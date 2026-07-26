import type { LLMResponse, Message } from '../services/llm';
import { buildHarnessContext, type PromptAssemblyOptions } from './assembler';
import { createContextCapsule } from './capsule';
import { createTaskContract, updateTaskContract } from './contract';
import { checkToolDrift, evaluateCompletionGate } from './drift-guard';
import { buildEvidenceIndex, bumpIncludedEvidence } from './evidence';
import { classifyIntent, shouldReplaceActiveInstruction } from './intent';
import { ContextLedger } from './ledger';
import { upgradeHarnessState } from './state';
import { createTurnSummary, type CreateTurnSummaryInput } from './turn-summary';
import type {
  CompletionGateResult,
  ContextCapsule,
  DriftCheckResult,
  EvidenceRecord,
  HarnessConfig,
  HarnessState,
  IntentUpdate,
  PromptAssemblyStats,
  TurnSummary,
} from './types';

const DEFAULT_CONFIG: Required<Pick<HarnessConfig, 'enabled' | 'preCompactThreshold' | 'compactThreshold' | 'maxRecentTurns' | 'evidenceBudgetRatio' | 'driftGuard'>> & {
  completionGate: HarnessConfig['completionGate'];
} = {
  enabled: true,
  preCompactThreshold: 0.8,
  compactThreshold: 0.95,
  maxRecentTurns: 8,
  evidenceBudgetRatio: 0.3,
  driftGuard: 'warn',
  completionGate: 'warn',
};

export interface ContextHarnessOptions {
  cwd: string;
  modelId: string;
  state?: HarnessState;
  config?: HarnessConfig;
}

export class ContextHarness {
  private readonly cwd: string;
  private readonly modelId: string;
  private readonly config: HarnessConfig;
  private contract: HarnessState['contract'];
  private ledger: ContextLedger;
  private capsule?: ContextCapsule;
  private completionBlockCount: number;
  private taskEpoch: number;
  private rootObjective?: string;
  private activeInstruction?: string;
  private intentHistory: IntentUpdate[];
  private activeConstraints: string[];
  private nonGoals: string[];
  private openQuestions: string[];
  private evidenceIndex: EvidenceRecord[];
  private turnSummaries: TurnSummary[];
  private promptAssemblyStats?: PromptAssemblyStats;
  private diagnostics: string[];
  private reconciledAt?: number;

  constructor(options: ContextHarnessOptions) {
    this.cwd = options.cwd;
    this.modelId = options.modelId;
    this.config = { ...DEFAULT_CONFIG, ...options.config };
    const state = upgradeHarnessState(options.state, { cwd: options.cwd });
    this.contract = state.contract;
    this.ledger = new ContextLedger(state.ledger);
    this.capsule = state.capsule;
    this.completionBlockCount = state.completionBlockCount ?? 0;
    this.taskEpoch = state.taskEpoch ?? 1;
    this.rootObjective = state.rootObjective;
    this.activeInstruction = state.activeInstruction;
    this.intentHistory = state.intentHistory ?? [];
    this.activeConstraints = state.activeConstraints ?? [];
    this.nonGoals = state.nonGoals ?? [];
    this.openQuestions = state.openQuestions ?? [];
    this.evidenceIndex = state.evidenceIndex ?? [];
    this.turnSummaries = state.turnSummaries ?? [];
    this.promptAssemblyStats = state.promptAssemblyStats;
    this.diagnostics = state.diagnostics ?? [];
    this.reconciledAt = state.reconciledAt;
  }

  updateContractFromUserInput(input: string): IntentUpdate | undefined {
    if (this.config.enabled === false) return;
    const intent = classifyIntent(input, this.toJSON());
    this.contract = this.contract
      ? updateTaskContract(this.contract, input, this.cwd, intent)
      : createTaskContract(input, this.cwd);
    this.taskEpoch = intent.taskEpoch;
    if (intent.rootObjectiveChanged || !this.rootObjective) {
      this.rootObjective = this.contract.objective;
    }
    if (shouldReplaceActiveInstruction(intent) || !this.activeInstruction) {
      this.activeInstruction = intent.activeInstruction;
    }
    this.activeConstraints = this.mergeList(this.activeConstraints, intent.constraints);
    this.nonGoals = this.mergeList(this.nonGoals, intent.nonGoals);
    this.openQuestions = this.mergeList(this.openQuestions, intent.openQuestions);
    this.intentHistory = [...this.intentHistory, intent].slice(-40);
    this.ledger.recordUserRequirement(input);
    this.refreshCapsule();
    return intent;
  }

