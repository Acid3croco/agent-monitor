# agent-monitor

A terminal dashboard for watching multiple Claude Code and Codex sessions in real time. Think `htop` for AI agent sessions: a grid of cells, one per session, with live state (thinking, running a tool, waiting for input, idle, stale, done).

```
agent-monitor grid · sessions=12 (4 hidden, press a) · tick=87 · changed=3
j/k/h/l move · enter detail · / filter · a show stale · r reconcile · q quit
idx: lastDrain=1s ago · backlog=0 · last=OK

> ⠸ projects/tui     tool Bash          ⠹ projects/tui     thin Implementi…
  X tmp              wait Just respo…   C code/jackonf     idle yes make a…
  ⠏ projects/api     tool Edit          C projects/web     wait can you fi…
  ⠦ projects/api     tool Read          C projects/cli     wait write a sm…
```

## What it does

- Watches **every Claude and Codex session you run on this machine**, not just ones it spawned. The TUI is an observer — your normal `claude` / `codex` workflow is unchanged.
- Per-session state: `thinking`, `tool` (with the tool name), `permission`, `waiting`, `idle`, `stale`, `done`.
- Hides closed and stale sessions by default; press `a` to show them.
- Drill into any cell with `enter` to see metadata, recent events, and the rollout file path.

## How it works

```
┌──────────────────┐    ┌──────────────────┐
│ Claude Code hook │    │   Codex hook     │   shell scripts that
│  (shell script)  │    │  (shell script)  │   append one JSON line
└────────┬─────────┘    └────────┬─────────┘   per agent event
         │                       │
         ▼                       ▼
   ~/.local/state/agent-monitor/spool/<provider>/<session_hash>/YYYYMMDD.jsonl
         │
         │      (also: rollout reconciler tails ~/.claude/projects/
         │       and ~/.codex/sessions/ for sessions that started
         │       before the hooks were installed)
         ▼
   ┌────────────┐
   │  Indexer   │  drains spool + rollouts into SQLite
   └─────┬──────┘
         ▼
   ~/.local/state/agent-monitor/events.db   (WAL mode)
         ▲
         │
   ┌─────┴──────┐
   │   TUI      │  reads SQLite at 200 ms tick, renders grid
   └────────────┘
```

