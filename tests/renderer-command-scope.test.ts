import { AgentChatController } from '../src/runtime/chat-controller';
import type { OrionCodeUiRuntime, UiEventSink } from '../src/runtime/ui-events';

describe('renderer command scope', () => {
  function createController(renderer: 'print' | 'tui') {
    const events = { append: jest.fn() } as unknown as UiEventSink;
    const runtime = {
      cwd: process.cwd(),
      config: { ui: { renderer } },
      store: { setState: jest.fn() },
      llm: null,
      compactCoordinator: undefined,
      runtime: undefined,
      getSession: () => null,
      ensureSession: () => null,
      setSession: jest.fn(),
    } as unknown as OrionCodeUiRuntime;
    return {
      append: events.append as jest.Mock,
      controller: new AgentChatController(runtime, events, { uiRenderer: renderer }),
    };
  }

  it.each([
    ['/tool-output full', 'tool-output'],
    ['/redraw', 'redraw'],
    ['/queue', 'queue'],
  ])('rejects TUI-local %s through the print controller', async (input, name) => {
    const { append, controller } = createController('print');

    await controller.runInput(input);

    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'error',
        content: expect.stringContaining(`/${name} is not available in the print renderer`),
        command: expect.objectContaining({ name, success: false }),
      })
    );
  });

  it('allows a TUI-local command through the TUI controller', async () => {
    const { append, controller } = createController('tui');

    await controller.runInput('/tool-output full');

    expect(append).not.toHaveBeenCalled();
  });
});
