import { digestRuntimeValue } from './protocol/canonical';
import type { RuntimeEventEnvelopeV1, RuntimeEventTypeV1 } from './protocol/runtime-protocol-v1';
import type { CompactRuntimeEventV1 } from './compact-transaction';

export type ThreadProjectionStatusV1 = 'new' | 'active' | 'idle';
export type TurnProjectionStatusV1 = 'active' | 'completed' | 'failed' | 'interrupted';
/**
 * Version of the canonical content included in a Thread projection digest.
 *
 * Version 1 predates head-only diagnostic and compact lifecycle fields.
 * Version 2 covers the complete current projection shape.
 */
export type ThreadProjectionDigestVersionV1 = 1 | 2;
export const CURRENT_THREAD_PROJECTION_DIGEST_VERSION_V1: ThreadProjectionDigestVersionV1 = 2;
export type ItemProjectionStatusV1 =
  | 'started'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'indeterminate';

export interface ItemProjectionV1 {
  readonly itemId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly kind: string;
  readonly role?: string;
  readonly name?: string;
  readonly inputDigest?: string;
  readonly intent?: string;
  readonly status: ItemProjectionStatusV1;
  readonly startedSeq: number;
  readonly terminalSeq?: number;
  readonly summary?: string;
  readonly content?: string;
  readonly receipt?: string;
  readonly error?: string;
}

export interface TurnProjectionV1 {
  readonly turnId: string;
  readonly status: TurnProjectionStatusV1;
  readonly mode: string;
  readonly input: string;
  readonly startedSeq: number;
  readonly terminalSeq?: number;
  readonly itemIds: readonly string[];
  readonly steeringItemIds: readonly string[];
  readonly interruptIntentId?: string;
  readonly commit?: TurnCommitProjectionV1;
}

export interface TurnCommitProjectionV1 {
  readonly commitId: string;
  readonly terminal: 'completed' | 'failed' | 'interrupted';
  readonly digest: string;
  readonly receipt: string;
  readonly outcome?: string;
  readonly error?: string;
  readonly reason?: string;
  readonly seq: number;
}

export interface QueuedTurnProjectionV1 {
  readonly queueId: string;
  readonly input: string;
  readonly mode: string;
  readonly kind: 'regular' | 'goal' | 'maintenance';
  readonly source: 'start' | 'follow_up';
  readonly enqueuedAt: number;
  readonly deadline: number;
  readonly queuedSeq: number;
}

export interface PlanReviewProjectionV1 {
  readonly reviewId: string;
  readonly revision: string;
  readonly planDigest: string;
  readonly planReceiptDigest: string;
  readonly status: 'awaiting_review' | 'approved' | 'continued' | 'cancelled';
  readonly createdAt: number;
  readonly createdModel: string;
  readonly returnMode: 'build' | 'auto';
  readonly requestedSeq: number;
  readonly resolvedAt?: number;
  readonly resolvedSeq?: number;
  readonly feedback?: string;
  readonly feedbackDigest?: string;
}

export interface ThreadDiagnosticEventsV1 {
  readonly latestCapability?: RuntimeEventEnvelopeV1;
  readonly latestStepSnapshot?: RuntimeEventEnvelopeV1;
}

export interface ThreadProjectionV1 {
  readonly version: 1;
  readonly threadId: string;
  readonly cursor: number;
  readonly status: ThreadProjectionStatusV1;
  readonly activeTurnId?: string;
  readonly turns: Readonly<Record<string, TurnProjectionV1>>;
  readonly items: Readonly<Record<string, ItemProjectionV1>>;
  readonly queue: readonly QueuedTurnProjectionV1[];
  readonly planReview?: PlanReviewProjectionV1;
  /** Missing only on projections written before diagnostics became head-only. */
  readonly diagnosticEvents?: ThreadDiagnosticEventsV1;
  /**
   * Compact lifecycle facts retained by new projections so fresh-process
   * orphan recovery does not have to replay the full authoritative JSONL.
   * Missing means a projection written by an older Orion version and forces
   * the store to take the verified scan fallback.
   */
  readonly compactEvents?: readonly RuntimeEventEnvelopeV1<CompactRuntimeEventV1>[];
  readonly stepSnapshotDigests: readonly string[];
  readonly capabilityReceiptDigests: readonly string[];
  readonly toolInvocationIds: readonly string[];
  readonly digest: string;
}

