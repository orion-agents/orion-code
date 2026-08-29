import { TerminalWriteQueue } from '../web/src/components/terminal/terminal-write-queue';

class TaskScheduler {
  private nextHandle = 1;
  private readonly callbacks = new Map<number, () => void>();

  schedule = (callback: () => void): number => {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.callbacks.set(handle, callback);
    return handle;
  };

  cancel = (handle: number): void => {
    this.callbacks.delete(handle);
  };

  runNext(): void {
    const entry = this.callbacks.entries().next().value as [number, () => void] | undefined;
    if (!entry) throw new Error('No terminal write task is scheduled.');
    this.callbacks.delete(entry[0]);
    entry[1]();
  }

  size(): number {
    return this.callbacks.size;
  }
}

describe('TerminalWriteQueue', () => {
  it('paces output and commits each reconnect sequence only after its complete xterm write', () => {
    const scheduler = new TaskScheduler();
    const writes: Array<{ data: string; callback: () => void }> = [];
    const sequences: number[] = [];
    const queue = new TerminalWriteQueue({
      target: { write: (data, callback) => writes.push({ data, callback }) },
      onSequenceCommitted: sequence => sequences.push(sequence),
      scheduleTask: scheduler.schedule,
      cancelTask: scheduler.cancel,
      maxChunkCharacters: 4,
    });

    queue.enqueue('abcdef', { sequence: 1 });
    queue.enqueue('gh', { sequence: 2 });
    expect(scheduler.size()).toBe(1);
    scheduler.runNext();
    expect(writes.map(write => write.data)).toEqual(['abcd']);
    expect(sequences).toEqual([]);
    expect(scheduler.size()).toBe(0);

    writes[0].callback();
    expect(scheduler.size()).toBe(1);
    scheduler.runNext();
    expect(writes.map(write => write.data)).toEqual(['abcd', 'efgh']);
    expect(sequences).toEqual([]);
    writes[1].callback();
    expect(sequences).toEqual([1, 2]);
    expect(scheduler.size()).toBe(0);
  });

  it('never splits a Unicode surrogate pair at a render boundary', () => {
    const scheduler = new TaskScheduler();
    const writes: Array<{ data: string; callback: () => void }> = [];
    const queue = new TerminalWriteQueue({
      target: { write: (data, callback) => writes.push({ data, callback }) },
      onSequenceCommitted: () => undefined,
      scheduleTask: scheduler.schedule,
      cancelTask: scheduler.cancel,
      maxChunkCharacters: 2,
    });

    queue.enqueue('a😀b');
    scheduler.runNext();
    expect(writes[0].data).toBe('a');
    writes[0].callback();
    scheduler.runNext();
    expect(writes[1].data).toBe('😀');
    writes[1].callback();
    scheduler.runNext();
    expect(writes[2].data).toBe('b');
  });

  it('cancels pending work and suppresses late callbacks after disposal', () => {
    const scheduler = new TaskScheduler();
    const writes: Array<{ data: string; callback: () => void }> = [];
    const sequences: number[] = [];
    const queue = new TerminalWriteQueue({
      target: { write: (data, callback) => writes.push({ data, callback }) },
      onSequenceCommitted: sequence => sequences.push(sequence),
      scheduleTask: scheduler.schedule,
      cancelTask: scheduler.cancel,
      maxChunkCharacters: 4,
    });

    queue.enqueue('abcd', { sequence: 1 });
    scheduler.runNext();
    queue.enqueue('efgh', { sequence: 2 });
    queue.dispose();
    writes[0].callback();
    expect(sequences).toEqual([]);
    expect(scheduler.size()).toBe(0);
    expect(writes.map(write => write.data)).toEqual(['abcd']);
  });
});
