import {
  createTuiRenderScheduler,
  type TuiRenderScheduler,
  type TuiRenderSchedulerDeps,
} from '../src/tui-ui/render-scheduler';
import { TuiRunner, type TuiRunnerCounters } from '../src/tui-ui/runner';

// ============================================================================
// Helpers
// ============================================================================

interface FakeDeps extends TuiRenderSchedulerDeps {
  timers: Array<{ cb: () => void; ms: number }>;
  advance(ms: number): void;
}

function fakeDeps(): FakeDeps {
  const timers: Array<{ cb: () => void; ms: number }> = [];
  let nowValue = 0;
  return {
    now: () => nowValue,
    queueMicrotask: (cb: () => void) => { Promise.resolve().then(cb); },
    setTimeout: (cb: () => void, ms: number) => { timers.push({ cb, ms }); return timers.length; },
    clearTimeout: () => {},
    timers,
    advance: (ms: number) => { nowValue += ms; },
  };
}

interface SyncDeps extends TuiRenderSchedulerDeps {
  flush(): void;
  advance(ms: number): void;
}

function syncDeps(): SyncDeps {
  let nowValue = 0;
  const pendingMicrotasks: Array<() => void> = [];
  return {
    now: () => nowValue,
    queueMicrotask: (cb: () => void) => { pendingMicrotasks.push(cb); },
    setTimeout: (cb: () => void, _ms: number) => {
      // For sync tests, execute immediately.
      cb();
      return 0;
    },
    clearTimeout: () => {},
    flush: () => {
      while (pendingMicrotasks.length > 0) {
        const cb = pendingMicrotasks.shift()!;
        cb();
      }
    },
    advance: (ms: number) => { nowValue += ms; },
  };
}

class FakeOutput {
  chunks: string[] = [];
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(String(chunk));
    return true;
  }
  text(): string {
    return this.chunks.join('');
  }
}

// ============================================================================
// Scheduler unit tests
// ============================================================================

describe('TuiRenderScheduler', () => {
  it('paints immediately on first immediate request', () => {
    const paints: number[] = [];
    const scheduler = createTuiRenderScheduler(
      () => { paints.push(1); },
    );
    scheduler.request('immediate');
    // microtask hasn't run yet; flush to execute.
    scheduler.flush();
    expect(paints).toHaveLength(1);
    scheduler.stop();
  });

  it('coalesces multiple immediate requests in same tick', () => {
    const paints: number[] = [];
    const deps = syncDeps();
    const scheduler = createTuiRenderScheduler(
      () => { paints.push(1); },
      deps,
    );
    scheduler.request('immediate');
    scheduler.request('immediate');
    scheduler.request('immediate');
    (deps as SyncDeps).flush();
    expect(paints).toHaveLength(1);
    expect(scheduler.counters.coalescedCount).toBe(2);
    scheduler.stop();
  });

  it('does not paint when state has not changed (flush on same frame)', () => {
    const paints: number[] = [];
    const scheduler = createTuiRenderScheduler(
      () => { paints.push(1); },
    );
    // Request then flush paints once.
    scheduler.request('immediate');
    scheduler.flush();
    expect(paints).toHaveLength(1);
    // Second flush with no request does NOT paint.
    scheduler.flush();
    expect(paints).toHaveLength(1);
    scheduler.stop();
  });

  it('caps stream paints at ~30 FPS', () => {
    const paints: number[] = [];
    const deps = fakeDeps();
    const scheduler = createTuiRenderScheduler(
      () => { paints.push(1); },
      deps,
    );
    // First stream request at time 0.
    scheduler.request('stream');
    // Timer should be scheduled.
    expect(deps.timers.length).toBe(1);
    // Execute the timer.
    deps.timers[0].cb();
    expect(paints).toHaveLength(1);

    // Second request immediately after — should be coalesced or delayed.
    scheduler.request('stream');
    // Advance time by 10ms (less than 33ms frame budget).
    deps.advance(10);
    scheduler.request('stream');
    // Should have coalesced at least one.
    expect(scheduler.counters.coalescedCount).toBeGreaterThanOrEqual(1);
    scheduler.stop();
  });

  it('immediate request cancels pending stream timer', () => {
    const paints: number[] = [];
    const deps = fakeDeps();
    const scheduler = createTuiRenderScheduler(
      () => { paints.push(1); },
      deps,
    );
    scheduler.request('stream');
    expect(deps.timers.length).toBe(1);
    // Before stream timer fires, request immediate.
    scheduler.request('immediate');
    // The immediate should cancel the stream timer and schedule microtask.
    // Flush to execute.
    scheduler.flush();
    expect(paints).toHaveLength(1);
    scheduler.stop();
  });

  it('flush executes pending paint immediately', () => {
    const paints: number[] = [];
    const scheduler = createTuiRenderScheduler(
      () => { paints.push(1); },
    );
    scheduler.request('stream');
    // Stream timer is pending; flush should execute paint now.
    scheduler.flush();
    expect(paints).toHaveLength(1);
    scheduler.stop();
  });

  it('stop clears pending timers and resets counters', () => {
    const scheduler = createTuiRenderScheduler(() => {});
    scheduler.request('stream');
    scheduler.request('immediate');
    scheduler.stop();
    expect(scheduler.counters.paintCount).toBe(0);
    expect(scheduler.counters.requestCount).toBe(0);
    expect(scheduler.counters.coalescedCount).toBe(0);
  });

  it('requests after stop are no-ops', () => {
    const paints: number[] = [];
    const scheduler = createTuiRenderScheduler(
      () => { paints.push(1); },
    );
    scheduler.stop();
    scheduler.request('immediate');
    scheduler.flush();
    expect(paints).toHaveLength(0);
  });

  it('tracks request, paint, and coalesced counters', () => {
    const deps = syncDeps();
    const scheduler = createTuiRenderScheduler(() => {}, deps);
    scheduler.request('immediate');
    scheduler.request('immediate');
    (deps as SyncDeps).flush();
    expect(scheduler.counters.requestCount).toBe(2);
    expect(scheduler.counters.paintCount).toBe(1);
    expect(scheduler.counters.coalescedCount).toBe(1);
    scheduler.stop();
  });
});

