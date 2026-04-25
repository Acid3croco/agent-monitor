// Reconciler tests. We copy the sanitized rollout fixtures into a tmp directory
// (mimicking the real layout: ~/.claude/projects/<dir>/<file>.jsonl and
// ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sid>.jsonl), point the reconciler
// at them with an isolated DB, and assert what landed in the DB.
//
// We don't touch ~/.claude or ~/.codex.

import { describe, expect, test, afterEach } from 'bun:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runReconcileOnce } from '../src/reconciler/index.ts';
import { closeDb, openDb } from '../src/store/db.ts';
import { insertEvent, upsertSession } from '../src/store/queries.ts';
import type { NormalizedEvent } from '../src/types.ts';

const FIXTURES_DIR = new URL('./fixtures/', import.meta.url).pathname;

const CLAUDE_FIXTURE = 'claude-rollout-sample.jsonl';
const CODEX_FIXTURE = 'codex-rollout-sample.jsonl';

interface Tmp {
  root: string;
  claudeRoot: string;
  codexRoot: string;
  dbPath: string;
  claudeFile: string;
  codexFile: string;
  cleanup: () => Promise<void>;
}

async function mkTmp(): Promise<Tmp> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-monitor-recon-'));
  const claudeRoot = path.join(root, 'claude');
  const codexRoot = path.join(root, 'codex');
  const dbPath = path.join(root, 'events.db');

  // Mimic the real layouts.
  const claudeProjectDir = path.join(claudeRoot, '-home-jack-projects-tui');
  const codexDayDir = path.join(codexRoot, '2026', '04', '25');
  fs.mkdirSync(claudeProjectDir, { recursive: true });
  fs.mkdirSync(codexDayDir, { recursive: true });

  const claudeFile = path.join(
    claudeProjectDir,
    '00000000-0000-4000-8000-000000000001.jsonl',
  );
  const codexFile = path.join(
    codexDayDir,
    'rollout-2026-04-25T12-00-00-019dc000-0000-7000-8000-000000000001.jsonl',
  );

  await fsp.copyFile(path.join(FIXTURES_DIR, CLAUDE_FIXTURE), claudeFile);
  await fsp.copyFile(path.join(FIXTURES_DIR, CODEX_FIXTURE), codexFile);

  return {
    root,
    claudeRoot,
    codexRoot,
    dbPath,
    claudeFile,
    codexFile,
    cleanup: async () => {
      closeDb();
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

let active: Tmp | null = null;
afterEach(async () => {
  if (active) {
    await active.cleanup();
    active = null;
  }
});

describe('reconciler: full rollout ingest', () => {
  test('ingests claude + codex rollouts on first pass', async () => {
    active = await mkTmp();
    openDb(active.dbPath);

    const stats = await runReconcileOnce({
      claudeRoot: active.claudeRoot,
      codexRoot: active.codexRoot,
      dbPath: active.dbPath,
    });

    expect(stats.filesScanned).toBe(2);
    expect(stats.linesIngested).toBeGreaterThan(0);

    // Sanity-check what we expect from each fixture:
    //  - Claude fixture has 9 lines: ignored=permission-mode, file-history-snapshot,
    //    3x attachments, 2x assistants where one is end_turn (text only) and one is
    //    tool_use, 1x last-prompt. Mapped: 1 user_prompt, 1 tool_call_start,
    //    1 turn_complete = 3 events.
    //  - Codex fixture has 10 lines: ignored=task_started, agent_message,
    //    reasoning, turn_context (metadata-only), token_count (metadata-only).
    //    Mapped:
    //    1 session_start, 1 user_prompt, 1 function_call (tool_call_start),
    //    1 function_call_output (tool_call_end), 1 task_complete = 5 events.
    const db = openDb(active.dbPath);
    const counts = db
      .query<{ kind: string; n: number }, []>(
        'SELECT kind, COUNT(*) AS n FROM events GROUP BY kind ORDER BY kind',
      )
      .all();
    const byKind = Object.fromEntries(counts.map((r) => [r.kind, r.n]));

    expect(byKind.user_prompt).toBe(2); // 1 claude + 1 codex
    expect(byKind.tool_call_start).toBe(2); // 1 claude + 1 codex
    expect(byKind.tool_call_end).toBe(1); // codex only
    expect(byKind.turn_complete).toBe(2); // 1 claude + 1 codex
    expect(byKind.session_start).toBe(1); // codex only

    const total = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM events').get();
    expect(total?.n).toBe(8);

    // Source paths and source set to 'rollout'.
    const sources = db
      .query<{ source: string; source_path: string }, []>(
        'SELECT DISTINCT source, source_path FROM events ORDER BY source_path',
      )
      .all();
    expect(sources.length).toBe(2);
    for (const r of sources) expect(r.source).toBe('rollout');
    expect(new Set(sources.map((r) => r.source_path))).toEqual(
      new Set([active.claudeFile, active.codexFile]),
    );

    // Sessions row materialized for both providers.
    const sessions = db
      .query<{ provider: string; session_id: string; cwd: string | null }, []>(
        'SELECT provider, session_id, cwd FROM sessions ORDER BY provider',
      )
      .all();
    expect(sessions.length).toBe(2);
    expect(sessions.find((s) => s.provider === 'claude')?.cwd).toBe(
      '/home/jack/projects/tui',
    );
    expect(sessions.find((s) => s.provider === 'codex')?.cwd).toBe(
      '/home/jack/projects/tui',
    );

    const contextRows = db
      .query<
        { provider: string; used: number | null; max: number | null; src: string | null },
        []
      >(
        `SELECT provider,
                context_tokens_used AS used,
                context_tokens_max AS max,
                context_source AS src
           FROM sessions ORDER BY provider`,
      )
      .all();
    const claudeCtx = contextRows.find((r) => r.provider === 'claude');
    expect(claudeCtx?.used).toBe(2);
    // Default for opus/sonnet bumped from 200k → 1M (matches Pro-tier reality).
    expect(claudeCtx?.max).toBe(1_000_000);
    expect(claudeCtx?.src).toBe('model_lookup');

    const codexCtx = contextRows.find((r) => r.provider === 'codex');
    expect(codexCtx?.used).toBe(2);
    expect(codexCtx?.max).toBe(258_400);
    expect(codexCtx?.src).toBe('reported');
  });

  test('re-running the reconciler is idempotent', async () => {
    active = await mkTmp();
    openDb(active.dbPath);

    await runReconcileOnce({
      claudeRoot: active.claudeRoot,
      codexRoot: active.codexRoot,
      dbPath: active.dbPath,
    });
    const db = openDb(active.dbPath);
    const before = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM events').get();

    const second = await runReconcileOnce({
      claudeRoot: active.claudeRoot,
      codexRoot: active.codexRoot,
      dbPath: active.dbPath,
    });
    expect(second.linesIngested).toBe(0);

    const after = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM events').get();
    expect(after?.n).toBe(before?.n);
  });

  test('dedup respected: rows from another path are kept when one path is wiped', async () => {
    active = await mkTmp();
    openDb(active.dbPath);

    await runReconcileOnce({
      claudeRoot: active.claudeRoot,
      codexRoot: active.codexRoot,
      dbPath: active.dbPath,
    });

    const db = openDb(active.dbPath);
    const claudeBefore = db
      .query<{ n: number }, [{ $p: string }]>(
        'SELECT COUNT(*) AS n FROM events WHERE source_path = $p',
      )
      .get({ $p: active.claudeFile });

    // Delete only the Codex events; Claude rows must survive untouched.
    db.query<unknown, [{ $p: string }]>(
      'DELETE FROM events WHERE source_path = $p',
    ).run({ $p: active.codexFile });

    // Re-running picks up Codex from offset 0 (since no rows for it remain),
    // and keeps Claude as-is (existing rows still there -> dedup kicks in).
    const stats = await runReconcileOnce({
      claudeRoot: active.claudeRoot,
      codexRoot: active.codexRoot,
      dbPath: active.dbPath,
    });

    // Codex events were re-ingested.
    expect(stats.linesIngested).toBeGreaterThan(0);

    const claudeAfter = db
      .query<{ n: number }, [{ $p: string }]>(
        'SELECT COUNT(*) AS n FROM events WHERE source_path = $p',
      )
      .get({ $p: active.claudeFile });
    expect(claudeAfter?.n).toBe(claudeBefore?.n);
  });

  test('offset resume: pre-seeded rows cause early lines to be skipped', async () => {
    active = await mkTmp();
    openDb(active.dbPath);

    // Compute the byte offset that lies BETWEEN line 3 and line 4 of the Claude
    // fixture. Anything <= that offset is "already ingested" and must be
    // skipped on the next pass.
    const buf = await fsp.readFile(active.claudeFile);
    const lineStarts: number[] = [0];
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i] === 0x0a) lineStarts.push(i + 1);
    }
    // First three lines = indices 0..2; the cutoff is the offset of line 2
    // (the third line, zero-indexed). After dedup, lines 0..2 must be skipped.
    const cutoff = lineStarts[2]!;

    // Pre-seed: a session row + an event row with source_offset == cutoff so
    // getMaxOffsetForPath returns it, and the dedup loop skips offsets <= cutoff.
    upsertSession({
      key: 'claude:00000000-0000-4000-8000-000000000001:dummy',
      provider: 'claude',
      session_id: '00000000-0000-4000-8000-000000000001',
      observed_at_ms: 1,
      state: 'waiting',
      transcript_path: active.claudeFile,
      cwd: '/home/jack/projects/tui',
    });
    const seedEvent: NormalizedEvent = {
      session_key: 'claude:00000000-0000-4000-8000-000000000001:dummy',
      observed_at_ms: 1,
      source: 'rollout',
      source_path: active.claudeFile,
      source_offset: cutoff,
      kind: 'session_start',
    };
    insertEvent(seedEvent);

    const db = openDb(active.dbPath);
    const before = db
      .query<{ n: number }, [{ $p: string }]>(
        'SELECT COUNT(*) AS n FROM events WHERE source_path = $p',
      )
      .get({ $p: active.claudeFile });
    expect(before?.n).toBe(1); // just the seed

    // Run reconciler against ONLY the Claude root -- isolate to make the
    // assertion easy.
    const stats = await runReconcileOnce({
      claudeRoot: active.claudeRoot,
      codexRoot: path.join(active.root, 'codex-empty'), // does not exist
      dbPath: active.dbPath,
    });
    expect(stats.filesScanned).toBe(1);

    const after = db
      .query<{ n: number }, [{ $p: string }]>(
        'SELECT COUNT(*) AS n FROM events WHERE source_path = $p',
      )
      .get({ $p: active.claudeFile });

    // The Claude fixture mapped to 3 events (user_prompt, tool_call_start,
    // turn_complete). With the dedup cutoff sitting between lines 2 and 3
    // (i.e. before the user prompt at line 2), all three are still after the
    // cutoff and get ingested. Total = seed (1) + 3 = 4.
    //
    // The exact assertion we care about: the seed survived AND no duplicate
    // got inserted at offset <= cutoff. Verify that with a direct query.
    const dupes = db
      .query<{ n: number }, [{ $p: string; $c: number }]>(
        'SELECT COUNT(*) AS n FROM events WHERE source_path = $p AND source_offset <= $c',
      )
      .get({ $p: active.claudeFile, $c: cutoff });
    expect(dupes?.n).toBe(1); // only the seed

    const newRows = db
      .query<{ n: number }, [{ $p: string; $c: number }]>(
        'SELECT COUNT(*) AS n FROM events WHERE source_path = $p AND source_offset > $c',
      )
      .get({ $p: active.claudeFile, $c: cutoff });
    expect(newRows?.n).toBe((after?.n ?? 0) - 1); // everything past cutoff is fresh
    expect(after?.n).toBeGreaterThan(before?.n ?? 0);
  });
});
