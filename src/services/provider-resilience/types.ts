/**
 * v0.2.25 — Provider Resilience Types.
 *
 * V2 failure taxonomy, retry disposition, attempt record, diagnostics.
 */

export type ProviderFailureKind =
  | 'aborted'
  | 'connect_timeout'
  | 'read_timeout'
  | 'connection_reset'
  | 'network_error'
  | 'rate_limit'
  | 'provider_overloaded'
  | 'server_error'
  | 'conflict'
  | 'auth_failed'
  | 'permission_denied'
  | 'quota_or_credit_exhausted'
  | 'model_not_found'
  | 'invalid_endpoint'
  | 'invalid_request'
  | 'context_overflow'
  | 'request_too_large'
  | 'content_policy'
  | 'malformed_response'
  | 'stream_interrupted'
  | 'unknown';

export type RetryDisposition =
  | 'retry_precommit'
  | 'recover_stream'
  | 'fallback_once'
  | 'defer_until_cooldown'
  | 'fail_fast';

export type CircuitState = 'closed' | 'open' | 'half_open';

export type ProviderRequestState =
  | 'queued'
  | 'waiting_cooldown'
  | 'sending'
  | 'awaiting_first_delta'
  | 'streaming'
  | 'recovering_stream'
  | 'backing_off'
  | 'completed'
  | 'retry_exhausted'
  | 'failed_fast'
  | 'aborted';

export interface ProviderKey {
  providerFamily: string;
  normalizedEndpoint: string;
  accountScopeId?: string;
  modelGroup?: string;
}

export type ProviderOperation =
  | 'root_chat'
  | 'root_chat_stream'
  | 'goal_continuation'
  | 'subagent_chat'
  | 'compact_summary'
  | 'session_summary'
  | 'doctor_probe';

export interface ProviderRequestContext {
  logicalRequestId: string;
  sessionId?: string;
  turnId?: string;
  goalId?: string;
  subtaskId?: string;
  operation: ProviderOperation;
  providerKey: string;
  requestedModel: string;
  abortSignal?: AbortSignal;
  estimatedPromptTokens?: number;
}

export interface ProviderAttemptRecord {
  attemptId: string;
  logicalRequestId: string;
  attemptNumber: number;
  model: string;
  startedAt: number;
  endedAt: number;
  providerRequestId?: string;
  status?: number;
  failureKind?: ProviderFailureKind;
  retryDisposition?: RetryDisposition;
  retryAfterMs?: number;
  backoffMs?: number;
  semanticDeltaSeen: boolean;
  visibleTextBytes: number;
  toolCallDeltaSeen: boolean;
  terminalFinishReasonSeen: boolean;
  outcome: 'succeeded' | 'failed' | 'aborted' | 'recovered' | 'superseded';
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface ProviderRequestDiagnosticsV2 {
  logicalRequestId: string;
  operation: ProviderOperation;
  requestedModel: string;
  finalModel?: string;
  finalState: 'succeeded' | 'recovered' | 'retry_exhausted' | 'failed_fast' | 'aborted' | 'circuit_open';
  attempts: ProviderAttemptRecord[];
  retryCount: number;
  recoveryCount: number;
  fallbackCount: number;
  totalBackoffMs: number;
  sdkRetriesDisabled: true;
  usageConfidence: 'exact' | 'partial' | 'unknown';
  unknownBilledAttemptCount: number;
}

export interface StreamAttemptState {
  attemptId: string;
  text: string;
  visibleTextBytes: number;
  semanticDeltaSeen: boolean;
  toolCallDeltaSeen: boolean;
  partialToolCalls: Map<number, { name?: string; arguments: string }>;
  providerRequestId?: string;
  finishReason?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface ProviderResilienceConfig {
  enabled: boolean;
  maxTotalAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  minRateLimitDelayMs: number;
  maxRetryAfterMs: number;
  maxElapsedMs: number;
  maxStreamRecoveries: number;
  circuitFailureThreshold: number;
  circuitWindowMs: number;
  circuitCooldownMs: number;
}

export const DEFAULT_PROVIDER_RESILIENCE_CONFIG: ProviderResilienceConfig = {
  enabled: true,
  maxTotalAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  minRateLimitDelayMs: 2_000,
  maxRetryAfterMs: 60_000,
  maxElapsedMs: 90_000,
  maxStreamRecoveries: 1,
  circuitFailureThreshold: 5,
  circuitWindowMs: 60_000,
  circuitCooldownMs: 30_000,
};