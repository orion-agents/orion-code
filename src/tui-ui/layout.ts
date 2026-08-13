import stringWidth from 'string-width';
import { createTuiFrame, setFrameCursor, writeFrameText, type TuiFrame } from '../tui-core/frame';
import { DEFAULT_THEME, type StyledRow, type TuiTheme } from '../tui-core/style';
import {
  createEditPreviewPickerState,
  createModelPickerState,
  createPermissionDecisionPickerState,
} from '../runtime/ui-view-model';
import { formatBytes } from '../services/format';
import type { ToolConfirmationPolicy } from '../services/global-config';
import {
  liveTuiTranscriptRecords,
  staticTuiTranscriptRecords,
  type TuiTranscriptRecord,
  type TuiUiState,
} from './state';
import { layoutTranscriptEntry, writeStyledRowToFrame } from './transcript-layout';
import { createTuiChromeViewModel } from './chrome-view-model';
import { pixelHunterBadge } from './pixel-mascot';
import type { TuiStatusItem } from '../services/global-config';
import type { TuiStyle } from '../tui-core/style';
import type { TuiChromeSegment } from './chrome-view-model';

export type TranscriptRecordLayout = (entry: TuiTranscriptRecord, width: number) => StyledRow[];

export interface TuiTranscriptLayoutOptions {
  /** Transcript content width; production uses the surface safe width. */
  transcriptWidth?: number;
  theme?: TuiTheme;
  toolOutputMode?: 'adaptive' | 'collapsed' | 'full';
  /** Runner-provided cached layout. Pure render callers use the shared default. */
  layoutTranscriptRecord?: TranscriptRecordLayout;
  statusLine?: readonly TuiStatusItem[];
  mascot?: boolean;
  animationFrame?: number;
}

export interface TuiLayoutOptions extends TuiTranscriptLayoutOptions {
  width: number;
  height: number;
  maxTranscriptRows?: number;
}

/**
 * Options for the live-region-only layout (renderTuiLiveFrame).
 * This function produces a frame for the inline surface's live region only,
 * containing: live transcript entries, timeline (if any), overlay, status, and
 * prompt. Committed (static) transcript entries are handled by surface.commit()
 * separately and are NOT included in this frame.
 */
export interface TuiLiveLayoutOptions extends TuiTranscriptLayoutOptions {
  width: number;
  /** Height of the live region (the inline surface bottom band). */
  height: number;
}

const MIN_WIDTH = 24;
const MIN_HEIGHT = 8;
const PROMPT_BORDER_ROWS = 2;
const MAX_TIMELINE_ROWS = 6;
const STATUS_ROWS = 1;

export interface TuiLayoutBudget {
  promptLineCount: number;
  /** Rows consumed by the prompt box (2 borders + N content lines). */
  promptRows: number;
  /** Rows consumed by the timeline strip (0 when there is no activity). */
  timelineRows: number;
  /** Rows available for the (live) transcript region at the top. */
  transcriptRows: number;
}

/**
 * Compute a dynamic layout budget for the given terminal height and prompt.
 *
 * The prompt box grows with the number of prompt lines (multi-line prompts get
 * a taller box); the timeline strip appears only when there is activity to show
 * (tools running / subtasks). Remaining rows go to the transcript, which is the
 * scrollable history region. For a single-line prompt with no activity this
 * collapses to the original fixed layout (prompt = 3 rows at the bottom).
 */
function computeBudget(
  height: number,
  promptValue: string,
  timelineCount: number
): TuiLayoutBudget {
  const totalPromptLines = Math.max(1, promptValue.split('\n').length);
  const maxPromptLines = Math.max(1, height - PROMPT_BORDER_ROWS - STATUS_ROWS);
  const promptLineCount = Math.min(totalPromptLines, maxPromptLines);
  const promptRows = PROMPT_BORDER_ROWS + promptLineCount;
  const maxTimelineRows = Math.max(0, height - promptRows - STATUS_ROWS);
  const timelineRows =
    timelineCount > 0 ? Math.min(MAX_TIMELINE_ROWS, timelineCount, maxTimelineRows) : 0;
  const transcriptRows = Math.max(0, height - promptRows - STATUS_ROWS - timelineRows);
  return { promptLineCount, promptRows, timelineRows, transcriptRows };
}

