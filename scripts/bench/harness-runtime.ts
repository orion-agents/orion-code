#!/usr/bin/env ts-node

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { performance } from 'perf_hooks';
import type { OrionCodeTool, ToolContext } from '../../src/framework/tool';
import type {
  CapabilityCompilerInputV1,
  CapabilityToolCandidateV1,
} from '../../src/runtime/capabilities';
import type {
  McpConnectionV1,
  McpConnectorV1,
  McpServerDescriptorInputV1,
  McpServerDescriptorV1,
} from '../../src/runtime/mcp';
import type {
  SkillDefinitionV1,
  SkillDescriptorV1,
  SkillCatalogV1,
  SkillObservationV1,
  SkillProviderV1,
  SkillResourceV1,
  SkillScopeV1,
} from '../../src/runtime/skills';
import type { ToolBindingDescriptorV1 } from '../../src/runtime/step-snapshot';
import {
  HARNESS_BENCHMARK_MIN_SAMPLES,
  canonicalHarnessBenchmarkJson,
  compareHarnessBenchmarkReceipts,
  createHarnessBenchmarkActivityCollector,
  createHarnessBenchmarkReceipt,
  measureToolSchema,
  toolSchemaMatchesCurrentBaseline,
  verifyHarnessBenchmarkReceipt,
  type HarnessBenchmarkReceiptV1,
  type HarnessBenchmarkSampleV1,
  type McpBenchmarkMetricsV1,
  type SkillBenchmarkMetricsV1,
  type ToolSchemaMeasurementV1,
} from '../../src/runtime/harness-metrics';

interface HarnessRuntimeArguments {
  mode: HarnessBenchmarkReceiptV1['mode'];
  coldRuns: number;
  warmRuns: number;
  out?: string;
  baseline?: string;
  createdAt?: string;
  worker?: 'cold' | 'warm';
  workerRuns?: number;
}

export interface ProbeResult {
  runtimeDurationMs: number;
  schemaSerializationMs: number;
  toolSchema: ToolSchemaMeasurementV1;
  skills: SkillBenchmarkMetricsV1;
  mcp: McpBenchmarkMetricsV1;
  firstParty?: {
    monolithicModuleLoads: number;
    shardModuleLoads: number;
    resolvedExecutors: number;
    loadedToolModules: number;
  };
}

interface RuntimeProbe {
  warm(): ProbeResult;
  close(): void | Promise<void>;
  startup: ProbeResult;
}

class BenchmarkSkillProvider implements SkillProviderV1 {
  readonly id = 'benchmark-builtin';
  readonly descriptors: readonly SkillDescriptorV1[];
  listReads = 0;
  definitionReads = 0;
  resourceReads = 0;

  constructor(count: number) {
    this.descriptors = Object.freeze(
      Array.from({ length: count }, (_, index) => {
        const id = `benchmark-skill-${index + 1}`;
        return Object.freeze({
          id,
          name: id,
          description: `Descriptor-only benchmark Skill ${index + 1}`,
          providerId: this.id,
          sourceScope: 'builtin' as const,
          modelInvocable: true,
          userInvocable: true,
          requestedCapabilities: Object.freeze([]),
          digest: sha256(id),
        });
      })
    );
  }

  async list(_scope: SkillScopeV1, _signal: AbortSignal): Promise<SkillObservationV1> {
    this.listReads++;
    return {
      version: 1,
      providerId: this.id,
      digest: sha256(JSON.stringify(this.descriptors)),
      complete: true,
      descriptors: this.descriptors,
    };
  }

  async get(_id: string, _signal: AbortSignal): Promise<SkillDefinitionV1 | undefined> {
    this.definitionReads++;
    return undefined;
  }

  async getResource(_id: string, _path: string, _signal: AbortSignal): Promise<SkillResourceV1> {
    this.resourceReads++;
    throw new Error('Benchmark candidate must not load a Skill resource.');
  }
}

class BenchmarkMcpConnector implements McpConnectorV1 {
  connectAttempts = 0;
  connectionsOpened = 0;
  processesSpawned = 0;
  socketsOpened = 0;

