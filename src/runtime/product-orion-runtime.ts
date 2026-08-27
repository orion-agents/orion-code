import { join } from 'path';

import type { Store } from '../framework/store';
import type { ToolContext } from '../framework/tool';
import { buildSystemPrompt } from '../framework/prompt';
import { createStopDecision, type StopDecision } from '../framework/stop-decision';
import type { OrionCodeCLIConfig } from '../services/config';
import type { CompactCoordinator } from '../services/compact/coordinator';
import { buildMemoryPromptContext } from '../memory/prompt-context';
import type { HarnessState } from '../harness';
import { buildReferencedFilesPrompt } from '../services/file-context';
import { loadGoal } from '../services/goal-storage';
import { LLMService, type LLMConfig, type Message } from '../services/llm';
import { loadSessionHarnessState, readSessionMessages } from '../services/session-storage';
import { estimateTokens } from '../utils/token-estimate';
import { getProjectThreadsV2Dir } from '../product/paths';
import { createBuiltinToolCatalogV1, type BuiltinToolCatalogV1 } from './builtin-tool-provider';
import type { CapabilityToolCandidateV1 } from './capabilities';
import type { GoalLifecycleStateV2 } from './goal-lifecycle-v2';
import type { GoalRuntimeDefinitionV2 } from './goal-runtime-coordinator';
import { materializeLegacyThreadV1, resolveSessionStorageV1 } from './legacy-thread-materializer';
import { ThreadEventStore } from './thread-event-store';
import type {
  LazyMcpRuntimeOptions,
  McpCatalogSnapshotV1,
  McpConnectionV1,
  McpConnectorV1,
  McpRuntimeToolBindingV1,
  McpServerDescriptorInputV1,
} from './mcp';
import {
  createOrionRuntimeV1,
  type OrionCapabilityStepConfigurationV1,
  type OrionPromptCompositionContextV1,
  type OrionRuntimeV1,
  type OrionSubagentCompositionV1,
  type OrionSubagentTurnCapabilityV1,
  type OrionSubagentTurnFactoryInputV1,
} from './orion-runtime-v1';
import type { AgentLoopStepPrepareInputV1 } from './capability-step-factory';
import type { AgentLoopTurnCommitV1 } from './agent-loop';
import {
  digestPromptSource,
  type PromptAssemblyReceiptV1,
  type PromptRegistryV1,
  type PromptSectionInputV1,
} from './prompts';
import { digestRuntimeValue } from './protocol/canonical';
import type {
  LoadedSkillDefinitionV1,
  SkillCatalogV1,
  SkillDescriptorV1,
  SkillAuthorityV1,
  SkillProviderV1,
} from './skills';
import type { FirstPartyApprovalHandlerV1 } from './first-party-tool-services';
import { normalizeSessionModelHistoryV1 } from './session-history-recovery';
import {
  createAuthoritySnapshotV1,
  createExecutionPolicySnapshotV1,
  type AuthoritySnapshotV1,
  type ToolBindingV1,
  type ToolRiskMetadataV1,
} from './step-snapshot';
import type { SubagentThreadReceiptV1 } from './subagent-thread-runtime';
import { createChildLlmConfig, createProductionSubagentRuntimeV1 } from './subagents/production';
import { createSubagentBundleForTurn, deriveRootLlmConfig } from './subagents/runtime-integration';
import { clampSubagentConfig } from './subagents/policy';
import { ParentThreadStepForkSourceV1 } from './subagents/parent-step-fork';
import { READ_ONLY_INVESTIGATION_TOOLS } from './subagents/presets';
import { DEFAULT_SUBAGENT_CONFIG, type SubagentConfig, type SubagentRole } from './subagents/types';
import {
  parsePlanReceiptV1,
  parseTurnCommitV1,
  type PlanExecutionModeV1,
  type PlanReceiptV1,
  type TurnCommitV1,
} from './turn-commit';

export interface ProductOrionRuntimeOptionsV1 {
  readonly cwd: string;
  readonly config: OrionCodeCLIConfig;
  readonly store: Store;
  readonly llm: LLMService;
  /** Runtime-owned coordinator used by automatic and explicit maintenance compaction. */
  readonly compactCoordinator?: CompactCoordinator;
  readonly toolCatalog: BuiltinToolCatalogV1;
  readonly skillProviders?: readonly SkillProviderV1[];
  readonly mcpDescriptors?: readonly McpServerDescriptorInputV1[];
  readonly mcpConnector?: McpConnectorV1;
  readonly approvalHandler?: FirstPartyApprovalHandlerV1;
  /** Must create a distinct mutable provider client for every child request. */
  readonly createSubagentModelExecutor?: (input: {
    readonly role: SubagentRole;
    readonly objective: string;
    readonly abortSignal: AbortSignal;
  }) => LLMService;
  /** Product telemetry hook; the same receipt is already durable in the child journal. */
  readonly onSubagentReceipt?: (receipt: SubagentThreadReceiptV1) => void | Promise<void>;
}