function countTimelineEntries(state: TuiUiState): number {
  return activeSubtaskTimelineEntries(state).length + activeToolStarts(state).length;
}

function activeToolStarts(state: TuiUiState) {
  const finishedCallIds = new Set(
    state.runtimeToolEvents.filter(event => event.type === 'finished').map(event => event.callId)
  );
  return state.runtimeToolEvents.filter(
    event => event.type === 'started' && !finishedCallIds.has(event.callId)
  );
}

function activeSubtaskTimelineEntries(state: TuiUiState) {
  return state.subtaskTimeline.filter(
    entry => entry.state === 'queued' || entry.state === 'running'
  );
}

/**
 * Measure the cursor-owned live block. Idle TUI state stays compact like an
 * ordinary shell prompt; streaming transcript and overlays grow the block only
 * as needed, up to the surface's viewport-derived limit.
 */
export function measureTuiLiveFrameHeight(
  state: TuiUiState,
  width: number,
  maxHeight: number,
  options: TuiTranscriptLayoutOptions = {}
): number {
  const safeWidth = Math.max(MIN_WIDTH, Math.floor(width));
  const transcriptWidth = resolveTranscriptWidth(safeWidth, options.transcriptWidth);
  const safeMaxHeight = Math.max(MIN_HEIGHT, Math.floor(maxHeight));
  if (state.overlay) return safeMaxHeight;

  const promptLines = Math.min(
    Math.max(1, state.prompt.value.split('\n').length),
    Math.max(1, safeMaxHeight - PROMPT_BORDER_ROWS - STATUS_ROWS)
  );
  const promptRows = PROMPT_BORDER_ROWS + promptLines;
  const timelineRows = Math.min(MAX_TIMELINE_ROWS, countTimelineEntries(state));
  const fixedRows = promptRows + STATUS_ROWS + timelineRows;
  const transcriptRows = liveTuiTranscriptRecords(state).flatMap(entry =>
    layoutRecord(entry, transcriptWidth, options)
  ).length;

  return Math.min(safeMaxHeight, Math.max(MIN_HEIGHT, fixedRows + transcriptRows));
}

export function renderTuiUiFrame(state: TuiUiState, options: TuiLayoutOptions): TuiFrame {
  const width = Math.max(MIN_WIDTH, Math.floor(options.width));
  const height = Math.max(MIN_HEIGHT, Math.floor(options.height));
  const frame = createTuiFrame(width, height);

  const budget = computeBudget(height, state.prompt.value, countTimelineEntries(state));
  // Honour an explicit cap on the transcript region (used by a test to pin a
  // small tail); otherwise the whole transcript region is used.
  const transcriptRows = Math.max(
    0,
    Math.min(options.maxTranscriptRows ?? budget.transcriptRows, budget.transcriptRows)
  );
  const promptTop = height - budget.promptRows;
  const statusRow = promptTop - 1;
  const timelineTop = statusRow - budget.timelineRows;

  renderTranscript(frame, state, 0, transcriptRows, options);
  if (budget.timelineRows > 0)
    renderTimeline(frame, state, timelineTop, budget.timelineRows, options.theme);
  renderStatus(frame, state, statusRow, options);
  renderPrompt(frame, state, promptTop, width, budget.promptLineCount, options.theme);
  // Overlay covers the region above status (transcript + timeline).
  renderOverlay(frame, state, statusRow);

  return frame;
}

/**
 * Render the live-region frame for InlineTerminalSurface.
 *
 * This frame contains ONLY the ephemeral content that sits at the bottom of
 * the terminal: live (uncommitted) transcript entries, timeline (if any),
 * overlay (if active), status bar, and prompt. Committed transcript entries are
 * written to scrollback by surface.commit() and are NOT included in this frame.
 *
 * The frame height should be sized to fill the terminal viewport's bottom band
 * (see InlineTerminalSurface.getLiveBandRows); the dynamic budget allocates the
 * band rows between transcript / timeline / status / prompt.
 */
