import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from 'fs';
import { basename, resolve } from 'path';

import { atomicWriteFileSync } from '../services/atomic-write';
import { withFileLockSync } from '../services/file-lock';
import {
  getProjectSessionMetaPath,
  getProjectThreadV2ImportReceiptPath,
  getProjectThreadsV2Dir,
  getProjectThreadsV2IndexPath,
} from '../product/paths';
import { canonicalRuntimeJson, digestRuntimeValue } from './protocol/canonical';
import type { RuntimeEventEnvelopeV1, RuntimeEventV1 } from './protocol/runtime-protocol-v1';
import {
  createDeterministicLegacyRuntimeId,
  importLegacySessionV1,
  readLegacySessionMaterializationSnapshotV1,
  type LegacyImportRecordMappingV1,
  type LegacyImportWarningV1,
  type LegacyMaterializationRecordV1,
  type LegacyMaterializationSidecarV1,
  type LegacySessionImportReceiptV1,
  type LegacySessionMaterializationSnapshotV1,
} from './legacy-session-importer';
import {
  ThreadEventStore,
  type AppendRuntimeEventV1,
  type ThreadCheckpointHeadV1,
} from './thread-event-store';
import {
  projectThreadEvents,
  verifyThreadProjectionDigest,
  type ThreadProjectionV1,
} from './thread-projection';

export type LegacyThreadMaterializationBoundaryV1 =
  | 'after_dry_run'
  | 'after_receipt_staged'
  | 'after_facts_materialized'
  | 'after_projection_verified'
  | 'after_source_recheck'
  | 'before_index_switch'
  | 'after_index_switch';

export interface LegacyThreadMaterializerOptionsV1 {
  readonly projectPath: string;
  readonly sessionId: string;
  readonly dryRun?: boolean;
  readonly onBoundary?: (
    boundary: LegacyThreadMaterializationBoundaryV1,
    context: { readonly threadId: string; readonly sourceDigest: string }
  ) => void;
}

export interface LegacyThreadMaterializationPlanV1 {
  readonly version: 1;
  readonly receipt: LegacySessionImportReceiptV1;
  readonly events: readonly RuntimeEventEnvelopeV1[];
  readonly eventDigest: string;
  readonly projection: ThreadProjectionV1;
}

export interface ThreadCutoverIndexEntryV1 {
  readonly sessionId: string;
  readonly threadId: string;
  readonly sourceDigest: string;
  readonly importDigest: string;
  readonly eventDigest: string;
  readonly projectionDigest: string;
  readonly cursor: number;
  readonly eventLogFile: string;
  readonly projectionFile: string;
  readonly receiptFile: string;
  readonly cutoverAt: number;
}

export interface ThreadCutoverIndexV1 {
  readonly version: 1;
  readonly generation: number;
  readonly sessions: Readonly<Record<string, ThreadCutoverIndexEntryV1>>;
  readonly digest: string;
}

export interface LegacyThreadMaterializationResultV1 {
  readonly mode: 'dry_run' | 'cutover' | 'already_cutover';
  readonly plan: LegacyThreadMaterializationPlanV1;
  readonly index?: ThreadCutoverIndexV1;
}

export type SessionStorageResolutionV1 =
  | {
      readonly kind: 'legacy';
      readonly sessionId: string;
      readonly metaPath: string;
    }
  | {
      readonly kind: 'thread';
      readonly sessionId: string;
      readonly threadId: string;
      readonly cursor: number;
      readonly projectionDigest: string;
      readonly generation: number;
    };

export type OpenedSessionStorageV1 =
  | {
      readonly resolution: Extract<SessionStorageResolutionV1, { kind: 'legacy' }>;
    }
  | {
      readonly resolution: Extract<SessionStorageResolutionV1, { kind: 'thread' }>;
      readonly store: ThreadEventStore;
    };

export interface OpenedSessionCheckpointStorageV1 {
  readonly resolution: Extract<SessionStorageResolutionV1, { kind: 'thread' }>;
  readonly store: ThreadEventStore;
  readonly head: ThreadCheckpointHeadV1;
}

export class LegacyThreadMaterializationError extends Error {
  constructor(
    readonly code:
      | 'ORION_LEGACY_MATERIALIZATION_DIVERGED'
      | 'ORION_LEGACY_MATERIALIZATION_SOURCE_CHANGED'
      | 'ORION_THREAD_CUTOVER_INDEX_CORRUPT'
      | 'ORION_THREAD_CUTOVER_CONFLICT',
    message: string
  ) {
    super(message);
    this.name = 'LegacyThreadMaterializationError';
  }
}

