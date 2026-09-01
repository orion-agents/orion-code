import type { IncomingMessage, Server } from 'http';
import { WebSocket, WebSocketServer } from 'ws';

import { WebWorkbenchError } from './errors';
import type { TerminalConnectionV1, TerminalManagerV1 } from './terminal-manager';

const TERMINAL_PROTOCOL = 'orion-terminal-v1';
const MAX_WS_BUFFERED_BYTES = 2 * 1024 * 1024;
const PAUSE_WS_BUFFERED_BYTES = 512 * 1024;
const RESUME_WS_BUFFERED_BYTES = 128 * 1024;
const BACKPRESSURE_POLL_MS = 10;
const AUTH_TIMEOUT_MS = 5_000;

export interface TerminalWebSocketHandle {
  close(): Promise<void>;
}

export function attachTerminalWebSocketServer(
  server: Server,
  origin: () => string,
  manager: TerminalManagerV1
): TerminalWebSocketHandle {
  const webSockets = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 72 * 1024,
    clientTracking: true,
  });
  const onUpgrade = (request: IncomingMessage, socket: import('stream').Duplex, head: Buffer) => {
    const expectedOrigin = origin();
    if (!expectedOrigin || request.headers.origin !== expectedOrigin) {
      rejectUpgrade(socket, 403, 'Origin rejected');
      return;
    }
    const expectedHost = new URL(expectedOrigin).host;
    if (request.headers.host !== expectedHost) {
      rejectUpgrade(socket, 421, 'Host rejected');
      return;
    }
    const protocols = String(request.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map(value => value.trim());
    if (!protocols.includes(TERMINAL_PROTOCOL)) {
      rejectUpgrade(socket, 400, 'Protocol rejected');
      return;
    }
    const requestUrl = new URL(request.url ?? '/', expectedOrigin);
    const match = requestUrl.pathname.match(/^\/api\/v1\/terminals\/([^/]+)\/stream$/u);
    if (!match || requestUrl.search) {
      rejectUpgrade(socket, 404, 'Stream not found');
      return;
    }
    let terminalId: string;
    try {
      terminalId = decodeURIComponent(match[1]);
    } catch {
      rejectUpgrade(socket, 400, 'Terminal identity rejected');
      return;
    }
    webSockets.handleUpgrade(request, socket, head, webSocket => {
      ownTerminalSocket(webSocket, terminalId, manager);
    });
  };
  server.on('upgrade', onUpgrade);

  return Object.freeze({
    close: () =>
      new Promise<void>(resolvePromise => {
        server.off('upgrade', onUpgrade);
        for (const client of webSockets.clients) client.close(1001, 'Host closing');
        webSockets.close(() => resolvePromise());
      }),
  });
}