/** Build one explicit OrionRuntime owner for a legacy Session/v2 Thread identity. */
export function createProductOrionRuntimeV1(
  options: ProductOrionRuntimeOptionsV1,
  sessionId: string
): OrionRuntimeV1 {
  let promptState:
    | {
        readonly turnId: string;
        readonly mode: 'build' | 'plan' | 'auto' | 'goal' | 'maintenance';
        readonly planReturnMode: PlanExecutionModeV1;
        readonly receipt: PromptAssemblyReceiptV1;
        readonly skillCatalog: SkillCatalogV1;
        readonly loadedSkills: readonly LoadedSkillDefinitionV1[];
        readonly explicitSkillIds: readonly string[];
      }
    | undefined;
  const scheduledPlanReceipts = new Set<string>();
  let storage = resolveSessionStorageV1(options.cwd, sessionId);
  if (storage.kind === 'legacy') {
    materializeLegacyThreadV1({ projectPath: options.cwd, sessionId });
    storage = resolveSessionStorageV1(options.cwd, sessionId);
  }
  if (storage.kind !== 'thread') {
    throw new Error(`Session ${sessionId} did not cut over to a v2 Thread.`);
  }

  const existingProjection = new ThreadEventStore(
    getProjectThreadsV2Dir(options.cwd),
    storage.threadId
  ).loadProjection();
  const hasDurableTurnCommit = Object.values(existingProjection.turns).some(turn => turn.commit);

  const profile = options.config.modelRegistry?.defaultProfile;
  const provider = profile
    ? options.config.modelRegistry?.providers.get(profile.provider)
    : undefined;
  const modelId = profile?.model ?? options.llm.getModel();
  const contextWindow = profile?.contextWindow ?? 128_000;
  // Legacy sidecars are migration seeds only. Once a TurnCommit exists, its
  // TaskContext and Goal state are the sole durable authority on restart.
  const taskState = hasDurableTurnCommit
    ? undefined
    : (loadSessionHarnessState(sessionId) ?? undefined);
  const goalSeed = hasDurableTurnCommit ? undefined : loadProductGoalSeed(options.cwd, sessionId);
  const executionPolicy = createExecutionPolicySnapshotV1({
    policyId: 'orion-product-policy-v1',
    approvalMode: options.config.toolConfirmation === 'ask' ? 'interactive' : 'never',
    // Workspace file tools provide path containment. Shell sandboxing remains
    // explicitly recorded by FirstPartySandboxService; a project grant may
    // execute with enforcement=none without pretending a sandbox exists.
    sandboxRequired: false,
    sandboxBackend: 'configured-first-party',
    timeoutMs: 120_000,
  });
  const subagents = createProductSubagentCompositionV1(options, {
    modelId,
    providerId: profile?.provider ?? 'configured-provider',
    protocol: provider?.protocol ?? 'openai-compatible',
    providerProtocol: provider?.protocol,
    contextWindow,
  });

  const runtime = createOrionRuntimeV1({
    modelExecutor: options.llm,
    toolCatalog: options.toolCatalog,
    toolContext: {
      cwd: options.cwd,
      config: { name: options.config.name, mode: options.config.mode },
    },
    eventStore: {
      rootDir: getProjectThreadsV2Dir(options.cwd),
      threadId: storage.threadId,
    },
    projectPath: options.cwd,
    taskContext: {
      cwd: options.cwd,
      modelId,
      ...(taskState ? { state: taskState } : {}),
    },
    ...(goalSeed ? { goal: goalSeed } : {}),
    skills: { providers: [...(options.skillProviders ?? [])] },
    mcp: {
      descriptors: [...(options.mcpDescriptors ?? [])],
      connector: options.mcpConnector ?? INERT_MCP_CONNECTOR,
    } satisfies Omit<LazyMcpRuntimeOptions, 'signal'>,
    approvalHandler: options.approvalHandler,
    ...(subagents ? { subagents } : {}),
    resolveCapabilityConfiguration: async (input, context) => {
      if (!promptState || promptState.turnId !== input.turnId) {
        throw new Error(`Prompt receipt is missing for active turn ${input.turnId}.`);
      }
      const dynamicTools = await resolveMcpToolsForStep(input, context.mcp, context.mcpCatalog);
      return capabilityConfiguration({
        options,
        input,
        modelId,
        contextWindow,
        providerId: profile?.provider ?? 'configured-provider',
        protocol: provider?.protocol ?? 'openai-compatible',
        executionPolicy,
        skillCatalog: promptState.skillCatalog,
        loadedSkills: promptState.loadedSkills,
        explicitSkillIds: promptState.explicitSkillIds,
        promptReceipt: promptState.receipt,
        dynamicTools,
      });
    },
    loadBaseMessages: async (store, context, prompts, composition) => {
      const assembled = await buildProductMessages(
        options,
        sessionId,
        store,
        prompts,
        composition,
        context.input,
        context.mode,
        contextWindow
      );
      promptState = {
        turnId: context.turnId,
        mode: context.mode,
        planReturnMode: productPlanReturnMode(options.store),
        receipt: assembled.receipt,
        skillCatalog: assembled.skillCatalog,
        loadedSkills: assembled.loadedSkills,
        explicitSkillIds: assembled.explicitSkillIds,
      };
      return assembled.messages;
    },
    loop: {
      ...(options.compactCoordinator ? { compactCoordinator: options.compactCoordinator } : {}),
      onContextUsage: usage => options.store.setContextUsage(usage),
      prepareTurnCommit: commit => {
        const active = promptState;
        if (!active || active.turnId !== commit.turnId || active.mode !== 'plan') return {};
        const plan = extractDecisionCompletePlan(commit);
        return {
          stopDecision: createPlanStopDecision(commit, active.receipt.digest),
          plan: {
            plan,
            returnMode: active.planReturnMode,
            promptReceiptDigest: active.receipt.digest,
          },
        };
      },
      onTurnCommitted: (commit, durableCommit) => {
        if (promptState?.turnId === commit.turnId) promptState = undefined;
        if (commit.queryComplete.stats) options.store.setLastLoopStats(commit.queryComplete.stats);
        options.store.setState({
          harnessState: commit.taskContextState,
          conversationHistory: commit.history.map(message => ({ ...message })),
        });
        const planReceipt = planReceiptFromCommit(durableCommit);
        if (planReceipt) {
          projectPlanReceipt(options.store, planReceipt);
          schedulePlanExecution(runtime, planReceipt, scheduledPlanReceipts);
        }
      },
      onRuntimeStarted: ({ restoredCommit, thread }) => {
        if (restoredCommit) projectRestoredTurnCommit(options.store, restoredCommit);
        const planReceipt = restoredCommit ? planReceiptFromCommit(restoredCommit) : undefined;
        if (!planReceipt) return;
        projectPlanReceipt(options.store, planReceipt);
        if (thread.getProjection().queue.length === 0) {
          schedulePlanExecution(runtime, planReceipt, scheduledPlanReceipts);
        }
      },
    },
  });
  return runtime;
}

