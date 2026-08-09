import { estimateMessagesTokens, estimateTokens } from '../src/utils/token-estimate';

describe('message token estimation', () => {
  test('charges message framing even when assistant content is empty', () => {
    expect(estimateMessagesTokens([{ role: 'assistant', content: '' }])).toBe(4);
  });

  test('counts tool-call names, ids, arguments, and tool result ids', () => {
    const args = 'x'.repeat(40_000);
    const estimate = estimateMessagesTokens([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-1',
            function: { name: 'write_file', arguments: args },
          },
        ],
      },
      { role: 'tool', content: 'ok', tool_call_id: 'call-1' },
    ]);

    expect(estimate).toBeGreaterThan(estimateTokens(args));
    expect(estimate).toBeGreaterThan(10_000);
  });
});