function ownTerminalSocket(
  webSocket: WebSocket,
  terminalId: string,
  manager: TerminalManagerV1
): void {
  let connection: TerminalConnectionV1 | undefined;
  let backpressurePaused = false;
  let replayPaused = false;
  let drainTimer: NodeJS.Timeout | undefined;
  let replayTimer: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => webSocket.close(4401, 'Authentication timeout'), AUTH_TIMEOUT_MS);
  timer.unref();
  const applyFlowControl = () => {
    if (!connection) return;
    try {
      connection.setOutputPaused(backpressurePaused || replayPaused);
    } catch {
      webSocket.close(1011, 'Terminal flow control failed');
    }
  };
  const scheduleDrainCheck = () => {
    if (drainTimer || webSocket.readyState !== WebSocket.OPEN) return;
    drainTimer = setTimeout(() => {
      drainTimer = undefined;
      checkBackpressure();
    }, BACKPRESSURE_POLL_MS);
    drainTimer.unref();
  };
  const checkBackpressure = () => {
    if (webSocket.readyState !== WebSocket.OPEN) return;
    if (webSocket.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
      backpressurePaused = true;
      applyFlowControl();
      webSocket.close(4413, 'Terminal stream backpressure');
      return;
    }
    if (webSocket.bufferedAmount >= PAUSE_WS_BUFFERED_BYTES) {
      if (!backpressurePaused) {
        backpressurePaused = true;
        applyFlowControl();
      }
    } else if (backpressurePaused && webSocket.bufferedAmount <= RESUME_WS_BUFFERED_BYTES) {
      backpressurePaused = false;
      applyFlowControl();
    }
    if (backpressurePaused) scheduleDrainCheck();
  };
  const send = (value: unknown, onSent?: () => void): boolean => {
    if (webSocket.readyState !== WebSocket.OPEN) return false;
    const payload = JSON.stringify(value);
    if (
      Buffer.byteLength(payload, 'utf8') > MAX_WS_BUFFERED_BYTES ||
      webSocket.bufferedAmount > MAX_WS_BUFFERED_BYTES
    ) {
      backpressurePaused = true;
      applyFlowControl();
      webSocket.close(4413, 'Terminal stream backpressure');
      return false;
    }
    webSocket.send(payload, error => {
      if (error) {
        webSocket.close(1011, 'Terminal stream failed');
        return;
      }
      checkBackpressure();
      onSent?.();
    });
    checkBackpressure();
    return true;
  };
  const sendReplay = (values: readonly unknown[], index = 0): void => {
    if (webSocket.readyState !== WebSocket.OPEN) return;
    if (index >= values.length) {
      replayPaused = false;
      applyFlowControl();
      return;
    }
    if (webSocket.bufferedAmount >= PAUSE_WS_BUFFERED_BYTES) {
      backpressurePaused = true;
      applyFlowControl();
      scheduleDrainCheck();
      replayTimer = setTimeout(() => sendReplay(values, index), BACKPRESSURE_POLL_MS);
      replayTimer.unref();
      return;
    }
    send(values[index], () => sendReplay(values, index + 1));
  };
  const dispose = () => {
    clearTimeout(timer);
    if (drainTimer) clearTimeout(drainTimer);
    if (replayTimer) clearTimeout(replayTimer);
    connection?.dispose();
    connection = undefined;
  };
  webSocket.once('close', dispose);
  webSocket.once('error', dispose);
  webSocket.on('message', (data, binary) => {
    if (binary) {
      webSocket.close(4400, 'Binary client messages are not supported');
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(data.toString()) as unknown;
    } catch {
      webSocket.close(4400, 'Invalid terminal message');
      return;
    }
    try {
      if (!connection) {
        const auth = parseAuthenticate(message);
        connection = manager.attach({
          terminalId,
          ticket: auth.ticket,
          afterSequence: auth.afterSequence,
          onFrame: frame => send(frame),
          onExit: event => {
            if (!send(event, () => webSocket.close(1000, 'Terminal exited'))) {
              webSocket.close(1000, 'Terminal exited');
            }
          },
          onReplaced: () => webSocket.close(4409, 'Terminal connection replaced'),
        });
        clearTimeout(timer);
        replayPaused = true;
        applyFlowControl();
        sendReplay([
          { type: 'ready', terminal: connection.terminal },
          ...(connection.gap ? [connection.gap] : []),
          ...connection.replay,
        ]);
        return;
      }
      const command = parseTerminalCommand(message);
      if (command.type === 'input') connection.write(command.data);
      else if (command.type === 'resize') connection.resize(command.cols, command.rows);
      else send({ type: 'pong', timestamp: command.timestamp });
    } catch (error) {
      const code = error instanceof WebWorkbenchError ? error.code : 'terminal_protocol_error';
      send({ type: 'error', code });
      webSocket.close(
        error instanceof WebWorkbenchError ? 4403 : 4400,
        'Terminal request rejected'
      );
    }
  });
}

function parseAuthenticate(value: unknown): {
  readonly ticket: string;
  readonly afterSequence: number;
} {
  const row = requireRecord(value);
  assertKeys(row, ['type', 'ticket', 'afterSequence']);
  if (
    row.type !== 'authenticate' ||
    typeof row.ticket !== 'string' ||
    row.ticket.length < 32 ||
    row.ticket.length > 128 ||
    !Number.isSafeInteger(row.afterSequence) ||
    Number(row.afterSequence) < 0
  ) {
    throw new WebWorkbenchError(400, 'Terminal authentication is invalid.');
  }
  return { ticket: row.ticket, afterSequence: Number(row.afterSequence) };
}

type TerminalCommand =
  | { readonly type: 'input'; readonly data: string }
  | { readonly type: 'resize'; readonly cols: number; readonly rows: number }
  | { readonly type: 'ping'; readonly timestamp: number };

function parseTerminalCommand(value: unknown): TerminalCommand {
  const row = requireRecord(value);
  if (row.type === 'input') {
    assertKeys(row, ['type', 'data']);
    if (typeof row.data !== 'string') throw new Error('invalid input');
    return { type: 'input', data: row.data };
  }
  if (row.type === 'resize') {
    assertKeys(row, ['type', 'cols', 'rows']);
    if (!Number.isSafeInteger(row.cols) || !Number.isSafeInteger(row.rows)) {
      throw new Error('invalid resize');
    }
    return { type: 'resize', cols: Number(row.cols), rows: Number(row.rows) };
  }
  if (row.type === 'ping') {
    assertKeys(row, ['type', 'timestamp']);
    if (typeof row.timestamp !== 'number' || !Number.isFinite(row.timestamp)) {
      throw new Error('invalid ping');
    }
    return { type: 'ping', timestamp: row.timestamp };
  }
  throw new Error('unknown terminal command');
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid object');
  return value as Record<string, unknown>;
}

function assertKeys(row: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = new Set(allowed);
  if (Object.keys(row).some(key => !keys.has(key))) throw new Error('unknown field');
}

function rejectUpgrade(socket: import('stream').Duplex, status: number, message: string): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  );
}

export const TERMINAL_WEBSOCKET_PROTOCOL = TERMINAL_PROTOCOL;
