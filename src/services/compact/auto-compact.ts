/**
 * orion code - 自动压缩触发器
 *
 * 监控对话 token 使用量，当上下文达到模型限制的 95% 时自动触发压缩。
 * 每个模型自动感知其上下文窗口大小。
 */

import type { Message } from '../llm';
import type { LLMService } from '../llm';
import { compactMessages } from './compact';
import {
  resolveModelContext,
  resolveContextBudget,
  AUTO_COMPACT_THRESHOLD,
} from '../model-context';
import type { CompactResult } from './compact';
import type { ContextCapsule, HarnessState } from '../../harness';
import { estimateMessagesTokens } from '../../utils/token-estimate';

// ============================================================================
// 类型定义
// ============================================================================

export interface AutoCompactConfig {
  /** 触发阈值（0-1，默认 0.95 即 95%） */
  threshold?: number;
  /** 模型 ID（用于获取上下文窗口） */
  modelId?: string;
  /** 压缩后保留消息数 */
  maxMessages?: number;
  /** 是否启用自动压缩 */
  enabled?: boolean;
  /** 压缩回调（通知用户） */
  onCompact?: (result: {
    originalCount: number;
    compactedCount: number;
    ctxPercent: number;
    mode: 'predictive' | 'threshold' | 'manual';
  }) => void;
  /** 提前准备可恢复上下文的阈值（0-1，默认 0.8） */
  preCompactThreshold?: number;
  /** 预测触发阈值（0-1，默认 0.95），用于 LLM 调用前压缩 */
  predictiveCompactThreshold?: number;
  /** 获取最新 Context Capsule */
  getContextCapsule?: () => ContextCapsule | undefined | null;
  /** 获取最新完整 Harness State */
  getHarnessState?: () => HarnessState | undefined | null;
  /** Optional LLM service for high-quality compact summaries. */
  llm?: LLMService | null;
  /** Actual max completion tokens requested from the provider. */
  outputReserveTokens?: number;
}

// ============================================================================
// 自动压缩器
// ============================================================================

export class AutoCompact {
  private config: Required<
    Pick<
      AutoCompactConfig,
      | 'threshold'
      | 'modelId'
      | 'maxMessages'
      | 'enabled'
      | 'preCompactThreshold'
      | 'predictiveCompactThreshold'
      | 'outputReserveTokens'
    >
  > & {
    onCompact?: AutoCompactConfig['onCompact'];
    getContextCapsule?: AutoCompactConfig['getContextCapsule'];
    getHarnessState?: AutoCompactConfig['getHarnessState'];
    llm?: LLMService;
  };
  private lastCompactTime: number = 0;
  private compactCount: number = 0;
  /** 最后一次计算的 token 使用量 */
  private lastTokenCount: number = 0;
  private lastCtxPercent: number = 0;
  private preCompactArmed: boolean = false;
  private lastCompactFingerprint: string | null = null;
  private lastCompactMode: 'predictive' | 'threshold' | 'manual' | null = null;
  private lastCompactResult: CompactResult | null = null;
  private providerCorrection = 0;
  private calibrationModel: string | null = null;

  constructor(config?: AutoCompactConfig) {
    this.config = {
      threshold: config?.threshold ?? AUTO_COMPACT_THRESHOLD,
      modelId: config?.modelId ?? 'gpt-4o',
      maxMessages: config?.maxMessages ?? 20,
      enabled: config?.enabled ?? true,
      preCompactThreshold: config?.preCompactThreshold ?? 0.8,
      predictiveCompactThreshold: config?.predictiveCompactThreshold ?? AUTO_COMPACT_THRESHOLD,
      outputReserveTokens: config?.outputReserveTokens ?? 8192,
      onCompact: config?.onCompact,
      getContextCapsule: config?.getContextCapsule,
      getHarnessState: config?.getHarnessState,
      llm: config?.llm ?? undefined,
    };
  }

