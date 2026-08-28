import type { Message } from '../services/llm';
import { realpathSync } from 'fs';
import { resolve } from 'path';
import { openSessionStorageV1 } from './legacy-thread-materializer';
import type { RuntimeEventEnvelopeV1 } from './protocol/runtime-protocol-v1';
import {
  normalizeSessionModelHistoryV1,
  type SessionHistoryRecoveryDiagnosticV1,
  type SessionHistoryResolvedSourceV1,
} from './session-history-recovery';
import { ThreadEventStore, type ThreadReadModelHeadV1 } from './thread-event-store';
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

export interface ThreadSessionTurnCommitV1 {
  readonly seq: number;
  readonly receipt: string;
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
  readonly readModel: {
    readonly cutoverGeneration: number;
    readonly lastRecordHash: string | null;
    readonly log: ThreadReadModelHeadV1['log'];
  };
}

/** Read-only compatibility view over the authoritative v2 Thread facts. */
export interface ThreadSessionViewV1 extends ThreadSessionSummaryV1 {
  readonly modelHistory: readonly Message[];
  readonly modelHistorySource: SessionHistoryResolvedSourceV1;
  readonly diagnostics: readonly SessionHistoryRecoveryDiagnosticV1[];
  readonly latestTurnCommit?: ThreadSessionTurnCommitV1;
  readonly latestPlanTurnCommit?: ThreadSessionTurnCommitV1;
}

/**
 * A verified, process-local hand-off from Session restore into the sole
 * OrionRuntime owner. The mutable Store is intentionally not serialized or
 * recursively frozen; the outer receipt binds it to the canonical project,
 * Session, Thread and projection edge that were validated before the previous
 * Runtime is torn down.
 */
export interface ThreadSessionRuntimeActivationV1 {
  readonly version: 1;
  readonly projectPath: string;
  readonly sessionId: string;
  readonly threadId: string;
  readonly cursor: number;
  readonly projectionDigest: string;
  readonly cutoverGeneration: number;
  readonly store: ThreadEventStore;
  /** Cursor-bound view captured with the same Store; Web may reuse it once for baseline. */
  readonly view?: ThreadSessionViewV1;
}

export interface OpenThreadSessionViewV1 {
  readonly view: ThreadSessionViewV1;
  readonly runtimeActivation: ThreadSessionRuntimeActivationV1;
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
  return openThreadSessionViewV1(projectPath, sessionId)?.view;
}

/** Capture the restore view and retain its already-verified Store for Runtime activation. */
export function openThreadSessionViewV1(
  projectPath: string,
  sessionId: string
): OpenThreadSessionViewV1 | undefined {
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

  const view = deepFreeze({
    ...captured.summary,
    modelHistory: recovery.messages,
    modelHistorySource: recovery.source,
    diagnostics: recovery.diagnostics,
    ...(captured.latestTurnCommit ? { latestTurnCommit: captured.latestTurnCommit } : {}),
    ...(captured.latestPlanTurnCommit
      ? { latestPlanTurnCommit: captured.latestPlanTurnCommit }
      : {}),
  });
  return Object.freeze({
    view,
    runtimeActivation: createRuntimeActivation(projectPath, sessionId, captured, view),
  });
}

/**
 * Open only the verified Runtime hand-off. This is used after an atomic legacy
 * cutover, where the provider history was already captured from the legacy
 * source and rebuilding the complete transcript view would be duplicate work.
 */
export function openThreadSessionRuntimeActivationV1(
  projectPath: string,
  sessionId: string
): ThreadSessionRuntimeActivationV1 | undefined {
  const opened = openSessionStorageV1(projectPath, sessionId);
  if (opened.resolution.kind === 'legacy' || !('store' in opened)) return undefined;
  const projection = opened.store.loadProjection();
  return Object.freeze({
    version: 1,
    projectPath: realpathSync(resolve(projectPath)),
    sessionId,
    threadId: opened.resolution.threadId,
    cursor: projection.cursor,
    projectionDigest: projection.digest,
    cutoverGeneration: opened.resolution.generation,
    store: opened.store,
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
      readonly latestTurnCommit?: ThreadSessionTurnCommitV1;
      readonly latestPlanTurnCommit?: ThreadSessionTurnCommitV1;
      readonly store: ThreadEventStore;
      readonly cutoverGeneration: number;
    }
  | undefined {
  const opened = openSessionStorageV1(projectPath, sessionId);
  const { resolution } = opened;
  if (resolution.kind === 'legacy' || !('store' in opened)) return undefined;

  const { store } = opened;
  const { projection, events, durableHistory, readModelHead } = captureStableThreadView(
    store,
    resolution.cursor,
    resolution.projectionDigest,
    includeDurableHistory
  );
  const transcriptMessages = projectTranscriptMessages(projection.items, events);
  const startedAt = events[0]?.timestamp ?? 0;
  const updatedAt = events.at(-1)?.timestamp ?? startedAt;
  const turnCommits = Object.values(projection.turns)
    .flatMap(turn => (turn.commit ? [{ seq: turn.commit.seq, receipt: turn.commit.receipt }] : []))
    .sort((left, right) => left.seq - right.seq);
  const latestTurnCommit = turnCommits.at(-1);
  const latestPlanTurnCommit = [...turnCommits]
    .reverse()
    .find(commit => turnCommitContainsPlan(commit.receipt));
  return {
    summary: deepFreeze({
      version: 1,
      sessionId,
      threadId: resolution.threadId,
      cursor: projection.cursor,
      projectionDigest: projection.digest,
      startedAt,
      updatedAt,
      historySizeBytes: readModelHead.log.bytes,
      messageCount: transcriptMessages.length,
      transcriptMessages,
      readModel: {
        cutoverGeneration: resolution.generation,
        lastRecordHash: readModelHead.lastRecordHash,
        log: readModelHead.log,
      },
    }),
    durableHistory,
    store,
    cutoverGeneration: resolution.generation,
    ...(latestTurnCommit ? { latestTurnCommit: Object.freeze(latestTurnCommit) } : {}),
    ...(latestPlanTurnCommit ? { latestPlanTurnCommit: Object.freeze(latestPlanTurnCommit) } : {}),
  };
}

function createRuntimeActivation(
  projectPath: string,
  sessionId: string,
  captured: {
    readonly summary: ThreadSessionSummaryV1;
    readonly store: ThreadEventStore;
    readonly cutoverGeneration: number;
  },
  view: ThreadSessionViewV1
): ThreadSessionRuntimeActivationV1 {
  return Object.freeze({
    version: 1,
    projectPath: realpathSync(resolve(projectPath)),
    sessionId,
    threadId: captured.summary.threadId,
    cursor: captured.summary.cursor,
    projectionDigest: captured.summary.projectionDigest,
    cutoverGeneration: captured.cutoverGeneration,
    store: captured.store,
    view,
  });
}

function turnCommitContainsPlan(receipt: string): boolean {
  try {
    const parsed = JSON.parse(receipt) as Record<string, unknown>;
    return typeof parsed.planReceipt === 'string' && parsed.planReceipt.length > 0;
  } catch {
    return false;
  }
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
  readonly readModelHead: ThreadReadModelHeadV1;
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
    const readModelHead = store.captureReadModelHead();
    if (
      readModelHead.projection.cursor === projection.cursor &&
      readModelHead.projection.digest === projection.digest
    ) {
      return { projection, events, durableHistory, readModelHead };
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

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