  classifyIntent(input: string): IntentUpdate {
    return classifyIntent(input, this.toJSON());
  }

  assembleMessages(messages: Message[], options: PromptAssemblyOptions = {}): Message[] {
    if (this.config.enabled === false) return messages;

    const built = buildHarnessContext(this.toJSON(), this.modelId, this.config, options);
    this.promptAssemblyStats = built.stats;

    // Bump includedCount for evidence that was selected — learning signal
    if (built.stats.includedEvidence.length > 0) {
      const includedIds = built.stats.includedEvidence.map(e => e.id);
      this.evidenceIndex = bumpIncludedEvidence(this.evidenceIndex, includedIds);
    }

    if (!built.text.trim()) return messages;

    const cloned = messages.map(message => ({ ...message }));

    // Inject dynamic harness context after the stable system prefix. Keeping
    // the first system message stable allows provider-side prompt caching
    // without polluting the durable user/assistant transcript.
    const firstNonSystemIndex = cloned.findIndex(message => message.role !== 'system');
    const insertIndex = firstNonSystemIndex >= 0 ? firstNonSystemIndex : cloned.length;

    cloned.splice(insertIndex, 0, {
      role: 'system',
      content: built.text,
    });

    return cloned;
  }

  recordAssistantResponse(response: LLMResponse): void {
    if (this.config.enabled === false) return;
    if (response.content?.trim()) {
      this.ledger.recordAssistantDecision(response.content);
    }
    this.refreshCapsule();
  }

  recordAppliedSkills(skills: Array<{ name: string; source?: string; tools?: string[] }>): void {
    if (this.config.enabled === false || skills.length === 0) return;
    this.ledger.add({
      type: 'skill',
      content: `Applied skills: ${skills.map(skill => skill.name).join(', ')}`,
      source: { kind: 'system', ref: 'skills' },
      importance: 4,
      ttl: 'turn',
      metadata: {
        skills: skills.map(skill => ({
          name: skill.name,
          source: skill.source,
          tools: skill.tools,
        })),
      },
    });
    this.refreshCapsule();
  }

  beforeToolUse(params: { name: string; args: Record<string, unknown> }): DriftCheckResult {
    const mode = this.config.driftGuard ?? 'warn';
    const result = checkToolDrift({
      contract: this.contract,
      toolName: params.name,
      args: params.args,
      mode,
    });
    if (result.status !== 'ok') {
      this.ledger.add({
        type: result.status === 'block' ? 'blocker' : 'risk',
        content: result.reason || `Tool ${params.name} may drift from the current task.`,
        source: { kind: 'system', ref: params.name },
        importance: result.status === 'block' ? 5 : 4,
        ttl: 'task',
        metadata: { toolName: params.name, status: result.status },
      });
      this.refreshCapsule();
    }
    return result;
  }

  recordToolResult(params: {
    name: string;
    args: Record<string, unknown>;
    result: string;
    duration: number;
    success: boolean;
    error?: string;
    summary?: string;
  }): void {
    if (this.config.enabled === false) return;
    this.ledger.recordToolResult(params);
    this.refreshCapsule();
  }

  ingestTurn(params: Omit<CreateTurnSummaryInput, 'turn' | 'taskEpoch' | 'intent'> & { intent?: IntentUpdate }): TurnSummary | undefined {
    if (this.config.enabled === false) return undefined;
    const intent = params.intent ?? this.intentHistory[this.intentHistory.length - 1] ?? classifyIntent(params.userInput, this.toJSON());
    const summary = createTurnSummary({
      ...params,
      turn: this.turnSummaries.length + 1,
      taskEpoch: this.taskEpoch,
      intent,
    });
    this.turnSummaries = [...this.turnSummaries, summary].slice(-80);
    this.refreshEvidenceIndex();
    this.refreshCapsule();
    return summary;
  }