function createProductSubagentCompositionV1(
  options: ProductOrionRuntimeOptionsV1,
  model: {
    readonly modelId: string;
    readonly providerId: string;
    readonly protocol: string;
    readonly providerProtocol?: LLMConfig['providerProtocol'];
    readonly contextWindow: number;
  }
): OrionSubagentCompositionV1 | undefined {
  const config = clampSubagentConfig(options.config.subagents ?? DEFAULT_SUBAGENT_CONFIG);
  const rootLlmConfig = deriveRootLlmConfig(options.config);
  if (config.mode === 'off' || !rootLlmConfig.apiKey) return undefined;

  const allowedNames = new Set<string>(READ_ONLY_INVESTIGATION_TOOLS);
  const childTools = options.toolCatalog.entries
    .filter(
      entry =>
        allowedNames.has(entry.candidate.descriptor.name) &&
        entry.candidate.descriptor.risk.readOnly &&
        !entry.candidate.descriptor.risk.destructive &&
        entry.candidate.descriptor.risk.network === 'none'
    )
    .map(entry => entry.tool);
  const toolContext: ToolContext = {
    cwd: options.cwd,
    config: { name: options.config.name, mode: options.config.mode },
  };
  const childCatalog = createBuiltinToolCatalogV1(childTools, { context: toolContext });
  const childExecutionPolicy = createExecutionPolicySnapshotV1({
    policyId: 'orion-product-subagent-readonly-v1',
    approvalMode: 'never',
    sandboxRequired: false,
    sandboxBackend: 'workspace-path-containment',
    timeoutMs: config.timeoutMs,
  });
  const rolePolicies = createProductSubagentRolePolicies(options, config);
  const issuedModels = new WeakSet<LLMService>();
  const childRuntimeServicesDigest = digestRuntimeValue({
    version: 1,
    owner: 'product-subagent-composition-v1',
    loop: 'agent-loop-v1',
    gateway: 'tool-gateway-v1',
    toolCatalog: childCatalog.digest,
  });
  const emptySkillCatalogDigest = digestRuntimeValue({ version: 1, skills: [] });
  const emptyMcpCatalogDigest = digestRuntimeValue({ version: 1, servers: [] });

  return Object.freeze({
    serviceId: 'product-subagent-composition-v1',
    createTurn: async (
      input: OrionSubagentTurnFactoryInputV1
    ): Promise<OrionSubagentTurnCapabilityV1 | null> => {
      if (input.abortSignal.aborted) return null;
      const parentForkSource = new ParentThreadStepForkSourceV1({
        store: input.store,
        flush: input.flush,
      });
      let productionRuntime: ReturnType<typeof createProductionSubagentRuntimeV1> | undefined;
      try {
        productionRuntime = createProductionSubagentRuntimeV1({
          childStoreRootDir: join(getProjectThreadsV2Dir(options.cwd), 'subagents'),
          receiptRootDir: join(getProjectThreadsV2Dir(options.cwd), 'subagent-receipts'),
          toolCatalog: childCatalog,
          treeLimits: {
            maxConcurrent: config.maxParallel,
            maxQueued: config.maxTasksPerTurn,
            maxModelRequests: config.maxModelRequestsPerTurn,
            maxToolCalls: config.maxToolCallsPerTask * config.maxTasksPerTurn,
          },
          rolePolicies,
          createModelExecutor: childInput => {
            const executor = options.createSubagentModelExecutor
              ? options.createSubagentModelExecutor(childInput)
              : createProductChildModelExecutor(options, rootLlmConfig, model.providerProtocol);
            if (executor === options.llm || issuedModels.has(executor)) {
              throw new Error(
                'Subagent model factory must return a distinct LLMService for every child request.'
              );
            }
            issuedModels.add(executor);
            return executor;
          },
          resolveCapabilityConfiguration: (step, context) => ({
            taskEpoch: 1,
            model: {
              providerId: model.providerId,
              modelId: context.modelId,
              protocol: model.protocol,
              contextWindow: model.contextWindow,
            },
            executionPolicy: childExecutionPolicy,
            environment: {
              cwd: context.authority.projectRoot,
              platform: process.platform,
              arch: process.arch,
              environmentDigest: digestRuntimeValue({
                cwd: context.authority.projectRoot,
                platform: process.platform,
                arch: process.arch,
              }),
            },
            compiler: {
              task: { objective: context.objective },
              model: { toolCalling: true },
              authority: context.authority,
              budgets: {
                maxDirectTools: Math.max(1, childCatalog.candidates.length),
                maxToolSchemaBytes: Math.max(1, childCatalog.toolSchemaBytes),
                maxDeferredTools: 0,
                maxExpansionTools: 0,
              },
              tools: childCatalog.candidates,
              runtimeServicesDigest: childRuntimeServicesDigest,
              executionPolicyDigest: childExecutionPolicy.digest,
              skillCatalogDigest: emptySkillCatalogDigest,
              mcpCatalogDigest: emptyMcpCatalogDigest,
              estimatedInputTokens: estimateTokens(step.input),
            },
          }),
          toolContext: (_request, authority) => ({
            ...toolContext,
            cwd: authority.projectRoot,
          }),
          runtimeServicesDigest: childRuntimeServicesDigest,
          onReceipt: options.onSubagentReceipt,
          parentAbortSignal: input.abortSignal,
        });
        const bundle = createSubagentBundleForTurn({
          config,
          cwd: options.cwd,
          rootLlmConfig,
          productionRuntime,
          parentForkSource,
          parentAuthority: input.authority,
          modelLabel: model.modelId,
          rootObjectiveSummary: input.input,
          abortSignal: input.abortSignal,
        });
        if (!bundle) {
          productionRuntime.close('subagent_turn_unavailable');
          parentForkSource.close('subagent_turn_unavailable');
          return null;
        }
        const catalog = createBuiltinToolCatalogV1([bundle.tool], { context: toolContext });
        const capability: OrionSubagentTurnCapabilityV1 = {
          serviceId: `product-subagent-turn-v1:${input.turnId}`,
          turnId: input.turnId,
          catalog,
          publishCommitted: (stepBundle, commit) => {
            parentForkSource.publishCommitted(stepBundle, commit);
          },
          close: (reason?: string) => bundle.close(reason),
        };
        return Object.freeze(capability);
      } catch (error) {
        productionRuntime?.close('subagent_turn_start_failed');
        parentForkSource.close('subagent_turn_start_failed');
        throw error;
      }
    },
  });
}

