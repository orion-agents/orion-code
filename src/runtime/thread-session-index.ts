import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync } from 'fs';
import { basename, join } from 'path';

import { atomicWriteFileSync } from '../services/atomic-write';
import type { Message } from '../services/llm';
import { canonicalRuntimeJson, digestRuntimeValue } from './protocol/canonical';
import type { RuntimeEventEnvelopeV1 } from './protocol/runtime-protocol-v1';
import type { ThreadLogIdentityV1 } from './thread-event-store';
import type { ItemProjectionV1, ThreadProjectionV1 } from './thread-projection';

const TRANSCRIPT_PAGE_ITEMS = 100;
const MAX_MANIFEST_PAGES = 100_000;

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

export interface ThreadSessionIndexHeadV1 {
  readonly cursor: number;
  readonly projectionDigest: string;
  readonly lastEventTimestamp: number;
  readonly lastRecordHash: string | null;
  readonly log: ThreadLogIdentityV1;
}

interface StoredTranscriptPagePointerV1 {
  readonly start: number;
  readonly end: number;
  readonly file: string;
  readonly digest: string;
}

interface StoredTranscriptPageV1 {
  readonly version: 1;
  readonly threadId: string;
  readonly start: number;
  readonly end: number;
  readonly items: readonly ThreadSessionTranscriptMessageV1[];
  readonly digest: string;
}

export interface ThreadSessionIndexManifestV1 {
  readonly version: 1;
  readonly generation: number;
  readonly threadId: string;
  readonly cursor: number;
  readonly projectionDigest: string;
  readonly lastEventTimestamp: number;
  readonly lastRecordHash: string | null;
  readonly log: ThreadLogIdentityV1;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly messageCount: number;
  readonly pages: readonly StoredTranscriptPagePointerV1[];
  readonly latestTurnCommit?: ThreadSessionTurnCommitV1;
  readonly latestPlanTurnCommit?: ThreadSessionTurnCommitV1;
  readonly digest: string;
}

export interface ThreadSessionIndexedPageV1 {
  readonly manifest: ThreadSessionIndexManifestV1;
  readonly items: readonly ThreadSessionTranscriptMessageV1[];
  readonly offset: number;
  readonly nextCursor: string | null;
}

export class ThreadSessionIndexError extends Error {
  constructor(
    readonly code:
      | 'ORION_THREAD_SESSION_INDEX_CORRUPT'
      | 'ORION_THREAD_SESSION_CURSOR_INVALID'
      | 'ORION_THREAD_SESSION_CURSOR_STALE',
    message: string
  ) {
    super(message);
    this.name = 'ThreadSessionIndexError';
  }
}

export function buildThreadSessionIndexV1(input: {
  readonly rootDir: string;
  readonly threadId: string;
  readonly projection: ThreadProjectionV1;
  readonly events: readonly RuntimeEventEnvelopeV1[];
  readonly head: ThreadSessionIndexHeadV1;
}): ThreadSessionIndexManifestV1 {
  const previous = readManifest(manifestPath(input.rootDir, input.threadId), input.threadId);
  const messages = projectTranscriptMessages(input.projection.items, input.events);
  const pages: StoredTranscriptPagePointerV1[] = [];
  for (let start = 0; start < messages.length; start += TRANSCRIPT_PAGE_ITEMS) {
    pages.push(
      writeImmutablePage(
        input.rootDir,
        input.threadId,
        start,
        messages.slice(start, start + TRANSCRIPT_PAGE_ITEMS)
      )
    );
  }
  const commits = latestAuthorityCommits(input.projection);
  const manifest = createManifest({
    generation: (previous?.generation ?? 0) + 1,
    threadId: input.threadId,
    head: input.head,
    startedAt: input.events[0]?.timestamp ?? 0,
    updatedAt: input.events.at(-1)?.timestamp ?? 0,
    messageCount: messages.length,
    pages,
    ...commits,
  });
  writeManifest(input.rootDir, manifest);
  return manifest;
}

