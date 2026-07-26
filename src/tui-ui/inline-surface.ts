/**
 * InlineTerminalSurface: primary-screen inline TUI surface.
 *
 * Replaces the alternate-screen (1049) approach. Finalized transcript
 * content is committed once to stdout (entering shell native scrollback),
 * while the bottom live region holds only ephemeral content (streaming
 * assistant, running tools, overlay, status, prompt).
 *
 * Control sequences used (relative addressing only):
 *   CR       \r             return to column 0
 *   EL2      \x1b[2K        erase current line
 *   CUU(n)   \x1b[<n>A      cursor up (relative)
 *   CUD(n)   \x1b[<n>B      cursor down (relative)
 *   CUF(n)   \x1b[<n>C      cursor forward (relative)
 *   SGR0     \x1b[0m        reset style
 *   DECTCEM  \x1b[?25l/?25h hide/show cursor
 *   DECAWM   \x1b[?7l/?7h   disable/enable autowrap (paint batch)
 *
 * Forbidden (never emitted):
 *   \x1b[?1049h / \x1b[?1049l  (alternate screen)
 *   CSI row;col H / f         (absolute cursor positioning)
 *   CSI 2J                     (full screen clear)
 *   mouse reporting, OSC52, OSC8
 *
 * All operations are serialized via an internal FIFO queue so commit,
 * renderLive, resize, suspend, and unmount never interleave on the same stream.
 */

import { renderStyledFrameRow, type TuiFrame } from '../tui-core/frame';
import { encodeStyleToSgr, SGR_RESET, shouldSuppressColor, styleKey } from '../tui-core/style';

/** Minimal output stream interface. */
export type SurfaceOutputEvent = 'drain' | 'error' | 'close';

export interface SurfaceOutput {
  write(chunk: string | Uint8Array): boolean;
  on(event: SurfaceOutputEvent, listener: (error?: unknown) => void): this;
  off(event: SurfaceOutputEvent, listener: (error?: unknown) => void): this;
  readonly writable: boolean;
}

export interface InlineSurfaceOptions {
  output: SurfaceOutput;
  /** Inject for deterministic tests. */
  now?: () => number;
}

export type SurfacePhase = 'idle' | 'mounted' | 'suspended' | 'unmounted' | 'failed';

export interface InlineSurfaceState {
  phase: SurfacePhase;
  width: number;
  height: number;
  /** Height of the bottom live band. */
  liveBandRows: number;
  /** Rows currently owned by the inline live block. */
  liveRegionCapacity: number;
  cursorRow: number;
  cursorColumn: number;
  previousFrame: TuiFrame | null;
}

/** A committed transcript entry rendered to styled rows. */
export interface CommittedEntry {
  displayKey: string;
  rows: { text: string; style?: import('../tui-core/style').TuiStyle }[][];
}

export interface TranscriptCommitBatch {
  batchId?: string;
  generation: number;
  reason: 'append' | 'finalize' | 'restore' | 'replace' | 'clear-divider';
  entries: CommittedEntry[];
}

export interface TuiTerminalRenderResult {
  output: string;
  committedEntries: number;
  batchId?: string;
  generation?: number;
  displayKeys?: string[];
}

/**
 * Get the latest live frame for rendering after a commit.
 * The runner provides this so commit + finalize interleaving uses fresh state.
 */
export type LiveFrameProvider = () => TuiFrame | null;

const CR = '\r';
const EL2 = '\x1b[2K';
const ENABLE_BRACKETED_PASTE = '\x1b[?2004h';
const DISABLE_BRACKETED_PASTE = '\x1b[?2004l';
const SHOW_CURSOR = '\x1b[?25h';
const HIDE_CURSOR = '\x1b[?25l';
const DISABLE_AUTOWRAP = '\x1b[?7l';
const ENABLE_AUTOWRAP = '\x1b[?7h';

/** Fraction of the terminal height occupied by the bottom live band. */
const LIVE_BAND_RATIO = 0.75;

function cursorUp(n: number): string {
  return n > 0 ? `\x1b[${n}A` : '';
}
function cursorDown(n: number): string {
  return n > 0 ? `\x1b[${n}B` : '';
}

