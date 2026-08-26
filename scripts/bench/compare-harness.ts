#!/usr/bin/env ts-node

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import {
  compareHarnessBenchmarkReceipts,
  verifyHarnessBenchmarkReceipt,
  type HarnessBenchmarkThresholdsV1,
} from '../../src/runtime/harness-metrics';

interface CompareArguments {
  baseline: string;
  candidate: string;
  output?: string;
  minimumSchemaReductionPercent: number;
  minimumColdDurationReductionPercent: number;
}

function optionValue(args: string[], name: string): string | undefined {
  const inline = args.find(value => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function percentage(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`${name} must be a percentage between 0 and 100`);
  }
  return parsed;
}

export function parseCompareArguments(args: string[]): CompareArguments {
  const baseline = optionValue(args, '--baseline');
  const candidate = optionValue(args, '--candidate');
  if (!baseline || !candidate) {
    throw new Error('Usage: compare-harness --baseline <receipt.json> --candidate <receipt.json>');
  }
  return {
    baseline,
    candidate,
    ...(optionValue(args, '--out') ? { output: resolve(optionValue(args, '--out')!) } : {}),
    minimumSchemaReductionPercent: percentage(
      optionValue(args, '--minimum-schema-reduction'),
      50,
      '--minimum-schema-reduction'
    ),
    minimumColdDurationReductionPercent: percentage(
      optionValue(args, '--minimum-cold-duration-reduction'),
      30,
      '--minimum-cold-duration-reduction'
    ),
  };
}

function readReceipt(path: string) {
  return verifyHarnessBenchmarkReceipt(JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown);
}

function main(): void {
  const args = parseCompareArguments(process.argv.slice(2));
  const thresholds: HarnessBenchmarkThresholdsV1 = {
    minimumSchemaReductionPercent: args.minimumSchemaReductionPercent,
    minimumColdDurationReductionPercent: args.minimumColdDurationReductionPercent,
  };
  const comparison = compareHarnessBenchmarkReceipts(
    readReceipt(args.baseline),
    readReceipt(args.candidate),
    thresholds
  );
  const serialized = `${JSON.stringify(comparison, null, 2)}\n`;
  if (args.output) {
    mkdirSync(dirname(args.output), { recursive: true });
    writeFileSync(args.output, serialized, { mode: 0o600 });
  }
  process.stdout.write(serialized);
  if (!comparison.ok) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    process.exitCode = 1;
  }
}
