/**
 * Phase 1 (P0-2) - Goal Contract & Plan Snapshot tests.
 *
 * Validates the additive GoalContract layer: originalObjective preservation,
 * objectiveRevision bumping, criterion model, and v0.1.1 sidecar
 * normalization into a minimal pending contract.
 */

import { GoalCoordinator } from '../src/runtime/goals/coordinator';
import { goalTransition } from '../src/runtime/goals/types';
import type { SessionGoalV1, GoalContract } from '../src/runtime/goals/types';

// ---------------------------------------------------------------------------
// Contract creation
// ---------------------------------------------------------------------------

describe('Goal contract creation', () => {
  let coord: GoalCoordinator;

  beforeEach(() => {
    coord = new GoalCoordinator('/tmp/test-contract-create', 'contract-create');
  });

  it('create() builds a contract with originalObjective and a derived primary criterion', () => {
    const result = coord.create('Fix the login bug');
    expect(result.ok).toBe(true);

    const contract = coord.goal!.contract;
    expect(contract).toBeDefined();
    expect(contract!.originalObjective).toBe('Fix the login bug');
    expect(contract!.objectiveRevision).toBe(0);
    expect(contract!.successCriteria.length).toBeGreaterThan(0);

    const primary = contract!.successCriteria[0];
    expect(primary.source).toBe('derived');
    expect(primary.status).toBe('pending');
    expect(primary.statement).toBe('Fix the login bug');
    expect(primary.requiredEvidenceKinds.length).toBeGreaterThan(0);
    expect(primary.evidenceRefs).toEqual([]);
  });

  it('the derived primary criterion has a stable id across normalizations', () => {
    coord.create('Stable id goal');
    const id1 = coord.goal!.contract!.successCriteria[0].id;

    // Simulate a reload from sidecar (which triggers ensureContract).
    const reloaded = new GoalCoordinator('/tmp/test-contract-create', 'contract-create');
    reloaded.load();
    const id2 = reloaded.goal!.contract!.successCriteria[0].id;

    expect(id1).toBe(id2);
  });

  it('plan snapshot starts at revision 0, phase initial', () => {
    coord.create('Goal with plan');
    const plan = coord.goal!.contract!.planSnapshot;
    expect(plan).toBeDefined();
    expect(plan!.revision).toBe(0);
    expect(plan!.phase).toBe('initial');
    expect(plan!.steps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// edit() preserves originalObjective
// ---------------------------------------------------------------------------

describe('edit() preserves originalObjective', () => {
  let coord: GoalCoordinator;

  beforeEach(() => {
    coord = new GoalCoordinator('/tmp/test-contract-edit', 'contract-edit');
    coord.create('Original objective wording');
  });

  it('edit changes the current objective but keeps originalObjective', () => {
    const original = coord.goal!.contract!.originalObjective;
    expect(original).toBe('Original objective wording');

    coord.edit('Refined objective wording');
    expect(coord.goal!.objective).toBe('Refined objective wording');
    expect(coord.goal!.contract!.originalObjective).toBe('Original objective wording');
  });

  it('edit bumps objectiveRevision on the contract', () => {
    const before = coord.goal!.contract!.objectiveRevision;
    coord.edit('First refinement');
    const after = coord.goal!.contract!.objectiveRevision;
    expect(after).toBe(before + 1);
  });

  it('repeated edits keep bumping objectiveRevision and never touch originalObjective', () => {
    coord.edit('Refinement 1');
    coord.edit('Refinement 2');
    coord.edit('Refinement 3');
    expect(coord.goal!.contract!.objectiveRevision).toBe(3);
    expect(coord.goal!.contract!.originalObjective).toBe('Original objective wording');
  });
});

// ---------------------------------------------------------------------------
// replace() creates a fresh contract
// ---------------------------------------------------------------------------

describe('replace() creates a fresh contract', () => {
  let coord: GoalCoordinator;

  beforeEach(() => {
    coord = new GoalCoordinator('/tmp/test-contract-replace', 'contract-replace');
    coord.create('First goal');
  });

  it('replace creates a new goalId and fresh contract', () => {
    const oldGoalId = coord.goal!.goalId;
    const oldContract = coord.goal!.contract!;

    coord.replace('Completely new goal');
    expect(coord.goal!.goalId).not.toBe(oldGoalId);
    expect(coord.goal!.contract!.originalObjective).toBe('Completely new goal');
    expect(coord.goal!.contract!.objectiveRevision).toBe(0);
    // Fresh contract, not the old one.
    expect(coord.goal!.contract).not.toBe(oldContract);
  });

  it('replace does not reuse old completion state', () => {
    // Even if the old goal somehow had a completion audit, replace starts clean.
    coord.replace('New goal after old');
    expect(coord.goal!.completionAudit).toBeUndefined();
    expect(coord.goal!.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// v0.1.1 sidecar normalization
// ---------------------------------------------------------------------------

describe('v0.1.1 sidecar normalization', () => {
  it('a goal with no contract gets a minimal pending contract on load', () => {
    // Construct a v0.1.1-era goal sidecar (no contract field) and verify
    // ensureContract synthesizes one. We test the coordinator's load path
    // by simulating the normalization directly on a raw goal object.
    const v011Goal: SessionGoalV1 = {
      version: 1,
      goalId: 'legacy-1',
      sessionId: 'legacy-session',
      revision: 2,
      objective: 'Legacy objective',
      status: 'active',
      tokensUsed: 500,
      timeUsedMs: 1000,
      createdAt: 1000,
      updatedAt: 2000,
      continuationCount: 3,
      noProgressCount: 0,
      // No contract field - this is the v0.1.1 shape.
    };
    expect(v011Goal.contract).toBeUndefined();

    // The coordinator's ensureContract is module-private; we exercise it via
    // the public load() path using a real sidecar written by goal-storage.
    const { saveGoal } = require('../src/services/goal-storage');
    saveGoal('/tmp/test-contract-normalize', 'legacy-session', v011Goal);

    const coord = new GoalCoordinator('/tmp/test-contract-normalize', 'legacy-session');
    expect(coord.load()).toBe(true);

    expect(coord.goal!.contract).toBeDefined();
    expect(coord.goal!.contract!.originalObjective).toBe('Legacy objective');
    expect(coord.goal!.contract!.successCriteria.length).toBeGreaterThan(0);
    expect(coord.goal!.contract!.successCriteria[0].status).toBe('pending');
  });

  it('a goal that already has a contract is not rewritten on load', () => {
    const { saveGoal } = require('../src/services/goal-storage');
    const existingContract: GoalContract = {
      originalObjective: 'Pre-existing',
      objectiveRevision: 5,
      constraints: [{ id: 'c1', statement: 'Do not touch prod', source: 'user' }],
      successCriteria: [
        { id: 'custom-crit', statement: 'Custom criterion', source: 'user', status: 'pending', requiredEvidenceKinds: ['test'], evidenceRefs: [] },
      ],
    };
    const goal: SessionGoalV1 = {
      version: 1,
      goalId: 'has-contract',
      sessionId: 'has-contract-session',
      revision: 1,
      objective: 'Pre-existing',
      status: 'active',
      tokensUsed: 0,
      timeUsedMs: 0,
      createdAt: 1000,
      updatedAt: 2000,
      continuationCount: 0,
      noProgressCount: 0,
      contract: existingContract,
    };
    saveGoal('/tmp/test-contract-preserve', 'has-contract-session', goal);

    const coord = new GoalCoordinator('/tmp/test-contract-preserve', 'has-contract-session');
    expect(coord.load()).toBe(true);

    // Contract preserved verbatim - not normalized.
    expect(coord.goal!.contract!.objectiveRevision).toBe(5);
    expect(coord.goal!.contract!.constraints[0].statement).toBe('Do not touch prod');
    expect(coord.goal!.contract!.successCriteria[0].id).toBe('custom-crit');
  });
});

// ---------------------------------------------------------------------------
// Criterion model
// ---------------------------------------------------------------------------

describe('criterion model', () => {
  it('derived criteria never accept model natural language as evidence', () => {
    const coord = new GoalCoordinator('/tmp/test-criterion-model', 'criterion-model');
    coord.create('Build the feature');
    const primary = coord.goal!.contract!.successCriteria[0];
    // The requiredEvidenceKinds must not include a "model_text" or "self_report" kind.
    const allKinds = primary.requiredEvidenceKinds;
    expect(allKinds).not.toContain('model_text' as never);
    expect(allKinds).not.toContain('self_report' as never);
    // Accepted kinds are concrete: test/build/file/runtime/external/user.
    for (const k of allKinds) {
      expect(['test', 'build', 'lint', 'file', 'runtime', 'external', 'user']).toContain(k);
    }
  });

  it('criterion status starts pending', () => {
    const coord = new GoalCoordinator('/tmp/test-criterion-status', 'criterion-status');
    coord.create('Pending goal');
    for (const c of coord.goal!.contract!.successCriteria) {
      expect(c.status).toBe('pending');
    }
  });
});

// ---------------------------------------------------------------------------
// Contract survives state machine transitions
// ---------------------------------------------------------------------------

describe('contract survives transitions', () => {
  it('pause/resume preserves the contract', () => {
    const coord = new GoalCoordinator('/tmp/test-contract-transitions', 'contract-transitions');
    coord.create('Resilient goal');
    const contractBefore = coord.goal!.contract!;

    coord.pause();
    expect(coord.goal!.contract).toBe(contractBefore);
    expect(coord.goal!.status).toBe('paused');

    coord.resume();
    expect(coord.goal!.contract).toBe(contractBefore);
    expect(coord.goal!.status).toBe('active');
  });

  it('setBudget preserves the contract', () => {
    const coord = new GoalCoordinator('/tmp/test-contract-budget', 'contract-budget');
    coord.create('Budgeted goal');
    const contractBefore = coord.goal!.contract!;

    coord.setBudget(100000);
    expect(coord.goal!.contract).toBe(contractBefore);
    expect(coord.goal!.tokenBudget).toBe(100000);
  });
});