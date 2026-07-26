import { parseInput } from '../commands/parser';
import { isTargetCommand } from '../commands/target-command';
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
import { AgentChatController, type AgentChatControllerOptions, type RunInputOptions } from './chat-controller';
import { resolveUiRendererCapabilities } from './ui-events';
import type { OpenHorseUiRuntime, ToolPermissionRequest, TranscriptAppendEntry, UiEventSink, UiRendererCapabilities } from './ui-events';
import type { CommandUiRenderer } from '../commands/types';
import { TurnController, type TurnControllerOptions } from './turn-controller';

export type {
  AgentRuntimeInput,
  AgentRuntimeInputResult,
  AgentRuntimeInterruptResult,
  AgentRuntimeSubmitResult,
} from './agent-runtime-protocol';

export interface AgentRuntimeRunner {
  runInput(input: string, options?: RunInputOptions): Promise<void>;
}

export interface AgentRuntimeToolPermissionRequest {
  name: string;
  args: Record<string, unknown>;
  reason?: string;
  abortSignal?: AbortSignal;
}

export interface AgentRuntimeControllerOptions extends TurnControllerOptions {
  runtime: OpenHorseUiRuntime;
  events?: UiEventSink;
  eventSink?: AgentRuntimeEventSink;
  runner?: AgentRuntimeRunner;
  /** Renderer presentation capabilities passed into command execution. */
  uiCapabilities?: UiRendererCapabilities;
  /** Active renderer adapter identity for renderer-layer diagnostics. */
  uiRenderer?: CommandUiRenderer;
  chatOptions?: AgentChatControllerOptions;
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

function statusText(value: string | ((input: string) => string) | undefined, input: string): string {
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
  private readonly pendingPermissions = new Map<string, (approved: boolean) => void>();
  private activeRun: Promise<void> | null = null;
  private stopping = false;
  private nextPermissionRequestId = 1;
  /** v0.2.24: optional goal coordinator for /target mode. */
  private goalCoordinator: import('./goals/coordinator').GoalCoordinator | null = null;

  /** v0.2.24: set the goal coordinator for /target mode. */
  setGoalCoordinator(coord: import('./goals/coordinator').GoalCoordinator): void {
    this.goalCoordinator = coord;
    // Wire goal tools to the coordinator so model can call get_goal/create_goal/update_goal.
    const { setGoalToolCoordinator } = require('./goals/tools') as typeof import('./goals/tools');
    setGoalToolCoordinator(coord);
    // Wire goal prompt injection into the chat controller.
    if ('setGoalCoordinator' in this.runner) {
      (this.runner as any).setGoalCoordinator(coord);
    }
  }

  constructor(private readonly options: AgentRuntimeControllerOptions) {
    if (!options.events && !options.eventSink) {
      throw new Error('AgentRuntimeController requires either events or eventSink');
    }

    this.turnController = new TurnController(options);
    this.eventSink = options.eventSink ?? createAgentRuntimeEventSinkFromUiEvents(options.events as UiEventSink);
    const events = options.events ?? createUiEventSinkFromAgentRuntimeEvents(this.eventSink);
    this.runner = options.runner ?? new AgentChatController(options.runtime, events, this.createChatOptions());
  }

  hasActiveTurn(): boolean {
    return this.turnController.hasActiveTurn();
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
      case 'select_session':
        return this.submit(resumeSessionInput(input.sessionId, input.allProjects));
      case 'permission_decision':
        return this.recordPermissionDecision(input.requestId, input.approved);
      case 'interrupt':
        return this.interrupt();
      case 'clear_exit_intent':
        this.clearExitIntent();
        return { type: 'exit_intent_cleared' };
      case 'goal_control':
        return this.handleGoalControl(input as unknown as import('./goals/types').GoalControlInput);
    }
  }

  submit(input: string): AgentRuntimeSubmitResult {
    const submitted = input.trim();
    if (!submitted) return { type: 'empty' };

    if (isExitInput(submitted)) {
      return { type: 'exit_requested' };
    }

    if (this.turnController.hasActiveTurn()) {
      const parsed = parseInput(submitted);
      if (parsed.isCommand) {
        this.emitStatus(this.options.commandWhileRunningStatus ?? 'Command ignored while agent is running. Press Ctrl+C to interrupt first.');
        return { type: 'command_ignored' };
      }

      // v0.2.26: user steering input during active goal — update constraints
      // without replacing the root objective.
      const gc = this.goalCoordinator;
      if (gc?.goal && !isTargetCommand(submitted)) {
        // Record the steering as a constraint update without changing objective.
        gc.edit(gc.goal.objective); // no-op edit to bump revision, steering is via prompt
      }

      this.turnController.clearExitIntent();
      this.turnController.requestRevision(submitted);
      this.emitStatus(this.options.revisionStatus ?? 'Revision received. Interrupting current response...');
      return { type: 'revision_requested' };
    }



    this.activeRun = this.runTurn(submitted)
      .catch(error => {
        this.handleRunLoopError(error);
      })
      .finally(() => {
        this.activeRun = null;
        // v0.2.26: schedule goal continuation after turn completes.
        this.scheduleGoalContinuation();
      });
    return { type: 'started' };
  }