export function renderTuiLiveFrame(state: TuiUiState, options: TuiLiveLayoutOptions): TuiFrame {
  const width = Math.max(MIN_WIDTH, Math.floor(options.width));
  const height = Math.max(MIN_HEIGHT, Math.floor(options.height));
  const frame = createTuiFrame(width, height);

  const budget = computeBudget(height, state.prompt.value, countTimelineEntries(state));
  const promptTop = height - budget.promptRows;
  const statusRow = promptTop - 1;
  const timelineTop = statusRow - budget.timelineRows;

  renderLiveTranscript(frame, state, 0, budget.transcriptRows, options);
  if (budget.timelineRows > 0)
    renderTimeline(frame, state, timelineTop, budget.timelineRows, options.theme);
  renderStatus(frame, state, statusRow, options);
  renderPrompt(frame, state, promptTop, width, budget.promptLineCount, options.theme);
  renderOverlay(frame, state, statusRow);

  return frame;
}

/** Render (live) transcript entries into [startRow, startRow + maxRows). */
function renderLiveTranscript(
  frame: TuiFrame,
  state: TuiUiState,
  startRow: number,
  maxRows: number,
  options: TuiTranscriptLayoutOptions
): void {
  const width = resolveTranscriptWidth(frame.width, options.transcriptWidth);
  const rows = liveTuiTranscriptRecords(state).flatMap(entry =>
    layoutRecord(entry, width, options)
  );
  const visible = rows.slice(Math.max(0, rows.length - maxRows));

  visible.forEach((row, index) => {
    writeStyledRowToFrame(frame, startRow + index, row);
  });
}

function renderTranscript(
  frame: TuiFrame,
  state: TuiUiState,
  startRow: number,
  maxRows: number,
  options: TuiTranscriptLayoutOptions
): void {
  const width = resolveTranscriptWidth(frame.width, options.transcriptWidth);
  const records = [...staticTuiTranscriptRecords(state), ...liveTuiTranscriptRecords(state)];
  const rows = records.flatMap(entry => layoutRecord(entry, width, options));
  const visible = rows.slice(Math.max(0, rows.length - maxRows));

  visible.forEach((row, index) => {
    writeStyledRowToFrame(frame, startRow + index, row);
  });
}

/** Render the activity timeline (subtasks + running tools) just above status. */
function renderTimeline(
  frame: TuiFrame,
  state: TuiUiState,
  top: number,
  maxRows: number,
  theme?: TuiTheme
): void {
  const items: string[] = [];
  for (const t of activeSubtaskTimelineEntries(state)) {
    const mark = t.state === 'running' ? '▶' : '◦';
    const label = t.summary ?? t.objective ?? t.role;
    const sequence = state.subtaskTimeline.findIndex(entry => entry.taskId === t.taskId) + 1;
    items.push(`${mark} #${sequence} ${t.role} · ${truncateCells(label, 34)} · ${t.state}`);
  }
  for (const e of activeToolStarts(state)) {
    items.push(`⚙ #${e.sequence} ${e.name} running`);
  }
  const visible = items.slice(-maxRows);
  visible.forEach((line, index) => {
    writeFrameText(frame, top + index, 0, truncateCells(line, frame.width), theme?.activityRunning);
  });
}

function renderStatus(
  frame: TuiFrame,
  state: TuiUiState,
  row: number,
  options: TuiTranscriptLayoutOptions
): void {
  if (row < 0) return;
  const chrome = createTuiChromeViewModel(state, options.statusLine);
  const mode = chrome.segments.find(segment => segment.id === 'mode');
  const secondary = chrome.segments
    .filter(segment => segment.id !== 'mode')
    .sort((a, b) => b.priority - a.priority);
  let column = 0;

  const write = (text: string, style?: TuiStyle): boolean => {
    const remaining = Math.max(0, frame.width - column);
    if (remaining <= 0) return false;
    const clipped = truncateCells(text, remaining);
    writeFrameText(frame, row, column, clipped, style);
    column += stringWidth(clipped);
    return clipped === text;
  };

  if (mode) write(mode.label, segmentStyle(mode, options.theme ?? DEFAULT_THEME, state));

  if (options.mascot !== false && frame.width >= 48) {
    const badge = ` │ ${pixelHunterBadge(chrome.pose, options.animationFrame)}`;
    if (column + stringWidth(badge) <= frame.width) write(badge, options.theme?.mascot);
  }

  for (const segment of secondary) {
    const separator = column > 0 ? ' │ ' : '';
    const needed = stringWidth(separator) + stringWidth(segment.label);
    if (column + needed <= frame.width) {
      write(separator, options.theme?.statusText);
      write(segment.label, segmentStyle(segment, options.theme ?? DEFAULT_THEME, state));
      continue;
    }
    if (segment.critical) {
      const remaining = frame.width - column - stringWidth(separator);
      if (remaining >= 8) {
        write(separator, options.theme?.statusText);
        write(
          truncateCells(segment.label, remaining),
          segmentStyle(segment, options.theme ?? DEFAULT_THEME, state)
        );
      }
    }
    break;
  }
}