  /**
   * 更新配置。AutoCompact 是单例，query loop 每轮可能需要刷新 model
   * 和 capsule provider。
   */
  configure(config?: AutoCompactConfig): void {
    if (!config) return;
    if (config.threshold !== undefined) this.config.threshold = config.threshold;
    if (config.modelId !== undefined) this.setModel(config.modelId);
    if (config.maxMessages !== undefined) this.config.maxMessages = config.maxMessages;
    if (config.enabled !== undefined) this.config.enabled = config.enabled;
    if (config.preCompactThreshold !== undefined)
      this.config.preCompactThreshold = config.preCompactThreshold;
    if (config.predictiveCompactThreshold !== undefined)
      this.config.predictiveCompactThreshold = config.predictiveCompactThreshold;
    if (config.outputReserveTokens !== undefined)
      this.config.outputReserveTokens = config.outputReserveTokens;
    if (config.onCompact !== undefined) this.config.onCompact = config.onCompact;
    if (config.getContextCapsule !== undefined)
      this.config.getContextCapsule = config.getContextCapsule;
    if (config.getHarnessState !== undefined) this.config.getHarnessState = config.getHarnessState;
    if ('llm' in config) this.config.llm = config.llm ?? undefined;
  }

  /**
   * 更新模型（切换模型时调用）
   */
  setModel(modelId: string): void {
    if (modelId !== this.config.modelId) this.resetProviderCalibration();
    this.config.modelId = modelId;
  }

  adjustTokenEstimate(estimatedTokens: number, modelId: string = this.config.modelId): number {
    this.ensureCalibrationModel(modelId);
    return Math.max(0, Math.round(estimatedTokens + this.providerCorrection));
  }

  recordProviderUsage(
    estimatedPromptTokens: number,
    providerPromptTokens: number,
    modelId: string = this.config.modelId
  ): void {
    this.ensureCalibrationModel(modelId);
    if (!Number.isFinite(providerPromptTokens) || providerPromptTokens <= 0) return;
    this.providerCorrection = Math.round(providerPromptTokens - estimatedPromptTokens);
  }

  hasProviderCalibration(modelId: string = this.config.modelId): boolean {
    return this.calibrationModel === modelId && this.providerCorrection !== 0;
  }

  private ensureCalibrationModel(modelId: string): void {
    if (this.calibrationModel === modelId) return;
    this.calibrationModel = modelId;
    this.providerCorrection = 0;
  }

  private resetProviderCalibration(): void {
    this.calibrationModel = null;
    this.providerCorrection = 0;
  }

  /**
   * 检查并触发自动压缩（基于 token 百分比）
   * @param messages 当前对话消息列表
   * @param usedTokens 当前已使用的 token 数（来自 API usage 响应）
   */
  async checkAndCompact(messages: Message[], usedTokens?: number): Promise<Message[]> {
    return this.compactIfNeeded(messages, usedTokens, this.config.threshold, 'threshold');
  }

  /**
   * LLM 调用前的预测压缩。用于避免下一次请求已经接近模型上下文上限。
   */
  async checkPredictiveAndCompact(
    messages: Message[],
    predictedTokens?: number
  ): Promise<Message[]> {
    return this.compactIfNeeded(
      messages,
      predictedTokens,
      this.config.predictiveCompactThreshold,
      'predictive'
    );
  }

  private async compactIfNeeded(
    messages: Message[],
    usedTokens: number | undefined,
    threshold: number,
    mode: 'predictive' | 'threshold'
  ): Promise<Message[]> {
    if (!this.config.enabled) {
      return messages;
    }

    const { percent: ctxPercent, ratio } = this.calculateContextUsage(usedTokens, messages);
    this.preCompactArmed = ratio >= this.config.preCompactThreshold;
    const contextCapsule = this.preCompactArmed
      ? (this.config.getContextCapsule?.() ?? undefined)
      : undefined;
    const harnessState = this.preCompactArmed
      ? (this.config.getHarnessState?.() ?? undefined)
      : undefined;

    // 达到阈值才触发
    if (ratio < threshold) {
      return messages;
    }

    // Do not compact the exact same post-compact history repeatedly. A changed
    // history must still be eligible immediately because a single tool result
    // can push context back over 95% within seconds.
    const now = Date.now();
    const fingerprint = this.getMessagesFingerprint(messages);
    if (fingerprint === this.lastCompactFingerprint && now - this.lastCompactTime < 30000) {
      return messages;
    }

    // 执行压缩
    const result = await compactMessages(messages, {
      maxMessages: this.config.maxMessages,
      contextCapsule,
      harnessState,
      llm: this.config.llm,
      compactMode: 'auto_pre_turn',
    });

    // 更新状态
    this.lastCompactTime = now;
    this.compactCount++;
    this.lastCompactFingerprint = this.getMessagesFingerprint(result.messages);
    this.lastCompactMode = mode;
    this.lastCompactResult = result;

    // 通知回调
    if (this.config.onCompact) {
      this.config.onCompact({
        originalCount: result.originalCount,
        compactedCount: result.compactedCount,
        ctxPercent,
        mode,
      });
    }

    return result.messages;
  }

