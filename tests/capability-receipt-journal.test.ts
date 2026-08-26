import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { Message } from '../src/services/llm';
import type { CapabilityToolCandidateV1 } from '../src/runtime/capabilities';
import {
  CapabilityReceiptJournalError,
  CapabilityReceiptJournalV1,
} from '../src/runtime/capability-receipt-journal';
import {
  CapabilityAgentLoopStepFactoryV1,
  type CapabilityStepConfigurationV1,
  type CapabilityStepPersistenceBundleV1,
} from '../src/runtime/capability-step-factory';
import { canonicalRuntimeJson, digestRuntimeValue } from '../src/runtime/protocol/canonical';
import {
  createAuthoritySnapshotV1,
  createExecutionPolicySnapshotV1,
  type ToolBindingDescriptorV1,
  type ToolBindingV1,
} from '../src/runtime/step-snapshot';
import { ThreadEventStore } from '../src/runtime/thread-event-store';

interface ActiveStoreFixture {
  readonly store: ThreadEventStore;
  readonly threadId: string;
  readonly turnId: string;
}

interface ToolFixture {
  readonly candidate: CapabilityToolCandidateV1;
  readonly binding: ToolBindingV1;
}

describe('CapabilityReceiptJournalV1', () => {
  const roots: string[] = [];

  afterEach(() => {
    jest.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test('appends the StepSnapshot and CapabilityReceipt as one adjacent durable batch', async () => {
    const fixture = createActiveStore(roots);
    const bundle = await createBundle(fixture.threadId, fixture.turnId, randomUUID());
    const append = jest.spyOn(fixture.store, 'appendDurableBatch');

    const result = new CapabilityReceiptJournalV1(fixture.store).commit(bundle);

    expect(result).toMatchObject({
      status: 'committed',
      threadId: fixture.threadId,
      turnId: fixture.turnId,
      stepId: bundle.snapshot.stepId,
      firstSeq: 3,
      lastSeq: 4,
      stepReceiptDigest: bundle.receipt.digest,
    });
    expect(result.events.map(event => event.payload.type)).toEqual([
      'step.snapshot',
      'capability.receipt',
    ]);
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][0]).toHaveLength(2);

    const [snapshotEvent, capabilityEvent] = result.events;
    expect(snapshotEvent).toMatchObject({
      turnId: fixture.turnId,
      stepId: bundle.snapshot.stepId,
      payload: {
        type: 'step.snapshot',
        data: { snapshotId: bundle.snapshot.stepId, digest: bundle.snapshot.digest },
      },
    });
    expect(capabilityEvent).toMatchObject({
      turnId: fixture.turnId,
      stepId: bundle.snapshot.stepId,
      payload: {
        type: 'capability.receipt',
        data: {
          receiptId: bundle.capabilityReceipt.requestId,
          digest: bundle.capabilityReceipt.digest,
        },
      },
    });
    if (
      snapshotEvent.payload.type !== 'step.snapshot' ||
      capabilityEvent.payload.type !== 'capability.receipt'
    ) {
      throw new Error('Journal returned unexpected durable event types.');
    }
    expect(JSON.parse(snapshotEvent.payload.data.receipt)).toMatchObject({
      snapshotId: bundle.snapshot.stepId,
      snapshotDigest: bundle.snapshot.digest,
      stepReceipt: bundle.receipt,
      capabilityReceiptDigest: bundle.capabilityReceipt.digest,
    });
    expect(JSON.parse(capabilityEvent.payload.data.receipt)).toEqual(bundle.capabilityReceipt);
    expect(fixture.store.loadProjection()).toMatchObject({
      cursor: 4,
      stepSnapshotDigests: [bundle.snapshot.digest],
      capabilityReceiptDigests: [bundle.capabilityReceipt.digest],
    });
  });

  test('returns the original pair for an exact retry, including after turn termination', async () => {
    const fixture = createActiveStore(roots);
    const bundle = await createBundle(fixture.threadId, fixture.turnId, randomUUID());
    const journal = new CapabilityReceiptJournalV1(fixture.store);
    const first = journal.commit(bundle);
    fixture.store.appendDurable({
      turnId: fixture.turnId,
      payload: { type: 'turn.completed', data: { outcome: 'verified' } },
    });

    const retry = new CapabilityReceiptJournalV1(fixture.store).commit(bundle);

    expect(retry.status).toBe('existing');
    expect(retry.events.map(event => event.eventId)).toEqual(
      first.events.map(event => event.eventId)
    );
    expect(retry.firstSeq).toBe(first.firstSeq);
    expect(retry.lastSeq).toBe(first.lastSeq);
    expect(fixture.store.getCursor()).toBe(5);
  });

  test('rejects a second valid bundle that reuses an already committed stepId', async () => {
    const fixture = createActiveStore(roots);
    const stepId = randomUUID();
    const first = await createBundle(fixture.threadId, fixture.turnId, stepId, 'first prompt');
    const conflicting = await createBundle(
      fixture.threadId,
      fixture.turnId,
      stepId,
      'different prompt'
    );
    const journal = new CapabilityReceiptJournalV1(fixture.store);
    journal.commit(first);

    expect(() => journal.commit(conflicting)).toThrowError(
      expect.objectContaining({ code: 'ORION_CAPABILITY_RECEIPT_CONFLICT' })
    );
    expect(fixture.store.getCursor()).toBe(4);
  });

  test('fails closed when only one durable fact already exists for the step', async () => {
    const fixture = createActiveStore(roots);
    const bundle = await createBundle(fixture.threadId, fixture.turnId, randomUUID());
    fixture.store.appendDurable({
      turnId: fixture.turnId,
      stepId: bundle.snapshot.stepId,
      payload: {
        type: 'step.snapshot',
        data: {
          snapshotId: bundle.snapshot.stepId,
          digest: bundle.snapshot.digest,
          receipt: createPersistedStepSnapshotReceipt(bundle),
        },
      },
    });

    expect(() => new CapabilityReceiptJournalV1(fixture.store).commit(bundle)).toThrowError(
      expect.objectContaining({ code: 'ORION_CAPABILITY_RECEIPT_CONFLICT' })
    );
    expect(fixture.store.getCursor()).toBe(3);
  });

  test('rejects a re-digested CapabilityReceipt whose plan binding is inconsistent', async () => {
    const fixture = createActiveStore(roots);
    const bundle = await createBundle(fixture.threadId, fixture.turnId, randomUUID());
    const capabilityContent = omitDigest(bundle.capabilityReceipt);
    const changedCapabilityContent = {
      ...capabilityContent,
      planDigest: 'sha256:stale-plan',
    };
    const capabilityReceipt = {
      ...changedCapabilityContent,
      digest: digestRuntimeValue(changedCapabilityContent),
    };
    const stepContent = omitDigest(bundle.receipt);
    const changedStepContent = {
      ...stepContent,
      capabilityReceiptDigest: capabilityReceipt.digest,
    };
    const tampered: CapabilityStepPersistenceBundleV1 = {
      ...bundle,
      capabilityReceipt,
      receipt: { ...changedStepContent, digest: digestRuntimeValue(changedStepContent) },
    };

    expect(() => new CapabilityReceiptJournalV1(fixture.store).commit(tampered)).toThrowError(
      expect.objectContaining({ code: 'ORION_CAPABILITY_RECEIPT_INTEGRITY' })
    );
    expect(fixture.store.getCursor()).toBe(2);
  });

  test('rejects a broken StepReceipt digest chain before appending anything', async () => {
    const fixture = createActiveStore(roots);
    const bundle = await createBundle(fixture.threadId, fixture.turnId, randomUUID());
    const tampered: CapabilityStepPersistenceBundleV1 = {
      ...bundle,
      receipt: { ...bundle.receipt, promptDigest: 'sha256:tampered-prompt' },
    };

    expect(() => new CapabilityReceiptJournalV1(fixture.store).commit(tampered)).toThrowError(
      expect.objectContaining({ code: 'ORION_CAPABILITY_RECEIPT_INTEGRITY' })
    );
    expect(fixture.store.getCursor()).toBe(2);
  });

  test('rejects a bundle for another store thread and an inactive turn', async () => {
    const first = createActiveStore(roots);
    const bundle = await createBundle(first.threadId, first.turnId, randomUUID());
    const other = createActiveStore(roots);

    expect(() => new CapabilityReceiptJournalV1(other.store).commit(bundle)).toThrowError(
      expect.objectContaining({ code: 'ORION_CAPABILITY_RECEIPT_IDENTITY' })
    );
    expect(other.store.getCursor()).toBe(2);

    first.store.appendDurable({
      turnId: first.turnId,
      payload: { type: 'turn.completed', data: { outcome: 'closed before capture' } },
    });
    expect(() => new CapabilityReceiptJournalV1(first.store).commit(bundle)).toThrowError(
      expect.objectContaining({ code: 'ORION_CAPABILITY_RECEIPT_TURN_STATE' })
    );
    expect(first.store.getCursor()).toBe(3);
  });

  test('exports a distinct journal error type for callers', () => {
    const error = new CapabilityReceiptJournalError(
      'ORION_CAPABILITY_RECEIPT_CONFLICT',
      'conflict'
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('CapabilityReceiptJournalError');
  });
});

function createActiveStore(roots: string[]): ActiveStoreFixture {
  const root = mkdtempSync(join(tmpdir(), 'orion-capability-journal-'));
  roots.push(root);
  const threadId = randomUUID();
  const turnId = randomUUID();
  const store = new ThreadEventStore(root, threadId);
  store.appendDurableBatch([
    { payload: { type: 'thread.started', data: { projectPath: '/workspace' } } },
    {
      turnId,
      payload: { type: 'turn.started', data: { input: 'persist capability step', mode: 'build' } },
    },
  ]);
  return { store, threadId, turnId };
}

async function createBundle(
  threadId: string,
  turnId: string,
  stepId: string,
  prompt = 'Final prompt'
): Promise<CapabilityStepPersistenceBundleV1> {
  const tool = createToolFixture();
  const factory = new CapabilityAgentLoopStepFactoryV1({
    resolveConfiguration: () => createConfiguration(tool),
    resolveToolRegistry: () => new Map([[tool.candidate.bindingId, tool.binding]]),
    idFactory: identity => (identity.kind === 'step' ? stepId : randomUUID()),
    clock: () => 100,
  });
  const prepared = await factory.prepare({
    threadId,
    turnId,
    requestIndex: 0,
    input: 'Persist the capability step',
    mode: 'build',
    messages: [{ role: 'user', content: 'draft' }],
    taskContextRevision: 3,
    abortSignal: new AbortController().signal,
  });
  const messages: readonly Message[] = [{ role: 'user', content: prompt }];
  await prepared.capture({ messages, taskContextRevision: 4 });
  if (!prepared.persistenceBundle) throw new Error('Factory did not capture persistence bundle.');
  return prepared.persistenceBundle;
}

function createToolFixture(): ToolFixture {
  const inputSchema = {
    type: 'object' as const,
    properties: { path: { type: 'string' } },
    required: ['path'],
  };
  const descriptor: ToolBindingDescriptorV1 = {
    name: 'read_file',
    aliases: [],
    description: 'Read a workspace file',
    inputSchema,
    schemaDigest: digestRuntimeValue(inputSchema),
    executorId: 'executor:read_file:v1',
    risk: {
      readOnly: true,
      destructive: false,
      fileEdit: false,
      effect: 'workspace_read',
      network: 'none',
    },
  };
  return {
    candidate: {
      bindingId: 'binding:read_file:v1',
      descriptor,
      tier: 'core',
      source: 'first_party',
    },
    binding: {
      descriptor,
      execute: async args => ({ success: true, output: String(args.path) }),
    },
  };
}

function createConfiguration(tool: ToolFixture): CapabilityStepConfigurationV1 {
  const executionPolicy = createExecutionPolicySnapshotV1({
    policyId: 'policy-v1',
    approvalMode: 'never',
    sandboxRequired: true,
    sandboxBackend: 'test',
    timeoutMs: 5_000,
  });
  return {
    taskEpoch: 1,
    model: {
      providerId: 'test-provider',
      modelId: 'model-v1',
      protocol: 'test-protocol',
      contextWindow: 32_000,
    },
    executionPolicy,
    environment: {
      cwd: '/workspace',
      platform: 'test',
      arch: 'test',
      environmentDigest: 'environment-v1',
    },
    compiler: {
      task: { objective: 'Persist one capability step' },
      model: { toolCalling: true },
      authority: createAuthoritySnapshotV1({
        authorityId: 'project',
        projectRoot: '/workspace',
        confirmation: 'allow',
        filesystem: 'workspace',
        network: 'deny',
      }),
      budgets: {
        maxDirectTools: 4,
        maxToolSchemaBytes: 8_000,
        maxDeferredTools: 4,
        maxExpansionTools: 1,
      },
      tools: [tool.candidate],
      runtimeServicesDigest: 'runtime-services-v1',
      executionPolicyDigest: executionPolicy.digest,
      skillCatalogDigest: 'skill-catalog-v1',
      mcpCatalogDigest: 'mcp-catalog-v1',
      estimatedInputTokens: 64,
    },
  };
}

function createPersistedStepSnapshotReceipt(bundle: CapabilityStepPersistenceBundleV1): string {
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
  return canonicalRuntimeJson({ ...content, digest: digestRuntimeValue(content) });
}

function omitDigest<T extends { readonly digest: string }>(value: T): Omit<T, 'digest'> {
  const copy = { ...value } as Record<string, unknown>;
  delete copy.digest;
  return copy as Omit<T, 'digest'>;
}
