import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Store } from '../src/framework/store';
import { createContextHarness } from '../src/harness';
import {
  AgentRuntimeController,
  type AgentRuntimeRunner,
} from '../src/runtime/agent-runtime-controller';
import type {
  AgentRuntimeEvent,
  AgentRuntimeEventSink,
} from '../src/runtime/agent-runtime-protocol';
import { createUiEventSinkFromAgentRuntimeEvents } from '../src/runtime/agent-runtime-protocol';
import { AgentChatController } from '../src/runtime/chat-controller';
import { GoalCoordinator } from '../src/runtime/goals/coordinator';
import {
  currentGoalToolContext,
  updateGoalPlanTool,
  updateGoalTool,
} from '../src/runtime/goals/tools';
import type { AgentTurnRequest } from '../src/runtime/goals/types';
import type { OrionCodeUiRuntime } from '../src/runtime/ui-events';
import { loadConfig } from '../src/services/config';
import {
  appendSessionMessages,
  createSession,
  loadSessionCompactCheckpoint,
  readSessionTraceEvents,
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

function deferredSignal(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function recordCompletedLoop(store: Store): void {
  store.setState({
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
}

function emitVerification(
  controller: AgentRuntimeController,
  input: {
    callId: string;
    criterionId: string;
    criterionStatement: string;
    success: boolean;
    sequence: number;
  }
): string {
  const context = currentGoalToolContext();
  expect(context).toBeDefined();
  const before = context!.evidenceRecords.length;
  (controller as unknown as { eventSink: AgentRuntimeEventSink }).eventSink.emit({
    type: 'tool_finished',
    event: {
      callId: input.callId,
      name: 'exec_command',
      args: { command: `jest ${input.callId}` },
      success: input.success,
      duration: 1,
      summary: `${input.criterionId} ${input.criterionStatement} ${
        input.success ? 'passed' : 'failed'
      } ${input.callId}`,
      sequence: input.sequence,
    },
  });
  expect(context!.evidenceRecords).toHaveLength(before + 1);
  return context!.evidenceRecords[before].id;
}

async function flushImmediate(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

async function waitForSignal(
  signal: Promise<void>,
  label: string,
  diagnostics?: () => string
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`Timed out waiting for ${label}${diagnostics ? ` (${diagnostics()})` : ''}`)
            ),
          15_000
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForCondition(
  condition: () => boolean,
  label: string,
  diagnostics?: () => string
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}${diagnostics ? ` (${diagnostics()})` : ''}`);
    }
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
}

describe('Goal combined long-session regression', () => {
  it('survives 20+ turns, compact, restart/resume, steering, denial, repair, and reverify', async () => {
    const previousConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    const root = mkdtempSync(join(tmpdir(), 'orion-goal-combined-'));
    const projectDir = join(root, 'project');
    const fixPath = join(projectDir, 'goal-artifact.txt');
    process.env.ORION_CODE_CONFIG_DIR = join(root, 'config');
    mkdirSync(projectDir, { recursive: true });
    execFileSync('git', ['init', '--quiet', projectDir]);

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

      const permissionStarted = deferredSignal();
      const steeringStarted = deferredSignal();
      const steeringRelease = deferredSignal();
      const turn21Started = deferredSignal();
      const turn21Release = deferredSignal();
      const typedRequests: AgentTurnRequest[] = [];
      let permissionResult: boolean | undefined;
      let steeringTriggered = false;
      let initialController!: AgentRuntimeController;
      let verificationSequence = 0;

      const initialRunner: AgentRuntimeRunner = {
        runInput: jest.fn(async () => undefined),
        runRequest: jest.fn(async (request, options) => {
          typedRequests.push(request);
          const context = currentGoalToolContext();
          expect(context).toBeDefined();
          const goal = context!.coordinator.goal!;
          const completedTurns = goal.continuationCount;
          recordCompletedLoop(initialStore);

          if (completedTurns === 7 && !steeringTriggered) {
            steeringTriggered = true;
            steeringStarted.resolve();
            await steeringRelease.promise;
            expect(options?.abortSignal?.aborted).toBe(true);
            return;
          }

          if (completedTurns === 0) {
            const pending = initialController.requestToolPermission({
              name: 'exec_command',
              args: { command: 'jest guarded-check' },
              reason: 'combined regression permission gate',
              abortSignal: options?.abortSignal,
            });
            permissionStarted.resolve();
            permissionResult = await pending;
          }

          const plan = await updateGoalPlanTool.execute(
            {
              phase: 'long-session',
              steps: [
                {
                  description: `Complete checkpoint ${completedTurns + 1}`,
                  done: true,
                },
              ],
              next_action: `Continue to checkpoint ${completedTurns + 2}`,
              derived_criteria: [],
            },
            { cwd: projectDir, config }
          );
          expect(plan.success).toBe(true);
          emitVerification(initialController, {
            callId: `checkpoint-${completedTurns + 1}`,
            criterionId: goal.contract!.successCriteria[0].id,
            criterionStatement: goal.contract!.successCriteria[0].statement,
            success: true,
            sequence: ++verificationSequence,
          });

          if (completedTurns === 20) {
            turn21Started.resolve();
            await turn21Release.promise;
          }
        }),
      };
      const initialEvents: AgentRuntimeEvent[] = [];
      initialController = new AgentRuntimeController({
        runtime: initialRuntime,
        runner: initialRunner,
        eventSink: eventSink(initialEvents),
      });

      expect(
        initialController.submit('/target Complete the combined long session artifact verification')
      ).toEqual({ type: 'started' });

      await waitForSignal(permissionStarted.promise, 'permission request');
      const permissionRequest = initialEvents.find(
        (event): event is Extract<AgentRuntimeEvent, { type: 'permission_requested' }> =>
          event.type === 'permission_requested'
      );
      expect(permissionRequest).toBeDefined();
      expect(
        initialController.handle({
          type: 'permission_decision',
          requestId: permissionRequest!.request.id,
          approved: false,
        })
      ).toEqual({ type: 'permission_decision_recorded' });

      const activeCoordinator = () =>
        (initialController as unknown as { goalCoordinator: GoalCoordinator }).goalCoordinator;
      const goalDiagnostics = () =>
        `requests=${typedRequests.length}, goal=${JSON.stringify(activeCoordinator().goal)}`;
      await waitForCondition(
        () =>
          activeCoordinator().goal?.status === 'paused' &&
          activeCoordinator().goal?.continuationCount === 5,
        'first autonomy checkpoint',
        goalDiagnostics
      );
      expect(activeCoordinator().goal?.stopReason?.message).toContain('/goal resume');
      expect(initialController.submit('/target resume')).toEqual({ type: 'started' });

      await waitForSignal(steeringStarted.promise, 'live steering turn', goalDiagnostics);
      expect(initialController.submit('Preserve the repaired artifact across restart')).toEqual({
        type: 'revision_requested',
      });
      steeringRelease.resolve();

      let lastReviewCount = 5;
      for (let review = 0; review < 2; review += 1) {
        await waitForCondition(
          () =>
            activeCoordinator().goal?.status === 'paused' &&
            (activeCoordinator().goal?.continuationCount ?? 0) > lastReviewCount,
          `autonomy checkpoint after steering ${review + 1}`,
          goalDiagnostics
        );
        lastReviewCount = activeCoordinator().goal!.continuationCount;
        expect(activeCoordinator().goal?.stopReason?.message).toContain('/goal resume');
        expect(initialController.submit('/target resume')).toEqual({ type: 'started' });
      }

      await waitForSignal(turn21Started.promise, 'Goal turn 21');
      expect(permissionResult).toBe(false);
      expect(typedRequests).toHaveLength(21);
      expect(typedRequests.filter(request => request.inputKind === 'revision')).toHaveLength(1);
      expect(
        typedRequests.every(request => request.goal?.goalId === typedRequests[0].goal?.goalId)
      ).toBe(true);

      turn21Release.resolve();
      await initialController.waitForIdle();
      expect(initialController.submit('/target pause')).toEqual({ type: 'command_handled' });
      await flushImmediate();

      const initialCoordinator = (
        initialController as unknown as { goalCoordinator: GoalCoordinator }
      ).goalCoordinator;
      const goalId = initialCoordinator.goal!.goalId;
      expect(initialCoordinator.goal).toMatchObject({
        goalId,
        status: 'paused',
        continuationCount: 21,
      });
      expect(initialCoordinator.goal!.contract!.constraints).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            statement: 'Preserve the repaired artifact across restart',
            source: 'user',
          }),
        ])
      );

      const history = Array.from({ length: 24 }, (_, index) => [
        { role: 'user' as const, content: `Combined turn ${index + 1} request` },
        { role: 'assistant' as const, content: `Combined turn ${index + 1} result` },
      ]).flat();
      appendSessionMessages(
        session.id,
        history.map((message, index) => ({ ...message, timestamp: Date.now() + index }))
      );
      const harness = createContextHarness({ cwd: projectDir, modelId: 'test-model' });
      harness.updateContractFromUserInput(initialCoordinator.goal!.contract!.originalObjective);
      updateSessionHarnessState(session.id, harness.toJSON());

      const compactStore = new Store({ config, tools: TOOLS, currentModel: 'test-model' });
      compactStore.setState({ conversationHistory: history, harnessState: harness.toJSON() });
      let compactSession: SessionMeta | null = session;
      const noNetworkCompactLlm = {
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
        llm: noNetworkCompactLlm as any,
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
      expect(noNetworkCompactLlm.chatStream).not.toHaveBeenCalled();
      expect(loadSessionCompactCheckpoint(session.id)).not.toBeNull();

      const compactedGoal = new GoalCoordinator(projectDir, session.id);
      expect(compactedGoal.load()).toBe(true);
      expect(compactedGoal.goal).toMatchObject({
        goalId,
        status: 'paused',
        continuationCount: 21,
      });

      // Process-like restart: entirely new Store, runtime, and runtime controller.
      const restartedStore = new Store({ config, tools: TOOLS, currentModel: 'test-model' });
      let restartedSession: SessionMeta | null = null;
      const noNetworkRestartLlm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn(() => {
          throw new Error('scripted resumed Goal turns must not call the provider');
        }),
      };
      const restartedRuntime: OrionCodeUiRuntime = {
        cwd: projectDir,
        version: 'test',
        config,
        store: restartedStore,
        llm: noNetworkRestartLlm as any,
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
      const restartedEvents: AgentRuntimeEvent[] = [];
      const restartedController = new AgentRuntimeController({
        runtime: restartedRuntime,
        eventSink: eventSink(restartedEvents),
      });

      expect(restartedController.submit(`/resume ${session.id}`)).toEqual({ type: 'started' });
      await restartedController.waitForIdle();
      expect(noNetworkRestartLlm.chatStream).not.toHaveBeenCalled();
      expect(restartedEvents).toEqual(
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

      const resumedRunner = (restartedController as unknown as { runner: AgentChatController })
        .runner;
      const resumedPhases: string[] = [];
      let failedEvidenceId = '';
      let finalEvidenceId = '';
      jest.spyOn(resumedRunner, 'runRequest').mockImplementation(async request => {
        const context = currentGoalToolContext();
        expect(context).toBeDefined();
        const goal = context!.coordinator.goal!;
        const completedTurns = goal.continuationCount;
        const criterion = goal.contract!.successCriteria[0];
        recordCompletedLoop(restartedStore);

        if (completedTurns === 21) {
          resumedPhases.push('failed-verification');
          const plan = await updateGoalPlanTool.execute(
            {
              phase: 'verification-failed',
              steps: [{ description: 'Create the missing goal artifact', done: false }],
              next_action: 'Repair the workspace, then rerun verification',
              derived_criteria: [],
            },
            { cwd: projectDir, config }
          );
          expect(plan.success).toBe(true);
          expect(existsSync(fixPath)).toBe(false);
          failedEvidenceId = emitVerification(restartedController, {
            callId: 'goal-artifact-before-fix',
            criterionId: criterion.id,
            criterionStatement: criterion.statement,
            success: false,
            sequence: ++verificationSequence,
          });
          const completion = await updateGoalTool.execute(
            {
              status: 'complete',
              criterion_evidence: [
                { criterion_id: criterion.id, evidence_ids: [failedEvidenceId] },
              ],
            },
            { cwd: projectDir, config }
          );
          expect(completion.success).toBe(true);
          return;
        }

        if (completedTurns === 22) {
          resumedPhases.push('workspace-plan-fix');
          writeFileSync(fixPath, 'repaired\n', 'utf8');
          const plan = await updateGoalPlanTool.execute(
            {
              phase: 'remediation',
              steps: [{ description: 'Create the missing goal artifact', done: true }],
              next_action: 'Rerun criterion-specific verification',
              derived_criteria: [],
            },
            { cwd: projectDir, config }
          );
          expect(plan.success).toBe(true);
          return;
        }

        expect(completedTurns).toBe(23);
        resumedPhases.push('reverified');
        expect(readFileSync(fixPath, 'utf8')).toBe('repaired\n');
        finalEvidenceId = emitVerification(restartedController, {
          callId: 'goal-artifact-after-fix',
          criterionId: criterion.id,
          criterionStatement: criterion.statement,
          success: true,
          sequence: ++verificationSequence,
        });
        const completion = await updateGoalTool.execute(
          {
            status: 'complete',
            criterion_evidence: [{ criterion_id: criterion.id, evidence_ids: [finalEvidenceId] }],
          },
          { cwd: projectDir, config }
        );
        expect(completion.success).toBe(true);
      });

      expect(restartedController.submit('/target resume')).toEqual({ type: 'started' });
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await restartedController.waitForIdle();
        await flushImmediate();
        const coordinator = (restartedController as unknown as { goalCoordinator: GoalCoordinator })
          .goalCoordinator;
        if (coordinator.goal?.status === 'complete') break;
      }

      const completedCoordinator = (
        restartedController as unknown as { goalCoordinator: GoalCoordinator }
      ).goalCoordinator;
      expect(resumedPhases).toEqual(['failed-verification', 'workspace-plan-fix', 'reverified']);
      expect(restartedEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'goal_event',
            event: expect.objectContaining({ type: 'goal_audit_failed', audit: 'completion' }),
          }),
          expect.objectContaining({
            type: 'goal_event',
            event: expect.objectContaining({ type: 'goal_plan_updated', phase: 'remediation' }),
          }),
          expect.objectContaining({
            type: 'goal_event',
            event: expect.objectContaining({ type: 'goal_completed' }),
          }),
        ])
      );
      expect(completedCoordinator.goal).toMatchObject({
        goalId,
        status: 'complete',
        continuationCount: 24,
      });
      expect(completedCoordinator.goal!.completionAudit).toMatchObject({
        passed: true,
        remainingRequirements: [],
        finalSummary: {
          stopReason: 'completed',
          remainingRequirements: [],
          accounting: {
            continuationCount: 24,
            usageComplete: true,
          },
        },
      });
      expect(completedCoordinator.goal!.completionAudit!.evidenceRefs).toContain(finalEvidenceId);
      expect(completedCoordinator.goal!.completionAudit!.evidenceRefs).not.toContain(
        failedEvidenceId
      );

      // A final fresh coordinator proves terminal state and its receipt came from the sidecar.
      const recoveredFromSidecar = new GoalCoordinator(projectDir, session.id);
      expect(recoveredFromSidecar.load()).toBe(true);
      expect(recoveredFromSidecar.goal).toEqual(completedCoordinator.goal);
      expect(recoveredFromSidecar.goal!.completionAudit!.finalSummary).toMatchObject({
        originalObjective: 'Complete the combined long session artifact verification',
        stopReason: 'completed',
        evidenceRefs: [finalEvidenceId],
        accounting: { continuationCount: 24, usageComplete: true },
      });

      const persistedTrace = readSessionTraceEvents(session.id);
      const goalTrace = persistedTrace.filter(
        event => event.type === 'goal_state' && event.goalId === goalId
      );
      expect(goalTrace).toHaveLength(24);
      expect(goalTrace.some(event => event.goalInputKind === 'revision')).toBe(true);
      expect(goalTrace.at(-1)).toMatchObject({
        type: 'goal_state',
        goalId,
        goalInputKind: 'goal_continuation',
        goalStopReason: 'completed',
        note: expect.stringContaining('status=complete'),
      });
    } finally {
      if (previousConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
      else process.env.ORION_CODE_CONFIG_DIR = previousConfigDir;
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
