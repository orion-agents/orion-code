import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import stringWidth from 'string-width';

export type TerminalImageProtocol = 'kitty' | 'iterm2' | 'none';

export interface TerminalImageDetectionOptions {
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
}

export interface TuiStartupBannerOptions {
  cwd: string;
  version: string;
  model: string;
  terminalWidth: number;
  protocol: TerminalImageProtocol;
  image?: Buffer | null;
  suppressColor?: boolean;
}

const SAVE_CURSOR = '\x1b7';
const RESTORE_CURSOR = '\x1b8';
const RESET_STYLE = '\x1b[0m';
const BRIGHT_CYAN = '\x1b[38;2;125;211;252m';
const SKY_BLUE = '\x1b[38;2;88;190;255m';
const DEEP_BLUE = '\x1b[38;2;30;120;190m';
const DIM = '\x1b[2m';
const ICON_COLUMNS = 10;
const ICON_ROWS = 5;
const ICON_GAP = 2;
const MIN_IMAGE_BANNER_WIDTH = 40;
const MIN_PIXEL_BANNER_WIDTH = 64;
// Terminal cells are roughly twice as tall as they are wide. The compact 25 × 7
// frame leaves room for a fuller OC mark without becoming an oversized banner.
const PIXEL_BADGE_LINES = [
  '╭───────────────────────╮',
  '│ ✦   ·   ▒▓▓▓▓▒ ▒▓▓▓▓▒ │',
  '│  ╲ ✦    ▓░░░░▓ ▓░░░░  │',
  '│✦─✦─✦    ▓░░░░▓ ▓░░░░  │',
  '│  ╱ ✦    ▓░░░░▓ ▓░░░░  │',
  '│ ✦   ·   ▒▓▓▓▓▒ ▒▓▓▓▓▒ │',
  '╰───────────────────────╯',
];
const PIXEL_BADGE_WIDTH = Math.max(...PIXEL_BADGE_LINES.map(line => stringWidth(line)));
const KITTY_IMAGE_ID = 100_000 + (process.pid % 900_000);
const KITTY_CHUNK_SIZE = 4096;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Select the image protocol conservatively. Multiplexers and remote shells
 * require additional passthrough negotiation, so they deliberately use the
 * portable text fallback.
 */
export function detectTerminalImageProtocol(
  options: TerminalImageDetectionOptions = {}
): TerminalImageProtocol {
  const env = options.env ?? process.env;
  if (options.isTTY === false) return 'none';

  const mode = (env.ORION_TUI_IMAGE ?? 'off').trim().toLowerCase();
  if (mode === 'off' || mode === '0' || mode === 'false' || mode === 'none') return 'none';

  if (env.CI || env.TMUX || env.STY || env.SSH_CONNECTION || env.SSH_TTY) return 'none';

  const termProgram = (env.TERM_PROGRAM ?? '').toLowerCase();
  const term = (env.TERM ?? '').toLowerCase();
  if (termProgram === 'apple_terminal') return 'none';

  let detected: TerminalImageProtocol = 'none';
  if (env.ITERM_SESSION_ID || termProgram === 'iterm.app') detected = 'iterm2';
  if (
    env.KITTY_WINDOW_ID ||
    term.includes('kitty') ||
    termProgram.includes('ghostty') ||
    termProgram.includes('wezterm') ||
    termProgram.includes('kitty')
  ) {
    detected = 'kitty';
  }

  // A requested protocol is still compatibility-checked. Emitting Kitty APC
  // or iTerm2 OSC bytes in an unsupported terminal (notably Apple Terminal)
  // can expose the encoded PNG as visible text.
  if (mode === 'kitty') return detected === 'kitty' ? 'kitty' : 'none';
  if (mode === 'iterm2' || mode === 'iterm') {
    return detected === 'iterm2' ? 'iterm2' : 'none';
  }
  return detected;
}

export function resolveTuiIconPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    env.ORION_TUI_ICON,
    resolve(__dirname, '../../assets/orion-tui-icon.png'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find(candidate => existsSync(candidate)) ?? null;
}

