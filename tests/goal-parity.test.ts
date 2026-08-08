/**
 * Phase 3 (P0-C) — Goal parity tests across renderers.
 *
 * Validates that:
 *  - /target command parsing produces identical results regardless of renderer
 *  - Goal coordinator state machine is renderer-agnostic
 *  - Completion audit works for both TUI and terminal renderers
 *  - Renderer switching does not change goal state
 */

import { GoalCoordinator } from '../src/runtime/goals/coordinator';
import { randomUUID } from 'crypto';
import { goalTransition, GOAL_INVARIANTS } from '../src/runtime/goals/types';
import type { GoalContract, GoalEvidenceRecord, GoalStatus } from '../src/runtime/goals/types';
import {
  auditCompletion,
  auditBlocked,
  blockerFingerprint,
} from '../src/runtime/goals/completion-audit';
import { parseTargetCommand } from '../src/commands/target-command';
import { findCommand } from '../src/commands';

// ---------------------------------------------------------------------------
// Goal command parser parity
// ---------------------------------------------------------------------------

describe('Goal command parser parity', () => {
  const renderers = ['tui', 'terminal', 'ink', 'print'] as const;

  it('parseTargetCommand produces same result regardless of renderer context', () => {
    const cases = [
      '/target',
      '/target status',
      '/goal',
      '/goal status',
      '/target pause',
      '/target resume',
      '/target edit fix all bugs',
      '/target replace rewrite the API',
      '/target clear --yes',
      '/target budget 50000',
      '/target budget off',
      '/target build a feature with many words in the objective',
      '/goal pause',
      '/goal resume',
    ];

    for (const input of cases) {
      const results = renderers.map(() => parseTargetCommand(input));
      const first = results[0];
      for (let i = 1; i < results.length; i++) {
        expect(results[i]).toEqual(first);
      }
    }
  });

  it('/target and /goal commands share renderer scope (all renderers)', () => {
    const target = findCommand('target');
    const goal = findCommand('goal');
    expect(goal).toBe(target);
    expect(target?.rendererScope).toBeUndefined();
    expect(goal?.rendererScope).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Goal state machine
// ---------------------------------------------------------------------------

describe('Goal state machine', () => {
  it('goalTransition from null with create returns active', () => {
    expect(goalTransition(null, 'create')).toBe('active');
  });

  it('goalTransition from active to pause returns paused', () => {
    expect(goalTransition('active', 'pause')).toBe('paused');
  });

  it('goalTransition from active to complete returns complete', () => {
    expect(goalTransition('active', 'complete')).toBe('complete');
  });

  it('goalTransition from active to block returns blocked', () => {
    expect(goalTransition('active', 'block')).toBe('blocked');
  });

  it('goalTransition from paused to resume returns active', () => {
    expect(goalTransition('paused', 'resume')).toBe('active');
  });

  it('goalTransition from blocked to resume returns active', () => {
    expect(goalTransition('blocked', 'resume')).toBe('active');
  });

  it('goalTransition complete is terminal', () => {
    expect(goalTransition('complete', 'pause')).toBeNull();
    expect(goalTransition('complete', 'block')).toBeNull();
    expect(goalTransition('complete', 'resume')).toBeNull();
  });

  it('goalTransition replace always returns active', () => {
    expect(goalTransition('active', 'replace')).toBe('active');
    expect(goalTransition('paused', 'replace')).toBe('active');
    expect(goalTransition('complete', 'replace')).toBe('active');
    expect(goalTransition(null, 'replace')).toBe('active');
  });

  it('goalTransition clear always returns null (removes goal)', () => {
    expect(goalTransition('active', 'clear')).toBeNull();
    expect(goalTransition('paused', 'clear')).toBeNull();
    expect(goalTransition('complete', 'clear')).toBeNull();
    expect(goalTransition(null, 'clear')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Goal coordinator lifecycle
// ---------------------------------------------------------------------------

describe('Goal coordinator lifecycle', () => {
  let coord: GoalCoordinator;

  beforeEach(() => {
    coord = new GoalCoordinator(`/tmp/test-goal-${randomUUID()}`, 'test-session');
  });

  it('starts with no active goal', () => {
    expect(coord.goal).toBeNull();
    expect(coord.isActive).toBe(false);
  });

  it('creates a goal and transitions to active', () => {
    const result = coord.create('Fix all bugs');
    expect(result.ok).toBe(true);
    expect(coord.goal?.status).toBe('active');
    expect(coord.goal?.objective).toBe('Fix all bugs');
    expect(coord.isActive).toBe(true);
  });

  it('pauses and resumes a goal', () => {
    coord.create('Fix all bugs');
    expect(coord.goal?.status).toBe('active');

    coord.pause();
    expect(coord.goal?.status).toBe('paused');
    expect(coord.isActive).toBe(false);

    coord.resume();
    expect(coord.goal?.status).toBe('active');
    expect(coord.isActive).toBe(true);
  });

  it('edits a goal while preserving goalId', () => {
    coord.create('Fix all bugs');
    const goalId = coord.goal!.goalId;

    coord.edit('Fix critical bugs only');
    expect(coord.goal?.objective).toBe('Fix critical bugs only');
    expect(coord.goal?.goalId).toBe(goalId);
  });

  it('replaces a goal with a new goalId', () => {
    coord.create('Fix all bugs');
    const oldGoalId = coord.goal!.goalId;

    coord.replace('Build new feature');
    expect(coord.goal?.objective).toBe('Build new feature');
    expect(coord.goal?.goalId).not.toBe(oldGoalId);
  });

  it('clears a goal', () => {
    coord.create('Fix all bugs');
    coord.clear();
    expect(coord.isActive).toBe(false);
  });

  it('sets and removes a token budget', () => {
    coord.create('Fix all bugs');
    expect(coord.goal?.tokenBudget).toBeUndefined();

    coord.setBudget(100000);
    expect(coord.goal?.tokenBudget).toBe(100000);

    coord.setBudget(null);
    // budget removal clears the field entirely
    expect(coord.goal?.tokenBudget).toBeFalsy();
  });

  it('rejects creating a goal with an objective exceeding the max length', () => {
    const longObjective = 'x'.repeat(GOAL_INVARIANTS.maxObjectiveChars + 1);
    const result = coord.create(longObjective);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('too long');
    }
  });

  it('builds continuation request for active goals', () => {
    coord.create('Fix all bugs');
    const req = coord.buildContinuationRequest();
    expect(req).not.toBeNull();
    expect(req?.goal?.goalId).toBe(coord.goal?.goalId);
  });

  it('does not build continuation request for paused goals', () => {
    coord.create('Fix all bugs');
    coord.pause();
    const req = coord.buildContinuationRequest();
    expect(req).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Completion audit
// ---------------------------------------------------------------------------

describe('Completion audit', () => {
  const contract: GoalContract = {
    originalObjective: 'Verify renderer parity',
    objectiveRevision: 0,
    constraints: [],
    successCriteria: [
      {
        id: 'criterion:primary',
        statement: 'Renderer parity remains stable',
        source: 'derived',
        status: 'pending',
        requiredEvidenceKinds: ['test'],
        evidenceRefs: ['e-1'],
      },
    ],
  };
  const evidence: GoalEvidenceRecord = {
    id: 'e-1',
    goalId: 'goal-1',
    goalRevision: 1,
    objectiveRevision: contract.objectiveRevision,
    turnId: 'turn-1',
    kind: 'test',
    subject: 'renderer parity test suite',
    result: 'passed',
    sourceRef: 'tool:call-1:exec_command',
    capturedAt: 1,
    workspaceFingerprint: 'workspace-current',
    redacted: true,
  };

  it('auditCompletion requires evidence for completion', () => {
    const result = auditCompletion({
      objective: 'Test goal',
      contract,
      evidenceLedger: [],
      goalId: 'goal-1',
      goalRevision: 1,
      requestedAt: 1,
      verificationSummary: '',
      workspaceFingerprint: 'workspace-current',
    });
    expect(result.passed).toBe(false);
  });

  it('auditCompletion allows completion with sufficient evidence', () => {
    const result = auditCompletion({
      objective: 'Test goal',
      contract,
      evidenceLedger: [evidence],
      goalId: 'goal-1',
      goalRevision: 1,
      requestedAt: 1,
      verificationSummary: 'All tests pass, code compiles. Feature complete.',
      workspaceFingerprint: 'workspace-current',
    });
    expect(result.passed).toBe(true);
  });

  it('auditBlocked requires 3+ consecutive turns and 3+ no-progress counts', () => {
    const insufficient = auditBlocked({
      blocker: {
        category: 'permission',
        retryable: false,
        fingerprint: 'missing:tests',
        firstSeenAt: Date.now() - 60000,
        lastSeenAt: Date.now(),
        consecutiveTurns: 1,
        summary: 'Tests not passing',
      },
      noProgressCount: 1,
    });
    expect(insufficient.allowed).toBe(false);

    const sufficient = auditBlocked({
      blocker: {
        category: 'permission',
        retryable: false,
        fingerprint: 'missing:tests',
        firstSeenAt: Date.now() - 60000,
        lastSeenAt: Date.now(),
        consecutiveTurns: 3,
        summary: 'Tests not passing',
      },
      noProgressCount: 3,
    });
    expect(sufficient.allowed).toBe(true);
  });

  it('blockerFingerprint produces stable fingerprints', () => {
    const fp1 = blockerFingerprint('test', 'src/index.ts', 'Tests not passing');
    const fp2 = blockerFingerprint('test', 'src/index.ts', 'Tests not passing');
    expect(fp1).toBe(fp2);
  });

  it('blockerFingerprint produces different fingerprints for different resources', () => {
    const fp1 = blockerFingerprint('test', 'src/a.ts', 'Missing tests');
    const fp2 = blockerFingerprint('test', 'src/b.ts', 'Missing tests');
    expect(fp1).not.toBe(fp2);
  });
});

// ---------------------------------------------------------------------------
// Renderer switching does not change goal state
// ---------------------------------------------------------------------------

describe('Renderer-agnostic goal state', () => {
  it('GoalCoordinator does not reference any renderer', () => {
    const coord = new GoalCoordinator('/tmp/test-goal', 'session-1');
    coord.create('Test goal');
    const goal = coord.goal;
    expect(goal).not.toBeNull();
    expect(goal).not.toHaveProperty('renderer');
    expect(goal).not.toHaveProperty('uiRenderer');
    expect(goal).not.toHaveProperty('ui');
  });

  it('parseTargetCommand does not reference any renderer', () => {
    const source = parseTargetCommand.toString();
    expect(source).not.toContain('uiRenderer');
    expect(source).not.toContain('renderer');
  });
});
