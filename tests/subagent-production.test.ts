import {
  createProductionExecuteQuery,
  createChildLlmConfig,
} from '../src/runtime/subagents/production';
import { SubagentProviderGate } from '../src/runtime/subagents/provider-gate';
import type { LLMService, LLMConfig, ProviderRequestPreflight } from '../src/services/llm';
import type { QueryEvent, QueryParams } from '../src/framework/query';
import type { ChildToolSet } from '../src/runtime/subagents/runner';
import { SubtaskExecutionError } from '../src/runtime/subagents/types';

const TOOL_SET: ChildToolSet = { tools: [], toolExecutor: async () => '' };

function makeMockLlm(): LLMService {
  return { getModel: () => 'test-model' } as unknown as LLMService;
}

describe('subagent production executeQuery binding', () => {
  it('createChildLlmConfig derives an isolated config from the root config', () => {
    const cfg = createChildLlmConfig({
      apiKey: 'key',
      baseUrl: 'http://x',
      model: 'gpt-4o',
      fallbackModel: 'gpt-4o-mini',
    });
    expect(cfg.apiKey).toBe('key');
    expect(cfg.model).toBe('gpt-4o');
    expect(cfg.fallbackModel).toBe('gpt-4o-mini');
  });

  it('creates a fresh LLMService per call (no shared mutable state)', async () => {
    let created = 0;
    const executeQuery = createProductionExecuteQuery({
      rootConfig: { apiKey: 'k', model: 'm' },
      createLlm: () => {
        created++;
        return makeMockLlm();
      },
      runQuery: async function* (): AsyncIterable<QueryEvent> {
        yield {
          type: 'complete',
          content: JSON.stringify({ summary: 'ok' }),
          usage: { promptTokens: 10, completionTokens: 5 },
          model: 'm',
          stats: { llmRequests: 1, toolCalls: 0 } as never,
        };
      },
      providerGate: new SubagentProviderGate({ maxConcurrent: 3 }),
      maxTurnsPerTask: 6,
    });
    const messages = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'do it' },
    ];
    await executeQuery(messages, TOOL_SET, new AbortController().signal);
    await executeQuery(messages, TOOL_SET, new AbortController().signal);
    expect(created).toBe(2);
  });

  it('returns the final assistant content and usage from a complete event', async () => {
    const executeQuery = createProductionExecuteQuery({
      rootConfig: { apiKey: 'k', model: 'm' },
      createLlm: () => makeMockLlm(),
      runQuery: async function* (): AsyncIterable<QueryEvent> {
        yield { type: 'assistant_tool_calls', content: 'partial', toolCalls: [] as never };
        yield {
          type: 'complete',
          content: JSON.stringify({ summary: 'done' }),
          usage: { promptTokens: 20, completionTokens: 8 },
          model: 'm',
          stats: { llmRequests: 2, toolCalls: 3 } as never,
        };
      },
      providerGate: new SubagentProviderGate({ maxConcurrent: 3 }),
      maxTurnsPerTask: 6,
    });
    const { content, usage } = await executeQuery(
      [{ role: 'user', content: 'go' }],
      TOOL_SET,
      new AbortController().signal
    );
    expect(content).toBe(JSON.stringify({ summary: 'done' }));
    expect(usage.modelRequests).toBeGreaterThanOrEqual(2);
    expect(usage.toolCalls).toBe(3);
    expect(usage.promptTokens).toBe(20);
    expect(usage.usageComplete).toBe(true);
  });

  it.each([
    ['provider retry', { providerRetryCount: 1 }],
    ['provider fallback', { providerFallbackCount: 1 }],
  ])('marks successful child usage incomplete after a %s', async (_label, diagnostics) => {
    const executeQuery = createProductionExecuteQuery({
      rootConfig: { apiKey: 'k', model: 'm' },
      createLlm: () => makeMockLlm(),
      runQuery: async function* (): AsyncIterable<QueryEvent> {
        yield {
          type: 'complete',
          content: '{}',
          usage: { promptTokens: 10, completionTokens: 5 },
          model: 'm',
          stats: { llmRequests: 1, toolCalls: 0, ...diagnostics } as never,
        };
      },
      providerGate: new SubagentProviderGate({ maxConcurrent: 3 }),
      maxTurnsPerTask: 6,
    });

    const { usage } = await executeQuery(
      [{ role: 'user', content: 'go' }],
      TOOL_SET,
      new AbortController().signal
    );
    expect(usage).toMatchObject({ promptTokens: 10, completionTokens: 5, usageComplete: false });
  });

  it('marks usage incomplete when a completed child request has no usage metadata', async () => {
    const executeQuery = createProductionExecuteQuery({
      rootConfig: { apiKey: 'k', model: 'm' },
      createLlm: () => makeMockLlm(),
      runQuery: async function* (): AsyncIterable<QueryEvent> {
        yield {
          type: 'complete',
          content: '{}',
          model: 'm',
          stats: { llmRequests: 1, toolCalls: 0 } as never,
        };
      },
      providerGate: new SubagentProviderGate({ maxConcurrent: 3 }),
      maxTurnsPerTask: 6,
    });

    const { usage } = await executeQuery(
      [{ role: 'user', content: 'go' }],
      TOOL_SET,
      new AbortController().signal
    );
    expect(usage).toMatchObject({ promptTokens: 0, completionTokens: 0, usageComplete: false });
  });

  it('enters provider cooldown when query throws a 429', async () => {
    let clock = 0;
    const gate = new SubagentProviderGate({ maxConcurrent: 3, now: () => clock });
    const executeQuery = createProductionExecuteQuery({
      rootConfig: { apiKey: 'k', model: 'm' },
      createLlm: () => makeMockLlm(),
      runQuery: async function* (): AsyncIterable<QueryEvent> {
        throw Object.assign(new Error('Too Many Requests'), {
          status: 429,
          headers: { 'retry-after': '2' },
        });
      },
      providerGate: gate,
      maxTurnsPerTask: 6,
    });
    await expect(
      executeQuery([{ role: 'user', content: 'go' }], TOOL_SET, new AbortController().signal)
    ).rejects.toThrow(/Too Many Requests/);
    expect(gate.isInCooldown()).toBe(true);
    expect(gate.cooldownRemainingMs()).toBe(2000);
  });

  it('propagates non-rate-limit errors without entering cooldown', async () => {
    const gate = new SubagentProviderGate({ maxConcurrent: 3 });
    const executeQuery = createProductionExecuteQuery({
      rootConfig: { apiKey: 'k', model: 'm' },
      createLlm: () => makeMockLlm(),
      runQuery: async function* (): AsyncIterable<QueryEvent> {
        throw new Error('provider 500');
      },
      providerGate: gate,
      maxTurnsPerTask: 6,
    });
    await expect(
      executeQuery([{ role: 'user', content: 'go' }], TOOL_SET, new AbortController().signal)
    ).rejects.toThrow(/provider 500/);
    expect(gate.isInCooldown()).toBe(false);
  });

  it('carries observed lower-bound usage when a child query fails', async () => {
    let usageListener:
      | ((event: {
          usage: { promptTokens: number; completionTokens: number; costUsd?: number };
        }) => void)
      | undefined;
    const executeQuery = createProductionExecuteQuery({
      rootConfig: { apiKey: 'k', model: 'm' },
      createLlm: () =>
        ({
          getModel: () => 'test-model',
          subscribeUsage: (listener: typeof usageListener) => {
            usageListener = listener;
            return () => undefined;
          },
        }) as unknown as LLMService,
      runQuery: async function* (): AsyncIterable<QueryEvent> {
        usageListener?.({ usage: { promptTokens: 9, completionTokens: 4 } });
        throw new Error('provider failed after usage');
      },
      providerGate: new SubagentProviderGate({ maxConcurrent: 3 }),
      maxTurnsPerTask: 6,
    });

    const rejection = await executeQuery(
      [{ role: 'user', content: 'go' }],
      TOOL_SET,
      new AbortController().signal
    ).catch(error => error as SubtaskExecutionError);

    expect(rejection).toBeInstanceOf(SubtaskExecutionError);
    expect(rejection.usage).toMatchObject({
      modelRequests: 1,
      promptTokens: 9,
      completionTokens: 4,
      usageComplete: false,
    });
  });

  it('passes the child abort signal through to query', async () => {
    let receivedSignal: AbortSignal | undefined;
    const executeQuery = createProductionExecuteQuery({
      rootConfig: { apiKey: 'k', model: 'm' },
      createLlm: () => makeMockLlm(),
      runQuery: async function* (params: QueryParams): AsyncIterable<QueryEvent> {
        receivedSignal = params.abortSignal;
        yield {
          type: 'complete',
          content: '{}',
          usage: { promptTokens: 0, completionTokens: 0 },
          model: 'm',
          stats: { llmRequests: 1, toolCalls: 0 } as never,
        };
      },
      providerGate: new SubagentProviderGate({ maxConcurrent: 3 }),
      maxTurnsPerTask: 6,
    });
    const ac = new AbortController();
    await executeQuery([{ role: 'user', content: 'go' }], TOOL_SET, ac.signal);
    expect(receivedSignal).toBe(ac.signal);
  });

  it('uses the supervisor reservation as the child query resource budget', async () => {
    let receivedParams: QueryParams | undefined;
    const executeQuery = createProductionExecuteQuery({
      rootConfig: { apiKey: 'k', model: 'm' },
      createLlm: () => makeMockLlm(),
      runQuery: async function* (params: QueryParams): AsyncIterable<QueryEvent> {
        receivedParams = params;
        yield {
          type: 'complete',
          content: '{}',
          usage: { promptTokens: 0, completionTokens: 0 },
          model: 'm',
          stats: { llmRequests: 1, toolCalls: 0 } as never,
        };
      },
      providerGate: new SubagentProviderGate({ maxConcurrent: 3 }),
      maxTurnsPerTask: 4,
    });
    await executeQuery([{ role: 'user', content: 'go' }], TOOL_SET, new AbortController().signal, {
      maxModelRequests: 3,
      maxToolCalls: 9,
    });
    expect(receivedParams?.maxTurns).toBeUndefined();
    expect(receivedParams?.loopBudget).toMatchObject({
      maxLlmRequestsPerUserTurn: 3,
      maxToolCallsPerUserTurn: 9,
    });
  });

  it('enforces and accounts the reservation at the provider-attempt boundary', async () => {
    let activePreflight: ProviderRequestPreflight | undefined;
    const decisions: boolean[] = [];
    const sharedPreflight = jest.fn(async () => ({ available: true }));
    const executeQuery = createProductionExecuteQuery({
      rootConfig: { apiKey: 'k', model: 'm' },
      createLlm: () =>
        ({
          getModel: () => 'test-model',
          setProviderRequestPreflight: (preflight?: ProviderRequestPreflight) => {
            activePreflight = preflight;
            return () => {
              activePreflight = undefined;
            };
          },
        }) as unknown as LLMService,
      runQuery: async function* (): AsyncIterable<QueryEvent> {
        for (let attempt = 1; attempt <= 3; attempt++) {
          const decision = await activePreflight!({
            operation: 'chat_stream',
            attempt,
            model: 'test-model',
            estimatedPromptTokens: 10,
          });
          decisions.push(decision.available);
        }
        yield {
          type: 'complete',
          content: '{}',
          usage: { promptTokens: 10, completionTokens: 5 },
          model: 'm',
          stats: { llmRequests: 1, toolCalls: 0 } as never,
        };
      },
      providerGate: new SubagentProviderGate({ maxConcurrent: 3 }),
      beforeProviderRequest: sharedPreflight,
    });

    const { usage } = await executeQuery(
      [{ role: 'user', content: 'go' }],
      TOOL_SET,
      new AbortController().signal,
      { maxModelRequests: 2, maxToolCalls: 5 }
    );

    expect(decisions).toEqual([true, true, false]);
    expect(sharedPreflight).toHaveBeenCalledTimes(2);
    expect(usage.modelRequests).toBe(2);
  });
});
