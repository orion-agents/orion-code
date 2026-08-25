import { isAbsolute, relative, resolve, sep } from 'path';

import {
  createStopDecision,
  type StopDecision,
  type StopDecisionStatus,
} from '../framework/stop-decision';
import type { CapabilityReceiptV1 } from './capabilities';
import type { CapabilityStepReceiptV1 } from './capability-step-factory';
import type { SubagentRole } from './subagents/types';
import { digestRuntimeValue } from './protocol/canonical';
import {
  createRuntimeId,
  isRuntimeId,
  type RuntimeEventEnvelopeV1,
} from './protocol/runtime-protocol-v1';
import {
  createAuthoritySnapshotV1,
  type AgentBaseModeV1,
  type AuthoritySnapshotV1,
} from './step-snapshot';
import { ThreadEventStore, type ThreadEventStoreOptionsV1 } from './thread-event-store';
import {
  ThreadRuntimeV1,
  type ThreadTurnOutcomeV1,
  type ThreadTurnRunnerV1,
} from './thread-runtime';
import { parseTurnCommitV1, type TurnCommitV1 } from './turn-commit';

export const SUBAGENT_THREAD_RUNTIME_VERSION = 1 as const;

export interface SubagentThreadTreeLimitsV1 {
  readonly maxConcurrent: number;
  readonly maxQueued?: number;
  readonly maxModelRequests: number;
  readonly maxToolCalls: number;
}

export interface SubagentThreadBudgetRequestV1 {
  readonly maxModelRequests: number;
  readonly maxToolCalls: number;
}

export interface SubagentThreadUsageV1 {
  readonly modelRequests: number;
  readonly toolCalls: number;
}

export interface SubagentThreadTreeSnapshotV1 {
  readonly version: 1;
  readonly active: number;
  readonly queued: number;
  readonly maxConcurrent: number;
  readonly maxQueued: number;
  readonly modelRequests: {
    readonly used: number;
    readonly reserved: number;
    readonly limit: number;
  };
  readonly toolCalls: {
    readonly used: number;
    readonly reserved: number;
    readonly limit: number;
  };
  readonly closed: boolean;
}

/**
 * The explicit budget port a root AgentLoop and every child AgentLoop share.
 * Production provider/tool boundaries must charge this port before an effect.
 */
export interface SubagentThreadBudgetPortV1 {
  readonly ownerId: string;
  readonly limits: SubagentThreadBudgetRequestV1;
  consumeModelRequests(count?: number): SubagentThreadUsageV1;
  consumeToolCalls(count?: number): SubagentThreadUsageV1;
  snapshot(): SubagentThreadUsageV1;
}

interface ConcurrencyWaiter {
  readonly signal: AbortSignal;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: Error) => void;
  readonly onAbort: () => void;
}

/** Root-tree owner for concurrency, provider/tool budgets and cancellation. */
export class SubagentThreadTreeScopeV1 {
  readonly signal: AbortSignal;

  private readonly limits: Required<SubagentThreadTreeLimitsV1>;
  private readonly controller = new AbortController();
  private readonly waiters: ConcurrencyWaiter[] = [];
  private readonly detachParentAbort: () => void;
  private active = 0;
  private modelUsed = 0;
  private modelReserved = 0;
  private toolUsed = 0;
  private toolReserved = 0;

  constructor(limits: SubagentThreadTreeLimitsV1, parentSignal?: AbortSignal) {
    this.limits = {
      maxConcurrent: positiveInteger(limits.maxConcurrent, 'maxConcurrent'),
      maxQueued: nonNegativeInteger(limits.maxQueued ?? limits.maxConcurrent * 4, 'maxQueued'),
      maxModelRequests: positiveInteger(limits.maxModelRequests, 'maxModelRequests'),
      maxToolCalls: nonNegativeInteger(limits.maxToolCalls, 'maxToolCalls'),
    };
    this.signal = this.controller.signal;
    this.detachParentAbort = forwardAbort(parentSignal, this.controller);
  }

