/**
 * v0.3.29 — pure presentation logic for the shared code-review run results in
 * the Review panel (docs/plan/v0.3.29-plan.md S3). Pure functions only so the
 * grouping, banners and composer drafts can be unit-tested without rendering.
 */
import type { ReviewFindingV1 } from '../../../../src/services/code-review/contract';
import type { WebCodeReviewRunRecordV1 } from '../../../../src/web/code-review-run-service';

export type FindingGroups = Readonly<{
  P0: readonly ReviewFindingV1[];
  P1: readonly ReviewFindingV1[];
  P2: readonly ReviewFindingV1[];
  P3: readonly ReviewFindingV1[];
}>;

const PRIORITY_ORDER: readonly (keyof FindingGroups)[] = ['P0', 'P1', 'P2', 'P3'];

/** Groups findings by priority P0→P3, preserving receipt order inside a group. */
export function groupFindingsByPriority(findings: readonly ReviewFindingV1[]): FindingGroups {
  const groups: { P0: ReviewFindingV1[]; P1: ReviewFindingV1[]; P2: ReviewFindingV1[]; P3: ReviewFindingV1[] } = {
    P0: [],
    P1: [],
    P2: [],
    P3: [],
  };
  for (const finding of findings) {
    if (groups[finding.priority]) groups[finding.priority].push(finding);
  }
  return groups;
}

export const PRIORITY_LABELS: Readonly<Record<keyof FindingGroups, string>> = Object.freeze({
  P0: 'P0 阻断',
  P1: 'P1 重要',
  P2: 'P2 一般',
  P3: 'P3 提示',
});

export function priorityOrder(): readonly (keyof FindingGroups)[] {
  return PRIORITY_ORDER;
}

/** Resolves the file path a finding anchors to, via the run's file index. */
export function resolveFindingPath(
  record: Pick<WebCodeReviewRunRecordV1, 'files'>,
  finding: Pick<ReviewFindingV1, 'fileKey'>
): string | null {
  return record.files.find(file => file.fileKey === finding.fileKey)?.path ?? null;
}

/** The typed draft text sent back to the Composer when the user picks a finding. */
export function findingComposerText(
  record: Pick<WebCodeReviewRunRecordV1, 'files'>,
  finding: ReviewFindingV1
): string {
  const path = resolveFindingPath(record, finding);
  const location = path ? `${path}:${finding.startLine}-${finding.endLine}` : finding.fileKey;
  return [
    `[审查问题 ${finding.priority}] ${finding.title}`,
    `位置：${location}（${finding.side === 'old' ? '基线侧' : '当前侧'}）`,
    `触发条件：${finding.trigger}`,
    `影响：${finding.impact}`,
    `证据：${finding.evidence}`,
    '请评估该问题并给出修复方案；先不要直接修改文件。',
  ].join('\n');
}

export type RunBannerTone = 'ok' | 'warn' | 'error' | 'info';

/** Honest state banners: only completed + complete coverage can look green. */
export function runStateBanner(record: WebCodeReviewRunRecordV1): {
  readonly tone: RunBannerTone;
  readonly text: string;
} {
  if (record.status === 'running' || record.status === 'queued') {
    return { tone: 'info', text: '审查进行中…' };
  }
  if (record.status === 'cancelled') {
    return { tone: 'warn', text: '审查已取消，没有结论。' };
  }
  if (record.status === 'failed') {
    return {
      tone: 'error',
      text: `审查未完成：${record.failure?.message ?? '未知失败'}`,
    };
  }
  const suffix = record.stale ? '（结果已过期：仓库在审查后发生了变化）' : '';
  if (record.result?.state === 'partial') {
    return { tone: 'warn', text: `审查部分完成，覆盖不完整${suffix}` };
  }
  if (record.result?.conclusion === 'findings') {
    return { tone: 'ok', text: `审查完成，发现 ${record.result.findings.length} 个问题${suffix}` };
  }
  if (record.result?.conclusion === 'no_findings') {
    return { tone: 'ok', text: `审查完成，未发现问题${suffix}` };
  }
  return { tone: 'warn', text: `审查完成但结论不确定${suffix}` };
}

/** Timestamp shown for a run; kept trivial for stable tests. */
export function runStartedLabel(record: Pick<WebCodeReviewRunRecordV1, 'startedAt'>): string {
  return new Date(record.startedAt).toLocaleTimeString();
}
