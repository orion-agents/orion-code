import { createTuiFrame, writeFrameText } from '../src/tui-core/frame';
import { InlineTerminalSurface, MemoryOutput } from '../src/tui-ui/inline-surface';

describe('TUI force redraw', () => {
  it('repaints only the owned live region without clearing scrollback', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    const frame = createTuiFrame(79, 4);
    writeFrameText(frame, 0, 0, 'ready');
    writeFrameText(frame, 2, 0, '┌ prompt ┐');
    await surface.renderLive(frame);
    output.chunks = [];

    const written = await surface.forceRedraw(frame);
    await surface.flush();

    expect(written).toContain('ready');
    expect(written).toContain('prompt');
    expect(written).not.toContain('\x1b[2J');
    expect(written).not.toContain('\x1b[3J');
    expect(written).not.toContain('\x1b[?1049h');
  });

  it('is a safe no-op after unmount', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(40, 12);
    await surface.unmount();
    const frame = createTuiFrame(39, 3);
    writeFrameText(frame, 0, 0, 'must not paint');
    expect(await surface.forceRedraw(frame)).toBe('');
  });
});
