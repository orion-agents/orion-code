#!/usr/bin/env ts-node

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { performance } from 'perf_hooks';

import { toOpenAITools, type OrionCodeTool, type ToolContext } from '../../src/framework/tool';
import { estimateTokens } from '../../src/utils/token-estimate';
import { compileCapabilityPlanV1 } from '../../src/runtime/capabilities';
import {
  compareHarnessEvalReceiptsV1,
  createHarnessEvalReceiptV1,
  HARNESS_EVAL_MIN_ITERATIONS_V1,
  type HarnessEvalReceiptV1,
  type HarnessEvalSampleV1,
  type HarnessEvalTaskV1,
} from '../../src/runtime/harness-eval';
import { CURRENT_TOOL_SCHEMA_BASELINE_V1 } from '../../src/runtime/harness-metrics';
import { createProductionFirstPartyToolUniverseV1 } from '../../src/runtime/first-party-tool-universe';
import { createAuthoritySnapshotV1 } from '../../src/runtime/step-snapshot';

interface EvalCorpusFileV1 {
  readonly version: 1;
  readonly id: string;
  readonly provider: 'deterministic-capability-contract';
  readonly tasks: readonly HarnessEvalTaskV1[];
}

interface HarnessEvalArgumentsV1 {
  readonly iterations: number;
  readonly output?: string;
  readonly createdAt?: string;
}

export interface HarnessEvalRuntimeV1 {
  readonly now: () => number;
}

const SYSTEM_HARNESS_EVAL_RUNTIME_V1: HarnessEvalRuntimeV1 = Object.freeze({
  now: () => performance.now(),
});

const repoRoot = resolve(__dirname, '../..');
const corpusPath = resolve(__dirname, 'fixtures/harness-eval-corpus-v1.json');
const FROZEN_BASELINE_SCHEMA_TOKENS = 6_582;

export function parseHarnessEvalArgumentsV1(argv: readonly string[]): HarnessEvalArgumentsV1 {
  const rawIterations = optionValue(argv, '--iterations');
  const iterations =
    rawIterations === undefined ? HARNESS_EVAL_MIN_ITERATIONS_V1 : Number(rawIterations);
  if (!Number.isSafeInteger(iterations) || iterations < HARNESS_EVAL_MIN_ITERATIONS_V1) {
    throw new Error(`--iterations must be an integer >= ${HARNESS_EVAL_MIN_ITERATIONS_V1}`);
  }
  const output = optionValue(argv, '--out');
  const createdAt = optionValue(argv, '--created-at');
  return { iterations, ...(output ? { output } : {}), ...(createdAt ? { createdAt } : {}) };
}

export function runHarnessEvalV1(
  args: HarnessEvalArgumentsV1,
  runtime: HarnessEvalRuntimeV1 = SYSTEM_HARNESS_EVAL_RUNTIME_V1
): {
  readonly baseline: HarnessEvalReceiptV1;
  readonly candidate: HarnessEvalReceiptV1;
  readonly comparison: ReturnType<typeof compareHarnessEvalReceiptsV1>;
} {
  const corpusRaw = readFileSync(corpusPath);
  const corpus = parseCorpus(corpusRaw.toString('utf8'));
  const toolContext: ToolContext = {
    cwd: repoRoot,
    config: { name: 'orion-code', mode: 'harness-eval' },
  };
  const universe = createProductionFirstPartyToolUniverseV1({ context: toolContext });
  const authority = createAuthoritySnapshotV1({
    authorityId: 'harness-eval-workspace',
    projectRoot: repoRoot,
    confirmation: 'allow',
    filesystem: 'workspace',
    network: 'write',
  });
  const baselineSamples: HarnessEvalSampleV1[] = [];
  const candidateSamples: HarnessEvalSampleV1[] = [];

  for (let iteration = 1; iteration <= args.iterations; iteration += 1) {
    for (const task of corpus.tasks) {
      baselineSamples.push(runBaselineSample(task, iteration));
      candidateSamples.push(
        runCandidateSample(task, iteration, universe.catalog.candidates, authority, runtime.now)
      );
    }
  }

  const source = sourceMetadata();
  const environment = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  } as const;
  const corpusMetadata = {
    id: corpus.id,
    digest: createHash('sha256').update(corpusRaw).digest('hex'),
    taskCount: corpus.tasks.length,
    iterations: args.iterations,
    provider: corpus.provider,
    providerCorrectnessDependency: false as const,
  };
  const createdAt = args.createdAt ?? new Date().toISOString();
  const baseline = createHarnessEvalReceiptV1({
    mode: 'baseline',
    createdAt,
    source,
    environment,
    corpus: corpusMetadata,
    samples: baselineSamples,
  });
  const candidate = createHarnessEvalReceiptV1({
    mode: 'candidate',
    createdAt,
    source,
    environment,
    corpus: corpusMetadata,
    samples: candidateSamples,
  });
  return {
    baseline,
    candidate,
    comparison: compareHarnessEvalReceiptsV1(baseline, candidate),
  };
}

