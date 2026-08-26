import {
  CURRENT_TOOL_SCHEMA_BASELINE_V1,
  canonicalHarnessBenchmarkJson,
  compareHarnessBenchmarkReceipts,
  createHarnessBenchmarkActivityCollector,
  createHarnessBenchmarkReceipt,
  measureToolSchema,
  summarizeDistribution,
  verifyHarnessBenchmarkReceipt,
  type HarnessBenchmarkReceiptV1,
  type HarnessBenchmarkSampleV1,
  type ToolSchemaMeasurementV1,
} from '../src/runtime/harness-metrics';
import {
  createHarnessRuntimeWorkerCommand,
  parseHarnessRuntimeArguments,
  runHarnessRuntimeFreshWorkerProbe,
  runHarnessRuntimeWorkerProbe,
} from '../scripts/bench/harness-runtime';
import {
  createFrozenV019HarnessBaseline,
  FROZEN_V019_BASELINE_RECEIPT_DIGEST,
} from '../scripts/bench/frozen-v019-baseline';

const BASELINE_SCHEMA: ToolSchemaMeasurementV1 = {
  ...CURRENT_TOOL_SCHEMA_BASELINE_V1,
  estimatedTokens: 6_582,
};

const CANDIDATE_SCHEMA: ToolSchemaMeasurementV1 = {
  count: 14,
  bytes: 9_000,
  estimatedTokens: 2_900,
  sha256: 'a'.repeat(64),
};

function sample(
  phase: HarnessBenchmarkSampleV1['phase'],
  iteration: number,
  options: {
    durationMs: number;
    schema: ToolSchemaMeasurementV1;
    skillLoads?: number;
    residentSkills?: number;
    mcpActivity?: number;
  }
): HarnessBenchmarkSampleV1 {
  return {
    id: `${phase}-${String(iteration).padStart(3, '0')}`,
    phase,
    iteration,
    durationMs: options.durationMs,
    schemaSerializationMs: 1,
    toolSchema: { ...options.schema },
    skills: {
      instrumented: true,
      catalogLists: 1,
      descriptorsObserved: 3,
      definitionLoads: options.skillLoads ?? 0,
      definitionBytes: (options.skillLoads ?? 0) * 100,
      resourceLoads: 0,
      resourceBytes: 0,
      residentDefinitions: options.residentSkills ?? 0,
    },
    mcp: {
      instrumented: true,
      descriptorLists: 1,
      descriptorsObserved: 5,
      connectAttempts: options.mcpActivity ?? 0,
      connectionsOpened: options.mcpActivity ?? 0,
      processesSpawned: options.mcpActivity ?? 0,
      socketsOpened: 0,
      leasesAcquired: 0,
      activeConnections: options.mcpActivity ?? 0,
      activeProcesses: options.mcpActivity ?? 0,
    },
  };
}

function receipt(
  mode: HarnessBenchmarkReceiptV1['mode'],
  options: {
    durationMs: number;
    schema: ToolSchemaMeasurementV1;
    skillLoads?: number;
    residentSkills?: number;
    mcpActivity?: number;
  }
): HarnessBenchmarkReceiptV1 {
  const cold = Array.from({ length: 30 }, (_, index) => sample('cold', index + 1, options));
  const warm = Array.from({ length: 30 }, (_, index) => sample('warm', index + 1, options));
  return createHarnessBenchmarkReceipt({
    mode,
    createdAt: '2026-08-26T00:00:00.000Z',
    source: {
      gitSha: '1'.repeat(40),
      branch: 'v0.2.0',
      dirty: false,
      packageName: '@orion-agents/orion-code',
      packageVersion: '0.2.0',
    },
    environment: {
      node: 'v20.19.0',
      npm: '10.8.0',
      platform: 'linux',
      arch: 'x64',
    },
    fixture: {
      id: 'fixture-v1',
      sha256: 'f'.repeat(64),
      provider: 'deterministic-none',
      providerCorrectnessDependency: false,
      configuredSkillSet: 'builtin-only',
      configuredMcpServers: 5,
    },
    coldSamples: cold,
    warmSamples: warm,
  });
}

