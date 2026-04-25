// Top-level Ink app for `agent-monitor tui`.
//
// Owns:
//   - The 200 ms DB poll → applyDiff → Zustand re-render path.
//   - Keyboard input: dispatches the pure key handlers from ./keys.ts to actions
//     against the store (and `useApp().exit()` for quit).
//   - The two view modes (grid, detail). When mode flips to 'detail', a side
//     effect refreshes recentEvents for the focused session.
//   - Mounting/unmounting the alt-screen (manual ESC sequences). Ink does not
//     do this itself; see M0_SPIKE_NOTES.md gotcha #1.
//
// Cleanup sequence — strict ordering matters (M0 gotcha #6):
//   ink.waitUntilExit()  →  db.close()  →  alt-screen exit  →  process.exit(0)
//
// All TUI-internal logging goes through ./log.ts; never use console.log here.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';

import {
  getActiveSessions,
  getRecentEventsForSession,
} from '../store/queries.ts';
import { runReconcileOnce } from '../reconciler/index.ts';
import { startAmbientIndexer, type AmbientStatus } from '../indexer/ambient.ts';
import { deriveDisplayState } from '../liveness.ts';
import type { Database } from 'bun:sqlite';

import { useStore, visibleKeys } from './store.ts';
import { Grid } from './Grid.tsx';
import { Detail } from './Detail.tsx';
import {
  computeFocusAfterMove,
  handleDetailKey,
  handleGridKey,
} from './keys.ts';
import { log, logError } from './log.ts';

const TICK_MS = 200;
const CELL_WIDTH = 38;

// Module-scoped pending-stop promise: the App's unmount cleanup is sync, but
// we must wait for in-flight drain/reconcile passes to finish before runTui's
// caller closes the DB handle. The cleanup effect publishes its stop()
// promise here; runTui awaits it after waitUntilExit resolves.
let _ambientStopPromise: Promise<void> | null = null;

// ---------- alt-screen ----------
// Ink renders inline. We want vim-style: TUI takes the screen, leaves it on
// exit. Manual ESC sequences: 1049h enters, 1049l leaves.
function enterAltScreen(): void {
  process.stdout.write('\x1b[?1049h\x1b[H');
}
function leaveAltScreen(): void {
  process.stdout.write('\x1b[?1049l');
}

// ---------- header ----------

// Format a "Xs ago" / "Xm ago" stamp from a wall-clock ms snapshot. Returns
// "never" when ts is null. We hand this 'now' rather than calling Date.now()
// inline so the footer doesn't keep re-rendering between ticks for no reason
// (the parent re-render cadence is the truth source).
function ageString(ts: number | null, nowMs: number): string {
  if (ts == null) return 'never';
  const dSec = Math.max(0, Math.round((nowMs - ts) / 1000));
  if (dSec < 60) return `${dSec}s ago`;
  const dMin = Math.round(dSec / 60);
  if (dMin < 60) return `${dMin}m ago`;
  const dHr = Math.round(dMin / 60);
  return `${dHr}h ago`;
}

// One-line ambient status footer. Single source of truth for "is the indexer
// alive and keeping up?" -- the user shouldn't need to tail tui.log.
function AmbientFooter({
  status,
  nowMs,
}: {
  status: AmbientStatus | null;
  nowMs: number;
}) {
  if (!status) {
    return <Text dimColor>idx: starting…</Text>;
  }
  const drainAge = ageString(status.lastDrainAt, nowMs);
  const backlog = status.lastDrainStats?.linesIngested ?? 0;
  const last = status.lastError
    ? `${status.lastError.source} err: ${status.lastError.message}`
    : 'OK';
  return (
    <Text dimColor>
      idx: lastDrain={drainAge} · backlog={backlog} · last={last}
    </Text>
  );
}

function Header({
  stats,
  ambient,
  nowMs,
}: {
  stats: { tick: number; changed: number };
  ambient: AmbientStatus | null;
  nowMs: number;
}) {
  const mode = useStore((s) => s.mode);
  const filter = useStore((s) => s.filter);
  const filterMode = useStore((s) => s.filterMode);
  const showAll = useStore((s) => s.showAll);
  const total = useStore((s) => s.sessions.size);
  const setFilter = useStore((s) => s.setFilter);
  const setFilterMode = useStore((s) => s.setFilterMode);

  // Number of sessions hidden because they're stale/done and showAll is off.
  const hiddenCount = useStore((s) => {
    if (s.showAll) return 0;
    let h = 0;
    for (const r of s.sessions.values()) {
      const d = deriveDisplayState(r, nowMs);
      if (d === 'stale' || d === 'done') h++;
    }
    return h;
  });

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>agent-monitor </Text>
        <Text dimColor>
          {mode === 'grid' ? 'grid' : 'detail'} · sessions={total}
          {hiddenCount > 0 ? ` (${hiddenCount} hidden, press a)` : ''} · tick=
          {stats.tick} · changed={stats.changed}
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
        ) : mode === 'grid' ? (
          <Text dimColor>
            j/k/h/l move · enter detail · / filter · a {showAll ? 'hide' : 'show'} stale · r reconcile · q quit
            {filter ? `   filter: "${filter}" (esc clears)` : ''}
          </Text>
        ) : (
          <Text dimColor>esc back · j/k scroll events · q quit</Text>
        )}
      </Box>
      <AmbientFooter status={ambient} nowMs={nowMs} />
    </Box>
  );
}

