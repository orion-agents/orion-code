import { findCommand, getVisibleCommands } from '../commands';
import { parseInput } from '../commands/parser';
import type { CommandContext, CommandResult, RegisteredSlashCommand } from '../commands/types';
import { isTargetCommand, parseTargetCommand } from '../commands/target-command';
import type {
  AgentRuntimeEventSink,
  AgentRuntimeInput,
  AgentRuntimeInputResult,
  AgentRuntimeInterruptResult,
  AgentRuntimeSubmitResult,
} from './agent-runtime-protocol';
import {
  createAgentRuntimeEventSinkFromUiEvents,
  createUiEventSinkFromAgentRuntimeEvents,
} from './agent-runtime-protocol';
import { permissionPendingStatus } from './agent-status';
import type { AgentRuntimeRunnerV1, AgentRuntimeRunInputOptionsV1 } from './agent-runtime-runner';
import type {
  OrionCodeUiRuntime,
  FollowupQueueItem,
  ToolPermissionRequest,
  TranscriptAppendEntry,
  UiEventSink,
  UiRendererCapabilities,
} from './ui-events';
import { resolveUiRendererCapabilities } from './ui-events';
import type { CommandUiRenderer } from '../commands/types';
import { TurnController, type TurnControllerOptions } from './turn-controller';
import type { AgentTurnRequest } from './goals/types';
import type { GoalRuntimeControlResultV2, GoalRuntimeControlV2 } from './goal-runtime-coordinator';
import { updateGlobalConfig } from '../services/global-config';
import type { ToolConfirmationPolicy } from '../services/global-config';
import {
  grantToolPermission,
  isToolPermissionScope,
  type ToolPermissionScope,
} from '../services/tool-allowlist';
import { AgentModeLifecycleController } from '../framework/agent-mode';
import { sanitizeTerminalText } from '../tui-core/style';

export type {
  AgentRuntimeInput,
  AgentRuntimeInputResult,
  AgentRuntimeInterruptResult,
  AgentRuntimeSubmitResult,
} from './agent-runtime-protocol';

export type AgentRuntimeRunner = AgentRuntimeRunnerV1;
export type RunInputOptions = AgentRuntimeRunInputOptionsV1;

export interface AgentRuntimeToolPermissionRequest {
  name: string;
  args: Record<string, unknown>;
  reason?: string;
  abortSignal?: AbortSignal;
}

export interface AgentRuntimeControllerOptions extends TurnControllerOptions {
  runtime: OrionCodeUiRuntime;
  events?: UiEventSink;
  eventSink?: AgentRuntimeEventSink;
  runner?: AgentRuntimeRunner;
  /** Renderer presentation capabilities passed into command execution. */
  uiCapabilities?: UiRendererCapabilities;
  /** Active renderer adapter identity for renderer-layer diagnostics. */
  uiRenderer?: CommandUiRenderer;
  echoSubmittedInput?: boolean;
  runningStatus?: string | ((input: string) => string);
  readyStatus?: string | (() => string);
  useRuntimeToolPermissions?: boolean;
  restartingStatus?: string;
  revisionStatus?: string;
  commandWhileRunningStatus?: string;
  interruptedStatus?: string;
  exitPromptStatus?: string;
  beforeTurn?: (input: string) => void;
  afterTurnLoop?: () => void;
  onTurnError?: (error: unknown) => void;
  /** Optional lifecycle injection for deterministic runtime tests and embedders. */
  agentModeLifecycle?: AgentModeLifecycleController;
}

function isExitInput(input: string): boolean {
  const parsed = parseInput(input.trim());
  return parsed.isCommand && ['exit', 'quit', 'q'].includes(parsed.name);
}

function submittedEntry(input: string): TranscriptAppendEntry {
  const parsed = parseInput(input.trim());
  return {
    role: parsed.isCommand ? 'command' : 'user',
    title: parsed.isCommand ? 'command' : 'you',
    content: input,
  };
}

function statusText(
  value: string | ((input: string) => string) | undefined,
  input: string
): string {
  if (!value) return '';
  return typeof value === 'function' ? value(input) : value;
}

function resumeSessionInput(sessionId: string, allProjects?: boolean): string {
  return `/resume ${sessionId}${allProjects ? ' --all' : ''}`;
}

