/**
 * v0.3.27 PR0 — the shared code-review contract, frozen before any runtime
 * wiring. This module is the single source of truth for review selectors,
 * states, conclusions, findings, budgets and receipt digests; CLI and Web both
 * consume it and neither may redefine the semantics locally (goal G3: one
 * engine, one contract).
 *
 * Design sources: docs/plan/v0.3.27-plan.md §4 (identity, state, conclusions),
 * §4.3 (bounded resources), §5 (read-only execution). The conclusion mapping
 * encodes the plan's rule that tool success is not review success: a partial,
 * failed, cancelled or untrustworthy output can never surface as a green
 * "no findings".
 */
import { digestRuntimeValue } from '../../runtime/protocol/canonical';

/** v0.3.27 §3.1 — what a review examines. Parsed once, frozen at admission. */
export type ReviewSelectorV1 =
  | { readonly kind: 'worktree'; readonly paths?: readonly string[] }
  | { readonly kind: 'base'; readonly ref: string; readonly paths?: readonly string[] };

/** v0.3.27 §4.1 — run states. `queued`/`running` never carry a conclusion. */
export type ReviewRunStateV1 =
  | 'queued'
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled';

/** v0.3.27 §4.1 — terminal conclusions. Absence can only be asserted when the
 *  state is `completed`, coverage is complete and the output contained no
 *  invalid findings; everything else maps to findings or inconclusive. */
export type ReviewConclusionV1 = 'findings' | 'no_findings' | 'inconclusive';

/** v0.3.27 §6.1 — a stored result's applicability after code or rules change.
 *  History is never rewritten; staleness is an annotation, not an edit. */
export type ReviewApplicabilityV1 = 'current' | 'stale';

/** Priority levels. P0 requires evidence that the defect blocks usage without
 *  special preconditions; the definition is frozen here and in PR0 tests. */
export type ReviewFindingPriorityV1 = 'P0' | 'P1' | 'P2' | 'P3';

/** v0.3.27 §4.1 — one review finding. `fileKey` is validated for shape here;
 *  membership against the frozen snapshot manifest happens at Host validation
 *  time (PR1+), never in the model's favor. */
export interface ReviewFindingV1 {
  readonly findingId: string;
  readonly priority: ReviewFindingPriorityV1;
  readonly title: string;
  /** The condition under which the defect manifests — not a style opinion. */
  readonly trigger: string;
  readonly impact: string;
  readonly fileKey: string;
  readonly side: 'old' | 'new';
  readonly startLine: number;
  readonly endLine: number;
  readonly evidence: string;
}

/** Coverage is evidence, not a count: what was actually inspected, what was
 *  skipped and why, and where truncation or budget exhaustion occurred. */
export interface ReviewCoverageV1 {
  readonly inspectedFiles: readonly string[];
  readonly inspectedRanges: readonly {
    readonly fileKey: string;
    readonly startLine: number;
    readonly endLine: number;
  }[];
  readonly skipped: readonly {
    readonly fileKey: string;
    readonly reason:
      | 'over_budget_files'
      | 'over_budget_bytes'
      | 'binary'
      | 'sensitive'
      | 'unreadable'
      | 'changed_during_review'
      | 'other';
    readonly detail?: string;
  }[];
  readonly truncated: boolean;
  readonly budgetExhausted: readonly string[];
}

/** Whether the declared coverage is internally consistent and complete for the
 *  resolved selector — computed by the Host from the frozen manifest, never
 *  taken from the model's self-report (§4.1). */
export interface ReviewCoverageAssertionV1 {
  readonly complete: boolean;
  readonly reason?: string;
}

/** v0.3.27 §4.1 — the persisted receipt. `receiptDigest` covers the canonical
 *  form of everything above it and is recomputed on read. */
