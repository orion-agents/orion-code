import { resolve } from 'path';

import type { ToolContext } from '../framework/tool';
import type { StopDecision } from '../framework/stop-decision';
import type { HarnessState } from '../harness/types';
import type { LLMService, Message, StreamCallbacks } from '../services/llm';
import { AgentLoopV1, type AgentLoopTurnCommitV1 } from './agent-loop';
import type { BuiltinToolCatalogV1 } from './builtin-tool-provider';
import { BatchReadExecutionServiceV1 } from './batch-read-service';
import type { CapabilityReceiptV1, CapabilityToolCandidateV1 } from './capabilities';
import {
  CapabilityReceiptJournalV1,
  type CapabilityReceiptJournalCommitV1,
} from './capability-receipt-journal';
import type { CompactPrepareSourceReceiptV1, CompactRecoveryReportV1 } from './compact-transaction';
import {
  CapabilityAgentLoopStepFactoryV1,
  type AgentLoopStepPrepareInputV1,
  type CapabilityStepCompilerInputV1,
  type CapabilityStepConfigurationV1,
  type CapabilityStepPersistenceBundleV1,
} from './capability-step-factory';
import {
  FirstPartySandboxServiceV1,
  FirstPartyToolApprovalServiceV1,
  FirstPartyToolPolicyServiceV1,
  type FirstPartyApprovalHandlerV1,
} from './first-party-tool-services';
import {
  GoalRuntimeCoordinatorV2,
  type GoalRuntimeControlResultV2,
  type GoalRuntimeControlV2,
  type GoalRuntimeDefinitionV2,
} from './goal-runtime-coordinator';
import {
  LazyMcpRuntime,
  type LazyMcpRuntimeOptions,
  type LazyMcpRuntimeSnapshotV1,
  type McpCatalogSnapshotV1,
} from './mcp';
import { PromptRegistryV1 } from './prompts';
import { canonicalRuntimeJson, digestRuntimeValue } from './protocol/canonical';
import type { RuntimeEventEnvelopeV1 } from './protocol/runtime-protocol-v1';
import { CURRENT_TOOL_SCHEMA_BASELINE_V1 } from './harness-metrics';
import { ResourceScope, type ResourceScopeCloseReport } from './resource-scope';
import {
  createRuntimeContributors,
  createRuntimeServices,
  emptyRuntimeContributorSlots,
  type RuntimeContributorSlots,
  type RuntimeContributors,
  type RuntimeServicePort,
  type RuntimeServices,
  type RuntimeServiceSlots,
} from './runtime-services';
import {
  LazySkillRuntime,
  type LazySkillRuntimeOptions,
  type LazySkillRuntimeStatsV1,
} from './skills';
import { ExecutionService, type AuthoritySnapshotV1, type ToolBindingV1 } from './step-snapshot';
import {
  createThreadCompactCandidateDraftV1,
  ThreadCompactMaintenanceRunnerV1,
  ThreadCompactTransactionPersistenceV1,
  type ThreadCompactMaintenanceRunnerOptionsV1,
} from './thread-compact-persistence';
import {
  createTaskContextService,
  type TaskContextService,
  type TaskContextServiceOptions,
} from './task-context-service';
import { ThreadEventStore, type ThreadEventStoreOptionsV1 } from './thread-event-store';
import {
  ThreadRuntimeV1,
  type ThreadCompactMaintenanceRequestV1,
  type ThreadRuntimeOptionsV1,
  type ThreadTurnExecutionContextV1,
} from './thread-runtime';
import type { ThreadCommandAdmissionV1 } from './thread-admission';
import { ThreadToolInvocationJournalV1 } from './thread-tool-journal';
import { ToolGateway, type ToolPolicyServiceV1 } from './tool-gateway';
import {
  parseTurnCommitV1,
  ThreadTurnCommitJournalV1,
  type PlanTurnCommitInputV1,
  type TurnCommitV1,
  type TurnCommitTerminalV1,
} from './turn-commit';

export type OrionRuntimeStateV1 = 'created' | 'starting' | 'started' | 'closing' | 'closed';

export interface OrionRuntimeEventStoreRootsV1 {
  readonly rootDir: string;
  readonly threadId: string;
  readonly options?: ThreadEventStoreOptionsV1;
}

export type OrionCapabilityStepConfigurationV1 = Omit<CapabilityStepConfigurationV1, 'compiler'> & {
  readonly compiler: Omit<
    CapabilityStepCompilerInputV1,
    'tools' | 'runtimeServicesDigest' | 'mcpCatalogDigest'
  >;
  /** Turn/step-scoped exact bindings, such as a selected MCP lease. */
  readonly dynamicTools?: {
    readonly candidates: readonly CapabilityToolCandidateV1[];
    readonly bindings: ReadonlyMap<string, ToolBindingV1>;
  };
};

export interface OrionCapabilityCompositionContextV1 {
  readonly runtimeServicesDigest: string;
  readonly toolCatalog: BuiltinToolCatalogV1;
  readonly taskContext: TaskContextService;
  readonly skills: LazySkillRuntime;
  readonly mcp: LazyMcpRuntime;
  readonly mcpCatalog: McpCatalogSnapshotV1;
  readonly prompts: PromptRegistryV1;
}

export interface OrionPromptCompositionContextV1 {
  readonly taskContext: TaskContextService;
  readonly goal: GoalRuntimeCoordinatorV2;
  readonly skills: LazySkillRuntime;
  readonly mcp: LazyMcpRuntime;
}

export type OrionCapabilityConfigurationResolverV1 = (
  input: AgentLoopStepPrepareInputV1,
  context: OrionCapabilityCompositionContextV1
) => OrionCapabilityStepConfigurationV1 | Promise<OrionCapabilityStepConfigurationV1>;

export interface OrionSubagentTurnFactoryInputV1 {
  readonly store: ThreadEventStore;
  readonly threadId: string;
  readonly turnId: string;
  readonly input: string;
  readonly mode: AgentLoopStepPrepareInputV1['mode'];
  readonly authority: AuthoritySnapshotV1;
  readonly abortSignal: AbortSignal;
  /** Parent store appends are synchronous+fsynced; custom buffers must flush here. */
  readonly flush: () => void | Promise<void>;
}

export interface OrionSubagentTurnCapabilityV1 extends RuntimeServicePort {
  readonly turnId: string;
  /** Exact one-tool catalog containing the turn-bound `subtask` executor. */
  readonly catalog: BuiltinToolCatalogV1;
  publishCommitted(
    bundle: CapabilityStepPersistenceBundleV1,
    commit: CapabilityReceiptJournalCommitV1
  ): void | Promise<void>;
  close(reason?: string): void | Promise<void>;
}

export interface OrionSubagentCompositionV1 extends RuntimeServicePort {
  createTurn(
    input: OrionSubagentTurnFactoryInputV1
  ): OrionSubagentTurnCapabilityV1 | null | Promise<OrionSubagentTurnCapabilityV1 | null>;
}

