/**
 * orion code - 会话存储
 *
 * 使用 JSONL 格式存储会话历史和对话记录。
 * 参考 OpenClaude 的 history.jsonl 和 sessions/ 目录。
 */

import {
  existsSync,
  readFileSync,
  appendFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  realpathSync,
  statSync,
} from 'fs';
import { createHash, randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { join, resolve } from 'path';
import {
  encodeProjectPath,
  ensureConfigDir,
  ensureProjectDir,
  getHistoryPath,
  getProjectSessionMessagesPath,
  getProjectSessionHarnessPath,
  getProjectSessionCompactPath,
  getProjectSessionMetaPath,
  getProjectSessionTracePath,
  getProjectSessionsDir,
  getConfigDir,
  getProjectsDir,
} from './config-dir';
import { atomicWriteFileSync } from './atomic-write';
import { withFileLockSync } from './file-lock';
import { deleteSessionIndex, updateSessionIndex } from './session-index';
import { assertToolCallGroups, sealToolCallGroups } from './compact/tool-call-groups';
import { redactTraceText } from './redaction';
import { debugError } from '../utils/debug-log';
import { deleteGoal } from './goal-storage';
import type {
  LoopContinuationAction,
  LoopFinishReason,
  QueryCompactCommit,
} from '../framework/query';
import type { StopDecision } from '../framework/stop-decision';
import type { Message } from './llm';
import type { ContextUsageSnapshot } from './model-context';
import { canonicalMessagesFingerprint } from './compact/fingerprint';
import { estimateMessagesTokens } from '../utils/token-estimate';
import type { EffortPreference } from './effort';
import {
  loadThreadSessionSummaryV1,
  loadThreadSessionViewV1,
  openThreadSessionViewV1,
  type ThreadSessionRuntimeActivationV1,
  type ThreadSessionTranscriptMessageV1,
} from '../runtime/thread-session-view';
import {
  loadThreadCutoverIndexV1,
  type ThreadCutoverIndexEntryV1,
} from '../runtime/legacy-thread-materializer';
import { getProjectThreadsV2Dir } from '../product/paths';
import type {
  SessionHistoryRecoveryDiagnosticV1,
  SessionHistoryResolvedSourceV1,
} from '../runtime/session-history-recovery';
import { parseTurnCommitV1 } from '../runtime/turn-commit';
import {
  summarizeHarnessStateForMeta,
  upgradeHarnessState,
  type ContextCapsule,
  type HarnessSidecar,
  type HarnessState,
  type PromptSectionManifestEntry,
} from '../harness';

// ============================================================================
// 类型定义
// ============================================================================

/** 工具调用记录（用于 assistant 消息） */
export interface ToolCallRecord {
  /** 调用 ID */
  id: string;
  /** 类型 */
  type: 'function';
  /** 函数信息 */
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

/** 会话元数据 */
export interface SessionMeta {
  /** 会话 ID */
  id: string;
  /** Canonical project root path */
  projectPath: string;
  /** Encoded project key used under ~/.orion-code/projects/ */
  projectKey?: string;
  /** Original working directory used when the session started */
  cwd?: string;
  /** 使用的模型 */
  model: string;
  /** 开始时间 (timestamp ms) */
  startTime: number;
  /** ISO create time for SDK/picker compatibility */
  createdAt?: string;
  /** Last update timestamp (ms) */
  updatedAt?: number;
  /** ISO update time for SDK/picker compatibility */
  updatedAtIso?: string;
  /** 结束时间 (timestamp ms) */
  endTime?: number;
  /** Number of recorded transcript messages */
  messageCount?: number;
  /** Size of the session transcript history file in bytes */
  historySizeBytes?: number;
  /** Rebuildable v2 Thread head that produced the list/picker metadata. */
  threadReadModel?: {
    readonly version: 1;
    readonly threadId: string;
    readonly cursor: number;
    readonly projectionDigest: string;
    readonly cutoverGeneration: number;
    readonly lastRecordHash: string | null;
    readonly logDevice: string;
    readonly logInode: string;
    readonly logMtimeNs: string;
    readonly logCtimeNs: string;
  };
  /** UI transcript should resume from this timestamp; compacted earlier messages may stay hidden. */
  transcriptDisplayStartTime?: number;
  /** Active durable compact checkpoint stored in the compact sidecar. */
  activeCompactCheckpointId?: string;
  lastCompactAt?: number;
  /** Optional human-readable name */
  name?: string;
  /** Git branch at session creation/resume time */
  gitBranch?: string;
  /** token 数 */
  tokenCount: number;
  /** 成本 (USD) */
  cost: number;
  /** 任务摘要 */
  taskSummary?: string;
  /** 使用过的工具列表 */
  toolsUsed?: string[];
  /** 修改过的文件列表 */
  filesModified?: string[];
  /** Context Harness 状态摘要 */
  harnessState?: HarnessState;
  /** 最近一次可恢复上下文包 */
  contextCapsule?: ContextCapsule;
  /** Skills applied in this session. */
  skillsUsed?: string[];
  /** v0.2.24 — Active goal ID bound to this session. */
  activeGoalId?: string;
  /** v0.2.24 — Goal objective text (survives Compact). */
  activeGoalObjective?: string;
  /** Session-level reasoning effort preference; absent means inherit project/global/model. */
  effortPreference?: EffortPreference;
}

export interface CompactCheckpointV1 {
  version: 1;
  checkpointId: string;
  sessionId: string;
  createdAt: number;
  mode: 'predictive' | 'threshold' | 'manual';
  modelId: string;
  sourceMessageCount: number;
  transcriptStartMessageIndex: number;
  modelHistory: Message[];
  summary: {
    text: string;
    generatedAt: number;
    source: 'llm' | 'heuristic';
    sourceMessageCount: number;
  };
  beforeUsage: ContextUsageSnapshot;
  afterUsage: ContextUsageSnapshot;
}

export interface CompactCheckpointV2 {
  version: 2;
  checkpointId: string;
  sessionId: string;
  createdAt: number;
  mode: CompactCheckpointV1['mode'];
  modelId: string;
  sourceMessageCount: number;
  transcriptStartMessageIndex: number;
  sourceBoundary: {
    startMessageIndex: 0;
    endMessageIndexExclusive: number;
  };
  sourcePrefixHash: string;
  modelHistory: Message[];
  modelHistoryHash: string;
  summary: CompactCheckpointV1['summary'] & {
    schemaVersion: 2;
    strategy: string;
  };
  beforeUsage: ContextUsageSnapshot;
  afterUsage: ContextUsageSnapshot;
  contractVersion: number;
  harnessStateVersion: number;
  harnessBinding?: {
    schemaVersion: number;
    stateHash: string;
  };
  goalBinding?: {
    goalId: string;
    revision: number;
    stateHash: string;
  };
  candidateReceipt: {
    source: 'semantic_candidate' | 'compatibility_adapter';
    candidateFingerprint: string;
    persistedProjectionFingerprint: string;
    beforeTokens: number;
    afterTokens: number;
    targetTokens?: number;
    targetRatio: number;
    semanticSummary?: QueryCompactCommit['semanticSummary'];
    semanticSummaryHash?: string;
    diagnostics: QueryCompactCommit['diagnostics'];
    coverageHash?: string;
    /** Source identity captured before semantic candidate preparation. */
    prepareSource?: CompactPrepareSourceReceipt;
    /** Deterministic semantic checks completed before the sidecar was written. */
    semanticValidation?: CompactSemanticValidationReceipt;
  };
  validation: {
    schemaValid: true;
    toolCallGroupsValid: true;
    sourcePrefixVerified: true;
    targetHeadroomRatio: number;
    achievedUsageRatio: number;
    targetMet: true;
    prepareSourceVerified?: true;
    candidateTokensVerified?: true;
    semanticReceiptVerified?: true;
    bindingHash: string;
    validatedAt: number;
  };
}

/**
 * Immutable source identity captured before compact candidate preparation.
 * `activeCheckpointId` is explicit so the first checkpoint can CAS against null.
 */
export interface CompactPrepareSourceReceipt {
  schemaVersion: 1;
  sessionId: string;
  sourceMessageCount: number;
  sourcePrefixHash: string;
  activeCheckpointId: string | null;
}

export interface CompactSemanticValidationReceipt {
  schemaValid: true;
  coverageValid: true;
  taskEpoch: number;
  taskEpochVerified: true;
  criterionEvidenceRefsValid: true;
  preservedCriterionIds: string[];
  validatedEvidenceRefs: string[];
}

export type CompactCheckpoint = CompactCheckpointV1 | CompactCheckpointV2;

export interface CommitCompactCheckpointInput {
  sessionId: string;
  mode: CompactCheckpointV1['mode'];
  modelId: string;
  sourceMessageCount: number;
  transcriptStartMessageIndex: number;
  modelHistory: Message[];
  summary: Omit<CompactCheckpointV1['summary'], 'sourceMessageCount'>;
  beforeUsage: ContextUsageSnapshot;
  afterUsage: ContextUsageSnapshot;
  /** Named compaction strategy recorded in the durable validation receipt. */
  strategy?: string;
  /** Task-contract schema used to construct the replacement history. */
  contractVersion?: number;
  /** Harness-state schema bound to this checkpoint. */
  harnessStateVersion?: number;
  /** Deterministic Harness snapshot bound to this checkpoint, but not duplicated in it. */
  harnessState?: HarnessState;
  /** Harness authority captured when the semantic candidate was prepared. */
  semanticHarnessState?: HarnessState;
  /** Active Goal snapshot identity bound to this checkpoint. */
  goalBinding?: {
    goalId: string;
    revision: number;
    state?: unknown;
  };
  /** Candidate-only metadata emitted by the semantic compact pipeline. */
  candidate?: Pick<
    QueryCompactCommit,
    'fingerprint' | 'beforeTokens' | 'afterTokens' | 'plan' | 'semanticSummary' | 'diagnostics'
  >;
  /** Required for semantic candidates; captured before candidate preparation. */
  prepareSource?: CompactPrepareSourceReceipt;
  createdAt?: number;
}

/** 历史记录条目 */
export interface HistoryEntry {
  /** 显示文本 */
  display: string;
  /** 时间戳 (ms) */
  timestamp: number;
  /** 项目路径 */
  project: string;
  /** 会话 ID */
  sessionId: string;
  /** 角色 */
  role: 'user' | 'assistant';
}

/** 对话消息 */
export interface SessionMessage {
  /** 角色 */
  role: 'user' | 'assistant' | 'system' | 'tool';
  /** 内容 */
  content: string;
  /** Compact content used when restoring this message into model context. */
  modelVisibleContent?: string;
  /** 时间戳 (ms) */
  timestamp: number;
  /** 工具调用 ID (tool role) */
  toolCallId?: string;
  /** 工具调用列表 (assistant role) */
  tool_calls?: ToolCallRecord[];
  /** Skills applied for this turn (usually stored on the user message). */
  appliedSkills?: string[];
}

export type SessionTraceEventType =
  | 'turn_start'
  | 'request_start'
  | 'provider_retry'
  | 'provider_fallback'
  | 'prompt_assembly'
  | 'assistant_tool_calls'
  | 'checkpoint'
  | 'tool_call'
  | 'permission_decision'
  | 'tool_result'
  | 'strategy_exhausted'
  | 'message'
  | 'complete'
  | 'local_fast_path'
  | 'workspace_snapshot'
  | 'workspace_delta'
  | 'verification_profile'
  | 'verification_result'
  | 'verification_summary'
  | 'aborted'
  | 'error'
  | 'subtask_requested'
  | 'subtask_started'
  | 'subtask_completed'
  | 'subtask_failed'
  | 'subtask_cancelled'
  | 'subtask_rejected'
  | 'subtask_timed_out'
  | 'subtask_artifact_stored'
  | 'compact_prepare'
  | 'compact_validate'
  | 'compact_commit'
  | 'compact_rollback'
  | 'compact_boundary'
  | 'compact_completed'
  | 'compact_failed'
  | 'goal_state';

export interface SessionTraceEvent {
  sessionId: string;
  turnId: string;
  timestamp: number;
  type: SessionTraceEventType;
  /** Additive active-Goal correlation. Absent on legacy/non-Goal traces. */
  goalId?: string;
  goalRevision?: number;
  goalInputKind?: import('../runtime/goals/types').AgentInputKind;
  /** Redacted terminal/continuation reason captured by the runtime. */
  goalStopReason?: string;
  model?: string;
  turn?: number;
  name?: string;
  callId?: string;
  argsSummary?: string;
  argsArtifactId?: string;
  argsBytes?: number;
  batchCount?: number;
  batchIndex?: number;
  permissionBehavior?: string;
  permissionApproved?: boolean;
  permissionSource?: string;
  permissionReason?: string;
  permissionDuration?: number;
  success?: boolean;
  duration?: number;
  inputBytes?: number;
  contentBytes?: number;
  outputBytes?: number;
  modelVisibleBytes?: number;
  toolCallCount?: number;
  artifactId?: string;
  checkpointId?: string;
  checkpointFileCount?: number;
  checkpointFiles?: string[];
  compactMode?: CompactCheckpointV1['mode'];
  compactStrategy?: string;
  compactCandidateFingerprint?: string;
  compactBeforeTokens?: number;
  compactAfterTokens?: number;
  compactTargetTokens?: number;
  compactTargetRatio?: number;
  compactDiagnosticsCount?: number;
  compactSourceMessageCount?: number;
  promptModelId?: string;
  promptEstimatedTokens?: number;
  promptBudgetTokens?: number;
  promptCoreTokens?: number;
  promptEvidenceBudgetTokens?: number;
  promptRecentTurnBudgetTokens?: number;
  promptSections?: string[];
  promptIncludedEvidence?: string[];
  promptOmittedEvidence?: string[];
  promptIncludedEvidenceCount?: number;
  promptOmittedEvidenceCount?: number;
  promptSectionManifest?: PromptSectionManifestEntry[];
  promptOverBudget?: boolean;
  promptCapabilityProfileVersion?: number;
  promptCapabilityProfileFingerprint?: string;
  finishReason?: LoopFinishReason;
  /** Typed boundary result; additive so legacy trace rows remain readable. */
  stopDecision?: StopDecision;
  llmRequests?: number;
  toolCalls?: number;
  readOnlyToolCalls?: number;
  unsafeToolCalls?: number;
  loopBudgetSource?: string;
  loopBudgetBaseProfile?: string;
  loopBudgetMaxLlmRequests?: number;
  loopBudgetMaxToolCalls?: number;
  loopBudgetMaxReadOnlyFragmentation?: number;
  loopBudgetMaxModelVisibleBytes?: number;
  loopBudgetConfigOverride?: boolean;
  budgetExceededReason?: string;
  localFastPathUsed?: boolean;
  providerRetryCount?: number;
  providerRetryDelayMs?: number;
  providerRetryErrorTypes?: string[];
  providerLastRetryErrorType?: string;
  providerLastRetryStatus?: number;
  providerFallbackCount?: number;
  providerFallbackFromModel?: string;
  providerFallbackToModel?: string;
  providerFinalModel?: string;
  providerUsingFallback?: boolean;
  continuationActions?: LoopContinuationAction[];
  continuationHint?: string;
  lastToolName?: string;
  lastToolSummary?: string;
  lastToolSuccess?: boolean;
  workspacePhase?: 'pre_turn' | 'post_turn';
  workspaceGitAvailable?: boolean;
  workspaceDirty?: boolean;
  workspaceBranch?: string;
  workspaceFileCount?: number;
  workspaceFiles?: string[];
  workspaceNewByTurn?: string[];
  workspaceChangedByTurn?: string[];
  workspaceModifiedPreExistingByTurn?: string[];
  workspaceResolvedByTurn?: string[];
  verificationProfile?: string;
  verificationRequired?: boolean;
  verificationRisky?: boolean;
  verificationCommands?: string[];
  verificationChangedFiles?: string[];
  verificationCommand?: string;
  verificationPassed?: boolean;
  verificationClaimAllowed?: boolean;
  verificationPassedCommands?: string[];
  verificationFailedCommands?: string[];
  verificationMissingCommands?: string[];
  error?: string;
  note?: string;
}

export { redactTraceText } from './redaction';

function sanitizeTraceEvent(
  event: Omit<SessionTraceEvent, 'sessionId' | 'timestamp'> & { timestamp?: number }
): Omit<SessionTraceEvent, 'sessionId' | 'timestamp'> & { timestamp?: number } {
  const sanitized = { ...event };
  if (sanitized.stopDecision) {
    sanitized.stopDecision = {
      ...sanitized.stopDecision,
      reason: {
        ...sanitized.stopDecision.reason,
        message: redactTraceText(sanitized.stopDecision.reason.message),
      },
      evidence: sanitized.stopDecision.evidence.map(item => ({
        ...item,
        source: redactTraceText(item.source),
        detail: redactTraceText(item.detail),
      })),
      nextActions: sanitized.stopDecision.nextActions.map(item => ({
        ...item,
        label: redactTraceText(item.label),
        command: item.command ? redactTraceText(item.command) : undefined,
      })),
      resources: Object.fromEntries(
        Object.entries(sanitized.stopDecision.resources).map(([key, value]) => [
          key,
          value ? { ...value } : value,
        ])
      ),
      criterionStates: sanitized.stopDecision.criterionStates?.map(item => ({
        ...item,
        id: redactTraceText(item.id),
      })),
      evidenceRefs: sanitized.stopDecision.evidenceRefs?.map(redactTraceText),
      progressDelta: sanitized.stopDecision.progressDelta
        ? {
            ...sanitized.stopDecision.progressDelta,
            criterionChanges: sanitized.stopDecision.progressDelta.criterionChanges.map(item => ({
              ...item,
              id: redactTraceText(item.id),
            })),
            newEvidenceRefs:
              sanitized.stopDecision.progressDelta.newEvidenceRefs.map(redactTraceText),
            newChangedFiles:
              sanitized.stopDecision.progressDelta.newChangedFiles.map(redactTraceText),
            newDecisions: sanitized.stopDecision.progressDelta.newDecisions.map(redactTraceText),
            newBlockers: sanitized.stopDecision.progressDelta.newBlockers.map(redactTraceText),
            newDiagnostics:
              sanitized.stopDecision.progressDelta.newDiagnostics.map(redactTraceText),
          }
        : undefined,
    };
  }
  for (const key of [
    'argsSummary',
    'error',
    'note',
    'permissionReason',
    'continuationHint',
    'goalStopReason',
    'budgetExceededReason',
    'lastToolSummary',
  ] as const) {
    if (typeof sanitized[key] === 'string') {
      sanitized[key] = redactTraceText(sanitized[key]);
    }
  }
  if (sanitized.workspaceFiles) {
    sanitized.workspaceFiles = sanitized.workspaceFiles.map(redactTraceText);
  }
  if (sanitized.checkpointFiles) {
    sanitized.checkpointFiles = sanitized.checkpointFiles.map(redactTraceText);
  }
  if (sanitized.promptSections) {
    sanitized.promptSections = sanitized.promptSections.map(redactTraceText);
  }
  if (sanitized.promptIncludedEvidence) {
    sanitized.promptIncludedEvidence = sanitized.promptIncludedEvidence.map(redactTraceText);
  }
  if (sanitized.promptOmittedEvidence) {
    sanitized.promptOmittedEvidence = sanitized.promptOmittedEvidence.map(redactTraceText);
  }
  if (sanitized.promptSectionManifest) {
    sanitized.promptSectionManifest = sanitized.promptSectionManifest.map(item => ({
      ...item,
      name: redactTraceText(item.name),
      source: redactTraceText(item.source),
      reason: item.reason ? redactTraceText(item.reason) : undefined,
    }));
  }
  if (sanitized.workspaceChangedByTurn) {
    sanitized.workspaceChangedByTurn = sanitized.workspaceChangedByTurn.map(redactTraceText);
  }
  if (sanitized.workspaceNewByTurn) {
    sanitized.workspaceNewByTurn = sanitized.workspaceNewByTurn.map(redactTraceText);
  }
  if (sanitized.workspaceModifiedPreExistingByTurn) {
    sanitized.workspaceModifiedPreExistingByTurn =
      sanitized.workspaceModifiedPreExistingByTurn.map(redactTraceText);
  }
  if (sanitized.workspaceResolvedByTurn) {
    sanitized.workspaceResolvedByTurn = sanitized.workspaceResolvedByTurn.map(redactTraceText);
  }
  if (sanitized.verificationCommands) {
    sanitized.verificationCommands = sanitized.verificationCommands.map(redactTraceText);
  }
  if (typeof sanitized.verificationCommand === 'string') {
    sanitized.verificationCommand = redactTraceText(sanitized.verificationCommand);
  }
  if (sanitized.providerRetryErrorTypes) {
    sanitized.providerRetryErrorTypes = sanitized.providerRetryErrorTypes.map(redactTraceText);
  }
  for (const key of [
    'providerLastRetryErrorType',
    'providerFallbackFromModel',
    'providerFallbackToModel',
    'providerFinalModel',
  ] as const) {
    if (typeof sanitized[key] === 'string') {
      sanitized[key] = redactTraceText(sanitized[key]);
    }
  }
  if (sanitized.verificationChangedFiles) {
    sanitized.verificationChangedFiles = sanitized.verificationChangedFiles.map(redactTraceText);
  }
  if (sanitized.verificationPassedCommands) {
    sanitized.verificationPassedCommands =
      sanitized.verificationPassedCommands.map(redactTraceText);
  }
  if (sanitized.verificationFailedCommands) {
    sanitized.verificationFailedCommands =
      sanitized.verificationFailedCommands.map(redactTraceText);
  }
  if (sanitized.verificationMissingCommands) {
    sanitized.verificationMissingCommands =
      sanitized.verificationMissingCommands.map(redactTraceText);
  }
  return sanitized;
}

export interface ListSessionsOptions {
  /** Filter sessions to this canonical project. */
  projectPath?: string;
  /** Include sessions from all projects. Overrides projectPath. */
  allProjects?: boolean;
  /** Include sessions without transcript messages. Defaults to true. */
  includeEmpty?: boolean;
}

export type SessionLookupResult =
  | { status: 'found'; session: SessionMeta }
  | { status: 'not_found' }
  | { status: 'ambiguous'; matches: SessionMeta[] };

// ============================================================================
// Project helpers
// ============================================================================

const MAX_CACHE_SIZE = 256;
const SESSION_CATALOG_VERSION = 1;

interface SessionCatalog {
  version: typeof SESSION_CATALOG_VERSION;
  sessions: Record<string, SessionMeta>;
}

interface SessionCatalogCache {
  path: string;
  mtimeMs: number;
  size: number;
  catalog: SessionCatalog;
}

let sessionCatalogCache: SessionCatalogCache | null = null;

function getSessionCatalogPath(): string {
  return join(getConfigDir(), 'session-catalog.json');
}

function emptySessionCatalog(): SessionCatalog {
  return { version: SESSION_CATALOG_VERSION, sessions: {} };
}

/**
 * Evict the oldest entries when a Map exceeds MAX_CACHE_SIZE.
 * Simple LRU approximation: delete the first (oldest) entries until
 * the map is within bounds. Called after each insertion.
 */
function evictOldest<K, V>(map: Map<K, V>, maxSize: number): void {
  while (map.size > maxSize) {
    const firstKey = map.keys().next().value;
    if (firstKey !== undefined) map.delete(firstKey);
    else break;
  }
}

const resolvedProjectPathCache = new Map<string, string>();

/**
 * Resolve a working directory to the project identity used for session storage.
 * Git repositories share sessions from the repository root; non-git folders use
 * their real absolute path.
 */
export function resolveProjectPath(cwd: string = process.cwd()): string {
  const absolute = resolve(cwd);
  const cached = resolvedProjectPathCache.get(absolute);
  if (cached) {
    return cached;
  }

  let resolvedPath = absolute;

  if (existsSync(absolute)) {
    try {
      const root = execFileSync('git', ['-C', absolute, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (root) {
        resolvedPath = realpathSync(root);
        resolvedProjectPathCache.set(absolute, resolvedPath);
        evictOldest(resolvedProjectPathCache, MAX_CACHE_SIZE);
        return resolvedPath;
      }
    } catch (error) {
      // Not a git worktree, or git is unavailable.
      debugError('session-storage.resolveGitRoot', error, absolute);
    }
  }

  try {
    resolvedPath = realpathSync(absolute);
  } catch (error) {
    // Broken symlink or concurrent deletion; the literal path still works
    // as a stable project key.
    debugError('session-storage.realpath', error, absolute);
    resolvedPath = absolute;
  }

  resolvedProjectPathCache.set(absolute, resolvedPath);
  evictOldest(resolvedProjectPathCache, MAX_CACHE_SIZE);
  return resolvedPath;
}

export function getProjectKey(projectPath: string): string {
  return encodeProjectPath(resolveProjectPath(projectPath));
}

function getGitBranch(projectPath: string): string | undefined {
  if (!existsSync(projectPath)) {
    return undefined;
  }

  try {
    const branch = execFileSync('git', ['-C', projectPath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return branch || undefined;
  } catch (error) {
    // Detached HEAD, no git, or not a repository — branch metadata is
    // optional, but "why is my branch missing" is a real support question.
    debugError('session-storage.currentBranch', error, projectPath);
    return undefined;
  }
}

function normalizeSessionMeta(session: SessionMeta): SessionMeta {
  const projectPath = resolveProjectPath(session.projectPath);
  const startTime = session.startTime ?? Date.now();
  const updatedAt = session.updatedAt ?? session.endTime ?? startTime;

  return {
    ...session,
    projectPath,
    projectKey: session.projectKey ?? encodeProjectPath(projectPath),
    cwd: session.cwd ?? projectPath,
    startTime,
    createdAt: session.createdAt ?? new Date(startTime).toISOString(),
    updatedAt,
    updatedAtIso: session.updatedAtIso ?? new Date(updatedAt).toISOString(),
    messageCount: session.messageCount ?? 0,
    historySizeBytes:
      session.historySizeBytes ?? computeSessionHistorySizeBytes({ id: session.id, projectPath }),
    tokenCount: session.tokenCount ?? 0,
    cost: session.cost ?? 0,
    gitBranch: session.gitBranch ?? getGitBranch(projectPath),
  };
}

function tryNormalizeSessionMeta(session: SessionMeta, sourcePath: string): SessionMeta | null {
  try {
    return normalizeSessionMeta(session);
  } catch (error) {
    debugError('session-storage.normalizeSessionMeta', error, sourcePath);
    return null;
  }
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function parseSessionMetaFile(path: string): SessionMeta | null {
  try {
    const content = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(content) as Partial<SessionMeta>;
    if (typeof parsed.id !== 'string' || !parsed.id) {
      console.warn(`[session-storage] meta file missing valid id: ${path}`);
      return null;
    }
    if (typeof parsed.projectPath !== 'string' || !parsed.projectPath) {
      console.warn(`[session-storage] meta file missing valid projectPath: ${path}`);
      return null;
    }
    return parsed as SessionMeta;
  } catch (err) {
    console.warn(
      `[session-storage] failed to parse meta file ${path}: ${err instanceof Error ? err.message : err}`
    );
    return null;
  }
}

export function isSessionMetaFile(file: string): boolean {
  return file.endsWith('.json') && !SESSION_SIDECAR_SUFFIXES.some(s => file.endsWith(s));
}

/** Shared exclusion list for session sidecar files. */
export const SESSION_SIDECAR_SUFFIXES = [
  '.messages.json',
  '.harness.json',
  '.compact.json',
  '.runtime.json',
  '.trace.json',
  '.goal.json',
  '.index.json',
];

function readSessionCatalogFile(path: string): SessionCatalog | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SessionCatalog>;
    if (
      parsed.version !== SESSION_CATALOG_VERSION ||
      !parsed.sessions ||
      typeof parsed.sessions !== 'object' ||
      Array.isArray(parsed.sessions)
    ) {
      return null;
    }

    for (const [id, session] of Object.entries(parsed.sessions)) {
      if (
        !session ||
        session.id !== id ||
        typeof session.projectPath !== 'string' ||
        !session.projectPath
      ) {
        return null;
      }
    }
    return parsed as SessionCatalog;
  } catch (error) {
    debugError('session-storage.readCatalog', error, path);
    return null;
  }
}

function cacheSessionCatalog(path: string, catalog: SessionCatalog): SessionCatalog {
  try {
    const stat = statSync(path);
    sessionCatalogCache = { path, mtimeMs: stat.mtimeMs, size: stat.size, catalog };
  } catch (error) {
    debugError('session-storage.cacheCatalog', error, path);
    sessionCatalogCache = null;
  }
  return catalog;
}

function readCachedSessionCatalog(path: string): SessionCatalog | null {
  if (!existsSync(path)) return null;
  try {
    const stat = statSync(path);
    if (
      sessionCatalogCache?.path === path &&
      sessionCatalogCache.mtimeMs === stat.mtimeMs &&
      sessionCatalogCache.size === stat.size
    ) {
      return sessionCatalogCache.catalog;
    }
  } catch (error) {
    debugError('session-storage.statCatalog', error, path);
    return null;
  }

  const catalog = readSessionCatalogFile(path);
  return catalog ? cacheSessionCatalog(path, catalog) : null;
}

function scanSessionCatalog(): SessionCatalog {
  const catalog = emptySessionCatalog();
  const projectsDir = getProjectsDir();
  if (!existsSync(projectsDir)) return catalog;

  for (const projectKey of readdirSync(projectsDir)) {
    const projectSessionsDir = join(projectsDir, projectKey, 'sessions');
    if (!existsSync(projectSessionsDir)) continue;
    for (const file of readdirSync(projectSessionsDir).filter(isSessionMetaFile)) {
      const sourcePath = join(projectSessionsDir, file);
      const rawSession = parseSessionMetaFile(sourcePath);
      if (!rawSession) continue;
      const normalized = tryNormalizeSessionMeta(rawSession, sourcePath);
      if (!normalized) continue;

      const previous = catalog.sessions[normalized.id];
      if (
        !previous ||
        (normalized.updatedAt ?? normalized.startTime) > (previous.updatedAt ?? previous.startTime)
      ) {
        catalog.sessions[normalized.id] = normalized;
      }
    }
  }
  return catalog;
}

function writeSessionCatalog(path: string, catalog: SessionCatalog): void {
  atomicWriteFileSync(path, JSON.stringify(catalog), { mode: 0o600 });
  cacheSessionCatalog(path, catalog);
}

function loadOrRebuildSessionCatalog(): SessionCatalog {
  ensureConfigDir();
  const path = getSessionCatalogPath();
  const cached = readCachedSessionCatalog(path);
  if (cached) return cached;

  return withFileLockSync(
    path,
    () => {
      const current = readCachedSessionCatalog(path);
      if (current) return current;
      const rebuilt = scanSessionCatalog();
      writeSessionCatalog(path, rebuilt);
      return rebuilt;
    },
    { waitMs: 10_000 }
  );
}

function updateSessionCatalog(update: (catalog: SessionCatalog) => void): SessionCatalog {
  ensureConfigDir();
  const path = getSessionCatalogPath();
  return withFileLockSync(
    path,
    () => {
      const catalog = readSessionCatalogFile(path) ?? scanSessionCatalog();
      update(catalog);
      writeSessionCatalog(path, catalog);
      return catalog;
    },
    { waitMs: 10_000 }
  );
}

function parseHarnessSidecarFile(path: string): HarnessSidecar | null {
  try {
    const content = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(content) as HarnessSidecar;
    return parsed?.version === 2 && parsed.state ? parsed : null;
  } catch (error) {
    // A corrupt sidecar silently drops resumable harness state, which the
    // user experiences as "my session lost its context".
    debugError('session-storage.parseHarnessSidecar', error, path);
    return null;
  }
}

function canonicalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalizeForHash(entry)])
  );
}

function canonicalContentHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeForHash(value)), 'utf-8')
    .digest('hex');
}