function runBaselineSample(task: HarnessEvalTaskV1, iteration: number): HarnessEvalSampleV1 {
  const promptTokens = promptTokensForTask(task);
  const evidenceTokens = estimateTokens(task.expectedEvidence);
  const inputTokens =
    task.modelRequests * (promptTokens + FROZEN_BASELINE_SCHEMA_TOKENS) + evidenceTokens;
  return {
    id: sampleId('baseline', task.id, iteration),
    taskId: task.id,
    iteration,
    success: true,
    completionClaimed: true,
    evidenceSatisfied: true,
    falseCompletion: false,
    inputTokens,
    modelRequests: task.modelRequests,
    expansionSteps: 0,
    orchestrationMs: 0,
    toolSchemaBytes: CURRENT_TOOL_SCHEMA_BASELINE_V1.bytes,
    toolSchemaTokens: FROZEN_BASELINE_SCHEMA_TOKENS,
    directTools: [...task.requiredTools].sort(compare),
    omittedRequiredTools: [],
  };
}

function runCandidateSample(
  task: HarnessEvalTaskV1,
  iteration: number,
  tools: Parameters<typeof compileCapabilityPlanV1>[0]['tools'],
  authority: Parameters<typeof compileCapabilityPlanV1>[0]['authority'],
  now: () => number
): HarnessEvalSampleV1 {
  const started = now();
  const compilation = compileCapabilityPlanV1({
    baseMode: 'build',
    taskContextRevision: 0,
    task: {
      objective: task.objective,
      criteria: task.criteria,
      explicitToolIds: task.requiredTools,
    },
    model: { toolCalling: true },
    authority,
    hardDeniedTools: [],
    budgets: {
      maxDirectTools: 12,
      maxToolSchemaBytes: CURRENT_TOOL_SCHEMA_BASELINE_V1.bytes,
      maxDeferredTools: 32,
      maxExpansionTools: 1,
    },
    tools,
    skills: [],
    receipt: {
      requestId: `eval-request-${task.id}-${iteration}`,
      threadId: 'eval-thread-v1',
      turnId: `eval-turn-${task.id}-${iteration}`,
      stepId: `eval-step-${task.id}-${iteration}`,
      durableCommitId: `eval-commit-${task.id}-${iteration}`,
      createdAt: iteration,
    },
    runtimeServicesDigest: 'eval-runtime-services-v1',
    executionPolicyDigest: 'eval-execution-policy-v1',
    skillCatalogDigest: 'eval-empty-skill-catalog-v1',
    mcpCatalogDigest: 'eval-empty-mcp-catalog-v1',
    estimatedInputTokens: promptTokensForTask(task),
  });
  const orchestrationMs = now() - started;
  const directTools = compilation.receipt.directToolNames;
  const directSet = new Set(directTools);
  const omittedRequiredTools = task.requiredTools
    .filter(tool => !directSet.has(tool))
    .sort(compare);
  const facades = compilation.directToolBindings.map(binding =>
    descriptorFacade(binding.descriptor)
  );
  const toolSchemaJson = JSON.stringify(toOpenAITools(facades));
  const toolSchemaTokens = estimateTokens(toolSchemaJson);
  const promptTokens = promptTokensForTask(task);
  const evidenceSatisfied = omittedRequiredTools.length === 0;
  const completionClaimed = evidenceSatisfied;
  return {
    id: sampleId('candidate', task.id, iteration),
    taskId: task.id,
    iteration,
    success: completionClaimed && evidenceSatisfied,
    completionClaimed,
    evidenceSatisfied,
    falseCompletion: completionClaimed && !evidenceSatisfied,
    inputTokens:
      task.modelRequests * (promptTokens + toolSchemaTokens) +
      estimateTokens(task.expectedEvidence),
    modelRequests: task.modelRequests,
    expansionSteps: compilation.receipt.expansion ? 1 : 0,
    orchestrationMs,
    toolSchemaBytes: Buffer.byteLength(toolSchemaJson, 'utf8'),
    toolSchemaTokens,
    directTools,
    omittedRequiredTools,
    capabilityReceiptDigest: compilation.receipt.digest,
  };
}

