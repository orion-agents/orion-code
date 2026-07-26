/** Pure transcript presentation. This module never writes a frame or stdout. */

import stringWidth from 'string-width';
import { segmentGraphemes } from '../runtime/composer/grapheme';
import { parseAnsiToStyledSpans } from '../runtime/rich-text/ansi-parser';
import { layoutRichText } from '../runtime/rich-text/layout';
import { parseRichText } from '../runtime/rich-text/markdown-parser';
import type {
  StructuredToolActivity,
  TranscriptEntry,
} from '../runtime/ui-events';
import type { ToolOutputStepSummary } from '../runtime/tool-output-presentation';
import { writeFrameText, type TuiFrame } from '../tui-core/frame';
import {
  sanitizeTerminalText,
  styleKey,
  type StyledRow,
  type StyledSpan,
  type TuiStyle,
  type TuiTheme,
} from '../tui-core/style';
import {
  resolveTuiTheme,
  richTextThemeResolver,
  type ResolvedTuiTheme,
} from './theme';

export type TranscriptLayoutEntry = Omit<TranscriptEntry, 'id'> & {
  id?: string;
  revision?: number;
  finalized?: boolean;
};

export interface TranscriptLayoutOptions {
  width: number;
  theme?: TuiTheme;
  toolOutputMode?: 'adaptive' | 'collapsed' | 'full';
}

interface StyledUnit {
  text: string;
  style: TuiStyle;
  width: number;
}

/**
 * Convert one transcript record into terminal-safe visual rows.
 * The function is deterministic and has no frame, cache, state, or stdout side effects.
 */
export function layoutTranscriptEntry(
  entry: TranscriptLayoutEntry,
  options: TranscriptLayoutOptions,
): StyledRow[] {
  const width = normalizeWidth(options.width);
  const theme = resolveTuiTheme(options.theme);
  let rows: StyledRow[];

  if (isToolEntry(entry)) {
    rows = layoutToolEntry(entry, width, theme, options.toolOutputMode ?? 'adaptive');
  } else {
    switch (entry.role) {
      case 'assistant':
        rows = layoutRichText(parseRichText(entry.content), {
          width,
          theme: richTextThemeResolver(theme),
        });
        break;
      case 'user':
        rows = layoutUserEntry(entry.content, width, theme);
        break;
      case 'error':
        rows = layoutLiteralRole(entry.content, width, '! ', theme.error, theme.error);
        break;
      case 'system':
        rows = layoutLiteralRole(
          entry.content,
          width,
          'system  ',
          theme.systemText,
          theme.systemText,
        );
        break;
      case 'command':
        rows = layoutLiteralRole(
          entry.content,
          width,
          '$ ',
          theme.commandMarker,
          theme.commandText,
        );
        break;
      case 'status':
        {
          const statusStyle = entry.statusTone === 'warning'
            ? theme.warning
            : theme.statusText;
        rows = layoutLiteralRole(
          entry.content,
          width,
          '· ',
          statusStyle,
          statusStyle,
        );
        break;
        }
      case 'tool':
        rows = [];
        break;
    }
  }

  return rows.map(row => normalizeOutputRow(row, width));
}

/** Paint one styled transcript row into a frame using terminal cell widths. */
export function writeStyledRowToFrame(frame: TuiFrame, row: number, spans: StyledRow): void {
  let column = 0;
  for (const span of spans) {
    if (column >= frame.width) break;
    writeFrameText(frame, row, column, span.text, span.style);
    column += stringWidth(span.text);
  }
}

function isToolEntry(entry: TranscriptLayoutEntry): boolean {
  return entry.role === 'tool'
    || entry.title?.toLowerCase() === 'tool'
    || entry.toolActivity !== undefined;
}

