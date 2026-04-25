// State-age driven liveness override (M6).
//
// The DB's `state` column is set at event-ingest time by the state machine and
// stays as that lifecycle value (`thinking` / `tool` / `waiting` / `permission`
// / `done` / `recovered`). At read time, the TUI overlays this with an
// "is this still alive?" judgement based on how stale `last_event_at_ms` is.
//
// We deliberately never return `dead` in v1 -- per plan M6, hook payloads do
// not carry the agent's PID, so we can't trust process liveness. False-dead
// on a quietly-waiting session is worse than conservative `stale`.
//
// Pure function. Inputs are SessionRow + a wall clock; output is the display
// state to show in the grid. Same row at different times can return different
// states, which is the whole point.

import { readdirSync, readlinkSync, readFileSync } from 'node:fs';
import type { SessionRow, SessionState } from './types.ts';

// Authoritative session-end check for Claude.
//
// Claude Code creates `~/.claude/tasks/<session_id>/.lock` at session start.
// The file's *existence* is not enough — crashed processes leave stale locks
// behind. Empirically, Claude doesn't use flock(2) on it either; the actual
// signal is that a live `claude` process has the lock file open as a file
// descriptor. We detect this by walking /proc/<pid>/fd and matching readlinks.
//
// We cache the result of the scan for ALIVE_CACHE_MS so 88 cells * 5 ticks/sec
// don't hammer /proc. The scan itself is bounded to PIDs whose /proc/<pid>/comm
// is "claude".
//
// Codex has lock files too, but its lock dir name is randomized
// (~/.codex/tmp/arg0/codex-arg0<random>/.lock) and doesn't carry session_id,
// so we can't map session -> lock cheaply. Codex liveness still uses the
// event-age heuristic below.

const ALIVE_CACHE_MS = 3000;
interface AliveCache {
  claude: Set<string>;
  codex: Set<string>;
}
let aliveCache: AliveCache | null = null;
let aliveCacheExpiresAt = 0;

// /proc/<pid>/fd readlinks we recognize:
//   /home/<user>/.claude/tasks/<session_id>/.lock           (Claude session marker)
//   /home/<user>/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<session_id>.jsonl
//                                                           (Codex rollout, open while session lives)
// UUID-shaped session ids (8-4-4-4-12 hex). Tight match avoids greedy [^/]+
// from swallowing dashes inside the timestamp portion of the codex filename.
const UUID_RE_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CLAUDE_LOCK_RE = new RegExp(`/\\.claude/tasks/(${UUID_RE_SRC})/\\.lock$`);
const CODEX_ROLLOUT_RE = new RegExp(
  `/\\.codex/sessions/[^ ]+/rollout-[^/]+-(${UUID_RE_SRC})\\.jsonl$`,
);

function refreshAliveCache(): void {
  const now = Date.now();
  if (aliveCache && aliveCacheExpiresAt > now) return;

  const cache: AliveCache = { claude: new Set(), codex: new Set() };
  let pids: string[];
  try {
    pids = readdirSync('/proc');
  } catch {
    aliveCache = cache;
    aliveCacheExpiresAt = now + ALIVE_CACHE_MS;
    return;
  }

  // Match a UUID anywhere in the rest of a token list. Used for `--resume`
  // arg parsing where the value may be the next argument in cmdline.
  const UUID_TOKEN_RE = new RegExp(`^${UUID_RE_SRC}$`);

  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let comm: string;
    try {
      comm = readFileSync(`/proc/${pid}/comm`, 'utf-8').trim();
    } catch {
      continue;
    }
    if (comm !== 'claude' && comm !== 'codex') continue;

    // Resumed sessions (`claude --resume <sid>` or `codex --resume <sid>`)
    // don't create a new lock file and don't keep their rollout fd open
    // persistently, so we'd miss them via the fd walk alone. Parse cmdline.
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
      const args = raw.split('\0');
      for (let i = 0; i < args.length - 1; i++) {
        if (args[i] === '--resume' && UUID_TOKEN_RE.test(args[i + 1] ?? '')) {
          const sid = args[i + 1]!;
          if (comm === 'claude') cache.claude.add(sid);
          else cache.codex.add(sid);
          break;
        }
      }
    } catch {
      // cmdline unreadable; fall through to fd walk.
    }

    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const link = readlinkSync(`/proc/${pid}/fd/${fd}`);
        const cm = CLAUDE_LOCK_RE.exec(link);
        if (cm) {
          cache.claude.add(cm[1]!);
          continue;
        }
        const xm = CODEX_ROLLOUT_RE.exec(link);
        if (xm) cache.codex.add(xm[1]!);
      } catch {
        // fd vanished mid-walk; ignore.
      }
    }
  }

  aliveCache = cache;
  aliveCacheExpiresAt = now + ALIVE_CACHE_MS;
}

