/**
 * v0.3.17 S4 — history view.
 *
 * Lists commits, opens one commit's details and file list, and renders the diff that commit
 * introduced to one of its files. Nothing here can write: the panel offers no stage, commit or
 * checkout control in this view, and every action it calls is a read.
 */
import { useMemo, useState } from 'react';

import type { GitHistoryModel } from '../../state/useGitHistory';
import type { WorkbenchActions } from '../../useWorkbench';
import type { GitDiffMode } from '../../state/git-panel-state';
import { Icon } from '../Icon';
import { StructuredDiffViewer } from './StructuredDiffViewer';

export function GitHistoryView({
  history,
  actions,
  display,
  collapsedHunks,
  anchorLineId,
  onDisplayChange,
  onToggleHunk,
  onSetAllFolded,
  onAnchorChange,
  onNotice,
  onSendToComposer,
}: {
  readonly history: GitHistoryModel;
  readonly actions: WorkbenchActions;
  readonly display: { readonly mode: GitDiffMode; readonly wrap: boolean; readonly showWhitespace: boolean };
  readonly collapsedHunks: readonly string[];
  readonly anchorLineId: string | null;
  readonly onDisplayChange: (
    patch: Partial<{ readonly mode: GitDiffMode; readonly wrap: boolean; readonly showWhitespace: boolean }>
  ) => void;
  readonly onToggleHunk: (hunkId: string) => void;
  readonly onSetAllFolded: (folded: boolean) => void;
  readonly onAnchorChange: (lineId: string | null) => void;
  readonly onNotice: (text: string) => void;
  readonly onSendToComposer: (text: string) => void;
}) {
  const { page, detail, files, diff, fileHistory, error } = history;
  // v0.3.17 S5 — blame for one file at the selected commit.
  const [blame, setBlame] = useState<{
    readonly path: string;
    readonly rev: string;
    readonly lines: readonly { readonly lineNumber: number; readonly commitShort: string; readonly author: string; readonly authoredAt: string; readonly summary: string; readonly isBoundary: boolean }[];
    readonly truncated: boolean;
  } | null>(null);
  const [blameBusy, setBlameBusy] = useState(false);
  // v0.3.17 S5 — read a file at a revision, including one no longer in the worktree.
  // v0.3.17 S5 — the commit graph, drawn by git itself.
  const [graph, setGraph] = useState<{
    readonly rows: readonly { readonly graph: string; readonly id: string | null; readonly shortId: string | null; readonly subject: string }[];
    readonly truncated: boolean;
  } | null>(null);
  const [graphBusy, setGraphBusy] = useState(false);
  const [blobResult, setBlobResult] = useState<{
    readonly path: string;
    readonly rev: string;
    readonly lines: readonly string[];
    readonly binary: boolean;
    readonly truncated: boolean;
    readonly byteSize: number;
    readonly dataUrl: string | null;
  } | null>(null);

  const mergedCount = useMemo(
    () => (page?.items ?? []).filter(item => item.isMerge).length,
    [page]
  );

  if (history.isEmptyRepository) {
    return (
      <div className="resource-empty">
        <Icon name="branch" size={16} />
        <strong>尚无提交</strong>
        <p>这个仓库还没有提交。新文件仍可暂存并完成首次提交。</p>
      </div>
    );
  }

  return (
    <div className="git-history" aria-label="Git 历史">
      <div className="git-history-search">
        <input
          type="search"
          aria-label="搜索提交消息"
          placeholder="搜索提交消息…"
          value={history.query.message}
          onChange={event => history.setQuery({ message: event.target.value })}
        />
        <input
          type="search"
          aria-label="按作者筛选"
          placeholder="作者"
          value={history.query.author}
          onChange={event => history.setQuery({ author: event.target.value })}
        />
        <input
          type="search"
          aria-label="按文件路径筛选"
          placeholder="文件路径"
          value={history.query.path}
          onChange={event => history.setQuery({ path: event.target.value })}
        />
        <input
          type="search"
          aria-label="按提交哈希查找"
          placeholder="提交哈希"
          value={history.query.sha}
          onChange={event => history.setQuery({ sha: event.target.value })}
        />
        <div className="git-history-dates">
          <input
            type="search"
            aria-label="起始日期"
            placeholder="自 (2026-01-01)"
            value={history.query.since}
            onChange={event => history.setQuery({ since: event.target.value })}
          />
          <input
            type="search"
            aria-label="结束日期"
            placeholder="至"
            value={history.query.until}
            onChange={event => history.setQuery({ until: event.target.value })}
          />
        </div>
        <div className="git-history-search-actions">
          <span role="status">
            {page
              ? `已载 ${page.items.length}${page.truncated ? '+' : ''} 个提交${
                  mergedCount > 0 ? ` · 含 ${mergedCount} 个合并` : ''
                }`
              : '读取中…'}
            {history.refs?.detached ? ' · detached HEAD' : ''}
          </span>
          <button
            type="button"
            className={`text-button ${graph ? 'diff-toggle-on' : ''}`}
            aria-pressed={graph !== null}
            onClick={() => {
              if (graph) {
                setGraph(null);
                return;
              }
              setGraphBusy(true);
              void actions
                .gitGraph()
                .then(setGraph)
                .finally(() => setGraphBusy(false));
            }}
          >
            拓扑
          </button>
          <button type="button" className="text-button" onClick={history.resetQuery}>
            清除筛选
          </button>
        </div>
      </div>

      {error ? (
        <p className="resource-error" role="alert">
          {error}
        </p>
      ) : null}

      {fileHistory ? (
        <section className="git-file-history" aria-label="文件历史">
          <header>
            <strong>文件历史 · {fileHistory.path}</strong>
            <button type="button" className="text-button" onClick={history.closeFileHistory}>
              返回提交列表
            </button>
          </header>
          {/* `--follow` has real limits for copies and complex merges; say so instead of
              implying the tracking is complete (plan G6). */}
          <p className="git-file-history-note">
            跟随重命名；复制与复杂合并场景的追踪可能不完整。
          </p>
          <ul>
            {fileHistory.items.map(commit => (
              <li key={commit.id}>
                <button
                  type="button"
                  onClick={() => {
                    history.closeFileHistory();
                    history.selectCommit(commit);
                  }}
                >
                  <code>{commit.shortId}</code>
                  <span>{commit.subject}</span>
                  <time dateTime={commit.authoredAt}>{formatDate(commit.authoredAt)}</time>
                </button>
              </li>
            ))}
          </ul>
          {fileHistory.truncated ? (
            <p className="git-file-history-note">结果已截断，仅显示最近的提交。</p>
          ) : null}
        </section>
      ) : null}

      {detail ? (
        <section className="git-commit-detail" aria-label="提交详情">
          <header>
            <div>
              <code>{detail.shortId}</code>
              {detail.isMerge ? (
                <span className="git-merge-badge">
                  合并提交 · {detail.parents.length} 个父提交
                </span>
              ) : detail.parents.length === 0 ? (
                <span className="git-root-badge">根提交</span>
              ) : null}
            </div>
            <button type="button" className="text-button" onClick={history.closeDetail}>
              关闭详情
            </button>
          </header>

          <p className="git-commit-subject">{detail.subject}</p>
          {detail.message.trim() !== detail.subject.trim() ? (
            <pre className="git-commit-message">{detail.message.trim()}</pre>
          ) : null}
          <p className="git-commit-meta">
            {detail.authorName} &lt;{detail.authorEmail}&gt; · {formatDate(detail.authoredAt)}
            {detail.committerName && detail.committerName !== detail.authorName
              ? ` · 提交者 ${detail.committerName}`
              : ''}
          </p>
          {/* The comparison is stated, never implied: plan G4 requires the real base. */}
          <p className="git-commit-base">
            比较基准：{detail.baseLabel} <code>{detail.baseOid.slice(0, 10)}</code>
          </p>
          {detail.isMerge ? (
            <div className="git-parent-picker" role="group" aria-label="选择父提交">
              {detail.parents.map((parent, index) => (
                <button
                  type="button"
                  key={parent}
                  aria-pressed={detail.parentIndex === index}
                  className={detail.parentIndex === index ? 'selected' : ''}
                  onClick={() => history.setParentIndex(index)}
                >
                  父 {index + 1} <code>{parent.slice(0, 8)}</code>
                </button>
              ))}
            </div>
          ) : null}

          {files ? (
            <>
              <p className="git-commit-stats-line">
                {files.files.length} 个文件 ·<em className="diff-stat-add"> +{files.additions}</em>
                <em className="diff-stat-del"> -{files.deletions}</em>
                {files.truncated ? ' · 已截断' : ''}
              </p>
              <ul className="git-commit-file-list">
                {files.files.map(file => (
                  <li key={file.path}>
                    <button
                      type="button"
                      className={detail && history.diff?.path === file.path ? 'selected' : ''}
                      aria-current={history.diff?.path === file.path ? 'true' : undefined}
                      onClick={() => history.selectFile(file.path)}
                    >
                      <span className="git-commit-file-stats">
                        {file.binary ? 'bin' : `+${file.additions} -${file.deletions}`}
                      </span>
                      <span title={file.path}>
                        {file.renamedFrom ? `${file.renamedFrom} → ${file.path}` : file.path}
                      </span>
                      {file.sensitive ? <em className="git-sensitive-badge">受保护</em> : null}
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      aria-label={`查看 ${file.path} 的文件历史`}
                      onClick={() => history.openFileHistory(file.path)}
                    >
                      历史
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      aria-label={`查看 ${file.path} 在该提交的版本`}
                      onClick={() => {
                        if (!detail) return;
                        void actions
                          .gitBlob({ path: file.path, rev: detail.id })
                          .then(result =>
                            setBlobResult({
                              path: result.path,
                              rev: result.rev,
                              lines: result.content,
                              binary: result.binary,
                              truncated: result.truncated,
                              byteSize: result.byteSize,
                              dataUrl: result.dataUrl,
                            })
                          )
                          .catch(() => setBlobResult(null));
                      }}
                    >
                      该版本
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      aria-label={`查看 ${file.path} 的 Blame`}
                      onClick={() => {
                        if (!detail) return;
                        setBlameBusy(true);
                        void actions
                          .gitBlame({ path: file.path, rev: detail.id })
                          .then(result => setBlame({ ...result, rev: detail.id }))
                          .catch(() => setBlame(null))
                          .finally(() => setBlameBusy(false));
                      }}
                    >
                      Blame
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="resource-loading">正在读取该提交的改动…</p>
          )}
        </section>
      ) : null}

      {diff ? (
        <StructuredDiffViewer
          document={diff}
          mode={display.mode}
          wrap={display.wrap}
          showWhitespace={display.showWhitespace}
          collapsedHunks={collapsedHunks}
          anchorLineId={anchorLineId}
          loading={history.loadingDetail}
          onChangeMode={mode => onDisplayChange({ mode })}
          onToggleWrap={() => onDisplayChange({ wrap: !display.wrap })}
          onToggleWhitespace={() => onDisplayChange({ showWhitespace: !display.showWhitespace })}
          onToggleHunk={onToggleHunk}
          onSetAllFolded={onSetAllFolded}
          onAnchorChange={onAnchorChange}
          onNotice={onNotice}
          onSendToComposer={onSendToComposer}
        />
      ) : null}

      {graphBusy ? <p className="git-file-history-note">正在读取拓扑…</p> : null}
      {graph ? (
        <section className="git-graph" aria-label="提交拓扑">
          <header>
            <strong>拓扑（{graph.rows.length}{graph.truncated ? '+' : ''} 行）</strong>
            <button type="button" className="text-button" onClick={() => setGraph(null)}>
              关闭
            </button>
          </header>
          <p className="git-file-history-note">图形列由 git 直接绘制，不由前端重算。</p>
          <div className="git-graph-body">
            {graph.rows.map((row, index) => (
              <button
                type="button"
                key={`${row.id ?? 'graph'}:${index}`}
                className={row.id && detail?.id === row.id ? 'selected' : ''}
                disabled={!row.id}
                onClick={() => {
                  if (!row.id) return;
                  setGraph(null);
                  history.selectCommit({ id: row.id });
                }}
              >
                <code>{row.graph}</code>
                <span>{row.id ? row.subject : ''}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {blobResult ? (
        <section className="git-blob" aria-label="该版本内容">
          <header>
            <strong>
              {blobResult.path} @ {blobResult.rev.slice(0, 10)}
            </strong>
            <button type="button" className="text-button" onClick={() => setBlobResult(null)}>
              关闭
            </button>
          </header>
          {blobResult.truncated ? (
            <p className="git-file-history-note">
              文件超过上限（{blobResult.byteSize} 字节），未读取内容。
            </p>
          ) : blobResult.dataUrl ? (
            <img
              src={blobResult.dataUrl}
              alt={`${blobResult.path} 在该提交的图像版本`}
              className="git-blob-image"
            />
          ) : blobResult.binary ? (
            <p className="git-file-history-note">
              二进制内容（{blobResult.byteSize} 字节），不在此处渲染。
            </p>
          ) : (
            <pre className="git-blob-content">{blobResult.lines.join('\n')}</pre>
          )}
        </section>
      ) : null}

      {blame ? (
        <section className="git-blame" aria-label="Blame">
          <header>
            <strong>Blame · {blame.path}</strong>
            <button type="button" className="text-button" onClick={() => setBlame(null)}>
              关闭
            </button>
          </header>
          {blameBusy ? <p className="git-file-history-note">读取中…</p> : null}
          <div className="git-blame-table">
            {blame.lines.map(line => (
              <div key={line.lineNumber} className="git-blame-row">
                <code>{line.commitShort}</code>
                <span className="git-blame-author" title={line.summary}>
                  {line.author}
                </span>
                <time>{line.authoredAt.slice(0, 10)}</time>
                <span className="git-blame-summary" title={line.summary}>
                  {line.summary}
                </span>
              </div>
            ))}
          </div>
          {blame.truncated ? <p className="git-file-history-note">结果已截断。</p> : null}
        </section>
      ) : null}

      <ul className="git-history-list">
        {(page?.items ?? []).map(commit => (
          <li key={commit.id}>
            <button
              type="button"
              className={detail?.id === commit.id ? 'selected' : ''}
              aria-current={detail?.id === commit.id ? 'true' : undefined}
              onClick={() => history.selectCommit(commit)}
            >
              <code>{commit.shortId}</code>
              <span title={commit.subject}>{commit.subject}</span>
              {commit.isMerge ? <em className="git-merge-badge-inline">合并</em> : null}
              {commit.decoration.length > 0 ? (
                <em className="git-ref-badge" title={commit.decoration.join(', ')}>
                  {commit.decoration[0]}
                </em>
              ) : null}
              <time dateTime={commit.authoredAt}>{formatDate(commit.authoredAt)}</time>
            </button>
          </li>
        ))}
      </ul>

      {page && page.items.length === 0 && !history.loading ? (
        <div className="resource-empty compact">
          <Icon name="search" size={16} />
          <strong>没有匹配的提交</strong>
          <p>筛选在 Host 上对整个可达历史执行，不只是当前页。</p>
        </div>
      ) : null}

      {page?.nextCursor ? (
        <button
          type="button"
          className="text-button resource-load-more"
          onClick={history.loadMore}
          disabled={history.loadingMore}
        >
          {history.loadingMore ? '加载中…' : '加载更多提交'}
        </button>
      ) : null}
    </div>
  );
}

/** Dates are shown in the reader's locale; the wire value stays ISO. */
function formatDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}