/**
 * UI-independent turn runner for interactive Orion Code surfaces.
 *
 * Renderers own local editing, overlays, cursor, and transcript layout. This
 * controller owns the shared coding-agent semantics: one active turn at a time,
 * live revision, abort cleanup, processing state, and Ctrl+C double-exit
 * intent. If different UIs need different visual behavior, they should adapt
 * these results and events instead of reimplementing the turn lifecycle.
 */
export class AgentRuntimeController {
  private readonly turnController: TurnController;
  private readonly runner: AgentRuntimeRunner;
  private readonly eventSink: AgentRuntimeEventSink;
  private readonly agentModeLifecycle: AgentModeLifecycleController;
  private readonly pendingPermissions = new Map<
    string,
    { request: AgentRuntimeToolPermissionRequest; finish: (approved: boolean) => void }
  >();
  private activeRun: Promise<void> | null = null;
  private readonly goalControlRuns = new Set<Promise<void>>();
  private stopping = false;
  private nextPermissionRequestId = 1;
  private readonly queuedCommands: string[] = [];
  private readonly followupQueue: FollowupQueueItem[] = [];
  private readonly followupQueueLimit = 16;
  private nextFollowupId = 1;
  constructor(private readonly options: AgentRuntimeControllerOptions) {
    if (!options.events && !options.eventSink) {
      throw new Error('AgentRuntimeController requires either events or eventSink');
    }

    this.turnController = new TurnController(options);
    const downstream =
      options.eventSink ?? createAgentRuntimeEventSinkFromUiEvents(options.events as UiEventSink);
    this.eventSink = {
      emit: event => {
        const result = downstream.emit(event);
        if (event.type === 'session_restored') {
          if (this.followupQueue.length > 0) {
            this.followupQueue.splice(0);
            this.emitFollowupQueue();
          }
        }
        return result;
      },
    };
    this.agentModeLifecycle =
      options.agentModeLifecycle ?? new AgentModeLifecycleController(options.runtime.store);
    this.agentModeLifecycle.subscribe(snapshot => {
      this.eventSink.emit({ type: 'agent_mode_changed', snapshot });
    });
    const events = createUiEventSinkFromAgentRuntimeEvents(this.eventSink);
    this.runner =
      options.runner ??
      options.runtime.createAgentRunner?.(events, {
        approvalHandler: request => this.requestToolPermission(request),
      }) ??
      createUnavailableRunner();
    this.emitAgentModeSnapshot();
  }

  hasActiveTurn(): boolean {
    return this.turnController.hasActiveTurn();
  }

  getFollowupQueue(): readonly FollowupQueueItem[] {
    return this.followupQueue;
  }

  /** Thin /goal control surface; GoalRuntimeCoordinatorV2 owns every mutation. */
  handleTargetInput(rawInput: string): {
    handled: boolean;
    statusText?: string;
    runtimeResult: AgentRuntimeSubmitResult;
  } {
    const parsed = parseTargetCommand(rawInput);
    if (!parsed.ok) {
      this.emitAppend({
        role: 'error',
        title: 'goal',
        content: parsed.error,
        errorLayer: 'runtime',
      });
      this.emitStatus(parsed.error);
      return {
        handled: true,
        statusText: parsed.error,
        runtimeResult: { type: 'command_handled' },
      };
    }
    return {
      handled: true,
      runtimeResult: this.startGoalControl(parsed.input),
    };
  }

  /** Goal controls remain available while a turn is active only when they can stop or inspect it. */
  canInterceptTargetCommand(input: string, duringActiveTurn: boolean): boolean {
    if (!isTargetCommand(input)) return false;
    const parsed = parseTargetCommand(input);
    if (!parsed.ok || !duringActiveTurn) return true;
    return ['status', 'pause', 'clear'].includes(parsed.input.action);
  }

  /** v0.1.1: emit clear_view event through the renderer protocol. */
  emitClearView(): void {
    this.eventSink.emit({ type: 'clear_view' });
  }

  /** v0.1.1: emit shutdown_requested event through the renderer protocol. */
  emitShutdownRequested(reason?: string): void {
    this.runner.interrupt?.(reason ?? 'shutdown requested');
    this.eventSink.emit({ type: 'shutdown_requested', reason });
  }

