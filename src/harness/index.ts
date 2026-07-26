export { ContextHarness, createContextHarness } from './context-harness';
export type { ContextHarnessOptions } from './context-harness';
export {
  createTaskContract,
  extractExplicitObjective,
  normalizeTaskContract,
  updateTaskContract,
} from './contract';
export { ContextLedger } from './ledger';
export type { AddLedgerEntryInput } from './ledger';
export {
  createContextCapsule,
  normalizeContextCapsule,
  renderContextCapsule,
  renderHarnessStateForCompact,
} from './capsule';
export { assembleHarnessMessages, buildHarnessContext, renderHarnessContext } from './assembler';
export type { HarnessContextBuildResult, PromptAssemblyOptions } from './assembler';
export { buildEvidenceIndex, bumpIncludedEvidence, estimateTokens, rankEvidence } from './evidence';
export { classifyIntent, shouldReplaceActiveInstruction } from './intent';
export { summarizeHarnessStateForMeta, upgradeHarnessState } from './state';
export { createTurnSummary } from './turn-summary';
export type { CreateTurnSummaryInput, SessionMessageLike } from './turn-summary';
export { checkToolDrift, evaluateCompletionGate } from './drift-guard';
export type {
  CompletionGateResult,
  ContextCapsule,
  ContextLedgerEntry,
  DriftCheckResult,
  EvidenceKind,
  EvidenceRecord,
  HarnessConfig,
  HarnessSidecar,
  HarnessState,
  IntentKind,
  IntentUpdate,
  LedgerEntryType,
  LedgerSource,
  PlanStep,
  PromptAssemblyStats,
  RankedEvidenceRecord,
  TaskContract,
  TurnSummary,
} from './types';
