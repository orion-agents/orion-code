import {
  ResourceScope,
  type ResourceScopeCloseOptions,
  type ResourceScopeCloseReport,
  type ResourceScopeOptions,
} from './resource-scope';
import type { TaskContextService } from './task-context-service';

/** Narrow structural seam implemented by first-party runtime services. */
export interface RuntimeServicePort {
  readonly serviceId: string;
}

export interface RuntimeServiceSlots {
  readonly models: RuntimeServicePort;
  readonly threads: RuntimeServicePort;
  readonly policy: RuntimeServicePort;
  readonly execution: RuntimeServicePort;
  readonly tools: RuntimeServicePort;
  readonly prompts: RuntimeServicePort;
  readonly skills: RuntimeServicePort;
  readonly mcp: RuntimeServicePort;
  readonly taskContext: TaskContextService;
  readonly capabilities: RuntimeServicePort;
  readonly events: RuntimeServicePort;
  readonly subagents: RuntimeServicePort;
}

export type RuntimeServices<T extends RuntimeServiceSlots = RuntimeServiceSlots> = Readonly<T>;

const RUNTIME_SERVICE_KEYS: readonly (keyof RuntimeServiceSlots)[] = Object.freeze([
  'models',
  'threads',
  'policy',
  'execution',
  'tools',
  'prompts',
  'skills',
  'mcp',
  'taskContext',
  'capabilities',
  'events',
  'subagents',
]);

/** Freezes the composition, not the stateful services it references. */
export function createRuntimeServices<T extends RuntimeServiceSlots>(
  services: T
): RuntimeServices<T> {
  for (const key of RUNTIME_SERVICE_KEYS) {
    const service = services[key];
    if (!service || typeof service.serviceId !== 'string' || !service.serviceId.trim()) {
      throw new TypeError(`Runtime service slot ${key} must provide a non-empty serviceId.`);
    }
  }
  return Object.freeze({ ...services });
}

export type RuntimeContributorLane =
  | 'context'
  | 'prompt'
  | 'tools'
  | 'threadLifecycle'
  | 'turnLifecycle'
  | 'toolLifecycle';

export type RuntimeContributorFailurePolicy = 'required' | 'isolate';

export interface RuntimeContributorExecutionContext {
  readonly lane: RuntimeContributorLane;
  readonly contributorId: string;
  readonly signal: AbortSignal;
  readonly scope: ResourceScope;
  readonly epoch: number;
}

export interface RuntimeContributor<TInput = unknown, TOutput = unknown> {
  readonly id: string;
  readonly order: number;
  readonly deadlineMs: number;
  readonly failurePolicy: RuntimeContributorFailurePolicy;
  readonly contribute: (
    input: TInput,
    context: RuntimeContributorExecutionContext
  ) => TOutput | Promise<TOutput>;
}

export interface RuntimeContributorSlots {
  readonly context: readonly RuntimeContributor[];
  readonly prompt: readonly RuntimeContributor[];
  readonly tools: readonly RuntimeContributor[];
  readonly threadLifecycle: readonly RuntimeContributor[];
  readonly turnLifecycle: readonly RuntimeContributor[];
  readonly toolLifecycle: readonly RuntimeContributor[];
}

export type RuntimeContributors = Readonly<RuntimeContributorSlots>;

export interface RuntimeContributorFailure {
  readonly id: string;
  readonly lane: RuntimeContributorLane;
  readonly message: string;
  readonly timedOut: boolean;
}

export interface RuntimeContributorLaneResult {
  readonly values: readonly { readonly id: string; readonly value: unknown }[];
  readonly failures: readonly RuntimeContributorFailure[];
}

export class RuntimeContributorError extends Error {
  constructor(
    public readonly failure: RuntimeContributorFailure,
    public readonly contributorCause: unknown
  ) {
    super(`Required runtime contributor ${failure.id} failed: ${failure.message}`);
    this.name = 'RuntimeContributorError';
  }
}

