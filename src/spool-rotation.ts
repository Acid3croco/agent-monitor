// Conservative spool rotation (M6).
//
// Delete spool files older than `minAgeDays` only when we are SURE every line
// was ingested into the events table. The bar:
//   1. The file ends with a newline (no partial trailing record still being
//      written), AND
//   2. We have at least one event row for this source_path
//      (`getMaxOffsetForPath` returns non-null), AND
//   3. The count of events whose source_path matches equals the count of
//      newline-delimited lines in the file.
//
// If any condition fails: keep the file. The plan calls this out: "Never infer
// 'ingested' from timestamps alone." We'd rather pay the disk cost of a few MB
// than drop a record we hadn't actually persisted.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { PATHS } from './paths.ts';
import { db } from './store/db.ts';
import { getMaxOffsetForPath } from './store/queries.ts';

export interface RotateOptions {
  spoolRoot?: string;     // override for tests; default PATHS.spool
  minAgeDays?: number;    // default 3
  dryRun?: boolean;       // when true, decide but don't actually unlink
  nowMs?: number;         // override "now" for tests
}

// One reason per file. Aggregated reason counts go into stats.reasons so the
// `doctor` view can summarize "kept N because partial trailing line".
export type RotationReason =
  | 'deleted'
  | 'kept-too-young'
  | 'kept-no-events'
  | 'kept-partial-line'
  | 'kept-line-count-mismatch'
  | 'kept-stat-failed'
  | 'kept-not-jsonl';

export interface RotateStats {
  filesDeleted: number;
  filesKept: number;
  reasons: Record<RotationReason, number>;
  perFile: { file: string; reason: RotationReason }[];
}

// Single SQL: how many event rows do we have for this source path?
const SQL_EVENT_COUNT_FOR_PATH =
  'SELECT COUNT(*) AS c FROM events WHERE source_path = $path';

function eventCountForPath(filePath: string): number {
  const row = db()
    .prepare(SQL_EVENT_COUNT_FOR_PATH)
    .get({ $path: filePath }) as { c: number } | undefined;
  return row?.c ?? 0;
}

// Walk the spool root, return absolute paths of every .jsonl file. Mirrors
// the indexer's walk shape (3-4 levels: provider / session_hash / date.jsonl).
async function listSpoolFiles(spoolRoot: string): Promise<string[]> {
  if (!fs.existsSync(spoolRoot)) return [];
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4) return;
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
  await walk(spoolRoot, 0);
  return out;
}

// Read the last byte of a file; returns null on empty / unreadable.
async function readLastByte(filePath: string): Promise<number | null> {
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return null;
  }
  if (stat.size === 0) return null;
  const fd = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(1);
    await fd.read(buf, 0, 1, stat.size - 1);
    return buf[0]!;
  } finally {
    await fd.close();
  }
}

// Count newline-terminated lines in a file. We do NOT count a trailing partial
// line as a "line" -- that case is already filtered earlier by readLastByte.
async function countLines(filePath: string): Promise<number> {
  const buf = await fsp.readFile(filePath);
  let n = 0;
  for (const b of buf) if (b === 0x0a) n++;
  return n;
}

function emptyReasons(): Record<RotationReason, number> {
  return {
    deleted: 0,
    'kept-too-young': 0,
    'kept-no-events': 0,
    'kept-partial-line': 0,
    'kept-line-count-mismatch': 0,
    'kept-stat-failed': 0,
    'kept-not-jsonl': 0,
  };
}

// Decide and (optionally) act on every spool file. Returns the stats so the
// `rotate-spool` CLI and the `doctor` view can render them.
export async function rotateSpoolOnce(
  opts: RotateOptions = {},
): Promise<RotateStats> {
  const spoolRoot = opts.spoolRoot ?? PATHS.spool;
  const minAgeDays = opts.minAgeDays ?? 3;
  const dryRun = opts.dryRun ?? false;
  const now = opts.nowMs ?? Date.now();
  const cutoff = now - minAgeDays * 24 * 60 * 60 * 1000;

  const stats: RotateStats = {
    filesDeleted: 0,
    filesKept: 0,
    reasons: emptyReasons(),
    perFile: [],
  };

  const files = await listSpoolFiles(spoolRoot);

  for (const file of files) {
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(file);
    } catch {
      stats.reasons['kept-stat-failed']++;
      stats.filesKept++;
      stats.perFile.push({ file, reason: 'kept-stat-failed' });
      continue;
    }

    // mtime is the right reference: it advances every time the writer appends
    // a record. ctime advances on inode-level changes (chmod, link, etc) which
    // are unrelated to "did the writer touch this file". A file that was
    // created days ago and never appended-to since should be eligible.
    const ageRefMs = stat.mtimeMs;
    if (ageRefMs > cutoff) {
      stats.reasons['kept-too-young']++;
      stats.filesKept++;
      stats.perFile.push({ file, reason: 'kept-too-young' });
      continue;
    }

    // Trailing newline check: if the writer is mid-record, the indexer left
    // it for the next pass and we MUST NOT delete the file.
    const last = await readLastByte(file);
    if (last !== 0x0a) {
      stats.reasons['kept-partial-line']++;
      stats.filesKept++;
      stats.perFile.push({ file, reason: 'kept-partial-line' });
      continue;
    }

    // Has the indexer ever ingested from this file?
    const maxOff = getMaxOffsetForPath(file);
    if (maxOff == null) {
      stats.reasons['kept-no-events']++;
      stats.filesKept++;
      stats.perFile.push({ file, reason: 'kept-no-events' });
      continue;
    }

    // All-lines-ingested check: the only fully-trustworthy signal we have.
    // If the spool file has N newline-terminated lines but the events table
    // has < N rows for this source_path, something was skipped (malformed JSON,
    // unrecognized hook event, dedup race) -- keep the file as evidence.
    const lineCount = await countLines(file);
    const eventCount = eventCountForPath(file);
    if (eventCount < lineCount) {
      stats.reasons['kept-line-count-mismatch']++;
      stats.filesKept++;
      stats.perFile.push({ file, reason: 'kept-line-count-mismatch' });
      continue;
    }

    // Safe to delete.
    if (!dryRun) {
      try {
        await fsp.unlink(file);
      } catch {
        // Treat unlink failure as "keep" -- the file might be open or the
        // directory might be read-only. Either way, don't crash.
        stats.reasons['kept-stat-failed']++;
        stats.filesKept++;
        stats.perFile.push({ file, reason: 'kept-stat-failed' });
        continue;
      }
    }
    stats.reasons.deleted++;
    stats.filesDeleted++;
    stats.perFile.push({ file, reason: 'deleted' });
  }

  return stats;
}
