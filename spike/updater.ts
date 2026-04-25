// M0 spike — mutate session rows at 10 Hz to drive the TUI under load.
// Each tick: pick ~10 rows, rotate their state, bump last_event_at_ms,
// occasionally swap current_tool. Runs forever. Clean exit on SIGINT/SIGTERM.
//
// Run: bun run spike:updater

import { Database } from 'bun:sqlite';

const DB_PATH = '/tmp/agent-monitor-spike.db';
const TICK_MS = 100; // 10 Hz
const ROWS_PER_TICK = 10;

const STATES = ['thinking', 'tool', 'permission', 'waiting'] as const;
const TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'WebFetch'];

const db = new Database(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');

const allKeysRow = db.query('SELECT key FROM sessions').all() as { key: string }[];
if (allKeysRow.length === 0) {
  console.error('no sessions in db; run `bun run spike:seed` first');
  process.exit(1);
}
const keys = allKeysRow.map((r) => r.key);

const update = db.prepare(`
  UPDATE sessions
     SET state = ?, current_tool = ?, last_event_at_ms = ?
   WHERE key = ?
`);

let ticks = 0;
const interval = setInterval(() => {
  const now = Date.now();
  const tx = db.transaction(() => {
    for (let i = 0; i < ROWS_PER_TICK; i++) {
      const key = keys[Math.floor(Math.random() * keys.length)]!;
      const state = STATES[Math.floor(Math.random() * STATES.length)]!;
      const tool =
        state === 'tool'
          ? TOOLS[Math.floor(Math.random() * TOOLS.length)]!
          : Math.random() < 0.1
            ? TOOLS[Math.floor(Math.random() * TOOLS.length)]!
            : null;
      update.run(state, tool, now, key);
    }
  });
  tx();
  ticks++;
  if (ticks % 50 === 0) {
    // brief heartbeat to stderr (so it doesn't pollute pipes)
    console.error(`updater: ${ticks} ticks (${ticks * ROWS_PER_TICK} updates)`);
  }
}, TICK_MS);

function shutdown(sig: string) {
  console.error(`\nupdater: received ${sig}, shutting down after ${ticks} ticks`);
  clearInterval(interval);
  db.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
