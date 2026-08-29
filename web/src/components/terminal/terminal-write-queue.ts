// Keep each xterm parser input bounded while letting xterm own the animation-frame render cycle.
// A 4KiB slice still drains the 10MiB release fixture inside its 90 second budget.
const DEFAULT_RENDER_CHUNK_CHARACTERS = 4 * 1024;

export interface TerminalWriteTarget {
  write(data: string, callback: () => void): void;
}

export interface TerminalWriteQueueOptions {
  readonly target: TerminalWriteTarget;
  readonly onSequenceCommitted: (sequence: number) => void;
  readonly scheduleTask?: (callback: () => void) => number;
  readonly cancelTask?: (handle: number) => void;
  readonly maxChunkCharacters?: number;
}

interface PendingTerminalWrite {
  readonly data: string;
  readonly sequence?: number;
  readonly onCommitted?: () => void;
  offset: number;
}

/**
 * Paces xterm writes so a burst of PTY output cannot monopolize the browser main thread.
 * A reconnect sequence is committed only after xterm acknowledges the complete source frame.
 */
export class TerminalWriteQueue {
  private readonly pending: PendingTerminalWrite[] = [];
  private readonly target: TerminalWriteTarget;
  private readonly onSequenceCommitted: (sequence: number) => void;
  private readonly scheduleTask: (callback: () => void) => number;
  private readonly cancelTask: (handle: number) => void;
  private readonly maxChunkCharacters: number;
  private scheduledTask: number | null = null;
  private writing = false;
  private disposed = false;

  constructor(options: TerminalWriteQueueOptions) {
    this.target = options.target;
    this.onSequenceCommitted = options.onSequenceCommitted;
    this.scheduleTask = options.scheduleTask ?? (callback => window.setTimeout(callback, 0));
    this.cancelTask = options.cancelTask ?? (handle => window.clearTimeout(handle));
    this.maxChunkCharacters = Math.max(
      1,
      Math.floor(options.maxChunkCharacters ?? DEFAULT_RENDER_CHUNK_CHARACTERS)
    );
  }

  enqueue(
    data: string,
    options: { readonly sequence?: number; readonly onCommitted?: () => void } = {}
  ) {
    if (this.disposed) return;
    this.pending.push({ data, offset: 0, ...options });
    this.requestFlush();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending.length = 0;
    if (this.scheduledTask !== null) {
      this.cancelTask(this.scheduledTask);
      this.scheduledTask = null;
    }
  }

  private requestFlush(): void {
    if (this.disposed || this.writing || this.pending.length === 0 || this.scheduledTask !== null) {
      return;
    }
    // xterm already yields its parser after 12ms and schedules rendering itself. Scheduling this
    // queue on requestAnimationFrame would consume a separate frame and make parsing and painting
    // alternate at roughly half the display refresh rate on slower browsers.
    this.scheduledTask = this.scheduleTask(() => {
      this.scheduledTask = null;
      this.flush();
    });
  }

  private flush(): void {
    if (this.disposed || this.writing || this.pending.length === 0) return;
    const chunks: string[] = [];
    const completed: PendingTerminalWrite[] = [];
    let remaining = this.maxChunkCharacters;

    while (remaining > 0 && this.pending.length > 0) {
      const current = this.pending[0];
      const end = safeTerminalChunkEnd(current.data, current.offset, remaining);
      if (end > current.offset) {
        chunks.push(current.data.slice(current.offset, end));
        remaining -= end - current.offset;
        current.offset = end;
      }
      if (current.offset < current.data.length) break;
      this.pending.shift();
      completed.push(current);
    }

    const data = chunks.join('');
    if (!data) {
      this.commit(completed);
      this.requestFlush();
      return;
    }
    this.writing = true;
    this.target.write(data, () => {
      this.writing = false;
      if (this.disposed) return;
      this.commit(completed);
      this.requestFlush();
    });
  }

  private commit(entries: readonly PendingTerminalWrite[]): void {
    for (const entry of entries) {
      if (entry.sequence !== undefined) this.onSequenceCommitted(entry.sequence);
      entry.onCommitted?.();
    }
  }
}

function safeTerminalChunkEnd(data: string, offset: number, limit: number): number {
  let end = Math.min(data.length, offset + limit);
  if (
    end > offset &&
    end < data.length &&
    isHighSurrogate(data.charCodeAt(end - 1)) &&
    isLowSurrogate(data.charCodeAt(end))
  ) {
    end -= 1;
  }
  return end;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}
