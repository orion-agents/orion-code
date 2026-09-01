import type { Message } from '../services/llm';
import { realpathSync } from 'fs';
import { resolve } from 'path';
import { openSessionCheckpointStorageV1, openSessionStorageV1 } from './legacy-thread-materializer';
import type { RuntimeEventEnvelopeV1 } from './protocol/runtime-protocol-v1';
import {
  normalizeSessionModelHistoryV1,
  type SessionHistoryRecoveryDiagnosticV1,
  type SessionHistoryResolvedSourceV1,
} from './session-history-recovery';
import {
  ThreadEventStore,
  type ThreadCheckpointHeadV1,
  type ThreadReadModelHeadV1,
} from './thread-event-store';
import {
  buildThreadSessionIndexV1,
  loadThreadSessionIndexedPageV1,
  loadThreadSessionIndexManifestV1,
  projectTranscriptMessages,
  ThreadSessionIndexError,
  type ThreadSessionIndexHeadV1,
  type ThreadSessionIndexedPageV1,
  type ThreadSessionLatestTurnV1,
  type ThreadSessionTranscriptMessageV1,
  type ThreadSessionTurnCommitV1,
} from './thread-session-index';

export type {
  ThreadSessionTranscriptMessageV1,
  ThreadSessionTurnCommitV1,
} from './thread-session-index';

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

export interface ThreadSessionSnapshotPageV1 {
  readonly version: 1;
  readonly sessionId: string;
  readonly threadId: string;
  readonly cursor: number;
  readonly projectionDigest: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly historySizeBytes: number;
  readonly messageCount: number;
  readonly transcript: {
    readonly items: readonly ThreadSessionTranscriptMessageV1[];
    readonly offset: number;
    readonly nextCursor: string | null;
  };
  readonly readModel: {
    readonly cutoverGeneration: number;
    readonly lastRecordHash: string | null;
    readonly log: ThreadReadModelHeadV1['log'];
  };
  readonly latestTurn?: ThreadSessionLatestTurnV1;
  readonly latestTurnCommit?: ThreadSessionTurnCommitV1;
  readonly latestPlanTurnCommit?: ThreadSessionTurnCommitV1;
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

/**
 * Load one revision-bound transcript page without materializing the complete
 * projection/history. A missing or stale derived index is rebuilt once from
 * the authoritative Thread and then reused by later processes.
 */
export function loadThreadSessionSnapshotPageV1(
  projectPath: string,
  sessionId: string,
  cursor?: string,
  pageSize = 50
): ThreadSessionSnapshotPageV1 | undefined {
  const checkpoint = openSessionCheckpointStorageV1(projectPath, sessionId);
  if (checkpoint) {
    const head = checkpointIndexHead(checkpoint.head);
    try {
      const page = loadThreadSessionIndexedPageV1({
        rootDir: checkpoint.store.rootDir,
        threadId: checkpoint.store.threadId,
        head,
        cursor,
        pageSize,
      });
      if (page) {
        return snapshotPageFromIndex(sessionId, checkpoint.resolution.generation, page);
      }
    } catch (error) {
      if (
        !(error instanceof ThreadSessionIndexError) ||
        error.code !== 'ORION_THREAD_SESSION_INDEX_CORRUPT'
      ) {
        throw error;
      }
    }
  }

  const opened = openSessionStorageV1(projectPath, sessionId);
  if (opened.resolution.kind === 'legacy' || !('store' in opened)) return undefined;
  const captured = captureStableThreadView(
    opened.store,
    opened.resolution.cursor,
    opened.resolution.projectionDigest,
    false
  );
  const head = sessionIndexHead(captured.readModelHead);
  buildThreadSessionIndexV1({
    rootDir: opened.store.rootDir,
    threadId: opened.store.threadId,
    projection: captured.projection,
    events: captured.events,
    head,
  });
  const page = loadThreadSessionIndexedPageV1({
    rootDir: opened.store.rootDir,
    threadId: opened.store.threadId,
    head,
    cursor,
    pageSize,
  });
  if (!page) {
    throw new ThreadSessionViewError(
      `Thread ${opened.store.threadId} transcript index was not published.`
    );
  }
  return snapshotPageFromIndex(sessionId, opened.resolution.generation, page);
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
  const indexHead = sessionIndexHead(readModelHead);
  if (!loadThreadSessionIndexManifestV1(store.rootDir, store.threadId, indexHead)) {
    try {
      buildThreadSessionIndexV1({
        rootDir: store.rootDir,
        threadId: store.threadId,
        projection,
        events,
        head: indexHead,
      });
    } catch {
      // The Session index is derived. Failing to publish it must not make an
      // otherwise verified authoritative Thread unreadable.
    }
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

function sessionIndexHead(readModelHead: ThreadReadModelHeadV1): ThreadSessionIndexHeadV1 {
  return {
    cursor: readModelHead.projection.cursor,
    projectionDigest: readModelHead.projection.digest,
    lastEventTimestamp: readModelHead.lastEventTimestamp,
    lastRecordHash: readModelHead.lastRecordHash,
    log: readModelHead.log,
  };
}

function checkpointIndexHead(head: ThreadCheckpointHeadV1): ThreadSessionIndexHeadV1 {
  return {
    cursor: head.cursor,
    projectionDigest: head.projectionDigest,
    lastEventTimestamp: head.lastEventTimestamp,
    lastRecordHash: head.lastRecordHash,
    log: head.log,
  };
}

function snapshotPageFromIndex(
  sessionId: string,
  cutoverGeneration: number,
  page: ThreadSessionIndexedPageV1
): ThreadSessionSnapshotPageV1 {
  const manifest = page.manifest;
  return deepFreeze({
    version: 1,
    sessionId,
    threadId: manifest.threadId,
    cursor: manifest.cursor,
    projectionDigest: manifest.projectionDigest,
    startedAt: manifest.startedAt,
    updatedAt: manifest.updatedAt,
    historySizeBytes: manifest.log.bytes,
    messageCount: manifest.messageCount,
    transcript: {
      items: page.items,
      offset: page.offset,
      nextCursor: page.nextCursor,
    },
    readModel: {
      cutoverGeneration,
      lastRecordHash: manifest.lastRecordHash,
      log: manifest.log,
    },
    ...(manifest.latestTurn ? { latestTurn: manifest.latestTurn } : {}),
    ...(manifest.latestTurnCommit ? { latestTurnCommit: manifest.latestTurnCommit } : {}),
    ...(manifest.latestPlanTurnCommit
      ? { latestPlanTurnCommit: manifest.latestPlanTurnCommit }
      : {}),
  });
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
    const replay = store.replay(nextCursor, undefined, 'thread_session_view');
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
