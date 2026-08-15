/** Handler implementations for the session-command-handlers boundary. */

import chalk from 'chalk';
import { type CommandContext, type CommandResult } from './types';
import { createStatusSnapshot } from '../runtime/ui-view-model';
import { formatBytes } from '../services/format';
import { resetToolState } from '../framework';
import type { Message } from '../services/llm';
import {
  listSessions,
  listProjectSessions,
  lookupSessionRef,
  loadSessionHistory,
  loadSessionCompactCheckpoint,
  loadSessionTranscriptMessages,
  commitSessionCompactCheckpoint,
  prepareSessionCompactSourceReceipt,
  loadSessionHarnessState,
  resumeSession,
  renameSession,
  resolveProjectPath,
  readSessionMessages,
  redactTraceText,
  appendSessionTraceEvent,
  type SessionMeta,
  type SessionTraceEvent,
} from '../services/session-storage';
import { loadSessionIndex, searchSessions } from '../services/session-index';
import { CompactCoordinator } from '../services/compact/coordinator';
import { createContextUsageSnapshot } from '../services/model-context';
import { estimateMessagesTokens } from '../utils/token-estimate';
import { compactStatus } from '../runtime/agent-status';

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

function commandUICapabilities(ctx: CommandContext) {
  return createStatusSnapshot({
    renderer: ctx.uiRenderer ?? ctx.config.ui?.renderer ?? 'terminal',
    capabilities: ctx.uiCapabilities,
  }).renderer.capabilities;
}

function hasCommandFlag(args: string, flag: string): boolean {
  return args.trim().split(/\s+/u).includes(flag);
}

function handleContextClear(ctx: CommandContext, args: string): CommandResult {
  const history = ctx.store.getSnapshot().conversationHistory;

  if (history.length === 0) {
    return { success: true, output: 'Current in-memory model context is already empty.' };
  }

  if (!hasCommandFlag(args, '--yes')) {
    return {
      success: false,
      error: [
        `This will clear ${history.length} message(s) from the current in-memory model context.`,
        'Saved session history will not be deleted and can still be restored with /resume.',
        'Run /context clear --yes to continue.',
      ].join('\n'),
    };
  }

  ctx.store.resetConversation();
  resetToolState();
  return {
    success: true,
    output: [
      `Cleared ${history.length} messages from current model context.`,
      'Saved session history, configuration, and system state were preserved.',
    ].join('\n'),
  };
}