  setVerificationState(state: 'pending' | 'running' | 'passed' | 'failed' | 'gated'): void {
    this.turnController.setVerificationState(state);
  }

  getVerificationState(): 'pending' | 'running' | 'passed' | 'failed' | 'gated' | undefined {
    return this.turnController.getVerificationState();
  }

  clearExitIntent(): void {
    this.turnController.clearExitIntent();
  }

  handle(input: AgentRuntimeInput): AgentRuntimeInputResult {
    switch (input.type) {
      case 'submit':
        return this.submit(input.text);
      case 'queue_followup':
        return this.queueFollowup(input.text);
      case 'manage_followup_queue':
        return this.manageFollowupQueue(input.action, input.itemId);
      case 'select_session':
        return this.submit(resumeSessionInput(input.sessionId, input.allProjects));
      case 'permission_decision':
        return this.recordPermissionDecision(input.requestId, input.approved, input.scope);
      case 'interrupt':
        return this.interrupt();
      case 'clear_exit_intent':
        this.clearExitIntent();
        return { type: 'exit_intent_cleared' };
      case 'goal_control':
        return this.startGoalControl(input);
      case 'permission_mode_change':
        return this.applyPermissionModeChange(input.value);
      case 'cycle_agent_mode':
        return this.cycleAgentMode();
    }
  }

  private queueFollowup(input: string): AgentRuntimeInputResult {
    const text = input.trim();
    if (!text) return { type: 'empty' };
    if (!this.turnController.hasActiveTurn()) {
      this.emitStatus('Nothing is running; press Enter to submit this message now.');
      return { type: 'command_ignored' };
    }
    if (this.followupQueue.length >= this.followupQueueLimit) {
      this.emitStatus(`Follow-up queue is full (${this.followupQueueLimit}).`);
      return { type: 'followup_queue_full' };
    }
    const item: FollowupQueueItem = {
      id: `followup-${this.nextFollowupId++}`,
      text,
      queuedAt: Date.now(),
    };
    this.followupQueue.push(item);
    this.emitFollowupQueue();
    this.emitStatus(`Queued follow-up ${this.followupQueue.length}/${this.followupQueueLimit}.`);
    return { type: 'followup_queued', itemId: item.id };
  }

  private manageFollowupQueue(
    action: 'clear' | 'remove',
    itemId?: string
  ): AgentRuntimeInputResult {
    if (action === 'clear') {
      this.followupQueue.splice(0);
    } else if (itemId) {
      const index = this.followupQueue.findIndex(item => item.id === itemId);
      if (index >= 0) this.followupQueue.splice(index, 1);
    }
    this.emitFollowupQueue();
    this.emitStatus(
      this.followupQueue.length > 0
        ? `${this.followupQueue.length} follow-up(s) queued.`
        : 'Follow-up queue is empty.'
    );
    return { type: 'followup_queue_changed' };
  }

