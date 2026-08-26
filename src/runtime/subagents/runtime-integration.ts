/**
 * Turn-level bridge for the modern subagent runtime.
 *
 * The bridge is intentionally dependency-injected. If the product composition
 * root has not supplied a durable parent fork anchor and production child
 * runtime, the capability is unavailable instead of falling back to query()
 * or a process-global tool catalog.
 */

import type { OrionCodeTool } from '../../framework/tool';
import type { LLMConfig } from '../../services/llm';
import type { OrionCodeCLIConfig } from '../../services/config';
import type { ProviderResilienceCoordinator } from '../../services/provider-resilience';
import type { ProviderRequestPreflight } from '../../services/llm';
import type { ProviderRequestGate } from '../../services/provider-resilience/request-gate';
import type { AuthoritySnapshotV1 } from '../step-snapshot';
import type { ParentThreadForkRequestV1 } from '../subagent-thread-runtime';
import { SubagentBudgetLedger, budgetLimitsFromConfig, TurnTaskState } from './budget';
import type { ParentThreadStepForkSourcePortV1 } from './parent-step-fork';
import { SubagentProviderGate } from './provider-gate';
import type { ProductionSubagentExecutionPortV1 } from './runtime-contract';
import { runSubtaskBatch, type SubagentSupervisorDeps } from './supervisor';
import { createSubtaskTool } from './tool';
import type { RuntimeSubtaskEvent, SubagentConfig, SubtaskResult, SubtaskUsage } from './types';
import type { WebResearchResult } from './web-research-adapter';
import type { WebResearchDeps } from './web-research-adapter';
import type { ResearchRequest } from './research-types';

export interface SubagentTurnInputs {
  config: SubagentConfig;
  cwd: string;
  rootLlmConfig: Pick<LLMConfig, 'apiKey' | 'baseUrl' | 'model' | 'fallbackModel'>;
  /** Explicit modern child runtime. No legacy fallback is consulted. */
  productionRuntime?: ProductionSubagentExecutionPortV1;
  /** Current active model step's durable StepSnapshot/CapabilityReceipt boundary. */
  parentFork?: ParentThreadForkRequestV1;
  /** Product seam populated by CapabilityReceiptJournal after the current step is captured. */
  parentForkSource?: ParentThreadStepForkSourcePortV1;
  /** Frozen root authority; the child role policy can only narrow it. */
  parentAuthority?: AuthoritySnapshotV1;
  modelLabel?: string;
  rootObjectiveSummary?: string;
  abortSignal?: AbortSignal;
  onSubtaskEvent?: (event: RuntimeSubtaskEvent) => void;
  onSubtaskResult?: (
    result: SubtaskResult,
    batchId: string,
    objective?: string,
    research?: import('./supervisor').SubtaskResearchResultContext
  ) => void;
  hasPendingPermission?: () => boolean;
  onChildUsage?: (
    taskId: string,
    role: import('./types').SubagentRole,
    usage: SubtaskUsage,
    modelLabel?: string
  ) => void;
  sharedGate?: ProviderRequestGate;
  /** @deprecated Accepted during product migration but never used as a child-loop shortcut. */
  resilience?: ProviderResilienceCoordinator;
  /** @deprecated Bind provider preflight on ProductionSubagentRuntimeV1 instead. */
  beforeProviderRequest?: ProviderRequestPreflight;
  /** @deprecated Raw research deps are ignored; inject runWebResearch via ToolGateway. */
  webResearchDeps?: WebResearchDeps;
  /** Root ToolGateway-backed external capability. Raw tool executors are not accepted here. */
  runWebResearch?: (
    request: ResearchRequest,
    parentAbortSignal?: AbortSignal
  ) => Promise<WebResearchResult>;
}

export interface SubagentTurnBundle {
  tool: OrionCodeTool;
  getAggregateUsage: () => SubtaskUsage;
  getSubtaskCount: () => number;
  /** Must be called from the root ThreadRuntime onTurnSettled hook. Idempotent. */
  close: (reason?: string) => void | Promise<void>;
}

/**
 * Build the root `subtask` tool. Missing modern dependencies are a deliberate
 * fail-closed result while the product composition root migrates its parent
 * fork anchor.
 */
export function createSubagentBundleForTurn(inputs: SubagentTurnInputs): SubagentTurnBundle | null {
  const { config, cwd, abortSignal, onSubtaskEvent } = inputs;
  if (config.mode === 'off' || !inputs.rootLlmConfig.apiKey) return null;
  if (
    !inputs.productionRuntime ||
    (!inputs.parentFork && !inputs.parentForkSource) ||
    !inputs.parentAuthority
  ) {
    return null;
  }

  const providerGate = new SubagentProviderGate({
    maxConcurrent: config.maxParallel,
    sharedGate: inputs.sharedGate,
  });
  const budget = new SubagentBudgetLedger(
    budgetLimitsFromConfig({
      maxModelRequestsPerTurn: config.maxModelRequestsPerTurn,
      maxModelRequestsPerTask: config.maxModelRequestsPerTask,
      maxToolCallsPerTask: config.maxToolCallsPerTask,
      timeoutMs: config.timeoutMs,
    })
  );
  const turnTaskState = new TurnTaskState();
  let closed = false;
  const supervisorDeps: SubagentSupervisorDeps = {
    config,
    cwd,
    budget,
    providerGate,
    executeChild: inputs.productionRuntime,
    parentFork: inputs.parentFork,
    parentForkSource: inputs.parentForkSource,
    parentAuthority: inputs.parentAuthority,
    turnTaskState,
    hasPendingPermission: inputs.hasPendingPermission,
    onChildUsage: inputs.onChildUsage,
    parentAbortSignal: abortSignal,
    rootObjectiveSummary: inputs.rootObjectiveSummary,
    modelLabel: inputs.modelLabel,
    onEvent: onSubtaskEvent,
    onSubtaskResult: inputs.onSubtaskResult,
    runWebResearch: inputs.runWebResearch,
  };
  return {
    tool: createSubtaskTool(supervisorDeps),
    getAggregateUsage: () => budget.aggregateUsage(),
    getSubtaskCount: () => budget.reconciledTaskCount(),
    close: async reason => {
      if (closed) return;
      closed = true;
      try {
        await inputs.productionRuntime!.close(reason ?? 'parent_turn_settled');
      } finally {
        inputs.parentForkSource?.close(reason ?? 'parent_turn_settled');
      }
    },
  };
}

export function createSubagentToolForTurn(inputs: SubagentTurnInputs): OrionCodeTool | null {
  return createSubagentBundleForTurn(inputs)?.tool ?? null;
}

/** Derive the root LLM config slice from the legacy runtime config. */
export function deriveRootLlmConfig(
  config: OrionCodeCLIConfig
): Pick<LLMConfig, 'apiKey' | 'baseUrl' | 'model' | 'fallbackModel'> {
  const registry = config.modelRegistry;
  const profile = registry?.defaultProfile;
  const provider = profile ? registry?.providers.get(profile.provider) : undefined;
  if (profile && provider) {
    const apiKey = provider.apiKey.startsWith('$')
      ? (process.env[provider.apiKey.slice(1)] ?? '')
      : provider.apiKey;
    return {
      apiKey,
      baseUrl: provider.baseUrl,
      model: profile.model,
      fallbackModel:
        registry?.fallbackProfile?.provider === profile.provider
          ? registry.fallbackProfile.model
          : undefined,
    };
  }
  return {
    apiKey: config.apiKey,
    baseUrl: config.apiBaseUrl,
    model: config.model,
    fallbackModel: config.fallbackModel,
  };
}

export { runSubtaskBatch };
