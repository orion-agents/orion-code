/**
 * v0.2.24 — Goal Coordinator.
 *
 * Single-flight state machine that manages goal lifecycle: creation,
 * pause/resume, auto-continuation, completion/blocked audit, and
 * persistence. Owned by AgentRuntimeController — NOT a global singleton.
 */

import {
  type SessionGoalV1,
  type RuntimeGoalSnapshot,
  type GoalStatus,
  type AgentTurnOutcome,
  type AgentTurnRequest,
  type GoalContract,
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
import { accumulateTurn, isBudgetExceeded } from './accounting';
import { auditCompletion, auditBlocked, blockerFingerprint, blockersMatch } from './completion-audit';

/**
 * Build a minimal pending contract from an objective string. Used at creation
 * and at load time to normalize v0.1.1 sidecars (which have no contract).
 *
 * The primary criterion is `source=derived` with a stable id so repeated
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
        source: 'derived',
        status: 'pending',
        // A derived primary criterion accepts test/build/file/runtime evidence;
        // model natural language is never an accepted kind.
        requiredEvidenceKinds: ['test', 'build', 'file', 'runtime'],
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

/** Ensure a loaded goal carries a contract; normalize v0.1.1 sidecars. */
function ensureContract(goal: SessionGoalV1): SessionGoalV1 {
  if (goal.contract) return goal;
  return { ...goal, contract: minimalContract(goal.objective, goal.updatedAt || goal.createdAt) };
}

export interface GoalCoordinatorState {
  goal: SessionGoalV1 | null;
  generation: number;
  continuationDeferred: boolean;
}

export class GoalCoordinator {
  private state: GoalCoordinatorState = { goal: null, generation: 0, continuationDeferred: false };

  constructor(
    private readonly projectPath: string,
    private readonly sessionId: string,
  ) {}

  // ==========================================================================
  // Queries
  // ==========================================================================

  get goal(): SessionGoalV1 | null { return this.state.goal; }
  get generation(): number { return this.state.generation; }
  get isActive(): boolean { return this.state.goal?.status === 'active'; }
  get canContinue(): boolean {
    return this.isActive
      && !this.state.continuationDeferred
      && !isBudgetExceeded(this.state.goal!.tokensUsed, this.state.goal!.tokenBudget);
  }

  snapshot(): RuntimeGoalSnapshot | null {
    const g = this.state.goal;
    if (!g) return null;
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
    };
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  load(): boolean {
    const result = loadGoal(this.projectPath, this.sessionId);
    if (result.ok) {
      // v0.1.2: normalize v0.1.1 sidecars (no contract) into a minimal pending
      // contract. This is in-memory only; it does not rewrite the sidecar
      // until the next real state update.
      this.state.goal = ensureContract(result.value);
      this.state.generation = 0;
      this.state.continuationDeferred = false;
      return true;
    }
    return false;
  }

  create(objective: string): { ok: true } | { ok: false; error: string } {
    if (this.state.goal && !GOAL_TERMINAL_STATES.has(this.state.goal.status)) {
      return { ok: false, error: 'An active goal already exists. Use /target replace to change it.' };
    }
    if (!objective.trim()) {
      return { ok: false, error: 'Objective cannot be empty.' };
    }
    if (objective.length > GOAL_INVARIANTS.maxObjectiveChars) {
      return { ok: false, error: `Objective too long (max ${GOAL_INVARIANTS.maxObjectiveChars} chars).` };
    }

    const now = Date.now();
    const contract = minimalContract(objective.trim(), now);
    const result = persistGoal(this.projectPath, this.sessionId, objective, contract);
    if (!result.ok) return { ok: false, error: result.message };

    this.state.goal = result.value;
    this.state.generation += 1;
    this.state.continuationDeferred = false;
    return { ok: true };
  }

  pause(): boolean {
    if (!this.state.goal || this.state.goal.status !== 'active') return false;
    this.state.goal = {
      ...this.state.goal,
      status: 'paused',
      revision: this.state.goal.revision + 1,
      updatedAt: Date.now(),
      stopReason: { kind: 'user', message: 'Paused by user.', at: Date.now() },
    };
    this.persist();
    this.state.continuationDeferred = true;
    return true;
  }

  resume(): boolean {
    if (!this.state.goal || !GOAL_USER_RECOVERABLE_STATES.has(this.state.goal.status)) return false;
    this.state.goal = {
      ...this.state.goal,
      status: 'active',
      revision: this.state.goal.revision + 1,
      updatedAt: Date.now(),
      activeSince: Date.now(),
      stopReason: undefined,
      blocker: undefined,
      noProgressCount: 0,
    };
    this.persist();
    this.state.continuationDeferred = false;
    return true;
  }

  edit(objective: string): boolean {
    if (!this.state.goal) return false;
    if (!objective.trim()) return false;
    const g = this.state.goal;
    // v0.1.2: preserve originalObjective; record an objective revision on the
    // contract so steering can never silently rewrite the root goal. The
    // top-level `objective` reflects the current wording.
    const contract: GoalContract = g.contract
      ? { ...g.contract, originalObjective: g.contract.originalObjective, objectiveRevision: g.contract.objectiveRevision + 1 }
      : minimalContract(g.objective, g.updatedAt);
    this.state.goal = {
      ...g,
      objective: objective.trim(),
      contract,
      revision: g.revision + 1,
      updatedAt: Date.now(),
    };
    this.persist();
    return true;
  }

  replace(objective: string): boolean {
    if (!objective.trim()) return false;
    // Create new goal with fresh goalId and fresh contract; old generation
    // invalidated. Does not reuse the old goal's completion state.
    const now = Date.now();
    const contract = minimalContract(objective.trim(), now);
    const result = persistGoal(this.projectPath, this.sessionId, objective, contract);
    if (!result.ok) return false;
    this.state.goal = result.value;
    this.state.generation += 1;
    this.state.continuationDeferred = false;
    return true;
  }

  setBudget(tokenBudget: number | null): boolean {
    if (!this.state.goal) return false;
    this.state.goal = {
      ...this.state.goal,
      tokenBudget: tokenBudget ?? undefined,
      revision: this.state.goal.revision + 1,
      updatedAt: Date.now(),
    };
    this.persist();
    return true;
  }

  clear(): boolean {
    if (!this.state.goal) return false;
    deleteGoal(this.projectPath, this.sessionId);
    this.state.goal = null;
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
    return {
      inputKind: 'goal_continuation',
      sessionId: this.sessionId,
      persistAsUserMessage: false,
      echoToTranscript: false,
      goal: {
        goalId: g.goalId,
        revision: g.revision,
        continuationIndex: g.continuationCount + 1,
      },
    };
  }

  finalizeTurn(outcome: AgentTurnOutcome): void {
    const g = this.state.goal;
    if (!g) return;
    if (outcome.goalId !== g.goalId || outcome.goalRevision !== g.revision) return;

    // Accumulate usage.
    const acc = accumulateTurn(
      { tokensUsed: g.tokensUsed, timeUsedMs: g.timeUsedMs, continuationCount: g.continuationCount, noProgressCount: g.noProgressCount },
      outcome,
    );

    const updated: SessionGoalV1 = {
      ...g,
      tokensUsed: acc.tokensUsed,
      timeUsedMs: acc.timeUsedMs,
      continuationCount: acc.continuationCount,
      noProgressCount: acc.noProgressCount,
      revision: g.revision + 1,
      updatedAt: Date.now(),
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
    };

    // Process pending terminal request.
    if (outcome.pendingTerminalRequest) {
      if (outcome.pendingTerminalRequest.requestedStatus === 'complete') {
        const audit = auditCompletion({
          objective: updated.objective,
          // v0.1.2: use actual evidence captured during the turn (typed on
          // AgentTurnOutcome). The controller populates these from real
          // tool/runtime results; empty until Phase 3 wires capture.
          evidenceRefs: outcome.evidenceRefs ?? [],
          verificationSummary: outcome.verificationSummary ?? outcome.finishReason,
        });
        updated.completionAudit = audit;
        if (audit.passed) {
          updated.status = 'complete';
          updated.completedAt = Date.now();
        }
      } else if (outcome.pendingTerminalRequest.requestedStatus === 'blocked') {
        const blocker = outcome.blocker;
        if (blocker) {
          const fingerprint = blockerFingerprint(blocker.fingerprint, '', '');
          const same = blockersMatch(updated.blocker, fingerprint);
          const newBlocker = {
            fingerprint,
            firstSeenAt: same && updated.blocker ? updated.blocker.firstSeenAt : Date.now(),
            lastSeenAt: Date.now(),
            consecutiveTurns: same ? (updated.blocker?.consecutiveTurns ?? 0) + 1 : 1,
            summary: blocker.summary,
          };
          updated.blocker = newBlocker;

          const blockAudit = auditBlocked({ blocker: newBlocker, noProgressCount: updated.noProgressCount });
          if (blockAudit.allowed) {
            updated.status = 'blocked';
            updated.stopReason = { kind: 'blocked', message: blockAudit.reason, at: Date.now() };
          }
        }
      }
    }

    // Auto-pause on no-progress threshold.
    if (updated.noProgressCount >= GOAL_INVARIANTS.maxConsecutiveNoProgressTurns && updated.status === 'active') {
      updated.status = 'paused';
      updated.stopReason = { kind: 'user', message: 'Auto-paused: no progress for 3 consecutive turns.', at: Date.now() };
      this.state.continuationDeferred = true;
    }

    // Budget limit.
    if (isBudgetExceeded(updated.tokensUsed, updated.tokenBudget) && updated.status === 'active') {
      updated.status = 'budget_limited';
      updated.stopReason = { kind: 'budget_limit', message: `Token budget reached: ${updated.tokensUsed}/${updated.tokenBudget}`, at: Date.now() };
    }

    this.state.goal = updated;
    this.persist();
  }

  deferContinuation(): void {
    if (!this.state.goal || this.state.goal.status !== 'active') return;
    this.state.continuationDeferred = true;
    const g = this.state.goal;
    this.state.goal = {
      ...g,
      status: 'paused',
      revision: g.revision + 1,
      updatedAt: Date.now(),
      stopReason: { kind: 'user', message: 'Paused by interrupt.', at: Date.now() },
    };
    this.persist();
  }

  // ==========================================================================
  // Persistence
  // ==========================================================================

  private persist(): void {
    if (!this.state.goal) return;
    saveGoal(this.projectPath, this.sessionId, this.state.goal);
  }
}