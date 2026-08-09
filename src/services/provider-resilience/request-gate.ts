/**
 * v0.2.25 — Provider Request Gate.
 *
 * Shared concurrency gate and cooldown for all Provider requests
 * (root, child, compact). Prevents concurrent 429 storms and
 * ensures Retry-After is respected across all request sources.
 */

export interface GateRequest {
  priority: number;
  providerKey: string;
  abortSignal?: AbortSignal;
}

export interface GateLease {
  release: () => void;
}

export interface GateSnapshot {
  activeCount: number;
  waitingCount: number;
  cooldownUntil: number | null;
  cooldownReason: string | null;
}

export interface ProviderRequestGateOptions {
  /** Maximum number of in-flight provider requests. */
  maxConcurrent?: number;
}

interface GateWaiter {
  request: GateRequest;
  resolve: (lease: GateLease) => void;
  reject: (error: Error) => void;
  onAbort?: () => void;
}

export class ProviderRequestGate {
  private readonly maxConcurrent: number;
  private activeCount = 0;
  private waiters: GateWaiter[] = [];
  private cooldownUntil = 0;
  private cooldownReason = '';

  constructor(options: ProviderRequestGateOptions = {}) {
    const configured = Number(options.maxConcurrent ?? 6);
    this.maxConcurrent = Number.isFinite(configured) && configured >= 1
      ? Math.floor(configured)
      : 1;
  }

  /**
   * Acquire a gate lease. If cooldown is active, waits until it expires.
   * Priority ordering: lower number = higher priority.
   */
  acquire(request: GateRequest): Promise<GateLease> {
    if (request.abortSignal?.aborted) {
      return Promise.reject(new Error('aborted'));
    }

    return new Promise((resolve, reject) => {
      const waiter: GateWaiter = { request, resolve, reject };
      if (request.abortSignal) {
        const onAbort = (): void => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) {
            this.waiters.splice(idx, 1);
            reject(new Error('aborted'));
          }
          request.abortSignal?.removeEventListener('abort', onAbort);
        };
        waiter.onAbort = onAbort;
        request.abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      this.waiters.push(waiter);
      // Sort by priority (lower = higher priority).
      this.waiters.sort((a, b) => a.request.priority - b.request.priority);
      this.tryDispatch();
    });
  }

  /**
   * Enter cooldown for a provider key. All new requests wait until
   * the cooldown expires. Existing requests are not aborted.
   */
  enterCooldown(providerKey: string, until: number, reason: string): void {
    if (until > this.cooldownUntil) {
      this.cooldownUntil = until;
      this.cooldownReason = reason;
    }
  }

  /** Snapshot for diagnostics / UI. */
  snapshot(): GateSnapshot {
    return {
      activeCount: this.activeCount,
      waitingCount: this.waiters.length,
      cooldownUntil: this.cooldownUntil > Date.now() ? this.cooldownUntil : null,
      cooldownReason: this.cooldownUntil > Date.now() ? this.cooldownReason : null,
    };
  }

  private tryDispatch(): void {
    while (this.waiters.length > 0 && this.activeCount < this.maxConcurrent) {
      // Check cooldown.
      if (Date.now() < this.cooldownUntil) {
        // Still in cooldown — dispatch after cooldown expires.
        const remaining = this.cooldownUntil - Date.now();
        setTimeout(() => this.tryDispatch(), remaining + 50);
        return;
      }

      const next = this.waiters.shift()!;
      if (next.request.abortSignal && next.onAbort) {
        next.request.abortSignal.removeEventListener('abort', next.onAbort);
      }
      this.activeCount++;
      let released = false;
      next.resolve({
        release: () => {
          if (released) return;
          released = true;
          this.activeCount = Math.max(0, this.activeCount - 1);
          this.tryDispatch();
        },
      });
    }
  }
}
