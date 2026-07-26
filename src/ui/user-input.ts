/**
 * User input echo styling.
 *
 * Terminals do not support real alpha transparency, so this uses a pre-blended
 * neutral gray background that reads like a translucent overlay on dark themes.
 */

const INPUT_BG = [56, 56, 56] as const;
const INPUT_FG = [226, 232, 240] as const;
const DEFAULT_TERMINAL_WIDTH = 80;
const CONTENT_PADDING = 2;

function colorsDisabled(): boolean {
  return process.env.NO_COLOR !== undefined || process.env.TERM === 'dumb';
}

function fg([r, g, b]: readonly [number, number, number]): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

function bg([r, g, b]: readonly [number, number, number]): string {
  return `\x1b[48;2;${r};${g};${b}m`;
}

function style(text: string, foreground: readonly [number, number, number]): string {
  if (colorsDisabled()) {
    return text;
  }
  return `${bg(INPUT_BG)}${fg(foreground)}${text}\x1b[39;49m`;
}

function visualWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) || 0;
    width += (cp >= 0x1100 && (
      cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x2fffd) ||
      (cp >= 0x30000 && cp <= 0x3fffd)
    )) ? 2 : 1;
  }
  return width;
}

export function renderUserInputPrompt(): string {
  return '';
}

export function renderUserInputContent(text: string, width?: number): string {
  const terminalWidth = Math.max(1, width || process.stdout.columns || DEFAULT_TERMINAL_WIDTH);
  const targetWidth = Math.max(CONTENT_PADDING, terminalWidth);
  const visibleWidth = CONTENT_PADDING + visualWidth(text);
  const fill = Math.max(0, targetWidth - visibleWidth);
  return style(` ${text}${' '.repeat(fill)} `, INPUT_FG);
}

export function renderUserInputEcho(input: string, width?: number): string {
  return input
    .split('\n')
    .map(line => renderUserInputPrompt() + renderUserInputContent(line, width))
    .join('\n');
}

export function renderUserInputEchoFrame(input: string, width?: number): string {
  // Kept for compatibility with older framed-input callers. Submitted input
  // should read as conversation content, not as a bordered live input frame.
  return renderUserInputEcho(input, width);
}
