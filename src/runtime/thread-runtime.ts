import { RuntimeEventBufferV1, type RuntimeEventBufferOptionsV1 } from './runtime-event-buffer';
import {
  ThreadAdmissionControllerV1,
  type ThreadAdmissionOptionsV1,
  type ThreadCommandAdmissionV1,
  type ThreadTurnRequestV1,
} from './thread-admission';
import {
  ThreadEventStore,
  type AppendRuntimeEventV1,
  type ThreadEventCommitV1,
} from './thread-event-store';
import {
  createRuntimeId,
  type AgentRuntimeCommandV1,
  type RuntimeEventEnvelopeV1,
} from './protocol/runtime-protocol-v1';
import type { CompactPrepareSourceReceiptV1 } from './compact-transaction';

export interface ThreadCompactCandidateDraftV1 {
  readonly checkpoint: unknown;
  readonly modelVisibleHistory: readonly unknown[];
}

export interface ThreadCompactMaintenanceRequestV1 {
  readonly type: 'compact';
  readonly source: 'automatic' | 'explicit';
  readonly prepare: (
    context: {
      readonly source: CompactPrepareSourceReceiptV1;
      readonly history: readonly unknown[];
      readonly taskContext: unknown;
    },
    signal: AbortSignal
  ) => ThreadCompactCandidateDraftV1 | Promise<ThreadCompactCandidateDraftV1>;
}

export interface ThreadMaintenanceTurnRunnerV1 {
  run(
    request: ThreadCompactMaintenanceRequestV1,
    context: ThreadTurnExecutionContextV1
  ): Promise<ThreadTurnOutcomeV1>;
}

/** Internal, non-model maintenance turn used for durable Goal lifecycle control. */
export interface ThreadGoalControlRequestV1 {
  readonly type: 'goal_control';
  readonly input: string;
  readonly run: (context: ThreadTurnExecutionContextV1) => Promise<ThreadTurnOutcomeV1>;
  readonly onRejected?: (reason: 'deadline_expired' | 'shutdown') => void;
}

export type ThreadTurnOutcomeV1 =
  | {
      readonly status: 'completed';
      readonly outcome?: string;
      /** Internal priority work that starts only after this turn is durably terminal. */
      readonly maintenance?: ThreadCompactMaintenanceRequestV1;
    }
  | { readonly status: 'failed'; readonly error: string }
  | { readonly status: 'interrupted'; readonly reason?: string };

export interface ThreadItemHandleV1 {
  readonly turnId: string;
  readonly stepId: string;
  readonly itemId: string;
}

export interface ThreadTurnExecutionContextV1 {
  readonly threadId: string;
  readonly turnId: string;
  readonly input: string;
  readonly mode: ThreadTurnRequestV1['mode'];
  readonly kind: 'regular' | 'goal' | 'maintenance';
  readonly abortSignal: AbortSignal;
  startItem(input: {
    readonly kind: 'message' | 'reasoning' | 'command' | 'file_change' | 'mcp' | 'plan' | 'compact';
    readonly stepId?: string;
    readonly itemId?: string;
    readonly role?: 'user' | 'assistant' | 'system' | 'tool';
    readonly name?: string;
    readonly inputDigest?: string;
  }): ThreadItemHandleV1;
  emitDelta(
    handle: ThreadItemHandleV1,
    delta: string,
    channel?: 'content' | 'reasoning' | 'output'
  ): void;
  completeItem(
    handle: ThreadItemHandleV1,
    input?: { readonly content?: string; readonly summary?: string; readonly outputDigest?: string }
  ): void;
  failItem(handle: ThreadItemHandleV1, error: string): void;
  onSteer(handler: (input: string, itemId: string) => void | Promise<void>): void;
}

export interface ThreadTurnRunnerV1 {
  run(context: ThreadTurnExecutionContextV1): Promise<ThreadTurnOutcomeV1>;
}

