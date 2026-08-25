import { createHash } from 'crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync } from 'fs';
import { basename, join, resolve } from 'path';

import { atomicWriteFileSync } from '../services/atomic-write';
import {
  getProjectSessionCompactPath,
  getProjectSessionGoalPath,
  getProjectSessionHarnessPath,
  getProjectSessionMessagesPath,
  getProjectSessionMetaPath,
  getProjectSessionTracePath,
} from '../product/paths';
import type { SessionMessage, SessionMeta, SessionTraceEvent } from '../services/session-storage';
import { canonicalRuntimeJson, digestRuntimeValue } from './protocol/canonical';
import { isRuntimeId } from './protocol/runtime-protocol-v1';

export type LegacySessionSourceKindV1 =
  | 'meta'
  | 'messages'
  | 'trace'
  | 'harness'
  | 'compact'
  | 'goal';

export type LegacyImportTargetKindV1 =
  | 'thread'
  | 'turn'
  | 'item'
  | 'event'
  | 'harness_snapshot'
  | 'compact_checkpoint'
  | 'task_context';

export interface LegacyImportSourceReceiptV1 {
  readonly kind: LegacySessionSourceKindV1;
  readonly file: string;
  readonly present: boolean;
  readonly bytes: number;
  readonly sha256?: string;
}

export interface LegacyImportTurnMappingV1 {
  readonly legacyTurnKey: string;
  readonly runtimeTurnId: string;
}

export interface LegacyImportRecordMappingV1 {
  readonly source: LegacySessionSourceKindV1;
  readonly locator: string;
  readonly sourceDigest: string;
  readonly targetKind: LegacyImportTargetKindV1;
  readonly runtimeId: string;
  readonly runtimeTurnId?: string;
  readonly status: 'mapped' | 'indeterminate';
}

export interface LegacyImportWarningV1 {
  readonly code:
    | 'meta_project_mismatch'
    | 'malformed_json'
    | 'malformed_jsonl_line'
    | 'invalid_message_shape'
    | 'invalid_trace_shape'
    | 'duplicate_tool_call'
    | 'unknown_tool_result'
    | 'missing_tool_result';
  readonly source: LegacySessionSourceKindV1;
  readonly locator: string;
  readonly message: string;
}

export interface LegacySessionImportReceiptV1 {
  readonly version: 1;
  readonly importer: 'orion-legacy-session-v1';
  readonly sessionId: string;
  readonly threadId: string;
  readonly projectPath: string;
  readonly sourceTimestamp: number;
  readonly sourceDigest: string;
  readonly sources: readonly LegacyImportSourceReceiptV1[];
  readonly turnMappings: readonly LegacyImportTurnMappingV1[];
  readonly recordMappings: readonly LegacyImportRecordMappingV1[];
  readonly warnings: readonly LegacyImportWarningV1[];
  readonly disposition: 'ready' | 'requires_review';
  readonly importDigest: string;
}

export interface LegacySessionImportOptionsV1 {
  readonly projectPath: string;
  readonly sessionId: string;
  /** Dedicated v2 directory; no legacy source file is modified. */
  readonly outputDir: string;
  readonly dryRun?: boolean;
  readonly onBoundary?: (
    boundary: 'before_receipt_write' | 'after_receipt_write',
    receipt: LegacySessionImportReceiptV1
  ) => void;
}

export interface LegacySessionImportResultV1 {
  readonly mode: 'dry_run' | 'staged' | 'already_staged';
  readonly receiptPath: string;
  readonly receipt: LegacySessionImportReceiptV1;
}

export class LegacySessionImportError extends Error {
  constructor(
    readonly code:
      | 'ORION_LEGACY_IMPORT_INVALID_SOURCE'
      | 'ORION_LEGACY_IMPORT_SOURCE_CHANGED'
      | 'ORION_LEGACY_IMPORT_CONFLICT',
    message: string
  ) {
    super(message);
    this.name = 'LegacySessionImportError';
  }
}

interface StableSourceFile {
  readonly kind: LegacySessionSourceKindV1;
  readonly path: string;
  readonly content?: Buffer;
}

interface ParsedJsonLine {
  readonly line: number;
  readonly offset: number;
  readonly digest: string;
  readonly value?: unknown;
}

export interface LegacyMaterializationRecordV1<T> {
  readonly source: 'messages' | 'trace';
  readonly locator: string;
  readonly sourceDigest: string;
  readonly status: 'mapped' | 'indeterminate';
  readonly value?: T;
}

