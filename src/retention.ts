// Events table retention (M6).
//
// Drop `events` rows older than maxAgeDays in bounded chunks so the UI never
// stalls on a large delete. Each chunk is its own transaction, so a long-running
// compaction can be interrupted (Ctrl-C) without losing partial progress.
//
// Sessions rows are NEVER deleted by retention -- they are small and provide
// the long-tail history (agents you talked to last month). Pruning them would
// also orphan the FK from any retained event for that session.
//
// No VACUUM. SQLite reclaims free pages internally via the WAL; an explicit
// VACUUM rewrites the entire DB file and is not safe to run while the TUI is
// reading. If the file ever grows unwieldy, that's a separate command.

import { db } from './store/db.ts';

export interface CompactOptions {
  maxAgeDays?: number;  // default: 7
  batchSize?: number;   // default: 1000 rows per transaction
  // Override "now" for tests. Defaults to Date.now().
  nowMs?: number;
}

export interface CompactStats {
  rowsDeleted: number;
  batches: number;
  durationMs: number;
}

const SQL_DELETE_BATCH = `
DELETE FROM events
WHERE id IN (
  SELECT id FROM events
  WHERE observed_at_ms < $cutoff
  LIMIT $batch
)
`;

// Run one full compaction pass. Loops batched DELETE until a pass deletes
// nothing. Caller schedules cadence (the TUI runs this maybe once a day; the
// `compact` CLI runs it on demand).
export async function compactOnce(opts: CompactOptions = {}): Promise<CompactStats> {
  const maxAgeDays = opts.maxAgeDays ?? 7;
  const batchSize = opts.batchSize ?? 1000;
  const now = opts.nowMs ?? Date.now();
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;

  const handle = db();
  // Cache the prepared statement once -- bun:sqlite already caches via `prepare`,
  // but we want to avoid re-parsing on every batch.
  const stmt = handle.prepare(SQL_DELETE_BATCH);

  const start = Date.now();
  let rowsDeleted = 0;
  let batches = 0;

  // Loop until a batch deletes 0 rows. SQLite's `DELETE ... LIMIT` is a
  // bun:sqlite + sqlite-with-LIMIT extension; the subquery wrapper ensures
  // it works on the standard build too.
  // Each batch is its own implicit transaction. We do NOT wrap the loop in
  // BEGIN/COMMIT -- a long-running outer transaction would block readers and
  // hold WAL space.
  // Safety bound: cap at 1e6 batches so a runaway query (e.g. clock skew
  // dropping all events) still terminates in finite time.
  for (let i = 0; i < 1_000_000; i++) {
    const info = stmt.run({ $cutoff: cutoff, $batch: batchSize });
    const n = Number(info.changes);
    if (n === 0) break;
    rowsDeleted += n;
    batches++;
    // Yield to the event loop between batches so the TUI tick can run.
    await new Promise<void>((r) => setImmediate(r));
  }

  return {
    rowsDeleted,
    batches,
    durationMs: Date.now() - start,
  };
}
