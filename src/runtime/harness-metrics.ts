import { createHash } from 'crypto';
import { toOpenAITools, type OrionCodeTool } from '../framework/tool';
import { estimateTokens } from '../utils/token-estimate';

export const HARNESS_BENCHMARK_RECEIPT_SCHEMA_VERSION = 1 as const;
export const HARNESS_BENCHMARK_MIN_SAMPLES = 30 as const;

/** Immutable Phase 0 full-registry baseline for the v0.2.0 Harness redesign. */
export const CURRENT_TOOL_SCHEMA_BASELINE_V1 = Object.freeze({
  count: 33,
  bytes: 20_596,
  sha256: '29a9ccb14a036e132fa86d52ce6ab421e1c9791fac15e982cad4b1d288d1bde2',
});

export interface ToolSchemaMeasurementV1 {
  count: number;
  bytes: number;
  estimatedTokens: number;
  sha256: string;
}

export interface SkillBenchmarkMetricsV1 {
  instrumented: boolean;
  catalogLists: number;
  descriptorsObserved: number;
  definitionLoads: number;
  definitionBytes: number;
  resourceLoads: number;
  resourceBytes: number;
  residentDefinitions: number;
}

export interface McpBenchmarkMetricsV1 {
  instrumented: boolean;
  descriptorLists: number;
  descriptorsObserved: number;
  connectAttempts: number;
  connectionsOpened: number;
  processesSpawned: number;
  socketsOpened: number;
  leasesAcquired: number;
  activeConnections: number;
  activeProcesses: number;
}

export interface SkillBenchmarkObserver {
  onCatalogList(descriptorCount: number): void;
  onDefinitionLoad(bytes: number): void;
  onResourceLoad(bytes: number): void;
  setResidentDefinitions(count: number): void;
}

export interface McpBenchmarkObserver {
  onDescriptorList(descriptorCount: number): void;
  onConnectAttempt(count?: number): void;
  onConnectionOpen(count?: number): void;
  onProcessSpawn(count?: number): void;
  onSocketOpen(count?: number): void;
  onLeaseAcquire(count?: number): void;
  setActiveResources(connections: number, processes: number): void;
}

export interface HarnessBenchmarkActivityCollector {
  readonly skills: SkillBenchmarkObserver;
  readonly mcp: McpBenchmarkObserver;
  snapshot(): {
    skills: SkillBenchmarkMetricsV1;
    mcp: McpBenchmarkMetricsV1;
  };
}

export interface HarnessBenchmarkSampleV1 {
  id: string;
  phase: 'cold' | 'warm';
  iteration: number;
  durationMs: number;
  schemaSerializationMs: number;
  toolSchema: ToolSchemaMeasurementV1;
  skills: SkillBenchmarkMetricsV1;
  mcp: McpBenchmarkMetricsV1;
}

export interface DistributionSummaryV1 {
  n: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
}

export interface HarnessBenchmarkPhaseSummaryV1 {
  samples: number;
  durationMs: DistributionSummaryV1;
  schemaSerializationMs: DistributionSummaryV1;
  toolSchemaBytes: DistributionSummaryV1;
  toolSchemaTokens: DistributionSummaryV1;
  skills: {
    instrumentedSamples: number;
    definitionLoads: number;
    definitionBytes: number;
    resourceLoads: number;
    resourceBytes: number;
    maxResidentDefinitions: number;
  };
  mcp: {
    instrumentedSamples: number;
    connectAttempts: number;
    connectionsOpened: number;
    processesSpawned: number;
    socketsOpened: number;
    leasesAcquired: number;
    maxActiveConnections: number;
    maxActiveProcesses: number;
  };
}

export interface HarnessBenchmarkReceiptSourceV1 {
  gitSha: string;
  branch: string;
  dirty: boolean;
  packageName: string;
  packageVersion: string;
}

export interface HarnessBenchmarkReceiptEnvironmentV1 {
  node: string;
  npm: string;
  platform: NodeJS.Platform;
  arch: string;
}

