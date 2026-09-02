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
  ProviderAttemptReporter,
} from './types';
import { DEFAULT_PROVIDER_RESILIENCE_CONFIG } from './types';
import { classifyProviderError } from './error-classifier';
import type { GateLease, ProviderRequestGate } from './request-gate';
import { incrementDiagnosticMetric } from '../../utils/observability';

export class ProviderResilienceCoordinator {
  private readonly config: ProviderResilienceConfig;

  constructor(
    config?: Partial<ProviderResilienceConfig>,
    private readonly requestGate?: ProviderRequestGate
  ) {
    this.config = { ...DEFAULT_PROVIDER_RESILIENCE_CONFIG, ...config };
  }

  /** Execute a logical request with full retry/fallback/recovery logic. */
  async execute<T>(
    ctx: ProviderRequestContext,
    transport: (
      attempt: number,
      signal?: AbortSignal,
      model?: string,
      reporter?: ProviderAttemptReporter
    ) => Promise<{
      response: T;
      usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
      providerRequestId?: string;
    }>,
    _options?: {
      onStreamChunk?: (text: string) => void;
      buildRecoveryRequest?: (partialText: string) => Promise<unknown>;
    }
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

    const startedAt = Date.now();
    let lastError: unknown;
    let currentModel = ctx.requestedModel;
    let fallbackUsed = false;
    let recoveredStream = false;

    for (let attempt = 1; attempt <= this.config.maxTotalAttempts; attempt++) {
      // Check elapsed budget
      if (Date.now() - startedAt >= this.config.maxElapsedMs) {
        diagnostics.finalState = 'retry_exhausted';
        throw new ProviderRetryExhaustedError(diagnostics, 'max elapsed time exceeded', lastError);
      }

      // Check abort
      if (ctx.abortSignal?.aborted) {
        diagnostics.finalState = 'aborted';
        throw new ProviderRetryExhaustedError(diagnostics, 'aborted by signal');
      }

      const attemptRecord = this.startAttempt(ctx, attempt, diagnostics, currentModel);
      diagnostics.attempts.push(attemptRecord);
      let gateLease: GateLease | undefined;

      try {
        gateLease = await this.requestGate?.acquire({
          priority: 0,
          providerKey: ctx.providerKey,
          ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
        });
        const result = await transport(
          attempt,
          ctx.abortSignal,
          currentModel,
          this.createAttemptReporter(attemptRecord)
        );

        attemptRecord.outcome = 'succeeded';
        attemptRecord.endedAt = Date.now();
        if (result.usage) attemptRecord.usage = result.usage;
        if (result.providerRequestId) attemptRecord.providerRequestId = result.providerRequestId;

        diagnostics.finalModel = currentModel;
        diagnostics.finalState = recoveredStream ? 'recovered' : 'succeeded';
        if (result.usage) {
          diagnostics.usageConfidence =
            diagnostics.unknownBilledAttemptCount > 0 ? 'partial' : 'exact';
        }
        incrementDiagnosticMetric('provider.request.succeeded');

        return { result: result.response, diagnostics };
      } catch (error) {
        lastError = error;
        attemptRecord.endedAt = Date.now();
        attemptRecord.outcome = 'failed';

        const classification = classifyProviderError(error, attemptRecord.semanticDeltaSeen);
        if (classification.kind === 'aborted') {
          attemptRecord.outcome = 'aborted';
          attemptRecord.failureKind = 'aborted';
          attemptRecord.retryDisposition = 'fail_fast';
          diagnostics.finalState = 'aborted';
          incrementDiagnosticMetric('provider.failure.aborted');
          incrementDiagnosticMetric('provider.request.aborted');
          throw new ProviderRetryExhaustedError(diagnostics, 'aborted by signal', error);
        }
        if (classification.kind === 'rate_limit' && classification.retryAfterMs) {
          this.requestGate?.enterCooldown(
            ctx.providerKey,
            Date.now() + classification.retryAfterMs,
            `Provider rate limit; retry-after ${classification.retryAfterMs}ms`
          );
        }
        attemptRecord.failureKind = classification.kind;
        if (attemptRecord.semanticDeltaSeen && !attemptRecord.usage) {
          diagnostics.unknownBilledAttemptCount++;
          diagnostics.usageConfidence = 'partial';
          recoveredStream = true;
        }
        const shouldFallback =
          !fallbackUsed &&
          typeof ctx.fallbackModel === 'string' &&
          ctx.fallbackModel.length > 0 &&
          ctx.fallbackModel !== currentModel &&
          [
            'rate_limit',
            'provider_overloaded',
            'server_error',
            'network_error',
            'connect_timeout',
            'read_timeout',
            'connection_reset',
            'quota_or_credit_exhausted',
            'model_not_found',
          ].includes(classification.kind);
        const disposition = shouldFallback ? 'fallback_once' : classification.disposition;
        attemptRecord.retryDisposition = disposition;
        attemptRecord.retryAfterMs = classification.retryAfterMs;
        attemptRecord.status = classification.status;

        switch (disposition) {
          case 'fail_fast':
            diagnostics.finalState = 'failed_fast';
            incrementDiagnosticMetric(`provider.failure.${classification.kind}`);
            incrementDiagnosticMetric('provider.request.failed_fast');
            throw new ProviderRetryExhaustedError(
              diagnostics,
              `fail fast: ${classification.kind}`,
              error
            );

          case 'retry_precommit':
          case 'recover_stream':
            if (attempt >= this.config.maxTotalAttempts) {
              diagnostics.finalState = 'retry_exhausted';
              throw new ProviderRetryExhaustedError(
                diagnostics,
                `max attempts (${this.config.maxTotalAttempts}) reached`,
                error
              );
            }
            if (
              disposition === 'recover_stream' &&
              diagnostics.recoveryCount >= this.config.maxStreamRecoveries
            ) {
              diagnostics.finalState = 'retry_exhausted';
              throw new ProviderRetryExhaustedError(
                diagnostics,
                `max stream recoveries (${this.config.maxStreamRecoveries}) reached`,
                error
              );
            }
            const delay = computeProviderBackoff(this.config, attempt, classification.retryAfterMs);
            attemptRecord.backoffMs = delay;
            diagnostics.totalBackoffMs += delay;
            diagnostics.retryCount++;
            incrementDiagnosticMetric('provider.retry');

            if (disposition === 'recover_stream') {
              diagnostics.recoveryCount++;
              incrementDiagnosticMetric('provider.stream_recovery');
            }

            await this.sleep(delay, ctx.abortSignal);
            break;

          case 'fallback_once':
            fallbackUsed = true;
            diagnostics.fallbackCount++;
            incrementDiagnosticMetric('provider.fallback');
            currentModel = ctx.fallbackModel as string;
            break;

          case 'defer_until_cooldown':
            diagnostics.finalState = 'retry_exhausted';
            incrementDiagnosticMetric('provider.cooldown');
            throw new ProviderRetryExhaustedError(diagnostics, 'provider cooldown active', error);
        }
      } finally {
        gateLease?.release();
      }
    }

    diagnostics.finalState = 'retry_exhausted';
    throw new ProviderRetryExhaustedError(
      diagnostics,
      `max attempts exhausted: ${String(lastError)}`,
      lastError
    );
  }

