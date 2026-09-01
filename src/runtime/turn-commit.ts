import { randomUUID } from 'crypto';

import type { Message } from '../services/llm';
import { assertToolCallGroups } from '../services/compact/tool-call-groups';
import type { HarnessState } from '../harness/types';
import type { StopDecision } from '../framework/stop-decision';
import { canonicalRuntimeJson, digestRuntimeValue } from './protocol/canonical';
import { isRuntimeId } from './protocol/runtime-protocol-v1';
import { ThreadEventStore } from './thread-event-store';

export type TurnCommitTerminalV1 =
  | { readonly status: 'completed'; readonly outcome?: string }
  | { readonly status: 'failed'; readonly error: string }
  | { readonly status: 'interrupted'; readonly reason?: string };

export type PlanExecutionModeV1 = 'build' | 'auto';

/** Product-owned input; the journal binds it to the authoritative turn facts. */
export interface PlanTurnCommitInputV1 {
  readonly plan: string;
  readonly returnMode: PlanExecutionModeV1;
  readonly promptReceiptDigest: string;
}

/**
 * Atomic receipt for the PLAN -> execution boundary.
 *
 * The plan body is intentionally persisted here as well as in history so the
 * next logical turn never has to infer which assistant message was approved as
 * the executable plan. Every other field binds it to the same TurnCommit.
 */
export interface PlanReceiptV1 {
  readonly version: 1;
  readonly threadId: string;
  readonly turnId: string;
  readonly plan: string;
  readonly planDigest: string;
  readonly returnMode: PlanExecutionModeV1;
  readonly historyDigest: string;
  readonly taskContextDigest: string;
  readonly taskContextRevision: number;
  readonly stopDecisionDigest: string;
  readonly capabilityReceiptDigests: readonly string[];
  readonly toolReceiptDigests: readonly string[];
  readonly promptReceiptDigest: string;
  readonly createdAt: number;
  readonly digest: string;
}

export interface ThreadTurnCommitInputV1 {
  readonly commitId?: string;
  readonly turnId: string;
  readonly history: readonly Message[];
  readonly taskContextState: HarnessState;
  readonly taskContextRevision: number;
  readonly terminal: TurnCommitTerminalV1;
  readonly goalState?: unknown;
  readonly compactPointer?: unknown;
  readonly stopDecision?: StopDecision;
  readonly plan?: PlanTurnCommitInputV1;
  readonly createdAt?: number;
}

export interface TurnCommitV1 {
  readonly version: 1;
  readonly commitId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly sourceCursor: number;
  readonly terminal: 'completed' | 'failed' | 'interrupted';
  readonly outcome?: string;
  readonly error?: string;
  readonly reason?: string;
  readonly history: string;
  readonly historyDigest: string;
  readonly taskContext: string;
  readonly taskContextDigest: string;
  readonly taskContextRevision: number;
  readonly goalState?: string;
  readonly goalStateDigest?: string;
  readonly compactPointer?: string;
  readonly compactPointerDigest?: string;
  readonly stopDecision?: string;
  readonly stopDecisionDigest?: string;
  readonly planReceipt?: string;
  readonly planReceiptDigest?: string;
  readonly stepSnapshotDigests: readonly string[];
  readonly capabilityReceiptDigests: readonly string[];
  readonly toolReceiptDigests: readonly string[];
  readonly createdAt: number;
  readonly digest: string;
}

export class TurnCommitError extends Error {
  constructor(
    readonly code:
      | 'ORION_TURN_COMMIT_INVALID'
      | 'ORION_TURN_COMMIT_CONFLICT'
      | 'ORION_TURN_COMMIT_OPEN_ITEM',
    message: string
  ) {
    super(message);
    this.name = 'TurnCommitError';
  }
}

/** Atomic durable owner for transcript, TaskContext, Goal, compact and receipts. */
export class ThreadTurnCommitJournalV1 {
  constructor(
    private readonly store: ThreadEventStore,
    private readonly clock: () => number = Date.now
  ) {}