const RUNTIME_CONTRIBUTOR_LANES: readonly RuntimeContributorLane[] = Object.freeze([
  'context',
  'prompt',
  'tools',
  'threadLifecycle',
  'turnLifecycle',
  'toolLifecycle',
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function freezeContributor(contributor: RuntimeContributor): RuntimeContributor {
  const id = contributor.id.trim();
  if (!id) throw new TypeError('Runtime contributor id must not be empty.');
  if (!Number.isFinite(contributor.order)) {
    throw new TypeError(`Runtime contributor ${id} order must be finite.`);
  }
  if (!Number.isFinite(contributor.deadlineMs) || contributor.deadlineMs <= 0) {
    throw new TypeError(`Runtime contributor ${id} deadlineMs must be positive and finite.`);
  }
  if (contributor.failurePolicy !== 'required' && contributor.failurePolicy !== 'isolate') {
    throw new TypeError(`Runtime contributor ${id} has an invalid failure policy.`);
  }
  if (typeof contributor.contribute !== 'function') {
    throw new TypeError(`Runtime contributor ${id} must provide contribute().`);
  }
  return Object.freeze({
    id,
    order: contributor.order,
    deadlineMs: contributor.deadlineMs,
    failurePolicy: contributor.failurePolicy,
    contribute: contributor.contribute,
  });
}

/** Copies, deterministically orders and freezes all first-party contribution lanes. */
export function createRuntimeContributors(input: RuntimeContributorSlots): RuntimeContributors {
  const seenIds = new Set<string>();
  const result = {} as Record<RuntimeContributorLane, readonly RuntimeContributor[]>;

  for (const lane of RUNTIME_CONTRIBUTOR_LANES) {
    if (!Array.isArray(input[lane])) {
      throw new TypeError(`Runtime contributor lane ${lane} must be an array.`);
    }
    const contributors = input[lane].map(freezeContributor);
    for (const contributor of contributors) {
      if (seenIds.has(contributor.id)) {
        throw new Error(`Duplicate runtime contributor id: ${contributor.id}.`);
      }
      seenIds.add(contributor.id);
    }
    contributors.sort(
      (left, right) =>
        left.order - right.order || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    );
    result[lane] = Object.freeze(contributors);
  }

  return Object.freeze(result) as RuntimeContributors;
}

export function emptyRuntimeContributorSlots(): RuntimeContributorSlots {
  return {
    context: [],
    prompt: [],
    tools: [],
    threadLifecycle: [],
    turnLifecycle: [],
    toolLifecycle: [],
  };
}

export async function runRuntimeContributorLane(
  contributors: RuntimeContributors,
  lane: RuntimeContributorLane,
  input: unknown,
  scope: ResourceScope
): Promise<RuntimeContributorLaneResult> {
  const values: Array<{ id: string; value: unknown }> = [];
  const failures: RuntimeContributorFailure[] = [];

  for (const contributor of contributors[lane]) {
    const epoch = scope.captureEpoch();
    const lease = scope.acquireLease(`contributor:${lane}:${contributor.id}`);
    const controller = new AbortController();
    const onScopeAbort = (): void => controller.abort(scope.signal.reason);
    scope.signal.addEventListener('abort', onScopeAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error(`Contributor ${contributor.id} exceeded its deadline.`)),
      contributor.deadlineMs
    );

    try {
      const value = await Promise.race([
        Promise.resolve(
          contributor.contribute(input, {
            lane,
            contributorId: contributor.id,
            signal: controller.signal,
            scope,
            epoch,
          })
        ),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => reject(controller.signal.reason ?? new Error('Contributor aborted.')),
            { once: true }
          );
        }),
      ]);
      if (!scope.isCurrentEpoch(epoch)) {
        throw new Error(`Contributor ${contributor.id} produced a stale epoch result.`);
      }
      values.push(Object.freeze({ id: contributor.id, value }));
    } catch (error) {
      const failure: RuntimeContributorFailure = Object.freeze({
        id: contributor.id,
        lane,
        message: errorMessage(error),
        timedOut: controller.signal.aborted && !scope.signal.aborted,
      });
      failures.push(failure);
      if (contributor.failurePolicy === 'required') {
        throw new RuntimeContributorError(failure, error);
      }
    } finally {
      clearTimeout(timer);
      scope.signal.removeEventListener('abort', onScopeAbort);
      lease.release();
    }
  }

  return Object.freeze({
    values: Object.freeze(values),
    failures: Object.freeze(failures),
  });
}

export interface HarnessTestRigOptions<T extends RuntimeServiceSlots> {
  readonly services: T;
  readonly contributors?: RuntimeContributorSlots;
  readonly scope?: ResourceScope;
  readonly scopeOptions?: ResourceScopeOptions;
}

/** Small deterministic host for runtime contract and lifecycle tests. */
export class HarnessTestRig<T extends RuntimeServiceSlots = RuntimeServiceSlots> {
  readonly services: RuntimeServices<T>;
  readonly contributors: RuntimeContributors;
  readonly scope: ResourceScope;

  constructor(options: HarnessTestRigOptions<T>) {
    if (options.scope && options.scopeOptions) {
      throw new TypeError('HarnessTestRig accepts either scope or scopeOptions, not both.');
    }
    this.services = createRuntimeServices(options.services);
    this.contributors = createRuntimeContributors(
      options.contributors ?? emptyRuntimeContributorSlots()
    );
    this.scope = options.scope ?? new ResourceScope(options.scopeOptions);
  }

  run(lane: RuntimeContributorLane, input: unknown): Promise<RuntimeContributorLaneResult> {
    return runRuntimeContributorLane(this.contributors, lane, input, this.scope);
  }

  close(options?: ResourceScopeCloseOptions): Promise<ResourceScopeCloseReport> {
    return this.scope.close(options);
  }
}

export function createHarnessTestRig<T extends RuntimeServiceSlots>(
  options: HarnessTestRigOptions<T>
): HarnessTestRig<T> {
  return new HarnessTestRig(options);
}
