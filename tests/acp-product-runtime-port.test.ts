import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { AgentRuntimeRunnerV1 } from '../src/runtime/agent-runtime-runner';
import type { OrionCodeUiRuntime, UiEventSink } from '../src/runtime/ui-events';
import type { SessionMessage, SessionMeta } from '../src/services/session-storage';
import {
  ProductOrionAcpRuntimePort,
  type ProductOrionAcpRuntimeDependencies,
} from '../src/acp/product-runtime-port';
import type {
  OrionAcpMcpServer,
  OrionAcpRuntimeObserver,
  OrionAcpSessionUpdate,
} from '../src/acp/runtime-port';

describe('ProductOrionAcpRuntimePort session manager', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test('runs two sessions independently and cancellation stays session-scoped', async () => {
    const firstCwd = temporaryDirectory('first');
    const secondCwd = temporaryDirectory('second');
    const harness = createHarness();
    const port = new ProductOrionAcpRuntimePort(harness.dependencies);
    const first = await port.createSession({
      cwd: firstCwd,
      mcpServers: [],
    });
    const second = await port.createSession({
      cwd: secondCwd,
      mcpServers: [],
    });
    const observer = createObserver();

    const blockedPrompt = port.prompt({
      sessionId: first.sessionId,
      prompt: [{ type: 'text', text: 'block' }],
      observer,
    });
    const completedPrompt = port.prompt({
      sessionId: second.sessionId,
      prompt: [{ type: 'text', text: 'continue' }],
      observer,
    });
    await port.cancel(first.sessionId);

    await expect(blockedPrompt).resolves.toBe('cancelled');
    await expect(completedPrompt).resolves.toBe('end_turn');
    expect(harness.interrupted).toEqual([first.sessionId]);
    expect(harness.inputs).toEqual([
      [first.sessionId, 'block'],
      [second.sessionId, 'continue'],
    ]);

    await port.close();
    expect(new Set(harness.released)).toEqual(new Set([first.sessionId, second.sessionId]));
  });

  test('waits for an opening session and rolls its resources back when close wins', async () => {
    const cwd = temporaryDirectory('opening-close');
    const leaseStarted = createDeferred();
    const releaseLease = createDeferred();
    const harness = createHarness();
    const createRuntime = harness.dependencies.createRuntime;
    const port = new ProductOrionAcpRuntimePort({
      ...harness.dependencies,
      createRuntime: async bootstrap => {
        const runtime = await createRuntime(bootstrap);
        const activateSession = runtime.activateSession;
        runtime.activateSession = async (session, activation) => {
          leaseStarted.resolve();
          await releaseLease.promise;
          if (!activateSession) throw new Error('test runtime activation is unavailable');
          await activateSession(session, activation);
        };
        return runtime;
      },
    });

    const opening = port.createSession({ cwd, mcpServers: [] });
    await leaseStarted.promise;
    const closing = port.close();
    await expectPending(closing);

    releaseLease.resolve();
    await expect(opening).rejects.toMatchObject({ code: 'ORION_ACP_CLOSED' });
    await expect(closing).resolves.toBeUndefined();
    expect(harness.released).toEqual(['session-1']);
    expect(harness.shutdown).toEqual(['session-1']);
  });

  test('waits for load replay before closing that session', async () => {
    const cwd = temporaryDirectory('load-close');
    const restoreStarted = createDeferred();
    const releaseRestore = createDeferred();
    const loadedSession = createSessionMeta('session-loaded', cwd);
    const harness = createHarness({
      loadedSession,
      restoreSession: async () => {
        restoreStarted.resolve();
        await releaseRestore.promise;
      },
    });
    const port = new ProductOrionAcpRuntimePort(harness.dependencies);

    const loading = port.loadSession({
      sessionId: loadedSession.id,
      cwd,
      mcpServers: [],
      observer: createObserver(),
    });
    await restoreStarted.promise;
    const closing = port.closeSession(loadedSession.id);
    await expectPending(closing);

    releaseRestore.resolve();
    await expect(loading).resolves.toBeUndefined();
    await expect(closing).resolves.toBeUndefined();
    expect(harness.released).toEqual([loadedSession.id]);
    expect(harness.shutdown).toEqual([loadedSession.id]);
    await port.close();
  });

  test('forwards the stable runtime invocation id to the ACP permission observer', async () => {
    const cwd = temporaryDirectory('permission');
    const harness = createHarness({ requestPermission: true });
    const port = new ProductOrionAcpRuntimePort(harness.dependencies);
    const created = await port.createSession({ cwd, mcpServers: [] });
    const requests: string[] = [];

    await expect(
      port.prompt({
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'permission' }],
        observer: createObserver(async request => {
          requests.push(`${request.requestId}:${request.toolCallId}`);
          return true;
        }),
      })
    ).resolves.toBe('end_turn');
    expect(requests).toEqual(['invocation-permission:invocation-permission']);
    await port.close();
  });

  test('passes stdio MCP configuration to the session runtime and rejects unsupported transports', async () => {
    const cwd = temporaryDirectory('unsupported');
    const harness = createHarness();
    const port = new ProductOrionAcpRuntimePort(harness.dependencies);
    const stdioServer = {
      name: 'fixture',
      command: process.execPath,
      args: ['fixture.mjs'],
      env: [{ name: 'FIXTURE_VALUE', value: 'expected' }],
    } as const;

    const created = await port.createSession({ cwd, mcpServers: [stdioServer] });
    expect(harness.bootstrapOptions[0].mcpConfiguration).toEqual({
      mcpServers: {
        'acp-session-0001': {
          type: 'stdio',
          name: 'fixture',
          command: process.execPath,
          args: ['fixture.mjs'],
          env: { FIXTURE_VALUE: 'expected' },
        },
      },
    });
    await port.closeSession(created.sessionId);

    await expect(
      port.createSession({
        cwd,
        mcpServers: [
          {
            type: 'http',
            name: 'remote',
            url: 'https://example.invalid/mcp',
            headers: [],
          },
        ],
      })
    ).rejects.toMatchObject({
      code: 'ORION_ACP_MCP_UNSUPPORTED_TRANSPORT',
    });
    await expect(
      port.createSession({
        cwd,
        mcpServers: [
          {
            type: 'websocket',
            name: 'undeclared',
            url: 'wss://example.invalid/mcp',
          } as unknown as OrionAcpMcpServer,
        ],
      })
    ).rejects.toMatchObject({
      code: 'ORION_ACP_MCP_UNSUPPORTED_TRANSPORT',
    });
    await expect(
      port.createSession({ cwd, mcpServers: [], additionalDirectories: [cwd] })
    ).rejects.toMatchObject({
      code: 'ORION_ACP_ADDITIONAL_DIRECTORIES_UNSUPPORTED',
    });
    expect(harness.createdSessions).toEqual([created.sessionId]);
  });

  test('replays durable user, assistant, and tool history in order without a runner', async () => {
    const cwd = temporaryDirectory('durable-replay');
    const loadedSession = createSessionMeta('session-history', cwd);
    const transcriptMessages: SessionMessage[] = [
      { role: 'user', content: 'inspect', timestamp: 1 },
      {
        role: 'assistant',
        content: 'checking',
        timestamp: 2,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
          },
        ],
      },
      { role: 'tool', content: 'file body', timestamp: 3, toolCallId: 'call-1' },
      { role: 'assistant', content: 'done', timestamp: 4 },
    ];
    const updates: OrionAcpSessionUpdate[] = [];
    const harness = createHarness({ loadedSession, runnerAvailable: false, transcriptMessages });
    const port = new ProductOrionAcpRuntimePort(harness.dependencies);

    await port.loadSession({
      sessionId: loadedSession.id,
      cwd,
      mcpServers: [],
      observer: createObserverWithUpdates(updates),
    });

    expect(updates.map(update => update.sessionUpdate)).toEqual([
      'user_message_chunk',
      'agent_message_chunk',
      'tool_call',
      'tool_call_update',
      'agent_message_chunk',
    ]);
    expect(updates[2]).toMatchObject({
      toolCallId: 'call-1',
      title: 'read_file',
      rawInput: { path: 'a.ts' },
    });
    expect(updates[3]).toMatchObject({
      toolCallId: 'call-1',
      status: 'completed',
      rawOutput: 'file body',
    });
    await port.close();
  });

  test('reports busy while load restore is incomplete', async () => {
    const cwd = temporaryDirectory('load-busy');
    const restoreStarted = createDeferred();
    const releaseRestore = createDeferred();
    const loadedSession = createSessionMeta('session-busy', cwd);
    const harness = createHarness({
      loadedSession,
      restoreSession: async () => {
        restoreStarted.resolve();
        await releaseRestore.promise;
      },
    });
    const port = new ProductOrionAcpRuntimePort(harness.dependencies);
    const loading = port.loadSession({
      sessionId: loadedSession.id,
      cwd,
      mcpServers: [],
      observer: createObserver(),
    });
    await restoreStarted.promise;

    await expect(
      port.prompt({
        sessionId: loadedSession.id,
        prompt: [{ type: 'text', text: 'too soon' }],
        observer: createObserver(),
      })
    ).rejects.toMatchObject({ code: 'ORION_ACP_SESSION_BUSY' });

    releaseRestore.resolve();
    await expect(loading).resolves.toBeUndefined();
    await port.close();
  });

  test('releases runtime and lease exactly once when restore fails', async () => {
    const cwd = temporaryDirectory('restore-failure');
    const loadedSession = createSessionMeta('session-restore-failure', cwd);
    const harness = createHarness({
      loadedSession,
      restoreSession: async () => {
        throw new Error('restore failed');
      },
    });
    const port = new ProductOrionAcpRuntimePort(harness.dependencies);

    await expect(
      port.loadSession({
        sessionId: loadedSession.id,
        cwd,
        mcpServers: [],
        observer: createObserver(),
      })
    ).rejects.toThrow('restore failed');
    expect(harness.shutdown).toEqual([loadedSession.id]);
    expect(harness.released).toEqual([loadedSession.id]);

    await port.closeSession(loadedSession.id);
    await port.close();
    expect(harness.shutdown).toEqual([loadedSession.id]);
    expect(harness.released).toEqual([loadedSession.id]);
  });

  function temporaryDirectory(label: string): string {
    const root = mkdtempSync(join(tmpdir(), `orion-acp-port-${label}-`));
    roots.push(root);
    return root;
  }
});

