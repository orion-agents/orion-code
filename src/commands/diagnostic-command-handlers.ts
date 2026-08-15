/** Handler implementations for the diagnostic-command-handlers boundary. */

import chalk from 'chalk';
import { type CommandContext, type CommandResult } from './types';
import { formatBytes } from '../services/format';
import { type LoopStats } from '../framework';
import {
  loadSessionMeta,
  readSessionTraceEvents,
  redactTraceText,
  type SessionTraceEvent,
} from '../services/session-storage';
import { collectDoctorReport, formatDoctorReport, hasDoctorFailures } from '../services/doctor';
import { findArtifact, listArtifacts, retrieveArtifact } from '../core/tool-artifacts';
import { listCheckpoints, restoreCheckpoint } from '../core/checkpoint';
import {
  cleanupStorage,
  collectProjectMetadataRepairPlan,
  collectStorageCleanupPlan,
  collectStorageReport,
  consumeStorageMaintenancePlan,
  deserializeStorageMaintenancePlan,
  formatStorageCleanupResult,
  formatStorageReport,
  repairProjectMetadata,
  serializeStorageMaintenancePlan,
} from '../services/storage-maintenance';
import { loadUsageState, summarizeUsageLedger } from '../services/usage-state';

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

function formatDurationMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
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
  if (stats.lastToolName) {
    lines.push(
      `Stopped at ${stats.lastToolName}${stats.lastToolSummary ? ` — ${stats.lastToolSummary}` : ''}`
    );
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
    const fallbackPath =
      stats.providerFallbackFromModel && stats.providerFallbackToModel
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
    typeof stats.loopBudgetMaxLlmRequests === 'number' ||
    typeof stats.loopBudgetMaxToolCalls === 'number' ||
    typeof stats.loopBudgetMaxModelVisibleBytes === 'number'
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
    lines.push(
      `Read-only  streak ${stats.singleReadOnlyStreak}, batch_read hints ${stats.batchReadSuggestionCount}`
    );
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
  console.log(
    DIM(
      'Use this to spot excessive LLM requests, fragmented read-only tool calls, and local fast-path hits.'
    )
  );
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
        event.providerRetryErrorTypes?.length
          ? `types=${event.providerRetryErrorTypes.join(',')}`
          : '',
        event.providerFinalModel ? `final=${event.providerFinalModel}` : '',
      ].filter(Boolean);
      return `${prefix} ${parts.join(' ')}`;
    }
    case 'provider_fallback': {
      const path =
        event.providerFallbackFromModel && event.providerFallbackToModel
          ? `${event.providerFallbackFromModel}->${event.providerFallbackToModel}`
          : (event.providerFinalModel ?? 'active');
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
      const targets =
        event.workspaceFiles?.length && !files
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
        event.loopBudgetSource ||
        typeof event.loopBudgetMaxLlmRequests === 'number' ||
        typeof event.loopBudgetMaxToolCalls === 'number' ||
        typeof event.loopBudgetMaxModelVisibleBytes === 'number'
      ) {
        const source =
          event.loopBudgetSource === 'config' && event.loopBudgetBaseProfile
            ? `config/${event.loopBudgetBaseProfile}`
            : (event.loopBudgetSource ?? 'unknown');
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
      if (event.continuationActions?.length)
        stats.push(`next=${event.continuationActions.join(',')}`);
      if (event.continuationHint) stats.push(`hint=${event.continuationHint}`);
      if (event.localFastPathUsed) stats.push('fast-path=yes');
      return `${prefix} ${stats.join(' ')}`;
    }
    case 'local_fast_path':
      return `${prefix} ${event.name ?? 'tool'}${event.argsSummary ? ` ${DIM(event.argsSummary)}` : ''}${event.argsArtifactId ? ` ${DIM(`args=/artifacts show ${event.argsArtifactId} --full${event.argsBytes ? ` (${formatBytes(event.argsBytes)})` : ''}`)}` : ''}${event.note ? ` ${DIM(event.note)}` : ''}`;
    case 'workspace_snapshot': {
      const state =
        event.workspaceGitAvailable === false
          ? WARN('not-git')
          : event.workspaceDirty
            ? WARN('dirty')
            : SUCCESS('clean');
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
        added.length
          ? `new: ${added.slice(0, 6).join(', ')}${added.length > 6 ? ', ...' : ''}`
          : '',
        changed.length
          ? `changed: ${changed.slice(0, 6).join(', ')}${changed.length > 6 ? ', ...' : ''}`
          : '',
        modifiedPreExisting.length
          ? `pre-existing modified: ${modifiedPreExisting.slice(0, 6).join(', ')}${modifiedPreExisting.length > 6 ? ', ...' : ''}`
          : '',
        resolved.length
          ? `resolved: ${resolved.slice(0, 6).join(', ')}${resolved.length > 6 ? ', ...' : ''}`
          : '',
      ]
        .filter(Boolean)
        .join(' | ');
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
      const missingPreview =
        missing > 0
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
  console.log(
    DIM('Trace stores metadata only; full transcript and tool output stay in session/artifacts.')
  );
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
    const call =
      event.type === 'tool_call'
        ? event
        : callId
          ? events
              .slice(0, index)
              .reverse()
              .find(candidate => candidate.type === 'tool_call' && candidate.callId === callId)
          : undefined;

    return { call, result };
  }
  return null;
}