export interface LegacyMaterializationSidecarV1 {
  readonly source: 'harness' | 'compact' | 'goal';
  readonly locator: string;
  readonly sourceDigest: string;
  readonly status: 'mapped' | 'indeterminate';
  /** Exact legacy JSON bytes decoded as UTF-8. */
  readonly content: string;
}

export interface LegacySessionMaterializationSnapshotV1 {
  readonly receipt: LegacySessionImportReceiptV1;
  readonly meta: SessionMeta;
  readonly messages: readonly LegacyMaterializationRecordV1<SessionMessage>[];
  readonly traces: readonly LegacyMaterializationRecordV1<SessionTraceEvent>[];
  readonly sidecars: readonly LegacyMaterializationSidecarV1[];
}

/**
 * Stage a deterministic migration receipt without mutating legacy storage.
 *
 * The receipt is intentionally side-by-side rather than a catalog switch. It
 * gives the v2 event importer stable identities and an auditable source digest
 * before any legacy Session becomes a Thread.
 */
export function importLegacySessionV1(
  options: LegacySessionImportOptionsV1
): LegacySessionImportResultV1 {
  assertSafeLegacySessionId(options.sessionId);
  const projectPath = resolve(options.projectPath);
  const outputDir = resolve(options.outputDir);
  const sources = readLegacySources(projectPath, options.sessionId);
  const receipt = buildLegacySessionImportReceipt(projectPath, options.sessionId, sources);
  const receiptPath = join(outputDir, `${receipt.threadId}.legacy-import.v1.json`);

  if (options.dryRun === true) {
    return deepFreeze({ mode: 'dry_run', receiptPath, receipt });
  }

  if (existsSync(receiptPath)) {
    const current = readExistingReceipt(receiptPath);
    if (current.importDigest !== receipt.importDigest) {
      throw new LegacySessionImportError(
        'ORION_LEGACY_IMPORT_CONFLICT',
        `A different import receipt already exists at ${receiptPath}`
      );
    }
    return deepFreeze({ mode: 'already_staged', receiptPath, receipt: current });
  }

  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  options.onBoundary?.('before_receipt_write', receipt);
  atomicWriteFileSync(receiptPath, `${canonicalRuntimeJson(receipt)}\n`, {
    mode: 0o600,
    fsync: true,
  });
  fsyncDirectory(outputDir);
  options.onBoundary?.('after_receipt_write', receipt);
  return deepFreeze({ mode: 'staged', receiptPath, receipt });
}

export function verifyLegacySessionImportReceiptV1(receipt: LegacySessionImportReceiptV1): boolean {
  const { importDigest: _importDigest, ...content } = receipt;
  void _importDigest;
  return digestRuntimeValue(content) === receipt.importDigest;
}

