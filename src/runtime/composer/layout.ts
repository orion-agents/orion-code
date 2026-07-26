/**
 * Shared prompt layout utilities.
 *
 * Migrated from `src/ink-ui/runtime/prompt-layout.ts` to provide a
 * renderer-independent visual-line wrapping and viewport calculation.
 * Ink re-exports from here; TUI imports directly.
 *
 * All width calculations use `string-width` for CJK/emoji correctness.
 * Cursor positioning respects grapheme boundaries.
 */

import stringWidth from 'string-width';
import { floorGraphemeBoundary, segmentGraphemes } from './grapheme';

export interface PromptVisualLine {
  logicalIndex: number;
  wrapIndex: number;
  content: string;
  start: number;
  end: number;
}

interface PromptVisualLineChunk extends PromptVisualLine {
  chunkStart: number;
  chunkEnd: number;
}

export interface PromptInputViewport {
  lines: PromptVisualLine[];
  hiddenRows: number;
  showHiddenIndicator: boolean;
  cursorLineIndex: number;
  cursorColumn: number;
  rowsUpFromPromptBottom: number;
}

export const PROMPT_CURSOR_GLYPH = '▌';

export function promptContentWidth(width: number): number {
  return Math.max(1, width - 4);
}

export function promptTextWidth(width: number): number {
  return Math.max(1, promptContentWidth(width) - 2);
}

export function splitByVisualWidth(text: string, maxWidth: number): string[] {
  if (text.length === 0) return [''];

  const chunks: string[] = [];
  let current = '';

  for (const part of segmentGraphemes(text)) {
    const next = `${current}${part.segment}`;
    if (current && stringWidth(next) > maxWidth) {
      chunks.push(current);
      current = part.segment;
    } else {
      current = next;
    }
  }

  chunks.push(current);
  return chunks;
}

function splitByVisualWidthWithOffsets(text: string, maxWidth: number): Array<{ content: string; start: number; end: number }> {
  if (text.length === 0) return [{ content: '', start: 0, end: 0 }];

  const chunks: Array<{ content: string; start: number; end: number }> = [];
  let current = '';
  let currentStart = 0;

  for (const part of segmentGraphemes(text)) {
    const next = `${current}${part.segment}`;
    if (current && stringWidth(next) > maxWidth) {
      chunks.push({ content: current, start: currentStart, end: part.index });
      current = part.segment;
      currentStart = part.index;
    } else {
      current = next;
    }
  }

  chunks.push({ content: current, start: currentStart, end: text.length });
  return chunks;
}

export function getPromptVisualLines(value: string, width: number): PromptVisualLine[] {
  return buildPromptVisualLines(value, width).lines;
}

export function getVisiblePromptVisualLines(
  value: string,
  width: number,
  maxRows: number
): { lines: PromptVisualLine[]; hiddenRows: number } {
  const lines = getPromptVisualLines(value, width);
  const rowLimit = Math.max(1, maxRows);

  if (lines.length <= rowLimit) {
    return { lines, hiddenRows: 0 };
  }

  return {
    lines: lines.slice(-rowLimit),
    hiddenRows: lines.length - rowLimit,
  };
}

export function getPromptInputViewport(
  value: string,
  width: number,
  maxRows: number,
  cursor: number = value.length
): PromptInputViewport {
  const layout = buildPromptVisualLines(value, width, cursor);
  const allLines = layout.lines;
  const rowLimit = Math.max(1, maxRows);
  const showHiddenIndicator = allLines.length > rowLimit && rowLimit > 1;
  const visibleInputRows = showHiddenIndicator ? rowLimit - 1 : rowLimit;
  const start = allLines.length <= visibleInputRows
    ? 0
    : Math.min(
      Math.max(0, layout.cursorLineIndex - visibleInputRows + 1),
      allLines.length - visibleInputRows
    );
  const lines = allLines.slice(start, start + visibleInputRows);
  const indicatorRows = showHiddenIndicator ? 1 : 0;
  const cursorLineIndex = indicatorRows + Math.max(0, layout.cursorLineIndex - start);
  const contentRows = indicatorRows + lines.length;

  return {
    lines,
    hiddenRows: allLines.length - lines.length,
    showHiddenIndicator,
    cursorLineIndex,
    cursorColumn: layout.cursorColumn,
    rowsUpFromPromptBottom: Math.max(1, contentRows - cursorLineIndex + 1),
  };
}

function buildPromptVisualLines(
  value: string,
  width: number,
  cursor: number = value.length
): { lines: PromptVisualLineChunk[]; cursorLineIndex: number; cursorColumn: number } {
  const logicalLines = value.length > 0 ? value.split('\n') : [''];
  const maxTextWidth = promptTextWidth(width);
  const clampedCursor = Math.min(Math.max(0, cursor), value.length);
  const visualLines: PromptVisualLineChunk[] = [];
  let cursorLineIndex = 0;
  let cursorColumn = 5;
  let lineStart = 0;

  logicalLines.forEach((line, logicalIndex) => {
    const chunks = splitByVisualWidthWithOffsets(line, maxTextWidth);
    const lineEnd = lineStart + line.length;
    const cursorInThisLine = clampedCursor >= lineStart && clampedCursor <= lineEnd;

    chunks.forEach((chunk, wrapIndex) => {
      const visualLine: PromptVisualLineChunk = {
        logicalIndex,
        wrapIndex,
        content: chunk.content,
        start: lineStart + chunk.start,
        end: lineStart + chunk.end,
        chunkStart: chunk.start,
        chunkEnd: chunk.end,
      };

      if (cursorInThisLine && clampedCursor - lineStart >= chunk.start && clampedCursor - lineStart <= chunk.end) {
        cursorLineIndex = visualLines.length;
        const cursorInChunk = Math.max(0, clampedCursor - lineStart - chunk.start);
        cursorColumn = 5 + stringWidth(chunk.content.slice(0, cursorInChunk));
      }

      visualLines.push(visualLine);
    });

    lineStart = lineEnd + 1;
  });

  return {
    lines: visualLines,
    cursorLineIndex,
    cursorColumn,
  };
}

function takeVisualWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';

  let result = '';
  for (const part of segmentGraphemes(text)) {
    const next = `${result}${part.segment}`;
    if (stringWidth(next) > maxWidth) break;
    result = next;
  }

  return result;
}

export function formatPromptVisualLine(
  visualLine: PromptVisualLine,
  width: number,
  options: { showCursor?: boolean; cursorOffset?: number } = {}
): string {
  const prefix = visualLine.logicalIndex === 0 && visualLine.wrapIndex === 0 ? '› ' : '  ';
  const maxContentWidth = Math.max(1, promptContentWidth(width) - stringWidth(prefix));
  let content = visualLine.content;

  if (options.showCursor) {
    const requestedOffset = Math.min(Math.max(0, options.cursorOffset ?? content.length), content.length);
    const offset = floorGraphemeBoundary(content, requestedOffset);
    const before = content.slice(0, offset);
    const after = content.slice(offset);
    const beforeWithCursor = `${before}${PROMPT_CURSOR_GLYPH}`;

    content = stringWidth(beforeWithCursor) >= maxContentWidth
      ? `${takeVisualWidth(before, maxContentWidth - stringWidth(PROMPT_CURSOR_GLYPH))}${PROMPT_CURSOR_GLYPH}`
      : `${beforeWithCursor}${takeVisualWidth(after, maxContentWidth - stringWidth(beforeWithCursor))}`;
  }

  const raw = `${prefix}${content}`;
  const padding = Math.max(0, promptContentWidth(width) - stringWidth(raw));
  return raw + ' '.repeat(padding);
}