export function readTuiIcon(path: string | null): Buffer | null {
  if (!path) return null;
  try {
    const image = readFileSync(path);
    return image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ? image : null;
  } catch {
    return null;
  }
}

export function renderTuiStartupBanner(options: TuiStartupBannerOptions): string {
  const terminalWidth = Math.max(1, Math.floor(options.terminalWidth));
  const image = options.image ?? null;
  const canRenderImage =
    options.protocol !== 'none' && image !== null && terminalWidth >= MIN_IMAGE_BANNER_WIDTH;

  if (!canRenderImage) {
    return renderPortableBanner(options, terminalWidth);
  }

  const contentWidth = Math.max(1, terminalWidth - ICON_COLUMNS - ICON_GAP - 1);
  const lines = startupLines(options).map(line => truncateCells(line, contentWidth));
  const imageSequence =
    options.protocol === 'kitty' ? renderKittyImage(image) : renderIterm2Image(image);
  const rightOffset = ICON_COLUMNS + ICON_GAP;
  const chunks = [SAVE_CURSOR, imageSequence, RESTORE_CURSOR];

  lines.forEach((line, index) => {
    const styled = styleBannerLine(line, index, options.suppressColor ?? false);
    chunks.push(`\r\x1b[${rightOffset}C${styled}\n`);
  });
  for (let row = lines.length; row < ICON_ROWS; row += 1) {
    chunks.push('\r\n');
  }
  return chunks.join('');
}

function renderPortableBanner(options: TuiStartupBannerOptions, terminalWidth: number): string {
  if (terminalWidth >= MIN_PIXEL_BANNER_WIDTH) {
    return renderPixelBanner(options, terminalWidth);
  }

  return startupLines(options)
    .map((line, index) => {
      const styled = styleBannerLine(
        truncateCells(line, Math.max(1, terminalWidth - 1)),
        index,
        options.suppressColor ?? false
      );
      return `\r${styled}\n`;
    })
    .join('');
}

function renderPixelBanner(options: TuiStartupBannerOptions, terminalWidth: number): string {
  const contentWidth = Math.max(1, terminalWidth - PIXEL_BADGE_WIDTH - ICON_GAP - 1);
  const details = startupLines(options).map(line => truncateCells(line, contentWidth));
  const rightLines = ['', ...details, ''];
  const suppressColor = options.suppressColor ?? false;

  return PIXEL_BADGE_LINES.map((badgeLine, index) => {
    const badge = stylePixelBadge(badgeLine, suppressColor);
    const detail = rightLines[index]
      ? styleBannerLine(rightLines[index], index - 1, suppressColor)
      : '';
    return `\r${badge}${' '.repeat(ICON_GAP)}${detail}\n`;
  }).join('');
}

function stylePixelBadge(line: string, suppressColor: boolean): string {
  if (suppressColor) return line;

  let currentColor = '';
  let result = '';
  for (const character of Array.from(line)) {
    const color =
      character === '▓' || character === '✦'
        ? BRIGHT_CYAN
        : character === '░'
          ? DEEP_BLUE
          : SKY_BLUE;
    if (color !== currentColor) {
      result += color;
      currentColor = color;
    }
    result += character;
  }
  return `${result}${RESET_STYLE}`;
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

function renderKittyImage(image: Buffer): string {
  const encoded = image.toString('base64');
  const chunks: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += KITTY_CHUNK_SIZE) {
    const payload = encoded.slice(offset, offset + KITTY_CHUNK_SIZE);
    const more = offset + KITTY_CHUNK_SIZE < encoded.length ? 1 : 0;
    const command =
      offset === 0
        ? `a=T,f=100,t=d,q=2,C=1,i=${KITTY_IMAGE_ID},c=${ICON_COLUMNS},r=${ICON_ROWS},m=${more}`
        : `q=2,m=${more}`;
    chunks.push(`\x1b_G${command};${payload}\x1b\\`);
  }
  return chunks.join('');
}

function renderIterm2Image(image: Buffer): string {
  const encoded = image.toString('base64');
  return `\x1b]1337;File=inline=1;width=${ICON_COLUMNS};height=${ICON_ROWS};preserveAspectRatio=1:${encoded}\x07`;
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