  submit(input: string): AgentRuntimeSubmitResult {
    const submitted = input.trim();
    if (!submitted) return { type: 'empty' };

    if (isExitInput(submitted)) {
      this.emitShutdownRequested('user request');
      return { type: 'exit_requested' };
    }

    if (isTargetCommand(submitted)) {
      return this.handleTargetInput(submitted).runtimeResult;
    }

    const parsedInput = parseInput(submitted);
    if (parsedInput.isCommand && parsedInput.name === 'clear') {
      this.emitClearView();
      this.emitStatus('View cleared. Conversation context is preserved.');
      return { type: 'command_handled' };
    }

    if (parsedInput.isCommand && !findCommand(parsedInput.name)) {
      const message = `Unknown command /${parsedInput.name}. Use /help to list supported commands.`;
      this.emitAppend({ role: 'error', title: 'unknown command', content: message });
      this.emitStatus(message);
      return { type: 'command_handled' };
    }

    if (parsedInput.isCommand) {
      const command = findCommand(parsedInput.name) as RegisteredSlashCommand;
      this.activeRun = this.runCommand(command, parsedInput.args)
        .catch(error => this.handleRunLoopError(error))
        .finally(() => {
          this.activeRun = null;
        });
      return { type: 'command_handled' };
    }

    if (this.turnController.hasActiveTurn()) {
      const parsed = parseInput(submitted);
      if (parsed.isCommand) {
        const command = findCommand(parsed.name);
        if (!command) {
          this.emitStatus(`Unknown command /${parsed.name}; active turn continues.`);
          return { type: 'command_ignored' };
        }
        if (command.busyPolicy === 'reject-busy') {
          this.emitStatus(`/${command.name} rejected: an agent turn is active.`);
          return { type: 'command_rejected_busy', commandId: command.id };
        }
        if (command.busyPolicy === 'immediate') {
          this.emitImmediateCommandSnapshot(command.name);
          return { type: 'command_handled' };
        }
        if (this.queuedCommands.length >= 32) {
          this.emitStatus(`/${command.name} rejected: the command queue is full.`);
          return { type: 'command_rejected_busy', commandId: command.id };
        }
        this.queuedCommands.push(submitted);
        this.emitAppend(submittedEntry(submitted));
        this.emitStatus(`Queued /${command.name}; it will apply after the active logical request.`);
        return { type: 'command_queued', commandId: command.id };
      }

      this.turnController.clearExitIntent();
      this.turnController.requestRevision(submitted);
      // v0.1.3 (G1): echo the incremental input to the transcript immediately,
      // so the user sees their correction without waiting for the turn to abort.
      // A runtime-owned durable transcript disables this optimistic projection
      // and emits the revision from its authoritative user item instead.
      if (this.options.echoSubmittedInput ?? true) {
        this.emitAppend(submittedEntry(submitted));
      }
      this.emitStatus(this.options.revisionStatus ?? '已接收补充，正在中断当前轮…');
      return { type: 'revision_requested' };
    }

    const session = this.options.runtime.getSession() ?? this.options.runtime.ensureSession();
    const request: AgentTurnRequest = {
      inputKind: 'user',
      text: submitted,
      sessionId: session?.id ?? 'pending-session',
      persistAsUserMessage: true,
      echoToTranscript: true,
      generation: 0,
    };
    return this.submitTurnRequest(request);
  }

  private emitImmediateCommandSnapshot(name: string): void {
    const snapshot = this.options.runtime.store.getSnapshot?.() ?? {
      currentModel: this.options.runtime.config.model ?? 'unknown',
      agentMode: 'interactive',
      effortPreference: 'auto',
      resolvedEffort: null,
      tokenUsage: null,
    };
    if (name === 'help') {
      const roots = getVisibleCommands(this.options.uiRenderer)
        .filter(command => command.audience === 'primary')
        .slice(0, 12)
        .map(command => `/${command.name}`)
        .join('  ');
      this.emitAppend({ role: 'system', title: '/help', content: roots });
      this.emitStatus('Help snapshot shown; active turn continues.');
      return;
    }
    if (name === 'status') {
      this.emitStatus(
        `running model=${snapshot.currentModel} mode=${snapshot.agentMode} effort=${snapshot.resolvedEffort?.effective ?? snapshot.effortPreference}`
      );
      return;
    }
    if (name === 'usage') {
      const usage = snapshot.tokenUsage;
      this.emitStatus(
        `usage prompt=${usage?.promptTokens ?? 0} completion=${usage?.completionTokens ?? 0}`
      );
      return;
    }
    this.emitStatus(`/${name} acknowledged; active turn continues.`);
  }