function layoutUserEntry(
  content: string,
  width: number,
  theme: ResolvedTuiTheme,
): StyledRow[] {
  const background = theme.userBackground;
  const markerStyle = withBackground(theme.userMarker, background);
  const textStyle = withBackground(theme.userText, background);
  const horizontalPadding = width >= 6 ? 1 : 0;
  const contentWidth = Math.max(1, width - horizontalPadding);
  const firstPrefix: StyledRow = [{
    text: `${' '.repeat(horizontalPadding)}› `,
    style: markerStyle,
  }];
  const continuationPrefix: StyledRow = [{
    text: ' '.repeat(horizontalPadding + 2),
    style: markerStyle,
  }];
  const text = sanitizeTerminalText(content, 2);
  const rows = layoutPrefixedSpans(
    [{ text, style: textStyle }],
    contentWidth,
    firstPrefix,
    continuationPrefix,
  );

  return rows.map(row => fillRowBackground(row, width, background));
}

function layoutLiteralRole(
  content: string,
  width: number,
  marker: string,
  markerStyle: TuiStyle,
  textStyle: TuiStyle,
): StyledRow[] {
  const safeMarker = truncateText(marker, Math.max(1, width));
  const markerWidth = stringWidth(safeMarker);
  const firstPrefix: StyledRow = [{ text: safeMarker, style: markerStyle }];
  const continuationPrefix: StyledRow = [{ text: ' '.repeat(markerWidth), style: markerStyle }];
  return layoutPrefixedSpans(
    [{ text: sanitizeTerminalText(content, 2), style: textStyle }],
    width,
    firstPrefix,
    continuationPrefix,
  );
}

function layoutToolEntry(
  entry: TranscriptLayoutEntry,
  width: number,
  theme: ResolvedTuiTheme,
  viewMode: 'adaptive' | 'collapsed' | 'full',
): StyledRow[] {
  const activity = entry.toolActivity;
  if (!activity && entry.role === 'tool') {
    return layoutLiteralRole(entry.content, width, '• ', theme.toolName, theme.toolMeta);
  }
  const state = activity?.state ?? (entry.role === 'error' ? 'error' : 'success');
  const stateStyle = toolStateStyle(state, theme);
  const name = sanitizeInlineText(activity?.name || toolFallbackName(entry));
  const header: StyledSpan[] = [
    { text: `${toolStateMarker(state)} `, style: stateStyle },
    { text: name, style: mergeStyles(theme.toolName, state === 'running' ? stateStyle : {}) },
  ];
  const metadata = toolMetadata(activity);
  if (metadata) header.push({ text: `  ${metadata}`, style: theme.toolMeta });

  const rows = wrapStyledSpans(header, width);
  if (activity?.command) {
    rows.push(...layoutLiteralRole(
      activity.command,
      width,
      '$ ',
      theme.commandMarker,
      theme.commandText,
    ));
  }
  const outputView = activity?.outputView;
  if (viewMode !== 'full' && outputView?.aggregate) {
    const visibleSteps = prioritizeAggregateSteps(outputView.aggregate.steps).slice(0, 3);
    for (const step of visibleSteps) {
      const marker = step.state === 'success' ? '✓' : step.state === 'error' ? '✗' : '-';
      const target = step.target ? ` ${sanitizeInlineText(step.target)}` : '';
      const summary = step.summary ? `  ${sanitizeInlineText(step.summary)}` : '';
      rows.push(...wrapStyledSpans([{
        text: `  ${marker} ${step.index}. ${sanitizeInlineText(step.toolName)}${target}${summary}`,
        style: step.state === 'error' ? theme.toolError : theme.toolMeta,
      }], width));
    }
  }
  const bodyText = outputView
    ? viewMode === 'full'
      ? activity?.body ?? entry.content
      : viewMode === 'collapsed'
        ? ''
        : outputView.mode === 'inline' || outputView.mode === 'preview'
          ? outputView.preview
          : ''
    : activity?.body !== undefined ? activity.body : entry.content;
  if (bodyText) {
    const safeAnsi = retainSafeToolSgr(bodyText);
    const body = parseAnsiToStyledSpans(safeAnsi).map(span => ({
      text: span.text,
      style: styleKey(span.style) ? span.style : theme.toolMeta,
    }));
    rows.push(...wrapStyledSpans(body, width));
  }

  if (
    outputView
    && viewMode !== 'full'
    && (viewMode === 'collapsed' || outputView.mode !== 'inline')
  ) {
    const omitted = outputView.omittedBytes > 0
      ? `${formatByteCount(outputView.omittedBytes)} omitted`
      : 'details available';
    const more = outputView.aggregate && outputView.aggregate.steps.length > 3
      ? ` · +${outputView.aggregate.steps.length - 3} more`
      : '';
    rows.push(...wrapStyledSpans([{
      text: `  ↳ collapsed${more} · ${omitted} · Ctrl+O details`,
      style: theme.toolMeta,
    }], width));
  }

  if (activity?.error && !entry.content.includes(activity.error)) {
    rows.push(...layoutLiteralRole(activity.error, width, '  ', theme.toolError, theme.toolError));
  }

  return rows;
}

