// Tests for src/install.ts. Operates exclusively on temp files —
// never touches the user's real ~/.claude/settings.json.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLAUDE_HOOK_EVENTS,
  applyClaudeHookInstall,
  claudeHookCommandPath,
  mergeClaudeHooks,
  planClaudeHookInstall,
  stripOurHooks,
  uninstallClaudeHooks,
} from '../src/install.ts';

let tmpDir: string;
let tmpSettings: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-monitor-install-test-'));
  tmpSettings = path.join(tmpDir, 'settings.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('planClaudeHookInstall', () => {
  test('adds entries when settings.json has no hooks key', () => {
    const original = {
      permissions: { allow: ['Bash(*)'], defaultMode: 'default' as const },
      enabledPlugins: { 'foo@bar': true },
    };
    fs.writeFileSync(tmpSettings, JSON.stringify(original, null, 2));

    const plan = planClaudeHookInstall(tmpSettings);

    // Original keys preserved.
    expect(plan.nextJson.permissions).toEqual(original.permissions);
    expect(plan.nextJson.enabledPlugins).toEqual(original.enabledPlugins);

    // Hooks added for every target event.
    expect(plan.nextJson.hooks).toBeDefined();
    for (const event of CLAUDE_HOOK_EVENTS) {
      const groups = plan.nextJson.hooks?.[event];
      expect(Array.isArray(groups)).toBe(true);
      expect(groups!.length).toBe(1);
      const handler = groups![0].hooks[0];
      expect(handler.type).toBe('command');
      expect(handler.command).toContain(claudeHookCommandPath());
      expect(handler.command).toContain('claude');
      expect(handler.command).toContain(event);
    }

    // Disk untouched by planning.
    expect(JSON.parse(fs.readFileSync(tmpSettings, 'utf8'))).toEqual(original);

    // Diff string contains a header and at least one + line.
    expect(plan.diffString).toContain('--- a/');
    expect(plan.diffString).toContain('+++ b/');
    expect(plan.diffString).toMatch(/^\+.*hooks/m);
  });

  test('preserves an existing user-added hook (e.g. user-attention)', () => {
    const userHookCmd = '/home/user/scripts/notify-attention.sh';
    const original = {
      permissions: { allow: ['Bash(*)'] },
      hooks: {
        Notification: [
          {
            matcher: '',
            hooks: [{ type: 'command' as const, command: userHookCmd }],
          },
        ],
      },
    };
    fs.writeFileSync(tmpSettings, JSON.stringify(original, null, 2));

    const plan = planClaudeHookInstall(tmpSettings);

    // User's Notification entry is still there.
    const notifGroups = plan.nextJson.hooks!.Notification!;
    const userStillPresent = notifGroups.some((g) =>
      g.hooks.some((h) => h.command === userHookCmd),
    );
    expect(userStillPresent).toBe(true);

    // Plus our entry is registered for Notification.
    const oursPresent = notifGroups.some((g) =>
      g.hooks.some((h) =>
        typeof h.command === 'string' && h.command.includes(claudeHookCommandPath()),
      ),
    );
    expect(oursPresent).toBe(true);

    // Other events we register also got our handler.
    for (const event of CLAUDE_HOOK_EVENTS) {
      if (event === 'Notification') continue;
      const groups = plan.nextJson.hooks?.[event];
      expect(groups).toBeDefined();
      expect(groups!.length).toBeGreaterThan(0);
    }
  });

  test('is idempotent — planning twice produces the same nextJson', () => {
    fs.writeFileSync(tmpSettings, JSON.stringify({}, null, 2));
    const plan1 = planClaudeHookInstall(tmpSettings);
    // Apply mentally: write the planned next as the new "current" and re-plan.
    fs.writeFileSync(tmpSettings, JSON.stringify(plan1.nextJson, null, 2));
    const plan2 = planClaudeHookInstall(tmpSettings);
    expect(plan2.nextJson).toEqual(plan1.nextJson);
  });

  test('returns empty {} as currentJson when settings.json is missing', () => {
    const plan = planClaudeHookInstall(tmpSettings);
    expect(plan.currentJson).toEqual({});
    expect(plan.nextJson.hooks).toBeDefined();
  });
});

