// Tiny file logger for the TUI. Writes to ~/.local/state/agent-monitor/tui.log.
//
// Critical: while Ink is mounted, console.log/console.error corrupt the rendered
// frame. This module is the *only* observability channel inside the TUI. The
// pattern is borrowed from the M0 spike's perf logger but routed through the
// project state dir instead of /tmp.

import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../paths.ts';

const LOG_PATH = path.join(PATHS.state, 'tui.log');

let _initialized = false;

function ensureInit(): void {
  if (_initialized) return;
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `# tui log opened ${new Date().toISOString()}\n`);
    _initialized = true;
  } catch {
    // Logging must never throw. Drop silently.
  }
}

export function log(msg: string): void {
  ensureInit();
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // ignore
  }
}

export function logError(msg: string, err: unknown): void {
  const tail =
    err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  log(`ERROR ${msg}: ${tail}`);
}

export const LOG_FILE = LOG_PATH;
