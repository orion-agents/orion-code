/**
 * v0.3.17 S2 — Git work panel.
 *
 * Organises the three views, the change navigator and the reading pane. All reading state
 * lives in `useGitWorkspace` so the dock may unmount this pane and come back to the same
 * place; all writes are deliberately absent until S3 (plan §10 scopes file level write
 * wiring to S3, hunk/line writes follow it).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useGitHistory } from '../../state/useGitHistory';
import { useGitPanelKeyboard } from '../../state/useGitPanelKeyboard';

import type { GitCommitPreviewV1, GitWorktreeSourceV1, WebGitFileV1 } from '../../types';
import { ResourceSplitLayout } from '../../layout/ResourceSplitLayout';
import { entriesForSource, useGitWorkspace } from '../../state/useGitWorkspace';
import {
  GIT_PANEL_VIEWS,
  resolveGitPanelLayout,
  type GitPanelStore,
  type GitPanelView,
} from '../../state/git-panel-state';
import { changeAnchors } from './diff-view-model';
import { Icon } from '../Icon';
import { useAutoNotice } from '../useAutoNotice';
import { GitCompareView } from './GitCompareView';
import { GitConflictView } from './GitConflictView';
import { GitHistoryView } from './GitHistoryView';
import { StructuredDiffViewer } from './StructuredDiffViewer';

const VIEW_LABELS: Record<GitPanelView, string> = {
  changes: '变更',
  history: '历史',
  compare: '比较',
};

const GROUP_LABELS = {
  conflict: '冲突',
  unstaged: '未暂存',
  staged: '已暂存',
  untracked: '未跟踪',
} as const;

const GROUP_ORDER = ['conflict', 'unstaged', 'staged', 'untracked'] as const;

/** `counts` keeps the v1 spelling `conflicted`; the source name is `conflict`. */
function countOf(
  counts: {
    readonly conflicted: number;
    readonly staged: number;
    readonly unstaged: number;
    readonly untracked: number;
  },
  source: (typeof GROUP_ORDER)[number]
): number {
  return source === 'conflict' ? counts.conflicted : counts[source];
}