export type ThreadGoalContinuationRequestV1 = ThreadTurnRequestV1 & {
  readonly mode: 'goal';
  readonly kind: 'goal';
};

export interface ThreadDurableTerminalV1 {
  readonly turnId: string;
  readonly input: string;
  readonly mode: ThreadTurnRequestV1['mode'];
  readonly kind: 'regular' | 'goal' | 'maintenance';
  readonly terminal: 'completed' | 'failed' | 'interrupted';
}

export interface ThreadRuntimeOptionsV1 {
  readonly store: ThreadEventStore;
  readonly runner: ThreadTurnRunnerV1;
  readonly maintenanceRunner?: ThreadMaintenanceTurnRunnerV1;
  readonly projectPath?: string;
  readonly admission?: ThreadAdmissionOptionsV1;
  readonly idFactory?: () => string;
  readonly recoverIncomplete?: boolean;
  readonly requireTurnCommit?: boolean;
  /** Observes a durable turn.start boundary; it must not own runtime state. */
  readonly onTurnStarted?: (turn: {
    readonly turnId: string;
    readonly input: string;
    readonly mode: ThreadTurnRequestV1['mode'];
    readonly kind: 'regular' | 'goal' | 'maintenance';
    readonly startedAt: number;
  }) => void;
  /** May release internal Goal work only after the matching terminal event is durable. */
  readonly onTurnDurablyTerminal?: (
    terminal: ThreadDurableTerminalV1
  ) => ThreadGoalContinuationRequestV1 | undefined;
  /** Turn-scoped resources settle before any queued turn can be promoted. */
  readonly onTurnSettled?: (turnId: string) => void | Promise<void>;
}

export class ThreadRuntimeV1 {
  readonly threadId: string;
  private readonly store: ThreadEventStore;
  private readonly runner: ThreadTurnRunnerV1;
  private readonly maintenanceRunner?: ThreadMaintenanceTurnRunnerV1;
  private readonly admission: ThreadAdmissionControllerV1;
  private readonly idFactory: () => string;
  private readonly requireTurnCommit: boolean;
  private readonly onTurnStarted?: ThreadRuntimeOptionsV1['onTurnStarted'];
  private readonly onTurnDurablyTerminal?: ThreadRuntimeOptionsV1['onTurnDurablyTerminal'];
  private readonly onTurnSettled?: ThreadRuntimeOptionsV1['onTurnSettled'];
  private readonly consumers = new Map<string, RuntimeEventBufferV1>();
  private readonly compactMaintenance = new Map<string, ThreadCompactMaintenanceRequestV1>();
  private readonly goalControlTurns = new Map<string, ThreadGoalControlRequestV1>();
  private readonly queuedGoalControls = new Map<string, ThreadGoalControlRequestV1>();
  private activeAbort: AbortController | undefined;
  private activeTurnId: string | undefined;
  private activeRun: Promise<void> | undefined;
  private steerHandler: ((input: string, itemId: string) => void | Promise<void>) | undefined;
  private readonly idleWaiters = new Set<() => void>();
  private readonly unsubscribeStore: () => void;
  private deferredGoalContinuation: ThreadGoalContinuationRequestV1 | undefined;
  private closed = false;