Hooks fire on every agent lifecycle event (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`). Each hook is a tiny shell script that fails open — telemetry loss is acceptable, agent latency is not.

The reconciler picks up sessions that started before the hooks were installed by tailing the providers' own rollout JSONL files. Both signal sources land in the same SQLite, deduped by `(source_path, source_offset)`.

## Requirements

- Linux (uses `date +%s%3N`, `sha1sum`, `/proc`)
- [Bun](https://bun.sh) ≥ 1.3 (uses `bun:sqlite` and `bun:test`)
- [`jq`](https://jqlang.github.io/jq/) for the hook script's session-id extraction
- [Claude Code](https://docs.claude.com/en/docs/claude-code) (any recent version) and/or [Codex CLI](https://github.com/openai/codex) ≥ 0.125

## Install

```bash
git clone <this-repo> && cd tui
bun install
bun run install-hooks
```

`install-hooks` will:

1. Print a unified diff of what would change in `~/.claude/settings.json`.
2. Prompt `[y/N]`. Type `y` to apply.
3. Atomically merge the `hooks` block into `~/.claude/settings.json` (your existing keys are preserved untouched).
4. Drop a backup at `~/.claude/settings.json.bak.<ISO-timestamp>`.
5. Copy the hook scripts to `~/.local/share/agent-monitor/hooks/` and make them executable.

For Codex, the hook script writes to `~/.codex/hooks.json` (a new file). Codex hooks are stable + on by default in CLI ≥ 0.125, no feature flag needed.

## Usage

```bash
bun run tui                      # open the dashboard
bun run doctor                   # print system status (DB, spool, rollouts, hook install state)
bun run src/cli.ts reconcile     # one-pass scan of providers' rollout files
bun run src/cli.ts compact       # drop events older than 7 days (sessions kept)
bun run src/cli.ts rotate-spool  # delete fully-ingested spool files older than 3 days
```

### TUI keybindings

| Key | Action |
|---|---|
| `j` / `k` / `h` / `l` (or arrows) | Move focus |
| `enter` | Open detail view for focused session |
| `esc` | Back to grid (from detail) / exit filter mode |
| `/` | Enter filter mode (filter by cwd, state, tool, model, prompt) |
| `a` | Toggle showing stale + done sessions |
| `r` | Force reconcile now (also runs ambient every 8 s) |
| `q` / Ctrl-C | Quit |

The dashboard shows only **active** sessions by default. "Active" means: not `done` and not `stale` (≥ 10 min since the last event with no `Stop` hook).

### State semantics

- `thinking` — model is generating a response.
- `tool` — agent is executing a tool (Bash, Edit, etc.); the cell shows the tool name.
- `permission` — agent is awaiting your approval for a tool call.
- `waiting` — turn finished, agent is waiting for the next user prompt.
- `idle` — no events for 90+ seconds (still alive; rendered dimmed).
- `stale` — no events for 10+ minutes; hidden by default.
- `done` — explicit `Stop` hook fired (clean exit); hidden by default.

There is no `dead` state in v1 — distinguishing "crashed" from "quietly waiting" requires reliable PID tracking, which the hook payloads don't currently provide.

## Uninstall

```bash
bun run install-hooks --uninstall   # removes our entries from ~/.claude/settings.json
rm ~/.codex/hooks.json              # we own this whole file; safe to delete
```

The Claude uninstall preserves any non-agent-monitor hooks you've added. It leaves `~/.claude/settings.json.bak.*` backups in place — delete them manually if you want.

To also wipe collected data:

```bash
rm -rf ~/.local/state/agent-monitor   # events.db, spool files, tui.log
rm -rf ~/.local/share/agent-monitor   # the deployed hook scripts
```

## File layout

| Path | Purpose |
|---|---|
| `~/.local/state/agent-monitor/events.db` | SQLite event store (WAL mode) |
| `~/.local/state/agent-monitor/spool/<provider>/<sha1>/YYYYMMDD.jsonl` | Per-session hook spool |
| `~/.local/state/agent-monitor/tui.log` | TUI log (never goes to stdout) |
| `~/.local/share/agent-monitor/hooks/{claude,codex}-hook.sh` | Installed hook scripts |
| `~/.claude/settings.json` | Modified to register Claude hooks (with backup) |
| `~/.codex/hooks.json` | Created to register Codex hooks |

The hook scripts append to JSONL spool files at sub-millisecond cost. The indexer (the only writer to the SQLite events.db) drains the spool every ~1 s while the TUI is open.

## Troubleshooting

- **`agent-monitor doctor` is the first stop.** It reports hook install status, spool backlog, DB last event time, and per-provider event counts.
- **No sessions showing up after install?** Sessions started *before* the hook install won't have a `SessionStart` hook recorded — but they should still appear via the rollout reconciler within ~10 s of opening the TUI. If not: `bun run src/cli.ts reconcile` runs a one-pass scan and prints stats.
- **Sessions stuck in `tool` state** usually means a `PostToolUse` hook didn't fire (e.g. Claude Code crashed mid-tool). The state-age logic transitions to `idle` after 90 s and `stale` after 10 min.
- **`jq: command not found`** during a hook fire: install jq (`apt install jq` / `dnf install jq` / `pacman -S jq`). The hook script falls back to a `sed` parser, but jq is more reliable.
- **Hook fires don't appear in spool**: check `~/.claude/settings.json` for the `hooks` block. Re-run `bun run install-hooks` if it's missing.

## Limitations (v1)

- **Linux only.** macOS would need adapters for `date +%s%3N`, `sha1sum`, and `/proc`-based liveness (when we add it).
- **No `dead` state.** Hooks don't carry a reliable PID, so we can't distinguish a crashed agent from a quiet one. We use event-age ("stale") instead.
- **Subagent sessions** are rendered as their own cells, not nested under the parent.
- **No remote viewing.** All state is local to the machine running the agents.
- **No transcript content** is stored in SQLite — only paths and metadata. Drill-down shows event types, not message bodies.

## Development

```bash
bun test                  # 72 tests, ~1.3 s
bun run typecheck         # tsc --noEmit
bun run src/cli.ts tui    # run the TUI from source
```

The project layout (`src/store/`, `src/indexer/`, `src/reconciler/`, `src/tui/`) follows the architecture diagram above one-to-one. Hot paths to watch:

- `src/indexer/spool.ts` and `src/reconciler/{claude,codex}.ts` are the only writers to `events.db`.
- `src/store/queries.ts` is the single home for all SQL.
- `src/state-machine.ts` derives state on event ingest; `src/liveness.ts` overlays state-age (`idle`/`stale`) at read time.
- `src/tui/store.ts` Zustand `applyDiff` returns a stable Map ref when no row changed, so `React.memo`'d cells skip re-render.

The full design rationale (architectural decisions, peer-review notes, bugs caught and fixed during implementation) lives in the project plan at `~/.claude/plans/vivid-zooming-corbato.md`.
