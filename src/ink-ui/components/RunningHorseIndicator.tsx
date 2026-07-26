import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { isLegacyTurnStatus } from '../../runtime/agent-status';

const HORSE_FRAMES = [
  { horse: '╭◔╮▰╱╲', dust: '·  ' },
  { horse: '╭◔╮▰╲╱', dust: ' · ' },
  { horse: '╭◔╮▰╱╱', dust: '  ·' },
  { horse: '╭◔╮▰╲╲', dust: ' ··' },
];

export interface RunningHorseFrame {
  horse: string;
  dust: string;
}

export interface RunningHorseIndicatorProps {
  label?: string;
  maxWidth?: number;
  intervalMs?: number;
}

export function getRunningHorseFrame(tick: number): RunningHorseFrame {
  return HORSE_FRAMES[Math.abs(tick) % HORSE_FRAMES.length];
}

function truncateVisual(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (stringWidth(text) <= maxWidth) return text;

  let result = '';
  for (const char of text) {
    if (stringWidth(`${result}...`) > maxWidth) break;
    result += char;
  }
  return `${result}...`;
}

export function runningHorseLabel(statusMessage?: string): string {
  const trimmed = statusMessage?.trim() ?? '';
  if (!trimmed || isLegacyTurnStatus(trimmed)) return 'working';
  return trimmed;
}

export function RunningHorseIndicator({
  label = 'working',
  maxWidth = 32,
  intervalMs: _intervalMs = 120,
}: RunningHorseIndicatorProps): JSX.Element {
  const frame = getRunningHorseFrame(0);
  const fixedWidth = stringWidth(`${frame.horse} ${frame.dust} `);
  const text = truncateVisual(label, Math.max(0, maxWidth - fixedWidth));

  return (
    <Box>
      <Text color="cyan">{frame.horse}</Text>
      <Text color="gray"> {frame.dust} </Text>
      <Text color="yellow">{text}</Text>
    </Box>
  );
}