function compactBindingHash(parts: {
  sourcePrefixHash: string;
  modelHistoryHash: string;
  candidateFingerprint: string;
  persistedProjectionFingerprint: string;
  semanticSummaryHash?: string;
  prepareSourceHash?: string;
  semanticValidationHash?: string;
  harnessStateHash?: string;
  goalStateHash?: string;
}): string {
  return canonicalContentHash(parts);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validatePrepareSourceReceipt(
  receipt: CompactPrepareSourceReceipt,
  sessionId: string
): void {
  if (
    receipt.schemaVersion !== 1 ||
    receipt.sessionId !== sessionId ||
    !Number.isInteger(receipt.sourceMessageCount) ||
    receipt.sourceMessageCount < 0 ||
    !isSha256(receipt.sourcePrefixHash) ||
    (receipt.activeCheckpointId !== null &&
      (typeof receipt.activeCheckpointId !== 'string' || !receipt.activeCheckpointId))
  ) {
    throw new Error('Invalid compact prepare-source receipt');
  }
}

function assertPrepareSourceMatches(
  receipt: CompactPrepareSourceReceipt,
  session: SessionMeta,
  rawMessages: readonly SessionMessage[]
): void {
  validatePrepareSourceReceipt(receipt, session.id);
  const activeCheckpointId = session.activeCompactCheckpointId ?? null;
  if (activeCheckpointId !== receipt.activeCheckpointId) {
    throw new Error(
      `Stale compact candidate: active checkpoint changed from ${receipt.activeCheckpointId ?? 'none'} to ${activeCheckpointId ?? 'none'}`
    );
  }
  if (rawMessages.length !== receipt.sourceMessageCount) {
    throw new Error(
      `Stale compact candidate: source message count changed from ${receipt.sourceMessageCount} to ${rawMessages.length}`
    );
  }
  const prefixHash = canonicalContentHash(rawMessages);
  if (prefixHash !== receipt.sourcePrefixHash) {
    throw new Error('Stale compact candidate: source transcript hash changed during preparation');
  }
}

/** Capture the append-only transcript identity before preparing a compact candidate. */
export function prepareSessionCompactSourceReceipt(sessionId: string): CompactPrepareSourceReceipt {
  const receipt = withLockedSession(sessionId, session => {
    const rawMessages = readSessionMessagesForSession(session);
    return {
      schemaVersion: 1,
      sessionId,
      sourceMessageCount: rawMessages.length,
      sourcePrefixHash: canonicalContentHash(rawMessages),
      activeCheckpointId: session.activeCompactCheckpointId ?? null,
    } satisfies CompactPrepareSourceReceipt;
  });
  if (!receipt) throw new Error(`Session not found: ${sessionId}`);
  return receipt;
}

/**
 * Advance a prepare receipt only across the exact messages written by the
 * preparing turn. Any interleaved writer fails closed instead of being claimed
 * by a candidate that never observed its messages.
 */
export function advanceSessionCompactSourceReceipt(
  receipt: CompactPrepareSourceReceipt,
  appendedMessages: readonly SessionMessage[]
): CompactPrepareSourceReceipt {
  const advanced = withLockedSession(receipt.sessionId, session => {
    validatePrepareSourceReceipt(receipt, session.id);
    if ((session.activeCompactCheckpointId ?? null) !== receipt.activeCheckpointId) {
      throw new Error('Stale compact candidate: active checkpoint changed during preparation');
    }
    const rawMessages = readSessionMessagesForSession(session);
    if (
      rawMessages.length !== receipt.sourceMessageCount + appendedMessages.length ||
      canonicalContentHash(rawMessages.slice(0, receipt.sourceMessageCount)) !==
        receipt.sourcePrefixHash ||
      canonicalContentHash(rawMessages.slice(receipt.sourceMessageCount)) !==
        canonicalContentHash(appendedMessages)
    ) {
      throw new Error(
        'Stale compact candidate: transcript tail contains concurrent or unexpected messages'
      );
    }
    return {
      ...receipt,
      sourceMessageCount: rawMessages.length,
      sourcePrefixHash: canonicalContentHash(rawMessages),
    };
  });
  if (!advanced) throw new Error(`Session not found: ${receipt.sessionId}`);
  return advanced;
}

interface SemanticSummaryView {
  coverageGroupIds: string[];
  criterionStates: Array<{
    id: string;
    status: string;
    evidenceRefs: string[];
  }>;
  taskEpoch: number;
  taskEpochs: number[];
}

function inspectSemanticSummary(value: unknown): SemanticSummaryView {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error('Compact semantic summary schema is invalid');
  }
  if (!Number.isInteger(value.taskEpoch) || (value.taskEpoch as number) < 1) {
    throw new Error('Compact semantic summary taskEpoch is invalid');
  }
  for (const field of [
    'constraints',
    'decisions',
    'completed',
    'pending',
    'blockers',
    'files',
    'evidenceRefs',
  ] as const) {
    if (!isStringArray(value[field])) {
      throw new Error(`Compact semantic summary ${field} must be a string array`);
    }
  }
  if (!isRecord(value.coverage) || !isStringArray(value.coverage.groupIds)) {
    throw new Error('Compact semantic summary coverage is invalid');
  }
  const coverageGroupIds = value.coverage.groupIds;
  if (
    value.coverage.groupCount !== coverageGroupIds.length ||
    !Number.isInteger(value.coverage.messageCount) ||
    (value.coverage.messageCount as number) < 0
  ) {
    throw new Error('Compact semantic summary coverage counts are inconsistent');
  }

  if (!Array.isArray(value.items)) {
    throw new Error('Compact semantic summary items must be an array');
  }
  const taskEpochs: number[] = [];
  for (const item of value.items) {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      !item.id ||
      typeof item.groupId !== 'string' ||
      !item.groupId ||
      !isStringArray(item.sourceRefs) ||
      !Number.isInteger(item.tokenEstimate) ||
      (item.tokenEstimate as number) < 0 ||
      !Number.isInteger(item.taskEpoch) ||
      (item.taskEpoch as number) < 1 ||
      typeof item.text !== 'string'
    ) {
      throw new Error('Compact semantic summary contains an invalid ContextItem');
    }
    taskEpochs.push(item.taskEpoch as number);
  }

  const criterionStatesValue = value.criterionStates;
  if (criterionStatesValue !== undefined && !Array.isArray(criterionStatesValue)) {
    throw new Error('Compact semantic criterionStates must be an array');
  }
  const criterionStates = (criterionStatesValue ?? []).map(item => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      !item.id ||
      typeof item.statement !== 'string' ||
      !['pending', 'passed', 'failed', 'waived'].includes(String(item.status)) ||
      !isStringArray(item.evidenceRefs)
    ) {
      throw new Error('Compact semantic summary contains an invalid criterion state');
    }
    return {
      id: item.id,
      status: String(item.status),
      evidenceRefs: item.evidenceRefs,
    };
  });
  if (new Set(criterionStates.map(item => item.id)).size !== criterionStates.length) {
    throw new Error('Compact semantic summary contains duplicate criterion IDs');
  }

  return {
    coverageGroupIds,
    criterionStates,
    taskEpoch: value.taskEpoch as number,
    taskEpochs,
  };
}

