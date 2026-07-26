import { createTuiFrame, setFrameCursor, writeFrameText, type TuiFrame } from '../tui-core/frame';
import { sanitizeTerminalText, type TuiTheme } from '../tui-core/style';
import { segmentGraphemes } from '../runtime/composer/grapheme';
import stringWidth from 'string-width';
import { resolveTuiTheme } from './theme';
import type { ToolInspectorViewModel } from './transcript-inspector';

export function renderTranscriptInspectorFrame(
  view: ToolInspectorViewModel,
  options: { width: number; height: number; theme?: TuiTheme },
): TuiFrame {
  const frame = createTuiFrame(options.width, options.height);
  const theme = resolveTuiTheme(options.theme);
  const width = frame.width;
  const height = frame.height;
  writeFrameText(frame, 0, 0, ' Orion Code Tool Inspector', theme.heading);
  const search = view.searchQuery ? `search: ${view.searchQuery}` : `${view.entries.length} tools`;
  writeFrameText(frame, 1, 1, search, theme.toolMeta);

  if (width < 60) {
    const listRows = Math.max(2, Math.min(6, Math.floor((height - 4) / 3)));
    renderList(frame, view, 2, listRows, width, theme);
    renderDetail(frame, view, 2 + listRows, Math.max(0, height - listRows - 3), 0, width, theme);
  } else {
    const listWidth = Math.max(24, Math.min(42, Math.floor(width * 0.36)));
    renderList(frame, view, 2, Math.max(0, height - 3), listWidth, theme);
    renderDetail(frame, view, 2, Math.max(0, height - 3), listWidth + 1, width - listWidth - 1, theme);
  }

  const footer = ' j/k select  Enter/Space expand  Ctrl+E all  [ export  v editor  / search  q exit';
  writeFrameText(frame, height - 1, 0, footer, theme.statusText);
  setFrameCursor(frame, height - 1, Math.min(width - 1, footer.length), false);
  return frame;
}

function renderList(
  frame: TuiFrame,
  view: ToolInspectorViewModel,
  top: number,
  maxRows: number,
  width: number,
  theme: ReturnType<typeof resolveTuiTheme>,
): void {
  if (view.entries.length === 0) {
    writeFrameText(frame, top, 1, 'No tool output recorded.', theme.toolMeta);
    return;
  }
  const start = Math.max(0, Math.min(view.selectedIndex, view.entries.length - maxRows));
  for (let row = 0; row < maxRows && start + row < view.entries.length; row += 1) {
    const index = start + row;
    const entry = view.entries[index];
    const selected = index === view.selectedIndex;
    const marker = entry.state === 'success' ? '✓' : entry.state === 'error' ? '✗' : '-';
    const text = `${selected ? '›' : ' '} ${marker} #${entry.sequence} ${entry.toolName}`;
    writeFrameText(frame, top + row, 0, truncateWidth(text, Math.max(1, width - 1)), selected
      ? { ...theme.toolName, inverse: true }
      : entry.state === 'error' ? theme.toolError : theme.toolMeta);
  }
}

function renderDetail(
  frame: TuiFrame,
  view: ToolInspectorViewModel,
  top: number,
  maxRows: number,
  left: number,
  width: number,
  theme: ReturnType<typeof resolveTuiTheme>,
): void {
  if (maxRows <= 0 || width <= 0) return;
  const entry = view.selected;
  if (!entry) return;
  const heading = ` ${entry.toolName} · ${formatBytes(entry.outputBytes)}${entry.artifactId ? '' : ' · legacy'}`;
  writeFrameText(frame, top, left, heading, theme.toolName);
  const expanded = view.expandedCallIds.includes(entry.callId);
  const detail = view.detail;
  const body = !expanded
    ? entry.summary ?? 'Press Enter to expand detail.'
    : detail?.loading
    ? 'Loading detail...'
    : detail?.error
      ? `Detail error: ${detail.error}`
      : detail?.content ?? entry.summary ?? 'Press Enter to load detail.';
  const lines = sanitizeTerminalText(body).split('\n');
  const detailOffset = expanded ? Math.max(0, view.detailOffset) : 0;
  for (
    let index = 0;
    index < maxRows - 1 && detailOffset + index < lines.length;
    index += 1
  ) {
    writeFrameText(
      frame,
      top + 1 + index,
      left + 1,
      truncateWidth(lines[detailOffset + index], Math.max(1, width - 2)),
      theme.toolMeta,
    );
  }
  if (expanded && detail?.nextOffsetBytes !== undefined && maxRows > 1) {
    writeFrameText(frame, top + maxRows - 1, left + 1, 'More available · PageDown', theme.warning);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncateWidth(value: string, maxWidth: number): string {
  let output = '';
  let width = 0;
  for (const grapheme of segmentGraphemes(value)) {
    const nextWidth = stringWidth(grapheme.segment);
    if (width + nextWidth > maxWidth) break;
    output += grapheme.segment;
    width += nextWidth;
  }
  return output;
}
