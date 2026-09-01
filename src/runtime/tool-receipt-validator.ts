import { digestRuntimeValue } from './protocol/canonical';
import { isRuntimeId, type RuntimeEventEnvelopeV1 } from './protocol/runtime-protocol-v1';
import type {
  SandboxPreparationV1,
  ToolApprovalDecisionV1,
  ToolInvocationReceiptV1,
  ToolPolicyDecisionV1,
} from './tool-gateway';

export interface DurableToolReceiptItemV1 {
  readonly itemId: string;
  readonly toolName: string;
}

export class DurableToolReceiptValidationError extends Error {
  readonly code = 'ORION_DURABLE_TOOL_RECEIPT_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'DurableToolReceiptValidationError';
  }
}

/**
 * Validate the canonical terminal receipt against its separate durable
 * `tool.receipt` fact. Neither digest is projected until both envelopes,
 * identities and independently stored terminal facts agree.
 */
export function validateDurableToolInvocationReceiptV1(input: {
  readonly terminalEvent: RuntimeEventEnvelopeV1;
  readonly factEvent: RuntimeEventEnvelopeV1;
  readonly item: DurableToolReceiptItemV1;
}): ToolInvocationReceiptV1 {
  const { terminalEvent, factEvent, item } = input;
  if (!isTerminalItemEvent(terminalEvent) || terminalEvent.durability !== 'durable') {
    throw invalid('Tool terminal event is not a durable terminal fact.');
  }
  if (factEvent.payload.type !== 'tool.receipt' || factEvent.durability !== 'durable') {
    throw invalid('Tool receipt fact is not durable.');
  }
  if (
    !item.itemId ||
    !item.toolName ||
    terminalEvent.itemId !== item.itemId ||
    factEvent.itemId !== item.itemId ||
    factEvent.payload.data.invocationId !== item.itemId ||
    factEvent.threadId !== terminalEvent.threadId ||
    factEvent.turnId !== terminalEvent.turnId ||
    factEvent.stepId !== terminalEvent.stepId ||
    factEvent.seq + 1 !== terminalEvent.seq
  ) {
    throw invalid('Durable tool receipt identities do not match.');
  }

  const receiptJson = terminalEvent.payload.data.receipt;
  if (typeof receiptJson !== 'string' || !receiptJson) {
    throw invalid('Tool terminal event has no canonical receipt.');
  }
  let parsed: ToolInvocationReceiptV1;
  try {
    parsed = JSON.parse(receiptJson) as ToolInvocationReceiptV1;
  } catch {
    throw invalid('Canonical ToolInvocationReceipt is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalid('Canonical ToolInvocationReceipt is not an object.');
  }

  const { digest, ...content } = parsed;
  const terminal = terminalReceiptStatus(terminalEvent);
  if (
    parsed.version !== 1 ||
    !isSha256(digest) ||
    digestRuntimeValue(content) !== digest ||
    !isRuntimeId(parsed.invocationId) ||
    (parsed.parentInvocationId !== undefined && !isRuntimeId(parsed.parentInvocationId)) ||
    !isRuntimeId(parsed.threadId) ||
    !isRuntimeId(parsed.turnId) ||
    !isRuntimeId(parsed.stepId) ||
    parsed.invocationId !== item.itemId ||
    parsed.invocationId !== terminalEvent.itemId ||
    parsed.threadId !== terminalEvent.threadId ||
    parsed.turnId !== terminalEvent.turnId ||
    parsed.stepId !== terminalEvent.stepId ||
    parsed.toolName !== item.toolName ||
    parsed.terminal !== terminal ||
    !isSha256(parsed.snapshotDigest) ||
    !isSha256(parsed.routerDigest) ||
    !isSha256(parsed.authorityDigest) ||
    !isSha256(parsed.executionPolicyDigest) ||
    !isSha256(parsed.intentDigest) ||
    !isSha256(parsed.outputDigest) ||
    !validToolResult(parsed.result) ||
    digestRuntimeValue(parsed.result) !== parsed.outputDigest ||
    parsed.success !== (parsed.terminal === 'completed' && parsed.result.success) ||
    !Number.isSafeInteger(parsed.startedAt) ||
    parsed.startedAt < 0 ||
    !Number.isSafeInteger(parsed.finishedAt) ||
    parsed.finishedAt < parsed.startedAt ||
    !Number.isSafeInteger(parsed.durationMs) ||
    parsed.durationMs < 0 ||
    !['capability', 'policy', 'approval', 'sandbox', 'execute'].includes(parsed.terminalPhase)
  ) {
    throw invalid('Canonical ToolInvocationReceipt failed integrity validation.');
  }
  validateEmbeddedDecision(parsed.policy, 'policy');
  validateEmbeddedDecision(parsed.approval, 'approval');
  validateEmbeddedDecision(parsed.sandbox, 'sandbox');

  const fact = factEvent.payload.data;
  if (
    fact.invocationId !== parsed.invocationId ||
    fact.terminal !== parsed.terminal ||
    fact.success !== parsed.success ||
    fact.outputDigest !== parsed.outputDigest ||
    fact.receiptDigest !== parsed.digest ||
    fact.intentDigest !== parsed.intentDigest
  ) {
    throw invalid('Durable tool receipt fact does not match its canonical receipt.');
  }
  if (
    terminalEvent.payload.type === 'item.completed' &&
    terminalEvent.payload.data.outputDigest !== undefined &&
    terminalEvent.payload.data.outputDigest !== parsed.outputDigest
  ) {
    throw invalid('Tool terminal output digest does not match its canonical receipt.');
  }
  return parsed;
}

function isTerminalItemEvent(event: RuntimeEventEnvelopeV1): event is RuntimeEventEnvelopeV1<
  Extract<
    RuntimeEventEnvelopeV1['payload'],
    {
      type: 'item.completed' | 'item.failed' | 'item.interrupted' | 'item.indeterminate';
    }
  >
> {
  return (
    event.payload.type === 'item.completed' ||
    event.payload.type === 'item.failed' ||
    event.payload.type === 'item.interrupted' ||
    event.payload.type === 'item.indeterminate'
  );
}

function terminalReceiptStatus(event: RuntimeEventEnvelopeV1): ToolInvocationReceiptV1['terminal'] {
  switch (event.payload.type) {
    case 'item.completed':
      return 'completed';
    case 'item.failed':
      return 'failed';
    case 'item.interrupted':
      return 'interrupted';
    case 'item.indeterminate':
      return 'indeterminate';
    default:
      throw invalid('Tool event is not terminal.');
  }
}

function validateEmbeddedDecision(
  value: ToolPolicyDecisionV1 | ToolApprovalDecisionV1 | SandboxPreparationV1 | undefined,
  label: string
): void {
  if (!value) return;
  const { digest, ...content } = value;
  if (!isSha256(digest) || digestRuntimeValue(content) !== digest) {
    throw invalid(`Canonical ToolInvocationReceipt ${label} decision is invalid.`);
  }
}

function validToolResult(value: ToolInvocationReceiptV1['result']): boolean {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.success === 'boolean' &&
    typeof value.output === 'string' &&
    (value.outputBytes === undefined ||
      (Number.isSafeInteger(value.outputBytes) && Number(value.outputBytes) >= 0)) &&
    (value.artifactRef === undefined ||
      (Boolean(value.artifactRef) &&
        typeof value.artifactRef === 'object' &&
        typeof value.artifactRef.id === 'string' &&
        value.artifactRef.id.length > 0 &&
        Number.isSafeInteger(value.artifactRef.outputBytes) &&
        value.artifactRef.outputBytes >= 0))
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function invalid(message: string): DurableToolReceiptValidationError {
  return new DurableToolReceiptValidationError(message);
}
