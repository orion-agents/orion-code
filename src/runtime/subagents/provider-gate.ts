/**
 * SubagentProviderGate: shared concurrency + cooldown for child LLM requests.
 *
 * Each child runs its own loop, but all children draw model requests from the
 * same provider account. The gate bounds concurrent in-flight child execution
 * and shares cooldown state so that one child's 429/retry-after pauses new
 * children rather than letting each independently retry into a storm.
 *
 * The gate does NOT own per-request diagnostics or fallback model state - those
 * live in the child's own LLMService. The gate only owns the shared go/no-go.
 *
 * R4 semantics:
 *   - `canReserve(count)` only reports whether the provider is in an
 *     unrecoverable state (cooldown). Normal concurrency saturation is NOT a
 *     reason to reject - the policy should let batches queue and let the FIFO
 *     semaphore bound actual peak concurrency.
 *   - `acquire(signal?)` queues when slots are full; resolves in FIFO order.
 *     An abort signal atomically removes the waiter and rejects, with no leaked
 *     active slot or listener.
 *   - cooldown has a single wake timer that re-arms on extension; when it
 *     fires it drains queued waiters so they do not hang after the last
 *     release during cooldown.
 */

import type { ProviderRequestGate } from '../../services/provider-resilience/request-gate';

const NULL_PROVIDER_GATE: ProviderRequestGate | null = null;

export interface ProviderGateOptions {
  /** Maximum children running concurrently. */
  maxConcurrent: number;
  /** Optional clock, injectable for deterministic tests. */
  now?: () => number;
  /** Optional timer scheduler (defaults to setTimeout). Injectable for tests. */
  scheduleTimer?: (fn: () => void, ms: number) => { clear(): void };
  /** v0.2.26: shared gate — cooldown is bridged to the root gate when set. */
  sharedGate?: ProviderRequestGate;
}

/** Thrown when an acquire is aborted via its signal. */
export class AcquireAbortedError extends Error {
  constructor() {
    super('Subagent provider gate acquire was aborted');
    this.name = 'AcquireAbortedError';
  }
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  /** Abort handler registered on the signal, or undefined. */
  onAbort?: () => void;
  signal?: AbortSignal;
}

export class SubagentProviderGate {
  private readonly maxConcurrent: number;
  private readonly now: () => number;
  private readonly scheduleTimer: (fn: () => void, ms: number) => { clear(): void };
  /** v0.2.26: shared gate for cooldown bridging across root/child/compact. */
  private readonly sharedGate: ProviderRequestGate | null;
  private active = 0;
  private cooldownUntil = 0;
  private waiters: Waiter[] = [];
  private cooldownTimer: { clear(): void } | null = null;

  constructor(options: ProviderGateOptions) {
    const maxConcurrent = Number(options.maxConcurrent);
    // N12: guard against NaN/undefined/negative — clamp to 1 as safe minimum.
    this.maxConcurrent = Number.isFinite(maxConcurrent) && maxConcurrent >= 1
      ? Math.floor(maxConcurrent)
      : 1;
    this.now = options.now ?? (() => Date.now());
    this.scheduleTimer = options.scheduleTimer ?? defaultScheduleTimer;
    this.sharedGate = options.sharedGate ?? null;
  }

  /** Whether the provider is currently in a cooldown window. */
  isInCooldown(): boolean {
    return this.now() < this.cooldownUntil;
  }

  /** Remaining ms in the current cooldown, or 0. */
  cooldownRemainingMs(): number {
    return Math.max(0, this.cooldownUntil - this.now());
  }

  /**
   * Enter a cooldown after a rate-limit response. New acquires will wait until
   * the window expires. A longer requested cooldown extends; a shorter one is
   * ignored if an active cooldown is longer. Re-arms the wake timer so queued
   * waiters are drained when the cooldown expires (R4: no permanent hang).
   */
  enterCooldown(retryAfterMs: number): void {
    const until = this.now() + Math.max(0, retryAfterMs);
    if (until > this.cooldownUntil) {
      this.cooldownUntil = until;
      this.armCooldownTimer();
    }
    // v0.2.26: bridge cooldown to the shared gate so root/compact also respect it.
    if (this.sharedGate) {
      this.sharedGate.enterCooldown('subagents', until, `Subagent 429/rate-limit, retry-after ${retryAfterMs}ms`);
    }
  }

