export type LoopBudgetBaseProfile = 'default' | 'complex' | 'release';
export type LoopBudgetSource = LoopBudgetBaseProfile | 'config';

export interface LoopBudget {
  /** Maximum LLM requests allowed for one user turn before stopping. */
  maxLlmRequestsPerUserTurn: number;
  /** Maximum tool calls allowed for one user turn before stopping. */
  maxToolCallsPerUserTurn: number;
  /** Consecutive single read-only tool turns before injecting a batch_read hint. */
  maxReadOnlyFragmentation: number;
  /** Maximum aggregate tool-result bytes exposed to the model in one user turn. */
  maxModelVisibleToolBytes: number;
  /** Budget source after config overrides are applied. */
  profile?: LoopBudgetSource;
  /** Adaptive profile selected before config overrides, when applicable. */
  baseProfile?: LoopBudgetBaseProfile;
  /** Whether user/global/env config changed one or more numeric budget fields. */
  configOverride?: boolean;
}

export const DEFAULT_LOOP_BUDGET: Readonly<LoopBudget> = Object.freeze({
  maxLlmRequestsPerUserTurn: 24,
  maxToolCallsPerUserTurn: 120,
  maxReadOnlyFragmentation: 3,
  maxModelVisibleToolBytes: 64 * 1024,
  profile: 'default',
  baseProfile: 'default',
  configOverride: false,
});
