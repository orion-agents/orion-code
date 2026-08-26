import { randomUUID } from 'crypto';

export type ResourceScopeState = 'active' | 'draining' | 'closed';

export interface ResourceScopeOptions {
  /** Stable diagnostic identity. A UUID is generated when omitted. */
  id?: string;
  /** Total time allowed for lease draining and teardown. */
  deadlineMs?: number;
  /** Closing the parent signal closes this scope. */
  parentSignal?: AbortSignal;
}

export interface ResourceActivationContext {
  readonly scopeId: string;
  readonly resourceId: string;
  readonly epoch: number;
  readonly signal: AbortSignal;
}

export interface ResourceDisposalContext {
  readonly scopeId: string;
  readonly resourceId: string;
  readonly reason: string;
  readonly deadlineAt: number;
  /** Aborted when the teardown deadline expires. */
  readonly signal: AbortSignal;
}

export type ResourceDisposer = (context: ResourceDisposalContext) => void | Promise<void>;

export interface ResourceActivation<T> {
  readonly value: T;
  readonly dispose: ResourceDisposer;
}

export interface ResourceRegistration<T> {
  readonly id: string;
  readonly activate: (
    context: ResourceActivationContext
  ) => ResourceActivation<T> | Promise<ResourceActivation<T>>;
}

export interface ResourceLease {
  readonly id: string;
  readonly label?: string;
  readonly epoch: number;
  readonly released: boolean;
  release(): void;
}

export interface ResourceDisposalError {
  readonly resourceId: string;
  readonly message: string;
}

export interface ResourceScopeCloseOptions {
  readonly reason?: string;
  readonly deadlineMs?: number;
}

export interface ResourceScopeCloseReport {
  readonly scopeId: string;
  readonly reason: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly timedOut: boolean;
  readonly leaseTimedOut: boolean;
  readonly disposed: readonly string[];
  readonly errors: readonly ResourceDisposalError[];
}

interface RegisteredResource {
  readonly id: string;
  readonly dispose: ResourceDisposer;
}

const DEFAULT_CLOSE_DEADLINE_MS = 5_000;

