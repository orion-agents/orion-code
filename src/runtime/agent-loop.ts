import { createHash } from 'crypto';

import {
  query,
  type QueryEvent,
  type QueryModelRequestBindingInput,
  type QueryParams,
  type QueryTaskContext,
} from '../framework/query';
import type { OrionCodeTool, ToolContext } from '../framework/tool';
import { serializeToolResult } from '../framework/tool-serializer';
import type { LoopBudget } from '../framework/query';
import type { LLMService, Message, StreamCallbacks } from '../services/llm';
import { canonicalRuntimeJson, digestRuntimeValue } from './protocol/canonical';
import { createThreadCompactCandidateDraftV1 } from './thread-compact-persistence';
import type { TaskContextCompletionDecisionV1, TaskContextService } from './task-context-service';
import type { StepSnapshotV1, ToolBindingDescriptorV1, ToolBindingV1 } from './step-snapshot';
import { ToolRouterSnapshotV1 } from './step-snapshot';
import type { ThreadEventStore } from './thread-event-store';
import type {
  ThreadItemHandleV1,
  ThreadCompactMaintenanceRequestV1,
  ThreadTurnExecutionContextV1,
  ThreadTurnOutcomeV1,
  ThreadTurnRunnerV1,
} from './thread-runtime';
import type { CompactPrepareSourceReceiptV1 } from './compact-transaction';
import type {
  ToolExecutionMetadata,
  ToolExecutorOutcome,
  ToolPermissionDecision,
} from '../framework/tool-call-orchestrator';
import { ToolGateway } from './tool-gateway';

export interface AgentLoopPreparedStepV1 {
  readonly stepId: string;
  readonly toolBindings: readonly ToolBindingV1[];
  readonly capture: (input: {
    readonly messages: readonly Message[];
    readonly taskContextRevision: number;
  }) => StepSnapshotV1 | Promise<StepSnapshotV1>;
}

export interface AgentLoopStepFactoryV1 {
  prepare(input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly requestIndex: number;
    readonly input: string;
    readonly mode: ThreadTurnExecutionContextV1['mode'];
    readonly messages: readonly Message[];
    readonly taskContextRevision: number;
    readonly abortSignal: AbortSignal;
  }): AgentLoopPreparedStepV1 | Promise<AgentLoopPreparedStepV1>;
}

export interface AgentLoopTurnCommitV1 {
  readonly threadId: string;
  readonly turnId: string;
  readonly queryComplete: Extract<QueryEvent, { type: 'complete' }>;
  readonly taskContextState: ReturnType<TaskContextService['exportState']>;
  readonly taskContextRevision: number;
  readonly taskContextCompletion?: TaskContextCompletionDecisionV1;
  readonly history: readonly Message[];
  readonly digest: string;
}

export interface AgentLoopOptionsV1 {
  readonly llm: LLMService;
  readonly taskContext: TaskContextService;
  readonly steps: AgentLoopStepFactoryV1;
  readonly gateway: ToolGateway;
  /** Load system and prior history. The current user input is appended by AgentLoop. */
  readonly loadBaseMessages: (
    context: ThreadTurnExecutionContextV1
  ) => readonly Message[] | Promise<readonly Message[]>;
  readonly toolContext?: (
    context: ThreadTurnExecutionContextV1,
    snapshot: StepSnapshotV1
  ) => ToolContext;
  readonly streamCallbacks?: StreamCallbacks;
  readonly loopBudget?: Partial<LoopBudget>;
  /** Publish the latest model-context pressure without giving UI code loop ownership. */
  readonly onContextUsage?: QueryParams['onContextUsage'];
  readonly onStepCaptured?: (snapshot: StepSnapshotV1) => void | Promise<void>;
  readonly commitTurn?: (commit: AgentLoopTurnCommitV1) => void | Promise<void>;
  readonly compactCoordinator?: QueryParams['compactCoordinator'];
}

