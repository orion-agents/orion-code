/**
 * v0.2.25 — Provider Resilience Coordinator.
 *
 * Single owner of all Provider retry decisions. Replaces withRetry() in llm.ts
 * and the global fallback mutable state. All root/child/compact requests go
 * through this coordinator.
 */

import { randomUUID } from 'crypto';
import type {
  ProviderRequestContext,
  ProviderAttemptRecord,
  ProviderRequestDiagnosticsV2,
  ProviderResilienceConfig,
  StreamAttemptState,
} from './types';
import { DEFAULT_PROVIDER_RESILIENCE_CONFIG } from './types';
import { classifyProviderError } from './error-classifier';

export class ProviderResilienceCoordinator {
  private readonly config: ProviderResilienceConfig;

  constructor(config?: Partial<ProviderResilienceConfig>) {
    this.config = { ...DEFAULT_PROVIDER_RESILIENCE_CONFIG, ...config };
  }

  /** Execute a logical request with full retry/fallback/recovery logic. */
  async execute<T>(
    ctx: ProviderRequestContext,
    transport: (attempt: number, signal?: AbortSignal) => Promise<{ response: T; usage?: { promptTokens: number; completionTokens: number; totalTokens: number }; providerRequestId?: string }>,
    options?: {
      onStreamChunk?: (text: string) => void;
      buildRecoveryRequest?: (partialText: string) => Promise<unknown>;
    },
  ): Promise<{ result: T; diagnostics: ProviderRequestDiagnosticsV2 }> {
    const diagnostics: ProviderRequestDiagnosticsV2 = {
      logicalRequestId: ctx.logicalRequestId,
      operation: ctx.operation,
      requestedModel: ctx.requestedModel,
      sdkRetriesDisabled: true,
      finalState: 'succeeded',
      attempts: [],
      retryCount: 0,
      recoveryCount: 0,
      fallbackCount: 0,
      totalBackoffMs: 0,
      usageConfidence: 'unknown',
      unknownBilledAttemptCount: 0,
    };

    let streamState: StreamAttemptState | null = null;
    const startedAt = Date.now();
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.config.maxTotalAttempts; attempt++) {
      // Check elapsed budget
      if (Date.now() - startedAt >= this.config.maxElapsedMs) {
        diagnostics.finalState = 'retry_exhausted';
        throw new ProviderRetryExhaustedError(diagnostics, 'max elapsed time exceeded');
      }

      // Check abort
      if (ctx.abortSignal?.aborted) {
        diagnostics.finalState = 'aborted';
        throw new ProviderRetryExhaustedError(diagnostics, 'aborted by signal');
      }

      const attemptRecord = this.startAttempt(ctx, attempt, diagnostics);
      diagnostics.attempts.push(attemptRecord);

      try {
        const result = await transport(attempt, ctx.abortSignal);

        attemptRecord.outcome = 'succeeded';
        attemptRecord.endedAt = Date.now();
        if (result.usage) attemptRecord.usage = result.usage;
        if (result.providerRequestId) attemptRecord.providerRequestId = result.providerRequestId;

        diagnostics.finalModel = ctx.requestedModel;
        diagnostics.finalState = streamState ? 'recovered' : 'succeeded';
        if (result.usage) diagnostics.usageConfidence = 'exact';

        return { result: result.response, diagnostics };
      } catch (error) {
        lastError = error;
        attemptRecord.endedAt = Date.now();
        attemptRecord.outcome = 'failed';

        const classification = classifyProviderError(error, attemptRecord.semanticDeltaSeen);
        attemptRecord.failureKind = classification.kind;
        attemptRecord.retryDisposition = classification.disposition;
        attemptRecord.retryAfterMs = classification.retryAfterMs;
        attemptRecord.status = classification.status;

        switch (classification.disposition) {
          case 'fail_fast':
            diagnostics.finalState = 'failed_fast';
            throw new ProviderRetryExhaustedError(diagnostics, `fail fast: ${classification.kind}`);

          case 'retry_precommit':
          case 'recover_stream':
            if (attempt >= this.config.maxTotalAttempts) {
              diagnostics.finalState = 'retry_exhausted';
              throw new ProviderRetryExhaustedError(diagnostics, `max attempts (${this.config.maxTotalAttempts}) reached`);
            }
            const delay = this.computeBackoff(attempt, classification.retryAfterMs);
            attemptRecord.backoffMs = delay;
            diagnostics.totalBackoffMs += delay;
            diagnostics.retryCount++;

            if (classification.disposition === 'recover_stream') {
              diagnostics.recoveryCount++;
            }

            await this.sleep(delay, ctx.abortSignal);
            break;

          case 'fallback_once':
            diagnostics.fallbackCount++;
            break;

          case 'defer_until_cooldown':
            diagnostics.finalState = 'retry_exhausted';
            throw new ProviderRetryExhaustedError(diagnostics, 'provider cooldown active');
        }
      }
    }

    diagnostics.finalState = 'retry_exhausted';
    throw new ProviderRetryExhaustedError(diagnostics, `max attempts exhausted: ${String(lastError)}`);
  }

  getConfig(): ProviderResilienceConfig {
    return { ...this.config };
  }

  private startAttempt(ctx: ProviderRequestContext, attempt: number, diag: ProviderRequestDiagnosticsV2): ProviderAttemptRecord {
    return {
      attemptId: randomUUID().slice(0, 8),
      logicalRequestId: ctx.logicalRequestId,
      attemptNumber: attempt,
      model: ctx.requestedModel,
      startedAt: Date.now(),
      endedAt: 0,
      semanticDeltaSeen: false,
      visibleTextBytes: 0,
      toolCallDeltaSeen: false,
      terminalFinishReasonSeen: false,
      outcome: 'failed',
    };
  }

  private computeBackoff(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs && retryAfterMs > 0 && retryAfterMs <= this.config.maxRetryAfterMs) {
      return Math.max(retryAfterMs, this.config.minRateLimitDelayMs);
    }
    const cap = Math.min(this.config.maxDelayMs, this.config.baseDelayMs * Math.pow(2, attempt - 1));
    return cap / 2 + Math.floor(Math.random() * (cap / 2));
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { resolve(); return; }
      const timer = setTimeout(resolve, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(); // Don't reject — abort is not an error for backoff
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

export class ProviderRetryExhaustedError extends Error {
  readonly recoverableTurnFailure = true;

  constructor(
    readonly diagnostics: ProviderRequestDiagnosticsV2,
    reason: string,
  ) {
    super(`Provider retry exhausted: ${reason}`);
    this.name = 'ProviderRetryExhaustedError';
  }
}