export interface OrionRuntimeLoopOptionsV1 {
  readonly streamCallbacks?: StreamCallbacks;
  readonly loopBudget?: ConstructorParameters<typeof AgentLoopV1>[0]['loopBudget'];
  readonly onContextUsage?: ConstructorParameters<typeof AgentLoopV1>[0]['onContextUsage'];
  readonly compactCoordinator?: ConstructorParameters<typeof AgentLoopV1>[0]['compactCoordinator'];
  /**
   * Synchronous pre-commit projection. It may specialize the request
   * StopDecision and attach bounded product receipts, but cannot perform I/O.
   */
  readonly prepareTurnCommit?: (
    commit: Parameters<NonNullable<ConstructorParameters<typeof AgentLoopV1>[0]['commitTurn']>>[0]
  ) => {
    readonly stopDecision?: StopDecision;
    readonly plan?: PlanTurnCommitInputV1;
  };
  /** Projection hook; the exact durable TurnCommit is provided after success. */
  readonly onTurnCommitted?: (
    commit: Parameters<NonNullable<ConstructorParameters<typeof AgentLoopV1>[0]['commitTurn']>>[0],
    durableCommit: TurnCommitV1
  ) => void | Promise<void>;
  /** Restore product projections or missing internal continuations before start() resolves. */
  readonly onRuntimeStarted?: (input: {
    readonly restoredCommit?: TurnCommitV1;
    readonly thread: ThreadRuntimeV1;
    readonly eventStore: ThreadEventStore;
  }) => void | Promise<void>;
}

export interface OrionExplicitCompactInputV1 {
  readonly maxMessages?: number;
  readonly focus?: string;
}

export interface OrionRuntimeV1Options {
  /** The caller owns provider configuration; the runtime owns model invocation routing. */
  readonly modelExecutor: LLMService;
  /** Already-normalized first-party tools. No global TOOLS collection is consulted. */
  readonly toolCatalog: BuiltinToolCatalogV1;
  readonly toolContext: ToolContext;
  readonly eventStore: OrionRuntimeEventStoreRootsV1;
  readonly projectPath: string;
  readonly taskContext: TaskContextServiceOptions;
  readonly goal?: GoalRuntimeDefinitionV2;
  readonly skills: Omit<LazySkillRuntimeOptions, 'signal'>;
  readonly mcp: Omit<LazyMcpRuntimeOptions, 'signal'>;
  readonly resolveCapabilityConfiguration: OrionCapabilityConfigurationResolverV1;
  readonly approvalHandler?: FirstPartyApprovalHandlerV1;
  readonly contributors?: RuntimeContributorSlots;
  readonly subagents?: OrionSubagentCompositionV1;
  readonly thread?: Omit<
    ThreadRuntimeOptionsV1,
    'store' | 'runner' | 'maintenanceRunner' | 'projectPath' | 'requireTurnCommit'
  >;
  readonly compact?: ThreadCompactMaintenanceRunnerOptionsV1;
  readonly loop?: OrionRuntimeLoopOptionsV1;
  readonly loadBaseMessages?: (
    store: ThreadEventStore,
    context: ThreadTurnExecutionContextV1,
    prompts: PromptRegistryV1,
    composition: OrionPromptCompositionContextV1
  ) => readonly Message[] | Promise<readonly Message[]>;
  readonly closeDeadlineMs?: number;
}

export interface OrionRuntimeModelServiceV1 extends RuntimeServicePort {
  readonly executor: LLMService;
}

export interface OrionRuntimeThreadServiceV1 extends RuntimeServicePort {
  readonly runtime: ThreadRuntimeV1;
}

export interface OrionRuntimeExecutionServiceV1 extends RuntimeServicePort {
  readonly execution: ExecutionService;
}

export interface OrionRuntimeToolServiceV1 extends RuntimeServicePort {
  readonly catalog: BuiltinToolCatalogV1;
  readonly gateway: ToolGateway;
  readonly approval: FirstPartyToolApprovalServiceV1;
  readonly sandbox: FirstPartySandboxServiceV1;
  readonly journal: ThreadToolInvocationJournalV1;
}

export interface OrionRuntimePromptServiceV1 extends RuntimeServicePort {
  readonly registry: PromptRegistryV1;
}

export interface OrionRuntimeSkillServiceV1 extends RuntimeServicePort {
  readonly runtime: LazySkillRuntime;
}

export interface OrionRuntimeMcpServiceV1 extends RuntimeServicePort {
  readonly runtime: LazyMcpRuntime;
}

export interface OrionRuntimeGoalServiceV1 extends RuntimeServicePort {
  readonly runtime: GoalRuntimeCoordinatorV2;
}

export interface OrionRuntimeCapabilityServiceV1 extends RuntimeServicePort {
  readonly steps: CapabilityAgentLoopStepFactoryV1;
  readonly journal: CapabilityReceiptJournalV1;
}

export interface OrionRuntimeEventServiceV1 extends RuntimeServicePort {
  readonly store: ThreadEventStore;
  readonly turnCommits: ThreadTurnCommitJournalV1;
}

export interface OrionRuntimeCompactServiceV1 extends RuntimeServicePort {
  readonly persistence: ThreadCompactTransactionPersistenceV1;
  readonly runner: ThreadCompactMaintenanceRunnerV1;
  readonly recovery: CompactRecoveryReportV1;
}

export interface OrionRuntimeServiceSlotsV1 extends RuntimeServiceSlots {
  readonly models: OrionRuntimeModelServiceV1;
  readonly threads: OrionRuntimeThreadServiceV1;
  readonly policy: ToolPolicyServiceV1 & RuntimeServicePort;
  readonly execution: OrionRuntimeExecutionServiceV1;
  readonly tools: OrionRuntimeToolServiceV1;
  readonly prompts: OrionRuntimePromptServiceV1;
  readonly skills: OrionRuntimeSkillServiceV1;
  readonly mcp: OrionRuntimeMcpServiceV1;
  readonly goals: OrionRuntimeGoalServiceV1;
  readonly taskContext: TaskContextService;
  readonly capabilities: OrionRuntimeCapabilityServiceV1;
  readonly events: OrionRuntimeEventServiceV1;
  readonly compaction: OrionRuntimeCompactServiceV1;
  readonly subagents: RuntimeServicePort;
}

export interface OrionRuntimeGraphV1 {
  readonly services: RuntimeServices<OrionRuntimeServiceSlotsV1>;
  readonly contributors: RuntimeContributors;
  readonly scope: ResourceScope;
  readonly eventStore: ThreadEventStore;
  readonly taskContext: TaskContextService;
  readonly prompts: PromptRegistryV1;
  readonly skills: LazySkillRuntime;
  readonly mcp: LazyMcpRuntime;
  readonly goal: GoalRuntimeCoordinatorV2;
  readonly execution: ExecutionService;
  readonly gateway: ToolGateway;
  readonly capabilityJournal: CapabilityReceiptJournalV1;
  readonly compactPersistence: ThreadCompactTransactionPersistenceV1;
  readonly compactRunner: ThreadCompactMaintenanceRunnerV1;
  readonly compactRecovery: CompactRecoveryReportV1;
  readonly stepFactory: CapabilityAgentLoopStepFactoryV1;
  readonly agentLoop: AgentLoopV1;
  readonly thread: ThreadRuntimeV1;
}

