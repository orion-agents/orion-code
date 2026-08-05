/**
 * orion code - Tool Scheduler
 *
 * Extracts tool grouping, permission checks, concurrent execution, and
 * ordered result emission from query.ts into a testable module.
 *
 * Input: tool calls from LLM + tool registry + permission context + abort signal
 * Output: execution results in original call order
 */

import type { OpenHorseTool, PermissionResult, ToolContext } from './tool';
import {
  externalAssertionMatchesInvocation,
  isToolExternalAssertion,
  type ToolExternalAssertion,
} from './external-assertion';
import type { Message } from '../services/llm';
import type { ToolAllowlistEvaluator, ToolAllowlistMatch } from '../services/tool-allowlist';
import type { DriftCheckResult } from '../harness/types';

// ============================================================================
// Types
// ============================================================================

type ToolCallRecord = NonNullable<Message['tool_calls']>[number];

export interface PreparedToolCall {
  index: number;
  tc: ToolCallRecord;
  args: Record<string, unknown>;
  tool: OpenHorseTool | undefined;
  attemptId: string;
  drift: DriftCheckResult | undefined;
  permission: PermissionResult | undefined;
  /**
   * Winning project allowlist rule, if any.
   * Optional so external callers constructing a PreparedToolCall stay source-compatible.
   */
  allowlist?: ToolAllowlistMatch;
  canRunConcurrently: boolean;
}

export interface ExecutedToolCall {
  prepared: PreparedToolCall;
  result: string;
  duration: number;
  success: boolean;
  error?: string;
  summary?: string;
  outputBytes?: number;
  artifactRef?: { id: string; outputBytes: number };
  externalAssertion?: ToolExternalAssertion;
  strategyResult: 'success' | 'failed';
  strategyError?: string;
  permissionDecision?: ToolPermissionDecision;
}

export type PermissionDecisionSource =
  | 'tool_policy'
  | 'config_allow'
  | 'config_deny'
  | 'user'
  | 'missing_confirmation'
  | 'drift_guard'
  | 'plan_mode'
  | 'mode_auto'
  | 'mode_accept_edits'
  | 'allowlist_allow'
  | 'allowlist_deny';

export interface ToolPermissionDecision {
  behavior?: PermissionResult['behavior'];
  approved: boolean;
  source: PermissionDecisionSource;
  reason?: string;
  duration?: number;
}

export interface ToolSchedule {
  parallel: PreparedToolCall[];
  serial: PreparedToolCall[];
}

export interface ToolSchedulerOptions {
  /** Tool calls from the LLM response */
  toolCalls: NonNullable<Message['tool_calls']>;
  /** Available tool registry */
  tools: OpenHorseTool[];
  /** Tool executor: (name, args, abortSignal?) => result string */
  toolExecutor: (
    name: string,
    args: Record<string, unknown>,
    abortSignal?: AbortSignal
  ) => Promise<string>;
  /** Permission mode */
  permissionMode?: string;
  /** Fallback for permission checks that would need an interactive prompt */
  toolConfirmation?: string;
  /** Project-scoped allowlist rule engine (see services/tool-allowlist). */
  toolAllowlist?: ToolAllowlistEvaluator;
  /** Optional UI confirmation hook for tools whose permission check returns ask */
  confirmToolUse?: (request: {
    name: string;
    args: Record<string, unknown>;
    reason?: string;
    abortSignal?: AbortSignal;
  }) => Promise<boolean>;
  /** Tool execution context */
  toolContext?: ToolContext;
  /** Abort signal */
  abortSignal?: AbortSignal;
  /** Maximum number of concurrency-safe tools to run at once. */
  maxParallelToolCalls?: number;
  /** Start a tracking approach for strategy tracker (returns attemptId) */
  startApproach?: (toolName: string) => string;
  /** Add tool to strategy tracker */
  addToolToTracker?: (attemptId: string, toolName: string) => void;
  /** Harness drift check callback */
  harnessDriftCheck?: (params: {
    name: string;
    args: Record<string, unknown>;
  }) => DriftCheckResult | undefined;
  /** Harness blocked result formatter */
  harnessBlockedResult?: (drift: DriftCheckResult) => string;
}

