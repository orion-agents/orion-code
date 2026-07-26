import { renderFrameRows, type TuiFrame } from '../tui-core/frame';
import type { StyledRow, TuiTheme } from '../tui-core/style';
import { TuiInputParser, type TuiInputEvent, type TuiKey } from '../tui-core/input-parser';
import type { UiEventSink } from '../runtime/ui-events';
import type { ToolDetailRepository } from '../runtime/tool-detail-repository';
import { getCommands } from '../commands';
import { measureTuiLiveFrameHeight, renderTuiLiveFrame, renderTuiUiFrame } from './layout';
import { getFileQuery, visibleCommandItems, visibleFileItems, type TuiPickerItem } from './pickers';
import {
  InlineTerminalSurface,
  type CommittedEntry,
  type LiveFrameProvider,
  type TranscriptCommitBatch,
} from './inline-surface';
import {
  createTuiRenderScheduler,
  type TuiRenderScheduler,
  type TuiRenderSchedulerDeps,
} from './render-scheduler';
import {
  createTuiUiEventSink,
  initialTuiUiState,
  acknowledgeTranscriptCommit,
  markTranscriptQueued,
  pendingCommitRecords,
  tuiUiReducer,
  type TuiUiAction,
  type TuiTranscriptRecord,
  type TuiUiState,
} from './state';
import { TuiInputOwnershipController } from './input-ownership';
import { TranscriptInspectorController } from './transcript-inspector';
import { renderTranscriptInspectorFrame } from './transcript-inspector-layout';
import { TranscriptInspectorSurface } from './transcript-inspector-surface';
import { TranscriptLayoutCache } from './transcript-cache';
import { layoutTranscriptEntry } from './transcript-layout';
import { DEFAULT_TUI_THEME_ID, resolveTuiTheme, type ResolvedTuiTheme } from './theme';
import {
  initialHistoryState,
  historyCurrentValue,
  historyNext,
  historyPrevious,
  pushHistoryEntry,
  type InputHistoryState,
} from '../runtime/composer/history';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

/** Actions that should use 'stream' priority (FPS-capped). */
const STREAM_ACTIONS: ReadonlySet<string> = new Set([
  'updateTranscript',
  'setStatusSnapshot',
  'setStatus',
  'toolStarted',
  'toolFinished',
  'subtaskEvent',
]);

export interface TuiRunnerOptions {
  output: Pick<NodeJS.WriteStream, 'write'>;
  width: number;
  height: number;
  cwd?: string;
  onSubmit?: (input: string) => void | Promise<void>;
  onCtrlC?: () => void;
  onPermissionDecision?: (requestId: string, approved: boolean) => void | Promise<void>;
  /** Inject scheduler deps for testing (fake timers). */
  schedulerDeps?: Partial<TuiRenderSchedulerDeps>;
  /** Inline surface for committed scrollback + live region rendering. */
  surface?: InlineTerminalSurface;
  /** Fatal surface failures must restore terminal ownership and stop the renderer. */
  onSurfaceError?: (error: unknown) => void;
  /** Immutable transcript theme for this runner instance. */
  theme?: TuiTheme;
  themeId?: string;
  detailRepository?: ToolDetailRepository;
  inspectorSurface?: TranscriptInspectorSurface;
  onOpenExternalEditor?: (filePath: string) => void | Promise<void>;
}

export interface TuiRunnerCounters {
  layoutCount: number;
  paintCount: number;
  changedRows: number;
  commitCount: number;
}

export class TuiRunner {
  readonly events: UiEventSink;
  private readonly parser = new TuiInputParser();
  private readonly inputOwnership = new TuiInputOwnershipController();
  private readonly scheduler: TuiRenderScheduler;
  private readonly surface: InlineTerminalSurface | null;
  private readonly transcriptCache = new TranscriptLayoutCache();
  private readonly theme: ResolvedTuiTheme;
  private readonly themeId: string;
  private readonly inspectorController: TranscriptInspectorController | null;
  private readonly inspectorSurface: TranscriptInspectorSurface | null;
  private history: InputHistoryState = initialHistoryState;
  private surfaceFailed = false;
  private inspectorReady = false;
  private inspectorSearchActive = false;
  private modalTransition: Promise<void> = Promise.resolve();
  private commitSequence = 0;
  private commitInFlight = false;
  private commitMismatchRetries = 0;
  private state: TuiUiState = initialTuiUiState;
  private width: number;
  private height: number;
  private lastFrame: TuiFrame | null = null;
  private surfaceResizePending = false;
  private resizeEpoch = 0;
  private surfaceResizeGeneration = 0;
  readonly counters: TuiRunnerCounters = {
    layoutCount: 0,
    paintCount: 0,
    changedRows: 0,
    commitCount: 0,
  };

  constructor(private readonly options: TuiRunnerOptions) {
    this.width = options.width;
    this.height = options.height;
    this.surface = options.surface ?? null;
    this.theme = resolveTuiTheme(options.theme);
    this.themeId = options.themeId ?? DEFAULT_TUI_THEME_ID;
    this.inspectorSurface = options.inspectorSurface ?? null;
    this.inspectorController = options.detailRepository
      ? new TranscriptInspectorController(options.detailRepository, options.cwd ?? process.cwd())
      : null;
    this.scheduler = createTuiRenderScheduler(() => this.renderLive(), options.schedulerDeps);
    this.events = createTuiUiEventSink(action => this.dispatch(action));
    // Initial render: paint the live region immediately.
    this.renderLive();
  }

  getState(): TuiUiState {
    return this.state;
  }

  getLastFrame(): TuiFrame | null {
    return this.lastFrame;
  }

  getVisibleRows(): string[] {
    return this.lastFrame ? renderFrameRows(this.lastFrame) : [];
  }

