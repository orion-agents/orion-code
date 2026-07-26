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

export interface TaskContract {
  id: string;
  objective: string;
  userIntent: string;
  requirements: string[];
  successCriteria: string[];
  constraints: string[];
  prohibitions: string[];
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
}
