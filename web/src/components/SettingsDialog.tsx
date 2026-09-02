import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';

import { requestId, WebApiError } from '../api';
import {
  conflictSettingsKeys,
  controlValue,
  dirtySettingsKeys,
  draftOperations,
  type SettingsDraftV1,
} from '../settings/settings-draft';
import {
  initialSettingsEditorState,
  settingsEditorReducer,
  type SettingsSectionId,
} from '../settings/settings-reducer';
import {
  type EffortPreference,
  type MotionPreference,
  type SettingsAppliesV1,
  type SettingsFieldViewV1,
  type SettingsKeyV1,
  type SettingsScopeV1,
  type SettingsSourceV1,
  type ThemePreference,
  type ToolConfirmationPreference,
  type UiStylePreference,
  type WebSettingsDocumentV1,
} from '../settings/types';
import type { WorkbenchState } from '../types';
import type { WorkbenchActions } from '../useWorkbench';
import { Icon, type IconName } from './Icon';
import { sanitizeDisplayText } from './Markdown';
import { basename } from './WorkspaceRail';

const EFFORTS: readonly EffortPreference[] = [
  'auto',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

const SECTIONS: ReadonlyArray<{
  readonly id: SettingsSectionId;
  readonly label: string;
  readonly icon: IconName;
}> = [
  { id: 'general', label: 'General', icon: 'settings' },
  { id: 'models', label: 'Models & Reasoning', icon: 'spark' },
  { id: 'permissions', label: 'Permissions', icon: 'warning' },
  { id: 'advanced', label: 'Advanced', icon: 'diagnostics' },
];

export interface SettingsDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly state: WorkbenchState;
  readonly actions: WorkbenchActions;
  readonly onGoToSessionControls: () => void;
}

