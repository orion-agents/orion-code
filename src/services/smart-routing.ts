/**
 * orion code - Smart Model Routing
 *
 * 智能路由简单请求到便宜模型，复杂请求到强模型。
 */

import type { Message } from './llm';

// ============================================================================
// 类型定义
// ============================================================================

export interface RoutingDecision {
  /** 推荐模型 */
  recommendedModel: string;
  /** 是否需要强模型 */
  needsStrongModel: boolean;
  /** 决策原因 */
  reason: string;
  /** 置信度 */
  confidence: number;
}

export interface SmartRoutingConfig {
  /** 简单模型 */
  cheapModel: string;
  /** 强模型 */
  strongModel: string;
  /** 简单请求阈值（字符数） */
  simpleThresholdChars: number;
  /** 简单请求阈值（词数） */
  simpleThresholdWords: number;
  /** 强关键词 */
  strongKeywords: string[];
  /** 简单关键词 */
  simpleKeywords: string[];
}

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULT_CONFIG: SmartRoutingConfig = {
  cheapModel: 'gpt-3.5-turbo',  // 或 haiku
  strongModel: 'gpt-4o',        // 或 sonnet/opus
  simpleThresholdChars: 160,
  simpleThresholdWords: 28,
  strongKeywords: [
    'plan', 'design', 'implement', 'debug', 'refactor',
    'architecture', 'optimize', 'security', 'performance',
    'complex', 'analyze', 'investigate', 'troubleshoot',
    'explain', 'review', 'audit',
  ],
  simpleKeywords: [
    'fix', 'add', 'remove', 'update', 'rename',
    'simple', 'quick', 'minor', 'small',
  ],
};

// ============================================================================
// Smart Routing 实现
// ============================================================================

/**
 * 分析请求复杂度并推荐模型
 */
export function analyzeRequestComplexity(
  input: string,
  messages: Message[],
  config?: SmartRoutingConfig
): RoutingDecision {
  const cfg = config || DEFAULT_CONFIG;

  // 1. 计算基本指标
  const charCount = input.length;
  const wordCount = input.split(/\s+/).filter(Boolean).length;
  const lowerInput = input.toLowerCase();

  // 2. 检查强关键词
  const hasStrongKeywords = cfg.strongKeywords.some(kw => lowerInput.includes(kw));

  // 3. 检查简单关键词
  const hasSimpleKeywords = cfg.simpleKeywords.some(kw => lowerInput.includes(kw));

  // 4. 检查历史复杂度
  const historyComplexity = analyzeHistoryComplexity(messages);

  // 5. 决策
  let needsStrongModel = false;
  let reason = '';

  // 触发强模型的条件
  if (hasStrongKeywords) {
    needsStrongModel = true;
    reason = 'Contains strong keywords indicating complex task';
  } else if (charCount > cfg.simpleThresholdChars * 3) {
    needsStrongModel = true;
    reason = 'Very long input indicating complex request';
  } else if (wordCount > cfg.simpleThresholdWords * 3) {
    needsStrongModel = true;
    reason = 'Many words indicating detailed request';
  } else if (historyComplexity > 0.7) {
    needsStrongModel = true;
    reason = 'History indicates ongoing complex task';
  }

  // 触发简单模型的条件
  if (!needsStrongModel) {
    if (hasSimpleKeywords && charCount < cfg.simpleThresholdChars) {
      reason = 'Contains simple keywords and short input';
    } else if (charCount <= cfg.simpleThresholdChars && wordCount <= cfg.simpleThresholdWords) {
      reason = 'Short and simple input';
    } else {
      // 中等复杂度：默认使用强模型（保守策略）
      needsStrongModel = true;
      reason = 'Medium complexity, using strong model for reliability';
    }
  }

  const confidence = calculateConfidence(
    charCount,
    wordCount,
    hasStrongKeywords,
    hasSimpleKeywords,
    historyComplexity
  );

  return {
    recommendedModel: needsStrongModel ? cfg.strongModel : cfg.cheapModel,
    needsStrongModel,
    reason,
    confidence,
  };
}

/**
 * 快速路由决策
 */
export function quickRoute(input: string, config?: SmartRoutingConfig): string {
  const cfg = config || DEFAULT_CONFIG;

  const charCount = input.length;
  const lowerInput = input.toLowerCase();
  const hasStrongKeywords = cfg.strongKeywords.some(kw => lowerInput.includes(kw));

  if (hasStrongKeywords || charCount > cfg.simpleThresholdChars * 2) {
    return cfg.strongModel;
  }

  return cfg.cheapModel;
}

// ============================================================================
// 内部辅助
// ============================================================================

function analyzeHistoryComplexity(messages: Message[]): number {
  if (messages.length < 3) return 0;

  // 统计工具调用次数
  const toolCallCount = messages
    .filter(m => m.role === 'assistant')
    .reduce((sum, m) => sum + (m.tool_calls?.length || 0), 0);

  // 统计消息长度
  const avgLength = messages
    .filter(m => m.content)
    .reduce((sum, m) => sum + (m.content?.length || 0), 0) / messages.length;

  // 复杂度评分
  const score = Math.min(
    (toolCallCount / 10) * 0.5 + (avgLength / 500) * 0.5,
    1
  );

  return score;
}

function calculateConfidence(
  chars: number,
  words: number,
  hasStrong: boolean,
  hasSimple: boolean,
  historyComplexity: number
): number {
  // 简单情况下置信度高
  if (hasStrong && !hasSimple) return 0.9;
  if (hasSimple && chars < 50) return 0.85;

  // 中间情况置信度中等
  if (chars > 200 || words > 30) return 0.7;

  // 基于历史复杂度
  return 0.6 + historyComplexity * 0.3;
}

// ============================================================================
// 导出
// ============================================================================

export { DEFAULT_CONFIG as DEFAULT_ROUTING_CONFIG };