  async acquire(signal: AbortSignal): Promise<() => void> {
    this.assertOpen();
    throwIfAborted(signal);
    if (this.active < this.limits.maxConcurrent) {
      this.active += 1;
      return this.releaseHandle();
    }
    if (this.waiters.length >= this.limits.maxQueued) {
      throw new SubagentThreadRuntimeError(
        'ORION_SUBAGENT_TREE_OVERLOADED',
        `Subagent tree queue is full (${this.limits.maxQueued}).`
      );
    }
    return new Promise<() => void>((resolveWaiter, rejectWaiter) => {
      const waiter: ConcurrencyWaiter = {
        signal,
        resolve: resolveWaiter,
        reject: rejectWaiter,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          rejectWaiter(abortError(signal));
        },
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  reserveBudget(
    ownerId: string,
    request: SubagentThreadBudgetRequestV1
  ): SubagentThreadBudgetLeaseV1 {
    this.assertOpen();
    const limits = validateBudgetRequest(request);
    if (
      this.modelUsed + this.modelReserved + limits.maxModelRequests >
        this.limits.maxModelRequests ||
      this.toolUsed + this.toolReserved + limits.maxToolCalls > this.limits.maxToolCalls
    ) {
      throw new SubagentThreadRuntimeError(
        'ORION_SUBAGENT_TREE_BUDGET_EXCEEDED',
        'The root-tree model/tool budget cannot satisfy this child reservation.'
      );
    }
    this.modelReserved += limits.maxModelRequests;
    this.toolReserved += limits.maxToolCalls;
    return new SubagentThreadBudgetLeaseV1(this, ownerId, limits);
  }

  /** Charge work already performed by the root loop against the same tree budget. */
  recordRootUsage(usage: SubagentThreadUsageV1): SubagentThreadTreeSnapshotV1 {
    this.assertOpen();
    const modelRequests = nonNegativeInteger(usage.modelRequests, 'root modelRequests');
    const toolCalls = nonNegativeInteger(usage.toolCalls, 'root toolCalls');
    if (
      this.modelUsed + this.modelReserved + modelRequests > this.limits.maxModelRequests ||
      this.toolUsed + this.toolReserved + toolCalls > this.limits.maxToolCalls
    ) {
      throw new SubagentThreadRuntimeError(
        'ORION_SUBAGENT_TREE_BUDGET_EXCEEDED',
        'Root usage exceeds the remaining shared subagent-tree budget.'
      );
    }
    this.modelUsed += modelRequests;
    this.toolUsed += toolCalls;
    return this.snapshot();
  }

  snapshot(): SubagentThreadTreeSnapshotV1 {
    return deepFreeze({
      version: SUBAGENT_THREAD_RUNTIME_VERSION,
      active: this.active,
      queued: this.waiters.length,
      maxConcurrent: this.limits.maxConcurrent,
      maxQueued: this.limits.maxQueued,
      modelRequests: {
        used: this.modelUsed,
        reserved: this.modelReserved,
        limit: this.limits.maxModelRequests,
      },
      toolCalls: {
        used: this.toolUsed,
        reserved: this.toolReserved,
        limit: this.limits.maxToolCalls,
      },
      closed: this.signal.aborted,
    });
  }

  close(reason = 'subagent thread tree closed'): void {
    if (!this.signal.aborted) this.controller.abort(reason);
    this.detachParentAbort();
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.reject(abortError(this.signal));
    }
  }

  consume(
    lease: SubagentThreadBudgetLeaseV1,
    resource: 'model' | 'tool',
    count: number
  ): SubagentThreadUsageV1 {
    this.assertOpen();
    const amount = positiveInteger(count, `${resource} budget charge`);
    if (resource === 'model') {
      if (lease.modelRequests + amount > lease.limits.maxModelRequests) {
        throw lease.fail(
          childBudgetError(lease.ownerId, 'model requests', lease.limits.maxModelRequests)
        );
      }
      lease.modelRequests += amount;
      this.modelReserved -= amount;
      this.modelUsed += amount;
    } else {
      if (lease.toolCalls + amount > lease.limits.maxToolCalls) {
        throw lease.fail(childBudgetError(lease.ownerId, 'tool calls', lease.limits.maxToolCalls));
      }
      lease.toolCalls += amount;
      this.toolReserved -= amount;
      this.toolUsed += amount;
    }
    return lease.snapshot();
  }

  releaseBudget(lease: SubagentThreadBudgetLeaseV1): void {
    this.modelReserved -= lease.limits.maxModelRequests - lease.modelRequests;
    this.toolReserved -= lease.limits.maxToolCalls - lease.toolCalls;
  }

  private assertOpen(): void {
    if (this.signal.aborted) throw abortError(this.signal);
  }

  private releaseHandle(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.promote();
    };
  }

  private promote(): void {
    while (this.active < this.limits.maxConcurrent && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(abortError(waiter.signal));
        continue;
      }
      this.active += 1;
      waiter.resolve(this.releaseHandle());
    }
  }
}

class SubagentThreadBudgetLeaseV1 implements SubagentThreadBudgetPortV1 {
  modelRequests = 0;
  toolCalls = 0;
  failure?: SubagentThreadRuntimeError;
  private released = false;

  constructor(
    private readonly tree: SubagentThreadTreeScopeV1,
    readonly ownerId: string,
    readonly limits: SubagentThreadBudgetRequestV1
  ) {}

  consumeModelRequests(count = 1): SubagentThreadUsageV1 {
    this.assertOpen();
    return this.tree.consume(this, 'model', count);
  }

  consumeToolCalls(count = 1): SubagentThreadUsageV1 {
    this.assertOpen();
    return this.tree.consume(this, 'tool', count);
  }

  snapshot(): SubagentThreadUsageV1 {
    return Object.freeze({ modelRequests: this.modelRequests, toolCalls: this.toolCalls });
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.tree.releaseBudget(this);
  }

  fail(error: SubagentThreadRuntimeError): SubagentThreadRuntimeError {
    this.failure ??= error;
    return this.failure;
  }

  private assertOpen(): void {
    if (this.released) {
      throw new SubagentThreadRuntimeError(
        'ORION_SUBAGENT_TREE_CLOSED',
        `Budget lease ${this.ownerId} is closed.`
      );
    }
  }
}

export interface SubagentThreadEvidenceV1 {
  readonly kind: 'verification' | 'file' | 'tool' | 'runtime';
  readonly source: string;
  readonly detail: string;
  readonly reference?: string;
}

export interface SubagentThreadEvidencePortV1 {
  record(evidence: SubagentThreadEvidenceV1): boolean;
  snapshot(): readonly SubagentThreadEvidenceV1[];
}

export interface ParentThreadForkRequestV1 {
  readonly store: ThreadEventStore;
  readonly threadId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly requestId: string;
  readonly stepSnapshotDigest: string;
  readonly capabilityReceiptDigest: string;
  /** Flushes the active step's atomic StepSnapshot/CapabilityReceipt pair before verification. */
  readonly flush: () => void | Promise<void>;
}

export interface ParentThreadForkAnchorV1 {
  readonly threadId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly requestId: string;
  readonly stepSnapshotSeq: number;
  readonly capabilityReceiptSeq: number;
  readonly stepSnapshotDigest: string;
  readonly capabilityReceiptDigest: string;
  readonly projectionCursor: number;
  readonly projectionDigest: string;
}

export interface SubagentAgentLoopFactoryInputV1 {
  readonly role: SubagentRole;
  readonly objective: string;
  readonly childThreadId: string;
  readonly childStore: ThreadEventStore;
  readonly parent: ParentThreadForkAnchorV1;
  readonly authority: AuthoritySnapshotV1;
  readonly budget: SubagentThreadBudgetPortV1;
  readonly evidence: SubagentThreadEvidencePortV1;
  readonly abortSignal: AbortSignal;
}

/** Additive composition seam: root and child must instantiate the same AgentLoop implementation. */
export type SubagentAgentLoopFactoryV1 = (
  input: SubagentAgentLoopFactoryInputV1
) => ThreadTurnRunnerV1 | Promise<ThreadTurnRunnerV1>;

