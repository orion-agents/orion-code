/**
 * v0.3.16 — confirmation card shown after a directory has been inspected.
 *
 * Selecting a folder never switches workspace on its own: the card surfaces the
 * canonical path, the Git/Folder kind and availability, and the user must press
 * "打开项目" to enter the existing activation flow.
 */
import type { WebWorkspaceCandidateV1 } from '../../types';

const AVAILABILITY_LABEL: Record<WebWorkspaceCandidateV1['availability'], string> = {
  available: '可用',
  missing: '目录不存在',
  not_directory: '不是文件夹',
  unreadable: '无法读取',
};

export interface WorkspaceConfirmCardProps {
  readonly candidate: WebWorkspaceCandidateV1;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onOpen: () => void;
}

export function WorkspaceConfirmCard({
  candidate,
  busy,
  error,
  onCancel,
  onOpen,
}: WorkspaceConfirmCardProps) {
  const openable = candidate.availability === 'available' && !candidate.isActive;
  const actionLabel = candidate.isActive
    ? '当前项目'
    : candidate.availability !== 'available'
      ? '不可打开'
      : busy
        ? '正在打开…'
        : '打开项目';
  return (
    <section className="workspace-confirm" aria-label="已选择本地项目">
      <header className="workspace-confirm-head">
        <span className="workspace-confirm-name" title={candidate.canonicalPath}>
          {candidate.label}
        </span>
        <span className="workspace-confirm-meta">
          {candidate.kind === 'git' ? 'Git 项目' : '本地文件夹'} ·{' '}
          {AVAILABILITY_LABEL[candidate.availability]}
          {typeof candidate.sessionCount === 'number' ? ` · ${candidate.sessionCount} 个会话` : ''}
        </span>
      </header>
      <p className="workspace-confirm-path">{candidate.canonicalPath}</p>
      <p className="workspace-confirm-note">已解析真实路径；此操作不会读取目录外的文件。</p>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <footer className="workspace-confirm-actions">
        <button type="button" className="text-button" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button
          type="button"
          className="primary-button"
          onClick={onOpen}
          disabled={busy || !openable}
          aria-busy={busy}
        >
          {actionLabel}
        </button>
      </footer>
    </section>
  );
}
