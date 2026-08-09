import {
  computeProviderBackoff,
  ProviderResilienceCoordinator,
  ProviderRetryExhaustedError,
  type ProviderAttemptReporter,
} from '../src/services/provider-resilience';
import { DEFAULT_PROVIDER_RESILIENCE_CONFIG } from '../src/services/provider-resilience/types';

describe('ProviderResilienceCoordinator stream and backoff contracts', () => {
  it('records semantic stream state and unknown billed usage before recovery', async () => {
    const coordinator = new ProviderResilienceCoordinator({
      maxTotalAttempts: 2,
      baseDelayMs: 0,
      maxDelayMs: 0,
      minRateLimitDelayMs: 0,
    });

    const outcome = await coordinator.execute(
      {
        logicalRequestId: 'stream-recovery-1',
        operation: 'root_chat_stream',
        providerKey: 'provider',
        requestedModel: 'model',
      },
      async (attempt, _signal, _model, reporter) => {
        if (attempt === 1) {
          reporter?.onTextDelta('partial');
          reporter?.onToolCallDelta();
          throw new Error('socket ECONNRESET');
        }
        reporter?.onTextDelta('complete');
        reporter?.onFinishReason('end_turn');
        return {
          response: 'complete',
          usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
        };
      }
    );

    expect(outcome.result).toBe('complete');
    expect(outcome.diagnostics).toMatchObject({
      finalState: 'recovered',
      retryCount: 1,
      recoveryCount: 1,
      unknownBilledAttemptCount: 1,
      usageConfidence: 'partial',
    });
    expect(outcome.diagnostics.attempts[0]).toMatchObject({
      semanticDeltaSeen: true,
      visibleTextBytes: 7,
      toolCallDeltaSeen: true,
      retryDisposition: 'recover_stream',
    });
    expect(outcome.diagnostics.attempts[1]).toMatchObject({
      terminalFinishReasonSeen: true,
      finishReason: 'end_turn',
      outcome: 'succeeded',
    });
  });

  it('fails closed after the configured number of stream recoveries', async () => {
    const coordinator = new ProviderResilienceCoordinator({
      maxTotalAttempts: 3,
      maxStreamRecoveries: 1,
      baseDelayMs: 0,
      maxDelayMs: 0,
      minRateLimitDelayMs: 0,
    });
    const transport = jest.fn(
      async (
        _attempt: number,
        _signal?: AbortSignal,
        _model?: string,
        reporter?: ProviderAttemptReporter
      ) => {
        reporter?.onTextDelta('partial');
        throw new Error('read ECONNRESET');
      }
    );

    let caught: ProviderRetryExhaustedError | undefined;
    try {
      await coordinator.execute(
        {
          logicalRequestId: 'stream-recovery-limit',
          operation: 'root_chat_stream',
          providerKey: 'provider',
          requestedModel: 'model',
        },
        transport
      );
    } catch (error) {
      if (error instanceof ProviderRetryExhaustedError) caught = error;
    }

    expect(caught).toBeDefined();
    expect(caught?.message).toContain('max stream recoveries (1) reached');
    expect(caught?.diagnostics).toMatchObject({
      finalState: 'retry_exhausted',
      recoveryCount: 1,
      unknownBilledAttemptCount: 2,
    });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('clamps oversized Retry-After and keeps it ahead of the rate-limit floor', () => {
    const config = { ...DEFAULT_PROVIDER_RESILIENCE_CONFIG };

    expect(computeProviderBackoff(config, 1, 120_000)).toBe(60_000);
    expect(computeProviderBackoff(config, 1, 250)).toBe(2_000);
    expect(computeProviderBackoff(config, 1, 60_000)).toBe(60_000);
  });

  it('uses bounded jitter only when Retry-After is absent', () => {
    const config = { ...DEFAULT_PROVIDER_RESILIENCE_CONFIG };

    expect(computeProviderBackoff(config, 1, undefined, () => 0)).toBe(250);
    expect(computeProviderBackoff(config, 1, undefined, () => 0.999)).toBeLessThanOrEqual(500);
  });
});