export function GitPanel({
  workspaceId,
  refreshEpoch,
  actions,
  onSendToComposer,
  onRevealInFiles,
  navigatorWidthPx,
  onNavigatorWidthCommit,
  store,
}: {
  readonly workspaceId: string;
  readonly refreshEpoch: number;
  readonly actions: Parameters<typeof useGitWorkspace>[0]['actions'];
  readonly onSendToComposer: (text: string) => void;
  /** v0.3.17 S6 — ask the Files panel to open this working-tree file (plan G7). */
  readonly onRevealInFiles?: (target: {
    readonly path: string;
    readonly filesToken: string;
  }) => void;
  /** v0.3.13 — per-workspace + per-panel navigator (change list) column width. */
  readonly navigatorWidthPx: number;
  /** v0.3.13 — persists one workspace/panel width on pointer-up / keyboard commit. */
  readonly onNavigatorWidthCommit: (width: number) => void;
  /** Injectable session store; defaults to the app-wide one. */
  readonly store?: GitPanelStore;
}) {
  const git = useGitWorkspace({ workspaceId, refreshEpoch, actions, store });
  const { notice, showNotice, clearNotice } = useAutoNotice();
  const { status, diff, session } = git;
  // v0.3.17 S4 — history has its own loading/error state so a slow history query never
  // blanks the change list, and vice versa.
  /**
   * v0.3.17 S3 — per-hunk write action for the change-list diff.
   *
   * The direction is decided by the comparison source: an unstaged or untracked file is
   * staged into the index, a staged file is reversed out of it, and a commit is read-only
   * so it gets no action at all. The Host owns the patch text either way.
   */
  /** v0.3.17 S5 — submit the ticked lines as one partial patch. */
  const stageSelectedLines = () => {
    if (!session.selectedFileId || session.selectedLineIds.length === 0) return;
    const fileId = session.selectedFileId;
    const lineIds = session.selectedLineIds;
    void git.applyPatch({ fileId, lineIds });
    git.setSession({ selectedLineIds: [] });
  };

  /**
   * v0.3.17 S6 — responsive tiers keyed off the *panel* width, not the window (plan §4.3).
   *
   * v0.3.19 (G317-19) — two fixes, both found by asserting the tier against the panel that is
   * actually rendered:
   *
   *   1. The decision lives in `resolveGitPanelLayout`, so the plan's widths (960 / 620 / 360)
   *      are asserted in a unit test rather than only being observable in whichever browser
   *      window happened to be open.
   *   2. The observer is attached with a **callback ref**, not an effect. The panel's first
   *      render is the loading placeholder, which does not contain the measured node, so an
   *      effect with `[]` deps read `panelRef.current === null`, returned, and never ran again:
   *      the width stayed 0, `data-width` stayed `wide` on a 480px panel, and the responsive
   *      tiers were silently inert on every load whose status was not already cached.
   *
   * The forced unified mode never writes back to the stored preference: a narrow container must
   * not permanently downgrade what the reader chose for a wide one.
   */
  const observerRef = useRef<ResizeObserver | null>(null);
  const attachPanel = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) setPanelWidth(entry.contentRect.width);
    });
    observer.observe(node);
    observerRef.current = observer;
    // The first observation is asynchronous, so seed from the layout we are already in.
    setPanelWidth(node.getBoundingClientRect().width);
  }, []);
  const [panelWidth, setPanelWidth] = useState(0);
  useEffect(() => () => observerRef.current?.disconnect(), []);
  const layout = resolveGitPanelLayout(panelWidth, git.display.mode);
  const narrow = layout.narrow;
  const effectiveMode = layout.effectiveMode;

  /**
   * v0.3.19 (G317-19) — "which pane is on top" is not the same question as "which file is
   * being read".
   *
   * The narrow tier used to switch back to the list by clearing `selectedFileId`, which threw
   * away the reader's position, the anchors that hang off it, and the cached document. Returning
   * to the list must cost nothing, so the pane choice is its own state and the selection stays.
   */
  const [narrowShowsDetail, setNarrowShowsDetail] = useState(false);

  /**
   * v0.3.17 S6 — "open in Files" for a working-tree file.
   *
   * A historical comparison deliberately gets no such action: plan G7 forbids opening the
   * current file of the same name for a revision that no longer exists. Those views offer
   * "该版本" instead.
   */
  const revealInFiles = useMemo(() => {
    const entry = git.selectedEntry;
    if (!onRevealInFiles || !entry || session.view !== 'changes') return null;
    const fileId = entry.fileId;
    return () => {
      void actions
        .gitFilesTarget(fileId)
        .then(target => onRevealInFiles({ path: target.path, filesToken: target.filesToken }))
        .catch(() => showNotice('该文件无法在 Files 中打开。'));
    };
  }, [actions, git.selectedEntry, onRevealInFiles, session.view, showNotice]);

  const hunkAction = useMemo(() => {
    if (session.view !== 'changes' || !session.selectedFileId || !diff) return null;
    const selectedFileId = session.selectedFileId;
    if (diff.source !== 'staged' && diff.source !== 'unstaged' && diff.source !== 'untracked') {
      return null;
    }
    const label = diff.source === 'staged' ? '取消暂存此 Hunk' : '暂存此 Hunk';
    return {
      label,
      run: (hunkId: string) => {
        void git.applyPatch({
          fileId: selectedFileId,
          hunkIds: [hunkId],
        });
      },
    };
  }, [diff, git, session.selectedFileId, session.view]);

  const history = useGitHistory({
    workspaceId,
    // The compare view needs the ref list from here, so history loading must not be tied to
    // the history tab alone — otherwise switching to 比较 shows an empty ref picker.
    enabled: (session.view === 'history' || session.view === 'compare') && Boolean(workspaceId),
    session,
    setSession: git.setSession,
    actions,
    refreshEpoch,
  });

  const groups = useMemo(() => {
    if (!status) return [];
    return GROUP_ORDER.map(source => ({
      source,
      label: GROUP_LABELS[source],
      count: countOf(status.counts, source),
      items: entriesForSource(status, source),
    }));
  }, [status]);

  const visibleGroups = useMemo(
    () => (session.group ? groups.filter(group => group.source === session.group) : groups),
    [groups, session.group]
  );

  const navigatorFileIds = useMemo(
    () => visibleGroups.flatMap(group => group.items.map(entry => entry.fileId)),
    [visibleGroups]
  );
  const anchorLineIds = useMemo(
    () => (diff ? changeAnchors(diff.hunks).map(anchor => anchor.lineId) : []),
    [diff]
  );

  useGitPanelKeyboard({
    enabled: session.view === 'changes',
    session,
    setSession: git.setSession,
    fileIds: navigatorFileIds,
    anchorLineIds,
    onOpenSelection: () => {
      const entry = git.selectedEntry;
      if (entry) git.openFile(entry);
    },
    // The panel itself has no further layer to close; the dock owns that.
    onEscapeFallback: () => undefined,
  });

  if (git.error && !status) {
    return (
      <div className="resource-empty" role="alert">
        <Icon name="warning" />
        <strong>Git 状态读取失败</strong>
        <p>{git.error}</p>
        <button type="button" className="secondary-button" onClick={git.reload}>
          重试
        </button>
      </div>
    );
  }

  if (git.loading && !status) {
    return <p className="resource-loading">正在读取 Git 状态…</p>;
  }

  if (status && status.repositoryKind === 'bare') {
    // v0.3.19 (G317-22) — a bare repository *is* a repository, so it must not be told the
    // project "is not a Git repository". What it has no working tree, and this panel reads one.
    return (
      <div className="resource-empty">
        <Icon name="branch" size={16} />
        <strong>当前项目是裸仓库</strong>
        <p>裸仓库没有工作区，工作栏没有可显示的变更或 Diff。文件和 Agent 不受影响。</p>
      </div>
    );
  }

  if (status && !status.isRepository) {
    return (
      <div className="resource-empty">
        <Icon name="branch" size={16} />
        <strong>当前项目不是 Git 仓库</strong>
        <p>文件和 Agent 不受影响。</p>
      </div>
    );
  }

  return (
    <div
      ref={attachPanel}
      data-width={layout.dataWidth}
      data-narrow-view={narrow && narrowShowsDetail && session.selectedFileId ? 'detail' : 'list'}
      className="work-resource-panel git-panel"
    >
      <div className="git-summary">
        <div>
          <Icon name="branch" size={16} />
          <strong>
            {status?.detached ? `detached ${status.head ?? ''}` : status?.branch || 'HEAD'}
          </strong>
        </div>
        <span>
          {status?.upstream || '无 upstream'}
          {status && (status.ahead || status.behind) ? ` · ↑${status.ahead} ↓${status.behind}` : ''}
        </span>
        <button
          type="button"
          className="icon-button"
          aria-label="刷新 Git 状态"
          aria-busy={git.refreshing}
          onClick={() => {
            clearNotice();
            git.reload();
          }}
          disabled={git.refreshing}
        >
          <Icon name="refresh" size={16} />
        </button>
      </div>

      <div className="git-views" role="tablist" aria-label="Git 视图">
        {GIT_PANEL_VIEWS.map(view => (
          <button
            key={view}
            type="button"
            role="tab"
            aria-selected={session.view === view}
            className={session.view === view ? 'selected' : ''}
            onClick={() => git.setSession({ view })}
          >
            {VIEW_LABELS[view]}
            {view === 'changes' && status && status.counts.total > 0 ? (
              <span className="git-view-count">{status.counts.total}</span>
            ) : null}
          </button>
        ))}
        {git.refreshing ? <span className="git-refreshing">更新中…</span> : null}
      </div>

      {notice ? (
        <p className="resource-notice" role="status">
          {notice.text}
        </p>
      ) : null}
      {session.notice ? (
        <p className="resource-notice" role="status">
          {session.notice}
        </p>
      ) : null}
      {git.error ? (
        <p className="resource-error" role="alert">
          {git.error}
        </p>
      ) : null}

      <ResourceSplitLayout
        panelId="git"
        navigatorWidthPx={navigatorWidthPx}
        onNavigatorWidthCommit={onNavigatorWidthCommit}
        contentLabel="Git 内容"
        navigatorLabel="Git 导航"
        handleLabel="调整 Git 导航宽度"
        contentClassName="git-content"
        navigatorClassName="git-changes"
      >
        <>
          {narrow && session.selectedFileId ? (
            <button
              type="button"
              className="git-back-to-list"
              onClick={() => setNarrowShowsDetail(false)}
            >
              ← 返回文件列表
            </button>
          ) : null}
          {session.view === 'changes' ? (
            <ChangesNavigator
              groups={visibleGroups}
              activeGroup={session.group}
              query={session.query}
              total={status?.counts.total ?? 0}
              clean={status?.clean ?? false}
              busy={git.busy}
              selectedFileIds={session.selectedFileIds}
              onQueryChange={value => git.setSession({ query: value, selectedFileId: null })}
              onGroupChange={group => git.setSession({ group, selectedFileId: null })}
              selectedFileId={session.selectedFileId}
              onSelect={entry => {
                git.setSession({ selectedLineIds: [] });
                setNarrowShowsDetail(true);
                git.openFile(entry);
              }}
              onToggleSelection={git.toggleSelection}
              onClearSelection={git.clearSelection}
              onStage={fileIds => void git.stagePaths(fileIds)}
              onUnstage={fileIds => void git.unstagePaths(fileIds)}
            />
          ) : null}

          {session.view === 'history' ? (
            <div className="git-history-nav">
              <p className="git-history-nav-note">提交列表与详情显示在右侧。</p>
            </div>
          ) : null}

          {session.view === 'compare' ? (
            <GitCompareView
              refs={history.refs}
              actions={actions}
              display={git.display}
              collapsedHunks={session.collapsedHunks}
              anchorLineId={session.anchorLineId}
              onDisplayChange={patch => git.setDisplay(patch)}
              onToggleHunk={hunkId =>
                git.setSession({
                  collapsedHunks: session.collapsedHunks.includes(hunkId)
                    ? session.collapsedHunks.filter(id => id !== hunkId)
                    : [...session.collapsedHunks, hunkId],
                })
              }
              onSetAllFolded={folded =>
                git.setSession({
                  collapsedHunks: folded ? session.collapsedHunks : [],
                })
              }
              onAnchorChange={lineId => git.setSession({ anchorLineId: lineId })}
              onNotice={showNotice}
              onSendToComposer={onSendToComposer}
            />
          ) : null}
        </>
        <>
          {session.view === 'changes' ? (
            git.selectedEntry?.source === 'conflict' ? (
              <GitConflictView path={git.selectedEntry.path} actions={actions} />
            ) : diff ? (
              <div>
                {revealInFiles ? (
                  <div className="git-reveal-row">
                    <button type="button" className="text-button" onClick={revealInFiles}>
                      在 Files 打开
                    </button>
                  </div>
                ) : null}
                {session.selectedLineIds.length > 0 ? (
                  <div className="git-line-actions" role="group" aria-label="选中的行">
                    <span>已选 {session.selectedLineIds.length} 行</span>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={git.busy}
                      onClick={stageSelectedLines}
                    >
                      暂存选中行
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => git.setSession({ selectedLineIds: [] })}
                    >
                      清除
                    </button>
                  </div>
                ) : null}
                <StructuredDiffViewer
                  hunkAction={hunkAction}
                  ignoreWhitespace={git.display.ignoreWhitespace}
                  onToggleIgnoreWhitespace={() =>
                    git.setDisplay({ ignoreWhitespace: !git.display.ignoreWhitespace })
                  }
                  wordDiff={git.display.wordDiff}
                  onToggleWordDiff={() => git.setDisplay({ wordDiff: !git.display.wordDiff })}
                  selectedLineIds={session.selectedLineIds}
                  onToggleLine={lineId =>
                    git.setSession({
                      selectedLineIds: session.selectedLineIds.includes(lineId)
                        ? session.selectedLineIds.filter(id => id !== lineId)
                        : [...session.selectedLineIds, lineId],
                    })
                  }
                  document={diff}
                  mode={effectiveMode}
                  wrap={git.display.wrap}
                  showWhitespace={git.display.showWhitespace}
                  collapsedHunks={session.collapsedHunks}
                  anchorLineId={session.anchorLineId}
                  loading={git.loading}
                  stale={git.stale}
                  onChangeMode={mode => git.setDisplay({ mode })}
                  onToggleWrap={() => git.setDisplay({ wrap: !git.display.wrap })}
                  onToggleWhitespace={() =>
                    git.setDisplay({ showWhitespace: !git.display.showWhitespace })
                  }
                  onToggleHunk={hunkId =>
                    git.setSession({
                      collapsedHunks: session.collapsedHunks.includes(hunkId)
                        ? session.collapsedHunks.filter(id => id !== hunkId)
                        : [...session.collapsedHunks, hunkId],
                    })
                  }
                  onSetAllFolded={folded =>
                    git.setSession({
                      collapsedHunks: folded
                        ? diff.hunks.map(hunk => hunk.hunkId)
                        : ([] as readonly string[]),
                    })
                  }
                  onAnchorChange={lineId => git.setSession({ anchorLineId: lineId })}
                  onNotice={showNotice}
                  onLoadMore={diff.nextCursor ? git.loadMoreDiff : undefined}
                  onSendToComposer={onSendToComposer}
                />
              </div>
            ) : (
              <div className="resource-empty">
                <Icon name="code" size={16} />
                <strong>选择变更查看 Diff</strong>
                <p>同一文件的「未暂存」和「已暂存」是两个不同的比较目标。</p>
              </div>
            )
          ) : null}

          {session.view === 'changes' ? (
            <CommitForm
              preview={git.commitPreview}
              draft={session.commitDraft}
              busy={git.busy}
              onDraftChange={commitDraft => git.setSession({ commitDraft })}
              onCommit={input => git.commit(input)}
            />
          ) : null}

          {session.view === 'history' ? (
            <GitHistoryView
              history={history}
              actions={actions}
              display={git.display}
              collapsedHunks={session.collapsedHunks}
              anchorLineId={session.anchorLineId}
              onDisplayChange={patch => git.setDisplay(patch)}
              onToggleHunk={hunkId =>
                git.setSession({
                  collapsedHunks: session.collapsedHunks.includes(hunkId)
                    ? session.collapsedHunks.filter(id => id !== hunkId)
                    : [...session.collapsedHunks, hunkId],
                })
              }
              onSetAllFolded={folded =>
                git.setSession({
                  collapsedHunks: folded ? session.collapsedHunks : [],
                })
              }
              onAnchorChange={lineId => git.setSession({ anchorLineId: lineId })}
              onNotice={showNotice}
              onSendToComposer={onSendToComposer}
            />
          ) : null}

          {session.view === 'compare' ? <NotYet title="比较结果" stage="S5" /> : null}
        </>
      </ResourceSplitLayout>
    </div>
  );
}