/**
 * Render a bounded prompt viewport. The underlying prompt value is never
 * truncated; only the lines around the cursor are painted when the terminal is
 * too short to show the full multi-line value.
 */
function renderPrompt(
  frame: TuiFrame,
  state: TuiUiState,
  top: number,
  width: number,
  visibleLineCount: number,
  theme?: TuiTheme
): void {
  const value = state.prompt.value;
  const lines = value.split('\n');
  const innerWidth = Math.max(0, width - 2);
  const { line: cursorLine, col: cursorCol } = lineColOfCursor(value, state.prompt.cursor);
  const viewportStart = Math.max(0, Math.min(cursorLine, lines.length - visibleLineCount));
  const viewportLines = lines.slice(viewportStart, viewportStart + visibleLineCount);

  const resolvedTheme = theme ?? DEFAULT_THEME;
  const borderStyle = promptModeStyle(state, resolvedTheme);
  writeFrameText(frame, top, 0, `┌${'─'.repeat(innerWidth)}┐`, borderStyle);
  for (let i = 0; i < viewportLines.length; i++) {
    const absoluteLine = viewportStart + i;
    const prefix = absoluteLine === 0 ? '› ' : '  ';
    const fixed = ` ${prefix}`;
    const bodyWidth = Math.max(0, innerWidth - stringWidth(fixed) - 1);
    const viewport =
      absoluteLine === cursorLine
        ? promptLineViewport(viewportLines[i], cursorCol, bodyWidth)
        : { text: truncateCells(viewportLines[i], bodyWidth), cursorCells: 0 };
    const contentRow = top + 1 + i;
    writeFrameText(frame, contentRow, 0, '│', borderStyle);
    writeFrameText(frame, contentRow, 1, ' ');
    if (absoluteLine === 0) writeFrameText(frame, contentRow, 2, '›', borderStyle);
    writeFrameText(frame, contentRow, 3, ' ');
    writeFrameText(frame, contentRow, 4, viewport.text, resolvedTheme.userText);
    writeFrameText(frame, contentRow, width - 1, '│', borderStyle);
  }
  writeFrameText(
    frame,
    top + 1 + viewportLines.length,
    0,
    `└${'─'.repeat(innerWidth)}┘`,
    borderStyle
  );

  const cursorPrefix = cursorLine === 0 ? '› ' : '  ';
  const cursorFixed = ` ${cursorPrefix}`;
  const cursorBodyWidth = Math.max(0, innerWidth - stringWidth(cursorFixed) - 1);
  const cursorViewport = promptLineViewport(lines[cursorLine], cursorCol, cursorBodyWidth);
  const cursorColumn = 1 + stringWidth(cursorFixed) + cursorViewport.cursorCells;
  setFrameCursor(frame, top + 1 + cursorLine - viewportStart, cursorColumn, true);
}

function promptModeStyle(state: TuiUiState, theme?: TuiTheme): TuiStyle | undefined {
  if (state.goal) return theme?.modeGoal;
  if (state.agentMode.baseMode === 'plan') return theme?.modePlan;
  if (state.agentMode.baseMode === 'auto') return theme?.modeAuto;
  return theme?.modeBuild;
}