  constructor(options: ThreadRuntimeOptionsV1) {
    this.store = options.store;
    this.threadId = options.store.threadId;
    this.runner = options.runner;
    this.maintenanceRunner = options.maintenanceRunner;
    this.idFactory = options.idFactory ?? createRuntimeId;
    this.requireTurnCommit = options.requireTurnCommit === true;
    this.onTurnStarted = options.onTurnStarted;
    this.onTurnDurablyTerminal = options.onTurnDurablyTerminal;
    this.onTurnSettled = options.onTurnSettled;
    this.admission = new ThreadAdmissionControllerV1({
      ...options.admission,
      idFactory: this.idFactory,
    });
    this.unsubscribeStore = this.store.subscribeCommitted(events => this.publish(events));

    let projection = this.store.loadProjection();
    if (projection.cursor === 0) {
      projection = this.commitAndPublish([
        {
          payload: {
            type: 'thread.started',
            data: options.projectPath ? { projectPath: options.projectPath } : {},
          },
        },
      ]).projection;
    } else if (projection.activeTurnId && options.recoverIncomplete !== false) {
      projection = this.store.recoverIncomplete();
    }

    this.admission.restore({
      queue: projection.queue.map(item => ({
        queueId: item.queueId,
        input: item.input,
        inputBytes: Buffer.byteLength(item.input, 'utf8'),
        mode: item.mode as ThreadTurnRequestV1['mode'],
        kind: item.kind,
        source: item.source,
        enqueuedAt: item.enqueuedAt,
        deadline: item.deadline,
      })),
      queuedBytes: projection.queue.reduce(
        (total, item) => total + Buffer.byteLength(item.input, 'utf8'),
        0
      ),
      continuationMode: latestContinuationMode(projection),
      shutdown: false,
    });
    if (projection.queue.length > 0) {
      queueMicrotask(() => this.promoteQueuedTurn());
    }
  }

  dispatch(
    command: Extract<
      AgentRuntimeCommandV1,
      { type: 'turn.start' | 'turn.steer' | 'turn.follow_up' | 'turn.interrupt' }
    >
  ): ThreadCommandAdmissionV1 {
    if (this.closed) return { status: 'rejected', reason: 'shutdown' };
    const before = this.admission.getSnapshot();
    const result = this.admission.admit(command);
    if (result.status === 'rejected') return result;

    try {
      switch (result.status) {
        case 'started': {
          const active = this.requiredActiveTurn(result.turnId);
          this.persistTurnStart(active);
          this.scheduleTurn(active);
          break;
        }
        case 'queued': {
          const queued = this.admission
            .getSnapshot()
            .queue.find(item => item.queueId === result.queueId);
          if (!queued) throw new Error(`Queued turn ${result.queueId} disappeared before commit`);
          this.commitAndPublish([
            {
              payload: {
                type: 'turn.queued',
                data: {
                  queueId: queued.queueId,
                  input: queued.input,
                  mode: queued.mode,
                  kind: queued.kind,
                  source: queued.source,
                  enqueuedAt: queued.enqueuedAt,
                  deadline: queued.deadline,
                },
              },
            },
          ]);
          break;
        }
        case 'steered': {
          if (command.type !== 'turn.steer') {
            throw new Error('Admission returned steered for a non-steer command');
          }
          const steerInput = command.data.input;
          const stepId = this.idFactory();
          this.commitAndPublish([
            {
              turnId: result.activeTurnId,
              payload: {
                type: 'turn.steered',
                data: { itemId: result.itemId, input: steerInput },
              },
            },
            {
              turnId: result.activeTurnId,
              stepId,
              itemId: result.itemId,
              payload: { type: 'item.started', data: { kind: 'message', role: 'user' } },
            },
            {
              turnId: result.activeTurnId,
              stepId,
              itemId: result.itemId,
              payload: { type: 'item.completed', data: { content: steerInput } },
            },
          ]);
          void Promise.resolve(this.steerHandler?.(steerInput, result.itemId)).catch(
            () => undefined
          );
          break;
        }
        case 'interrupt_requested':
          if (!result.alreadyRequested) {
            const reason = command.type === 'turn.interrupt' ? command.data.reason : undefined;
            this.commitAndPublish([
              {
                turnId: result.activeTurnId,
                payload: {
                  type: 'turn.interrupt_requested',
                  data: { intentId: result.intentId, ...(reason ? { reason } : {}) },
                },
              },
            ]);
            // The durable intent is flushed before AbortSignal is propagated.
            this.activeAbort?.abort(reason ?? 'thread interrupted');
          }
          break;
      }
      return result;
    } catch (error) {
      this.admission.restore(before);
      throw error;
    }
  }

