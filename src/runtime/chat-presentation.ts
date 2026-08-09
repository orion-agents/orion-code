/**
 * Renderer-independent chat transcript, stream, and tool presentation helpers.
 *
 * The module consumes typed runtime/query events and projects them into UI
 * entries. It has no dependency on commands or the AgentChatController loop.
 */

import type { QueryEvent } from '../framework';
import type { SessionMessage } from '../services/session-storage';
import {
  loadSessionTranscriptMessages,
  readSessionTraceEvents,
  redactTraceText,
} from '../services/session-storage';
import { parseToolResultEnvelope } from '../framework/tool-serializer';
import { storeArtifact, truncateForContext } from '../core/tool-artifacts';
import { formatBytes } from '../services/format';
import type {
  OrionCodeUiRuntime,
  StructuredToolActivity,
  TranscriptEntry,
  UiEventSink,
} from './ui-events';
import {
  formatToolActivityTranscript,
  toolActivityFromFinished,
  toolActivityFromStarted,
} from './ui-view-model';
import { createToolOutputView, DEFAULT_TOOL_OUTPUT_POLICY } from './tool-output-presentation';
import { presentAggregateToolResult } from './aggregate-tool-presenter';
import { byteLength, compactToolArgs, stripAnsi } from './chat-trace';

const LOCAL_FAST_PATH_INLINE_OUTPUT_BYTES = 2048;
const TOOL_TRANSCRIPT_ARG_BUDGET = 512;

function toolStartContent(event: ToolCallEvent): string {
  return formatToolActivityTranscript(
    toolActivityFromStarted(event, compactToolArgs(event.args, TOOL_TRANSCRIPT_ARG_BUDGET))
  );
}

export function toolFinishContent(event: ToolResultEvent): string {
  return formatToolActivityTranscript(
    toolActivityFromFinished(event, compactToolArgs(event.args, TOOL_TRANSCRIPT_ARG_BUDGET))
  );
}

function structuredToolStartActivity(event: ToolCallEvent, seq: number): StructuredToolActivity {
  const command =
    event.name === 'exec_command' && typeof event.args.command === 'string'
      ? event.args.command
      : undefined;
  const safeCommand = command ? redactTraceText(command) : undefined;
  return {
    state: 'running',
    name: event.name,
    detail: command ? '' : redactTraceText(compactToolArgs(event.args, TOOL_TRANSCRIPT_ARG_BUDGET)),
    command: safeCommand,
    body: '',
    seq,
  };
}

export interface ToolEventPresenterOptions {
  projectPath?: string;
  turnId?: string;
}

export function structuredToolFinishActivity(
  event: ToolResultEvent,
  seq: number,
  options: ToolEventPresenterOptions = {}
): StructuredToolActivity {
  const modelVisible = parseToolResultEnvelope(event.modelVisibleResult);
  const durable = parseToolResultEnvelope(event.result);
  const durableOutput = typeof durable.output === 'string' ? durable.output : '';
  const displayOutput =
    typeof modelVisible.output === 'string' ? modelVisible.output : durableOutput;
  const outputBytes = event.outputBytes ?? Buffer.byteLength(durableOutput, 'utf8');
  const aggregatePresentation = presentAggregateToolResult(event.name, durableOutput, outputBytes);
  const aggregate = aggregatePresentation?.view;
  const storedArtifact =
    event.artifactRef ??
    (options.projectPath &&
    durableOutput &&
    (outputBytes > DEFAULT_TOOL_OUTPUT_POLICY.inlineMaxBytes || aggregate)
      ? (storeArtifact(options.projectPath, event.name, durableOutput, outputBytes) ?? undefined)
      : undefined);
  const artifactRef = storedArtifact
    ? { id: storedArtifact.id, outputBytes: storedArtifact.outputBytes }
    : undefined;
  const outputView = createToolOutputView({
    toolName: event.name,
    success: event.success,
    summary: event.summary,
    rawOutput: durableOutput.length <= 64 * 1024 ? durableOutput : displayOutput,
    outputBytes,
    artifactRef,
    callId: event.callId,
    sequence: seq,
    turnId: options.turnId,
    policy: DEFAULT_TOOL_OUTPUT_POLICY,
  });
  if (aggregate) {
    outputView.aggregate = {
      ...aggregate,
      steps: aggregate.steps.map(step => ({ ...step, detailRef: outputView.detailRef })),
    };
  }
  const command =
    event.name === 'exec_command' && typeof event.args.command === 'string'
      ? event.args.command
      : undefined;
  const safeCommand = command ? redactTraceText(command) : undefined;
  return {
    state: event.success ? 'success' : 'error',
    name: event.name,
    detail: command ? '' : redactTraceText(compactToolArgs(event.args, TOOL_TRANSCRIPT_ARG_BUDGET)),
    command: safeCommand,
    duration: `${event.duration}ms`,
    summary: event.summary ? redactTraceText(event.summary.split(/\r?\n/u, 1)[0]) : undefined,
    outputBytes,
    body: redactTraceText(modelVisible.output),
    error: event.error ? redactTraceText(event.error) : undefined,
    seq,
    artifactHint: artifactRef ? `/artifacts show ${artifactRef.id} --full` : undefined,
    callId: event.callId,
    turnId: options.turnId,
    outputView,
  };
}

