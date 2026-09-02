import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  truncateSync,
  writeSync,
} from 'fs';
import { dirname, join } from 'path';

import { atomicWriteFileSync } from '../services/atomic-write';
import { withFileLockSync } from '../services/file-lock';
import { canonicalRuntimeJson, digestRuntimeValue } from './protocol/canonical';
import {
  assertRuntimeEventEnvelopeV1,
  createRuntimeId,
  isRuntimeId,
  type RuntimeEventEnvelopeV1,
  type RuntimeEventV1,
} from './protocol/runtime-protocol-v1';
import {
  advanceThreadProjection,
  projectThreadEvents,
  verifyThreadProjectionDigest,
  type ThreadProjectionV1,
} from './thread-projection';
import { advanceThreadSessionIndexV1, type ThreadSessionIndexHeadV1 } from './thread-session-index';
import type {
  CompactAuthoritativeSourceV1,
  CompactCheckpointCommitReceiptV1,
  CompactCheckpointPointerV1,
  CompactCompareAndCommitInputV1,
  CompactCompareAndCommitResultV1,
  CompactRuntimeEventV1,
} from './compact-transaction';

export interface AppendRuntimeEventV1<T extends RuntimeEventV1 = RuntimeEventV1> {
  readonly turnId?: string;
  readonly stepId?: string;
  readonly itemId?: string;
  readonly timestamp?: number;
  readonly payload: T;
}

export interface ThreadEventReplayV1 {
  readonly events: readonly RuntimeEventEnvelopeV1[];
  readonly fromCursor: number;
  readonly nextCursor: number;
  readonly hasMore: boolean;
}

export type ThreadEventReplayReasonV1 =
  | 'direct'
  | 'capability_receipt_journal'
  | 'durable_tool_receipt'
  | 'legacy_materializer'
  | 'runtime_diagnostics_legacy'
  | 'subagent_receipt_journal'
  | 'thread_session_view'
  | 'turn_commit_journal'
  | 'ui_gap_recovery'
  | 'ui_initial_history';

export interface ThreadEventCommitV1 {
  readonly events: readonly RuntimeEventEnvelopeV1[];
  readonly projection: ThreadProjectionV1;
}

export interface ThreadLogIdentityV1 {
  readonly bytes: number;
  readonly device: string;
  readonly inode: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

export interface ThreadReadModelHeadV1 {
  readonly projection: ThreadProjectionV1;
  readonly lastEventTimestamp: number;
  readonly lastRecordHash: string | null;
  readonly log: ThreadLogIdentityV1;
}

export interface ThreadCheckpointHeadV1 {
  readonly cursor: number;
  readonly projectionDigest: string;
  readonly lastEventTimestamp: number;
  readonly lastRecordHash: string | null;
  readonly log: ThreadLogIdentityV1;
  readonly verifiedPrefixes: readonly ThreadVerifiedPrefixV1[];
}

export interface ThreadVerifiedPrefixV1 {
  readonly cursor: number;
  readonly eventDigest: string;
  readonly projectionDigest: string;
}

/**
 * Crash-safe derived checkpoint for opening a Thread in a fresh process.
 *
 * The JSONL remains authoritative. This receipt is accepted only while its
 * exact file identity and independently digested projection still match; any
 * mismatch falls back to the full hash-chain verification path.
 */
export interface ThreadHeadV1 {
  readonly version: 1;
  readonly generation: number;
  readonly threadId: string;
  readonly cursor: number;
  readonly projectionDigest: string;
  readonly lastEventTimestamp: number;
  readonly lastRecordHash: string | null;
  readonly safeByteLength: number;
  readonly discardedTailBytes: number;
  readonly eventIds: readonly string[];
  readonly verifiedPrefixes: readonly ThreadVerifiedPrefixV1[];
  readonly log: ThreadLogIdentityV1;
  readonly digest: string;
}

interface StoredCompactCheckpointV1 {
  readonly version: 1;
  readonly threadId: string;
  readonly checkpointId: string;
  readonly checkpoint: unknown;
  readonly checkpointDigest: string;
  readonly modelVisibleHistory: readonly unknown[];
  readonly nextModelVisibleHistoryDigest: string;
  readonly commit: CompactCheckpointCommitReceiptV1;
  readonly digest: string;
}

interface StoredCompactStateV1 {
  readonly version: 1;
  readonly threadId: string;
  /** Cursor of compact.started at the point the pointer became authoritative. */
  readonly installedAtCursor: number;
  readonly pointer: CompactCheckpointPointerV1;
  readonly history: readonly unknown[];
  readonly historyDigest: string;
  readonly taskContext: unknown;
  readonly taskContextDigest: string;
  readonly taskContextRevision: number;
  readonly commit: CompactCheckpointCommitReceiptV1;
  readonly digest: string;
}

interface DurableTurnStateV1 {
  readonly eventSeq: number;
  readonly history: readonly unknown[];
  readonly historyDigest: string;
  readonly taskContext: unknown;
  readonly taskContextDigest: string;
  readonly taskContextRevision: number;
}

export type ThreadEventStoreBoundaryV1 =
  | 'before_log_write'
  | 'after_log_write'
  | 'after_log_flush'
  | 'before_projection_write'
  | 'after_projection_write';

export interface ThreadEventStoreOptionsV1 {
  readonly maxLogBytes?: number;
  readonly maxReplayEvents?: number;
  readonly lockWaitMs?: number;
  readonly clock?: () => number;
  readonly idFactory?: () => string;
  readonly onBoundary?: (
    boundary: ThreadEventStoreBoundaryV1,
    context: { readonly threadId: string; readonly lastSeq: number }
  ) => void;
  /** Read-path observability used by performance tests and diagnostics. */
  readonly onLogScan?: (context: {
    readonly threadId: string;
    readonly bytes: number;
    readonly events: number;
  }) => void;
}

export interface ThreadEventStorePerformanceCountersV1 {
  readonly logScans: number;
  readonly bytesScanned: number;
  readonly eventsScanned: number;
  readonly scanReasons: Readonly<Record<string, number>>;
}

interface StoredThreadEventRecordV1 {
  readonly version: 1;
  readonly previousHash: string | null;
  readonly hash: string;
  readonly event: RuntimeEventEnvelopeV1;
}

interface ScannedThreadEventLogV1 {
  readonly records: readonly StoredThreadEventRecordV1[];
  readonly events: readonly RuntimeEventEnvelopeV1[];
  readonly safeByteLength: number;
  readonly discardedTailBytes: number;
}

interface CachedThreadHeadV1 {
  readonly generation: number;
  readonly logFingerprint: string;
  readonly log: ThreadLogIdentityV1;
  readonly projectionFingerprint?: string;
  readonly scan?: ScannedThreadEventLogV1;
  readonly projection: ThreadProjectionV1;
  readonly lastEventTimestamp: number;
  readonly lastRecordHash: string | null;
  readonly safeByteLength: number;
  readonly discardedTailBytes: number;
  readonly eventIds: readonly string[];
  readonly eventIdSet: ReadonlySet<string>;
  readonly verifiedPrefixes: readonly ThreadVerifiedPrefixV1[];
}

export class ThreadEventStoreError extends Error {
  constructor(
    readonly code:
      | 'ORION_THREAD_EVENT_CORRUPT'
      | 'ORION_THREAD_EVENT_LIMIT'
      | 'ORION_THREAD_EVENT_CURSOR'
      | 'ORION_THREAD_EVENT_IDENTITY'
      | 'ORION_THREAD_COMPACT_INVALID'
      | 'ORION_THREAD_COMPACT_CONFLICT',
    message: string,
    readonly offset?: number
  ) {
    super(message);
    this.name = 'ThreadEventStoreError';
  }
}

const DEFAULT_MAX_LOG_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_REPLAY_EVENTS = 10_000;
const DEFAULT_LOCK_WAIT_MS = 10_000;
const threadEventStorePerformance = {
  logScans: 0,
  bytesScanned: 0,
  eventsScanned: 0,
  scanReasons: {} as Record<string, number>,
};

/** Process-local monotonic read counters for diagnostics and switch budgets. */
export function threadEventStorePerformanceCountersV1(): ThreadEventStorePerformanceCountersV1 {
  return Object.freeze({
    ...threadEventStorePerformance,
    scanReasons: Object.freeze({ ...threadEventStorePerformance.scanReasons }),
  });
}

/**
 * Append-only durable fact store for a single Thread.
 *
 * The log is authoritative. Its projection is an atomic, rebuildable cache and
 * is never returned when it is ahead of or divergent from the durable cursor.
 */
export class ThreadEventStore {
  readonly logPath: string;
  readonly projectionPath: string;
  readonly headPath: string;
  readonly compactStatePath: string;
  readonly compactCheckpointsDir: string;
  private readonly maxLogBytes: number;
  private readonly maxReplayEvents: number;
  private readonly lockWaitMs: number;
  private readonly clock: () => number;
  private readonly idFactory: () => string;
  private readonly onBoundary?: ThreadEventStoreOptionsV1['onBoundary'];
  private readonly onLogScan?: ThreadEventStoreOptionsV1['onLogScan'];
  private readonly commitListeners = new Set<(events: readonly RuntimeEventEnvelopeV1[]) => void>();
  private cachedHead?: CachedThreadHeadV1;

