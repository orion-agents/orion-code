/**
 * v0.3.17 S5 — conflict detail (plan G6).
 *
 * A conflicted file is NOT an ordinary staged diff, so it is not rendered as one. The four
 * versions come from the index stages and the working tree; a version that legitimately does
 * not exist (add/add has no base, modify/delete is missing one side) is labelled as absent
 * instead of being silently dropped, which is exactly what the plan requires.
 */
import { useEffect, useState } from 'react';

import type { GitConflictVersionsV1, GitFileVersionV1 } from '../../types';
import type { WorkbenchActions } from '../../useWorkbench';
import { Icon } from '../Icon';

const SHAPE_LABELS: Readonly<Record<GitConflictVersionsV1['shape'], string>> = Object.freeze({
  'both-modified': '双方都修改',
  'both-added': '双方都新增',
  'added-by-us': '我们新增 · 对方删除',
  'added-by-them': '对方新增 · 我们删除',
  'deleted-by-us': '我们删除 · 对方修改',
  'deleted-by-them': '对方删除 · 我们修改',
  'both-deleted': '双方都删除',
  other: '其他冲突形态',
});

const VERSION_LABELS: Readonly<Record<GitFileVersionV1['label'], string>> = Object.freeze({
  base: 'base（共同祖先）',
  ours: 'ours（当前分支）',
  theirs: 'theirs（合入分支）',
  worktree: '工作区文件',
  revision: '该版本',
});

export function GitConflictView({
  path,
  actions,
}: {
  readonly path: string;
  readonly actions: WorkbenchActions;
}) {
  const [data, setData] = useState<GitConflictVersionsV1 | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const result = await actions.gitConflictVersions(path);
        if (!cancelled) setData(result);
      } catch (caught) {
        if (!cancelled) {
          setData(null);
          setError(caught instanceof Error ? caught.message : '冲突详情读取失败。');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actions, path]);

  if (loading) return <p className="resource-loading">正在读取冲突版本…</p>;
  if (error) {
    return (
      <p className="resource-error" role="alert">
        {error}
      </p>
    );
  }
  if (!data) return null;

  const versions: readonly GitFileVersionV1[] = [data.base, data.ours, data.theirs, data.worktree];
  return (
    <section className="git-conflict" aria-label="冲突版本">
      <header className="git-conflict-header">
        <Icon name="warning" size={14} />
        <strong>{data.path}</strong>
        <em className="git-merge-badge">{SHAPE_LABELS[data.shape]}</em>
      </header>
      <p className="git-compare-hint">
        直接读 index 的 stage 1/2/3，不用普通暂存 Diff
        代替完整冲突视图。缺失的版本是这种冲突形态的正常结果。
      </p>
      <div className="git-conflict-grid">
        {versions.map(version => (
          <article key={version.label} className="git-conflict-version">
            <header>
              <span>{VERSION_LABELS[version.label]}</span>
              {version.exists ? (
                <code>{version.oid?.slice(0, 10)}</code>
              ) : (
                <em className="git-conflict-absent">此形态下不存在</em>
              )}
            </header>
            {!version.exists ? (
              <p className="git-conflict-note">没有这个版本。</p>
            ) : version.lfs ? (
              <p className="git-conflict-note">
                LFS 指针 · oid {version.lfs.oid.slice(0, 16)}…
                {version.lfs.size !== null ? ` · ${version.lfs.size} 字节（不下载对象）` : ''}
              </p>
            ) : version.binary ? (
              <p className="git-conflict-note">
                二进制内容（{version.byteSize} 字节），不在此处渲染。
              </p>
            ) : version.truncated ? (
              <p className="git-conflict-note">超过上限（{version.byteSize} 字节），未读取内容。</p>
            ) : (
              <pre className="git-conflict-content">{version.content ?? ''}</pre>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