  /** Get the scheduler for external lifecycle management (flush, stop). */
  getScheduler(): TuiRenderScheduler {
    return this.scheduler;
  }

  /** Stop stale-width paints as soon as the terminal reports SIGWINCH. */
  beginResize(width = this.width): void {
    if (this.state.inspector) return;
    if (!this.surface || this.surfaceFailed) return;
    this.surfaceResizePending = true;
    this.resizeEpoch += 1;
    this.surfaceResizeGeneration = this.surface.beginResize(width);
  }

  resize(width: number, height: number): void {
    if (this.state.inspector) {
      this.width = width;
      this.height = height;
      this.paintInspector();
      return;
    }
    this.beginResize(width);
    const resizeEpoch = this.resizeEpoch;
    const surfaceResizeGeneration = this.surfaceResizeGeneration;
    this.width = width;
    this.height = height;
    // Invalidate transcript cache on resize so committed entries are re-laid-out
    // at the new width.
    this.transcriptCache.invalidate(
      this.state.transcriptGeneration,
      this.transcriptWidth,
      this.themeId
    );
    if (this.surface && !this.surfaceFailed) {
      // Surface resize is async (serialized FIFO); fire-and-forget is safe
      // because subsequent renders go through the surface queue too.
      void this.surface
        .resize(
          width,
          height,
          () => {
            const frame = this.buildLiveFrame(width);
            this.lastFrame = frame;
            this.counters.layoutCount += 1;
            this.counters.paintCount += 1;
            return frame;
          },
          surfaceResizeGeneration
        )
        .then(() => {
          if (resizeEpoch !== this.resizeEpoch) return;
          this.surfaceResizePending = false;
          this.tryCommit(this.state, true);
          this.scheduler.request('immediate');
          this.scheduler.flush();
        })
        .catch(error => this.handleSurfaceError(error));
      return;
    }
    this.scheduler.request('immediate');
    this.scheduler.flush();
  }

  dispatch(action: TuiUiAction): void {
    const prevState = this.state;
    this.state = tuiUiReducer(this.state, action);
    if (action.type === 'setToolOutputViewMode' && action.mode !== prevState.toolOutputViewMode) {
      this.transcriptCache.clear();
    }

    // Check if any transcript entries became committable (finalized).
    this.tryCommit(prevState);

    const priority = STREAM_ACTIONS.has(action.type) ? 'stream' : 'immediate';
    this.scheduler.request(priority);
  }

  feedInput(chunk: Buffer | string): TuiInputEvent[] {
    const events = this.parser.feed(chunk, { detectUnbracketedMultilinePaste: true });
    for (const event of events) {
      this.applyInputEvent(event);
    }
    return events;
  }

  /**
   * Render the full frame (legacy path for tests without surface).
   * Uses renderTuiUiFrame which includes both static and live transcript.
   */
  renderFullFrame(): TuiFrame {
    this.counters.layoutCount += 1;
    const frame = renderTuiUiFrame(this.state, {
      width: this.width,
      height: this.height,
      ...this.transcriptLayoutOptions(),
    });
    this.lastFrame = frame;
    this.counters.paintCount += 1;
    return frame;
  }

  /**
   * Render the live region via InlineTerminalSurface.
   * When surface is available, only ephemeral content (live transcript, overlay,
   * status, prompt) is painted into the live region.
   * When no surface (test mode), renders the full frame including committed
   * transcript so tests can inspect complete content via getLastFrame().
   */
  private renderLive(): void {
    if (this.state.inspector) {
      this.paintInspector();
      return;
    }
    if (this.surface && !this.surfaceFailed) {
      if (this.surfaceResizePending) return;
      this.counters.layoutCount += 1;
      // Production path: render only the live region for inline surface.
      const frame = this.buildLiveFrame(this.width);
      this.lastFrame = frame;
      this.counters.paintCount += 1;
      // Surface renderLive is async (serialized FIFO), but for production use
      // we fire-and-forget because the next render will also go through the queue.
      void this.surface.renderLive(frame).catch(error => this.handleSurfaceError(error));
    } else {
      this.counters.layoutCount += 1;
      // Test path (no surface): render the full frame so getLastFrame() /
      // getVisibleRows() return complete content including committed transcript.
      const frame = renderTuiUiFrame(this.state, {
        width: this.width,
        height: this.height,
        ...this.transcriptLayoutOptions(),
      });
      this.lastFrame = frame;
      this.counters.paintCount += 1;
    }
  }

  /** Build a compact live-region frame that grows only for active content. */
  private buildLiveFrame(terminalWidth: number): TuiFrame {
    const width = this.surface
      ? Math.max(1, Math.floor(terminalWidth) - 1)
      : Math.max(1, Math.floor(terminalWidth));
    const height = this.surface
      ? measureTuiLiveFrameHeight(
          this.state,
          width,
          this.surface.getLiveBandRows(),
          this.transcriptLayoutOptions()
        )
      : this.height - 1;
    return renderTuiLiveFrame(this.state, {
      width,
      height,
      ...this.transcriptLayoutOptions(),
    });
  }

