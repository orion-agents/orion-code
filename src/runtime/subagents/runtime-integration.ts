/**
 * Turn-level integration: build the runtime-bound `subtask` tool for a root turn.
 *
 * This is the bridge between {@link AgentChatController} and the subagent
 * runtime. It resolves the child tool set from the global runtime tools, builds
 * the production executeQuery, the budget ledger, the provider gate and the
 * Supervisor, and returns the `subtask` OpenHorseTool to merge into the root
 * turn's tool list. Returns null when subagents are off or the LLM is absent,
 * so the root loop is unchanged.
 */

import type { OpenHorseTool, ToolContext } from '../../framework/tool';
import { SubagentBudgetLedger, budgetLimitsFromConfig, TurnTaskState } from './budget';
import { SubagentProviderGate } from './provider-gate';
import { createProductionExecuteQuery } from './production';
import { runSubtaskBatch, type SubagentSupervisorDeps } from './supervisor';
import { createSubtaskTool } from './tool';
import { filterToolsForRole, assertNoForbiddenTools } from './presets';
import { createChildToolExecutorGuard, ScopeHolder } from './child-executor-guard';
import type { RuntimeSubtaskEvent, SubagentConfig, SubtaskUsage } from './types';
import type { LLMConfig } from '../../services/llm';
import type { ProviderResilienceCoordinator } from '../../services/provider-resilience';
import type { OpenHorseCLIConfig } from '../../services/config';

/**
 * Lazy accessor for the runtime tool pool.
 *
 * Importing `../../tools` at module top-level creates a circular dependency:
 *   subagents barrel → runtime-integration → tools/index → web → config → subagents/types
 * When `tools/index` loads before `web.ts` finishes, `WEB_TOOLS` is still
 * `undefined` and `...WEB_TOOLS` throws "not iterable". Deferring the import
 * to call-time breaks the cycle because by then all modules have initialized.
 */
function lazyRuntimeTools() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const tools = require('../../tools') as typeof import('../../tools');
  return { executeTool: tools.executeTool, getRuntimeTools: tools.getRuntimeTools };
}

export interface SubagentTurnInputs {
  /** Resolved subagent config (from runtime.config.subagents). */
  config: SubagentConfig;
  /** Canonical project root. */
  cwd: string;
  /** Root LLM config derived from runtime config (apiKey, baseUrl, model, ...). */
  rootLlmConfig: Pick<LLMConfig, 'apiKey' | 'baseUrl' | 'model' | 'fallbackModel'>;
  /** Model label shown to children. */
  modelLabel?: string;
  /** Root objective summary forwarded to children. */
  rootObjectiveSummary?: string;
  /** Root turn abort signal; propagated to every child. */
  abortSignal?: AbortSignal;
  /** Lifecycle event sink (runtime event + trace). */
  onSubtaskEvent?: (event: RuntimeSubtaskEvent) => void;
  /** Called once per finished task with its structured result, for artifact persistence. */
  onSubtaskResult?: (result: import('./types').SubtaskResult, batchId: string) => void;
  /**
   * R6: live permission state from the root runtime. Returns true when a
   * permission request is awaiting user decision. When provided, the policy
   * gate uses it instead of a hardcoded false, preventing background
   * delegation while the user is deciding a permission.
   */
  hasPendingPermission?: () => boolean;
  /**
   * R6: called with each child's observed usage so the root loop can record
   * it into its shared CostTracker. The observed values are never clamped;
   * `/cost` and telemetry must reflect the truth.
   */
  onChildUsage?: (taskId: string, role: import('./types').SubagentRole, usage: import('./types').SubtaskUsage, modelLabel?: string) => void;
  /** v0.2.26: shared resilience coordinator for child LLM requests. */
  resilience?: ProviderResilienceCoordinator;
}

/**
 * Build the `subtask` tool for a root turn, or null if disabled.
 *
 * Returns a bundle: the tool to merge into the root turn's tool list, plus an
 * accessor for the aggregate child usage so the root loop can fold child cost
 * into its loop stats and `/cost`. The bundle is null when subagents are off.
 */
