// Claude rollout reconciler.
//
// Tails ~/.claude/projects/<mangled-cwd>/<session-uuid>.jsonl files. Each line is
// a transcript record (NOT a HookEnvelope). We normalize the small subset of
// line shapes that map to lifecycle events and drop the rest. Inserts go through
// `insertEvent` + `upsertSession`; dedup by `(source_path, source_offset)` with
// the same offset-cursor pattern the spool tailer uses.
//
// Why a separate normalizer (not the hook reducer): rollout records carry their
// own envelope (`type`, `sessionId`, `cwd`, `version`, `gitBranch`, `timestamp`)
// that doesn't match HookEnvelope at all. Easier to map directly than to coerce.
//
// Mapping (per the M4 plan):
//   user                                   -> user_prompt   (extract message text)
//   assistant w/ stop_reason=tool_use      -> tool_call_start (extract tool name)
//   system w/ subtype=turn_duration        -> turn_complete
//   permission-mode / attachment / etc     -> ignored
//
// Session is upserted on every recognized record so cwd/model/cli_version are
// learned even if the only line we mapped is a turn_complete.

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

export interface ClaudeReconcileOptions {
  // Override watch root (tests). Defaults to PATHS.claudeProjects.
  rootDir?: string;
  // Override DB path (tests). Defaults to PATHS.db.
  dbPath?: string;
  // Logger (defaults to console.error).
  log?: (msg: string) => void;
}

export interface ReconcileStats {
  filesScanned: number;
  linesIngested: number;
  linesSkipped: number; // dropped lines (unrecognized type, dedup, malformed)
}

// Bound the depth of the walk; ~/.claude/projects/<dir>/<file>.jsonl plus the
// occasional `subagents/` subdir means depth 4 is more than enough.
const WALK_MAX_DEPTH = 4;

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
function asArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

// Pull the assistant's first tool_use block name from `message.content[]`.
// Returns null if the assistant didn't actually issue a tool_use this turn
// (despite stop_reason saying so) or the structure is unfamiliar.
function extractToolName(line: Json): string | null {
  const msg = asObject(line.message);
  if (!msg) return null;
  const content = asArray(msg.content);
  if (!content) return null;
  for (const block of content) {
    const b = asObject(block);
    if (b && b.type === 'tool_use') {
      const name = asString(b.name);
      if (name) return name;
    }
  }
  return null;
}

// User prompt text -- string or first text block in a content array.
function extractUserPrompt(line: Json): string | null {
  const msg = asObject(line.message);
  if (!msg) return null;
  const direct = asString(msg.content);
  if (direct) return direct;
  const content = asArray(msg.content);
  if (!content) return null;
  for (const block of content) {
    const b = asObject(block);
    if (!b) continue;
    if (b.type === 'text') {
      const text = asString(b.text);
      if (text) return text;
    }
    // Tool result rows are also `type: user`; we don't want to surface those
    // as a "prompt", so skip anything that isn't an explicit text block.
  }
  return null;
}

function extractModel(line: Json): string | null {
  const msg = asObject(line.message);
  if (!msg) return null;
  return asString(msg.model);
}

// Truncate prompt for last_prompt column (mirrors state-machine's helper but we
// don't want to import a private function). 200 chars, whitespace-squashed.
function summarizePrompt(prompt: string): string {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? flat.slice(0, 197) + '...' : flat;
}

// --- normalizer --------------------------------------------------------------

interface NormalizedRollout {
  kind: NormalizedEventKind;
  sessionId: string;
  transcriptPath: string;
  cwd: string | null;
  model: string | null;
  cliVersion: string | null;
  toolName: string | null;
  userPrompt: string | null;
  providerTs: string | null;
  observedAtMs: number;
}

