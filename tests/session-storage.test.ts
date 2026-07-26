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
  deleteSession,
  updateSessionSummary,
  truncateSessionToLastComplete,
  listProjectSessions,
  findSession,
  lookupSessionRef,
  renameSession,
  getLastSession,
  resumeSession,
  resolveProjectPath,
  updateSessionHarnessState,
  loadSessionHarnessState,
  type SessionMeta,
  type HistoryEntry,
  type SessionMessage,
} from '../src/services/session-storage';
import { loadSessionIndex, saveSessionIndex, searchSessions } from '../src/services/session-index';
import { createContextHarness } from '../src/harness';
import { existsSync, mkdirSync, readFileSync, rmSync, realpathSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  getProjectSessionCompactPath,
  getProjectSessionHarnessPath,
  getProjectSessionMessagesPath,
  getProjectSessionMetaPath,
} from '../src/services/config-dir';
import { createContextUsageSnapshot } from '../src/services/model-context';
import * as atomicWrite from '../src/services/atomic-write';

describe('session-storage', () => {
  // Use a unique test directory based on timestamp to avoid conflicts
  const testDir = join(homedir(), `.openhorse-test-session-${Date.now()}`);
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

    test('stores session meta in the project scope only', () => {
      const session = createSession('/tmp/project2', 'claude-sonnet');

      expect(session.projectKey).toBeDefined();
      expect(existsSync(getProjectSessionMetaPath(session.projectPath, session.id))).toBe(true);
      expect(existsSync(join(testDir, 'sessions', `${session.id}.json`))).toBe(false);
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
      expect(loadSessionHistory(session.id)).toEqual([
        { role: 'user', content: 'checkpoint-two' },
      ]);
      expect(readSessionMessages(session.id)).toHaveLength(3);
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
          if (path === compactPath) throw new Error('sidecar unavailable');
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
      expect(existsSync(compactPath)).toBe(true);

      expect(deleteSession(session.id)).toBe(true);
      expect(existsSync(compactPath)).toBe(false);
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

    test('readSessionMessages stops at a corrupt line to avoid orphaning later messages', () => {
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

      expect(readSessionMessages(session.id).map(message => message.content)).toEqual([
        'before corruption',
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
            { id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/large"}' } },
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
      const wrongProjectMatch = findSession(otherSession.id.slice(0, 8), '/tmp/project-find-current');
      const allProjectsMatch = findSession(otherSession.id.slice(0, 8), '/tmp/project-find-current', { allProjects: true });

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
      expect(findSession(session.id.slice(0, 8), '/tmp/project-index-sidecar')?.id).toBe(session.id);
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

      expect(truncated.map(message => message.content)).toEqual(['complete topic', 'complete answer']);
      expect(persisted).toHaveLength(2);
      expect(meta?.messageCount).toBe(2);
      expect(index?.topics).toContain('complete topic');
      expect(index?.topics).not.toContain('aborted topic');
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
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"bug.ts"}' } }],
        },
      ]);

      const truncated = truncateSessionToLastComplete(session.id);
      expect(truncated.map(message => message.content)).toEqual(['first question', 'done']);
      expect(readSessionMessages(session.id)).toHaveLength(2);
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
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'grep', arguments: '{"pattern":"foo"}' } }],
        },
        { role: 'tool', content: 'found foo in src/a.ts', timestamp: Date.now(), toolCallId: 'call-1' },
      ]);

      const truncated = truncateSessionToLastComplete(session.id);
      expect(truncated.map(message => message.content)).toEqual(['start', 'ok']);
      expect(readSessionMessages(session.id)).toHaveLength(2);
    });

    test('truncate: abort with only user message (no assistant response at all)', () => {
      const session = createSession('/tmp/project-abort-only-user', 'gpt-4o');
      appendSessionMessages(session.id, [
        { role: 'user', content: 'hello', timestamp: Date.now() },
      ]);

      const truncated = truncateSessionToLastComplete(session.id);
      expect(truncated).toHaveLength(0);
      expect(readSessionMessages(session.id)).toHaveLength(0);
    });

    test('truncate: complete final answer is NOT removed', () => {
      const session = createSession('/tmp/project-complete-not-truncated', 'gpt-4o');
      appendSessionMessages(session.id, [
        { role: 'user', content: 'question', timestamp: Date.now() },
        { role: 'assistant', content: 'Here is the answer with details.', timestamp: Date.now() },
      ]);

      const truncated = truncateSessionToLastComplete(session.id);
      expect(truncated.map(message => message.content)).toEqual(['question', 'Here is the answer with details.']);
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
        { role: 'assistant', content: '', timestamp: Date.now(), tool_calls: [
          { id: 'call-a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
          { id: 'call-b', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.ts"}' } },
        ] },
        { role: 'tool', content: 'content a', timestamp: Date.now(), toolCallId: 'call-a' },
        { role: 'tool', content: 'content b', timestamp: Date.now(), toolCallId: 'call-b' },
        { role: 'assistant', content: 'processing...', timestamp: Date.now(), tool_calls: [
          { id: 'call-c', type: 'function', function: { name: 'edit_file', arguments: '{"path":"a.ts","old_string":"x","new_string":"y"}' } },
        ] },
      ]);

      const truncated = truncateSessionToLastComplete(session.id);
      expect(truncated.map(message => message.content)).toEqual(['task 1', 'done 1']);
      expect(readSessionMessages(session.id)).toHaveLength(2);
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
      appendSessionMessage(sessionA.id, { role: 'user', content: 'billing query', timestamp: Date.now() + 1 });
      appendSessionMessage(sessionB.id, { role: 'user', content: 'billing query', timestamp: Date.now() + 2 });

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
      expect(tieResult).toEqual([sessionA.id < sessionB.id ? sessionA.id : sessionB.id, sessionA.id < sessionB.id ? sessionB.id : sessionA.id]);

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
        expect(result.matches.map(s => s.id)).toEqual(expect.arrayContaining(['abc111-session', 'abc222-session']));
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
      expect((meta?.harnessState?.ledger.length ?? 0)).toBeLessThan(40);
      expect(loaded?.rootObjective).toContain('Context Harness sidecar');
      expect((loaded?.ledger.length ?? 0)).toBeGreaterThanOrEqual(40);
    });

    test('resolveProjectPath returns a stable absolute path for non-git folders', () => {
      expect(resolveProjectPath('/tmp')).toBe(realpathSync('/tmp'));
    });
  });
});