interface MutableThreadProjectionV1 {
  version: 1;
  threadId: string;
  cursor: number;
  status: ThreadProjectionStatusV1;
  activeTurnId?: string;
  turns: Record<string, TurnProjectionV1>;
  items: Record<string, ItemProjectionV1>;
  queue: QueuedTurnProjectionV1[];
  planReview?: PlanReviewProjectionV1;
  diagnosticEvents: {
    latestCapability?: RuntimeEventEnvelopeV1;
    latestStepSnapshot?: RuntimeEventEnvelopeV1;
  };
  compactEvents: RuntimeEventEnvelopeV1<CompactRuntimeEventV1>[];
  stepSnapshotDigests: string[];
  capabilityReceiptDigests: string[];
  toolInvocationIds: string[];
}

export class ThreadProjectionInvariantError extends Error {
  readonly code = 'ORION_THREAD_PROJECTION_INVARIANT';

  constructor(
    message: string,
    readonly seq: number,
    readonly eventType: RuntimeEventTypeV1
  ) {
    super(`Thread projection invariant failed at seq ${seq} (${eventType}): ${message}`);
    this.name = 'ThreadProjectionInvariantError';
  }
}

export function projectThreadEvents(
  threadId: string,
  events: readonly RuntimeEventEnvelopeV1[]
): ThreadProjectionV1 {
  const state: MutableThreadProjectionV1 = {
    version: 1,
    threadId,
    cursor: 0,
    status: 'new',
    turns: {},
    items: {},
    queue: [],
    diagnosticEvents: {},
    compactEvents: [],
    stepSnapshotDigests: [],
    capabilityReceiptDigests: [],
    toolInvocationIds: [],
  };

  for (const event of events) applyThreadEvent(state, event);

  return freezeProjection(state);
}

/**
 * Advance an already verified projection with a contiguous durable event tail.
 *
 * ThreadEventStore uses this after it has verified that the underlying log head
 * still matches its in-process cache. Re-projecting thousands of historical
 * facts for every append made streaming latency grow with the lifetime of a
 * Session; cloning the bounded projection and applying only the new tail keeps
 * the same invariants without re-reading old facts.
 */
export function advanceThreadProjection(
  projection: ThreadProjectionV1,
  events: readonly RuntimeEventEnvelopeV1[]
): ThreadProjectionV1 {
  if (!verifyThreadProjectionDigest(projection)) {
    throw new Error('Cannot advance a Thread projection with an invalid digest');
  }
  if (events.length === 0) return projection;

  const state: MutableThreadProjectionV1 = {
    version: 1,
    threadId: projection.threadId,
    cursor: projection.cursor,
    status: projection.status,
    ...(projection.activeTurnId ? { activeTurnId: projection.activeTurnId } : {}),
    turns: Object.fromEntries(
      Object.entries(projection.turns).map(([id, turn]) => [
        id,
        {
          ...turn,
          itemIds: [...turn.itemIds],
          steeringItemIds: [...turn.steeringItemIds],
        },
      ])
    ),
    items: Object.fromEntries(
      Object.entries(projection.items).map(([id, item]) => [id, { ...item }])
    ),
    queue: projection.queue.map(item => ({ ...item })),
    ...(projection.planReview ? { planReview: { ...projection.planReview } } : {}),
    diagnosticEvents: projection.diagnosticEvents
      ? structuredClone(projection.diagnosticEvents)
      : {},
    compactEvents: (projection.compactEvents ?? []).map(event => structuredClone(event)),
    stepSnapshotDigests: [...projection.stepSnapshotDigests],
    capabilityReceiptDigests: [...projection.capabilityReceiptDigests],
    toolInvocationIds: [...projection.toolInvocationIds],
  };
  for (const event of events) applyThreadEvent(state, event);
  return freezeProjection(state);
}

