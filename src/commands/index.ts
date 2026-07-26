/**
 * orion code - Command Registry
 *
 * 注册所有 slash 命令，提供查找和列表功能。
 */

import chalk from 'chalk';
import {
  PERMISSION_MODES,
  getModeDisplayText,
  getNextPermissionMode,
  type SlashCommand,
  type CommandCategory,
  type CommandContext,
  type CommandResult,
  type PermissionMode,
} from './types';
import {
  createModelPickerState,
  createStatusSnapshot,
} from '../runtime/ui-view-model';
import type { Task } from '../core/agent';
import { TaskManager, CreateTaskOptions } from '../services/task-manager';
import { AgentRunner } from '../services/agent-runner';
import { isBetaUIRenderer, isConfigured } from '../services/config';
import { createSpinner, toolLine } from '../ui/box';
import { createStreamRenderer, type StreamMarkdownRenderer } from '../ui/stream-markdown';
import { hideProgress, showToolProgress } from '../ui/progress';
import { formatBytes } from '../services/format';
import { query, getSystemPrompt, resetToolState, getToolState, type LoopStats, type PromptContext } from '../framework';
import { executeTool, getRuntimeTools } from '../tools';
import { mcpManager } from '../tools/mcp';
import type { Message, StreamCallbacks } from '../services/llm';
import {
  listSessions,
  listProjectSessions,
  lookupSessionRef,
  loadSessionHistory,
  loadSessionMeta,
  loadSessionCompactCheckpoint,
  loadSessionTranscriptMessages,
  commitSessionCompactCheckpoint,
  appendSessionMessage,
  appendSessionMessages,
  endSession,
  updateSessionSummary,
  updateSessionHarnessState,
  loadSessionHarnessState,
  updateSessionSkills,
  resumeSession,
  renameSession,
  resolveProjectPath,
  readSessionMessages,
  readSessionTraceEvents,
  redactTraceText,
  type SessionMeta,
  type SessionMessage,
  type SessionTraceEvent,
} from '../services/session-storage';
import { loadSessionIndex, searchSessions } from '../services/session-index';
import { GoalCoordinator } from '../runtime/goals/coordinator';
import { getAutoCompact } from '../services/compact/auto-compact';
import { CompactCoordinator } from '../services/compact/coordinator';
import { createContextHarness } from '../harness';
import {
  getSkillsRegistry,
  loadExplicitSkillReference,
  normalizeRequestedSkillName,
  parseSkillCommandInput,
  resolveSkillsForTurn,
  skillActivationNames,
} from '../skills';
import { buildReferencedFilesPrompt } from '../services/file-context';
import { loadProjectInstructionFiles } from '../services/project-instructions';
import { refreshProjectInstructions } from '../services/prompt-context';
import { collectDoctorReport, formatDoctorReport, hasDoctorFailures } from '../services/doctor';
import {
  createContextUsageSnapshot,
  resolveModelContext,
} from '../services/model-context';
import { estimateMessagesTokens } from '../utils/token-estimate';
import {
  getModelCatalogAliases,
  getModelCatalogEntry,
  listModelCatalogEntries,
  resolveModelAlias,
} from '../services/model-catalog';
import { collectWorkspaceDiff, formatWorkspaceDiff } from '../services/workspace-diff';
import { createCommitPlan, formatCommitPlan } from '../services/commit-plan';
import { findArtifact, listArtifacts, retrieveArtifact } from '../core/tool-artifacts';
import { listCheckpoints, restoreCheckpoint } from '../core/checkpoint';
import {
  cleanupStorage,
  collectStorageReport,
  formatStorageCleanupResult,
  formatStorageReport,
  repairProjectMetadata,
} from '../services/storage-maintenance';
import { agentStepStatus, compactStatus, runningToolsStatus } from '../runtime/agent-status';
import { resolveRuntimeLoopBudget } from '../runtime/loop-budget';
import { loadUsageState, summarizeUsageLedger } from '../services/usage-state';
import { handleMigrateCommand } from '../migration/command';

// ============================================================================
// 颜色常量
// ============================================================================

const BRAND = chalk.hex('#FF6B35');
const ACCENT = chalk.hex('#00D4AA');
const DIM = chalk.dim;
const ERROR = chalk.red;
const WARN = chalk.yellow;
const SUCCESS = chalk.green;
const HEADER = chalk.cyan.bold;

const CATEGORY_ORDER: CommandCategory[] = [
  'workflow',
  'session',
  'context',
  'tools',
  'model',
  'system',
  'diagnostics',
  'legacy',
];

