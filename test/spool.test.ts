// Spool tailer tests. We write fake hook envelopes to a tmpdir spool, point
// the tailer at it (with an isolated DB path), and assert events landed with
// the right (source_path, source_offset). Re-running must be idempotent.

import { describe, expect, test, afterEach } from 'bun:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { drainOnce } from '../src/indexer/spool.ts';
import { closeDb, openDb } from '../src/store/db.ts';
import {
  getKnownSourcePaths,
  getMaxOffsetForPath,
} from '../src/store/queries.ts';
import type { HookEnvelope } from '../src/types.ts';

interface Tmp {
  root: string;
  spool: string;
  db: string;
  cleanup: () => Promise<void>;
}

async function mkTmp(): Promise<Tmp> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-monitor-test-'));
  const spool = path.join(root, 'spool');
  const db = path.join(root, 'events.db');
  fs.mkdirSync(spool, { recursive: true });
  return {
    root,
    spool,
    db,
    cleanup: async () => {
      closeDb();
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

function writeEnvelopes(filePath: string, envs: HookEnvelope[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = envs.map((e) => JSON.stringify(e) + '\n').join('');
  fs.appendFileSync(filePath, lines);
}

function appendEnvelope(filePath: string, env: HookEnvelope): number {
  // Returns the byte offset at which this record was written.
  const before = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  fs.appendFileSync(filePath, JSON.stringify(env) + '\n');
  return before;
}

let active: Tmp | null = null;
afterEach(async () => {
  if (active) {
    await active.cleanup();
    active = null;
  }
});

describe('spool tailer', () => {
  test('drains a fresh spool file end-to-end and records source offsets', async () => {
    active = await mkTmp();
    const sessionDir = path.join(active.spool, 'claude', 'abc123');
    const file = path.join(sessionDir, '20260425.jsonl');

    const envs: HookEnvelope[] = [
      {
        provider: 'claude',
        event: 'SessionStart',
        session_id: 'spool-sess-1',
        observed_at_ms: 1000,
        payload: {
          cwd: '/home/jack',
          model: 'claude-opus-4-7',
          transcript_path: '/tmp/t1',
        },
      },
      {
        provider: 'claude',
        event: 'UserPromptSubmit',
        session_id: 'spool-sess-1',
        observed_at_ms: 1100,
        payload: { prompt: 'hello' },
      },
      {
        provider: 'claude',
        event: 'PreToolUse',
        session_id: 'spool-sess-1',
        observed_at_ms: 1200,
        payload: { tool_name: 'Bash' },
      },
    ];
    writeEnvelopes(file, envs);

    openDb(active.db);
    const stats = await drainOnce({ spoolRoot: active.spool, dbPath: active.db });
    expect(stats.filesScanned).toBe(1);
    expect(stats.linesIngested).toBe(3);

    // The DB now knows about this file's path.
    expect(getKnownSourcePaths()).toEqual([file]);

    // Max offset = byte offset at the START of the last record.
    const lastBytes =
      Buffer.byteLength(JSON.stringify(envs[0]) + '\n') +
      Buffer.byteLength(JSON.stringify(envs[1]) + '\n');
    expect(getMaxOffsetForPath(file)).toBe(lastBytes);

    // Sessions row exists with the right state (PreToolUse -> tool).
    const db = openDb(active.db);
    const sess = db
      .query<{ state: string; cwd: string; model: string; current_tool: string }, []>(
        'SELECT state, cwd, model, current_tool FROM sessions',
      )
      .all();
    expect(sess.length).toBe(1);
    expect(sess[0]!.state).toBe('tool');
    expect(sess[0]!.cwd).toBe('/home/jack');
    expect(sess[0]!.model).toBe('claude-opus-4-7');
    expect(sess[0]!.current_tool).toBe('Bash');
  });

  test('re-running the drain ingests nothing new (idempotent)', async () => {
    active = await mkTmp();
    const file = path.join(active.spool, 'claude', 'abc', '20260425.jsonl');
    writeEnvelopes(file, [
      {
        provider: 'claude',
        event: 'SessionStart',
        session_id: 's2',
        observed_at_ms: 1,
        payload: { cwd: '/x', transcript_path: '/t' },
      },
      {
        provider: 'claude',
        event: 'UserPromptSubmit',
        session_id: 's2',
        observed_at_ms: 2,
        payload: { prompt: 'hi' },
      },
    ]);

    openDb(active.db);
    const first = await drainOnce({ spoolRoot: active.spool, dbPath: active.db });
    expect(first.linesIngested).toBe(2);

    const second = await drainOnce({ spoolRoot: active.spool, dbPath: active.db });
    expect(second.linesIngested).toBe(0);
    // filesScanned is still 1 -- the file is still there, just nothing new.
    expect(second.filesScanned).toBe(1);
  });

  test('appending new envelopes after a drain picks them up on the next pass', async () => {
    active = await mkTmp();
    const file = path.join(active.spool, 'codex', 'def', '20260425.jsonl');
    writeEnvelopes(file, [
      {
        provider: 'codex',
        event: 'SessionStart',
        session_id: 'cs1',
        observed_at_ms: 1,
        payload: { cwd: '/x', transcript_path: '/t' },
      },
    ]);

    openDb(active.db);
    await drainOnce({ spoolRoot: active.spool, dbPath: active.db });
    const offsetAfterFirst = getMaxOffsetForPath(file);
    expect(offsetAfterFirst).toBe(0);

    // Append a new record, drain again -- only the new one should be inserted.
    appendEnvelope(file, {
      provider: 'codex',
      event: 'UserPromptSubmit',
      session_id: 'cs1',
      observed_at_ms: 2,
      payload: { prompt: 'second' },
    });

    const stats = await drainOnce({ spoolRoot: active.spool, dbPath: active.db });
    expect(stats.linesIngested).toBe(1);
    // The DB now has two events on this path; max_offset should have moved.
    const db = openDb(active.db);
    const count = db
      .query<{ c: number }, []>('SELECT COUNT(*) AS c FROM events')
      .get();
    expect(count?.c).toBe(2);
  });

  test('skips unrecognized hook event names without crashing', async () => {
    active = await mkTmp();
    const file = path.join(active.spool, 'claude', 'ghi', '20260425.jsonl');
    writeEnvelopes(file, [
      {
        provider: 'claude',
        event: 'SomeFutureHook',
        session_id: 'sx',
        observed_at_ms: 1,
        payload: { foo: 'bar' },
      },
    ]);

    openDb(active.db);
    const stats = await drainOnce({ spoolRoot: active.spool, dbPath: active.db });
    expect(stats.filesScanned).toBe(1);
    expect(stats.linesIngested).toBe(0);
    expect(stats.linesSkipped).toBe(1);
  });
});
