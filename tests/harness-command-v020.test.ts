import { findCommand } from '../src/commands';
import type { CommandContext } from '../src/commands/types';
import type { Store } from '../src/framework/store';
import type { OrionCodeCLIConfig } from '../src/services/config';
import type { OrionRuntimeDiagnosticsV1 } from '../src/runtime/orion-runtime-v1';

const DIAGNOSTICS: OrionRuntimeDiagnosticsV1 = {
  version: 1,
  runtime: {
    state: 'started',
    services: [
      { slot: 'execution', serviceId: 'execution-v1' },
      { slot: 'skills', serviceId: 'lazy-skills-v1' },
    ],
    contributors: [{ lane: 'prompt', ids: ['first-party-prompts'] }],
    scope: {
      id: 'scope-1',
      state: 'open',
      epoch: 1,
      activeResources: 3,
      activeLeases: 0,
    },
  },
  thread: {
    threadId: 'thread-1',
    status: 'idle',
    cursor: 12,
    projectionDigest: 'a'.repeat(64),
    projectionLag: 0,
    activeItemIds: [],
    queuedTurns: 0,
    queuedBytes: 0,
    interruptRequested: false,
  },
  taskContext: {
    revision: 4,
    taskEpoch: 2,
    stateDigest: 'b'.repeat(64),
    criteria: 3,
    evidenceRefs: ['verify-1:verification:passed'],
  },
  capability: {
    requestId: 'request-1',
    stepId: 'step-1',
    direct: ['read_file', 'exec_command'],
    deferred: ['git_log'],
    hidden: { write_file: 'authority denied' },
    omitted: [{ id: 'mcp:remote', reason: 'not selected' }],
    schemaBytes: 3947,
    fullSchemaBytes: 20596,
    schemaReductionPercent: 80.836,
    stepSnapshotDigest: 'c'.repeat(64),
    toolRouterDigest: 'd'.repeat(64),
    authorityDigest: 'e'.repeat(64),
    executionPolicyDigest: 'f'.repeat(64),
    skillCatalogDigest: '1'.repeat(64),
    selectedSkillIds: ['ai-fullstack-engineer'],
    mcpCatalogDigest: '2'.repeat(64),
    selectedMcpBindings: [],
    promptSections: [
      { id: 'task-context', digest: '3'.repeat(64), selected: true },
      { id: 'memory', digest: '4'.repeat(64), selected: false, reason: 'budget' },
    ],
    receiptDigest: '5'.repeat(64),
  },
  skills: {
    definitionCache: { entries: 0, bytes: 0, maxEntries: 32, maxBytes: 262144, ttlMs: 60_000 },
    resourceCache: { entries: 0, bytes: 0, maxEntries: 64, maxBytes: 524288, ttlMs: 60_000 },
    definitionLoadsInFlight: 0,
    resourceLoadsInFlight: 0,
    providerGenerations: { builtin: 1 },
  },
  mcp: {
    version: 1,
    catalog: { version: 1, descriptors: [], digest: '6'.repeat(64) },
    servers: [],
    digest: '7'.repeat(64),
  },
  latest: {
    stopDecision: { scope: 'request', status: 'completed' },
    compactEvent: 'compact.completed',
    compactRecoveryDigest: '8'.repeat(64),
    eventCursor: 12,
  },
};

function context(getHarnessDiagnostics: CommandContext['getHarnessDiagnostics']): CommandContext {
  return {
    cwd: '/repo',
    config: { model: 'test', toolConfirmation: 'ask' } as OrionCodeCLIConfig,
    store: { getSnapshot: jest.fn() } as unknown as Store,
    llm: null,
    getHarnessDiagnostics,
  };
}

describe('/harness explain v0.2 diagnostics', () => {
  test('renders the live runtime graph and lean capability facts', async () => {
    const getHarnessDiagnostics = jest.fn(async () => DIAGNOSTICS);
    const result = await findCommand('harness')!.execute(
      context(getHarnessDiagnostics),
      'explain'
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('Harness Explain · Runtime v0.2');
    expect(result.output).toContain('execution-v1');
    expect(result.output).toContain('read_file, exec_command');
    expect(result.output).toContain('3947B / 20596B');
    expect(result.output).toContain('80.836% leaner');
    expect(result.output).toContain('0/32 entries');
    expect(getHarnessDiagnostics).toHaveBeenCalledTimes(1);
  });

  test('emits the exact machine-readable receipt without reading legacy Store state', async () => {
    const getHarnessDiagnostics = jest.fn(async () => DIAGNOSTICS);
    const ctx = context(getHarnessDiagnostics);
    const result = await findCommand('harness')!.execute(ctx, 'explain --json');

    expect(result).toEqual({ success: true, output: JSON.stringify(DIAGNOSTICS, null, 2) });
    expect(ctx.store.getSnapshot).not.toHaveBeenCalled();
  });

  test('fails closed when the durable diagnostic projection cannot be verified', async () => {
    const result = await findCommand('harness')!.execute(
      context(async () => {
        throw new Error('capability receipt digest mismatch');
      }),
      'explain'
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('capability receipt digest mismatch');
  });
});
