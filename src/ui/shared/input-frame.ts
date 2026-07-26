import chalk from 'chalk';
import { truncateVisible, visualWidth } from './text';

const NO_COLOR = process.env.NO_COLOR !== undefined || process.env.TERM === 'dumb';

const colorize = NO_COLOR ? {
  accent: (s: string) => s,
  dim: (s: string) => s,
} : {
  accent: chalk.hex('#00D4AA'),
  dim: chalk.dim,
};

const INPUT_BG = '\x1b[48;2;56;56;56m';
const INPUT_FG = '\x1b[38;2;226;232;240m';
const RESET_COLORS = '\x1b[39;49m';
const CLEAR_TO_EOL = '\x1b[K';

export interface FramedInputFrameOptions {
  input: string;
  modeIndicator?: string;
  width?: number;
  statusText?: string;
}

export interface FramedInputFrameRender {
  output: string;
  height: number;
  cursorRow: number;
  cursorColumn: number;
}

export type V2InputFrameOptions = FramedInputFrameOptions;
export type V2InputFrameRender = FramedInputFrameRender;

export function renderFramedPrompt(modeIndicator: string = ''): string {
  const mode = modeIndicator ? colorize.dim(`${modeIndicator} `) : '';
  return `${colorize.accent('›')} ${mode}`;
}

export function renderFramedInputFrame(options: FramedInputFrameOptions): FramedInputFrameRender {
  const width = Math.max(24, options.width || process.stdout.columns || 80);
  const inputWidth = Math.max(1, width - 1);
  const logicalLines = options.input.length > 0 ? options.input.split('\n') : [''];
  const firstPrompt = renderFramedPrompt(options.modeIndicator || '');
  const continuationPrompt = ' '.repeat(visualWidth(firstPrompt));

  const renderedLines = logicalLines.map((line, index) => {
    const prefix = index === 0 ? firstPrompt : continuationPrompt;
    return renderInputLine(truncateVisible(prefix + line, inputWidth));
  });
  const statusLine = options.statusText ? renderInputStatusLine(inputWidth, options.statusText) : undefined;

  const rowSpans = logicalLines.map((line, index) => {
    const prefix = index === 0 ? firstPrompt : continuationPrompt;
    return terminalRowsFor(visualWidth(prefix) + visualWidth(line), width);
  });
  const rowsBeforeCursor = rowSpans.slice(0, -1).reduce((sum, rows) => sum + rows, 0);
  const lastLine = logicalLines[logicalLines.length - 1] || '';
  const lastPrefix = logicalLines.length === 1 ? firstPrompt : continuationPrompt;
  const lastVisibleWidth = visualWidth(lastPrefix) + visualWidth(lastLine);

  return {
    output: [...renderedLines, ...(statusLine ? [statusLine] : [])].join('\n'),
    height: rowSpans.reduce((sum, rows) => sum + rows, 0) + (statusLine ? 1 : 0),
    cursorRow: rowsBeforeCursor + Math.floor(lastVisibleWidth / width),
    cursorColumn: (lastVisibleWidth % width) + 1,
  };
}

export const renderV2Prompt = renderFramedPrompt;
export const renderV2InputFrame = renderFramedInputFrame;

function renderInputLine(content: string): string {
  if (NO_COLOR) {
    return content;
  }

  return `${INPUT_BG}${INPUT_FG}${content}${CLEAR_TO_EOL}${RESET_COLORS}`;
}

function renderInputStatusLine(width: number, statusText: string): string {
  const badge = ` ${statusText} `;
  const badgeWidth = visualWidth(badge);
  if (badgeWidth >= width) {
    return truncateVisible(badge, width);
  }

  return ' '.repeat(width - badgeWidth) + badge;
}

function terminalRowsFor(visibleWidth: number, terminalWidth: number): number {
  if (visibleWidth <= 0) return 1;
  return Math.floor(visibleWidth / terminalWidth) + 1;
}