/**
 * v0.3.17 S3 — commit form.
 *
 * Plan G3 requires the form to describe the *real index*, independent of whatever the change
 * list is filtered to, and to show the identity, signing and hook configuration the commit
 * will actually run under. A failure keeps the draft: the reason is surfaced, the text is not
 * thrown away.
 */
function CommitForm({
  preview,
  draft,
  busy,
  onDraftChange,
  onCommit,
}: {
  readonly preview: GitCommitPreviewV1 | null;
  readonly draft: { readonly summary: string; readonly body: string };
  readonly busy: boolean;
  readonly onDraftChange: (draft: { readonly summary: string; readonly body: string }) => void;
  readonly onCommit: (input: {
    readonly summary: string;
    readonly body?: string;
  }) => Promise<string>;
}) {
  const [open, setOpen] = useState(false);
  const [localError, setLocalError] = useState('');
  const blocked = preview?.blockedReason ?? '正在读取暂存区…';
  const canCommit = Boolean(preview?.canCommit) && draft.summary.trim().length > 0 && !busy;

  const submit = () => {
    setLocalError('');
    void onCommit({
      summary: draft.summary,
      ...(draft.body.trim() ? { body: draft.body } : {}),
    }).catch(error => setLocalError(error instanceof Error ? error.message : '提交失败。'));
  };

  return (
    <section className="git-commit" aria-label="提交">
      <button
        type="button"
        className="git-commit-toggle"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        {open ? '▾' : '▸'} 提交 {preview ? `${preview.filesChanged} 个文件` : ''}
        {preview && (preview.additions > 0 || preview.deletions > 0) ? (
          <span className="git-commit-stats">
            <em className="diff-stat-add">+{preview.additions}</em>{' '}
            <em className="diff-stat-del">-{preview.deletions}</em>
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="git-commit-body">
          {preview ? (
            <>
              <p className="git-commit-meta">
                {preview.detached ? 'detached HEAD' : preview.branch || 'HEAD'} ·{' '}
                {preview.identity.name ?? '未配置 user.name'} &lt;
                {preview.identity.email ?? '未配置 user.email'}&gt;
                {preview.identity.signingEnabled ? ' · 已启用签名' : ' · 未启用签名'}
                {` · hooks ${preview.identity.hooksPresent ? '存在' : '不存在'}`}
              </p>
              <ul className="git-commit-files">
                {preview.entries.slice(0, 40).map(entry => (
                  <li key={`${entry.source}:${entry.path}`}>
                    <code>{entry.status}</code>
                    <span>{entry.path}</span>
                  </li>
                ))}
                {preview.entries.length > 40 ? (
                  <li className="git-commit-more">…还有 {preview.entries.length - 40} 个文件</li>
                ) : null}
              </ul>
            </>
          ) : null}

          <label>
            <span>摘要</span>
            <input
              type="text"
              value={draft.summary}
              maxLength={2000}
              disabled={busy}
              placeholder="本次提交做了什么"
              onChange={event => onDraftChange({ ...draft, summary: event.target.value })}
            />
          </label>
          <label>
            <span>正文（可选）</span>
            <textarea
              value={draft.body}
              rows={3}
              disabled={busy}
              placeholder="为什么这样做"
              onChange={event => onDraftChange({ ...draft, body: event.target.value })}
            />
          </label>

          {localError ? (
            <p className="resource-error" role="alert">
              {localError}
            </p>
          ) : null}

          <div className="git-commit-actions">
            <button
              type="button"
              className="primary-button"
              disabled={!canCommit}
              aria-busy={busy}
              onClick={submit}
            >
              {busy ? '提交中…' : '提交到本地索引'}
            </button>
            {!preview?.canCommit ? <span className="git-commit-blocked">{blocked}</span> : null}
          </div>
          <p className="git-commit-note">只提交本地 index：不自动暂存、不 amend、不 push。</p>
        </div>
      ) : null}
    </section>
  );
}

