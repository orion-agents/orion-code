/**
 * SubagentRunner: runs a single child agent to completion and parses its result.
 *
 * The runner is the boundary between the Supervisor and the shared `query()`
 * loop. It is deliberately thin: it derives a child abort signal from the
 * parent, applies a per-child timeout, invokes an injectable `executeQuery`,
 * and normalizes the outcome through {@link parseSubtaskResult}.
 *
 * `executeQuery` is injected so the runner can be tested without a live LLM;
 * the production binding wraps `query()` with a per-child LLMService.
 */

import { buildChildMessages } from './context-builder';
import { parseSubtaskResult } from './result-parser';
import type {
  SubtaskPacket,
  SubtaskResult,
  SubtaskResultStatus,
  SubtaskUsage,
} from './types';
import { EMPTY_SUBTASK_USAGE } from './types';

/**
 * R5: bounded grace period to let a child query settle after it was aborted
 * (timeout or parent cancel). The abort signal has fired; a cooperative
 * executor stops promptly. An uncooperative executor is abandoned after this
 * window so a stuck child cannot hold the provider slot indefinitely. The
 * abandon is observable: the promise is caught and the (now unobserved)
 * late resolution cannot flip the already-decided terminal status.
 */
const CHILD_SHUTDOWN_GRACE_MS = 2_000;

async function settleWithGrace(queryPromise: Promise<unknown>, graceMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      queryPromise.catch(() => undefined),
      new Promise<void>(resolve => {
        timer = setTimeout(() => resolve(), graceMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A filtered, child-safe tool list with its executor. */
export interface ChildToolSet {
  /** Resolved tool definitions the child may call. */
  tools: unknown[];
  /** Tool name -> executor. */
  toolExecutor: (name: string, args: Record<string, unknown>, abortSignal?: AbortSignal) => Promise<string>;
}

/** Injectable child query function. Returns the final assistant text + usage. */
export type ExecuteChildQuery = (
  messages: ReturnType<typeof buildChildMessages>,
  toolSet: ChildToolSet,
  abortSignal: AbortSignal,
) => Promise<{ content: string; usage: SubtaskUsage }>;

export interface SubagentRunnerDeps {
  /** Canonical project root. */
  cwd: string;
  /** Canonical scope paths (already validated). */
  canonicalScopePaths?: string[];
  /** Filtered child tools + executor. */
  toolSet: ChildToolSet;
  /** Injectable query binding (production wraps query(); tests mock it). */
  executeQuery: ExecuteChildQuery;
  /** Per-child wall-clock timeout. */
  timeoutMs: number;
  /** Parent abort signal; child abort is derived from it. */
  parentAbortSignal?: AbortSignal;
  /** Optional read-only context inputs forwarded to the context builder. */
  rootObjectiveSummary?: string;
  modelLabel?: string;
}

export interface RunSubtaskOutcome {
  result: SubtaskResult;
  /** Whether the child was aborted by the parent (vs its own timeout). */
  parentCancelled: boolean;
}

/**
 * Run one child subtask to a terminal state. Never throws: every failure mode
 * (timeout, cancel, error, non-JSON output) is normalized into a SubtaskResult.
 */
export async function runSubtask(
  packet: SubtaskPacket,
  deps: SubagentRunnerDeps,
  taskId: string,
): Promise<RunSubtaskOutcome> {
  const messages = buildChildMessages({
    cwd: deps.cwd,
    packet,
    canonicalScopePaths: deps.canonicalScopePaths,
    rootObjectiveSummary: deps.rootObjectiveSummary,
    modelLabel: deps.modelLabel,
  });

  const childController = new AbortController();
  let parentAborted = false;
  const onParentAbort = () => {
    parentAborted = true;
    childController.abort();
  };
  if (deps.parentAbortSignal) {
    if (deps.parentAbortSignal.aborted) {
      parentAborted = true;
      childController.abort();
    } else {
      deps.parentAbortSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutPromise = new Promise<{ kind: 'timeout' }>(resolve => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      childController.abort();
      resolve({ kind: 'timeout' });
    }, deps.timeoutMs);
  });

  // R5: parent abort is a distinct terminal outcome that wins the race even
  // if the query subsequently resolves. Without this, a query that resolves
  // just after the abort fires would flip the result to 'completed'.
  // N15: store reference to the second abort listener so it can be cleaned up
  // in the finally block alongside the first.
  let onParentAbortForRace: (() => void) | undefined;
  const parentAbortPromise = new Promise<{ kind: 'parent_abort' }>(resolve => {
    if (parentAborted) {
      resolve({ kind: 'parent_abort' });
      return;
    }
    if (deps.parentAbortSignal) {
      const handler = () => resolve({ kind: 'parent_abort' });
      onParentAbortForRace = handler;
      deps.parentAbortSignal.addEventListener('abort', handler, { once: true });
    }
  });

  const queryPromise = deps
    .executeQuery(messages, deps.toolSet, childController.signal)
    .then(content => ({ kind: 'done' as const, content }))
    .catch(err => ({
      kind: 'error' as const,
      message: err instanceof Error ? err.message : String(err),
    }));

  let status: SubtaskResultStatus;
  let content = '';
  let usage: SubtaskUsage = EMPTY_SUBTASK_USAGE;
  let parentCancelled = false;

  try {
    const outcome = await Promise.race([parentAbortPromise, queryPromise, timeoutPromise]);
    if (outcome.kind === 'parent_abort') {
      // Parent abort wins regardless of whether the query resolves later.
      status = 'cancelled';
      parentCancelled = true;
    } else if (outcome.kind === 'timeout') {
      status = 'timed_out';
    } else if (outcome.kind === 'error') {
      // If the parent aborted, treat as cancel; otherwise a failure.
      if (parentAborted && !timedOut) {
        status = 'cancelled';
        parentCancelled = true;
      } else {
        status = 'failed';
        content = outcome.message;
      }
    } else {
      // R5: even on 'done', if the parent aborted before this resolved, the
      // terminal state must remain cancelled - a late resolve cannot flip it.
      if (parentAborted && !timedOut) {
        status = 'cancelled';
        parentCancelled = true;
      } else {
        status = 'completed';
        content = outcome.content.content;
        usage = outcome.content.usage;
      }
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (deps.parentAbortSignal) {
      deps.parentAbortSignal.removeEventListener('abort', onParentAbort);
      if (onParentAbortForRace) {
        deps.parentAbortSignal.removeEventListener('abort', onParentAbortForRace);
      }
    }
  }

  // R5: on timeout/abort the query promise may still be running in the
  // background (model request or tool call in flight). The provider slot
  // must not be released while the child can still issue requests, and we
  // must not leave an unobserved promise that could fire late side effects.
  // Wait a bounded grace period for the query to settle after the abort
  // signal fired. An uncooperative executor that ignores the signal is
  // logged via the result; the slot is still released after the grace so a
  // stuck child cannot hang the whole turn forever.
  if (status === 'timed_out' || status === 'cancelled') {
    await settleWithGrace(queryPromise, CHILD_SHUTDOWN_GRACE_MS);
  }

  const result = parseSubtaskResult({
    id: taskId,
    role: packet.role,
    content,
    status,
    usage,
  });

  return { result, parentCancelled };
}
