import { findCommand, getVisibleCommands } from '../commands';
import { parseInput } from '../commands/parser';
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
import {
  AgentChatController,
  type AgentChatControllerOptions,
  type RunInputOptions,
} from './chat-controller';
import { resolveUiRendererCapabilities } from './ui-events';
import type {
  OrionCodeUiRuntime,
  ToolPermissionRequest,
  TranscriptAppendEntry,
  UiEventSink,
  UiRendererCapabilities,
} from './ui-events';
import type { CommandUiRenderer } from '../commands/types';
import { TurnController, type TurnControllerOptions } from './turn-controller';
import type { AgentTurnRequest, GoalEvidenceRecord, GoalRuntimeEvent } from './goals/types';
import {
  currentGoalToolContext,
  runWithGoalToolContext,
  type GoalToolExecutionContext,
} from './goals/tools';
import { budgetPreflight } from './goals/accounting';
import { randomUUID } from 'crypto';
import { captureWorkspaceFingerprint } from '../services/workspace-state';
import { redactTraceText } from '../services/redaction';
import { classifyGoalEvidenceKind, classifyGoalEvidenceResult } from './goals/evidence';
import { appendSessionTraceEvent } from '../services/session-storage';
import { externalAssertionMatchesInvocation } from '../framework/external-assertion';
import { updateGlobalConfig } from '../services/global-config';
import type { ToolConfirmationPolicy } from '../services/global-config';
import {
  grantToolPermission,
  isToolPermissionScope,
  type ToolPermissionScope,
} from '../services/tool-allowlist';

export type {
  AgentRuntimeInput,
  AgentRuntimeInputResult,
  AgentRuntimeInterruptResult,
  AgentRuntimeSubmitResult,
} from './agent-runtime-protocol';

export interface AgentRuntimeRunner {
  runInput(input: string, options?: RunInputOptions): Promise<void>;
  runRequest?(request: AgentTurnRequest, options?: RunInputOptions): Promise<void>;
}

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

export function goalProviderError(
  finishReason: string | undefined,
  errorType: string | undefined
): import('./goals/types').AgentTurnOutcome['providerError'] {
  if (finishReason !== 'failed' || !errorType) return undefined;
  switch (errorType) {
    case 'quota_or_credit_exhausted':
      return { kind: 'usage_limit', retryable: false };
    case 'rate_limit':
      return { kind: 'rate_limit', retryable: true };
    case 'provider_busy':
      return { kind: 'provider_busy', retryable: true };
    case 'auth_failed':
      return { kind: 'auth', retryable: false };
    case 'connect_timeout':
    case 'read_timeout':
    case 'connection_reset':
    case 'network_error':
      return { kind: 'network', retryable: true };
    default:
      return { kind: 'unknown', retryable: false };
  }
}

