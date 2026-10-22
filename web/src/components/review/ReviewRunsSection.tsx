/**
 * v0.3.29 — the shared code-review run results section of the Review panel
 * (docs/plan/v0.3.29-plan.md S3). Starts Host-side review runs, polls their
 * receipts and renders findings with honest state banners. Findings anchor to
 * the existing diff view via the run's file index; sending a finding back to
 * the Composer produces a typed draft that the user still confirms.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ReviewFindingV1 } from '../../../../src/services/code-review/contract';
import type { WebCodeReviewRunRecordV1 } from '../../../../src/web/code-review-run-service';
import type { WebGitFileV1 } from '../../../../src/web/protocol';
import type { WorkbenchActions } from '../../useWorkbench';
import { Icon } from '../Icon';
import {
  PRIORITY_LABELS,
  findingComposerText,
  groupFindingsByPriority,
  priorityOrder,
  resolveFindingPath,
  runStateBanner,
} from './review-runs-view';

export function ReviewRunsSection({
  actions,
  changedFiles,
  onOpenFileDiff,
  onSendToComposer,
}: {
  readonly actions: Pick<WorkbenchActions, 'reviewRunStart' | 'reviewRuns' | 'reviewRunCancel'>;
  readonly changedFiles: readonly WebGitFileV1[];
  readonly onOpenFileDiff: (file: WebGitFileV1) => void;
  readonly onSendToComposer: (text: string) => void;
}) {
  const [runs, setRuns] = useState<readonly WebCodeReviewRunRecordV1[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const pollRef = useRef(0);

  const refresh = useCallback(async () => {
    const generation = pollRef.current + 1;
    pollRef.current = generation;
    try {
      const next = await actions.reviewRuns();
      if (generation !== pollRef.current) return;
      setRuns(next);
      setError('');
    } catch (caught) {
      if (generation !== pollRef.current) return;
      setError(caught instanceof Error ? caught.message : '读取审查历史失败。');
    }
  }, [actions]);

  useEffect(() => {
    void refresh();
    return () => {
      pollRef.current += 1;
    };
  }, [refresh]);

  // Poll while any run is in flight; static otherwise.
  const hasRunning = runs.some(run => run.status === 'running' || run.status === 'queued');
  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(() => void refresh(), 1_500);
    return () => clearInterval(timer);
  }, [hasRunning, refresh]);

  const start = async () => {
    setStarting(true);
    setError('');
    try {
      await actions.reviewRunStart();
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '启动审查失败。');
    } finally {
      setStarting(false);
    }
  };

  const cancel = async (runId: string) => {
    try {
      await actions.reviewRunCancel(runId);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '取消审查失败。');
    }
  };

  const anchorFinding = (record: WebCodeReviewRunRecordV1, finding: ReviewFindingV1): void => {
    const path = resolveFindingPath(record, finding);
    const file = path ? changedFiles.find(candidate => candidate.path === path) : undefined;
    if (file) {
      onOpenFileDiff(file);
      return;
    }
    // The file is no longer in the change list (stale receipt): still deliver
    // the typed draft so the user keeps the content.
    onSendToComposer(findingComposerText(record, finding));
  };

  return (
    <section className="review-runs" aria-label="代码审查结果">
      <div className="review-runs-header">
        <strong>代码审查</strong>
        <button
          type="button"
          className="secondary-button"
          disabled={starting || hasRunning}
          onClick={() => void start()}
        >
          {hasRunning ? '审查进行中…' : '审查当前工作区'}
        </button>
      </div>
      <p className="review-runs-hint">
        审查由 Host 使用当前配置的模型执行；Host 重启后审查历史不保留。
      </p>
      {error ? (
        <p className="resource-error" role="alert">
          {error}
        </p>
      ) : null}
      {runs.length === 0 && !error ? (
        <p className="resource-notice" role="status">
          还没有审查记录。
        </p>
      ) : null}
      {runs.map(record => (
        <ReviewRunCard
          key={record.runId}
          record={record}
          onCancel={() => void cancel(record.runId)}
          onAnchor={finding => anchorFinding(record, finding)}
          onSendToComposer={text => onSendToComposer(text)}
        />
      ))}
    </section>
  );
}

function ReviewRunCard({
  record,
  onCancel,
  onAnchor,
  onSendToComposer,
}: {
  readonly record: WebCodeReviewRunRecordV1;
  readonly onCancel: () => void;
  readonly onAnchor: (finding: ReviewFindingV1) => void;
  readonly onSendToComposer: (text: string) => void;
}) {
  const banner = runStateBanner(record);
  const running = record.status === 'running' || record.status === 'queued';
  const findings = record.result?.findings ?? [];
  const groups = groupFindingsByPriority(findings);
  const invalidCount = record.result?.invalidFindingCount ?? 0;
  return (
    <article className={`review-run banner-${banner.tone}`} data-run-id={record.runId}>
      <div className="review-run-head">
        <span className={`review-run-state tone-${banner.tone}`} role="status">
          {banner.tone === 'ok' ? (
            <Icon name="check" size={14} />
          ) : (
            <Icon name="warning" size={14} />
          )}
          {banner.text}
        </span>
        {running ? (
          <button type="button" className="icon-button" aria-label="取消审查" onClick={onCancel}>
            <Icon name="close" size={14} />
          </button>
        ) : null}
      </div>
      {findings.length > 0 ? (
        <div className="review-run-findings">
          {priorityOrder()
            .filter(priority => groups[priority].length > 0)
            .map(priority => (
              <div key={priority} className="review-run-priority">
                <strong>{PRIORITY_LABELS[priority]}</strong>
                {groups[priority].map(finding => {
                  const path = resolveFindingPath(record, finding);
                  return (
                    <div key={finding.findingId} className="review-run-finding">
                      <button
                        type="button"
                        className="review-finding-title"
                        title={path ? `在 diff 中定位 ${path}` : '该文件已不在变更列表中'}
                        onClick={() => onAnchor(finding)}
                      >
                        <Icon name="code" size={13} />
                        <span>
                          {finding.title}
                          {path ? `（${path}:${finding.startLine}）` : ''}
                        </span>
                      </button>
                      <p className="review-finding-detail">
                        触发：{finding.trigger} · 影响：{finding.impact}
                      </p>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => onSendToComposer(findingComposerText(record, finding))}
                      >
                        送回对话草稿
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
        </div>
      ) : null}
      {invalidCount > 0 ? (
        <p className="resource-notice" role="status">
          {invalidCount} 条模型输出未通过契约校验，已计数并剔除。
        </p>
      ) : null}
    </article>
  );
}
