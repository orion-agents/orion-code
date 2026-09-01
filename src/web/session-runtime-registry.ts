import { randomUUID } from 'crypto';

export interface WebSessionActorKeyV1 {
  readonly workspaceId: string;
  readonly sessionId: string;
}

export type WebSessionActorPhaseV1 =
  | 'cold'
  | 'starting'
  | 'idle'
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'stopping'
  | 'interrupted'
  | 'failed';

export interface WebSessionRuntimeSummaryV1 extends WebSessionActorKeyV1 {
  readonly runtimeRevision: string;
  readonly phase: WebSessionActorPhaseV1;
  readonly queueId?: string;
  readonly queuePosition?: number;
  readonly pendingApprovalCount: number;
  readonly resident: boolean;
  readonly estimatedBytes: number;
  readonly updatedAt: string;
}

export interface WebSessionTurnStartV1<T> {
  /** Synchronous command admission returned to the HTTP caller. */
  readonly accepted: T;
  /** Resolves only after the logical turn, including approval waits, is terminal. */
  readonly settled: Promise<void>;
}

export type WebSessionTurnAdmissionV1<T> =
  | {
      readonly status: 'started';
      readonly accepted: T;
      readonly runtime: WebSessionRuntimeSummaryV1;
    }
  | {
      readonly status: 'queued';
      readonly queueId: string;
      readonly queuePosition: number;
      readonly runtime: WebSessionRuntimeSummaryV1;
    };

export interface WebSessionRuntimeRegistryOptionsV1<TActor extends object> {
  readonly createActor: (key: WebSessionActorKeyV1) => Promise<TActor>;
  /**
   * Finish actor startup only after the registry owns the returned resource.
   * This lets the registry quarantine and retry cleanup when initialization
   * fails instead of losing the only handle to a partially started actor.
   */
  readonly initializeActor?: (actor: TActor, key: WebSessionActorKeyV1) => Promise<void>;
  readonly closeActor: (actor: TActor, reason: string) => Promise<void>;
  readonly estimateActorBytes?: (actor: TActor) => number;
  readonly maxRunningSessions?: number;
  readonly maxResidentSessionActors?: number;
  readonly now?: () => number;
  readonly createRevision?: () => string;
  readonly onSummaryChanged?: (summary: WebSessionRuntimeSummaryV1) => void;
}

interface SessionActorRecord<TActor> {
  readonly key: WebSessionActorKeyV1;
  actor?: TActor;
  phase: WebSessionActorPhaseV1;
  runtimeRevision: string;
  pendingApprovalCount: number;
  estimatedBytes: number;
  updatedAtMs: number;
  lastUsedOrdinal: number;
  activeRun: boolean;
  actorReady: boolean;
  queueId?: string;
  queuePosition?: number;
  failure?: unknown;
}

interface QueuedTurn<TActor> {
  readonly queueId: string;
  readonly record: SessionActorRecord<TActor>;
  readonly start: (actor: TActor) => Promise<WebSessionTurnStartV1<unknown>>;
}

const DEFAULT_MAX_RUNNING_SESSIONS = 3;
const DEFAULT_MAX_RESIDENT_SESSION_ACTORS = 4;

/**
 * Bounded Web-only Session actor pool.
 *
 * It owns concurrency admission and actor lifetime, but deliberately knows
 * nothing about React, HTTP, OrionRuntime, or TUI semantics. Callers provide a
 * Session-scoped actor and a logical-turn terminal promise. This keeps Web
 * parallelism out of the single-session CLI/TUI runner.
 */
export class WebSessionRuntimeRegistryV1<TActor extends object> {
  private readonly records = new Map<string, SessionActorRecord<TActor>>();
  private readonly queue: QueuedTurn<TActor>[] = [];
  private readonly maxRunningSessions: number;
  private readonly maxResidentSessionActors: number;
  private readonly now: () => number;
  private readonly createRevision: () => string;
  private capacityQueue: Promise<void> = Promise.resolve();
  private ordinal = 0;
  private runningCountValue = 0;
  private closed = false;

