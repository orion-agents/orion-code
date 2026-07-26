import { layoutTranscriptEntry } from '../src/tui-ui/transcript-layout';
import {
  createToolOutputView,
  DEFAULT_TOOL_OUTPUT_POLICY,
  type ToolOutputView,
} from '../src/runtime/tool-output-presentation';
import type { TranscriptEntry } from '../src/runtime/ui-events';

function render(view: ToolOutputView, body = 'RAW_BODY_MUST_NOT_RENDER'): string[] {
  const entry: TranscriptEntry = {
    id: 'tool-1',
    role: 'tool',
    content: body,
    toolActivity: {
      state: 'success',
      name: 'batch_read',
      body,
      detail: '',
      summary: '4/4 steps',
      outputBytes: view.detailRef?.outputBytes,
      outputView: view,
    },
  };
  return layoutTranscriptEntry(entry, { width: 120 }).map(row => row.map(span => span.text).join(''));
}

describe('TUI tool output collapse', () => {
  it('renders preview instead of the raw body', () => {
    const view = createToolOutputView({
      toolName: 'read_file',
      success: true,
      rawOutput: `${'preview line\n'.repeat(100)}`,
      outputBytes: 1300,
      callId: 'call-1',
      sequence: 1,
      policy: DEFAULT_TOOL_OUTPUT_POLICY,
    });
    const entry: TranscriptEntry = {
      id: 'tool-1',
      role: 'tool',
      content: 'RAW_BODY_MUST_NOT_RENDER',
      toolActivity: {
        state: 'success',
        name: 'read_file',
        body: 'RAW_BODY_MUST_NOT_RENDER',
        detail: '',
        outputView: view,
      },
    };
    const text = layoutTranscriptEntry(entry, { width: 100 }).flatMap(row => row.map(span => span.text)).join('\n');
    expect(text).toContain('preview line');
    expect(text).toContain('collapsed');
    expect(text).not.toContain('RAW_BODY_MUST_NOT_RENDER');
  });

  it('keeps inline output complete', () => {
    const view = createToolOutputView({
      toolName: 'read_file', success: true, rawOutput: 'complete output', outputBytes: 15,
      callId: 'call-2', sequence: 2, policy: DEFAULT_TOOL_OUTPUT_POLICY,
    });
    const rows = render(view, 'complete output');
    expect(rows.join('\n')).toContain('complete output');
    expect(rows.join('\n')).not.toContain('collapsed');
  });

  it('honors collapsed and full session modes', () => {
    const view = createToolOutputView({
      toolName: 'read_file', success: true, rawOutput: 'complete output', outputBytes: 15,
      callId: 'call-mode', sequence: 2, policy: DEFAULT_TOOL_OUTPUT_POLICY,
    });
    const entry: TranscriptEntry = {
      id: 'tool-mode',
      role: 'tool',
      content: 'complete output',
      toolActivity: {
        state: 'success',
        name: 'read_file',
        detail: '',
        body: 'complete output',
        outputView: view,
      },
    };
    const collapsed = layoutTranscriptEntry(entry, { width: 80, toolOutputMode: 'collapsed' });
    const full = layoutTranscriptEntry(entry, { width: 80, toolOutputMode: 'full' });
    expect(collapsed.flatMap(row => row.map(span => span.text)).join('\n')).not.toContain('complete output');
    expect(collapsed.flatMap(row => row.map(span => span.text)).join('\n')).toContain('collapsed');
    expect(full.flatMap(row => row.map(span => span.text)).join('\n')).toContain('complete output');
    expect(full.flatMap(row => row.map(span => span.text)).join('\n')).not.toContain('collapsed');
  });

  it('renders a four-step batch in no more than five rows without the JSON envelope', () => {
    const raw = JSON.stringify({
      success: true,
      output: 'RAW_ENVELOPE_OUTPUT',
      summary: '4/4 steps',
      steps: [
        { index: 1, tool: 'list_files', args: { path: 'agents/' }, success: true, summary: '21 entries' },
        { index: 2, tool: 'list_files', args: { path: 'commons/' }, success: true, summary: '0 entries' },
        { index: 3, tool: 'list_files', args: { path: 'projects/' }, success: true, summary: '2 entries' },
        { index: 4, tool: 'read_file', args: { path: 'SKILL.md' }, success: true, summary: '42 lines' },
      ],
    });
    const view = createToolOutputView({
      toolName: 'batch_read', success: true, summary: '4/4 steps', rawOutput: raw,
      outputBytes: Buffer.byteLength(raw), callId: 'call-batch', sequence: 3,
      policy: DEFAULT_TOOL_OUTPUT_POLICY,
    });
    const rows = render(view, raw);
    expect(rows).toHaveLength(5);
    expect(rows.join('\n')).toContain('list_files agents/');
    expect(rows.join('\n')).toContain('+1 more');
    expect(rows.join('\n')).not.toContain('RAW_ENVELOPE_OUTPUT');
    expect(rows.join('\n')).not.toContain('"steps"');
  });

  it('prioritizes a failed aggregate step in the visible preview', () => {
    const raw = JSON.stringify({ steps: [
      { tool: 'read_file', target: 'ok-1', success: true, summary: 'ok' },
      { tool: 'read_file', target: 'ok-2', success: true, summary: 'ok' },
      { tool: 'read_file', target: 'ok-3', success: true, summary: 'ok' },
      { tool: 'read_file', target: 'failed', success: false, summary: 'permission denied' },
    ] });
    const view = createToolOutputView({
      toolName: 'batch_read', success: false, rawOutput: raw, outputBytes: Buffer.byteLength(raw),
      callId: 'call-error', sequence: 4, policy: DEFAULT_TOOL_OUTPUT_POLICY,
    });
    const rows = render(view, raw);
    expect(rows[1]).toContain('failed');
    expect(rows[1]).toContain('permission denied');
  });
});
