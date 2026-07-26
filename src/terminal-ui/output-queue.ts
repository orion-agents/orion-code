/**
 * v0.2.23 — Terminal Output Queue.
 *
 * Single-writer FIFO queue for all Terminal UI runtime output. Handles
 * backpressure (write() returns false → wait for drain), batch coalescing,
 * flush, close, and safe shutdown. Replaces the ad-hoc pattern of each
 * event handler calling editor.writeExternal() directly.
 */

export interface TerminalOutputBatch {
  id: string;
  chunks: readonly string[];
  /** Entry IDs whose heavy state can be released after this batch is written. */
  releaseEntryIds: readonly string[];
}

interface PendingBatch {
  batch: TerminalOutputBatch;
  resolve: () => void;
  reject: (error: Error) => void;
}

export interface TerminalOutputWriter {
  write(text: string): boolean;
  on(event: 'drain', listener: () => void): void;
  off(event: 'drain', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  off(event: 'error', listener: (error: Error) => void): void;
}

export class TerminalOutputQueue {
  private readonly pending: PendingBatch[] = [];
  private closed = false;
  private draining = false;
  private flushPromise: Promise<void> | null = null;
  private failure: Error | null = null;

  constructor(private readonly writer: TerminalOutputWriter) {}

  /** Enqueue a batch for ordered write. Resolves when the batch has been written. */
  enqueue(batch: TerminalOutputBatch): Promise<void> {
    if (this.closed) return Promise.reject(new Error('terminal output queue is closed'));
    if (this.failure) return Promise.reject(this.failure);

    const completion = new Promise<void>((resolve, reject) => {
      this.pending.push({ batch, resolve, reject });
    });

    if (!this.draining) {
      this.draining = true;
      this.flushPromise = this.processQueue();
    }

    return completion;
  }

  /** Flush all pending batches. Returns a promise that resolves when done. */
  async flush(): Promise<void> {
    await (this.flushPromise ?? Promise.resolve());
    if (this.failure) throw this.failure;
  }

  /** Close the queue: prevent new enqueues, flush remaining, and clean up. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Flush remaining batches.
    if (this.draining && this.flushPromise) {
      await this.flush();
    }
  }

  /** True after close() is called. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Number of pending (not yet written) batches. */
  get pendingCount(): number {
    return this.pending.length;
  }

  private async processQueue(): Promise<void> {
    while (this.pending.length > 0) {
      const pending = this.pending.shift()!;
      try {
        await this.writeBatch(pending.batch);
        pending.resolve();
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.failure = failure;
        pending.reject(failure);
        for (const queued of this.pending.splice(0)) queued.reject(failure);
        this.draining = false;
        return;
      }
    }
    this.draining = false;
    this.flushPromise = null;
  }

  private writeBatch(batch: TerminalOutputBatch): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let chunkIndex = 0;
      let drainListener: (() => void) | null = null;

      const cleanup = (): void => {
        if (drainListener) {
          try { this.writer.off('drain', drainListener); } catch { /* ok */ }
          drainListener = null;
        }
        try { this.writer.off('error', onError); } catch { /* ok */ }
      };

      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };

      const writeNext = (): void => {
        try {
          while (chunkIndex < batch.chunks.length) {
            const chunk = batch.chunks[chunkIndex];
            chunkIndex += 1;
            const ok = this.writer.write(chunk);
            if (!ok) {
              // Backpressure: wait for drain before writing more.
              drainListener = (): void => {
                if (!drainListener) return; // already cleaned up
                const listener = drainListener;
                drainListener = null;
                try { this.writer.off('drain', listener); } catch { /* ok */ }
                writeNext();
              };
              this.writer.on('drain', drainListener);
              return;
            }
          }
          // All chunks written successfully.
          cleanup();
          resolve();
        } catch (err) {
          cleanup();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };

      this.writer.on('error', onError);
      writeNext();
    });
  }
}
