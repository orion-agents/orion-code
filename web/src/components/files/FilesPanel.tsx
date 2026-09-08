import { useEffect, useMemo, useRef, useState } from 'react';

import { WebApiError } from '../../api';
import type { WebFileNodeV1, WebGitStatusV1 } from '../../types';
import type { WorkbenchActions } from '../../useWorkbench';
import { ResourceSplitLayout } from '../../layout/ResourceSplitLayout';
import { Icon } from '../Icon';
import { sanitizeDisplayText } from '../Markdown';

interface DirectoryPage {
  readonly items: readonly WebFileNodeV1[];
  readonly nextCursor: string | null;
  readonly revision: string;
  readonly loading: boolean;
  readonly error?: string;
}

type GitDecorations = Readonly<Record<string, readonly string[]>>;

export function FilesPanel({
  workspaceId,
  refreshEpoch,
  actions,
  navigatorWidthPx,
  onNavigatorWidthCommit,
}: {
  readonly workspaceId: string;
  readonly refreshEpoch: number;
  readonly actions: WorkbenchActions;
  /** v0.3.13 — per-workspace + per-panel navigator (tree) column width. */
  readonly navigatorWidthPx: number;
  /** v0.3.13 — persists one workspace/panel width on pointer-up / keyboard commit. */
  readonly onNavigatorWidthCommit: (width: number) => void;
}) {
  const [directories, setDirectories] = useState<Readonly<Record<string, DirectoryPage>>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(['workspace-root']));
  const [selected, setSelected] = useState<WebFileNodeV1 | null>(null);
  const [content, setContent] = useState('');
  const [contentCursor, setContentCursor] = useState<string | null>(null);
  const [binary, setBinary] = useState(false);
  const [contentError, setContentError] = useState('');
  const [resourceNotice, setResourceNotice] = useState('');
  const [query, setQuery] = useState('');
  const [gitDecorations, setGitDecorations] = useState<GitDecorations>({});
  const [gitDecorationNotice, setGitDecorationNotice] = useState('');
  // v0.3.14 — file editor state: view/edit modes with a CAS-guarded draft.
  const [editMode, setEditMode] = useState<'view' | 'edit'>('view');
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [contentRevision, setContentRevision] = useState('');
  const generationRef = useRef(0);
  const contentRequestRef = useRef(0);

  const loadDirectory = async (
    parentId: string,
    append = false,
    generation = generationRef.current
  ) => {
    if (generation !== generationRef.current) return;
    const previous = directories[parentId];
    const cursor = append ? previous?.nextCursor : undefined;
    if (append && !cursor) return;
    setDirectories(current => ({
      ...current,
      [parentId]: {
        items: previous?.items ?? [],
        nextCursor: previous?.nextCursor ?? null,
        revision: previous?.revision ?? '',
        loading: true,
      },
    }));
    try {
      const page = await actions.listFiles(parentId, cursor ?? undefined);
      if (generation !== generationRef.current) return;
      setDirectories(current => ({
        ...current,
        [parentId]: {
          items: append ? mergeNodes(current[parentId]?.items ?? [], page.items) : page.items,
          nextCursor: page.nextCursor,
          revision: page.revision,
          loading: false,
        },
      }));
    } catch (error) {
      if (generation !== generationRef.current) return;
      if (append && isRevisionConflict(error)) {
        setResourceNotice('目录已变化，已重新载入第一页。');
        void loadDirectory(parentId, false, generation);
        return;
      }
      setDirectories(current => ({
        ...current,
        [parentId]: {
          items: current[parentId]?.items ?? [],
          nextCursor: current[parentId]?.nextCursor ?? null,
          revision: current[parentId]?.revision ?? '',
          loading: false,
          error: message(error),
        },
      }));
    }
  };

  const loadGitDecorations = async (generation = generationRef.current) => {
    try {
      const status = await actions.gitStatus();
      if (generation !== generationRef.current) return;
      setGitDecorations(buildGitDecorations(status));
      setGitDecorationNotice(
        status.nextCursor ? 'Git 装饰仅显示首批 200 个变更；在 Git 面板继续分页查看。' : ''
      );
    } catch (error) {
      if (generation !== generationRef.current) return;
      setGitDecorations({});
      setGitDecorationNotice(`Git 状态装饰不可用：${message(error)}`);
    }
  };

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    contentRequestRef.current += 1;
    setDirectories({});
    setExpanded(new Set(['workspace-root']));
    setSelected(null);
    setContent('');
    setContentCursor(null);
    setBinary(false);
    setContentError('');
    setResourceNotice('');
    setGitDecorations({});
    setGitDecorationNotice('');
    if (workspaceId) {
      void loadDirectory('workspace-root', false, generation);
      void loadGitDecorations(generation);
    }
    // Loading is deliberately tied to the active Context identity.
  }, [refreshEpoch, workspaceId]);

  const selectFile = async (
    node: WebFileNodeV1,
    append = false,
    recovered = false,
    generation = generationRef.current,
    request = contentRequestRef.current + 1
  ) => {
    if (generation !== generationRef.current) return;
    if (!node.readable || node.sensitive || isDirectoryLike(node)) return;
    contentRequestRef.current = request;
    setSelected(node);
    setContentError('');
    if (!append) {
      setContent('');
      setContentCursor(null);
      setBinary(false);
      setEditMode('view');
      setDraft('');
      setConflict(false);
    }
    if (!recovered) setResourceNotice('');
    try {
      const page = await actions.readFileContent(
        node.id,
        append ? (contentCursor ?? undefined) : undefined
      );
      if (generation !== generationRef.current || request !== contentRequestRef.current) return;
      setBinary(page.binary);
      setContent(current => (append ? `${current}${page.content ?? ''}` : (page.content ?? '')));
      setContentCursor(page.nextCursor);
      setContentRevision(page.revision);
      if (recovered) setResourceNotice('文件已变化，已从第一页重新载入。');
    } catch (error) {
      if (generation !== generationRef.current || request !== contentRequestRef.current) return;
      if (append && isRevisionConflict(error)) {
        await selectFile(node, false, true, generation, request);
        return;
      }
      setContentError(message(error));
    }
  };

  const editable =
    Boolean(selected) &&
    !binary &&
    !selected?.sensitive &&
    contentCursor === null &&
    (selected?.sizeBytes ?? 0) <= 512 * 1024;

  const beginEdit = () => {
    setDraft(content);
    setConflict(false);
    setEditMode('edit');
  };

  const cancelEdit = () => {
    if (draft !== content && !window.confirm('放弃未保存的修改？')) return;
    setEditMode('view');
    setDraft('');
    setConflict(false);
  };

  const saveEdit = async () => {
    if (!selected || saving) return;
    setSaving(true);
    setConflict(false);
    try {
      await actions.writeFileContent(selected.id, draft, contentRevision);
      setEditMode('view');
      setDraft('');
      await selectFile(selected, false, true, generationRef.current, contentRequestRef.current + 1);
      setResourceNotice('已保存文件。');
      void loadGitDecorations();
    } catch (error) {
      if (isRevisionConflict(error)) setConflict(true);
      else setResourceNotice(message(error));
    } finally {
      setSaving(false);
    }
  };

  const toggleDirectory = (nodeId: string) => {
    const next = new Set(expanded);
    if (next.has(nodeId)) next.delete(nodeId);
    else {
      next.add(nodeId);
      if (!directories[nodeId]) void loadDirectory(nodeId);
    }
    setExpanded(next);
  };

  const loadedNodes = useMemo(
    () => Object.values(directories).flatMap(page => page.items),
    [directories]
  );
  const matches = query.trim()
    ? loadedNodes.filter(node => node.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    : null;

  return (
    <div className="work-resource-panel files-panel">
      <div className="resource-toolbar">
        <label className="resource-search">
          <span className="sr-only">搜索已加载文件</span>
          <Icon name="search" size={14} />
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="搜索已加载文件"
          />
        </label>
        <button
          type="button"
          className="icon-button"
          aria-label="刷新文件树"
          onClick={() => {
            void loadDirectory('workspace-root');
            void loadGitDecorations();
          }}
        >
          <Icon name="refresh" size={15} />
        </button>
      </div>

      <ResourceSplitLayout
        panelId="files"
        navigatorWidthPx={navigatorWidthPx}
        onNavigatorWidthCommit={onNavigatorWidthCommit}
        contentLabel="文件预览"
        navigatorLabel="工作区文件"
        handleLabel="调整文件目录宽度"
        contentClassName="file-preview"
        navigatorClassName="file-tree"
      >
        <>
          {gitDecorationNotice ? (
            <p className="resource-hint" role="status">
              {gitDecorationNotice}
            </p>
          ) : null}
          {matches ? (
            <>
              <p className="resource-hint">搜索仅覆盖已加载的目录和文件。</p>
              <ul role="list" className="file-node-list search-results">
                {matches.map(node => (
                  <FileRow
                    key={node.id}
                    node={node}
                    depth={0}
                    expanded={false}
                    selected={selected?.id === node.id}
                    gitLabels={gitDecorations[node.displayPath] ?? []}
                    onToggle={toggleDirectory}
                    onSelect={node => void selectFile(node)}
                  />
                ))}
              </ul>
            </>
          ) : (
            <DirectoryTree
              parentId="workspace-root"
              depth={0}
              directories={directories}
              expanded={expanded}
              selectedId={selected?.id}
              gitDecorations={gitDecorations}
              onToggle={toggleDirectory}
              onSelect={node => void selectFile(node)}
              onLoadMore={parentId => void loadDirectory(parentId, true)}
            />
          )}
        </>
        <>
          {resourceNotice ? (
            <p className="resource-notice" role="status">
              {resourceNotice}
            </p>
          ) : null}
          {selected ? (
            <>
              <header>
                <strong>{selected.name}</strong>
                <span>{formatBytes(selected.sizeBytes ?? 0)}</span>
              </header>
              {contentError ? (
                <p className="resource-error" role="alert">
                  {contentError}
                </p>
              ) : binary ? (
                <div className="resource-empty">
                  <Icon name="code" />
                  <strong>二进制文件</strong>
                  <p>出于安全和性能考虑，只显示元数据。</p>
                </div>
              ) : (
                <>
                  <div className="file-preview-actions">
                    {editMode === 'view' ? (
                      <button
                        type="button"
                        className="text-button"
                        disabled={!editable}
                        title={editable ? undefined : '仅支持编辑 512 KB 内的 UTF-8 文本文件'}
                        onClick={beginEdit}
                      >
                        编辑
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="primary-button"
                          disabled={saving || draft === content}
                          onClick={() => void saveEdit()}
                        >
                          {saving ? '保存中…' : '保存'}
                        </button>
                        <button
                          type="button"
                          className="text-button"
                          disabled={saving}
                          onClick={cancelEdit}
                        >
                          取消
                        </button>
                      </>
                    )}
                  </div>
                  {conflict ? (
                    <p className="resource-error" role="alert">
                      文件已在别处变更，保存被拒绝。
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => void selectFile(selected, false, true)}
                      >
                        重新加载
                      </button>
                    </p>
                  ) : null}
                  {editMode === 'edit' ? (
                    <textarea
                      className="file-editor"
                      value={draft}
                      spellCheck={false}
                      aria-label={`编辑文件 ${selected.name}`}
                      onChange={event => setDraft(event.target.value)}
                      onKeyDown={event => {
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          cancelEdit();
                        }
                      }}
                    />
                  ) : (
                    <pre
                      tabIndex={0}
                      className="file-code-view"
                      aria-label={`文件内容 ${selected.name}`}
                    >
                      {sanitizeDisplayText(content)}
                    </pre>
                  )}
                </>
              )}
              {contentCursor && editMode === 'view' ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void selectFile(selected, true)}
                >
                  加载更多内容
                </button>
              ) : null}
            </>
          ) : (
            <div className="resource-empty">
              <Icon name="workspace" />
              <strong>选择文件预览</strong>
              <p>敏感文件、工作区外链接和二进制正文不会返回浏览器。</p>
            </div>
          )}
        </>
      </ResourceSplitLayout>
    </div>
  );
}