  private getMessagesFingerprint(messages: Message[]): string {
    const first = messages[0];
    const last = messages[messages.length - 1];
    const totalChars = messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0);
    return [
      messages.length,
      totalChars,
      first ? `${first.role}:${first.content?.length ?? 0}` : 'none',
      last ? `${last.role}:${last.content?.length ?? 0}` : 'none',
    ].join(':');
  }

  /**
   * 计算上下文使用百分比
   */
  private calculateContextUsage(
    usedTokens?: number,
    messages?: Message[]
  ): { percent: number; ratio: number } {
    const contextWindow = resolveContextBudget(
      this.config.modelId,
      this.config.outputReserveTokens
    ).safeInputBudget;
    const tokenCount =
      usedTokens !== undefined ? usedTokens : messages ? estimateMessagesTokens(messages) : 0;
    const normalizedTokens = Number.isFinite(tokenCount) ? Math.max(0, tokenCount) : 0;
    const ratio = normalizedTokens / contextWindow;
    this.lastTokenCount = normalizedTokens;
    this.lastCtxPercent = Math.min(100, Math.floor(ratio * 100));
    return { percent: this.lastCtxPercent, ratio };
  }

  /**
   * 获取当前上下文百分比
   */
  getCtxPercent(usedTokens?: number, messages?: Message[]): number {
    return this.calculateContextUsage(usedTokens, messages).percent;
  }

  /**
   * 强制压缩
   */
  async forceCompact(messages: Message[]): Promise<Message[]> {
    const result = await compactMessages(messages, {
      maxMessages: this.config.maxMessages,
      contextCapsule: this.config.getContextCapsule?.() ?? undefined,
      harnessState: this.config.getHarnessState?.() ?? undefined,
      llm: this.config.llm,
      compactMode: 'manual',
    });

    this.compactCount++;
    this.lastCompactTime = Date.now();
    this.lastCompactFingerprint = this.getMessagesFingerprint(result.messages);
    this.lastCompactMode = 'manual';
    this.lastCompactResult = result;

    if (this.config.onCompact) {
      this.config.onCompact({
        originalCount: result.originalCount,
        compactedCount: result.compactedCount,
        ctxPercent: this.getCtxPercent(),
        mode: 'manual',
      });
    }

    return result.messages;
  }

  /**
   * 获取压缩统计
   */
  getStats(): {
    compactCount: number;
    lastCompactTime: number;
    threshold: number;
    preCompactThreshold: number;
    predictiveCompactThreshold: number;
    enabled: boolean;
    modelId: string;
    contextWindow: number;
    maxOutputTokens?: number;
    ctxPercent: number;
    lastTokenCount: number;
    preCompactArmed: boolean;
    lastCompactMode: 'predictive' | 'threshold' | 'manual' | null;
    outputReserveTokens: number;
  } {
    const model = resolveModelContext(this.config.modelId);
    return {
      compactCount: this.compactCount,
      lastCompactTime: this.lastCompactTime,
      threshold: this.config.threshold,
      preCompactThreshold: this.config.preCompactThreshold,
      predictiveCompactThreshold: this.config.predictiveCompactThreshold,
      enabled: this.config.enabled,
      modelId: this.config.modelId,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      ctxPercent: this.lastCtxPercent,
      lastTokenCount: this.lastTokenCount,
      preCompactArmed: this.preCompactArmed,
      lastCompactMode: this.lastCompactMode,
      outputReserveTokens: this.config.outputReserveTokens,
    };
  }

  getLastCompactResult(): CompactResult | null {
    return this.lastCompactResult;
  }

  /**
   * 启用/禁用自动压缩
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }
}

// ============================================================================
// 单例
// ============================================================================

let autoCompactInstance: AutoCompact | null = null;

export function getAutoCompact(config?: AutoCompactConfig): AutoCompact {
  if (!autoCompactInstance) {
    autoCompactInstance = new AutoCompact(config);
  } else if (config) {
    autoCompactInstance.configure(config);
  }
  return autoCompactInstance;
}

export function resetAutoCompact(): void {
  autoCompactInstance = null;
}
