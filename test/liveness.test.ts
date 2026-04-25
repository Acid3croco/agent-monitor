// liveness.test.ts -- exercises every branch of deriveDisplayState.
//
// We synthesize SessionRow objects via a small factory rather than touching
// the DB; deriveDisplayState is pure (row + clock -> SessionState).

import { describe, expect, test } from 'bun:test';
import { ACTIVE_WINDOW_MS, deriveDisplayState } from '../src/liveness.ts';
import type { SessionRow, SessionState } from '../src/types.ts';

function row(over: Partial<SessionRow>): SessionRow {
  return {
    key: 'k',
    provider: 'claude',
    session_id: 's',
    transcript_path: null,
    cwd: null,
    model: null,
    cli_version: null,
    pid: null,
    process_start_unix: null,
    started_at_ms: 0,
    last_event_at_ms: 0,
    prior_state: null,
    state: 'thinking',
    current_tool: null,
    last_prompt: null,
    observed_parent_pid: null,
    ...over,
  };
}

describe('deriveDisplayState', () => {
  test('done is terminal — always returns done regardless of age', () => {
    const r = row({ state: 'done', last_event_at_ms: 0 });
    expect(deriveDisplayState(r, 1_000)).toBe('done');
    expect(deriveDisplayState(r, 60 * 60 * 1000)).toBe('done');
    expect(deriveDisplayState(r, 365 * 24 * 60 * 60 * 1000)).toBe('done');
  });

  test('fresh DB states pass through unchanged within ACTIVE_WINDOW_MS', () => {
    const baseTs = 1_000_000;
    const states: SessionState[] = [
      'thinking',
      'tool',
      'waiting',
      'permission',
      'recovered',
    ];
    for (const s of states) {
      const r = row({ state: s, last_event_at_ms: baseTs });
      // Just-now, 1 minute later, 59 minutes later — all return the DB state.
      expect(deriveDisplayState(r, baseTs)).toBe(s);
      expect(deriveDisplayState(r, baseTs + 60 * 1000)).toBe(s);
      expect(deriveDisplayState(r, baseTs + ACTIVE_WINDOW_MS - 1)).toBe(s);
    }
  });

  test('past ACTIVE_WINDOW_MS — any non-done state becomes idle', () => {
    for (const s of ['thinking', 'tool', 'waiting', 'permission', 'recovered'] as SessionState[]) {
      const r = row({ state: s, last_event_at_ms: 0 });
      expect(deriveDisplayState(r, ACTIVE_WINDOW_MS)).toBe('idle');
      expect(deriveDisplayState(r, ACTIVE_WINDOW_MS + 60_000)).toBe('idle');
      // Even days later — still idle (not stale; stale was removed in
      // favor of process-liveness driving DONE).
      expect(deriveDisplayState(r, 24 * 60 * 60 * 1000)).toBe('idle');
      expect(deriveDisplayState(r, 7 * 24 * 60 * 60 * 1000)).toBe('idle');
    }
  });

  test('never returns dead — that state is reserved for future PID liveness', () => {
    for (const s of ['thinking', 'tool', 'waiting', 'permission', 'recovered'] as SessionState[]) {
      for (const ageMs of [0, 1_000, ACTIVE_WINDOW_MS, 7 * 24 * 60 * 60 * 1000]) {
        const r = row({ state: s, last_event_at_ms: 0 });
        expect(deriveDisplayState(r, ageMs)).not.toBe('dead');
      }
    }
  });

  test('exact window boundary: < strict, not <=', () => {
    const r = row({ state: 'thinking', last_event_at_ms: 0 });
    expect(deriveDisplayState(r, ACTIVE_WINDOW_MS - 1)).toBe('thinking');
    expect(deriveDisplayState(r, ACTIVE_WINDOW_MS)).toBe('idle');
  });
});
