/**
 * Phase 1 (P0-2) - Goal Contract & Plan Snapshot tests.
 *
 * Validates the additive GoalContract layer: originalObjective preservation,
 * objectiveRevision bumping, criterion model, and v0.1.1 sidecar
 * normalization into a minimal pending contract.
 */

import {
  GoalCoordinator,
  goalRequiresBoundaryConfirmation,
} from '../src/runtime/goals/coordinator';
import { randomUUID } from 'crypto';
import {
  buildContinuationInstruction,
  buildGoalContextFragment,
} from '../src/runtime/goals/prompt';
import { normalizeGoalObjective } from '../src/runtime/goals/objective';
import { goalTransition } from '../src/runtime/goals/types';
import type {
  AgentTurnOutcome,
  GoalContract,
  GoalCreationContractInput,
  SessionGoalV1,
} from '../src/runtime/goals/types';

// ---------------------------------------------------------------------------
// Contract creation
// ---------------------------------------------------------------------------

describe('Goal contract creation', () => {
  let coord: GoalCoordinator;
  let contractProject: string;

  beforeEach(() => {
    contractProject = `/tmp/test-contract-create-${randomUUID()}`;
    coord = new GoalCoordinator(contractProject, 'contract-create');
  });

  it('create() builds a contract with originalObjective and a user-owned primary criterion', () => {
    const result = coord.create('Fix the login bug');
    expect(result.ok).toBe(true);

    const contract = coord.goal!.contract;
    expect(contract).toBeDefined();
    expect(contract!.originalObjective).toBe('Fix the login bug');
    expect(contract!.objectiveRevision).toBe(0);
    expect(contract!.successCriteria.length).toBeGreaterThan(0);

    const primary = contract!.successCriteria[0];
    expect(primary.source).toBe('user');
    expect(primary.status).toBe('pending');
    expect(primary.statement).toBe('Fix the login bug');
    expect(primary.requiredEvidenceKinds.length).toBeGreaterThan(0);
    expect(primary.evidenceRefs).toEqual([]);
  });

  it.each([
    ['push仓库，然后退出goal模式', 'push仓库'],
    ['测试一下目标模式，然后退出', '测试一下目标模式'],
    ['测试目标模式，测试1轮后，退出目标模式', '测试目标模式，测试1轮'],
    ['测试目标模式并自动退出目标模式', '测试目标模式'],
    ['Run focused tests, then exit goal mode.', 'Run focused tests'],
    ['Implement the fix and exit the active goal mode', 'Implement the fix'],
  ])('separates a trailing completion lifecycle action: %s', (input, executableObjective) => {
    expect(coord.create(input)).toEqual({ ok: true });
    expect(coord.goal?.objective).toBe(executableObjective);
    expect(coord.goal?.contract).toMatchObject({
      originalObjective: input,
      completionAction: 'exit_goal',
      successCriteria: [expect.objectContaining({ statement: executableObjective })],
    });

    if (coord.goal?.status === 'paused') {
      expect(coord.goal.boundaryConfirmation?.requiredAt).toEqual(expect.any(Number));
      expect(
        coord.resume({
          confirmBoundary: true,
          expectedGoalId: coord.goal.goalId,
          expectedRevision: coord.goal.revision,
        })
      ).toBe(true);
    }
    const prompt = buildGoalContextFragment(coord.goal);
    expect(prompt?.text).toContain(
      'Completion action: exit Goal mode automatically after the completion audit passes.'
    );
    expect(prompt?.text).toContain('Do not call abandon_goal to satisfy it');
  });

  it('does not treat exit wording used as a subject as a lifecycle action', () => {
    const objective = 'Fix the exit goal mode button and its tests';
    expect(normalizeGoalObjective(objective)).toEqual({
      originalObjective: objective,
      objective,
    });
  });

  it('does not infer an omitted Goal object without explicit Goal-mode context', () => {
    const objective = '完成任务，然后退出';
    expect(normalizeGoalObjective(objective)).toEqual({
      originalObjective: objective,
      objective,
    });
  });

  it('teaches Goal-mode self-tests to use same-turn runtime evidence instead of echo', () => {
    expect(coord.create('测试一下目标模式，然后退出')).toEqual({ ok: true });

    const prompt = buildGoalContextFragment(coord.goal);

    expect(prompt?.text).toContain('get_goal and update_goal_plan calls are runtime evidence');
    expect(prompt?.text).toContain('call get_goal again in the same turn');
    expect(prompt?.text).toContain('echo/printf output is not verification evidence');
  });

  it('rejects an exit-only phrase as an auditable Goal objective', () => {
    expect(coord.create('退出 goal 模式')).toEqual({
      ok: false,
      error: 'Goal exit is a lifecycle command, not an objective. Use /goal exit.',
    });
  });

  it.each([
    'Publish the Orion package',
    '发布 Orion 软件包',
    'Open an Orion pull request',
    '创建 Orion PR',
    'Merge the Orion pull request',
    '合并 Orion PR',
    'Verify the Orion package registry entry',
    '验证 Orion 软件包注册表条目',
  ])('requires external or user evidence for external completion objective: %s', objective => {
    const external = new GoalCoordinator(
      `/tmp/test-external-primary-${Date.now()}-${Math.random()}`,
      `external-primary-${Math.random()}`
    );

    expect(external.create(objective).ok).toBe(true);
    expect(external.goal?.contract?.successCriteria[0].requiredEvidenceKinds).toEqual([
      'external',
      'user',
    ]);
  });

  it('keeps local primary criteria on local runtime evidence kinds', () => {
    expect(coord.create('Run focused unit tests').ok).toBe(true);
    expect(coord.goal?.contract?.successCriteria[0].requiredEvidenceKinds).toEqual([
      'test',
      'build',
      'file',
      'runtime',
    ]);
  });

  it('pauses high-impact goals until the user explicitly confirms the boundary', () => {
    const project = `/tmp/test-boundary-confirmation-${Date.now()}-${Math.random()}`;
    const highImpact = new GoalCoordinator(project, 'boundary-confirmation');

    expect(goalRequiresBoundaryConfirmation('Publish v0.1.2 to npm')).toBe(true);
    expect(highImpact.create('Publish v0.1.2 to npm').ok).toBe(true);
    expect(highImpact.goal).toMatchObject({
      status: 'paused',
      revision: 0,
      stopReason: {
        kind: 'user',
        message: expect.stringContaining('Boundary confirmation required'),
      },
    });
    const atomicallyRestored = new GoalCoordinator(project, 'boundary-confirmation');
    expect(atomicallyRestored.load()).toBe(true);
    expect(atomicallyRestored.goal).toMatchObject({ status: 'paused', revision: 0 });
    expect(highImpact.buildContinuationRequest()).toBeNull();
    expect(highImpact.resume()).toBe(false);
    expect(
      highImpact.resume({
        confirmBoundary: true,
        expectedGoalId: highImpact.goal?.goalId,
        expectedRevision: highImpact.goal?.revision,
      })
    ).toBe(true);
    expect(highImpact.goal?.status).toBe('active');

    const local = new GoalCoordinator(project, 'local-goal');
    expect(local.create('Run focused unit tests').ok).toBe(true);
    expect(local.goal?.status).toBe('active');
  });

  it('applies the same boundary confirmation to edit and replace', () => {
    const project = `/tmp/test-boundary-edit-replace-${Date.now()}-${Math.random()}`;
    const edited = new GoalCoordinator(project, 'boundary-edit');
    expect(edited.create('Prepare the local release notes').ok).toBe(true);
    expect(edited.edit('Publish v0.1.2 to npm')).toBe(true);
    expect(edited.goal?.status).toBe('paused');
    expect(edited.buildContinuationRequest()).toBeNull();
    expect(edited.resume()).toBe(false);
    expect(
      edited.resume({
        confirmBoundary: true,
        expectedGoalId: edited.goal?.goalId,
        expectedRevision: edited.goal?.revision,
      })
    ).toBe(true);

    const replaced = new GoalCoordinator(project, 'boundary-replace');
    expect(replaced.create('Run local checks').ok).toBe(true);
    expect(replaced.replace('Deploy the release to production')).toBe(true);
    expect(replaced.goal?.status).toBe('paused');
    expect(replaced.buildContinuationRequest()).toBeNull();
    expect(replaced.resume()).toBe(false);
    expect(
      replaced.resume({
        confirmBoundary: true,
        expectedGoalId: replaced.goal?.goalId,
        expectedRevision: replaced.goal?.revision,
      })
    ).toBe(true);
    expect(replaced.goal?.status).toBe('active');
  });

  it.each<{ label: string; input: GoalCreationContractInput }>([
    {
      label: 'retained constraint',
      input: { constraints: ['Publish the package when verification passes'] },
    },
    {
      label: 'retained success criterion',
      input: {
        successCriteria: [
          {
            statement: 'Deploy the verified package',
            requiredEvidenceKinds: ['external'],
          },
        ],
      },
    },
  ])('re-confirms the boundary after edit because of a $label', ({ input }) => {
    const project = `/tmp/test-boundary-retained-${Date.now()}-${Math.random()}`;
    const retained = new GoalCoordinator(project, `boundary-retained-${Math.random()}`);
    expect(retained.create('Prepare a release', input)).toEqual({ ok: true });
    expect(retained.goal?.status).toBe('paused');
    expect(
      retained.resume({
        confirmBoundary: true,
        expectedGoalId: retained.goal?.goalId,
        expectedRevision: retained.goal?.revision,
      })
    ).toBe(true);

    expect(retained.edit('Verify the local binary thoroughly')).toBe(true);

    expect(retained.goal?.status).toBe('paused');
    expect(retained.goal?.boundaryConfirmation).toMatchObject({
      reason: 'external_destructive_or_high_impact',
      objectiveRevision: 1,
    });
    expect(retained.buildContinuationRequest()).toBeNull();
  });

  it('checks contract text while ignoring prohibitive boundary constraints', () => {
    const project = `/tmp/test-boundary-contract-${Date.now()}-${Math.random()}`;
    const constrained = new GoalCoordinator(project, 'boundary-criterion');
    expect(
      constrained.create('Finish the release workflow', {
        successCriteria: [
          { statement: 'Publish the package to npm', requiredEvidenceKinds: ['external'] },
        ],
      }).ok
    ).toBe(true);
    expect(constrained.goal?.status).toBe('paused');

    const guarded = new GoalCoordinator(project, 'boundary-negation');
    expect(
      guarded.create('Prepare release notes', {
        constraints: ['Do not publish or push anything'],
      }).ok
    ).toBe(true);
    expect(guarded.goal?.status).toBe('active');
  });

  it('still detects a positive high-impact clause after a negated clause', () => {
    const project = `/tmp/test-boundary-mixed-${Date.now()}-${Math.random()}`;
    const mixed = new GoalCoordinator(project, 'boundary-mixed');

    mixed.create('Do not publish staging; then deploy production');

    expect(mixed.goal?.status).toBe('paused');
    expect(mixed.goal?.boundaryConfirmation).toMatchObject({
      requiredAt: expect.any(Number),
      objectiveRevision: 0,
    });
  });

  it.each([
    ['Publish the npm package, but do not merge the PR.', true],
    ['发布 npm 包，但不要合并 PR。', true],
    ['Do not merge the PR; then publish the npm package.', true],
    ['不要合并 PR；然后发布 npm 包。', true],
    ['Do not publish or merge anything.', false],
    ['不要发布或合并任何内容。', false],
  ])('evaluates high-impact actions with local negation scope: %s', (objective, expected) => {
    expect(goalRequiresBoundaryConfirmation(objective)).toBe(expected);
  });

  it('rejects stale boundary confirmation after reload', () => {
    const project = `/tmp/test-boundary-reload-${Date.now()}-${Math.random()}`;
    const original = new GoalCoordinator(project, 'boundary-reload');
    expect(original.create('Publish the package').ok).toBe(true);
    const staleRevision = original.goal!.revision - 1;

    const restored = new GoalCoordinator(project, 'boundary-reload');
    expect(restored.load()).toBe(true);
    expect(
      restored.resume({
        confirmBoundary: true,
        expectedGoalId: restored.goal?.goalId,
        expectedRevision: staleRevision,
      })
    ).toBe(false);
    expect(restored.goal?.status).toBe('paused');
    expect(
      restored.resume({
        confirmBoundary: true,
        expectedGoalId: restored.goal?.goalId,
        expectedRevision: restored.goal?.revision,
      })
    ).toBe(true);
  });

  it('the primary criterion has a stable id across normalizations', () => {
    coord.create('Stable id goal');
    const id1 = coord.goal!.contract!.successCriteria[0].id;

    // Simulate a reload from sidecar (which triggers ensureContract).
    const reloaded = new GoalCoordinator(contractProject, 'contract-create');
    reloaded.load();
    const id2 = reloaded.goal!.contract!.successCriteria[0].id;

    expect(id1).toBe(id2);
  });

  it('preserves user-supplied constraints and success criteria as structured contract input', () => {
    const result = coord.create('Ship safely', {
      constraints: ['Do not modify public APIs'],
      successCriteria: [
        {
          statement: 'Focused tests pass',
          requiredEvidenceKinds: ['test', 'test'],
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(coord.goal!.contract!.constraints).toEqual([
      {
        id: 'constraint:user:1',
        statement: 'Do not modify public APIs',
        source: 'user',
      },
    ]);
    expect(coord.goal!.contract!.successCriteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'criterion:user:1',
          statement: 'Focused tests pass',
          source: 'user',
          status: 'pending',
          requiredEvidenceKinds: ['test'],
          evidenceRefs: [],
        }),
      ])
    );
  });

  it('plan snapshot starts at revision 0, phase initial', () => {
    coord.create('Goal with plan');
    const plan = coord.goal!.contract!.planSnapshot;
    expect(plan).toBeDefined();
    expect(plan!.revision).toBe(0);
    expect(plan!.phase).toBe('initial');
    expect(plan!.steps).toEqual([]);
  });

  it('applies a queued plan and derived criteria atomically at turn finalization', () => {
    coord.create('Goal with an auditable plan');
    const goal = coord.goal!;
    coord.finalizeTurn({
      turnId: 'turn-plan',
      sessionId: goal.sessionId,
      goalId: goal.goalId,
      goalRevision: goal.revision,
      startedAt: 10,
      endedAt: 20,
      finishReason: 'completed',
      usage: { promptTokens: 1, completionTokens: 1, subagentTokens: 0, totalTokens: 2 },
      usageComplete: true,
      madeProgress: true,
      pendingPlanUpdate: {
        phase: 'verification',
        steps: [{ description: 'Run tests', done: false }],
        nextAction: 'Run npm test',
        derivedCriteria: [{ statement: 'Tests pass', requiredEvidenceKinds: ['test'] }],
      },
    });
    expect(coord.goal!.contract!.planSnapshot).toMatchObject({
      revision: 1,
      phase: 'verification',
      nextAction: 'Run npm test',
    });
    expect(coord.goal!.contract!.planSnapshot!.steps[0]).toMatchObject({
      description: 'Run tests',
      done: false,
    });
    expect(coord.goal!.contract!.successCriteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ statement: 'Tests pass', source: 'derived' }),
      ])
    );
  });

  it('auto-pauses after three cosmetic plan rewrites and preserves the summaries on restart', () => {
    coord.create('Avoid a cosmetic planning loop');
    const finalize = (turnId: string, index: number) => {
      const goal = coord.goal!;
      coord.finalizeTurn({
        turnId,
        sessionId: goal.sessionId,
        goalId: goal.goalId,
        goalRevision: goal.revision,
        startedAt: 10,
        endedAt: 20,
        finishReason: 'completed',
        usage: { promptTokens: 1, completionTokens: 1, subagentTokens: 0, totalTokens: 2 },
        usageComplete: true,
        madeProgress: true,
        pendingPlanUpdate: {
          phase: `implementation-${index}`,
          steps: [{ description: `Rename the same pending step ${index}`, done: false }],
          nextAction: `Restate the next action ${index}`,
          derivedCriteria: [],
        },
      });
    };

    finalize('turn-plan-1', 1);
    finalize('turn-plan-2', 2);
    finalize('turn-plan-3', 3);
    expect(coord.goal!.contract!.planSnapshot!.revision).toBe(3);
    expect(coord.goal!.status).toBe('paused');
    expect(coord.goal!.noProgressCount).toBe(3);
    expect(coord.goal!.lastTurn!.madeProgress).toBe(false);
    expect(coord.goal!.stopReason?.message).toContain('no progress');
    expect(coord.goal!.recentNoProgressTurns).toEqual([
      expect.objectContaining({
        turnId: 'turn-plan-1',
        finishReason: 'completed',
        passedEvidence: 0,
        failedEvidence: 0,
        inconclusiveEvidence: 0,
        planUpdateProposed: true,
      }),
      expect.objectContaining({ turnId: 'turn-plan-2' }),
      expect.objectContaining({ turnId: 'turn-plan-3' }),
    ]);
    expect(coord.goal!.stopReason?.message).toContain('turn-plan-1');
    expect(coord.goal!.stopReason?.message).toContain('evidence=0p/0f/0i');

    const restarted = new GoalCoordinator(contractProject, 'contract-create');
    expect(restarted.load()).toBe(true);
    expect(restarted.goal?.status).toBe('paused');
    expect(restarted.goal?.recentNoProgressTurns).toEqual(coord.goal!.recentNoProgressTurns);
    expect(restarted.goal?.stopReason).toEqual(coord.goal!.stopReason);
  });

  it('pauses after two blocked autonomous continuations instead of burning the full streak', () => {
    coord.create('Resolve an external dependency or stop for review');
    const finalizeBlocked = (turnId: string) => {
      const goal = coord.goal!;
      coord.finalizeTurn({
        turnId,
        inputKind: 'goal_continuation',
        sessionId: goal.sessionId,
        goalId: goal.goalId,
        goalRevision: goal.revision,
        goalGeneration: coord.generation,
        startedAt: 10,
        endedAt: 20,
        finishReason: 'blocked',
        usage: { promptTokens: 1, completionTokens: 1, subagentTokens: 0, totalTokens: 2 },
        usageComplete: true,
        madeProgress: false,
        workspaceChanged: false,
        evidenceRecords: [],
      });
    };

    finalizeBlocked('blocked-auto-1');
    expect(coord.goal?.status).toBe('active');
    finalizeBlocked('blocked-auto-2');

    expect(coord.goal).toMatchObject({
      status: 'paused',
      automaticContinuationStreak: 2,
      noProgressCount: 2,
      stopReason: {
        kind: 'user',
        message: expect.stringContaining('2 blocked autonomous continuations'),
      },
    });
  });

  it('resets no-progress only for stable step completion or an objective-traceable criterion', () => {
    const project = `/tmp/test-material-plan-${Date.now()}-${Math.random()}`;
    const material = new GoalCoordinator(project, 'material-plan');
    material.create('Ship package registry support');
    const finalize = (
      turnId: string,
      pendingPlanUpdate: NonNullable<AgentTurnOutcome['pendingPlanUpdate']>
    ) => {
      const goal = material.goal!;
      material.finalizeTurn({
        turnId,
        sessionId: goal.sessionId,
        goalId: goal.goalId,
        goalRevision: goal.revision,
        startedAt: 10,
        endedAt: 20,
        finishReason: 'completed',
        usage: { promptTokens: 1, completionTokens: 1, subagentTokens: 0, totalTokens: 2 },
        usageComplete: true,
        madeProgress: true,
        workspaceChanged: false,
        evidenceRecords: [],
        pendingPlanUpdate,
      });
    };

    finalize('turn-material-1', {
      phase: 'implementation',
      steps: [{ description: 'Implement registry lookup', done: false }],
      nextAction: 'Implement registry lookup',
      derivedCriteria: [],
    });
    expect(material.goal?.noProgressCount).toBe(1);

    finalize('turn-material-2', {
      phase: 'implementation',
      steps: [{ description: 'Implement registry lookup', done: true }],
      nextAction: 'Verify registry lookup',
      derivedCriteria: [],
    });
    expect(material.goal?.noProgressCount).toBe(0);
    expect(material.goal?.lastTurn?.madeProgress).toBe(true);

    finalize('turn-material-3', {
      phase: 'verification-renamed',
      steps: [{ description: 'Implement registry lookup', done: true }],
      nextAction: 'Rename the verification action',
      derivedCriteria: [],
    });
    expect(material.goal?.noProgressCount).toBe(1);

    finalize('turn-material-4', {
      phase: 'verification',
      steps: [{ description: 'Implement registry lookup', done: true }],
      nextAction: 'Run package registry smoke checks',
      derivedCriteria: [
        { statement: 'Package registry lookup succeeds', requiredEvidenceKinds: ['test'] },
      ],
    });
    expect(material.goal?.noProgressCount).toBe(0);
    expect(material.goal?.lastTurn?.madeProgress).toBe(true);
  });

  it('resets no-progress for new passing evidence or a verified workspace delta', () => {
    const project = `/tmp/test-material-runtime-${Date.now()}-${Math.random()}`;
    const material = new GoalCoordinator(project, 'material-runtime');
    material.create('Implement calculator parser support');
    const finalize = (
      turnId: string,
      options: { workspaceChanged: boolean; includePassingEvidence?: boolean }
    ) => {
      const goal = material.goal!;
      material.finalizeTurn({
        turnId,
        sessionId: goal.sessionId,
        goalId: goal.goalId,
        goalRevision: goal.revision,
        startedAt: 10,
        endedAt: 20,
        finishReason: 'completed',
        usage: { promptTokens: 1, completionTokens: 1, subagentTokens: 0, totalTokens: 2 },
        usageComplete: true,
        madeProgress: true,
        workspaceChanged: options.workspaceChanged,
        evidenceRecords: options.includePassingEvidence
          ? [
              {
                id: `evidence-${turnId}`,
                goalId: goal.goalId,
                goalRevision: goal.revision,
                objectiveRevision: goal.contract?.objectiveRevision ?? 0,
                turnId,
                kind: 'test',
                subject: 'calculator parser focused test',
                result: 'passed',
                sourceRef: 'tool:test:registry',
                capturedAt: 20,
                redacted: false,
              },
            ]
          : [],
      });
    };

    finalize('turn-runtime-1', { workspaceChanged: false });
    expect(material.goal?.noProgressCount).toBe(1);

    finalize('turn-runtime-2', { workspaceChanged: false, includePassingEvidence: true });
    expect(material.goal?.noProgressCount).toBe(0);
    expect(material.goal?.lastTurn?.madeProgress).toBe(true);

    finalize('turn-runtime-3', { workspaceChanged: false });
    finalize('turn-runtime-4', { workspaceChanged: false, includePassingEvidence: true });
    expect(material.goal?.noProgressCount).toBe(2);
    expect(material.goal?.lastTurn?.madeProgress).toBe(false);

    finalize('turn-runtime-5', { workspaceChanged: true });
    expect(material.goal?.noProgressCount).toBe(0);
    expect(material.goal?.lastTurn?.madeProgress).toBe(true);
  });

  it('does not treat unrelated passed evidence with changing call ids as progress', () => {
    const project = `/tmp/test-unrelated-evidence-${Date.now()}-${Math.random()}`;
    const material = new GoalCoordinator(project, 'unrelated-evidence');
    material.create('Implement calculator parser');

    for (let index = 1; index <= 3; index += 1) {
      const goal = material.goal!;
      const turnId = `turn-unrelated-${index}`;
      material.finalizeTurn({
        turnId,
        sessionId: goal.sessionId,
        goalId: goal.goalId,
        goalRevision: goal.revision,
        startedAt: index * 10,
        endedAt: index * 10 + 5,
        finishReason: 'completed',
        usage: { promptTokens: 1, completionTokens: 1, subagentTokens: 0, totalTokens: 2 },
        usageComplete: true,
        madeProgress: true,
        workspaceChanged: false,
        evidenceRecords: [
          {
            id: `evidence-unrelated-${index}`,
            goalId: goal.goalId,
            goalRevision: goal.revision,
            objectiveRevision: goal.contract?.objectiveRevision ?? 0,
            turnId,
            kind: 'test',
            subject: 'unrelated billing smoke test',
            result: 'passed',
            sourceRef: `tool:call-${index}:exec_command`,
            capturedAt: index * 10 + 5,
            workspaceFingerprint: 'workspace:v1',
            redacted: true,
          },
        ],
      });
    }

    expect(material.goal).toMatchObject({
      status: 'paused',
      noProgressCount: 3,
      progressEvidenceKeys: [],
      lastTurn: { madeProgress: false },
    });
  });

  it('deduplicates related passed evidence across call ids and restart while allowing real state advances', () => {
    const project = `/tmp/test-related-evidence-${Date.now()}-${Math.random()}`;
    const sessionId = 'related-evidence';
    let material = new GoalCoordinator(project, sessionId);
    material.create('Implement calculator parser');
    const finalizeEvidence = (turnId: string, result: 'passed' | 'failed', callId: string) => {
      const goal = material.goal!;
      material.finalizeTurn({
        turnId,
        sessionId: goal.sessionId,
        goalId: goal.goalId,
        goalRevision: goal.revision,
        startedAt: 10,
        endedAt: 20,
        finishReason: 'completed',
        usage: { promptTokens: 1, completionTokens: 1, subagentTokens: 0, totalTokens: 2 },
        usageComplete: true,
        madeProgress: result === 'passed',
        workspaceChanged: false,
        evidenceRecords: [
          {
            id: `evidence-${turnId}`,
            goalId: goal.goalId,
            goalRevision: goal.revision,
            objectiveRevision: goal.contract?.objectiveRevision ?? 0,
            turnId,
            kind: 'test',
            subject: 'calculator parser focused test',
            result,
            sourceRef: `tool:${callId}:exec_command`,
            capturedAt: 20,
            workspaceFingerprint: 'workspace:v1',
            redacted: true,
          },
        ],
      });
    };

    finalizeEvidence('turn-related-failed', 'failed', 'call-1');
    expect(material.goal?.noProgressCount).toBe(1);
    finalizeEvidence('turn-related-fixed', 'passed', 'call-2');
    expect(material.goal?.noProgressCount).toBe(0);
    expect(material.goal?.progressEvidenceKeys).toHaveLength(1);

    material = new GoalCoordinator(project, sessionId);
    expect(material.load()).toBe(true);
    finalizeEvidence('turn-related-repeat', 'passed', 'call-3');
    expect(material.goal?.noProgressCount).toBe(1);
    expect(material.goal?.lastTurn?.madeProgress).toBe(false);

    const goal = material.goal!;
    material.finalizeTurn({
      turnId: 'turn-add-criterion',
      sessionId: goal.sessionId,
      goalId: goal.goalId,
      goalRevision: goal.revision,
      startedAt: 10,
      endedAt: 20,
      finishReason: 'completed',
      usage: { promptTokens: 1, completionTokens: 1, subagentTokens: 0, totalTokens: 2 },
      usageComplete: true,
      madeProgress: true,
      workspaceChanged: false,
      evidenceRecords: [],
      pendingPlanUpdate: {
        phase: 'verification',
        steps: [],
        nextAction: 'Verify unary expressions',
        derivedCriteria: [
          {
            statement: 'Calculator parser accepts unary expressions',
            requiredEvidenceKinds: ['test'],
          },
        ],
      },
    });
    expect(material.goal?.noProgressCount).toBe(0);

    finalizeEvidence('turn-related-new-criterion', 'passed', 'call-4');
    expect(material.goal?.noProgressCount).toBe(0);
    expect(material.goal?.lastTurn?.madeProgress).toBe(true);
    expect(material.goal?.progressEvidenceKeys).toHaveLength(2);
  });
});