/** Build the complete content-bearing event stream without writing any file. */
export function planLegacyThreadMaterializationV1(
  projectPath: string,
  sessionId: string
): LegacyThreadMaterializationPlanV1 {
  const snapshot = readLegacySessionMaterializationSnapshotV1(projectPath, sessionId);
  const events = buildMaterializedEvents(snapshot);
  const projection = projectThreadEvents(snapshot.receipt.threadId, events);
  return deepFreeze({
    version: 1,
    receipt: snapshot.receipt,
    events,
    eventDigest: digestRuntimeValue(events),
    projection,
  });
}

/**
 * Materialize facts and projection first, then atomically publish the index.
 * The index is the sole reader cutover marker; hidden v2 files are safe to
 * leave behind after any pre-cutover crash.
 */
export function materializeLegacyThreadV1(
  options: LegacyThreadMaterializerOptionsV1
): LegacyThreadMaterializationResultV1 {
  const projectPath = resolve(options.projectPath);
  const plan = planLegacyThreadMaterializationV1(projectPath, options.sessionId);
  const context = {
    threadId: plan.receipt.threadId,
    sourceDigest: plan.receipt.sourceDigest,
  };
  options.onBoundary?.('after_dry_run', context);
  if (options.dryRun === true) return deepFreeze({ mode: 'dry_run', plan });

  const threadsDir = getProjectThreadsV2Dir(projectPath);
  const staged = importLegacySessionV1({
    projectPath,
    sessionId: options.sessionId,
    outputDir: threadsDir,
  });
  if (staged.receipt.importDigest !== plan.receipt.importDigest) {
    throw sourceChanged('Legacy source changed between dry-run and receipt staging');
  }
  if (
    staged.receiptPath !== getProjectThreadV2ImportReceiptPath(projectPath, plan.receipt.threadId)
  ) {
    throw new LegacyThreadMaterializationError(
      'ORION_LEGACY_MATERIALIZATION_DIVERGED',
      'Legacy import receipt path does not match the v2 Thread layout'
    );
  }
  options.onBoundary?.('after_receipt_staged', context);

  const store = materializeFacts(threadsDir, plan);
  options.onBoundary?.('after_facts_materialized', context);
  verifyMaterializedStore(store, plan);
  options.onBoundary?.('after_projection_verified', context);

  assertSourceUnchanged(projectPath, options.sessionId, plan.receipt.importDigest);
  options.onBoundary?.('after_source_recheck', context);

  const indexPath = getProjectThreadsV2IndexPath(projectPath);
  mkdirSync(threadsDir, { recursive: true, mode: 0o700 });
  let mode: LegacyThreadMaterializationResultV1['mode'] = 'cutover';
  const index = withFileLockSync(indexPath, () => {
    // Recheck inside the cutover lock so a stale pre-lock observation can
    // never publish a newer generation.
    assertSourceUnchanged(projectPath, options.sessionId, plan.receipt.importDigest);
    const current = readThreadCutoverIndex(indexPath);
    const existing = current.sessions[options.sessionId];
    const entry = createIndexEntry(options.sessionId, store, plan);
    if (existing) {
      if (canonicalRuntimeJson(existing) !== canonicalRuntimeJson(entry)) {
        throw new LegacyThreadMaterializationError(
          'ORION_THREAD_CUTOVER_CONFLICT',
          `Session ${options.sessionId} already points at a different v2 Thread`
        );
      }
      mode = 'already_cutover';
      return current;
    }

    options.onBoundary?.('before_index_switch', context);
    const content = {
      version: 1 as const,
      generation: current.generation + 1,
      sessions: { ...current.sessions, [options.sessionId]: entry },
    };
    const next = deepFreeze({ ...content, digest: digestRuntimeValue(content) });
    atomicWriteFileSync(indexPath, `${canonicalRuntimeJson(next)}\n`, {
      mode: 0o600,
      fsync: true,
    });
    fsyncDirectory(threadsDir);
    options.onBoundary?.('after_index_switch', context);
    return next;
  });

  return deepFreeze({ mode, plan, index });
}