export function applyThreadEvent(
  state: MutableThreadProjectionV1,
  event: RuntimeEventEnvelopeV1
): void {
  const type = event.payload.type;
  if (event.durability !== 'durable') {
    throw invariant('ephemeral events cannot change the durable projection', event);
  }
  if (event.threadId !== state.threadId) throw invariant('threadId mismatch', event);
  if (event.seq !== state.cursor + 1) {
    throw invariant(`expected seq ${state.cursor + 1}, received ${event.seq}`, event);
  }

  switch (type) {
    case 'thread.started':
      if (state.status !== 'new') throw invariant('thread already started', event);
      state.status = 'idle';
      break;
    case 'thread.resumed':
    case 'thread.forked':
      if (state.status === 'new') state.status = 'idle';
      break;
    case 'turn.started':
      startTurn(state, event);
      break;
    case 'turn.queued':
      queueTurn(state, event);
      break;
    case 'turn.queue_expired':
      expireQueuedTurn(state, event);
      break;
    case 'turn.steered':
      steerTurn(state, event);
      break;
    case 'turn.interrupt_requested':
      requestTurnInterrupt(state, event);
      break;
    case 'turn.committed':
      commitTurn(state, event);
      break;
    case 'plan.review_requested':
      requestPlanReview(state, event);
      break;
    case 'plan.review_resolved':
      resolvePlanReview(state, event);
      break;
    case 'turn.completed':
      finishTurn(state, event, 'completed');
      break;
    case 'turn.failed':
      finishTurn(state, event, 'failed');
      break;
    case 'turn.interrupted':
      finishTurn(state, event, 'interrupted');
      break;
    case 'item.started':
      startItem(state, event);
      break;
    case 'item.completed':
      finishItem(state, event, 'completed');
      break;
    case 'item.failed':
      finishItem(state, event, 'failed');
      break;
    case 'item.interrupted':
      finishItem(state, event, 'interrupted');
      break;
    case 'item.indeterminate':
      finishItem(state, event, 'indeterminate');
      break;
    case 'step.snapshot':
      validateStepSnapshotReceipt(event);
      if (state.stepSnapshotDigests.includes(event.payload.data.digest)) {
        throw invariant('step snapshot already exists', event);
      }
      state.stepSnapshotDigests.push(event.payload.data.digest);
      state.diagnosticEvents.latestStepSnapshot = structuredClone(event);
      break;
    case 'capability.receipt':
      validateCapabilityReceipt(event);
      if (state.capabilityReceiptDigests.includes(event.payload.data.digest)) {
        throw invariant('capability receipt already exists', event);
      }
      state.capabilityReceiptDigests.push(event.payload.data.digest);
      state.diagnosticEvents.latestCapability = structuredClone(event);
      break;
    case 'tool.receipt':
      if (state.toolInvocationIds.includes(event.payload.data.invocationId)) {
        throw invariant('tool invocation already has a terminal receipt', event);
      }
      state.toolInvocationIds.push(event.payload.data.invocationId);
      break;
    case 'compact.started':
    case 'compact.completed':
    case 'compact.failed':
      state.compactEvents.push(
        structuredClone(event) as RuntimeEventEnvelopeV1<CompactRuntimeEventV1>
      );
      break;
    case 'approval.requested':
      break;
    case 'item.delta':
      throw invariant('item.delta cannot be durable', event);
  }

  state.cursor = event.seq;
}

export function verifyThreadProjectionDigest(projection: ThreadProjectionV1): boolean {
  const { digest: _digest, ...content } = projection;
  void _digest;
  return digestRuntimeValue(content) === projection.digest;
}

/**
 * Compute one explicitly versioned digest without weakening projection-file
 * integrity. This is used only for immutable cutover-prefix compatibility.
 */
export function threadProjectionDigestForVersionV1(
  projection: ThreadProjectionV1,
  version: ThreadProjectionDigestVersionV1
): string {
  const {
    digest: _digest,
    diagnosticEvents: _diagnosticEvents,
    compactEvents: _compactEvents,
    ...legacyContent
  } = projection;
  void _digest;
  if (version === 1) return digestRuntimeValue(legacyContent);
  const content = {
    ...legacyContent,
    diagnosticEvents: projection.diagnosticEvents ?? {},
    compactEvents: projection.compactEvents ?? [],
  };
  return digestRuntimeValue(content);
}