  constructor(
    readonly rootDir: string,
    readonly threadId: string,
    options: ThreadEventStoreOptionsV1 = {}
  ) {
    if (!isRuntimeId(threadId)) {
      throw new ThreadEventStoreError(
        'ORION_THREAD_EVENT_IDENTITY',
        `ThreadEventStore threadId must be a UUID: ${threadId}`
      );
    }
    this.logPath = join(rootDir, `${threadId}.events.v1.jsonl`);
    this.projectionPath = join(rootDir, `${threadId}.projection.v1.json`);
    this.headPath = join(rootDir, `${threadId}.head.v1.json`);
    this.compactStatePath = join(rootDir, `${threadId}.compact-state.v1.json`);
    this.compactCheckpointsDir = join(rootDir, `${threadId}.compact-checkpoints.v1`);
    this.maxLogBytes = positiveInteger(options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES, 'maxLogBytes');
    this.maxReplayEvents = positiveInteger(
      options.maxReplayEvents ?? DEFAULT_MAX_REPLAY_EVENTS,
      'maxReplayEvents'
    );
    this.lockWaitMs = positiveInteger(options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS, 'lockWaitMs');
    this.clock = options.clock ?? Date.now;
    this.idFactory = options.idFactory ?? createRuntimeId;
    this.onBoundary = options.onBoundary;
    this.onLogScan = options.onLogScan;
  }

  appendDurable<T extends RuntimeEventV1>(
    input: AppendRuntimeEventV1<T>
  ): RuntimeEventEnvelopeV1<T> {
    return this.appendDurableBatch([input]).events[0] as RuntimeEventEnvelopeV1<T>;
  }

  appendDurableBatch(inputs: readonly AppendRuntimeEventV1[]): ThreadEventCommitV1 {
    if (inputs.length === 0) {
      return { events: [], projection: this.loadProjection() };
    }
    const commit = this.withLogLock(() => {
      ensurePrivateDirectory(this.rootDir);
      const head = this.loadVerifiedHead();
      if (head.discardedTailBytes > 0) truncateSync(this.logPath, head.safeByteLength);

      let seq = head.projection.cursor;
      let previousHash = head.lastRecordHash;
      const records: StoredThreadEventRecordV1[] = [];
      const eventIds = new Set(head.eventIdSet);

      for (const input of inputs) {
        seq += 1;
        const eventId = this.idFactory();
        if (!isRuntimeId(eventId) || eventIds.has(eventId)) {
          throw new ThreadEventStoreError(
            'ORION_THREAD_EVENT_IDENTITY',
            `Event ID factory returned an invalid or duplicate UUID: ${eventId}`
          );
        }
        eventIds.add(eventId);
        const event: RuntimeEventEnvelopeV1 = {
          protocolVersion: 1,
          eventId,
          seq,
          threadId: this.threadId,
          turnId: input.turnId,
          stepId: input.stepId,
          itemId: input.itemId,
          durability: 'durable',
          timestamp: input.timestamp ?? this.clock(),
          payload: input.payload,
        };
        assertRuntimeEventEnvelopeV1(event);
        const hash = digestRuntimeValue({ version: 1, previousHash, event });
        records.push({ version: 1, previousHash, hash, event });
        previousHash = hash;
      }

      // Validate the new tail against the already verified projection before a
      // byte becomes durable. Historical lifecycle facts were validated when
      // cachedHead was established and are invalidated by any log fingerprint
      // change, so append cost no longer grows with Session age.
      const committedEvents = records.map(record => record.event);
      const projection = advanceThreadProjection(head.projection, committedEvents);

      this.boundary('before_log_write', seq);
      appendRecordsAndFlush(this.logPath, records, () => this.boundary('after_log_write', seq));
      // appendRecordsAndFlush fsyncs before returning; this boundary is the
      // point after which consumers may safely publish success notifications.
      this.boundary('after_log_flush', seq);
      fsyncDirectory(this.rootDir);

      this.boundary('before_projection_write', seq);
      writeProjection(this.projectionPath, projection);
      fsyncDirectory(this.rootDir);
      this.boundary('after_projection_write', seq);

      const nextLogIdentity = readFileIdentity(this.logPath);
      const safeByteLength = nextLogIdentity.bytes;
      const nextScan = head.scan
        ? ({
            records: [...head.scan.records, ...records],
            events: [...head.scan.events, ...committedEvents],
            safeByteLength,
            discardedTailBytes: 0,
          } satisfies ScannedThreadEventLogV1)
        : undefined;
      const nextHead: CachedThreadHeadV1 = {
        generation: head.generation + 1,
        logFingerprint: nextLogIdentity.fingerprint,
        log: storedLogIdentity(nextLogIdentity),
        projectionFingerprint: fileFingerprint(this.projectionPath),
        ...(nextScan ? { scan: nextScan } : {}),
        projection,
        lastEventTimestamp: committedEvents.at(-1)?.timestamp ?? head.lastEventTimestamp,
        lastRecordHash: previousHash,
        safeByteLength,
        discardedTailBytes: 0,
        eventIds: [...eventIds],
        eventIdSet: eventIds,
        verifiedPrefixes: head.verifiedPrefixes,
      };
      this.cachedHead = nextHead;
      this.tryPersistVerifiedHead(nextHead);
      try {
        advanceThreadSessionIndexV1({
          rootDir: this.rootDir,
          threadId: this.threadId,
          previousHead: sessionIndexHead(head),
          nextHead: sessionIndexHead(nextHead),
          projection,
          committedEvents,
        });
      } catch {
        // The immutable transcript index is derived. A stale manifest forces
        // a verified rebuild on the next snapshot and cannot veto the fact.
      }

      return deepFreeze({ events: committedEvents, projection });
    });
    this.notifyCommitted(commit.events);
    return commit;
  }

