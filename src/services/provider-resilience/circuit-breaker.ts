/**
 * v0.2.25 — Provider Circuit Breaker.
 *
 * Prevents repeated requests to a failing provider. Counts logical request
 * failures (not individual attempts), with half-open probing.
 */

import type { CircuitState } from './types';

export interface CircuitBreakerConfig {
  failureThreshold: number;
  windowMs: number;
  cooldownMs: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  windowMs: 60_000,
  cooldownMs: 30_000,
};

interface FailureEntry {
  timestamp: number;
}

export class ProviderCircuitBreaker {
  private state: CircuitState = 'closed';
  private failures: FailureEntry[] = [];
  private openedAt = 0;
  private probeActive = false;
  private readonly config: CircuitBreakerConfig;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get currentState(): CircuitState {
    return this.state;
  }

  /** Check if a request can proceed. Returns false if circuit is open. */
  allowRequest(): boolean {
    this.pruneFailures();

    if (this.state === 'closed') return true;

    if (this.state === 'open') {
      if (Date.now() >= this.cooldownUntil) {
        // Transition to half-open, allow one probe.
        this.state = 'half_open';
        this.probeActive = true;
        return true;
      }
      return false;
    }

    // half_open: only allow if no probe is active.
    if (this.probeActive) return false;
    this.probeActive = true;
    return true;
  }

  /** Record a successful logical request. */
  recordSuccess(): void {
    if (this.state === 'half_open') {
      this.state = 'closed';
      this.probeActive = false;
      this.failures = [];
    }
    // In closed state, just prune.
    this.pruneFailures();
  }

  /** Record a failed logical request (retry_exhausted or failed_fast). */
  recordFailure(): void {
    this.pruneFailures();
    this.failures.push({ timestamp: Date.now() });

    if (this.state === 'half_open') {
      // Probe failed — reopen.
      this.state = 'open';
      this.openedAt = Date.now();
      this.probeActive = false;
      return;
    }

    if (this.failures.length >= this.config.failureThreshold) {
      this.state = 'open';
      this.openedAt = Date.now();
      this.probeActive = false;
    }
  }

  /** Force close (e.g., on user resume or provider recovery). */
  reset(): void {
    this.state = 'closed';
    this.failures = [];
    this.probeActive = false;
  }

  private get cooldownUntil(): number {
    return this.openedAt + this.config.cooldownMs;
  }

  private pruneFailures(): void {
    const cutoff = Date.now() - this.config.windowMs;
    this.failures = this.failures.filter(f => f.timestamp > cutoff);
  }
}