export function goalTurnMadeProgress(input: {
  evidenceRecords?: GoalEvidenceRecord[];
  pendingPlanUpdate?: GoalToolExecutionContext['pendingPlanUpdate'];
  workspaceFingerprintBefore?: string;
  workspaceFingerprintAfter?: string;
}): boolean {
  const passedEvidence = input.evidenceRecords?.some(record => record.result === 'passed') ?? false;
  const workspaceChanged = Boolean(
    input.workspaceFingerprintBefore &&
    input.workspaceFingerprintAfter &&
    input.workspaceFingerprintBefore !== input.workspaceFingerprintAfter
  );
  return passedEvidence || workspaceChanged;
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
  private readonly pendingPermissions = new Map<
    string,
    { request: AgentRuntimeToolPermissionRequest; finish: (approved: boolean) => void }
  >();
  private activeRun: Promise<void> | null = null;
  private stopping = false;
  private continuationScheduleEpoch = 0;
  /** Conservative reservations for every provider attempt in the current root turn. */
  private goalProviderReservedTokens = 0;
  private nextPermissionRequestId = 1;
  private readonly queuedCommands: string[] = [];
  /** v0.2.24: optional goal coordinator for /target mode. */
  private goalCoordinator: import('./goals/coordinator').GoalCoordinator | null = null;
  private goalCoordinatorSessionId: string | null = null;

  /** v0.2.24: set the goal coordinator for /target mode. */
  setGoalCoordinator(coord: import('./goals/coordinator').GoalCoordinator): void {
    this.goalCoordinator = coord;
    this.goalCoordinatorSessionId = coord.boundSessionId;
    // Wire goal prompt injection into the chat controller.
    if ('setGoalCoordinator' in this.runner) {
      (this.runner as AgentChatController).setGoalCoordinator(coord);
    }
  }

  constructor(private readonly options: AgentRuntimeControllerOptions) {
    if (!options.events && !options.eventSink) {
      throw new Error('AgentRuntimeController requires either events or eventSink');
    }

    this.turnController = new TurnController(options);
    const downstream =
      options.eventSink ?? createAgentRuntimeEventSinkFromUiEvents(options.events as UiEventSink);
    this.eventSink = {
      emit: event => {
        this.captureGoalEvidence(event);
        const result = downstream.emit(event);
        if (event.type === 'session_restored') {
          this.restoreGoalForSession(event.event.sessionId, event.event.projectPath);
        }
        return result;
      },
    };
    const events = createUiEventSinkFromAgentRuntimeEvents(this.eventSink);
    this.runner =
      options.runner ?? new AgentChatController(options.runtime, events, this.createChatOptions());
  }

  hasActiveTurn(): boolean {
    return this.turnController.hasActiveTurn();
  }

  /** v0.1.1: shared /target command handling for all renderers. */
  handleTargetInput(rawInput: string): {
    handled: boolean;
    statusText?: string;
    runtimeResult: AgentRuntimeSubmitResult;
  } {
    if (/^\/target(?:\s|$)/iu.test(rawInput.trim())) {
      const command = findCommand('goal');
      if (command) {
        this.emitAppend({
          role: 'system',
          title: '/target deprecated',
          content: '/target is deprecated; use /goal. It will be removed in v0.3.0.',
          statusTone: 'warning',
          command: {
            id: command.id,
            name: command.name,
            source: command.source,
            success: true,
          },
        });
      }
    }
    const parsed = parseTargetCommand(rawInput);
    if (!parsed.ok) {
      this.emitAppend({
        role: 'error',
        title: 'target',
        content: parsed.error,
        errorLayer: 'runtime',
      });
      return {
        handled: true,
        statusText: parsed.error,
        runtimeResult: { type: 'command_handled' },
      };
    }
    const input = parsed.input;
    const coord = this.ensureGoalCoordinator(input.action !== 'show');

    if (!coord) {
      const statusText = 'Target unavailable: no active session.';
      this.emitAppend({
        role: 'error',
        title: 'target',
        content: statusText,
        errorLayer: 'session',
      });
      return { handled: true, statusText, runtimeResult: { type: 'command_handled' } };
    }

    if (this.turnController.hasActiveTurn() && !['pause', 'show', 'clear'].includes(input.action)) {
      const statusText =
        'Target command ignored while the agent is running. Use /target pause or interrupt first.';
      this.emitStatus(statusText);
      return { handled: true, statusText, runtimeResult: { type: 'command_ignored' } };
    }

    let success = true;
    let error: string | undefined;
    let executionRevoked = false;
    const previousGoalId = coord.goal?.goalId;
    try {
      switch (input.action) {
        case 'show':
          break;
        case 'create': {
          const result = coord.create(input.payload?.objective ?? '');
          success = result.ok;
          if (!result.ok) error = result.error;
          break;
        }
        case 'pause':
          if (coord.isActive) {
            this.abortGoalOwnedExecution();
            executionRevoked = true;
          }
          success = coord.pause();
          if (!success) error = 'Target is not active.';
          break;
        case 'resume':
          success = coord.resume({
            confirmBoundary: true,
            expectedGoalId: coord.goal?.goalId,
            expectedRevision: coord.goal?.revision,
          });
          if (!success) error = 'Target cannot be resumed from its current state.';
          break;
        case 'confirm':
          success = coord.confirmCriterion(input.payload?.criterionId ?? '');
          if (!success) {
            error = 'Criterion cannot be confirmed. It must exist and require user evidence.';
          }
          break;
        case 'edit':
          success = coord.edit(input.payload?.objective ?? '');
          if (!success) error = 'Target objective could not be updated.';
          break;
        case 'replace':
          success = coord.replace(input.payload?.objective ?? '');
          if (!success) {
            error = 'Target could not be replaced.';
            if (input.payload?.objective?.trim()) {
              error = this.failClosedGoalMutation(
                coord,
                input.action,
                new Error(error),
                executionRevoked,
                previousGoalId
              );
              executionRevoked = true;
            }
          }
          break;
        case 'set_budget':
          success = coord.setBudget(input.payload?.tokenBudget ?? null);
          if (!success) error = 'Create or resume a target before setting a budget.';
          break;
        case 'clear':
          if (!input.payload?.confirmed) {
            success = false;
            error = 'Removing a Goal requires explicit authorization: /goal exit';
          } else {
            const hadGoal = coord.goal !== null;
            if (hadGoal) {
              this.abortGoalOwnedExecution();
              executionRevoked = true;
            }
            success = coord.clear();
            if (hadGoal && !success) {
              error = this.failClosedGoalMutation(
                coord,
                input.action,
                new Error('Target clear did not remove the active Goal.'),
                executionRevoked,
                previousGoalId
              );
            }
            if (!success && !hadGoal) error = 'No target exists to clear.';
          }
          break;
      }
    } catch (cause) {
      success = false;
      error =
        input.action === 'show'
          ? cause instanceof Error
            ? cause.message
            : String(cause)
          : this.failClosedGoalMutation(
              coord,
              input.action,
              cause,
              executionRevoked,
              previousGoalId
            );
    }

    if (!success && error) {
      this.emitAppend({ role: 'error', title: 'target', content: error, errorLayer: 'runtime' });
    }

    if (
      success &&
      input.action === 'resume' &&
      coord.goal?.status === 'active' &&
      coord.goal.tokenBudget !== undefined
    ) {
      const resumedBudget = budgetPreflight(coord.goal.tokensUsed, coord.goal.tokenBudget, 0);
      if (!resumedBudget.available) {
        try {
          coord.limitBudget(
            resumedBudget.reason ?? 'Token budget unavailable after resuming the target.'
          );
        } catch (cause) {
          success = false;
          error = this.failClosedGoalMutation(
            coord,
            'resume_budget_stop',
            cause,
            executionRevoked,
            previousGoalId
          );
          this.emitGoalMutationError(error);
        }
      }
    }

    if (success) {
      const { updateSessionGoalBinding } =
        require('../services/session-storage') as typeof import('../services/session-storage');
      updateSessionGoalBinding(coord.boundSessionId, coord.goal);
      if (input.action === 'clear' && previousGoalId) {
        this.emitGoalEvent({ type: 'goal_cleared', goalId: previousGoalId, reason: 'user_clear' });
      } else {
        const snapshot = coord.snapshot();
        if (snapshot) {
          this.emitGoalEvent({
            type: 'goal_updated',
            goal: snapshot,
            reason: `target_${input.action}`,
          });
        }
      }
    }

    const statusText = this.formatTargetStatus(coord);
    this.emitAppend({ role: 'system', title: 'target', content: statusText });

    if (
      success &&
      (input.action === 'create' || input.action === 'resume' || input.action === 'replace') &&
      coord.isActive
    ) {
      const req = coord.buildContinuationRequest();
      if (req) {
        const runtimeResult = this.submitGoalContinuation(req, `target_${input.action}`, true);
        return { handled: true, statusText, runtimeResult };
      }
    }

    return { handled: true, statusText, runtimeResult: { type: 'command_handled' } };
  }

  /** v0.1.1: shared /target intercept check for all renderers. */
  canInterceptTargetCommand(input: string, duringActiveTurn: boolean): boolean {
    if (!isTargetCommand(input)) return false;
    const parsed = parseTargetCommand(input);
    if (!parsed.ok) return true; // intercept to show error
    // During active turn, only allow non-mutating actions.
    if (duringActiveTurn) {
      return ['pause', 'show', 'clear'].includes(parsed.input.action);
    }
    return true;
  }

  /** v0.1.1: emit clear_view event through the renderer protocol. */
  emitClearView(): void {
    this.eventSink.emit({ type: 'clear_view' });
  }

  /** v0.1.1: emit shutdown_requested event through the renderer protocol. */
  emitShutdownRequested(reason?: string): void {
    this.deferGoalContinuation(reason ?? 'shutdown requested', true);
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
        return this.handleGoalControl(input as unknown as import('./goals/types').GoalControlInput);
      case 'permission_mode_change':
        return this.applyPermissionModeChange(input.value);
    }
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

      // v0.2.26: user steering input during active goal — update constraints
      // without replacing the root objective.
      const gc = this.goalCoordinator;
      if (gc?.goal && !isTargetCommand(submitted)) {
        const steeringGoalId = gc.goal.goalId;
        try {
          gc.addConstraint(submitted);
        } catch (cause) {
          const message = this.failClosedGoalMutation(gc, 'steering', cause, false, steeringGoalId);
          this.emitAppend({
            role: 'error',
            title: 'target steering',
            content: message,
            errorLayer: 'runtime',
          });
          this.emitStatus(message);
          return { type: 'command_ignored' };
        }
      }

      this.turnController.clearExitIntent();
      this.turnController.requestRevision(submitted);
      // v0.1.3 (G1): echo the incremental input to the transcript immediately,
      // so the user sees their correction without waiting for the turn to abort.
      this.emitAppend(submittedEntry(submitted));
      this.emitStatus(this.options.revisionStatus ?? '已接收补充，正在中断当前轮…');
      return { type: 'revision_requested' };
    }

    const session = this.options.runtime.getSession() ?? this.options.runtime.ensureSession();
    const coord = this.ensureGoalCoordinator(false);
    const goal = coord?.goal?.status === 'active' ? coord.goal : undefined;
    const request: AgentTurnRequest = {
      inputKind: 'user',
      text: submitted,
      sessionId: session?.id ?? 'pending-session',
      goal: goal
        ? {
            goalId: goal.goalId,
            revision: goal.revision,
            continuationIndex: goal.continuationCount,
          }
        : undefined,
      persistAsUserMessage: true,
      echoToTranscript: true,
      generation: coord?.generation ?? 0,
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

  private submitTurnRequest(request: AgentTurnRequest): AgentRuntimeSubmitResult {
    if (this.turnController.hasActiveTurn()) return { type: 'command_ignored' };
    if (!this.requestIsCurrent(request)) return { type: 'command_ignored' };

    this.activeRun = this.runTurn(request)
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

  private submitGoalContinuation(
    request: AgentTurnRequest,
    reason: string,
    emitScheduled: boolean
  ): AgentRuntimeSubmitResult {
    const goalId = request.goal?.goalId;
    if (emitScheduled && goalId) {
      this.emitGoalEvent({ type: 'goal_continuation', goalId, phase: 'scheduled', reason });
    }
    const result = this.submitTurnRequest(request);
    if (goalId) {
      this.emitGoalEvent({
        type: 'goal_continuation',
        goalId,
        phase: result.type === 'started' ? 'started' : 'deferred',
        reason: result.type === 'started' ? reason : `request rejected: ${reason}`,
      });
    }
    return result;
  }

  // --- v0.2.26: goal continuation scheduling ---

  private scheduleGoalContinuation(): void {
    const coord = this.goalCoordinator;
    if (!coord || !coord.isActive || coord.goal?.status !== 'active') return;
    if (!coord.canContinue) {
      this.emitGoalEvent({
        type: 'goal_continuation',
        goalId: coord.goal.goalId,
        phase: 'deferred',
        reason: 'coordinator is not eligible to continue',
      });
      return;
    }

    const scheduleEpoch = ++this.continuationScheduleEpoch;
    const scheduledGoalId = coord.goal.goalId;

    // Defer to next tick to let the current turn's events settle.
    setImmediate(() => {
      if (scheduleEpoch !== this.continuationScheduleEpoch) {
        this.emitGoalEvent({
          type: 'goal_continuation',
          goalId: scheduledGoalId,
          phase: 'deferred',
          reason: 'scheduled continuation was invalidated',
        });
        return;
      }
      if (
        this.stopping ||
        this.turnController.hasActiveTurn() ||
        this.pendingPermissions.size > 0
      ) {
        this.emitGoalEvent({
          type: 'goal_continuation',
          goalId: scheduledGoalId,
          phase: 'deferred',
          reason: this.stopping
            ? 'runtime is stopping'
            : this.pendingPermissions.size > 0
              ? 'tool permission is pending'
              : 'another turn is active',
        });
        return;
      }
      if (!coord.isActive || coord.goal?.status !== 'active') {
        this.emitGoalEvent({
          type: 'goal_continuation',
          goalId: scheduledGoalId,
          phase: 'deferred',
          reason: 'goal is no longer active',
        });
        return;
      }
      const req = coord.buildContinuationRequest();
      if (req) {
        const projected = coord.goal?.lastTurn?.totalTokens ?? 0;
        const preflight = budgetPreflight(
          coord.goal?.tokensUsed ?? 0,
          coord.goal?.tokenBudget,
          projected
        );
        if (!preflight.available) {
          try {
            coord.limitBudget(preflight.reason ?? 'Token budget unavailable for another turn.');
          } catch (cause) {
            const message = this.failClosedGoalMutation(
              coord,
              'budget_stop',
              cause,
              false,
              scheduledGoalId
            );
            this.emitGoalMutationError(message);
            return;
          }
          this.emitGoalEvent({
            type: 'goal_continuation',
            goalId: coord.goal!.goalId,
            phase: 'stopped',
            reason: preflight.reason ?? 'budget preflight failed',
          });
          return;
        }
        this.submitGoalContinuation(req, `continuation ${req.goal!.continuationIndex}`, true);
      } else {
        this.emitGoalEvent({
          type: 'goal_continuation',
          goalId: scheduledGoalId,
          phase: 'deferred',
          reason: 'coordinator did not produce a continuation request',
        });
      }
    });
  }

  /** v0.2.26: finalize goal turn with usage data from the last loop. */
  private finalizeGoalTurn(
    turnId: string | number,
    request: AgentTurnRequest,
    toolContext: GoalToolExecutionContext | undefined,
    startedAt: number,
    workspaceFingerprintBefore: string | undefined,
    turnAborted: boolean
  ): void {
    const coord = this.goalCoordinator;
    const requestGoal = request.goal;
    const currentSessionId = this.options.runtime.getSession()?.id;
    if (
      !coord?.goal ||
      !requestGoal ||
      currentSessionId !== request.sessionId ||
      coord.boundSessionId !== request.sessionId ||
      coord.generation !== request.generation ||
      coord.goal.goalId !== requestGoal.goalId
    ) {
      if (request.inputKind === 'goal_continuation' && requestGoal) {
        this.emitGoalEvent({
          type: 'goal_continuation',
          goalId: requestGoal.goalId,
          phase: 'deferred',
          reason:
            'turn outcome rejected because its session, goal, revision, or generation is stale',
        });
      }
      return;
    }

    const usage = this.options.runtime.store.getSnapshot().tokenUsage;
    const loopStats = this.options.runtime.store.getSnapshot().lastLoopStats;
    const subagentPromptTokens = loopStats?.subagentPromptTokens ?? 0;
    const subagentCompletionTokens = loopStats?.subagentCompletionTokens ?? 0;
    const subagentTokens = loopStats?.subagentTotalTokens ?? 0;
    const workspaceFingerprintAfter = captureWorkspaceFingerprint(this.activeProjectPath());
    const workspaceChanged = Boolean(
      workspaceFingerprintBefore &&
      workspaceFingerprintAfter &&
      workspaceFingerprintBefore !== workspaceFingerprintAfter
    );
    const usageAccountingComplete =
      (loopStats as (typeof loopStats & { usageAccountingComplete?: boolean }) | undefined)
        ?.usageAccountingComplete !== false;

    const outcome: import('./goals/types').AgentTurnOutcome = {
      turnId: String(turnId),
      inputKind: request.inputKind,
      sessionId: request.sessionId,
      goalId: requestGoal.goalId,
      goalRevision: requestGoal.revision,
      goalGeneration: request.generation,
      startedAt,
      endedAt: Date.now(),
      finishReason: loopStats?.finishReason ?? 'unknown',
      usage: {
        promptTokens: Math.max(0, (usage?.promptTokens ?? 0) - subagentPromptTokens),
        completionTokens: Math.max(0, (usage?.completionTokens ?? 0) - subagentCompletionTokens),
        subagentTokens,
        totalTokens:
          usage !== null
            ? (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0)
            : subagentTokens,
      },
      madeProgress: goalTurnMadeProgress({
        evidenceRecords: toolContext?.evidenceRecords,
        pendingPlanUpdate: toolContext?.pendingPlanUpdate,
        workspaceFingerprintBefore,
        workspaceFingerprintAfter,
      }),
      workspaceChanged,
      providerError: goalProviderError(
        loopStats?.finishReason,
        loopStats?.providerLastRetryErrorType
      ),
      blocker: toolContext?.pendingBlocker,
      pendingTerminalRequest: toolContext?.pendingTerminalRequest,
      pendingPlanUpdate: toolContext?.pendingPlanUpdate,
      evidenceRecords: toolContext?.evidenceRecords,
      workspaceFingerprint: workspaceFingerprintAfter,
      evidenceRefs: toolContext?.evidenceRecords.map(record => record.id),
      verificationSummary: this.verificationSummary(loopStats),
      usageComplete:
        usageAccountingComplete &&
        usage !== null &&
        loopStats?.finishReason !== 'failed' &&
        (loopStats?.providerRetryCount ?? 0) === 0 &&
        (loopStats?.providerFallbackCount ?? 0) === 0,
    };

    const semanticOutcomeIsCurrent =
      coord.goal.status === 'active' &&
      !turnAborted &&
      coord.goal.revision === requestGoal.revision;

    if (!semanticOutcomeIsCurrent) {
      const accountingOnlyEligible =
        turnAborted || coord.goal.status === 'paused' || coord.goal.revision > requestGoal.revision;
      if (!accountingOnlyEligible) {
        if (request.inputKind === 'goal_continuation') {
          this.emitGoalEvent({
            type: 'goal_continuation',
            goalId: requestGoal.goalId,
            phase: 'deferred',
            reason: 'turn outcome rejected because the Goal lifecycle no longer accepts this turn',
          });
        }
        return;
      }

      // accountStaleTurn is the coordinator's accounting-only, idempotent
      // entry point. An interrupt can leave the Goal revision unchanged, so
      // freeze this outcome immediately before the current revision without
      // admitting any semantic payload from the cancelled turn.
      const accountingOutcome = {
        ...outcome,
        goalRevision: Math.min(
          outcome.goalRevision ?? requestGoal.revision,
          coord.goal.revision - 1
        ),
      };
      let accounted = false;
      try {
        const alreadyAccounted = coord.goal.lastTurn?.turnId === String(turnId);
        accounted = alreadyAccounted ? false : coord.accountStaleTurn(accountingOutcome);

        // Missing/partial provider usage is fail-closed. Known lower-bound
        // tokens have already been retained by accountStaleTurn.
        if (outcome.usageComplete === false && coord.goal?.status === 'active') {
          coord.pause();
        }
      } catch (error) {
        this.failClosedGoalPersistence(coord, requestGoal.goalId, error, 'stale_accounting');
        return;
      }

      const snapshot = coord.snapshot();
      if (accounted && snapshot) {
        this.emitGoalEvent({
          type: 'goal_updated',
          goal: snapshot,
          reason: 'interrupted or stale turn usage accounted without semantic finalization',
        });
        this.recordGoalTraceState(turnId, request, snapshot);
      }
      if (request.inputKind === 'goal_continuation') {
        this.emitGoalEvent({
          type: 'goal_continuation',
          goalId: requestGoal.goalId,
          phase: 'deferred',
          reason:
            'turn semantic outcome rejected; incurred usage was accounted without continuation',
        });
      }
      return;
    }

    // Live steering intentionally bumps the Goal revision before the aborted
    // provider turn settles. The semantic payload is stale, but the provider
    // usage and elapsed time were still incurred and must be counted once.
    const planRevisionBefore = coord.goal.contract?.planSnapshot?.revision;
    try {
      coord.finalizeTurn(outcome);
    } catch (error) {
      this.failClosedGoalPersistence(coord, requestGoal.goalId, error, 'turn_finalize');
      return;
    }
    const snapshot = coord.snapshot();
    if (snapshot) {
      this.recordGoalTraceState(turnId, request, snapshot);
      if (
        coord.goal?.contract?.planSnapshot &&
        coord.goal.contract.planSnapshot.revision !== planRevisionBefore
      ) {
        const plan = coord.goal.contract.planSnapshot;
        this.emitGoalEvent({
          type: 'goal_plan_updated',
          goalId: snapshot.goalId,
          planRevision: plan.revision,
          phase: plan.phase,
          nextAction: plan.nextAction,
        });
      }
      let terminalEvent: GoalRuntimeEvent | undefined;
      if (snapshot.status === 'complete' && coord.goal?.completionAudit) {
        terminalEvent = {
          type: 'goal_completed',
          goal: snapshot,
          audit: coord.goal.completionAudit,
        };
      } else if (coord.goal?.completionAudit && !coord.goal.completionAudit.passed) {
        terminalEvent = {
          type: 'goal_audit_failed',
          goalId: snapshot.goalId,
          audit: 'completion',
          summary: coord.goal.completionAudit.remainingRequirements.join(' '),
        };
      } else if (
        toolContext?.pendingTerminalRequest?.requestedStatus === 'blocked' &&
        snapshot.status !== 'blocked'
      ) {
        const blocker = coord.goal?.blocker;
        terminalEvent = {
          type: 'goal_audit_failed',
          goalId: snapshot.goalId,
          audit: 'blocked',
          summary: blocker
            ? `Blocker is not terminal: ${blocker.consecutiveTurns}/3 consecutive turns; no-progress ${coord.goal?.noProgressCount ?? 0}/3.`
            : 'Blocked request did not include a valid non-retryable user, permission, or external-state blocker.',
        };
      }
      // Project the fresh snapshot first, then the specific audit/completion
      // event. This keeps renderer state current without a generic update
      // overwriting the user-facing terminal result.
      this.emitGoalEvent({ type: 'goal_updated', goal: snapshot, reason: 'turn_finalized' });
      if (terminalEvent) this.emitGoalEvent(terminalEvent);
    }
  }

  private failClosedGoalPersistence(
    coord: import('./goals/coordinator').GoalCoordinator,
    goalId: string,
    error: unknown,
    operation: 'stale_accounting' | 'turn_finalize'
  ): void {
    const message = this.failClosedGoalMutation(coord, operation, error, false, goalId);
    this.emitAppend({
      role: 'error',
      title: 'goal persistence',
      content: message,
      errorLayer: 'session',
    });
    this.emitStatus(message);
  }

  private recordGoalTraceState(
    turnId: string | number,
    request: AgentTurnRequest,
    snapshot: import('./goals/types').RuntimeGoalSnapshot
  ): void {
    if (!request.goal) return;
    const trace = appendSessionTraceEvent(request.sessionId, {
      turnId: String(turnId),
      type: 'goal_state',
      goalId: request.goal.goalId,
      goalRevision: request.goal.revision,
      goalInputKind: request.inputKind,
      goalStopReason:
        snapshot.stopReason ?? (snapshot.status === 'complete' ? 'completed' : 'continue'),
      note: `status=${snapshot.status}; snapshotRevision=${snapshot.revision}`,
    });
    if (trace) this.eventSink.emit({ type: 'trace_event_recorded', event: trace });
  }

  interrupt(): AgentRuntimeInterruptResult {
    // v0.2.26: pause active goal on interrupt to prevent immediate restart.
    this.deferGoalContinuation('user interrupt', true);
    // Register after any synchronous persistence recovery. A lock wait can be
    // longer than the confirmation window, but must not consume the user's
    // first Ctrl+C before this call even returns.
    const shouldExit = this.turnController.registerExitIntent();
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
    this.deferGoalContinuation('runtime stopping');
    this.turnController.interruptActiveTurn();
    this.rejectPendingPermissions();
    if (this.activeRun) {
      await this.activeRun.catch(() => undefined);
    }
    // Reset stopping flag so subsequent turns can execute.
    this.stopping = false;
  }

  private deferGoalContinuation(reason: string, preserveExitIntent: boolean = false): void {
    this.continuationScheduleEpoch += 1;
    const coord = this.goalCoordinator;
    const goalId = coord?.goal?.status === 'active' ? coord.goal.goalId : undefined;
    if (!coord || !goalId) return;

    try {
      coord.deferContinuation();
    } catch (cause) {
      const message = this.failClosedGoalMutation(
        coord,
        'pause',
        cause,
        false,
        goalId,
        preserveExitIntent
      );
      this.emitGoalMutationError(message);
      return;
    }
    this.emitGoalEvent({
      type: 'goal_continuation',
      goalId,
      phase: 'deferred',
      reason,
    });
  }

  /** Revoke all Goal-owned execution before mutating a lifecycle boundary. */
  private abortGoalOwnedExecution(preserveExitIntent: boolean = false): void {
    this.continuationScheduleEpoch += 1;
    if (!preserveExitIntent) this.turnController.clearExitIntent();
    this.turnController.interruptActiveTurn();
    this.rejectPendingPermissions();
  }

  /**
   * Contain a failed Goal mutation without writing the restored disk state back.
   * The coordinator advances its generation so every in-flight request becomes
   * stale, then preserves complete or deleted disk authority as-is.
   */
  private failClosedGoalMutation(
    coord: import('./goals/coordinator').GoalCoordinator,
    operation: string,
    cause: unknown,
    executionAlreadyRevoked: boolean = false,
    goalIdBeforeMutation?: string,
    preserveExitIntent: boolean = false
  ): string {
    if (!executionAlreadyRevoked) this.abortGoalOwnedExecution(preserveExitIntent);
    const detail = redactTraceText(cause instanceof Error ? cause.message : String(cause)).slice(
      0,
      600
    );
    const operationSubject =
      operation === 'steering'
        ? 'Steering'
        : operation === 'turn_finalize'
          ? 'Goal turn finalization'
          : operation === 'stale_accounting'
            ? 'Stale Goal accounting'
            : `Target ${operation}`;
    const goalIdBeforeRecovery = coord.goal?.goalId ?? goalIdBeforeMutation;
    const failureReason = `${operationSubject} was not saved; Goal-owned execution was revoked fail-closed. ${detail}`;
    coord.failClosedAfterPersistenceError(failureReason);
    const snapshot = coord.snapshot();
    const message = !snapshot
      ? `${operationSubject} was not saved; disk authority reports that the Goal was deleted. No continuation was started. ${detail}`
      : coord.goal?.status === 'complete'
        ? `${operationSubject} was not saved; the restored completed Goal remains terminal. No continuation was started. ${detail}`
        : `${operationSubject} was not saved; execution was paused fail-closed. Resolve the storage error, then use /target resume. ${detail}`;
    if (snapshot) {
      this.emitGoalEvent({
        type: 'goal_updated',
        goal: snapshot,
        reason:
          coord.goal?.status === 'complete'
            ? `target_${operation} persistence failed; completed disk authority preserved`
            : `target_${operation} persistence failed; continuation paused fail-closed`,
      });
    } else if (goalIdBeforeRecovery) {
      this.emitGoalEvent({
        type: 'goal_cleared',
        goalId: goalIdBeforeRecovery,
        reason: `target_${operation} failed after the Goal was deleted`,
      });
    }
    const deferredGoalId = snapshot?.goalId ?? goalIdBeforeRecovery;
    if (deferredGoalId) {
      this.emitGoalEvent({
        type: 'goal_continuation',
        goalId: deferredGoalId,
        phase: 'deferred',
        reason: `target_${operation} persistence failed`,
      });
    }
    return message;
  }

  waitForIdle(): Promise<void> {
    return this.activeRun ?? Promise.resolve();
  }

  private async runTurn(firstRequest: AgentTurnRequest): Promise<void> {
    let nextRequest: AgentTurnRequest | undefined = firstRequest;
    let preserveTerminalGoalStatus = false;

    while (nextRequest && !this.stopping) {
      this.goalProviderReservedTokens = 0;
      if (!this.requestIsCurrent(nextRequest)) break;
      const request: AgentTurnRequest = nextRequest;
      const nextInput =
        request.text?.trim() ||
        'Continue pursuing the active goal from its persisted plan and evidence.';
      if (
        (this.options.echoSubmittedInput ?? true) &&
        request.echoToTranscript &&
        !request.alreadyEchoed
      ) {
        this.emitAppend(submittedEntry(nextInput));
      }
      this.options.beforeTurn?.(nextInput);

      const turn = this.turnController.beginTurn(nextInput);
      const startedAt = Date.now();
      const workspaceFingerprintBefore = captureWorkspaceFingerprint(this.activeProjectPath());
      const coord = this.ensureGoalCoordinator(false);
      const toolContext: GoalToolExecutionContext | undefined = coord
        ? { coordinator: coord, request, turnId: String(turn.id), evidenceRecords: [] }
        : undefined;
      this.options.runtime.store.setProcessing(true);
      this.emitProcessing(true);
      const runningStatus = statusText(this.options.runningStatus, nextInput);
      if (runningStatus) this.emitStatus(runningStatus);

      try {
        const execute = (): Promise<void> => {
          if (this.runner.runRequest) {
            return this.runner.runRequest(request, {
              abortSignal: turn.abortSignal,
              turnId: turn.id,
            });
          }
          return this.runner.runInput(nextInput, {
            abortSignal: turn.abortSignal,
            turnId: turn.id,
            persistAsUserMessage: request.persistAsUserMessage,
            inputKind: request.inputKind,
          });
        };
        if (toolContext) {
          await runWithGoalToolContext(toolContext, execute);
        } else {
          await execute();
        }
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
        this.finalizeGoalTurn(
          turn.id,
          request,
          toolContext,
          startedAt,
          workspaceFingerprintBefore,
          turn.abortSignal.aborted
        );
        const finalizedGoal = request.goal ? this.goalCoordinator?.goal : undefined;
        preserveTerminalGoalStatus = Boolean(
          finalizedGoal?.completionAudit ||
          (toolContext?.pendingTerminalRequest?.requestedStatus === 'blocked' &&
            finalizedGoal?.status !== 'blocked')
        );

        if (revision?.trim()) {
          const currentCoord = this.ensureGoalCoordinator(false);
          const currentGoal =
            currentCoord?.goal?.status === 'active' ? currentCoord.goal : undefined;
          if (request.goal && currentCoord?.goal && !currentGoal) {
            this.emitStatus(
              'Latest instruction was saved, but the Goal is paused because usage accounting is incomplete. Use /target resume after reviewing the budget.'
            );
            nextRequest = undefined;
          } else {
            this.emitStatus(this.options.restartingStatus ?? '根据补充调整方向中…');
            nextRequest = {
              inputKind: 'revision',
              text: revision,
              sessionId: this.options.runtime.getSession()?.id ?? request.sessionId,
              goal: currentGoal
                ? {
                    goalId: currentGoal.goalId,
                    revision: currentGoal.revision,
                    continuationIndex: currentGoal.continuationCount,
                  }
                : undefined,
              persistAsUserMessage: true,
              echoToTranscript: true,
              // v0.1.3 (G1): the revision was already echoed at submission time.
              alreadyEchoed: true,
              generation: currentCoord?.generation ?? 0,
            };
          }
        } else {
          const queuedCommand = this.queuedCommands.shift();
          nextRequest = queuedCommand
            ? {
                inputKind: 'user',
                text: queuedCommand,
                sessionId: this.options.runtime.getSession()?.id ?? request.sessionId,
                persistAsUserMessage: true,
                echoToTranscript: false,
                alreadyEchoed: true,
                generation: this.goalCoordinator?.generation ?? 0,
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
      // A completion/blocked audit is the authoritative terminal result of the
      // turn. Keep it visible instead of immediately replacing it with the
      // renderer's generic ready snapshot.
      if (readyStatus && !preserveTerminalGoalStatus) this.emitStatus(readyStatus);
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

  private emitGoalEvent(event: GoalRuntimeEvent): void {
    this.eventSink.emit({ type: 'goal_event', event });
  }

  private requestIsCurrent(request: AgentTurnRequest): boolean {
    const activeSessionId = this.options.runtime.getSession()?.id;
    if (activeSessionId && request.sessionId !== activeSessionId) return false;
    if (!request.goal) return true;
    const coord = this.goalCoordinator;
    const goal = coord?.goal;
    return Boolean(
      coord &&
      goal &&
      coord.boundSessionId === request.sessionId &&
      coord.generation === request.generation &&
      goal.goalId === request.goal.goalId &&
      goal.revision === request.goal.revision &&
      goal.status === 'active'
    );
  }

  private verificationSummary(
    loopStats: ReturnType<OrionCodeUiRuntime['store']['getSnapshot']>['lastLoopStats']
  ): string {
    if (!loopStats) return 'No loop statistics were recorded.';
    const passed = loopStats.verificationPassedCommands ?? [];
    const failed = loopStats.verificationFailedCommands ?? [];
    const missing = loopStats.verificationMissingCommands ?? [];
    return [
      `finish=${loopStats.finishReason}`,
      passed.length ? `passed=${passed.join(', ')}` : '',
      failed.length ? `failed=${failed.join(', ')}` : '',
      missing.length ? `missing=${missing.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('; ');
  }

  private captureGoalEvidence(event: import('./agent-runtime-protocol').AgentRuntimeEvent): void {
    if (event.type !== 'tool_finished') return;
    const context = currentGoalToolContext();
    const goal = context?.coordinator.goal;
    if (!context || !goal || goal.status !== 'active') return;
    const capturedAt = Date.now();
    const claimedAssertion = event.event.externalAssertion;
    const assertion =
      claimedAssertion &&
      externalAssertionMatchesInvocation({
        assertion: claimedAssertion,
        name: event.event.name,
        args: event.event.args,
        success: event.event.success,
        skipped: event.event.skipped,
        now: capturedAt,
      })
        ? claimedAssertion
        : undefined;
    const kind = claimedAssertion
      ? 'external'
      : classifyGoalEvidenceKind(event.event.name, event.event.args);
    if (!kind) return;
    const classifiedResult = classifyGoalEvidenceResult({
      kind,
      success: event.event.success,
      skipped: event.event.skipped,
      summary: event.event.summary,
      error: event.event.error,
    });
    // A successful transport plus display text is never sufficient proof of
    // an external mutation/state. Only runtime-derived typed assertions may
    // promote successful external tool output to passed evidence. Explicit
    // tool failures remain failed so the ledger still records negative proof.
    const result = assertion
      ? assertion.status
      : kind === 'external' && classifiedResult === 'passed'
        ? 'inconclusive'
        : classifiedResult;
    const assertionSubject = assertion
      ? [
          `external ${assertion.action} ${assertion.status}`,
          `provider=${assertion.provider}`,
          `target=${assertion.target}`,
          assertion.observedValue ? `observed=${assertion.observedValue}` : '',
        ]
          .filter(Boolean)
          .join(' ')
      : undefined;
    const record: GoalEvidenceRecord = {
      id: `evidence:${randomUUID()}`,
      goalId: goal.goalId,
      goalRevision: goal.revision,
      objectiveRevision: goal.contract?.objectiveRevision ?? 0,
      turnId: context.turnId,
      kind,
      subject: redactTraceText(
        assertionSubject || event.event.summary || event.event.error || event.event.name
      ).slice(0, 512),
      result,
      sourceRef: `tool:${event.event.callId}:${event.event.name}`,
      capturedAt,
      workspaceFingerprint: captureWorkspaceFingerprint(this.activeProjectPath()),
      expiresAt: kind === 'external' ? capturedAt + 5 * 60_000 : undefined,
      ...(assertion ? { externalAssertion: assertion } : {}),
      redacted: true,
    };
    context.evidenceRecords.push(record);
    this.emitGoalEvent({
      type: 'goal_evidence_recorded',
      goalId: goal.goalId,
      evidence: {
        id: record.id,
        kind: record.kind,
        result: record.result,
        subject: record.subject,
      },
    });
  }

  private restoreGoalForSession(sessionId: string, projectPath: string): void {
    // A continuation queued by the previously active session must not survive a
    // session switch. It captured the old coordinator and would otherwise be
    // able to start after /resume has rebound the runtime.
    this.continuationScheduleEpoch += 1;
    this.goalCoordinator = null;
    this.goalCoordinatorSessionId = null;
    const coord = this.bindGoalCoordinator(sessionId, true, projectPath);
    const snapshot = coord?.snapshot();
    if (snapshot) this.emitGoalEvent({ type: 'goal_restored', goal: snapshot });
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

  // --- v0.2.24: Goal control ---

  private handleGoalControl(
    input: import('./goals/types').GoalControlInput
  ): AgentRuntimeInputResult {
    const coord = this.goalCoordinator;
    if (!coord) return { type: 'empty' };

    let executionRevoked = false;
    const goalIdBeforeMutation = coord.goal?.goalId;
    try {
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
          if (coord.isActive) {
            this.abortGoalOwnedExecution();
            executionRevoked = true;
          }
          return { type: coord.pause() ? 'interrupted' : 'empty' };
        case 'resume':
          return { type: coord.resume() ? 'interrupted' : 'empty' };
        case 'confirm':
          coord.confirmCriterion(input.payload?.criterionId ?? '');
          return { type: 'interrupted' };
        case 'edit': {
          const obj = input.payload?.objective;
          if (obj) coord.edit(obj);
          return { type: 'interrupted' };
        }
        case 'replace': {
          const obj = input.payload?.objective;
          if (obj && !coord.replace(obj)) {
            const message = this.failClosedGoalMutation(
              coord,
              input.action,
              new Error('Target could not be replaced.'),
              executionRevoked,
              goalIdBeforeMutation
            );
            this.emitGoalMutationError(message);
          }
          return { type: 'interrupted' };
        }
        case 'set_budget':
          coord.setBudget(input.payload?.tokenBudget ?? null);
          return { type: 'interrupted' };
        case 'clear':
          if (input.payload?.confirmed && coord.goal !== null) {
            this.abortGoalOwnedExecution();
            executionRevoked = true;
            if (!coord.clear()) {
              const message = this.failClosedGoalMutation(
                coord,
                input.action,
                new Error('Target clear did not remove the active Goal.'),
                executionRevoked,
                goalIdBeforeMutation
              );
              this.emitGoalMutationError(message);
            }
          }
          return { type: 'interrupted' };
        default:
          return { type: 'empty' };
      }
    } catch (cause) {
      const message = this.failClosedGoalMutation(
        coord,
        input.action,
        cause,
        executionRevoked,
        goalIdBeforeMutation
      );
      this.emitGoalMutationError(message);
      return { type: 'interrupted' };
    }
  }

  private emitGoalMutationError(message: string): void {
    this.emitAppend({
      role: 'error',
      title: 'target',
      content: message,
      errorLayer: 'runtime',
    });
    this.emitStatus(message);
  }

  private ensureGoalCoordinator(
    ensureSession: boolean
  ): import('./goals/coordinator').GoalCoordinator | null {
    if (ensureSession) {
      this.options.runtime.ensureSession();
    }
    const session = this.options.runtime.getSession();
    const sessionId = session?.id;
    if (!sessionId) return this.goalCoordinator;
    if (this.goalCoordinator && this.goalCoordinatorSessionId === sessionId) {
      return this.goalCoordinator;
    }

    return this.bindGoalCoordinator(
      sessionId,
      true,
      session.projectPath || this.options.runtime.cwd
    );
  }

  private bindGoalCoordinator(
    sessionId: string,
    recoverActive: boolean,
    projectPath: string
  ): import('./goals/coordinator').GoalCoordinator {
    const { GoalCoordinator } =
      require('./goals/coordinator') as typeof import('./goals/coordinator');
    const coord = new GoalCoordinator(projectPath, sessionId);
    coord.load(recoverActive);
    if (coord.lastLoadIssue) {
      this.emitAppend({
        role: 'error',
        title: 'target recovery',
        content: `${coord.lastLoadIssue.code}: ${coord.lastLoadIssue.message}. Run orion doctor for recovery guidance.`,
        errorLayer: 'runtime',
      });
    }
    this.goalCoordinator = coord;
    this.goalCoordinatorSessionId = sessionId;
    if ('setGoalCoordinator' in this.runner) {
      (this.runner as AgentChatController).setGoalCoordinator(coord);
    }
    return coord;
  }

  private activeProjectPath(): string {
    return this.options.runtime.getSession()?.projectPath || this.options.runtime.cwd;
  }

  private formatTargetStatus(coord: import('./goals/coordinator').GoalCoordinator): string {
    const goal = coord.goal;
    if (!goal) {
      return 'Target: no active goal. Use /target <objective> to create one.';
    }
    const objective =
      goal.objective.length > 60 ? `${goal.objective.slice(0, 57)}...` : goal.objective;
    const tokens =
      goal.tokensUsed >= 1000 ? `${(goal.tokensUsed / 1000).toFixed(1)}K` : String(goal.tokensUsed);
    const lines = [
      `Target: [${goal.status}] ${objective} | ${goal.continuationCount} turns | ${tokens} tokens${goal.tokenBudget ? ` | budget ${tokens}/${goal.tokenBudget}` : ''}`,
    ];
    const contract = goal.contract;
    const plan = contract?.planSnapshot;
    if (plan) {
      lines.push(
        `Plan: r${plan.revision} ${plan.phase}${plan.nextAction ? ` | next: ${plan.nextAction}` : ''}`
      );
    }
    if (contract?.successCriteria.length) {
      const passed = contract.successCriteria.filter(
        criterion => criterion.status === 'passed'
      ).length;
      const failed = contract.successCriteria.filter(
        criterion => criterion.status === 'failed'
      ).length;
      const stale = contract.successCriteria.filter(
        criterion => criterion.status === 'stale'
      ).length;
      const pending = contract.successCriteria.length - passed - failed - stale;
      lines.push(
        `Criteria: ${pending} pending | ${passed}/${contract.successCriteria.length} passed | ${failed} failed | ${stale} stale`
      );
    }
    if (goal.completionAudit?.remainingRequirements.length) {
      lines.push(`Audit: ${goal.completionAudit.remainingRequirements.slice(0, 3).join(' | ')}`);
    }
    if (goal.stopReason) lines.push(`Resume: ${goal.stopReason.message}`);
    const recentEvidence = (goal.evidenceLedger ?? []).slice(-3);
    if (recentEvidence.length > 0) {
      lines.push(
        `Evidence: ${recentEvidence
          .map(item => `${item.id} ${item.kind}/${item.result} ${item.subject}`)
          .join(' | ')}`
      );
    }
    return lines.join('\n');
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
    chatOptions.onVerificationStateChange =
      chatOptions.onVerificationStateChange ??
      (state => this.turnController.setVerificationState(state));
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
          }
        );
      };
    }
    const configuredPreflight = chatOptions.beforeProviderRequest;
    chatOptions.beforeProviderRequest = async context => {
      if (configuredPreflight) {
        const configuredDecision = await configuredPreflight(context);
        if (!configuredDecision.available) return configuredDecision;
      }

      const coord = this.goalCoordinator;
      const goal = coord?.goal;
      if (!coord || !goal || goal.status !== 'active' || !goal.tokenBudget) {
        return { available: true };
      }

      const projectedTokens = Math.max(
        1,
        context.estimatedPromptTokens,
        goal.lastTurn?.totalTokens ?? 0
      );
      const decision = budgetPreflight(
        goal.tokensUsed + this.goalProviderReservedTokens,
        goal.tokenBudget,
        projectedTokens
      );
      if (!decision.available) {
        try {
          coord.limitBudget(decision.reason ?? 'Token budget unavailable for provider request.');
        } catch (cause) {
          const message = this.failClosedGoalMutation(
            coord,
            'provider_budget_stop',
            cause,
            false,
            goal.goalId
          );
          this.emitGoalMutationError(message);
          return { available: false, reason: message };
        }
        const snapshot = coord.snapshot();
        if (snapshot) {
          this.emitGoalEvent({
            type: 'goal_updated',
            goal: snapshot,
            reason: `provider request ${context.operation} attempt ${context.attempt} rejected by token budget`,
          });
        }
        return decision;
      }

      // Reserve the projected cost before the network call. Failed retries and
      // fallbacks keep their reservation because providers may charge attempts
      // that fail before returning usage. Actual successful usage is persisted
      // at turn finalization; reservations reset only when the next root turn starts.
      this.goalProviderReservedTokens += projectedTokens;
      return decision;
    };
    return Object.keys(chatOptions).length > 0 ? chatOptions : undefined;
  }
}