  constructor(private readonly options: WebSessionRuntimeRegistryOptionsV1<TActor>) {
    this.maxRunningSessions = boundedInteger(
      options.maxRunningSessions,
      DEFAULT_MAX_RUNNING_SESSIONS,
      1,
      8,
      'maxRunningSessions'
    );
    this.maxResidentSessionActors = boundedInteger(
      options.maxResidentSessionActors,
      DEFAULT_MAX_RESIDENT_SESSION_ACTORS,
      1,
      8,
      'maxResidentSessionActors'
    );
    if (this.maxResidentSessionActors < this.maxRunningSessions) {
      throw new Error(
        'maxResidentSessionActors must be greater than or equal to maxRunningSessions.'
      );
    }
    this.now = options.now ?? Date.now;
    this.createRevision = options.createRevision ?? randomUUID;
  }

  get runningCount(): number {
    return this.runningCountValue;
  }

  get residentCount(): number {
    let count = 0;
    for (const record of this.records.values()) if (record.actor !== undefined) count += 1;
    return count;
  }

  summary(key: WebSessionActorKeyV1): WebSessionRuntimeSummaryV1 {
    return this.snapshot(this.record(key));
  }

  summaries(): readonly WebSessionRuntimeSummaryV1[] {
    return Object.freeze(
      [...this.records.values()]
        .sort((left, right) => right.lastUsedOrdinal - left.lastUsedOrdinal)
        .map(record => this.snapshot(record))
    );
  }

  /**
   * Return the current resident actor without starting a cold Session.
   *
   * Snapshot/read paths use this to project live state while preserving the
   * cold-read invariant: merely selecting or inspecting a Session must not
   * allocate a Runtime or consume a running slot.
   */
  residentActor(
    key: WebSessionActorKeyV1
  ): { readonly actor: TActor; readonly runtime: WebSessionRuntimeSummaryV1 } | undefined {
    this.assertOpen();
    const record = this.record(key);
    if (!record.actor || !record.actorReady) return undefined;
    this.touch(record);
    return Object.freeze({ actor: record.actor, runtime: this.snapshot(record) });
  }

  async ensureResident(
    key: WebSessionActorKeyV1,
    expectedRuntimeRevision?: string
  ): Promise<{ readonly actor: TActor; readonly runtime: WebSessionRuntimeSummaryV1 }> {
    return this.withCapacityLock(async () => {
      this.assertOpen();
      const record = this.record(key);
      this.assertRevision(record, expectedRuntimeRevision);
      const actor = await this.ensureResidentLocked(record);
      return Object.freeze({ actor, runtime: this.snapshot(record) });
    });
  }

  async withActor<T>(
    key: WebSessionActorKeyV1,
    expectedRuntimeRevision: string,
    action: (actor: TActor) => T | Promise<T>
  ): Promise<{ readonly result: T; readonly runtime: WebSessionRuntimeSummaryV1 }> {
    return this.withCapacityLock(async () => {
      this.assertOpen();
      const record = this.record(key);
      this.assertRevision(record, expectedRuntimeRevision);
      const actor = await this.ensureResidentLocked(record);
      const result = await action(actor);
      this.touch(record);
      return Object.freeze({ result, runtime: this.snapshot(record) });
    });
  }

  async admitTurn<T>(input: {
    readonly key: WebSessionActorKeyV1;
    readonly expectedRuntimeRevision: string;
    readonly start: (actor: TActor) => Promise<WebSessionTurnStartV1<T>>;
  }): Promise<WebSessionTurnAdmissionV1<T>> {
    return this.withCapacityLock(async () => {
      this.assertOpen();
      const record = this.record(input.key);
      this.assertRevision(record, input.expectedRuntimeRevision);
      if (record.activeRun || record.queueId) {
        throw new WebSessionRuntimeRegistryError(
          409,
          'session_turn_already_active',
          'The Session already has a running or queued logical turn.'
        );
      }

      const actor = await this.ensureResidentLocked(record);
      if (this.runningCountValue >= this.maxRunningSessions) {
        const queueId = this.createRevision();
        record.queueId = queueId;
        this.queue.push({
          queueId,
          record,
          start: input.start as (actor: TActor) => Promise<WebSessionTurnStartV1<unknown>>,
        });
        record.queuePosition = this.queue.length;
        this.transition(record, 'queued');
        this.publishQueuePositions();
        const runtime = this.snapshot(record);
        return Object.freeze({
          status: 'queued' as const,
          queueId,
          queuePosition: runtime.queuePosition as number,
          runtime,
        });
      }

      const started = await this.startTurn(record, actor, input.start);
      return Object.freeze({
        status: 'started' as const,
        accepted: started.accepted,
        runtime: started.runtime,
      });
    });
  }