/**
 * The single production model -> tool recursion adapter.
 *
 * It deliberately reuses query()'s mature budget/provider/compact logic while
 * replacing its turn-scoped registry with a frozen StepSnapshot and ToolGateway
 * binding at every provider request.
 */
export class AgentLoopV1 implements ThreadTurnRunnerV1 {
  readonly serviceId = 'agent-loop' as const;

  constructor(private readonly options: AgentLoopOptionsV1) {}

  async run(context: ThreadTurnExecutionContextV1): Promise<ThreadTurnOutcomeV1> {
    this.options.taskContext.observeUserInput(context.input);
    const messages = (await this.options.loadBaseMessages(context)).map(message => ({
      ...message,
    }));
    messages.push({ role: 'user', content: context.input });

    let activeStep: StepSnapshotV1 | undefined;
    let assistantItem: ThreadItemHandleV1 | undefined;
    let assistantContent = '';
    let reasoningItem: ThreadItemHandleV1 | undefined;
    let completeEvent: Extract<QueryEvent, { type: 'complete' }> | undefined;
    let taskContextCompletion: TaskContextCompletionDecisionV1 | undefined;

    const finishReasoning = (): void => {
      if (!reasoningItem) return;
      context.completeItem(reasoningItem, { summary: 'Model reasoning started' });
      reasoningItem = undefined;
    };
    const ensureAssistantItem = (): ThreadItemHandleV1 => {
      if (assistantItem) return assistantItem;
      assistantItem = context.startItem({
        kind: 'message',
        role: 'assistant',
        stepId: activeStep?.stepId,
      });
      return assistantItem;
    };
    const completeAssistant = (content: string): void => {
      if (!assistantItem && !content) return;
      const item = ensureAssistantItem();
      context.completeItem(item, { content, summary: compactSummary(content) });
      assistantItem = undefined;
      assistantContent = '';
    };
    const streamCallbacks: StreamCallbacks = {
      onThinking: () => {
        this.options.streamCallbacks?.onThinking?.();
        if (!reasoningItem) {
          reasoningItem = context.startItem({ kind: 'reasoning', stepId: activeStep?.stepId });
        }
      },
      onChunk: chunk => {
        finishReasoning();
        assistantContent += chunk;
        context.emitDelta(ensureAssistantItem(), chunk, 'content');
        this.options.streamCallbacks?.onChunk?.(chunk);
      },
    };

    const harness = createQueryTaskContextAdapter(
      this.options.taskContext,
      decision => {
        taskContextCompletion = decision;
      },
      context.mode === 'plan'
    );
    try {
      for await (const event of query({
        messages,
        tools: [],
        toolExecutor: async () => {
          throw new Error('AgentLoop tool execution was requested before StepSnapshot binding');
        },
        resolveStep: async stepInput => {
          const prepared = await this.options.steps.prepare({
            threadId: context.threadId,
            turnId: context.turnId,
            requestIndex: stepInput.requestIndex,
            input: context.input,
            mode: context.mode,
            messages: stepInput.messages,
            taskContextRevision: this.options.taskContext.revision,
            abortSignal: context.abortSignal,
          });
          const router = new ToolRouterSnapshotV1(prepared.toolBindings);
          const tools = router.descriptors.map(createSnapshotToolFacade);
          return {
            tools,
            toolExecutor: async () => {
              throw new Error('AgentLoop tool execution was requested before model binding');
            },
            bindModelRequest: async bindingInput => {
              activeStep = await this.bindStep(context, prepared, router, bindingInput);
              return {
                receiptDigest: activeStep.digest,
                toolExecutor: (name, args, abortSignal, metadata) =>
                  this.invokeTool(context, activeStep!, name, args, abortSignal, metadata),
              };
            },
          };
        },
        llm: this.options.llm,
        abortSignal: context.abortSignal,
        streamCallbacks,
        harness,
        input: context.input,
        toolContext: {
          cwd: process.cwd(),
          config: { name: 'orion-code', mode: context.mode },
        },
        loopBudget: this.options.loopBudget,
        onContextUsage: this.options.onContextUsage,
        compactCoordinator: this.options.compactCoordinator,
      })) {
        switch (event.type) {
          case 'request_start':
            finishReasoning();
            completeAssistant(assistantContent);
            activeStep = undefined;
            break;
          case 'assistant_tool_calls':
            finishReasoning();
            completeAssistant(assistantContent || event.content);
            break;
          case 'message':
            finishReasoning();
            completeAssistant(assistantContent || event.content);
            break;
          case 'warning':
          case 'strategy_exhausted': {
            const content = event.type === 'warning' ? event.message : event.suggestion;
            const item = context.startItem({ kind: 'reasoning', stepId: activeStep?.stepId });
            context.completeItem(item, { content, summary: compactSummary(content) });
            break;
          }
          case 'complete':
            completeEvent = event;
            break;
          case 'prompt_assembly':
          case 'tool_call':
          case 'permission_decision':
          case 'tool_result':
            break;
        }
      }
    } catch (error) {
      finishReasoning();
      if (assistantItem) context.failItem(assistantItem, errorMessage(error));
      return context.abortSignal.aborted
        ? { status: 'interrupted', reason: abortReason(context.abortSignal) }
        : { status: 'failed', error: errorMessage(error) };
    }

    finishReasoning();
    completeAssistant(assistantContent);
    if (!completeEvent) {
      return context.abortSignal.aborted
        ? { status: 'interrupted', reason: abortReason(context.abortSignal) }
        : { status: 'failed', error: 'AgentLoop ended without a terminal Query event' };
    }

    const commitContent = {
      threadId: context.threadId,
      turnId: context.turnId,
      queryComplete: completeEvent,
      taskContextState: this.options.taskContext.exportState(),
      taskContextRevision: this.options.taskContext.revision,
      ...(taskContextCompletion ? { taskContextCompletion } : {}),
      history: (completeEvent.compact?.uncompactedHistory ?? messages).map(message => ({
        ...message,
      })),
    };
    await this.options.commitTurn?.({
      ...commitContent,
      digest: digestRuntimeValue(commitContent),
    });

    if (context.abortSignal.aborted || completeEvent.stats?.finishReason === 'cancelled') {
      return { status: 'interrupted', reason: abortReason(context.abortSignal) };
    }
    if (completeEvent.stats?.finishReason === 'failed') {
      return { status: 'failed', error: completeEvent.content || 'AgentLoop failed' };
    }
    const maintenance = completeEvent.compact
      ? createAutomaticCompactMaintenance(completeEvent.compact)
      : undefined;
    return {
      status: 'completed',
      outcome: canonicalRuntimeJson({
        finishReason: completeEvent.stats?.finishReason ?? 'completed',
        stopDecision: completeEvent.stats?.stopDecision,
      }),
      ...(maintenance ? { maintenance } : {}),
    };
  }