export interface SubagentThreadRuntimeOptionsV1 {
  readonly childStoreRootDir: string;
  readonly tree: SubagentThreadTreeScopeV1;
  readonly rolePolicies: Readonly<Partial<Record<SubagentRole, AuthoritySnapshotV1>>>;
  readonly createAgentLoop: SubagentAgentLoopFactoryV1;
  readonly eventStoreOptions?: ThreadEventStoreOptionsV1;
  readonly defaultBudget?: SubagentThreadBudgetRequestV1;
  readonly maxObjectiveBytes?: number;
  readonly maxSummaryBytes?: number;
  readonly maxEvidenceItems?: number;
  readonly maxEvidenceBytes?: number;
  readonly threadIdFactory?: () => string;
  readonly clock?: () => number;
  /** Parent-facing durable receipt sink; child step/tool/turn facts remain in the child store. */
  readonly onReceipt?: (receipt: SubagentThreadReceiptV1) => void | Promise<void>;
}

export interface RunSubagentThreadRequestV1 {
  readonly parent: ParentThreadForkRequestV1;
  readonly parentAuthority: AuthoritySnapshotV1;
  readonly role: SubagentRole;
  readonly objective: string;
  readonly mode?: AgentBaseModeV1;
  readonly budget?: SubagentThreadBudgetRequestV1;
  readonly abortSignal?: AbortSignal;
}

export interface SubagentThreadReceiptV1 {
  readonly version: 1;
  readonly receiptId: string;
  readonly parentThreadId: string;
  readonly parentTurnId: string;
  readonly parentStepId: string;
  readonly parentRequestId: string;
  readonly parentStepSnapshotSeq: number;
  readonly parentCapabilityReceiptSeq: number;
  readonly parentStepSnapshotDigest: string;
  readonly parentCapabilityReceiptDigest: string;
  readonly parentProjectionCursor: number;
  readonly parentProjectionDigest: string;
  readonly childThreadId: string;
  readonly childTurnId: string;
  readonly childCursor: number;
  readonly childProjectionDigest: string;
  readonly childCommitDigest: string;
  readonly childStepSnapshotDigests: readonly string[];
  readonly role: SubagentRole;
  readonly authorityDigest: string;
  readonly usage: SubagentThreadUsageV1;
  readonly turnTerminal: 'completed' | 'failed' | 'interrupted';
  readonly stopDecisionDigest: string;
  readonly resultDigest: string;
  readonly evidenceDigest: string;
  readonly createdAt: number;
  readonly digest: string;
}

export interface SubagentThreadResultV1 {
  readonly version: 1;
  readonly parentThreadId: string;
  readonly parentTurnId: string;
  readonly childThreadId: string;
  readonly childTurnId: string;
  readonly role: SubagentRole;
  readonly authority: AuthoritySnapshotV1;
  readonly status: StopDecisionStatus;
  readonly turnTerminal: 'completed' | 'failed' | 'interrupted';
  readonly summary: string;
  readonly evidence: readonly SubagentThreadEvidenceV1[];
  readonly usage: SubagentThreadUsageV1;
  readonly stopDecision: StopDecision;
  readonly receipt: SubagentThreadReceiptV1;
}

interface ValidatedSubagentOptions {
  readonly childStoreRootDir: string;
  readonly tree: SubagentThreadTreeScopeV1;
  readonly rolePolicies: SubagentThreadRuntimeOptionsV1['rolePolicies'];
  readonly createAgentLoop: SubagentAgentLoopFactoryV1;
  readonly eventStoreOptions?: ThreadEventStoreOptionsV1;
  readonly defaultBudget: SubagentThreadBudgetRequestV1;
  readonly maxObjectiveBytes: number;
  readonly maxSummaryBytes: number;
  readonly maxEvidenceItems: number;
  readonly maxEvidenceBytes: number;
  readonly threadIdFactory: () => string;
  readonly clock: () => number;
  readonly onReceipt?: SubagentThreadRuntimeOptionsV1['onReceipt'];
}

/** Durable child-Thread orchestration; it never returns the child's transcript. */
export class SubagentThreadRuntimeV1 {
  private readonly options: ValidatedSubagentOptions;

  constructor(options: SubagentThreadRuntimeOptionsV1) {
    this.options = validateOptions(options);
  }

