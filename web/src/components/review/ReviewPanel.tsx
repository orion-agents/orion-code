import { useEffect, useRef, useState } from 'react';

import { WebApiError } from '../../api';
import type { WebGitDiffPageV1, WebGitFileV1, WebReviewSnapshotV1 } from '../../types';
import type { WorkbenchActions } from '../../useWorkbench';
import { Icon } from '../Icon';
import { DiffViewer } from '../git/DiffViewer';

export function ReviewPanel({
  workspaceId,
  refreshEpoch,
  actions,
  onSendToComposer,
}: {
  readonly workspaceId: string;
  readonly refreshEpoch: number;
  readonly actions: WorkbenchActions;
  readonly onSendToComposer: (text: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<WebReviewSnapshotV1 | null>(null);
  const [selected, setSelected] = useState<WebGitFileV1 | null>(null);
  const [diff, setDiff] = useState<WebGitDiffPageV1 | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [resourceNotice, setResourceNotice] = useState('');
  const generationRef = useRef(0);
  const diffRequestRef = useRef(0);

  const refresh = async (generation = generationRef.current) => {
    if (generation !== generationRef.current) return;
    setLoading(true);
    setError('');
    try {
      const next = await actions.review();
      if (generation !== generationRef.current) return;
      setSnapshot(next);
      setSelected(null);
      setDiff(null);
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
    setResourceNotice('');
    void refresh(generation);
  };

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    diffRequestRef.current += 1;
    setSnapshot(null);
    setSelected(null);
    setDiff(null);
    setError('');
    setResourceNotice('');
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
        await refresh(generation);
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
            {snapshot.clean ? <Icon name="check" /> : <Icon name="edit" />}
          </span>
          <div>
            <strong>
              {snapshot.clean ? '没有待审阅变更' : `${snapshot.totalChangedFiles} 个变更文件`}
            </strong>
            <span>
              {snapshot.truncated ? '当前显示 · ' : ''}
              {snapshot.stagedCount} staged · {snapshot.unstagedCount} unstaged ·{' '}
              {snapshot.untrackedCount} untracked · {snapshot.conflictCount} conflict
            </span>
          </div>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="刷新审阅快照"
          disabled={loading}
          onClick={reload}
        >
          <Icon name="refresh" size={15} />
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
          {resourceNotice}
        </p>
      ) : null}
      {error ? (
        <p className="resource-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="review-layout">
        <section className="review-files" aria-label="待审阅文件">
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
          <div className="review-verification">
            <h3>验证证据</h3>
            {snapshot.verification.length ? (
              snapshot.verification.map(item => (
                <article key={`${item.callId}:${item.toolName}`}>
                  <span className={`state-dot state-${item.state}`} aria-hidden="true" />
                  <div>
                    <strong>{item.toolName}</strong>
                    <small>
                      {item.state} · {item.outputBytes} B{item.hasArtifact ? ' · artifact' : ''}
                    </small>
                  </div>
                </article>
              ))
            ) : (
              <p className="muted-copy">当前没有持久化验证结果。</p>
            )}
          </div>
        </section>
        <section className="review-diff" aria-label="审阅 Diff">
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
              <Icon name="edit" />
              <strong>选择文件开始审阅</strong>
              <p>你可以把某个 Hunk 作为草稿送回对话，提交前仍由你确认。</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : '审阅请求失败。';
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof WebApiError && error.code === 'git_revision_conflict';
}
