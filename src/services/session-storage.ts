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
  unlinkSync,
  realpathSync,
  statSync,
} from 'fs';
import { randomUUID } from 'crypto';
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
  getProjectsDir,
} from './config-dir';
import { atomicWriteFileSync } from './atomic-write';
import { deleteSessionIndex, updateSessionIndex } from './session-index';
import { redactTraceText } from './redaction';
import type { LoopContinuationAction, LoopFinishReason } from '../framework/query';
import type { Message } from './llm';
import type { ContextUsageSnapshot } from './model-context';
import {
  summarizeHarnessStateForMeta,
  upgradeHarnessState,
  type ContextCapsule,
  type HarnessSidecar,
  type HarnessState,
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
  | 'compact_completed'
  | 'compact_failed';

export interface SessionTraceEvent {
  sessionId: string;
  turnId: string;
  timestamp: number;
  type: SessionTraceEventType;
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
  finishReason?: LoopFinishReason;
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
  for (const key of [
    'argsSummary',
    'error',
    'note',
    'permissionReason',
    'continuationHint',
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
    } catch {
      // Not a git worktree, or git is unavailable.
    }
  }

  try {
    resolvedPath = realpathSync(absolute);
  } catch {
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
  } catch {
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
    historySizeBytes: computeSessionHistorySizeBytes({ id: session.id, projectPath }),
    tokenCount: session.tokenCount ?? 0,
    cost: session.cost ?? 0,
    gitBranch: session.gitBranch ?? getGitBranch(projectPath),
  };
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

function parseHarnessSidecarFile(path: string): HarnessSidecar | null {
  try {
    const content = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(content) as HarnessSidecar;
    return parsed?.version === 2 && parsed.state ? parsed : null;
  } catch {
    return null;
  }
}

function parseCompactCheckpointFile(path: string): CompactCheckpointV1 | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as CompactCheckpointV1;
    if (
      parsed?.version !== 1 ||
      !parsed.checkpointId ||
      !parsed.sessionId ||
      !Array.isArray(parsed.modelHistory) ||
      !Number.isInteger(parsed.sourceMessageCount) ||
      parsed.sourceMessageCount < 0 ||
      !parsed.summary ||
      typeof parsed.summary.text !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function upsertNewestSession(sessionsById: Map<string, SessionMeta>, session: SessionMeta): void {
  const existing = sessionsById.get(session.id);
  const existingTime = existing ? (existing.updatedAt ?? existing.startTime) : 0;
  const nextTime = session.updatedAt ?? session.startTime;

  if (!existing || nextTime >= existingTime) {
    sessionsById.set(session.id, session);
  }
}

function sortSessionsNewestFirst(sessions: SessionMeta[]): SessionMeta[] {
  return sessions.sort((a, b) => (b.updatedAt ?? b.startTime) - (a.updatedAt ?? a.startTime));
}

function safeFileSize(path: string): number | null {
  try {
    return existsSync(path) ? statSync(path).size : null;
  } catch {
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
  const payload = JSON.stringify(normalized, null, 2);

  ensureProjectDir(normalized.projectPath);
  atomicWriteFileSync(getProjectSessionMetaPath(normalized.projectPath, normalized.id), payload, {
    mode: 0o600,
  });
}

/**
 * 加载会话元数据
 */
export function loadSessionMeta(sessionId: string): SessionMeta | null {
  const projectsDir = getProjectsDir();
  if (existsSync(projectsDir)) {
    for (const projectKey of readdirSync(projectsDir)) {
      const path = join(projectsDir, projectKey, 'sessions', `${sessionId}.json`);
      if (!existsSync(path)) continue;

      const session = parseSessionMetaFile(path);
      if (session) {
        return normalizeSessionMeta(session);
      }
    }
  }

  return null;
}

/**
 * 更新会话统计
 */
export function updateSessionStats(sessionId: string, tokens: number, cost: number): void {
  const session = loadSessionMeta(sessionId);
  if (!session) return;

  session.tokenCount += tokens;
  session.cost += cost;
  session.updatedAt = Date.now();
  session.updatedAtIso = new Date(session.updatedAt).toISOString();
  saveSessionMeta(session);
}

function touchSession(sessionId: string, messageDelta: number = 0): SessionMeta | null {
  const session = loadSessionMeta(sessionId);
  if (!session) return null;

  session.updatedAt = Date.now();
  session.updatedAtIso = new Date(session.updatedAt).toISOString();
  session.messageCount = (session.messageCount ?? 0) + messageDelta;
  saveSessionMeta(session);
  return session;
}

/**
 * Mark a saved session as active again and refresh project metadata.
 */
export function resumeSession(sessionId: string): SessionMeta | null {
  const session = loadSessionMeta(sessionId);
  if (!session) return null;

  session.endTime = undefined;
  session.gitBranch = getGitBranch(session.projectPath);
  session.updatedAt = Date.now();
  session.updatedAtIso = new Date(session.updatedAt).toISOString();
  saveSessionMeta(session);
  return session;
}

/**
 * 更新会话 Harness 状态。
 */
export function updateSessionHarnessState(sessionId: string, harnessState: HarnessState): void {
  const session = loadSessionMeta(sessionId);
  if (!session) return;

  const fullState = upgradeHarnessState(harnessState, { cwd: session.cwd ?? session.projectPath });
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
  saveSessionMeta(session);
}

export function loadSessionHarnessState(sessionId: string): HarnessState | null {
  const session = loadSessionMeta(sessionId);
  if (!session) return null;

  const sidecarPath = getProjectSessionHarnessPath(session.projectPath, sessionId);
  if (existsSync(sidecarPath)) {
    const sidecar = parseHarnessSidecarFile(sidecarPath);
    if (sidecar?.state) {
      return upgradeHarnessState(sidecar.state, {
        cwd: session.cwd ?? session.projectPath,
        messages: readSessionMessages(sessionId),
      });
    }
  }

  if (session.harnessState) {
    return upgradeHarnessState(session.harnessState, {
      cwd: session.cwd ?? session.projectPath,
      messages: readSessionMessages(sessionId),
    });
  }

  const messages = readSessionMessages(sessionId);
  if (messages.length > 0) {
    return upgradeHarnessState(null, {
      cwd: session.cwd ?? session.projectPath,
      messages,
    });
  }

  return null;
}

export function updateSessionSkills(sessionId: string, skills: string[]): void {
  if (skills.length === 0) return;
  const session = loadSessionMeta(sessionId);
  if (!session) return;

  session.skillsUsed = [...new Set([...(session.skillsUsed || []), ...skills])];
  session.updatedAt = Date.now();
  session.updatedAtIso = new Date(session.updatedAt).toISOString();
  saveSessionMeta(session);
}

export function markSessionTranscriptDisplayStart(
  sessionId: string,
  timestamp: number = Date.now()
): SessionMeta | null {
  const session = loadSessionMeta(sessionId);
  if (!session) return null;

  session.transcriptDisplayStartTime = timestamp;
  session.updatedAt = timestamp;
  session.updatedAtIso = new Date(timestamp).toISOString();
  saveSessionMeta(session);
  return session;
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

export function loadSessionCompactCheckpoint(sessionId: string): CompactCheckpointV1 | null {
  const session = loadSessionMeta(sessionId);
  if (!session) return null;
  const checkpoint = parseCompactCheckpointFile(
    getProjectSessionCompactPath(session.projectPath, sessionId)
  );
  if (!checkpoint || checkpoint.sessionId !== sessionId) return null;
  if (session.activeCompactCheckpointId !== checkpoint.checkpointId) {
    return null;
  }

  const rawCount = readSessionMessages(sessionId).length;
  if (checkpoint.sourceMessageCount > rawCount) return null;

  return checkpoint;
}

export function commitSessionCompactCheckpoint(
  input: CommitCompactCheckpointInput
): CompactCheckpointV1 {
  const session = loadSessionMeta(input.sessionId);
  if (!session) throw new Error(`Session not found: ${input.sessionId}`);
  const rawCount = readSessionMessages(input.sessionId).length;
  if (input.sourceMessageCount < 0 || input.sourceMessageCount > rawCount) {
    throw new Error(
      `Invalid compact source boundary ${input.sourceMessageCount}; transcript has ${rawCount} messages`
    );
  }

  const createdAt = input.createdAt ?? Date.now();
  const checkpoint: CompactCheckpointV1 = {
    version: 1,
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
    modelHistory: input.modelHistory
      .filter(message => message.role !== 'system')
      .map(message => ({ ...message })),
    summary: {
      ...input.summary,
      sourceMessageCount: input.sourceMessageCount,
    },
    beforeUsage: { ...input.beforeUsage },
    afterUsage: { ...input.afterUsage },
  };

  const previousId = session.activeCompactCheckpointId;
  const previousTime = session.lastCompactAt;
  session.activeCompactCheckpointId = checkpoint.checkpointId;
  session.lastCompactAt = createdAt;
  session.updatedAt = createdAt;
  session.updatedAtIso = new Date(createdAt).toISOString();

  // Commit the pointer before replacing the atomic sidecar. If the process
  // crashes between writes, the loader safely uses the last valid sidecar.
  saveSessionMeta(session);
  try {
    atomicWriteFileSync(
      getProjectSessionCompactPath(session.projectPath, input.sessionId),
      JSON.stringify(checkpoint, null, 2),
      { mode: 0o600 }
    );
  } catch (error) {
    session.activeCompactCheckpointId = previousId;
    session.lastCompactAt = previousTime;
    saveSessionMeta(session);
    throw error;
  }

  return checkpoint;
}

export function loadSessionTranscriptMessages(sessionId: string): SessionMessage[] {
  const messages = readSessionMessages(sessionId);
  const checkpoint = loadSessionCompactCheckpoint(sessionId);
  if (checkpoint) {
    return messages.slice(checkpoint.transcriptStartMessageIndex);
  }

  const session = loadSessionMeta(sessionId);
  const displayStartTime = session?.transcriptDisplayStartTime;
  return typeof displayStartTime === 'number'
    ? messages.filter(message => (message.timestamp ?? 0) >= displayStartTime)
    : messages;
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
  const session = loadSessionMeta(sessionId);
  if (!session) return;

  session.endTime = Date.now();
  session.updatedAt = session.endTime;
  session.updatedAtIso = new Date(session.updatedAt).toISOString();
  saveSessionMeta(session);
}

/**
 * 更新会话任务摘要
 * 从会话消息中提取关键信息并更新元数据
 */
export function updateSessionSummary(sessionId: string, messages: SessionMessage[]): void {
  const session = loadSessionMeta(sessionId);
  if (!session) return;

  // 提取工具使用列表
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
          } catch {
            // ignore parse errors
          }
        }
      }
    }
  }

  // 提取任务摘要（从第一个用户消息）
  const firstUserMsg = messages.find(m => m.role === 'user' && m.content);
  const taskSummary = redactTraceText(firstUserMsg?.content ?? '').slice(0, 100);

  // 更新 session
  session.toolsUsed = [...new Set(toolsUsed)]; // unique
  session.filesModified = [...new Set(filesModified)]; // unique
  session.taskSummary = taskSummary.length > 100 ? taskSummary.slice(0, 100) + '...' : taskSummary;
  session.messageCount = messages.length;
  session.updatedAt = Date.now();
  session.updatedAtIso = new Date(session.updatedAt).toISOString();

  saveSessionMeta(session);
}

