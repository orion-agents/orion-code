import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import type { TranscriptEntry } from '../types';
import { splitByVisualWidth } from '../runtime/prompt-layout';
import { Markdown } from './Markdown';
import { ToolActivityBlock, parseToolActivity } from './ToolActivity';

export interface TranscriptProps {
  entries: TranscriptEntry[];
  maxItems?: number;
  width?: number;
  emptyMessage?: string | null;
}

const USER_BACKGROUND = '#50545c';
const ANSI_RESET_BG = '\x1b[49m';
const ANSI_RESET_FG = '\x1b[39m';
const ANSI_USER_BG = '\x1b[48;5;102m';
const ANSI_GRAY = '\x1b[90m';
const ANSI_RED = '\x1b[31m';

function padLine(line: string, width: number): string {
  const padding = Math.max(0, width - stringWidth(line));
  return line + ' '.repeat(padding);
}

function transcriptLines(entry: TranscriptEntry, width: number): string[] {
  const rawLines = entry.content.split('\n');
  if (entry.role !== 'user' && entry.role !== 'command') {
    return rawLines.map(line => line || ' ');
  }

  return rawLines.flatMap(line =>
    splitByVisualWidth(line || ' ', width).map(chunk => padLine(chunk, width))
  );
}

function colorTranscriptLine(entry: TranscriptEntry, line: string): string {
  if (entry.role === 'user' || entry.role === 'command') {
    return `${ANSI_USER_BG}${line}${ANSI_RESET_BG}`;
  }

  if (entry.role === 'tool') {
    return `${ANSI_GRAY}${line}${ANSI_RESET_FG}`;
  }

  if (entry.role === 'error') {
    return `${ANSI_RED}${line}${ANSI_RESET_FG}`;
  }

  return line;
}

export function renderTranscriptEntryText(entry: TranscriptEntry, width = 80): string {
  const contentWidth = Math.max(1, width - 2);
  return transcriptLines(entry, contentWidth)
    .map(line => colorTranscriptLine(entry, line))
    .join('\n');
}

export function TranscriptEntryBlock({ entry, width = 80 }: { entry: TranscriptEntry; width?: number }): JSX.Element {
  const contentWidth = Math.max(1, width - 2);
  const toolActivity = entry.role === 'tool' || entry.role === 'error'
    ? parseToolActivity(entry.content)
    : null;

  if (toolActivity) {
    return <ToolActivityBlock entry={entry} width={width} />;
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      {entry.role === 'assistant' || entry.role === 'system' || entry.role === 'status' ? (
        <Markdown width={contentWidth}>{entry.content}</Markdown>
      ) : (
        transcriptLines(entry, contentWidth).map((line, index) => (
          <Text
            key={index}
            color={entry.role === 'error' ? 'red' : entry.role === 'tool' ? 'gray' : undefined}
            backgroundColor={entry.role === 'user' || entry.role === 'command' ? USER_BACKGROUND : undefined}
            wrap="truncate"
          >
            {line}
          </Text>
        ))
      )}
    </Box>
  );
}

export function Transcript({ entries, maxItems, width = 80, emptyMessage = 'Orion Code is ready.' }: TranscriptProps): JSX.Element {
  const visible = typeof maxItems === 'number'
    ? entries.slice(Math.max(0, entries.length - maxItems))
    : entries;

  return (
    <Box flexDirection="column">
      {visible.length === 0 ? (
        emptyMessage ? <Text color="gray">{emptyMessage}</Text> : null
      ) : (
        visible.map(entry => (
          <TranscriptEntryBlock key={entry.id} entry={entry} width={width} />
        ))
      )}
    </Box>
  );
}