  /**
   * R4: whether the provider can accept new children. Returns false ONLY during
   * cooldown — normal concurrency saturation is not a rejection reason, because
   * the FIFO semaphore queues excess tasks and bounds actual peak concurrency
   * at acquire time.
   *
   * NOTE: the `count` parameter is currently unused. It is reserved for future
   * per-slot reservation checks. Today, policy only needs to know whether the
   * provider is in an unrecoverable state (cooldown).
   */
  canReserve(_count: number): boolean {
    return !this.isInCooldown();
  }

  /** Number of children currently holding a slot. */
  activeCount(): number {
    return this.active;
  }

  /**
   * Acquire a slot. Resolves once a slot is free and the provider is not in
   * cooldown. The caller MUST call `release()` when the child finishes.
   *
   * R4: if `signal` is provided and aborts while queued, the waiter is removed
   * atomically and the promise rejects with {@link AcquireAbortedError}. No
   * active slot is leaked and the abort listener is removed.
   *
   * The slot is claimed synchronously before the waiter's microtask runs, so
   * `drainWaiters` never over-allocates beyond `maxConcurrent`.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    // Already aborted before we even start.
    if (signal?.aborted) throw new AcquireAbortedError();

    if (this.canReserve(1) && this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      this.waiters.push(waiter);

      if (signal) {
        const onAbort = () => {
          // Atomically remove this waiter; if it was already claimed by
          // drainWaiters (no longer in the queue), the abort is a no-op.
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) {
            this.waiters.splice(idx, 1);
            reject(new AcquireAbortedError());
          }
          signal.removeEventListener('abort', onAbort);
        };
        waiter.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    // NOTE: `this.active` was already incremented by drainWaiters when the
    // slot was claimed synchronously, so we do NOT increment here.
  }

  /** Release a slot and wake the next waiter (if not in cooldown). */
  release(): void {
    this.active = Math.max(0, this.active - 1);
    this.drainWaiters();
  }

  /**
   * Wake waiters in FIFO order. For each waiter, the slot is claimed
   * synchronously (active += 1) BEFORE the promise is resolved, so the
   * next iteration of the while-loop sees the updated count and won't
   * over-allocate.
   */
  private drainWaiters(): void {
    while (this.waiters.length > 0 && !this.isInCooldown() && this.active < this.maxConcurrent) {
      const next = this.waiters.shift();
      if (!next) continue;
      this.active += 1; // claim synchronously before resolving
      // Remove the abort listener (if any) - the waiter is being fulfilled.
      if (next.signal && next.onAbort) {
        next.signal.removeEventListener('abort', next.onAbort);
      }
      next.resolve();
    }
  }

  /**
   * Arm (or re-arm) a single timer that fires when the current cooldown
   * expires, then drains queued waiters. Re-arming on extension keeps a
   * single pending timer at all times.
   */
  private armCooldownTimer(): void {
    if (this.cooldownTimer) {
      this.cooldownTimer.clear();
      this.cooldownTimer = null;
    }
    const remaining = this.cooldownRemainingMs();
    if (remaining <= 0) {
      // Cooldown already over - drain immediately.
      this.drainWaiters();
      return;
    }
    this.cooldownTimer = this.scheduleTimer(() => {
      this.cooldownTimer = null;
      this.drainWaiters();
    }, remaining);
  }
}

function defaultScheduleTimer(fn: () => void, ms: number): { clear(): void } {
  const handle = setTimeout(fn, ms);
  // Don't keep the event loop alive solely for a cooldown wake.
  if (typeof handle === 'object' && handle && 'unref' in handle && typeof handle.unref === 'function') {
    (handle as NodeJS.Timeout).unref();
  }
  return {
    clear() {
      clearTimeout(handle as NodeJS.Timeout);
    },
  };
}