function segmentStyle(
  segment: TuiChromeSegment,
  theme: TuiTheme | undefined,
  state: TuiUiState
): TuiStyle | undefined {
  switch (segment.tone) {
    case 'mode-goal':
      return theme?.modeGoal;
    case 'mode-plan':
      return theme?.modePlan;
    case 'mode-auto':
      return theme?.modeAuto;
    case 'mode-build':
      return theme?.modeBuild;
    case 'warning':
      return theme?.warning;
    case 'muted':
      return theme?.statusText;
    default:
      if (segment.id === 'queue') return theme?.queueBadge;
      if (segment.id === 'activity' && state.statusState.phase === 'error') return theme?.error;
      return theme?.statusText;
  }
}

function promptLineViewport(
  value: string,
  cursor: number,
  width: number
): { text: string; cursorCells: number } {
  if (width <= 0) return { text: '', cursorCells: 0 };

  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  const before = Array.from(graphemeIterate(value.slice(0, safeCursor)));
  const after = value.slice(safeCursor);
  let visibleBefore = before.join('');
  let marker = '';

  if (stringWidth(visibleBefore) > width) {
    marker = '…';
    const available = Math.max(0, width - stringWidth(marker));
    let used = 0;
    const tail: string[] = [];
    for (let index = before.length - 1; index >= 0; index -= 1) {
      const grapheme = before[index];
      const graphemeWidth = Math.max(0, stringWidth(grapheme));
      if (used + graphemeWidth > available) break;
      tail.unshift(grapheme);
      used += graphemeWidth;
    }
    visibleBefore = tail.join('');
  }

  const left = `${marker}${visibleBefore}`;
  const visibleAfter = truncateCells(after, Math.max(0, width - stringWidth(left)));
  return {
    text: `${left}${visibleAfter}`,
    cursorCells: stringWidth(left),
  };
}

