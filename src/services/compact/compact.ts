/**
 * orion code - Compact 服务
 *
 * 长对话压缩服务，减少上下文长度同时保留关键信息。
 * 参考 OpenClaude 的 compact/ 目录实现。
 */

import type { Message } from '../llm';
import type { LLMService } from '../llm';
import {
  summaryGenerator,
  generateSummaryWithSource,
  type SummaryOptions,
} from './summary-generator';
import { renderContextCapsule, renderHarnessStateForCompact, type ContextCapsule, type HarnessState } from '../../harness';

// ============================================================================
// 类型定义
// ============================================================================

export interface CompactOptions {
  /** 最大保留消息数 */
  maxMessages?: number;
  /** 是否保留工具调用 */
  keepToolCalls?: boolean;
  /** 是否保留系统消息 */
  keepSystemMessage?: boolean;
  /** 压缩阈值（消息数超过此值触发） */
  threshold?: number;
  /** 自定义摘要生成选项 */
  summaryOptions?: SummaryOptions;
  /** Harness capsule that must survive compaction */
  contextCapsule?: ContextCapsule;
  /** Full Context Harness state that must survive compaction */
  harnessState?: HarnessState;
  /** v0.2.24 — Goal objective that must survive compaction */
  goalObjective?: string;
  /** LLM service for high-quality summarization (optional, falls back to heuristic) */
  llm?: LLMService;
  /** Why this compaction happened */
  compactMode?: 'manual' | 'auto_pre_turn' | 'mid_turn';
}

export interface CompactResult {
  /** 压缩后的消息列表 */
  messages: Message[];
  /** 压缩前消息数 */
  originalCount: number;
  /** 压缩后消息数 */
  compactedCount: number;
  /** 压缩比率 */
  ratio: number;
  /** 摘要内容 */
  summary: string;
  summarySource: 'llm' | 'heuristic';
  summaryGeneratedAt: number;
}

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULT_OPTIONS: CompactOptions = {
  maxMessages: 20,
  keepToolCalls: true,
  keepSystemMessage: true,
  threshold: 0, // 不再使用消息数阈值，由 auto-compact 基于 token 控制
};

// ============================================================================
// Compact 实现
// ============================================================================

/**
 * 压缩消息历史
 *
 * 策略：
 * 1. 保留 system 消息
 * 2. 保留最近 N 条消息
 * 3. 对早期消息生成摘要替换
 */
export async function compactMessages(
  messages: Message[],
  options?: CompactOptions
): Promise<CompactResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const originalCount = messages.length;

  // 检查是否需要压缩
  if (originalCount <= opts.threshold!) {
    return {
      messages,
      originalCount,
      compactedCount: originalCount,
      ratio: 1,
      summary: '',
      summarySource: 'heuristic',
      summaryGeneratedAt: Date.now(),
    };
  }

  // 1. 保留 system 消息
  const systemMessage = opts.keepSystemMessage
    ? messages.find(m => m.role === 'system')
    : undefined;

  // 2. 分离需要压缩的消息
  const toCompact = opts.keepSystemMessage
    ? messages.filter(m => m.role !== 'system')
    : messages;

  const priorSummary = [...toCompact]
    .reverse()
    .find(message => message.content?.startsWith('[Context Summary]\n'));
  const conversationMessages = toCompact.filter(
    message =>
      !message.content?.startsWith('[Context Summary]\n') &&
      !(
        message.role === 'assistant' &&
        message.content ===
          'I understand the context. I will continue the conversation with this background information.'
      )
  );

  // 3. 保留最近 maxMessages 条
  const recentMessages = conversationMessages.slice(-opts.maxMessages!);
  const oldMessages = conversationMessages.slice(
    0,
    conversationMessages.length - opts.maxMessages!
  );
  if (priorSummary) oldMessages.unshift(priorSummary);

  // 4. 对早期消息生成摘要
  // Use LLM-driven summary if LLM service is provided, else fall back to heuristic
  const generated = opts.llm
    ? await generateSummaryWithSource(oldMessages, opts.llm, opts.summaryOptions)
    : {
        text: await summaryGenerator(oldMessages, opts.summaryOptions),
        source: 'heuristic' as const,
      };
  const summary = generated.text;

  // 5. 构建压缩后的消息列表
  let compactedMessages: Message[] = [];

  if (systemMessage) {
    compactedMessages.push(systemMessage);
  }

  // Preserve structured task state before the lossy natural-language summary.
  if (opts.harnessState) {
    compactedMessages.push({
      role: 'user',
      content: renderHarnessStateForCompact(opts.harnessState, opts.compactMode ?? 'manual'),
    });
    compactedMessages.push({
      role: 'assistant',
      content: 'I will continue from this Orion Code Context State and preserve its root objective, active instruction, constraints, and verification state.',
    });
  } else if (opts.contextCapsule) {
    compactedMessages.push({
      role: 'user',
      content: renderContextCapsule(opts.contextCapsule),
    });
    compactedMessages.push({
      role: 'assistant',
      content: 'I will continue from this Context Capsule and preserve its open todos, constraints, and verification state.',
    });
  }

  // 添加摘要作为 user 消息（作为上下文背景）
  if (summary) {
    compactedMessages.push({
      role: 'user',
      content: `[Context Summary]\n${summary}`,
    });
    compactedMessages.push({
      role: 'assistant',
      content: 'I understand the context. I will continue the conversation with this background information.',
    });
  }

  // 添加最近消息
  compactedMessages.push(...recentMessages);

  // 过滤工具调用（如果需要）
  if (!opts.keepToolCalls) {
    compactedMessages = compactedMessages.map(m => {
      if (m.role === 'assistant' && m.tool_calls) {
        return { ...m, tool_calls: undefined };
      }
      return m;
    });
  }

  const compactedCount = compactedMessages.length;
  const ratio = compactedCount / originalCount;

  return {
    messages: compactedMessages,
    originalCount,
    compactedCount,
    ratio,
    summary,
    summarySource: generated.source,
    summaryGeneratedAt: Date.now(),
  };
}

/**
 * 检查是否需要压缩
 */
export function needsCompact(messages: Message[], threshold?: number): boolean {
  const limit = threshold || DEFAULT_OPTIONS.threshold!;
  return messages.length > limit;
}

/**
 * 快速压缩（不生成摘要，直接保留最近 N 条）
 */
export function quickCompact(messages: Message[], keepLast: number = 10): Message[] {
  const systemMessage = messages.find(m => m.role === 'system');

  // 过滤掉 system
  const nonSystem = messages.filter(m => m.role !== 'system');

  // 保留最近 keepLast 条
  const recent = nonSystem.slice(-keepLast);

  // 构建结果
  const result: Message[] = [];
  if (systemMessage) {
    result.push(systemMessage);
  }
  result.push(...recent);

  return result;
}

// ============================================================================
// 导出
// ============================================================================

export { CompactOptions as CompactConfig, CompactResult as CompactResultData };
