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

export class ProviderRequestGate {
  private activeCount = 0;
  private waiters: Array<{
    request: GateRequest;
    resolve: (lease: GateLease) => void;
    reject: (error: Error) => void;
  }> = [];
  private cooldownUntil = 0;
  private cooldownReason = '';

  /**
   * Acquire a gate lease. If cooldown is active, waits until it expires.
   * Priority ordering: lower number = higher priority.
   */
  acquire(request: GateRequest): Promise<GateLease> {
    if (request.abortSignal?.aborted) {
      return Promise.reject(new Error('aborted'));
    }

    return new Promise((resolve, reject) => {
      this.waiters.push({ request, resolve, reject });
      // Sort by priority (lower = higher priority).
      this.waiters.sort((a, b) => a.request.priority - b.request.priority);
      this.tryDispatch();

      if (request.abortSignal) {
        request.abortSignal.addEventListener('abort', () => {
          const idx = this.waiters.findIndex(w => w.resolve === resolve);
          if (idx >= 0) {
            this.waiters.splice(idx, 1);
            reject(new Error('aborted'));
          }
        }, { once: true });
      }
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
    while (this.waiters.length > 0) {
      // Check cooldown.
      if (Date.now() < this.cooldownUntil) {
        // Still in cooldown — dispatch after cooldown expires.
        const remaining = this.cooldownUntil - Date.now();
        setTimeout(() => this.tryDispatch(), remaining + 50);
        return;
      }

      const next = this.waiters.shift()!;
      this.activeCount++;
      next.resolve({
        release: () => {
          this.activeCount = Math.max(0, this.activeCount - 1);
          this.tryDispatch();
        },
      });
    }
  }
}