export interface HarnessBenchmarkFixtureV1 {
  id: string;
  sha256: string;
  provider: 'deterministic-none';
  providerCorrectnessDependency: false;
  configuredSkillSet: string;
  configuredMcpServers: number;
}

export interface HarnessBenchmarkReceiptV1 {
  schemaVersion: typeof HARNESS_BENCHMARK_RECEIPT_SCHEMA_VERSION;
  kind: 'orion.harness-benchmark';
  mode: 'baseline' | 'candidate';
  createdAt: string;
  measurementTarget: 'harness-runtime-probe';
  source: HarnessBenchmarkReceiptSourceV1;
  environment: HarnessBenchmarkReceiptEnvironmentV1;
  fixture: HarnessBenchmarkFixtureV1;
  requiredMinimumSamples: typeof HARNESS_BENCHMARK_MIN_SAMPLES;
  currentFullSchemaBaseline: typeof CURRENT_TOOL_SCHEMA_BASELINE_V1;
  samples: {
    cold: HarnessBenchmarkSampleV1[];
    warm: HarnessBenchmarkSampleV1[];
  };
  summary: {
    cold: HarnessBenchmarkPhaseSummaryV1;
    warm: HarnessBenchmarkPhaseSummaryV1;
  };
  compatibilityFingerprint: string;
  receiptDigest: string;
}

export interface HarnessBenchmarkReceiptInputV1 {
  mode: HarnessBenchmarkReceiptV1['mode'];
  createdAt: string;
  source: HarnessBenchmarkReceiptSourceV1;
  environment: HarnessBenchmarkReceiptEnvironmentV1;
  fixture: HarnessBenchmarkFixtureV1;
  coldSamples: HarnessBenchmarkSampleV1[];
  warmSamples: HarnessBenchmarkSampleV1[];
}

export interface HarnessBenchmarkThresholdsV1 {
  minimumSchemaReductionPercent: number;
  minimumColdDurationReductionPercent: number;
}

export interface HarnessBenchmarkComparisonCheckV1 {
  id: string;
  ok: boolean;
  actual: number | string | boolean;
  expected: number | string | boolean;
  detail: string;
}

export interface HarnessBenchmarkComparisonV1 {
  schemaVersion: 1;
  kind: 'orion.harness-benchmark-comparison';
  ok: boolean;
  baselineDigest: string;
  candidateDigest: string;
  thresholds: HarnessBenchmarkThresholdsV1;
  checks: HarnessBenchmarkComparisonCheckV1[];
}

const DEFAULT_COMPARISON_THRESHOLDS: HarnessBenchmarkThresholdsV1 = {
  minimumSchemaReductionPercent: 50,
  minimumColdDurationReductionPercent: 30,
};

function requireNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function requireFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
}

function increment(current: number, delta: number, label: string): number {
  requireNonNegativeInteger(delta, label);
  return current + delta;
}