  private async bindStep(
    context: ThreadTurnExecutionContextV1,
    prepared: AgentLoopPreparedStepV1,
    expectedRouter: ToolRouterSnapshotV1,
    bindingInput: QueryModelRequestBindingInput
  ): Promise<StepSnapshotV1> {
    const snapshot = await prepared.capture({
      messages: bindingInput.messages,
      taskContextRevision: this.options.taskContext.revision,
    });
    if (
      snapshot.threadId !== context.threadId ||
      snapshot.turnId !== context.turnId ||
      snapshot.stepId !== prepared.stepId
    ) {
      throw new Error('StepSnapshot identity does not match the active Thread/Turn/Step');
    }
    if (snapshot.toolRouter.digest !== expectedRouter.digest) {
      throw new Error('StepSnapshot router differs from the model-visible tool set');
    }
    if (snapshot.taskContextRevision !== this.options.taskContext.revision) {
      throw new Error('StepSnapshot TaskContext revision is stale at the model boundary');
    }
    snapshot.toolRouter.assertIntegrity();
    await this.options.onStepCaptured?.(snapshot);
    return snapshot;
  }

  private async invokeTool(
    context: ThreadTurnExecutionContextV1,
    snapshot: StepSnapshotV1,
    name: string,
    args: Record<string, unknown>,
    abortSignal?: AbortSignal,
    metadata?: ToolExecutionMetadata
  ): Promise<ToolExecutorOutcome> {
    if (!metadata) throw new Error('ToolGateway execution requires provider call identity');
    const invocationId = deterministicRuntimeId([
      context.threadId,
      context.turnId,
      snapshot.stepId,
      metadata.callId,
      String(metadata.index),
    ]);
    const toolContext = this.options.toolContext?.(context, snapshot) ?? {
      cwd: snapshot.environment.cwd,
      config: { name: 'orion-code', mode: context.mode },
    };
    const invoked = await this.options.gateway.invoke({
      invocationId,
      snapshot,
      toolName: name,
      args,
      context: toolContext,
      abortSignal,
    });
    const permissionDecision = projectPermissionDecision(invoked.receipt);
    return {
      result: serializeToolResult(invoked.result),
      ...(permissionDecision ? { permissionDecision } : {}),
    };
  }
}

