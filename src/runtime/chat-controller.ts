import { findCommand } from '../commands';
import { randomUUID } from 'crypto';
import { parseInput, buildCommandSuggestions } from '../commands/parser';
import type { CommandContext, CommandUiRenderer } from '../commands/types';
import type { Message, ProviderRequestPreflight, StreamCallbacks } from '../services/llm';
import type { SessionMessage, SessionTraceEvent } from '../services/session-storage';
import {
  appendSessionMessage,
  appendSessionMessages,
  commitSessionCompactCheckpoint,
  endSession,
  loadSessionHarnessState,
  loadSessionHistory,
  loadSessionMeta,
  removeLastIncompleteAssistantMessage,
  removeTrailingSessionUserMessage,
  readSessionMessages,
  updateSessionHarnessState,
  updateSessionSkills,
  updateSessionSummary,
} from '../services/session-storage';
import { isConfigured } from '../services/config';
import { ProviderRetryExhaustedError } from '../services/provider-resilience';
import {
  resolveProjectToolAllowlist,
  type ToolAllowlistEvaluator,
} from '../services/tool-allowlist';
import {
  query,
  buildSystemPrompt,
  QueryLoopError,
  createFailedLoopStats,
  createLocalFastPathLoopStats,
  type LoopFinishReason,
  type LoopStats,
  type PromptContext,
  type QueryCompactCommit,
} from '../framework';
import { buildGoalContextFragment } from './goals/prompt';
import { createContextHarness } from '../harness';
import { executeTool, getRuntimeTools } from '../tools';
import { resolveEffectivePermission } from '../framework/tool-scheduler';
import { parseToolResultEnvelope } from '../framework/tool-serializer';
import { storeArtifact } from '../core/tool-artifacts';
import { resolveSkillsForTurn, hasMatchingSkill } from '../skills';
import {
  createSubagentBundleForTurn,
  deriveRootLlmConfig,
  buildResearchView,
  createFileArtifactStore,
  createLocalResearchRequest,
  resolveCitations,
  saveResearchPacket,
  subtaskResultToPacket,
  toLifecycleEvents,
  validatePacket,
  type RuntimeSubtaskEvent,
  type SubagentTurnBundle,
} from './subagents';
import { buildReferencedFilesPrompt } from '../services/file-context';
import { refreshProjectInstructions } from '../services/prompt-context';
import { captureWorkspaceSnapshot } from '../services/workspace-state';
import {
  collectVerificationCommandResult,
  formatVerificationGateNotice,
  shouldGateCompletion,
  type VerificationCommandResult,
} from '../services/verification-profile';
import type { OrionCodeUiRuntime, UiEventSink, UiRendererCapabilities } from './ui-events';
import { resolveUiRendererCapabilities } from './ui-events';
import {
  agentStepStatus,
  batchingSuggestion,
  runningToolsStatus,
  verifyingStatus,
  verificationGateStatus,
} from './agent-status';
import { capAutonomousGoalLoopBudget, resolveRuntimeLoopBudget } from './loop-budget';
import { setDiagnosticTraceContext } from '../utils/observability';
import {
  appendAssistantNotice,
  buildTraceArgsDetails,
  byteLength,
  compactMiddle,
  compactToolArgs,
  compactTraceError,
  emitHarnessDiagnostics,
  errorLayerForChatError,
  formatChatError,
  getLastRequestDiagnostics,
  goalTraceContext,
  isAbortError,
  recordProviderTraceEvents,
  recordTraceEvent,
  traceTurnId,
  type GoalAccountingLoopStats,
} from './chat-trace';
import { createPreToolCheckpoint, parseToolCallArgsForRuntime } from './chat-checkpoint';
import {
  appendPostWorkspaceTrace,
  appendVerificationResultTrace,
  appendWorkspaceSnapshotTrace,
  formatFailureRecoveryNotice,
  shouldRecordVerificationLoopStats,
  withVerificationLoopStats,
  workspaceDeltaHasTurnChanges,
} from './chat-workspace';
import {
  captureConsoleOutput,
  formatLocalFastPathAssistantContent,
  LocalFastPathBlockedError,
  parseLocalFastPath,
  removeTrailingUserMessage,
  sessionMessagesToTranscriptEntries,
  createAssistantStreamPresenter,
  createToolEventPresenter,
  structuredToolFinishActivity,
  toolFinishContent,
  type LocalFastPathAction,
  type ToolResultEvent,
} from './chat-presentation';
import { applySessionEffort } from './chat-effort';
import { createPlanModeChangeHandler } from '../framework/agent-mode';

