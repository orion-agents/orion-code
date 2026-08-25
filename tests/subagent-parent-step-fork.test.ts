import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { CapabilityReceiptJournalV1 } from '../src/runtime/capability-receipt-journal';
import {
  CapabilityAgentLoopStepFactoryV1,
  type CapabilityStepPersistenceBundleV1,
} from '../src/runtime/capability-step-factory';
import {
  ParentThreadStepForkSourceError,
  ParentThreadStepForkSourceV1,
} from '../src/runtime/subagents/parent-step-fork';
import {
  createAuthoritySnapshotV1,
  createExecutionPolicySnapshotV1,
} from '../src/runtime/step-snapshot';
import { ThreadEventStore } from '../src/runtime/thread-event-store';

describe('ParentThreadStepForkSourceV1', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test('publishes only a journal-confirmed active step and clears it at turn settlement', async () => {
    const fixture = await createFixture(roots);
    const flush = jest.fn();
    const source = new ParentThreadStepForkSourceV1({ store: fixture.store, flush });

    const anchor = source.publishCommitted(fixture.bundle, fixture.commit);

    expect(source.current()).toBe(anchor);
    expect(anchor).toMatchObject({
      threadId: fixture.store.threadId,
      turnId: fixture.bundle.snapshot.turnId,
      stepId: fixture.bundle.snapshot.stepId,
      requestId: fixture.bundle.capabilityReceipt.requestId,
      stepSnapshotDigest: fixture.bundle.snapshot.digest,
      capabilityReceiptDigest: fixture.bundle.capabilityReceipt.digest,
    });
    await anchor.flush();
    expect(flush).toHaveBeenCalledTimes(1);

    source.close('turn_settled');
    source.close('duplicate_settle');
    expect(source.current()).toBeUndefined();
    expect(() => source.publishCommitted(fixture.bundle, fixture.commit)).toThrow(
      ParentThreadStepForkSourceError
    );
  });

  test('fails closed when the commit receipt does not match the persistence bundle', async () => {
    const fixture = await createFixture(roots);
    const source = new ParentThreadStepForkSourceV1({
      store: fixture.store,
      flush: () => undefined,
    });

    let error: unknown;
    try {
      source.publishCommitted(fixture.bundle, {
        ...fixture.commit,
        lastSeq: fixture.commit.lastSeq + 1,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'ORION_SUBAGENT_PARENT_SOURCE_CONFLICT' });
    expect(source.current()).toBeUndefined();
  });
});

async function createFixture(roots: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'orion-parent-step-source-'));
  roots.push(root);
  const store = new ThreadEventStore(root, randomUUID());
  const turnId = randomUUID();
  store.appendDurableBatch([
    { payload: { type: 'thread.started', data: { projectPath: root } } },
    {
      turnId,
      payload: { type: 'turn.started', data: { input: 'parent task', mode: 'build' } },
    },
  ]);
  const bundle = await createBundle(store.threadId, turnId, root);
  const commit = new CapabilityReceiptJournalV1(store).commit(bundle);
  return { store, bundle, commit };
}

async function createBundle(
  threadId: string,
  turnId: string,
  root: string
): Promise<CapabilityStepPersistenceBundleV1> {
  const executionPolicy = createExecutionPolicySnapshotV1({
    policyId: 'parent-step-source-policy',
    approvalMode: 'never',
    sandboxRequired: true,
    sandboxBackend: 'test',
    timeoutMs: 5_000,
  });
  const authority = createAuthoritySnapshotV1({
    authorityId: 'parent-step-source-authority',
    projectRoot: root,
    confirmation: 'allow',
    filesystem: 'workspace',
    network: 'deny',
  });
  const factory = new CapabilityAgentLoopStepFactoryV1({
    resolveConfiguration: () => ({
      taskEpoch: 1,
      model: {
        providerId: 'test',
        modelId: 'test-model',
        protocol: 'test',
        contextWindow: 32_000,
      },
      executionPolicy,
      environment: {
        cwd: root,
        platform: 'test',
        arch: 'test',
        environmentDigest: `environment:${root}`,
      },
      compiler: {
        task: { objective: 'parent task' },
        model: { toolCalling: true },
        authority,
        budgets: {
          maxDirectTools: 1,
          maxToolSchemaBytes: 1_024,
          maxDeferredTools: 1,
          maxExpansionTools: 1,
        },
        tools: [],
        runtimeServicesDigest: 'runtime-services:test',
        executionPolicyDigest: executionPolicy.digest,
        skillCatalogDigest: 'skills:none',
        mcpCatalogDigest: 'mcp:none',
        estimatedInputTokens: 8,
      },
    }),
    resolveToolRegistry: () => new Map(),
  });
  const prepared = await factory.prepare({
    threadId,
    turnId,
    requestIndex: 0,
    input: 'parent task',
    mode: 'build',
    messages: [{ role: 'user', content: 'parent task' }],
    taskContextRevision: 0,
    abortSignal: new AbortController().signal,
  });
  await prepared.capture({
    messages: [{ role: 'user', content: 'parent task' }],
    taskContextRevision: 0,
  });
  if (!prepared.persistenceBundle) throw new Error('Capability step was not captured.');
  return prepared.persistenceBundle;
}
