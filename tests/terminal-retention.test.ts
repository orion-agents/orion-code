/**
 * v0.2.23 Slice 2 — Terminal Bounded State / Retention tests.
 */

import {
  TerminalEventSink,
  TerminalWriter,
} from '../src/terminal-ui/launch';
import type { OpenHorseUiRuntime } from '../src/runtime/ui-events';

function syncWriter(): TerminalWriter & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    write(text: string): void {
      writes.push(text);
    },
  };
}

function mockRuntime(): OpenHorseUiRuntime {
  return {
    cwd: '/tmp/test',
    version: '0.2.23',
    config: { model: 'test-model' } as any,
    store: { getSnapshot: () => ({}) } as any,
    llm: null,
    runtime: {} as any,
    isConfigured: true,
    shutdown: async () => {},
    ensureSession: () => ({} as any),
    setSession: () => {},
    getSession: () => null,
  };
}

describe('Terminal bounded state', () => {
  it('releases entry body after finalize', () => {
    const sink = new TerminalEventSink(mockRuntime(), syncWriter());
    const id = sink.append({ role: 'assistant', content: 'Hello World', live: true });

    // Before finalize, content is intact.
    const before = (sink as any).entries.get(id);
    expect(before.content).toBe('Hello World');

    sink.finalize(id);

    // After finalize, content is replaced with lightweight marker.
    const after = (sink as any).entries.get(id);
    expect(after.content).toContain('[scrollback:');
    expect(after.content).toContain('11 chars');
  });

  it('does not release non-finalized entry bodies', () => {
    const sink = new TerminalEventSink(mockRuntime(), syncWriter());
    const id = sink.append({ role: 'assistant', content: 'streaming content', live: true });

    // Without finalize, content should still be intact.
    const entry = (sink as any).entries.get(id);
    expect(entry.content).toBe('streaming content');
  });

  it('bounded entries map (512 items)', () => {
    const sink = new TerminalEventSink(mockRuntime(), syncWriter());

    // Complete append-only entries are acknowledged and released immediately.
    for (let i = 0; i < 600; i++) {
      sink.append({ role: 'system', content: `message ${i}` });
    }

    const entries = (sink as any).entries;
    expect(entries.size).toBeLessThanOrEqual(512);
  });

  it('bounded subtask timeline (100 items)', () => {
    const sink = new TerminalEventSink(mockRuntime(), syncWriter());

    for (let i = 0; i < 150; i++) {
      (sink as any).subtaskEvent({
        batchId: `batch-${i}`,
        taskId: `task-${i}`,
        role: 'test',
        state: 'completed',
        objective: `test ${i}`,
      });
    }

    const timeline = (sink as any).subtaskTimeline;
    expect(timeline.size).toBeLessThanOrEqual(100);
  });

  it('bounded printed content (512 entries)', () => {
    const sink = new TerminalEventSink(mockRuntime(), syncWriter());

    for (let i = 0; i < 600; i++) {
      const id = sink.append({ role: 'system', content: `print ${i}` });
      if (i % 2 === 0) sink.finalize(id);
    }

    const printed = (sink as any).printedContent;
    expect(printed.size).toBeLessThanOrEqual(512);
  });

  it('preserves entry metadata (role, title) after release', () => {
    const sink = new TerminalEventSink(mockRuntime(), syncWriter());
    const id = sink.append({
      role: 'tool',
      content: 'large tool output',
      title: 'tool-result',
      live: true,
    });

    sink.finalize(id);

    const entry = (sink as any).entries.get(id);
    expect(entry.role).toBe('tool');
    expect(entry.title).toBe('tool-result');
    expect(entry.id).toBe(id);
  });

  it('keeps finalized content until async output acknowledgement succeeds', async () => {
    let acknowledge: ((written: boolean) => void) | undefined;
    const writer: TerminalWriter = {
      write: () => undefined,
      writeAsync: () => new Promise(resolve => {
        acknowledge = resolve;
      }),
    };
    const sink = new TerminalEventSink(mockRuntime(), writer);
    const id = sink.append({ role: 'tool', content: 'durable body' });

    expect((sink as any).entries.get(id).content).toBe('durable body');
    acknowledge?.(true);
    await Promise.resolve();
    expect((sink as any).entries.get(id).content).toContain('[scrollback:');
  });

  it('does not release finalized content when async output acknowledgement fails', async () => {
    const writer: TerminalWriter = {
      write: () => undefined,
      writeAsync: async () => false,
    };
    const sink = new TerminalEventSink(mockRuntime(), writer);
    const id = sink.append({ role: 'tool', content: 'retryable body' });

    await Promise.resolve();
    expect((sink as any).entries.get(id).content).toBe('retryable body');
  });
});