// ============================================================================
// Preparation
// ============================================================================

function parseToolArgs(tc: ToolCallRecord): Record<string, unknown> {
  const rawArgs = tc.function.arguments || '';
  if (!rawArgs) return {};
  try {
    return JSON.parse(rawArgs) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * How a `behavior: 'ask'` permission should be resolved for the active permission mode.
 * - `block`   : plan mode is read-only, the tool must not run at all.
 * - `allow`   : the mode itself grants approval (auto / acceptEdits for file edits).
 * - `confirm` : fall through to toolConfirmation policy / interactive confirmation.
 */
export type AskResolution = 'block' | 'allow' | 'confirm';

/**
 * Resolve an `ask` permission against the permission mode.
 *
 * Historically this logic was inlined as `permissionMode === 'default'`, which meant
 * every non-default mode (plan / acceptEdits / auto) silently skipped confirmation and
 * executed the tool. That defeated plan mode's read-only guarantee and widened
 * acceptEdits from "auto-accept file edits" to "auto-accept everything".
 */
export function resolveAskPermission(
  permissionMode: string | undefined,
  tool: OpenHorseTool | undefined,
  args: Record<string, unknown>
): AskResolution {
  switch (permissionMode) {
    case 'plan':
      return 'block';
    case 'auto':
      return 'allow';
    case 'acceptEdits':
      return tool?.isFileEdit?.(args) === true ? 'allow' : 'confirm';
    default:
      return 'confirm';
  }
}

/**
 * Outcome of the full permission gate, before the `toolConfirmation` fallback
 * and interactive confirmation are considered.
 *
 * - `deny`    : hard refusal, `behavior: 'deny'` (tool policy or allowlist deny rule).
 * - `block`   : the tool asked for confirmation but the mode forbids running it (plan mode).
 * - `allow`   : approved without a prompt. `source` is set when the approval was
 *               an explicit escalation decision worth auditing.
 * - `confirm` : fall through to toolConfirmation / interactive confirmation.
 */
export interface EffectivePermission {
  outcome: 'deny' | 'block' | 'allow' | 'confirm';
  source?: PermissionDecisionSource;
  reason?: string;
}

/**
 * Resolve the tool policy, project allowlist and permission mode into one decision.
 *
 * Precedence (most restrictive first, see services/tool-allowlist for the contract):
 *   1. tool `checkPermissions() === 'deny'`  — never overridable by config
 *   2. allowlist `deny:` rule                — project can always tighten
 *   3. neither the tool nor a rule asks      — plain allow
 *   4. plan mode                             — read-only, block anything that asks
 *   5. allowlist `ask:` rule                 — explicit escalation beats auto / acceptEdits
 *   6. allowlist `allow:` rule               — only for non-destructive tools
 *   7. permission mode (auto / acceptEdits)
 *   8. otherwise confirm
 */
export function resolveEffectivePermission(input: {
  toolName: string;
  tool?: OpenHorseTool;
  args: Record<string, unknown>;
  permission?: PermissionResult;
  permissionMode?: string;
  allowlist?: ToolAllowlistMatch;
}): EffectivePermission {
  const { toolName, tool, args, permission, permissionMode, allowlist } = input;

  if (permission?.behavior === 'deny') {
    return {
      outcome: 'deny',
      source: 'tool_policy',
      reason: permission.reason || 'Permission denied',
    };
  }

  if (allowlist?.effect === 'deny') {
    return {
      outcome: 'deny',
      source: 'allowlist_deny',
      reason: `Tool ${toolName} is denied by project allowedTools rule "${allowlist.rule}"`,
    };
  }

  const asks = permission?.behavior === 'ask' || allowlist?.effect === 'ask';
  if (!asks) return { outcome: 'allow' };

  const reason =
    permission?.behavior === 'ask'
      ? permission.reason
      : `Confirmation required by project allowedTools rule "${allowlist?.rule}"`;

  if (permissionMode === 'plan') {
    return { outcome: 'block', source: 'plan_mode', reason };
  }

  if (allowlist?.effect === 'ask') {
    return { outcome: 'confirm', reason };
  }

  if (allowlist?.effect === 'allow' && tool?.isDestructive?.(args) !== true) {
    return {
      outcome: 'allow',
      source: 'allowlist_allow',
      reason: `Auto-approved by project allowedTools rule "${allowlist.rule}"`,
    };
  }

  const modeResolution = resolveAskPermission(permissionMode, tool, args);
  if (modeResolution === 'allow') {
    return {
      outcome: 'allow',
      source: permissionMode === 'auto' ? 'mode_auto' : 'mode_accept_edits',
      reason,
    };
  }

  return { outcome: 'confirm', reason };
}

/**
 * Prepare tool calls: parse args, check drift, check permissions, determine concurrency.
 * Re-serializes tc.function.arguments to ensure valid JSON.
 */
export function prepareToolCalls(options: ToolSchedulerOptions): PreparedToolCall[] {
  const { toolCalls, tools } = options;
  const preparedCalls: PreparedToolCall[] = [];

  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    const args = parseToolArgs(tc);
    // Re-serialize to ensure valid JSON for next API call
    tc.function.arguments = JSON.stringify(args);

    const attemptId = options.startApproach?.(tc.function.name) ?? `tool-${i}`;
    options.addToolToTracker?.(attemptId, tc.function.name);
    const tool = tools.find(t => t.name === tc.function.name);
    const drift = options.harnessDriftCheck?.({ name: tc.function.name, args });
    const permission =
      tool?.checkPermissions && options.toolContext
        ? tool.checkPermissions(args, options.toolContext)
        : undefined;
    const allowlist = options.toolAllowlist?.(tc.function.name, args);
    const effective = resolveEffectivePermission({
      toolName: tc.function.name,
      tool,
      args,
      permission,
      permissionMode: options.permissionMode,
      allowlist,
    });
    const confirmation = options.toolConfirmation ?? 'ask';
    const needsInteractiveConfirmation =
      effective.outcome === 'confirm' && confirmation === 'ask' && Boolean(options.confirmToolUse);
    const canRunConcurrently =
      tool?.isConcurrencySafe?.(args) === true &&
      drift?.status !== 'block' &&
      effective.outcome !== 'deny' &&
      !needsInteractiveConfirmation;

    preparedCalls.push({
      index: i,
      tc,
      args,
      tool,
      attemptId,
      drift,
      permission,
      allowlist,
      canRunConcurrently,
    });
  }

  return preparedCalls;
}

// ============================================================================
// Execution
// ============================================================================

function isArtifactRef(value: unknown): value is { id: string; outputBytes: number } {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.outputBytes === 'number';
}

function parseToolResult(
  result: string
): Pick<
  ExecutedToolCall,
  | 'success'
  | 'error'
  | 'summary'
  | 'outputBytes'
  | 'artifactRef'
  | 'externalAssertion'
  | 'strategyResult'
  | 'strategyError'
> {
  try {
    const parsed = JSON.parse(result);
    const success = parsed.success === true;
    const outputBytes = typeof parsed.outputBytes === 'number' ? parsed.outputBytes : undefined;
    const artifactRef = isArtifactRef(parsed.artifactRef) ? parsed.artifactRef : undefined;
    return {
      success,
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
      summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
      outputBytes,
      artifactRef,
      externalAssertion: isToolExternalAssertion(parsed.externalAssertion)
        ? parsed.externalAssertion
        : undefined,
      strategyResult: success ? ('success' as const) : ('failed' as const),
      strategyError: success ? undefined : parsed.error || 'Unknown error',
    };
  } catch {
    return {
      success: true,
      summary: result,
      outputBytes: Buffer.byteLength(result, 'utf8'),
      strategyResult: 'success' as const,
    };
  }
}

function failedExecution(prepared: PreparedToolCall, err: unknown): ExecutedToolCall {
  const message = err instanceof Error ? err.message : String(err);
  const result = JSON.stringify({
    success: false,
    error: `Tool execution error: ${message}`,
  });
  return {
    prepared,
    result,
    duration: 0,
    success: false,
    error: `Tool execution error: ${message}`,
    strategyResult: 'failed',
    strategyError: message,
  };
}

function executePreparedTool(
  prepared: PreparedToolCall,
  toolExecutor: ToolSchedulerOptions['toolExecutor'],
  abortSignal?: AbortSignal,
  confirmToolUse?: ToolSchedulerOptions['confirmToolUse'],
  permissionMode?: string,
  toolConfirmation?: string,
  harnessBlockedResult?: ToolSchedulerOptions['harnessBlockedResult']
): Promise<ExecutedToolCall> {
  const start = Date.now();
  const { tc, args, tool, drift, permission, allowlist } = prepared;
  let permissionDecision: ToolPermissionDecision | undefined;

  const exec = async (): Promise<string> => {
    try {
      return await toolExecutor(tc.function.name, args, abortSignal);
    } catch (err: any) {
      return JSON.stringify({
        success: false,
        error: `Tool execution error: ${err.message}`,
      });
    }
  };

  const run = async (): Promise<string> => {
    if (drift?.status === 'block') {
      permissionDecision = {
        behavior: 'deny',
        approved: false,
        source: 'drift_guard',
        reason: drift.reason || 'Blocked by Context Harness',
      };
      return harnessBlockedResult
        ? harnessBlockedResult(drift)
        : JSON.stringify({ success: false, error: 'Blocked by Context Harness' });
    }
    // Resolve tool policy + project allowlist + permission mode in one place.
    // Previously the `ask` branch was gated on `permissionMode === 'default'`, so
    // plan / acceptEdits / auto fell through to exec() and bypassed confirmation.
    const effective = resolveEffectivePermission({
      toolName: tc.function.name,
      tool,
      args,
      permission,
      permissionMode,
      allowlist,
    });

    if (effective.outcome === 'deny') {
      permissionDecision = {
        behavior: 'deny',
        approved: false,
        source: effective.source ?? 'tool_policy',
        reason: effective.reason || 'Permission denied',
      };
      return JSON.stringify({
        success: false,
        error: effective.reason || 'Permission denied',
      });
    }

    if (effective.outcome === 'block') {
      permissionDecision = {
        behavior: 'ask',
        approved: false,
        source: effective.source ?? 'plan_mode',
        reason: effective.reason,
      };
      return JSON.stringify({
        success: false,
        error: `Tool ${tc.function.name} requires confirmation and is blocked in plan mode (read-only).`,
      });
    }

    if (effective.outcome === 'allow') {
      if (effective.source) {
        permissionDecision = {
          behavior: 'ask',
          approved: true,
          source: effective.source,
          reason: effective.reason,
        };
      }
      return exec();
    }

    const confirmation = toolConfirmation ?? 'ask';
    if (confirmation === 'allow') {
      permissionDecision = {
        behavior: 'ask',
        approved: true,
        source: 'config_allow',
        reason: effective.reason,
      };
      return exec();
    }
    if (confirmToolUse && confirmation === 'ask') {
      const permissionStart = Date.now();
      const approved = await confirmToolUse({
        name: tc.function.name,
        args,
        reason: effective.reason,
        abortSignal,
      });
      permissionDecision = {
        behavior: 'ask',
        approved,
        source: 'user',
        reason: effective.reason,
        duration: Date.now() - permissionStart,
      };
      return approved
        ? await exec()
        : JSON.stringify({
            success: false,
            error: `Tool ${tc.function.name} requires user confirmation and was denied by user.`,
          });
    }
    permissionDecision = {
      behavior: 'ask',
      approved: false,
      source: confirmation === 'deny' ? 'config_deny' : 'missing_confirmation',
      reason: effective.reason,
    };
    return JSON.stringify({
      success: false,
      error:
        confirmation === 'deny'
          ? `Tool ${tc.function.name} requires user confirmation and was denied by toolConfirmation=deny.`
          : `Tool ${tc.function.name} requires user confirmation.`,
    });
  };

  return run().then(result => {
    const duration = Date.now() - start;
    const parsed = parseToolResult(result);
    if (
      parsed.externalAssertion &&
      !externalAssertionMatchesInvocation({
        assertion: parsed.externalAssertion,
        name: tc.function.name,
        args,
        success: parsed.success,
      })
    ) {
      parsed.externalAssertion = undefined;
    }
    return {
      prepared,
      result,
      duration,
      permissionDecision,
      ...parsed,
    };
  });
}

/**
 * Execute prepared tool calls, respecting concurrency flags.
 * Parallel-safe tools run concurrently; unsafe tools run serially.
 * Results are returned in original call order.
 *
 * Returns an async generator that yields each result as it completes.
 */
export async function* executeToolCalls(
  preparedCalls: PreparedToolCall[],
  options: {
    toolExecutor: ToolSchedulerOptions['toolExecutor'];
    abortSignal?: AbortSignal;
    confirmToolUse?: ToolSchedulerOptions['confirmToolUse'];
    permissionMode?: string;
    toolConfirmation?: string;
    harnessBlockedResult?: ToolSchedulerOptions['harnessBlockedResult'];
    maxParallelToolCalls?: number;
  }
): AsyncGenerator<ExecutedToolCall> {
  let parallelGroup: PreparedToolCall[] = [];
  const maxParallelToolCalls = Math.max(1, options.maxParallelToolCalls ?? 6);

  const runParallelGroup = async (group: PreparedToolCall[]): Promise<ExecutedToolCall[]> => {
    const settled = await Promise.allSettled(
      group.map(call =>
        executePreparedTool(
          call,
          options.toolExecutor,
          options.abortSignal,
          options.confirmToolUse,
          options.permissionMode,
          options.toolConfirmation,
          options.harnessBlockedResult
        )
      )
    );
    return settled.map((result, index) =>
      result.status === 'fulfilled' ? result.value : failedExecution(group[index], result.reason)
    );
  };

  for (const prepared of preparedCalls) {
    if (prepared.canRunConcurrently) {
      parallelGroup.push(prepared);
      if (parallelGroup.length >= maxParallelToolCalls) {
        const executedGroup = await runParallelGroup(parallelGroup);
        executedGroup.sort((a, b) => a.prepared.index - b.prepared.index);
        for (const executed of executedGroup) {
          yield executed;
        }
        parallelGroup = [];
      }
      continue;
    }

    if (parallelGroup.length > 0) {
      const executedGroup = await runParallelGroup(parallelGroup);
      // Sort by original index to maintain order
      executedGroup.sort((a, b) => a.prepared.index - b.prepared.index);
      for (const executed of executedGroup) {
        yield executed;
      }
      parallelGroup = [];
    }

    const executed = await executePreparedTool(
      prepared,
      options.toolExecutor,
      options.abortSignal,
      options.confirmToolUse,
      options.permissionMode,
      options.toolConfirmation,
      options.harnessBlockedResult
    ).catch(err => failedExecution(prepared, err));
    yield executed;
  }

  if (parallelGroup.length > 0) {
    const executedGroup = await runParallelGroup(parallelGroup);
    executedGroup.sort((a, b) => a.prepared.index - b.prepared.index);
    for (const executed of executedGroup) {
      yield executed;
    }
  }
}

// ============================================================================
// Schedule inspection (for testing)
// ============================================================================

/**
 * Inspect how prepared tool calls would be scheduled.
 * Returns parallel and serial groups without executing.
 */
export function inspectSchedule(preparedCalls: PreparedToolCall[]): ToolSchedule {
  const parallel: PreparedToolCall[] = [];
  const serial: PreparedToolCall[] = [];
  for (const call of preparedCalls) {
    if (call.canRunConcurrently) {
      parallel.push(call);
    } else {
      serial.push(call);
    }
  }
  return { parallel, serial };
}
