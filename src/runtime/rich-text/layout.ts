/** Pure rich-text layout: structured Markdown blocks to terminal-safe styled rows. */

import stringWidth from 'string-width';
import { segmentGraphemes } from '../composer/grapheme';
import {
  type DiffLine,
  type RichTextBlock,
  type RichTextDocument,
  type RichTextSpan,
  type RichTextThemeResolver,
} from './types';
import {
  styleKey,
  type StyledRow,
  type StyledSpan,
  type TuiStyle,
} from '../../tui-core/style';

export interface RichTextLayoutOptions {
  width: number;
  theme: RichTextThemeResolver;
  /** Left indentation for the content (continuation alignment). */
  indent?: number;
}

interface StyledUnit {
  text: string;
  style: TuiStyle;
  width: number;
}

/** Every returned row has a visual width less than or equal to options.width. */
export function layoutRichText(doc: RichTextDocument, options: RichTextLayoutOptions): StyledRow[] {
  const width = normalizeWidth(options.width);
  const indent = normalizeIndent(options.indent ?? 0, width);
  return doc.blocks.flatMap(block => layoutBlock(block, width, options.theme, indent));
}

function layoutBlock(
  block: RichTextBlock,
  width: number,
  theme: RichTextThemeResolver,
  indent: number,
): StyledRow[] {
  switch (block.type) {
    case 'paragraph':
      return layoutInline(block.spans, width, theme, theme('assistantText'), indent);
    case 'heading':
      return layoutInline(block.spans, width, theme, theme('heading'), indent);
    case 'list':
      return layoutList(block, width, theme, indent);
    case 'quote':
      return layoutQuote(block, width, theme, indent);
    case 'code':
      return layoutCode(block.lines, width, theme, indent, block.language);
    case 'diff':
      return layoutDiff(block.lines, width, theme, indent);
    case 'table':
      return layoutTable(block, width, theme, indent);
    case 'rule': {
      const available = Math.max(1, width - indent);
      return [[
        { text: ' '.repeat(indent), style: theme('muted') },
        { text: '─'.repeat(available), style: theme('muted') },
      ]];
    }
  }
}

function layoutInline(
  spans: RichTextSpan[],
  width: number,
  theme: RichTextThemeResolver,
  baseStyle: TuiStyle,
  indent: number,
): StyledRow[] {
  const prefix: StyledRow = indent > 0 ? [{ text: ' '.repeat(indent), style: baseStyle }] : [];
  const styled = spans.map(span => ({
    text: span.text,
    style: resolveSpanStyle(span, baseStyle, theme),
  }));
  return layoutPrefixedSpans(styled, width, prefix, prefix, true);
}

function layoutList(
  block: Extract<RichTextBlock, { type: 'list' }>,
  width: number,
  theme: RichTextThemeResolver,
  indent: number,
): StyledRow[] {
  const rows: StyledRow[] = [];

  block.items.forEach((item, itemIndex) => {
    const marker = block.ordered ? `${itemIndex + 1}. ` : '- ';
    const markerIndent = normalizeIndent(indent, width);
    const prefixStyle = theme('muted');
    const firstPrefix: StyledRow = [
      { text: ' '.repeat(markerIndent), style: prefixStyle },
      { text: marker, style: prefixStyle },
    ];
    const continuationPrefix: StyledRow = [
      { text: ' '.repeat(markerIndent + stringWidth(marker)), style: prefixStyle },
    ];

    item.forEach((subBlock, blockIndex) => {
      if (blockIndex === 0 && (subBlock.type === 'paragraph' || subBlock.type === 'heading')) {
        const base = subBlock.type === 'heading' ? theme('heading') : theme('assistantText');
        const styled = subBlock.spans.map(span => ({
          text: span.text,
          style: resolveSpanStyle(span, base, theme),
        }));
        rows.push(...layoutPrefixedSpans(
          styled,
          width,
          firstPrefix,
          continuationPrefix,
          true,
        ));
        return;
      }

      if (blockIndex === 0) {
        rows.push(clampRow(firstPrefix, width));
      }
      const childIndent = normalizeIndent(markerIndent + stringWidth(marker), width);
      rows.push(...layoutBlock(subBlock, width, theme, childIndent));
    });
  });

  return rows;
}

