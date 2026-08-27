import { statSync } from 'fs';

import { getProjectThreadsV2Dir } from '../product/paths';
import type { Message } from '../services/llm';
import { resolveSessionStorageV1 } from './legacy-thread-materializer';
import type { RuntimeEventEnvelopeV1 } from './protocol/runtime-protocol-v1';
import {
  normalizeSessionModelHistoryV1,
  type SessionHistoryRecoveryDiagnosticV1,
  type SessionHistoryResolvedSourceV1,
} from './session-history-recovery';
import { ThreadEventStore } from './thread-event-store';
import type { ItemProjectionV1 } from './thread-projection';

export interface ThreadSessionTranscriptMessageV1 {
  readonly role: Message['role'];
  readonly content: string;
  readonly timestamp: number;
  readonly modelVisibleContent?: string;
  readonly toolCallId?: string;
  readonly tool_calls?: NonNullable<Message['tool_calls']>;
  readonly appliedSkills?: readonly string[];
}

/** Metadata/transcript projection that never needs to decode model history. */
export interface ThreadSessionSummaryV1 {
  readonly version: 1;
  readonly sessionId: string;
  readonly threadId: string;
  readonly cursor: number;
  readonly projectionDigest: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly historySizeBytes: number;
  readonly messageCount: number;
  readonly transcriptMessages: readonly ThreadSessionTranscriptMessageV1[];
}

/** Read-only compatibility view over the authoritative v2 Thread facts. */
export interface ThreadSessionViewV1 extends ThreadSessionSummaryV1 {
  readonly modelHistory: readonly Message[];
  readonly modelHistorySource: SessionHistoryResolvedSourceV1;
  readonly diagnostics: readonly SessionHistoryRecoveryDiagnosticV1[];
}

export class ThreadSessionViewError extends Error {
  readonly code = 'ORION_THREAD_SESSION_VIEW_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'ThreadSessionViewError';
  }
}

/**
 * Resolve a Session identity through the cutover index and project its Thread
 * facts without writing a legacy JSONL mirror. The cutover index remains the
 * sole generation switch. Invalid authoritative model history is recovered
 * from durable transcript facts with explicit diagnostics; invalid Thread
 * identity, replay, or projection data still fails closed.
 */
export function loadThreadSessionViewV1(
  projectPath: string,
  sessionId: string
): ThreadSessionViewV1 | undefined {
  const captured = captureThreadSessionV1(projectPath, sessionId, true);
  if (!captured) return undefined;

  const transcriptHistory = captured.summary.transcriptMessages.map(
    transcriptMessageToModelMessage
  );
  let recovery;
  if (captured.durableHistory) {
    try {
      recovery = normalizeSessionModelHistoryV1(
        parseModelHistory(captured.durableHistory),
        'turn_commit'
      );
    } catch {
      const transcriptRecovery = normalizeSessionModelHistoryV1(transcriptHistory, 'transcript');
      recovery = {
        ...transcriptRecovery,
        diagnostics: [
          {
            code: 'authoritative_history_invalid' as const,
            message:
              'The authoritative model history was invalid; Orion recovered from durable transcript facts.',
          },
          ...transcriptRecovery.diagnostics,
        ],
      };
    }
  } else {
    recovery = normalizeSessionModelHistoryV1(transcriptHistory, 'transcript');
  }

  return deepFreeze({
    ...captured.summary,
    modelHistory: recovery.messages,
    modelHistorySource: recovery.source,
    diagnostics: recovery.diagnostics,
  });
}

/** Load list/picker metadata without allowing model-history damage to fan out. */
export function loadThreadSessionSummaryV1(
  projectPath: string,
  sessionId: string
): ThreadSessionSummaryV1 | undefined {
  return captureThreadSessionV1(projectPath, sessionId, false)?.summary;
}

