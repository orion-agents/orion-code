/**
 * v0.3.23 T23-A — A/B comparison of two coding-task eval receipts.
 *
 * Consumes two receipts (fake or live) produced by `coding-task-eval.ts` and
 * reports the per-metric deltas required by the plan: solvedRate,
 * falseCompletionRate, tokensPerSolvedTask, modelRequestsPerTask,
 * toolCallsPerTask, latency P50/P95, retryCount and costPerSolvedTask — with
 * the raw samples preserved so no run can be cherry-picked.
 */
import { readFileSync, writeFileSync } from 'fs';

import type { CodingTaskEvalReceiptV1 } from './coding-task-eval';

export interface ComparisonRowV1 {
  readonly metric: string;
  readonly baseline: number;
  readonly candidate: number;
  readonly delta: number;
  /** Relative change vs baseline; null when the baseline is zero. */
  readonly relativeDelta: number | null;
  readonly betterWhenLower: boolean;
}

export interface CodingTaskComparisonV1 {
  readonly version: 1;
  readonly kind: 'orion.coding-task-eval-comparison';
  readonly createdAt: string;
  readonly baseline: {
    readonly gitSha: string;
    readonly packageVersion: string;
    readonly mode: string;
    readonly createdAt: string;
  };
  readonly candidate: {
    readonly gitSha: string;
    readonly packageVersion: string;
    readonly mode: string;
    readonly createdAt: string;
  };
  readonly raw: {
    readonly baseline: readonly unknown[];
    readonly candidate: readonly unknown[];
  };
  readonly rows: readonly ComparisonRowV1[];
  readonly verdict: {
    /** solvedRate must not drop for an efficiency claim to stand. */
    readonly solvedRateNotDropped: boolean;
    readonly falseCompleteZeroInCandidate: boolean;
  };
}

function perSolved(receipt: CodingTaskEvalReceiptV1, total: number): number {
  const solved = receipt.samples.filter(sample => sample.solved).length;
  return solved === 0 ? 0 : Math.round((total / solved) * 100) / 100;
}

function compareReceipts(
  baseline: CodingTaskEvalReceiptV1,
  candidate: CodingTaskEvalReceiptV1
): CodingTaskComparisonV1 {
  const rows: ComparisonRowV1[] = [];
  const addRow = (
    metric: string,
    baselineValue: number,
    candidateValue: number,
    betterWhenLower: boolean
  ): void => {
    rows.push({
      metric,
      baseline: baselineValue,
      candidate: candidateValue,
      delta: Math.round((candidateValue - baselineValue) * 100) / 100,
      relativeDelta:
        baselineValue === 0
          ? null
          : Math.round(((candidateValue - baselineValue) / baselineValue) * 100) / 100,
      betterWhenLower,
    });
  };
  addRow('solvedRate', baseline.summary.solvedRate, candidate.summary.solvedRate, false);
  addRow(
    'falseCompletionRate',
    baseline.summary.falseComplete,
    candidate.summary.falseComplete,
    true
  );
  addRow(
    'tokensPerSolvedTask',
    perSolved(baseline, baseline.summary.totalTokens),
    perSolved(candidate, candidate.summary.totalTokens),
    true
  );
  addRow(
    'modelRequestsPerTask',
    baseline.summary.attempted === 0
      ? 0
      : Math.round((baseline.summary.totalModelRequests / baseline.summary.attempted) * 100) / 100,
    candidate.summary.attempted === 0
      ? 0
      : Math.round((candidate.summary.totalModelRequests / candidate.summary.attempted) * 100) /
          100,
    true
  );
  addRow(
    'toolCallsPerTask',
    baseline.summary.attempted === 0
      ? 0
      : Math.round(
          (baseline.samples.reduce((sum, sample) => sum + sample.toolCalls, 0) /
            baseline.summary.attempted) *
            100
        ) / 100,
    candidate.summary.attempted === 0
      ? 0
      : Math.round(
          (candidate.samples.reduce((sum, sample) => sum + sample.toolCalls, 0) /
            candidate.summary.attempted) *
            100
        ) / 100,
    true
  );
  addRow('latencyP50Ms', baseline.summary.p50LatencyMs, candidate.summary.p50LatencyMs, true);
  addRow('latencyP95Ms', baseline.summary.p95LatencyMs, candidate.summary.p95LatencyMs, true);
  addRow('retryCount', baseline.summary.totalRetries, candidate.summary.totalRetries, true);
  addRow(
    'costPerSolvedTask',
    perSolved(baseline, baseline.summary.totalTokens * 0.0005),
    perSolved(candidate, candidate.summary.totalTokens * 0.0005),
    true
  );
  return {
    version: 1,
    kind: 'orion.coding-task-eval-comparison',
    createdAt: new Date().toISOString(),
    baseline: {
      gitSha: baseline.source.gitSha,
      packageVersion: baseline.source.packageVersion,
      mode: baseline.mode,
      createdAt: baseline.createdAt,
    },
    candidate: {
      gitSha: candidate.source.gitSha,
      packageVersion: candidate.source.packageVersion,
      mode: candidate.mode,
      createdAt: candidate.createdAt,
    },
    raw: {
      baseline: baseline.samples,
      candidate: candidate.samples,
    },
    rows,
    verdict: {
      solvedRateNotDropped: candidate.summary.solvedRate >= baseline.summary.solvedRate,
      falseCompleteZeroInCandidate: candidate.summary.falseComplete === 0,
    },
  };
}

export { compareReceipts as compareCodingTaskReceiptsV1 };

/** CLI: `node compare-receipts.js --baseline a.json --candidate b.json [--out c.json]` */
export function main(argv: readonly string[] = process.argv.slice(2)): void {
  const optionValue = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const baselinePath = optionValue('--baseline');
  const candidatePath = optionValue('--candidate');
  if (!baselinePath || !candidatePath) {
    process.stderr.write(
      'usage: compare-receipts --baseline <a.json> --candidate <b.json> [--out <c.json>]\n'
    );
    process.exitCode = 2;
    return;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as CodingTaskEvalReceiptV1;
  const candidate = JSON.parse(readFileSync(candidatePath, 'utf8')) as CodingTaskEvalReceiptV1;
  const comparison = compareReceipts(baseline, candidate);
  const rendered = `${JSON.stringify(comparison, null, 2)}\n`;
  const out = optionValue('--out');
  if (out) writeFileSync(out, rendered);
  else process.stdout.write(rendered);
}

if (require.main === module) {
  main();
}