function DirectoryTree({
  parentId,
  depth,
  directories,
  expanded,
  selectedId,
  gitDecorations,
  onToggle,
  onSelect,
  onLoadMore,
}: {
  readonly parentId: string;
  readonly depth: number;
  readonly directories: Readonly<Record<string, DirectoryPage>>;
  readonly expanded: ReadonlySet<string>;
  readonly selectedId?: string;
  readonly gitDecorations: GitDecorations;
  readonly onToggle: (nodeId: string) => void;
  readonly onSelect: (node: WebFileNodeV1) => void;
  readonly onLoadMore: (parentId: string) => void;
}) {
  const page = directories[parentId];
  if (!page) return <p className="resource-loading">正在读取…</p>;
  if (page.error)
    return (
      <p className="resource-error" role="alert">
        {page.error}
      </p>
    );
  return (
    <ul role="list" className="file-node-list">
      {page.items.map(node => {
        const open = expanded.has(node.id);
        return (
          <li key={node.id}>
            <FileRow
              node={node}
              depth={depth}
              expanded={open}
              selected={selectedId === node.id}
              gitLabels={gitDecorations[node.displayPath] ?? []}
              onToggle={onToggle}
              onSelect={onSelect}
            />
            {isDirectoryLike(node) && open ? (
              <DirectoryTree
                parentId={node.id}
                depth={depth + 1}
                directories={directories}
                expanded={expanded}
                selectedId={selectedId}
                gitDecorations={gitDecorations}
                onToggle={onToggle}
                onSelect={onSelect}
                onLoadMore={onLoadMore}
              />
            ) : null}
          </li>
        );
      })}
      {page.loading ? <li className="resource-loading">正在读取…</li> : null}
      {page.nextCursor ? (
        <li>
          <button type="button" className="text-button" onClick={() => onLoadMore(parentId)}>
            加载更多
          </button>
        </li>
      ) : null}
    </ul>
  );
}