  /** Observe locally committed durable facts after log and projection fsync. */
  subscribeCommitted(listener: (events: readonly RuntimeEventEnvelopeV1[]) => void): () => void {
    this.commitListeners.add(listener);
    return () => this.commitListeners.delete(listener);
  }

  createEphemeral<T extends Extract<RuntimeEventV1, { type: 'item.delta' }>>(
    input: AppendRuntimeEventV1<T>
  ): RuntimeEventEnvelopeV1<T> {
    const cursor = this.getCursor();
    const event: RuntimeEventEnvelopeV1<T> = {
      protocolVersion: 1,
      eventId: this.idFactory(),
      seq: cursor,
      threadId: this.threadId,
      turnId: input.turnId,
      stepId: input.stepId,
      itemId: input.itemId,
      durability: 'ephemeral',
      timestamp: input.timestamp ?? this.clock(),
      payload: input.payload,
    };
    assertRuntimeEventEnvelopeV1(event);
    return deepFreeze(event);
  }

  replay(
    cursor = 0,
    limit = this.maxReplayEvents,
    reason: ThreadEventReplayReasonV1 = 'direct'
  ): ThreadEventReplayV1 {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new ThreadEventStoreError(
        'ORION_THREAD_EVENT_CURSOR',
        'Replay cursor must be a non-negative safe integer'
      );
    }
    const safeLimit = positiveInteger(limit, 'replay limit');
    if (safeLimit > this.maxReplayEvents) {
      throw new ThreadEventStoreError(
        'ORION_THREAD_EVENT_LIMIT',
        `Replay limit ${safeLimit} exceeds ${this.maxReplayEvents}`
      );
    }

    return this.withLogLock(() => {
      const scan = requireVerifiedScan(this.loadVerifiedHead(true, `replay:${reason}`));
      const lastSeq = scan.events.length;
      if (cursor > lastSeq) {
        throw new ThreadEventStoreError(
          'ORION_THREAD_EVENT_CURSOR',
          `Replay cursor ${cursor} is ahead of durable cursor ${lastSeq}`
        );
      }
      const events = scan.events.slice(cursor, cursor + safeLimit);
      const nextCursor = events.at(-1)?.seq ?? cursor;
      return deepFreeze({
        events,
        fromCursor: cursor,
        nextCursor,
        hasMore: nextCursor < lastSeq,
      });
    });
  }

  /**
   * Verify and seal an immutable imported prefix. The first call may scan the
   * authoritative log; later processes reuse the prefix receipt while the
   * exact log identity/projection checkpoint remains current. Internal append
   * carries the proof forward because the hash-chained prefix cannot change.
   */
  verifyDurablePrefix(cursor: number, eventDigest: string, projectionDigest: string): boolean {
    if (
      !Number.isSafeInteger(cursor) ||
      cursor <= 0 ||
      !isSha256(eventDigest) ||
      !isSha256(projectionDigest)
    ) {
      return false;
    }
    return this.withLogLock(() => {
      let head = this.loadVerifiedHead();
      if (cursor > head.projection.cursor) return false;
      const expected = { cursor, eventDigest, projectionDigest };
      if (head.verifiedPrefixes.some(prefix => sameVerifiedPrefix(prefix, expected))) return true;

      head = this.loadVerifiedHead(true, 'verify_durable_prefix');
      const scan = requireVerifiedScan(head);
      const events = scan.events.slice(0, cursor);
      if (
        events.length !== cursor ||
        digestRuntimeValue(events) !== eventDigest ||
        projectThreadEvents(this.threadId, events).digest !== projectionDigest
      ) {
        return false;
      }

      const next: CachedThreadHeadV1 = {
        ...head,
        generation: head.generation + 1,
        verifiedPrefixes: [...head.verifiedPrefixes, expected].sort(
          (left, right) => left.cursor - right.cursor
        ),
      };
      this.cachedHead = next;
      this.tryPersistVerifiedHead(next);
      return true;
    });
  }

  getCursor(): number {
    const cached = this.cachedHead;
    if (cached && cached.logFingerprint === fileFingerprint(this.logPath)) {
      return cached.projection.cursor;
    }
    return this.withLogLock(() => this.loadVerifiedHead().projection.cursor);
  }

  /**
   * Read the compact persisted receipt without parsing the potentially large
   * projection. Callers must fall back to the authoritative scan whenever the
   * receipt is missing, stale, or lacks their required cutover proof.
   */
  capturePersistedCheckpointHead(): ThreadCheckpointHeadV1 | undefined {
    return this.withLogLock(() => {
      const identity = readFileIdentity(this.logPath);
      const cached = this.cachedHead;
      if (cached?.logFingerprint === identity.fingerprint) {
        return checkpointHead(cached);
      }
      const stored = readStoredThreadHead(this.headPath, this.threadId);
      if (
        !stored ||
        !sameStoredLogIdentity(stored.log, identity) ||
        stored.safeByteLength + stored.discardedTailBytes !== identity.bytes
      ) {
        return undefined;
      }
      return deepFreeze({
        cursor: stored.cursor,
        projectionDigest: stored.projectionDigest,
        lastEventTimestamp: stored.lastEventTimestamp,
        lastRecordHash: stored.lastRecordHash,
        log: { ...stored.log },
        verifiedPrefixes: stored.verifiedPrefixes.map(prefix => ({ ...prefix })),
      });
    });
  }