function commandUICapabilities(ctx: CommandContext) {
  return createStatusSnapshot({
    renderer: ctx.uiRenderer ?? ctx.config.ui?.renderer ?? 'terminal',
    capabilities: ctx.uiCapabilities,
  }).renderer.capabilities;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

function formatThreshold(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatDurationMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function formatRendererStatus(ctx: CommandContext): string {
  const snapshot = createStatusSnapshot({
    renderer: ctx.uiRenderer ?? ctx.config.ui?.renderer ?? 'terminal',
    capabilities: ctx.uiCapabilities,
  });
  const status = snapshot.renderer.status === 'deprecated'
    ? WARN('deprecated')
    : snapshot.renderer.status === 'beta' || isBetaUIRenderer(snapshot.renderer.name)
      ? WARN('beta')
      : snapshot.renderer.status === 'stable'
        ? SUCCESS('stable')
        : snapshot.renderer.status === 'non-interactive'
          ? DIM('non-interactive')
        : DIM('custom');

  return `${BRAND(snapshot.renderer.name)} ${status} ${DIM(snapshot.renderer.capabilityLabels.join(', '))}`;
}

function formatModelAliasHelp(): string {
  return Object.keys(getModelCatalogAliases()).sort().join(', ');
}

function formatLoopBudgetSource(stats: LoopStats): string {
  const source = stats.loopBudgetSource ?? 'unknown';
  if (source === 'config' && stats.loopBudgetBaseProfile) {
    return `config over ${stats.loopBudgetBaseProfile}`;
  }
  return source;
}

function formatLoopStatsLines(stats: LoopStats, detail = false): string[] {
  const lines = [
    `Finish     ${stats.finishReason}`,
    `Requests   ${stats.llmRequests} LLM / ${stats.turnsStarted} turns`,
    `Tools      ${stats.toolCalls} total (${stats.readOnlyToolCalls} read-only, ${stats.unsafeToolCalls} unsafe)`,
    `Tool bytes ${formatBytes(stats.modelVisibleToolBytes)} model-visible / ${formatBytes(stats.toolResultBytes)} total`,
  ];

  if (stats.summarizedBytes > 0) {
    lines.push(`Saved      ${formatBytes(stats.summarizedBytes)} from model context`);
  }
  if (stats.compactTrigger) {
    lines.push(`Compact    ${stats.compactTrigger}`);
  }
  if (stats.localFastPathUsed) {
    lines.push('Fast path  yes');
  }
  if (stats.budgetExceededReason) {
    lines.push(`Budget     ${stats.budgetExceededReason}`);
  }
  if (stats.continuationActions && stats.continuationActions.length > 0) {
    lines.push(`Next       ${stats.continuationActions.join(', ')}`);
  }
  if ((stats.providerRetryCount ?? 0) > 0) {
    const retryParts = [
      `${stats.providerRetryCount} retries`,
      `delay ${formatDurationMs(stats.providerRetryDelayMs ?? 0)}`,
      stats.providerLastRetryErrorType
        ? `last ${stats.providerLastRetryErrorType}${stats.providerLastRetryStatus ? `/${stats.providerLastRetryStatus}` : ''}`
        : undefined,
    ].filter(Boolean);
    lines.push(`Provider   ${retryParts.join(', ')}`);
  }
  if ((stats.providerFallbackCount ?? 0) > 0 || stats.providerUsingFallback) {
    const fallbackPath = stats.providerFallbackFromModel && stats.providerFallbackToModel
      ? `${stats.providerFallbackFromModel} -> ${stats.providerFallbackToModel}`
      : stats.providerFinalModel
        ? `final ${stats.providerFinalModel}`
        : 'active';
    lines.push(`Fallback   ${fallbackPath}`);
  }
  if (typeof stats.verificationClaimAllowed === 'boolean') {
    const verificationParts = [
      stats.verificationProfile ?? 'unknown',
      `required=${stats.verificationRequired ? 'yes' : 'no'}`,
      `passed=${stats.verificationPassedCommands?.length ?? 0}`,
      `failed=${stats.verificationFailedCommands?.length ?? 0}`,
      `missing=${stats.verificationMissingCommands?.length ?? 0}`,
      `claim=${stats.verificationClaimAllowed ? 'yes' : 'no'}`,
    ];
    lines.push(`Verify     ${verificationParts.join(' ')}`);
  }
  if (
    typeof stats.loopBudgetMaxLlmRequests === 'number'
    || typeof stats.loopBudgetMaxToolCalls === 'number'
    || typeof stats.loopBudgetMaxModelVisibleBytes === 'number'
  ) {
    const caps = [
      typeof stats.loopBudgetMaxLlmRequests === 'number'
        ? `${stats.llmRequests}/${stats.loopBudgetMaxLlmRequests} LLM`
        : undefined,
      typeof stats.loopBudgetMaxToolCalls === 'number'
        ? `${stats.toolCalls}/${stats.loopBudgetMaxToolCalls} tools`
        : undefined,
      typeof stats.loopBudgetMaxModelVisibleBytes === 'number'
        ? `${formatBytes(stats.modelVisibleToolBytes)}/${formatBytes(stats.loopBudgetMaxModelVisibleBytes)} visible`
        : undefined,
      typeof stats.loopBudgetMaxReadOnlyFragmentation === 'number'
        ? `fragment ${stats.singleReadOnlyStreak}/${stats.loopBudgetMaxReadOnlyFragmentation}`
        : undefined,
    ].filter(Boolean);
    lines.push(`Budget cap ${caps.join(', ')} (${formatLoopBudgetSource(stats)})`);
  }
  if (stats.singleReadOnlyStreak > 0 || stats.batchReadSuggestionCount > 0) {
    lines.push(`Read-only  streak ${stats.singleReadOnlyStreak}, batch_read hints ${stats.batchReadSuggestionCount}`);
  }

  if (detail) {
    lines.push(`Unsafe     ${stats.unsafeToolCalls}`);
    if (stats.providerRetryErrorTypes && stats.providerRetryErrorTypes.length > 0) {
      lines.push(`Retry type ${stats.providerRetryErrorTypes.join(', ')}`);
    }
    if (stats.verificationFailedCommands && stats.verificationFailedCommands.length > 0) {
      lines.push(`Failed     ${stats.verificationFailedCommands.join(' && ')}`);
    }
    if (stats.verificationMissingCommands && stats.verificationMissingCommands.length > 0) {
      lines.push(`Missing    ${stats.verificationMissingCommands.join(' && ')}`);
    }
    if (stats.verificationSkippedReason) {
      lines.push(`Verify why ${stats.verificationSkippedReason}`);
    }
    if (stats.continuationHint) {
      lines.push(`Next why   ${stats.continuationHint}`);
    }
    lines.push(`Budget hit ${stats.finishReason === 'budget_exceeded' ? 'yes' : 'no'}`);
  }

  return lines;
}

const CATEGORY_LABELS: Record<CommandCategory, string> = {
  workflow: 'Workflow',
  session: 'Session',
  context: 'Context',
  tools: 'Tools',
  model: 'Model',
  system: 'System',
  diagnostics: 'Diagnostics',
  legacy: 'Legacy',
};

function commandCategory(command: SlashCommand): CommandCategory {
  return command.category ?? 'system';
}

export function getCommandCategoryLabel(category: CommandCategory | undefined): string {
  return CATEGORY_LABELS[category ?? 'system'];
}

export function sortCommands(commands: SlashCommand[]): SlashCommand[] {
  return [...commands].sort((a, b) => {
    const categoryDelta = CATEGORY_ORDER.indexOf(commandCategory(a)) - CATEGORY_ORDER.indexOf(commandCategory(b));
    if (categoryDelta !== 0) return categoryDelta;
    const priorityDelta = (a.priority ?? 100) - (b.priority ?? 100);
    if (priorityDelta !== 0) return priorityDelta;
    return a.name.localeCompare(b.name);
  });
}

function isAbortError(error: unknown, abortSignal?: AbortSignal): boolean {
  if (abortSignal?.aborted) return true;
  if (error instanceof Error) {
    return error.name === 'AbortError' || error.message.toLowerCase().includes('aborted');
  }
  return false;
}

// ============================================================================
// 工具参数摘要
// ============================================================================


// ============================================================================
// 命令实现
// ============================================================================

let taskManager: TaskManager | null = null;

function showHelp(): CommandResult {
  console.log();
  console.log(HEADER('Commands:'));
  console.log();

  const visible = getVisibleCommands();
  for (const category of CATEGORY_ORDER) {
    const items = visible.filter(cmd => commandCategory(cmd) === category);
    if (items.length === 0) continue;

    console.log(DIM(getCommandCategoryLabel(category)));
    for (const cmd of items) {
      const aliases = cmd.aliases ? ` (${cmd.aliases.join(', ')})` : '';
      const params = cmd.argumentHint || cmd.params?.map(p => `<${p.name}>`).join(' ') || '';
      console.log(`  ${ACCENT(`/${cmd.name}`)}${aliases} ${DIM(params)}`);
      console.log(`    ${DIM(cmd.description)}`);
    }
    console.log();
  }

  console.log(DIM('Type any text without / prefix to chat with the LLM.'));
  console.log();
  return { success: true };
}

function showStatus(ctx: CommandContext): CommandResult {
  console.log();
  console.log(HEADER('System Status'));
  console.log(DIM('─'.repeat(40)));

  const brainStatus = ctx.runtime.brain.getStatus();
  const memStatus = ctx.runtime.memory.getStatus();
  const storeStats = ctx.runtime.store.getStats();

  console.log(`  Mode       ${BRAND(ctx.config.mode)}`);
  console.log(`  Log level  ${DIM(ctx.config.logLevel)}`);
  const modelId = ctx.llm?.getModel() ?? snapshotCurrentModel(ctx);
  const modelContext = resolveModelContext(modelId);
  const compactStats = getCommandAutoCompact(ctx, modelId).getStats();
  console.log(`  Model      ${BRAND(modelId)}`);
  console.log(`  Context    ${DIM(`${formatTokenCount(modelContext.contextWindow)} tokens (${modelContext.source}${modelContext.source === 'fuzzy' ? `:${modelContext.matchedId}` : ''})`)}`);
  console.log(`  Compact    ${compactStats.enabled ? SUCCESS('auto') : WARN('off')} ${DIM(`predict ${formatThreshold(compactStats.predictiveCompactThreshold)}, hard ${formatThreshold(compactStats.threshold)}, used ${compactStats.ctxPercent}%`)}`);
  console.log(`  Renderer   ${formatRendererStatus(ctx)}`);
  console.log();
  console.log(`  Agents     ${SUCCESS(brainStatus.agents.length)} registered`);
  console.log(`  Tasks      ${brainStatus.pendingTasks} pending (${brainStatus.strategy} strategy)`);
  console.log();
  console.log(`  Memory (inline):`);
  console.log(`    Working    ${memStatus.working} entries`);
  console.log(`    Short-term ${memStatus['short-term']} entries`);
  console.log(`    Long-term  ${memStatus['long-term']} entries`);
  console.log();
  console.log(`  Memory (store):`);
  console.log(`    Working    ${storeStats.working} entries`);
  console.log(`    Short-term ${storeStats['short-term']} entries`);
  console.log(`    Long-term  ${storeStats['long-term']} entries`);

  refreshProjectInstructions(ctx.store, ctx.cwd);
  const snapshot = ctx.store.getSnapshot();
  const instructionFiles = loadProjectInstructionFiles(ctx.cwd);
  console.log();
  console.log(`  Context:`);
  console.log(`    Project rules ${instructionFiles.length > 0 ? SUCCESS(`${instructionFiles.length} files`) : DIM('none')}`);
  for (const file of instructionFiles.slice(0, 8)) {
    console.log(`      ${DIM(file.path)}${file.truncated ? ` ${WARN('(truncated)')}` : ''}`);
  }
  if (instructionFiles.length > 8) {
    console.log(`      ${DIM(`... ${instructionFiles.length - 8} more`)}`);
  }
  console.log(`    Prompt rules  ${snapshot.projectInstructionsContent ? SUCCESS(`${snapshot.projectInstructionsContent.length} chars`) : DIM('none')}`);
  console.log(`    Project memory ${snapshot.memoryContent ? SUCCESS(`${snapshot.memoryContent.length} chars`) : DIM('none')}`);
  console.log(`    Skills index   ${snapshot.skillsContent ? SUCCESS(`${snapshot.skillsContent.length} chars`) : DIM('none')}`);

  if (snapshot.lastLoopStats) {
    const stats = snapshot.lastLoopStats;
    console.log();
    console.log(`  Last loop:`);
    for (const line of formatLoopStatsLines(stats)) {
      console.log(`    ${line}`);
    }
  }

  const harnessState = snapshot.harnessState;
  if (harnessState?.contract || harnessState?.capsule) {
    console.log();
    console.log(`  Harness:`);
    if (harnessState.contract) {
      console.log(`    Objective  ${ACCENT(harnessState.contract.objective)}`);
    }
    console.log(`    Ledger     ${DIM(`${harnessState.ledger.length} entries`)}`);
    if (harnessState.capsule) {
      console.log(`    Next       ${DIM(harnessState.capsule.nextAction)}`);
      const passed = harnessState.capsule.verification.passed.length;
      const failed = harnessState.capsule.verification.failed.length;
      console.log(`    Verify     ${SUCCESS(`${passed} passed`)} / ${failed > 0 ? ERROR(`${failed} failed`) : DIM('0 failed')}`);
    }
  }
  console.log();
  return { success: true };
}

function handleLoopStats(ctx: CommandContext): CommandResult {
  const stats = ctx.store.getSnapshot().lastLoopStats;
  if (!stats) {
    console.log('No agent-loop stats recorded yet.');
    return { success: true };
  }

  console.log(HEADER('Agent Loop Stats'));
  console.log();
  for (const line of formatLoopStatsLines(stats, true)) {
    console.log(`  ${line}`);
  }
  console.log();
  console.log(DIM('Use this to spot excessive LLM requests, fragmented read-only tool calls, and local fast-path hits.'));
  return { success: true };
}

function formatTraceEventLine(event: SessionTraceEvent): string {
  const time = new Date(event.timestamp).toLocaleTimeString();
  const prefix = `${DIM(time)} ${ACCENT(event.type)}`;

  switch (event.type) {
    case 'turn_start':
      return `${prefix} input=${formatBytes(event.inputBytes ?? 0)}${event.localFastPathUsed ? ' fast-path' : ''}${event.note ? ` ${DIM(event.note)}` : ''}`;
    case 'request_start':
      return `${prefix} model=${event.model ?? 'unknown'} iteration=${event.turn ?? '?'}`;
    case 'provider_retry': {
      const parts = [
        `count=${event.providerRetryCount ?? 0}`,
        `delay=${formatDurationMs(event.providerRetryDelayMs ?? 0)}`,
        event.providerLastRetryErrorType
          ? `last=${event.providerLastRetryErrorType}${event.providerLastRetryStatus ? `/${event.providerLastRetryStatus}` : ''}`
          : '',
        event.providerRetryErrorTypes?.length ? `types=${event.providerRetryErrorTypes.join(',')}` : '',
        event.providerFinalModel ? `final=${event.providerFinalModel}` : '',
      ].filter(Boolean);
      return `${prefix} ${parts.join(' ')}`;
    }
    case 'provider_fallback': {
      const path = event.providerFallbackFromModel && event.providerFallbackToModel
        ? `${event.providerFallbackFromModel}->${event.providerFallbackToModel}`
        : event.providerFinalModel ?? 'active';
      const parts = [
        `count=${event.providerFallbackCount ?? 0}`,
        `path=${path}`,
        `using=${event.providerUsingFallback ? 'yes' : 'no'}`,
      ];
      return `${prefix} ${parts.join(' ')}`;
    }
    case 'prompt_assembly': {
      const parts = [
        `model=${event.promptModelId ?? 'unknown'}`,
        `tokens=${event.promptEstimatedTokens ?? 0}/${event.promptBudgetTokens ?? 0}`,
        `core=${event.promptCoreTokens ?? 0}`,
        `evidenceBudget=${event.promptEvidenceBudgetTokens ?? 0}`,
        `recentBudget=${event.promptRecentTurnBudgetTokens ?? 0}`,
        `included=${event.promptIncludedEvidenceCount ?? 0}`,
        `omitted=${event.promptOmittedEvidenceCount ?? 0}`,
      ];
      const sections = event.promptSections?.length
        ? ` sections=${event.promptSections.join(',')}`
        : '';
      const evidence = event.promptIncludedEvidence?.length
        ? ` evidence=${event.promptIncludedEvidence.slice(0, 6).join(', ')}${event.promptIncludedEvidence.length > 6 ? ', ...' : ''}`
        : '';
      return `${prefix} ${parts.join(' ')}${sections ? DIM(sections) : ''}${evidence ? ` ${DIM(evidence)}` : ''}`;
    }
    case 'assistant_tool_calls':
      return `${prefix} calls=${event.toolCallCount ?? 0} assistant=${formatBytes(event.contentBytes ?? 0)}`;
    case 'checkpoint': {
      const files = event.checkpointFiles?.length
        ? ` files=${event.checkpointFiles.slice(0, 6).join(', ')}${event.checkpointFiles.length > 6 ? ', ...' : ''}`
        : '';
      const targets = event.workspaceFiles?.length && !files
        ? ` targets=${event.workspaceFiles.slice(0, 6).join(', ')}${event.workspaceFiles.length > 6 ? ', ...' : ''}`
        : '';
      return `${prefix} id=${event.checkpointId ?? 'unknown'} saved=${event.checkpointFileCount ?? 0}${files}${targets}${event.note ? ` ${DIM(event.note)}` : ''}`;
    }
    case 'tool_call':
      return `${prefix} ${event.name ?? 'tool'}${event.argsSummary ? ` ${DIM(event.argsSummary)}` : ''}${event.argsArtifactId ? ` ${DIM(`args=/artifacts show ${event.argsArtifactId} --full${event.argsBytes ? ` (${formatBytes(event.argsBytes)})` : ''}`)}` : ''}${event.callId ? ` ${DIM(event.callId)}` : ''}`;
    case 'permission_decision': {
      const status = event.permissionApproved ? SUCCESS('approved') : ERROR('denied');
      const parts = [
        `source=${event.permissionSource ?? 'unknown'}`,
        `behavior=${event.permissionBehavior ?? 'unknown'}`,
      ];
      if (typeof event.permissionDuration === 'number') {
        parts.push(`${event.permissionDuration}ms`);
      }
      return `${prefix} ${status} ${event.name ?? 'tool'} ${DIM(parts.join(' '))}${event.permissionReason ? ` ${DIM(event.permissionReason)}` : ''}`;
    }
    case 'tool_result': {
      const status = event.success === false ? ERROR('error') : SUCCESS('ok');
      const bytes = [
        `output=${formatBytes(event.outputBytes ?? 0)}`,
        `model=${formatBytes(event.modelVisibleBytes ?? 0)}`,
      ];
      if (event.artifactId) bytes.push(`artifact=${event.artifactId}`);
      return `${prefix} ${status} ${event.name ?? 'tool'} ${DIM(`${event.duration ?? 0}ms`)} ${DIM(bytes.join(' '))}${event.error ? ` ${ERROR(event.error)}` : ''}`;
    }
    case 'message':
      return `${prefix} assistant=${formatBytes(event.contentBytes ?? 0)}`;
    case 'strategy_exhausted':
      return `${prefix}${event.note ? ` ${WARN(event.note)}` : ''}`;
    case 'complete': {
      const stats = [
        `finish=${event.finishReason ?? 'unknown'}`,
        `llm=${typeof event.llmRequests === 'number' ? event.llmRequests : 'unknown'}`,
        `tools=${typeof event.toolCalls === 'number' ? event.toolCalls : 'unknown'}`,
      ];
      if (
        event.loopBudgetSource
        || typeof event.loopBudgetMaxLlmRequests === 'number'
        || typeof event.loopBudgetMaxToolCalls === 'number'
        || typeof event.loopBudgetMaxModelVisibleBytes === 'number'
      ) {
        const source = event.loopBudgetSource === 'config' && event.loopBudgetBaseProfile
          ? `config/${event.loopBudgetBaseProfile}`
          : event.loopBudgetSource ?? 'unknown';
        const caps = [
          typeof event.loopBudgetMaxLlmRequests === 'number'
            ? `${typeof event.llmRequests === 'number' ? event.llmRequests : '?'}/${event.loopBudgetMaxLlmRequests}llm`
            : undefined,
          typeof event.loopBudgetMaxToolCalls === 'number'
            ? `${typeof event.toolCalls === 'number' ? event.toolCalls : '?'}/${event.loopBudgetMaxToolCalls}tools`
            : undefined,
          typeof event.loopBudgetMaxModelVisibleBytes === 'number'
            ? `${formatBytes(event.loopBudgetMaxModelVisibleBytes)}visible`
            : undefined,
          typeof event.loopBudgetMaxReadOnlyFragmentation === 'number'
            ? `frag=${event.loopBudgetMaxReadOnlyFragmentation}`
            : undefined,
          event.loopBudgetConfigOverride ? 'override=yes' : undefined,
        ].filter(Boolean);
        stats.push(`budgetProfile=${source}${caps.length ? `(${caps.join(',')})` : ''}`);
      }
      if (event.budgetExceededReason) stats.push(`budget=${event.budgetExceededReason}`);
      if (event.continuationActions?.length) stats.push(`next=${event.continuationActions.join(',')}`);
      if (event.continuationHint) stats.push(`hint=${event.continuationHint}`);
      if (event.localFastPathUsed) stats.push('fast-path=yes');
      return `${prefix} ${stats.join(' ')}`;
    }
    case 'local_fast_path':
      return `${prefix} ${event.name ?? 'tool'}${event.argsSummary ? ` ${DIM(event.argsSummary)}` : ''}${event.argsArtifactId ? ` ${DIM(`args=/artifacts show ${event.argsArtifactId} --full${event.argsBytes ? ` (${formatBytes(event.argsBytes)})` : ''}`)}` : ''}${event.note ? ` ${DIM(event.note)}` : ''}`;
    case 'workspace_snapshot': {
      const state = event.workspaceGitAvailable === false
        ? WARN('not-git')
        : event.workspaceDirty ? WARN('dirty') : SUCCESS('clean');
      const files = event.workspaceFiles?.length
        ? ` files=${event.workspaceFiles.slice(0, 6).join(', ')}${event.workspaceFiles.length > 6 ? ', ...' : ''}`
        : '';
      return `${prefix} ${event.workspacePhase ?? 'unknown'} ${state} count=${event.workspaceFileCount ?? 0}${event.workspaceBranch ? ` branch=${event.workspaceBranch}` : ''}${files}${event.error ? ` ${ERROR(event.error)}` : ''}`;
    }
    case 'workspace_delta': {
      const added = event.workspaceNewByTurn ?? [];
      const changed = event.workspaceChangedByTurn ?? [];
      const modifiedPreExisting = event.workspaceModifiedPreExistingByTurn ?? [];
      const resolved = event.workspaceResolvedByTurn ?? [];
      const parts = [
        `after=${event.workspaceFileCount ?? 0}`,
        `new=${added.length}`,
        `changed=${changed.length}`,
        `pre-existing-modified=${modifiedPreExisting.length}`,
        `resolved=${resolved.length}`,
      ];
      const details = [
        added.length ? `new: ${added.slice(0, 6).join(', ')}${added.length > 6 ? ', ...' : ''}` : '',
        changed.length ? `changed: ${changed.slice(0, 6).join(', ')}${changed.length > 6 ? ', ...' : ''}` : '',
        modifiedPreExisting.length ? `pre-existing modified: ${modifiedPreExisting.slice(0, 6).join(', ')}${modifiedPreExisting.length > 6 ? ', ...' : ''}` : '',
        resolved.length ? `resolved: ${resolved.slice(0, 6).join(', ')}${resolved.length > 6 ? ', ...' : ''}` : '',
      ].filter(Boolean).join(' | ');
      return `${prefix} ${parts.join(' ')}${details ? ` ${DIM(details)}` : ''}${event.note ? ` ${DIM(event.note)}` : ''}`;
    }
    case 'verification_profile': {
      const commands = event.verificationCommands ?? [];
      const files = event.verificationChangedFiles ?? [];
      const details = [
        `profile=${event.verificationProfile ?? 'unknown'}`,
        `required=${event.verificationRequired === false ? 'no' : 'yes'}`,
        `commands=${commands.length}`,
        `files=${files.length}`,
      ];
      if (event.verificationRisky) {
        details.push(`risk=${WARN('high')}(${files.length} files)`);
      }
      const commandPreview = commands.length
        ? ` cmds: ${commands.slice(0, 4).join(' && ')}${commands.length > 4 ? ' && ...' : ''}`
        : '';
      return `${prefix} ${details.join(' ')}${commandPreview ? ` ${DIM(commandPreview)}` : ''}${event.note ? ` ${DIM(event.note)}` : ''}`;
    }
    case 'verification_result': {
      const status = event.verificationPassed === true ? SUCCESS('passed') : ERROR('failed');
      const command = event.verificationCommand ?? 'unknown';
      return `${prefix} ${status} ${command}${typeof event.outputBytes === 'number' ? ` ${DIM(formatBytes(event.outputBytes))}` : ''}${event.error ? ` ${ERROR(event.error)}` : ''}`;
    }
    case 'verification_summary': {
      const passed = event.verificationPassedCommands?.length ?? 0;
      const failed = event.verificationFailedCommands?.length ?? 0;
      const missing = event.verificationMissingCommands?.length ?? 0;
      const parts = [
        `profile=${event.verificationProfile ?? 'unknown'}`,
        `required=${event.verificationRequired === false ? 'no' : 'yes'}`,
        `passed=${passed}`,
        `failed=${failed}`,
        `missing=${missing}`,
        `claimAllowed=${event.verificationClaimAllowed ? 'yes' : 'no'}`,
      ];
      const missingPreview = missing > 0
        ? ` missing: ${(event.verificationMissingCommands ?? []).slice(0, 4).join(' && ')}${missing > 4 ? ' && ...' : ''}`
        : '';
      return `${prefix} ${parts.join(' ')}${missingPreview ? ` ${DIM(missingPreview)}` : ''}${event.note ? ` ${DIM(event.note)}` : ''}`;
    }
    case 'aborted':
      return `${prefix}${event.note ? ` ${WARN(event.note)}` : ''}`;
    case 'error':
      return `${prefix} ${ERROR(event.error ?? 'unknown error')}`;
    default:
      return prefix;
  }
}

function handleTrace(ctx: CommandContext, args: string = ''): CommandResult {
  const session = ctx.getSession?.() ?? (ctx.sessionId ? loadSessionMeta(ctx.sessionId) : null);
  if (!session) {
    console.log(ERROR('No active session.'));
    console.log(DIM('Use /resume <session-id> first, or start a chat turn to create a session.'));
    return { success: false };
  }

  const events = readSessionTraceEvents(session.id);
  if (events.length === 0) {
    console.log(DIM(`No trace events recorded for session ${session.id.slice(0, 8)} yet.`));
    return { success: true };
  }

  const ref = args.trim();
  const requestedTurnId = ref && ref !== 'latest' ? ref : events[events.length - 1].turnId;
  const turnEvents = events.filter(event => event.turnId === requestedTurnId);

  if (turnEvents.length === 0) {
    const recentTurnIds = [...new Set(events.map(event => event.turnId))].slice(-8).reverse();
    console.log(ERROR(`Trace turn not found: ${requestedTurnId}`));
    console.log(DIM(`Recent turns: ${recentTurnIds.join(', ')}`));
    return { success: false };
  }

  console.log(HEADER(`Trace ${requestedTurnId}`));
  console.log(DIM(`Session ${session.id}  Events ${turnEvents.length}`));
  console.log(DIM('─'.repeat(40)));
  for (const event of turnEvents) {
    console.log(`  ${formatTraceEventLine(event)}`);
  }
  console.log();
  console.log(DIM('Trace stores metadata only; full transcript and tool output stay in session/artifacts.'));
  return { success: true };
}

function latestToolTrace(events: SessionTraceEvent[]): {
  call?: SessionTraceEvent;
  result?: SessionTraceEvent;
} | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.type !== 'tool_result' && event.type !== 'tool_call') continue;

    const callId = event.callId;
    const result = event.type === 'tool_result' ? event : undefined;
    const call = event.type === 'tool_call'
      ? event
      : callId
        ? events.slice(0, index).reverse().find(candidate =>
          candidate.type === 'tool_call' && candidate.callId === callId
        )
        : undefined;

    return { call, result };
  }
  return null;
}

/** Find tool trace by 1-based sequence number across all tool events. */
function toolTraceBySeq(events: SessionTraceEvent[], seq: number): {
  call?: SessionTraceEvent;
  result?: SessionTraceEvent;
} | null {
  let counter = 0;
  const toolEvents = new Map<string, { call?: SessionTraceEvent; result?: SessionTraceEvent }>();

  for (const event of events) {
    if (event.type !== 'tool_call' && event.type !== 'tool_result') continue;
    if (!event.callId) continue;
    const entry = toolEvents.get(event.callId) ?? {};
    if (event.type === 'tool_call') {
      counter++;
      entry.call = event;
    } else {
      if (!entry.call) counter++;
      entry.result = event;
    }
    toolEvents.set(event.callId, entry);
    if (counter === seq) {
      return toolEvents.get(event.callId) ?? null;
    }
  }
  return null;
}

/** Find tool trace by callId prefix. */
function toolTraceByCallId(events: SessionTraceEvent[], callIdPrefix: string): {
  call?: SessionTraceEvent;
  result?: SessionTraceEvent;
} | null {
  let call: SessionTraceEvent | undefined;
  let result: SessionTraceEvent | undefined;

  for (const event of events) {
    if (event.type !== 'tool_call' && event.type !== 'tool_result') continue;
    if (!event.callId?.startsWith(callIdPrefix)) continue;
    if (event.type === 'tool_call') call = event;
    else result = event;
  }

  if (!call && !result) return null;
  return { call, result };
}