  startMaintenance(input: string): ThreadCommandAdmissionV1 {
    if (this.closed) return { status: 'rejected', reason: 'shutdown' };
    const before = this.admission.getSnapshot();
    const result = this.admission.start({ input, mode: 'maintenance', kind: 'maintenance' });
    try {
      if (result.status === 'started') {
        const active = this.requiredActiveTurn(result.turnId);
        this.persistTurnStart(active);
        this.scheduleTurn(active);
      } else if (result.status === 'queued') {
        this.persistQueuedTurn(result.queueId);
      }
      return result;
    } catch (error) {
      this.admission.restore(before);
      throw error;
    }
  }

  /**
   * Serialize a Goal control mutation through the same bounded admission and
   * durable terminal lane as every other Thread turn. The callback owns no
   * scheduling; it must write its TurnCommit before returning completed.
   */
  startGoalControl(request: ThreadGoalControlRequestV1): ThreadCommandAdmissionV1 {
    if (this.closed) return { status: 'rejected', reason: 'shutdown' };
    const before = this.admission.getSnapshot();
    const result = this.admission.start({
      input: request.input,
      mode: 'maintenance',
      kind: 'maintenance',
    });
    try {
      if (result.status === 'started') {
        this.goalControlTurns.set(result.turnId, request);
        const active = this.requiredActiveTurn(result.turnId);
        this.persistTurnStart(active);
        this.scheduleTurn(active);
      } else if (result.status === 'queued') {
        this.queuedGoalControls.set(result.queueId, request);
        this.persistQueuedTurn(result.queueId);
      }
      return result;
    } catch (error) {
      if (result.status === 'started') this.goalControlTurns.delete(result.turnId);
      if (result.status === 'queued') this.queuedGoalControls.delete(result.queueId);
      this.admission.restore(before);
      throw error;
    }
  }

  /** Start an explicit Compact maintenance transaction only from an idle boundary. */
  startCompactMaintenance(
    request: ThreadCompactMaintenanceRequestV1,
    input = 'compact:explicit'
  ): ThreadCommandAdmissionV1 {
    if (this.closed) return { status: 'rejected', reason: 'shutdown' };
    if (!this.maintenanceRunner) throw new Error('Compact maintenance runner is not configured');
    const snapshot = this.admission.getSnapshot();
    if (snapshot.activeTurn) return { status: 'rejected', reason: 'non_steerable' };
    if (snapshot.queue.length > 0) return { status: 'rejected', reason: 'overloaded' };
    const result = this.admission.start({ input, mode: 'maintenance', kind: 'maintenance' });
    if (result.status !== 'started') return result;
    try {
      this.compactMaintenance.set(result.turnId, request);
      const active = this.requiredActiveTurn(result.turnId);
      this.persistTurnStart(active);
      this.scheduleTurn(active);
      return result;
    } catch (error) {
      this.compactMaintenance.delete(result.turnId);
      this.admission.restore(snapshot);
      throw error;
    }
  }

  subscribe(
    consumerId: string,
    cursor = this.store.getCursor(),
    options: Omit<RuntimeEventBufferOptionsV1, 'initialCursor'> = {}
  ): RuntimeEventBufferV1 {
    if (this.consumers.has(consumerId)) throw new Error(`Consumer already exists: ${consumerId}`);
    const buffer = new RuntimeEventBufferV1(this.threadId, { ...options, initialCursor: cursor });
    this.consumers.set(consumerId, buffer);
    return buffer;
  }

  unsubscribe(consumerId: string): void {
    this.consumers.delete(consumerId);
  }

  /** Observe committed durable facts without acquiring ownership of the Thread lifecycle. */
  observeCommittedEvents(
    listener: (events: readonly RuntimeEventEnvelopeV1[]) => void
  ): () => void {
    if (this.closed) throw new Error('Closed Thread runtime cannot be observed');
    return this.store.subscribeCommitted(listener);
  }

