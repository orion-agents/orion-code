import type {
  CapabilityStepPersistenceBundleV1,
  CapabilityStepReceiptV1,
} from './capability-step-factory';
import type { CapabilityReceiptV1 } from './capabilities';
import { withFileLockSync } from '../services/file-lock';
import { canonicalRuntimeJson, digestRuntimeValue } from './protocol/canonical';
import { isRuntimeId, type RuntimeEventEnvelopeV1 } from './protocol/runtime-protocol-v1';
import type { StepSnapshotV1 } from './step-snapshot';
import { ThreadEventStore } from './thread-event-store';

export type CapabilityReceiptJournalStatusV1 = 'committed' | 'existing';

export interface CapabilityReceiptJournalCommitV1 {
  readonly status: CapabilityReceiptJournalStatusV1;
  readonly threadId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly events: readonly RuntimeEventEnvelopeV1[];
  readonly stepReceiptDigest: string;
}

type CapabilityReceiptJournalErrorCode =
  | 'ORION_CAPABILITY_RECEIPT_IDENTITY'
  | 'ORION_CAPABILITY_RECEIPT_INTEGRITY'
  | 'ORION_CAPABILITY_RECEIPT_CONFLICT'
  | 'ORION_CAPABILITY_RECEIPT_TURN_STATE';

export class CapabilityReceiptJournalError extends Error {
  constructor(
    public readonly code: CapabilityReceiptJournalErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'CapabilityReceiptJournalError';
  }
}

interface DurablePayloadsV1 {
  readonly stepSnapshot: {
    readonly type: 'step.snapshot';
    readonly data: {
      readonly snapshotId: string;
      readonly digest: string;
      readonly receipt: string;
    };
  };
  readonly capabilityReceipt: {
    readonly type: 'capability.receipt';
    readonly data: {
      readonly receiptId: string;
      readonly digest: string;
      readonly receipt: string;
    };
  };
}

interface StepSnapshotDurableReceiptV1 {
  readonly version: 1;
  readonly snapshotId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly snapshotDigest: string;
  readonly toolRouter: ReturnType<StepSnapshotV1['toolRouter']['toReceipt']>;
  readonly promptDigest: string;
  readonly taskContextRevision: number;
  readonly stepReceipt: CapabilityStepReceiptV1;
  readonly capabilityReceiptDigest: string;
  readonly digest: string;
}

/** Atomically persists one validated StepSnapshot/CapabilityReceipt pair. */
export class CapabilityReceiptJournalV1 {
  constructor(private readonly store: ThreadEventStore) {}

  commit(bundle: CapabilityStepPersistenceBundleV1): CapabilityReceiptJournalCommitV1 {
    validateBundle(bundle, this.store.threadId);
    const payloads = createDurablePayloads(bundle);
    return withFileLockSync(
      `${this.store.logPath}.capability-receipt-journal-v1`,
      () => this.commitLocked(bundle, payloads),
      { waitMs: 10_000 }
    );
  }

  private commitLocked(
    bundle: CapabilityStepPersistenceBundleV1,
    payloads: DurablePayloadsV1
  ): CapabilityReceiptJournalCommitV1 {
    const existing = this.resolveExisting(bundle, payloads);
    if (existing) return existing;

    const projection = this.store.loadProjection();
    const turn = projection.turns[bundle.snapshot.turnId];
    if (!turn || turn.status !== 'active' || projection.activeTurnId !== turn.turnId) {
      throw new CapabilityReceiptJournalError(
        'ORION_CAPABILITY_RECEIPT_TURN_STATE',
        `Step ${bundle.snapshot.stepId} can only be committed to its active turn.`
      );
    }
    if (turn.commit) {
      throw new CapabilityReceiptJournalError(
        'ORION_CAPABILITY_RECEIPT_TURN_STATE',
        `Turn ${turn.turnId} already has a terminal commit receipt.`
      );
    }

    const committed = this.store.appendDurableBatch([
      {
        turnId: bundle.snapshot.turnId,
        stepId: bundle.snapshot.stepId,
        payload: payloads.stepSnapshot,
      },
      {
        turnId: bundle.snapshot.turnId,
        stepId: bundle.snapshot.stepId,
        payload: payloads.capabilityReceipt,
      },
    ]);
    return createCommitResult('committed', bundle, committed.events);
  }

