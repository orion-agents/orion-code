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
import type { ProviderErrorType } from '../services/provider-diagnostics';
import type { OpenHorseTool, ToolContext } from './tool';
import type { PermissionMode } from '../commands/types';
import type { CostTracker } from '../core/cost-tracker';
import type { ToolConfirmationPolicy } from '../services/config';
import { toOpenAITools } from './tool';
import { createStrategyTracker, type StrategyTracker } from '../core/strategy-tracker';
import { AutoCompact } from '../services/compact/auto-compact';
import type { CompactCoordinator } from '../services/compact/coordinator';
import type { ContextHarness } from '../harness';
import type { PromptAssemblyStats } from '../harness/types';
import {
  prepareToolCalls,
  executeToolCalls,
  type ExecutedToolCall,
  type ToolPermissionDecision,
} from './tool-scheduler';
import { estimateMessagesTokens } from '../utils/token-estimate';
import { parseToolResultEnvelope, serializeToolResult } from './tool-serializer';
import { createContextUsageSnapshot, type ContextUsageSnapshot } from '../services/model-context';

export const DEFAULT_MAX_MODEL_VISIBLE_TOOL_RESULT_BYTES = 4096;

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
  | 'max_turns'
  | 'completion_gate'
  | 'budget_exceeded'
  | 'running';

export type LoopBudgetBaseProfile = 'default' | 'complex' | 'release';
export type LoopBudgetSource = LoopBudgetBaseProfile | 'config';
export type LoopContinuationAction =
  | 'reply_continue'
  | 'narrow_instruction'
  | 'inspect_loop_stats'
  | 'raise_budget';

export interface LoopBudget {
  /** Maximum LLM requests allowed for one user turn before stopping. */
  maxLlmRequestsPerUserTurn: number;
  /** Maximum tool calls allowed for one user turn before stopping. */
  maxToolCallsPerUserTurn: number;
  /** Consecutive single read-only tool turns before injecting a batch_read hint. */
  maxReadOnlyFragmentation: number;
  /** Maximum aggregate tool-result bytes exposed to the model in one user turn. */
  maxModelVisibleToolBytes: number;
  /** Budget source after config overrides are applied. */
  profile?: LoopBudgetSource;
  /** Adaptive profile selected before config overrides, when applicable. */
  baseProfile?: LoopBudgetBaseProfile;
  /** Whether user/global/env config changed one or more numeric budget fields. */
  configOverride?: boolean;
}