async function handleCompact(ctx: CommandContext, args: string): Promise<CommandResult> {
  const lines: string[] = [];
  const console = {
    log: (...values: unknown[]): void => {
      lines.push(values.map(value => String(value)).join(' '));
    },
  };
  const finish = (success: boolean): CommandResult => ({
    success,
    output: lines.join('\n'),
  });
  const history = ctx.store.getSnapshot().conversationHistory;
  const traceSessionId = ctx.getSession?.()?.id ?? ctx.sessionId;
  const traceTurnId = String(ctx.turnId ?? 'command:compact');
  let traceDetails:
    | Pick<
        SessionTraceEvent,
        | 'model'
        | 'compactMode'
        | 'compactStrategy'
        | 'compactCandidateFingerprint'
        | 'compactBeforeTokens'
        | 'compactAfterTokens'
        | 'compactTargetTokens'
        | 'compactTargetRatio'
        | 'compactDiagnosticsCount'
      >
    | undefined;

  if (history.length === 0) {
    console.log(DIM('Conversation history is empty, nothing to compact'));
    console.log();
    return finish(true);
  }

  // `/compact [N] [focus]`: a leading positive integer keeps the legacy
  // message threshold; all remaining text is secondary summary guidance.
  const trimmedArgs = args.trim();
  const match = trimmedArgs.match(/^(?:(\d+)(?:\s+|$))?([\s\S]*)$/u);
  const thresholdArg = match?.[1] ? Number.parseInt(match[1], 10) : NaN;
  const threshold = Number.isSafeInteger(thresholdArg) && thresholdArg > 0 ? thresholdArg : 20;
  const focus = (match?.[2] ?? trimmedArgs).trim() || undefined;

  console.log();
  console.log(HEADER('Compacting Conversation'));
  console.log(DIM('─'.repeat(40)));
  console.log(`  Current messages: ${history.length}`);
  console.log(`  Threshold: ${threshold}`);
  if (focus) console.log(`  Focus: ${focus}`);
  console.log();

  if (history.length <= threshold) {
    console.log(
      DIM(`Conversation has ${history.length} messages, below compact threshold ${threshold}.`)
    );
    console.log(DIM('Nothing compacted.'));
    console.log();
    return finish(true);
  }

  console.log(DIM(compactStatus()));
  try {
    const prepareSource = traceSessionId
      ? prepareSessionCompactSourceReceipt(traceSessionId)
      : undefined;
    const modelId = ctx.llm?.getModel() ?? ctx.store.getSnapshot().currentModel;
    const coordinator =
      ctx.compactCoordinator ??
      new CompactCoordinator({
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
    const result = await coordinator.compactManual(history, threshold, focus);
    traceDetails = {
      model: modelId,
      compactMode: 'manual',
      compactStrategy:
        result.summarySource === 'llm' ? 'semantic-llm-v2' : 'deterministic-fallback-v2',
      compactCandidateFingerprint: result.fingerprint,
      compactBeforeTokens: result.beforeTokens,
      compactAfterTokens: result.afterTokens,
      compactTargetTokens: result.plan.targetTokens,
      compactTargetRatio: result.plan.targetRatio,
      compactDiagnosticsCount: result.diagnostics.length,
    };
    if (traceSessionId) {
      appendSessionTraceEvent(traceSessionId, {
        turnId: traceTurnId,
        type: 'compact_prepare',
        ...traceDetails,
      });
    }
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
      const sourceMessageCount =
        prepareSource?.sourceMessageCount ?? readSessionMessages(sessionId).length;
      const goal = ctx.getActiveGoal?.();
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
        harnessState: ctx.store.getSnapshot().harnessState,
        goalBinding: goal
          ? { goalId: goal.goalId, revision: goal.revision, state: goal }
          : undefined,
        prepareSource,
        candidate: {
          fingerprint: result.fingerprint,
          beforeTokens: result.beforeTokens,
          afterTokens: result.afterTokens,
          plan: result.plan,
          semanticSummary: result.semanticSummary,
          diagnostics: result.diagnostics,
        },
      });
      appendSessionTraceEvent(sessionId, {
        turnId: traceTurnId,
        type: 'compact_validate',
        checkpointId: checkpoint.checkpointId,
        success: true,
        compactSourceMessageCount: sourceMessageCount,
        ...traceDetails,
      });
      appendSessionTraceEvent(sessionId, {
        turnId: traceTurnId,
        type: 'compact_commit',
        checkpointId: checkpoint.checkpointId,
        success: true,
        compactSourceMessageCount: sourceMessageCount,
        ...traceDetails,
      });
      ctx.store.setState({ conversationHistory: checkpoint.modelHistory });
      appendSessionTraceEvent(sessionId, {
        turnId: traceTurnId,
        type: 'compact_boundary',
        checkpointId: checkpoint.checkpointId,
        success: true,
        compactSourceMessageCount: sourceMessageCount,
        ...traceDetails,
      });
      appendSessionTraceEvent(sessionId, {
        turnId: traceTurnId,
        type: 'compact_completed',
        checkpointId: checkpoint.checkpointId,
        success: true,
        compactSourceMessageCount: sourceMessageCount,
        ...traceDetails,
      });
    } else {
      ctx.store.setState({ conversationHistory: compacted });
    }
    ctx.store.setContextUsage(afterUsage);

    console.log(SUCCESS(`✔ Compacted ${history.length} → ${compacted.length} messages`));
    console.log(DIM(`  Reduced by ${reduction} messages (${percent}%)`));
    console.log();
    return finish(true);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (traceSessionId) {
      appendSessionTraceEvent(traceSessionId, {
        turnId: traceTurnId,
        type: 'compact_rollback',
        success: false,
        error: message,
        ...traceDetails,
      });
      appendSessionTraceEvent(traceSessionId, {
        turnId: traceTurnId,
        type: 'compact_failed',
        success: false,
        error: message,
        ...traceDetails,
      });
    }
    console.log(ERROR(`✗ Compact failed: ${message}`));
    console.log();
    return finish(false);
  }
}

// ============================================================================
// Session 命令
// ============================================================================