function prioritizeAggregateSteps(steps: ToolOutputStepSummary[]): ToolOutputStepSummary[] {
  return [...steps].sort((a, b) => {
    const priority = (state: string): number => state === 'error' ? 0 : state === 'skipped' ? 1 : 2;
    return priority(a.state) - priority(b.state) || a.index - b.index;
  });
}

function toolFallbackName(entry: TranscriptLayoutEntry): string {
  if (entry.title && entry.title.toLowerCase() !== 'tool') return entry.title;
  return 'tool';
}

function toolStateMarker(state: StructuredToolActivity['state']): string {
  switch (state) {
    case 'success':
      return '✓';
    case 'error':
      return '✗';
    case 'skipped':
      return '-';
    case 'queued':
    case 'requested':
    case 'running':
      return '●';
  }
}

function toolStateStyle(
  state: StructuredToolActivity['state'],
  theme: ResolvedTuiTheme,
): TuiStyle {
  switch (state) {
    case 'success':
      return theme.toolSuccess;
    case 'error':
      return theme.toolError;
    case 'skipped':
      return theme.toolSkipped;
    case 'queued':
    case 'requested':
    case 'running':
      return theme.toolRunning;
  }
}

function toolMetadata(activity?: StructuredToolActivity): string {
  if (!activity) return '';
  const output = typeof activity.outputBytes === 'number'
    ? `output ${formatByteCount(activity.outputBytes)}`
    : '';
  const artifact = activity.artifactHint ? `artifact ${activity.artifactHint}` : '';
  return [activity.detail, activity.summary, activity.duration, output, artifact]
    .filter((value): value is string => Boolean(value))
    .map(sanitizeInlineText)
    .join('  ');
}