export function createDeterministicLegacyRuntimeId(...parts: readonly string[]): string {
  const bytes = createHash('sha256').update(parts.join('\0')).digest().subarray(0, 16);
  // RFC 4122 variant with a version-5 marker. SHA-256 is used instead of SHA-1,
  // but the identity remains deterministic and validates as a UUID.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Read the exact legacy snapshot used by the receipt without invoking Session
 * recovery loaders. This is a zero-write API for the v2 materializer.
 */
export function readLegacySessionMaterializationSnapshotV1(
  projectPathInput: string,
  sessionId: string
): LegacySessionMaterializationSnapshotV1 {
  assertSafeLegacySessionId(sessionId);
  const projectPath = resolve(projectPathInput);
  const sources = readLegacySources(projectPath, sessionId);
  const receipt = buildLegacySessionImportReceipt(projectPath, sessionId, sources);
  const metaSource = requiredSource(sources, 'meta');
  const meta = JSON.parse(metaSource.content.toString('utf8')) as SessionMeta;
  const ignoredWarnings: LegacyImportWarningV1[] = [];
  const messages = parseJsonLines(sourceByKind(sources, 'messages'), ignoredWarnings).map(
    record => ({
      source: 'messages' as const,
      locator: `line:${record.line}:offset:${record.offset}`,
      sourceDigest: record.digest,
      status: isSessionMessage(record.value) ? ('mapped' as const) : ('indeterminate' as const),
      value: isSessionMessage(record.value) ? record.value : undefined,
    })
  );
  const traces = parseJsonLines(sourceByKind(sources, 'trace'), ignoredWarnings).map(record => ({
    source: 'trace' as const,
    locator: `line:${record.line}:offset:${record.offset}`,
    sourceDigest: record.digest,
    status: isSessionTraceEvent(record.value) ? ('mapped' as const) : ('indeterminate' as const),
    value: isSessionTraceEvent(record.value) ? record.value : undefined,
  }));
  const sidecars = (['harness', 'compact', 'goal'] as const).flatMap(kind => {
    const source = sourceByKind(sources, kind);
    if (!source.content) return [];
    let status: LegacyMaterializationSidecarV1['status'] = 'mapped';
    try {
      JSON.parse(source.content.toString('utf8'));
    } catch {
      status = 'indeterminate';
    }
    return [
      {
        source: kind,
        locator: basename(source.path),
        sourceDigest: sha256(source.content),
        status,
        content: source.content.toString('utf8'),
      },
    ];
  });
  return deepFreeze({ receipt, meta, messages, traces, sidecars });
}

function buildLegacySessionImportReceipt(
  projectPath: string,
  sessionId: string,
  sources: readonly StableSourceFile[]
): LegacySessionImportReceiptV1 {
  const metaSource = requiredSource(sources, 'meta');
  let meta: SessionMeta;
  try {
    meta = JSON.parse(metaSource.content!.toString('utf8')) as SessionMeta;
  } catch {
    throw new LegacySessionImportError(
      'ORION_LEGACY_IMPORT_INVALID_SOURCE',
      `Legacy session metadata is malformed: ${metaSource.path}`
    );
  }
  if (!meta || meta.id !== sessionId || typeof meta.projectPath !== 'string') {
    throw new LegacySessionImportError(
      'ORION_LEGACY_IMPORT_INVALID_SOURCE',
      `Legacy session metadata does not identify ${sessionId}`
    );
  }

  const threadId = isRuntimeId(sessionId)
    ? sessionId
    : createDeterministicLegacyRuntimeId('legacy-thread', projectPath, sessionId);
  const warnings: LegacyImportWarningV1[] = [];
  if (resolve(meta.projectPath) !== projectPath) {
    warnings.push({
      code: 'meta_project_mismatch',
      source: 'meta',
      locator: 'meta',
      message: 'Metadata projectPath differs from the explicit import scope.',
    });
  }

  const turnIds = new Map<string, string>();
  const turnMappings: LegacyImportTurnMappingV1[] = [];
  const mapTurn = (legacyTurnKey: string): string => {
    const existing = turnIds.get(legacyTurnKey);
    if (existing) return existing;
    const runtimeTurnId = createDeterministicLegacyRuntimeId(
      'legacy-turn',
      threadId,
      legacyTurnKey
    );
    turnIds.set(legacyTurnKey, runtimeTurnId);
    turnMappings.push({ legacyTurnKey, runtimeTurnId });
    return runtimeTurnId;
  };

  const recordMappings: LegacyImportRecordMappingV1[] = [
    {
      source: 'meta',
      locator: 'meta',
      sourceDigest: sha256(metaSource.content!),
      targetKind: 'thread',
      runtimeId: threadId,
      status: 'mapped',
    },
  ];

  const messagesSource = sourceByKind(sources, 'messages');
  const messageLines = parseJsonLines(messagesSource, warnings);
  let transcriptTurn = 0;
  const pendingToolCalls = new Map<string, string>();
  for (const record of messageLines) {
    const message = isSessionMessage(record.value) ? record.value : undefined;
    if (!message && record.value !== undefined) {
      warnings.push({
        code: 'invalid_message_shape',
        source: 'messages',
        locator: `line:${record.line}:offset:${record.offset}`,
        message: 'JSON record is not a valid legacy SessionMessage.',
      });
    }
    if (message?.role === 'user') transcriptTurn += 1;
    const legacyTurnKey = `transcript:${Math.max(1, transcriptTurn)}`;
    const runtimeTurnId = mapTurn(legacyTurnKey);
    const locator = `line:${record.line}:offset:${record.offset}`;
    recordMappings.push({
      source: 'messages',
      locator,
      sourceDigest: record.digest,
      targetKind: 'item',
      runtimeId: createDeterministicLegacyRuntimeId(
        'legacy-message-item',
        threadId,
        locator,
        record.digest
      ),
      runtimeTurnId,
      status: message ? 'mapped' : 'indeterminate',
    });
    if (!message) continue;
    observeToolPairing(message, locator, pendingToolCalls, warnings);
  }
  for (const [callId, locator] of pendingToolCalls) {
    warnings.push({
      code: 'missing_tool_result',
      source: 'messages',
      locator,
      message: `Tool call ${safeLabel(callId)} has no matching result.`,
    });
  }

  const traceSource = sourceByKind(sources, 'trace');
  for (const record of parseJsonLines(traceSource, warnings)) {
    const trace = isSessionTraceEvent(record.value) ? record.value : undefined;
    const locator = `line:${record.line}:offset:${record.offset}`;
    if (!trace && record.value !== undefined) {
      warnings.push({
        code: 'invalid_trace_shape',
        source: 'trace',
        locator,
        message: 'JSON record is not a valid legacy SessionTraceEvent.',
      });
    }
    const runtimeTurnId = trace ? mapTurn(`trace:${trace.turnId}`) : undefined;
    recordMappings.push({
      source: 'trace',
      locator,
      sourceDigest: record.digest,
      targetKind: 'event',
      runtimeId: createDeterministicLegacyRuntimeId(
        'legacy-trace-event',
        threadId,
        locator,
        record.digest
      ),
      runtimeTurnId,
      status: trace ? 'mapped' : 'indeterminate',
    });
  }

  for (const [kind, targetKind] of [
    ['harness', 'harness_snapshot'],
    ['compact', 'compact_checkpoint'],
    ['goal', 'task_context'],
  ] as const) {
    const source = sourceByKind(sources, kind);
    if (!source.content) continue;
    const digest = sha256(source.content);
    let status: LegacyImportRecordMappingV1['status'] = 'mapped';
    try {
      JSON.parse(source.content.toString('utf8'));
    } catch {
      status = 'indeterminate';
      warnings.push({
        code: 'malformed_json',
        source: kind,
        locator: basename(source.path),
        message: `Legacy ${kind} sidecar is malformed JSON.`,
      });
    }
    recordMappings.push({
      source: kind,
      locator: basename(source.path),
      sourceDigest: digest,
      targetKind,
      runtimeId: createDeterministicLegacyRuntimeId(`legacy-${kind}`, threadId, digest),
      status,
    });
  }

  const sourceReceipts = sources.map(toSourceReceipt);
  const sourceDigest = digestRuntimeValue(sourceReceipts);
  const content = {
    version: 1 as const,
    importer: 'orion-legacy-session-v1' as const,
    sessionId,
    threadId,
    projectPath,
    sourceTimestamp: normalizedTimestamp(meta.updatedAt ?? meta.startTime),
    sourceDigest,
    sources: sourceReceipts,
    turnMappings,
    recordMappings,
    warnings,
    disposition: warnings.length === 0 ? ('ready' as const) : ('requires_review' as const),
  };
  return deepFreeze({ ...content, importDigest: digestRuntimeValue(content) });
}

function readLegacySources(projectPath: string, sessionId: string): StableSourceFile[] {
  return [
    readStableSource('meta', getProjectSessionMetaPath(projectPath, sessionId), true),
    readStableSource('messages', getProjectSessionMessagesPath(projectPath, sessionId)),
    readStableSource('trace', getProjectSessionTracePath(projectPath, sessionId)),
    readStableSource('harness', getProjectSessionHarnessPath(projectPath, sessionId)),
    readStableSource('compact', getProjectSessionCompactPath(projectPath, sessionId)),
    readStableSource('goal', getProjectSessionGoalPath(projectPath, sessionId)),
  ];
}

function readStableSource(
  kind: LegacySessionSourceKindV1,
  path: string,
  required = false
): StableSourceFile {
  if (!existsSync(path)) {
    if (required) {
      throw new LegacySessionImportError(
        'ORION_LEGACY_IMPORT_INVALID_SOURCE',
        `Required legacy source does not exist: ${path}`
      );
    }
    return { kind, path };
  }
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new LegacySessionImportError(
      'ORION_LEGACY_IMPORT_INVALID_SOURCE',
      `Legacy source must be a regular file: ${path}`
    );
  }
  const content = readFileSync(path);
  const after = lstatSync(path);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new LegacySessionImportError(
      'ORION_LEGACY_IMPORT_SOURCE_CHANGED',
      `Legacy source changed while it was read: ${path}`
    );
  }
  return { kind, path, content };
}

