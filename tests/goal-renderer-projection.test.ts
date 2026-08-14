import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  AgentRuntimeController,
  type AgentRuntimeRunner,
} from '../src/runtime/agent-runtime-controller';
import type {
  AgentRuntimeEvent,
  AgentRuntimeEventSink,
} from '../src/runtime/agent-runtime-protocol';
import { GoalCoordinator } from '../src/runtime/goals/coordinator';
import { formatGoalRuntimeEvent } from '../src/runtime/goals/presentation';
import {
  currentGoalToolContext,
  getGoalTool,
  updateGoalPlanTool,
  updateGoalTool,
} from '../src/runtime/goals/tools';
import type {
  AgentTurnOutcome,
  GoalEvidenceRecord,
  GoalRuntimeEvent,
  RuntimeGoalSnapshot,
} from '../src/runtime/goals/types';
import type { OrionCodeUiRuntime } from '../src/runtime/ui-events';
import { PrintEventSink } from '../src/print-ui/launch';
import { formatTerminalStatusMessage, TerminalEventSink } from '../src/terminal-ui/launch';
import { renderFrameRows } from '../src/tui-core/frame';
import { renderTuiUiFrame } from '../src/tui-ui/layout';
import { initialTuiUiState, tuiUiReducer, type TuiUiState } from '../src/tui-ui/state';
import {
  createSession,
  loadSessionMeta,
  updateSessionGoalBinding,
} from '../src/services/session-storage';

