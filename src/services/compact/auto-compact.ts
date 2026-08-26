/**
 * orion code - 自动压缩触发器
 *
 * 监控对话 token 使用量，当上下文达到模型限制的 95% 时自动触发压缩。
 * 每个模型自动感知其上下文窗口大小。
 */

import type { Message } from '../llm';
import type { LLMService } from '../llm';
import {
  CompactCandidateValidationError,
  compactMessages,
  type CompactValidationError,
} from './compact';
import {
  resolveModelContext,
  resolveContextBudget,
  AUTO_COMPACT_THRESHOLD,
} from '../model-context';
import type { CompactResult } from './compact';
import type { ContextCapsule, HarnessState } from '../../harness';
import { estimateMessagesTokens } from '../../utils/token-estimate';
import { canonicalMessagesFingerprint } from './fingerprint';
import { DEFAULT_COMPACT_TARGET_RATIO } from './planner';

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
  /** Required post-compact fraction of the safe input budget (default 0.65). */
  targetRatio?: number;
  /** Consecutive duplicate/rejected attempts allowed before pausing (default 2). */
  maxConsecutiveNoProgressAttempts?: number;
  /** Project-level summary guidance; validated semantic invariants take precedence. */
  compactInstructions?: string;
}

export type CompactPauseCode =
  | 'no_headroom'
  | 'context_thrash'
  | 'candidate_invalid'
  | 'mandatory_context_over_budget';

export interface CompactPauseFailure {
  code: CompactPauseCode;
  message: string;
  mode: 'predictive' | 'threshold';
  fingerprint: string;
  consecutiveNoProgressAttempts: number;
  beforeTokens: number;
  afterTokens?: number;
  safeInputBudget: number;
  targetTokens: number;
  validationErrors?: CompactValidationError[];
}

export type CompactPostValidation =
  | { valid: true; observedTokens: number; targetTokens: number }
  | {
      valid: false;
      code: 'no_headroom' | 'candidate_invalid';
      message: string;
      observedTokens: number;
      targetTokens: number;
    };

export type CompactPostValidator = (result: CompactResult) => CompactPostValidation;

function normalizeTargetRatio(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_COMPACT_TARGET_RATIO;
  return Math.max(
    0.1,
    Math.min(DEFAULT_COMPACT_TARGET_RATIO, value ?? DEFAULT_COMPACT_TARGET_RATIO)
  );
}

interface AutoCompactAttemptBase {
  messages: Message[];
  mode: 'predictive' | 'threshold';
  fingerprint: string;
  consecutiveNoProgressAttempts: number;
}