export interface CodeReviewResultV1 {
  readonly schemaVersion: 1;
  readonly reviewId: string;
  readonly workspaceIdentity: string;
  readonly sessionId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly requestedSelector: ReviewSelectorV1;
  /** The actually resolved target (commit OIDs, snapshot ids), not the request. */
  readonly resolvedTarget: {
    readonly kind: 'worktree' | 'base';
    readonly baseOid?: string;
    readonly headOid?: string;
    readonly snapshotId: string;
  };
  /** Digest of the frozen input snapshot; a stored result is stale when this
   *  no longer matches the current snapshot digest for the same selector. */
  readonly inputSnapshotDigest: string;
  readonly rulesDigest: string;
  readonly state: ReviewRunStateV1;
  readonly conclusion: ReviewConclusionV1;
  readonly findings: readonly ReviewFindingV1[];
  /** Findings that failed validation — counted and surfaced, never silently
   *  dropped (dropping them must not turn the run into no_findings). */
  readonly invalidFindingCount: number;
  readonly coverage: ReviewCoverageV1;
  readonly coverageAssertion: ReviewCoverageAssertionV1;
  readonly limits: readonly string[];
  readonly model: { readonly provider: string; readonly model: string };
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly startedAt: number;
  readonly endedAt: number;
  readonly receiptDigest: string;
}

/** Budgets are ceilings that may only be tightened (§4.3): a provider with a
 *  smaller window takes the stricter value; nothing may widen them at runtime. */
export interface ReviewBudgetsV1 {
  readonly maxFiles: number;
  readonly maxBodyBytes: number;
  readonly maxDiffBytes: number;
  readonly maxReadToolCalls: number;
  readonly maxDurationMs: number;
  readonly maxFindings: number;
  readonly maxResultBytes: number;
}

export const DEFAULT_REVIEW_BUDGETS: ReviewBudgetsV1 = Object.freeze({
  maxFiles: 50,
  maxBodyBytes: 2 * 1024 * 1024,
  maxDiffBytes: 1024 * 1024,
  maxReadToolCalls: 50,
  maxDurationMs: 5 * 60 * 1000,
  maxFindings: 100,
  maxResultBytes: 256 * 1024,
});

/** Text size caps for finding fields, in characters. Chosen so 100 maximal
 *  findings stay well inside the 256 KiB result bound. */
export const FINDING_TEXT_LIMITS = Object.freeze({
  title: 200,
  trigger: 2000,
  impact: 2000,
  evidence: 4000,
  fileKey: 1024,
});

const FINDING_ID_PATTERN = /^[0-9a-f]{8,64}$/iu;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** Validates one model-produced finding against the frozen shape. Returns the
 *  finding unchanged when valid; a typed reason when not. Membership against
 *  the snapshot manifest is a separate Host check (PR1+). */
export function validateReviewFinding(value: unknown):
  | { readonly valid: true; readonly finding: ReviewFindingV1 }
  | {
      readonly valid: false;
      readonly reason:
        | 'not_an_object'
        | 'finding_id_invalid'
        | 'priority_invalid'
        | 'title_invalid'
        | 'trigger_invalid'
        | 'impact_invalid'
        | 'file_key_invalid'
        | 'side_invalid'
        | 'line_range_invalid'
        | 'evidence_invalid';
    } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, reason: 'not_an_object' };
  }
  const candidate = value as Record<string, unknown>;
  const text = (field: string): string =>
    typeof candidate[field] === 'string' ? (candidate[field] as string) : '';
  if (typeof candidate.findingId !== 'string' || !FINDING_ID_PATTERN.test(candidate.findingId)) {
    return { valid: false, reason: 'finding_id_invalid' };
  }
  if (
    candidate.priority !== 'P0' &&
    candidate.priority !== 'P1' &&
    candidate.priority !== 'P2' &&
    candidate.priority !== 'P3'
  ) {
    return { valid: false, reason: 'priority_invalid' };
  }
  const title = text('title').trim();
  if (!title || title.length > FINDING_TEXT_LIMITS.title) {
    return { valid: false, reason: 'title_invalid' };
  }
  const trigger = text('trigger').trim();
  if (!trigger || trigger.length > FINDING_TEXT_LIMITS.trigger) {
    return { valid: false, reason: 'trigger_invalid' };
  }
  const impact = text('impact').trim();
  if (!impact || impact.length > FINDING_TEXT_LIMITS.impact) {
    return { valid: false, reason: 'impact_invalid' };
  }
  const fileKey = text('fileKey');
  if (
    !fileKey ||
    fileKey.length > FINDING_TEXT_LIMITS.fileKey ||
    fileKey.startsWith('/') ||
    fileKey.includes('\0') ||
    fileKey.split('/').includes('..')
  ) {
    return { valid: false, reason: 'file_key_invalid' };
  }
  if (candidate.side !== 'old' && candidate.side !== 'new') {
    return { valid: false, reason: 'side_invalid' };
  }
  const startLine = candidate.startLine;
  const endLine = candidate.endLine;
  if (
    !Number.isSafeInteger(startLine) ||
    (startLine as number) < 1 ||
    !Number.isSafeInteger(endLine) ||
    (endLine as number) < (startLine as number)
  ) {
    return { valid: false, reason: 'line_range_invalid' };
  }
  const evidence = text('evidence').trim();
  if (!evidence || evidence.length > FINDING_TEXT_LIMITS.evidence) {
    return { valid: false, reason: 'evidence_invalid' };
  }
  return {
    valid: true,
    finding: Object.freeze({
      findingId: candidate.findingId,
      priority: candidate.priority as ReviewFindingPriorityV1,
      title,
      trigger,
      impact,
      fileKey,
      side: candidate.side as 'old' | 'new',
      startLine: startLine as number,
      endLine: endLine as number,
      evidence,
    }),
  };
}