  private resolveExisting(
    bundle: CapabilityStepPersistenceBundleV1,
    expected: DurablePayloadsV1
  ): CapabilityReceiptJournalCommitV1 | undefined {
    const allEvents = replayAll(this.store);
    const stepId = bundle.snapshot.stepId;
    const receiptId = bundle.capabilityReceipt.requestId;
    const related = allEvents.filter(event => {
      if (event.payload.type === 'step.snapshot') {
        return event.stepId === stepId || event.payload.data.snapshotId === stepId;
      }
      if (event.payload.type === 'capability.receipt') {
        return event.stepId === stepId || event.payload.data.receiptId === receiptId;
      }
      return false;
    });
    if (related.length === 0) return undefined;

    const snapshots = related.filter(event => event.payload.type === 'step.snapshot');
    const receipts = related.filter(event => event.payload.type === 'capability.receipt');
    const exactPair =
      snapshots.length === 1 &&
      receipts.length === 1 &&
      snapshots[0].seq + 1 === receipts[0].seq &&
      snapshots[0].threadId === bundle.snapshot.threadId &&
      snapshots[0].turnId === bundle.snapshot.turnId &&
      snapshots[0].stepId === stepId &&
      receipts[0].threadId === bundle.snapshot.threadId &&
      receipts[0].turnId === bundle.snapshot.turnId &&
      receipts[0].stepId === stepId &&
      canonicalRuntimeJson(snapshots[0].payload) === canonicalRuntimeJson(expected.stepSnapshot) &&
      canonicalRuntimeJson(receipts[0].payload) ===
        canonicalRuntimeJson(expected.capabilityReceipt);

    if (!exactPair) {
      throw new CapabilityReceiptJournalError(
        'ORION_CAPABILITY_RECEIPT_CONFLICT',
        `Durable capability facts already conflict with step ${stepId}.`
      );
    }
    return createCommitResult('existing', bundle, [snapshots[0], receipts[0]]);
  }
}

