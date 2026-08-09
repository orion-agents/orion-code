/**
 * Trace, workspace, checkpoint, and verification helpers for AgentChatController.
 *
 * This module owns deterministic projection/persistence helpers only. It does
 * not execute the chat loop or import commands.
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { LLMRequestDiagnostics } from '../services/llm';
import type { SessionMessage, SessionTraceEvent } from '../services/session-storage';
import { appendSessionTraceEvent, redactTraceText } from '../services/session-storage';
import type { LoopStats } from '../framework';
import type { HarnessState } from '../harness/types';
import { storeArtifact } from '../core/tool-artifacts';
import type { OrionCodeUiRuntime, RuntimeHarnessDiagnostics, UiEventSink } from './ui-events';

const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/g;
const TRACE_ARGS_ARTIFACT_THRESHOLD_BYTES = 160;

/**
 * Runtime-only accounting confidence carried from the chat loop into Goal
 * finalization. `false` means the recorded token totals are a known lower
 * bound (for example, an in-flight provider request was aborted before usage
 * metadata arrived).
 */
export type GoalAccountingLoopStats = LoopStats & {
  usageAccountingComplete?: boolean;
};

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

export function isAbortError(error: unknown, abortSignal?: AbortSignal): boolean {
  if (abortSignal?.aborted) return true;
  if (error instanceof Error) {
    return error.name === 'AbortError' || error.message.toLowerCase().includes('aborted');
  }
  return false;
}

export function errorLayerForChatError(error: unknown): import('./ui-events').ErrorLayer {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (
    /NotEnoughCvError|code:\s*11210|provider|quota|rate.?limit|timeout|connection/i.test(message)
  ) {
    return 'provider';
  }
  if (/tool|command|exec_command|write_file|edit_file/i.test(message)) {
    return 'tool';
  }
  if (/\bmcp\b/i.test(message)) return 'mcp';
  if (/\b(session|resume|compact|harness)\b/i.test(message)) return 'session';
  if (/\b(skill|skills)\b/i.test(message)) return 'skills';
  if (/\b(memory|vector store|recall|forget)\b/i.test(message)) return 'memory';
  if (/\b(renderer|terminal|tty|prompt|resize|scrollback)\b/i.test(message)) return 'renderer';
  if (lower.includes('abort') || lower.includes('interrupted')) return 'runtime';
  return 'unknown';
}

export function formatChatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/NotEnoughCvError|code:\s*11210/i.test(message)) {
    return [
      message,
      '',
      'Provider quota or credit appears insufficient. The Orion Code session is still active; switch model/provider or recharge the provider account, then continue.',
    ].join('\n');
  }
  return message;
}

export function compactMiddle(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  if (maxLength <= 3) return compact.slice(0, maxLength);

  const headLength = Math.ceil((maxLength - 3) * 0.55);
  const tailLength = Math.floor((maxLength - 3) * 0.45);
  return `${compact.slice(0, headLength)}...${compact.slice(-tailLength)}`;
}

export function compactToolArgs(args: Record<string, unknown>, maxLength = 160): string {
  for (const key of [
    'path',
    'file_path',
    'file',
    'cwd',
    'command',
    'pattern',
    'query',
    'url',
    'target',
    'sessionId',
  ]) {
    const value = args[key];
    if (typeof value === 'string') {
      return compactMiddle(value, maxLength);
    }
  }
  const firstString = Object.values(args).find(value => typeof value === 'string');
  if (typeof firstString === 'string') {
    return compactMiddle(firstString, maxLength);
  }
  return '';
}

interface TraceArgsDetails {
  argsSummary: string;
  argsArtifactId?: string;
  argsBytes?: number;
}

function fullToolArgsForTrace(name: string, args: Record<string, unknown>): string {
  if (name === 'exec_command' && typeof args.command === 'string') {
    return `$ ${args.command}`;
  }

  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return compactToolArgs(args, 2048);
  }
}

export function buildTraceArgsDetails(
  projectPath: string | undefined,
  name: string,
  args: Record<string, unknown>
): TraceArgsDetails {
  const argsSummary = compactToolArgs(args);
  const fullArgs = redactTraceText(fullToolArgsForTrace(name, args)).trim();
  const argsBytes = byteLength(fullArgs);

  if (
    !projectPath ||
    !fullArgs ||
    fullArgs === redactTraceText(argsSummary) ||
    argsBytes <= TRACE_ARGS_ARTIFACT_THRESHOLD_BYTES
  ) {
    return { argsSummary };
  }

  const artifact = storeArtifact(projectPath, `${name}-args`, fullArgs, argsBytes);
  return artifact ? { argsSummary, argsArtifactId: artifact.id, argsBytes } : { argsSummary };
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function traceTurnId(turnId: number | string | undefined): string {
  return turnId == null ? `turn-${Date.now()}` : String(turnId);
}

export function compactTraceError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return compactMiddle(message, 240);
}