function FileRow({
  node,
  depth,
  expanded,
  selected,
  gitLabels,
  onToggle,
  onSelect,
}: {
  readonly node: WebFileNodeV1;
  readonly depth: number;
  readonly expanded: boolean;
  readonly selected: boolean;
  readonly gitLabels: readonly string[];
  readonly onToggle: (nodeId: string) => void;
  readonly onSelect: (node: WebFileNodeV1) => void;
}) {
  const blocked = node.sensitive || !node.readable;
  const directoryLike = isDirectoryLike(node);
  return (
    <button
      type="button"
      className={`file-node ${selected ? 'selected' : ''} ${blocked ? 'blocked' : ''}`}
      style={{ paddingInlineStart: `${8 + depth * 15}px` }}
      aria-expanded={directoryLike ? expanded : undefined}
      aria-label={`${fileKindLabel(node)} ${node.name}${blocked ? '，不可读取' : ''}${gitLabels.length ? `，Git ${gitLabels.join('、')}` : ''}`}
      onClick={() => (directoryLike ? onToggle(node.id) : onSelect(node))}
      disabled={blocked}
    >
      <Icon name={directoryLike ? 'workspace' : 'code'} size={14} />
      <span>{node.name}</span>
      {node.kind === 'symlink' ? <small>链接</small> : null}
      {node.sensitive ? <small>敏感</small> : null}
      {gitLabels.length ? (
        <small className="file-git-status" title={`Git ${gitLabels.join('、')}`}>
          {gitLabels.join(' · ')}
        </small>
      ) : null}
    </button>
  );
}