  /** Capture the catalog read model and its exact verified log identity atomically. */
  captureReadModelHead(): ThreadReadModelHeadV1 {
    return this.withLogLock(() => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const head = this.loadVerifiedHead();
        const identity = readFileIdentity(this.logPath);
        if (identity.fingerprint !== head.logFingerprint) {
          this.cachedHead = undefined;
          continue;
        }
        return deepFreeze({
          projection: head.projection,
          lastEventTimestamp: head.lastEventTimestamp,
          lastRecordHash: head.lastRecordHash,
          log: {
            bytes: identity.bytes,
            device: identity.device,
            inode: identity.inode,
            mtimeNs: identity.mtimeNs,
            ctimeNs: identity.ctimeNs,
          },
        });
      }
      throw corrupt('Thread event log changed while capturing its read model', 0);
    });
  }

  loadProjection(): ThreadProjectionV1 {
    return this.withLogLock(() => {
      ensurePrivateDirectory(this.rootDir);
      const head = this.loadVerifiedHead();
      const replayed = head.projection;
      const projectionFingerprint = fileFingerprint(this.projectionPath);
      if (head.projectionFingerprint === projectionFingerprint) {
        this.tryPersistVerifiedHead(head);
        return replayed;
      }
      const cached = readProjection(this.projectionPath);
      if (
        cached &&
        cached.threadId === this.threadId &&
        cached.cursor === replayed.cursor &&
        cached.digest === replayed.digest &&
        verifyThreadProjectionDigest(cached)
      ) {
        const current = { ...head, projectionFingerprint };
        this.cachedHead = current;
        this.tryPersistVerifiedHead(current);
        return replayed;
      }
      writeProjection(this.projectionPath, replayed);
      fsyncDirectory(this.rootDir);
      const current = {
        ...head,
        projectionFingerprint: fileFingerprint(this.projectionPath),
      };
      this.cachedHead = current;
      this.tryPersistVerifiedHead(current);
      return replayed;
    });
  }

  /**
   * Load exactly the history selected by the latest committed TurnCommit or,
   * when newer, the atomically-installed Compact checkpoint pointer.
   */
  loadAuthoritativeModelHistory(): readonly unknown[] | undefined {
    return this.withLogLock(() => {
      const head = this.loadVerifiedHead();
      const state = readCompactState(this.compactStatePath, this.threadId);
      if (state) this.assertCompactCheckpoint(state);
      const turnState = readLatestDurableTurnStateFromProjection(head.projection);
      if (!state && !turnState) return undefined;
      return resolveCompactAuthorityState(turnState, state).history;
    });
  }

  /**
   * Capture the history and TaskContext that a maintenance compact is allowed
   * to replace. The event log and compact pointer are read under the same lock.
   */
  captureCompactSource(turnId: string): CompactAuthoritativeSourceV1 {
    return this.withLogLock(() => {
      ensurePrivateDirectory(this.rootDir);
      const head = this.loadVerifiedHead(true, 'capture_compact_source');
      const scan = requireVerifiedScan(head);
      const { projection } = head;
      assertActiveMaintenanceTurn(projection, turnId);
      const state = readCompactState(this.compactStatePath, this.threadId);
      if (state) this.assertCompactCheckpoint(state);
      const authoritative = resolveCompactAuthority(scan.events, state, this.threadId);
      return deepFreeze({
        threadId: this.threadId,
        maintenanceTurn: {
          turnId,
          mode: 'maintenance',
          active: true,
          steerable: false,
        },
        cursor: projection.cursor,
        projectionDigest: projection.digest,
        history: authoritative.history,
        taskContext: authoritative.taskContext,
        taskContextRevision: authoritative.taskContextRevision,
        activeCheckpointId: state?.pointer.checkpointId ?? null,
      });
    });
  }

  /**
   * The only compact pointer commit boundary. Cursor/projection, history,
   * TaskContext and the previous pointer are rechecked while the log lock is
   * held; the checkpoint is durable before one atomic state-file rename makes
   * the new pointer and model-visible history authoritative together.
   */
  appendCompactCheckpointCas(
    input: CompactCompareAndCommitInputV1
  ): CompactCompareAndCommitResultV1 {
    return this.withLogLock(() => {
      ensurePrivateDirectory(this.rootDir);
      ensurePrivateDirectory(this.compactCheckpointsDir);
      validateCompactCommitInput(input, this.threadId);

      input.onBoundary('before_cas_recheck');
      const head = this.loadVerifiedHead(true, 'compact_cas');
      const scan = requireVerifiedScan(head);
      const { projection } = head;
      const eventsAfterAnchor = scan.events.slice(input.expectedEventAnchor.cursor);
      const onlyQueuedFollowUps =
        eventsAfterAnchor.length > 0 &&
        eventsAfterAnchor.every(event => event.payload.type === 'turn.queued');
      if (projection.cursor !== input.expectedEventAnchor.cursor && !onlyQueuedFollowUps) {
        return { status: 'conflict', reason: 'cursor_changed' };
      }
      if (
        projection.digest !== input.expectedEventAnchor.projectionDigest &&
        !onlyQueuedFollowUps
      ) {
        return { status: 'conflict', reason: 'projection_changed' };
      }
      assertActiveMaintenanceTurn(projection, input.source.turnId);

      const previousState = readCompactState(this.compactStatePath, this.threadId);
      if (previousState) this.assertCompactCheckpoint(previousState);
      const authoritative = resolveCompactAuthority(scan.events, previousState, this.threadId);
      if (authoritative.historyDigest !== input.source.historyDigest) {
        return { status: 'conflict', reason: 'history_changed' };
      }
      if (authoritative.taskContextDigest !== input.source.taskContextDigest) {
        return { status: 'conflict', reason: 'task_context_changed' };
      }
      if (authoritative.taskContextRevision !== input.source.taskContextRevision) {
        return { status: 'conflict', reason: 'task_context_revision_changed' };
      }
      if ((previousState?.pointer.checkpointId ?? null) !== input.source.activeCheckpointId) {
        return { status: 'conflict', reason: 'checkpoint_pointer_changed' };
      }
      input.onBoundary('after_cas_recheck');

      const checkpoint = createStoredCompactCheckpoint(this.threadId, input);
      const checkpointPath = join(
        this.compactCheckpointsDir,
        `${input.candidate.checkpointId}.json`
      );
      const existingCheckpoint = readStoredCompactCheckpoint(checkpointPath, this.threadId);
      if (existingCheckpoint && existingCheckpoint.digest !== checkpoint.digest) {
        throw new ThreadEventStoreError(
          'ORION_THREAD_COMPACT_CONFLICT',
          `Compact checkpoint ${input.candidate.checkpointId} already contains different data`
        );
      }
      if (!existingCheckpoint) {
        atomicWriteFileSync(checkpointPath, `${canonicalRuntimeJson(checkpoint)}\n`, {
          mode: 0o600,
          fsync: true,
        });
        fsyncDirectory(this.compactCheckpointsDir);
      }
      input.onBoundary('after_checkpoint_write');

      const state = createStoredCompactState(
        this.threadId,
        input,
        authoritative.taskContext,
        authoritative.taskContextRevision
      );
      atomicWriteFileSync(this.compactStatePath, `${canonicalRuntimeJson(state)}\n`, {
        mode: 0o600,
        fsync: true,
      });
      fsyncDirectory(this.rootDir);
      input.onBoundary('after_pointer_commit');
      return deepFreeze({ status: 'committed', pointer: input.commit.pointer });
    });
  }

  findCompactCheckpointCommit(
    turnId: string,
    sourceSeq: number
  ): CompactCheckpointCommitReceiptV1 | undefined {
    return this.withLogLock(() => {
      const state = readCompactState(this.compactStatePath, this.threadId);
      if (!state) return undefined;
      return state.commit.turnId === turnId && state.commit.source.cursor === sourceSeq
        ? state.commit
        : undefined;
    });
  }

  listCompactEvents(): readonly RuntimeEventEnvelopeV1<CompactRuntimeEventV1>[] {
    return this.withLogLock(() => {
      const projection = this.loadVerifiedHead().projection;
      if (projection.compactEvents) return projection.compactEvents;
      const scan = requireVerifiedScan(this.loadVerifiedHead(true, 'legacy_compact_projection'));
      return deepFreeze(
        scan.events.filter(
          (event): event is RuntimeEventEnvelopeV1<CompactRuntimeEventV1> =>
            event.payload.type === 'compact.started' ||
            event.payload.type === 'compact.completed' ||
            event.payload.type === 'compact.failed'
        )
      );
    });
  }

  /**
   * Converts orphaned started items to an explicit indeterminate terminal
   * state, then interrupts their active turn. This never guesses success.
   */
  recoverIncomplete(reason = 'runtime_restarted_before_terminal_commit'): ThreadProjectionV1 {
    const projection = this.loadProjection();
    const openItems = Object.values(projection.items).filter(item => item.status === 'started');
    const inputs: AppendRuntimeEventV1[] = openItems.map(item => ({
      turnId: item.turnId,
      stepId: item.stepId,
      itemId: item.itemId,
      payload: { type: 'item.indeterminate', data: { reason } },
    }));
    if (projection.activeTurnId) {
      const commit = projection.turns[projection.activeTurnId]?.commit;
      if (commit?.terminal === 'completed') {
        inputs.push({
          turnId: projection.activeTurnId,
          payload: {
            type: 'turn.completed',
            data: commit.outcome === undefined ? {} : { outcome: commit.outcome },
          },
        });
      } else if (commit?.terminal === 'failed') {
        inputs.push({
          turnId: projection.activeTurnId,
          payload: {
            type: 'turn.failed',
            data: { error: commit.error || 'Turn failed before terminal publication' },
          },
        });
      } else {
        inputs.push({
          turnId: projection.activeTurnId,
          payload: {
            type: 'turn.interrupted',
            data: { reason: commit?.reason ?? reason },
          },
        });
      }
    }
    return inputs.length > 0 ? this.appendDurableBatch(inputs).projection : projection;
  }

  /**
   * Return the last verified log head. A fresh process may adopt the persisted
   * receipt only when the exact JSONL identity and independently validated
   * projection still match. Callers that need historical events explicitly
   * request a scan; cursor/projection/append paths stay O(head + projection).
   */
  private loadVerifiedHead(requireScan = false, scanReason = 'unspecified'): CachedThreadHeadV1 {
    ensurePrivateDirectory(this.rootDir);
    const logIdentity = readFileIdentity(this.logPath);
    if (
      this.cachedHead?.logFingerprint === logIdentity.fingerprint &&
      (!requireScan || this.cachedHead.scan)
    ) {
      return this.cachedHead;
    }

    const stored = readStoredThreadHead(this.headPath, this.threadId);
    if (!requireScan && stored) {
      const projection = readProjection(this.projectionPath);
      const persisted = hydratePersistedThreadHead(
        stored,
        logIdentity,
        projection,
        fileFingerprint(this.projectionPath)
      );
      if (persisted) {
        this.cachedHead = persisted;
        return persisted;
      }
    }

    const scan = scanThreadEventLog(this.logPath, this.threadId, this.maxLogBytes);
    threadEventStorePerformance.logScans += 1;
    threadEventStorePerformance.bytesScanned += scan.safeByteLength + scan.discardedTailBytes;
    threadEventStorePerformance.eventsScanned += scan.events.length;
    threadEventStorePerformance.scanReasons[scanReason] =
      (threadEventStorePerformance.scanReasons[scanReason] ?? 0) + 1;
    this.onLogScan?.({
      threadId: this.threadId,
      bytes: scan.safeByteLength + scan.discardedTailBytes,
      events: scan.events.length,
    });
    const projection = projectThreadEvents(this.threadId, scan.events);
    const eventIds = scan.events.map(event => event.eventId);
    const projectionFingerprint = projectionFileMatches(this.projectionPath, projection)
      ? fileFingerprint(this.projectionPath)
      : undefined;
    const head: CachedThreadHeadV1 = {
      generation: (stored?.generation ?? 0) + 1,
      logFingerprint: logIdentity.fingerprint,
      log: storedLogIdentity(logIdentity),
      ...(projectionFingerprint ? { projectionFingerprint } : {}),
      scan,
      projection,
      lastEventTimestamp: scan.events.at(-1)?.timestamp ?? 0,
      lastRecordHash: scan.records.at(-1)?.hash ?? null,
      safeByteLength: scan.safeByteLength,
      discardedTailBytes: scan.discardedTailBytes,
      eventIds,
      eventIdSet: new Set(eventIds),
      verifiedPrefixes: retainVerifiedPrefixes(stored?.verifiedPrefixes ?? [], scan, this.threadId),
    };
    this.cachedHead = head;
    if (projectionFingerprint) this.tryPersistVerifiedHead(head);
    return head;
  }

  private tryPersistVerifiedHead(head: CachedThreadHeadV1): void {
    try {
      const logIdentity = readFileIdentity(this.logPath);
      if (logIdentity.fingerprint !== head.logFingerprint) return;
      if (!projectionFileMatches(this.projectionPath, head.projection)) return;
      const stored = createStoredThreadHead(head, logIdentity);
      atomicWriteFileSync(this.headPath, `${canonicalRuntimeJson(stored)}\n`, {
        mode: 0o600,
        fsync: true,
      });
      fsyncDirectory(this.rootDir);
    } catch {
      // The JSONL fact and projection are already durable. A missing/stale
      // derived head merely makes the next process take the full verification
      // path; it must never turn a committed fact into a reported failure.
    }
  }

  private withLogLock<T>(operation: () => T): T {
    ensurePrivateDirectory(dirname(this.logPath));
    return withFileLockSync(this.logPath, operation, { waitMs: this.lockWaitMs });
  }

  private assertCompactCheckpoint(state: StoredCompactStateV1): void {
    const checkpointPath = join(this.compactCheckpointsDir, `${state.pointer.checkpointId}.json`);
    const checkpoint = readStoredCompactCheckpoint(checkpointPath, this.threadId);
    if (
      !checkpoint ||
      checkpoint.checkpointId !== state.pointer.checkpointId ||
      checkpoint.commit.digest !== state.commit.digest ||
      checkpoint.nextModelVisibleHistoryDigest !== state.historyDigest ||
      checkpoint.nextModelVisibleHistoryDigest !== state.pointer.nextModelVisibleHistoryDigest
    ) {
      throw compactCorrupt('Compact pointer does not resolve to its committed checkpoint');
    }
  }

  private boundary(boundary: ThreadEventStoreBoundaryV1, lastSeq: number): void {
    this.onBoundary?.(boundary, { threadId: this.threadId, lastSeq });
  }

  private notifyCommitted(events: readonly RuntimeEventEnvelopeV1[]): void {
    for (const listener of this.commitListeners) {
      try {
        listener(events);
      } catch {
        // Durable commit observers are projections only and cannot veto facts.
      }
    }
  }
}