  async run(request: RunSubagentThreadRequestV1): Promise<SubagentThreadResultV1> {
    const objective = request.objective.trim();
    if (!objective || Buffer.byteLength(objective, 'utf8') > this.options.maxObjectiveBytes) {
      throw new SubagentThreadRuntimeError(
        'ORION_SUBAGENT_INVALID_REQUEST',
        `Child objective must be non-empty and at most ${this.options.maxObjectiveBytes} bytes.`
      );
    }
    throwIfAborted(this.options.tree.signal);
    throwIfAborted(request.abortSignal);
    const parent = await flushAndCaptureParent(request.parent);
    throwIfAborted(this.options.tree.signal);
    throwIfAborted(request.abortSignal);

    const rolePolicy = this.options.rolePolicies[request.role];
    if (!rolePolicy) {
      throw new SubagentThreadRuntimeError(
        'ORION_SUBAGENT_ROLE_DENIED',
        `Subagent role ${request.role} has no configured authority policy.`
      );
    }
    const authority = intersectSubagentAuthorityV1(request.parentAuthority, rolePolicy);
    const childThreadId = this.options.threadIdFactory();
    if (!isRuntimeId(childThreadId) || childThreadId === parent.threadId) {
      throw new SubagentThreadRuntimeError(
        'ORION_SUBAGENT_INVALID_REQUEST',
        'Child Thread ID factory must return a UUID distinct from the parent Thread.'
      );
    }

    const linked = linkAbortSignals([this.options.tree.signal, request.abortSignal]);
    let releaseConcurrency: (() => void) | undefined;
    let budget: SubagentThreadBudgetLeaseV1 | undefined;
    let runtime: ThreadRuntimeV1 | undefined;
    try {
      releaseConcurrency = await this.options.tree.acquire(linked.signal);
      throwIfAborted(linked.signal);
      budget = this.options.tree.reserveBudget(
        childThreadId,
        request.budget ?? this.options.defaultBudget
      );
      const evidence = new BoundedEvidenceCollectorV1(
        this.options.maxEvidenceItems,
        this.options.maxEvidenceBytes
      );
      const store = new ThreadEventStore(
        this.options.childStoreRootDir,
        childThreadId,
        this.options.eventStoreOptions
      );
      const runner = await this.options.createAgentLoop({
        role: request.role,
        objective,
        childThreadId,
        childStore: store,
        parent,
        authority,
        budget,
        evidence,
        abortSignal: linked.signal,
      });
      const captured = new CapturingTurnRunnerV1(runner, linked.signal);
      runtime = new ThreadRuntimeV1({
        store,
        runner: captured,
        projectPath: authority.projectRoot,
        requireTurnCommit: true,
      });
      store.appendDurable({
        payload: {
          type: 'thread.forked',
          data: {
            sourceThreadId: parent.threadId,
            sourceSeq: parent.capabilityReceiptSeq,
          },
        },
      });
      const admission = runtime.dispatch({
        type: 'turn.start',
        data: { input: objective, mode: request.mode ?? 'build' },
      });
      if (admission.status !== 'started') {
        throw new SubagentThreadRuntimeError(
          'ORION_SUBAGENT_CHILD_START_FAILED',
          `Child Thread start was ${admission.status}.`
        );
      }
      const onAbort = (): void => {
        runtime?.dispatch({
          type: 'turn.interrupt',
          data: { reason: abortMessage(linked.signal) },
        });
      };
      linked.signal.addEventListener('abort', onAbort, { once: true });
      if (linked.signal.aborted) onAbort();
      try {
        await runtime.waitForIdle();
      } finally {
        linked.signal.removeEventListener('abort', onAbort);
      }

      const projection = store.loadProjection();
      const turn = projection.turns[admission.turnId];
      if (budget.failure) throw budget.failure;
      if (!turn || turn.status === 'active' || !turn.commit) {
        throw new SubagentThreadRuntimeError(
          'ORION_SUBAGENT_CHILD_COMMIT_MISSING',
          'Child AgentLoop did not durably publish a terminal TurnCommitV1.'
        );
      }
      const childCommit = parseTurnCommitV1(turn.commit.receipt);
      assertIndependentStepSnapshots(parent.stepSnapshotDigest, childCommit, turn.status);
      const usage = budget.snapshot();
      const stopDecision = childStopDecision(
        childCommit,
        turn.status,
        usage,
        budget.limits,
        parent
      );
      const summary = boundedChildSummary(
        projection,
        admission.turnId,
        childCommit,
        this.options.maxSummaryBytes
      );
      const evidenceItems = boundedEvidence(
        evidence.snapshot(),
        childCommit,
        this.options.maxEvidenceItems,
        this.options.maxEvidenceBytes
      );
      const receipt = createSubagentThreadReceiptV1({
        receiptId: createRuntimeId(),
        parent,
        childThreadId,
        childTurnId: admission.turnId,
        childCursor: projection.cursor,
        childProjectionDigest: projection.digest,
        childCommit,
        role: request.role,
        authority,
        usage,
        turnTerminal: turn.status,
        stopDecision,
        summary,
        evidence: evidenceItems,
        createdAt: this.options.clock(),
      });
      try {
        await this.options.onReceipt?.(receipt);
      } catch (error) {
        throw new SubagentThreadRuntimeError(
          'ORION_SUBAGENT_RECEIPT_WRITE_FAILED',
          `Subagent receipt sink failed: ${errorMessage(error)}`
        );
      }
      return deepFreeze({
        version: SUBAGENT_THREAD_RUNTIME_VERSION,
        parentThreadId: parent.threadId,
        parentTurnId: parent.turnId,
        childThreadId,
        childTurnId: admission.turnId,
        role: request.role,
        authority,
        status: stopDecision.status,
        turnTerminal: turn.status,
        summary,
        evidence: evidenceItems,
        usage,
        stopDecision,
        receipt,
      });
    } finally {
      runtime?.close('subagent child finished');
      budget?.release();
      releaseConcurrency?.();
      linked.dispose();
    }
  }
}

class CapturingTurnRunnerV1 implements ThreadTurnRunnerV1 {
  constructor(
    private readonly runner: ThreadTurnRunnerV1,
    private readonly treeSignal: AbortSignal
  ) {}

  async run(context: Parameters<ThreadTurnRunnerV1['run']>[0]): Promise<ThreadTurnOutcomeV1> {
    const linked = linkAbortSignals([context.abortSignal, this.treeSignal]);
    try {
      return await this.runner.run({ ...context, abortSignal: linked.signal });
    } finally {
      linked.dispose();
    }
  }
}

class BoundedEvidenceCollectorV1 implements SubagentThreadEvidencePortV1 {
  private readonly items: SubagentThreadEvidenceV1[] = [];

  constructor(
    private readonly maxItems: number,
    private readonly maxBytes: number
  ) {}

  record(evidence: SubagentThreadEvidenceV1): boolean {
    if (this.items.length >= this.maxItems) return false;
    const source = truncateUtf8(evidence.source.trim(), this.maxBytes);
    const detail = truncateUtf8(evidence.detail.trim(), this.maxBytes);
    const reference = evidence.reference
      ? truncateUtf8(evidence.reference.trim(), this.maxBytes)
      : undefined;
    if (!source || !detail) return false;
    this.items.push(
      deepFreeze({
        kind: evidence.kind,
        source,
        detail,
        ...(reference ? { reference } : {}),
      })
    );
    return true;
  }

  snapshot(): readonly SubagentThreadEvidenceV1[] {
    return deepFreeze(this.items.map(item => ({ ...item })));
  }
}

export function intersectSubagentAuthorityV1(
  parent: AuthoritySnapshotV1,
  rolePolicy: AuthoritySnapshotV1
): AuthoritySnapshotV1 {
  assertAuthority(parent, 'parent');
  assertAuthority(rolePolicy, 'role');
  const projectRoot = intersectProjectRoots(parent.projectRoot, rolePolicy.projectRoot);
  const confirmation = moreRestrictive(parent.confirmation, rolePolicy.confirmation, [
    'allow',
    'ask',
    'deny',
  ] as const);
  const filesystem = moreRestrictive(parent.filesystem, rolePolicy.filesystem, [
    'full',
    'workspace',
  ] as const);
  const network = moreRestrictive(parent.network, rolePolicy.network, [
    'write',
    'read',
    'deny',
  ] as const);
  return createAuthoritySnapshotV1({
    authorityId: `subagent:${digestRuntimeValue({ parent: parent.digest, role: rolePolicy.digest })}`,
    projectRoot,
    confirmation,
    filesystem,
    network,
  });
}