function createProductSubagentRolePolicies(
  options: ProductOrionRuntimeOptionsV1,
  config: SubagentConfig
): Readonly<Partial<Record<SubagentRole, AuthoritySnapshotV1>>> {
  const entries = config.roles.map(
    role =>
      [
        role,
        createAuthoritySnapshotV1({
          authorityId: `subagent-role:${role}:${digestRuntimeValue(options.cwd).slice(0, 16)}`,
          projectRoot: options.cwd,
          confirmation: 'allow',
          filesystem: 'workspace',
          network: 'deny',
        }),
      ] as const
  );
  return Object.freeze(Object.fromEntries(entries));
}

function createProductChildModelExecutor(
  options: ProductOrionRuntimeOptionsV1,
  rootConfig: Parameters<typeof createChildLlmConfig>[0],
  providerProtocol: LLMConfig['providerProtocol'] | undefined
): LLMService {
  const executor = new LLMService({
    ...createChildLlmConfig(rootConfig),
    providerProtocol,
    reasoningCapability: options.config.modelRegistry?.defaultProfile?.reasoningCapability,
    fallbackReasoningCapability: options.config.modelRegistry?.fallbackProfile?.reasoningCapability,
    effortPreference: options.config.defaultEffort,
  });
  executor.resilience = options.llm.resilience;
  return executor;
}

function capabilityConfiguration(input: {
  readonly options: ProductOrionRuntimeOptionsV1;
  readonly input: Parameters<
    Parameters<typeof createOrionRuntimeV1>[0]['resolveCapabilityConfiguration']
  >[0];
  readonly modelId: string;
  readonly contextWindow: number;
  readonly providerId: string;
  readonly protocol: string;
  readonly executionPolicy: ReturnType<typeof createExecutionPolicySnapshotV1>;
  readonly skillCatalog: Awaited<ReturnType<import('./skills').LazySkillRuntime['observe']>>;
  readonly loadedSkills: readonly LoadedSkillDefinitionV1[];
  readonly explicitSkillIds: readonly string[];
  readonly promptReceipt: PromptAssemblyReceiptV1;
  readonly dynamicTools: OrionCapabilityStepConfigurationV1['dynamicTools'];
}): OrionCapabilityStepConfigurationV1 {
  const authority = createProductAuthority(input.options, input.input.mode);
  const loadedSkillIds = new Set(input.loadedSkills.map(skill => skill.definition.id));
  return {
    taskEpoch: 1,
    model: {
      providerId: input.providerId,
      modelId: input.modelId,
      protocol: input.protocol,
      contextWindow: input.contextWindow,
    },
    executionPolicy: input.executionPolicy,
    environment: {
      cwd: input.options.cwd,
      platform: process.platform,
      arch: process.arch,
      environmentDigest: digestRuntimeValue({
        cwd: input.options.cwd,
        platform: process.platform,
        arch: process.arch,
      }),
    },
    compiler: {
      task: {
        objective: input.input.input,
        ...(input.explicitSkillIds.length > 0 ? { explicitSkillIds: input.explicitSkillIds } : {}),
        ...(input.dynamicTools?.candidates.length
          ? {
              explicitMcpToolIds: input.dynamicTools.candidates.map(
                candidate => candidate.descriptor.name
              ),
            }
          : {}),
      },
      model: { toolCalling: true },
      authority,
      budgets: {
        maxDirectTools: 12,
        maxToolSchemaBytes: 16_384,
        maxDeferredTools: 32,
        maxExpansionTools: 4,
      },
      skills: input.skillCatalog.descriptors.map(skill => ({
        id: skill.id,
        digest: skill.digest,
        description: skill.description,
        keywords: [skill.name],
        requestedCapabilities: skill.requestedCapabilities,
        loaded: loadedSkillIds.has(skill.id),
      })),
      executionPolicyDigest: input.executionPolicy.digest,
      skillCatalogDigest: input.skillCatalog.digest,
      promptManifest: input.promptReceipt.sections.map(section => ({
        id: section.id,
        digest: section.contentDigest,
        selected: section.selected,
        reason: section.reason,
      })),
      estimatedInputTokens: estimateTokens(input.input.input),
    },
    ...(input.dynamicTools ? { dynamicTools: input.dynamicTools } : {}),
  };
}

function loadProductGoalSeed(
  projectPath: string,
  sessionId: string
): GoalRuntimeDefinitionV2 | undefined {
  const loaded = loadGoal(projectPath, sessionId);
  if (!loaded.ok) {
    if (loaded.error === 'not_found') return undefined;
    throw new Error(`Cannot start Goal runtime: ${loaded.message}`);
  }
  const legacy = loaded.value;
  const status: GoalLifecycleStateV2['status'] =
    legacy.status === 'active' ? 'active' : legacy.status === 'complete' ? 'completed' : 'paused';
  const budget = {
    maxTokens: legacy.tokenBudget ?? Number.MAX_SAFE_INTEGER,
    maxElapsedMs: Number.MAX_SAFE_INTEGER,
  };
  const content = {
    version: 2 as const,
    goalId: legacy.goalId,
    objective: legacy.objective,
    status,
    generation: Math.max(1, legacy.revision + 1),
    continuationCount: legacy.continuationCount,
    noProgressCount: legacy.noProgressCount,
    blockedCount: legacy.blocker?.consecutiveTurns ?? 0,
    tokensUsed: legacy.tokensUsed,
    elapsedMs: legacy.timeUsedMs,
    budget,
    createdAt: legacy.createdAt,
    updatedAt: Math.max(legacy.createdAt, legacy.updatedAt),
  };
  const state: GoalLifecycleStateV2 = Object.freeze({
    ...content,
    digest: digestRuntimeValue(content),
  });
  return Object.freeze({
    goalId: state.goalId,
    objective: state.objective,
    budget: state.budget,
    state,
  });
}

