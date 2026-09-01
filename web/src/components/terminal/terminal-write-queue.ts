// Feed xterm one bounded 3KiB parser entry per animation frame. The frame boundary
// preserves paint opportunities while avoiding repeated write-buffer callbacks for
// the same budget. A single entry is small enough to parse within the frame budget.
const DEFAULT_RENDER_CHUNK_CHARACTERS = 3 * 1024;
const DEFAULT_IN_FLIGHT_CHARACTERS = 3 * 1024;

export interface TerminalWriteTarget {
  write(data: string, callback: () => void): void;
}

export interface TerminalWriteQueueOptions {
  readonly target: TerminalWriteTarget;
  readonly onSequenceCommitted: (sequence: number) => void;
  readonly scheduleTask?: (callback: () => void) => number;
  readonly cancelTask?: (handle: number) => void;
  readonly maxChunkCharacters?: number;
  readonly maxInFlightCharacters?: number;
}

interface PendingTerminalWrite {
  readonly data: string;
  readonly sequence?: number;
  readonly onCommitted?: () => void;
  offset: number;
  pendingChunks: number;
}

/**
 * Paces xterm writes so a burst of PTY output cannot monopolize the browser main thread.
 * A reconnect sequence is committed only after xterm acknowledges the complete source frame.
 */
export class TerminalWriteQueue {
  private readonly pending: PendingTerminalWrite[] = [];
  private readonly awaitingCommit: PendingTerminalWrite[] = [];
  private readonly target: TerminalWriteTarget;
  private readonly onSequenceCommitted: (sequence: number) => void;
  private readonly scheduleTask: (callback: () => void) => number;
  private readonly cancelTask: (handle: number) => void;
  private readonly maxChunkCharacters: number;
  private readonly maxInFlightCharacters: number;
  private scheduledTask: number | null = null;
  private inFlightCharacters = 0;
  private flushing = false;
  private waitingForCapacity = false;
  private disposed = false;

  constructor(options: TerminalWriteQueueOptions) {
    this.target = options.target;
    this.onSequenceCommitted = options.onSequenceCommitted;
    this.scheduleTask =
      options.scheduleTask ?? (callback => window.requestAnimationFrame(() => callback()));
    this.cancelTask = options.cancelTask ?? (handle => window.cancelAnimationFrame(handle));
    this.maxChunkCharacters = Math.max(
      2,
      Math.floor(options.maxChunkCharacters ?? DEFAULT_RENDER_CHUNK_CHARACTERS)
    );
    this.maxInFlightCharacters = Math.max(
      this.maxChunkCharacters,
      Math.floor(options.maxInFlightCharacters ?? DEFAULT_IN_FLIGHT_CHARACTERS)
    );
  }

  enqueue(
    data: string,
    options: { readonly sequence?: number; readonly onCommitted?: () => void } = {}
  ) {
    if (this.disposed) return;
    this.pending.push({ data, offset: 0, pendingChunks: 0, ...options });
    this.requestFlush();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending.length = 0;
    this.awaitingCommit.length = 0;
    if (this.scheduledTask !== null) {
      this.cancelTask(this.scheduledTask);
      this.scheduledTask = null;
    }
  }

  private requestFlush(): void {
    if (
      this.disposed ||
      this.flushing ||
      this.pending.length === 0 ||
      this.inFlightCharacters >= this.maxInFlightCharacters ||
      this.waitingForCapacity ||
      this.scheduledTask !== null
    ) {
      return;
    }
    // A browser-frame boundary prevents a continuously reposted parser timer from starving paint.
    // xterm still owns parsing and rendering; this queue only caps how much new work it receives.
    this.scheduledTask = this.scheduleTask(() => {
      this.scheduledTask = null;
      this.flush();
    });
  }

  private flush(): void {
    if (
      this.disposed ||
      this.flushing ||
      this.pending.length === 0 ||
      this.inFlightCharacters >= this.maxInFlightCharacters
    ) {
      return;
    }
    this.flushing = true;
    let submittedCharacters = 0;
    try {
      while (
        this.pending.length > 0 &&
        this.inFlightCharacters < this.maxInFlightCharacters &&
        submittedCharacters < this.maxInFlightCharacters
      ) {
        const current = this.pending[0];
        if (current.offset >= current.data.length) {
          this.pending.shift();
          this.awaitingCommit.push(current);
          this.commitReady();
          continue;
        }
        const capacity = Math.min(
          this.maxChunkCharacters,
          this.maxInFlightCharacters - this.inFlightCharacters,
          this.maxInFlightCharacters - submittedCharacters
        );
        const end = safeTerminalChunkEnd(current.data, current.offset, capacity);
        if (end <= current.offset) {
          // The only non-progressing boundary is a surrogate pair that needs
          // more capacity than remains in the current xterm pipeline. Waiting
          // for an acknowledgement avoids reposting an animation frame that
          // cannot submit any new work.
          this.waitingForCapacity = true;
          break;
        }
        const data = current.data.slice(current.offset, end);
        current.offset = end;
        current.pendingChunks += 1;
        this.inFlightCharacters += data.length;
        submittedCharacters += data.length;
        if (current.offset >= current.data.length) {
          this.pending.shift();
          this.awaitingCommit.push(current);
        }
        try {
          this.target.write(data, () => this.acknowledge(current, data.length));
        } catch (error) {
          current.pendingChunks -= 1;
          this.inFlightCharacters -= data.length;
          this.dispose();
          throw error;
        }
      }
    } finally {
      this.flushing = false;
    }
    this.commitReady();
    this.requestFlush();
  }

  private acknowledge(entry: PendingTerminalWrite, characters: number): void {
    entry.pendingChunks = Math.max(0, entry.pendingChunks - 1);
    this.inFlightCharacters = Math.max(0, this.inFlightCharacters - characters);
    if (this.disposed) return;
    this.waitingForCapacity = false;
    this.commitReady();
    this.requestFlush();
  }

  private commitReady(): void {
    while (this.awaitingCommit[0]?.pendingChunks === 0) {
      const entry = this.awaitingCommit.shift();
      if (!entry) return;
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