export function createSubagentThreadReceiptV1(input: {
  readonly receiptId: string;
  readonly parent: ParentThreadForkAnchorV1;
  readonly childThreadId: string;
  readonly childTurnId: string;
  readonly childCursor: number;
  readonly childProjectionDigest: string;
  readonly childCommit: TurnCommitV1;
  readonly role: SubagentRole;
  readonly authority: AuthoritySnapshotV1;
  readonly usage: SubagentThreadUsageV1;
  readonly turnTerminal: 'completed' | 'failed' | 'interrupted';
  readonly stopDecision: StopDecision;
  readonly summary: string;
  readonly evidence: readonly SubagentThreadEvidenceV1[];
  readonly createdAt: number;
}): SubagentThreadReceiptV1 {
  const content = {
    version: SUBAGENT_THREAD_RUNTIME_VERSION,
    receiptId: input.receiptId,
    parentThreadId: input.parent.threadId,
    parentTurnId: input.parent.turnId,
    parentStepId: input.parent.stepId,
    parentRequestId: input.parent.requestId,
    parentStepSnapshotSeq: input.parent.stepSnapshotSeq,
    parentCapabilityReceiptSeq: input.parent.capabilityReceiptSeq,
    parentStepSnapshotDigest: input.parent.stepSnapshotDigest,
    parentCapabilityReceiptDigest: input.parent.capabilityReceiptDigest,
    parentProjectionCursor: input.parent.projectionCursor,
    parentProjectionDigest: input.parent.projectionDigest,
    childThreadId: input.childThreadId,
    childTurnId: input.childTurnId,
    childCursor: input.childCursor,
    childProjectionDigest: input.childProjectionDigest,
    childCommitDigest: input.childCommit.digest,
    childStepSnapshotDigests: [...input.childCommit.stepSnapshotDigests],
    role: input.role,
    authorityDigest: input.authority.digest,
    usage: { ...input.usage },
    turnTerminal: input.turnTerminal,
    stopDecisionDigest: digestRuntimeValue(input.stopDecision),
    resultDigest: digestRuntimeValue({
      status: input.stopDecision.status,
      turnTerminal: input.turnTerminal,
      summary: input.summary,
    }),
    evidenceDigest: digestRuntimeValue(input.evidence),
    createdAt: input.createdAt,
  };
  return deepFreeze({ ...content, digest: digestRuntimeValue(content) });
}

export function assertSubagentThreadReceiptV1(receipt: SubagentThreadReceiptV1): void {
  const { digest, ...content } = receipt;
  if (
    receipt.version !== SUBAGENT_THREAD_RUNTIME_VERSION ||
    !isRuntimeId(receipt.receiptId) ||
    !isRuntimeId(receipt.parentThreadId) ||
    !isRuntimeId(receipt.parentTurnId) ||
    !isRuntimeId(receipt.parentStepId) ||
    !isRuntimeId(receipt.parentRequestId) ||
    !isRuntimeId(receipt.childThreadId) ||
    !isRuntimeId(receipt.childTurnId) ||
    !Number.isSafeInteger(receipt.parentStepSnapshotSeq) ||
    receipt.parentStepSnapshotSeq < 1 ||
    receipt.parentCapabilityReceiptSeq !== receipt.parentStepSnapshotSeq + 1 ||
    !Number.isSafeInteger(receipt.parentProjectionCursor) ||
    receipt.parentCapabilityReceiptSeq > receipt.parentProjectionCursor ||
    !receipt.parentStepSnapshotDigest.trim() ||
    !receipt.parentCapabilityReceiptDigest.trim() ||
    digestRuntimeValue(content) !== digest
  ) {
    throw new SubagentThreadRuntimeError(
      'ORION_SUBAGENT_RECEIPT_INVALID',
      'Subagent Thread receipt failed identity or digest validation.'
    );
  }
}

export type SubagentThreadRuntimeErrorCodeV1 =
  | 'ORION_SUBAGENT_INVALID_REQUEST'
  | 'ORION_SUBAGENT_PARENT_FLUSH_FAILED'
  | 'ORION_SUBAGENT_PARENT_STEP_NOT_DURABLE'
  | 'ORION_SUBAGENT_PARENT_NOT_ACTIVE'
  | 'ORION_SUBAGENT_PARENT_DRIFT'
  | 'ORION_SUBAGENT_ROLE_DENIED'
  | 'ORION_SUBAGENT_AUTHORITY_INVALID'
  | 'ORION_SUBAGENT_TREE_OVERLOADED'
  | 'ORION_SUBAGENT_TREE_BUDGET_EXCEEDED'
  | 'ORION_SUBAGENT_TREE_CLOSED'
  | 'ORION_SUBAGENT_ABORTED'
  | 'ORION_SUBAGENT_CHILD_START_FAILED'
  | 'ORION_SUBAGENT_CHILD_COMMIT_MISSING'
  | 'ORION_SUBAGENT_CHILD_SNAPSHOT_INVALID'
  | 'ORION_SUBAGENT_CHILD_RESULT_INVALID'
  | 'ORION_SUBAGENT_RECEIPT_WRITE_FAILED'
  | 'ORION_SUBAGENT_RECEIPT_INVALID';

export class SubagentThreadRuntimeError extends Error {
  constructor(
    readonly code: SubagentThreadRuntimeErrorCodeV1,
    message: string
  ) {
    super(message);
    this.name = 'SubagentThreadRuntimeError';
  }
}

