// liveness.test.ts -- exercises every branch of deriveDisplayState.
//
// We synthesize SessionRow objects via a small factory rather than touching
// the DB; deriveDisplayState is pure (row + clock -> SessionState).

import { describe, expect, test } from 'bun:test';
import {
  ACTIVE_WINDOW_MS,
  FRESH_EVENT_GRACE_MS,
  deriveDisplayState,
  deriveLiveState,
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
    origin: null,
    context_tokens_used: null,
    context_tokens_max: null,
    context_source: null,
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

describe('deriveLiveState (combines /proc proof with fresh-event grace)', () => {
  test('proven alive: trust deriveDisplayState (DB state when fresh)', () => {
    // Old last-event but proven via proc — within ACTIVE_WINDOW returns DB state.
    const r = row({ state: 'waiting', last_event_at_ms: 1_000 });
    expect(deriveLiveState(r, 1_000, true)).toBe('waiting');
    // Past ACTIVE_WINDOW — proven idle.
    expect(deriveLiveState(r, 1_000 + ACTIVE_WINDOW_MS, true)).toBe('idle');
  });

  test('not proven, fresh event in grace: alive (covers lazy-lock startup)', () => {
    // SessionStart-just-fired Claude: row exists, .lock not yet open.
    // Without grace this would be 'done' (hidden); with grace we keep DB state.
    const r = row({ state: 'waiting', last_event_at_ms: 100_000 });
    // 0s, half-grace, 1ms-before-grace-expiry — all alive.
    expect(deriveLiveState(r, 100_000, false)).toBe('waiting');
    expect(deriveLiveState(r, 100_000 + 60_000, false)).toBe('waiting');
    expect(deriveLiveState(r, 100_000 + FRESH_EVENT_GRACE_MS - 1, false)).toBe('waiting');
  });

  test('not proven, event past grace: done (claude really is gone)', () => {
    const r = row({ state: 'waiting', last_event_at_ms: 100_000 });
    // Exactly at grace boundary the row flips to done — < strict, not <=.
    expect(deriveLiveState(r, 100_000 + FRESH_EVENT_GRACE_MS, false)).toBe('done');
    expect(deriveLiveState(r, 100_000 + FRESH_EVENT_GRACE_MS + 1, false)).toBe('done');
  });

  test('terminal done is preserved across both branches', () => {
    // Once the reducer marks state='done', neither proof nor grace should
    // resurrect it.
    const r = row({ state: 'done', last_event_at_ms: 100_000 });
    expect(deriveLiveState(r, 100_000, true)).toBe('done');
    expect(deriveLiveState(r, 100_000, false)).toBe('done');
    expect(deriveLiveState(r, 100_000 + FRESH_EVENT_GRACE_MS - 1, false)).toBe('done');
  });

  test('grace covers the observed Claude lazy-lock gap (~87s)', () => {
    // Concrete regression guard: the empirical SessionStart→.lock gap was 87s.
    // Make sure 87s after the last event we still consider the row alive when
    // proof is missing — this is the bug that motivated the grace.
    const r = row({ state: 'waiting', last_event_at_ms: 0 });
    expect(deriveLiveState(r, 87_000, false)).toBe('waiting');
  });
});
