import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Store } from '../src/framework/store';
import { createContextHarness } from '../src/harness';
import {
  AgentRuntimeController,
  type AgentRuntimeRunner,
} from '../src/runtime/agent-runtime-controller';
import { createUiEventSinkFromAgentRuntimeEvents } from '../src/runtime/agent-runtime-protocol';
import { AgentChatController } from '../src/runtime/chat-controller';
import { GoalCoordinator } from '../src/runtime/goals/coordinator';
import { currentGoalToolContext, updateGoalPlanTool } from '../src/runtime/goals/tools';
import type {
  AgentRuntimeEvent,
  AgentRuntimeEventSink,
} from '../src/runtime/agent-runtime-protocol';
import type { AgentTurnRequest } from '../src/runtime/goals/types';
import type { OrionCodeUiRuntime } from '../src/runtime/ui-events';
import { loadConfig } from '../src/services/config';
import {
  appendSessionMessages,
  createSession,
  loadSessionCompactCheckpoint,
  readSessionMessages,
  updateSessionHarnessState,
  type SessionMeta,
} from '../src/services/session-storage';
import { TOOLS } from '../src/tools';

function eventSink(events: AgentRuntimeEvent[]): AgentRuntimeEventSink {
  return {
    emit: event => {
      events.push(event);
      return event.type === 'transcript_append' ? `entry-${events.length}` : undefined;
    },
  };
}