/** Find tool trace by 1-based sequence number across all tool events. */
function toolTraceBySeq(
  events: SessionTraceEvent[],
  seq: number
): {
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
function toolTraceByCallId(
  events: SessionTraceEvent[],
  callIdPrefix: string
): {
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
  const seen = new Map<
    string,
    { seq: number; call?: SessionTraceEvent; result?: SessionTraceEvent }
  >();
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
  full: boolean
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
    console.log(
      `  ${DIM(`... preview truncated at ${formatBytes(maxPreviewBytes)}. Use /last-tool --full or /artifacts show ${artifact.id} --full.`)}`
    );
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
      const status = pair.result ? (pair.result.success === false ? '✗' : '✓') : '…';
      const duration =
        typeof pair.result?.duration === 'number'
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
  const status = result
    ? result.success === false
      ? ERROR('error')
      : SUCCESS('ok')
    : WARN('running');

  // Resolve sequence number from the trace events
  let seqLabel = '';
  if (options.ref && /^#?\d+$/.test(options.ref)) {
    seqLabel = `#${parseInt(options.ref.replace('#', ''), 10)} `;
  } else if (result || call) {
    const allPairs = collectToolTracePairs(events);
    const matchingPair = allPairs.find(
      p => p.call?.callId === callId || p.result?.callId === callId
    );
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
    const size =
      typeof argsSource.argsBytes === 'number' ? ` (${formatBytes(argsSource.argsBytes)})` : '';
    console.log(
      `  ${lastToolField(`${inputLabel} full`)}${DIM(`/artifacts show ${argsSource.argsArtifactId} --full${size}`)}`
    );
  }

  if (typeof result?.outputBytes === 'number') {
    const modelVisible =
      typeof result.modelVisibleBytes === 'number'
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
  console.log(
    DIM(
      'Use /last-tool --full for redacted full previews, --no-preview for metadata only, or /trace latest for the ordered turn timeline.'
    )
  );
  return { success: true };
}

function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function parseArtifactArgs(args: string): {
  action: 'list' | 'show';
  ref?: string;
  full: boolean;
  limit: number;
} {
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
  console.log(
    DIM(
      `... preview truncated at ${formatBytes(maxPreviewBytes)}. Use /artifacts show <id> --full for full output.`
    )
  );
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
      console.log(
        `${ACCENT(artifact.id)} ${DIM(artifact.toolName)} ${formatBytes(artifact.outputBytes)}`
      );
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
  console.log(
    DIM(
      `Tool ${artifact.toolName}  Size ${formatBytes(artifact.outputBytes)}  Modified ${formatDateTime(artifact.modifiedAt)}`
    )
  );
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
      const files = checkpoint.files
        .map(file => file.path)
        .slice(0, 8)
        .join(', ');
      console.log(`  ${DIM(`${checkpoint.files.length} file(s)${files ? `: ${files}` : ''}`)}`);
    }
    console.log();
    console.log(DIM('Use /rewind restore <turn-id|prefix> to preview, then add --yes to restore.'));
    return { success: true };
  }

  if (action !== 'restore') {
    console.log(ERROR('Usage: /rewind [list|restore <turn-id|prefix> [--yes]]'));
    return { success: false };
  }

  const ref = tokens.find(token => token !== 'restore' && token !== '--yes');
  const confirmed = tokens.includes('--yes');
  if (!ref) {
    console.log(ERROR('Usage: /rewind restore <turn-id|prefix> [--yes]'));
    return { success: false };
  }

  const { checkpoint, ambiguous } = findCheckpointByRef(ctx, ref);
  if (!checkpoint) {
    console.log(
      ERROR(ambiguous ? `Checkpoint prefix is ambiguous: ${ref}` : `Checkpoint not found: ${ref}`)
    );
    console.log(DIM('Run /rewind to list available checkpoint ids.'));
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
    console.log(DIM(`Run /rewind restore ${checkpoint.turnId} --yes to restore.`));
    return { success: true };
  }

  const result = restoreCheckpoint(ctx.cwd, checkpoint.turnId);
  if (result.error) {
    console.log(ERROR(result.error));
    return { success: false, error: result.error };
  }

  console.log(
    SUCCESS(`Restored ${result.restored.length} file(s) from checkpoint ${checkpoint.turnId}.`)
  );
  for (const file of result.restored.slice(0, 20)) {
    console.log(`  ${file}`);
  }
  return { success: true, output: result.restored.join('\n') };
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
      console.log(
        `    ${BRAND(model.padEnd(20))} ${data.tokens} tokens, ${costTracker.formatCost(data.cost)}`
      );
    }
  }

  console.log();
  console.log(HEADER('  Cost Sources:'));
  for (const source of ['provider', 'configured', 'builtin', 'fallback'] as const) {
    const data = ledger.bySource[source];
    if (data.count === 0) continue;
    console.log(
      `    ${source.padEnd(12)} ${data.count} requests, ${costTracker.formatCost(data.cost)}`
    );
  }
  if (state.baselineCost > 0 || state.baselineTokens > 0) {
    console.log(
      DIM(
        `    legacy       ${state.baselineTokens.toLocaleString()} tokens, ${costTracker.formatCost(state.baselineCost)}`
      )
    );
  }
  if (ledger.bySource.fallback.count > 0) {
    console.log();
    console.log(WARN('  Unknown-model fallback pricing is an estimate.'));
    console.log(DIM('  Configure cost.modelPricing in ~/.orion-code/orion.json for accuracy.'));
  }
  if (ledger.droppedCorruptLines > 0) {
    console.log();
    console.log(
      WARN(
        `  Ignored ${ledger.droppedCorruptLines} corrupt usage ledger line(s); run /storage doctor.`
      )
    );
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

function handleDoctor(ctx: CommandContext): CommandResult {
  const report = collectDoctorReport(ctx);
  console.log();
  console.log(formatDoctorReport(report));
  console.log();
  return { success: !hasDoctorFailures(report) };
}

function handleStorage(_ctx: CommandContext, args: string): CommandResult {
  const usage =
    '/storage [doctor|status|repair [--dry-run|--yes] [--plan=<token>]|cleanup [--dry-run|--yes] [--plan=<token>]]';
  const trimmed = args.trim();
  const tokens = trimmed ? trimmed.split(/\s+/u) : [];
  const action = tokens[0] ?? 'doctor';
  const flags = tokens.slice(1);
  const acceptsMutationFlags = action === 'cleanup' || action === 'repair';
  const planFlags = flags.filter(flag => flag.startsWith('--plan='));
  const invalidTokens = flags.filter(
    flag =>
      !acceptsMutationFlags ||
      (flag !== '--dry-run' && flag !== '--yes' && !flag.startsWith('--plan=')) ||
      (flag.startsWith('--plan=') && flag.length === '--plan='.length)
  );
  if (planFlags.length > 1) invalidTokens.push(...planFlags.slice(1));
  if (invalidTokens.length > 0) {
    return {
      success: false,
      error: `Unknown /storage option: ${invalidTokens.join(', ')}. Usage: ${usage}`,
    };
  }
  const confirmed = flags.includes('--yes');
  const explicitDryRun = flags.includes('--dry-run');
  const planToken = planFlags[0]?.slice('--plan='.length);
  const decodedPlan = planToken ? deserializeStorageMaintenancePlan(planToken) : undefined;
  if (planToken && !decodedPlan) {
    return { success: false, error: `Invalid or corrupted storage plan token. Usage: ${usage}` };
  }

  if (action === 'cleanup') {
    if (decodedPlan && decodedPlan.kind !== 'cleanup') {
      return { success: false, error: 'The supplied storage plan is not a cleanup plan.' };
    }
    const dryRun = explicitDryRun || !confirmed;
    if (!dryRun && !decodedPlan) {
      return {
        success: false,
        error: 'Cleanup requires the exact preview plan. Run /storage cleanup first.',
      };
    }
    const consumedPlan =
      !dryRun && planToken ? consumeStorageMaintenancePlan(planToken) : undefined;
    if (!dryRun && (!consumedPlan || consumedPlan.kind !== 'cleanup')) {
      return {
        success: false,
        error:
          'The storage cleanup plan expired, was already used, or is not valid in this process.',
      };
    }
    const plan = dryRun
      ? decodedPlan?.kind === 'cleanup'
        ? decodedPlan.plan
        : collectStorageCleanupPlan()
      : (consumedPlan as { kind: 'cleanup'; plan: ReturnType<typeof collectStorageCleanupPlan> })
          .plan;
    const result = cleanupStorage({ dryRun }, plan);
    console.log();
    console.log(formatStorageCleanupResult(result));
    if (dryRun) {
      const portablePlan = planToken ?? serializeStorageMaintenancePlan({ kind: 'cleanup', plan });
      console.log(
        DIM(`Preview only. Run /storage cleanup --plan=${portablePlan} --yes to apply this plan.`)
      );
    }
    console.log();
    return { success: true };
  }

  if (action === 'repair') {
    if (decodedPlan && decodedPlan.kind !== 'repair') {
      return { success: false, error: 'The supplied storage plan is not a repair plan.' };
    }
    const plan =
      decodedPlan?.kind === 'repair' ? decodedPlan.plan : collectProjectMetadataRepairPlan();
    if (explicitDryRun || !confirmed) {
      console.log();
      console.log(HEADER('Orion Code Storage Repair Preview'));
      console.log(DIM('─'.repeat(40)));
      console.log(`  Repairable metadata entries ${ACCENT(String(plan.actions.length))}`);
      for (const action of plan.actions.slice(0, 12)) {
        console.log(`  ${DIM('•')} ${DIM(action.metadataPath)}`);
      }
      const portablePlan = planToken ?? serializeStorageMaintenancePlan({ kind: 'repair', plan });
      console.log(
        DIM(
          `  Preview only. Writable repair is disabled; /storage repair --plan=${portablePlan} --yes will fail closed.`
        )
      );
      console.log();
      return { success: true };
    }
    if (!decodedPlan) {
      return {
        success: false,
        error: 'Repair requires the exact preview plan. Run /storage repair first.',
      };
    }
    const consumedPlan = planToken ? consumeStorageMaintenancePlan(planToken) : undefined;
    if (!consumedPlan || consumedPlan.kind !== 'repair') {
      return {
        success: false,
        error:
          'The storage repair plan expired, was already used, or is not valid in this process.',
      };
    }
    const result = repairProjectMetadata(consumedPlan.plan);
    return { success: false, error: result.blockedReason };
  }

  if (action !== 'doctor' && action !== 'status') {
    return {
      success: false,
      error: `Usage: ${usage}`,
    };
  }

  const report = collectStorageReport();
  console.log();
  console.log(formatStorageReport(report));
  console.log();
  return { success: true };
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

export {
  handleDoctor,
  handleStorage,
  handleUsage,
  handleLoopStats,
  handleTrace,
  handleLastTool,
  handleArtifacts,
  handleCheckpoint,
  handleCost,
  showAgents,
};
