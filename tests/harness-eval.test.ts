import {
  compareHarnessEvalReceiptsV1,
  createHarnessEvalReceiptV1,
  verifyHarnessEvalReceiptV1,
  type HarnessEvalSampleV1,
} from '../src/runtime/harness-eval';
import { parseHarnessEvalArgumentsV1, runHarnessEvalV1 } from '../scripts/bench/harness-eval';

describe('HarnessEvalReceiptV1', () => {
  test('runs the deterministic same-environment corpus and meets every v0.2.0 gate', () => {
    const result = runHarnessEvalV1({
      iterations: 30,
      createdAt: '2026-08-26T00:00:00.000Z',
    });

    expect(result.baseline.summary).toMatchObject({ successRate: 100, falseCompletionRate: 0 });
    expect(result.candidate.summary).toMatchObject({
      successRate: 100,
      falseCompletionRate: 0,
      successfulModelRequestsP50: 2,
      expansionStepRate: 0,
    });
    expect(result.candidate.summary.successfulInputTokensP50).toBeLessThan(
      result.baseline.summary.successfulInputTokensP50 * 0.7
    );
    expect(result.candidate.summary.orchestrationMsP95).toBeLessThan(5);
    expect(result.comparison.decision).toBe('GO');
    expect(result.comparison.checks.every(check => check.status === 'pass')).toBe(true);
    expect(verifyHarnessEvalReceiptV1(result.candidate)).toEqual(result.candidate);
  });

  test('fails closed on false completion, lower success, or tampered samples', () => {
    const result = runHarnessEvalV1({
      iterations: 30,
      createdAt: '2026-08-26T00:00:00.000Z',
    });
    const first = result.candidate.samples[0];
    const failed: HarnessEvalSampleV1 = {
      ...first,
      success: false,
      completionClaimed: true,
      evidenceSatisfied: false,
      falseCompletion: true,
    };
    const candidate = createHarnessEvalReceiptV1({
      mode: 'candidate',
      createdAt: result.candidate.createdAt,
      source: result.candidate.source,
      environment: result.candidate.environment,
      corpus: result.candidate.corpus,
      samples: [failed, ...result.candidate.samples.slice(1)],
    });

    expect(compareHarnessEvalReceiptsV1(result.baseline, candidate)).toMatchObject({
      decision: 'NO_GO',
      checks: expect.arrayContaining([
        expect.objectContaining({ id: 'task-success-not-lower', status: 'fail' }),
        expect.objectContaining({ id: 'false-completion-rate', status: 'fail' }),
      ]),
    });
    expect(() =>
      verifyHarnessEvalReceiptV1({ ...candidate, receiptDigest: '0'.repeat(64) })
    ).toThrow('digest mismatch');
  });

  test('requires at least thirty iterations', () => {
    expect(() => parseHarnessEvalArgumentsV1(['--iterations', '29'])).toThrow('>= 30');
    expect(parseHarnessEvalArgumentsV1([])).toEqual({ iterations: 30 });
  });
});