/** Advance the derived index only when it exactly matches the pre-commit head. */
export function advanceThreadSessionIndexV1(input: {
  readonly rootDir: string;
  readonly threadId: string;
  readonly previousHead: ThreadSessionIndexHeadV1;
  readonly nextHead: ThreadSessionIndexHeadV1;
  readonly projection: ThreadProjectionV1;
  readonly committedEvents: readonly RuntimeEventEnvelopeV1[];
}): boolean {
  const current = readManifest(manifestPath(input.rootDir, input.threadId), input.threadId);
  if (!current || !manifestMatchesHead(current, input.previousHead)) return false;

  const orderedItems = orderedTranscriptItems(input.projection.items);
  const messages = projectTranscriptMessages(input.projection.items, input.committedEvents);
  const committedTerminalItemIds = new Set(
    input.committedEvents
      .filter(event => event.itemId && isItemTerminalEvent(event))
      .map(event => event.itemId as string)
  );
  const appendedItems = orderedItems.slice(current.messageCount);
  if (
    orderedItems.length !== current.messageCount + messages.length ||
    appendedItems.length !== messages.length ||
    appendedItems.some(item => !committedTerminalItemIds.has(item.itemId))
  ) {
    // A message that started before the indexed tail may complete later. It
    // belongs inside the existing order, so blindly appending would publish a
    // transcript that disagrees with the authoritative startedSeq ordering.
    // Leave the old manifest stale and let the next snapshot rebuild once.
    return false;
  }
  const pages = [...current.pages];
  let messageCount = current.messageCount;
  for (let start = 0; start < messages.length; start += TRANSCRIPT_PAGE_ITEMS) {
    const chunk = messages.slice(start, start + TRANSCRIPT_PAGE_ITEMS);
    pages.push(writeImmutablePage(input.rootDir, input.threadId, messageCount, chunk));
    messageCount += chunk.length;
  }
  const nextCommits = latestAuthorityCommits(input.projection, input.committedEvents);
  const manifest = createManifest({
    generation: current.generation + 1,
    threadId: input.threadId,
    head: input.nextHead,
    startedAt: current.startedAt,
    updatedAt: input.nextHead.lastEventTimestamp,
    messageCount,
    pages,
    latestTurnCommit: nextCommits.latestTurnCommit ?? current.latestTurnCommit,
    latestPlanTurnCommit: nextCommits.latestPlanTurnCommit ?? current.latestPlanTurnCommit,
  });
  writeManifest(input.rootDir, manifest);
  return true;
}

export function loadThreadSessionIndexManifestV1(
  rootDir: string,
  threadId: string,
  head: ThreadSessionIndexHeadV1
): ThreadSessionIndexManifestV1 | undefined {
  const manifest = readManifest(manifestPath(rootDir, threadId), threadId);
  return manifest && manifestMatchesHead(manifest, head) ? manifest : undefined;
}

export function loadThreadSessionIndexedPageV1(input: {
  readonly rootDir: string;
  readonly threadId: string;
  readonly head: ThreadSessionIndexHeadV1;
  readonly cursor?: string;
  readonly pageSize?: number;
}): ThreadSessionIndexedPageV1 | undefined {
  const pageSize = input.pageSize ?? 50;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > TRANSCRIPT_PAGE_ITEMS) {
    throw new ThreadSessionIndexError(
      'ORION_THREAD_SESSION_CURSOR_INVALID',
      'Transcript pageSize must be an integer from 1 through 100.'
    );
  }
  const manifest = loadThreadSessionIndexManifestV1(input.rootDir, input.threadId, input.head);
  if (!manifest) return undefined;
  const end = input.cursor ? decodeCursor(input.cursor, manifest) : manifest.messageCount;
  const offset = Math.max(0, end - pageSize);
  const items: ThreadSessionTranscriptMessageV1[] = [];
  for (const pointer of manifest.pages) {
    if (pointer.end <= offset || pointer.start >= end) continue;
    const page = readPage(input.rootDir, input.threadId, pointer);
    const from = Math.max(offset, pointer.start) - pointer.start;
    const to = Math.min(end, pointer.end) - pointer.start;
    items.push(...page.items.slice(from, to));
  }
  if (items.length !== end - offset) {
    throw indexCorrupt('Transcript page manifest did not cover the requested range.');
  }
  return deepFreeze({
    manifest,
    items,
    offset,
    nextCursor: offset > 0 ? encodeCursor(manifest, offset) : null,
  });
}