export function createHarnessBenchmarkActivityCollector(options: {
  skillsInstrumented: boolean;
  mcpInstrumented: boolean;
}): HarnessBenchmarkActivityCollector {
  const skillMetrics: SkillBenchmarkMetricsV1 = {
    instrumented: options.skillsInstrumented,
    catalogLists: 0,
    descriptorsObserved: 0,
    definitionLoads: 0,
    definitionBytes: 0,
    resourceLoads: 0,
    resourceBytes: 0,
    residentDefinitions: 0,
  };
  const mcpMetrics: McpBenchmarkMetricsV1 = {
    instrumented: options.mcpInstrumented,
    descriptorLists: 0,
    descriptorsObserved: 0,
    connectAttempts: 0,
    connectionsOpened: 0,
    processesSpawned: 0,
    socketsOpened: 0,
    leasesAcquired: 0,
    activeConnections: 0,
    activeProcesses: 0,
  };

  return {
    skills: {
      onCatalogList(descriptorCount) {
        requireNonNegativeInteger(descriptorCount, 'skill descriptor count');
        skillMetrics.catalogLists += 1;
        skillMetrics.descriptorsObserved += descriptorCount;
      },
      onDefinitionLoad(bytes) {
        skillMetrics.definitionLoads += 1;
        skillMetrics.definitionBytes = increment(
          skillMetrics.definitionBytes,
          bytes,
          'skill definition bytes'
        );
      },
      onResourceLoad(bytes) {
        skillMetrics.resourceLoads += 1;
        skillMetrics.resourceBytes = increment(
          skillMetrics.resourceBytes,
          bytes,
          'skill resource bytes'
        );
      },
      setResidentDefinitions(count) {
        requireNonNegativeInteger(count, 'resident skill definitions');
        skillMetrics.residentDefinitions = count;
      },
    },
    mcp: {
      onDescriptorList(descriptorCount) {
        requireNonNegativeInteger(descriptorCount, 'MCP descriptor count');
        mcpMetrics.descriptorLists += 1;
        mcpMetrics.descriptorsObserved += descriptorCount;
      },
      onConnectAttempt(count = 1) {
        mcpMetrics.connectAttempts = increment(
          mcpMetrics.connectAttempts,
          count,
          'MCP connect attempts'
        );
      },
      onConnectionOpen(count = 1) {
        mcpMetrics.connectionsOpened = increment(
          mcpMetrics.connectionsOpened,
          count,
          'MCP connections opened'
        );
      },
      onProcessSpawn(count = 1) {
        mcpMetrics.processesSpawned = increment(
          mcpMetrics.processesSpawned,
          count,
          'MCP processes spawned'
        );
      },
      onSocketOpen(count = 1) {
        mcpMetrics.socketsOpened = increment(mcpMetrics.socketsOpened, count, 'MCP sockets opened');
      },
      onLeaseAcquire(count = 1) {
        mcpMetrics.leasesAcquired = increment(
          mcpMetrics.leasesAcquired,
          count,
          'MCP leases acquired'
        );
      },
      setActiveResources(connections, processes) {
        requireNonNegativeInteger(connections, 'active MCP connections');
        requireNonNegativeInteger(processes, 'active MCP processes');
        mcpMetrics.activeConnections = connections;
        mcpMetrics.activeProcesses = processes;
      },
    },
    snapshot() {
      return {
        skills: { ...skillMetrics },
        mcp: { ...mcpMetrics },
      };
    },
  };
}

export function measureToolSchema(
  tools: Pick<OrionCodeTool, 'name' | 'description' | 'parameters'>[]
): ToolSchemaMeasurementV1 {
  const json = JSON.stringify(toOpenAITools(tools as OrionCodeTool[]));
  return {
    count: tools.length,
    bytes: Buffer.byteLength(json, 'utf8'),
    estimatedTokens: estimateTokens(json),
    sha256: createHash('sha256').update(json, 'utf8').digest('hex'),
  };
}

/**
 * Benchmark-only snapshot of the v0.1.x model-facing Plan completion tool.
 *
 * Product runtime intentionally no longer exposes this tool: Plan completion is
 * represented by the atomic TurnCommit/PlanReceipt path. Keeping the descriptor
 * here prevents the frozen 33-tool baseline from drifting when measuring the
 * current product tool universe.
 */
export const FROZEN_LEGACY_PLAN_TOOL_SCHEMA_V1: Pick<
  OrionCodeTool,
  'name' | 'description' | 'parameters'
> = Object.freeze({
  name: 'exit_plan_mode',
  description: `Submit the decision-complete implementation plan and finish the planning phase.
Call this exactly once when planning is complete. A successful call saves the plan
and automatically restores the selected execution mode. The runtime starts implementation in a
separate logical request so the completed plan remains a distinct phase. Do not call it with a draft, and do
not ask the user to run a separate exit command.`,
  parameters: {
    type: 'object' as const,
    properties: {
      plan: {
        type: 'string' as const,
        description: 'The detailed implementation plan',
      },
    },
    required: ['plan'],
  },
});

