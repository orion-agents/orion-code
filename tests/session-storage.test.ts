import {
  createSession,
  saveSessionMeta,
  loadSessionMeta,
  markSessionTranscriptDisplayStart,
  updateSessionStats,
  updateSessionSkills,
  endSession,
  appendHistory,
  readHistory,
  readProjectHistory,
  appendSessionMessage,
  appendSessionMessages,
  readSessionMessages,
  loadSessionHistory,
  loadSessionCompactCheckpoint,
  loadSessionTranscriptMessages,
  commitSessionCompactCheckpoint,
  prepareSessionCompactSourceReceipt,
  advanceSessionCompactSourceReceipt,
  deleteSession,
  updateSessionSummary,
  truncateSessionToLastComplete,
  countSessionsByProject,
  listSessions,
  listProjectSessions,
  findSession,
  lookupSessionRef,
  renameSession,
  getLastSession,
  resumeSession,
  resolveProjectPath,
  updateSessionHarnessState,
  loadSessionHarnessState,
  updateSessionGoalBinding,
  clearSessionGoalBinding,
  restoreSessionGoalBinding,
  appendSessionTraceEvent,
  readSessionTraceEvents,
  type SessionMeta,
  type HistoryEntry,
  type SessionMessage,
  type CommitCompactCheckpointInput,
} from '../src/services/session-storage';
import { spawnSync } from 'child_process';
import { loadSessionIndex, saveSessionIndex, searchSessions } from '../src/services/session-index';
import { createContextHarness } from '../src/harness';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getProjectSessionCompactPath,
  getProjectSessionHarnessPath,
  getProjectSessionMessagesPath,
  getProjectSessionMetaPath,
  getProjectSessionTracePath,
  getProjectSessionsDir,
} from '../src/services/config-dir';
import { createGoal, loadGoal, saveGoal } from '../src/services/goal-storage';
import { createContextUsageSnapshot } from '../src/services/model-context';
import * as atomicWrite from '../src/services/atomic-write';
import { canonicalMessagesFingerprint } from '../src/services/compact/fingerprint';
import { estimateMessagesTokens } from '../src/utils/token-estimate';
import type { HarnessState } from '../src/harness';

