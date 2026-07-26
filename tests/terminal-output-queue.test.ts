/**
 * v0.2.23 Slice 2 — Terminal Output Queue tests.
 */

import { TerminalOutputQueue, type TerminalOutputWriter } from '../src/terminal-ui/output-queue';

function makeWriter(): {
  writer: TerminalOutputWriter;
  written: string[];
  blocked: boolean;
  drainListeners: Array<() => void>;
  errorListeners: Array<(error: Error) => void>;
} {
  const drainListeners: Array<() => void> = [];
  const errorListeners: Array<(error: Error) => void> = [];
  const written: string[] = [];

  return {
    written,
    blocked: false,
    drainListeners,
    errorListeners,
    writer: {
      write(text: string): boolean {
        written.push(text);
        return true; // never blocks by default
      },
      on(event: string, listener: (...args: any[]) => void): void {
        if (event === 'drain') drainListeners.push(listener as () => void);
        if (event === 'error') errorListeners.push(listener as (e: Error) => void);
      },
      off(event: string, listener: (...args: any[]) => void): void {
        if (event === 'drain') {
          const idx = drainListeners.indexOf(listener as () => void);
          if (idx >= 0) drainListeners.splice(idx, 1);
        }
        if (event === 'error') {
          const idx = errorListeners.indexOf(listener as (e: Error) => void);
          if (idx >= 0) errorListeners.splice(idx, 1);
        }
      },
    },
  };
}

