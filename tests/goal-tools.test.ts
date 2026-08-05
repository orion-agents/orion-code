/**
 * v0.2.24 — Goal model tools unit tests.
 * v0.1.2 — Runtime/session scoped Goal tool binding.
 */

import { GoalCoordinator } from '../src/runtime/goals/coordinator';
import {
  getGoalTool,
  createGoalTool,
  updateGoalPlanTool,
  updateGoalTool,
  runWithGoalToolContext,
  type GoalToolExecutionContext,
} from '../src/runtime/goals/tools';
import type { OpenHorseTool, ToolResult } from '../src/framework/tool';

describe('Goal model tools', () => {
  let coordinator: GoalCoordinator;
  let lastContext: GoalToolExecutionContext;

  beforeEach(() => {
    coordinator = new GoalCoordinator('/test/project', 'test-session');
  });

  async function execute(tool: OpenHorseTool, args: Record<string, unknown>): Promise<ToolResult> {
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
      const result = await execute(createGoalTool, { objective: 'Run CI' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Run CI');
    });

    it('creates user-owned constraints and success criteria from structured input', async () => {
      const result = await execute(createGoalTool, {
        objective: 'Ship safely',
        constraints: ['Do not change public APIs'],
        success_criteria: [{ statement: 'Focused tests pass', required_evidence_kinds: ['test'] }],
      });
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
      const result = await execute(createGoalTool, { objective: '' });
      expect(result.success).toBe(false);
    });

    it('rejects duplicate goal if active', async () => {
      coordinator.create('first goal');
      const result = await execute(createGoalTool, { objective: 'second goal' });
      expect(result.success).toBe(false);
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