  async connect(descriptor: McpServerDescriptorV1, _signal: AbortSignal): Promise<McpConnectionV1> {
    this.connectAttempts++;
    throw new Error(`Benchmark candidate unexpectedly activated MCP server ${descriptor.id}.`);
  }
}

const repoRoot = resolve(__dirname, '../..');
const fixturePath = join(__dirname, 'fixtures', 'harness-runtime-corpus-v1.json');
const fakeMcpServerPath = join(__dirname, 'fixtures', 'fake-mcp-server.js');
const candidateSkillCount = 3;
const candidateMcpServerCount = 5;
const phase0Commit = '1010418f24a6d07a22074435bd4d50a9d339391c';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function candidateMcpDescriptors(): readonly McpServerDescriptorInputV1[] {
  return Object.freeze(
    Array.from({ length: candidateMcpServerCount }, (_, index) => {
      const id = `fixture-${index + 1}`;
      return Object.freeze({
        id,
        name: id,
        description: `Descriptor-only benchmark MCP server ${index + 1}`,
        transport: 'stdio' as const,
        configDigest: sha256(`benchmark-mcp:${id}`),
      });
    })
  );
}

function candidateCompilerInput(
  tools: readonly CapabilityToolCandidateV1[],
  skills: SkillCatalogV1,
  mcpCatalogDigest: string,
  authority: CapabilityCompilerInputV1['authority']
): CapabilityCompilerInputV1 {
  return {
    baseMode: 'build',
    taskContextRevision: 0,
    task: { objective: 'Fix the implementation and verify tests' },
    model: { toolCalling: true },
    authority,
    hardDeniedTools: [],
    budgets: {
      maxDirectTools: 8,
      maxToolSchemaBytes: 10_298,
      maxDeferredTools: 32,
      maxExpansionTools: 1,
    },
    tools,
    skills: skills.descriptors.map(descriptor => ({
      id: descriptor.id,
      digest: descriptor.digest,
      description: descriptor.description,
      requestedCapabilities: descriptor.requestedCapabilities,
      loaded: false,
    })),
    receipt: {
      requestId: 'benchmark-request-v1',
      threadId: 'benchmark-thread-v1',
      turnId: 'benchmark-turn-v1',
      stepId: 'benchmark-step-v1',
      durableCommitId: 'benchmark-commit-v1',
      createdAt: 1,
    },
    runtimeServicesDigest: 'benchmark-runtime-services-v1',
    executionPolicyDigest: 'benchmark-execution-policy-v1',
    skillCatalogDigest: skills.digest,
    mcpCatalogDigest,
    estimatedInputTokens: 100,
  };
}

function toolFromDescriptor(descriptor: ToolBindingDescriptorV1): OrionCodeTool {
  return {
    name: descriptor.name,
    aliases: [...descriptor.aliases],
    description: descriptor.description,
    parameters: structuredClone(descriptor.inputSchema),
    execute: () =>
      Promise.resolve({
        success: false,
        output: '',
        error: 'Benchmark descriptor facade is not executable.',
      }),
  };
}

function optionValue(args: string[], name: string): string | undefined {
  const inline = args.find(value => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parsePositiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < HARNESS_BENCHMARK_MIN_SAMPLES) {
    throw new Error(`${label} must be an integer >= ${HARNESS_BENCHMARK_MIN_SAMPLES}`);
  }
  return parsed;
}

export function parseHarnessRuntimeArguments(args: string[]): HarnessRuntimeArguments {
  const workerValue = optionValue(args, '--worker');
  const modeValue = optionValue(args, '--mode') ?? 'candidate';
  if (modeValue !== 'baseline' && modeValue !== 'candidate') {
    throw new Error('--mode must be baseline or candidate');
  }
  if (workerValue !== undefined && workerValue !== 'cold' && workerValue !== 'warm') {
    throw new Error('--worker must be cold or warm');
  }
  const workerRuns = optionValue(args, '--worker-runs');
  return {
    mode: modeValue,
    coldRuns: parsePositiveInteger(
      optionValue(args, '--cold-runs'),
      HARNESS_BENCHMARK_MIN_SAMPLES,
      '--cold-runs'
    ),
    warmRuns: parsePositiveInteger(
      optionValue(args, '--warm-runs'),
      HARNESS_BENCHMARK_MIN_SAMPLES,
      '--warm-runs'
    ),
    ...(optionValue(args, '--out') ? { out: optionValue(args, '--out') } : {}),
    ...(optionValue(args, '--baseline') ? { baseline: optionValue(args, '--baseline') } : {}),
    ...(optionValue(args, '--created-at') ? { createdAt: optionValue(args, '--created-at') } : {}),
    ...(workerValue ? { worker: workerValue } : {}),
    ...(workerRuns
      ? {
          workerRuns: parsePositiveInteger(
            workerRuns,
            HARNESS_BENCHMARK_MIN_SAMPLES,
            '--worker-runs'
          ),
        }
      : {}),
  };
}

