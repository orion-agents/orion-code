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
import type { Message } from '../services/llm';
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
  | 'drift_guard';

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
  toolExecutor: (name: string, args: Record<string, unknown>, abortSignal?: AbortSignal) => Promise<string>;
  /** Permission mode */
  permissionMode?: string;
  /** Fallback for permission checks that would need an interactive prompt */
  toolConfirmation?: string;
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
  harnessDriftCheck?: (params: { name: string; args: Record<string, unknown> }) => DriftCheckResult | undefined;
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
    const permission = tool?.checkPermissions && options.toolContext
      ? tool.checkPermissions(args, options.toolContext)
      : undefined;
    const confirmation = options.toolConfirmation ?? 'ask';
    const needsInteractiveConfirmation = permission?.behavior === 'ask'
      && options.permissionMode === 'default'
      && confirmation === 'ask'
      && Boolean(options.confirmToolUse);
    const canRunConcurrently = tool?.isConcurrencySafe?.(args) === true
      && drift?.status !== 'block'
      && permission?.behavior !== 'deny'
      && !needsInteractiveConfirmation;

    preparedCalls.push({
      index: i,
      tc,
      args,
      tool,
      attemptId,
      drift,
      permission,
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

function parseToolResult(result: string): Pick<
  ExecutedToolCall,
  'success' | 'error' | 'summary' | 'outputBytes' | 'artifactRef' | 'strategyResult' | 'strategyError'
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
      strategyResult: success ? 'success' as const : 'failed' as const,
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
  harnessBlockedResult?: ToolSchedulerOptions['harnessBlockedResult'],
): Promise<ExecutedToolCall> {
  const start = Date.now();
  const { tc, args, drift, permission } = prepared;
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
    if (permission?.behavior === 'deny') {
      permissionDecision = {
        behavior: 'deny',
        approved: false,
        source: 'tool_policy',
        reason: permission.reason || 'Permission denied',
      };
      return JSON.stringify({
        success: false,
        error: permission.reason || 'Permission denied',
      });
    }
    if (permission?.behavior === 'ask' && permissionMode === 'default') {
      const confirmation = toolConfirmation ?? 'ask';
      if (confirmation === 'allow') {
        permissionDecision = {
          behavior: 'ask',
          approved: true,
          source: 'config_allow',
          reason: permission.reason,
        };
        return exec();
      }
      if (confirmToolUse && confirmation === 'ask') {
        const permissionStart = Date.now();
        const approved = await confirmToolUse({
          name: tc.function.name,
          args,
          reason: permission.reason,
          abortSignal,
        });
        permissionDecision = {
          behavior: 'ask',
          approved,
          source: 'user',
          reason: permission.reason,
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
        reason: permission.reason,
      };
      return JSON.stringify({
        success: false,
        error: confirmation === 'deny'
          ? `Tool ${tc.function.name} requires user confirmation and was denied by toolConfirmation=deny.`
          : `Tool ${tc.function.name} requires user confirmation.`,
      });
    }
    return exec();
  };

  return run().then(result => {
    const duration = Date.now() - start;
    return {
      prepared,
      result,
      duration,
      permissionDecision,
      ...parseToolResult(result),
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
  },
): AsyncGenerator<ExecutedToolCall> {
  let parallelGroup: PreparedToolCall[] = [];
  const maxParallelToolCalls = Math.max(1, options.maxParallelToolCalls ?? 6);

  const runParallelGroup = async (group: PreparedToolCall[]): Promise<ExecutedToolCall[]> => {
    const settled = await Promise.allSettled(
      group.map(call => executePreparedTool(
        call,
        options.toolExecutor,
        options.abortSignal,
        options.confirmToolUse,
        options.permissionMode,
        options.toolConfirmation,
        options.harnessBlockedResult,
      )),
    );
    return settled.map((result, index) =>
      result.status === 'fulfilled' ? result.value : failedExecution(group[index], result.reason),
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
      options.harnessBlockedResult,
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
