import {
  createRuntimeId,
  isRuntimeId,
  type AgentRuntimeCommandV1,
} from './protocol/runtime-protocol-v1';

export type ThreadTurnKindV1 = 'regular' | 'goal' | 'maintenance';

export interface ThreadTurnRequestV1 {
  readonly input: string;
  readonly mode: 'build' | 'plan' | 'auto' | 'goal' | 'maintenance';
  readonly kind?: ThreadTurnKindV1;
  /** Absolute epoch deadline. The controller also caps it to maxQueueWaitMs. */
  readonly deadline?: number;
}

export interface ActiveThreadTurnV1 {
  readonly turnId: string;
  readonly input: string;
  readonly mode: ThreadTurnRequestV1['mode'];
  readonly kind: ThreadTurnKindV1;
  readonly startedAt: number;
  readonly interruptIntentId?: string;
}

export interface QueuedThreadTurnV1 {
  readonly queueId: string;
  readonly input: string;
  readonly inputBytes: number;
  readonly mode: ThreadTurnRequestV1['mode'];
  readonly kind: ThreadTurnKindV1;
  readonly source: 'start' | 'follow_up';
  readonly enqueuedAt: number;
  readonly deadline: number;
}

export type ThreadAdmissionRejectionReasonV1 =
  | 'overloaded'
  | 'non_steerable'
  | 'shutdown'
  | 'no_active_turn'
  | 'deadline_expired'
  | 'invalid_input'
  | 'turn_mismatch';

export type TurnAdmissionV1 =
  | { readonly status: 'started'; readonly turnId: string }
  | {
      readonly status: 'steered';
      readonly activeTurnId: string;
      readonly itemId: string;
    }
  | {
      readonly status: 'queued';
      readonly queueId: string;
      readonly position: number;
      readonly deadline: number;
    }
  | {
      readonly status: 'rejected';
      readonly reason: ThreadAdmissionRejectionReasonV1;
    };

export type InterruptAdmissionV1 =
  | {
      readonly status: 'interrupt_requested';
      readonly activeTurnId: string;
      readonly intentId: string;
      readonly alreadyRequested: boolean;
    }
  | {
      readonly status: 'rejected';
      readonly reason: Extract<ThreadAdmissionRejectionReasonV1, 'shutdown' | 'no_active_turn'>;
    };

export type ThreadCommandAdmissionV1 = TurnAdmissionV1 | InterruptAdmissionV1;

export type ThreadTurnFinishV1 =
  | {
      readonly status: 'started';
      readonly turnId: string;
      /** Present only when the promoted turn came from the user queue. */
      readonly queueId?: string;
      readonly expiredQueueIds: readonly string[];
    }
  | { readonly status: 'idle'; readonly expiredQueueIds: readonly string[] }
  | {
      readonly status: 'rejected';
      readonly reason: Extract<ThreadAdmissionRejectionReasonV1, 'turn_mismatch'>;
    };

export interface ThreadAdmissionSnapshotV1 {
  readonly activeTurn?: ActiveThreadTurnV1;
  readonly queue: readonly QueuedThreadTurnV1[];
  readonly queuedBytes: number;
  /** Last user-facing mode; internal maintenance never becomes a follow-up mode. */
  readonly continuationMode: Exclude<ThreadTurnRequestV1['mode'], 'maintenance'>;
  readonly shutdown: boolean;
}

export interface ThreadAdmissionOptionsV1 {
  readonly maxQueuedItems?: number;
  readonly maxQueuedBytes?: number;
  readonly maxQueueWaitMs?: number;
  readonly maxInputBytes?: number;
  readonly clock?: () => number;
  readonly idFactory?: () => string;
}

const DEFAULT_MAX_QUEUED_ITEMS = 16;
const DEFAULT_MAX_QUEUED_BYTES = 256 * 1024;
const DEFAULT_MAX_QUEUE_WAIT_MS = 5 * 60 * 1000;

/**
 * The single admission authority for a Thread.
 *
 * It deliberately does not execute or persist turns. Callers must durably
 * record an accepted interrupt intent before propagating AbortSignal, and
 * must durably record a started turn before running it.
 */
export class ThreadAdmissionControllerV1 {
  private readonly maxQueuedItems: number;
  private readonly maxQueuedBytes: number;
  private readonly maxQueueWaitMs: number;
  private readonly maxInputBytes: number;
  private readonly clock: () => number;
  private readonly idFactory: () => string;
  private activeTurn: ActiveThreadTurnV1 | undefined;
  private queue: QueuedThreadTurnV1[] = [];
  private queuedBytes = 0;
  private continuationMode: Exclude<ThreadTurnRequestV1['mode'], 'maintenance'> = 'build';
  private shutdown = false;