function projectPermissionDecision(
  receipt: Awaited<ReturnType<ToolGateway['invoke']>>['receipt']
): ToolPermissionDecision | undefined {
  const policy = receipt.policy;
  if (!policy) return undefined;
  const approval = receipt.approval;
  return {
    behavior: policy.behavior,
    approved:
      policy.behavior === 'allow' || (policy.behavior === 'ask' && approval?.approved === true),
    source: normalizePermissionSource(policy.behavior, policy.source, approval?.source),
    reason: approval?.reason ?? policy.reason,
  };
}

function normalizePermissionSource(
  behavior: NonNullable<ToolPermissionDecision['behavior']>,
  policySource: string,
  approvalSource?: string
): ToolPermissionDecision['source'] {
  if (approvalSource === 'user') return 'user';
  if (approvalSource === 'authority') return behavior === 'deny' ? 'config_deny' : 'config_allow';
  if (approvalSource === 'unavailable') return 'missing_confirmation';
  if (policySource.startsWith('allowlist:')) {
    return behavior === 'allow'
      ? 'allowlist_allow'
      : behavior === 'deny'
        ? 'allowlist_deny'
        : 'allowlist_ask';
  }
  return 'tool_policy';
}

function createAutomaticCompactMaintenance(
  compact: NonNullable<Extract<QueryEvent, { type: 'complete' }>['compact']>
): ThreadCompactMaintenanceRequestV1 {
  const uncompactedHistory = compact.uncompactedHistory.map(message => ({ ...message }));
  const modelVisibleHistory = compact.modelHistory.map(message => ({ ...message }));
  const sourceHistoryDigest = digestRuntimeValue(uncompactedHistory);
  const payload = {
    version: 1 as const,
    mode: compact.mode,
    summary: structuredClone(compact.summary),
    before: structuredClone(compact.before),
    after: structuredClone(compact.after),
    fingerprint: compact.fingerprint,
    beforeTokens: compact.beforeTokens,
    afterTokens: compact.afterTokens,
    plan: structuredClone(compact.plan),
    semanticSummary: structuredClone(compact.semanticSummary),
    diagnostics: compact.diagnostics.map(diagnostic => ({ ...diagnostic })),
  };
  return Object.freeze({
    type: 'compact' as const,
    source: 'automatic' as const,
    prepare: ({ source }: { readonly source: CompactPrepareSourceReceiptV1 }) => {
      if (source.historyDigest !== sourceHistoryDigest) {
        throw new Error('Automatic compact source changed before its maintenance turn');
      }
      return createThreadCompactCandidateDraftV1({
        source: 'automatic',
        sourceHistoryDigest,
        modelVisibleHistory,
        payload,
      });
    },
  });
}

/** Persist the frozen step before its provider request is allowed to start. */
export class ThreadStepSnapshotJournalV1 {
  constructor(private readonly store: ThreadEventStore) {}

