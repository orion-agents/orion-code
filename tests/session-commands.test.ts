/**
 * Session command behavior tests.
 */

import { randomUUID } from 'crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { findCommand } from '../src/commands';
import { Store } from '../src/framework/store';
import { TOOLS } from './support/legacy-tools';
import { loadConfig } from '../src/services/config';
import {
  appendSessionMessage,
  appendSessionMessages,
  commitSessionCompactCheckpoint,
  createSession,
  listProjectSessions,
  loadSessionHistoryWithDiagnostics,
  loadSessionMeta,
  loadSessionRestoreBundle,
  renameSession,
  type SessionMeta,
} from '../src/services/session-storage';
import type { CommandContext } from '../src/commands/types';
import type { RuntimeSessionRestoredEvent, TranscriptEntry } from '../src/runtime/ui-events';
import { createContextUsageSnapshot } from '../src/services/model-context';
import { materializeLegacyThreadV1 } from '../src/runtime/legacy-thread-materializer';
import type { ThreadSessionRuntimeActivationV1 } from '../src/runtime/thread-session-view';
import { getProjectSessionMetaPath, getProjectThreadsV2Dir } from '../src/product/paths';
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
    const transcriptReplacements: TranscriptEntry[][] = [];
    const ctx: CommandContext = {
      cwd: projectDir,
      config,
      store,
      llm: null,
      setSession: session => restored.push(session),
      sessionRestored: event => sessionRestored.push(event),
      replaceTranscript: entries => transcriptReplacements.push([...entries]),
      getSession: () => restored[restored.length - 1] ?? null,
    };

    return { ctx, restored, sessionRestored, transcriptReplacements, store };
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
      projectPath: realpathSync(projectDir),
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

  function createIncompleteV2Session(): SessionMeta {
    const session = createSession(projectDir, 'gpt-4o');
    appendSessionMessages(session.id, [
      { role: 'user', content: 'resume an interrupted tool turn', timestamp: Date.now() },
      {
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        tool_calls: [
          {
            id: 'call-interrupted',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"package.json"}' },
          },
        ],
      },
    ]);
    materializeLegacyThreadV1({ projectPath: projectDir, sessionId: session.id });
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
    const updatedAtBeforeResume = loadSessionMeta(session.id)?.updatedAt;

    const result = await findCommand('resume')!.execute(ctx, session.id);

    expect(result.success).toBe(true);
    expect(loadSessionMeta(session.id)?.updatedAt).toBe(updatedAtBeforeResume);
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

  test('/resume hands the verified legacy cutover Store to the replacement Runtime', async () => {
    const session = createRestorableSession('activation hand-off context');
    const { ctx, restored } = makeContext('terminal');
    let activation: ThreadSessionRuntimeActivationV1 | undefined;
    ctx.restoreSessionRuntime = async candidate => {
      activation = candidate;
    };

    const result = await findCommand('resume')!.execute(ctx, session.id);

    expect(result.success).toBe(true);
    expect(restored.at(-1)?.id).toBe(session.id);
    expect(activation).toMatchObject({
      version: 1,
      projectPath: realpathSync(projectDir),
      sessionId: session.id,
      threadId: expect.any(String),
      cursor: expect.any(Number),
      projectionDigest: expect.any(String),
      cutoverGeneration: expect.any(Number),
    });
    expect(activation?.store.threadId).toBe(activation?.threadId);
  });

  test('/resume bounds renderer history while preserving complete model context', async () => {
    const session = createSession(projectDir, 'gpt-4o');
    const messages = Array.from({ length: 80 }, (_, index) => ({
      role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: index === 79 ? 'x'.repeat(100 * 1024) : `history-${index}`,
      timestamp: Date.now() + index,
    }));
    appendSessionMessages(session.id, messages);
    const { ctx, sessionRestored, transcriptReplacements, store } = makeContext('terminal');

    const result = await findCommand('resume')!.execute(ctx, session.id);

    expect(result.success).toBe(true);
    expect(store.getSnapshot().conversationHistory).toHaveLength(80);
    expect(store.getSnapshot().conversationHistory.at(-1)?.content).toHaveLength(100 * 1024);
    expect(transcriptReplacements).toHaveLength(1);
    expect(transcriptReplacements[0]).toHaveLength(50);
    expect(transcriptReplacements[0][0]).toMatchObject({
      id: `resume:${session.id}:31`,
      role: 'user',
      content: 'history-30',
    });
    expect(transcriptReplacements[0].at(-1)?.content).toContain(
      '[display truncated; full content remains durable]'
    );
    expect(
      transcriptReplacements[0].reduce(
        (bytes, entry) => bytes + Buffer.byteLength(entry.content, 'utf8') + 128,
        0
      )
    ).toBeLessThanOrEqual(256 * 1024);
    expect(sessionRestored[0]).toMatchObject({
      restoredMessages: 80,
      transcriptMessages: 80,
      visibleTranscriptMessages: 50,
      transcriptTruncated: true,
    });
    expect(result.output).toContain('Display: showing recent 50');
  });

  test('reopening an unchanged v2 restore bundle does not rewrite its catalog metadata', () => {
    const session = createRestorableSession('idempotent restore bundle');
    materializeLegacyThreadV1({ projectPath: projectDir, sessionId: session.id });
    const first = loadSessionRestoreBundle(session.id);
    expect(first.runtimeActivation).toBeDefined();
    const metaPath = getProjectSessionMetaPath(projectDir, session.id);
    const before = statSync(metaPath, { bigint: true }).mtimeNs;

    const second = loadSessionRestoreBundle(session.id);
    const after = statSync(metaPath, { bigint: true }).mtimeNs;

    expect(second.runtimeActivation).toBeDefined();
    expect(after).toBe(before);
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

    // Listing consumes only the bounded catalog read model. This fixture writes
    // a v2 Thread directly, so the pre-v0.3 metadata is repaired lazily by the
    // selected restore rather than replaying every Thread in the picker.
    expect(listed).toMatchObject({ id: session.id, messageCount: 0 });
    expect(result.success).toBe(true);
    expect(loadSessionMeta(session.id)).toMatchObject({
      messageCount: 2,
      historySizeBytes: expect.any(Number),
      threadReadModel: { cursor: expect.any(Number), projectionDigest: expect.any(String) },
    });
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

  test('/resume --last repairs a stale empty read model after a durable Thread append', async () => {
    const session = createSession(projectDir, 'gpt-4o');
    const materialized = materializeLegacyThreadV1({
      projectPath: projectDir,
      sessionId: session.id,
    });

    expect(loadSessionHistoryWithDiagnostics(session.id).messages).toEqual([]);
    const stale = loadSessionMeta(session.id);
    expect(stale).toMatchObject({
      messageCount: 0,
      threadReadModel: { cursor: materialized.plan.events.length },
    });

    const store = new ThreadEventStore(
      getProjectThreadsV2Dir(projectDir),
      materialized.plan.receipt.threadId
    );
    const turnId = randomUUID();
    const userItemId = randomUUID();
    const assistantItemId = randomUUID();
    const userStepId = randomUUID();
    const assistantStepId = randomUUID();
    store.appendDurableBatch([
      {
        turnId,
        payload: { type: 'turn.started', data: { input: 'crash-gap input', mode: 'build' } },
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
        payload: { type: 'item.completed', data: { content: 'crash-gap input' } },
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
        payload: { type: 'item.completed', data: { content: 'crash-gap output' } },
      },
    ]);
    new ThreadTurnCommitJournalV1(store).commit({
      turnId,
      history: [
        { role: 'user', content: 'crash-gap input' },
        { role: 'assistant', content: 'crash-gap output' },
      ],
      taskContextState: { ledger: [], updatedAt: Date.now() },
      taskContextRevision: 0,
      terminal: { status: 'completed', outcome: 'crash-gap fixture complete' },
    });
    store.appendDurable({
      turnId,
      payload: { type: 'turn.completed', data: { outcome: 'crash-gap fixture complete' } },
    });

    // Simulate a process crash after the Thread commit but before catalog refresh.
    expect(loadSessionMeta(session.id)).toMatchObject({
      messageCount: 0,
      threadReadModel: { cursor: stale?.threadReadModel?.cursor },
    });

    const { ctx, restored, store: uiStore } = makeContext('terminal');
    const result = await findCommand('resume')!.execute(ctx, '--last');

    expect(result.success).toBe(true);
    expect(restored.at(-1)?.id).toBe(session.id);
    expect(uiStore.getSnapshot().conversationHistory).toEqual([
      { role: 'user', content: 'crash-gap input' },
      { role: 'assistant', content: 'crash-gap output' },
    ]);
    expect(loadSessionMeta(session.id)).toMatchObject({
      messageCount: 2,
      threadReadModel: { cursor: store.getCursor() },
    });
  });

  test('/resume --last isolates an incomplete historical Thread and restores the healthy latest session', async () => {
    const incomplete = createIncompleteV2Session();
    const healthy = createV2OnlySession('healthy latest context', 'healthy durable answer');
    const { ctx, restored, store } = makeContext('terminal');

    const listed = listProjectSessions(projectDir);
    const result = await findCommand('resume')!.execute(ctx, '--last');

    expect(listed.map(session => session.id)).toEqual(
      expect.arrayContaining([incomplete.id, healthy.id])
    );
    expect(listed.find(session => session.id === incomplete.id)).toMatchObject({ messageCount: 2 });
    expect(result.success).toBe(true);
    expect(restored.at(-1)?.id).toBe(healthy.id);
    expect(store.getSnapshot().conversationHistory).toEqual([
      { role: 'user', content: 'healthy latest context' },
      { role: 'assistant', content: 'healthy durable answer' },
    ]);
  });

  test('/resume repairs an incomplete v2 tool group and reports the recovery', async () => {
    const incomplete = createIncompleteV2Session();
    const { ctx, sessionRestored, store } = makeContext('terminal');

    const result = await findCommand('resume')!.execute(ctx, incomplete.id);
    const loaded = loadSessionHistoryWithDiagnostics(incomplete.id);

    expect(result.success).toBe(true);
    expect(loaded.source).toBe('transcript_repaired');
    expect(loaded.diagnostics).toEqual([
      expect.objectContaining({ code: 'tool_call_groups_repaired' }),
    ]);
    expect(store.getSnapshot().conversationHistory.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-interrupted',
    });
    expect(sessionRestored.at(-1)?.warnings).toEqual([
      expect.stringContaining('Recovered incomplete tool-call results'),
    ]);
    expect(result.output).toContain('Recovered incomplete tool-call results');
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
