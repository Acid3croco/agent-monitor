// CLI handler for `agent-monitor install-hooks`.
// Wires planClaudeHookInstall + applyClaudeHookInstall + installPlanFiles
// behind a y/n prompt. Importing this file does NOT execute anything.

import readline from 'node:readline';
import {
  applyClaudeHookInstall,
  installPlanFiles,
  planClaudeHookInstall,
  uninstallClaudeHooks,
} from './install.ts';

export interface InstallHooksArgs {
  dryRun: boolean;
  uninstall: boolean;
  filesOnly: boolean;
}

export function parseInstallHooksArgs(argv: string[]): InstallHooksArgs {
  return {
    dryRun: argv.includes('--dry-run'),
    uninstall: argv.includes('--uninstall'),
    filesOnly: argv.includes('--files-only'),
  };
}

// Default entry point for the subcommand.
// Returns the exit code so the CLI dispatcher can call process.exit cleanly.
export async function runInstallHooks(argv: string[]): Promise<number> {
  const args = parseInstallHooksArgs(argv);

  if (args.uninstall) {
    uninstallClaudeHooks();
    process.stdout.write('uninstalled agent-monitor hook entries from settings.json\n');
    return 0;
  }

  // --files-only: just deploy the hook scripts, no settings merge, no prompt.
  // Used by install.sh so the Codex step never depends on the user accepting
  // the Claude diff first.
  if (args.filesOnly) {
    installPlanFiles();
    process.stdout.write('hook scripts deployed to ~/.local/share/agent-monitor/hooks/\n');
    return 0;
  }

  const plan = planClaudeHookInstall();

  // Idempotency: if the merged settings would be byte-equal to the current
  // file, skip the prompt + write entirely. Otherwise every re-run accumulates
  // a fresh `.bak.<stamp>` for no reason.
  if (
    JSON.stringify(plan.currentJson, null, 2) ===
    JSON.stringify(plan.nextJson, null, 2)
  ) {
    process.stdout.write('claude hooks already up to date — no changes\n');
    return 0;
  }

  process.stdout.write(plan.diffString + '\n');

  if (args.dryRun) {
    process.stdout.write('\n(dry run — no changes written)\n');
    return 0;
  }

  const yes = await prompt('\nApply this change? [y/N]: ');
  if (!/^y(es)?$/i.test(yes.trim())) {
    process.stdout.write('aborted, no changes written\n');
    return 1;
  }

  installPlanFiles();
  applyClaudeHookInstall(plan);
  process.stdout.write('hooks installed\n');
  return 0;
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