function layoutQuote(
  block: Extract<RichTextBlock, { type: 'quote' }>,
  width: number,
  theme: RichTextThemeResolver,
  indent: number,
): StyledRow[] {
  const prefix: StyledRow = [{
    text: `${' '.repeat(normalizeIndent(indent, width))}> `,
    style: theme('muted'),
  }];
  const prefixWidth = rowWidth(prefix);
  const childWidth = Math.max(1, width - prefixWidth);
  const rows: StyledRow[] = [];

  for (const child of block.blocks) {
    const childRows = layoutBlock(child, childWidth, theme, 0);
    if (childRows.length === 0) rows.push(clampRow(prefix, width));
    for (const childRow of childRows) {
      rows.push(clampRow([...prefix, ...childRow], width));
    }
  }

  return rows;
}

function layoutCode(
  lines: string[],
  width: number,
  theme: RichTextThemeResolver,
  indent: number,
  language?: string,
): StyledRow[] {
  const safeIndent = normalizeIndent(indent, width);
  const available = Math.max(1, width - safeIndent);
  const style = theme('code');
  const prefix: StyledRow = safeIndent > 0 ? [{ text: ' '.repeat(safeIndent), style }] : [];
  const rows: StyledRow[] = [];

  if (language) {
    const labelStyle = mergeStyles(style, theme('muted'));
    const labelPrefix: StyledRow = safeIndent > 0
      ? [{ text: ' '.repeat(safeIndent), style: labelStyle }]
      : [];
    const label = truncateToWidth(language, available);
    rows.push(clampRow([
      ...labelPrefix,
      ...padRow([{ text: label, style: labelStyle }], available, labelStyle),
    ], width));
  }

  for (const line of lines.length > 0 ? lines : ['']) {
    const wrapped = wrapStyledSpans([{ text: line, style }], available, false);
    for (const row of wrapped) {
      rows.push(clampRow([...prefix, ...padRow(row, available, style)], width));
    }
  }

  return rows;
}

function layoutDiff(
  lines: DiffLine[],
  width: number,
  theme: RichTextThemeResolver,
  indent: number,
): StyledRow[] {
  const rows: StyledRow[] = [];
  const safeIndent = normalizeIndent(indent, width);

  for (const line of lines) {
    const prefix = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
    const style = diffLineStyle(line.kind, theme);
    const firstPrefix: StyledRow = [{ text: `${' '.repeat(safeIndent)}${prefix}`, style }];
    const continuationPrefix: StyledRow = [{ text: `${' '.repeat(safeIndent)}↳`, style }];
    rows.push(...layoutPrefixedSpans(
      [{ text: line.content, style }],
      width,
      firstPrefix,
      continuationPrefix,
      false,
    ));
  }

  return rows;
}

function diffLineStyle(kind: DiffLine['kind'], theme: RichTextThemeResolver): TuiStyle {
  switch (kind) {
    case 'add':
      return theme('diffAdded');
    case 'remove':
      return theme('diffRemoved');
    case 'hunk':
    case 'meta':
      return theme('diffHunk');
    case 'context':
      return theme('muted');
  }
}