function parseJsonLines(
  source: StableSourceFile,
  warnings: LegacyImportWarningV1[]
): ParsedJsonLine[] {
  if (!source.content || source.content.byteLength === 0) return [];
  const records: ParsedJsonLine[] = [];
  let offset = 0;
  let line = 1;
  while (offset < source.content.byteLength) {
    const newline = source.content.indexOf(0x0a, offset);
    const end = newline < 0 ? source.content.byteLength : newline;
    const raw = source.content.subarray(offset, end);
    if (raw.byteLength > 0) {
      const digest = sha256(raw);
      let value: unknown;
      try {
        value = JSON.parse(raw.toString('utf8'));
      } catch {
        warnings.push({
          code: 'malformed_jsonl_line',
          source: source.kind,
          locator: `line:${line}:offset:${offset}`,
          message: 'Malformed JSONL record retained as indeterminate.',
        });
      }
      records.push({ line, offset, digest, value });
    }
    if (newline < 0) break;
    offset = newline + 1;
    line += 1;
  }
  return records;
}

function observeToolPairing(
  message: SessionMessage,
  locator: string,
  pending: Map<string, string>,
  warnings: LegacyImportWarningV1[]
): void {
  for (const call of message.tool_calls ?? []) {
    if (pending.has(call.id)) {
      warnings.push({
        code: 'duplicate_tool_call',
        source: 'messages',
        locator,
        message: `Tool call ${safeLabel(call.id)} is duplicated.`,
      });
    } else {
      pending.set(call.id, locator);
    }
  }
  if (message.role !== 'tool' || !message.toolCallId) return;
  if (!pending.delete(message.toolCallId)) {
    warnings.push({
      code: 'unknown_tool_result',
      source: 'messages',
      locator,
      message: `Tool result ${safeLabel(message.toolCallId)} has no preceding call.`,
    });
  }
}

