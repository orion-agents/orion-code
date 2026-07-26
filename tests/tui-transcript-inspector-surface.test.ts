import { createTuiFrame, writeFrameText } from '../src/tui-core/frame';
import { MemoryOutput } from '../src/tui-ui/inline-surface';
import { TranscriptInspectorSurface } from '../src/tui-ui/transcript-inspector-surface';

describe('TUI transcript Inspector surface', () => {
  it('owns alternate screen only for the Inspector lifecycle', async () => {
    const output = new MemoryOutput();
    const surface = new TranscriptInspectorSurface(output);
    const frame = createTuiFrame(40, 8);
    writeFrameText(frame, 0, 0, 'Inspector detail');

    await surface.mount(frame);
    expect(surface.isMounted).toBe(true);
    expect(output.text()).toContain('\x1b[?1049h');
    expect(output.text()).toContain('Inspector detail');

    await surface.unmount();
    expect(surface.isMounted).toBe(false);
    expect(output.text()).toContain('\x1b[?1049l');
  });

  it('serializes paint after mount', async () => {
    const output = new MemoryOutput();
    const surface = new TranscriptInspectorSurface(output);
    const first = createTuiFrame(20, 4);
    const second = createTuiFrame(20, 4);
    writeFrameText(first, 0, 0, 'first');
    writeFrameText(second, 0, 0, 'second');

    await Promise.all([surface.mount(first), surface.paint(second)]);
    expect(output.text().lastIndexOf('second')).toBeGreaterThan(output.text().lastIndexOf('first'));
  });
});
