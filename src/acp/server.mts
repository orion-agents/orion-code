import { Readable, Writable } from 'node:stream';
import { createRequire } from 'node:module';

import * as acp from '@agentclientprotocol/sdk';

type OrionAcpSessionUpdate = acp.SessionUpdate;
type OrionAcpPromptContent = acp.ContentBlock;

interface OrionAcpPermissionRequest {
  readonly requestId: string;
  readonly toolCallId: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly reason?: string;
  readonly signal?: AbortSignal;
}

interface OrionAcpRuntimeObserver {
  update(update: OrionAcpSessionUpdate): Promise<void>;
  requestPermission(request: OrionAcpPermissionRequest): Promise<boolean>;
}

interface OrionAcpRuntimePort {
  createSession(input: {
    readonly cwd: string;
    readonly mcpServers: readonly acp.McpServer[];
    readonly additionalDirectories?: readonly string[];
  }): Promise<{ readonly sessionId: string }>;
  loadSession(input: {
    readonly sessionId: string;
    readonly cwd: string;
    readonly mcpServers: readonly acp.McpServer[];
    readonly additionalDirectories?: readonly string[];
    readonly observer: OrionAcpRuntimeObserver;
  }): Promise<void>;
  prompt(input: {
    readonly sessionId: string;
    readonly prompt: readonly OrionAcpPromptContent[];
    readonly observer: OrionAcpRuntimeObserver;
    readonly signal?: AbortSignal;
  }): Promise<acp.StopReason>;
  cancel(sessionId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

const require = createRequire(import.meta.url);
const { PACKAGE_VERSION } = require('../product/version.js') as { PACKAGE_VERSION: string };
const { createProductOrionAcpRuntimePort } = require('./product-runtime-port.js') as {
  createProductOrionAcpRuntimePort: () => OrionAcpRuntimePort;
};

const PERMISSION_TIMEOUT_MS = 60_000;

export function createOrionAcpAgentApp(
  runtimePort: OrionAcpRuntimePort = createProductOrionAcpRuntimePort()
): acp.AgentApp {
  return acp
    .agent({ name: 'orion-code' })
    .onRequest(acp.methods.agent.initialize, ({ params }) => ({
      protocolVersion:
        params.protocolVersion === acp.PROTOCOL_VERSION
          ? params.protocolVersion
          : acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {},
        sessionCapabilities: { close: {} },
      },
      authMethods: [],
      agentInfo: {
        name: 'orion-code',
        title: 'Orion Code',
        version: PACKAGE_VERSION,
      },
    }))
    .onRequest(acp.methods.agent.session.new, async ({ params }) =>
      runtimePort.createSession({
        cwd: params.cwd,
        mcpServers: params.mcpServers,
        additionalDirectories: params.additionalDirectories,
      })
    )
    .onRequest(acp.methods.agent.session.load, async ({ params, client, signal }) => {
      await runtimePort.loadSession({
        sessionId: params.sessionId,
        cwd: params.cwd,
        mcpServers: params.mcpServers,
        additionalDirectories: params.additionalDirectories,
        observer: createObserver(params.sessionId, client, signal),
      });
      return {};
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client, signal }) => ({
      stopReason: await runtimePort.prompt({
        sessionId: params.sessionId,
        prompt: params.prompt,
        observer: createObserver(params.sessionId, client, signal),
        signal,
      }),
    }))
    .onNotification(acp.methods.agent.session.cancel, async ({ params }) => {
      await runtimePort.cancel(params.sessionId);
    })
    .onRequest(acp.methods.agent.session.close, async ({ params }) => {
      await runtimePort.closeSession(params.sessionId);
      return {};
    })
    .onConnect(connection => {
      void connection.closed
        .finally(() => runtimePort.close())
        .catch(error => {
          writeDiagnostic('ACP runtime close failed', error);
        });
    });
}

export async function startOrionAcpServer(
  runtimePort: OrionAcpRuntimePort = createProductOrionAcpRuntimePort()
): Promise<void> {
  const app = createOrionAcpAgentApp(runtimePort);
  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
  );
  const connection = app.connect(stream);
  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await runtimePort.close();
    } catch (error) {
      writeDiagnostic(`ACP shutdown failed (${reason})`, error);
      process.exitCode = 1;
    } finally {
      connection.close();
    }
  };
  const onSigint = (): void => void shutdown('SIGINT');
  const onSigterm = (): void => void shutdown('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    await connection.closed;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    await shutdown('EOF');
  }
}

function createObserver(
  sessionId: string,
  client: acp.AgentContext,
  connectionSignal: AbortSignal
): OrionAcpRuntimeObserver {
  return {
    update: async (update: OrionAcpSessionUpdate): Promise<void> => {
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update,
      });
    },
    requestPermission: request => requestPermission(sessionId, client, request, connectionSignal),
  };
}

async function requestPermission(
  sessionId: string,
  client: acp.AgentContext,
  request: OrionAcpPermissionRequest,
  connectionSignal: AbortSignal
): Promise<boolean> {
  if (connectionSignal.aborted || request.signal?.aborted) return false;
  const allowOptionId = `${request.requestId}:allow-once`;
  const rejectOptionId = `${request.requestId}:reject-once`;
  const cancellation = new AbortController();
  const detachSignals = forwardAbortSignals(
    [connectionSignal, request.signal].filter((signal): signal is AbortSignal => Boolean(signal)),
    cancellation
  );
  let detachCancellationAbort = (): void => undefined;
  const cancellationPromise = new Promise<never>((_, reject) => {
    const abort = (): void => reject(new Error('ACP permission request cancelled.'));
    if (cancellation.signal.aborted) {
      abort();
      return;
    }
    cancellation.signal.addEventListener('abort', abort, { once: true });
    detachCancellationAbort = (): void => cancellation.signal.removeEventListener('abort', abort);
  });
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      cancellation.abort('ACP permission request timed out');
      reject(new Error('ACP permission request timed out.'));
    }, PERMISSION_TIMEOUT_MS);
    timeout.unref();
  });
  const responsePromise = client.request(
    acp.methods.client.session.requestPermission,
    {
      sessionId,
      toolCall: {
        toolCallId: request.toolCallId,
        title: request.name,
        status: 'pending',
        rawInput: request.args,
      },
      options: [
        { optionId: allowOptionId, name: 'Allow once', kind: 'allow_once' },
        { optionId: rejectOptionId, name: 'Reject', kind: 'reject_once' },
      ],
    },
    { cancellationSignal: cancellation.signal }
  );
  responsePromise.catch(() => undefined);
  try {
    const response = await Promise.race([responsePromise, timeoutPromise, cancellationPromise]);
    return response.outcome.outcome === 'selected' && response.outcome.optionId === allowOptionId;
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
    detachCancellationAbort();
    detachSignals();
  }
}

function forwardAbortSignals(
  signals: readonly AbortSignal[],
  controller: AbortController
): () => void {
  const handlers = signals.map(signal => {
    const handler = (): void => controller.abort(signal.reason);
    if (signal.aborted) handler();
    else signal.addEventListener('abort', handler, { once: true });
    return { signal, handler };
  });
  return () => {
    for (const { signal, handler } of handlers) signal.removeEventListener('abort', handler);
  };
}

function writeDiagnostic(prefix: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${prefix}: ${message}\n`);
}