function layoutTable(
  block: Extract<RichTextBlock, { type: 'table' }>,
  width: number,
  theme: RichTextThemeResolver,
  indent: number,
): StyledRow[] {
  const safeIndent = normalizeIndent(indent, width);
  const available = Math.max(1, width - safeIndent);
  const columnCount = Math.max(block.headers.length, ...block.rows.map(row => row.length));
  if (columnCount === 0) return [];

  const columnWidth = Math.floor(available / columnCount);
  if (columnWidth < 4) return layoutTableAsKeyValue(block, width, theme, safeIndent);

  const rows: StyledRow[] = [];
  const indentSpan: StyledSpan[] = safeIndent > 0
    ? [{ text: ' '.repeat(safeIndent), style: theme('assistantText') }]
    : [];

  const header: StyledRow = [...indentSpan];
  for (let column = 0; column < columnCount; column++) {
    const text = block.headers[column]?.map(span => span.text).join('') ?? '';
    header.push({
      text: padText(truncateToWidth(text, columnWidth - 1), columnWidth),
      style: theme('heading'),
    });
  }
  rows.push(clampRow(header, width));
  rows.push([
    ...indentSpan,
    { text: '─'.repeat(columnWidth * columnCount), style: theme('muted') },
  ]);

  for (const sourceRow of block.rows) {
    const row: StyledRow = [...indentSpan];
    for (let column = 0; column < columnCount; column++) {
      const text = sourceRow[column]?.map(span => span.text).join('') ?? '';
      row.push({
        text: padText(truncateToWidth(text, columnWidth - 1), columnWidth),
        style: theme('assistantText'),
      });
    }
    rows.push(clampRow(row, width));
  }

  return rows;
}

function layoutTableAsKeyValue(
  block: Extract<RichTextBlock, { type: 'table' }>,
  width: number,
  theme: RichTextThemeResolver,
  indent: number,
): StyledRow[] {
  const rows: StyledRow[] = [];
  const prefixIndent = ' '.repeat(normalizeIndent(indent, width));

  for (const sourceRow of block.rows) {
    for (let column = 0; column < block.headers.length; column++) {
      const key = block.headers[column]?.map(span => span.text).join('') || `col${column + 1}`;
      const value = sourceRow[column] ?? [];
      const prefix: StyledRow = [{ text: `${prefixIndent}${key}: `, style: theme('heading') }];
      const safePrefix = clampRow(prefix, Math.max(1, width - 1));
      const continuation: StyledRow = [{ text: ' '.repeat(rowWidth(safePrefix)), style: theme('muted') }];
      const styledValue = value.map(span => ({
        text: span.text,
        style: resolveSpanStyle(span, theme('assistantText'), theme),
      }));
      rows.push(...layoutPrefixedSpans(
        styledValue,
        width,
        safePrefix,
        continuation,
        true,
      ));
    }
  }

  return rows;
}

function layoutPrefixedSpans(
  spans: StyledSpan[],
  width: number,
  firstPrefix: StyledRow,
  continuationPrefix: StyledRow,
  softWrap: boolean,
): StyledRow[] {
  const prefixWidth = Math.max(rowWidth(firstPrefix), rowWidth(continuationPrefix));
  if (prefixWidth >= width) {
    const prefixRow = clampRow(firstPrefix, width);
    const body = wrapStyledSpans(spans, width, softWrap);
    const hasContent = spans.some(span => span.text.length > 0);
    return hasContent ? [prefixRow, ...body.map(row => clampRow(row, width))] : [prefixRow];
  }

  const bodyRows = wrapStyledSpans(spans, width - prefixWidth, softWrap);
  return bodyRows.map((row, index) => clampRow([
    ...(index === 0 ? firstPrefix : continuationPrefix),
    ...row,
  ], width));
}

