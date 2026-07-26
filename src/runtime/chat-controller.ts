import { findCommand } from '../commands';
import { parseInput, buildCommandSuggestions } from '../commands/parser';
import * as path from 'path';
import type { CommandContext, CommandResult, CommandUiRenderer } from '../commands/types';
import type { LLMRequestDiagnostics, Message, StreamCallbacks } from '../services/llm';
import type { SessionMessage, SessionTraceEvent } from '../services/session-storage';
import {
  appendSessionMessage,
  appendSessionMessages,
  appendSessionTraceEvent,
  commitSessionCompactCheckpoint,
  endSession,
  loadSessionHarnessState,
  loadSessionTranscriptMessages,
  loadSessionHistory,
  loadSessionMeta,
  removeLastIncompleteAssistantMessage,
  readSessionMessages,
  readSessionTraceEvents,
  redactTraceText,
  updateSessionHarnessState,
  updateSessionSkills,
  updateSessionSummary,
} from '../services/session-storage';
import { isConfigured } from '../services/config';
import {
  query,
  buildSystemPrompt,
  QueryLoopError,
  createFailedLoopStats,
  createLocalFastPathLoopStats,
  type LoopFinishReason,
  type LoopStats,
  type PromptContext,
  type QueryEvent,
  type QueryCompactCommit,
} from '../framework';
import { buildGoalContextFragment } from './goals/prompt';
import { createContextHarness } from '../harness';
import type { HarnessState } from '../harness/types';
import { executeTool, getRuntimeTools } from '../tools';
import { parseToolResultEnvelope } from '../framework/tool-serializer';
import { storeArtifact, truncateForContext } from '../core/tool-artifacts';
import { createCheckpoint, shouldCreateMultiFileCheckpoint } from '../core/checkpoint';
import { resolveSkillsForTurn, hasMatchingSkill } from '../skills';
import {
  createSubagentBundleForTurn,
  deriveRootLlmConfig,
  type RuntimeSubtaskEvent,
  type SubagentTurnBundle,
} from './subagents';
import { buildReferencedFilesPrompt } from '../services/file-context';
import { refreshProjectInstructions } from '../services/prompt-context';
import { formatBytes } from '../services/format';
import {
  captureWorkspaceSnapshot,
  diffWorkspaceSnapshots,
  type WorkspaceSnapshot,
} from '../services/workspace-state';
import {
  collectVerificationCommandResult,
  formatVerificationGateNotice,
  isRiskyEdit,
  selectVerificationProfile,
  shouldGateCompletion,
  summarizeVerificationState,
  type VerificationCommandResult,
  type VerificationProfile,
  type VerificationSummary,
} from '../services/verification-profile';
import type {
  OpenHorseUiRuntime,
  RuntimeHarnessDiagnostics,
  StructuredToolActivity,
  TranscriptEntry,
  UiEventSink,
  UiRendererCapabilities,
} from './ui-events';
import { resolveUiRendererCapabilities } from './ui-events';
import {
  formatToolActivityTranscript,
  toolActivityFromFinished,
  toolActivityFromStarted,
} from './ui-view-model';
import {
  agentStepStatus,
  batchingSuggestion,
  runningToolsStatus,
  verifyingStatus,
  verificationGateStatus,
} from './agent-status';
import { resolveRuntimeLoopBudget } from './loop-budget';
import {
  createToolOutputView,
  DEFAULT_TOOL_OUTPUT_POLICY,
} from './tool-output-presentation';
import { presentAggregateToolResult } from './aggregate-tool-presenter';

const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/g;
const LOCAL_FAST_PATH_INLINE_OUTPUT_BYTES = 2048;
const TRACE_ARGS_ARTIFACT_THRESHOLD_BYTES = 160;
const TOOL_TRANSCRIPT_ARG_BUDGET = 512;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

function isAbortError(error: unknown, abortSignal?: AbortSignal): boolean {
  if (abortSignal?.aborted) return true;
  if (error instanceof Error) {
    return error.name === 'AbortError' || error.message.toLowerCase().includes('aborted');
  }
  return false;
}

function errorLayerForChatError(error: unknown): import('./ui-events').ErrorLayer {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (
    /NotEnoughCvError|code:\s*11210|provider|quota|rate.?limit|timeout|connection/i.test(message)
  ) {
    return 'provider';
  }
  if (/tool|command|exec_command|write_file|edit_file/i.test(message)) {
    return 'tool';
  }
  if (/\bmcp\b/i.test(message)) return 'mcp';
  if (/\b(session|resume|compact|harness)\b/i.test(message)) return 'session';
  if (/\b(skill|skills)\b/i.test(message)) return 'skills';
  if (/\b(memory|vector store|recall|forget)\b/i.test(message)) return 'memory';
  if (/\b(renderer|terminal|tty|prompt|resize|scrollback)\b/i.test(message)) return 'renderer';
  if (lower.includes('abort') || lower.includes('interrupted')) return 'runtime';
  return 'unknown';
}

function formatChatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/NotEnoughCvError|code:\s*11210/i.test(message)) {
    return [
      message,
      '',
      'Provider quota or credit appears insufficient. The Orion Code session is still active; switch model/provider or recharge the provider account, then continue.',
    ].join('\n');
  }
  return message;
}

function compactMiddle(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  if (maxLength <= 3) return compact.slice(0, maxLength);

  const headLength = Math.ceil((maxLength - 3) * 0.55);
  const tailLength = Math.floor((maxLength - 3) * 0.45);
  return `${compact.slice(0, headLength)}...${compact.slice(-tailLength)}`;
}

function compactToolArgs(args: Record<string, unknown>, maxLength = 160): string {
  for (const key of [
    'path',
    'file_path',
    'file',
    'cwd',
    'command',
    'pattern',
    'query',
    'url',
    'target',
    'sessionId',
  ]) {
    const value = args[key];
    if (typeof value === 'string') {
      return compactMiddle(value, maxLength);
    }
  }
  const firstString = Object.values(args).find(value => typeof value === 'string');
  if (typeof firstString === 'string') {
    return compactMiddle(firstString, maxLength);
  }
  return '';
}

interface TraceArgsDetails {
  argsSummary: string;
  argsArtifactId?: string;
  argsBytes?: number;
}

function fullToolArgsForTrace(name: string, args: Record<string, unknown>): string {
  if (name === 'exec_command' && typeof args.command === 'string') {
    return `$ ${args.command}`;
  }

  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return compactToolArgs(args, 2048);
  }
}

function buildTraceArgsDetails(
  projectPath: string | undefined,
  name: string,
  args: Record<string, unknown>
): TraceArgsDetails {
  const argsSummary = compactToolArgs(args);
  const fullArgs = redactTraceText(fullToolArgsForTrace(name, args)).trim();
  const argsBytes = byteLength(fullArgs);

  if (
    !projectPath ||
    !fullArgs ||
    fullArgs === redactTraceText(argsSummary) ||
    argsBytes <= TRACE_ARGS_ARTIFACT_THRESHOLD_BYTES
  ) {
    return { argsSummary };
  }

  const artifact = storeArtifact(projectPath, `${name}-args`, fullArgs, argsBytes);
  return artifact ? { argsSummary, argsArtifactId: artifact.id, argsBytes } : { argsSummary };
}