function buildGoalRuntimeContext(state: GoalLifecycleStateV2 | undefined): string | undefined {
  if (!state) return undefined;
  return [
    'Durable Goal lifecycle (v2):',
    `- Goal ID: ${state.goalId}`,
    `- Objective: ${state.objective}`,
    `- Status: ${state.status}`,
    `- Generation: ${state.generation}`,
    `- Continuations: ${state.continuationCount}`,
    `- Tokens: ${state.tokensUsed}/${state.budget.maxTokens}`,
    `- Elapsed ms: ${state.elapsedMs}/${state.budget.maxElapsedMs}`,
    state.status === 'active'
      ? '- Continue autonomously; only TaskContext may verify completion.'
      : '- Do not autonomously continue this Goal unless the user explicitly resumes it.',
  ].join('\n');
}

async function buildProductMessages(
  options: ProductOrionRuntimeOptionsV1,
  sessionId: string,
  eventStore: Parameters<
    NonNullable<Parameters<typeof createOrionRuntimeV1>[0]['loadBaseMessages']>
  >[0],
  prompts: PromptRegistryV1,
  composition: OrionPromptCompositionContextV1,
  input: string,
  mode: 'build' | 'plan' | 'auto' | 'goal' | 'maintenance',
  contextWindow: number
): Promise<{
  readonly messages: readonly Message[];
  readonly receipt: PromptAssemblyReceiptV1;
  readonly skillCatalog: SkillCatalogV1;
  readonly loadedSkills: readonly LoadedSkillDefinitionV1[];
  readonly explicitSkillIds: readonly string[];
}> {
  const durable = latestDurableHistory(eventStore);
  const history = durable ?? legacyHistory(sessionId);
  const withoutOldSystem = history.filter(message => message.role !== 'system');
  const snapshot = options.store.getSnapshot();
  const goalContent = buildGoalRuntimeContext(composition.goal.state);
  const planReceipt = mode === 'plan' ? undefined : latestDurablePlanReceipt(eventStore);
  const memory = buildMemoryPromptContext(input, options.cwd).content;
  const skillCatalog = await composition.skills.observe(
    { id: `project:${digestRuntimeValue(options.cwd)}` },
    undefined
  );
  const skillSelection = await loadSelectedSkills(
    input,
    skillCatalog,
    composition,
    createProductAuthority(options, mode)
  );
  const basePrompt = buildSystemPrompt({
    cwd: options.cwd,
    platform: process.platform,
    nodeVersion: process.version,
    tools: options.toolCatalog.entries
      .filter(entry => entry.candidate.tier === 'core')
      .map(entry => entry.tool),
    planMode: mode === 'plan',
    agentMode:
      mode === 'goal'
        ? snapshot.agentMode
        : mode === 'build'
          ? 'interactive'
          : mode === 'maintenance'
            ? snapshot.agentMode
            : mode,
  });
  const referencedFiles = buildReferencedFilesPrompt(input, options.cwd);
  const sections = productPromptSections({
    basePrompt,
    memory,
    projectInstructions: snapshot.projectInstructionsContent,
    referencedFiles,
    goal: goalContent,
    plan: planReceipt,
    skills: skillSelection.loaded,
  });
  const assembly = prompts.assemble({
    hardTokenBudget: Math.min(32_000, Math.max(8_000, Math.floor(contextWindow * 0.25))),
    contributors: sections,
  });
  const cacheable = assembly.sections
    .filter(section => section.cacheablePrefix)
    .map(section => section.content)
    .join('\n\n');
  const dynamic = assembly.sections
    .filter(section => !section.cacheablePrefix)
    .map(section => section.content)
    .join('\n\n');
  return {
    messages: [
      ...(cacheable
        ? [
            {
              role: 'system' as const,
              content: cacheable,
              cacheControl: { type: 'ephemeral' as const },
            },
          ]
        : []),
      ...(dynamic ? [{ role: 'system' as const, content: dynamic }] : []),
      ...withoutOldSystem,
    ],
    receipt: assembly.receipt,
    skillCatalog,
    loadedSkills: skillSelection.loaded,
    explicitSkillIds: skillSelection.explicitSkillIds,
  };
}

