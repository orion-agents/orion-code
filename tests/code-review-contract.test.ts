/**
 * v0.3.27 PR0 — contract tests for the shared code-review contract. These pin
 * the frozen semantics before any runtime wiring: budgets are ceilings that
 * only tighten, findings validate on shape, conclusions follow the plan's
 * mapping (tool success is not review success), and receipt digests verify by
 * recomputation.
 */
import {
  computeReceiptDigest,
  DEFAULT_REVIEW_BUDGETS,
  resolveReviewBudgets,
  resolveReviewConclusion,
  reviewApplicability,
  validateReviewFinding,
  verifyReceiptDigest,
  type CodeReviewResultV1,
} from '../src/services/code-review/contract';
import type { ReviewFindingV1 } from '../src/services/code-review/contract';

function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    findingId: 'abcd1234',
    priority: 'P1',
    title: 'Unhandled rejection on cancel',
    trigger: 'When the turn is cancelled mid-request',
    impact: 'The process crashes instead of surfacing the interruption',
    fileKey: 'src/runtime/loop.ts',
    side: 'new',
    startLine: 12,
    endLine: 18,
    evidence: 'loop.ts line 14 attaches no rejection handler to the abort path',
    ...overrides,
  };
}

describe('v0.3.27 PR0 — review budgets', () => {
  test('the defaults match the frozen plan values (50 files / 2 MiB / 1 MiB / 50 reads / 5 min / 100 findings / 256 KiB)', () => {
    expect(DEFAULT_REVIEW_BUDGETS).toEqual({
      maxFiles: 50,
      maxBodyBytes: 2 * 1024 * 1024,
      maxDiffBytes: 1024 * 1024,
      maxReadToolCalls: 50,
      maxDurationMs: 5 * 60 * 1000,
      maxFindings: 100,
      maxResultBytes: 256 * 1024,
    });
  });

  test('overrides may only tighten, never widen', () => {
    expect(resolveReviewBudgets({ maxFiles: 10 })).toEqual({
      ok: true,
      budgets: { ...DEFAULT_REVIEW_BUDGETS, maxFiles: 10 },
    });
    expect(resolveReviewBudgets({ maxFiles: 51 })).toMatchObject({ ok: false, field: 'maxFiles' });
    expect(resolveReviewBudgets({ maxDurationMs: 6 * 60 * 1000 })).toMatchObject({
      ok: false,
      field: 'maxDurationMs',
    });
    expect(resolveReviewBudgets({ maxFindings: 0 })).toMatchObject({ ok: false });
    expect(resolveReviewBudgets({ maxBodyBytes: Number.NaN })).toMatchObject({ ok: false });
    expect(resolveReviewBudgets({ maxResultBytes: 1.5 })).toMatchObject({ ok: false });
  });
});

describe('v0.3.27 PR0 — finding validation', () => {
  test('accepts a well-formed finding unchanged', () => {
    const result = validateReviewFinding(finding());
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.finding.fileKey).toBe('src/runtime/loop.ts');
  });

  test('rejects structural violations with typed reasons', () => {
    expect(validateReviewFinding(null)).toMatchObject({ valid: false, reason: 'not_an_object' });
    expect(validateReviewFinding([])).toMatchObject({ valid: false, reason: 'not_an_object' });
    expect(validateReviewFinding(finding({ findingId: 'xyz' }))).toMatchObject({
      valid: false,
      reason: 'finding_id_invalid',
    });
    expect(validateReviewFinding(finding({ priority: 'P9' }))).toMatchObject({
      valid: false,
      reason: 'priority_invalid',
    });
    expect(validateReviewFinding(finding({ title: '   ' }))).toMatchObject({
      valid: false,
      reason: 'title_invalid',
    });
    expect(validateReviewFinding(finding({ trigger: '' }))).toMatchObject({
      valid: false,
      reason: 'trigger_invalid',
    });
    expect(validateReviewFinding(finding({ impact: 'x'.repeat(2001) }))).toMatchObject({
      valid: false,
      reason: 'impact_invalid',
    });
    expect(validateReviewFinding(finding({ fileKey: '/abs/path.ts' }))).toMatchObject({
      valid: false,
      reason: 'file_key_invalid',
    });
    expect(validateReviewFinding(finding({ fileKey: 'src/../secret.ts' }))).toMatchObject({
      valid: false,
      reason: 'file_key_invalid',
    });
    expect(validateReviewFinding(finding({ fileKey: 'a\0b' }))).toMatchObject({
      valid: false,
      reason: 'file_key_invalid',
    });
    expect(validateReviewFinding(finding({ side: 'either' }))).toMatchObject({
      valid: false,
      reason: 'side_invalid',
    });
    expect(validateReviewFinding(finding({ startLine: 0, endLine: 3 }))).toMatchObject({
      valid: false,
      reason: 'line_range_invalid',
    });
    expect(validateReviewFinding(finding({ startLine: 5, endLine: 4 }))).toMatchObject({
      valid: false,
      reason: 'line_range_invalid',
    });
    expect(validateReviewFinding(finding({ endLine: '12' }))).toMatchObject({
      valid: false,
      reason: 'line_range_invalid',
    });
    expect(validateReviewFinding(finding({ evidence: 'too short' }))).toMatchObject({
      valid: true,
    });
  });
});

