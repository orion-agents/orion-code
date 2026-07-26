/**
 * orion code - LLM 服务层
 *
 * 封装 OpenAI 兼容 API，支持流式和非流式调用。
 * 兼容 OpenAI、Claude (via proxy)、本地 Ollama 等。
 * 支持工具调用（function calling）和 agentic 循环。
 * 支持重试机制和 fallback model。
 */

import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { randomUUID } from 'crypto';
import { diagnoseProviderError, toLLMProviderError } from './provider-diagnostics';
import type { ProviderErrorType } from './provider-diagnostics';

export { LLMProviderError } from './provider-diagnostics';
export type { ProviderErrorDiagnostic, ProviderErrorType } from './provider-diagnostics';

// ============================================================================
// 类型定义
// ============================================================================

/** LLM 配置 — 用户只需关注 3 项 */
export interface LLMConfig {
  /** API Key */
  apiKey: string;
  /** API Base URL（兼容第三方） */
  baseUrl?: string;
  /** 模型名称 */
  model: string;
  /** 备用模型（主模型失败时切换） */
  fallbackModel?: string;
  /** 请求超时 (ms) */
  timeout?: number;
  // 以下参数由 Agent 智能控制，不暴露给用户:
  // maxTokens:    代码 8192 / 分析 4096 / 简短 512
  // temperature:  代码 0.1 / 分析 0.3 / 创意 0.7
  // maxRetries:   指数退避，自动调整
}

/** 重试配置 */
export interface RetryConfig {
  /** 最大重试次数 */
  maxRetries: number;
  /** 基础延迟 ms */
  baseDelayMs: number;
  /** 最大延迟 ms */
  maxDelayMs?: number;
  /** Abort retries and retry backoff when the current turn is interrupted */
  abortSignal?: AbortSignal;
  /** 重试回调 */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

export interface LLMRequestDiagnostics {
  retryCount: number;
  retryDelayMs: number;
  retryErrorTypes: ProviderErrorType[];
  lastRetryErrorType?: ProviderErrorType;
  lastRetryStatus?: number;
  fallbackTriggered: boolean;
  fallbackFromModel?: string;
  fallbackToModel?: string;
  finalModel: string;
  usingFallback: boolean;
}

/** Fallback 触发错误 */
export class FallbackTriggeredError extends Error {
  constructor(
    public readonly originalModel: string,
    public readonly fallbackModel: string,
  ) {
    super(`Fallback triggered: ${originalModel} -> ${fallbackModel}`);
    this.name = 'FallbackTriggeredError';
  }
}

/** Cache control hint for provider-level prompt caching */
export interface CacheControl {
  type: 'ephemeral';
}

/** Provider-agnostic cache control content part.
 *  Appended to content arrays when cacheControl is set on a message.
 *  Supported by Anthropic (via OpenAI-compatible) — silently ignored by OpenAI. */
export interface CacheControlContentPart {
  type: 'text';
  text: '';
  cache_control: { type: 'ephemeral' };
}

/** 对话消息 */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  /** Provider-level prompt caching hint. Set on messages expected to be identical
   *  across consecutive requests (e.g. static system prompt prefix). */
  cacheControl?: CacheControl;
}

/** 工具定义 */
export interface Tool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** LLM 响应 */
export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number;
  /** Provider-reported billed cost in USD, when supplied by the API. */
  costUsd?: number;
  /** Provider request id, or a locally generated id when omitted. */
  requestId?: string;
}

export interface LLMUsageEvent {
  usage: LLMUsage;
  model: string;
  operation: 'chat' | 'chat_stream';
}

export interface LLMResponse {
  /** 回复内容 */
  content: string;
  /** Token 用量 */
  usage?: LLMUsage;
  /** 使用的模型 */
  model: string;
  /** 工具调用 */
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

/** 流式回调 */
export type StreamCallback = (chunk: string) => void;

/** 工具回调 — LLM 流式输出时的钩子 */
export interface StreamCallbacks {
  /** 文本块回调 */
  onChunk?: StreamCallback;
  /** 思考提示回调（流式开始前） */
  onThinking?: () => void;
}

export interface StreamOptions {
  abortSignal?: AbortSignal;
}

// ============================================================================
// 重试机制
// ============================================================================

/** 默认重试配置 */
const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 10000,
};