  /**
   * Try to commit any newly-finalized transcript entries to scrollback.
   * Called after each dispatch. Only commits entries that are committable
   * but not yet queued.
   */
  private tryCommit(prevState: TuiUiState, force = false): void {
    if (!this.surface || this.surfaceResizePending || this.state.inspector || this.commitInFlight)
      return;

    const prevCommittable = prevState.committableTranscriptCount;
    const currCommittable = this.state.committableTranscriptCount;
    const generationChanged = this.state.transcriptGeneration !== prevState.transcriptGeneration;

    if (!force && !generationChanged && currCommittable <= prevCommittable) return;
    if (currCommittable <= this.state.queuedTranscriptCount) return;

    // Gather entries to commit: from queued boundary to new committable boundary.
    const entriesToCommit = pendingCommitRecords(this.state);
    if (entriesToCommit.length === 0) return;

    // Advance the queued boundary so we don't double-commit.
    this.state = markTranscriptQueued(this.state, entriesToCommit.length);

    // Build the commit batch.
    const committedEntries: CommittedEntry[] = entriesToCommit.map(entry => ({
      displayKey: entry.id,
      rows: this.layoutTranscriptRecord(entry, this.transcriptWidth),
    }));

    const batch: TranscriptCommitBatch = {
      batchId: `tui-commit-${++this.commitSequence}`,
      generation: this.state.transcriptGeneration,
      reason: 'finalize',
      entries: committedEntries,
    };

    // The LiveFrameProvider ensures the live frame is rebuilt after commit
    // with the latest state (where committed entries are no longer in the
    // live region).
    const generation = batch.generation;
    const getLatestLiveFrame: LiveFrameProvider = () => this.buildLiveFrame(this.width);
    this.commitInFlight = true;
    let continueCommit = true;

    // Surface commit is async (serialized FIFO). Fire-and-forget: the
    // commit's internal getLatestLiveFrame already rebuilds the live region,
    // so no additional scheduler paint is needed here.
    void this.surface
      .commit(batch, getLatestLiveFrame)
      .then(result => {
        if (
          result.batchId !== batch.batchId ||
          result.generation !== generation ||
          result.committedEntries !== entriesToCommit.length
        ) {
          if (this.state.transcriptGeneration === generation) {
            this.state = {
              ...this.state,
              queuedTranscriptCount: Math.max(
                0,
                this.state.queuedTranscriptCount - entriesToCommit.length
              ),
            };
            this.commitMismatchRetries += 1;
            if (this.commitMismatchRetries > 1) {
              continueCommit = false;
              this.state = tuiUiReducer(this.state, {
                type: 'setStatus',
                message: 'TUI transcript acknowledgement mismatch; retained content for retry.',
              });
            }
          }
          void this.surface?.forceRedraw(this.buildLiveFrame(this.width));
          return;
        }
        const acknowledgement = acknowledgeTranscriptCommit(this.state, {
          generation,
          recordIds: result.displayKeys ?? [],
        });
        if (!acknowledgement.accepted) {
          if (this.state.transcriptGeneration === generation) {
            this.state = {
              ...this.state,
              queuedTranscriptCount: Math.max(
                0,
                this.state.queuedTranscriptCount - entriesToCommit.length
              ),
            };
            this.commitMismatchRetries += 1;
            if (this.commitMismatchRetries > 1) {
              continueCommit = false;
              this.state = tuiUiReducer(this.state, {
                type: 'setStatus',
                message: 'TUI transcript acknowledgement mismatch; retained content for retry.',
              });
            }
          }
          void this.surface?.forceRedraw(this.buildLiveFrame(this.width));
          return;
        }
        this.state = acknowledgement.state;
        this.commitMismatchRetries = 0;
        this.counters.commitCount += 1;
      })
      .catch(error => this.handleSurfaceError(error))
      .finally(() => {
        this.commitInFlight = false;
        if (!this.surfaceFailed && continueCommit) this.tryCommit(this.state, true);
      });
  }

  /** Layout a transcript record once per revision/width/theme combination. */
  private layoutTranscriptRecord(entry: TuiTranscriptRecord, width: number): StyledRow[] {
    const cached = this.transcriptCache.get(
      entry.id,
      entry.revision,
      this.state.transcriptGeneration,
      width,
      this.themeId
    );
    if (cached) return cached;

    const rows = layoutTranscriptEntry(entry, {
      width,
      theme: this.theme,
      toolOutputMode: this.state.toolOutputViewMode,
    });
    this.transcriptCache.set(
      entry.id,
      entry.revision,
      rows,
      this.state.transcriptGeneration,
      width,
      this.themeId
    );
    return rows;
  }

  private get transcriptWidth(): number {
    return this.surface ? Math.max(1, this.width - 1) : Math.max(1, this.width);
  }

  private transcriptLayoutOptions() {
    return {
      transcriptWidth: this.transcriptWidth,
      theme: this.theme,
      toolOutputMode: this.state.toolOutputViewMode,
      layoutTranscriptRecord: (entry: TuiTranscriptRecord, width: number) =>
        this.layoutTranscriptRecord(entry, width),
    };
  }

  private handleSurfaceError(error: unknown): void {
    if (this.surfaceFailed) return;
    this.surfaceFailed = true;
    const message = error instanceof Error ? error.message : String(error);
    this.state = tuiUiReducer(this.state, {
      type: 'setStatus',
      message: `TUI output error: ${message}`,
    });
    this.options.onSurfaceError?.(error);
  }

  private applyInputEvent(event: TuiInputEvent): void {
    if (this.state.inspector) {
      this.applyInspectorInput(event);
      return;
    }
    if (this.state.overlay?.type === 'permission') {
      if (event.type === 'text') {
        const answer = event.value.trim().toLowerCase();
        if (answer === 'y' || answer === 'yes') {
          this.answerPermission(true);
          return;
        }
        if (answer === 'n' || answer === 'no') {
          this.answerPermission(false);
          return;
        }
        return;
      }
      // Ignore paste and non-escape keys during permission overlay
      if (event.type === 'paste') return;
    }

    switch (event.type) {
      case 'text':
      case 'paste':
        if (event.type === 'text' && event.value === '?' && this.state.prompt.value === '') {
          this.dispatch({ type: 'showShortcuts' });
          return;
        }
        this.updatePrompt(
          insertAtCursor(this.state.prompt.value, this.state.prompt.cursor, event.value)
        );
        return;
      case 'key':
        this.applyKey(event.key);
        return;
    }
  }

