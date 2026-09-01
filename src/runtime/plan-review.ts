import { randomUUID } from 'crypto';

import type { OrionRuntimeV1 } from './orion-runtime-v1';
import { digestRuntimeValue } from './protocol/canonical';
import type { ThreadEventStore } from './thread-event-store';
import type { PlanReviewProjectionV1, ThreadProjectionV1 } from './thread-projection';
import { parsePlanReceiptV1, parseTurnCommitV1, type PlanReceiptV1 } from './turn-commit';

export type PlanReviewActionV1 = 'approve' | 'continue' | 'cancel';

export interface PlanReviewResolutionReceiptV1 {
  readonly receiptId: string;
  readonly state: PlanReviewProjectionV1;
  readonly admission:
    | { readonly status: 'started'; readonly turnId: string }
    | { readonly status: 'queued'; readonly queueId: string }
    | { readonly status: 'already_admitted' | 'cancelled' }
    | { readonly status: 'pending'; readonly reason: string };
  readonly digest: string;
}

export class PlanReviewControlError extends Error {
  constructor(
    readonly code: 'runtime_busy' | 'plan_review_stale' | 'plan_review_invalid',
    message: string
  ) {
    super(message);
    this.name = 'PlanReviewControlError';
  }
}

/** Persist an awaiting-review authority for a newly committed PlanReceipt. */
export function ensurePlanReviewRequestedV1(
  store: ThreadEventStore,
  receipt: PlanReceiptV1,
  createdModel: string
): PlanReviewProjectionV1 {
  const projection = store.loadProjection();
  const current = projection.planReview;
  if (current?.planDigest === receipt.planDigest && current.planReceiptDigest === receipt.digest) {
    return current;
  }
  if (current?.status === 'awaiting_review') {
    throw new PlanReviewControlError(
      'plan_review_invalid',
      'Another durable plan is already awaiting review.'
    );
  }
  const reviewId = randomUUID();
  const revision = randomUUID();
  store.appendDurable({
    turnId: receipt.turnId,
    payload: {
      type: 'plan.review_requested',
      data: {
        reviewId,
        revision,
        planDigest: receipt.planDigest,
        planReceiptDigest: receipt.digest,
        createdAt: receipt.createdAt,
        createdModel: createdModel.trim() || 'unknown-model',
        returnMode: receipt.returnMode,
      },
    },
  });
  const requested = store.loadProjection().planReview;
  if (!requested || requested.reviewId !== reviewId) {
    throw new PlanReviewControlError(
      'plan_review_invalid',
      'Durable plan review request was not projected.'
    );
  }
  return requested;
}

/** Resolve the exact pending plan and admit any follow-on request separately. */
export function resolvePlanReviewV1(
  runtime: OrionRuntimeV1,
  input: {
    readonly planDigest: string;
    readonly action: PlanReviewActionV1;
    readonly feedback?: string;
  }
): PlanReviewResolutionReceiptV1 {
  const projection = runtime.thread.getProjection();
  if (projection.activeTurnId) {
    throw new PlanReviewControlError(
      'runtime_busy',
      'The active logical request must finish before reviewing its plan.'
    );
  }
  const current = projection.planReview;
  if (!current || current.status !== 'awaiting_review' || current.planDigest !== input.planDigest) {
    throw new PlanReviewControlError(
      'plan_review_stale',
      'The plan review no longer matches the latest awaiting plan.'
    );
  }
  const feedback = input.feedback?.trim();
  if (input.action === 'continue' && !feedback) {
    throw new PlanReviewControlError(
      'plan_review_invalid',
      'Continue planning requires non-empty feedback.'
    );
  }
  if (input.action !== 'continue' && feedback) {
    throw new PlanReviewControlError(
      'plan_review_invalid',
      'Feedback is accepted only when continuing planning.'
    );
  }
  requireBoundPlanReceipt(projection, current);

  const revision = randomUUID();
  runtime.graph.eventStore.appendDurable({
    payload: {
      type: 'plan.review_resolved',
      data: {
        reviewId: current.reviewId,
        previousRevision: current.revision,
        revision,
        planDigest: current.planDigest,
        action: input.action,
        resolvedAt: Date.now(),
        ...(feedback ? { feedback, feedbackDigest: digestRuntimeValue(feedback) } : {}),
      },
    },
  });
  const resolved = runtime.thread.getProjection().planReview;
  if (!resolved || resolved.revision !== revision) {
    throw new PlanReviewControlError(
      'plan_review_invalid',
      'Durable plan review resolution was not projected.'
    );
  }
  const admission = admitResolvedPlanReviewV1(runtime, resolved);
  const content = {
    version: 1 as const,
    receiptId: randomUUID(),
    state: resolved,
    admission,
  };
  return Object.freeze({ ...content, digest: digestRuntimeValue(content) });
}