async function initializeCandidateRuntimeProbe(): Promise<RuntimeProbe> {
  const started = performance.now();
  const firstPartyModule =
    require('../../src/runtime/first-party-core-provider') as typeof import('../../src/runtime/first-party-core-provider');
  const capabilityModule =
    require('../../src/runtime/capabilities') as typeof import('../../src/runtime/capabilities');
  const snapshotModule =
    require('../../src/runtime/step-snapshot') as typeof import('../../src/runtime/step-snapshot');
  const skillsModule =
    require('../../src/runtime/skills') as typeof import('../../src/runtime/skills');
  const mcpModule = require('../../src/runtime/mcp') as typeof import('../../src/runtime/mcp');

  const context: ToolContext = {
    cwd: process.cwd(),
    config: { name: 'orion-code', mode: 'benchmark-candidate' },
  };
  const firstPartyProvider = firstPartyModule.createFirstPartyCoreToolProviderV1({ context });
  const builtinCatalog = firstPartyProvider.catalog;
  const skillProvider = new BenchmarkSkillProvider(candidateSkillCount);
  const skillRuntime = new skillsModule.LazySkillRuntime({ providers: [skillProvider] });
  const skillCatalog = await skillRuntime.observe({ id: 'benchmark-project' });
  const mcpConnector = new BenchmarkMcpConnector();
  const mcpRuntime = new mcpModule.LazyMcpRuntime({
    descriptors: candidateMcpDescriptors(),
    connector: mcpConnector,
  });
  const mcpCatalog = mcpRuntime.getCatalog();

  const compileTools = (): OrionCodeTool[] => {
    const compilation = capabilityModule.compileCapabilityPlanV1(
      candidateCompilerInput(
        builtinCatalog.candidates,
        skillCatalog,
        mcpCatalog.digest,
        snapshotModule.createAuthoritySnapshotV1({
          authorityId: 'benchmark-project',
          projectRoot: process.cwd(),
          confirmation: 'allow',
          filesystem: 'workspace',
          network: 'write',
        })
      )
    );
    return compilation.directToolBindings.map(selection =>
      toolFromDescriptor(selection.descriptor)
    );
  };
  const tools = compileTools();
  const schemaStarted = performance.now();
  const toolSchema = measureToolSchema(tools);
  const schemaSerializationMs = performance.now() - schemaStarted;
  const startupActivity = candidateActivity(
    skillProvider,
    skillRuntime.stats().definitionCache.entries,
    skillCatalog.descriptors.length,
    mcpConnector,
    mcpRuntime.snapshot().servers
  );
  const firstParty = firstPartyProvider.stats();

  return {
    startup: {
      runtimeDurationMs: performance.now() - started,
      schemaSerializationMs,
      toolSchema,
      ...startupActivity,
      firstParty: {
        monolithicModuleLoads: firstParty.monolithicModuleLoads,
        shardModuleLoads: firstParty.shardModuleLoads,
        resolvedExecutors: firstParty.resolvedExecutors,
        loadedToolModules: loadedLegacyToolModuleCount(),
      },
    },
    warm() {
      const warmStarted = performance.now();
      const warmTools = compileTools();
      const warmSchemaStarted = performance.now();
      const warmToolSchema = measureToolSchema(warmTools);
      const warmSchemaSerializationMs = performance.now() - warmSchemaStarted;
      const activity = candidateActivity(
        skillProvider,
        skillRuntime.stats().definitionCache.entries,
        skillCatalog.descriptors.length,
        mcpConnector,
        mcpRuntime.snapshot().servers
      );
      const warmFirstParty = firstPartyProvider.stats();
      return {
        runtimeDurationMs: performance.now() - warmStarted,
        schemaSerializationMs: warmSchemaSerializationMs,
        toolSchema: warmToolSchema,
        ...activity,
        firstParty: {
          monolithicModuleLoads: warmFirstParty.monolithicModuleLoads,
          shardModuleLoads: warmFirstParty.shardModuleLoads,
          resolvedExecutors: warmFirstParty.resolvedExecutors,
          loadedToolModules: loadedLegacyToolModuleCount(),
        },
      };
    },
    async close() {
      await Promise.all([skillRuntime.dispose(), mcpRuntime.dispose()]);
    },
  };
}