/** Collect all tool trace pairs ordered by appearance (1-based sequence). */
function collectToolTracePairs(events: SessionTraceEvent[]): Array<{
  seq: number;
  call?: SessionTraceEvent;
  result?: SessionTraceEvent;
}> {
  const pairs: Array<{ seq: number; call?: SessionTraceEvent; result?: SessionTraceEvent }> = [];
  const seen = new Map<string, { seq: number; call?: SessionTraceEvent; result?: SessionTraceEvent }>();
  let counter = 0;

  for (const event of events) {
    if (event.type !== 'tool_call' && event.type !== 'tool_result') continue;
    if (!event.callId) continue;
    let entry = seen.get(event.callId);
    if (!entry) {
      counter++;
      entry = { seq: counter };
      seen.set(event.callId, entry);
      pairs.push(entry);
    }
    if (event.type === 'tool_call') entry.call = event;
    else entry.result = event;
  }

  return pairs;
}

function parseLastToolArgs(args: string = ''): { full: boolean; preview: boolean; ref?: string } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const ref = parts.length > 0 && !parts[0].startsWith('--') ? parts[0] : undefined;
  return {
    full: parts.includes('--full'),
    preview: !parts.includes('--no-preview'),
    ref,
  };
}

function printLastToolArtifactPreview(
  projectPath: string,
  label: string,
  artifactId: string | undefined,
  full: boolean,
): void {
  if (!artifactId) return;

  const artifact = findArtifact(projectPath, artifactId);
  if (!artifact) {
    console.log(`  ${label} preview ${DIM(`artifact not found or ambiguous: ${artifactId}`)}`);
    return;
  }

  const content = retrieveArtifact(artifact.path);
  if (content == null) {
    console.log(`  ${label} preview ${DIM(`artifact cannot be read: ${artifact.id}`)}`);
    return;
  }

  const redacted = redactTraceText(content);
  const maxPreviewBytes = 4 * 1024;
  const shouldTruncate = !full && Buffer.byteLength(redacted, 'utf8') > maxPreviewBytes;
  const preview = shouldTruncate
    ? Buffer.from(redacted, 'utf8').subarray(0, maxPreviewBytes).toString('utf8')
    : redacted;

  console.log(`  ${label} preview`);
  console.log(`  ${DIM('─'.repeat(40))}`);
  for (const line of preview.split('\n')) {
    console.log(`  ${line}`);
  }
  if (shouldTruncate) {
    console.log(`  ${DIM(`... preview truncated at ${formatBytes(maxPreviewBytes)}. Use /last-tool --full or /artifacts show ${artifact.id} --full.`)}`);
  }
}

function lastToolInputLabel(toolName: string): string {
  return toolName === 'exec_command' ? 'Command' : 'Args';
}

function lastToolField(label: string): string {
  return label.padEnd(13, ' ');
}

function handleLastTool(ctx: CommandContext, args: string = ''): CommandResult {
  const options = parseLastToolArgs(args);
  const session = ctx.getSession?.() ?? (ctx.sessionId ? loadSessionMeta(ctx.sessionId) : null);
  if (!session) {
    console.log(ERROR('No active session.'));
    console.log(DIM('Use /resume <session-id> first, or start a chat turn to create a session.'));
    return { success: false };
  }

  const events = readSessionTraceEvents(session.id);

  // Resolve reference: latest (default), #N, or callId prefix
  let trace: { call?: SessionTraceEvent; result?: SessionTraceEvent } | null = null;
  let listMode = false;

  if (!options.ref || options.ref === 'latest') {
    trace = latestToolTrace(events);
  } else if (/^#?\d+$/.test(options.ref)) {
    const seq = parseInt(options.ref.replace('#', ''), 10);
    trace = toolTraceBySeq(events, seq);
    if (!trace) {
      console.log(ERROR(`Tool #${seq} not found in session trace.`));
      // Fall back to listing available tools
      listMode = true;
    }
  } else {
    trace = toolTraceByCallId(events, options.ref);
    if (!trace) {
      console.log(ERROR(`Tool with callId prefix "${options.ref}" not found in session trace.`));
      listMode = true;
    }
  }

  if (listMode || !trace) {
    const pairs = collectToolTracePairs(events);
    if (pairs.length === 0) {
      console.log(DIM(`No tool trace events recorded for session ${session.id.slice(0, 8)} yet.`));
      return { success: true };
    }
    console.log(HEADER(`Tools (${pairs.length})`));
    console.log(DIM('─'.repeat(60)));
    for (const pair of pairs.slice(-30)) {
      const source = pair.result ?? pair.call;
      const name = source?.name ?? 'tool';
      const status = pair.result
        ? (pair.result.success === false ? '✗' : '✓')
        : '…';
      const duration = typeof pair.result?.duration === 'number'
        ? ` (${formatDurationMs(pair.result.duration)})`
        : '';
      const argsShort = (pair.call?.argsSummary ?? '').slice(0, 40);
      console.log(`  #${pair.seq} ${status} ${ACCENT(name)}${duration}  ${DIM(argsShort)}`);
    }
    console.log();
    console.log(DIM('Use /last-tool #N or /last-tool <callId> for details.'));
    return { success: true };
  }

  const call = trace.call;
  const result = trace.result;
  const source = result ?? call;
  const argsSource = call ?? result;
  const name = source?.name ?? 'tool';
  const inputLabel = lastToolInputLabel(name);
  const callId = source?.callId ?? call?.callId;
  const status = result ? (result.success === false ? ERROR('error') : SUCCESS('ok')) : WARN('running');

  // Resolve sequence number from the trace events
  let seqLabel = '';
  if (options.ref && /^#?\d+$/.test(options.ref)) {
    seqLabel = `#${parseInt(options.ref.replace('#', ''), 10)} `;
  } else if (result || call) {
    const allPairs = collectToolTracePairs(events);
    const matchingPair = allPairs.find(p => p.call?.callId === callId || p.result?.callId === callId);
    if (matchingPair) seqLabel = `#${matchingPair.seq} `;
  }

  console.log(HEADER(`Last Tool ${seqLabel}`.trimEnd()));
  console.log(DIM('─'.repeat(40)));
  console.log(`  Tool        ${ACCENT(name)}`);
  console.log(`  Turn        ${DIM(source?.turnId ?? 'unknown')}`);
  if (callId) console.log(`  Call        ${DIM(callId)}`);
  console.log(`  Status      ${status}`);
  if (typeof result?.duration === 'number') {
    console.log(`  Time        ${DIM(formatDurationMs(result.duration))}`);
  }

  if (argsSource?.argsSummary) {
    console.log(`  ${lastToolField(inputLabel)}${DIM(redactTraceText(argsSource.argsSummary))}`);
  }
  if (argsSource?.argsArtifactId) {
    const size = typeof argsSource.argsBytes === 'number' ? ` (${formatBytes(argsSource.argsBytes)})` : '';
    console.log(`  ${lastToolField(`${inputLabel} full`)}${DIM(`/artifacts show ${argsSource.argsArtifactId} --full${size}`)}`);
  }

  if (typeof result?.outputBytes === 'number') {
    const modelVisible = typeof result.modelVisibleBytes === 'number'
      ? `, model-visible ${formatBytes(result.modelVisibleBytes)}`
      : '';
    console.log(`  Output      ${DIM(`${formatBytes(result.outputBytes)}${modelVisible}`)}`);
  }
  if (result?.artifactId) {
    console.log(`  Output full ${DIM(`/artifacts show ${result.artifactId} --full`)}`);
  }
  if (result?.error) {
    console.log(`  Error       ${ERROR(redactTraceText(result.error))}`);
  }

  if (options.preview) {
    const projectPath = session.projectPath || ctx.cwd;
    printLastToolArtifactPreview(projectPath, inputLabel, argsSource?.argsArtifactId, options.full);
    printLastToolArtifactPreview(projectPath, 'Output', result?.artifactId, options.full);
  }

  console.log();
  console.log(DIM('Use /last-tool --full for redacted full previews, --no-preview for metadata only, or /trace latest for the ordered turn timeline.'));
  return { success: true };
}

function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function parseArtifactArgs(args: string): { action: 'list' | 'show'; ref?: string; full: boolean; limit: number } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  let full = false;
  let limit = 20;
  const positional: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === '--full') {
      full = true;
      continue;
    }
    if ((part === '--limit' || part === '-n') && parts[i + 1]) {
      const parsed = Number(parts[i + 1]);
      if (Number.isInteger(parsed) && parsed > 0) {
        limit = Math.min(parsed, 200);
      }
      i++;
      continue;
    }
    positional.push(part);
  }

  if (positional[0] === 'show' || positional[0] === 'cat') {
    return { action: 'show', ref: positional[1], full, limit };
  }
  if (positional[0]) {
    return { action: 'show', ref: positional[0], full, limit };
  }
  return { action: 'list', full, limit };
}

function printArtifactPreview(content: string, full: boolean): void {
  const maxPreviewBytes = 16 * 1024;
  if (full || Buffer.byteLength(content, 'utf8') <= maxPreviewBytes) {
    console.log(content);
    return;
  }

  const preview = Buffer.from(content, 'utf8').subarray(0, maxPreviewBytes).toString('utf8');
  console.log(preview);
  console.log();
  console.log(DIM(`... preview truncated at ${formatBytes(maxPreviewBytes)}. Use /artifacts show <id> --full for full output.`));
}

function formatArtifactPathForDisplay(artifactPath: string): string {
  return redactTraceText(artifactPath);
}

function handleArtifacts(ctx: CommandContext, args: string = ''): CommandResult {
  const parsed = parseArtifactArgs(args);

  if (parsed.action === 'list') {
    const artifacts = listArtifacts(ctx.cwd, parsed.limit);
    console.log(HEADER('Artifacts'));
    console.log(DIM('─'.repeat(40)));
    if (artifacts.length === 0) {
      console.log(DIM('No artifacts found for this project.'));
      return { success: true };
    }

    for (const artifact of artifacts) {
      console.log(`${ACCENT(artifact.id)} ${DIM(artifact.toolName)} ${formatBytes(artifact.outputBytes)}`);
      console.log(`  ${DIM(formatDateTime(artifact.modifiedAt))}`);
      console.log(`  ${DIM(formatArtifactPathForDisplay(artifact.path))}`);
    }
    console.log();
    console.log(DIM('Use /artifacts show <id|prefix> to preview, or add --full for full output.'));
    return { success: true };
  }

  if (!parsed.ref) {
    console.log(ERROR('Usage: /artifacts show <id|prefix> [--full]'));
    return { success: false };
  }

  const artifact = findArtifact(ctx.cwd, parsed.ref);
  if (!artifact) {
    console.log(ERROR(`Artifact not found or ambiguous: ${parsed.ref}`));
    console.log(DIM('Run /artifacts to list available artifact ids.'));
    return { success: false };
  }

  const content = retrieveArtifact(artifact.path);
  if (content == null) {
    console.log(ERROR(`Artifact exists but cannot be read: ${artifact.id}`));
    console.log(DIM(formatArtifactPathForDisplay(artifact.path)));
    return { success: false };
  }

  console.log(HEADER(`Artifact ${artifact.id}`));
  console.log(DIM(`Tool ${artifact.toolName}  Size ${formatBytes(artifact.outputBytes)}  Modified ${formatDateTime(artifact.modifiedAt)}`));
  console.log(DIM(formatArtifactPathForDisplay(artifact.path)));
  console.log(DIM('─'.repeat(40)));
  printArtifactPreview(content, parsed.full);
  return { success: true };
}

function findCheckpointByRef(ctx: CommandContext, ref: string) {
  const checkpoints = listCheckpoints(ctx.cwd);
  const exact = checkpoints.find(checkpoint => checkpoint.turnId === ref);
  if (exact) return { checkpoint: exact, ambiguous: false };

  const matches = checkpoints.filter(checkpoint => checkpoint.turnId.startsWith(ref));
  return {
    checkpoint: matches.length === 1 ? matches[0] : undefined,
    ambiguous: matches.length > 1,
  };
}

function handleCheckpoint(ctx: CommandContext, args: string = ''): CommandResult {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const action = tokens[0] ?? 'list';

  if (action === 'list') {
    const checkpoints = listCheckpoints(ctx.cwd);
    console.log(HEADER('Checkpoints'));
    console.log(DIM('─'.repeat(40)));
    if (checkpoints.length === 0) {
      console.log(DIM('No checkpoints found for this project.'));
      return { success: true };
    }

    for (const checkpoint of checkpoints.slice(0, 20)) {
      console.log(`${ACCENT(checkpoint.turnId)} ${DIM(formatDateTime(checkpoint.createdAt))}`);
      const files = checkpoint.files.map(file => file.path).slice(0, 8).join(', ');
      console.log(`  ${DIM(`${checkpoint.files.length} file(s)${files ? `: ${files}` : ''}`)}`);
    }
    console.log();
    console.log(DIM('Use /checkpoint restore <turn-id|prefix> to preview, then add --yes to restore.'));
    return { success: true };
  }

  if (action !== 'restore') {
    console.log(ERROR('Usage: /checkpoint [list|restore <turn-id|prefix> [--yes]]'));
    return { success: false };
  }

  const ref = tokens.find(token => token !== 'restore' && token !== '--yes');
  const confirmed = tokens.includes('--yes');
  if (!ref) {
    console.log(ERROR('Usage: /checkpoint restore <turn-id|prefix> [--yes]'));
    return { success: false };
  }

  const { checkpoint, ambiguous } = findCheckpointByRef(ctx, ref);
  if (!checkpoint) {
    console.log(ERROR(ambiguous
      ? `Checkpoint prefix is ambiguous: ${ref}`
      : `Checkpoint not found: ${ref}`));
    console.log(DIM('Run /checkpoint to list available checkpoint ids.'));
    return { success: false };
  }

  if (!confirmed) {
    console.log(HEADER(`Checkpoint ${checkpoint.turnId}`));
    console.log(DIM(`${formatDateTime(checkpoint.createdAt)}  ${checkpoint.files.length} file(s)`));
    for (const file of checkpoint.files.slice(0, 20)) {
      console.log(`  ${file.path} ${DIM(formatBytes(file.sizeBytes))}`);
    }
    console.log();
    console.log(WARN(`This will overwrite current files from checkpoint ${checkpoint.turnId}.`));
    console.log(DIM(`Run /checkpoint restore ${checkpoint.turnId} --yes to restore.`));
    return { success: true };
  }

  const result = restoreCheckpoint(ctx.cwd, checkpoint.turnId);
  if (result.error) {
    console.log(ERROR(result.error));
    return { success: false, error: result.error };
  }

  console.log(SUCCESS(`Restored ${result.restored.length} file(s) from checkpoint ${checkpoint.turnId}.`));
  for (const file of result.restored.slice(0, 20)) {
    console.log(`  ${file}`);
  }
  return { success: true, output: result.restored.join('\n') };
}

function snapshotCurrentModel(ctx: CommandContext): string {
  return ctx.store.getSnapshot().currentModel || ctx.config.model;
}

function getCommandAutoCompact(ctx: CommandContext, modelId: string) {
  if (ctx.compactCoordinator) {
    ctx.compactCoordinator.configure({
      modelId,
      llm: ctx.llm,
      outputReserveTokens: ctx.llm?.getMaxTokens?.(),
    });
    return ctx.compactCoordinator.getAutomatic();
  }
  return getAutoCompact({ modelId });
}

function showAgents(ctx: CommandContext): CommandResult {
  console.log();
  console.log(HEADER('Registered Agents'));
  console.log(DIM('─'.repeat(40)));

  for (const agent of ctx.runtime.agents) {
    const status = agent.getStatus();
    const statusColor = status.status === 'idle' ? SUCCESS : WARN;
    console.log();
    console.log(`  ${ACCENT(status.name)} ${DIM(`(${status.id})`)}`);
    console.log(`    Status:    ${statusColor(status.status)}`);
    console.log(`    Capabilities: ${status.capabilities.join(', ')}`);
  }
  console.log();
  return { success: true };
}

function showMemory(ctx: CommandContext): CommandResult {
  console.log();
  console.log(HEADER('Memory Status'));
  console.log(DIM('─'.repeat(40)));

  const memStatus = ctx.runtime.memory.getStatus();
  const storeStats = ctx.runtime.store.getStats();

  console.log();
  console.log(HEADER('  Inline MemorySystem:'));
  console.log(`    Working    ${memStatus.working} / ${ctx.runtime.config.memory.workingCapacity}`);
  console.log(`    Short-term ${memStatus['short-term']} / ${ctx.runtime.config.memory.shortTermCapacity}`);
  console.log(`    Long-term  ${memStatus['long-term']} entries`);

  console.log();
  console.log(HEADER('  Modular MemoryStore:'));
  console.log(`    Working    ${storeStats.working}`);
  console.log(`    Short-term ${storeStats['short-term']}`);
  console.log(`    Long-term  ${storeStats['long-term']} entries`);
  console.log();
  return { success: true };
}

async function handleMemoryReindex(_ctx: CommandContext): Promise<CommandResult> {
  const { isSemanticEnabled, getSemanticSearchService } = require('../memory/semantic-search');

  if (!isSemanticEnabled()) {
    console.log();
    console.log(WARN('⚠ Semantic search is not enabled.'));
    console.log(DIM('  Set ORION_CODE_EMBEDDING_PROVIDER=ollama or openai to enable.'));
    console.log();
    return { success: false };
  }

  console.log();
  console.log(HEADER('Reindexing project memories...'));

  try {
    const service = getSemanticSearchService();
    const count = await service.indexExistingMemories(process.cwd());
    console.log(SUCCESS(`✔ Indexed ${count} memories`));
  } catch (err: any) {
    console.log(ERROR(`✗ Reindex failed: ${err.message}`));
    return { success: false };
  }

  console.log();
  return { success: true };
}