function scanThreadEventLog(
  path: string,
  threadId: string,
  maxLogBytes: number
): ScannedThreadEventLogV1 {
  if (!existsSync(path)) {
    return { records: [], events: [], safeByteLength: 0, discardedTailBytes: 0 };
  }
  const content = readFileSync(path);
  if (content.byteLength > maxLogBytes) {
    throw new ThreadEventStoreError(
      'ORION_THREAD_EVENT_LIMIT',
      `Thread event log exceeds ${maxLogBytes} bytes`
    );
  }
  const endsWithNewline = content.byteLength === 0 || content[content.byteLength - 1] === 0x0a;
  const text = content.toString('utf8');
  const allLines = text.split('\n');
  const tail = endsWithNewline ? '' : (allLines.pop() ?? '');
  if (endsWithNewline) allLines.pop();

  const records: StoredThreadEventRecordV1[] = [];
  const events: RuntimeEventEnvelopeV1[] = [];
  const eventIds = new Set<string>();
  let expectedPreviousHash: string | null = null;
  let safeByteLength = 0;

  for (const line of allLines) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (line.length === 0) {
      throw corrupt('Empty record inside the durable event log', safeByteLength);
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw corrupt('Malformed JSON record inside the durable event log', safeByteLength);
    }
    const record = validateStoredRecord(
      value,
      threadId,
      records.length + 1,
      expectedPreviousHash,
      safeByteLength
    );
    if (eventIds.has(record.event.eventId)) {
      throw corrupt(`Duplicate eventId ${record.event.eventId}`, safeByteLength);
    }
    eventIds.add(record.event.eventId);
    records.push(record);
    events.push(record.event);
    expectedPreviousHash = record.hash;
    safeByteLength += lineBytes;
  }

  return {
    records,
    events,
    safeByteLength,
    discardedTailBytes: Buffer.byteLength(tail, 'utf8'),
  };
}

