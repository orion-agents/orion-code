/**
 * orion code - Query Loop (async generator)
 *
 * Generator-based query loop replacing the callback-based chatWithTools.
 * Yields typed events: request_start, tool_call, tool_result, message, complete.
 *
 * Note: Streaming text chunks are handled via onChunk callback in llm.chatStream(),
 * not yielded as events (callbacks cannot yield). The handleChat consumer writes
 * chunks directly to stdout via the callback.
 */

import type {
  LLMRequestDiagnostics,
  LLMService,
  Message,
  StreamCallbacks,
  Tool,
} from '../services/llm';
import { ProviderRequestPreflightError } from '../services/llm';
import type { ProviderErrorType } from '../services/provider-diagnostics';
import type { OrionCodeTool, ToolContext } from './tool';
import type { PermissionMode } from '../commands/types';
import type { CostTracker } from '../core/cost-tracker';
import type { ToolConfirmationPolicy } from '../services/config';
import type { ToolAllowlistEvaluator } from '../services/tool-allowlist';
import { toOpenAITools } from './tool';
import { createStrategyTracker, type StrategyTracker } from '../core/strategy-tracker';
import {
  AutoCompact,
  type AutoCompactAttempt,
  type CompactPauseFailure,
  type CompactPostValidation,
} from '../services/compact/auto-compact';
import type { CompactResult } from '../services/compact/compact';
import { canonicalMessagesFingerprint } from '../services/compact/fingerprint';
import { pendingToolCalls } from '../services/compact/tool-call-groups';
import type { CompactCoordinator } from '../services/compact/coordinator';
import type { CompactPrepareSourceReceipt } from '../services/session-storage';
import type { ContextHarness, HarnessState } from '../harness';
import type { PromptAssemblyStats } from '../harness/types';
import {
  prepareToolCalls,
  executeToolCalls,
  type AuthoritativeToolExecutor,
  type ExecutedToolCall,
  type ToolPermissionDecision,
} from './tool-call-orchestrator';
import { estimateMessagesTokens } from '../utils/token-estimate';
import { parseToolResultEnvelope, serializeToolResult } from './tool-serializer';
import {
  createContextUsageSnapshot,
  getModelContextWindow,
  type ContextUsageSnapshot,
} from '../services/model-context';
import type { ToolExternalAssertion } from './external-assertion';
import { createStopDecision, type StopDecision, type StopDecisionStatus } from './stop-decision';
import {
  DEFAULT_LOOP_BUDGET,
  type LoopBudget,
  type LoopBudgetBaseProfile,
  type LoopBudgetSource,
} from './loop-budget-contract';

export { DEFAULT_LOOP_BUDGET } from './loop-budget-contract';
export type { LoopBudget, LoopBudgetBaseProfile, LoopBudgetSource } from './loop-budget-contract';

export const DEFAULT_MAX_MODEL_VISIBLE_TOOL_RESULT_BYTES = 4096;