function isSyntheticCompactContext(content: string): boolean {
  return (
    content.startsWith('[Orion Code Context State v2]') ||
    content.startsWith('[Context Summary]') ||
    content.startsWith('I will continue from this Orion Code Context State') ||
    content.startsWith(
      'I understand the context. I will continue the conversation with this background information.'
    )
  );
}

function sessionToolCallSummaries(message: SessionMessage): Array<{ id: string; content: string }> {
  return (message.tool_calls ?? []).map(call => {
    const args = parseToolCallArgs(call.function.arguments);
    const detail = compactToolArgs(args);
    return {
      id: call.id,
      content: `Requested ${call.function.name}${detail ? ` ${detail}` : ''}`,
    };
  });
}

function parseToolCallArgs(rawArgs: string | undefined): Record<string, unknown> {
  try {
    return rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return rawArgs ? { arguments: rawArgs } : {};
  }
}

function parseSessionToolResult(content: string): {
  success: boolean;
  error?: string;
  summary?: string;
} {
  try {
    const parsed = JSON.parse(content) as { success?: unknown; error?: unknown; summary?: unknown };
    return {
      success: parsed.success === true,
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
      summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
    };
  } catch {
    return { success: false, error: 'Invalid JSON result' };
  }
}

export function removeTrailingUserMessage(runtime: OrionCodeUiRuntime): void {
  const history = runtime.store.getSnapshot().conversationHistory;
  if (history.length === 0) return;

  const lastMsg = history[history.length - 1];
  if (lastMsg?.role === 'user') {
    runtime.store.setState({ conversationHistory: history.slice(0, -1) });
  }
}

function sessionToolResultSummary(
  message: SessionMessage,
  toolCallsById: Map<string, NonNullable<SessionMessage['tool_calls']>[number]>
): string | null {
  if (!message.toolCallId) return null;
  const call = toolCallsById.get(message.toolCallId);
  if (!call) return null;

  const args = parseToolCallArgs(call.function.arguments);
  const detail = compactToolArgs(args);
  const parsed = parseSessionToolResult(message.content);
  const firstLine =
    parsed.summary ||
    `${parsed.success ? '✓' : '✗'} ${call.function.name}${detail ? ` ${detail}` : ''}`;
  return parsed.error ? `${firstLine}\nError: ${parsed.error}` : firstLine;
}

export interface SessionTranscriptEntryOptions {
  includeToolOutputViews?: boolean;
}