export {
  createAssistantStreamPresenter,
  createToolEventPresenter,
  sessionMessagesToTranscriptEntries,
} from './chat-presentation';
export type {
  AssistantStreamPresenter,
  SessionTranscriptEntryOptions,
  ToolEventPresenter,
} from './chat-presentation';

export interface RunInputOptions {
  abortSignal?: AbortSignal;
  turnId?: number | string;
  persistAsUserMessage?: boolean;
  inputKind?: import('./goals/types').AgentInputKind;
}

export interface AgentChatControllerOptions {
  confirmToolUse?: Parameters<typeof query>[0]['confirmToolUse'];
  uiCapabilities?: UiRendererCapabilities;
  uiRenderer?: CommandUiRenderer;
  onVerificationStateChange?: (
    state: 'pending' | 'running' | 'passed' | 'failed' | 'gated'
  ) => void;
  /** True while the parent runtime is awaiting a permission decision. */
  hasPendingPermission?: () => boolean;
  /** Reports observed child usage to the root cost tracker. */
  onChildUsage?: (
    taskId: string,
    role: import('./subagents/types').SubagentRole,
    usage: import('./subagents/types').SubtaskUsage,
    modelLabel?: string
  ) => void;
  /** Shared Goal budget gate for every provider request. */
  beforeProviderRequest?: ProviderRequestPreflight;
  /** Single BUILD / PLAN / AUTO lifecycle shared with commands and plan tools. */
  agentModeLifecycle?: import('../framework/agent-mode').AgentModeLifecycleController;
}

/** @deprecated Use AgentChatControllerOptions. Chat execution is renderer-independent. */
export type InkChatControllerOptions = AgentChatControllerOptions;

export class AgentChatController {
  /** v0.2.26: optional goal coordinator for prompt injection and turn finalization. */
  private goalCoordinator: import('./goals/coordinator').GoalCoordinator | null = null;

  setGoalCoordinator(coord: import('./goals/coordinator').GoalCoordinator | null): void {
    this.goalCoordinator = coord;
  }

  private resolveToolAllowlist(): ToolAllowlistEvaluator {
    // Resolve on every evaluation, including execution. A model response can
    // contain several serial calls prepared before the first permission prompt;
    // once the user chooses project/global scope, the next call in that same
    // response must observe the persisted grant instead of prompting again.
    return (toolName, args) =>
      resolveProjectToolAllowlist(this.runtime.cwd).evaluator?.(toolName, args);
  }

  constructor(
    private readonly runtime: OrionCodeUiRuntime,
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

    // Every root input owns a fresh accounting snapshot. Commands and local
    // fast paths are known zero-provider turns; runChat changes tokenUsage to
    // null before networking so missing provider usage remains fail-closed.
    const storeWithState = this.runtime.store as typeof this.runtime.store & {
      setState?: (partial: {
        tokenUsage?: { promptTokens: number; completionTokens: number } | null;
        lastLoopStats?: LoopStats;
      }) => void;
    };
    storeWithState.setState?.({
      tokenUsage: { promptTokens: 0, completionTokens: 0 },
      lastLoopStats: undefined,
    });

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
      if (this.events.clearView) {
        this.events.clearView();
      } else {
        this.events.clearTranscript();
      }
      this.events.setStatus('View cleared. Conversation context is preserved.');
      return;
    }

