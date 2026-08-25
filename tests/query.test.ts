import {
  DEFAULT_LOOP_BUDGET,
  QueryLoopError,
  query,
  withLoopFinishReason,
} from '../src/framework/query';
import type { QueryEvent } from '../src/framework/query';
import { buildTool } from '../src/framework/tool';
import type { OrionCodeTool, ToolContext } from '../src/framework/tool';
import { LLMService, type LLMResponse, type Message, type Tool } from '../src/services/llm';
import { ProviderResilienceCoordinator } from '../src/services/provider-resilience';
import { resetAutoCompact } from '../src/services/compact/auto-compact';
import { CompactCoordinator } from '../src/services/compact/coordinator';
import { canonicalMessagesFingerprint } from '../src/services/compact/fingerprint';
import { CostTracker } from '../src/core/cost-tracker';
import { estimateMessagesTokens } from '../src/utils/token-estimate';
import { createContextHarness } from '../src/harness';

const mockTool: OrionCodeTool = buildTool({
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

const askTool: OrionCodeTool = buildTool({
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

const batchReadTool: OrionCodeTool = buildTool({
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
  test('refreshes the typed decision when a consumer changes the finish reason', () => {
    const stats = withLoopFinishReason(
      {
        turnsStarted: 1,
        llmRequests: 1,
        toolCalls: 0,
        readOnlyToolCalls: 0,
        unsafeToolCalls: 0,
        toolResultBytes: 0,
        modelVisibleToolBytes: 0,
        summarizedBytes: 0,
        finishReason: 'completed',
        providerRetryCount: 0,
        providerRetryDelayMs: 0,
        providerRetryErrorTypes: [],
        providerFallbackCount: 0,
        providerUsingFallback: false,
        singleReadOnlyStreak: 0,
        batchReadSuggestionCount: 0,
        localFastPathUsed: false,
        stopDecision: {
          schemaVersion: 1,
          scope: 'request',
          status: 'completed',
          disposition: 'finish_scope',
          reason: { code: 'completed', message: 'old decision' },
          evidence: [],
          nextActions: [],
          resources: {},
        },
      },
      'completion_gate'
    );

    expect(stats).toMatchObject({
      finishReason: 'completion_gate',
      stopDecision: {
        scope: 'request',
        status: 'stopped',
        disposition: 'resume_allowed',
        reason: { code: 'completion_gate' },
      },
    });
  });

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

  test('resolves an exact tool set at every model request boundary', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          {
            id: 'call-step-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
          },
        ],
      },
      { content: 'done', model: 'test-model' },
    ]);
    const resolveStep = jest
      .fn()
      .mockResolvedValueOnce({ tools: [mockTool], toolExecutor: async () => 'file content' })
      .mockResolvedValueOnce({ tools: [askTool], toolExecutor: async () => 'search results' });

    for await (const _event of query({
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'inspect' },
      ],
      tools: [],
      toolExecutor: async () => 'legacy executor must not run',
      llm,
      resolveStep,
    })) {
      // drain
    }

    expect(resolveStep).toHaveBeenCalledTimes(2);
    expect(resolveStep.mock.calls.map(call => call[0].requestIndex)).toEqual([0, 1]);
    expect(
      (llm.chatStream as jest.Mock).mock.calls.map(call =>
        (call[2] as Tool[]).map(tool => tool.function.name)
      )
    ).toEqual([['read_file'], ['web_search']]);
  });

  test('delegates permission and stable call identity to ToolGateway boundary', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          {
            id: 'gateway-call',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"orion"}' },
          },
        ],
      },
      { content: 'done', model: 'test-model' },
    ]);
    const toolExecutor = jest.fn(async () =>
      JSON.stringify({ success: true, output: 'gateway result' })
    );
    const confirmToolUse = jest.fn(async () => false);

    for await (const _event of query({
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'search' },
      ],
      tools: [askTool],
      toolExecutor,
      llm,
      toolContext,
      confirmToolUse,
      executionBoundary: 'tool_gateway',
    })) {
      // drain
    }

    expect(confirmToolUse).not.toHaveBeenCalled();
    expect(toolExecutor).toHaveBeenCalledWith('web_search', { query: 'orion' }, undefined, {
      callId: 'gateway-call',
      index: 0,
    });
  });

  test('accounts for tool-calling model turns as well as the final response', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        usage: { promptTokens: 100, completionTokens: 20, requestId: 'tool-turn' },
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
          },
        ],
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
    let complete: Extract<QueryEvent, { type: 'complete' }> | undefined;

    for await (const event of query({
      messages,
      tools: [mockTool],
      toolExecutor: async () => 'file content',
      llm,
      costTracker,
    })) {
      if (event.type === 'complete') complete = event;
    }

    const stats = costTracker.getStats();
    expect(stats.recordCount).toBe(2);
    expect(stats.totalTokens).toBe(350);
    expect(complete?.usage).toEqual({ promptTokens: 300, completionTokens: 50 });
  });

  test('preserves known usage when a later model request fails', async () => {
    const llm = makeMockLLM([]);
    (llm.chatStream as jest.Mock)
      .mockResolvedValueOnce({
        content: '',
        model: 'test-model',
        usage: { promptTokens: 100, completionTokens: 20 },
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
          },
        ],
      })
      .mockRejectedValueOnce(new Error('provider failed'));
    let caught: unknown;

    try {
      for await (const _event of query({
        messages: [
          { role: 'system', content: 'You are a bot.' },
          { role: 'user', content: 'Read a.ts' },
        ],
        tools: [mockTool],
        toolExecutor: async () => 'file content',
        llm,
      })) {
        // Consume the loop until the second provider request fails.
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(QueryLoopError);
    expect((caught as QueryLoopError).aggregateUsage).toEqual({
      promptTokens: 100,
      completionTokens: 20,
    });
    expect((caught as QueryLoopError).stats).toMatchObject({
      finishReason: 'failed',
      llmRequests: 2,
      toolCalls: 1,
    });
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

  test('pauses before provider when mandatory Harness sections exceed their atomic budget', async () => {
    const llm = makeMockLLM([{ content: 'must not be called', model: 'test-model' }]);
    const harness = createContextHarness({
      cwd: '/repo',
      modelId: 'gpt-4o',
      config: { evidenceBudgetRatio: 0.01 },
      state: {
        ledger: [],
        rootObjective: `objective ${'keep all semantics '.repeat(300)}`,
        activeInstruction: `instruction ${'keep all semantics '.repeat(300)}`,
        activeConstraints: Array.from(
          { length: 8 },
          (_, index) => `constraint-${index} ${'must remain atomic '.repeat(80)}`
        ),
        nonGoals: Array.from(
          { length: 8 },
          (_, index) => `non-goal-${index} ${'must remain atomic '.repeat(80)}`
        ),
        updatedAt: 1,
      },
    });
    const events: QueryEvent[] = [];

    for await (const event of query({
      messages: [{ role: 'user', content: 'continue' }],
      tools: [],
      toolExecutor: async () => '',
      llm,
      harness,
    })) {
      events.push(event);
    }

    expect(llm.chatStream).not.toHaveBeenCalled();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'prompt_assembly', overBudget: true }),
        expect.objectContaining({
          type: 'complete',
          stats: expect.objectContaining({
            finishReason: 'compact_paused',
            stopDecision: expect.objectContaining({
              disposition: 'pause_scope',
              reason: expect.objectContaining({ code: 'mandatory_context_over_budget' }),
            }),
          }),
        }),
      ])
    );
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

  test('preserves a typed external assertion on the tool_result event', async () => {
    const execTool: OrionCodeTool = buildTool({
      name: 'exec_command',
      description: 'Execute a command',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'Command' } },
        required: ['command'],
      },
      execute: async () => ({ success: true, output: '0.1.2' }),
      isReadOnly: () => true,
    });
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          {
            id: 'call-external',
            type: 'function',
            function: {
              name: 'exec_command',
              arguments: '{"command":"npm view @orion-agents/orion-code version"}',
            },
          },
        ],
      },
      { content: 'Done', model: 'test-model' },
    ]);
    const observedAt = Date.now();
    const assertion = {
      version: 1,
      action: 'registry',
      status: 'passed',
      provider: 'npm',
      target: '@orion-agents/orion-code',
      observedValue: '0.1.2',
      observedAt,
      details: {
        kind: 'npm',
        packageName: '@orion-agents/orion-code',
        version: '0.1.2',
        field: 'version',
      },
    } as const;
    const events: QueryEvent[] = [];

    for await (const event of query({
      messages: [
        { role: 'system', content: 'You are a bot.' },
        { role: 'user', content: 'Verify registry' },
      ],
      tools: [execTool],
      toolExecutor: async () =>
        JSON.stringify({ success: true, output: '0.1.2', externalAssertion: assertion }),
      llm,
    })) {
      events.push(event);
    }

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        callId: 'call-external',
        externalAssertion: assertion,
      })
    );
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

  test('propagates production resilience retries into loop stats', async () => {
    const llm = new LLMService({ apiKey: 'test-key', model: 'primary-model' });
    llm.resilience = new ProviderResilienceCoordinator({
      maxTotalAttempts: 2,
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
    const create = jest
      .fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockImplementationOnce(async function* () {
        yield {
          choices: [{ delta: { content: 'Recovered' } }],
          model: 'primary-model',
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        };
      });
    (llm as any).client = { chat: { completions: { create } } };

    const events: QueryEvent[] = [];
    for await (const event of query({
      messages: [{ role: 'user', content: 'Recover from provider failure' }],
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
    expect(create).toHaveBeenCalledTimes(2);
    expect(complete.stats).toMatchObject({
      finishReason: 'completed',
      providerRetryCount: 1,
      providerRetryErrorTypes: ['invalid_endpoint'],
      providerLastRetryErrorType: 'invalid_endpoint',
      providerFinalModel: 'primary-model',
      providerFallbackCount: 0,
    });
  });

  test('propagates an unswitched resilience fallback count fail-closed', async () => {
    const llm = new LLMService({ apiKey: 'test-key', model: 'primary-model' });
    llm.resilience = {
      execute: jest.fn().mockResolvedValue({
        result: { content: 'Recovered', model: 'primary-model' },
        diagnostics: {
          logicalRequestId: 'fallback-diagnostic',
          operation: 'root_chat_stream',
          requestedModel: 'primary-model',
          finalModel: 'primary-model',
          finalState: 'succeeded',
          attempts: [],
          retryCount: 0,
          recoveryCount: 0,
          fallbackCount: 1,
          totalBackoffMs: 0,
          sdkRetriesDisabled: true,
          usageConfidence: 'unknown',
          unknownBilledAttemptCount: 1,
        },
      }),
    } as any;

    const events: QueryEvent[] = [];
    for await (const event of query({
      messages: [{ role: 'user', content: 'Use fallback' }],
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
      providerRetryCount: 0,
      providerFallbackCount: 1,
      providerFallbackFromModel: 'primary-model',
      providerFinalModel: 'primary-model',
      providerUsingFallback: false,
    });
    expect(complete.stats?.providerFallbackToModel).toBeUndefined();
  });

  test('stops before another model request when LLM request budget is reached', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        usage: { promptTokens: 40, completionTokens: 5 },
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
      // Deprecated callers remain safe: maxTurns is treated as a request resource cap,
      // never as evidence that the parent task completed.
      maxTurns: 1,
    })) {
      events.push(event);
    }

    const complete = events[events.length - 1] as Extract<QueryEvent, { type: 'complete' }>;
    expect(llm.chatStream).toHaveBeenCalledTimes(1);
    expect(complete).toMatchObject({
      type: 'complete',
      stats: {
        finishReason: 'budget_exceeded',
        stopDecision: {
          scope: 'request',
          status: 'stopped',
          disposition: 'resume_allowed',
          reason: { code: 'llm_request_budget' },
          resources: {
            llmRequests: { used: 1, limit: 1 },
          },
        },
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
        lastToolName: 'read_file',
        lastToolSuccess: true,
      },
    });
    expect(complete.stats?.continuationHint).toContain('Reply `继续`');
    expect(complete.usage).toEqual({ promptTokens: 40, completionTokens: 5 });
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

  test('stops repeated model-only completion-gate loops after one corrective retry', async () => {
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
    expect(llm.chatStream).toHaveBeenCalledTimes(2);
    expect(complete).toMatchObject({
      type: 'complete',
      stats: {
        finishReason: 'completion_gate',
        llmRequests: 2,
        toolCalls: 0,
        loopBudgetSource: 'default',
        loopBudgetBaseProfile: 'default',
        loopBudgetMaxLlmRequests: 24,
      },
    });
    expect(complete.content).toContain('Completion gate stopped this turn');
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
      singleReadOnlyStreak: 0,
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

  test('uses a resumable resource decision instead of a fixed turn completion', async () => {
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
      loopBudget: { maxLlmRequestsPerUserTurn: 1 },
    })) {
      events.push(event);
    }

    const complete = events.find(e => e.type === 'complete');
    expect(complete).toBeDefined();

    expect((complete as any).content).toContain('Agent loop budget reached');
    expect(events.filter(e => e.type === 'request_start')).toHaveLength(1);
    expect((complete as Extract<QueryEvent, { type: 'complete' }>).stats).toMatchObject({
      finishReason: 'budget_exceeded',
      turnsStarted: 1,
      llmRequests: 1,
      stopDecision: {
        scope: 'request',
        status: 'stopped',
        disposition: 'resume_allowed',
      },
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
      summary: { text: expect.stringContaining('compact summary'), source: 'llm' },
      before: { percent: 100 },
      fingerprint: expect.any(String),
      beforeTokens: expect.any(Number),
      afterTokens: expect.any(Number),
      diagnostics: expect.any(Array),
    });
    expect(Array.isArray(complete?.compact?.plan.evictedGroups)).toBe(true);
    expect(complete?.compact?.semanticSummary.version).toBe(1);
    expect(complete?.compact?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(complete?.compact?.fingerprint).not.toBe(
      canonicalMessagesFingerprint(complete?.compact?.modelHistory ?? [])
    );
    expect(complete?.compact?.afterTokens).toBe(
      estimateMessagesTokens(complete?.compact?.modelHistory ?? [])
    );
    expect(complete?.compact?.modelHistory.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Answer',
    });
    expect(complete?.compact?.uncompactedHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('large historical message 0'),
        }),
        expect.objectContaining({ role: 'assistant', content: 'Answer' }),
      ])
    );
    expect(complete?.compact?.uncompactedHistory.length).toBeGreaterThan(
      complete?.compact?.modelHistory.length ?? Number.POSITIVE_INFINITY
    );
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

  test('does not reinterpret an authoritative external-tool denial', async () => {
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
    const toolExecutor = jest.fn(async () => ({
      result: JSON.stringify({ success: false, error: 'Explicit approval is required.' }),
      permissionDecision: {
        behavior: 'ask' as const,
        approved: false,
        source: 'config_allow_blocked' as const,
        reason: 'Explicit approval is required.',
      },
    }));
    const events: QueryEvent[] = [];

    for await (const event of query({
      messages,
      tools: [askTool],
      toolExecutor,
      llm,
    })) {
      events.push(event);
    }

    expect(toolExecutor).toHaveBeenCalledWith('web_search', { query: 'openhorse' }, undefined, {
      callId: 'call-1',
      index: 0,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        name: 'web_search',
        success: false,
      })
    );
  });

  test('stops after the authoritative boundary denies a tool', async () => {
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
    const toolExecutor = jest.fn(async () => ({
      result: JSON.stringify({ success: false, error: 'Denied by frozen project authority.' }),
      permissionDecision: {
        behavior: 'deny' as const,
        approved: false,
        source: 'config_deny' as const,
        reason: 'Denied by frozen project authority.',
      },
    }));
    const events: QueryEvent[] = [];

    for await (const event of query({
      messages,
      tools: [askTool],
      toolExecutor,
      llm,
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
    expect(toolExecutor).toHaveBeenCalledTimes(1);
    expect(toolResult.success).toBe(false);
    expect(toolResult.error).toContain('Denied by frozen project authority');
    expect(llm.chatStream).toHaveBeenCalledTimes(1);
    expect(complete.content).toContain('permission was denied');
    expect(complete.stats).toMatchObject({
      finishReason: 'blocked',
      llmRequests: 1,
      toolCalls: 1,
    });
  });

  test('stops the query loop when the Context Harness drift guard blocks a tool', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          {
            id: 'call-drift',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"/drifted"}' },
          },
        ],
      },
    ]);
    const toolExecutor = jest.fn(async () => JSON.stringify({ success: true, output: 'unsafe' }));
    const harness = {
      assembleMessages: jest.fn((messages: Message[]) => messages),
      getCapsule: jest.fn(() => ({ summary: '' })),
      toJSON: jest.fn(() => ({})),
      recordAssistantResponse: jest.fn(),
      beforeToolUse: jest.fn(() => ({ status: 'block', reason: 'context drift' })),
      asToolBlockedResult: jest.fn(() =>
        JSON.stringify({ success: false, error: 'blocked by Context Harness' })
      ),
      beforeComplete: jest.fn(() => ({ canComplete: true })),
      asCompletionBlockedMessage: jest.fn(),
      recordToolResult: jest.fn(),
    };
    const events: QueryEvent[] = [];

    for await (const event of query({
      messages: [
        { role: 'system', content: 'You are a bot.' },
        { role: 'user', content: 'Read drifted context' },
      ],
      tools: [mockTool],
      toolExecutor,
      llm,
      harness: harness as any,
    })) {
      events.push(event);
    }

    expect(toolExecutor).not.toHaveBeenCalled();
    expect(harness.beforeToolUse).toHaveBeenCalledWith({
      name: 'read_file',
      args: { path: '/drifted' },
    });
    expect(events.find(event => event.type === 'permission_decision')).toMatchObject({
      decision: { approved: false, source: 'drift_guard' },
    });
    expect(events.find(event => event.type === 'tool_result')).toMatchObject({
      success: false,
      result: expect.stringContaining('blocked by Context Harness'),
    });
    expect(events.find(event => event.type === 'complete')).toMatchObject({
      stats: { finishReason: 'blocked', toolCalls: 1 },
    });
    expect(llm.chatStream).toHaveBeenCalledTimes(1);
  });

  test('an authoritative denial seals every remaining result in a serial tool-call batch', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"one"}' },
          },
          {
            id: 'call-2',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"two"}' },
          },
          {
            id: 'call-3',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"three"}' },
          },
        ],
      },
    ]);
    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Search' },
    ];
    const toolExecutor = jest.fn(async () => ({
      result: JSON.stringify({ success: false, error: 'Denied by frozen project authority.' }),
      permissionDecision: {
        behavior: 'deny' as const,
        approved: false,
        source: 'config_deny' as const,
      },
    }));
    const events: QueryEvent[] = [];

    for await (const event of query({
      messages,
      tools: [askTool],
      toolExecutor,
      llm,
    })) {
      events.push(event);
    }

    expect(toolExecutor).toHaveBeenCalledTimes(1);
    expect(events.filter(event => event.type === 'tool_result').map(event => event.callId)).toEqual(
      ['call-1', 'call-2', 'call-3']
    );
    const assistantIndex = messages.findIndex(message => message.tool_calls?.length === 3);
    expect(
      messages.slice(assistantIndex, assistantIndex + 4).map(message => ({
        role: message.role,
        toolCallId: message.tool_call_id,
      }))
    ).toEqual([
      { role: 'assistant', toolCallId: undefined },
      { role: 'tool', toolCallId: 'call-1' },
      { role: 'tool', toolCallId: 'call-2' },
      { role: 'tool', toolCallId: 'call-3' },
    ]);
    expect(events.find(event => event.type === 'complete')).toMatchObject({
      type: 'complete',
      stats: { finishReason: 'blocked', toolCalls: 3 },
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

  test('emits an approval receipt returned by the authoritative boundary', async () => {
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
    const toolExecutor = jest.fn(async () => ({
      result: JSON.stringify({ success: true, output: 'ok' }),
      permissionDecision: {
        behavior: 'ask' as const,
        approved: true,
        source: 'user' as const,
        reason: 'External query',
      },
    }));
    const events: QueryEvent[] = [];

    for await (const event of query({
      messages,
      tools: [askTool],
      toolExecutor,
      llm,
    })) {
      events.push(event);
    }

    expect(toolExecutor).toHaveBeenCalledWith('web_search', { query: 'openhorse' }, undefined, {
      callId: 'call-1',
      index: 0,
    });
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

  test('observes a user denial made inside the authoritative boundary', async () => {
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
    const toolExecutor = jest.fn(async () => ({
      result: JSON.stringify({ success: false, error: 'Tool approval was denied by user.' }),
      permissionDecision: {
        behavior: 'ask' as const,
        approved: false,
        source: 'user' as const,
        reason: 'External query',
      },
    }));
    const events: QueryEvent[] = [];

    for await (const event of query({
      messages,
      tools: [askTool],
      toolExecutor,
      llm,
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
    expect(toolExecutor).toHaveBeenCalledTimes(1);
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
