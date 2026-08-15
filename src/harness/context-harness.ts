import type { LLMResponse, Message } from '../services/llm';
import { buildHarnessContext, type PromptAssemblyOptions } from './assembler';
import { createCapabilityProfile } from './capability-profile';
import { createContextCapsule } from './capsule';
import { createTaskContract, updateTaskContract } from './contract';
import { checkToolDrift, evaluateCompletionGate } from './drift-guard';
import { buildEvidenceIndex, bumpIncludedEvidence } from './evidence';
import { classifyIntent, shouldReplaceActiveInstruction } from './intent';
import { ContextLedger } from './ledger';
import { ProgressController } from './progress-controller';
import { upgradeHarnessState } from './state';
import { StopController } from './stop-controller';
import { createTurnSummary, type CreateTurnSummaryInput } from './turn-summary';
import {
  classifyVerificationCommand,
  isTrustedEvidence,
  requiredVerificationKinds,
  verificationKindForEntry,
} from './verification';
import type {
  CompletionGateResult,
  CapabilityProfileInput,
  ContextCapsule,
  DriftCheckResult,
  EvidenceRecord,
  HarnessConfig,
  HarnessState,
  IntentUpdate,
  PromptAssemblyStats,
  TurnSummary,
} from './types';

const DEFAULT_CONFIG: Required<
  Pick<
    HarnessConfig,
    | 'enabled'
    | 'preCompactThreshold'
    | 'compactThreshold'
    | 'maxRecentTurns'
    | 'evidenceBudgetRatio'
    | 'driftGuard'
  >
