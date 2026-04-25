// Codex rollout reconciler.
//
// Tails ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sid>.jsonl files. Each line
// is `{ timestamp, type, payload }` (NOT a HookEnvelope). We map the small set
// of `type`/`payload.type` pairs that correspond to lifecycle events; the rest
// are dropped.
//
// Mapping (per the M4 plan):
//   session_meta                                -> session_start
//   turn_context                                -> ignored, but updates session metadata
//   event_msg.payload.type=user_message         -> user_prompt
//   event_msg.payload.type=task_started         -> ignored
//   event_msg.payload.type=task_complete        -> turn_complete
//   event_msg.payload.type=agent_message        -> ignored
//   response_item.payload.type=function_call    -> tool_call_start
//   response_item.payload.type=function_call_output -> tool_call_end
//   anything else                               -> ignored

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';

import { PATHS, sessionKey } from '../paths.ts';
import { nextState } from '../state-machine.ts';
import {
  getMaxOffsetForPath,
  getSessionByKey,
  insertEvent,
  upsertSession,
  type SessionUpsert,
} from '../store/queries.ts';
import { openDb } from '../store/db.ts';
import type {
  NormalizedEvent,
  NormalizedEventKind,
  SessionRow,
} from '../types.ts';

export interface CodexReconcileOptions {
  rootDir?: string;
  dbPath?: string;
  log?: (msg: string) => void;
}

export interface ReconcileStats {
  filesScanned: number;
  linesIngested: number;
  linesSkipped: number;
}

const WALK_MAX_DEPTH = 6; // YYYY/MM/DD plus headroom

async function listRolloutFiles(rootDir: string): Promise<string[]> {
  if (!fs.existsSync(rootDir)) return [];
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > WALK_MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(full, depth + 1);
      else if (ent.isFile() && ent.name.endsWith('.jsonl')) out.push(full);
    }
  }
  await walk(rootDir, 0);
  return out.sort();
}

// --- payload helpers ---------------------------------------------------------

type Json = Record<string, unknown>;
function asObject(v: unknown): Json | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}
function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function summarizePrompt(prompt: string): string {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? flat.slice(0, 197) + '...' : flat;
}

// --- normalizer --------------------------------------------------------------
//
// We use the rollout file's own session id (the one inside session_meta.payload.id
// AND embedded in the filename), but session_meta is the only line that carries
// it. Codex events after session_meta don't repeat the session id, so we extract
// it from the filename as a fallback for files where we missed the start.

const FILENAME_SID_RE = /rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]+)\.jsonl$/;

function sessionIdFromFilename(filePath: string): string | null {
  const base = path.basename(filePath);
  const m = base.match(FILENAME_SID_RE);
  return m ? m[1] ?? null : null;
}

interface NormalizedRollout {
  kind: NormalizedEventKind | null; // null => metadata-only update (no event row)
  cwd: string | null;
  model: string | null;
  cliVersion: string | null;
  toolName: string | null;
  userPrompt: string | null;
  providerTs: string | null;
  observedAtMs: number;
  // session_meta.payload.source: 'cli' | 'exec' | 'mcp' | other. Used to
  // distinguish human-driven sessions from MCP-spawned children. Only set on
  // the session_meta line; metadata-only callsites pass null.
  origin: string | null;
  contextTokensUsed?: number | null;
  contextTokensMax?: number | null;
  contextSource?: 'reported' | null;
}

// Pull metadata-only fields off a turn_context line. Returns null when there's
// nothing useful to learn.
function readTurnContext(payload: Json): {
  cwd: string | null;
  model: string | null;
} {
  return {
    cwd: asString(payload.cwd),
    model: asString(payload.model),
  };
}