function formatByteCount(bytes: number): string {
  const safeBytes = Math.max(0, Math.floor(bytes));
  if (safeBytes < 1024) return `${safeBytes} B`;
  if (safeBytes < 1024 * 1024) return `${(safeBytes / 1024).toFixed(1)} KB`;
  return `${(safeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sanitizeInlineText(text: string): string {
  return sanitizeTerminalText(text, 2).replace(/\s+/gu, ' ').trim();
}

function layoutPrefixedSpans(
  spans: StyledSpan[],
  width: number,
  firstPrefix: StyledRow,
  continuationPrefix: StyledRow,
): StyledRow[] {
  const prefixWidth = Math.max(rowWidth(firstPrefix), rowWidth(continuationPrefix));
  if (prefixWidth >= width) {
    const prefix = clampRow(firstPrefix, width);
    const hasContent = spans.some(span => span.text.length > 0);
    return hasContent ? [prefix, ...wrapStyledSpans(spans, width)] : [prefix];
  }

  return wrapStyledSpans(spans, width - prefixWidth).map((row, index) => [
    ...(index === 0 ? firstPrefix : continuationPrefix),
    ...row,
  ]);
}

function wrapStyledSpans(spans: StyledSpan[], width: number): StyledRow[] {
  const safeWidth = normalizeWidth(width);
  const lines = splitStyledUnitsIntoLines(spans);
  const rows: StyledRow[] = [];

  for (const units of lines) {
    if (units.length === 0) {
      rows.push([]);
      continue;
    }

    let row: StyledUnit[] = [];
    let used = 0;
    for (const unit of units) {
      if (unit.width > safeWidth) {
        if (row.length > 0) rows.push(unitsToRow(row));
        rows.push([{ text: '…', style: unit.style }]);
        row = [];
        used = 0;
        continue;
      }
      if (row.length > 0 && used + unit.width > safeWidth) {
        rows.push(unitsToRow(row));
        row = [];
        used = 0;
      }
      row.push(unit);
      used += unit.width;
    }
    if (row.length > 0) rows.push(unitsToRow(row));
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

function fillRowBackground(row: StyledRow, width: number, background: TuiStyle): StyledRow {
  const styled = row.map(span => ({
    text: span.text,
    style: withBackground(span.style, background),
  }));
  const padding = Math.max(0, width - rowWidth(styled));
  if (padding > 0) styled.push({ text: ' '.repeat(padding), style: background });
  return styled;
}

function normalizeOutputRow(row: StyledRow, width: number): StyledRow {
  return mergeAdjacentSpans(clampRow(row.map(span => ({
    text: sanitizeTerminalText(span.text, 2).replace(/\n/gu, ''),
    style: span.style,
  })), width));
}

function clampRow(row: StyledRow, width: number): StyledRow {
  const result: StyledRow = [];
  let used = 0;
  for (const span of row) {
    let text = '';
    for (const grapheme of segmentGraphemes(span.text)) {
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

function mergeAdjacentSpans(row: StyledRow): StyledRow {
  const merged: StyledRow = [];
  for (const span of row) {
    if (!span.text) continue;
    const previous = merged[merged.length - 1];
    if (previous && styleKey(previous.style) === styleKey(span.style)) {
      previous.text += span.text;
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/** Keep supported SGR codes for parseAnsiToStyledSpans; remove every other escape family. */
function retainSafeToolSgr(text: string): string {
  let result = '';
  let index = 0;

  while (index < text.length) {
    const code = text.codePointAt(index);
    if (code === undefined) break;
    const character = String.fromCodePoint(code);

    if (code === 0x1b) {
      const next = text.codePointAt(index + 1);
      if (next === 0x5b) {
        const end = findCsiEnd(text, index + 2);
        if (end < 0) break;
        const sequence = text.slice(index, end + 1);
        const parameters = text.slice(index + 2, end);
        if (text[end] === 'm' && /^[0-9;]*$/u.test(parameters)) result += sequence;
        index = end + 1;
        continue;
      }
      if (next === 0x5d || next === 0x50 || next === 0x5e || next === 0x5f) {
        index = skipControlString(text, index + 2);
        continue;
      }
      index += next === undefined ? 1 : 2;
      continue;
    }

    if (code === 0x9d || code === 0x90 || code === 0x9e || code === 0x9f) {
      index = skipControlString(text, index + character.length);
      continue;
    }

    result += character;
    index += character.length;
  }

  return result;
}

function findCsiEnd(text: string, start: number): number {
  for (let index = start; index < text.length; index++) {
    const code = text.codePointAt(index);
    if (code !== undefined && code >= 0x40 && code <= 0x7e) return index;
  }
  return -1;
}

function skipControlString(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const code = text.codePointAt(index);
    if (code === 0x07 || code === 0x9c) return index + 1;
    if (code === 0x1b && text.codePointAt(index + 1) === 0x5c) return index + 2;
    index += code !== undefined && code > 0xffff ? 2 : 1;
  }
  return index;
}

function truncateText(text: string, width: number): string {
  let result = '';
  for (const grapheme of segmentGraphemes(text)) {
    if (stringWidth(result + grapheme.segment) > width) break;
    result += grapheme.segment;
  }
  return result;
}

function mergeStyles(base: TuiStyle, overlay: TuiStyle): TuiStyle {
  return { ...base, ...overlay };
}

function withBackground(style: TuiStyle, background: TuiStyle): TuiStyle {
  return { ...style, ...background };
}

function rowWidth(row: StyledRow): number {
  return stringWidth(row.map(span => span.text).join(''));
}

function normalizeWidth(width: number): number {
  return Math.max(1, Number.isFinite(width) ? Math.floor(width) : 1);
}