function createObserver(
  permission: OrionAcpRuntimeObserver['requestPermission'] = async () => false
): OrionAcpRuntimeObserver {
  return {
    update: async () => undefined,
    requestPermission: permission,
  };
}

function createObserverWithUpdates(updates: OrionAcpSessionUpdate[]): OrionAcpRuntimeObserver {
  return {
    update: async update => {
      updates.push(update);
    },
    requestPermission: async () => false,
  };
}

function createHarness(
  options: {
    requestPermission?: boolean;
    loadedSession?: SessionMeta;
    restoreSession?: () => Promise<void>;
    runnerAvailable?: boolean;
    transcriptMessages?: readonly SessionMessage[];
  } = {}
) {
  let nextSession = 1;
  const createdSessions: string[] = [];
  const released: string[] = [];
  const interrupted: string[] = [];
  const inputs: Array<[string, string]> = [];
  const shutdown: string[] = [];
  const bootstrapOptions: Parameters<ProductOrionAcpRuntimeDependencies['createRuntime']>[0][] = [];

  const dependencies: ProductOrionAcpRuntimeDependencies = {
    loadSessionMeta: sessionId =>
      options.loadedSession?.id === sessionId ? options.loadedSession : null,
    resumeSession: sessionId =>
      options.loadedSession?.id === sessionId ? options.loadedSession : null,
    loadSessionTranscriptMessages: sessionId =>
      options.loadedSession?.id === sessionId ? (options.transcriptMessages ?? []) : [],
    createRuntime: async bootstrap => {
      bootstrapOptions.push(bootstrap);
      const sessionId = `session-${nextSession++}`;
      let session = createSessionMeta(sessionId, bootstrap.cwd);
      let ownedSessionId: string | undefined;
      let closed = false;
      createdSessions.push(sessionId);
      let sink: UiEventSink | undefined;
      let approvalHandler:
        | ((request: {
            id: string;
            name: string;
            args: Readonly<Record<string, unknown>>;
          }) => boolean | Promise<boolean>)
        | undefined;
      const runner: AgentRuntimeRunnerV1 = {
        runInput: async (input, runOptions) => {
          inputs.push([sessionId, input]);
          if (options.requestPermission && input === 'permission') {
            await approvalHandler?.({
              id: 'invocation-permission',
              name: 'write_file',
              args: { path: 'a.ts' },
            });
          }
          if (input === 'block') {
            await new Promise<void>(resolve => {
              const signal = runOptions?.abortSignal;
              if (signal?.aborted) resolve();
              else signal?.addEventListener('abort', () => resolve(), { once: true });
            });
          }
          sink?.append({ role: 'assistant', content: `completed:${input}` });
        },
        interrupt: () => {
          interrupted.push(sessionId);
        },
        restoreSession: options.restoreSession,
      };
      return {
        cwd: bootstrap.cwd,
        version: 'test',
        createAgentRunner:
          options.runnerAvailable === false
            ? undefined
            : (
                events: UiEventSink,
                runnerOptions: Parameters<NonNullable<OrionCodeUiRuntime['createAgentRunner']>>[1]
              ) => {
                sink = events;
                approvalHandler = runnerOptions.approvalHandler;
                return runner;
              },
        ensureSession: () => session,
        setSession: (resumed: SessionMeta) => {
          session = resumed;
        },
        getSession: () => session,
        activateSession: async (resumed: SessionMeta) => {
          session = resumed;
          ownedSessionId = resumed.id;
        },
        releaseSession: async () => {
          if (ownedSessionId) released.push(ownedSessionId);
          ownedSessionId = undefined;
        },
        shutdown: async () => {
          if (closed) return;
          closed = true;
          shutdown.push(session.id);
          if (ownedSessionId) released.push(ownedSessionId);
          ownedSessionId = undefined;
        },
      } as unknown as OrionCodeUiRuntime;
    },
  };

  return {
    dependencies,
    createdSessions,
    released,
    interrupted,
    inputs,
    shutdown,
    bootstrapOptions,
  };
}

function createDeferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => {
    resolve = () => complete();
  });
  return { promise, resolve };
}

async function expectPending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(settled).toBe(false);
}

function createSessionMeta(id: string, cwd: string): SessionMeta {
  return {
    id,
    projectPath: cwd,
    cwd,
    model: 'test',
    startTime: 0,
    tokenCount: 0,
    cost: 0,
  };
}