  cancelQueued(
    key: WebSessionActorKeyV1,
    queueId: string,
    expectedRuntimeRevision: string
  ): WebSessionRuntimeSummaryV1 {
    this.assertOpen();
    const record = this.record(key);
    this.assertRevision(record, expectedRuntimeRevision);
    if (!record.queueId || record.queueId !== queueId) {
      throw new WebSessionRuntimeRegistryError(
        409,
        'session_queue_conflict',
        'The queued turn no longer matches this Session.'
      );
    }
    const index = this.queue.findIndex(item => item.queueId === queueId && item.record === record);
    if (index < 0) {
      throw new WebSessionRuntimeRegistryError(
        409,
        'session_queue_conflict',
        'The queued turn is no longer pending.'
      );
    }
    this.queue.splice(index, 1);
    record.queueId = undefined;
    record.queuePosition = undefined;
    this.transition(record, 'idle');
    this.publishQueuePositions();
    return this.snapshot(record);
  }

  setPendingApprovalCount(key: WebSessionActorKeyV1, count: number): WebSessionRuntimeSummaryV1 {
    this.assertOpen();
    const record = this.record(key);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error('pending approval count must be a non-negative integer.');
    }
    const normalized = count;
    if (record.pendingApprovalCount === normalized) return this.snapshot(record);
    record.pendingApprovalCount = normalized;
    if (record.activeRun) this.transition(record, normalized > 0 ? 'waiting_approval' : 'running');
    else this.bump(record);
    return this.snapshot(record);
  }

  async evict(key: WebSessionActorKeyV1, reason = 'session actor evicted'): Promise<void> {
    this.assertOpen();
    const record = this.record(key);
    await this.withCapacityLock(async () => {
      if (!record.actor) return;
      if (!this.isEvictable(record)) {
        throw new WebSessionRuntimeRegistryError(
          409,
          'session_actor_busy',
          'Running, queued, approval-waiting, or stopping actors cannot be evicted.'
        );
      }
      await this.closeResidentLocked(record, reason, 'cold');
    });
  }

  async shutdown(reason = 'Web Session registry shutdown'): Promise<void> {
    this.closed = true;
    const queued = this.queue.splice(0);
    for (const item of queued) {
      item.record.queueId = undefined;
      item.record.queuePosition = undefined;
      this.transition(item.record, 'interrupted');
    }
    const cleanupErrors: unknown[] = [];
    await this.withCapacityLock(async () => {
      const residents = [...this.records.values()].filter(record => record.actor !== undefined);
      await Promise.all(
        residents.map(async record => {
          const actor = record.actor;
          if (!actor) return;
          const wasActive = record.activeRun;
          if (wasActive) this.runningCountValue = Math.max(0, this.runningCountValue - 1);
          record.activeRun = false;
          record.pendingApprovalCount = 0;
          record.actorReady = false;
          this.transition(record, 'stopping');
          try {
            await this.options.closeActor(actor, reason);
            record.actor = undefined;
            record.estimatedBytes = 0;
            this.transition(record, wasActive ? 'interrupted' : 'cold');
          } catch (error) {
            record.failure = error;
            this.transition(record, 'failed');
            cleanupErrors.push(error);
          }
        })
      );
    });
    if (cleanupErrors.length > 0) {
      throw new WebSessionRuntimeRegistryError(
        503,
        'session_actor_cleanup_failed',
        `${cleanupErrors.length} Session actor(s) could not be closed safely.`
      );
    }
  }

  private record(key: WebSessionActorKeyV1): SessionActorRecord<TActor> {
    const normalized = normalizeKey(key);
    const id = keyId(normalized);
    let record = this.records.get(id);
    if (!record) {
      const now = this.now();
      record = {
        key: normalized,
        phase: 'cold',
        runtimeRevision: this.createRevision(),
        pendingApprovalCount: 0,
        estimatedBytes: 0,
        updatedAtMs: now,
        lastUsedOrdinal: ++this.ordinal,
        activeRun: false,
        actorReady: false,
      };
      this.records.set(id, record);
      this.publish(record);
    }
    return record;
  }

  private async ensureResidentLocked(record: SessionActorRecord<TActor>): Promise<TActor> {
    if (record.actor && record.actorReady) {
      this.touch(record);
      return record.actor;
    }
    if (record.actor) {
      await this.closeResidentLocked(record, 'retry quarantined Session actor cleanup', 'cold');
    }
    await this.makeCapacityLocked(record);
    this.transition(record, 'starting');
    let actor: TActor | undefined;
    try {
      actor = await this.options.createActor(record.key);
      await this.options.initializeActor?.(actor, record.key);
      if (this.closed) {
        throw new WebSessionRuntimeRegistryError(
          503,
          'session_registry_closed',
          'The Web Session registry is closed.'
        );
      }
      record.estimatedBytes = normalizeBytes(this.options.estimateActorBytes?.(actor));
      record.actor = actor;
      record.actorReady = true;
      actor = undefined;
      record.failure = undefined;
      this.transition(record, 'idle');
      return record.actor;
    } catch (error) {
      if (actor) {
        try {
          await this.options.closeActor(actor, 'Session actor start failed');
        } catch (cleanupError) {
          // Preserve the only handle to the partially initialized actor. It is
          // never returned by residentActor/ensureResident and still counts
          // against the resident budget until a later eviction or shutdown
          // successfully closes it.
          record.actor = actor;
          record.actorReady = false;
          record.estimatedBytes = 0;
          record.failure = cleanupError;
          this.transition(record, 'failed');
          throw new WebSessionRuntimeRegistryError(
            503,
            'session_actor_cleanup_failed',
            'A failed Session actor could not be closed safely.'
          );
        }
      }
      record.actor = undefined;
      record.actorReady = false;
      record.estimatedBytes = 0;
      record.failure = error;
      this.transition(record, 'failed');
      throw error;
    }
  }

  private async makeCapacityLocked(target: SessionActorRecord<TActor>): Promise<void> {
    if (this.residentCount < this.maxResidentSessionActors) return;
    const candidate = [...this.records.values()]
      .filter(record => record !== target && record.actor && this.isEvictable(record))
      .sort((left, right) => left.lastUsedOrdinal - right.lastUsedOrdinal)[0];
    if (!candidate) {
      throw new WebSessionRuntimeRegistryError(
        503,
        'session_concurrency_limit',
        'All resident Session actors are busy; the requested Session remains available read-only.'
      );
    }
    await this.closeResidentLocked(candidate, 'idle Session actor evicted by LRU', 'cold');
  }

  private isEvictable(record: SessionActorRecord<TActor>): boolean {
    return (
      Boolean(record.actor) &&
      !record.activeRun &&
      !record.queueId &&
      record.pendingApprovalCount === 0 &&
      ['idle', 'failed', 'interrupted'].includes(record.phase)
    );
  }

  private async closeResidentLocked(
    record: SessionActorRecord<TActor>,
    reason: string,
    terminalPhase: WebSessionActorPhaseV1
  ): Promise<void> {
    const actor = record.actor;
    if (!actor) return;
    record.actorReady = false;
    this.transition(record, 'stopping');
    try {
      await this.options.closeActor(actor, reason);
      record.actor = undefined;
      record.estimatedBytes = 0;
      this.transition(record, terminalPhase);
    } catch (error) {
      record.failure = error;
      this.transition(record, 'failed');
      throw error;
    }
  }

  private async startTurn<T>(
    record: SessionActorRecord<TActor>,
    actor: TActor,
    start: (actor: TActor) => Promise<WebSessionTurnStartV1<T>>
  ): Promise<{ readonly accepted: T; readonly runtime: WebSessionRuntimeSummaryV1 }> {
    record.activeRun = true;
    record.queueId = undefined;
    record.pendingApprovalCount = 0;
    this.runningCountValue += 1;
    this.transition(record, 'running');
    try {
      const started = await start(actor);
      void Promise.resolve(started.settled).then(
        () => this.finishTurn(record),
        error => this.finishTurn(record, error)
      );
      return Object.freeze({ accepted: started.accepted, runtime: this.snapshot(record) });
    } catch (error) {
      this.finishTurn(record, error);
      throw error;
    }
  }

  private finishTurn(record: SessionActorRecord<TActor>, error?: unknown): void {
    if (!record.activeRun) return;
    record.activeRun = false;
    record.pendingApprovalCount = 0;
    this.runningCountValue = Math.max(0, this.runningCountValue - 1);
    if (error) {
      record.failure = error;
      this.transition(record, 'failed');
    } else {
      record.failure = undefined;
      this.transition(record, 'idle');
    }
    this.drainQueue();
  }

  private drainQueue(): void {
    while (!this.closed && this.runningCountValue < this.maxRunningSessions && this.queue.length) {
      const item = this.queue.shift() as QueuedTurn<TActor>;
      item.record.queueId = undefined;
      item.record.queuePosition = undefined;
      const actor = item.record.actor;
      if (!actor) {
        item.record.failure = new Error('Queued Session actor is no longer resident.');
        this.transition(item.record, 'failed');
        continue;
      }
      void this.startTurn(item.record, actor, item.start).catch(() => undefined);
    }
    this.publishQueuePositions();
  }

  private publishQueuePositions(): void {
    for (const [index, item] of this.queue.entries()) {
      const queuePosition = index + 1;
      if (item.record.queuePosition === queuePosition) continue;
      item.record.queuePosition = queuePosition;
      this.bump(item.record);
    }
  }

  private snapshot(record: SessionActorRecord<TActor>): WebSessionRuntimeSummaryV1 {
    return Object.freeze({
      ...record.key,
      runtimeRevision: record.runtimeRevision,
      phase: record.phase,
      ...(record.queueId ? { queueId: record.queueId } : {}),
      ...(record.queueId && record.queuePosition ? { queuePosition: record.queuePosition } : {}),
      pendingApprovalCount: record.pendingApprovalCount,
      resident: record.actor !== undefined,
      estimatedBytes: record.estimatedBytes,
      updatedAt: new Date(record.updatedAtMs).toISOString(),
    });
  }

  private assertRevision(
    record: SessionActorRecord<TActor>,
    expectedRuntimeRevision?: string
  ): void {
    if (expectedRuntimeRevision === undefined) return;
    if (expectedRuntimeRevision !== record.runtimeRevision) {
      throw new WebSessionRuntimeRegistryError(
        409,
        'session_runtime_revision_conflict',
        'The Session Runtime changed before the operation was admitted.'
      );
    }
  }

  private transition(record: SessionActorRecord<TActor>, phase: WebSessionActorPhaseV1): void {
    record.phase = phase;
    this.bump(record);
  }

  private touch(record: SessionActorRecord<TActor>): void {
    record.lastUsedOrdinal = ++this.ordinal;
    record.updatedAtMs = this.now();
  }

  private bump(record: SessionActorRecord<TActor>): void {
    record.runtimeRevision = this.createRevision();
    this.touch(record);
    this.publish(record);
  }

  private publish(record: SessionActorRecord<TActor>): void {
    this.options.onSummaryChanged?.(this.snapshot(record));
  }

  private withCapacityLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.capacityQueue.then(operation, operation);
    this.capacityQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new WebSessionRuntimeRegistryError(
        503,
        'session_registry_closed',
        'The Web Session registry is closed.'
      );
    }
  }
}

export class WebSessionRuntimeRegistryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'WebSessionRuntimeRegistryError';
  }
}

function normalizeKey(key: WebSessionActorKeyV1): WebSessionActorKeyV1 {
  const workspaceId = key.workspaceId.trim();
  const sessionId = key.sessionId.trim();
  if (!workspaceId || !sessionId) throw new Error('Session actor identity must not be empty.');
  return Object.freeze({ workspaceId, sessionId });
}

function keyId(key: WebSessionActorKeyV1): string {
  return `${key.workspaceId}\u0000${key.sessionId}`;
}

function normalizeBytes(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : 0;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return candidate;
}
