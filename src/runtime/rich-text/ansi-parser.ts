/**
 * Lightweight ANSI SGR-to-StyledSpan parser.
 *
 * Converts tool output containing basic SGR colour/style codes into StyledSpan[]
 * for the rich-text layout engine, while stripping all other escape sequences
 * (cursor movement, erase, absolute positioning, etc.) that would corrupt the
 * TUI frame model.
 *
 * This is intentionally NOT a full terminal emulator. It only handles the
 * subset of SGR codes that external tools (jest, eslint, compilers) commonly
 * emit:
 *
 *   - SGR reset (0)
 *   - bold (1), dim (2)
 *   - foreground colours (30-37)
 *   - background colours (40-47)
 *   - bright foreground (90-97)
 *
 * All other escape sequences are discarded.
 */

import {
  normalizeStyle,
  type StyledSpan,
  type TuiStyle,
  type TuiColor,
} from '../../tui-core/style';

// --- Public API ---

export interface AnsiParserResult {
  spans: StyledSpan[];
}

/**
 * Parse tool output that may contain ANSI SGR escape codes into styled spans.
 * Non-SGR escape sequences (cursor movement, clear screen, etc.) are stripped.
 * Plain text between SGR codes is emitted with the current style.
 */
export function parseAnsiToStyledSpans(rawText: string): StyledSpan[] {
  const spans: StyledSpan[] = [];
  const text = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let current = '';
  let style: TuiStyle = {};
  let i = 0;

  const flush = () => {
    if (current.length > 0) {
      spans.push({ text: current, style });
      current = '';
    }
  };

  while (i < text.length) {
    const codePoint = text.codePointAt(i);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);

    if (codePoint === 0x1b) {
      // ESC found — try to parse the escape sequence
      const parsed = tryParseSgrSequence(text, i);
      if (parsed) {
        flush();
        style = applySgrChange(style, parsed.change);
        i = parsed.nextIndex;
        continue;
      }
      // Not a recognised SGR sequence — skip the entire escape sequence
      flush();
      style = {}; // reset on unknown escape to avoid stale colour
      i = skipEscapeSequence(text, i + 1);
      continue;
    }

    // C0 control characters other than \n are stripped.
    if (codePoint < 0x20 && codePoint !== 0x0a) {
      i += 1;
      continue;
    }

    current += char;
    i += char.length;
  }

  flush();
  return spans;
}

// --- Internal helpers ---

/**
 * A parsed SGR change. Distinguishes:
 *  - reset (code 0): clear everything
 *  - clearFg (code 39): clear foreground only
 *  - clearBg (code 49): clear background only
 *  - set: fields to set/override
 *
 * This separation is necessary because `foreground: undefined` alone cannot
 * distinguish "clear foreground" from "don't touch foreground".
 */
interface SgrChange {
  reset?: boolean;
  clearFg?: boolean;
  clearBg?: boolean;
  set?: TuiStyle;
}

interface ParsedSgr {
  change: SgrChange;
  nextIndex: number;
}

function tryParseSgrSequence(text: string, escIndex: number): ParsedSgr | null {
  const next = text.codePointAt(escIndex + 1);
  if (next !== 0x5b) return null; // 0x5b = '['

  // Find the terminator (0x40–0x7e: @–~)
  let end = escIndex + 2;
  while (end < text.length) {
    const cp = text.codePointAt(end);
    if (cp === undefined) break;
    if (cp >= 0x40 && cp <= 0x7e) {
      const params = text.slice(escIndex + 2, end + 1); // include terminator
      const change = parseSgrParams(params);
      if (change === null) return null; // not an SGR sequence
      return { change, nextIndex: end + 1 };
    }
    end += 1;
  }

  return null; // unterminated
}

/**
 * Parse SGR parameters (the portion between `\x1b[` and `m`).
 * Returns null if the final character is not 'm' (not an SGR sequence).
 */
