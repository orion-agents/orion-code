import { homedir } from 'os';
import stringWidth from 'string-width';

export interface TuiStartupBannerOptions {
  cwd: string;
  version: string;
  model: string;
  terminalWidth: number;
  suppressColor?: boolean;
}

const RESET_STYLE = '\x1b[0m';
const SKY_BLUE = '\x1b[38;2;88;190;255m';
const DIM = '\x1b[2m';

/**
 * Render the startup banner as plain text. The earlier left-side icon (a pixel
 * galaxy badge or an inline PNG) was removed; the banner is now just the
 * startup details, which keeps it legible in every terminal and width.
 */
export function renderTuiStartupBanner(options: TuiStartupBannerOptions): string {
  const terminalWidth = Math.max(1, Math.floor(options.terminalWidth));
  const suppressColor = options.suppressColor ?? false;
  const lines = startupLines(options).map((line, index) =>
    styleBannerLine(truncateCells(line, Math.max(1, terminalWidth - 1)), index, suppressColor)
  );
  return lines.map(line => `\r${line}\n`).join('');
}

function startupLines(options: TuiStartupBannerOptions): string[] {
  return [
    'ORION CODE | 猎户座',
    `v${options.version}  model ${options.model}`,
    `project ${shortenHomePath(options.cwd)}`,
    '/ commands   @ files   ? shortcuts   Ctrl+O tools',
    'Ctrl+C twice exits',
  ];
}

function styleBannerLine(line: string, index: number, suppressColor: boolean): string {
  if (suppressColor) return line;
  return index === 0 ? `${SKY_BLUE}\x1b[1m${line}${RESET_STYLE}` : `${DIM}${line}${RESET_STYLE}`;
}

function shortenHomePath(path: string): string {
  const home = homedir();
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function truncateCells(value: string, maxWidth: number): string {
  if (stringWidth(value) <= maxWidth) return value;
  if (maxWidth <= 1) return '…'.slice(0, maxWidth);

  let result = '';
  for (const character of Array.from(value)) {
    if (stringWidth(`${result}${character}…`) > maxWidth) break;
    result += character;
  }
  return `${result}…`;
}
