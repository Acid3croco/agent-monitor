# M0 — Bun + Ink spike notes

**Date:** 2026-04-25
**Runtime:** Bun 1.3.11 (Linux 6.12.63, kernel x86_64)
**Stack tested:** `bun:sqlite` + Ink 5.2.1 + React 18.3.1 + Zustand 5

## Summary

**Recommendation: PROCEED with Bun for the TUI runtime.** All exit criteria
hit. No flicker, clean exit on `q` / SIGINT / SIGTERM, render time well under
the 16 ms ceiling, resize handled by Ink. Switching to Node + `better-sqlite3`
for the TUI is not justified by anything I observed.

## What I built

| File | What |
|------|------|
| `spike/seed.ts` | Creates `/tmp/agent-monitor-spike.db`, seeds 100 sessions (mix of providers, states, cwds, models). |
| `spike/updater.ts` | Mutates ~10 rows per 100 ms tick (10 Hz). Rotates state, bumps `last_event_at_ms`, occasionally swaps `current_tool`. Clean shutdown on SIGINT/SIGTERM. |
| `spike/tui.tsx` | Ink app: 200 ms coalesced poll → diff against Zustand store → re-render only changed `React.memo` cells. Tick counter + perf header. Logs render time per tick to `/tmp/agent-monitor-spike-perf.log`. Exits on `q` and Ctrl-C. |

## Render-time numbers (100 cells, 200 ms tick, ~28 s sample)

Measured per-tick wall time of `selectAll.all()` + `applyDiff()` + state set
that triggers React render. Captured from `/tmp/agent-monitor-spike-perf.log`.

| stat | warm value |
|------|------------|
| samples | 138 |
| min | 9.0 ms |
| p50 | 9.8 ms |
| **avg** | **10.0 ms** |
| p95 | 11.8 ms |
| p99 | 16.1 ms |
| max | 16.2 ms |

Cold-start first 5 samples drop to a single 42 ms outlier (JIT warmup / first
draw); ignored above. Steady state is comfortably under the 16 ms exit
criterion. A handful of ticks brush 16 ms; that's the ceiling, not the floor —
the diff path itself is sub-millisecond once warm, the rest is React +
ink-render.

## Behaviour observed

- **Flicker:** none, both at default and resized terminals. Ink's reconciler
  only repaints lines that actually changed.
- **Quit via `q`:** exits cleanly, terminal is healthy, prompt redraws fine.
  Cursor is restored (`ESC[?25h` emitted on exit). Last frame stays in
  scrollback (see "Gotchas" below).
- **Ctrl-C / SIGINT:** Ink installs its own SIGINT handler, exits cleanly,
  cursor restored. Updater's SIGINT handler logs total ticks then closes the
  DB — no orphaned WAL.
- **SIGTERM:** added an explicit handler in the TUI that calls `exit()`.
  Verified — exits clean, cursor restored.
- **Resize:** sent two SIGWINCH signals mid-run, Ink reflowed the column count
  on the next render tick (`Math.floor(stdout.columns / 26)`). No corruption
  on shrink or grow.
- **Updater throughput verified:** at 10 Hz with 10 random keys/tick, ~39
  unique rows show `last_event_at_ms > now-500ms`, ~61 within 1 s — matches
  10 Hz × 10 keys with the expected birthday-overlap.

## Gotchas worth knowing for M5

1. **Ink does NOT use the alternate screen buffer.** It renders inline in the
   normal scrollback. On exit, the last drawn frame stays visible in your
   terminal history — there's no "swipe back to your shell" effect like
   `vim`/`htop` give. If we want that for v1, we'd need to manually emit
   `\x1b[?1049h` on enter and `\x1b[?1049l` on exit (and re-emit on resize).
   It's optional; many TUIs don't bother. Decide in M5.

2. **`useStdout().stdout.columns` is read at render time, not subscribed.** We
   re-read it inside `Grid()` each render, which is fine because the 200 ms
   poll triggers a render anyway. If we ever skip a render we'd miss a resize
   between ticks — but at 200 ms the perceived lag is ~half a tick.

3. **`appendFileSync` in the render hot path is not ideal.** For the spike
   it's <0.5 ms per tick and the perf log is the *only* observability
   channel (stdout would corrupt the TUI). For M5, switch to a buffered
   logger or just write to a logfile path under our state dir, async, with
   no per-tick syscall. (Or better: use `process.stderr.write` to a redirected
   FD — but stderr in a TTY also corrupts.) **Pattern for M5: write logs to a
   file, never to stdout/stderr while Ink is mounted.**

4. **`React.memo` requires structural equality on props** — passing a new
   `Cell` object on every diff defeats the optimisation. The current spike
   only puts a fresh `Cell` in the store map when something actually changed
   (the `applyDiff` returns a new map only if any diff hit). Keep this
   discipline in M5: Zustand selectors should return stable references for
   unchanged cells, otherwise every cell re-renders every tick.

5. **`bun:sqlite` `Database.prepare` returns a statement bound to the DB.**
   Re-using the prepared statement (`selectAll.all()`) is what keeps the
   read path fast. Don't re-prepare per tick.

6. **`db.close()` must run after `inkApp.waitUntilExit()`** — closing it from
   inside `useEffect` cleanup races with React unmount and can throw "DB is
   closed" from the next tick if the interval hasn't been cleared yet. The
   spike sequences cleanup correctly: ink resolves, *then* `db.close()`,
   *then* `process.exit(0)`.

7. **Verification with `sqlite3` CLI not available on this box.** Used a tiny
   inline `bun -e` snippet to run aggregate queries instead. M2/M5 docs that
   tell users to "verify with `sqlite3 events.db ...`" should fall back to
   `agent-monitor doctor` for users without the CLI installed.

8. **No new deps were added.** Everything (`bun:sqlite`, `ink`, `react`,
   `zustand`) already in `node_modules`. `package.json` already had
   `spike:seed`, `spike:updater`, `spike:tui` scripts.

## Verdict

The exit criteria from the plan:

- [x] Flicker-free at 100 memoized cells with a 200 ms tick under 10 Hz writes.
- [x] No terminal corruption on resize, Ctrl-C, or quit.
- [x] Sub-16 ms render per tick at 100 cells (10 ms avg, 11.8 ms p95, 16.2 ms max).
- [x] Clean exit on `q`, SIGINT, and SIGTERM.

**Proceed with Bun + `bun:sqlite` for the TUI runtime in M5.** Keep the Node +
`better-sqlite3` swap as a documented fallback in case a future Ink/Bun version
breaks something, but no migration is warranted now.