async function flushAndCaptureParent(
  input: ParentThreadForkRequestV1
): Promise<ParentThreadForkAnchorV1> {
  assertParentForkRequest(input);
  try {
    await input.flush();
  } catch (error) {
    throw new SubagentThreadRuntimeError(
      'ORION_SUBAGENT_PARENT_FLUSH_FAILED',
      `Parent step receipt flush failed: ${errorMessage(error)}`
    );
  }

  const events = replayAllEvents(input.store);
  const projection = input.store.loadProjection();
  const turn = projection.turns[input.turnId];
  if (
    !turn ||
    turn.status !== 'active' ||
    projection.activeTurnId !== input.turnId ||
    turn.commit
  ) {
    throw new SubagentThreadRuntimeError(
      'ORION_SUBAGENT_PARENT_NOT_ACTIVE',
      `Parent turn ${input.turnId} must remain active at the child fork boundary.`
    );
  }
  const replayCursor = events.at(-1)?.seq ?? 0;
  if (projection.cursor !== replayCursor || input.store.getCursor() !== projection.cursor) {
    throw new SubagentThreadRuntimeError(
      'ORION_SUBAGENT_PARENT_DRIFT',
      'Parent durable projection changed while capturing the child fork boundary.'
    );
  }

  const snapshots = events.filter(
    event =>
      event.payload.type === 'step.snapshot' &&
      (event.stepId === input.stepId || event.payload.data.snapshotId === input.stepId)
  );
  const capabilities = events.filter(
    event =>
      event.payload.type === 'capability.receipt' &&
      (event.stepId === input.stepId || event.payload.data.receiptId === input.requestId)
  );
  if (snapshots.length !== 1 || capabilities.length !== 1) {
    throw new SubagentThreadRuntimeError(
      'ORION_SUBAGENT_PARENT_STEP_NOT_DURABLE',
      `Parent step ${input.stepId} does not have exactly one durable StepSnapshot/CapabilityReceipt pair.`
    );
  }
  const snapshotEvent = snapshots[0];
  const capabilityEvent = capabilities[0];
  if (
    snapshotEvent.payload.type !== 'step.snapshot' ||
    capabilityEvent.payload.type !== 'capability.receipt' ||
    snapshotEvent.seq + 1 !== capabilityEvent.seq ||
    snapshotEvent.threadId !== input.threadId ||
    capabilityEvent.threadId !== input.threadId ||
    snapshotEvent.turnId !== input.turnId ||
    capabilityEvent.turnId !== input.turnId ||
    snapshotEvent.stepId !== input.stepId ||
    capabilityEvent.stepId !== input.stepId ||
    snapshotEvent.payload.data.snapshotId !== input.stepId ||
    capabilityEvent.payload.data.receiptId !== input.requestId ||
    snapshotEvent.payload.data.digest !== input.stepSnapshotDigest ||
    capabilityEvent.payload.data.digest !== input.capabilityReceiptDigest
  ) {
    throw new SubagentThreadRuntimeError(
      'ORION_SUBAGENT_PARENT_DRIFT',
      'Parent StepSnapshot/CapabilityReceipt envelope differs from the requested fork anchor.'
    );
  }
  const laterStep = events.find(
    event =>
      event.payload.type === 'step.snapshot' &&
      event.turnId === input.turnId &&
      event.seq > capabilityEvent.seq
  );
  if (laterStep) {
    throw new SubagentThreadRuntimeError(
      'ORION_SUBAGENT_PARENT_DRIFT',
      `Parent advanced beyond step ${input.stepId} before the child fork boundary.`
    );
  }

  assertParentReceiptChain(input, snapshotEvent, capabilityEvent);
  return deepFreeze({
    threadId: input.threadId,
    turnId: input.turnId,
    stepId: input.stepId,
    requestId: input.requestId,
    stepSnapshotSeq: snapshotEvent.seq,
    capabilityReceiptSeq: capabilityEvent.seq,
    stepSnapshotDigest: input.stepSnapshotDigest,
    capabilityReceiptDigest: input.capabilityReceiptDigest,
    projectionCursor: projection.cursor,
    projectionDigest: projection.digest,
  });
}

interface ParentStepSnapshotDurableReceiptV1 {
  readonly version: 1;
  readonly snapshotId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly snapshotDigest: string;
  readonly stepReceipt: CapabilityStepReceiptV1;
  readonly capabilityReceiptDigest: string;
  readonly digest: string;
}

function assertParentForkRequest(input: ParentThreadForkRequestV1): void {
  if (
    !input?.store ||
    !isRuntimeId(input.threadId) ||
    !isRuntimeId(input.turnId) ||
    !isRuntimeId(input.stepId) ||
    !isRuntimeId(input.requestId) ||
    input.store.threadId !== input.threadId ||
    !input.stepSnapshotDigest.trim() ||
    !input.capabilityReceiptDigest.trim() ||
    typeof input.flush !== 'function'
  ) {
    throw new SubagentThreadRuntimeError(
      'ORION_SUBAGENT_INVALID_REQUEST',
      'Parent fork requires matching thread/turn/step/request identities and both receipt digests.'
    );
  }
}

function assertParentReceiptChain(
  input: ParentThreadForkRequestV1,
  snapshotEvent: RuntimeEventEnvelopeV1,
  capabilityEvent: RuntimeEventEnvelopeV1
): void {
  if (
    snapshotEvent.payload.type !== 'step.snapshot' ||
    capabilityEvent.payload.type !== 'capability.receipt'
  ) {
    parentDrift('Parent fork events are not a StepSnapshot/CapabilityReceipt pair.');
  }
  const persistedSnapshot = parseReceiptObject(
    snapshotEvent.payload.data.receipt,
    'StepSnapshot'
  ) as unknown as ParentStepSnapshotDurableReceiptV1;
  const capabilityReceipt = parseReceiptObject(
    capabilityEvent.payload.data.receipt,
    'CapabilityReceipt'
  ) as unknown as CapabilityReceiptV1;
  const stepReceipt = persistedSnapshot.stepReceipt;
  if (!isRecord(stepReceipt)) parentDrift('Parent StepSnapshot is missing its step receipt.');

  assertReceiptDigest(persistedSnapshot, 'Parent StepSnapshot receipt');
  assertReceiptDigest(stepReceipt, 'Parent CapabilityStep receipt');
  assertReceiptDigest(capabilityReceipt, 'Parent Capability receipt');

  if (
    persistedSnapshot.version !== 1 ||
    persistedSnapshot.snapshotId !== input.stepId ||
    persistedSnapshot.threadId !== input.threadId ||
    persistedSnapshot.turnId !== input.turnId ||
    persistedSnapshot.stepId !== input.stepId ||
    persistedSnapshot.snapshotDigest !== input.stepSnapshotDigest ||
    persistedSnapshot.capabilityReceiptDigest !== input.capabilityReceiptDigest ||
    stepReceipt.version !== 1 ||
    stepReceipt.threadId !== input.threadId ||
    stepReceipt.turnId !== input.turnId ||
    stepReceipt.stepId !== input.stepId ||
    stepReceipt.snapshotDigest !== input.stepSnapshotDigest ||
    stepReceipt.capabilityReceiptDigest !== input.capabilityReceiptDigest ||
    capabilityReceipt.version !== 1 ||
    capabilityReceipt.requestId !== input.requestId ||
    capabilityReceipt.threadId !== input.threadId ||
    capabilityReceipt.turnId !== input.turnId ||
    capabilityReceipt.stepId !== input.stepId ||
    capabilityReceipt.digest !== input.capabilityReceiptDigest
  ) {
    parentDrift('Parent step receipt identity or digest chain is inconsistent.');
  }
}