export interface OrionRuntimeDiagnosticsV1 {
  readonly version: 1;
  readonly runtime: {
    readonly state: OrionRuntimeStateV1;
    readonly services: readonly { readonly slot: string; readonly serviceId: string }[];
    readonly contributors: readonly {
      readonly lane: string;
      readonly ids: readonly string[];
    }[];
    readonly scope: {
      readonly id: string;
      readonly state: string;
      readonly epoch: number;
      readonly activeResources: number;
      readonly activeLeases: number;
    };
  };
  readonly thread: {
    readonly threadId: string;
    readonly status: string;
    readonly cursor: number;
    readonly projectionDigest: string;
    readonly projectionLag: number;
    readonly activeTurnId?: string;
    readonly activeItemIds: readonly string[];
    readonly queuedTurns: number;
    readonly queuedBytes: number;
    readonly interruptRequested: boolean;
  };
  readonly taskContext: {
    readonly revision: number;
    readonly taskEpoch: number;
    readonly stateDigest: string;
    readonly criteria: number;
    readonly evidenceRefs: readonly string[];
  };
  readonly capability?: {
    readonly requestId: string;
    readonly stepId: string;
    readonly direct: readonly string[];
    readonly deferred: readonly string[];
    readonly hidden: Readonly<Record<string, string>>;
    readonly omitted: readonly { readonly id: string; readonly reason: string }[];
    readonly schemaBytes: number;
    readonly fullSchemaBytes: number;
    readonly schemaReductionPercent: number;
    readonly stepSnapshotDigest: string;
    readonly toolRouterDigest: string;
    readonly authorityDigest: string;
    readonly executionPolicyDigest: string;
    readonly skillCatalogDigest: string;
    readonly selectedSkillIds: readonly string[];
    readonly mcpCatalogDigest: string;
    readonly selectedMcpBindings: readonly string[];
    readonly promptSections: readonly {
      readonly id: string;
      readonly digest: string;
      readonly selected: boolean;
      readonly reason?: string;
    }[];
    readonly receiptDigest: string;
  };
  readonly skills: LazySkillRuntimeStatsV1;
  readonly mcp: LazyMcpRuntimeSnapshotV1;
  readonly latest: {
    readonly stopDecision?: unknown;
    readonly compactEvent?: string;
    readonly compactRecoveryDigest: string;
    readonly eventCursor: number;
  };
}

type OrionRuntimeErrorCode =
  | 'ORION_RUNTIME_INVALID_CONFIGURATION'
  | 'ORION_RUNTIME_OWNER_CONFLICT'
  | 'ORION_RUNTIME_NOT_STARTED'
  | 'ORION_RUNTIME_CLOSED';

export class OrionRuntimeV1Error extends Error {
  constructor(
    readonly code: OrionRuntimeErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'OrionRuntimeV1Error';
  }
}

const SERVICE_IDS = Object.freeze({
  models: 'model-executor-v1',
  threads: 'thread-runtime-v1',
  policy: 'turn-routed-first-party-tool-policy-v1',
  execution: 'execution-service-v1',
  tools: 'tool-gateway-v1',
  prompts: 'prompt-registry-v1',
  skills: 'lazy-skill-runtime-v1',
  mcp: 'lazy-mcp-runtime-v1',
  goals: 'goal-runtime-v2',
  taskContext: 'task-context',
  capabilities: 'capability-step-factory-v1',
  events: 'thread-event-store-v1',
  compaction: 'compact-transaction-v1',
} as const);

/** Process-local guard; it is an ownership check, never a service lookup path. */
const ACTIVE_RUNTIME_OWNERS = new Map<string, OrionRuntimeV1>();

/**
 * Explicit first-party production composition root for exactly one ThreadRuntime.
 * Construction is side-effect free; start() owns resources and close() releases them.
 */
export class OrionRuntimeV1 {
  readonly scope: ResourceScope;

  private readonly ownerKey: string;
  private readonly options: OrionRuntimeV1Options;
  private stateValue: OrionRuntimeStateV1 = 'created';
  private graphValue?: OrionRuntimeGraphV1;
  private startFlight?: Promise<this>;
  private closeFlight?: Promise<ResourceScopeCloseReport>;
  private closeRequested = false;

  constructor(options: OrionRuntimeV1Options) {
    this.options = validateOptions(options);
    this.ownerKey = ownerKey(this.options.eventStore);
    this.scope = new ResourceScope({ deadlineMs: options.closeDeadlineMs });
  }

  get state(): OrionRuntimeStateV1 {
    return this.stateValue;
  }

  get graph(): OrionRuntimeGraphV1 {
    return this.requireGraph();
  }

  get services(): RuntimeServices<OrionRuntimeServiceSlotsV1> {
    return this.requireGraph().services;
  }

  get contributors(): RuntimeContributors {
    return this.requireGraph().contributors;
  }

  get thread(): ThreadRuntimeV1 {
    return this.requireGraph().thread;
  }

  /** Safe control-plane projection. It never loads Skill bodies or connects MCP servers. */
  diagnostics(): OrionRuntimeDiagnosticsV1 {
    const graph = this.requireGraph();
    const projection = graph.thread.getProjection();
    const admission = graph.thread.getAdmissionSnapshot();
    const eventCursor = graph.eventStore.getCursor();
    const recent = graph.eventStore.replay(Math.max(0, eventCursor - 256), 256).events;
    const latestCapabilityEvent = [...recent]
      .reverse()
      .find(event => event.payload.type === 'capability.receipt');
    const latestSnapshotEvent = [...recent]
      .reverse()
      .find(event => event.payload.type === 'step.snapshot');
    const latestCommitEvent = [...recent]
      .reverse()
      .find(event => event.payload.type === 'turn.committed');
    const latestCompactEvent = [...recent]
      .reverse()
      .find(event => event.payload.type.startsWith('compact.'));
    const capability = parseCapabilityDiagnostics(latestCapabilityEvent, latestSnapshotEvent);
    const latestCommit =
      latestCommitEvent?.payload.type === 'turn.committed'
        ? parseTurnCommitV1(latestCommitEvent.payload.data.receipt)
        : undefined;
    const task = graph.taskContext.snapshot();
    const activeTurn = projection.activeTurnId
      ? projection.turns[projection.activeTurnId]
      : undefined;
    const serviceEntries = Object.entries(graph.services)
      .map(([slot, service]) => ({ slot, serviceId: service.serviceId }))
      .sort((left, right) => (left.slot < right.slot ? -1 : left.slot > right.slot ? 1 : 0));
    const contributorEntries = Object.entries(graph.contributors).map(([lane, contributors]) => ({
      lane,
      ids: contributors.map(contributor => contributor.id),
    }));
    const criteria = task.state.contract?.criteria ?? [];
    const evidenceRefs = (task.state.evidenceIndex ?? [])
      .slice(-20)
      .map(item => `${item.id}:${item.kind}:${item.verificationStatus ?? 'unknown'}`);

    return Object.freeze({
      version: 1 as const,
      runtime: {
        state: this.stateValue,
        services: serviceEntries,
        contributors: contributorEntries,
        scope: {
          id: graph.scope.id,
          state: graph.scope.state,
          epoch: graph.scope.epoch,
          activeResources: graph.scope.activeResourceCount,
          activeLeases: graph.scope.activeLeaseCount,
        },
      },
      thread: {
        threadId: projection.threadId,
        status: projection.status,
        cursor: projection.cursor,
        projectionDigest: projection.digest,
        projectionLag: Math.max(0, eventCursor - projection.cursor),
        ...(projection.activeTurnId ? { activeTurnId: projection.activeTurnId } : {}),
        activeItemIds: activeTurn
          ? activeTurn.itemIds.filter(itemId => projection.items[itemId]?.status === 'started')
          : [],
        queuedTurns: admission.queue.length,
        queuedBytes: admission.queuedBytes,
        interruptRequested: Boolean(admission.activeTurn?.interruptIntentId),
      },
      taskContext: {
        revision: task.revision,
        taskEpoch: task.taskEpoch,
        stateDigest: digestRuntimeValue(task.state),
        criteria: criteria.length,
        evidenceRefs,
      },
      ...(capability ? { capability } : {}),
      skills: graph.skills.stats(),
      mcp: graph.mcp.snapshot(),
      latest: {
        ...(latestCommit?.stopDecision
          ? { stopDecision: JSON.parse(latestCommit.stopDecision) as unknown }
          : {}),
        ...(latestCompactEvent ? { compactEvent: latestCompactEvent.payload.type } : {}),
        compactRecoveryDigest: graph.compactRecovery.digest,
        eventCursor,
      },
    });
  }