async function flushImmediate(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

async function waitForCondition(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
}

describe('Goal continuity integration', () => {
  it('keeps one typed Goal through 21 turns, real compact, restart, /resume, and turn 22', async () => {
    const previousConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    const root = mkdtempSync(join(tmpdir(), 'orion-goal-continuity-'));
    const projectDir = join(root, 'project');
    process.env.ORION_CODE_CONFIG_DIR = join(root, 'config');

    try {
      const config = loadConfig({ apiKey: 'test-key', model: 'test-model' });
      const session = createSession(projectDir, 'test-model');
      const initialStore = new Store({ config, tools: TOOLS, currentModel: 'test-model' });
      const initialRuntime: OrionCodeUiRuntime = {
        cwd: projectDir,
        version: 'test',
        config,
        store: initialStore,
        llm: null,
        runtime: {} as OrionCodeUiRuntime['runtime'],
        isConfigured: true,
        ensureSession: jest.fn(() => session),
        getSession: jest.fn(() => session),
        setSession: jest.fn(),
        shutdown: jest.fn(),
      };
      const typedRequests: AgentTurnRequest[] = [];
      let releaseTurn21: () => void = () => undefined;
      let signalTurn21: () => void = () => undefined;
      const turn21Held = new Promise<void>(resolve => {
        releaseTurn21 = resolve;
      });
      const turn21Started = new Promise<void>(resolve => {
        signalTurn21 = resolve;
      });
      const runner: AgentRuntimeRunner = {
        runInput: jest.fn(async () => undefined),
        runRequest: jest.fn(async request => {
          typedRequests.push(request);
          const index = typedRequests.length;
          const context = currentGoalToolContext();
          expect(context).toBeDefined();
          expect(request).toMatchObject({
            inputKind: 'goal_continuation',
            sessionId: session.id,
            persistAsUserMessage: false,
            echoToTranscript: false,
            generation: context!.coordinator.generation,
            goal: {
              goalId: context!.coordinator.goal!.goalId,
              revision: context!.coordinator.goal!.revision,
              continuationIndex: index,
            },
          });

          initialStore.setState({
            tokenUsage: { promptTokens: 10, completionTokens: 5 },
            lastLoopStats: {
              turnsStarted: 1,
              llmRequests: 1,
              toolCalls: 1,
              readOnlyToolCalls: 0,
              unsafeToolCalls: 0,
              toolResultBytes: 0,
              modelVisibleToolBytes: 0,
              summarizedBytes: 0,
              finishReason: 'completed',
              singleReadOnlyStreak: 0,
              batchReadSuggestionCount: 0,
              localFastPathUsed: false,
            },
          });
          const stableStep = Math.ceil(index / 2);
          const planResult = await updateGoalPlanTool.execute(
            {
              phase: 'implementation',
              steps: [
                {
                  description: `Complete verified step ${stableStep}`,
                  done: index % 2 === 0,
                },
              ],
              next_action: `Continue with verified step ${stableStep}`,
              derived_criteria:
                index === 1
                  ? [
                      {
                        statement: 'Goal continuity survives compact and restart',
                        evidence_kinds: ['test'],
                      },
                    ]
                  : [],
            },
            { cwd: projectDir, config }
          );
          expect(planResult.success).toBe(true);

          if (index === 1) {
            const goal = context!.coordinator.goal!;
            context!.evidenceRecords.push({
              id: 'evidence:continuity:turn-1',
              goalId: goal.goalId,
              goalRevision: goal.revision,
              objectiveRevision: goal.contract!.objectiveRevision,
              turnId: context!.turnId,
              kind: 'test',
              subject: 'Goal continuity fixture entered the typed runtime flow',
              result: 'passed',
              sourceRef: 'runtime:goal-continuity-e2e',
              capturedAt: Date.now(),
              redacted: true,
            });
          }

          if (index === 21) {
            signalTurn21();
            await turn21Held;
          }
        }),
      };
      const initialEvents: AgentRuntimeEvent[] = [];
      const initialController = new AgentRuntimeController({
        runtime: initialRuntime,
        runner,
        eventSink: eventSink(initialEvents),
      });

      expect(
        initialController.submit('/target Preserve the verified Goal across compact and restart')
      ).toEqual({ type: 'started' });
      await turn21Started;
      expect(typedRequests).toHaveLength(21);
      const goalId = typedRequests[0].goal!.goalId;
      expect(typedRequests.map(request => request.goal!.goalId)).toEqual(
        Array.from({ length: 21 }, () => goalId)
      );
      expect(typedRequests.map(request => request.goal!.continuationIndex)).toEqual(
        Array.from({ length: 21 }, (_, index) => index + 1)
      );
      expect(typedRequests.map(request => request.goal!.revision)).toEqual(
        Array.from({ length: 21 }, (_, index) => index)
      );

      releaseTurn21();
      await initialController.waitForIdle();
      expect(initialController.submit('/target pause')).toEqual({ type: 'command_handled' });
      await flushImmediate();

      const coordinator = (initialController as any).goalCoordinator as GoalCoordinator;
      const originalObjective = coordinator.goal!.contract!.originalObjective;
      expect(coordinator.goal).toMatchObject({
        goalId,
        status: 'paused',
        continuationCount: 21,
        tokensUsed: 315,
      });
      const criteriaBeforeCompact = coordinator.goal!.contract!.successCriteria.map(criterion => ({
        id: criterion.id,
        status: criterion.status,
        evidenceRefs: [...criterion.evidenceRefs],
      }));
      const evidenceBeforeCompact = (coordinator.goal!.evidenceLedger ?? []).map(record => ({
        ...record,
      }));
      const auditBeforeCompact = coordinator.goal!.completionAudit;
      expect(criteriaBeforeCompact).toHaveLength(2);
      expect(evidenceBeforeCompact).toHaveLength(1);

      const history = Array.from({ length: 22 }, (_, index) => [
        { role: 'user' as const, content: `Turn ${index + 1} request` },
        { role: 'assistant' as const, content: `Turn ${index + 1} result` },
      ]).flat();
      appendSessionMessages(
        session.id,
        history.map((message, index) => ({ ...message, timestamp: Date.now() + index }))
      );
      const harness = createContextHarness({ cwd: projectDir, modelId: 'test-model' });
      harness.updateContractFromUserInput(originalObjective);
      updateSessionHarnessState(session.id, harness.toJSON());

      const compactStore = new Store({ config, tools: TOOLS, currentModel: 'test-model' });
      compactStore.setState({ conversationHistory: history, harnessState: harness.toJSON() });
      let compactSession: SessionMeta | null = session;
      const noNetworkLlm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn(() => {
          throw new Error('compact must not call the provider');
        }),
      };
      const compactRuntime: OrionCodeUiRuntime = {
        cwd: projectDir,
        version: 'test',
        config,
        store: compactStore,
        llm: noNetworkLlm as any,
        runtime: {} as OrionCodeUiRuntime['runtime'],
        isConfigured: true,
        ensureSession: jest.fn(() => compactSession!),
        getSession: jest.fn(() => compactSession),
        setSession: jest.fn(next => {
          compactSession = next;
        }),
        shutdown: jest.fn(),
      };
      const compactEvents: AgentRuntimeEvent[] = [];
      const compactController = new AgentChatController(
        compactRuntime,
        createUiEventSinkFromAgentRuntimeEvents(eventSink(compactEvents))
      );
      await compactController.runInput('/compact 2');
      expect(noNetworkLlm.chatStream).not.toHaveBeenCalled();
      expect(loadSessionCompactCheckpoint(session.id)).not.toBeNull();

      const afterCompact = new GoalCoordinator(projectDir, session.id);
      expect(afterCompact.load()).toBe(true);
      expect(afterCompact.goal).toMatchObject({
        goalId,
        status: 'paused',
        continuationCount: 21,
      });
      expect(afterCompact.goal?.contract?.originalObjective).toBe(originalObjective);
      expect(
        afterCompact.goal?.contract?.successCriteria.map(criterion => ({
          id: criterion.id,
          status: criterion.status,
          evidenceRefs: [...criterion.evidenceRefs],
        }))
      ).toEqual(criteriaBeforeCompact);
      expect(afterCompact.goal?.evidenceLedger).toEqual(evidenceBeforeCompact);
      expect(afterCompact.goal?.completionAudit).toEqual(auditBeforeCompact);
      expect(afterCompact.goal?.contract?.planSnapshot).toMatchObject({
        revision: 21,
        nextAction: 'Continue with verified step 11',
      });

      // Simulate a fresh process: new Store, runtime, controller, and no current session.
      const restartedStore = new Store({ config, tools: TOOLS, currentModel: 'test-model' });
      let restartedSession: SessionMeta | null = null;
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn(async () => ({
          content: 'Turn 22 resumed from the persisted Goal contract.',
          model: 'test-model',
          usage: { promptTokens: 10, completionTokens: 5 },
        })),
      };
      const restartedRuntime: OrionCodeUiRuntime = {
        cwd: projectDir,
        version: 'test',
        config,
        store: restartedStore,
        llm: llm as any,
        runtime: {} as OrionCodeUiRuntime['runtime'],
        isConfigured: true,
        ensureSession: jest.fn(() => {
          restartedSession ??= createSession(projectDir, 'test-model');
          return restartedSession;
        }),
        getSession: jest.fn(() => restartedSession),
        setSession: jest.fn(next => {
          restartedSession = next;
        }),
        shutdown: jest.fn(),
      };
      const restartEvents: AgentRuntimeEvent[] = [];
      const restartedController = new AgentRuntimeController({
        runtime: restartedRuntime,
        eventSink: eventSink(restartEvents),
      });

      expect(restartedController.submit(`/resume ${session.id}`)).toEqual({ type: 'started' });
      await restartedController.waitForIdle();
      expect(llm.chatStream).not.toHaveBeenCalled();
      expect(restartEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'goal_event',
            event: expect.objectContaining({
              type: 'goal_restored',
              goal: expect.objectContaining({ goalId, status: 'paused' }),
            }),
          }),
        ])
      );

      expect(restartedController.submit('/target resume')).toEqual({ type: 'started' });
      await restartedController.waitForIdle();
      restartedController.emitShutdownRequested('integration test stop after turn 22');
      await flushImmediate();

      expect(llm.chatStream).toHaveBeenCalledTimes(1);
      const restored = new GoalCoordinator(projectDir, session.id);
      expect(restored.load()).toBe(true);
      expect(restored.goal).toMatchObject({
        goalId,
        status: 'paused',
        continuationCount: 22,
        tokensUsed: 330,
      });
      expect(restored.goal?.contract?.originalObjective).toBe(originalObjective);
      expect(readSessionMessages(session.id).map(message => message.content)).not.toContain(
        'Continue pursuing the active goal from its persisted plan and evidence.'
      );
      expect(
        restartEvents.filter(
          event =>
            event.type === 'goal_event' &&
            event.event.type === 'goal_continuation' &&
            event.event.phase === 'started'
        )
      ).toHaveLength(1);
    } finally {
      if (previousConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
      else process.env.ORION_CODE_CONFIG_DIR = previousConfigDir;
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('rebinds Goal state when /resume switches between sessions', async () => {
    const previousConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    const root = mkdtempSync(join(tmpdir(), 'orion-goal-session-isolation-'));
    const projectDir = join(root, 'project');
    process.env.ORION_CODE_CONFIG_DIR = join(root, 'config');

    try {
      const config = loadConfig({ apiKey: 'test-key', model: 'test-model' });
      const sessionA = createSession(projectDir, 'test-model');
      const sessionB = createSession(projectDir, 'test-model');
      const goalA = new GoalCoordinator(projectDir, sessionA.id);
      const goalB = new GoalCoordinator(projectDir, sessionB.id);
      expect(goalA.create('Session A Goal').ok).toBe(true);
      expect(goalB.create('Session B Goal').ok).toBe(true);
      expect(goalA.pause()).toBe(true);
      expect(goalB.pause()).toBe(true);

      const store = new Store({ config, tools: TOOLS, currentModel: 'test-model' });
      let currentSession: SessionMeta | null = null;
      const runtime: OrionCodeUiRuntime = {
        cwd: projectDir,
        version: 'test',
        config,
        store,
        llm: {
          getModel: jest.fn(() => 'test-model'),
          chatStream: jest.fn(),
        } as any,
        runtime: {} as OrionCodeUiRuntime['runtime'],
        isConfigured: true,
        ensureSession: jest.fn(() => {
          currentSession ??= createSession(projectDir, 'test-model');
          return currentSession;
        }),
        getSession: jest.fn(() => currentSession),
        setSession: jest.fn(next => {
          currentSession = next;
        }),
        shutdown: jest.fn(),
      };
      const events: AgentRuntimeEvent[] = [];
      const controller = new AgentRuntimeController({ runtime, eventSink: eventSink(events) });

      expect(controller.submit(`/resume ${sessionA.id}`)).toEqual({ type: 'started' });
      await controller.waitForIdle();
      expect((controller as any).goalCoordinator.boundSessionId).toBe(sessionA.id);
      expect((controller as any).goalCoordinator.goal.objective).toBe('Session A Goal');

      expect(controller.submit(`/resume ${sessionB.id}`)).toEqual({ type: 'started' });
      await controller.waitForIdle();
      expect((controller as any).goalCoordinator.boundSessionId).toBe(sessionB.id);
      expect((controller as any).goalCoordinator.goal.objective).toBe('Session B Goal');
      expect(
        events
          .filter(event => event.type === 'goal_event' && event.event.type === 'goal_restored')
          .map(event =>
            event.type === 'goal_event' && event.event.type === 'goal_restored'
              ? event.event.goal.goalId
              : ''
          )
      ).toEqual([goalA.goal!.goalId, goalB.goal!.goalId]);
    } finally {
      if (previousConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
      else process.env.ORION_CODE_CONFIG_DIR = previousConfigDir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the restored project path for Goal state after cross-project /resume --all', async () => {
    const previousConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    const root = mkdtempSync(join(tmpdir(), 'orion-goal-cross-project-'));
    const currentProjectDir = join(root, 'current-project');
    const restoredProjectDir = join(root, 'restored-project');
    process.env.ORION_CODE_CONFIG_DIR = join(root, 'config');

    try {
      const config = loadConfig({ apiKey: 'test-key', model: 'test-model' });
      const currentSession = createSession(currentProjectDir, 'test-model');
      const restoredSession = createSession(restoredProjectDir, 'test-model');
      const restoredGoal = new GoalCoordinator(restoredProjectDir, restoredSession.id);
      expect(restoredGoal.create('Cross-project Goal').ok).toBe(true);
      expect(restoredGoal.pause()).toBe(true);

      const store = new Store({ config, tools: TOOLS, currentModel: 'test-model' });
      let activeSession: SessionMeta | null = currentSession;
      const runtime: OrionCodeUiRuntime = {
        cwd: currentProjectDir,
        version: 'test',
        config,
        store,
        llm: null,
        runtime: {} as OrionCodeUiRuntime['runtime'],
        isConfigured: true,
        ensureSession: jest.fn(() => activeSession ?? currentSession),
        getSession: jest.fn(() => activeSession),
        setSession: jest.fn(next => {
          activeSession = next;
        }),
        shutdown: jest.fn(),
      };
      const events: AgentRuntimeEvent[] = [];
      const controller = new AgentRuntimeController({ runtime, eventSink: eventSink(events) });

      expect(controller.submit(`/resume ${restoredSession.id} --all`)).toEqual({ type: 'started' });
      await controller.waitForIdle();

      expect(activeSession?.id).toBe(restoredSession.id);
      expect((controller as any).goalCoordinator.boundSessionId).toBe(restoredSession.id);
      expect((controller as any).goalCoordinator.goal.objective).toBe('Cross-project Goal');

      expect(controller.submit('/target edit Cross-project Goal updated')).toEqual({
        type: 'command_handled',
      });
      const persistedInRestoredProject = new GoalCoordinator(
        restoredProjectDir,
        restoredSession.id
      );
      expect(persistedInRestoredProject.load()).toBe(true);
      expect(persistedInRestoredProject.goal?.objective).toBe('Cross-project Goal updated');

      const incorrectlyPersistedInCurrentProject = new GoalCoordinator(
        currentProjectDir,
        restoredSession.id
      );
      expect(incorrectlyPersistedInCurrentProject.load()).toBe(false);
    } finally {
      if (previousConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
      else process.env.ORION_CODE_CONFIG_DIR = previousConfigDir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('invalidates a queued continuation when a different session is restored', async () => {
    const previousConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    const root = mkdtempSync(join(tmpdir(), 'orion-goal-resume-race-'));
    const firstProjectDir = join(root, 'first-project');
    const restoredProjectDir = join(root, 'restored-project');
    process.env.ORION_CODE_CONFIG_DIR = join(root, 'config');

    try {
      const config = loadConfig({ apiKey: 'test-key', model: 'test-model' });
      const firstSession = createSession(firstProjectDir, 'test-model');
      const restoredSession = createSession(restoredProjectDir, 'test-model');
      const firstGoal = new GoalCoordinator(firstProjectDir, firstSession.id);
      const restoredGoal = new GoalCoordinator(restoredProjectDir, restoredSession.id);
      expect(firstGoal.create('Do not ghost continue').ok).toBe(true);
      expect(restoredGoal.create('Restored Goal').ok).toBe(true);
      expect(restoredGoal.pause()).toBe(true);

      const store = new Store({ config, tools: TOOLS, currentModel: 'test-model' });
      let activeSession: SessionMeta | null = firstSession;
      const runtime: OrionCodeUiRuntime = {
        cwd: firstProjectDir,
        version: 'test',
        config,
        store,
        llm: null,
        runtime: {} as OrionCodeUiRuntime['runtime'],
        isConfigured: true,
        ensureSession: jest.fn(() => activeSession ?? firstSession),
        getSession: jest.fn(() => activeSession),
        setSession: jest.fn(next => {
          activeSession = next;
        }),
        shutdown: jest.fn(),
      };
      const events: AgentRuntimeEvent[] = [];
      const runner: AgentRuntimeRunner = {
        runInput: jest.fn(async () => undefined),
        runRequest: jest.fn(async () => undefined),
      };
      const controller = new AgentRuntimeController({
        runtime,
        runner,
        eventSink: eventSink(events),
      });
      controller.setGoalCoordinator(firstGoal);

      (controller as any).scheduleGoalContinuation();
      activeSession = restoredSession;
      (controller as any).eventSink.emit({
        type: 'session_restored',
        event: {
          sessionId: restoredSession.id,
          projectPath: restoredProjectDir,
          model: 'test-model',
          restoredMessages: 0,
        },
      });
      await flushImmediate();

      expect(runner.runRequest).not.toHaveBeenCalled();
      expect((controller as any).goalCoordinator.boundSessionId).toBe(restoredSession.id);
      expect((controller as any).goalCoordinator.goal.objective).toBe('Restored Goal');
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'goal_event',
            event: expect.objectContaining({
              type: 'goal_continuation',
              goalId: firstGoal.goal?.goalId,
              phase: 'deferred',
              reason: 'scheduled continuation was invalidated',
            }),
          }),
        ])
      );
    } finally {
      if (previousConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
      else process.env.ORION_CODE_CONFIG_DIR = previousConfigDir;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