/** Resolve an exact known digest scheme; missing metadata is inferred safely. */
export function resolveThreadProjectionDigestVersionV1(
  projection: ThreadProjectionV1,
  digest: string,
  requestedVersion?: ThreadProjectionDigestVersionV1
): ThreadProjectionDigestVersionV1 | undefined {
  if (requestedVersion !== undefined) {
    if (requestedVersion !== 1 && requestedVersion !== 2) return undefined;
    return threadProjectionDigestForVersionV1(projection, requestedVersion) === digest
      ? requestedVersion
      : undefined;
  }
  for (const version of [
    CURRENT_THREAD_PROJECTION_DIGEST_VERSION_V1,
    1,
  ] as const) {
    if (threadProjectionDigestForVersionV1(projection, version) === digest) return version;
  }
  return undefined;
}

/** Older persisted projections must be rebuilt before incremental advance. */
export function hasCurrentThreadProjectionShapeV1(projection: ThreadProjectionV1): boolean {
  return projection.diagnosticEvents !== undefined && projection.compactEvents !== undefined;
}

function startTurn(state: MutableThreadProjectionV1, event: RuntimeEventEnvelopeV1): void {
  const turnId = requiredIdentity(event.turnId, 'turnId', event);
  if (state.activeTurnId) throw invariant(`turn ${state.activeTurnId} is already active`, event);
  if (state.turns[turnId]) throw invariant(`turn ${turnId} already exists`, event);
  if (state.status === 'new') throw invariant('thread must start before a turn', event);
  if (event.payload.type !== 'turn.started') throw invariant('invalid turn start payload', event);

  const queueId = event.payload.data.queueId;
  if (queueId) {
    const queueIndex = state.queue.findIndex(item => item.queueId === queueId);
    if (queueIndex < 0) throw invariant(`queued turn ${queueId} does not exist`, event);
    state.queue.splice(queueIndex, 1);
  }

  state.turns[turnId] = {
    turnId,
    status: 'active',
    mode: event.payload.data.mode,
    input: event.payload.data.input,
    startedSeq: event.seq,
    itemIds: [],
    steeringItemIds: [],
  };
  state.activeTurnId = turnId;
  state.status = 'active';
}

function queueTurn(state: MutableThreadProjectionV1, event: RuntimeEventEnvelopeV1): void {
  if (event.payload.type !== 'turn.queued') throw invariant('invalid queue payload', event);
  const data = event.payload.data;
  if (state.queue.some(item => item.queueId === data.queueId)) {
    throw invariant(`queue item ${data.queueId} already exists`, event);
  }
  state.queue.push({
    queueId: data.queueId,
    input: data.input,
    mode: data.mode,
    kind: data.kind,
    source: data.source,
    enqueuedAt: data.enqueuedAt,
    deadline: data.deadline,
    queuedSeq: event.seq,
  });
}

function expireQueuedTurn(state: MutableThreadProjectionV1, event: RuntimeEventEnvelopeV1): void {
  if (event.payload.type !== 'turn.queue_expired') {
    throw invariant('invalid queue expiry payload', event);
  }
  const queueId = event.payload.data.queueId;
  const index = state.queue.findIndex(item => item.queueId === queueId);
  if (index < 0) throw invariant(`queue item ${queueId} does not exist`, event);
  state.queue.splice(index, 1);
}

function steerTurn(state: MutableThreadProjectionV1, event: RuntimeEventEnvelopeV1): void {
  if (event.payload.type !== 'turn.steered') throw invariant('invalid steer payload', event);
  const turnId = requiredIdentity(event.turnId, 'turnId', event);
  const turn = state.turns[turnId];
  if (!turn || turn.status !== 'active' || state.activeTurnId !== turnId) {
    throw invariant(`turn ${turnId} is not active`, event);
  }
  if (turn.steeringItemIds.includes(event.payload.data.itemId)) {
    throw invariant(`steering item ${event.payload.data.itemId} already exists`, event);
  }
  state.turns[turnId] = {
    ...turn,
    steeringItemIds: [...turn.steeringItemIds, event.payload.data.itemId],
  };
}

