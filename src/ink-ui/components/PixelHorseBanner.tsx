import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { basename } from 'path';
import { calculateCtxPercent } from '../../services/model-context';
import { mcpManager } from '../../tools/mcp';
import type { OpenHorseUiRuntime } from '../types';

const HORSE = [
  '   ▄▟█▙▄   ',
  ' ▟█▔  ▔█▙  ',
  '▐█ ◔  ◔ █▌ ',
  ' ▜█ OH █▛  ',
  '  ▟▙▄▄▟▙   ',
  '  ▝▘  ▝▘   ',
];

const COMPACT_HORSE = [
  '╭◔  ◔╮',
  '│ OH │',
  '╰─╥─╯',
];

interface PixelHorseBannerProps {
  runtime: OpenHorseUiRuntime;
  width?: number;
}

function truncateVisual(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (stringWidth(text) <= maxWidth) return text;

  let result = '';
  for (const char of text) {
    if (stringWidth(`${result}${char}…`) > maxWidth) break;
    result += char;
  }
  return `${result}…`;
}

function InfoRow({ label, value, width }: { label: string; value: string; width: number }): JSX.Element {
  return (
    <Text>
      <Text color="gray">{label.padEnd(7)}  </Text>
      <Text color="cyan">{truncateVisual(value, Math.max(4, width - 7))}</Text>
    </Text>
  );
}

export function PixelHorseBanner({ runtime, width = 80 }: PixelHorseBannerProps): JSX.Element {
  const snapshot = runtime.store.getSnapshot();
  const model = snapshot.currentModel || runtime.config.model;
  const usage = snapshot.tokenUsage;
  const totalTokens = usage ? usage.promptTokens + usage.completionTokens : 0;
  const session = runtime.getSession();
  const projectName = basename(runtime.cwd) || runtime.cwd;
  const mcpStatus = mcpManager.getStatus();
  const connectedMcp = mcpStatus.filter(item => item.connected).length;
  const ctxPercent = calculateCtxPercent(totalTokens, model);
  const cardWidth = Math.max(44, Math.min(width, 118));
  const compact = cardWidth < 82;
  const infoWidth = compact ? cardWidth - 6 : Math.max(28, Math.min(42, cardWidth - 54));
  const project = truncateVisual(runtime.cwd, infoWidth - 7);
  const mcpText = mcpStatus.length > 0 ? `${connectedMcp}/${mcpStatus.length}` : 'none';

  if (compact) {
    return (
      <Box borderStyle="round" borderColor="gray" paddingX={1} width={cardWidth}>
        <Box flexDirection="row">
          <Box flexDirection="column" marginRight={2}>
            {COMPACT_HORSE.map((line, index) => (
              <Text key={index} color={index === 1 ? 'cyan' : 'gray'}>{line}</Text>
            ))}
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            <Text>
              <Text bold color="cyan">Orion Code</Text>
              <Text color="gray"> v{runtime.version}</Text>
            </Text>
            <Text color="gray">{truncateVisual(`model ${model}  project ${projectName}`, cardWidth - 16)}</Text>
            <Text color={runtime.isConfigured ? 'gray' : 'yellow'}>
              {runtime.isConfigured ? 'context harness coding agent' : 'LLM not configured: set ORION_CODE_API_KEY'}
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  return (
    <Box borderStyle="round" borderColor="gray" paddingX={2} paddingY={1} width={cardWidth}>
      <Box flexDirection="row">
        <Box flexDirection="column" marginRight={3}>
          <Text>
            <Text color="cyan" bold>ORION</Text>
            <Text color="white" bold> CODE</Text>
            <Text color="gray"> v{runtime.version}</Text>
          </Text>
          <Text color="gray">context harness coding agent</Text>
          <Box marginTop={1} flexDirection="column">
            <Text color="gray">/ commands   @ files   ? shortcuts</Text>
            <Text color="gray">Alt+Enter newline   Ctrl+C twice exits</Text>
          </Box>
        </Box>

        <Box flexDirection="column" marginRight={3}>
          {HORSE.map((line, index) => (
            <Text key={index} color={index === 3 ? 'cyan' : 'gray'}>{line}</Text>
          ))}
        </Box>

        <Box flexDirection="column" flexGrow={1}>
          <InfoRow label="Model" value={model} width={infoWidth} />
          <InfoRow label="Session" value={session?.id.slice(0, 8) ?? 'new'} width={infoWidth} />
          <InfoRow label="Project" value={project} width={infoWidth} />
          <InfoRow label="Tokens" value={`${(totalTokens / 1000).toFixed(1)}K  ctx ${ctxPercent}%`} width={infoWidth} />
          <InfoRow label="MCP" value={mcpText} width={infoWidth} />
          {!runtime.isConfigured ? (
            <Box marginTop={1}>
              <Text color="yellow">LLM not configured: set ORION_CODE_API_KEY</Text>
            </Box>
          ) : null}
        </Box>
      </Box>
    </Box>
  );
}