function parseSessionScopeArgs(
  args: string,
  cwd: string
): { allProjects: boolean; projectPath: string; query: string; last: boolean } {
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

type SessionLineWriter = (text?: string) => void;
const writeSessionLineToConsole: SessionLineWriter = (text = '') => console.log(text);

function printSessionRows(
  sessions: SessionMeta[],
  options: { showProject?: boolean; indexed?: boolean; showIndexSummary?: boolean } = {},
  write: SessionLineWriter = writeSessionLineToConsole
): void {
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

    write(`${index}${status} ${BRAND(session.id.slice(0, 8))}${name} ${DIM(session.model)}`);
    write(`    ${truncateText(sessionTitle(session), 96)}`);
    write(
      `    ${DIM(`Started: ${startTime}`)} ${DIM(`Updated: ${updatedTime}`)} ${DIM(`Duration: ${duration}`)}`
    );
    write(
      `    ${DIM(`Messages: ${session.messageCount ?? 0}`)} ${DIM(`Size: ${formatBytes(session.historySizeBytes ?? 0)}`)} ${DIM(`Tokens: ${session.tokenCount}`)} ${DIM(`Cost: $${session.cost.toFixed(4)}`)}`
    );
    if (options.showIndexSummary) {
      const indexSummary = loadSessionIndex(session.id, session.projectPath);
      if (indexSummary) {
        const toolCount = Object.values(indexSummary.tools).reduce(
          (total, count) => total + count,
          0
        );
        write(
          `    ${DIM(`Index: ${indexSummary.files.length} files, ${toolCount} tool calls, ${indexSummary.topics.length} topics`)}`
        );
      } else {
        write(`    ${DIM('Index: not built')}`);
      }
    }
    if (options.showProject) {
      write(`    ${DIM(`Project: ${session.projectPath}`)}`);
    }
    write();
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

function printSessionConflict(
  ref: string,
  matches: SessionMeta[],
  write: SessionLineWriter = writeSessionLineToConsole
): void {
  write(ERROR(`Session reference is ambiguous: ${ref}`));
  write(DIM('Use a longer id prefix, exact session name, or pick one of these:'));
  write();
  printSessionRows(matches.slice(0, 10), { indexed: true, showProject: true }, write);
  write(DIM('Example: /resume <longer-session-id>'));
  write();
}

function printSessionPicker(
  sessions: SessionMeta[],
  options: { title: string; showProject?: boolean; moreCount?: number },
  write: SessionLineWriter = writeSessionLineToConsole
): void {
  write(HEADER(options.title));
  write(DIM('─'.repeat(Math.min(process.stdout.columns || 80, 96))));
  printSessionRows(sessions, { indexed: true, showProject: options.showProject }, write);
  if (options.moreCount && options.moreCount > 0) {
    write(
      DIM(
        `... ${options.moreCount} more sessions. Use /session list to list them, or /resume <session-id>.`
      )
    );
  }
  write(DIM('Use /resume <number|session-id|name> or /resume --last.'));
}

function handleSessions(ctx: CommandContext, args: string = ''): CommandResult {
  const scope = parseSessionScopeArgs(args, ctx.cwd);
  const query = scope.query?.trim();

  // If there's a search query, use the session index
  if (query && !query.startsWith('--')) {
    const allSessions = scope.allProjects ? listSessions() : listProjectSessions(scope.projectPath);
    const matchedIds = searchSessions(
      query,
      allSessions.map(session => ({
        id: session.id,
        projectPath: session.projectPath,
      }))
    );

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
    const matchedSessions = matchedIds
      .map(id => sessionMap.get(id))
      .filter(Boolean) as SessionMeta[];

    console.log();
    console.log(HEADER(`Sessions (search: "${query}") — ${matchedSessions.length} matches`));
    console.log(DIM('─'.repeat(40)));
    console.log();
    printSessionRows(matchedSessions, {
      indexed: true,
      showProject: scope.allProjects,
      showIndexSummary: true,
    });
    console.log();
    console.log(
      DIM(`Searched ${allSessions.length} sessions, found ${matchedSessions.length} matches`)
    );
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
    console.log(
      DIM(scope.allProjects ? '  No sessions found' : '  No sessions found for this project')
    );
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

function handleSessionInfo(ctx: CommandContext, args: string = ''): CommandResult {
  const scope = parseSessionScopeArgs(args, ctx.cwd);
  const active = ctx.getSession?.() ?? null;
  let session: SessionMeta | null = null;

  if (!scope.query) {
    session = active ?? listProjectSessions(scope.projectPath)[0] ?? null;
  } else {
    const found = lookupSessionRef(scope.query, scope.projectPath, {
      allProjects: scope.allProjects,
    });
    if (found.status === 'ambiguous') {
      return {
        success: false,
        error: `Session reference is ambiguous: ${scope.query}. Matches: ${found.matches
          .slice(0, 5)
          .map(item => item.id.slice(0, 8))
          .join(', ')}.`,
      };
    }
    if (found.status === 'not_found') {
      return { success: false, error: `Session not found: ${scope.query}.` };
    }
    session = found.session;
  }

  if (!session) return { success: false, error: 'No session is available for this project.' };
  return {
    success: true,
    output: [
      `Session ${session.id}`,
      `Name: ${session.name ?? '(untitled)'}`,
      `Status: ${session.endTime ? 'completed' : 'active'}`,
      `Model: ${session.model}`,
      `Project: ${session.projectPath}`,
      `Started: ${new Date(session.startTime).toISOString()}`,
      `Updated: ${new Date(session.updatedAt ?? session.startTime).toISOString()}`,
      `Messages: ${session.messageCount ?? 0}`,
      `History size: ${formatBytes(session.historySizeBytes ?? 0)}`,
      `Effort: ${session.effortPreference ?? 'auto'}`,
    ].join('\n'),
  };
}

function handleResume(ctx: CommandContext, args: string): CommandResult {
  const lines: string[] = [];
  const write: SessionLineWriter = (text = '') => lines.push(text);
  const output = (success: boolean): CommandResult => ({ success, output: lines.join('\n') });
  const ui = commandUICapabilities(ctx);
  const scope = parseSessionScopeArgs(args, ctx.cwd);
  const sessionRef = scope.query;
  const scopedSessions = (
    scope.allProjects ? listSessions() : listProjectSessions(scope.projectPath)
  ).filter(session => (session.messageCount ?? 0) > 0);

  if (!sessionRef) {
    const lastSession = scopedSessions[0];
    if (!lastSession) {
      return {
        success: false,
        error:
          'No previous session found for this project. Use /session list --all to list all sessions.',
      };
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
    write();
    printSessionPicker(
      visibleSessions,
      {
        title: picker.title,
        showProject: picker.showProject,
        moreCount: Math.max(0, scopedSessions.length - visibleSessions.length),
      },
      write
    );
    write();
    return output(true);
  }

  const pickerIndex = parsePickerIndex(sessionRef, scopedSessions.length);
  if (pickerIndex !== null) {
    return restoreSession(ctx, scopedSessions[pickerIndex], false);
  }

  // Resume specific session
  const result = lookupSessionRef(sessionRef, scope.projectPath, {
    allProjects: scope.allProjects,
  });

  if (result.status === 'ambiguous') {
    printSessionConflict(sessionRef, result.matches, write);
    return output(false);
  }

  if (result.status === 'not_found') {
    return {
      success: false,
      error: scope.allProjects
        ? `Session not found: ${sessionRef}. Use /session list --all to list sessions.`
        : `Session not found: ${sessionRef}. Use /session list, or /resume <id> --all.`,
    };
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
  const summary =
    checkpoint?.summary.text ?? (history.length > 0 ? generateHistorySummary(history) : '');
  const summaryGeneratedAt = checkpoint?.summary.generatedAt ?? resumeGeneratedAt;
  const summarySource = checkpoint?.summary.source ?? 'resume_heuristic';
  const summaryCoveredMessages = checkpoint?.summary.sourceMessageCount ?? rawMessages.length;
  if (history.length > 0) {
    const eventSummary = checkpoint?.summary.text ?? generateRestoredSessionEventSummary(history);
    ctx.store.setState({ conversationHistory: history });
    ctx.store.setState({
      harnessState: loadSessionHarnessState(resumed.id) ?? resumed.harnessState,
    });
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
    return { success: true };
  }

  return {
    success: true,
    output: [
      '',
      HEADER(bannerLines[0]),
      ...bannerLines.slice(1).map(line => (line.startsWith('✔') ? SUCCESS(line) : DIM(line))),
      '',
    ].join('\n'),
  };
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

  const scopedSessions = scope.allProjects
    ? listSessions()
    : listProjectSessions(scope.projectPath);
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
      console.log(
        DIM(
          scope.allProjects
            ? 'Use /sessions --all to list sessions'
            : 'Use /sessions to list project sessions'
        )
      );
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
    console.log(
      WARN(
        `  Name already exists on ${duplicate.id.slice(0, 8)}; /resume "${newName}" will be ambiguous.`
      )
    );
  }
  console.log();
  return { success: true };
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
  const assistantMsgsWithTools = messages.filter(
    m => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0
  );

  // Extract topics from first few user messages
  const topics = userMsgs.slice(0, 3).map(m => {
    return truncateRedactedSummary(m.content || '', 40);
  });

  // Extract tools used
  const toolsUsed = assistantMsgsWithTools.flatMap(
    m => m.tool_calls?.map(tc => tc.function.name) || []
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
  const assistantMsgsWithTools = messages.filter(
    m => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0
  );
  const toolsUsed = assistantMsgsWithTools.flatMap(
    m => m.tool_calls?.map(tc => tc.function.name) || []
  );
  const uniqueTools = [...new Set(toolsUsed)].slice(0, 8);

  if (uniqueTools.length === 0) return undefined;
  return `Tools: ${uniqueTools.join(', ')}`;
}

export {
  handleResume,
  handleSessions,
  handleSessionInfo,
  handleSessionRename,
  handleCompact,
  handleContextClear,
};