export type AutoCompactAttempt =
  | (AutoCompactAttemptBase & {
      status: 'not_needed';
      reason: 'disabled' | 'below_threshold';
    })
  | (AutoCompactAttemptBase & { status: 'compacted'; result: CompactResult })
  | (AutoCompactAttemptBase & { status: 'duplicate'; reason: 'unchanged_history' })
  | (AutoCompactAttemptBase & { status: 'rejected'; reason: 'no_token_reduction' })
  | (AutoCompactAttemptBase & { status: 'paused'; failure: CompactPauseFailure });

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
      | 'targetRatio'
      | 'maxConsecutiveNoProgressAttempts'
    >
  > & {
    onCompact?: AutoCompactConfig['onCompact'];
    getContextCapsule?: AutoCompactConfig['getContextCapsule'];
    getHarnessState?: AutoCompactConfig['getHarnessState'];
    compactInstructions?: string;
    llm?: LLMService;
  };
  private lastCompactTime: number = 0;
  private compactCount: number = 0;
  /** 最后一次计算的 token 使用量 */
  private lastTokenCount: number = 0;
  private lastCtxPercent: number = 0;
  private preCompactArmed: boolean = false;
  private lastCompactFingerprint: string | null = null;
  private lastRejectedFingerprint: string | null = null;
  private lastCompactMode: 'predictive' | 'threshold' | 'manual' | null = null;
  private lastCompactResult: CompactResult | null = null;
  private consecutiveNoProgressAttempts = 0;
  private duplicateAttemptCount = 0;
  private rejectedAttemptCount = 0;
  private lastPauseFailure: CompactPauseFailure | null = null;
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
      targetRatio: normalizeTargetRatio(config?.targetRatio),
      maxConsecutiveNoProgressAttempts: Math.max(
        1,
        Math.floor(config?.maxConsecutiveNoProgressAttempts ?? 2)
      ),
      onCompact: config?.onCompact,
      getContextCapsule: config?.getContextCapsule,
      getHarnessState: config?.getHarnessState,
      compactInstructions: config?.compactInstructions,
      llm: config?.llm ?? undefined,
    };
  }

  /**
   * 更新配置。AutoCompact 是单例，query loop 每轮可能需要刷新 model
   * 和 capsule provider。
   */
  configure(config?: AutoCompactConfig): void {
    if (!config) return;
    const policyChanged =
      (config.modelId !== undefined && config.modelId !== this.config.modelId) ||
      (config.maxMessages !== undefined && config.maxMessages !== this.config.maxMessages) ||
      (config.outputReserveTokens !== undefined &&
        config.outputReserveTokens !== this.config.outputReserveTokens) ||
      (config.targetRatio !== undefined &&
        normalizeTargetRatio(config.targetRatio) !== this.config.targetRatio) ||
      ('compactInstructions' in config &&
        config.compactInstructions !== this.config.compactInstructions) ||
      (config.enabled !== undefined && config.enabled !== this.config.enabled);
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
    if (config.targetRatio !== undefined) {
      this.config.targetRatio = normalizeTargetRatio(config.targetRatio);
    }
    if (config.maxConsecutiveNoProgressAttempts !== undefined) {
      this.config.maxConsecutiveNoProgressAttempts = Math.max(
        1,
        Math.floor(config.maxConsecutiveNoProgressAttempts)
      );
    }
    if (config.onCompact !== undefined) this.config.onCompact = config.onCompact;
    if (config.getContextCapsule !== undefined)
      this.config.getContextCapsule = config.getContextCapsule;
    if (config.getHarnessState !== undefined) this.config.getHarnessState = config.getHarnessState;
    if ('compactInstructions' in config) {
      this.config.compactInstructions = config.compactInstructions;
    }
    if ('llm' in config) this.config.llm = config.llm ?? undefined;
    if (policyChanged) this.resetAttemptPolicyState();
  }

  /**
   * 更新模型（切换模型时调用）
   */
  setModel(modelId: string): void {
    if (modelId !== this.config.modelId) {
      this.resetProviderCalibration();
      this.resetAttemptPolicyState();
    }
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
    return (await this.checkAndCompactOutcome(messages, usedTokens)).messages;
  }

  async checkAndCompactOutcome(
    messages: Message[],
    usedTokens?: number,
    postValidate?: CompactPostValidator
  ): Promise<AutoCompactAttempt> {
    return this.compactIfNeeded(
      messages,
      usedTokens,
      this.config.threshold,
      'threshold',
      postValidate
    );
  }

  /**
   * Finalize an already-triggered compact before persistence. Once a request
   * has a pending candidate, the final history must still meet the 65% target;
   * waiting until the normal 95% trigger would produce an invalid checkpoint.
   */
  async ensureHeadroomAndCompactOutcome(
    messages: Message[],
    usedTokens?: number,
    postValidate?: CompactPostValidator
  ): Promise<AutoCompactAttempt> {
    return this.compactIfNeeded(
      messages,
      usedTokens,
      this.config.targetRatio,
      'threshold',
      postValidate
    );
  }

  /**
   * LLM 调用前的预测压缩。用于避免下一次请求已经接近模型上下文上限。
   */
  async checkPredictiveAndCompact(
    messages: Message[],
    predictedTokens?: number
  ): Promise<Message[]> {
    return (await this.checkPredictiveCompactOutcome(messages, predictedTokens)).messages;
  }

  async checkPredictiveCompactOutcome(
    messages: Message[],
    predictedTokens?: number,
    postValidate?: CompactPostValidator
  ): Promise<AutoCompactAttempt> {
    return this.compactIfNeeded(
      messages,
      predictedTokens,
      this.config.predictiveCompactThreshold,
      'predictive',
      postValidate
    );
  }

  private async compactIfNeeded(
    messages: Message[],
    usedTokens: number | undefined,
    threshold: number,
    mode: 'predictive' | 'threshold',
    postValidate?: CompactPostValidator
  ): Promise<AutoCompactAttempt> {
    const beforeTokens = estimateMessagesTokens(messages);
    const fingerprint = canonicalMessagesFingerprint(messages);
    if (!this.config.enabled) {
      return this.unchangedAttempt('not_needed', messages, mode, fingerprint, 'disabled');
    }

    const { percent: ctxPercent, ratio } = this.calculateContextUsage(usedTokens, messages);
    this.preCompactArmed = ratio >= this.config.preCompactThreshold;
    const shouldCompact = ratio >= threshold;
    const shouldCaptureSemanticAuthority = this.preCompactArmed || shouldCompact;
    const contextCapsule = shouldCaptureSemanticAuthority
      ? (this.config.getContextCapsule?.() ?? undefined)
      : undefined;
    const harnessState = shouldCaptureSemanticAuthority
      ? (this.config.getHarnessState?.() ?? undefined)
      : undefined;

    // 达到阈值才触发
    if (!shouldCompact) {
      this.resetNoProgressAttempts();
      return this.unchangedAttempt('not_needed', messages, mode, fingerprint, 'below_threshold');
    }

    if (this.lastPauseFailure?.fingerprint === fingerprint) {
      return this.pausedAttempt(messages, mode, this.lastPauseFailure);
    }
    if (this.lastPauseFailure && this.lastPauseFailure.fingerprint !== fingerprint) {
      this.resetNoProgressAttempts();
      this.lastRejectedFingerprint = null;
    }

    // The canonical output of a successful or rejected attempt cannot produce
    // new headroom until the durable history changes. Count it deterministically
    // instead of repeatedly spending summary/provider calls behind a time window.
    if (
      fingerprint === this.lastCompactFingerprint ||
      fingerprint === this.lastRejectedFingerprint
    ) {
      this.duplicateAttemptCount++;
      return this.recordNoProgress(
        'duplicate',
        messages,
        mode,
        fingerprint,
        beforeTokens,
        'The same compact history reached the trigger again without new durable context.'
      );
    }

    let result: CompactResult;
    try {
      result = await compactMessages(messages, {
        maxMessages: this.config.maxMessages,
        summaryOptions: { instructions: this.config.compactInstructions },
        contextCapsule,
        harnessState,
        llm: this.config.llm,
        compactMode: 'auto_pre_turn',
        safeInputBudget: this.getPlannerSafeInputBudget(),
        targetRatio: this.config.targetRatio,
      });
    } catch (error) {
      if (!(error instanceof CompactCandidateValidationError)) throw error;
      this.rejectedAttemptCount++;
      this.consecutiveNoProgressAttempts++;
      this.lastRejectedFingerprint = fingerprint;
      const headroom = error.validation.errors.some(
        validationError => validationError.code === 'target_headroom_exceeded'
      );
      const failure = this.createPauseFailure({
        code: headroom ? 'no_headroom' : 'candidate_invalid',
        message: error.message,
        mode,
        fingerprint,
        beforeTokens,
        validationErrors: error.validation.errors,
      });
      this.lastPauseFailure = failure;
      return this.pausedAttempt(messages, mode, failure);
    }

    const postValidation = postValidate?.(result);
    if (postValidation && !postValidation.valid) {
      this.rejectedAttemptCount++;
      this.consecutiveNoProgressAttempts++;
      this.lastRejectedFingerprint = fingerprint;
      const failure = this.createPauseFailure({
        code: postValidation.code,
        message: postValidation.message,
        mode,
        fingerprint,
        beforeTokens,
        afterTokens: postValidation.observedTokens,
      });
      this.lastPauseFailure = failure;
      return this.pausedAttempt(messages, mode, failure);
    }

    // Automatic compaction must strictly reduce the model-visible prompt.
    // Otherwise a summary/capsule can grow the context and re-trigger forever.
    const originalTokens = estimateMessagesTokens(messages);
    const compactedTokens = estimateMessagesTokens(result.messages);
    if (compactedTokens >= originalTokens) {
      this.rejectedAttemptCount++;
      this.lastRejectedFingerprint = fingerprint;
      return this.recordNoProgress(
        'rejected',
        messages,
        mode,
        fingerprint,
        beforeTokens,
        `Compact did not reduce estimated tokens (${originalTokens} -> ${compactedTokens}).`
      );
    }

    // 更新状态
    this.lastCompactTime = Date.now();
    this.compactCount++;
    this.lastCompactFingerprint = canonicalMessagesFingerprint(result.messages);
    this.lastRejectedFingerprint = null;
    this.resetNoProgressAttempts();
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

    return {
      status: 'compacted',
      messages: result.messages,
      mode,
      fingerprint,
      consecutiveNoProgressAttempts: 0,
      result,
    };
  }

  private unchangedAttempt(
    status: 'not_needed',
    messages: Message[],
    mode: 'predictive' | 'threshold',
    fingerprint: string,
    reason: 'disabled' | 'below_threshold'
  ): AutoCompactAttempt {
    return {
      status,
      messages,
      mode,
      fingerprint,
      consecutiveNoProgressAttempts: this.consecutiveNoProgressAttempts,
      reason,
    };
  }

  private recordNoProgress(
    status: 'duplicate' | 'rejected',
    messages: Message[],
    mode: 'predictive' | 'threshold',
    fingerprint: string,
    beforeTokens: number,
    detail: string
  ): AutoCompactAttempt {
    this.consecutiveNoProgressAttempts++;
    if (this.consecutiveNoProgressAttempts >= this.config.maxConsecutiveNoProgressAttempts) {
      const failure = this.createPauseFailure({
        code: 'context_thrash',
        message: `${detail} Compact paused after ${this.consecutiveNoProgressAttempts} consecutive no-progress attempts.`,
        mode,
        fingerprint,
        beforeTokens,
      });
      this.lastPauseFailure = failure;
      return this.pausedAttempt(messages, mode, failure);
    }
    const base = {
      messages,
      mode,
      fingerprint,
      consecutiveNoProgressAttempts: this.consecutiveNoProgressAttempts,
    };
    return status === 'duplicate'
      ? { ...base, status, reason: 'unchanged_history' }
      : { ...base, status, reason: 'no_token_reduction' };
  }

  private createPauseFailure(input: {
    code: CompactPauseCode;
    message: string;
    mode: 'predictive' | 'threshold';
    fingerprint: string;
    beforeTokens: number;
    afterTokens?: number;
    validationErrors?: CompactValidationError[];
  }): CompactPauseFailure {
    const safeInputBudget = this.getSafeInputBudget();
    return {
      ...input,
      consecutiveNoProgressAttempts: this.consecutiveNoProgressAttempts,
      safeInputBudget,
      targetTokens: Math.max(1, Math.floor(safeInputBudget * this.config.targetRatio)),
      validationErrors: input.validationErrors?.map(error => ({ ...error })),
    };
  }

  private pausedAttempt(
    messages: Message[],
    mode: 'predictive' | 'threshold',
    failure: CompactPauseFailure
  ): AutoCompactAttempt {
    return {
      status: 'paused',
      messages,
      mode,
      fingerprint: failure.fingerprint,
      consecutiveNoProgressAttempts: failure.consecutiveNoProgressAttempts,
      failure: {
        ...failure,
        validationErrors: failure.validationErrors?.map(error => ({ ...error })),
      },
    };
  }

  private resetNoProgressAttempts(): void {
    this.consecutiveNoProgressAttempts = 0;
    this.lastPauseFailure = null;
  }

  private resetAttemptPolicyState(): void {
    this.lastCompactFingerprint = null;
    this.lastRejectedFingerprint = null;
    this.resetNoProgressAttempts();
  }

  private getSafeInputBudget(): number {
    return resolveContextBudget(this.config.modelId, this.config.outputReserveTokens)
      .safeInputBudget;
  }

  /** Translate provider-observed correction into the estimator budget. */
  private getPlannerSafeInputBudget(): number {
    const safeInputBudget = this.getSafeInputBudget();
    const targetTokens = Math.max(1, Math.floor(safeInputBudget * this.config.targetRatio));
    const estimatorTarget = Math.max(1, targetTokens - Math.max(0, this.providerCorrection));
    return Math.max(1, Math.floor(estimatorTarget / this.config.targetRatio));
  }

  /**
   * 计算上下文使用百分比
   */
  private calculateContextUsage(
    usedTokens?: number,
    messages?: Message[]
  ): { percent: number; ratio: number } {
    const contextWindow = this.getSafeInputBudget();
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
      summaryOptions: { instructions: this.config.compactInstructions },
      contextCapsule: this.config.getContextCapsule?.() ?? undefined,
      harnessState: this.config.getHarnessState?.() ?? undefined,
      llm: this.config.llm,
      compactMode: 'manual',
      safeInputBudget: this.getPlannerSafeInputBudget(),
      targetRatio: this.config.targetRatio,
    });

    this.compactCount++;
    this.lastCompactTime = Date.now();
    this.lastCompactFingerprint = canonicalMessagesFingerprint(result.messages);
    this.lastRejectedFingerprint = null;
    this.resetNoProgressAttempts();
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
    targetRatio: number;
    safeInputBudget: number;
    maxConsecutiveNoProgressAttempts: number;
    consecutiveNoProgressAttempts: number;
    duplicateAttemptCount: number;
    rejectedAttemptCount: number;
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
      targetRatio: this.config.targetRatio,
      safeInputBudget: this.getSafeInputBudget(),
      maxConsecutiveNoProgressAttempts: this.config.maxConsecutiveNoProgressAttempts,
      consecutiveNoProgressAttempts: this.consecutiveNoProgressAttempts,
      duplicateAttemptCount: this.duplicateAttemptCount,
      rejectedAttemptCount: this.rejectedAttemptCount,
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
