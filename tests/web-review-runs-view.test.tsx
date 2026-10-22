/**
 * v0.3.29 — ReviewRunsSection presentation contract: pure grouping, banner
 * copy, composer drafts and SSR markup (no jsdom in this suite).
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ReviewFindingV1 } from '../src/services/code-review/contract';
import type { WebCodeReviewRunRecordV1 } from '../src/web/code-review-run-service';
import {
  PRIORITY_LABELS,
  findingComposerText,
  groupFindingsByPriority,
  resolveFindingPath,
  runStateBanner,
} from '../web/src/components/review/review-runs-view';
import { ReviewRunsSection } from '../web/src/components/review/ReviewRunsSection';
import type { WorkbenchActions } from '../web/src/useWorkbench';

function finding(overrides: Partial<ReviewFindingV1> = {}): ReviewFindingV1 {
  return {
    findingId: 'aaaa1111aaaa1111aaaa1111aaaa1111',
    priority: 'P1',
    title: 'Changed line breaks consumers',
    trigger: 'When a consumer matches the literal',
    impact: 'Parsers fail downstream.',
    fileKey: 'fk-1',
    side: 'new',
    startLine: 2,
    endLine: 2,
    evidence: 'The literal changed.',
    ...overrides,
  };
}

function record(overrides: Record<string, unknown> = {}): WebCodeReviewRunRecordV1 {
  return {
    runId: '1b2b3c4d-0000-4000-8000-000000000000',
    selector: { kind: 'worktree' },
    status: 'completed',
    startedAt: 0,
    endedAt: 1,
    repositoryRevisionAtAdmission: 'rev-1',
    files: [{ fileKey: 'fk-1', path: 'src/a.ts' }],
    result: null,
    failure: null,
    stale: false,
    ...overrides,
  } as WebCodeReviewRunRecordV1;
}

describe('groupFindingsByPriority', () => {
  it('groups P0→P3 and preserves receipt order inside a group', () => {
    const groups = groupFindingsByPriority([
      finding({ findingId: 'b'.repeat(32), priority: 'P2' }),
      finding({ findingId: 'c'.repeat(32), priority: 'P0' }),
      finding({ findingId: 'd'.repeat(32), priority: 'P0' }),
    ]);
    expect(groups.P0.map(item => item.findingId)).toEqual(['c'.repeat(32), 'd'.repeat(32)]);
    expect(groups.P1).toEqual([]);
    expect(groups.P2.map(item => item.findingId)).toEqual(['b'.repeat(32)]);
    expect(groups.P3).toEqual([]);
  });

  it('exposes the frozen priority labels', () => {
    expect(PRIORITY_LABELS.P0).toBe('P0 阻断');
    expect(PRIORITY_LABELS.P3).toBe('P3 提示');
  });
});

describe('resolveFindingPath / findingComposerText', () => {
  it('resolves the file path via the run file index', () => {
    expect(
      resolveFindingPath({ files: [{ fileKey: 'fk-1', path: 'src/a.ts' }] }, { fileKey: 'fk-1' })
    ).toBe('src/a.ts');
    expect(resolveFindingPath({ files: [] }, { fileKey: 'fk-1' })).toBeNull();
  });

  it('builds a typed composer draft with location, trigger, impact and evidence', () => {
    const text = findingComposerText({ files: [{ fileKey: 'fk-1', path: 'src/a.ts' }] }, finding());
    expect(text).toContain('[审查问题 P1] Changed line breaks consumers');
    expect(text).toContain('位置：src/a.ts:2-2（当前侧）');
    expect(text).toContain('触发条件：When a consumer matches the literal');
    expect(text).toContain('影响：Parsers fail downstream.');
    expect(text).toContain('证据：The literal changed.');
    expect(text.endsWith('请评估该问题并给出修复方案；先不要直接修改文件。')).toBe(true);
  });

  it('falls back to the file key when the file left the change list', () => {
    const text = findingComposerText({ files: [] }, finding());
    expect(text).toContain('位置：fk-1');
  });
});

describe('runStateBanner', () => {
  it('never renders running, cancelled, failed or partial as a green pass', () => {
    expect(runStateBanner(record({ status: 'running' }))).toEqual({
      tone: 'info',
      text: '审查进行中…',
    });
    expect(runStateBanner(record({ status: 'cancelled' })).tone).toBe('warn');
    expect(
      runStateBanner(
        record({ status: 'failed', failure: { kind: 'model_error', message: 'boom' } })
      ).tone
    ).toBe('error');
    const partial = record({
      result: {
        state: 'partial',
        conclusion: 'findings',
        findings: [finding()],
        invalidFindingCount: 0,
      } as unknown as WebCodeReviewRunRecordV1['result'],
    });
    expect(runStateBanner(partial).tone).toBe('warn');
  });

  it('marks stale receipts explicitly instead of presenting them as current', () => {
    const stale = record({
      stale: true,
      result: {
        state: 'completed',
        conclusion: 'findings',
        findings: [finding()],
        invalidFindingCount: 0,
      } as unknown as WebCodeReviewRunRecordV1['result'],
    });
    const banner = runStateBanner(stale);
    expect(banner.tone).toBe('ok');
    expect(banner.text).toContain('结果已过期');
  });

  it('reports a clean pass only for completed no_findings', () => {
    const clean = record({
      result: {
        state: 'completed',
        conclusion: 'no_findings',
        findings: [],
        invalidFindingCount: 0,
      } as unknown as WebCodeReviewRunRecordV1['result'],
    });
    expect(runStateBanner(clean)).toEqual({ tone: 'ok', text: '审查完成，未发现问题' });
  });
});

describe('ReviewRunsSection markup (SSR)', () => {
  it('renders the empty state and the host-restart history notice', () => {
    const actions = {
      reviewRunStart: () => Promise.resolve({ runId: 'x', status: 'running' as const }),
      reviewRuns: () => Promise.resolve([]),
      reviewRunCancel: () => Promise.resolve(),
    } as unknown as Pick<WorkbenchActions, 'reviewRunStart' | 'reviewRuns' | 'reviewRunCancel'>;
    const html = renderToStaticMarkup(
      React.createElement(ReviewRunsSection, {
        actions,
        changedFiles: [],
        onOpenFileDiff: () => undefined,
        onSendToComposer: () => undefined,
      })
    );
    expect(html).toContain('代码审查');
    expect(html).toContain('还没有审查记录');
    expect(html).toContain('Host 重启后审查历史不保留');
  });
});
