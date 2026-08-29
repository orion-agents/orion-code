const WEBSOCKET_CONNECTING = 0;
const WEBSOCKET_OPEN = 1;

export interface TerminalSocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  close(code?: number, reason?: string): void;
}

/** Close a terminal socket without asking the browser to abort an in-flight handshake. */
export function closeTerminalSocket(socket: TerminalSocketLike | null, reason: string): void {
  if (!socket) return;
  if (socket.readyState === WEBSOCKET_CONNECTING) {
    socket.onopen = () => socket.close(1000, reason);
    return;
  }
  if (socket.readyState === WEBSOCKET_OPEN) socket.close(1000, reason);
}
