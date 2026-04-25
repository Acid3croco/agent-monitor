# Compatibility — Codex hooks on CLI 0.125.0

**Verdict: HOOKS WORK on Codex CLI 0.125.0.**

The same `codex-hook.sh` shell script that backs Claude works unmodified for Codex. Both providers put `session_id` at the top level of the stdin payload; `jq -r '.session_id'` extracts it cleanly.

## Environment

- `codex --version` → `codex-cli 0.125.0`
- `codex features list | grep codex_hooks` → `codex_hooks   stable   true`
  - `codex_hooks` is in the **stable** stage and **default-on**. The `[features] codex_hooks = true` line in `~/.codex/config.toml` is therefore redundant on 0.125.0, but harmless and explicit. We left it in so the install is self-documenting and survives any future change in default state.

## Config changes made

- Backup: `~/.codex/config.toml.bak.20260425T080116Z` (preserved).
- Appended `[features]` section with `codex_hooks = true` to `~/.codex/config.toml` via tmp+rename atomic write. All prior sections (`[projects."/home/jack"]`, `[tui.model_availability_nux]`, `[plugins."github@openai-curated"]`, `[mcp_servers.claude]`) preserved verbatim.
- Wrote `~/.codex/hooks.json` registering `codex-hook.sh codex <Event>` for the six events listed below. Schema confirmed against the official docs (`https://developers.openai.com/codex/hooks`) and against the `figma` plugin's `hooks.json` shipped with Codex on this box (`~/.codex/.tmp/plugins/plugins/figma/hooks.json`).

## Schema used (`~/.codex/hooks.json`)

```json
{
  "hooks": {
    "<EventName>": [
      { "hooks": [{ "type": "command", "command": "<absolute-path> codex <EventName>" }] }
    ]
  }
}
```

Codex does **not** distinguish startup-vs-resume in the matcher in the way Claude does — `matcher` is omitted entirely (any subtype fires the hook). The official docs show a `matcher: "startup|resume"` example for SessionStart but matching is not required.

## Test results

Two minimal `codex exec --skip-git-repo-check` runs:

1. **No-tool prompt** ("respond with the literal word OK"). Captured: SessionStart, UserPromptSubmit, Stop. Spool: `spool/codex/929345e44ec11075/20260425.jsonl` (3 lines).
2. **Tool-use prompt** with `--dangerously-bypass-approvals-and-sandbox` ("run `echo HOOKTEST`"). Captured: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop. Spool: `spool/codex/e42967f51a8ff0ca/20260425.jsonl` (5 lines).

Codex visibly logs `hook: <Event>` and `hook: <Event> Completed` to stderr around each invocation — useful confirmation. No startup error, no config rejection.

| Event              | Fired? | Notes                                                                 |
|--------------------|--------|-----------------------------------------------------------------------|
| `SessionStart`     | yes    | Includes `source` field (`"startup"` observed).                        |
| `UserPromptSubmit` | yes    | Includes `prompt` (full text) + `turn_id`.                             |
| `PreToolUse`       | yes    | Includes `tool_name`, `tool_input`, `tool_use_id`, `turn_id`.          |
| `PostToolUse`      | yes    | Includes `tool_response` in addition to PreToolUse fields.             |
| `Stop`             | yes    | Includes `last_assistant_message`, `stop_hook_active`, `turn_id`.      |
| `PermissionRequest`| not exercised | Tests bypassed approvals to keep them non-interactive. Registered but unverified. The event is documented as supported on 0.125.0; we trust the docs for v1 and will revisit if it doesn't reach the spool in the wild. |

## Payload shape — vs Claude

Identical envelope conventions: top-level `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, plus event-specific fields. Codex additionally exposes `permission_mode` and `turn_id`. **No script changes needed**: `codex-hook.sh` is byte-identical to `claude-hook.sh`; only the `$1` provider tag (baked at install time) differs.

Sample SessionStart payload keys:
```
["cwd","hook_event_name","model","permission_mode","session_id","source","transcript_path"]
```

Sample PostToolUse payload keys:
```
["cwd","hook_event_name","model","permission_mode","session_id","tool_input","tool_name","tool_response","tool_use_id","transcript_path","turn_id"]
```

## Drain + doctor

```
$ bun -e "import('./src/indexer/spool.ts').then(m => m.drainOnce()).then(r => console.log(JSON.stringify(r)))"
{"filesScanned":5,"linesIngested":181,"linesSkipped":3}

$ bun run src/cli.ts doctor
sessions by state:
  done       3
  thinking   1
  tool       1
spool files:
  [ingested]    3 lines  .../spool/codex/929345e44ec11075/20260425.jsonl
  [ingested]    5 lines  .../spool/codex/e42967f51a8ff0ca/20260425.jsonl
```

Sessions table after drain shows two `provider=codex` rows with `state=done`, alongside the pre-existing Claude rows.

## Quirks observed

- After `Stop` completes on a `codex exec` run, Codex prints:
  `ERROR codex_core::session: failed to record rollout items: thread <id> not found`
  This appears unrelated to hooks (it's a rollout-recording race on shutdown) and does not block hook delivery. Worth noting for the rollout reconciler (M4) — the rollout file should still exist on disk, but if Codex starts writing the final rollout entries asynchronously after `Stop` fires, the spool will see the lifecycle end before the rollout reconciler does. Hook ordering is the source of truth either way.
- Codex hook events are delivered **synchronously** (visible "hook: X Completed" before the next event prints), which matches Claude's behavior. Long-running hooks would block the agent — keep `codex-hook.sh` fast.

## Required action

None. Codex hooks work out of the box on 0.125.0 with the exact same script and conventions as Claude. M3 is complete; rollout-tail-only fallback is **not** needed for the Codex side.