export function createSubagentBundleForTurn(inputs: SubagentTurnInputs): SubagentTurnBundle | null {
  const { config, cwd, rootLlmConfig, abortSignal, onSubtaskEvent } = inputs;
  if (config.mode === 'off') return null;
  if (!rootLlmConfig.apiKey) return null;

  // Resolve child tools: all v0.2.20 roles share the read-only allowlist, so
  // filter once for 'research'. Assert no forbidden tool slips in as a
  // defense-in-depth check (the allowlist already excludes them, but this
  // catches future regressions).
  const { executeTool, getRuntimeTools } = lazyRuntimeTools();
  const runtimeTools = getRuntimeTools();
  const availableNames = runtimeTools.map(t => t.name);
  const allowedNames = new Set(filterToolsForRole(availableNames, 'research', runtimeTools));
  const childTools: OpenHorseTool[] = runtimeTools.filter(t => allowedNames.has(t.name));
  assertNoForbiddenTools(childTools.map(t => t.name));

  // Defense-in-depth: map tool name -> definition so the executor can re-verify
  // isReadOnly() on every call. A tool that is not read-only must never execute
  // in a child context, regardless of what the allowlist says at construction.
  const childToolByName = new Map<string, OpenHorseTool>();
  for (const t of childTools) childToolByName.set(t.name, t);

  // R3: scope holder lets the supervisor set the current packet's scope
  // before each child runs, so the turn-level guard enforces per-packet
  // containment without rebuilding the executor.
  const scopeHolder = new ScopeHolder();

  const unguardedExecutor = async (name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> => {
    if (!allowedNames.has(name)) {
      return JSON.stringify({ success: false, error: `Tool ${name} is not available to subagents.` });
    }
    // Re-verify read-only at execution time: catches tools whose isReadOnly()
    // returns false (mutating MCP actions, future regressions).
    const tool = childToolByName.get(name);
    if (!tool || tool.isReadOnly?.(args) !== true) {
      return JSON.stringify({ success: false, error: `Tool ${name} is not read-only and cannot run in a subagent.` });
    }
    const toolContext: ToolContext = { cwd, config: { name: 'orion-code-subagent', mode: 'subagent' }, abortSignal: signal };
    return executeTool(name, args, signal, toolContext);
  };

  const childToolExecutor = createChildToolExecutorGuard(unguardedExecutor, {
    rootCwd: cwd,
    scopeHolder,
  });

  const providerGate = new SubagentProviderGate({
    maxConcurrent: config.maxParallel,
    sharedGate: inputs.resilience ? (inputs as any).sharedGate ?? undefined : undefined,
  });
  const budget = new SubagentBudgetLedger(budgetLimitsFromConfig({
    maxModelRequestsPerTurn: config.maxModelRequestsPerTurn,
    maxModelRequestsPerTask: config.maxModelRequestsPerTask,
    maxToolCallsPerTask: config.maxToolCallsPerTask,
    timeoutMs: config.timeoutMs,
  }));
  // R6: turn-level task counter persists across `subtask` calls so multiple
  // calls in one root turn cannot exceed `maxTasksPerTurn`.
  const turnTaskState = new TurnTaskState();

  const executeQuery = createProductionExecuteQuery({
    rootConfig: rootLlmConfig,
    providerGate,
    maxTurnsPerTask: config.maxTurnsPerTask,
    resilience: inputs.resilience,
  });

  const supervisorDeps: SubagentSupervisorDeps = {
    config,
    cwd,
    budget,
    providerGate,
    executeQuery,
    toolSet: { tools: childTools, toolExecutor: childToolExecutor },
    scopeHolder,
    turnTaskState,
    hasPendingPermission: inputs.hasPendingPermission,
    onChildUsage: inputs.onChildUsage,
    parentAbortSignal: abortSignal,
    rootObjectiveSummary: inputs.rootObjectiveSummary,
    modelLabel: inputs.modelLabel,
    onEvent: onSubtaskEvent,
    onSubtaskResult: inputs.onSubtaskResult,
  };

  const tool = createSubtaskTool(supervisorDeps);
  return {
    tool,
    /** Read-only accessor for the reconciled aggregate child usage this turn. */
    getAggregateUsage: () => budget.aggregateUsage(),
    /** Number of subtasks that ran (reconciled) this turn. */
    getSubtaskCount: () => budget.reconciledTaskCount(),
  };
}

/**
 * Backwards-compatible wrapper returning only the tool. Prefer
 * {@link createSubagentBundleForTurn} when the root loop needs to fold child
 * usage into its stats.
 */
export function createSubagentToolForTurn(inputs: SubagentTurnInputs): OpenHorseTool | null {
  const bundle = createSubagentBundleForTurn(inputs);
  return bundle ? bundle.tool : null;
}

/** A subtask turn bundle: the tool plus usage accessors for the root loop. */
export interface SubagentTurnBundle {
  tool: OpenHorseTool;
  /** Reconciled aggregate usage across all children that ran this turn. */
  getAggregateUsage: () => SubtaskUsage;
  /** Best-effort count of subtasks that ran this turn. */
  getSubtaskCount: () => number;
}

/** Derive the root LLM config slice from the runtime config. */
export function deriveRootLlmConfig(config: OpenHorseCLIConfig): Pick<LLMConfig, 'apiKey' | 'baseUrl' | 'model' | 'fallbackModel'> {
  return {
    apiKey: config.apiKey,
    baseUrl: config.apiBaseUrl,
    model: config.model,
    fallbackModel: config.fallbackModel,
  };
}

/** Re-exported for the root loop to read aggregate usage after a turn. */
export { runSubtaskBatch };