> & {
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

/** Canonical v0.1.9 task-state owner; ContextHarness remains a compatibility alias. */
export class HarnessKernel {
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
  private readonly progressController: ProgressController;
  private readonly stopController: StopController;
  private capabilityProfile: HarnessState['capabilityProfile'];
  private capabilityHistory: NonNullable<HarnessState['capabilityHistory']>;
  private reconciledAt?: number;
  private updatedAt: number;

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
    const recentTurnLimit = this.resolveRecentTurnLimit();
    this.turnSummaries =
      recentTurnLimit > 0 ? (state.turnSummaries ?? []).slice(-recentTurnLimit) : [];
    this.promptAssemblyStats = state.promptAssemblyStats;
    this.diagnostics = state.diagnostics ?? [];
    this.progressController = new ProgressController(state.progressState);
    this.stopController = new StopController();
    this.capabilityProfile = state.capabilityProfile;
    this.capabilityHistory = state.capabilityHistory ?? [];
    this.reconciledAt = state.reconciledAt;
    this.updatedAt = state.updatedAt;
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
    this.touch();
    return intent;
  }

  classifyIntent(input: string): IntentUpdate {
    return classifyIntent(input, this.toJSON());
  }

  updateCapabilityProfile(input: CapabilityProfileInput): HarnessState['capabilityProfile'] {
    if (this.config.enabled === false) return this.capabilityProfile;
    const next = createCapabilityProfile(this.cwd, input, this.capabilityProfile);
    if (next.fingerprint === this.capabilityProfile?.fingerprint) return this.capabilityProfile;
    this.capabilityProfile = next;
    this.capabilityHistory = [...this.capabilityHistory, next].slice(-10);
    this.touch();
    return structuredClone(next);
  }

  assembleMessages(messages: Message[], options: PromptAssemblyOptions = {}): Message[] {
    if (this.config.enabled === false) return messages;

    const built = buildHarnessContext(this.toJSON(), this.modelId, this.config, options);
    this.promptAssemblyStats = built.stats;
    this.touch();

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
    this.touch();
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
    this.touch();
  }

  beforeToolUse(params: { name: string; args: Record<string, unknown> }): DriftCheckResult {
    const mode = this.config.driftGuard ?? 'warn';
    const result = checkToolDrift({
      contract: this.contract,
      capabilityProfile: this.capabilityProfile,
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
      this.touch();
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
    const entry = this.ledger.recordToolResult(params);
    this.autoLinkVerificationEvidence(entry);
    this.refreshCapsule();
    this.touch();
  }

  ingestTurn(
    params: Omit<CreateTurnSummaryInput, 'turn' | 'taskEpoch' | 'intent'> & {
      intent?: IntentUpdate;
    }
  ): TurnSummary | undefined {
    if (this.config.enabled === false) return undefined;
    const intent =
      params.intent ??
      this.intentHistory[this.intentHistory.length - 1] ??
      classifyIntent(params.userInput, this.toJSON());
    const previousTurn = this.turnSummaries[this.turnSummaries.length - 1]?.turn ?? 0;
    const summary = createTurnSummary({
      ...params,
      turn: previousTurn + 1,
      taskEpoch: this.taskEpoch,
      intent,
    });
    const recentTurnLimit = this.resolveRecentTurnLimit();
    this.turnSummaries =
      recentTurnLimit > 0 ? [...this.turnSummaries, summary].slice(-recentTurnLimit) : [];
    this.refreshEvidenceIndex();
    this.refreshCapsule();
    this.touch();
    return summary;
  }

  beforeComplete(): CompletionGateResult {
    const result = evaluateCompletionGate({
      contract: this.contract,
      ledger: this.ledger.getEntries(),
    });
    const progressDelta = this.progressController.observe({
      contract: this.contract,
      ledger: this.ledger.getEntries(),
      diagnostics: this.diagnostics,
    });
    result.progressDelta = progressDelta;
    result.stopDecision = this.stopController.decideCompletion(result, progressDelta);
    this.touch();

    const mode =
      this.config.completionGate === true
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
      this.touch();
    }

    // Block completion until evidence is provided. Track consecutive blocks
    // so callers can detect a stalled loop, but never silently pass the gate
    // without evidence.
    if (!result.canComplete && mode === 'block') {
      this.completionBlockCount++;
      this.touch();
      return result;
    }

    if (result.canComplete) {
      const changed = this.completionBlockCount !== 0;
      this.completionBlockCount = 0;
      if (changed) this.touch();
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
    return this.capsule;
  }

  linkEvidenceToCriterion(criterionId: string, evidenceRef: string): boolean {
    if (!this.contract?.criteria || !criterionId.trim() || !evidenceRef.trim()) return false;
    const entry = this.ledger
      .getEntries()
      .find(item => item.id === evidenceRef || `ledger:${item.id}` === evidenceRef);
    if (!entry || !isTrustedEvidence(entry)) return false;
    const criterion = this.contract.criteria.find(item => item.id === criterionId);
    if (!criterion) return false;
    if (criterion.evidenceRefs.includes(evidenceRef)) return true;
    this.updateCriterionEvidence(criterionId, evidenceRef);
    this.refreshCapsule();
    this.touch();
    return true;
  }

  authorizeCriterionWaiver(
    criterionId: string,
    waiver: { authorizedBy: 'user'; reason: string; at?: number; sourceRef?: string }
  ): boolean {
    if (
      !this.contract?.criteria ||
      waiver.authorizedBy !== 'user' ||
      !waiver.reason.trim() ||
      !this.contract.criteria.some(item => item.id === criterionId)
    ) {
      return false;
    }
    const at = waiver.at ?? Date.now();
    if (!Number.isFinite(at)) return false;
    this.contract = {
      ...this.contract,
      updatedAt: Math.max(Date.now(), this.contract.updatedAt + 1),
      criteria: this.contract.criteria.map(item =>
        item.id === criterionId
          ? {
              ...item,
              status: 'waived',
              waiver: {
                authorizedBy: 'user',
                reason: waiver.reason.trim(),
                at,
                sourceRef: waiver.sourceRef,
              },
            }
          : item
      ),
    };
    this.refreshCapsule();
    this.touch();
    return true;
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
      progressState: this.progressController.toJSON(),
      capabilityProfile: this.capabilityProfile,
      capabilityHistory: this.capabilityHistory,
      reconciledAt: this.reconciledAt,
      updatedAt: this.updatedAt,
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
    return [...new Set([...existing, ...incoming].map(item => item.trim()).filter(Boolean))].slice(
      -30
    );
  }

  private resolveRecentTurnLimit(): number {
    const configured = Number(this.config.maxRecentTurns ?? DEFAULT_CONFIG.maxRecentTurns);
    if (!Number.isFinite(configured)) return DEFAULT_CONFIG.maxRecentTurns;
    return Math.max(0, Math.min(80, Math.floor(configured)));
  }

  private autoLinkVerificationEvidence(entry: ReturnType<ContextLedger['recordToolResult']>): void {
    if (!this.contract?.criteria || !isTrustedEvidence(entry)) return;
    const command =
      typeof entry.metadata?.command === 'string' ? entry.metadata.command : undefined;
    const kind = verificationKindForEntry(entry);
    if (kind === 'generic' && classifyVerificationCommand(command) === 'generic') return;

    const candidates = this.contract.criteria.filter(criterion =>
      requiredVerificationKinds(criterion.statement).includes(kind)
    );
    if (candidates.length === 0) return;

    const normalizedCommand = command?.trim().toLowerCase();
    const exact = normalizedCommand
      ? candidates.find(criterion => criterion.statement.toLowerCase().includes(normalizedCommand))
      : undefined;
    const selected =
      exact ??
      candidates.find(criterion => {
        const evaluation = evaluateCompletionGate({
          contract: {
            ...this.contract!,
            criteria: [criterion],
            successCriteria: [criterion.statement],
          },
          ledger: this.ledger.getEntries(),
        }).criterionResults?.[0];
        return evaluation?.status !== 'passed' && evaluation?.status !== 'waived';
      }) ??
      candidates[0];
    this.updateCriterionEvidence(selected.id, entry.id);
  }

  private updateCriterionEvidence(criterionId: string, evidenceRef: string): void {
    if (!this.contract?.criteria) return;
    const nextCriteria = this.contract.criteria.map(item => {
      if (item.id !== criterionId) return item;
      const evidenceRefs = item.evidenceRefs.includes(evidenceRef)
        ? item.evidenceRefs
        : [...item.evidenceRefs, evidenceRef];
      const singleResult = evaluateCompletionGate({
        contract: {
          ...this.contract!,
          successCriteria: [item.statement],
          criteria: [{ ...item, evidenceRefs }],
        },
        ledger: this.ledger.getEntries(),
      }).criterionResults?.[0];
      return {
        ...item,
        evidenceRefs,
        status: singleResult?.status ?? item.status,
      };
    });
    this.contract = {
      ...this.contract,
      criteria: nextCriteria,
      updatedAt: Math.max(Date.now(), this.contract.updatedAt + 1),
    };
  }

  private touch(): void {
    this.updatedAt = Math.max(Date.now(), this.updatedAt + 1);
  }
}

export function createHarnessKernel(options: ContextHarnessOptions): HarnessKernel {
  return new HarnessKernel(options);
}

export function createContextHarness(options: ContextHarnessOptions): HarnessKernel {
  return createHarnessKernel(options);
}

export { HarnessKernel as ContextHarness };