describe('v0.3.27 PR0 — conclusion mapping (tool success is not review success)', () => {
  test('failed and cancelled runs are inconclusive regardless of findings', () => {
    expect(
      resolveReviewConclusion({
        state: 'failed',
        validFindingCount: 3,
        invalidFindingCount: 0,
        coverageComplete: true,
      })
    ).toBe('inconclusive');
    expect(
      resolveReviewConclusion({
        state: 'cancelled',
        validFindingCount: 0,
        invalidFindingCount: 0,
        coverageComplete: true,
      })
    ).toBe('inconclusive');
  });

  test('any valid finding yields findings, even when coverage is incomplete', () => {
    expect(
      resolveReviewConclusion({
        state: 'partial',
        validFindingCount: 2,
        invalidFindingCount: 1,
        coverageComplete: false,
      })
    ).toBe('findings');
    expect(
      resolveReviewConclusion({
        state: 'completed',
        validFindingCount: 1,
        invalidFindingCount: 0,
        coverageComplete: false,
      })
    ).toBe('findings');
  });

  test('partial runs can never assert absence', () => {
    expect(
      resolveReviewConclusion({
        state: 'partial',
        validFindingCount: 0,
        invalidFindingCount: 0,
        coverageComplete: false,
      })
    ).toBe('inconclusive');
  });

  test('completed with only invalid findings is inconclusive, never no_findings', () => {
    expect(
      resolveReviewConclusion({
        state: 'completed',
        validFindingCount: 0,
        invalidFindingCount: 4,
        coverageComplete: true,
      })
    ).toBe('inconclusive');
  });

  test('completed with zero findings requires complete coverage to assert no_findings', () => {
    expect(
      resolveReviewConclusion({
        state: 'completed',
        validFindingCount: 0,
        invalidFindingCount: 0,
        coverageComplete: true,
      })
    ).toBe('no_findings');
    expect(
      resolveReviewConclusion({
        state: 'completed',
        validFindingCount: 0,
        invalidFindingCount: 0,
        coverageComplete: false,
      })
    ).toBe('inconclusive');
  });

  test('non-terminal states cannot receive a conclusion', () => {
    for (const state of ['queued', 'running'] as const) {
      expect(() =>
        resolveReviewConclusion({
          state,
          validFindingCount: 0,
          invalidFindingCount: 0,
          coverageComplete: true,
        })
      ).toThrow(/cannot have a terminal conclusion/);
    }
  });
});

describe('v0.3.27 PR0 — receipt digests and applicability', () => {
  const base = {
    schemaVersion: 1 as const,
    reviewId: 'review-1',
    workspaceIdentity: 'ws-1',
    sessionId: 'session-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    requestedSelector: { kind: 'worktree' as const },
    resolvedTarget: { kind: 'worktree' as const, snapshotId: 'snap-1' },
    inputSnapshotDigest: 'a'.repeat(64),
    rulesDigest: 'b'.repeat(64),
    state: 'completed' as const,
    conclusion: 'no_findings' as const,
    findings: [] as readonly ReviewFindingV1[],
    invalidFindingCount: 0,
    coverage: {
      inspectedFiles: ['src/a.ts'],
      inspectedRanges: [],
      skipped: [],
      truncated: false,
      budgetExhausted: [],
    },
    coverageAssertion: { complete: true },
    limits: [],
    model: { provider: 'fixture', model: 'fixture-model' },
    usage: { inputTokens: 10, outputTokens: 5 },
    startedAt: 1000,
    endedAt: 2000,
  };

  test('the digest verifies by recomputation and detects any content change', () => {
    const receiptDigest = computeReceiptDigest(base);
    const result = { ...base, receiptDigest } as CodeReviewResultV1;
    expect(verifyReceiptDigest(result)).toBe(true);
    expect(verifyReceiptDigest({ ...result, state: 'failed' })).toBe(false);
    expect(verifyReceiptDigest({ ...result, endedAt: 2001 })).toBe(false);
  });

  test('applicability is current only when both input and rules digests match', () => {
    const current = {
      inputSnapshotDigest: base.inputSnapshotDigest,
      rulesDigest: base.rulesDigest,
    };
    expect(reviewApplicability(base, current)).toBe('current');
    expect(reviewApplicability(base, { ...current, inputSnapshotDigest: 'c'.repeat(64) })).toBe(
      'stale'
    );
    expect(reviewApplicability(base, { ...current, rulesDigest: 'd'.repeat(64) })).toBe('stale');
  });
});