describe('HarnessBenchmarkReceiptV1', () => {
  test('verifies the immutable pre-cut baseline receipt and schema identity', () => {
    const baseline = createFrozenV019HarnessBaseline();
    expect(baseline.receiptDigest).toBe(FROZEN_V019_BASELINE_RECEIPT_DIGEST);
    expect(baseline.currentFullSchemaBaseline).toEqual({
      count: BASELINE_SCHEMA.count,
      bytes: BASELINE_SCHEMA.bytes,
      sha256: BASELINE_SCHEMA.sha256,
    });
    expect(baseline.samples.cold[0].toolSchema).toEqual(BASELINE_SCHEMA);
    expect(baseline.summary.cold.durationMs.p95).toBe(923.0755);
  });

  test('uses nearest-rank p50/p95 and retains an explicit sample count', () => {
    expect(summarizeDistribution(Array.from({ length: 30 }, (_, index) => index + 1))).toEqual({
      n: 30,
      min: 1,
      max: 30,
      mean: 15.5,
      p50: 15,
      p95: 29,
    });
  });

  test('rejects cold or warm CLI sample counts below 30', () => {
    expect(() => parseHarnessRuntimeArguments(['--cold-runs', '29'])).toThrow(
      '--cold-runs must be an integer >= 30'
    );
    expect(() => parseHarnessRuntimeArguments(['--warm-runs=0'])).toThrow(
      '--warm-runs must be an integer >= 30'
    );
    expect(parseHarnessRuntimeArguments([])).toMatchObject({
      mode: 'candidate',
      coldRuns: 30,
      warmRuns: 30,
    });
  });

  test('forwards candidate mode into cold and warm worker processes', () => {
    expect(createHarnessRuntimeWorkerCommand('candidate', 'cold')).toEqual(
      expect.arrayContaining(['--mode=candidate', '--worker=cold'])
    );
    expect(createHarnessRuntimeWorkerCommand('candidate', 'warm', 30)).toEqual(
      expect.arrayContaining(['--mode=candidate', '--worker=warm', '--worker-runs=30'])
    );
    expect(parseHarnessRuntimeArguments(['--mode=candidate'])).toMatchObject({
      mode: 'candidate',
      coldRuns: 30,
      warmRuns: 30,
    });
  });

  test('candidate worker uses direct v0.2.0 schemas and descriptor-only lazy runtimes', async () => {
    const probe = await runHarnessRuntimeWorkerProbe('candidate');

    expect(probe.toolSchema).toMatchObject({ count: 7 });
    expect(probe.toolSchema.bytes).toBeLessThanOrEqual(BASELINE_SCHEMA.bytes / 2);
    expect(probe.firstParty).toMatchObject({
      monolithicModuleLoads: 0,
      shardModuleLoads: 0,
      resolvedExecutors: 0,
    });
    expect(probe.skills).toEqual({
      instrumented: true,
      catalogLists: 1,
      descriptorsObserved: 3,
      definitionLoads: 0,
      definitionBytes: 0,
      resourceLoads: 0,
      resourceBytes: 0,
      residentDefinitions: 0,
    });
    expect(probe.mcp).toEqual({
      instrumented: true,
      descriptorLists: 1,
      descriptorsObserved: 5,
      connectAttempts: 0,
      connectionsOpened: 0,
      processesSpawned: 0,
      socketsOpened: 0,
      leasesAcquired: 0,
      activeConnections: 0,
      activeProcesses: 0,
    });
  });

  test('candidate cold worker loads no legacy src/tools module', () => {
    const probe = runHarnessRuntimeFreshWorkerProbe('candidate');

    expect(probe.firstParty).toEqual({
      monolithicModuleLoads: 0,
      shardModuleLoads: 0,
      resolvedExecutors: 0,
      loadedToolModules: 0,
    });
  });

  test('replays the exact Phase 0 eager source contract in a fresh process', () => {
    const probe = runHarnessRuntimeFreshWorkerProbe('baseline');

    expect(probe.toolSchema).toEqual(BASELINE_SCHEMA);
    expect(probe.skills).toMatchObject({
      definitionLoads: 6,
      definitionBytes: 5_504,
      residentDefinitions: 3,
    });
    expect(probe.mcp).toMatchObject({
      connectAttempts: 5,
      connectionsOpened: 5,
      processesSpawned: 5,
      activeConnections: 5,
      activeProcesses: 5,
    });
  });

  test('collects injected Skill and MCP lifecycle counters without names or payloads', () => {
    const collector = createHarnessBenchmarkActivityCollector({
      skillsInstrumented: true,
      mcpInstrumented: true,
    });
    collector.skills.onCatalogList(3);
    collector.skills.onDefinitionLoad(120);
    collector.skills.onResourceLoad(80);
    collector.skills.setResidentDefinitions(3);
    collector.mcp.onDescriptorList(5);
    collector.mcp.onConnectAttempt(5);
    collector.mcp.onConnectionOpen(5);
    collector.mcp.onProcessSpawn(5);
    collector.mcp.onLeaseAcquire();
    collector.mcp.setActiveResources(5, 5);

    expect(collector.snapshot()).toEqual({
      skills: {
        instrumented: true,
        catalogLists: 1,
        descriptorsObserved: 3,
        definitionLoads: 1,
        definitionBytes: 120,
        resourceLoads: 1,
        resourceBytes: 80,
        residentDefinitions: 3,
      },
      mcp: {
        instrumented: true,
        descriptorLists: 1,
        descriptorsObserved: 5,
        connectAttempts: 5,
        connectionsOpened: 5,
        processesSpawned: 5,
        socketsOpened: 0,
        leasesAcquired: 1,
        activeConnections: 5,
        activeProcesses: 5,
      },
    });
  });

  test('derives deterministic summaries and digest from all raw samples', () => {
    const first = receipt('baseline', {
      durationMs: 100,
      schema: BASELINE_SCHEMA,
      skillLoads: 6,
      residentSkills: 3,
      mcpActivity: 5,
    });
    const second = receipt('baseline', {
      durationMs: 100,
      schema: BASELINE_SCHEMA,
      skillLoads: 6,
      residentSkills: 3,
      mcpActivity: 5,
    });

    expect(first.samples.cold).toHaveLength(30);
    expect(first.samples.warm).toHaveLength(30);
    expect(first.summary.cold.durationMs).toMatchObject({ n: 30, p50: 100, p95: 100 });
    expect(first.receiptDigest).toBe(second.receiptDigest);
    expect(canonicalHarnessBenchmarkJson(first)).toBe(canonicalHarnessBenchmarkJson(second));
    expect(verifyHarnessBenchmarkReceipt(JSON.parse(JSON.stringify(first)))).toEqual(first);
  });

  test('rejects a persisted receipt whose derived summary was changed', () => {
    const value = receipt('baseline', { durationMs: 100, schema: BASELINE_SCHEMA });
    const tampered = structuredClone(value);
    tampered.summary.cold.durationMs.p95 = 1;
    expect(() => verifyHarnessBenchmarkReceipt(tampered)).toThrow('does not match raw samples');
  });

  test('passes the deterministic lean-runtime gates without a real provider', () => {
    const baseline = receipt('baseline', {
      durationMs: 100,
      schema: BASELINE_SCHEMA,
      skillLoads: 6,
      residentSkills: 3,
      mcpActivity: 5,
    });
    const candidate = receipt('candidate', {
      durationMs: 60,
      schema: CANDIDATE_SCHEMA,
    });
    const comparison = compareHarnessBenchmarkReceipts(baseline, candidate);

    expect(comparison.ok).toBe(true);
    expect(comparison.checks.every(check => check.ok)).toBe(true);
    expect(comparison.checks.find(check => check.id === 'tool-schema-reduction')).toMatchObject({
      actual: 56.302195,
      expected: 50,
    });
    expect(comparison.checks.find(check => check.id === 'cold-duration-reduction')).toMatchObject({
      actual: 40,
      expected: 30,
    });
  });

  test('fails closed when candidate activity counters are not instrumented', () => {
    const baseline = receipt('baseline', { durationMs: 100, schema: BASELINE_SCHEMA });
    const candidate = receipt('candidate', { durationMs: 60, schema: CANDIDATE_SCHEMA });
    candidate.samples.cold.forEach(current => {
      current.skills.instrumented = false;
      current.mcp.instrumented = false;
    });
    const rebuilt = createHarnessBenchmarkReceipt({
      mode: 'candidate',
      createdAt: candidate.createdAt,
      source: candidate.source,
      environment: candidate.environment,
      fixture: candidate.fixture,
      coldSamples: candidate.samples.cold,
      warmSamples: candidate.samples.warm,
    });
    const comparison = compareHarnessBenchmarkReceipts(baseline, rebuilt);

    expect(comparison.ok).toBe(false);
    expect(comparison.checks.find(check => check.id === 'skill-instrumentation')?.ok).toBe(false);
    expect(comparison.checks.find(check => check.id === 'mcp-instrumentation')?.ok).toBe(false);
  });
});