    if (parsed.name === 'exit' || parsed.name === 'quit' || parsed.name === 'q') {
      this.events.shutdownRequested?.('user request');
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

    const compatibilityAlias = command.compatibilityAliases?.find(
      alias => alias.name.toLowerCase() === parsed.name.toLowerCase()
    );
    const deprecation =
      compatibilityAlias?.lifecycle ??
      (command.lifecycle.status === 'deprecated' ? command.lifecycle : undefined);
    if (deprecation) {
      this.events.append({
        role: 'system',
        title: `/${parsed.name} deprecated`,
        content: `/${parsed.name} is deprecated${deprecation.replacement ? `; use ${deprecation.replacement}` : ''}. It will be removed in ${deprecation.removeIn ?? 'a future release'}.`,
        statusTone: 'warning',
        command: {
          id: command.id,
          name: command.name,
          source: command.source,
          success: true,
        },
      });
    }

    const ctx = this.createCommandContext(options.abortSignal, options.turnId);
    let commandProviderAttempts = 0;
    const commandProviderPreflight: ProviderRequestPreflight = async context => {
      commandProviderAttempts += 1;
      return this.controllerOptions.beforeProviderRequest
        ? this.controllerOptions.beforeProviderRequest(context)
        : { available: true };
    };
    const restoreProviderPreflight =
      typeof this.runtime.llm?.setProviderRequestPreflight === 'function'
        ? this.runtime.llm.setProviderRequestPreflight(commandProviderPreflight)
        : undefined;
    const commandUsage = { promptTokens: 0, completionTokens: 0 };
    let commandUsageEvents = 0;
    const unsubscribeCommandUsage =
      typeof this.runtime.llm?.subscribeUsage === 'function'
        ? this.runtime.llm.subscribeUsage(event => {
            commandUsageEvents += 1;
            commandUsage.promptTokens += event.usage.promptTokens;
            commandUsage.completionTokens += event.usage.completionTokens;
          })
        : undefined;
    let result: Awaited<ReturnType<typeof command.execute>>;
    let output: string;
    try {
      if (command.audience === 'primary') {
        result = await command.execute(ctx, parsed.args);
        output = '';
      } else {
        ({ result, output } = await captureConsoleOutput(() => command.execute(ctx, parsed.args)));
      }
    } finally {
      unsubscribeCommandUsage?.();
      restoreProviderPreflight?.();
      if (commandUsage.promptTokens > 0 || commandUsage.completionTokens > 0) {
        this.runtime.store.setTokenUsage(commandUsage);
      }
      const providerRequests = Math.max(commandProviderAttempts, commandUsageEvents);
      if (providerRequests > 0) {
        const diagnostics = getLastRequestDiagnostics(this.runtime.llm);
        const retryCount = diagnostics?.retryCount ?? 0;
        const fallbackCount = diagnostics?.fallbackTriggered ? 1 : 0;
        this.setLoopStats({
          turnsStarted: 1,
          llmRequests: providerRequests,
          toolCalls: 0,
          readOnlyToolCalls: 0,
          unsafeToolCalls: 0,
          toolResultBytes: 0,
          modelVisibleToolBytes: 0,
          summarizedBytes: 0,
          finishReason: commandUsageEvents > 0 ? 'completed' : 'failed',
          providerRetryCount: retryCount,
          providerRetryDelayMs: diagnostics?.retryDelayMs,
          providerRetryErrorTypes: diagnostics?.retryErrorTypes,
          providerLastRetryErrorType: diagnostics?.lastRetryErrorType,
          providerLastRetryStatus: diagnostics?.lastRetryStatus,
          providerFallbackCount: fallbackCount,
          providerFallbackFromModel: diagnostics?.fallbackFromModel,
          providerFallbackToModel: diagnostics?.fallbackToModel,
          providerFinalModel: diagnostics?.finalModel,
          providerUsingFallback: diagnostics?.usingFallback,
          singleReadOnlyStreak: 0,
          batchReadSuggestionCount: 0,
          localFastPathUsed: false,
        });
      }
    }

    const commandMeta = {
      id: command.id,
      name: command.name,
      source: command.source,
      success: result.success,
    };

    if (output) {
      this.events.append({
        role: result.success ? 'system' : 'error',
        title: `/${command.name}`,
        content: output,
        command: commandMeta,
      });
    }

    if (result.output) {
      this.events.append({
        role: result.success ? 'system' : 'error',
        title: `/${command.name}`,
        content: result.output,
        command: commandMeta,
      });
    }

    if (result.error) {
      this.events.append({
        role: 'error',
        title: `/${command.name}`,
        content: result.error,
        errorLayer: 'runtime',
        command: commandMeta,
      });
    }

    if (result.sessionPicker) {
      this.events.showSessionPicker(result.sessionPicker);
      return;
    }

    if (result.modelPicker) {
      this.events.showModelPicker?.(result.modelPicker);
      return;
    }

    if (result.editPreview) {
      this.events.showEditPreview(result.editPreview);
      return;
    }

    if (result.effortEvent) {
      this.events.effortEvent?.(result.effortEvent);
    }

    if (result.continueAsChat) {
      await this.runChat(result.chatInput ?? parsed.args, options);
    }
  }