function fileKindLabel(node: WebFileNodeV1): string {
  if (node.kind === 'directory') return '目录';
  if (node.kind === 'symlink') return node.targetKind === 'directory' ? '符号链接目录' : '符号链接';
  return '文件';
}

function isDirectoryLike(node: WebFileNodeV1): boolean {
  return node.kind === 'directory' || (node.kind === 'symlink' && node.targetKind === 'directory');
}

function mergeNodes(
  current: readonly WebFileNodeV1[],
  next: readonly WebFileNodeV1[]
): readonly WebFileNodeV1[] {
  const byId = new Map(current.map(item => [item.id, item]));
  for (const item of next) byId.set(item.id, item);
  return [...byId.values()];
}

function buildGitDecorations(status: WebGitStatusV1): GitDecorations {
  if (!status.isRepository) return {};
  const decorations = new Map<string, Set<string>>();
  const add = (path: string, label: string) => {
    const normalized = path.replace(/\\/gu, '/').replace(/^\.\//u, '');
    if (!normalized) return;
    const labels = decorations.get(normalized) ?? new Set<string>();
    labels.add(label);
    decorations.set(normalized, labels);
    const segments = normalized.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join('/');
      const ancestorLabels = decorations.get(ancestor) ?? new Set<string>();
      ancestorLabels.add('含变更');
      decorations.set(ancestor, ancestorLabels);
    }
  };
  status.conflicted.forEach(file => add(file.path, '冲突'));
  status.staged.forEach(file => add(file.path, '已暂存'));
  status.unstaged.forEach(file => add(file.path, '未暂存'));
  status.untracked.forEach(file => add(file.path, '未跟踪'));
  return Object.fromEntries(
    [...decorations].map(([path, labels]) => [path, Object.freeze([...labels])])
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof WebApiError && error.code === 'file_revision_conflict';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : '文件请求失败。';
}