export function isClaudeSessionAlive(sessionId: string): boolean {
  if (!sessionId) return false;
  refreshAliveCache();
  return aliveCache!.claude.has(sessionId);
}

export function isCodexSessionAlive(sessionId: string): boolean {
  if (!sessionId) return false;
  refreshAliveCache();
  return aliveCache!.codex.has(sessionId);
}

// Tunables, exposed as constants for easy adjustment / test parameterization.
// Times are in milliseconds.
export const ACTIVE_WINDOW_MS = 30_000; // < 30s since last event: keep insert-time state as-is
export const IDLE_SOFT_WINDOW_MS = 90_000; // 30-90s if was actively running: idle (soft)
export const IDLE_HARD_WINDOW_MS = 600_000; // 90s-10min: still idle (soft); past that: stale

// The set of insert-time states that count as "actively running" for the
// idle-soft override. `waiting` is a turn-completed lull, not running.
const ACTIVE_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  'thinking',
  'tool',
  'waiting',
  'permission',
]);

// Compute the display state for a row at a given wall-clock instant.
//
// Pure: no fs side effects. Production callers use `applyLiveness` (below)
// which composes this with the authoritative lock-file check; tests use
// this directly.
//
// Logic (in order):
//   - state === 'done'                -> 'done'   (terminal; never overridden)
//   - now - last < 30s                -> state    (fresh enough; trust insert-time)
//   - now - last < 90s and was active -> 'idle'   (active state that quieted)
//   - now - last < 10min              -> 'idle'   (still soft; not stale yet)
//   - else                             -> 'stale' (long-quiet, no Stop hook)
export function deriveDisplayState(row: SessionRow, nowMs: number): SessionState {
  if (row.state === 'done') return 'done';

  const age = nowMs - row.last_event_at_ms;

  if (age < ACTIVE_WINDOW_MS) {
    // Fresh: trust the state machine's lifecycle value.
    return row.state;
  }

  if (age < IDLE_SOFT_WINDOW_MS && ACTIVE_STATES.has(row.state)) {
    // Was actively running but no events for 30-90s. Soft idle.
    return 'idle';
  }

  if (age < IDLE_HARD_WINDOW_MS) {
    // Still under the stale threshold; show as idle regardless of insert-time state.
    return 'idle';
  }

  return 'stale';
}

// Production-side liveness: authoritative process-fd checks first (both
// providers), then fall back to the event-age heuristic. Side-effecting
// (walks /proc, cached for 3 s); tests should stick to deriveDisplayState.
//
// When a session is confirmed *alive* by /proc but its last event is older
// than the IDLE_HARD threshold, the event-age heuristic would return `stale`
// — which is wrong (we *know* it's running). Cap such cases at `idle`.
export function applyLiveness(row: SessionRow, nowMs: number): SessionState {
  const proven =
    (row.provider === 'claude' && isClaudeSessionAlive(row.session_id)) ||
    (row.provider === 'codex' && isCodexSessionAlive(row.session_id));

  if (!proven) return 'done';

  const derived = deriveDisplayState(row, nowMs);
  return derived === 'stale' ? 'idle' : derived;
}