  async runRequest(
    request: import('./goals/types').AgentTurnRequest,
    options: RunInputOptions = {}
  ): Promise<void> {
    const internalInput =
      request.text?.trim() ||
      'Continue pursuing the active goal from its persisted plan and evidence.';
    const run = () =>
      this.runInput(internalInput, {
        ...options,
        persistAsUserMessage: request.persistAsUserMessage,
        inputKind: request.inputKind,
      });
    if (!request.goal) {
      await run();
      return;
    }
    await goalTraceContext.run(
      {
        goalId: request.goal.goalId,
        goalRevision: request.goal.revision,
        goalInputKind: request.inputKind,
        getStopReason: () => this.goalCoordinator?.goal?.stopReason?.message,
      },
      run
    );
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
    setDiagnosticTraceContext({
      traceId: `${sessionId ?? 'local'}:${turnId}`,
      ...(sessionId ? { sessionId } : {}),
      turnId,
    });
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
    if (options.persistAsUserMessage !== false) {
      this.runtime.store.addMessage({ role: 'user', content: input });
    }
    this.events.setStatus(`Running local ${action.label}...`);

    try {
      const tool = getRuntimeTools().find(candidate => candidate.name === action.tool);
      if (!tool) {
        throw new LocalFastPathBlockedError(`Local fast path tool ${action.tool} is unavailable.`);
      }
      const effectivePermissionMode = this.runtime.store.getEffectivePermissionMode();
      const toolAllowlist = this.resolveToolAllowlist();
      const toolContext = {
        cwd: this.runtime.cwd,
        config: {
          name: this.runtime.config.name,
          mode: this.runtime.config.mode,
        },
        sessionId,
        turnId,
        permissionMode: effectivePermissionMode,
        toolAllowlist,
        toolConfirmation: this.runtime.config.toolConfirmation,
        confirmToolUse:
          effectivePermissionMode === 'auto' ? undefined : this.controllerOptions.confirmToolUse,
      };
      let permission;
      try {
        permission = tool.checkPermissions?.(action.args, toolContext);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new LocalFastPathBlockedError(`Permission check failed closed: ${detail}`);
      }
      const effective = resolveEffectivePermission({
        toolName: action.tool,
        tool,
        args: action.args,
        permission,
        permissionMode: effectivePermissionMode,
        allowlist: toolAllowlist?.(action.tool, action.args),
        toolConfirmation: this.runtime.config.toolConfirmation,
      });

      if (effective.outcome === 'deny') {
        throw new LocalFastPathBlockedError(
          effective.reason ||
            `Local fast path blocked by ${effective.source ?? 'permission policy'}.`
        );
      }
      if (effective.outcome === 'confirm') {
        if (
          this.runtime.config.toolConfirmation === 'deny' ||
          !this.controllerOptions.confirmToolUse
        ) {
          throw new LocalFastPathBlockedError(
            effective.reason || 'Local fast path requires user confirmation.'
          );
        }
        const approved = await this.controllerOptions.confirmToolUse({
          name: action.tool,
          args: action.args,
          reason: effective.reason,
          abortSignal: options.abortSignal,
        });
        if (!approved) {
          throw new LocalFastPathBlockedError(
            `Local fast path ${action.tool} requires confirmation and was denied by user.`
          );
        }
      }

      if (options.abortSignal?.aborted) {
        throw new LocalFastPathBlockedError('Local fast path was cancelled before tool execution.');
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
        applySessionEffort(this.runtime, this.events, session);
        const renderer =
          this.controllerOptions.uiRenderer ?? this.runtime.config.ui?.renderer ?? 'terminal';
        this.events.replaceTranscript(
          sessionMessagesToTranscriptEntries(session.id, {
            includeToolOutputViews: renderer === 'tui',
          })
        );
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
      clearView: () => {
        if (this.events.clearView) {
          this.events.clearView();
        } else {
          this.events.clearTranscript();
        }
      },
      requestShutdown: reason => {
        this.events.shutdownRequested?.(reason);
      },
      uiRenderer:
        this.controllerOptions.uiRenderer ?? this.runtime.config.ui?.renderer ?? 'terminal',
      uiCapabilities: resolveUiRendererCapabilities(
        this.controllerOptions.uiCapabilities,
        this.controllerOptions.uiRenderer ?? this.runtime.config.ui?.renderer
      ),
      agentModeLifecycle: this.controllerOptions.agentModeLifecycle,
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
    if (usage.modelRequests === 0 && usage.toolCalls === 0 && usage.usageComplete === true)
      return stats;
    const subtaskCount = bundle.getSubtaskCount();
    const subagentSuffix = `subagents: ${usage.modelRequests} req/${usage.toolCalls} calls across ${subtaskCount} task(s)`;
    return {
      ...stats,
      llmRequests: (stats.llmRequests ?? 0) + usage.modelRequests,
      toolCalls: (stats.toolCalls ?? 0) + usage.toolCalls,
      readOnlyToolCalls: (stats.readOnlyToolCalls ?? 0) + usage.toolCalls,
      subagentPromptTokens: usage.promptTokens,
      subagentCompletionTokens: usage.completionTokens,
      subagentTotalTokens: usage.promptTokens + usage.completionTokens,
      usageAccountingComplete:
        (stats as GoalAccountingLoopStats).usageAccountingComplete !== false &&
        usage.usageComplete === true,
      continuationHint: stats.continuationHint
        ? `${stats.continuationHint} (${subagentSuffix})`
        : subagentSuffix,
    };
  }

  private async runChat(input: string, options: RunInputOptions = {}): Promise<void> {
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

    // Usage belongs to a single root turn. Clear the previous snapshot before
    // any provider request so failures without usage cannot inherit stale data.
    this.runtime.store.setState({ tokenUsage: null });

    const abortSignal = options.abortSignal;
    const turnId = traceTurnId(options.turnId);
    const activeSession =
      this.runtime.getSession() ??
      this.runtime.ensureSession() ??
      loadSessionMeta(this.runtime.getSession()?.id ?? '');
    const sessionId = activeSession?.id;
    setDiagnosticTraceContext({
      traceId: `${sessionId ?? 'unsaved'}:${turnId}`,
      ...(sessionId ? { sessionId } : {}),
      turnId,
    });
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

    if (sessionId && options.persistAsUserMessage !== false) {
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

    if (options.persistAsUserMessage !== false) {
      this.runtime.store.addMessage({ role: 'user', content: input });
    }
    refreshProjectInstructions(this.runtime.store, this.runtime.cwd);
    const snapshot = this.runtime.store.getSnapshot();
    const effectivePermissionMode = this.runtime.store.getEffectivePermissionMode();
    const onPlanModeChange = createPlanModeChangeHandler(
      this.runtime.store,
      this.controllerOptions.agentModeLifecycle
    );
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
    const intent = harness.updateContractFromUserInput(
      options.inputKind === 'goal_continuation'
        ? (this.goalCoordinator?.goal?.objective ?? input)
        : input
    );
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
            onSubtaskResult: (result, _batchId, objective, researchContext) => {
              if (!projectPath) return;
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

              // v0.1.4 Research-to-Evidence integration: normalize every
              // terminal research result (including partial/failure states),
              // persist it under a packet-specific CAS scope, and forward the
              // canonical lifecycle stream to every renderer.
              if (result.role !== 'research' || !sessionId) return;
              try {
                const goal = this.goalCoordinator?.goal;
                const objectiveRevision = goal?.contract?.objectiveRevision;
                const hasGoalBinding =
                  typeof goal?.goalId === 'string' && typeof objectiveRevision === 'number';
                // Preserve the authoritative request produced from the
                // original subtask capability. Reconstruct local-only only for
                // legacy callers that predate the additive callback context.
                const baseRequest =
                  researchContext?.request ??
                  createLocalResearchRequest(
                    objective?.trim() || result.summary || 'repository research',
                    projectPath
                  );
                const request = {
                  ...baseRequest,
                  scope: { ...baseRequest.scope, projectRoot: projectPath },
                  ...(hasGoalBinding
                    ? {
                        goalBinding: {
                          goalId: goal!.goalId,
                          objectiveRevision,
                        },
                      }
                    : {}),
                };
                const packet = subtaskResultToPacket(
                  result,
                  request,
                  {
                    projectPath,
                    sessionId,
                    ...(hasGoalBinding ? { goalId: goal!.goalId, objectiveRevision } : {}),
                  },
                  {
                    externalSources: researchContext?.web?.sources,
                    externalNotes: researchContext?.web?.notes,
                    externalTimedOut: researchContext?.web?.timedOut,
                    externalAborted: researchContext?.web?.aborted,
                  }
                );
                // Citation resolution can downgrade claims and mark superseded
                // same-URL sources stale. Resolve before validation/persistence so
                // the CAS token, durable packet and renderer view describe the
                // exact same final state (#105).
                const resolution = resolveCitations(packet);
                const validation = validatePacket(packet);
                if (!validation.ok) return;

                const saved = saveResearchPacket(createFileArtifactStore(projectPath), packet, {
                  projectPath,
                  sessionId,
                  packetId: packet.packetId,
                  ...(packet.goalId ? { goalId: packet.goalId } : {}),
                });
                const view = buildResearchView(packet, resolution);
                for (const event of toLifecycleEvents(view, resolution)) {
                  this.events.researchEvent?.(event);
                }
                recordTraceEvent(this.events, sessionId, {
                  turnId: String(turnId),
                  type: 'subtask_artifact_stored',
                  name: `research:${packet.packetId}`,
                  argsSummary: `${view.stage}/${view.auditStatus}: ${packet.summary}`.slice(0, 200),
                  argsArtifactId: `research-${saved.casToken.slice(0, 16)}`,
                  argsBytes: Buffer.byteLength(JSON.stringify(packet), 'utf8'),
                });
              } catch {
                // Research persistence/rendering is observational. A storage
                // failure must not alter the child result or root turn state.
              }
            },
            // R6: wire live permission state so the subagent policy gate can
            // prevent background delegation while the user is deciding a tool
            // permission. Injected by AgentRuntimeController via chatOptions.
            hasPendingPermission: this.controllerOptions.hasPendingPermission,
            // R6: wire child usage callback so CostTracker records subagent
            // token consumption. Injected by AgentRuntimeController via chatOptions.
            onChildUsage: this.controllerOptions.onChildUsage,
            beforeProviderRequest: this.controllerOptions.beforeProviderRequest,
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
      planMode: snapshot.planMode || snapshot.agentMode === 'plan',
      agentMode: snapshot.agentMode,
      goalContent:
        this.goalCoordinator?.goal?.status === 'active'
          ? buildGoalContextFragment(this.goalCoordinator.goal)?.text
          : undefined,
    };
    const systemPrompt = buildSystemPrompt(promptCtx);
    const messages: Message[] = [
      { role: 'system', content: systemPrompt.static, cacheControl: { type: 'ephemeral' } },
      ...(systemPrompt.dynamic ? [{ role: 'system' as const, content: systemPrompt.dynamic }] : []),
      ...snapshot.conversationHistory,
      ...(options.persistAsUserMessage === false
        ? [{ role: 'user' as const, content: input }]
        : []),
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
        // Tools that fan out to other tools (batch_read) have to re-run the
        // permission gate per sub-step; they need the mode and the allowlist.
        permissionMode: effectivePermissionMode,
        toolAllowlist: this.resolveToolAllowlist(),
        toolConfirmation: this.runtime.config.toolConfirmation,
        confirmToolUse:
          effectivePermissionMode === 'auto' ? undefined : this.controllerOptions.confirmToolUse,
        onPlanModeChange,
      });
    };

    const resolvedLoopBudget = resolveRuntimeLoopBudget(
      input,
      this.runtime.config,
      harness.toJSON()
    );
    const loopBudget =
      options.inputKind === 'goal_continuation'
        ? capAutonomousGoalLoopBudget(resolvedLoopBudget)
        : resolvedLoopBudget;
    let observedTurnsStarted = 0;
    let observedLlmRequests = 0;
    let observedToolCalls = 0;
    let observedReadOnlyToolCalls = 0;
    let observedUnsafeToolCalls = 0;
    let observedToolResultBytes = 0;
    let observedModelVisibleToolBytes = 0;
    const restoreProviderPreflight =
      typeof this.runtime.llm.setProviderRequestPreflight === 'function'
        ? this.runtime.llm.setProviderRequestPreflight(this.controllerOptions.beforeProviderRequest)
        : undefined;

    const persistInterruptedAccounting = (
      rootUsage: { promptTokens: number; completionTokens: number } | undefined,
      stats: LoopStats,
      usageAccountingComplete: boolean
    ): void => {
      const accountingStats: GoalAccountingLoopStats = {
        ...stats,
        finishReason: 'cancelled',
        usageAccountingComplete,
      };
      const interruptedStats = this.foldSubagentUsage(
        accountingStats,
        subagentBundle
      ) as GoalAccountingLoopStats;
      this.setLoopStats(interruptedStats);

      const subagentUsage = subagentBundle?.getAggregateUsage();
      const knownZeroRootUsage = usageAccountingComplete && interruptedStats.llmRequests === 0;
      if (rootUsage || knownZeroRootUsage) {
        this.runtime.store.setTokenUsage({
          promptTokens: (rootUsage?.promptTokens ?? 0) + (subagentUsage?.promptTokens ?? 0),
          completionTokens:
            (rootUsage?.completionTokens ?? 0) + (subagentUsage?.completionTokens ?? 0),
        });
      }
    };

    try {
      for await (const event of query({
        messages,
        tools: turnTools,
        toolExecutor,
        llm: this.runtime.llm,
        streamCallbacks,
        costTracker: snapshot.costTracker,
        permissionMode: effectivePermissionMode,
        toolConfirmation: this.runtime.config.toolConfirmation,
        toolAllowlist: this.resolveToolAllowlist(),
        confirmToolUse:
          effectivePermissionMode === 'auto' ? undefined : this.controllerOptions.confirmToolUse,
        toolContext: {
          cwd: this.runtime.cwd,
          config: {
            name: this.runtime.config.name,
            mode: this.runtime.config.mode,
          },
          sessionId,
          turnId,
          permissionMode: effectivePermissionMode,
          toolAllowlist: this.resolveToolAllowlist(),
          toolConfirmation: this.runtime.config.toolConfirmation,
          confirmToolUse:
            effectivePermissionMode === 'auto' ? undefined : this.controllerOptions.confirmToolUse,
          onPlanModeChange,
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
            const checkpointId = `${turnId}-${checkpointSequence + 1}-${randomUUID()}`;
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
          case 'warning':
            this.events.append({
              role: 'status',
              statusTone: 'warning',
              title: 'harness',
              content: event.message,
            });
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
        const stats =
          pendingCompleteStats ??
          createFailedLoopStats({
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
        persistInterruptedAccounting(
          finalUsage,
          stats,
          finalUsage !== undefined || stats.llmRequests === 0
        );
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
      if (error instanceof ProviderRetryExhaustedError) {
        const diag = error.diagnostics;
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
        } catch {
          /* best effort */
        }

        return;
      }
      if (isAbortError(error, abortSignal)) {
        const interruptedStats =
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
        const interruptedRootUsage =
          error instanceof QueryLoopError ? error.aggregateUsage : undefined;
        // A thrown abort after a provider request started can only prove a
        // lower bound: the in-flight request may be billable even when its
        // final usage chunk never arrived.
        persistInterruptedAccounting(
          interruptedRootUsage,
          interruptedStats,
          interruptedStats.llmRequests === 0
        );
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
      const failedStats = this.foldSubagentUsage(
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
            }),
        subagentBundle
      );
      const rootUsage = error instanceof QueryLoopError ? error.aggregateUsage : undefined;
      const subagentUsage = subagentBundle?.getAggregateUsage();
      const hasSubagentUsage =
        (subagentUsage?.promptTokens ?? 0) > 0 || (subagentUsage?.completionTokens ?? 0) > 0;
      if (rootUsage || hasSubagentUsage) {
        this.runtime.store.setTokenUsage({
          promptTokens: (rootUsage?.promptTokens ?? 0) + (subagentUsage?.promptTokens ?? 0),
          completionTokens:
            (rootUsage?.completionTokens ?? 0) + (subagentUsage?.completionTokens ?? 0),
        });
      }
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
        // A failed turn must not leave the user's prompt dangling in the
        // persisted session (it would replay on resume). The in-memory history
        // is cleaned above (2969-2972); mirror that for the on-disk transcript.
        if (options.persistAsUserMessage !== false) {
          removeTrailingSessionUserMessage(sessionId);
        }
      }
      const history = this.runtime.store.getSnapshot().conversationHistory;
      if (history.length > 0) {
        this.runtime.store.setState({ conversationHistory: history.slice(0, -1) });
      }
    } finally {
      restoreProviderPreflight?.();
    }
  }
}

/** @deprecated Use AgentChatController. Chat execution is renderer-independent. */
export { AgentChatController as InkChatController };

export function loadSessionIntoRuntime(runtime: OrionCodeUiRuntime, sessionId: string): string {
  const history = loadSessionHistory(sessionId);
  runtime.store.setState({ conversationHistory: history });
  runtime.store.setState({
    harnessState: loadSessionHarnessState(sessionId) ?? loadSessionMeta(sessionId)?.harnessState,
  });
  return `Restored ${history.length} messages`;
}

export function closeSession(runtime: OrionCodeUiRuntime): void {
  const session = runtime.getSession();
  if (!session) return;
  const messages = readSessionMessages(session.id);
  if (messages.length > 0) {
    updateSessionSummary(session.id, messages);
  }
  endSession(session.id);
}