function ChangesNavigator({
  groups,
  activeGroup,
  query,
  total,
  clean,
  busy,
  selectedFileIds,
  onQueryChange,
  onGroupChange,
  selectedFileId,
  onSelect,
  onToggleSelection,
  onClearSelection,
  onStage,
  onUnstage,
}: {
  readonly groups: readonly {
    readonly source: (typeof GROUP_ORDER)[number];
    readonly label: string;
    readonly count: number;
    readonly items: readonly WebGitFileV1[];
  }[];
  readonly activeGroup: GitWorktreeSourceV1 | null;
  readonly query: string;
  readonly total: number;
  readonly clean: boolean;
  readonly busy: boolean;
  readonly selectedFileIds: readonly string[];
  readonly onQueryChange: (value: string) => void;
  readonly onGroupChange: (group: GitWorktreeSourceV1 | null) => void;
  readonly selectedFileId: string | null;
  readonly onSelect: (entry: WebGitFileV1) => void;
  readonly onToggleSelection: (fileId: string) => void;
  readonly onClearSelection: () => void;
  readonly onStage: (fileIds: readonly string[]) => void;
  readonly onUnstage: (fileIds: readonly string[]) => void;
}) {
  const selected = new Set(selectedFileIds);
  const selectedWritable = selectedFileIds.length > 0;
  return (
    <>
      <div className="git-filter">
        <input
          type="search"
          value={query}
          aria-label="搜索文件路径"
          placeholder="搜索文件…"
          onChange={event => onQueryChange(event.target.value)}
        />
        <div className="git-filter-groups" role="group" aria-label="按分组筛选">
          <button
            type="button"
            aria-pressed={activeGroup === null}
            onClick={() => onGroupChange(null)}
          >
            全部
          </button>
          {GROUP_ORDER.map(source => (
            <button
              type="button"
              key={source}
              aria-pressed={activeGroup === source}
              onClick={() => onGroupChange(activeGroup === source ? null : source)}
            >
              {GROUP_LABELS[source]}
            </button>
          ))}
        </div>
        <p className="git-filter-summary" role="status">
          {total === 0 ? (query ? '没有匹配的改动' : '没有改动') : `匹配 ${total} 个改动`}
        </p>
        {selectedWritable ? (
          <div className="git-bulk" role="group" aria-label="对选中文件操作">
            {/* v0.3.17 S3 / plan G1 — the label states the real scope so a bulk action can
                never be mistaken for "just the visible ones". */}
            <span>已选 {selectedFileIds.length} 个文件</span>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => onStage(selectedFileIds)}
            >
              暂存选中
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => onUnstage(selectedFileIds)}
            >
              取消暂存选中
            </button>
            <button type="button" className="text-button" onClick={onClearSelection}>
              清除
            </button>
          </div>
        ) : null}
      </div>

      {clean ? (
        <div className="resource-empty compact">
          <Icon name="check" />
          <strong>工作区干净</strong>
        </div>
      ) : (
        groups.map(group =>
          group.count ? (
            <div className="git-group" key={group.source}>
              <h3>
                {group.label} <span>{group.count}</span>
                {group.items.length < group.count ? (
                  <small className="git-group-loaded">已载 {group.items.length}</small>
                ) : null}
                {group.source === 'unstaged' || group.source === 'untracked' ? (
                  <button
                    type="button"
                    className="text-button git-group-action"
                    disabled={busy}
                    onClick={() => onStage(group.items.map(entry => entry.fileId))}
                  >
                    暂存该组已载
                  </button>
                ) : null}
                {group.source === 'staged' ? (
                  <button
                    type="button"
                    className="text-button git-group-action"
                    disabled={busy}
                    onClick={() => onUnstage(group.items.map(entry => entry.fileId))}
                  >
                    取消暂存该组已载
                  </button>
                ) : null}
              </h3>
              {group.items.map(entry => (
                <div
                  key={entry.fileId}
                  className={`git-row ${selectedFileId === entry.fileId ? 'selected' : ''}`}
                >
                  {/* Plan G1: the checkbox is a separate concept from the read position. */}
                  <input
                    type="checkbox"
                    aria-label={`选择 ${entry.path}`}
                    checked={selected.has(entry.fileId)}
                    onChange={() => onToggleSelection(entry.fileId)}
                  />
                  <button
                    type="button"
                    className={selectedFileId === entry.fileId ? 'selected' : ''}
                    aria-current={selectedFileId === entry.fileId ? 'true' : undefined}
                    onClick={() => onSelect(entry)}
                  >
                    <span className={`git-status-code ${group.source}`}>
                      {entry.indexStatus.trim() || entry.worktreeStatus.trim() || '?'}
                    </span>
                    <span title={entry.path}>
                      {entry.renamedFrom ? `${entry.renamedFrom} → ${entry.path}` : entry.path}
                    </span>
                  </button>
                  {group.source === 'unstaged' || group.source === 'untracked' ? (
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      aria-label={`暂存 ${entry.path}`}
                      onClick={() => onStage([entry.fileId])}
                    >
                      暂存
                    </button>
                  ) : null}
                  {group.source === 'staged' ? (
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      aria-label={`取消暂存 ${entry.path}`}
                      onClick={() => onUnstage([entry.fileId])}
                    >
                      取消
                    </button>
                  ) : null}
                  {group.source === 'conflict' ? (
                    <span className="git-conflict-hint">需在 Files 处理</span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null
        )
      )}
    </>
  );
}

/**
 * An explicit placeholder. The panel states what is missing and which stage delivers it
 * rather than showing an empty pane that reads as a bug.
 */
function NotYet({ title, stage }: { readonly title: string; readonly stage: string }) {
  return (
    <div className="resource-empty">
      <Icon name="info" size={16} />
      <strong>{title}</strong>
      <p>计划阶段 {stage} 交付，当前版本尚未实现。</p>
    </div>
  );
}
