// All SQL lives here. Other modules call typed functions, never raw SQL.

import { prepare } from './db.ts';
import type { EventRow, NormalizedEvent, SessionRow, SessionState } from '../types.ts';

// --- sessions ----------------------------------------------------------------

// Upsert a session. New rows must come with a starting `state`; existing rows
// only update fields the caller actually set (COALESCE keeps prior values when
// the patch leaves a column undefined / null).
//
// Plan: started_at_ms is set once at first event; last_event_at_ms always moves
// forward to the latest observed_at_ms.
export interface SessionUpsert {
  key: string;
  provider: SessionRow['provider'];
  session_id: string;
  observed_at_ms: number;
  state: SessionState;
  transcript_path?: string | null;
  cwd?: string | null;
  model?: string | null;
  cli_version?: string | null;
  pid?: number | null;
  process_start_unix?: number | null;
  prior_state?: SessionState | null;
  current_tool?: string | null;
  last_prompt?: string | null;
  observed_parent_pid?: number | null;
}

const SQL_UPSERT_SESSION = `
INSERT INTO sessions (
  key, provider, session_id, transcript_path, cwd, model, cli_version,
  pid, process_start_unix, started_at_ms, last_event_at_ms,
  prior_state, state, current_tool, last_prompt, observed_parent_pid
) VALUES (
  $key, $provider, $session_id, $transcript_path, $cwd, $model, $cli_version,
  $pid, $process_start_unix, $observed_at_ms, $observed_at_ms,
  $prior_state, $state, $current_tool, $last_prompt, $observed_parent_pid
)
ON CONFLICT(key) DO UPDATE SET
  transcript_path     = COALESCE(excluded.transcript_path, sessions.transcript_path),
  cwd                 = COALESCE(excluded.cwd,             sessions.cwd),
  model               = COALESCE(excluded.model,           sessions.model),
  cli_version         = COALESCE(excluded.cli_version,     sessions.cli_version),
  pid                 = COALESCE(excluded.pid,             sessions.pid),
  process_start_unix  = COALESCE(excluded.process_start_unix, sessions.process_start_unix),
  last_event_at_ms    = MAX(excluded.last_event_at_ms, sessions.last_event_at_ms),
  prior_state         = excluded.prior_state,
  state               = excluded.state,
  current_tool        = excluded.current_tool,
  last_prompt         = COALESCE(excluded.last_prompt,     sessions.last_prompt),
  observed_parent_pid = COALESCE(excluded.observed_parent_pid, sessions.observed_parent_pid)
`;

export function upsertSession(row: SessionUpsert): void {
  prepare(SQL_UPSERT_SESSION).run({
    $key: row.key,
    $provider: row.provider,
    $session_id: row.session_id,
    $transcript_path: row.transcript_path ?? null,
    $cwd: row.cwd ?? null,
    $model: row.model ?? null,
    $cli_version: row.cli_version ?? null,
    $pid: row.pid ?? null,
    $process_start_unix: row.process_start_unix ?? null,
    $observed_at_ms: row.observed_at_ms,
    $prior_state: row.prior_state ?? null,
    $state: row.state,
    $current_tool: row.current_tool ?? null,
    $last_prompt: row.last_prompt ?? null,
    $observed_parent_pid: row.observed_parent_pid ?? null,
  });
}

const SQL_GET_SESSION_BY_KEY = `SELECT * FROM sessions WHERE key = $key`;

export function getSessionByKey(key: string): SessionRow | null {
  const row = prepare<SessionRow, [{ $key: string }]>(SQL_GET_SESSION_BY_KEY).get({
    $key: key,
  });
  return (row as SessionRow | null) ?? null;
}

// Find an existing session by (provider, session_id), regardless of which
// transcript_path-derived key it lives under. Hooks often emit events without
// the transcript_path field after SessionStart, so the reducer uses this to
// recover the canonical key.
const SQL_FIND_SESSION_BY_PROVIDER_SID = `
SELECT * FROM sessions WHERE provider = $provider AND session_id = $session_id
ORDER BY started_at_ms DESC LIMIT 1
`;

export function findSessionByProviderAndId(
  provider: SessionRow['provider'],
  sessionId: string,
): SessionRow | null {
  const row = prepare<SessionRow, [{ $provider: string; $session_id: string }]>(
    SQL_FIND_SESSION_BY_PROVIDER_SID,
  ).get({ $provider: provider, $session_id: sessionId });
  return (row as SessionRow | null) ?? null;
}

// "Active" = not done/dead/stale. Used by the doctor command and the TUI grid.
const SQL_ACTIVE_SESSIONS = `
SELECT * FROM sessions
WHERE state NOT IN ('done', 'dead', 'stale')
ORDER BY last_event_at_ms DESC
`;