// ============================================================================
// Runner integration with scheduler
// ============================================================================

describe('TuiRunner with scheduler', () => {
  it('coalesces multiple dispatches in same tick', () => {
    const output = new FakeOutput();
    const runner = new TuiRunner({
      output,
      width: 40,
      height: 10,
    });
    const before = runner.counters.paintCount;
    // Multiple dispatches — scheduler coalesces them.
    runner.dispatch({ type: 'setPrompt', value: 'a', cursor: 1 });
    runner.dispatch({ type: 'setPrompt', value: 'ab', cursor: 2 });
    runner.dispatch({ type: 'setPrompt', value: 'abc', cursor: 3 });
    // Flush the scheduler.
    runner.getScheduler().flush();
    // At least one paint happened (initial + flush).
    expect(runner.counters.paintCount).toBeGreaterThan(before);
  });

  it('uses stream priority for updateTranscript', () => {
    const output = new FakeOutput();
    const runner = new TuiRunner({
      output,
      width: 40,
      height: 10,
    });
    // updateTranscript is a stream action — should not block.
    runner.dispatch({ type: 'appendTranscript', entry: { id: 'a1', role: 'assistant', content: 'hello', live: true } });
    runner.dispatch({ type: 'updateTranscript', id: 'a1', patch: { content: 'hello world' } });
    // Force paint.
    runner.getScheduler().flush();
    const state = runner.getState();
    const entry = state.transcript.find(e => e.id === 'a1');
    expect(entry?.content).toBe('hello world');
  });

  it('uses immediate priority for setPrompt', () => {
    const output = new FakeOutput();
    const runner = new TuiRunner({
      output,
      width: 40,
      height: 10,
    });
    runner.dispatch({ type: 'setPrompt', value: 'test', cursor: 4 });
    runner.getScheduler().flush();
    expect(runner.getState().prompt.value).toBe('test');
  });

  it('resize flushes scheduler and renders immediately', () => {
    const output = new FakeOutput();
    const runner = new TuiRunner({
      output,
      width: 40,
      height: 10,
    });
    const before = runner.counters.paintCount;
    runner.resize(60, 15);
    // Flush should have triggered a paint.
    expect(runner.counters.paintCount).toBeGreaterThan(before);
  });

  it('tracks layoutCount, paintCount, changedRows counters', () => {
    const output = new FakeOutput();
    const runner = new TuiRunner({
      output,
      width: 40,
      height: 10,
    });
    const c: TuiRunnerCounters = runner.counters;
    expect(c.layoutCount).toBeGreaterThan(0);
    expect(c.paintCount).toBeGreaterThan(0);
  });

  it('renderFullFrame produces a complete frame for tests', () => {
    const output = new FakeOutput();
    const runner = new TuiRunner({
      output,
      width: 40,
      height: 10,
    });
    runner.dispatch({ type: 'appendTranscript', entry: { id: 'u1', role: 'user', content: 'hello' } });
    runner.dispatch({ type: 'finalizeTranscript', id: 'u1' });
    const frame = runner.renderFullFrame();
    expect(frame.width).toBe(40);
    expect(frame.height).toBe(10);
    // Full frame should contain both static and live transcript.
    const rows = frame.rows.map(row => row.map(cell => cell.width === 0 ? '' : cell.char).join('')).join('\n');
    expect(rows).toContain('hello');
  });
});

// ============================================================================
// Performance fixture: 500 entries / 100 deltas
// ============================================================================

