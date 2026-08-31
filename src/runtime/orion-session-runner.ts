import type {
  AgentRuntimeCompactInputV1,
  AgentRuntimeCompactResultV1,
  AgentRuntimeRunnerV1,
  AgentRuntimeRunInputOptionsV1,
} from './agent-runtime-runner';
import type { AgentTurnRequest } from './goals/types';
import type { GoalRuntimeControlResultV2, GoalRuntimeControlV2 } from './goal-runtime-coordinator';
import type { OrionRuntimeDiagnosticsV1, OrionRuntimeV1 } from './orion-runtime-v1';
import { ThreadUiAdapterV1, type ThreadUiModeResolverV1 } from './thread-ui-adapter';
import type { UiEventSink } from './ui-events';
import type { ThreadSessionRuntimeActivationV1 } from './thread-session-view';
import { resolvePlanReviewV1 } from './plan-review';
import type { PlanReviewProjectionV1 } from './thread-projection';
import { SessionOwnershipError, type SessionOwnershipCoordinator } from './session-ownership';

export interface OrionSessionRunnerOptionsV1 {
  readonly eventSink: UiEventSink;
  readonly getSessionId: () => string;
  readonly createRuntime: (
    sessionId: string,
    activation?: ThreadSessionRuntimeActivationV1
  ) => OrionRuntimeV1 | Promise<OrionRuntimeV1>;
  readonly mode?: ThreadUiModeResolverV1;
  /** Renderer-neutral observer installed after the sole session Runtime starts. */
  readonly onActiveRuntime?: (
    runtime: OrionRuntimeV1,
    sessionId: string,
    activation?: ThreadSessionRuntimeActivationV1
  ) => void | (() => void);
  /** Historical transcript may instead be restored from a cursor-bound surface snapshot. */
  readonly replayHistoryOnRestore?: boolean;
  readonly ownership?: SessionOwnershipCoordinator;
}

interface ActiveSessionRuntimeV1 {
  readonly sessionId: string;
  readonly runtime: OrionRuntimeV1;
  readonly adapter: ThreadUiAdapterV1;
  readonly disposeObserver?: () => void;
}

/**
 * Session-aware product runner. A session switch starts its candidate while
 * both ownership leases are held, then closes the previous sole Thread owner.
 */
export class OrionSessionRunnerV1 implements AgentRuntimeRunnerV1 {
  private active?: ActiveSessionRuntimeV1;
  private transition: Promise<void> | undefined;
  private readonly backgroundDrains = new WeakMap<ActiveSessionRuntimeV1, Promise<void>>();
  private closed = false;

  constructor(private readonly options: OrionSessionRunnerOptionsV1) {}

  async runInput(input: string, options?: AgentRuntimeRunInputOptionsV1): Promise<void> {
    const active = await this.ensureActive();
    return active.adapter.runInput(input, options);
  }

  async runRequest(
    request: AgentTurnRequest,
    options?: AgentRuntimeRunInputOptionsV1
  ): Promise<void> {
    const active = await this.ensureActive();
    return active.adapter.runRequest(request, options);
  }

  async restoreSession(activation?: ThreadSessionRuntimeActivationV1): Promise<void> {
    return this.activateSession(this.options.getSessionId(), activation);
  }

  async activateSession(
    sessionId: string,
    activation?: ThreadSessionRuntimeActivationV1
  ): Promise<void> {
    if (this.closed) throw new Error('Orion session runner is closed.');
    if (this.transition) await this.transition;
    if (!sessionId.trim()) throw new Error('Orion session identity is empty.');

    const transition = this.activateOwnership(sessionId, () =>
      this.switchTo(
        sessionId,
        this.options.replayHistoryOnRestore === false ? undefined : 0,
        activation
      ).then(() => undefined)
    );
    this.transition = transition;
    try {
      await transition;
    } finally {
      if (this.transition === transition) this.transition = undefined;
    }
    // A typed activation denotes an actual Session selection and is followed
    // by a bounded transcript replacement from the command surface. A same-
    // Session runtime rebind (for example after Settings changes) has no such
    // replacement and must preserve the current renderer window.
    if (activation || this.options.replayHistoryOnRestore !== false) {
      this.options.eventSink.clearTranscript();
    }
    this.active?.adapter.flush();
  }

  async controlGoal(control: GoalRuntimeControlV2): Promise<GoalRuntimeControlResultV2> {
    const active = await this.ensureActive();
    const result = await active.runtime.controlGoal(control);
    if (result.scheduleContinuation) {
      // The control result is authoritative as soon as its own internal turn is
      // durable. A productive Goal may never become idle, so awaiting the whole
      // Thread here would hide `/goal create|resume` indefinitely. Keep the UI
      // projection pump alive in the background while returning the committed
      // control result immediately.
      this.startBackgroundDrain(active);
    }
    if (this.active === active) active.adapter.flush();
    return result;
  }

  async compact(input: AgentRuntimeCompactInputV1 = {}): Promise<AgentRuntimeCompactResultV1> {
    const active = await this.ensureActive();
    const admission = active.runtime.compact(input);
    if (admission.status !== 'started') {
      return {
        status: 'rejected',
        reason: admission.status === 'rejected' ? admission.reason : 'invalid_admission',
      };
    }
    this.startBackgroundDrain(active);
    const status = await active.runtime.thread.waitForTurnTerminal(admission.turnId);
    if (this.active === active) active.adapter.flush();
    return { status, turnId: admission.turnId };
  }

