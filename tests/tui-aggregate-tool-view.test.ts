import { presentAggregateToolResult } from '../src/runtime/aggregate-tool-presenter';
import { tryParseAggregateOutput } from '../src/runtime/tool-output-presentation';

describe('ToolAggregateView', () => {
  it('normalizes batch_read counts, targets, bytes, and schema version', () => {
    const raw = JSON.stringify({ steps: [
      { index: 1, tool: 'list_files', args: { path: 'agents/' }, success: true, summary: '21 entries', output: 'a' },
      { index: 2, tool: 'read_file', target: 'missing', success: false, summary: 'not found', output: 'error' },
      { index: 3, tool: 'read_file', target: 'skip', state: 'skipped', summary: 'skipped' },
    ] });
    const view = tryParseAggregateOutput('batch_read', raw)!;
    expect(view).toMatchObject({ version: 1, total: 3, succeeded: 1, failed: 1, skipped: 1 });
    expect(view.steps[0]).toMatchObject({ toolName: 'list_files', target: 'agents/', outputBytes: 1 });
  });

  it('returns null for malformed or unknown aggregate output', () => {
    expect(tryParseAggregateOutput('batch_read', '{')).toBeNull();
    expect(tryParseAggregateOutput('read_file', '{}')).toBeNull();
  });

  it('normalizes subtask result batches', () => {
    const view = tryParseAggregateOutput('subtask', JSON.stringify({ results: [
      { id: 'a', role: 'research', status: 'completed', summary: 'done' },
      { id: 'b', role: 'review', status: 'timed_out', summary: 'timeout' },
    ] }))!;
    expect(view).toMatchObject({ version: 1, kind: 'subtask_batch', total: 2, succeeded: 1, failed: 1 });
  });

  it('aggregate presenter emits a stable headline', () => {
    const result = presentAggregateToolResult('batch_read', JSON.stringify({
      summary: 'batch complete',
      steps: [{ tool: 'read_file', success: true, summary: 'ok', outputBytes: 2 }],
    }), 4096);
    expect(result?.view.version).toBe(1);
    expect(result?.headline).toBe('batch complete · 4.0 KB');
  });
});
