/**
 * v0.3.28 — the bounded single-pass code-review runner (docs/plan/
 * v0.3.28-plan.md S2). Wires the frozen PR0 contract and the PR1 snapshot
 * reader into an executable review: a typed selector is resolved to a frozen
 * Git snapshot, the snapshot material is assembled into a bounded prompt, one
 * model completion is requested, and the output is validated against the
 * contract before a digest-verifiable `CodeReviewResultV1` receipt is built.
 *
 * Read-only posture: the runner performs no writes inside the reviewed
 * repository — git runs read-only with argument arrays, working files are read
 * through the contained reader, and the model receives the frozen material
 * inline instead of an open tool surface. `REVIEW_WORKFLOW_CONSTRAINTS` is
 * bound into the receipt's rules digest so receipts record the policy that
 * governed the run.
 */
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { randomBytes } from 'crypto';
import { readFile as readFilePromise } from 'fs/promises';
import { dirname, join, resolve } from 'path';

import {
  DEFAULT_REVIEW_BUDGETS,
  computeReceiptDigest,
  resolveReviewBudgets,
  resolveReviewConclusion,
  validateReviewFinding,
  type CodeReviewResultV1,
  type ReviewBudgetsV1,
  type ReviewCoverageV1,
  type ReviewFindingV1,
  type ReviewSelectorV1,
} from './contract';
import { REVIEW_WORKFLOW_CONSTRAINTS } from './constraints';
import {
  ReviewSnapshotError,
  captureReviewSnapshot,
  createContainedWorktreeReader,
  reviewUnifiedDiffArgs,
  type CodeReviewSnapshotV1,
  type ReviewGitRunner,
} from './snapshot';

/** One bounded model completion. CLI wiring adapts `LLMService.chat`. */
export interface ReviewModelAdapterV1 {
  complete(messages: readonly { readonly role: 'system' | 'user'; readonly content: string }[]): Promise<{
    readonly content: string;
    readonly model: string;
    readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  }>;
}

export interface ReviewRunIdentityV1 {
  readonly workspaceIdentity: string;
  readonly sessionId: string;
  readonly threadId: string;
  readonly turnId: string;
}

export interface ReviewRunOptionsV1 {
  readonly cwd: string;
  readonly selector: ReviewSelectorV1;
  readonly adapter: ReviewModelAdapterV1;
  readonly identity: ReviewRunIdentityV1;
  readonly budgets?: Partial<ReviewBudgetsV1>;
  readonly abortSignal?: AbortSignal;
  readonly runGit?: ReviewGitRunner;
  readonly now?: () => number;
}

export type ReviewRunFailureV1 =
  | { readonly kind: 'budget'; readonly field: string }
  | { readonly kind: 'snapshot'; readonly code: string; readonly message: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'model_error'; readonly message: string }
  | { readonly kind: 'unparsable_output'; readonly message: string };

export type ReviewRunOutcomeV1 =
  | { readonly ok: true; readonly result: CodeReviewResultV1 }
  | { readonly ok: false; readonly failure: ReviewRunFailureV1 };

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Production git runner: argument arrays, no shell, read-only profile is the
 *  caller's responsibility (the runner only issues read commands). */
export function createProcessGitRunner(cwd: string): ReviewGitRunner {
  return async (args: readonly string[]) =>
    new Promise<string>((resolvePromise, reject) => {
      execFile(
        'git',
        args as string[],
        { cwd, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`git ${args.join(' ')} failed: ${stderr || error.message}`));
            return;
          }
          resolvePromise(stdout);
        }
      );
    });
}

/** Rules provenance: AGENTS.md contents from cwd up to the filesystem root
 *  (bounded to 16 levels), combined with the frozen read-only constraints
 *  digest. Changing the rules or the policy invalidates applicability. */