  commit(snapshot: StepSnapshotV1): void {
    if (snapshot.threadId !== this.store.threadId) {
      throw new Error('StepSnapshot thread does not match ThreadEventStore');
    }
    const receiptContent = {
      version: 1 as const,
      snapshotId: snapshot.stepId,
      threadId: snapshot.threadId,
      turnId: snapshot.turnId,
      stepId: snapshot.stepId,
      snapshotDigest: snapshot.digest,
      toolRouter: snapshot.toolRouter.toReceipt(),
      promptDigest: snapshot.prompt.digest,
      taskContextRevision: snapshot.taskContextRevision,
    };
    const receipt = {
      ...receiptContent,
      digest: digestRuntimeValue(receiptContent),
    };
    this.store.appendDurable({
      turnId: snapshot.turnId,
      stepId: snapshot.stepId,
      payload: {
        type: 'step.snapshot',
        data: {
          snapshotId: snapshot.stepId,
          digest: snapshot.digest,
          receipt: canonicalRuntimeJson(receipt),
        },
      },
    });
  }
}

export function deterministicRuntimeId(parts: readonly string[]): string {
  const hex = createHash('sha256')
    .update(parts.join('\u0000'))
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function createSnapshotToolFacade(descriptor: ToolBindingDescriptorV1): OrionCodeTool {
  return {
    name: descriptor.name,
    aliases: [...descriptor.aliases],
    description: descriptor.description,
    parameters: structuredClone(descriptor.inputSchema),
    execute: async () => {
      throw new Error(`Tool ${descriptor.name} can only execute through ToolGateway`);
    },
    checkPermissions: () => ({ behavior: 'allow' }),
    isConcurrencySafe: () =>
      descriptor.risk.readOnly &&
      descriptor.risk.effect !== 'external_write' &&
      descriptor.risk.network === 'none',
    isReadOnly: () => descriptor.risk.readOnly,
    isDestructive: () => descriptor.risk.destructive,
    isFileEdit: () => descriptor.risk.fileEdit,
  };
}

function createQueryTaskContextAdapter(
  taskContext: TaskContextService,
  onCompletion: (decision: TaskContextCompletionDecisionV1) => void,
  planningPhase = false
): QueryTaskContext {
  return {
    updateCapabilityProfile: input =>
      structuredClone(taskContext.observeCapability(input)) as unknown as ReturnType<
        QueryTaskContext['updateCapabilityProfile']
      >,
    assembleMessages: (messages, options) => taskContext.assembleMessages(messages, options),
    getCapsule: () => {
      const capsule = taskContext.getCapsule();
      return capsule
        ? (structuredClone(capsule) as unknown as ReturnType<QueryTaskContext['getCapsule']>)
        : undefined;
    },
    toJSON: () => taskContext.exportState(),
    recordAssistantResponse: response => taskContext.observeAssistantResponse(response),
    beforeToolUse: input => structuredClone(taskContext.checkToolUse(input)),
    asToolBlockedResult: result => taskContext.toolBlockedResult(result),
    recordToolResult: input => taskContext.observeToolResult(input),
    beforeComplete: () => {
      const decision = taskContext.auditCompletion();
      onCompletion(decision);
      // PLAN completes a planning phase, not the parent implementation task.
      // Persist the unmodified audit for the PlanReceipt, while allowing the
      // query to stop after its decision-complete plan. BUILD/AUTO will enforce
      // the same TaskContext criteria in the following logical turn.
      const queryDecision = planningPhase ? { ...decision, canComplete: true } : decision;
      return structuredClone(queryDecision) as unknown as ReturnType<
        QueryTaskContext['beforeComplete']
      >;
    },
    asCompletionBlockedMessage: result => taskContext.completionBlockedMessage(result),
  };
}

function compactSummary(content: string): string {
  return content.replace(/\s+/gu, ' ').trim().slice(0, 240);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortReason(signal: AbortSignal): string {
  return typeof signal.reason === 'string' ? signal.reason : 'AgentLoop interrupted';
}
