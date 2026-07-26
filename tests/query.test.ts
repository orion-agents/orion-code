import { DEFAULT_LOOP_BUDGET, query } from '../src/framework/query';
import type { QueryEvent } from '../src/framework/query';
import { buildTool } from '../src/framework/tool';
import type { OpenHorseTool, ToolContext } from '../src/framework/tool';
import type { LLMService, LLMResponse, Message, Tool } from '../src/services/llm';
import { resetAutoCompact } from '../src/services/compact/auto-compact';
import { CompactCoordinator } from '../src/services/compact/coordinator';
import { CostTracker } from '../src/core/cost-tracker';

const mockTool: OpenHorseTool = buildTool({
  name: 'read_file',
  description: 'Read a file',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path' } },
    required: ['path'],
  },
  execute: async () => ({ success: true, output: 'file content' }),
  isReadOnly: () => true,
});

const askTool: OpenHorseTool = buildTool({
  name: 'web_search',
  description: 'Search the web',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Query' } },
    required: ['query'],
  },
  execute: async () => ({ success: true, output: 'search results' }),
  checkPermissions: () => ({ behavior: 'ask', reason: 'External query' }),
});

const batchReadTool: OpenHorseTool = buildTool({
  name: 'batch_read',
  description: 'Batch read-only exploration',
  parameters: {
    type: 'object',
    properties: { steps: { type: 'array', description: 'Steps' } },
    required: ['steps'],
  },
  execute: async () => ({ success: true, output: '' }),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
});

const toolContext: ToolContext = {
  cwd: '/tmp/project',
  config: { name: 'test', mode: 'development' },
};

function makeMockLLM(responses: LLMResponse[], model = 'test-model'): jest.Mocked<LLMService> {
  let callIndex = 0;
  return {
    chat: jest.fn(async () => ({ content: 'compact summary', model })),
    chatStream: jest.fn(async () => {
      const resp = responses[callIndex++];
      return resp ?? { content: 'done', model };
    }),
    getModel: jest.fn(() => model),
    setModel: jest.fn(),
    getConfigSummary: jest.fn(() => ({ model })),
  } as unknown as jest.Mocked<LLMService>;
}

function collectEvents(params: Parameters<typeof query>[0]) {
  const events: QueryEvent[] = [];
  return query(params);
}

