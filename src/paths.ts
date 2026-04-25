// XDG path helpers + session-key derivation.
// Single source of truth for filesystem locations.

import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Provider } from './types.ts';

const HOME = os.homedir();
const STATE_HOME = process.env.XDG_STATE_HOME || path.join(HOME, '.local', 'state');
const DATA_HOME = process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share');

export const PATHS = {
  // Our state.
  state: path.join(STATE_HOME, 'agent-monitor'),
  db: path.join(STATE_HOME, 'agent-monitor', 'events.db'),
  spool: path.join(STATE_HOME, 'agent-monitor', 'spool'),

  // Our installed assets.
  hooks: path.join(DATA_HOME, 'agent-monitor', 'hooks'),

  // Claude Code locations.
  claudeProjects: path.join(HOME, '.claude', 'projects'),
  claudeSettings: path.join(HOME, '.claude', 'settings.json'),
  claudeSettingsLocal: path.join(HOME, '.claude', 'settings.local.json'),

  // Codex locations.
  codexSessions: path.join(HOME, '.codex', 'sessions'),
  codexConfig: path.join(HOME, '.codex', 'config.toml'),
  codexHooks: path.join(HOME, '.codex', 'hooks.json'),
} as const;

// 16-char sha1 prefix; collision risk is acceptable for path partitioning.
export function sessionHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 16);
}

// Stable session identity across the system.
// transcriptPath disambiguates session_id collisions across forks/subagents.
export function sessionKey(
  provider: Provider,
  sessionId: string,
  transcriptPath: string | null,
): string {
  const h = sessionHash(transcriptPath ?? '');
  return `${provider}:${sessionId}:${h}`;
}

// Per-session spool directory (eliminates cross-session write contention).
export function spoolDir(provider: Provider, sessionId: string): string {
  return path.join(PATHS.spool, provider, sessionHash(sessionId));
}

// Today's spool file for a given session (UTC date).
export function spoolFile(provider: Provider, sessionId: string, dateUtc?: Date): string {
  const d = dateUtc ?? new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return path.join(spoolDir(provider, sessionId), `${yyyy}${mm}${dd}.jsonl`);
}
