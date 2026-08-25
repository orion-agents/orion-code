import { canonicalRuntimeJson, digestRuntimeValue } from './protocol/canonical';
import { ThreadEventStore } from './thread-event-store';
import type {
  ToolInvocationIntentV1,
  ToolInvocationJournalEntryV1,
  ToolInvocationJournalV1,
  ToolInvocationReceiptV1,
} from './tool-gateway';

/** Durable ToolGateway journal backed by the canonical Thread event log. */
export class ThreadToolInvocationJournalV1 implements ToolInvocationJournalV1 {
  constructor(private readonly store: ThreadEventStore) {}

  async load(invocationId: string): Promise<ToolInvocationJournalEntryV1 | null> {
    const item = this.store.loadProjection().items[invocationId];
    if (!item) return null;
    if (item.kind !== 'command' || !item.intent) {
      throw new Error(`Thread item ${invocationId} is not a durable tool invocation intent`);
    }
    const intent = parseIntent(item.intent);
    const receipt = item.receipt ? parseReceipt(item.receipt) : undefined;
    if (receipt && receipt.intentDigest !== intent.digest) {
      throw new Error(`Tool receipt ${invocationId} does not match its durable intent`);
    }
    return { intent, receipt };
  }

  async begin(intent: ToolInvocationIntentV1): Promise<void> {
    if (intent.threadId !== this.store.threadId) {
      throw new Error('Tool invocation thread does not match ThreadEventStore');
    }
    this.store.appendDurable({
      turnId: intent.turnId,
      stepId: intent.stepId,
      itemId: intent.invocationId,
      payload: {
        type: 'item.started',
        data: {
          kind: 'command',
          name: intent.toolName,
          inputDigest: intent.requestDigest,
          intent: canonicalRuntimeJson(intent),
        },
      },
    });
  }

  async complete(receipt: ToolInvocationReceiptV1): Promise<void> {
    const current = await this.load(receipt.invocationId);
    if (!current || current.receipt) {
      throw new Error(`Tool invocation ${receipt.invocationId} is missing or already terminal`);
    }
    if (current.intent.digest !== receipt.intentDigest) {
      throw new Error(`Tool invocation ${receipt.invocationId} receipt does not match its intent`);
    }
    const receiptJson = canonicalRuntimeJson(receipt);
    const terminalPayload = toTerminalPayload(receipt, receiptJson);
    this.store.appendDurableBatch([
      {
        turnId: receipt.turnId,
        stepId: receipt.stepId,
        itemId: receipt.invocationId,
        payload: {
          type: 'tool.receipt',
          data: {
            invocationId: receipt.invocationId,
            terminal: receipt.terminal,
            success: receipt.success,
            outputDigest: receipt.outputDigest,
            receiptDigest: receipt.digest,
            intentDigest: receipt.intentDigest,
          },
        },
      },
      {
        turnId: receipt.turnId,
        stepId: receipt.stepId,
        itemId: receipt.invocationId,
        payload: terminalPayload,
      },
    ]);
  }
}

function toTerminalPayload(
  receipt: ToolInvocationReceiptV1,
  receiptJson: string
):
  | { type: 'item.completed'; data: { summary: string; outputDigest: string; receipt: string } }
  | { type: 'item.failed'; data: { error: string; receipt: string } }
  | { type: 'item.interrupted'; data: { reason: string; receipt: string } }
  | { type: 'item.indeterminate'; data: { reason: string; receipt: string } } {
  switch (receipt.terminal) {
    case 'completed':
      return {
        type: 'item.completed',
        data: {
          summary: receipt.result.summary ?? receipt.result.output,
          outputDigest: receipt.outputDigest,
          receipt: receiptJson,
        },
      };
    case 'failed':
      return {
        type: 'item.failed',
        data: { error: receipt.result.error ?? 'Tool failed', receipt: receiptJson },
      };
    case 'interrupted':
      return {
        type: 'item.interrupted',
        data: { reason: receipt.result.error ?? 'Tool interrupted', receipt: receiptJson },
      };
    case 'indeterminate':
      return {
        type: 'item.indeterminate',
        data: {
          reason: receipt.result.error ?? 'Tool outcome indeterminate',
          receipt: receiptJson,
        },
      };
  }
}

function parseIntent(value: string): ToolInvocationIntentV1 {
  const parsed = JSON.parse(value) as ToolInvocationIntentV1;
  const { digest, ...content } = parsed;
  if (
    parsed?.version !== 1 ||
    typeof digest !== 'string' ||
    digestRuntimeValue(content) !== digest
  ) {
    throw new Error('Durable tool invocation intent failed integrity validation');
  }
  return parsed;
}

function parseReceipt(value: string): ToolInvocationReceiptV1 {
  const parsed = JSON.parse(value) as ToolInvocationReceiptV1;
  const { digest, ...content } = parsed;
  if (
    parsed?.version !== 1 ||
    typeof digest !== 'string' ||
    digestRuntimeValue(content) !== digest
  ) {
    throw new Error('Durable tool invocation receipt failed integrity validation');
  }
  return parsed;
}