/** Resolve exactly one storage generation using the atomic index as authority. */
export function resolveSessionStorageV1(
  projectPathInput: string,
  sessionId: string
): SessionStorageResolutionV1 {
  return openSessionStorageV1(projectPathInput, sessionId).resolution;
}

/**
 * Open only the compact persisted Thread head used by bounded Web snapshots.
 * Missing/stale receipts return undefined so the caller can run the normal
 * authoritative open once and rebuild the derived checkpoint.
 */
export function openSessionCheckpointStorageV1(
  projectPathInput: string,
  sessionId: string
): OpenedSessionCheckpointStorageV1 | undefined {
  const projectPath = resolve(projectPathInput);
  const indexPath = getProjectThreadsV2IndexPath(projectPath);
  if (!existsSync(indexPath)) return undefined;
  const index = readThreadCutoverIndex(indexPath);
  const entry = index.sessions[sessionId];
  if (!entry) return undefined;
  const store = new ThreadEventStore(getProjectThreadsV2Dir(projectPath), entry.threadId, {
    maxReplayEvents: Math.max(10_000, entry.cursor),
  });
  const head = store.capturePersistedCheckpointHead();
  if (
    !head ||
    head.cursor < entry.cursor ||
    !head.verifiedPrefixes.some(
      prefix =>
        prefix.cursor === entry.cursor &&
        prefix.eventDigest === entry.eventDigest &&
        prefix.projectionDigest === entry.projectionDigest
    )
  ) {
    return undefined;
  }
  return Object.freeze({
    resolution: deepFreeze({
      kind: 'thread' as const,
      sessionId,
      threadId: entry.threadId,
      cursor: head.cursor,
      projectionDigest: head.projectionDigest,
      generation: index.generation,
    }),
    store,
    head,
  });
}

/**
 * Resolve and verify one storage generation while retaining the verified
 * ThreadEventStore. Read-side projections can then capture transcript and
 * model history without constructing a second cold store and rescanning the
 * same append-only log.
 */
export function openSessionStorageV1(
  projectPathInput: string,
  sessionId: string
): OpenedSessionStorageV1 {
  const projectPath = resolve(projectPathInput);
  const indexPath = getProjectThreadsV2IndexPath(projectPath);
  if (!existsSync(indexPath)) {
    return Object.freeze({
      resolution: Object.freeze({
        kind: 'legacy' as const,
        sessionId,
        metaPath: getProjectSessionMetaPath(projectPath, sessionId),
      }),
    });
  }
  const index = readThreadCutoverIndex(indexPath);
  const entry = index.sessions[sessionId];
  if (!entry) {
    return Object.freeze({
      resolution: Object.freeze({
        kind: 'legacy' as const,
        sessionId,
        metaPath: getProjectSessionMetaPath(projectPath, sessionId),
      }),
    });
  }

  const store = new ThreadEventStore(getProjectThreadsV2Dir(projectPath), entry.threadId, {
    maxReplayEvents: Math.max(10_000, entry.cursor),
  });
  const prefixVerified = store.verifyDurablePrefix(
    entry.cursor,
    entry.eventDigest,
    entry.projectionDigest
  );
  // The cutover receipt seals the imported prefix, not the forever-changing
  // head of a live Thread. loadProjection() independently verifies/rebuilds the
  // current cache against the complete hash-chained log.
  const currentProjection = store.loadProjection();
  if (
    !prefixVerified ||
    currentProjection.threadId !== entry.threadId ||
    currentProjection.cursor < entry.cursor
  ) {
    throw new LegacyThreadMaterializationError(
      'ORION_THREAD_CUTOVER_INDEX_CORRUPT',
      `Cutover index for ${sessionId} does not match its durable Thread facts`
    );
  }
  const resolution = deepFreeze({
    kind: 'thread',
    sessionId,
    threadId: entry.threadId,
    cursor: currentProjection.cursor,
    projectionDigest: currentProjection.digest,
    generation: index.generation,
  } as const);
  return Object.freeze({ resolution, store });
}

export function loadThreadCutoverIndexV1(projectPath: string): ThreadCutoverIndexV1 {
  return readThreadCutoverIndex(getProjectThreadsV2IndexPath(resolve(projectPath)));
}