function semanticValidationReceipt(
  semanticSummary: unknown,
  candidate: NonNullable<CommitCompactCheckpointInput['candidate']>,
  harnessState: HarnessState | undefined
): CompactSemanticValidationReceipt {
  const view = inspectSemanticSummary(semanticSummary);
  const expectedCoverage = candidate.plan.evictedGroups.map(group => group.id);
  if (!sameStrings(view.coverageGroupIds, expectedCoverage)) {
    throw new Error('Compact semantic summary does not cover the prepared evicted groups');
  }

  const expectedTaskEpoch = Math.max(
    1,
    Math.floor(
      harnessState?.taskEpoch ?? harnessState?.contract?.taskEpoch ?? view.taskEpochs[0] ?? 1
    )
  );
  if (
    view.taskEpoch !== expectedTaskEpoch ||
    view.taskEpochs.some(taskEpoch => taskEpoch !== expectedTaskEpoch)
  ) {
    throw new Error('Compact semantic summary taskEpoch does not match the active Harness epoch');
  }

  const contractCriteria = harnessState?.contract?.criteria ?? [];
  const expectedCriteria = contractCriteria.map(criterion => ({
    id: criterion.id,
    status: criterion.status ?? 'pending',
    evidenceRefs: [...criterion.evidenceRefs],
  }));
  if (expectedCriteria.length > 0) {
    if (view.criterionStates.length !== expectedCriteria.length) {
      throw new Error('Compact semantic summary omitted active task criteria');
    }
    for (const [index, expected] of expectedCriteria.entries()) {
      const actual = view.criterionStates[index];
      if (
        actual.id !== expected.id ||
        actual.status !== expected.status ||
        !sameStrings(actual.evidenceRefs, expected.evidenceRefs)
      ) {
        throw new Error(`Compact semantic criterion mismatch: ${expected.id}`);
      }
    }
  }

  const knownEvidenceRefs = new Set([
    ...(harnessState?.ledger.flatMap(item => [item.id, `ledger:${item.id}`]) ?? []),
    ...(harnessState?.evidenceIndex?.flatMap(item => [item.id, `evidence:${item.id}`]) ?? []),
    ...(harnessState?.capsule?.keyFacts.flatMap(item => [item.id, `fact:${item.id}`]) ?? []),
  ]);
  const validatedEvidenceRefs = [
    ...new Set(view.criterionStates.flatMap(item => item.evidenceRefs)),
  ];
  if (validatedEvidenceRefs.length > 0 && !harnessState) {
    throw new Error('Compact semantic evidence references require an authoritative Harness state');
  }
  for (const criterion of view.criterionStates) {
    if (criterion.status === 'passed' && criterion.evidenceRefs.length === 0) {
      throw new Error(`Passed compact criterion lacks evidence: ${criterion.id}`);
    }
    for (const evidenceRef of criterion.evidenceRefs) {
      if (!knownEvidenceRefs.has(evidenceRef)) {
        throw new Error(`Dangling compact criterion evidence reference: ${evidenceRef}`);
      }
    }
  }

  return {
    schemaValid: true,
    coverageValid: true,
    taskEpoch: expectedTaskEpoch,
    taskEpochVerified: true,
    criterionEvidenceRefsValid: true,
    preservedCriterionIds: view.criterionStates.map(item => item.id),
    validatedEvidenceRefs,
  };
}