export function sessionMessagesToTranscriptEntries(
  sessionId: string,
  options: SessionTranscriptEntryOptions = {}
): TranscriptEntry[] {
  const messages = loadSessionTranscriptMessages(sessionId);
  const resultTraces = options.includeToolOutputViews
    ? readSessionTraceEvents(sessionId).filter(
        trace => trace.type === 'tool_result' && trace.callId
      )
    : [];
  const resultTraceByCallId = new Map(resultTraces.map(trace => [trace.callId!, trace]));
  const sequenceByCallId = new Map<string, number>();
  resultTraces.forEach((trace, index) => {
    if (!sequenceByCallId.has(trace.callId!)) sequenceByCallId.set(trace.callId!, index + 1);
  });
  const entries: TranscriptEntry[] = [];
  const toolCallsById = new Map<string, NonNullable<SessionMessage['tool_calls']>[number]>();
  const completedToolCallIds = new Set<string>();
  let fallbackToolSequence = 0;

  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      toolCallsById.set(call.id, call);
    }
    if (message.role === 'tool' && message.toolCallId) {
      completedToolCallIds.add(message.toolCallId);
    }
  }

  messages.forEach((message, index) => {
    if (isSyntheticCompactContext(message.content)) return;

    const idBase = `session-${sessionId.slice(0, 8)}-${index}`;
    if (message.role === 'user') {
      entries.push({ id: `${idBase}-user`, role: 'user', content: message.content });
      return;
    }

    if (message.role === 'assistant') {
      if (message.content?.trim()) {
        entries.push({ id: `${idBase}-assistant`, role: 'assistant', content: message.content });
      }
      for (const summary of sessionToolCallSummaries(message)) {
        if (!completedToolCallIds.has(summary.id)) {
          entries.push({
            id: `${idBase}-tool-call-${entries.length}`,
            role: 'tool',
            content: summary.content,
          });
        }
      }
      return;
    }

    if (message.role === 'tool') {
      const summary = sessionToolResultSummary(message, toolCallsById);
      const call = message.toolCallId ? toolCallsById.get(message.toolCallId) : undefined;
      const trace = message.toolCallId ? resultTraceByCallId.get(message.toolCallId) : undefined;
      const durable = parseToolResultEnvelope(message.content);
      const modelVisible = message.modelVisibleContent
        ? parseToolResultEnvelope(message.modelVisibleContent)
        : durable;
      const durableOutput = typeof durable.output === 'string' ? durable.output : '';
      const displayOutput =
        typeof modelVisible.output === 'string' ? modelVisible.output : durableOutput;
      const outputBytes =
        trace?.outputBytes ??
        (durable.schemaVersion === 1 ? durable.outputBytes : undefined) ??
        Buffer.byteLength(durableOutput, 'utf8');
      const artifactId = durable.artifactRef?.id ?? trace?.artifactId;
      fallbackToolSequence += 1;
      const sequence = message.toolCallId
        ? (sequenceByCallId.get(message.toolCallId) ?? fallbackToolSequence)
        : fallbackToolSequence;
      const outputView =
        options.includeToolOutputViews && call && message.toolCallId
          ? createToolOutputView({
              toolName: call.function.name,
              success: durable.success,
              summary: durable.summary,
              rawOutput: durableOutput.length <= 64 * 1024 ? durableOutput : displayOutput,
              outputBytes,
              artifactRef: artifactId ? { id: artifactId, outputBytes } : undefined,
              callId: message.toolCallId,
              sequence,
              turnId: trace?.turnId,
              policy: DEFAULT_TOOL_OUTPUT_POLICY,
            })
          : undefined;
      entries.push({
        id: `${idBase}-tool`,
        role: 'tool',
        content:
          summary ??
          (message.toolCallId
            ? `Tool result ${message.toolCallId}\n${message.content}`
            : message.content),
        toolActivity:
          call && message.toolCallId && outputView
            ? {
                state: durable.success ? 'success' : 'error',
                name: call.function.name,
                detail: redactTraceText(
                  compactToolArgs(parseToolCallArgs(call.function.arguments))
                ),
                summary: durable.summary
                  ? redactTraceText(durable.summary.split(/\r?\n/u, 1)[0])
                  : undefined,
                outputBytes,
                body: redactTraceText(
                  durableOutput.length <= 64 * 1024 ? durableOutput : displayOutput
                ),
                error: durable.error ? redactTraceText(durable.error) : undefined,
                duration: typeof trace?.duration === 'number' ? `${trace.duration}ms` : undefined,
                seq: sequence,
                artifactHint: artifactId ? `/artifacts show ${artifactId} --full` : undefined,
                callId: message.toolCallId,
                turnId: trace?.turnId,
                outputView,
              }
            : undefined,
      });
      return;
    }

    if (message.role === 'system') {
      entries.push({ id: `${idBase}-system`, role: 'system', content: message.content });
    }
  });

  return entries;
}

export interface AssistantStreamPresenter {
  appendChunk(chunk: string): void;
  closeSegment(): void;
  discardSegment(): void;
  ensureMessage(content: string): void;
  replaceMessage(content: string): void;
}

