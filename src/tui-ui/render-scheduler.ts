/**
 * TuiRenderScheduler — coalesces redundant renders and caps stream paint rate.
 *
 * Priority model:
 * - `immediate`: input, permission, cursor, overlay, resize. At most one
 *   paint per event-loop tick (multiple immediate requests merge).
 * - `stream`: streaming assistant/tool deltas. Capped at ~30 FPS; multiple
 *   deltas between frames are merged (latest state wins).
 *
 * Commit effects bypass the scheduler entirely; they go through the surface
 * FIFO queue. After a commit, an immediate live paint is requested.
 *
 * Timer deps are injectable for fake-timer testing. No real sleeps.
 */

export interface TuiRenderSchedulerDeps {
  now: () => number;
  queueMicrotask: (callback: () => void) => void;
  setTimeout: (callback: () => void, delay: number) => unknown;
  clearTimeout: (timer: unknown) => void;
}

export interface TuiRenderScheduler {
  /** Request a paint at the given priority. */
  request(priority: 'stream' | 'immediate'): void;
  /** Flush any pending paint synchronously (for lifecycle / tests). */
  flush(): void;
  /** Stop the scheduler and clear any pending timers. */
  stop(): void;
  /** Performance counters (test/debug only, zeroed on stop). */
  readonly counters: TuiRenderSchedulerCounters;
}

export interface TuiRenderSchedulerCounters {
  paintCount: number;
  requestCount: number;
  coalescedCount: number;
}

const STREAM_FPS = 30;
const STREAM_FRAME_MS = 1000 / STREAM_FPS; // ~33.3ms

export function createTuiRenderScheduler(
  paint: () => void,
  deps?: Partial<TuiRenderSchedulerDeps>,
): TuiRenderScheduler {
  const now = deps?.now ?? (() => Date.now());
  const queueMicrotaskFn = deps?.queueMicrotask ?? queueMicrotask;
  const setTimeoutFn = deps?.setTimeout ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimeoutFn = deps?.clearTimeout ?? ((timer: unknown) => clearTimeout(timer as NodeJS.Timeout));

  let pendingImmediate = false;
  let pendingStreamTimer: unknown = null;
  let lastStreamPaintTime = 0;
  let stopped = false;

  const counters: TuiRenderSchedulerCounters = {
    paintCount: 0,
    requestCount: 0,
    coalescedCount: 0,
  };

  function doPaint(): void {
    counters.paintCount += 1;
    paint();
  }

  function executeImmediate(): void {
    pendingImmediate = false;
    // Cancel any pending stream paint — immediate supersedes it.
    if (pendingStreamTimer !== null) {
      clearTimeoutFn(pendingStreamTimer);
      pendingStreamTimer = null;
    }
    doPaint();
  }

  function executeStream(): void {
    pendingStreamTimer = null;
    lastStreamPaintTime = now();
    doPaint();
  }

  const scheduler: TuiRenderScheduler = {
    request(priority: 'stream' | 'immediate'): void {
      if (stopped) return;
      counters.requestCount += 1;

      if (priority === 'immediate') {
        if (pendingImmediate) {
          // Same-tick coalescing: already have a pending immediate.
          counters.coalescedCount += 1;
          return;
        }
        pendingImmediate = true;
        queueMicrotaskFn(executeImmediate);
        return;
      }

      // Stream priority: FPS cap.
      if (pendingImmediate) {
        // Immediate already scheduled; no need for separate stream paint.
        counters.coalescedCount += 1;
        return;
      }

      if (pendingStreamTimer !== null) {
        // Already waiting for a stream frame; merge.
        counters.coalescedCount += 1;
        return;
      }

      const elapsed = now() - lastStreamPaintTime;
      const remaining = STREAM_FRAME_MS - elapsed;

      if (remaining <= 0) {
        // Enough time has passed; paint on next microtask.
        pendingStreamTimer = setTimeoutFn(executeStream, 0);
      } else {
        pendingStreamTimer = setTimeoutFn(executeStream, remaining);
      }
    },

    flush(): void {
      if (stopped) return;
      const hasPending = pendingImmediate || pendingStreamTimer !== null;
      // Cancel pending timers.
      if (pendingStreamTimer !== null) {
        clearTimeoutFn(pendingStreamTimer);
        pendingStreamTimer = null;
      }
      pendingImmediate = false;
      // Only paint if there was a pending request.
      if (hasPending) {
        doPaint();
      }
    },

    stop(): void {
      stopped = true;
      if (pendingStreamTimer !== null) {
        clearTimeoutFn(pendingStreamTimer);
        pendingStreamTimer = null;
      }
      pendingImmediate = false;
      counters.paintCount = 0;
      counters.requestCount = 0;
      counters.coalescedCount = 0;
    },

    counters,
  };

  return scheduler;
}
