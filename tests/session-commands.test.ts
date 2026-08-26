/**
 * Session command behavior tests.
 */

import { randomUUID } from 'crypto';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { findCommand } from '../src/commands';
import { Store } from '../src/framework/store';
import { TOOLS } from './support/legacy-tools';
import { loadConfig } from '../src/services/config';
import {
  appendSessionMessage,
  commitSessionCompactCheckpoint,
  createSession,
  listProjectSessions,
  loadSessionMeta,
  renameSession,
  type SessionMeta,
} from '../src/services/session-storage';
import type { CommandContext } from '../src/commands/types';
import type { RuntimeSessionRestoredEvent } from '../src/runtime/ui-events';
import { createContextUsageSnapshot } from '../src/services/model-context';
import { materializeLegacyThreadV1 } from '../src/runtime/legacy-thread-materializer';
import { getProjectThreadsV2Dir } from '../src/product/paths';
import { ThreadEventStore } from '../src/runtime/thread-event-store';
import { ThreadTurnCommitJournalV1 } from '../src/runtime/turn-commit';

describe('session commands', () => {
  const testConfigDir = mkdtempSync(join(tmpdir(), 'openhorse-session-commands-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'openhorse-project-'));
  const originalConfigDir = process.env.ORION_CODE_CONFIG_DIR;
  let logSpy: jest.SpyInstance;

  beforeAll(() => {
    process.env.ORION_CODE_CONFIG_DIR = testConfigDir;
  });

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  afterAll(() => {
    if (existsSync(testConfigDir)) {
      rmSync(testConfigDir, { recursive: true, force: true });
    }
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
    if (originalConfigDir !== undefined) {
      process.env.ORION_CODE_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.ORION_CODE_CONFIG_DIR;
    }
  });

  function makeContext(renderer: 'terminal' | 'tui' = 'terminal') {
    const config = loadConfig({
      apiKey: 'test-key',
      ui: { renderer, confirmations: 'config' },
    });
    const store = new Store({
      config,
      tools: TOOLS,
      currentModel: 'gpt-4o',
    });
    const restored: SessionMeta[] = [];
    const sessionRestored: RuntimeSessionRestoredEvent[] = [];
    const ctx: CommandContext = {
      cwd: projectDir,
      config,
      store,
      llm: null,
      setSession: session => restored.push(session),
      sessionRestored: event => sessionRestored.push(event),
      getSession: () => restored[restored.length - 1] ?? null,
    };

    return { ctx, restored, sessionRestored, store };
  }

  function createRestorableSession(content: string, withTool = false): SessionMeta {
    const session = createSession(projectDir, 'gpt-4o');
    appendSessionMessage(session.id, {
      role: 'user',
      content,
      timestamp: Date.now(),
    });
    if (withTool) {
      appendSessionMessage(session.id, {
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        tool_calls: [
          {
            id: 'call-read',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"package.json"}' },
          },
        ],
      });
    }
    return session;
  }

  function createV2OnlySession(userContent: string, assistantContent: string): SessionMeta {
    const session = createSession(projectDir, 'gpt-4o');
    const materialized = materializeLegacyThreadV1({
      projectPath: projectDir,
      sessionId: session.id,
    });
    const store = new ThreadEventStore(
      getProjectThreadsV2Dir(projectDir),
      materialized.plan.receipt.threadId,
      {
        clock: (() => {
          let timestamp = Date.now();
          return () => timestamp++;
        })(),
      }
    );
    const turnId = randomUUID();
    const userItemId = randomUUID();
    const assistantItemId = randomUUID();
    const userStepId = randomUUID();
    const assistantStepId = randomUUID();
    store.appendDurableBatch([
      {
        turnId,
        payload: { type: 'turn.started', data: { input: userContent, mode: 'build' } },
      },
      {
        turnId,
        stepId: userStepId,
        itemId: userItemId,
        payload: { type: 'item.started', data: { kind: 'message', role: 'user' } },
      },
      {
        turnId,
        stepId: userStepId,
        itemId: userItemId,
        payload: { type: 'item.completed', data: { content: userContent } },
      },
      {
        turnId,
        stepId: assistantStepId,
        itemId: assistantItemId,
        payload: { type: 'item.started', data: { kind: 'message', role: 'assistant' } },
      },
      {
        turnId,
        stepId: assistantStepId,
        itemId: assistantItemId,
        payload: { type: 'item.completed', data: { content: assistantContent } },
      },
    ]);
    new ThreadTurnCommitJournalV1(store).commit({
      turnId,
      history: [
        { role: 'user', content: userContent },
        { role: 'assistant', content: assistantContent },
      ],
      taskContextState: { ledger: [], updatedAt: Date.now() },
      taskContextRevision: 0,
      terminal: { status: 'completed', outcome: 'v2 session fixture complete' },
    });
    store.appendDurable({
      turnId,
      payload: { type: 'turn.completed', data: { outcome: 'v2 session fixture complete' } },
    });
    return session;
  }

  test('/resume returns an interactive picker request for terminal when multiple sessions exist', async () => {
    createRestorableSession('first restorable session');
    createRestorableSession('second restorable session');
    const { ctx } = makeContext('terminal');

    const result = await findCommand('resume')!.execute(ctx, '');

    expect(result.success).toBe(true);
    expect(result.sessionPicker).toBeDefined();
    expect(result.sessionPicker?.sessions).toHaveLength(2);
    expect(result.sessionPicker?.title).toBe('Pick a Session');
  });

  test('/resume returns an interactive picker request for tui when multiple sessions exist', async () => {
    createRestorableSession('first tui restorable session');
    createRestorableSession('second tui restorable session');
    const { ctx } = makeContext('tui');

    const result = await findCommand('resume')!.execute(ctx, '');

    expect(result.success).toBe(true);
    expect(result.sessionPicker).toBeDefined();
    expect(result.sessionPicker?.sessions.length).toBeGreaterThanOrEqual(2);
    expect(result.sessionPicker?.maxVisibleItems).toBe(10);
  });

  test('/resume can fall back to printed picker when renderer adapter disables structured pickers', async () => {
    createRestorableSession('first printed restorable session');
    createRestorableSession('second printed restorable session');
    const { ctx } = makeContext('terminal');
    ctx.uiCapabilities = { structuredPickers: false };

    const result = await findCommand('resume')!.execute(ctx, '');

    expect(result.success).toBe(true);
    expect(result.sessionPicker).toBeUndefined();
    expect(result.output ?? logSpy.mock.calls.flat().join('\n')).toContain(
      'Use /resume <number|session-id|name>'
    );
  });

  test('/resume <session-id> restores history and switches active session', async () => {
    const session = createRestorableSession(
      'restore this exact session apiKey=sk-testsecret123456',
      true
    );
    const { ctx, restored, sessionRestored, store } = makeContext('terminal');

    const result = await findCommand('resume')!.execute(ctx, session.id);

    expect(result.success).toBe(true);
    expect(restored[0]?.id).toBe(session.id);
    expect(sessionRestored).toHaveLength(1);
    expect(sessionRestored[0]).toMatchObject({
      sessionId: session.id,
      projectPath: session.projectPath,
      model: 'gpt-4o',
      messageCount: 2,
      restoredMessages: 3,
      transcriptMessages: 2,
      summaryCoveredMessages: 2,
      summarySource: 'resume_heuristic',
      summary: 'Tools: read_file',
    });
    expect(sessionRestored[0].summary).not.toContain('restore this exact session');
    expect(sessionRestored[0].summary).not.toContain('sk-testsecret');
    const printed = result.output ?? logSpy.mock.calls.flat().join('\n');
    expect(printed).toContain('apiKey=[REDACTED_SECRET]');
    expect(printed).not.toContain('sk-testsecret');
    const restoredHistory = store.getSnapshot().conversationHistory;
    expect(restoredHistory.slice(0, 2)).toEqual([
      { role: 'user', content: 'restore this exact session apiKey=sk-testsecret123456' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-read',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"package.json"}' },
          },
        ],
      },
    ]);
    expect(restoredHistory).toHaveLength(3);
    expect(restoredHistory[2]).toMatchObject({ role: 'tool', tool_call_id: 'call-read' });
    expect(JSON.parse(restoredHistory[2].content)).toMatchObject({
      success: false,
      status: 'cancelled',
    });
  });

  test('/resume reports persisted compact summary provenance and restore counts', async () => {
    const session = createRestorableSession('checkpoint source one');
    appendSessionMessage(session.id, {
      role: 'assistant',
      content: 'checkpoint source two',
      timestamp: Date.now(),
    });
    const beforeUsage = createContextUsageSnapshot({
      modelId: 'gpt-4o',
      usedTokens: 110000,
      outputReserveTokens: 4096,
    });
    const afterUsage = createContextUsageSnapshot({
      modelId: 'gpt-4o',
      usedTokens: 1000,
      outputReserveTokens: 4096,
    });
    const checkpoint = commitSessionCompactCheckpoint({
      sessionId: session.id,
      mode: 'threshold',
      modelId: 'gpt-4o',
      sourceMessageCount: 2,
      transcriptStartMessageIndex: 1,
      modelHistory: [{ role: 'user', content: '[Context Summary]\ndurable summary' }],
      summary: {
        text: 'durable summary',
        generatedAt: 123456789,
        source: 'llm',
      },
      beforeUsage,
      afterUsage,
    });
    const { ctx, sessionRestored, store } = makeContext('terminal');

    const result = await findCommand('resume')!.execute(ctx, session.id);

    expect(result.success).toBe(true);
    expect(sessionRestored[0]).toMatchObject({
      summary: 'durable summary',
      summaryGeneratedAt: 123456789,
      summarySource: 'llm',
      summaryCoveredMessages: 2,
      checkpointId: checkpoint.checkpointId,
      restoredMessages: 1,
      transcriptMessages: 1,
    });
    expect(store.getSnapshot().conversationHistory).toEqual([
      { role: 'user', content: '[Context Summary]\ndurable summary' },
    ]);
    const printed = result.output ?? logSpy.mock.calls.flat().join('\n');
    expect(printed).toContain('(compact checkpoint)');
    expect(printed).toContain('Covers: 2 source messages');
    expect(printed).toContain('Restored 1 model-context messages / 1 transcript messages');
  });

  test('/resume --last discovers and restores a v2-only Thread without a legacy JSONL', async () => {
    const session = createV2OnlySession('v2-only user context', 'v2-only durable answer');
    const { ctx, restored, sessionRestored, store } = makeContext('terminal');

    const listed = listProjectSessions(projectDir).find(candidate => candidate.id === session.id);
    const result = await findCommand('resume')!.execute(ctx, '--last');

    expect(listed).toMatchObject({
      id: session.id,
      messageCount: 2,
      historySizeBytes: expect.any(Number),
    });
    expect(listed?.historySizeBytes).toBeGreaterThan(0);
    expect(result.success).toBe(true);
    expect(restored.at(-1)?.id).toBe(session.id);
    expect(sessionRestored.at(-1)).toMatchObject({
      sessionId: session.id,
      restoredMessages: 2,
      transcriptMessages: 2,
      messageCount: 2,
    });
    expect(store.getSnapshot().conversationHistory).toEqual([
      { role: 'user', content: 'v2-only user context' },
      { role: 'assistant', content: 'v2-only durable answer' },
    ]);
    expect(result.output).not.toContain('No messages in session');
  });

  test('/session rename accepts a picker number and synchronizes the active session', async () => {
    const active = createRestorableSession('rename active session');
    const { ctx, restored } = makeContext('terminal');
    ctx.setSession?.(active);

    const result = await findCommand('session')!.execute(ctx, 'rename #1 pixel command center');

    expect(result.success).toBe(true);
    expect(loadSessionMeta(active.id)?.name).toBe('pixel command center');
    expect(restored.at(-1)).toMatchObject({ id: active.id, name: 'pixel command center' });
  });

  test('/session rename accepts a full session id', async () => {
    const session = createRestorableSession('compound rename target');
    const { ctx } = makeContext('terminal');

    const result = await findCommand('session')!.execute(
      ctx,
      `rename ${session.id} compound command`
    );

    expect(result.success).toBe(true);
    expect(loadSessionMeta(session.id)?.name).toBe('compound command');
  });

  test('/session rename reports ambiguous names without modifying either session', async () => {
    const first = createRestorableSession('first duplicate target');
    const second = createRestorableSession('second duplicate target');
    renameSession(first.id, 'duplicate-name');
    renameSession(second.id, 'duplicate-name');
    const { ctx } = makeContext('terminal');

    const result = await findCommand('session')!.execute(
      ctx,
      'rename duplicate-name must-not-apply'
    );

    expect(result.success).toBe(false);
    expect(loadSessionMeta(first.id)?.name).toBe('duplicate-name');
    expect(loadSessionMeta(second.id)?.name).toBe('duplicate-name');
  });

  test('/session rename honors --project and --all lookup scopes', async () => {
    const otherProject = mkdtempSync(join(tmpdir(), 'openhorse-rename-other-'));
    try {
      const other = createSession(otherProject, 'gpt-4o');
      const { ctx } = makeContext('terminal');

      const projectResult = await findCommand('session')!.execute(
        ctx,
        `rename ${other.id} scoped-name --project ${otherProject}`
      );
      const allResult = await findCommand('session')!.execute(
        ctx,
        `rename ${other.id} all-project-name --all`
      );

      expect(projectResult.success).toBe(true);
      expect(allResult.success).toBe(true);
      expect(loadSessionMeta(other.id)?.name).toBe('all-project-name');
    } finally {
      rmSync(otherProject, { recursive: true, force: true });
    }
  });
});
