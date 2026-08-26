/**
 * Subagent runtime public surface.
 *
 * v0.2.20 exposes a read-only subagent runtime. The root Agent may request
 * 1-3 independent investigation packets; a Supervisor runs them as isolated
 * child agents under a unified budget, permission boundary and trace.
 */

export * from './types';
export * from './presets';
export {
  evaluateSubtaskPolicy,
  canonicalizeScopePaths,
  hasExplicitDelegationIntent,
  clampSubagentConfig,
  type PolicyContext,
  type PolicyVerdict,
  type PolicyRejectReason,
} from './policy';
export {
  SubagentBudgetLedger,
  TurnTaskState,
  budgetLimitsFromConfig,
  type SubagentBudgetLimits,
  type ReservedBudget,
  type BudgetSnapshot,
  type BudgetViolation,
} from './budget';
export { buildChildMessages, type ChildContextInputs } from './context-builder';
export { parseSubtaskResult, extractJsonObject, type ParsedSubtaskPayload } from './result-parser';
export {
  createChildToolExecutorGuard,
  evaluateToolCall,
  ScopeHolder,
  type GuardOptions,
  type GuardVerdict,
} from './child-executor-guard';
export {
  runSubtask,
  type SubagentRunnerDeps,
  type ChildToolSet,
  type ExecuteChildQuery,
  type ChildExecutionBudget,
  type RunSubtaskOutcome,
} from './runner';
export { SubagentProviderGate, type ProviderGateOptions } from './provider-gate';
export {
  runSubtaskBatch,
  type SubagentSupervisorDeps,
  type SubtaskResearchResultContext,
  type RunBatchOutcome,
} from './supervisor';
export { createSubtaskTool, coerceSubtaskRequest, summarizeBatchForModel } from './tool';
export {
  ProductionSubagentRuntimeV1,
  ProductionSubagentRuntimeError,
  createProductionSubagentRuntimeV1,
  createChildLlmConfig,
  type ProductionSubagentCapabilityContextV1,
  type ProductionSubagentCapabilityResolverV1,
  type ProductionSubagentRuntimeOptionsV1,
} from './production';
export { SubagentReceiptJournalV1, SubagentReceiptJournalError } from './receipt-journal';
export {
  ParentThreadStepForkSourceV1,
  ParentThreadStepForkSourceError,
  type ParentThreadStepForkSourceOptionsV1,
  type ParentThreadStepForkSourcePortV1,
} from './parent-step-fork';
export type {
  ProductionSubagentExecutionRequestV1,
  ProductionSubagentExecutionOutcomeV1,
  ProductionSubagentExecutionPortV1,
} from './runtime-contract';
export {
  createSubagentToolForTurn,
  createSubagentBundleForTurn,
  deriveRootLlmConfig,
  type SubagentTurnInputs,
  type SubagentTurnBundle,
} from './runtime-integration';
export * from './research-types';
export {
  RESEARCH_HARD_LIMITS,
  createLocalResearchRequest,
  createResearchRequestForSubtask,
  hashPacket,
  stableStringify,
  subtaskResultToPacket,
  validatePacket,
  validateResearchRequest,
  type PacketContext,
  type ResearchPacketInputs,
  type ValidationResult,
} from './research-contract';
export {
  CasMismatchError,
  UnsupportedSchemaError,
  artifactHistory,
  createFileArtifactStore,
  createMemoryArtifactStore,
  loadResearchPacket,
  resumeResearchState,
  saveResearchPacket,
  scopeKey,
  type ArtifactRecord,
  type ResearchArtifactStore,
  type ResearchResumeState,
  type SaveOptions,
  type SaveResult,
  type ResearchScope as ResearchArtifactScope,
} from './research-artifact';
export * from './research-citation';
export * from './research-quality';
export * from './research-renderer';
export * from './web-research-adapter';
