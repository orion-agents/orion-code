/**
 * v0.2.24 — Goal Storage.
 *
 * Atomic sidecar persistence for Session goals. Uses compare-and-swap
 * revision, temporary file + atomic rename, and corrupt quarantine.
 */

import {
  existsSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { getProjectSessionsDir } from '../services/config-dir';
import type {
  SessionGoalV1,
  GoalContract,
  GoalCompletionAudit,
  GoalEvidenceRecord,
  GoalEvidenceLedgerTruncation,
} from '../runtime/goals/types';
import { GOAL_TERMINAL_STATES } from '../runtime/goals/types';
import { auditCompletion } from '../runtime/goals/completion-audit';
import { isToolExternalAssertion } from '../framework/external-assertion';
import { debugError } from '../utils/debug-log';

// ============================================================================
// Sidecar path
// ============================================================================

function goalSidecarPath(projectPath: string, sessionId: string): string {
  return join(getProjectSessionsDir(projectPath), `${sessionId}.goal.json`);
}

function goalDeletionFencePath(sidecarPath: string): string {
  return `${sidecarPath}.deleted`;
}

// ============================================================================
// Core operations
// ============================================================================

export interface GoalStorageWarning {
  code: 'lock_cleanup_failed';
  message: string;
}

export type GoalStorageResult<T = void> =
  | { ok: true; value: T; warnings?: GoalStorageWarning[] }
  | {
      ok: false;
      error:
        | 'not_found'
        | 'revision_stale'
        | 'corrupt'
        | 'metadata_mismatch'
        | 'incompatible_schema'
        | 'io_error';
      message: string;
    };

interface GoalSidecarLockOwner {
  token: string;
  pid: number;
  createdAt: number;
}

interface AcquiredGoalSidecarLock {
  ok: true;
  release: () => GoalStorageResult;
}

type GoalSidecarLockResult = AcquiredGoalSidecarLock | Exclude<GoalStorageResult, { ok: true }>;

const GOAL_LOCK_WAIT_MS = 2_000;
const GOAL_LOCK_RETRY_MS = 10;
const GOAL_LOCK_STALE_MS = 30_000;

function sleepSync(ms: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

function lockOwnerPath(lockPath: string): string {
  return join(lockPath, 'owner.json');
}

function readLockOwner(lockPath: string): GoalSidecarLockOwner | null {
  try {
    const parsed = JSON.parse(
      readFileSync(lockOwnerPath(lockPath), 'utf8')
    ) as Partial<GoalSidecarLockOwner>;
    if (
      typeof parsed.token !== 'string' ||
      !parsed.token ||
      !Number.isInteger(parsed.pid) ||
      typeof parsed.createdAt !== 'number'
    ) {
      return null;
    }
    return parsed as GoalSidecarLockOwner;
  } catch (error) {
    // An unreadable owner file makes the lock look ownerless, which feeds
    // straight into stale-lock recovery — worth knowing when a lock is
    // being reclaimed unexpectedly.
    debugError('goal-storage.readLockOwner', error, lockPath);
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Move an abandoned lock out of the lock namespace before deleting it. The
 * rename is important: another process may immediately acquire a fresh lock,
 * and cleanup must never remove that new owner's directory.
 */
function recoverStaleLock(lockPath: string): boolean {
  let stat;
  try {
    stat = statSync(lockPath);
  } catch {
    // The lock directory is already gone: nothing to recover, and the
    // caller is free to acquire. A throw here *is* the success answer.
    return true;
  }

  const firstOwner = readLockOwner(lockPath);
  if (!firstOwner) return false;
  const lastActivity = Math.max(stat.mtimeMs, firstOwner.createdAt);
  if (Date.now() - lastActivity <= GOAL_LOCK_STALE_MS) return false;
  if (processIsAlive(firstOwner.pid)) return false;

  // Re-read the token immediately before rename. If ownership changed while we
  // inspected it, leave the replacement lock alone and retry normally.
  const currentOwner = readLockOwner(lockPath);
  if (!currentOwner || firstOwner.token !== currentOwner.token) return false;

  const stalePath = `${lockPath}.stale-${randomUUID().slice(0, 8)}`;
  try {
    renameSync(lockPath, stalePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    return false;
  }

  try {
    rmSync(stalePath, { recursive: true, force: true });
  } catch (error) {
    // It is already outside the lock namespace. A later maintenance pass can
    // remove it without blocking safe writes.
    debugError('goal-storage.removeStaleLock', error, stalePath);
  }
  return true;
}

function acquireGoalSidecarLock(sidecarPath: string): GoalSidecarLockResult {
  const lockPath = `${sidecarPath}.lock`;
  const deadline = Date.now() + GOAL_LOCK_WAIT_MS;

  while (true) {
    const owner: GoalSidecarLockOwner = {
      token: randomUUID(),
      pid: process.pid,
      createdAt: Date.now(),
    };
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      try {
        writeFileSync(lockOwnerPath(lockPath), JSON.stringify(owner), {
          encoding: 'utf8',
          mode: 0o600,
        });
      } catch (error) {
        try {
          rmSync(lockPath, { recursive: true, force: true });
        } catch {
          // The acquisition still fails closed below.
        }
        return {
          ok: false,
          error: 'io_error',
          message: `Failed to initialize Goal sidecar lock: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      return {
        ok: true,
        release: () => {
          if (!existsSync(lockPath)) return { ok: true, value: undefined };
          const currentOwner = readLockOwner(lockPath);
          if (currentOwner?.token !== owner.token) {
            return {
              ok: false,
              error: 'io_error',
              message: 'Goal sidecar lock ownership changed before cleanup',
            };
          }
          try {
            rmSync(lockPath, { recursive: true });
            return { ok: true, value: undefined };
          } catch (error) {
            return {
              ok: false,
              error: 'io_error',
              message: `Failed to release Goal sidecar lock: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        return {
          ok: false,
          error: 'io_error',
          message: `Failed to acquire Goal sidecar lock: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    if (recoverStaleLock(lockPath)) continue;
    if (Date.now() >= deadline) {
      return {
        ok: false,
        error: 'io_error',
        message: `Timed out waiting for Goal sidecar lock at ${lockPath}`,
      };
    }
    sleepSync(GOAL_LOCK_RETRY_MS);
  }
}

function withGoalSidecarLock<T>(
  sidecarPath: string,
  operation: () => GoalStorageResult<T>
): GoalStorageResult<T> {
  const acquired = acquireGoalSidecarLock(sidecarPath);
  if (!acquired.ok) return acquired;

  let result: GoalStorageResult<T>;
  try {
    result = operation();
  } catch (error) {
    result = {
      ok: false,
      error: 'io_error',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const released = acquired.release();
  if (!released.ok) {
    const warning: GoalStorageWarning = {
      code: 'lock_cleanup_failed',
      message: released.message,
    };
    console.warn(`[goal-storage] ${warning.message}`);

    // The operation result is authoritative. In particular, an atomic sidecar
    // rename may already have committed the new Goal before lock-directory
    // cleanup fails. Returning io_error here would make callers roll their
    // in-memory state back even though the new revision is durable on disk.
    // Keep pre-commit operation failures fail-closed, while reporting cleanup
    // as a secondary diagnostic on successful operations.
    if (result.ok) {
      return {
        ...result,
        warnings: [...(result.warnings ?? []), warning],
      };
    }
    return {
      ...result,
      message: `${result.message}; additionally, ${released.message}`,
    };
  }
  return result;
}

type JsonRecord = Record<string, unknown>;

const GOAL_STATUSES = new Set([
  'active',
  'paused',
  'blocked',
  'usage_limited',
  'budget_limited',
  'complete',
]);
const BLOCKER_CATEGORIES = new Set(['user_input', 'permission', 'external_state']);
const STOP_REASON_KINDS = new Set([
  'user',
  'blocked',
  'usage_limit',
  'budget_limit',
  'rate_limit',
  'provider_busy',
  'auth',
  'network',
  'runtime_error',
]);
const CRITERION_STATUSES = new Set(['pending', 'passed', 'failed', 'stale']);
const EVIDENCE_KINDS = new Set(['test', 'build', 'lint', 'file', 'runtime', 'external', 'user']);
const EVIDENCE_RESULTS = new Set(['passed', 'failed', 'inconclusive']);
const EVIDENCE_PROVENANCE = new Set(['runtime_automatic', 'external', 'user_acceptance']);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function hasUniqueRecordIds(values: unknown[]): boolean {
  const ids = values.map(value => (isRecord(value) ? value.id : undefined));
  return ids.every(id => typeof id === 'string') && new Set(ids).size === ids.length;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeNumber(value) && Number.isSafeInteger(value);
}

function isOptionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined || isNonNegativeNumber(value);
}

function isGoalBlocker(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.category === 'string' &&
    BLOCKER_CATEGORIES.has(value.category) &&
    isNonEmptyString(value.fingerprint) &&
    isNonNegativeNumber(value.firstSeenAt) &&
    isNonNegativeNumber(value.lastSeenAt) &&
    isNonNegativeInteger(value.consecutiveTurns) &&
    typeof value.summary === 'string' &&
    value.retryable === false
  );
}

function isGoalLastTurn(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.turnId) &&
    isNonEmptyString(value.finishReason) &&
    isNonNegativeNumber(value.endedAt) &&
    isNonNegativeInteger(value.promptTokens) &&
    isNonNegativeInteger(value.completionTokens) &&
    isNonNegativeInteger(value.subagentTokens) &&
    isNonNegativeInteger(value.totalTokens) &&
    typeof value.madeProgress === 'boolean'
  );
}

function isGoalNoProgressTurn(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.turnId) &&
    value.turnId.length <= 80 &&
    isNonNegativeNumber(value.endedAt) &&
    isNonEmptyString(value.finishReason) &&
    value.finishReason.length <= 80 &&
    isNonNegativeInteger(value.passedEvidence) &&
    isNonNegativeInteger(value.failedEvidence) &&
    isNonNegativeInteger(value.inconclusiveEvidence) &&
    typeof value.planUpdateProposed === 'boolean' &&
    (value.blockerCategory === undefined ||
      (typeof value.blockerCategory === 'string' && BLOCKER_CATEGORIES.has(value.blockerCategory)))
  );
}

function isStopReason(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.kind === 'string' &&
    STOP_REASON_KINDS.has(value.kind) &&
    isNonEmptyString(value.message) &&
    isNonNegativeNumber(value.at)
  );
}

function isBoundaryConfirmation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeNumber(value.requiredAt) &&
    isNonEmptyString(value.reason) &&
    isNonNegativeInteger(value.objectiveRevision) &&
    isOptionalNonNegativeNumber(value.confirmedAt) &&
    (value.confirmedRevision === undefined || isNonNegativeInteger(value.confirmedRevision))
  );
}

function isGoalCriterion(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.statement) &&
    (value.source === 'user' || value.source === 'derived') &&
    typeof value.status === 'string' &&
    CRITERION_STATUSES.has(value.status) &&
    Array.isArray(value.requiredEvidenceKinds) &&
    value.requiredEvidenceKinds.every(
      kind => typeof kind === 'string' && EVIDENCE_KINDS.has(kind)
    ) &&
    isStringArray(value.evidenceRefs)
  );
}

function isGoalContract(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    !isNonEmptyString(value.originalObjective) ||
    !isNonNegativeInteger(value.objectiveRevision) ||
    (value.completionAction !== undefined && value.completionAction !== 'exit_goal') ||
    !Array.isArray(value.constraints) ||
    !value.constraints.every(
      constraint =>
        isRecord(constraint) &&
        isNonEmptyString(constraint.id) &&
        isNonEmptyString(constraint.statement) &&
        (constraint.source === 'user' || constraint.source === 'derived')
    ) ||
    !hasUniqueRecordIds(value.constraints) ||
    !Array.isArray(value.successCriteria) ||
    !value.successCriteria.every(isGoalCriterion) ||
    !hasUniqueRecordIds(value.successCriteria)
  ) {
    return false;
  }
  if (
    value.objectiveHistory !== undefined &&
    (!Array.isArray(value.objectiveHistory) ||
      !value.objectiveHistory.every(
        revision =>
          isRecord(revision) &&
          isNonNegativeInteger(revision.revision) &&
          typeof revision.previousObjective === 'string' &&
          isNonEmptyString(revision.objective) &&
          isNonEmptyString(revision.reason) &&
          isNonNegativeNumber(revision.changedAt) &&
          revision.source === 'user'
      ))
  ) {
    return false;
  }
  if (value.planSnapshot !== undefined) {
    const plan = value.planSnapshot;
    if (
      !isRecord(plan) ||
      !isNonNegativeInteger(plan.revision) ||
      !isNonEmptyString(plan.phase) ||
      !Array.isArray(plan.steps) ||
      !plan.steps.every(
        step =>
          isRecord(step) &&
          isNonEmptyString(step.id) &&
          isNonEmptyString(step.description) &&
          typeof step.done === 'boolean'
      ) ||
      !hasUniqueRecordIds(plan.steps) ||
      (plan.nextAction !== undefined && typeof plan.nextAction !== 'string') ||
      !isNonNegativeNumber(plan.updatedAt)
    ) {
      return false;
    }
  }
  return true;
}

function isGoalEvidence(value: unknown, goalId: string): boolean {
  if (!isRecord(value)) return false;
  const assertion = value.externalAssertion;
  const assertionEnvelopeValid =
    assertion === undefined ||
    (isToolExternalAssertion(assertion) &&
      assertion.details !== undefined &&
      isNonNegativeInteger(assertion.observedAt) &&
      value.kind === 'external' &&
      value.result === assertion.status &&
      typeof value.sourceRef === 'string' &&
      value.sourceRef.startsWith('tool:') &&
      typeof value.capturedAt === 'number' &&
      assertion.observedAt <= value.capturedAt &&
      value.capturedAt - assertion.observedAt < 5 * 60_000 &&
      typeof value.expiresAt === 'number' &&
      value.expiresAt > value.capturedAt &&
      value.expiresAt - value.capturedAt <= 5 * 60_000);
  return (
    isNonEmptyString(value.id) &&
    value.goalId === goalId &&
    isNonNegativeInteger(value.goalRevision) &&
    isNonNegativeInteger(value.objectiveRevision) &&
    isNonEmptyString(value.turnId) &&
    typeof value.kind === 'string' &&
    EVIDENCE_KINDS.has(value.kind) &&
    isNonEmptyString(value.subject) &&
    typeof value.result === 'string' &&
    EVIDENCE_RESULTS.has(value.result) &&
    isNonEmptyString(value.sourceRef) &&
    isNonNegativeNumber(value.capturedAt) &&
    (value.workspaceFingerprint === undefined || typeof value.workspaceFingerprint === 'string') &&
    isOptionalNonNegativeNumber(value.expiresAt) &&
    assertionEnvelopeValid &&
    typeof value.redacted === 'boolean'
  );
}

const MAX_EVIDENCE_LEDGER_RECORDS = 500;
const MAX_EVIDENCE_TRUNCATION_COUNT = 1_000_000_000;

function isGoalEvidenceLedgerTruncation(value: unknown): value is GoalEvidenceLedgerTruncation {
  if (!isRecord(value)) return false;
  const fields = Object.keys(value);
  if (
    fields.length !== 4 ||
    !fields.every(field =>
      ['objectiveRevision', 'droppedPassed', 'droppedFailed', 'droppedInconclusive'].includes(field)
    )
  ) {
    return false;
  }
  const boundedCount = (count: unknown): count is number =>
    isNonNegativeInteger(count) && count <= MAX_EVIDENCE_TRUNCATION_COUNT;
  return (
    isNonNegativeInteger(value.objectiveRevision) &&
    boundedCount(value.droppedPassed) &&
    boundedCount(value.droppedFailed) &&
    boundedCount(value.droppedInconclusive) &&
    value.droppedPassed + value.droppedFailed + value.droppedInconclusive > 0
  );
}

function isCompletionCriterionResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.criterionId) &&
    typeof value.passed === 'boolean' &&
    typeof value.status === 'string' &&
    CRITERION_STATUSES.has(value.status) &&
    isStringArray(value.evidenceRefs) &&
    (value.reason === undefined || typeof value.reason === 'string')
  );
}

function isGoalCompletionAudit(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    !isNonNegativeNumber(value.requestedAt) ||
    !isNonNegativeNumber(value.auditedAt) ||
    typeof value.passed !== 'boolean' ||
    typeof value.verificationSummary !== 'string' ||
    !isStringArray(value.remainingRequirements) ||
    !isStringArray(value.evidenceRefs) ||
    (value.criterionResults !== undefined &&
      (!Array.isArray(value.criterionResults) ||
        !value.criterionResults.every(isCompletionCriterionResult)))
  ) {
    return false;
  }
  if (value.finalSummary === undefined) return true;
  const summary = value.finalSummary;
  if (!isRecord(summary) || !isRecord(summary.accounting)) return false;
  return (
    isNonEmptyString(summary.originalObjective) &&
    isNonEmptyString(summary.currentObjective) &&
    isNonNegativeInteger(summary.objectiveRevision) &&
    isNonNegativeNumber(summary.completedAt) &&
    typeof summary.verificationSummary === 'string' &&
    Array.isArray(summary.criterionResults) &&
    summary.criterionResults.every(
      result =>
        isRecord(result) &&
        isNonEmptyString(result.criterionId) &&
        typeof result.status === 'string' &&
        CRITERION_STATUSES.has(result.status) &&
        isStringArray(result.evidenceRefs) &&
        (result.evidence === undefined ||
          (Array.isArray(result.evidence) &&
            result.evidence.every(
              evidence =>
                isRecord(evidence) &&
                isNonEmptyString(evidence.evidenceId) &&
                typeof evidence.kind === 'string' &&
                EVIDENCE_KINDS.has(evidence.kind) &&
                typeof evidence.provenance === 'string' &&
                EVIDENCE_PROVENANCE.has(evidence.provenance) &&
                typeof evidence.result === 'string' &&
                EVIDENCE_RESULTS.has(evidence.result) &&
                isNonEmptyString(evidence.subject)
            )))
    ) &&
    isStringArray(summary.evidenceRefs) &&
    isNonNegativeInteger(summary.accounting.tokensUsed) &&
    isNonNegativeNumber(summary.accounting.timeUsedMs) &&
    isNonNegativeInteger(summary.accounting.continuationCount) &&
    summary.accounting.usageComplete === true &&
    Array.isArray(summary.remainingRequirements) &&
    summary.remainingRequirements.length === 0 &&
    summary.stopReason === 'completed'
  );
}

function invalidCompleteGoalReason(value: JsonRecord): string | null {
  if (value.status !== 'complete') return null;

  // v0.1.1 sidecars had no contract. They remain readable and are downgraded
  // to a paused, pending contract by GoalCoordinator so v0.1.2 can re-verify
  // them instead of trusting an unverifiable legacy terminal marker.
  if (value.contract === undefined) return null;

  if (!isNonNegativeNumber(value.completedAt)) {
    return 'complete goal requires completedAt';
  }
  if (value.blocker !== undefined) {
    return 'complete goal cannot retain a blocker';
  }
  if (value.activeSince !== undefined) {
    return 'complete goal cannot retain activeSince';
  }
  if (value.stopReason !== undefined) {
    return 'complete goal cannot retain a top-level stopReason';
  }
  if (!isRecord(value.contract) || !Array.isArray(value.contract.successCriteria)) {
    return 'complete goal requires a valid contract';
  }
  if (!isRecord(value.completionAudit) || value.completionAudit.passed !== true) {
    return 'complete goal requires a passed completionAudit';
  }
  const audit = value.completionAudit as unknown as GoalCompletionAudit;
  if (!Array.isArray(audit.remainingRequirements) || audit.remainingRequirements.length !== 0) {
    return 'complete goal cannot have remaining requirements';
  }
  const summary = audit.finalSummary;
  if (!summary || !isRecord(summary)) {
    return 'complete goal requires a finalSummary';
  }

  const contract = value.contract as unknown as GoalContract;
  const criteria = contract.successCriteria;
  const auditResults = audit.criterionResults ?? [];
  const summaryResults = summary.criterionResults;
  const criterionIds = new Set(criteria.map(criterion => criterion.id));
  const matchesPassedCriteria = (
    results: ReadonlyArray<{ criterionId: string; status: string; passed?: boolean }>,
    includePassedFlag: boolean
  ): boolean => {
    const resultIds = new Set(results.map(result => result.criterionId));
    return (
      results.length === criterionIds.size &&
      resultIds.size === criterionIds.size &&
      results.every(
        result =>
          typeof result.criterionId === 'string' &&
          criterionIds.has(result.criterionId) &&
          result.status === 'passed' &&
          (!includePassedFlag || result.passed === true)
      )
    );
  };

  if (criteria.length === 0 || criteria.some(criterion => criterion.status !== 'passed')) {
    return 'complete goal requires every success criterion to be passed';
  }
  if (!matchesPassedCriteria(auditResults, true)) {
    return 'complete goal completionAudit does not cover every passed criterion';
  }
  if (!matchesPassedCriteria(summaryResults, false)) {
    return 'complete goal finalSummary does not cover every passed criterion';
  }
  if (
    summary.completedAt !== value.completedAt ||
    summary.currentObjective !== value.objective ||
    summary.originalObjective !== contract.originalObjective ||
    summary.objectiveRevision !== contract.objectiveRevision
  ) {
    return 'complete goal finalSummary does not match the persisted goal contract';
  }
  if (
    summary.accounting.tokensUsed !== value.tokensUsed ||
    summary.accounting.timeUsedMs !== value.timeUsedMs ||
    summary.accounting.continuationCount !== value.continuationCount
  ) {
    return 'complete goal finalSummary accounting does not match the persisted goal';
  }
  if (summary.verificationSummary !== audit.verificationSummary) {
    return 'complete goal finalSummary verification does not match completionAudit';
  }

  const ledger = Array.isArray(value.evidenceLedger)
    ? (value.evidenceLedger as GoalEvidenceRecord[])
    : [];
  const evidenceById = new Map(ledger.map(record => [record.id, record]));
  const sameRefs = (left: unknown, right: unknown): boolean => {
    if (!isStringArray(left) || !isStringArray(right)) return false;
    const leftSet = new Set(left);
    const rightSet = new Set(right);
    return (
      left.length === leftSet.size &&
      right.length === rightSet.size &&
      leftSet.size === rightSet.size &&
      [...leftSet].every(ref => rightSet.has(ref))
    );
  };
  const auditByCriterion = new Map(auditResults.map(result => [result.criterionId, result]));
  const summaryByCriterion = new Map(summaryResults.map(result => [result.criterionId, result]));

  for (const criterion of criteria) {
    const result = auditByCriterion.get(criterion.id);
    const summaryResult = summaryByCriterion.get(criterion.id);
    if (
      !isStringArray(criterion.evidenceRefs) ||
      criterion.evidenceRefs.length === 0 ||
      criterion.evidenceRefs.some(ref => !evidenceById.has(ref)) ||
      !result ||
      !summaryResult ||
      !isStringArray(result.evidenceRefs) ||
      result.evidenceRefs.length === 0 ||
      !result.evidenceRefs.every(ref => criterion.evidenceRefs.includes(ref)) ||
      !sameRefs(result.evidenceRefs, summaryResult.evidenceRefs)
    ) {
      return 'complete goal criteria require consistent non-empty ledger evidence';
    }

    if (!Array.isArray(summaryResult.evidence)) {
      return 'complete goal finalSummary requires evidence provenance receipts';
    }
    const receiptById = new Map(
      summaryResult.evidence.map(receipt => [receipt.evidenceId, receipt] as const)
    );
    if (
      receiptById.size !== summaryResult.evidence.length ||
      receiptById.size !== result.evidenceRefs.length ||
      result.evidenceRefs.some(ref => {
        const record = evidenceById.get(ref);
        const receipt = receiptById.get(ref);
        if (!record || !receipt) return true;
        const expectedProvenance =
          record.kind === 'user'
            ? 'user_acceptance'
            : record.kind === 'external'
              ? 'external'
              : 'runtime_automatic';
        return (
          receipt.kind !== record.kind ||
          receipt.result !== record.result ||
          receipt.subject !== record.subject ||
          receipt.provenance !== expectedProvenance
        );
      })
    ) {
      return 'complete goal finalSummary evidence receipts do not match the ledger';
    }
  }

  const resultEvidenceRefs = [...new Set(auditResults.flatMap(result => result.evidenceRefs))];
  if (
    resultEvidenceRefs.length === 0 ||
    !sameRefs(audit.evidenceRefs, resultEvidenceRefs) ||
    !sameRefs(summary.evidenceRefs, resultEvidenceRefs)
  ) {
    return 'complete goal evidence summary does not match criterion evidence';
  }

  const workspaceBoundKinds = new Set(['test', 'build', 'lint', 'file', 'runtime']);
  const workspaceFingerprints = new Set(
    resultEvidenceRefs.flatMap(ref => {
      const record = evidenceById.get(ref);
      return record && workspaceBoundKinds.has(record.kind) && record.workspaceFingerprint
        ? [record.workspaceFingerprint]
        : [];
    })
  );
  const hasWorkspaceBoundEvidence = resultEvidenceRefs.some(ref => {
    const record = evidenceById.get(ref);
    return Boolean(record && workspaceBoundKinds.has(record.kind));
  });
  if (hasWorkspaceBoundEvidence && workspaceFingerprints.size !== 1) {
    return 'complete goal workspace-bound evidence lacks one stable fingerprint';
  }

  const replay = auditCompletion({
    objective: value.objective as string,
    contract,
    evidenceLedger: ledger,
    evidenceLedgerTruncation: value.evidenceLedgerTruncation as
      | GoalEvidenceLedgerTruncation
      | undefined,
    goalId: value.goalId as string,
    goalRevision: value.revision as number,
    requestedAt: audit.requestedAt as number,
    verificationSummary: audit.verificationSummary as string,
    workspaceFingerprint: [...workspaceFingerprints][0],
    now: audit.auditedAt as number,
  });
  const replayResults = replay.criterionResults ?? [];
  if (
    !replay.passed ||
    replayResults.length !== auditResults.length ||
    replayResults.some(replayed => {
      const persisted = auditByCriterion.get(replayed.criterionId);
      return (
        !persisted ||
        persisted.passed !== replayed.passed ||
        persisted.status !== replayed.status ||
        !sameRefs(persisted.evidenceRefs, replayed.evidenceRefs)
      );
    }) ||
    !sameRefs(replay.evidenceRefs, audit.evidenceRefs)
  ) {
    return 'complete goal completionAudit replay failed';
  }
  return null;
}

function invalidNonTerminalGoalReason(value: JsonRecord): string | null {
  if (value.contract === undefined || value.status === 'complete') return null;

  // These invariants are additive v0.1.2 guarantees. Contract-less v0.1.1
  // sidecars remain readable and are normalized by GoalCoordinator.
  if (value.completedAt !== undefined) {
    return 'non-complete goal cannot have completedAt';
  }
  if (isRecord(value.completionAudit) && value.completionAudit.finalSummary !== undefined) {
    return 'non-complete goal cannot have a finalSummary';
  }
  if (isRecord(value.completionAudit) && value.completionAudit.passed === true) {
    return 'non-complete goal cannot have a passed completionAudit';
  }
  if (value.status === 'blocked') {
    if (!isRecord(value.blocker)) {
      return 'blocked goal requires a blocker';
    }
    if (!isRecord(value.stopReason) || value.stopReason.kind !== 'blocked') {
      return 'blocked goal requires a blocked stopReason';
    }
  }
  if (value.status === 'active' && value.stopReason !== undefined) {
    return 'active goal cannot have a stopReason';
  }
  return null;
}

function invalidBoundaryConfirmationReason(value: JsonRecord): string | null {
  if (value.boundaryConfirmation === undefined) return null;
  if (!isRecord(value.boundaryConfirmation)) return 'boundaryConfirmation is invalid';

  const boundary = value.boundaryConfirmation;
  const hasConfirmedAt = boundary.confirmedAt !== undefined;
  const hasConfirmedRevision = boundary.confirmedRevision !== undefined;
  if (hasConfirmedAt !== hasConfirmedRevision) {
    return 'boundaryConfirmation confirmedAt and confirmedRevision must be paired';
  }
  if (!isRecord(value.contract)) {
    return 'boundaryConfirmation requires a contract';
  }
  if (boundary.objectiveRevision !== value.contract.objectiveRevision) {
    return 'boundaryConfirmation objectiveRevision must match the contract';
  }
  if (hasConfirmedRevision && (boundary.confirmedRevision as number) > (value.revision as number)) {
    return 'boundaryConfirmation confirmedRevision cannot exceed the Goal revision';
  }
  if (!hasConfirmedAt) {
    if (value.status !== 'paused') {
      return 'pending boundaryConfirmation requires a paused Goal';
    }
    if (!isRecord(value.stopReason) || value.stopReason.kind !== 'user') {
      return 'pending boundaryConfirmation requires a user stopReason';
    }
  }
  return null;
}

function invalidGoalSchemaReason(value: JsonRecord): string | null {
  if (!isNonEmptyString(value.goalId)) return 'missing or invalid goalId';
  if (!isNonEmptyString(value.sessionId)) return 'missing or invalid sessionId';
  if (!isNonNegativeInteger(value.revision)) return 'revision must be a non-negative integer';
  if (!isNonEmptyString(value.objective)) return 'objective must be a non-empty string';
  if (typeof value.status !== 'string' || !GOAL_STATUSES.has(value.status)) {
    return 'status is invalid';
  }
  if (
    value.tokenBudget !== undefined &&
    (!Number.isInteger(value.tokenBudget) ||
      !isNonNegativeNumber(value.tokenBudget) ||
      value.tokenBudget < 1)
  ) {
    return 'tokenBudget must be a positive integer';
  }
  if (!isNonNegativeInteger(value.tokensUsed)) return 'tokensUsed must be a non-negative integer';
  if (!isNonNegativeNumber(value.timeUsedMs)) return 'timeUsedMs must be non-negative';
  if (!isNonNegativeNumber(value.createdAt)) return 'createdAt must be non-negative';
  if (!isNonNegativeNumber(value.updatedAt)) return 'updatedAt must be non-negative';
  if (!isOptionalNonNegativeNumber(value.activeSince)) return 'activeSince must be non-negative';
  if (!isOptionalNonNegativeNumber(value.completedAt)) return 'completedAt must be non-negative';
  if (!isNonNegativeInteger(value.continuationCount)) {
    return 'continuationCount must be a non-negative integer';
  }
  if (
    value.automaticContinuationStreak !== undefined &&
    !isNonNegativeInteger(value.automaticContinuationStreak)
  ) {
    return 'automaticContinuationStreak must be a non-negative integer';
  }
  if (!isNonNegativeInteger(value.noProgressCount)) {
    return 'noProgressCount must be a non-negative integer';
  }
  if (value.blocker !== undefined && !isGoalBlocker(value.blocker)) return 'blocker is invalid';
  if (value.lastTurn !== undefined && !isGoalLastTurn(value.lastTurn)) return 'lastTurn is invalid';
  if (
    value.recentNoProgressTurns !== undefined &&
    (!Array.isArray(value.recentNoProgressTurns) ||
      value.recentNoProgressTurns.length > 3 ||
      !value.recentNoProgressTurns.every(isGoalNoProgressTurn))
  ) {
    return 'recentNoProgressTurns is invalid';
  }
  if (
    value.progressEvidenceKeys !== undefined &&
    (!Array.isArray(value.progressEvidenceKeys) ||
      value.progressEvidenceKeys.length > 1000 ||
      !value.progressEvidenceKeys.every(
        key => typeof key === 'string' && /^[a-f0-9]{64}$/u.test(key)
      ))
  ) {
    return 'progressEvidenceKeys is invalid';
  }
  if (value.completionAudit !== undefined && !isGoalCompletionAudit(value.completionAudit)) {
    return 'completionAudit is invalid';
  }
  if (value.stopReason !== undefined && !isStopReason(value.stopReason)) {
    return 'stopReason is invalid';
  }
  if (
    value.boundaryConfirmation !== undefined &&
    !isBoundaryConfirmation(value.boundaryConfirmation)
  ) {
    return 'boundaryConfirmation is invalid';
  }
  if (value.contract !== undefined && !isGoalContract(value.contract)) return 'contract is invalid';
  const boundaryConfirmationReason = invalidBoundaryConfirmationReason(value);
  if (boundaryConfirmationReason) return boundaryConfirmationReason;
  if (
    value.evidenceLedger !== undefined &&
    (!Array.isArray(value.evidenceLedger) ||
      value.evidenceLedger.length > MAX_EVIDENCE_LEDGER_RECORDS ||
      !value.evidenceLedger.every(evidence => isGoalEvidence(evidence, value.goalId as string)) ||
      new Set(value.evidenceLedger.map(evidence => evidence.id)).size !==
        value.evidenceLedger.length)
  ) {
    return 'evidenceLedger is invalid';
  }
  if (
    value.evidenceLedgerTruncation !== undefined &&
    (!isGoalEvidenceLedgerTruncation(value.evidenceLedgerTruncation) ||
      !isRecord(value.contract) ||
      value.evidenceLedgerTruncation.objectiveRevision !== value.contract.objectiveRevision)
  ) {
    return 'evidenceLedgerTruncation is invalid';
  }
  const nonTerminalGoalReason = invalidNonTerminalGoalReason(value);
  if (nonTerminalGoalReason) return nonTerminalGoalReason;
  const completeGoalReason = invalidCompleteGoalReason(value);
  if (completeGoalReason) return completeGoalReason;
  return null;
}

type GoalStorageFailure = Exclude<GoalStorageResult, { ok: true }>;
type QuarantineDisposition = 'quarantined' | 'changed' | 'missing';

const GOAL_LOAD_RACE_RETRIES = 8;

function loadGoalInternal(
  projectPath: string,
  sessionId: string,
  lockHeld: boolean,
  retriesRemaining: number,
  quarantineInvalidSidecar: boolean
): GoalStorageResult<SessionGoalV1> {
  const path = goalSidecarPath(projectPath, sessionId);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, error: 'not_found', message: `No goal sidecar at ${path}` };
    }
    return {
      ok: false,
      error: 'io_error',
      message: `Failed to read goal sidecar: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const quarantineInvalid = (
    failure: GoalStorageFailure,
    reason: string
  ): GoalStorageResult<SessionGoalV1> => {
    if (!quarantineInvalidSidecar) return failure;
    const quarantined = quarantineSidecar(path, raw, reason, lockHeld);
    if (!quarantined.ok) return quarantined;
    if (quarantined.value === 'quarantined') return failure;
    if (quarantined.value === 'missing') {
      return { ok: false, error: 'not_found', message: `No goal sidecar at ${path}` };
    }
    if (retriesRemaining <= 0) {
      return {
        ok: false,
        error: 'io_error',
        message: `Goal sidecar changed repeatedly while loading ${path}`,
      };
    }
    return loadGoalInternal(
      projectPath,
      sessionId,
      lockHeld,
      retriesRemaining - 1,
      quarantineInvalidSidecar
    );
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return quarantineInvalid(
      { ok: false, error: 'corrupt', message: 'Failed to parse goal sidecar' },
      error instanceof Error ? error.message : String(error)
    );
  }

  if (!isRecord(parsed)) {
    return quarantineInvalid(
      { ok: false, error: 'corrupt', message: 'Goal sidecar has invalid schema' },
      'sidecar root must be an object'
    );
  }
  if (typeof parsed.version === 'number' && parsed.version !== 1) {
    return quarantineInvalid(
      {
        ok: false,
        error: 'incompatible_schema',
        message: `Goal sidecar schema version ${String(parsed.version)} is not supported`,
      },
      `incompatible schema version: ${String(parsed.version)}`
    );
  }
  if (parsed.version !== 1) {
    return quarantineInvalid(
      { ok: false, error: 'corrupt', message: 'Goal sidecar has invalid schema' },
      'missing or invalid schema version'
    );
  }

  const invalidReason = invalidGoalSchemaReason(parsed);
  if (invalidReason) {
    return quarantineInvalid(
      { ok: false, error: 'corrupt', message: `Goal sidecar is corrupt: ${invalidReason}` },
      invalidReason
    );
  }
  if (parsed.sessionId !== sessionId) {
    return quarantineInvalid(
      {
        ok: false,
        error: 'metadata_mismatch',
        message: 'Goal sidecar sessionId mismatch',
      },
      `sessionId mismatch: expected ${sessionId}, got ${parsed.sessionId}`
    );
  }

  return { ok: true, value: parsed as unknown as SessionGoalV1 };
}

export function loadGoal(projectPath: string, sessionId: string): GoalStorageResult<SessionGoalV1> {
  return loadGoalInternal(projectPath, sessionId, false, GOAL_LOAD_RACE_RETRIES, true);
}

interface GoalDeletionFence {
  goalId: string;
  revision: number;
}

/**
 * A successful delete atomically renames the last valid sidecar to this
 * durable fence. Keeping the deleted identity on disk prevents a writer that
 * survived in another process from treating the missing sidecar as a fresh
 * revision-zero create after a restart.
 */
function readGoalDeletionFence(
  sidecarPath: string,
  sessionId: string
): GoalStorageResult<GoalDeletionFence> {
  const fencePath = goalDeletionFencePath(sidecarPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(fencePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, error: 'not_found', message: `No Goal deletion fence at ${fencePath}` };
    }
    return {
      ok: false,
      error: 'io_error',
      message: `Failed to read Goal deletion fence: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (
    !isRecord(parsed) ||
    parsed.sessionId !== sessionId ||
    !isNonEmptyString(parsed.goalId) ||
    !isNonNegativeInteger(parsed.revision)
  ) {
    return {
      ok: false,
      error: 'io_error',
      message: `Goal deletion fence at ${fencePath} is invalid`,
    };
  }
  return {
    ok: true,
    value: { goalId: parsed.goalId as string, revision: parsed.revision as number },
  };
}

function staleRevision(message: string): GoalStorageResult {
  return { ok: false, error: 'revision_stale', message };
}

function saveGoalInternal(
  projectPath: string,
  sessionId: string,
  goal: SessionGoalV1,
  expectedRevision: number | undefined,
  allowGoalReplacement: boolean
): GoalStorageResult {
  const candidate = goal as unknown as JsonRecord;
  const invalidReason =
    goal.version !== 1
      ? 'missing or invalid schema version'
      : goal.sessionId !== sessionId
        ? `sessionId mismatch: expected ${sessionId}, got ${goal.sessionId}`
        : expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision)
          ? 'expectedRevision must be a non-negative safe integer'
          : invalidGoalSchemaReason(candidate);
  if (invalidReason) {
    return {
      ok: false,
      error: 'io_error',
      message: `Refusing to persist an invalid Goal sidecar: ${invalidReason}`,
    };
  }

  const path = goalSidecarPath(projectPath, sessionId);
  const dir = getProjectSessionsDir(projectPath);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    /* dir exists */
  }

  return withGoalSidecarLock(path, () => {
    // The revision check and rename happen under the same per-sidecar lock. A
    // second process cannot pass the comparison against a revision that the
    // first process is concurrently replacing.
    if (expectedRevision !== undefined) {
      const existing = loadGoalInternal(projectPath, sessionId, true, GOAL_LOAD_RACE_RETRIES, true);
      if (existing.ok) {
        if (existing.value.revision !== expectedRevision) {
          return staleRevision(
            `Expected revision ${expectedRevision}, got ${existing.value.revision}`
          );
        }
        if (!allowGoalReplacement && existing.value.goalId !== goal.goalId) {
          return staleRevision(
            `Expected Goal ${goal.goalId}, got ${existing.value.goalId} at revision ${expectedRevision}`
          );
        }
      } else if (existing.error === 'not_found') {
        const fence = readGoalDeletionFence(path, sessionId);
        if (fence.ok) {
          // A deletion fence is authoritative for every CAS writer. Even a
          // fresh Goal identity with the same expected revision may have been
          // constructed by a stale coordinator before another process cleared
          // the session. Only a truly fresh create (expectedRevision omitted)
          // may replace the fence.
          return staleRevision(
            `Goal ${fence.value.goalId} was deleted at revision ${fence.value.revision}`
          );
        } else if (fence.error !== 'not_found') {
          return fence;
        } else if (!allowGoalReplacement || expectedRevision !== 0) {
          return staleRevision(
            `Expected revision ${expectedRevision}, but the Goal sidecar is missing`
          );
        }
      } else if (existing.error !== 'corrupt' || expectedRevision !== 0) {
        return existing;
      }
    } else {
      // An unversioned write is a fresh create/replacement request, not an
      // update. Re-read the sidecar while holding the writer lock so a stale
      // in-memory Goal cannot overwrite an active or otherwise recoverable
      // Goal after a failed reload. Do not quarantine failures here: this
      // path must preserve the exact bytes that blocked the replacement.
      const existing = loadGoalInternal(
        projectPath,
        sessionId,
        true,
        GOAL_LOAD_RACE_RETRIES,
        false
      );
      if (existing.ok) {
        if (!GOAL_TERMINAL_STATES.has(existing.value.status)) {
          return staleRevision(
            `Cannot replace non-terminal Goal ${existing.value.goalId} with an unversioned write`
          );
        }
      } else if (existing.error !== 'not_found') {
        return existing;
      } else {
        const fence = readGoalDeletionFence(path, sessionId);
        if (fence.ok && fence.value.goalId === goal.goalId) {
          return staleRevision(
            `Goal ${fence.value.goalId} was deleted at revision ${fence.value.revision}`
          );
        }
        if (!fence.ok && fence.error !== 'not_found') {
          return fence;
        }
      }
    }

    const tmpPath = `${path}.tmp-${randomUUID().slice(0, 8)}`;
    try {
      writeFileSync(tmpPath, JSON.stringify(goal, null, 2), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmpPath, path);
      try {
        unlinkSync(goalDeletionFencePath(path));
      } catch {
        // The sidecar rename above is the commit point. Fence cleanup is only
        // post-commit hygiene: a retained fence is ignored while the live
        // sidecar exists and will be replaced by the next atomic delete. Never
        // report a failed save after the new Goal is already durable.
      }
      return { ok: true, value: undefined };
    } catch (err) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* best effort */
      }
      return {
        ok: false,
        error: 'io_error',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

export function saveGoal(
  projectPath: string,
  sessionId: string,
  goal: SessionGoalV1,
  expectedRevision?: number
): GoalStorageResult {
  return saveGoalInternal(projectPath, sessionId, goal, expectedRevision, false);
}

export function deleteGoal(
  projectPath: string,
  sessionId: string,
  expectedRevision?: number,
  expectedGoalId?: string
): GoalStorageResult {
  const path = goalSidecarPath(projectPath, sessionId);
  try {
    mkdirSync(getProjectSessionsDir(projectPath), { recursive: true, mode: 0o700 });
  } catch (error) {
    return {
      ok: false,
      error: 'io_error',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  return withGoalSidecarLock(path, () => {
    if (expectedRevision !== undefined) {
      const existing = loadGoalInternal(projectPath, sessionId, true, GOAL_LOAD_RACE_RETRIES, true);
      if (!existing.ok) return existing;
      if (existing.value.revision !== expectedRevision) {
        return {
          ok: false,
          error: 'revision_stale',
          message: `Expected revision ${expectedRevision}, got ${existing.value.revision}`,
        };
      }
      if (expectedGoalId !== undefined && existing.value.goalId !== expectedGoalId) {
        return {
          ok: false,
          error: 'revision_stale',
          message: `Expected Goal ${expectedGoalId}, got ${existing.value.goalId} at revision ${expectedRevision}`,
        };
      }
    } else if (!existsSync(path)) {
      return { ok: true, value: undefined };
    }

    try {
      // Renaming the valid sidecar itself makes deletion and durable fencing a
      // single atomic filesystem transition. A crash cannot leave a window in
      // which both the sidecar and its cross-process deletion record are absent.
      chmodSync(path, 0o600);
      renameSync(path, goalDeletionFencePath(path));
      // The atomic rename above is the safety boundary. Compact the retained
      // sidecar to the minimum identity needed for stale-writer rejection; if
      // compaction fails, the renamed full sidecar remains a valid fence.
      const fence = readGoalDeletionFence(path, sessionId);
      if (fence.ok) {
        const fencePath = goalDeletionFencePath(path);
        const compactPath = `${path}.tmp-delete-${randomUUID().slice(0, 8)}`;
        try {
          writeFileSync(
            compactPath,
            JSON.stringify(
              {
                version: 1,
                kind: 'goal_deletion_fence',
                sessionId,
                goalId: fence.value.goalId,
                revision: fence.value.revision,
                deletedAt: Date.now(),
              },
              null,
              2
            ),
            { encoding: 'utf8', mode: 0o600 }
          );
          renameSync(compactPath, fencePath);
        } catch (error) {
          // Compaction is post-commit hygiene; the renamed full sidecar is
          // still a valid fence, so deletion stays successful either way.
          debugError('goal-storage.compactDeletionFence', error, fencePath);
          try {
            unlinkSync(compactPath);
          } catch (cleanupError) {
            /* the atomically renamed full sidecar remains the fence */
            debugError('goal-storage.compactCleanup', cleanupError, compactPath);
          }
        }
      }
      // Also clean up any stale temp files.
      try {
        const dir = getProjectSessionsDir(projectPath);
        // Using require here would create a circular dependency, so we use a
        // simple readdirSync pattern that matches the tmp- prefix.
        const { readdirSync } = require('fs');
        for (const file of readdirSync(dir)) {
          if (file.startsWith(`${sessionId}.goal.json.tmp-`)) {
            try {
              unlinkSync(join(dir, file));
            } catch (error) {
              /* leftover temp file; the next delete retries the sweep */
              debugError('goal-storage.sweepTempFile', error, file);
            }
          }
        }
      } catch (error) {
        /* the sessions dir is unreadable; temp files are swept next time */
        debugError('goal-storage.sweepTempDir', error, projectPath);
      }
      return { ok: true, value: undefined };
    } catch (err) {
      return {
        ok: false,
        error: 'io_error',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

export function createGoal(
  projectPath: string,
  sessionId: string,
  objective: string,
  contract?: GoalContract,
  expectedRevision?: number,
  initialState?: Pick<SessionGoalV1, 'status' | 'stopReason' | 'boundaryConfirmation'>
): GoalStorageResult<SessionGoalV1> {
  const now = Date.now();
  const status = initialState?.status ?? 'active';
  const goal: SessionGoalV1 = {
    version: 1,
    goalId: randomUUID(),
    sessionId,
    revision: 0,
    objective: objective.trim(),
    status,
    tokensUsed: 0,
    timeUsedMs: 0,
    createdAt: now,
    updatedAt: now,
    ...(status === 'active' ? { activeSince: now } : {}),
    continuationCount: 0,
    automaticContinuationStreak: 0,
    noProgressCount: 0,
    // v0.1.2: persist contract if provided. Omitted for pre-v0.1.2 callers,
    // in which case the coordinator normalizes a minimal pending contract at
    // load time (additive, never rewrites history).
    ...(contract ? { contract } : {}),
    ...(initialState ?? {}),
  };

  const result = saveGoalInternal(projectPath, sessionId, goal, expectedRevision, true);
  if (!result.ok) return result;
  return { ok: true, value: goal, ...(result.warnings ? { warnings: result.warnings } : {}) };
}

// ============================================================================
// Helpers
// ============================================================================

function quarantineSidecar(
  path: string,
  observedRaw: string,
  reason: string,
  lockHeld: boolean
): GoalStorageResult<QuarantineDisposition> {
  const quarantineObserved = (): GoalStorageResult<QuarantineDisposition> => {
    let currentRaw: string;
    try {
      currentRaw = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: true, value: 'missing' };
      }
      return {
        ok: false,
        error: 'io_error',
        message: `Failed to re-read goal sidecar before quarantine: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // The invalid bytes were observed before taking the writer lock. Another
    // writer may have atomically installed a valid sidecar in the meantime.
    // Only quarantine the exact bytes that triggered this load failure.
    if (currentRaw !== observedRaw) return { ok: true, value: 'changed' };

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const quarantinePath = `${path}.corrupt-${timestamp}`;
    try {
      renameSync(path, quarantinePath);
      console.warn(`[goal-storage] Quarantined corrupt goal sidecar: ${path} (${reason})`);
      return { ok: true, value: 'quarantined' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: true, value: 'missing' };
      }
      return {
        ok: false,
        error: 'io_error',
        message: `Failed to quarantine corrupt goal sidecar: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };

  return lockHeld ? quarantineObserved() : withGoalSidecarLock(path, quarantineObserved);
}

// ============================================================================
// Sidecar suffix for storage-maintenance
// ============================================================================

export const GOAL_SIDECAR_SUFFIX = '.goal.json';
export const GOAL_TMP_PREFIX = '.goal.json.tmp-';