function renderOverlay(frame: TuiFrame, state: TuiUiState, maxRows: number): void {
  if (!state.overlay || maxRows <= 0) return;

  if (state.overlay.type === 'sessions') {
    const overlay = state.overlay;
    const request = overlay.request;
    const visibleCount = Math.max(
      0,
      Math.min(maxRows - 1, request.maxVisibleItems ?? maxRows - 1, request.sessions.length)
    );
    const start = sessionPickerStartIndex(
      state.overlay.selectedIndex,
      visibleCount,
      request.sessions.length
    );
    const visibleSessions = request.sessions.slice(start, start + visibleCount);
    const rows = [
      `Sessions: ${request.title} (${overlay.selectedIndex + 1}/${request.sessions.length})`,
      ...visibleSessions.map((session, offset) => {
        const index = start + offset;
        const marker = index === overlay.selectedIndex ? '›' : ' ';
        const label = session.name || session.taskSummary || session.id.slice(0, 8);
        const size = formatBytes(session.historySizeBytes ?? 0);
        const messages = `${session.messageCount ?? 0} msgs`;
        const project = request.showProject ? `  ${session.projectPath}` : '';
        return `${marker} ${String(index + 1).padStart(2, ' ')} ${session.id.slice(0, 8)}  ${label}  ${messages}  ${size}  ${session.model}${project}`;
      }),
    ].map(row => truncateCells(row, frame.width));

    rows.slice(0, maxRows).forEach((line, index) => {
      writeFrameText(frame, index, 0, line);
    });
    // Clear any remaining transcript rows below overlay content
    for (let i = rows.length; i < maxRows; i++) {
      writeFrameText(frame, i, 0, '');
    }
    return;
  }

  if (state.overlay.type === 'model') {
    const overlay = state.overlay;
    const request = overlay.request;
    const pickerState = createModelPickerState({ ...request, visibleStart: 0 });
    const visibleCount = Math.max(
      0,
      Math.min(maxRows - 1, request.maxVisibleItems ?? maxRows - 1, request.models.length)
    );
    const start = sessionPickerStartIndex(
      state.overlay.selectedIndex,
      visibleCount,
      request.models.length
    );
    const visibleModels = request.models.slice(start, start + visibleCount);
    const rows = [
      `Models: ${request.title ?? 'Switch Model'} (${overlay.selectedIndex + 1}/${request.models.length})`,
      ...visibleModels.map((model, offset) => {
        const index = start + offset;
        const marker = index === overlay.selectedIndex ? '›' : ' ';
        const isCurrent = pickerState.visibleItems.some(
          item => item.name === model.name && item.isCurrent
        );
        const currentTag = isCurrent ? ' *' : '';
        const alias = model.alias ? ` (${model.alias})` : '';
        const context = model.contextWindow ? `  ${formatModelTokens(model.contextWindow)}` : '';
        const provider = model.provider ? `  ${model.provider}` : '';
        return `${marker} ${String(index + 1).padStart(2, ' ')} ${model.name}${alias}${currentTag}${context}${provider}`;
      }),
    ].map(row => truncateCells(row, frame.width));

    rows.slice(0, maxRows).forEach((line, index) => {
      writeFrameText(frame, index, 0, line);
    });
    // Clear any remaining transcript rows below overlay content
    for (let i = rows.length; i < maxRows; i++) {
      writeFrameText(frame, i, 0, '');
    }
    return;
  }

  if (state.overlay.type === 'edit') {
    const overlay = state.overlay;
    const req = overlay.request;
    const visibleCount = Math.max(0, Math.min(maxRows - 1, 10, req.candidates.length));
    const start = pickerStartIndex(overlay.selectedIndex, visibleCount, req.candidates.length);
    const picker = createEditPreviewPickerState({
      request: req,
      visibleStart: start,
      maxVisibleItems: visibleCount,
      maxMatchLength: 60,
      maxReplacementLength: 40,
    });
    const rows = [
      picker.title,
      ...picker.visibleItems.map((item, offset) => {
        const index = start + offset;
        const marker = index === overlay.selectedIndex ? '›' : ' ';
        return `${marker} line ${String(item.line).padStart(3, ' ')}  "${item.matchPreview}"  → "${item.replacementPreview}"`;
      }),
    ].map(row => truncateCells(row, frame.width));

    rows.slice(0, maxRows).forEach((line, index) => {
      writeFrameText(frame, index, 0, line);
    });
    // Clear any remaining transcript rows below overlay content
    for (let i = rows.length; i < maxRows; i++) {
      writeFrameText(frame, i, 0, '');
    }
    return;
  }

  if (state.overlay.type === 'commands' || state.overlay.type === 'files') {
    const overlay = state.overlay;
    const visibleCount = Math.max(0, Math.min(maxRows - 2, 10, overlay.items.length || 1));
    const start = pickerStartIndex(overlay.selectedIndex, visibleCount, overlay.items.length);
    const visibleItems = overlay.items.slice(start, start + visibleCount);
    const title =
      overlay.type === 'commands'
        ? `Commands${overlay.query ? ` "${overlay.query}"` : ''}`
        : `Files${overlay.query ? ` "${overlay.query}"` : ''}`;
    const rows = [
      `${title} (${overlay.items.length} match${overlay.items.length === 1 ? '' : 'es'})`,
      ...(overlay.items.length === 0
        ? ['  No matching items']
        : visibleItems.map((item, offset) => {
            const index = start + offset;
            const marker = index === overlay.selectedIndex ? '›' : ' ';
            const description = item.description ? `  ${item.description}` : '';
            return `${marker} ${item.label}${description}`;
          })),
    ].map(row => truncateCells(row, frame.width));

    rows.slice(0, maxRows).forEach((line, index) => {
      writeFrameText(frame, index, 0, line);
    });
    // Clear any remaining transcript rows below overlay content
    for (let i = rows.length; i < maxRows; i++) {
      writeFrameText(frame, i, 0, '');
    }
    return;
  }

  if (state.overlay.type === 'permission') {
    const overlay = state.overlay;
    const picker = createPermissionDecisionPickerState(overlay.request);
    const rows = [
      `Tool Permission: ${overlay.request.name}`,
      ...picker.visibleItems.map((item, index) => {
        const marker = index === overlay.selectedIndex ? '›' : ' ';
        return `${marker} ${item.label}${item.description ? ` — ${item.description}` : ''}`;
      }),
      'Enter select   y once   p project   g global   n/Esc deny',
    ].map(row => truncateCells(row, frame.width));

    rows.slice(0, maxRows).forEach((line, index) => {
      writeFrameText(frame, index, 0, line);
    });
    // Clear any remaining transcript rows below overlay content
    for (let i = rows.length; i < maxRows; i++) {
      writeFrameText(frame, i, 0, '');
    }
    return;
  }

  if (state.overlay.type === 'toolConfirmation') {
    const overlay = state.overlay;
    const order: ToolConfirmationPolicy[] = ['allow', 'ask', 'deny'];
    const descriptions: Record<ToolConfirmationPolicy, string> = {
      allow: 'auto-run ask-level commands (blocked still denied)',
      ask: 'prompt interactively each time',
      deny: 'deny all ask-level commands',
    };
    const rows = [
      `Tool Confirmation (${overlay.selectedIndex + 1}/${order.length})`,
      ...order.map((value, index) => {
        const marker = index === overlay.selectedIndex ? '›' : ' ';
        const current = value === state.permissionMode ? ' *' : '';
        return `${marker} ${value}${current}  ${descriptions[value]}`;
      }),
      'Enter select   ↑/↓ move   Esc cancel',
    ].map(row => truncateCells(row, frame.width));

    rows.slice(0, maxRows).forEach((line, index) => {
      writeFrameText(frame, index, 0, line);
    });
    for (let i = rows.length; i < maxRows; i++) {
      writeFrameText(frame, i, 0, '');
    }
    return;
  }

  if (state.overlay.type === 'shortcuts') {
    const rows = [
      'Orion Pixel · Shortcuts',
      '/ commands   @ files   ? help   Ctrl+O tools',
      'Enter send/steer   Tab complete/queue   Shift+Tab cycle mode',
      'Esc cancel/stop    Ctrl+O tools          Ctrl+R history',
      'Ctrl+R history   Ctrl+E editor   Ctrl+L redraw   Ctrl+D exit',
      'Ctrl+C interrupt / twice exits   /goal exit leaves Goal mode',
    ].map(row => truncateCells(row, frame.width));

    rows.slice(0, maxRows).forEach((line, index) => {
      writeFrameText(frame, index, 0, line);
    });
  }
}

