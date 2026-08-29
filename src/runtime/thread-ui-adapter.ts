import type { AgentRuntimeRunnerV1, AgentRuntimeRunInputOptionsV1 } from './agent-runtime-runner';
import {
  createAgentRuntimeEventSinkFromUiEvents,
  type AgentRuntimeEvent,
  type AgentRuntimeEventSink,
} from './agent-runtime-protocol';
import type { AgentTurnRequest } from './goals/types';
import type { RuntimeGoalSnapshot } from './goals/types';
import {
  readGoalRuntimePersistenceV2,
  type GoalRuntimePersistenceViewV2,
} from './goal-runtime-coordinator';
import { createRuntimeId, type RuntimeEventEnvelopeV1 } from './protocol/runtime-protocol-v1';
import type { RuntimeEventBufferOptionsV1, RuntimeEventBufferV1 } from './runtime-event-buffer';
import type { ThreadCommandAdmissionV1, ThreadTurnRequestV1 } from './thread-admission';
import { ThreadRuntimeV1 } from './thread-runtime';
import type { ToolInvocationReceiptV1 } from './tool-gateway';
import {
  DurableToolReceiptValidationError,
  validateDurableToolInvocationReceiptV1,
} from './tool-receipt-validator';
import { parseTurnCommitV1 } from './turn-commit';
import type {
  ToolAuthorizationView,
  TranscriptAppendEntry,
  TranscriptRole,
  UiEventSink,
} from './ui-events';

export const THREAD_UI_ADAPTER_VERSION = 1 as const;

export type ThreadUiBaseModeV1 = Extract<ThreadTurnRequestV1['mode'], 'build' | 'plan' | 'auto'>;

export interface ThreadUiModeContextV1 {
  readonly input: string;
  readonly inputKind?: AgentTurnRequest['inputKind'];
  readonly request?: AgentTurnRequest;
}

export type ThreadUiModeResolverV1 =
  | ThreadUiBaseModeV1
  | ((context: ThreadUiModeContextV1) => ThreadUiBaseModeV1);

export interface ThreadUiAdapterOptionsV1 {
  readonly runtime: ThreadRuntimeV1;
  /** Renderer-neutral protocol sink. Exactly one sink form is required. */
  readonly eventSink?: AgentRuntimeEventSink;
  /** Existing UI sink, adapted through the shared runtime event protocol. */
  readonly uiEventSink?: UiEventSink;
  readonly consumerId?: string;
  /** Last durable event already consumed by this UI. Defaults to the current cursor. */
  readonly cursor?: number;
  readonly buffer?: Omit<RuntimeEventBufferOptionsV1, 'initialCursor'>;
  readonly mode?: ThreadUiModeResolverV1;
}

export interface ThreadUiAdapterSnapshotV1 {
  readonly version: 1;
  readonly threadId: string;
  readonly consumerId: string;
  readonly cursor: number;
  readonly closed: boolean;
}

interface ItemPresentation {
  readonly itemId: string;
  readonly kind: ItemKind;
  readonly role?: 'user' | 'assistant' | 'system' | 'tool';
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly sequence: number;
  readonly startedAt: number;
  transcriptId?: string;
  content: string;
}

type ItemKind = 'message' | 'reasoning' | 'command' | 'file_change' | 'mcp' | 'plan' | 'compact';

type ThreadUiDispatchModeV1 = Exclude<ThreadTurnRequestV1['mode'], 'maintenance'>;

/**
 * Transitional projection from the durable Thread runtime to existing UI
 * contracts. ThreadRuntime remains the sole owner of turn/item state; this
 * adapter keeps only an acknowledged delivery cursor and event-derived handles
 * needed for incremental transcript/tool updates.
 */
export class ThreadUiAdapterV1 implements AgentRuntimeRunnerV1 {
  readonly version = THREAD_UI_ADAPTER_VERSION;
  readonly consumerId: string;

  private readonly runtime: ThreadRuntimeV1;
  private readonly sink: AgentRuntimeEventSink;
  private readonly consumer: RuntimeEventBufferV1;
  private readonly mode: ThreadUiModeResolverV1;
  private readonly initialReplayTarget: number;
  private readonly presentations = new Map<string, ItemPresentation>();
  private readonly toolReceiptFacts = new Map<string, RuntimeEventEnvelopeV1>();
  private cursorValue: number;
  private initialReplayComplete = false;
  private closed = false;

