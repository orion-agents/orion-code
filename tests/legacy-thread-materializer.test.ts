import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import {
  loadThreadCutoverIndexV1,
  materializeLegacyThreadV1,
  planLegacyThreadMaterializationV1,
  resolveSessionStorageV1,
  type LegacyThreadMaterializationBoundaryV1,
} from '../src/runtime/legacy-thread-materializer';
import { ThreadEventStore } from '../src/runtime/thread-event-store';
import {
  getProjectSessionCompactPath,
  getProjectSessionGoalPath,
  getProjectSessionHarnessPath,
  getProjectSessionMessagesPath,
  getProjectSessionMetaPath,
  getProjectSessionTracePath,
  getProjectSessionsDir,
  getProjectThreadsV2Dir,
  getProjectThreadsV2IndexPath,
} from '../src/product/paths';

describe('legacy Thread materialization and atomic cutover', () => {
  let root: string;
  let projectPath: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-thread-materializer-'));
    projectPath = join(root, 'project');
    mkdirSync(projectPath, { recursive: true });
    previousConfigDir = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = join(root, 'config');
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
    else process.env.ORION_CODE_CONFIG_DIR = previousConfigDir;
    rmSync(root, { recursive: true, force: true });
  });

  test('dry-run produces deterministic content-bearing events without writes', () => {
    const sessionId = 'legacy-dry-run';
    writeLegacySession(sessionId);

    const first = planLegacyThreadMaterializationV1(projectPath, sessionId);
    const second = planLegacyThreadMaterializationV1(projectPath, sessionId);

    expect(first).toEqual(second);
    expect(existsSync(getProjectThreadsV2Dir(projectPath))).toBe(false);
    expect(first.events.map(event => event.seq)).toEqual(
      Array.from({ length: first.events.length }, (_, index) => index + 1)
    );
    expect(Object.values(first.projection.items)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', status: 'completed', content: 'hello' }),
        expect.objectContaining({ role: 'tool', status: 'completed', content: 'tool output' }),
        expect.objectContaining({ name: 'legacy_trace:tool_result', status: 'completed' }),
        expect.objectContaining({ name: 'legacy_compact', status: 'completed' }),
      ])
    );
    const toolItem = Object.values(first.projection.items).find(item => item.role === 'tool');
    expect(JSON.parse(toolItem?.receipt ?? '{}')).toMatchObject({
      legacyRecord: {
        toolCallId: 'call-1',
        modelVisibleContent: 'tool output',
      },
    });
  });

  test('materializes facts and projection before one generation-index cutover', () => {
    const sessionId = 'legacy-cutover';
    writeLegacySession(sessionId);
    const legacyMetaPath = getProjectSessionMetaPath(projectPath, sessionId);
    const legacyMessagesPath = getProjectSessionMessagesPath(projectPath, sessionId);
    const metaBefore = readFileSync(legacyMetaPath);
    const messagesBefore = readFileSync(legacyMessagesPath);

    expect(resolveSessionStorageV1(projectPath, sessionId)).toMatchObject({ kind: 'legacy' });
    const result = materializeLegacyThreadV1({ projectPath, sessionId });

    expect(result.mode).toBe('cutover');
    expect(result.index).toMatchObject({ generation: 1 });
    expect(resolveSessionStorageV1(projectPath, sessionId)).toMatchObject({
      kind: 'thread',
      threadId: result.plan.receipt.threadId,
      cursor: result.plan.events.length,
      projectionDigest: result.plan.projection.digest,
      generation: 1,
    });
    expect(readFileSync(legacyMetaPath)).toEqual(metaBefore);
    expect(readFileSync(legacyMessagesPath)).toEqual(messagesBefore);

    const store = new ThreadEventStore(
      getProjectThreadsV2Dir(projectPath),
      result.plan.receipt.threadId,
      { maxReplayEvents: result.plan.events.length }
    );
    expect(store.replay(0, result.plan.events.length).events).toEqual(result.plan.events);
    expect(store.loadProjection().digest).toBe(result.plan.projection.digest);

    const repeated = materializeLegacyThreadV1({ projectPath, sessionId });
    expect(repeated.mode).toBe('already_cutover');
    expect(repeated.index?.generation).toBe(1);
    expect(loadThreadCutoverIndexV1(projectPath).generation).toBe(1);
  });

  test('source recheck prevents cutover after legacy data changes', () => {
    const sessionId = 'legacy-source-race';
    writeLegacySession(sessionId);

    expect(() =>
      materializeLegacyThreadV1({
        projectPath,
        sessionId,
        onBoundary: boundary => {
          if (boundary === 'after_projection_verified') {
            appendFileSync(
              getProjectSessionMessagesPath(projectPath, sessionId),
              `${JSON.stringify({ role: 'assistant', content: 'late write', timestamp: 999 })}\n`
            );
          }
        },
      })
    ).toThrow('changed after v2 facts');
    expect(resolveSessionStorageV1(projectPath, sessionId)).toMatchObject({ kind: 'legacy' });
    expect(existsSync(getProjectThreadsV2IndexPath(projectPath))).toBe(false);
  });

  test('increments the project generation without replacing prior cutovers', () => {
    writeLegacySession('legacy-generation-a');
    writeLegacySession('legacy-generation-b');

    materializeLegacyThreadV1({ projectPath, sessionId: 'legacy-generation-a' });
    const second = materializeLegacyThreadV1({
      projectPath,
      sessionId: 'legacy-generation-b',
    });

    expect(second.index?.generation).toBe(2);
    expect(Object.keys(second.index?.sessions ?? {}).sort()).toEqual([
      'legacy-generation-a',
      'legacy-generation-b',
    ]);
    expect(resolveSessionStorageV1(projectPath, 'legacy-generation-a')).toMatchObject({
      kind: 'thread',
      generation: 2,
    });
    expect(resolveSessionStorageV1(projectPath, 'legacy-generation-b')).toMatchObject({
      kind: 'thread',
      generation: 2,
    });
  });

  test('keeps the imported prefix sealed while resolving the advancing live Thread head', () => {
    const sessionId = 'legacy-live-thread';
    writeLegacySession(sessionId);
    const result = materializeLegacyThreadV1({ projectPath, sessionId });
    const store = new ThreadEventStore(
      getProjectThreadsV2Dir(projectPath),
      result.plan.receipt.threadId,
      { maxReplayEvents: result.plan.events.length + 2 }
    );
    const turnId = randomUUID();
    store.appendDurableBatch([
      {
        turnId,
        payload: { type: 'turn.started', data: { input: 'new v2 work', mode: 'build' } },
      },
      { turnId, payload: { type: 'turn.completed', data: { outcome: 'advanced' } } },
    ]);

    const current = store.loadProjection();
    expect(resolveSessionStorageV1(projectPath, sessionId)).toMatchObject({
      kind: 'thread',
      threadId: result.plan.receipt.threadId,
      cursor: current.cursor,
      projectionDigest: current.digest,
    });
    expect(loadThreadCutoverIndexV1(projectPath).sessions[sessionId]).toMatchObject({
      cursor: result.plan.events.length,
      eventDigest: result.plan.eventDigest,
      projectionDigest: result.plan.projection.digest,
    });
  });

  test.each([
    'after_dry_run',
    'after_receipt_staged',
    'after_facts_materialized',
    'after_projection_verified',
    'after_source_recheck',
    'before_index_switch',
  ] as LegacyThreadMaterializationBoundaryV1[])(
    'a crash at %s leaves legacy as the sole readable generation',
    boundaryToCrash => {
      const sessionId = `legacy-crash-${boundaryToCrash}`;
      writeLegacySession(sessionId);
      expect(() =>
        materializeLegacyThreadV1({
          projectPath,
          sessionId,
          onBoundary: boundary => {
            if (boundary === boundaryToCrash) throw new Error(`crash:${boundary}`);
          },
        })
      ).toThrow(`crash:${boundaryToCrash}`);
      expect(resolveSessionStorageV1(projectPath, sessionId)).toMatchObject({ kind: 'legacy' });
    }
  );

  test('a crash after atomic index publication leaves Thread as the sole readable generation', () => {
    const sessionId = 'legacy-crash-after-index';
    writeLegacySession(sessionId);
    expect(() =>
      materializeLegacyThreadV1({
        projectPath,
        sessionId,
        onBoundary: boundary => {
          if (boundary === 'after_index_switch') throw new Error('crash:after_index_switch');
        },
      })
    ).toThrow('crash:after_index_switch');
    expect(resolveSessionStorageV1(projectPath, sessionId)).toMatchObject({ kind: 'thread' });
  });

  test('corrupt records and missing tool results become indeterminate, never completed', () => {
    const sessionId = 'legacy-indeterminate-materialized';
    writeLegacySession(sessionId);
    writeFileSync(
      getProjectSessionMessagesPath(projectPath, sessionId),
      [
        JSON.stringify({ role: 'user', content: 'run', timestamp: 1 }),
        JSON.stringify({
          role: 'assistant',
          content: '',
          timestamp: 2,
          tool_calls: [
            {
              id: 'missing-result',
              type: 'function',
              function: { name: 'exec_command', arguments: '{}' },
            },
          ],
        }),
        '{broken',
        '',
      ].join('\n'),
      'utf8'
    );

    const result = materializeLegacyThreadV1({ projectPath, sessionId });
    const indeterminateItems = Object.values(result.plan.projection.items).filter(
      item => item.status === 'indeterminate'
    );
    expect(indeterminateItems).toHaveLength(2);
    expect(
      Object.values(result.plan.projection.turns).some(turn => turn.status === 'interrupted')
    ).toBe(true);
    expect(resolveSessionStorageV1(projectPath, sessionId)).toMatchObject({ kind: 'thread' });
  });

  function writeLegacySession(sessionId: string): void {
    mkdirSync(getProjectSessionsDir(projectPath), { recursive: true });
    writeFileSync(
      getProjectSessionMetaPath(projectPath, sessionId),
      JSON.stringify({
        id: sessionId,
        projectPath: resolve(projectPath),
        model: 'test-model',
        startTime: 100,
        updatedAt: 200,
        tokenCount: 0,
        cost: 0,
      }),
      'utf8'
    );
    writeFileSync(
      getProjectSessionMessagesPath(projectPath, sessionId),
      [
        JSON.stringify({ role: 'user', content: 'hello', timestamp: 101 }),
        JSON.stringify({
          role: 'assistant',
          content: '',
          timestamp: 102,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"README.md"}' },
            },
          ],
        }),
        JSON.stringify({
          role: 'tool',
          content: 'tool output',
          modelVisibleContent: 'tool output',
          toolCallId: 'call-1',
          timestamp: 103,
        }),
        JSON.stringify({ role: 'assistant', content: 'done', timestamp: 104 }),
        '',
      ].join('\n'),
      'utf8'
    );
    writeFileSync(
      getProjectSessionTracePath(projectPath, sessionId),
      `${JSON.stringify({
        sessionId,
        turnId: '1',
        timestamp: 103,
        type: 'tool_result',
        callId: 'call-1',
        success: true,
      })}\n`,
      'utf8'
    );
    writeFileSync(getProjectSessionHarnessPath(projectPath, sessionId), '{"version":1}', 'utf8');
    writeFileSync(
      getProjectSessionCompactPath(projectPath, sessionId),
      '{"version":1,"checkpointId":"legacy-checkpoint"}',
      'utf8'
    );
    writeFileSync(
      getProjectSessionGoalPath(projectPath, sessionId),
      '{"version":1,"goalId":"legacy-goal"}',
      'utf8'
    );
  }
});