function productPromptSections(input: {
  readonly basePrompt: { readonly static: string; readonly dynamic: string };
  readonly memory: string;
  readonly projectInstructions: string;
  readonly referencedFiles: string;
  readonly goal?: string;
  readonly plan?: PlanReceiptV1;
  readonly skills: readonly LoadedSkillDefinitionV1[];
}): Parameters<PromptRegistryV1['assemble']>[0]['contributors'] {
  const section = (
    value: Omit<PromptSectionInputV1, 'source'> & { readonly sourceId: string }
  ): PromptSectionInputV1 => ({
    ...value,
    source: { id: value.sourceId, digest: digestPromptSource(value.content) },
  });
  return {
    taskContext: [
      section({
        id: 'core.instructions',
        sourceId: 'orion.core.v020',
        authority: 'system',
        priority: 1_000,
        tokenBudget: 12_000,
        mandatory: true,
        atomic: true,
        dynamic: false,
        cacheability: 'cacheable',
        redaction: 'none',
        content: input.basePrompt.static,
      }),
    ],
    project: [
      section({
        id: 'project.instructions',
        sourceId: 'project.instructions',
        authority: 'project',
        priority: 900,
        tokenBudget: 8_000,
        mandatory: false,
        atomic: true,
        dynamic: false,
        cacheability: 'cacheable',
        redaction: 'secrets',
        content: input.projectInstructions,
        enabled: Boolean(input.projectInstructions.trim()),
        omissionReason: input.projectInstructions.trim() ? undefined : 'source_unavailable',
      }),
      section({
        id: 'project.referenced-files',
        sourceId: 'turn.referenced-files',
        authority: 'user',
        priority: 850,
        tokenBudget: 8_000,
        mandatory: false,
        atomic: true,
        dynamic: true,
        cacheability: 'non_cacheable',
        redaction: 'secrets',
        content: input.referencedFiles,
        enabled: Boolean(input.referencedFiles.trim()),
        omissionReason: input.referencedFiles.trim() ? undefined : 'not_applicable',
      }),
    ],
    memory: [
      section({
        id: 'memory.relevant',
        sourceId: 'project.memory',
        authority: 'session',
        priority: 800,
        tokenBudget: 6_000,
        mandatory: false,
        atomic: true,
        dynamic: true,
        cacheability: 'non_cacheable',
        redaction: 'secrets',
        content: input.memory ? `Project memory:\n${input.memory}` : '',
        enabled: Boolean(input.memory.trim()),
        omissionReason: input.memory.trim() ? undefined : 'source_unavailable',
      }),
    ],
    skill: input.skills.map((skill, index) =>
      section({
        id: `skill.selected-${index + 1}`,
        sourceId: `skill.${skill.definition.digest.slice(0, 24)}`,
        authority: skill.receipt.actor === 'user' ? 'user' : 'system',
        priority: 920 - index,
        tokenBudget: 16_000,
        mandatory: false,
        atomic: true,
        dynamic: true,
        cacheability: 'non_cacheable',
        redaction: 'secrets',
        content: [
          `Selected Skill: ${skill.definition.name}`,
          `Granted capabilities: ${skill.receipt.grantedCapabilities.join(', ') || 'none'}`,
          skill.definition.body,
        ].join('\n\n'),
      })
    ),
    goal: [
      section({
        id: 'goal.active',
        sourceId: 'goal.active',
        authority: 'session',
        priority: 950,
        tokenBudget: 8_000,
        mandatory: false,
        atomic: true,
        dynamic: true,
        cacheability: 'non_cacheable',
        redaction: 'secrets',
        content: input.goal ?? '',
        enabled: Boolean(input.goal?.trim()),
        omissionReason: input.goal?.trim() ? undefined : 'not_applicable',
      }),
    ],
    mode: [
      section({
        id: 'runtime.saved-plan',
        sourceId: input.plan ? `plan.${input.plan.digest.slice(0, 24)}` : 'plan.none',
        authority: 'runtime',
        priority: 1_010,
        tokenBudget: 16_000,
        mandatory: false,
        atomic: true,
        dynamic: true,
        cacheability: 'non_cacheable',
        redaction: 'secrets',
        content: input.plan
          ? [
              '[Durable PlanReceipt V1]',
              `Receipt: ${input.plan.digest}`,
              `Planning turn: ${input.plan.turnId}`,
              `Execution mode: ${input.plan.returnMode.toUpperCase()}`,
              'Execute this saved plan now; do not return to planning unless new evidence invalidates it.',
              '',
              input.plan.plan,
            ].join('\n')
          : '',
        enabled: Boolean(input.plan),
        omissionReason: input.plan ? undefined : 'not_applicable',
      }),
      section({
        id: 'runtime.environment-mode',
        sourceId: 'runtime.environment-mode',
        authority: 'runtime',
        priority: 1_000,
        tokenBudget: 4_000,
        mandatory: true,
        atomic: true,
        dynamic: true,
        cacheability: 'non_cacheable',
        redaction: 'secrets',
        content: input.basePrompt.dynamic,
      }),
    ],
  };
}

function latestDurableHistory(
  store: Parameters<NonNullable<Parameters<typeof createOrionRuntimeV1>[0]['loadBaseMessages']>>[0]
): Message[] | undefined {
  const commits = Object.values(store.loadProjection().turns)
    .map(turn => turn.commit)
    .filter((commit): commit is NonNullable<typeof commit> => Boolean(commit))
    .sort((left, right) => left.seq - right.seq);
  const latest = commits.at(-1);
  if (!latest) return undefined;
  const parsed = parseTurnCommitV1(latest.receipt);
  const history = JSON.parse(parsed.history) as unknown;
  if (!Array.isArray(history) || !history.every(isMessage)) {
    throw new Error('Durable TurnCommit contains an invalid model history.');
  }
  return history.map(message => ({ ...message }));
}

function projectRestoredTurnCommit(store: Store, commit: TurnCommitV1): void {
  const history = JSON.parse(commit.history) as unknown;
  const harnessState = JSON.parse(commit.taskContext) as unknown;
  if (!Array.isArray(history) || !history.every(isMessage)) {
    throw new Error('Durable TurnCommit contains an invalid model history.');
  }
  if (!harnessState || typeof harnessState !== 'object' || Array.isArray(harnessState)) {
    throw new Error('Durable TurnCommit contains an invalid TaskContext state.');
  }
  if (digestRuntimeValue(harnessState) !== commit.taskContextDigest) {
    throw new Error('Durable TurnCommit TaskContext digest does not match its state.');
  }
  store.setState({
    conversationHistory: history.map(message => ({ ...message })),
    harnessState: structuredClone(harnessState) as HarnessState,
  });
}

function latestDurablePlanReceipt(
  store: Parameters<NonNullable<Parameters<typeof createOrionRuntimeV1>[0]['loadBaseMessages']>>[0]
): PlanReceiptV1 | undefined {
  const latest = Object.values(store.loadProjection().turns)
    .map(turn => turn.commit)
    .filter((commit): commit is NonNullable<typeof commit> => Boolean(commit))
    .sort((left, right) => left.seq - right.seq)
    .at(-1);
  if (!latest) return undefined;
  return planReceiptFromCommit(parseTurnCommitV1(latest.receipt));
}

function planReceiptFromCommit(commit: TurnCommitV1): PlanReceiptV1 | undefined {
  if (!commit.planReceipt) return undefined;
  const receipt = parsePlanReceiptV1(commit.planReceipt);
  if (commit.planReceiptDigest !== receipt.digest) {
    throw new Error('Durable PlanReceipt digest differs from its TurnCommit binding.');
  }
  return receipt;
}

function extractDecisionCompletePlan(commit: AgentLoopTurnCommitV1): string {
  const plan = commit.queryComplete.content.trim();
  if (!plan) throw new Error('PLAN finished without a decision-complete plan body.');
  const persistedInHistory = [...commit.history]
    .reverse()
    .some(message => message.role === 'assistant' && message.content.trim() === plan);
  if (!persistedInHistory) {
    throw new Error('PLAN output is not present in the authoritative model history.');
  }
  return plan;
}