export function SettingsDialog({
  open,
  onClose,
  state,
  actions,
  onGoToSessionControls,
}: SettingsDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const discardRef = useRef<HTMLButtonElement>(null);
  const focusBeforeDiscard = useRef<HTMLElement | null>(null);
  const observedRevision = useRef<string | null>(null);
  const wasOpen = useRef(false);
  const saveRequestId = useRef<string | null>(null);
  const previousPhase = useRef(initialSettingsEditorState.phase);
  const [editor, dispatch] = useReducer(settingsEditorReducer, initialSettingsEditorState);
  const [confirmAllow, setConfirmAllow] = useState(false);
  const [allowAcknowledged, setAllowAcknowledged] = useState(false);
  const [documentAction, setDocumentAction] = useState<{
    readonly tone: 'status' | 'error';
    readonly message: string;
  } | null>(null);
  const candidateDocument = state.settings ?? state.settingsMirror.lastGood;
  const document =
    candidateDocument && (!state.workspace || candidateDocument.workspace === state.workspace)
      ? candidateDocument
      : null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (open && !wasOpen.current) {
      if (document) {
        dispatch({ type: 'open', document });
        observedRevision.current = document.revision;
      }
      setConfirmAllow(false);
      setAllowAcknowledged(false);
      setDocumentAction(null);
    } else if (open && document && observedRevision.current === null) {
      dispatch({ type: 'open', document });
      observedRevision.current = document.revision;
    } else if (
      open &&
      document &&
      observedRevision.current !== null &&
      observedRevision.current !== document.revision
    ) {
      if (editor.phase === 'saving') return;
      observedRevision.current = document.revision;
      dispatch({ type: 'server_updated', document });
    } else if (!open && wasOpen.current) {
      dispatch({ type: 'close' });
      observedRevision.current = null;
      saveRequestId.current = null;
    }
    wasOpen.current = open;
  }, [document, editor.phase, open]);

  useEffect(() => {
    if (editor.confirmDiscard) discardRef.current?.focus();
  }, [editor.confirmDiscard]);

  useEffect(() => {
    const prior = previousPhase.current;
    previousPhase.current = editor.phase;
    if (!open || prior !== 'saving' || editor.phase !== 'success') return;
    const active = documentActiveElement();
    if (!dialogRef.current?.contains(active)) closeRef.current?.focus();
  }, [editor.phase, open]);

  useEffect(() => {
    if (!open || document || state.settingsMirror.status === 'loading') return;
    void actions.refreshSettings().catch(() => undefined);
  }, [actions, document, open, state.settingsMirror.status]);

  useEffect(() => {
    if (!open || !editor.draft || !state.workspace) return;
    if (editor.draft.workspace === state.workspace) return;
    dispatch({ type: 'close' });
    observedRevision.current = null;
  }, [editor.draft, open, state.workspace]);

  const draft = editor.draft;
  const dirtyKeys = draft ? dirtySettingsKeys(draft) : [];
  const dirty = dirtyKeys.length > 0;
  const runtimeBlockedDirty =
    state.processing &&
    dirtyKeys.some(key => ['defaults.effort', 'permissions.toolConfirmation'].includes(key));

  const requestClose = () => {
    if (editor.phase === 'saving') return;
    if (dirty) {
      const activeElement = documentActiveElement();
      focusBeforeDiscard.current = activeElement instanceof HTMLElement ? activeElement : null;
      dispatch({ type: 'request_discard' });
      return;
    }
    dispatch({ type: 'close' });
    onClose();
  };

  const discardAndClose = () => {
    dispatch({ type: 'close' });
    onClose();
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || !dirty || editor.phase === 'saving' || editor.phase === 'conflict') return;
    const operations = draftOperations(draft);
    const stableId = saveRequestId.current ?? requestId();
    saveRequestId.current = stableId;
    dispatch({ type: 'save_started' });
    try {
      const result = await actions.updateSettings(draft.base.revision, operations, stableId);
      saveRequestId.current = null;
      observedRevision.current = result.settings.revision;
      dispatch({ type: 'save_succeeded', document: result.settings });
    } catch (error) {
      const code = error instanceof WebApiError ? (error.code ?? 'settings_rejected') : 'network';
      let latest: WebSettingsDocumentV1 | undefined;
      if (code === 'settings_revision_conflict') {
        saveRequestId.current = null;
        latest = await actions.refreshSettings().catch(() => undefined);
        if (latest) observedRevision.current = latest.revision;
      } else if (error instanceof WebApiError && error.status < 500) {
        // A definite Host answer is not retried under the same idempotency key.
        saveRequestId.current = null;
      }
      const resolvedCode =
        code === 'settings_revision_conflict' && !latest ? 'settings_recovery_required' : code;
      dispatch({
        type: 'save_failed',
        code: resolvedCode,
        message: settingsErrorMessage(resolvedCode, error),
        ...(latest ? { latest } : {}),
      });
    }
  };

  const onBackdropClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) requestClose();
  };

  return (
    <dialog
      id="settings-dialog"
      ref={dialogRef}
      className="modal settings-modal"
      aria-modal="true"
      aria-labelledby="settings-title"
      aria-describedby="settings-description"
      onCancel={event => {
        event.preventDefault();
        requestClose();
      }}
      onClick={onBackdropClick}
    >
      <form onSubmit={save}>
        <header className="modal-header settings-header">
          <div>
            <span className="eyebrow">HOST SETTINGS</span>
            <h2 id="settings-title">设置</h2>
            <p id="settings-description">由本地 Host 读取、校验并原子保存。</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="icon-button"
            onClick={requestClose}
            aria-label="关闭设置"
            disabled={editor.phase === 'saving'}
          >
            <Icon name="close" />
          </button>
        </header>

        <div className="settings-layout">
          <nav className="settings-navigation" aria-label="设置类别">
            {SECTIONS.map(section => (
              <button
                type="button"
                key={section.id}
                className={editor.section === section.id ? 'active' : ''}
                aria-current={editor.section === section.id ? 'page' : undefined}
                onClick={() => dispatch({ type: 'select_section', section: section.id })}
              >
                <Icon name={section.icon} size={16} />
                <span>{section.label}</span>
              </button>
            ))}
          </nav>

          <div className="settings-content">
            <SettingsAvailability state={state} />
            {!draft ? (
              <section className="settings-empty" aria-live="polite">
                <Icon name="refresh" />
                <h3>正在读取设置</h3>
                <p>等待本地 Host 返回可验证的设置快照。</p>
              </section>
            ) : (
              <>
                {editor.phase === 'conflict' ? (
                  <ConflictNotice
                    draft={draft}
                    onAdopt={() => {
                      saveRequestId.current = null;
                      dispatch({ type: 'adopt_server' });
                    }}
                    onRebase={() => {
                      saveRequestId.current = null;
                      dispatch({ type: 'rebase' });
                    }}
                  />
                ) : null}
                {editor.message && editor.phase !== 'conflict' ? (
                  <div
                    className={`settings-inline-message settings-message-${editor.phase}`}
                    role={editor.phase === 'rejected' ? 'alert' : 'status'}
                    aria-live={editor.phase === 'rejected' ? 'assertive' : 'polite'}
                  >
                    <Icon name={editor.phase === 'success' ? 'check' : 'info'} size={16} />
                    <span>{editor.message}</span>
                  </div>
                ) : null}

                {editor.section === 'general' ? (
                  <GeneralSection
                    document={draft.base}
                    draft={draft.values}
                    dirtyKeys={dirtyKeys}
                    saving={editor.phase === 'saving'}
                    onSet={(key, value) => dispatch({ type: 'set_value', key, value })}
                    onReset={key => dispatch({ type: 'reset_value', key })}
                  />
                ) : null}
                {editor.section === 'models' ? (
                  <ModelsSection
                    document={draft.base}
                    draft={draft.values}
                    dirtyKeys={dirtyKeys}
                    runtimeBusy={state.processing}
                    saving={editor.phase === 'saving'}
                    onGoToSessionControls={onGoToSessionControls}
                    onSet={(key, value) => dispatch({ type: 'set_value', key, value })}
                    onReset={key => dispatch({ type: 'reset_value', key })}
                  />
                ) : null}
                {editor.section === 'permissions' ? (
                  <PermissionsSection
                    document={draft.base}
                    value={draft.values['permissions.toolConfirmation']}
                    dirtyKeys={dirtyKeys}
                    runtimeBusy={state.processing}
                    saving={editor.phase === 'saving'}
                    confirmAllow={confirmAllow}
                    allowAcknowledged={allowAcknowledged}
                    onAllowRequested={() => {
                      setAllowAcknowledged(false);
                      setConfirmAllow(true);
                    }}
                    onAllowAcknowledged={setAllowAcknowledged}
                    onConfirmAllow={() => {
                      dispatch({
                        type: 'set_value',
                        key: 'permissions.toolConfirmation',
                        value: 'allow',
                      });
                      setConfirmAllow(false);
                      setAllowAcknowledged(false);
                    }}
                    onCancelAllow={() => {
                      setConfirmAllow(false);
                      setAllowAcknowledged(false);
                    }}
                    onSet={value =>
                      dispatch({
                        type: 'set_value',
                        key: 'permissions.toolConfirmation',
                        value,
                      })
                    }
                    onReset={() =>
                      dispatch({ type: 'reset_value', key: 'permissions.toolConfirmation' })
                    }
                  />
                ) : null}
                {editor.section === 'advanced' ? (
                  <AdvancedSection
                    state={state}
                    document={draft.base}
                    documentAction={documentAction}
                    onOpenDocument={() => {
                      setDocumentAction({ tone: 'status', message: '正在请求 Host 打开设置文件…' });
                      void actions
                        .openSettingsDocument()
                        .then(() =>
                          setDocumentAction({
                            tone: 'status',
                            message: '已交给系统默认编辑器打开。',
                          })
                        )
                        .catch(error =>
                          setDocumentAction({
                            tone: 'error',
                            message: error instanceof Error ? error.message : '无法打开设置文件。',
                          })
                        );
                    }}
                    onRefresh={() => {
                      setDocumentAction({ tone: 'status', message: '正在重新载入 Host 设置…' });
                      void actions
                        .refreshSettings()
                        .then(() =>
                          setDocumentAction({ tone: 'status', message: '已载入最新设置。' })
                        )
                        .catch(error =>
                          setDocumentAction({
                            tone: 'error',
                            message: error instanceof Error ? error.message : '重新载入失败。',
                          })
                        );
                    }}
                  />
                ) : null}
              </>
            )}
          </div>
        </div>

        {editor.confirmDiscard ? (
          <div
            className="settings-discard-confirm"
            role="alertdialog"
            aria-labelledby="settings-discard-title"
            aria-describedby="settings-discard-description"
          >
            <div>
              <strong id="settings-discard-title">放弃未应用的更改？</strong>
              <p id="settings-discard-description">你的 {dirtyKeys.length} 项草稿尚未写入 Host。</p>
            </div>
            <div>
              <button
                ref={discardRef}
                type="button"
                className="secondary-button"
                onClick={() => {
                  dispatch({ type: 'cancel_discard' });
                  const target = focusBeforeDiscard.current;
                  requestAnimationFrame(() => target?.focus());
                }}
              >
                继续编辑
              </button>
              <button type="button" className="danger-ghost-button" onClick={discardAndClose}>
                放弃更改
              </button>
            </div>
          </div>
        ) : null}

        <footer className="modal-footer settings-footer">
          <span className="settings-dirty-summary" aria-live="polite">
            {dirty ? `${dirtyKeys.length} 项未应用` : '没有未应用的更改'}
          </span>
          <button
            type="button"
            className="secondary-button"
            onClick={requestClose}
            disabled={editor.phase === 'saving'}
          >
            取消
          </button>
          <button
            type="submit"
            className="primary-button"
            disabled={
              !draft ||
              !dirty ||
              editor.phase === 'saving' ||
              editor.phase === 'conflict' ||
              runtimeBlockedDirty ||
              draft.base.state !== 'ready' ||
              !draft.base.writable
            }
          >
            {editor.phase === 'saving' ? '应用中…' : `应用 ${dirtyKeys.length} 项`}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

interface SectionProps {
  readonly document: WebSettingsDocumentV1;
  readonly draft: {
    readonly 'appearance.style': UiStylePreference;
    readonly 'appearance.theme': ThemePreference;
    readonly 'appearance.motion': MotionPreference;
    readonly 'defaults.model': string;
    readonly 'defaults.effort': EffortPreference;
    readonly 'permissions.toolConfirmation': ToolConfirmationPreference;
  };
  readonly dirtyKeys: readonly SettingsKeyV1[];
  readonly saving: boolean;
  readonly onSet: (key: SettingsKeyV1, value: SectionProps['draft'][SettingsKeyV1]) => void;
  readonly onReset: (key: SettingsKeyV1) => void;
}

function GeneralSection({ document, draft, dirtyKeys, saving, onSet, onReset }: SectionProps) {
  const style = document.sections.appearance.style;
  const theme = document.sections.appearance.theme;
  const motion = document.sections.appearance.motion;
  return (
    <SettingsSection
      heading="通用"
      detail="外观偏好由 Host 保存，并在所有 Workbench 窗口保持一致。"
    >
      <SettingField
        id="settings-style"
        label="视觉风格"
        description="选择内置的方块工坊外观，或切回经典工作台。"
        field={style}
        dirty={dirtyKeys.includes('appearance.style')}
        onReset={() => onReset('appearance.style')}
        disabled={saving || !canWrite(document, style)}
      >
        <select
          id="settings-style"
          value={draft['appearance.style']}
          disabled={saving || !canWrite(document, style)}
          onChange={event => onSet('appearance.style', event.target.value as UiStylePreference)}
        >
          <option value="orion-blocksmith">方块工坊（内置，默认）</option>
          <option value="classic">经典</option>
        </select>
      </SettingField>
      <SettingField
        id="settings-theme"
        label="主题"
        description="跟随系统或固定使用浅色、深色。"
        field={theme}
        dirty={dirtyKeys.includes('appearance.theme')}
        onReset={() => onReset('appearance.theme')}
        disabled={saving || !canWrite(document, theme)}
      >
        <select
          id="settings-theme"
          value={draft['appearance.theme']}
          disabled={saving || !canWrite(document, theme)}
          onChange={event => onSet('appearance.theme', event.target.value as ThemePreference)}
        >
          <option value="system">跟随系统</option>
          <option value="dark">深色</option>
          <option value="light">浅色</option>
        </select>
      </SettingField>
      <figure
        className="appearance-preview"
        data-preview-style={draft['appearance.style']}
        data-preview-theme={draft['appearance.theme']}
        aria-label={`外观预览：${
          draft['appearance.style'] === 'orion-blocksmith' ? '方块工坊' : '经典工作台'
        }，${themePreferenceLabel(draft['appearance.theme'])}`}
      >
        <div className="appearance-preview-frame" aria-hidden="true">
          <span className="appearance-preview-rail" />
          <span className="appearance-preview-main">
            <i />
            <i />
          </span>
          <span className="appearance-preview-panel" />
        </div>
        <figcaption>纯 CSS 预览 · 均为内置外观，不支持安装或卸载。</figcaption>
      </figure>
      <SettingField
        id="settings-motion"
        label="动效"
        description="减少非必要动画，保留状态变化。"
        field={motion}
        dirty={dirtyKeys.includes('appearance.motion')}
        onReset={() => onReset('appearance.motion')}
        disabled={saving || !canWrite(document, motion)}
      >
        <select
          id="settings-motion"
          value={draft['appearance.motion']}
          disabled={saving || !canWrite(document, motion)}
          onChange={event => onSet('appearance.motion', event.target.value as MotionPreference)}
        >
          <option value="system">跟随系统</option>
          <option value="reduced">减少动效</option>
        </select>
      </SettingField>
    </SettingsSection>
  );
}

function themePreferenceLabel(theme: ThemePreference): string {
  if (theme === 'light') return '浅色';
  if (theme === 'dark') return '深色';
  return '跟随系统';
}

function ModelsSection({
  document,
  draft,
  dirtyKeys,
  saving,
  runtimeBusy,
  onSet,
  onReset,
  onGoToSessionControls,
}: SectionProps & {
  readonly runtimeBusy: boolean;
  readonly onGoToSessionControls: () => void;
}) {
  const model = document.sections.defaults.model;
  const effort = document.sections.defaults.effort;
  const knownModels = document.models.some(item => item.id === draft['defaults.model'])
    ? document.models
    : [{ id: draft['defaults.model'], label: draft['defaults.model'] }, ...document.models];
  return (
    <SettingsSection
      heading="模型与推理"
      detail="项目默认值通常从下一逻辑请求开始生效；当前会话覆盖保持可见。"
    >
      {runtimeBusy ? (
        <BusyNotice detail="当前回合正在运行；项目推理强度暂时锁定，默认模型仍可用于新会话。" />
      ) : null}
      <SettingField
        id="settings-model"
        label="默认模型"
        description="仅展示 Host 提供的可用模型标识。"
        field={model}
        dirty={dirtyKeys.includes('defaults.model')}
        onReset={() => onReset('defaults.model')}
        disabled={saving || !canWrite(document, model)}
      >
        <select
          id="settings-model"
          value={draft['defaults.model']}
          disabled={saving || !canWrite(document, model)}
          onChange={event => onSet('defaults.model', event.target.value)}
        >
          {knownModels.map(item => (
            <option key={item.id} value={item.id}>
              {item.label}
              {item.provider ? ` · ${item.provider}` : ''}
            </option>
          ))}
        </select>
      </SettingField>
      <SettingField
        id="settings-effort"
        label="默认推理强度"
        description="模型不支持的强度会由 Host 拒绝，不会静默降级。"
        field={effort}
        dirty={dirtyKeys.includes('defaults.effort')}
        onReset={() => onReset('defaults.effort')}
        disabled={saving || runtimeBusy || !canWrite(document, effort)}
      >
        <select
          id="settings-effort"
          value={draft['defaults.effort']}
          disabled={saving || runtimeBusy || !canWrite(document, effort)}
          onChange={event => onSet('defaults.effort', event.target.value as EffortPreference)}
        >
          {EFFORTS.map(value => (
            <option key={value} value={value}>
              {value === 'auto' ? 'Auto' : value}
            </option>
          ))}
        </select>
      </SettingField>
      {document.currentSession ? (
        <div className="settings-readonly-card" aria-label="当前会话设置">
          <div>
            <span>当前会话</span>
            <strong>{document.currentSession.model}</strong>
          </div>
          <div>
            <span>Effort</span>
            <strong>{document.currentSession.effort}</strong>
          </div>
          <p>
            {document.currentSession.overridesProjectEffort
              ? '当前会话覆盖了项目推理强度。'
              : '当前会话沿用项目默认值。'}
          </p>
          <small>可在会话输入框使用 /model 或 /effort 调整当前会话。</small>
          <button
            type="button"
            className="text-button"
            onClick={onGoToSessionControls}
            aria-controls="orion-composer"
          >
            转到会话控制
          </button>
        </div>
      ) : null}
      <div className="credential-note">
        <Icon name="check" size={16} />
        <div>
          <strong>凭证始终留在 Host</strong>
          <p>浏览器只接收 ready / missing / unavailable 状态，不提供 API Key 输入框。</p>
        </div>
      </div>
    </SettingsSection>
  );
}

interface PermissionsProps {
  readonly document: WebSettingsDocumentV1;
  readonly value: ToolConfirmationPreference;
  readonly dirtyKeys: readonly SettingsKeyV1[];
  readonly runtimeBusy: boolean;
  readonly saving: boolean;
  readonly confirmAllow: boolean;
  readonly allowAcknowledged: boolean;
  readonly onAllowRequested: () => void;
  readonly onAllowAcknowledged: (value: boolean) => void;
  readonly onConfirmAllow: () => void;
  readonly onCancelAllow: () => void;
  readonly onSet: (value: ToolConfirmationPreference) => void;
  readonly onReset: () => void;
}

function PermissionsSection({
  document,
  value,
  dirtyKeys,
  runtimeBusy,
  saving,
  confirmAllow,
  allowAcknowledged,
  onAllowRequested,
  onAllowAcknowledged,
  onConfirmAllow,
  onCancelAllow,
  onSet,
  onReset,
}: PermissionsProps) {
  const allowRadioRef = useRef<HTMLInputElement>(null);
  const allowCheckboxRef = useRef<HTMLInputElement>(null);
  const field = document.sections.permissions.toolConfirmation;
  const disabled = saving || runtimeBusy || !canWrite(document, field);
  useEffect(() => {
    if (confirmAllow) allowCheckboxRef.current?.focus();
  }, [confirmAllow]);
  return (
    <SettingsSection heading="权限" detail="默认确认策略不改变工作区边界、硬拒绝和高风险保护。">
      {runtimeBusy ? <BusyNotice /> : null}
      <SettingField
        id="settings-tool-confirmation"
        label="工具确认"
        description="Ask 逐次询问；Deny 默认拒绝；Allow 仍受 Host 安全策略约束。"
        field={field}
        labelControl={false}
        dirty={dirtyKeys.includes('permissions.toolConfirmation')}
        onReset={onReset}
        disabled={disabled}
      >
        <fieldset id="settings-tool-confirmation" className="segmented-field" disabled={disabled}>
          <legend className="sr-only">默认工具确认策略</legend>
          {(['ask', 'allow', 'deny'] as const).map(option => (
            <label key={option}>
              <input
                ref={option === 'allow' ? allowRadioRef : undefined}
                type="radio"
                name="settings-permission"
                value={option}
                checked={value === option}
                onChange={() => (option === 'allow' ? onAllowRequested() : onSet(option))}
              />
              <span>{option === 'ask' ? 'Ask' : option === 'allow' ? 'Allow' : 'Deny'}</span>
            </label>
          ))}
        </fieldset>
      </SettingField>
      {confirmAllow ? (
        <div
          className="settings-risk-confirm"
          role="alertdialog"
          aria-labelledby="allow-confirm-title"
          aria-describedby="allow-confirm-description"
        >
          <strong id="allow-confirm-title">确认启用 Allow</strong>
          <p id="allow-confirm-description">
            Orion 会减少常规工具询问，但硬拒绝、工作区边界和风险检查仍然生效。
          </p>
          <label>
            <input
              ref={allowCheckboxRef}
              type="checkbox"
              checked={allowAcknowledged}
              onChange={event => onAllowAcknowledged(event.target.checked)}
            />
            <span>我理解这会扩大默认授权范围</span>
          </label>
          <div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                onCancelAllow();
                requestAnimationFrame(() => allowRadioRef.current?.focus());
              }}
            >
              保持当前策略
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!allowAcknowledged}
              onClick={onConfirmAllow}
            >
              启用 Allow
            </button>
          </div>
        </div>
      ) : null}
      <p className="settings-help">Agent 的 BUILD / PLAN / AUTO 模式与工具确认策略互相独立。</p>
    </SettingsSection>
  );
}