/**
 * v0.3.27 §4.1 — the conclusion mapping, frozen as code so CLI and Web cannot
 * diverge. The invariants:
 * - `queued`/`running` results carry no conclusion (callers must not call this).
 * - A state that is not `completed` can never conclude `no_findings`.
 * - Invalid findings make the output untrustworthy: zero valid findings with
 *   invalid ones present is `inconclusive`, never a green pass.
 * - Zero findings without complete coverage is `inconclusive`, never a green
 *   pass ("不静默截断后宣布全部完成").
 */
export function resolveReviewConclusion(input: {
  readonly state: ReviewRunStateV1;
  readonly validFindingCount: number;
  readonly invalidFindingCount: number;
  readonly coverageComplete: boolean;
}): ReviewConclusionV1 {
  if (input.state === 'queued' || input.state === 'running') {
    throw new Error('A queued or running review cannot have a terminal conclusion.');
  }
  if (input.state === 'failed' || input.state === 'cancelled') {
    return 'inconclusive';
  }
  if (input.validFindingCount > 0) {
    return 'findings';
  }
  if (input.state === 'partial') {
    return 'inconclusive';
  }
  // state === 'completed'
  if (input.invalidFindingCount > 0) {
    return 'inconclusive';
  }
  return input.coverageComplete ? 'no_findings' : 'inconclusive';
}

/** Applies the budgets with the tighten-only rule: every override must be a
 *  safe integer at or below the frozen default, otherwise the run is refused
 *  rather than silently widened. */
export function resolveReviewBudgets(
  overrides: Partial<ReviewBudgetsV1> = {}
):
  | { readonly ok: true; readonly budgets: ReviewBudgetsV1 }
  | { readonly ok: false; readonly field: string } {
  const resolved: Record<string, number> = {};
  for (const [field, ceiling] of Object.entries(DEFAULT_REVIEW_BUDGETS) as [
    keyof ReviewBudgetsV1,
    number,
  ][]) {
    const requested = overrides[field];
    if (requested === undefined) {
      resolved[field] = ceiling;
      continue;
    }
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > ceiling) {
      return { ok: false, field };
    }
    resolved[field] = requested;
  }
  return {
    ok: true,
    budgets: Object.freeze(resolved) as unknown as ReviewBudgetsV1,
  };
}

/** Marks a stored result's applicability against the current input snapshot and
 *  rules digests. The receipt itself is never rewritten. */
export function reviewApplicability(
  result: Pick<CodeReviewResultV1, 'inputSnapshotDigest' | 'rulesDigest'>,
  current: { readonly inputSnapshotDigest: string; readonly rulesDigest: string }
): ReviewApplicabilityV1 {
  return result.inputSnapshotDigest === current.inputSnapshotDigest &&
    result.rulesDigest === current.rulesDigest
    ? 'current'
    : 'stale';
}

/** The receipt digest covers the canonical form of the result with the digest
 *  field itself excluded, so verification is a recomputation, not a lookup. */
export function computeReceiptDigest(result: Omit<CodeReviewResultV1, 'receiptDigest'>): string {
  const content: Record<string, unknown> = { ...result };
  delete content.receiptDigest;
  const digest = digestRuntimeValue(content);
  return DIGEST_PATTERN.test(digest) ? digest : digest.toLowerCase();
}

/** Verifies a stored receipt by recomputing its digest. */
export function verifyReceiptDigest(result: CodeReviewResultV1): boolean {
  const { receiptDigest, ...content } = result;
  return computeReceiptDigest(content) === receiptDigest;
}