  async diagnostics(): Promise<OrionRuntimeDiagnosticsV1> {
    const active = await this.ensureActive();
    return active.runtime.diagnostics();
  }

  async planReviewState(): Promise<PlanReviewProjectionV1 | undefined> {
    const active = await this.ensureActive();
    return active.runtime.thread.getProjection().planReview;
  }

  async reviewPlan(
    input: Parameters<typeof resolvePlanReviewV1>[1]
  ): Promise<ReturnType<typeof resolvePlanReviewV1>> {
    const active = await this.ensureActive();
    const receipt = resolvePlanReviewV1(active.runtime, input);
    if (receipt.admission.status === 'started' || receipt.admission.status === 'queued') {
      this.startBackgroundDrain(active);
    }
    if (this.active === active) active.adapter.flush();
    return receipt;
  }

  interrupt(reason = 'user interrupted'): void {
    this.active?.adapter.interrupt(reason);
  }

  async close(reason = 'session runner closed'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const transitioning = this.transition;
    if (transitioning) {
      try {
        await transitioning;
      } catch {
        // A failed start owns its own rollback.
      }
    }
    await this.closeActive(reason);
  }

  private async ensureActive(): Promise<ActiveSessionRuntimeV1> {
    if (this.closed) throw new Error('Orion session runner is closed.');
    const sessionId = this.options.getSessionId();
    if (!sessionId.trim()) throw new Error('Orion session identity is empty.');
    if (this.active?.sessionId === sessionId) return this.active;
    if (this.transition) {
      await this.transition;
      return this.ensureActive();
    }

    const transition = this.activateOwnership(sessionId, () =>
      this.switchTo(sessionId).then(() => undefined)
    );
    this.transition = transition;
    try {
      await transition;
    } finally {
      if (this.transition === transition) this.transition = undefined;
    }
    const active = this.active;
    if (!active || active.sessionId !== sessionId) {
      throw new Error(`Session ${sessionId} did not become active.`);
    }
    return active;
  }

  private async switchTo(
    sessionId: string,
    cursor?: number,
    activation?: ThreadSessionRuntimeActivationV1
  ): Promise<ActiveSessionRuntimeV1> {
    const previous = this.active;
    if (this.closed) throw new Error('Orion session runner closed during session switch.');
    if (previous?.sessionId === sessionId) {
      this.active = undefined;
      await this.closeSpecific(previous, 'session runtime rebound');
    }
    const runtime = await this.options.createRuntime(sessionId, activation);
    let disposeObserver: (() => void) | undefined;
    let adapter: ThreadUiAdapterV1 | undefined;
    try {
      await runtime.start();
      disposeObserver = this.options.onActiveRuntime?.(runtime, sessionId, activation) ?? undefined;
      adapter = new ThreadUiAdapterV1({
        runtime: runtime.thread,
        uiEventSink: this.options.eventSink,
        mode: this.options.mode,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const active = Object.freeze({ sessionId, runtime, adapter, disposeObserver });
      if (previous && previous.sessionId !== sessionId && previous !== this.active) {
        throw new Error('Orion session runtime changed while a replacement was starting.');
      }
      if (previous && previous.sessionId !== sessionId && previous === this.active) {
        this.active = undefined;
        await this.closeSpecific(
          previous,
          previous.sessionId === sessionId ? 'session runtime rebound' : 'session switched'
        );
      }
      this.active = active;
      return active;
    } catch (error) {
      disposeObserver?.();
      adapter?.close('session runtime start failed');
      try {
        await runtime.close('session runtime start failed');
      } catch (closeError) {
        throw new SessionOwnershipError(
          `Session ${sessionId} transition failed and its candidate runtime could not close.`,
          [error, closeError]
        );
      }
      throw error;
    }
  }

  private async closeActive(reason: string): Promise<void> {
    const active = this.active;
    this.active = undefined;
    if (!active) return;
    await this.closeSpecific(active, reason);
  }

  private async closeSpecific(active: ActiveSessionRuntimeV1, reason: string): Promise<void> {
    active.disposeObserver?.();
    active.adapter.close(reason);
    await active.runtime.close(reason);
  }

  private activateOwnership(sessionId: string, transition: () => Promise<void>): Promise<void> {
    return this.options.ownership?.activate(sessionId, transition) ?? transition();
  }

  private async drainUntilIdle(active: ActiveSessionRuntimeV1): Promise<void> {
    let idle = false;
    const idlePromise = active.runtime.thread.waitForIdle().finally(() => {
      idle = true;
    });
    while (!idle) {
      if (this.active === active) active.adapter.flush();
      await Promise.race([idlePromise, new Promise<void>(resolve => setImmediate(resolve))]);
    }
    await idlePromise;
    if (this.active === active) active.adapter.flush();
  }

  private startBackgroundDrain(active: ActiveSessionRuntimeV1): void {
    if (this.backgroundDrains.has(active)) return;
    const drain = this.drainUntilIdle(active)
      .catch(() => {
        // Durable Thread facts remain replayable. A presentation pump failure
        // must not manufacture a second runtime owner or abort Goal execution.
      })
      .finally(() => this.backgroundDrains.delete(active));
    this.backgroundDrains.set(active, drain);
  }
}
