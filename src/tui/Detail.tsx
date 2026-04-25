// Detail view: drill-down for a single focused session.
// Renders metadata + last 20 events (kind, observed_at, optional tool name
// extracted from the JSON payload).

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { useStore } from './store.ts';
import type { EventRow } from '../types.ts';

function fmtTs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '?';
  const d = new Date(ms);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function extractToolName(ev: EventRow): string | null {
  if (!ev.payload_json) return null;
  try {
    const p = JSON.parse(ev.payload_json) as { tool_name?: unknown };
    if (typeof p.tool_name === 'string' && p.tool_name) return p.tool_name;
  } catch {
    // ignore — payload may be truncated or non-JSON
  }
  return null;
}

const STATE_COLOR: Record<string, string> = {
  thinking: 'cyan',
  tool: 'yellow',
  permission: 'magenta',
  waiting: 'gray',
  idle: 'gray',
  done: 'green',
  stale: 'red',
  dead: 'red',
  recovered: 'blue',
};

interface FieldProps {
  label: string;
  value: string | null | undefined;
  color?: string;
}

function Field({ label, value, color }: FieldProps): React.ReactElement {
  return (
    <Box>
      <Text dimColor>{label.padEnd(15)}</Text>
      <Text color={color}>{value ?? '-'}</Text>
    </Box>
  );
}

export function Detail(): React.ReactElement {
  const focusedKey = useStore((s) => s.focusedKey);
  const sessions = useStore((s) => s.sessions);
  const recentEvents = useStore((s) => s.recentEvents);
  const eventScroll = useStore((s) => s.eventScroll);

  const session = focusedKey ? sessions.get(focusedKey) ?? null : null;
  const events = useMemo<EventRow[]>(
    () => (focusedKey ? recentEvents.get(focusedKey) ?? [] : []),
    [focusedKey, recentEvents],
  );

  if (!focusedKey || !session) {
    return (
      <Box flexDirection="column">
        <Text color="red">no session focused</Text>
        <Text dimColor>esc to return to grid</Text>
      </Box>
    );
  }

  // Window of events: scroll offset slices into the (already DESC) event list.
  const VIEW = 20;
  const windowed = events.slice(eventScroll, eventScroll + VIEW);

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>session detail </Text>
        <Text dimColor>(esc to return, j/k to scroll events)</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Field label="key" value={session.key} />
        <Field label="provider" value={session.provider} />
        <Field label="session_id" value={session.session_id} />
        <Field label="model" value={session.model} />
        <Field label="cli_version" value={session.cli_version} />
        <Field label="cwd" value={session.cwd} />
        <Field label="transcript" value={session.transcript_path} />
        <Field
          label="state"
          value={`${session.state}${session.current_tool ? ` (${session.current_tool})` : ''}`}
          color={STATE_COLOR[session.state] ?? 'white'}
        />
        <Field label="last_event_at" value={fmtTs(session.last_event_at_ms)} />
        <Field label="last_prompt" value={(session.last_prompt ?? '').slice(0, 200) || null} />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>recent events ({events.length}):</Text>
        {windowed.length === 0 ? (
          <Text dimColor>(none yet)</Text>
        ) : (
          windowed.map((ev) => {
            const tool = extractToolName(ev);
            return (
              <Box key={ev.id}>
                <Text dimColor>{fmtTs(ev.observed_at_ms)} </Text>
                <Text color="cyan">{ev.kind.padEnd(20)} </Text>
                {tool ? <Text>{tool}</Text> : null}
              </Box>
            );
          })
        )}
        {eventScroll + VIEW < events.length ? (
          <Text dimColor>
            … {events.length - eventScroll - VIEW} older events
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}