function createPlanStopDecision(
  commit: AgentLoopTurnCommitV1,
  promptReceiptDigest: string
): StopDecision {
  const stats = commit.queryComplete.stats;
  const completion = commit.taskContextCompletion;
  const tokenCount =
    (commit.queryComplete.usage?.promptTokens ?? 0) +
    (commit.queryComplete.usage?.completionTokens ?? 0);
  return createStopDecision({
    scope: 'request',
    status: 'completed',
    disposition: 'finish_scope',
    reason: {
      code: 'plan_ready',
      message: 'The planning phase produced a durable decision-complete plan.',
    },
    evidence: [
      {
        kind: 'runtime',
        source: 'task-context',
        detail: `revision=${commit.taskContextRevision};digest=${digestRuntimeValue(commit.taskContextState)}`,
      },
      {
        kind: 'runtime',
        source: 'prompt-registry',
        detail: `receipt=${promptReceiptDigest}`,
      },
    ],
    nextActions: [
      {
        kind: 'continue',
        label: 'Execute the saved plan in the next logical turn.',
      },
    ],
    resources: {
      turns: { used: safeCounter(stats?.turnsStarted) },
      llmRequests: { used: safeCounter(stats?.llmRequests) },
      toolCalls: { used: safeCounter(stats?.toolCalls) },
      tokens: { used: safeCounter(tokenCount) },
    },
    ...(completion?.criterionResults
      ? {
          criterionStates: completion.criterionResults.map(result => ({
            id: result.criterionId,
            status: result.status,
          })),
        }
      : {}),
    ...(completion?.progressDelta
      ? {
          progressDelta: structuredClone(completion.progressDelta) as StopDecision['progressDelta'],
        }
      : {}),
    ...(completion?.stopDecision?.evidenceRefs
      ? { evidenceRefs: [...completion.stopDecision.evidenceRefs] }
      : {}),
    resumable: false,
  });
}

function safeCounter(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? (value as number) : 0;
}

function productPlanReturnMode(store: Store): PlanExecutionModeV1 {
  const snapshot = store.getSnapshot();
  return snapshot.agentMode === 'auto' || snapshot.planReturnMode === 'auto' ? 'auto' : 'build';
}

function projectPlanReceipt(store: Store, receipt: PlanReceiptV1): void {
  const agentMode = receipt.returnMode === 'auto' ? 'auto' : 'interactive';
  store.setState({
    agentMode,
    planMode: false,
    planReturnMode: agentMode,
    currentPlan: receipt.plan,
  });
}

function schedulePlanExecution(
  runtime: OrionRuntimeV1,
  receipt: PlanReceiptV1,
  scheduled: Set<string>
): void {
  if (scheduled.has(receipt.digest)) return;
  const admission = runtime.thread.dispatch({
    type: 'turn.start',
    data: {
      input: [
        `Execute durable PlanReceipt ${receipt.digest}.`,
        'Continue autonomously from the saved plan and verify the implementation before finishing.',
      ].join(' '),
      mode: receipt.returnMode,
    },
  });
  if (admission.status === 'rejected') {
    throw new Error(`Saved plan execution was not admitted: ${admission.reason}.`);
  }
  if (admission.status !== 'started' && admission.status !== 'queued') {
    throw new Error(`Saved plan execution returned unexpected admission: ${admission.status}.`);
  }
  scheduled.add(receipt.digest);
}

function legacyHistory(sessionId: string): Message[] {
  return normalizeSessionModelHistoryV1(
    readSessionMessages(sessionId).map(message => ({
      role: message.role,
      content: message.modelVisibleContent ?? message.content,
      ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      ...(message.tool_calls ? { tool_calls: structuredClone(message.tool_calls) } : {}),
    })),
    'legacy'
  ).messages.map(message => ({ ...message }));
}

function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<Message>;
  return (
    ['system', 'user', 'assistant', 'tool'].includes(message.role ?? '') &&
    typeof message.content === 'string'
  );
}

function createProductAuthority(
  options: ProductOrionRuntimeOptionsV1,
  mode?: AgentLoopStepPrepareInputV1['mode']
): AuthoritySnapshotV1 {
  // AUTO is an explicit full-action consent mode. It bypasses interactive
  // approval only; capability, containment, hard policy and sandbox checks
  // remain unchanged and still precede execution.
  const confirmation = mode === 'auto' ? 'allow' : options.config.toolConfirmation;
  return createAuthoritySnapshotV1({
    authorityId: `project:${digestRuntimeValue(options.cwd).slice(0, 16)}:${mode ?? 'base'}`,
    projectRoot: options.cwd,
    confirmation,
    filesystem: 'workspace',
    network: confirmation === 'deny' ? 'deny' : 'write',
  });
}

async function loadSelectedSkills(
  input: string,
  catalog: SkillCatalogV1,
  composition: OrionPromptCompositionContextV1,
  authority: AuthoritySnapshotV1
): Promise<{
  readonly loaded: readonly LoadedSkillDefinitionV1[];
  readonly explicitSkillIds: readonly string[];
}> {
  const explicit = parseExplicitSkillSelector(input);
  const selected = selectSkillDescriptors(input, catalog.descriptors, explicit);
  const allowedCapabilities = skillAuthorityCapabilities(authority);
  const skillAuthority: SkillAuthorityV1 = Object.freeze({
    authorityId: authority.authorityId,
    digest: digestRuntimeValue({
      authorityDigest: authority.digest,
      allowedCapabilities,
    }),
    allowedCapabilities,
    deniedCapabilityReasons:
      authority.network === 'deny'
        ? Object.freeze({ network: 'Project Authority denies network access.' })
        : undefined,
  });
  const loaded: LoadedSkillDefinitionV1[] = [];
  for (const descriptor of selected.slice(0, 3)) {
    loaded.push(
      await composition.skills.getDefinition({
        catalog,
        skillId: descriptor.id,
        actor: explicit ? 'user' : 'model',
        reason: explicit ? `Explicit Skill selection: ${explicit}` : 'Matched current task intent.',
        authority: skillAuthority,
      })
    );
  }
  const explicitSkillIds = explicit
    ? [
        catalog.descriptors.find(
          descriptor =>
            normalizeLookup(descriptor.id) === normalizeLookup(explicit) ||
            normalizeLookup(descriptor.name) === normalizeLookup(explicit)
        )?.id ?? explicit,
      ]
    : loaded.map(skill => skill.definition.id);
  return Object.freeze({ loaded: Object.freeze(loaded), explicitSkillIds });
}

