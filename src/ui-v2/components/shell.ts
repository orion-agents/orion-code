/**
 * UI v2 visible shell components.
 */

import { basename } from 'path';
import chalk from 'chalk';
import { padEndVisible, truncateVisible, visualWidth } from '../runtime/text';
export {
  renderV2InputFrame,
  renderV2Prompt,
  type V2InputFrameOptions,
  type V2InputFrameRender,
} from '../../ui/shared/input-frame';

const NO_COLOR = process.env.NO_COLOR !== undefined || process.env.TERM === 'dumb';

const colorize = NO_COLOR ? {
  brand: (s: string) => s,
  accent: (s: string) => s,
  dim: (s: string) => s,
  success: (s: string) => s,
  warn: (s: string) => s,
  danger: (s: string) => s,
  label: (s: string) => s,
} : {
  brand: chalk.hex('#FF6B35').bold,
  accent: chalk.hex('#00D4AA'),
  dim: chalk.dim,
  success: chalk.green,
  warn: chalk.yellow,
  danger: chalk.red,
  label: chalk.hex('#94A3B8'),
};

export interface V2ShellHeaderConfig {
  provider: string;
  model: string;
  projectPath: string;
  status: 'ready' | 'loading' | 'error' | 'processing';
  statusText?: string;
  version: string;
  width?: number;
}

export interface V2StatusLineStats {
  model: string;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  ctxPercent: number;
  mcpConnected: number;
  mcpTotal: number;
  sessionId?: string;
  modeText?: string;
  width?: number;
}

export interface V2ShortcutItem {
  key: string;
  label: string;
}

const DEFAULT_SHORTCUTS: V2ShortcutItem[] = [
  { key: '/', label: 'commands' },
  { key: '@', label: 'files' },
  { key: 'Ctrl+R', label: 'history' },
  { key: 'Ctrl+L', label: 'clear view' },
  { key: '?', label: 'shortcuts' },
  { key: 'Ctrl+C', label: 'exit' },
];

export function renderV2ShellHeader(config: V2ShellHeaderConfig): string {
  const width = Math.max(44, config.width || process.stdout.columns || 80);
  const innerWidth = Math.max(24, width - 4);
  const title = `Orion Code v${config.version}`;
  const topFill = Math.max(1, innerWidth - visualWidth(title) - 3);
  const projectName = basename(config.projectPath) || config.projectPath;
  const status = renderStatus(config.status, config.statusText);

  const body = [
    renderToken('model', config.model),
    renderToken('provider', shortProvider(config.provider)),
    renderToken('project', projectName),
    status,
  ].filter(Boolean).join(colorize.dim('  |  '));

  return [
    colorize.dim(`╭─ ${colorize.brand(title)} ${'─'.repeat(topFill)}╮`),
    colorize.dim('│ ') + padEndVisible(truncateVisible(body, innerWidth - 2), innerWidth - 2) + colorize.dim(' │'),
    colorize.dim(`╰${'─'.repeat(innerWidth)}╯`),
  ].join('\n');
}

export function renderV2StatusBadge(stats: V2StatusLineStats): string {
  const width = Math.max(20, stats.width || process.stdout.columns || 80);
  const parts = buildStatusParts(stats).join(colorize.dim('  '));
  return truncateVisible(parts, Math.max(1, width));
}

export function renderV2StatusLine(stats: V2StatusLineStats): string {
  const width = Math.max(44, stats.width || process.stdout.columns || 80);
  const content = buildStatusParts(stats).join(colorize.dim('  '));
  return colorize.dim('  ') + truncateVisible(content, Math.max(1, width - 2));
}

function buildStatusParts(stats: V2StatusLineStats): string[] {
  return [
    renderToken('model', stats.model),
    stats.sessionId ? renderToken('session', stats.sessionId.slice(0, 8)) : '',
    renderToken('tokens', formatTokens(stats.tokens)),
    stats.ctxPercent > 0 ? renderToken('ctx', `${stats.ctxPercent}%`) : '',
    stats.mcpTotal > 0 ? renderToken('mcp', `${stats.mcpConnected}/${stats.mcpTotal}`) : '',
    stats.modeText ? renderToken('mode', stats.modeText) : '',
  ].filter(Boolean);
}

export function renderV2FooterHint(width: number = process.stdout.columns || 80): string {
  const text = DEFAULT_SHORTCUTS
    .slice(0, 5)
    .map(item => `${colorize.accent(item.key)} ${colorize.label(item.label)}`)
    .join(colorize.dim('   '));
  return colorize.dim('  ') + truncateVisible(text, Math.max(1, width - 2));
}

export function renderV2Shortcuts(width: number = process.stdout.columns || 80): string {
  const innerWidth = Math.max(36, Math.min(width - 4, 72));
  const title = 'Shortcuts';
  const titleFill = Math.max(1, innerWidth - visualWidth(title) - 3);
  const rows = DEFAULT_SHORTCUTS.map(item => {
    const key = padEndVisible(item.key, 8);
    const content = `${colorize.accent(key)} ${colorize.label(item.label)}`;
    return colorize.dim('│ ') + padEndVisible(truncateVisible(content, innerWidth - 2), innerWidth - 2) + colorize.dim(' │');
  });

  return [
    colorize.dim(`┌─ ${title} ${'─'.repeat(titleFill)}┐`),
    ...rows,
    colorize.dim(`└${'─'.repeat(innerWidth)}┘`),
  ].join('\n');
}

function renderStatus(status: V2ShellHeaderConfig['status'], text?: string): string {
  const dot = status === 'ready'
    ? colorize.success('●')
    : status === 'loading'
      ? colorize.warn('●')
      : status === 'error'
        ? colorize.danger('●')
        : colorize.accent('●');
  return `${dot} ${colorize.label(text || status)}`;
}

function renderToken(label: string, value: string): string {
  return `${colorize.label(label)}=${colorize.accent(value)}`;
}

function shortProvider(provider: string): string {
  return provider === 'Alibaba Cloud' ? 'Qwen' : provider;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return String(tokens);
}
