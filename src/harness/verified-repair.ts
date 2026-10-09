/**
 * v0.3.23 T23-C3/C4/C5 — bounded verified-repair loop and the five-state
 * completion audit.
 *
 * The loop alternates `verify` → structured attribution → caller-supplied
 * `repair` with hard bounds: `maxAttempts` (default 3, from the archived
 * AutoFixConfig semantics), an objective no-progress detector (identical
 * attribution digests on consecutive rounds), a wall-clock/cancel signal, and
 * an anti-cheat guard that maps forbidden repair behaviors (deleting tests,
 * weakening assertions, touching acceptance criteria) to a hard `failed`.
 *
 * Completion states: completed / failed / blocked / cancelled / unverified.
 * `unverified` is used when no trusted verification ran and nothing else
 * explains the stop — a task can never be marked completed without
 * verification evidence.
 */
import { createHash } from 'crypto';

import type { StructuredFailureEvidenceV1 } from './failure-attribution';
import { attributeFailure } from './failure-attribution';

export interface VerificationRunV1 {
  readonly ok: boolean;
  readonly output: string;
  readonly command: string;
  readonly durationMs: number;
}

export interface RepairGuardSnapshotV1 {
  /** Workspace-relative paths of test files present BEFORE the repair. */
  readonly testFiles: readonly string[];
  /** Path → count of assertion tokens (`expect(`) per test file. */
  readonly assertionTokens: Readonly<Record<string, number>>;
  /** Path → digest of acceptance/verification criteria files. */
  readonly acceptanceDigests: Readonly<Record<string, string>>;
}

export class ForbiddenRepairError extends Error {
  constructor(
    message: string,
    readonly guard: 'test_deleted' | 'assertion_weakened' | 'acceptance_modified'
  ) {
    super(message);
    this.name = 'ForbiddenRepairError';
  }
}

const hash = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 32);