async function initializeBaselineRuntimeProbe(): Promise<RuntimeProbe> {
  const baselineRoot = process.env.ORION_HARNESS_BASELINE_ROOT;
  if (!baselineRoot) {
    throw new Error('ORION_HARNESS_BASELINE_ROOT is required for the Phase 0 behavior replay.');
  }
  const started = performance.now();
  const fsModule = require('fs') as typeof import('fs');
  const childProcessModule = require('child_process') as typeof import('child_process');
  const originalReadFileSync = fsModule.readFileSync;
  const originalSpawn = childProcessModule.spawn;
  let skillDefinitionLoads = 0;
  let skillDefinitionBytes = 0;
  let processesSpawned = 0;

  Object.defineProperty(fsModule, 'readFileSync', {
    configurable: true,
    value: ((...readArgs: Parameters<typeof originalReadFileSync>) => {
      const value = originalReadFileSync(...readArgs);
      const path = String(readArgs[0]);
      if (path.endsWith('/SKILL.md')) {
        skillDefinitionLoads += 1;
        skillDefinitionBytes +=
          typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : value.byteLength;
      }
      return value;
    }) as typeof originalReadFileSync,
  });
  Object.defineProperty(childProcessModule, 'spawn', {
    configurable: true,
    value: ((...spawnArgs: Parameters<typeof originalSpawn>) => {
      processesSpawned += 1;
      return originalSpawn(...spawnArgs);
    }) as typeof originalSpawn,
  });

  let mcpManager:
    | {
        connectAll(): Promise<void>;
        disconnectAll(): void;
        getStatus(): Array<{ connected: boolean }>;
      }
    | undefined;
  let toolSchema: ToolSchemaMeasurementV1;
  let descriptorsObserved = 0;
  try {
    const toolsModule = require(join(baselineRoot, 'src', 'tools')) as {
      TOOLS: OrionCodeTool[];
    };
    const mcpModule = require(join(baselineRoot, 'src', 'tools', 'mcp')) as {
      mcpManager: NonNullable<typeof mcpManager>;
    };
    const registryModule = require(join(baselineRoot, 'src', 'skills', 'registry')) as {
      getSkillsRegistry(): { getAllSkills(): unknown[] };
    };
    const registry = registryModule.getSkillsRegistry();
    descriptorsObserved = registry.getAllSkills().length;
    mcpManager = mcpModule.mcpManager;
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    try {
      console.log = () => undefined;
      console.error = () => undefined;
      await mcpManager?.connectAll();
    } finally {
      console.log = originalConsoleLog;
      console.error = originalConsoleError;
    }
    const schemaStarted = performance.now();
    toolSchema = measureToolSchema(toolsModule.TOOLS);
    const schemaSerializationMs = performance.now() - schemaStarted;
    if (!toolSchemaMatchesCurrentBaseline(toolSchema)) {
      throw new Error('Phase 0 source replay did not reproduce the frozen 33-tool schema.');
    }
    const connected = mcpManager?.getStatus().filter(server => server.connected).length ?? 0;
    const startup: ProbeResult = {
      runtimeDurationMs: performance.now() - started,
      schemaSerializationMs,
      toolSchema,
      skills: {
        instrumented: true,
        catalogLists: 2,
        descriptorsObserved,
        definitionLoads: skillDefinitionLoads,
        definitionBytes: skillDefinitionBytes,
        resourceLoads: 0,
        resourceBytes: 0,
        residentDefinitions: descriptorsObserved,
      },
      mcp: {
        instrumented: true,
        descriptorLists: 1,
        descriptorsObserved: candidateMcpServerCount,
        connectAttempts: candidateMcpServerCount,
        connectionsOpened: connected,
        processesSpawned,
        socketsOpened: 0,
        leasesAcquired: 0,
        activeConnections: connected,
        activeProcesses: processesSpawned,
      },
    };
    return {
      startup,
      warm() {
        const warmStarted = performance.now();
        const warmSchemaStarted = performance.now();
        const warmToolSchema = measureToolSchema(toolsModule.TOOLS);
        const warmSchemaSerializationMs = performance.now() - warmSchemaStarted;
        return {
          runtimeDurationMs: performance.now() - warmStarted,
          schemaSerializationMs: warmSchemaSerializationMs,
          toolSchema: warmToolSchema,
          skills: {
            instrumented: true,
            catalogLists: 0,
            descriptorsObserved: 0,
            definitionLoads: 0,
            definitionBytes: 0,
            resourceLoads: 0,
            resourceBytes: 0,
            residentDefinitions: descriptorsObserved,
          },
          mcp: {
            instrumented: true,
            descriptorLists: 0,
            descriptorsObserved: 0,
            connectAttempts: 0,
            connectionsOpened: 0,
            processesSpawned: 0,
            socketsOpened: 0,
            leasesAcquired: 0,
            activeConnections: connected,
            activeProcesses: processesSpawned,
          },
        };
      },
      close() {
        mcpManager?.disconnectAll();
      },
    };
  } finally {
    Object.defineProperty(fsModule, 'readFileSync', {
      configurable: true,
      value: originalReadFileSync,
    });
    Object.defineProperty(childProcessModule, 'spawn', {
      configurable: true,
      value: originalSpawn,
    });
  }
}