function descriptorFacade(
  descriptor: Parameters<typeof compileCapabilityPlanV1>[0]['tools'][number]['descriptor']
): OrionCodeTool {
  return {
    name: descriptor.name,
    aliases: [...descriptor.aliases],
    description: descriptor.description,
    parameters: structuredClone(descriptor.inputSchema),
    execute: async () => ({ success: false, output: '', error: 'eval facade is not executable' }),
  };
}

function promptTokensForTask(task: HarnessEvalTaskV1): number {
  return estimateTokens(
    [
      'You are Orion Code. Complete the task and only claim completion with durable evidence.',
      task.objective,
      ...task.criteria,
    ].join('\n')
  );
}

function parseCorpus(raw: string): EvalCorpusFileV1 {
  const value = JSON.parse(raw) as EvalCorpusFileV1;
  if (
    value?.version !== 1 ||
    value.provider !== 'deterministic-capability-contract' ||
    !value.id?.trim() ||
    !Array.isArray(value.tasks) ||
    value.tasks.length === 0
  ) {
    throw new Error('Invalid harness eval corpus.');
  }
  const ids = new Set<string>();
  for (const task of value.tasks) {
    if (
      !task.id?.trim() ||
      ids.has(task.id) ||
      !task.objective?.trim() ||
      !Array.isArray(task.requiredTools) ||
      task.requiredTools.length === 0 ||
      !Number.isSafeInteger(task.modelRequests) ||
      task.modelRequests <= 0
    ) {
      throw new Error(`Invalid harness eval task ${task?.id ?? '<unknown>'}.`);
    }
    ids.add(task.id);
  }
  return value;
}

function sourceMetadata(): HarnessEvalReceiptV1['source'] {
  const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
    version: string;
  };
  return {
    gitSha: commandOutput('git', ['rev-parse', 'HEAD'], 'unknown'),
    branch: commandOutput('git', ['branch', '--show-current'], 'detached'),
    dirty: commandOutput('git', ['status', '--porcelain'], '').length > 0,
    packageVersion: packageJson.version,
  };
}

function commandOutput(command: string, args: readonly string[], fallback: string): string {
  const result = spawnSync(command, [...args], { cwd: repoRoot, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() || fallback : fallback;
}

function sampleId(mode: string, taskId: string, iteration: number): string {
  return `${mode}:${taskId}:${String(iteration).padStart(3, '0')}`;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function optionValue(argv: readonly string[], name: string): string | undefined {
  const inline = argv.find(value => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function main(): void {
  const args = parseHarnessEvalArgumentsV1(process.argv.slice(2));
  const result = runHarnessEvalV1(args);
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) {
    const target = resolve(args.output);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, output, { encoding: 'utf8', mode: 0o600 });
  }
  process.stdout.write(output);
  if (result.comparison.decision !== 'GO') process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ kind: 'orion.harness-eval-error', failClosed: true, error: error instanceof Error ? error.message : String(error) })}\n`
    );
    process.exitCode = 1;
  }
}
