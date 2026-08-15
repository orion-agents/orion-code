export type LedgerEntryType =
  | 'user_requirement'
  | 'decision'
  | 'file_fact'
  | 'tool_result'
  | 'test_result'
  | 'risk'
  | 'todo'
  | 'skill'
  | 'blocker'
  | 'verification';

export type TaskCriterionStatus = 'pending' | 'passed' | 'failed' | 'waived';

export type TaskCriterionScope = 'task' | 'project' | 'release';

export interface TaskCriterionSource {
  kind: 'user' | 'derived' | 'system';
  /** Stable message, intent, Goal, or policy reference when one is available. */
  ref?: string;
}

export interface TaskCriterionWaiver {
  /** Waivers are only authoritative when they came from the user. */
  authorizedBy: 'user';
  reason: string;
  at: number;
  sourceRef?: string;
}

export interface TaskCriterion {
  /** Stable across normalization, persistence and compatible state upgrades. */
  id: string;
  statement: string;
  /** Ledger/evidence ids that explicitly support this criterion. */
  evidenceRefs: string[];
  /** Additive V3 fields. Legacy records are populated during normalization. */
  source?: TaskCriterionSource;
  scope?: TaskCriterionScope;
  dependencies?: string[];
  status?: TaskCriterionStatus;
  waiver?: TaskCriterionWaiver;
}

export interface TaskContract {
  /** TaskContract V3 is additive and remains readable inside HarnessState V2. */
  version?: 3;
  id: string;
  objective: string;
  userIntent: string;
  requirements: string[];
  successCriteria: string[];
  /** Additive typed projection of legacy successCriteria strings. */
  criteria?: TaskCriterion[];
  taskEpoch?: number;
  constraints: string[];
  prohibitions: string[];
  nonGoals?: string[];
  openQuestions?: string[];
  allowedScope: {
    cwd: string;
    files?: string[];
    commands?: string[];
  };
  createdAt: number;
  updatedAt: number;
}

export interface LedgerSource {
  kind: 'user' | 'file' | 'tool' | 'test' | 'agent' | 'system';
  ref?: string;
}

