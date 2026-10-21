/**
 * v0.3.28 — TUI formatting of review receipts (plan S3). The formatter must
 * keep the honest-state invariants: empty scope ≠ review pass, partial /
 * inconclusive ≠ green, invalid findings stay visible.
 */
import { computeReceiptDigest, type CodeReviewResultV1 } from '../src/services/code-review/contract';
import { formatReviewReport } from '../src/services/code-review/format';

function baseResult(overrides: Partial<CodeReviewResultV1> = {}): CodeReviewResultV1 {
  const base = {
    schemaVersion: 1 as const,
    reviewId: 'cr-0123456789abcdef',
    workspaceIdentity: '/repo',
    sessionId: 's',
    threadId: 't',
    turnId: '1',
    requestedSelector: { kind: 'worktree' } as const,
    resolvedTarget: { kind: 'worktree' as const, snapshotId: 'rev-abc' },
    inputSnapshotDigest: 'a'.repeat(64),
    rulesDigest: 'b'.repeat(64),
    state: 'completed' as const,
    conclusion: 'no_findings' as const,
    findings: [],
    invalidFindingCount: 0,
    coverage: {
      inspectedFiles: ['app.ts'],
      inspectedRanges: [],
      skipped: [],
      truncated: false,
      budgetExhausted: [],
    },
    coverageAssertion: { complete: true },
    limits: [],
    model: { provider: 'orion-llm', model: 'probe' },
    usage: { inputTokens: 10, outputTokens: 5 },
    startedAt: 0,
    endedAt: 1,
  };
  const merged = { ...base, ...overrides } as Omit<CodeReviewResultV1, 'receiptDigest'>;
  return Object.freeze({ ...merged, receiptDigest: computeReceiptDigest(merged) });
}

describe('v0.3.28 — formatReviewReport', () => {
  test('empty scope is reported as nothing to review, not as a review pass', () => {
    const report = formatReviewReport(
      baseResult({ limits: ['empty_scope_no_changes'], coverage: {
        inspectedFiles: [],
        inspectedRanges: [],
        skipped: [],
        truncated: false,
        budgetExhausted: [],
      } })
    );
    expect(report).toContain('No changes under the selected scope');
    expect(report).not.toContain('No findings');
  });

  test('a completed no-findings review states the bounded conclusion', () => {
    const report = formatReviewReport(baseResult());
    expect(report).toContain('Review completed.');
    expect(report).toContain('No findings within the reviewed scope.');
  });

  test('findings render priority, location, trigger, impact and evidence', () => {
    const report = formatReviewReport(
      baseResult({
        conclusion: 'findings',
        findings: [
          {
            findingId: 'abcd1234',
            priority: 'P0',
            title: 'Unguarded division',
            trigger: 'denominator is zero',
            impact: 'crash',
            fileKey: '0123456789abcdef0123',
            side: 'new',
            startLine: 2,
            endLine: 3,
            evidence: 'line 2',
          },
        ],
      })
    );
    expect(report).toContain('[P0] Unguarded division');
    expect(report).toContain('new:2-3');
    expect(report).toContain('Trigger: denominator is zero');
    expect(report).toContain('Impact: crash');
    expect(report).toContain('Evidence: line 2');
  });

  test('fileLabels resolve fileKeys to human paths', () => {
    const report = formatReviewReport(
      baseResult({
        conclusion: 'findings',
        findings: [
          {
            findingId: 'abcd1234',
            priority: 'P1',
            title: 't',
            trigger: 'tr',
            impact: 'im',
            fileKey: '0123456789abcdef0123',
            side: 'old',
            startLine: 1,
            endLine: 1,
            evidence: 'ev',
          },
        ],
      }),
      new Map([['0123456789abcdef0123', 'src/app.ts']])
    );
    expect(report).toContain('Location: src/app.ts old:1-1');
  });

  test('partial runs never render as a clean pass and show skips', () => {
    const report = formatReviewReport(
      baseResult({
        state: 'partial',
        conclusion: 'inconclusive',
        invalidFindingCount: 2,
        coverage: {
          inspectedFiles: ['app.ts'],
          inspectedRanges: [],
          skipped: [{ fileKey: 'secret.env', reason: 'sensitive' }],
          truncated: true,
          budgetExhausted: ['maxBodyBytes'],
        },
        coverageAssertion: { complete: false, reason: 'skipped files' },
        limits: ['prompt_material_truncated'],
      })
    );
    expect(report).toContain('Review PARTIAL');
    expect(report).toContain('2 finding(s) from the model were invalid');
    expect(report).toContain('skipped: secret.env (sensitive)');
    expect(report).toContain('Budget exhausted: maxBodyBytes');
    expect(report).toContain('Limit: prompt_material_truncated');
    expect(report).not.toContain('No findings within the reviewed scope.');
  });

  test('failed and cancelled runs state that no conclusions can be drawn', () => {
    expect(formatReviewReport(baseResult({ state: 'failed', conclusion: 'inconclusive' }))).toContain(
      'Review FAILED'
    );
    expect(
      formatReviewReport(baseResult({ state: 'cancelled', conclusion: 'inconclusive' }))
    ).toContain('Review CANCELLED');
  });

  test('the receipt digest is printed for verification', () => {
    const result = baseResult();
    expect(formatReviewReport(result)).toContain(
      `Receipt digest: ${result.receiptDigest.slice(0, 16)}`
    );
  });
});
