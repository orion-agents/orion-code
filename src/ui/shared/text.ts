const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
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
  return cp >= 0x1100 && (
    cp <= 0x115F || cp === 0x2329 || cp === 0x232A ||
    (cp >= 0x2E80 && cp <= 0xA4CF && cp !== 0x303F) ||
    (cp >= 0xAC00 && cp <= 0xD7A3) ||
    (cp >= 0xF900 && cp <= 0xFAFF) ||
    (cp >= 0xFE10 && cp <= 0xFE19) ||
    (cp >= 0xFE30 && cp <= 0xFE6F) ||
    (cp >= 0xFF01 && cp <= 0xFF60) ||
    (cp >= 0xFFE0 && cp <= 0xFFE6) ||
    (cp >= 0x20000 && cp <= 0x2FFFD) ||
    (cp >= 0x30000 && cp <= 0x3FFFD)
  );
}