  beforeComplete(): CompletionGateResult {
    const result = evaluateCompletionGate({
      contract: this.contract,
      ledger: this.ledger.getEntries(),
    });

    const mode = this.config.completionGate === true
      ? 'block'
      : this.config.completionGate === false
        ? 'off'
        : (this.config.completionGate ?? 'warn');

    if (!result.canComplete && mode !== 'off') {
      this.ledger.add({
        type: mode === 'block' ? 'blocker' : 'risk',
        content: `Completion gate missing: ${result.missing.join('; ')}`,
        source: { kind: 'system', ref: 'completion_gate' },
        importance: 5,
        ttl: 'task',
        metadata: { missing: result.missing, mode },
      });
      this.refreshCapsule();
    }

    // Block completion at most once per intent cycle. When the task moves
    // forward (canComplete becomes true), the counter resets for next time.
    if (!result.canComplete && mode === 'block' && this.completionBlockCount < 1) {
      this.completionBlockCount++;
      return result;
    }

    if (result.canComplete) {
      this.completionBlockCount = 0;
    }

    return { ...result, canComplete: true };
  }

  asCompletionBlockedMessage(result: CompletionGateResult): Message {
    return {
      role: 'user',
      content: `[Harness Completion Gate]\nThe task is not ready to finish.\nMissing:\n${result.missing.map(item => `- ${item}`).join('\n')}\nContinue working or explicitly explain why verification cannot be run.`,
    };
  }

  asToolBlockedResult(result: DriftCheckResult): string {
    return JSON.stringify({
      success: false,
      error: result.reason || 'Blocked by Context Harness',
      suggestion: result.correction,
    });
  }

  getCapsule(): ContextCapsule | undefined {
    this.refreshCapsule();
    return this.capsule;
  }

  getContract(): HarnessState['contract'] {
    return this.contract;
  }

  getIntentHistory(): IntentUpdate[] {
    return this.intentHistory;
  }

  /**
   * Generate a structured diagnostic summary for /harness explain
   */
  explain(): {
    contract: HarnessState['contract'];
    recentIntents: IntentUpdate[];
    capsule: ContextCapsule | undefined;
    assemblyStats: HarnessState['promptAssemblyStats'];
    ledgerSize: number;
    evidenceSize: number;
    turnSummaryCount: number;
  } {
    this.refreshEvidenceIndex();
    return {
      contract: this.contract,
      recentIntents: this.intentHistory.slice(-5),
      capsule: this.getCapsule(),
      assemblyStats: this.promptAssemblyStats,
      ledgerSize: this.ledger.getEntries().length,
      evidenceSize: this.evidenceIndex.length,
      turnSummaryCount: this.turnSummaries.length,
    };
  }

  toJSON(): HarnessState {
    this.refreshEvidenceIndex();
    return {
      version: 2,
      contract: this.contract,
      ledger: this.ledger.toJSON(),
      capsule: this.capsule,
      completionBlockCount: this.completionBlockCount,
      taskEpoch: this.taskEpoch,
      rootObjective: this.rootObjective,
      activeInstruction: this.activeInstruction,
      intentHistory: this.intentHistory,
      activeConstraints: this.activeConstraints,
      nonGoals: this.nonGoals,
      openQuestions: this.openQuestions,
      evidenceIndex: this.evidenceIndex,
      turnSummaries: this.turnSummaries,
      promptAssemblyStats: this.promptAssemblyStats,
      diagnostics: this.diagnostics,
      reconciledAt: this.reconciledAt,
      updatedAt: Date.now(),
    };
  }

  private refreshCapsule(): void {
    if (!this.contract && this.ledger.getEntries().length === 0) return;
    this.capsule = createContextCapsule(this.contract, this.ledger.getEntries());
    this.refreshEvidenceIndex();
  }

  private refreshEvidenceIndex(): void {
    this.evidenceIndex = buildEvidenceIndex({
      ledger: this.ledger.getEntries(),
      turnSummaries: this.turnSummaries,
      existing: this.evidenceIndex,
    });
  }

  private mergeList(existing: string[], incoming: string[]): string[] {
    return [...new Set([...existing, ...incoming].map(item => item.trim()).filter(Boolean))].slice(-30);
  }
}

export function createContextHarness(options: ContextHarnessOptions): ContextHarness {
  return new ContextHarness(options);
}
