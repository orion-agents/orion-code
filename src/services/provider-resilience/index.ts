/**
 * v0.2.25 — Provider Resilience Module Index.
 */

export { ProviderResilienceCoordinator, ProviderRetryExhaustedError } from './coordinator';
export { classifyProviderError } from './error-classifier';
export { ProviderCircuitBreaker } from './circuit-breaker';
export { ProviderRequestGate } from './request-gate';
export {
  reconcileStreamOverlap,
  buildRecoveryInstruction,
  isSemanticDelta,
  isPartialToolCall,
} from './stream-recovery';
export {
  DEFAULT_PROVIDER_RESILIENCE_CONFIG,
  type ProviderFailureKind,
  type RetryDisposition,
  type CircuitState,
  type ProviderRequestState,
  type ProviderKey,
  type ProviderOperation,
  type ProviderRequestContext,
  type ProviderAttemptRecord,
  type ProviderRequestDiagnosticsV2,
  type StreamAttemptState,
  type ProviderResilienceConfig,
} from './types';