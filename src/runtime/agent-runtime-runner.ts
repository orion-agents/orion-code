import type { AgentInputKind, AgentTurnRequest } from './goals/types';
import type { GoalRuntimeControlResultV2, GoalRuntimeControlV2 } from './goal-runtime-coordinator';
import type { ThreadSessionRuntimeActivationV1 } from './thread-session-view';
import type { PlanReviewActionV1, PlanReviewResolutionReceiptV1 } from './plan-review';
import type { PlanReviewProjectionV1 } from './thread-projection';

/** Renderer-neutral options for one admitted runtime request. */
export interface AgentRuntimeRunInputOptionsV1 {
  readonly abortSignal?: AbortSignal;
  readonly turnId?: number | string;
  readonly persistAsUserMessage?: boolean;
  readonly inputKind?: AgentInputKind;
}

/** Explicit compact request routed through the runtime-owned maintenance transaction. */
export interface AgentRuntimeCompactInputV1 {
  readonly maxMessages?: number;
  readonly focus?: string;
}

export type AgentRuntimeCompactResultV1 =
  | { readonly status: 'completed'; readonly turnId: string }
  | { readonly status: 'failed' | 'interrupted'; readonly turnId: string }
  | { readonly status: 'rejected'; readonly reason: string };

/** Narrow execution port consumed by AgentRuntimeController and every renderer. */
export interface AgentRuntimeRunnerV1 {
  runInput(input: string, options?: AgentRuntimeRunInputOptionsV1): Promise<void>;
  runRequest?(request: AgentTurnRequest, options?: AgentRuntimeRunInputOptionsV1): Promise<void>;
  /** Rebind the selected Session and replay its durable Thread facts without starting a turn. */
  restoreSession?(activation?: ThreadSessionRuntimeActivationV1): Promise<void>;
  controlGoal?(control: GoalRuntimeControlV2): Promise<GoalRuntimeControlResultV2>;
  compact?(input?: AgentRuntimeCompactInputV1): Promise<AgentRuntimeCompactResultV1>;
  planReviewState?(): Promise<PlanReviewProjectionV1 | undefined>;
  reviewPlan?(input: {
    readonly planDigest: string;
    readonly action: PlanReviewActionV1;
    readonly feedback?: string;
  }): Promise<PlanReviewResolutionReceiptV1>;
  interrupt?(reason?: string): void;
  close?(reason?: string): void | Promise<void>;
}