function validateStoredRecord(
  value: unknown,
  threadId: string,
  expectedSeq: number,
  expectedPreviousHash: string | null,
  offset: number
): StoredThreadEventRecordV1 {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.event)) {
    throw corrupt('Invalid durable record envelope', offset);
  }
  try {
    assertRuntimeEventEnvelopeV1(value.event);
  } catch (error) {
    throw corrupt(error instanceof Error ? error.message : 'Invalid runtime event', offset);
  }
  const event = value.event;
  if (event.durability !== 'durable') throw corrupt('Ephemeral event found in durable log', offset);
  if (event.threadId !== threadId)
    throw corrupt('Thread identity changed inside event log', offset);
  if (event.seq !== expectedSeq) {
    throw corrupt(`Expected durable seq ${expectedSeq}, found ${event.seq}`, offset);
  }
  if (value.previousHash !== expectedPreviousHash) {
    throw corrupt('Event hash chain predecessor mismatch', offset);
  }
  if (typeof value.hash !== 'string') throw corrupt('Event record hash is missing', offset);
  const expectedHash = digestRuntimeValue({
    version: 1,
    previousHash: expectedPreviousHash,
    event,
  });
  if (value.hash !== expectedHash) throw corrupt('Event record hash mismatch', offset);

  return {
    version: 1,
    previousHash: expectedPreviousHash,
    hash: value.hash,
    event,
  };
}

function appendRecordsAndFlush(
  path: string,
  records: readonly StoredThreadEventRecordV1[],
  afterWrite: () => void
): void {
  const fd = openSync(path, 'a', 0o600);
  try {
    for (const record of records) writeAll(fd, Buffer.from(`${canonicalRuntimeJson(record)}\n`));
    afterWrite();
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, content: Buffer): void {
  let offset = 0;
  while (offset < content.byteLength) {
    const written = writeSync(fd, content, offset, content.byteLength - offset);
    if (written <= 0) throw new Error('Unable to append durable event record');
    offset += written;
  }
}

function writeProjection(path: string, projection: ThreadProjectionV1): void {
  atomicWriteFileSync(path, `${canonicalRuntimeJson(projection)}\n`, { mode: 0o600, fsync: true });
}

function readProjection(path: string): ThreadProjectionV1 | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as ThreadProjectionV1;
    return value?.version === 1 && typeof value.digest === 'string' ? value : null;
  } catch {
    return null;
  }
}

function projectionFileMatches(path: string, expected: ThreadProjectionV1): boolean {
  const projection = readProjection(path);
  return Boolean(
    projection &&
    projection.threadId === expected.threadId &&
    projection.cursor === expected.cursor &&
    projection.digest === expected.digest &&
    verifyThreadProjectionDigest(projection)
  );
}

function readStoredThreadHead(path: string, threadId: string): ThreadHeadV1 | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isRecord(value)) return null;
    const { digest: _digest, ...content } = value;
    void _digest;
    if (
      value.version !== 1 ||
      value.threadId !== threadId ||
      !Number.isSafeInteger(value.generation) ||
      (value.generation as number) < 1 ||
      !Number.isSafeInteger(value.cursor) ||
      (value.cursor as number) < 0 ||
      typeof value.projectionDigest !== 'string' ||
      !Number.isSafeInteger(value.lastEventTimestamp) ||
      (value.lastEventTimestamp as number) < 0 ||
      (value.lastRecordHash !== null && !isSha256(value.lastRecordHash)) ||
      !Number.isSafeInteger(value.safeByteLength) ||
      (value.safeByteLength as number) < 0 ||
      !Number.isSafeInteger(value.discardedTailBytes) ||
      (value.discardedTailBytes as number) < 0 ||
      !Array.isArray(value.eventIds) ||
      !Array.isArray(value.verifiedPrefixes) ||
      value.verifiedPrefixes.length > 32 ||
      !isStoredLogIdentity(value.log) ||
      typeof value.digest !== 'string' ||
      digestRuntimeValue(content) !== value.digest
    ) {
      return null;
    }
    const eventIds = value.eventIds;
    if (
      eventIds.length !== value.cursor ||
      eventIds.some(eventId => typeof eventId !== 'string' || !isRuntimeId(eventId)) ||
      new Set(eventIds).size !== eventIds.length ||
      ((value.cursor as number) === 0) !== (value.lastRecordHash === null) ||
      ((value.cursor as number) === 0 && (value.lastEventTimestamp as number) !== 0)
    ) {
      return null;
    }
    const prefixes = value.verifiedPrefixes;
    if (
      prefixes.some(prefix => !isStoredVerifiedPrefix(prefix, value.cursor as number)) ||
      new Set(prefixes.map(prefix => (prefix as ThreadVerifiedPrefixV1).cursor)).size !==
        prefixes.length
    ) {
      return null;
    }
    return deepFreeze(value as unknown as ThreadHeadV1);
  } catch {
    return null;
  }
}

function hydratePersistedThreadHead(
  stored: ThreadHeadV1,
  logIdentity: FileIdentityV1,
  projection: ThreadProjectionV1 | null,
  projectionFingerprint: string
): CachedThreadHeadV1 | null {
  if (
    !sameStoredLogIdentity(stored.log, logIdentity) ||
    stored.safeByteLength + stored.discardedTailBytes !== logIdentity.bytes ||
    !projection ||
    projection.threadId !== stored.threadId ||
    projection.cursor !== stored.cursor ||
    projection.digest !== stored.projectionDigest ||
    !verifyThreadProjectionDigest(projection)
  ) {
    return null;
  }
  const eventIds = [...stored.eventIds];
  return {
    generation: stored.generation,
    logFingerprint: logIdentity.fingerprint,
    log: storedLogIdentity(logIdentity),
    projectionFingerprint,
    projection,
    lastEventTimestamp: stored.lastEventTimestamp,
    lastRecordHash: stored.lastRecordHash,
    safeByteLength: stored.safeByteLength,
    discardedTailBytes: stored.discardedTailBytes,
    eventIds,
    eventIdSet: new Set(eventIds),
    verifiedPrefixes: stored.verifiedPrefixes.map(prefix => ({ ...prefix })),
  };
}

function createStoredThreadHead(
  head: CachedThreadHeadV1,
  logIdentity: FileIdentityV1
): ThreadHeadV1 {
  const content = {
    version: 1 as const,
    generation: head.generation,
    threadId: head.projection.threadId,
    cursor: head.projection.cursor,
    projectionDigest: head.projection.digest,
    lastEventTimestamp: head.lastEventTimestamp,
    lastRecordHash: head.lastRecordHash,
    safeByteLength: head.safeByteLength,
    discardedTailBytes: head.discardedTailBytes,
    eventIds: [...head.eventIds],
    verifiedPrefixes: head.verifiedPrefixes.map(prefix => ({ ...prefix })),
    log: storedLogIdentity(logIdentity),
  };
  return deepFreeze({ ...content, digest: digestRuntimeValue(content) });
}

function retainVerifiedPrefixes(
  prefixes: readonly ThreadVerifiedPrefixV1[],
  scan: ScannedThreadEventLogV1,
  threadId: string
): readonly ThreadVerifiedPrefixV1[] {
  return prefixes.filter(prefix => {
    if (prefix.cursor > scan.events.length) return false;
    const events = scan.events.slice(0, prefix.cursor);
    return (
      digestRuntimeValue(events) === prefix.eventDigest &&
      projectThreadEvents(threadId, events).digest === prefix.projectionDigest
    );
  });
}