function normalizeCodexLine(
  line: Json,
  fallbackObservedMs: number,
): NormalizedRollout | null {
  const type = asString(line.type);
  if (!type) return null;
  const payload = asObject(line.payload);
  const tsRaw = asString(line.timestamp);
  const observedAtMs = tsRaw ? Date.parse(tsRaw) : NaN;
  const observed = Number.isFinite(observedAtMs)
    ? (observedAtMs as number)
    : fallbackObservedMs;
  const providerTs = tsRaw;

  switch (type) {
    case 'session_meta': {
      if (!payload) return null;
      return {
        kind: 'session_start',
        cwd: asString(payload.cwd),
        model: asString(payload.model),
        cliVersion: asString(payload.cli_version),
        toolName: null,
        userPrompt: null,
        providerTs,
        observedAtMs: observed,
        origin: asString(payload.source),
      };
    }

    case 'turn_context': {
      if (!payload) return null;
      const m = readTurnContext(payload);
      // metadata-only: no event row, but we want the session row to learn
      // model / cwd if it didn't have them.
      return {
        kind: null,
        cwd: m.cwd,
        model: m.model,
        cliVersion: null,
        toolName: null,
        userPrompt: null,
        providerTs,
        observedAtMs: observed,
        origin: null,
      };
    }

    case 'event_msg': {
      if (!payload) return null;
      const sub = asString(payload.type);
      switch (sub) {
        case 'user_message': {
          const msg = asString(payload.message);
          if (!msg) return null;
          return {
            kind: 'user_prompt',
            cwd: null,
            model: null,
            cliVersion: null,
            toolName: null,
            userPrompt: msg,
            providerTs,
            observedAtMs: observed,
            origin: null,
          };
        }
        case 'token_count': {
          // `total_token_usage` is CUMULATIVE across the session — for a long
          // codex thread that runs for hours, total_tokens far exceeds the
          // context window. The actual current context size is in
          // `last_token_usage.total_tokens` — the last turn's request.
          const info = asObject(payload.info);
          const last = info ? asObject(info.last_token_usage) : null;
          const used = last ? asNumber(last.total_tokens) : null;
          const max = info ? asNumber(info.model_context_window) : null;
          if (used == null && max == null) return null;
          return {
            kind: null,
            cwd: null,
            model: null,
            cliVersion: null,
            toolName: null,
            userPrompt: null,
            providerTs,
            observedAtMs: observed,
            origin: null,
            contextTokensUsed: used,
            contextTokensMax: max,
            contextSource: 'reported',
          };
        }
        case 'task_complete': {
          return {
            kind: 'turn_complete',
            cwd: null,
            model: null,
            cliVersion: null,
            toolName: null,
            userPrompt: null,
            providerTs,
            observedAtMs: observed,
            origin: null,
          };
        }
        // Ignored: task_started (we derive thinking from user_prompt),
        // agent_message (text), web_search_*, etc.
        default:
          return null;
      }
    }

    case 'response_item': {
      if (!payload) return null;
      const sub = asString(payload.type);
      switch (sub) {
        case 'function_call': {
          return {
            kind: 'tool_call_start',
            cwd: null,
            model: null,
            cliVersion: null,
            toolName: asString(payload.name),
            userPrompt: null,
            providerTs,
            observedAtMs: observed,
            origin: null,
          };
        }
        case 'function_call_output': {
          return {
            kind: 'tool_call_end',
            cwd: null,
            model: null,
            cliVersion: null,
            toolName: null,
            userPrompt: null,
            providerTs,
            observedAtMs: observed,
            origin: null,
          };
        }
        // Ignored: message (assistant text), reasoning, web_search_call.
        default:
          return null;
      }
    }

    default:
      return null;
  }
}

// --- per-file drain ----------------------------------------------------------

