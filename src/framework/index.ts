/**
 * Orion Code - Framework module
 *
 * Core framework components:
 *   - Tool System v2 (buildTool factory)
 *   - Query Loop (async generator)
 *   - System Prompt Builder (segment-based)
 *   - State Store (pub-sub)
 */

export { buildTool, toOpenAITool, toOpenAITools } from './tool';
export {
  serializeToolResult,
  parseToolResultEnvelope,
  TOOL_RESULT_SCHEMA_VERSION,
} from './tool-serializer';
export type {
  OrionCodeTool,
  ToolResult,
  ToolContext,
  ToolConfig,
  PermissionResult,
  ToolInputJSONSchema,
  OpenAITool,
} from './tool';
export { deriveToolExternalAssertion, isToolExternalAssertion } from './external-assertion';
export type {
  ToolExternalAssertion,
  ToolExternalAssertionAction,
  ToolExternalAssertionStatus,
} from './external-assertion';

export {
  query,
  DEFAULT_LOOP_BUDGET,
  QueryLoopError,
  createFailedLoopStats,
  createLocalFastPathLoopStats,
  withLoopFinishReason,
} from './query';
export type {
  AutoCompactNotice,
  LoopBudget,
  LoopBudgetBaseProfile,
  LoopBudgetSource,
  LoopContinuationAction,
  LoopFinishReason,
  LoopStats,
  QueryEvent,
  QueryCompactCommit,
  QueryParams,
} from './query';
export { createStopDecision } from './stop-decision';
export type {
  StopDecision,
  StopDecisionInput,
  StopDecisionScope,
  StopDecisionStatus,
  StopDisposition,
  StopEvidence,
  StopNextAction,
  StopReason,
  StopResourceCounter,
  StopResourceSnapshot,
} from './stop-decision';

export { prepareToolCalls, executeToolCalls, inspectSchedule } from './tool-scheduler';
export type {
  PreparedToolCall,
  ExecutedToolCall,
  ToolSchedule,
  ToolSchedulerOptions,
} from './tool-scheduler';

export { buildSystemPrompt, getSystemPrompt } from './prompt';
export type { PromptContext, PromptSection } from './prompt';

export { Store } from './store';
export type { AppState } from './store';

export {
  ContextHarness,
  HarnessKernel,
  createContextHarness,
  createHarnessKernel,
  ContextLedger,
  createContextCapsule,
  renderContextCapsule,
  renderHarnessStateForCompact,
  assembleHarnessMessages,
  buildHarnessContext,
  classifyIntent,
  rankEvidence,
  upgradeHarnessState,
  ProgressController,
  StopController,
  createCapabilityProfile,
} from '../harness';
export type {
  CapabilityProfile,
  CapabilityProfileInput,
  CompletionCriterionResult,
  CompletionGateResult,
  ContextCapsule,
  ContextLedgerEntry,
  EvidenceRecord,
  HarnessConfig,
  HarnessProgressState,
  IntentKind,
  IntentUpdate,
  HarnessState,
  PromptAssemblyStats,
  PromptSectionManifestEntry,
  ProgressDelta,
  ProgressSnapshot,
  TaskContract,
  TaskCriterion,
  TaskCriterionScope,
  TaskCriterionSource,
  TaskCriterionStatus,
  TaskCriterionWaiver,
  TurnSummary,
  VerificationKind,
} from '../harness';

export { getToolState, setToolState, subscribeToolState, resetToolState } from './tool-state';
export type { ToolState, TodoItem } from './tool-state';