async function handleMemory(ctx: CommandContext, args: string): Promise<CommandResult> {
  const sub = args.trim().toLowerCase();
  if (sub === 'reindex') {
    return handleMemoryReindex(ctx);
  }
  return showMemory(ctx);
}

function showSafety(ctx: CommandContext): CommandResult {
  console.log();
  console.log(HEADER('Safety Checker'));
  console.log(DIM('─'.repeat(40)));

  const policy = ctx.runtime.safety.getPolicy();
  const summary = ctx.runtime.safety.getAuditSummary();

  console.log();
  console.log(`  Enabled    ${policy.enabled ? SUCCESS('yes') : ERROR('no')}`);
  console.log(`  Sandbox    ${policy.sandboxMode ? WARN('on') : DIM('off')}`);
  console.log();
  console.log(`  Blocked patterns:`);
  for (const pattern of policy.blocked) {
    console.log(`    ${ERROR('✗')} ${DIM(pattern)}`);
  }
  console.log();
  console.log(`  Dangerous patterns:`);
  for (const pattern of policy.dangerousPatterns) {
    console.log(`    ${WARN('⚠')} ${DIM(pattern)}`);
  }
  console.log();
  console.log(`  Audit summary: ${summary.total} checks | ${SUCCESS(`${summary.passed} passed`)} | ${ERROR(`${summary.blocked} blocked`)}`);
  console.log();
  return { success: true };
}

function showHarness(ctx: CommandContext, args: string = ''): CommandResult {
  const explain = args.trim().toLowerCase() === 'explain';
  console.log();
  console.log(HEADER(explain ? 'Harness Explain' : 'Harness'));
  console.log(DIM('─'.repeat(40)));

  const cfg = ctx.runtime.harness.getConfig();
  console.log();
  if (!explain) {
    console.log(`  Max steps       ${cfg.maxSteps}`);
    console.log(`  Boundary check  ${cfg.boundaryCheck ? SUCCESS('on') : ERROR('off')}`);
    console.log(`  Goal constraint ${cfg.goalConstraint ? SUCCESS('on') : ERROR('off')}`);
    console.log(`  Result validate ${cfg.resultValidation ? SUCCESS('on') : ERROR('off')}`);
    console.log(`  Sandbox         ${cfg.sandbox ? WARN('on') : DIM('off')}`);
    console.log(`  Timeout         ${cfg.timeout}ms`);
    console.log(`  Blocked actions ${DIM(cfg.blockedActions.join(', ') || 'none')}`);
  }

  const state = ctx.store.getSnapshot().harnessState;
  if (!state) {
    console.log();
    console.log(DIM('  No Context Harness state for this session yet.'));
    console.log();
    return { success: true };
  }

  if (explain) {
    // Build explain output from harnessState in store
    const contract = state.contract;

    // Contract section
    console.log(HEADER('  Contract'));
    if (contract) {
      console.log(`    Objective   ${ACCENT(contract.objective || '(none)')}`);
      if (contract.requirements?.length) {
        console.log(`    Requires    ${DIM(contract.requirements.slice(0, 3).join(' | '))}`);
      }
      if (contract.prohibitions?.length) {
        console.log(`    Prohibits   ${WARN(contract.prohibitions.slice(0, 3).join(' | '))}`);
      }
      if (contract.successCriteria?.length) {
        console.log(`    Success     ${DIM(contract.successCriteria.slice(0, 3).join(' | '))}`);
      }
    } else {
      console.log(DIM('    (no contract established)'));
    }
    console.log();

    // Context source
    console.log(HEADER('  Context Source'));
    const session = ctx.getSession?.() ?? (ctx.sessionId ? loadSessionMeta(ctx.sessionId) : null);
    const isRestored = session?.transcriptDisplayStartTime != null;
    const isCompactActive = Boolean(state.promptAssemblyStats);
    console.log(`    Root       ${ACCENT(state.rootObjective || contract?.objective || '(none)')}`);
    console.log(`    Active     ${DIM(state.activeInstruction || contract?.userIntent || '(none)')}`);
    console.log(`    Source     ${isRestored ? WARN('restored session') : DIM('live turn')}`);
    if (isRestored && session) {
      const restoredTime = session.transcriptDisplayStartTime
        ? new Date(session.transcriptDisplayStartTime).toLocaleString()
        : 'unknown';
      console.log(`    Restored   ${DIM(restoredTime)}`);
    }
    if (isCompactActive) {
      console.log(`    Compact    ${SUCCESS('active')}`);
    }
    console.log();

    // Evidence index summary
    console.log(HEADER('  Evidence Index'));
    const evidenceItems = state.evidenceIndex?.length ?? 0;
    const evidenceKinds = new Map<string, number>();
    if (state.evidenceIndex) {
      for (const item of state.evidenceIndex) {
        const kind = item.kind || 'unknown';
        evidenceKinds.set(kind, (evidenceKinds.get(kind) || 0) + 1);
      }
    }
    console.log(`    Total      ${ACCENT(String(evidenceItems))} items`);
    if (evidenceKinds.size > 0) {
      const kinds = Array.from(evidenceKinds.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      for (const [kind, count] of kinds) {
        console.log(`      ${DIM(kind.padEnd(16))} ${count}`);
      }
    } else {
      console.log(DIM('      (no evidence records yet)'));
    }
    console.log();

    // Intent history
    console.log(HEADER('  Recent Intents'));
    const intents = state.intentHistory?.slice(-5) ?? [];
    if (intents.length > 0) {
      for (const intent of intents) {
        const conf = intent.confidence != null ? ` (${Math.round(intent.confidence * 100)}%)` : '';
        console.log(`    ${ACCENT(intent.kind)}${DIM(conf)} ${DIM(intent.summary?.slice(0, 50) || '')}`);
      }
    } else {
      console.log(DIM('    (no intents recorded)'));
    }
    console.log();

    // Capsule snapshot
    console.log(HEADER('  Capsule'));
    const capsule = state.capsule;
    if (capsule) {
      console.log(`    Next        ${DIM(capsule.nextAction)}`);
      if (capsule.completed?.length) {
        console.log(`    Done        ${SUCCESS(`${capsule.completed.length} steps`)}`);
      }
      if (capsule.openTodos?.length) {
        console.log(`    Open        ${WARN(`${capsule.openTodos.length} todos`)}`);
      }
      if (capsule.changedFiles?.length) {
        console.log(`    Files       ${DIM(capsule.changedFiles.slice(0, 5).join(', '))}`);
      }
      const passed = capsule.verification?.passed?.length ?? 0;
      const failed = capsule.verification?.failed?.length ?? 0;
      console.log(`    Verify      ${SUCCESS(`${passed} passed`)} / ${failed > 0 ? ERROR(`${failed} failed`) : DIM('0 failed')}`);
    } else {
      console.log(DIM('    (no capsule yet)'));
    }
    console.log();

    // Prompt assembly stats
    const stats = state.promptAssemblyStats;
    console.log(HEADER('  Prompt Assembly'));
    if (stats) {
      console.log(`    Model       ${ACCENT(stats.modelId)}`);
      console.log(`    Budget      ${DIM(`${stats.estimatedTokens}/${stats.budgetTokens} tokens`)}`);
      console.log(`    Sections    ${DIM(stats.sections.join(', ') || 'none')}`);
      console.log(`    Ledger      ${DIM(`${state.ledger?.length ?? 0} entries`)}`);
      console.log(`    Evidence    ${DIM(`${state.evidenceIndex?.length ?? 0} records`)}`);
      console.log(`    Turns       ${DIM(`${state.turnSummaries?.length ?? 0} summaries`)}`);
      console.log();
      console.log(HEADER('    Included Evidence'));
      for (const item of stats.includedEvidence.slice(0, 10)) {
        console.log(`      ${ACCENT(item.id)} ${DIM(`[${item.kind}] score=${item.score} tokens=${item.tokens}`)}`);
        console.log(`        ${DIM(item.reason)}`);
      }
      if (stats.includedEvidence.length === 0) {
        console.log(DIM('      none'));
      }
      if (stats.omittedEvidence.length > 0) {
        console.log();
        console.log(HEADER('    Omitted Evidence'));
        for (const item of stats.omittedEvidence.slice(0, 8)) {
          console.log(`      ${DIM(item.id)} ${DIM(`[${item.kind}] score=${item.score} tokens=${item.tokens}`)}`);
          console.log(`        ${DIM(item.reason)}`);
        }
      }
    } else {
      console.log(DIM('    No prompt assembly stats recorded yet. Run a chat turn first.'));
    }
    console.log();
    console.log(HEADER('  Auto Compact'));
    const compactStats = getCommandAutoCompact(
      ctx,
      state.promptAssemblyStats?.modelId ?? snapshotCurrentModel(ctx)
    ).getStats();
    const contextInfo = resolveModelContext(compactStats.modelId);
    console.log(`    Model       ${ACCENT(compactStats.modelId)}`);
    console.log(`    Window      ${DIM(`${formatTokenCount(contextInfo.contextWindow)} tokens (${contextInfo.source}${contextInfo.source === 'fuzzy' ? `:${contextInfo.matchedId}` : ''})`)}`);
    console.log(`    Thresholds  ${DIM(`predict ${formatThreshold(compactStats.predictiveCompactThreshold)}, hard ${formatThreshold(compactStats.threshold)}, prewarm ${formatThreshold(compactStats.preCompactThreshold)}`)}`);
    console.log(`    Usage       ${DIM(`${compactStats.lastTokenCount} tokens, ${compactStats.ctxPercent}%`)}`);
    console.log(`    Armed       ${compactStats.preCompactArmed ? SUCCESS('yes') : DIM('no')}`);
    console.log(`    Last mode   ${DIM(compactStats.lastCompactMode ?? 'none')}`);
    console.log();
    return { success: true };
  }

  console.log();
  console.log(HEADER('  Context State'));
  console.log(`    Version     ${ACCENT(String(state.version ?? 1))}`);
  console.log(`    Epoch       ${ACCENT(String(state.taskEpoch ?? 1))}`);
  console.log(`    Objective   ${ACCENT(state.rootObjective ?? state.contract?.objective ?? '(none)')}`);
  console.log(`    Active      ${DIM(state.activeInstruction ?? state.contract?.userIntent ?? '(none)')}`);
  console.log(`    Ledger      ${DIM(`${state.ledger.length} entries`)}`);
  console.log(`    Evidence    ${DIM(`${state.evidenceIndex?.length ?? 0} records`)}`);
  console.log(`    Turns       ${DIM(`${state.turnSummaries?.length ?? 0} summaries`)}`);
  if (state.activeConstraints && state.activeConstraints.length > 0) {
    console.log(`    Constraints ${DIM(state.activeConstraints.slice(0, 3).join(' | '))}`);
  }
  if (state.capsule) {
    console.log(`    Next        ${DIM(state.capsule.nextAction)}`);
    const passed = state.capsule.verification.passed.length;
    const failed = state.capsule.verification.failed.length;
    console.log(`    Verify      ${SUCCESS(`${passed} passed`)} / ${failed > 0 ? ERROR(`${failed} failed`) : DIM('0 failed')}`);
  }
  if (state.diagnostics && state.diagnostics.length > 0) {
    console.log(`    Diagnostics ${WARN(state.diagnostics.slice(-2).join(' | '))}`);
  }
  console.log();
  return { success: true };
}

function showConfig(ctx: CommandContext): CommandResult {
  console.log();
  console.log(HEADER('Configuration'));
  console.log(DIM('─'.repeat(40)));

  const summary = {
    name: ctx.config.name,
    model: ctx.config.model,
    apiBaseUrl: ctx.config.apiBaseUrl || '(default OpenAI)',
    apiKey: ctx.config.apiKey ? `${ctx.config.apiKey.slice(0, 7)}***` : '(not set)',
    mode: ctx.config.mode,
    logLevel: ctx.config.logLevel,
    toolConfirmation: ctx.config.toolConfirmation,
  };

  const llmSummary = ctx.llm?.getConfigSummary() ?? {};

  for (const [key, val] of Object.entries(summary)) {
    console.log(`  ${ACCENT(key.padEnd(16))} ${DIM(val)}`);
  }
  console.log();
  console.log(HEADER('  LLM Settings:'));
  for (const [key, val] of Object.entries(llmSummary)) {
    console.log(`  ${ACCENT(key.padEnd(16))} ${DIM(val)}`);
  }
  console.log();
  return { success: true };
}

function handleModel(ctx: CommandContext, args: string): CommandResult {
  const trimmedArgs = args.trim().toLowerCase();

  // 显示当前模型
  if (!args || trimmedArgs === '?' || trimmedArgs === 'info') {
    console.log();
    if (ctx.llm) {
      const currentModel = ctx.llm.getModel();
      const aliasEntry = getModelCatalogEntry(currentModel);
      const contextInfo = resolveModelContext(currentModel);
      const compactStats = getCommandAutoCompact(ctx, currentModel).getStats();
      console.log(HEADER('Current Model'));
      console.log(DIM('─'.repeat(40)));
      console.log(`  Model    ${BRAND(currentModel)}`);
      if (aliasEntry) {
        console.log(`  Alias    ${ACCENT(aliasEntry.alias)}`);
        console.log(`  Provider ${DIM(aliasEntry.provider)}`);
      }
      console.log(`  Context  ${DIM(`${formatTokenCount(contextInfo.contextWindow)} tokens`)}`);
      if (contextInfo.maxOutputTokens) {
        console.log(`  Output   ${DIM(`${formatTokenCount(contextInfo.maxOutputTokens)} tokens`)}`);
      }
      console.log(`  Source   ${DIM(`${contextInfo.source}${contextInfo.source === 'fuzzy' ? `:${contextInfo.matchedId}` : ''}`)}`);
      console.log(`  Compact  ${compactStats.enabled ? SUCCESS('auto') : WARN('off')} ${DIM(`predict ${formatThreshold(compactStats.predictiveCompactThreshold)}, hard ${formatThreshold(compactStats.threshold)}`)}`);
    } else {
      console.log(ERROR('LLM not initialized. Set ORION_CODE_API_KEY first.'));
    }
    console.log();
    return { success: true };
  }

  // 显示模型列表
  if (trimmedArgs === 'list' || trimmedArgs === 'ls') {
    console.log();
    console.log(HEADER('Available Models'));
    console.log(DIM('─'.repeat(40)));
    const currentModel = ctx.llm?.getModel() || '';
    const modelPicker = createModelPickerState({
      currentModel,
      models: listModelCatalogEntries().map(model => {
        const contextInfo = resolveModelContext(model.name);
        return {
          ...model,
          contextWindow: contextInfo.contextWindow,
          maxOutputTokens: contextInfo.maxOutputTokens,
          source: contextInfo.source,
        };
      }),
    });
    for (const item of modelPicker.visibleItems) {
      const marker = item.isCurrent ? SUCCESS('●') : DIM('○');
      const alias = item.alias ? `(${item.alias})` : '';
      const context = `${formatTokenCount(item.contextWindow ?? 0)} ctx`;
      const current = item.isCurrent ? BRAND('(current)') : '';
      console.log(`  ${marker} ${ACCENT(item.name)} ${DIM(alias)} ${DIM(context)} ${current}`);
      console.log(`      ${DIM(item.provider ?? 'unknown')}`);
    }
    console.log();
    console.log(DIM('Use /model <name|alias> to switch, e.g. /model sonnet'));
    console.log();
    return { success: true };
  }

  // 显示帮助
  if (trimmedArgs === 'help') {
    console.log();
    console.log(HEADER('/model Command Help'));
    console.log(DIM('─'.repeat(40)));
    console.log();
    console.log(`  ${ACCENT('/model')}           Show current model`);
    console.log(`  ${ACCENT('/model list')}      Show available models`);
    console.log(`  ${ACCENT('/model <name>')}    Switch to specific model`);
    console.log(`  ${ACCENT('/model <alias>')}   Switch using alias (opus, sonnet, haiku)`);
    console.log();
    console.log(DIM(`Aliases: ${formatModelAliasHelp()}`));
    console.log();
    return { success: true };
  }

  // 设置模型
  if (!ctx.llm) {
    console.log(ERROR('LLM not initialized. Set ORION_CODE_API_KEY first.'));
    console.log();
    return { success: false };
  }

  // 解析别名
  const resolvedModel = resolveModelAlias(args);

  ctx.llm.setModel(resolvedModel);
  getCommandAutoCompact(ctx, resolvedModel);
  ctx.store.setState({ currentModel: resolvedModel });
  console.log(SUCCESS(`✔ Model changed to ${BRAND(resolvedModel)}`));
  const contextInfo = resolveModelContext(resolvedModel);
  console.log(DIM(`  Context window ${formatTokenCount(contextInfo.contextWindow)} tokens (${contextInfo.source})`));
  console.log();
  return { success: true };
}

function normalizePermissionMode(raw: string): PermissionMode | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value === 'accept' || value === 'acceptedits' || value === 'accept-edits' || value === 'edit') {
    return 'acceptEdits';
  }
  if (value === 'default' || value === 'ask') return 'default';
  if (value === 'plan' || value === 'readonly' || value === 'read-only') return 'plan';
  if (value === 'auto' || value === 'full-auto') return 'auto';
  return null;
}