/**
 * 获取项目最近的会话
 */
export function getLastSession(projectPath: string): SessionMeta | null {
  const sessions = listProjectSessions(projectPath).filter(
    session => (session.messageCount ?? 0) > 0
  );
  return sessions[0] ?? null;
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
      } catch {
        // Skip corrupted line, preserve remaining valid entries.
      }
    }

    // 从最新开始
    const reversed = entries.reverse();
    return limit ? reversed.slice(0, limit) : reversed;
  } catch {
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
  const session = touchSession(sessionId, 1);

  if (!session) return;

  ensureProjectDir(session.projectPath);
  appendFileSync(getProjectSessionMessagesPath(session.projectPath, sessionId), line, {
    mode: 0o600,
  });

  // Update session index for fast search
  updateSessionIndex(sessionId, session.projectPath, message);
}

/**
 * 追加多条会话消息
 */
export function appendSessionMessages(sessionId: string, messages: SessionMessage[]): void {
  if (messages.length === 0) return;

  ensureConfigDir();
  const lines = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
  const session = touchSession(sessionId, messages.length);

  if (!session) return;

  ensureProjectDir(session.projectPath);
  appendFileSync(getProjectSessionMessagesPath(session.projectPath, sessionId), lines, {
    mode: 0o600,
  });

  for (const message of messages) {
    updateSessionIndex(sessionId, session.projectPath, message);
  }
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
  return tail.some(isFinalAssistantMessage) ? messages.length : lastUserIndex;
}

