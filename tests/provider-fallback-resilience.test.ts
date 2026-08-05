import { LLMService } from '../src/services/llm';
import { ProviderResilienceCoordinator } from '../src/services/provider-resilience';

describe('provider fallback resilience', () => {
  it('switches the actual request model once and records exact fallback usage', async () => {
    const llm = new LLMService({
      apiKey: 'test-key',
      model: 'primary-model',
      fallbackModel: 'fallback-model',
    });
    llm.resilience = new ProviderResilienceCoordinator({
      maxTotalAttempts: 3,
      baseDelayMs: 0,
      maxDelayMs: 0,
    });

    const create = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('rate limit'), { status: 429 }))
      .mockResolvedValueOnce({
        id: 'fallback-request',
        model: 'fallback-model',
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      });
    (llm as any).client = { chat: { completions: { create } } };

    const response = await llm.chat([{ role: 'user', content: 'hello' }]);

    expect(response).toMatchObject({ content: 'ok', model: 'fallback-model' });
    expect(create.mock.calls.map(call => call[0].model)).toEqual([
      'primary-model',
      'fallback-model',
    ]);
    expect(llm.getLastRequestDiagnostics()).toMatchObject({
      fallbackTriggered: true,
      fallbackFromModel: 'primary-model',
      fallbackToModel: 'fallback-model',
      finalModel: 'fallback-model',
      usingFallback: true,
    });
  });
});
