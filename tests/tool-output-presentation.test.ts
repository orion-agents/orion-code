/**
 * v0.2.23 Slice 4 — Tool Output Presentation tests.
 */

import {
  createToolOutputView,
  tryParseAggregateOutput,
  DEFAULT_TOOL_OUTPUT_POLICY,
  type ToolOutputView,
} from '../src/runtime/tool-output-presentation';

const POLICY = DEFAULT_TOOL_OUTPUT_POLICY;

function baseInput(overrides: Partial<Parameters<typeof createToolOutputView>[0]> = {}) {
  return {
    toolName: 'read_file',
    success: true,
    rawOutput: 'hello world',
    outputBytes: 11,
    callId: 'call_001',
    sequence: 1,
    policy: POLICY,
    ...overrides,
  };
}

describe('createToolOutputView', () => {
  describe('adaptive mode', () => {
    it('inlines small output', () => {
      const view = createToolOutputView(baseInput());
      expect(view.mode).toBe('inline');
      expect(view.preview).toBe('hello world');
      expect(view.omittedBytes).toBe(0);
    });

    it('redacts secrets before creating an inline or preview body', () => {
      const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
      const view = createToolOutputView(baseInput({
        rawOutput: `token=${secret}`,
        outputBytes: Buffer.byteLength(`token=${secret}`, 'utf8'),
      }));
      expect(view.preview).toContain('[REDACTED_SECRET]');
      expect(view.preview).not.toContain(secret);
    });

    it('shows preview for large output', () => {
      const big = 'x'.repeat(2000);
      const view = createToolOutputView(baseInput({
        rawOutput: big,
        outputBytes: Buffer.byteLength(big, 'utf8'),
      }));
      expect(view.mode).toBe('preview');
      expect(view.omittedBytes).toBeGreaterThan(0);
      expect(view.detailRef).toBeDefined();
    });

    it('collapses batch_read always', () => {
      const view = createToolOutputView(baseInput({
        toolName: 'batch_read',
        summary: '4/4 steps',
      }));
      expect(view.mode).toBe('collapsed');
      expect(view.contentKind).toBe('batch');
    });

    it('shows larger error preview for failed tools', () => {
      const err = 'Error line 1\nError line 2\nError line 3\nError line 4\nError line 5';
      const view = createToolOutputView(baseInput({
        success: false,
        rawOutput: err,
        outputBytes: Buffer.byteLength(err, 'utf8'),
      }));
      expect(view.mode).toBe('preview');
      // Error preview allows up to 8 lines.
      expect(view.preview.split('\n').length).toBeLessThanOrEqual(8);
    });

    it('handles empty output', () => {
      const view = createToolOutputView(baseInput({
        rawOutput: '',
        outputBytes: 0,
      }));
      expect(view.mode).toBe('collapsed');
      expect(view.preview).toBe('');
    });
  });

  describe('collapsed mode', () => {
    it('collapses all non-empty output', () => {
      const view = createToolOutputView(baseInput({
        policy: { ...POLICY, mode: 'collapsed' },
      }));
      expect(view.mode).toBe('collapsed');
      expect(view.preview).toBe('');
    });
  });

  describe('full mode', () => {
    it('shows complete output inline', () => {
      const big = 'x'.repeat(2000);
      const view = createToolOutputView(baseInput({
        rawOutput: big,
        outputBytes: Buffer.byteLength(big, 'utf8'),
        policy: { ...POLICY, mode: 'full' },
      }));
      expect(view.mode).toBe('inline');
      expect(view.omittedBytes).toBe(0);
    });
  });

  describe('detail reference', () => {
    it('includes detailRef with callId and sequence', () => {
      const view = createToolOutputView(baseInput({
        rawOutput: 'x'.repeat(2000),
        outputBytes: 2000,
      }));
      expect(view.detailRef).toBeDefined();
      expect(view.detailRef!.callId).toBe('call_001');
      expect(view.detailRef!.sequence).toBe(1);
      expect(view.detailRef!.outputBytes).toBe(2000);
    });
  });
});

describe('tryParseAggregateOutput', () => {
  it('parses batch_read with steps', () => {
    const raw = JSON.stringify({
      success: true,
      summary: '4/4 steps',
      steps: [
        { tool: 'list_files', target: 'agents/', success: true, summary: '21 entries', outputBytes: 500 },
        { tool: 'list_files', target: 'commons/', success: true, summary: '0 entries', outputBytes: 100 },
        { tool: 'list_files', target: 'projects/', success: true, summary: '2 entries', outputBytes: 200 },
        { tool: 'read_file', target: 'index.ts', success: true, summary: '42 lines', outputBytes: 1200 },
      ],
    });
    const agg = tryParseAggregateOutput('batch_read', raw);
    expect(agg).not.toBeNull();
    expect(agg!.kind).toBe('batch_read');
    expect(agg!.total).toBe(4);
    expect(agg!.succeeded).toBe(4);
    expect(agg!.failed).toBe(0);
    expect(agg!.steps).toHaveLength(4);
    expect(agg!.steps[0].toolName).toBe('list_files');
    expect(agg!.steps[0].target).toBe('agents/');
  });

  it('handles mixed success/failure', () => {
    const raw = JSON.stringify({
      steps: [
        { tool: 'exec', target: 'a', success: true, summary: 'ok', outputBytes: 10 },
        { tool: 'exec', target: 'b', success: false, summary: 'fail', outputBytes: 100 },
        { tool: 'exec', target: 'c', success: true, summary: 'ok', outputBytes: 10 },
      ],
    });
    const agg = tryParseAggregateOutput('batch_read', raw);
    expect(agg!.succeeded).toBe(2);
    expect(agg!.failed).toBe(1);
  });

  it('returns null for unknown tools', () => {
    const agg = tryParseAggregateOutput('read_file', '{}');
    expect(agg).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    const agg = tryParseAggregateOutput('batch_read', 'not json');
    expect(agg).toBeNull();
  });

  it('returns null for empty batch', () => {
    const agg = tryParseAggregateOutput('batch_read', JSON.stringify({ steps: [] }));
    // No steps and no summary — null.
    expect(agg).toBeNull();
  });
});