function validateDeadline(deadlineMs: number, label: string): number {
  if (!Number.isFinite(deadlineMs) || deadlineMs < 0) {
    throw new RangeError(`${label} must be a finite, non-negative number.`);
  }
  return deadlineMs;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** Raised when an operation attempts to mutate a scope outside its active lifetime. */
export class ResourceScopeStateError extends Error {
  constructor(
    public readonly scopeId: string,
    public readonly state: ResourceScopeState,
    operation: string
  ) {
    super(`Resource scope ${scopeId} cannot ${operation} while ${state}.`);
    this.name = 'ResourceScopeStateError';
  }
}

/** Raised when an async activation completes after its owning epoch has moved on. */
export class StaleResourceEpochError extends Error {
  constructor(
    public readonly scopeId: string,
    public readonly resourceId: string,
    public readonly expectedEpoch: number,
    public readonly actualEpoch: number
  ) {
    super(
      `Resource ${resourceId} completed in stale epoch ${expectedEpoch}; ` +
        `scope ${scopeId} is at epoch ${actualEpoch}.`
    );
    this.name = 'StaleResourceEpochError';
  }
}

/** Activation failures include the deterministic rollback report. */
export class ResourceActivationError extends Error {
  constructor(
    public readonly scopeId: string,
    public readonly resourceId: string,
    public readonly activationCause: unknown,
    public readonly rollback: ResourceScopeCloseReport
  ) {
    super(`Failed to activate resource ${resourceId}: ${errorMessage(activationCause)}`);
    this.name = 'ResourceActivationError';
  }
}

/**
 * Owns cancellable runtime resources for one bounded lifetime.
 *
 * Business side effects do not belong here. This scope only guarantees LIFO
 * rollback, lease draining, deadline-bounded teardown and stale-result rejection.
 */
export class ResourceScope {
  readonly id: string;

  private readonly defaultDeadlineMs: number;
  private readonly abortController = new AbortController();
  private readonly resources: RegisteredResource[] = [];
  private readonly resourceIds = new Set<string>();
  private readonly pendingResourceIds = new Set<string>();
  private readonly leases = new Set<string>();
  private readonly leaseWaiters = new Set<() => void>();
  private readonly detachParentSignal?: () => void;
  private stateValue: ResourceScopeState = 'active';
  private epochValue = 1;
  private closePromise?: Promise<ResourceScopeCloseReport>;

  constructor(options: ResourceScopeOptions = {}) {
    this.id = options.id?.trim() || randomUUID();
    this.defaultDeadlineMs = validateDeadline(
      options.deadlineMs ?? DEFAULT_CLOSE_DEADLINE_MS,
      'Resource scope deadline'
    );

    if (options.parentSignal) {
      const onAbort = (): void => {
        void this.close({ reason: 'parent_aborted' });
      };
      options.parentSignal.addEventListener('abort', onAbort, { once: true });
      this.detachParentSignal = () => options.parentSignal?.removeEventListener('abort', onAbort);
      if (options.parentSignal.aborted) onAbort();
    }
  }

  get state(): ResourceScopeState {
    return this.stateValue;
  }

  get epoch(): number {
    return this.epochValue;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get activeLeaseCount(): number {
    return this.leases.size;
  }

  get activeResourceCount(): number {
    return this.resources.length + this.pendingResourceIds.size;
  }

  captureEpoch(): number {
    return this.epochValue;
  }

  isCurrentEpoch(epoch: number): boolean {
    return this.stateValue === 'active' && epoch === this.epochValue;
  }

  advanceEpoch(): number {
    this.assertActive('advance its epoch');
    this.epochValue++;
    return this.epochValue;
  }

  commitIfCurrent<T>(epoch: number, commit: () => T): T | undefined {
    if (!this.isCurrentEpoch(epoch)) return undefined;
    return commit();
  }

  register(id: string, dispose: ResourceDisposer): void {
    this.assertActive('register resources');
    const resourceId = this.validateResourceId(id);
    this.assertResourceIdAvailable(resourceId);
    if (typeof dispose !== 'function') {
      throw new TypeError(`Resource ${resourceId} must provide a disposer.`);
    }
    this.resourceIds.add(resourceId);
    this.resources.push({ id: resourceId, dispose });
  }

  async activate<T>(registration: ResourceRegistration<T>): Promise<T> {
    this.assertActive('activate resources');
    const resourceId = this.validateResourceId(registration.id);
    this.assertResourceIdAvailable(resourceId);
    if (typeof registration.activate !== 'function') {
      throw new TypeError(`Resource ${resourceId} must provide an activation function.`);
    }

    const epoch = this.captureEpoch();
    this.pendingResourceIds.add(resourceId);
    let activation: ResourceActivation<T>;

    try {
      activation = await registration.activate({
        scopeId: this.id,
        resourceId,
        epoch,
        signal: this.signal,
      });
      if (!activation || typeof activation.dispose !== 'function') {
        throw new TypeError(`Resource ${resourceId} activation must return a disposer.`);
      }
    } catch (error) {
      this.pendingResourceIds.delete(resourceId);
      const rollback = await this.close({ reason: `activation_failed:${resourceId}` });
      throw new ResourceActivationError(this.id, resourceId, error, rollback);
    }

    this.pendingResourceIds.delete(resourceId);
    if (!this.isCurrentEpoch(epoch)) {
      await this.disposeStaleActivation(resourceId, activation.dispose);
      throw new StaleResourceEpochError(this.id, resourceId, epoch, this.epochValue);
    }

    this.resourceIds.add(resourceId);
    this.resources.push({ id: resourceId, dispose: activation.dispose });
    return activation.value;
  }

  acquireLease(label?: string): ResourceLease {
    this.assertActive('acquire leases');
    const id = randomUUID();
    const epoch = this.epochValue;
    let released = false;
    this.leases.add(id);

    return Object.freeze({
      id,
      label,
      epoch,
      get released(): boolean {
        return released;
      },
      release: (): void => {
        if (released) return;
        released = true;
        this.leases.delete(id);
        this.notifyLeaseWaiters();
      },
    });
  }

  createChild(
    id: string,
    options: Omit<ResourceScopeOptions, 'id' | 'parentSignal'> = {}
  ): ResourceScope {
    const childId = this.validateResourceId(id);
    const child = new ResourceScope({
      ...options,
      id: `${this.id}/${childId}`,
      parentSignal: this.signal,
    });
    this.register(`child:${childId}`, async () => {
      await child.close({ reason: `parent_closed:${this.id}` });
    });
    return child;
  }

  close(options: ResourceScopeCloseOptions = {}): Promise<ResourceScopeCloseReport> {
    if (this.closePromise) return this.closePromise;

    const reason = options.reason?.trim() || 'scope_closed';
    const deadlineMs = validateDeadline(
      options.deadlineMs ?? this.defaultDeadlineMs,
      'Resource teardown deadline'
    );
    this.stateValue = 'draining';
    this.epochValue++;
    this.abortController.abort(new Error(reason));
    this.closePromise = this.performClose(reason, deadlineMs);
    return this.closePromise;
  }

  private async performClose(
    reason: string,
    deadlineMs: number
  ): Promise<ResourceScopeCloseReport> {
    const startedAt = Date.now();
    const deadlineAt = startedAt + deadlineMs;
    const deadlineController = new AbortController();
    const disposed: string[] = [];
    const errors: ResourceDisposalError[] = [];
    let timedOut = false;
    let leaseTimedOut = false;

    const leasesDrained = await this.waitForLeases(deadlineAt);
    if (!leasesDrained) {
      timedOut = true;
      leaseTimedOut = true;
      deadlineController.abort(new Error('Resource lease drain deadline exceeded.'));
    }

    const resources = this.resources.splice(0).reverse();
    this.resourceIds.clear();
    for (const resource of resources) {
      disposed.push(resource.id);
      const remainingMs = Math.max(0, deadlineAt - Date.now());
      if (remainingMs === 0 && !deadlineController.signal.aborted) {
        timedOut = true;
        deadlineController.abort(new Error('Resource teardown deadline exceeded.'));
      }

      try {
        const result = resource.dispose({
          scopeId: this.id,
          resourceId: resource.id,
          reason,
          deadlineAt,
          signal: deadlineController.signal,
        });
        if (!isPromiseLike(result)) continue;
        if (remainingMs === 0) {
          void Promise.resolve(result).catch(() => undefined);
          continue;
        }
        const outcome = await this.settleBeforeDeadline(result, remainingMs);
        if (outcome.status === 'timed_out') {
          timedOut = true;
          if (!deadlineController.signal.aborted) {
            deadlineController.abort(new Error('Resource teardown deadline exceeded.'));
          }
        } else if (outcome.error !== undefined) {
          errors.push({ resourceId: resource.id, message: errorMessage(outcome.error) });
        }
      } catch (error) {
        errors.push({ resourceId: resource.id, message: errorMessage(error) });
      }
    }

    this.detachParentSignal?.();
    this.pendingResourceIds.clear();
    this.stateValue = 'closed';
    const report: ResourceScopeCloseReport = Object.freeze({
      scopeId: this.id,
      reason,
      startedAt,
      completedAt: Date.now(),
      timedOut,
      leaseTimedOut,
      disposed: Object.freeze(disposed),
      errors: Object.freeze(errors.map(error => Object.freeze({ ...error }))),
    });
    return report;
  }

  private async disposeStaleActivation(
    resourceId: string,
    dispose: ResourceDisposer
  ): Promise<void> {
    const deadlineAt = Date.now() + this.defaultDeadlineMs;
    const controller = new AbortController();
    try {
      const result = dispose({
        scopeId: this.id,
        resourceId,
        reason: 'stale_epoch',
        deadlineAt,
        signal: controller.signal,
      });
      if (!isPromiseLike(result)) return;
      const outcome = await this.settleBeforeDeadline(result, this.defaultDeadlineMs);
      if (outcome.status === 'timed_out') controller.abort(new Error('Stale disposal timed out.'));
    } catch {
      // A stale result can no longer affect the active epoch. Disposal is best effort.
    }
  }

  private settleBeforeDeadline(
    promise: PromiseLike<void>,
    timeoutMs: number
  ): Promise<{ status: 'settled'; error?: unknown } | { status: 'timed_out' }> {
    return new Promise(resolve => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ status: 'timed_out' });
      }, timeoutMs);

      void Promise.resolve(promise).then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ status: 'settled' });
        },
        error => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ status: 'settled', error });
        }
      );
    });
  }

  private waitForLeases(deadlineAt: number): Promise<boolean> {
    if (this.leases.size === 0) return Promise.resolve(true);
    const remainingMs = Math.max(0, deadlineAt - Date.now());
    if (remainingMs === 0) return Promise.resolve(false);

    return new Promise(resolve => {
      let settled = false;
      const finish = (drained: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.leaseWaiters.delete(onLeaseChange);
        resolve(drained);
      };
      const onLeaseChange = (): void => {
        if (this.leases.size === 0) finish(true);
      };
      const timer = setTimeout(() => finish(false), remainingMs);
      this.leaseWaiters.add(onLeaseChange);
      onLeaseChange();
    });
  }

  private notifyLeaseWaiters(): void {
    for (const waiter of [...this.leaseWaiters]) waiter();
  }

  private validateResourceId(id: string): string {
    const normalized = id.trim();
    if (!normalized) throw new TypeError('Resource id must not be empty.');
    return normalized;
  }

  private assertResourceIdAvailable(id: string): void {
    if (this.resourceIds.has(id) || this.pendingResourceIds.has(id)) {
      throw new Error(`Resource ${id} is already registered in scope ${this.id}.`);
    }
  }

  private assertActive(operation: string): void {
    if (this.stateValue !== 'active') {
      throw new ResourceScopeStateError(this.id, this.stateValue, operation);
    }
  }
}