export function snapshotTestFiles(
  workspace: string,
  testFilePaths: readonly string[]
): RepairGuardSnapshotV1 {
  const { existsSync, readFileSync } = require('fs') as typeof import('fs');
  const assertionTokens: Record<string, number> = {};
  const acceptanceDigests: Record<string, string> = {};
  for (const relative of testFilePaths) {
    const target = joinWorkspace(workspace, relative);
    if (!existsSync(target)) continue;
    const content = readFileSync(target, 'utf8');
    assertionTokens[relative] = (content.match(/expect\s*\(/g) ?? []).length;
    acceptanceDigests[relative] = hash(content);
  }
  return { testFiles: testFilePaths, assertionTokens, acceptanceDigests };
}

function joinWorkspace(workspace: string, relative: string): string {
  return `${workspace.replace(/[\\/]+$/, '')}/${relative}`;
}

/**
 * C4 — forbidden repair detection. Throws ForbiddenRepairError when the
 * after-snapshot shows a test deleted, assertions materially weakened
 * (>20% fewer `expect(` calls in a file), or an acceptance file modified.
 */
export function assertNoForbiddenRepair(
  before: RepairGuardSnapshotV1,
  after: RepairGuardSnapshotV1
): void {
  for (const testFile of before.testFiles) {
    const beforeTokens = before.assertionTokens[testFile] ?? 0;
    const afterExists =
      after.testFiles.includes(testFile) && after.assertionTokens[testFile] !== undefined;
    if (!afterExists) {
      throw new ForbiddenRepairError(
        `a test file was deleted during repair: ${testFile}`,
        'test_deleted'
      );
    }
    const afterTokens = after.assertionTokens[testFile] ?? 0;
    if (beforeTokens > 0 && afterTokens < Math.ceil(beforeTokens * 0.8)) {
      throw new ForbiddenRepairError(
        `assertions were weakened during repair: ${testFile} (${beforeTokens} → ${afterTokens} expect calls)`,
        'assertion_weakened'
      );
    }
  }
  for (const [file, beforeDigest] of Object.entries(before.acceptanceDigests)) {
    const afterDigest = after.acceptanceDigests[file];
    if (afterDigest !== undefined && afterDigest !== beforeDigest) {
      throw new ForbiddenRepairError(
        `acceptance criteria were modified during repair: ${file}`,
        'acceptance_modified'
      );
    }
  }
}

export type VerifiedRepairTerminal =
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'unverified';

export interface RepairRoundV1 {
  readonly attempt: number;
  readonly verification: VerificationRunV1;
  readonly attribution: StructuredFailureEvidenceV1;
  readonly repairRan: boolean;
  readonly repairError?: string;
}

export interface VerifiedRepairOutcomeV1 {
  readonly terminal: VerifiedRepairTerminal;
  readonly attempts: number;
  readonly rounds: readonly RepairRoundV1[];
  readonly noProgress: boolean;
  readonly failureReason?: string;
  readonly lastAttribution?: StructuredFailureEvidenceV1;
}

export interface VerifiedRepairOptionsV1 {
  /** Runs the (change-aware) verification command. */
  readonly verify: () => Promise<VerificationRunV1>;
  /** Performs the bounded repair for the given attribution. */
  readonly repair: (attribution: StructuredFailureEvidenceV1, attempt: number) => Promise<void>;
  /** Compares guard snapshots after each repair; throws on forbidden repairs. */
  readonly guard?: (
    previous: RepairGuardSnapshotV1 | undefined
  ) => Promise<RepairGuardSnapshotV1> | RepairGuardSnapshotV1;
  readonly maxAttempts?: number;
  readonly noProgressThreshold?: number;
  readonly signal?: AbortSignal;
}

/**
 * The bounded verified-repair loop (C3). The first verification is the
 * change-aware check; each failed round attributes the failure structurally
 * (C2), runs one bounded repair, re-verifies, and evaluates progress.
 */
export async function runVerifiedRepairLoop(
  options: VerifiedRepairOptionsV1
): Promise<VerifiedRepairOutcomeV1> {
  const maxAttempts = options.maxAttempts ?? 3;
  const noProgressThreshold = options.noProgressThreshold ?? 2;
  const rounds: RepairRoundV1[] = [];
  const seenDigests: string[] = [];
  let previousGuard: RepairGuardSnapshotV1 | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      return {
        terminal: 'cancelled',
        attempts: attempt - 1,
        rounds,
        noProgress: false,
        failureReason: 'cancelled before verification',
      };
    }
    let verification: VerificationRunV1;
    try {
      verification = await options.verify();
    } catch (error) {
      return {
        terminal: 'blocked',
        attempts: attempt - 1,
        rounds,
        noProgress: false,
        failureReason: `verification infrastructure failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const attribution = attributeFailure(verification.output, verification.command);
    rounds.push({
      attempt,
      verification,
      attribution,
      repairRan: false,
    });
    if (verification.ok) {
      return {
        terminal: 'completed',
        attempts: attempt,
        rounds,
        noProgress: false,
        lastAttribution: attribution,
      };
    }

    // Guard FIRST (before no-progress): a forbidden repair from the previous
    // round must surface as failed, never as a soft no-progress block.
    try {
      previousGuard = options.guard ? await options.guard(previousGuard) : undefined;
    } catch (error) {
      if (error instanceof ForbiddenRepairError) {
        return {
          terminal: 'failed',
          attempts: attempt,
          rounds,
          noProgress: false,
          failureReason: `forbidden repair: ${error.message}`,
          lastAttribution: attribution,
        };
      }
      return {
        terminal: 'blocked',
        attempts: attempt,
        rounds,
        noProgress: false,
        failureReason: `repair guard failed: ${error instanceof Error ? error.message : String(error)}`,
        lastAttribution: attribution,
      };
    }

    // No-progress detection: identical failure digests on consecutive rounds.
    if (seenDigests.length >= noProgressThreshold) {
      seenDigests.shift();
    }
    seenDigests.push(attribution.digest);
    const stuck =
      seenDigests.length >= noProgressThreshold &&
      seenDigests.every(digest => digest === seenDigests[0]);
    if (stuck || attempt === maxAttempts) {
      return {
        terminal: stuck ? 'blocked' : 'failed',
        attempts: attempt,
        rounds,
        noProgress: stuck,
        failureReason: stuck
          ? `no progress: the same failure persisted across ${seenDigests.length} rounds`
          : `verification still failing after ${maxAttempts} attempt(s)`,
        lastAttribution: attribution,
      };
    }

    try {
      await options.repair(attribution, attempt);
      rounds[rounds.length - 1] = { ...rounds[rounds.length - 1], repairRan: true };
    } catch (error) {
      rounds[rounds.length - 1] = {
        ...rounds[rounds.length - 1],
        repairRan: true,
        repairError: error instanceof Error ? error.message : String(error),
      };
    }
    if (options.signal?.aborted) {
      return {
        terminal: 'cancelled',
        attempts: attempt,
        rounds,
        noProgress: false,
        failureReason: 'cancelled during repair',
      };
    }
  }
  return {
    terminal: 'failed',
    attempts: maxAttempts,
    rounds,
    noProgress: false,
    failureReason: `verification still failing after ${maxAttempts} attempt(s)`,
  };
}

/**
 * C5 — five-state completion mapping. A turn may only be `completed` with
 * trusted verification evidence; no evidence maps to `unverified`.
 */
export function completionStateFromVerification(state: {
  readonly cancelled: boolean;
  readonly blockedReason?: string;
  readonly verificationRan: boolean;
  readonly verificationOk: boolean;
  readonly agentClaimedSuccess: boolean;
}): VerifiedRepairTerminal {
  if (state.cancelled) return 'cancelled';
  if (state.blockedReason) return 'blocked';
  if (!state.verificationRan) return 'unverified';
  return state.verificationOk ? 'completed' : 'failed';
}