function captureThreadSessionV1(
  projectPath: string,
  sessionId: string,
  includeDurableHistory: boolean
):
  | {
      readonly summary: ThreadSessionSummaryV1;
      readonly durableHistory: readonly unknown[] | undefined;
    }
  | undefined {
  const resolution = resolveSessionStorageV1(projectPath, sessionId);
  if (resolution.kind === 'legacy') return undefined;

  const store = new ThreadEventStore(getProjectThreadsV2Dir(projectPath), resolution.threadId, {
    maxReplayEvents: Math.max(10_000, resolution.cursor),
  });
  const { projection, events, durableHistory } = captureStableThreadView(
    store,
    resolution.cursor,
    resolution.projectionDigest,
    includeDurableHistory
  );
  const transcriptMessages = projectTranscriptMessages(projection.items, events);
  const startedAt = events[0]?.timestamp ?? 0;
  const updatedAt = events.at(-1)?.timestamp ?? startedAt;
  let historySizeBytes: number;
  try {
    historySizeBytes = statSync(store.logPath).size;
  } catch (error) {
    throw new ThreadSessionViewError(
      `Thread ${resolution.threadId} event log size is unavailable: ${errorMessage(error)}`
    );
  }

  return {
    summary: deepFreeze({
      version: 1,
      sessionId,
      threadId: resolution.threadId,
      cursor: projection.cursor,
      projectionDigest: projection.digest,
      startedAt,
      updatedAt,
      historySizeBytes,
      messageCount: transcriptMessages.length,
      transcriptMessages,
    }),
    durableHistory,
  };
}

function captureStableThreadView(
  store: ThreadEventStore,
  minimumCursor: number,
  minimumProjectionDigest: string,
  includeDurableHistory: boolean
): {
  readonly projection: ReturnType<ThreadEventStore['loadProjection']>;
  readonly events: readonly RuntimeEventEnvelopeV1[];
  readonly durableHistory: readonly unknown[] | undefined;
} {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const projection = store.loadProjection();
    if (projection.cursor < minimumCursor) {
      throw new ThreadSessionViewError(
        `Thread ${store.threadId} moved behind its cutover resolution cursor.`
      );
    }
    if (projection.cursor === minimumCursor && projection.digest !== minimumProjectionDigest) {
      throw new ThreadSessionViewError(
        `Thread ${store.threadId} projection changed without advancing its cursor.`
      );
    }
    const events = replayAll(store, projection.cursor);
    const durableHistory = includeDurableHistory
      ? store.loadAuthoritativeModelHistory()
      : undefined;
    if (store.getCursor() === projection.cursor) {
      return { projection, events, durableHistory };
    }
  }
  throw new ThreadSessionViewError(
    `Thread ${store.threadId} remained active while its Session view was being captured.`
  );
}

function replayAll(store: ThreadEventStore, cursor: number): readonly RuntimeEventEnvelopeV1[] {
  if (cursor === 0) return [];
  const events: RuntimeEventEnvelopeV1[] = [];
  let nextCursor = 0;
  while (nextCursor < cursor) {
    const replay = store.replay(nextCursor);
    const page = replay.events.filter(event => event.seq <= cursor);
    if (page.length === 0) {
      throw new ThreadSessionViewError(
        `Thread ${store.threadId} replay stopped at ${nextCursor}/${cursor}.`
      );
    }
    events.push(...page);
    nextCursor = page.at(-1)?.seq ?? nextCursor;
  }
  if (events.length !== cursor) {
    throw new ThreadSessionViewError(
      `Thread ${store.threadId} replay returned ${events.length}/${cursor} events.`
    );
  }
  return events;
}