function validatePersistedSemanticReceipt(
  semanticSummary: unknown,
  receipt: CompactSemanticValidationReceipt
): void {
  const view = inspectSemanticSummary(semanticSummary);
  if (
    receipt.schemaValid !== true ||
    receipt.coverageValid !== true ||
    receipt.taskEpochVerified !== true ||
    receipt.criterionEvidenceRefsValid !== true ||
    !Number.isInteger(receipt.taskEpoch) ||
    receipt.taskEpoch < 1 ||
    !isStringArray(receipt.preservedCriterionIds) ||
    !Array.isArray(receipt.validatedEvidenceRefs) ||
    !receipt.validatedEvidenceRefs.every(ref => typeof ref === 'string' && ref.length > 0) ||
    view.taskEpoch !== receipt.taskEpoch ||
    view.taskEpochs.some(taskEpoch => taskEpoch !== receipt.taskEpoch) ||
    !sameStrings(
      view.criterionStates.map(item => item.id),
      receipt.preservedCriterionIds
    ) ||
    !sameStrings(
      [...new Set(view.criterionStates.flatMap(item => item.evidenceRefs))],
      receipt.validatedEvidenceRefs
    )
  ) {
    throw new Error('Compact semantic validation receipt does not match its summary');
  }
}

function reportInvalidCompactCheckpoint(path: string, reason: string): null {
  debugError(
    'session-storage.validateCompactCheckpoint',
    new Error(`Invalid compact checkpoint: ${reason}`),
    path
  );
  return null;
}

function compactCandidatePath(path: string): string {
  return `${path}.candidate`;
}

function compactPreviousPath(path: string): string {
  return `${path}.previous`;
}

