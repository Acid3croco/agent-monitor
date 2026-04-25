// Rollout reconciliation entry points. Combines the Claude and Codex
// reconcilers into one-pass and watch-mode helpers used by the CLI and TUI.

import type { FSWatcher } from 'chokidar';

import { reconcileClaudeOnce, watchClaude } from './claude.ts';
import { reconcileCodexOnce, watchCodex } from './codex.ts';

export interface ReconcileStats {
  filesScanned: number;
  linesIngested: number;
  linesSkipped: number;
}

export interface ReconcileOptions {
  // Override roots / db path for tests. When omitted, the per-provider
  // reconcilers use PATHS defaults.
  claudeRoot?: string;
  codexRoot?: string;
  dbPath?: string;
  log?: (msg: string) => void;
}

// One-pass scan over both providers. Used by `agent-monitor reconcile` and by
// the watch entry point as the startup pass.
export async function runReconcileOnce(
  opts: ReconcileOptions = {},
): Promise<ReconcileStats> {
  const claudeStats = await reconcileClaudeOnce({
    rootDir: opts.claudeRoot,
    dbPath: opts.dbPath,
    log: opts.log,
  });
  const codexStats = await reconcileCodexOnce({
    rootDir: opts.codexRoot,
    dbPath: opts.dbPath,
    log: opts.log,
  });
  return {
    filesScanned: claudeStats.filesScanned + codexStats.filesScanned,
    linesIngested: claudeStats.linesIngested + codexStats.linesIngested,
    linesSkipped: claudeStats.linesSkipped + codexStats.linesSkipped,
  };
}

// Watch-mode reconciler. Returns a `stop()` that closes both chokidar watchers.
// Caller is responsible for awaiting `stop()` on shutdown.
export async function startReconciler(
  opts: ReconcileOptions = {},
): Promise<{ stop(): Promise<void> }> {
  const claudeWatcher: FSWatcher = await watchClaude({
    rootDir: opts.claudeRoot,
    dbPath: opts.dbPath,
    log: opts.log,
  });
  const codexWatcher: FSWatcher = await watchCodex({
    rootDir: opts.codexRoot,
    dbPath: opts.dbPath,
    log: opts.log,
  });
  return {
    async stop() {
      await Promise.all([claudeWatcher.close(), codexWatcher.close()]);
    },
  };
}
