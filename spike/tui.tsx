// M0 spike — Ink TUI rendering 100 memoized cells from /tmp/agent-monitor-spike.db.
//
// - Polls SQLite every 200 ms (coalesced tick).
// - Diffs against a Zustand store; only changed cells re-render (React.memo).
// - Provider icon (C/X), short cwd, state, current tool.
// - Exit on `q` or Ctrl-C; clean terminal restore.
// - Render time per tick logged (rolling avg) to /tmp/agent-monitor-spike-perf.log.
//
// Run: bun run spike:tui

import React, { useEffect, useState } from 'react';
import { Box, Text, render, useApp, useInput, useStdout } from 'ink';
import { Database } from 'bun:sqlite';
import { create } from 'zustand';
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DB_PATH = '/tmp/agent-monitor-spike.db';
const PERF_LOG = '/tmp/agent-monitor-spike-perf.log';
const TICK_MS = 200;

// ---------- types ----------
type Cell = {
  key: string;
  provider: 'claude' | 'codex';
  cwd: string | null;
  state: string;
  current_tool: string | null;
  last_event_at_ms: number;
};

// ---------- store ----------
type StoreState = {
  cells: Map<string, Cell>;
  order: string[]; // stable display order
  tick: number;
  applyDiff: (rows: Cell[]) => number; // returns # of changed cells
};

const useStore = create<StoreState>((set, get) => ({
  cells: new Map(),
  order: [],
  tick: 0,
  applyDiff: (rows) => {
    const prev = get().cells;
    let next: Map<string, Cell> | null = null;
    let changed = 0;
    for (const row of rows) {
      const old = prev.get(row.key);
      if (
        !old ||
        old.state !== row.state ||
        old.current_tool !== row.current_tool ||
        old.last_event_at_ms !== row.last_event_at_ms ||
        old.cwd !== row.cwd ||
        old.provider !== row.provider
      ) {
        if (!next) next = new Map(prev);
        next.set(row.key, row);
        changed++;
      }
    }
    if (next) {
      // Keep stable order from first sighting
      const order = get().order.slice();
      const seen = new Set(order);
      for (const row of rows) {
        if (!seen.has(row.key)) {
          order.push(row.key);
          seen.add(row.key);
        }
      }
      set({ cells: next, order, tick: get().tick + 1 });
    } else {
      set({ tick: get().tick + 1 });
    }
    return changed;
  },
}));

// ---------- perf log ----------
writeFileSync(PERF_LOG, `# spike perf log started ${new Date().toISOString()}\n`);

let perfSamples: number[] = [];
const PERF_WINDOW = 50;
function recordPerf(ms: number) {
  perfSamples.push(ms);
  if (perfSamples.length > PERF_WINDOW) perfSamples.shift();
  const avg = perfSamples.reduce((a, b) => a + b, 0) / perfSamples.length;
  const max = Math.max(...perfSamples);
  appendFileSync(
    PERF_LOG,
    `t=${Date.now()} last=${ms.toFixed(2)}ms avg(${perfSamples.length})=${avg.toFixed(2)}ms max=${max.toFixed(2)}ms\n`,
  );
}

// ---------- DB ----------
const db = new Database(DB_PATH, { readonly: true });
const selectAll = db.query<Cell, []>(
  `SELECT key, provider, cwd, state, current_tool, last_event_at_ms FROM sessions`,
);

// ---------- view ----------
const PROVIDER_ICON: Record<string, string> = { claude: 'C', codex: 'X' };
const STATE_COLOR: Record<string, string> = {
  thinking: 'cyan',
  tool: 'yellow',
  permission: 'magenta',
  waiting: 'gray',
  idle: 'gray',
  done: 'green',
};

function shortCwd(cwd: string | null): string {
  if (!cwd) return '?';
  return path.basename(cwd) || cwd;
}

const SessionCell = React.memo(function SessionCell({
  cell,
  width,
}: {
  cell: Cell;
  width: number;
}) {
  const icon = PROVIDER_ICON[cell.provider] ?? '?';
  const color = STATE_COLOR[cell.state] ?? 'white';
  const cwd = shortCwd(cell.cwd).slice(0, 10);
  const state = cell.state.slice(0, 4);
  const tool = (cell.current_tool ?? '-').slice(0, 6);
  // Pad to fixed width so the grid lines up. width is in chars.
  const text = `${icon} ${cwd.padEnd(10)} ${state.padEnd(4)} ${tool.padEnd(6)}`;
  return (
    <Box width={width}>
      <Text color={color}>{text}</Text>
    </Box>
  );
});

function Grid() {
  const cells = useStore((s) => s.cells);
  const order = useStore((s) => s.order);
  const { stdout } = useStdout();
  const cols = Math.max(1, Math.floor((stdout?.columns ?? 80) / 26));
  const cellWidth = 26;

  // Group into rows
  const rows: string[][] = [];
  for (let i = 0; i < order.length; i += cols) {
    rows.push(order.slice(i, i + cols));
  }

  return (
    <Box flexDirection="column">
      {rows.map((row, ri) => (
        <Box key={ri} flexDirection="row">
          {row.map((k) => {
            const c = cells.get(k);
            if (!c) return null;
            return <SessionCell key={k} cell={c} width={cellWidth} />;
          })}
        </Box>
      ))}
    </Box>
  );
}

function App() {
  const { exit } = useApp();
  const tick = useStore((s) => s.tick);
  const cellCount = useStore((s) => s.cells.size);
  const [lastChanged, setLastChanged] = useState(0);
  const [lastMs, setLastMs] = useState(0);

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
    }
  });

  useEffect(() => {
    const apply = useStore.getState().applyDiff;
    const interval = setInterval(() => {
      const t0 = performance.now();
      const rows = selectAll.all() as Cell[];
      const changed = apply(rows);
      const dt = performance.now() - t0;
      recordPerf(dt);
      setLastChanged(changed);
      setLastMs(dt);
    }, TICK_MS);
    return () => clearInterval(interval);
  }, []);

  // SIGTERM: ink installs SIGINT itself. Add SIGTERM for completeness.
  useEffect(() => {
    const handler = () => exit();
    process.on('SIGTERM', handler);
    return () => {
      process.off('SIGTERM', handler);
    };
  }, [exit]);

  const avg =
    perfSamples.length > 0
      ? perfSamples.reduce((a, b) => a + b, 0) / perfSamples.length
      : 0;

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>agent-monitor M0 spike </Text>
        <Text color="gray">
          tick={tick} cells={cellCount} changed={lastChanged} last=
          {lastMs.toFixed(1)}ms avg={avg.toFixed(1)}ms — q to quit
        </Text>
      </Box>
      <Box marginTop={1}>
        <Grid />
      </Box>
    </Box>
  );
}

const inkApp = render(<App />);
inkApp.waitUntilExit().then(() => {
  try {
    db.close();
  } catch {}
  process.exit(0);
});
