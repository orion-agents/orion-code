/**
 * v0.3.17 S2 — structured diff reader.
 *
 * Replaces the v1 reader for the Git panel: real old/new line numbers, continuous hunk
 * reading instead of one tab per hunk, side-by-side alignment, fold, find, and change
 * to change navigation.
 *
 * The v1 `DiffViewer` stays in place for the Review panel until S6 migrates it (plan §6.2
 * requires v1 to survive until both Git and Review are moved over).
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import type { GitDiffDocumentV2, GitHunkV2 } from '../../../../src/web/git-diff-document';
import type { GitDiffMode } from '../../state/git-panel-state';
import { Icon } from '../Icon';
import {
  buildHunkReviewContext,
  buildRenderRows,
  changeAnchors,
  diffStats,
  displayText,
  findInDocument,
  markerFor,
  type DiffRenderRow,
  type SideBySideRow,
} from './diff-view-model';

export interface StructuredDiffViewerProps {
  readonly document: GitDiffDocumentV2;
  readonly mode: GitDiffMode;
  readonly wrap: boolean;
  readonly showWhitespace: boolean;
  readonly collapsedHunks: readonly string[];
  readonly anchorLineId: string | null;
  readonly loading?: boolean;
  readonly stale?: boolean;
  readonly onChangeMode: (mode: GitDiffMode) => void;
  readonly onToggleWrap: () => void;
  readonly onToggleWhitespace: () => void;
  readonly onToggleHunk: (hunkId: string) => void;
  /**
   * v0.3.17 S3 — optional per-hunk write action.
   *
   * Absent means "this comparison cannot be patched": a commit view, a conflicted file,
   * or a document that is not fully loaded. When it is null the viewer stays write-free;
   * when present it only forwards an id, like the rest of the write path.
   */
  readonly hunkAction?: {
    readonly label: string;
    readonly run: (hunkId: string) => void;
  } | null;
  /** v0.3.17 S5 — line-level partial staging (unified mode only). */
  readonly selectedLineIds?: readonly string[];
  readonly onToggleLine?: (lineId: string) => void;
  /** v0.3.17 S5 — flips `git diff --ignore-all-space`; re-reads the document. */
  readonly ignoreWhitespace?: boolean;
  readonly onToggleIgnoreWhitespace?: () => void;
  /** v0.3.17 S5 — word-level diff mode (`--word-diff=plain`). */
  readonly wordDiff?: boolean;
  readonly onToggleWordDiff?: () => void;
  readonly onSetAllFolded: (folded: boolean) => void;
  readonly onAnchorChange: (lineId: string | null) => void;
  readonly onNotice: (text: string) => void;
  readonly onLoadMore?: () => void;
  readonly onSendToComposer?: (text: string) => void;
}

