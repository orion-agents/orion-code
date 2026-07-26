/**
 * orion code - 成本追踪模块
 *
 * 记录 token 使用量，计算成本，支持预算检查。
 * 按 Agent、任务、模型、时间维度统计。
 */

// ============================================================================
// 类型定义
// ============================================================================

/** 使用记录 */
export type CostSource = 'provider' | 'configured' | 'builtin' | 'fallback';

export interface ModelPricing {
  /** USD per one million input tokens. */
  input: number;
  /** USD per one million output tokens. */
  output: number;
  /** USD per one million cached input tokens. Defaults to input pricing. */
  cachedInput?: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number;
  /** Provider-reported billed cost in USD. */
  costUsd?: number;
  /** Stable provider request id used to suppress duplicate accounting. */
  requestId?: string;
}

export interface UsageRecord {
  timestamp: Date;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens: number;
  /** Cost used for accounting, in USD. */
  costUsd: number;
  costSource: CostSource;
  /** @deprecated Use costUsd. Kept for API compatibility. */
  estimatedCost: number; // USD
  requestId?: string;
  requestKind?: string;
  agentId?: string;
  taskId?: string;
}

/** 统计结果 */
export interface CostStats {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCost: number;
  providerCost: number;
  estimatedCost: number;
  recordCount: number;
  bySource: Record<CostSource, { cost: number; count: number }>;
  byAgent: Record<string, { tokens: number; cost: number; count: number }>;
  byTask: Record<string, { tokens: number; cost: number; count: number }>;
  byModel: Record<string, { tokens: number; cost: number; count: number }>;
}

/** 时间范围 */
export interface TimeRange {
  start: Date;
  end: Date;
}

// ============================================================================
// 模型定价表（每 1M tokens，USD）
// ============================================================================

const MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenAI
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },

  // Anthropic Claude
  'claude-opus-4-7': { input: 15, output: 75 },
  'claude-opus-4-8': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 0.8, output: 4 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4 },

  // Alibaba Qwen
  'qwen3.7-plus': { input: 0.5, output: 2 },
  'qwen3.6-plus': { input: 0.5, output: 2 },
  'qwen3.5-plus': { input: 0.5, output: 2 },
  'qwen3.5-turbo': { input: 0.3, output: 1 },
  'qwen3-max-2026-01-23': { input: 2, output: 6 },
  'qwen3-coder-plus': { input: 0.5, output: 2 },
  'qwen3-coder-next': { input: 0.5, output: 2 },
  'qwen-max': { input: 2, output: 6 },

  // Google Gemini
  'gemini-1.5-pro': { input: 1.25, output: 5 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },

  // DeepSeek
  'deepseek-chat': { input: 0.14, output: 0.28 },
  'deepseek-coder': { input: 0.14, output: 0.28 },

  // GLM
  'glm-4': { input: 0.1, output: 0.1 },
  'glm-4.7': { input: 0.1, output: 0.1 },
  'glm-5': { input: 0.1, output: 0.1 },

  // Bailian routed providers
  'kimi-k2.5': { input: 0.5, output: 2 },
  'MiniMax-M2.5': { input: 0.5, output: 2 },
  'minimax-m2.5': { input: 0.5, output: 2 },
};

/** 默认定价（未知模型） */
const DEFAULT_PRICING = { input: 1, output: 5 };

export interface CostTrackerOptions {
  pricing?: Record<string, ModelPricing>;
  defaultPricing?: ModelPricing;
  onRecord?: (record: UsageRecord) => void;
}

// ============================================================================
// CostTracker 类
// ============================================================================

export class CostTracker {
  private records: UsageRecord[] = [];
  private recordsByRequestId = new Map<string, UsageRecord>();
  private budgetLimit: number | null = null;
  private sessionStartTime: Date;
  private pricing: Record<string, ModelPricing>;
  private defaultPricing: ModelPricing;
  private onRecord?: (record: UsageRecord) => void;

  constructor(options: CostTrackerOptions = {}) {
    this.sessionStartTime = new Date();
    this.pricing = { ...(options.pricing ?? {}) };
    this.defaultPricing = options.defaultPricing ?? DEFAULT_PRICING;
    this.onRecord = options.onRecord;
  }

  /**
   * 记录使用量
   */
  record(
    usage: TokenUsage,
    meta: {
      model: string;
      agentId?: string;
      taskId?: string;
      requestKind?: string;
    },
  ): UsageRecord {
    if (usage.requestId) {
      const existing = this.recordsByRequestId.get(usage.requestId);
      if (existing) return existing;
    }

    const promptTokens = normalizeTokenCount(usage.promptTokens);
    const completionTokens = normalizeTokenCount(usage.completionTokens);
    const cachedPromptTokens = Math.min(
      promptTokens,
      normalizeTokenCount(usage.cachedPromptTokens ?? 0),
    );
    const totalTokens = promptTokens + completionTokens;
    const providerCost = normalizeProviderCost(usage.costUsd);
    const configuredPricing = this.pricing[meta.model];
    const builtinPricing = MODEL_PRICING[meta.model];
    const pricing = configuredPricing ?? builtinPricing ?? this.defaultPricing;
    const costSource: CostSource = providerCost !== undefined
      ? 'provider'
      : configuredPricing
        ? 'configured'
        : builtinPricing
          ? 'builtin'
          : 'fallback';
    const nonCachedPromptTokens = promptTokens - cachedPromptTokens;
    const costUsd = providerCost ?? (
      nonCachedPromptTokens * pricing.input
      + cachedPromptTokens * (pricing.cachedInput ?? pricing.input)
      + completionTokens * pricing.output
    ) / 1_000_000;

    const record: UsageRecord = {
      timestamp: new Date(),
      model: meta.model,
      promptTokens,
      completionTokens,
      totalTokens,
      cachedPromptTokens,
      costUsd,
      costSource,
      estimatedCost: costUsd,
      requestId: usage.requestId,
      requestKind: meta.requestKind,
      agentId: meta.agentId,
      taskId: meta.taskId,
    };

    this.records.push(record);
    if (record.requestId) this.recordsByRequestId.set(record.requestId, record);
    try {
      this.onRecord?.(record);
    } catch {
      // Accounting persistence must not fail an otherwise successful model call.
    }
    return record;
  }