  /**
   * Apply Goal lifecycle control through an internal durable Thread turn.
   * Status is a pure snapshot; every mutation receives its own TurnCommit.
   */
  async controlGoal(control: GoalRuntimeControlV2): Promise<GoalRuntimeControlResultV2> {
    const graph = this.requireGraph();
    if (control.action === 'status') return graph.goal.control(control, 'status');

    let resolveExecution!: (value: {
      readonly turnId: string;
      readonly result: GoalRuntimeControlResultV2;
    }) => void;
    let rejectExecution!: (error: unknown) => void;
    const execution = new Promise<{
      readonly turnId: string;
      readonly result: GoalRuntimeControlResultV2;
    }>((resolvePromise, rejectPromise) => {
      resolveExecution = resolvePromise;
      rejectExecution = rejectPromise;
    });
    const admission = graph.thread.startGoalControl({
      type: 'goal_control',
      input: goalControlInput(control),
      onRejected: reason => rejectExecution(new Error(`Goal control was rejected: ${reason}.`)),
      run: async context => {
        try {
          if (context.abortSignal.aborted) throw new Error('Goal control was interrupted.');
          const result = graph.goal.control(control, context.turnId, fields => {
            const previous = restoreLatestTurnCommit(graph.eventStore);
            const committed = graph.services.events.turnCommits.commit({
              turnId: context.turnId,
              history: previous ? parseCommittedHistory(previous) : [],
              taskContextState: graph.taskContext.exportState(),
              taskContextRevision: graph.taskContext.revision,
              terminal: { status: 'completed', outcome: `goal_control:${control.action}` },
              ...(fields.goalState ? { goalState: fields.goalState } : {}),
              ...(fields.stopDecision ? { stopDecision: fields.stopDecision } : {}),
            });
            return committed;
          });
          resolveExecution({ turnId: context.turnId, result });
          return { status: 'completed', outcome: `goal_control:${control.action}` };
        } catch (error) {
          rejectExecution(error);
          throw error;
        }
      },
    });
    if (admission.status === 'rejected') {
      throw new Error(`Goal control was rejected: ${admission.reason}.`);
    }
    const deadlineTimer =
      admission.status === 'queued'
        ? setTimeout(
            () => rejectExecution(new Error('Goal control was rejected: deadline_expired.')),
            Math.max(1, admission.deadline - Date.now())
          )
        : undefined;
    deadlineTimer?.unref();
    let completed: Awaited<typeof execution>;
    try {
      completed = await execution;
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
    const terminal = await graph.thread.waitForTurnTerminal(completed.turnId);
    if (terminal !== 'completed') {
      throw new Error(`Goal control turn ended as ${terminal}.`);
    }
    return completed.result;
  }

  /** Schedule an explicit Compact transaction as a non-steerable maintenance turn. */
  compact(input: OrionExplicitCompactInputV1 = {}): ThreadCommandAdmissionV1 {
    const graph = this.requireGraph();
    const coordinator = this.options.loop?.compactCoordinator;
    if (!coordinator) {
      throw new OrionRuntimeV1Error(
        'ORION_RUNTIME_INVALID_CONFIGURATION',
        'Explicit compact requires a runtime-owned CompactCoordinator.'
      );
    }
    const maxMessages = input.maxMessages ?? 20;
    if (!Number.isSafeInteger(maxMessages) || maxMessages <= 0) {
      throw new OrionRuntimeV1Error(
        'ORION_RUNTIME_INVALID_CONFIGURATION',
        'Explicit compact maxMessages must be a positive integer.'
      );
    }
    const request: ThreadCompactMaintenanceRequestV1 = Object.freeze({
      type: 'compact' as const,
      source: 'explicit' as const,
      prepare: async (
        {
          source,
          history,
        }: {
          readonly source: CompactPrepareSourceReceiptV1;
          readonly history: readonly unknown[];
        },
        signal: AbortSignal
      ) => {
        throwIfAborted(signal);
        const messages = parseModelVisibleHistory(history);
        const result = await coordinator.compactManual(messages, maxMessages, input.focus);
        throwIfAborted(signal);
        return createThreadCompactCandidateDraftV1({
          source: 'explicit',
          sourceHistoryDigest: source.historyDigest,
          modelVisibleHistory: result.messages,
          payload: {
            version: 1,
            mode: 'explicit',
            summary: result.summary,
            summarySource: result.summarySource,
            summaryGeneratedAt: result.summaryGeneratedAt,
            fingerprint: result.fingerprint,
            beforeTokens: result.beforeTokens,
            afterTokens: result.afterTokens,
            plan: result.plan,
            semanticSummary: result.semanticSummary,
            diagnostics: result.diagnostics,
          },
        });
      },
    });
    return graph.thread.startCompactMaintenance(request, 'compact:explicit');
  }

  start(): Promise<this> {
    if (this.stateValue === 'started') return Promise.resolve(this);
    if (this.startFlight) return this.startFlight;
    if (this.stateValue === 'closing' || this.stateValue === 'closed') {
      return Promise.reject(
        new OrionRuntimeV1Error('ORION_RUNTIME_CLOSED', 'Closed OrionRuntime cannot start.')
      );
    }
    this.stateValue = 'starting';
    this.startFlight = this.performStart();
    return this.startFlight;
  }

  close(reason = 'orion_runtime_closed'): Promise<ResourceScopeCloseReport> {
    if (this.closeFlight) return this.closeFlight;
    this.closeRequested = true;
    this.stateValue = 'closing';
    this.closeFlight = this.performClose(reason);
    return this.closeFlight;
  }

  private async performStart(): Promise<this> {
    try {
      this.acquireOwnership();
      const eventStore = new ThreadEventStore(
        this.options.eventStore.rootDir,
        this.options.eventStore.threadId,
        this.options.eventStore.options
      );
      const compactPersistence = new ThreadCompactTransactionPersistenceV1(eventStore);
      const compactRunner = new ThreadCompactMaintenanceRunnerV1(eventStore, this.options.compact);
      const compactRecovery = await compactRunner.recoverOrphans();
      const restored = restoreLatestTurnCommit(eventStore);
      const taskContext = createTaskContextService(
        mergeTaskContextOptions(this.options.taskContext, restored)
      );
      const goal = new GoalRuntimeCoordinatorV2({
        ...(this.options.goal ? { definition: this.options.goal } : {}),
        ...(restored ? { restoredCommit: restored } : {}),
      });
      const prompts = new PromptRegistryV1();
      const contributors = createRuntimeContributors(
        this.options.contributors ?? emptyRuntimeContributorSlots()
      );

      const skills = await this.scope.activate({
        id: 'lazy-skills',
        activate: () => {
          const runtime = new LazySkillRuntime({
            ...this.options.skills,
            signal: this.scope.signal,
          });
          return { value: runtime, dispose: () => runtime.dispose() };
        },
      });
      const mcp = await this.scope.activate({
        id: 'lazy-mcp',
        activate: () => {
          const runtime = new LazyMcpRuntime({ ...this.options.mcp, signal: this.scope.signal });
          return {
            value: runtime,
            dispose: context => runtime.dispose(context.reason),
          };
        },
      });

      const basePolicy = new FirstPartyToolPolicyServiceV1(
        this.options.toolCatalog,
        this.options.toolContext
      );
      const subagentTurns = new Map<string, OrionSubagentTurnCapabilityV1>();
      const subagentTurnFlights = new Map<
        string,
        Promise<OrionSubagentTurnCapabilityV1 | undefined>
      >();
      const subagentUnavailableTurns = new Set<string>();
      const subagentPolicies = new Map<string, FirstPartyToolPolicyServiceV1>();
      const subagentAuthorityDigests = new Map<string, string>();
      const policy: ToolPolicyServiceV1 & RuntimeServicePort = Object.freeze({
        serviceId: 'turn-routed-first-party-tool-policy-v1',
        decide: (input: Parameters<ToolPolicyServiceV1['decide']>[0]) => {
          if (input.descriptor.name === 'subtask') {
            const turnPolicy = subagentPolicies.get(input.snapshot.turnId);
            if (!turnPolicy) {
              return Object.freeze({
                behavior: 'deny' as const,
                source: 'subagent-turn',
                reason: 'No active turn-owned subagent policy exists for this snapshot.',
                digest: digestRuntimeValue({
                  behavior: 'deny',
                  source: 'subagent-turn',
                  reason: 'No active turn-owned subagent policy exists for this snapshot.',
                }),
              });
            }
            return turnPolicy.decide(input);
          }
          return basePolicy.decide(input);
        },
      });
      const approval = new FirstPartyToolApprovalServiceV1(this.options.approvalHandler);
      const sandbox = new FirstPartySandboxServiceV1();
      const execution = new ExecutionService();
      const toolJournal = new ThreadToolInvocationJournalV1(eventStore);
      const gateway = new ToolGateway({
        policy,
        approval,
        sandbox,
        execution,
        nested: new BatchReadExecutionServiceV1(),
        journal: toolJournal,
      });
      const capabilityJournal = new CapabilityReceiptJournalV1(eventStore);
      const subagents =
        this.options.subagents ?? Object.freeze({ serviceId: 'subagents-disabled-v1' });
      const runtimeServicesDigest = digestRuntimeValue({
        version: 1,
        services: { ...SERVICE_IDS, subagents: subagents.serviceId },
      });
      const resolveSubagentTurn = async (
        input: AgentLoopStepPrepareInputV1,
        authority: AuthoritySnapshotV1
      ): Promise<OrionSubagentTurnCapabilityV1 | undefined> => {
        if (!this.options.subagents) return undefined;
        if (subagentUnavailableTurns.has(input.turnId)) return undefined;
        const existing = subagentTurns.get(input.turnId);
        if (existing) {
          assertSubagentAuthorityStable(input.turnId, authority, subagentAuthorityDigests);
          return existing;
        }
        const pending = subagentTurnFlights.get(input.turnId);
        if (pending) return pending;
        const flight = Promise.resolve(
          this.options.subagents.createTurn({
            store: eventStore,
            threadId: input.threadId,
            turnId: input.turnId,
            input: input.input,
            mode: input.mode,
            authority,
            abortSignal: input.abortSignal,
            flush: () => undefined,
          })
        ).then(async capability => {
          if (!capability) {
            subagentUnavailableTurns.add(input.turnId);
            return undefined;
          }
          try {
            validateSubagentTurnCapability(input, capability);
            subagentTurns.set(input.turnId, capability);
            subagentPolicies.set(
              input.turnId,
              new FirstPartyToolPolicyServiceV1(capability.catalog, this.options.toolContext)
            );
            subagentAuthorityDigests.set(input.turnId, authority.digest);
            return capability;
          } catch (error) {
            await capability.close('subagent_turn_start_failed');
            throw error;
          }
        });
        subagentTurnFlights.set(input.turnId, flight);
        try {
          return await flight;
        } finally {
          subagentTurnFlights.delete(input.turnId);
        }
      };
      const preparedRegistries = new Map<string, ReadonlyMap<string, ToolBindingV1>>();
      const preparationKey = (input: AgentLoopStepPrepareInputV1): string =>
        `${input.turnId}:${input.requestIndex}`;
      const stepFactory = new CapabilityAgentLoopStepFactoryV1({
        resolveConfiguration: async input => {
          const configured = await this.options.resolveCapabilityConfiguration(
            input,
            Object.freeze({
              runtimeServicesDigest,
              toolCatalog: this.options.toolCatalog,
              taskContext,
              skills,
              mcp,
              mcpCatalog: mcp.getCatalog(),
              prompts,
            })
          );
          const subagentTurn = await resolveSubagentTurn(input, configured.compiler.authority);
          const dynamic = mergeDynamicTools(configured.dynamicTools, subagentTurn?.catalog);
          const registry = new Map(this.options.toolCatalog.bindings);
          for (const [bindingId, binding] of dynamic?.bindings ?? []) {
            if (registry.has(bindingId)) {
              throw new OrionRuntimeV1Error(
                'ORION_RUNTIME_INVALID_CONFIGURATION',
                `Dynamic tool binding collides with ${bindingId}.`
              );
            }
            registry.set(bindingId, binding);
          }
          preparedRegistries.set(preparationKey(input), registry);
          return {
            ...configured,
            dynamicTools: undefined,
            compiler: {
              ...configured.compiler,
              tools: [...this.options.toolCatalog.candidates, ...(dynamic?.candidates ?? [])],
              runtimeServicesDigest,
              mcpCatalogDigest: mcp.getCatalog().digest,
            },
          };
        },
        resolveToolRegistry: input => {
          const key = preparationKey(input);
          const registry = preparedRegistries.get(key);
          preparedRegistries.delete(key);
          if (!registry) {
            throw new OrionRuntimeV1Error(
              'ORION_RUNTIME_INVALID_CONFIGURATION',
              `No frozen tool registry exists for ${key}.`
            );
          }
          return registry;
        },
        onCaptured: async bundle => {
          const commit = capabilityJournal.commit(bundle);
          await subagentTurns.get(bundle.snapshot.turnId)?.publishCommitted(bundle, commit);
        },
      });
      const turnCommits = new ThreadTurnCommitJournalV1(eventStore);
      const agentLoop = new AgentLoopV1({
        llm: this.options.modelExecutor,
        taskContext,
        steps: stepFactory,
        gateway,
        loadBaseMessages: context =>
          loadRuntimeBaseMessages(
            compactPersistence,
            this.options.loadBaseMessages?.(eventStore, context, prompts, {
              taskContext,
              goal,
              skills,
              mcp,
            })
          ),
        toolContext: () => this.options.toolContext,
        streamCallbacks: this.options.loop?.streamCallbacks,
        loopBudget: this.options.loop?.loopBudget,
        onContextUsage: this.options.loop?.onContextUsage,
        compactCoordinator: this.options.loop?.compactCoordinator,
        commitTurn: commit => {
          const prepared = this.options.loop?.prepareTurnCommit?.(commit);
          const committed = prepared?.stopDecision
            ? withStopDecision(commit, prepared.stopDecision)
            : commit;
          let durableCommit: TurnCommitV1 | undefined;
          goal.commitTurn(committed, fields => {
            durableCommit = turnCommits.commit({
              turnId: committed.turnId,
              history: committed.history,
              taskContextState: committed.taskContextState,
              taskContextRevision: committed.taskContextRevision,
              terminal: terminalFromAgentCommit(committed.queryComplete),
              ...(fields.goalState ? { goalState: fields.goalState } : {}),
              ...(fields.stopDecision ? { stopDecision: fields.stopDecision } : {}),
              ...(prepared?.plan ? { plan: prepared.plan } : {}),
            });
            return durableCommit;
          });
          if (!durableCommit) {
            throw new OrionRuntimeV1Error(
              'ORION_RUNTIME_INVALID_CONFIGURATION',
              `Turn ${commit.turnId} completed without an authoritative TurnCommit.`
            );
          }
          try {
            const projected = this.options.loop?.onTurnCommitted?.(committed, durableCommit);
            return projected && typeof projected.then === 'function'
              ? projected.catch(() => undefined)
              : undefined;
          } catch {
            // UI/metrics projections cannot veto an already durable TurnCommit.
            return undefined;
          }
        },
      });
      const thread = await this.scope.activate({
        id: 'thread-runtime',
        activate: () => {
          const runtime = new ThreadRuntimeV1({
            ...this.options.thread,
            store: eventStore,
            runner: agentLoop,
            maintenanceRunner: compactRunner,
            projectPath: this.options.projectPath,
            requireTurnCommit: true,
            onTurnStarted: turn => {
              goal.markTurnStarted(turn.turnId, turn.startedAt);
              this.options.thread?.onTurnStarted?.(turn);
            },
            onTurnDurablyTerminal: terminal =>
              goal.afterDurableTerminal(terminal.turnId, terminal.terminal) ??
              this.options.thread?.onTurnDurablyTerminal?.(terminal),
            onTurnSettled: async turnId => {
              for (const key of [...preparedRegistries.keys()]) {
                if (key.startsWith(`${turnId}:`)) preparedRegistries.delete(key);
              }
              const turnCapability = subagentTurns.get(turnId);
              subagentTurns.delete(turnId);
              subagentTurnFlights.delete(turnId);
              subagentUnavailableTurns.delete(turnId);
              subagentPolicies.delete(turnId);
              subagentAuthorityDigests.delete(turnId);
              try {
                await turnCapability?.close('parent_turn_settled');
              } finally {
                await mcp.releaseOwner(turnId);
                await this.options.thread?.onTurnSettled?.(turnId);
              }
            },
          });
          return {
            value: runtime,
            dispose: async context => {
              goal.close();
              runtime.close(context.reason);
              await runtime.waitForIdle();
            },
          };
        },
      });

      const services = createRuntimeServices<OrionRuntimeServiceSlotsV1>({
        models: servicePort(SERVICE_IDS.models, { executor: this.options.modelExecutor }),
        threads: servicePort(SERVICE_IDS.threads, { runtime: thread }),
        policy,
        execution: servicePort(SERVICE_IDS.execution, { execution }),
        tools: servicePort(SERVICE_IDS.tools, {
          catalog: this.options.toolCatalog,
          gateway,
          approval,
          sandbox,
          journal: toolJournal,
        }),
        prompts: servicePort(SERVICE_IDS.prompts, { registry: prompts }),
        skills: servicePort(SERVICE_IDS.skills, { runtime: skills }),
        mcp: servicePort(SERVICE_IDS.mcp, { runtime: mcp }),
        goals: servicePort(SERVICE_IDS.goals, { runtime: goal }),
        taskContext,
        capabilities: servicePort(SERVICE_IDS.capabilities, {
          steps: stepFactory,
          journal: capabilityJournal,
        }),
        events: servicePort(SERVICE_IDS.events, { store: eventStore, turnCommits }),
        compaction: servicePort(SERVICE_IDS.compaction, {
          persistence: compactPersistence,
          runner: compactRunner,
          recovery: compactRecovery,
        }),
        subagents,
      });
      this.graphValue = Object.freeze({
        services,
        contributors,
        scope: this.scope,
        eventStore,
        taskContext,
        prompts,
        skills,
        mcp,
        goal,
        execution,
        gateway,
        capabilityJournal,
        compactPersistence,
        compactRunner,
        compactRecovery,
        stepFactory,
        agentLoop,
        thread,
      });
      const restoredTurn = restored
        ? eventStore.loadProjection().turns[restored.turnId]
        : undefined;
      if (
        !this.closeRequested &&
        restoredTurn?.status === 'completed' &&
        eventStore.loadProjection().queue.length === 0
      ) {
        const continuation = goal.takeRestoredContinuation();
        if (continuation) thread.startGoalContinuation(continuation);
      }
      if (this.closeRequested) {
        throw new OrionRuntimeV1Error(
          'ORION_RUNTIME_CLOSED',
          'OrionRuntime was closed while starting.'
        );
      }
      this.stateValue = 'started';
      await this.options.loop?.onRuntimeStarted?.({
        ...(restored ? { restoredCommit: restored } : {}),
        thread,
        eventStore,
      });
      return this;
    } catch (error) {
      await this.scope.close({ reason: 'orion_runtime_start_failed' });
      this.releaseOwnership();
      this.stateValue = 'closed';
      throw error;
    }
  }

  private async performClose(reason: string): Promise<ResourceScopeCloseReport> {
    if (this.startFlight) {
      try {
        await this.startFlight;
      } catch {
        // Failed start already rolled back the same ResourceScope.
      }
    }
    const report = await this.scope.close({ reason });
    this.releaseOwnership();
    this.stateValue = 'closed';
    return report;
  }

  private acquireOwnership(): void {
    const existing = ACTIVE_RUNTIME_OWNERS.get(this.ownerKey);
    if (existing && existing !== this) {
      throw new OrionRuntimeV1Error(
        'ORION_RUNTIME_OWNER_CONFLICT',
        `Thread ${this.options.eventStore.threadId} already has an active OrionRuntime owner.`
      );
    }
    ACTIVE_RUNTIME_OWNERS.set(this.ownerKey, this);
  }

  private releaseOwnership(): void {
    if (ACTIVE_RUNTIME_OWNERS.get(this.ownerKey) === this) {
      ACTIVE_RUNTIME_OWNERS.delete(this.ownerKey);
    }
  }

  private requireGraph(): OrionRuntimeGraphV1 {
    if (!this.graphValue || this.stateValue !== 'started') {
      throw new OrionRuntimeV1Error(
        'ORION_RUNTIME_NOT_STARTED',
        'OrionRuntime services are available only after start().'
      );
    }
    return this.graphValue;
  }
}

export function createOrionRuntimeV1(options: OrionRuntimeV1Options): OrionRuntimeV1 {
  return new OrionRuntimeV1(options);
}

function mergeDynamicTools(
  configured: OrionCapabilityStepConfigurationV1['dynamicTools'],
  subagentCatalog: BuiltinToolCatalogV1 | undefined
): OrionCapabilityStepConfigurationV1['dynamicTools'] {
  if (!subagentCatalog) return configured;
  const candidates = [...(configured?.candidates ?? [])];
  const bindings = new Map(configured?.bindings ?? []);
  const candidateNames = new Set(candidates.map(candidate => candidate.descriptor.name));
  const candidateBindingIds = new Set(candidates.map(candidate => candidate.bindingId));
  for (const candidate of subagentCatalog.candidates) {
    if (candidateNames.has(candidate.descriptor.name)) {
      invalidConfiguration(
        `Turn subagent tool collides with dynamic tool ${candidate.descriptor.name}.`
      );
    }
    if (candidateBindingIds.has(candidate.bindingId) || bindings.has(candidate.bindingId)) {
      invalidConfiguration(
        `Turn subagent binding collides with dynamic binding ${candidate.bindingId}.`
      );
    }
    candidates.push(candidate);
    candidateNames.add(candidate.descriptor.name);
    candidateBindingIds.add(candidate.bindingId);
  }
  for (const [bindingId, binding] of subagentCatalog.bindings) {
    if (bindings.has(bindingId)) {
      invalidConfiguration(`Turn subagent binding collides with dynamic binding ${bindingId}.`);
    }
    bindings.set(bindingId, binding);
  }
  return Object.freeze({ candidates: Object.freeze(candidates), bindings });
}

function validateSubagentTurnCapability(
  input: AgentLoopStepPrepareInputV1,
  capability: OrionSubagentTurnCapabilityV1
): void {
  const catalog = capability.catalog;
  const candidate = catalog?.candidates[0];
  const binding = candidate ? catalog.bindings.get(candidate.bindingId) : undefined;
  if (
    !capability.serviceId?.trim() ||
    capability.turnId !== input.turnId ||
    typeof capability.publishCommitted !== 'function' ||
    typeof capability.close !== 'function' ||
    !catalog ||
    catalog.entries.length !== 1 ||
    catalog.candidates.length !== 1 ||
    catalog.bindings.size !== 1 ||
    candidate?.descriptor.name !== 'subtask' ||
    candidate.descriptor.risk.readOnly !== true ||
    candidate.descriptor.risk.destructive ||
    !binding ||
    binding.descriptor.executorId !== candidate.descriptor.executorId ||
    binding.descriptor.schemaDigest !== candidate.descriptor.schemaDigest
  ) {
    invalidConfiguration(
      `Subagent turn ${input.turnId} must expose exactly one read-only exact subtask binding.`
    );
  }
}

function assertSubagentAuthorityStable(
  turnId: string,
  authority: AuthoritySnapshotV1,
  digests: ReadonlyMap<string, string>
): void {
  const expected = digests.get(turnId);
  if (expected && expected !== authority.digest) {
    invalidConfiguration(`Subagent authority drifted within root turn ${turnId}.`);
  }
}

function parseCapabilityDiagnostics(
  capabilityEvent: RuntimeEventEnvelopeV1 | undefined,
  snapshotEvent: RuntimeEventEnvelopeV1 | undefined
): OrionRuntimeDiagnosticsV1['capability'] | undefined {
  if (!capabilityEvent || capabilityEvent.payload.type !== 'capability.receipt') {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(capabilityEvent.payload.data.receipt) as unknown;
  } catch {
    invalidConfiguration('Durable CapabilityReceipt is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    invalidConfiguration('Durable CapabilityReceipt is not an object.');
  }
  const receipt = parsed as CapabilityReceiptV1;
  const { digest, ...content } = receipt;
  if (
    typeof digest !== 'string' ||
    digestRuntimeValue(content) !== digest ||
    digest !== capabilityEvent.payload.data.digest ||
    receipt.threadId !== capabilityEvent.threadId ||
    receipt.turnId !== capabilityEvent.turnId ||
    receipt.stepId !== capabilityEvent.stepId ||
    receipt.requestId !== capabilityEvent.payload.data.receiptId
  ) {
    invalidConfiguration('Durable CapabilityReceipt failed identity or integrity validation.');
  }

  let stepSnapshotDigest = 'unavailable';
  if (
    snapshotEvent?.payload.type === 'step.snapshot' &&
    snapshotEvent.threadId === receipt.threadId &&
    snapshotEvent.turnId === receipt.turnId &&
    snapshotEvent.stepId === receipt.stepId
  ) {
    stepSnapshotDigest = snapshotEvent.payload.data.digest;
  }
  const fullSchemaBytes = CURRENT_TOOL_SCHEMA_BASELINE_V1.bytes;
  const schemaReductionPercent = Number(
    ((1 - receipt.toolSchemaBytes / fullSchemaBytes) * 100).toFixed(3)
  );

  return Object.freeze({
    requestId: receipt.requestId,
    stepId: receipt.stepId,
    direct: [...receipt.directToolNames],
    deferred: [...receipt.deferredToolNames],
    hidden: { ...receipt.hiddenToolReasons },
    omitted: receipt.omitted.map(item => ({ id: item.id, reason: item.reason })),
    schemaBytes: receipt.toolSchemaBytes,
    fullSchemaBytes,
    schemaReductionPercent,
    stepSnapshotDigest,
    toolRouterDigest: receipt.toolRouterDigest,
    authorityDigest: receipt.authorityDigest,
    executionPolicyDigest: receipt.executionPolicyDigest,
    skillCatalogDigest: receipt.skillCatalogDigest,
    selectedSkillIds: [...receipt.selectedSkillIds],
    mcpCatalogDigest: receipt.mcpCatalogDigest,
    selectedMcpBindings: receipt.selectedMcpBindings.map(
      binding => `${binding.serverId}:${binding.toolName}`
    ),
    promptSections: receipt.promptManifest.map(section => ({
      id: section.id,
      digest: section.digest,
      selected: section.selected,
      ...(section.reason ? { reason: section.reason } : {}),
    })),
    receiptDigest: receipt.digest,
  });
}

function validateOptions(options: OrionRuntimeV1Options): OrionRuntimeV1Options {
  if (!options || typeof options !== 'object') invalidConfiguration('Options are required.');
  if (!options.modelExecutor) invalidConfiguration('modelExecutor is required.');
  if (!options.toolCatalog) invalidConfiguration('toolCatalog is required.');
  if (!options.toolContext?.cwd?.trim()) invalidConfiguration('toolContext.cwd is required.');
  if (!options.eventStore?.rootDir?.trim()) {
    invalidConfiguration('eventStore.rootDir is required.');
  }
  if (!options.eventStore?.threadId?.trim()) {
    invalidConfiguration('eventStore.threadId is required.');
  }
  if (!options.projectPath?.trim()) invalidConfiguration('projectPath is required.');
  if (typeof options.resolveCapabilityConfiguration !== 'function') {
    invalidConfiguration('resolveCapabilityConfiguration is required.');
  }
  if (!options.skills || !Array.isArray(options.skills.providers)) {
    invalidConfiguration('skills.providers must be an array.');
  }
  if (!options.mcp || !Array.isArray(options.mcp.descriptors) || !options.mcp.connector) {
    invalidConfiguration('MCP descriptors and connector are required.');
  }
  if (
    options.subagents &&
    (!options.subagents.serviceId?.trim() || typeof options.subagents.createTurn !== 'function')
  ) {
    invalidConfiguration('subagents must provide a serviceId and createTurn factory.');
  }
  return Object.freeze({
    ...options,
    eventStore: Object.freeze({
      ...options.eventStore,
      rootDir: resolve(options.eventStore.rootDir),
    }),
    projectPath: resolve(options.projectPath),
  });
}

function ownerKey(roots: OrionRuntimeEventStoreRootsV1): string {
  return `${resolve(roots.rootDir)}\u0000${roots.threadId}`;
}

function goalControlInput(control: GoalRuntimeControlV2): string {
  return `goal-control:${control.action}:${digestRuntimeValue(control)}`;
}

function parseCommittedHistory(commit: TurnCommitV1): Message[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(commit.history) as unknown;
  } catch {
    invalidConfiguration('Durable TurnCommit history is not valid JSON.');
  }
  if (!Array.isArray(parsed)) {
    invalidConfiguration('Durable TurnCommit history is not an array.');
  }
  return parseModelVisibleHistory(parsed);
}

function mergeTaskContextOptions(
  configured: TaskContextServiceOptions,
  restored: TurnCommitV1 | undefined
): TaskContextServiceOptions {
  if (!restored) return configured;
  const durableState = parseTaskContextState(restored);
  if (
    configured.state &&
    digestRuntimeValue(configured.state) !== digestRuntimeValue(durableState)
  ) {
    invalidConfiguration('Configured TaskContext state conflicts with the durable TurnCommit.');
  }
  if (configured.revision !== undefined && configured.revision !== restored.taskContextRevision) {
    invalidConfiguration('Configured TaskContext revision conflicts with the durable TurnCommit.');
  }
  return {
    ...configured,
    state: durableState,
    revision: restored.taskContextRevision,
  };
}

function restoreLatestTurnCommit(store: ThreadEventStore): TurnCommitV1 | undefined {
  const commits = Object.values(store.loadProjection().turns)
    .map(turn => turn.commit)
    .filter((commit): commit is NonNullable<typeof commit> => Boolean(commit))
    .sort((left, right) => left.seq - right.seq);
  return commits.length > 0 ? parseTurnCommitV1(commits[commits.length - 1].receipt) : undefined;
}

function parseTaskContextState(commit: TurnCommitV1): HarnessState {
  try {
    return JSON.parse(commit.taskContext) as HarnessState;
  } catch {
    invalidConfiguration('Durable TurnCommit TaskContext is not valid JSON.');
  }
}

async function loadRuntimeBaseMessages(
  compact: ThreadCompactTransactionPersistenceV1,
  configured?: readonly Message[] | Promise<readonly Message[]>
): Promise<readonly Message[]> {
  const authoritative = compact.loadModelVisibleHistory();
  const configuredMessages = configured ? await configured : undefined;
  if (!authoritative) return configuredMessages?.map(message => ({ ...message })) ?? [];
  const durable = parseModelVisibleHistory(authoritative);
  if (!configuredMessages) return durable;

  // Product loaders own current system/prompt assembly, but never the durable
  // conversation tail. A committed Compact pointer replaces that tail here.
  return [
    ...configuredMessages
      .filter(message => message.role === 'system')
      .map(message => ({ ...message })),
    ...durable.filter(message => message.role !== 'system').map(message => ({ ...message })),
  ];
}

function parseModelVisibleHistory(history: readonly unknown[]): Message[] {
  if (!history.every(isMessage)) {
    invalidConfiguration('Durable model-visible history has an invalid message shape.');
  }
  return history.map(message => ({ ...message }));
}

function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<Message>;
  return (
    ['system', 'user', 'assistant', 'tool'].includes(message.role ?? '') &&
    typeof message.content === 'string'
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Compact was aborted.');
  }
}