function overwriteSessionMessages(sessionId: string, messages: SessionMessage[]): void {
  ensureConfigDir();
  const session = loadSessionMeta(sessionId);
  if (!session) return;

  const content =
    messages.length > 0 ? messages.map(message => JSON.stringify(message)).join('\n') + '\n' : '';

  ensureProjectDir(session.projectPath);
  atomicWriteFileSync(getProjectSessionMessagesPath(session.projectPath, sessionId), content, {
    mode: 0o600,
  });

  deleteSessionIndex(sessionId, session.projectPath);
  for (const message of messages) {
    updateSessionIndex(sessionId, session.projectPath, message);
  }
  session.messageCount = messages.length;
  session.updatedAt = Date.now();
  session.updatedAtIso = new Date(session.updatedAt).toISOString();
  saveSessionMeta(session);
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
  const messages = readSessionMessages(sessionId);
  const boundary = findLastCompleteBoundary(messages);

  if (boundary === messages.length) {
    return messages;
  }

  const truncated = messages.slice(0, boundary);
  overwriteSessionMessages(sessionId, truncated);
  return truncated;
}

export function removeLastIncompleteAssistantMessage(sessionId: string): SessionMessage[] {
  return truncateSessionToLastComplete(sessionId);
}

/**
 * 读取会话消息
 */