function parseToolCallArgsForRuntime(
  toolCall: NonNullable<Message['tool_calls']>[number]
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(toolCall.function.arguments || '{}');
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function resolveProjectScopedPath(cwd: string, filePath: string): string | null {
  const absolute = path.resolve(cwd, filePath);
  const relative = path.relative(cwd, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return absolute;
}

function checkpointTargetsFromToolCalls(
  cwd: string,
  toolCalls: NonNullable<Message['tool_calls']>
): string[] {
  const targets = new Set<string>();
  for (const toolCall of toolCalls) {
    const name = toolCall.function.name;
    if (name !== 'write_file' && name !== 'edit_file') continue;

    const args = parseToolCallArgsForRuntime(toolCall);
    if (!args || typeof args.path !== 'string') continue;
    if (name === 'edit_file' && args.preview === true) continue;

    const target = resolveProjectScopedPath(cwd, args.path);
    if (target) targets.add(target);
  }
  return Array.from(targets);
}

function createPreToolCheckpoint(
  events: UiEventSink,
  sessionId: string | undefined,
  turnId: string,
  checkpointId: string,
  cwd: string,
  toolCalls: NonNullable<Message['tool_calls']>
): { created: boolean; targetCount: number; risky: boolean } {
  const targets = checkpointTargetsFromToolCalls(cwd, toolCalls);
  if (targets.length === 0) return { created: false, targetCount: 0, risky: false };

  const risky = shouldCreateMultiFileCheckpoint(targets.length);
  const checkpoint = createCheckpoint(cwd, checkpointId, targets);
  if (!sessionId) return { created: true, targetCount: targets.length, risky };

  const relativeTargets = targets.map(target => path.relative(cwd, target));
  recordTraceEvent(events, sessionId, {
    turnId,
    type: 'checkpoint',
    checkpointId,
    checkpointFileCount: checkpoint?.files.length ?? 0,
    checkpointFiles: checkpoint?.files.map(file => file.path) ?? [],
    workspaceFiles: relativeTargets,
    note: checkpoint
      ? risky
        ? 'risky_multi_file_checkpoint'
        : 'pre_edit_checkpoint'
      : 'pre_edit_checkpoint_skipped',
  });
  return { created: true, targetCount: targets.length, risky };
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function traceTurnId(turnId: number | string | undefined): string {
  return turnId == null ? `turn-${Date.now()}` : String(turnId);
}

function compactTraceError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return compactMiddle(message, 240);
}

function getLastRequestDiagnostics(
  llm: OpenHorseUiRuntime['llm']
): LLMRequestDiagnostics | undefined {
  if (!llm) return undefined;
  const reader = (
    llm as unknown as {
      getLastRequestDiagnostics?: () => LLMRequestDiagnostics;
    }
  ).getLastRequestDiagnostics;
  return typeof reader === 'function' ? reader.call(llm) : undefined;
}

function compactPathList(paths: string[], maxItems = 40): string[] {
  return paths.slice(0, maxItems);
}

function formatWorkspaceFileForTrace(file: WorkspaceSnapshot['files'][number]): string {
  const metadata = [
    typeof file.sizeBytes === 'number' ? `${file.sizeBytes}B` : '',
    typeof file.mtimeMs === 'number' ? `mtime=${file.mtimeMs}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `${file.status} ${file.path}${metadata ? ` (${metadata})` : ''}`;
}

function appendWorkspaceSnapshotTrace(
  events: UiEventSink,
  sessionId: string | undefined,
  turnId: string,
  phase: 'pre_turn' | 'post_turn',
  snapshot: WorkspaceSnapshot
): void {
  if (!sessionId) return;
  recordTraceEvent(events, sessionId, {
    turnId,
    type: 'workspace_snapshot',
    workspacePhase: phase,
    workspaceGitAvailable: snapshot.gitAvailable,
    workspaceDirty: snapshot.dirty,
    workspaceBranch: snapshot.branch,
    workspaceFileCount: snapshot.fileCount,
    workspaceFiles: compactPathList(snapshot.files.map(formatWorkspaceFileForTrace)),
    error: snapshot.error ? compactMiddle(snapshot.error, 240) : undefined,
  });
}

function appendWorkspaceDeltaTrace(
  events: UiEventSink,
  sessionId: string | undefined,
  turnId: string,
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot
): ReturnType<typeof diffWorkspaceSnapshots> {
  const delta = diffWorkspaceSnapshots(before, after);
  if (sessionId) {
    recordTraceEvent(events, sessionId, {
      turnId,
      type: 'workspace_delta',
      workspaceFileCount: delta.filesAfterTurn.length,
      workspaceFiles: compactPathList(delta.filesAfterTurn),
      workspaceNewByTurn: compactPathList(delta.newFilesByTurn),
      workspaceChangedByTurn: compactPathList(delta.changedByTurn),
      workspaceModifiedPreExistingByTurn: compactPathList(delta.modifiedPreExistingByTurn),
      workspaceResolvedByTurn: compactPathList(delta.resolvedByTurn),
      note: `pre_existing=${delta.preExistingFiles.length}`,
    });
  }
  return delta;
}

function workspaceDeltaHasTurnChanges(delta: ReturnType<typeof diffWorkspaceSnapshots>): boolean {
  return (
    delta.newFilesByTurn.length > 0 ||
    delta.changedByTurn.length > 0 ||
    delta.resolvedByTurn.length > 0
  );
}

function formatFailureRecoveryNotice(
  turnId: string,
  delta: ReturnType<typeof diffWorkspaceSnapshots>,
  checkpointIds: string[]
): string {
  const files = compactPathList(
    [...delta.newFilesByTurn, ...delta.changedByTurn, ...delta.resolvedByTurn],
    8
  );
  const fileText = files.length > 0 ? files.join(', ') : 'workspace changes recorded';
  const checkpointText =
    checkpointIds.length > 0
      ? ` Checkpoints: ${checkpointIds.join(', ')}. Preview rollback with /checkpoint restore <id>; restore each listed checkpoint if multiple.`
      : '';
  return `Turn failed after modifying files: ${fileText}. Inspect /trace ${turnId}.${checkpointText}`;
}

function appendVerificationProfileTrace(
  events: UiEventSink,
  sessionId: string | undefined,
  turnId: string,
  profile: VerificationProfile
): void {
  if (!sessionId || profile.changedFiles.length === 0) return;
  recordTraceEvent(events, sessionId, {
    turnId,
    type: 'verification_profile',
    verificationProfile: profile.profile,
    verificationRequired: profile.required,
    verificationRisky: isRiskyEdit(profile.changedFiles),
    verificationCommands: compactPathList(profile.commands, 8),
    verificationChangedFiles: compactPathList(profile.changedFiles),
    note: profile.reason,
  });
}

function appendVerificationResultTrace(
  events: UiEventSink,
  sessionId: string | undefined,
  turnId: string,
  result: VerificationCommandResult
): void {
  if (!sessionId) return;
  recordTraceEvent(events, sessionId, {
    turnId,
    type: 'verification_result',
    verificationCommand: result.command,
    verificationPassed: result.success,
    outputBytes: result.outputBytes,
    error: result.error ? compactMiddle(result.error, 240) : undefined,
  });
}

function appendVerificationSummaryTrace(
  events: UiEventSink,
  sessionId: string | undefined,
  turnId: string,
  summary: VerificationSummary,
  changedFiles: string[]
): void {
  if (!sessionId || changedFiles.length === 0) return;
  recordTraceEvent(events, sessionId, {
    turnId,
    type: 'verification_summary',
    verificationProfile: summary.profile,
    verificationRequired: summary.required,
    verificationCommands: compactPathList(summary.commandsRun, 12),
    verificationPassedCommands: compactPathList(summary.passedCommands, 12),
    verificationFailedCommands: compactPathList(summary.failedCommands, 12),
    verificationMissingCommands: compactPathList(summary.missingCommands, 12),
    verificationChangedFiles: compactPathList(changedFiles),
    verificationClaimAllowed: summary.claimAllowed,
    note: summary.skippedReason,
  });
}

function compactVerificationCommands(commands: string[], maxItems = 12): string[] {
  return commands.slice(0, maxItems).map(redactTraceText);
}

function withVerificationLoopStats(stats: LoopStats, summary: VerificationSummary): LoopStats {
  return {
    ...stats,
    verificationProfile: summary.profile,
    verificationRequired: summary.required,
    verificationClaimAllowed: summary.claimAllowed,
    verificationPassedCommands: compactVerificationCommands(summary.passedCommands),
    verificationFailedCommands: compactVerificationCommands(summary.failedCommands),
    verificationMissingCommands: compactVerificationCommands(summary.missingCommands),
    verificationSkippedReason: summary.skippedReason
      ? redactTraceText(summary.skippedReason)
      : undefined,
  };
}

function shouldRecordVerificationLoopStats(
  profile: VerificationProfile,
  summary: VerificationSummary
): boolean {
  return (
    profile.changedFiles.length > 0 ||
    summary.commandsRun.length > 0 ||
    summary.passedCommands.length > 0 ||
    summary.failedCommands.length > 0 ||
    summary.missingCommands.length > 0
  );
}

function appendPostWorkspaceTrace(
  events: UiEventSink,
  sessionId: string | undefined,
  turnId: string,
  cwd: string,
  before: WorkspaceSnapshot,
  verificationResults: VerificationCommandResult[] = []
): {
  delta: ReturnType<typeof diffWorkspaceSnapshots>;
  profile: VerificationProfile;
  summary: VerificationSummary;
} {
  const postWorkspace = captureWorkspaceSnapshot(cwd);
  appendWorkspaceSnapshotTrace(events, sessionId, turnId, 'post_turn', postWorkspace);
  const delta = appendWorkspaceDeltaTrace(events, sessionId, turnId, before, postWorkspace);
  const profile = selectVerificationProfile(cwd, delta.changedByTurn);
  const summary = summarizeVerificationState(profile, verificationResults);
  appendVerificationProfileTrace(events, sessionId, turnId, profile);
  appendVerificationSummaryTrace(events, sessionId, turnId, summary, profile.changedFiles);
  return { delta, profile, summary };
}

function appendAssistantNotice(messages: SessionMessage[], notice: string): void {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'assistant' && !message.tool_calls) {
      message.content = message.content ? `${message.content}\n\n${notice}` : notice;
      return;
    }
  }
  messages.push({
    role: 'assistant',
    content: notice,
    timestamp: Date.now(),
  });
}

function recordTraceEvent(
  events: UiEventSink,
  sessionId: string | undefined,
  event: Omit<SessionTraceEvent, 'sessionId' | 'timestamp'> & { timestamp?: number }
): SessionTraceEvent | null {
  if (!sessionId) return null;
  const traceEvent = appendSessionTraceEvent(sessionId, event);
  if (traceEvent) {
    events.traceEventRecorded?.(traceEvent);
  }
  return traceEvent;
}

function recordProviderTraceEvents(
  events: UiEventSink,
  sessionId: string | undefined,
  turnId: string,
  stats: LoopStats
): void {
  if ((stats.providerRetryCount ?? 0) > 0) {
    recordTraceEvent(events, sessionId, {
      turnId,
      type: 'provider_retry',
      providerRetryCount: stats.providerRetryCount,
      providerRetryDelayMs: stats.providerRetryDelayMs,
      providerRetryErrorTypes: stats.providerRetryErrorTypes,
      providerLastRetryErrorType: stats.providerLastRetryErrorType,
      providerLastRetryStatus: stats.providerLastRetryStatus,
      providerFinalModel: stats.providerFinalModel,
      providerUsingFallback: stats.providerUsingFallback,
    });
  }

  if ((stats.providerFallbackCount ?? 0) > 0 || stats.providerUsingFallback) {
    recordTraceEvent(events, sessionId, {
      turnId,
      type: 'provider_fallback',
      providerFallbackCount: stats.providerFallbackCount,
      providerFallbackFromModel: stats.providerFallbackFromModel,
      providerFallbackToModel: stats.providerFallbackToModel,
      providerFinalModel: stats.providerFinalModel,
      providerUsingFallback: stats.providerUsingFallback,
    });
  }
}

function toHarnessDiagnostics(state: HarnessState): RuntimeHarnessDiagnostics {
  const stats = state.promptAssemblyStats;
  const redactOptional = (value: string | undefined): string | undefined =>
    typeof value === 'string' ? redactTraceText(value) : undefined;
  const redactList = (values: string[] | undefined): string[] | undefined =>
    values?.slice(0, 6).map(redactTraceText);
  return {
    taskEpoch: state.taskEpoch,
    rootObjective: redactOptional(state.rootObjective ?? state.contract?.objective),
    activeInstruction: redactOptional(state.activeInstruction ?? state.contract?.userIntent),
    openQuestions: redactList(state.openQuestions),
    diagnostics: redactList(state.diagnostics?.slice(-6)),
    ledgerSize: state.ledger?.length ?? 0,
    evidenceSize: state.evidenceIndex?.length ?? 0,
    turnSummaryCount: state.turnSummaries?.length ?? 0,
    promptAssembly: stats
      ? {
          modelId: stats.modelId,
          estimatedTokens: stats.estimatedTokens,
          budgetTokens: stats.budgetTokens,
          sections: stats.sections.slice(0, 12),
          includedEvidence: stats.includedEvidence.length,
          omittedEvidence: stats.omittedEvidence.length,
        }
      : undefined,
  };
}

function emitHarnessDiagnostics(events: UiEventSink, state: HarnessState): void {
  events.harnessDiagnosticsUpdated?.(toHarnessDiagnostics(state));
}

function toolStartContent(event: ToolCallEvent): string {
  return formatToolActivityTranscript(
    toolActivityFromStarted(event, compactToolArgs(event.args, TOOL_TRANSCRIPT_ARG_BUDGET))
  );
}

function toolFinishContent(event: ToolResultEvent): string {
  return formatToolActivityTranscript(
    toolActivityFromFinished(event, compactToolArgs(event.args, TOOL_TRANSCRIPT_ARG_BUDGET))
  );
}

function structuredToolStartActivity(event: ToolCallEvent, seq: number): StructuredToolActivity {
  const command =
    event.name === 'exec_command' && typeof event.args.command === 'string'
      ? event.args.command
      : undefined;
  const safeCommand = command ? redactTraceText(command) : undefined;
  return {
    state: 'running',
    name: event.name,
    detail: command ? '' : redactTraceText(compactToolArgs(event.args, TOOL_TRANSCRIPT_ARG_BUDGET)),
    command: safeCommand,
    body: '',
    seq,
  };
}

interface ToolEventPresenterOptions {
  projectPath?: string;
  turnId?: string;
}

function structuredToolFinishActivity(
  event: ToolResultEvent,
  seq: number,
  options: ToolEventPresenterOptions = {},
): StructuredToolActivity {
  const modelVisible = parseToolResultEnvelope(event.modelVisibleResult);
  const durable = parseToolResultEnvelope(event.result);
  const durableOutput = typeof durable.output === 'string' ? durable.output : '';
  const displayOutput = typeof modelVisible.output === 'string' ? modelVisible.output : durableOutput;
  const outputBytes = event.outputBytes ?? Buffer.byteLength(durableOutput, 'utf8');
  const aggregatePresentation = presentAggregateToolResult(event.name, durableOutput, outputBytes);
  const aggregate = aggregatePresentation?.view;
  const storedArtifact = event.artifactRef ?? (
    options.projectPath && durableOutput && (outputBytes > DEFAULT_TOOL_OUTPUT_POLICY.inlineMaxBytes || aggregate)
      ? storeArtifact(options.projectPath, event.name, durableOutput, outputBytes) ?? undefined
      : undefined
  );
  const artifactRef = storedArtifact
    ? { id: storedArtifact.id, outputBytes: storedArtifact.outputBytes }
    : undefined;
  const outputView = createToolOutputView({
    toolName: event.name,
    success: event.success,
    summary: event.summary,
    rawOutput: durableOutput.length <= 64 * 1024 ? durableOutput : displayOutput,
    outputBytes,
    artifactRef,
    callId: event.callId,
    sequence: seq,
    turnId: options.turnId,
    policy: DEFAULT_TOOL_OUTPUT_POLICY,
  });
  if (aggregate) {
    outputView.aggregate = {
      ...aggregate,
      steps: aggregate.steps.map(step => ({ ...step, detailRef: outputView.detailRef })),
    };
  }
  const command =
    event.name === 'exec_command' && typeof event.args.command === 'string'
      ? event.args.command
      : undefined;
  const safeCommand = command ? redactTraceText(command) : undefined;
  return {
    state: event.success ? 'success' : 'error',
    name: event.name,
    detail: command ? '' : redactTraceText(compactToolArgs(event.args, TOOL_TRANSCRIPT_ARG_BUDGET)),
    command: safeCommand,
    duration: `${event.duration}ms`,
    summary: event.summary ? redactTraceText(event.summary.split(/\r?\n/u, 1)[0]) : undefined,
    outputBytes,
    body: redactTraceText(modelVisible.output),
    error: event.error ? redactTraceText(event.error) : undefined,
    seq,
    artifactHint: artifactRef ? `/artifacts show ${artifactRef.id} --full` : undefined,
    callId: event.callId,
    turnId: options.turnId,
    outputView,
  };
}

function isSyntheticCompactContext(content: string): boolean {
  return (
    content.startsWith('[Orion Code Context State v2]') ||
    content.startsWith('[Context Summary]') ||
    content.startsWith('I will continue from this Orion Code Context State') ||
    content.startsWith(
      'I understand the context. I will continue the conversation with this background information.'
    )
  );
}

function sessionToolCallSummaries(message: SessionMessage): Array<{ id: string; content: string }> {
  return (message.tool_calls ?? []).map(call => {
    const args = parseToolCallArgs(call.function.arguments);
    const detail = compactToolArgs(args);
    return {
      id: call.id,
      content: `Requested ${call.function.name}${detail ? ` ${detail}` : ''}`,
    };
  });
}

function parseToolCallArgs(rawArgs: string | undefined): Record<string, unknown> {
  try {
    return rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return rawArgs ? { arguments: rawArgs } : {};
  }
}

function parseSessionToolResult(content: string): {
  success: boolean;
  error?: string;
  summary?: string;
} {
  try {
    const parsed = JSON.parse(content) as { success?: unknown; error?: unknown; summary?: unknown };
    return {
      success: parsed.success === true,
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
      summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
    };
  } catch {
    return { success: false, error: 'Invalid JSON result' };
  }
}

function removeTrailingUserMessage(runtime: OpenHorseUiRuntime): void {
  const history = runtime.store.getSnapshot().conversationHistory;
  if (history.length === 0) return;

  const lastMsg = history[history.length - 1];
  if (lastMsg?.role === 'user') {
    runtime.store.setState({ conversationHistory: history.slice(0, -1) });
  }
}

function sessionToolResultSummary(
  message: SessionMessage,
  toolCallsById: Map<string, NonNullable<SessionMessage['tool_calls']>[number]>
): string | null {
  if (!message.toolCallId) return null;
  const call = toolCallsById.get(message.toolCallId);
  if (!call) return null;

  const args = parseToolCallArgs(call.function.arguments);
  const detail = compactToolArgs(args);
  const parsed = parseSessionToolResult(message.content);
  const firstLine =
    parsed.summary ||
    `${parsed.success ? '✓' : '✗'} ${call.function.name}${detail ? ` ${detail}` : ''}`;
  return parsed.error ? `${firstLine}\nError: ${parsed.error}` : firstLine;
}

export interface SessionTranscriptEntryOptions {
  includeToolOutputViews?: boolean;
}

export function sessionMessagesToTranscriptEntries(
  sessionId: string,
  options: SessionTranscriptEntryOptions = {},
): TranscriptEntry[] {
  const messages = loadSessionTranscriptMessages(sessionId);
  const resultTraces = options.includeToolOutputViews
    ? readSessionTraceEvents(sessionId).filter(trace => trace.type === 'tool_result' && trace.callId)
    : [];
  const resultTraceByCallId = new Map(resultTraces.map(trace => [trace.callId!, trace]));
  const sequenceByCallId = new Map<string, number>();
  resultTraces.forEach((trace, index) => {
    if (!sequenceByCallId.has(trace.callId!)) sequenceByCallId.set(trace.callId!, index + 1);
  });
  const entries: TranscriptEntry[] = [];
  const toolCallsById = new Map<string, NonNullable<SessionMessage['tool_calls']>[number]>();
  const completedToolCallIds = new Set<string>();
  let fallbackToolSequence = 0;

  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      toolCallsById.set(call.id, call);
    }
    if (message.role === 'tool' && message.toolCallId) {
      completedToolCallIds.add(message.toolCallId);
    }
  }

  messages.forEach((message, index) => {
    if (isSyntheticCompactContext(message.content)) return;

    const idBase = `session-${sessionId.slice(0, 8)}-${index}`;
    if (message.role === 'user') {
      entries.push({ id: `${idBase}-user`, role: 'user', content: message.content });
      return;
    }

    if (message.role === 'assistant') {
      if (message.content?.trim()) {
        entries.push({ id: `${idBase}-assistant`, role: 'assistant', content: message.content });
      }
      for (const summary of sessionToolCallSummaries(message)) {
        if (!completedToolCallIds.has(summary.id)) {
          entries.push({
            id: `${idBase}-tool-call-${entries.length}`,
            role: 'tool',
            content: summary.content,
          });
        }
      }
      return;
    }

    if (message.role === 'tool') {
      const summary = sessionToolResultSummary(message, toolCallsById);
      const call = message.toolCallId ? toolCallsById.get(message.toolCallId) : undefined;
      const trace = message.toolCallId ? resultTraceByCallId.get(message.toolCallId) : undefined;
      const durable = parseToolResultEnvelope(message.content);
      const modelVisible = message.modelVisibleContent
        ? parseToolResultEnvelope(message.modelVisibleContent)
        : durable;
      const durableOutput = typeof durable.output === 'string' ? durable.output : '';
      const displayOutput = typeof modelVisible.output === 'string' ? modelVisible.output : durableOutput;
      const outputBytes = trace?.outputBytes
        ?? (durable.schemaVersion === 1 ? durable.outputBytes : undefined)
        ?? Buffer.byteLength(durableOutput, 'utf8');
      const artifactId = durable.artifactRef?.id ?? trace?.artifactId;
      fallbackToolSequence += 1;
      const sequence = message.toolCallId
        ? sequenceByCallId.get(message.toolCallId) ?? fallbackToolSequence
        : fallbackToolSequence;
      const outputView = options.includeToolOutputViews && call && message.toolCallId
        ? createToolOutputView({
          toolName: call.function.name,
          success: durable.success,
          summary: durable.summary,
          rawOutput: durableOutput.length <= 64 * 1024 ? durableOutput : displayOutput,
          outputBytes,
          artifactRef: artifactId ? { id: artifactId, outputBytes } : undefined,
          callId: message.toolCallId,
          sequence,
          turnId: trace?.turnId,
          policy: DEFAULT_TOOL_OUTPUT_POLICY,
        })
        : undefined;
      entries.push({
        id: `${idBase}-tool`,
        role: 'tool',
        content:
          summary ??
          (message.toolCallId
            ? `Tool result ${message.toolCallId}\n${message.content}`
            : message.content),
        toolActivity: call && message.toolCallId && outputView
          ? {
            state: durable.success ? 'success' : 'error',
            name: call.function.name,
            detail: redactTraceText(compactToolArgs(parseToolCallArgs(call.function.arguments))),
            summary: durable.summary
              ? redactTraceText(durable.summary.split(/\r?\n/u, 1)[0])
              : undefined,
            outputBytes,
            body: redactTraceText(
              durableOutput.length <= 64 * 1024 ? durableOutput : displayOutput,
            ),
            error: durable.error ? redactTraceText(durable.error) : undefined,
            duration: typeof trace?.duration === 'number' ? `${trace.duration}ms` : undefined,
            seq: sequence,
            artifactHint: artifactId ? `/artifacts show ${artifactId} --full` : undefined,
            callId: message.toolCallId,
            turnId: trace?.turnId,
            outputView,
          }
          : undefined,
      });
      return;
    }

    if (message.role === 'system') {
      entries.push({ id: `${idBase}-system`, role: 'system', content: message.content });
    }
  });

  return entries;
}

export interface AssistantStreamPresenter {
  appendChunk(chunk: string): void;
  closeSegment(): void;
  discardSegment(): void;
  ensureMessage(content: string): void;
  replaceMessage(content: string): void;
}

export function createAssistantStreamPresenter(
  events: UiEventSink,
  abortSignal?: AbortSignal
): AssistantStreamPresenter {
  let activeSegmentText = '';
  let activeEntryId: string | null = null;

  const ensureLiveEntry = (): string | null => {
    if (abortSignal?.aborted || !activeSegmentText) return null;
    if (activeEntryId) {
      events.update(activeEntryId, { content: activeSegmentText });
      return activeEntryId;
    }

    activeEntryId = events.append({
      role: 'assistant',
      content: activeSegmentText,
      live: true,
    });
    return activeEntryId;
  };

  const flushSegment = (): void => {
    if (abortSignal?.aborted) {
      if (activeEntryId) events.remove(activeEntryId);
      activeEntryId = null;
      activeSegmentText = '';
      return;
    }

    const entryId = ensureLiveEntry();
    if (!entryId) return;
    events.finalize(entryId);
    activeEntryId = null;
    activeSegmentText = '';
  };

  return {
    appendChunk(chunk: string): void {
      if (abortSignal?.aborted || !chunk) return;
      activeSegmentText += chunk;
      ensureLiveEntry();
    },

    closeSegment(): void {
      flushSegment();
    },

    discardSegment(): void {
      if (activeEntryId) events.remove(activeEntryId);
      activeEntryId = null;
      activeSegmentText = '';
    },

    ensureMessage(content: string): void {
      if (abortSignal?.aborted || !content || activeSegmentText.length > 0) return;
      activeSegmentText = content;
      ensureLiveEntry();
    },

    replaceMessage(content: string): void {
      if (abortSignal?.aborted || !content) return;
      activeSegmentText = content;
      ensureLiveEntry();
    },
  };
}

type ToolCallEvent = Extract<QueryEvent, { type: 'tool_call' }>;
type ToolResultEvent = Extract<QueryEvent, { type: 'tool_result' }>;

interface LocalFastPathAction {
  tool: string;
  args: Record<string, unknown>;
  label: string;
}

class LocalFastPathBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalFastPathBlockedError';
  }
}

function parseLocalFastPath(input: string): LocalFastPathAction | null {
  const text = input.trim();
  if (/^git\s+status$/i.test(text)) {
    return { tool: 'git_status', args: {}, label: 'git status' };
  }

  const readMatch = /^(?:read|读取)\s+(.+)$/i.exec(text);
  const readTarget = readMatch?.[1]?.trim();
  const looksLikePath =
    Boolean(readTarget) &&
    !/\s/.test(readTarget!) &&
    (/[/\\.]/.test(readTarget!) || readTarget!.startsWith('~'));
  if (readTarget && looksLikePath) {
    return { tool: 'read_file', args: { path: readTarget }, label: `read ${readTarget}` };
  }

  const grepMatch = /^(?:grep|搜索)\s+(.+)$/i.exec(text);
  if (grepMatch?.[1]?.trim()) {
    return {
      tool: 'grep',
      args: { pattern: grepMatch[1].trim() },
      label: `grep ${grepMatch[1].trim()}`,
    };
  }

  const runTestMatch = /^(?:run\s+test|运行测试)\s*[:：]\s*(.+)$/i.exec(text);
  if (runTestMatch?.[1]?.trim()) {
    return {
      tool: 'exec_command',
      args: { command: runTestMatch[1].trim() },
      label: `run test: ${runTestMatch[1].trim()}`,
    };
  }

  return null;
}

function formatLocalFastPathAssistantContent(
  action: LocalFastPathAction,
  rawResult: string,
  projectPath: string
): { content: string; artifactRef?: { id: string; outputBytes: number } } {
  const envelope = parseToolResultEnvelope(rawResult);
  const rawOutput = typeof envelope.output === 'string' ? envelope.output : '';
  const output = rawOutput.trim();
  const summary = envelope.summary || `${action.tool} ${envelope.success ? 'completed' : 'failed'}`;
  const lines = [
    envelope.success
      ? `Local fast path completed ${action.label}.`
      : `Local fast path failed ${action.label}.`,
    '',
    summary,
  ];
  if (!envelope.success && envelope.error) {
    lines.push(`Error: ${envelope.error}`);
  }

  if (!output) {
    return { content: lines.join('\n'), artifactRef: envelope.artifactRef };
  }

  let artifactRef = envelope.artifactRef;
  let preview = output;
  const outputBytes = envelope.outputBytes ?? byteLength(rawOutput);
  if (byteLength(rawOutput) > LOCAL_FAST_PATH_INLINE_OUTPUT_BYTES) {
    if (!artifactRef) {
      const artifact = storeArtifact(projectPath, action.tool, rawOutput, outputBytes);
      artifactRef = artifact ? { id: artifact.id, outputBytes: artifact.outputBytes } : undefined;
    }
    preview = truncateForContext(output, LOCAL_FAST_PATH_INLINE_OUTPUT_BYTES);
  }

  if (artifactRef) {
    lines.push(
      '',
      `Full output: /artifacts show ${artifactRef.id} --full (${formatBytes(artifactRef.outputBytes)})`
    );
  }
  lines.push('', 'Preview:', preview);
  return { content: lines.join('\n'), artifactRef };
}

export interface ToolEventPresenter {
  start(event: ToolCallEvent): void;
  finish(event: ToolResultEvent): void;
  finalizePendingAsSkipped(reason?: string): void;
}

export function createToolEventPresenter(
  events: UiEventSink,
  options: ToolEventPresenterOptions = {},
): ToolEventPresenter {
  const runningToolEntries = new Map<
    string,
    {
      entryId: string;
      name: string;
      args: Record<string, unknown>;
      sequence: number;
      batchCount?: number;
      batchIndex?: number;
    }
  >();
  let toolSequenceCounter = 0;

  return {
    start(event: ToolCallEvent): void {
      const seq = ++toolSequenceCounter;
      const entryId = events.append({
        role: 'tool',
        title: 'tool',
        content: toolStartContent(event),
        toolActivity: structuredToolStartActivity(event, seq),
      });
      runningToolEntries.set(event.callId, {
        entryId,
        name: event.name,
        args: event.args,
        sequence: seq,
        batchCount: event.batchCount,
        batchIndex: event.batchIndex,
      });
      events.toolStarted?.({
        callId: event.callId,
        name: event.name,
        args: event.args,
        sequence: seq,
        batchCount: event.batchCount,
        batchIndex: event.batchIndex,
      });
    },

    finish(event: ToolResultEvent): void {
      const content = toolFinishContent(event);
      const stored = runningToolEntries.get(event.callId);
      const seq = stored?.sequence ?? ++toolSequenceCounter;
      const toolActivity = structuredToolFinishActivity(event, seq, options);

      if (stored) {
        events.finalize(stored.entryId, {
          role: event.success ? 'tool' : 'error',
          title: 'tool',
          content,
          toolActivity,
        });
        runningToolEntries.delete(event.callId);
      } else {
        const entryId = events.append({
          role: event.success ? 'tool' : 'error',
          title: 'tool',
          content,
          toolActivity,
        });
        events.finalize(entryId);
      }

      events.toolFinished?.({
        callId: event.callId,
        name: event.name,
        args: event.args,
        success: event.success,
        duration: event.duration,
        summary: event.summary,
        error: event.error,
        outputBytes: event.outputBytes,
        artifactRef: toolActivity.outputView?.detailRef?.artifactId
          ? {
            id: toolActivity.outputView.detailRef.artifactId,
            outputBytes: toolActivity.outputView.detailRef.outputBytes,
          }
          : event.artifactRef,
        sequence: seq,
        batchCount: event.batchCount,
        batchIndex: event.batchIndex,
      });
    },

    finalizePendingAsSkipped(reason = 'permission denied'): void {
      for (const [callId, entry] of runningToolEntries) {
        events.finalize(entry.entryId, {
          role: 'tool',
          title: 'tool',
          content: `Skipped · ${reason}`,
          toolActivity: {
            state: 'skipped',
            name: entry.name,
            detail: '',
            body: '',
            error: reason,
            seq: entry.sequence,
          },
        });
        events.toolFinished?.({
          callId,
          name: entry.name,
          args: entry.args,
          success: false,
          skipped: true,
          duration: 0,
          error: reason,
          sequence: entry.sequence,
          batchCount: entry.batchCount,
          batchIndex: entry.batchIndex,
        });
      }
      runningToolEntries.clear();
    },
  };
}

async function captureConsoleOutput(
  fn: () => Promise<CommandResult> | CommandResult
): Promise<{ result: CommandResult; output: string }> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const capture = (...args: unknown[]) => {
    lines.push(
      stripAnsi(args.map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
    );
  };

  console.log = capture;
  console.error = capture;
  console.warn = capture;
  try {
    const result = await fn();
    return { result, output: lines.join('\n').trim() };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }
}

export interface RunInputOptions {
  abortSignal?: AbortSignal;
  turnId?: number | string;
}

export interface AgentChatControllerOptions {
  confirmToolUse?: Parameters<typeof query>[0]['confirmToolUse'];
  uiCapabilities?: UiRendererCapabilities;
  uiRenderer?: CommandUiRenderer;
  onVerificationStateChange?: (
    state: 'pending' | 'running' | 'passed' | 'failed' | 'gated'
  ) => void;
  /**
   * R6: returns true when a tool permission request is awaiting user decision.
   * When provided, the subagent policy gate uses it to prevent background
   * delegation while the user is deciding a permission. When absent, defaults
   * to false (no pending permission) — the root loop should inject the real
   * state via AgentRuntimeController.
   */
  hasPendingPermission?: () => boolean;
  /**
   * R6: called with each child's observed usage so the root loop can record
   * it into its shared CostTracker. The observed values are never clamped;
   * `/cost` and telemetry must reflect the truth.
   */
  onChildUsage?: (
    taskId: string,
    role: import('./subagents/types').SubagentRole,
    usage: import('./subagents/types').SubtaskUsage,
    modelLabel?: string
  ) => void;
}

/** @deprecated Use AgentChatControllerOptions. Chat execution is renderer-independent. */
export type InkChatControllerOptions = AgentChatControllerOptions;

export class AgentChatController {
  /** v0.2.26: optional goal coordinator for prompt injection and turn finalization. */
  private goalCoordinator: import('./goals/coordinator').GoalCoordinator | null = null;

  setGoalCoordinator(coord: import('./goals/coordinator').GoalCoordinator | null): void {
    this.goalCoordinator = coord;
  }

  constructor(
    private readonly runtime: OpenHorseUiRuntime,
    private readonly events: UiEventSink,
    private readonly controllerOptions: AgentChatControllerOptions = {}
  ) {}

  private setLoopStats(stats: LoopStats): void {
    this.runtime.store.setLastLoopStats(stats);
    this.events.loopStatsUpdated?.(stats);
  }

  async runInput(input: string, options: RunInputOptions = {}): Promise<void> {
    const text = input.trim();
    if (!text) return;

    const parsed = parseInput(text);
    if (!parsed.isCommand) {
      const localFastPath = parseLocalFastPath(text);
      if (localFastPath) {
        await this.runLocalFastPath(text, localFastPath, options);
        return;
      }
      await this.runChat(text, options);
      return;
    }

    if (parsed.name === 'clear') {
      this.events.clearTranscript();
      this.events.setStatus('View cleared. Conversation context is preserved.');
      return;
    }

    if (parsed.name === 'exit' || parsed.name === 'quit' || parsed.name === 'q') {
      await this.runtime.shutdown();
      return;
    }

    const command = findCommand(parsed.name);
    if (!command) {
      if (hasMatchingSkill(text, this.runtime.cwd)) {
        await this.runChat(text, options);
        return;
      }

      const suggestions = buildCommandSuggestions(parsed.name);
      this.events.append({
        role: 'error',
        title: 'unknown command',
        content:
          suggestions.length > 0
            ? `Unknown command: /${parsed.name}\nDid you mean: ${suggestions.map(item => `/${item}`).join(', ')}?`
            : `Unknown command: /${parsed.name}`,
        errorLayer: 'runtime',
      });
      return;
    }

    const ctx = this.createCommandContext(options.abortSignal, options.turnId);
    const { result, output } = await captureConsoleOutput(() => command.execute(ctx, parsed.args));

    if (output) {
      this.events.append({
        role: result.success ? 'system' : 'error',
        title: `/${command.name}`,
        content: output,
      });
    }

    if (result.output) {
      this.events.append({
        role: result.success ? 'system' : 'error',
        title: `/${command.name}`,
        content: result.output,
      });
    }

    if (result.error) {
      this.events.append({
        role: 'error',
        title: `/${command.name}`,
        content: result.error,
        errorLayer: 'runtime',
      });
    }

    if (result.sessionPicker) {
      this.events.showSessionPicker(result.sessionPicker);
      return;
    }

    if (result.editPreview) {
      this.events.showEditPreview(result.editPreview);
      return;
    }

    if (result.continueAsChat) {
      await this.runChat(result.chatInput ?? parsed.args, options);
    }
  }

  private async runLocalFastPath(
    input: string,
    action: LocalFastPathAction,
    options: RunInputOptions = {}
  ): Promise<void> {
    const activeSession =
      this.runtime.getSession() ??
      this.runtime.ensureSession() ??
      loadSessionMeta(this.runtime.getSession()?.id ?? '');
    const sessionId = activeSession?.id;
    const turnId = traceTurnId(options.turnId);
    const localCallId = `local-${turnId}`;
    const start = Date.now();
    const preWorkspace = captureWorkspaceSnapshot(this.runtime.cwd);
    const traceArgs = buildTraceArgsDetails(this.runtime.cwd, action.tool, action.args);

    if (sessionId) {
      appendSessionMessage(sessionId, {
        role: 'user',
        content: input,
        timestamp: Date.now(),
      });
      recordTraceEvent(this.events, sessionId, {
        turnId,
        type: 'turn_start',
        inputBytes: byteLength(input),
        localFastPathUsed: true,
      });
      appendWorkspaceSnapshotTrace(this.events, sessionId, turnId, 'pre_turn', preWorkspace);
      recordTraceEvent(this.events, sessionId, {
        turnId,
        type: 'local_fast_path',
        name: action.tool,
        ...traceArgs,
        note: compactMiddle(action.label, 160),
      });
    }
    this.runtime.store.addMessage({ role: 'user', content: input });
    this.events.setStatus(`Running local ${action.label}...`);

    try {
      const tool = getRuntimeTools().find(candidate => candidate.name === action.tool);
      const toolContext = {
        cwd: this.runtime.cwd,
        config: {
          name: this.runtime.config.name,
          mode: this.runtime.config.mode,
        },
        sessionId,
        turnId,
      };
      const permission = tool?.checkPermissions?.(action.args, toolContext);
      if (permission?.behavior === 'deny' || tool?.isDestructive?.(action.args) === true) {
        const reason = permission?.reason || 'Local fast path blocked a destructive tool request.';
        throw new LocalFastPathBlockedError(reason);
      }
      if (permission?.behavior === 'ask') {
        throw new LocalFastPathBlockedError(
          permission.reason || 'Local fast path requires an allow-safe command.'
        );
      }

      if (sessionId) {
        recordTraceEvent(this.events, sessionId, {
          turnId,
          type: 'tool_call',
          name: action.tool,
          callId: localCallId,
          ...traceArgs,
        });
      }
      const result = await executeTool(action.tool, action.args, options.abortSignal, {
        ...toolContext,
        sessionId,
        turnId,
      });
      const duration = Date.now() - start;
      const envelope = parseToolResultEnvelope(result);
      const outputBytes =
        typeof envelope.outputBytes === 'number'
          ? envelope.outputBytes
          : Buffer.byteLength(result, 'utf8');
      const formattedLocalResult = formatLocalFastPathAssistantContent(
        action,
        result,
        this.runtime.cwd
      );
      const assistantContent = formattedLocalResult.content;
      const stats = createLocalFastPathLoopStats({
        finishReason: envelope.success ? 'completed' : 'failed',
        toolCalls: 1,
        readOnlyToolCalls: action.tool === 'exec_command' ? 0 : 1,
        unsafeToolCalls: action.tool === 'exec_command' ? 1 : 0,
        toolResultBytes: outputBytes,
        modelVisibleToolBytes: 0,
        summarizedBytes: outputBytes,
      });

      const localToolResultEvent: ToolResultEvent = {
        type: 'tool_result',
        name: action.tool,
        args: action.args,
        callId: localCallId,
        result,
        modelVisibleResult: result,
        duration,
        success: envelope.success,
        error: envelope.error,
        summary: envelope.summary,
        outputBytes,
        artifactRef: formattedLocalResult.artifactRef,
      };
      this.events.append({
        role: envelope.success ? 'tool' : 'error',
        title: 'local',
        content: toolFinishContent(localToolResultEvent),
        toolActivity: structuredToolFinishActivity(localToolResultEvent, 1, {
          projectPath: this.runtime.cwd,
          turnId,
        }),
      });

      this.runtime.store.addMessage({ role: 'assistant', content: assistantContent });
      this.setLoopStats(stats);

      if (sessionId) {
        recordTraceEvent(this.events, sessionId, {
          turnId,
          type: 'tool_result',
          name: action.tool,
          callId: localCallId,
          argsSummary: traceArgs.argsSummary,
          argsArtifactId: traceArgs.argsArtifactId,
          argsBytes: traceArgs.argsBytes,
          success: envelope.success,
          duration,
          outputBytes,
          modelVisibleBytes: 0,
          artifactId: formattedLocalResult.artifactRef?.id,
          error: envelope.error ? compactMiddle(envelope.error, 240) : undefined,
        });
        appendPostWorkspaceTrace(this.events, sessionId, turnId, this.runtime.cwd, preWorkspace);
        recordTraceEvent(this.events, sessionId, {
          turnId,
          type: 'complete',
          finishReason: stats.finishReason,
          llmRequests: stats.llmRequests,
          toolCalls: stats.toolCalls,
          readOnlyToolCalls: stats.readOnlyToolCalls,
          unsafeToolCalls: stats.unsafeToolCalls,
          localFastPathUsed: true,
        });
        appendSessionMessage(sessionId, {
          role: 'assistant',
          content: assistantContent,
          timestamp: Date.now(),
        });
        const recordedMessages = readSessionMessages(sessionId);
        if (recordedMessages.length > 0) {
          updateSessionSummary(sessionId, recordedMessages);
        }
      }

      this.events.setStatus(
        envelope.success ? `Completed local ${action.label}` : `Failed local ${action.label}`
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.events.append({ role: 'error', title: 'local', content: message, errorLayer: 'tool' });
      this.events.setStatus('Local command failed. Ready for the next input.');
      const assistantContent = `Local fast path failed for ${action.label}.\n\n${message}`;
      this.runtime.store.addMessage({ role: 'assistant', content: assistantContent });
      const finishReason: LoopFinishReason =
        error instanceof LocalFastPathBlockedError ? 'blocked' : 'failed';
      const stats = createLocalFastPathLoopStats({
        finishReason,
        toolCalls: 0,
      });
      this.setLoopStats(stats);
      if (sessionId) {
        recordTraceEvent(this.events, sessionId, {
          turnId,
          type: 'error',
          name: action.tool,
          error: compactTraceError(error),
        });
        appendPostWorkspaceTrace(this.events, sessionId, turnId, this.runtime.cwd, preWorkspace);
        recordTraceEvent(this.events, sessionId, {
          turnId,
          type: 'complete',
          finishReason: stats.finishReason,
          llmRequests: stats.llmRequests,
          toolCalls: stats.toolCalls,
          localFastPathUsed: true,
          note: 'local_fast_path_failed',
        });
        appendSessionMessage(sessionId, {
          role: 'assistant',
          content: assistantContent,
          timestamp: Date.now(),
        });
      }
    }
  }

  private createCommandContext(
    abortSignal?: AbortSignal,
    turnId?: number | string
  ): CommandContext {
    return {
      cwd: this.runtime.cwd,
      config: this.runtime.config,
      store: this.runtime.store,
      llm: this.runtime.llm,
      compactCoordinator: this.runtime.compactCoordinator,
      runtime: this.runtime.runtime,
      sessionId: this.runtime.getSession()?.id,
      turnId,
      ensureSession: this.runtime.ensureSession,
      setSession: session => {
        this.runtime.setSession(session);
        const renderer = this.controllerOptions.uiRenderer
          ?? this.runtime.config.ui?.renderer
          ?? 'terminal';
        this.events.replaceTranscript(sessionMessagesToTranscriptEntries(session.id, {
          includeToolOutputViews: renderer === 'tui',
        }));
      },
      sessionRestored: event => {
        this.events.sessionRestored?.(event);
      },
      getSession: this.runtime.getSession,
      abortSignal,
      writeOutput: text => {
        if (text.trim()) {
          this.events.append({ role: 'system', content: text });
        }
      },
      writeLine: text => {
        if (text?.trim()) {
          this.events.append({ role: 'system', content: text });
        }
      },
      uiRenderer:
        this.controllerOptions.uiRenderer ?? this.runtime.config.ui?.renderer ?? 'terminal',
      uiCapabilities: resolveUiRendererCapabilities(
        this.controllerOptions.uiCapabilities,
        this.controllerOptions.uiRenderer ?? this.runtime.config.ui?.renderer
      ),
    };
  }

  /**
   * Forward a subagent lifecycle event to the runtime event sink and session
   * trace. Renderers consume the same event across terminal/Ink/TUI; this is
   * the only place a subtask event touches the root loop.
   */
  private handleSubtaskEvent(
    event: RuntimeSubtaskEvent,
    sessionId: string | undefined,
    turnId: number | string
  ): void {
    // Emit the renderer-independent runtime event first so all renderers
    // (terminal/Ink/TUI) consume the same lifecycle through one protocol.
    this.events.subtaskEvent?.(event);
    const stateToTraceType: Partial<
      Record<RuntimeSubtaskEvent['state'], SessionTraceEvent['type']>
    > = {
      queued: 'subtask_requested',
      running: 'subtask_started',
      completed: 'subtask_completed',
      failed: 'subtask_failed',
      cancelled: 'subtask_cancelled',
      rejected: 'subtask_rejected',
      timed_out: 'subtask_timed_out',
    };
    if (sessionId) {
      const traceType = stateToTraceType[event.state];
      if (traceType) {
        recordTraceEvent(this.events, sessionId, {
          turnId: String(turnId),
          type: traceType,
          name: `${event.role}:${event.taskId}`,
          argsSummary: event.objective.slice(0, 160),
        });
      }
    }
    // Surface start/complete/fail/cancel summaries in the transcript so all
    // renderers show subtask progress without renderer-local logic.
    if (event.state === 'running') {
      this.events.append({
        role: 'system',
        content: `▸ subtask ${event.role} started: ${event.objective.slice(0, 120)}`,
      });
    } else if (
      event.state === 'completed' ||
      event.state === 'failed' ||
      event.state === 'cancelled' ||
      event.state === 'timed_out' ||
      event.state === 'rejected'
    ) {
      const summary = event.summary ? ` — ${event.summary.slice(0, 200)}` : '';
      this.events.append({
        role: 'system',
        content: `◂ subtask ${event.role} ${event.state}${summary}`,
      });
    }
  }

  /**
   * Fold reconciled child aggregate usage into the root turn's loop stats so
   * `/cost` and loop-budget accounting reflect subagent cost. Child model
   * requests and tool calls are added to the root counters; a note records the
   * subagent contribution so it is distinguishable from root work.
   */
  private foldSubagentUsage(stats: LoopStats, bundle: SubagentTurnBundle | null): LoopStats {
    if (!bundle) return stats;
    const usage = bundle.getAggregateUsage();
    if (usage.modelRequests === 0 && usage.toolCalls === 0) return stats;
    const subtaskCount = bundle.getSubtaskCount();
    const subagentSuffix = `subagents: ${usage.modelRequests} req/${usage.toolCalls} calls across ${subtaskCount} task(s)`;
    return {
      ...stats,
      llmRequests: (stats.llmRequests ?? 0) + usage.modelRequests,
      toolCalls: (stats.toolCalls ?? 0) + usage.toolCalls,
      readOnlyToolCalls: (stats.readOnlyToolCalls ?? 0) + usage.toolCalls,
      continuationHint: stats.continuationHint
        ? `${stats.continuationHint} (${subagentSuffix})`
        : subagentSuffix,
    };
  }

  private async runChat(
    input: string,
    options: { abortSignal?: AbortSignal; turnId?: number | string } = {}
  ): Promise<void> {
    if (!input) {
      this.events.append({
        role: 'error',
        content: 'Usage: /chat <message>',
        errorLayer: 'runtime',
      });
      return;
    }

    if (!this.runtime.llm || !isConfigured(this.runtime.config)) {
      this.events.append({
        role: 'error',
        content:
          'LLM is not configured. Set ORION_CODE_API_KEY in ~/.orion-code/orion.json or environment.',
        errorLayer: 'provider',
      });
      return;
    }

    const abortSignal = options.abortSignal;
    const turnId = traceTurnId(options.turnId);
    const activeSession =
      this.runtime.getSession() ??
      this.runtime.ensureSession() ??
      loadSessionMeta(this.runtime.getSession()?.id ?? '');
    const sessionId = activeSession?.id;
    const preWorkspace = captureWorkspaceSnapshot(this.runtime.cwd);
    const runtimeTools = getRuntimeTools();
    const skillResolution = resolveSkillsForTurn({
      cwd: this.runtime.cwd,
      input,
      tools: runtimeTools,
      projectPath: activeSession?.projectPath,
      sessionId,
    });
    const appliedSkillNames = skillResolution.skills.map(skill => skill.name);

    if (sessionId) {
      appendSessionMessage(sessionId, {
        role: 'user',
        content: input,
        timestamp: Date.now(),
        appliedSkills: appliedSkillNames.length > 0 ? appliedSkillNames : undefined,
      });
      recordTraceEvent(this.events, sessionId, {
        turnId,
        type: 'turn_start',
        inputBytes: byteLength(input),
        note: appliedSkillNames.length > 0 ? `skills=${appliedSkillNames.join(',')}` : undefined,
      });
      appendWorkspaceSnapshotTrace(this.events, sessionId, turnId, 'pre_turn', preWorkspace);
    }

    this.runtime.store.addMessage({ role: 'user', content: input });
    refreshProjectInstructions(this.runtime.store, this.runtime.cwd);
    const snapshot = this.runtime.store.getSnapshot();
    const harness = createContextHarness({
      cwd: this.runtime.cwd,
      modelId: this.runtime.llm.getModel(),
      state: snapshot.harnessState,
      config: {
        enabled: true,
        driftGuard: 'warn',
        completionGate: true,
      },
    });
    const intent = harness.updateContractFromUserInput(input);
    harness.recordAppliedSkills(skillResolution.skills);

    // Reconcile diagnostic: when harness state is present but objective may be incomplete
    if (
      snapshot.harnessState &&
      !snapshot.harnessState.rootObjective &&
      !snapshot.harnessState.contract?.objective
    ) {
      this.events.setStatus(
        'Resume diagnostic: harness state restored but objective may be incomplete. Run /harness explain to review.'
      );
    }

    const subagentConfig = this.runtime.config.subagents;
    // The subtask capability is a root-level tool. It is exposed on normal
    // turns, but respects an active skill scope: when a skill restricts the
    // tool set, subtask is not appended (the skill owns the scope).
    const projectPath = activeSession?.projectPath;
    const subagentBundle: SubagentTurnBundle | null =
      subagentConfig &&
      subagentConfig.mode !== 'off' &&
      this.runtime.llm &&
      !skillResolution.toolScopeActive
        ? createSubagentBundleForTurn({
            config: subagentConfig,
            cwd: this.runtime.cwd,
            rootLlmConfig: deriveRootLlmConfig(this.runtime.config),
            modelLabel: this.runtime.llm.getModel(),
            rootObjectiveSummary: harness.toJSON()?.rootObjective ?? input,
            abortSignal,
            resilience: this.runtime.llm.resilience,
            onSubtaskEvent: event => {
              this.handleSubtaskEvent(event, sessionId, turnId);
            },
            onSubtaskResult: (result, _batchId) => {
              if (!projectPath || result.status !== 'completed') return;
              const json = JSON.stringify(result);
              const artifact = storeArtifact(
                projectPath,
                `subtask_${result.role}`,
                json,
                Buffer.byteLength(json, 'utf8')
              );
              if (artifact) {
                // Record a trace event for artifact discoverability only.
                // The subtask state transition (subtask_completed) is already
                // emitted by handleSubtaskEvent above.
                if (sessionId) {
                  recordTraceEvent(this.events, sessionId, {
                    turnId: String(turnId),
                    type: 'subtask_artifact_stored',
                    name: `${result.role}:${result.id}`,
                    argsSummary: result.summary.slice(0, 200),
                    argsArtifactId: artifact.id,
                    argsBytes: artifact.outputBytes,
                  });
                }
              }
            },
            // R6: wire live permission state so the subagent policy gate can
            // prevent background delegation while the user is deciding a tool
            // permission. Injected by AgentRuntimeController via chatOptions.
            hasPendingPermission: this.controllerOptions.hasPendingPermission,
            // R6: wire child usage callback so CostTracker records subagent
            // token consumption. Injected by AgentRuntimeController via chatOptions.
            onChildUsage: this.controllerOptions.onChildUsage,
          })
        : null;
    const subtaskTool = subagentBundle?.tool ?? null;
    const turnTools = subtaskTool ? [...skillResolution.tools, subtaskTool] : skillResolution.tools;

    const promptCtx: PromptContext = {
      cwd: this.runtime.cwd,
      platform: process.platform,
      nodeVersion: process.version,
      tools: turnTools,
      memoryContent: snapshot.memoryContent,
      skillsContent: snapshot.skillsContent,
      projectInstructionsContent: snapshot.projectInstructionsContent,
      activeSkillsContent: skillResolution.promptInjection,
      referencedFilesContent: buildReferencedFilesPrompt(input, this.runtime.cwd),
      goalContent: this.goalCoordinator?.goal?.status === 'active'
        ? buildGoalContextFragment(this.goalCoordinator.goal)?.text
        : undefined,
    };
    const systemPrompt = buildSystemPrompt(promptCtx);
    const messages: Message[] = [
      { role: 'system', content: systemPrompt.static, cacheControl: { type: 'ephemeral' } },
      ...(systemPrompt.dynamic ? [{ role: 'system' as const, content: systemPrompt.dynamic }] : []),
      ...snapshot.conversationHistory,
    ];

    let finalContent = '';
    let finalUsage: { promptTokens: number; completionTokens: number } | undefined;
    let finalModel = '';
    let pendingCompleteTrace: Omit<SessionTraceEvent, 'sessionId' | 'timestamp'> | null = null;
    let pendingCompleteStats: LoopStats | undefined;
    let pendingCompact: QueryCompactCommit | undefined;
    const verificationResults: VerificationCommandResult[] = [];
    const sessionMessagesToRecord: SessionMessage[] = [];
    const assistantStream = createAssistantStreamPresenter(this.events, abortSignal);
    const toolEvents = createToolEventPresenter(this.events, {
      projectPath: this.runtime.cwd,
      turnId,
    });
    let checkpointSequence = 0;
    const checkpointIds: string[] = [];

    const streamCallbacks: StreamCallbacks = {
      onChunk: chunk => {
        assistantStream.appendChunk(chunk);
      },
    };

    const toolExecutor = async (
      name: string,
      args: Record<string, unknown>,
      signal?: AbortSignal
    ) => {
      // The runtime-bound `subtask` tool is not in the global TOOLS registry;
      // dispatch it directly so it reaches the Supervisor closure.
      if (name === 'subtask' && subtaskTool) {
        const result = await subtaskTool.execute(args, {
          cwd: this.runtime.cwd,
          config: { name: this.runtime.config.name, mode: this.runtime.config.mode },
          abortSignal: signal,
          sessionId,
          turnId,
        });
        return JSON.stringify(result);
      }
      if (!turnTools.some(tool => tool.name === name)) {
        return JSON.stringify({
          success: false,
          error: skillResolution.toolScopeActive
            ? `Tool ${name} is not available for the active skill scope. Available tools: ${skillResolution.tools.map(tool => tool.name).join(', ') || 'none'}`
            : `Tool ${name} is not available.`,
        });
      }
      return executeTool(name, args, signal, {
        cwd: this.runtime.cwd,
        config: {
          name: this.runtime.config.name,
          mode: this.runtime.config.mode,
        },
        sessionId,
        turnId,
      });
    };

    const loopBudget = resolveRuntimeLoopBudget(input, this.runtime.config, harness.toJSON());
    let observedTurnsStarted = 0;
    let observedLlmRequests = 0;
    let observedToolCalls = 0;
    let observedReadOnlyToolCalls = 0;
    let observedUnsafeToolCalls = 0;
    let observedToolResultBytes = 0;
    let observedModelVisibleToolBytes = 0;

    try {
      for await (const event of query({
        messages,
        tools: turnTools,
        toolExecutor,
        llm: this.runtime.llm,
        streamCallbacks,
        costTracker: snapshot.costTracker,
        permissionMode: snapshot.permissionMode,
        toolConfirmation: this.runtime.config.toolConfirmation,
        confirmToolUse: this.controllerOptions.confirmToolUse,
        toolContext: {
          cwd: this.runtime.cwd,
          config: {
            name: this.runtime.config.name,
            mode: this.runtime.config.mode,
          },
          sessionId,
          turnId,
        },
        abortSignal,
        harness,
        input,
        loopBudget,
        onContextUsage: usage => {
          this.runtime.store.setContextUsage(usage);
        },
        compactCoordinator: this.runtime.compactCoordinator,
      })) {
        switch (event.type) {
          case 'request_start':
            observedTurnsStarted = Math.max(observedTurnsStarted, event.turn);
            observedLlmRequests++;
            assistantStream.discardSegment();
            this.events.setStatus(agentStepStatus(event.turn));
            if (sessionId) {
              recordTraceEvent(this.events, sessionId, {
                turnId,
                type: 'request_start',
                model: event.model,
                turn: event.turn,
              });
            }
            break;
          case 'prompt_assembly':
            if (sessionId) {
              recordTraceEvent(this.events, sessionId, {
                turnId,
                type: 'prompt_assembly',
                promptModelId: event.modelId,
                promptEstimatedTokens: event.estimatedTokens,
                promptBudgetTokens: event.budgetTokens,
                promptCoreTokens: event.coreTokens,
                promptEvidenceBudgetTokens: event.evidenceBudgetTokens,
                promptRecentTurnBudgetTokens: event.recentTurnBudgetTokens,
                promptSections: event.sections,
                promptIncludedEvidence: event.includedEvidence,
                promptOmittedEvidence: event.omittedEvidence,
                promptIncludedEvidenceCount: event.includedEvidenceCount,
                promptOmittedEvidenceCount: event.omittedEvidenceCount,
              });
            }
            break;
          case 'assistant_tool_calls':
            assistantStream.ensureMessage(event.content || '');
            assistantStream.closeSegment();
            this.events.setStatus(runningToolsStatus(event.toolCalls.length));
            {
              const batchReadOnlyCount = event.toolCalls.filter(tc => {
                const def = skillResolution.tools.find(t => t.name === tc.function.name);
                const args = parseToolCallArgsForRuntime(tc);
                return args && def?.isReadOnly?.(args) === true;
              }).length;
              const suggestion = batchingSuggestion(batchReadOnlyCount);
              if (suggestion) {
                this.events.append({ role: 'status', content: suggestion });
              }
            }
            const checkpointId =
              checkpointSequence === 0 ? turnId : `${turnId}-checkpoint-${checkpointSequence + 1}`;
            const checkpointResult = createPreToolCheckpoint(
              this.events,
              sessionId,
              turnId,
              checkpointId,
              this.runtime.cwd,
              event.toolCalls
            );
            if (checkpointResult.created) {
              checkpointIds.push(checkpointId);
              checkpointSequence++;
            }
            if (checkpointResult.created && checkpointResult.risky) {
              this.events.append({
                role: 'status',
                title: 'checkpoint',
                statusTone: 'warning',
                content: `Risky edit: ${checkpointResult.targetCount} files in one turn. Checkpoint ${checkpointId} created for rollback (/checkpoints restore ${checkpointId}).`,
              });
            } else if (checkpointResult.risky) {
              this.events.append({
                role: 'status',
                title: 'checkpoint',
                statusTone: 'warning',
                content: `Risky edit: ${checkpointResult.targetCount} files in one turn, but checkpoint creation failed. Restore any pre-existing checkpoint manually or revert via git.`,
              });
            }
            if (sessionId) {
              recordTraceEvent(this.events, sessionId, {
                turnId,
                type: 'assistant_tool_calls',
                toolCallCount: event.toolCalls.length,
                contentBytes: byteLength(event.content || ''),
              });
            }
            sessionMessagesToRecord.push({
              role: 'assistant',
              content: event.content || '',
              timestamp: Date.now(),
              tool_calls: event.toolCalls,
            });
            break;
          case 'tool_call':
            observedToolCalls++;
            {
              const toolDefinition = skillResolution.tools.find(tool => tool.name === event.name);
              if (toolDefinition?.isReadOnly?.(event.args) === true) {
                observedReadOnlyToolCalls++;
              } else {
                observedUnsafeToolCalls++;
              }
            }
            assistantStream.closeSegment();
            toolEvents.start(event);
            if (sessionId) {
              const traceArgs = buildTraceArgsDetails(this.runtime.cwd, event.name, event.args);
              recordTraceEvent(this.events, sessionId, {
                turnId,
                type: 'tool_call',
                name: event.name,
                callId: event.callId,
                ...traceArgs,
                batchCount: event.batchCount,
                batchIndex: event.batchIndex,
              });
            }
            break;
          case 'permission_decision':
            if (sessionId) {
              recordTraceEvent(this.events, sessionId, {
                turnId,
                type: 'permission_decision',
                name: event.name,
                callId: event.callId,
                argsSummary: compactToolArgs(event.args),
                permissionBehavior: event.decision.behavior,
                permissionApproved: event.decision.approved,
                permissionSource: event.decision.source,
                permissionReason: event.decision.reason
                  ? compactMiddle(event.decision.reason, 240)
                  : undefined,
                permissionDuration: event.decision.duration,
                batchCount: event.batchCount,
                batchIndex: event.batchIndex,
              });
            }
            break;
          case 'tool_result': {
            observedToolResultBytes += event.outputBytes ?? byteLength(event.result);
            observedModelVisibleToolBytes += byteLength(event.modelVisibleResult);
            toolEvents.finish(event);
            if (sessionId) {
              recordTraceEvent(this.events, sessionId, {
                turnId,
                type: 'tool_result',
                name: event.name,
                callId: event.callId,
                argsSummary: compactToolArgs(event.args),
                success: event.success,
                duration: event.duration,
                outputBytes: event.outputBytes,
                modelVisibleBytes: byteLength(event.modelVisibleResult),
                artifactId: event.artifactRef?.id,
                error: event.error ? compactMiddle(event.error, 240) : undefined,
                batchCount: event.batchCount,
                batchIndex: event.batchIndex,
              });
            }
            const verificationResult = collectVerificationCommandResult({
              toolName: event.name,
              args: event.args,
              success: event.success,
              outputBytes: event.outputBytes,
              error: event.error,
            });
            if (verificationResult) {
              verificationResults.push(verificationResult);
              appendVerificationResultTrace(this.events, sessionId, turnId, verificationResult);
            }
            sessionMessagesToRecord.push({
              role: 'tool',
              content: event.result,
              modelVisibleContent: event.modelVisibleResult,
              timestamp: Date.now(),
              toolCallId: event.callId,
            });
            break;
          }
          case 'strategy_exhausted':
            this.events.append({ role: 'status', content: event.suggestion });
            if (sessionId) {
              recordTraceEvent(this.events, sessionId, {
                turnId,
                type: 'strategy_exhausted',
                note: compactMiddle(event.suggestion, 240),
              });
            }
            break;
          case 'message':
            finalContent = event.content;
            assistantStream.ensureMessage(event.content);
            if (sessionId) {
              recordTraceEvent(this.events, sessionId, {
                turnId,
                type: 'message',
                contentBytes: byteLength(event.content),
              });
            }
            if (event.content) {
              sessionMessagesToRecord.push({
                role: 'assistant',
                content: event.content,
                timestamp: Date.now(),
              });
            }
            break;
          case 'complete':
            if (event.stats?.finishReason === 'blocked') {
              toolEvents.finalizePendingAsSkipped('permission denied');
            }
            if (event.content && !finalContent) {
              if (event.stats?.finishReason === 'budget_exceeded') {
                assistantStream.replaceMessage(event.content);
              } else {
                assistantStream.ensureMessage(event.content);
              }
              sessionMessagesToRecord.push({
                role: 'assistant',
                content: event.content,
                timestamp: Date.now(),
              });
            }
            finalContent = event.content;
            finalUsage = event.usage;
            finalModel = event.model;
            pendingCompact = event.compact;
            if (event.stats) {
              pendingCompleteStats = event.stats;
              recordProviderTraceEvents(this.events, sessionId, turnId, event.stats);
              pendingCompleteTrace = {
                turnId,
                type: 'complete',
                model: event.model,
                contentBytes: byteLength(event.content || ''),
                finishReason: event.stats.finishReason,
                llmRequests: event.stats.llmRequests,
                toolCalls: event.stats.toolCalls,
                readOnlyToolCalls: event.stats.readOnlyToolCalls,
                unsafeToolCalls: event.stats.unsafeToolCalls,
                loopBudgetSource: event.stats.loopBudgetSource,
                loopBudgetBaseProfile: event.stats.loopBudgetBaseProfile,
                loopBudgetMaxLlmRequests: event.stats.loopBudgetMaxLlmRequests,
                loopBudgetMaxToolCalls: event.stats.loopBudgetMaxToolCalls,
                loopBudgetMaxReadOnlyFragmentation: event.stats.loopBudgetMaxReadOnlyFragmentation,
                loopBudgetMaxModelVisibleBytes: event.stats.loopBudgetMaxModelVisibleBytes,
                loopBudgetConfigOverride: event.stats.loopBudgetConfigOverride,
                budgetExceededReason: event.stats.budgetExceededReason,
                continuationActions: event.stats.continuationActions,
                continuationHint: event.stats.continuationHint,
                localFastPathUsed: event.stats.localFastPathUsed,
              };
            } else {
              pendingCompleteTrace = {
                turnId,
                type: 'complete',
                model: event.model,
                contentBytes: byteLength(event.content || ''),
              };
            }
            break;
        }
      }

      const wasAborted = abortSignal?.aborted === true;
      if (wasAborted) {
        assistantStream.discardSegment();
        this.events.setStatus('Interrupted.');
        removeTrailingUserMessage(this.runtime);
        if (sessionId) {
          const { delta } = appendPostWorkspaceTrace(
            this.events,
            sessionId,
            turnId,
            this.runtime.cwd,
            preWorkspace,
            verificationResults
          );
          recordTraceEvent(this.events, sessionId, {
            turnId,
            type: 'aborted',
            note: 'aborted_after_query',
          });
          const recoveryNotice = workspaceDeltaHasTurnChanges(delta)
            ? formatFailureRecoveryNotice(turnId, delta, checkpointIds)
            : undefined;
          if (recoveryNotice) {
            this.events.append({
              role: 'status',
              title: 'recovery',
              statusTone: 'warning',
              content: recoveryNotice,
            });
          }
          removeLastIncompleteAssistantMessage(sessionId);
        }
        // Persist any accumulated session messages before returning,
        // so tool results from the interrupted turn are not lost.
        if (sessionId && sessionMessagesToRecord.length > 0) {
          appendSessionMessages(sessionId, sessionMessagesToRecord);
        }
        return;
      }

      assistantStream.closeSegment();

      if (sessionId) {
        const { profile, summary } = appendPostWorkspaceTrace(
          this.events,
          sessionId,
          turnId,
          this.runtime.cwd,
          preWorkspace,
          verificationResults
        );
        if (profile.changedFiles.length > 0 && profile.required) {
          this.events.setStatus(verifyingStatus(profile.profile));
          this.controllerOptions.onVerificationStateChange?.('running');
        }
        if (shouldRecordVerificationLoopStats(profile, summary)) {
          const stats = pendingCompleteStats ?? this.runtime.store.getSnapshot().lastLoopStats;
          if (stats) {
            pendingCompleteStats = withVerificationLoopStats(stats, summary);
          }
        }
        if (shouldGateCompletion(summary)) {
          this.events.setStatus(
            verificationGateStatus(summary.skippedReason ?? 'verification checks not run')
          );
          this.controllerOptions.onVerificationStateChange?.('gated');
          const notice = formatVerificationGateNotice(summary);
          this.events.append({
            role: 'status',
            title: 'verification',
            statusTone: 'warning',
            content: notice,
          });
          finalContent = finalContent ? `${finalContent}\n\n${notice}` : notice;
          appendAssistantNotice(sessionMessagesToRecord, notice);
          if (pendingCompleteTrace) {
            pendingCompleteTrace.finishReason = 'completion_gate';
            pendingCompleteTrace.contentBytes = byteLength(finalContent);
            pendingCompleteTrace.note = 'verification_incomplete';
          }
          const stats = pendingCompleteStats ?? this.runtime.store.getSnapshot().lastLoopStats;
          if (stats) {
            pendingCompleteStats = {
              ...withVerificationLoopStats(stats, summary),
              finishReason: 'completion_gate',
            };
          }
        } else if (profile.changedFiles.length > 0 && profile.required) {
          this.controllerOptions.onVerificationStateChange?.('passed');
        }
      }

      if (pendingCompleteStats?.finishReason === 'budget_exceeded') {
        const stats = pendingCompleteStats;
        const lines: string[] = ['Loop budget reached — stopping this turn.'];
        if (stats.budgetExceededReason) {
          lines.push(`Reason: ${stats.budgetExceededReason}`);
        }
        const progressParts: string[] = [];
        if (typeof stats.loopBudgetMaxLlmRequests === 'number') {
          progressParts.push(
            `${stats.llmRequests ?? 0}/${stats.loopBudgetMaxLlmRequests} LLM requests`
          );
        }
        if (typeof stats.loopBudgetMaxToolCalls === 'number') {
          progressParts.push(`${stats.toolCalls ?? 0}/${stats.loopBudgetMaxToolCalls} tool calls`);
        }
        if (progressParts.length) {
          lines.push(`Progress: ${progressParts.join(', ')}`);
        }
        if (stats.continuationActions?.length) {
          lines.push(`Next: ${stats.continuationActions.join('; ')}`);
        } else if (stats.continuationHint) {
          lines.push(`Next: ${stats.continuationHint}`);
        }
        const notice = lines.join('\n');
        this.events.append({
          role: 'status',
          title: 'budget',
          statusTone: 'warning',
          content: notice,
        });
        finalContent = finalContent ? `${finalContent}\n\n${notice}` : notice;
        appendAssistantNotice(sessionMessagesToRecord, notice);
      }

      if (pendingCompleteStats) {
        this.setLoopStats(this.foldSubagentUsage(pendingCompleteStats, subagentBundle));
      }

      if (finalContent) {
        this.runtime.store.addMessage({ role: 'assistant', content: finalContent });
      }

      if (sessionId && sessionMessagesToRecord.length > 0) {
        appendSessionMessages(sessionId, sessionMessagesToRecord);
      }

      if (pendingCompact) {
        try {
          let committedCheckpointId: string | undefined;
          if (sessionId) {
            const sourceMessageCount = readSessionMessages(sessionId).length;
            const checkpoint = commitSessionCompactCheckpoint({
              sessionId,
              mode: pendingCompact.mode,
              modelId: finalModel || this.runtime.llm.getModel(),
              sourceMessageCount,
              transcriptStartMessageIndex: Math.max(0, sourceMessageCount - 20),
              modelHistory: pendingCompact.modelHistory,
              summary: pendingCompact.summary,
              beforeUsage: pendingCompact.before,
              afterUsage: pendingCompact.after,
            });
            committedCheckpointId = checkpoint.checkpointId;
            this.runtime.store.setState({ conversationHistory: checkpoint.modelHistory });
          } else {
            this.runtime.store.setState({
              conversationHistory: pendingCompact.modelHistory.filter(
                message => message.role !== 'system'
              ),
            });
          }
          this.runtime.store.setContextUsage(pendingCompact.after);
          if (sessionId) {
            recordTraceEvent(this.events, sessionId, {
              turnId,
              type: 'compact_completed',
              checkpointId: committedCheckpointId,
              model: finalModel || this.runtime.llm.getModel(),
              note: pendingCompact.mode,
            });
          }
          this.events.append({
            role: 'status',
            title: 'auto-compact',
            statusTone: 'neutral',
            content: `Context reached ${pendingCompact.before.percent}% of the safe input budget. Agent core committed a ${pendingCompact.mode} compact checkpoint; current context is ${pendingCompact.after.percent}%.`,
          });
        } catch (error) {
          if (sessionId) {
            recordTraceEvent(this.events, sessionId, {
              turnId,
              type: 'compact_failed',
              model: finalModel || this.runtime.llm.getModel(),
              error: compactTraceError(error),
              note: pendingCompact.mode,
            });
          }
          this.events.append({
            role: 'error',
            title: 'compact-failed',
            content: `Compact checkpoint failed; the previous model context remains active. ${error instanceof Error ? error.message : String(error)}`,
            errorLayer: 'runtime',
          });
        }
      }

      if (finalUsage) {
        // Fold subagent token usage into /cost accounting.
        if (subagentBundle) {
          const subUsage = subagentBundle.getAggregateUsage();
          finalUsage = {
            promptTokens: finalUsage.promptTokens + subUsage.promptTokens,
            completionTokens: finalUsage.completionTokens + subUsage.completionTokens,
          };
        }
        this.runtime.store.setTokenUsage(finalUsage);
      }

      harness.ingestTurn({
        userInput: input,
        assistantContent: finalContent,
        sessionMessages: sessionMessagesToRecord,
        intent,
      });
      const harnessState = harness.toJSON();
      this.runtime.store.setState({ harnessState });
      emitHarnessDiagnostics(this.events, harnessState);
      if (sessionId) {
        if (pendingCompleteTrace) {
          recordTraceEvent(this.events, sessionId, pendingCompleteTrace);
        }
        updateSessionSkills(sessionId, appliedSkillNames);
        updateSessionHarnessState(sessionId, harnessState);
        const recordedMessages = readSessionMessages(sessionId);
        if (recordedMessages.length > 0) {
          updateSessionSummary(sessionId, recordedMessages);
        }
      }
      this.events.setStatus(finalModel ? `Completed with ${finalModel}` : 'Completed');
    } catch (error: unknown) {
      // v0.2.25: Provider retry exhausted is a recoverable turn failure.
      if (error instanceof Error && error.name === 'ProviderRetryExhaustedError') {
        const diag = (error as any).diagnostics;
        const attempts = diag?.attempts?.length ?? '?';
        const kind = diag?.attempts?.[diag.attempts.length - 1]?.failureKind ?? 'unknown';
        this.events.setStatus(
          `Provider unavailable (${kind}, ${attempts} attempts). Retry exhausted — ready for next input.`
        );
        this.events.append({
          role: 'error',
          title: 'provider',
          content: `Provider retry exhausted after ${attempts} attempts (${kind}). The turn was not completed. You can try again or wait for the provider to recover.`,
          errorLayer: 'provider',
        });

        // v0.2.25: If a goal is active, pause it on provider retry exhaustion
        // so it doesn't auto-continue and burn retries.
        try {
          const gc = this.goalCoordinator;
          if (gc?.goal?.status === 'active') {
            gc.deferContinuation();
          }
        } catch { /* best effort */ }

        return;
      }
      if (isAbortError(error, abortSignal)) {
        assistantStream.discardSegment();
        this.events.setStatus('Interrupted.');
        removeTrailingUserMessage(this.runtime);
        if (sessionId) {
          const { delta } = appendPostWorkspaceTrace(
            this.events,
            sessionId,
            turnId,
            this.runtime.cwd,
            preWorkspace,
            verificationResults
          );
          recordTraceEvent(this.events, sessionId, {
            turnId,
            type: 'aborted',
            note: 'abort_error',
          });
          const recoveryNotice = workspaceDeltaHasTurnChanges(delta)
            ? formatFailureRecoveryNotice(turnId, delta, checkpointIds)
            : undefined;
          if (recoveryNotice) {
            this.events.append({
              role: 'status',
              title: 'recovery',
              statusTone: 'warning',
              content: recoveryNotice,
            });
          }
          removeLastIncompleteAssistantMessage(sessionId);
        }
        return;
      }

      assistantStream.discardSegment();
      this.events.append({
        role: 'error',
        content: formatChatError(error),
        errorLayer: errorLayerForChatError(error),
      });
      this.events.setStatus('Turn failed. Ready for the next input.');
      const failedStats =
        error instanceof QueryLoopError
          ? error.stats
          : createFailedLoopStats({
              loopBudget,
              diagnostics:
                observedLlmRequests > 0 ? getLastRequestDiagnostics(this.runtime.llm) : undefined,
              turnsStarted: observedTurnsStarted,
              llmRequests: observedLlmRequests,
              toolCalls: observedToolCalls,
              readOnlyToolCalls: observedReadOnlyToolCalls,
              unsafeToolCalls: observedUnsafeToolCalls,
              toolResultBytes: observedToolResultBytes,
              modelVisibleToolBytes: observedModelVisibleToolBytes,
            });
      this.setLoopStats(failedStats);
      if (sessionId) {
        recordProviderTraceEvents(this.events, sessionId, turnId, failedStats);
        const { delta } = appendPostWorkspaceTrace(
          this.events,
          sessionId,
          turnId,
          this.runtime.cwd,
          preWorkspace,
          verificationResults
        );
        const recoveryNotice = workspaceDeltaHasTurnChanges(delta)
          ? formatFailureRecoveryNotice(turnId, delta, checkpointIds)
          : undefined;
        if (recoveryNotice) {
          this.events.append({
            role: 'status',
            title: 'recovery',
            statusTone: 'warning',
            content: recoveryNotice,
          });
        }
        recordTraceEvent(this.events, sessionId, {
          turnId,
          type: 'error',
          error: compactTraceError(error),
          note: recoveryNotice,
        });
        recordTraceEvent(this.events, sessionId, {
          turnId,
          type: 'complete',
          model: failedStats.providerFinalModel ?? this.runtime.llm.getModel(),
          contentBytes: 0,
          finishReason: failedStats.finishReason,
          llmRequests: failedStats.llmRequests,
          toolCalls: failedStats.toolCalls,
          readOnlyToolCalls: failedStats.readOnlyToolCalls,
          unsafeToolCalls: failedStats.unsafeToolCalls,
          loopBudgetSource: failedStats.loopBudgetSource,
          loopBudgetBaseProfile: failedStats.loopBudgetBaseProfile,
          loopBudgetMaxLlmRequests: failedStats.loopBudgetMaxLlmRequests,
          loopBudgetMaxToolCalls: failedStats.loopBudgetMaxToolCalls,
          loopBudgetMaxReadOnlyFragmentation: failedStats.loopBudgetMaxReadOnlyFragmentation,
          loopBudgetMaxModelVisibleBytes: failedStats.loopBudgetMaxModelVisibleBytes,
          loopBudgetConfigOverride: failedStats.loopBudgetConfigOverride,
          localFastPathUsed: failedStats.localFastPathUsed,
        });
        removeLastIncompleteAssistantMessage(sessionId);
      }
      const history = this.runtime.store.getSnapshot().conversationHistory;
      if (history.length > 0) {
        this.runtime.store.setState({ conversationHistory: history.slice(0, -1) });
      }
    }
  }
}

/** @deprecated Use AgentChatController. Chat execution is renderer-independent. */
export { AgentChatController as InkChatController };

export function loadSessionIntoRuntime(runtime: OpenHorseUiRuntime, sessionId: string): string {
  const history = loadSessionHistory(sessionId);
  runtime.store.setState({ conversationHistory: history });
  runtime.store.setState({
    harnessState: loadSessionHarnessState(sessionId) ?? loadSessionMeta(sessionId)?.harnessState,
  });
  return `Restored ${history.length} messages`;
}

export function closeSession(runtime: OpenHorseUiRuntime): void {
  const session = runtime.getSession();
  if (!session) return;
  const messages = readSessionMessages(session.id);
  if (messages.length > 0) {
    updateSessionSummary(session.id, messages);
  }
  endSession(session.id);
}