function isSessionMessage(value: unknown): value is SessionMessage {
  if (!isRecord(value)) return false;
  return (
    ['user', 'assistant', 'system', 'tool'].includes(String(value.role)) &&
    typeof value.content === 'string' &&
    Number.isFinite(value.timestamp)
  );
}

function isSessionTraceEvent(value: unknown): value is SessionTraceEvent {
  return (
    isRecord(value) &&
    typeof value.turnId === 'string' &&
    typeof value.type === 'string' &&
    Number.isFinite(value.timestamp)
  );
}

function sourceByKind(
  sources: readonly StableSourceFile[],
  kind: LegacySessionSourceKindV1
): StableSourceFile {
  const source = sources.find(candidate => candidate.kind === kind);
  if (!source) throw new Error(`Legacy source ${kind} is missing from snapshot`);
  return source;
}

function requiredSource(
  sources: readonly StableSourceFile[],
  kind: LegacySessionSourceKindV1
): StableSourceFile & { content: Buffer } {
  const source = sourceByKind(sources, kind);
  if (!source.content) throw new Error(`Required legacy source ${kind} has no content`);
  return source as StableSourceFile & { content: Buffer };
}

function toSourceReceipt(source: StableSourceFile): LegacyImportSourceReceiptV1 {
  return {
    kind: source.kind,
    file: basename(source.path),
    present: source.content !== undefined,
    bytes: source.content?.byteLength ?? 0,
    sha256: source.content ? sha256(source.content) : undefined,
  };
}

function readExistingReceipt(path: string): LegacySessionImportReceiptV1 {
  let receipt: LegacySessionImportReceiptV1;
  try {
    receipt = JSON.parse(readFileSync(path, 'utf8')) as LegacySessionImportReceiptV1;
  } catch {
    throw new LegacySessionImportError(
      'ORION_LEGACY_IMPORT_CONFLICT',
      `Existing import receipt is unreadable: ${path}`
    );
  }
  if (receipt.version !== 1 || !verifyLegacySessionImportReceiptV1(receipt)) {
    throw new LegacySessionImportError(
      'ORION_LEGACY_IMPORT_CONFLICT',
      `Existing import receipt failed digest validation: ${path}`
    );
  }
  return deepFreeze(receipt);
}

function normalizedTimestamp(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}

function assertSafeLegacySessionId(sessionId: string): void {
  if (
    !sessionId ||
    sessionId.includes('/') ||
    sessionId.includes('\\') ||
    sessionId.includes('\0')
  ) {
    throw new LegacySessionImportError(
      'ORION_LEGACY_IMPORT_INVALID_SOURCE',
      'Legacy session ID must be a non-empty path-safe value'
    );
  }
}

function safeLabel(value: string): string {
  return JSON.stringify(value.slice(0, 80));
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch {
    // File fsync + rename remain the fail-closed baseline on unsupported filesystems.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
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
