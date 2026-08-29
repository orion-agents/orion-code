import { useEffect, useMemo, useRef, useState } from 'react';

import { WebApiError } from '../../api';
import type { WebFileNodeV1, WebGitStatusV1 } from '../../types';
import type { WorkbenchActions } from '../../useWorkbench';
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
}: {
  readonly workspaceId: string;
  readonly refreshEpoch: number;
  readonly actions: WorkbenchActions;
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
  const [wrapLines, setWrapLines] = useState(false);
  const [targetLine, setTargetLine] = useState('1');
  const [gitDecorations, setGitDecorations] = useState<GitDecorations>({});
  const [gitDecorationNotice, setGitDecorationNotice] = useState('');
  const previewRef = useRef<HTMLPreElement>(null);
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
    if (!node.readable || node.sensitive || node.kind === 'directory') return;
    contentRequestRef.current = request;
    setSelected(node);
    setContentError('');
    if (!append) {
      setContent('');
      setContentCursor(null);
      setBinary(false);
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

      <div className="files-layout">
        <section className="file-tree" aria-label="工作区文件">
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
        </section>

        <section className="file-preview" aria-label="文件预览">
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
                    <label>
                      <span className="sr-only">跳到行</span>
                      <input
                        type="number"
                        min="1"
                        value={targetLine}
                        aria-label="跳到行"
                        onChange={event => setTargetLine(event.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => scrollToLine(previewRef.current, targetLine)}
                    >
                      跳转
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => void copyText(content, setResourceNotice)}
                    >
                      复制
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      aria-pressed={wrapLines}
                      onClick={() => setWrapLines(value => !value)}
                    >
                      自动换行
                    </button>
                  </div>
                  <pre
                    ref={previewRef}
                    tabIndex={0}
                    className={`file-code-view ${wrapLines ? 'wrap' : ''}`}
                    aria-label={`文件内容 ${selected.name}`}
                  >
                    {sanitizeDisplayText(content)
                      .split('\n')
                      .map((line, index) => (
                        <span className="file-code-line" data-line={index + 1} key={index}>
                          <span className="file-line-number" aria-hidden="true">
                            {index + 1}
                          </span>
                          <span className="file-line-content">{line || ' '}</span>
                        </span>
                      ))}
                  </pre>
                </>
              )}
              {contentCursor ? (
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
        </section>
      </div>
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
            {node.kind === 'directory' && open ? (
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
  return (
    <button
      type="button"
      className={`file-node ${selected ? 'selected' : ''} ${blocked ? 'blocked' : ''}`}
      style={{ paddingInlineStart: `${8 + depth * 15}px` }}
      aria-expanded={node.kind === 'directory' ? expanded : undefined}
      aria-label={`${fileKindLabel(node.kind)} ${node.name}${blocked ? '，不可读取' : ''}${gitLabels.length ? `，Git ${gitLabels.join('、')}` : ''}`}
      onClick={() => (node.kind === 'directory' ? onToggle(node.id) : onSelect(node))}
      disabled={blocked}
    >
      <Icon name={node.kind === 'directory' ? 'workspace' : 'code'} size={14} />
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

function fileKindLabel(kind: WebFileNodeV1['kind']): string {
  if (kind === 'directory') return '目录';
  if (kind === 'symlink') return '符号链接';
  return '文件';
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

function scrollToLine(preview: HTMLPreElement | null, rawLine: string): void {
  const line = Number(rawLine);
  if (!preview || !Number.isSafeInteger(line) || line < 1) return;
  preview.querySelector<HTMLElement>(`[data-line="${line}"]`)?.scrollIntoView({
    block: 'center',
  });
  preview.focus();
}

async function copyText(content: string, announce: (message: string) => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(content);
    announce('已复制当前加载的文件内容。');
  } catch {
    announce('浏览器未允许复制，请手动选择文本。');
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : '文件请求失败。';
}
