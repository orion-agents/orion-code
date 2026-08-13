import { homedir } from 'os';
import stringWidth from 'string-width';
import type { TuiThemePreference } from '../services/global-config';
import { sanitizeTerminalText } from '../tui-core/style';
import { pixelHunterSprite } from './pixel-mascot';

export interface TuiStartupBannerOptions {
  cwd: string;
  version: string;
  model: string;
  terminalWidth: number;
  suppressColor?: boolean;
  mascot?: boolean;
  theme?: TuiThemePreference;
}

export interface TuiMascotVisibilityOptions {
  suppressColor?: boolean;
  mascot?: boolean;
  theme?: TuiThemePreference;
}

const RESET_STYLE = '\x1b[0m';
const SKY_BLUE = '\x1b[38;2;88;190;255m';
const DIM = '\x1b[2m';

/**
 * Render the startup banner as safe terminal text. Orion Pixel uses a bounded
 * character-grid hunter on wide terminals and degrades to details-only output
 * for classic, narrow, and color-suppressed environments.
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
  const version = sanitizeBannerField(options.version);
  const model = sanitizeBannerField(options.model);
  const cwd = sanitizeBannerField(shortenHomePath(options.cwd));
  const details = [
    'ORION CODE | 猎户座',
    `v${version}  model ${model}`,
    `project ${cwd}`,
    '/ commands   @ files   ? shortcuts   Ctrl+O tools',
    'Enter steer · Tab queue while working · Ctrl+C twice exits',
  ];
  if (!shouldRenderTuiMascot(options) || options.terminalWidth < 54) {
    return details;
  }
  const sprite = pixelHunterSprite('ready');
  return details.map((line, index) => `${sprite[index] ?? '     '}  ${line}`);
}

function sanitizeBannerField(value: string): string {
  return sanitizeTerminalText(value).replace(/\s+/gu, ' ').trim();
}

/** Keep the brand character optional and textual in accessibility/fallback modes. */
export function shouldRenderTuiMascot(options: TuiMascotVisibilityOptions): boolean {
  return options.mascot !== false && !options.suppressColor && options.theme !== 'classic';
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