  constructor(options: ThreadUiAdapterOptionsV1) {
    if (Boolean(options.eventSink) === Boolean(options.uiEventSink)) {
      throw new ThreadUiAdapterError(
        'Exactly one AgentRuntimeEventSink or UiEventSink is required.'
      );
    }
    this.runtime = options.runtime;
    this.sink =
      options.eventSink ??
      createAgentRuntimeEventSinkFromUiEvents(options.uiEventSink as UiEventSink);
    this.mode = options.mode ?? 'build';
    this.consumerId = options.consumerId?.trim() || `thread-ui-adapter:${createRuntimeId()}`;

    const liveCursor = this.runtime.getProjection().cursor;
    const cursor = options.cursor ?? liveCursor;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > liveCursor) {
      throw new ThreadUiAdapterError(
        `UI cursor ${cursor} is outside the durable Thread cursor 0..${liveCursor}.`
      );
    }
    this.cursorValue = cursor;
    this.initialReplayTarget = liveCursor;
    // Subscribe at the current edge first. Historical replay is projected
    // separately, so commits that arrive after construction cannot be missed.
    this.consumer = this.runtime.subscribe(this.consumerId, liveCursor, options.buffer);
    if (cursor === liveCursor) this.projectLatestGoalState();
  }

  async runInput(input: string, options: AgentRuntimeRunInputOptionsV1 = {}): Promise<void> {
    const text = input.trim();
    if (!text) return;
    await this.runTurn(
      text,
      this.resolveMode({ input: text, inputKind: options.inputKind }),
      options
    );
  }

  async runRequest(
    request: AgentTurnRequest,
    options: AgentRuntimeRunInputOptionsV1 = {}
  ): Promise<void> {
    const input =
      request.text?.trim() ||
      'Continue pursuing the active goal from its persisted plan and evidence.';
    const mode = request.goal
      ? 'goal'
      : this.resolveMode({ input, inputKind: request.inputKind, request });
    await this.runTurn(input, mode, options);
  }

  /** Deliver all available events, replaying durable facts on slow-consumer overflow. */
  flush(): ThreadUiAdapterSnapshotV1 {
    this.assertOpen();
    if (!this.initialReplayComplete) {
      this.replayInitialHistory();
      this.initialReplayComplete = true;
    }

    while (true) {
      const delivery = this.consumer.read();
      if (delivery.status === 'replay_required') {
        this.replayRequired(delivery.cursor);
        continue;
      }
      if (delivery.events.length === 0) break;
      for (const event of delivery.events) {
        this.project(event);
        if (event.durability === 'durable') this.cursorValue = event.seq;
        this.consumer.acknowledgeThrough(this.cursorValue);
      }
    }
    return this.snapshot();
  }

  /** AgentRuntimeRunner cannot express interrupt, so the concrete adapter exposes this narrow port. */
  interrupt(reason = 'user interrupted'): ThreadCommandAdmissionV1 {
    if (this.closed) return { status: 'rejected', reason: 'shutdown' };
    return this.runtime.dispatch({
      type: 'turn.interrupt',
      data: reason.trim() ? { reason: reason.trim() } : {},
    });
  }

  close(reason = 'thread UI adapter closed'): void {
    if (this.closed) return;
    this.closed = true;
    this.runtime.unsubscribe(this.consumerId);
    this.runtime.close(reason);
    this.presentations.clear();
    this.toolReceiptFacts.clear();
  }

  snapshot(): ThreadUiAdapterSnapshotV1 {
    return Object.freeze({
      version: THREAD_UI_ADAPTER_VERSION,
      threadId: this.runtime.threadId,
      consumerId: this.consumerId,
      cursor: this.cursorValue,
      closed: this.closed,
    });
  }

  private async runTurn(
    input: string,
    mode: ThreadUiDispatchModeV1,
    options: AgentRuntimeRunInputOptionsV1
  ): Promise<void> {
    this.assertOpen();
    throwIfAborted(options.abortSignal);
    const admission = this.runtime.dispatch({ type: 'turn.start', data: { input, mode } });
    if (admission.status === 'rejected') {
      throw new ThreadUiAdmissionError(admission.reason);
    }
    if (admission.status !== 'started' && admission.status !== 'queued') {
      throw new ThreadUiAdapterError(`Unexpected turn.start admission: ${admission.status}`);
    }

    const detachAbort = forwardAbort(options.abortSignal, reason => this.interrupt(reason));
    try {
      await this.waitForIdleAndFlush();
    } finally {
      detachAbort();
    }
  }

  private async waitForIdleAndFlush(): Promise<void> {
    let idle = false;
    const idlePromise = this.runtime.waitForIdle().finally(() => {
      idle = true;
    });
    while (!idle) {
      if (!this.closed) this.flush();
      await Promise.race([idlePromise, nextDrainTick()]);
    }
    await idlePromise;
    if (!this.closed) this.flush();
  }

  private replayInitialHistory(): void {
    while (this.cursorValue < this.initialReplayTarget) {
      const replay = this.runtime.replay(this.cursorValue);
      const events = replay.events.filter(event => event.seq <= this.initialReplayTarget);
      if (events.length === 0) {
        throw new ThreadUiAdapterError(
          `Thread replay stalled at cursor ${this.cursorValue} before ${this.initialReplayTarget}.`
        );
      }
      for (const event of events) {
        this.project(event);
        this.cursorValue = event.seq;
      }
    }
  }

  private replayRequired(fromCursor: number): void {
    if (fromCursor !== this.cursorValue) {
      throw new ThreadUiAdapterError(
        `Replay cursor ${fromCursor} differs from projected cursor ${this.cursorValue}.`
      );
    }
    while (true) {
      const replay = this.runtime.replay(this.cursorValue);
      for (const event of replay.events) {
        this.project(event);
        this.cursorValue = event.seq;
      }
      const required = this.consumer.getSnapshot().replayRequired;
      if (!replay.hasMore && (!required || this.cursorValue >= required.latestAvailableCursor)) {
        break;
      }
      if (replay.events.length === 0) {
        throw new ThreadUiAdapterError(
          `Required Thread replay stalled at cursor ${this.cursorValue}.`
        );
      }
    }
    this.consumer.resetAfterReplay(this.cursorValue);
  }

  private project(event: RuntimeEventEnvelopeV1): void {
    switch (event.payload.type) {
      case 'turn.started':
        this.emit({ type: 'processing_changed', processing: true });
        this.emit({
          type: 'status_changed',
          message: `Running · ${event.payload.data.mode.toUpperCase()}`,
        });
        return;
      case 'turn.queued':
        this.emit({
          type: 'status_changed',
          message: `Queued follow-up ${event.payload.data.queueId}.`,
        });
        return;
      case 'turn.queue_expired':
        this.emit({
          type: 'status_changed',
          message: `Queued follow-up ${event.payload.data.queueId} expired.`,
        });
        return;
      case 'turn.steered':
        this.emit({ type: 'status_changed', message: 'Updated the active turn instruction.' });
        return;
      case 'turn.interrupt_requested':
        this.emit({ type: 'status_changed', message: 'Interrupt requested…' });
        return;
      case 'turn.completed':
        this.emit({ type: 'processing_changed', processing: false });
        this.emit({
          type: 'status_changed',
          message: event.payload.data.outcome?.trim() || 'Ready',
        });
        this.projectCompletedPlanMode(event);
        return;
      case 'turn.failed':
        this.emit({
          type: 'transcript_append',
          entry: {
            role: 'error',
            title: 'turn failed',
            content: event.payload.data.error,
            errorLayer: 'runtime',
          },
        });
        this.emit({ type: 'processing_changed', processing: false });
        this.emit({ type: 'status_changed', message: 'Turn failed.' });
        return;
      case 'turn.interrupted':
        this.emit({ type: 'processing_changed', processing: false });
        this.emit({
          type: 'status_changed',
          message: event.payload.data.reason?.trim() || 'Turn interrupted.',
        });
        return;
      case 'item.started':
        this.startItem(event);
        return;
      case 'item.delta':
        this.updateItem(event);
        return;
      case 'item.completed':
      case 'item.failed':
      case 'item.interrupted':
      case 'item.indeterminate':
        this.finishItem(event);
        return;
      case 'compact.started':
        this.emit({ type: 'status_changed', message: 'Compacting context…' });
        return;
      case 'compact.completed':
        this.emit({ type: 'status_changed', message: 'Context compacted.' });
        return;
      case 'compact.failed':
        this.emit({
          type: 'transcript_append',
          entry: {
            role: 'error',
            title: 'compact',
            content: event.payload.data.error,
            errorLayer: 'runtime',
          },
        });
        return;
      case 'approval.requested':
        this.emit({
          type: 'status_changed',
          message: `Approval required for ${event.payload.data.toolName}.`,
        });
        return;
      case 'thread.started':
      case 'thread.resumed':
      case 'thread.forked':
      case 'step.snapshot':
      case 'capability.receipt':
        return;
      case 'tool.receipt':
        this.rememberToolReceipt(event);
        return;
      case 'turn.committed':
        this.projectGoalCommit(event.payload.data.receipt);
        return;
    }
  }

  private projectLatestGoalState(): void {
    const latest = Object.values(this.runtime.getProjection().turns)
      .flatMap(turn => (turn.commit ? [turn.commit] : []))
      .sort((left, right) => right.seq - left.seq)[0];
    if (latest) this.projectGoalCommit(latest.receipt);
  }

  private projectGoalCommit(receipt: string): void {
    const persistence = readGoalRuntimePersistenceV2(parseTurnCommitV1(receipt));
    if (persistence.state?.status === 'completed') {
      this.emit({
        type: 'goal_event',
        event: {
          type: 'goal_cleared',
          goalId: persistence.state.goalId,
          reason: 'completion_auto_exit',
        },
      });
      return;
    }
    if (persistence.state) {
      this.emit({
        type: 'goal_event',
        event: {
          type: 'goal_updated',
          goal: goalUiSnapshot(persistence.state),
          reason: 'durable_turn_commit',
        },
      });
      return;
    }
    if (persistence.tombstone) {
      this.emit({
        type: 'goal_event',
        event: {
          type: 'goal_cleared',
          goalId: persistence.tombstone.goalId ?? 'cleared-goal',
          reason: persistence.tombstone.reason,
        },
      });
    }
  }

  private startItem(event: RuntimeEventEnvelopeV1): ItemPresentation {
    if (event.payload.type !== 'item.started' || !event.itemId) {
      throw new ThreadUiAdapterError('item.started is missing its item identity.');
    }
    const existing = this.presentations.get(event.itemId);
    if (existing) return existing;
    const data = event.payload.data;
    const presentation: ItemPresentation = {
      itemId: event.itemId,
      kind: data.kind,
      role: data.role,
      name: data.name?.trim() || defaultItemName(data.kind),
      args: data.inputDigest ? { inputDigest: data.inputDigest } : {},
      sequence: event.seq,
      startedAt: event.timestamp,
      content: '',
    };

    if (isToolItem(presentation.kind)) {
      this.emit({
        type: 'tool_started',
        event: {
          callId: presentation.itemId,
          name: presentation.name,
          args: presentation.args,
          sequence: presentation.sequence,
        },
      });
    } else {
      const id = this.emit({
        type: 'transcript_append',
        entry: transcriptEntry(presentation, '', true),
      });
      presentation.transcriptId = typeof id === 'string' && id.trim() ? id : presentation.itemId;
    }
    this.presentations.set(presentation.itemId, presentation);
    return presentation;
  }

  private updateItem(event: RuntimeEventEnvelopeV1): void {
    if (event.payload.type !== 'item.delta') return;
    const presentation = this.ensurePresentation(event);
    presentation.content += event.payload.data.delta;
    if (!isToolItem(presentation.kind) && presentation.transcriptId) {
      this.emit({
        type: 'transcript_update',
        id: presentation.transcriptId,
        patch: { content: presentation.content },
      });
    }
  }

  private finishItem(event: RuntimeEventEnvelopeV1): void {
    const presentation = this.ensurePresentation(event);
    const terminal = terminalItemData(event);
    if (terminal.content !== undefined) presentation.content = terminal.content;
    if (!presentation.content && terminal.summary) presentation.content = terminal.summary;

    if (isToolItem(presentation.kind)) {
      const durableReceiptFact = this.toolReceiptFacts.get(presentation.itemId);
      let receipt: ToolInvocationReceiptV1 | undefined;
      if (terminal.receipt && durableReceiptFact) {
        try {
          receipt = validateDurableToolInvocationReceiptV1({
            terminalEvent: event,
            factEvent: durableReceiptFact,
            item: { itemId: presentation.itemId, toolName: presentation.name },
          });
        } catch (error) {
          if (error instanceof DurableToolReceiptValidationError) {
            throw new ThreadUiAdapterError(error.message);
          }
          throw error;
        }
      }
      this.toolReceiptFacts.delete(presentation.itemId);
      const success = receipt?.success ?? event.payload.type === 'item.completed';
      this.emit({
        type: 'tool_finished',
        event: {
          callId: presentation.itemId,
          name: presentation.name,
          args: presentation.args,
          success,
          duration: Math.max(0, event.timestamp - presentation.startedAt),
          sequence: presentation.sequence,
          ...(terminal.summary ? { summary: terminal.summary } : {}),
          ...(terminal.error ? { error: terminal.error } : {}),
          ...(presentation.content
            ? { outputBytes: Buffer.byteLength(presentation.content, 'utf8') }
            : {}),
          ...(receipt
            ? {
                authorization: projectToolAuthorization(receipt),
                executionPolicyDigest: receipt.executionPolicyDigest,
                receiptDigest: receipt.digest,
              }
            : {}),
        },
      });
    } else if (presentation.transcriptId) {
      const success = event.payload.type === 'item.completed';
      this.emit({
        type: 'transcript_finalize',
        id: presentation.transcriptId,
        patch: {
          content: success ? presentation.content : terminal.error || presentation.content,
          ...(success ? {} : { errorLayer: 'runtime' as const }),
        },
      });
    }
    this.presentations.delete(presentation.itemId);
  }

  private rememberToolReceipt(event: RuntimeEventEnvelopeV1): void {
    if (event.payload.type !== 'tool.receipt') return;
    const fact = event.payload.data;
    if (event.itemId && event.itemId !== fact.invocationId) {
      throw new ThreadUiAdapterError('Durable tool receipt identity does not match its Item.');
    }
    this.toolReceiptFacts.set(fact.invocationId, event);
  }

  private ensurePresentation(event: RuntimeEventEnvelopeV1): ItemPresentation {
    if (!event.itemId) throw new ThreadUiAdapterError(`${event.payload.type} has no itemId.`);
    const existing = this.presentations.get(event.itemId);
    if (existing) return existing;
    const projected = this.runtime.getProjection().items[event.itemId];
    if (!projected) {
      throw new ThreadUiAdapterError(`Thread projection has no item ${event.itemId}.`);
    }
    return this.startItem({
      ...event,
      durability: 'durable',
      seq: projected.startedSeq,
      timestamp: event.timestamp,
      payload: {
        type: 'item.started',
        data: {
          kind: projected.kind as ItemKind,
          ...(isItemRole(projected.role) ? { role: projected.role } : {}),
          ...(projected.name ? { name: projected.name } : {}),
          ...(projected.inputDigest ? { inputDigest: projected.inputDigest } : {}),
        },
      },
    });
  }

  private resolveMode(context: ThreadUiModeContextV1): ThreadUiBaseModeV1 {
    const mode = typeof this.mode === 'function' ? this.mode(context) : this.mode;
    if (mode !== 'build' && mode !== 'plan' && mode !== 'auto') {
      throw new ThreadUiAdapterError(`Unsupported UI base mode: ${String(mode)}`);
    }
    return mode;
  }

  private projectCompletedPlanMode(event: RuntimeEventEnvelopeV1): void {
    if (!event.turnId) return;
    const turn = this.runtime.getProjection().turns[event.turnId];
    if (!turn || turn.mode !== 'plan') return;
    const mode = this.resolveMode({ input: turn.input });
    this.emit({
      type: 'agent_mode_changed',
      snapshot: {
        baseMode: mode === 'build' ? 'interactive' : mode,
        pendingBaseMode: null,
      },
    });
  }

  private emit(event: AgentRuntimeEvent): string | void {
    return this.sink.emit(event);
  }

  private assertOpen(): void {
    if (this.closed) throw new ThreadUiAdapterError('Thread UI adapter is closed.');
  }
}

