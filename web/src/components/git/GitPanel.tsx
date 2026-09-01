import { useEffect, useRef, useState } from 'react';

import { WebApiError } from '../../api';
import type { WebGitDiffPageV1, WebGitFileV1, WebGitLogPageV1, WebGitStatusV1 } from '../../types';
import type { WorkbenchActions } from '../../useWorkbench';
import { Icon } from '../Icon';
import { DiffViewer } from './DiffViewer';

export function GitPanel({
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
  const [status, setStatus] = useState<WebGitStatusV1 | null>(null);
  const [log, setLog] = useState<WebGitLogPageV1 | null>(null);
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
      const [nextStatus, nextLog] = await Promise.all([actions.gitStatus(), actions.gitLog()]);
      if (generation !== generationRef.current) return;
      setStatus(nextStatus);
      setLog(nextLog);
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
    setStatus(null);
    setLog(null);
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
        setResourceNotice('仓库已变化，已重新载入 Git 状态。');
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

  const loadMoreStatus = async () => {
    const cursor = status?.nextCursor;
    if (!cursor || !status) return;
    const generation = generationRef.current;
    const revision = status.repositoryRevision;
    setLoading(true);
    setError('');
    try {
      const page = await actions.gitStatus(cursor);
      if (generation !== generationRef.current) return;
      if (page.repositoryRevision !== revision) throw revisionConflict();
      setStatus(current =>
        !current || current.repositoryRevision !== revision
          ? current
          : {
              ...page,
              conflicted: mergeFiles(current.conflicted, page.conflicted),
              staged: mergeFiles(current.staged, page.staged),
              unstaged: mergeFiles(current.unstaged, page.unstaged),
              untracked: mergeFiles(current.untracked, page.untracked),
            }
      );
    } catch (caught) {
      if (generation !== generationRef.current) return;
      if (isRevisionConflict(caught)) {
        setResourceNotice('仓库已变化，已重新载入 Git 状态。');
        await refresh(generation);
        return;
      }
      setError(message(caught));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  };

  const loadMoreLog = async () => {
    const cursor = log?.nextCursor;
    if (!cursor || !log) return;
    const generation = generationRef.current;
    const revision = log.repositoryRevision;
    setLoading(true);
    setError('');
    try {
      const page = await actions.gitLog(cursor);
      if (generation !== generationRef.current) return;
      if (page.repositoryRevision !== revision) throw revisionConflict();
      setLog(current =>
        !current || current.repositoryRevision !== revision
          ? current
          : { ...page, items: mergeCommits(current.items, page.items) }
      );
    } catch (caught) {
      if (generation !== generationRef.current) return;
      if (isRevisionConflict(caught)) {
        setResourceNotice('提交历史已变化，已重新载入第一页。');
        await refresh(generation);
        return;
      }
      setError(message(caught));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  };

  if (error && !status) {
    return <ResourceFailure message={error} onRetry={reload} />;
  }
  if (!status) return <p className="resource-loading">正在读取 Git 状态…</p>;
  if (!status.isRepository) {
    return (
      <div className="resource-empty">
        <Icon name="branch" />
        <strong>当前项目不是 Git 仓库</strong>
        <p>文件和 Agent 仍可使用；Git 面板保持只读空状态。</p>
      </div>
    );
  }

  const groups: ReadonlyArray<{
    label: string;
    tone: string;
    items: readonly WebGitFileV1[];
  }> = [
    { label: '冲突', tone: 'conflict', items: status.conflicted },
    { label: '已暂存', tone: 'staged', items: status.staged },
    { label: '未暂存', tone: 'unstaged', items: status.unstaged },
    { label: '未跟踪', tone: 'untracked', items: status.untracked },
  ];

  return (
    <div className="work-resource-panel git-panel">
      <div className="git-summary">
        <div>
          <Icon name="branch" size={15} />
          <strong>
            {status.detached ? `detached ${status.head ?? ''}` : status.branch || 'HEAD'}
          </strong>
        </div>
        <span>
          {status.upstream || '无 upstream'}
          {status.ahead || status.behind ? ` · ↑${status.ahead} ↓${status.behind}` : ''}
        </span>
        <button
          type="button"
          className="icon-button"
          aria-label="刷新 Git 状态"
          onClick={reload}
          disabled={loading}
        >
          <Icon name="refresh" size={15} />
        </button>
      </div>
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
      <div className="git-layout">
        <section className="git-changes" aria-label="Git 变更">
          {status.clean ? (
            <div className="resource-empty compact">
              <Icon name="check" />
              <strong>工作区干净</strong>
            </div>
          ) : (
            groups.map(group =>
              group.items.length ? (
                <div className="git-group" key={group.label}>
                  <h3>
                    {group.label} <span>{group.items.length}</span>
                  </h3>
                  {group.items.map(file => (
                    <button
                      type="button"
                      key={`${group.label}:${file.fileId}`}
                      className={selected?.fileId === file.fileId ? 'selected' : ''}
                      onClick={() => void openDiff(file)}
                    >
                      <span className={`git-status-code ${group.tone}`}>
                        {file.indexStatus.trim() || file.worktreeStatus.trim() || '?'}
                      </span>
                      <span title={file.path}>{file.path}</span>
                    </button>
                  ))}
                </div>
              ) : null
            )
          )}
          {status.nextCursor ? (
            <button
              type="button"
              className="text-button resource-load-more"
              onClick={() => void loadMoreStatus()}
              disabled={loading}
            >
              加载更多变更
            </button>
          ) : null}
          <div className="git-history">
            <h3>提交历史</h3>
            {log?.items.map(commit => (
              <article key={commit.id}>
                <code>{commit.shortId}</code>
                <strong>{commit.subject}</strong>
                <span>
                  {commit.authorName} · {new Date(commit.authoredAt).toLocaleDateString('zh-CN')}
                </span>
              </article>
            ))}
            {log?.nextCursor ? (
              <button
                type="button"
                className="text-button resource-load-more"
                onClick={() => void loadMoreLog()}
                disabled={loading}
              >
                加载更多提交
              </button>
            ) : null}
          </div>
        </section>
        <section className="git-diff" aria-label="Git Diff">
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
              <Icon name="code" />
              <strong>选择变更查看 Diff</strong>
              <p>Diff 来自受限 Git read model，不解析对话或工具输出。</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function ResourceFailure({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}) {
  return (
    <div className="resource-empty" role="alert">
      <Icon name="warning" />
      <strong>Git 状态读取失败</strong>
      <p>{message}</p>
      <button type="button" className="secondary-button" onClick={onRetry}>
        重试
      </button>
    </div>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Git 请求失败。';
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof WebApiError && error.code === 'git_revision_conflict';
}

function revisionConflict(): WebApiError {
  return new WebApiError('仓库版本已变化。', 409, 'git_revision_conflict');
}

function mergeFiles(
  current: readonly WebGitFileV1[],
  next: readonly WebGitFileV1[]
): readonly WebGitFileV1[] {
  const byId = new Map(current.map(item => [item.fileId, item]));
  for (const item of next) byId.set(item.fileId, item);
  return [...byId.values()];
}

function mergeCommits(
  current: readonly WebGitLogPageV1['items'][number][],
  next: readonly WebGitLogPageV1['items'][number][]
): readonly WebGitLogPageV1['items'][number][] {
  const byId = new Map(current.map(item => [item.id, item]));
  for (const item of next) byId.set(item.id, item);
  return [...byId.values()];
}