  private applyKey(key: TuiKey): void {
    const { value, cursor } = this.state.prompt;
    const overlay = this.state.overlay;

    if (overlay?.type === 'sessions') {
      switch (key) {
        case 'up':
          this.dispatch({ type: 'moveOverlaySelection', delta: -1 });
          return;
        case 'down':
        case 'tab':
          this.dispatch({ type: 'moveOverlaySelection', delta: 1 });
          return;
        case 'pageup':
          this.dispatch({
            type: 'moveOverlaySelection',
            delta: -Math.max(1, overlay.request.maxVisibleItems ?? 10),
          });
          return;
        case 'pagedown':
          this.dispatch({
            type: 'moveOverlaySelection',
            delta: Math.max(1, overlay.request.maxVisibleItems ?? 10),
          });
          return;
        case 'enter':
          this.submitPrompt({ allowEmpty: true });
          return;
      }
    }

    if (overlay?.type === 'edit') {
      switch (key) {
        case 'up':
          this.dispatch({ type: 'moveOverlaySelection', delta: -1 });
          return;
        case 'down':
        case 'tab':
          this.dispatch({ type: 'moveOverlaySelection', delta: 1 });
          return;
        case 'pageup':
          this.dispatch({ type: 'moveOverlaySelection', delta: -10 });
          return;
        case 'pagedown':
          this.dispatch({ type: 'moveOverlaySelection', delta: 10 });
          return;
        case 'enter':
        case 'escape':
          this.dispatch({ type: 'closeOverlay' });
          return;
      }
    }

    if (overlay?.type === 'commands') {
      switch (key) {
        case 'up':
          this.dispatch({ type: 'moveOverlaySelection', delta: -1 });
          return;
        case 'down':
          this.dispatch({ type: 'moveOverlaySelection', delta: 1 });
          return;
        case 'pageup':
          this.dispatch({ type: 'moveOverlaySelection', delta: -10 });
          return;
        case 'pagedown':
          this.dispatch({ type: 'moveOverlaySelection', delta: 10 });
          return;
        case 'tab':
          this.completeCommand(overlay.items[overlay.selectedIndex], false);
          return;
        case 'enter':
          if (/^\/(?:tool-output|redraw)(?:\s|$)/u.test(this.state.prompt.value.trim())) {
            this.dispatch({ type: 'closeOverlay' });
            this.submitPrompt();
            return;
          }
          this.completeCommand(overlay.items[overlay.selectedIndex], true);
          return;
        case 'escape':
          this.dispatch({ type: 'closeOverlay' });
          return;
      }
    }

    if (overlay?.type === 'files') {
      switch (key) {
        case 'up':
          this.dispatch({ type: 'moveOverlaySelection', delta: -1 });
          return;
        case 'down':
          this.dispatch({ type: 'moveOverlaySelection', delta: 1 });
          return;
        case 'pageup':
          this.dispatch({ type: 'moveOverlaySelection', delta: -10 });
          return;
        case 'pagedown':
          this.dispatch({ type: 'moveOverlaySelection', delta: 10 });
          return;
        case 'tab':
        case 'enter':
          this.completeFile(overlay.items[overlay.selectedIndex]);
          return;
        case 'escape':
          this.dispatch({ type: 'closeOverlay' });
          return;
      }
    }

    if (overlay?.type === 'shortcuts') {
      switch (key) {
        case 'enter':
        case 'escape':
          this.dispatch({ type: 'closeOverlay' });
          return;
      }
    }

    if (overlay?.type === 'permission') {
      switch (key) {
        case 'up':
          this.dispatch({ type: 'moveOverlaySelection', delta: -1 });
          return;
        case 'down':
        case 'tab':
          this.dispatch({ type: 'moveOverlaySelection', delta: 1 });
          return;
        case 'enter':
          this.answerPermission(overlay.selectedIndex === 0);
          return;
        case 'escape':
        case 'ctrl+c':
          this.answerPermission(false);
          return;
      }
      return;
    }

    switch (key) {
      case 'ctrl+o':
        this.openToolInspector();
        return;
      case 'ctrl+l':
        this.forceOwnedRedraw();
        return;
      case 'enter':
        this.submitPrompt();
        return;
      case 'newline':
        this.updatePrompt(insertAtCursor(value, cursor, '\n'));
        return;
      case 'backspace':
        this.updatePrompt(deleteBeforeCursor(value, cursor));
        return;
      case 'delete':
        this.updatePrompt(deleteAfterCursor(value, cursor));
        return;
      case 'left':
        this.dispatch({ type: 'setPrompt', value, cursor: previousBoundary(value, cursor) });
        return;
      case 'right':
        this.dispatch({ type: 'setPrompt', value, cursor: nextBoundary(value, cursor) });
        return;
      case 'home':
        this.moveCursorLineHome();
        return;
      case 'end':
        this.moveCursorLineEnd();
        return;
      case 'ctrl+u':
        this.dispatch({ type: 'setPrompt', value: '', cursor: 0 });
        this.dispatch({ type: 'closeOverlay' });
        return;
      case 'ctrl+w':
        this.updatePrompt(deleteWordBeforeCursor(value, cursor));
        return;
      case 'ctrl+c':
        this.options.onCtrlC?.();
        return;
      case 'escape':
        this.dispatch({ type: 'closeOverlay' });
        return;
      case 'tab':
        if (value.startsWith('/')) {
          this.syncPromptOverlay(value);
        } else if (getFileQuery(value)) {
          this.syncPromptOverlay(value);
        }
        return;
      case 'up':
        this.moveCursorUpOrHistory();
        return;
      case 'down':
        this.moveCursorDownOrHistory();
        return;
    }
  }