function parseCompactCheckpointFile(path: string): CompactCheckpoint | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as CompactCheckpoint;
    if (
      (parsed?.version !== 1 && parsed?.version !== 2) ||
      !parsed.checkpointId ||
      !parsed.sessionId ||
      !Array.isArray(parsed.modelHistory) ||
      !Number.isInteger(parsed.sourceMessageCount) ||
      parsed.sourceMessageCount < 0 ||
      !parsed.summary ||
      typeof parsed.summary.text !== 'string'
    ) {
      return reportInvalidCompactCheckpoint(path, 'base schema mismatch');
    }
    if (parsed.version === 1) return parsed;

    if (
      parsed.sourceBoundary?.startMessageIndex !== 0 ||
      parsed.sourceBoundary.endMessageIndexExclusive !== parsed.sourceMessageCount ||
      !isSha256(parsed.sourcePrefixHash) ||
      !isSha256(parsed.modelHistoryHash) ||
      parsed.summary.schemaVersion !== 2 ||
      typeof parsed.summary.strategy !== 'string' ||
      !parsed.summary.strategy ||
      !Number.isInteger(parsed.contractVersion) ||
      parsed.contractVersion < 1 ||
      !Number.isInteger(parsed.harnessStateVersion) ||
      parsed.harnessStateVersion < 1 ||
      parsed.validation?.schemaValid !== true ||
      parsed.validation.toolCallGroupsValid !== true ||
      parsed.validation.sourcePrefixVerified !== true ||
      parsed.validation.targetMet !== true ||
      !isSha256(parsed.validation.bindingHash) ||
      !Number.isFinite(parsed.validation.targetHeadroomRatio) ||
      !Number.isFinite(parsed.validation.achievedUsageRatio) ||
      !parsed.candidateReceipt ||
      !['semantic_candidate', 'compatibility_adapter'].includes(parsed.candidateReceipt.source) ||
      !isSha256(parsed.candidateReceipt.candidateFingerprint) ||
      !isSha256(parsed.candidateReceipt.persistedProjectionFingerprint) ||
      !Number.isInteger(parsed.candidateReceipt.beforeTokens) ||
      parsed.candidateReceipt.beforeTokens < 0 ||
      !Number.isInteger(parsed.candidateReceipt.afterTokens) ||
      parsed.candidateReceipt.afterTokens < 0 ||
      (parsed.candidateReceipt.targetTokens !== undefined &&
        (!Number.isInteger(parsed.candidateReceipt.targetTokens) ||
          parsed.candidateReceipt.targetTokens < 0)) ||
      !Number.isFinite(parsed.candidateReceipt.targetRatio) ||
      !Array.isArray(parsed.candidateReceipt.diagnostics) ||
      (parsed.harnessBinding !== undefined &&
        (!Number.isInteger(parsed.harnessBinding.schemaVersion) ||
          parsed.harnessBinding.schemaVersion < 1 ||
          !isSha256(parsed.harnessBinding.stateHash))) ||
      (parsed.goalBinding !== undefined &&
        (!parsed.goalBinding.goalId ||
          !Number.isInteger(parsed.goalBinding.revision) ||
          parsed.goalBinding.revision < 0 ||
          !isSha256(parsed.goalBinding.stateHash)))
    ) {
      return reportInvalidCompactCheckpoint(path, 'V2 receipt mismatch');
    }
    if (canonicalContentHash(parsed.modelHistory) !== parsed.modelHistoryHash) {
      return reportInvalidCompactCheckpoint(path, 'replacement history hash mismatch');
    }
    if (
      canonicalMessagesFingerprint(parsed.modelHistory) !==
      parsed.candidateReceipt.persistedProjectionFingerprint
    ) {
      return reportInvalidCompactCheckpoint(path, 'persisted projection fingerprint mismatch');
    }
    const semanticSummaryHash = parsed.candidateReceipt.semanticSummary
      ? canonicalContentHash(parsed.candidateReceipt.semanticSummary)
      : undefined;
    if (semanticSummaryHash !== parsed.candidateReceipt.semanticSummaryHash) {
      return reportInvalidCompactCheckpoint(path, 'semantic summary hash mismatch');
    }
    const coverageHash = parsed.candidateReceipt.semanticSummary
      ? canonicalContentHash(parsed.candidateReceipt.semanticSummary.coverage)
      : undefined;
    if (coverageHash !== parsed.candidateReceipt.coverageHash) {
      return reportInvalidCompactCheckpoint(path, 'semantic coverage hash mismatch');
    }
    if (parsed.candidateReceipt.source === 'semantic_candidate') {
      if (
        !parsed.candidateReceipt.prepareSource ||
        !parsed.candidateReceipt.semanticSummary ||
        !parsed.candidateReceipt.semanticValidation ||
        parsed.validation.prepareSourceVerified !== true ||
        parsed.validation.candidateTokensVerified !== true ||
        parsed.validation.semanticReceiptVerified !== true
      ) {
        return reportInvalidCompactCheckpoint(path, 'semantic candidate validation is incomplete');
      }
      try {
        validatePrepareSourceReceipt(parsed.candidateReceipt.prepareSource, parsed.sessionId);
        if (
          parsed.candidateReceipt.prepareSource.sourceMessageCount !== parsed.sourceMessageCount ||
          parsed.candidateReceipt.prepareSource.sourcePrefixHash !== parsed.sourcePrefixHash
        ) {
          return reportInvalidCompactCheckpoint(path, 'prepare-source boundary mismatch');
        }
        validatePersistedSemanticReceipt(
          parsed.candidateReceipt.semanticSummary,
          parsed.candidateReceipt.semanticValidation
        );
      } catch (error) {
        return reportInvalidCompactCheckpoint(
          path,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
    const prepareSourceHash = parsed.candidateReceipt.prepareSource
      ? canonicalContentHash(parsed.candidateReceipt.prepareSource)
      : undefined;
    const semanticValidationHash = parsed.candidateReceipt.semanticValidation
      ? canonicalContentHash(parsed.candidateReceipt.semanticValidation)
      : undefined;
    const expectedBindingHash = compactBindingHash({
      sourcePrefixHash: parsed.sourcePrefixHash,
      modelHistoryHash: parsed.modelHistoryHash,
      candidateFingerprint: parsed.candidateReceipt.candidateFingerprint,
      persistedProjectionFingerprint: parsed.candidateReceipt.persistedProjectionFingerprint,
      semanticSummaryHash,
      prepareSourceHash,
      semanticValidationHash,
      harnessStateHash: parsed.harnessBinding?.stateHash,
      goalStateHash: parsed.goalBinding?.stateHash,
    });
    if (expectedBindingHash !== parsed.validation.bindingHash) {
      return reportInvalidCompactCheckpoint(path, 'cross-state binding hash mismatch');
    }
    try {
      assertToolCallGroups(parsed.modelHistory);
    } catch (error) {
      debugError('session-storage.validateCompactCheckpoint.toolGroups', error, path);
      return null;
    }
    return parsed;
  } catch (error) {
    // Losing a compact checkpoint means the next resume replays the full
    // history instead of the summary — degraded, not fatal.
    debugError('session-storage.parseCompactCheckpoint', error, path);
    return null;
  }
}

function sortSessionsNewestFirst(sessions: SessionMeta[]): SessionMeta[] {
  return sessions.sort((a, b) => (b.updatedAt ?? b.startTime) - (a.updatedAt ?? a.startTime));
}

function safeFileSize(path: string): number | null {
  try {
    return existsSync(path) ? statSync(path).size : null;
  } catch (error) {
    // Size is only used for reporting; an unreadable file reports as unknown.
    debugError('session-storage.safeFileSize', error, path);
    return null;
  }
}

function computeSessionHistorySizeBytes(session: Pick<SessionMeta, 'id' | 'projectPath'>): number {
  return safeFileSize(getProjectSessionMessagesPath(session.projectPath, session.id)) ?? 0;
}

// ============================================================================
// 会话管理
// ============================================================================

/**
 * 创建新会话
 */
export function createSession(projectPath: string, model: string): SessionMeta {
  ensureConfigDir();
  const canonicalProjectPath = resolveProjectPath(projectPath);
  const now = Date.now();

  const session: SessionMeta = {
    id: randomUUID(),
    projectPath: canonicalProjectPath,
    projectKey: encodeProjectPath(canonicalProjectPath),
    cwd: resolve(projectPath),
    model,
    startTime: now,
    createdAt: new Date(now).toISOString(),
    updatedAt: now,
    updatedAtIso: new Date(now).toISOString(),
    messageCount: 0,
    gitBranch: getGitBranch(canonicalProjectPath),
    tokenCount: 0,
    cost: 0,
  };

  saveSessionMeta(session);
  return session;
}

/**
 * 保存会话元数据
 */
export function saveSessionMeta(session: SessionMeta): void {
  ensureConfigDir();
  const normalized = normalizeSessionMeta(session);
  ensureProjectDir(normalized.projectPath);
  const metaPath = getProjectSessionMetaPath(normalized.projectPath, normalized.id);
  withFileLockSync(metaPath, () => {
    writeSessionMetaUnlocked(normalized);
  });
}

function writeSessionMetaUnlocked(session: SessionMeta): void {
  const normalized = normalizeSessionMeta(session);
  ensureProjectDir(normalized.projectPath);
  const metaPath = getProjectSessionMetaPath(normalized.projectPath, normalized.id);
  atomicWriteFileSync(metaPath, JSON.stringify(normalized, null, 2), { mode: 0o600 });
  updateSessionCatalog(catalog => {
    catalog.sessions[normalized.id] = normalized;
  });
}

function findSessionMetaPath(sessionId: string): string | null {
  const catalog = loadOrRebuildSessionCatalog();
  const indexed = catalog.sessions[sessionId];
  const findUnindexedCandidate = (): string | null => {
    const projectsDir = getProjectsDir();
    if (!existsSync(projectsDir)) return null;
    for (const projectKey of readdirSync(projectsDir)) {
      const candidate = join(projectsDir, projectKey, 'sessions', `${sessionId}.json`);
      const session = existsSync(candidate) ? readSessionMetaAtPath(candidate) : null;
      if (!session) continue;
      updateSessionCatalog(current => {
        current.sessions[session.id] = session;
      });
      return candidate;
    }
    return null;
  };

  if (!indexed) return findUnindexedCandidate();

  const path = getProjectSessionMetaPath(indexed.projectPath, sessionId);
  if (existsSync(path)) return path;

  const migratedPath = findUnindexedCandidate();
  if (migratedPath) return migratedPath;

  updateSessionCatalog(current => {
    delete current.sessions[sessionId];
  });
  return null;
}

function readSessionMetaAtPath(path: string): SessionMeta | null {
  const session = parseSessionMetaFile(path);
  return session ? tryNormalizeSessionMeta(session, path) : null;
}

function loadRawSessionMeta(sessionId: string): SessionMeta | null {
  const path = findSessionMetaPath(sessionId);
  return path ? readSessionMetaAtPath(path) : null;
}

/**
 * Serialize a session read-modify-write transaction across Orion processes.
 * The metadata path is rediscovered before each transaction and re-read only
 * after the lock is held, so a stale snapshot can never overwrite a concurrent
 * message/stat update.
 */
function withLockedSession<T>(sessionId: string, operation: (session: SessionMeta) => T): T | null {
  const metaPath = findSessionMetaPath(sessionId);
  if (!metaPath) return null;

  return withFileLockSync(
    metaPath,
    () => {
      const session = readSessionMetaAtPath(metaPath);
      if (!session) return null;
      return operation(session);
    },
    { waitMs: 10_000 }
  );
}

function mutateSessionMeta(
  sessionId: string,
  mutation: (session: SessionMeta) => void
): SessionMeta | null {
  return withLockedSession(sessionId, session => {
    mutation(session);
    writeSessionMetaUnlocked(session);
    return session;
  });
}

export function updateSessionEffort(
  sessionId: string,
  effortPreference: EffortPreference | undefined
): SessionMeta | null {
  return mutateSessionMeta(sessionId, session => {
    if (effortPreference === undefined || effortPreference === 'auto') {
      delete session.effortPreference;
    } else {
      session.effortPreference = effortPreference;
    }
  });
}

/** Persist the model selected for one Session without replacing unrelated metadata. */
export function updateSessionModel(sessionId: string, model: string): SessionMeta | null {
  const normalizedModel = model.trim();
  if (!normalizedModel) throw new Error('Session model must not be empty.');
  return mutateSessionMeta(sessionId, session => {
    session.model = normalizedModel;
    session.updatedAt = Date.now();
    session.updatedAtIso = new Date(session.updatedAt).toISOString();
  });
}

export interface SessionThreadReadModelV1 {
  readonly threadId: string;
  readonly cursor: number;
  readonly projectionDigest: string;
  readonly cutoverGeneration: number;
  readonly lastRecordHash: string | null;
  readonly logDevice: string;
  readonly logInode: string;
  readonly logMtimeNs: string;
  readonly logCtimeNs: string;
  readonly messageCount: number;
  readonly historySizeBytes: number;
  readonly updatedAt: number;
}

/**
 * Persist the bounded Session-list projection derived from an authoritative
 * v2 Thread. List and picker paths consume this catalog projection directly;
 * they must never replay every Thread merely to render metadata.
 */
export function updateSessionThreadReadModel(
  sessionId: string,
  input: SessionThreadReadModelV1
): SessionMeta | null {
  if (!input.threadId.trim()) throw new Error('Session Thread id must not be empty.');
  if (!Number.isSafeInteger(input.cursor) || input.cursor < 0) {
    throw new Error('Session Thread cursor must be a non-negative safe integer.');
  }
  if (!input.projectionDigest.trim()) {
    throw new Error('Session Thread projection digest must not be empty.');
  }
  if (!Number.isSafeInteger(input.cutoverGeneration) || input.cutoverGeneration < 1) {
    throw new Error('Session Thread cutover generation must be a positive safe integer.');
  }
  if (input.lastRecordHash !== null && !/^[a-f0-9]{64}$/i.test(input.lastRecordHash)) {
    throw new Error('Session Thread last record hash must be a SHA-256 digest or null.');
  }
  for (const [name, value] of [
    ['logDevice', input.logDevice],
    ['logInode', input.logInode],
    ['logMtimeNs', input.logMtimeNs],
    ['logCtimeNs', input.logCtimeNs],
  ] as const) {
    if (!/^\d+$/.test(value)) throw new Error(`Session Thread ${name} must be an integer string.`);
  }
  if (!Number.isSafeInteger(input.messageCount) || input.messageCount < 0) {
    throw new Error('Session Thread messageCount must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(input.historySizeBytes) || input.historySizeBytes < 0) {
    throw new Error('Session Thread historySizeBytes must be a non-negative safe integer.');
  }
  if (!Number.isFinite(input.updatedAt) || input.updatedAt < 0) {
    throw new Error('Session Thread updatedAt must be a non-negative finite timestamp.');
  }
  return withLockedSession(sessionId, session => {
    const nextUpdatedAt = Math.max(session.updatedAt ?? session.startTime, input.updatedAt);
    const current = session.threadReadModel;
    const unchanged =
      session.messageCount === input.messageCount &&
      session.historySizeBytes === input.historySizeBytes &&
      session.updatedAt === nextUpdatedAt &&
      current?.version === 1 &&
      current.threadId === input.threadId &&
      current.cursor === input.cursor &&
      current.projectionDigest === input.projectionDigest &&
      current.cutoverGeneration === input.cutoverGeneration &&
      current.lastRecordHash === input.lastRecordHash &&
      current.logDevice === input.logDevice &&
      current.logInode === input.logInode &&
      current.logMtimeNs === input.logMtimeNs &&
      current.logCtimeNs === input.logCtimeNs;
    if (unchanged) return session;

    session.messageCount = input.messageCount;
    session.historySizeBytes = input.historySizeBytes;
    session.threadReadModel = {
      version: 1,
      threadId: input.threadId,
      cursor: input.cursor,
      projectionDigest: input.projectionDigest,
      cutoverGeneration: input.cutoverGeneration,
      lastRecordHash: input.lastRecordHash,
      logDevice: input.logDevice,
      logInode: input.logInode,
      logMtimeNs: input.logMtimeNs,
      logCtimeNs: input.logCtimeNs,
    };
    // Selecting a Session is itself recent activity. A background projection
    // refresh must not reorder it backwards to the timestamp of its last fact.
    session.updatedAt = nextUpdatedAt;
    session.updatedAtIso = new Date(session.updatedAt).toISOString();
    writeSessionMetaUnlocked(session);
    return session;
  });
}

/**
 * 加载会话元数据
 */
export function loadSessionMeta(sessionId: string): SessionMeta | null {
  return loadRawSessionMeta(sessionId);
}

/**
 * 更新会话统计
 */
export function updateSessionStats(sessionId: string, tokens: number, cost: number): void {
  mutateSessionMeta(sessionId, session => {
    session.tokenCount += tokens;
    session.cost += cost;
    session.updatedAt = Date.now();
    session.updatedAtIso = new Date(session.updatedAt).toISOString();
  });
}

/**
 * Mark a saved session as active again and refresh project metadata.
 */
export function resumeSession(sessionId: string): SessionMeta | null {
  return withLockedSession(sessionId, current => {
    // Session selection is not new conversation activity. Once a Session is
    // already open, do not rewrite its metadata/catalog merely because the UI
    // selected it again. This keeps /resume off the fsync path while preserving
    // the one durable ended -> active transition.
    if (current.endTime === undefined) return current;
    current.endTime = undefined;
    current.gitBranch ??= getGitBranch(current.projectPath);
    current.updatedAt = Date.now();
    current.updatedAtIso = new Date(current.updatedAt).toISOString();
    writeSessionMetaUnlocked(current);
    return current;
  });
}

/** Keep the session metadata's additive Goal binding in sync with its sidecar. */
export function updateSessionGoalBinding(
  sessionId: string,
  goal: { goalId: string; objective: string } | null
): SessionMeta | null {
  return mutateSessionMeta(sessionId, session => {
    session.activeGoalId = goal?.goalId;
    session.activeGoalObjective = goal?.objective;
    session.updatedAt = Date.now();
    session.updatedAtIso = new Date(session.updatedAt).toISOString();
  });
}

/**
 * Clear a completed Goal binding without clobbering a newer Goal selected by
 * another Orion process. A missing binding is already converged; a different
 * binding is a lifecycle conflict and fails closed.
 */
export function clearSessionGoalBinding(
  sessionId: string,
  expectedGoalId: string
): SessionMeta | null {
  return mutateSessionMeta(sessionId, session => {
    if (session.activeGoalId && session.activeGoalId !== expectedGoalId) {
      throw new Error(
        `Session Goal binding changed from ${expectedGoalId} to ${session.activeGoalId}; refusing to clear the newer Goal.`
      );
    }
    session.activeGoalId = undefined;
    session.activeGoalObjective = undefined;
    session.updatedAt = Date.now();
    session.updatedAtIso = new Date(session.updatedAt).toISOString();
  });
}

/**
 * Restore a Goal binding after a later sidecar mutation failed. A different
 * active binding belongs to a newer lifecycle and must never be overwritten.
 */
export function restoreSessionGoalBinding(
  sessionId: string,
  goal: { goalId: string; objective: string },
  expectedClearedAt: number
): SessionMeta | null {
  return mutateSessionMeta(sessionId, session => {
    if (session.activeGoalId && session.activeGoalId !== goal.goalId) {
      throw new Error(
        `Session Goal binding changed from ${goal.goalId} to ${session.activeGoalId}; refusing to overwrite the newer Goal during rollback.`
      );
    }
    if (!session.activeGoalId && session.updatedAt !== expectedClearedAt) {
      throw new Error(
        `Session metadata changed after Goal ${goal.goalId} was cleared; refusing to overwrite newer session state during rollback.`
      );
    }
    session.activeGoalId = goal.goalId;
    session.activeGoalObjective = goal.objective;
    session.updatedAt = Date.now();
    session.updatedAtIso = new Date(session.updatedAt).toISOString();
  });
}

/**
 * 更新会话 Harness 状态。
 */
export function updateSessionHarnessState(sessionId: string, harnessState: HarnessState): void {
  withLockedSession(sessionId, session => {
    const fullState = upgradeHarnessState(harnessState, {
      cwd: session.cwd ?? session.projectPath,
    });
    const sidecar: HarnessSidecar = {
      version: 2,
      sessionId,
      projectPath: session.projectPath,
      state: fullState,
      contextCapsule: fullState.capsule,
      updatedAt: Date.now(),
      diagnostics: fullState.diagnostics,
    };

    ensureProjectDir(session.projectPath);
    atomicWriteFileSync(
      getProjectSessionHarnessPath(session.projectPath, sessionId),
      JSON.stringify(sidecar, null, 2),
      { mode: 0o600 }
    );

    session.harnessState = summarizeHarnessStateForMeta(fullState);
    session.contextCapsule = fullState.capsule;
    session.updatedAt = Date.now();
    session.updatedAtIso = new Date(session.updatedAt).toISOString();
    writeSessionMetaUnlocked(session);
  });
}

export function loadSessionHarnessState(sessionId: string): HarnessState | null {
  const session = loadSessionMeta(sessionId);
  if (!session) return null;
  return restoreLegacyHarnessState(session, readSessionMessages(sessionId));
}

export function updateSessionSkills(sessionId: string, skills: string[]): void {
  if (skills.length === 0) return;
  mutateSessionMeta(sessionId, session => {
    session.skillsUsed = [...new Set([...(session.skillsUsed || []), ...skills])];
    session.updatedAt = Date.now();
    session.updatedAtIso = new Date(session.updatedAt).toISOString();
  });
}

export function markSessionTranscriptDisplayStart(
  sessionId: string,
  timestamp: number = Date.now()
): SessionMeta | null {
  return mutateSessionMeta(sessionId, session => {
    session.transcriptDisplayStartTime = timestamp;
    session.updatedAt = timestamp;
    session.updatedAtIso = new Date(timestamp).toISOString();
  });
}

export function persistSessionCompactHistory(
  sessionId: string,
  messages: Message[],
  timestamp: number = Date.now()
): SessionMeta | null {
  const session = loadSessionMeta(sessionId);
  if (!session) return null;

  const compactMessages = messages.map(
    message =>
      ({
        role: message.role,
        content: message.content,
        timestamp,
        toolCallId: message.tool_call_id,
        tool_calls: message.tool_calls,
      }) satisfies SessionMessage
  );

  appendSessionMessages(sessionId, compactMessages);
  return markSessionTranscriptDisplayStart(sessionId, timestamp);
}

function loadCompactCheckpointForSession(
  session: SessionMeta,
  messages: SessionMessage[]
): CompactCheckpoint | null {
  const compactPath = getProjectSessionCompactPath(session.projectPath, session.id);
  const candidatePaths = [compactPath, compactPreviousPath(compactPath)];
  for (const path of candidatePaths) {
    if (!existsSync(path)) continue;
    const checkpoint = parseCompactCheckpointFile(path);
    if (!checkpoint || checkpoint.sessionId !== session.id) continue;
    if (session.activeCompactCheckpointId !== checkpoint.checkpointId) continue;
    if (checkpoint.sourceMessageCount > messages.length) continue;
    if (
      checkpoint.version === 2 &&
      canonicalContentHash(messages.slice(0, checkpoint.sourceMessageCount)) !==
        checkpoint.sourcePrefixHash
    ) {
      reportInvalidCompactCheckpoint(path, 'covered transcript prefix hash mismatch');
      continue;
    }
    return checkpoint;
  }
  return null;
}

export function loadSessionCompactCheckpoint(sessionId: string): CompactCheckpoint | null {
  return (
    withLockedSession(sessionId, session =>
      loadCompactCheckpointForSession(session, readSessionMessagesForSession(session))
    ) ?? null
  );
}

export function commitSessionCompactCheckpoint(
  input: CommitCompactCheckpointInput
): CompactCheckpointV2 {
  const checkpoint = withLockedSession(input.sessionId, session => {
    const rawMessages = readSessionMessagesForSession(session);
    const rawCount = rawMessages.length;
    if (input.candidate && !input.prepareSource) {
      throw new Error('Semantic compact candidate requires a prepare-source receipt');
    }
    if (input.prepareSource) {
      if (input.prepareSource.sourceMessageCount !== input.sourceMessageCount) {
        throw new Error('Compact source boundary differs from its prepare-source receipt');
      }
      assertPrepareSourceMatches(input.prepareSource, session, rawMessages);
    }
    if (input.sourceMessageCount < 0 || input.sourceMessageCount > rawCount) {
      throw new Error(
        `Invalid compact source boundary ${input.sourceMessageCount}; transcript has ${rawCount} messages`
      );
    }

    const createdAt = input.createdAt ?? Date.now();
    const candidateModelHistory = input.modelHistory.map(
      message => JSON.parse(JSON.stringify(message)) as Message
    );
    assertToolCallGroups(candidateModelHistory);
    const modelHistory = input.modelHistory
      .filter(message => message.role !== 'system')
      .map(message => JSON.parse(JSON.stringify(message)) as Message);
    assertToolCallGroups(modelHistory);

    const targetHeadroomRatio = 0.65;
    const safeInputBudget = Math.max(
      1,
      input.afterUsage.safeInputBudget ?? input.afterUsage.contextWindow
    );
    const achievedUsageRatio = input.afterUsage.usedTokens / safeInputBudget;
    if (!Number.isFinite(achievedUsageRatio) || achievedUsageRatio > targetHeadroomRatio) {
      throw new Error(
        `Compact candidate did not reach the required ${Math.round(
          targetHeadroomRatio * 100
        )}% safe-input headroom target (${Math.round(achievedUsageRatio * 100)}% used)`
      );
    }

    const sourcePrefixHash = canonicalContentHash(rawMessages.slice(0, input.sourceMessageCount));
    const modelHistoryHash = canonicalContentHash(modelHistory);
    const persistedProjectionFingerprint = canonicalMessagesFingerprint(modelHistory);
    const candidateBeforeTokens = input.candidate?.beforeTokens ?? input.beforeUsage.usedTokens;
    const candidateAfterTokens = input.candidate?.afterTokens ?? input.afterUsage.usedTokens;
    const candidateTargetRatio = input.candidate?.plan.targetRatio ?? targetHeadroomRatio;
    const candidateFingerprint = input.candidate?.fingerprint ?? persistedProjectionFingerprint;
    for (const [name, value] of [
      ['beforeTokens', candidateBeforeTokens],
      ['afterTokens', candidateAfterTokens],
    ] as const) {
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`Compact candidate ${name} must be a non-negative integer`);
      }
    }
    if (!isSha256(candidateFingerprint)) {
      throw new Error('Compact candidate fingerprint must be a SHA-256 digest');
    }
    if (input.candidate) {
      const actualCandidateTokens = estimateMessagesTokens(candidateModelHistory);
      if (candidateAfterTokens !== actualCandidateTokens) {
        throw new Error(
          `Compact candidate afterTokens ${candidateAfterTokens} does not match actual history ${actualCandidateTokens}`
        );
      }
      if (
        input.candidate.plan.targetTokens !== undefined &&
        candidateAfterTokens > input.candidate.plan.targetTokens
      ) {
        throw new Error('Compact candidate exceeds its prepared target token budget');
      }
    }
    if (
      !Number.isFinite(candidateTargetRatio) ||
      candidateTargetRatio <= 0 ||
      candidateTargetRatio > targetHeadroomRatio
    ) {
      throw new Error(`Compact candidate target ratio must be within (0, ${targetHeadroomRatio}]`);
    }
    const semanticSummary = input.candidate
      ? (JSON.parse(
          JSON.stringify(input.candidate.semanticSummary)
        ) as QueryCompactCommit['semanticSummary'])
      : undefined;
    const semanticSummaryHash = semanticSummary ? canonicalContentHash(semanticSummary) : undefined;
    const coverageHash = semanticSummary
      ? canonicalContentHash(semanticSummary.coverage)
      : undefined;
    const semanticValidation =
      input.candidate && semanticSummary
        ? semanticValidationReceipt(
            semanticSummary,
            input.candidate,
            input.semanticHarnessState ?? input.harnessState
          )
        : undefined;
    const prepareSource = input.prepareSource
      ? ({ ...input.prepareSource } satisfies CompactPrepareSourceReceipt)
      : undefined;
    const harnessBinding = input.harnessState
      ? {
          schemaVersion: input.harnessState.version ?? input.harnessStateVersion ?? 2,
          stateHash: canonicalContentHash(input.harnessState),
        }
      : undefined;
    const goalBinding = input.goalBinding
      ? {
          goalId: input.goalBinding.goalId,
          revision: input.goalBinding.revision,
          stateHash: canonicalContentHash(
            input.goalBinding.state ?? {
              goalId: input.goalBinding.goalId,
              revision: input.goalBinding.revision,
            }
          ),
        }
      : undefined;
    const candidateReceipt: CompactCheckpointV2['candidateReceipt'] = {
      source: input.candidate ? 'semantic_candidate' : 'compatibility_adapter',
      candidateFingerprint,
      persistedProjectionFingerprint,
      beforeTokens: candidateBeforeTokens,
      afterTokens: candidateAfterTokens,
      targetTokens: input.candidate?.plan.targetTokens,
      targetRatio: candidateTargetRatio,
      semanticSummary,
      semanticSummaryHash,
      diagnostics:
        input.candidate?.diagnostics.map(diagnostic => ({
          ...diagnostic,
          message: redactTraceText(diagnostic.message),
        })) ?? [],
      coverageHash,
      prepareSource,
      semanticValidation,
    };
    const prepareSourceHash = prepareSource ? canonicalContentHash(prepareSource) : undefined;
    const semanticValidationHash = semanticValidation
      ? canonicalContentHash(semanticValidation)
      : undefined;
    const bindingHash = compactBindingHash({
      sourcePrefixHash,
      modelHistoryHash,
      candidateFingerprint,
      persistedProjectionFingerprint,
      semanticSummaryHash,
      prepareSourceHash,
      semanticValidationHash,
      harnessStateHash: harnessBinding?.stateHash,
      goalStateHash: goalBinding?.stateHash,
    });

    const nextCheckpoint: CompactCheckpointV2 = {
      version: 2,
      checkpointId: randomUUID(),
      sessionId: input.sessionId,
      createdAt,
      mode: input.mode,
      modelId: input.modelId,
      sourceMessageCount: input.sourceMessageCount,
      transcriptStartMessageIndex: Math.max(
        0,
        Math.min(input.sourceMessageCount, input.transcriptStartMessageIndex)
      ),
      sourceBoundary: {
        startMessageIndex: 0,
        endMessageIndexExclusive: input.sourceMessageCount,
      },
      sourcePrefixHash,
      modelHistory,
      modelHistoryHash,
      summary: {
        ...input.summary,
        sourceMessageCount: input.sourceMessageCount,
        schemaVersion: 2,
        strategy:
          input.strategy ??
          (input.summary.source === 'llm' ? 'semantic-llm-v2' : 'deterministic-fallback-v2'),
      },
      beforeUsage: { ...input.beforeUsage },
      afterUsage: { ...input.afterUsage },
      contractVersion: (() => {
        const derivedContractVersion = input.harnessState?.contract?.version ?? 1;
        if (
          input.contractVersion !== undefined &&
          input.harnessState?.contract?.version !== undefined &&
          input.contractVersion !== derivedContractVersion
        ) {
          throw new Error(
            `Compact contractVersion ${input.contractVersion} does not match Harness contract ${derivedContractVersion}`
          );
        }
        return input.contractVersion ?? derivedContractVersion;
      })(),
      harnessStateVersion: harnessBinding?.schemaVersion ?? input.harnessStateVersion ?? 2,
      harnessBinding,
      goalBinding,
      candidateReceipt,
      validation: {
        schemaValid: true,
        toolCallGroupsValid: true,
        sourcePrefixVerified: true,
        targetHeadroomRatio,
        achievedUsageRatio,
        targetMet: true,
        prepareSourceVerified: prepareSource ? true : undefined,
        candidateTokensVerified: input.candidate ? true : undefined,
        semanticReceiptVerified: semanticValidation ? true : undefined,
        bindingHash,
        validatedAt: createdAt,
      },
    };

    const previousId = session.activeCompactCheckpointId;
    const previousTime = session.lastCompactAt;
    const previousUpdatedAt = session.updatedAt;
    const previousUpdatedAtIso = session.updatedAtIso;
    const compactPath = getProjectSessionCompactPath(session.projectPath, input.sessionId);
    const candidatePath = compactCandidatePath(compactPath);
    const previousPath = compactPreviousPath(compactPath);

    // Recover a process that crashed after installing a new sidecar but before
    // committing its pointer. The previous file is keyed by the durable pointer.
    if (existsSync(previousPath)) {
      const installed = existsSync(compactPath) ? parseCompactCheckpointFile(compactPath) : null;
      const previous = parseCompactCheckpointFile(previousPath);
      if (
        previousId &&
        installed?.checkpointId !== previousId &&
        previous?.checkpointId === previousId
      ) {
        if (existsSync(compactPath)) unlinkSync(compactPath);
        renameSync(previousPath, compactPath);
      } else if (installed?.checkpointId === previousId) {
        unlinkSync(previousPath);
      } else {
        throw new Error('Cannot reconcile interrupted compact checkpoint transaction');
      }
    }

    atomicWriteFileSync(candidatePath, JSON.stringify(nextCheckpoint, null, 2), { mode: 0o600 });
    const prepared = parseCompactCheckpointFile(candidatePath);
    if (prepared?.version !== 2 || prepared.checkpointId !== nextCheckpoint.checkpointId) {
      if (existsSync(candidatePath)) unlinkSync(candidatePath);
      throw new Error('Compact candidate failed durable reload validation');
    }

    let previousInstalled = false;
    let candidateInstalled = false;
    try {
      if (existsSync(compactPath)) {
        renameSync(compactPath, previousPath);
        previousInstalled = true;
      }
      renameSync(candidatePath, compactPath);
      candidateInstalled = true;

      session.activeCompactCheckpointId = nextCheckpoint.checkpointId;
      session.lastCompactAt = createdAt;
      session.updatedAt = createdAt;
      session.updatedAtIso = new Date(createdAt).toISOString();
      writeSessionMetaUnlocked(session);

      const persistedSession = readSessionMetaAtPath(
        getProjectSessionMetaPath(session.projectPath, session.id)
      );
      const persistedCheckpoint = parseCompactCheckpointFile(compactPath);
      if (
        persistedSession?.activeCompactCheckpointId !== nextCheckpoint.checkpointId ||
        persistedCheckpoint?.checkpointId !== nextCheckpoint.checkpointId
      ) {
        throw new Error('Compact checkpoint commit could not be read back atomically');
      }
    } catch (error) {
      session.activeCompactCheckpointId = previousId;
      session.lastCompactAt = previousTime;
      session.updatedAt = previousUpdatedAt;
      session.updatedAtIso = previousUpdatedAtIso;

      if (candidateInstalled && existsSync(compactPath)) unlinkSync(compactPath);
      if (previousInstalled && existsSync(previousPath)) renameSync(previousPath, compactPath);
      if (existsSync(candidatePath)) unlinkSync(candidatePath);

      const persistedSession = readSessionMetaAtPath(
        getProjectSessionMetaPath(session.projectPath, session.id)
      );
      if (persistedSession?.activeCompactCheckpointId === nextCheckpoint.checkpointId) {
        writeSessionMetaUnlocked(session);
      }
      throw error;
    }

    if (existsSync(previousPath)) {
      try {
        unlinkSync(previousPath);
      } catch (error) {
        debugError('session-storage.compactPreviousCleanup', error, previousPath);
      }
    }

    return nextCheckpoint;
  });
  if (!checkpoint) throw new Error(`Session not found: ${input.sessionId}`);
  return checkpoint;
}

