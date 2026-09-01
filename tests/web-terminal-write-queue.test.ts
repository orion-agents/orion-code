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
      maxInFlightCharacters: 4,
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
    expect(writes.map(write => write.data)).toEqual(['abcd', 'ef', 'gh']);
    expect(sequences).toEqual([]);
    writes[1].callback();
    expect(sequences).toEqual([1]);
    writes[2].callback();
    expect(sequences).toEqual([1, 2]);
    expect(scheduler.size()).toBe(0);
  });

  it('keeps a bounded pipeline fed while preserving callback commit order', () => {
    const scheduler = new TaskScheduler();
    const writes: Array<{ data: string; callback: () => void }> = [];
    const sequences: number[] = [];
    const queue = new TerminalWriteQueue({
      target: { write: (data, callback) => writes.push({ data, callback }) },
      onSequenceCommitted: sequence => sequences.push(sequence),
      scheduleTask: scheduler.schedule,
      cancelTask: scheduler.cancel,
      maxChunkCharacters: 4,
      maxInFlightCharacters: 8,
    });

    queue.enqueue('abcdefghijkl', { sequence: 1 });
    scheduler.runNext();
    expect(writes.map(write => write.data)).toEqual(['abcd', 'efgh']);
    expect(scheduler.size()).toBe(0);
    writes[0].callback();
    expect(scheduler.size()).toBe(1);
    scheduler.runNext();
    expect(writes.map(write => write.data)).toEqual(['abcd', 'efgh', 'ijkl']);
    writes[1].callback();
    expect(sequences).toEqual([]);
    writes[2].callback();
    expect(sequences).toEqual([1]);
  });

  it('warms a cold burst at 2.5KiB before using the 3KiB sustained budget', () => {
    const scheduler = new TaskScheduler();
    const writes: Array<{ data: string; callback: () => void }> = [];
    const queue = new TerminalWriteQueue({
      target: { write: (data, callback) => writes.push({ data, callback }) },
      onSequenceCommitted: () => undefined,
      scheduleTask: scheduler.schedule,
      cancelTask: scheduler.cancel,
    });

    queue.enqueue('x'.repeat(512 * 1024));
    for (let frame = 0; frame < 120; frame += 1) {
      scheduler.runNext();
      expect(writes[frame].data).toHaveLength(2_560);
      writes[frame].callback();
    }
    scheduler.runNext();
    expect(writes[120].data).toHaveLength(3 * 1024);
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
      maxInFlightCharacters: 2,
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

  it('waits for xterm acknowledgement instead of spinning frames at a surrogate boundary', () => {
    const scheduler = new TaskScheduler();
    const writes: Array<{ data: string; callback: () => void }> = [];
    const queue = new TerminalWriteQueue({
      target: { write: (data, callback) => writes.push({ data, callback }) },
      onSequenceCommitted: () => undefined,
      scheduleTask: scheduler.schedule,
      cancelTask: scheduler.cancel,
      maxChunkCharacters: 2,
      maxInFlightCharacters: 3,
    });

    queue.enqueue('ab😀');
    scheduler.runNext();
    expect(writes.map(write => write.data)).toEqual(['ab']);
    expect(scheduler.size()).toBe(0);

    writes[0].callback();
    expect(scheduler.size()).toBe(1);
    scheduler.runNext();
    expect(writes.map(write => write.data)).toEqual(['ab', '😀']);
    expect(scheduler.size()).toBe(0);
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
      maxInFlightCharacters: 4,
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
