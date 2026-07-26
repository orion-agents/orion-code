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
  type RunSubtaskOutcome,
} from './runner';
export {
  SubagentProviderGate,
  type ProviderGateOptions,
} from './provider-gate';
export {
  runSubtaskBatch,
  type SubagentSupervisorDeps,
  type RunBatchOutcome,
} from './supervisor';
export {
  createSubtaskTool,
  coerceSubtaskRequest,
  summarizeBatchForModel,
} from './tool';
export {
  createProductionExecuteQuery,
  createChildLlmConfig,
  type SubagentLlmFactoryDeps,
} from './production';
export {
  createSubagentToolForTurn,
  createSubagentBundleForTurn,
  deriveRootLlmConfig,
  type SubagentTurnInputs,
  type SubagentTurnBundle,
} from './runtime-integration';
