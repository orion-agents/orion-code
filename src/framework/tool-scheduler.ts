/**
 * orion code - Tool Scheduler
 *
 * Extracts tool grouping, permission checks, concurrent execution, and
 * ordered result emission from query.ts into a testable module.
 *
 * Input: tool calls from LLM + tool registry + permission context + abort signal
 * Output: execution results in original call order
 */

import {
  getToolMetadataPresence,
  type OrionCodeTool,
  type PermissionResult,
  type ToolContext,
} from './tool';
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
  tool: OrionCodeTool | undefined;
  attemptId: string;
  /** Provider arguments rejected before policy, drift, tracking, or execution. */
  argumentError?: string;
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
  /**
   * Whether the executor returned the structured tool-result contract.
   * Optional for source compatibility; missing legacy values are never trusted.
   */
  resultTrust?: 'structured' | 'opaque';
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
  | 'mode_auto'
  | 'mode_accept_edits'
  | 'allowlist_allow'
  | 'allowlist_deny'
  | 'allowlist_ask'
  | 'missing_risk_metadata'
  | 'risk_guard'
  | 'config_allow_blocked';

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
  tools: OrionCodeTool[];
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

/**
 * How a `behavior: 'ask'` permission should be resolved for the active permission mode.
 * - `allow`   : the mode itself grants approval (acceptEdits for file edits).
 * - `confirm` : fall through to toolConfirmation policy / interactive confirmation.
 */
export type AskResolution = 'allow' | 'confirm';

export type ToolRisk =
  | 'read_only'
  | 'file_edit'
  | 'state_write'
  | 'destructive'
  | 'external'
  | 'unknown';

interface ToolRiskAssessment {
  risk: ToolRisk;
  known: boolean;
  isFileEdit: boolean;
}

function assessToolRisk(
  tool: OrionCodeTool | undefined,
  args: Record<string, unknown>,
  permission: PermissionResult | undefined
): ToolRiskAssessment {
  const metadata = getToolMetadataPresence(tool);
  const known = metadata.hasReadOnly || metadata.hasDestructive || metadata.hasFileEdit;
  if (!tool || !known) return { risk: 'unknown', known: false, isFileEdit: false };

  const isReadOnly = metadata.hasReadOnly && tool.isReadOnly?.(args) === true;
  const isDestructive = metadata.hasDestructive && tool.isDestructive?.(args) === true;
  const isFileEdit = metadata.hasFileEdit && tool.isFileEdit?.(args) === true;

  if (isDestructive) return { risk: 'destructive', known: true, isFileEdit };
  // A read-only tool that asks is normally an external/caution operation
  // (web/MCP are the important examples), not a safe local read. A local
  // read-only exec_command (e.g. `gh auth status`, `git status`) stays a safe
  // read even though its policy asks when it is not explicitly allowlisted.
  if (isReadOnly && permission?.behavior === 'ask' && tool?.name !== 'exec_command') {
    return { risk: 'external', known: true, isFileEdit };
  }
  if (isReadOnly) return { risk: 'read_only', known: true, isFileEdit };
  if (isFileEdit) return { risk: 'file_edit', known: true, isFileEdit };
  return { risk: 'state_write', known: true, isFileEdit };
}

function checkToolPermission(
  tool: OrionCodeTool | undefined,
  args: Record<string, unknown>,
  context: ToolContext | undefined
): PermissionResult | undefined {
  const metadata = getToolMetadataPresence(tool);
  if (!metadata.hasPermissionCheck || !tool?.checkPermissions || !context) return undefined;
  try {
    return tool.checkPermissions(args, context);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { behavior: 'deny', reason: `Permission check failed closed: ${detail}` };
  }
}

function isSafeReadOnly(risk: ToolRiskAssessment): boolean {
  return risk.known && risk.risk === 'read_only';
}

/**
 * Resolve an `ask` permission against the permission mode.
 *
 * Historically this logic was inlined as `permissionMode === 'default'`, which meant
 * every non-default mode silently skipped confirmation without a complete safety
 * decision. Agent PLAN is a workflow mode, so the legacy permission value
 * `plan` follows the normal confirmation path. Auto delegates to the full
 * policy/risk gate below and never opens an interactive prompt.
 */
