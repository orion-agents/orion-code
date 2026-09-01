import { createServer, type Server } from 'http';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import type { Socket } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { WebSocket } from 'ws';

import {
  TerminalManagerV1,
  type TerminalBackendV1,
  type TerminalProcessV1,
} from '../src/web/terminal-manager';
import {
  attachTerminalWebSocketServer,
  TERMINAL_WEBSOCKET_PROTOCOL,
  type TerminalWebSocketHandle,
} from '../src/web/terminal-server';

class BackpressureTerminalProcess implements TerminalProcessV1 {
  readonly pid = 999_998;
  readonly process = 'backpressure-shell';
  readonly cols = 100;
  readonly rows = 30;
  paused = false;
  alive = true;
  pauseCalls = 0;
  resumeCalls = 0;
  onPause: (() => void) | undefined;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<
    (event: { exitCode: number; signal?: number }) => void
  >();

  write(_data: string | Buffer): void {}

  resize(_cols: number, _rows: number): void {}

  kill(signal?: string): void {
    if (signal === 'SIGKILL') this.alive = false;
  }

  pause(): void {
    this.paused = true;
    this.pauseCalls += 1;
    this.onPause?.();
  }

  resume(): void {
    this.paused = false;
    this.resumeCalls += 1;
  }

  isAlive(): boolean {
    return this.alive;
  }

  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  emitData(data: string): void {
    if (this.paused || !this.alive) return;
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(event: { exitCode: number; signal?: number }): void {
    this.alive = false;
    for (const listener of this.exitListeners) listener(event);
  }
}

describe('terminal WebSocket backpressure', () => {
  let root: string;
  let workspace: string;
  let server: Server;
  let sockets: TerminalWebSocketHandle;
  let manager: TerminalManagerV1;
  let terminalProcess: BackpressureTerminalProcess;
  let client: WebSocket | undefined;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'orion-terminal-ws-'));
    workspace = join(root, 'workspace');
    mkdirSync(workspace);
    terminalProcess = new BackpressureTerminalProcess();
    const backend: TerminalBackendV1 = {
      spawn: () => terminalProcess,
    };
    manager = new TerminalManagerV1({
      backend,
      resolveWorkspace: id => (id === 'workspace' ? workspace : undefined),
      getActiveContext: () => ({ workspaceId: 'workspace', contextRevision: 'revision' }),
      forceKillDelayMs: 10,
      shutdownGraceMs: 20,
      forceKillGraceMs: 100,
    });
    server = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolvePromise);
    });
    const origin = serverOrigin(server);
    sockets = attachTerminalWebSocketServer(server, () => origin, manager);
  });

  afterEach(async () => {
    client?.terminate();
    await sockets.close();
    await manager.shutdown();
    await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
    rmSync(root, { recursive: true, force: true });
  });

  test('pauses at the high watermark and resumes only after the socket drains', async () => {
    const created = manager.create({
      workspaceId: 'workspace',
      expectedContextRevision: 'revision',
    });
    const messages: Array<Record<string, unknown>> = [];
    client = new WebSocket(
      `${serverOrigin(server).replace(/^http/u, 'ws')}/api/v1/terminals/${created.terminal.id}/stream`,
      TERMINAL_WEBSOCKET_PROTOCOL,
      { origin: serverOrigin(server) }
    );
    client.on('message', data => {
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    await waitForWebSocket(client, 'open');
    client.send(JSON.stringify({ type: 'authenticate', ticket: created.ticket, afterSequence: 0 }));
    await waitFor(() => messages.some(message => message.type === 'ready'));
    await waitFor(() => !terminalProcess.paused);
    const pauseBaseline = terminalProcess.pauseCalls;
    const resumeBaseline = terminalProcess.resumeCalls;
    const transport = (client as unknown as { readonly _socket: Socket })._socket;
    transport.pause();

    for (let chunk = 0; chunk < 2_000 && !terminalProcess.paused; chunk += 1) {
      terminalProcess.emitData('x'.repeat(32 * 1024));
      await immediate();
    }

    expect(client.readyState).toBe(WebSocket.OPEN);
    expect(terminalProcess.pauseCalls).toBeGreaterThan(pauseBaseline);
    expect(terminalProcess.paused).toBe(true);

    transport.resume();
    await waitFor(
      () => terminalProcess.resumeCalls > resumeBaseline && !terminalProcess.paused,
      5_000
    );
    expect(client.readyState).toBe(WebSocket.OPEN);
  }, 15_000);

  test('orders replay, buffered live output and exit before closing the socket', async () => {
    const created = manager.create({
      workspaceId: 'workspace',
      expectedContextRevision: 'revision',
    });
    for (let index = 0; index < 260; index += 1) {
      terminalProcess.emitData(`${String(index).padStart(4, '0')}:${'x'.repeat(7_995)}`);
    }

    const messages: Array<Record<string, unknown>> = [];
    client = new WebSocket(
      `${serverOrigin(server).replace(/^http/u, 'ws')}/api/v1/terminals/${created.terminal.id}/stream`,
      TERMINAL_WEBSOCKET_PROTOCOL,
      { origin: serverOrigin(server) }
    );
    client.on('message', data => {
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    await waitForWebSocket(client, 'open');
    const transport = (client as unknown as { readonly _socket: Socket })._socket;
    terminalProcess.onPause = () => transport.pause();
    client.send(JSON.stringify({ type: 'authenticate', ticket: created.ticket, afterSequence: 0 }));
    await waitFor(() => terminalProcess.pauseCalls > 0 && terminalProcess.paused, 5_000);
    terminalProcess.onPause = undefined;

    terminalProcess.emitExit({ exitCode: 0 });
    transport.resume();
    await waitForWebSocket(client, 'close');

    expect(messages[0]?.type).toBe('ready');
    expect(messages.at(-1)).toMatchObject({ type: 'exit', exitCode: 0 });
    const sequences = messages
      .filter(message => message.type === 'output')
      .map(message => Number(message.sequence));
    expect(sequences.length).toBeGreaterThan(200);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
    expect(new Set(sequences).size).toBe(sequences.length);
  }, 15_000);
});

function serverOrigin(server: Server): string {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server address unavailable.');
  return `http://127.0.0.1:${address.port}`;
}

function waitForWebSocket(webSocket: WebSocket, event: 'open' | 'close'): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    webSocket.once(event, () => resolvePromise());
    webSocket.once('error', reject);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for WebSocket flow state.');
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
  }
}

function immediate(): Promise<void> {
  return new Promise(resolvePromise => setImmediate(resolvePromise));
}
