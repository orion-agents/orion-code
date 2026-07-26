import { createProductionExecuteQuery, createChildLlmConfig } from '../src/runtime/subagents/production';
import { SubagentProviderGate } from '../src/runtime/subagents/provider-gate';
import type { LLMService, LLMConfig } from '../src/services/llm';
import type { QueryEvent, QueryParams } from '../src/framework/query';
import type { ChildToolSet } from '../src/runtime/subagents/runner';

const TOOL_SET: ChildToolSet = { tools: [], toolExecutor: async () => '' };

function makeMockLlm(): LLMService {
  return { getModel: () => 'test-model' } as unknown as LLMService;
}

describe('subagent production executeQuery binding', () => {
  it('createChildLlmConfig derives an isolated config from the root config', () => {
    const cfg = createChildLlmConfig({ apiKey: 'key', baseUrl: 'http://x', model: 'gpt-4o', fallbackModel: 'gpt-4o-mini' });
    expect(cfg.apiKey).toBe('key');
    expect(cfg.model).toBe('gpt-4o');
    expect(cfg.fallbackModel).toBe('gpt-4o-mini');
  });

  it('creates a fresh LLMService per call (no shared mutable state)', async () => {
    let created = 0;
    const executeQuery = createProductionExecuteQuery({
      rootConfig: { apiKey: 'k', model: 'm' },
      createLlm: () => { created++; return makeMockLlm(); },
      runQuery: async function* (): AsyncIterable<QueryEvent> {
        yield { type: 'complete', content: JSON.stringify({ summary: 'ok' }), usage: { promptTokens: 10, completionTokens: 5 }, model: 'm', stats: { llmRequests: 1, toolCalls: 0 } as never };
      },
      providerGate: new SubagentProviderGate({ maxConcurrent: 3 }),
      maxTurnsPerTask: 6,
    });
    const messages = [{ role: 'system' as const, content: 'sys' }, { role: 'user' as const, content: 'do it' }];
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
        yield { type: 'complete', content: JSON.stringify({ summary: 'done' }), usage: { promptTokens: 20, completionTokens: 8 }, model: 'm', stats: { llmRequests: 2, toolCalls: 3 } as never };
      },
      providerGate: new SubagentProviderGate({ maxConcurrent: 3 }),
      maxTurnsPerTask: 6,
    });
    const { content, usage } = await executeQuery(
      [{ role: 'user', content: 'go' }],
      TOOL_SET,
      new AbortController().signal,
    );
    expect(content).toBe(JSON.stringify({ summary: 'done' }));
    expect(usage.modelRequests).toBeGreaterThanOrEqual(2);
    expect(usage.toolCalls).toBe(3);
    expect(usage.promptTokens).toBe(20);
  });

  it('enters provider cooldown when query throws a 429', async () => {
    let clock = 0;
    const gate = new SubagentProviderGate({ maxConcurrent: 3, now: () => clock });
    const executeQuery = createProductionExecuteQuery({
      rootConfig: { apiKey: 'k', model: 'm' },
      createLlm: () => makeMockLlm(),
      runQuery: async function* (): AsyncIterable<QueryEvent> {
        throw Object.assign(new Error('Too Many Requests'), { status: 429, headers: { 'retry-after': '2' } });
      },
      providerGate: gate,
      maxTurnsPerTask: 6,
    });
    await expect(executeQuery(
      [{ role: 'user', content: 'go' }],
      TOOL_SET,
      new AbortController().signal,
    )).rejects.toThrow(/Too Many Requests/);
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
    await expect(executeQuery(
      [{ role: 'user', content: 'go' }],
      TOOL_SET,
      new AbortController().signal,
    )).rejects.toThrow(/provider 500/);
    expect(gate.isInCooldown()).toBe(false);
  });

  it('passes the child abort signal through to query', async () => {
    let receivedSignal: AbortSignal | undefined;
    const executeQuery = createProductionExecuteQuery({
      rootConfig: { apiKey: 'k', model: 'm' },
      createLlm: () => makeMockLlm(),
      runQuery: async function* (params: QueryParams): AsyncIterable<QueryEvent> {
        receivedSignal = params.abortSignal;
        yield { type: 'complete', content: '{}', usage: { promptTokens: 0, completionTokens: 0 }, model: 'm', stats: { llmRequests: 1, toolCalls: 0 } as never };
      },
      providerGate: new SubagentProviderGate({ maxConcurrent: 3 }),
      maxTurnsPerTask: 6,
    });
    const ac = new AbortController();
    await executeQuery([{ role: 'user', content: 'go' }], TOOL_SET, ac.signal);
    expect(receivedSignal).toBe(ac.signal);
  });

  it('honors maxTurnsPerTask in the query params', async () => {
    let receivedMaxTurns: number | undefined;
    const executeQuery = createProductionExecuteQuery({
      rootConfig: { apiKey: 'k', model: 'm' },
      createLlm: () => makeMockLlm(),
      runQuery: async function* (params: QueryParams): AsyncIterable<QueryEvent> {
        receivedMaxTurns = params.maxTurns;
        yield { type: 'complete', content: '{}', usage: { promptTokens: 0, completionTokens: 0 }, model: 'm', stats: { llmRequests: 1, toolCalls: 0 } as never };
      },
      providerGate: new SubagentProviderGate({ maxConcurrent: 3 }),
      maxTurnsPerTask: 4,
    });
    await executeQuery([{ role: 'user', content: 'go' }], TOOL_SET, new AbortController().signal);
    expect(receivedMaxTurns).toBe(4);
  });
});