function runtime(
  projectPath: string,
  sessionId: string,
  renderer: 'tui' | 'terminal' = 'tui'
): OrionCodeUiRuntime {
  const session = { id: sessionId, projectPath, model: 'test-model' };
  return {
    cwd: projectPath,
    version: 'test',
    config: { model: 'test-model', ui: { renderer } } as OrionCodeUiRuntime['config'],
    store: {
      getSnapshot: jest.fn(() => ({
        currentModel: 'test-model',
        tokenUsage: { promptTokens: 8, completionTokens: 3 },
        lastLoopStats: {
          finishReason: 'completed',
          llmRequests: 1,
          toolCalls: 1,
          unsafeToolCalls: 0,
          verificationPassedCommands: ['npm test -- renderer-projection'],
        },
      })),
      setProcessing: jest.fn(),
    } as unknown as OrionCodeUiRuntime['store'],
    llm: null,
    runtime: {} as OrionCodeUiRuntime['runtime'],
    isConfigured: true,
    ensureSession: jest.fn(
      () => session as unknown as ReturnType<OrionCodeUiRuntime['ensureSession']>
    ),
    setSession: jest.fn(),
    getSession: jest.fn(() => session as unknown as ReturnType<OrionCodeUiRuntime['getSession']>),
    shutdown: jest.fn(),
  };
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

function flushImmediate(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function goalEvents(events: AgentRuntimeEvent[]): GoalRuntimeEvent[] {
  return events
    .filter(
      (event): event is Extract<AgentRuntimeEvent, { type: 'goal_event' }> =>
        event.type === 'goal_event'
    )
    .map(event => event.event);
}

describe('Goal renderer projection parity', () => {
  it('auto-exits the exact Chinese Goal-mode test objective with runtime tool evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-goal-meta-exit-'));
    const projectPath = join(root, 'project');
    const configPath = join(root, 'config');
    const previousConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = configPath;
    mkdirSync(projectPath);
    execFileSync('git', ['init', '--quiet', projectPath]);

    const session = createSession(projectPath, 'test-model');
    const sessionId = session.id;
    const seed = new GoalCoordinator(projectPath, sessionId);
    expect(seed.create('测试一下目标模式，然后退出')).toEqual({ ok: true });
    expect(seed.goal).toMatchObject({
      objective: '测试一下目标模式',
      contract: { completionAction: 'exit_goal' },
    });
    updateSessionGoalBinding(sessionId, seed.goal);

    const protocolEvents: AgentRuntimeEvent[] = [];
    const eventSink: AgentRuntimeEventSink = {
      emit: event => {
        protocolEvents.push(event);
        return event.type === 'transcript_append' ? `entry-${protocolEvents.length}` : undefined;
      },
    };
    let controller!: AgentRuntimeController;
    let turnCount = 0;
    const runner: AgentRuntimeRunner = {
      runInput: jest.fn(async () => undefined),
      runRequest: jest.fn(async () => {
        turnCount += 1;
        const context = currentGoalToolContext();
        expect(context).toBeDefined();
        if (!context) throw new Error('Goal tool context was not established by the controller');
        const toolContext = { cwd: projectPath, config: { name: 'test', mode: 'test' } };
        const controllerSink = (controller as unknown as { eventSink: AgentRuntimeEventSink })
          .eventSink;

        const firstRead = await getGoalTool.execute({}, toolContext);
        expect(firstRead.success).toBe(true);
        controllerSink.emit({
          type: 'tool_finished',
          event: {
            callId: 'goal-meta-get-1',
            name: 'get_goal',
            args: {},
            success: true,
            duration: 1,
            outputBytes: firstRead.output.length,
            sequence: 1,
          },
        });

        const planResult = await updateGoalPlanTool.execute(
          {
            phase: 'verification',
            steps: [{ description: '验证目标模式工具链', done: true }],
            next_action: '完成审计并自动退出目标模式',
          },
          toolContext
        );
        expect(planResult.success).toBe(true);
        controllerSink.emit({
          type: 'tool_finished',
          event: {
            callId: 'goal-meta-plan-1',
            name: 'update_goal_plan',
            args: { phase: 'verification' },
            success: true,
            duration: 1,
            outputBytes: planResult.output.length,
            sequence: 2,
          },
        });

        // A later get_goal in the same turn must expose exact IDs for the
        // already-finished runtime probes, so completion is not always one
        // evidence generation behind the model.
        const evidenceRead = await getGoalTool.execute({}, toolContext);
        const payload = JSON.parse(evidenceRead.output) as {
          recentEvidence: Array<{ id: string; kind: string; subject: string }>;
        };
        expect(payload.recentEvidence).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: 'runtime',
              subject: expect.stringContaining('目标模式'),
            }),
          ])
        );
        const runtimeIds = payload.recentEvidence
          .filter(record => record.kind === 'runtime')
          .map(record => record.id);
        expect(runtimeIds).toHaveLength(2);

        const completionResult = await updateGoalTool.execute(
          {
            status: 'complete',
            criterion_evidence: [{ criterion_id: 'criterion:primary', evidence_ids: runtimeIds }],
          },
          toolContext
        );
        expect(completionResult.success).toBe(true);
      }),
    };
    controller = new AgentRuntimeController({
      runtime: runtime(projectPath, sessionId),
      runner,
      eventSink,
      echoSubmittedInput: false,
    });

    try {
      const controllerSink = (controller as unknown as { eventSink: AgentRuntimeEventSink })
        .eventSink;
      controllerSink.emit({
        type: 'session_restored',
        event: { sessionId, projectPath, model: 'test-model', restoredMessages: 0 },
      });
      expect(controller.submit('/goal resume')).toEqual({ type: 'started' });

      await controller.waitForIdle();
      await flushImmediate();
      await controller.waitForIdle();

      expect(turnCount).toBe(1);
      expect(loadSessionMeta(sessionId)?.activeGoalId).toBeUndefined();
      expect(
        (controller as unknown as { goalCoordinator: GoalCoordinator }).goalCoordinator.goal
      ).toBeNull();
      const receipt = new GoalCoordinator(projectPath, sessionId);
      expect(receipt.load(false)).toBe(true);
      expect(receipt.goal).toMatchObject({
        objective: '测试一下目标模式',
        status: 'complete',
        contract: { completionAction: 'exit_goal' },
        completionAudit: { passed: true },
      });
      const events = goalEvents(protocolEvents);
      expect(events.filter(event => event.type === 'goal_audit_failed')).toHaveLength(0);
      expect(events.filter(event => event.type === 'goal_completed')).toHaveLength(1);
      expect(events.at(-1)?.type).toBe('goal_cleared');
    } finally {
      if (previousConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
      else process.env.ORION_CODE_CONFIG_DIR = previousConfigDir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves one Goal ledger and accounting across TUI -> terminal -> TUI switches', () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-goal-renderer-switch-'));
    const projectPath = join(root, 'project');
    const configPath = join(root, 'config');
    const sessionId = 'renderer-switch-session';
    const previousConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = configPath;
    mkdirSync(projectPath);
    execFileSync('git', ['init', '--quiet', projectPath]);

    const projectGoalEvents = (
      events: GoalRuntimeEvent[],
      renderer: 'tui' | 'terminal'
    ): RuntimeGoalSnapshot => {
      if (renderer === 'tui') {
        let state = initialTuiUiState;
        for (const event of events) {
          state = tuiUiReducer(state, { type: 'goalEvent', event });
          expect(state.statusMessage).toBe(formatGoalRuntimeEvent(event));
        }
        expect(state.goal).toBeDefined();
        return state.goal as RuntimeGoalSnapshot;
      }

      const writes: string[] = [];
      const sink = new TerminalEventSink(runtime(projectPath, sessionId, 'terminal'), {
        write: text => writes.push(text),
      });
      for (const event of events) {
        sink.goalEvent(event);
        expect(stripAnsi(writes.at(-1) ?? '').trim()).toBe(
          formatTerminalStatusMessage(formatGoalRuntimeEvent(event))
        );
      }
      const lastGoalEvent = [...events]
        .reverse()
        .find(
          (
            event
          ): event is Extract<
            GoalRuntimeEvent,
            { type: 'goal_restored' | 'goal_updated' | 'goal_completed' }
          > =>
            event.type === 'goal_restored' ||
            event.type === 'goal_updated' ||
            event.type === 'goal_completed'
        );
      expect(lastGoalEvent).toBeDefined();
      return lastGoalEvent!.goal;
    };

    const finalizeLeg = (
      coordinator: GoalCoordinator,
      turnId: string,
      usage: AgentTurnOutcome['usage'],
      sequence: number
    ): { evidence: GoalEvidenceRecord; snapshot: RuntimeGoalSnapshot } => {
      const goal = coordinator.goal;
      expect(goal).toBeDefined();
      if (!goal) throw new Error('Renderer leg requires a persisted Goal');
      const evidence: GoalEvidenceRecord = {
        id: `evidence:renderer-switch:${sequence}`,
        goalId: goal.goalId,
        goalRevision: goal.revision,
        objectiveRevision: goal.contract?.objectiveRevision ?? 0,
        turnId,
        kind: 'runtime',
        subject: `renderer continuity checkpoint ${sequence}`,
        result: 'passed',
        sourceRef: `renderer-switch:${sequence}`,
        capturedAt: Date.now(),
        redacted: true,
      };
      coordinator.finalizeTurn({
        turnId,
        sessionId,
        goalId: goal.goalId,
        goalRevision: goal.revision,
        goalGeneration: coordinator.generation,
        startedAt: Date.now() - 10,
        endedAt: Date.now(),
        finishReason: 'completed',
        usage,
        usageComplete: true,
        madeProgress: true,
        workspaceChanged: false,
        evidenceRecords: [evidence],
      });
      const snapshot = coordinator.snapshot();
      expect(snapshot).toBeDefined();
      return { evidence, snapshot: snapshot! };
    };

    try {
      // First product-TUI leg creates the durable identity and records one turn.
      const firstTui = new GoalCoordinator(projectPath, sessionId);
      expect(firstTui.create('Prove renderer continuity')).toEqual({ ok: true });
      const initialSnapshot = firstTui.snapshot();
      expect(initialSnapshot).toBeDefined();
      const goalId = initialSnapshot!.goalId;
      const first = finalizeLeg(
        firstTui,
        'turn:tui:1',
        { promptTokens: 7, completionTokens: 3, subagentTokens: 1, totalTokens: 11 },
        1
      );
      const firstProjection = projectGoalEvents(
        [
          { type: 'goal_restored', goal: initialSnapshot! },
          {
            type: 'goal_evidence_recorded',
            goalId,
            evidence: {
              id: first.evidence.id,
              kind: first.evidence.kind,
              result: first.evidence.result,
              subject: first.evidence.subject,
            },
          },
          { type: 'goal_updated', goal: first.snapshot, reason: 'turn_finalized' },
        ],
        'tui'
      );
      expect(firstProjection).toEqual(first.snapshot);
      firstTui.deferContinuation();
      const firstPaused = firstTui.snapshot()!;

      // A renderer switch is a new adapter/controller over the same session sidecar.
      // Loading an already-paused Goal with restart recovery enabled must not mutate it.
      const terminal = new GoalCoordinator(projectPath, sessionId);
      expect(terminal.load(true)).toBe(true);
      expect(terminal.snapshot()).toEqual(firstPaused);
      expect(terminal.goal?.evidenceLedger?.map(record => record.id)).toEqual([first.evidence.id]);
      expect(terminal.resume()).toBe(true);
      const terminalResumed = terminal.snapshot()!;
      const second = finalizeLeg(
        terminal,
        'turn:terminal:2',
        { promptTokens: 8, completionTokens: 4, subagentTokens: 1, totalTokens: 13 },
        2
      );
      const terminalProjection = projectGoalEvents(
        [
          { type: 'goal_restored', goal: firstPaused },
          { type: 'goal_updated', goal: terminalResumed, reason: 'target_resume' },
          {
            type: 'goal_evidence_recorded',
            goalId,
            evidence: {
              id: second.evidence.id,
              kind: second.evidence.kind,
              result: second.evidence.result,
              subject: second.evidence.subject,
            },
          },
          { type: 'goal_updated', goal: second.snapshot, reason: 'turn_finalized' },
        ],
        'terminal'
      );
      expect(terminalProjection).toEqual(second.snapshot);
      terminal.deferContinuation();
      const terminalPaused = terminal.snapshot()!;

      // Returning to the product TUI reloads the exact second-leg state and adds
      // one more turn without duplicating either earlier ledger entry or usage.
      const secondTui = new GoalCoordinator(projectPath, sessionId);
      expect(secondTui.load(true)).toBe(true);
      expect(secondTui.snapshot()).toEqual(terminalPaused);
      expect(secondTui.resume()).toBe(true);
      const secondTuiResumed = secondTui.snapshot()!;
      const third = finalizeLeg(
        secondTui,
        'turn:tui:3',
        { promptTokens: 9, completionTokens: 5, subagentTokens: 2, totalTokens: 16 },
        3
      );
      const finalProjection = projectGoalEvents(
        [
          { type: 'goal_restored', goal: terminalPaused },
          { type: 'goal_updated', goal: secondTuiResumed, reason: 'target_resume' },
          {
            type: 'goal_evidence_recorded',
            goalId,
            evidence: {
              id: third.evidence.id,
              kind: third.evidence.kind,
              result: third.evidence.result,
              subject: third.evidence.subject,
            },
          },
          { type: 'goal_updated', goal: third.snapshot, reason: 'turn_finalized' },
        ],
        'tui'
      );

      expect(finalProjection).toEqual(third.snapshot);
      expect(third.snapshot).toMatchObject({
        goalId,
        status: 'active',
        tokensUsed: 40,
        continuationCount: 3,
      });
      expect(third.snapshot.revision).toBeGreaterThan(second.snapshot.revision);
      expect(second.snapshot.revision).toBeGreaterThan(first.snapshot.revision);
      expect(secondTui.goal?.sessionId).toBe(sessionId);
      expect(secondTui.goal?.lastTurn).toMatchObject({
        turnId: 'turn:tui:3',
        promptTokens: 9,
        completionTokens: 5,
        subagentTokens: 2,
        totalTokens: 16,
      });
      const finalEvidence = secondTui.goal?.evidenceLedger ?? [];
      expect(finalEvidence.map(record => record.id)).toEqual([
        first.evidence.id,
        second.evidence.id,
        third.evidence.id,
      ]);
      expect(new Set(finalEvidence.map(record => record.id))).toHaveProperty('size', 3);

      // A final independent reload proves the assertions above came from durable
      // session state rather than renderer-local objects retained in memory.
      const diskCheck = new GoalCoordinator(projectPath, sessionId);
      expect(diskCheck.load(false)).toBe(true);
      expect(diskCheck.snapshot()).toEqual(third.snapshot);
      expect(diskCheck.goal?.evidenceLedger).toEqual(finalEvidence);
    } finally {
      if (previousConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
      else process.env.ORION_CODE_CONFIG_DIR = previousConfigDir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('projects the controller-produced Goal lifecycle equally through every renderer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-goal-renderer-projection-'));
    const projectPath = join(root, 'project');
    const configPath = join(root, 'config');
    const previousConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = configPath;
    mkdirSync(projectPath);
    execFileSync('git', ['init', '--quiet', projectPath]);

    const session = createSession(projectPath, 'test-model');
    const sessionId = session.id;

    const seed = new GoalCoordinator(projectPath, sessionId);
    expect(seed.create('Verify renderer projection')).toEqual({ ok: true });
    updateSessionGoalBinding(sessionId, seed.goal);

    const protocolEvents: AgentRuntimeEvent[] = [];
    const eventSink: AgentRuntimeEventSink = {
      emit: event => {
        protocolEvents.push(event);
        return event.type === 'transcript_append' ? `entry-${protocolEvents.length}` : undefined;
      },
    };
    const testRuntime = runtime(projectPath, sessionId);
    let controller!: AgentRuntimeController;
    let turnIndex = 0;
    const runner: AgentRuntimeRunner = {
      runInput: jest.fn(async () => undefined),
      runRequest: jest.fn(async () => {
        turnIndex += 1;
        if (turnIndex > 2) throw new Error('Goal should complete after the second continuation');
        const context = currentGoalToolContext();
        expect(context).toBeDefined();
        if (!context) throw new Error('Goal tool context was not established by the controller');

        if (turnIndex === 1) {
          const planResult = await updateGoalPlanTool.execute(
            {
              phase: 'verification',
              steps: [{ description: 'Verify renderer projection', done: false }],
              next_action: 'Run renderer-specific verification',
            },
            { cwd: projectPath, config: { name: 'test', mode: 'test' } }
          );
          expect(planResult.success).toBe(true);
        }

        const summary =
          turnIndex === 1
            ? 'unrelated smoke verification'
            : 'renderer projection verification test';
        const controllerSink = (controller as unknown as { eventSink: AgentRuntimeEventSink })
          .eventSink;
        controllerSink.emit({
          type: 'tool_finished',
          event: {
            callId: `test-${turnIndex}`,
            name: 'exec_command',
            args: { command: 'npm test -- renderer-projection' },
            success: true,
            duration: 1,
            summary,
            outputBytes: 1,
            sequence: turnIndex,
          },
        });

        const evidence = context.evidenceRecords.at(-1);
        expect(evidence).toBeDefined();
        if (!evidence) throw new Error('Controller did not capture Goal evidence');
        const completionResult = await updateGoalTool.execute(
          {
            status: 'complete',
            criterion_evidence: [
              { criterion_id: 'criterion:primary', evidence_ids: [evidence.id] },
            ],
          },
          { cwd: projectPath, config: { name: 'test', mode: 'test' } }
        );
        expect(completionResult.success).toBe(true);
      }),
    };
    controller = new AgentRuntimeController({
      runtime: testRuntime,
      runner,
      eventSink,
      echoSubmittedInput: false,
      readyStatus: 'generic ready status',
    });

    try {
      const controllerSink = (controller as unknown as { eventSink: AgentRuntimeEventSink })
        .eventSink;
      controllerSink.emit({
        type: 'session_restored',
        event: {
          sessionId,
          projectPath,
          model: 'test-model',
          restoredMessages: 0,
        },
      });
      expect(controller.submit('/target resume')).toEqual({ type: 'started' });

      await controller.waitForIdle();
      await flushImmediate();
      await controller.waitForIdle();
      await flushImmediate();

      expect(turnIndex).toBe(2);
      expect(loadSessionMeta(sessionId)?.activeGoalId).toBeUndefined();
      expect(
        (controller as unknown as { goalCoordinator: GoalCoordinator }).goalCoordinator.goal
      ).toBeNull();
      const completedReceipt = new GoalCoordinator(projectPath, sessionId);
      expect(completedReceipt.load(false)).toBe(true);
      expect(completedReceipt.goal).toMatchObject({
        status: 'complete',
        completionAudit: expect.objectContaining({ passed: true }),
      });

      const events = goalEvents(protocolEvents);
      const eventTypes = events.map(event => event.type);
      expect(eventTypes).toEqual(
        expect.arrayContaining([
          'goal_restored',
          'goal_updated',
          'goal_continuation',
          'goal_evidence_recorded',
          'goal_plan_updated',
          'goal_audit_failed',
          'goal_completed',
          'goal_cleared',
        ])
      );
      expect(
        events
          .filter(
            (event): event is Extract<GoalRuntimeEvent, { type: 'goal_continuation' }> =>
              event.type === 'goal_continuation'
          )
          .map(event => event.phase)
      ).toEqual(expect.arrayContaining(['scheduled', 'started']));
      expect(events.filter(event => event.type === 'goal_evidence_recorded')).toHaveLength(2);
      expect(events.filter(event => event.type === 'goal_audit_failed')).toHaveLength(1);
      expect(events.filter(event => event.type === 'goal_completed')).toHaveLength(1);
      expect(events.at(-1)?.type).toBe('goal_cleared');

      const terminalGoalEventIndexes = protocolEvents
        .map((event, index) => ({ event, index }))
        .filter(
          item =>
            item.event.type === 'goal_event' &&
            (item.event.event.type === 'goal_audit_failed' ||
              item.event.event.type === 'goal_completed')
        );
      expect(terminalGoalEventIndexes).toHaveLength(2);
      for (const item of terminalGoalEventIndexes) {
        const nextGoalEventIndex = protocolEvents.findIndex(
          (event, index) => index > item.index && event.type === 'goal_event'
        );
        const boundary = nextGoalEventIndex < 0 ? protocolEvents.length : nextGoalEventIndex;
        expect(
          protocolEvents
            .slice(item.index + 1, boundary)
            .filter(
              event => event.type === 'status_changed' && event.message === 'generic ready status'
            )
        ).toEqual([]);
      }

      const auditIndex = events.findIndex(event => event.type === 'goal_audit_failed');
      const completedIndex = events.findIndex(event => event.type === 'goal_completed');
      expect(auditIndex).toBeGreaterThan(0);
      expect(completedIndex).toBeGreaterThan(0);
      expect(events[auditIndex - 1]?.type).toBe('goal_updated');
      expect(events[completedIndex - 1]?.type).toBe('goal_updated');

      const auditEvent = events[auditIndex] as Extract<
        GoalRuntimeEvent,
        { type: 'goal_audit_failed' }
      >;
      const auditState = events
        .slice(0, auditIndex + 1)
        .reduce(
          (state, event) => tuiUiReducer(state, { type: 'goalEvent', event }),
          initialTuiUiState
        );
      expect(auditState.statusMessage).toBe(formatGoalRuntimeEvent(auditEvent));
      expect(auditState.statusMessage).toContain('criterion:primary');
      expect(auditState.goal?.auditRemaining).toContainEqual(
        expect.stringContaining('criterion:primary')
      );
      expect(
        renderFrameRows(renderTuiUiFrame(auditState, { width: 160, height: 8 })).join('\n')
      ).toContain('criterion:primary');

      const completedEvent = events[completedIndex] as Extract<
        GoalRuntimeEvent,
        { type: 'goal_completed' }
      >;
      const completedState = events
        .slice(0, completedIndex + 1)
        .reduce(
          (state, event) => tuiUiReducer(state, { type: 'goalEvent', event }),
          initialTuiUiState
        );
      expect(completedState.statusMessage).toBe(formatGoalRuntimeEvent(completedEvent));
      expect(completedState.statusMessage).toContain('criterion:primary=passed');

      const exitedState = events.reduce<TuiUiState>(
        (state, event) => tuiUiReducer(state, { type: 'goalEvent', event }),
        {
          ...initialTuiUiState,
          agentMode: { baseMode: 'auto', pendingBaseMode: null },
        }
      );
      expect(exitedState.goal).toBeNull();
      expect(exitedState.agentMode.baseMode).toBe('auto');
      expect(exitedState.statusMessage).toContain('exited Goal mode');
      expect(
        renderFrameRows(renderTuiUiFrame(exitedState, { width: 160, height: 8 })).join('\n')
      ).toContain('MODE AUTO');

      const terminalWrites: string[] = [];
      const terminal = new TerminalEventSink(testRuntime, {
        write: text => terminalWrites.push(text),
      });
      const printText = new PrintEventSink(testRuntime, 'text');
      const printJson = new PrintEventSink(testRuntime, 'json');
      const stderrWrites: string[] = [];
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(chunk => {
        stderrWrites.push(String(chunk));
        return true;
      });

      try {
        let tuiState = initialTuiUiState;
        for (const event of events) {
          tuiState = tuiUiReducer(tuiState, { type: 'goalEvent', event });
          terminal.goalEvent(event);
          printText.goalEvent(event);
          printJson.goalEvent(event);

          const expected = formatGoalRuntimeEvent(event);
          expect(tuiState.statusMessage).toBe(expected);
          expect(stripAnsi(terminalWrites.at(-1) ?? '').trim()).toBe(
            formatTerminalStatusMessage(expected)
          );
          expect(stderrWrites.at(-1)).toBe(`${expected}\n`);

          const tuiFrame = renderFrameRows(
            renderTuiUiFrame(tuiState, { width: 160, height: 8 })
          ).join('\n');
          if (event.type === 'goal_evidence_recorded') {
            expect(tuiFrame).toContain(`[${event.evidence.id}]`);
          }
          if (event.type === 'goal_completed') {
            expect(tuiFrame).toContain(
              `criterion:primary=passed[${event.audit.evidenceRefs.join(',')}]`
            );
          }
        }

        expect(printJson.result().goalEvents).toEqual(events);
        expect(printText.result().goalEvents).toEqual(events);
      } finally {
        stderrSpy.mockRestore();
      }
    } finally {
      if (previousConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
      else process.env.ORION_CODE_CONFIG_DIR = previousConfigDir;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
