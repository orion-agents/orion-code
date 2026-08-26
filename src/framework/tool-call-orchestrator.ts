import type { Message } from '../services/llm';
import type { DriftCheckResult } from '../harness/types';
import type { OrionCodeTool, PermissionResult } from './tool';
import {
  externalAssertionMatchesInvocation,
  isToolExternalAssertion,
  type ToolExternalAssertion,
} from './external-assertion';

type ToolCallRecord = NonNullable<Message['tool_calls']>[number];

/** Stable identity supplied by the model loop to the authoritative executor. */
export interface ToolExecutionMetadata {
  readonly callId: string;
  readonly index: number;
}

/**
 * Optional policy projection returned by the authoritative execution boundary.
 * The model loop observes this receipt; it never computes the decision itself.
 */
export type PermissionDecisionSource =
  | 'tool_policy'
  | 'config_allow'
  | 'config_deny'
  | 'user'
  | 'missing_confirmation'
  | 'drift_guard'
  | 'mode_auto'
  | 'mode_accept_edits'
  | 'allowlist_allow'
  | 'allowlist_deny'
  | 'allowlist_ask'
  | 'missing_risk_metadata'
  | 'risk_guard'
  | 'config_allow_blocked';

export interface ToolPermissionDecision {
  readonly behavior?: PermissionResult['behavior'];
  readonly approved: boolean;
  readonly source: PermissionDecisionSource;
  readonly reason?: string;
  readonly duration?: number;
}

export interface ToolExecutorOutcome {
  readonly result: string;
  readonly permissionDecision?: ToolPermissionDecision;
}

export type AuthoritativeToolExecutor = (
  name: string,
  args: Record<string, unknown>,
  abortSignal?: AbortSignal,
  metadata?: ToolExecutionMetadata
) => Promise<string | ToolExecutorOutcome>;

export interface PreparedToolCall {
  readonly index: number;
  readonly tc: ToolCallRecord;
  readonly args: Record<string, unknown>;
  readonly tool: OrionCodeTool | undefined;
  readonly attemptId: string;
  readonly argumentError?: string;
  readonly drift: DriftCheckResult | undefined;
  readonly canRunConcurrently: boolean;
}

export interface ExecutedToolCall {
  readonly prepared: PreparedToolCall;
  readonly result: string;
  readonly duration: number;
  readonly success: boolean;
  readonly error?: string;
  readonly summary?: string;
  readonly outputBytes?: number;
  readonly artifactRef?: { id: string; outputBytes: number };
  readonly externalAssertion?: ToolExternalAssertion;
  readonly resultTrust?: 'structured' | 'opaque';
  readonly strategyResult: 'success' | 'failed';
  readonly strategyError?: string;
  readonly permissionDecision?: ToolPermissionDecision;
}

export interface PrepareToolCallsOptions {
  readonly toolCalls: NonNullable<Message['tool_calls']>;
  readonly tools: readonly OrionCodeTool[];
  readonly startApproach?: (toolName: string) => string;
  readonly addToolToTracker?: (attemptId: string, toolName: string) => void;
  readonly harnessDriftCheck?: (params: {
    readonly name: string;
    readonly args: Record<string, unknown>;
  }) => DriftCheckResult | undefined;
}

export interface ExecuteToolCallsOptions {
  readonly toolExecutor: AuthoritativeToolExecutor;
  readonly abortSignal?: AbortSignal;
  readonly harnessBlockedResult?: (drift: DriftCheckResult) => string;
  readonly maxParallelToolCalls?: number;
}

/**
 * Parse and validate model tool calls without making authority decisions.
 * Capability, policy, approval, sandboxing, and execution remain owned by ToolGateway.
 */
export function prepareToolCalls(options: PrepareToolCallsOptions): PreparedToolCall[] {
  return options.toolCalls.map((tc, index) => {
    const tool = options.tools.find(candidate => candidate.name === tc.function.name);
    const parsed = parseToolArgs(tc);
    if ('error' in parsed) {
      return {
        index,
        tc,
        args: {},
        tool,
        attemptId: `invalid-tool-${index}`,
        argumentError: parsed.error,
        drift: undefined,
        canRunConcurrently: false,
      };
    }

    const args = parsed.args;
    tc.function.arguments = JSON.stringify(args);
    const inputError = tool?.validateInput?.(args);
    if (inputError) {
      return {
        index,
        tc,
        args,
        tool,
        attemptId: `invalid-tool-${index}`,
        argumentError: inputError,
        drift: undefined,
        canRunConcurrently: false,
      };
    }

    const attemptId = options.startApproach?.(tc.function.name) ?? `tool-${index}`;
    options.addToolToTracker?.(attemptId, tc.function.name);
    const drift = options.harnessDriftCheck?.({ name: tc.function.name, args });
    return {
      index,
      tc,
      args,
      tool,
      attemptId,
      drift,
      canRunConcurrently: drift?.status !== 'block' && tool?.isConcurrencySafe?.(args) === true,
    };
  });
}