function persistEvent(
  norm: NormalizedRollout,
  sessionId: string,
  sourcePath: string,
  sourceOffset: number,
  rawLine: string,
): void {
  if (norm.kind == null) return; // metadata-only handled by caller

  const key = sessionKey('codex', sessionId, sourcePath);
  const prev: SessionRow | null = getSessionByKey(key);

  const event: NormalizedEvent = {
    session_key: key,
    observed_at_ms: norm.observedAtMs,
    provider_ts: norm.providerTs ?? undefined,
    source: 'rollout',
    source_path: sourcePath,
    source_offset: sourceOffset,
    kind: norm.kind,
    payload_json: rawLine,
    meta: {
      cwd: norm.cwd ?? undefined,
      model: norm.model ?? undefined,
      cli_version: norm.cliVersion ?? undefined,
      transcript_path: sourcePath,
      tool_name: norm.toolName ?? undefined,
      user_prompt: norm.userPrompt ?? undefined,
    },
  };

  // SessionStart for an existing key behaves like a resume in the hook reducer;
  // we mirror that here so the state machine's session_resume branch fires.
  let kindForSm: NormalizedEventKind = norm.kind;
  if (norm.kind === 'session_start' && prev) {
    kindForSm = 'session_resume';
    event.kind = 'session_resume';
  }
  void kindForSm;

  const patch = nextState(prev, event);

  const upsert: SessionUpsert = {
    key,
    provider: 'codex',
    session_id: sessionId,
    observed_at_ms: norm.observedAtMs,
    state: patch.state ?? prev?.state ?? 'waiting',
    transcript_path: sourcePath,
    cwd: norm.cwd,
    model: norm.model,
    cli_version: norm.cliVersion,
    pid: null,
    process_start_unix: null,
    prior_state:
      'prior_state' in patch ? patch.prior_state ?? null : prev?.prior_state ?? null,
    current_tool:
      'current_tool' in patch ? patch.current_tool ?? null : prev?.current_tool ?? null,
    last_prompt: norm.userPrompt ? summarizePrompt(norm.userPrompt) : null,
    origin: norm.origin,
    context_tokens_used: norm.contextTokensUsed,
    context_tokens_max: norm.contextTokensMax,
    context_source: norm.contextSource,
  };

  upsertSession(upsert);
  insertEvent(event);
}

// Update only the session row with whatever metadata we just learned. Used for
// lines like `turn_context` where we want to record the model/cwd but don't
// want to insert an event row.
function persistMetadataOnly(
  norm: NormalizedRollout,
  sessionId: string,
  sourcePath: string,
): void {
  const key = sessionKey('codex', sessionId, sourcePath);
  const prev = getSessionByKey(key);
  if (!prev) return; // no session row yet -- nothing to patch onto.

  // Only push fields if at least one meaningful field is set; saves a write.
  if (
    !norm.cwd &&
    !norm.model &&
    !norm.cliVersion &&
    norm.contextTokensUsed == null &&
    norm.contextTokensMax == null
  ) return;

  const upsert: SessionUpsert = {
    key,
    provider: 'codex',
    session_id: sessionId,
    observed_at_ms: norm.observedAtMs,
    state: prev.state,
    transcript_path: sourcePath,
    cwd: norm.cwd,
    model: norm.model,
    cli_version: norm.cliVersion,
    pid: null,
    process_start_unix: null,
    prior_state: prev.prior_state,
    current_tool: prev.current_tool,
    last_prompt: null,
    context_tokens_used: norm.contextTokensUsed,
    context_tokens_max: norm.contextTokensMax,
    context_source: norm.contextSource,
  };
  upsertSession(upsert);
}

interface DrainResult {
  newOffset: number;
  ingested: number;
  skipped: number;
}