export function readSessionMessages(sessionId: string): SessionMessage[] {
  const session = loadSessionMeta(sessionId);
  if (!session) return [];

  const path = getProjectSessionMessagesPath(session.projectPath, sessionId);
  if (!existsSync(path)) return [];

  try {
    const content = readFileSync(path, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const messages: SessionMessage[] = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        messages.push(JSON.parse(lines[i]) as SessionMessage);
      } catch {
        // A missing turn can orphan later tool results, so only restore the valid prefix.
        break;
      }
    }
    return messages;
  } catch {
    return [];
  }
}

export function appendSessionTraceEvent(
  sessionId: string,
  event: Omit<SessionTraceEvent, 'sessionId' | 'timestamp'> & { timestamp?: number }
): SessionTraceEvent | null {
  const session = loadSessionMeta(sessionId);
  if (!session) return null;

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
}

export function readSessionTraceEvents(sessionId: string): SessionTraceEvent[] {
  const session = loadSessionMeta(sessionId);
  if (!session) return [];

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
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/**
 * 读取会话消息并转换为 Message 格式（用于恢复对话历史）
 * 包含完整的 tool_calls 信息，确保 LLM 能理解之前的工具调用
 */
export function loadSessionHistory(sessionId: string): Message[] {
  const messages = readSessionMessages(sessionId);
  const checkpoint = loadSessionCompactCheckpoint(sessionId);
  if (checkpoint) {
    return [
      ...checkpoint.modelHistory.map(message => ({ ...message })),
      ...messages.slice(checkpoint.sourceMessageCount).map(sessionMessageToModelMessage),
    ];
  }
  const session = loadSessionMeta(sessionId);
  const displayStartTime = session?.transcriptDisplayStartTime;
  let modelVisibleMessages = messages;
  if (typeof displayStartTime === 'number') {
    const afterDisplayStart = messages.filter(
      message => (message.timestamp ?? 0) >= displayStartTime
    );
    modelVisibleMessages = hasPersistedCompactContext(afterDisplayStart)
      ? afterDisplayStart
      : messages;
  }

  return modelVisibleMessages.map(sessionMessageToModelMessage);
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
  ensureConfigDir();
  const sessionsById = new Map<string, SessionMeta>();

  const projectsDir = getProjectsDir();
  if (existsSync(projectsDir)) {
    for (const projectKey of readdirSync(projectsDir)) {
      const projectSessionsDir = join(projectsDir, projectKey, 'sessions');
      if (!existsSync(projectSessionsDir)) continue;

      const files = readdirSync(projectSessionsDir).filter(isSessionMetaFile);
      for (const file of files) {
        const rawSession = parseSessionMetaFile(join(projectSessionsDir, file));
        if (rawSession) {
          upsertNewestSession(sessionsById, normalizeSessionMeta(rawSession));
        }
      }
    }
  }

  const sessions = sortSessionsNewestFirst(Array.from(sessionsById.values()));
  return limit ? sessions.slice(0, limit) : sessions;
}

/**
 * List sessions for a single canonical project.
 */
export function listProjectSessions(projectPath: string, limit?: number): SessionMeta[] {
  const canonicalProjectPath = resolveProjectPath(projectPath);
  const sessionsById = new Map<string, SessionMeta>();

  const projectSessionsDir = getProjectSessionsDir(canonicalProjectPath);
  if (existsSync(projectSessionsDir)) {
    const files = readdirSync(projectSessionsDir).filter(isSessionMetaFile);
    for (const file of files) {
      const rawSession = parseSessionMetaFile(join(projectSessionsDir, file));
      if (rawSession) {
        upsertNewestSession(sessionsById, normalizeSessionMeta(rawSession));
      }
    }
  }

  const sessions = sortSessionsNewestFirst(Array.from(sessionsById.values()));
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
  const query = ref.trim();
  if (!query) return { status: 'not_found' };

  const candidates =
    options.allProjects || !projectPath ? listSessions() : listProjectSessions(projectPath);

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
  const session = loadSessionMeta(sessionId);
  if (!session) return null;

  const trimmed = name.trim();
  session.name = trimmed || undefined;
  session.updatedAt = Date.now();
  session.updatedAtIso = new Date(session.updatedAt).toISOString();
  saveSessionMeta(session);
  return session;
}

/**
 * 删除会话
 */
export function deleteSession(sessionId: string): boolean {
  const session = loadSessionMeta(sessionId);
  if (!session) return false;

  let deleted = false;
  const paths = [
    getProjectSessionMetaPath(session.projectPath, sessionId),
    getProjectSessionMessagesPath(session.projectPath, sessionId),
    getProjectSessionHarnessPath(session.projectPath, sessionId),
    getProjectSessionCompactPath(session.projectPath, sessionId),
    getProjectSessionTracePath(session.projectPath, sessionId),
  ];

  // v0.2.24: also delete goal sidecar.
  const goalPath = join(getProjectSessionsDir(session.projectPath), `${sessionId}.goal.json`);
  if (existsSync(goalPath)) {
    try { unlinkSync(goalPath); deleted = true; } catch { /* ok */ }
  }

  deleteSessionIndex(sessionId, session.projectPath);

  for (const path of uniquePaths(paths)) {
    if (existsSync(path)) {
      unlinkSync(path);
      deleted = true;
    }
  }

  return deleted;
}
