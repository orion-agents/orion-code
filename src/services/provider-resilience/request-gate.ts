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

interface ProviderCooldown {
  until: number;
  reason: string;
}

function createGateAbortError(): Error {
  const error = new Error('Provider request gate acquisition aborted.');
  error.name = 'AbortError';
  return error;
}

export class ProviderRequestGate {
  private readonly maxConcurrent: number;
  private activeCount = 0;
  private readonly activeByProvider = new Map<string, number>();
  private waiters: GateWaiter[] = [];
  private readonly cooldowns = new Map<string, ProviderCooldown>();
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private cooldownTimerDue = 0;

  constructor(options: ProviderRequestGateOptions = {}) {
    const configured = Number(options.maxConcurrent ?? 6);
    this.maxConcurrent =
      Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 1;
  }

  /**
   * Acquire a gate lease. If cooldown is active, waits until it expires.
   * Priority ordering: lower number = higher priority.
   */
  acquire(request: GateRequest): Promise<GateLease> {
    if (request.abortSignal?.aborted) {
      return Promise.reject(createGateAbortError());
    }

    return new Promise((resolve, reject) => {
      const waiter: GateWaiter = { request, resolve, reject };
      if (request.abortSignal) {
        const onAbort = (): void => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) {
            this.waiters.splice(idx, 1);
            reject(createGateAbortError());
            this.tryDispatch();
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
   * Enter cooldown for one provider key. Other providers may continue to use
   * the shared concurrency budget. Existing requests are not aborted.
   */
  enterCooldown(providerKey: string, until: number, reason: string): void {
    const current = this.cooldowns.get(providerKey);
    if (!current || until > current.until) {
      this.cooldowns.set(providerKey, { until, reason });
      this.tryDispatch();
    }
  }

  /** Snapshot for diagnostics / UI. */
  snapshot(providerKey?: string): GateSnapshot {
    this.clearExpiredCooldowns();
    const cooldown = providerKey
      ? this.cooldowns.get(providerKey)
      : [...this.cooldowns.values()].sort((a, b) => b.until - a.until)[0];
    return {
      activeCount: providerKey ? (this.activeByProvider.get(providerKey) ?? 0) : this.activeCount,
      waitingCount: providerKey
        ? this.waiters.filter(waiter => waiter.request.providerKey === providerKey).length
        : this.waiters.length,
      cooldownUntil: cooldown?.until ?? null,
      cooldownReason: cooldown?.reason ?? null,
    };
  }

  private tryDispatch(): void {
    this.clearExpiredCooldowns();
    while (this.waiters.length > 0 && this.activeCount < this.maxConcurrent) {
      const nextIndex = this.waiters.findIndex(
        waiter => !this.cooldowns.has(waiter.request.providerKey)
      );
      if (nextIndex < 0) break;
      const [next] = this.waiters.splice(nextIndex, 1);
      if (next.request.abortSignal && next.onAbort) {
        next.request.abortSignal.removeEventListener('abort', next.onAbort);
      }
      this.activeCount++;
      const providerKey = next.request.providerKey;
      this.activeByProvider.set(providerKey, (this.activeByProvider.get(providerKey) ?? 0) + 1);
      let released = false;
      next.resolve({
        release: () => {
          if (released) return;
          released = true;
          this.activeCount = Math.max(0, this.activeCount - 1);
          const providerActive = Math.max(0, (this.activeByProvider.get(providerKey) ?? 1) - 1);
          if (providerActive === 0) this.activeByProvider.delete(providerKey);
          else this.activeByProvider.set(providerKey, providerActive);
          this.tryDispatch();
        },
      });
    }
    this.scheduleCooldownWake();
  }

  private clearExpiredCooldowns(): void {
    const now = Date.now();
    for (const [key, cooldown] of this.cooldowns) {
      if (cooldown.until <= now) this.cooldowns.delete(key);
    }
  }

  private scheduleCooldownWake(): void {
    const waitingKeys = new Set(this.waiters.map(waiter => waiter.request.providerKey));
    const earliest = [...waitingKeys]
      .map(key => this.cooldowns.get(key)?.until)
      .filter((until): until is number => until !== undefined)
      .sort((a, b) => a - b)[0];

    if (earliest === undefined || this.activeCount >= this.maxConcurrent) {
      if (this.cooldownTimer && earliest === undefined) {
        clearTimeout(this.cooldownTimer);
        this.cooldownTimer = null;
        this.cooldownTimerDue = 0;
      }
      return;
    }
    if (this.cooldownTimer && this.cooldownTimerDue <= earliest) return;
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cooldownTimerDue = earliest;
    this.cooldownTimer = setTimeout(
      () => {
        this.cooldownTimer = null;
        this.cooldownTimerDue = 0;
        this.tryDispatch();
      },
      Math.max(0, earliest - Date.now()) + 1
    );
    const timer = this.cooldownTimer as { unref?: () => void };
    timer.unref?.();
  }
}