function buildMaterializedEvents(
  snapshot: LegacySessionMaterializationSnapshotV1
): RuntimeEventEnvelopeV1[] {
  const receipt = snapshot.receipt;
  const pending: Array<{
    readonly turnId?: string;
    readonly stepId?: string;
    readonly itemId?: string;
    readonly timestamp: number;
    readonly payload: RuntimeEventV1;
  }> = [
    {
      timestamp: safeTimestamp(snapshot.meta.startTime, receipt.sourceTimestamp),
      payload: { type: 'thread.started', data: { projectPath: receipt.projectPath } },
    },
  ];
  const indeterminate = indeterminateLocators(receipt.warnings);

  const messageGroups = groupRecordsByTurn(snapshot.messages, receipt, 'messages');
  let messageOrdinal = 0;
  for (const [turnId, records] of messageGroups) {
    messageOrdinal += 1;
    const firstMessage = records.find(record => record.value?.role === 'user')?.value;
    const input = nonEmptyInput(
      firstMessage?.content,
      `Imported legacy transcript turn ${messageOrdinal}`
    );
    const timestamp = firstRecordTimestamp(records, receipt.sourceTimestamp);
    pending.push({
      turnId,
      timestamp,
      payload: {
        type: 'turn.started',
        data: { input, mode: snapshot.meta.activeGoalId ? 'goal' : 'build' },
      },
    });
    let turnIndeterminate = false;
    for (const record of records) {
      const mapping = requiredMapping(receipt, 'messages', record.locator);
      const terminalIndeterminate =
        record.status === 'indeterminate' || indeterminate.has(`messages:${record.locator}`);
      turnIndeterminate ||= terminalIndeterminate;
      appendRecordItem(pending, receipt, mapping, record, {
        kind: 'message',
        role: record.value?.role,
        name: 'legacy_message',
        content: record.value?.content,
        timestamp: safeTimestamp(record.value?.timestamp, timestamp),
        terminalIndeterminate,
      });
    }
    pending.push({
      turnId,
      timestamp,
      payload: turnIndeterminate
        ? {
            type: 'turn.interrupted',
            data: { reason: 'legacy transcript contains indeterminate records' },
          }
        : { type: 'turn.completed', data: { outcome: 'legacy transcript imported' } },
    });
  }

  const traceGroups = groupRecordsByTurn(snapshot.traces, receipt, 'trace');
  let traceOrdinal = 0;
  for (const [turnId, records] of traceGroups) {
    traceOrdinal += 1;
    const timestamp = firstRecordTimestamp(records, receipt.sourceTimestamp);
    pending.push({
      turnId,
      timestamp,
      payload: {
        type: 'turn.started',
        data: { input: `Imported legacy trace group ${traceOrdinal}`, mode: 'maintenance' },
      },
    });
    let turnIndeterminate = false;
    for (const record of records) {
      const mapping = requiredMapping(receipt, 'trace', record.locator);
      const terminalIndeterminate =
        record.status === 'indeterminate' || indeterminate.has(`trace:${record.locator}`);
      turnIndeterminate ||= terminalIndeterminate;
      appendRecordItem(pending, receipt, mapping, record, {
        kind: 'reasoning',
        name: `legacy_trace${record.value?.type ? `:${record.value.type}` : ''}`,
        content: record.value ? canonicalRuntimeJson(record.value) : undefined,
        timestamp: safeTimestamp(record.value?.timestamp, timestamp),
        terminalIndeterminate,
      });
    }
    pending.push({
      turnId,
      timestamp,
      payload: turnIndeterminate
        ? { type: 'turn.interrupted', data: { reason: 'legacy trace is indeterminate' } }
        : { type: 'turn.completed', data: { outcome: 'legacy trace imported' } },
    });
  }

  appendSidecarTurn(pending, snapshot, receipt, indeterminate);
  return deepFreeze(
    pending.map((event, index) => {
      const seq = index + 1;
      return {
        protocolVersion: 1 as const,
        eventId: createDeterministicLegacyRuntimeId(
          'legacy-runtime-event',
          receipt.importDigest,
          String(seq),
          digestRuntimeValue(event)
        ),
        seq,
        threadId: receipt.threadId,
        turnId: event.turnId,
        stepId: event.stepId,
        itemId: event.itemId,
        durability: 'durable' as const,
        timestamp: event.timestamp,
        payload: event.payload,
      };
    })
  );
}