  getConfig(): ProviderResilienceConfig {
    return { ...this.config };
  }

  private startAttempt(
    ctx: ProviderRequestContext,
    attempt: number,
    diag: ProviderRequestDiagnosticsV2,
    model: string
  ): ProviderAttemptRecord {
    return {
      attemptId: randomUUID().slice(0, 8),
      logicalRequestId: ctx.logicalRequestId,
      attemptNumber: attempt,
      model,
      startedAt: Date.now(),
      endedAt: 0,
      semanticDeltaSeen: false,
      visibleTextBytes: 0,
      toolCallDeltaSeen: false,
      terminalFinishReasonSeen: false,
      outcome: 'failed',
    };
  }

  private createAttemptReporter(attempt: ProviderAttemptRecord): ProviderAttemptReporter {
    return {
      onTextDelta: text => {
        if (!text) return;
        attempt.semanticDeltaSeen = true;
        attempt.visibleTextBytes += Buffer.byteLength(text, 'utf8');
      },
      onToolCallDelta: () => {
        attempt.semanticDeltaSeen = true;
        attempt.toolCallDeltaSeen = true;
      },
      onFinishReason: finishReason => {
        const normalized = finishReason.trim();
        if (!normalized) return;
        attempt.terminalFinishReasonSeen = true;
        attempt.finishReason = normalized;
      },
    };
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, _reject) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
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

/**
 * Equal-jitter retry delay with Retry-After taking precedence. Provider waits
 * above the configured cap are clamped to the cap instead of discarded.
 */
export function computeProviderBackoff(
  config: ProviderResilienceConfig,
  attempt: number,
  retryAfterMs?: number,
  random: () => number = Math.random
): number {
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    const cappedRetryAfter = Math.min(retryAfterMs, config.maxRetryAfterMs);
    return Math.min(config.maxRetryAfterMs, Math.max(cappedRetryAfter, config.minRateLimitDelayMs));
  }
  const cap = Math.max(
    0,
    Math.min(config.maxDelayMs, config.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)))
  );
  return cap / 2 + Math.floor(random() * (cap / 2));
}

export class ProviderRetryExhaustedError extends Error {
  readonly recoverableTurnFailure = true;

  constructor(
    readonly diagnostics: ProviderRequestDiagnosticsV2,
    reason: string,
    readonly originalError?: unknown
  ) {
    super(`Provider retry exhausted: ${reason}`);
    this.name = 'ProviderRetryExhaustedError';
  }
}