export class InlineTerminalSurface {
  private phase: SurfacePhase = 'idle';
  private width = 0;
  private height = 0;
  /** Height of the bottom live band (status + prompt + live tail). */
  private liveBandRows = 0;
  private liveRegionCapacity = 0;
  private cursorRow = 0;
  private cursorColumn = 0;
  private previousFrame: TuiFrame | null = null;
  /** Suppress stale-width live paints between SIGWINCH and the resize repaint. */
  private resizePending = false;
  private pendingResizeWidth: number | null = null;
  private resizeGeneration = 0;
  private resizeWaiters: Array<() => void> = [];
  private readonly output: SurfaceOutput;
  private readonly now: () => number;
  private readonly suppressColor: boolean;
  /** Serialized FIFO queue of pending operations. */
  private queue: Array<() => Promise<void>> = [];
  private processing = false;

  constructor(options: InlineSurfaceOptions) {
    this.output = options.output;
    this.now = options.now ?? (() => Date.now());
    this.suppressColor = shouldSuppressColor();
  }

  /** Compute the live band height (~75% of screen, min 8, max height-1). */
  private static computeBandRows(height: number): number {
    const h = Math.max(1, Math.floor(height));
    const minBand = 8;
    const maxBand = Math.max(minBand, h - 1); // leave >=1 history row when possible
    const desired = Math.round(h * LIVE_BAND_RATIO);
    return Math.max(minBand, Math.min(maxBand, desired));
  }

  /** Live band height for the runner to size its live frame. */
  getLiveBandRows(): number {
    return this.liveBandRows;
  }

  /** History area rows above the band (recently scrolled committed lines). */
  get historyAreaRows(): number {
    return Math.max(0, this.height - this.liveBandRows);
  }

  getState(): InlineSurfaceState {
    return {
      phase: this.phase,
      width: this.width,
      height: this.height,
      liveBandRows: this.liveBandRows,
      liveRegionCapacity: this.liveRegionCapacity,
      cursorRow: this.cursorRow,
      cursorColumn: this.cursorColumn,
      previousFrame: this.previousFrame,
    };
  }

  /** Mark the terminal as resizing before the debounced layout pass runs. */
  beginResize(width = this.width): number {
    this.resizeGeneration += 1;
    this.resizePending = true;
    this.pendingResizeWidth = Math.max(1, Math.floor(width));
    return this.resizeGeneration;
  }

  /**
   * Await completion of all queued operations.
   * Because the queue is strictly FIFO, enqueueing a no-op and awaiting it
   * guarantees every operation enqueued before this call has finished. Used by
   * tests to deterministically observe the terminal after a burst of renders.
   */
  whenIdle(): Promise<void> {
    return this.enqueue(async () => {});
  }

  /** Safe content width: never write the last column (avoid pending-wrap). */
  get safeContentWidth(): number {
    return Math.max(1, this.width - 1);
  }