function goalUiSnapshot(
  state: NonNullable<GoalRuntimePersistenceViewV2['state']>
): RuntimeGoalSnapshot {
  return {
    goalId: state.goalId,
    revision: state.generation,
    objective: state.objective,
    status:
      state.status === 'completed'
        ? 'complete'
        : state.status === 'failed'
          ? 'blocked'
          : state.status,
    tokenBudget: state.budget.maxTokens,
    tokensUsed: state.tokensUsed,
    timeUsedMs: state.elapsedMs,
    continuationCount: state.continuationCount,
    updatedAt: state.updatedAt,
    ...(state.lastStopDecision ? { stopReason: state.lastStopDecision.reason.message } : {}),
  };
}

export class ThreadUiAdapterError extends Error {
  readonly code: string = 'ORION_THREAD_UI_ADAPTER_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'ThreadUiAdapterError';
  }
}

export class ThreadUiAdmissionError extends ThreadUiAdapterError {
  override readonly code = 'ORION_THREAD_UI_ADMISSION_REJECTED';

  constructor(readonly reason: string) {
    super(`Thread turn was rejected: ${reason}`);
    this.name = 'ThreadUiAdmissionError';
  }
}

function transcriptEntry(
  presentation: ItemPresentation,
  content: string,
  live: boolean
): TranscriptAppendEntry {
  return {
    role: transcriptRole(presentation),
    title: transcriptTitle(presentation),
    content,
    live,
  };
}

