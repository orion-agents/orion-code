import type { Message } from '../src/services/llm';
import { assertToolCallGroups, sealToolCallGroups } from '../src/services/compact/tool-call-groups';

function assistantCalls(...ids: string[]): Message {
  return {
    role: 'assistant',
    content: '',
    tool_calls: ids.map(id => ({
      id,
      type: 'function',
      function: { name: 'read_file', arguments: '{}' },
    })),
  };
}

describe('tool-call group integrity', () => {
  test('seals missing results and drops orphan results during legacy resume', () => {
    const sealed = sealToolCallGroups([
      { role: 'tool', content: 'orphan', tool_call_id: 'old' },
      assistantCalls('a', 'b'),
      { role: 'tool', content: 'result-a', tool_call_id: 'a' },
      { role: 'user', content: 'next turn' },
    ]);

    expect(sealed.map(message => [message.role, message.tool_call_id])).toEqual([
      ['assistant', undefined],
      ['tool', 'a'],
      ['tool', 'b'],
      ['user', undefined],
    ]);
    expect(sealed[2].content).toContain('session recovery');
    expect(() => assertToolCallGroups(sealed)).not.toThrow();
  });

  test('fails loudly for incomplete provider histories', () => {
    expect(() =>
      assertToolCallGroups([assistantCalls('a'), { role: 'user', content: 'next' }])
    ).toThrow('Incomplete tool-call group');
    expect(() =>
      assertToolCallGroups([{ role: 'tool', content: 'orphan', tool_call_id: 'a' }])
    ).toThrow('Orphan or duplicate tool result');
  });
});