/** 529 错误最大重试次数（触发 fallback） */
const MAX_529_RETRIES = 3;

/** 判断错误是否可重试 */
function isRetryableError(error: unknown): boolean {
  return diagnoseProviderError(error).retryable;
}

function isRateLimitError(error: unknown): boolean {
  return diagnoseProviderError(error).type === 'rate_limit';
}

function createAbortError(): Error {
  const error = new Error('Operation cancelled');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** 从错误中提取 retry-after 时间 */
function getRetryAfterMs(error: unknown): number | null {
  if (error instanceof OpenAI.APIError && error.headers) {
    const headers = error.headers;
    let retryAfter: string | null = null;

    // headers may be Headers object or plain object
    if (headers && typeof headers === 'object') {
      if ('get' in headers && typeof headers.get === 'function') {
        retryAfter = headers.get('retry-after');
      } else if ('retry-after' in headers) {
        retryAfter = (headers as Record<string, string>)['retry-after'];
      }
    }

    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds)) return seconds * 1000;
    }
  }
  return null;
}

/** 指数退避计算 */
function exponentialBackoff(attempt: number, baseDelayMs: number, maxDelayMs?: number): number {
  const delay = baseDelayMs * Math.pow(2, attempt - 1);
  return maxDelayMs ? Math.min(delay, maxDelayMs) : delay;
}