function handleMode(ctx: CommandContext, args: string): CommandResult {
  const current = ctx.store.getSnapshot().permissionMode;
  const trimmed = args.trim();

  if (!trimmed || trimmed === '?' || trimmed === 'help') {
    console.log();
    console.log(HEADER('Permission Mode'));
    console.log(DIM('─'.repeat(40)));
    console.log(`  Current  ${ACCENT(current)} ${DIM(getModeDisplayText(current) || 'ask before sensitive actions')}`);
    console.log();
    console.log(`  ${ACCENT('/mode next')}           Cycle to the next mode`);
    console.log(`  ${ACCENT('/mode default')}        Ask before sensitive actions`);
    console.log(`  ${ACCENT('/mode accept-edits')}   Auto-accept file edits`);
    console.log(`  ${ACCENT('/mode plan')}           Plan first, avoid executing edits`);
    console.log(`  ${ACCENT('/mode auto')}           Auto-run allowed actions`);
    console.log();
    return { success: true };
  }

  const next = trimmed === 'next'
    ? getNextPermissionMode(current)
    : normalizePermissionMode(trimmed);

  if (!next || !PERMISSION_MODES.includes(next)) {
    return {
      success: false,
      error: `Unknown mode: ${trimmed}. Use one of: default, accept-edits, plan, auto, next.`,
    };
  }

  ctx.store.setPermissionMode(next);
  const display = getModeDisplayText(next);
  return {
    success: true,
    output: `Mode changed to ${next}${display ? ` (${display})` : ''}.`,
  };
}

function handleTask(ctx: CommandContext, args: string): CommandResult {
  const [sub] = args.trim().split(/\s+/);

  if (sub === 'list' || sub === 'ls') {
    if (!taskManager) {
      taskManager = new TaskManager();
    }

    console.log();
    console.log(HEADER('Task List'));
    console.log(DIM('─'.repeat(40)));

    const stats = taskManager.getStats();
    console.log(`  Total      ${stats.total}`);
    console.log(`  Pending    ${stats.pending}`);
    console.log(`  Running    ${stats.running}`);
    console.log(`  Completed  ${SUCCESS(stats.completed)}`);
    console.log(`  Failed     ${ERROR(stats.failed)}`);
    console.log(`  Cancelled  ${DIM(stats.cancelled)}`);

    const tasks = taskManager.list();
    if (tasks.length > 0) {
      console.log();
      for (const t of tasks) {
        const statusIcon = t.status === 'completed' ? SUCCESS('✓')
          : t.status === 'failed' ? ERROR('✗')
          : t.status === 'running' ? WARN('◌')
          : t.status === 'cancelled' ? DIM('⊘')
          : DIM('○');
        console.log(`  ${statusIcon} ${ACCENT(t.name)} ${DIM(`(${t.id.slice(0, 8)})`)}`);
        console.log(`    ${DIM(`[${t.priority}]`)} ${t.description.slice(0, 60)}`);
      }
    }
    console.log();
    return { success: true };
  }

  // 默认行为: 作为任务名提交
  const taskName = args.trim() || 'demo-task';
  const task: Task = {
    id: `cli-${Date.now()}`,
    name: taskName,
    description: `Task submitted from CLI: ${taskName}`,
    priority: 'P1',
    assignedTo: 'leader',
    status: 'pending',
  };

  console.log();
  ctx.runtime.brain.submitTask(task);
  console.log(SUCCESS(`✔ Task "${taskName}" submitted`));
  console.log();
  return { success: true };
}

async function handleRun(ctx: CommandContext, args: string): Promise<CommandResult> {
  if (!args.trim()) {
    console.log(ERROR('Usage: /run <task description>'));
    console.log(DIM('  Creates a task and executes it through the Agent + LLM pipeline.'));
    console.log();
    return { success: false };
  }

  if (!ctx.llm || !isConfigured(ctx.config)) {
    console.log(WARN('⚠ LLM not configured. Set ORION_CODE_API_KEY in .env to enable run mode.'));
    console.log();
    return { success: false };
  }

  if (!taskManager) {
    taskManager = new TaskManager();
  }

  const taskOptions: CreateTaskOptions = {
    name: args.slice(0, 80),
    description: args,
    priority: 'P1',
    assignedTo: 'leader',
    tags: ['cli', 'interactive'],
  };

  const record = taskManager.create(taskOptions);
  console.log();
  console.log(SUCCESS(`✔ Task created: ${ACCENT(record.name)}`));
  console.log(DIM(`  ID: ${record.id} | Tags: ${record.tags.join(', ')}`));

  taskManager.start(record.id);
  console.log(WARN('◌ Running task through Agent + LLM...'));

  try {
    const agent = ctx.runtime.agents[0];
    if (!agent) {
      throw new Error('No agents registered');
    }

    const runner = new AgentRunner(agent, ctx.llm);
    const task = taskManager.toTask(record);
    const result = await runner.run(task);

    if (result.success) {
      taskManager.complete(record.id, result);
      console.log(SUCCESS(`✓ Task completed in ${result.duration}ms`));
      if (result.tokenUsage) {
        console.log(DIM(`  Tokens: ${result.tokenUsage.promptTokens} in / ${result.tokenUsage.completionTokens} out`));
      }
      if (result.data?.summary) {
        console.log();
        console.log(ACCENT('  Summary:'));
        console.log(`  ${result.data.summary}`);
      }
    } else {
      taskManager.fail(record.id, result.error, result);
      console.log(ERROR(`✗ Task failed: ${result.error}`));
    }
  } catch (error: any) {
    taskManager.fail(record.id, error.message);
    console.log(ERROR(`✗ Task error: ${error.message}`));
  }

  console.log();
  return { success: true };
}

async function handleChat(ctx: CommandContext, input: string): Promise<CommandResult> {
  const ui = commandUICapabilities(ctx);
  const writeOutput = ctx.writeOutput ?? ((text: string) => process.stdout.write(text));
  const writeLine = ctx.writeLine ?? ((text: string = '') => console.log(text));

  if (!input) {
    console.log(ERROR('Usage: /chat <message>'));
    console.log();
    return { success: false };
  }

  if (!ctx.llm || !isConfigured(ctx.config)) {
    console.log(WARN('⚠ LLM not configured. Set ORION_CODE_API_KEY in .env to enable chat.'));
    console.log();
    return { success: false };
  }

  const activeSession = ctx.getSession?.() ?? ctx.ensureSession?.() ?? (ctx.sessionId ? loadSessionMeta(ctx.sessionId) : null);
  const sessionId = activeSession?.id ?? ctx.sessionId;
  const runtimeTools = getRuntimeTools();
  const skillResolution = resolveSkillsForTurn({
    cwd: ctx.cwd,
    input,
    tools: runtimeTools,
    projectPath: activeSession?.projectPath,
    sessionId,
  });
  const appliedSkillNames = skillResolution.skills.map(skill => skill.name);

  // Record user message to session
  if (sessionId) {
    appendSessionMessage(sessionId, {
      role: 'user',
      content: input,
      timestamp: Date.now(),
      appliedSkills: appliedSkillNames.length > 0 ? appliedSkillNames : undefined,
    });
  }

  ctx.store.addMessage({ role: 'user', content: input });
  refreshProjectInstructions(ctx.store, ctx.cwd);
  const snapshot = ctx.store.getSnapshot();
  const harness = createContextHarness({
    cwd: ctx.cwd,
    modelId: ctx.llm.getModel(),
    state: snapshot.harnessState,
    config: {
      enabled: true,
      driftGuard: 'warn',
      completionGate: true,
    },
  });
  const intent = harness.updateContractFromUserInput(input);
  harness.recordAppliedSkills(skillResolution.skills);

  const promptCtx: PromptContext = {
    cwd: ctx.cwd,
    platform: process.platform,
    nodeVersion: process.version,
    tools: skillResolution.tools,
    memoryContent: snapshot.memoryContent,
    skillsContent: snapshot.skillsContent,
    projectInstructionsContent: snapshot.projectInstructionsContent,
    activeSkillsContent: skillResolution.promptInjection,
    referencedFilesContent: buildReferencedFilesPrompt(input, ctx.cwd),
  };
  const systemPrompt = getSystemPrompt(promptCtx);

  const spinner = createSpinner();
  const useSpinner = !ui.inlineProgress;
  if (useSpinner) {
    spinner.start('Thinking');
  }

  let finalContent = '';
  let finalModel = '';
  let finalUsage: { promptTokens: number; completionTokens: number } | undefined;
  let responseStarted = false;
  const sessionMessagesToRecord: SessionMessage[] = [];

  // Issue #22: 批量工具调用进度显示
  let toolCallCount = 0;
  let lastProgressUpdate = 0;

  // 流式 Markdown 渲染器
  let streamRenderer: StreamMarkdownRenderer | null = null;

  // Issue #32 #3.2: toolExecutor 支持 abortSignal
  const toolExecutor = async (name: string, args: Record<string, unknown>, abortSignal?: AbortSignal) => {
    if (!skillResolution.tools.some(tool => tool.name === name)) {
      return JSON.stringify({
        success: false,
        error: skillResolution.toolScopeActive
          ? `Tool ${name} is not available for the active skill scope. Available tools: ${skillResolution.tools.map(tool => tool.name).join(', ') || 'none'}`
          : `Tool ${name} is not available.`,
      });
    }
    const result = await executeTool(name, args, abortSignal, {
      cwd: ctx.cwd,
      config: {
        name: ctx.config.name,
        mode: ctx.config.mode,
      },
      sessionId,
      turnId: ctx.turnId,
    });
    // 不在这里打印，让 tool_result 事件处理
    return result;
  };

  const streamCallbacks: StreamCallbacks = {
    onChunk: (chunk: string) => {
      if (ctx.abortSignal?.aborted) {
        return;
      }

      if (!responseStarted) {
        responseStarted = true;
        spinner.stop();
        // 打印换行，让流式输出在新行开始
        writeLine();
        // 初始化流式渲染器
        streamRenderer = createStreamRenderer();
      }
      // 使用流式渲染器处理 chunk
      if (streamRenderer) {
        const rendered = streamRenderer.feed(chunk);
        if (rendered) {
          writeOutput(rendered);
        }
      } else {
        writeOutput(chunk);
      }
    },
  };

  try {
    const messages: Message[] = [{ role: 'system', content: systemPrompt }, ...snapshot.conversationHistory];

    for await (const event of query({
      messages,
      tools: skillResolution.tools,
      toolExecutor,
      llm: ctx.llm,
      streamCallbacks,
      costTracker: snapshot.costTracker,
      permissionMode: snapshot.permissionMode,
      toolConfirmation: ctx.config.toolConfirmation,
      toolContext: {
        cwd: ctx.cwd,
        config: {
          name: ctx.config.name,
          mode: ctx.config.mode,
        },
        sessionId,
        turnId: ctx.turnId,
      },
      abortSignal: ctx.abortSignal,
      harness,
      input,
      loopBudget: resolveRuntimeLoopBudget(input, ctx.config, harness.toJSON()),
    })) {
      switch (event.type) {
        case 'request_start':
          // 停止 spinner，等待 LLM 响应
          spinner.stop();
          writeLine();
          writeLine(DIM(agentStepStatus(event.turn)));
          // 重置流式渲染器
          streamRenderer = createStreamRenderer();
          // Issue #22: 重置工具调用计数器
          toolCallCount = 0;
          lastProgressUpdate = 0;
          break;

        case 'assistant_tool_calls':
          if (event.toolCalls.length > 1) {
            writeLine(DIM(runningToolsStatus(event.toolCalls.length)));
          }
          sessionMessagesToRecord.push({
            role: 'assistant',
            content: event.content || '',
            timestamp: Date.now(),
            tool_calls: event.toolCalls,
          });
          break;

        case 'tool_call':
          // Issue #22: 批量工具调用进度显示
          toolCallCount++;
          if (toolCallCount >= 3 && Date.now() - lastProgressUpdate > 1000) {
            showToolProgress(toolCallCount, event.name);
            lastProgressUpdate = Date.now();
          }
          break;

        case 'tool_result':
          // Issue #22: 隐藏进度指示
          hideProgress();
          // 显示工具结果后，准备下一轮（不启动 spinner）
          writeLine(event.summary || toolLine(event.name, event.args, event.success, event.duration));
          // 显示错误详情
          if (!event.success && event.error) {
            writeLine(ERROR(`    Error: ${event.error}`));
          }
          // Debug: 显示接收到的参数
          if (!event.success && Object.keys(event.args).length === 0) {
            writeLine(WARN(`    ⚠ Tool received empty arguments - LLM may not be providing parameters correctly`));
            writeLine(DIM(`    Try using /model qwen or /model gpt4o for better tool calling support`));
          }
          // Record tool result for session
          sessionMessagesToRecord.push({
            role: 'tool',
            content: event.result,
            modelVisibleContent: event.modelVisibleResult,
            timestamp: Date.now(),
            toolCallId: event.callId,
          });
          break;

        case 'message':
          if (event.content) {
            sessionMessagesToRecord.push({
              role: 'assistant',
              content: event.content,
              timestamp: Date.now(),
            });
          }
          break;

        case 'strategy_exhausted':
          writeLine(WARN(`⚠ ${event.suggestion}`));
          break;

        case 'complete':
          finalContent = event.content;
          finalModel = event.model;
          finalUsage = event.usage;
          if (event.stats) {
            ctx.store.setLastLoopStats(event.stats);
          }
          break;
      }
    }

    // 刷新流式渲染器，输出剩余内容
    if (streamRenderer) {
      const remaining = streamRenderer.flush();
      if (remaining) {
        writeOutput(remaining);
      }
      streamRenderer = null;
    }

    const wasAborted = ctx.abortSignal?.aborted === true;

    if (finalContent && !wasAborted) {
      ctx.store.addMessage({ role: 'assistant', content: finalContent });
    }

    if (sessionId && sessionMessagesToRecord.length > 0 && !wasAborted) {
      appendSessionMessages(sessionId, sessionMessagesToRecord);
    }

    if (finalUsage && !wasAborted) {
      ctx.store.setTokenUsage(finalUsage);
    }

    if (!wasAborted) {
      harness.ingestTurn({
        userInput: input,
        assistantContent: finalContent,
        sessionMessages: sessionMessagesToRecord,
        intent,
      });
      const harnessState = harness.toJSON();
      ctx.store.setState({ harnessState });
      if (sessionId) {
        updateSessionSkills(sessionId, appliedSkillNames);
        updateSessionHarnessState(sessionId, harnessState);
        const recordedMessages = readSessionMessages(sessionId);
        if (recordedMessages.length > 0) {
          updateSessionSummary(sessionId, recordedMessages);
        }
      }
    }

    if (responseStarted) {
      writeLine();
      if (ui.extraAssistantSpacing) {
        writeLine();
      }
    }
    if (!ui.suppressLegacyTokenMeta) {
      const stats = [
        finalUsage ? `tokens: ${finalUsage.promptTokens}+${finalUsage.completionTokens}` : '',
        finalModel ? finalModel : '',
      ].filter(Boolean).join('  ');
      if (stats) {
        writeLine(DIM(stats));
      }
    }
  } catch (error: any) {
    spinner.stop();
    writeLine();
    if (isAbortError(error, ctx.abortSignal)) {
      hideProgress();
      if (!ui.suppressAbortNotice) {
        writeLine(DIM('Interrupted.'));
      }
    } else {
      writeLine(ERROR(`✗ ${error.message || String(error)}`));
      const hist = ctx.store.getSnapshot().conversationHistory;
      if (hist.length > 0) {
        ctx.store.setState({ conversationHistory: hist.slice(0, -1) });
      }
    }
  }

  return { success: true };
}

async function handleExit(ctx: CommandContext): Promise<CommandResult> {
  console.log();
  console.log(DIM('Shutting down...'));

  // Update session summary before exit
  if (ctx.sessionId) {
    const messages = readSessionMessages(ctx.sessionId);
    if (messages.length > 0) {
      updateSessionSummary(ctx.sessionId, messages);
    }
    endSession(ctx.sessionId);
  }

  await ctx.runtime.shutdown();
  console.log(SUCCESS('Goodbye! 🐴'));
  process.exit(0);
}

