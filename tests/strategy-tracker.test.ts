import { query } from '../src/framework/query';
import type { QueryEvent } from '../src/framework/query';
import { buildTool } from '../src/framework/tool';
import type { OpenHorseTool } from '../src/framework/tool';
import type { LLMService, LLMResponse, Message } from '../src/services/llm';
import { createStrategyTracker } from '../src/core/strategy-tracker';

const failTool: OpenHorseTool = buildTool({
  name: 'flaky_tool',
  description: 'Always fails',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path' } },
    required: ['path'],
  },
  execute: async () => ({ success: false, output: '', error: 'simulated failure' }),
});

function makeMockLLM(responses: LLMResponse[]): jest.Mocked<LLMService> {
  let callIndex = 0;
  return {
    chatStream: jest.fn(async () => {
      const resp = responses[callIndex++];
      return resp ?? { content: 'done', model: 'test-model' };
    }),
    getModel: jest.fn(() => 'test-model'),
    setModel: jest.fn(),
    getConfigSummary: jest.fn(() => ({ model: 'test-model' })),
  } as unknown as jest.Mocked<LLMService>;
}

describe('strategy tracker integration with query()', () => {
  test('records each tool attempt as a strategy attempt', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'flaky_tool', arguments: '{"path":"/a"}' } },
        ],
      },
      { content: 'tried it', model: 'test-model' },
    ]);

    const tracker = createStrategyTracker({ maxAttempts: 5 });
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'do it' },
    ];

    const toolExecutor = async () => JSON.stringify({ success: false, error: 'simulated failure' });

    const events: QueryEvent[] = [];
    for await (const ev of query({
      messages, tools: [failTool], toolExecutor, llm,
      strategyTracker: tracker,
    })) {
      events.push(ev);
    }

    const attempts = tracker.getAttempts();
    expect(attempts.length).toBe(1);
    expect(attempts[0].approach).toBe('flaky_tool');
    expect(attempts[0].result).toBe('failed');
    expect(attempts[0].error).toBe('simulated failure');
    expect(attempts[0].toolsUsed).toContain('flaky_tool');
  });

  test('yields strategy_exhausted and injects suggestion after maxAttempts failures', async () => {
    // Three tool calls in a single turn, then a final response
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'flaky_tool', arguments: '{"path":"/a"}' } },
          { id: 'c2', type: 'function', function: { name: 'flaky_tool', arguments: '{"path":"/b"}' } },
          { id: 'c3', type: 'function', function: { name: 'flaky_tool', arguments: '{"path":"/c"}' } },
        ],
      },
      { content: 'giving up', model: 'test-model' },
    ]);

    const tracker = createStrategyTracker({ maxAttempts: 3 });
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'do it' },
    ];

    const toolExecutor = async () => JSON.stringify({ success: false, error: 'boom' });

    const events: QueryEvent[] = [];
    for await (const ev of query({
      messages, tools: [failTool], toolExecutor, llm,
      strategyTracker: tracker,
    })) {
      events.push(ev);
    }

    const exhausted = events.find(e => e.type === 'strategy_exhausted');
    expect(exhausted).toBeDefined();
    expect((exhausted as any).suggestion).toMatch(/flaky_tool|alternative/i);

    // The suggestion is added as a user message in the conversation
    const userSuggestionMsg = messages.find(
      m => m.role === 'user' && typeof m.content === 'string' && /alternative|flaky_tool/i.test(m.content)
    );
    expect(userSuggestionMsg).toBeDefined();
  });

  test('does not yield strategy_exhausted on successful tool calls', async () => {
    const okTool: OpenHorseTool = buildTool({
      name: 'ok_tool',
      description: 'always works',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ success: true, output: 'ok' }),
    });

    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'ok_tool', arguments: '{}' } },
        ],
      },
      { content: 'done', model: 'test-model' },
    ]);

    const tracker = createStrategyTracker({ maxAttempts: 3 });
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'do it' },
    ];

    const toolExecutor = async () => JSON.stringify({ success: true, output: 'ok' });

    const events: QueryEvent[] = [];
    for await (const ev of query({
      messages, tools: [okTool], toolExecutor, llm,
      strategyTracker: tracker,
    })) {
      events.push(ev);
    }

    expect(events.find(e => e.type === 'strategy_exhausted')).toBeUndefined();
    expect(tracker.getSuccessfulAttempts().length).toBe(1);
    expect(tracker.getFailedAttempts().length).toBe(0);
  });
});