export interface ContextLedgerEntry {
  id: string;
  type: LedgerEntryType;
  content: string;
  source: LedgerSource;
  importance: 1 | 2 | 3 | 4 | 5;
  ttl: 'turn' | 'task' | 'session' | 'persistent';
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export interface PlanStep {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed';
  evidence?: string[];
}

export interface ContextCapsule {
  contract?: TaskContract;
  currentPlan: PlanStep[];
  completed: string[];
  openTodos: string[];
  keyFacts: ContextLedgerEntry[];
  changedFiles: string[];
  verification: {
    commandsRun: string[];
    passed: string[];
    failed: string[];
    warnings: string[];
  };
  nextAction: string;
  createdAt: number;
  updatedAt: number;
}

export type IntentKind =
  | 'new_task'
  | 'refine_current_task'
  | 'interrupt_and_replace_current_step'
  | 'verify_or_test'
  | 'meta_configuration'
  | 'casual_or_feedback'
  | 'continue_current_task'
  | 'clarification';

export interface IntentUpdate {
  id: string;
  kind: IntentKind;
  input: string;
  summary: string;
  confidence: number;
  reason: string;
  taskEpoch: number;
  rootObjectiveChanged: boolean;
  activeInstruction: string;
  constraints: string[];
  nonGoals: string[];
  openQuestions: string[];
  filesMentioned: string[];
  toolsMentioned: string[];
  createdAt: number;
}

export type EvidenceKind =
  | 'requirement'
  | 'decision'
  | 'file_fact'
  | 'tool_result'
  | 'verification'
  | 'skill'
  | 'risk'
  | 'todo'
  | 'turn_summary'
  | 'mcp_fact';

export interface EvidenceRecord {
  id: string;
  kind: EvidenceKind;
  content: string;
  source: 'ledger' | 'turn_summary' | 'session' | 'system';
  sourceId?: string;
  importance: 1 | 2 | 3 | 4 | 5;
  taskEpoch?: number;
  createdAt: number;
  tokenEstimate: number;
  tags: string[];
  path?: string;
  toolName?: string;
  verificationStatus?: 'passed' | 'failed' | 'unknown';
  metadata?: Record<string, unknown>;
  /** How many times this evidence was selected into the prompt.
   *  Used as a simple learning signal to boost frequently-useful evidence. */
  includedCount?: number;
}

export interface RankedEvidenceRecord extends EvidenceRecord {
  score: number;
  reasons: string[];
}

export interface TurnSummary {
  id: string;
  turn: number;
  taskEpoch: number;
  intentKind: IntentKind;
  userIntent: string;
  assistantOutcome: string;
  filesTouched: string[];
  toolsUsed: string[];
  decisions: string[];
  verification: {
    commandsRun: string[];
    passed: string[];
    failed: string[];
  };
  unresolved: string[];
  createdAt: number;
}

export interface PromptAssemblyStats {
  createdAt: number;
  modelId: string;
  budgetTokens: number;
  estimatedTokens: number;
  coreTokens: number;
  evidenceBudgetTokens: number;
  recentTurnBudgetTokens: number;
  includedEvidence: Array<{
    id: string;
    kind: EvidenceKind;
    score: number;
    tokens: number;
    reason: string;
  }>;
  omittedEvidence: Array<{
    id: string;
    kind: EvidenceKind;
    score: number;
    tokens: number;
    reason: string;
  }>;
  sections: string[];
  sectionManifest?: PromptSectionManifestEntry[];
  overBudget?: boolean;
  capabilityProfileVersion?: number;
  capabilityProfileFingerprint?: string;
}

export interface PromptSectionManifestEntry {
  name: string;
  authority: 'system' | 'project' | 'user' | 'tool' | 'session';
  source: string;
  selected: boolean;
  tokenEstimate: number;
  budgetTokens: number;
  contentHash: string;
  reason?: string;
}

export interface HarnessState {
  version?: 2;
  contract?: TaskContract;
  ledger: ContextLedgerEntry[];
  capsule?: ContextCapsule;
  completionBlockCount?: number;
  taskEpoch?: number;
  rootObjective?: string;
  activeInstruction?: string;
  intentHistory?: IntentUpdate[];
  activeConstraints?: string[];
  nonGoals?: string[];
  openQuestions?: string[];
  evidenceIndex?: EvidenceRecord[];
  turnSummaries?: TurnSummary[];
  promptAssemblyStats?: PromptAssemblyStats;
  diagnostics?: string[];
  progressState?: HarnessProgressState;
  capabilityProfile?: CapabilityProfile;
  capabilityHistory?: CapabilityProfile[];
  reconciledAt?: number;
  updatedAt: number;
}

export interface HarnessSidecar {
  version: 2;
  sessionId: string;
  projectPath: string;
  state: HarnessState;
  contextCapsule?: ContextCapsule;
  updatedAt: number;
  diagnostics?: string[];
}

export interface HarnessConfig {
  enabled?: boolean;
  preCompactThreshold?: number;
  compactThreshold?: number;
  maxRecentTurns?: number;
  evidenceBudgetRatio?: number;
  driftGuard?: 'off' | 'warn' | 'block';
  completionGate?: boolean | 'off' | 'warn' | 'block';
}

export interface DriftCheckResult {
  status: 'ok' | 'warn' | 'block';
  reason?: string;
  correction?: string;
}

export interface CompletionGateResult {
  canComplete: boolean;
  missing: string[];
  evidence: string[];
  criterionResults?: CompletionCriterionResult[];
  progressDelta?: ProgressDelta;
  stopDecision?: import('../framework/stop-decision').StopDecision;
}

export type VerificationKind =
  | 'test'
  | 'build'
  | 'lint'
  | 'typecheck'
  | 'diff'
  | 'git'
  | 'ci'
  | 'release'
  | 'generic';

export interface CompletionCriterionResult {
  criterionId: string;
  statement: string;
  status: TaskCriterionStatus;
  applicable: boolean;
  evidenceRefs: string[];
  requiredKinds: VerificationKind[];
  missingKinds: VerificationKind[];
  failedKinds: VerificationKind[];
}

export interface ProgressSnapshot {
  fingerprint: string;
  criterionStates: Array<{ id: string; status: TaskCriterionStatus }>;
  evidenceRefs: string[];
  changedFiles: string[];
  decisions: string[];
  blockers: string[];
  diagnostics: string[];
  toolSignature?: string;
  workspaceStateHash: string;
}

export interface ProgressDelta {
  schemaVersion: 1;
  changed: boolean;
  criterionChanges: Array<{
    id: string;
    from?: TaskCriterionStatus;
    to: TaskCriterionStatus;
  }>;
  newEvidenceRefs: string[];
  newChangedFiles: string[];
  newDecisions: string[];
  newBlockers: string[];
  newDiagnostics: string[];
  toolSignature?: string;
  workspaceStateHash: string;
  repeatedSignatureCount: number;
  recordedAt: number;
}

export interface HarnessProgressState {
  schemaVersion: 1;
  snapshot?: ProgressSnapshot;
  lastDelta?: ProgressDelta;
}

export interface CapabilityProfile {
  schemaVersion: 1;
  revision: number;
  fingerprint: string;
  createdAt: number;
  projectRoot: string;
  model: {
    id: string;
    contextWindow: number;
    toolCalling: boolean;
    streaming: boolean;
  };
  permission: {
    mode: string;
    confirmation: string;
    scope: 'project';
    source: 'runtime_policy';
    hardDenyEnforced: true;
  };
  tools: string[];
  features: {
    network: boolean;
    mcp: boolean;
    subagents: boolean;
    skills: boolean;
  };
}

export interface CapabilityProfileInput {
  modelId: string;
  contextWindow: number;
  permissionMode: string;
  toolConfirmation: string;
  tools: string[];
  now?: number;
}