export function getLastRequestDiagnostics(
  llm: OrionCodeUiRuntime['llm']
): LLMRequestDiagnostics | undefined {
  if (!llm) return undefined;
  const reader = (
    llm as unknown as {
      getLastRequestDiagnostics?: () => LLMRequestDiagnostics;
    }
  ).getLastRequestDiagnostics;
  return typeof reader === 'function' ? reader.call(llm) : undefined;
}

export function appendAssistantNotice(messages: SessionMessage[], notice: string): void {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'assistant' && !message.tool_calls) {
      message.content = message.content ? `${message.content}\n\n${notice}` : notice;
      return;
    }
  }
  messages.push({
    role: 'assistant',
    content: notice,
    timestamp: Date.now(),
  });
}

export function recordTraceEvent(
  events: UiEventSink,
  sessionId: string | undefined,
  event: Omit<SessionTraceEvent, 'sessionId' | 'timestamp'> & { timestamp?: number }
): SessionTraceEvent | null {
  if (!sessionId) return null;
  const goal = goalTraceContext.getStore();
  const traceEvent = appendSessionTraceEvent(sessionId, {
    ...event,
    goalId: goal?.goalId,
    goalRevision: goal?.goalRevision,
    goalInputKind: goal?.goalInputKind,
    goalStopReason: goal?.getStopReason(),
  });
  if (traceEvent) {
    events.traceEventRecorded?.(traceEvent);
  }
  return traceEvent;
}

export function recordProviderTraceEvents(
  events: UiEventSink,
  sessionId: string | undefined,
  turnId: string,
  stats: LoopStats
): void {
  if ((stats.providerRetryCount ?? 0) > 0) {
    recordTraceEvent(events, sessionId, {
      turnId,
      type: 'provider_retry',
      providerRetryCount: stats.providerRetryCount,
      providerRetryDelayMs: stats.providerRetryDelayMs,
      providerRetryErrorTypes: stats.providerRetryErrorTypes,
      providerLastRetryErrorType: stats.providerLastRetryErrorType,
      providerLastRetryStatus: stats.providerLastRetryStatus,
      providerFinalModel: stats.providerFinalModel,
      providerUsingFallback: stats.providerUsingFallback,
    });
  }

  if ((stats.providerFallbackCount ?? 0) > 0 || stats.providerUsingFallback) {
    recordTraceEvent(events, sessionId, {
      turnId,
      type: 'provider_fallback',
      providerFallbackCount: stats.providerFallbackCount,
      providerFallbackFromModel: stats.providerFallbackFromModel,
      providerFallbackToModel: stats.providerFallbackToModel,
      providerFinalModel: stats.providerFinalModel,
      providerUsingFallback: stats.providerUsingFallback,
    });
  }
}

function toHarnessDiagnostics(state: HarnessState): RuntimeHarnessDiagnostics {
  const stats = state.promptAssemblyStats;
  const redactOptional = (value: string | undefined): string | undefined =>
    typeof value === 'string' ? redactTraceText(value) : undefined;
  const redactList = (values: string[] | undefined): string[] | undefined =>
    values?.slice(0, 6).map(redactTraceText);
  return {
    taskEpoch: state.taskEpoch,
    rootObjective: redactOptional(state.rootObjective ?? state.contract?.objective),
    activeInstruction: redactOptional(state.activeInstruction ?? state.contract?.userIntent),
    openQuestions: redactList(state.openQuestions),
    diagnostics: redactList(state.diagnostics?.slice(-6)),
    ledgerSize: state.ledger?.length ?? 0,
    evidenceSize: state.evidenceIndex?.length ?? 0,
    turnSummaryCount: state.turnSummaries?.length ?? 0,
    promptAssembly: stats
      ? {
          modelId: stats.modelId,
          estimatedTokens: stats.estimatedTokens,
          budgetTokens: stats.budgetTokens,
          sections: stats.sections.slice(0, 12),
          includedEvidence: stats.includedEvidence.length,
          omittedEvidence: stats.omittedEvidence.length,
        }
      : undefined,
  };
}

export function emitHarnessDiagnostics(events: UiEventSink, state: HarnessState): void {
  events.harnessDiagnosticsUpdated?.(toHarnessDiagnostics(state));
}

interface GoalTraceContext {
  goalId: string;
  goalRevision: number;
  goalInputKind: import('./goals/types').AgentInputKind;
  getStopReason: () => string | undefined;
}

export const goalTraceContext = new AsyncLocalStorage<GoalTraceContext>();
