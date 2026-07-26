import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { calculateCtxPercent } from '../../services/model-context';
import { mcpManager } from '../../tools/mcp';
import type { OpenHorseUiRuntime } from '../types';
import { runningHorseLabel } from './RunningHorseIndicator';

const RUNNING_HORSE_MARK = '╭◔╮▰╱╲ ·';

export type ErrorLayer = 'renderer' | 'runtime' | 'provider' | 'tool' | 'session' | 'memory' | 'MCP' | 'skills';

export interface StatusLineProps {
  runtime: OpenHorseUiRuntime;
  running: boolean;
  statusMessage?: string;
  width?: number;
  errorLayer?: ErrorLayer;
}

function truncateVisual(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text;
  let result = '';
  for (const char of text) {
    if (stringWidth(`${result}${char}...`) > maxWidth) break;
    result += char;
  }
  return `${result}...`;
}

export function StatusLine({ runtime, running, statusMessage, width = 80, errorLayer }: StatusLineProps): JSX.Element {
  const snapshot = runtime.store.getSnapshot();
  const usage = snapshot.tokenUsage;
  const totalTokens = usage ? usage.promptTokens + usage.completionTokens : 0;
  const session = runtime.getSession();
  const mcpStatus = mcpManager.getStatus();
  const connectedMcp = mcpStatus.filter(item => item.connected).length;
  const ctxPercent = calculateCtxPercent(totalTokens, snapshot.currentModel || snapshot.config.model);
  const errorTag = errorLayer ? `[${errorLayer}] ` : '';
  const baseLeft = errorLayer ? `${errorLayer} error` : (statusMessage || 'ready');
  const fullRightText = [
    `model=${snapshot.currentModel}`,
    `session=${session?.id.slice(0, 8) ?? 'none'}`,
    `tokens=${(totalTokens / 1000).toFixed(1)}K`,
    `ctx=${ctxPercent}%`,
    mcpStatus.length > 0 ? `mcp=${connectedMcp}/${mcpStatus.length}` : '',
  ].filter(Boolean).join('  ');
  const mediumRightText = [
    `model=${snapshot.currentModel}`,
    `session=${session?.id.slice(0, 8) ?? 'none'}`,
    `tokens=${(totalTokens / 1000).toFixed(1)}K`,
    `ctx=${ctxPercent}%`,
  ].join('  ');
  const compactRightText = [
    `model=${snapshot.currentModel}`,
    `ctx=${ctxPercent}%`,
  ].join('  ');
  const usableWidth = Math.max(20, width);
  const rightBudget = Math.max(10, Math.floor(usableWidth * 0.68));

  if (running) {
    const runningText = truncateVisual(
      `${compactRightText}  ${RUNNING_HORSE_MARK} ${runningHorseLabel(statusMessage)}`,
      usableWidth
    );

    return (
      <Box width={usableWidth}>
        <Text color="gray" wrap="truncate">
          {runningText}
        </Text>
      </Box>
    );
  }

  const rightText = [fullRightText, mediumRightText, compactRightText]
    .find(candidate => stringWidth(candidate) <= rightBudget)
    ?? compactRightText;
  const rightMaxWidth = Math.max(10, Math.min(stringWidth(rightText), rightBudget));
  const rightDisplay = truncateVisual(rightText, rightMaxWidth);
  const leftMaxWidth = Math.max(8, usableWidth - stringWidth(rightDisplay) - 2);
  const leftText = truncateVisual(errorTag + baseLeft, leftMaxWidth);

  return (
    <Box width={usableWidth} justifyContent="space-between">
      <Text color={errorLayer ? 'red' : 'gray'} wrap="truncate">
        {leftText}
      </Text>
      <Text color="gray" wrap="truncate">
        {rightDisplay}
      </Text>
    </Box>
  );
}