  // --- v0.2.26: goal continuation scheduling ---

  private scheduleGoalContinuation(): void {
    const coord = this.goalCoordinator;
    if (!coord || !coord.isActive || coord.goal?.status !== 'active') return;
    if (!coord.canContinue) return; // don't continue if deferred, budget exceeded, etc.

    // Defer to next tick to let the current turn's events settle.
    setImmediate(() => {
      if (this.stopping || this.turnController.hasActiveTurn()) return;
      if (!coord.isActive || coord.goal?.status !== 'active') return; // re-check after tick
      const req = coord.buildContinuationRequest();
      if (req) {
        this.handle({
          type: 'submit',
          text: `[goal continuation #${coord.goal!.continuationCount + 1}]`,
          source: 'programmatic',
        } as AgentRuntimeInput);
      }
    });
  }

  /** v0.2.26: finalize goal turn with usage data from the last loop. */
  private finalizeGoalTurn(turnId: string | number): void {
    const coord = this.goalCoordinator;
    if (!coord?.goal || coord.goal.status !== 'active') return;

    const usage = this.options.runtime.store.getSnapshot().tokenUsage;
    const loopStats = this.options.runtime.store.getSnapshot().lastLoopStats;

    const outcome: import('./goals/types').AgentTurnOutcome = {
      turnId: String(turnId),
      sessionId: this.options.runtime.getSession()?.id ?? '',
      goalId: coord.goal.goalId,
      goalRevision: coord.goal.revision,
      startedAt: coord.goal.updatedAt,
      endedAt: Date.now(),
      finishReason: loopStats?.finishReason ?? 'unknown',
      usage: {
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        subagentTokens: 0,
        totalTokens: (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0),
      },
      madeProgress: loopStats ? loopStats.toolCalls > 0 : true,
    };

    coord.finalizeTurn(outcome);
  }