function AdvancedSection({
  state,
  document,
  documentAction,
  onOpenDocument,
  onRefresh,
}: {
  readonly state: WorkbenchState;
  readonly document: WebSettingsDocumentV1;
  readonly documentAction: { readonly tone: 'status' | 'error'; readonly message: string } | null;
  readonly onOpenDocument: () => void;
  readonly onRefresh: () => void;
}) {
  return (
    <SettingsSection heading="高级" detail="配置状态、凭证可用性和集成清单均为只读摘要。">
      {document.diagnostic ? (
        <div className="settings-diagnostic" role="alert">
          <Icon name="warning" size={16} />
          <div>
            <strong>{sanitizeDisplayText(document.diagnostic.code)}</strong>
            <p>{sanitizeDisplayText(document.diagnostic.message)}</p>
          </div>
        </div>
      ) : null}
      <dl className="settings-facts">
        <div>
          <dt>状态</dt>
          <dd>{settingsStateLabel(document.state)}</dd>
        </div>
        <div>
          <dt>工作区</dt>
          <dd title="仅显示目录名">{basename(document.workspace) || '—'}</dd>
        </div>
        <div>
          <dt>文档</dt>
          <dd>{document.hasDocument ? '已创建' : '尚未创建'}</dd>
        </div>
        <div>
          <dt>版本</dt>
          <dd title={document.revision}>{shortRevision(document.revision)}</dd>
        </div>
        <div>
          <dt>Last good</dt>
          <dd>
            {state.settingsMirror.lastGood
              ? shortRevision(state.settingsMirror.lastGood.revision)
              : '无'}
          </dd>
        </div>
        <div>
          <dt>Mirror</dt>
          <dd>
            {state.settingsMirror.status} · g{state.settingsMirror.generation}
          </dd>
        </div>
      </dl>
      <div className="settings-advanced-actions">
        <button type="button" className="secondary-button" onClick={onRefresh}>
          <Icon name="refresh" size={15} />
          重新载入设置
        </button>
        <button type="button" className="secondary-button" onClick={onOpenDocument}>
          <Icon name="edit" size={15} />
          打开配置文件
        </button>
      </div>
      {documentAction ? (
        <div
          className={`settings-document-action ${documentAction.tone}`}
          role={documentAction.tone === 'error' ? 'alert' : 'status'}
        >
          {documentAction.message}
        </div>
      ) : null}

      <section className="settings-subsection" aria-labelledby="credential-status-heading">
        <h4 id="credential-status-heading">凭证状态</h4>
        <p>仅显示来源类别与可用性；密钥值、环境变量名和认证头不会进入浏览器。</p>
        {document.credentials.length ? (
          <ul className="settings-readonly-list">
            {document.credentials.map(slot => (
              <li key={slot.providerId}>
                <span>{slot.providerId}</span>
                <span className={`settings-state-badge state-${slot.state}`}>{slot.state}</span>
                <small>{credentialSourceLabel(slot.source)}</small>
              </li>
            ))}
          </ul>
        ) : (
          <p className="settings-empty-line">Host 未报告凭证槽位。</p>
        )}
      </section>

      <section className="settings-subsection" aria-labelledby="integration-status-heading">
        <h4 id="integration-status-heading">只读能力</h4>
        <p>Skills 与 MCP 在专用配置中管理，此处用于确认 Host 实际加载结果。</p>
        <div className="settings-capability-grid">
          <CapabilitySummary
            title="Skills"
            count={state.skills.length}
            names={state.skills.map(skill => skill.name)}
          />
          <CapabilitySummary
            title="MCP"
            count={state.mcpServers.length}
            names={state.mcpServers.map(server => server.name)}
          />
        </div>
      </section>
    </SettingsSection>
  );
}