function normalizeClaudeLine(
  line: Json,
  filePath: string,
  fallbackObservedMs: number,
): NormalizedRollout | null {
  const type = asString(line.type);
  if (!type) return null;

  // Common envelope fields. Some line types (file-history-snapshot, last-prompt)
  // don't carry the full envelope; that's fine for the dropped types.
  const sessionId = asString(line.sessionId);
  const cwd = asString(line.cwd);
  const cliVersion = asString(line.version);
  const tsRaw = asString(line.timestamp);
  const providerTs = tsRaw;
  const observedAtMs = tsRaw ? Date.parse(tsRaw) : NaN;
  const observed = Number.isFinite(observedAtMs)
    ? (observedAtMs as number)
    : fallbackObservedMs;

  let kind: NormalizedEventKind | null = null;
  let toolName: string | null = null;
  let userPrompt: string | null = null;

  switch (type) {
    case 'user': {
      // `user` rows are either fresh user prompts or tool_result follow-ups.
      // Tool_result rows have content arrays with `tool_result` blocks; we
      // skip those by only mapping when we can extract real prompt text.
      const text = extractUserPrompt(line);
      if (!text) return null;
      kind = 'user_prompt';
      userPrompt = text;
      break;
    }
    case 'assistant': {
      const msg = asObject(line.message);
      const stopReason = msg ? asString(msg.stop_reason) : null;
      if (stopReason === 'tool_use') {
        kind = 'tool_call_start';
        toolName = extractToolName(line);
      } else {
        // Plain assistant text (`end_turn` / null). Not a lifecycle marker --
        // the state machine derives `thinking` from `user_prompt`.
        return null;
      }
      break;
    }
    case 'system': {
      if (asString(line.subtype) === 'turn_duration') {
        kind = 'turn_complete';
      } else {
        return null;
      }
      break;
    }
    // Explicitly ignored types listed in M4 plan.
    case 'permission-mode':
    case 'attachment':
    case 'file-history-snapshot':
    case 'last-prompt':
      return null;
    default:
      return null;
  }

  // We need a sessionId to key the session row. Records that don't have one
  // (file-history-snapshot, last-prompt) are already dropped above; if we got
  // here without one, the rollout is malformed -- skip rather than guess.
  if (!sessionId) return null;

  return {
    kind,
    sessionId,
    transcriptPath: filePath,
    cwd: cwd,
    model: extractModel(line),
    cliVersion: cliVersion,
    toolName,
    userPrompt,
    providerTs,
    observedAtMs: observed,
  };
}

// --- per-file drain ----------------------------------------------------------

// Build a NormalizedEvent + session upsert from a normalized line, run it
// through the state machine using the current DB state, and persist. Mirrors
// the spool tailer's flow but without the HookEnvelope reducer.
function persist(
  norm: NormalizedRollout,
  sourcePath: string,
  sourceOffset: number,
  rawLine: string,
): void {
  const key = sessionKey('claude', norm.sessionId, norm.transcriptPath);
  const prev: SessionRow | null = getSessionByKey(key);

  // Build the canonical event first; the state machine consumes it as-is.
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
      transcript_path: norm.transcriptPath,
      tool_name: norm.toolName ?? undefined,
      user_prompt: norm.userPrompt ?? undefined,
    },
  };
  const patch = nextState(prev, event);

  // Compose the session upsert. State is required; if the state-machine didn't
  // touch it, fall back to existing or initial waiting.
  const upsert: SessionUpsert = {
    key,
    provider: 'claude',
    session_id: norm.sessionId,
    observed_at_ms: norm.observedAtMs,
    state: patch.state ?? prev?.state ?? 'waiting',
    transcript_path: norm.transcriptPath,
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
  };

  upsertSession(upsert);
  insertEvent(event);
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

  while (cursor < buf.length) {
    const nl = buf.indexOf(0x0a, cursor);
    if (nl === -1) break; // partial trailing line; wait for next pass
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

    // Dedup: skip records we've already inserted. The dedup index is non-unique,
    // so we have to do this check in code -- same as the spool tailer.
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
      log(`reconciler/claude: malformed JSON in ${filePath} @ ${recordOffsetInFile}`);
      skipped++;
      continue;
    }

    const norm = normalizeClaudeLine(line, filePath, Date.now());
    if (!norm) {
      skipped++;
      continue;
    }

    try {
      persist(norm, filePath, recordOffsetInFile, trimmed);
      ingested++;
    } catch (e) {
      log(
        `reconciler/claude: persist error in ${filePath} @ ${recordOffsetInFile}: ${(e as Error).message}`,
      );
      skipped++;
    }
  }

  return { newOffset, ingested, skipped };
}

// --- entrypoints -------------------------------------------------------------

export async function reconcileClaudeOnce(
  opts: ClaudeReconcileOptions = {},
): Promise<ReconcileStats> {
  const root = opts.rootDir ?? PATHS.claudeProjects;
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

export async function watchClaude(
  opts: ClaudeReconcileOptions = {},
): Promise<FSWatcher> {
  const root = opts.rootDir ?? PATHS.claudeProjects;
  const log = opts.log ?? ((m: string) => console.error(m));
  fs.mkdirSync(root, { recursive: true });

  // Initial drain so anything written while we were down is caught.
  await reconcileClaudeOnce(opts);

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
        `reconciler/claude: drainFile error ${file}: ${(e as Error).message}`,
      );
    }
  };

  watcher.on('add', drain);
  watcher.on('change', drain);

  return watcher;
}