describe('session-storage', () => {
  const testDir = mkdtempSync(join(tmpdir(), 'orion-session-storage-'));
  const originalEnv = process.env.ORION_CODE_CONFIG_DIR;

  beforeAll(() => {
    process.env.ORION_CODE_CONFIG_DIR = testDir;
    // Clean up test directory if it exists
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  afterAll(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    // Restore original env var
    if (originalEnv !== undefined) {
      process.env.ORION_CODE_CONFIG_DIR = originalEnv;
    } else {
      delete process.env.ORION_CODE_CONFIG_DIR;
    }
  });

  describe('createSession', () => {
    test('creates session with correct fields', () => {
      const session = createSession('/tmp/project', 'gpt-4o');

      expect(session.id).toBeDefined();
      expect(session.projectPath).toBe('/tmp/project');
      expect(session.model).toBe('gpt-4o');
      expect(session.startTime).toBeDefined();
      expect(session.startTime).toBeLessThanOrEqual(Date.now());
      expect(session.tokenCount).toBe(0);
      expect(session.cost).toBe(0);
      expect(session.endTime).toBeUndefined();
    });

    test('clears only the expected completed Goal binding', () => {
      const session = createSession('/tmp/project-goal-binding', 'gpt-4o');
      updateSessionGoalBinding(session.id, {
        goalId: 'goal-current',
        objective: 'Finish the current Goal',
      });

      expect(() => clearSessionGoalBinding(session.id, 'goal-stale')).toThrow(
        'refusing to clear the newer Goal'
      );
      expect(loadSessionMeta(session.id)).toMatchObject({ activeGoalId: 'goal-current' });

      clearSessionGoalBinding(session.id, 'goal-current');
      expect(loadSessionMeta(session.id)?.activeGoalId).toBeUndefined();
      expect(loadSessionMeta(session.id)?.activeGoalObjective).toBeUndefined();
    });

    test('restores a just-cleared Goal binding without overwriting newer session state', () => {
      const session = createSession('/tmp/project-goal-binding-rollback', 'gpt-4o');
      const goal = { goalId: 'goal-rollback', objective: 'Preserve rollback authority' };
      updateSessionGoalBinding(session.id, goal);
      const cleared = clearSessionGoalBinding(session.id, goal.goalId)!;

      expect(
        restoreSessionGoalBinding(session.id, goal, cleared.updatedAt ?? 0)?.activeGoalId
      ).toBe(goal.goalId);

      const clearedAgain = clearSessionGoalBinding(session.id, goal.goalId)!;
      updateSessionGoalBinding(session.id, {
        goalId: 'goal-newer',
        objective: 'Newer lifecycle owns the session',
      });
      expect(() =>
        restoreSessionGoalBinding(session.id, goal, clearedAgain.updatedAt ?? 0)
      ).toThrow('refusing to overwrite the newer Goal');
      expect(loadSessionMeta(session.id)?.activeGoalId).toBe('goal-newer');

      clearSessionGoalBinding(session.id, 'goal-newer');
      expect(() => restoreSessionGoalBinding(session.id, goal, -1)).toThrow(
        'refusing to overwrite newer session state'
      );
    });

    test('stores session meta in the project scope only', () => {
      const session = createSession('/tmp/project2', 'claude-sonnet');

      expect(session.projectKey).toBeDefined();
      expect(existsSync(getProjectSessionMetaPath(session.projectPath, session.id))).toBe(true);
      expect(existsSync(join(testDir, 'sessions', `${session.id}.json`))).toBe(false);
    });
  });

  describe('Goal trace compatibility', () => {
    test('round-trips additive Goal correlation and redacts the stop reason', () => {
      const session = createSession('/tmp/project-goal-trace', 'gpt-4o');
      appendSessionTraceEvent(session.id, {
        turnId: 'goal-turn-1',
        type: 'goal_state',
        goalId: 'goal-1',
        goalRevision: 7,
        goalInputKind: 'goal_continuation',
        goalStopReason: 'provider failed with sk-secret1234567890',
      });

      expect(readSessionTraceEvents(session.id)).toEqual([
        expect.objectContaining({
          turnId: 'goal-turn-1',
          type: 'goal_state',
          goalId: 'goal-1',
          goalRevision: 7,
          goalInputKind: 'goal_continuation',
          goalStopReason: expect.stringContaining('[REDACTED'),
        }),
      ]);
      expect(JSON.stringify(readSessionTraceEvents(session.id))).not.toContain(
        'sk-secret1234567890'
      );
    });

    test('keeps legacy trace rows without Goal fields readable', () => {
      const session = createSession('/tmp/project-legacy-trace', 'gpt-4o');
      appendSessionTraceEvent(session.id, {
        turnId: 'legacy-turn',
        type: 'message',
        note: 'legacy row',
      });

      expect(readSessionTraceEvents(session.id)).toEqual([
        expect.objectContaining({ turnId: 'legacy-turn', type: 'message', note: 'legacy row' }),
      ]);
      expect(readSessionTraceEvents(session.id)[0].goalId).toBeUndefined();
    });

    test('round-trips typed stop decisions and redacts their nested text', () => {
      const session = createSession('/tmp/project-stop-decision-trace', 'gpt-4o');
      const secret = 'sk-stopdecision1234567890';
      appendSessionTraceEvent(session.id, {
        turnId: 'stop-turn',
        type: 'complete',
        finishReason: 'budget_exceeded',
        stopDecision: {
          schemaVersion: 1,
          scope: 'request',
          status: 'stopped',
          disposition: 'resume_allowed',
          reason: { code: 'resource_budget', message: `budget ${secret}` },
          evidence: [{ kind: 'resource_limit', source: 'query', detail: `limit ${secret}` }],
          nextActions: [
            { kind: 'resume', label: `resume ${secret}`, command: `/resume ${secret}` },
          ],
          resources: { llmRequests: { used: 24, limit: 24 } },
          criterionStates: [{ id: `criterion:${secret}`, status: 'pending' }],
          evidenceRefs: [`ledger:${secret}`],
          progressDelta: {
            schemaVersion: 1,
            changed: true,
            criterionChanges: [{ id: `criterion:${secret}`, to: 'pending' }],
            newEvidenceRefs: [`ledger:${secret}`],
            newChangedFiles: [`src/${secret}.ts`],
            newDecisions: [`decision ${secret}`],
            newBlockers: [`blocker ${secret}`],
            newDiagnostics: [`diagnostic ${secret}`],
            workspaceStateHash: 'hash',
            repeatedSignatureCount: 0,
            recordedAt: 1,
          },
        },
      });

      const [trace] = readSessionTraceEvents(session.id);
      expect(trace.stopDecision).toMatchObject({
        schemaVersion: 1,
        scope: 'request',
        status: 'stopped',
        disposition: 'resume_allowed',
        resources: { llmRequests: { used: 24, limit: 24 } },
      });
      expect(JSON.stringify(trace)).not.toContain(secret);
      expect(JSON.stringify(trace.stopDecision)).toContain('[REDACTED');
    });

    test('serializes trace deletion and prevents a stale append from recreating it', () => {
      const session = createSession('/tmp/project-delete-trace', 'gpt-4o');
      const tracePath = getProjectSessionTracePath(session.projectPath, session.id);
      appendSessionTraceEvent(session.id, {
        turnId: 'before-delete',
        type: 'message',
        note: 'present before delete',
      });
      expect(existsSync(tracePath)).toBe(true);

      expect(deleteSession(session.id)).toBe(true);
      expect(existsSync(tracePath)).toBe(false);
      expect(
        appendSessionTraceEvent(session.id, {
          turnId: 'stale-writer',
          type: 'message',
          note: 'must not reappear',
        })
      ).toBeNull();
      expect(existsSync(tracePath)).toBe(false);
      expect(readSessionTraceEvents(session.id)).toEqual([]);
    });
  });

  describe('loadSessionMeta', () => {
    test('returns null for non-existent session', () => {
      const session = loadSessionMeta('non-existent-id');
      expect(session).toBeNull();
    });

    test('loads existing session', () => {
      const created = createSession('/tmp/project', 'gpt-4o');
      const loaded = loadSessionMeta(created.id);

      expect(loaded?.id).toBe(created.id);
      expect(loaded?.projectPath).toBe(created.projectPath);
      expect(loaded?.model).toBe(created.model);
    });
  });

  describe('compact checkpoints', () => {
    const usage = (usedTokens: number) =>
      createContextUsageSnapshot({
        modelId: 'gpt-4o',
        usedTokens,
        outputReserveTokens: 4096,
      });

    const semanticFixture = (taskEpoch: number = 7) => {
      const evictedMessages = [{ role: 'user' as const, content: 'old source fact' }];
      const group = {
        id: canonicalMessagesFingerprint(evictedMessages),
        startIndex: 0,
        endIndex: 1,
        messages: evictedMessages,
        estimatedTokens: estimateMessagesTokens(evictedMessages),
      };
      const semanticSummary = {
        version: 1 as const,
        taskEpoch,
        objective: 'ship safely',
        latestUserInstruction: 'preserve the build criterion',
        constraints: [],
        decisions: [],
        completed: [],
        pending: [],
        blockers: [],
        files: [],
        verification: [],
        toolOutcomes: [],
        evidenceRefs: ['e-build'],
        items: [
          {
            id: `ctx-${group.id.slice(0, 20)}`,
            groupId: group.id,
            kind: 'turn' as const,
            priority: 'high' as const,
            sourceRefs: [`group:${group.id}`],
            tokenEstimate: group.estimatedTokens,
            taskEpoch,
            expires: 'task' as const,
            text: 'old source fact',
            sourceRole: 'user' as const,
            messageIndexes: { start: 0, end: 1 },
          },
        ],
        criterionStates: [
          {
            id: 'criterion:build',
            statement: 'build passes',
            status: 'passed' as const,
            evidenceRefs: ['e-build'],
          },
        ],
        sourceBoundary: {
          firstGroupId: group.id,
          lastGroupId: group.id,
          groupCount: 1,
          messageCount: 1,
        },
        coverage: { groupIds: [group.id], groupCount: 1, messageCount: 1 },
      };
      const modelHistory = [{ role: 'user' as const, content: '[Context Summary]\ntrusted' }];
      const candidate: NonNullable<CommitCompactCheckpointInput['candidate']> = {
        fingerprint: canonicalMessagesFingerprint(modelHistory),
        beforeTokens: group.estimatedTokens,
        afterTokens: estimateMessagesTokens(modelHistory),
        plan: {
          groups: [group],
          evictedGroups: [group],
          recentGroups: [],
          recentStartIndex: 1,
          targetRatio: 0.65,
          targetTokens: 1000,
          tailTokenBudget: 800,
          fixedTokens: 0,
          summaryReserveTokens: 200,
        },
        semanticSummary,
        diagnostics: [],
      };
      const harnessState: HarnessState = {
        version: 2,
        ledger: [
          {
            id: 'e-build',
            type: 'verification',
            content: 'npm run build passed',
            source: { kind: 'test', ref: 'npm run build' },
            importance: 5,
            ttl: 'task',
            createdAt: 1,
          },
        ],
        taskEpoch,
        contract: {
          version: 3,
          id: 'contract-build',
          objective: 'ship safely',
          userIntent: 'preserve the build criterion',
          requirements: [],
          successCriteria: ['build passes'],
          criteria: [
            {
              id: 'criterion:build',
              statement: 'build passes',
              status: 'passed',
              evidenceRefs: ['e-build'],
            },
          ],
          taskEpoch,
          constraints: [],
          prohibitions: [],
          allowedScope: { cwd: '/tmp/project-semantic-receipt' },
          createdAt: 1,
          updatedAt: 1,
        },
        updatedAt: 1,
      };
      return { candidate, harnessState, modelHistory };
    };

    test('rejects a prepared candidate when the transcript or active checkpoint changes', () => {
      const session = createSession('/tmp/project-compact-source-cas', 'gpt-4o');
      appendSessionMessage(session.id, { role: 'user', content: 'source', timestamp: 1 });
      const staleTranscript = prepareSessionCompactSourceReceipt(session.id);
      appendSessionMessage(session.id, { role: 'assistant', content: 'concurrent', timestamp: 2 });

      expect(() =>
        commitSessionCompactCheckpoint({
          sessionId: session.id,
          mode: 'manual',
          modelId: 'gpt-4o',
          sourceMessageCount: staleTranscript.sourceMessageCount,
          transcriptStartMessageIndex: 0,
          modelHistory: [{ role: 'user', content: 'must not commit' }],
          summary: { text: 'stale', generatedAt: 3, source: 'heuristic' },
          beforeUsage: usage(1000),
          afterUsage: usage(500),
          prepareSource: staleTranscript,
        })
      ).toThrow('source message count changed');

      const current = prepareSessionCompactSourceReceipt(session.id);
      const stable = commitSessionCompactCheckpoint({
        sessionId: session.id,
        mode: 'manual',
        modelId: 'gpt-4o',
        sourceMessageCount: current.sourceMessageCount,
        transcriptStartMessageIndex: 0,
        modelHistory: [{ role: 'user', content: 'stable' }],
        summary: { text: 'stable', generatedAt: 4, source: 'heuristic' },
        beforeUsage: usage(1000),
        afterUsage: usage(500),
        prepareSource: current,
      });
      expect(stable.validation.prepareSourceVerified).toBe(true);

      expect(() =>
        commitSessionCompactCheckpoint({
          sessionId: session.id,
          mode: 'manual',
          modelId: 'gpt-4o',
          sourceMessageCount: current.sourceMessageCount,
          transcriptStartMessageIndex: 0,
          modelHistory: [{ role: 'user', content: 'stale pointer' }],
          summary: { text: 'stale pointer', generatedAt: 5, source: 'heuristic' },
          beforeUsage: usage(1000),
          afterUsage: usage(500),
          prepareSource: current,
        })
      ).toThrow('active checkpoint changed');
      expect(loadSessionCompactCheckpoint(session.id)?.checkpointId).toBe(stable.checkpointId);
    });

    test('advances a source receipt only across the preparing turn exact tail', () => {
      const session = createSession('/tmp/project-compact-source-tail', 'gpt-4o');
      appendSessionMessage(session.id, { role: 'user', content: 'source', timestamp: 1 });
      const receipt = prepareSessionCompactSourceReceipt(session.id);
      const ownTail: SessionMessage[] = [
        { role: 'assistant', content: 'own result', timestamp: 2 },
      ];
      appendSessionMessages(session.id, ownTail);
      const advanced = advanceSessionCompactSourceReceipt(receipt, ownTail);
      expect(advanced.sourceMessageCount).toBe(2);

      const next = prepareSessionCompactSourceReceipt(session.id);
      appendSessionMessage(session.id, {
        role: 'assistant',
        content: 'other writer',
        timestamp: 3,
      });
      expect(() => advanceSessionCompactSourceReceipt(next, [])).toThrow(
        'concurrent or unexpected messages'
      );
    });

    test('derives contract V3 and validates candidate tokens, criteria, evidence, and task epoch', () => {
      const session = createSession('/tmp/project-semantic-receipt', 'gpt-4o');
      appendSessionMessage(session.id, { role: 'user', content: 'source', timestamp: 1 });
      const prepareSource = prepareSessionCompactSourceReceipt(session.id);
      const { candidate, harnessState, modelHistory } = semanticFixture();
      const postTurnHarnessState: HarnessState = {
        ...harnessState,
        contract: {
          ...harnessState.contract!,
          successCriteria: [...harnessState.contract!.successCriteria, 'answer recorded'],
          criteria: [
            ...(harnessState.contract!.criteria ?? []),
            {
              id: 'criterion:answer',
              statement: 'answer recorded',
              status: 'pending',
              evidenceRefs: [],
            },
          ],
        },
      };
      const checkpoint = commitSessionCompactCheckpoint({
        sessionId: session.id,
        mode: 'manual',
        modelId: 'gpt-4o',
        sourceMessageCount: prepareSource.sourceMessageCount,
        transcriptStartMessageIndex: 0,
        modelHistory,
        summary: { text: 'trusted', generatedAt: 2, source: 'heuristic' },
        beforeUsage: usage(1000),
        afterUsage: usage(candidate.afterTokens),
        harnessState: postTurnHarnessState,
        semanticHarnessState: harnessState,
        candidate,
        prepareSource,
      });

      expect(checkpoint.contractVersion).toBe(3);
      expect(checkpoint.validation).toMatchObject({
        prepareSourceVerified: true,
        candidateTokensVerified: true,
        semanticReceiptVerified: true,
      });
      expect(checkpoint.candidateReceipt.semanticValidation).toMatchObject({
        taskEpoch: 7,
        preservedCriterionIds: ['criterion:build'],
        validatedEvidenceRefs: ['e-build'],
      });

      const nextPrepare = prepareSessionCompactSourceReceipt(session.id);
      expect(() =>
        commitSessionCompactCheckpoint({
          sessionId: session.id,
          mode: 'manual',
          modelId: 'gpt-4o',
          sourceMessageCount: nextPrepare.sourceMessageCount,
          transcriptStartMessageIndex: 0,
          modelHistory,
          summary: { text: 'bad tokens', generatedAt: 3, source: 'heuristic' },
          beforeUsage: usage(1000),
          afterUsage: usage(candidate.afterTokens),
          harnessState,
          candidate: { ...candidate, afterTokens: candidate.afterTokens + 1 },
          prepareSource: nextPrepare,
        })
      ).toThrow('does not match actual history');

      const wrongEpoch = {
        ...candidate,
        semanticSummary: {
          ...candidate.semanticSummary,
          items: candidate.semanticSummary.items.map(item => ({ ...item, taskEpoch: 8 })),
        },
      };
      expect(() =>
        commitSessionCompactCheckpoint({
          sessionId: session.id,
          mode: 'manual',
          modelId: 'gpt-4o',
          sourceMessageCount: nextPrepare.sourceMessageCount,
          transcriptStartMessageIndex: 0,
          modelHistory,
          summary: { text: 'bad epoch', generatedAt: 4, source: 'heuristic' },
          beforeUsage: usage(1000),
          afterUsage: usage(candidate.afterTokens),
          harnessState,
          candidate: wrongEpoch,
          prepareSource: nextPrepare,
        })
      ).toThrow('taskEpoch');

      const danglingHarness: HarnessState = {
        ...harnessState,
        ledger: [],
      };
      expect(() =>
        commitSessionCompactCheckpoint({
          sessionId: session.id,
          mode: 'manual',
          modelId: 'gpt-4o',
          sourceMessageCount: nextPrepare.sourceMessageCount,
          transcriptStartMessageIndex: 0,
          modelHistory,
          summary: { text: 'dangling evidence', generatedAt: 5, source: 'heuristic' },
          beforeUsage: usage(1000),
          afterUsage: usage(candidate.afterTokens),
          harnessState: danglingHarness,
          candidate,
          prepareSource: nextPrepare,
        })
      ).toThrow('Dangling compact criterion evidence reference');
    });

    test('keeps the raw transcript immutable and restores checkpoint history plus new tail', () => {
      const session = createSession('/tmp/project-compact-checkpoint', 'gpt-4o');
      const rawMessages = Array.from({ length: 8 }, (_, index) => ({
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `raw-${index}`,
        timestamp: 1000 + index,
      }));
      appendSessionMessages(session.id, rawMessages);

      const checkpoint = commitSessionCompactCheckpoint({
        sessionId: session.id,
        mode: 'threshold',
        modelId: 'gpt-4o',
        sourceMessageCount: rawMessages.length,
        transcriptStartMessageIndex: 4,
        modelHistory: [
          { role: 'system', content: 'must not persist' },
          { role: 'user', content: '[Context Summary]\ncompleted setup' },
          { role: 'assistant', content: 'recent answer' },
        ],
        summary: {
          text: 'completed setup',
          generatedAt: 2000,
          source: 'heuristic',
        },
        beforeUsage: usage(110000),
        afterUsage: usage(1200),
      });

      expect(readSessionMessages(session.id)).toEqual(rawMessages);
      expect(checkpoint).toMatchObject({
        version: 2,
        sourceBoundary: {
          startMessageIndex: 0,
          endMessageIndexExclusive: rawMessages.length,
        },
        validation: {
          schemaValid: true,
          toolCallGroupsValid: true,
          sourcePrefixVerified: true,
          targetHeadroomRatio: 0.65,
          targetMet: true,
        },
      });
      expect(checkpoint.sourcePrefixHash).toMatch(/^[a-f0-9]{64}$/);
      expect(checkpoint.modelHistoryHash).toMatch(/^[a-f0-9]{64}$/);
      expect(checkpoint.candidateReceipt).toMatchObject({
        source: 'compatibility_adapter',
        beforeTokens: 110000,
        afterTokens: 1200,
        targetRatio: 0.65,
      });
      expect(checkpoint.validation.bindingHash).toMatch(/^[a-f0-9]{64}$/);
      expect(checkpoint.modelHistory).not.toContainEqual(
        expect.objectContaining({ role: 'system' })
      );
      expect(loadSessionMeta(session.id)).toMatchObject({
        activeCompactCheckpointId: checkpoint.checkpointId,
        lastCompactAt: checkpoint.createdAt,
      });
      expect(loadSessionTranscriptMessages(session.id).map(message => message.content)).toEqual([
        'raw-4',
        'raw-5',
        'raw-6',
        'raw-7',
      ]);

      appendSessionMessage(session.id, {
        role: 'user',
        content: 'new-tail',
        timestamp: 3000,
      });
      expect(loadSessionHistory(session.id).map(message => message.content)).toEqual([
        '[Context Summary]\ncompleted setup',
        'recent answer',
        'new-tail',
      ]);
    });

    test('uses the latest checkpoint boundary across consecutive compactions', () => {
      const session = createSession('/tmp/project-consecutive-compact', 'gpt-4o');
      appendSessionMessages(session.id, [
        { role: 'user', content: 'first', timestamp: 1 },
        { role: 'assistant', content: 'second', timestamp: 2 },
      ]);
      const common = {
        sessionId: session.id,
        modelId: 'gpt-4o',
        transcriptStartMessageIndex: 0,
        beforeUsage: usage(110000),
        afterUsage: usage(1000),
      };
      commitSessionCompactCheckpoint({
        ...common,
        mode: 'predictive',
        sourceMessageCount: 2,
        modelHistory: [{ role: 'user', content: 'checkpoint-one' }],
        summary: { text: 'one', generatedAt: 10, source: 'heuristic' },
      });
      appendSessionMessage(session.id, { role: 'user', content: 'third', timestamp: 3 });
      const latest = commitSessionCompactCheckpoint({
        ...common,
        mode: 'threshold',
        sourceMessageCount: 3,
        modelHistory: [{ role: 'user', content: 'checkpoint-two' }],
        summary: { text: 'two', generatedAt: 20, source: 'llm' },
      });

      expect(loadSessionCompactCheckpoint(session.id)?.checkpointId).toBe(latest.checkpointId);
      expect(loadSessionHistory(session.id)).toEqual([{ role: 'user', content: 'checkpoint-two' }]);
      expect(readSessionMessages(session.id)).toHaveLength(3);
    });

    test('rejects a V2 checkpoint when its covered transcript prefix changes', () => {
      const session = createSession('/tmp/project-compact-prefix-integrity', 'gpt-4o');
      appendSessionMessages(session.id, [
        { role: 'user', content: 'immutable-one', timestamp: 1 },
        { role: 'assistant', content: 'immutable-two', timestamp: 2 },
      ]);
      commitSessionCompactCheckpoint({
        sessionId: session.id,
        mode: 'threshold',
        modelId: 'gpt-4o',
        sourceMessageCount: 2,
        transcriptStartMessageIndex: 0,
        modelHistory: [{ role: 'user', content: 'verified checkpoint' }],
        summary: { text: 'verified', generatedAt: 3, source: 'heuristic' },
        beforeUsage: usage(110000),
        afterUsage: usage(1000),
      });

      const messagesPath = getProjectSessionMessagesPath(session.projectPath, session.id);
      writeFileSync(
        messagesPath,
        `${JSON.stringify({ role: 'user', content: 'tampered', timestamp: 1 })}\n${JSON.stringify({
          role: 'assistant',
          content: 'immutable-two',
          timestamp: 2,
        })}\n`,
        'utf-8'
      );

      expect(loadSessionCompactCheckpoint(session.id)).toBeNull();
      expect(loadSessionHistory(session.id)).toEqual([
        { role: 'user', content: 'tampered' },
        { role: 'assistant', content: 'immutable-two' },
      ]);
    });

    test('rejects a V2 checkpoint when its replacement history hash changes', () => {
      const session = createSession('/tmp/project-compact-replacement-integrity', 'gpt-4o');
      appendSessionMessage(session.id, { role: 'user', content: 'raw source', timestamp: 1 });
      const checkpoint = commitSessionCompactCheckpoint({
        sessionId: session.id,
        mode: 'manual',
        modelId: 'gpt-4o',
        sourceMessageCount: 1,
        transcriptStartMessageIndex: 0,
        modelHistory: [{ role: 'user', content: 'trusted replacement' }],
        summary: { text: 'trusted', generatedAt: 2, source: 'heuristic' },
        beforeUsage: usage(1000),
        afterUsage: usage(500),
      });
      const compactPath = getProjectSessionCompactPath(session.projectPath, session.id);
      writeFileSync(
        compactPath,
        JSON.stringify({
          ...checkpoint,
          modelHistory: [{ role: 'user', content: 'tampered replacement' }],
        }),
        'utf-8'
      );

      expect(loadSessionCompactCheckpoint(session.id)).toBeNull();
      expect(loadSessionHistory(session.id)).toEqual([{ role: 'user', content: 'raw source' }]);
    });

    test('rejects malformed V2 tool groups without moving the active checkpoint pointer', () => {
      const session = createSession('/tmp/project-compact-tool-groups', 'gpt-4o');
      appendSessionMessage(session.id, { role: 'user', content: 'raw source', timestamp: 1 });
      const common = {
        sessionId: session.id,
        mode: 'manual' as const,
        modelId: 'gpt-4o',
        sourceMessageCount: 1,
        transcriptStartMessageIndex: 0,
        summary: { text: 'summary', generatedAt: 2, source: 'heuristic' as const },
        beforeUsage: usage(1000),
        afterUsage: usage(500),
      };
      const stable = commitSessionCompactCheckpoint({
        ...common,
        modelHistory: [{ role: 'user', content: 'stable replacement' }],
      });

      expect(() =>
        commitSessionCompactCheckpoint({
          ...common,
          modelHistory: [
            {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'missing-result',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{}' },
                },
              ],
            },
          ],
        })
      ).toThrow(/Incomplete tool-call group/);
      expect(loadSessionCompactCheckpoint(session.id)?.checkpointId).toBe(stable.checkpointId);
    });

    test('continues to read legacy V1 compact checkpoints', () => {
      const session = createSession('/tmp/project-compact-v1-compatibility', 'gpt-4o');
      appendSessionMessage(session.id, { role: 'user', content: 'legacy raw', timestamp: 1 });
      const checkpointId = 'legacy-checkpoint';
      const legacyCheckpoint = {
        version: 1,
        checkpointId,
        sessionId: session.id,
        createdAt: 2,
        mode: 'manual',
        modelId: 'gpt-4o',
        sourceMessageCount: 1,
        transcriptStartMessageIndex: 0,
        modelHistory: [{ role: 'user', content: 'legacy replacement' }],
        summary: {
          text: 'legacy summary',
          generatedAt: 2,
          source: 'heuristic',
          sourceMessageCount: 1,
        },
        beforeUsage: usage(1000),
        afterUsage: usage(500),
      };
      writeFileSync(
        getProjectSessionCompactPath(session.projectPath, session.id),
        JSON.stringify(legacyCheckpoint),
        'utf-8'
      );
      saveSessionMeta({ ...session, activeCompactCheckpointId: checkpointId });

      expect(loadSessionCompactCheckpoint(session.id)).toMatchObject({
        version: 1,
        checkpointId,
      });
      expect(loadSessionHistory(session.id)).toEqual([
        { role: 'user', content: 'legacy replacement' },
      ]);
    });

    test('falls back to raw history for a corrupt or mismatched sidecar', () => {
      const session = createSession('/tmp/project-corrupt-compact', 'gpt-4o');
      appendSessionMessage(session.id, { role: 'user', content: 'auditable raw', timestamp: 1 });
      const checkpoint = commitSessionCompactCheckpoint({
        sessionId: session.id,
        mode: 'manual',
        modelId: 'gpt-4o',
        sourceMessageCount: 1,
        transcriptStartMessageIndex: 0,
        modelHistory: [{ role: 'user', content: 'checkpoint context' }],
        summary: { text: 'summary', generatedAt: 2, source: 'heuristic' },
        beforeUsage: usage(1000),
        afterUsage: usage(500),
      });
      const compactPath = getProjectSessionCompactPath(session.projectPath, session.id);
      writeFileSync(
        compactPath,
        JSON.stringify({ ...checkpoint, checkpointId: 'mismatched-id' }),
        'utf-8'
      );

      expect(loadSessionCompactCheckpoint(session.id)).toBeNull();
      expect(loadSessionHistory(session.id)).toEqual([{ role: 'user', content: 'auditable raw' }]);

      writeFileSync(compactPath, '{broken', 'utf-8');
      expect(loadSessionCompactCheckpoint(session.id)).toBeNull();
      expect(loadSessionHistory(session.id)).toEqual([{ role: 'user', content: 'auditable raw' }]);
    });

    test('preserves the previous checkpoint when sidecar or meta commit fails', () => {
      const session = createSession('/tmp/project-failed-compact-commit', 'gpt-4o');
      appendSessionMessage(session.id, { role: 'user', content: 'raw source', timestamp: 1 });
      const input = {
        sessionId: session.id,
        mode: 'manual' as const,
        modelId: 'gpt-4o',
        sourceMessageCount: 1,
        transcriptStartMessageIndex: 0,
        modelHistory: [{ role: 'user' as const, content: 'stable checkpoint' }],
        summary: { text: 'stable', generatedAt: 2, source: 'heuristic' as const },
        beforeUsage: usage(1000),
        afterUsage: usage(500),
      };
      const stable = commitSessionCompactCheckpoint(input);
      const compactPath = getProjectSessionCompactPath(session.projectPath, session.id);
      const metaPath = getProjectSessionMetaPath(session.projectPath, session.id);
      const realAtomicWrite = atomicWrite.atomicWriteFileSync;

      const sidecarFailure = jest
        .spyOn(atomicWrite, 'atomicWriteFileSync')
        .mockImplementation((path, content, options) => {
          if (path === `${compactPath}.candidate`) throw new Error('sidecar unavailable');
          realAtomicWrite(path, content, options);
        });
      expect(() =>
        commitSessionCompactCheckpoint({
          ...input,
          modelHistory: [{ role: 'user', content: 'must not commit' }],
        })
      ).toThrow('sidecar unavailable');
      sidecarFailure.mockRestore();
      expect(loadSessionCompactCheckpoint(session.id)?.checkpointId).toBe(stable.checkpointId);

      const metaFailure = jest
        .spyOn(atomicWrite, 'atomicWriteFileSync')
        .mockImplementation((path, content, options) => {
          if (path === metaPath) throw new Error('meta unavailable');
          realAtomicWrite(path, content, options);
        });
      expect(() =>
        commitSessionCompactCheckpoint({
          ...input,
          modelHistory: [{ role: 'user', content: 'also must not commit' }],
        })
      ).toThrow('meta unavailable');
      metaFailure.mockRestore();
      expect(loadSessionCompactCheckpoint(session.id)?.checkpointId).toBe(stable.checkpointId);
      expect(loadSessionHistory(session.id)).toEqual([
        { role: 'user', content: 'stable checkpoint' },
      ]);
    });

    test('recovers the durable checkpoint when a crash installs a sidecar before its pointer', () => {
      const session = createSession('/tmp/project-interrupted-compact-commit', 'gpt-4o');
      appendSessionMessage(session.id, { role: 'user', content: 'raw source', timestamp: 1 });
      const stable = commitSessionCompactCheckpoint({
        sessionId: session.id,
        mode: 'manual',
        modelId: 'gpt-4o',
        sourceMessageCount: 1,
        transcriptStartMessageIndex: 0,
        modelHistory: [{ role: 'user', content: 'stable checkpoint' }],
        summary: { text: 'stable', generatedAt: 2, source: 'heuristic' },
        beforeUsage: usage(1000),
        afterUsage: usage(500),
      });
      const compactPath = getProjectSessionCompactPath(session.projectPath, session.id);
      writeFileSync(`${compactPath}.previous`, JSON.stringify(stable), 'utf-8');
      writeFileSync(
        compactPath,
        JSON.stringify({ ...stable, checkpointId: 'interrupted-candidate' }),
        'utf-8'
      );

      expect(loadSessionCompactCheckpoint(session.id)?.checkpointId).toBe(stable.checkpointId);
      expect(loadSessionHistory(session.id)).toEqual([
        { role: 'user', content: 'stable checkpoint' },
      ]);
    });

    test('deleting a session removes its compact sidecar', () => {
      const session = createSession('/tmp/project-delete-compact', 'gpt-4o');
      appendSessionMessage(session.id, { role: 'user', content: 'delete me', timestamp: 1 });
      commitSessionCompactCheckpoint({
        sessionId: session.id,
        mode: 'manual',
        modelId: 'gpt-4o',
        sourceMessageCount: 1,
        transcriptStartMessageIndex: 0,
        modelHistory: [{ role: 'user', content: 'compact' }],
        summary: { text: 'summary', generatedAt: 2, source: 'heuristic' },
        beforeUsage: usage(1000),
        afterUsage: usage(500),
      });
      const compactPath = getProjectSessionCompactPath(session.projectPath, session.id);
      writeFileSync(`${compactPath}.candidate`, '{}', 'utf-8');
      writeFileSync(`${compactPath}.previous`, '{}', 'utf-8');
      expect(existsSync(compactPath)).toBe(true);

      expect(deleteSession(session.id)).toBe(true);
      expect(existsSync(compactPath)).toBe(false);
      expect(existsSync(`${compactPath}.candidate`)).toBe(false);
      expect(existsSync(`${compactPath}.previous`)).toBe(false);
    });

    test('deleting a session fences its Goal against a stale writer', () => {
      const session = createSession('/tmp/project-delete-goal', 'gpt-4o');
      const goal = createGoal(session.projectPath, session.id, 'Goal owned by deleted session');
      if (!goal.ok) throw new Error(goal.message);

      expect(deleteSession(session.id)).toBe(true);
      expect(
        existsSync(
          join(getProjectSessionsDir(session.projectPath), `${session.id}.goal.json.deleted`)
        )
      ).toBe(true);
      expect(loadGoal(session.projectPath, session.id)).toEqual(
        expect.objectContaining({ ok: false, error: 'not_found' })
      );

      const stale = saveGoal(
        session.projectPath,
        session.id,
        { ...goal.value, revision: goal.value.revision + 1 },
        goal.value.revision
      );
      expect(stale).toEqual(expect.objectContaining({ ok: false, error: 'revision_stale' }));
      expect(loadGoal(session.projectPath, session.id)).toEqual(
        expect.objectContaining({ ok: false, error: 'not_found' })
      );
    });
  });

  describe('updateSessionStats', () => {
    test('updates token count and cost', () => {
      const session = createSession('/tmp/project', 'gpt-4o');

      updateSessionStats(session.id, 500, 0.01);
      updateSessionStats(session.id, 300, 0.005);

      const loaded = loadSessionMeta(session.id);
      expect(loaded?.tokenCount).toBe(800);
      expect(loaded?.cost).toBe(0.015);
    });
  });

  describe('updateSessionSkills', () => {
    test('merges applied skills into session metadata', () => {
      const session = createSession('/tmp/project-skills', 'gpt-4o');

      updateSessionSkills(session.id, ['code-review', 'security-check']);
      updateSessionSkills(session.id, ['code-review']);

      const loaded = loadSessionMeta(session.id);
      expect(loaded?.skillsUsed).toEqual(['code-review', 'security-check']);
    });
  });

  describe('endSession', () => {
    test('sets end time', () => {
      const session = createSession('/tmp/project', 'gpt-4o');

      endSession(session.id);

      const loaded = loadSessionMeta(session.id);
      expect(loaded?.endTime).toBeDefined();
      expect(loaded?.endTime).toBeGreaterThanOrEqual(loaded!.startTime);
    });
  });

  describe('history (JSONL)', () => {
    test('appendHistory creates file if not exists', () => {
      const entry: HistoryEntry = {
        display: 'hello',
        timestamp: Date.now(),
        project: '/tmp/project',
        sessionId: 'test-session',
        role: 'user',
      };

      appendHistory(entry);

      const path = join(testDir, 'history.jsonl');
      expect(existsSync(path)).toBe(true);
    });

    test('appendHistory appends multiple entries', () => {
      const entries: HistoryEntry[] = [
        {
          display: 'question 1',
          timestamp: Date.now(),
          project: '/tmp/project',
          sessionId: 'session-1',
          role: 'user',
        },
        {
          display: 'answer 1',
          timestamp: Date.now() + 1000,
          project: '/tmp/project',
          sessionId: 'session-1',
          role: 'assistant',
        },
      ];

      appendHistory(entries[0]);
      appendHistory(entries[1]);

      const history = readHistory();
      expect(history.length).toBeGreaterThanOrEqual(2);
    });

    test('readHistory returns entries in reverse order', () => {
      // Clean history
      const path = join(testDir, 'history.jsonl');
      if (existsSync(path)) {
        rmSync(path);
      }

      const entry1: HistoryEntry = {
        display: 'first',
        timestamp: 1000,
        project: '/tmp/project',
        sessionId: 'session-1',
        role: 'user',
      };
      const entry2: HistoryEntry = {
        display: 'second',
        timestamp: 2000,
        project: '/tmp/project',
        sessionId: 'session-1',
        role: 'user',
      };

      appendHistory(entry1);
      appendHistory(entry2);

      const history = readHistory();
      expect(history[0].display).toBe('second'); // Most recent first
      expect(history[1].display).toBe('first');
    });

    test('readHistory respects limit', () => {
      // Clean history
      const path = join(testDir, 'history.jsonl');
      if (existsSync(path)) {
        rmSync(path);
      }

      for (let i = 0; i < 10; i++) {
        appendHistory({
          display: `entry ${i}`,
          timestamp: i * 1000,
          project: '/tmp/project',
          sessionId: 'session-1',
          role: 'user',
        });
      }

      const history = readHistory(3);
      expect(history.length).toBe(3);
    });

    test('readProjectHistory filters by project', () => {
      // Clean history
      const path = join(testDir, 'history.jsonl');
      if (existsSync(path)) {
        rmSync(path);
      }

      appendHistory({
        display: 'project A',
        timestamp: 1000,
        project: '/tmp/projectA',
        sessionId: 'session-1',
        role: 'user',
      });
      appendHistory({
        display: 'project B',
        timestamp: 2000,
        project: '/tmp/projectB',
        sessionId: 'session-2',
        role: 'user',
      });

      const historyA = readProjectHistory('/tmp/projectA');
      expect(historyA.length).toBe(1);
      expect(historyA[0].project).toBe('/tmp/projectA');
    });
  });

  describe('session messages (JSONL)', () => {
    test('appendSessionMessage ignores unknown session ids', () => {
      const sessionId = 'test-msg-session';
      const message: SessionMessage = {
        role: 'user',
        content: 'Hello',
        timestamp: Date.now(),
      };

      appendSessionMessage(sessionId, message);

      const path = join(testDir, 'sessions', `${sessionId}.jsonl`);
      expect(existsSync(path)).toBe(false);
    });

    test('appendSessionMessage mirrors project transcript and updates message count', () => {
      const session = createSession('/tmp/project-msg-count', 'gpt-4o');

      appendSessionMessage(session.id, {
        role: 'user',
        content: 'Hello project session',
        timestamp: Date.now(),
        appliedSkills: ['code-review'],
      });

      const loaded = loadSessionMeta(session.id);
      expect(loaded?.messageCount).toBe(1);
      expect(loaded?.updatedAt).toBeGreaterThanOrEqual(session.startTime);
      expect(existsSync(getProjectSessionMessagesPath(session.projectPath, session.id))).toBe(true);
      expect(existsSync(join(testDir, 'sessions', `${session.id}.jsonl`))).toBe(false);
      expect(readSessionMessages(session.id)[0].appliedSkills).toEqual(['code-review']);
    });

    test('loadSessionMeta reports transcript history size from the project jsonl file', () => {
      const session = createSession('/tmp/project-history-size', 'gpt-4o');

      appendSessionMessage(session.id, {
        role: 'user',
        content: 'history size should be visible in session picker',
        timestamp: 1234,
      });

      const transcriptPath = getProjectSessionMessagesPath(session.projectPath, session.id);
      const expectedSize = Buffer.byteLength(readFileSync(transcriptPath, 'utf-8'), 'utf-8');
      const loaded = loadSessionMeta(session.id);

      expect(loaded?.historySizeBytes).toBe(expectedSize);
      expect(loaded?.messageCount).toBe(1);
    });

    test('readSessionMessages returns all messages', () => {
      const session = createSession('/tmp/project-read-messages', 'gpt-4o');

      appendSessionMessage(session.id, {
        role: 'user',
        content: 'Question',
        timestamp: 1000,
      });
      appendSessionMessage(session.id, {
        role: 'assistant',
        content: 'Answer',
        timestamp: 2000,
      });

      const messages = readSessionMessages(session.id);
      expect(messages.length).toBe(2);
      expect(messages[0].role).toBe('user');
      expect(messages[1].role).toBe('assistant');
    });

    test('readSessionMessages skips a corrupt line and keeps the later messages (Issue #84)', () => {
      const session = createSession('/tmp/project-read-corrupt-messages', 'gpt-4o');
      appendSessionMessage(session.id, {
        role: 'user',
        content: 'before corruption',
        timestamp: 1000,
      });
      appendSessionMessage(session.id, {
        role: 'assistant',
        content: 'after corruption',
        timestamp: 2000,
      });

      const transcriptPath = getProjectSessionMessagesPath(session.projectPath, session.id);
      const [first, second] = readFileSync(transcriptPath, 'utf-8').trim().split('\n');
      writeFileSync(transcriptPath, `${first}\n{not-json}\n${second}\n`, 'utf-8');

      // A single corrupt line must NOT truncate the whole session (which would
      // drop every later turn on resume). It is skipped and the rest is kept.
      expect(readSessionMessages(session.id).map(message => message.content)).toEqual([
        'before corruption',
        'after corruption',
      ]);
    });

    test('loadSessionHistory uses model-visible content while transcript keeps full tool output', () => {
      const session = createSession('/tmp/project-model-visible-history', 'gpt-4o');
      const fullToolOutput = JSON.stringify({
        success: true,
        output: 'full line\n'.repeat(500),
        summary: 'full result',
      });
      const compactToolOutput = JSON.stringify({
        success: true,
        output: 'compact result',
        summary: 'compact result',
        metadata: { modelVisibleCompressed: true },
      });

      appendSessionMessages(session.id, [
        {
          role: 'assistant',
          content: '',
          timestamp: 1000,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"/large"}' },
            },
          ],
        },
        {
          role: 'tool',
          content: fullToolOutput,
          modelVisibleContent: compactToolOutput,
          timestamp: 1001,
          toolCallId: 'call-1',
        },
      ]);

      const persisted = readSessionMessages(session.id);
      const history = loadSessionHistory(session.id);

      expect(persisted[1].content).toBe(fullToolOutput);
      expect(history[1].content).toBe(compactToolOutput);
      expect(history[1].content).toContain('modelVisibleCompressed');
      expect(history[1].content).not.toContain('full line');
    });

    test('loadSessionHistory seals a legacy incomplete tool-call batch before resume', () => {
      const session = createSession('/tmp/project-seal-tool-history', 'gpt-4o');
      appendSessionMessages(session.id, [
        {
          role: 'assistant',
          content: '',
          timestamp: 1000,
          tool_calls: [
            {
              id: 'call-a',
              type: 'function',
              function: { name: 'read_file', arguments: '{}' },
            },
            {
              id: 'call-b',
              type: 'function',
              function: { name: 'read_file', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', content: 'a', toolCallId: 'call-a', timestamp: 1001 },
        { role: 'user', content: 'resume this session', timestamp: 1002 },
      ]);

      const history = loadSessionHistory(session.id);
      expect(history.map(message => [message.role, message.tool_call_id])).toEqual([
        ['assistant', undefined],
        ['tool', 'call-a'],
        ['tool', 'call-b'],
        ['user', undefined],
      ]);
    });

    test('loadSessionHistory falls back to full history for legacy compact boundary without persisted summary', () => {
      const session = createSession('/tmp/project-legacy-compact-boundary', 'gpt-4o');
      appendSessionMessages(session.id, [
        { role: 'user', content: 'old context', timestamp: 1000 },
        { role: 'assistant', content: 'old answer', timestamp: 1001 },
        { role: 'user', content: 'tail after boundary', timestamp: 2000 },
      ]);
      markSessionTranscriptDisplayStart(session.id, 2000);

      const history = loadSessionHistory(session.id);

      expect(history.map(message => message.content)).toEqual([
        'old context',
        'old answer',
        'tail after boundary',
      ]);
    });

    test('loadSessionHistory hides pre-compact transcript when compact summary was persisted', () => {
      const session = createSession('/tmp/project-persisted-compact-boundary', 'gpt-4o');
      appendSessionMessages(session.id, [
        { role: 'user', content: 'raw old context', timestamp: 1000 },
        { role: 'assistant', content: 'raw old answer', timestamp: 1001 },
        { role: 'user', content: '[Context Summary]\nold context summarized', timestamp: 2000 },
        { role: 'assistant', content: 'I understand the context.', timestamp: 2000 },
        { role: 'user', content: 'recent tail', timestamp: 2001 },
      ]);
      markSessionTranscriptDisplayStart(session.id, 2000);

      const history = loadSessionHistory(session.id);

      expect(history.map(message => message.content)).toEqual([
        '[Context Summary]\nold context summarized',
        'I understand the context.',
        'recent tail',
      ]);
    });

    test('readSessionMessages returns empty array for non-existent session', () => {
      const messages = readSessionMessages('non-existent');
      expect(messages).toEqual([]);
    });
  });

  describe('project session lookup', () => {
    test('counts catalogued sessions by canonical project without hydrating history', () => {
      createSession('/tmp/project-count-A', 'gpt-4o');
      createSession('/tmp/project-count-A', 'gpt-4o');
      createSession('/tmp/project-count-B', 'gpt-4o');

      const counts = countSessionsByProject();
      expect(counts.get(resolveProjectPath('/tmp/project-count-A'))).toBe(2);
      expect(counts.get(resolveProjectPath('/tmp/project-count-B'))).toBe(1);
    });

    test('listProjectSessions filters by canonical project path', () => {
      const sessionA = createSession('/tmp/project-filter-A', 'gpt-4o');
      const sessionB = createSession('/tmp/project-filter-B', 'gpt-4o');

      appendSessionMessage(sessionA.id, {
        role: 'user',
        content: 'A',
        timestamp: Date.now(),
      });
      appendSessionMessage(sessionB.id, {
        role: 'user',
        content: 'B',
        timestamp: Date.now(),
      });

      const sessionsA = listProjectSessions('/tmp/project-filter-A');
      expect(sessionsA.some(s => s.id === sessionA.id)).toBe(true);
      expect(sessionsA.some(s => s.id === sessionB.id)).toBe(false);
    });

    test('session lookup ignores legacy global session files', () => {
      const project = '/tmp/project-ignore-global';
      const legacySession: SessionMeta = {
        id: 'legacy-global-session',
        projectPath: project,
        model: 'gpt-4o',
        startTime: Date.now(),
        messageCount: 1,
        tokenCount: 0,
        cost: 0,
      };

      mkdirSync(join(testDir, 'sessions'), { recursive: true });
      writeFileSync(
        join(testDir, 'sessions', `${legacySession.id}.json`),
        JSON.stringify(legacySession, null, 2)
      );

      const projectSessions = listProjectSessions(project);
      const allProjectsMatch = findSession(legacySession.id, project, { allProjects: true });

      expect(projectSessions.some(s => s.id === legacySession.id)).toBe(false);
      expect(allProjectsMatch).toBeNull();
    });

    test('findSession defaults to the provided project scope', () => {
      const projectSession = createSession('/tmp/project-find-current', 'gpt-4o');
      const otherSession = createSession('/tmp/project-find-other', 'gpt-4o');

      const projectMatch = findSession(projectSession.id.slice(0, 8), '/tmp/project-find-current');
      const wrongProjectMatch = findSession(
        otherSession.id.slice(0, 8),
        '/tmp/project-find-current'
      );
      const allProjectsMatch = findSession(
        otherSession.id.slice(0, 8),
        '/tmp/project-find-current',
        { allProjects: true }
      );

      expect(projectMatch?.id).toBe(projectSession.id);
      expect(wrongProjectMatch).toBeNull();
      expect(allProjectsMatch?.id).toBe(otherSession.id);
    });

    test('project session index sidecars are not listed as sessions', () => {
      const session = createSession('/tmp/project-index-sidecar', 'gpt-4o');
      appendSessionMessage(session.id, {
        role: 'user',
        content: 'sidecar indexing check',
        timestamp: Date.now(),
      });

      const sessions = listProjectSessions('/tmp/project-index-sidecar');

      expect(sessions.filter(s => s.id === session.id)).toHaveLength(1);
      expect(sessions.every(s => typeof s.id === 'string' && !s.id.endsWith('.index'))).toBe(true);
      expect(findSession(session.id.slice(0, 8), '/tmp/project-index-sidecar')?.id).toBe(
        session.id
      );
    });

    test('appendSessionMessages updates the session index', () => {
      const session = createSession('/tmp/project-index-batch', 'gpt-4o');
      appendSessionMessages(session.id, [
        {
          role: 'user',
          content: 'batch topic',
          timestamp: Date.now(),
        },
        {
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"src/index.ts"}' },
            },
          ],
        },
      ]);

      const index = loadSessionIndex(session.id, '/tmp/project-index-batch');

      expect(index?.topics).toContain('batch topic');
      expect(index?.tools.read_file).toBe(1);
      expect(index?.files).toContain('src/index.ts');
    });

    test('appendSessionMessages updates summary metadata without rescanning a long transcript', () => {
      const session = createSession('/tmp/project-incremental-summary', 'gpt-4o');
      const messagesPath = getProjectSessionMessagesPath(session.projectPath, session.id);
      const historicalMessages = Array.from({ length: 5_000 }, (_, index) =>
        JSON.stringify({ role: 'user', content: `historical ${index}`, timestamp: index })
      ).join('\n');
      writeFileSync(messagesPath, `${historicalMessages}\n`);
      session.messageCount = 5_000;
      saveSessionMeta(session);

      const fsModule = jest.requireActual<typeof import('fs')>('fs');
      const readSpy = jest.spyOn(fsModule, 'readFileSync');
      try {
        appendSessionMessages(session.id, [
          {
            role: 'assistant',
            content: '',
            timestamp: 5_001,
            tool_calls: [
              {
                id: 'call-incremental',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"src/index.ts"}' },
              },
            ],
          },
        ]);

        const transcriptReads = readSpy.mock.calls.filter(
          ([file]) => String(file) === messagesPath
        );
        expect(transcriptReads).toHaveLength(0);
        expect(loadSessionMeta(session.id)).toMatchObject({
          messageCount: 5_001,
          toolsUsed: ['read_file'],
        });
      } finally {
        readSpy.mockRestore();
      }
    });

    test('redacts secret-like values from session summaries and indexes', () => {
      const session = createSession('/tmp/project-index-redaction', 'gpt-4o');
      appendSessionMessages(session.id, [
        {
          role: 'user',
          content: 'fix config {"apiKey":"dashscope-secret-value"} and sk-secretvalue123456',
          timestamp: Date.now(),
        },
        {
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: '{"path":"src/sk-secretvalue123456.ts"}',
              },
            },
          ],
        },
      ]);

      updateSessionSummary(session.id, readSessionMessages(session.id));
      const meta = loadSessionMeta(session.id);
      const index = loadSessionIndex(session.id, '/tmp/project-index-redaction');
      const serialized = JSON.stringify({ meta, index });

      expect(meta?.taskSummary).toContain('[REDACTED_SECRET]');
      expect(index?.topics.join('\n')).toContain('[REDACTED_SECRET]');
      expect(index?.files.join('\n')).toContain('[REDACTED_SECRET]');
      expect(serialized).not.toContain('dashscope-secret-value');
      expect(serialized).not.toContain('sk-secretvalue123456');
    });

    test('reconciles summary metadata from the locked transcript, not a stale caller snapshot', () => {
      const session = createSession('/tmp/project-summary-stale-snapshot', 'gpt-4o');
      appendSessionMessage(session.id, {
        role: 'user',
        content: 'Update both files',
        timestamp: 1,
      });
      const staleSnapshot = readSessionMessages(session.id);
      appendSessionMessages(session.id, [
        {
          role: 'assistant',
          content: '',
          timestamp: 2,
          tool_calls: [
            {
              id: 'call-write',
              type: 'function',
              function: {
                name: 'write_file',
                arguments: '{"path":"src/first.ts","content":"first"}',
              },
            },
          ],
        },
        {
          role: 'assistant',
          content: '',
          timestamp: 3,
          tool_calls: [
            {
              id: 'call-edit',
              type: 'function',
              function: {
                name: 'edit_file',
                arguments: '{"path":"src/second.ts","old_string":"old","new_string":"new"}',
              },
            },
          ],
        },
      ]);

      updateSessionSummary(session.id, staleSnapshot);
      expect(loadSessionMeta(session.id)).toMatchObject({
        messageCount: 3,
        taskSummary: 'Update both files',
        toolsUsed: ['write_file', 'edit_file'],
        filesModified: ['src/first.ts', 'src/second.ts'],
      });
    });

    test('truncateSessionToLastComplete removes trailing aborted turn and rebuilds index', () => {
      const session = createSession('/tmp/project-truncate-abort', 'gpt-4o');
      appendSessionMessages(session.id, [
        {
          role: 'user',
          content: 'complete topic',
          timestamp: Date.now(),
        },
        {
          role: 'assistant',
          content: 'complete answer',
          timestamp: Date.now(),
        },
        {
          role: 'user',
          content: 'aborted topic',
          timestamp: Date.now(),
        },
      ]);

      const truncated = truncateSessionToLastComplete(session.id);
      const persisted = readSessionMessages(session.id);
      const meta = loadSessionMeta(session.id);
      const index = loadSessionIndex(session.id, '/tmp/project-truncate-abort');

      // The aborted user prompt is kept; only the dangling tail (its missing
      // final answer) is dropped (Issue #49).
      expect(truncated.map(message => message.content)).toEqual([
        'complete topic',
        'complete answer',
        'aborted topic',
      ]);
      expect(persisted).toHaveLength(3);
      expect(meta?.messageCount).toBe(3);
      expect(index?.topics).toContain('complete topic');
      expect(index?.topics).toContain('aborted topic');
    });

    test('truncate: abort mid-tool-call (assistant has tool_calls, no tool result yet)', () => {
      const session = createSession('/tmp/project-abort-mid-tool', 'gpt-4o');
      appendSessionMessages(session.id, [
        { role: 'user', content: 'first question', timestamp: Date.now() },
        { role: 'assistant', content: 'done', timestamp: Date.now() },
        { role: 'user', content: 'fix this bug', timestamp: Date.now() },
        {
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"bug.ts"}' },
            },
          ],
        },
      ]);

      const truncated = truncateSessionToLastComplete(session.id);
      // The user prompt 'fix this bug' is kept; only the partial assistant
      // tool-call is dropped (Issue #49).
      expect(truncated.map(message => message.content)).toEqual([
        'first question',
        'done',
        'fix this bug',
      ]);
      expect(readSessionMessages(session.id)).toHaveLength(3);
    });

    test('truncate: abort after tool result but before final assistant answer', () => {
      const session = createSession('/tmp/project-abort-after-tool-result', 'gpt-4o');
      appendSessionMessages(session.id, [
        { role: 'user', content: 'start', timestamp: Date.now() },
        { role: 'assistant', content: 'ok', timestamp: Date.now() },
        { role: 'user', content: 'search for foo', timestamp: Date.now() },
        {
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'grep', arguments: '{"pattern":"foo"}' },
            },
          ],
        },
        {
          role: 'tool',
          content: 'found foo in src/a.ts',
          timestamp: Date.now(),
          toolCallId: 'call-1',
        },
      ]);

      const truncated = truncateSessionToLastComplete(session.id);
      // 'search for foo' (the user prompt) is kept; the partial assistant/tool
      // tail is dropped (Issue #49).
      expect(truncated.map(message => message.content)).toEqual(['start', 'ok', 'search for foo']);
      expect(readSessionMessages(session.id)).toHaveLength(3);
    });

    test('truncate: abort with only user message keeps the prompt (Issue #49)', () => {
      const session = createSession('/tmp/project-abort-only-user', 'gpt-4o');
      appendSessionMessages(session.id, [
        { role: 'user', content: 'hello', timestamp: Date.now() },
      ]);

      const truncated = truncateSessionToLastComplete(session.id);
      // The user prompt is preserved even with no assistant response yet.
      expect(truncated.map(message => message.content)).toEqual(['hello']);
      expect(readSessionMessages(session.id)).toHaveLength(1);
    });

    test('truncate: complete final answer is NOT removed', () => {
      const session = createSession('/tmp/project-complete-not-truncated', 'gpt-4o');
      appendSessionMessages(session.id, [
        { role: 'user', content: 'question', timestamp: Date.now() },
        { role: 'assistant', content: 'Here is the answer with details.', timestamp: Date.now() },
      ]);

      const truncated = truncateSessionToLastComplete(session.id);
      expect(truncated.map(message => message.content)).toEqual([
        'question',
        'Here is the answer with details.',
      ]);
      expect(readSessionMessages(session.id)).toHaveLength(2);
    });

    test('truncate: multiple complete turns, no truncation needed', () => {
      const session = createSession('/tmp/project-multi-complete', 'gpt-4o');
      appendSessionMessages(session.id, [
        { role: 'user', content: 'q1', timestamp: Date.now() },
        { role: 'assistant', content: 'a1', timestamp: Date.now() },
        { role: 'user', content: 'q2', timestamp: Date.now() },
        { role: 'assistant', content: 'a2', timestamp: Date.now() },
        { role: 'user', content: 'q3', timestamp: Date.now() },
        { role: 'assistant', content: 'a3', timestamp: Date.now() },
      ]);

      const truncated = truncateSessionToLastComplete(session.id);
      expect(truncated).toHaveLength(6);
    });

    test('truncate: tool result with no following assistant still truncates back to last complete', () => {
      const session = createSession('/tmp/project-tool-result-no-assistant', 'gpt-4o');
      appendSessionMessages(session.id, [
        { role: 'user', content: 'task 1', timestamp: Date.now() },
        { role: 'assistant', content: 'done 1', timestamp: Date.now() },
        { role: 'user', content: 'task 2', timestamp: Date.now() },
        {
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          tool_calls: [
            {
              id: 'call-a',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
            },
            {
              id: 'call-b',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"b.ts"}' },
            },
          ],
        },
        { role: 'tool', content: 'content a', timestamp: Date.now(), toolCallId: 'call-a' },
        { role: 'tool', content: 'content b', timestamp: Date.now(), toolCallId: 'call-b' },
        {
          role: 'assistant',
          content: 'processing...',
          timestamp: Date.now(),
          tool_calls: [
            {
              id: 'call-c',
              type: 'function',
              function: {
                name: 'edit_file',
                arguments: '{"path":"a.ts","old_string":"x","new_string":"y"}',
              },
            },
          ],
        },
      ]);

      const truncated = truncateSessionToLastComplete(session.id);
      // The user prompt 'task 2' is kept; only the partial tool tail is dropped (Issue #49).
      expect(truncated.map(message => message.content)).toEqual(['task 1', 'done 1', 'task 2']);
      expect(readSessionMessages(session.id)).toHaveLength(3);
    });

    test('searchSessions can search candidates across project indexes', () => {
      const authSession = createSession('/tmp/project-search-auth', 'gpt-4o');
      const billingSession = createSession('/tmp/project-search-billing', 'gpt-4o');
      appendSessionMessage(authSession.id, {
        role: 'user',
        content: 'fix auth flow',
        timestamp: Date.now(),
      });
      appendSessionMessage(billingSession.id, {
        role: 'user',
        content: 'fix billing flow',
        timestamp: Date.now(),
      });

      const matches = searchSessions('billing', [
        { id: authSession.id, projectPath: authSession.projectPath },
        { id: billingSession.id, projectPath: billingSession.projectPath },
      ]);

      expect(matches).toEqual([billingSession.id]);
    });

    test('searchSessions sorts ties by updatedAt then session id', () => {
      const project = '/tmp/project-search-sort';
      const sessionA = createSession(project, 'gpt-4o');
      const sessionB = createSession(project, 'gpt-4o');
      appendSessionMessage(sessionA.id, {
        role: 'user',
        content: 'billing query',
        timestamp: Date.now() + 1,
      });
      appendSessionMessage(sessionB.id, {
        role: 'user',
        content: 'billing query',
        timestamp: Date.now() + 2,
      });

      const candidates = [
        { id: sessionA.id, projectPath: sessionA.projectPath },
        { id: sessionB.id, projectPath: sessionB.projectPath },
      ];
      const indexA = loadSessionIndex(sessionA.id, sessionA.projectPath);
      const indexB = loadSessionIndex(sessionB.id, sessionB.projectPath);
      if (!indexA || !indexB) {
        throw new Error('Indexes not generated');
      }

      // Same score, same updatedAt => stable by id.
      saveSessionIndex(sessionA.id, sessionA.projectPath, { ...indexA, updatedAt: 1000 });
      saveSessionIndex(sessionB.id, sessionB.projectPath, { ...indexB, updatedAt: 1000 });
      const tieResult = searchSessions('billing', candidates);
      expect(tieResult).toEqual([
        sessionA.id < sessionB.id ? sessionA.id : sessionB.id,
        sessionA.id < sessionB.id ? sessionB.id : sessionA.id,
      ]);

      // same score, updatedAt changed => recent first.
      saveSessionIndex(sessionA.id, sessionA.projectPath, { ...indexA, updatedAt: 2000 });
      saveSessionIndex(sessionB.id, sessionB.projectPath, { ...indexB, updatedAt: 1500 });
      const recentFirst = searchSessions('billing', candidates);
      expect(recentFirst[0]).toBe(sessionA.id);
      expect(recentFirst[1]).toBe(sessionB.id);
    });

    test('lookupSessionRef reports ambiguous id prefixes', () => {
      const project = '/tmp/project-ambiguous-prefix';
      const base = createSession(project, 'gpt-4o');
      const sessionA: SessionMeta = {
        ...base,
        id: 'abc111-session',
        startTime: base.startTime + 1,
      };
      const sessionB: SessionMeta = {
        ...base,
        id: 'abc222-session',
        startTime: base.startTime + 2,
      };
      saveSessionMeta(sessionA);
      saveSessionMeta(sessionB);

      const result = lookupSessionRef('abc', project);
      expect(result.status).toBe('ambiguous');
      if (result.status === 'ambiguous') {
        expect(result.matches.map(s => s.id)).toEqual(
          expect.arrayContaining(['abc111-session', 'abc222-session'])
        );
      }
      expect(findSession('abc', project)).toBeNull();
    });

    test('renameSession updates the display name and lookup by exact name', () => {
      const session = createSession('/tmp/project-rename-session', 'gpt-4o');

      const renamed = renameSession(session.id, 'api cleanup');
      const loaded = loadSessionMeta(session.id);
      const byName = findSession('api cleanup', '/tmp/project-rename-session');

      expect(renamed?.name).toBe('api cleanup');
      expect(loaded?.name).toBe('api cleanup');
      expect(byName?.id).toBe(session.id);
    });

    test('catalog keeps hot lookup independent from the number of project directories', () => {
      const sessions = Array.from({ length: 24 }, (_, index) =>
        createSession(`/tmp/project-catalog-lookup-${index}`, 'gpt-4o')
      );
      const target = sessions[17];
      const worker = spawnSync(
        process.execPath,
        [
          '-r',
          'ts-node/register',
          join(__dirname, 'fixtures/session-catalog-worker.js'),
          'lookup',
          target.id,
        ],
        { encoding: 'utf-8', env: process.env }
      );

      expect(worker.status).toBe(0);
      const metrics = JSON.parse(worker.stdout);
      expect(metrics).toMatchObject({ found: target.id, metaReads: 1 });
      expect(metrics.projectDirectoryReads).toBeLessThanOrEqual(1);
    });

    test('limited global listing reads the catalog without parsing every session file', () => {
      Array.from({ length: 24 }, (_, index) =>
        createSession(`/tmp/project-catalog-list-${index}`, 'gpt-4o')
      );
      expect(listSessions(3)).toHaveLength(3);

      const worker = spawnSync(
        process.execPath,
        [
          '-r',
          'ts-node/register',
          join(__dirname, 'fixtures/session-catalog-worker.js'),
          'list',
          '3',
        ],
        { encoding: 'utf-8', env: process.env }
      );

      expect(worker.status).toBe(0);
      const metrics = JSON.parse(worker.stdout);
      expect(metrics).toMatchObject({ count: 3, metaReads: 0 });
      expect(metrics.projectDirectoryReads).toBeLessThanOrEqual(1);
    });

    test('getLastSession ignores empty sessions and returns most recently updated project session', () => {
      const project = '/tmp/project-last-session';
      const empty = createSession(project, 'gpt-4o');
      const withMessages = createSession(project, 'gpt-4o');

      appendSessionMessage(withMessages.id, {
        role: 'user',
        content: 'restorable',
        timestamp: Date.now(),
      });

      const last = getLastSession(project);
      expect(last?.id).toBe(withMessages.id);
      expect(last?.id).not.toBe(empty.id);
    });

    test('resumeSession clears endTime and refreshes updatedAt', () => {
      const session = createSession('/tmp/project-resume-session', 'gpt-4o');
      endSession(session.id);

      const ended = loadSessionMeta(session.id);
      expect(ended?.endTime).toBeDefined();

      const resumed = resumeSession(session.id);
      expect(resumed?.endTime).toBeUndefined();
      expect(resumed?.updatedAt).toBeGreaterThanOrEqual(session.startTime);
    });

    test('resumeSession recovers a stale zero-byte recovery sentinel from an interrupted writer', () => {
      const session = createSession('/tmp/project-resume-stale-recovery', 'gpt-4o');
      endSession(session.id);
      const metaPath = getProjectSessionMetaPath(session.projectPath, session.id);
      const recoveryPath = `${metaPath}.lock.recovery`;
      writeFileSync(recoveryPath, '', { mode: 0o600 });
      const staleTime = new Date(Date.now() - 60_000);
      utimesSync(recoveryPath, staleTime, staleTime);

      const resumed = resumeSession(session.id);

      expect(resumed?.id).toBe(session.id);
      expect(resumed?.endTime).toBeUndefined();
      expect(existsSync(recoveryPath)).toBe(false);
      expect(
        readdirSync(getProjectSessionsDir(session.projectPath)).some(entry =>
          entry.startsWith(`${session.id}.json.lock.recovery.quarantine-`)
        )
      ).toBe(true);
    });

    test('stores full harness state in project sidecar and loads sidecar on resume', () => {
      const session = createSession('/tmp/project-harness-sidecar', 'gpt-4o');
      const harness = createContextHarness({ cwd: session.projectPath, modelId: 'gpt-4o' });
      harness.updateContractFromUserInput('实现 Context Harness sidecar，必须支持 resume');
      for (let i = 0; i < 40; i++) {
        harness.recordToolResult({
          name: 'bash',
          args: { command: `npm test -- case-${i}` },
          result: JSON.stringify({ success: true, output: 'ok' }),
          duration: 1,
          success: true,
        });
      }

      updateSessionHarnessState(session.id, harness.toJSON());

      const sidecarPath = getProjectSessionHarnessPath(session.projectPath, session.id);
      const meta = loadSessionMeta(session.id);
      const loaded = loadSessionHarnessState(session.id);

      expect(existsSync(sidecarPath)).toBe(true);
      expect(meta?.harnessState?.version).toBe(2);
      expect(meta?.harnessState?.ledger.length ?? 0).toBeLessThan(40);
      expect(loaded?.rootObjective).toContain('Context Harness sidecar');
      expect(loaded?.ledger.length ?? 0).toBeGreaterThanOrEqual(40);
    });

    test('resolveProjectPath returns a stable absolute path for non-git folders', () => {
      expect(resolveProjectPath('/tmp')).toBe(realpathSync('/tmp'));
    });
  });
});