  interrupt(): AgentRuntimeInterruptResult {
    const shouldExit = this.turnController.registerExitIntent();
    // v0.2.26: pause active goal on interrupt to prevent immediate restart.
    this.goalCoordinator?.deferContinuation();
    if (this.turnController.hasActiveTurn()) {
      this.turnController.interruptActiveTurn();
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
    this.rejectPendingPermissions();
    if (this.activeRun) {
      await this.activeRun.catch(() => undefined);
    }
    // Reset stopping flag so subsequent turns can execute.
    this.stopping = false;
  }

  waitForIdle(): Promise<void> {
    return this.activeRun ?? Promise.resolve();
  }

  private async runTurn(firstInput: string): Promise<void> {
    let nextInput: string | undefined = firstInput;

    while (nextInput?.trim() && !this.stopping) {
      if (this.options.echoSubmittedInput ?? true) {
        this.emitAppend(submittedEntry(nextInput));
      }
      this.options.beforeTurn?.(nextInput);

      const turn = this.turnController.beginTurn(nextInput);
      this.options.runtime.store.setProcessing(true);
      this.emitProcessing(true);
      const runningStatus = statusText(this.options.runningStatus, nextInput);
      if (runningStatus) this.emitStatus(runningStatus);

      try {
        await this.runner.runInput(nextInput, { abortSignal: turn.abortSignal, turnId: turn.id });
      } catch (error) {
        if (!turn.abortSignal.aborted) {
          if (this.options.onTurnError) {
            this.options.onTurnError(error);
          } else {
            const message = error instanceof Error ? error.message : String(error);
            this.emitAppend({ role: 'error', content: `Error: ${message}` });
          }
        }
      } finally {
        const revision = this.turnController.finishTurn(turn.id);

        // v0.2.26: finalize goal turn with usage data.
        this.finalizeGoalTurn(turn.id);

        if (revision?.trim()) {
          this.emitStatus(this.options.restartingStatus ?? 'Restarting with latest instruction...');
          nextInput = revision;
        } else {
          nextInput = undefined;
        }
      }
    }

    this.options.runtime.store.setProcessing(false);
    this.emitProcessing(false);
    if (!this.stopping) {
      const readyStatus = typeof this.options.readyStatus === 'function'
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
      this.emitAppend({ role: 'error', content: `[RUNTIME] Error: ${message}`, errorLayer: 'runtime' });
    }

    this.options.runtime.store.setProcessing(false);
    this.emitProcessing(false);
    const readyStatus = typeof this.options.readyStatus === 'function'
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

      this.pendingPermissions.set(id, finish);
      request.abortSignal?.addEventListener('abort', onAbort, { once: true });
      this.emitStatus(permissionPendingStatus(request.name));
      this.eventSink.emit({ type: 'permission_requested', request: runtimeRequest });
    });
  }

  // --- v0.2.24: Goal control ---

  private handleGoalControl(input: import('./goals/types').GoalControlInput): AgentRuntimeInputResult {
    const coord = this.goalCoordinator;
    if (!coord) return { type: 'empty' };

    switch (input.action) {
      case 'show':
        // Just shows status — already handled by the renderer format function.
        return { type: 'empty' };
      case 'create': {
        const obj = input.payload?.objective;
        if (!obj) return { type: 'empty' };
        const result = coord.create(obj);
        return { type: result.ok ? 'interrupted' : 'empty' };
      }
      case 'pause':
        coord.pause();
        return { type: 'interrupted' };
      case 'resume':
        coord.resume();
        return { type: 'interrupted' };
      case 'edit': {
        const obj = input.payload?.objective;
        if (obj) coord.edit(obj);
        return { type: 'interrupted' };
      }
      case 'replace': {
        const obj = input.payload?.objective;
        if (obj) coord.replace(obj);
        return { type: 'interrupted' };
      }
      case 'set_budget':
        coord.setBudget(input.payload?.tokenBudget ?? null);
        return { type: 'interrupted' };
      case 'clear':
        if (input.payload?.confirmed) {
          coord.clear();
        }
        return { type: 'interrupted' };
      default:
        return { type: 'empty' };
    }
  }

  private recordPermissionDecision(requestId: string, approved: boolean): AgentRuntimeInputResult {
    const resolve = this.pendingPermissions.get(requestId);
    if (!resolve) return { type: 'permission_decision_ignored' };
    resolve(approved);
    return { type: 'permission_decision_recorded' };
  }

  private rejectPendingPermissions(): void {
    const pending = [...this.pendingPermissions.values()];
    this.pendingPermissions.clear();
    for (const resolve of pending) {
      resolve(false);
    }
  }

  private createChatOptions(): AgentChatControllerOptions | undefined {
    const resolvedRenderer = this.options.chatOptions?.uiRenderer ?? this.options.uiRenderer;
    const uiCapabilities = {
      ...resolveUiRendererCapabilities(undefined, resolvedRenderer),
      ...(this.options.uiCapabilities ?? {}),
      ...(this.options.chatOptions?.uiCapabilities ?? {}),
    };
    const chatOptions: AgentChatControllerOptions = {
      uiCapabilities,
      uiRenderer: resolvedRenderer,
      onVerificationStateChange: state => this.turnController.setVerificationState(state),
      ...(this.options.chatOptions ?? {}),
    };
    chatOptions.uiCapabilities = uiCapabilities;
    chatOptions.uiRenderer = chatOptions.uiRenderer ?? resolvedRenderer;
    chatOptions.onVerificationStateChange = chatOptions.onVerificationStateChange ?? (state => this.turnController.setVerificationState(state));
    if (this.options.useRuntimeToolPermissions && !chatOptions.confirmToolUse) {
      chatOptions.confirmToolUse = request => this.requestToolPermission(request);
    }
    // R6: wire live permission state so the subagent policy gate can prevent
    // background delegation while the user is deciding a tool permission.
    if (!chatOptions.hasPendingPermission) {
      chatOptions.hasPendingPermission = () => this.pendingPermissions.size > 0;
    }
    // R6: wire child usage callback so CostTracker records subagent token
    // consumption, making /cost complete and honest about child agent spend.
    if (!chatOptions.onChildUsage) {
      chatOptions.onChildUsage = (taskId, _role, usage, modelLabel) => {
        const costTracker = this.options.runtime.store.getSnapshot().costTracker;
        costTracker.record(
          {
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
            requestId: `subagent:${taskId}`,
          },
          {
            model: modelLabel ?? 'unknown',
            agentId: 'subagent',
            taskId,
            requestKind: 'subagent',
          },
        );
      };
    }
    return Object.keys(chatOptions).length > 0 ? chatOptions : undefined;
  }
}