function SettingsAvailability({ state }: { readonly state: WorkbenchState }) {
  const { settingsMirror: mirror } = state;
  if (mirror.status === 'loading') {
    return (
      <div className="settings-availability" role="status">
        <Icon name="refresh" size={15} /> 正在与 Host 同步设置…
      </div>
    );
  }
  if (mirror.error) {
    return (
      <div className="settings-availability error" role="alert">
        <Icon name="warning" size={15} /> 设置同步失败：{mirror.error} 当前显示上一次可用值。
      </div>
    );
  }
  if (mirror.stale) {
    return (
      <div className="settings-availability" role="status">
        <Icon name="refresh" size={15} /> Host 已更新设置，正在载入；当前显示上一次可用值。
      </div>
    );
  }
  if (mirror.document?.state === 'invalid') {
    return (
      <div className="settings-availability error" role="alert">
        <Icon name="warning" size={15} /> 设置文档无效。控件已锁定，并保留上一次可用值供参考。
      </div>
    );
  }
  if (mirror.document?.state === 'read-only') {
    return (
      <div className="settings-availability" role="status">
        <Icon name="info" size={15} /> 设置当前为只读状态。
      </div>
    );
  }
  if (mirror.document?.state === 'unavailable') {
    return (
      <div className="settings-availability error" role="alert">
        <Icon name="warning" size={15} /> Host 设置暂不可用；当前显示上一次可用值。
      </div>
    );
  }
  return null;
}