  /** Navigate to previous history entry. */
  private historyBack(): void {
    if (this.state.overlay) return; // overlay handles up/down itself
    const { value } = this.state.prompt;
    const next = historyPrevious(this.history, value);
    this.history = next;
    const displayValue = historyCurrentValue(next, value);
    this.dispatch({ type: 'setPrompt', value: displayValue, cursor: displayValue.length });
  }

  /** Navigate to next history entry (or back to draft). */
  private historyForward(): void {
    if (this.state.overlay) return;
    const { value } = this.state.prompt;
    const next = historyNext(this.history);
    this.history = next;
    const displayValue = historyCurrentValue(next, value);
    this.dispatch({ type: 'setPrompt', value: displayValue, cursor: displayValue.length });
  }

  /**
   * Up in a multi-line prompt moves the cursor to the previous visual line;
   * only at the first line does it fall back to command history (matching
   * shell/editor behaviour). Single-line prompts behave exactly as before.
   */
  private moveCursorUpOrHistory(): void {
    if (this.state.overlay) return;
    const { value, cursor } = this.state.prompt;
    const { line, col } = lineColOfCursor(value, cursor);
    if (line > 0) {
      this.dispatch({ type: 'setPrompt', value, cursor: cursorOfLineCol(value, line - 1, col) });
    } else {
      this.historyBack();
    }
  }

  /**
   * Down in a multi-line prompt moves the cursor to the next visual line;
   * only at the last line does it fall back to command history.
   */
  private moveCursorDownOrHistory(): void {
    if (this.state.overlay) return;
    const { value, cursor } = this.state.prompt;
    const lines = value.split('\n');
    const { line, col } = lineColOfCursor(value, cursor);
    if (line < lines.length - 1) {
      this.dispatch({ type: 'setPrompt', value, cursor: cursorOfLineCol(value, line + 1, col) });
    } else {
      this.historyForward();
    }
  }

  /** Home: move to the start of the current visual line (not whole buffer). */
  private moveCursorLineHome(): void {
    if (this.state.overlay) return;
    const { value, cursor } = this.state.prompt;
    const { line } = lineColOfCursor(value, cursor);
    this.dispatch({ type: 'setPrompt', value, cursor: cursorOfLineCol(value, line, 0) });
  }

  /** End: move to the end of the current visual line (not whole buffer). */
  private moveCursorLineEnd(): void {
    if (this.state.overlay) return;
    const { value, cursor } = this.state.prompt;
    const { line } = lineColOfCursor(value, cursor);
    const lines = value.split('\n');
    this.dispatch({
      type: 'setPrompt',
      value,
      cursor: cursorOfLineCol(value, line, lines[line].length),
    });
  }

  private submitPrompt(options: { allowEmpty?: boolean } = {}): void {
    const input = this.state.prompt.value;
    if (!input.trim() && !options.allowEmpty) return;
    // Push to history before clearing.
    this.history = pushHistoryEntry(this.history, input);
    this.dispatch({ type: 'setPrompt', value: '', cursor: 0 });
    if (this.handleLocalCommand(input)) return;
    try {
      const submission = this.options.onSubmit?.(input);
      if (submission) {
        void submission.catch(() => this.reportSubmitFailure());
      }
    } catch {
      this.reportSubmitFailure();
    }
  }

  private reportSubmitFailure(): void {
    this.events.append({ role: 'error', content: 'Input submission failed.' });
  }

  private handleLocalCommand(input: string): boolean {
    const command = input.trim();
    if (command === '/redraw') {
      this.forceOwnedRedraw();
      return true;
    }
    const match = command.match(/^\/tool-output(?:\s+(adaptive|collapsed|full))?$/u);
    if (match) {
      const mode = match[1] as TuiUiState['toolOutputViewMode'] | undefined;
      if (mode) this.dispatch({ type: 'setToolOutputViewMode', mode });
      this.dispatch({
        type: 'setStatus',
        message: `tool output: ${mode ?? this.state.toolOutputViewMode}`,
      });
      return true;
    }
    if (command.startsWith('/tool-output')) {
      this.dispatch({
        type: 'setStatus',
        message: 'Usage: /tool-output adaptive|collapsed|full',
      });
      return true;
    }
    return false;
  }

  private forceOwnedRedraw(): void {
    if (this.surface && !this.surfaceFailed) {
      void this.surface
        .forceRedraw(this.buildLiveFrame(this.width))
        .catch(error => this.handleSurfaceError(error));
      return;
    }
    this.lastFrame = null;
    this.scheduler.request('immediate');
  }

  private updatePrompt(next: { value: string; cursor: number }): void {
    this.dispatch({ type: 'setPrompt', value: next.value, cursor: next.cursor });
    this.syncPromptOverlay(next.value);
  }

  private syncPromptOverlay(value: string): void {
    if (this.state.overlay?.type === 'shortcuts' && value.trim()) {
      this.dispatch({ type: 'closeOverlay' });
    }

    if (value.startsWith('/')) {
      this.dispatch({
        type: 'showCommandPalette',
        query: value.slice(1),
        items: visibleTuiCommandItems(value),
      });
      return;
    }

    const fileQuery = getFileQuery(value);
    if (fileQuery) {
      this.dispatch({
        type: 'showFilePicker',
        base: fileQuery.base,
        query: fileQuery.query,
        items: visibleFileItems(this.options.cwd ?? process.cwd(), value),
      });
      return;
    }

    if (this.state.overlay?.type === 'commands' || this.state.overlay?.type === 'files') {
      this.dispatch({ type: 'closeOverlay' });
    }
  }