export async function computeReviewRulesDigest(cwd: string): Promise<string> {
  const chunks: string[] = [];
  let current = resolve(cwd);
  for (let depth = 0; depth < 16; depth += 1) {
    try {
      const content = await readFilePromise(join(current, 'AGENTS.md'), 'utf8');
      chunks.push(`${current}::${content}`);
    } catch {
      // No AGENTS.md at this level — fine.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return sha256(`${REVIEW_WORKFLOW_CONSTRAINTS.constraintsDigest}\n${chunks.join('\n---\n')}`);
}

/** The frozen review instruction set assembled for the model. */
export function buildReviewSystemPrompt(rulesDigest: string): string {
  return [
    'You are a strict code reviewer operating inside Orion Code.',
    'You receive a frozen snapshot of the changes under review.',
    'Report only defects introduced or worsened by these changes, with concrete evidence.',
    'Exclude pure style opinions, speculation without evidence, and duplicates.',
    'Never suggest running commands, editing files, or any other action: this review is read-only.',
    'Respond with a single JSON object of the shape {"findings":[...]} and nothing else.',
    'Each finding object needs exactly these fields:',
    '  findingId: 8-64 hex characters, stable within this response;',
    '  priority: "P0" (blocks usage, proven) | "P1" | "P2" | "P3";',
    '  title: short imperative summary;',
    '  trigger: the concrete condition under which the defect manifests;',
    '  impact: what breaks and for whom;',
    '  fileKey: copy the file key from the snapshot material verbatim;',
    '  side: "old" for removed/base lines, "new" for added/current lines;',
    '  startLine, endLine: 1-based inclusive line numbers in that side;',
    '  evidence: the code excerpt or reasoning that proves the finding.',
    `Active policy digest: ${REVIEW_WORKFLOW_CONSTRAINTS.constraintsDigest}.`,
    `Rules digest: ${rulesDigest}.`,
  ].join('\n');
}

interface SnapshotMaterial {
  readonly text: string;
  readonly truncated: boolean;
}

/** Assembles the bounded user prompt material from the frozen snapshot plus
 *  the diff text captured inside the admission window. */
function buildSnapshotMaterial(
  snapshot: CodeReviewSnapshotV1,
  diffText: string,
  budgets: ReviewBudgetsV1
): SnapshotMaterial {
  const sections: string[] = [
    `Snapshot: ${snapshot.snapshotId} (kind=${snapshot.kind}`,
    snapshot.kind === 'base' ? `base=${snapshot.baseOid} head=${snapshot.headOid})` : 'worktree scope)',
    `Input snapshot digest: ${snapshot.inputSnapshotDigest}`,
    'Changed files (fileKey -> path):',
    ...snapshot.files.map(file => {
      const sides = file.sides.map(side => side.source).join('+') || 'no-content';
      return `  ${file.fileKey} ${file.path}${file.oldPath ? ` (from ${file.oldPath})` : ''} [${sides}]`;
    }),
    snapshot.skipped.length > 0
      ? `Skipped by the host: ${snapshot.skipped.map(skip => `${skip.path} (${skip.reason})`).join('; ')}`
      : 'Skipped by the host: none',
    'Unified diff:',
    diffText,
  ];
  const text = sections.join('\n');
  if (Buffer.byteLength(text, 'utf8') <= budgets.maxBodyBytes) {
    return { text, truncated: false };
  }
  const clipped = Buffer.alloc(budgets.maxBodyBytes);
  const written = Buffer.from(text, 'utf8').subarray(0, budgets.maxBodyBytes);
  clipped.set(written);
  return { text: clipped.toString('utf8'), truncated: true };
}

function extractFindingsPayload(content: string): { findings: readonly unknown[] } | null {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? (fenced[1] as string).trim() : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (!Array.isArray(record.findings)) return null;
    return { findings: record.findings as readonly unknown[] };
  } catch {
    return null;
  }
}

function snapshotAuthorizesFile(
  snapshot: CodeReviewSnapshotV1,
  finding: ReviewFindingV1
): boolean {
  const file = snapshot.files.find(candidate => candidate.fileKey === finding.fileKey);
  if (!file) return false;
  if (finding.side === 'old' && !file.oldPath && file.hunks.every(hunk => hunk.oldLines === 0)) {
    return false;
  }
  const relevant = file.hunks.filter(hunk =>
    finding.side === 'old'
      ? hunk.oldLines > 0 && finding.startLine <= hunk.oldStart + hunk.oldLines - 1 && finding.endLine >= hunk.oldStart
      : hunk.newLines > 0 && finding.startLine <= hunk.newStart + hunk.newLines - 1 && finding.endLine >= hunk.newStart
  );
  // A finding whose lines touch no diff hunk is not anchored in the frozen
  // material; the model must cite the changes under review.
  return relevant.length > 0;
}

/**
 * Runs one bounded review. Never throws for expected review failures — the
 * outcome is typed; unexpected internal errors surface as `model_error`.
 */
export async function runCodeReview(options: ReviewRunOptionsV1): Promise<ReviewRunOutcomeV1> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const budgets = resolveReviewBudgets(options.budgets);
  if (!budgets.ok) return { ok: false, failure: { kind: 'budget', field: budgets.field } };

  const aborted = (): boolean => options.abortSignal?.aborted === true;
  if (aborted()) return { ok: false, failure: { kind: 'cancelled' } };

  const runGit = options.runGit ?? createProcessGitRunner(options.cwd);
  let snapshot: CodeReviewSnapshotV1;
  let diffText: string;
  try {
    snapshot = await captureReviewSnapshot({
      root: options.cwd,
      selector: options.selector,
      budgets: budgets.budgets,
      runGit,
      readWorktreeFile: createContainedWorktreeReader(options.cwd),
    });
    if (aborted()) return { ok: false, failure: { kind: 'cancelled' } };
    // The exact same frozen diff arguments the snapshot used, against the
    // OIDs the snapshot resolved; captured once inside the admission window
    // and never re-read afterwards.
    diffText = await runGit(
      reviewUnifiedDiffArgs(options.selector, {
        baseOid: snapshot.baseOid,
        headOid: snapshot.headOid,
      })
    );
  } catch (error) {
    const code = error instanceof ReviewSnapshotError ? error.code : 'not_a_repository';
    return {
      ok: false,
      failure: { kind: 'snapshot', code, message: error instanceof Error ? error.message : String(error) },
    };
  }

  const rulesDigest = await computeReviewRulesDigest(options.cwd);
  const limits: string[] = [];
  const budgetExhausted: string[] = [];

  if (snapshot.files.length === 0) {
    limits.push('empty_scope_no_changes');
    const endedAt = now();
    const coverage: ReviewCoverageV1 = {
      inspectedFiles: [],
      inspectedRanges: [],
      skipped: [],
      truncated: false,
      budgetExhausted: [],
    };
    const base = {
      schemaVersion: 1 as const,
      reviewId: `cr-${randomBytes(8).toString('hex')}`,
      workspaceIdentity: options.identity.workspaceIdentity,
      sessionId: options.identity.sessionId,
      threadId: options.identity.threadId,
      turnId: options.identity.turnId,
      requestedSelector: options.selector,
      resolvedTarget: {
        kind: snapshot.kind,
        ...(snapshot.baseOid ? { baseOid: snapshot.baseOid } : {}),
        ...(snapshot.headOid ? { headOid: snapshot.headOid } : {}),
        snapshotId: snapshot.snapshotId,
      },
      inputSnapshotDigest: snapshot.inputSnapshotDigest,
      rulesDigest,
      state: 'completed' as const,
      conclusion: 'no_findings' as const,
      findings: [],
      invalidFindingCount: 0,
      coverage,
      coverageAssertion: { complete: true },
      limits,
      model: { provider: 'none', model: 'none' },
      usage: { inputTokens: 0, outputTokens: 0 },
      startedAt,
      endedAt,
    };
    return { ok: true, result: Object.freeze({ ...base, receiptDigest: computeReceiptDigest(base) }) };
  }

  const material = buildSnapshotMaterial(snapshot, diffText, budgets.budgets);
  if (material.truncated) {
    budgetExhausted.push('maxBodyBytes');
    limits.push('prompt_material_truncated');
  }

  if (aborted()) return { ok: false, failure: { kind: 'cancelled' } };

  let completion: Awaited<ReturnType<ReviewModelAdapterV1['complete']>>;
  try {
    completion = await options.adapter.complete([
      { role: 'system', content: buildReviewSystemPrompt(rulesDigest) },
      { role: 'user', content: material.text },
    ]);
  } catch (error) {
    return {
      ok: false,
      failure: {
        kind: 'model_error',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const durationExceeded = now() - startedAt > budgets.budgets.maxDurationMs;
  if (durationExceeded) budgetExhausted.push('maxDurationMs');

  const payload = extractFindingsPayload(completion.content);
  if (!payload) {
    return {
      ok: false,
      failure: {
        kind: 'unparsable_output',
        message: 'The model response did not contain a {"findings":[...]} JSON object.',
      },
    };
  }

  const validFindings: ReviewFindingV1[] = [];
  let invalidFindingCount = 0;
  for (const raw of payload.findings) {
    const validated = validateReviewFinding(raw);
    if (!validated.valid) {
      invalidFindingCount += 1;
      continue;
    }
    if (validFindings.length >= budgets.budgets.maxFindings) {
      invalidFindingCount += 1;
      budgetExhausted.push('maxFindings');
      continue;
    }
    if (!snapshotAuthorizesFile(snapshot, validated.finding)) {
      invalidFindingCount += 1;
      continue;
    }
    validFindings.push(validated.finding);
  }

  const truncated = material.truncated || budgetExhausted.includes('maxFindings');
  const coverage: ReviewCoverageV1 = {
    inspectedFiles: snapshot.files.map(file => file.path),
    inspectedRanges: [],
    skipped: snapshot.skipped.map(skip => ({
      fileKey: skip.path,
      reason: skip.reason,
      ...(skip.detail ? { detail: skip.detail } : {}),
    })),
    truncated,
    budgetExhausted: [...new Set(budgetExhausted)],
  };
  const coverageComplete =
    snapshot.skipped.length === 0 && !truncated && !durationExceeded && !material.truncated;

  let state: CodeReviewResultV1['state'] = 'completed';
  if (aborted()) return { ok: false, failure: { kind: 'cancelled' } };
  if (truncated || durationExceeded || snapshot.skipped.length > 0) state = 'partial';

  const conclusion = resolveReviewConclusion({
    state,
    validFindingCount: validFindings.length,
    invalidFindingCount,
    coverageComplete,
  });

  const base = {
    schemaVersion: 1 as const,
    reviewId: `cr-${randomBytes(8).toString('hex')}`,
    workspaceIdentity: options.identity.workspaceIdentity,
    sessionId: options.identity.sessionId,
    threadId: options.identity.threadId,
    turnId: options.identity.turnId,
    requestedSelector: options.selector,
    resolvedTarget: {
      kind: snapshot.kind,
      ...(snapshot.baseOid ? { baseOid: snapshot.baseOid } : {}),
      ...(snapshot.headOid ? { headOid: snapshot.headOid } : {}),
      snapshotId: snapshot.snapshotId,
    },
    inputSnapshotDigest: snapshot.inputSnapshotDigest,
    rulesDigest,
    state,
    conclusion,
    findings: Object.freeze(validFindings),
    invalidFindingCount,
    coverage,
    coverageAssertion: { complete: coverageComplete },
    limits,
    model: { provider: 'orion-llm', model: completion.model },
    usage: {
      inputTokens: completion.usage?.inputTokens ?? 0,
      outputTokens: completion.usage?.outputTokens ?? 0,
    },
    startedAt,
    endedAt: now(),
  };
  const result: CodeReviewResultV1 = Object.freeze({
    ...base,
    receiptDigest: computeReceiptDigest(base),
  });
  return { ok: true, result };
}

export { DEFAULT_REVIEW_BUDGETS };