  replay(cursor = 0, limit?: number) {
    return this.store.replay(cursor, limit);
  }

  getProjection() {
    return this.store.loadProjection();
  }

  getAdmissionSnapshot() {
    return this.admission.getSnapshot();
  }

  async waitForIdle(): Promise<void> {
    if (!this.admission.getSnapshot().activeTurn && !this.activeRun) return;
    await new Promise<void>(resolve => this.idleWaiters.add(resolve));
  }

  async waitForTurnTerminal(turnId: string): Promise<'completed' | 'failed' | 'interrupted'> {
    const current = terminalStatus(this.store.loadProjection().turns[turnId]?.status);
    if (current) return current;
    return new Promise(resolve => {
      let settled = false;
      const finish = (status: 'completed' | 'failed' | 'interrupted') => {
        if (settled) return;
        settled = true;
        unsubscribe();
        resolve(status);
      };
      const unsubscribe = this.store.subscribeCommitted(events => {
        for (const event of events) {
          if (event.turnId !== turnId) continue;
          const status = terminalEventStatus(event);
          if (status) finish(status);
        }
      });
      const raced = terminalStatus(this.store.loadProjection().turns[turnId]?.status);
      if (raced) finish(raced);
    });
  }

  close(reason = 'runtime shutdown'): void {
    if (this.closed) return;
    this.closed = true;
    this.deferredGoalContinuation = undefined;
    for (const request of this.queuedGoalControls.values()) request.onRejected?.('shutdown');
    this.goalControlTurns.clear();
    this.queuedGoalControls.clear();
    this.admission.close();
    this.activeAbort?.abort(reason);
    this.consumers.clear();
    this.unsubscribeStore();
  }

  /** Runtime-owned entry for a recovered Goal; public input still uses dispatch(). */
  startGoalContinuation(request: ThreadGoalContinuationRequestV1): ThreadCommandAdmissionV1 {
    if (this.closed) return { status: 'rejected', reason: 'shutdown' };
    if (request.mode !== 'goal' || request.kind !== 'goal') {
      return { status: 'rejected', reason: 'invalid_input' };
    }
    const before = this.admission.getSnapshot();
    const result = this.admission.start(request);
    try {
      if (result.status === 'started') {
        const active = this.requiredActiveTurn(result.turnId);
        this.persistTurnStart(active);
        this.scheduleTurn(active);
      } else if (result.status === 'queued') {
        this.persistQueuedTurn(result.queueId);
      }
      return result;
    } catch (error) {
      this.admission.restore(before);
      throw error;
    }
  }

  private persistTurnStart(
    active: NonNullable<ReturnType<ThreadRuntimeV1['getAdmissionSnapshot']>['activeTurn']>,
    queueId?: string
  ): void {
    const stepId = this.idFactory();
    const itemId = this.idFactory();
    const inputs: AppendRuntimeEventV1[] = [
      {
        turnId: active.turnId,
        payload: {
          type: 'turn.started',
          data: {
            input: active.input,
            mode: active.mode,
            ...(queueId ? { queueId } : {}),
          },
        },
      },
    ];
    if (active.kind !== 'maintenance') {
      inputs.push({
        turnId: active.turnId,
        stepId,
        itemId,
        payload: { type: 'item.started', data: { kind: 'message', role: 'user' } },
      });
      inputs.push({
        turnId: active.turnId,
        stepId,
        itemId,
        payload: { type: 'item.completed', data: { content: active.input } },
      });
    }
    this.commitAndPublish(inputs);
    try {
      this.onTurnStarted?.({
        turnId: active.turnId,
        input: active.input,
        mode: active.mode,
        kind: active.kind,
        startedAt: active.startedAt,
      });
    } catch {
      // Timing is an observation only; a durable turn.start cannot be rolled back.
    }
  }