function assertReceiptDigest(value: object & { readonly digest?: unknown }, label: string): void {
  const record = value as Readonly<Record<string, unknown>>;
  const digest = record.digest;
  if (typeof digest !== 'string') parentDrift(`${label} has no digest.`);
  const content = { ...record };
  delete content.digest;
  if (digestRuntimeValue(content) !== digest) parentDrift(`${label} digest is invalid.`);
}

function parseReceiptObject(serialized: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    parentDrift(`${label} is not valid JSON.`);
  }
  if (!isRecord(value)) parentDrift(`${label} is not an object.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parentDrift(message: string): never {
  throw new SubagentThreadRuntimeError('ORION_SUBAGENT_PARENT_DRIFT', message);
}

function replayAllEvents(store: ThreadEventStore): readonly RuntimeEventEnvelopeV1[] {
  const events: RuntimeEventEnvelopeV1[] = [];
  let cursor = 0;
  while (true) {
    const page = store.replay(cursor);
    events.push(...page.events);
    if (!page.hasMore) return events;
    if (page.nextCursor <= cursor) parentDrift('Parent event replay cursor did not advance.');
    cursor = page.nextCursor;
  }
}

function validateOptions(options: SubagentThreadRuntimeOptionsV1): ValidatedSubagentOptions {
  if (!options.childStoreRootDir.trim()) {
    throw new SubagentThreadRuntimeError(
      'ORION_SUBAGENT_INVALID_REQUEST',
      'childStoreRootDir is required.'
    );
  }
  const childStoreRootDir = resolve(options.childStoreRootDir);
  return {
    childStoreRootDir,
    tree: options.tree,
    rolePolicies: options.rolePolicies,
    createAgentLoop: options.createAgentLoop,
    eventStoreOptions: options.eventStoreOptions,
    defaultBudget: validateBudgetRequest(
      options.defaultBudget ?? { maxModelRequests: 6, maxToolCalls: 24 }
    ),
    maxObjectiveBytes: positiveInteger(options.maxObjectiveBytes ?? 64 * 1024, 'maxObjectiveBytes'),
    maxSummaryBytes: positiveInteger(options.maxSummaryBytes ?? 16 * 1024, 'maxSummaryBytes'),
    maxEvidenceItems: positiveInteger(options.maxEvidenceItems ?? 32, 'maxEvidenceItems'),
    maxEvidenceBytes: positiveInteger(options.maxEvidenceBytes ?? 2 * 1024, 'maxEvidenceBytes'),
    threadIdFactory: options.threadIdFactory ?? createRuntimeId,
    clock: options.clock ?? Date.now,
    onReceipt: options.onReceipt,
  };
}

function validateBudgetRequest(
  input: SubagentThreadBudgetRequestV1
): SubagentThreadBudgetRequestV1 {
  return Object.freeze({
    maxModelRequests: positiveInteger(input.maxModelRequests, 'child maxModelRequests'),
    maxToolCalls: nonNegativeInteger(input.maxToolCalls, 'child maxToolCalls'),
  });
}

function assertAuthority(authority: AuthoritySnapshotV1, label: string): void {
  const { digest, ...content } = authority;
  if (
    !authority.authorityId.trim() ||
    !authority.projectRoot.trim() ||
    !['allow', 'ask', 'deny'].includes(authority.confirmation) ||
    !['workspace', 'full'].includes(authority.filesystem) ||
    !['deny', 'read', 'write'].includes(authority.network) ||
    digestRuntimeValue(content) !== digest
  ) {
    throw new SubagentThreadRuntimeError(
      'ORION_SUBAGENT_AUTHORITY_INVALID',
      `${label} AuthoritySnapshotV1 failed integrity validation.`
    );
  }
}

function intersectProjectRoots(parentRoot: string, roleRoot: string): string {
  const parent = resolve(parentRoot);
  const role = resolve(roleRoot);
  if (isWithin(parent, role)) return role;
  if (isWithin(role, parent)) return parent;
  throw new SubagentThreadRuntimeError(
    'ORION_SUBAGENT_AUTHORITY_INVALID',
    'Parent and role project roots do not overlap.'
  );
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function moreRestrictive<T extends string>(left: T, right: T, order: readonly T[]): T {
  return order[Math.max(order.indexOf(left), order.indexOf(right))];
}

function assertIndependentStepSnapshots(
  parentStepSnapshotDigest: string,
  child: TurnCommitV1,
  terminal: 'completed' | 'failed' | 'interrupted'
): void {
  if (terminal === 'completed' && child.stepSnapshotDigests.length === 0) {
    throw new SubagentThreadRuntimeError(
      'ORION_SUBAGENT_CHILD_SNAPSHOT_INVALID',
      'A completed child AgentLoop must persist an independent StepSnapshotV1.'
    );
  }
  if (child.stepSnapshotDigests.includes(parentStepSnapshotDigest)) {
    throw new SubagentThreadRuntimeError(
      'ORION_SUBAGENT_CHILD_SNAPSHOT_INVALID',
      'Child StepSnapshotV1 aliases a parent snapshot digest.'
    );
  }
}

function childStopDecision(
  commit: TurnCommitV1,
  terminal: 'completed' | 'failed' | 'interrupted',
  usage: SubagentThreadUsageV1,
  limits: SubagentThreadBudgetRequestV1,
  parent: ParentThreadForkAnchorV1
): StopDecision {
  const parsed = parseStopDecision(commit);
  const status: StopDecisionStatus =
    terminal === 'interrupted' ? 'cancelled' : terminal === 'failed' ? 'failed' : 'completed';
  const base =
    parsed ??
    createStopDecision({
      scope: 'subagent',
      status,
      disposition: status === 'completed' ? 'finish_scope' : 'resume_allowed',
      reason: {
        code: `subagent_${status}`,
        message:
          status === 'completed'
            ? 'Child Thread completed its assigned scope.'
            : `Child Thread ended with ${status}.`,
      },
      evidence: [],
      nextActions:
        status === 'completed'
          ? [{ kind: 'inspect', label: 'Inspect and reconcile child evidence.' }]
          : [{ kind: 'retry', label: 'Retry only after inspecting the child receipt.' }],
      resources: {},
    });
  return createStopDecision({
    ...base,
    scope: 'subagent',
    evidence: [
      ...base.evidence,
      {
        kind: 'runtime',
        source: 'subagent-thread-runtime',
        detail: `Forked from durable parent step ${parent.stepId} (${parent.capabilityReceiptDigest}).`,
      },
    ],
    resources: {
      ...base.resources,
      llmRequests: { used: usage.modelRequests, limit: limits.maxModelRequests },
      toolCalls: { used: usage.toolCalls, limit: limits.maxToolCalls },
    },
  });
}

function parseStopDecision(commit: TurnCommitV1): StopDecision | undefined {
  if (!commit.stopDecision) return undefined;
  let value: StopDecision;
  try {
    value = JSON.parse(commit.stopDecision) as StopDecision;
  } catch {
    throw childResultError('Child TurnCommit stopDecision is not JSON.');
  }
  if (
    value.schemaVersion !== 1 ||
    !['completed', 'stopped', 'blocked', 'cancelled', 'failed'].includes(value.status) ||
    !['finish_scope', 'pause_scope', 'resume_allowed'].includes(value.disposition) ||
    !value.reason ||
    !Array.isArray(value.evidence) ||
    !Array.isArray(value.nextActions) ||
    !value.resources ||
    digestRuntimeValue(value) !== commit.stopDecisionDigest
  ) {
    throw childResultError('Child TurnCommit stopDecision failed schema or digest validation.');
  }
  return value;
}

function boundedChildSummary(
  projection: ReturnType<ThreadEventStore['loadProjection']>,
  turnId: string,
  commit: TurnCommitV1,
  maxBytes: number
): string {
  const turn = projection.turns[turnId];
  const assistant = turn?.itemIds
    .map(itemId => projection.items[itemId])
    .filter(item => item.kind === 'message' && item.role === 'assistant' && item.content)
    .at(-1)?.content;
  const fallback =
    commit.outcome ||
    commit.error ||
    commit.reason ||
    `Child Thread ended with ${commit.terminal}.`;
  return truncateUtf8((assistant || fallback).trim(), maxBytes);
}

function boundedEvidence(
  collected: readonly SubagentThreadEvidenceV1[],
  commit: TurnCommitV1,
  maxItems: number,
  maxBytes: number
): readonly SubagentThreadEvidenceV1[] {
  const items = collected.slice(0, maxItems).map(item => ({ ...item }));
  if (items.length === 0) {
    items.push({
      kind: 'runtime',
      source: 'subagent-thread-runtime',
      detail: truncateUtf8('Child completed without separately reported task evidence.', maxBytes),
      reference: truncateUtf8(commit.digest, maxBytes),
    });
  }
  return deepFreeze(items);
}

function linkAbortSignals(signals: readonly (AbortSignal | undefined)[]): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  for (const signal of signals) {
    if (!signal) continue;
    const listener = (): void => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    };
    if (signal.aborted) listener();
    else {
      signal.addEventListener('abort', listener, { once: true });
      listeners.push({ signal, listener });
    }
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const entry of listeners) {
        entry.signal.removeEventListener('abort', entry.listener);
      }
    },
  };
}

function forwardAbort(signal: AbortSignal | undefined, target: AbortController): () => void {
  if (!signal) return () => undefined;
  const listener = (): void => {
    if (!target.signal.aborted) target.abort(signal.reason);
  };
  if (signal.aborted) listener();
  else signal.addEventListener('abort', listener, { once: true });
  return () => signal.removeEventListener('abort', listener);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal: AbortSignal): SubagentThreadRuntimeError {
  return new SubagentThreadRuntimeError('ORION_SUBAGENT_ABORTED', abortMessage(signal));
}

function abortMessage(signal: AbortSignal): string {
  return signal.reason instanceof Error
    ? signal.reason.message
    : String(signal.reason || 'Subagent Thread was aborted.');
}

function childBudgetError(
  ownerId: string,
  resource: string,
  limit: number
): SubagentThreadRuntimeError {
  return new SubagentThreadRuntimeError(
    'ORION_SUBAGENT_TREE_BUDGET_EXCEEDED',
    `Child ${ownerId} exceeded its ${resource} reservation (${limit}).`
  );
}

function childResultError(message: string): SubagentThreadRuntimeError {
  return new SubagentThreadRuntimeError('ORION_SUBAGENT_CHILD_RESULT_INVALID', message);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const next = Buffer.byteLength(character, 'utf8');
    if (bytes + next > maxBytes) break;
    result += character;
    bytes += next;
  }
  return result;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SubagentThreadRuntimeError(
      'ORION_SUBAGENT_INVALID_REQUEST',
      `${name} must be a positive safe integer.`
    );
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SubagentThreadRuntimeError(
      'ORION_SUBAGENT_INVALID_REQUEST',
      `${name} must be a non-negative safe integer.`
    );
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