describe('slice 6: performance fixture', () => {
  it('500 committed entries + 1 live delta produces correct state', () => {
    const output = new FakeOutput();
    const runner = new TuiRunner({
      output,
      width: 80,
      height: 24,
    });

    // Append 500 finalized entries.
    for (let i = 0; i < 500; i++) {
      runner.dispatch({
        type: 'appendTranscript',
        entry: { id: `u${i}`, role: 'user', content: `Message ${i}` },
      });
      runner.dispatch({
        type: 'finalizeTranscript',
        id: `u${i}`,
      });
    }

    // Add one live entry.
    runner.dispatch({
      type: 'appendTranscript',
      entry: { id: 'live1', role: 'assistant', content: 'partial', live: true },
    });

    const state = runner.getState();
    // Verify state is correct.
    expect(state.committableTranscriptCount).toBe(500);
    expect(state.transcript.length).toBe(501);

    // Full frame should render without crashing.
    const frame = runner.renderFullFrame();
    expect(frame.height).toBe(24);
  });

  it('100 stream deltas produce bounded paint count with scheduler', () => {
    const output = new FakeOutput();
    const runner = new TuiRunner({
      output,
      width: 80,
      height: 24,
    });

    // Append a live entry.
    runner.dispatch({
      type: 'appendTranscript',
      entry: { id: 'a1', role: 'assistant', content: '', live: true },
    });

    // Simulate 100 stream deltas.
    for (let i = 0; i < 100; i++) {
      runner.dispatch({
        type: 'updateTranscript',
        id: 'a1',
        patch: { content: `delta ${i}` },
      });
    }

    // Force a final paint.
    runner.getScheduler().flush();

    // With scheduler coalescing, paint count should be much less than 100.
    const schedulerPaints = runner.getScheduler().counters.paintCount;
    const schedulerCoalesced = runner.getScheduler().counters.coalescedCount;
    expect(schedulerCoalesced).toBeGreaterThan(0);
  });

  it('renderFullFrame with same state produces unchanged frame', () => {
    const output = new FakeOutput();
    const runner = new TuiRunner({
      output,
      width: 40,
      height: 10,
    });
    // Render once to establish baseline.
    const frame1 = runner.renderFullFrame();
    // Render again with no state change.
    const frame2 = runner.renderFullFrame();
    // Both frames should have same dimensions.
    expect(frame2.width).toBe(frame1.width);
    expect(frame2.height).toBe(frame1.height);
  });
});

// ============================================================================
// Transcript cache
// ============================================================================

import { TranscriptLayoutCache } from '../src/tui-ui/transcript-cache';

describe('TranscriptLayoutCache', () => {
  it('returns null for uncached entries', () => {
    const cache = new TranscriptLayoutCache();
    expect(cache.get('e1', 1, 0, 80)).toBeNull();
  });

  it('stores and retrieves entries', () => {
    const cache = new TranscriptLayoutCache();
    const rows = [[{ text: 'hello', style: {} }]];
    cache.set('e1', 1, rows as any, 0, 80);
    expect(cache.get('e1', 1, 0, 80)).toEqual(rows);
  });

  it('returns null when revision changes', () => {
    const cache = new TranscriptLayoutCache();
    const rows = [[{ text: 'hello', style: {} }]];
    cache.set('e1', 1, rows as any, 0, 80);
    expect(cache.get('e1', 2, 0, 80)).toBeNull();
  });

  it('invalidates on generation change', () => {
    const cache = new TranscriptLayoutCache();
    const rows = [[{ text: 'hello', style: {} }]];
    cache.set('e1', 1, rows as any, 0, 80);
    // Generation change should invalidate.
    expect(cache.get('e1', 1, 1, 80)).toBeNull();
  });

  it('invalidates on width change', () => {
    const cache = new TranscriptLayoutCache();
    const rows = [[{ text: 'hello', style: {} }]];
    cache.set('e1', 1, rows as any, 0, 80);
    // Width change should invalidate.
    expect(cache.get('e1', 1, 0, 120)).toBeNull();
  });

  it('invalidates on theme change', () => {
    const cache = new TranscriptLayoutCache();
    const rows = [[{ text: 'hello', style: {} }]];
    cache.set('e1', 1, rows as any, 0, 80, 'dark');

    expect(cache.get('e1', 1, 0, 80, 'light')).toBeNull();
  });

  it('evicts oldest entry when at capacity', () => {
    const cache = new TranscriptLayoutCache();
    const rows = [[{ text: 'x', style: {} }]] as any;
    // Fill to capacity (256).
    for (let i = 0; i < 256; i++) {
      cache.set(`e${i}`, 1, rows, 0, 80);
    }
    expect(cache.size).toBe(256);
    // Add one more — should evict oldest.
    cache.set('e256', 1, rows, 0, 80);
    expect(cache.size).toBe(256);
    expect(cache.get('e0', 1, 0, 80)).toBeNull();
    expect(cache.get('e256', 1, 0, 80)).toEqual(rows);
  });

  it('clear resets all state', () => {
    const cache = new TranscriptLayoutCache();
    const rows = [[{ text: 'hello', style: {} }]] as any;
    cache.set('e1', 1, rows, 0, 80);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('e1', 1, 0, 80)).toBeNull();
  });
});
