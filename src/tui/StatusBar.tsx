// Top-of-screen attention status bar (v1.1).
//
// Replaces the old multi-line header. Renders:
//   agent-monitor · ⚠ N needs you · M active · K idle · L stale   [keymap]
//
// Counts are computed against the *full* session set (not the filtered/visible
// view) so the user sees the whole state of the world, not just what's on
// screen below.

import React from 'react';
import { Box, Text, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { useStore, visibleKeys } from './store.ts';
import { applyLiveness } from '../liveness.ts';

interface Counts {
  needs: number;    // permission_request — most urgent (red)
  waiting: number;  // turn ended, awaiting user input — your move (yellow, prominent)
  working: number;  // thinking / tool — agent is busy, no user action needed
  idle: number;     // no events for >ACTIVE_WINDOW_MS but still alive
  done: number;     // process gone
}

function tally(
  sessions: Map<string, import('../types.ts').SessionRow>,
  nowMs: number,
): Counts {
  const c: Counts = { needs: 0, waiting: 0, working: 0, idle: 0, done: 0 };
  for (const r of sessions.values()) {
    const d = applyLiveness(r, nowMs);
    if (d === 'permission') c.needs++;
    else if (d === 'waiting') c.waiting++;
    else if (d === 'thinking' || d === 'tool') c.working++;
    else if (d === 'idle') c.idle++;
    else if (d === 'done') c.done++;
  }
  return c;
}

const KEYMAP_GRID =
  '[d]ensity [a]ll [m]cp [c]opy-resume [/]filter [r]econcile [enter]detail [q]uit';
const KEYMAP_DETAIL = '[esc]back [j/k]scroll [q]uit';

export function StatusBar({ nowMs }: { nowMs: number }): React.ReactElement {
  // useStdout subscription isn't strictly needed here, but reading it makes
  // the bar re-evaluate on terminal resize alongside everything else.
  useStdout();

  const mode = useStore((s) => s.mode);
  const order = useStore((s) => s.order);
  const filter = useStore((s) => s.filter);
  const filterMode = useStore((s) => s.filterMode);
  const showAll = useStore((s) => s.showAll);
  const density = useStore((s) => s.density);
  const sessions = useStore((s) => s.sessions);
  const setFilter = useStore((s) => s.setFilter);
  const setFilterMode = useStore((s) => s.setFilterMode);

  // When a filter is active, tally over the filtered set so the counts match
  // what the user actually sees in the grid below. Otherwise tally globally.
  const filtered = filter
    ? new Map(
        visibleKeys(order, sessions, filter, { showAll: true, nowMs })
          .map((k) => [k, sessions.get(k)!] as const)
          .filter(([, v]) => v != null),
      )
    : sessions;
  const counts = tally(filtered, nowMs);

  // Keymap line: in filter-edit mode the input replaces the keymap.
  const keymap = mode === 'grid' ? KEYMAP_GRID : KEYMAP_DETAIL;

  // We render the bar in a flex box so the keymap right-aligns. When the
  // terminal is too narrow to fit both, the keymap wraps below — flex layout
  // handles that gracefully.
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>agent-monitor</Text>
        <Text dimColor> · </Text>
        {filter ? <Text color="yellow">filtered </Text> : null}
        {/* Permission requests — most urgent (red bold). */}
        {counts.needs > 0 ? (
          <Text color="red" bold>
            ⚠ {counts.needs} needs you
          </Text>
        ) : (
          <Text dimColor>0 needs you</Text>
        )}
        <Text dimColor> · </Text>
        {/* Waiting — "your turn" signal. Prominent yellow when nonzero so
            the user can spot it from the corner of their screen. */}
        {counts.waiting > 0 ? (
          <Text color="yellow" bold>
            ⏵ {counts.waiting} waiting
          </Text>
        ) : (
          <Text dimColor>0 waiting</Text>
        )}
        <Text dimColor> · </Text>
        {/* Working — busy doing things; no user action needed. */}
        <Text color={counts.working > 0 ? 'cyan' : undefined} dimColor={counts.working === 0}>
          {counts.working} working
        </Text>
        <Text dimColor>
          {' '}· {counts.idle} idle
          {showAll ? ` · ${counts.done} done` : ''} · density={density}
        </Text>
      </Box>
      <Box>
        {filterMode ? (
          <>
            <Text>filter: </Text>
            <TextInput
              value={filter}
              onChange={setFilter}
              onSubmit={() => setFilterMode(false)}
            />
            <Text dimColor>  (esc to exit)</Text>
          </>
        ) : (
          <Text dimColor>
            {keymap}
            {filter && mode === 'grid' ? `   filter: "${filter}" (esc clears)` : ''}
          </Text>
        )}
      </Box>
    </Box>
  );
}
