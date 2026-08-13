/**
 * v0.2.24 — Goal model tools unit tests.
 * v0.1.2 — Runtime/session scoped Goal tool binding.
 */

import { randomUUID } from 'crypto';

import { GoalCoordinator } from '../src/runtime/goals/coordinator';
import {
  abandonGoalTool,
  authorizeGoalAbandonment,
  authorizeGoalCreation,
  getGoalTool,
  createGoalTool,
  GOAL_TOOLS,
  updateGoalPlanTool,
  updateGoalTool,
  runWithGoalToolContext,
  type GoalToolExecutionContext,
} from '../src/runtime/goals/tools';
import type { OrionCodeTool, ToolResult } from '../src/framework/tool';
import * as sessionStorage from '../src/services/session-storage';

describe('Goal model tools', () => {
  let coordinator: GoalCoordinator;
  let lastContext: GoalToolExecutionContext;

  beforeEach(() => {
    coordinator = new GoalCoordinator(`/tmp/goal-tools-${randomUUID()}`, 'test-session');
  });

  async function execute(
    tool: OrionCodeTool,
    args: Record<string, unknown>,
    request: { text?: string; inputKind?: 'user' | 'revision' | 'goal_continuation' } = {}
  ): Promise<ToolResult> {
    lastContext = {
      coordinator,
      request: {
        inputKind: request.inputKind ?? 'user',
        text: request.text ?? 'test',
        sessionId: 'test-session',
        persistAsUserMessage: true,
        echoToTranscript: true,
        generation: coordinator.generation,
      },
      turnId: 'turn-1',
      evidenceRecords: [],
    };
    return runWithGoalToolContext(lastContext, () =>
      tool.execute(args, { cwd: '/test', config: { name: 'test', mode: 'test' } })
    );
  }

  describe('get_goal', () => {
    it('returns null when no goal exists', async () => {
      const result = await execute(getGoalTool, {});
      expect(result.success).toBe(true);
      expect(result.output).toBe('No active goal.');
    });

    it('returns goal snapshot when goal exists', async () => {
      coordinator.create('test objective');
      const result = await execute(getGoalTool, {});
      expect(result.success).toBe(true);
      expect(result.output).toContain('test objective');
    });

    it('has tool definition with correct name', () => {
      expect(getGoalTool.name).toBe('get_goal');
    });

    it('returns current-turn evidence ids for completion mapping', async () => {
      coordinator.create('test objective');
      lastContext = {
        coordinator,
        request: {
          inputKind: 'user',
          text: 'test',
          sessionId: 'test-session',
          persistAsUserMessage: true,
          echoToTranscript: true,
          generation: coordinator.generation,
        },
        turnId: 'turn-1',
        evidenceRecords: [
          {
            id: 'current-evidence',
            goalId: coordinator.goal!.goalId,
            goalRevision: coordinator.goal!.revision,
            objectiveRevision: coordinator.goal!.contract?.objectiveRevision ?? 0,
            turnId: 'turn-1',
            kind: 'test',
            subject: 'goal test',
            result: 'passed',
            sourceRef: 'tool:turn-1:exec_command',
            capturedAt: Date.now(),
            redacted: true,
          },
        ],
      };
      const result = await runWithGoalToolContext(lastContext, () =>
        getGoalTool.execute({}, { cwd: '/test', config: { name: 'test', mode: 'test' } })
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('current-evidence');
      expect(result.output).toContain('criterion:primary');
      expect(result.output).not.toContain('sourceRef');
    });

    it('is read-only', () => {
      expect(getGoalTool.isReadOnly!({})).toBe(true);
    });
  });

  describe('create_goal', () => {
    it('creates a goal from explicit objective', async () => {
      const result = await execute(
        createGoalTool,
        { objective: 'Run CI' },
        { text: 'Create a persistent goal to run CI' }
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('Run CI');
    });

    it('creates user-owned constraints and success criteria from structured input', async () => {
      const result = await execute(
        createGoalTool,
        {
          objective: 'Ship safely',
          constraints: ['Do not change public APIs'],
          success_criteria: [
            { statement: 'Focused tests pass', required_evidence_kinds: ['test'] },
          ],
        },
        { text: '建立一个长期目标，安全发布' }
      );
      expect(result.success).toBe(true);
      expect(coordinator.goal!.contract!.constraints[0]).toMatchObject({
        statement: 'Do not change public APIs',
        source: 'user',
      });
      expect(coordinator.goal!.contract!.successCriteria).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            statement: 'Focused tests pass',
            source: 'user',
            requiredEvidenceKinds: ['test'],
          }),
        ])
      );
    });

    it('rejects empty objective', async () => {
      // Coordinator rejects empty objectives
      const result = await execute(
        createGoalTool,
        { objective: '' },
        { text: 'Create a persistent goal for this task' }
      );
      expect(result.success).toBe(false);
    });

    it('rejects duplicate goal if active', async () => {
      coordinator.create('first goal');
      const result = await execute(
        createGoalTool,
        { objective: 'second goal' },
        { text: 'Create a persistent goal for the second task' }
      );
      expect(result.success).toBe(false);
    });

    it.each([
      ['ordinary task request', 'Fix the current issues', 'user'],
      ['ordinary Chinese task request', '修复当前分支的问题', 'user'],
      ['#150 smoke input', 'test', 'user'],
      ['#150 project overview input', '了解下整个项目', 'user'],
      ['#150 error question', 'update_goal 失败是什么原因', 'user'],
      ['#150 single-choice reply', 'A', 'user'],
      ['model continuation', 'Create a persistent goal for this task', 'goal_continuation'],
    ] as const)('denies creation for %s', async (_label, text, inputKind) => {
      const result = await execute(
        createGoalTool,
        { objective: 'Unauthorized Goal' },
        { text, inputKind }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Goal creation denied');
      expect(coordinator.goal).toBeNull();
    });

    it('requires explicit latest-user Goal intent at both authorization boundaries', () => {
      const base = {
        sessionId: 'test-session',
        persistAsUserMessage: true,
        echoToTranscript: true,
        generation: 1,
      } as const;
      expect(
        authorizeGoalCreation({
          ...base,
          inputKind: 'user',
          text: 'Can you create a persistent goal to finish this work?',
        }).authorized
      ).toBe(true);
      expect(
        authorizeGoalCreation({
          ...base,
          inputKind: 'user',
          text: 'Should we create a Goal?',
        }).authorized
      ).toBe(false);
      expect(createGoalTool.checkPermissions!({}, {} as never).behavior).toBe('deny');
    });

    it('has tool definition', () => {
      expect(createGoalTool.name).toBe('create_goal');
    });
  });

  describe('update_goal', () => {
    it('rejects completion without runtime evidence', async () => {
      coordinator.create('test');
      const result = await execute(updateGoalTool, { status: 'complete' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('evidence mapping');
      expect(result.output).toContain('evidence mapping');
      expect(lastContext.pendingTerminalRequest).toBeUndefined();
    });

    it('requests complete status with a validated evidence mapping', async () => {
      coordinator.create('test');
      const criterion = coordinator.goal!.contract!.successCriteria[0];
      lastContext = {
        coordinator,
        request: {
          inputKind: 'user',
          text: 'test',
          sessionId: 'test-session',
          persistAsUserMessage: true,
          echoToTranscript: true,
          generation: coordinator.generation,
        },
        turnId: 'turn-1',
        evidenceRecords: [
          {
            id: 'evidence-1',
            goalId: coordinator.goal!.goalId,
            goalRevision: coordinator.goal!.revision,
            objectiveRevision: coordinator.goal!.contract?.objectiveRevision ?? 0,
            turnId: 'turn-1',
            kind: 'test',
            subject: 'goal test',
            result: 'passed',
            sourceRef: 'tool:turn-1:exec_command',
            capturedAt: Date.now(),
            redacted: true,
          },
        ],
      };
      const result = await runWithGoalToolContext(lastContext, () =>
        updateGoalTool.execute(
          {
            status: 'complete',
            criterion_evidence: [{ criterion_id: criterion.id, evidence_ids: ['evidence-1'] }],
          },
          { cwd: '/test', config: { name: 'test', mode: 'test' } }
        )
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('complete');
      expect(lastContext.pendingTerminalRequest).toMatchObject({
        requestedStatus: 'complete',
        goalId: coordinator.goal?.goalId,
        goalRevision: coordinator.goal?.revision,
        turnId: 'turn-1',
        criterionEvidence: [{ criterionId: criterion.id, evidenceIds: ['evidence-1'] }],
      });
      expect(coordinator.goal?.status).toBe('active');
    });

    it('does not auto-bind current evidence when criterion_evidence is omitted', async () => {
      coordinator.create('test');
      lastContext = {
        coordinator,
        request: {
          inputKind: 'user',
          text: 'test',
          sessionId: 'test-session',
          persistAsUserMessage: true,
          echoToTranscript: true,
          generation: coordinator.generation,
        },
        turnId: 'turn-1',
        evidenceRecords: [
          {
            id: 'evidence-current',
            goalId: coordinator.goal!.goalId,
            goalRevision: coordinator.goal!.revision,
            objectiveRevision: coordinator.goal!.contract?.objectiveRevision ?? 0,
            turnId: 'turn-1',
            kind: 'test',
            subject: 'goal test',
            result: 'passed',
            sourceRef: 'tool:turn-1:exec_command',
            capturedAt: Date.now(),
            redacted: true,
          },
        ],
      };
      const result = await runWithGoalToolContext(lastContext, () =>
        updateGoalTool.execute(
          { status: 'complete' },
          { cwd: '/test', config: { name: 'test', mode: 'test' } }
        )
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('evidence mapping');
      expect(lastContext.pendingTerminalRequest).toBeUndefined();
    });

    it('rejects a model-invented evidence id', async () => {
      coordinator.create('test');
      const criterion = coordinator.goal!.contract!.successCriteria[0];
      const result = await execute(updateGoalTool, {
        status: 'complete',
        criterion_evidence: [{ criterion_id: criterion.id, evidence_ids: ['invented-evidence'] }],
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('unavailable');
      expect(lastContext.pendingTerminalRequest).toBeUndefined();
    });

    it('stops completion retries until the runtime captures new evidence', async () => {
      coordinator.create('test');
      const criterion = coordinator.goal!.contract!.successCriteria[0];
      const first = await execute(updateGoalTool, {
        status: 'complete',
        criterion_evidence: [{ criterion_id: criterion.id, evidence_ids: ['invented-1'] }],
      });
      expect(first.success).toBe(false);

      const retry = await runWithGoalToolContext(lastContext, () =>
        updateGoalTool.execute(
          {
            status: 'complete',
            criterion_evidence: [{ criterion_id: criterion.id, evidence_ids: ['invented-2'] }],
          },
          { cwd: '/test', config: { name: 'test', mode: 'test' } }
        )
      );
      expect(retry.success).toBe(false);
      expect(retry.error).toContain('no new runtime evidence');
      expect(retry.error).toContain('stop retrying');

      lastContext.evidenceRecords.push({
        id: 'evidence-after-rejection',
        goalId: coordinator.goal!.goalId,
        goalRevision: coordinator.goal!.revision,
        objectiveRevision: coordinator.goal!.contract?.objectiveRevision ?? 0,
        turnId: 'turn-1',
        kind: 'test',
        subject: 'goal test after rejection',
        result: 'passed',
        sourceRef: 'tool:turn-1:exec_command',
        capturedAt: Date.now(),
        redacted: true,
      });
      const afterEvidence = await runWithGoalToolContext(lastContext, () =>
        updateGoalTool.execute(
          {
            status: 'complete',
            criterion_evidence: [
              { criterion_id: criterion.id, evidence_ids: ['evidence-after-rejection'] },
            ],
          },
          { cwd: '/test', config: { name: 'test', mode: 'test' } }
        )
      );
      expect(afterEvidence.success).toBe(true);
    });

    it('rejects reuse of one evidence record across multiple criteria', async () => {
      coordinator.create('test');
      const primary = coordinator.goal!.contract!.successCriteria[0];
      coordinator.goal!.contract!.successCriteria.push({
        id: 'criterion:second',
        statement: 'second requirement',
        source: 'user',
        status: 'pending',
        requiredEvidenceKinds: ['test'],
        evidenceRefs: [],
      });
      lastContext = {
        coordinator,
        request: {
          inputKind: 'user',
          text: 'test',
          sessionId: 'test-session',
          persistAsUserMessage: true,
          echoToTranscript: true,
          generation: coordinator.generation,
        },
        turnId: 'turn-1',
        evidenceRecords: [
          {
            id: 'evidence-shared',
            goalId: coordinator.goal!.goalId,
            goalRevision: coordinator.goal!.revision,
            objectiveRevision: coordinator.goal!.contract?.objectiveRevision ?? 0,
            turnId: 'turn-1',
            kind: 'test',
            subject: 'one test',
            result: 'passed',
            sourceRef: 'tool:turn-1:exec_command',
            capturedAt: Date.now(),
            redacted: true,
          },
        ],
      };
      const result = await runWithGoalToolContext(lastContext, () =>
        updateGoalTool.execute(
          {
            status: 'complete',
            criterion_evidence: [
              { criterion_id: primary.id, evidence_ids: ['evidence-shared'] },
              { criterion_id: 'criterion:second', evidence_ids: ['evidence-shared'] },
            ],
          },
          { cwd: '/test', config: { name: 'test', mode: 'test' } }
        )
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('cannot be reused');
      expect(lastContext.pendingTerminalRequest).toBeUndefined();
    });

    it('requests blocked status', async () => {
      coordinator.create('test');
      const result = await execute(updateGoalTool, {
        status: 'blocked',
        blocker: {
          category: 'permission',
          resource: 'production deploy',
          reason: 'user approval required',
          retryable: false,
        },
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('blocked');
      expect(lastContext.pendingTerminalRequest?.requestedStatus).toBe('blocked');
      expect(lastContext.pendingBlocker).toMatchObject({
        category: 'permission',
        fingerprint: 'permission:production deploy:user approval required',
        retryable: false,
      });
      expect(result.output).toContain('does not mean blocked was applied');
      expect(result.output).toContain('no progress');
      expect(updateGoalTool.description).toContain('>= 3');
      expect(updateGoalTool.description).toContain('no progress');
    });

    it('rejects blocked without a structured blocker', async () => {
      coordinator.create('test');
      const result = await execute(updateGoalTool, { status: 'blocked' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('blocker category');
      expect(lastContext.pendingTerminalRequest).toBeUndefined();
    });

    it('rejects non-allowlisted and retryable terminal blockers', async () => {
      coordinator.create('test');
      const invalidCategory = await execute(updateGoalTool, {
        status: 'blocked',
        blocker: {
          category: 'runtime',
          resource: 'test runner',
          reason: 'temporary failure',
          retryable: false,
        },
      });
      expect(invalidCategory.success).toBe(false);
      expect(invalidCategory.error).toContain('blocker category');

      const retryable = await execute(updateGoalTool, {
        status: 'blocked',
        blocker: {
          category: 'external_state',
          resource: 'remote API',
          reason: 'temporarily unavailable',
          retryable: true,
        },
      });
      expect(retryable.success).toBe(false);
      expect(retryable.error).toContain('Retryable blockers');
    });

    it('rejects update when no goal exists', async () => {
      const result = await execute(updateGoalTool, { status: 'complete' });
      expect(result.success).toBe(false);
    });

    it('has tool definition', () => {
      expect(updateGoalTool.name).toBe('update_goal');
    });
  });

  describe('abandon_goal', () => {
    async function abandon(
      text: string,
      inputKind: GoalToolExecutionContext['request']['inputKind'] = 'user',
      reason = 'The user withdrew this Goal.'
    ): Promise<ToolResult> {
      lastContext = {
        coordinator,
        request: {
          inputKind,
          text,
          sessionId: coordinator.boundSessionId,
          persistAsUserMessage: true,
          echoToTranscript: true,
          generation: coordinator.generation,
        },
        turnId: 'turn-abandon',
        evidenceRecords: [],
      };
      return runWithGoalToolContext(lastContext, () =>
        abandonGoalTool.execute(
          { reason },
          { cwd: '/test', config: { name: 'test', mode: 'test' } }
        )
      );
    }

    it('clears the Goal and session binding after explicit latest-user authorization', async () => {
      coordinator.create('Obsolete objective');
      const goalId = coordinator.goal!.goalId;
      const binding = jest.spyOn(sessionStorage, 'updateSessionGoalBinding').mockReturnValue(null);

      const result = await abandon("ok let's just abandon this goal entirely");

      expect(result.success).toBe(true);
      expect(result.metadata).toMatchObject({
        action: 'abandon_goal',
        goalId,
        turnId: 'turn-abandon',
        reason: 'The user withdrew this Goal.',
        authorizedBy: 'latest_user_explicit_intent',
      });
      expect(coordinator.goal).toBeNull();
      expect(binding).toHaveBeenCalledWith(coordinator.boundSessionId, null);
    });

    it.each([
      ['user asked a question', 'Should we abandon this goal?', 'user'],
      ['user negated abandonment', 'Do not abandon this goal.', 'user'],
      ['user discussed unrelated work', 'Stop the development server.', 'user'],
      ['model continuation asserted intent', 'Abandon this goal.', 'goal_continuation'],
    ] as const)('fails closed when %s', async (_label, text, inputKind) => {
      coordinator.create('Goal must remain');

      const result = await abandon(text, inputKind);

      expect(result.success).toBe(false);
      expect(result.error).toContain('denied');
      expect(coordinator.goal?.objective).toBe('Goal must remain');
    });

    it('accepts an explicit Chinese abandonment revision and requires an audit reason', async () => {
      coordinator.create('待取消目标');
      const missingReason = await abandon('放弃这个目标', 'revision', '');
      expect(missingReason.success).toBe(false);
      expect(coordinator.goal).not.toBeNull();

      const result = await abandon('放弃这个目标', 'revision', '用户明确改变方向');
      expect(result.success).toBe(true);
      expect(coordinator.goal).toBeNull();
    });

    it.each([
      'Can you abandon this goal?',
      'exit goal mode',
      '请结束当前目标？',
      '退出goal模式',
      '退出目标模式',
    ])('accepts an explicit abandonment request with question punctuation: %s', async text => {
      coordinator.create('待取消目标');
      const result = await abandon(text, 'user', '用户明确要求结束目标');
      expect(result.success).toBe(true);
      expect(coordinator.goal).toBeNull();
    });

    it('registers a destructive typed tool and denies permission without runtime context', () => {
      expect(GOAL_TOOLS).toContain(abandonGoalTool);
      expect(abandonGoalTool.name).toBe('abandon_goal');
      expect(abandonGoalTool.parameters.required).toContain('reason');
      expect(abandonGoalTool.isDestructive!({})).toBe(true);
      expect(abandonGoalTool.checkPermissions!({}, {} as never).behavior).toBe('deny');
      expect(
        authorizeGoalAbandonment({
          inputKind: 'user',
          text: 'Cancel the current target.',
          sessionId: 'test-session',
          persistAsUserMessage: true,
          echoToTranscript: true,
          generation: 1,
        }).authorized
      ).toBe(true);
    });
  });

  describe('update_goal_plan', () => {
    it('queues a plan and derived criterion without mutating the coordinator mid-turn', async () => {
      coordinator.create('ship safely');
      const revision = coordinator.goal!.revision;
      const result = await execute(updateGoalPlanTool, {
        phase: 'verification',
        steps: [{ description: 'Run tests', done: false }],
        next_action: 'Run npm test',
        derived_criteria: [{ statement: 'Tests pass', evidence_kinds: ['test'] }],
      });
      expect(result.success).toBe(true);
      expect(lastContext.pendingPlanUpdate).toEqual({
        phase: 'verification',
        steps: [{ description: 'Run tests', done: false }],
        nextAction: 'Run npm test',
        derivedCriteria: [{ statement: 'Tests pass', requiredEvidenceKinds: ['test'] }],
      });
      expect(coordinator.goal!.revision).toBe(revision);
      expect(coordinator.goal!.contract!.planSnapshot!.phase).toBe('initial');
    });
  });

  it('keeps overlapping async tool contexts isolated by session', async () => {
    const coordA = new GoalCoordinator('/tmp/tool-isolation-a', 'session-a');
    const coordB = new GoalCoordinator('/tmp/tool-isolation-b', 'session-b');
    coordA.create('Goal A');
    coordB.create('Goal B');
    const contextFor = (coord: GoalCoordinator, sessionId: string): GoalToolExecutionContext => ({
      coordinator: coord,
      request: {
        inputKind: 'goal_continuation',
        sessionId,
        goal: {
          goalId: coord.goal!.goalId,
          revision: coord.goal!.revision,
          continuationIndex: 1,
        },
        persistAsUserMessage: false,
        echoToTranscript: false,
        generation: coord.generation,
      },
      turnId: `turn-${sessionId}`,
      evidenceRecords: [],
    });

    const [a, b] = await Promise.all([
      runWithGoalToolContext(contextFor(coordA, 'session-a'), async () => {
        await new Promise<void>(resolve => setImmediate(resolve));
        return getGoalTool.execute({}, { cwd: '/tmp', config: { name: 'test', mode: 'test' } });
      }),
      runWithGoalToolContext(contextFor(coordB, 'session-b'), () =>
        getGoalTool.execute({}, { cwd: '/tmp', config: { name: 'test', mode: 'test' } })
      ),
    ]);

    expect(a.output).toContain('Goal A');
    expect(a.output).not.toContain('Goal B');
    expect(b.output).toContain('Goal B');
    expect(b.output).not.toContain('Goal A');
  });
});
