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
import { useStore } from './store.ts';
import { applyLiveness } from '../liveness.ts';

interface Counts {
  needs: number;
  active: number;
  idle: number;
  stale: number;
  done: number;
}

function tally(
  sessions: Map<string, import('../types.ts').SessionRow>,
  nowMs: number,
): Counts {
  const c: Counts = { needs: 0, active: 0, idle: 0, stale: 0, done: 0 };
  for (const r of sessions.values()) {
    const d = applyLiveness(r, nowMs);
    if (d === 'permission') {
      c.needs++;
    } else if (d === 'thinking' || d === 'tool' || d === 'waiting') {
      c.active++;
    } else if (d === 'idle') {
      c.idle++;
    } else if (d === 'stale') {
      c.stale++;
    } else if (d === 'done') {
      c.done++;
    }
  }
  return c;
}

const KEYMAP_GRID =
  '[d]ensity [a]ll [/]filter [r]econcile [enter]detail [q]uit';
const KEYMAP_DETAIL = '[esc]back [j/k]scroll [q]uit';

export function StatusBar({ nowMs }: { nowMs: number }): React.ReactElement {
  // useStdout subscription isn't strictly needed here, but reading it makes
  // the bar re-evaluate on terminal resize alongside everything else.
  useStdout();

  const mode = useStore((s) => s.mode);
  const filter = useStore((s) => s.filter);
  const filterMode = useStore((s) => s.filterMode);
  const showAll = useStore((s) => s.showAll);
  const density = useStore((s) => s.density);
  const sessions = useStore((s) => s.sessions);
  const setFilter = useStore((s) => s.setFilter);
  const setFilterMode = useStore((s) => s.setFilterMode);

  const counts = tally(sessions, nowMs);

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
        {counts.needs > 0 ? (
          <Text color="red" bold>
            ⚠ {counts.needs} needs you
          </Text>
        ) : (
          <Text dimColor>0 needs you</Text>
        )}
        <Text dimColor> · </Text>
        <Text color={counts.active > 0 ? 'cyan' : undefined} dimColor={counts.active === 0}>
          {counts.active} active
        </Text>
        <Text dimColor>
          {' '}· {counts.idle} idle · {counts.stale} stale
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