export function loadSessionTranscriptMessages(sessionId: string): SessionMessage[] {
  const rawSession = loadRawSessionMeta(sessionId);
  if (rawSession) {
    const threadSummary = loadThreadSessionSummaryV1(rawSession.projectPath, rawSession.id);
    if (threadSummary) {
      return threadSummary.transcriptMessages.map(threadTranscriptMessageToSessionMessage);
    }
  }
  return (
    withLockedSession(sessionId, session => {
      const messages = readSessionMessagesForSession(session);
      const checkpoint = loadCompactCheckpointForSession(session, messages);
      if (checkpoint) {
        return messages.slice(checkpoint.transcriptStartMessageIndex);
      }

      return typeof session.transcriptDisplayStartTime === 'number'
        ? messages.filter(
            message => (message.timestamp ?? 0) >= (session.transcriptDisplayStartTime ?? 0)
          )
        : messages;
    }) ?? []
  );
}

function threadTranscriptMessageToSessionMessage(
  message: ThreadSessionTranscriptMessageV1
): SessionMessage {
  return {
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    ...(message.modelVisibleContent ? { modelVisibleContent: message.modelVisibleContent } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.tool_calls ? { tool_calls: structuredClone(message.tool_calls) } : {}),
    ...(message.appliedSkills ? { appliedSkills: [...message.appliedSkills] } : {}),
  };
}

function hasPersistedCompactContext(messages: SessionMessage[]): boolean {
  return messages.some(
    message =>
      message.content.includes('[Orion Code Context State v2]') ||
      message.content.includes('[Context Summary]') ||
      message.content.includes('## Context Capsule')
  );
}

/**
 * 结束会话
 */
export function endSession(sessionId: string): void {
  mutateSessionMeta(sessionId, session => {
    session.endTime = Date.now();
    session.updatedAt = session.endTime;
    session.updatedAtIso = new Date(session.updatedAt).toISOString();
  });
}