  private async runCommand(command: RegisteredSlashCommand, args: string): Promise<void> {
    const renderer =
      this.options.uiRenderer ?? this.options.runtime.config.ui?.renderer ?? 'terminal';
    if (command.rendererScope && !command.rendererScope.includes(renderer)) {
      this.emitAppend({
        role: 'error',
        title: `/${command.name} unavailable`,
        content: `/${command.name} is not available in the ${renderer} renderer. Supported renderers: ${command.rendererScope.join(', ')}.`,
        errorLayer: 'runtime',
        command: commandIdentity(command, false),
      });
      return;
    }

    const context = this.createCommandContext();
    const { result, output } = await captureCommandOutput(() => command.execute(context, args));
    const commandMeta = commandIdentity(command, result.success);

    if (output) {
      this.emitAppend({
        role: result.success ? 'system' : 'error',
        title: `/${command.name}`,
        content: output,
        command: commandMeta,
      });
    }
    if (result.output) {
      this.emitAppend({
        role: result.success ? 'system' : 'error',
        title: `/${command.name}`,
        content: result.output,
        command: commandMeta,
      });
    }
    if (result.error) {
      this.emitAppend({
        role: 'error',
        title: `/${command.name}`,
        content: result.error,
        errorLayer: 'runtime',
        command: commandMeta,
      });
    }
    if (result.sessionPicker) {
      this.eventSink.emit({ type: 'session_picker_requested', request: result.sessionPicker });
    }
    if (result.modelPicker) {
      this.eventSink.emit({ type: 'model_picker_requested', request: result.modelPicker });
    }
    if (result.editPreview) {
      this.eventSink.emit({ type: 'edit_preview_requested', request: result.editPreview });
    }
    if (result.effortEvent) {
      this.eventSink.emit({ type: 'effort_event', event: result.effortEvent });
    }

    if (result.continueAsChat) {
      const session = this.options.runtime.getSession() ?? this.options.runtime.ensureSession();
      await this.runTurn({
        inputKind: 'user',
        text: result.chatInput ?? args,
        sessionId: session?.id ?? 'pending-session',
        persistAsUserMessage: true,
        echoToTranscript: true,
        generation: 0,
      });
    }
  }

  private createCommandContext(): CommandContext {
    const renderer =
      this.options.uiRenderer ?? this.options.runtime.config.ui?.renderer ?? 'terminal';
    return {
      cwd: this.options.runtime.cwd,
      config: this.options.runtime.config,
      store: this.options.runtime.store,
      llm: this.options.runtime.llm,
      compactCoordinator: this.options.runtime.compactCoordinator,
      modelCoordinator: this.options.runtime.modelCoordinator,
      sessionId: this.options.runtime.getSession()?.id,
      ensureSession: this.options.runtime.ensureSession,
      setSession: session => this.options.runtime.setSession(session),
      restoreSessionRuntime: this.runner.restoreSession
        ? () => this.runner.restoreSession!()
        : undefined,
      sessionRestored: event => this.eventSink.emit({ type: 'session_restored', event }),
      getSession: this.options.runtime.getSession,
      writeOutput: text => {
        if (text.trim()) this.emitAppend({ role: 'system', content: text });
      },
      writeLine: text => {
        if (text?.trim()) this.emitAppend({ role: 'system', content: text });
      },
      clearView: () => this.emitClearView(),
      requestShutdown: reason => this.emitShutdownRequested(reason),
      uiRenderer: renderer,
      uiCapabilities: resolveUiRendererCapabilities(this.options.uiCapabilities, renderer),
      agentModeLifecycle: this.agentModeLifecycle,
      getHarnessDiagnostics: this.options.runtime.getHarnessDiagnostics,
      compact: this.runner.compact ? input => this.runner.compact!(input) : undefined,
    };
  }

  private submitTurnRequest(request: AgentTurnRequest): AgentRuntimeSubmitResult {
    if (this.turnController.hasActiveTurn()) return { type: 'command_ignored' };
    if (!this.requestIsCurrent(request)) return { type: 'command_ignored' };

    this.activeRun = this.runTurn(request)
      .catch(error => {
        this.handleRunLoopError(error);
      })
      .finally(() => {
        this.activeRun = null;
      });
    return { type: 'started' };
  }

  interrupt(): AgentRuntimeInterruptResult {
    const shouldExit = this.turnController.registerExitIntent();
    if (this.turnController.hasActiveTurn() || this.goalControlRuns.size > 0) {
      this.turnController.interruptActiveTurn();
      this.runner.interrupt?.('user interrupted');
      if (shouldExit) return { type: 'exit_requested' };
      this.emitStatus(this.options.interruptedStatus ?? 'Interrupted. Press Ctrl+C again to exit.');
      return { type: 'interrupted' };
    }

    if (shouldExit) return { type: 'exit_requested' };
    this.emitStatus(this.options.exitPromptStatus ?? 'Press Ctrl+C again to exit.');
    return { type: 'exit_prompt' };
  }

