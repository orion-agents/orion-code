/**
 * v0.2.24 — Goal Coordinator.
 *
 * Single-flight state machine that manages goal lifecycle: creation,
 * pause/resume, auto-continuation, completion/blocked audit, and
 * persistence. Owned by AgentRuntimeController — NOT a global singleton.
 */

import { createHash, randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';

import {
  type SessionGoalV1,
  type RuntimeGoalSnapshot,
  type AgentTurnOutcome,
  type AgentTurnRequest,
  type GoalContract,
  type GoalCreationContractInput,
  type GoalEvidenceRecord,
  type GoalEvidenceLedgerTruncation,
  type GoalFinalEvidence,
  type GoalNoProgressTurn,
  type GoalPlanUpdate,
  GOAL_INVARIANTS,
  GOAL_TERMINAL_STATES,
  GOAL_USER_RECOVERABLE_STATES,
} from './types';
import {
  loadGoal,
  saveGoal,
  deleteGoal,
  createGoal as persistGoal,
} from '../../services/goal-storage';
import { accumulateTurn, classifyStopReason, isBudgetExceeded } from './accounting';
import {
  auditCompletion,
  auditBlocked,
  blockersMatch,
  criterionRequiresExternalCompletionEvidence,
  hasUnnegatedActionMatch,
} from './completion-audit';
import { redactTraceText } from '../../services/redaction';
import { getProjectSessionsDir } from '../../services/config-dir';

const MAX_EVIDENCE_LEDGER_RECORDS = 500;
const MAX_EVIDENCE_TRUNCATION_COUNT = 1_000_000_000;

function addSafeInteger(value: number, increment: number, field: string): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    !Number.isSafeInteger(increment) ||
    increment < 0 ||
    value > Number.MAX_SAFE_INTEGER - increment
  ) {
    throw new RangeError(`${field} would exceed the non-negative safe integer range`);
  }
  return value + increment;
}

function boundedTruncationCount(current: number, increment: number): number {
  return Math.min(MAX_EVIDENCE_TRUNCATION_COUNT, current + increment);
}

function appendBoundedEvidence(
  existing: GoalEvidenceRecord[],
  incoming: GoalEvidenceRecord[],
  objectiveRevision: number,
  previousTruncation?: GoalEvidenceLedgerTruncation
): {
  ledger: GoalEvidenceRecord[];
  truncation?: GoalEvidenceLedgerTruncation;
} {
  const all = [...existing, ...incoming];
  const carried =
    previousTruncation?.objectiveRevision === objectiveRevision ? previousTruncation : undefined;
  if (all.length <= MAX_EVIDENCE_LEDGER_RECORDS) {
    return { ledger: all, truncation: carried };
  }

  const retained = new Set<GoalEvidenceRecord>();
  const retainNewest = (records: GoalEvidenceRecord[]): void => {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (retained.size >= MAX_EVIDENCE_LEDGER_RECORDS) return;
      retained.add(records[index]);
    }
  };

  // Negative evidence for the current objective epoch is safety-critical. Keep
  // it ahead of passing and old-epoch records; if more than the entire bounded
  // ledger is negative, the truncation summary below makes completion fail
  // closed even after later passing evidence arrives.
  retainNewest(
    all.filter(
      record => record.objectiveRevision === objectiveRevision && record.result !== 'passed'
    )
  );
  retainNewest(all.filter(record => record.objectiveRevision === objectiveRevision));
  retainNewest(all);

  const ledger = all.filter(record => retained.has(record));
  const dropped = all.filter(
    record => record.objectiveRevision === objectiveRevision && !retained.has(record)
  );
  if (dropped.length === 0) return { ledger, truncation: carried };

  const increment = (result: GoalEvidenceRecord['result']): number =>
    dropped.filter(record => record.result === result).length;
  return {
    ledger,
    truncation: {
      objectiveRevision,
      droppedPassed: boundedTruncationCount(carried?.droppedPassed ?? 0, increment('passed')),
      droppedFailed: boundedTruncationCount(carried?.droppedFailed ?? 0, increment('failed')),
      droppedInconclusive: boundedTruncationCount(
        carried?.droppedInconclusive ?? 0,
        increment('inconclusive')
      ),
    },
  };
}

function finalEvidenceReceipt(record: GoalEvidenceRecord): GoalFinalEvidence {
  return {
    evidenceId: record.id,
    kind: record.kind,
    provenance:
      record.kind === 'user'
        ? 'user_acceptance'
        : record.kind === 'external'
          ? 'external'
          : 'runtime_automatic',
    result: record.result,
    subject: record.subject,
  };
}

function noProgressTurnSummary(outcome: AgentTurnOutcome): GoalNoProgressTurn {
  const evidence = outcome.evidenceRecords ?? [];
  return {
    turnId: redactTraceText(String(outcome.turnId)).slice(0, 80),
    endedAt: outcome.endedAt,
    finishReason: redactTraceText(outcome.finishReason).slice(0, 80),
    passedEvidence: evidence.filter(record => record.result === 'passed').length,
    failedEvidence: evidence.filter(record => record.result === 'failed').length,
    inconclusiveEvidence: evidence.filter(record => record.result === 'inconclusive').length,
    planUpdateProposed: Boolean(outcome.pendingPlanUpdate),
    blockerCategory: outcome.blocker?.category,
  };
}

function formatNoProgressTurns(turns: GoalNoProgressTurn[]): string {
  return turns
    .map(
      turn =>
        `${turn.turnId} finish=${turn.finishReason} evidence=${turn.passedEvidence}p/${turn.failedEvidence}f/${turn.inconclusiveEvidence}i plan=${turn.planUpdateProposed ? 'no-change' : 'none'}${turn.blockerCategory ? ` blocker=${turn.blockerCategory}` : ''}`
    )
    .join('; ');
}

/**
 * Build a minimal pending contract from an objective string. Used at creation
 * and at load time to normalize v0.1.1 sidecars (which have no contract).
 *
 * The primary criterion is `source=user` because it is the user's verbatim
 * objective, with a stable id so repeated
 * normalizations of the same goal produce the same id (no churn on reload).
 * User-supplied criteria (`source=user`) are added via a separate path.
 */
function minimalContract(objective: string, now: number): GoalContract {
  return {
    originalObjective: objective,
    objectiveRevision: 0,
    constraints: [],
    successCriteria: [
      {
        id: 'criterion:primary',
        statement: objective,
        source: 'user',
        status: 'pending',
        // External completion actions cannot be proven by local process output.
        // Other primary criteria accept local runtime evidence; model natural
        // language is never an accepted kind.
        requiredEvidenceKinds: criterionRequiresExternalCompletionEvidence(objective)
          ? ['external', 'user']
          : ['test', 'build', 'file', 'runtime'],
        evidenceRefs: [],
      },
    ],
    planSnapshot: {
      revision: 0,
      phase: 'initial',
      steps: [],
      updatedAt: now,
    },
  };
}

const CONTRACT_EVIDENCE_KINDS = new Set([
  'test',
  'build',
  'lint',
  'file',
  'runtime',
  'external',
  'user',
]);

