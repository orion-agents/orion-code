import stringWidth from 'string-width';
import { DEFAULT_STYLE, normalizeStyle, styleKey, type TuiStyle } from './style';

export interface TuiCursor {
  row: number;
  column: number;
  visible: boolean;
}

export interface TuiCell {
  char: string;
  width: 0 | 1 | 2;
  /** Normalized style. Defaults to DEFAULT_STYLE (shared immutable). */
  style: TuiStyle;
}

export interface TuiFrame {
  width: number;
  height: number;
  rows: TuiCell[][];
  cursor: TuiCursor;
}

export interface TuiFrameDiff {
  changedRows: number[];
  cursorChanged: boolean;
}

export function createTuiFrame(width: number, height: number): TuiFrame {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  return {
    width: safeWidth,
    height: safeHeight,
    rows: Array.from({ length: safeHeight }, () => createEmptyRow(safeWidth)),
    cursor: { row: 0, column: 0, visible: true },
  };
}

export function writeFrameText(frame: TuiFrame, row: number, column: number, text: string, style: TuiStyle = DEFAULT_STYLE): void {
  let y = clamp(row, 0, frame.height - 1);
  let x = clamp(column, 0, frame.width - 1);
  const normalizedStyle = style === DEFAULT_STYLE ? DEFAULT_STYLE : normalizeStyle(style);

  for (const char of segmentText(text)) {
    if (char === '\n') {
      y += 1;
      x = clamp(column, 0, frame.width - 1);
      if (y >= frame.height) break;
      continue;
    }

    const width = charWidth(char);
    if (width === 0) continue;
    if (x + width > frame.width) {
      y += 1;
      x = 0;
      if (y >= frame.height) break;
    }

    frame.rows[y][x] = { char, width, style: normalizedStyle };
    if (width === 2 && x + 1 < frame.width) {
      // Continuation cell inherits style but does not output the char.
      frame.rows[y][x + 1] = { char: '', width: 0, style: normalizedStyle };
    }
    x += width;
  }
}

export function setFrameCursor(frame: TuiFrame, row: number, column: number, visible = true): void {
  frame.cursor = {
    row: clamp(row, 0, frame.height - 1),
    column: clamp(column, 0, frame.width - 1),
    visible,
  };
}

export function renderFrameRows(frame: TuiFrame): string[] {
  return frame.rows.map(row => row
    .map(cell => cell.width === 0 ? '' : cell.char)
    .join(''));
}

export function diffTuiFrames(previous: TuiFrame | null, next: TuiFrame): TuiFrameDiff {
  if (!previous || previous.width !== next.width || previous.height !== next.height) {
    return {
      changedRows: Array.from({ length: next.height }, (_, index) => index),
      cursorChanged: true,
    };
  }

  // Compare char + width + style key per cell so style-only changes are detected.
  const changedRows: number[] = [];
  for (let index = 0; index < next.height; index += 1) {
    if (rowsDifferent(previous.rows[index], next.rows[index])) {
      changedRows.push(index);
    }
  }

  return {
    changedRows,
    cursorChanged:
      previous.cursor.row !== next.cursor.row
      || previous.cursor.column !== next.cursor.column
      || previous.cursor.visible !== next.cursor.visible,
  };
}

function rowsDifferent(prev: TuiCell[], next: TuiCell[]): boolean {
  if (prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (a.char !== b.char || a.width !== b.width) return true;
    if (styleKey(a.style) !== styleKey(b.style)) return true;
  }
  return false;
}

function createEmptyRow(width: number): TuiCell[] {
  return Array.from({ length: width }, () => ({ char: ' ', width: 1 as const, style: DEFAULT_STYLE }));
}

function charWidth(char: string): 0 | 1 | 2 {
  const width = stringWidth(char);
  return width <= 0 ? 0 : width >= 2 ? 2 : 1;
}

function segmentText(text: string): string[] {
  const segmenter = getSegmenter();
  if (segmenter) {
    return Array.from(segmenter.segment(text), part => part.segment);
  }
  return Array.from(text);
}

function getSegmenter(): { segment: (text: string) => Iterable<{ segment: string }> } | null {
  const Segmenter = (Intl as any).Segmenter;
  return Segmenter ? new Segmenter(undefined, { granularity: 'grapheme' }) : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

// ============================================================================
// Styled row rendering
// ============================================================================

/**
 * Render a single frame row into styled spans by merging consecutive cells
 * with the same style key. Continuation cells (width 0) are skipped.
 * The encoder emits SGR per span and SGR0 at row end.
 */
export function renderStyledFrameRow(cells: TuiCell[]): { text: string; style: TuiStyle }[] {
  const spans: { text: string; style: TuiStyle }[] = [];
  let currentText = '';
  let currentKey: string | null = null;
  let currentStyle: TuiStyle = DEFAULT_STYLE;

  for (const cell of cells) {
    if (cell.width === 0) continue; // continuation cell
    const key = styleKey(cell.style);
    if (currentKey === null) {
      currentKey = key;
      currentStyle = cell.style;
      currentText = cell.char;
    } else if (key === currentKey) {
      currentText += cell.char;
    } else {
      spans.push({ text: currentText, style: currentStyle });
      currentKey = key;
      currentStyle = cell.style;
      currentText = cell.char;
    }
  }

  if (currentKey !== null) {
    spans.push({ text: currentText, style: currentStyle });
  }

  return spans.length > 0 ? spans : [{ text: '', style: DEFAULT_STYLE }];
}
