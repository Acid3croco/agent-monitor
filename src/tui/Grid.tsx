// Adaptive grid: lays out the visible session cells in N columns, where N is
// derived from the current terminal width. Re-reads stdout.columns on every
// render — Ink does not subscribe to resize, but the 200 ms tick triggers a
// render anyway, so resize visibly settles within one tick.

import React, { useMemo } from 'react';
import { Box, Text, useStdout } from 'ink';
import { useStore, visibleKeys } from './store.ts';
import { SessionCell } from './SessionCell.tsx';

const CELL_WIDTH = 38; // chars; tuned to hold "C dir/sub        TOOL  current_tool"
const HEADER_LINES = 4; // top header + filter + spacer

export function Grid(): React.ReactElement {
  const sessions = useStore((s) => s.sessions);
  const order = useStore((s) => s.order);
  const focusedKey = useStore((s) => s.focusedKey);
  const filter = useStore((s) => s.filter);
  const filterMode = useStore((s) => s.filterMode);
  const showAll = useStore((s) => s.showAll);
  const tick = useStore((s) => s.tick);

  const { stdout } = useStdout();
  const termCols = stdout?.columns ?? 80;
  const termRows = stdout?.rows ?? 24;

  const cols = Math.max(1, Math.floor(termCols / CELL_WIDTH));

  // Recompute on every tick so display-state transitions (idle/stale) move
  // sessions in/out of view as their last_event_at_ms ages, even if the
  // underlying SessionRow ref is unchanged.
  const visible = useMemo(
    () => visibleKeys(order, sessions, filter, { showAll, nowMs: Date.now() }),
    [order, sessions, filter, showAll, tick],
  );

  // Hint for the user: how many we're hiding.
  const total = order.length;
  const visibleCount = visible.length;

  // Cap visible rows to roughly the terminal height to avoid Ink ballooning
  // past the screen. Ink renders inline, so over-tall outputs scroll the
  // user's history. Header takes ~4 lines, footer ~1.
  const maxRows = Math.max(1, termRows - HEADER_LINES - 1);
  const cappedKeys = visible.slice(0, maxRows * cols);

  if (visible.length === 0) {
    let msg: string;
    if (total === 0) {
      msg = '(no sessions yet — start a Claude or Codex session)';
    } else if (filter) {
      msg = `(no sessions match filter "${filter}")`;
    } else if (!showAll) {
      msg = '(no active sessions — press "a" to also show stale/closed)';
    } else {
      msg = '(no sessions to display)';
    }
    return (
      <Box flexDirection="column">
        <Text color="gray">{msg}</Text>
      </Box>
    );
  }

  // Group capped list into rows.
  const rows: string[][] = [];
  for (let i = 0; i < cappedKeys.length; i += cols) {
    rows.push(cappedKeys.slice(i, i + cols));
  }

  return (
    <Box flexDirection="column">
      {rows.map((row, ri) => (
        <Box key={ri} flexDirection="row">
          {row.map((k) => {
            const c = sessions.get(k);
            if (!c) return null;
            return (
              <SessionCell
                key={k}
                cell={c}
                width={CELL_WIDTH}
                focused={k === focusedKey}
              />
            );
          })}
        </Box>
      ))}
      {visibleCount > cappedKeys.length ? (
        <Text dimColor>
          … {visibleCount - cappedKeys.length} more (resize terminal to see)
        </Text>
      ) : null}
      {filterMode ? null : visibleCount < total ? (
        <Text dimColor>
          showing {visibleCount}/{total} (filter: {filter})
        </Text>
      ) : null}
    </Box>
  );
}
