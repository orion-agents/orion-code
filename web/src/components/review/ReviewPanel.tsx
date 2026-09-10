import { useEffect, useRef, useState } from 'react';

import { WebApiError } from '../../api';
import type { WebGitDiffPageV1, WebGitFileV1, WebReviewSnapshotV1 } from '../../types';
import type { WorkbenchActions } from '../../useWorkbench';
import { ResourceSplitLayout } from '../../layout/ResourceSplitLayout';
import { Icon } from '../Icon';
import { useAutoNotice } from '../useAutoNotice';
import { DiffViewer } from '../git/DiffViewer';

export function ReviewPanel({
  workspaceId,
  refreshEpoch,
  actions,
  onSendToComposer,
  navigatorWidthPx,
  onNavigatorWidthCommit,
}: {
  readonly workspaceId: string;
  readonly refreshEpoch: number;
  readonly actions: WorkbenchActions;
  readonly onSendToComposer: (text: string) => void;
  /** v0.3.13 — per-workspace + per-panel navigator (review list) column width. */
  readonly navigatorWidthPx: number;
  /** v0.3.13 — persists one workspace/panel width on pointer-up / keyboard commit. */
  readonly onNavigatorWidthCommit: (width: number) => void;
}) {
  const [snapshot, setSnapshot] = useState<WebReviewSnapshotV1 | null>(null);
  const [selected, setSelected] = useState<WebGitFileV1 | null>(null);
  const [diff, setDiff] = useState<WebGitDiffPageV1 | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // v0.3.15 T1 — recovery notices fade out on their own; real errors persist
  // in `.resource-error` below.
  const { notice: resourceNotice, showNotice: setResourceNotice, clearNotice: clearResourceNotice } =
    useAutoNotice();
  const generationRef = useRef(0);
  const diffRequestRef = useRef(0);

  const refresh = async (generation = generationRef.current, restoreFileId?: string) => {
    if (generation !== generationRef.current) return;
    setLoading(true);
    setError('');
    try {
      const next = await actions.review();
      if (generation !== generationRef.current) return;
      setSnapshot(next);
      // Keep the inspected file across refreshes (manual, epoch and conflict
      // recovery) instead of dropping the user back to the empty state.
      const restored = restoreFileId
        ? (next.changedFiles.find(file => file.fileId === restoreFileId) ?? null)
        : null;
      setSelected(restored);
      setDiff(null);
      if (restored) void openDiff(restored, undefined, generation);
    } catch (caught) {
      if (generation !== generationRef.current) return;
      setError(message(caught));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  };

  const reload = () => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    diffRequestRef.current += 1;
    clearResourceNotice();
    void refresh(generation, selected?.fileId);
  };

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    diffRequestRef.current += 1;
    setSnapshot(null);
    setSelected(null);
    setDiff(null);
    setError('');
    clearResourceNotice();
    if (workspaceId) void refresh(generation);
  }, [refreshEpoch, workspaceId]);

  const openDiff = async (
    file: WebGitFileV1,
    cursor?: string,
    generation = generationRef.current,
    request = diffRequestRef.current + 1
  ) => {
    if (generation !== generationRef.current) return;
    diffRequestRef.current = request;
    if (!cursor) {
      setSelected(file);
      setDiff(null);
    }
    setLoading(true);
    setError('');
    try {
      const page = await actions.gitDiff(file.fileId, cursor);
      if (generation !== generationRef.current || request !== diffRequestRef.current) return;
      if (page.fileId !== file.fileId) return;
      setSelected(file);
      setDiff(current =>
        cursor && current && current.fileId === page.fileId
          ? { ...page, lines: [...current.lines, ...page.lines] }
          : page
      );
    } catch (caught) {
      if (generation !== generationRef.current || request !== diffRequestRef.current) return;
      if (isRevisionConflict(caught)) {
        setResourceNotice('仓库已变化，已重新建立审阅快照。');
        await refresh(generation, file.fileId);
        return;
      }
      setError(message(caught));
    } finally {
      if (generation === generationRef.current && request === diffRequestRef.current) {
        setLoading(false);
      }
    }
  };

  if (!snapshot && !error) return <p className="resource-loading">正在建立审阅快照…</p>;
  if (!snapshot) {
    return (
      <div className="resource-empty" role="alert">
        <Icon name="warning" />
        <strong>无法读取审阅快照</strong>
        <p>{error}</p>
        <button type="button" className="secondary-button" onClick={reload}>
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="work-resource-panel review-panel">
      <div className="review-summary">
        <div>
          <span className={`review-score ${snapshot.clean ? 'clean' : 'changed'}`}>
            {snapshot.clean ? <Icon name="check" size={16} /> : <Icon name="edit" size={16} />}
          </span>
          <div>
            <strong>{reviewSummary(snapshot).headline}</strong>
            <span>{reviewSummary(snapshot).counters}</span>
          </div>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="刷新审阅快照"
          aria-busy={loading}
          disabled={loading}
          onClick={reload}
        >
          <Icon name="refresh" size={16} />
        </button>
      </div>
      {snapshot.truncated ? (
        <p className="resource-notice" role="status">
          当前显示 {snapshot.changedFiles.length} / {snapshot.totalChangedFiles}{' '}
          个变更文件；分类计数仅覆盖当前显示范围。
        </p>
      ) : null}
      {resourceNotice ? (
        <p className="resource-notice" role="status">
          {resourceNotice.text}
        </p>
      ) : null}
      {error ? (
        <p className="resource-error" role="alert">
          {error}
        </p>
      ) : null}
      <ResourceSplitLayout
        panelId="review"
        navigatorWidthPx={navigatorWidthPx}
        onNavigatorWidthCommit={onNavigatorWidthCommit}
        contentLabel="审阅 Diff"
        navigatorLabel="待审阅文件"
        handleLabel="调整待审阅文件列表宽度"
        contentClassName="review-diff"
        navigatorClassName="review-files"
      >
        <>
          {snapshot.changedFiles.map(file => (
            <button
              type="button"
              key={file.fileId}
              className={selected?.fileId === file.fileId ? 'selected' : ''}
              onClick={() => void openDiff(file)}
            >
              <Icon name="code" size={14} />
              <span title={file.path}>{file.path}</span>
              <small>{`${file.indexStatus}${file.worktreeStatus}`.trim() || '?'}</small>
            </button>
          ))}
        </>
        <>
          {diff ? (
            <DiffViewer
              page={diff}
              loading={loading}
              onLoadMore={
                diff.nextCursor && selected
                  ? () => void openDiff(selected, diff.nextCursor ?? undefined)
                  : undefined
              }
              onSendToComposer={onSendToComposer}
            />
          ) : (
            <div className="resource-empty">
              <Icon name="edit" size={16} />
              <strong>选择文件开始审阅</strong>
              <p title="你可以把某个 Hunk 作为草稿送回对话，提交前仍由你确认。">选中 Hunk 可送回对话。</p>
            </div>
          )}
        </>
      </ResourceSplitLayout>
    </div>
  );
}

/**
 * v0.3.14 — review summary copy. Pure so the localised counters can be unit
 * tested without rendering the panel.
 */
export function reviewSummary(snapshot: {
  readonly clean: boolean;
  readonly totalChangedFiles: number;
  readonly stagedCount: number;
  readonly unstagedCount: number;
  readonly untrackedCount: number;
  readonly conflictCount: number;
  readonly truncated: boolean;
}): { readonly headline: string; readonly counters: string } {
  const counters = [
    `${snapshot.stagedCount} 已暂存`,
    `${snapshot.unstagedCount} 未暂存`,
    `${snapshot.untrackedCount} 未跟踪`,
    `${snapshot.conflictCount} 冲突`,
  ].join(' · ');
  return Object.freeze({
    headline: snapshot.clean ? '没有待审阅变更' : `${snapshot.totalChangedFiles} 个变更文件`,
    counters: `${snapshot.truncated ? '当前显示 · ' : ''}${counters}`,
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : '审阅请求失败。';
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof WebApiError && error.code === 'git_revision_conflict';
}