export function resolveAskPermission(
  permissionMode: string | undefined,
  tool: OrionCodeTool | undefined,
  args: Record<string, unknown>
): AskResolution {
  switch (permissionMode) {
    case 'auto':
      // Auto never opens an interactive permission prompt. The full gate below
      // still enforces hard tool-policy and explicit allowlist denies.
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
 * - `allow`   : approved without a prompt. `source` is set when the approval was
 *               an explicit escalation decision worth auditing.
 * - `confirm` : fall through to toolConfirmation / interactive confirmation.
 */
export interface EffectivePermission {
  outcome: 'deny' | 'allow' | 'confirm';
  source?: PermissionDecisionSource;
  reason?: string;
  risk?: ToolRisk;
}

/**
 * Resolve the tool policy, project allowlist and permission mode into one decision.
 *
 * Precedence (most restrictive first, see services/tool-allowlist for the contract):
 *   1. tool `checkPermissions() === 'deny'`  — never overridable by config
 *   2. allowlist `deny:` rule                — project can always tighten
 *   3. auto mode                             — fully authorized; no interactive permission prompt
 *   4. allowlist `ask:` rule                 — explicit escalation in collaborative modes
 *   5. acceptEdits                           — only explicit file edits auto-run
 *   6. allowlist `allow:` rule               — explicit durable user approval
 *   7. safe read-only tools                  — auto-run in every collaborative mode
 *   8. otherwise confirm (fail closed)
 *
 * Agent PLAN is intentionally absent from this precedence list. It changes the
 * workflow prompt and lifecycle, not the available tool registry or permission
 * envelope; the legacy permission string `plan` therefore behaves like default.
 */
export function resolveEffectivePermission(input: {
  toolName: string;
  tool?: OrionCodeTool;
  args: Record<string, unknown>;
  permission?: PermissionResult;
  permissionMode?: string;
  allowlist?: ToolAllowlistMatch;
  toolConfirmation?: string;
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
      reason: `Tool ${toolName} is denied by ${allowlist.scope ?? 'configured'} allowedTools rule "${allowlist.rule}"`,
    };
  }

  const risk = assessToolRisk(tool, args, permission);
  const riskReason =
    risk.risk === 'unknown'
      ? `Tool ${toolName} is missing risk metadata; automatic approval is not allowed.`
      : `Tool ${toolName} is ${risk.risk.replace('_', ' ')} and requires explicit confirmation.`;

  const reason =
    permission?.behavior === 'ask'
      ? permission.reason
      : allowlist?.effect === 'ask'
        ? `Confirmation required by ${allowlist.scope ?? 'configured'} allowedTools rule "${allowlist.rule}"`
        : riskReason;

  if (permissionMode === 'auto') {
    return {
      outcome: 'allow',
      source: 'mode_auto',
      reason: 'Auto mode fully authorized this invocation after hard policy checks.',
      risk: risk.risk,
    };
  }

  if (allowlist?.effect === 'ask') {
    return { outcome: 'confirm', source: 'allowlist_ask', reason, risk: risk.risk };
  }

  // A tool's explicit policy may approve a bounded internal state transition.
  // This is distinct from `toolConfirmation=allow`: the global fallback still
  // should not auto-approve external/unknown tools, and non-file destructive
  // calls continue to require an explicit confirmation path.
  if (
    permission?.behavior === 'allow' &&
    risk.known &&
    risk.risk !== 'external' &&
    !(risk.risk === 'destructive' && !risk.isFileEdit)
  ) {
    return {
      outcome: 'allow',
      source: 'tool_policy',
      reason: permission.reason,
      risk: risk.risk,
    };
  }

  if (allowlist?.effect === 'allow') {
    return {
      outcome: 'allow',
      source: 'allowlist_allow',
      reason: `Auto-approved by ${allowlist.scope ?? 'configured'} allowedTools rule "${allowlist.rule}"`,
      risk: risk.risk,
    };
  }

  if (permissionMode === 'acceptEdits' && risk.isFileEdit && risk.risk !== 'external') {
    return {
      outcome: 'allow',
      source: 'mode_accept_edits',
      reason,
      risk: risk.risk,
    };
  }

  if (isSafeReadOnly(risk)) return { outcome: 'allow', risk: risk.risk };

  return {
    outcome: 'confirm',
    source: risk.known ? 'risk_guard' : 'missing_risk_metadata',
    reason,
    risk: risk.risk,
  };
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
    const parsedArgs = parseToolArgs(tc);
    if ('error' in parsedArgs) {
      preparedCalls.push({
        index: i,
        tc,
        args: {},
        tool: tools.find(tool => tool.name === tc.function.name),
        attemptId: `invalid-tool-${i}`,
        argumentError: parsedArgs.error,
        drift: undefined,
        permission: undefined,
        canRunConcurrently: false,
      });
      continue;
    }
    const { args } = parsedArgs;
    // Re-serialize to ensure valid JSON for next API call
    tc.function.arguments = JSON.stringify(args);

    const tool = tools.find(t => t.name === tc.function.name);
    const inputError = tool?.validateInput?.(args);
    if (inputError) {
      preparedCalls.push({
        index: i,
        tc,
        args,
        tool,
        attemptId: `invalid-tool-${i}`,
        argumentError: inputError,
        drift: undefined,
        permission: undefined,
        canRunConcurrently: false,
      });
      continue;
    }

    const attemptId = options.startApproach?.(tc.function.name) ?? `tool-${i}`;
    options.addToolToTracker?.(attemptId, tc.function.name);
    const drift = options.harnessDriftCheck?.({ name: tc.function.name, args });
    const permission = checkToolPermission(tool, args, options.toolContext);
    const allowlist = options.toolAllowlist?.(tc.function.name, args);
    const effective = resolveEffectivePermission({
      toolName: tc.function.name,
      tool,
      args,
      permission,
      permissionMode: options.permissionMode,
      allowlist,
      toolConfirmation: options.toolConfirmation,
    });
    const confirmation = options.toolConfirmation ?? 'ask';
    const needsInteractiveConfirmation =
      effective.outcome === 'confirm' && confirmation !== 'deny' && Boolean(options.confirmToolUse);
    const canRunConcurrently =
      effective.outcome !== 'deny' &&
      drift?.status !== 'block' &&
      tool?.isConcurrencySafe?.(args) === true &&
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
  | 'resultTrust'
  | 'strategyResult'
  | 'strategyError'
> {
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
    const outputBytes = typeof envelope.outputBytes === 'number' ? envelope.outputBytes : undefined;
    const artifactRef = isArtifactRef(envelope.artifactRef) ? envelope.artifactRef : undefined;
    return {
      success,
      error: typeof envelope.error === 'string' ? envelope.error : undefined,
      summary: typeof envelope.summary === 'string' ? envelope.summary : undefined,
      outputBytes,
      artifactRef,
      externalAssertion: isToolExternalAssertion(envelope.externalAssertion)
        ? envelope.externalAssertion
        : undefined,
      resultTrust: 'structured',
      strategyResult: success ? ('success' as const) : ('failed' as const),
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
      strategyResult: 'failed' as const,
      strategyError: 'Tool result was not a structured result envelope.',
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
    resultTrust: 'structured',
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
  toolAllowlist?: ToolAllowlistEvaluator,
  harnessBlockedResult?: ToolSchedulerOptions['harnessBlockedResult']
): Promise<ExecutedToolCall> {
  const start = Date.now();
  const { tc, args, tool, drift, permission, allowlist } = prepared;
  let permissionDecision: ToolPermissionDecision | undefined;

  const exec = async (): Promise<string> => {
    try {
      return await toolExecutor(tc.function.name, args, abortSignal);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return JSON.stringify({
        success: false,
        error: `Tool execution error: ${message}`,
      });
    }
  };

  const run = async (): Promise<string> => {
    if (prepared.argumentError) {
      return JSON.stringify({ success: false, error: prepared.argumentError });
    }
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
    // Re-evaluate at execution time. A user may approve the first serial call
    // for the whole project while later calls from the same model response are
    // already prepared; those calls must observe the newly persisted grant.
    const currentAllowlist = toolAllowlist ? toolAllowlist(tc.function.name, args) : allowlist;
    prepared.allowlist = currentAllowlist;
    const effective = resolveEffectivePermission({
      toolName: tc.function.name,
      tool,
      args,
      permission,
      permissionMode,
      allowlist: currentAllowlist,
      toolConfirmation,
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
    const requestInteractiveConfirmation = async (): Promise<string> => {
      if (!confirmToolUse) {
        return JSON.stringify({
          success: false,
          error: `Tool ${tc.function.name} requires user confirmation.`,
        });
      }
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
    };
    if (confirmation === 'allow') {
      const risk = assessToolRisk(tool, args, permission);
      const allowWithConfirmationBypass = risk.isFileEdit;
      if (effective.source === 'allowlist_ask' || !allowWithConfirmationBypass) {
        // `allow` may auto-approve only the bounded file-edit envelope. For
        // higher-risk tools, use the available UI to collect the explicit
        // decision promised by the error contract; headless callers remain
        // fail-closed below.
        if (confirmToolUse) return requestInteractiveConfirmation();
        permissionDecision = {
          behavior: 'ask',
          approved: false,
          source:
            effective.source === 'missing_risk_metadata'
              ? 'missing_risk_metadata'
              : 'config_allow_blocked',
          reason: effective.reason,
        };
      } else {
        permissionDecision = {
          behavior: 'ask',
          approved: true,
          source: 'config_allow',
          reason: effective.reason,
        };
        return exec();
      }
      return JSON.stringify({
        success: false,
        error:
          effective.source === 'missing_risk_metadata'
            ? `Tool ${tc.function.name} is missing risk metadata; toolConfirmation=allow cannot approve it.`
            : `toolConfirmation=allow cannot approve ${tc.function.name}; explicit confirmation is required for ${risk.risk.replace('_', ' ')} tools.`,
      });
    }
    if (confirmToolUse && confirmation === 'ask') {
      return requestInteractiveConfirmation();
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
    toolAllowlist?: ToolAllowlistEvaluator;
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
          options.toolAllowlist,
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
      options.toolAllowlist,
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
