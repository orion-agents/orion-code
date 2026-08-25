import type { CapabilityReceiptJournalCommitV1 } from '../capability-receipt-journal';
import type { CapabilityStepPersistenceBundleV1 } from '../capability-step-factory';
import type { ParentThreadForkRequestV1 } from '../subagent-thread-runtime';
import type { ThreadEventStore } from '../thread-event-store';

export interface ParentThreadStepForkSourcePortV1 {
  readonly serviceId: string;
  current(): ParentThreadForkRequestV1 | undefined;
  close(reason?: string): void;
}

export interface ParentThreadStepForkSourceOptionsV1 {
  readonly store: ThreadEventStore;
  /** Flushes parent item/tool facts immediately before SubagentThreadRuntime verifies the anchor. */
  readonly flush: () => void | Promise<void>;
}

export class ParentThreadStepForkSourceError extends Error {
  constructor(
    readonly code: 'ORION_SUBAGENT_PARENT_SOURCE_CLOSED' | 'ORION_SUBAGENT_PARENT_SOURCE_CONFLICT',
    message: string
  ) {
    super(message);
    this.name = 'ParentThreadStepForkSourceError';
  }
}

/**
 * Turn-scoped product composition seam.
 *
 * The product owner calls publishCommitted only after CapabilityReceiptJournal
 * returns. The subtask tool resolves current() at batch execution time, after
 * the active model step is known, and receives only frozen receipt identities.
 */
export class ParentThreadStepForkSourceV1 implements ParentThreadStepForkSourcePortV1 {
  readonly serviceId = 'parent-thread-step-fork-source-v1';

  private anchor: ParentThreadForkRequestV1 | undefined;
  private closed = false;

  constructor(private readonly options: ParentThreadStepForkSourceOptionsV1) {
    if (!options?.store || typeof options.flush !== 'function') {
      throw new ParentThreadStepForkSourceError(
        'ORION_SUBAGENT_PARENT_SOURCE_CONFLICT',
        'Parent step fork source requires an event store and flush function.'
      );
    }
  }

  publishCommitted(
    bundle: CapabilityStepPersistenceBundleV1,
    commit: CapabilityReceiptJournalCommitV1
  ): ParentThreadForkRequestV1 {
    if (this.closed) {
      throw new ParentThreadStepForkSourceError(
        'ORION_SUBAGENT_PARENT_SOURCE_CLOSED',
        'Closed parent step fork source cannot publish another anchor.'
      );
    }
    assertCommittedBundle(this.options.store, bundle, commit);
    if (this.anchor && this.anchor.turnId !== bundle.snapshot.turnId) {
      throw new ParentThreadStepForkSourceError(
        'ORION_SUBAGENT_PARENT_SOURCE_CONFLICT',
        `Turn ${this.anchor.turnId} must settle before publishing ${bundle.snapshot.turnId}.`
      );
    }
    this.anchor = Object.freeze({
      store: this.options.store,
      threadId: bundle.snapshot.threadId,
      turnId: bundle.snapshot.turnId,
      stepId: bundle.snapshot.stepId,
      requestId: bundle.capabilityReceipt.requestId,
      stepSnapshotDigest: bundle.snapshot.digest,
      capabilityReceiptDigest: bundle.capabilityReceipt.digest,
      flush: this.options.flush,
    });
    return this.anchor;
  }

  current(): ParentThreadForkRequestV1 | undefined {
    return this.closed ? undefined : this.anchor;
  }

  close(_reason = 'parent_turn_settled'): void {
    if (this.closed) return;
    this.closed = true;
    this.anchor = undefined;
  }
}

function assertCommittedBundle(
  store: ThreadEventStore,
  bundle: CapabilityStepPersistenceBundleV1,
  commit: CapabilityReceiptJournalCommitV1
): void {
  const [snapshotEvent, capabilityEvent] = commit.events;
  if (
    commit.events.length !== 2 ||
    commit.threadId !== store.threadId ||
    commit.threadId !== bundle.snapshot.threadId ||
    commit.turnId !== bundle.snapshot.turnId ||
    commit.stepId !== bundle.snapshot.stepId ||
    commit.stepReceiptDigest !== bundle.receipt.digest ||
    commit.firstSeq + 1 !== commit.lastSeq ||
    snapshotEvent?.seq !== commit.firstSeq ||
    capabilityEvent?.seq !== commit.lastSeq ||
    snapshotEvent?.payload.type !== 'step.snapshot' ||
    capabilityEvent?.payload.type !== 'capability.receipt' ||
    snapshotEvent.turnId !== bundle.snapshot.turnId ||
    capabilityEvent.turnId !== bundle.snapshot.turnId ||
    snapshotEvent.stepId !== bundle.snapshot.stepId ||
    capabilityEvent.stepId !== bundle.snapshot.stepId ||
    snapshotEvent.payload.data.snapshotId !== bundle.snapshot.stepId ||
    snapshotEvent.payload.data.digest !== bundle.snapshot.digest ||
    capabilityEvent.payload.data.receiptId !== bundle.capabilityReceipt.requestId ||
    capabilityEvent.payload.data.digest !== bundle.capabilityReceipt.digest
  ) {
    throw new ParentThreadStepForkSourceError(
      'ORION_SUBAGENT_PARENT_SOURCE_CONFLICT',
      'Capability journal commit does not match the parent step persistence bundle.'
    );
  }
}
