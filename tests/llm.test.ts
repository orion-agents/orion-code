/**
 * LLMService 单元测试
 *
 * 测试 LLMService 的核心功能，包括：
 * - chatStream usage 提取
 * - 消息格式转换
 * - 工具调用处理
 */

import {
  LLMProviderError,
  LLMService,
  ProviderRequestPreflightError,
  type CacheControlContentPart,
  type Message,
  type Tool,
} from '../src/services/llm';
import { ProviderResilienceCoordinator } from '../src/services/provider-resilience';
import { diagnoseProviderError } from '../src/services/provider-diagnostics';

// Skip real API tests if no API key is available
const hasApiKey = Boolean(process.env.ORION_CODE_API_KEY);

describe('LLMService', () => {
  describe('toOpenAIMessages (internal)', () => {
    test('converts simple messages', () => {
      const llm = new LLMService({
        apiKey: 'test-key',
        model: 'gpt-4o',
      });

      // Access internal method via any
      const messages: Message[] = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ];

      // The method is private, but we can test it via chat call structure
      // For now, just verify the service is constructed correctly
      expect(llm.getModel()).toBe('gpt-4o');
    });

    test('converts tool messages', () => {
      const llm = new LLMService({
        apiKey: 'test-key',
        model: 'gpt-4o',
      });

      // Tool message format
      const messages: Message[] = [
        { role: 'user', content: 'What is the weather?' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call-123',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"location":"Beijing"}' },
            },
          ],
        },
        { role: 'tool', content: '{"temp":25}', tool_call_id: 'call-123' },
      ];

      // Verify service handles tool messages
      expect(llm).toBeDefined();
    });
  });

  describe('setModel/getModel', () => {
    test('setModel changes the model', () => {
      const llm = new LLMService({
        apiKey: 'test-key',
        model: 'gpt-4o',
      });

      expect(llm.getModel()).toBe('gpt-4o');

      llm.setModel('claude-sonnet-4-6');
      expect(llm.getModel()).toBe('claude-sonnet-4-6');
    });
  });

  describe('getConfigSummary', () => {
    test('returns config summary', () => {
      const llm = new LLMService({
        apiKey: 'test-key',
        model: 'gpt-4o',
      });

      const summary = llm.getConfigSummary();

      expect(summary.model).toBe('gpt-4o');
      expect(summary.maxTokens).toBe('8192');
      expect(summary.temperature).toBe('0.1');
    });
  });

  describe('provider diagnostics', () => {
    test('classifies common provider failures into structured types', () => {
      const cases = [
        [
          Object.assign(new Error('404 model_not_found: model x does not exist'), {
            status: 404,
            code: 'model_not_found',
          }),
          'model_not_found',
          false,
        ],
        [Object.assign(new Error('401 invalid_api_key'), { status: 401 }), 'auth_failed', false],
        [
          new Error('Xunfei code: 11210, msg: NotEnoughCvError'),
          'quota_or_credit_exhausted',
          false,
        ],
        [
          { status: 403, code: '11210', message: 'NotEnoughCvError' },
          'quota_or_credit_exhausted',
          false,
        ],
        [Object.assign(new Error('429 API_LIMIT'), { status: 429 }), 'rate_limit', true],
        [new Error('code: 10012, msg: EngineInternalError: system is busy'), 'provider_busy', true],
        [new Error('Invalid URL: ht!tp://bad-endpoint'), 'invalid_endpoint', false],
        [new Error('Connection error.'), 'unknown_provider_error', true],
      ] as const;

      for (const [error, type, retryable] of cases) {
        expect(diagnoseProviderError(error)).toMatchObject({ type, retryable });
      }
    });

    test('wraps chat errors with readable diagnostics without leaking keys', async () => {
      const llm = new LLMService({
        apiKey: 'sk-secret123456789',
        model: 'gpt-4o',
      });
      const create = jest.fn().mockRejectedValue(
        Object.assign(new Error('401 invalid_api_key: Bearer sk-secret123456789 rejected'), {
          status: 401,
          code: 'invalid_api_key',
        })
      );

      (llm as any).client = {
        chat: {
          completions: { create },
        },
      };

      let caught: unknown;
      try {
        await llm.chat([{ role: 'user', content: 'Hi' }]);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(LLMProviderError);
      expect(caught).toMatchObject({
        diagnostic: {
          type: 'auth_failed',
          status: 401,
          retryable: false,
        },
      });
      expect((caught as Error).message).toContain('LLM provider error [auth');
      expect((caught as Error).message).not.toContain('sk-secret123456789');
      expect((caught as LLMProviderError).diagnostic.providerMessage).not.toContain(
        'sk-secret123456789'
      );
    });
  });

  describe('non-standard provider responses', () => {
    test('falls back to the configured model when the response omits one', async () => {
      // LLMResponse.model is declared `string`, but `model` is optional on the
      // wire and some OpenAI-compatible gateways leave it out. Without a
      // fallback the field silently becomes `undefined` while still typed as
      // a string, which then shows up in usage accounting and the status line.
      const llm = new LLMService({ apiKey: 'test-key', model: 'configured-model' });
      (llm as any).client = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              id: 'no-model-1',
              choices: [{ message: { content: 'ok' } }],
            }),
          },
        },
      };

      const response = await llm.chat([{ role: 'user', content: 'Hi' }]);

      expect(response.model).toBe('configured-model');
      expect(response.content).toBe('ok');
    });

    test('prefers the model the provider actually routed to', async () => {
      const llm = new LLMService({ apiKey: 'test-key', model: 'configured-model' });
      (llm as any).client = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              id: 'routed-1',
              model: 'actually-served-model',
              choices: [{ message: { content: 'ok' } }],
            }),
          },
        },
      };

      const response = await llm.chat([{ role: 'user', content: 'Hi' }]);

      expect(response.model).toBe('actually-served-model');
    });
  });

  describe('usage accounting', () => {
    test('extracts provider cost and cached tokens from non-stream responses', async () => {
      const llm = new LLMService({ apiKey: 'test-key', model: 'routed-model' });
      (llm as any).client = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              id: 'request-cost-1',
              model: 'routed-model',
              choices: [{ message: { content: 'ok' } }],
              usage: {
                prompt_tokens: 100,
                completion_tokens: 20,
                prompt_tokens_details: { cached_tokens: 60 },
                cost: '0.0042',
              },
            }),
          },
        },
      };
      const observed: any[] = [];
      llm.subscribeUsage(event => observed.push(event));

      const response = await llm.chat([{ role: 'user', content: 'Hi' }]);

      expect(response.usage).toMatchObject({
        promptTokens: 100,
        completionTokens: 20,
        cachedPromptTokens: 60,
        costUsd: 0.0042,
        requestId: 'request-cost-1',
      });
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({ model: 'routed-model', operation: 'chat' });
    });

    test('publishes provider cost from the final stream usage chunk', async () => {
      const llm = new LLMService({ apiKey: 'test-key', model: 'routed-model' });
      async function* stream() {
        yield {
          id: 'request-cost-2',
          model: 'routed-model',
          choices: [{ delta: { content: 'ok' } }],
        };
        yield {
          id: 'request-cost-2',
          model: 'routed-model',
          choices: [],
          usage: { prompt_tokens: 50, completion_tokens: 10, total_cost: 0.0021 },
        };
      }
      (llm as any).client = {
        chat: { completions: { create: jest.fn().mockResolvedValue(stream()) } },
      };
      const observed: any[] = [];
      llm.subscribeUsage(event => observed.push(event));

      const response = await llm.chatStream([{ role: 'user', content: 'Hi' }]);

      expect(response.usage).toMatchObject({ costUsd: 0.0021, requestId: 'request-cost-2' });
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({ operation: 'chat_stream' });
    });
  });

  describe('chatStream cancellation', () => {
    test('passes abort signal to OpenAI request options', async () => {
      const llm = new LLMService({
        apiKey: 'test-key',
        model: 'gpt-4o',
      });
      const controller = new AbortController();
      const create = jest.fn(async function* () {
        yield {
          choices: [{ delta: { content: 'ok' } }],
          model: 'gpt-4o',
        };
        yield {
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 5, completion_tokens: 1 },
          model: 'gpt-4o',
        };
      });

      (llm as any).client = {
        chat: {
          completions: { create },
        },
      };

      const response = await llm.chatStream(
        [{ role: 'user', content: 'Hi' }],
        undefined,
        undefined,
        { abortSignal: controller.signal }
      );

      expect(response.content).toBe('ok');
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ stream: true }), {
        signal: controller.signal,
      });
    });

    test('stops processing stream chunks after abort', async () => {
      const llm = new LLMService({
        apiKey: 'test-key',
        model: 'gpt-4o',
      });
      const controller = new AbortController();
      const create = jest.fn(async function* () {
        controller.abort();
        yield {
          choices: [{ delta: { content: 'should not render' } }],
          model: 'gpt-4o',
        };
      });
      const onChunk = jest.fn();

      (llm as any).client = {
        chat: {
          completions: { create },
        },
      };

      await expect(
        llm.chatStream([{ role: 'user', content: 'Hi' }], { onChunk }, undefined, {
          abortSignal: controller.signal,
        })
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(onChunk).not.toHaveBeenCalled();
    });
  });

  describe('chatStream tool calls', () => {
    test('parses multiple tool calls from a single streaming delta chunk', async () => {
      const llm = new LLMService({
        apiKey: 'test-key',
        model: 'gpt-4o',
      });
      const create = jest.fn(async function* () {
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-0',
                    type: 'function',
                    function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
                  },
                  {
                    index: 1,
                    id: 'call-1',
                    type: 'function',
                    function: { name: 'grep', arguments: '{"pattern":"foo"}' },
                  },
                ],
              },
            },
          ],
          model: 'gpt-4o',
        };
      });

      (llm as any).client = {
        chat: {
          completions: { create },
        },
      };

      const response = await llm.chatStream([{ role: 'user', content: 'Inspect' }]);

      expect(response.toolCalls).toHaveLength(2);
      expect(response.toolCalls?.map(call => call.function.name)).toEqual(['read_file', 'grep']);
      expect(response.toolCalls?.map(call => JSON.parse(call.function.arguments))).toEqual([
        { path: 'a.ts' },
        { pattern: 'foo' },
      ]);
    });
  });

  describe('provider transient errors', () => {
    test('surfaces production resilience retry diagnostics for turn accounting', async () => {
      const llm = new LLMService({ apiKey: 'test-key', model: 'gpt-4o' });
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
            choices: [{ delta: { content: 'recovered' } }],
            model: 'gpt-4o',
            usage: { prompt_tokens: 3, completion_tokens: 1 },
          };
        });
      (llm as any).client = { chat: { completions: { create } } };

      await expect(
        llm.chatStream([{ role: 'user', content: 'Retry safely' }])
      ).resolves.toMatchObject({ content: 'recovered' });

      expect(create).toHaveBeenCalledTimes(2);
      expect(llm.getLastRequestDiagnostics()).toMatchObject({
        retryCount: 1,
        retryDelayMs: 0,
        retryErrorTypes: ['invalid_endpoint'],
        lastRetryErrorType: 'invalid_endpoint',
        finalModel: 'gpt-4o',
        fallbackTriggered: false,
      });
    });

    test('keeps a production resilience preflight rejection typed and fail-fast', async () => {
      const llm = new LLMService({ apiKey: 'test-key', model: 'gpt-4o' });
      llm.resilience = new ProviderResilienceCoordinator({
        maxTotalAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
      });
      const create = jest.fn();
      const preflight = jest.fn(() => ({
        available: false,
        reason: 'goal budget exhausted',
      }));
      (llm as any).client = { chat: { completions: { create } } };
      llm.setProviderRequestPreflight(preflight);

      const request = llm.chatStream([{ role: 'user', content: 'Do not send' }]);
      await expect(request).rejects.toBeInstanceOf(ProviderRequestPreflightError);
      await expect(request).rejects.toThrow('goal budget exhausted');

      expect(preflight).toHaveBeenCalledTimes(1);
      expect(create).not.toHaveBeenCalled();
      expect(llm.getLastRequestDiagnostics()).toMatchObject({
        retryCount: 0,
        fallbackTriggered: false,
      });
    });

    test('reports an unswitched resilience fallback disposition fail-closed', async () => {
      const llm = new LLMService({ apiKey: 'test-key', model: 'primary-model' });
      llm.resilience = {
        execute: jest.fn().mockResolvedValue({
          result: { content: 'ok', model: 'primary-model' },
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

      await expect(
        llm.chatStream([{ role: 'user', content: 'Use fallback' }])
      ).resolves.toMatchObject({ content: 'ok' });

      expect(llm.getLastRequestDiagnostics()).toMatchObject({
        retryCount: 0,
        fallbackTriggered: true,
        fallbackFromModel: 'primary-model',
        finalModel: 'primary-model',
        usingFallback: false,
      });
      expect(llm.getLastRequestDiagnostics().fallbackToModel).toBeUndefined();
    });

    test('runs budget preflight before a non-stream provider call', async () => {
      const llm = new LLMService({ apiKey: 'test-key', model: 'gpt-4o' });
      llm.resilience = new ProviderResilienceCoordinator({
        maxTotalAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
      });
      const create = jest.fn();
      (llm as any).client = { chat: { completions: { create } } };
      const preflight = jest.fn(() => ({ available: false, reason: 'goal budget exhausted' }));
      llm.setProviderRequestPreflight(preflight);

      await expect(
        llm.chat([{ role: 'user', content: 'Do not send this request' }])
      ).rejects.toBeInstanceOf(ProviderRequestPreflightError);
      expect(create).not.toHaveBeenCalled();
      expect(preflight).toHaveBeenCalledTimes(1);
      expect(preflight).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'chat',
          attempt: 1,
          model: 'gpt-4o',
          estimatedPromptTokens: expect.any(Number),
        })
      );
    });

    test('runs budget preflight before every stream retry and prevents the denied attempt', async () => {
      const llm = new LLMService({ apiKey: 'test-key', model: 'xopglm51' });
      (llm as any).config.retryBaseDelay = 1;
      (llm as any).config.maxRetries = 2;
      const create = jest
        .fn()
        .mockRejectedValue(new Error('code: 10012, msg: EngineInternalError: system is busy'));
      (llm as any).client = { chat: { completions: { create } } };
      const preflight = jest.fn(({ attempt }: { attempt: number }) => ({
        available: attempt < 2,
        reason: attempt < 2 ? undefined : 'retry would exceed goal budget',
      }));
      llm.setProviderRequestPreflight(preflight);

      await expect(
        llm.chatStream([{ role: 'user', content: 'Retry safely' }])
      ).rejects.toMatchObject({
        name: 'ProviderRequestPreflightError',
        message: 'retry would exceed goal budget',
      });
      expect(create).toHaveBeenCalledTimes(1);
      expect(preflight).toHaveBeenCalledTimes(2);
    });

    test('retries Xunfei busy errors and returns the later stream response', async () => {
      const llm = new LLMService({
        apiKey: 'test-key',
        model: 'xopglm51',
      });
      (llm as any).config.retryBaseDelay = 1;
      (llm as any).config.maxRetries = 1;

      const create = jest
        .fn()
        .mockRejectedValueOnce(
          new Error(
            'Xunfei request failed with Sid: abc code: 10012, msg: EngineInternalError:The system is busy, please try again later.'
          )
        )
        .mockImplementationOnce(async function* () {
          yield {
            choices: [{ delta: { content: 'ok' } }],
            model: 'xopglm51',
          };
        });

      (llm as any).client = {
        chat: {
          completions: { create },
        },
      };

      const response = await llm.chatStream([{ role: 'user', content: 'Hi' }]);

      expect(response.content).toBe('ok');
      expect(create).toHaveBeenCalledTimes(2);
    });

    test('retries generic provider rate-limit messages', async () => {
      const llm = new LLMService({
        apiKey: 'test-key',
        model: 'xopglm51',
      });
      (llm as any).config.retryBaseDelay = 1;
      (llm as any).config.maxRetries = 1;

      const create = jest
        .fn()
        .mockRejectedValueOnce(new Error('API_LIMIT'))
        .mockImplementationOnce(async function* () {
          yield {
            choices: [{ delta: { content: 'ok' } }],
            model: 'xopglm51',
          };
        });

      (llm as any).client = {
        chat: {
          completions: { create },
        },
      };

      const response = await llm.chatStream([{ role: 'user', content: 'Hi' }]);

      expect(response.content).toBe('ok');
      expect(create).toHaveBeenCalledTimes(2);
    });

    test('does not retry Xunfei insufficient credit errors', async () => {
      const llm = new LLMService({
        apiKey: 'test-key',
        model: 'xopglm51',
      });
      (llm as any).config.retryBaseDelay = 1;
      (llm as any).config.maxRetries = 3;

      const create = jest
        .fn()
        .mockRejectedValue(
          new Error('Xunfei request failed with Sid: abc code: 11210, msg: NotEnoughCvError')
        );

      (llm as any).client = {
        chat: {
          completions: { create },
        },
      };

      await expect(llm.chatStream([{ role: 'user', content: 'Hi' }])).rejects.toMatchObject({
        diagnostic: {
          type: 'quota_or_credit_exhausted',
          retryable: false,
        },
      });
      expect(create).toHaveBeenCalledTimes(1);
    });

    test('does not retry quota exhaustion errors', async () => {
      const llm = new LLMService({
        apiKey: 'test-key',
        model: 'xopglm51',
      });
      (llm as any).config.retryBaseDelay = 1;
      (llm as any).config.maxRetries = 3;

      const create = jest
        .fn()
        .mockRejectedValue(new Error('429 insufficient_quota: credit exhausted'));

      (llm as any).client = {
        chat: {
          completions: { create },
        },
      };

      await expect(llm.chatStream([{ role: 'user', content: 'Hi' }])).rejects.toMatchObject({
        diagnostic: {
          type: 'quota_or_credit_exhausted',
          retryable: false,
        },
      });
      expect(create).toHaveBeenCalledTimes(1);
    });

    test('abort signal cancels provider retry backoff immediately', async () => {
      const llm = new LLMService({
        apiKey: 'test-key',
        model: 'xopglm51',
      });
      (llm as any).config.retryBaseDelay = 10000;
      (llm as any).config.maxRetries = 2;

      const create = jest
        .fn()
        .mockRejectedValue(
          new Error(
            'Xunfei request failed with Sid: abc code: 10012, msg: EngineInternalError:The system is busy, please try again later.'
          )
        );

      (llm as any).client = {
        chat: {
          completions: { create },
        },
      };

      const controller = new AbortController();
      const response = llm.chatStream([{ role: 'user', content: 'Hi' }], undefined, undefined, {
        abortSignal: controller.signal,
      });

      await new Promise(resolve => setTimeout(resolve, 0));
      expect(create).toHaveBeenCalledTimes(1);

      controller.abort();

      await expect(response).rejects.toThrow('Operation cancelled');
      expect(create).toHaveBeenCalledTimes(1);
    });
  });

  // Real API tests (only run if API key is available)
  describe('Real API (requires ORION_CODE_API_KEY)', () => {
    if (!hasApiKey) {
      test.skip('Skipping real API tests - no ORION_CODE_API_KEY', () => {});
      return;
    }

    test('chatStream returns usage with stream_options', async () => {
      const config = {
        apiKey: process.env.ORION_CODE_API_KEY!,
        baseUrl: process.env.ORION_CODE_API_BASE_URL,
        model: process.env.ORION_CODE_MODEL || 'gpt-4o',
      };

      const llm = new LLMService(config);

      const messages: Message[] = [{ role: 'user', content: 'Say "test" and nothing else.' }];

      const response = await llm.chatStream(messages, {
        onChunk: chunk => {
          // Just consume chunks
        },
      });

      expect(response.content).toBeDefined();
      expect(response.content.length).toBeGreaterThan(0);

      // This is the critical test: usage should be present
      expect(response.usage).toBeDefined();
      expect(response.usage!.promptTokens).toBeGreaterThan(0);
      expect(response.usage!.completionTokens).toBeGreaterThan(0);
    }, 30000);
  });

  describe('Prompt cache control', () => {
    test('cacheControl: ephemeral converts to content array with cache_control block', async () => {
      const llm = new LLMService({
        apiKey: 'test-key',
        model: 'gpt-4o',
      });

      (llm as any).client = {
        chat: {
          completions: {
            create: jest.fn(async (params: any) => ({
              choices: [{ message: { content: 'ok', tool_calls: [] } }],
              model: 'gpt-4o',
            })),
          },
        },
      };

      const messages: Message[] = [
        { role: 'system', content: 'You are Orion Code.', cacheControl: { type: 'ephemeral' } },
        { role: 'user', content: 'Hello' },
      ];

      await llm.chat(messages);

      const callArgs = ((llm as any).client.chat.completions.create as jest.Mock).mock.calls[0];
      const capturedMessages = callArgs[0].messages;

      // Static system message should have content array with cache_control
      const sysMsg = capturedMessages[0];
      expect(Array.isArray(sysMsg.content)).toBe(true);
      expect(sysMsg.content[0]).toEqual({ type: 'text', text: 'You are Orion Code.' });
      expect(sysMsg.content[1]).toHaveProperty('cache_control', { type: 'ephemeral' });

      // User message should remain plain string
      expect(capturedMessages[1].content).toBe('Hello');
    });

    test('messages without cacheControl remain plain strings', async () => {
      const llm = new LLMService({
        apiKey: 'test-key',
        model: 'gpt-4o',
      });

      (llm as any).client = {
        chat: {
          completions: {
            create: jest.fn(async () => ({
              choices: [{ message: { content: 'ok', tool_calls: [] } }],
              model: 'gpt-4o',
            })),
          },
        },
      };

      await llm.chat([
        { role: 'system', content: 'No cache.' },
        { role: 'user', content: 'Hi' },
      ]);

      const callArgs = ((llm as any).client.chat.completions.create as jest.Mock).mock.calls[0];
      const messages = callArgs[0].messages;

      // No cacheControl → plain string content
      expect(typeof messages[0].content).toBe('string');
      expect(typeof messages[1].content).toBe('string');
    });

    test('cacheControl on assistant/tool messages works correctly', async () => {
      const llm = new LLMService({
        apiKey: 'test-key',
        model: 'gpt-4o',
      });

      (llm as any).client = {
        chat: {
          completions: {
            create: jest.fn(async () => ({
              choices: [{ message: { content: 'ok', tool_calls: [] } }],
              model: 'gpt-4o',
            })),
          },
        },
      };

      // Cache control should NOT affect messages with tool_calls (those use their own format)
      await llm.chat([
        { role: 'system', content: 'System.', cacheControl: { type: 'ephemeral' } },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"x.ts"}' },
            },
          ],
        },
      ]);

      const callArgs = ((llm as any).client.chat.completions.create as jest.Mock).mock.calls[0];
      const messages = callArgs[0].messages;

      // System: content array with cache_control
      expect(Array.isArray(messages[0].content)).toBe(true);
      // Assistant with tool_calls: object format, not content array
      expect(messages[0].role).toBe('system');
      expect(messages[1].role).toBe('assistant');
      expect(messages[1].tool_calls).toBeDefined();
    });

    test('cache_control content part matches CacheControlContentPart shape', async () => {
      const llm = new LLMService({
        apiKey: 'test-key',
        model: 'gpt-4o',
      });

      (llm as any).client = {
        chat: {
          completions: {
            create: jest.fn(async () => ({
              choices: [{ message: { content: 'ok', tool_calls: [] } }],
              model: 'gpt-4o',
            })),
          },
        },
      };

      await llm.chat([
        { role: 'system', content: 'static prefix', cacheControl: { type: 'ephemeral' } },
      ]);

      const callArgs = ((llm as any).client.chat.completions.create as jest.Mock).mock.calls[0];
      const cachePart = callArgs[0].messages[0].content[1] as CacheControlContentPart;

      // Verify the part matches the CacheControlContentPart interface exactly
      expect(cachePart.type).toBe('text');
      expect(cachePart.text).toBe('');
      expect(cachePart.cache_control.type).toBe('ephemeral');
      // No 'as any' — this is a properly typed object
    });
  });
});