  /** Enqueue an operation; FIFO guarantees no interleaving. */
  private enqueue(op: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          await op();
          resolve();
        } catch (err) {
          this.phase = 'failed';
          reject(err);
        }
      });
      this.drainQueue();
    });
  }

  private async drainQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    while (this.queue.length > 0) {
      const op = this.queue.shift()!;
      await op();
    }
    this.processing = false;
    // Re-check in case an enqueue happened during the last op's async yield.
    if (this.queue.length > 0) {
      void this.drainQueue();
    }
  }

  /** Mount: enable bracketed paste + hide cursor. NO alternate screen. */
  async mount(width: number, height: number): Promise<void> {
    await this.enqueue(async () => {
      if (this.phase !== 'idle') return;
      this.width = Math.max(1, Math.floor(width));
      this.height = Math.max(1, Math.floor(height));
      this.liveBandRows = InlineTerminalSurface.computeBandRows(this.height);
      this.phase = 'mounted';
      this.liveRegionCapacity = 0;
      this.cursorRow = 0;
      this.cursorColumn = 0;
      await this.writeRaw(`${ENABLE_BRACKETED_PASTE}${HIDE_CURSOR}`);
    });
  }

  /**
   * Commit finalized transcript entries to native scrollback.
   *
   * Protocol:
   *  1. Erase only the live rows owned by this surface and return to their top.
   *  2. Release that block and write finalized rows as ordinary line-oriented
   *     shell output. The terminal decides when those lines enter scrollback.
   *  3. Allocate a fresh live block from the resulting cursor and repaint the
   *     latest live frame below the committed output.
   */
  async commit(batch: TranscriptCommitBatch, getLatestLiveFrame: LiveFrameProvider): Promise<TuiTerminalRenderResult> {
    let output = '';
    for (;;) {
      let retryAfterResize = false;
      await this.enqueue(async () => {
        if (this.resizePending) {
          retryAfterResize = true;
          return;
        }

        // Committed output behaves like ordinary shell output. Keeping
        // autowrap enabled preserves an already-queued old-width batch if the
        // terminal changes size immediately before this operation executes.
        const chunks: string[] = [this.clearOwnedLiveRegion(), ENABLE_AUTOWRAP];
        this.releaseLiveRegion();

        for (const entry of batch.entries) {
          for (const row of entry.rows) {
            chunks.push(CR);
            for (const [index, span] of row.entries()) {
              if (index > 0) chunks.push(SGR_RESET);
              if (span.style) {
                const sgr = encodeStyleToSgr(span.style, this.suppressColor);
                if (sgr) chunks.push(sgr);
              }
              chunks.push(span.text);
            }
            chunks.push(SGR_RESET);
            chunks.push('\n');
          }
        }

        const liveFrame = getLatestLiveFrame();
        if (liveFrame) {
          chunks.push(this.renderLiveInternal(liveFrame));
        }
        output = chunks.join('');
        await this.writeRaw(output);
      });
      if (!retryAfterResize) break;
      await this.waitForResizeCompletion();
    }
    return {
      output,
      committedEntries: batch.entries.length,
      batchId: batch.batchId,
      generation: batch.generation,
      displayKeys: batch.entries.map(entry => entry.displayKey),
    };
  }

  /** Render the live region frame (relative addressing, changed-row diff). */
  async renderLive(frame: TuiFrame): Promise<string> {
    let output = '';
    const requestedDuringResize = this.resizePending;
    await this.enqueue(async () => {
      if (requestedDuringResize || this.resizePending) return;
      output = this.renderLiveInternal(frame);
      await this.writeRaw(output);
    });
    return output;
  }

  /** Forget the diff baseline and repaint only the currently owned live region. */
  async forceRedraw(frame: TuiFrame): Promise<string> {
    let output = '';
    await this.enqueue(async () => {
      if (this.phase !== 'mounted' || this.resizePending) return;
      this.previousFrame = null;
      output = this.renderLiveInternal(frame);
      await this.writeRaw(output);
    });
    return output;
  }

  private renderLiveInternal(frame: TuiFrame): string {
    const chunks: string[] = [];
    const requiredRows = Math.min(frame.height, Math.max(1, this.liveBandRows));

    // Allocate or resize the cursor-owned live block from the current cursor.
    chunks.push(this.ensureCapacity(requiredRows));

    // Disable autowrap while painting band rows: a row that fills the last
    // column (e.g. the full-width prompt border ┌─...─┐) would otherwise leave
    // the terminal in a pending-wrap state that corrupts the next row's
    // repaint. Re-enabled at the end of the batch.
    chunks.push(DISABLE_AUTOWRAP);

    const capacity = this.liveRegionCapacity;
    const prev = this.previousFrame;
    let row = this.cursorRow;

    // Only diff when the previous frame shares the same geometry (height and
    // capacity). Any geometry change (resize, first frame) triggers a full
    // repaint so we never leave stale rows behind.
    const canDiff = prev !== null && prev.height === capacity && frame.height === capacity;

    if (!canDiff) {
      // Full repaint: move to band top, clear every band row, then write every
      // frame row. Track the real cursor row in `row` so the final positioning
      // block below is exact.
      chunks.push(cursorUp(row));
      for (let i = 0; i < capacity; i++) {
        chunks.push(CR, EL2);
        if (i < capacity - 1) {
          chunks.push(cursorDown(1));
          row += 1;
        }
      }
      chunks.push(cursorUp(capacity - 1));
      row = 0;
      const frameRows = Math.min(frame.height, capacity);
      for (let r = 0; r < frameRows; r++) {
        chunks.push(...this.renderRowChunks(frame.rows[r] ?? []));
        if (r < frameRows - 1) {
          chunks.push(CR, cursorDown(1));
          row += 1;
        }
      }
    } else {
      // Changed-row diff: only repaint rows whose styled content differs from
      // the previous frame. Navigation moves the real cursor to the changed
      // row, clears it, and redraws — avoiding a full-band flicker on every
      // tick (e.g. while a tool is running and only the status line changes).
      for (let r = 0; r < capacity; r++) {
        const newRow = r < frame.height ? frame.rows[r] : [];
        const oldRow = r < prev!.height ? prev!.rows[r] : [];
        if (this.renderRowString(newRow) === this.renderRowString(oldRow)) continue;
        if (r < row) {
          chunks.push(cursorUp(row - r));
          row = r;
        } else if (r > row) {
          chunks.push(cursorDown(r - row));
          row = r;
        }
        chunks.push(CR, EL2);
        chunks.push(...this.renderRowChunks(newRow));
      }
    }

    // Position cursor at frame cursor using the precisely-tracked `row`.
    const targetRow = Math.min(frame.cursor.row, this.liveRegionCapacity - 1);
    const targetCol = Math.min(frame.cursor.column, Math.max(0, this.width - 1));
    if (targetRow < row) {
      chunks.push(cursorUp(row - targetRow));
      row = targetRow;
    } else if (targetRow > row) {
      chunks.push(cursorDown(targetRow - row));
      row = targetRow;
    }
    chunks.push(CR);
    if (targetCol > 0) chunks.push(`\x1b[${targetCol}C`);
    this.cursorRow = row;
    this.cursorColumn = targetCol;

    chunks.push(frame.cursor.visible ? SHOW_CURSOR : HIDE_CURSOR);
    chunks.push(ENABLE_AUTOWRAP);

    this.previousFrame = frame;
    return chunks.join('');
  }

  /** Render a single styled frame row to ANSI chunks (text + SGR + reset). */
  private renderRowChunks(row: TuiFrame['rows'][number]): string[] {
    const chunks: string[] = [];
    const spans = renderStyledFrameRow(this.trimDefaultTrailingCells(row));
    let emittedSgr = false;
    for (const [index, span] of spans.entries()) {
      if (index > 0) chunks.push(SGR_RESET);
      const sgr = encodeStyleToSgr(span.style, this.suppressColor);
      if (sgr) {
        chunks.push(sgr);
        emittedSgr = true;
      }
      chunks.push(span.text);
    }
    if (emittedSgr || spans.length > 1) chunks.push(SGR_RESET);
    return chunks;
  }

  /** Stable string form of a styled row, used for changed-row comparison. */
  private renderRowString(row: TuiFrame['rows'][number]): string {
    return this.renderRowChunks(row).join('');
  }

  private trimDefaultTrailingCells(
    row: TuiFrame['rows'][number],
  ): TuiFrame['rows'][number] {
    let end = row.length;
    while (end > 0) {
      const cell = row[end - 1];
      if (cell.char !== ' ' || styleKey(cell.style) !== '') break;
      end -= 1;
    }
    return row.slice(0, end);
  }

  private renderedRowWidth(row: TuiFrame['rows'][number]): number {
    return this.trimDefaultTrailingCells(row)
      .reduce((total, cell) => total + cell.width, 0);
  }

  /**
   * Ensure the surface owns exactly `requiredRows` rows starting at the current
   * cursor. Allocation uses ordinary newlines, so existing shell output is
   * preserved and may naturally move into terminal scrollback.
   */
  private ensureCapacity(requiredRows: number): string {
    const target = Math.min(requiredRows, Math.max(1, this.liveBandRows));
    const chunks: string[] = [];
    if (this.liveRegionCapacity !== target) {
      if (this.liveRegionCapacity > 0) {
        chunks.push(this.clearLiveRegion());
        this.releaseLiveRegion();
      }
      chunks.push(CR);
      for (let i = 1; i < target; i++) chunks.push('\n');
      chunks.push(cursorUp(target - 1), CR);
      this.liveRegionCapacity = target;
      this.cursorRow = 0;
      this.cursorColumn = 0;
      this.previousFrame = null;
    }
    return chunks.join('');
  }

  /** Clear the live band rows (relative, no absolute addressing). */
  private clearLiveRegion(): string {
    if (this.liveRegionCapacity === 0) return '';
    const chunks: string[] = [];
    chunks.push(cursorUp(this.cursorRow));
    for (let i = 0; i < this.liveRegionCapacity; i++) {
      chunks.push(CR, EL2);
      if (i < this.liveRegionCapacity - 1) chunks.push(cursorDown(1));
    }
    chunks.push(cursorUp(this.liveRegionCapacity - 1));
    this.cursorRow = 0;
    this.cursorColumn = 0;
    return chunks.join('');
  }

  /**
   * Clear the old live block after the terminal has already adopted a new
   * width. A previously full row can occupy multiple physical rows after
   * reflow, so tracked logical rows are not sufficient during resize.
   */
  private clearReflowedLiveRegion(nextWidth: number): string {
    if (this.liveRegionCapacity === 0) return '';
    if (!this.previousFrame) return this.clearLiveRegion();

    const physicalWidth = Math.max(1, Math.floor(nextWidth));
    const frame = this.previousFrame;
    const rowPhysicalHeights = Array.from(
      { length: this.liveRegionCapacity },
      (_, row) => {
        const cells = frame.rows[row] ?? [];
        const writtenWidth = this.renderedRowWidth(cells);
        return Math.max(1, Math.ceil(Math.max(1, writtenWidth) / physicalWidth));
      },
    );
    const logicalCursorRow = Math.min(this.cursorRow, rowPhysicalHeights.length - 1);
    const cursorPhysicalRow = rowPhysicalHeights
      .slice(0, logicalCursorRow)
      .reduce((total, rows) => total + rows, 0)
      + Math.floor(Math.max(0, this.cursorColumn) / physicalWidth);
    const physicalRows = rowPhysicalHeights.reduce((total, rows) => total + rows, 0);

    const chunks: string[] = [cursorUp(cursorPhysicalRow)];
    for (let row = 0; row < physicalRows; row += 1) {
      chunks.push(CR, EL2);
      if (row < physicalRows - 1) chunks.push(cursorDown(1));
    }
    chunks.push(cursorUp(physicalRows - 1));
    this.cursorRow = 0;
    this.cursorColumn = 0;
    return chunks.join('');
  }

  private clearOwnedLiveRegion(): string {
    return this.resizePending && this.pendingResizeWidth !== null
      ? this.clearReflowedLiveRegion(this.pendingResizeWidth)
      : this.clearLiveRegion();
  }

  private waitForResizeCompletion(): Promise<void> {
    if (!this.resizePending) return Promise.resolve();
    return new Promise<void>(resolve => this.resizeWaiters.push(resolve));
  }

  private completeResize(): void {
    this.resizePending = false;
    this.pendingResizeWidth = null;
    const waiters = this.resizeWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private releaseLiveRegion(): void {
    this.liveRegionCapacity = 0;
    this.cursorRow = 0;
    this.cursorColumn = 0;
    this.previousFrame = null;
  }

  /** Resize: erase only the owned block, then rebuild from the current cursor. */
  async resize(
    width: number,
    height: number,
    getLatestLiveFrame: LiveFrameProvider,
    generation = this.resizePending ? this.resizeGeneration : this.beginResize(width),
  ): Promise<void> {
    await this.enqueue(async () => {
      if (generation !== this.resizeGeneration) return;
      const chunks: string[] = [this.clearReflowedLiveRegion(width)];
      this.releaseLiveRegion();
      this.width = Math.max(1, Math.floor(width));
      this.height = Math.max(1, Math.floor(height));
      this.liveBandRows = InlineTerminalSurface.computeBandRows(this.height);
      const liveFrame = getLatestLiveFrame();
      if (liveFrame) {
        chunks.push(this.renderLiveInternal(liveFrame));
      }
      await this.writeRaw(chunks.join(''));
      if (generation === this.resizeGeneration) this.completeResize();
    });
  }

  /** Suspend for child process: clear live region, disable bracketed paste, show cursor. */
  async suspend(): Promise<void> {
    await this.enqueue(async () => {
      if (this.phase !== 'mounted') return;
      await this.writeRaw(
        `${this.clearOwnedLiveRegion()}${SGR_RESET}${SHOW_CURSOR}${DISABLE_BRACKETED_PASTE}${ENABLE_AUTOWRAP}`,
      );
      this.phase = 'suspended';
      this.releaseLiveRegion();
      this.completeResize();
    });
  }

  /** Restore after child process: re-enable bracketed paste, rebuild live frame. */
  async restore(
    getLatestLiveFrame: LiveFrameProvider,
    width = this.width,
    height = this.height,
  ): Promise<void> {
    await this.enqueue(async () => {
      if (this.phase !== 'suspended') return;
      this.width = Math.max(1, Math.floor(width));
      this.height = Math.max(1, Math.floor(height));
      this.liveBandRows = InlineTerminalSurface.computeBandRows(this.height);
      this.phase = 'mounted';
      const chunks = [`${ENABLE_BRACKETED_PASTE}${HIDE_CURSOR}`];
      const liveFrame = getLatestLiveFrame();
      if (liveFrame) {
        chunks.push(this.renderLiveInternal(liveFrame));
      }
      await this.writeRaw(chunks.join(''));
    });
  }

  /** Unmount: clear live region, restore terminal state. Does NOT erase scrollback. */
  async unmount(): Promise<void> {
    await this.enqueue(async () => {
      if (this.phase === 'unmounted') return;
      await this.writeRaw(
        `${this.clearOwnedLiveRegion()}${SGR_RESET}${SHOW_CURSOR}${DISABLE_BRACKETED_PASTE}${ENABLE_AUTOWRAP}\n`,
      );
      this.phase = 'unmounted';
      this.releaseLiveRegion();
      this.completeResize();
    });
  }

  /** Flush: wait for queue to drain. Yields to I/O between checks. */
  async flush(): Promise<void> {
    while (this.processing || this.queue.length > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }

  private async writeRaw(chunk: string): Promise<void> {
    if (!chunk) return;
    if (this.output.writable === false) {
      throw new Error('terminal output is not writable');
    }

    let accepted: boolean;
    try {
      accepted = this.output.write(chunk);
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    // Node streams return a boolean. A few compatible/test streams return
    // void; only an explicit false means backpressure.
    if (accepted !== false) return;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        this.output.off('drain', onDrain);
        this.output.off('error', onError);
        this.output.off('close', onClose);
      };
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onDrain = (): void => {
        if (this.output.writable === false) {
          settle(new Error('terminal output closed before drain'));
          return;
        }
        settle();
      };
      const onError = (error?: unknown): void => {
        settle(error instanceof Error ? error : new Error(String(error ?? 'terminal output error')));
      };
      const onClose = (): void => settle(new Error('terminal output closed before drain'));
      this.output.on('drain', onDrain);
      this.output.on('error', onError);
      this.output.on('close', onClose);
    });
  }

  /** Reset for tests. */
  reset(): void {
    this.phase = 'idle';
    this.liveBandRows = 0;
    this.liveRegionCapacity = 0;
    this.cursorRow = 0;
    this.cursorColumn = 0;
    this.previousFrame = null;
    this.completeResize();
    this.resizeGeneration = 0;
    this.queue = [];
    this.processing = false;
  }
}

// ============================================================================
// MemoryOutput: test double for surface tests
// ============================================================================

export class MemoryOutput implements SurfaceOutput {
  chunks: string[] = [];
  writable = true;
  private drainListeners: Array<(error?: unknown) => void> = [];

  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }

  on(event: SurfaceOutputEvent, listener: (error?: unknown) => void): this {
    if (event === 'drain') this.drainListeners.push(listener);
    return this;
  }

  off(event: SurfaceOutputEvent, listener: (error?: unknown) => void): this {
    if (event === 'drain') {
      this.drainListeners = this.drainListeners.filter(l => l !== listener);
    }
    return this;
  }

  text(): string {
    return this.chunks.join('');
  }

  /** Assert output never contains forbidden sequences. */
  assertNoForbidden(): void {
    const text = this.text();
    if (text.includes('\x1b[?1049h')) throw new Error('output contains alternate-screen enter');
    if (text.includes('\x1b[?1049l')) throw new Error('output contains alternate-screen exit');
    if (/\x1b\[\d+;\d+H/.test(text)) throw new Error('output contains absolute cursor positioning');
    if (text.includes('\x1b[2J')) throw new Error('output contains full-screen clear');
  }
}