function requireVerifiedScan(head: CachedThreadHeadV1): ScannedThreadEventLogV1 {
  if (!head.scan) throw new Error('Thread event history was not loaded');
  return head.scan;
}

function sessionIndexHead(head: CachedThreadHeadV1): ThreadSessionIndexHeadV1 {
  return {
    cursor: head.projection.cursor,
    projectionDigest: head.projection.digest,
    lastEventTimestamp: head.lastEventTimestamp,
    lastRecordHash: head.lastRecordHash,
    log: head.log,
  };
}

function checkpointHead(head: CachedThreadHeadV1): ThreadCheckpointHeadV1 {
  return deepFreeze({
    cursor: head.projection.cursor,
    projectionDigest: head.projection.digest,
    lastEventTimestamp: head.lastEventTimestamp,
    lastRecordHash: head.lastRecordHash,
    log: { ...head.log },
    verifiedPrefixes: head.verifiedPrefixes.map(prefix => ({ ...prefix })),
  });
}

function isStoredVerifiedPrefix(value: unknown, headCursor: number): boolean {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.cursor) &&
    (value.cursor as number) > 0 &&
    (value.cursor as number) <= headCursor &&
    isSha256(value.eventDigest) &&
    isSha256(value.projectionDigest)
  );
}

function sameVerifiedPrefix(left: ThreadVerifiedPrefixV1, right: ThreadVerifiedPrefixV1): boolean {
  return (
    left.cursor === right.cursor &&
    left.eventDigest === right.eventDigest &&
    left.projectionDigest === right.projectionDigest
  );
}

function isStoredLogIdentity(value: unknown): value is ThreadLogIdentityV1 {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.bytes) &&
    (value.bytes as number) >= 0 &&
    ['device', 'inode', 'mtimeNs', 'ctimeNs'].every(
      key => typeof value[key] === 'string' && /^\d+$/.test(value[key] as string)
    )
  );
}

function sameStoredLogIdentity(stored: ThreadLogIdentityV1, current: FileIdentityV1): boolean {
  return (
    stored.bytes === current.bytes &&
    stored.device === current.device &&
    stored.inode === current.inode &&
    stored.mtimeNs === current.mtimeNs &&
    stored.ctimeNs === current.ctimeNs
  );
}

