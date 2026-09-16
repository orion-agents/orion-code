/**
 * v0.3.17 S5 — branch / version comparison view (plan G5).
 *
 * Request semantics: the comparison only runs when the reader presses the button (or Enter) —
 * changing a selector never fires a query. The opened result is frozen against the resolved
 * OIDs it shows, and "重新比较" is the only thing that replaces it, so a ref that moves cannot
 * silently re-point an open comparison at a different tree.
 */
import { useMemo, useState } from 'react';

import type {
  GitCompareFileV1,
  GitCompareModeV1,
  GitCompareResultV1,
  GitDiffDocumentV2,
  GitRefsV1,
} from '../../types';
import type { GitDiffMode } from '../../state/git-panel-state';
import type { WorkbenchActions } from '../../useWorkbench';
import { StructuredDiffViewer } from './StructuredDiffViewer';
import { Icon } from '../Icon';

const MODE_LABELS: Readonly<Record<GitCompareModeV1, string>> = Object.freeze({
  snapshot: '两端快照 A → B',
  'merge-base': '共同祖先 → B',
});

export function GitCompareView({
  refs,
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
  readonly refs: GitRefsV1 | null;
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
  const options = useMemo(() => buildRefOptions(refs), [refs]);
  const defaultBase = options.find(option => option.isBranch)?.value ?? options[0]?.value ?? '';
  const defaultHead = refs?.refs.find(ref => ref.isHead)?.shortName ?? defaultBase;

  const [baseRef, setBaseRef] = useState(defaultBase);
  const [headRef, setHeadRef] = useState(defaultHead);
  const [mode, setMode] = useState<GitCompareModeV1>('snapshot');
  const [result, setResult] = useState<GitCompareResultV1 | null>(null);
  const [diff, setDiff] = useState<GitDiffDocumentV2 | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = () => {
    if (!baseRef || !headRef || busy) return;
    setBusy(true);
    setError('');
    void (async () => {
      try {
        const next = await actions.gitCompare({ baseRef, headRef, mode });
        setResult(next);
        setDiff(null);
      } catch (caught) {
        setError(messageOf(caught));
      } finally {
        setBusy(false);
      }
    })();
  };

  const openFile = (file: GitCompareFileV1) => {
    if (!result || file.sensitive || busy) return;
    setBusy(true);
    setError('');
    void (async () => {
      try {
        const document = await actions.gitCompareFileDiff({
          baseOid: result.baseOid,
          headOid: result.headOid,
          path: file.path,
        });
        setDiff(document);
      } catch (caught) {
        setError(messageOf(caught));
      } finally {
        setBusy(false);
      }
    })();
  };

  if (options.length === 0) {
    return (
      <div className="resource-empty">
        <Icon name="branch" size={16} />
        <strong>没有可比较的 ref</strong>
        <p>这个仓库还没有分支或标签。</p>
      </div>
    );
  }

  return (
    <div className="git-compare" aria-label="分支与版本比较">
      <div className="git-compare-form">
        <label>
          <span>基准 A</span>
          <select value={baseRef} aria-label="选择基准 A" onChange={event => setBaseRef(event.target.value)}>
            {options.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>目标 B</span>
          <select value={headRef} aria-label="选择目标 B" onChange={event => setHeadRef(event.target.value)}>
            {options.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>模式</span>
          <select
            value={mode}
            aria-label="选择比较模式"
            onChange={event => setMode(event.target.value as GitCompareModeV1)}
          >
            {(Object.keys(MODE_LABELS) as readonly GitCompareModeV1[]).map(value => (
              <option key={value} value={value}>
                {MODE_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="primary-button"
          disabled={busy || baseRef === headRef}
          aria-busy={busy}
          onClick={run}
        >
          {busy ? '比较中…' : '比较'}
        </button>
      </div>

      <p className="git-compare-hint">
        修改选择不会立即发起查询；点「比较」或按 Enter 才执行。交换 A/B 后会取消旧的请求。
      </p>

      {error ? (
        <p className="resource-error" role="alert">
          {error}
        </p>
      ) : null}

      {result ? (
        <>
          {/* The comparison is stated, never implied: which commits were actually used. */}
          <p className="git-compare-range">
            {result.baseLabel} <code>{result.baseOid.slice(0, 10)}</code> → {result.headLabel}{' '}
            <code>{result.headOid.slice(0, 10)}</code>
            {result.truncated ? ' · 文件列表已截断' : ''}
          </p>
          <p className="git-compare-range">
            {result.files.length} 个文件 ·<em className="diff-stat-add"> +{result.additions}</em>
            <em className="diff-stat-del"> -{result.deletions}</em>
            <button type="button" className="text-button" onClick={run} disabled={busy}>
              重新比较
            </button>
          </p>
          <ul className="git-compare-files">
            {result.files.map(file => (
              <li key={`${file.renamedFrom ?? ''}:${file.path}`}>
                <button
                  type="button"
                  className={diff?.path === file.path ? 'selected' : ''}
                  aria-current={diff?.path === file.path ? 'true' : undefined}
                  disabled={file.sensitive}
                  onClick={() => openFile(file)}
                >
                  <span className="git-commit-file-stats">
                    {file.binary ? 'bin' : `+${file.additions} -${file.deletions}`}
                  </span>
                  <span title={file.path}>
                    {file.renamedFrom ? `${file.renamedFrom} → ${file.path}` : file.path}
                  </span>
                  {file.sensitive ? <em className="git-sensitive-badge">受保护</em> : null}
                </button>
              </li>
            ))}
          </ul>

          {diff ? (
            <StructuredDiffViewer
              document={diff}
              mode={display.mode}
              wrap={display.wrap}
              showWhitespace={display.showWhitespace}
              collapsedHunks={collapsedHunks}
              anchorLineId={anchorLineId}
              loading={busy}
              onChangeMode={value => onDisplayChange({ mode: value })}
              onToggleWrap={() => onDisplayChange({ wrap: !display.wrap })}
              onToggleWhitespace={() => onDisplayChange({ showWhitespace: !display.showWhitespace })}
              onToggleHunk={onToggleHunk}
              onSetAllFolded={onSetAllFolded}
              onAnchorChange={onAnchorChange}
              onNotice={onNotice}
              onSendToComposer={onSendToComposer}
            />
          ) : (
            <p className="git-compare-hint">点一个文件查看该比较下的 Diff。</p>
          )}
        </>
      ) : null}
    </div>
  );
}

function buildRefOptions(refs: GitRefsV1 | null): readonly {
  readonly value: string;
  readonly label: string;
  readonly isBranch: boolean;
}[] {
  if (!refs) return [];
  return refs.refs.map(ref =>
    Object.freeze({
      value: ref.shortName,
      label:
        ref.kind === 'branch'
          ? ref.shortName
          : `${ref.shortName}（${ref.kind === 'tag' ? 'tag' : ref.kind === 'remote' ? '远程' : '其他'}）`,
      isBranch: ref.kind === 'branch',
    })
  );
}

function messageOf(error: unknown): string {
  const code = (error as { readonly code?: string } | undefined)?.code;
  if (code === 'git_merge_base_multiple') {
    return '这两个 ref 有多个共同祖先，没有唯一分叉点；请改用「两端快照」模式。';
  }
  if (code === 'git_merge_base_missing') {
    return '两个 ref 没有共同祖先，无法用「共同祖先」模式；请改用「两端快照」模式。';
  }
  if (code === 'git_shallow_history') {
    return '仓库缺少完成该比较所需的对象（浅克隆？）。';
  }
  if (code === 'git_ref_not_found') {
    return '所选 ref 无法解析为提交。';
  }
  return error instanceof Error ? error.message : '比较失败。';
}