function transcriptRole(presentation: ItemPresentation): TranscriptRole {
  if (presentation.kind !== 'message') {
    return presentation.kind === 'compact' ? 'status' : 'assistant';
  }
  return presentation.role ?? 'assistant';
}

function transcriptTitle(presentation: ItemPresentation): string | undefined {
  switch (presentation.kind) {
    case 'reasoning':
      return 'reasoning';
    case 'plan':
      return 'plan';
    case 'compact':
      return 'compact';
    case 'message':
      return presentation.role === 'user' ? 'you' : undefined;
    default:
      return presentation.name;
  }
}

function isToolItem(kind: ItemKind): boolean {
  return kind === 'command' || kind === 'file_change' || kind === 'mcp';
}

function defaultItemName(kind: ItemKind): string {
  switch (kind) {
    case 'file_change':
      return 'file_change';
    case 'mcp':
      return 'mcp';
    default:
      return kind;
  }
}

function terminalItemData(event: RuntimeEventEnvelopeV1): {
  readonly content?: string;
  readonly summary?: string;
  readonly error?: string;
  readonly receipt?: string;
} {
  switch (event.payload.type) {
    case 'item.completed':
      return {
        content: event.payload.data.content,
        summary: event.payload.data.summary,
        receipt: event.payload.data.receipt,
      };
    case 'item.failed':
      return { error: event.payload.data.error, receipt: event.payload.data.receipt };
    case 'item.interrupted':
      return {
        error: event.payload.data.reason || 'Item interrupted.',
        receipt: event.payload.data.receipt,
      };
    case 'item.indeterminate':
      return { error: event.payload.data.reason, receipt: event.payload.data.receipt };
    default:
      throw new ThreadUiAdapterError(`${event.payload.type} is not an Item terminal event.`);
  }
}