/** Sleep 函数 */
function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (!abortSignal) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  return new Promise((resolve, reject) => {
    if (abortSignal.aborted) {
      reject(createAbortError());
      return;
    }

    const timeout = setTimeout(() => {
      abortSignal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(createAbortError());
    };
    abortSignal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 带重试的操作 */
async function withRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
    try {
      throwIfAborted(config.abortSignal);
      return await operation();
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (!isRetryableError(error)) {
        throw lastError;
      }

      if (attempt > config.maxRetries) {
        throw lastError;
      }

      let delayMs = exponentialBackoff(attempt, config.baseDelayMs, config.maxDelayMs);

      const retryAfter = getRetryAfterMs(error);
      if (retryAfter !== null) {
        delayMs = retryAfter;
      } else if (isRateLimitError(error)) {
        delayMs = Math.max(delayMs, Math.min(2000, config.baseDelayMs * 4));
      }

      config.onRetry?.(attempt, lastError, delayMs);

      await sleep(delayMs, config.abortSignal);
    }
  }

  throw lastError ?? new Error('Unknown error');
}

// ============================================================================
// LLMService
// ============================================================================

// ============================================================================
// Agent 内部参数默认值（用户无需配置）
// ============================================================================

const DEFAULT_MAX_TOKENS = 8192;      // 代码场景需要足够长的输出
const DEFAULT_TEMPERATURE = 0.1;       // 代码场景需要确定性输出
const DEFAULT_MAX_RETRIES = DEFAULT_RETRY_CONFIG.maxRetries;
const DEFAULT_RETRY_DELAY = DEFAULT_RETRY_CONFIG.baseDelayMs;

function toNonNegativeFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

/** Extract non-standard billing fields used by OpenAI-compatible providers. */
function extractProviderCost(usage: any, response: any): number | undefined {
  return [
    usage?.cost,
    usage?.total_cost,
    usage?.cost_usd,
    response?.cost,
    response?.total_cost,
    response?.cost_usd,
  ]
    .map(toNonNegativeFiniteNumber)
    .find(value => value !== undefined);
}

function extractLLMUsage(usage: any, response: any, requestId?: string): LLMUsage {
  const cachedPromptTokens = toNonNegativeFiniteNumber(
    usage?.prompt_tokens_details?.cached_tokens
      ?? usage?.input_tokens_details?.cached_tokens,
  );
  return {
    promptTokens: toNonNegativeFiniteNumber(usage?.prompt_tokens ?? usage?.input_tokens) ?? 0,
    completionTokens:
      toNonNegativeFiniteNumber(usage?.completion_tokens ?? usage?.output_tokens) ?? 0,
    ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
    ...(extractProviderCost(usage, response) !== undefined
      ? { costUsd: extractProviderCost(usage, response) }
      : {}),
    requestId: requestId || randomUUID(),
  };
}

export class LLMService {
  private client: OpenAI;
  private config: {
    model: string;
    fallbackModel: string;
    maxTokens: number;
    temperature: number;
    timeout: number;
    maxRetries: number;
    retryBaseDelay: number;
  };
  private consecutive529Errors = 0;
  private usingFallback = false;
  private lastRequestDiagnostics: LLMRequestDiagnostics;
  private usageObservers = new Set<(event: LLMUsageEvent) => void>();
  /** v0.2.25: injected resilience coordinator (optional — falls back to old withRetry if absent). */
  resilience?: import('./provider-resilience').ProviderResilienceCoordinator;

  constructor(config: LLMConfig) {
    // v0.2.25: disable SDK built-in retry (maxRetries=0). Orion Code owns retry policy.
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: config.timeout ?? 60000,
      maxRetries: 0,
      dangerouslyAllowBrowser: true,
    });

    // Agent 内部控制参数，不由用户配置
    this.config = {
      model: config.model,
      fallbackModel: config.fallbackModel ?? '',
      maxTokens: DEFAULT_MAX_TOKENS,
      temperature: DEFAULT_TEMPERATURE,
      timeout: config.timeout ?? 60000,
      maxRetries: DEFAULT_MAX_RETRIES,
      retryBaseDelay: DEFAULT_RETRY_DELAY,
    };
    this.lastRequestDiagnostics = this.createRequestDiagnostics();
  }

  /** 是否正在使用 fallback model */
  isUsingFallback(): boolean {
    return this.usingFallback;
  }

  getLastRequestDiagnostics(): LLMRequestDiagnostics {
    return {
      ...this.lastRequestDiagnostics,
      retryErrorTypes: [...this.lastRequestDiagnostics.retryErrorTypes],
    };
  }

  /** Observe every successful provider call, including compact summaries. */
  subscribeUsage(observer: (event: LLMUsageEvent) => void): () => void {
    this.usageObservers.add(observer);
    return () => this.usageObservers.delete(observer);
  }

  /** 触发 fallback */
  triggerFallback(): void {
    if (this.config.fallbackModel && !this.usingFallback) {
      this.usingFallback = true;
      this.config.model = this.config.fallbackModel;
      this.consecutive529Errors = 0;
    }
  }

  /** 重置为原始 model */
  resetToPrimary(): void {
    this.usingFallback = false;
    this.consecutive529Errors = 0;
  }

  /**
   * 非流式对话
   */
  async chat(messages: Message[], tools?: Tool[]): Promise<LLMResponse> {
    const params: Record<string, unknown> = {
      model: this.config.model,
      messages: this.toOpenAIMessages(messages),
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
    };

    if (tools && tools.length > 0) {
      params.tools = tools as ChatCompletionTool[];
    }

    // v0.2.25: Use resilience coordinator when available.
    let response: any;
    try {
      if (this.resilience) {
        const result = await this.resilience.execute(
          { logicalRequestId: `chat-${Date.now()}`, operation: 'root_chat', providerKey: 'default', requestedModel: this.config.model },
          async () => ({ response: await this.client.chat.completions.create(params as any) }),
        );
        response = result.result;
      } else {
        response = await this.client.chat.completions.create(params as any);
      }
    } catch (error) {
      // v0.2.25: ProviderRetryExhaustedError is a recoverable turn failure.
      if (error instanceof Error && error.name === 'ProviderRetryExhaustedError') throw error;
      if (isAbortError(error)) throw error;
      throw toLLMProviderError(error);
    }

    const message = response.choices?.[0]?.message;
    const content = message?.content ?? '';
    const toolCalls = message?.tool_calls?.map((tc: any) => ({
      id: tc.id,
      type: 'function' as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));

    const usage = response.usage
      ? extractLLMUsage(response.usage, response, response.id)
      : undefined;

    if (usage) this.publishUsage(usage, response.model ?? this.config.model, 'chat');

    return {
      content,
      usage,
      model: response.model,
      toolCalls,
    };
  }

  /**
   * 流式对话（带重试）
   */
  async chatStream(
    messages: Message[],
    callbacks?: StreamCallbacks | StreamCallback,
    tools?: Tool[],
    options?: StreamOptions,
  ): Promise<LLMResponse> {
    const onChunk = typeof callbacks === 'function' ? callbacks : callbacks?.onChunk;
    const onThinking = typeof callbacks === 'object' ? callbacks?.onThinking : undefined;
    const requestDiagnostics = this.createRequestDiagnostics();
    this.lastRequestDiagnostics = requestDiagnostics;

    const retryConfig: RetryConfig = {
      maxRetries: this.config.maxRetries,
      baseDelayMs: this.config.retryBaseDelay,
      maxDelayMs: 10000,
      abortSignal: options?.abortSignal,
      onRetry: (_attempt, error, delayMs) => {
        const diagnostic = diagnoseProviderError(error);
        requestDiagnostics.retryCount++;
        requestDiagnostics.retryDelayMs += delayMs;
        requestDiagnostics.retryErrorTypes.push(diagnostic.type);
        requestDiagnostics.lastRetryErrorType = diagnostic.type;
        requestDiagnostics.lastRetryStatus = diagnostic.status;

        // Provider overload/busy errors can often recover by retrying or using fallback.
        if (diagnostic.status === 529 || diagnostic.type === 'provider_busy' || diagnostic.type === 'rate_limit') {
          this.consecutive529Errors++;
          if (this.consecutive529Errors >= MAX_529_RETRIES && this.config.fallbackModel && !this.usingFallback) {
            const originalModel = this.config.model;
            this.triggerFallback();
            if (this.config.model !== originalModel) {
              requestDiagnostics.fallbackTriggered = true;
              requestDiagnostics.fallbackFromModel = originalModel;
              requestDiagnostics.fallbackToModel = this.config.model;
            }
          }
        }
        requestDiagnostics.finalModel = this.config.model;
        requestDiagnostics.usingFallback = this.usingFallback;
      },
    };

    try {
      // v0.2.26: Use resilience coordinator when available for streaming too.
      if (this.resilience) {
        const streamResult = await this.resilience.execute(
          {
            logicalRequestId: `stream-${Date.now()}`,
            operation: 'root_chat_stream',
            providerKey: 'default',
            requestedModel: this.config.model,
            abortSignal: options?.abortSignal,
          },
          async (_attempt: number, signal?: AbortSignal) => {
            throwIfAborted(signal);

            const params: Record<string, unknown> = {
              model: this.config.model,
              messages: this.toOpenAIMessages(messages),
              max_tokens: this.config.maxTokens,
              temperature: this.config.temperature,
              stream: true,
              stream_options: { include_usage: true },
            };

            if (tools && tools.length > 0) {
              params.tools = tools as ChatCompletionTool[];
            }

            onThinking?.();

            const requestOptions = signal ? { signal } : undefined;
            const stream = await this.client.chat.completions.create(
              params as any,
              requestOptions as any,
            ) as unknown as AsyncIterable<any>;

            let content = '';
            let usedModel = this.config.model;
            let usage: LLMUsage | undefined;
            let providerRequestId: string | undefined;
            const toolCallsMap = new Map<string, {
              id: string;
              type: 'function';
              function: { name: string; arguments: string };
            }>();

            for await (const chunk of stream) {
              throwIfAborted(signal);

              // Debug: log raw chunk when tool_calls present
              if (process.env.ORION_CODE_DEBUG_TOOLS === 'true') {
                const delta = chunk.choices?.[0]?.delta;
                if (delta?.tool_calls || chunk.choices?.[0]?.message?.tool_calls) {
                  console.log('[DEBUG] Raw chunk:', JSON.stringify(chunk, null, 2));
                }
              }

              const delta = chunk.choices?.[0]?.delta;

              const text = delta?.content ?? '';
              if (text) {
                content += text;
                onChunk?.(text);
              }

              for (const tc of delta?.tool_calls ?? []) {
                const idx = tc.index ?? 0;
                const existing = toolCallsMap.get(idx);
                if (!existing) {
                  toolCallsMap.set(idx, {
                    id: tc.id ?? `call_${idx}`,
                    type: 'function',
                    function: { name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' },
                  });
                } else {
                  if (tc.id) existing.id = tc.id;
                  if (tc.function?.name) existing.function.name = tc.function.name;
                  if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
                }
              }

              const msg = chunk.choices?.[0]?.message;
              if (msg?.tool_calls && !delta?.tool_calls) {
                for (const msgTc of msg.tool_calls) {
                  const existing = toolCallsMap.get(msgTc.index ?? 0);
                  if (!existing && msgTc.id) {
                    toolCallsMap.set(msgTc.index ?? 0, {
                      id: msgTc.id,
                      type: 'function',
                      function: { name: msgTc.function?.name ?? '', arguments: msgTc.function?.arguments ?? '' },
                    });
                  } else if (existing && msgTc.function?.arguments) {
                    existing.function.arguments += msgTc.function.arguments;
                  }
                }
              }

              if (chunk.usage) {
                usage = extractLLMUsage(chunk.usage, chunk, chunk.id ?? providerRequestId);
              }

              if (chunk.id) providerRequestId = chunk.id;

              if (chunk.model) {
                usedModel = chunk.model;
              }
            }

            const toolCalls = Array.from(toolCallsMap.entries())
              .sort(([a], [b]) => Number(a) - Number(b))
              .map(([, value]) => value);

            for (const tc of toolCalls) {
              if (!tc.function.arguments || tc.function.arguments.trim() === '') {
                tc.function.arguments = '{}';
              } else {
                try {
                  const parsed = JSON.parse(tc.function.arguments);
                  tc.function.arguments = JSON.stringify(parsed);
                } catch {
                  tc.function.arguments = '{}';
                }
              }
            }

            if (usage) this.publishUsage(usage, usedModel, 'chat_stream');

            return {
              response: {
                content,
                model: usedModel,
                usage,
                toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
              } as LLMResponse,
              usage: usage ? {
                promptTokens: usage.promptTokens,
                completionTokens: usage.completionTokens,
                totalTokens: usage.promptTokens + usage.completionTokens,
              } : undefined,
              providerRequestId,
            };
          },
        );

        // Unpack resilience result
        const response: LLMResponse = streamResult.result;
        this.consecutive529Errors = 0;
        requestDiagnostics.finalModel = response.model;
        requestDiagnostics.usingFallback = this.usingFallback;
        this.lastRequestDiagnostics = {
          ...requestDiagnostics,
          retryErrorTypes: [...requestDiagnostics.retryErrorTypes],
        };
        return response;
      }

      // Legacy path: without resilience coordinator
      else {
        const response = await withRetry(
        async () => {
          throwIfAborted(options?.abortSignal);

          const params: Record<string, unknown> = {
            model: this.config.model,
            messages: this.toOpenAIMessages(messages),
            max_tokens: this.config.maxTokens,
            temperature: this.config.temperature,
            stream: true,
            stream_options: { include_usage: true },
          };

          if (tools && tools.length > 0) {
            params.tools = tools as ChatCompletionTool[];
          }

          onThinking?.();

          const requestOptions = options?.abortSignal ? { signal: options.abortSignal } : undefined;
          const stream = await this.client.chat.completions.create(
            params as any,
            requestOptions as any,
          ) as unknown as AsyncIterable<any>;

          let content = '';
          let usedModel = this.config.model;
          let usage: LLMUsage | undefined;
          let providerRequestId: string | undefined;
          const toolCallsMap = new Map<string, {
            id: string;
            type: 'function';
            function: { name: string; arguments: string };
          }>();

          for await (const chunk of stream) {
            throwIfAborted(options?.abortSignal);

            // Debug: log raw chunk when tool_calls present (for diagnosing API compatibility)
            if (process.env.ORION_CODE_DEBUG_TOOLS === 'true') {
              const delta = chunk.choices?.[0]?.delta;
              if (delta?.tool_calls || chunk.choices?.[0]?.message?.tool_calls) {
                console.log('[DEBUG] Raw chunk:', JSON.stringify(chunk, null, 2));
              }
            }

            const delta = chunk.choices?.[0]?.delta;

            const text = delta?.content ?? '';
            if (text) {
              content += text;
              onChunk?.(text);
            }

            // Handle tool_calls from delta (OpenAI standard streaming format).
            // A single stream chunk may contain multiple tool call deltas.
            for (const tc of delta?.tool_calls ?? []) {
              const idx = tc.index ?? 0;
              const existing = toolCallsMap.get(idx);
              if (!existing) {
                toolCallsMap.set(idx, {
                  id: tc.id ?? `call_${idx}`,
                  type: 'function',
                  function: { name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' },
                });
              } else {
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.function.name = tc.function.name;
                if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
              }
            }

            // Handle tool_calls from message (some APIs like DashScope may use this format)
            const msg = chunk.choices?.[0]?.message;
            if (msg?.tool_calls && !delta?.tool_calls) {
              for (const msgTc of msg.tool_calls) {
                const existing = toolCallsMap.get(msgTc.index ?? 0);
                if (!existing && msgTc.id) {
                  toolCallsMap.set(msgTc.index ?? 0, {
                    id: msgTc.id,
                    type: 'function',
                    function: { name: msgTc.function?.name ?? '', arguments: msgTc.function?.arguments ?? '' },
                  });
                } else if (existing && msgTc.function?.arguments) {
                  existing.function.arguments += msgTc.function.arguments;
                }
              }
            }

            if (chunk.usage) {
              usage = extractLLMUsage(chunk.usage, chunk, chunk.id ?? providerRequestId);
            }

            if (chunk.id) providerRequestId = chunk.id;

            if (chunk.model) {
              usedModel = chunk.model;
            }
          }

          const toolCalls = Array.from(toolCallsMap.entries())
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([, value]) => value);

          for (const tc of toolCalls) {
            if (!tc.function.arguments || tc.function.arguments.trim() === '') {
              tc.function.arguments = '{}';
            } else {
              try {
                const parsed = JSON.parse(tc.function.arguments);
                tc.function.arguments = JSON.stringify(parsed);
              } catch {
                tc.function.arguments = '{}';
              }
            }
          }

          if (usage) this.publishUsage(usage, usedModel, 'chat_stream');

          this.consecutive529Errors = 0;
          requestDiagnostics.finalModel = usedModel;
          requestDiagnostics.usingFallback = this.usingFallback;
          this.lastRequestDiagnostics = {
            ...requestDiagnostics,
            retryErrorTypes: [...requestDiagnostics.retryErrorTypes],
          };
          return {
            content,
            model: usedModel,
            usage,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          };
        },
        retryConfig,
      );
      requestDiagnostics.finalModel = response.model;
      requestDiagnostics.usingFallback = this.usingFallback;
      this.lastRequestDiagnostics = {
        ...requestDiagnostics,
        retryErrorTypes: [...requestDiagnostics.retryErrorTypes],
      };
      return response;
      } // end legacy else branch
    } catch (error) {
      requestDiagnostics.finalModel = this.config.model;
      requestDiagnostics.usingFallback = this.usingFallback;
      this.lastRequestDiagnostics = {
        ...requestDiagnostics,
        retryErrorTypes: [...requestDiagnostics.retryErrorTypes],
      };
      if (isAbortError(error)) throw error;
      throw toLLMProviderError(error);
    }
  }

  private publishUsage(
    usage: LLMUsage,
    model: string,
    operation: LLMUsageEvent['operation'],
  ): void {
    for (const observer of this.usageObservers) {
      try {
        observer({ usage, model, operation });
      } catch {
        // Telemetry/accounting observers must not fail the model request.
      }
    }
  }

  /**
   * 带工具调用的 agentic 循环
   */
  async chatWithTools(
    messages: Message[],
    tools: Tool[],
    toolExecutor: (name: string, args: Record<string, unknown>) => Promise<string>,
    callbacks?: StreamCallbacks,
    maxIterations = 10,
  ): Promise<LLMResponse> {
    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;

      const response = await this.chatStream(messages, {
        onChunk: callbacks?.onChunk,
        onThinking: iteration === 1 ? callbacks?.onThinking : undefined,
      }, tools);

      const assistantMsg: Message = {
        role: 'assistant',
        content: response.content,
      };
      if (response.toolCalls) {
        assistantMsg.tool_calls = response.toolCalls;
      }
      messages.push(assistantMsg);

      if (response.toolCalls && response.toolCalls.length > 0) {
        for (const tc of response.toolCalls) {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            // Malformed JSON arguments from LLM — use empty object as fallback.
            args = {};
          }
          const result = await toolExecutor(tc.function.name, args);
          messages.push({
            role: 'tool',
            content: result,
            tool_call_id: tc.id,
          });
        }
        continue;
      }

      return response;
    }

    return {
      content: '达到了最大执行步数限制，未能完成。请简化任务。',
      model: this.config.model,
    };
  }

  /**
   * 切换模型
   */
  setModel(model: string): void {
    this.config.model = model;
  }

  /**
   * 获取当前模型
   */
  getModel(): string {
    return this.config.model;
  }

  /** Maximum completion tokens requested from the provider for each call. */
  getMaxTokens(): number {
    return this.config.maxTokens;
  }

  /**
   * 获取当前配置摘要
   */
  getConfigSummary(): Record<string, string> {
    return {
      model: this.config.model,
      fallback: this.config.fallbackModel || '(none)',
      maxTokens: String(this.config.maxTokens),
      temperature: String(this.config.temperature),
      timeout: String(this.config.timeout),
      maxRetries: String(this.config.maxRetries),
    };
  }

  // ---- Internal ----

  private createRequestDiagnostics(): LLMRequestDiagnostics {
    return {
      retryCount: 0,
      retryDelayMs: 0,
      retryErrorTypes: [],
      fallbackTriggered: false,
      finalModel: this.config.model,
      usingFallback: this.usingFallback,
    };
  }

  /** 转换为 OpenAI SDK 消息格式 */
  private toOpenAIMessages(messages: Message[]): ChatCompletionMessageParam[] {
    return messages.map(msg => {
      if (msg.role === 'tool') {
        return {
          role: 'tool',
          content: msg.content,
          tool_call_id: msg.tool_call_id ?? '',
        } as ChatCompletionMessageParam;
      }
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        return {
          role: 'assistant',
          content: msg.content,
          tool_calls: msg.tool_calls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          })),
        } as ChatCompletionMessageParam;
      }
      // Apply cache control for providers that support it (Anthropic via OpenAI-compatible API).
      // Converts content to content array format with cache_control block appended.
      if (msg.cacheControl?.type === 'ephemeral' && msg.content) {
        return {
          role: msg.role,
          content: [
            { type: 'text', text: msg.content },
            { type: 'text', text: '', cache_control: { type: 'ephemeral' } },
          ],
        } as unknown as ChatCompletionMessageParam;
      }
      return {
        role: msg.role,
        content: msg.content,
      } as ChatCompletionMessageParam;
    });
  }
}