/** Execute through one injected authoritative boundary while preserving provider order. */
export async function* executeToolCalls(
  preparedCalls: readonly PreparedToolCall[],
  options: ExecuteToolCallsOptions
): AsyncGenerator<ExecutedToolCall> {
  let parallelGroup: PreparedToolCall[] = [];
  const maxParallelToolCalls = Math.max(1, options.maxParallelToolCalls ?? 6);

  const runGroup = async (group: readonly PreparedToolCall[]): Promise<ExecutedToolCall[]> => {
    const settled = await Promise.allSettled(group.map(call => executePreparedTool(call, options)));
    return settled
      .map((result, index) =>
        result.status === 'fulfilled' ? result.value : failedExecution(group[index], result.reason)
      )
      .sort((left, right) => left.prepared.index - right.prepared.index);
  };

  for (const prepared of preparedCalls) {
    if (prepared.canRunConcurrently) {
      parallelGroup.push(prepared);
      if (parallelGroup.length < maxParallelToolCalls) continue;
      for (const executed of await runGroup(parallelGroup)) yield executed;
      parallelGroup = [];
      continue;
    }

    if (parallelGroup.length > 0) {
      for (const executed of await runGroup(parallelGroup)) yield executed;
      parallelGroup = [];
    }
    yield await executePreparedTool(prepared, options).catch(error =>
      failedExecution(prepared, error)
    );
  }

  if (parallelGroup.length > 0) {
    for (const executed of await runGroup(parallelGroup)) yield executed;
  }
}

function parseToolArgs(tc: ToolCallRecord): { args: Record<string, unknown> } | { error: string } {
  const rawArgs = tc.function.arguments || '';
  if (!rawArgs) return { args: {} };
  try {
    const parsed = JSON.parse(rawArgs) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: `Tool ${tc.function.name} arguments must be a JSON object.` };
    }
    return { args: parsed as Record<string, unknown> };
  } catch {
    return { error: `Tool ${tc.function.name} arguments are not valid JSON.` };
  }
}

async function executePreparedTool(
  prepared: PreparedToolCall,
  options: ExecuteToolCallsOptions
): Promise<ExecutedToolCall> {
  const startedAt = Date.now();
  if (prepared.argumentError) {
    return parseExecution(
      prepared,
      JSON.stringify({ success: false, error: prepared.argumentError }),
      startedAt
    );
  }
  if (prepared.drift?.status === 'block') {
    const reason = prepared.drift.reason || 'Blocked by TaskContext drift guard';
    return parseExecution(
      prepared,
      options.harnessBlockedResult?.(prepared.drift) ??
        JSON.stringify({ success: false, error: reason }),
      startedAt,
      {
        behavior: 'deny',
        approved: false,
        source: 'drift_guard',
        reason,
      }
    );
  }

  const outcome = await options.toolExecutor(
    prepared.tc.function.name,
    prepared.args,
    options.abortSignal,
    { callId: prepared.tc.id, index: prepared.index }
  );
  return typeof outcome === 'string'
    ? parseExecution(prepared, outcome, startedAt)
    : parseExecution(prepared, outcome.result, startedAt, outcome.permissionDecision);
}

function parseExecution(
  prepared: PreparedToolCall,
  result: string,
  startedAt: number,
  permissionDecision?: ToolPermissionDecision
): ExecutedToolCall {
  const parsed = parseToolResult(result);
  const externalAssertion =
    parsed.externalAssertion &&
    externalAssertionMatchesInvocation({
      assertion: parsed.externalAssertion,
      name: prepared.tc.function.name,
      args: prepared.args,
      success: parsed.success,
    })
      ? parsed.externalAssertion
      : undefined;
  return {
    prepared,
    result,
    duration: Date.now() - startedAt,
    ...(permissionDecision ? { permissionDecision } : {}),
    ...parsed,
    externalAssertion,
  };
}

function parseToolResult(
  result: string
): Omit<ExecutedToolCall, 'prepared' | 'result' | 'duration' | 'permissionDecision'> {
  try {
    const parsed = JSON.parse(result) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      typeof (parsed as Record<string, unknown>).success !== 'boolean'
    ) {
      throw new Error('Tool result is not a structured result envelope.');
    }
    const envelope = parsed as Record<string, unknown>;
    const success = envelope.success === true;
    return {
      success,
      error: typeof envelope.error === 'string' ? envelope.error : undefined,
      summary: typeof envelope.summary === 'string' ? envelope.summary : undefined,
      outputBytes: typeof envelope.outputBytes === 'number' ? envelope.outputBytes : undefined,
      artifactRef: isArtifactRef(envelope.artifactRef) ? envelope.artifactRef : undefined,
      externalAssertion: isToolExternalAssertion(envelope.externalAssertion)
        ? envelope.externalAssertion
        : undefined,
      resultTrust: 'structured',
      strategyResult: success ? 'success' : 'failed',
      strategyError: success
        ? undefined
        : typeof envelope.error === 'string'
          ? envelope.error
          : 'Unknown error',
    };
  } catch {
    return {
      success: true,
      summary: result,
      outputBytes: Buffer.byteLength(result, 'utf8'),
      resultTrust: 'opaque',
      strategyResult: 'failed',
      strategyError: 'Tool result was not a structured result envelope.',
    };
  }
}

function isArtifactRef(value: unknown): value is { id: string; outputBytes: number } {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.outputBytes === 'number';
}

function failedExecution(prepared: PreparedToolCall, error: unknown): ExecutedToolCall {
  const message = error instanceof Error ? error.message : String(error);
  return parseExecution(
    prepared,
    JSON.stringify({ success: false, error: `Tool execution error: ${message}` }),
    Date.now()
  );
}