const BOUNDARY_CONFIRMATION_PATTERN =
  /\b(publish|deploy|delete|erase|remove|drop|migrate|send|email|message|post|pay|purchase|merge|push|tag|overwrite|destroy|revoke|transfer|upload)\b|发布|部署|删除|清空|迁移|发送|付款|购买|合并|推送|打标签|覆盖|销毁|撤销|转账|上传/i;

/** High-impact external or destructive goals must not auto-start from model-created text. */
export function goalRequiresBoundaryConfirmation(
  objective: string,
  input: GoalCreationContractInput = {}
): boolean {
  return [
    objective,
    ...(input.constraints ?? []),
    ...(input.successCriteria ?? []).map(criterion => criterion.statement),
  ].some(statement => hasUnnegatedActionMatch(statement, BOUNDARY_CONFIRMATION_PATTERN));
}

function boundaryConfirmationState(
  objectiveRevision: number,
  now: number
): Pick<SessionGoalV1, 'status' | 'stopReason' | 'boundaryConfirmation'> {
  return {
    status: 'paused',
    stopReason: {
      kind: 'user',
      message:
        'Boundary confirmation required for an external, destructive, or high-impact Goal. Review the objective and constraints, then use /target resume to confirm.',
      at: now,
    },
    boundaryConfirmation: {
      requiredAt: now,
      reason: 'external_destructive_or_high_impact',
      objectiveRevision,
    },
  };
}

function pauseForBoundaryConfirmation(goal: SessionGoalV1, now: number): SessionGoalV1 {
  return {
    ...goal,
    ...boundaryConfirmationState(goal.contract?.objectiveRevision ?? 0, now),
    updatedAt: now,
  };
}

function creationContract(
  objective: string,
  now: number,
  input: GoalCreationContractInput
): GoalContract | null {
  const constraints = input.constraints ?? [];
  const successCriteria = input.successCriteria ?? [];
  if (constraints.length > 50 || successCriteria.length > 50) return null;
  if (
    constraints.some(statement => !statement.trim()) ||
    successCriteria.some(
      criterion =>
        !criterion.statement.trim() ||
        criterion.requiredEvidenceKinds.length === 0 ||
        criterion.requiredEvidenceKinds.some(kind => !CONTRACT_EVIDENCE_KINDS.has(kind))
    )
  ) {
    return null;
  }

  const contract = minimalContract(objective, now);
  contract.constraints = constraints.map((statement, index) => ({
    id: `constraint:user:${index + 1}`,
    statement: statement.trim(),
    source: 'user',
  }));
  contract.successCriteria.push(
    ...successCriteria.map((criterion, index) => ({
      id: `criterion:user:${index + 1}`,
      statement: criterion.statement.trim(),
      source: 'user' as const,
      status: 'pending' as const,
      requiredEvidenceKinds: [...new Set(criterion.requiredEvidenceKinds)],
      evidenceRefs: [],
    }))
  );
  return contract;
}

function compactPlanValue(value: string | undefined): string | undefined {
  const compact = value?.replace(/\s+/gu, ' ').trim();
  return compact || undefined;
}

function stablePlanStepKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

const OBJECTIVE_TRACE_STOP_WORDS = new Set([
  'add',
  'build',
  'check',
  'code',
  'complete',
  'create',
  'goal',
  'implement',
  'pass',
  'run',
  'test',
  'update',
  'verify',
]);

function objectiveTraceTokens(value: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of value
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}_-]+/gu) ?? []) {
    if (raw.length >= 3 && !OBJECTIVE_TRACE_STOP_WORDS.has(raw)) tokens.add(raw);
    if (/\p{Script=Han}/u.test(raw)) {
      const characters = Array.from(raw);
      for (let index = 0; index < characters.length - 1; index += 1) {
        tokens.add(`${characters[index]}${characters[index + 1]}`);
      }
    }
  }
  return tokens;
}

function criterionTracesToObjective(statement: string, contract: GoalContract): boolean {
  const objectiveTokens = objectiveTraceTokens(contract.originalObjective);
  if (objectiveTokens.size === 0) return false;
  const criterionTokens = objectiveTraceTokens(statement);
  return [...criterionTokens].some(token => objectiveTokens.has(token));
}

function substantivePlanProgress(
  contract: GoalContract,
  update: GoalPlanUpdate,
  derivedCriteria: ReturnType<typeof newDerivedCriteria>
): boolean {
  const current = contract.planSnapshot;
  const completedStableStep = Boolean(
    current?.steps.some(step => {
      if (step.done) return false;
      const key = stablePlanStepKey(step.description);
      return Boolean(
        key && update.steps.some(next => next.done && stablePlanStepKey(next.description) === key)
      );
    })
  );
  const traceableCriterionAdded = derivedCriteria.some(criterion =>
    criterionTracesToObjective(criterion.statement, contract)
  );
  return completedStableStep || traceableCriterionAdded;
}

function stableEvidenceSource(sourceRef: string): string {
  const tool = /^tool:[^:]+:(.+)$/iu.exec(sourceRef.trim());
  return compactPlanValue(tool ? `tool:${tool[1]}` : sourceRef)?.toLowerCase() ?? 'unknown';
}