function withStopDecision(
  commit: AgentLoopTurnCommitV1,
  stopDecision: StopDecision
): AgentLoopTurnCommitV1 {
  const stats = commit.queryComplete.stats;
  if (!stats) invalidConfiguration('A prepared StopDecision requires terminal loop statistics.');
  const queryComplete = {
    ...commit.queryComplete,
    stats: { ...stats, stopDecision },
  };
  const content = {
    threadId: commit.threadId,
    turnId: commit.turnId,
    queryComplete,
    taskContextState: commit.taskContextState,
    taskContextRevision: commit.taskContextRevision,
    ...(commit.taskContextCompletion
      ? { taskContextCompletion: commit.taskContextCompletion }
      : {}),
    history: commit.history,
  };
  return Object.freeze({ ...content, digest: digestRuntimeValue(content) });
}

function terminalFromAgentCommit(
  complete: Parameters<
    NonNullable<ConstructorParameters<typeof AgentLoopV1>[0]['commitTurn']>
  >[0]['queryComplete']
): TurnCommitTerminalV1 {
  if (complete.stats?.finishReason === 'cancelled') {
    return { status: 'interrupted', reason: complete.content || 'AgentLoop interrupted' };
  }
  if (complete.stats?.finishReason === 'failed') {
    return { status: 'failed', error: complete.content || 'AgentLoop failed' };
  }
  return {
    status: 'completed',
    outcome: canonicalRuntimeJson({
      finishReason: complete.stats?.finishReason ?? 'completed',
      stopDecision: complete.stats?.stopDecision,
    }),
  };
}

function servicePort<T extends object>(
  serviceId: string,
  value: T
): Readonly<T & { readonly serviceId: string }> {
  return Object.freeze({ serviceId, ...value });
}

function invalidConfiguration(message: string): never {
  throw new OrionRuntimeV1Error('ORION_RUNTIME_INVALID_CONFIGURATION', message);
}
