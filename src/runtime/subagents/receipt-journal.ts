import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

import { atomicWriteFileSync } from '../../services/atomic-write';
import { canonicalRuntimeJson } from '../protocol/canonical';
import {
  assertSubagentThreadReceiptV1,
  type SubagentThreadReceiptV1,
} from '../subagent-thread-runtime';

export class SubagentReceiptJournalError extends Error {
  constructor(
    readonly code:
      | 'ORION_SUBAGENT_RECEIPT_JOURNAL_INVALID'
      | 'ORION_SUBAGENT_RECEIPT_JOURNAL_CONFLICT',
    message: string
  ) {
    super(message);
    this.name = 'SubagentReceiptJournalError';
  }
}

/**
 * Durable, idempotent sidecar for the parent-facing child receipt.
 *
 * Child Step/Tool/Turn receipts remain authoritative in the child
 * ThreadEventStore. This journal makes their digest chain discoverable even
 * when the parent process exits immediately after the child finishes.
 */
export class SubagentReceiptJournalV1 {
  readonly rootDir: string;

  constructor(rootDir: string) {
    if (!rootDir.trim()) {
      throw new SubagentReceiptJournalError(
        'ORION_SUBAGENT_RECEIPT_JOURNAL_INVALID',
        'Subagent receipt journal root is required.'
      );
    }
    this.rootDir = resolve(rootDir);
  }

  commit(receipt: SubagentThreadReceiptV1): SubagentThreadReceiptV1 {
    assertSubagentThreadReceiptV1(receipt);
    const path = this.pathFor(receipt.receiptId);
    if (existsSync(path)) {
      const existing = this.read(receipt.receiptId);
      if (existing.digest === receipt.digest) return existing;
      throw new SubagentReceiptJournalError(
        'ORION_SUBAGENT_RECEIPT_JOURNAL_CONFLICT',
        `Receipt ${receipt.receiptId} already has a different durable digest.`
      );
    }
    mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    atomicWriteFileSync(path, `${canonicalRuntimeJson(receipt)}\n`, { mode: 0o600, fsync: true });
    return receipt;
  }

  read(receiptId: string): SubagentThreadReceiptV1 {
    let receipt: SubagentThreadReceiptV1;
    try {
      receipt = JSON.parse(
        readFileSync(this.pathFor(receiptId), 'utf8')
      ) as SubagentThreadReceiptV1;
    } catch (error) {
      throw new SubagentReceiptJournalError(
        'ORION_SUBAGENT_RECEIPT_JOURNAL_INVALID',
        `Receipt ${receiptId} could not be read: ${errorMessage(error)}`
      );
    }
    try {
      assertSubagentThreadReceiptV1(receipt);
    } catch (error) {
      throw new SubagentReceiptJournalError(
        'ORION_SUBAGENT_RECEIPT_JOURNAL_INVALID',
        `Receipt ${receiptId} failed integrity validation: ${errorMessage(error)}`
      );
    }
    if (receipt.receiptId !== receiptId) {
      throw new SubagentReceiptJournalError(
        'ORION_SUBAGENT_RECEIPT_JOURNAL_INVALID',
        `Receipt filename identity does not match ${receiptId}.`
      );
    }
    return receipt;
  }

  pathFor(receiptId: string): string {
    if (!/^[0-9a-f-]{36}$/iu.test(receiptId)) {
      throw new SubagentReceiptJournalError(
        'ORION_SUBAGENT_RECEIPT_JOURNAL_INVALID',
        'Receipt ID must be a UUID.'
      );
    }
    return join(this.rootDir, `${receiptId}.subagent-receipt.v1.json`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