function handleCost(ctx: CommandContext): CommandResult {
  console.log();
  console.log(HEADER('Lifetime Cost'));
  console.log(DIM('─'.repeat(40)));

  const costTracker = ctx.store.getSnapshot().costTracker;
  const state = loadUsageState();
  const ledger = summarizeUsageLedger();

  if (state.totalTokens === 0 && state.totalCost === 0) {
    console.log(DIM('  No usage recorded yet.'));
    console.log(DIM('  Use /run or /chat to interact with LLM.'));
    console.log();
    return { success: true };
  }

  // Summary
  console.log();
  console.log(`  ${ACCENT('Total Tokens')}   ${state.totalTokens.toLocaleString()}`);
  console.log(`  ${ACCENT('Tracked Cost')}   ${costTracker.formatCost(state.totalCost)}`);
  console.log(`  ${ACCENT('Provider Cost')}  ${costTracker.formatCost(state.providerCost)}`);
  console.log(`  ${ACCENT('Estimated Cost')} ${costTracker.formatCost(state.estimatedCost)}`);
  console.log(`  ${ACCENT('Requests')}       ${state.usageRecords.toLocaleString()}`);
  console.log(`  ${ACCENT('Sessions')}       ${state.totalSessions.toLocaleString()}`);

  // By Model
  if (Object.keys(ledger.byModel).length > 0) {
    console.log();
    console.log(HEADER('  By Model:'));
    for (const [model, data] of Object.entries(ledger.byModel)) {
      console.log(`    ${BRAND(model.padEnd(20))} ${data.tokens} tokens, ${costTracker.formatCost(data.cost)}`);
    }
  }

  console.log();
  console.log(HEADER('  Cost Sources:'));
  for (const source of ['provider', 'configured', 'builtin', 'fallback'] as const) {
    const data = ledger.bySource[source];
    if (data.count === 0) continue;
    console.log(
      `    ${source.padEnd(12)} ${data.count} requests, ${costTracker.formatCost(data.cost)}`,
    );
  }
  if (state.baselineCost > 0 || state.baselineTokens > 0) {
    console.log(
      DIM(
        `    legacy       ${state.baselineTokens.toLocaleString()} tokens, ${costTracker.formatCost(state.baselineCost)}`,
      ),
    );
  }
  if (ledger.bySource.fallback.count > 0) {
    console.log();
    console.log(WARN('  Unknown-model fallback pricing is an estimate.'));
    console.log(DIM('  Configure cost.modelPricing in ~/.orion-code/orion.json for accuracy.'));
  }

  // Budget
  const budget = costTracker.getBudget();
  if (budget !== null) {
    const check = costTracker.checkBudget();
    console.log();
    console.log(HEADER('  Budget:'));
    console.log(`    ${ACCENT('Limit')}    ${costTracker.formatCost(budget)}`);
    console.log(`    ${ACCENT('Used this run')} ${costTracker.formatCost(check.used)}`);
    console.log(`    ${check.ok ? SUCCESS('✓ Within budget') : WARN('⚠ Budget exceeded')}`);
  }

  console.log();
  return { success: true };
}

function handleSkills(_ctx: CommandContext): CommandResult {
  console.log();
  console.log(HEADER('Loaded Skills'));
  console.log(DIM('─'.repeat(40)));

  try {
    const registry = getSkillsRegistry();
    const summary = registry.getSummary();

    if (summary.count === 0) {
      console.log();
      console.log(DIM('  No skills loaded.'));
      console.log(DIM('  Place SKILL.md files in ~/.orion-code/skills/<name>/ or .orion-code/skills/<name>/'));
      console.log();
      return { success: true };
    }

    console.log();
    console.log(`  Total ${SUCCESS(summary.count)} skills (${WARN(summary.autoCount)} auto-trigger)`);
    console.log();
    for (const skill of registry.getAllSkills()) {
      const source = registry.getSource(skill.name);
      const sourceType = source?.type || 'unknown';
      const resourceRoot = skill.resourceRoot || skill.source || source?.path;
      const skillFile = resourceRoot
        ? `${resourceRoot.replace(/\/SKILL\.md$/i, '')}/SKILL.md`
        : source?.skillFile;
      console.log(`  ${ACCENT(skill.name)} ${DIM(`(${sourceType})`)}`);
      console.log(`    ${DIM(skill.description || '(no description)')}`);
      if (skillFile) console.log(`    ${DIM(`SKILL.md ${skillFile}`)}`);
      if (resourceRoot) console.log(`    ${DIM(`Root     ${resourceRoot}`)}`);
    }
    console.log();
  } catch (err: any) {
    console.log(ERROR(`✗ ${err.message}`));
    return { success: false };
  }

  return { success: true };
}

function handleSkill(ctx: CommandContext, args: string): CommandResult {
  const trimmed = args.trim();
  const registry = getSkillsRegistry();
  registry.initialize();

  if (!trimmed) {
    const names = registry.getAllSkills().map(skill => skill.name).sort();
    return {
      success: false,
      error: [
        'Usage: /skill <name> <task>',
        `Loaded skills: ${names.join(', ') || 'none'}`,
      ].join('\n'),
    };
  }

  const parsed = parseSkillCommandInput(`/skill ${trimmed}`);
  const rawName = trimmed.split(/\s+/, 1)[0] || '';
  const requestedName = parsed.skillName || normalizeRequestedSkillName(rawName);
  const referencedSkill = loadExplicitSkillReference(`/skill ${trimmed}`, ctx.cwd);
  if (parsed.skillPath && !referencedSkill) {
    return {
      success: false,
      error: `Invalid skill reference: ${parsed.skillPath}`,
    };
  }

  const skill = referencedSkill || registry.getAllSkills()
    .find(candidate => skillActivationNames(candidate)
      .some(name => normalizeRequestedSkillName(name) === requestedName));

  if (!skill) {
    const suggestions = registry.getAllSkills()
      .map(candidate => candidate.name)
      .filter(name => name.includes(requestedName) || requestedName.includes(name))
      .slice(0, 5);
    return {
      success: false,
      error: suggestions.length > 0
        ? `Unknown skill: ${rawName}\nDid you mean: ${suggestions.join(', ')}?`
        : `Unknown skill: ${rawName}`,
    };
  }

  const task = parsed.task;
  const source = registry.getSource(skill.name);
  const resourceRoot = skill.resourceRoot || skill.source || source?.path;
  const skillFile = resourceRoot
    ? `${resourceRoot.replace(/\/SKILL\.md$/i, '')}/SKILL.md`
    : source?.skillFile;

  if (!task) {
    const usageSelector = parsed.skillPath
      ? `[$${skill.name}](${formatSkillReferencePath(parsed.skillPath)})`
      : skill.name;
    return {
      success: true,
      output: [
        parsed.skillPath
          ? `Skill reference ${skill.name} is valid for one turn.`
          : `Skill ${skill.name} is loaded.`,
        skillFile ? `SKILL.md ${skillFile}` : '',
        resourceRoot ? `Root     ${resourceRoot}` : '',
        `Use: /skill ${usageSelector} <task>`,
      ].filter(Boolean).join('\n'),
    };
  }

  return {
    success: true,
    continueAsChat: true,
    chatInput: parsed.skillPath
      ? `/skill [$${skill.name}](${formatSkillReferencePath(parsed.skillPath)}) ${task}`
      : `/skill ${skill.name} ${task}`,
  };
}

function formatSkillReferencePath(path: string): string {
  return /[\s()]/u.test(path) ? `<${path}>` : path;
}

function handleMcp(_ctx: CommandContext): CommandResult {
  console.log();
  console.log(HEADER('MCP Servers'));
  console.log(DIM('─'.repeat(40)));

  const status = mcpManager.getStatus();
  if (status.length === 0) {
    console.log();
    console.log(DIM('  No servers configured. Add to ~/.orion-code/mcp.json'));
    console.log();
    return { success: true };
  }

  console.log();
  for (const s of status) {
    const stateLabel = s.dead
      ? ERROR('dead')
      : s.connected
        ? SUCCESS('connected')
        : WARN('disconnected');
    console.log(`  ${ACCENT(s.name.padEnd(20))} ${stateLabel}  ${DIM(`${s.toolCount} tools`)}`);
  }
  console.log();
  return { success: true };
}

function handleDoctor(ctx: CommandContext): CommandResult {
  const report = collectDoctorReport(ctx);
  console.log();
  console.log(formatDoctorReport(report));
  console.log();
  return { success: !hasDoctorFailures(report) };
}

function handleStorage(_ctx: CommandContext, args: string): CommandResult {
  const trimmed = args.trim();
  const [action = 'doctor'] = trimmed.split(/\s+/);

  if (action === 'cleanup') {
    const dryRun = /\b--dry-run\b/.test(trimmed);
    const result = cleanupStorage({ dryRun });
    console.log();
    console.log(formatStorageCleanupResult(result));
    console.log();
    return { success: true };
  }

  if (action === 'repair') {
    const result = repairProjectMetadata();
    console.log();
    console.log(HEADER('Orion Code Storage Repair'));
    console.log(DIM('─'.repeat(40)));
    console.log(`  Repaired ${ACCENT(String(result.repaired.length))}`);
    console.log(`  Skipped  ${DIM(String(result.skipped.length))}`);
    for (const project of result.repaired.slice(0, 12)) {
      console.log(`  ${SUCCESS('✓')} ${DIM(project)}`);
    }
    if (result.repaired.length > 12) {
      console.log(DIM(`  ... ${result.repaired.length - 12} more`));
    }
    console.log();
    return { success: true };
  }

  if (action !== 'doctor' && action !== 'status') {
    return {
      success: false,
      error: 'Usage: /storage [doctor|status|repair|cleanup --dry-run]',
    };
  }

  const report = collectStorageReport();
  console.log();
  console.log(formatStorageReport(report));
  console.log();
  return { success: true };
}

function handleTarget(ctx: CommandContext, args: string): CommandResult {
  const trimmed = args.trim();
  // GoalCoordinator needs projectPath + sessionId — derive from context
  const projectPath = ctx.cwd ?? process.cwd();
  const sessionId = ctx.sessionId ?? 'default';
  const coordinator = new GoalCoordinator(projectPath, sessionId);

  // /target (no args) — show current goal
  if (!trimmed) {
    const snap = coordinator.snapshot();
    if (!snap) {
      console.log(chalk.gray('No goal is currently set. Use /target <objective> to create one.'));
      return { success: true };
    }
    console.log(chalk.bold('Goal: ') + snap.objective);
    console.log(chalk.gray(`Status: ${snap.status}  |  Continuations: ${snap.continuationCount}`));
    console.log(chalk.gray(`Tokens: ${snap.tokensUsed}  |  Time: ${snap.timeUsedMs}ms`));
    return { success: true };
  }

  // Sub-commands
  const subCommand = trimmed.split(/\s+/)[0].toLowerCase();
  const rest = trimmed.slice(subCommand.length).trim();

  switch (subCommand) {
    case 'pause': {
      const ok = coordinator.pause();
      console.log(ok ? chalk.yellow('Goal paused.') : chalk.red('Cannot pause.'));
      return { success: ok };
    }
    case 'resume': {
      const ok = coordinator.resume();
      console.log(ok ? chalk.green('Goal resumed.') : chalk.red('Cannot resume.'));
      return { success: ok };
    }
    case 'clear': {
      const ok = coordinator.clear();
      console.log(ok ? chalk.gray('Goal cleared.') : chalk.gray('No goal to clear.'));
      return { success: ok };
    }
    case 'status': {
      const snap = coordinator.snapshot();
      if (!snap) { console.log(chalk.gray('No goal set.')); return { success: true }; }
      console.log(chalk.bold(`Status: ${snap.status}`));
      console.log(`Objective: ${snap.objective}`);
      console.log(`Continuations: ${snap.continuationCount}  |  Tokens: ${snap.tokensUsed}`);
      return { success: true };
    }
    case 'edit': {
      if (!rest) { console.log(chalk.red('Usage: /target edit <new objective text>')); return { success: false }; }
      const ok = coordinator.edit(rest);
      console.log(ok ? chalk.green('Goal objective updated.') : chalk.red('Cannot edit.'));
      return { success: ok };
    }
    case 'replace': {
      if (!rest) { console.log(chalk.red('Usage: /target replace <new objective text>')); return { success: false }; }
      const ok = coordinator.replace(rest);
      console.log(ok ? chalk.green('Goal replaced.') : chalk.red('Cannot replace.'));
      return { success: ok };
    }
    default: {
      // Treat as new objective
      const result = coordinator.create(trimmed);
      console.log(result.ok ? chalk.green('Goal created: ') + trimmed : chalk.red(result.error ?? 'Failed'));
      return { success: result.ok };
    }
  }
}

function handleDiff(ctx: CommandContext, args: string): CommandResult {
  const maxFilesMatch = args.match(/--max-files(?:=|\s+)(\d+)/);
  const maxFiles = maxFilesMatch ? Number(maxFilesMatch[1]) : 40;
  const report = collectWorkspaceDiff({ cwd: ctx.cwd, maxFiles });
  console.log();
  console.log(formatWorkspaceDiff(report, { maxFiles }));
  console.log();
  return { success: report.isGitRepo };
}

function handleCommitPlan(ctx: CommandContext, args: string): CommandResult {
  const maxFilesMatch = args.match(/--max-files(?:=|\s+)(\d+)/);
  const maxFiles = maxFilesMatch ? Number(maxFilesMatch[1]) : 20;
  const plan = createCommitPlan({ cwd: ctx.cwd, maxFiles });
  console.log();
  console.log(formatCommitPlan(plan));
  console.log();
  return { success: plan.diff.isGitRepo };
}

function handleTools(ctx: CommandContext): CommandResult {
  const tools = ctx.store.getSnapshot().tools.length > 0
    ? ctx.store.getSnapshot().tools
    : getRuntimeTools();
  const staticTools = tools.filter(tool => !tool.name.startsWith('mcp__'));
  const mcpTools = tools.filter(tool => tool.name.startsWith('mcp__'));

  console.log();
  console.log(HEADER('Available Tools'));
  console.log(DIM('─'.repeat(40)));
  console.log(`  Static tools  ${ACCENT(String(staticTools.length))}`);
  console.log(`  MCP tools     ${ACCENT(String(mcpTools.length))}`);
  console.log();

  const visible = [...staticTools, ...mcpTools].slice(0, 28);
  for (const tool of visible) {
    const label = tool.name.startsWith('mcp__') ? 'mcp' : 'tool';
    console.log(`  ${ACCENT(tool.name)} ${DIM(`[${label}]`)}`);
    console.log(`    ${DIM(tool.description.slice(0, 96))}`);
  }

  if (tools.length > visible.length) {
    console.log();
    console.log(DIM(`  ... ${tools.length - visible.length} more tools hidden`));
  }
  console.log();
  return { success: true };
}

function handleTodos(ctx: CommandContext): CommandResult {
  const todos = ctx.store.getSnapshot().todos;
  console.log();
  console.log(HEADER('Todos'));
  console.log(DIM('─'.repeat(40)));

  if (todos.length === 0) {
    console.log(DIM('  No active todos yet.'));
    console.log();
    return { success: true };
  }

  for (const todo of todos) {
    const marker = todo.status === 'completed' ? SUCCESS('✓')
      : todo.status === 'in_progress' ? WARN('›')
      : DIM('○');
    console.log(`  ${marker} ${todo.content}`);
    if (todo.activeForm && todo.activeForm !== todo.content) {
      console.log(`    ${DIM(todo.activeForm)}`);
    }
  }
  console.log();
  return { success: true };
}

function handleClearHistory(ctx: CommandContext): CommandResult {
  const history = ctx.store.getSnapshot().conversationHistory;

  if (history.length === 0) {
    console.log(DIM('Conversation history is already empty'));
    console.log();
    return { success: true };
  }

  ctx.store.resetConversation();
  resetToolState();
  console.log(SUCCESS(`✔ Cleared ${history.length} messages from conversation history`));
  console.log(DIM('  Configuration and system state preserved'));
  console.log();
  return { success: true };
}

async function handleCompact(ctx: CommandContext, args: string): Promise<CommandResult> {
  const history = ctx.store.getSnapshot().conversationHistory;

  if (history.length === 0) {
    console.log(DIM('Conversation history is empty, nothing to compact'));
    console.log();
    return { success: true };
  }

  // 解析参数
  const thresholdArg = parseInt(args.trim(), 10);
  const threshold = thresholdArg > 0 ? thresholdArg : 50;

  console.log();
  console.log(HEADER('Compacting Conversation'));
  console.log(DIM('─'.repeat(40)));
  console.log(`  Current messages: ${history.length}`);
  console.log(`  Threshold: ${threshold}`);
  console.log();

  if (history.length <= threshold) {
    console.log(DIM(`Conversation has ${history.length} messages, below compact threshold ${threshold}.`));
    console.log(DIM('Nothing compacted.'));
    console.log();
    return { success: true };
  }

  console.log(DIM(compactStatus()));
  try {
    const modelId = ctx.llm?.getModel() ?? ctx.store.getSnapshot().currentModel;
    const coordinator = ctx.compactCoordinator ?? new CompactCoordinator({
      modelId,
      llm: ctx.llm,
      outputReserveTokens: ctx.llm?.getMaxTokens?.(),
      getContextCapsule: () => ctx.store.getSnapshot().harnessState?.capsule,
      getHarnessState: () => ctx.store.getSnapshot().harnessState,
    });
    coordinator.configure({
      modelId,
      llm: ctx.llm,
      outputReserveTokens: ctx.llm?.getMaxTokens?.(),
      getContextCapsule: () => ctx.store.getSnapshot().harnessState?.capsule,
      getHarnessState: () => ctx.store.getSnapshot().harnessState,
    });
    const beforeTokens = estimateMessagesTokens(history);
    const automaticStats = coordinator.getAutomatic().getStats();
    const beforeUsage = createContextUsageSnapshot({
      modelId,
      usedTokens: beforeTokens,
      source: 'estimated',
      outputReserveTokens: ctx.llm?.getMaxTokens?.(),
      warningThreshold: automaticStats.preCompactThreshold,
      autoCompactThreshold: automaticStats.threshold,
      autoCompactEnabled: automaticStats.enabled,
    });
    const result = await coordinator.compactManual(history, threshold);
    const compacted = result.messages;
    const compactedTokens = estimateMessagesTokens(compacted);
    const afterUsage = createContextUsageSnapshot({
      modelId,
      usedTokens: compactedTokens,
      source: 'estimated',
      outputReserveTokens: ctx.llm?.getMaxTokens?.(),
      warningThreshold: automaticStats.preCompactThreshold,
      autoCompactThreshold: automaticStats.threshold,
      autoCompactEnabled: automaticStats.enabled,
    });

    const reduction = history.length - compacted.length;
    const percent = Math.round((reduction / history.length) * 100);
    const sessionId = ctx.getSession?.()?.id ?? ctx.sessionId;
    if (sessionId) {
      const sourceMessageCount = readSessionMessages(sessionId).length;
      const checkpoint = commitSessionCompactCheckpoint({
        sessionId,
        mode: 'manual',
        modelId,
        sourceMessageCount,
        transcriptStartMessageIndex: Math.max(0, sourceMessageCount - threshold),
        modelHistory: compacted,
        summary: {
          text: result.summary,
          generatedAt: result.summaryGeneratedAt,
          source: result.summarySource,
        },
        beforeUsage,
        afterUsage,
      });
      ctx.store.setState({ conversationHistory: checkpoint.modelHistory });
    } else {
      ctx.store.setState({ conversationHistory: compacted });
    }
    ctx.store.setContextUsage(afterUsage);

    console.log(SUCCESS(`✔ Compacted ${history.length} → ${compacted.length} messages`));
    console.log(DIM(`  Reduced by ${reduction} messages (${percent}%)`));
    console.log();
    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(ERROR(`✗ Compact failed: ${message}`));
    console.log();
    return { success: false };
  }
}