  constructor(options: ThreadAdmissionOptionsV1 = {}) {
    this.maxQueuedItems = positiveInteger(
      options.maxQueuedItems ?? DEFAULT_MAX_QUEUED_ITEMS,
      'maxQueuedItems'
    );
    this.maxQueuedBytes = positiveInteger(
      options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES,
      'maxQueuedBytes'
    );
    this.maxQueueWaitMs = positiveInteger(
      options.maxQueueWaitMs ?? DEFAULT_MAX_QUEUE_WAIT_MS,
      'maxQueueWaitMs'
    );
    this.maxInputBytes = positiveInteger(
      options.maxInputBytes ?? this.maxQueuedBytes,
      'maxInputBytes'
    );
    this.clock = options.clock ?? Date.now;
    this.idFactory = options.idFactory ?? createRuntimeId;
  }

  admit(
    command: Extract<
      AgentRuntimeCommandV1,
      { type: 'turn.start' | 'turn.steer' | 'turn.follow_up' | 'turn.interrupt' }
    >
  ): ThreadCommandAdmissionV1 {
    switch (command.type) {
      case 'turn.start':
        return this.start({
          input: command.data.input,
          mode: command.data.mode,
          kind: command.data.mode === 'goal' ? 'goal' : 'regular',
        });
      case 'turn.steer':
        return this.steer(command.data.input);
      case 'turn.follow_up':
        return this.followUp({
          input: command.data.input,
          mode:
            this.activeTurn?.mode && this.activeTurn.mode !== 'maintenance'
              ? this.activeTurn.mode
              : this.continuationMode,
        });
      case 'turn.interrupt':
        return this.interrupt();
    }
  }

  start(request: ThreadTurnRequestV1): TurnAdmissionV1 {
    return this.admitTurn(request, 'start');
  }

  followUp(request: ThreadTurnRequestV1): TurnAdmissionV1 {
    return this.admitTurn(request, 'follow_up');
  }

  steer(input: string): TurnAdmissionV1 {
    if (this.shutdown) return rejected('shutdown');
    if (!this.activeTurn) return rejected('no_active_turn');
    if (this.activeTurn.kind === 'maintenance') return rejected('non_steerable');
    if (!validInput(input, this.maxInputBytes)) return rejected('invalid_input');
    return {
      status: 'steered',
      activeTurnId: this.activeTurn.turnId,
      itemId: this.nextId('steer item'),
    };
  }

  interrupt(): InterruptAdmissionV1 {
    if (this.shutdown) return { status: 'rejected', reason: 'shutdown' };
    if (!this.activeTurn) return { status: 'rejected', reason: 'no_active_turn' };
    if (this.activeTurn.interruptIntentId) {
      return {
        status: 'interrupt_requested',
        activeTurnId: this.activeTurn.turnId,
        intentId: this.activeTurn.interruptIntentId,
        alreadyRequested: true,
      };
    }
    const intentId = this.nextId('interrupt intent');
    this.activeTurn = { ...this.activeTurn, interruptIntentId: intentId };
    return {
      status: 'interrupt_requested',
      activeTurnId: this.activeTurn.turnId,
      intentId,
      alreadyRequested: false,
    };
  }

  finish(turnId: string): ThreadTurnFinishV1 {
    if (!this.activeTurn || this.activeTurn.turnId !== turnId) {
      return { status: 'rejected', reason: 'turn_mismatch' };
    }
    this.activeTurn = undefined;
    return this.startNextQueued();
  }

  /**
   * Finish one active turn and start an internal maintenance turn before the
   * user queue. This is the only priority lane and never accepts user input.
   */
  finishAndStartPriority(
    turnId: string,
    request: ThreadTurnRequestV1 & { readonly kind: 'maintenance'; readonly mode: 'maintenance' }
  ): ThreadTurnFinishV1 {
    if (!this.activeTurn || this.activeTurn.turnId !== turnId) {
      return { status: 'rejected', reason: 'turn_mismatch' };
    }
    const now = this.clock();
    if (!validInput(request.input, this.maxInputBytes)) {
      throw new Error('Priority maintenance input is invalid');
    }
    if (request.deadline !== undefined && !validDeadline(request.deadline, now)) {
      throw new Error('Priority maintenance deadline has expired');
    }
    this.activeTurn = undefined;
    const expiredQueueIds = this.dropExpired(now);
    const active = this.begin(request, now);
    return { status: 'started', turnId: active.turnId, expiredQueueIds };
  }

  startNextQueued(): ThreadTurnFinishV1 {
    if (this.activeTurn) return { status: 'rejected', reason: 'turn_mismatch' };
    const expiredQueueIds = this.dropExpired(this.clock());
    const next = this.queue.shift();
    if (!next) return { status: 'idle', expiredQueueIds };
    this.queuedBytes -= next.inputBytes;
    const started = this.begin(next, this.clock());
    return {
      status: 'started',
      turnId: started.turnId,
      queueId: next.queueId,
      expiredQueueIds,
    };
  }

  close(): readonly string[] {
    this.shutdown = true;
    const queueIds = this.queue.map(item => item.queueId);
    this.queue = [];
    this.queuedBytes = 0;
    return Object.freeze(queueIds);
  }