/** Restore the historical schema order without making the retired tool executable. */
export function createFrozenLegacyBaselineToolSchemasV1(
  tools: Pick<OrionCodeTool, 'name' | 'description' | 'parameters'>[]
): Pick<OrionCodeTool, 'name' | 'description' | 'parameters'>[] {
  if (tools.some(tool => tool.name === FROZEN_LEGACY_PLAN_TOOL_SCHEMA_V1.name)) {
    throw new Error('frozen baseline input already contains exit_plan_mode');
  }
  const goalToolIndex = tools.findIndex(tool => tool.name === 'get_goal');
  if (goalToolIndex < 0) {
    throw new Error('frozen baseline input is missing the get_goal ordering anchor');
  }
  return [
    ...tools.slice(0, goalToolIndex),
    FROZEN_LEGACY_PLAN_TOOL_SCHEMA_V1,
    ...tools.slice(goalToolIndex),
  ];
}

export function toolSchemaMatchesCurrentBaseline(measurement: ToolSchemaMeasurementV1): boolean {
  return (
    measurement.count === CURRENT_TOOL_SCHEMA_BASELINE_V1.count &&
    measurement.bytes === CURRENT_TOOL_SCHEMA_BASELINE_V1.bytes &&
    measurement.sha256 === CURRENT_TOOL_SCHEMA_BASELINE_V1.sha256
  );
}

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}

/** Nearest-rank percentile. Raw samples remain in the receipt for independent analysis. */
export function summarizeDistribution(values: number[]): DistributionSummaryV1 {
  if (values.length === 0) throw new Error('distribution requires at least one value');
  for (const value of values) requireFiniteNonNegative(value, 'distribution value');
  const sorted = [...values].sort((left, right) => left - right);
  const nearestRank = (percentile: number): number => {
    const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
    return sorted[index];
  };
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    n: sorted.length,
    min: roundMetric(sorted[0]),
    max: roundMetric(sorted[sorted.length - 1]),
    mean: roundMetric(sum / sorted.length),
    p50: roundMetric(nearestRank(0.5)),
    p95: roundMetric(nearestRank(0.95)),
  };
}

function sum(
  samples: HarnessBenchmarkSampleV1[],
  pick: (sample: HarnessBenchmarkSampleV1) => number
): number {
  return samples.reduce((total, sample) => total + pick(sample), 0);
}

function max(
  samples: HarnessBenchmarkSampleV1[],
  pick: (sample: HarnessBenchmarkSampleV1) => number
): number {
  return Math.max(...samples.map(pick));
}

export function summarizeHarnessBenchmarkPhase(
  samples: HarnessBenchmarkSampleV1[]
): HarnessBenchmarkPhaseSummaryV1 {
  if (samples.length === 0) throw new Error('benchmark phase requires at least one sample');
  return {
    samples: samples.length,
    durationMs: summarizeDistribution(samples.map(sample => sample.durationMs)),
    schemaSerializationMs: summarizeDistribution(
      samples.map(sample => sample.schemaSerializationMs)
    ),
    toolSchemaBytes: summarizeDistribution(samples.map(sample => sample.toolSchema.bytes)),
    toolSchemaTokens: summarizeDistribution(
      samples.map(sample => sample.toolSchema.estimatedTokens)
    ),
    skills: {
      instrumentedSamples: samples.filter(sample => sample.skills.instrumented).length,
      definitionLoads: sum(samples, sample => sample.skills.definitionLoads),
      definitionBytes: sum(samples, sample => sample.skills.definitionBytes),
      resourceLoads: sum(samples, sample => sample.skills.resourceLoads),
      resourceBytes: sum(samples, sample => sample.skills.resourceBytes),
      maxResidentDefinitions: max(samples, sample => sample.skills.residentDefinitions),
    },
    mcp: {
      instrumentedSamples: samples.filter(sample => sample.mcp.instrumented).length,
      connectAttempts: sum(samples, sample => sample.mcp.connectAttempts),
      connectionsOpened: sum(samples, sample => sample.mcp.connectionsOpened),
      processesSpawned: sum(samples, sample => sample.mcp.processesSpawned),
      socketsOpened: sum(samples, sample => sample.mcp.socketsOpened),
      leasesAcquired: sum(samples, sample => sample.mcp.leasesAcquired),
      maxActiveConnections: max(samples, sample => sample.mcp.activeConnections),
      maxActiveProcesses: max(samples, sample => sample.mcp.activeProcesses),
    },
  };
}