function validateBundle(bundle: CapabilityStepPersistenceBundleV1, storeThreadId: string): void {
  if (!bundle || !bundle.snapshot || !bundle.capabilityReceipt || !bundle.receipt) {
    integrityError('Capability persistence bundle is incomplete.');
  }
  const { snapshot, capabilityReceipt, receipt } = bundle;
  for (const [name, value] of [
    ['store threadId', storeThreadId],
    ['snapshot threadId', snapshot.threadId],
    ['snapshot turnId', snapshot.turnId],
    ['snapshot stepId', snapshot.stepId],
  ] as const) {
    if (!isRuntimeId(value)) identityError(`${name} must be a UUID.`);
  }
  if (snapshot.threadId !== storeThreadId) {
    identityError('StepSnapshot threadId does not match ThreadEventStore.');
  }
  if (
    receipt.threadId !== snapshot.threadId ||
    capabilityReceipt.threadId !== snapshot.threadId ||
    receipt.turnId !== snapshot.turnId ||
    capabilityReceipt.turnId !== snapshot.turnId ||
    receipt.stepId !== snapshot.stepId ||
    capabilityReceipt.stepId !== snapshot.stepId
  ) {
    identityError('StepSnapshot, StepReceipt and CapabilityReceipt identities do not match.');
  }

  assertDigest('CapabilityStepReceipt', receipt);
  assertDigest('CapabilityReceipt', capabilityReceipt);
  assertEmbeddedDigest('CapabilityPlan', snapshot.capabilityPlan);
  assertEmbeddedDigest('AuthoritySnapshot', snapshot.authority);
  assertEmbeddedDigest('ExecutionPolicySnapshot', snapshot.executionPolicy);
  assertEmbeddedDigest('SkillSnapshot', snapshot.skills);
  assertEmbeddedDigest('McpBindingSnapshot', snapshot.mcp);
  try {
    snapshot.toolRouter.assertIntegrity();
  } catch (error) {
    integrityError(
      `ToolRouter integrity is invalid: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const expectedSnapshotDigest = recomputeSnapshotDigest(snapshot);
  if (snapshot.digest !== expectedSnapshotDigest) {
    integrityError('StepSnapshot digest does not match its captured content.');
  }
  if (
    receipt.snapshotDigest !== snapshot.digest ||
    receipt.capabilityReceiptDigest !== capabilityReceipt.digest ||
    receipt.promptDigest !== snapshot.prompt.digest
  ) {
    integrityError('CapabilityStepReceipt digest chain does not match the bundle.');
  }
  const promptReceipt = capabilityReceipt.promptManifest.find(
    section => section.id === 'final-model-messages'
  );
  if (!promptReceipt?.selected || promptReceipt.digest !== snapshot.prompt.digest) {
    integrityError('CapabilityReceipt is not bound to the final StepSnapshot prompt.');
  }

  const routerReceipt = snapshot.toolRouter.toReceipt();
  const directToolNames = snapshot.toolRouter.descriptors.map(descriptor => descriptor.name);
  if (
    capabilityReceipt.planDigest !== snapshot.capabilityPlan.digest ||
    capabilityReceipt.toolSchemaDigest !== routerReceipt.visibleSchemaDigest ||
    capabilityReceipt.toolBindingDigest !== routerReceipt.bindingDigest ||
    capabilityReceipt.toolRouterDigest !== routerReceipt.digest ||
    digestRuntimeValue(capabilityReceipt.directToolNames) !== digestRuntimeValue(directToolNames) ||
    capabilityReceipt.toolSchemaBytes !==
      Buffer.byteLength(canonicalRuntimeJson(snapshot.toolRouter.visibleSchemas), 'utf8') ||
    capabilityReceipt.authorityDigest !== snapshot.authority.digest ||
    capabilityReceipt.executionPolicyDigest !== snapshot.executionPolicy.digest ||
    capabilityReceipt.skillCatalogDigest !== snapshot.skills.catalogDigest ||
    capabilityReceipt.mcpCatalogDigest !== snapshot.mcp.catalogDigest ||
    capabilityReceipt.taskContextRevision !== snapshot.taskContextRevision
  ) {
    integrityError('CapabilityReceipt does not match the final StepSnapshot bindings.');
  }
}

function recomputeSnapshotDigest(snapshot: StepSnapshotV1): string {
  return digestRuntimeValue({
    version: snapshot.version,
    threadId: snapshot.threadId,
    turnId: snapshot.turnId,
    stepId: snapshot.stepId,
    taskEpoch: snapshot.taskEpoch,
    baseMode: snapshot.baseMode,
    model: snapshot.model,
    authority: snapshot.authority,
    executionPolicy: snapshot.executionPolicy,
    environment: snapshot.environment,
    capabilityPlan: snapshot.capabilityPlan,
    prompt: snapshot.prompt,
    skills: snapshot.skills,
    mcp: snapshot.mcp,
    taskContextRevision: snapshot.taskContextRevision,
    toolRouterReceipt: snapshot.toolRouter.toReceipt(),
  });
}

function assertDigest(name: string, value: CapabilityStepReceiptV1 | CapabilityReceiptV1): void {
  const { digest, ...content } = value;
  if (digestRuntimeValue(content) !== digest) integrityError(`${name} digest is invalid.`);
}

function assertEmbeddedDigest<T extends object & { readonly digest: string }>(
  name: string,
  value: T
): void {
  const { digest, ...content } = value as T & Record<string, unknown>;
  if (digestRuntimeValue(content) !== digest) integrityError(`${name} digest is invalid.`);
}

function createDurablePayloads(bundle: CapabilityStepPersistenceBundleV1): DurablePayloadsV1 {
  const stepSnapshotReceipt = createStepSnapshotDurableReceipt(bundle);
  return {
    stepSnapshot: {
      type: 'step.snapshot',
      data: {
        snapshotId: bundle.snapshot.stepId,
        digest: bundle.snapshot.digest,
        receipt: canonicalRuntimeJson(stepSnapshotReceipt),
      },
    },
    capabilityReceipt: {
      type: 'capability.receipt',
      data: {
        receiptId: bundle.capabilityReceipt.requestId,
        digest: bundle.capabilityReceipt.digest,
        receipt: canonicalRuntimeJson(bundle.capabilityReceipt),
      },
    },
  };
}

function createStepSnapshotDurableReceipt(
  bundle: CapabilityStepPersistenceBundleV1
): StepSnapshotDurableReceiptV1 {
  const content = {
    version: 1 as const,
    snapshotId: bundle.snapshot.stepId,
    threadId: bundle.snapshot.threadId,
    turnId: bundle.snapshot.turnId,
    stepId: bundle.snapshot.stepId,
    snapshotDigest: bundle.snapshot.digest,
    toolRouter: bundle.snapshot.toolRouter.toReceipt(),
    promptDigest: bundle.snapshot.prompt.digest,
    taskContextRevision: bundle.snapshot.taskContextRevision,
    stepReceipt: bundle.receipt,
    capabilityReceiptDigest: bundle.capabilityReceipt.digest,
  };
  return freeze({ ...content, digest: digestRuntimeValue(content) });
}

function replayAll(store: ThreadEventStore): readonly RuntimeEventEnvelopeV1[] {
  const events: RuntimeEventEnvelopeV1[] = [];
  let cursor = 0;
  while (true) {
    const page = store.replay(cursor);
    events.push(...page.events);
    if (!page.hasMore) return events;
    if (page.nextCursor <= cursor) {
      throw new CapabilityReceiptJournalError(
        'ORION_CAPABILITY_RECEIPT_CONFLICT',
        'ThreadEventStore replay cursor did not advance.'
      );
    }
    cursor = page.nextCursor;
  }
}

function createCommitResult(
  status: CapabilityReceiptJournalStatusV1,
  bundle: CapabilityStepPersistenceBundleV1,
  events: readonly RuntimeEventEnvelopeV1[]
): CapabilityReceiptJournalCommitV1 {
  if (events.length !== 2) {
    throw new CapabilityReceiptJournalError(
      'ORION_CAPABILITY_RECEIPT_CONFLICT',
      'Capability receipt commits must contain exactly two durable events.'
    );
  }
  return freeze({
    status,
    threadId: bundle.snapshot.threadId,
    turnId: bundle.snapshot.turnId,
    stepId: bundle.snapshot.stepId,
    firstSeq: events[0].seq,
    lastSeq: events[1].seq,
    events: [...events],
    stepReceiptDigest: bundle.receipt.digest,
  });
}

function identityError(message: string): never {
  throw new CapabilityReceiptJournalError('ORION_CAPABILITY_RECEIPT_IDENTITY', message);
}

function integrityError(message: string): never {
  throw new CapabilityReceiptJournalError('ORION_CAPABILITY_RECEIPT_INTEGRITY', message);
}

function freeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) freeze(nested);
  return Object.freeze(value);
}