function requestTurnInterrupt(
  state: MutableThreadProjectionV1,
  event: RuntimeEventEnvelopeV1
): void {
  if (event.payload.type !== 'turn.interrupt_requested') {
    throw invariant('invalid interrupt payload', event);
  }
  const turnId = requiredIdentity(event.turnId, 'turnId', event);
  const turn = state.turns[turnId];
  if (!turn || turn.status !== 'active' || state.activeTurnId !== turnId) {
    throw invariant(`turn ${turnId} is not active`, event);
  }
  if (turn.interruptIntentId && turn.interruptIntentId !== event.payload.data.intentId) {
    throw invariant(`turn ${turnId} already has a different interrupt intent`, event);
  }
  state.turns[turnId] = { ...turn, interruptIntentId: event.payload.data.intentId };
}

function finishTurn(
  state: MutableThreadProjectionV1,
  event: RuntimeEventEnvelopeV1,
  status: Exclude<TurnProjectionStatusV1, 'active'>
): void {
  const turnId = requiredIdentity(event.turnId, 'turnId', event);
  const turn = state.turns[turnId];
  if (!turn || turn.status !== 'active') throw invariant(`turn ${turnId} is not active`, event);
  if (state.activeTurnId !== turnId)
    throw invariant(`turn ${turnId} is not the active turn`, event);
  const openItem = turn.itemIds
    .map(itemId => state.items[itemId])
    .find(item => item.status === 'started');
  if (openItem) throw invariant(`item ${openItem.itemId} has no terminal event`, event);
  if (turn.commit && turn.commit.terminal !== status) {
    throw invariant(
      `turn ${turnId} terminal ${status} conflicts with committed ${turn.commit.terminal}`,
      event
    );
  }

  state.turns[turnId] = { ...turn, status, terminalSeq: event.seq };
  delete state.activeTurnId;
  state.status = 'idle';
}

function commitTurn(state: MutableThreadProjectionV1, event: RuntimeEventEnvelopeV1): void {
  if (event.payload.type !== 'turn.committed')
    throw invariant('invalid turn commit payload', event);
  const turnId = requiredIdentity(event.turnId, 'turnId', event);
  const turn = state.turns[turnId];
  if (!turn || turn.status !== 'active' || state.activeTurnId !== turnId) {
    throw invariant(`turn ${turnId} is not active`, event);
  }
  if (turn.commit) throw invariant(`turn ${turnId} already has a durable commit`, event);
  const openItem = turn.itemIds
    .map(itemId => state.items[itemId])
    .find(item => item.status === 'started');
  if (openItem) throw invariant(`item ${openItem.itemId} has no terminal event`, event);

  let receipt: Record<string, unknown>;
  try {
    receipt = JSON.parse(event.payload.data.receipt) as Record<string, unknown>;
  } catch {
    throw invariant('turn commit receipt is not valid JSON', event);
  }
  const { digest, ...content } = receipt;
  if (
    digest !== event.payload.data.digest ||
    digestRuntimeValue(content) !== event.payload.data.digest ||
    receipt.commitId !== event.payload.data.commitId ||
    receipt.terminal !== event.payload.data.terminal
  ) {
    throw invariant('turn commit receipt failed integrity validation', event);
  }

  state.turns[turnId] = {
    ...turn,
    commit: {
      commitId: event.payload.data.commitId,
      terminal: event.payload.data.terminal,
      digest: event.payload.data.digest,
      receipt: event.payload.data.receipt,
      outcome: event.payload.data.outcome,
      error: event.payload.data.error,
      reason: event.payload.data.reason,
      seq: event.seq,
    },
  };
}