  private completeCommand(item: TuiPickerItem | undefined, submitImmediately: boolean): void {
    if (!item) return;
    const command = getCommands().find(candidate => candidate.name === item.value);
    const needsArgs =
      item.value === 'tool-output' ||
      Boolean(command?.argumentHint || command?.params?.some(param => param.required));
    const value = `/${item.value}${needsArgs ? ' ' : ''}`;
    const promptAlreadyMatchesCommand = this.state.prompt.value.trim() === `/${item.value}`;
    const nextValue = promptAlreadyMatchesCommand ? `/${item.value}` : value;
    this.dispatch({ type: 'closeOverlay' });
    this.dispatch({ type: 'setPrompt', value: nextValue, cursor: nextValue.length });
    if (submitImmediately && (!needsArgs || promptAlreadyMatchesCommand)) {
      this.submitPrompt();
    }
  }

  private completeFile(item: TuiPickerItem | undefined): void {
    if (!item) return;
    const fileQuery = getFileQuery(this.state.prompt.value);
    if (!fileQuery) return;
    const value = `${fileQuery.base}@${item.value}${item.value.endsWith('/') ? '' : ' '}`;
    this.dispatch({ type: 'closeOverlay' });
    this.dispatch({ type: 'setPrompt', value, cursor: value.length });
  }

  private answerPermission(approved: boolean): void {
    const overlay = this.state.overlay;
    if (overlay?.type !== 'permission') return;
    this.dispatch({ type: 'closeOverlay' });
    void this.options.onPermissionDecision?.(overlay.request.id, approved);
  }

  /** Restore any temporary Inspector terminal ownership before shutdown. */
  async closeModalSurface(): Promise<void> {
    if (this.state.inspector || this.inspectorSurface?.isMounted) {
      this.closeToolInspector();
    }
    await this.modalTransition;
  }

  /** Wait until the current Inspector ownership transition is complete. */
  async waitForModalSurface(): Promise<void> {
    await this.modalTransition;
  }

  /** Flush every finalized transcript batch, including batches queued by acknowledgements. */
  async flushTranscriptCommits(): Promise<void> {
    if (!this.surface || this.surfaceFailed) return;
    for (let attempt = 0; attempt < 1024; attempt += 1) {
      await this.surface.whenIdle();
      await Promise.resolve();
      if (!this.commitInFlight && pendingCommitRecords(this.state).length === 0) return;
      if (!this.commitInFlight) this.tryCommit(this.state, true);
    }
    throw new Error('TUI transcript commits did not settle');
  }

  private openToolInspector(): void {
    if (this.state.inspector || !this.inspectorController || !this.inspectorSurface) return;
    this.inputOwnership.capture('inspector', {
      value: this.state.prompt.value,
      cursor: this.state.prompt.cursor,
      parserState: this.parser.getState(),
    });
    this.state = tuiUiReducer(this.state, { type: 'openToolInspector' });
    this.inspectorReady = false;
    this.inspectorSearchActive = false;
    this.modalTransition = this.modalTransition
      .then(async () => {
        await this.surface?.suspend();
        this.inspectorReady = true;
        await this.inspectorSurface!.mount(this.buildInspectorFrame());
      })
      .catch(error => this.handleSurfaceError(error));
  }

  private closeToolInspector(): void {
    if (!this.state.inspector && !this.inspectorSurface?.isMounted) return;
    this.inspectorController?.cancel();
    this.state = tuiUiReducer(this.state, { type: 'closeToolInspector' });
    const snapshot = this.inputOwnership.restore();
    if (snapshot) {
      this.parser.setState(snapshot.parserState);
      this.state = tuiUiReducer(this.state, {
        type: 'setPrompt',
        value: snapshot.value,
        cursor: snapshot.cursor,
      });
    }
    this.inspectorReady = false;
    this.inspectorSearchActive = false;
    this.modalTransition = this.modalTransition
      .then(async () => {
        await this.inspectorSurface?.unmount();
        if (this.surface) {
          await this.surface.restore(
            () => this.buildLiveFrame(this.width),
            this.width,
            this.height
          );
        }
        this.scheduler.request('immediate');
      })
      .catch(error => this.handleSurfaceError(error));
  }

  private applyInspectorInput(event: TuiInputEvent): void {
    if (event.type === 'paste') return;
    if (event.type === 'text') {
      if (!this.inspectorSearchActive) {
        if (event.value === 'j') {
          this.moveInspectorSelection(1);
          return;
        }
        if (event.value === 'k') {
          this.moveInspectorSelection(-1);
          return;
        }
        if (event.value === ' ') {
          void this.loadSelectedInspectorDetail(false);
          return;
        }
        if (event.value === 'g') {
          this.moveInspectorSelectionTo('first');
          return;
        }
        if (event.value === 'G') {
          this.moveInspectorSelectionTo('last');
          return;
        }
        if (event.value === 'n' && this.state.inspector?.searchQuery) {
          this.moveInspectorSelection(1, true);
          return;
        }
        if (event.value === 'N' && this.state.inspector?.searchQuery) {
          this.moveInspectorSelection(-1, true);
          return;
        }
        if (event.value === 'v') {
          this.openSelectedInspectorDetailInEditor();
          return;
        }
      }
      if (!this.inspectorSearchActive && (event.value === 'q' || event.value === 'Q')) {
        this.closeToolInspector();
        return;
      }
      if (!this.inspectorSearchActive && event.value === '/') {
        this.inspectorSearchActive = true;
        this.state = tuiUiReducer(this.state, { type: 'setToolInspectorSearch', query: '' });
        this.paintInspector();
        return;
      }
      if (!this.inspectorSearchActive && event.value === '[') {
        this.exportInspectorResults();
        return;
      }
      if (this.inspectorSearchActive) {
        const query = `${this.state.inspector?.searchQuery ?? ''}${event.value}`;
        this.state = tuiUiReducer(this.state, { type: 'setToolInspectorSearch', query });
        this.paintInspector();
      }
      return;
    }

    switch (event.key) {
      case 'ctrl+o':
      case 'escape':
        this.closeToolInspector();
        return;
      case 'ctrl+c':
        this.closeToolInspector();
        return;
      case 'up':
        this.moveInspectorSelection(-1);
        return;
      case 'down':
        this.moveInspectorSelection(1);
        return;
      case 'pageup':
      case 'ctrl+u':
        this.state = tuiUiReducer(this.state, { type: 'scrollToolInspector', delta: -10 });
        this.paintInspector();
        return;
      case 'pagedown':
      case 'ctrl+d':
        this.state = tuiUiReducer(this.state, { type: 'scrollToolInspector', delta: 10 });
        void this.loadSelectedInspectorDetail(true);
        return;
      case 'home':
        this.moveInspectorSelectionTo('first');
        return;
      case 'end':
        this.moveInspectorSelectionTo('last');
        return;
      case 'backspace': {
        if (!this.inspectorSearchActive) return;
        const query = this.state.inspector?.searchQuery ?? '';
        this.state = tuiUiReducer(this.state, {
          type: 'setToolInspectorSearch',
          query: query.slice(0, -1),
        });
        this.paintInspector();
        return;
      }
      case 'enter':
        if (this.inspectorSearchActive) {
          this.inspectorSearchActive = false;
          this.paintInspector();
          return;
        }
        void this.loadSelectedInspectorDetail(false);
        return;
      case 'ctrl+e':
        this.state = tuiUiReducer(this.state, { type: 'toggleAllToolInspectorEntries' });
        this.paintInspector();
        return;
      case 'ctrl+l':
        this.paintInspector();
        return;
    }
  }