async function initializeRuntimeProbe(
  mode: HarnessBenchmarkReceiptV1['mode']
): Promise<RuntimeProbe> {
  return mode === 'baseline' ? initializeBaselineRuntimeProbe() : initializeCandidateRuntimeProbe();
}

function candidateActivity(
  skillProvider: BenchmarkSkillProvider,
  residentDefinitions: number,
  skillDescriptors: number,
  mcpConnector: BenchmarkMcpConnector,
  mcpServers: readonly {
    state: string;
    activeLeaseCount: number;
  }[]
): { skills: SkillBenchmarkMetricsV1; mcp: McpBenchmarkMetricsV1 } {
  const collector = createHarnessBenchmarkActivityCollector({
    skillsInstrumented: true,
    mcpInstrumented: true,
  });
  collector.skills.onCatalogList(skillDescriptors);
  for (let read = 0; read < skillProvider.definitionReads; read += 1) {
    collector.skills.onDefinitionLoad(0);
  }
  for (let read = 0; read < skillProvider.resourceReads; read += 1) {
    collector.skills.onResourceLoad(0);
  }
  collector.skills.setResidentDefinitions(residentDefinitions);
  collector.mcp.onDescriptorList(mcpServers.length);
  collector.mcp.onConnectAttempt(mcpConnector.connectAttempts);
  collector.mcp.onConnectionOpen(mcpConnector.connectionsOpened);
  collector.mcp.onProcessSpawn(mcpConnector.processesSpawned);
  collector.mcp.onSocketOpen(mcpConnector.socketsOpened);
  collector.mcp.onLeaseAcquire(
    mcpServers.reduce((total, server) => total + server.activeLeaseCount, 0)
  );
  collector.mcp.setActiveResources(
    mcpServers.filter(server => server.state === 'connected' || server.state === 'idle').length,
    mcpConnector.processesSpawned
  );
  return collector.snapshot();
}

async function runWorker(args: HarnessRuntimeArguments): Promise<void> {
  const runtime = await initializeRuntimeProbe(args.mode);
  try {
    if (args.worker === 'cold') {
      process.stdout.write(`${JSON.stringify(runtime.startup)}\n`);
      return;
    }
    const runs = args.workerRuns ?? HARNESS_BENCHMARK_MIN_SAMPLES;
    const samples: ProbeResult[] = [];
    for (let iteration = 0; iteration < runs; iteration += 1) {
      samples.push(runtime.warm());
    }
    process.stdout.write(`${JSON.stringify(samples)}\n`);
  } finally {
    await runtime.close();
  }
}