export function StructuredDiffViewer({
  document: doc,
  mode,
  wrap,
  showWhitespace,
  collapsedHunks,
  anchorLineId,
  loading = false,
  stale = false,
  onChangeMode,
  onToggleWrap,
  onToggleWhitespace,
  onToggleHunk,
  hunkAction = null,
  selectedLineIds = [],
  onToggleLine,
  ignoreWhitespace = false,
  onToggleIgnoreWhitespace,
  wordDiff = false,
  onToggleWordDiff,
  onSetAllFolded,
  onAnchorChange,
  onNotice,
  onLoadMore,
  onSendToComposer,
}: StructuredDiffViewerProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findIndex, setFindIndex] = useState(0);

  const rows = useMemo(
    () => buildRenderRows(doc.hunks, collapsedHunks, mode),
    [doc.hunks, collapsedHunks, mode]
  );
  const anchors = useMemo(() => changeAnchors(doc.hunks), [doc.hunks]);
  const stats = useMemo(() => diffStats(doc.hunks), [doc.hunks]);
  const matches = useMemo(
    () => (findOpen ? findInDocument(doc.hunks, findQuery) : []),
    [doc.hunks, findOpen, findQuery]
  );

  // Restore the reading position after a refresh when the anchor still exists.
  useEffect(() => {
    if (!anchorLineId || !bodyRef.current) return;
    bodyRef.current
      .querySelector<HTMLElement>(`[data-line-id="${CSS.escape(anchorLineId)}"]`)
      ?.scrollIntoView({ block: 'center' });
  }, [anchorLineId]);

  useEffect(() => {
    setFindIndex(0);
  }, [findQuery]);

  const currentAnchorIndex = useMemo(() => {
    if (!anchorLineId) return -1;
    return anchors.findIndex(anchor => anchor.lineId === anchorLineId);
  }, [anchors, anchorLineId]);

  const moveAnchor = (delta: number) => {
    if (anchors.length === 0) {
      onNotice('这个文件没有改动。');
      return;
    }
    const base = currentAnchorIndex < 0 ? (delta > 0 ? -1 : 0) : currentAnchorIndex;
    const next = Math.min(anchors.length - 1, Math.max(0, base + delta));
    onAnchorChange(anchors[next].lineId);
  };

  const onBodyKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'F7') {
      event.preventDefault();
      moveAnchor(event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === 'Escape') {
      if (findOpen) {
        event.stopPropagation();
        setFindOpen(false);
        setFindQuery('');
      }
      return;
    }
    if (event.key === 'Enter' && findOpen && matches.length > 0) {
      event.preventDefault();
      const next = event.shiftKey
        ? (findIndex - 1 + matches.length) % matches.length
        : (findIndex + 1) % matches.length;
      setFindIndex(next);
      onAnchorChange(matches[next].lineId);
    }
  };

  if (doc.kind === 'binary' || doc.kind === 'symlink' || doc.kind === 'submodule') {
    return (
      <div className="diff-viewer">
        <DiffHeader doc={doc} stats={stats} stale={stale} />
        <div className="resource-empty compact">
          <Icon name="code" />
          <strong>{kindLabel(doc.kind)}</strong>
          <p>只展示变更事实，不返回可预览内容。</p>
          <ul className="diff-meta-list">
            {doc.meta.slice(0, 8).map(line => (
              <li key={line}>
                <code>{line}</code>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  if (doc.kind === 'metadata') {
    return (
      <div className="diff-viewer">
        <DiffHeader doc={doc} stats={stats} stale={stale} />
        <div className="resource-empty compact">
          <Icon name="code" />
          <strong>仅有元数据变化</strong>
          <p>没有文本 Hunk，但文件确实变了。</p>
          <ul className="diff-meta-list">
            {doc.meta.slice(0, 8).map(line => (
              <li key={line}>
                <code>{line}</code>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  return (
    <div className="diff-viewer">
      <DiffHeader doc={doc} stats={stats} stale={stale} />

      <div className="diff-toolbar" role="toolbar" aria-label="Diff 显示选项">
        <div className="diff-mode-group" role="group" aria-label="Diff 布局">
          <button
            type="button"
            className="text-button"
            aria-pressed={mode === 'unified'}
            onClick={() => onChangeMode('unified')}
          >
            统一
          </button>
          <button
            type="button"
            className="text-button"
            aria-pressed={mode === 'side-by-side'}
            onClick={() => onChangeMode('side-by-side')}
          >
            并排
          </button>
        </div>
        <button type="button" className="text-button" aria-pressed={wrap} onClick={onToggleWrap}>
          换行
        </button>
        <button
          type="button"
          className="text-button"
          aria-pressed={showWhitespace}
          onClick={onToggleWhitespace}
        >
          空白字符
        </button>
        {onToggleWordDiff ? (
          <button
            type="button"
            className={`text-button ${wordDiff ? 'diff-toggle-on' : ''}`}
            aria-pressed={wordDiff}
            title="词级差异（重新读取 Diff）"
            onClick={onToggleWordDiff}
          >
            词级
          </button>
        ) : null}
        {onToggleIgnoreWhitespace ? (
          <button
            type="button"
            className={`text-button ${ignoreWhitespace ? 'diff-toggle-on' : ''}`}
            aria-pressed={ignoreWhitespace}
            title="忽略空白差异（重新读取 Diff）"
            onClick={onToggleIgnoreWhitespace}
          >
            忽略空白
          </button>
        ) : null}
        <button
          type="button"
          className="text-button"
          onClick={() => onSetAllFolded(collapsedHunks.length === 0)}
        >
          {collapsedHunks.length === 0 ? '折叠全部' : '展开全部'}
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => moveAnchor(-1)}
          disabled={anchors.length === 0}
          aria-label="上一个改动"
        >
          ↑改动
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => moveAnchor(1)}
          disabled={anchors.length === 0}
          aria-label="下一个改动"
        >
          ↓改动
        </button>
        <span className="diff-anchor-count" aria-live="polite">
          {anchors.length === 0
            ? '无改动'
            : `改动 ${Math.max(1, currentAnchorIndex + 1)}/${anchors.length}`}
        </span>
        <button
          type="button"
          className="text-button"
          aria-pressed={findOpen}
          onClick={() => setFindOpen(open => !open)}
        >
          查找
        </button>
      </div>

      {findOpen ? (
        <div className="diff-find">
          <input
            type="search"
            value={findQuery}
            autoFocus
            aria-label="在已加载的 Diff 中查找"
            placeholder="在已加载内容中查找"
            onChange={event => setFindQuery(event.target.value)}
          />
          <span aria-live="polite">
            {findQuery.trim()
              ? matches.length === 0
                ? '无命中'
                : `${findIndex + 1}/${matches.length}`
              : '输入以查找'}
            {doc.completeness !== 'complete' ? ' · 仅已加载内容' : ''}
          </span>
        </div>
      ) : null}

      {doc.completeness === 'paged' ? (
        <p className="resource-notice" role="status">
          当前为分页预览，未加载的 Hunk 不能执行任何写入。
        </p>
      ) : null}

      <div
        className={`diff-body diff-body-${mode} ${wrap ? 'diff-wrap' : ''}`}
        ref={bodyRef}
        tabIndex={0}
        role="region"
        aria-label={`Diff ${doc.path}`}
        onKeyDown={onBodyKeyDown}
      >
        {rows.length === 0 ? (
          <div className="resource-empty compact">
            <Icon name="check" />
            <strong>没有文本改动</strong>
          </div>
        ) : (
          rows.map(row => (
            <DiffRow
              key={rowKey(row)}
              row={row}
              mode={mode}
              showWhitespace={showWhitespace}
              folded={collapsedHunks.includes(hunkOf(row).hunkId)}
              activeAnchor={anchorLineId}
              onToggleHunk={onToggleHunk}
              hunkAction={hunkAction}
              selectedLineIds={selectedLineIds}
              onToggleLine={onToggleLine}
              wordDiff={wordDiff}
            />
          ))
        )}
      </div>

      <footer className="diff-footer">
        {onSendToComposer ? (
          <button
            type="button"
            className="secondary-button"
            disabled={doc.hunks.length === 0}
            onClick={() =>
              onSendToComposer(
                buildHunkReviewContext(
                  {
                    path: doc.path,
                    source: doc.source,
                    repositoryRevision: doc.repositoryRevision,
                  },
                  doc.hunks[
                    Math.max(
                      0,
                      anchors.findIndex(a => a.lineId === anchorLineId)
                    )
                  ] ?? doc.hunks[0]
                )
              )
            }
          >
            发送当前 Hunk 到对话
          </button>
        ) : null}
        {doc.nextCursor && onLoadMore ? (
          <button type="button" className="text-button" onClick={onLoadMore} disabled={loading}>
            {loading ? '加载中…' : '加载更多 Diff'}
          </button>
        ) : null}
        <span className="diff-footer-hint">
          {doc.capabilities.stageFile
            ? '可暂存此文件'
            : doc.capabilities.unstageFile
              ? '可取消暂存此文件'
              : '只读'}
          {doc.capabilities.reason ? ` · ${doc.capabilities.reason}` : ''}
        </span>
      </footer>
    </div>
  );
}

function DiffHeader({
  doc,
  stats,
  stale,
}: {
  readonly doc: GitDiffDocumentV2;
  readonly stats: {
    readonly additions: number;
    readonly deletions: number;
    readonly hunks: number;
  };
  readonly stale: boolean;
}) {
  return (
    <header>
      <strong title={doc.path}>{doc.path}</strong>
      <span className="diff-source">{sourceLabel(doc.source)}</span>
      <span className="diff-stat-add">+{stats.additions}</span>
      <span className="diff-stat-del">-{stats.deletions}</span>
      <span>{stats.hunks} 个 Hunk</span>
      {stale ? (
        <span className="diff-stale" role="status">
          已变化
        </span>
      ) : null}
    </header>
  );
}

function DiffRow({
  row,
  mode,
  showWhitespace,
  folded,
  activeAnchor,
  onToggleHunk,
  hunkAction = null,
  selectedLineIds = [],
  onToggleLine,
  wordDiff = false,
}: {
  readonly row: DiffRenderRow;
  readonly mode: GitDiffMode;
  readonly showWhitespace: boolean;
  readonly folded: boolean;
  readonly activeAnchor: string | null;
  readonly onToggleHunk: (hunkId: string) => void;
  readonly hunkAction?: {
    readonly label: string;
    readonly run: (hunkId: string) => void;
  } | null;
  readonly selectedLineIds?: readonly string[];
  readonly onToggleLine?: (lineId: string) => void;
  readonly wordDiff?: boolean;
}) {
  if (row.kind === 'hunk-header') {
    return (
      <div className="diff-hunk-header">
        <button
          type="button"
          className="diff-fold"
          aria-expanded={!folded}
          aria-label={folded ? '展开 Hunk' : '折叠 Hunk'}
          onClick={() => onToggleHunk(row.hunk.hunkId)}
        >
          {folded ? '▸' : '▾'}
        </button>
        <code>{row.hunk.header}</code>
        {!row.hunk.complete ? <em className="diff-incomplete">未完整加载</em> : null}
        {hunkAction && row.hunk.complete ? (
          <button
            type="button"
            className="text-button diff-hunk-action"
            aria-label={hunkAction.label}
            onClick={() => hunkAction.run(row.hunk.hunkId)}
          >
            {hunkAction.label}
          </button>
        ) : null}
      </div>
    );
  }
  if (row.kind === 'folded') {
    return (
      <button
        type="button"
        className="diff-folded-row"
        onClick={() => onToggleHunk(row.hunk.hunkId)}
      >
        已折叠 {row.hunk.lines.length} 行 · 点击展开
      </button>
    );
  }
  if (row.kind === 'side-by-side') {
    return <SideBySideLine row={row.row} showWhitespace={showWhitespace} />;
  }
  const line = row.line;
  return (
    <div
      className={`diff-line diff-line-${line.kind} ${
        activeAnchor === line.lineId ? 'diff-line-anchor' : ''
      }`}
      data-line-id={line.lineId}
      data-side={
        line.oldLineNumber !== null && line.newLineNumber !== null
          ? 'both'
          : line.oldLineNumber !== null
            ? 'old'
            : 'new'
      }
    >
      <span className="diff-gutter">{line.oldLineNumber ?? ''}</span>
      <span className="diff-gutter">{line.newLineNumber ?? ''}</span>
      {onToggleLine && (line.kind === 'addition' || line.kind === 'deletion') ? (
        <input
          type="checkbox"
          className="diff-line-select"
          aria-label={`选择第 ${line.newLineNumber ?? line.oldLineNumber ?? ''} 行`}
          checked={selectedLineIds.includes(line.lineId)}
          onChange={() => onToggleLine(line.lineId)}
        />
      ) : null}
      <span className="diff-marker" aria-hidden="true">
        {markerFor(line.kind)}
      </span>
      <span className="diff-code">
        {wordDiff
          ? renderWordDiff(displayText(line.text, showWhitespace))
          : displayText(line.text, showWhitespace) || ' '}
      </span>
      {mode === 'unified' ? null : null}
    </div>
  );
}

/**
 * v0.3.17 S5 — renders `--word-diff=plain` markers.
 *
 * Only the markers git emits are highlighted; the rest of the line is passed through
 * unchanged, so a line that merely contains `[-` is not mangled.
 */
function renderWordDiff(text: string): React.ReactNode {
  if (!text) return ' ';
  const parts: React.ReactNode[] = [];
  const pattern = /\[-([\s\S]*?)-\]|\{\+([\s\S]*?)\+\}/gu;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    if (match[1] !== undefined) {
      parts.push(
        <em key={key++} className="diff-word-del">
          {match[1]}
        </em>
      );
    } else {
      parts.push(
        <em key={key++} className="diff-word-add">
          {match[2]}
        </em>
      );
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.length > 0 ? parts : ' ';
}

function SideBySideLine({
  row,
  showWhitespace,
}: {
  readonly row: SideBySideRow;
  readonly showWhitespace: boolean;
}) {
  return (
    <div className={`diff-sbs-row ${row.changed ? 'diff-sbs-changed' : ''}`}>
      <div
        className={`diff-sbs-side ${row.left?.kind === 'deletion' ? 'diff-line-deletion' : ''}`}
        data-line-id={row.left?.lineId ?? undefined}
      >
        <span className="diff-gutter">{row.left?.oldLineNumber ?? ''}</span>
        <span className="diff-marker" aria-hidden="true">
          {row.left ? markerFor(row.left.kind) : ' '}
        </span>
        <span className="diff-code">
          {row.left ? displayText(row.left.text, showWhitespace) || ' ' : ''}
        </span>
      </div>
      <div
        className={`diff-sbs-side ${row.right?.kind === 'addition' ? 'diff-line-addition' : ''}`}
        data-line-id={row.right?.lineId ?? undefined}
      >
        <span className="diff-gutter">{row.right?.newLineNumber ?? ''}</span>
        <span className="diff-marker" aria-hidden="true">
          {row.right ? markerFor(row.right.kind) : ' '}
        </span>
        <span className="diff-code">
          {row.right ? displayText(row.right.text, showWhitespace) || ' ' : ''}
        </span>
      </div>
    </div>
  );
}

function rowKey(row: DiffRenderRow): string {
  if (row.kind === 'hunk-header') return `h:${row.hunk.hunkId}`;
  if (row.kind === 'folded') return `f:${row.hunk.hunkId}`;
  if (row.kind === 'side-by-side') return row.row.key;
  return row.line.lineId;
}

function hunkOf(row: DiffRenderRow): GitHunkV2 {
  return row.hunk;
}

function kindLabel(kind: GitDiffDocumentV2['kind']): string {
  if (kind === 'binary') return '二进制差异';
  if (kind === 'symlink') return '符号链接变化';
  if (kind === 'submodule') return 'Submodule 指针变化';
  return '元数据变化';
}

export function sourceLabel(source: GitDiffDocumentV2['source']): string {
  if (source === 'staged') return 'HEAD → 索引';
  if (source === 'unstaged') return '索引 → 工作区';
  if (source === 'untracked') return '空 → 未跟踪文件';
  return '冲突版本';
}
