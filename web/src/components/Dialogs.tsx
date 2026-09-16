import {
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';

import type {
  WebDirectoryPickResultV1,
  WebSessionSummaryV1,
  WebWorkspaceCandidateSourceV1,
  WebWorkspaceCandidateV1,
  WorkbenchState,
} from '../types';
import { Icon } from './Icon';
import { basename, sessionTitle } from './WorkspaceRail';
import { WorkspaceConfirmCard } from './workspace/WorkspaceConfirmCard';
import {
  initialWorkspacePickerState,
  workspacePickerBusy,
  workspacePickerReducer,
} from './workspace/workspace-picker-state';

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
  /** v0.3.16 — Host OS directory picker. Browse only: nothing activates. */
  readonly onPickDirectory: () => Promise<WebDirectoryPickResultV1>;
  /** v0.3.16 — read-only preview of a candidate directory. */
  readonly onInspect: (path: string) => Promise<WebWorkspaceCandidateV1>;
}

export function WorkspaceDialog({
  open,
  onClose,
  state,
  onSelect,
  onLoadMore,
  onPickDirectory,
  onInspect,
}: WorkspaceDialogProps) {
  const [path, setPath] = useState('');
  const [showAllWorkspaces, setShowAllWorkspaces] = useState(false);
  const [query, setQuery] = useState('');
  const [picker, dispatch] = useReducer(workspacePickerReducer, initialWorkspacePickerState);
  useEffect(() => {
    if (!open) return;
    setPath('');
    setShowAllWorkspaces(false);
    setQuery('');
    dispatch({ type: 'reset' });
  }, [open]);

  const pickerBusy = workspacePickerBusy(picker);
  const locked = Boolean(state.pendingAction) || pickerBusy;
  const confirming = picker.phase === 'confirm' || picker.phase === 'activate-pending';
  const activeCandidate = confirming ? picker.candidate : null;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchesQuery = (workspace: WorkbenchState['workspaces'][number]) =>
    !normalizedQuery ||
    workspace.label.toLocaleLowerCase().includes(normalizedQuery) ||
    workspace.path.toLocaleLowerCase().includes(normalizedQuery);
  const visible = state.workspaces.filter(matchesQuery);
  const pinned = visible.filter(workspace => workspace.pinnedOrder !== undefined);
  const recent = visible.filter(workspace => workspace.pinnedOrder === undefined);
  const RECENT_PREVIEW_COUNT = 3;
  const shownRecent = showAllWorkspaces ? recent : recent.slice(0, RECENT_PREVIEW_COUNT);
  const hiddenRecent = recent.length - shownRecent.length;
  const hasWorkspaces = pinned.length > 0 || recent.length > 0;

  /**
   * v0.3.16 — inspect a candidate without activating it. Used by every entry
   * point; the user still has to confirm on the card before any workspace
   * transition happens.
   */
  const inspectPath = async (candidatePath: string, source: WebWorkspaceCandidateSourceV1) => {
    dispatch({ type: 'inspect-started', path: candidatePath });
    try {
      const candidate = await onInspect(candidatePath);
      dispatch({ type: 'inspect-succeeded', candidate: { ...candidate, source } });
    } catch (error) {
      dispatch({
        type: 'failed',
        message: error instanceof Error ? error.message : '无法读取该目录。',
      });
    }
  };

  const chooseFolder = async () => {
    dispatch({ type: 'picker-started' });
    try {
      const result = await onPickDirectory();
      if (result.outcome === 'cancelled') {
        dispatch({ type: 'picker-cancelled' });
        return;
      }
      if (result.outcome !== 'selected' || !result.path) {
        dispatch({
          type: 'picker-unavailable',
          reason: '系统目录选择器不可用，请在高级选项中粘贴绝对路径。',
        });
        return;
      }
      await inspectPath(result.path, 'picker');
    } catch (error) {
      dispatch({
        type: 'picker-unavailable',
        reason: error instanceof Error ? error.message : '无法打开系统目录选择器。',
      });
    }
  };

  const openCandidate = async (candidate: WebWorkspaceCandidateV1) => {
    // Only here — after an inspected candidate has been confirmed — do we enter
    // the existing activation flow.
    dispatch({ type: 'activate-started' });
    try {
      await onSelect(candidate.canonicalPath);
      onClose();
    } catch (error) {
      dispatch({
        type: 'failed',
        message: error instanceof Error ? error.message : '工作区切换失败。',
      });
    }
  };

  /**
   * v0.3.17 — pinned/recent rows use the same inspect → confirm → activate
   * contract as the Finder and advanced paths. They are inspected rather than
   * activated directly so availability and the Git/Folder kind are always
   * re-checked, and nothing switches without an explicit confirmation.
   */
  const openListedWorkspace = (workspace: WorkbenchState['workspaces'][number]) => {
    void inspectPath(workspace.path, workspace.pinnedOrder !== undefined ? 'pinned' : 'recent');
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const target = path.trim();
    if (!target) return;
    void inspectPath(target, 'manual');
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
      <div className="workspace-picker">
        <label className="workspace-search">
          <span className="sr-only">搜索最近项目</span>
          <Icon name="search" size={15} />
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="搜索最近项目…"
            disabled={locked}
          />
        </label>
        <button
          type="button"
          className="workspace-pick-folder primary-button"
          onClick={() => void chooseFolder()}
          disabled={picker.phase === 'picker-pending' || (locked && !pickerBusy)}
          aria-busy={picker.phase === 'picker-pending'}
        >
          <Icon name="workspace" size={16} />
          {picker.phase === 'picker-pending' ? '正在打开 Finder…' : '从 Finder 选择文件夹…'}
        </button>
        {picker.error ? (
          <p className="field-error" role="alert">
            {picker.error}
          </p>
        ) : null}
        {picker.phase === 'inspect-pending' ? (
          <p className="workspace-inspect-pending" role="status">
            正在解析 {picker.pendingPath}…
          </p>
        ) : null}
      </div>

      {activeCandidate ? (
        <WorkspaceConfirmCard
          candidate={activeCandidate}
          busy={picker.phase === 'activate-pending'}
          stage={picker.phase === 'activate-pending' ? 'runtime' : 'prepare'}
          error={picker.error}
          onCancel={() => dispatch({ type: 'back-to-browse' })}
          onOpen={() => void openCandidate(activeCandidate)}
        />
      ) : null}

      <div className="workspace-options" role="group" aria-label="常用工作区">
        {pinned.length > 0 ? (
          <>
            <h3 className="workspace-group-heading">固定项目</h3>
            {pinned.map(workspace => (
              <WorkspaceOption
                key={workspace.id}
                workspace={workspace}
                locked={locked}
                onOpen={openListedWorkspace}
              />
            ))}
          </>
        ) : null}
        {recent.length > 0 ? (
          <>
            <h3 className="workspace-group-heading">
              {pinned.length > 0 ? '最近打开' : '最近项目'}
            </h3>
            {shownRecent.map(workspace => (
              <WorkspaceOption
                key={workspace.id}
                workspace={workspace}
                locked={locked}
                onOpen={openListedWorkspace}
              />
            ))}
          </>
        ) : null}
        {!hasWorkspaces ? <p className="workspace-empty">没有匹配的项目。</p> : null}
        {hiddenRecent > 0 || (showAllWorkspaces && recent.length > RECENT_PREVIEW_COUNT) ? (
          <button
            type="button"
            className="text-button workspace-toggle-all"
            aria-expanded={showAllWorkspaces}
            onClick={() => setShowAllWorkspaces(value => !value)}
          >
            {showAllWorkspaces ? '收起其他项目' : `其他项目（${hiddenRecent}）`}
          </button>
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

      <details className="workspace-advanced">
        <summary>高级：粘贴绝对路径</summary>
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
            <button type="submit" className="primary-button" disabled={!path.trim() || locked}>
              打开
            </button>
          </div>
        </form>
      </details>
    </DialogFrame>
  );
}

function WorkspaceOption({
  workspace,
  locked,
  onOpen,
}: {
  readonly workspace: WorkbenchState['workspaces'][number];
  readonly locked: boolean;
  readonly onOpen: (workspace: WorkbenchState['workspaces'][number]) => void;
}) {
  return (
    <button
      type="button"
      className={`workspace-option ${workspace.active ? 'active' : ''}`}
      disabled={workspace.active || !workspace.available || locked}
      onClick={() => onOpen(workspace)}
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

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  /** Destructive confirmations render the danger action; focus starts on 取消. */
  readonly danger?: boolean;
  readonly pending?: boolean;
  readonly onConfirm: () => void | Promise<void>;
}

/**
 * v0.3.15 — one confirmation modal for destructive/unsaved-change guards,
 * replacing the last `window.confirm` calls (FilesPanel discard, Inspector
 * goal clear). Reuses `DialogFrame`, so Esc cancel, backdrop click and the
 * native focus trap come for free; the cancel button takes initial focus so
 * Enter can never confirm a destructive action accidentally.
 */
export function ConfirmDialog({
  open,
  onClose,
  title,
  body,
  confirmLabel,
  danger = false,
  pending = false,
  onConfirm,
}: ConfirmDialogProps) {
  const titleId = useId();
  const confirm = async () => {
    if (pending) return;
    try {
      await onConfirm();
      onClose();
    } catch {
      // Failures keep the dialog open; panels surface the error themselves.
    }
  };

  return (
    <DialogFrame open={open} onClose={onClose} labelledBy={titleId} className="confirm-modal">
      <header className="modal-header">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="关闭确认窗口">
          <Icon name="close" />
        </button>
      </header>
      <p className="confirm-body">{body}</p>
      <footer className="modal-footer">
        <button type="button" className="secondary-button" autoFocus onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className={danger ? 'danger-button' : 'primary-button'}
          disabled={pending}
          onClick={() => void confirm()}
        >
          {pending ? '处理中…' : confirmLabel}
        </button>
      </footer>
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
