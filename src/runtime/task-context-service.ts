import { HarnessKernel } from '../harness/context-harness';
import type { PromptAssemblyOptions } from '../harness/assembler';
import type { CreateTurnSummaryInput } from '../harness/turn-summary';
import type {
  CapabilityProfileInput,
  CompletionGateResult,
  ContextCapsule,
  DriftCheckResult,
  HarnessConfig,
  HarnessState,
  IntentUpdate,
  TaskContract,
  TurnSummary,
} from '../harness/types';
import type { LLMResponse, Message } from '../services/llm';

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export interface TaskContextServiceOptions {
  readonly cwd: string;
  readonly modelId: string;
  readonly state?: HarnessState;
  readonly config?: HarnessConfig;
  readonly revision?: number;
}

export interface TaskContextToolInput {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface TaskContextToolResultInput extends TaskContextToolInput {
  readonly result: string;
  readonly duration: number;
  readonly success: boolean;
  readonly error?: string;
  readonly summary?: string;
}

export interface TaskContextAppliedSkill {
  readonly name: string;
  readonly source?: string;
  readonly tools?: string[];
}

export interface TaskContextCriterionWaiver {
  readonly authorizedBy: 'user';
  readonly reason: string;
  readonly at?: number;
  readonly sourceRef?: string;
}

export type TaskContextTurnInput = Omit<CreateTurnSummaryInput, 'turn' | 'taskEpoch' | 'intent'> & {
  readonly intent?: IntentUpdate;
};

export type TaskContextCompletionDecisionV1 = DeepReadonly<
  CompletionGateResult & {
    version: 1;
    revision: number;
    auditedAt: number;
  }
>;

export interface TaskContextSnapshotV1 {
  readonly version: 1;
  readonly revision: number;
  readonly taskEpoch: number;
  readonly updatedAt: number;
  readonly state: DeepReadonly<HarnessState>;
}

export interface TaskContextExplanation {
  readonly contract: DeepReadonly<TaskContract> | undefined;
  readonly recentIntents: readonly DeepReadonly<IntentUpdate>[];
  readonly capsule: DeepReadonly<ContextCapsule> | undefined;
  readonly assemblyStats: DeepReadonly<HarnessState['promptAssemblyStats']>;
  readonly ledgerSize: number;
  readonly evidenceSize: number;
  readonly turnSummaryCount: number;
}

/**
 * The sole in-memory owner of task contract, evidence, progress and completion semantics.
 * Persistence and Goal lifecycle deliberately remain outside this contract.
 */
export interface TaskContextService {
  readonly serviceId: 'task-context';
  readonly revision: number;
  observeUserInput(input: string): DeepReadonly<IntentUpdate> | undefined;
  classifyIntent(input: string): DeepReadonly<IntentUpdate>;
  observeCapability(input: CapabilityProfileInput): DeepReadonly<HarnessState['capabilityProfile']>;
  assembleMessages(messages: Message[], options?: PromptAssemblyOptions): Message[];
  observeAssistantResponse(response: LLMResponse): void;
  observeAppliedSkills(skills: TaskContextAppliedSkill[]): void;
  checkToolUse(input: TaskContextToolInput): DeepReadonly<DriftCheckResult>;
  observeToolResult(input: TaskContextToolResultInput): void;
  observeTurn(input: TaskContextTurnInput): DeepReadonly<TurnSummary> | undefined;
  auditCompletion(): TaskContextCompletionDecisionV1;
  completionBlockedMessage(result: CompletionGateResult): Message;
  toolBlockedResult(result: DriftCheckResult): string;
  linkEvidence(criterionId: string, evidenceRef: string): boolean;
  authorizeCriterionWaiver(criterionId: string, waiver: TaskContextCriterionWaiver): boolean;
  getContract(): DeepReadonly<TaskContract> | undefined;
  getIntentHistory(): readonly DeepReadonly<IntentUpdate>[];
  getCapsule(): DeepReadonly<ContextCapsule> | undefined;
  explain(): TaskContextExplanation;
  snapshot(): DeepReadonly<TaskContextSnapshotV1>;
  /** Mutable clone intended for the future atomic TurnCommit owner. */
  exportState(): HarnessState;
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value as DeepReadonly<T>;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value) as DeepReadonly<T>;
}

function immutableClone<T>(value: T): DeepReadonly<T> {
  return deepFreeze(structuredClone(value));
}

class HarnessKernelTaskContextService implements TaskContextService {
  readonly serviceId = 'task-context' as const;

  private readonly kernel: HarnessKernel;
  private revisionValue: number;