// ---------- app ----------
function App(): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const tick = useStore((s) => s.tick);
  const mode = useStore((s) => s.mode);
  const filterMode = useStore((s) => s.filterMode);
  const focusedKey = useStore((s) => s.focusedKey);
  const order = useStore((s) => s.order);
  const sessions = useStore((s) => s.sessions);
  const filter = useStore((s) => s.filter);
  const showAll = useStore((s) => s.showAll);

  const [lastChanged, setLastChanged] = useState(0);
  const [ambient, setAmbient] = useState<AmbientStatus | null>(null);

  // Reconcile-in-flight guard so spamming 'r' only ever has one running.
  const reconcileRunning = useRef(false);

  // Hold the ambient indexer's stop() across the App lifetime; we tear it
  // down in the unmount effect so the DB can close cleanly.
  const ambientHandle = useRef<{ stop(): Promise<void> } | null>(null);

  // Compute current cols here so navigation respects the live terminal width.
  const termCols = stdout?.columns ?? 80;
  const cols = Math.max(1, Math.floor(termCols / CELL_WIDTH));

  // 200 ms poll → applyDiff. Pulling state.applyDiff via getState avoids
  // re-binding the interval when the action ref changes (it doesn't, but
  // belt-and-braces).
  useEffect(() => {
    let stopped = false;
    const poll = () => {
      if (stopped) return;
      try {
        const raw = getActiveSessions();
        // M6: overlay state-age liveness so the grid reflects idle/stale even
        // when no new events have landed. The DB `state` is the insert-time
        // lifecycle value; the displayed state is a function of (row, now).
        const now = Date.now();
        const rows = raw.map((r) => {
          const display = deriveDisplayState(r, now);
          return display === r.state ? r : { ...r, state: display };
        });
        const changed = useStore.getState().applyDiff(rows);
        if (changed > 0) setLastChanged(changed);

        // Auto-focus first cell on first non-empty tick so the user has
        // something to navigate from immediately.
        const st = useStore.getState();
        const visOpts = { showAll: st.showAll, nowMs: now };
        if (st.focusedKey == null && rows.length > 0) {
          const vis = visibleKeys(st.order, st.sessions, st.filter, visOpts);
          if (vis.length > 0) st.setFocusedKey(vis[0] ?? null);
        } else if (
          st.focusedKey != null &&
          (!st.sessions.has(st.focusedKey) ||
            !visibleKeys(st.order, st.sessions, st.filter, visOpts).includes(
              st.focusedKey,
            ))
        ) {
          // Focused session aged out OR was hidden by visibility filter.
          const vis = visibleKeys(st.order, st.sessions, st.filter, visOpts);
          st.setFocusedKey(vis[0] ?? null);
        }
      } catch (err) {
        logError('poll', err);
      }
    };
    poll(); // immediate first paint
    const id = setInterval(poll, TICK_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  // When entering detail mode, fetch the events for the focused session.
  // Refresh on each tick while in detail mode so events stream in live.
  useEffect(() => {
    if (mode !== 'detail' || !focusedKey) return;
    try {
      const events = getRecentEventsForSession(focusedKey, 100);
      useStore.getState().setRecentEvents(focusedKey, events);
    } catch (err) {
      logError('recent events', err);
    }
  }, [mode, focusedKey, tick]);

  // SIGTERM: ink installs SIGINT itself. Cover SIGTERM for completeness so
  // `kill <pid>` exits cleanly through the same path.
  useEffect(() => {
    const onTerm = () => exit();
    process.on('SIGTERM', onTerm);
    return () => {
      process.off('SIGTERM', onTerm);
    };
  }, [exit]);

  // M6: ambient ingest. Drain spool every ~1s, reconcile rollouts every ~8s,
  // both in this process. Without this, the grid is a one-shot snapshot.
  // The status callback bumps a hook so the footer can render lastDrain age,
  // backlog, and the most recent error.
  useEffect(() => {
    const handle = startAmbientIndexer({
      onStatus: (s) => setAmbient(s),
    });
    ambientHandle.current = handle;
    log('ambient indexer started');
    return () => {
      // Effect cleanup is sync: publish the stop promise to module scope so
      // runTui can await it after waitUntilExit resolves, before the DB closes.
      _ambientStopPromise = handle.stop();
      ambientHandle.current = null;
    };
  }, []);

  // Keyboard. Filter-edit mode is special: ink-text-input owns the keystrokes,
  // so we suppress useInput while it's open (esc/enter both close the input).
  useInput(
    (input, key) => {
      const st = useStore.getState();

      if (filterMode) {
        // Allow esc to close the input even in this mode.
        if (key.escape) {
          st.setFilterMode(false);
          st.setFilter('');
        }
        return;
      }

      const action =
        st.mode === 'grid' ? handleGridKey(input, key) : handleDetailKey(input, key);

      switch (action.type) {
        case 'none':
          return;
        case 'quit':
          log('quit requested');
          exit();
          return;
        case 'open-detail':
          if (st.focusedKey) {
            // Pre-populate so the first detail render isn't empty.
            try {
              const evs = getRecentEventsForSession(st.focusedKey, 100);
              st.setRecentEvents(st.focusedKey, evs);
            } catch (err) {
              logError('open-detail prefetch', err);
            }
            st.setMode('detail');
          }
          return;
        case 'back-to-grid':
          st.setMode('grid');
          return;
        case 'enter-filter':
          st.setFilterMode(true);
          return;
        case 'clear-filter':
          st.setFilter('');
          st.setFilterMode(false);
          return;
        case 'reconcile':
          if (reconcileRunning.current) return;
          reconcileRunning.current = true;
          log('reconcile triggered by user');
          runReconcileOnce()
            .then((stats) => {
              log(
                `reconcile done: files=${stats.filesScanned} ingested=${stats.linesIngested} skipped=${stats.linesSkipped}`,
              );
            })
            .catch((err) => logError('reconcile', err))
            .finally(() => {
              reconcileRunning.current = false;
            });
          return;
        case 'toggle-show-all':
          st.setShowAll(!st.showAll);
          return;
        case 'move-focus': {
          const vis = visibleKeys(st.order, st.sessions, st.filter, {
            showAll: st.showAll,
            nowMs: Date.now(),
          });
          const next = computeFocusAfterMove(
            vis,
            cols,
            st.focusedKey,
            action.dx,
            action.dy,
          );
          st.setFocusedKey(next);
          return;
        }
        case 'scroll-events': {
          st.setEventScroll(st.eventScroll + action.delta);
          return;
        }
      }
    },
    // useInput stays active during filterMode so Esc can actually exit it.
    // ink-text-input owns most keystrokes during filter editing; we only
    // intercept Esc here. '/'-as-toggle is handled in the TextInput onChange.
  );

  const stats = useMemo(() => ({ tick, changed: lastChanged }), [tick, lastChanged]);

  // Reference 'order', 'sessions', 'filter' here so the Header re-renders when
  // the user pages the filter — otherwise the unused-vars TS option would
  // flag them. They're already consumed by Grid via store hooks.
  void order;
  void sessions;
  void filter;

  // tick is the 200ms heartbeat; reading Date.now() once per render keeps the
  // age string in the footer monotonically advancing without a separate timer.
  const nowMs = Date.now();

  return (
    <Box flexDirection="column">
      <Header stats={stats} ambient={ambient} nowMs={nowMs} />
      <Box marginTop={1}>{mode === 'grid' ? <Grid /> : <Detail />}</Box>
    </Box>
  );
}

// ---------- public mount ----------

// Public so cli.ts can call it after opening the DB. Returns a promise that
// resolves after the alt-screen has been torn down — caller closes the DB
// and then exits the process.
export async function runTui(_db: Database): Promise<void> {
  enterAltScreen();
  log('tui mounted');
  const inkApp = render(<App />, {
    // We render into the alt screen ourselves; let ink draw inline inside it.
    exitOnCtrlC: true,
  });
  try {
    await inkApp.waitUntilExit();
  } finally {
    // Wait for any in-flight drain/reconcile so the DB doesn't close mid-write.
    if (_ambientStopPromise) {
      try {
        await _ambientStopPromise;
      } catch (err) {
        logError('ambient stop', err);
      }
      _ambientStopPromise = null;
    }
    leaveAltScreen();
    log('tui unmounted');
  }
}