  private scheduleTurn(
    active: NonNullable<ReturnType<ThreadRuntimeV1['getAdmissionSnapshot']>['activeTurn']>
  ): void {
    if (this.activeRun) throw new Error('ThreadRuntime attempted to schedule a second active run');
    const abortController = new AbortController();
    this.activeAbort = abortController;
    this.activeTurnId = active.turnId;
    const context = this.createExecutionContext(active, abortController.signal);
    const compactRequest = this.compactMaintenance.get(active.turnId);
    const goalControlRequest = this.goalControlTurns.get(active.turnId);
    this.activeRun = Promise.resolve()
      .then(() => {
        if (goalControlRequest) return goalControlRequest.run(context);
        if (compactRequest) {
          if (!this.maintenanceRunner) throw new Error('Compact maintenance runner is missing');
          return this.maintenanceRunner.run(compactRequest, context);
        }
        return this.runner.run(context);
      })
      .then(outcome => this.finalizeTurn(active, normalizeOutcome(outcome, abortController)))
      .catch(error =>
        this.finalizeTurn(active, {
          status: abortController.signal.aborted ? 'interrupted' : 'failed',
          error: error instanceof Error ? error.message : String(error),
        })
      )
      .finally(async () => {
        try {
          await this.onTurnSettled?.(active.turnId);
        } catch {
          // The resource owner remains fail-closed; no lease is handed to the
          // next turn even if teardown diagnostics fail.
        }
        this.activeRun = undefined;
        this.activeAbort = undefined;
        this.activeTurnId = undefined;
        this.steerHandler = undefined;
        this.compactMaintenance.delete(active.turnId);
        this.goalControlTurns.delete(active.turnId);
        const next = this.admission.getSnapshot().activeTurn;
        if (this.closed && next) this.admission.finish(next.turnId);
        else if (next) this.scheduleTurn(next);
        else this.promoteQueuedTurn();
        this.resolveIdleIfNeeded();
      });
  }

  private createExecutionContext(
    active: NonNullable<ReturnType<ThreadRuntimeV1['getAdmissionSnapshot']>['activeTurn']>,
    abortSignal: AbortSignal
  ): ThreadTurnExecutionContextV1 {
    return {
      threadId: this.threadId,
      turnId: active.turnId,
      input: active.input,
      mode: active.mode,
      kind: active.kind,
      abortSignal,
      startItem: input => {
        const handle = {
          turnId: active.turnId,
          stepId: input.stepId ?? this.idFactory(),
          itemId: input.itemId ?? this.idFactory(),
        };
        this.commitAndPublish([
          {
            ...handle,
            payload: {
              type: 'item.started',
              data: {
                kind: input.kind,
                ...(input.role ? { role: input.role } : {}),
                ...(input.name ? { name: input.name } : {}),
                ...(input.inputDigest ? { inputDigest: input.inputDigest } : {}),
              },
            },
          },
        ]);
        return handle;
      },
      emitDelta: (handle, delta, channel = 'content') => {
        const event = this.store.createEphemeral({
          ...handle,
          payload: { type: 'item.delta', data: { delta, channel } },
        });
        this.publish([event]);
      },
      completeItem: (handle, input = {}) => {
        this.commitAndPublish([
          {
            ...handle,
            payload: {
              type: 'item.completed',
              data: {
                ...(input.content === undefined ? {} : { content: input.content }),
                ...(input.summary === undefined ? {} : { summary: input.summary }),
                ...(input.outputDigest === undefined ? {} : { outputDigest: input.outputDigest }),
              },
            },
          },
        ]);
      },
      failItem: (handle, error) => {
        this.commitAndPublish([{ ...handle, payload: { type: 'item.failed', data: { error } } }]);
      },
      onSteer: handler => {
        this.steerHandler = handler;
      },
    };
  }