/**
 * 更新会话任务摘要
 * 从会话消息中提取关键信息并更新元数据
 */
function summarizeSessionMessages(
  messages: SessionMessage[]
): Pick<SessionMeta, 'toolsUsed' | 'filesModified' | 'taskSummary' | 'messageCount'> {
  const toolsUsed: string[] = [];
  const filesModified: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolsUsed.push(tc.function.name);

        // 从 write_file, edit_file 工具参数中提取文件路径
        if (tc.function.name === 'write_file' || tc.function.name === 'edit_file') {
          try {
            const args = JSON.parse(tc.function.arguments);
            if (args.path) {
              filesModified.push(args.path);
            }
          } catch (error) {
            // Malformed tool arguments only affect the "files modified"
            // summary, so the entry is skipped rather than failing the read.
            debugError('session-storage.parseToolArgs', error, tc.function.name);
          }
        }
      }
    }
  }

  // 提取任务摘要（从第一个用户消息）
  const firstUserMsg = messages.find(m => m.role === 'user' && m.content);
  const taskText = redactTraceText(firstUserMsg?.content ?? '');
  const taskSummary = taskText.length > 100 ? `${taskText.slice(0, 100)}...` : taskText;

  return {
    toolsUsed: [...new Set(toolsUsed)],
    filesModified: [...new Set(filesModified)],
    taskSummary,
    messageCount: messages.length,
  };
}

function mergeMessageSummary(session: SessionMeta, message: SessionMessage): void {
  if (!session.taskSummary && message.role === 'user' && message.content) {
    const taskText = redactTraceText(message.content);
    session.taskSummary = taskText.length > 100 ? `${taskText.slice(0, 100)}...` : taskText;
  }
  if (message.role !== 'assistant' || !message.tool_calls) return;

  const tools = new Set(session.toolsUsed ?? []);
  const files = new Set(session.filesModified ?? []);
  for (const toolCall of message.tool_calls) {
    tools.add(toolCall.function.name);
    if (toolCall.function.name !== 'write_file' && toolCall.function.name !== 'edit_file') continue;
    try {
      const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
      if (typeof args.path === 'string') files.add(args.path);
    } catch (error) {
      debugError('session-storage.parseToolArgs', error, toolCall.function.name);
    }
  }
  session.toolsUsed = [...tools];
  session.filesModified = [...files];
}

export function updateSessionSummary(sessionId: string, _messages: SessionMessage[]): void {
  // Callers may hold a stale transcript snapshot. Re-read under the same lock
  // used by append/delete so reconciliation can never roll metadata backwards.
  withLockedSession(sessionId, session => {
    const summary = summarizeSessionMessages(readSessionMessagesForSession(session));

    session.toolsUsed = summary.toolsUsed;
    session.filesModified = summary.filesModified;
    session.taskSummary = summary.taskSummary;
    session.messageCount = summary.messageCount;
    session.historySizeBytes = computeSessionHistorySizeBytes(session);
    session.updatedAt = Date.now();
    session.updatedAtIso = new Date(session.updatedAt).toISOString();
    writeSessionMetaUnlocked(session);
  });
}

/**
 * 获取项目最近的会话
 */
export function getLastSession(projectPath: string): SessionMeta | null {
  const sessions = filterSessionsWithRestorableHistory(listProjectSessions(projectPath));
  return sessions[0] ?? null;
}

/**
 * Keep pre-read-model v2 Sessions discoverable without replaying their logs.
 * An indexed Thread with no bound read model is "unknown", not "empty"; its
 * metadata is repaired lazily when that target is actually opened.
 */
export function filterSessionsWithRestorableHistory(
  sessions: readonly SessionMeta[]
): SessionMeta[] {
  const threadSessionsByProject = new Map<
    string,
    Readonly<Record<string, ThreadCutoverIndexEntryV1>>
  >();
  const threadSessions = (
    projectPath: string
  ): Readonly<Record<string, ThreadCutoverIndexEntryV1>> => {
    const cached = threadSessionsByProject.get(projectPath);
    if (cached) return cached;
    let entries: Readonly<Record<string, ThreadCutoverIndexEntryV1>> = {};
    try {
      entries = loadThreadCutoverIndexV1(projectPath).sessions;
    } catch (error) {
      debugError('session-storage.restorableThreadIndex', error, projectPath);
    }
    threadSessionsByProject.set(projectPath, entries);
    return entries;
  };

  return sessions.filter(session => {
    if ((session.messageCount ?? 0) > 0) return true;
    const entry = threadSessions(session.projectPath)[session.id];
    if (!entry) return false;
    const readModel = session.threadReadModel;
    if (!readModel || readModel.threadId !== entry.threadId) return true;
    try {
      const stats = statSync(
        join(getProjectThreadsV2Dir(session.projectPath), `${readModel.threadId}.events.v1.jsonl`),
        { bigint: true }
      );
      const headStillCurrent =
        stats.size === BigInt(session.historySizeBytes ?? -1) &&
        stats.dev.toString() === readModel.logDevice &&
        stats.ino.toString() === readModel.logInode &&
        stats.mtimeNs.toString() === readModel.logMtimeNs &&
        stats.ctimeNs.toString() === readModel.logCtimeNs;
      return !headStillCurrent;
    } catch {
      // Missing or unreadable authoritative facts must remain discoverable so
      // an explicit restore can surface the isolated corruption diagnostic.
      return true;
    }
  });
}

// ============================================================================
// 历史记录 (JSONL)
// ============================================================================

/**
 * 追加历史记录
 */
export function appendHistory(entry: HistoryEntry): void {
  ensureConfigDir();
  const path = getHistoryPath();
  const line = JSON.stringify(entry) + '\n';
  appendFileSync(path, line, { mode: 0o600 });
}

/**
 * 读取历史记录
 * @param limit 最大条数（从最新开始）
 */
export function readHistory(limit?: number): HistoryEntry[] {
  const path = getHistoryPath();

  if (!existsSync(path)) {
    return [];
  }

  try {
    const content = readFileSync(path, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    // Parse each line individually — skip corrupted lines instead of losing all history.
    const entries: HistoryEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as HistoryEntry);
      } catch (error) {
        // Skip corrupted line, preserve remaining valid entries.
        debugError('session-storage.parseHistoryLine', error);
      }
    }

    // 从最新开始
    const reversed = entries.reverse();
    return limit ? reversed.slice(0, limit) : reversed;
  } catch (error) {
    // An unreadable history file presents as "no history at all", which is
    // indistinguishable from a fresh install without this signal.
    debugError('session-storage.readHistory', error, path);
    return [];
  }
}

/**
 * 按项目过滤历史记录
 */
export function readProjectHistory(projectPath: string, limit?: number): HistoryEntry[] {
  const all = readHistory();
  const filtered = all.filter(e => e.project === projectPath);
  return limit ? filtered.slice(0, limit) : filtered;
}

// ============================================================================
// 会话对话记录 (JSONL)
// ============================================================================

/**
 * 追加会话消息
 */
export function appendSessionMessage(sessionId: string, message: SessionMessage): void {
  ensureConfigDir();
  const line = JSON.stringify(message) + '\n';
  withLockedSession(sessionId, session => {
    ensureProjectDir(session.projectPath);
    appendFileSync(getProjectSessionMessagesPath(session.projectPath, sessionId), line, {
      mode: 0o600,
    });

    // Keep transcript, metadata, and search index inside the same session
    // critical section so concurrent processes cannot lose counters.
    updateSessionIndex(sessionId, session.projectPath, message);
    mergeMessageSummary(session, message);
    session.updatedAt = Date.now();
    session.updatedAtIso = new Date(session.updatedAt).toISOString();
    session.messageCount = (session.messageCount ?? 0) + 1;
    session.historySizeBytes = computeSessionHistorySizeBytes(session);
    writeSessionMetaUnlocked(session);
  });
}

/**
 * 追加多条会话消息
 */
export function appendSessionMessages(sessionId: string, messages: SessionMessage[]): void {
  if (messages.length === 0) return;

  ensureConfigDir();
  const lines = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
  withLockedSession(sessionId, session => {
    ensureProjectDir(session.projectPath);
    appendFileSync(getProjectSessionMessagesPath(session.projectPath, sessionId), lines, {
      mode: 0o600,
    });

    for (const message of messages) {
      updateSessionIndex(sessionId, session.projectPath, message);
      mergeMessageSummary(session, message);
    }
    session.updatedAt = Date.now();
    session.updatedAtIso = new Date(session.updatedAt).toISOString();
    session.messageCount = (session.messageCount ?? 0) + messages.length;
    session.historySizeBytes = computeSessionHistorySizeBytes(session);
    writeSessionMetaUnlocked(session);
  });
}

function isFinalAssistantMessage(message: SessionMessage): boolean {
  return message.role === 'assistant' && (!message.tool_calls || message.tool_calls.length === 0);
}

function findLastCompleteBoundary(messages: SessionMessage[]): number {
  const lastUserIndex = messages.map(message => message.role).lastIndexOf('user');
  if (lastUserIndex < 0) {
    return messages.length;
  }

  const tail = messages.slice(lastUserIndex + 1);
  if (tail.some(isFinalAssistantMessage)) {
    return messages.length;
  }
  // No final assistant answer follows the last user prompt: the turn is
  // incomplete. Keep the user prompt itself (lastUserIndex + 1) and only drop
  // the partial assistant/tool tail — an abort must not delete what the user
  // actually typed (Issue #49: off-by-one previously returned lastUserIndex and
  // sliced the prompt away).
  return lastUserIndex + 1;
}

function overwriteSessionMessagesUnlocked(session: SessionMeta, messages: SessionMessage[]): void {
  const content =
    messages.length > 0 ? messages.map(message => JSON.stringify(message)).join('\n') + '\n' : '';

  ensureProjectDir(session.projectPath);
  atomicWriteFileSync(getProjectSessionMessagesPath(session.projectPath, session.id), content, {
    mode: 0o600,
  });

  deleteSessionIndex(session.id, session.projectPath);
  for (const message of messages) {
    updateSessionIndex(session.id, session.projectPath, message);
  }
  session.messageCount = messages.length;
  session.historySizeBytes = computeSessionHistorySizeBytes(session);
  const summary = summarizeSessionMessages(messages);
  session.toolsUsed = summary.toolsUsed;
  session.filesModified = summary.filesModified;
  session.taskSummary = summary.taskSummary;
  session.updatedAt = Date.now();
  session.updatedAtIso = new Date(session.updatedAt).toISOString();
  writeSessionMetaUnlocked(session);
}

/**
 * Remove a trailing incomplete turn from the persisted session transcript.
 *
 * A complete turn ends with a final assistant message without tool calls. If an
 * abort happens after the user message, or after assistant/tool intermediates
 * but before the final assistant answer, the tail is removed so resume does not
 * resurrect partial state.
 */
export function truncateSessionToLastComplete(sessionId: string): SessionMessage[] {
  return (
    withLockedSession(sessionId, session => {
      const messages = readSessionMessagesForSession(session);
      const boundary = findLastCompleteBoundary(messages);
      if (boundary === messages.length) return messages;

      const truncated = messages.slice(0, boundary);
      overwriteSessionMessagesUnlocked(session, truncated);
      return truncated;
    }) ?? []
  );
}

export function removeLastIncompleteAssistantMessage(sessionId: string): SessionMessage[] {
  return truncateSessionToLastComplete(sessionId);
}

/**
 * Remove the trailing user message from a failed turn so a provider/tool
 * failure does not leave a dangling prompt in the persisted session that would
 * be replayed on resume. The caller must guarantee the trailing message was
 * appended by the turn that just failed (i.e. `persistAsUserMessage !== false`);
 * this is a no-op when the last message is not a user message.
 */
export function removeTrailingSessionUserMessage(sessionId: string): SessionMessage[] {
  return (
    withLockedSession(sessionId, session => {
      const messages = readSessionMessagesForSession(session);
      if (messages.length === 0) return messages;
      if (messages[messages.length - 1].role !== 'user') return messages;

      const truncated = messages.slice(0, -1);
      overwriteSessionMessagesUnlocked(session, truncated);
      return truncated;
    }) ?? []
  );
}

/**
 * 读取会话消息
 */
export function readSessionMessages(sessionId: string): SessionMessage[] {
  const session = loadRawSessionMeta(sessionId);
  if (!session) return [];

  return readSessionMessagesForSession(session);
}

function readSessionMessagesForSession(session: SessionMeta): SessionMessage[] {
  const sessionId = session.id;
  const path = getProjectSessionMessagesPath(session.projectPath, sessionId);
  if (!existsSync(path)) return [];

  try {
    const content = readFileSync(path, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const messages: SessionMessage[] = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        messages.push(JSON.parse(lines[i]) as SessionMessage);
      } catch (error) {
        // A single corrupted line must not silently truncate the whole session
        // (which would drop every later turn on resume). Skip only the bad line
        // and keep the rest, mirroring readHistory's behaviour. The corruption
        // is still recorded for observability (#68).
        debugError('session-storage.parseMessageLine', error, `${path}:${i + 1}`);
        continue;
      }
    }
    return messages;
  } catch (error) {
    // Silent truncation of a session to zero messages is the single worst
    // failure mode here — the user resumes into an apparently empty session.
    debugError('session-storage.readMessages', error, path);
    return [];
  }
}