function wrapStyledSpans(spans: StyledSpan[], width: number, softWrap: boolean): StyledRow[] {
  const safeWidth = normalizeWidth(width);
  const lines = splitStyledUnitsIntoLines(spans);
  const rows: StyledRow[] = [];

  for (const units of lines) {
    if (units.length === 0) {
      rows.push([]);
      continue;
    }

    let remaining = units;
    while (remaining.length > 0) {
      let used = 0;
      let take = 0;
      let lastWhitespace = -1;

      while (take < remaining.length && used + remaining[take].width <= safeWidth) {
        used += remaining[take].width;
        if (/^\s+$/u.test(remaining[take].text)) lastWhitespace = take;
        take += 1;
      }

      if (take === remaining.length) {
        rows.push(unitsToRow(remaining));
        break;
      }

      if (take === 0) {
        rows.push([{ text: '…', style: remaining[0].style }]);
        remaining = remaining.slice(1);
        continue;
      }

      const breakAt = softWrap && lastWhitespace > 0 ? lastWhitespace : take;
      rows.push(unitsToRow(remaining.slice(0, breakAt)));
      let consumed = softWrap && lastWhitespace > 0 ? lastWhitespace + 1 : take;
      if (softWrap) {
        while (consumed < remaining.length && /^\s+$/u.test(remaining[consumed].text)) {
          consumed += 1;
        }
      }
      remaining = remaining.slice(consumed);
    }
  }

  return rows.length > 0 ? rows : [[]];
}

function splitStyledUnitsIntoLines(spans: StyledSpan[]): StyledUnit[][] {
  const lines: StyledUnit[][] = [[]];
  for (const span of spans) {
    for (const part of span.text.split(/(\n)/u)) {
      if (part === '\n') {
        lines.push([]);
        continue;
      }
      for (const grapheme of segmentGraphemes(part)) {
        lines[lines.length - 1].push({
          text: grapheme.segment,
          style: span.style,
          width: stringWidth(grapheme.segment),
        });
      }
    }
  }
  return lines;
}

function unitsToRow(units: StyledUnit[]): StyledRow {
  const row: StyledRow = [];
  for (const unit of units) {
    const previous = row[row.length - 1];
    if (previous && styleKey(previous.style) === styleKey(unit.style)) {
      previous.text += unit.text;
    } else {
      row.push({ text: unit.text, style: unit.style });
    }
  }
  return row;
}

function resolveSpanStyle(
  span: RichTextSpan,
  baseStyle: TuiStyle,
  theme: RichTextThemeResolver,
): TuiStyle {
  let style = baseStyle;
  if (span.linkUrl) style = mergeStyles(style, theme('link'));
  if (span.code) style = mergeStyles(style, theme('inlineCode'));
  if (span.bold) style = { ...style, bold: true };
  if (span.italic) style = { ...style, italic: true };
  return style;
}

function mergeStyles(base: TuiStyle, overlay: TuiStyle): TuiStyle {
  return { ...base, ...overlay };
}

function padRow(row: StyledRow, targetWidth: number, style: TuiStyle): StyledRow {
  const padding = Math.max(0, targetWidth - rowWidth(row));
  return padding > 0 ? [...row, { text: ' '.repeat(padding), style }] : row;
}

function clampRow(row: StyledRow, width: number): StyledRow {
  const result: StyledRow = [];
  let used = 0;

  for (const span of row) {
    let text = '';
    for (const grapheme of segmentGraphemes(span.text.replace(/\n/gu, ''))) {
      const graphemeWidth = stringWidth(grapheme.segment);
      if (used + graphemeWidth > width) break;
      text += grapheme.segment;
      used += graphemeWidth;
    }
    if (text) result.push({ text, style: span.style });
    if (used >= width) break;
  }

  return result;
}

function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (stringWidth(text) <= maxWidth) return text;
  if (maxWidth === 1) return '…';

  let result = '';
  for (const grapheme of segmentGraphemes(text)) {
    if (stringWidth(result + grapheme.segment) > maxWidth - 1) break;
    result += grapheme.segment;
  }
  return `${result}…`;
}

function padText(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - stringWidth(text)));
}

function rowWidth(row: StyledRow): number {
  return stringWidth(row.map(span => span.text).join(''));
}

function normalizeWidth(width: number): number {
  return Math.max(1, Number.isFinite(width) ? Math.floor(width) : 1);
}

function normalizeIndent(indent: number, width: number): number {
  const normalized = Number.isFinite(indent) ? Math.floor(indent) : 0;
  return Math.max(0, Math.min(width - 1, normalized));
}
