/**
 * v0.3.28 — TUI rendering of a code-review receipt (docs/plan/v0.3.28-plan.md
 * S3). The formatter is deliberately honest about state: a partial, failed,
 * cancelled or inconclusive run never renders as a green "no findings" pass,
 * and an empty scope is reported as "no changes under review", distinct from a
 * completed review that found nothing (v0.3.27 plan §4.1).
 */
import type { CodeReviewResultV1 } from './contract';

const PRIORITY_ORDER = ['P0', 'P1', 'P2', 'P3'] as const;

const STATE_BANNERS: Record<CodeReviewResultV1['state'], string> = {
  queued: 'Review queued.',
  running: 'Review running.',
  completed: 'Review completed.',
  partial: 'Review PARTIAL — coverage was incomplete; findings below are valid but not exhaustive.',
  failed: 'Review FAILED — no conclusions can be drawn from this run.',
  cancelled: 'Review CANCELLED — no conclusions can be drawn from this run.',
};

function formatScope(result: CodeReviewResultV1): string {
  const selector = result.requestedSelector;
  if (selector.kind === 'base') {
    const paths = selector.paths?.length ? ` paths: ${selector.paths.join(', ')}` : '';
    return `base ${selector.ref} (${result.resolvedTarget.baseOid?.slice(0, 12) ?? '?'}..${
      result.resolvedTarget.headOid?.slice(0, 12) ?? '?'
    })${paths}`;
  }
  const paths = selector.paths?.length ? ` paths: ${selector.paths.join(', ')}` : '';
  return `worktree (snapshot ${result.resolvedTarget.snapshotId})${paths}`;
}

/** Renders the full report shown after `/review` finishes. `fileLabels` maps
 *  snapshot fileKeys to human paths when the caller still holds the manifest. */
export function formatReviewReport(
  result: CodeReviewResultV1,
  fileLabels?: ReadonlyMap<string, string>
): string {
  const lines: string[] = [];
  lines.push(`Code review ${result.reviewId} — ${formatScope(result)}`);
  lines.push(
    `Model: ${result.model.provider}/${result.model.model} · input snapshot ${result.inputSnapshotDigest.slice(0, 12)}`
  );

  const emptyScope = result.limits.includes('empty_scope_no_changes');
  if (emptyScope) {
    lines.push('');
    lines.push('No changes under the selected scope — nothing to review.');
    return lines.join('\n');
  }

  lines.push('');
  lines.push(STATE_BANNERS[result.state]);

  if (result.findings.length > 0) {
    lines.push('');
    lines.push(`Findings (${result.findings.length}):`);
    for (const priority of PRIORITY_ORDER) {
      const group = result.findings.filter(finding => finding.priority === priority);
      if (group.length === 0) continue;
      for (const finding of group) {
        lines.push('');
        lines.push(`[${priority}] ${finding.title}`);
        lines.push(
          `  Location: ${fileLabels?.get(finding.fileKey) ?? finding.fileKey.slice(0, 12)} ${
            finding.side
          }:${finding.startLine}-${finding.endLine}`
        );
        lines.push(`  Trigger: ${finding.trigger}`);
        lines.push(`  Impact: ${finding.impact}`);
        lines.push(`  Evidence: ${finding.evidence}`);
      }
    }
  } else if (result.state === 'completed' && result.conclusion === 'no_findings') {
    lines.push('No findings within the reviewed scope.');
  }

  if (result.invalidFindingCount > 0) {
    lines.push('');
    lines.push(
      `${result.invalidFindingCount} finding(s) from the model were invalid or outside the frozen snapshot and are not shown.`
    );
  }

  lines.push('');
  const coverage = result.coverage;
  lines.push(
    `Coverage: ${coverage.inspectedFiles.length} file(s) inspected, ${coverage.skipped.length} skipped${
      coverage.truncated ? ', output truncated' : ''
    }`
  );
  for (const skip of coverage.skipped) {
    lines.push(`  skipped: ${skip.fileKey} (${skip.reason})`);
  }
  if (coverage.budgetExhausted.length > 0) {
    lines.push(`Budget exhausted: ${coverage.budgetExhausted.join(', ')}`);
  }
  for (const limit of result.limits) {
    if (limit !== 'empty_scope_no_changes') lines.push(`Limit: ${limit}`);
  }
  if (!result.coverageAssertion.complete && result.state === 'completed') {
    lines.push(
      `Coverage incomplete: ${result.coverageAssertion.reason ?? 'not all changed files were reviewed'}`
    );
  }
  lines.push(`Receipt digest: ${result.receiptDigest.slice(0, 16)}`);
  return lines.join('\n');
}