  commit(input: ThreadTurnCommitInputV1): TurnCommitV1 {
    validateInput(this.store.threadId, input);
    assertToolCallGroups(input.history);
    const projection = this.store.loadProjection();
    const turn = projection.turns[input.turnId];
    if (!turn || turn.status !== 'active' || projection.activeTurnId !== input.turnId) {
      throw new TurnCommitError(
        'ORION_TURN_COMMIT_INVALID',
        `Turn ${input.turnId} is not the active turn`
      );
    }
    if (input.plan && turn.mode !== 'plan') {
      throw new TurnCommitError(
        'ORION_TURN_COMMIT_INVALID',
        `Turn ${input.turnId} cannot attach a Plan receipt from mode ${turn.mode}`
      );
    }
    const openItem = turn.itemIds
      .map(itemId => projection.items[itemId])
      .find(item => item.status === 'started');
    if (openItem) {
      throw new TurnCommitError(
        'ORION_TURN_COMMIT_OPEN_ITEM',
        `Item ${openItem.itemId} has no durable terminal outcome`
      );
    }

    const receiptEvents = [] as ReturnType<ThreadEventStore['replay']>['events'][number][];
    let cursor = 0;
    while (true) {
      const page = this.store.replay(cursor, undefined, 'turn_commit_journal');
      receiptEvents.push(...page.events.filter(event => event.turnId === input.turnId));
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    const capabilityReceiptDigests = receiptEvents
      .filter(event => event.payload.type === 'capability.receipt')
      .map(event => (event.payload.type === 'capability.receipt' ? event.payload.data.digest : ''));
    const stepSnapshotDigests = receiptEvents
      .filter(event => event.payload.type === 'step.snapshot')
      .map(event => (event.payload.type === 'step.snapshot' ? event.payload.data.digest : ''));
    const toolReceiptDigests = receiptEvents
      .filter(event => event.payload.type === 'tool.receipt')
      .map(event =>
        event.payload.type === 'tool.receipt' ? event.payload.data.receiptDigest : ''
      );

    const commit = createTurnCommitV1({
      ...input,
      commitId: input.commitId ?? randomUUID(),
      threadId: this.store.threadId,
      sourceCursor: projection.cursor,
      stepSnapshotDigests,
      capabilityReceiptDigests,
      toolReceiptDigests,
      createdAt: input.createdAt ?? this.clock(),
    });
    if (turn.commit) {
      const existing = parseTurnCommitV1(turn.commit.receipt);
      if (sameSemanticCommit(existing, commit)) return existing;
      throw new TurnCommitError(
        'ORION_TURN_COMMIT_CONFLICT',
        `Turn ${input.turnId} already has a different durable commit`
      );
    }

    this.store.appendDurable({
      turnId: input.turnId,
      payload: {
        type: 'turn.committed',
        data: {
          commitId: commit.commitId,
          terminal: commit.terminal,
          digest: commit.digest,
          receipt: canonicalRuntimeJson(commit),
          ...(commit.outcome === undefined ? {} : { outcome: commit.outcome }),
          ...(commit.error === undefined ? {} : { error: commit.error }),
          ...(commit.reason === undefined ? {} : { reason: commit.reason }),
        },
      },
    });
    return commit;
  }
}

export function createTurnCommitV1(
  input: Omit<
    TurnCommitV1,
    | 'version'
    | 'terminal'
    | 'history'
    | 'historyDigest'
    | 'taskContext'
    | 'taskContextDigest'
    | 'goalState'
    | 'goalStateDigest'
    | 'compactPointer'
    | 'compactPointerDigest'
    | 'stopDecision'
    | 'stopDecisionDigest'
    | 'planReceipt'
    | 'planReceiptDigest'
    | 'digest'
  > &
    Pick<
      ThreadTurnCommitInputV1,
      | 'history'
      | 'taskContextState'
      | 'goalState'
      | 'compactPointer'
      | 'stopDecision'
      | 'plan'
      | 'terminal'
    >
): TurnCommitV1 {
  const history = canonicalRuntimeJson(input.history);
  const taskContext = canonicalRuntimeJson(input.taskContextState);
  const goalState =
    input.goalState === undefined ? undefined : canonicalRuntimeJson(input.goalState);
  const compactPointer =
    input.compactPointer === undefined ? undefined : canonicalRuntimeJson(input.compactPointer);
  const stopDecision =
    input.stopDecision === undefined ? undefined : canonicalRuntimeJson(input.stopDecision);
  const historyDigest = digestRuntimeValue(input.history);
  const taskContextDigest = digestRuntimeValue(input.taskContextState);
  const stopDecisionDigest =
    input.stopDecision === undefined ? undefined : digestRuntimeValue(input.stopDecision);
  const planReceipt = input.plan
    ? createPlanReceiptV1({
        ...input.plan,
        threadId: input.threadId,
        turnId: input.turnId,
        historyDigest,
        taskContextDigest,
        taskContextRevision: input.taskContextRevision,
        stopDecisionDigest: stopDecisionDigest as string,
        capabilityReceiptDigests: input.capabilityReceiptDigests,
        toolReceiptDigests: input.toolReceiptDigests,
        createdAt: input.createdAt,
      })
    : undefined;
  const planReceiptJson = planReceipt ? canonicalRuntimeJson(planReceipt) : undefined;
  const content = {
    version: 1 as const,
    commitId: input.commitId,
    threadId: input.threadId,
    turnId: input.turnId,
    sourceCursor: input.sourceCursor,
    terminal: input.terminal.status,
    ...(input.terminal.status === 'completed' && input.terminal.outcome !== undefined
      ? { outcome: input.terminal.outcome }
      : {}),
    ...(input.terminal.status === 'failed' ? { error: input.terminal.error } : {}),
    ...(input.terminal.status === 'interrupted' && input.terminal.reason !== undefined
      ? { reason: input.terminal.reason }
      : {}),
    history,
    historyDigest,
    taskContext,
    taskContextDigest,
    taskContextRevision: input.taskContextRevision,
    ...(goalState === undefined
      ? {}
      : { goalState, goalStateDigest: digestRuntimeValue(input.goalState) }),
    ...(compactPointer === undefined
      ? {}
      : {
          compactPointer,
          compactPointerDigest: digestRuntimeValue(input.compactPointer),
        }),
    ...(stopDecision === undefined ? {} : { stopDecision, stopDecisionDigest }),
    ...(planReceiptJson === undefined
      ? {}
      : { planReceipt: planReceiptJson, planReceiptDigest: planReceipt!.digest }),
    capabilityReceiptDigests: [...input.capabilityReceiptDigests],
    stepSnapshotDigests: [...input.stepSnapshotDigests],
    toolReceiptDigests: [...input.toolReceiptDigests],
    createdAt: input.createdAt,
  };
  return deepFreeze({ ...content, digest: digestRuntimeValue(content) });
}

export function parseTurnCommitV1(receipt: string): TurnCommitV1 {
  let parsed: TurnCommitV1;
  try {
    parsed = JSON.parse(receipt) as TurnCommitV1;
  } catch {
    throw new TurnCommitError('ORION_TURN_COMMIT_INVALID', 'Turn commit is not valid JSON');
  }
  const { digest, ...content } = parsed;
  if (
    parsed.version !== 1 ||
    typeof digest !== 'string' ||
    digestRuntimeValue(content) !== digest
  ) {
    throw new TurnCommitError('ORION_TURN_COMMIT_INVALID', 'Turn commit integrity failed');
  }
  if (parsed.planReceipt !== undefined) {
    const planReceipt = parsePlanReceiptV1(parsed.planReceipt);
    assertPlanReceiptBinding(parsed, planReceipt);
  } else if (parsed.planReceiptDigest !== undefined) {
    throw new TurnCommitError(
      'ORION_TURN_COMMIT_INVALID',
      'Turn commit has a Plan receipt digest without its receipt'
    );
  }
  return deepFreeze(parsed);
}

export function createPlanReceiptV1(
  input: Omit<PlanReceiptV1, 'version' | 'planDigest' | 'digest'>
): PlanReceiptV1 {
  const content = {
    version: 1 as const,
    threadId: input.threadId,
    turnId: input.turnId,
    plan: input.plan.trim(),
    planDigest: digestRuntimeValue(input.plan.trim()),
    returnMode: input.returnMode,
    historyDigest: input.historyDigest,
    taskContextDigest: input.taskContextDigest,
    taskContextRevision: input.taskContextRevision,
    stopDecisionDigest: input.stopDecisionDigest,
    capabilityReceiptDigests: [...input.capabilityReceiptDigests],
    toolReceiptDigests: [...input.toolReceiptDigests],
    promptReceiptDigest: input.promptReceiptDigest,
    createdAt: input.createdAt,
  };
  validatePlanReceiptContent(content);
  return deepFreeze({ ...content, digest: digestRuntimeValue(content) });
}

export function parsePlanReceiptV1(receipt: string): PlanReceiptV1 {
  let parsed: PlanReceiptV1;
  try {
    parsed = JSON.parse(receipt) as PlanReceiptV1;
  } catch {
    throw new TurnCommitError('ORION_TURN_COMMIT_INVALID', 'Plan receipt is not valid JSON');
  }
  const { digest, ...content } = parsed;
  validatePlanReceiptContent(content);
  if (typeof digest !== 'string' || digestRuntimeValue(content) !== digest) {
    throw new TurnCommitError('ORION_TURN_COMMIT_INVALID', 'Plan receipt integrity failed');
  }
  return deepFreeze(parsed);
}

function validateInput(threadId: string, input: ThreadTurnCommitInputV1): void {
  if (!isRuntimeId(threadId) || !isRuntimeId(input.turnId)) {
    throw new TurnCommitError(
      'ORION_TURN_COMMIT_INVALID',
      'Thread and turn identities must be UUIDs'
    );
  }
  if (input.commitId && !isRuntimeId(input.commitId)) {
    throw new TurnCommitError('ORION_TURN_COMMIT_INVALID', 'commitId must be a UUID');
  }
  if (!Number.isSafeInteger(input.taskContextRevision) || input.taskContextRevision < 0) {
    throw new TurnCommitError(
      'ORION_TURN_COMMIT_INVALID',
      'TaskContext revision must be a non-negative safe integer'
    );
  }
  if (input.terminal.status === 'failed' && !input.terminal.error.trim()) {
    throw new TurnCommitError('ORION_TURN_COMMIT_INVALID', 'Failed turn requires an error');
  }
  if (input.plan) {
    if (input.terminal.status !== 'completed') {
      throw new TurnCommitError(
        'ORION_TURN_COMMIT_INVALID',
        'A Plan receipt requires a completed turn'
      );
    }
    if (!input.stopDecision) {
      throw new TurnCommitError(
        'ORION_TURN_COMMIT_INVALID',
        'A Plan receipt requires a typed StopDecision'
      );
    }
    if (!input.plan.plan.trim()) {
      throw new TurnCommitError('ORION_TURN_COMMIT_INVALID', 'Plan content must not be empty');
    }
    if (!['build', 'auto'].includes(input.plan.returnMode)) {
      throw new TurnCommitError('ORION_TURN_COMMIT_INVALID', 'Plan return mode is invalid');
    }
    if (!input.plan.promptReceiptDigest.trim()) {
      throw new TurnCommitError(
        'ORION_TURN_COMMIT_INVALID',
        'Plan prompt receipt digest must not be empty'
      );
    }
  }
}

function sameSemanticCommit(left: TurnCommitV1, right: TurnCommitV1): boolean {
  return (
    left.turnId === right.turnId &&
    left.terminal === right.terminal &&
    left.outcome === right.outcome &&
    left.error === right.error &&
    left.reason === right.reason &&
    left.historyDigest === right.historyDigest &&
    left.taskContextDigest === right.taskContextDigest &&
    left.taskContextRevision === right.taskContextRevision &&
    left.goalStateDigest === right.goalStateDigest &&
    left.compactPointerDigest === right.compactPointerDigest &&
    left.stopDecisionDigest === right.stopDecisionDigest &&
    sameSemanticPlanReceipt(left, right) &&
    canonicalRuntimeJson(left.capabilityReceiptDigests) ===
      canonicalRuntimeJson(right.capabilityReceiptDigests) &&
    canonicalRuntimeJson(left.stepSnapshotDigests) ===
      canonicalRuntimeJson(right.stepSnapshotDigests) &&
    canonicalRuntimeJson(left.toolReceiptDigests) === canonicalRuntimeJson(right.toolReceiptDigests)
  );
}

function sameSemanticPlanReceipt(left: TurnCommitV1, right: TurnCommitV1): boolean {
  if (!left.planReceipt || !right.planReceipt) {
    return left.planReceipt === right.planReceipt;
  }
  const leftReceipt = parsePlanReceiptV1(left.planReceipt);
  const rightReceipt = parsePlanReceiptV1(right.planReceipt);
  return (
    leftReceipt.planDigest === rightReceipt.planDigest &&
    leftReceipt.returnMode === rightReceipt.returnMode &&
    leftReceipt.promptReceiptDigest === rightReceipt.promptReceiptDigest
  );
}

function validatePlanReceiptContent(input: Omit<PlanReceiptV1, 'digest'>): void {
  if (
    input.version !== 1 ||
    !isRuntimeId(input.threadId) ||
    !isRuntimeId(input.turnId) ||
    !input.plan.trim() ||
    digestRuntimeValue(input.plan) !== input.planDigest ||
    !['build', 'auto'].includes(input.returnMode) ||
    !Number.isSafeInteger(input.taskContextRevision) ||
    input.taskContextRevision < 0 ||
    !Number.isFinite(input.createdAt) ||
    input.createdAt < 0 ||
    !input.historyDigest.trim() ||
    !input.taskContextDigest.trim() ||
    !input.stopDecisionDigest.trim() ||
    input.capabilityReceiptDigests.length === 0 ||
    input.capabilityReceiptDigests.some(digest => !digest.trim()) ||
    input.toolReceiptDigests.some(digest => !digest.trim()) ||
    !input.promptReceiptDigest.trim()
  ) {
    throw new TurnCommitError('ORION_TURN_COMMIT_INVALID', 'Plan receipt content is invalid');
  }
}

function assertPlanReceiptBinding(commit: TurnCommitV1, receipt: PlanReceiptV1): void {
  if (
    commit.planReceiptDigest !== receipt.digest ||
    commit.threadId !== receipt.threadId ||
    commit.turnId !== receipt.turnId ||
    commit.historyDigest !== receipt.historyDigest ||
    commit.taskContextDigest !== receipt.taskContextDigest ||
    commit.taskContextRevision !== receipt.taskContextRevision ||
    commit.stopDecisionDigest !== receipt.stopDecisionDigest ||
    canonicalRuntimeJson(commit.capabilityReceiptDigests) !==
      canonicalRuntimeJson(receipt.capabilityReceiptDigests) ||
    canonicalRuntimeJson(commit.toolReceiptDigests) !==
      canonicalRuntimeJson(receipt.toolReceiptDigests)
  ) {
    throw new TurnCommitError(
      'ORION_TURN_COMMIT_INVALID',
      'Plan receipt is not bound to its authoritative TurnCommit'
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return value;
}