  private finalizeTurn(
    active: NonNullable<ReturnType<ThreadRuntimeV1['getAdmissionSnapshot']>['activeTurn']>,
    outcome: ThreadTurnOutcomeV1 | { status: 'failed' | 'interrupted'; error: string }
  ): void {
    const turnId = active.turnId;
    const goalControl = this.goalControlTurns.has(turnId);
    let terminalPublished = false;
    try {
      if (this.requireTurnCommit && (active.kind !== 'maintenance' || goalControl)) {
        const committed = this.store.loadProjection().turns[turnId]?.commit;
        if (!committed) throw new Error(`Turn ${turnId} has no durable TurnCommitV1`);
        if (committed.terminal !== outcome.status) {
          throw new Error(
            `Turn ${turnId} outcome ${outcome.status} conflicts with committed ${committed.terminal}`
          );
        }
      }
      if (outcome.status === 'completed') {
        this.commitAndPublish([
          {
            turnId,
            payload: {
              type: 'turn.completed',
              data: outcome.outcome === undefined ? {} : { outcome: outcome.outcome },
            },
          },
        ]);
      } else if (outcome.status === 'failed') {
        this.commitAndPublish([
          {
            turnId,
            payload: { type: 'turn.failed', data: { error: outcome.error } },
          },
        ]);
      } else {
        this.commitAndPublish([
          {
            turnId,
            payload: {
              type: 'turn.interrupted',
              data: (() => {
                const reason = 'error' in outcome ? outcome.error : outcome.reason;
                return reason === undefined ? {} : { reason };
              })(),
            },
          },
        ]);
      }
      terminalPublished = true;
    } catch {
      // A runner that exits with open Items cannot publish a false turn
      // terminal. Recovery marks those Items indeterminate first.
      this.store.recoverIncomplete('turn_finished_with_uncommitted_items');
    }
    const terminal = outcome.status;
    let continuation: ThreadGoalContinuationRequestV1 | undefined;
    if (terminalPublished && !this.closed) {
      try {
        continuation = this.onTurnDurablyTerminal?.({
          turnId,
          input: active.input,
          mode: active.mode,
          kind: active.kind,
          terminal,
        });
      } catch {
        // Goal continuation is fail-closed. The durable terminal remains authoritative.
      }
    }
    if (active.kind !== 'maintenance') this.deferredGoalContinuation = undefined;
    const maintenance =
      terminalPublished && active.kind !== 'maintenance' && outcome.status === 'completed'
        ? outcome.maintenance
        : undefined;
    if (maintenance && continuation) {
      this.deferredGoalContinuation = continuation;
      continuation = undefined;
    } else if (active.kind === 'maintenance' && !goalControl) {
      continuation = terminal === 'completed' ? this.deferredGoalContinuation : undefined;
      this.deferredGoalContinuation = undefined;
    }
    const finish = maintenance
      ? this.admission.finishAndStartPriority(turnId, {
          input: `compact:${maintenance.source}`,
          mode: 'maintenance',
          kind: 'maintenance',
        })
      : this.admission.finish(turnId);
    if (finish.status === 'rejected') throw new Error(`Admission lost active turn ${turnId}`);
    for (const queueId of finish.expiredQueueIds) {
      this.rejectQueuedGoalControl(queueId, 'deadline_expired');
      this.commitAndPublish([{ payload: { type: 'turn.queue_expired', data: { queueId } } }]);
    }
    if (finish.status === 'started') {
      if (maintenance) this.compactMaintenance.set(finish.turnId, maintenance);
      this.promoteQueuedGoalControl(finish.turnId, finish.queueId);
      const active = this.requiredActiveTurn(finish.turnId);
      this.persistTurnStart(active, finish.queueId);
    } else if (finish.status === 'idle' && continuation && !this.closed) {
      const started = this.admission.start(continuation);
      if (started.status !== 'started') {
        throw new Error('Goal continuation could not start from an idle durable boundary');
      }
      const next = this.requiredActiveTurn(started.turnId);
      this.persistTurnStart(next);
    }
  }