describe('Completed Goal terminal mutation boundary', () => {
  it('rejects budget and constraint changes while preserving recoverable-state behavior', () => {
    const completed = new GoalCoordinator(
      `/tmp/test-completed-mutation-${Date.now()}-${Math.random()}`,
      'completed-mutation'
    );
    expect(completed.create('Keep completion terminal')).toEqual({ ok: true });
    completed.goal!.status = 'complete';
    const completedRevision = completed.goal!.revision;
    const completedConstraints = completed.goal!.contract!.constraints;

    expect(completed.setBudget(1_000)).toBe(false);
    expect(completed.addConstraint('must not be persisted')).toBe(false);
    expect(completed.goal).toMatchObject({
      status: 'complete',
      revision: completedRevision,
    });
    expect(completed.goal?.tokenBudget).toBeUndefined();
    expect(completed.goal!.contract!.constraints).toEqual(completedConstraints);

    for (const status of ['paused', 'blocked', 'budget_limited'] as const) {
      const recoverable = new GoalCoordinator(
        `/tmp/test-recoverable-mutation-${status}-${Date.now()}-${Math.random()}`,
        `recoverable-mutation-${status}`
      );
      expect(recoverable.create(`Keep ${status} editable`)).toEqual({ ok: true });
      recoverable.goal!.status = status;
      recoverable.goal!.stopReason = {
        kind:
          status === 'blocked' ? 'blocked' : status === 'budget_limited' ? 'budget_limit' : 'user',
        message: `Recoverable ${status}`,
        at: Date.now(),
      };
      if (status === 'blocked') {
        recoverable.goal!.blocker = {
          category: 'external_state',
          fingerprint: 'test:recoverable-blocker',
          firstSeenAt: Date.now(),
          lastSeenAt: Date.now(),
          consecutiveTurns: 3,
          summary: 'Recoverable external blocker',
          retryable: false,
        };
      }
      expect(recoverable.setBudget(2_000)).toBe(true);
      expect(recoverable.addConstraint(`constraint for ${status}`)).toBe(true);
    }
  });

  it('does not revive a cached Goal after another coordinator clears it', () => {
    const project = `/tmp/test-deletion-authority-${Date.now()}-${Math.random()}`;
    const sessionId = 'deletion-authority';
    const authority = new GoalCoordinator(project, sessionId);
    expect(authority.create('Observe authoritative removal')).toEqual({ ok: true });
    const stale = new GoalCoordinator(project, sessionId);
    expect(stale.load()).toBe(true);
    const staleGeneration = stale.generation;
    expect(authority.clear()).toBe(true);

    expect(() => stale.pause()).toThrow('revision_stale');
    expect(stale.goal).toBeNull();
    expect(stale.generation).toBeGreaterThan(staleGeneration);
    expect(stale.create('Fresh Goal after authoritative deletion')).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// edit() preserves originalObjective
// ---------------------------------------------------------------------------

describe('edit() preserves originalObjective', () => {
  let coord: GoalCoordinator;

  beforeEach(() => {
    coord = new GoalCoordinator(`/tmp/test-contract-edit-${randomUUID()}`, 'contract-edit');
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

  it('persists a completion action even when an edit keeps the executable objective unchanged', () => {
    const revision = coord.goal!.contract!.objectiveRevision;

    expect(coord.edit('Original objective wording, then exit goal mode')).toBe(true);

    expect(coord.goal).toMatchObject({
      objective: 'Original objective wording',
      contract: {
        completionAction: 'exit_goal',
        objectiveRevision: revision + 1,
      },
    });
  });

  it('records edit time and reason while resetting the primary criterion', () => {
    const changedAtFloor = Date.now();
    coord.goal!.contract!.successCriteria[0].status = 'passed';
    coord.goal!.contract!.successCriteria[0].evidenceRefs = ['evidence:old'];

    coord.edit('Auditable refinement', 'Scope clarified by the user.');

    expect(coord.goal!.contract!.objectiveHistory).toEqual([
      expect.objectContaining({
        revision: 1,
        previousObjective: 'Original objective wording',
        objective: 'Auditable refinement',
        reason: 'Scope clarified by the user.',
        source: 'user',
        changedAt: expect.any(Number),
      }),
    ]);
    expect(coord.goal!.contract!.objectiveHistory![0].changedAt).toBeGreaterThanOrEqual(
      changedAtFloor
    );
    expect(coord.goal!.contract!.successCriteria[0]).toMatchObject({
      id: 'criterion:primary',
      statement: 'Auditable refinement',
      source: 'user',
      status: 'pending',
      evidenceRefs: [],
    });
  });
});

// ---------------------------------------------------------------------------
// replace() creates a fresh contract
// ---------------------------------------------------------------------------

describe('replace() creates a fresh contract', () => {
  let coord: GoalCoordinator;

  beforeEach(() => {
    coord = new GoalCoordinator(`/tmp/test-contract-replace-${randomUUID()}`, 'contract-replace');
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

  it('migrates a paused legacy exit clause out of the auditable criterion on load', () => {
    const { saveGoal } = require('../src/services/goal-storage');
    const project = `/tmp/test-contract-exit-migration-${randomUUID()}`;
    const sessionId = 'legacy-exit-clause';
    const originalObjective = '测试一下目标模式，然后退出';
    const goal: SessionGoalV1 = {
      version: 1,
      goalId: 'legacy-exit-goal',
      sessionId,
      revision: 4,
      objective: originalObjective,
      status: 'paused',
      tokensUsed: 500,
      timeUsedMs: 1000,
      createdAt: 1000,
      updatedAt: 2000,
      continuationCount: 5,
      automaticContinuationStreak: 5,
      noProgressCount: 3,
      contract: {
        originalObjective,
        objectiveRevision: 0,
        constraints: [],
        successCriteria: [
          {
            id: 'criterion:primary',
            statement: originalObjective,
            source: 'user',
            status: 'failed',
            requiredEvidenceKinds: ['test'],
            evidenceRefs: [],
          },
        ],
        planSnapshot: {
          revision: 2,
          phase: 'verification',
          steps: [],
          nextAction: '退出目标模式无法验证',
          updatedAt: 2000,
        },
      },
      completionAudit: {
        requestedAt: 1900,
        auditedAt: 2000,
        passed: false,
        verificationSummary: 'exit clause could not be proven',
        remainingRequirements: [originalObjective],
        evidenceRefs: [],
      },
    };
    expect(saveGoal(project, sessionId, goal).ok).toBe(true);

    const restored = new GoalCoordinator(project, sessionId);
    expect(restored.load()).toBe(true);
    expect(restored.goal).toMatchObject({
      objective: '测试一下目标模式',
      contract: {
        originalObjective,
        completionAction: 'exit_goal',
        successCriteria: [
          expect.objectContaining({ statement: '测试一下目标模式', status: 'pending' }),
        ],
        planSnapshot: {
          phase: 'execution',
          nextAction: 'Verify and complete: 测试一下目标模式',
        },
      },
    });
    expect(restored.goal?.completionAudit).toBeUndefined();
  });

  it('a goal that already has a contract is not rewritten on load', () => {
    const { saveGoal } = require('../src/services/goal-storage');
    const existingContract: GoalContract = {
      originalObjective: 'Pre-existing',
      objectiveRevision: 5,
      constraints: [{ id: 'c1', statement: 'Do not touch prod', source: 'user' }],
      successCriteria: [
        {
          id: 'custom-crit',
          statement: 'Custom criterion',
          source: 'user',
          status: 'pending',
          requiredEvidenceKinds: ['test'],
          evidenceRefs: [],
        },
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
  it('criteria never accept model natural language as evidence', () => {
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

  it('tells the model that local evidence kinds are accepted alternatives', () => {
    const coord = new GoalCoordinator('/tmp/test-evidence-prompt', 'evidence-prompt');
    expect(coord.create('Run focused unit tests').ok).toBe(true);

    const fragment = buildGoalContextFragment(coord.goal);

    expect(fragment?.text).toContain('accepted evidence (any of)=test,build,file,runtime');
    expect(fragment?.text).not.toContain(' evidence=test,build,file,runtime');
    expect(fragment?.text).toContain('use only exact recentEvidence IDs');
    expect(fragment?.text).toContain('update_goal success records a request only');
    expect(fragment?.text).toContain('without newly captured runtime evidence');
  });

  it('criterion status starts pending', () => {
    const coord = new GoalCoordinator('/tmp/test-criterion-status', 'criterion-status');
    coord.create('Pending goal');
    for (const c of coord.goal!.contract!.successCriteria) {
      expect(c.status).toBe('pending');
    }
  });

  it('records trusted user evidence only for an explicitly confirmable criterion', () => {
    const project = `/tmp/test-user-evidence-${Date.now()}-${Math.random()}`;
    const coord = new GoalCoordinator(project, 'user-evidence');
    expect(
      coord.create('Ship after manual acceptance', {
        successCriteria: [
          {
            statement: 'The user accepts the final terminal experience',
            requiredEvidenceKinds: ['user'],
          },
        ],
      }).ok
    ).toBe(true);
    const criterion = coord.goal!.contract!.successCriteria.find(item =>
      item.requiredEvidenceKinds.includes('user')
    )!;

    expect(coord.confirmCriterion('criterion:missing')).toBe(false);
    expect(coord.confirmCriterion(criterion.id)).toBe(true);
    expect(
      coord.goal!.contract!.successCriteria.find(item => item.id === criterion.id)?.status
    ).toBe('passed');
    expect(coord.goal!.evidenceLedger).toEqual([
      expect.objectContaining({
        kind: 'user',
        result: 'passed',
        objectiveRevision: 0,
        sourceRef: 'user:/target-confirm',
      }),
    ]);

    const reloaded = new GoalCoordinator(project, 'user-evidence');
    expect(reloaded.load()).toBe(true);
    expect(
      reloaded.goal!.contract!.successCriteria.find(item => item.id === criterion.id)?.evidenceRefs
    ).toEqual([reloaded.goal!.evidenceLedger![0].id]);
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

describe('compact-safe Goal context', () => {
  it('preserves contract, criteria, plan and next action across reload', () => {
    const project = `/tmp/test-goal-prompt-${Date.now()}-${Math.random()}`;
    const coord = new GoalCoordinator(project, 'goal-prompt');
    coord.create('Ship an auditable Goal runtime');
    coord.addConstraint('Do not publish automatically');
    const goal = coord.goal!;
    coord.finalizeTurn({
      turnId: 'turn-plan-context',
      sessionId: goal.sessionId,
      goalId: goal.goalId,
      goalRevision: goal.revision,
      startedAt: 10,
      endedAt: 20,
      finishReason: 'completed',
      usage: { promptTokens: 1, completionTokens: 1, subagentTokens: 0, totalTokens: 2 },
      usageComplete: true,
      madeProgress: true,
      pendingPlanUpdate: {
        phase: 'verification',
        steps: [{ description: 'Run Goal E2E', done: false }],
        nextAction: 'Run the focused Goal suites',
        derivedCriteria: [{ statement: 'Goal E2E passes', requiredEvidenceKinds: ['test'] }],
      },
    });

    const before = buildGoalContextFragment(coord.goal)!.text;
    const reloaded = new GoalCoordinator(project, 'goal-prompt');
    expect(reloaded.load()).toBe(true);
    const after = buildGoalContextFragment(reloaded.goal)!.text;

    expect(after).toBe(before);
    expect(after).toContain('original: Ship an auditable Goal runtime');
    expect(after).toContain('[user] Do not publish automatically');
    expect(after).toContain('criterion:derived:1:1');
    expect(after).toContain('Plan: revision 1; phase verification');
    expect(after).toContain('Next action: Run the focused Goal suites');
    expect(after).toMatch(/Blocked gate: same eligible blocker 0\/3; no-progress \d+\/3/u);
    expect(after).toContain('Both must reach the threshold');
    expect(after).toContain('>= 3 consecutive Goal turns');
    expect(buildContinuationInstruction()).toContain('same eligible non-retryable blocker');
    expect(buildContinuationInstruction()).toContain('no progress persisted for >= 3');
  });
});

describe('user steering constraints', () => {
  it('records steering without rewriting or revising the objective wording', () => {
    const coord = new GoalCoordinator('/tmp/test-contract-steering', 'contract-steering');
    coord.create('Original objective');
    coord.addConstraint('Do not modify the public API');
    expect(coord.goal?.objective).toBe('Original objective');
    expect(coord.goal?.contract?.originalObjective).toBe('Original objective');
    expect(coord.goal?.contract?.objectiveRevision).toBe(0);
    expect(coord.goal?.contract?.constraints).toContainEqual(
      expect.objectContaining({
        statement: 'Do not modify the public API',
        source: 'user',
      })
    );
  });
});