  private async loadSelectedInspectorDetail(append: boolean): Promise<void> {
    const inspector = this.state.inspector;
    if (!inspector || !this.inspectorController) return;
    const view = this.inspectorController.view(this.state.recentToolDetails, inspector);
    const selected = view.selected;
    if (!selected) return;
    const expanded = inspector.expandedCallIds.includes(selected.callId);
    if (!append && expanded) {
      this.state = tuiUiReducer(this.state, {
        type: 'toggleToolInspectorEntry',
        callId: selected.callId,
      });
      this.paintInspector();
      return;
    }
    if (!expanded) {
      this.state = tuiUiReducer(this.state, {
        type: 'toggleToolInspectorEntry',
        callId: selected.callId,
      });
    }
    this.paintInspector();
    await this.inspectorController.load(
      selected,
      append && view.detail?.nextOffsetBytes !== undefined
    );
    if (this.state.inspector) this.paintInspector();
  }

  private moveInspectorSelection(delta: number, wrap = false): void {
    const inspector = this.state.inspector;
    if (!inspector || !this.inspectorController) return;
    const view = this.inspectorController.view(this.state.recentToolDetails, inspector);
    if (view.entries.length === 0) return;
    const target = wrap
      ? (view.selectedIndex + delta + view.entries.length) % view.entries.length
      : Math.max(0, Math.min(view.entries.length - 1, view.selectedIndex + delta));
    this.inspectorController.cancel();
    this.state = tuiUiReducer(this.state, { type: 'setToolInspectorSelection', index: target });
    this.paintInspector();
  }

  private moveInspectorSelectionTo(edge: 'first' | 'last'): void {
    const inspector = this.state.inspector;
    if (!inspector || !this.inspectorController) return;
    const view = this.inspectorController.view(this.state.recentToolDetails, inspector);
    if (view.entries.length === 0) return;
    this.inspectorController.cancel();
    this.state = tuiUiReducer(this.state, {
      type: 'setToolInspectorSelection',
      index: edge === 'first' ? 0 : view.entries.length - 1,
    });
    this.paintInspector();
  }

  private exportInspectorResults(): void {
    const inspector = this.state.inspector;
    if (!inspector || !this.inspectorController) return;
    const entries = this.inspectorController.view(this.state.recentToolDetails, inspector).entries;
    this.closeToolInspector();
    this.modalTransition = this.modalTransition
      .then(async () => {
        if (!this.surface) {
          this.state = tuiUiReducer(this.state, {
            type: 'setStatus',
            message: 'Inspector export requires an inline terminal surface.',
          });
          return;
        }
        for (const entry of entries) {
          let pageIndex = 0;
          for await (const page of this.inspectorController!.readPages(entry)) {
            const heading = pageIndex === 0 ? `#${entry.sequence} ${entry.toolName}\n` : '';
            const rows = layoutTranscriptEntry(
              {
                role: 'tool',
                content: `${heading}${page.content}`,
              },
              {
                width: this.transcriptWidth,
                theme: this.theme,
                toolOutputMode: 'full',
              }
            );
            await this.surface.commit(
              {
                batchId: `tui-inspector-export-${++this.commitSequence}`,
                generation: this.state.transcriptGeneration,
                reason: 'append',
                entries: [
                  {
                    displayKey: `inspector-export-${entry.callId}-${pageIndex}`,
                    rows,
                  },
                ],
              },
              () => this.buildLiveFrame(this.width)
            );
            pageIndex += 1;
          }
        }
        this.state = tuiUiReducer(this.state, {
          type: 'setStatus',
          message: `Exported ${entries.length} tool result${entries.length === 1 ? '' : 's'} to scrollback.`,
        });
        this.scheduler.request('immediate');
      })
      .catch(error => this.handleSurfaceError(error));
  }