/**
 * Project presentation provenance only after the canonical receipt and its
 * separate durable `tool.receipt` fact have both passed validation.
 */
function projectToolAuthorization(receipt: ToolInvocationReceiptV1): ToolAuthorizationView {
  const policy = receipt.policy;
  const approval = receipt.approval;
  if (!policy) {
    return {
      approved: false,
      behavior: 'deny',
      source: 'tool_policy',
      reason:
        receipt.result.error ??
        `Tool invocation stopped during the ${receipt.terminalPhase} authorization phase.`,
    };
  }
  return {
    behavior: policy.behavior,
    approved:
      policy.behavior === 'allow' || (policy.behavior === 'ask' && approval?.approved === true),
    source: normalizeToolAuthorizationSource(
      policy.behavior,
      policy.source,
      approval?.source,
      approval?.approved
    ),
    ...(approval?.reason || policy.reason ? { reason: approval?.reason ?? policy.reason } : {}),
  };
}

function normalizeToolAuthorizationSource(
  behavior: NonNullable<ToolAuthorizationView['behavior']>,
  policySource: string,
  approvalSource?: string,
  approvalApproved?: boolean
): ToolAuthorizationView['source'] {
  if (approvalSource === 'user') return 'user';
  if (approvalSource === 'authority') return approvalApproved ? 'config_allow' : 'config_deny';
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

function isItemRole(value: string | undefined): value is 'user' | 'assistant' | 'system' | 'tool' {
  return value === 'user' || value === 'assistant' || value === 'system' || value === 'tool';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Thread UI run was aborted.');
}

function forwardAbort(
  signal: AbortSignal | undefined,
  interrupt: (reason: string) => void
): () => void {
  if (!signal) return () => undefined;
  const onAbort = (): void => {
    const reason = signal.reason;
    interrupt(reason instanceof Error ? reason.message : String(reason || 'user interrupted'));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  return () => signal.removeEventListener('abort', onAbort);
}

function nextDrainTick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 16));
}
