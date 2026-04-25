// liveness.test.ts -- exercises every branch of deriveDisplayState.
//
// We synthesize SessionRow objects via a small factory rather than touching
// the DB; deriveDisplayState is pure (row + clock -> SessionState).

import { describe, expect, test } from 'bun:test';
import {
  ACTIVE_WINDOW_MS,
  IDLE_HARD_WINDOW_MS,
  IDLE_SOFT_WINDOW_MS,
  deriveDisplayState,
} from '../src/liveness.ts';
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
  test('done is terminal -- always returns done regardless of age', () => {
    const r = row({ state: 'done', last_event_at_ms: 0 });
    // 1 hour ago, 1 day ago, even 1 year ago -- done stays done.
    expect(deriveDisplayState(r, 1_000)).toBe('done');
    expect(deriveDisplayState(r, 60 * 60 * 1000)).toBe('done');
    expect(deriveDisplayState(r, 365 * 24 * 60 * 60 * 1000)).toBe('done');
  });

  test('fresh active states pass through unchanged', () => {
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
      // 0s, 5s, 29s -> all under ACTIVE_WINDOW_MS (30s); pass through.
      expect(deriveDisplayState(r, baseTs)).toBe(s);
      expect(deriveDisplayState(r, baseTs + 5_000)).toBe(s);
      expect(deriveDisplayState(r, baseTs + ACTIVE_WINDOW_MS - 1)).toBe(s);
    }
  });

  test('active states between 30s and 90s become idle', () => {
    const ts = 0;
    for (const s of ['thinking', 'tool', 'permission', 'waiting'] as SessionState[]) {
      const r = row({ state: s, last_event_at_ms: ts });
      expect(deriveDisplayState(r, ts + ACTIVE_WINDOW_MS)).toBe('idle');
      expect(deriveDisplayState(r, ts + ACTIVE_WINDOW_MS + 10_000)).toBe('idle');
      expect(deriveDisplayState(r, ts + IDLE_SOFT_WINDOW_MS - 1)).toBe('idle');
    }
  });

  test('non-active state in the 30-90s window still returns idle (soft window)', () => {
    // recovered isn't in ACTIVE_STATES, but the second branch only matches
    // active states. Still under 10min, so the third branch returns 'idle'.
    const r = row({ state: 'recovered', last_event_at_ms: 0 });
    expect(deriveDisplayState(r, ACTIVE_WINDOW_MS + 1_000)).toBe('idle');
  });

  test('any non-done state past the soft window becomes idle until 10min', () => {
    for (const s of ['thinking', 'tool', 'waiting', 'permission', 'recovered'] as SessionState[]) {
      const r = row({ state: s, last_event_at_ms: 0 });
      expect(deriveDisplayState(r, IDLE_SOFT_WINDOW_MS)).toBe('idle');
      expect(deriveDisplayState(r, IDLE_SOFT_WINDOW_MS + 60_000)).toBe('idle');
      expect(deriveDisplayState(r, IDLE_HARD_WINDOW_MS - 1)).toBe('idle');
    }
  });

  test('past the 10min hard window becomes stale (not dead)', () => {
    for (const s of ['thinking', 'tool', 'waiting', 'permission', 'recovered'] as SessionState[]) {
      const r = row({ state: s, last_event_at_ms: 0 });
      expect(deriveDisplayState(r, IDLE_HARD_WINDOW_MS)).toBe('stale');
      expect(deriveDisplayState(r, IDLE_HARD_WINDOW_MS + 60_000)).toBe('stale');
      // Day-old session: still stale, never dead.
      expect(deriveDisplayState(r, 24 * 60 * 60 * 1000)).toBe('stale');
    }
  });

  test('never returns dead in v1', () => {
    // No combination of inputs should return 'dead'. We sweep a broad range.
    for (const s of [
      'thinking',
      'tool',
      'waiting',
      'permission',
      'recovered',
    ] as SessionState[]) {
      for (const ageMs of [0, 1_000, ACTIVE_WINDOW_MS, IDLE_SOFT_WINDOW_MS, IDLE_HARD_WINDOW_MS, 7 * 24 * 60 * 60 * 1000]) {
        const r = row({ state: s, last_event_at_ms: 0 });
        const display = deriveDisplayState(r, ageMs);
        expect(display).not.toBe('dead');
      }
    }
  });

  test('exact window boundaries: < strict, not <=', () => {
    // ACTIVE_WINDOW_MS exactly: should NOT return state (out of fresh window),
    // but for an active state it falls into the soft idle branch -> idle.
    const r = row({ state: 'thinking', last_event_at_ms: 0 });
    expect(deriveDisplayState(r, ACTIVE_WINDOW_MS - 1)).toBe('thinking');
    expect(deriveDisplayState(r, ACTIVE_WINDOW_MS)).toBe('idle');
    expect(deriveDisplayState(r, IDLE_SOFT_WINDOW_MS - 1)).toBe('idle');
    expect(deriveDisplayState(r, IDLE_SOFT_WINDOW_MS)).toBe('idle');
    expect(deriveDisplayState(r, IDLE_HARD_WINDOW_MS - 1)).toBe('idle');
    expect(deriveDisplayState(r, IDLE_HARD_WINDOW_MS)).toBe('stale');
  });
});