  private openSelectedInspectorDetailInEditor(): void {
    const inspector = this.state.inspector;
    if (!inspector || !this.inspectorController) return;
    const selected = this.inspectorController.view(
      this.state.recentToolDetails,
      inspector
    ).selected;
    if (!selected) return;
    if (!this.options.onOpenExternalEditor) {
      this.state = tuiUiReducer(this.state, {
        type: 'setStatus',
        message: 'External editor is unavailable in this TUI environment.',
      });
      this.paintInspector();
      return;
    }
    this.closeToolInspector();
    this.modalTransition = this.modalTransition
      .then(async () => {
        const directory = await mkdtemp(join(tmpdir(), 'orion-code-tool-'));
        const filePath = join(
          directory,
          `${selected.sequence}-${safeFileName(selected.toolName)}.txt`
        );
        try {
          await this.inspectorController!.writeDetailToFile(selected, filePath);
          await this.options.onOpenExternalEditor!(filePath);
          this.state = tuiUiReducer(this.state, {
            type: 'setStatus',
            message: `Viewed #${selected.sequence} ${selected.toolName} in external editor.`,
          });
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
        this.forceOwnedRedraw();
      })
      .catch(error => {
        this.state = tuiUiReducer(this.state, {
          type: 'setStatus',
          message: `External editor failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        this.forceOwnedRedraw();
      });
  }

  private paintInspector(): void {
    if (
      !this.state.inspector ||
      !this.inspectorController ||
      !this.inspectorSurface ||
      !this.inspectorReady
    )
      return;
    const frame = this.buildInspectorFrame();
    this.lastFrame = frame;
    void this.inspectorSurface.paint(frame).catch(error => this.handleSurfaceError(error));
  }

  private buildInspectorFrame(): TuiFrame {
    const inspector = this.state.inspector;
    const view =
      inspector && this.inspectorController
        ? this.inspectorController.view(this.state.recentToolDetails, inspector)
        : {
            entries: [],
            selectedIndex: 0,
            expandedCallIds: [],
            searchQuery: '',
            detailOffset: 0,
          };
    return renderTranscriptInspectorFrame(view, {
      width: this.width,
      height: this.height,
      theme: this.theme,
    });
  }
}

function insertAtCursor(
  value: string,
  cursor: number,
  text: string
): { value: string; cursor: number } {
  const safeCursor = clampCursor(value, cursor);
  return {
    value: value.slice(0, safeCursor) + text + value.slice(safeCursor),
    cursor: safeCursor + text.length,
  };
}

function visibleTuiCommandItems(input: string): TuiPickerItem[] {
  const query = input.startsWith('/')
    ? input.slice(1).trim().split(/\s+/u, 1)[0].toLowerCase()
    : '';
  const local: TuiPickerItem[] = [
    {
      value: 'tool-output',
      label: '/tool-output',
      description: 'Set TUI tool output mode',
    },
    {
      value: 'redraw',
      label: '/redraw',
      description: 'Redraw the TUI-owned live region',
    },
  ].filter(item => item.value.includes(query));
  const localNames = new Set(local.map(item => item.value));
  return [...local, ...visibleCommandItems(input).filter(item => !localNames.has(item.value))];
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'tool';
}

function deleteBeforeCursor(value: string, cursor: number): { value: string; cursor: number } {
  const safeCursor = clampCursor(value, cursor);
  if (safeCursor === 0) return { value, cursor: 0 };
  const previous = previousBoundary(value, safeCursor);
  return {
    value: value.slice(0, previous) + value.slice(safeCursor),
    cursor: previous,
  };
}

function deleteAfterCursor(value: string, cursor: number): { value: string; cursor: number } {
  const safeCursor = clampCursor(value, cursor);
  if (safeCursor >= value.length) return { value, cursor: safeCursor };
  const next = nextBoundary(value, safeCursor);
  return {
    value: value.slice(0, safeCursor) + value.slice(next),
    cursor: safeCursor,
  };
}

function deleteWordBeforeCursor(value: string, cursor: number): { value: string; cursor: number } {
  const safeCursor = clampCursor(value, cursor);
  const before = value.slice(0, safeCursor).replace(/\s*\S+\s*$/u, '');
  return {
    value: before + value.slice(safeCursor),
    cursor: before.length,
  };
}

function previousBoundary(value: string, cursor: number): number {
  const safeCursor = clampCursor(value, cursor);
  let previous = 0;
  for (const boundary of graphemeBoundaries(value)) {
    if (boundary >= safeCursor) break;
    previous = boundary;
  }
  return previous;
}

function nextBoundary(value: string, cursor: number): number {
  const safeCursor = clampCursor(value, cursor);
  for (const boundary of graphemeBoundaries(value)) {
    if (boundary > safeCursor) return boundary;
  }
  return value.length;
}

function graphemeBoundaries(value: string): number[] {
  const Segmenter = (Intl as any).Segmenter;
  if (!Segmenter) {
    const boundaries: number[] = [0];
    let index = 0;
    for (const char of Array.from(value)) {
      index += char.length;
      boundaries.push(index);
    }
    return boundaries;
  }

  const segmenter = new Segmenter(undefined, { granularity: 'grapheme' });
  const boundaries = [0];
  for (const part of segmenter.segment(value) as Iterable<{ index: number; segment: string }>) {
    boundaries.push(part.index + part.segment.length);
  }
  return Array.from(new Set(boundaries)).sort((left, right) => left - right);
}

function clampCursor(value: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return value.length;
  return Math.min(Math.max(0, Math.floor(cursor)), value.length);
}

/** Map an absolute character cursor to {line, col} within a multi-line value. */
function lineColOfCursor(value: string, cursor: number): { line: number; col: number } {
  const lines = value.split('\n');
  const safeCursor = clampCursor(value, cursor);
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

/** Map a {line, col} back to an absolute character cursor within a multi-line value. */
function cursorOfLineCol(value: string, line: number, col: number): number {
  const lines = value.split('\n');
  const safeLine = Math.max(0, Math.min(line, lines.length - 1));
  let offset = 0;
  for (let i = 0; i < safeLine; i++) {
    offset += lines[i].length + 1;
  }
  return offset + Math.max(0, Math.min(col, lines[safeLine].length));
}