describe('query generator', () => {
  beforeEach(() => {
    resetAutoCompact();
  });

  test('yields request_start, message, complete on simple response', async () => {
    const llm = makeMockLLM([{ content: 'Hello!', model: 'test-model' }]);

    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Hi' },
    ];

    const events: QueryEvent[] = [];
    for await (const event of query({
      messages,
      tools: [mockTool],
      toolExecutor: async () => 'result',
      llm,
    })) {
      events.push(event);
    }

    expect(events.length).toBe(3);
    expect(events[0]).toMatchObject({ type: 'request_start', model: 'test-model', turn: 1 });
    expect(events[1]).toMatchObject({ type: 'message', role: 'assistant', content: 'Hello!' });
    expect(events[2]).toMatchObject({ type: 'complete', content: 'Hello!', model: 'test-model' });
    expect(llm.chat).not.toHaveBeenCalled();
  });

  test('accounts for tool-calling model turns as well as the final response', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        usage: { promptTokens: 100, completionTokens: 20, requestId: 'tool-turn' },
        toolCalls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
        }],
      },
      {
        content: 'done',
        model: 'test-model',
        usage: { promptTokens: 200, completionTokens: 30, requestId: 'final-turn' },
      },
    ]);
    const costTracker = new CostTracker();
    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Read a.ts' },
    ];

    for await (const _event of query({
      messages,
      tools: [mockTool],
      toolExecutor: async () => 'file content',
      llm,
      costTracker,
    })) {
      // Drain the loop.
    }

    const stats = costTracker.getStats();
    expect(stats.recordCount).toBe(2);
    expect(stats.totalTokens).toBe(350);
  });

  test('yields prompt assembly stats before model response when harness is active', async () => {
    const llm = makeMockLLM([{ content: 'Hello with context', model: 'test-model' }]);
    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Hi' },
    ];
    const promptAssemblyStats = {
      createdAt: 1,
      modelId: 'test-model',
      budgetTokens: 1200,
      estimatedTokens: 240,
      coreTokens: 120,
      evidenceBudgetTokens: 300,
      recentTurnBudgetTokens: 200,
      includedEvidence: [
        { id: 'ledger-1', kind: 'user_requirement', score: 42, tokens: 20, reason: 'relevant' },
      ],
      omittedEvidence: [
        { id: 'ledger-2', kind: 'tool_result', score: 2, tokens: 50, reason: 'budget' },
      ],
      sections: ['core', 'ranked_evidence'],
    };
    const harness = {
      assembleMessages: jest.fn((inputMessages: Message[]) => inputMessages),
      getCapsule: jest.fn(() => ({ summary: '' })),
      recordAssistantResponse: jest.fn(),
      beforeComplete: jest.fn(() => ({ canComplete: true })),
      toJSON: jest.fn(() => ({ promptAssemblyStats })),
    };
    const events: QueryEvent[] = [];

    for await (const event of query({
      messages,
      tools: [mockTool],
      toolExecutor: async () => 'result',
      llm,
      harness: harness as any,
    })) {
      events.push(event);
    }

    expect(events.map(event => event.type)).toEqual([
      'request_start',
      'prompt_assembly',
      'message',
      'complete',
    ]);
    expect(events[1]).toMatchObject({
      type: 'prompt_assembly',
      modelId: 'test-model',
      estimatedTokens: 240,
      budgetTokens: 1200,
      sections: ['core', 'ranked_evidence'],
      includedEvidence: ['ledger-1:user_requirement:score=42:tokens=20'],
      omittedEvidence: ['ledger-2:tool_result:score=2:tokens=50'],
      includedEvidenceCount: 1,
      omittedEvidenceCount: 1,
    });
  });

  test('yields tool_call and tool_result when tool is called', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"/test"}' },
          },
        ],
      },
      { content: 'The file says hello', model: 'test-model' },
    ]);

    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Read the file' },
    ];

    const executedTools: Array<{ name: string; args: Record<string, unknown> }> = [];
    const events: QueryEvent[] = [];

    for await (const event of query({
      messages,
      tools: [mockTool],
      toolExecutor: async (name, args) => {
        executedTools.push({ name, args });
        return 'file content here';
      },
      llm,
    })) {
      events.push(event);
    }

    // Expect: request_start → tool_call → tool_result → request_start → message → complete
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool_call', name: 'read_file' })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        name: 'read_file',
        callId: 'call-1',
        args: { path: '/test' },
        result: 'file content here',
      })
    );
    expect(executedTools).toHaveLength(1);
    expect(executedTools[0].name).toBe('read_file');
    expect(executedTools[0].args).toEqual({ path: '/test' });
  });

  test('emits multi-tool event sequence in stable runtime order', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"/one"}' },
          },
          {
            id: 'call-2',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"/two"}' },
          },
        ],
      },
      { content: 'Read both files', model: 'test-model' },
    ]);

    const events: QueryEvent[] = [];
    for await (const event of query({
      messages: [
        { role: 'system', content: 'You are a bot.' },
        { role: 'user', content: 'Read two files' },
      ],
      tools: [mockTool],
      toolExecutor: async (_name, args) =>
        JSON.stringify({
          success: true,
          output: `content:${args.path}`,
        }),
      llm,
    })) {
      events.push(event);
    }

    expect(events.map(event => event.type)).toEqual([
      'request_start',
      'assistant_tool_calls',
      'tool_call',
      'tool_call',
      'tool_result',
      'tool_result',
      'request_start',
      'message',
      'complete',
    ]);
    expect(events[2]).toMatchObject({
      type: 'tool_call',
      callId: 'call-1',
      batchCount: 2,
      batchIndex: 0,
    });
    expect(events[3]).toMatchObject({
      type: 'tool_call',
      callId: 'call-2',
      batchCount: 2,
      batchIndex: 1,
    });
    expect(events[4]).toMatchObject({
      type: 'tool_result',
      callId: 'call-1',
      batchCount: 2,
      batchIndex: 0,
    });
    expect(events[5]).toMatchObject({
      type: 'tool_result',
      callId: 'call-2',
      batchCount: 2,
      batchIndex: 1,
    });
  });

  test('propagates structured tool result summary metadata', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"/test"}' },
          },
        ],
      },
      { content: 'Done', model: 'test-model' },
    ]);

    const events: QueryEvent[] = [];

    for await (const event of query({
      messages: [
        { role: 'system', content: 'You are a bot.' },
        { role: 'user', content: 'Read the file' },
      ],
      tools: [mockTool],
      toolExecutor: async () =>
        JSON.stringify({
          success: true,
          output: 'file content',
          summary: 'read /test (1L, 12B)',
          outputBytes: 12,
        }),
      llm,
    })) {
      events.push(event);
    }

    const toolResult = events.find(event => event.type === 'tool_result') as Extract<
      QueryEvent,
      { type: 'tool_result' }
    >;
    expect(toolResult.summary).toBe('read /test (1L, 12B)');
    expect(toolResult.outputBytes).toBe(12);
  });

  test('reports loop stats on complete events', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"/test"}' },
          },
        ],
      },
      { content: 'Done', model: 'test-model' },
    ]);

    const events: QueryEvent[] = [];
    for await (const event of query({
      messages: [
        { role: 'system', content: 'You are a bot.' },
        { role: 'user', content: 'Read the file' },
      ],
      tools: [mockTool],
      toolExecutor: async () =>
        JSON.stringify({
          success: true,
          output: 'file content',
          summary: 'read /test',
          outputBytes: 12,
        }),
      llm,
    })) {
      events.push(event);
    }

    const complete = events.find(event => event.type === 'complete') as Extract<
      QueryEvent,
      { type: 'complete' }
    >;
    expect(complete.stats).toMatchObject({
      finishReason: 'completed',
      turnsStarted: 2,
      llmRequests: 2,
      toolCalls: 1,
      readOnlyToolCalls: 1,
      unsafeToolCalls: 0,
      toolResultBytes: 12,
    });
    expect(complete.stats?.modelVisibleToolBytes).toBeGreaterThan(0);
  });

  test('merges provider retry and fallback diagnostics into loop stats', async () => {
    const llm = makeMockLLM([{ content: 'Recovered', model: 'fallback-model' }]);
    (llm as any).getLastRequestDiagnostics = jest.fn(() => ({
      retryCount: 3,
      retryDelayMs: 12,
      retryErrorTypes: ['rate_limit', 'provider_busy', 'rate_limit'],
      lastRetryErrorType: 'rate_limit',
      lastRetryStatus: 429,
      fallbackTriggered: true,
      fallbackFromModel: 'primary-model',
      fallbackToModel: 'fallback-model',
      finalModel: 'fallback-model',
      usingFallback: true,
    }));

    const events: QueryEvent[] = [];
    for await (const event of query({
      messages: [
        { role: 'system', content: 'You are a bot.' },
        { role: 'user', content: 'Recover from provider pressure' },
      ],
      tools: [mockTool],
      toolExecutor: async () => 'result',
      llm,
    })) {
      events.push(event);
    }

    const complete = events.find(event => event.type === 'complete') as Extract<
      QueryEvent,
      { type: 'complete' }
    >;
    expect(complete.stats).toMatchObject({
      finishReason: 'completed',
      providerRetryCount: 3,
      providerRetryDelayMs: 12,
      providerRetryErrorTypes: ['rate_limit', 'provider_busy'],
      providerLastRetryErrorType: 'rate_limit',
      providerLastRetryStatus: 429,
      providerFallbackCount: 1,
      providerFallbackFromModel: 'primary-model',
      providerFallbackToModel: 'fallback-model',
      providerFinalModel: 'fallback-model',
      providerUsingFallback: true,
    });
  });

  test('stops before another model request when LLM request budget is reached', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"/test"}' },
          },
        ],
      },
      { content: 'should not be requested', model: 'test-model' },
    ]);

    const events: QueryEvent[] = [];
    for await (const event of query({
      messages: [
        { role: 'system', content: 'You are a bot.' },
        { role: 'user', content: 'Read repeatedly' },
      ],
      tools: [mockTool],
      toolExecutor: async () => JSON.stringify({ success: true, output: 'file content' }),
      llm,
      loopBudget: { maxLlmRequestsPerUserTurn: 1 },
    })) {
      events.push(event);
    }

    const complete = events[events.length - 1] as Extract<QueryEvent, { type: 'complete' }>;
    expect(llm.chatStream).toHaveBeenCalledTimes(1);
    expect(complete).toMatchObject({
      type: 'complete',
      stats: {
        finishReason: 'budget_exceeded',
        budgetExceededReason: 'LLM request budget 1 reached',
        llmRequests: 1,
        loopBudgetSource: 'config',
        loopBudgetMaxLlmRequests: 1,
        loopBudgetMaxToolCalls: DEFAULT_LOOP_BUDGET.maxToolCallsPerUserTurn,
        loopBudgetConfigOverride: true,
        continuationActions: [
          'reply_continue',
          'narrow_instruction',
          'inspect_loop_stats',
          'raise_budget',
        ],
      },
    });
    expect(complete.stats?.continuationHint).toContain('Reply `继续`');
    expect(complete.content).toContain('Agent loop budget reached');
    expect(complete.content).toContain('preserved the current session state');
    expect(complete.content).toContain('reply `继续`');
    expect(complete.content).toContain('raise agentLoop.budget');
  });

  test('stops before executing tools when tool-call budget would be exceeded', async () => {
    const llm = makeMockLLM([
      {
        content: 'Need several files',
        model: 'test-model',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"/one"}' },
          },
          {
            id: 'call-2',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"/two"}' },
          },
        ],
      },
    ]);
    const toolExecutor = jest.fn(async () =>
      JSON.stringify({ success: true, output: 'file content' })
    );

    const events: QueryEvent[] = [];
    for await (const event of query({
      messages: [
        { role: 'system', content: 'You are a bot.' },
        { role: 'user', content: 'Read both files' },
      ],
      tools: [mockTool],
      toolExecutor,
      llm,
      loopBudget: { maxToolCallsPerUserTurn: 1 },
    })) {
      events.push(event);
    }

    const complete = events[events.length - 1] as Extract<QueryEvent, { type: 'complete' }>;
    expect(llm.chatStream).toHaveBeenCalledTimes(1);
    expect(toolExecutor).not.toHaveBeenCalled();
    expect(events.some(event => event.type === 'assistant_tool_calls')).toBe(false);
    expect(events.some(event => event.type === 'tool_call')).toBe(false);
    expect(complete).toMatchObject({
      type: 'complete',
      stats: {
        finishReason: 'budget_exceeded',
        budgetExceededReason: 'tool call budget 1 would be exceeded by 2 requested tools',
        llmRequests: 1,
        toolCalls: 0,
        loopBudgetMaxToolCalls: 1,
        continuationActions: [
          'reply_continue',
          'narrow_instruction',
          'inspect_loop_stats',
          'raise_budget',
        ],
      },
    });
    expect(complete.stats?.continuationHint).toContain('Reply `继续`');
  });

  test('promotes default budget when a task becomes a tool-heavy loop', async () => {
    const toolResponses: LLMResponse[] = Array.from({ length: 24 }, (_, index) => ({
      content: '',
      model: 'test-model',
      toolCalls: [
        {
          id: `call-${index}`,
          type: 'function',
          function: { name: 'read_file', arguments: `{"path":"/test-${index}"}` },
        },
      ],
    }));
    const llm = makeMockLLM([
      ...toolResponses,
      { content: 'Done after promoted budget', model: 'test-model' },
    ]);

    const events: QueryEvent[] = [];
    for await (const event of query({
      messages: [
        { role: 'system', content: 'You are a bot.' },
        { role: 'user', content: 'work on it' },
      ],
      tools: [mockTool],
      toolExecutor: async () => JSON.stringify({ success: true, output: 'file content' }),
      llm,
    })) {
      events.push(event);
    }

    const complete = events[events.length - 1] as Extract<QueryEvent, { type: 'complete' }>;
    expect(llm.chatStream).toHaveBeenCalledTimes(25);
    expect(complete).toMatchObject({
      type: 'complete',
      content: 'Done after promoted budget',
      stats: {
        finishReason: 'completed',
        llmRequests: 25,
        toolCalls: 24,
        loopBudgetSource: 'complex',
        loopBudgetBaseProfile: 'complex',
        loopBudgetMaxLlmRequests: 48,
        loopBudgetMaxToolCalls: 180,
      },
    });
  });

  test('does not promote direct custom LLM request caps', async () => {
    const toolResponses: LLMResponse[] = Array.from({ length: 8 }, (_, index) => ({
      content: '',
      model: 'test-model',
      toolCalls: [
        {
          id: `call-${index}`,
          type: 'function',
          function: { name: 'read_file', arguments: `{"path":"/test-${index}"}` },
        },
      ],
    }));
    const llm = makeMockLLM([
      ...toolResponses,
      { content: 'should not be requested', model: 'test-model' },
    ]);

    const events: QueryEvent[] = [];
    for await (const event of query({
      messages: [
        { role: 'system', content: 'You are a bot.' },
        { role: 'user', content: 'work on it' },
      ],
      tools: [mockTool],
      toolExecutor: async () => JSON.stringify({ success: true, output: 'file content' }),
      llm,
      loopBudget: { maxLlmRequestsPerUserTurn: 8 },
    })) {
      events.push(event);
    }

    const complete = events[events.length - 1] as Extract<QueryEvent, { type: 'complete' }>;
    expect(llm.chatStream).toHaveBeenCalledTimes(8);
    expect(complete).toMatchObject({
      type: 'complete',
      stats: {
        finishReason: 'budget_exceeded',
        budgetExceededReason: 'LLM request budget 8 reached',
        llmRequests: 8,
        toolCalls: 8,
        loopBudgetSource: 'config',
        loopBudgetMaxLlmRequests: 8,
        loopBudgetConfigOverride: true,
      },
    });
  });

  test('does not promote the default budget for repeated model-only completion-gate loops', async () => {
    const llm = makeMockLLM([
      ...Array.from({ length: 24 }, (_, index) => ({
        content: `pass ${index}`,
        model: 'test-model',
      })),
      { content: 'should not be requested', model: 'test-model' },
    ]);
    const harness = {
      assembleMessages: jest.fn((inputMessages: Message[]) => inputMessages),
      getCapsule: jest.fn(() => ({ summary: '' })),
      recordAssistantResponse: jest.fn(),
      beforeComplete: jest.fn(() => ({ canComplete: false, reason: 'needs verification' })),
      asCompletionBlockedMessage: jest.fn(() => ({
        role: 'user' as const,
        content: 'Continue until verified.',
      })),
      toJSON: jest.fn(() => ({})),
    };

    const events: QueryEvent[] = [];
    for await (const event of query({
      messages: [
        { role: 'system', content: 'You are a bot.' },
        { role: 'user', content: 'Answer carefully' },
      ],
      tools: [mockTool],
      toolExecutor: async () => JSON.stringify({ success: true, output: 'unused' }),
      llm,
      harness: harness as any,
    })) {
      events.push(event);
    }

    const complete = events[events.length - 1] as Extract<QueryEvent, { type: 'complete' }>;
    expect(llm.chatStream).toHaveBeenCalledTimes(24);
    expect(complete).toMatchObject({
      type: 'complete',
      stats: {
        finishReason: 'budget_exceeded',
        budgetExceededReason: 'LLM request budget 24 reached',
        llmRequests: 24,
        toolCalls: 0,
        loopBudgetSource: 'default',
        loopBudgetBaseProfile: 'default',
        loopBudgetMaxLlmRequests: 24,
      },
    });
  });

  test('records fragmented single read-only turns and injects batch_read guidance', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"/one"}' },
          },
        ],
      },
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          {
            id: 'call-2',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"/two"}' },
          },
        ],
      },
      { content: 'Done', model: 'test-model' },
    ]);

    const events: QueryEvent[] = [];
    for await (const event of query({
      messages: [
        { role: 'system', content: 'You are a bot.' },
        { role: 'user', content: 'Inspect slowly' },
      ],
      tools: [mockTool],
      toolExecutor: async (_name, args) =>
        JSON.stringify({ success: true, output: `content:${args.path}` }),
      llm,
      loopBudget: { maxReadOnlyFragmentation: 2 },
    })) {
      events.push(event);
    }

    const thirdRequestMessages = (llm.chatStream as jest.Mock).mock.calls[2][0] as Message[];
    expect(thirdRequestMessages.map(message => message.content).join('\n')).toContain(
      'prefer batch_read'
    );
    const complete = events.find(event => event.type === 'complete') as Extract<
      QueryEvent,
      { type: 'complete' }
    >;
    expect(complete.stats).toMatchObject({
      singleReadOnlyStreak: 2,
      batchReadSuggestionCount: 1,
      loopBudgetMaxReadOnlyFragmentation: 2,
    });
  });

  test('compresses model-visible tool results while preserving full UI event results', async () => {
    const largeOutput = 'line with details\n'.repeat(1000);
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"/large"}' },
          },
        ],
      },
      { content: 'Done', model: 'test-model' },
    ]);
    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Read the large file' },
    ];
    const events: QueryEvent[] = [];

    for await (const event of query({
      messages,
      tools: [mockTool],
      toolExecutor: async () =>
        JSON.stringify({
          success: true,
          output: largeOutput,
          summary: 'read /large (1000L)',
          outputBytes: Buffer.byteLength(largeOutput, 'utf8'),
          artifactRef: {
            id: 'read_file-large',
            outputBytes: Buffer.byteLength(largeOutput, 'utf8'),
          },
        }),
      llm,
      maxModelVisibleToolResultBytes: 700,
    })) {
      events.push(event);
    }

    const toolResult = events.find(event => event.type === 'tool_result') as Extract<
      QueryEvent,
      { type: 'tool_result' }
    >;
    expect(JSON.parse(toolResult.result).output).toContain(largeOutput.slice(0, 100));
    expect(Buffer.byteLength(toolResult.modelVisibleResult, 'utf8')).toBeLessThanOrEqual(700);
    expect(toolResult.modelVisibleResult).not.toBe(toolResult.result);
    expect(toolResult.artifactRef).toEqual({
      id: 'read_file-large',
      outputBytes: Buffer.byteLength(largeOutput, 'utf8'),
    });

    const toolMessage = messages.find(message => message.role === 'tool');
    expect(toolMessage?.content.length).toBeLessThan(toolResult.result.length);
    expect(Buffer.byteLength(toolMessage?.content ?? '', 'utf8')).toBeLessThanOrEqual(700);
    expect(toolMessage?.content).toContain('modelVisibleCompressed');
    expect(toolMessage?.content).toContain('read_file-large');

    const complete = events.find(event => event.type === 'complete') as Extract<
      QueryEvent,
      { type: 'complete' }
    >;
    expect(complete.stats?.toolResultBytes).toBe(Buffer.byteLength(largeOutput, 'utf8'));
    expect(complete.stats?.modelVisibleToolBytes).toBeLessThan(
      complete.stats?.toolResultBytes ?? 0
    );
    expect(complete.stats?.summarizedBytes).toBeGreaterThan(0);
  });

  test('caps aggregate model-visible tool result bytes while preserving full event results', async () => {
    const largeOutput = 'line with details\n'.repeat(1000);
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"/one"}' },
          },
          {
            id: 'call-2',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"/two"}' },
          },
        ],
      },
      { content: 'Done', model: 'test-model' },
    ]);
    const events: QueryEvent[] = [];

    for await (const event of query({
      messages: [
        { role: 'system', content: 'You are a bot.' },
        { role: 'user', content: 'Read large files' },
      ],
      tools: [mockTool],
      toolExecutor: async () =>
        JSON.stringify({
          success: true,
          output: largeOutput,
          summary: 'large read',
          outputBytes: Buffer.byteLength(largeOutput, 'utf8'),
          artifactRef: { id: 'large-output', outputBytes: Buffer.byteLength(largeOutput, 'utf8') },
        }),
      llm,
      maxModelVisibleToolResultBytes: 700,
      loopBudget: { maxModelVisibleToolBytes: 700 },
    })) {
      events.push(event);
    }

    const toolResults = events.filter(event => event.type === 'tool_result') as Array<
      Extract<QueryEvent, { type: 'tool_result' }>
    >;
    expect(toolResults).toHaveLength(2);
    expect(JSON.parse(toolResults[0].result).output).toContain(largeOutput.slice(0, 100));
    expect(JSON.parse(toolResults[1].result).output).toContain(largeOutput.slice(0, 100));
    expect(toolResults[1].modelVisibleResult).toContain('modelVisibleBudgetExceeded');
    const complete = events.find(event => event.type === 'complete') as Extract<
      QueryEvent,
      { type: 'complete' }
    >;
    expect(complete.stats?.modelVisibleToolBytes).toBeLessThan(
      complete.stats?.toolResultBytes ?? 0
    );
    expect(complete.stats?.summarizedBytes).toBeGreaterThan(0);
  });

  test('keeps model-visible tool result under byte budget for CJK output and long metadata', async () => {
    const largeOutput = '中文输出🙂'.repeat(1000);
    const longSummary = '摘要🙂'.repeat(300);
    const longError = '错误🙂'.repeat(300);
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"/large"}' },
          },
        ],
      },
      { content: 'Done', model: 'test-model' },
    ]);
    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Read the large file' },
    ];

    for await (const _event of query({
      messages,
      tools: [mockTool],
      toolExecutor: async () =>
        JSON.stringify({
          success: false,
          output: largeOutput,
          summary: longSummary,
          error: longError,
          outputBytes: Buffer.byteLength(largeOutput, 'utf8'),
        }),
      llm,
      maxModelVisibleToolResultBytes: 700,
    })) {
      // consume
    }

    const toolMessage = messages.find(message => message.role === 'tool');
    expect(Buffer.byteLength(toolMessage?.content ?? '', 'utf8')).toBeLessThanOrEqual(700);
    expect(toolMessage?.content).toContain('modelVisibleCompressed');
  });

  test('records batch_read inner steps as harness evidence without changing tool protocol', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          {
            id: 'call-batch',
            type: 'function',
            function: {
              name: 'batch_read',
              arguments: JSON.stringify({
                steps: [
                  { tool: 'read_file', args: { path: 'src/index.ts' } },
                  { tool: 'grep', args: { pattern: 'TODO', path: 'src' } },
                ],
              }),
            },
          },
        ],
      },
      { content: 'Done', model: 'test-model' },
    ]);
    const harness = {
      assembleMessages: jest.fn((messages: Message[]) => messages),
      getCapsule: jest.fn(() => ({ summary: '' })),
      toJSON: jest.fn(() => ({})),
      recordAssistantResponse: jest.fn(),
      beforeToolUse: jest.fn(() => undefined),
      asToolBlockedResult: jest.fn(),
      beforeComplete: jest.fn(() => ({ canComplete: true })),
      asCompletionBlockedMessage: jest.fn(),
      recordToolResult: jest.fn(),
    };
    const batchPayload = {
      success: true,
      output: '1. read_file: read src/index.ts\n2. grep: grep TODO',
      summary: 'batch_read completed 2/2 steps',
      steps: [
        {
          index: 1,
          tool: 'read_file',
          args: { path: 'src/index.ts' },
          success: true,
          summary: 'read src/index.ts (10L, 100B)',
          output: 'file content',
        },
        {
          index: 2,
          tool: 'grep',
          args: { pattern: 'TODO', path: 'src' },
          success: true,
          summary: 'grep /TODO/ -> 3 matches',
          output: 'src/index.ts:1:TODO',
        },
      ],
    };
    const events: QueryEvent[] = [];

    for await (const event of query({
      messages: [
        { role: 'system', content: 'You are a bot.' },
        { role: 'user', content: 'Inspect project' },
      ],
      tools: [batchReadTool],
      toolExecutor: async () =>
        JSON.stringify({
          success: true,
          output: JSON.stringify(batchPayload),
          summary: batchPayload.summary,
          outputBytes: 120,
        }),
      llm,
      harness: harness as any,
    })) {
      events.push(event);
    }

    expect(events.filter(event => event.type === 'tool_result')).toHaveLength(1);
    expect(harness.recordToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'batch_read',
        summary: batchPayload.summary,
      })
    );
    expect(harness.recordToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'read_file',
        args: { path: 'src/index.ts' },
        summary: 'read src/index.ts (10L, 100B)',
      })
    );
    expect(harness.recordToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'grep',
        args: { pattern: 'TODO', path: 'src' },
        summary: 'grep /TODO/ -> 3 matches',
      })
    );
  });

  test('runs concurrency-safe tool calls in parallel and preserves result order', async () => {
    const safeTools = ['glob', 'grep'].map(name =>
      buildTool({
        name,
        description: `Run ${name}`,
        parameters: {
          type: 'object',
          properties: { pattern: { type: 'string', description: 'Pattern' } },
          required: ['pattern'],
        },
        execute: async () => ({ success: true, output: 'ok' }),
        isConcurrencySafe: () => true,
        isReadOnly: () => true,
      })
    );
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'glob', arguments: '{"pattern":"*.ts"}' },
          },
          {
            id: 'call-2',
            type: 'function',
            function: { name: 'grep', arguments: '{"pattern":"needle"}' },
          },
        ],
      },
      { content: 'Done', model: 'test-model' },
    ]);
    let active = 0;
    let maxActive = 0;
    const events: QueryEvent[] = [];

    for await (const event of query({
      messages: [
        { role: 'system', content: 'You are a bot.' },
        { role: 'user', content: 'Search' },
      ],
      tools: safeTools,
      toolExecutor: async name => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, name === 'glob' ? 30 : 10));
        active--;
        return JSON.stringify({ success: true, output: name });
      },
      llm,
    })) {
      events.push(event);
    }

    expect(maxActive).toBe(2);
    expect(
      events
        .filter(event => event.type === 'tool_result')
        .map(event => (event as Extract<QueryEvent, { type: 'tool_result' }>).name)
    ).toEqual(['glob', 'grep']);
  });

  test('respects abort signal', async () => {
    const controller = new AbortController();
    controller.abort();

    const llm = makeMockLLM([{ content: 'should not reach', model: 'test-model' }]);

    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Hi' },
    ];

    const events: QueryEvent[] = [];
    for await (const event of query({
      messages,
      tools: [mockTool],
      toolExecutor: async () => 'result',
      llm,
      abortSignal: controller.signal,
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'complete',
      content: 'Operation cancelled.',
    });
    // chatStream should never have been called
    expect(llm.chatStream).not.toHaveBeenCalled();
  });

  test('reports cancelled stats when aborted after tool execution', async () => {
    const controller = new AbortController();
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"/test"}' },
          },
        ],
      },
    ]);
    const events: QueryEvent[] = [];

    for await (const event of query({
      messages: [
        { role: 'system', content: 'You are a bot.' },
        { role: 'user', content: 'Read' },
      ],
      tools: [mockTool],
      toolExecutor: async () => {
        controller.abort();
        return JSON.stringify({ success: true, output: 'late output' });
      },
      llm,
      abortSignal: controller.signal,
    })) {
      events.push(event);
    }

    const complete = events.find(event => event.type === 'complete') as Extract<
      QueryEvent,
      { type: 'complete' }
    >;
    expect(complete).toMatchObject({
      type: 'complete',
      content: 'Operation cancelled.',
      stats: {
        finishReason: 'cancelled',
        turnsStarted: 1,
        llmRequests: 1,
        toolCalls: 1,
      },
    });
    expect(events.some(event => event.type === 'tool_result')).toBe(false);
  });

  test('passes abort signal to chatStream', async () => {
    const controller = new AbortController();
    const llm = makeMockLLM([{ content: 'Hello!', model: 'test-model' }]);

    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Hi' },
    ];

    for await (const _event of query({
      messages,
      tools: [mockTool],
      toolExecutor: async () => 'result',
      llm,
      abortSignal: controller.signal,
    })) {
      // consume
    }

    expect(llm.chatStream).toHaveBeenCalledWith(expect.any(Array), undefined, expect.any(Array), {
      abortSignal: controller.signal,
    });
  });

  test('does not emit assistant message when aborted after stream returns', async () => {
    const controller = new AbortController();
    const llm = {
      chatStream: jest.fn(async () => {
        controller.abort();
        return { content: 'late response', model: 'test-model' };
      }),
      getModel: jest.fn(() => 'test-model'),
    } as unknown as jest.Mocked<LLMService>;

    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Hi' },
    ];

    const events: QueryEvent[] = [];
    for await (const event of query({
      messages,
      tools: [mockTool],
      toolExecutor: async () => 'result',
      llm,
      abortSignal: controller.signal,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({ type: 'request_start' }),
      expect.objectContaining({ type: 'complete', content: 'Operation cancelled.' }),
    ]);
    expect(messages).toHaveLength(2);
  });

  test('reaches max turns and returns truncation message', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"/1"}' },
          },
        ],
      },
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          {
            id: 'call-2',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"/2"}' },
          },
        ],
      },
    ]);

    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Go' },
    ];

    const events: QueryEvent[] = [];
    for await (const event of query({
      messages,
      tools: [mockTool],
      toolExecutor: async () => 'result',
      llm,
      maxTurns: 1,
    })) {
      events.push(event);
    }

    const complete = events.find(e => e.type === 'complete');
    expect(complete).toBeDefined();

    expect((complete as any).content).toContain('Reached maximum turns');
    expect(events.filter(e => e.type === 'request_start')).toHaveLength(1);
    expect((complete as Extract<QueryEvent, { type: 'complete' }>).stats).toMatchObject({
      finishReason: 'max_turns',
      turnsStarted: 1,
      llmRequests: 1,
    });
  });

  test('passes usage info in complete event', async () => {
    const llm = makeMockLLM([
      {
        content: 'Answer',
        model: 'test-model',
        usage: { promptTokens: 10, completionTokens: 20 },
      },
    ]);

    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Hi' },
    ];

    const events: QueryEvent[] = [];
    for await (const event of query({
      messages,
      tools: [mockTool],
      toolExecutor: async () => 'result',
      llm,
    })) {
      events.push(event);
    }

    const complete = events.find(e => e.type === 'complete') as any;
    expect(complete.usage).toEqual({ promptTokens: 10, completionTokens: 20 });
  });

  test('runs predictive compact before sending an oversized request', async () => {
    const llm = makeMockLLM([{ content: 'Answer', model: 'gpt-4' }], 'gpt-4');

    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      ...Array.from({ length: 30 }, (_, index) => ({
        role: 'user' as const,
        content: `large historical message ${index} ${'x'.repeat(4000)}`,
      })),
    ];
    const originalLength = messages.length;
    const contextUpdates = jest.fn();
    const autoCompactNotices = jest.fn();
    const coordinator = new CompactCoordinator({ modelId: 'gpt-4', llm });
    const events: QueryEvent[] = [];

    for await (const event of query({
      messages,
      tools: [mockTool],
      toolExecutor: async () => 'result',
      llm,
      onContextUsage: contextUpdates,
      onAutoCompact: autoCompactNotices,
      compactCoordinator: coordinator,
    })) {
      events.push(event);
    }

    expect(llm.chat).toHaveBeenCalled();
    const requestMessages = (llm.chatStream as jest.Mock).mock.calls[0][0] as Message[];
    expect(requestMessages.length).toBeLessThan(originalLength);
    expect(requestMessages.map(message => message.content).join('\n')).toContain(
      '[Context Summary]'
    );
    expect(contextUpdates).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'gpt-4',
        autoCompactThresholdPercent: 95,
      })
    );
    expect(autoCompactNotices).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'predictive',
        before: expect.objectContaining({ percent: 100 }),
      })
    );
    const complete = events.find(
      (event): event is Extract<QueryEvent, { type: 'complete' }> => event.type === 'complete'
    );
    expect(complete?.compact).toMatchObject({
      mode: expect.stringMatching(/^(predictive|threshold)$/),
      summary: { text: 'compact summary', source: 'llm' },
      before: { percent: 100 },
    });
    expect(complete?.compact?.modelHistory.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Answer',
    });
  });

  test('increments turn counter correctly', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"/1"}' },
          },
        ],
      },
      { content: 'Final answer', model: 'test-model' },
    ]);

    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Go' },
    ];

    const requestStarts: QueryEvent[] = [];
    for await (const event of query({
      messages,
      tools: [mockTool],
      toolExecutor: async () => 'result',
      llm,
    })) {
      if (event.type === 'request_start') requestStarts.push(event);
    }

    expect(requestStarts).toHaveLength(2);
    expect((requestStarts[0] as any).turn).toBe(1);
    expect((requestStarts[1] as any).turn).toBe(2);
  });

  test('allows ask-permission tools when toolConfirmation is allow', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"openhorse"}' },
          },
        ],
      },
      { content: 'Final answer', model: 'test-model' },
    ]);

    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Search' },
    ];
    const toolExecutor = jest.fn(async () => JSON.stringify({ success: true, output: 'ok' }));
    const events: QueryEvent[] = [];

    for await (const event of query({
      messages,
      tools: [askTool],
      toolExecutor,
      llm,
      permissionMode: 'default',
      toolConfirmation: 'allow',
      toolContext,
    })) {
      events.push(event);
    }

    expect(toolExecutor).toHaveBeenCalledWith('web_search', { query: 'openhorse' }, undefined);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        name: 'web_search',
        success: true,
      })
    );
  });

  test('denies ask-permission tools when toolConfirmation is deny', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"openhorse"}' },
          },
        ],
      },
      { content: 'Final answer', model: 'test-model' },
    ]);

    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Search' },
    ];
    const toolExecutor = jest.fn(async () => JSON.stringify({ success: true, output: 'ok' }));
    const events: QueryEvent[] = [];

    for await (const event of query({
      messages,
      tools: [askTool],
      toolExecutor,
      llm,
      permissionMode: 'default',
      toolConfirmation: 'deny',
      toolContext,
    })) {
      events.push(event);
    }

    const toolResult = events.find(event => event.type === 'tool_result') as Extract<
      QueryEvent,
      { type: 'tool_result' }
    >;
    const complete = events.find(event => event.type === 'complete') as Extract<
      QueryEvent,
      { type: 'complete' }
    >;
    expect(toolExecutor).not.toHaveBeenCalled();
    expect(toolResult.success).toBe(false);
    expect(toolResult.error).toContain('toolConfirmation=deny');
    expect(llm.chatStream).toHaveBeenCalledTimes(1);
    expect(complete.content).toContain('permission was denied');
    expect(complete.stats).toMatchObject({
      finishReason: 'blocked',
      llmRequests: 1,
      toolCalls: 1,
    });
  });

  test('does not inject extra user noise after failed tool results', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"/missing"}' },
          },
        ],
      },
      { content: 'The file is missing.', model: 'test-model' },
    ]);

    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Read the file' },
    ];

    for await (const _event of query({
      messages,
      tools: [mockTool],
      toolExecutor: async () =>
        JSON.stringify({
          success: false,
          output: '',
          error: 'not found',
        }),
      llm,
    })) {
      // consume
    }

    expect(messages.map(message => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(messages.map(message => message.content).join('\n')).not.toContain(
      '[System] Tool read_file failed'
    );
    const secondRequest = (llm.chatStream as jest.Mock).mock.calls[1][0] as Message[];
    expect(secondRequest.map(message => message.content).join('\n')).not.toContain(
      '[System] Tool read_file failed'
    );
  });

  test('uses interactive confirmation hook for ask-permission tools', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"openhorse"}' },
          },
        ],
      },
      { content: 'Final answer', model: 'test-model' },
    ]);

    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Search' },
    ];
    const toolExecutor = jest.fn(async () => JSON.stringify({ success: true, output: 'ok' }));
    const confirmToolUse = jest.fn(async () => true);
    const events: QueryEvent[] = [];

    for await (const event of query({
      messages,
      tools: [askTool],
      toolExecutor,
      llm,
      permissionMode: 'default',
      toolConfirmation: 'ask',
      confirmToolUse,
      toolContext,
    })) {
      events.push(event);
    }

    expect(confirmToolUse).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'web_search',
        args: { query: 'openhorse' },
        reason: 'External query',
      })
    );
    expect(toolExecutor).toHaveBeenCalledWith('web_search', { query: 'openhorse' }, undefined);
    const eventTypes = events.map(event => event.type);
    expect(eventTypes.indexOf('permission_decision')).toBeGreaterThan(
      eventTypes.indexOf('tool_call')
    );
    expect(eventTypes.indexOf('permission_decision')).toBeLessThan(
      eventTypes.indexOf('tool_result')
    );
    expect(events.find(event => event.type === 'permission_decision')).toMatchObject({
      type: 'permission_decision',
      name: 'web_search',
      callId: 'call-1',
      decision: {
        behavior: 'ask',
        approved: true,
        source: 'user',
        reason: 'External query',
      },
    });
  });

  test('interactive confirmation hook can deny ask-permission tools', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"openhorse"}' },
          },
        ],
      },
      { content: 'Final answer', model: 'test-model' },
    ]);

    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Search' },
    ];
    const toolExecutor = jest.fn(async () => JSON.stringify({ success: true, output: 'ok' }));
    const events: QueryEvent[] = [];

    for await (const event of query({
      messages,
      tools: [askTool],
      toolExecutor,
      llm,
      permissionMode: 'default',
      toolConfirmation: 'ask',
      confirmToolUse: async () => false,
      toolContext,
    })) {
      events.push(event);
    }

    const toolResult = events.find(event => event.type === 'tool_result') as Extract<
      QueryEvent,
      { type: 'tool_result' }
    >;
    const decision = events.find(event => event.type === 'permission_decision') as Extract<
      QueryEvent,
      { type: 'permission_decision' }
    >;
    const complete = events.find(event => event.type === 'complete') as Extract<
      QueryEvent,
      { type: 'complete' }
    >;
    expect(toolExecutor).not.toHaveBeenCalled();
    expect(decision.decision).toMatchObject({
      behavior: 'ask',
      approved: false,
      source: 'user',
      reason: 'External query',
    });
    expect(toolResult.success).toBe(false);
    expect(toolResult.error).toContain('denied by user');
    expect(llm.chatStream).toHaveBeenCalledTimes(1);
    expect(complete.content).toContain('permission was denied');
    expect(complete.stats).toMatchObject({
      finishReason: 'blocked',
      llmRequests: 1,
      toolCalls: 1,
    });
  });
});