function SettingsSection({
  heading,
  detail,
  children,
}: {
  readonly heading: string;
  readonly detail: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="settings-section" aria-labelledby={`settings-${slug(heading)}-heading`}>
      <header className="settings-section-heading">
        <h3 id={`settings-${slug(heading)}-heading`}>{heading}</h3>
        <p>{detail}</p>
      </header>
      <div className="settings-section-fields">{children}</div>
    </section>
  );
}

function SettingField<T>({
  id,
  label,
  description,
  field,
  labelControl = true,
  dirty,
  disabled,
  onReset,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly field: SettingsFieldViewV1<T>;
  readonly labelControl?: boolean;
  readonly dirty: boolean;
  readonly disabled: boolean;
  readonly onReset: () => void;
  readonly children: ReactNode;
}) {
  return (
    <div className={`settings-field-card ${dirty ? 'dirty' : ''}`}>
      <div className="settings-field-copy">
        {labelControl ? <label htmlFor={id}>{label}</label> : <strong>{label}</strong>}
        <p>{description}</p>
        <div className="settings-field-meta" aria-label={`${label} 设置来源`}>
          <span>{sourceLabel(field.source)}</span>
          <span>{scopeLabel(field.scope)}</span>
          <span>{appliesLabel(field.applies)}</span>
          {dirty ? <strong>草稿</strong> : null}
        </div>
        {field.blockedReason ? (
          <small className="settings-blocked-reason">
            {blockedReasonLabel(field.blockedReason)}
          </small>
        ) : null}
      </div>
      <div className="settings-field-control">
        {children}
        <button
          type="button"
          className="text-button"
          onClick={onReset}
          disabled={disabled || (field.explicitValue === undefined && !dirty)}
          aria-label={`重置${label}为继承值`}
        >
          重置
        </button>
      </div>
    </div>
  );
}