async function drainFile(
  filePath: string,
  startOffset: number,
  log: (m: string) => void,
): Promise<DrainResult> {
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return { newOffset: startOffset, ingested: 0, skipped: 0 };
  }
  if (stat.size <= startOffset) {
    return { newOffset: startOffset, ingested: 0, skipped: 0 };
  }

  const fd = await fsp.open(filePath, 'r');
  let buf: Buffer;
  try {
    const length = stat.size - startOffset;
    buf = Buffer.alloc(length);
    await fd.read(buf, 0, length, startOffset);
  } finally {
    await fd.close();
  }

  let ingested = 0;
  let skipped = 0;
  let cursor = 0;
  let newOffset = startOffset;

  // Codex doesn't repeat session_id on every line, so we cache the id we
  // learned from session_meta (or, failing that, parse it from the filename).
  let sessionId = sessionIdFromFilename(filePath);

  while (cursor < buf.length) {
    const nl = buf.indexOf(0x0a, cursor);
    if (nl === -1) break;
    const lineStart = cursor;
    const recordOffsetInFile = startOffset + lineStart;
    const lineBytes = buf.subarray(lineStart, nl);
    cursor = nl + 1;
    newOffset = startOffset + cursor;

    const trimmed = lineBytes.toString('utf8').trim();
    if (trimmed.length === 0) {
      skipped++;
      continue;
    }

    const existingMax = getMaxOffsetForPath(filePath);
    if (existingMax != null && recordOffsetInFile <= existingMax) {
      skipped++;
      continue;
    }

    let line: Json;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const obj = asObject(parsed);
      if (!obj) {
        skipped++;
        continue;
      }
      line = obj;
    } catch {
      log(`reconciler/codex: malformed JSON in ${filePath} @ ${recordOffsetInFile}`);
      skipped++;
      continue;
    }

    // session_meta lets us authoritatively pin the session id even if the
    // filename was renamed or doesn't match the regex.
    if (asString(line.type) === 'session_meta') {
      const p = asObject(line.payload);
      const id = p ? asString(p.id) : null;
      if (id) sessionId = id;
    }

    const norm = normalizeCodexLine(line, Date.now());
    if (!norm) {
      skipped++;
      continue;
    }

    if (!sessionId) {
      // Can't key the row without a session id. Skip rather than guess.
      skipped++;
      continue;
    }

    try {
      if (norm.kind == null) {
        persistMetadataOnly(norm, sessionId, filePath);
        // metadata-only counts as skipped from the events-row perspective; the
        // dedup index is per-line, and we want re-runs to remain idempotent
        // even though we didn't insert. Treat as skipped.
        skipped++;
      } else {
        persistEvent(norm, sessionId, filePath, recordOffsetInFile, trimmed);
        ingested++;
      }
    } catch (e) {
      log(
        `reconciler/codex: persist error in ${filePath} @ ${recordOffsetInFile}: ${(e as Error).message}`,
      );
      skipped++;
    }
  }

  return { newOffset, ingested, skipped };
}

// --- entrypoints -------------------------------------------------------------

export async function reconcileCodexOnce(
  opts: CodexReconcileOptions = {},
): Promise<ReconcileStats> {
  const root = opts.rootDir ?? PATHS.codexSessions;
  const log = opts.log ?? ((m: string) => console.error(m));
  if (opts.dbPath) openDb(opts.dbPath);
  else openDb();

  const files = await listRolloutFiles(root);
  let linesIngested = 0;
  let linesSkipped = 0;
  for (const f of files) {
    const known = getMaxOffsetForPath(f);
    const start = known ?? 0;
    const r = await drainFile(f, start, log);
    linesIngested += r.ingested;
    linesSkipped += r.skipped;
  }
  return { filesScanned: files.length, linesIngested, linesSkipped };
}

export async function watchCodex(
  opts: CodexReconcileOptions = {},
): Promise<FSWatcher> {
  const root = opts.rootDir ?? PATHS.codexSessions;
  const log = opts.log ?? ((m: string) => console.error(m));
  fs.mkdirSync(root, { recursive: true });

  await reconcileCodexOnce(opts);

  const watcher = chokidar.watch(root, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: false,
    depth: WALK_MAX_DEPTH,
  });

  const drain = async (file: string) => {
    if (!file.endsWith('.jsonl')) return;
    const known = getMaxOffsetForPath(file);
    const start = known ?? 0;
    try {
      await drainFile(file, start, log);
    } catch (e) {
      log(
        `reconciler/codex: drainFile error ${file}: ${(e as Error).message}`,
      );
    }
  };

  watcher.on('add', drain);
  watcher.on('change', drain);

  return watcher;
}
