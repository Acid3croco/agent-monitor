import React from 'react';
import { Box, Text } from 'ink';

const GROUPS: Array<{ title: string; bindings: Array<[string, string]> }> = [
  {
    title: 'Navigation',
    bindings: [
      ['j / k / h / l', 'move focus or scroll events'],
      ['gg / G', 'jump to first / last session'],
      ['ctrl-d / ctrl-u', 'scroll grid half-page'],
      ['enter', 'open detail'],
      ['esc', 'back'],
    ],
  },
  {
    title: 'View',
    bindings: [
      ['a', 'toggle stale / done sessions'],
      ['m', 'toggle MCP sessions'],
      ['d', 'cycle density'],
      ['/', 'filter'],
    ],
  },
  {
    title: 'Action',
    bindings: [
      ['r', 'reconcile'],
      ['c', 'copy --resume to clipboard'],
    ],
  },
  {
    title: 'Quit',
    bindings: [
      ['q', 'quit'],
      ['ctrl-c', 'quit'],
    ],
  },
];

export function Help(): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold>help</Text>
      <Box marginTop={1} flexDirection="column">
        {GROUPS.map((group) => (
          <Box key={group.title} flexDirection="column" marginBottom={1}>
            <Text bold>{group.title}</Text>
            {group.bindings.map(([key, desc]) => (
              <Box key={key}>
                <Text color="cyan">{key.padEnd(16)}</Text>
                <Text>{desc}</Text>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
      <Text dimColor>esc / ? back</Text>
    </Box>
  );
}