export function getActiveSessions(): SessionRow[] {
  return prepare<SessionRow, []>(SQL_ACTIVE_SESSIONS).all() as SessionRow[];
}

const SQL_ALL_SESSION_STATE_COUNTS = `
SELECT state, COUNT(*) AS count FROM sessions GROUP BY state ORDER BY state
`;

// Per-session progress stats: turn count (number of user prompts handled) and
// subagent count (other sessions whose transcript_path lives under the parent's
// `<sid>/subagents/` directory). These are surfaced in the card UI so the user
// can confirm a session is progressing without opening detail.
//
// The subagent self-match guard (`c.session_id != s.session_id`) is paranoid:
// a parent's transcript_path doesn't contain its own session_id under
// /subagents/, but the LIKE is loose so we filter out collisions defensively.
const SQL_ALL_SESSION_STATS = `
SELECT
  s.key AS key,
  (SELECT COUNT(*) FROM events e
     WHERE e.session_key = s.key AND e.kind = 'user_prompt') AS turns,
  (SELECT COUNT(*) FROM sessions c
     WHERE c.session_id != s.session_id
       AND c.transcript_path LIKE '%' || s.session_id || '/subagents/%') AS subagents
FROM sessions s
`;

export interface SessionStats {
  turns: number;
  subagents: number;
}

export function getAllSessionStats(): Map<string, SessionStats> {
  const rows = prepare<{ key: string; turns: number; subagents: number }, []>(
    SQL_ALL_SESSION_STATS,
  ).all() as { key: string; turns: number; subagents: number }[];
  const out = new Map<string, SessionStats>();
  for (const r of rows) out.set(r.key, { turns: r.turns, subagents: r.subagents });
  return out;
}

export function getSessionStateCounts(): { state: SessionState; count: number }[] {
  return prepare<{ state: SessionState; count: number }, []>(
    SQL_ALL_SESSION_STATE_COUNTS,
  ).all() as { state: SessionState; count: number }[];
}

// --- events ------------------------------------------------------------------

const SQL_INSERT_EVENT = `
INSERT INTO events (
  session_key, observed_at_ms, provider_ts, source, source_path, source_offset, kind, payload_json
) VALUES (
  $session_key, $observed_at_ms, $provider_ts, $source, $source_path, $source_offset, $kind, $payload_json
)
`;

// Returns the new row's auto-increment id. The indexer uses this to confirm
// inserts and (later) to associate downstream computations with canonical order.
export function insertEvent(ev: NormalizedEvent): number {
  const info = prepare(SQL_INSERT_EVENT).run({
    $session_key: ev.session_key,
    $observed_at_ms: ev.observed_at_ms,
    $provider_ts: ev.provider_ts ?? null,
    $source: ev.source,
    $source_path: ev.source_path,
    $source_offset: ev.source_offset,
    $kind: ev.kind,
    $payload_json: ev.payload_json ?? null,
  });
  return Number(info.lastInsertRowid);
}

const SQL_RECENT_EVENTS_FOR_SESSION = `
SELECT * FROM events
WHERE session_key = $key
ORDER BY id DESC
LIMIT $limit
`;

export function getRecentEventsForSession(key: string, limit = 50): EventRow[] {
  return prepare<EventRow, [{ $key: string; $limit: number }]>(
    SQL_RECENT_EVENTS_FOR_SESSION,
  ).all({ $key: key, $limit: limit }) as EventRow[];
}

// Spool/rollout resume: largest already-ingested byte offset for a path.
// NULL means "we have never seen this file" -- caller treats as 0.
const SQL_MAX_OFFSET_FOR_PATH = `
SELECT MAX(source_offset) AS max_offset FROM events WHERE source_path = $path
`;

export function getMaxOffsetForPath(sourcePath: string): number | null {
  const row = prepare<{ max_offset: number | null }, [{ $path: string }]>(
    SQL_MAX_OFFSET_FOR_PATH,
  ).get({ $path: sourcePath }) as { max_offset: number | null } | null;
  return row?.max_offset ?? null;
}

// Distinct source paths we've already ingested from. doctor uses it to surface
// which spool files are known to the DB.
const SQL_DISTINCT_SOURCE_PATHS = `SELECT DISTINCT source_path FROM events ORDER BY source_path`;

export function getKnownSourcePaths(): string[] {
  const rows = prepare<{ source_path: string }, []>(SQL_DISTINCT_SOURCE_PATHS).all() as {
    source_path: string;
  }[];
  return rows.map((r) => r.source_path);
}