function requestPlanReview(state: MutableThreadProjectionV1, event: RuntimeEventEnvelopeV1): void {
  if (event.payload.type !== 'plan.review_requested') {
    throw invariant('invalid plan review request payload', event);
  }
  const turnId = requiredIdentity(event.turnId, 'turnId', event);
  const turn = state.turns[turnId];
  if (!turn?.commit) throw invariant('plan review requires a committed planning turn', event);
  if (state.planReview?.status === 'awaiting_review') {
    throw invariant('another plan is already awaiting review', event);
  }

  let commit: Record<string, unknown>;
  let receipt: Record<string, unknown>;
  try {
    commit = JSON.parse(turn.commit.receipt) as Record<string, unknown>;
    receipt = JSON.parse(String(commit.planReceipt ?? '')) as Record<string, unknown>;
  } catch {
    throw invariant('plan review is not bound to a valid PlanReceipt', event);
  }
  const { digest, ...content } = receipt;
  const data = event.payload.data;
  if (
    commit.planReceiptDigest !== data.planReceiptDigest ||
    digest !== data.planReceiptDigest ||
    digestRuntimeValue(content) !== data.planReceiptDigest ||
    receipt.planDigest !== data.planDigest ||
    receipt.threadId !== state.threadId ||
    receipt.turnId !== turnId
  ) {
    throw invariant('plan review failed PlanReceipt integrity validation', event);
  }

  state.planReview = {
    reviewId: data.reviewId,
    revision: data.revision,
    planDigest: data.planDigest,
    planReceiptDigest: data.planReceiptDigest,
    status: 'awaiting_review',
    createdAt: data.createdAt,
    createdModel: data.createdModel,
    returnMode: data.returnMode,
    requestedSeq: event.seq,
  };
}

function resolvePlanReview(state: MutableThreadProjectionV1, event: RuntimeEventEnvelopeV1): void {
  if (event.payload.type !== 'plan.review_resolved') {
    throw invariant('invalid plan review resolution payload', event);
  }
  const current = state.planReview;
  const data = event.payload.data;
  if (!current || current.status !== 'awaiting_review') {
    throw invariant('no plan is awaiting review', event);
  }
  if (
    current.reviewId !== data.reviewId ||
    current.revision !== data.previousRevision ||
    current.planDigest !== data.planDigest
  ) {
    throw invariant('plan review resolution is stale', event);
  }
  if (data.action === 'continue' && (!data.feedback || !data.feedbackDigest)) {
    throw invariant('continue plan review requires a feedback digest', event);
  }
  const feedback = data.feedback?.trim();
  if (data.action === 'continue' && digestRuntimeValue(feedback) !== data.feedbackDigest) {
    throw invariant('plan review feedback digest is invalid', event);
  }
  if (data.action !== 'continue' && (data.feedback || data.feedbackDigest)) {
    throw invariant('only continue plan review may bind feedback', event);
  }
  state.planReview = {
    ...current,
    revision: data.revision,
    status:
      data.action === 'approve'
        ? 'approved'
        : data.action === 'continue'
          ? 'continued'
          : 'cancelled',
    resolvedAt: data.resolvedAt,
    resolvedSeq: event.seq,
    ...(feedback ? { feedback } : {}),
    ...(data.feedbackDigest ? { feedbackDigest: data.feedbackDigest } : {}),
  };
}

function startItem(state: MutableThreadProjectionV1, event: RuntimeEventEnvelopeV1): void {
  const turnId = requiredIdentity(event.turnId, 'turnId', event);
  const stepId = requiredIdentity(event.stepId, 'stepId', event);
  const itemId = requiredIdentity(event.itemId, 'itemId', event);
  const turn = state.turns[turnId];
  if (!turn || turn.status !== 'active' || state.activeTurnId !== turnId) {
    throw invariant(`item ${itemId} must belong to the active turn`, event);
  }
  if (state.items[itemId]) throw invariant(`item ${itemId} already exists`, event);
  if (event.payload.type !== 'item.started') throw invariant('invalid item start payload', event);

  state.items[itemId] = {
    itemId,
    turnId,
    stepId,
    kind: event.payload.data.kind,
    role: event.payload.data.role,
    name: event.payload.data.name,
    inputDigest: event.payload.data.inputDigest,
    intent: event.payload.data.intent,
    status: 'started',
    startedSeq: event.seq,
  };
  state.turns[turnId] = { ...turn, itemIds: [...turn.itemIds, itemId] };
}