describe('TerminalOutputQueue', () => {
  it('enqueues and writes batches in FIFO order', async () => {
    const { writer, written } = makeWriter();
    const queue = new TerminalOutputQueue(writer);

    await queue.enqueue({ id: 'b1', chunks: ['a'], releaseEntryIds: [] });
    await queue.enqueue({ id: 'b2', chunks: ['b'], releaseEntryIds: [] });
    await queue.enqueue({ id: 'b3', chunks: ['c'], releaseEntryIds: [] });

    expect(written.join('')).toBe('abc');
  });

  it('writes all chunks in a batch', async () => {
    const { writer, written } = makeWriter();
    const queue = new TerminalOutputQueue(writer);

    await queue.enqueue({
      id: 'b1',
      chunks: ['hello ', 'world', '\n'],
      releaseEntryIds: [],
    });

    expect(written.join('')).toBe('hello world\n');
  });

  it('enqueue resolves only after all chunks are written', async () => {
    const { writer, written } = makeWriter();
    const queue = new TerminalOutputQueue(writer);

    let resolved = false;
    const promise = queue
      .enqueue({ id: 'b1', chunks: ['x', 'y'], releaseEntryIds: [] })
      .then(() => { resolved = true; });

    await promise;
    expect(resolved).toBe(true);
    expect(written.join('')).toBe('xy');
  });

  it('handles backpressure by waiting for drain', async () => {
    const { writer, written } = makeWriter();
    const queue = new TerminalOutputQueue(writer);

    // Make the writer block after each write.
    const drainCallbacks: Array<() => void> = [];
    writer.write = (text: string): boolean => {
      written.push(text);
      return false; // always signal backpressure
    };
    const origOn = writer.on.bind(writer);
    (writer as any).on = function(event: string, listener: (...args: any[]) => void): void {
      if (event === 'drain') drainCallbacks.push(listener as () => void);
      origOn(event as 'drain', listener);
    };

    const enqueuePromise = queue.enqueue({
      id: 'b1',
      chunks: ['a', 'b'],
      releaseEntryIds: [],
    });

    // Let the microtask queue process the first write attempt.
    await new Promise(r => setTimeout(r, 10));

    // First chunk 'a' was written, then blocked.
    expect(written.join('')).toBe('a');

    // Fire all drain callbacks to unblock.
    while (drainCallbacks.length > 0) {
      const cb = drainCallbacks.shift();
      if (cb) cb();
      await new Promise(r => setTimeout(r, 5));
    }

    // Should resolve after all drains fire.
    let resolved = false;
    enqueuePromise.then(() => { resolved = true; });
    await new Promise(r => setTimeout(r, 20));
    expect(resolved).toBe(true);
    expect(written.length).toBeGreaterThanOrEqual(2);
  }, 10000);

  it('flush drains all pending batches', async () => {
    const { writer, written } = makeWriter();
    const queue = new TerminalOutputQueue(writer);

    const p1 = queue.enqueue({ id: 'b1', chunks: ['1'], releaseEntryIds: [] });
    const p2 = queue.enqueue({ id: 'b2', chunks: ['2'], releaseEntryIds: [] });

    await queue.flush();
    // Both should be written after flush.
    expect(written.join('')).toBe('12');
  });

  it('close prevents new enqueues', async () => {
    const { writer, written } = makeWriter();
    const queue = new TerminalOutputQueue(writer);

    await queue.enqueue({ id: 'b1', chunks: ['before'], releaseEntryIds: [] });
    await queue.close();

    await expect(queue.enqueue({ id: 'b2', chunks: ['after'], releaseEntryIds: [] }))
      .rejects.toThrow('closed');
    expect(written.join('')).toBe('before');
  });

  it('close flushes remaining batches', async () => {
    const { writer, written } = makeWriter();
    const queue = new TerminalOutputQueue(writer);

    const p = queue.enqueue({ id: 'b1', chunks: ['flush-me'], releaseEntryIds: [] });
    await queue.close();

    expect(written.join('')).toBe('flush-me');
  });

  it('close is idempotent', async () => {
    const { writer } = makeWriter();
    const queue = new TerminalOutputQueue(writer);

    await queue.close();
    await queue.close();
    // No throw.
  });

  it('handles multiple concurrent enqueue calls', async () => {
    const { writer, written } = makeWriter();
    const queue = new TerminalOutputQueue(writer);

    await Promise.all([
      queue.enqueue({ id: 'a', chunks: ['1'], releaseEntryIds: [] }),
      queue.enqueue({ id: 'b', chunks: ['2'], releaseEntryIds: [] }),
      queue.enqueue({ id: 'c', chunks: ['3'], releaseEntryIds: [] }),
    ]);

    // All should be written in order.
    expect(written.join('')).toBe('123');
  });

  it('isClosed and pendingCount reflect state', async () => {
    const { writer } = makeWriter();
    const queue = new TerminalOutputQueue(writer);

    expect(queue.isClosed).toBe(false);
    expect(queue.pendingCount).toBe(0);

    const p = queue.enqueue({ id: 'b1', chunks: ['x'], releaseEntryIds: [] });
    // During processing, pendingCount may be 0 or 1 depending on timing.
    // After enqueue resolves, it should be 0.
    await p;
    expect(queue.pendingCount).toBe(0);

    await queue.close();
    expect(queue.isClosed).toBe(true);
  });

  it('rejects current and queued acknowledgements on writer error', async () => {
    const { writer, errorListeners } = makeWriter();
    const queue = new TerminalOutputQueue(writer);

    // Simulate writer error after first write.
    let writeCount = 0;
    writer.write = (text: string): boolean => {
      writeCount += 1;
      if (writeCount >= 2) {
        // Fire error asynchronously.
        setTimeout(() => {
          for (const listener of errorListeners) listener(new Error('write failed'));
        }, 5);
        return false;
      }
      return true;
    };

    const current = queue.enqueue({ id: 'failed', chunks: ['a', 'b'], releaseEntryIds: [] });
    const queued = queue.enqueue({ id: 'never-written', chunks: ['c'], releaseEntryIds: [] });
    await expect(current).rejects.toThrow('write failed');
    await expect(queued).rejects.toThrow('write failed');
    await expect(queue.flush()).rejects.toThrow('write failed');
  });

  it('preserves byte-for-byte order for a 10 MB chunked batch', async () => {
    const { writer, written } = makeWriter();
    const queue = new TerminalOutputQueue(writer);
    const chunk = '0123456789abcdef'.repeat(640);
    const chunks = Array.from({ length: 1024 }, () => chunk);

    await queue.enqueue({ id: '10mb', chunks, releaseEntryIds: [] });
    expect(Buffer.byteLength(written.join(''), 'utf8')).toBe(10 * 1024 * 1024);
    expect(written).toEqual(chunks);
  });
});