function storedLogIdentity(identity: FileIdentityV1): ThreadLogIdentityV1 {
  return {
    bytes: identity.bytes,
    device: identity.device,
    inode: identity.inode,
    mtimeNs: identity.mtimeNs,
    ctimeNs: identity.ctimeNs,
  };
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

/**
 * A cheap identity for deciding whether a previously verified file head is
 * still current. Size alone is insufficient because another process may
 * rewrite bytes in place; inode and nanosecond timestamps make that mutation
 * invalidate the cache and force the normal hash-chain verification path.
 */
interface FileIdentityV1 {
  readonly fingerprint: string;
  readonly bytes: number;
  readonly device: string;
  readonly inode: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

function readFileIdentity(path: string): FileIdentityV1 {
  try {
    const stats = statSync(path, { bigint: true });
    const device = stats.dev.toString();
    const inode = stats.ino.toString();
    const mtimeNs = stats.mtimeNs.toString();
    const ctimeNs = stats.ctimeNs.toString();
    return {
      fingerprint: [device, inode, stats.size, mtimeNs, ctimeNs].join(':'),
      bytes: Number(stats.size),
      device,
      inode,
      mtimeNs,
      ctimeNs,
    };
  } catch {
    return {
      fingerprint: 'missing',
      bytes: 0,
      device: '0',
      inode: '0',
      mtimeNs: '0',
      ctimeNs: '0',
    };
  }
}

function fileFingerprint(path: string): string {
  return readFileIdentity(path).fingerprint;
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch {
    // Some filesystems do not support directory fsync. File fsync and atomic
    // rename still preserve the fail-closed ordering used by the store.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertActiveMaintenanceTurn(projection: ThreadProjectionV1, turnId: string): void {
  const turn = projection.turns[turnId];
  if (
    !isRuntimeId(turnId) ||
    projection.activeTurnId !== turnId ||
    !turn ||
    turn.status !== 'active' ||
    turn.mode !== 'maintenance'
  ) {
    throw new ThreadEventStoreError(
      'ORION_THREAD_COMPACT_INVALID',
      `Compact requires ${turnId} to be the active maintenance turn`
    );
  }
}

function resolveCompactAuthority(
  events: readonly RuntimeEventEnvelopeV1[],
  compactState: StoredCompactStateV1 | null,
  threadId: string
): {
  readonly history: readonly unknown[];
  readonly historyDigest: string;
  readonly taskContext: unknown;
  readonly taskContextDigest: string;
  readonly taskContextRevision: number;
} {
  const turnState = readLatestDurableTurnState(events, threadId);
  return resolveCompactAuthorityState(turnState, compactState);
}

function resolveCompactAuthorityState(
  turnState: DurableTurnStateV1 | null,
  compactState: StoredCompactStateV1 | null
): {
  readonly history: readonly unknown[];
  readonly historyDigest: string;
  readonly taskContext: unknown;
  readonly taskContextDigest: string;
  readonly taskContextRevision: number;
} {
  if (!turnState && !compactState) {
    throw new ThreadEventStoreError(
      'ORION_THREAD_COMPACT_INVALID',
      'Compact requires a durable TurnCommitV1 source'
    );
  }
  const historyOwner =
    compactState && (!turnState || compactState.installedAtCursor > turnState.eventSeq)
      ? compactState
      : turnState;
  const taskContextOwner =
    turnState && (!compactState || turnState.eventSeq > compactState.installedAtCursor)
      ? turnState
      : compactState;
  if (!historyOwner || !taskContextOwner) {
    throw new ThreadEventStoreError(
      'ORION_THREAD_COMPACT_INVALID',
      'Compact authoritative state could not be resolved'
    );
  }
  return deepFreeze({
    history: structuredClone(historyOwner.history),
    historyDigest: historyOwner.historyDigest,
    taskContext: structuredClone(taskContextOwner.taskContext),
    taskContextDigest: taskContextOwner.taskContextDigest,
    taskContextRevision: taskContextOwner.taskContextRevision,
  });
}

function readLatestDurableTurnStateFromProjection(
  projection: ThreadProjectionV1
): DurableTurnStateV1 | null {
  const commit = Object.values(projection.turns)
    .map(turn => turn.commit)
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .sort((left, right) => left.seq - right.seq)
    .at(-1);
  return commit ? parseDurableTurnState(commit.receipt, commit.seq, projection.threadId) : null;
}

function readLatestDurableTurnState(
  events: readonly RuntimeEventEnvelopeV1[],
  threadId: string
): DurableTurnStateV1 | null {
  const event = [...events]
    .reverse()
    .find(candidate => candidate.payload.type === 'turn.committed');
  if (!event || event.payload.type !== 'turn.committed') return null;
  return parseDurableTurnState(event.payload.data.receipt, event.seq, threadId);
}

function parseDurableTurnState(
  serializedReceipt: string,
  eventSeq: number,
  threadId: string
): DurableTurnStateV1 {
  let receipt: Record<string, unknown>;
  try {
    receipt = JSON.parse(serializedReceipt) as Record<string, unknown>;
  } catch {
    throw compactCorrupt('TurnCommitV1 receipt is not valid JSON');
  }
  const { digest, ...content } = receipt;
  if (
    receipt.version !== 1 ||
    receipt.threadId !== threadId ||
    typeof digest !== 'string' ||
    digestRuntimeValue(content) !== digest ||
    typeof receipt.history !== 'string' ||
    typeof receipt.historyDigest !== 'string' ||
    typeof receipt.taskContext !== 'string' ||
    typeof receipt.taskContextDigest !== 'string' ||
    !Number.isSafeInteger(receipt.taskContextRevision) ||
    (receipt.taskContextRevision as number) < 0
  ) {
    throw compactCorrupt('TurnCommitV1 receipt failed compact source validation');
  }
  let history: unknown;
  let taskContext: unknown;
  try {
    history = JSON.parse(receipt.history);
    taskContext = JSON.parse(receipt.taskContext);
  } catch {
    throw compactCorrupt('TurnCommitV1 history or TaskContext is not valid JSON');
  }
  if (
    !Array.isArray(history) ||
    digestRuntimeValue(history) !== receipt.historyDigest ||
    digestRuntimeValue(taskContext) !== receipt.taskContextDigest
  ) {
    throw compactCorrupt('TurnCommitV1 history or TaskContext digest changed');
  }
  return deepFreeze({
    eventSeq,
    history: structuredClone(history),
    historyDigest: receipt.historyDigest,
    taskContext: structuredClone(taskContext),
    taskContextDigest: receipt.taskContextDigest,
    taskContextRevision: receipt.taskContextRevision as number,
  });
}

function validateCompactCommitInput(input: CompactCompareAndCommitInputV1, threadId: string): void {
  const commit = input.commit;
  const { digest, ...content } = commit;
  if (
    commit.version !== 1 ||
    commit.threadId !== threadId ||
    commit.threadId !== input.source.threadId ||
    commit.turnId !== input.source.turnId ||
    commit.source.digest !== input.source.digest ||
    commit.startedEvent.cursor !== input.expectedEventAnchor.cursor ||
    commit.startedEvent.projectionDigest !== input.expectedEventAnchor.projectionDigest ||
    commit.checkpointId !== input.candidate.checkpointId ||
    commit.checkpointDigest !== digestRuntimeValue(input.candidate.checkpoint) ||
    commit.pointer.nextModelVisibleHistoryDigest !==
      digestRuntimeValue(input.candidate.modelVisibleHistory) ||
    digestRuntimeValue(content) !== digest ||
    !isRuntimeId(commit.transactionId) ||
    !isRuntimeId(commit.checkpointId)
  ) {
    throw compactCorrupt('Compact CAS input failed receipt validation');
  }
  const { digest: pointerDigest, ...pointerContent } = commit.pointer;
  if (
    commit.pointer.version !== 1 ||
    commit.pointer.checkpointId !== commit.checkpointId ||
    commit.pointer.transactionId !== commit.transactionId ||
    commit.pointer.sourceReceiptDigest !== commit.source.digest ||
    digestRuntimeValue(pointerContent) !== pointerDigest
  ) {
    throw compactCorrupt('Compact pointer failed receipt validation');
  }
}

function createStoredCompactCheckpoint(
  threadId: string,
  input: CompactCompareAndCommitInputV1
): StoredCompactCheckpointV1 {
  const content = {
    version: 1 as const,
    threadId,
    checkpointId: input.candidate.checkpointId,
    checkpoint: structuredClone(input.candidate.checkpoint),
    checkpointDigest: input.commit.checkpointDigest,
    modelVisibleHistory: structuredClone(input.candidate.modelVisibleHistory),
    nextModelVisibleHistoryDigest: input.commit.pointer.nextModelVisibleHistoryDigest,
    commit: structuredClone(input.commit),
  };
  return deepFreeze({ ...content, digest: digestRuntimeValue(content) });
}

function createStoredCompactState(
  threadId: string,
  input: CompactCompareAndCommitInputV1,
  taskContext: unknown,
  taskContextRevision: number
): StoredCompactStateV1 {
  const history = structuredClone(input.candidate.modelVisibleHistory);
  const task = structuredClone(taskContext);
  const content = {
    version: 1 as const,
    threadId,
    installedAtCursor: input.expectedEventAnchor.cursor,
    pointer: structuredClone(input.commit.pointer),
    history,
    historyDigest: digestRuntimeValue(history),
    taskContext: task,
    taskContextDigest: digestRuntimeValue(task),
    taskContextRevision,
    commit: structuredClone(input.commit),
  };
  return deepFreeze({ ...content, digest: digestRuntimeValue(content) });
}

function readCompactState(path: string, threadId: string): StoredCompactStateV1 | null {
  if (!existsSync(path)) return null;
  let value: StoredCompactStateV1;
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as StoredCompactStateV1;
  } catch {
    throw compactCorrupt('Compact state is not valid JSON');
  }
  const { digest, ...content } = value;
  if (
    value.version !== 1 ||
    value.threadId !== threadId ||
    !Number.isSafeInteger(value.installedAtCursor) ||
    value.installedAtCursor < 0 ||
    !Array.isArray(value.history) ||
    digestRuntimeValue(value.history) !== value.historyDigest ||
    digestRuntimeValue(value.taskContext) !== value.taskContextDigest ||
    !Number.isSafeInteger(value.taskContextRevision) ||
    value.taskContextRevision < 0 ||
    digestRuntimeValue(content) !== digest ||
    value.commit?.digest === undefined ||
    value.pointer?.digest === undefined ||
    value.commit.digest !== digestRuntimeValue(stripDigest(value.commit)) ||
    value.pointer.digest !== digestRuntimeValue(stripDigest(value.pointer)) ||
    value.commit.pointer.digest !== value.pointer.digest
  ) {
    throw compactCorrupt('Compact state failed integrity validation');
  }
  return deepFreeze(value);
}

function readStoredCompactCheckpoint(
  path: string,
  threadId: string
): StoredCompactCheckpointV1 | null {
  if (!existsSync(path)) return null;
  let value: StoredCompactCheckpointV1;
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as StoredCompactCheckpointV1;
  } catch {
    throw compactCorrupt('Compact checkpoint is not valid JSON');
  }
  const { digest, ...content } = value;
  if (
    value.version !== 1 ||
    value.threadId !== threadId ||
    !isRuntimeId(value.checkpointId) ||
    digestRuntimeValue(value.checkpoint) !== value.checkpointDigest ||
    !Array.isArray(value.modelVisibleHistory) ||
    digestRuntimeValue(value.modelVisibleHistory) !== value.nextModelVisibleHistoryDigest ||
    digestRuntimeValue(content) !== digest
  ) {
    throw compactCorrupt('Compact checkpoint failed integrity validation');
  }
  return deepFreeze(value);
}

function stripDigest<T extends { readonly digest: string }>(value: T): Omit<T, 'digest'> {
  const { digest: _digest, ...content } = value;
  void _digest;
  return content;
}

function compactCorrupt(message: string): ThreadEventStoreError {
  return new ThreadEventStoreError('ORION_THREAD_COMPACT_INVALID', message);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ThreadEventStoreError(
      'ORION_THREAD_EVENT_LIMIT',
      `${name} must be a positive safe integer`
    );
  }
  return value;
}

function corrupt(message: string, offset: number): ThreadEventStoreError {
  return new ThreadEventStoreError('ORION_THREAD_EVENT_CORRUPT', message, offset);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return value;
}