function finishItem(
  state: MutableThreadProjectionV1,
  event: RuntimeEventEnvelopeV1,
  status: Exclude<ItemProjectionStatusV1, 'started'>
): void {
  const itemId = requiredIdentity(event.itemId, 'itemId', event);
  const item = state.items[itemId];
  if (!item || item.status !== 'started') {
    throw invariant(`item ${itemId} is missing or already terminal`, event);
  }
  if (event.turnId !== item.turnId || event.stepId !== item.stepId) {
    throw invariant(`item ${itemId} identity changed before terminal event`, event);
  }

  const data = event.payload.data as {
    content?: string;
    summary?: string;
    error?: string;
    reason?: string;
    receipt?: string;
  };
  state.items[itemId] = {
    ...item,
    status,
    terminalSeq: event.seq,
    content: data.content,
    receipt: data.receipt,
    summary: data.summary,
    error: data.error ?? data.reason,
  };
}

function requiredIdentity(
  value: string | undefined,
  name: string,
  event: RuntimeEventEnvelopeV1
): string {
  if (!value) throw invariant(`${name} is required`, event);
  return value;
}

function validateStepSnapshotReceipt(event: RuntimeEventEnvelopeV1): void {
  const payload = event.payload;
  if (payload.type !== 'step.snapshot') throw invariant('invalid step snapshot payload', event);
  const receipt = parseIntegrityReceipt(payload.data.receipt, 'step snapshot', event);
  if (
    receipt.snapshotId !== payload.data.snapshotId ||
    receipt.snapshotDigest !== payload.data.digest ||
    receipt.threadId !== event.threadId ||
    receipt.turnId !== event.turnId ||
    receipt.stepId !== event.stepId
  ) {
    throw invariant('step snapshot receipt identity or digest does not match its envelope', event);
  }
}

function validateCapabilityReceipt(event: RuntimeEventEnvelopeV1): void {
  const payload = event.payload;
  if (payload.type !== 'capability.receipt') throw invariant('invalid capability payload', event);
  const receipt = parseIntegrityReceipt(payload.data.receipt, 'capability', event);
  if (
    receipt.requestId !== payload.data.receiptId ||
    receipt.threadId !== event.threadId ||
    receipt.turnId !== event.turnId ||
    receipt.stepId !== event.stepId ||
    receipt.digest !== payload.data.digest
  ) {
    throw invariant('capability receipt identity or digest does not match its envelope', event);
  }
}

function parseIntegrityReceipt(
  serialized: string,
  label: string,
  event: RuntimeEventEnvelopeV1
): Record<string, unknown> {
  let receipt: Record<string, unknown>;
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    receipt = parsed as Record<string, unknown>;
  } catch {
    throw invariant(`${label} receipt is not valid JSON`, event);
  }
  const { digest, ...content } = receipt;
  if (typeof digest !== 'string' || digestRuntimeValue(content) !== digest) {
    throw invariant(`${label} receipt failed integrity validation`, event);
  }
  return receipt;
}

function invariant(message: string, event: RuntimeEventEnvelopeV1): ThreadProjectionInvariantError {
  return new ThreadProjectionInvariantError(message, event.seq, event.payload.type);
}

function freezeProjection(state: MutableThreadProjectionV1): ThreadProjectionV1 {
  const content = {
    ...state,
    turns: Object.fromEntries(
      Object.entries(state.turns).map(([id, turn]) => [
        id,
        {
          ...turn,
          itemIds: [...turn.itemIds],
          steeringItemIds: [...turn.steeringItemIds],
        },
      ])
    ),
    items: Object.fromEntries(Object.entries(state.items).map(([id, item]) => [id, { ...item }])),
    queue: state.queue.map(item => ({ ...item })),
    diagnosticEvents: structuredClone(state.diagnosticEvents),
    compactEvents: state.compactEvents.map(event => structuredClone(event)),
    stepSnapshotDigests: [...state.stepSnapshotDigests],
    capabilityReceiptDigests: [...state.capabilityReceiptDigests],
    toolInvocationIds: [...state.toolInvocationIds],
  };
  return deepFreeze({ ...content, digest: digestRuntimeValue(content) });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return value;
}
