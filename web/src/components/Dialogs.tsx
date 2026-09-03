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
  readonly onLoadMore: () => Promise<void>;
}

export function WorkspaceDialog({
  open,
  onClose,
  state,
  onSelect,
  onLoadMore,
}: WorkspaceDialogProps) {
  const [path, setPath] = useState('');
  const [localError, setLocalError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showAllWorkspaces, setShowAllWorkspaces] = useState(false);
  useEffect(() => {
    if (!open) return;
    setPath('');
    setLocalError('');
    setBusy(false);
    setShowAllWorkspaces(false);
  }, [open]);

  const locked = Boolean(state.pendingAction) || busy;
  const suggested = state.workspaces.slice(0, 3);
  const remaining = state.workspaces.slice(3);

  const select = async (next: string) => {
    const target = next.trim();
    if (!target) return;
    // v0.3.7: validate before the round-trip so the user gets actionable feedback
    // instead of a silent no-op.
    if (target === state.workspace) {
      setLocalError('该目录已经是当前工作区。');
      return;
    }
    setLocalError('');
    setBusy(true);
    try {
      await onSelect(target);
      onClose();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : '工作区切换失败。');
    } finally {
      setBusy(false);
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
          <h2 id="workspace-dialog-title">打开或新增项目</h2>
          <p id="workspace-dialog-description">
            选择一个本地目录作为项目；Host 会解析真实路径并拒绝无效目录。
          </p>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="关闭工作区选择">
          <Icon name="close" />
        </button>
      </div>
      <div className="workspace-options" role="group" aria-label="常用工作区">
        {suggested.map(workspace => (
          <WorkspaceOption
            key={workspace.id}
            workspace={workspace}
            locked={locked}
            onSelect={select}
          />
        ))}
        {remaining.length > 0 ? (
          <>
            <button
              type="button"
              className="text-button workspace-toggle-all"
              aria-expanded={showAllWorkspaces}
              onClick={() => setShowAllWorkspaces(value => !value)}
            >
              {showAllWorkspaces ? '收起其他工作区' : `其他工作区（${remaining.length}）`}
            </button>
            {showAllWorkspaces
              ? remaining.map(workspace => (
                  <WorkspaceOption
                    key={workspace.id}
                    workspace={workspace}
                    locked={locked}
                    onSelect={select}
                  />
                ))
              : null}
          </>
        ) : null}
        {state.workspaceNextCursor ? (
          <button
            type="button"
            className="text-button"
            onClick={() => void onLoadMore()}
            disabled={locked}
          >
            加载更多工作区
          </button>
        ) : null}
      </div>
      <form className="workspace-path-form" onSubmit={submit}>
        <label htmlFor="workspace-path-input">打开其他本地目录</label>
        <div className="path-input-row">
          <input
            id="workspace-path-input"
            value={path}
            onChange={event => {
              setPath(event.target.value);
              if (localError) setLocalError('');
            }}
            placeholder="/Users/name/project"
            spellCheck={false}
            autoComplete="off"
          />
          <button type="submit" className="primary-button" disabled={!path.trim() || locked}>
            {busy ? '打开中…' : '打开'}
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

function WorkspaceOption({
  workspace,
  locked,
  onSelect,
}: {
  readonly workspace: WorkbenchState['workspaces'][number];
  readonly locked: boolean;
  readonly onSelect: (path: string) => Promise<void>;
}) {
  return (
    <button
      type="button"
      className={`workspace-option ${workspace.active ? 'active' : ''}`}
      disabled={workspace.active || !workspace.available || locked}
      onClick={() => void onSelect(workspace.path)}
    >
      <span className="workspace-icon">
        <Icon name="workspace" size={17} />
      </span>
      <span>
        <strong>{workspace.label || basename(workspace.path)}</strong>
        <small title={workspace.path}>{workspace.path}</small>
      </span>
      {workspace.active ? (
        <span className="current-pill">当前</span>
      ) : !workspace.available ? (
        <span className="current-pill">不可用</span>
      ) : (
        <Icon name="chevron" size={15} />
      )}
    </button>
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
  const [error, setError] = useState('');
  const sessionId = session?.id;
  useEffect(() => {
    if (open && session) {
      setName(sessionTitle(session));
      setError('');
    }
    // Reinitialize when the dialog opens or targets a different Session. Live
    // Session summary refreshes must not overwrite text the user is editing.
  }, [open, sessionId]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!session || !name.trim()) return;
    setError('');
    try {
      await onRename(session.id, name.trim());
      onClose();
    } catch (cause) {
      // v0.3.7: never fail silently — the user must see why the rename failed.
      setError(cause instanceof Error ? cause.message : '重命名失败，请重试。');
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
            onChange={event => {
              setName(event.target.value);
              if (error) setError('');
            }}
            maxLength={120}
            autoFocus
          />
          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}
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

export interface SessionTagsDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly session: WebSessionSummaryV1 | null;
  readonly pending: boolean;
  readonly onSave: (sessionId: string, tags: readonly string[]) => Promise<void>;
}

const SESSION_TAG_LIMIT = 8;

/** v0.3.7 — Manage a Session's tag chips (add via Enter/comma, remove per chip). */
export function SessionTagsDialog({
  open,
  onClose,
  session,
  pending,
  onSave,
}: SessionTagsDialogProps) {
  const [tags, setTags] = useState<readonly string[]>(() =>
    session?.tags ? [...session.tags] : []
  );
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const sessionId = session?.id;
  useEffect(() => {
    if (open && session) {
      setTags(session.tags ?? []);
      setInput('');
      setError('');
    }
  }, [open, sessionId]);

  const addCandidate = () => {
    const candidate = input.trim().slice(0, 32);
    setInput('');
    if (!candidate) return;
    if (tags.includes(candidate)) return;
    if (tags.length >= SESSION_TAG_LIMIT) {
      setError(`最多 ${SESSION_TAG_LIMIT} 个标签。`);
      return;
    }
    setTags([...tags, candidate]);
    setError('');
  };

  const removeTag = (tag: string) => setTags(tags.filter(value => value !== tag));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!session) return;
    setError('');
    try {
      await onSave(session.id, tags);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存标签失败，请重试。');
    }
  };

  return (
    <DialogFrame
      open={open}
      onClose={onClose}
      labelledBy="session-tags-title"
      className="tags-modal"
    >
      <form onSubmit={submit}>
        <header className="modal-header">
          <div>
            <span className="eyebrow">SESSION</span>
            <h2 id="session-tags-title">管理会话标签</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭标签窗口">
            <Icon name="close" />
          </button>
        </header>
        <div className="session-tags-body">
          {session ? <p className="modal-description">{sessionTitle(session)}</p> : null}
          <div className="session-tags-chips" role="list" aria-label="当前标签">
            {tags.length === 0 ? (
              <span className="session-tags-empty">还没有标签，输入后回车添加。</span>
            ) : (
              tags.map(tag => (
                <span key={tag} className="session-tag-chip" role="listitem">
                  {tag}
                  <button
                    type="button"
                    className="icon-button session-tag-remove"
                    aria-label={`移除标签 ${tag}`}
                    onClick={() => removeTag(tag)}
                  >
                    <Icon name="close" size={11} />
                  </button>
                </span>
              ))
            )}
          </div>
          <label htmlFor="session-tag-input">新标签</label>
          <input
            id="session-tag-input"
            value={input}
            onChange={event => {
              setInput(event.target.value);
              if (error) setError('');
            }}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault();
                addCandidate();
              } else if (event.key === ',' || event.key === '，') {
                event.preventDefault();
                addCandidate();
              }
            }}
            placeholder="回车或逗号添加"
            maxLength={32}
            autoFocus
          />
          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <footer className="modal-footer">
          <button type="button" className="secondary-button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary-button" disabled={pending}>
            {pending ? '保存中…' : '保存'}
          </button>
        </footer>
      </form>
    </DialogFrame>
  );
}

export interface ConfirmDeleteSessionDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly session: WebSessionSummaryV1 | null;
  readonly pending: boolean;
  readonly onConfirm: (sessionId: string) => Promise<void>;
}

/** v0.3.7 — Irreversible action guard: full confirmation before deleting a Session. */
export function ConfirmDeleteSessionDialog({
  open,
  onClose,
  session,
  pending,
  onConfirm,
}: ConfirmDeleteSessionDialogProps) {
  const confirm = async () => {
    if (!session) return;
    try {
      await onConfirm(session.id);
      onClose();
    } catch {
      // A persistent notice carries the server error; keep the dialog open.
    }
  };

  return (
    <DialogFrame
      open={open}
      onClose={onClose}
      labelledBy="confirm-delete-title"
      describedBy="confirm-delete-description"
      className="delete-modal"
    >
      <div className="modal-header">
        <div>
          <span className="eyebrow">SESSION</span>
          <h2 id="confirm-delete-title">删除会话</h2>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="关闭删除确认">
          <Icon name="close" />
        </button>
      </div>
      <p id="confirm-delete-description" className="confirm-delete-body">
        将永久删除会话
        <strong>{session ? `「${sessionTitle(session)}」` : ''}</strong>
        及其全部记录（消息、文件变更、目标与检查点）。此操作不可恢复。
      </p>
      <footer className="modal-footer">
        <button type="button" className="secondary-button" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="danger-button"
          disabled={pending}
          onClick={() => void confirm()}
        >
          {pending ? '删除中…' : '永久删除'}
        </button>
      </footer>
    </DialogFrame>
  );
}