  private promoteQueuedTurn(): void {
    if (this.closed || this.activeRun || this.admission.getSnapshot().activeTurn) return;
    const result = this.admission.startNextQueued();
    if (result.status === 'rejected') return;
    for (const queueId of result.expiredQueueIds) {
      this.rejectQueuedGoalControl(queueId, 'deadline_expired');
      this.commitAndPublish([{ payload: { type: 'turn.queue_expired', data: { queueId } } }]);
    }
    if (result.status === 'started') {
      this.promoteQueuedGoalControl(result.turnId, result.queueId);
      const active = this.requiredActiveTurn(result.turnId);
      this.persistTurnStart(active, result.queueId);
      this.scheduleTurn(active);
    }
  }

  private persistQueuedTurn(queueId: string): void {
    const queued = this.admission.getSnapshot().queue.find(item => item.queueId === queueId);
    if (!queued) throw new Error(`Queued maintenance turn ${queueId} disappeared before commit`);
    this.commitAndPublish([
      {
        payload: {
          type: 'turn.queued',
          data: {
            queueId: queued.queueId,
            input: queued.input,
            mode: queued.mode,
            kind: queued.kind,
            source: queued.source,
            enqueuedAt: queued.enqueuedAt,
            deadline: queued.deadline,
          },
        },
      },
    ]);
  }

  private requiredActiveTurn(turnId: string) {
    const active = this.admission.getSnapshot().activeTurn;
    if (!active || active.turnId !== turnId) throw new Error(`Active turn ${turnId} is missing`);
    return active;
  }

  private promoteQueuedGoalControl(turnId: string, queueId?: string): void {
    if (!queueId) return;
    const request = this.queuedGoalControls.get(queueId);
    if (!request) return;
    this.queuedGoalControls.delete(queueId);
    this.goalControlTurns.set(turnId, request);
  }

  private rejectQueuedGoalControl(queueId: string, reason: 'deadline_expired' | 'shutdown'): void {
    const request = this.queuedGoalControls.get(queueId);
    this.queuedGoalControls.delete(queueId);
    request?.onRejected?.(reason);
  }

  private commitAndPublish(inputs: readonly AppendRuntimeEventV1[]): ThreadEventCommitV1 {
    return this.store.appendDurableBatch(inputs);
  }

  private publish(events: readonly RuntimeEventEnvelopeV1[]): void {
    for (const event of events) {
      for (const buffer of this.consumers.values()) buffer.offer(event);
    }
  }

  private resolveIdleIfNeeded(): void {
    if (this.activeRun || this.admission.getSnapshot().activeTurn) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}

function normalizeOutcome(
  outcome: ThreadTurnOutcomeV1,
  abortController: AbortController
): ThreadTurnOutcomeV1 {
  if (abortController.signal.aborted && outcome.status !== 'interrupted') {
    return {
      status: 'interrupted',
      reason:
        typeof abortController.signal.reason === 'string'
          ? abortController.signal.reason
          : 'thread interrupted',
    };
  }
  return outcome;
}

function terminalStatus(
  status: string | undefined
): 'completed' | 'failed' | 'interrupted' | undefined {
  return status === 'completed' || status === 'failed' || status === 'interrupted'
    ? status
    : undefined;
}

function terminalEventStatus(
  event: RuntimeEventEnvelopeV1
): 'completed' | 'failed' | 'interrupted' | undefined {
  switch (event.payload.type) {
    case 'turn.completed':
      return 'completed';
    case 'turn.failed':
      return 'failed';
    case 'turn.interrupted':
      return 'interrupted';
    default:
      return undefined;
  }
}

function latestContinuationMode(
  projection: ReturnType<ThreadEventStore['loadProjection']>
): Exclude<ThreadTurnRequestV1['mode'], 'maintenance'> {
  const mode = Object.values(projection.turns)
    .filter(turn => turn.mode !== 'maintenance')
    .sort((left, right) => left.startedSeq - right.startedSeq)
    .at(-1)?.mode;
  return mode === 'plan' || mode === 'auto' || mode === 'goal' ? mode : 'build';
}