describe('mergeClaudeHooks (pure)', () => {
  test('adds all six configured events', () => {
    const merged = mergeClaudeHooks({});
    for (const event of CLAUDE_HOOK_EVENTS) {
      expect(merged.hooks?.[event]).toBeDefined();
    }
  });

  test('preserves unknown top-level keys verbatim', () => {
    const merged = mergeClaudeHooks({
      permissions: { allow: ['x'] },
      enabledPlugins: { foo: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect((merged as { permissions: unknown }).permissions).toEqual({ allow: ['x'] });
    expect((merged as { enabledPlugins: unknown }).enabledPlugins).toEqual({ foo: true });
  });
});

describe('applyClaudeHookInstall + uninstall round-trip', () => {
  test('install then uninstall returns settings to original shape', () => {
    const original = {
      permissions: { allow: ['Bash(*)'], defaultMode: 'default' },
      enabledPlugins: { 'foo@bar': true },
      tui: 'fullscreen',
    };
    const originalText = JSON.stringify(original, null, 2);
    fs.writeFileSync(tmpSettings, originalText);

    // Install.
    const plan = planClaudeHookInstall(tmpSettings);
    applyClaudeHookInstall(plan);

    const afterInstall = JSON.parse(fs.readFileSync(tmpSettings, 'utf8'));
    expect(afterInstall.hooks).toBeDefined();
    // Original keys still present.
    expect(afterInstall.permissions).toEqual(original.permissions);
    expect(afterInstall.tui).toBe('fullscreen');

    // Backup file written.
    const backups = fs
      .readdirSync(tmpDir)
      .filter((f) => f.startsWith('settings.json.bak.'));
    expect(backups.length).toBe(1);

    // Uninstall.
    uninstallClaudeHooks(tmpSettings);
    const afterUninstall = JSON.parse(fs.readFileSync(tmpSettings, 'utf8'));

    // hooks key gone (we owned the only entries).
    expect(afterUninstall.hooks).toBeUndefined();
    // Other keys identical to original.
    expect(afterUninstall.permissions).toEqual(original.permissions);
    expect(afterUninstall.enabledPlugins).toEqual(original.enabledPlugins);
    expect(afterUninstall.tui).toBe(original.tui);
  });

  test('uninstall preserves user-added hooks', () => {
    const userHookCmd = '/home/user/scripts/notify-attention.sh';
    const original = {
      permissions: { allow: ['Bash(*)'] },
      hooks: {
        Notification: [
          { matcher: '', hooks: [{ type: 'command', command: userHookCmd }] },
        ],
      },
    };
    fs.writeFileSync(tmpSettings, JSON.stringify(original, null, 2));

    const plan = planClaudeHookInstall(tmpSettings);
    applyClaudeHookInstall(plan);
    uninstallClaudeHooks(tmpSettings);

    const after = JSON.parse(fs.readFileSync(tmpSettings, 'utf8'));
    expect(after.hooks?.Notification).toBeDefined();
    const stillThere = after.hooks.Notification.some((g: { hooks: { command: string }[] }) =>
      g.hooks.some((h) => h.command === userHookCmd),
    );
    expect(stillThere).toBe(true);
    // Our entries are gone.
    const oursGone = after.hooks.Notification.every(
      (g: { hooks: { command: string }[] }) =>
        g.hooks.every((h) => !h.command.includes(claudeHookCommandPath())),
    );
    expect(oursGone).toBe(true);
    // Other events we touched are now gone (user had nothing there).
    for (const event of CLAUDE_HOOK_EVENTS) {
      if (event === 'Notification') continue;
      expect(after.hooks?.[event]).toBeUndefined();
    }
  });
});

describe('stripOurHooks (pure)', () => {
  test('removes only handlers pointing into PATHS.hooks', () => {
    const userCmd = '/home/user/scripts/x.sh';
    const ourCmd = claudeHookCommandPath() + ' claude Stop';
    const stripped = stripOurHooks({
      hooks: {
        Stop: [
          {
            matcher: '',
            hooks: [
              { type: 'command', command: userCmd },
              { type: 'command', command: ourCmd },
            ],
          },
        ],
      },
    });
    expect(stripped.hooks?.Stop).toBeDefined();
    const handlers = stripped.hooks!.Stop![0].hooks;
    expect(handlers.length).toBe(1);
    expect(handlers[0].command).toBe(userCmd);
  });

  test('drops hooks key entirely when nothing remains', () => {
    const stripped = stripOurHooks({
      hooks: {
        Stop: [
          {
            matcher: '',
            hooks: [{ type: 'command', command: claudeHookCommandPath() }],
          },
        ],
      },
    });
    expect(stripped.hooks).toBeUndefined();
  });
});