export function appendSessionTraceEvent(
  sessionId: string,
  event: Omit<SessionTraceEvent, 'sessionId' | 'timestamp'> & { timestamp?: number }
): SessionTraceEvent | null {
  return withLockedSession(sessionId, session => {
    ensureConfigDir();
    const safeEvent = sanitizeTraceEvent(event);
    const traceEvent: SessionTraceEvent = {
      ...safeEvent,
      sessionId,
      turnId: String(safeEvent.turnId),
      timestamp: safeEvent.timestamp ?? Date.now(),
    };

    appendFileSync(
      getProjectSessionTracePath(session.projectPath, sessionId),
      `${JSON.stringify(traceEvent)}\n`,
      { mode: 0o600 }
    );
    return traceEvent;
  });
}

export function readSessionTraceEvents(sessionId: string): SessionTraceEvent[] {
  return (
    withLockedSession(sessionId, session => {
      const path = getProjectSessionTracePath(session.projectPath, sessionId);
      if (!existsSync(path)) return [];

      try {
        const content = readFileSync(path, 'utf-8');
        return content
          .trim()
          .split('\n')
          .filter(Boolean)
          .flatMap(line => {
            try {
              const parsed = JSON.parse(line) as Partial<SessionTraceEvent>;
              if (!parsed.type || !parsed.turnId || !parsed.timestamp) return [];
              const sanitized = sanitizeTraceEvent({
                ...parsed,
                turnId: String(parsed.turnId),
              } as Omit<SessionTraceEvent, 'sessionId' | 'timestamp'> & { timestamp?: number });
              return [
                {
                  ...sanitized,
                  sessionId,
                  turnId: String(sanitized.turnId),
                } as SessionTraceEvent,
              ];
            } catch (error) {
              // Drop only the malformed trace line, keep the rest of the trace.
              debugError('session-storage.parseTraceLine', error);
              return [];
            }
          });
      } catch (error) {
        // An empty trace looks like "nothing happened" instead of "trace
        // unreadable", which misleads anyone debugging a past run.
        debugError('session-storage.readTraceEvents', error, path);
        return [];
      }
    }) ?? []
  );
}

/**
 * 读取会话消息并转换为 Message 格式（用于恢复对话历史）
 * 包含完整的 tool_calls 信息，确保 LLM 能理解之前的工具调用
 */
export function loadSessionHistory(sessionId: string): Message[] {
  return loadSessionHistoryWithDiagnostics(sessionId).messages.map(message =>
    structuredClone(message)
  );
}

export interface SessionHistoryLoadResult {
  readonly messages: readonly Message[];
  readonly source: SessionHistoryResolvedSourceV1;
  readonly diagnostics: readonly SessionHistoryRecoveryDiagnosticV1[];
}

export interface SessionRestoreBundleV1 {
  readonly history: SessionHistoryLoadResult;
  readonly transcriptMessages: readonly SessionMessage[];
  readonly sourceMessageCount: number;
  readonly checkpoint: CompactCheckpoint | null;
  readonly harnessState?: HarnessState;
  /** Process-local verified Thread hand-off consumed exactly once by Session Runtime activation. */
  readonly runtimeActivation?: ThreadSessionRuntimeActivationV1;
}

/** Load provider-safe history together with any explicit recovery provenance. */
export function loadSessionHistoryWithDiagnostics(sessionId: string): SessionHistoryLoadResult {
  return loadSessionRestoreBundleInternal(sessionId, false).history;
}

/**
 * Capture every projection needed by /resume from one stable storage view.
 * A v2 target opens and verifies one ThreadEventStore; a legacy target reads
 * messages and its compact checkpoint under one Session lock.
 */
export function loadSessionRestoreBundle(sessionId: string): SessionRestoreBundleV1 {
  return loadSessionRestoreBundleInternal(sessionId, true);
}

function loadSessionRestoreBundleInternal(
  sessionId: string,
  includeRuntimeActivation: boolean
): SessionRestoreBundleV1 {
  const rawSession = loadRawSessionMeta(sessionId);
  if (rawSession) {
    const openedThread = includeRuntimeActivation
      ? openThreadSessionViewV1(rawSession.projectPath, rawSession.id)
      : undefined;
    const threadView =
      openedThread?.view ?? loadThreadSessionViewV1(rawSession.projectPath, rawSession.id);
    if (threadView) {
      const harnessState = restoreThreadHarnessState(rawSession, threadView);
      try {
        updateSessionThreadReadModel(sessionId, {
          threadId: threadView.threadId,
          cursor: threadView.cursor,
          projectionDigest: threadView.projectionDigest,
          cutoverGeneration: threadView.readModel.cutoverGeneration,
          lastRecordHash: threadView.readModel.lastRecordHash,
          logDevice: threadView.readModel.log.device,
          logInode: threadView.readModel.log.inode,
          logMtimeNs: threadView.readModel.log.mtimeNs,
          logCtimeNs: threadView.readModel.log.ctimeNs,
          messageCount: threadView.messageCount,
          historySizeBytes: threadView.historySizeBytes,
          updatedAt: threadView.updatedAt,
        });
      } catch (error) {
        debugError('session-storage.repairThreadReadModel', error, sessionId);
      }
      return {
        history: {
          messages: threadView.modelHistory.map(message => structuredClone(message)),
          source: threadView.modelHistorySource,
          diagnostics: threadView.diagnostics,
        },
        transcriptMessages: threadView.transcriptMessages.map(
          threadTranscriptMessageToSessionMessage
        ),
        sourceMessageCount: threadView.transcriptMessages.length,
        checkpoint: null,
        ...(harnessState ? { harnessState } : {}),
        ...(openedThread ? { runtimeActivation: openedThread.runtimeActivation } : {}),
      };
    }
  }
  return (
    withLockedSession(sessionId, session => {
      const messages = readSessionMessagesForSession(session);
      const harnessState = restoreLegacyHarnessState(session, messages);
      const checkpoint = loadCompactCheckpointForSession(session, messages);
      const transcriptMessages = checkpoint
        ? messages.slice(checkpoint.transcriptStartMessageIndex)
        : typeof session.transcriptDisplayStartTime === 'number'
          ? messages.filter(
              message => (message.timestamp ?? 0) >= (session.transcriptDisplayStartTime ?? 0)
            )
          : messages;
      return {
        history: {
          messages: restoreLegacyModelHistory(sessionId, session, messages, checkpoint),
          source: 'legacy' as const,
          diagnostics: [],
        },
        transcriptMessages,
        sourceMessageCount: messages.length,
        checkpoint,
        ...(harnessState ? { harnessState } : {}),
      };
    }) ?? {
      history: { messages: [], source: 'legacy', diagnostics: [] },
      transcriptMessages: [],
      sourceMessageCount: 0,
      checkpoint: null,
    }
  );
}

function restoreThreadHarnessState(
  session: SessionMeta,
  view: NonNullable<ReturnType<typeof loadThreadSessionViewV1>>
): HarnessState | null {
  if (!view.latestTurnCommit) {
    return restoreLegacyHarnessState(
      session,
      view.transcriptMessages.map(threadTranscriptMessageToSessionMessage)
    );
  }
  const commit = parseTurnCommitV1(view.latestTurnCommit.receipt);
  let state: HarnessState;
  try {
    state = JSON.parse(commit.taskContext) as HarnessState;
  } catch {
    throw new Error(`Session ${session.id} TurnCommit TaskContext is not valid JSON.`);
  }
  return upgradeHarnessState(state, {
    cwd: session.cwd ?? session.projectPath,
    messages: view.modelHistory.map(message => structuredClone(message)),
  });
}

function restoreLegacyHarnessState(
  session: SessionMeta,
  messages: readonly Message[]
): HarnessState | null {
  const sidecarPath = getProjectSessionHarnessPath(session.projectPath, session.id);
  const sidecar = existsSync(sidecarPath) ? parseHarnessSidecarFile(sidecarPath) : null;
  const state = sidecar?.state ?? session.harnessState ?? null;
  if (!state && messages.length === 0) return null;
  return upgradeHarnessState(state, {
    cwd: session.cwd ?? session.projectPath,
    messages: messages.map(message => structuredClone(message)),
  });
}

function restoreLegacyModelHistory(
  sessionId: string,
  session: SessionMeta,
  messages: SessionMessage[],
  checkpoint: CompactCheckpoint | null
): Message[] {
  if (checkpoint) {
    const restored = [
      ...checkpoint.modelHistory.map(message => ({ ...message })),
      ...messages.slice(checkpoint.sourceMessageCount).map(sessionMessageToModelMessage),
    ];
    if (checkpoint.version === 2) {
      try {
        assertToolCallGroups(restored);
        return restored;
      } catch (error) {
        // Never mutate or synthesize data inside a validated V2 replacement.
        debugError('session-storage.restoreCompactCheckpoint.toolGroups', error, sessionId);
        return sealToolCallGroups(messages.map(sessionMessageToModelMessage));
      }
    }
    return sealToolCallGroups(restored);
  }

  let modelVisibleMessages = messages;
  if (typeof session.transcriptDisplayStartTime === 'number') {
    const afterDisplayStart = messages.filter(
      message => (message.timestamp ?? 0) >= (session.transcriptDisplayStartTime ?? 0)
    );
    modelVisibleMessages = hasPersistedCompactContext(afterDisplayStart)
      ? afterDisplayStart
      : messages;
  }
  return sealToolCallGroups(modelVisibleMessages.map(sessionMessageToModelMessage));
}

function sessionMessageToModelMessage(message: SessionMessage): Message {
  const result: Message = {
    role: message.role,
    content: message.modelVisibleContent ?? message.content,
  };
  if (message.role === 'tool' && message.toolCallId) {
    result.tool_call_id = message.toolCallId;
  }
  if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
    result.tool_calls = message.tool_calls;
  }
  return result;
}

/**
 * 列出所有会话
 */
export function listSessions(limit?: number): SessionMeta[] {
  const sessions = sortSessionsNewestFirst(Object.values(loadOrRebuildSessionCatalog().sessions));
  return limit ? sessions.slice(0, limit) : sessions;
}

/**
 * List sessions for a single canonical project.
 */
export function listProjectSessions(projectPath: string, limit?: number): SessionMeta[] {
  const canonicalProjectPath = resolveProjectPath(projectPath);
  const sessions = sortSessionsNewestFirst(
    Object.values(loadOrRebuildSessionCatalog().sessions).filter(
      session => session.projectPath === canonicalProjectPath
    )
  );
  return limit ? sessions.slice(0, limit) : sessions;
}

/**
 * Find a session by full id, id prefix, or exact name. Project sessions are
 * searched by default; pass allProjects when the user explicitly asks.
 */
export function findSession(
  ref: string,
  projectPath?: string,
  options: { allProjects?: boolean } = {}
): SessionMeta | null {
  const result = lookupSessionRef(ref, projectPath, options);
  return result.status === 'found' ? result.session : null;
}

/**
 * Resolve a session reference and preserve ambiguity details for user-facing
 * conflict prompts.
 */
export function lookupSessionRef(
  ref: string,
  projectPath?: string,
  options: { allProjects?: boolean } = {}
): SessionLookupResult {
  const candidates =
    options.allProjects || !projectPath ? listSessions() : listProjectSessions(projectPath);
  return lookupSessionRefInSessions(ref, candidates);
}

/** Resolve a reference against an already-loaded picker snapshot. */
export function lookupSessionRefInSessions(
  ref: string,
  candidates: readonly SessionMeta[]
): SessionLookupResult {
  const query = ref.trim();
  if (!query) return { status: 'not_found' };

  const exactId = candidates.find(session => session.id === query);
  if (exactId) return { status: 'found', session: exactId };

  const exactNameMatches = candidates.filter(session => session.name === query);
  if (exactNameMatches.length === 1) {
    return { status: 'found', session: exactNameMatches[0] };
  }
  if (exactNameMatches.length > 1) {
    return { status: 'ambiguous', matches: exactNameMatches };
  }

  const prefixMatches = candidates.filter(
    session => session.id.startsWith(query) || session.name?.startsWith(query)
  );

  if (prefixMatches.length === 1) {
    return { status: 'found', session: prefixMatches[0] };
  }
  if (prefixMatches.length > 1) {
    return { status: 'ambiguous', matches: prefixMatches };
  }

  return { status: 'not_found' };
}

/**
 * Rename a session for easier picker/resume targeting.
 */
export function renameSession(sessionId: string, name: string): SessionMeta | null {
  const trimmed = name.trim();
  return mutateSessionMeta(sessionId, session => {
    session.name = trimmed || undefined;
    session.updatedAt = Date.now();
    session.updatedAtIso = new Date(session.updatedAt).toISOString();
  });
}

/**
 * 删除会话
 */
export function deleteSession(sessionId: string): boolean {
  return (
    withLockedSession(sessionId, session => {
      let deleted = false;
      const compactPath = getProjectSessionCompactPath(session.projectPath, sessionId);
      const paths = [
        getProjectSessionMetaPath(session.projectPath, sessionId),
        getProjectSessionMessagesPath(session.projectPath, sessionId),
        getProjectSessionHarnessPath(session.projectPath, sessionId),
        compactPath,
        compactCandidatePath(compactPath),
        compactPreviousPath(compactPath),
        getProjectSessionTracePath(session.projectPath, sessionId),
      ];

      // Preserve a durable deletion fence so a stale writer in another process
      // cannot recreate the Goal after the rest of the session is removed.
      const goalPath = join(getProjectSessionsDir(session.projectPath), `${sessionId}.goal.json`);
      const hadGoal = existsSync(goalPath);
      const goalDeletion = deleteGoal(session.projectPath, sessionId);
      if (!goalDeletion.ok) return false;
      if (hadGoal) deleted = true;

      deleteSessionIndex(sessionId, session.projectPath);

      for (const path of uniquePaths(paths)) {
        if (existsSync(path)) {
          unlinkSync(path);
          deleted = true;
        }
      }

      updateSessionCatalog(catalog => {
        delete catalog.sessions[sessionId];
      });

      return deleted;
    }) ?? false
  );
}
