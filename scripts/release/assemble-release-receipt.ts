#!/usr/bin/env ts-node

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';

import {
  compareHarnessEvalReceiptsV1,
  verifyHarnessEvalReceiptV1,
  type HarnessEvalComparisonV1,
  type HarnessEvalReceiptV1,
} from '../../src/runtime/harness-eval';
import { verifyArchitectureConfluenceReceiptV1 } from '../../src/runtime/harness-confluence';
import {
  compareHarnessBenchmarkReceipts,
  verifyHarnessBenchmarkReceipt,
  type HarnessBenchmarkComparisonV1,
} from '../../src/runtime/harness-metrics';
import { digestRuntimeValue } from '../../src/runtime/protocol/canonical';
import {
  createReleaseReceiptV1,
  verifyGateEvidenceReceiptV1,
  verifyRuntimeMatrixReceiptV1,
  verifyTarballArtifactReceiptV1,
  verifyWebE2EReleaseReceiptV1,
} from '../../src/runtime/release-receipts';

interface AssembleArgumentsV1 {
  readonly artifact: string;
  readonly runtimes: readonly string[];
  readonly benchmarkBaseline: string;
  readonly benchmarkCandidate: string;
  readonly benchmarkComparison: string;
  readonly evaluation: string;
  readonly confluence: string;
  readonly fullTests: string;
  readonly webE2E: string;
  readonly output: string;
}

export function parseAssembleReleaseArgumentsV1(argv: readonly string[]): AssembleArgumentsV1 {
  const required = (name: string): string => {
    const value = optionValue(argv, name);
    if (!value) throw new Error(`${name} is required.`);
    return resolve(value);
  };
  const runtimes = optionValues(argv, '--runtime').map(value => resolve(value));
  if (runtimes.length === 0) throw new Error('At least one --runtime receipt is required.');
  return {
    artifact: required('--artifact'),
    runtimes,
    benchmarkBaseline: required('--benchmark-baseline'),
    benchmarkCandidate: required('--benchmark-candidate'),
    benchmarkComparison: required('--benchmark-comparison'),
    evaluation: required('--evaluation'),
    confluence: required('--confluence'),
    fullTests: required('--full-tests'),
    webE2E: required('--web-e2e'),
    output: required('--out'),
  };
}

function main(): void {
  const args = parseAssembleReleaseArgumentsV1(process.argv.slice(2));
  const artifact = verifyTarballArtifactReceiptV1(readJson(args.artifact));
  const runtimes = args.runtimes.map(path => verifyRuntimeMatrixReceiptV1(readJson(path)));
  const baseline = verifyHarnessBenchmarkReceipt(readJson(args.benchmarkBaseline));
  const candidate = verifyHarnessBenchmarkReceipt(readJson(args.benchmarkCandidate));
  const suppliedBenchmark = readJson(args.benchmarkComparison) as HarnessBenchmarkComparisonV1;
  const benchmark = compareHarnessBenchmarkReceipts(
    baseline,
    candidate,
    suppliedBenchmark.thresholds
  );
  if (digestRuntimeValue(benchmark) !== digestRuntimeValue(suppliedBenchmark)) {
    throw new Error('Harness benchmark comparison does not match its verified source receipts.');
  }
  const evaluation = readJson(args.evaluation) as {
    baseline: HarnessEvalReceiptV1;
    candidate: HarnessEvalReceiptV1;
    comparison: HarnessEvalComparisonV1;
  };
  const evalBaseline = verifyHarnessEvalReceiptV1(evaluation.baseline);
  const evalCandidate = verifyHarnessEvalReceiptV1(evaluation.candidate);
  const evalComparison = compareHarnessEvalReceiptsV1(evalBaseline, evalCandidate);
  if (evalComparison.receiptDigest !== evaluation.comparison?.receiptDigest) {
    throw new Error('Harness task evaluation comparison does not match its source receipts.');
  }
  const confluence = verifyArchitectureConfluenceReceiptV1(
    readJson(args.confluence) as Parameters<typeof verifyArchitectureConfluenceReceiptV1>[0]
  );
  const fullTests = verifyGateEvidenceReceiptV1(readJson(args.fullTests));
  if (fullTests.gateId !== 'full-tests') {
    throw new Error(`Expected full-tests evidence, received ${fullTests.gateId}.`);
  }
  const webE2E = verifyWebE2EReleaseReceiptV1(readJson(args.webE2E));
  assertSourceBinding(artifact, candidate.source.gitSha, candidate.source.packageVersion);
  assertSourceBinding(artifact, evalCandidate.source.gitSha, evalCandidate.source.packageVersion);
  assertSourceBinding(artifact, fullTests.source.gitSha, fullTests.source.packageVersion);
  assertSourceBinding(artifact, webE2E.source.gitSha, webE2E.package.version);
  if (
    webE2E.artifactReceiptDigest !== artifact.receiptDigest ||
    webE2E.tarballSha256 !== artifact.tarball.sha256 ||
    webE2E.package.name !== artifact.package.name
  ) {
    throw new Error('Web E2E evidence is not bound to the exact release artifact.');
  }
  const receipt = createReleaseReceiptV1({
    createdAt: new Date().toISOString(),
    artifact,
    runtimeMatrix: runtimes,
    webE2E,
    evidence: {
      benchmarkComparisonDigest: digestRuntimeValue(benchmark),
      benchmarkOk: benchmark.ok,
      taskEvalComparisonDigest: evalComparison.receiptDigest,
      taskEvalDecision: evalComparison.decision,
      architectureConfluenceDigest: confluence.digest,
      architectureDecision: confluence.decision,
      fullTestDigest: fullTests.receiptDigest,
      fullTestsPassed: fullTests.status === 'pass',
      webE2EReceiptDigest: webE2E.receiptDigest,
      webE2EDecision: webE2E.decision,
    },
  });
  mkdirSync(dirname(args.output), { recursive: true });
  writeFileSync(args.output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (receipt.decision !== 'GO') process.exitCode = 1;
}

function assertSourceBinding(
  artifact: ReturnType<typeof verifyTarballArtifactReceiptV1>,
  gitSha: string,
  packageVersion: string
): void {
  if (gitSha !== artifact.source.gitSha || packageVersion !== artifact.package.version) {
    throw new Error('Release evidence is not bound to the exact artifact source and version.');
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function optionValue(argv: readonly string[], name: string): string | undefined {
  const inline = argv.find(value => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function optionValues(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith(`${name}=`)) values.push(value.slice(name.length + 1));
    else if (value === name && argv[index + 1]) values.push(argv[++index]);
  }
  return values;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ kind: 'orion.release-receipt-error', failClosed: true, error: error instanceof Error ? error.message : String(error) })}\n`
    );
    process.exitCode = 1;
  }
}