function handleUsage(ctx: CommandContext): CommandResult {
  console.log();
  console.log(HEADER('Usage Statistics'));
  console.log(DIM('─'.repeat(40)));

  const snapshot = ctx.store.getSnapshot();
  const usage = snapshot.tokenUsage;
  const history = snapshot.conversationHistory;

  console.log();

  // Token usage
  console.log(HEADER('  Tokens:'));
  if (usage) {
    console.log(`    Input       ${ACCENT(usage.promptTokens.toLocaleString())}`);
    console.log(`    Output      ${ACCENT(usage.completionTokens.toLocaleString())}`);
    const total = usage.promptTokens + usage.completionTokens;
    console.log(`    Total       ${DIM(total.toLocaleString())}`);
    const ratio = usage.completionTokens / usage.promptTokens;
    console.log(`    Ratio       ${DIM(ratio.toFixed(2))} (output/input)`);
  } else {
    console.log(DIM('    No token usage recorded'));
  }

  console.log();

  // Conversation stats
  console.log(HEADER('  Conversation:'));
  console.log(`    Messages    ${DIM(history.length.toString())}`);
  console.log(`    Turns       ${DIM(Math.floor(history.length / 2).toString())}`);

  // Count by role
  const byRole = { user: 0, assistant: 0, system: 0, tool: 0 };
  for (const msg of history) {
    byRole[msg.role] = (byRole[msg.role] || 0) + 1;
  }
  console.log(`    User msgs   ${DIM(byRole.user.toString())}`);
  console.log(`    Assistant   ${DIM(byRole.assistant.toString())}`);

  console.log();

  // Model info
  console.log(HEADER('  Model:'));
  console.log(`    Current     ${BRAND(snapshot.currentModel)}`);
  if (ctx.llm) {
    console.log(`    Active      ${ACCENT(ctx.llm.getModel())}`);
  }

  console.log();
  return { success: true };
}

// ============================================================================
// Session 命令
// ============================================================================

function parseSessionScopeArgs(args: string, cwd: string): { allProjects: boolean; projectPath: string; query: string; last: boolean } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  let allProjects = false;
  let last = false;
  let projectPath = resolveProjectPath(cwd);
  const queryParts: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === '--all' || part === '-a') {
      allProjects = true;
      continue;
    }
    if (part === '--last' || part === '-l') {
      last = true;
      continue;
    }
    if ((part === '--project' || part === '-p') && parts[i + 1]) {
      projectPath = resolveProjectPath(parts[i + 1]);
      i++;
      continue;
    }
    queryParts.push(part);
  }

  return {
    allProjects,
    projectPath,
    last,
    query: queryParts.join(' '),
  };
}

function sessionTitle(session: SessionMeta): string {
  return session.name || session.taskSummary || '(untitled)';
}

function truncateText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 3) + '...' : text;
}

function printSessionRows(sessions: SessionMeta[], options: { showProject?: boolean; indexed?: boolean; showIndexSummary?: boolean } = {}): void {
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    const startTime = new Date(session.startTime).toLocaleString();
    const updatedTime = new Date(session.updatedAt ?? session.startTime).toLocaleString();
    const duration = session.endTime
      ? Math.round((session.endTime - session.startTime) / 1000) + 's'
      : 'active';
    const status = session.endTime ? DIM('completed') : ACCENT('active');
    const index = options.indexed ? `${String(i + 1).padStart(2, ' ')}. ` : '  ';
    const name = session.name ? ` ${ACCENT(`"${session.name}"`)}` : '';

    console.log(`${index}${status} ${BRAND(session.id.slice(0, 8))}${name} ${DIM(session.model)}`);
    console.log(`    ${truncateText(sessionTitle(session), 96)}`);
    console.log(`    ${DIM(`Started: ${startTime}`)} ${DIM(`Updated: ${updatedTime}`)} ${DIM(`Duration: ${duration}`)}`);
    console.log(`    ${DIM(`Messages: ${session.messageCount ?? 0}`)} ${DIM(`Size: ${formatBytes(session.historySizeBytes ?? 0)}`)} ${DIM(`Tokens: ${session.tokenCount}`)} ${DIM(`Cost: $${session.cost.toFixed(4)}`)}`);
    if (options.showIndexSummary) {
      const indexSummary = loadSessionIndex(session.id, session.projectPath);
      if (indexSummary) {
        const toolCount = Object.values(indexSummary.tools).reduce((total, count) => total + count, 0);
        console.log(`    ${DIM(`Index: ${indexSummary.files.length} files, ${toolCount} tool calls, ${indexSummary.topics.length} topics`)}`);
      } else {
        console.log(`    ${DIM('Index: not built')}`);
      }
    }
    if (options.showProject) {
      console.log(`    ${DIM(`Project: ${session.projectPath}`)}`);
    }
    console.log();
  }
}