  constructor(options: TaskContextServiceOptions) {
    if (!Number.isSafeInteger(options.revision ?? 0) || (options.revision ?? 0) < 0) {
      throw new RangeError('TaskContext revision must be a non-negative safe integer.');
    }
    this.revisionValue = options.revision ?? 0;
    this.kernel = new HarnessKernel({
      cwd: options.cwd,
      modelId: options.modelId,
      state: options.state ? structuredClone(options.state) : undefined,
      config: { completionGate: 'block', ...options.config },
    });
  }

  get revision(): number {
    return this.revisionValue;
  }

  observeUserInput(input: string): DeepReadonly<IntentUpdate> | undefined {
    const result = this.mutate(() => this.kernel.updateContractFromUserInput(input));
    return result ? immutableClone(result) : undefined;
  }

  classifyIntent(input: string): DeepReadonly<IntentUpdate> {
    return immutableClone(this.kernel.classifyIntent(input));
  }

  observeCapability(
    input: CapabilityProfileInput
  ): DeepReadonly<HarnessState['capabilityProfile']> {
    return immutableClone(this.mutate(() => this.kernel.updateCapabilityProfile(input)));
  }

  assembleMessages(messages: Message[], options: PromptAssemblyOptions = {}): Message[] {
    return this.mutate(() => this.kernel.assembleMessages(messages, options));
  }

  observeAssistantResponse(response: LLMResponse): void {
    this.mutate(() => this.kernel.recordAssistantResponse(response));
  }

  observeAppliedSkills(skills: TaskContextAppliedSkill[]): void {
    this.mutate(() => this.kernel.recordAppliedSkills(skills));
  }

  checkToolUse(input: TaskContextToolInput): DeepReadonly<DriftCheckResult> {
    return immutableClone(this.mutate(() => this.kernel.beforeToolUse(input)));
  }

  observeToolResult(input: TaskContextToolResultInput): void {
    this.mutate(() => this.kernel.recordToolResult(input));
  }

  observeTurn(input: TaskContextTurnInput): DeepReadonly<TurnSummary> | undefined {
    const result = this.mutate(() => this.kernel.ingestTurn(input));
    return result ? immutableClone(result) : undefined;
  }

  auditCompletion(): TaskContextCompletionDecisionV1 {
    const result = this.mutate(() => this.kernel.beforeComplete());
    return immutableClone({
      ...result,
      version: 1 as const,
      revision: this.revisionValue,
      auditedAt: Date.now(),
    });
  }

  completionBlockedMessage(result: CompletionGateResult): Message {
    return this.kernel.asCompletionBlockedMessage(result);
  }

  toolBlockedResult(result: DriftCheckResult): string {
    return this.kernel.asToolBlockedResult(result);
  }

  linkEvidence(criterionId: string, evidenceRef: string): boolean {
    return this.mutate(() => this.kernel.linkEvidenceToCriterion(criterionId, evidenceRef));
  }

  authorizeCriterionWaiver(criterionId: string, waiver: TaskContextCriterionWaiver): boolean {
    return this.mutate(() => this.kernel.authorizeCriterionWaiver(criterionId, waiver));
  }

  getContract(): DeepReadonly<TaskContract> | undefined {
    const contract = this.kernel.getContract();
    return contract ? immutableClone(contract) : undefined;
  }

  getIntentHistory(): readonly DeepReadonly<IntentUpdate>[] {
    return immutableClone(this.kernel.getIntentHistory());
  }

  getCapsule(): DeepReadonly<ContextCapsule> | undefined {
    const capsule = this.kernel.getCapsule();
    return capsule ? immutableClone(capsule) : undefined;
  }

  explain(): TaskContextExplanation {
    return immutableClone(this.kernel.explain());
  }

  snapshot(): DeepReadonly<TaskContextSnapshotV1> {
    const state = this.kernel.toJSON();
    return immutableClone({
      version: 1 as const,
      revision: this.revisionValue,
      taskEpoch: state.taskEpoch ?? 1,
      updatedAt: state.updatedAt,
      state,
    });
  }

  exportState(): HarnessState {
    return structuredClone(this.kernel.toJSON());
  }

  private mutate<T>(operation: () => T): T {
    const before = this.kernel.toJSON().updatedAt;
    const result = operation();
    if (this.kernel.toJSON().updatedAt !== before) this.revisionValue++;
    return result;
  }
}

export function createTaskContextService(options: TaskContextServiceOptions): TaskContextService {
  return new HarnessKernelTaskContextService(options);
}
