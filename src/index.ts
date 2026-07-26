/**
 * Orion Code - goal-driven coding agent for the terminal.
 *
 * Public API export entry point.
 */

// Core
export { Brain } from './core/brain';
export type { BrainConfig } from './core/brain';

export { BaseAgent } from './core/agent';
export type { AgentConfig, Task, TaskResult, AgentStatus } from './core/agent';

// Agent implementations
export { LeaderAgent } from './agents/leader';
export { CoderAgent } from './agents/coder';

// Init & runtime
export { init, Harness, MemorySystem } from './init';
export type {
  OrionCodeConfig,
  OrionCodeRuntime,
  HarnessConfig,
  MemoryConfig,
  SafetyConfig,
  HarnessVerdict,
  AgentRegistryEntry,
  MemoryEntry as InitMemoryEntry,
  MemoryTier as InitMemoryTier,
} from './init';

// @deprecated — use OrionCodeConfig instead
export type { OrionCodeConfig as OpenHorseConfig } from './init';
// @deprecated — use OrionCodeRuntime instead
export type { OrionCodeRuntime as OpenHorseRuntime } from './init';

// Harness safety module
export { SafetyChecker } from './harness/safety';
export type { SafetyPolicy, SafetyCheck, SecurityLevel, AuditLogEntry } from './harness/safety';

// Memory store module
export { MemoryStore } from './memory/store';
export type {
  MemoryStoreConfig,
  MemoryEntry as StoreMemoryEntry,
  MemoryTier as StoreMemoryTier,
  MemoryQuery,
} from './memory/store';

// LLM service module
export { LLMService } from './services/llm';
export type {
  LLMConfig,
  Message,
  LLMResponse,
  StreamCallback,
} from './services/llm';

// Agent Runner module
export { AgentRunner } from './services/agent-runner';
export type {
  AgentRunnerConfig,
  AgentRunnerResult,
} from './services/agent-runner';

// Harness Engine module (public API compatibility)
export { HarnessEngine } from './harness/harness';
export type {
  HarnessConfig as HarnessEngineConfig,
  HarnessVerdict as HarnessEngineVerdict,
  HarnessContext,
  HarnessExecutionResult,
} from './harness/harness';

// Task Manager module
export { TaskManager } from './services/task-manager';
export type {
  TaskRecord,
  CreateTaskOptions,
  UpdateTaskOptions,
  TaskFilter,
  TaskStats,
  TaskStatus,
  Priority,
} from './services/task-manager';

// Config module
export { loadConfig, isConfigured, getConfigErrors, getConfigSummary } from './services/config';
export type { OrionCodeCLIConfig, OpenHorseCLIConfig } from './services/config';

// Framework module
export {
  buildTool, toOpenAITool, toOpenAITools,
  query,
  buildSystemPrompt, getSystemPrompt,
  Store,
  ContextHarness, createContextHarness, ContextLedger,
  createContextCapsule, renderContextCapsule, renderHarnessStateForCompact,
  assembleHarnessMessages, buildHarnessContext, classifyIntent, rankEvidence, upgradeHarnessState,
} from './framework';
export type {
  OrionCodeTool, ToolResult, ToolContext, ToolConfig, PermissionResult, ToolInputJSONSchema, OpenAITool,
  AutoCompactNotice, QueryEvent, QueryParams,
  PromptContext, PromptSection,
  AppState,
  ContextCapsule, ContextLedgerEntry, EvidenceRecord, HarnessConfig as ContextHarnessConfig,
  HarnessState, IntentKind, IntentUpdate, PromptAssemblyStats, TaskContract, TurnSummary,
} from './framework';

// @deprecated — use OrionCodeTool instead
export type { OrionCodeTool as OpenHorseTool } from './framework';

export type {
  ContextUsageSnapshot,
  ContextUsageSource,
} from './services/model-context';