function projectTranscriptMessages(
  items: Readonly<Record<string, ItemProjectionV1>>,
  events: readonly RuntimeEventEnvelopeV1[]
): readonly ThreadSessionTranscriptMessageV1[] {
  const timestamps = new Map<string, number>();
  for (const event of events) {
    if (!event.itemId || !isItemTerminalEvent(event)) continue;
    timestamps.set(event.itemId, event.timestamp);
  }

  return Object.values(items)
    .filter(
      item => item.kind === 'message' && item.status !== 'started' && isMessageRole(item.role)
    )
    .sort((left, right) => left.startedSeq - right.startedSeq)
    .map(item => {
      const legacy = parseLegacyTranscriptReceipt(item.receipt);
      if (legacy) return legacy;
      return {
        role: item.role as Message['role'],
        content: item.content ?? item.summary ?? item.error ?? '',
        timestamp: timestamps.get(item.itemId) ?? 0,
      };
    });
}

function parseLegacyTranscriptReceipt(
  receipt: string | undefined
): ThreadSessionTranscriptMessageV1 | undefined {
  if (!receipt) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(receipt);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.legacyRecord)) return undefined;
  const record = parsed.legacyRecord;
  if (!isMessageRole(record.role) || typeof record.content !== 'string') return undefined;
  if (!Number.isFinite(record.timestamp)) return undefined;

  const toolCalls = parseToolCalls(record.tool_calls);
  const appliedSkills = Array.isArray(record.appliedSkills)
    ? record.appliedSkills.filter((value): value is string => typeof value === 'string')
    : undefined;
  return {
    role: record.role,
    content: record.content,
    timestamp: record.timestamp as number,
    ...(typeof record.modelVisibleContent === 'string'
      ? { modelVisibleContent: record.modelVisibleContent }
      : {}),
    ...(typeof record.toolCallId === 'string' ? { toolCallId: record.toolCallId } : {}),
    ...(toolCalls ? { tool_calls: toolCalls } : {}),
    ...(appliedSkills ? { appliedSkills } : {}),
  };
}

function parseModelHistory(history: readonly unknown[]): Message[] {
  return history.map((value, index) => {
    if (!isRecord(value) || !isMessageRole(value.role) || typeof value.content !== 'string') {
      throw new ThreadSessionViewError(`Thread model history message ${index} is invalid.`);
    }
    const toolCalls = parseToolCalls(value.tool_calls);
    if (value.tool_calls !== undefined && !toolCalls) {
      throw new ThreadSessionViewError(`Thread model history tool_calls ${index} is invalid.`);
    }
    if (value.tool_call_id !== undefined && typeof value.tool_call_id !== 'string') {
      throw new ThreadSessionViewError(`Thread model history tool_call_id ${index} is invalid.`);
    }
    return {
      role: value.role,
      content: value.content,
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
      ...(typeof value.tool_call_id === 'string' ? { tool_call_id: value.tool_call_id } : {}),
    };
  });
}

function transcriptMessageToModelMessage(message: ThreadSessionTranscriptMessageV1): Message {
  return {
    role: message.role,
    content: message.modelVisibleContent ?? message.content,
    ...(message.tool_calls ? { tool_calls: structuredClone(message.tool_calls) } : {}),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
  };
}

function parseToolCalls(value: unknown): NonNullable<Message['tool_calls']> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const result: NonNullable<Message['tool_calls']> = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      item.type !== 'function' ||
      !isRecord(item.function) ||
      typeof item.function.name !== 'string' ||
      typeof item.function.arguments !== 'string'
    ) {
      return undefined;
    }
    result.push({
      id: item.id,
      type: 'function',
      function: { name: item.function.name, arguments: item.function.arguments },
    });
  }
  return result;
}

function isItemTerminalEvent(event: RuntimeEventEnvelopeV1): boolean {
  return (
    event.payload.type === 'item.completed' ||
    event.payload.type === 'item.failed' ||
    event.payload.type === 'item.interrupted' ||
    event.payload.type === 'item.indeterminate'
  );
}

function isMessageRole(value: unknown): value is Message['role'] {
  return value === 'system' || value === 'user' || value === 'assistant' || value === 'tool';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
