/**
 * TUI style model: normalized, renderer-independent text styling.
 *
 * Styles are semantic tokens resolved by theme at layout time; ANSI SGR
 * codes are only emitted by the terminal row encoder. Layout never writes
 * raw escape sequences.
 *
 * NO_COLOR / FORCE_COLOR are respected at the encoder level - style
 * fields are preserved in the model but color output is suppressed.
 */

export type TuiColor =
  | { kind: 'named'; value: 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white' }
  | { kind: 'indexed'; value: number }
  | { kind: 'rgb'; r: number; g: number; b: number };

export interface TuiStyle {
  foreground?: TuiColor;
  background?: TuiColor;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

/** Shared immutable default style (no formatting). */
export const DEFAULT_STYLE: TuiStyle = {};

/**
 * Normalize a style: remove undefined/false fields, clamp indexed/rgb values.
 * Returns a new frozen object. Used for frame diff comparison.
 */
export function normalizeStyle(style: TuiStyle): TuiStyle {
  const result: TuiStyle = {};

  if (style.foreground) {
    result.foreground = normalizeColor(style.foreground);
  }
  if (style.background) {
    result.background = normalizeColor(style.background);
  }
  if (style.bold) result.bold = true;
  if (style.dim) result.dim = true;
  if (style.italic) result.italic = true;
  if (style.underline) result.underline = true;
  if (style.inverse) result.inverse = true;

  return result;
}

function normalizeColor(color: TuiColor): TuiColor {
  switch (color.kind) {
    case 'named':
      return color;
    case 'indexed':
      return { kind: 'indexed', value: Math.max(0, Math.min(255, Math.floor(color.value))) };
    case 'rgb':
      return {
        kind: 'rgb',
        r: Math.max(0, Math.min(255, Math.floor(color.r))),
        g: Math.max(0, Math.min(255, Math.floor(color.g))),
        b: Math.max(0, Math.min(255, Math.floor(color.b))),
      };
  }
}

/**
 * Compute a stable string key for style comparison.
 * Used in frame diff to detect style-only changes efficiently.
 */
export function styleKey(style: TuiStyle): string {
  const parts: string[] = [];
  if (style.foreground) parts.push(`fg:${colorKey(style.foreground)}`);
  if (style.background) parts.push(`bg:${colorKey(style.background)}`);
  if (style.bold) parts.push('b');
  if (style.dim) parts.push('d');
  if (style.italic) parts.push('i');
  if (style.underline) parts.push('u');
  if (style.inverse) parts.push('v');
  return parts.join(',');
}

function colorKey(color: TuiColor): string {
  switch (color.kind) {
    case 'named': return color.value;
    case 'indexed': return `i${color.value}`;
    case 'rgb': return `r${color.r}.${color.g}.${color.b}`;
  }
}

/**
 * Check if two styles are equivalent after normalization.
 */
export function stylesEqual(a: TuiStyle, b: TuiStyle): boolean {
  return styleKey(normalizeStyle(a)) === styleKey(normalizeStyle(b));
}

// ============================================================================
// Semantic theme tokens (layout uses these; encoder resolves to SGR)
// ============================================================================

export interface TuiTheme {
  assistantText: TuiStyle;
  heading: TuiStyle;
  code: TuiStyle;
  diffAdded: TuiStyle;
  diffRemoved: TuiStyle;
  diffHunk: TuiStyle;
  warning: TuiStyle;
  error: TuiStyle;
  activityRunning: TuiStyle;
  activitySuccess: TuiStyle;
  activityFailed: TuiStyle;
  muted: TuiStyle;
  /** Optional additions keep themes authored against the original contract valid. */
  userMarker?: TuiStyle;
  userText?: TuiStyle;
  userBackground?: TuiStyle;
  inlineCode?: TuiStyle;
  link?: TuiStyle;
  toolRunning?: TuiStyle;
  toolSuccess?: TuiStyle;
  toolError?: TuiStyle;
  toolSkipped?: TuiStyle;
  toolName?: TuiStyle;
  toolMeta?: TuiStyle;
  systemText?: TuiStyle;
  commandMarker?: TuiStyle;
  commandText?: TuiStyle;
  statusText?: TuiStyle;
}

/** Default dark-theme semantic tokens. */
export const DEFAULT_THEME: TuiTheme = {
  assistantText: {},
  heading: { foreground: { kind: 'named', value: 'cyan' }, bold: true },
  code: {
    foreground: { kind: 'named', value: 'white' },
    background: { kind: 'rgb', r: 31, g: 35, b: 42 },
  },
  diffAdded: { foreground: { kind: 'named', value: 'green' } },
  diffRemoved: { foreground: { kind: 'named', value: 'red' } },
  diffHunk: { foreground: { kind: 'named', value: 'cyan' }, dim: true },
  warning: { foreground: { kind: 'named', value: 'yellow' } },
  error: { foreground: { kind: 'named', value: 'red' } },
  activityRunning: { foreground: { kind: 'named', value: 'yellow' } },
  activitySuccess: { foreground: { kind: 'named', value: 'green' } },
  activityFailed: { foreground: { kind: 'named', value: 'red' } },
  muted: { dim: true },
  userMarker: { foreground: { kind: 'rgb', r: 0, g: 96, b: 116 }, bold: true },
  userText: { foreground: { kind: 'rgb', r: 32, g: 35, b: 40 } },
  userBackground: { background: { kind: 'rgb', r: 218, g: 221, b: 226 } },
  inlineCode: {
    foreground: { kind: 'named', value: 'yellow' },
    background: { kind: 'rgb', r: 43, g: 47, b: 54 },
  },
  link: { foreground: { kind: 'named', value: 'cyan' }, underline: true },
  toolRunning: { foreground: { kind: 'named', value: 'yellow' } },
  toolSuccess: { foreground: { kind: 'named', value: 'green' } },
  toolError: { foreground: { kind: 'named', value: 'red' } },
  toolSkipped: { dim: true },
  toolName: { foreground: { kind: 'named', value: 'cyan' }, bold: true },
  toolMeta: { foreground: { kind: 'named', value: 'white' }, dim: true },
  systemText: { foreground: { kind: 'named', value: 'white' }, dim: true },
  commandMarker: { foreground: { kind: 'named', value: 'cyan' }, bold: true },
  commandText: { foreground: { kind: 'named', value: 'white' } },
  statusText: { dim: true },
};

// ============================================================================
// ANSI SGR encoder
// ============================================================================

/** Check if NO_COLOR is set or output is not a TTY. */
export function shouldSuppressColor(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return true;
  if (process.env.FORCE_COLOR === '0') return true;
  return false;
}

/**
 * Encode a TuiStyle into ANSI SGR parameters.
 * Returns an empty string if style is default or color is suppressed.
 * Row encoder must emit SGR0 (\x1b[0m) after each styled span.
 */
export function encodeStyleToSgr(style: TuiStyle, suppressColor = shouldSuppressColor()): string {
  const norm = normalizeStyle(style);
  const params: string[] = [];

  if (norm.bold) params.push('1');
  if (norm.dim) params.push('2');
  if (norm.italic) params.push('3');
  if (norm.underline) params.push('4');
  if (norm.inverse) params.push('7');

  if (!suppressColor) {
    if (norm.foreground) params.push(...encodeColorSgr(norm.foreground, '3', '38'));
    if (norm.background) params.push(...encodeColorSgr(norm.background, '4', '48'));
  }

  if (params.length === 0) return '';
  return `\x1b[${params.join(';')}m`;
}

function encodeColorSgr(color: TuiColor, baseSingle: string, baseExtended: string): string[] {
  switch (color.kind) {
    case 'named': {
      const map: Record<string, number> = {
        black: 0, red: 1, green: 2, yellow: 3,
        blue: 4, magenta: 5, cyan: 6, white: 7,
      };
      const code = map[color.value];
      if (code === undefined) return [];
      const base = parseInt(baseSingle, 10) * 10;
      return [`${base + code}`];
    }
    case 'indexed':
      return [`${baseExtended};5;${color.value}`];
    case 'rgb':
      return [`${baseExtended};2;${color.r};${color.g};${color.b}`];
  }
}

/** SGR reset sequence. */
export const SGR_RESET = '\x1b[0m';

// ============================================================================
// Styled span model
// ============================================================================

export interface StyledSpan {
  text: string;
  style: TuiStyle;
}

export type StyledRow = StyledSpan[];

// ============================================================================
// Sanitizer
// ============================================================================

/**
 * Sanitize text for terminal display.
 *
 * Strips entire ANSI escape sequences (CSI, OSC, etc.) and all C0/C1 control
 * characters except \n and \t. Tab is expanded to spaces before entering layout.
 * This prevents model content from injecting ANSI control sequences.
 */
export function sanitizeTerminalText(text: string, tabWidth = 2): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    const codePoint = text.codePointAt(i);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);

    // ESC (0x1b): strip the entire escape sequence that follows.
    if (codePoint === 0x1b) {
      i = skipEscapeSequence(text, i + 1);
      continue;
    }

    if (char === '\n') {
      result += '\n';
    } else if (char === '\t') {
      result += ' '.repeat(tabWidth);
    } else if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) {
      // C0/C1 control: strip. This includes DEL (0x7f).
    } else {
      result += char;
    }

    i += char.length;
  }
  return result;
}

/**
 * Skip past an ANSI escape sequence body starting after the ESC byte.
 * CSI: ESC [ params final-byte (0x40-0x7e)
 * OSC: ESC ] data ST (BEL 0x07 or ESC backslash)
 * Other: ESC + single intermediate/final byte
 * Returns the index after the consumed sequence.
 */
function skipEscapeSequence(text: string, start: number): number {
  if (start >= text.length) return start;
  const next = text.charCodeAt(start);

  if (next === 0x5b) {
    // CSI: ESC [ - consume params until final byte (0x40-0x7e).
    let i = start + 1;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c >= 0x40 && c <= 0x7e) return i + 1;
      i += 1;
    }
    return i;
  }

  if (next === 0x5d) {
    // OSC: ESC ] - consume until BEL (0x07) or ST (ESC backslash).
    let i = start + 1;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 0x07) return i + 1;
      if (c === 0x1b && i + 1 < text.length && text.charCodeAt(i + 1) === 0x5c) return i + 2;
      i += 1;
    }
    return i;
  }

  // Other escape (e.g. ESC =, ESC >): consume one byte.
  return start + 1;
}