export function createAssistantStreamPresenter(
  events: UiEventSink,
  abortSignal?: AbortSignal
): AssistantStreamPresenter {
  let activeSegmentText = '';
  let activeEntryId: string | null = null;

  const ensureLiveEntry = (): string | null => {
    if (abortSignal?.aborted || !activeSegmentText) return null;
    if (activeEntryId) {
      events.update(activeEntryId, { content: activeSegmentText });
      return activeEntryId;
    }

    activeEntryId = events.append({
      role: 'assistant',
      content: activeSegmentText,
      live: true,
    });
    return activeEntryId;
  };

  const flushSegment = (): void => {
    if (abortSignal?.aborted) {
      if (activeEntryId) events.remove(activeEntryId);
      activeEntryId = null;
      activeSegmentText = '';
      return;
    }

    const entryId = ensureLiveEntry();
    if (!entryId) return;
    events.finalize(entryId);
    activeEntryId = null;
    activeSegmentText = '';
  };

  return {
    appendChunk(chunk: string): void {
      if (abortSignal?.aborted || !chunk) return;
      activeSegmentText += chunk;
      ensureLiveEntry();
    },

    closeSegment(): void {
      flushSegment();
    },

    discardSegment(): void {
      if (activeEntryId) events.remove(activeEntryId);
      activeEntryId = null;
      activeSegmentText = '';
    },

    ensureMessage(content: string): void {
      if (abortSignal?.aborted || !content || activeSegmentText.length > 0) return;
      activeSegmentText = content;
      ensureLiveEntry();
    },

    replaceMessage(content: string): void {
      if (abortSignal?.aborted || !content) return;
      activeSegmentText = content;
      ensureLiveEntry();
    },
  };
}

export type ToolCallEvent = Extract<QueryEvent, { type: 'tool_call' }>;
export type ToolResultEvent = Extract<QueryEvent, { type: 'tool_result' }>;

export interface LocalFastPathAction {
  tool: string;
  args: Record<string, unknown>;
  label: string;
}

export class LocalFastPathBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalFastPathBlockedError';
  }
}

export function parseLocalFastPath(input: string): LocalFastPathAction | null {
  const text = input.trim();
  if (/^git\s+status$/i.test(text)) {
    return { tool: 'git_status', args: {}, label: 'git status' };
  }

  const readMatch = /^(?:read|读取)\s+(.+)$/i.exec(text);
  const readTarget = readMatch?.[1]?.trim();
  const looksLikePath =
    Boolean(readTarget) &&
    !/\s/.test(readTarget!) &&
    (/[/\\.]/.test(readTarget!) || readTarget!.startsWith('~'));
  if (readTarget && looksLikePath) {
    return { tool: 'read_file', args: { path: readTarget }, label: `read ${readTarget}` };
  }

  const grepMatch = /^(?:grep|搜索)\s+(.+)$/i.exec(text);
  if (grepMatch?.[1]?.trim()) {
    return {
      tool: 'grep',
      args: { pattern: grepMatch[1].trim() },
      label: `grep ${grepMatch[1].trim()}`,
    };
  }

  const runTestMatch = /^(?:run\s+test|运行测试)\s*[:：]\s*(.+)$/i.exec(text);
  if (runTestMatch?.[1]?.trim()) {
    return {
      tool: 'exec_command',
      args: { command: runTestMatch[1].trim() },
      label: `run test: ${runTestMatch[1].trim()}`,
    };
  }

  return null;
}

export function formatLocalFastPathAssistantContent(
  action: LocalFastPathAction,
  rawResult: string,
  projectPath: string
): { content: string; artifactRef?: { id: string; outputBytes: number } } {
  const envelope = parseToolResultEnvelope(rawResult);
  const rawOutput = typeof envelope.output === 'string' ? envelope.output : '';
  const output = rawOutput.trim();
  const summary = envelope.summary || `${action.tool} ${envelope.success ? 'completed' : 'failed'}`;
  const lines = [
    envelope.success
      ? `Local fast path completed ${action.label}.`
      : `Local fast path failed ${action.label}.`,
    '',
    summary,
  ];
  if (!envelope.success && envelope.error) {
    lines.push(`Error: ${envelope.error}`);
  }

  if (!output) {
    return { content: lines.join('\n'), artifactRef: envelope.artifactRef };
  }

  let artifactRef = envelope.artifactRef;
  let preview = output;
  const outputBytes = envelope.outputBytes ?? byteLength(rawOutput);
  if (byteLength(rawOutput) > LOCAL_FAST_PATH_INLINE_OUTPUT_BYTES) {
    if (!artifactRef) {
      const artifact = storeArtifact(projectPath, action.tool, rawOutput, outputBytes);
      artifactRef = artifact ? { id: artifact.id, outputBytes: artifact.outputBytes } : undefined;
    }
    preview = truncateForContext(output, LOCAL_FAST_PATH_INLINE_OUTPUT_BYTES);
  }

  if (artifactRef) {
    lines.push(
      '',
      `Full output: /artifacts show ${artifactRef.id} --full (${formatBytes(artifactRef.outputBytes)})`
    );
  }
  lines.push('', 'Preview:', preview);
  return { content: lines.join('\n'), artifactRef };
}

