// ambient.test.ts -- exercises the in-process indexer loop's contract:
//
//   1. Skip-if-overlapping: a slow drain must not double-fire while still in
//      flight. The next tick is dropped, not queued.
//   2. Errors don't crash the loop. A throwing drain is caught, logged, and
//      surfaced via onStatus; the next tick still runs.
//   3. stop() awaits in-flight passes so the DB doesn't close mid-write.
//
// We pass injected drainFn / reconcileFn closures rather than mock.module --
// bun's module-mocking is per-process, which would leak into the spool tests
// and cause spurious failures.

import { beforeEach, describe, expect, test } from 'bun:test';
import { startAmbientIndexer } from '../src/indexer/ambient.ts';

interface State {
  drainCalls: number;
  drainDelayMs: number;
  drainShouldThrow: boolean;
  drainThrowOnce: boolean;
  reconcileCalls: number;
  reconcileDelayMs: number;
}

function makeState(): State {
  return {
    drainCalls: 0,
    drainDelayMs: 0,
    drainShouldThrow: false,
    drainThrowOnce: false,
    reconcileCalls: 0,
    reconcileDelayMs: 0,
  };
}

let state = makeState();

beforeEach(() => {
  state = makeState();
});

function drainFn() {
  return async () => {
    state.drainCalls++;
    if (state.drainShouldThrow) throw new Error('boom drain');
    if (state.drainThrowOnce) {
      state.drainThrowOnce = false;
      throw new Error('one-shot drain failure');
    }
    if (state.drainDelayMs > 0) {
      await new Promise((r) => setTimeout(r, state.drainDelayMs));
    }
    return { filesScanned: 1, linesIngested: 0, linesSkipped: 0 };
  };
}

function reconcileFn() {
  return async () => {
    state.reconcileCalls++;
    if (state.reconcileDelayMs > 0) {
      await new Promise((r) => setTimeout(r, state.reconcileDelayMs));
    }
    return { filesScanned: 0, linesIngested: 0, linesSkipped: 0 };
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('startAmbientIndexer', () => {
  test('drains and reconciles on schedule', async () => {
    const h = startAmbientIndexer({
      drainIntervalMs: 50,
      reconcileIntervalMs: 80,
      drainFn: drainFn(),
      reconcileFn: reconcileFn(),
    });
    await sleep(220);
    await h.stop();

    expect(state.drainCalls).toBeGreaterThanOrEqual(2);
    expect(state.reconcileCalls).toBeGreaterThanOrEqual(1);
  });

  test('skip-if-overlapping: a slow drain does not pile up next ticks', async () => {
    state.drainDelayMs = 200;
    const h = startAmbientIndexer({
      drainIntervalMs: 30,
      reconcileIntervalMs: 10_000,
      drainFn: drainFn(),
      reconcileFn: reconcileFn(),
    });
    await sleep(240);
    await h.stop();

    // 240ms / 200ms-per-drain ~= 1.2 -> at most 2 calls. We MUST NOT see 5+
    // (which would indicate queueing).
    expect(state.drainCalls).toBeLessThanOrEqual(2);
    expect(state.drainCalls).toBeGreaterThanOrEqual(1);
  });

  test('errors are caught and surfaced via onStatus, not thrown', async () => {
    state.drainShouldThrow = true;
    const errors: string[] = [];
    const h = startAmbientIndexer({
      drainIntervalMs: 30,
      reconcileIntervalMs: 10_000,
      drainFn: drainFn(),
      reconcileFn: reconcileFn(),
      onStatus: (s) => {
        if (s.lastError) errors.push(s.lastError.message);
      },
    });
    await sleep(120);
    await h.stop();

    expect(state.drainCalls).toBeGreaterThanOrEqual(2);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]).toBe('boom drain');
  });

  test('a one-shot drain failure does not poison subsequent ticks', async () => {
    state.drainThrowOnce = true;
    const h = startAmbientIndexer({
      drainIntervalMs: 30,
      reconcileIntervalMs: 10_000,
      drainFn: drainFn(),
      reconcileFn: reconcileFn(),
    });
    await sleep(150);
    await h.stop();
    expect(state.drainCalls).toBeGreaterThanOrEqual(2);
  });

  test('stop() awaits an in-flight drain', async () => {
    state.drainDelayMs = 150;
    const h = startAmbientIndexer({
      drainIntervalMs: 1_000_000,
      reconcileIntervalMs: 1_000_000,
      drainFn: drainFn(),
      reconcileFn: reconcileFn(),
    });
    // Initial immediate drain is now mid-flight.
    await sleep(20);
    const stopStart = Date.now();
    await h.stop();
    const elapsed = Date.now() - stopStart;
    // Stop must NOT return until the in-flight 150ms drain finishes.
    expect(elapsed).toBeGreaterThan(50);
  });

  test('successful drain after error clears lastError', async () => {
    state.drainThrowOnce = true;
    let lastSeenError: string | null | undefined = undefined;
    const h = startAmbientIndexer({
      drainIntervalMs: 30,
      reconcileIntervalMs: 10_000,
      drainFn: drainFn(),
      reconcileFn: reconcileFn(),
      onStatus: (s) => {
        lastSeenError = s.lastError?.message ?? null;
      },
    });
    await sleep(150);
    await h.stop();
    // After the one-shot failure, subsequent successful drains clear the error.
    expect(lastSeenError).toBeNull();
  });
});