  async stopActiveTurn(): Promise<void> {
    this.stopping = true;
    this.turnController.interruptActiveTurn();
    this.runner.interrupt?.('runtime stopping');
    this.rejectPendingPermissions();
    await this.waitForIdle().catch(() => undefined);
    // Reset stopping flag so subsequent turns can execute.
    this.stopping = false;
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([this.activeRun ?? Promise.resolve(), ...this.goalControlRuns]);
  }

  private async runTurn(firstRequest: AgentTurnRequest): Promise<void> {
    let nextRequest: AgentTurnRequest | undefined = firstRequest;

    while (nextRequest && !this.stopping) {
      if (!this.requestIsCurrent(nextRequest)) break;
      const request: AgentTurnRequest = nextRequest;
      const planCompletionBeforeRequest = this.agentModeLifecycle.completionRevision();
      const nextInput = request.text?.trim() || 'Continue from the latest durable context.';
      if (
        (this.options.echoSubmittedInput ?? true) &&
        request.echoToTranscript &&
        !request.alreadyEchoed
      ) {
        this.emitAppend(submittedEntry(nextInput));
      }
      this.options.beforeTurn?.(nextInput);

      const turn = this.turnController.beginTurn(nextInput);
      this.options.runtime.store.setProcessing(true);
      this.emitProcessing(true);
      const runningStatus = statusText(this.options.runningStatus, nextInput);
      if (runningStatus) this.emitStatus(runningStatus);

      try {
        if (this.runner.runRequest) {
          await this.runner.runRequest(request, {
            abortSignal: turn.abortSignal,
            turnId: turn.id,
          });
        } else {
          await this.runner.runInput(nextInput, {
            abortSignal: turn.abortSignal,
            turnId: turn.id,
            persistAsUserMessage: request.persistAsUserMessage,
            inputKind: request.inputKind,
          });
        }
      } catch (error) {
        if (!turn.abortSignal.aborted) {
          if (this.options.onTurnError) this.options.onTurnError(error);
          else {
            const message = error instanceof Error ? error.message : String(error);
            this.emitAppend({ role: 'error', content: `Error: ${message}` });
          }
        }
      } finally {
        const revision = this.turnController.finishTurn(turn.id);
        const completedPlan =
          this.agentModeLifecycle.completedPlanSince(planCompletionBeforeRequest) ?? undefined;
        if (!completedPlan) this.agentModeLifecycle.applyPending();

        if (revision?.trim()) {
          this.emitStatus(this.options.restartingStatus ?? '根据补充调整方向中…');
          nextRequest = {
            inputKind: 'revision',
            text: revision,
            sessionId: this.options.runtime.getSession()?.id ?? request.sessionId,
            persistAsUserMessage: true,
            echoToTranscript: true,
            alreadyEchoed: true,
            generation: 0,
          };
        } else if (completedPlan) {
          nextRequest = {
            inputKind: 'plan_execution',
            text: `Execute the saved plan now. Continue autonomously from the plan and verify the result.\n\n${completedPlan}`,
            sessionId: this.options.runtime.getSession()?.id ?? request.sessionId,
            persistAsUserMessage: false,
            echoToTranscript: false,
            generation: 0,
          };
          this.emitStatus('Plan saved · starting execution in the selected mode.');
        } else {
          const queuedCommand = this.queuedCommands.shift();
          const queuedFollowup = queuedCommand ? undefined : this.followupQueue.shift();
          if (queuedFollowup) this.emitFollowupQueue();
          const queuedInput = queuedCommand ?? queuedFollowup?.text;
          nextRequest = queuedInput
            ? {
                inputKind: 'user',
                text: queuedInput,
                sessionId: this.options.runtime.getSession()?.id ?? request.sessionId,
                persistAsUserMessage: true,
                echoToTranscript: false,
                alreadyEchoed: true,
                generation: 0,
              }
            : undefined;
        }
      }
    }

    this.options.runtime.store.setProcessing(false);
    this.emitProcessing(false);
    if (!this.stopping) {
      const readyStatus =
        typeof this.options.readyStatus === 'function'
          ? this.options.readyStatus()
          : this.options.readyStatus;
      if (readyStatus) this.emitStatus(readyStatus);
      this.options.afterTurnLoop?.();
    }
  }

