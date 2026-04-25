// M0 spike — seed /tmp/agent-monitor-spike.db with 100 realistic-looking sessions.
// Mirrors the v1 plan's sessions schema, minus columns the spike doesn't exercise.
//
// Run: bun run spike:seed

import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';

const DB_PATH = '/tmp/agent-monitor-spike.db';
const N = 100;

const PROVIDERS = ['claude', 'codex'] as const;
const STATES = ['thinking', 'tool', 'permission', 'waiting'] as const;
const TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'WebFetch', null];
const CWDS = [
  '/home/jack/projects/tui',
  '/home/jack/projects/agent-monitor',
  '/home/jack/work/api-server',
  '/home/jack/work/frontend',
  '/home/jack/scratch/playground',
  '/home/jack/projects/data-pipeline',
  '/tmp/quick-experiment',
];
const MODELS = ['claude-opus-4-7', 'claude-sonnet-4-5', 'gpt-5-codex', 'o3-codex'];
const PROMPTS = [
  'add a memoization layer to the grid cells',
  'fix the flicker on resize',
  'why is the indexer dropping events',
  'refactor the reducer to be pure',
  'write a test for the state machine',
  'investigate WAL contention under load',
  'draft the M0 spike report',
  'audit the hook payload size cap',
];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function shortHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 16);
}

const db = new Database(DB_PATH, { create: true });
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');

db.exec('DROP TABLE IF EXISTS sessions');
db.exec(`
  CREATE TABLE sessions (
    key                TEXT PRIMARY KEY,
    provider           TEXT NOT NULL,
    session_id         TEXT NOT NULL,
    cwd                TEXT,
    model              TEXT,
    started_at_ms      INTEGER NOT NULL,
    last_event_at_ms   INTEGER NOT NULL,
    state              TEXT NOT NULL,
    current_tool       TEXT,
    last_prompt        TEXT
  );
`);
db.exec('CREATE INDEX sessions_state_idx ON sessions(state, last_event_at_ms);');

const now = Date.now();
const insert = db.prepare(`
  INSERT INTO sessions (key, provider, session_id, cwd, model,
                        started_at_ms, last_event_at_ms, state, current_tool, last_prompt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const tx = db.transaction(() => {
  for (let i = 0; i < N; i++) {
    const provider = pick(PROVIDERS);
    const sessionId = `${provider}-sess-${String(i).padStart(3, '0')}-${Math.random().toString(36).slice(2, 8)}`;
    const cwd = pick(CWDS);
    const key = `${provider}:${sessionId}:${shortHash(cwd)}`;
    const state = pick(STATES);
    const tool = state === 'tool' ? pick(TOOLS.filter((t) => t !== null) as string[]) : null;
    const startedAt = now - Math.floor(Math.random() * 1000 * 60 * 60); // up to 1h ago
    const lastEvent = startedAt + Math.floor(Math.random() * (now - startedAt));
    insert.run(
      key,
      provider,
      sessionId,
      cwd,
      pick(MODELS),
      startedAt,
      lastEvent,
      state,
      tool,
      pick(PROMPTS),
    );
  }
});
tx();

const count = (db.query('SELECT COUNT(*) as c FROM sessions').get() as { c: number }).c;
const byState = db.query('SELECT state, COUNT(*) as c FROM sessions GROUP BY state').all();
const byProvider = db.query('SELECT provider, COUNT(*) as c FROM sessions GROUP BY provider').all();

console.log(`seeded ${count} rows in ${DB_PATH}`);
console.log('by state:', byState);
console.log('by provider:', byProvider);

db.close();