/** Read-only tools eligible for the fragmentation hint; kept loop-local so Query has no tool registry. */
const BATCH_READ_ALLOWED_TOOLS = new Set(['git_status', 'list_files', 'glob', 'grep', 'read_file']);

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function cancelledCompleteEvent(
  llm: LLMService,
  stats: LoopStats
): Extract<QueryEvent, { type: 'complete' }> {
  return {
    type: 'complete',
    content: 'Operation cancelled.',
    model: llm.getModel(),
    stats: cloneLoopStats(stats, 'cancelled'),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecord(raw: unknown): Record<string, unknown> | undefined {
  if (isRecord(raw)) return raw;
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

interface BatchReadEvidenceStep {
  tool: string;
  args: Record<string, unknown>;
  success: boolean;
  summary?: string;
  error?: string;
  output: string;
}

function parseBatchReadEvidenceSteps(result: string): BatchReadEvidenceStep[] {
  const envelope = parseRecord(result);
  const inner = parseRecord(envelope?.output);
  const steps = inner?.steps;
  if (!Array.isArray(steps)) return [];

  return steps.flatMap(step => {
    if (!isRecord(step) || typeof step.tool !== 'string') return [];
    const args = isRecord(step.args) ? step.args : {};
    const output =
      typeof step.output === 'string' ? step.output : JSON.stringify(step.output ?? '');
    return [
      {
        tool: step.tool,
        args,
        success: step.success === true,
        summary: typeof step.summary === 'string' ? step.summary : undefined,
        error: typeof step.error === 'string' ? step.error : undefined,
        output,
      },
    ];
  });
}

export type LoopFinishReason =
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'blocked'
  | 'completion_gate'
  | 'budget_exceeded'
  | 'compact_paused'
  | 'running';

export type LoopContinuationAction =
  | 'reply_continue'
  | 'narrow_instruction'
  | 'inspect_loop_stats'
  | 'raise_budget';

const COMPLEX_LOOP_BUDGET: Pick<
  LoopBudget,
  'maxLlmRequestsPerUserTurn' | 'maxToolCallsPerUserTurn' | 'maxModelVisibleToolBytes'
> = {
  maxLlmRequestsPerUserTurn: 48,
  maxToolCallsPerUserTurn: 180,
  maxModelVisibleToolBytes: 96 * 1024,
};

export interface LoopStats {
  turnsStarted: number;
  llmRequests: number;
  toolCalls: number;
  readOnlyToolCalls: number;
  unsafeToolCalls: number;
  toolResultBytes: number;
  modelVisibleToolBytes: number;
  summarizedBytes: number;
  compactTrigger?: 'pre_turn' | 'post_turn';
  finishReason: LoopFinishReason;
  /** Typed boundary result. A request stop never implies that its parent task completed. */
  stopDecision?: StopDecision;
  /** Structured compact failure when the request pauses to protect context integrity. */
  compactFailure?: CompactPauseFailure;
  budgetExceededReason?: string;
  loopBudgetSource?: LoopBudgetSource;
  loopBudgetBaseProfile?: LoopBudgetBaseProfile;
  loopBudgetMaxLlmRequests?: number;
  loopBudgetMaxToolCalls?: number;
  loopBudgetMaxReadOnlyFragmentation?: number;
  loopBudgetMaxModelVisibleBytes?: number;
  loopBudgetConfigOverride?: boolean;
  providerRetryCount?: number;
  providerRetryDelayMs?: number;
  providerRetryErrorTypes?: ProviderErrorType[];
  providerLastRetryErrorType?: ProviderErrorType;
  providerLastRetryStatus?: number;
  providerFallbackCount?: number;
  providerFallbackFromModel?: string;
  providerFallbackToModel?: string;
  providerFinalModel?: string;
  providerUsingFallback?: boolean;
  subagentPromptTokens?: number;
  subagentCompletionTokens?: number;
  subagentTotalTokens?: number;
  /** False when observed usage is only a lower bound (for example, a failed child request). */
  usageAccountingComplete?: boolean;
  continuationActions?: LoopContinuationAction[];
  continuationHint?: string;
  /** Last tool boundary reached before the turn stopped. */
  lastToolName?: string;
  lastToolSummary?: string;
  lastToolSuccess?: boolean;
  verificationProfile?: string;
  verificationRequired?: boolean;
  verificationClaimAllowed?: boolean;
  verificationPassedCommands?: string[];
  verificationFailedCommands?: string[];
  verificationMissingCommands?: string[];
  verificationSkippedReason?: string;
  singleReadOnlyStreak: number;
  batchReadSuggestionCount: number;
  localFastPathUsed: boolean;
}

export class QueryLoopError extends Error {
  readonly originalError: unknown;
  readonly stats: LoopStats;
  readonly aggregateUsage?: { promptTokens: number; completionTokens: number };

  constructor(
    error: unknown,
    stats: LoopStats,
    aggregateUsage?: { promptTokens: number; completionTokens: number }
  ) {
    super(error instanceof Error ? error.message : String(error));
    this.name = 'QueryLoopError';
    this.originalError = error;
    this.stats = stats;
    this.aggregateUsage = aggregateUsage ? { ...aggregateUsage } : undefined;
  }
}

function createLoopStats(): LoopStats {
  return {
    turnsStarted: 0,
    llmRequests: 0,
    toolCalls: 0,
    readOnlyToolCalls: 0,
    unsafeToolCalls: 0,
    toolResultBytes: 0,
    modelVisibleToolBytes: 0,
    summarizedBytes: 0,
    finishReason: 'running',
    providerRetryCount: 0,
    providerRetryDelayMs: 0,
    providerRetryErrorTypes: [],
    providerFallbackCount: 0,
    providerUsingFallback: false,
    singleReadOnlyStreak: 0,
    batchReadSuggestionCount: 0,
    localFastPathUsed: false,
  };
}

function stopDecisionForLoop(stats: LoopStats, finishReason: LoopFinishReason): StopDecision {
  if (finishReason === 'compact_paused' && stats.compactFailure) {
    const failure = stats.compactFailure;
    return createStopDecision({
      scope: 'request',
      status: 'stopped',
      disposition: 'pause_scope',
      reason: { code: failure.code, message: failure.message },
      evidence: [
        {
          kind: 'resource_limit',
          source: `compact:${failure.mode}`,
          detail: `${failure.beforeTokens} tokens before compact; ${failure.afterTokens ?? 'unknown'} after; target ${failure.targetTokens}.`,
        },
      ],
      nextActions: [
        { kind: 'inspect', label: 'Inspect current context pressure', command: '/context' },
        { kind: 'change_input', label: 'Narrow or split the current instruction' },
        { kind: 'raise_budget', label: 'Select a larger-context model or raise the budget' },
        { kind: 'resume', label: 'Resume after changing context or budget', command: '继续' },
      ],
      resources: {
        tokens: {
          used: Math.max(0, Math.round(failure.afterTokens ?? failure.beforeTokens)),
          limit: Math.max(0, Math.round(failure.targetTokens)),
        },
      },
    });
  }
  const status: StopDecisionStatus =
    finishReason === 'completed'
      ? 'completed'
      : finishReason === 'cancelled'
        ? 'cancelled'
        : finishReason === 'failed'
          ? 'failed'
          : finishReason === 'blocked'
            ? 'blocked'
            : 'stopped';
  const reasonCode =
    finishReason === 'budget_exceeded'
      ? /LLM request budget/iu.test(stats.budgetExceededReason ?? '')
        ? 'llm_request_budget'
        : /tool call budget/iu.test(stats.budgetExceededReason ?? '')
          ? 'tool_call_budget'
          : /preflight|provider/iu.test(stats.budgetExceededReason ?? '')
            ? 'provider_preflight_budget'
            : 'resource_budget'
      : finishReason;
  const resumable =
    finishReason === 'budget_exceeded' ||
    finishReason === 'completion_gate' ||
    finishReason === 'blocked';
  const evidence = [] as StopDecision['evidence'];
  if (finishReason === 'budget_exceeded') {
    evidence.push({
      kind: 'resource_limit',
      source: 'query',
      detail: stats.budgetExceededReason ?? 'request resource budget reached',
    });
  }
  if (stats.lastToolName) {
    evidence.push({
      kind: 'tool_boundary',
      source: stats.lastToolName,
      detail: stats.lastToolSummary ?? `last tool success=${String(stats.lastToolSuccess)}`,
    });
  }

  const nextActions: StopDecision['nextActions'] = [];
  for (const action of stats.continuationActions ?? []) {
    if (action === 'reply_continue') {
      nextActions.push({ kind: 'continue', label: 'Continue the same objective', command: '继续' });
    } else if (action === 'raise_budget') {
      nextActions.push({ kind: 'raise_budget', label: 'Raise the intentional loop budget' });
    } else if (action === 'inspect_loop_stats') {
      nextActions.push({
        kind: 'inspect',
        label: 'Inspect loop statistics',
        command: '/usage',
      });
    } else {
      nextActions.push({ kind: 'change_input', label: 'Provide a narrower instruction' });
    }
  }

  return createStopDecision({
    scope: 'request',
    status,
    disposition: resumable ? 'resume_allowed' : 'finish_scope',
    reason: {
      code: reasonCode,
      message:
        finishReason === 'budget_exceeded'
          ? (stats.budgetExceededReason ?? 'Request resource budget reached')
          : `Request finished with ${finishReason}`,
    },
    evidence,
    nextActions,
    resources: {
      turns: { used: stats.turnsStarted },
      llmRequests: {
        used: stats.llmRequests,
        ...(stats.loopBudgetMaxLlmRequests === undefined
          ? {}
          : { limit: stats.loopBudgetMaxLlmRequests }),
      },
      toolCalls: {
        used: stats.toolCalls,
        ...(stats.loopBudgetMaxToolCalls === undefined
          ? {}
          : { limit: stats.loopBudgetMaxToolCalls }),
      },
      modelVisibleToolBytes: {
        used: stats.modelVisibleToolBytes,
        ...(stats.loopBudgetMaxModelVisibleBytes === undefined
          ? {}
          : { limit: stats.loopBudgetMaxModelVisibleBytes }),
      },
    },
  });
}

/** Rebuild terminal loop stats and its StopDecision as one atomic projection. */
export function withLoopFinishReason(stats: LoopStats, finishReason: LoopFinishReason): LoopStats {
  const resolvedReason = finishReason;
  const cloned: LoopStats = {
    ...stats,
    finishReason: resolvedReason,
  };
  if (resolvedReason !== 'running')
    cloned.stopDecision = stopDecisionForLoop(cloned, resolvedReason);
  else delete cloned.stopDecision;
  return cloned;
}

function cloneLoopStats(stats: LoopStats, finishReason?: LoopFinishReason): LoopStats {
  return withLoopFinishReason(stats, finishReason ?? stats.finishReason);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function createLocalFastPathLoopStats(overrides: Partial<LoopStats> = {}): LoopStats {
  return cloneLoopStats({
    ...createLoopStats(),
    turnsStarted: 1,
    finishReason: 'completed',
    localFastPathUsed: true,
    ...overrides,
  });
}

export function createFailedLoopStats(
  options: Partial<LoopStats> & {
    loopBudget?: Partial<LoopBudget>;
    diagnostics?: LLMRequestDiagnostics;
  } = {}
): LoopStats {
  const { loopBudget, diagnostics, ...overrides } = options;
  const stats: LoopStats = {
    ...createLoopStats(),
    turnsStarted: 1,
    llmRequests: 1,
    finishReason: 'failed',
    ...overrides,
  };
  applyLoopBudgetStats(stats, resolveLoopBudget(loopBudget));
  applyLlmRequestDiagnostics(stats, diagnostics);
  return cloneLoopStats(stats);
}

function isLoopBudgetSource(value: unknown): value is LoopBudgetSource {
  return value === 'default' || value === 'complex' || value === 'release' || value === 'config';
}

function isLoopBudgetBaseProfile(value: unknown): value is LoopBudgetBaseProfile {
  return value === 'default' || value === 'complex' || value === 'release';
}

function resolveLoopBudget(partial?: Partial<LoopBudget>): LoopBudget {
  const numericOverrides = Object.fromEntries(
    Object.entries(partial ?? {}).filter(
      ([, value]) => typeof value === 'number' && Number.isFinite(value) && value > 0
    )
  );
  const hasNumericOverrides = Object.keys(numericOverrides).length > 0;
  const hasExplicitProfile = partial?.profile !== undefined || partial?.baseProfile !== undefined;
  const inferredConfigOverride = hasNumericOverrides && !hasExplicitProfile;
  const configOverride = partial?.configOverride === true || inferredConfigOverride;

  return {
    ...DEFAULT_LOOP_BUDGET,
    ...numericOverrides,
    profile: isLoopBudgetSource(partial?.profile)
      ? partial.profile
      : configOverride
        ? 'config'
        : DEFAULT_LOOP_BUDGET.profile,
    baseProfile: isLoopBudgetBaseProfile(partial?.baseProfile)
      ? partial.baseProfile
      : DEFAULT_LOOP_BUDGET.baseProfile,
    configOverride,
  };
}

function applyLoopBudgetStats(stats: LoopStats, budget: LoopBudget): void {
  stats.loopBudgetSource = budget.profile ?? 'default';
  stats.loopBudgetBaseProfile =
    budget.baseProfile ?? (budget.profile === 'config' ? 'default' : (budget.profile ?? 'default'));
  stats.loopBudgetMaxLlmRequests = budget.maxLlmRequestsPerUserTurn;
  stats.loopBudgetMaxToolCalls = budget.maxToolCallsPerUserTurn;
  stats.loopBudgetMaxReadOnlyFragmentation = budget.maxReadOnlyFragmentation;
  stats.loopBudgetMaxModelVisibleBytes = budget.maxModelVisibleToolBytes;
  stats.loopBudgetConfigOverride = budget.configOverride === true;
}

function shouldPromoteDefaultBudget(stats: LoopStats, budget: LoopBudget): boolean {
  if (budget.configOverride === true || budget.profile !== 'default') return false;
  if (stats.llmRequests < budget.maxLlmRequestsPerUserTurn) return false;

  return (
    stats.toolCalls >= 8 || stats.readOnlyToolCalls >= 6 || stats.modelVisibleToolBytes >= 16 * 1024
  );
}

function promoteDefaultBudgetToComplex(budget: LoopBudget): LoopBudget {
  return {
    ...budget,
    maxLlmRequestsPerUserTurn: Math.max(
      budget.maxLlmRequestsPerUserTurn,
      COMPLEX_LOOP_BUDGET.maxLlmRequestsPerUserTurn
    ),
    maxToolCallsPerUserTurn: Math.max(
      budget.maxToolCallsPerUserTurn,
      COMPLEX_LOOP_BUDGET.maxToolCallsPerUserTurn
    ),
    maxModelVisibleToolBytes: Math.max(
      budget.maxModelVisibleToolBytes,
      COMPLEX_LOOP_BUDGET.maxModelVisibleToolBytes
    ),
    profile: 'complex',
    baseProfile: 'complex',
    configOverride: false,
  };
}

function getLlmRequestDiagnostics(llm: LLMService): LLMRequestDiagnostics | undefined {
  const diagnosticsReader = (
    llm as unknown as {
      getLastRequestDiagnostics?: () => LLMRequestDiagnostics;
    }
  ).getLastRequestDiagnostics;
  return typeof diagnosticsReader === 'function' ? diagnosticsReader.call(llm) : undefined;
}

function applyLlmRequestDiagnostics(
  stats: LoopStats,
  diagnostics: LLMRequestDiagnostics | undefined
): void {
  if (!diagnostics) return;
  const existingTypes = stats.providerRetryErrorTypes ?? [];
  const retryTypes = diagnostics.retryErrorTypes.filter(
    (type, index, values) => !existingTypes.includes(type) && values.indexOf(type) === index
  );

  stats.providerRetryCount = (stats.providerRetryCount ?? 0) + diagnostics.retryCount;
  stats.providerRetryDelayMs = (stats.providerRetryDelayMs ?? 0) + diagnostics.retryDelayMs;
  stats.providerRetryErrorTypes = [...existingTypes, ...retryTypes];
  stats.providerLastRetryErrorType =
    diagnostics.lastRetryErrorType ?? stats.providerLastRetryErrorType;
  stats.providerLastRetryStatus = diagnostics.lastRetryStatus ?? stats.providerLastRetryStatus;
  stats.providerFinalModel = diagnostics.finalModel;
  stats.providerUsingFallback = diagnostics.usingFallback;
  if (diagnostics.fallbackTriggered) {
    stats.providerFallbackCount = (stats.providerFallbackCount ?? 0) + 1;
    stats.providerFallbackFromModel = diagnostics.fallbackFromModel;
    stats.providerFallbackToModel = diagnostics.fallbackToModel;
  }
}

function budgetExceededEvent(
  llm: LLMService,
  stats: LoopStats,
  reason: string
): Extract<QueryEvent, { type: 'complete' }> {
  const continuationActions: LoopContinuationAction[] = [
    'reply_continue',
    'narrow_instruction',
    'inspect_loop_stats',
    'raise_budget',
  ];
  const continuationHint =
    'Reply `继续` to continue the same objective, give a narrower next step, inspect /usage, or raise agentLoop.budget for intentional long work.';
  return {
    type: 'complete',
    content: [
      `Agent loop budget reached: ${reason}.`,
      'I stopped this turn to avoid unnecessary model requests and preserved the current session state.',
      'To continue the same objective, reply `继续` or provide the next concrete step.',
      'Use /usage to inspect request/tool counts. For intentional long work, raise agentLoop.budget in orion.json.',
    ].join('\n'),
    model: llm.getModel(),
    stats: cloneLoopStats(
      {
        ...stats,
        budgetExceededReason: reason,
        continuationActions,
        continuationHint,
      },
      'budget_exceeded'
    ),
  };
}

function permissionBlockedEvent(
  llm: LLMService,
  stats: LoopStats,
  toolName: string,
  error?: string,
  source?: string
): Extract<QueryEvent, { type: 'complete' }> {
  const detail = error ? ` ${error}` : '';
  const sourceText = source ? ` (${source})` : '';
  return {
    type: 'complete',
    content:
      `Tool ${toolName} was not executed because permission was denied${sourceText}.${detail}`.trim(),
    model: llm.getModel(),
    stats: cloneLoopStats(stats, 'blocked'),
  };
}

function compactPromptEvidence(
  items: PromptAssemblyStats['includedEvidence'],
  maxItems = 12
): string[] {
  return items
    .slice(0, maxItems)
    .map(item => `${item.id}:${item.kind}:score=${item.score}:tokens=${item.tokens}`);
}

function takeUtf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let result = '';
  let bytes = 0;
  for (const char of text) {
    const nextBytes = byteLength(char);
    if (bytes + nextBytes > maxBytes) break;
    result += char;
    bytes += nextBytes;
  }
  return result;
}

function takeUtf8Suffix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let result = '';
  let bytes = 0;
  const chars = Array.from(text);
  for (let index = chars.length - 1; index >= 0; index--) {
    const char = chars[index];
    const nextBytes = byteLength(char);
    if (bytes + nextBytes > maxBytes) break;
    result = char + result;
    bytes += nextBytes;
  }
  return result;
}

function truncateForModel(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const marker = '\n...[truncated]';
  if (maxBytes <= 128) {
    return `${takeUtf8Prefix(text, Math.max(0, maxBytes - byteLength(marker)))}${marker}`;
  }

  const middle = `\n...[truncated ${byteLength(text)}B output for model context]...\n`;
  const contentBudget = Math.max(0, maxBytes - byteLength(middle));
  const headBytes = Math.floor(contentBudget * 0.65);
  const tailBytes = contentBudget - headBytes;
  return [takeUtf8Prefix(text, headBytes), middle, takeUtf8Suffix(text, tailBytes)].join('');
}

function summarizeModelVisibleToolResult(
  executed: ExecutedToolCall,
  maxBytes: number
): { result: string; bytes: number; summarizedBytes: number } {
  const rawBytes = byteLength(executed.result);
  const fullOutputBytes = executed.outputBytes ?? rawBytes;
  if (rawBytes <= maxBytes && !executed.artifactRef) {
    return { result: executed.result, bytes: rawBytes, summarizedBytes: 0 };
  }

  const envelope = parseToolResultEnvelope(executed.result);
  const output = typeof envelope.output === 'string' ? envelope.output : executed.result;
  const summary = executed.summary || envelope.summary;
  const compactSummary = summary ? truncateForModel(summary, 192) : undefined;
  const rawError = executed.error ?? envelope.error;
  const compactError = rawError ? truncateForModel(rawError, 192) : undefined;
  const artifactText = executed.artifactRef
    ? ` Full output is available as artifact ${executed.artifactRef.id} (${executed.artifactRef.outputBytes}B).`
    : '';

  const serializeCompact = (compactOutput: string): string =>
    serializeToolResult({
      success: executed.success,
      output: compactOutput,
      error: compactError,
      summary: compactSummary,
      outputBytes: fullOutputBytes,
      artifactRef: executed.artifactRef ?? envelope.artifactRef,
      metadata: {
        ...(envelope.metadata ?? {}),
        modelVisibleCompressed: true,
        originalResultBytes: rawBytes,
      },
    });

  let outputBudget = Math.max(128, maxBytes - 768);
  let compact = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    compact = serializeCompact(
      [
        compactSummary
          ? `Summary: ${compactSummary}`
          : 'Tool output was summarized for model context.',
        artifactText.trim(),
        truncateForModel(output, outputBudget),
      ]
        .filter(Boolean)
        .join('\n')
    );

    const compactBytes = byteLength(compact);
    if (compactBytes <= maxBytes || outputBudget <= 128) break;
    outputBudget = Math.max(128, outputBudget - Math.max(compactBytes - maxBytes, 128));
  }

  if (byteLength(compact) > maxBytes) {
    compact = serializeCompact(
      [
        compactSummary
          ? `Summary: ${compactSummary}`
          : 'Tool output was summarized for model context.',
        artifactText.trim(),
        `Output body omitted from model context (${fullOutputBytes}B total).`,
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  if (byteLength(compact) > maxBytes) {
    compact = serializeToolResult({
      success: executed.success,
      output: `Tool result omitted from model context (${fullOutputBytes}B total).`,
      outputBytes: fullOutputBytes,
      metadata: {
        modelVisibleCompressed: true,
        originalResultBytes: rawBytes,
      },
    });
  }

  const bytes = byteLength(compact);
  return {
    result: compact,
    bytes,
    summarizedBytes: Math.max(0, fullOutputBytes - bytes),
  };
}

function omitModelVisibleToolResult(
  executed: ExecutedToolCall,
  maxAggregateBytes: number
): { result: string; bytes: number; summarizedBytes: number } {
  const fullBytes = executed.outputBytes ?? byteLength(executed.result);
  const compact = serializeToolResult({
    success: executed.success,
    output: `Tool result omitted from model context because the per-turn model-visible tool budget (${maxAggregateBytes}B) was reached.`,
    outputBytes: fullBytes,
    artifactRef: executed.artifactRef,
    metadata: {
      modelVisibleCompressed: true,
      modelVisibleBudgetExceeded: true,
    },
  });
  const bytes = byteLength(compact);
  return {
    result: compact,
    bytes,
    summarizedBytes: Math.max(0, fullBytes - bytes),
  };
}

// ============================================================================
// 事件类型
// ============================================================================

export type QueryEvent =
  | { type: 'request_start'; model: string; turn: number }
  | {
      type: 'prompt_assembly';
      modelId: string;
      estimatedTokens: number;
      budgetTokens: number;
      coreTokens: number;
      evidenceBudgetTokens: number;
      recentTurnBudgetTokens: number;
      sections: string[];
      includedEvidence: string[];
      omittedEvidence: string[];
      includedEvidenceCount: number;
      omittedEvidenceCount: number;
      /** Additive v0.1.9 manifest; absent on legacy externally-constructed events. */
      sectionManifest?: NonNullable<PromptAssemblyStats['sectionManifest']>;
      /** Additive v0.1.9 budget signal; absent means the legacy unknown state. */
      overBudget?: boolean;
      capabilityProfileVersion?: number;
      capabilityProfileFingerprint?: string;
    }
  | { type: 'assistant_tool_calls'; content: string; toolCalls: NonNullable<Message['tool_calls']> }
  | {
      type: 'tool_call';
      name: string;
      args: Record<string, unknown>;
      callId: string;
      batchCount?: number;
      batchIndex?: number;
    }
  | {
      type: 'permission_decision';
      name: string;
      args: Record<string, unknown>;
      callId: string;
      decision: ToolPermissionDecision;
      batchCount?: number;
      batchIndex?: number;
    }
  | {
      type: 'tool_result';
      name: string;
      args: Record<string, unknown>;
      callId: string;
      result: string;
      modelVisibleResult: string;
      duration: number;
      success: boolean;
      artifactRef?: { id: string; outputBytes: number };
      externalAssertion?: ToolExternalAssertion;
      error?: string;
      summary?: string;
      outputBytes?: number;
      batchCount?: number;
      batchIndex?: number;
    }
  | { type: 'strategy_exhausted'; suggestion: string }
  | { type: 'message'; role: 'assistant'; content: string }
  | { type: 'warning'; message: string }
  | {
      type: 'complete';
      content: string;
      usage?: { promptTokens: number; completionTokens: number };
      model: string;
      stats?: LoopStats;
      compact?: QueryCompactCommit;
    };

export interface QueryCompactCommit extends Pick<
  CompactResult,
  'fingerprint' | 'beforeTokens' | 'afterTokens' | 'plan' | 'semanticSummary' | 'diagnostics'
> {
  mode: 'predictive' | 'threshold';
  /**
   * Append-only history for the enclosing regular TurnCommit. The compacted
   * modelHistory is only authoritative after CompactTransaction advances its pointer.
   */
  uncompactedHistory: Message[];
  modelHistory: Message[];
  summary: {
    text: string;
    generatedAt: number;
    source: 'llm' | 'heuristic';
  };
  before: ContextUsageSnapshot;
  after: ContextUsageSnapshot;
  prepareSource?: CompactPrepareSourceReceipt;
  /** Harness authority used when the semantic candidate was prepared. */
  semanticHarnessState?: HarnessState;
}

function queryCompactCommit(
  mode: QueryCompactCommit['mode'],
  result: CompactResult,
  before: ContextUsageSnapshot,
  after: ContextUsageSnapshot,
  uncompactedHistory: readonly Message[],
  prepareSource?: CompactPrepareSourceReceipt,
  semanticHarnessState?: HarnessState
): QueryCompactCommit {
  return {
    mode,
    uncompactedHistory: uncompactedHistory.map(message => ({ ...message })),
    modelHistory: result.messages.map(message => ({ ...message })),
    summary: {
      text: result.summary,
      generatedAt: result.summaryGeneratedAt,
      source: result.summarySource,
    },
    before,
    after,
    prepareSource,
    semanticHarnessState,
    fingerprint: result.fingerprint,
    beforeTokens: result.beforeTokens,
    afterTokens: result.afterTokens,
    plan: structuredClone(result.plan),
    semanticSummary: structuredClone(result.semanticSummary),
    diagnostics: result.diagnostics.map(diagnostic => ({ ...diagnostic })),
  };
}

function attachCompactCommit(
  event: Extract<QueryEvent, { type: 'complete' }>,
  compact: QueryCompactCommit | undefined,
  messages: Message[],
  usage?: { promptTokens: number; completionTokens: number }
): Extract<QueryEvent, { type: 'complete' }> {
  const eventWithUsage = usage ? { ...event, usage: { ...usage } } : event;
  return compact
    ? {
        ...eventWithUsage,
        compact: bindCompactCommitToHistory(compact, messages),
      }
    : eventWithUsage;
}

function bindCompactCommitToHistory(
  compact: QueryCompactCommit,
  messages: readonly Message[]
): QueryCompactCommit {
  const modelHistory = messages.map(message => ({ ...message }));
  return {
    ...compact,
    uncompactedHistory: compact.uncompactedHistory.map(message => ({ ...message })),
    modelHistory,
    afterTokens: estimateMessagesTokens(modelHistory),
  };
}

// ============================================================================
// 参数
// ============================================================================

export interface QueryParams {
  /** Conversation history (must include system prompt as first message) */
  messages: Message[];
  /** Available tools */
  tools: OrionCodeTool[];
  /** Tool executor: (name, args, abortSignal?) => result string
   *  Issue #32 #3.2: 支持 abortSignal 透传 */
  toolExecutor: AuthoritativeToolExecutor;
  /**
   * Resolve the exact tools and executor binding for each model request.
   * Existing callers may omit this and retain the turn-scoped registry.
   */
  resolveStep?: (input: QueryStepResolveInput) => QueryStepRuntime | Promise<QueryStepRuntime>;
  /** @deprecated Query always delegates authority to the injected executor. */
  executionBoundary?: 'legacy' | 'tool_gateway';
  /** LLM service instance */
  llm: LLMService;
  /** @deprecated Use loopBudget.maxLlmRequestsPerUserTurn. This alias is resource-only. */
  maxTurns?: number;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Streaming callbacks (onChunk writes to stdout, etc.) */
  streamCallbacks?: StreamCallbacks;
  /** Permission mode for tool execution */
  permissionMode?: PermissionMode;
  /** Fallback for permission checks that would need an interactive prompt. */
  toolConfirmation?: ToolConfirmationPolicy;
  /** Project-scoped allowlist rule engine applied on top of tool policy + mode. */
  toolAllowlist?: ToolAllowlistEvaluator;
  /** Optional UI confirmation hook for tools whose permission check returns ask. */
  confirmToolUse?: (request: {
    name: string;
    args: Record<string, unknown>;
    reason?: string;
    abortSignal?: AbortSignal;
  }) => Promise<boolean>;
  /** Tool execution context */
  toolContext?: ToolContext;
  /** Cost tracker for recording usage */
  costTracker?: CostTracker;
  /** Strategy tracker for alternative approaches */
  strategyTracker?: StrategyTracker;
  /** Optional Context Harness for turn-level context, ledger, and completion gates */
  harness?: QueryTaskContext;
  /** Current user input, used by Context Harness for evidence ranking */
  input?: string;
  /** Maximum number of concurrency-safe tools to execute at once (default 6). */
  maxParallelToolCalls?: number;
  /** Maximum bytes of one tool result to expose to the next model request. */
  maxModelVisibleToolResultBytes?: number;
  /** Per-user-turn budget guardrails for model requests, tools, and model-visible tool output. */
  loopBudget?: Partial<LoopBudget>;
  /** Runtime observer for current context pressure. Renderers consume Store state instead. */
  onContextUsage?: (usage: ContextUsageSnapshot) => void;
  /** Runtime observer for autonomous core compaction. */
  onAutoCompact?: (notice: AutoCompactNotice) => void;
  /** Runtime-owned compact policy and provider calibration. */
  compactCoordinator?: CompactCoordinator;
  /** Capture the durable transcript identity immediately before candidate preparation. */
  onCompactPrepare?: () => CompactPrepareSourceReceipt | undefined;
}

export interface QueryStepResolveInput {
  readonly requestIndex: number;
  readonly messages: readonly Message[];
  readonly input?: string;
  readonly abortSignal?: AbortSignal;
}

export interface QueryStepRuntime {
  readonly tools: readonly OrionCodeTool[];
  readonly toolExecutor: QueryParams['toolExecutor'];
  readonly receiptDigest?: string;
  /**
   * Freeze the final prompt/router binding after compaction and prompt assembly,
   * immediately before the provider request is issued.
   */
  readonly bindModelRequest?: (
    input: QueryModelRequestBindingInput
  ) => QueryModelRequestBinding | Promise<QueryModelRequestBinding>;
}

export interface QueryModelRequestBindingInput {
  readonly requestIndex: number;
  readonly messages: readonly Message[];
  readonly tools: readonly OrionCodeTool[];
  readonly abortSignal?: AbortSignal;
}

export interface QueryModelRequestBinding {
  readonly toolExecutor: QueryParams['toolExecutor'];
  readonly receiptDigest?: string;
}

export type QueryTaskContext = Pick<
  ContextHarness,
  | 'updateCapabilityProfile'
  | 'assembleMessages'
  | 'getCapsule'
  | 'toJSON'
  | 'recordAssistantResponse'
  | 'beforeToolUse'
  | 'asToolBlockedResult'
  | 'recordToolResult'
  | 'beforeComplete'
  | 'asCompletionBlockedMessage'
>;

export interface AutoCompactNotice {
  mode: 'predictive' | 'threshold';
  before: ContextUsageSnapshot;
  after: ContextUsageSnapshot;
}

function publishContextUsage(
  params: Pick<QueryParams, 'onContextUsage'>,
  autoCompact: AutoCompact,
  modelId: string,
  usedTokens: number,
  source: 'estimated' | 'provider_adjusted' = 'estimated'
): ContextUsageSnapshot {
  const stats = autoCompact.getStats();
  const usage = createContextUsageSnapshot({
    modelId,
    usedTokens,
    source,
    outputReserveTokens: stats.outputReserveTokens,
    warningThreshold: stats.preCompactThreshold,
    autoCompactThreshold: stats.threshold,
    autoCompactEnabled: stats.enabled,
  });
  try {
    params.onContextUsage?.(usage);
  } catch {
    // Context observers must never break the agent loop.
  }
  return usage;
}

function publishAutoCompact(
  callback: QueryParams['onAutoCompact'],
  notice: AutoCompactNotice
): void {
  try {
    callback?.(notice);
  } catch {
    // Runtime observers must never break autonomous compaction.
  }
}

function validateFinalCompactRequest(
  result: CompactResult,
  autoCompact: AutoCompact,
  modelId: string,
  harness: QueryTaskContext | undefined,
  messagesForHarness: Pick<OrionCodeTool, 'name' | 'description'>[],
  input?: string
): CompactPostValidation {
  const assembled = harness
    ? harness.assembleMessages(result.messages, {
        input,
        tools: messagesForHarness,
      })
    : result.messages;
  const estimatedTokens = estimateMessagesTokens(assembled);
  const observedTokens = autoCompact.adjustTokenEstimate(estimatedTokens, modelId);
  const compactStats = autoCompact.getStats();
  const targetTokens = Math.max(
    1,
    Math.floor(compactStats.safeInputBudget * compactStats.targetRatio)
  );
  if (observedTokens <= targetTokens) return { valid: true, observedTokens, targetTokens };
  return {
    valid: false,
    code: 'no_headroom',
    message: `Final assembled request uses ${observedTokens} tokens after compact; safe target is ${targetTokens}.`,
    observedTokens,
    targetTokens,
  };
}

function failureForUnchangedCompactAttempt(
  attempt: Extract<AutoCompactAttempt, { status: 'duplicate' | 'rejected' }>,
  autoCompact: AutoCompact
): CompactPauseFailure {
  const compactStats = autoCompact.getStats();
  const beforeTokens = estimateMessagesTokens(attempt.messages);
  return {
    code: attempt.status === 'duplicate' ? 'context_thrash' : 'no_headroom',
    message:
      attempt.status === 'duplicate'
        ? 'The same high-pressure context reached compact again without new durable progress.'
        : 'Compact could not reduce the high-pressure context, so the request was paused.',
    mode: attempt.mode,
    fingerprint: attempt.fingerprint,
    consecutiveNoProgressAttempts: attempt.consecutiveNoProgressAttempts,
    beforeTokens,
    afterTokens: beforeTokens,
    safeInputBudget: compactStats.safeInputBudget,
    targetTokens: Math.max(1, Math.floor(compactStats.safeInputBudget * compactStats.targetRatio)),
  };
}

function compactPausedEvent(
  llm: LLMService,
  stats: LoopStats,
  failure: CompactPauseFailure,
  content?: string
): Extract<QueryEvent, { type: 'complete' }> {
  stats.compactFailure = {
    ...failure,
    validationErrors: failure.validationErrors?.map(error => ({ ...error })),
  };
  return {
    type: 'complete',
    content:
      content ??
      `Context compaction paused this request: ${failure.message} Change context or budget, then resume.`,
    model: llm.getModel(),
    stats: cloneLoopStats(stats, 'compact_paused'),
  };
}

// ============================================================================
// query() — async generator
// ============================================================================

/**
 * Generator-based agentic loop.
 *
 * LLM → stream (via callback) → tool_call → execute → tool_result → repeat
 *
 * @example
 * for await (const event of query({
 *   messages, tools, toolExecutor, llm,
 *   streamCallbacks: { onChunk: (t) => process.stdout.write(t) },
 * })) {
 *   switch (event.type) {
 *     case 'complete': console.log(event.usage); break;
 *   }
 * }
 */
export async function* query(params: QueryParams): AsyncGenerator<QueryEvent> {
  const {
    messages,
    tools: initialTools,
    toolExecutor: initialToolExecutor,
    llm,
    abortSignal,
    streamCallbacks,
    costTracker,
    strategyTracker = createStrategyTracker({ maxAttempts: 5 }), // 增加到 5 次
    harness,
    input,
    maxParallelToolCalls = 6,
  } = params;

  let turn = 0;
  let consecutiveCompletionGateBlocks = 0;
  const stats = createLoopStats();
  let pendingCompact: QueryCompactCommit | undefined;
  const uncompactedMessages = messages.map(message => ({ ...message }));
  const appendMessage = (message: Message): void => {
    messages.push(message);
    uncompactedMessages.push({ ...message });
    if (pendingCompact) {
      pendingCompact.uncompactedHistory = uncompactedMessages.map(entry => ({ ...entry }));
    }
  };
  let compactPrepareSource: CompactPrepareSourceReceipt | undefined;
  const captureCompactPrepareSource = (): CompactPrepareSourceReceipt | undefined => {
    if (compactPrepareSource) return compactPrepareSource;
    try {
      compactPrepareSource = params.onCompactPrepare?.();
    } catch {
      // Candidate preparation may continue in memory, but persistence will fail
      // closed because semantic checkpoint commits require this receipt.
      compactPrepareSource = undefined;
    }
    return compactPrepareSource;
  };
  let aggregateUsage: { promptTokens: number; completionTokens: number } | undefined;
  // Preserve the old option as a resource-budget alias. It no longer emits a
  // task-like `max_turns` completion or claims that the objective completed.
  const legacyRequestBudget =
    typeof params.maxTurns === 'number' && Number.isFinite(params.maxTurns) && params.maxTurns > 0
      ? Math.floor(params.maxTurns)
      : undefined;
  let loopBudget = resolveLoopBudget({
    ...params.loopBudget,
    ...(params.loopBudget?.maxLlmRequestsPerUserTurn === undefined && legacyRequestBudget
      ? { maxLlmRequestsPerUserTurn: legacyRequestBudget }
      : {}),
  });
  applyLoopBudgetStats(stats, loopBudget);
  const maxModelVisibleToolResultBytes = Math.max(
    512,
    params.maxModelVisibleToolResultBytes ?? DEFAULT_MAX_MODEL_VISIBLE_TOOL_RESULT_BYTES
  );
  const fragmentedReadOnlyTools = new Set(BATCH_READ_ALLOWED_TOOLS);
  // 无限循环，依赖安全机制停止
  while (true) {
    turn++;

    // Check abort
    if (isAborted(abortSignal)) {
      yield attachCompactCommit(
        cancelledCompleteEvent(llm, stats),
        pendingCompact,
        messages,
        aggregateUsage
      );
      return;
    }

    if (shouldPromoteDefaultBudget(stats, loopBudget)) {
      loopBudget = promoteDefaultBudgetToComplex(loopBudget);
      applyLoopBudgetStats(stats, loopBudget);
    }

    if (stats.llmRequests >= loopBudget.maxLlmRequestsPerUserTurn) {
      yield attachCompactCommit(
        budgetExceededEvent(
          llm,
          stats,
          `LLM request budget ${loopBudget.maxLlmRequestsPerUserTurn} reached`
        ),
        pendingCompact,
        messages,
        aggregateUsage
      );
      return;
    }

    const resolvedStep = params.resolveStep
      ? await params.resolveStep({
          requestIndex: turn - 1,
          messages: messages.map(message => ({ ...message })),
          input,
          abortSignal,
        })
      : { tools: initialTools, toolExecutor: initialToolExecutor };
    const tools = [...resolvedStep.tools];
    let toolExecutor = resolvedStep.toolExecutor;
    const openaiTools = toOpenAITools(tools) as unknown as Tool[];
    harness?.updateCapabilityProfile?.({
      modelId: llm.getModel(),
      contextWindow: getModelContextWindow(llm.getModel()),
      permissionMode: params.permissionMode ?? 'default',
      toolConfirmation: params.toolConfirmation ?? 'allow',
      tools: tools.map(tool => tool.name),
    });

    // Request start
    yield { type: 'request_start', model: llm.getModel(), turn };
    stats.turnsStarted = turn;

    const coordinator = params.compactCoordinator;
    coordinator?.configure({
      modelId: llm.getModel(),
      getContextCapsule: harness ? () => harness.getCapsule() : undefined,
      getHarnessState: harness ? () => harness.toJSON() : undefined,
      llm,
      outputReserveTokens: llm.getMaxTokens?.(),
    });
    const autoCompact =
      coordinator?.getAutomatic() ??
      new AutoCompact({
        modelId: llm.getModel(),
        getContextCapsule: harness ? () => harness.getCapsule() : undefined,
        getHarnessState: harness ? () => harness.toJSON() : undefined,
        llm,
        outputReserveTokens: llm.getMaxTokens?.(),
      });

    // Stream the LLM response. Harness context is injected into a cloned
    // request payload so the durable conversation history stays clean.
    let requestMessages = harness
      ? harness.assembleMessages(messages, {
          input,
          tools: tools.map(tool => ({ name: tool.name, description: tool.description })),
        })
      : messages;
    let requestEstimatedTokens = estimateMessagesTokens(requestMessages);
    const predictedTokens = autoCompact.adjustTokenEstimate(requestEstimatedTokens, llm.getModel());
    const contextBeforePredictiveCompact = publishContextUsage(
      params,
      autoCompact,
      llm.getModel(),
      predictedTokens,
      autoCompact.hasProviderCalibration(llm.getModel()) ? 'provider_adjusted' : 'estimated'
    );
    const preCompactObjective = harness?.getCapsule()?.contract?.objective;
    const compactToolDescriptions = tools.map(tool => ({
      name: tool.name,
      description: tool.description,
    }));
    const predictiveStats = autoCompact.getStats();
    if (
      predictiveStats.enabled &&
      predictedTokens / Math.max(1, predictiveStats.safeInputBudget) >=
        predictiveStats.predictiveCompactThreshold
    ) {
      captureCompactPrepareSource();
    }
    const preCompactAttempt = await autoCompact.checkPredictiveCompactOutcome(
      messages,
      predictedTokens,
      result =>
        validateFinalCompactRequest(
          result,
          autoCompact,
          llm.getModel(),
          harness,
          compactToolDescriptions,
          input
        )
    );
    if (preCompactAttempt.status === 'paused') {
      yield attachCompactCommit(
        compactPausedEvent(llm, stats, preCompactAttempt.failure),
        pendingCompact,
        messages,
        aggregateUsage
      );
      return;
    }
    if (preCompactAttempt.status === 'duplicate' || preCompactAttempt.status === 'rejected') {
      yield attachCompactCommit(
        compactPausedEvent(
          llm,
          stats,
          failureForUnchangedCompactAttempt(preCompactAttempt, autoCompact)
        ),
        pendingCompact,
        messages,
        aggregateUsage
      );
      return;
    }
    const preCompacted = preCompactAttempt.messages;
    if (preCompactAttempt.status === 'compacted') {
      stats.compactTrigger = 'pre_turn';
      messages.length = 0;
      messages.push(...preCompacted);
      requestMessages = harness
        ? harness.assembleMessages(messages, {
            input,
            tools: tools.map(tool => ({ name: tool.name, description: tool.description })),
          })
        : messages;
      const postCompactObjective = harness?.getCapsule()?.contract?.objective;
      if (
        preCompactObjective &&
        postCompactObjective &&
        preCompactObjective !== postCompactObjective
      ) {
        yield {
          type: 'warning',
          message:
            'Harness objective may have shifted during compact. Verify current task alignment.',
        };
      }
      requestEstimatedTokens = estimateMessagesTokens(requestMessages);
      const compactedTokens = autoCompact.adjustTokenEstimate(
        requestEstimatedTokens,
        llm.getModel()
      );
      autoCompact.getCtxPercent(compactedTokens);
      const contextAfterPredictiveCompact = publishContextUsage(
        params,
        autoCompact,
        llm.getModel(),
        compactedTokens,
        autoCompact.hasProviderCalibration(llm.getModel()) ? 'provider_adjusted' : 'estimated'
      );
      pendingCompact = queryCompactCommit(
        'predictive',
        preCompactAttempt.result,
        contextBeforePredictiveCompact,
        contextAfterPredictiveCompact,
        uncompactedMessages,
        compactPrepareSource,
        harness?.toJSON()
      );
      publishAutoCompact(params.onAutoCompact, {
        mode: 'predictive',
        before: contextBeforePredictiveCompact,
        after: contextAfterPredictiveCompact,
      });
    }

    const assemblyStats = harness?.toJSON().promptAssemblyStats;
    if (assemblyStats) {
      yield {
        type: 'prompt_assembly',
        modelId: assemblyStats.modelId,
        estimatedTokens: assemblyStats.estimatedTokens,
        budgetTokens: assemblyStats.budgetTokens,
        coreTokens: assemblyStats.coreTokens,
        evidenceBudgetTokens: assemblyStats.evidenceBudgetTokens,
        recentTurnBudgetTokens: assemblyStats.recentTurnBudgetTokens,
        sections: assemblyStats.sections.slice(0, 12),
        includedEvidence: compactPromptEvidence(assemblyStats.includedEvidence),
        omittedEvidence: compactPromptEvidence(assemblyStats.omittedEvidence, 8),
        includedEvidenceCount: assemblyStats.includedEvidence.length,
        omittedEvidenceCount: assemblyStats.omittedEvidence.length,
        sectionManifest: assemblyStats.sectionManifest?.map(item => ({ ...item })) ?? [],
        overBudget: assemblyStats.overBudget === true,
        capabilityProfileVersion: assemblyStats.capabilityProfileVersion,
        capabilityProfileFingerprint: assemblyStats.capabilityProfileFingerprint,
      };
      if (assemblyStats.overBudget) {
        yield attachCompactCommit(
          compactPausedEvent(
            llm,
            stats,
            {
              code: 'mandatory_context_over_budget',
              message: `Mandatory Harness context uses ${assemblyStats.estimatedTokens} tokens; its atomic section budget is ${assemblyStats.budgetTokens}.`,
              mode: 'predictive',
              fingerprint: canonicalMessagesFingerprint(requestMessages),
              consecutiveNoProgressAttempts: 1,
              beforeTokens: assemblyStats.estimatedTokens,
              afterTokens: assemblyStats.estimatedTokens,
              safeInputBudget: assemblyStats.budgetTokens,
              targetTokens: assemblyStats.budgetTokens,
            },
            'Mandatory task context does not fit its atomic prompt budget. Narrow the contract or choose a larger-context model, then resume.'
          ),
          pendingCompact,
          messages,
          aggregateUsage
        );
        return;
      }
    }

    if (isAborted(abortSignal)) {
      yield attachCompactCommit(
        cancelledCompleteEvent(llm, stats),
        pendingCompact,
        messages,
        aggregateUsage
      );
      return;
    }

    if (resolvedStep.bindModelRequest) {
      const bound = await resolvedStep.bindModelRequest({
        requestIndex: turn - 1,
        messages: requestMessages.map(message => ({ ...message })),
        tools,
        abortSignal,
      });
      toolExecutor = bound.toolExecutor;
    }

    let response: Awaited<ReturnType<LLMService['chatStream']>>;
    try {
      stats.llmRequests++;
      response = await llm.chatStream(requestMessages, streamCallbacks, openaiTools, {
        abortSignal,
      });
      applyLlmRequestDiagnostics(stats, getLlmRequestDiagnostics(llm));
      if (response.usage) {
        autoCompact.recordProviderUsage(
          requestEstimatedTokens,
          response.usage.promptTokens,
          response.model || llm.getModel()
        );
      }
    } catch (error) {
      applyLlmRequestDiagnostics(stats, getLlmRequestDiagnostics(llm));
      if (error instanceof ProviderRequestPreflightError) {
        stats.llmRequests = Math.max(0, stats.llmRequests - 1);
        yield attachCompactCommit(
          budgetExceededEvent(llm, stats, error.message),
          pendingCompact,
          messages,
          aggregateUsage
        );
        return;
      }
      throw new QueryLoopError(error, cloneLoopStats(stats, 'failed'), aggregateUsage);
    }

    // Account every successful model request. Tool-calling turns are billable
    // too, so waiting for the final assistant response undercounts real usage.
    if (costTracker && response.usage) {
      costTracker.record(response.usage, {
        model: response.model,
        requestKind: 'agent',
      });
    }
    if (response.usage) {
      aggregateUsage = {
        promptTokens: (aggregateUsage?.promptTokens ?? 0) + response.usage.promptTokens,
        completionTokens: (aggregateUsage?.completionTokens ?? 0) + response.usage.completionTokens,
      };
    }

    if (isAborted(abortSignal)) {
      yield attachCompactCommit(
        cancelledCompleteEvent(llm, stats),
        pendingCompact,
        messages,
        aggregateUsage
      );
      return;
    }

    // Handle tool calls
    if (response.toolCalls && response.toolCalls.length > 0) {
      const toolCalls = response.toolCalls;
      if (stats.toolCalls + toolCalls.length > loopBudget.maxToolCallsPerUserTurn) {
        yield attachCompactCommit(
          budgetExceededEvent(
            llm,
            stats,
            `tool call budget ${loopBudget.maxToolCallsPerUserTurn} would be exceeded by ${toolCalls.length} requested tools`
          ),
          pendingCompact,
          messages,
          aggregateUsage
        );
        return;
      }

      // Save assistant tool-call message only after budget checks, so future
      // requests never inherit unresolved tool calls if this turn is stopped.
      const assistantMsg: Message = {
        role: 'assistant',
        content: response.content,
        tool_calls: toolCalls,
      };
      appendMessage(assistantMsg);
      harness?.recordAssistantResponse(response);

      yield {
        type: 'assistant_tool_calls',
        content: response.content,
        toolCalls,
      };

      const preparedCalls = prepareToolCalls({
        toolCalls,
        tools,
        startApproach: (toolName: string) => strategyTracker.startApproach(toolName),
        addToolToTracker: (attemptId: string, toolName: string) =>
          strategyTracker.addTool(attemptId, toolName),
        harnessDriftCheck: harness
          ? ({ name, args }) => harness.beforeToolUse({ name, args })
          : undefined,
      });
      stats.toolCalls += preparedCalls.length;
      for (const prepared of preparedCalls) {
        if (prepared.tool?.isReadOnly?.(prepared.args) === true) {
          stats.readOnlyToolCalls++;
        } else {
          stats.unsafeToolCalls++;
        }
      }
      const singleFragmentedReadOnlyCall =
        preparedCalls.length === 1 &&
        preparedCalls[0].tool?.isReadOnly?.(preparedCalls[0].args) === true &&
        fragmentedReadOnlyTools.has(preparedCalls[0].tc.function.name);
      stats.singleReadOnlyStreak = singleFragmentedReadOnlyCall
        ? stats.singleReadOnlyStreak + 1
        : 0;

      let pendingStrategySuggestion: string | undefined;
      const answeredToolCallIds = new Set<string>();
      const preparedCallById = new Map(preparedCalls.map(call => [call.tc.id, call]));

      for (const prepared of preparedCalls) {
        yield {
          type: 'tool_call',
          name: prepared.tc.function.name,
          args: prepared.args,
          callId: prepared.tc.id,
          batchCount: toolCalls.length,
          batchIndex: prepared.index,
        };
      }

      for await (const executed of executeToolCalls(preparedCalls, {
        toolExecutor,
        abortSignal,
        harnessBlockedResult: harness ? drift => harness.asToolBlockedResult(drift) : undefined,
        maxParallelToolCalls,
      })) {
        if (isAborted(abortSignal)) {
          yield attachCompactCommit(
            cancelledCompleteEvent(llm, stats),
            pendingCompact,
            messages,
            aggregateUsage
          );
          return;
        }

        const { prepared } = executed;
        const { tc, args, attemptId } = prepared;
        const remainingModelVisibleBytes =
          loopBudget.maxModelVisibleToolBytes - stats.modelVisibleToolBytes;
        const modelVisible =
          remainingModelVisibleBytes < 512
            ? omitModelVisibleToolResult(executed, loopBudget.maxModelVisibleToolBytes)
            : summarizeModelVisibleToolResult(
                executed,
                Math.min(maxModelVisibleToolResultBytes, remainingModelVisibleBytes)
              );
        stats.toolResultBytes += executed.outputBytes ?? byteLength(executed.result);
        stats.modelVisibleToolBytes += modelVisible.bytes;
        stats.summarizedBytes += modelVisible.summarizedBytes;
        stats.lastToolName = tc.function.name;
        stats.lastToolSummary = (executed.summary ?? executed.error ?? '')
          .replace(/\s+/gu, ' ')
          .trim()
          .slice(0, 240);
        stats.lastToolSuccess = executed.success;

        strategyTracker.recordResult(
          attemptId,
          executed.strategyResult,
          executed.strategyError,
          executed.duration
        );
        harness?.recordToolResult({
          name: tc.function.name,
          args,
          result: executed.result,
          duration: executed.duration,
          success: executed.success,
          error: executed.error,
          summary: executed.summary,
        });
        if (harness && tc.function.name === 'batch_read') {
          for (const step of parseBatchReadEvidenceSteps(executed.result)) {
            harness.recordToolResult({
              name: step.tool,
              args: step.args,
              result: JSON.stringify({
                success: step.success,
                output: step.output,
                summary: step.summary,
                error: step.error,
              }),
              duration: executed.duration,
              success: step.success,
              error: step.error,
              summary: step.summary,
            });
          }
        }

        if (executed.permissionDecision) {
          yield {
            type: 'permission_decision',
            name: tc.function.name,
            args,
            callId: tc.id,
            decision: executed.permissionDecision,
            batchCount: toolCalls.length,
            batchIndex: prepared.index,
          };
        }

        yield {
          type: 'tool_result',
          name: tc.function.name,
          args,
          callId: tc.id,
          result: executed.result,
          modelVisibleResult: modelVisible.result,
          duration: executed.duration,
          success: executed.success,
          artifactRef: executed.artifactRef,
          externalAssertion: executed.externalAssertion,
          error: executed.error,
          summary: executed.summary,
          outputBytes: executed.outputBytes,
          batchCount: toolCalls.length,
          batchIndex: prepared.index,
        };

        appendMessage({
          role: 'tool',
          content: modelVisible.result,
          tool_call_id: tc.id,
        });
        answeredToolCallIds.add(tc.id);

        if (executed.permissionDecision?.approved === false) {
          for (const skipped of pendingToolCalls(toolCalls, answeredToolCallIds)) {
            const skippedPrepared = preparedCallById.get(skipped.id);
            if (!skippedPrepared) continue;
            const skippedError = `Skipped after permission denial for ${tc.function.name}.`;
            const skippedResult = JSON.stringify({ success: false, error: skippedError });
            const skippedBytes = byteLength(skippedResult);
            strategyTracker.recordResult(skippedPrepared.attemptId, 'failed', skippedError, 0);
            harness?.recordToolResult({
              name: skipped.function.name,
              args: skippedPrepared.args,
              result: skippedResult,
              duration: 0,
              success: false,
              error: skippedError,
              summary: skippedError,
            });
            stats.toolResultBytes += skippedBytes;
            stats.modelVisibleToolBytes += skippedBytes;
            stats.lastToolName = skipped.function.name;
            stats.lastToolSummary = skippedError;
            stats.lastToolSuccess = false;
            yield {
              type: 'tool_result',
              name: skipped.function.name,
              args: skippedPrepared.args,
              callId: skipped.id,
              result: skippedResult,
              modelVisibleResult: skippedResult,
              duration: 0,
              success: false,
              error: skippedError,
              summary: skippedError,
              outputBytes: skippedBytes,
              batchCount: toolCalls.length,
              batchIndex: skippedPrepared.index,
            };
            appendMessage({
              role: 'tool',
              content: skippedResult,
              tool_call_id: skipped.id,
            });
            answeredToolCallIds.add(skipped.id);
          }
          yield attachCompactCommit(
            permissionBlockedEvent(
              llm,
              stats,
              tc.function.name,
              executed.error,
              executed.permissionDecision.source
            ),
            pendingCompact,
            messages,
            aggregateUsage
          );
          return;
        }

        if (!pendingStrategySuggestion && strategyTracker.isExhausted()) {
          pendingStrategySuggestion = strategyTracker.suggestAlternative() ?? undefined;
        }
      }

      if (pendingStrategySuggestion) {
        yield { type: 'strategy_exhausted', suggestion: pendingStrategySuggestion };
        appendMessage({
          role: 'user',
          content: pendingStrategySuggestion,
        });
        strategyTracker.reset();
      }

      if (stats.singleReadOnlyStreak >= loopBudget.maxReadOnlyFragmentation) {
        appendMessage({
          role: 'system',
          content: [
            '[Orion Code loop hint]',
            `You have made ${stats.singleReadOnlyStreak} consecutive turns with a single read-only local tool call.`,
            'For independent local exploration, prefer batch_read with up to 8 steps using git_status, list_files, glob, grep, and read_file.',
          ].join(' '),
        });
        stats.batchReadSuggestionCount++;
        stats.singleReadOnlyStreak = 0;
      }

      // Continue to next turn
      continue;
    }

    const assistantMsg: Message = {
      role: 'assistant',
      content: response.content,
    };
    appendMessage(assistantMsg);
    harness?.recordAssistantResponse(response);

    // No tool calls — done, unless the harness requires one more pass.
    const completionGate = harness?.beforeComplete();
    if (completionGate && !completionGate.canComplete) {
      consecutiveCompletionGateBlocks++;
      if (consecutiveCompletionGateBlocks >= 2) {
        const missing = completionGate.missing?.length
          ? completionGate.missing.join('; ')
          : 'required verification evidence is missing';
        const stoppedStats = cloneLoopStats(stats, 'completion_gate');
        if (completionGate.stopDecision) {
          stoppedStats.stopDecision = completionGate.stopDecision;
        }
        yield attachCompactCommit(
          {
            type: 'complete',
            content: `Completion gate stopped this turn: ${missing}\nRun the required verification, then continue.`,
            model: response.model || llm.getModel(),
            stats: stoppedStats,
          },
          pendingCompact,
          messages,
          aggregateUsage
        );
        return;
      }
      appendMessage(harness!.asCompletionBlockedMessage(completionGate));
      stats.finishReason = 'completion_gate';
      continue;
    }
    consecutiveCompletionGateBlocks = 0;

    yield { type: 'message', role: 'assistant', content: response.content };

    // Keep the next request safe by compacting the current durable history at
    // 95%. This uses current-message context, not cumulative session tokens.
    const currentContextEstimate = estimateMessagesTokens(messages);
    const currentContextTokens = autoCompact.adjustTokenEstimate(
      currentContextEstimate,
      response.model || llm.getModel()
    );
    autoCompact.configure({
      modelId: response.model || llm.getModel(),
      getContextCapsule: harness ? () => harness.getCapsule() : undefined,
      getHarnessState: harness ? () => harness.toJSON() : undefined,
      llm,
    });
    const contextBeforeThresholdCompact = publishContextUsage(
      params,
      autoCompact,
      response.model || llm.getModel(),
      currentContextTokens,
      autoCompact.hasProviderCalibration(response.model || llm.getModel())
        ? 'provider_adjusted'
        : 'estimated'
    );
    const validatePostCompact = (result: CompactResult): CompactPostValidation =>
      validateFinalCompactRequest(
        result,
        autoCompact,
        response.model || llm.getModel(),
        harness,
        compactToolDescriptions,
        input
      );
    const thresholdStats = autoCompact.getStats();
    if (
      !pendingCompact &&
      thresholdStats.enabled &&
      currentContextTokens / Math.max(1, thresholdStats.safeInputBudget) >= thresholdStats.threshold
    ) {
      captureCompactPrepareSource();
    }
    const postCompactAttempt = pendingCompact
      ? await autoCompact.ensureHeadroomAndCompactOutcome(
          messages,
          currentContextTokens,
          validatePostCompact
        )
      : await autoCompact.checkAndCompactOutcome(
          messages,
          currentContextTokens,
          validatePostCompact
        );
    if (postCompactAttempt.status === 'paused') {
      yield attachCompactCommit(
        compactPausedEvent(llm, stats, postCompactAttempt.failure, response.content),
        pendingCompact,
        messages,
        aggregateUsage
      );
      return;
    }
    if (postCompactAttempt.status === 'duplicate' || postCompactAttempt.status === 'rejected') {
      yield attachCompactCommit(
        compactPausedEvent(
          llm,
          stats,
          failureForUnchangedCompactAttempt(postCompactAttempt, autoCompact),
          response.content
        ),
        pendingCompact,
        messages,
        aggregateUsage
      );
      return;
    }
    const compacted = postCompactAttempt.messages;
    if (postCompactAttempt.status === 'compacted') {
      stats.compactTrigger = stats.compactTrigger ?? 'post_turn';
      messages.length = 0;
      messages.push(...compacted);
      const compactedEstimate = estimateMessagesTokens(messages);
      const compactedTokens = autoCompact.adjustTokenEstimate(
        compactedEstimate,
        response.model || llm.getModel()
      );
      autoCompact.getCtxPercent(compactedTokens);
      const contextAfterThresholdCompact = publishContextUsage(
        params,
        autoCompact,
        response.model || llm.getModel(),
        compactedTokens,
        autoCompact.hasProviderCalibration(response.model || llm.getModel())
          ? 'provider_adjusted'
          : 'estimated'
      );
      pendingCompact = queryCompactCommit(
        pendingCompact?.mode ?? 'threshold',
        postCompactAttempt.result,
        contextBeforeThresholdCompact,
        contextAfterThresholdCompact,
        uncompactedMessages,
        pendingCompact?.prepareSource ?? compactPrepareSource,
        pendingCompact?.semanticHarnessState ?? harness?.toJSON()
      );
      publishAutoCompact(params.onAutoCompact, {
        mode: 'threshold',
        before: contextBeforeThresholdCompact,
        after: contextAfterThresholdCompact,
      });
    } else if (pendingCompact) {
      pendingCompact = {
        ...pendingCompact,
        after: contextBeforeThresholdCompact,
      };
    }

    yield {
      type: 'complete',
      content: response.content,
      usage: aggregateUsage,
      model: response.model,
      stats: cloneLoopStats(stats, 'completed'),
      compact: pendingCompact ? bindCompactCommitToHistory(pendingCompact, messages) : undefined,
    };
    return;
  }
  // Note: Loop exits via return statements above, not by falling through
}