  private handleRunLoopError(error: unknown): void {
    if (this.options.onTurnError) {
      this.options.onTurnError(error);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      this.emitAppend({
        role: 'error',
        content: `[RUNTIME] Error: ${message}`,
        errorLayer: 'runtime',
      });
    }

    this.options.runtime.store.setProcessing(false);
    this.emitProcessing(false);
    const readyStatus =
      typeof this.options.readyStatus === 'function'
        ? this.options.readyStatus()
        : this.options.readyStatus;
    if (readyStatus) this.emitStatus(readyStatus);
    this.options.afterTurnLoop?.();
  }

  private emitAppend(entry: TranscriptAppendEntry): string | void {
    return this.eventSink.emit({ type: 'transcript_append', entry });
  }

  private emitStatus(message: string): void {
    this.eventSink.emit({ type: 'status_changed', message });
  }

  private emitProcessing(processing: boolean): void {
    this.eventSink.emit({ type: 'processing_changed', processing });
  }

  private emitFollowupQueue(): void {
    this.eventSink.emit({
      type: 'followup_queue_changed',
      snapshot: { items: [...this.followupQueue], limit: this.followupQueueLimit },
    });
  }

  private emitAgentModeSnapshot(): void {
    this.eventSink.emit({
      type: 'agent_mode_changed',
      snapshot: this.agentModeLifecycle.snapshot(),
    });
  }

  private cycleAgentMode(): AgentRuntimeInputResult {
    const deferred = this.turnController.hasActiveTurn();
    const snapshot = this.agentModeLifecycle.cycle({ defer: deferred });
    return {
      type: 'agent_mode_changed',
      snapshot,
      appliesFrom: deferred ? 'next-logical-request' : 'immediate',
    };
  }

  private requestIsCurrent(request: AgentTurnRequest): boolean {
    const activeSessionId = this.options.runtime.getSession()?.id;
    return !activeSessionId || request.sessionId === activeSessionId;
  }

  async requestToolPermission(request: AgentRuntimeToolPermissionRequest): Promise<boolean> {
    if (request.abortSignal?.aborted || this.stopping) return false;

    const id = `permission-${this.nextPermissionRequestId++}`;
    const runtimeRequest: ToolPermissionRequest = {
      id,
      name: request.name,
      args: request.args,
      reason: request.reason,
      abortSignal: request.abortSignal,
    };

    return new Promise<boolean>(resolve => {
      const finish = (approved: boolean) => {
        this.pendingPermissions.delete(id);
        request.abortSignal?.removeEventListener('abort', onAbort);
        resolve(approved);
      };
      const onAbort = () => finish(false);

      this.pendingPermissions.set(id, { request, finish });
      request.abortSignal?.addEventListener('abort', onAbort, { once: true });
      this.emitStatus(permissionPendingStatus(request.name));
      this.eventSink.emit({ type: 'permission_requested', request: runtimeRequest });
    });
  }

