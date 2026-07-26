/**
 * Fallback Model E2E Test
 *
 * Verifies that the LLMService correctly switches to the fallback model
 * after consecutive 529 (overloaded) errors.
 */

import { LLMService, FallbackTriggeredError } from '../src/services/llm';
import OpenAI from 'openai';

describe('LLMService fallback model', () => {
  test('triggerFallback switches model', () => {
    const llm = new LLMService({
      apiKey: 'test',
      model: 'primary-model',
      fallbackModel: 'fallback-model',
    });

    expect(llm.getModel()).toBe('primary-model');
    expect(llm.isUsingFallback()).toBe(false);

    llm.triggerFallback();

    expect(llm.getModel()).toBe('fallback-model');
    expect(llm.isUsingFallback()).toBe(true);
  });

  test('triggerFallback is a no-op when no fallbackModel is configured', () => {
    const llm = new LLMService({
      apiKey: 'test',
      model: 'primary-model',
    });

    llm.triggerFallback();

    expect(llm.getModel()).toBe('primary-model');
    expect(llm.isUsingFallback()).toBe(false);
  });

  test('triggerFallback only switches once even if called multiple times', () => {
    const llm = new LLMService({
      apiKey: 'test',
      model: 'primary-model',
      fallbackModel: 'fallback-model',
    });

    llm.triggerFallback();
    llm.triggerFallback();
    llm.triggerFallback();

    expect(llm.getModel()).toBe('fallback-model');
  });

  test('resetToPrimary keeps the (already-swapped) model but clears the fallback flag', () => {
    const llm = new LLMService({
      apiKey: 'test',
      model: 'primary-model',
      fallbackModel: 'fallback-model',
    });

    llm.triggerFallback();
    expect(llm.isUsingFallback()).toBe(true);

    llm.resetToPrimary();
    expect(llm.isUsingFallback()).toBe(false);
  });

  test('chatStream triggers fallback after consecutive 529 errors', async () => {
    const llm = new LLMService({
      apiKey: 'test',
      model: 'primary-model',
      fallbackModel: 'fallback-model',
    });
    (llm as any).config.retryBaseDelay = 1;

    // Build a 529 APIError to throw
    const make529 = () => {
      const err = new OpenAI.APIError(
        529,
        { error: { message: 'overloaded' } },
        'overloaded',
        {} as any,
      );
      return err;
    };

    let callCount = 0;
    const createSpy = jest.fn(async () => {
      callCount++;
      // First 3 calls throw 529; subsequent calls succeed with a tiny stream
      if (callCount <= 3) throw make529();

      // Return an async iterable that yields one final chunk
      async function* stream() {
        yield {
          choices: [{ delta: { content: 'recovered' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
          model: 'fallback-model',
        };
      }
      return stream() as any;
    });

    // Inject the spy into the OpenAI client
    (llm as any).client.chat.completions.create = createSpy;

    const result = await llm.chatStream([{ role: 'user', content: 'hi' }]);

    // The fallback should have been triggered before success
    expect(llm.isUsingFallback()).toBe(true);
    expect(llm.getModel()).toBe('fallback-model');

    // The OpenAI client was called multiple times (3 failures + 1 success)
    expect(createSpy).toHaveBeenCalledTimes(4);

    // The model in the final call's params should be the fallback
    const lastCallArgs: any = (createSpy.mock.calls as any[])[3][0];
    expect(lastCallArgs.model).toBe('fallback-model');

    expect(result.content).toBe('recovered');
    expect(llm.getLastRequestDiagnostics()).toMatchObject({
      retryCount: 3,
      retryErrorTypes: ['provider_busy', 'provider_busy', 'provider_busy'],
      lastRetryErrorType: 'provider_busy',
      lastRetryStatus: 529,
      fallbackTriggered: true,
      fallbackFromModel: 'primary-model',
      fallbackToModel: 'fallback-model',
      finalModel: 'fallback-model',
      usingFallback: true,
    });
  });

  test('chatStream triggers fallback after consecutive 429 rate-limit errors', async () => {
    const llm = new LLMService({
      apiKey: 'test',
      model: 'primary-model',
      fallbackModel: 'fallback-model',
    });
    (llm as any).config.retryBaseDelay = 1;

    const make429 = () => new OpenAI.APIError(
      429,
      { error: { message: 'rate limit exceeded' } },
      'rate limit exceeded',
      {} as any,
    );

    let callCount = 0;
    const createSpy = jest.fn(async () => {
      callCount++;
      if (callCount <= 3) throw make429();

      async function* stream() {
        yield {
          choices: [{ delta: { content: 'recovered' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
          model: 'fallback-model',
        };
      }
      return stream() as any;
    });

    (llm as any).client.chat.completions.create = createSpy;

    const result = await llm.chatStream([{ role: 'user', content: 'hi' }]);

    expect(llm.isUsingFallback()).toBe(true);
    expect(llm.getModel()).toBe('fallback-model');
    expect(createSpy).toHaveBeenCalledTimes(4);
    expect((createSpy.mock.calls as any[])[3][0].model).toBe('fallback-model');
    expect(result.content).toBe('recovered');
    expect(llm.getLastRequestDiagnostics()).toMatchObject({
      retryCount: 3,
      retryErrorTypes: ['rate_limit', 'rate_limit', 'rate_limit'],
      lastRetryErrorType: 'rate_limit',
      lastRetryStatus: 429,
      fallbackTriggered: true,
      fallbackFromModel: 'primary-model',
      fallbackToModel: 'fallback-model',
      finalModel: 'fallback-model',
      usingFallback: true,
    });
  });

  test('chatStream resets consecutive rate-limit fallback counter after success', async () => {
    const llm = new LLMService({
      apiKey: 'test',
      model: 'primary-model',
      fallbackModel: 'fallback-model',
    });
    (llm as any).config.retryBaseDelay = 1;

    const make429 = () => new OpenAI.APIError(
      429,
      { error: { message: 'rate limit exceeded' } },
      'rate limit exceeded',
      {} as any,
    );

    let callCount = 0;
    const createSpy = jest.fn(async () => {
      callCount++;
      if (callCount === 1 || callCount === 2 || callCount === 4) {
        throw make429();
      }

      async function* stream() {
        yield {
          choices: [{ delta: { content: 'recovered' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
          model: 'primary-model',
        };
      }
      return stream() as any;
    });

    (llm as any).client.chat.completions.create = createSpy;

    await expect(llm.chatStream([{ role: 'user', content: 'first' }]))
      .resolves
      .toMatchObject({ content: 'recovered' });
    await expect(llm.chatStream([{ role: 'user', content: 'second' }]))
      .resolves
      .toMatchObject({ content: 'recovered' });

    expect(llm.isUsingFallback()).toBe(false);
    expect(llm.getModel()).toBe('primary-model');
    expect(createSpy).toHaveBeenCalledTimes(5);
    expect((createSpy.mock.calls as any[])[4][0].model).toBe('primary-model');
  });

  test('FallbackTriggeredError contains both model names', () => {
    const err = new FallbackTriggeredError('opus', 'haiku');
    expect(err.originalModel).toBe('opus');
    expect(err.fallbackModel).toBe('haiku');
    expect(err.message).toMatch(/opus/);
    expect(err.message).toMatch(/haiku/);
  });
});
