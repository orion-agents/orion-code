import { assertToolCallGroups } from '../src/services/compact/tool-call-groups';
import { normalizeSessionModelHistoryV1 } from '../src/runtime/session-history-recovery';

describe('session history recovery', () => {
  it('passes valid model history through without a warning', () => {
    const result = normalizeSessionModelHistoryV1(
      [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call-valid',
              type: 'function',
              function: { name: 'read_file', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', content: '{"success":true}', tool_call_id: 'call-valid' },
      ],
      'turn_commit'
    );

    expect(result.source).toBe('turn_commit');
    expect(result.diagnostics).toEqual([]);
    expect(() => assertToolCallGroups(result.messages)).not.toThrow();
  });

  it('repairs incomplete tool groups and records safe provenance', () => {
    const result = normalizeSessionModelHistoryV1(
      [
        { role: 'user', content: 'continue the saved task' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call-missing',
              type: 'function',
              function: { name: 'read_file', arguments: '{}' },
            },
          ],
        },
      ],
      'transcript'
    );

    expect(result.source).toBe('transcript_repaired');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'tool_call_groups_repaired' }),
    ]);
    expect(result.messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-missing',
    });
    expect(JSON.parse(result.messages.at(-1)?.content ?? '{}')).toMatchObject({
      success: false,
      status: 'cancelled',
    });
    expect(() => assertToolCallGroups(result.messages)).not.toThrow();
  });
});