function appendRecordItem<T extends { timestamp: number }>(
  pending: Array<{
    readonly turnId?: string;
    readonly stepId?: string;
    readonly itemId?: string;
    readonly timestamp: number;
    readonly payload: RuntimeEventV1;
  }>,
  receipt: LegacySessionImportReceiptV1,
  mapping: LegacyImportRecordMappingV1,
  record: LegacyMaterializationRecordV1<T>,
  options: {
    readonly kind: 'message' | 'reasoning';
    readonly role?: 'user' | 'assistant' | 'system' | 'tool';
    readonly name: string;
    readonly content?: string;
    readonly timestamp: number;
    readonly terminalIndeterminate: boolean;
  }
): void {
  const turnId = mapping.runtimeTurnId;
  if (!turnId) throw diverged(`${mapping.source}:${mapping.locator} has no deterministic turn ID`);
  const itemId = mapping.runtimeId;
  const stepId = createDeterministicLegacyRuntimeId('legacy-step', receipt.threadId, itemId);
  const itemReceipt = canonicalRuntimeJson({
    version: 1,
    source: mapping.source,
    locator: mapping.locator,
    sourceDigest: mapping.sourceDigest,
    // Preserve tool_calls, toolCallId, appliedSkills and modelVisibleContent
    // alongside the primary content field so v2 resume loses no legacy
    // message semantics.
    legacyRecord: record.value,
  });
  pending.push({
    turnId,
    stepId,
    itemId,
    timestamp: options.timestamp,
    payload: {
      type: 'item.started',
      data: {
        kind: options.kind,
        ...(options.role ? { role: options.role } : {}),
        name: options.name,
        inputDigest: mapping.sourceDigest,
        intent: 'legacy_session_materialization',
      },
    },
  });
  pending.push({
    turnId,
    stepId,
    itemId,
    timestamp: options.timestamp,
    payload: options.terminalIndeterminate
      ? {
          type: 'item.indeterminate',
          data: { reason: 'legacy record cannot be proven complete', receipt: itemReceipt },
        }
      : {
          type: 'item.completed',
          data: {
            content: options.content ?? '',
            summary: options.name,
            outputDigest: digestRuntimeValue(options.content ?? ''),
            receipt: itemReceipt,
          },
        },
  });
}

function appendSidecarTurn(
  pending: Array<{
    readonly turnId?: string;
    readonly stepId?: string;
    readonly itemId?: string;
    readonly timestamp: number;
    readonly payload: RuntimeEventV1;
  }>,
  snapshot: LegacySessionMaterializationSnapshotV1,
  receipt: LegacySessionImportReceiptV1,
  indeterminate: ReadonlySet<string>
): void {
  if (snapshot.sidecars.length === 0) return;
  const turnId = createDeterministicLegacyRuntimeId(
    'legacy-sidecar-turn',
    receipt.threadId,
    receipt.sourceDigest
  );
  const timestamp = receipt.sourceTimestamp;
  pending.push({
    turnId,
    timestamp,
    payload: {
      type: 'turn.started',
      data: { input: 'Imported legacy runtime sidecars', mode: 'maintenance' },
    },
  });
  let turnIndeterminate = false;
  for (const sidecar of snapshot.sidecars) {
    const mapping = requiredMapping(receipt, sidecar.source, sidecar.locator);
    const terminalIndeterminate =
      sidecar.status === 'indeterminate' ||
      indeterminate.has(`${sidecar.source}:${sidecar.locator}`);
    turnIndeterminate ||= terminalIndeterminate;
    appendSidecarItem(pending, receipt, turnId, mapping, sidecar, terminalIndeterminate);
  }
  pending.push({
    turnId,
    timestamp,
    payload: turnIndeterminate
      ? { type: 'turn.interrupted', data: { reason: 'legacy sidecar is indeterminate' } }
      : { type: 'turn.completed', data: { outcome: 'legacy sidecars imported' } },
  });
}

