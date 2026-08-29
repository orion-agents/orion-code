import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';

import type { WebGitDiffPageV1 } from '../../types';
import { Icon } from '../Icon';
import { buildReviewContext, splitHunks } from './diff-hunks';

export interface DiffViewerProps {
  readonly page: WebGitDiffPageV1;
  readonly loading?: boolean;
  readonly onLoadMore?: () => void;
  readonly onSendToComposer?: (text: string) => void;
}

export function DiffViewer({
  page,
  loading = false,
  onLoadMore,
  onSendToComposer,
}: DiffViewerProps) {
  const hunks = useMemo(() => splitHunks(page.lines), [page.lines]);
  const [selected, setSelected] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [showWhitespace, setShowWhitespace] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const activeIndex = Math.min(selected, Math.max(0, hunks.length - 1));
  const active = hunks[activeIndex];

  useEffect(() => {
    setSelected(0);
    setCollapsed(false);
    setCopyStatus('');
  }, [page.fileId, page.repositoryRevision]);

  const moveSelection = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % hunks.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      next = (index - 1 + hunks.length) % hunks.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = hunks.length - 1;
    else return;
    event.preventDefault();
    setSelected(next);
    const tablist = event.currentTarget.parentElement;
    window.requestAnimationFrame(() =>
      tablist?.querySelector<HTMLButtonElement>(`[data-hunk-index="${next}"]`)?.focus()
    );
  };

  if (page.binary) {
    return (
      <div className="resource-empty compact">
        <Icon name="code" />
        <strong>二进制差异</strong>
        <p>只展示变更事实，不返回 binary patch。</p>
      </div>
    );
  }

  return (
    <div className="diff-viewer">
      <header>
        <strong title={page.path}>{page.path}</strong>
        <span>{page.truncated ? '受限预览' : `${page.lines.length} 行`}</span>
      </header>
      {hunks.length > 1 ? (
        <div className="diff-hunk-nav" role="tablist" aria-label="Diff hunks">
          {hunks.map((hunk, index) => (
            <button
              key={`${hunk.title}-${index}`}
              type="button"
              role="tab"
              data-hunk-index={index}
              aria-selected={activeIndex === index}
              tabIndex={activeIndex === index ? 0 : -1}
              onClick={() => setSelected(index)}
              onKeyDown={event => moveSelection(event, index)}
            >
              {hunk.title || `Hunk ${index + 1}`}
            </button>
          ))}
        </div>
      ) : null}
      <div className="diff-actions" aria-label="Diff 显示选项">
        {active ? (
          <button
            type="button"
            className="text-button"
            aria-expanded={!collapsed}
            onClick={() => setCollapsed(value => !value)}
          >
            {collapsed ? '展开 Hunk' : '折叠 Hunk'}
          </button>
        ) : null}
        <button
          type="button"
          className="text-button"
          aria-pressed={showWhitespace}
          onClick={() => setShowWhitespace(value => !value)}
        >
          显示空白字符
        </button>
        {active ? (
          <button
            type="button"
            className="text-button"
            onClick={() => void copyHunk(active.lines.join('\n'), setCopyStatus)}
          >
            复制 Hunk
          </button>
        ) : null}
      </div>
      {!collapsed ? (
        <pre className="diff-lines" tabIndex={0} aria-label={`Diff ${page.path}`}>
          {(active?.lines ?? page.lines).map((line, index) => (
            <span
              key={`${index}:${line}`}
              className={
                line.startsWith('+') ? 'addition' : line.startsWith('-') ? 'deletion' : ''
              }
            >
              {displayLine(line, showWhitespace) || ' '}
              {'\n'}
            </span>
          ))}
        </pre>
      ) : null}
      {copyStatus ? (
        <p className="resource-notice" role="status">
          {copyStatus}
        </p>
      ) : null}
      <footer>
        {onSendToComposer && active ? (
          <button
            type="button"
            className="secondary-button"
            onClick={() => onSendToComposer(buildReviewContext(page, active))}
          >
            发送此 Hunk 到对话
          </button>
        ) : null}
        {page.nextCursor && onLoadMore ? (
          <button type="button" className="text-button" onClick={onLoadMore} disabled={loading}>
            {loading ? '加载中…' : '加载更多 Diff'}
          </button>
        ) : null}
      </footer>
    </div>
  );
}

function displayLine(line: string, showWhitespace: boolean): string {
  if (!showWhitespace) return line;
  return line.replace(/\t/gu, '→\t').replace(/ +$/gu, spaces => '·'.repeat(spaces.length));
}

async function copyHunk(value: string, announce: (value: string) => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    announce('已复制当前 Hunk。');
  } catch {
    announce('浏览器未允许复制，请手动选择 Diff。');
  }
}
