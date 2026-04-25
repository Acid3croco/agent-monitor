// Adaptive grid (v1.1).
//
// Two layout knobs:
//
//   1. Density (`card` | `compact` | `row`) picks the cell renderer:
//        card    -> SessionCard       (5 lines: bordered card with prompt)
//        compact -> SessionCompact    (3 lines: bordered, single content line)
//        row     -> SessionCell       (1 line, no border — legacy renderer)
//
//   2. Grouping by cwd is on for `card` and `compact`. Sessions sharing a cwd
//      are clustered under a dimmed cwd header; cards inside a group flow
//      left-to-right with wrap. `row` mode keeps the legacy flat 2-D grid so
//      keyboard navigation still works as expected for users who prefer the
//      dense view.
//
// Cell width adapts to the terminal: target 60, min 50, max 80, with cols-per-
// row computed as floor(termCols / cardWidth). Total visible cells are still
// capped against terminal height to avoid Ink scrolling the user's history.

import React, { useMemo } from 'react';
import { Box, Text, useStdout } from 'ink';
import { useStore, visibleKeys } from './store.ts';
import { SessionCell } from './SessionCell.tsx';
import { SessionCard } from './SessionCard.tsx';
import { SessionCompact } from './SessionCompact.tsx';
import type { SessionRow } from '../types.ts';

const HEADER_LINES = 3; // status bar (2) + ambient footer (1)

// Width tuning per density.
const CARD_TARGET = 60;
const CARD_MIN = 50;
const CARD_MAX = 80;
const COMPACT_TARGET = 56;
const COMPACT_MIN = 44;
const COMPACT_MAX = 72;
const ROW_WIDTH = 38; // matches legacy SessionCell tuning

// Lines per cell (including blank separator) for the height cap.
const LINES_PER_CARD = 4;     // 5 box lines, but cards stack flush; budget 4 to be safe
const LINES_PER_COMPACT = 3;
const LINES_PER_ROW = 1;

function pickWidth(density: 'card' | 'compact', termCols: number): number {
  if (density === 'card') {
    if (termCols >= CARD_TARGET * 2 + 2) return CARD_TARGET;
    if (termCols < CARD_MIN + 2) return Math.max(20, termCols - 2);
    return Math.min(CARD_MAX, Math.max(CARD_MIN, termCols - 2));
  }
  // compact
  if (termCols >= COMPACT_TARGET * 2 + 2) return COMPACT_TARGET;
  if (termCols < COMPACT_MIN + 2) return Math.max(20, termCols - 2);
  return Math.min(COMPACT_MAX, Math.max(COMPACT_MIN, termCols - 2));
}

// Group an ordered key list by the row's cwd, preserving the input order both
// Within each group, order is preserved from the input (i.e. recency from
// visibleKeys). Across groups, real cwds sort alphabetically and the (no cwd)
// bucket is pinned at the end so unknown-cwd sessions never push real groups
// off-screen.
const NO_CWD_LABEL = '(no cwd)';
function groupByCwd(
  keys: string[],
  sessions: Map<string, SessionRow>,
): Array<{ cwd: string; keys: string[] }> {
  const buckets = new Map<string, string[]>();
  for (const k of keys) {
    const r = sessions.get(k);
    if (!r) continue;
    const cwd = r.cwd ?? NO_CWD_LABEL;
    let b = buckets.get(cwd);
    if (!b) {
      b = [];
      buckets.set(cwd, b);
    }
    b.push(k);
  }
  const cwds = Array.from(buckets.keys()).sort((a, b) => {
    if (a === NO_CWD_LABEL) return 1;
    if (b === NO_CWD_LABEL) return -1;
    return a.localeCompare(b);
  });
  return cwds.map((cwd) => ({ cwd, keys: buckets.get(cwd)! }));
}