function normalizedEvidenceSubject(subject: string): string {
  return redactTraceText(subject)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

function evidenceProgressKeys(incoming: GoalEvidenceRecord[], contract: GoalContract): string[] {
  const keys = new Set<string>();
  for (const record of incoming) {
    if (record.result !== 'passed') continue;
    const stableSource = stableEvidenceSource(record.sourceRef);
    const normalizedSubject = normalizedEvidenceSubject(record.subject);
    const evidenceTokens = objectiveTraceTokens(`${normalizedSubject} ${stableSource}`);
    for (const criterion of contract.successCriteria) {
      if (!criterion.requiredEvidenceKinds.includes(record.kind)) continue;
      const directCriterionReference =
        normalizedSubject.includes(criterion.id.toLowerCase()) ||
        stableSource.includes(criterion.id.toLowerCase());
      const criterionTokens = objectiveTraceTokens(criterion.statement);
      const semanticallyRelated = [...criterionTokens].some(token => evidenceTokens.has(token));
      if (!directCriterionReference && !semanticallyRelated) continue;
      const materialIdentity = [
        record.objectiveRevision,
        criterion.id,
        record.kind,
        stableSource,
        normalizedSubject,
        record.workspaceFingerprint ?? 'workspace:none',
      ].join('\u0000');
      keys.add(createHash('sha256').update(materialIdentity).digest('hex'));
    }
  }
  return [...keys];
}

function criterionStateAdvanced(
  before: GoalContract,
  after: GoalContract | undefined,
  evidenceLedger: GoalEvidenceRecord[]
): boolean {
  if (!after) return false;
  const passedEvidence = new Set(
    evidenceLedger.filter(record => record.result === 'passed').map(record => record.id)
  );
  const priorById = new Map(before.successCriteria.map(criterion => [criterion.id, criterion]));
  return after.successCriteria.some(criterion => {
    const prior = priorById.get(criterion.id);
    if (!prior) return false;
    if (prior.status !== 'passed' && criterion.status === 'passed') return true;
    const priorRefs = new Set(prior.evidenceRefs);
    return criterion.evidenceRefs.some(ref => !priorRefs.has(ref) && passedEvidence.has(ref));
  });
}

function planContentChanged(contract: GoalContract, update: GoalPlanUpdate): boolean {
  const current = contract.planSnapshot;
  if (!current) return true;
  if (compactPlanValue(current.phase) !== compactPlanValue(update.phase)) return true;
  if (compactPlanValue(current.nextAction) !== compactPlanValue(update.nextAction)) return true;
  if (current.steps.length !== update.steps.length) return true;
  return current.steps.some((step, index) => {
    const next = update.steps[index];
    return (
      compactPlanValue(step.description) !== compactPlanValue(next.description) ||
      step.done !== next.done
    );
  });
}

function newDerivedCriteria(contract: GoalContract, update: GoalPlanUpdate, planRevision: number) {
  const existingStatements = new Set(
    contract.successCriteria.map(criterion => criterion.statement.trim().toLowerCase())
  );
  return update.derivedCriteria
    .filter(item => !existingStatements.has(item.statement.trim().toLowerCase()))
    .map((item, index) => ({
      id: `criterion:derived:${planRevision}:${index + 1}`,
      statement: item.statement,
      source: 'derived' as const,
      status: 'pending' as const,
      requiredEvidenceKinds: item.requiredEvidenceKinds,
      evidenceRefs: [],
    }));
}

/** Ensure a loaded goal carries a contract; normalize v0.1.1 sidecars. */
function ensureContract(goal: SessionGoalV1): SessionGoalV1 {
  if (goal.contract) return goal;
  const contract = minimalContract(goal.objective, goal.updatedAt || goal.createdAt);
  const normalizedLegacy = {
    ...goal,
    contract,
    completedAt: undefined,
    completionAudit: undefined,
  };
  if (goal.status === 'active') {
    return {
      ...normalizedLegacy,
      blocker: undefined,
      stopReason: undefined,
    };
  }
  if (goal.status === 'blocked' && (!goal.blocker || goal.stopReason?.kind !== 'blocked')) {
    return {
      ...normalizedLegacy,
      status: 'paused',
      blocker: undefined,
      stopReason: {
        kind: 'user',
        message: 'Legacy blocked state requires v0.1.2 blocker re-verification.',
        at: Date.now(),
      },
    };
  }
  if (goal.status !== 'complete') return normalizedLegacy;
  const now = Date.now();
  return {
    ...normalizedLegacy,
    status: 'paused',
    stopReason: {
      kind: 'user',
      message: 'Legacy completion requires v0.1.2 evidence re-verification.',
      at: now,
    },
  };
}

export interface GoalCoordinatorState {
  goal: SessionGoalV1 | null;
  generation: number;
  continuationDeferred: boolean;
}

export class GoalCoordinator {
  private state: GoalCoordinatorState = { goal: null, generation: 0, continuationDeferred: false };
  private loadIssue: {
    code: 'corrupt' | 'metadata_mismatch' | 'incompatible_schema' | 'io_error';
    message: string;
  } | null = null;
  /** A failed reload requires storage recovery before a fresh Goal may be written. */
  private loadRecoveryRequired = false;
  /** Runtime-only dedupe for interrupted stale turns; in-flight turns do not survive restart. */
  private readonly accountedStaleTurnKeys = new Set<string>();
  /** Last disk-authoritative state, used when both a write and recovery read fail. */
  private persistedGoalSnapshot: SessionGoalV1 | null = null;

  constructor(
    private readonly projectPath: string,
    private readonly sessionId: string
  ) {}

  // ==========================================================================
  // Queries
  // ==========================================================================

  get goal(): SessionGoalV1 | null {
    return this.state.goal;
  }
  get generation(): number {
    return this.state.generation;
  }
  get boundSessionId(): string {
    return this.sessionId;
  }
  get isActive(): boolean {
    return this.state.goal?.status === 'active';
  }
  get canContinue(): boolean {
    return (
      this.isActive &&
      !this.state.continuationDeferred &&
      !isBudgetExceeded(this.state.goal!.tokensUsed, this.state.goal!.tokenBudget)
    );
  }
  get lastLoadIssue(): {
    code: 'corrupt' | 'metadata_mismatch' | 'incompatible_schema' | 'io_error';
    message: string;
  } | null {
    return this.loadIssue;
  }

  private addGoalInteger(value: number, increment: number, field: string): number {
    try {
      return addSafeInteger(value, increment, field);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.failClosedAfterPersistenceError(message);
      throw error;
    }
  }

  private loadRecoveryMessage(): string {
    const detail = this.loadIssue?.message ?? 'Goal storage state is not readable.';
    return `Goal storage recovery is required before creating or replacing a Goal. ${detail}`;
  }

  snapshot(): RuntimeGoalSnapshot | null {
    const g = this.state.goal;
    if (!g) return null;
    const criteria = g.contract?.successCriteria ?? [];
    return {
      goalId: g.goalId,
      revision: g.revision,
      objective: g.objective,
      status: g.status,
      tokenBudget: g.tokenBudget,
      tokensUsed: g.tokensUsed,
      timeUsedMs: g.timeUsedMs,
      continuationCount: g.continuationCount,
      updatedAt: g.updatedAt,
      stopReason: g.stopReason?.message,
      criteria: {
        passed: criteria.filter(criterion => criterion.status === 'passed').length,
        failed: criteria.filter(criterion => criterion.status === 'failed').length,
        stale: criteria.filter(criterion => criterion.status === 'stale').length,
        total: criteria.length,
      },
      planRevision: g.contract?.planSnapshot?.revision,
      planPhase: g.contract?.planSnapshot?.phase,
      nextAction: g.contract?.planSnapshot?.nextAction,
      auditRemaining: g.completionAudit?.remainingRequirements,
    };
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  load(recoverActive: boolean = false): boolean {
    const result = loadGoal(this.projectPath, this.sessionId);
    if (result.ok) {
      this.loadIssue = null;
      this.loadRecoveryRequired = false;
      // v0.1.2: normalize v0.1.1 sidecars (no contract) into a minimal pending
      // contract. This is in-memory only; it does not rewrite the sidecar
      // until the next real state update.
      this.state.goal = ensureContract(result.value);
      this.persistedGoalSnapshot = structuredClone(this.state.goal);
      // Every reload replaces the in-memory authority, even if the disk bytes
      // are unchanged. Advance the runtime epoch so pre-reload outcomes cannot
      // finalize or account against the newly loaded state.
      this.state.generation += 1;
      this.state.continuationDeferred = false;
      if (recoverActive && this.state.goal.status === 'active') {
        const loadedGoal = this.state.goal;
        const lockPath = join(
          getProjectSessionsDir(this.projectPath),
          `${this.sessionId}.goal.json.lock`
        );
        if (existsSync(lockPath)) {
          const message = `Restart recovery could not persist a paused Goal because storage is temporarily locked at ${lockPath}. No continuation was started; resolve the lock, then use /target resume.`;
          this.loadIssue = { code: 'io_error', message };
          this.loadRecoveryRequired = true;
          this.failClosedAfterPersistenceError(message);
          return true;
        }
        try {
          this.state.goal = {
            ...loadedGoal,
            status: 'paused',
            revision: addSafeInteger(loadedGoal.revision, 1, 'revision'),
            updatedAt: Date.now(),
            stopReason: {
              kind: 'user',
              message: 'Recovered after restart. Use /target resume to continue.',
              at: Date.now(),
            },
          };
          this.state.continuationDeferred = true;
          this.persist();
        } catch (error) {
          const detail = redactTraceText(error instanceof Error ? error.message : String(error));
          const message = `Restart recovery could not persist a paused Goal. No continuation was started; resolve the storage error, then use /target resume. ${detail}`;
          this.loadIssue = { code: 'io_error', message };
          this.loadRecoveryRequired = true;
          this.failClosedAfterPersistenceError(message);
        }
      }
      return true;
    }
    this.loadIssue = ['corrupt', 'metadata_mismatch', 'incompatible_schema', 'io_error'].includes(
      result.error
    )
      ? {
          code: result.error as
            | 'corrupt'
            | 'metadata_mismatch'
            | 'incompatible_schema'
            | 'io_error',
          message: result.message,
        }
      : null;
    // A missing sidecar is an authoritative empty state and permits a fresh
    // create. Every other load failure leaves the write path recovery-gated;
    // otherwise create/replace could hide the unreadable sidecar.
    this.loadRecoveryRequired = result.error !== 'not_found';
    // A failed repeat load makes the disk state authoritative and the previous
    // in-memory Goal unsafe to continue. Invalidate in-flight work and discard
    // both cached copies without attempting to write the stale Goal back.
    this.state.generation += 1;
    this.state.continuationDeferred = true;
    this.state.goal = null;
    this.persistedGoalSnapshot = null;
    return false;
  }

  create(
    objective: string,
    contractInput: GoalCreationContractInput = {}
  ): { ok: true } | { ok: false; error: string } {
    if (this.loadRecoveryRequired) {
      return { ok: false, error: this.loadRecoveryMessage() };
    }
    if (this.state.goal && !GOAL_TERMINAL_STATES.has(this.state.goal.status)) {
      return {
        ok: false,
        error: 'An active goal already exists. Use /target replace to change it.',
      };
    }
    if (!objective.trim()) {
      return { ok: false, error: 'Objective cannot be empty.' };
    }
    if (objective.length > GOAL_INVARIANTS.maxObjectiveChars) {
      return {
        ok: false,
        error: `Objective too long (max ${GOAL_INVARIANTS.maxObjectiveChars} chars).`,
      };
    }

    const now = Date.now();
    const contract = creationContract(objective.trim(), now, contractInput);
    if (!contract) {
      return { ok: false, error: 'Goal constraints or success criteria are invalid.' };
    }
    const requiresBoundaryConfirmation = goalRequiresBoundaryConfirmation(objective, contractInput);
    const result = persistGoal(
      this.projectPath,
      this.sessionId,
      objective,
      contract,
      this.state.goal?.revision,
      requiresBoundaryConfirmation
        ? boundaryConfirmationState(contract.objectiveRevision, now)
        : undefined
    );
    if (!result.ok) return { ok: false, error: result.message };

    const created = result.value;
    this.state.goal = created;
    this.persistedGoalSnapshot = structuredClone(created);
    this.state.generation += 1;
    this.state.continuationDeferred = created.status !== 'active';
    return { ok: true };
  }

  pause(): boolean {
    if (!this.state.goal || this.state.goal.status !== 'active') return false;
    this.state.goal = {
      ...this.state.goal,
      status: 'paused',
      revision: this.addGoalInteger(this.state.goal.revision, 1, 'revision'),
      updatedAt: Date.now(),
      stopReason: { kind: 'user', message: 'Paused by user.', at: Date.now() },
    };
    this.persist();
    this.state.continuationDeferred = true;
    return true;
  }

  resume(
    options: {
      confirmBoundary?: boolean;
      expectedGoalId?: string;
      expectedRevision?: number;
    } = {}
  ): boolean {
    if (!this.state.goal || !GOAL_USER_RECOVERABLE_STATES.has(this.state.goal.status)) return false;
    const pendingBoundary =
      this.state.goal.boundaryConfirmation &&
      this.state.goal.boundaryConfirmation.confirmedAt === undefined;
    if (
      pendingBoundary &&
      (!options.confirmBoundary ||
        options.expectedGoalId !== this.state.goal.goalId ||
        options.expectedRevision !== this.state.goal.revision)
    ) {
      return false;
    }
    const resumedAt = Date.now();
    this.state.goal = {
      ...this.state.goal,
      status: 'active',
      revision: this.addGoalInteger(this.state.goal.revision, 1, 'revision'),
      updatedAt: resumedAt,
      activeSince: resumedAt,
      stopReason: undefined,
      blocker: undefined,
      noProgressCount: 0,
      recentNoProgressTurns: [],
      boundaryConfirmation: pendingBoundary
        ? {
            ...this.state.goal.boundaryConfirmation!,
            confirmedAt: resumedAt,
            confirmedRevision: this.state.goal.revision,
          }
        : this.state.goal.boundaryConfirmation,
    };
    this.persist();
    this.state.continuationDeferred = false;
    return true;
  }

  edit(objective: string, reason: string = 'User invoked /target edit.'): boolean {
    if (!this.state.goal || GOAL_TERMINAL_STATES.has(this.state.goal.status)) return false;
    if (!objective.trim()) return false;
    const g = this.state.goal;
    const nextObjective = objective.trim();
    if (nextObjective === g.objective) return true;
    const changedAt = Date.now();
    // v0.1.2: preserve originalObjective; record an objective revision on the
    // contract so steering can never silently rewrite the root goal. The
    // top-level `objective` reflects the current wording.
    const currentContract = g.contract ?? minimalContract(g.objective, g.updatedAt);
    const objectiveRevision = this.addGoalInteger(
      currentContract.objectiveRevision,
      1,
      'contract.objectiveRevision'
    );
    const contract: GoalContract = {
      ...currentContract,
      originalObjective: currentContract.originalObjective,
      objectiveRevision,
      objectiveHistory: [
        ...(currentContract.objectiveHistory ?? []),
        {
          revision: objectiveRevision,
          previousObjective: g.objective,
          objective: nextObjective,
          reason: reason.trim() || 'User invoked /target edit.',
          changedAt,
          source: 'user' as const,
        },
      ].slice(-50),
      successCriteria: currentContract.successCriteria.map(criterion =>
        criterion.id === 'criterion:primary'
          ? {
              ...criterion,
              statement: nextObjective,
              source: 'user',
              status: 'pending',
              evidenceRefs: [],
            }
          : criterion
      ),
    };
    const edited: SessionGoalV1 = {
      ...g,
      objective: nextObjective,
      contract,
      revision: this.addGoalInteger(g.revision, 1, 'revision'),
      updatedAt: changedAt,
      completionAudit: undefined,
      // Truncation is scoped to an objective epoch. A user edit intentionally
      // starts a fresh verification epoch; old evidence remains provenance but
      // cannot permanently block the edited objective.
      evidenceLedgerTruncation: undefined,
    };
    this.state.goal = goalRequiresBoundaryConfirmation(nextObjective)
      ? { ...pauseForBoundaryConfirmation(edited, changedAt), revision: edited.revision }
      : { ...edited, boundaryConfirmation: undefined };
    this.persist();
    this.state.continuationDeferred = this.state.goal.status !== 'active';
    return true;
  }

  /** Record trusted human acceptance for a criterion that requires user evidence. */
  confirmCriterion(criterionId: string): boolean {
    const goal = this.state.goal;
    const contract = goal?.contract;
    if (!goal || !contract || GOAL_TERMINAL_STATES.has(goal.status)) return false;
    const criterion = contract.successCriteria.find(item => item.id === criterionId.trim());
    if (!criterion || !criterion.requiredEvidenceKinds.includes('user')) return false;

    const now = Date.now();
    const revision = this.addGoalInteger(goal.revision, 1, 'revision');
    const evidenceId = `evidence:user:${randomUUID()}`;
    const record = {
      id: evidenceId,
      goalId: goal.goalId,
      goalRevision: revision,
      objectiveRevision: contract.objectiveRevision,
      turnId: `user-confirmation:${revision}`,
      kind: 'user' as const,
      subject: `User confirmed ${criterion.id}: ${criterion.statement}`.slice(0, 240),
      result: 'passed' as const,
      sourceRef: 'user:/target-confirm',
      capturedAt: now,
      redacted: true,
    };
    const boundedEvidence = appendBoundedEvidence(
      goal.evidenceLedger ?? [],
      [record],
      contract.objectiveRevision,
      goal.evidenceLedgerTruncation
    );
    this.state.goal = {
      ...goal,
      revision,
      updatedAt: now,
      evidenceLedger: boundedEvidence.ledger,
      evidenceLedgerTruncation: boundedEvidence.truncation,
      contract: {
        ...contract,
        successCriteria: contract.successCriteria.map(item =>
          item.id === criterion.id
            ? {
                ...item,
                status: 'passed',
                evidenceRefs: [...new Set([...item.evidenceRefs, evidenceId])],
              }
            : item
        ),
      },
      completionAudit: undefined,
    };
    this.persist();
    return true;
  }

  addConstraint(statement: string): boolean {
    const goal = this.state.goal;
    const trimmed = statement.trim();
    if (!goal || goal.status === 'complete' || !trimmed) return false;
    const contract = goal.contract ?? minimalContract(goal.objective, goal.updatedAt);
    if (contract.constraints.some(constraint => constraint.statement === trimmed)) return true;
    const revision = this.addGoalInteger(goal.revision, 1, 'revision');
    this.state.goal = {
      ...goal,
      contract: {
        ...contract,
        constraints: [
          ...contract.constraints,
          {
            id: `constraint:user:${revision}`,
            statement: trimmed,
            source: 'user',
          },
        ],
      },
      revision,
      updatedAt: Date.now(),
    };
    this.persist();
    return true;
  }

  replace(objective: string): boolean {
    if (this.loadRecoveryRequired) return false;
    if (!objective.trim()) return false;
    // Create new goal with fresh goalId and fresh contract; old generation
    // invalidated. Does not reuse the old goal's completion state.
    const now = Date.now();
    const contract = minimalContract(objective.trim(), now);
    const requiresBoundaryConfirmation = goalRequiresBoundaryConfirmation(objective);
    const result = persistGoal(
      this.projectPath,
      this.sessionId,
      objective,
      contract,
      this.state.goal?.revision,
      requiresBoundaryConfirmation
        ? boundaryConfirmationState(contract.objectiveRevision, now)
        : undefined
    );
    if (!result.ok) {
      this.restoreDiskAuthorityAfterMutationFailure();
      return false;
    }
    const replacement = result.value;
    this.state.goal = replacement;
    this.persistedGoalSnapshot = structuredClone(replacement);
    this.state.generation += 1;
    this.state.continuationDeferred = replacement.status !== 'active';
    return true;
  }

  setBudget(tokenBudget: number | null): boolean {
    if (!this.state.goal || this.state.goal.status === 'complete') return false;
    this.state.goal = {
      ...this.state.goal,
      tokenBudget: tokenBudget ?? undefined,
      revision: this.addGoalInteger(this.state.goal.revision, 1, 'revision'),
      updatedAt: Date.now(),
    };
    this.persist();
    return true;
  }

  clear(): boolean {
    if (!this.state.goal) return false;
    const result = deleteGoal(this.projectPath, this.sessionId, this.state.goal.revision);
    if (!result.ok) {
      this.restoreDiskAuthorityAfterMutationFailure();
      throw new Error(`${result.error}: ${result.message}`);
    }
    this.state.goal = null;
    this.persistedGoalSnapshot = null;
    this.state.generation += 1;
    this.state.continuationDeferred = false;
    return true;
  }

  // ==========================================================================
  // Turn integration
  // ==========================================================================

  buildContinuationRequest(): AgentTurnRequest | null {
    if (!this.canContinue) return null;
    const g = this.state.goal!;
    let continuationIndex: number;
    try {
      continuationIndex = this.addGoalInteger(g.continuationCount, 1, 'continuationCount');
    } catch {
      return null;
    }
    return {
      inputKind: 'goal_continuation',
      sessionId: this.sessionId,
      persistAsUserMessage: false,
      echoToTranscript: false,
      generation: this.state.generation,
      goal: {
        goalId: g.goalId,
        revision: g.revision,
        continuationIndex,
      },
    };
  }

  finalizeTurn(outcome: AgentTurnOutcome): void {
    const g = this.state.goal;
    if (!g) return;
    if (
      outcome.sessionId !== this.sessionId ||
      outcome.goalId !== g.goalId ||
      outcome.goalRevision !== g.revision ||
      (outcome.goalGeneration !== undefined && outcome.goalGeneration !== this.state.generation)
    )
      return;

    if (outcome.usageComplete === false) {
      const accounting = accumulateTurn(
        {
          tokensUsed: g.tokensUsed,
          timeUsedMs: g.timeUsedMs,
          continuationCount: g.continuationCount,
          noProgressCount: g.noProgressCount,
        },
        outcome
      );
      const pausedAt = Date.now();
      const tokensUsed = this.addGoalInteger(accounting.tokensUsed, 0, 'tokensUsed');
      const timeUsedMs = this.addGoalInteger(accounting.timeUsedMs, 0, 'timeUsedMs');
      const continuationCount = this.addGoalInteger(
        accounting.continuationCount,
        0,
        'continuationCount'
      );
      const noProgressCount = this.addGoalInteger(accounting.noProgressCount, 0, 'noProgressCount');
      this.state.goal = {
        ...g,
        tokensUsed,
        timeUsedMs,
        continuationCount,
        noProgressCount,
        status: 'paused',
        revision: this.addGoalInteger(g.revision, 1, 'revision'),
        updatedAt: pausedAt,
        lastTurn: {
          turnId: outcome.turnId,
          finishReason: outcome.finishReason,
          endedAt: outcome.endedAt,
          promptTokens: outcome.usage.promptTokens,
          completionTokens: outcome.usage.completionTokens,
          subagentTokens: outcome.usage.subagentTokens,
          totalTokens: outcome.usage.totalTokens,
          madeProgress: outcome.madeProgress,
        },
        stopReason: {
          kind: 'runtime_error',
          message:
            'Paused because provider usage was missing or incomplete across retry/fallback attempts; known usage was recorded, and budget accounting is incomplete.',
          at: pausedAt,
        },
      };
      this.state.continuationDeferred = true;
      this.persist();
      return;
    }

    const currentContract = g.contract ?? minimalContract(g.objective, g.updatedAt);
    const pendingPlanRevision = outcome.pendingPlanUpdate
      ? this.addGoalInteger(
          currentContract.planSnapshot?.revision ?? 0,
          1,
          'contract.planSnapshot.revision'
        )
      : 0;
    const pendingDerivedCriteria = outcome.pendingPlanUpdate
      ? newDerivedCriteria(currentContract, outcome.pendingPlanUpdate, pendingPlanRevision)
      : [];
    const pendingPlanChangesContent = outcome.pendingPlanUpdate
      ? planContentChanged(currentContract, outcome.pendingPlanUpdate)
      : false;
    const pendingPlanMutatesContract = Boolean(
      outcome.pendingPlanUpdate && (pendingPlanChangesContent || pendingDerivedCriteria.length > 0)
    );
    const newEvidence = (outcome.evidenceRecords ?? []).filter(
      record =>
        record.goalId === g.goalId &&
        record.goalRevision === g.revision &&
        record.objectiveRevision === (g.contract?.objectiveRevision ?? 0) &&
        record.turnId === outcome.turnId
    );
    const planAdvanced = Boolean(
      outcome.pendingPlanUpdate &&
      substantivePlanProgress(currentContract, outcome.pendingPlanUpdate, pendingDerivedCriteria)
    );
    const evidenceContract = pendingDerivedCriteria.length
      ? {
          ...currentContract,
          successCriteria: [...currentContract.successCriteria, ...pendingDerivedCriteria],
        }
      : currentContract;
    const incomingEvidenceKeys = evidenceProgressKeys(newEvidence, evidenceContract);
    const recordedEvidenceKeys = new Set(g.progressEvidenceKeys ?? []);
    const evidenceAdvanced = incomingEvidenceKeys.some(key => !recordedEvidenceKeys.has(key));
    const hasAuditableProgressInputs =
      outcome.workspaceChanged !== undefined ||
      outcome.evidenceRecords !== undefined ||
      outcome.pendingPlanUpdate !== undefined;
    // Text-only plan churn is still persisted as a snapshot for observability,
    // but phase/next-action/description rewrites are not Goal progress. Runtime
    // turns must present an auditable signal; legacy direct callers without the
    // new metadata retain their explicit madeProgress value for compatibility.
    const madeAuditableProgress =
      Boolean(outcome.workspaceChanged) || evidenceAdvanced || planAdvanced;
    const accountingOutcome = {
      ...outcome,
      madeProgress: hasAuditableProgressInputs ? madeAuditableProgress : outcome.madeProgress,
    };

    // Accumulate per-turn usage.
    const acc = accumulateTurn(
      {
        tokensUsed: g.tokensUsed,
        timeUsedMs: g.timeUsedMs,
        continuationCount: g.continuationCount,
        noProgressCount: g.noProgressCount,
      },
      accountingOutcome
    );
    const tokensUsed = this.addGoalInteger(acc.tokensUsed, 0, 'tokensUsed');
    const timeUsedMs = this.addGoalInteger(acc.timeUsedMs, 0, 'timeUsedMs');
    const continuationCount = this.addGoalInteger(acc.continuationCount, 0, 'continuationCount');
    const noProgressCount = this.addGoalInteger(acc.noProgressCount, 0, 'noProgressCount');

    const updated: SessionGoalV1 = {
      ...g,
      tokensUsed,
      timeUsedMs,
      continuationCount,
      noProgressCount,
      recentNoProgressTurns: accountingOutcome.madeProgress
        ? []
        : [...(g.recentNoProgressTurns ?? []), noProgressTurnSummary(accountingOutcome)].slice(-3),
      progressEvidenceKeys: [
        ...(g.progressEvidenceKeys ?? []),
        ...incomingEvidenceKeys.filter(key => !recordedEvidenceKeys.has(key)),
      ].slice(-1000),
      revision: this.addGoalInteger(g.revision, 1, 'revision'),
      updatedAt: Date.now(),
      lastTurn: {
        turnId: outcome.turnId,
        finishReason: outcome.finishReason,
        endedAt: outcome.endedAt,
        promptTokens: outcome.usage.promptTokens,
        completionTokens: outcome.usage.completionTokens,
        subagentTokens: outcome.usage.subagentTokens,
        totalTokens: outcome.usage.totalTokens,
        madeProgress: accountingOutcome.madeProgress,
      },
    };

    if (outcome.pendingPlanUpdate && pendingPlanMutatesContract) {
      const contract = updated.contract ?? minimalContract(updated.objective, updated.updatedAt);
      updated.contract = {
        ...contract,
        successCriteria: [...contract.successCriteria, ...pendingDerivedCriteria],
        planSnapshot: {
          revision: pendingPlanRevision,
          phase: outcome.pendingPlanUpdate.phase,
          steps: outcome.pendingPlanUpdate.steps.map((step, index) => ({
            id: `plan:${pendingPlanRevision}:${index + 1}`,
            description: step.description,
            done: step.done,
          })),
          nextAction: outcome.pendingPlanUpdate.nextAction,
          updatedAt: Date.now(),
        },
      };
    }

    const boundedEvidence = appendBoundedEvidence(
      g.evidenceLedger ?? [],
      newEvidence,
      currentContract.objectiveRevision,
      g.evidenceLedgerTruncation
    );
    const evidenceLedger = boundedEvidence.ledger;
    updated.evidenceLedger = evidenceLedger;
    updated.evidenceLedgerTruncation = boundedEvidence.truncation;

    // Process a terminal request only when it belongs to this exact turn and
    // goal revision. A stale tool call can never close a newer goal.
    const terminalRequest = outcome.pendingTerminalRequest;
    const currentBlockedSignal = Boolean(
      terminalRequest?.requestedStatus === 'blocked' &&
      terminalRequest.goalId === g.goalId &&
      terminalRequest.goalRevision === g.revision &&
      terminalRequest.turnId === outcome.turnId &&
      outcome.blocker &&
      updated.blocker?.fingerprint === outcome.blocker.fingerprint
    );
    // Consecutive means every Goal turn. Any intervening turn without the same
    // current-turn blocker breaks the streak instead of leaving an old counter
    // available for a later terminal request.
    if (updated.blocker && !currentBlockedSignal) updated.blocker = undefined;
    if (
      terminalRequest &&
      terminalRequest.goalId === g.goalId &&
      terminalRequest.goalRevision === g.revision &&
      terminalRequest.turnId === outcome.turnId
    ) {
      if (terminalRequest.requestedStatus === 'complete') {
        if (updated.contract && terminalRequest.criterionEvidence) {
          const ledgerById = new Map(evidenceLedger.map(record => [record.id, record]));
          const criterionCounts = new Map<string, number>();
          const evidenceCounts = new Map<string, number>();
          for (const mapping of terminalRequest.criterionEvidence) {
            criterionCounts.set(
              mapping.criterionId,
              (criterionCounts.get(mapping.criterionId) ?? 0) + 1
            );
            for (const id of mapping.evidenceIds) {
              evidenceCounts.set(id, (evidenceCounts.get(id) ?? 0) + 1);
            }
          }
          const mappings = new Map(
            terminalRequest.criterionEvidence.map(mapping => [
              mapping.criterionId,
              mapping.evidenceIds,
            ])
          );
          updated.contract = {
            ...updated.contract,
            successCriteria: updated.contract.successCriteria.map(criterion => {
              if (criterionCounts.get(criterion.id) !== 1) return criterion;
              const refs = (mappings.get(criterion.id) ?? []).filter(id => {
                const record = ledgerById.get(id);
                return Boolean(
                  record &&
                  evidenceCounts.get(id) === 1 &&
                  record.goalId === g.goalId &&
                  record.goalRevision <= g.revision &&
                  record.objectiveRevision === (updated.contract?.objectiveRevision ?? 0) &&
                  criterion.requiredEvidenceKinds.includes(record.kind)
                );
              });
              return {
                ...criterion,
                evidenceRefs: [...new Set([...criterion.evidenceRefs, ...refs])],
              };
            }),
          };
        }
        const audit = auditCompletion({
          objective: updated.objective,
          contract: updated.contract ?? minimalContract(updated.objective, updated.updatedAt),
          evidenceLedger,
          evidenceLedgerTruncation: updated.evidenceLedgerTruncation,
          goalId: g.goalId,
          goalRevision: g.revision,
          requestedAt: terminalRequest.requestedAt,
          verificationSummary: outcome.verificationSummary ?? outcome.finishReason,
          workspaceFingerprint: outcome.workspaceFingerprint,
        });
        updated.completionAudit = audit;
        if (updated.contract) {
          const statusById = new Map(
            audit.criterionResults?.map(result => [result.criterionId, result.status]) ?? []
          );
          updated.contract = {
            ...updated.contract,
            successCriteria: updated.contract.successCriteria.map(criterion => ({
              ...criterion,
              status: statusById.get(criterion.id) ?? 'pending',
            })),
          };
        }
        if (audit.passed) {
          const completedAt = Date.now();
          const criterionResults = audit.criterionResults ?? [];
          const finalLedgerById = new Map(evidenceLedger.map(record => [record.id, record]));
          updated.completionAudit = {
            ...audit,
            finalSummary: {
              originalObjective: updated.contract?.originalObjective ?? updated.objective,
              currentObjective: updated.objective,
              objectiveRevision: updated.contract?.objectiveRevision ?? 0,
              completedAt,
              verificationSummary: audit.verificationSummary,
              criterionResults: criterionResults.map(result => ({
                criterionId: result.criterionId,
                status: result.status,
                evidenceRefs: result.evidenceRefs,
                evidence: result.evidenceRefs.flatMap(id => {
                  const record = finalLedgerById.get(id);
                  return record ? [finalEvidenceReceipt(record)] : [];
                }),
              })),
              evidenceRefs: audit.evidenceRefs,
              accounting: {
                tokensUsed: updated.tokensUsed,
                timeUsedMs: updated.timeUsedMs,
                continuationCount: updated.continuationCount,
                usageComplete: true,
              },
              remainingRequirements: [],
              stopReason: 'completed',
            },
          };
          updated.status = 'complete';
          updated.completedAt = completedAt;
          delete updated.activeSince;
          delete updated.blocker;
          delete updated.stopReason;
          if (updated.contract) {
            const currentPlan = updated.contract.planSnapshot;
            updated.contract = {
              ...updated.contract,
              planSnapshot: {
                revision: this.addGoalInteger(
                  currentPlan?.revision ?? 0,
                  1,
                  'contract.planSnapshot.revision'
                ),
                phase: 'complete',
                steps: currentPlan?.steps ?? [],
                nextAction: undefined,
                updatedAt: completedAt,
              },
            };
          }
        } else if (updated.contract) {
          const currentPlan = updated.contract.planSnapshot;
          updated.contract = {
            ...updated.contract,
            planSnapshot: {
              revision: this.addGoalInteger(
                currentPlan?.revision ?? 0,
                1,
                'contract.planSnapshot.revision'
              ),
              phase: 'verification',
              steps: currentPlan?.steps ?? [],
              nextAction: audit.remainingRequirements[0],
              updatedAt: Date.now(),
            },
          };
        }
      } else if (terminalRequest.requestedStatus === 'blocked') {
        const blocker = outcome.blocker;
        if (blocker) {
          const fingerprint = blocker.fingerprint;
          const same = blockersMatch(updated.blocker, fingerprint);
          const newBlocker = {
            category: blocker.category,
            fingerprint,
            firstSeenAt: same && updated.blocker ? updated.blocker.firstSeenAt : Date.now(),
            lastSeenAt: Date.now(),
            consecutiveTurns: same
              ? this.addGoalInteger(
                  updated.blocker?.consecutiveTurns ?? 0,
                  1,
                  'blocker.consecutiveTurns'
                )
              : 1,
            summary: blocker.summary,
            retryable: false as const,
          };
          updated.blocker = newBlocker;

          const blockAudit = auditBlocked({
            blocker: newBlocker,
            noProgressCount: updated.noProgressCount,
          });
          if (blockAudit.allowed) {
            updated.status = 'blocked';
            updated.stopReason = { kind: 'blocked', message: blockAudit.reason, at: Date.now() };
          }
        }
      }
    }

    if (
      updated.lastTurn &&
      !updated.lastTurn.madeProgress &&
      criterionStateAdvanced(currentContract, updated.contract, evidenceLedger)
    ) {
      updated.noProgressCount = 0;
      updated.recentNoProgressTurns = [];
      updated.lastTurn = { ...updated.lastTurn, madeProgress: true };
    }

    const providerStop = classifyStopReason(outcome.providerError);
    if (providerStop && updated.status === 'active') {
      updated.status = providerStop.kind === 'usage_limit' ? 'usage_limited' : 'paused';
      updated.stopReason = {
        kind: providerStop.kind,
        message: providerStop.message,
        at: Date.now(),
      };
      this.state.continuationDeferred = true;
    }

    // Auto-pause on no-progress threshold.
    if (
      updated.noProgressCount >= GOAL_INVARIANTS.maxConsecutiveNoProgressTurns &&
      updated.status === 'active'
    ) {
      updated.status = 'paused';
      const recent = updated.recentNoProgressTurns ?? [];
      updated.stopReason = {
        kind: 'user',
        message: `Auto-paused: no progress for 3 consecutive turns. Recent turns: ${formatNoProgressTurns(recent)}.`,
        at: Date.now(),
      };
      this.state.continuationDeferred = true;
    }

    // Budget limit.
    if (isBudgetExceeded(updated.tokensUsed, updated.tokenBudget) && updated.status === 'active') {
      updated.status = 'budget_limited';
      updated.stopReason = {
        kind: 'budget_limit',
        message: `Token budget reached: ${updated.tokensUsed}/${updated.tokenBudget}`,
        at: Date.now(),
      };
    }

    this.state.goal = updated;
    this.persist();
  }

  /**
   * Account an interrupted turn whose request revision was superseded by live steering.
   *
   * This deliberately ignores every semantic payload on the stale outcome: evidence,
   * plan updates, blockers, and terminal requests belong to the old contract revision.
   * Only already-incurred token/time/turn accounting is retained, without changing the
   * revised Goal's no-progress streak.
   */
  accountStaleTurn(outcome: AgentTurnOutcome): boolean {
    const g = this.state.goal;
    if (
      !g ||
      outcome.sessionId !== this.sessionId ||
      outcome.goalId !== g.goalId ||
      outcome.goalRevision === undefined ||
      outcome.goalRevision >= g.revision ||
      (outcome.goalGeneration !== undefined && outcome.goalGeneration !== this.state.generation)
    ) {
      return false;
    }

    const key = `${outcome.goalId}:${outcome.goalGeneration ?? this.state.generation}:${outcome.turnId}`;
    if (this.accountedStaleTurnKeys.has(key)) return false;

    const endedAt = Math.max(outcome.startedAt, outcome.endedAt);
    const elapsedMs = endedAt - outcome.startedAt;
    const tokensUsed = this.addGoalInteger(
      g.tokensUsed,
      Math.max(0, outcome.usage.totalTokens),
      'tokensUsed'
    );
    const timeUsedMs = this.addGoalInteger(g.timeUsedMs, elapsedMs, 'timeUsedMs');
    const continuationCount = this.addGoalInteger(g.continuationCount, 1, 'continuationCount');
    const revision = this.addGoalInteger(g.revision, 1, 'revision');
    this.accountedStaleTurnKeys.add(key);
    const updated: SessionGoalV1 = {
      ...g,
      tokensUsed,
      timeUsedMs,
      continuationCount,
      revision,
      updatedAt: Date.now(),
      lastTurn: {
        turnId: outcome.turnId,
        finishReason: outcome.finishReason,
        endedAt,
        promptTokens: Math.max(0, outcome.usage.promptTokens),
        completionTokens: Math.max(0, outcome.usage.completionTokens),
        subagentTokens: Math.max(0, outcome.usage.subagentTokens),
        totalTokens: Math.max(0, outcome.usage.totalTokens),
        madeProgress: false,
      },
    };

    if (isBudgetExceeded(updated.tokensUsed, updated.tokenBudget) && updated.status === 'active') {
      updated.status = 'budget_limited';
      updated.stopReason = {
        kind: 'budget_limit',
        message: `Token budget reached: ${updated.tokensUsed}/${updated.tokenBudget}`,
        at: Date.now(),
      };
      this.state.continuationDeferred = true;
    }

    this.state.goal = updated;
    try {
      this.persist();
    } catch (error) {
      // The key protects an in-flight attempt, but a failed pre-commit save did
      // not durably account the turn. Release it only after persist() restores
      // disk authority so the same outcome can be retried exactly once.
      this.accountedStaleTurnKeys.delete(key);
      throw error;
    }
    return true;
  }

  deferContinuation(): void {
    if (!this.state.goal || this.state.goal.status !== 'active') return;
    this.state.continuationDeferred = true;
    const g = this.state.goal;
    this.state.goal = {
      ...g,
      status: 'paused',
      revision: this.addGoalInteger(g.revision, 1, 'revision'),
      updatedAt: Date.now(),
      stopReason: { kind: 'user', message: 'Paused by interrupt.', at: Date.now() },
    };
    this.persist();
  }

  limitBudget(reason: string): void {
    const goal = this.state.goal;
    if (!goal || goal.status !== 'active') return;
    this.state.goal = {
      ...goal,
      status: 'budget_limited',
      revision: this.addGoalInteger(goal.revision, 1, 'revision'),
      updatedAt: Date.now(),
      stopReason: { kind: 'budget_limit', message: reason, at: Date.now() },
    };
    this.state.continuationDeferred = true;
    this.persist();
  }

  /**
   * Apply a runtime-only safety overlay after a mutation failed to persist.
   * `persist()` has already restored the disk-authoritative Goal. Keep its
   * revision intact so `/target resume` can save normally once storage recovers,
   * while invalidating every in-flight request and queued continuation now.
   */
  failClosedAfterPersistenceError(reason: string): void {
    const goal = this.state.goal;
    this.state.generation += 1;
    this.state.continuationDeferred = true;
    if (!goal || goal.status === 'complete') return;
    this.state.goal = {
      ...goal,
      status: 'paused',
      updatedAt: Date.now(),
      stopReason: {
        kind: 'runtime_error',
        message: redactTraceText(reason).slice(0, 600),
        at: Date.now(),
      },
    };
  }

  // ==========================================================================
  // Persistence
  // ==========================================================================

  /** Restore disk authority without reviving a deletion-fenced Goal. */
  private restoreDiskAuthorityAfterMutationFailure(): void {
    const persisted = loadGoal(this.projectPath, this.sessionId);
    if (persisted.ok) {
      this.loadRecoveryRequired = false;
      this.state.goal = ensureContract(persisted.value);
      this.persistedGoalSnapshot = structuredClone(this.state.goal);
      this.state.continuationDeferred = true;
      return;
    }
    if (persisted.error === 'not_found') {
      this.loadRecoveryRequired = false;
      this.state.goal = null;
      this.persistedGoalSnapshot = null;
      this.state.generation += 1;
      this.state.continuationDeferred = false;
      return;
    }
    if (this.persistedGoalSnapshot) {
      this.state.goal = structuredClone(this.persistedGoalSnapshot);
    } else {
      this.state.goal = null;
    }
    this.loadRecoveryRequired = true;
    this.state.continuationDeferred = true;
  }

  private persist(): void {
    if (!this.state.goal) return;
    const result = saveGoal(
      this.projectPath,
      this.sessionId,
      this.state.goal,
      Math.max(0, this.state.goal.revision - 1)
    );
    if (result.ok) {
      this.persistedGoalSnapshot = structuredClone(this.state.goal);
      return;
    }
    if (!result.ok) {
      this.restoreDiskAuthorityAfterMutationFailure();
      throw new Error(`Goal persistence failed (${result.error}): ${result.message}`);
    }
  }
}
