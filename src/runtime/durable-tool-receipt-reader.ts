import { openSessionStorageV1 } from './legacy-thread-materializer';
import type { ThreadEventStore } from './thread-event-store';
import type { ItemProjectionV1 } from './thread-projection';
import {
  DurableToolReceiptValidationError,
  validateDurableToolInvocationReceiptV1,
} from './tool-receipt-validator';
import type { ToolInvocationReceiptV1 } from './tool-gateway';
import { listProjectSessions } from '../services/session-storage';

const MAX_PROJECT_RECEIPTS = 100;
const MAX_SCANNED_SESSIONS = 100;

export interface VerifiedDurableToolReceiptRefV1 {
  readonly sessionId: string;
  readonly threadId: string;
  readonly callId: string;
  readonly sequence: number;
  readonly toolName: string;
  readonly terminal: ToolInvocationReceiptV1['terminal'];
  readonly success: boolean;
  readonly outputBytes: number;
  readonly hasArtifact: boolean;
  readonly executionPolicyDigest: string;
  readonly receiptDigest: string;
  readonly finishedAt: number;
}

export class DurableToolReceiptReaderError extends Error {
  constructor(
    readonly code:
      | 'ORION_DURABLE_TOOL_RECEIPT_SOURCE_CORRUPT'
      | 'ORION_DURABLE_TOOL_RECEIPT_CONFLICT',
    message: string
  ) {
    super(message);
    this.name = 'DurableToolReceiptReaderError';
  }
}

/** Read the newest verified receipt references across one project's durable Threads. */
export function listProjectDurableToolReceiptRefsV1(
  projectPath: string,
  limit = MAX_PROJECT_RECEIPTS
): readonly VerifiedDurableToolReceiptRefV1[] {
  const safeLimit = boundedLimit(limit);
  const receipts: VerifiedDurableToolReceiptRefV1[] = [];
  const byCallId = new Map<string, string>();
  const sessions = listProjectSessions(projectPath, MAX_SCANNED_SESSIONS);
  for (const session of sessions) {
    let sessionReceipts: readonly VerifiedDurableToolReceiptRefV1[];
    try {
      const opened = openSessionStorageV1(projectPath, session.id);
      if (opened.resolution.kind === 'legacy' || !('store' in opened)) continue;
      sessionReceipts = readDurableToolReceiptRefsFromStoreV1({
        sessionId: session.id,
        store: opened.store,
        limit: safeLimit,
      });
    } catch (error) {
      const detail =
        error instanceof DurableToolReceiptValidationError ? 'receipt validation' : 'Thread facts';
      throw new DurableToolReceiptReaderError(
        'ORION_DURABLE_TOOL_RECEIPT_SOURCE_CORRUPT',
        `Durable ${detail} failed closed.`
      );
    }
    for (const receipt of sessionReceipts) {
      const existing = byCallId.get(receipt.callId);
      if (existing && existing !== receipt.receiptDigest) {
        throw new DurableToolReceiptReaderError(
          'ORION_DURABLE_TOOL_RECEIPT_CONFLICT',
          'A Tool invocation has conflicting durable receipts.'
        );
      }
      if (existing) continue;
      byCallId.set(receipt.callId, receipt.receiptDigest);
      receipts.push(receipt);
    }
  }
  receipts.sort(
    (left, right) =>
      right.finishedAt - left.finishedAt || left.receiptDigest.localeCompare(right.receiptDigest)
  );
  return Object.freeze(receipts.slice(0, safeLimit));
}

/**
 * Read a verified Thread projection and validate each selected terminal tool
 * against the adjacent durable `tool.receipt` fact in the hash-chained log.
 */
export function readDurableToolReceiptRefsFromStoreV1(input: {
  readonly sessionId: string;
  readonly store: ThreadEventStore;
  readonly limit?: number;
}): readonly VerifiedDurableToolReceiptRefV1[] {
  const limit = boundedLimit(input.limit ?? MAX_PROJECT_RECEIPTS);
  const projection = input.store.loadProjection();
  const items = Object.values(projection.items)
    .filter(isTerminalToolItem)
    .sort((left, right) => (right.terminalSeq ?? 0) - (left.terminalSeq ?? 0))
    .slice(0, limit);
  const receipts = items.map(item => readItemReceipt(input.sessionId, input.store, item));
  return Object.freeze(receipts);
}

function readItemReceipt(
  sessionId: string,
  store: ThreadEventStore,
  item: ItemProjectionV1
): VerifiedDurableToolReceiptRefV1 {
  const terminalSeq = item.terminalSeq;
  const toolName = item.name?.trim();
  if (!terminalSeq || terminalSeq < 2 || !toolName || !item.receipt) {
    throw new DurableToolReceiptValidationError(
      'Terminal tool projection is missing its canonical receipt identity.'
    );
  }
  const pair = store.replay(terminalSeq - 2, 2, 'durable_tool_receipt').events;
  const factEvent = pair.find(event => event.seq === terminalSeq - 1);
  const terminalEvent = pair.find(event => event.seq === terminalSeq);
  if (!factEvent || !terminalEvent || terminalEvent.itemId !== item.itemId) {
    throw new DurableToolReceiptValidationError(
      'Terminal tool projection is missing its durable receipt pair.'
    );
  }
  const receipt = validateDurableToolInvocationReceiptV1({
    factEvent,
    terminalEvent,
    item: { itemId: item.itemId, toolName },
  });
  return Object.freeze({
    sessionId,
    threadId: projectionThreadId(terminalEvent.threadId, store.threadId),
    callId: receipt.invocationId,
    sequence: terminalSeq,
    toolName: receipt.toolName,
    terminal: receipt.terminal,
    success: receipt.success,
    outputBytes: receiptOutputBytes(receipt),
    hasArtifact: validArtifactRef(receipt.result.artifactRef),
    executionPolicyDigest: receipt.executionPolicyDigest,
    receiptDigest: receipt.digest,
    finishedAt: receipt.finishedAt,
  });
}

function isTerminalToolItem(item: ItemProjectionV1): boolean {
  return (
    (item.kind === 'command' || item.kind === 'file_change' || item.kind === 'mcp') &&
    item.status !== 'started'
  );
}

function receiptOutputBytes(receipt: ToolInvocationReceiptV1): number {
  const explicit = receipt.result.outputBytes;
  return Number.isSafeInteger(explicit) && Number(explicit) >= 0
    ? Number(explicit)
    : Buffer.byteLength(receipt.result.output, 'utf8');
}

function validArtifactRef(value: ToolInvocationReceiptV1['result']['artifactRef']): boolean {
  return Boolean(
    value &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    Number.isSafeInteger(value.outputBytes) &&
    value.outputBytes >= 0
  );
}

function projectionThreadId(eventThreadId: string, storeThreadId: string): string {
  if (eventThreadId !== storeThreadId) {
    throw new DurableToolReceiptValidationError(
      'Tool receipt Thread identity differs from its durable Store.'
    );
  }
  return eventThreadId;
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PROJECT_RECEIPTS) {
    throw new Error(`receipt limit must be an integer from 1 through ${MAX_PROJECT_RECEIPTS}`);
  }
  return value;
}