/** Recover the crash gap between a durable resolution and its turn admission. */
export function recoverResolvedPlanReviewV1(
  runtime: OrionRuntimeV1
): PlanReviewResolutionReceiptV1['admission'] {
  const review = runtime.thread.getProjection().planReview;
  if (!review || review.status === 'awaiting_review') {
    return { status: 'pending', reason: 'awaiting_review' };
  }
  return admitResolvedPlanReviewV1(runtime, review);
}

export function findPlanReceiptForReviewV1(
  projection: ThreadProjectionV1,
  review: PlanReviewProjectionV1
): PlanReceiptV1 {
  return requireBoundPlanReceipt(projection, review);
}

function admitResolvedPlanReviewV1(
  runtime: OrionRuntimeV1,
  review: PlanReviewProjectionV1
): PlanReviewResolutionReceiptV1['admission'] {
  if (review.status === 'cancelled') return { status: 'cancelled' };
  if (review.status !== 'approved' && review.status !== 'continued') {
    return { status: 'pending', reason: 'awaiting_review' };
  }
  const input = planReviewTurnInput(review);
  const projection = runtime.thread.getProjection();
  if (
    Object.values(projection.turns).some(turn => turn.input === input) ||
    projection.queue.some(item => item.input === input)
  ) {
    return { status: 'already_admitted' };
  }
  const result = runtime.thread.dispatch({
    type: 'turn.start',
    data: {
      input,
      mode: review.status === 'approved' ? 'build' : 'plan',
    },
  });
  if (result.status === 'started') return { status: 'started', turnId: result.turnId };
  if (result.status === 'queued') return { status: 'queued', queueId: result.queueId };
  return {
    status: 'pending',
    reason: result.status === 'rejected' ? result.reason : `unexpected_${result.status}`,
  };
}

function planReviewTurnInput(review: PlanReviewProjectionV1): string {
  const authority = [
    '[Orion Plan Review V1]',
    `reviewId=${review.reviewId}`,
    `planDigest=${review.planDigest}`,
  ];
  if (review.status === 'approved') {
    return [
      ...authority,
      'action=approve',
      'Execute the approved durable plan in BUILD mode. Verify the implementation before finishing.',
    ].join('\n');
  }
  return [
    ...authority,
    'action=continue',
    'Revise the durable plan using this review feedback:',
    review.feedback ?? '',
  ].join('\n');
}

function requireBoundPlanReceipt(
  projection: ThreadProjectionV1,
  review: PlanReviewProjectionV1
): PlanReceiptV1 {
  for (const turn of Object.values(projection.turns)) {
    if (!turn.commit) continue;
    const commit = parseTurnCommitV1(turn.commit.receipt);
    if (!commit.planReceipt) continue;
    const receipt = parsePlanReceiptV1(commit.planReceipt);
    if (
      receipt.planDigest === review.planDigest &&
      receipt.digest === review.planReceiptDigest &&
      commit.planReceiptDigest === receipt.digest
    ) {
      return receipt;
    }
  }
  throw new PlanReviewControlError(
    'plan_review_invalid',
    'The awaiting review is not bound to a valid durable PlanReceipt.'
  );
}
