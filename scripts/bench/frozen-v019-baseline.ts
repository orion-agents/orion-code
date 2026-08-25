#!/usr/bin/env ts-node

import { dirname, resolve } from 'path';
import { mkdirSync, writeFileSync } from 'fs';

import {
  createHarnessBenchmarkReceipt,
  verifyHarnessBenchmarkReceipt,
  type HarnessBenchmarkSampleV1,
  type SkillBenchmarkMetricsV1,
  type McpBenchmarkMetricsV1,
} from '../../src/runtime/harness-metrics';

/**
 * Immutable Phase-0 evidence captured before the v0.2.0 breaking cut removed
 * the eager v0.1.9 Tool/Skill/MCP owners. Replaying old production code inside
 * the release branch would itself violate the no-legacy-runtime invariant, so
 * CI verifies and compares this original digest-bound 30+30 sample receipt.
 */
export const FROZEN_V019_BASELINE_RECEIPT_DIGEST =
  'e47e04985ea28b713dfd06abfdcb2feeb047927a81e15382b3f4d126c794abf8';

const COLD_DURATION_MS = [
  879.989583, 853.2377909999999, 868.2105000000001, 853.890042, 864.977334,
  856.8560420000001, 859.1752909999999, 872.310917, 852.4465, 864.967083,
  847.6187499999999, 849.1483750000001, 861.3438749999999, 869.9471250000001,
  851.2830839999999, 852.2851670000001, 855.428958, 874.845125, 890.1485419999999,
  855.735917, 855.9555, 897.8650000000001, 927.678792, 907.3299159999999,
  910.3729999999999, 906.050416, 923.0755000000001, 905.1407499999999,
  908.3416669999999, 893.3895829999999,
] as const;

const COLD_SCHEMA_MS = [
  1.8359159999999974, 1.6607919999999012, 1.8514999999999873, 2.03120899999999,
  1.9729999999999563, 1.61850000000004, 1.7913750000000164, 1.7702080000001388,
  1.966959000000088, 1.8152919999999995, 1.601667000000134, 1.6663750000000164,
  1.6897080000001097, 1.6711659999998574, 1.6202920000000631, 1.6734579999999823,
  1.8155000000001564, 1.6097910000000866, 1.6720410000000356, 1.6676250000000437,
  1.6752919999998994, 1.597582999999986, 1.8019580000000133, 1.8075420000000122,
  1.6244999999998981, 1.6637499999999363, 1.7940000000000964,
  1.5975830000002134, 1.5975000000000819, 1.6437499999999545,
] as const;

const WARM_DURATION_MS = [
  0.6071669999998903, 0.5779160000001866, 0.5903749999999945, 0.5601249999999709,
  0.5773750000000746, 0.5017910000001393, 0.47358299999996234,
  0.48766699999987395, 0.47695800000019517, 0.46612499999991996,
  0.4602500000000873, 0.46154200000000856, 0.4598750000000109,
  0.49424999999996544, 0.5000840000000153, 0.47404100000017024,
  0.5740419999999631, 0.46241600000007566, 0.4672499999999218,
  0.4574170000000777, 0.4580829999999878, 0.4572920000000522,
  0.45858300000008967, 0.4713329999999587, 0.45775000000003274,
  0.48095899999998437, 0.45837500000016007, 0.4727919999997994,
  0.45858300000008967, 0.45745899999997164,
] as const;

const TOOL_SCHEMA = Object.freeze({
  count: 33,
  bytes: 20_596,
  estimatedTokens: 6_582,
  sha256: '29a9ccb14a036e132fa86d52ce6ab421e1c9791fac15e982cad4b1d288d1bde2',
});

const COLD_SKILLS: SkillBenchmarkMetricsV1 = Object.freeze({
  instrumented: true,
  catalogLists: 1,
  descriptorsObserved: 3,
  definitionLoads: 6,
  definitionBytes: 5_504,
  resourceLoads: 0,
  resourceBytes: 0,
  residentDefinitions: 3,
});

const WARM_SKILLS: SkillBenchmarkMetricsV1 = Object.freeze({
  ...COLD_SKILLS,
  catalogLists: 0,
  descriptorsObserved: 0,
  definitionLoads: 0,
  definitionBytes: 0,
});

const COLD_MCP: McpBenchmarkMetricsV1 = Object.freeze({
  instrumented: true,
  descriptorLists: 1,
  descriptorsObserved: 5,
  connectAttempts: 5,
  connectionsOpened: 5,
  processesSpawned: 5,
  socketsOpened: 0,
  leasesAcquired: 0,
  activeConnections: 5,
  activeProcesses: 5,
});

const WARM_MCP: McpBenchmarkMetricsV1 = Object.freeze({
  ...COLD_MCP,
  descriptorLists: 0,
  descriptorsObserved: 0,
  connectAttempts: 0,
  connectionsOpened: 0,
  processesSpawned: 0,
});

function sample(
  phase: 'cold' | 'warm',
  index: number,
  durationMs: number,
  schemaSerializationMs: number
): HarnessBenchmarkSampleV1 {
  return {
    id: `${phase}-${String(index + 1).padStart(3, '0')}`,
    phase,
    iteration: index + 1,
    durationMs,
    schemaSerializationMs,
    toolSchema: TOOL_SCHEMA,
    skills: phase === 'cold' ? COLD_SKILLS : WARM_SKILLS,
    mcp: phase === 'cold' ? COLD_MCP : WARM_MCP,
  };
}

export function createFrozenV019HarnessBaseline() {
  const receipt = createHarnessBenchmarkReceipt({
    mode: 'baseline',
    createdAt: '2026-08-26T00:00:00.000Z',
    source: {
      gitSha: '1010418f24a6d07a22074435bd4d50a9d339391c',
      branch: 'v0.2.0',
      dirty: true,
      packageName: '@orion-agents/orion-code',
      packageVersion: '0.1.9',
    },
    environment: {
      node: 'v26.5.1',
      npm: '11.17.0',
      platform: 'darwin',
      arch: 'arm64',
    },
    fixture: {
      id: 'orion-harness-runtime-baseline-v1',
      sha256: 'c78560a2ebb27b63d0c40761e5fdf28b9895f0420b7e1b23f5736de78d5138eb',
      provider: 'deterministic-none',
      providerCorrectnessDependency: false,
      configuredSkillSet: 'builtin-only',
      configuredMcpServers: 5,
    },
    coldSamples: COLD_DURATION_MS.map((duration, index) =>
      sample('cold', index, duration, COLD_SCHEMA_MS[index])
    ),
    warmSamples: WARM_DURATION_MS.map((duration, index) =>
      sample('warm', index, duration, duration)
    ),
  });
  return verifyHarnessBenchmarkReceipt(receipt);
}

function optionValue(args: readonly string[], name: string): string | undefined {
  const inline = args.find(value => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function main(): void {
  const receipt = createFrozenV019HarnessBaseline();
  if (receipt.receiptDigest !== FROZEN_V019_BASELINE_RECEIPT_DIGEST) {
    throw new Error(
      `Frozen v0.1.9 baseline digest drifted: ${receipt.receiptDigest} != ${FROZEN_V019_BASELINE_RECEIPT_DIGEST}`
    );
  }
  const json = `${JSON.stringify(receipt, null, 2)}\n`;
  const output = optionValue(process.argv.slice(2), '--out');
  if (!output) {
    process.stdout.write(json);
    return;
  }
  const target = resolve(output);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, json, 'utf8');
  process.stdout.write(`${JSON.stringify({ receipt: target, digest: receipt.receiptDigest })}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error) })}\n`);
    process.exitCode = 1;
  }
}
