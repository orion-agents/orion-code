import { LLMService, type LLMUsageEvent } from '../src/services/llm';
import type { ReasoningCapability } from '../src/services/effort';

const capability: ReasoningCapability = {
  kind: 'effort-level',
  supportedLevels: ['none', 'low', 'medium', 'high'],
  adapter: 'openai-chat-reasoning-effort',
  source: 'config',
};

function service(preference: 'auto' | 'high'): {
  llm: LLMService;
  create: jest.Mock;
} {
  const llm = new LLMService({
    apiKey: 'test-key',
    model: 'gpt-5',
    providerProtocol: 'openai-completions',
    reasoningCapability: capability,
    effortPreference: preference,
  });
  const create = jest.fn(async () => ({
    id: 'req-effort',
    model: 'gpt-5',
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 7,
      completion_tokens_details: { reasoning_tokens: 4 },
    },
  }));
  (
    llm as unknown as { client: { chat: { completions: { create: jest.Mock } } } }
  ).client.chat.completions.create = create;
  return { llm, create };
}

describe('effort provider request adapter', () => {
  it('injects explicit reasoning_effort into non-streaming Chat Completions', async () => {
    const { llm, create } = service('high');
    const usageEvents: LLMUsageEvent[] = [];
    llm.subscribeUsage(event => usageEvents.push(event));

    const response = await llm.chat([{ role: 'user', content: 'test' }]);
    expect(create.mock.calls[0][0]).toMatchObject({ reasoning_effort: 'high' });
    expect(response.usage).toMatchObject({
      reasoningTokens: 4,
      effortRequested: 'high',
      effortEffective: 'high',
      providerProtocol: 'openai-completions',
    });
    expect(usageEvents).toHaveLength(1);
  });

  it('omits reasoning_effort for auto and for profiles without explicit capability', async () => {
    const automatic = service('auto');
    await automatic.llm.chat([{ role: 'user', content: 'test' }]);
    expect(automatic.create.mock.calls[0][0]).not.toHaveProperty('reasoning_effort');

    const unsupported = new LLMService({ apiKey: 'test', model: 'ark-code-latest' });
    expect(() =>
      unsupported.setEffortContext({
        preference: 'high',
        protocol: 'openai-completions',
      })
    ).toThrow('capability');
  });

  it('uses the same immutable effort snapshot across retries', async () => {
    const { llm } = service('high');
    const calls: Array<Record<string, unknown>> = [];
    let attempt = 0;
    const create = jest.fn(async (params: Record<string, unknown>) => {
      calls.push(params);
      attempt += 1;
      if (attempt === 1) {
        llm.setEffortContext({
          preference: 'low',
          protocol: 'openai-completions',
          capability,
        });
        throw Object.assign(new Error('temporary server error'), { status: 500 });
      }
      return {
        id: 'retry-ok',
        model: 'gpt-5',
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      };
    });
    (
      llm as unknown as { client: { chat: { completions: { create: jest.Mock } } } }
    ).client.chat.completions.create = create;
    const { ProviderResilienceCoordinator } = require('../src/services/provider-resilience');
    llm.resilience = new ProviderResilienceCoordinator({
      maxTotalAttempts: 2,
      baseDelayMs: 0,
      minRateLimitDelayMs: 0,
      maxDelayMs: 0,
    });

    await llm.chat([{ role: 'user', content: 'retry' }]);
    expect(calls).toHaveLength(2);
    expect(calls.map(call => call.reasoning_effort)).toEqual(['high', 'high']);
    expect(llm.getResolvedEffort()).toMatchObject({ requested: 'low', effective: 'low' });
  });

  it('fails fast when an explicit effort override is rejected', async () => {
    const { llm } = service('high');
    const create = jest.fn().mockRejectedValue(
      Object.assign(new Error('reasoning_effort high is unsupported'), {
        status: 400,
      })
    );
    (
      llm as unknown as { client: { chat: { completions: { create: jest.Mock } } } }
    ).client.chat.completions.create = create;

    await expect(llm.chat([{ role: 'user', content: 'test' }])).rejects.toMatchObject({
      diagnostic: { type: 'unsupported_effort', retryable: false },
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ reasoning_effort: 'high' });
  });

  it('injects effort and projects reasoning usage on the streaming path', async () => {
    const { llm } = service('high');
    const create = jest.fn((params: Record<string, unknown>) => {
      async function* stream() {
        yield { id: 'stream-effort', model: 'gpt-5', choices: [{ delta: { content: 'ok' } }] };
        yield {
          id: 'stream-effort',
          model: 'gpt-5',
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 5,
            completion_tokens_details: { reasoning_tokens: 2 },
          },
        };
      }
      return stream();
    });
    (
      llm as unknown as { client: { chat: { completions: { create: jest.Mock } } } }
    ).client.chat.completions.create = create;

    const response = await llm.chatStream([{ role: 'user', content: 'stream' }]);
    expect(create.mock.calls[0][0]).toMatchObject({ stream: true, reasoning_effort: 'high' });
    expect(response).toMatchObject({
      content: 'ok',
      usage: {
        reasoningTokens: 2,
        effortRequested: 'high',
        effortEffective: 'high',
      },
    });
  });
});