function parseSgrParams(params: string): SgrChange | null {
  if (params.length === 0) return null; // CSI without params
  const final = params.codePointAt(params.length - 1);
  if (final !== 0x6d) return null; // not ending with 'm'

  const body = params.slice(0, -1);
  const codes = body === '' ? [0] : body.split(';').map(c => parseInt(c, 10));
  if (codes.every(isNaN)) return null;

  const change: SgrChange = { set: {} };
  let hasAny = false;
  for (const code of codes) {
    if (isNaN(code)) continue;
    hasAny = true;
    switch (code) {
      case 0:
        change.reset = true;
        change.clearFg = false;
        change.clearBg = false;
        change.set = {};
        break;
      case 1:  change.set = { ...change.set, bold: true }; break;
      case 2:  change.set = { ...change.set, dim: true }; break;
      case 30: setForeground(change, named('black')); break;
      case 31: setForeground(change, named('red')); break;
      case 32: setForeground(change, named('green')); break;
      case 33: setForeground(change, named('yellow')); break;
      case 34: setForeground(change, named('blue')); break;
      case 35: setForeground(change, named('magenta')); break;
      case 36: setForeground(change, named('cyan')); break;
      case 37: setForeground(change, named('white')); break;
      case 39: clearForeground(change); break;
      case 40: setBackground(change, named('black')); break;
      case 41: setBackground(change, named('red')); break;
      case 42: setBackground(change, named('green')); break;
      case 43: setBackground(change, named('yellow')); break;
      case 44: setBackground(change, named('blue')); break;
      case 45: setBackground(change, named('magenta')); break;
      case 46: setBackground(change, named('cyan')); break;
      case 47: setBackground(change, named('white')); break;
      case 49: clearBackground(change); break;
      // 90-97: bright foreground colours. Bright ≠ bold (separate SGR attrs).
      case 90: setForeground(change, named('black')); break;
      case 91: setForeground(change, named('red')); break;
      case 92: setForeground(change, named('green')); break;
      case 93: setForeground(change, named('yellow')); break;
      case 94: setForeground(change, named('blue')); break;
      case 95: setForeground(change, named('magenta')); break;
      case 96: setForeground(change, named('cyan')); break;
      case 97: setForeground(change, named('white')); break;
      // Unrecognised SGR codes are ignored (they are still valid SGR).
      default: break;
    }
  }
  if (!hasAny) return null;
  return change;
}

const VALID_NAMED_COLORS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;
type NamedColorValue = typeof VALID_NAMED_COLORS[number];

function named(name: string): TuiColor {
  // The SGR code mapping only produces valid named colors, but guard anyway.
  const value = VALID_NAMED_COLORS.includes(name as NamedColorValue)
    ? (name as NamedColorValue)
    : 'white';
  return { kind: 'named', value };
}

function setForeground(change: SgrChange, color: TuiColor): void {
  change.clearFg = false;
  change.set = { ...change.set, foreground: color };
}

function clearForeground(change: SgrChange): void {
  change.clearFg = true;
  if (!change.set) return;
  const rest = { ...change.set };
  delete rest.foreground;
  change.set = rest;
}

function setBackground(change: SgrChange, color: TuiColor): void {
  change.clearBg = false;
  change.set = { ...change.set, background: color };
}

function clearBackground(change: SgrChange): void {
  change.clearBg = true;
  if (!change.set) return;
  const rest = { ...change.set };
  delete rest.background;
  change.set = rest;
}

/** Apply a parsed SGR change on top of the current style. */
function applySgrChange(current: TuiStyle, change: SgrChange): TuiStyle {
  let result = change.reset ? {} : current;
  if (change.clearFg) {
    result = { ...result, foreground: undefined };
  }
  if (change.clearBg) {
    result = { ...result, background: undefined };
  }
  if (change.set) {
    const set = change.set;
    result = {
      foreground: set.foreground !== undefined ? set.foreground : result.foreground,
      background: set.background !== undefined ? set.background : result.background,
      bold: set.bold !== undefined ? set.bold : result.bold,
      dim: set.dim !== undefined ? set.dim : result.dim,
    };
  }
  return normalizeStyle(result);
}

/**
 * Skip past an escape sequence starting from the character after ESC.
 * We only skip known SGR/CUP/ED/EL/etc sequences; for unknown sequences
 * we skip to the next printable character as a safety measure.
 */
function skipEscapeSequence(text: string, index: number): number {
  // For CSI sequences (starting with '['), skip past all parameter bytes
  // (0x30-0x3f) and intermediate bytes (0x20-0x2f) until the terminator.
  let i = index;
  if (i < text.length && text.codePointAt(i) === 0x5b) {
    // CSI sequence: skip '[' and all parameter/intermediate bytes
    i += 1;
    while (i < text.length) {
      const cp = text.codePointAt(i);
      if (cp === undefined) break;
      if (cp >= 0x30 && cp <= 0x3f) { i += 1; continue; } // parameter byte
      if (cp >= 0x20 && cp <= 0x2f) { i += 1; continue; } // intermediate byte
      if (cp >= 0x40 && cp <= 0x7e) { return i + 1; }     // final byte
      break; // not a valid CSI byte — bail out
    }
    return text.length;
  }

  // Non-CSI escape: skip until terminator or end of string.
  while (i < text.length) {
    const cp = text.codePointAt(i);
    if (cp === undefined) break;
    if (cp >= 0x40 && cp <= 0x7e) return i + 1;
    if (cp < 0x20 || cp > 0x7e) return i;
    i += 1;
  }
  return text.length;
}