export function projectTranscriptMessages(
  items: Readonly<Record<string, ItemProjectionV1>>,
  events: readonly RuntimeEventEnvelopeV1[]
): readonly ThreadSessionTranscriptMessageV1[] {
  const timestamps = new Map<string, number>();
  for (const event of events) {
    if (!event.itemId || !isItemTerminalEvent(event)) continue;
    timestamps.set(event.itemId, event.timestamp);
  }

  return orderedTranscriptItems(items)
    .filter(item => timestamps.has(item.itemId))
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

function orderedTranscriptItems(
  items: Readonly<Record<string, ItemProjectionV1>>
): readonly ItemProjectionV1[] {
  return Object.values(items)
    .filter(
      item => item.kind === 'message' && item.status !== 'started' && isMessageRole(item.role)
    )
    .sort((left, right) => left.startedSeq - right.startedSeq);
}

function createManifest(input: {
  readonly generation: number;
  readonly threadId: string;
  readonly head: ThreadSessionIndexHeadV1;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly messageCount: number;
  readonly pages: readonly StoredTranscriptPagePointerV1[];
  readonly latestTurnCommit?: ThreadSessionTurnCommitV1;
  readonly latestPlanTurnCommit?: ThreadSessionTurnCommitV1;
}): ThreadSessionIndexManifestV1 {
  const content = {
    version: 1 as const,
    generation: input.generation,
    threadId: input.threadId,
    cursor: input.head.cursor,
    projectionDigest: input.head.projectionDigest,
    lastEventTimestamp: input.head.lastEventTimestamp,
    lastRecordHash: input.head.lastRecordHash,
    log: { ...input.head.log },
    startedAt: input.startedAt,
    updatedAt: input.updatedAt,
    messageCount: input.messageCount,
    pages: input.pages.map(page => ({ ...page })),
    ...(input.latestTurnCommit ? { latestTurnCommit: { ...input.latestTurnCommit } } : {}),
    ...(input.latestPlanTurnCommit
      ? { latestPlanTurnCommit: { ...input.latestPlanTurnCommit } }
      : {}),
  };
  return deepFreeze({ ...content, digest: digestRuntimeValue(content) });
}

function latestAuthorityCommits(
  projection: ThreadProjectionV1,
  events?: readonly RuntimeEventEnvelopeV1[]
): {
  readonly latestTurnCommit?: ThreadSessionTurnCommitV1;
  readonly latestPlanTurnCommit?: ThreadSessionTurnCommitV1;
} {
  const committedTurns = events
    ? new Set(
        events
          .filter(event => event.payload.type === 'turn.committed' && event.turnId)
          .map(event => event.turnId as string)
      )
    : undefined;
  const commits = Object.values(projection.turns)
    .filter(turn => !committedTurns || committedTurns.has(turn.turnId))
    .flatMap(turn => (turn.commit ? [{ seq: turn.commit.seq, receipt: turn.commit.receipt }] : []))
    .sort((left, right) => left.seq - right.seq);
  const latestTurnCommit = commits.at(-1);
  const latestPlanTurnCommit = [...commits]
    .reverse()
    .find(commit => turnCommitContainsPlan(commit.receipt));
  return {
    ...(latestTurnCommit ? { latestTurnCommit } : {}),
    ...(latestPlanTurnCommit ? { latestPlanTurnCommit } : {}),
  };
}

function writeImmutablePage(
  rootDir: string,
  threadId: string,
  start: number,
  items: readonly ThreadSessionTranscriptMessageV1[]
): StoredTranscriptPagePointerV1 {
  const end = start + items.length;
  const content = {
    version: 1 as const,
    threadId,
    start,
    end,
    items: items.map(item => structuredClone(item)),
  };
  const page = deepFreeze({ ...content, digest: digestRuntimeValue(content) });
  const file = `${threadId}.${start}-${end}.${page.digest}.page.v1.json`;
  const dir = pagesDir(rootDir, threadId);
  ensurePrivateDirectory(dir);
  const path = join(dir, file);
  const existing = readStoredPage(path, threadId);
  if (!existing || existing.digest !== page.digest) {
    atomicWriteFileSync(path, `${canonicalRuntimeJson(page)}\n`, { mode: 0o600, fsync: true });
    fsyncDirectory(dir);
  }
  return { start, end, file, digest: page.digest };
}

function writeManifest(rootDir: string, manifest: ThreadSessionIndexManifestV1): void {
  ensurePrivateDirectory(rootDir);
  atomicWriteFileSync(
    manifestPath(rootDir, manifest.threadId),
    `${canonicalRuntimeJson(manifest)}\n`,
    { mode: 0o600, fsync: true }
  );
  fsyncDirectory(rootDir);
}

function readManifest(path: string, threadId: string): ThreadSessionIndexManifestV1 | null {
  const value = readRegularJson(path);
  if (!isRecord(value)) return null;
  const { digest: _digest, ...content } = value;
  void _digest;
  if (
    value.version !== 1 ||
    value.threadId !== threadId ||
    !positiveSafeInteger(value.generation) ||
    !nonNegativeSafeInteger(value.cursor) ||
    typeof value.projectionDigest !== 'string' ||
    !nonNegativeSafeInteger(value.lastEventTimestamp) ||
    (value.lastRecordHash !== null && !isSha256(value.lastRecordHash)) ||
    !isLogIdentity(value.log) ||
    !nonNegativeSafeInteger(value.startedAt) ||
    !nonNegativeSafeInteger(value.updatedAt) ||
    !nonNegativeSafeInteger(value.messageCount) ||
    !Array.isArray(value.pages) ||
    value.pages.length > MAX_MANIFEST_PAGES ||
    typeof value.digest !== 'string' ||
    digestRuntimeValue(content) !== value.digest
  ) {
    return null;
  }
  let nextStart = 0;
  for (const page of value.pages) {
    if (!isPagePointer(page, nextStart)) return null;
    nextStart = page.end as number;
  }
  if (nextStart !== value.messageCount) return null;
  if (value.latestTurnCommit !== undefined && !isTurnCommit(value.latestTurnCommit)) return null;
  if (value.latestPlanTurnCommit !== undefined && !isTurnCommit(value.latestPlanTurnCommit)) {
    return null;
  }
  return deepFreeze(value as unknown as ThreadSessionIndexManifestV1);
}

function readPage(
  rootDir: string,
  threadId: string,
  pointer: StoredTranscriptPagePointerV1
): StoredTranscriptPageV1 {
  if (basename(pointer.file) !== pointer.file) throw indexCorrupt('Transcript page path escaped.');
  const page = readStoredPage(join(pagesDir(rootDir, threadId), pointer.file), threadId);
  if (
    !page ||
    page.start !== pointer.start ||
    page.end !== pointer.end ||
    page.digest !== pointer.digest
  ) {
    throw indexCorrupt('Transcript page failed its manifest binding.');
  }
  return page;
}

function readStoredPage(path: string, threadId: string): StoredTranscriptPageV1 | null {
  const value = readRegularJson(path);
  if (!isRecord(value)) return null;
  const { digest: _digest, ...content } = value;
  void _digest;
  if (
    value.version !== 1 ||
    value.threadId !== threadId ||
    !nonNegativeSafeInteger(value.start) ||
    !nonNegativeSafeInteger(value.end) ||
    (value.end as number) <= (value.start as number) ||
    !Array.isArray(value.items) ||
    value.items.length !== (value.end as number) - (value.start as number) ||
    value.items.length > TRANSCRIPT_PAGE_ITEMS ||
    value.items.some(item => !isTranscriptMessage(item)) ||
    typeof value.digest !== 'string' ||
    digestRuntimeValue(content) !== value.digest
  ) {
    return null;
  }
  return deepFreeze(value as unknown as StoredTranscriptPageV1);
}

function manifestMatchesHead(
  manifest: ThreadSessionIndexManifestV1,
  head: ThreadSessionIndexHeadV1
): boolean {
  return (
    manifest.cursor === head.cursor &&
    manifest.projectionDigest === head.projectionDigest &&
    manifest.lastEventTimestamp === head.lastEventTimestamp &&
    manifest.lastRecordHash === head.lastRecordHash &&
    sameLogIdentity(manifest.log, head.log)
  );
}

function encodeCursor(manifest: ThreadSessionIndexManifestV1, end: number): string {
  return Buffer.from(
    canonicalRuntimeJson({
      version: 1,
      kind: 'thread-transcript',
      threadId: manifest.threadId,
      revision: manifest.digest,
      end,
    })
  ).toString('base64url');
}

function decodeCursor(cursor: string, manifest: ThreadSessionIndexManifestV1): number {
  if (!cursor || cursor.length > 1024) throw cursorInvalid();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw cursorInvalid();
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.kind !== 'thread-transcript' ||
    value.threadId !== manifest.threadId ||
    !nonNegativeSafeInteger(value.end) ||
    (value.end as number) > manifest.messageCount ||
    typeof value.revision !== 'string'
  ) {
    throw cursorInvalid();
  }
  if (value.revision !== manifest.digest) {
    throw new ThreadSessionIndexError(
      'ORION_THREAD_SESSION_CURSOR_STALE',
      'Transcript changed after this page cursor was issued.'
    );
  }
  return value.end as number;
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

function parseToolCalls(value: unknown): NonNullable<Message['tool_calls']> | undefined {
  if (value === undefined || !Array.isArray(value)) return undefined;
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

function isTranscriptMessage(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isMessageRole(value.role) ||
    typeof value.content !== 'string' ||
    !nonNegativeSafeInteger(value.timestamp)
  ) {
    return false;
  }
  if (value.modelVisibleContent !== undefined && typeof value.modelVisibleContent !== 'string') {
    return false;
  }
  if (value.toolCallId !== undefined && typeof value.toolCallId !== 'string') return false;
  if (value.appliedSkills !== undefined) {
    if (
      !Array.isArray(value.appliedSkills) ||
      value.appliedSkills.some(item => typeof item !== 'string')
    ) {
      return false;
    }
  }
  return value.tool_calls === undefined || parseToolCalls(value.tool_calls) !== undefined;
}

function isPagePointer(value: unknown, expectedStart: number): boolean {
  return (
    isRecord(value) &&
    value.start === expectedStart &&
    nonNegativeSafeInteger(value.end) &&
    (value.end as number) > expectedStart &&
    (value.end as number) - expectedStart <= TRANSCRIPT_PAGE_ITEMS &&
    typeof value.file === 'string' &&
    basename(value.file) === value.file &&
    isSha256(value.digest)
  );
}

function isTurnCommit(value: unknown): boolean {
  return isRecord(value) && positiveSafeInteger(value.seq) && typeof value.receipt === 'string';
}

function isLogIdentity(value: unknown): value is ThreadLogIdentityV1 {
  return (
    isRecord(value) &&
    nonNegativeSafeInteger(value.bytes) &&
    ['device', 'inode', 'mtimeNs', 'ctimeNs'].every(
      key => typeof value[key] === 'string' && /^\d+$/.test(value[key] as string)
    )
  );
}

function sameLogIdentity(left: ThreadLogIdentityV1, right: ThreadLogIdentityV1): boolean {
  return (
    left.bytes === right.bytes &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function turnCommitContainsPlan(receipt: string): boolean {
  try {
    const parsed = JSON.parse(receipt) as Record<string, unknown>;
    return typeof parsed.planReceipt === 'string' && parsed.planReceipt.length > 0;
  } catch {
    return false;
  }
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

function readRegularJson(path: string): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0)
    );
    if (!fstatSync(fd).isFile()) return undefined;
    return JSON.parse(readFileSync(fd, 'utf8')) as unknown;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function manifestPath(rootDir: string, threadId: string): string {
  return join(rootDir, `${threadId}.session-index.v1.json`);
}

function pagesDir(rootDir: string, threadId: string): string {
  return join(rootDir, `${threadId}.transcript-pages.v1`);
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
    // Atomic rename + file fsync remains the portable minimum.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function positiveSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function cursorInvalid(): ThreadSessionIndexError {
  return new ThreadSessionIndexError(
    'ORION_THREAD_SESSION_CURSOR_INVALID',
    'Transcript page cursor is invalid.'
  );
}

function indexCorrupt(message: string): ThreadSessionIndexError {
  return new ThreadSessionIndexError('ORION_THREAD_SESSION_INDEX_CORRUPT', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
