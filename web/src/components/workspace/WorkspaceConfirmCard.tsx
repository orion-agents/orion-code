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

/**
 * v0.3.17 — discrete stages replace the single "正在打开…" label, so the wait is
 * attributable. Only stages the Host actually reports are marked current; the
 * session stage is completed by the shell after this card closes.
 */
export type WorkspaceOpenStageLabelV1 = 'prepare' | 'runtime' | 'session';

const STAGE_ORDER: readonly WorkspaceOpenStageLabelV1[] = ['prepare', 'runtime', 'session'];

const STAGE_LABEL: Record<WorkspaceOpenStageLabelV1, string> = {
  prepare: '准备项目',
  runtime: '加载本地 Runtime',
  session: '恢复会话（如有）',
};

export interface WorkspaceConfirmCardProps {
  readonly candidate: WebWorkspaceCandidateV1;
  readonly busy: boolean;
  readonly stage?: WorkspaceOpenStageLabelV1;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onOpen: () => void;
}

export function WorkspaceConfirmCard({
  candidate,
  busy,
  stage = 'prepare',
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
  const activeIndex = STAGE_ORDER.indexOf(stage);
  return (
    <section className="workspace-confirm" aria-label="已选择本地项目">
      <header className="workspace-confirm-head">
        <span className="workspace-confirm-name" title={candidate.canonicalPath}>
          {candidate.label}
        </span>
        <span className="workspace-confirm-meta">
          {candidate.kind === 'git' ? 'Git 项目' : '本地文件夹'} ·{' '}
          {AVAILABILITY_LABEL[candidate.availability]}
          {typeof candidate.sessionCount === 'number'
            ? ` · ${candidate.sessionCount} 个会话`
            : candidate.sessionCountStatus === 'deferred'
              ? ' · 会话数读取中'
              : ''}
        </span>
      </header>
      <p className="workspace-confirm-path">{candidate.canonicalPath}</p>
      <p className="workspace-confirm-note">已解析真实路径；此操作不会读取目录外的文件。</p>
      {busy ? (
        <ol className="workspace-confirm-stages" aria-label="打开进度">
          {STAGE_ORDER.map((entry, index) => (
            <li
              key={entry}
              className="workspace-confirm-stage"
              aria-current={entry === stage ? 'step' : undefined}
              data-state={index < activeIndex ? 'done' : index === activeIndex ? 'current' : 'todo'}
            >
              {STAGE_LABEL[entry]}
            </li>
          ))}
        </ol>
      ) : null}
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
