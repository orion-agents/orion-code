import {
  closeTerminalSocket,
  type TerminalSocketLike,
} from '../web/src/components/terminal/terminal-socket';

class FakeTerminalSocket implements TerminalSocketLike {
  onopen: ((event: Event) => void) | null = null;
  readonly close = jest.fn<void, [number?, string?]>();

  constructor(public readyState: number) {}
}

describe('terminal socket lifecycle', () => {
  it('waits for a connecting socket to open before closing it', () => {
    const socket = new FakeTerminalSocket(0);

    closeTerminalSocket(socket, 'Panel detached');

    expect(socket.close).not.toHaveBeenCalled();
    socket.readyState = 1;
    socket.onopen?.(new Event('open'));
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledWith(1000, 'Panel detached');
  });

  it('closes an open socket immediately and ignores terminal states', () => {
    const open = new FakeTerminalSocket(1);
    const closing = new FakeTerminalSocket(2);
    const closed = new FakeTerminalSocket(3);

    closeTerminalSocket(open, 'User closed terminal');
    closeTerminalSocket(closing, 'Panel detached');
    closeTerminalSocket(closed, 'Panel detached');

    expect(open.close).toHaveBeenCalledWith(1000, 'User closed terminal');
    expect(closing.close).not.toHaveBeenCalled();
    expect(closed.close).not.toHaveBeenCalled();
  });
});