  /** Configure the durable sink after runtime/session bootstrap. */
  setRecordSink(onRecord?: (record: UsageRecord) => void): void {
    this.onRecord = onRecord;
  }

  /**
   * 获取统计
   */
  getStats(timeRange?: TimeRange): CostStats {
    let filtered = this.records;

    if (timeRange) {
      filtered = filtered.filter(
        r => r.timestamp >= timeRange.start && r.timestamp <= timeRange.end,
      );
    }

    const stats: CostStats = {
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      providerCost: 0,
      estimatedCost: 0,
      recordCount: filtered.length,
      bySource: {
        provider: { cost: 0, count: 0 },
        configured: { cost: 0, count: 0 },
        builtin: { cost: 0, count: 0 },
        fallback: { cost: 0, count: 0 },
      },
      byAgent: {},
      byTask: {},
      byModel: {},
    };

    for (const record of filtered) {
      stats.totalPromptTokens += record.promptTokens;
      stats.totalCompletionTokens += record.completionTokens;
      stats.totalTokens += record.totalTokens;
      stats.totalCost += record.costUsd;
      if (record.costSource === 'provider') stats.providerCost += record.costUsd;
      else stats.estimatedCost += record.costUsd;
      stats.bySource[record.costSource].cost += record.costUsd;
      stats.bySource[record.costSource].count++;

      // 按 Agent 统计
      if (record.agentId) {
        if (!stats.byAgent[record.agentId]) {
          stats.byAgent[record.agentId] = { tokens: 0, cost: 0, count: 0 };
        }
        stats.byAgent[record.agentId].tokens += record.totalTokens;
        stats.byAgent[record.agentId].cost += record.costUsd;
        stats.byAgent[record.agentId].count++;
      }

      // 按任务统计
      if (record.taskId) {
        if (!stats.byTask[record.taskId]) {
          stats.byTask[record.taskId] = { tokens: 0, cost: 0, count: 0 };
        }
        stats.byTask[record.taskId].tokens += record.totalTokens;
        stats.byTask[record.taskId].cost += record.costUsd;
        stats.byTask[record.taskId].count++;
      }

      // 按模型统计
      if (!stats.byModel[record.model]) {
        stats.byModel[record.model] = { tokens: 0, cost: 0, count: 0 };
      }
      stats.byModel[record.model].tokens += record.totalTokens;
      stats.byModel[record.model].cost += record.costUsd;
      stats.byModel[record.model].count++;
    }

    return stats;
  }

  /**
   * 获取本次会话统计
   */
  getSessionStats(): CostStats {
    return this.getStats({ start: this.sessionStartTime, end: new Date() });
  }

  /**
   * 检查预算
   */
  checkBudget(): { ok: boolean; remaining: number; used: number } {
    if (this.budgetLimit === null) {
      return { ok: true, remaining: Infinity, used: 0 };
    }
    const stats = this.getSessionStats();
    const used = stats.totalCost;
    const remaining = this.budgetLimit - used;
    return { ok: used < this.budgetLimit, remaining, used };
  }

  /**
   * 设置预算限制
   */
  setBudget(limit: number): void {
    this.budgetLimit = limit;
  }

  /**
   * 获取预算限制
   */
  getBudget(): number | null {
    return this.budgetLimit;
  }

  /**
   * 清空记录
   */
  clear(): void {
    this.records = [];
    this.recordsByRequestId.clear();
    this.sessionStartTime = new Date();
  }

  /**
   * 获取所有记录
   */
  getRecords(): UsageRecord[] {
    return [...this.records];
  }

  /**
   * 获取最后一条记录
   */
  getLastRecord(): UsageRecord | undefined {
    return this.records[this.records.length - 1];
  }

  /**
   * 格式化成本显示
   */
  formatCost(cost: number): string {
    if (cost < 0.01) {
      return `$${cost.toFixed(6)}`;
    }
    if (cost < 1) {
      return `$${cost.toFixed(4)}`;
    }
    return `$${cost.toFixed(2)}`;
  }

  /**
   * 格式化统计摘要
   */
  formatSummary(stats: CostStats): string {
    const lines: string[] = [];
    lines.push(`Total: ${stats.totalTokens} tokens, ${this.formatCost(stats.totalCost)}`);
    lines.push(`  Prompt: ${stats.totalPromptTokens}, Completion: ${stats.totalCompletionTokens}`);
    lines.push(`  Records: ${stats.recordCount}`);

    if (Object.keys(stats.byModel).length > 0) {
      lines.push('\nBy Model:');
      for (const [model, data] of Object.entries(stats.byModel)) {
        lines.push(`  ${model}: ${data.tokens} tokens, ${this.formatCost(data.cost)}`);
      }
    }

    return lines.join('\n');
  }
}

function normalizeTokenCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeProviderCost(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