/** Focused in-process probe used to prove which runtime path a worker mode selects. */
export async function runHarnessRuntimeWorkerProbe(
  mode: HarnessBenchmarkReceiptV1['mode']
): Promise<ProbeResult> {
  const runtime = await initializeRuntimeProbe(mode);
  try {
    return structuredClone(runtime.startup);
  } finally {
    await runtime.close();
  }
}

/** Fresh-process probe used to make eager import regressions deterministic. */
export function runHarnessRuntimeFreshWorkerProbe(
  mode: HarnessBenchmarkReceiptV1['mode']
): ProbeResult {
  const fixture = createFixtureEnvironment({ baseline: mode === 'baseline' });
  try {
    return runWorkerProcess<ProbeResult>(mode, 'cold', fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function loadedLegacyToolModuleCount(): number {
  const sourceRoot = `${join(repoRoot, 'src', 'tools')}/`;
  const distRoot = `${join(repoRoot, 'dist', 'tools')}/`;
  return Object.keys(require.cache).filter(
    filename => filename.startsWith(sourceRoot) || filename.startsWith(distRoot)
  ).length;
}

function createFixtureEnvironment(options: { baseline: boolean } = { baseline: false }): {
  root: string;
  configDir: string;
  workspace: string;
  baselineRoot?: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'orion-harness-benchmark-'));
  const configDir = join(root, 'config');
  const workspace = join(root, 'workspace');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const mcpServers = Object.fromEntries(
    Array.from({ length: 5 }, (_, index) => [
      `fixture-${index + 1}`,
      {
        type: 'stdio',
        command: process.execPath,
        args: [fakeMcpServerPath],
        cwd: workspace,
      },
    ])
  );
  writeFileSync(join(configDir, 'mcp.json'), `${JSON.stringify({ mcpServers }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  if (!options.baseline) return { root, configDir, workspace };
  const baselineRoot = join(root, 'phase0-source');
  mkdirSync(baselineRoot, { recursive: true });
  const archive = join(root, 'phase0.tar');
  const archived = spawnSync(
    'git',
    ['archive', '--format=tar', `--output=${archive}`, phase0Commit],
    { cwd: repoRoot, encoding: 'utf8' }
  );
  if (archived.status !== 0) {
    throw new Error(`Unable to archive Phase 0 commit ${phase0Commit}: ${archived.stderr}`);
  }
  const extracted = spawnSync('tar', ['-xf', archive, '-C', baselineRoot], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (extracted.status !== 0) {
    throw new Error(`Unable to extract Phase 0 source: ${extracted.stderr}`);
  }
  return { root, configDir, workspace, baselineRoot };
}

export function createHarnessRuntimeWorkerCommand(
  mode: HarnessBenchmarkReceiptV1['mode'],
  worker: 'cold' | 'warm',
  runs?: number
): string[] {
  return [
    '-r',
    require.resolve('ts-node/register/transpile-only'),
    __filename,
    `--mode=${mode}`,
    `--worker=${worker}`,
    ...(runs === undefined ? [] : [`--worker-runs=${runs}`]),
  ];
}

function runWorkerProcess<T>(
  mode: HarnessBenchmarkReceiptV1['mode'],
  worker: 'cold' | 'warm',
  fixture: { configDir: string; workspace: string; baselineRoot?: string },
  runs?: number
): T {
  const outcome = spawnSync(
    process.execPath,
    createHarnessRuntimeWorkerCommand(mode, worker, runs),
    {
      cwd: fixture.workspace,
      env: {
        ...process.env,
        ORION_CODE_CONFIG_DIR: fixture.configDir,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        NODE_PATH: join(repoRoot, 'node_modules'),
        TS_NODE_PROJECT: join(repoRoot, 'tsconfig.json'),
        ...(fixture.baselineRoot ? { ORION_HARNESS_BASELINE_ROOT: fixture.baselineRoot } : {}),
      },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }
  );
  if (outcome.status !== 0) {
    throw new Error(
      `${worker} worker failed (${outcome.status ?? 'signal'}): ${`${outcome.stdout}${outcome.stderr}`.trim()}`
    );
  }
  return JSON.parse(outcome.stdout.trim()) as T;
}

function canonicalSample(
  phase: HarnessBenchmarkSampleV1['phase'],
  iteration: number,
  durationMs: number,
  probe: ProbeResult
): HarnessBenchmarkSampleV1 {
  return {
    id: `${phase}-${String(iteration).padStart(3, '0')}`,
    phase,
    iteration,
    durationMs,
    schemaSerializationMs: probe.schemaSerializationMs,
    toolSchema: probe.toolSchema,
    skills: probe.skills,
    mcp: probe.mcp,
  };
}

function commandOutput(command: string, args: string[], fallback: string): string {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() || fallback : fallback;
}

function sourceMetadata(): HarnessBenchmarkReceiptV1['source'] {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
  };
  return {
    gitSha: commandOutput('git', ['rev-parse', 'HEAD'], 'unknown'),
    branch: commandOutput('git', ['branch', '--show-current'], 'detached'),
    dirty: commandOutput('git', ['status', '--porcelain'], '').length > 0,
    packageName: packageJson.name,
    packageVersion: packageJson.version,
  };
}

function fixtureMetadata(): HarnessBenchmarkReceiptV1['fixture'] {
  const raw = readFileSync(fixturePath);
  const fixture = JSON.parse(raw.toString('utf8')) as {
    id: string;
    provider: { kind: 'deterministic-none'; correctnessDependency: false };
    workspace: { skills: string; mcpServers: number };
  };
  return {
    id: fixture.id,
    sha256: createHash('sha256').update(raw).digest('hex'),
    provider: fixture.provider.kind,
    providerCorrectnessDependency: fixture.provider.correctnessDependency,
    configuredSkillSet: fixture.workspace.skills,
    configuredMcpServers: fixture.workspace.mcpServers,
  };
}

export async function runHarnessRuntimeBenchmark(
  args: HarnessRuntimeArguments
): Promise<HarnessBenchmarkReceiptV1> {
  const fixture = createFixtureEnvironment({ baseline: args.mode === 'baseline' });
  try {
    const coldSamples: HarnessBenchmarkSampleV1[] = [];
    for (let iteration = 1; iteration <= args.coldRuns; iteration += 1) {
      const worker = runWorkerProcess<ProbeResult>(args.mode, 'cold', fixture);
      coldSamples.push(canonicalSample('cold', iteration, worker.runtimeDurationMs, worker));
    }

    const warmWorker = runWorkerProcess<ProbeResult[]>(args.mode, 'warm', fixture, args.warmRuns);
    const warmSamples = warmWorker.map((probe, index) =>
      canonicalSample('warm', index + 1, probe.runtimeDurationMs, probe)
    );
    return createHarnessBenchmarkReceipt({
      mode: args.mode,
      createdAt: args.createdAt ?? new Date().toISOString(),
      source: sourceMetadata(),
      environment: {
        node: process.version,
        npm: commandOutput('npm', ['--version'], 'unknown'),
        platform: process.platform,
        arch: process.arch,
      },
      fixture: fixtureMetadata(),
      coldSamples,
      warmSamples,
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function writeReceipt(receipt: HarnessBenchmarkReceiptV1, out?: string): void {
  const json = `${JSON.stringify(receipt, null, 2)}\n`;
  if (!out) {
    process.stdout.write(json);
    return;
  }
  const target = resolve(out);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, json, 'utf8');
  process.stdout.write(
    `${canonicalHarnessBenchmarkJson({ receipt: target, digest: receipt.receiptDigest })}\n`
  );
}

async function main(): Promise<void> {
  const args = parseHarnessRuntimeArguments(process.argv.slice(2));
  if (args.worker) {
    await runWorker(args);
    return;
  }
  const receipt = await runHarnessRuntimeBenchmark(args);
  writeReceipt(receipt, args.out);
  if (args.baseline) {
    const baseline = verifyHarnessBenchmarkReceipt(
      JSON.parse(readFileSync(resolve(args.baseline), 'utf8')) as unknown
    );
    const comparison = compareHarnessBenchmarkReceipts(baseline, receipt);
    process.stderr.write(`${JSON.stringify(comparison, null, 2)}\n`);
    if (!comparison.ok) process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    process.exitCode = 1;
  });
}