export const DEFAULT_LOOP_BUDGET: LoopBudget = {
  maxLlmRequestsPerUserTurn: 24,
  maxToolCallsPerUserTurn: 120,
  maxReadOnlyFragmentation: 3,
  maxModelVisibleToolBytes: 64 * 1024,
  profile: 'default',
  baseProfile: 'default',
  configOverride: false,
};

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
  continuationActions?: LoopContinuationAction[];
  continuationHint?: string;
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

  constructor(error: unknown, stats: LoopStats) {
    super(error instanceof Error ? error.message : String(error));
    this.name = 'QueryLoopError';
    this.originalError = error;
    this.stats = stats;
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

function cloneLoopStats(stats: LoopStats, finishReason?: LoopFinishReason): LoopStats {
  return {
    ...stats,
    finishReason: finishReason ?? stats.finishReason,
  };
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function createLocalFastPathLoopStats(overrides: Partial<LoopStats> = {}): LoopStats {
  return {
    ...createLoopStats(),
    turnsStarted: 1,
    finishReason: 'completed',
    localFastPathUsed: true,
    ...overrides,
  };
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
  return stats;
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
    'Reply `继续` to continue the same objective, give a narrower next step, inspect /loop-stats, or raise agentLoop.budget for intentional long work.';
  return {
    type: 'complete',
    content: [
      `Agent loop budget reached: ${reason}.`,
      'I stopped this turn to avoid unnecessary model requests and preserved the current session state.',
      'To continue the same objective, reply `继续` or provide the next concrete step.',
      'Use /loop-stats to inspect request/tool counts. For intentional long work, raise agentLoop.budget in orion.json.',
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
      error?: string;
      summary?: string;
      outputBytes?: number;
      batchCount?: number;
      batchIndex?: number;
    }
  | { type: 'strategy_exhausted'; suggestion: string }
  | { type: 'message'; role: 'assistant'; content: string }
  | {
      type: 'complete';
      content: string;
      usage?: { promptTokens: number; completionTokens: number };
      model: string;
      stats?: LoopStats;
      compact?: QueryCompactCommit;
    };

export interface QueryCompactCommit {
  mode: 'predictive' | 'threshold';
  modelHistory: Message[];
  summary: {
    text: string;
    generatedAt: number;
    source: 'llm' | 'heuristic';
  };
  before: ContextUsageSnapshot;
  after: ContextUsageSnapshot;
}

function attachCompactCommit(
  event: Extract<QueryEvent, { type: 'complete' }>,
  compact: QueryCompactCommit | undefined,
  messages: Message[]
): Extract<QueryEvent, { type: 'complete' }> {
  return compact
    ? {
        ...event,
        compact: {
          ...compact,
          modelHistory: messages.map(message => ({ ...message })),
        },
      }
    : event;
}

// ============================================================================
// 参数
// ============================================================================

export interface QueryParams {
  /** Conversation history (must include system prompt as first message) */
  messages: Message[];
  /** Available tools */
  tools: OpenHorseTool[];
  /** Tool executor: (name, args, abortSignal?) => result string
   *  Issue #32 #3.2: 支持 abortSignal 透传 */
  toolExecutor: (
    name: string,
    args: Record<string, unknown>,
    abortSignal?: AbortSignal
  ) => Promise<string>;
  /** LLM service instance */
  llm: LLMService;
  /** Maximum turns (default: no limit, relies on safety mechanisms) */
  maxTurns?: number;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Streaming callbacks (onChunk writes to stdout, etc.) */
  streamCallbacks?: StreamCallbacks;
  /** Permission mode for tool execution */
  permissionMode?: PermissionMode;
  /** Fallback for permission checks that would need an interactive prompt. */
  toolConfirmation?: ToolConfirmationPolicy;
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
  harness?: ContextHarness;
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
}

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
    tools,
    toolExecutor,
    llm,
    maxTurns, // 无默认值，可选参数
    abortSignal,
    streamCallbacks,
    costTracker,
    strategyTracker = createStrategyTracker({ maxAttempts: 5 }), // 增加到 5 次
    harness,
    input,
    maxParallelToolCalls = 6,
  } = params;

  const openaiTools = toOpenAITools(tools) as unknown as Tool[];
  let turn = 0;
  const stats = createLoopStats();
  let pendingCompact: QueryCompactCommit | undefined;
  let loopBudget = resolveLoopBudget(params.loopBudget);
  applyLoopBudgetStats(stats, loopBudget);
  const maxModelVisibleToolResultBytes = Math.max(
    512,
    params.maxModelVisibleToolResultBytes ?? DEFAULT_MAX_MODEL_VISIBLE_TOOL_RESULT_BYTES
  );
  const fragmentedReadOnlyTools = new Set([
    'read_file',
    'glob',
    'grep',
    'list_files',
    'git_status',
  ]);

  // 无限循环，依赖安全机制停止
  while (true) {
    turn++;

    // Check abort
    if (isAborted(abortSignal)) {
      yield attachCompactCommit(cancelledCompleteEvent(llm, stats), pendingCompact, messages);
      return;
    }

    // Safety valve: check maxTurns if specified (optional)
    if (maxTurns && turn > maxTurns) {
      yield attachCompactCommit(
        {
          type: 'complete',
          content: `Reached maximum turns (${maxTurns}). Task may be incomplete.`,
          model: llm.getModel(),
          stats: cloneLoopStats(stats, 'max_turns'),
        },
        pendingCompact,
        messages
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
        messages
      );
      return;
    }

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
    const autoCompact = coordinator?.getAutomatic() ?? new AutoCompact({
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
    const predictedTokens = autoCompact.adjustTokenEstimate(
      requestEstimatedTokens,
      llm.getModel()
    );
    const contextBeforePredictiveCompact = publishContextUsage(
      params,
      autoCompact,
      llm.getModel(),
      predictedTokens,
      autoCompact.hasProviderCalibration(llm.getModel()) ? 'provider_adjusted' : 'estimated'
    );
    const preCompacted = await autoCompact.checkPredictiveAndCompact(messages, predictedTokens);
    if (preCompacted !== messages) {
      stats.compactTrigger = 'pre_turn';
      messages.length = 0;
      messages.push(...preCompacted);
      requestMessages = harness
        ? harness.assembleMessages(messages, {
            input,
            tools: tools.map(tool => ({ name: tool.name, description: tool.description })),
          })
        : messages;
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
      const result = autoCompact.getLastCompactResult();
      if (result) {
        pendingCompact = {
          mode: 'predictive',
          modelHistory: result.messages.map(message => ({ ...message })),
          summary: {
            text: result.summary,
            generatedAt: result.summaryGeneratedAt,
            source: result.summarySource,
          },
          before: contextBeforePredictiveCompact,
          after: contextAfterPredictiveCompact,
        };
      }
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
      };
    }

    if (isAborted(abortSignal)) {
      yield attachCompactCommit(cancelledCompleteEvent(llm, stats), pendingCompact, messages);
      return;
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
      throw new QueryLoopError(error, cloneLoopStats(stats, 'failed'));
    }

    // Account every successful model request. Tool-calling turns are billable
    // too, so waiting for the final assistant response undercounts real usage.
    if (costTracker && response.usage) {
      costTracker.record(response.usage, {
        model: response.model,
        requestKind: 'agent',
      });
    }

    if (isAborted(abortSignal)) {
      yield attachCompactCommit(cancelledCompleteEvent(llm, stats), pendingCompact, messages);
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
          messages
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
      messages.push(assistantMsg);
      harness?.recordAssistantResponse(response);

      yield {
        type: 'assistant_tool_calls',
        content: response.content,
        toolCalls,
      };

      const preparedCalls = prepareToolCalls({
        toolCalls,
        tools,
        toolExecutor,
        permissionMode: params.permissionMode,
        toolConfirmation: params.toolConfirmation,
        confirmToolUse: params.confirmToolUse,
        toolContext: params.toolContext,
        abortSignal,
        startApproach: (toolName: string) => strategyTracker.startApproach(toolName),
        addToolToTracker: (attemptId: string, toolName: string) =>
          strategyTracker.addTool(attemptId, toolName),
        harnessDriftCheck: harness
          ? ({ name, args }) => harness.beforeToolUse({ name, args })
          : undefined,
        harnessBlockedResult: harness ? drift => harness.asToolBlockedResult(drift) : undefined,
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
        confirmToolUse: params.confirmToolUse,
        permissionMode: params.permissionMode,
        toolConfirmation: params.toolConfirmation,
        harnessBlockedResult: harness ? drift => harness.asToolBlockedResult(drift) : undefined,
        maxParallelToolCalls,
      })) {
        if (isAborted(abortSignal)) {
          yield attachCompactCommit(cancelledCompleteEvent(llm, stats), pendingCompact, messages);
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
          error: executed.error,
          summary: executed.summary,
          outputBytes: executed.outputBytes,
          batchCount: toolCalls.length,
          batchIndex: prepared.index,
        };

        messages.push({
          role: 'tool',
          content: modelVisible.result,
          tool_call_id: tc.id,
        });

        if (executed.permissionDecision?.approved === false) {
          yield attachCompactCommit(
            permissionBlockedEvent(
              llm,
              stats,
              tc.function.name,
              executed.error,
              executed.permissionDecision.source
            ),
            pendingCompact,
            messages
          );
          return;
        }

        if (strategyTracker.isExhausted()) {
          const suggestion = strategyTracker.suggestAlternative();
          if (suggestion) {
            yield { type: 'strategy_exhausted', suggestion };
            messages.push({
              role: 'user',
              content: suggestion,
            });
            strategyTracker.reset();
          }
        }
      }

      if (stats.singleReadOnlyStreak >= loopBudget.maxReadOnlyFragmentation) {
        messages.push({
          role: 'system',
          content: [
            '[Orion Code loop hint]',
            `You have made ${stats.singleReadOnlyStreak} consecutive turns with a single read-only local tool call.`,
            'For independent local exploration, prefer batch_read with up to 8 steps using git_status, list_files, glob, grep, and read_file.',
          ].join(' '),
        });
        stats.batchReadSuggestionCount++;
      }

      // Continue to next turn
      continue;
    }

    const assistantMsg: Message = {
      role: 'assistant',
      content: response.content,
    };
    messages.push(assistantMsg);
    harness?.recordAssistantResponse(response);

    // No tool calls — done, unless the harness requires one more pass.
    const completionGate = harness?.beforeComplete();
    if (completionGate && !completionGate.canComplete) {
      messages.push(harness!.asCompletionBlockedMessage(completionGate));
      stats.finishReason = 'completion_gate';
      continue;
    }

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
    const compacted = await autoCompact.checkAndCompact(messages, currentContextTokens);
    if (compacted !== messages) {
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
      const result = autoCompact.getLastCompactResult();
      if (result) {
        pendingCompact = {
          mode: 'threshold',
          modelHistory: result.messages.map(message => ({ ...message })),
          summary: {
            text: result.summary,
            generatedAt: result.summaryGeneratedAt,
            source: result.summarySource,
          },
          before: contextBeforeThresholdCompact,
          after: contextAfterThresholdCompact,
        };
      }
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
      usage: response.usage,
      model: response.model,
      stats: cloneLoopStats(stats, 'completed'),
      compact: pendingCompact
        ? {
            ...pendingCompact,
            modelHistory: messages.map(message => ({ ...message })),
          }
        : undefined,
    };
    return;
  }
  // Note: Loop exits via return statements above, not by falling through
}