function sessionPickerStartIndex(
  selectedIndex: number,
  visibleCount: number,
  total: number
): number {
  return pickerStartIndex(selectedIndex, visibleCount, total);
}

function formatModelTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M ctx`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K ctx`;
  return `${tokens} ctx`;
}

function pickerStartIndex(selectedIndex: number, visibleCount: number, total: number): number {
  if (visibleCount <= 0 || total <= visibleCount) return 0;
  const halfWindow = Math.floor(visibleCount / 2);
  const desired = selectedIndex - halfWindow;
  return Math.min(total - visibleCount, Math.max(0, desired));
}

function layoutRecord(
  entry: TuiTranscriptRecord,
  width: number,
  options: TuiTranscriptLayoutOptions
): StyledRow[] {
  return (
    options.layoutTranscriptRecord?.(entry, width) ??
    layoutTranscriptEntry(entry, {
      width,
      theme: options.theme,
      toolOutputMode: options.toolOutputMode,
    })
  );
}

function resolveTranscriptWidth(frameWidth: number, requested?: number): number {
  const normalized = requested === undefined ? frameWidth : Math.floor(requested);
  return Math.max(1, Math.min(frameWidth, normalized));
}

function truncateCells(value: string, width: number): string {
  if (width <= 0) return '';
  let output = '';
  let used = 0;
  for (const char of graphemeIterate(value)) {
    const charWidth = Math.max(0, stringWidth(char));
    if (used + charWidth > width) break;
    output += char;
    used += charWidth;
  }
  return output;
}

/** Map an absolute character cursor to {line, col} within a multi-line value. */
function lineColOfCursor(value: string, cursor: number): { line: number; col: number } {
  const lines = value.split('\n');
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i].length;
    if (safeCursor <= offset + lineLen) {
      return { line: i, col: safeCursor - offset };
    }
    offset += lineLen + 1; // +1 for the newline separator
  }
  const last = lines.length - 1;
  return { line: last, col: lines[last].length };
}

/** Iterate by grapheme cluster (not code point) to preserve ZWJ emoji etc. */
function* graphemeIterate(text: string): Generator<string> {
  const Segmenter = Intl.Segmenter;
  if (Segmenter) {
    const segmenter = new Segmenter(undefined, { granularity: 'grapheme' });
    for (const part of segmenter.segment(text)) {
      yield part.segment;
    }
  } else {
    yield* Array.from(text);
  }
}