function appendSidecarItem(
  pending: Array<{
    readonly turnId?: string;
    readonly stepId?: string;
    readonly itemId?: string;
    readonly timestamp: number;
    readonly payload: RuntimeEventV1;
  }>,
  receipt: LegacySessionImportReceiptV1,
  turnId: string,
  mapping: LegacyImportRecordMappingV1,
  sidecar: LegacyMaterializationSidecarV1,
  terminalIndeterminate: boolean
): void {
  const itemId = mapping.runtimeId;
  const stepId = createDeterministicLegacyRuntimeId('legacy-step', receipt.threadId, itemId);
  const kind =
    sidecar.source === 'compact' ? 'compact' : sidecar.source === 'goal' ? 'plan' : 'reasoning';
  const itemReceipt = canonicalRuntimeJson({
    version: 1,
    source: sidecar.source,
    locator: sidecar.locator,
    sourceDigest: sidecar.sourceDigest,
  });
  pending.push({
    turnId,
    stepId,
    itemId,
    timestamp: receipt.sourceTimestamp,
    payload: {
      type: 'item.started',
      data: {
        kind,
        name: `legacy_${sidecar.source}`,
        inputDigest: sidecar.sourceDigest,
        intent: 'legacy_session_materialization',
      },
    },
  });
  pending.push({
    turnId,
    stepId,
    itemId,
    timestamp: receipt.sourceTimestamp,
    payload: terminalIndeterminate
      ? {
          type: 'item.indeterminate',
          data: { reason: 'legacy sidecar is malformed', receipt: itemReceipt },
        }
      : {
          type: 'item.completed',
          data: {
            content: sidecar.content,
            summary: `legacy_${sidecar.source}`,
            outputDigest: digestRuntimeValue(sidecar.content),
            receipt: itemReceipt,
          },
        },
  });
}

function groupRecordsByTurn<T>(
  records: readonly LegacyMaterializationRecordV1<T>[],
  receipt: LegacySessionImportReceiptV1,
  source: 'messages' | 'trace'
): Map<string, LegacyMaterializationRecordV1<T>[]> {
  const groups = new Map<string, LegacyMaterializationRecordV1<T>[]>();
  for (const record of records) {
    const mapping = requiredMapping(receipt, source, record.locator);
    if (!mapping.runtimeTurnId) throw diverged(`${source}:${record.locator} has no turn mapping`);
    const group = groups.get(mapping.runtimeTurnId) ?? [];
    group.push(record);
    groups.set(mapping.runtimeTurnId, group);
  }
  return groups;
}

function requiredMapping(
  receipt: LegacySessionImportReceiptV1,
  source: LegacyImportRecordMappingV1['source'],
  locator: string
): LegacyImportRecordMappingV1 {
  const mapping = receipt.recordMappings.find(
    candidate => candidate.source === source && candidate.locator === locator
  );
  if (!mapping) throw diverged(`Receipt has no mapping for ${source}:${locator}`);
  return mapping;
}

function indeterminateLocators(warnings: readonly LegacyImportWarningV1[]): ReadonlySet<string> {
  const terminalWarnings = new Set<LegacyImportWarningV1['code']>([
    'malformed_json',
    'malformed_jsonl_line',
    'invalid_message_shape',
    'invalid_trace_shape',
    'duplicate_tool_call',
    'unknown_tool_result',
    'missing_tool_result',
  ]);
  return new Set(
    warnings
      .filter(warning => terminalWarnings.has(warning.code))
      .map(warning => `${warning.source}:${warning.locator}`)
  );
}

function materializeFacts(
  threadsDir: string,
  plan: LegacyThreadMaterializationPlanV1
): ThreadEventStore {
  let idIndex = 0;
  const store = new ThreadEventStore(threadsDir, plan.receipt.threadId, {
    maxReplayEvents: Math.max(1, plan.events.length),
    idFactory: () => {
      const event = plan.events[idIndex++];
      if (!event) throw diverged('Materializer requested more event IDs than planned');
      return event.eventId;
    },
  });
  const cursor = store.getCursor();
  if (cursor > plan.events.length) {
    throw diverged(`Existing Thread has ${cursor} events, expected ${plan.events.length}`);
  }
  const existing = cursor === 0 ? [] : store.replay(0, cursor).events;
  for (let index = 0; index < existing.length; index += 1) {
    if (canonicalRuntimeJson(existing[index]) !== canonicalRuntimeJson(plan.events[index])) {
      throw diverged(`Existing Thread diverges from import plan at seq ${index + 1}`);
    }
  }
  idIndex = existing.length;
  const remaining = plan.events.slice(existing.length).map(toAppendInput);
  if (remaining.length > 0) store.appendDurableBatch(remaining);
  return store;
}