function ConflictNotice({
  draft,
  onAdopt,
  onRebase,
}: {
  readonly draft: SettingsDraftV1;
  readonly onAdopt: () => void;
  readonly onRebase: () => void;
}) {
  const conflictKeys = conflictSettingsKeys(draft);
  const dirtyKeys = dirtySettingsKeys(draft);
  const latest = draft.serverLatest;
  return (
    <div className="settings-conflict" role="alert">
      <Icon name="warning" size={17} />
      <div>
        <strong>Host 设置已在其他位置更新</strong>
        <p>
          草稿仍被保留
          {conflictKeys.length ? `；${conflictKeys.length} 个草稿字段的服务器值发生变化` : ''}。
        </p>
        {latest ? (
          <div className="settings-conflict-values" aria-label="服务器值与我的草稿">
            <div className="settings-conflict-value-heading" aria-hidden="true">
              <span>字段</span>
              <span>服务器最新值</span>
              <span>我的草稿</span>
            </div>
            {dirtyKeys.map(key => (
              <div key={key}>
                <strong>{settingKeyLabel(key)}</strong>
                <span data-label="服务器最新值">{String(controlValue(latest, key))}</span>
                <span data-label="我的草稿">
                  {String(draft.values[key])}
                  {draft.intents[key]?.op === 'unset' ? '（重置）' : ''}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        <div>
          <button type="button" className="secondary-button" onClick={onAdopt}>
            采用服务器值
          </button>
          <button type="button" className="primary-button" onClick={onRebase}>
            基于最新值重试
          </button>
        </div>
      </div>
    </div>
  );
}

function BusyNotice({
  detail = '当前回合正在运行；相关设置会在 Runtime 空闲后解锁。',
}: {
  readonly detail?: string;
} = {}) {
  return (
    <div className="settings-busy" role="status">
      <Icon name="activity" size={15} /> {detail}
    </div>
  );
}

function CapabilitySummary({
  title,
  count,
  names,
}: {
  readonly title: string;
  readonly count: number;
  readonly names: readonly string[];
}) {
  return (
    <div className="settings-capability-card">
      <span>{title}</span>
      <strong>{count}</strong>
      <small>{names.slice(0, 3).join(' · ') || '未加载'}</small>
    </div>
  );
}

function canWrite<T>(document: WebSettingsDocumentV1, field: SettingsFieldViewV1<T>): boolean {
  return document.state === 'ready' && document.writable && field.writable && !field.blockedReason;
}

function settingsErrorMessage(code: string, error: unknown): string {
  const hostMessage = error instanceof Error ? error.message : 'Host 拒绝了设置变更。';
  switch (code) {
    case 'settings_revision_conflict':
      return '设置已在其他位置更新。你的草稿没有丢失。';
    case 'runtime_busy':
      return 'Runtime 正在处理任务。请等待当前回合结束后再次应用。';
    case 'settings_document_invalid':
      return '配置文件无效。请在高级页查看 Host 提供的安全诊断。';
    case 'settings_write_forbidden':
      return '当前设置来源为只读，Host 未执行任何变更。';
    case 'request_id_conflict':
      return '保存请求标识与先前内容冲突，请重新应用。';
    case 'settings_recovery_required':
      return 'Host 报告设置冲突，但最新设置暂时无法载入。草稿已保留，请重新载入后再试。';
    case 'network':
      return '未能确认 Host 是否收到请求；保留草稿，可安全重试。';
    default:
      return hostMessage;
  }
}

function sourceLabel(source: SettingsSourceV1): string {
  return `来源：${
    source === 'internal'
      ? '内置'
      : source === 'model'
        ? '模型'
        : source === 'global'
          ? '全局'
          : source === 'project'
            ? '项目'
            : '会话'
  }`;
}

function scopeLabel(scope: SettingsScopeV1): string {
  return `作用域：${scope === 'global' ? '全局' : scope === 'project' ? '项目' : '会话'}`;
}

function appliesLabel(applies: SettingsAppliesV1): string {
  const label =
    applies === 'live'
      ? '立即'
      : applies === 'next-logical-request'
        ? '下次请求'
        : applies === 'new-session'
          ? '新会话'
          : '重启后';
  return `生效：${label}`;
}

function blockedReasonLabel(reason: string): string {
  if (reason === 'runtime_busy') return 'Runtime 正在运行，暂不可修改。';
  if (reason === 'read_only') return '此字段来自只读配置。';
  return '设置文档无效，修复前不可修改。';
}

function settingKeyLabel(key: SettingsKeyV1): string {
  if (key === 'appearance.style') return '视觉风格';
  if (key === 'appearance.theme') return '主题';
  if (key === 'appearance.motion') return '动效';
  if (key === 'defaults.model') return '默认模型';
  if (key === 'defaults.effort') return '默认推理强度';
  return '工具确认';
}

function credentialSourceLabel(source: 'environment' | 'legacy' | 'none'): string {
  if (source === 'environment') return '环境提供';
  if (source === 'legacy') return 'Host 旧配置';
  return '未配置';
}

function settingsStateLabel(state: WebSettingsDocumentV1['state']): string {
  if (state === 'ready') return '可用';
  if (state === 'invalid') return '无效';
  if (state === 'read-only') return '只读';
  return '不可用';
}

function shortRevision(revision: string): string {
  return revision.length > 24 ? `${revision.slice(0, 20)}…` : revision;
}

function slug(value: string): string {
  return (
    value
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'section'
  );
}

function documentActiveElement(): Element | null {
  return typeof document === 'undefined' ? null : document.activeElement;
}