function parsePickerIndex(ref: string, max: number): number | null {
  const trimmed = ref.trim();
  const match = trimmed.match(/^#?(\d+)$/);
  if (!match) return null;

  const index = Number(match[1]);
  if (!Number.isInteger(index) || index < 1 || index > max) return null;
  return index - 1;
}

function printSessionConflict(ref: string, matches: SessionMeta[]): void {
  console.log(ERROR(`Session reference is ambiguous: ${ref}`));
  console.log(DIM('Use a longer id prefix, exact session name, or pick one of these:'));
  console.log();
  printSessionRows(matches.slice(0, 10), { indexed: true, showProject: true });
  console.log(DIM('Example: /resume <longer-session-id>'));
  console.log();
}

function printSessionPicker(sessions: SessionMeta[], options: { title: string; showProject?: boolean; moreCount?: number }): void {
  console.log(HEADER(options.title));
  console.log(DIM('─'.repeat(Math.min(process.stdout.columns || 80, 96))));
  printSessionRows(sessions, { indexed: true, showProject: options.showProject });
  if (options.moreCount && options.moreCount > 0) {
    console.log(DIM(`... ${options.moreCount} more sessions. Use /sessions to list them, or /resume <session-id>.`));
  }
  console.log(DIM('Use /resume <number|session-id|name> or /resume --last.'));
}

function handleSessions(ctx: CommandContext, args: string = ''): CommandResult {
  const scope = parseSessionScopeArgs(args, ctx.cwd);
  const query = scope.query?.trim();

  // If there's a search query, use the session index
  if (query && !query.startsWith('--')) {
    const allSessions = scope.allProjects
      ? listSessions()
      : listProjectSessions(scope.projectPath);
    const matchedIds = searchSessions(query, allSessions.map(session => ({
      id: session.id,
      projectPath: session.projectPath,
    })));

    if (matchedIds.length === 0) {
      console.log();
      console.log(HEADER(`Sessions (search: "${query}")`));
      console.log(DIM('─'.repeat(40)));
      console.log(DIM('  No matching sessions found'));
      console.log();
      console.log(DIM('Tip: search by file path, tool name, or topic keyword'));
      console.log();
      return { success: true };
    }

    // Rebuild session list in matched order
    const sessionMap = new Map(allSessions.map(s => [s.id, s]));
    const matchedSessions = matchedIds.map(id => sessionMap.get(id)).filter(Boolean) as SessionMeta[];

    console.log();
    console.log(HEADER(`Sessions (search: "${query}") — ${matchedSessions.length} matches`));
    console.log(DIM('─'.repeat(40)));
    console.log();
    printSessionRows(matchedSessions, { indexed: true, showProject: scope.allProjects, showIndexSummary: true });
    console.log();
    console.log(DIM(`Searched ${allSessions.length} sessions, found ${matchedSessions.length} matches`));
    console.log(DIM('Use /resume <number|session-id|name> to restore a session'));
    console.log();
    return { success: true };
  }

  console.log();
  console.log(HEADER(scope.allProjects ? 'Sessions (all projects)' : 'Sessions'));
  console.log(DIM('─'.repeat(40)));

  const sessions = scope.allProjects
    ? listSessions(10)
    : listProjectSessions(scope.projectPath, 10);

  if (sessions.length === 0) {
    console.log(DIM(scope.allProjects ? '  No sessions found' : '  No sessions found for this project'));
    console.log();
    return { success: true };
  }

  console.log();
  printSessionRows(sessions, { indexed: true, showProject: scope.allProjects });

  console.log(DIM('Use /resume <number|session-id|name> to restore a session'));
  console.log(DIM('Use /session-rename <number|session-id|name> <new name> to rename'));
  console.log(DIM('Use /sessions --all to list sessions from every project'));
  console.log(DIM('Use /sessions <query> to search by file, tool, or keyword'));
  console.log();
  return { success: true };
}

function handleResume(ctx: CommandContext, args: string): CommandResult {
  const ui = commandUICapabilities(ctx);
  const scope = parseSessionScopeArgs(args, ctx.cwd);
  const sessionRef = scope.query;
  const scopedSessions = (scope.allProjects ? listSessions() : listProjectSessions(scope.projectPath))
    .filter(session => (session.messageCount ?? 0) > 0);

  if (!sessionRef) {
    const lastSession = scopedSessions[0];
    if (!lastSession) {
      console.log(ERROR('No previous session found for this project'));
      console.log(DIM('Use /sessions --all to list all sessions'));
      console.log();
      return { success: false };
    }

    if (scope.last || scopedSessions.length === 1) {
      return restoreSession(ctx, lastSession, true);
    }

    const picker = {
      title: scope.allProjects ? 'Pick a Session (all projects)' : 'Pick a Session',
      showProject: scope.allProjects,
      moreCount: 0,
      sessions: scopedSessions,
      allProjects: scope.allProjects,
      maxVisibleItems: 10,
    };

    if (ui.structuredPickers) {
      return { success: true, sessionPicker: picker };
    }

    const visibleSessions = scopedSessions.slice(0, 10);
    console.log();
    printSessionPicker(visibleSessions, {
      title: picker.title,
      showProject: picker.showProject,
      moreCount: Math.max(0, scopedSessions.length - visibleSessions.length),
    });
    console.log();
    return { success: true };
  }

  const pickerIndex = parsePickerIndex(sessionRef, scopedSessions.length);
  if (pickerIndex !== null) {
    return restoreSession(ctx, scopedSessions[pickerIndex], false);
  }

  // Resume specific session
  const result = lookupSessionRef(sessionRef, scope.projectPath, { allProjects: scope.allProjects });

  if (result.status === 'ambiguous') {
    printSessionConflict(sessionRef, result.matches);
    return { success: false };
  }

  if (result.status === 'not_found') {
    console.log(ERROR(`Session not found: ${sessionRef}`));
    console.log(DIM(scope.allProjects ? 'Use /sessions --all to list sessions' : 'Use /sessions to list project sessions, or /resume <id> --all'));
    console.log();
    return { success: false };
  }

  return restoreSession(ctx, result.session, false);
}

function restoreSession(ctx: CommandContext, session: SessionMeta, isLast: boolean): CommandResult {
  const resumed = resumeSession(session.id) ?? session;

  // Swap in the resumed session's transcript BEFORE emitting any command output,
  // so the output is appended after the history rather than wiped by the
  // transcript replacement below.
  ctx.setSession?.(resumed);

  // Load history and notify runtime/TUI consumers.
  const history = loadSessionHistory(resumed.id);
  const transcriptMessages = loadSessionTranscriptMessages(resumed.id);
  const rawMessages = readSessionMessages(resumed.id);
  const checkpoint = loadSessionCompactCheckpoint(resumed.id);
  const resumeGeneratedAt = Date.now();
  const summary = checkpoint?.summary.text ?? (history.length > 0 ? generateHistorySummary(history) : '');
  const summaryGeneratedAt = checkpoint?.summary.generatedAt ?? resumeGeneratedAt;
  const summarySource = checkpoint?.summary.source ?? 'resume_heuristic';
  const summaryCoveredMessages = checkpoint?.summary.sourceMessageCount ?? rawMessages.length;
  if (history.length > 0) {
    const eventSummary = checkpoint?.summary.text ?? generateRestoredSessionEventSummary(history);
    ctx.store.setState({ conversationHistory: history });
    ctx.store.setState({ harnessState: loadSessionHarnessState(resumed.id) ?? resumed.harnessState });
    resetToolState();
    ctx.sessionRestored?.({
      sessionId: resumed.id,
      projectPath: resumed.projectPath,
      model: resumed.model,
      restoredMessages: history.length,
      messageCount: resumed.messageCount,
      summary: eventSummary,
      summaryGeneratedAt,
      summarySource,
      summaryCoveredMessages,
      checkpointId: checkpoint?.checkpointId,
      transcriptMessages: transcriptMessages.length,
    });
  } else {
    ctx.sessionRestored?.({
      sessionId: resumed.id,
      projectPath: resumed.projectPath,
      model: resumed.model,
      restoredMessages: 0,
      messageCount: resumed.messageCount,
      summaryGeneratedAt,
      summarySource,
      summaryCoveredMessages,
      checkpointId: checkpoint?.checkpointId,
      transcriptMessages: transcriptMessages.length,
    });
  }

  // Emit the resume summary. In TUI (inline-surface) mode, route through the
  // command-output sink instead of raw console.log: a bare console.log writes
  // directly to stdout and desyncs the surface's cursor tracking, leaving the
  // live region mis-positioned (blank lower screen, content stuck at top).
  // Plain text is used so no raw ANSI escapes leak into the TUI frame.
  const bannerLines: string[] = [
    isLast ? 'Resuming last session' : `Resuming session ${resumed.id.slice(0, 8)}`,
    `  ID: ${resumed.id}`,
    `  Model: ${resumed.model}`,
    `  Project: ${resumed.projectPath}`,
    `  Started: ${new Date(resumed.startTime).toLocaleString()}`,
  ];
  if (history.length > 0) {
    bannerLines.push(`  Summary: ${summary}`);
    bannerLines.push(
      `  Generated: ${new Date(summaryGeneratedAt).toLocaleString()} (${checkpoint ? 'compact checkpoint' : 'generated on resume'})`
    );
    bannerLines.push(`  Covers: ${summaryCoveredMessages} source messages`);
    bannerLines.push(
      `✔ Restored ${history.length} model-context messages / ${transcriptMessages.length} transcript messages`
    );
  } else {
    bannerLines.push('  No messages in session');
  }

  if (ctx.uiRenderer === 'tui' || ctx.uiRenderer === 'ink') {
    if (!ctx.sessionRestored) {
      for (const line of bannerLines) ctx.writeLine?.(line);
    }
  } else {
    console.log();
    console.log(HEADER(bannerLines[0]));
    for (const line of bannerLines.slice(1)) {
      console.log(line.startsWith('✔') ? SUCCESS(line) : DIM(line));
    }
    console.log();
  }

  return { success: true };
}

function handleSessionRename(ctx: CommandContext, args: string): CommandResult {
  const scope = parseSessionScopeArgs(args, ctx.cwd);
  const parts = scope.query.split(/\s+/).filter(Boolean);
  const ref = parts.shift();
  const newName = parts.join(' ').trim();

  if (!ref || !newName) {
    console.log(ERROR('Usage: /session-rename <number|session-id|name> <new name>'));
    console.log(DIM('Run /sessions first to see picker numbers for this project.'));
    console.log();
    return { success: false };
  }

  const scopedSessions = scope.allProjects ? listSessions() : listProjectSessions(scope.projectPath);
  const pickerIndex = parsePickerIndex(ref, scopedSessions.length);
  let session: SessionMeta | null = pickerIndex !== null ? scopedSessions[pickerIndex] : null;

  if (!session) {
    const result = lookupSessionRef(ref, scope.projectPath, { allProjects: scope.allProjects });
    if (result.status === 'ambiguous') {
      printSessionConflict(ref, result.matches);
      return { success: false };
    }
    if (result.status === 'not_found') {
      console.log(ERROR(`Session not found: ${ref}`));
      console.log(DIM(scope.allProjects ? 'Use /sessions --all to list sessions' : 'Use /sessions to list project sessions'));
      console.log();
      return { success: false };
    }
    session = result.session;
  }

  const duplicate = scopedSessions.find(s => s.id !== session!.id && s.name === newName);
  const renamed = renameSession(session.id, newName);
  if (!renamed) {
    console.log(ERROR(`Session not found: ${ref}`));
    console.log();
    return { success: false };
  }

  if (ctx.getSession?.()?.id === renamed.id) {
    ctx.setSession?.(renamed);
  }

  console.log();
  console.log(SUCCESS(`✔ Renamed session ${renamed.id.slice(0, 8)} to "${newName}"`));
  if (duplicate) {
    console.log(WARN(`  Name already exists on ${duplicate.id.slice(0, 8)}; /resume "${newName}" will be ambiguous.`));
  }
  console.log();
  return { success: true };
}

async function handleEditPreview(ctx: CommandContext): Promise<CommandResult> {
  const lastEdit = getToolState().lastEditFileArgs;

  if (!lastEdit) {
    console.log(ERROR('No previous edit_file call found for preview'));
    console.log(DIM('Run an edit_file tool call first, then use /edit-preview to inspect the match candidates.'));
    console.log();
    return { success: false };
  }

  const hasMetadata = Boolean(lastEdit.sessionId || lastEdit.turnId);
  if (!hasMetadata) {
    console.log(WARN('Using legacy edit-preview state without session/turn tags. Running preview as best-effort.'));
  }

  const staleBySession = Boolean(lastEdit.sessionId && ctx.sessionId && lastEdit.sessionId !== ctx.sessionId);
  const staleByTurn = Boolean(lastEdit.turnId != null && ctx.turnId != null && String(lastEdit.turnId) !== String(ctx.turnId));
  if (staleBySession || staleByTurn) {
    const mismatch = [];
    if (staleBySession) mismatch.push(`session ${lastEdit.sessionId} vs ${ctx.sessionId}`);
    if (staleByTurn) mismatch.push(`turn ${String(lastEdit.turnId)} vs ${String(ctx.turnId)}`);
    console.log(ERROR('Edit preview target does not match current context.'));
    console.log(DIM(`Stale edit target: ${mismatch.join(', ')}.`));
    console.log();
    return { success: false };
  }

  if (hasMetadata && !(ctx.sessionId || ctx.turnId)) {
    console.log(WARN('Edit preview context is available, but current command context is missing session/turn metadata.'));
    console.log(DIM('Preview is allowed, but stale checks cannot be fully validated.'));
  }

  const rawResult = await executeTool('edit_file', {
    ...lastEdit,
    preview: true,
  }, ctx.abortSignal, {
    cwd: ctx.cwd,
    config: {
      name: ctx.config.name,
      mode: ctx.config.mode,
    },
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
  });

  let parsed: { success?: boolean; output?: string; error?: string; metadata?: { candidates?: unknown[] } };
  try {
    parsed = JSON.parse(rawResult);
  } catch {
    parsed = { success: false, error: rawResult };
  }

  console.log();
  console.log(HEADER('Edit Preview'));
  console.log(DIM('─'.repeat(40)));
  if (parsed.success) {
    console.log(parsed.output || DIM('No preview output'));
  } else {
    console.log(ERROR(parsed.error || 'Preview failed'));
  }
  console.log();

  // Return structured data for terminal/TUI/Ink picker rendering.
  if (parsed.success && parsed.metadata?.candidates && Array.isArray(parsed.metadata.candidates)) {
    return {
      success: true,
      editPreview: {
        path: lastEdit.path as string,
        newString: lastEdit.new_string as string,
        kind: (lastEdit.fuzzy_match ? 'fuzzy' : 'exact') as 'exact' | 'fuzzy',
        candidates: parsed.metadata.candidates as Array<{ index: number; line: number; match: string; contextBefore: string; contextAfter: string; isReplaceAll: boolean }>,
      },
    };
  }

  return { success: parsed.success === true };
}

/** Generate a brief summary of conversation history */
function truncateRedactedSummary(text: string, maxLength: number): string {
  const redacted = redactTraceText(text);
  if (redacted.length <= maxLength) return redacted;

  let truncated = redacted.slice(0, maxLength);
  for (const marker of ['[REDACTED_SECRET]']) {
    const markerStart = truncated.indexOf(marker.slice(0, 6));
    if (markerStart >= 0 && !truncated.includes(marker)) {
      truncated = `${truncated.slice(0, markerStart)}${marker}`;
      break;
    }
  }
  return `${truncated}...`;
}

function generateHistorySummary(messages: Message[]): string {
  const userMsgs = messages.filter(m => m.role === 'user' && m.content);
  const assistantMsgsWithTools = messages.filter(m => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0);

  // Extract topics from first few user messages
  const topics = userMsgs.slice(0, 3).map(m => {
    return truncateRedactedSummary(m.content || '', 40);
  });

  // Extract tools used
  const toolsUsed = assistantMsgsWithTools.flatMap(m =>
    m.tool_calls?.map(tc => tc.function.name) || []
  );
  const uniqueTools = [...new Set(toolsUsed)];

  // Build summary
  const parts: string[] = [];

  if (topics.length > 0) {
    parts.push(`Topics: ${topics.join('; ')}`);
  }

  if (uniqueTools.length > 0) {
    parts.push(`Tools: ${uniqueTools.join(', ')}`);
  }

  if (parts.length === 0) {
    return 'No significant activity';
  }

  return parts.join('. ');
}

function generateRestoredSessionEventSummary(messages: Message[]): string | undefined {
  const assistantMsgsWithTools = messages.filter(m =>
    m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0
  );
  const toolsUsed = assistantMsgsWithTools.flatMap(m =>
    m.tool_calls?.map(tc => tc.function.name) || []
  );
  const uniqueTools = [...new Set(toolsUsed)].slice(0, 8);

  if (uniqueTools.length === 0) return undefined;
  return `Tools: ${uniqueTools.join(', ')}`;
}

function continueAsSlashChat(name: string, args: string): CommandResult {
  const trimmed = args.trim();
  return {
    success: true,
    continueAsChat: true,
    chatInput: `/${name}${trimmed ? ` ${trimmed}` : ''}`,
  };
}

// ============================================================================
// 命令注册表
// ============================================================================

const COMMANDS: SlashCommand[] = [
  // Coding workflows
  {
    name: 'target',
    description: 'Create, view, pause, resume, or clear a persistent goal target',
    argumentHint: '[objective | pause | resume | clear | status | edit <text>]',
    category: 'workflow',
    priority: 3,
    type: 'builtin',
    execute: (ctx, args) => handleTarget(ctx, args),
  },
  {
    name: 'goal',
    description: 'Alias for /target — manage a persistent goal target',
    argumentHint: '[objective | pause | resume | clear | status | edit <text>]',
    category: 'workflow',
    priority: 2,
    type: 'builtin',
    execute: (ctx, args) => handleTarget(ctx, args),
  },
  {
    name: 'diff',
    description: 'Summarize current git workspace changes and touched files',
    argumentHint: '[--max-files N]',
    category: 'workflow',
    priority: 5,
    type: 'builtin',
    execute: (ctx, args) => handleDiff(ctx, args),
  },
  {
    name: 'commit',
    description: 'Create a read-only commit plan and suggested message for current changes',
    argumentHint: '[--max-files N]',
    category: 'workflow',
    priority: 8,
    type: 'builtin',
    execute: (ctx, args) => handleCommitPlan(ctx, args),
  },
  {
    name: 'review',
    description: 'Review the current change or requested files',
    argumentHint: '[scope]',
    category: 'workflow',
    priority: 10,
    type: 'chat',
    execute: (_ctx, args) => continueAsSlashChat('review', args),
  },
  {
    name: 'security',
    aliases: ['audit'],
    description: 'Review code or dependencies for security risks',
    argumentHint: '[scope]',
    category: 'workflow',
    priority: 20,
    type: 'chat',
    execute: (_ctx, args) => continueAsSlashChat('security', args),
  },
  {
    name: 'test-gen',
    aliases: ['tests'],
    description: 'Generate or improve tests for a target area',
    argumentHint: '[scope]',
    category: 'workflow',
    priority: 30,
    type: 'chat',
    execute: (_ctx, args) => continueAsSlashChat('test-gen', args),
  },
  {
    name: 'todos',
    aliases: ['todo'],
    description: 'Show current agent todo state',
    category: 'workflow',
    priority: 40,
    type: 'builtin',
    execute: (ctx) => handleTodos(ctx),
  },

  // Sessions and context lifecycle
  {
    name: 'resume',
    description: 'Resume a previous session',
    argumentHint: '[number|session-id|name]',
    category: 'session',
    priority: 10,
    type: 'builtin',
    execute: (ctx, args) => handleResume(ctx, args),
  },
  {
    name: 'sessions',
    description: 'List recent sessions, or search by file/tool/keyword',
    argumentHint: '[<query>|--all]',
    category: 'session',
    priority: 20,
    type: 'builtin',
    execute: (ctx, args) => handleSessions(ctx, args),
  },
  {
    name: 'session-rename',
    aliases: ['rename-session'],
    description: 'Rename a saved session',
    argumentHint: '<number|session-id|name> <new name>',
    category: 'session',
    priority: 30,
    type: 'builtin',
    execute: (ctx, args) => handleSessionRename(ctx, args),
  },
  {
    name: 'compact',
    description: 'Compact conversation history to reduce context size',
    argumentHint: '[threshold]',
    category: 'session',
    priority: 40,
    type: 'builtin',
    execute: (ctx, args) => handleCompact(ctx, args),
  },
  {
    name: 'clear-history',
    aliases: ['reset'],
    description: 'Clear conversation history (keep config)',
    category: 'session',
    priority: 50,
    type: 'builtin',
    execute: (ctx) => handleClearHistory(ctx),
  },

  // Harness, memory, and skills
  {
    name: 'harness',
    description: 'Show Context Harness state, or `/harness explain` for prompt assembly details',
    argumentHint: '[explain]',
    category: 'context',
    priority: 10,
    type: 'builtin',
    execute: (ctx, args) => showHarness(ctx, args),
  },
  {
    name: 'skills',
    description: 'List loaded skills (built-in / user / project)',
    category: 'context',
    priority: 20,
    type: 'builtin',
    execute: (ctx) => handleSkills(ctx),
  },
  {
    name: 'skill',
    aliases: ['use-skill', 'activate-skill'],
    description: 'Activate a loaded skill for one chat turn',
    argumentHint: '<name> <task>',
    category: 'context',
    priority: 21,
    type: 'chat',
    execute: (ctx, args) => handleSkill(ctx, args),
  },
  {
    name: 'memory',
    description: 'Show memory status, or `/memory reindex` to rebuild semantic index',
    argumentHint: '[reindex]',
    category: 'context',
    priority: 30,
    type: 'builtin',
    execute: (ctx, args) => handleMemory(ctx, args),
  },

  // Tools and safety
  {
    name: 'tools',
    aliases: ['tool'],
    description: 'List available built-in and MCP tools',
    category: 'tools',
    priority: 10,
    type: 'builtin',
    execute: (ctx) => handleTools(ctx),
  },
  {
    name: 'edit-preview',
    description: 'Preview the last edit_file match candidates without writing',
    category: 'tools',
    priority: 15,
    type: 'builtin',
    execute: (ctx) => handleEditPreview(ctx),
  },
  {
    name: 'mcp',
    description: 'Show connected MCP servers and their status',
    category: 'tools',
    priority: 20,
    type: 'builtin',
    execute: (ctx) => handleMcp(ctx),
  },
  {
    name: 'safety',
    description: 'Show safety checker status and audit summary',
    category: 'tools',
    priority: 30,
    type: 'builtin',
    execute: (ctx) => showSafety(ctx),
  },

  // Model and runtime configuration
  {
    name: 'model',
    description: 'Show or change the current model',
    argumentHint: '[model|list|help]',
    category: 'model',
    priority: 10,
    type: 'builtin',
    execute: (ctx, args) => handleModel(ctx, args),
  },
  {
    name: 'mode',
    aliases: ['permissions', 'perm'],
    description: 'Show or change tool permission mode',
    argumentHint: '[default|accept-edits|plan|auto|next]',
    category: 'model',
    priority: 20,
    type: 'builtin',
    execute: (ctx, args) => handleMode(ctx, args),
  },
  {
    name: 'config',
    description: 'Show current configuration',
    category: 'model',
    priority: 30,
    type: 'builtin',
    execute: (ctx) => showConfig(ctx),
  },

  // System commands
  {
    name: 'help',
    aliases: ['h'],
    description: 'Show available commands',
    category: 'system',
    priority: 10,
    type: 'builtin',
    execute: () => showHelp(),
  },
  {
    name: 'status',
    aliases: ['s'],
    description: 'Show system status overview',
    category: 'system',
    priority: 20,
    type: 'builtin',
    execute: (ctx) => showStatus(ctx),
  },
  {
    name: 'clear',
    description: 'Clear the terminal screen',
    category: 'system',
    priority: 30,
    type: 'builtin',
    execute: () => {
      process.stdout.write('\x1Bc');
      return { success: true };
    },
  },
  {
    name: 'exit',
    aliases: ['quit', 'q'],
    description: 'Shutdown and exit',
    category: 'system',
    priority: 40,
    type: 'builtin',
    execute: (ctx) => handleExit(ctx),
  },

  // Diagnostics
  {
    name: 'doctor',
    aliases: ['diag', 'diagnose'],
    description: 'Run configuration, tools, MCP, skills, session, and harness diagnostics',
    category: 'diagnostics',
    priority: 5,
    type: 'builtin',
    execute: (ctx) => handleDoctor(ctx),
  },
  {
    name: 'storage',
    description: 'Inspect, repair, or clean Orion Code storage layout',
    argumentHint: '[doctor|repair|cleanup --dry-run]',
    category: 'diagnostics',
    priority: 8,
    type: 'builtin',
    execute: (ctx, args) => handleStorage(ctx, args),
  },
  {
    name: 'usage',
    aliases: ['stats'],
    description: 'Show detailed usage statistics',
    category: 'diagnostics',
    priority: 10,
    type: 'builtin',
    execute: (ctx) => handleUsage(ctx),
  },
  {
    name: 'loop-stats',
    aliases: ['loop'],
    description: 'Show detailed agent-loop budget and efficiency diagnostics',
    category: 'diagnostics',
    priority: 12,
    type: 'builtin',
    execute: (ctx) => handleLoopStats(ctx),
  },
  {
    name: 'trace',
    description: 'Show structured event timeline for the latest or selected turn',
    argumentHint: '[latest|turn-id]',
    category: 'diagnostics',
    priority: 14,
    type: 'builtin',
    execute: (ctx, args) => handleTrace(ctx, args),
  },
  {
    name: 'last-tool',
    aliases: ['tool-last'],
    description: 'Show the latest tool call/result with full inspection hints',
    category: 'diagnostics',
    priority: 15,
    type: 'builtin',
    execute: (ctx, args) => handleLastTool(ctx, args),
  },
  {
    name: 'artifacts',
    aliases: ['artifact'],
    description: 'List or inspect saved full tool outputs for this project',
    argumentHint: '[show <id|prefix> --full]',
    category: 'diagnostics',
    priority: 16,
    type: 'builtin',
    execute: (ctx, args) => handleArtifacts(ctx, args),
  },
  {
    name: 'checkpoint',
    aliases: ['checkpoints'],
    description: 'List or restore file checkpoints created before agent edits',
    argumentHint: '[list|restore <turn-id|prefix> --yes]',
    category: 'diagnostics',
    priority: 18,
    type: 'builtin',
    execute: (ctx, args) => handleCheckpoint(ctx, args),
  },
  {
    name: 'cost',
    description: 'Show session token usage',
    category: 'diagnostics',
    priority: 20,
    type: 'builtin',
    execute: (ctx) => handleCost(ctx),
  },
  {
    name: 'agents',
    description: 'List registered agents and their status',
    category: 'diagnostics',
    priority: 30,
    type: 'builtin',
    execute: (ctx) => showAgents(ctx),
  },
  {
    name: 'migrate',
    description: 'Migrate data from OpenHorse to Orion Code',
    argumentHint: 'openhorse [--dry-run] [--include-env] [--include-project-files]',
    category: 'diagnostics',
    priority: 32,
    type: 'builtin',
    execute: (ctx, args) => handleMigrateCommand(ctx, args),
  },

  // Legacy commands kept executable for compatibility, but not shown in Ink help/palette.
  {
    name: 'task',
    description: 'Submit or list tasks',
    params: [{ name: 'action', description: 'list | <task-name>', required: false }],
    category: 'legacy',
    type: 'builtin',
    isHidden: true,
    execute: (ctx, args) => handleTask(ctx, args),
  },
  {
    name: 'run',
    description: 'Create and run a task through Agent + LLM',
    params: [{ name: 'description', description: 'Task description', required: true }],
    category: 'legacy',
    type: 'builtin',
    isHidden: true,
    execute: (ctx, args) => handleRun(ctx, args),
  },
  {
    name: 'chat',
    description: 'Send a message to the LLM',
    params: [{ name: 'message', description: 'Message to send', required: true }],
    category: 'legacy',
    type: 'chat',
    isHidden: true,
    execute: (ctx, args) => ({ success: true, continueAsChat: true, chatInput: args }),
  },
];

// ============================================================================
// 导出
// ============================================================================

export function getCommands(): SlashCommand[] {
  return sortCommands(COMMANDS);
}

export function getVisibleCommands(): SlashCommand[] {
  return sortCommands(COMMANDS.filter(command => !command.isHidden));
}

export function findCommand(name: string): SlashCommand | undefined {
  return COMMANDS.find(c => c.name === name || c.aliases?.includes(name));
}

export function getCommandNames(): string[] {
  return getVisibleCommands().map(c => c.name);
}

export { handleChat as executeChat };
