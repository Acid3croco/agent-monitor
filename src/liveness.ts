// State-age driven liveness override (M6).
//
// The DB's `state` column is set at event-ingest time by the state machine and
// stays as that lifecycle value (`thinking` / `tool` / `waiting` / `permission`
// / `done` / `recovered`). At read time, the TUI overlays this with an
// "is this still alive?" judgement based on how stale `last_event_at_ms` is.
//
// We deliberately never return `dead` in v1 -- per plan M6, hook payloads do
// not carry the agent's PID, so we can't trust process liveness. False-dead
// on a quietly-waiting session is worse than conservative `stale`.
//
// Pure function. Inputs are SessionRow + a wall clock; output is the display
// state to show in the grid. Same row at different times can return different
// states, which is the whole point.

import type { SessionRow, SessionState } from './types.ts';

// Tunables, exposed as constants for easy adjustment / test parameterization.
// Times are in milliseconds.
export const ACTIVE_WINDOW_MS = 30_000; // < 30s since last event: keep insert-time state as-is
export const IDLE_SOFT_WINDOW_MS = 90_000; // 30-90s if was actively running: idle (soft)
export const IDLE_HARD_WINDOW_MS = 600_000; // 90s-10min: still idle (soft); past that: stale

// The set of insert-time states that count as "actively running" for the
// idle-soft override. `waiting` is a turn-completed lull, not running.
const ACTIVE_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  'thinking',
  'tool',
  'waiting',
  'permission',
]);

// Compute the display state for a row at a given wall-clock instant.
//
// Logic (in order):
//   - state === 'done'                -> 'done'   (terminal; never overridden)
//   - now - last < 30s                -> state    (fresh enough; trust insert-time)
//   - now - last < 90s and was active -> 'idle'   (active state that quieted)
//   - now - last < 10min              -> 'idle'   (still soft; not stale yet)
//   - else                             -> 'stale' (long-quiet, no Stop hook)
export function deriveDisplayState(row: SessionRow, nowMs: number): SessionState {
  if (row.state === 'done') return 'done';

  const age = nowMs - row.last_event_at_ms;

  if (age < ACTIVE_WINDOW_MS) {
    // Fresh: trust the state machine's lifecycle value.
    return row.state;
  }

  if (age < IDLE_SOFT_WINDOW_MS && ACTIVE_STATES.has(row.state)) {
    // Was actively running but no events for 30-90s. Soft idle.
    return 'idle';
  }

  if (age < IDLE_HARD_WINDOW_MS) {
    // Still under the stale threshold; show as idle regardless of insert-time state.
    return 'idle';
  }

  return 'stale';
}