function verifyMaterializedStore(
  store: ThreadEventStore,
  plan: LegacyThreadMaterializationPlanV1
): void {
  const replay = store.replay(0, Math.max(1, plan.events.length));
  if (
    replay.hasMore ||
    replay.events.length !== plan.events.length ||
    digestRuntimeValue(replay.events) !== plan.eventDigest
  ) {
    throw diverged('Durable Thread replay does not match the deterministic import plan');
  }
  const projection = store.loadProjection();
  if (
    projection.cursor !== plan.projection.cursor ||
    projection.digest !== plan.projection.digest ||
    !verifyThreadProjectionDigest(projection)
  ) {
    throw diverged('Materialized projection does not match replay projection digest');
  }
  if (
    !store.verifyDurablePrefix(
      plan.events.length,
      plan.eventDigest,
      plan.projection.digest
    )
  ) {
    throw diverged('Materialized Thread prefix could not be sealed');
  }
}

function toAppendInput(event: RuntimeEventEnvelopeV1): AppendRuntimeEventV1 {
  return {
    turnId: event.turnId,
    stepId: event.stepId,
    itemId: event.itemId,
    timestamp: event.timestamp,
    payload: event.payload,
  };
}

function createIndexEntry(
  sessionId: string,
  store: ThreadEventStore,
  plan: LegacyThreadMaterializationPlanV1
): ThreadCutoverIndexEntryV1 {
  return {
    sessionId,
    threadId: plan.receipt.threadId,
    sourceDigest: plan.receipt.sourceDigest,
    importDigest: plan.receipt.importDigest,
    eventDigest: plan.eventDigest,
    projectionDigest: plan.projection.digest,
    cursor: plan.events.length,
    eventLogFile: basename(store.logPath),
    projectionFile: basename(store.projectionPath),
    receiptFile: basename(
      getProjectThreadV2ImportReceiptPath(plan.receipt.projectPath, plan.receipt.threadId)
    ),
    cutoverAt: plan.receipt.sourceTimestamp,
  };
}

function assertSourceUnchanged(
  projectPath: string,
  sessionId: string,
  expectedImportDigest: string
): void {
  const current = readLegacySessionMaterializationSnapshotV1(projectPath, sessionId).receipt;
  if (current.importDigest !== expectedImportDigest) {
    throw sourceChanged('Legacy source changed after v2 facts were materialized');
  }
}

function readThreadCutoverIndex(path: string): ThreadCutoverIndexV1 {
  if (!existsSync(path)) return emptyIndex();
  let index: ThreadCutoverIndexV1;
  try {
    index = JSON.parse(readFileSync(path, 'utf8')) as ThreadCutoverIndexV1;
  } catch {
    throw indexCorrupt(`Thread cutover index is unreadable: ${path}`);
  }
  const { digest: _digest, ...content } = index;
  void _digest;
  if (
    index.version !== 1 ||
    !Number.isSafeInteger(index.generation) ||
    index.generation < 0 ||
    !index.sessions ||
    typeof index.sessions !== 'object' ||
    Array.isArray(index.sessions) ||
    digestRuntimeValue(content) !== index.digest
  ) {
    throw indexCorrupt(`Thread cutover index failed validation: ${path}`);
  }
  return deepFreeze(index);
}

function emptyIndex(): ThreadCutoverIndexV1 {
  const content = { version: 1 as const, generation: 0, sessions: {} };
  return deepFreeze({ ...content, digest: digestRuntimeValue(content) });
}

function firstRecordTimestamp<T extends { timestamp: number }>(
  records: readonly LegacyMaterializationRecordV1<T>[],
  fallback: number
): number {
  return safeTimestamp(records.find(record => record.value)?.value?.timestamp, fallback);
}

function safeTimestamp(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : fallback;
}

function nonEmptyInput(value: string | undefined, fallback: string): string {
  return value?.trim() ? value : fallback;
}

function sourceChanged(message: string): LegacyThreadMaterializationError {
  return new LegacyThreadMaterializationError(
    'ORION_LEGACY_MATERIALIZATION_SOURCE_CHANGED',
    message
  );
}

function diverged(message: string): LegacyThreadMaterializationError {
  return new LegacyThreadMaterializationError('ORION_LEGACY_MATERIALIZATION_DIVERGED', message);
}

function indexCorrupt(message: string): LegacyThreadMaterializationError {
  return new LegacyThreadMaterializationError('ORION_THREAD_CUTOVER_INDEX_CORRUPT', message);
}

function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch {
    // Atomic rename plus file fsync is the fail-closed baseline on filesystems
    // that do not allow directory fsync.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return value;
}
