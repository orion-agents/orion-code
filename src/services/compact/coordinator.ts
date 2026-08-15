import type { ContextCapsule, HarnessState } from '../../harness';
import type { LLMService, Message } from '../llm';
import { resolveContextBudget } from '../model-context';
import { AutoCompact, type AutoCompactConfig } from './auto-compact';
import { compactMessages, type CompactResult } from './compact';
import { DEFAULT_COMPACT_TARGET_RATIO } from './planner';

export interface CompactCoordinatorConfig {
  modelId: string;
  llm?: LLMService | null;
  outputReserveTokens?: number;
  targetRatio?: number;
  maxConsecutiveNoProgressAttempts?: number;
  /** Project-level summary guidance; semantic invariants always take precedence. */
  compactInstructions?: string;
  getContextCapsule?: () => ContextCapsule | undefined | null;
  getHarnessState?: () => HarnessState | undefined | null;
}

/**
 * Owns compact policy and provider calibration for one runtime. Manual
 * compaction deliberately bypasses the automatic policy instance so a
 * `/compact N` command cannot change the automatic 20-message retention.
 */
export class CompactCoordinator {
  private readonly automatic: AutoCompact;
  private config: CompactCoordinatorConfig;

  constructor(config: CompactCoordinatorConfig) {
    this.config = { ...config };
    this.automatic = new AutoCompact(this.toAutoConfig(config));
  }

  configure(config: Partial<CompactCoordinatorConfig>): void {
    this.config = { ...this.config, ...config };
    this.automatic.configure(this.toAutoConfig(this.config));
  }

  getAutomatic(): AutoCompact {
    return this.automatic;
  }

  async compactManual(
    messages: Message[],
    maxMessages: number,
    focus?: string
  ): Promise<CompactResult> {
    return compactMessages(messages, {
      maxMessages,
      summaryOptions: { focus, instructions: this.config.compactInstructions },
      contextCapsule: this.config.getContextCapsule?.() ?? undefined,
      harnessState: this.config.getHarnessState?.() ?? undefined,
      llm: this.config.llm ?? undefined,
      compactMode: 'manual',
      safeInputBudget: resolveContextBudget(this.config.modelId, this.config.outputReserveTokens)
        .safeInputBudget,
      targetRatio: this.config.targetRatio ?? DEFAULT_COMPACT_TARGET_RATIO,
    });
  }

  private toAutoConfig(config: CompactCoordinatorConfig): AutoCompactConfig {
    return {
      modelId: config.modelId,
      llm: config.llm,
      outputReserveTokens: config.outputReserveTokens,
      targetRatio: config.targetRatio,
      maxConsecutiveNoProgressAttempts: config.maxConsecutiveNoProgressAttempts,
      compactInstructions: config.compactInstructions,
      maxMessages: 20,
      getContextCapsule: config.getContextCapsule,
      getHarnessState: config.getHarnessState,
    };
  }
}
