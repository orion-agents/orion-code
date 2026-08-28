import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';

import type { WebSessionSummaryV1, WorkbenchState } from '../types';
import { Icon } from './Icon';
import { basename, sessionTitle } from './WorkspaceRail';

interface DialogFrameProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly labelledBy: string;
  readonly describedBy?: string;
  readonly className?: string;
  readonly children: ReactNode;
}

function DialogFrame({
  open,
  onClose,
  labelledBy,
  describedBy,
  className = '',
  children,
}: DialogFrameProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const onBackdropClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <dialog
      ref={ref}
      className={`modal ${className}`.trim()}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onCancel={event => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      onClick={onBackdropClick}
    >
      {children}
    </dialog>
  );
}

export interface WorkspaceDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly state: WorkbenchState;
  readonly onSelect: (path: string) => Promise<void>;
}

export function WorkspaceDialog({ open, onClose, state, onSelect }: WorkspaceDialogProps) {
  const [path, setPath] = useState('');
  const [localError, setLocalError] = useState('');
  useEffect(() => {
    if (!open) return;
    setPath('');
    setLocalError('');
  }, [open]);

  const select = async (next: string) => {
    if (!next.trim() || next === state.workspace) return;
    setLocalError('');
    try {
      await onSelect(next.trim());
      onClose();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : '工作区切换失败。');
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void select(path);
  };

  return (
    <DialogFrame
      open={open}
      onClose={onClose}
      labelledBy="workspace-dialog-title"
      describedBy="workspace-dialog-description"
      className="workspace-modal"
    >
      <div className="modal-header">
        <div>
          <span className="eyebrow">LOCAL WORKSPACE</span>
          <h2 id="workspace-dialog-title">选择工作区</h2>
          <p id="workspace-dialog-description">Host 会解析真实路径并拒绝无效目录。</p>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="关闭工作区选择">
          <Icon name="close" />
        </button>
      </div>
      <div className="workspace-options" role="group" aria-label="已知工作区">
        {state.workspaces.map(workspace => (
          <button
            type="button"
            className={`workspace-option ${workspace === state.workspace ? 'active' : ''}`}
            key={workspace}
            disabled={workspace === state.workspace || Boolean(state.pendingAction)}
            onClick={() => void select(workspace)}
          >
            <span className="workspace-icon">
              <Icon name="workspace" size={17} />
            </span>
            <span>
              <strong>{basename(workspace)}</strong>
              <small title={workspace}>{workspace}</small>
            </span>
            {workspace === state.workspace ? (
              <span className="current-pill">当前</span>
            ) : (
              <Icon name="chevron" size={15} />
            )}
          </button>
        ))}
      </div>
      <form className="workspace-path-form" onSubmit={submit}>
        <label htmlFor="workspace-path-input">打开其他本地目录</label>
        <div className="path-input-row">
          <input
            id="workspace-path-input"
            value={path}
            onChange={event => setPath(event.target.value)}
            placeholder="/Users/name/project"
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="submit"
            className="primary-button"
            disabled={!path.trim() || Boolean(state.pendingAction)}
          >
            打开
          </button>
        </div>
        {localError ? (
          <p className="field-error" role="alert">
            {localError}
          </p>
        ) : null}
      </form>
    </DialogFrame>
  );
}

export interface RenameDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly session: WebSessionSummaryV1 | null;
  readonly pending: boolean;
  readonly onRename: (sessionId: string, name: string) => Promise<void>;
}

export function RenameDialog({ open, onClose, session, pending, onRename }: RenameDialogProps) {
  const [name, setName] = useState('');
  useEffect(() => {
    if (open && session) setName(sessionTitle(session));
  }, [open, session]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!session || !name.trim()) return;
    try {
      await onRename(session.id, name.trim());
      onClose();
    } catch {
      // A persistent notice carries the server error.
    }
  };
  return (
    <DialogFrame open={open} onClose={onClose} labelledBy="rename-title" className="rename-modal">
      <form onSubmit={submit}>
        <header className="modal-header">
          <div>
            <span className="eyebrow">SESSION</span>
            <h2 id="rename-title">重命名会话</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="关闭重命名窗口"
          >
            <Icon name="close" />
          </button>
        </header>
        <div className="rename-body">
          <label htmlFor="session-name">会话名称</label>
          <input
            id="session-name"
            value={name}
            onChange={event => setName(event.target.value)}
            maxLength={120}
            autoFocus
          />
        </div>
        <footer className="modal-footer">
          <button type="button" className="secondary-button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary-button" disabled={pending || !name.trim()}>
            {pending ? '保存中…' : '保存'}
          </button>
        </footer>
      </form>
    </DialogFrame>
  );
}