function parseExplicitSkillSelector(input: string): string | undefined {
  const command = input.trim().match(/^\/(?:skill|use-skill|activate-skill)\s+([^\s]+)/iu);
  const dollar = input.trim().match(/^\$([A-Za-z\p{L}][\w\p{L}-]*)\b/u);
  const value = command?.[1] ?? dollar?.[1];
  if (!value) return undefined;
  return value.replace(/^[$@#]+/u, '').trim();
}

function selectSkillDescriptors(
  input: string,
  descriptors: readonly SkillDescriptorV1[],
  explicit?: string
): readonly SkillDescriptorV1[] {
  if (explicit) {
    const key = normalizeLookup(explicit);
    return descriptors.filter(
      descriptor =>
        normalizeLookup(descriptor.id) === key || normalizeLookup(descriptor.name) === key
    );
  }
  const task = normalizeLookup(input);
  return descriptors.filter(
    descriptor =>
      descriptor.modelInvocable &&
      normalizeLookup(descriptor.name).length >= 3 &&
      task.includes(normalizeLookup(descriptor.name))
  );
}

function skillAuthorityCapabilities(authority: AuthoritySnapshotV1): readonly string[] {
  const values = new Set(['read', 'workspace_read', 'read_file', 'list_files', 'glob', 'grep']);
  if (authority.confirmation !== 'deny') {
    for (const value of ['write', 'workspace_write', 'write_file', 'edit_file', 'exec_command']) {
      values.add(value);
    }
  }
  if (authority.network !== 'deny') {
    for (const value of ['network', 'web', 'web_search', 'web_fetch']) values.add(value);
  }
  return Object.freeze([...values].sort());
}

async function resolveMcpToolsForStep(
  input: AgentLoopStepPrepareInputV1,
  runtime: OrionPromptCompositionContextV1['mcp'],
  catalog: McpCatalogSnapshotV1
): Promise<OrionCapabilityStepConfigurationV1['dynamicTools']> {
  const server = selectMcpServer(input.input, catalog);
  if (!server) return undefined;
  const ownerId = input.turnId;
  const existing = runtime
    .bindingSnapshotForOwner(ownerId)
    .servers.some(binding => binding.serverId === server.id);
  if (!existing) {
    await runtime.acquire({
      catalog,
      serverId: server.id,
      ownerId,
      reason: 'explicit',
      signal: input.abortSignal,
    });
  }
  const bindings = chooseMcpBindings(input.input, runtime.toolBindingsForOwner(ownerId));
  const candidates: CapabilityToolCandidateV1[] = [];
  const registry = new Map<string, ToolBindingV1>();
  for (const binding of bindings) {
    const bindingId = `mcp:${binding.descriptor.bindingDigest}`;
    const risk: ToolRiskMetadataV1 = Object.freeze({
      readOnly: false,
      destructive: true,
      fileEdit: false,
      effect: 'external_write',
      network: 'write',
    });
    const descriptor = Object.freeze({
      name: binding.descriptor.qualifiedName,
      aliases: Object.freeze([] as string[]),
      description: binding.descriptor.description,
      inputSchema: binding.descriptor.inputSchema,
      schemaDigest: binding.descriptor.schemaDigest,
      executorId: bindingId,
      risk,
    });
    candidates.push(
      Object.freeze({
        bindingId,
        descriptor,
        tier: 'long_tail' as const,
        source: 'mcp' as const,
        keywords: Object.freeze([
          binding.descriptor.serverId,
          binding.descriptor.name,
          binding.descriptor.qualifiedName,
        ]),
        mcp: Object.freeze({
          serverId: binding.descriptor.serverId,
          bindingDigest: binding.descriptor.bindingDigest,
        }),
      })
    );
    registry.set(
      bindingId,
      Object.freeze({
        descriptor,
        execute: async (
          args: Record<string, unknown>,
          context: import('../framework/tool').ToolContext
        ) => {
          try {
            const result = await binding.invoke(args, context.abortSignal);
            return { success: true, output: renderMcpResult(result) };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, output: '', error: message };
          }
        },
      })
    );
  }
  return candidates.length === 0
    ? undefined
    : Object.freeze({ candidates: Object.freeze(candidates), bindings: registry });
}

function selectMcpServer(input: string, catalog: McpCatalogSnapshotV1) {
  const task = normalizeLookup(input);
  const explicit = input.trim().match(/^\/mcp\s+([^\s]+)/iu)?.[1];
  const explicitKey = explicit ? normalizeLookup(explicit) : undefined;
  return catalog.descriptors.find(descriptor => {
    if (descriptor.disabled) return false;
    const identities = [descriptor.id, descriptor.name, ...descriptor.tags]
      .map(normalizeLookup)
      .filter(value => value.length >= 2);
    return explicitKey
      ? identities.includes(explicitKey)
      : identities.some(identity => task.includes(identity));
  });
}

function chooseMcpBindings(
  input: string,
  bindings: readonly McpRuntimeToolBindingV1[]
): readonly McpRuntimeToolBindingV1[] {
  const task = normalizeLookup(input);
  const ranked = [...bindings].sort((left, right) => {
    const leftRelevant = task.includes(normalizeLookup(left.descriptor.name)) ? 1 : 0;
    const rightRelevant = task.includes(normalizeLookup(right.descriptor.name)) ? 1 : 0;
    return (
      rightRelevant - leftRelevant ||
      left.descriptor.qualifiedName.localeCompare(right.descriptor.qualifiedName)
    );
  });
  const relevant = ranked.filter(binding =>
    task.includes(normalizeLookup(binding.descriptor.name))
  );
  return Object.freeze((relevant.length > 0 ? relevant : ranked).slice(0, 4));
}

function normalizeLookup(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function renderMcpResult(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const INERT_MCP_CONNECTOR: McpConnectorV1 = Object.freeze({
  connect: async (): Promise<McpConnectionV1> => {
    throw new Error('No MCP connector is configured for this OrionRuntime.');
  },
});