export function assertHarnessBenchmarkRunCount(count: number, label: string): void {
  if (!Number.isSafeInteger(count) || count < HARNESS_BENCHMARK_MIN_SAMPLES) {
    throw new Error(`${label} must contain at least ${HARNESS_BENCHMARK_MIN_SAMPLES} samples`);
  }
}

function validateHexDigest(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} must be a SHA-256 hex digest`);
}

function validateSample(
  sample: HarnessBenchmarkSampleV1,
  phase: HarnessBenchmarkSampleV1['phase'],
  expectedIteration: number,
  enforceCurrentSchema: boolean
): void {
  if (sample.phase !== phase) throw new Error(`${sample.id}: expected phase ${phase}`);
  if (sample.iteration !== expectedIteration) {
    throw new Error(`${sample.id}: expected iteration ${expectedIteration}`);
  }
  if (sample.id !== `${phase}-${String(expectedIteration).padStart(3, '0')}`) {
    throw new Error(`${sample.id}: sample id is not canonical`);
  }
  requireFiniteNonNegative(sample.durationMs, `${sample.id} durationMs`);
  requireFiniteNonNegative(sample.schemaSerializationMs, `${sample.id} schemaSerializationMs`);
  requireNonNegativeInteger(sample.toolSchema.count, `${sample.id} tool count`);
  requireNonNegativeInteger(sample.toolSchema.bytes, `${sample.id} schema bytes`);
  requireNonNegativeInteger(sample.toolSchema.estimatedTokens, `${sample.id} schema tokens`);
  validateHexDigest(sample.toolSchema.sha256, `${sample.id} schema digest`);
  if (enforceCurrentSchema && !toolSchemaMatchesCurrentBaseline(sample.toolSchema)) {
    throw new Error(`${sample.id}: baseline tool schema differs from the frozen Phase 0 value`);
  }
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)])
  );
}

export function canonicalHarnessBenchmarkJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalHarnessBenchmarkJson(value), 'utf8').digest('hex');
}

function compatibilityMaterial(
  input: Pick<
    HarnessBenchmarkReceiptInputV1,
    'environment' | 'fixture' | 'coldSamples' | 'warmSamples'
  >
): unknown {
  return {
    fixture: input.fixture,
    measurementTarget: 'harness-runtime-probe',
    environment: {
      nodeMajor: Number(input.environment.node.replace(/^v/u, '').split('.')[0]),
      platform: input.environment.platform,
      arch: input.environment.arch,
    },
    samples: {
      cold: input.coldSamples.length,
      warm: input.warmSamples.length,
    },
  };
}

export function createHarnessBenchmarkReceipt(
  input: HarnessBenchmarkReceiptInputV1
): HarnessBenchmarkReceiptV1 {
  if (input.mode !== 'baseline' && input.mode !== 'candidate') {
    throw new Error('benchmark mode must be baseline or candidate');
  }
  assertHarnessBenchmarkRunCount(input.coldSamples.length, 'cold phase');
  assertHarnessBenchmarkRunCount(input.warmSamples.length, 'warm phase');
  validateHexDigest(input.fixture.sha256, 'fixture digest');
  if (Number.isNaN(Date.parse(input.createdAt)))
    throw new Error('createdAt must be an ISO timestamp');

  const enforceCurrentSchema = input.mode === 'baseline';
  input.coldSamples.forEach((sample, index) =>
    validateSample(sample, 'cold', index + 1, enforceCurrentSchema)
  );
  input.warmSamples.forEach((sample, index) =>
    validateSample(sample, 'warm', index + 1, enforceCurrentSchema)
  );

  const receiptWithoutDigest = {
    schemaVersion: HARNESS_BENCHMARK_RECEIPT_SCHEMA_VERSION,
    kind: 'orion.harness-benchmark' as const,
    mode: input.mode,
    createdAt: input.createdAt,
    measurementTarget: 'harness-runtime-probe' as const,
    source: { ...input.source },
    environment: { ...input.environment },
    fixture: { ...input.fixture },
    requiredMinimumSamples: HARNESS_BENCHMARK_MIN_SAMPLES as typeof HARNESS_BENCHMARK_MIN_SAMPLES,
    currentFullSchemaBaseline: CURRENT_TOOL_SCHEMA_BASELINE_V1,
    samples: {
      cold: input.coldSamples.map(sample => structuredClone(sample)),
      warm: input.warmSamples.map(sample => structuredClone(sample)),
    },
    summary: {
      cold: summarizeHarnessBenchmarkPhase(input.coldSamples),
      warm: summarizeHarnessBenchmarkPhase(input.warmSamples),
    },
    compatibilityFingerprint: sha256Canonical(compatibilityMaterial(input)),
  };
  return {
    ...receiptWithoutDigest,
    receiptDigest: sha256Canonical(receiptWithoutDigest),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parse and fully re-derive a receipt rather than trusting persisted summary fields. */
export function verifyHarnessBenchmarkReceipt(value: unknown): HarnessBenchmarkReceiptV1 {
  if (
    !isRecord(value) ||
    value.schemaVersion !== HARNESS_BENCHMARK_RECEIPT_SCHEMA_VERSION ||
    value.kind !== 'orion.harness-benchmark' ||
    !isRecord(value.samples) ||
    !Array.isArray(value.samples.cold) ||
    !Array.isArray(value.samples.warm)
  ) {
    throw new Error('invalid HarnessBenchmarkReceiptV1 envelope');
  }
  const receipt = value as unknown as HarnessBenchmarkReceiptV1;
  const rebuilt = createHarnessBenchmarkReceipt({
    mode: receipt.mode,
    createdAt: receipt.createdAt,
    source: receipt.source,
    environment: receipt.environment,
    fixture: receipt.fixture,
    coldSamples: receipt.samples.cold,
    warmSamples: receipt.samples.warm,
  });
  if (canonicalHarnessBenchmarkJson(rebuilt) !== canonicalHarnessBenchmarkJson(receipt)) {
    throw new Error(
      'HarnessBenchmarkReceiptV1 digest or derived summary does not match raw samples'
    );
  }
  return receipt;
}

function check(
  id: string,
  ok: boolean,
  actual: HarnessBenchmarkComparisonCheckV1['actual'],
  expected: HarnessBenchmarkComparisonCheckV1['expected'],
  detail: string
): HarnessBenchmarkComparisonCheckV1 {
  return { id, ok, actual, expected, detail };
}

function reductionPercent(baseline: number, candidate: number): number {
  if (baseline <= 0) return candidate <= 0 ? 0 : Number.NEGATIVE_INFINITY;
  return roundMetric(((baseline - candidate) / baseline) * 100);
}

function allActivityInstrumented(
  receipt: HarnessBenchmarkReceiptV1,
  kind: 'skills' | 'mcp'
): boolean {
  const phases = [receipt.summary.cold, receipt.summary.warm];
  return phases.every(phase => phase[kind].instrumentedSamples === phase.samples);
}

export function compareHarnessBenchmarkReceipts(
  baseline: HarnessBenchmarkReceiptV1,
  candidate: HarnessBenchmarkReceiptV1,
  thresholds: HarnessBenchmarkThresholdsV1 = DEFAULT_COMPARISON_THRESHOLDS
): HarnessBenchmarkComparisonV1 {
  const schemaReduction = reductionPercent(
    baseline.summary.cold.toolSchemaBytes.p50,
    candidate.summary.cold.toolSchemaBytes.p50
  );
  const coldDurationReduction = reductionPercent(
    baseline.summary.cold.durationMs.p95,
    candidate.summary.cold.durationMs.p95
  );
  const skillInstrumented = allActivityInstrumented(candidate, 'skills');
  const mcpInstrumented = allActivityInstrumented(candidate, 'mcp');
  const skillLoads =
    candidate.summary.cold.skills.definitionLoads +
    candidate.summary.warm.skills.definitionLoads +
    candidate.summary.cold.skills.resourceLoads +
    candidate.summary.warm.skills.resourceLoads +
    candidate.summary.cold.skills.maxResidentDefinitions +
    candidate.summary.warm.skills.maxResidentDefinitions;
  const mcpActivity =
    candidate.summary.cold.mcp.connectionsOpened +
    candidate.summary.warm.mcp.connectionsOpened +
    candidate.summary.cold.mcp.processesSpawned +
    candidate.summary.warm.mcp.processesSpawned +
    candidate.summary.cold.mcp.socketsOpened +
    candidate.summary.warm.mcp.socketsOpened +
    candidate.summary.cold.mcp.maxActiveConnections +
    candidate.summary.warm.mcp.maxActiveConnections +
    candidate.summary.cold.mcp.maxActiveProcesses +
    candidate.summary.warm.mcp.maxActiveProcesses;

  const checks: HarnessBenchmarkComparisonCheckV1[] = [
    check(
      'receipt-modes',
      baseline.mode === 'baseline' && candidate.mode === 'candidate',
      `${baseline.mode}->${candidate.mode}`,
      'baseline->candidate',
      'Comparison requires an immutable baseline and a candidate receipt.'
    ),
    check(
      'fixture-compatibility',
      baseline.compatibilityFingerprint === candidate.compatibilityFingerprint,
      candidate.compatibilityFingerprint,
      baseline.compatibilityFingerprint,
      'Fixture, platform, Node major, architecture, and sample counts must match.'
    ),
    check(
      'baseline-schema-identity',
      baseline.samples.cold.every(sample => toolSchemaMatchesCurrentBaseline(sample.toolSchema)),
      baseline.summary.cold.toolSchemaBytes.p50,
      CURRENT_TOOL_SCHEMA_BASELINE_V1.bytes,
      'The baseline receipt must retain the frozen 33-tool schema identity.'
    ),
    check(
      'tool-schema-reduction',
      schemaReduction >= thresholds.minimumSchemaReductionPercent,
      schemaReduction,
      thresholds.minimumSchemaReductionPercent,
      'Candidate cold p50 schema bytes must meet the reduction threshold.'
    ),
    check(
      'cold-duration-reduction',
      coldDurationReduction >= thresholds.minimumColdDurationReductionPercent,
      coldDurationReduction,
      thresholds.minimumColdDurationReductionPercent,
      'Candidate cold p95 probe duration must meet the reduction threshold.'
    ),
    check(
      'skill-instrumentation',
      skillInstrumented,
      skillInstrumented,
      true,
      'Every candidate sample must include injected Skill counters.'
    ),
    check(
      'skill-zero-load',
      skillInstrumented && skillLoads === 0,
      skillLoads,
      0,
      'The no-Skill fixture must not load definitions or resources.'
    ),
    check(
      'mcp-instrumentation',
      mcpInstrumented,
      mcpInstrumented,
      true,
      'Every candidate sample must include injected MCP counters.'
    ),
    check(
      'mcp-zero-activity',
      mcpInstrumented && mcpActivity === 0,
      mcpActivity,
      0,
      'The unselected-MCP fixture must open no connection, process, or socket.'
    ),
  ];
  return {
    schemaVersion: 1,
    kind: 'orion.harness-benchmark-comparison',
    ok: checks.every(item => item.ok),
    baselineDigest: baseline.receiptDigest,
    candidateDigest: candidate.receiptDigest,
    thresholds: { ...thresholds },
    checks,
  };
}
