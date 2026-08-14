import { sanitizeTerminalText } from '../../tui-core/style';

/** Sanitize untrusted labels before adding renderer-owned ANSI styling. */
export function sanitizeTerminalLine(text: string): string {
  return sanitizeTerminalText(String(text)).replace(/\n/gu, ' ');
}

export function stripAnsi(text: string): string {
  return sanitizeTerminalText(String(text));
}

export function visualWidth(text: string): number {
  let width = 0;
  for (const ch of stripAnsi(text)) {
    const cp = ch.codePointAt(0) || 0;
    width += isWideCodePoint(cp) ? 2 : 1;
  }
  return width;
}

export function padEndVisible(text: string, targetWidth: number): string {
  const width = visualWidth(text);
  return width >= targetWidth ? text : text + ' '.repeat(targetWidth - width);
}

export function truncateVisible(text: string, targetWidth: number): string {
  if (targetWidth <= 0) return '';
  if (visualWidth(text) <= targetWidth) return text;
  if (targetWidth <= 1) return '…';

  let out = '';
  let width = 0;
  const limit = targetWidth - 1;

  for (const ch of text) {
    const cp = ch.codePointAt(0) || 0;
    const chWidth = isWideCodePoint(cp) ? 2 : 1;
    if (width + chWidth > limit) break;
    out += ch;
    width += chWidth;
  }

  return out + '…';
}

function isWideCodePoint(cp: number): boolean {
  return (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x2fffd) ||
      (cp >= 0x30000 && cp <= 0x3fffd))
  );
}