export interface ToolEventPresenter {
  start(event: ToolCallEvent): void;
  finish(event: ToolResultEvent): void;
  finalizePendingAsSkipped(reason?: string): void;
}

export function createToolEventPresenter(
  events: UiEventSink,
  options: ToolEventPresenterOptions = {}
): ToolEventPresenter {
  const runningToolEntries = new Map<
    string,
    {
      entryId: string;
      name: string;
      args: Record<string, unknown>;
      sequence: number;
      batchCount?: number;
      batchIndex?: number;
    }
  >();
  let toolSequenceCounter = 0;

  return {
    start(event: ToolCallEvent): void {
      const seq = ++toolSequenceCounter;
      const entryId = events.append({
        role: 'tool',
        title: 'tool',
        content: toolStartContent(event),
        toolActivity: structuredToolStartActivity(event, seq),
      });
      runningToolEntries.set(event.callId, {
        entryId,
        name: event.name,
        args: event.args,
        sequence: seq,
        batchCount: event.batchCount,
        batchIndex: event.batchIndex,
      });
      events.toolStarted?.({
        callId: event.callId,
        name: event.name,
        args: event.args,
        sequence: seq,
        batchCount: event.batchCount,
        batchIndex: event.batchIndex,
      });
    },

    finish(event: ToolResultEvent): void {
      const content = toolFinishContent(event);
      const stored = runningToolEntries.get(event.callId);
      const seq = stored?.sequence ?? ++toolSequenceCounter;
      const toolActivity = structuredToolFinishActivity(event, seq, options);

      if (stored) {
        events.finalize(stored.entryId, {
          role: event.success ? 'tool' : 'error',
          title: 'tool',
          content,
          toolActivity,
        });
        runningToolEntries.delete(event.callId);
      } else {
        const entryId = events.append({
          role: event.success ? 'tool' : 'error',
          title: 'tool',
          content,
          toolActivity,
        });
        events.finalize(entryId);
      }

      events.toolFinished?.({
        callId: event.callId,
        name: event.name,
        args: event.args,
        success: event.success,
        duration: event.duration,
        summary: event.summary,
        error: event.error,
        outputBytes: event.outputBytes,
        artifactRef: toolActivity.outputView?.detailRef?.artifactId
          ? {
              id: toolActivity.outputView.detailRef.artifactId,
              outputBytes: toolActivity.outputView.detailRef.outputBytes,
            }
          : event.artifactRef,
        externalAssertion: event.externalAssertion,
        sequence: seq,
        batchCount: event.batchCount,
        batchIndex: event.batchIndex,
      });
    },

    finalizePendingAsSkipped(reason = 'permission denied'): void {
      for (const [callId, entry] of runningToolEntries) {
        events.finalize(entry.entryId, {
          role: 'tool',
          title: 'tool',
          content: `Skipped · ${reason}`,
          toolActivity: {
            state: 'skipped',
            name: entry.name,
            detail: '',
            body: '',
            error: reason,
            seq: entry.sequence,
          },
        });
        events.toolFinished?.({
          callId,
          name: entry.name,
          args: entry.args,
          success: false,
          skipped: true,
          duration: 0,
          error: reason,
          sequence: entry.sequence,
          batchCount: entry.batchCount,
          batchIndex: entry.batchIndex,
        });
      }
      runningToolEntries.clear();
    },
  };
}

export async function captureConsoleOutput<T>(
  fn: () => Promise<T> | T
): Promise<{ result: T; output: string }> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const capture = (...args: unknown[]) => {
    lines.push(
      stripAnsi(args.map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
    );
  };

  console.log = capture;
  console.error = capture;
  console.warn = capture;
  try {
    const result = await fn();
    return { result, output: lines.join('\n').trim() };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }
}
