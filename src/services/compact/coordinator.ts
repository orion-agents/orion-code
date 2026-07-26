import type { ContextCapsule, HarnessState } from '../../harness';
import type { LLMService, Message } from '../llm';
import { AutoCompact, type AutoCompactConfig } from './auto-compact';
import { compactMessages, type CompactResult } from './compact';

export interface CompactCoordinatorConfig {
  modelId: string;
  llm?: LLMService | null;
  outputReserveTokens?: number;
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

  async compactManual(messages: Message[], maxMessages: number): Promise<CompactResult> {
    return compactMessages(messages, {
      maxMessages,
      contextCapsule: this.config.getContextCapsule?.() ?? undefined,
      harnessState: this.config.getHarnessState?.() ?? undefined,
      llm: this.config.llm ?? undefined,
      compactMode: 'manual',
    });
  }

  private toAutoConfig(config: CompactCoordinatorConfig): AutoCompactConfig {
    return {
      modelId: config.modelId,
      llm: config.llm,
      outputReserveTokens: config.outputReserveTokens,
      maxMessages: 20,
      getContextCapsule: config.getContextCapsule,
      getHarnessState: config.getHarnessState,
    };
  }
}