export function Grid(): React.ReactElement {
  const sessions = useStore((s) => s.sessions);
  const order = useStore((s) => s.order);
  const focusedKey = useStore((s) => s.focusedKey);
  const filter = useStore((s) => s.filter);
  const filterMode = useStore((s) => s.filterMode);
  const showAll = useStore((s) => s.showAll);
  const showMcp = useStore((s) => s.showMcp);
  const density = useStore((s) => s.density);
  const tick = useStore((s) => s.tick);
  const sessionStats = useStore((s) => s.sessionStats);
  const scrollOffset = useStore((s) => s.scrollOffset);

  const { stdout } = useStdout();
  const termCols = stdout?.columns ?? 80;
  const termRows = stdout?.rows ?? 24;

  // Recompute on every tick so display-state transitions (idle/stale) move
  // sessions in/out of view as their last_event_at_ms ages.
  const visible = useMemo(
    () => visibleKeys(order, sessions, filter, { showAll, showMcp, nowMs: Date.now() }),
    [order, sessions, filter, showAll, showMcp, tick],
  );

  const total = order.length;
  const visibleCount = visible.length;

  const nowMs = Date.now();

  // Empty-state copy. Same logic as before; preserved across density modes.
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

  // --- ROW DENSITY (legacy) ---------------------------------------------
  if (density === 'row') {
    const cols = Math.max(1, Math.floor(termCols / ROW_WIDTH));
    const maxRows = Math.max(1, termRows - HEADER_LINES - 1);
    const cappedKeys = visible.slice(0, maxRows * cols);
    const rows: string[][] = [];
    for (let i = 0; i < cappedKeys.length; i += cols) {
      rows.push(cappedKeys.slice(i, i + cols));
    }
    return (
      <Box flexDirection="column">
        {rows.map((rowKeys, ri) => (
          <Box key={ri} flexDirection="row">
            {rowKeys.map((k) => {
              const c = sessions.get(k);
              if (!c) return null;
              return (
                <SessionCell
                  key={k}
                  cell={c}
                  width={ROW_WIDTH}
                  focused={k === focusedKey}
                />
              );
            })}
          </Box>
        ))}
        <FooterLines
          visibleCount={visibleCount}
          shownCount={cappedKeys.length}
          total={total}
          filter={filter}
          filterMode={filterMode}
        />
      </Box>
    );
  }

  // --- CARD / COMPACT (grouped by cwd, with vertical scroll) -----------
  const cellWidth = pickWidth(density, termCols);
  const linesPerCell = density === 'card' ? LINES_PER_CARD : LINES_PER_COMPACT;
  // Each group adds 2 overhead lines: header + blank separator.
  const groupOverhead = 2;

  const cols = Math.max(1, Math.floor((termCols + 1) / (cellWidth + 1)));

  // Slice the flat visibleKeys list by scrollOffset, then re-group the
  // remaining cells by cwd for layout. This way scrolling moves through
  // cells uniformly regardless of group boundaries.
  const safeScroll = Math.min(scrollOffset, Math.max(0, visible.length - 1));
  const scrolled = visible.slice(safeScroll);
  const groups = groupByCwd(scrolled, sessions);

  // Cap visible cells against terminal height. Reserve 1 line for the scroll
  // hint footer so we always have room to show "X above / Y below".
  const heightBudget = Math.max(linesPerCell, termRows - HEADER_LINES - 3);
  let linesUsed = 0;
  let cellsShown = 0;
  const visibleGroups: Array<{ cwd: string; keys: string[] }> = [];
  for (const g of groups) {
    if (linesUsed + groupOverhead + linesPerCell > heightBudget) break;
    const remainingLines = heightBudget - linesUsed - groupOverhead;
    const maxCellsHere = Math.max(0, Math.floor(remainingLines / linesPerCell)) * cols;
    if (maxCellsHere === 0) break;
    const take = Math.min(g.keys.length, maxCellsHere);
    const rowsHere = Math.ceil(take / cols);
    visibleGroups.push({ cwd: g.cwd, keys: g.keys.slice(0, take) });
    linesUsed += groupOverhead + rowsHere * linesPerCell;
    cellsShown += take;
    if (take < g.keys.length) break; // group truncated -> stop adding more groups
  }

  const cellsAbove = safeScroll;
  const cellsBelow = Math.max(0, visible.length - safeScroll - cellsShown);

  const Renderer = density === 'card' ? SessionCard : SessionCompact;

  return (
    <Box flexDirection="column">
      {visibleGroups.map((g, gi) => {
        const rows: string[][] = [];
        for (let i = 0; i < g.keys.length; i += cols) {
          rows.push(g.keys.slice(i, i + cols));
        }
        return (
          <Box key={`${g.cwd}-${gi}`} flexDirection="column" marginBottom={1}>
            <Text dimColor>{g.cwd}</Text>
            {rows.map((rowKeys, ri) => (
              <Box key={ri} flexDirection="row">
                {rowKeys.map((k) => {
                  const c = sessions.get(k);
                  if (!c) return null;
                  const stats = sessionStats.get(k);
                  return (
                    <Renderer
                      key={k}
                      cell={c}
                      width={cellWidth}
                      focused={k === focusedKey}
                      nowMs={nowMs}
                      turns={stats?.turns ?? 0}
                      subagentsActive={stats?.subagentsActive ?? 0}
                      subagentsTotal={stats?.subagentsTotal ?? 0}
                    />
                  );
                })}
              </Box>
            ))}
          </Box>
        );
      })}
      <FooterLines
        visibleCount={visibleCount}
        shownCount={cellsShown}
        total={total}
        filter={filter}
        filterMode={filterMode}
        cellsAbove={cellsAbove}
        cellsBelow={cellsBelow}
      />
    </Box>
  );
}

function FooterLines({
  visibleCount,
  shownCount,
  total,
  filter,
  filterMode,
  cellsAbove = 0,
  cellsBelow = 0,
}: {
  visibleCount: number;
  shownCount: number;
  total: number;
  filter: string;
  filterMode: boolean;
  cellsAbove?: number;
  cellsBelow?: number;
}): React.ReactElement | null {
  const hasScroll = cellsAbove > 0 || cellsBelow > 0;
  const hasFilter = !filterMode && visibleCount < total;
  if (!hasScroll && !hasFilter) return null;
  return (
    <Box flexDirection="column">
      {hasScroll ? (
        <Text dimColor>
          {cellsAbove > 0 ? `↑ ${cellsAbove} above   ` : ''}
          showing {shownCount}/{visibleCount}
          {cellsBelow > 0 ? `   ↓ ${cellsBelow} below (ctrl-d / ctrl-u)` : ''}
        </Text>
      ) : null}
      {hasFilter ? (
        <Text dimColor>
          showing {visibleCount}/{total} (filter: {filter})
        </Text>
      ) : null}
    </Box>
  );
}