  private startGoalControl(control: GoalRuntimeControlV2): AgentRuntimeSubmitResult {
    const goalControl = normalizeGoalRuntimeControl(control);
    if (!this.runner.controlGoal) {
      const message = 'Goal runtime is unavailable for the active product session.';
      this.emitAppend({ role: 'error', title: 'goal', content: message, errorLayer: 'runtime' });
      this.emitStatus(message);
      return { type: 'command_handled' };
    }
    if (
      (this.turnController.hasActiveTurn() || this.goalControlRuns.size > 0) &&
      (goalControl.action === 'create' || goalControl.action === 'resume')
    ) {
      const message = `/goal ${goalControl.action} is unavailable while Goal work is running; use /goal pause or /goal clear first.`;
      this.emitStatus(message);
      return { type: 'command_ignored' };
    }
    if (goalControl.action === 'pause' || goalControl.action === 'clear') {
      this.turnController.clearExitIntent();
      this.turnController.interruptActiveTurn();
      this.runner.interrupt?.(`goal ${goalControl.action}`);
      this.rejectPendingPermissions();
    }

    const run = this.runner
      .controlGoal(goalControl)
      .then(result => this.renderGoalControl(result))
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        this.emitAppend({ role: 'error', title: 'goal', content: message, errorLayer: 'runtime' });
        this.emitStatus(message);
      })
      .finally(() => {
        this.goalControlRuns.delete(run);
      });
    this.goalControlRuns.add(run);
    return { type: 'started' };
  }

  private renderGoalControl(result: GoalRuntimeControlResultV2): void {
    const summary = formatGoalRuntimeStatus(result);
    this.emitAppend({
      role: result.accepted ? 'system' : 'error',
      title: 'goal',
      content: summary,
      ...(result.accepted ? {} : { errorLayer: 'runtime' as const }),
    });
    this.emitStatus(summary);
  }

  private recordPermissionDecision(
    requestId: string,
    approved: boolean,
    scope: ToolPermissionScope = 'once'
  ): AgentRuntimeInputResult {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return { type: 'permission_decision_ignored' };
    if (!isToolPermissionScope(scope)) {
      const reason = `Invalid permission scope: ${String(scope)}`;
      pending.finish(false);
      this.emitStatus(`Permission denied: ${reason}`);
      return { type: 'permission_decision_failed', reason };
    }
    if (approved && scope !== 'once') {
      try {
        grantToolPermission(scope, this.options.runtime.cwd, pending.request.name);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        pending.finish(false);
        this.emitStatus(
          `Permission was not saved; ${pending.request.name} remains denied: ${reason}`
        );
        return { type: 'permission_decision_failed', reason };
      }
    }
    pending.finish(approved);
    if (approved) {
      const suffix =
        scope === 'global'
          ? ' for all projects'
          : scope === 'project'
            ? ' for this project'
            : ' once';
      this.emitStatus(`Allowed ${pending.request.name}${suffix}`);
    }
    return { type: 'permission_decision_recorded' };
  }

  private applyPermissionModeChange(value: ToolConfirmationPolicy): AgentRuntimeInputResult {
    const allowed: ToolConfirmationPolicy[] = ['allow', 'ask', 'deny'];
    if (!allowed.includes(value)) return { type: 'permission_mode_invalid' };
    // Persist to disk so the change survives restart...
    updateGlobalConfig({ toolConfirmation: value });
    // ...and mutate the live runtime config so the very next tool call uses it
    // immediately (chat-controller passes this.runtime.config.toolConfirmation into
    // the scheduler on every turn).
    this.options.runtime.config.toolConfirmation = value;
    this.emitStatus(`Tool confirmation → ${value}`);
    return { type: 'permission_mode_changed' };
  }

  private rejectPendingPermissions(): void {
    const pending = [...this.pendingPermissions.values()];
    this.pendingPermissions.clear();
    for (const entry of pending) {
      entry.finish(false);
    }
  }
}

function formatGoalRuntimeStatus(result: GoalRuntimeControlResultV2): string {
  const state = result.state;
  if (!state) return result.message;
  const objective =
    state.objective.length > 80 ? `${state.objective.slice(0, 77)}...` : state.objective;
  return [
    result.message,
    `Goal: [${state.status}] ${objective}`,
    `Progress: ${state.continuationCount} turns · ${state.tokensUsed}/${state.budget.maxTokens} tokens · ${state.elapsedMs}/${state.budget.maxElapsedMs}ms`,
  ].join('\n');
}

function normalizeGoalRuntimeControl(control: GoalRuntimeControlV2): GoalRuntimeControlV2 {
  if (control.action === 'create') {
    return {
      action: 'create',
      objective: control.objective,
      ...(control.budget ? { budget: control.budget } : {}),
    };
  }
  return { action: control.action };
}

function commandIdentity(command: RegisteredSlashCommand, success: boolean) {
  return {
    id: command.id,
    name: command.name,
    source: command.source,
    success,
  };
}

async function captureCommandOutput(
  execute: () => CommandResult | Promise<CommandResult>
): Promise<{ result: CommandResult; output: string }> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const capture = (...values: unknown[]): void => {
    const line = values
      .map(value => {
        if (typeof value === 'string') return value;
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      })
      .join(' ');
    lines.push(sanitizeTerminalText(line));
  };

  console.log = capture;
  console.error = capture;
  console.warn = capture;
  try {
    return { result: await execute(), output: lines.join('\n').trim() };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }
}

function createUnavailableRunner(): AgentRuntimeRunnerV1 {
  return {
    async runInput(): Promise<void> {
      throw new Error(
        'No OrionRuntimeV1 runner is configured. Initialize the product runtime before submitting a turn.'
      );
    },
  };
}