  getSnapshot(): ThreadAdmissionSnapshotV1 {
    this.dropExpired(this.clock());
    return deepFreeze({
      activeTurn: this.activeTurn ? { ...this.activeTurn } : undefined,
      queue: this.queue.map(item => ({ ...item })),
      queuedBytes: this.queuedBytes,
      continuationMode: this.continuationMode,
      shutdown: this.shutdown,
    });
  }

  /** Restore a previously captured in-memory state when durable admission fails. */
  restore(snapshot: ThreadAdmissionSnapshotV1): void {
    const queuedBytes = snapshot.queue.reduce((total, item) => total + item.inputBytes, 0);
    if (queuedBytes !== snapshot.queuedBytes || queuedBytes > this.maxQueuedBytes) {
      throw new Error('Thread admission snapshot has inconsistent queued byte accounting');
    }
    if (snapshot.queue.length > this.maxQueuedItems) {
      throw new Error('Thread admission snapshot exceeds the queue item limit');
    }
    if (!['build', 'plan', 'auto', 'goal'].includes(snapshot.continuationMode)) {
      throw new Error('Thread admission snapshot has an invalid continuation mode');
    }
    if (snapshot.activeTurn && !isRuntimeId(snapshot.activeTurn.turnId)) {
      throw new Error('Thread admission snapshot has an invalid active turn ID');
    }
    for (const item of snapshot.queue) {
      if (!isRuntimeId(item.queueId) || !validInput(item.input, this.maxInputBytes)) {
        throw new Error('Thread admission snapshot contains an invalid queue item');
      }
    }
    this.activeTurn = snapshot.activeTurn ? { ...snapshot.activeTurn } : undefined;
    this.queue = snapshot.queue.map(item => ({ ...item }));
    this.queuedBytes = queuedBytes;
    this.continuationMode = snapshot.continuationMode;
    this.shutdown = snapshot.shutdown;
  }

  private admitTurn(
    request: ThreadTurnRequestV1,
    source: QueuedThreadTurnV1['source']
  ): TurnAdmissionV1 {
    if (this.shutdown) return rejected('shutdown');
    const now = this.clock();
    this.dropExpired(now);
    const inputBytes = Buffer.byteLength(request.input, 'utf8');
    if (!validInput(request.input, this.maxInputBytes)) return rejected('invalid_input');
    if (request.deadline !== undefined && !validDeadline(request.deadline, now)) {
      return rejected('deadline_expired');
    }
    const kind = request.kind ?? (request.mode === 'maintenance' ? 'maintenance' : 'regular');
    if (!this.activeTurn) {
      const active = this.begin({ ...request, kind }, now);
      return { status: 'started', turnId: active.turnId };
    }

    if (
      this.queue.length >= this.maxQueuedItems ||
      inputBytes > this.maxQueuedBytes ||
      this.queuedBytes + inputBytes > this.maxQueuedBytes
    ) {
      return rejected('overloaded');
    }
    const queueId = this.nextId('queue item');
    const deadline = Math.min(
      request.deadline ?? now + this.maxQueueWaitMs,
      now + this.maxQueueWaitMs
    );
    const queued: QueuedThreadTurnV1 = {
      queueId,
      input: request.input,
      inputBytes,
      mode: request.mode,
      kind,
      source,
      enqueuedAt: now,
      deadline,
    };
    this.queue.push(queued);
    this.queuedBytes += inputBytes;
    return { status: 'queued', queueId, position: this.queue.length, deadline };
  }

  private begin(
    request: Pick<ThreadTurnRequestV1, 'input' | 'mode'> & { readonly kind: ThreadTurnKindV1 },
    now: number
  ): ActiveThreadTurnV1 {
    const active: ActiveThreadTurnV1 = {
      turnId: this.nextId('turn'),
      input: request.input,
      mode: request.mode,
      kind: request.kind,
      startedAt: now,
    };
    if (active.mode !== 'maintenance') this.continuationMode = active.mode;
    this.activeTurn = active;
    return active;
  }

  private dropExpired(now: number): string[] {
    const retained: QueuedThreadTurnV1[] = [];
    const expired: string[] = [];
    let retainedBytes = 0;
    for (const item of this.queue) {
      if (item.deadline <= now) {
        expired.push(item.queueId);
      } else {
        retained.push(item);
        retainedBytes += item.inputBytes;
      }
    }
    this.queue = retained;
    this.queuedBytes = retainedBytes;
    return expired;
  }

  private nextId(subject: string): string {
    const id = this.idFactory();
    if (!isRuntimeId(id)) throw new Error(`${subject} ID factory must return a UUID`);
    return id;
  }
}

function validInput(input: string, maxBytes: number): boolean {
  return input.trim().length > 0 && Buffer.byteLength(input, 'utf8') <= maxBytes;
}

function validDeadline(deadline: number, now: number): boolean {
  return Number.isSafeInteger(deadline) && deadline > now;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function rejected(reason: ThreadAdmissionRejectionReasonV1): TurnAdmissionV1 {
  return { status: 'rejected', reason };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return value;
}
