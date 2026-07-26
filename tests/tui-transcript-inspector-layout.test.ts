import { renderTranscriptInspectorFrame } from '../src/tui-ui/transcript-inspector-layout';
import type { ToolInspectorViewModel } from '../src/tui-ui/transcript-inspector';

function frameText(view: ToolInspectorViewModel, width = 80, height = 20): string {
  const frame = renderTranscriptInspectorFrame(view, { width, height });
  return frame.rows
    .map(row => row.map(cell => cell.width === 0 ? '' : cell.char).join(''))
    .join('\n');
}

function view(expanded: boolean): ToolInspectorViewModel {
  const entry = {
    callId: 'call-1',
    sequence: 7,
    toolName: 'batch_read',
    outputBytes: 4096,
    state: 'success' as const,
    summary: '检查中文目录',
    artifactId: 'artifact-1',
  };
  return {
    entries: [entry],
    selectedIndex: 0,
    selected: entry,
    expandedCallIds: expanded ? ['call-1'] : [],
    searchQuery: '',
    detailOffset: 0,
    detail: {
      content: '完整工具输出\n第二页内容',
      totalBytes: 4096,
      nextOffsetBytes: 2048,
      redacted: false,
      loading: false,
    },
  };
}

describe('TUI transcript Inspector layout', () => {
  it('keeps detail collapsed until the selected tool is expanded', () => {
    const text = frameText(view(false));
    expect(text).toContain('检查中文目录');
    expect(text).not.toContain('完整工具输出');
  });

  it('renders expanded detail and pagination affordance', () => {
    const text = frameText(view(true));
    expect(text).toContain('完整工具输出');
    expect(text).toContain('More available');
  });

  it('lays out safely at narrow widths', () => {
    const frame = renderTranscriptInspectorFrame(view(true), { width: 42, height: 12 });
    expect(frame.rows).toHaveLength(12);
    expect(frame.rows.every(row => row.length === 42)).toBe(true);
    expect(frameText(view(true), 42, 12)).toContain('Tool Inspector');
  });

  it('applies the detail viewport offset', () => {
    const offsetView = view(true);
    offsetView.detailOffset = 1;
    const text = frameText(offsetView);
    expect(text).toContain('第二页内容');
    expect(text).not.toContain('完整工具输出');
  });
});
