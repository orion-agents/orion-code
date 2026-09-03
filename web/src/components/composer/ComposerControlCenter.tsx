import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';

import type {
  WebContextReferenceV1,
  WebEffortPreferenceV1,
  WebFileNodeV1,
} from '../../../../src/web/protocol';
import {
  loadComposerDraft,
  removeComposerDraft,
  saveComposerDraft,
} from '../../state/composer-drafts';
import { WebApiError } from '../../api';
import { isActiveSessionSnapshotReady, type WorkbenchState } from '../../types';
import type { WorkbenchActions } from '../../useWorkbench';
import { Icon } from '../Icon';

interface ComposerControlCenterProps {
  readonly state: WorkbenchState;
  readonly actions: WorkbenchActions;
  readonly insertion: { readonly id: number; readonly text: string } | null;
}

interface DraftState {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly text: string;
  readonly references: readonly WebContextReferenceV1[];
}

type RiskSelection = 'auto' | 'allow' | null;

export function ComposerControlCenter({ state, actions, insertion }: ComposerControlCenterProps) {
  const workspaceId = state.workspaceId;
  const sessionId = state.activeSessionId ?? '';
  const [draftState, setDraftState] = useState<DraftState>({
    workspaceId,
    sessionId,
    text: '',
    references: [],
  });
  const [riskSelection, setRiskSelection] = useState<RiskSelection>(null);
  const [draftError, setDraftError] = useState('');
  const [invalidReferenceKeys, setInvalidReferenceKeys] = useState<ReadonlySet<string>>(new Set());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeKey = `${workspaceId}:${sessionId}`;
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;
  const draftKey = `${draftState.workspaceId}:${draftState.sessionId}`;
  const disabled =
    !sessionId ||
    !state.bootstrap?.configured ||
    state.connection !== 'live' ||
    !isActiveSessionSnapshotReady(state);
  const pending = Boolean(state.pendingAction);
  const sessionTurnQueued = state.sessionSnapshot?.sessionRuntime.phase === 'queued';
  const controlsReady = !disabled && !pending;
  const composerReady = controlsReady && !sessionTurnQueued;

  useEffect(() => {
    if (!workspaceId || !sessionId) {
      setDraftState({ workspaceId, sessionId, text: '', references: [] });
      return;
    }
    const saved = loadComposerDraft(workspaceId, sessionId);
    setDraftState({
      workspaceId,
      sessionId,
      text: saved?.text ?? '',
      references: saved?.references ?? [],
    });
    setDraftError('');
    setInvalidReferenceKeys(new Set());
  }, [workspaceId, sessionId]);

  useEffect(() => {
    if (!draftState.workspaceId || !draftState.sessionId) return;
    try {
      if (draftState.text || draftState.references.length > 0) {
        saveComposerDraft(draftState);
      } else {
        removeComposerDraft(draftState.workspaceId, draftState.sessionId);
      }
      setDraftError('');
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : '草稿无法保存。');
    }
  }, [draftState]);

  useEffect(() => {
    if (!insertion || !sessionId || draftKey !== activeKey) return;
    setDraftState(current => ({
      ...current,
      text: current.text.trim() ? `${current.text.trimEnd()}\n\n${insertion.text}` : insertion.text,
    }));
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [activeKey, draftKey, insertion, sessionId]);

  const draft = draftKey === activeKey ? draftState.text : '';
  const references = draftKey === activeKey ? draftState.references : [];
  const updateDraft = (text: string) =>
    setDraftState(current => ({ ...current, workspaceId, sessionId, text }));
  const updateReferences = (next: readonly WebContextReferenceV1[]) => {
    const nextKeys = new Set(next.map(contextReferenceKey));
    setInvalidReferenceKeys(current => new Set([...current].filter(key => nextKeys.has(key))));
    setDraftState(current => ({ ...current, workspaceId, sessionId, references: next }));
  };

  const deliver = async (kind: 'submit' | 'queue') => {
    const text = draft.trim();
    if (!text || !composerReady) return;
    const deliveredKey = activeKey;
    try {
      if (kind === 'queue') await actions.queue(text, references);
      else await actions.submit(text, references);
      removeComposerDraft(workspaceId, sessionId);
      setInvalidReferenceKeys(new Set());
      if (activeKeyRef.current === deliveredKey) {
        setDraftState({ workspaceId, sessionId, text: '', references: [] });
      }
      textareaRef.current?.focus();
    } catch (error) {
      if (
        error instanceof WebApiError &&
        ['context_reference_stale', 'context_reference_forbidden'].includes(error.code ?? '')
      ) {
        setInvalidReferenceKeys(new Set(references.map(contextReferenceKey)));
      }
      setDraftError(error instanceof Error ? error.message : '发送失败，草稿已保留。');
      textareaRef.current?.focus();
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void deliver(state.processing ? 'queue' : 'submit');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (state.processing && (event.metaKey || event.ctrlKey)) void deliver('submit');
    else void deliver(state.processing ? 'queue' : 'submit');
  };

  return (
    <div className="composer-control-center">
      {state.composer?.planReview?.status === 'awaiting_review' ? (
        <PlanReviewCard state={state} actions={actions} />
      ) : null}
      {references.length > 0 ? (
        <ContextTray
          references={references}
          invalidReferenceKeys={invalidReferenceKeys}
          onChange={updateReferences}
        />
      ) : null}
      <form className="composer composer-v032" onSubmit={onSubmit}>
        <label htmlFor="orion-composer" className="sr-only">
          发送给 Orion
        </label>
        <textarea
          ref={textareaRef}
          id="orion-composer"
          rows={3}
          maxLength={1_000_000}
          value={draft}
          onChange={event => updateDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            pending
              ? '正在同步会话控制状态…'
              : sessionTurnQueued
                ? `任务正在排队${
                    state.sessionSnapshot?.sessionRuntime.queuePosition
                      ? `（第 ${state.sessionSnapshot.sessionRuntime.queuePosition} 位）`
                      : ''
                  }`
                : disabled
                  ? '选择会话并配置模型后开始'
                  : state.processing
                    ? '输入后续消息；Enter 排队，⌘/Ctrl+Enter Steer'
                    : '描述任务，或输入 / 查看命令…'
          }
          disabled={!composerReady}
        />
        <div className="composer-toolbar composer-control-toolbar">
          <div className="composer-controls composer-control-row">
            <ContextLauncher
              state={state}
              actions={actions}
              disabled={!composerReady}
              references={references}
              onChange={updateReferences}
              onInsertCommand={() => updateDraft(draft.trim() ? `${draft.trimEnd()}\n/` : '/')}
            />
            <ControlMenu
              label={modeControlLabel(state)}
              accessibleLabel="工作模式"
              disabled={!composerReady}
              value={state.composer?.mode.baseMode ?? state.mode.baseMode}
              options={[
                { value: 'interactive', label: 'BUILD', detail: '执行、修改并验证当前任务' },
                { value: 'plan', label: 'PLAN', detail: '生成计划并等待你的审核' },
                { value: 'auto', label: 'AUTO', detail: '自主执行，仍受权限与沙箱约束' },
              ]}
              onSelect={value => {
                if (value === 'auto') setRiskSelection('auto');
                else consumeHandledAction(actions.setMode(value as 'interactive' | 'plan'));
              }}
            />
            <ControlMenu
              label={permissionControlLabel(state)}
              accessibleLabel="会话权限"
              disabled={!composerReady}
              value={state.composer?.permission.override ?? 'inherit'}
              options={[
                {
                  value: 'inherit',
                  label: '继承项目',
                  detail: `当前 ${state.composer?.permission.projectDefault ?? 'ask'}`,
                },
                { value: 'ask', label: 'ASK', detail: '高风险工具逐次请求批准' },
                { value: 'allow', label: 'ALLOW', detail: '允许策略许可的工具，不绕过沙箱' },
                { value: 'deny', label: 'DENY', detail: '拒绝需要授权的工具' },
              ]}
              onSelect={value => {
                if (value === 'allow') setRiskSelection('allow');
                else
                  consumeHandledAction(
                    actions.setPermissionOverride(
                      value === 'inherit' ? null : (value as 'ask' | 'deny')
                    )
                  );
              }}
            />
          </div>
          <div className="composer-actions composer-control-actions">
            <ModelControls state={state} actions={actions} disabled={!composerReady} />
            <ContextMeter state={state} actions={actions} disabled={!composerReady} />
            {state.processing ? (
              <>
                <button
                  type="button"
                  className="icon-text-button stop-button"
                  onClick={() => consumeHandledAction(actions.interrupt())}
                  disabled={!composerReady}
                >
                  <Icon name="stop" size={14} />
                  停止
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void deliver('submit')}
                  disabled={!draft.trim() || !composerReady}
                >
                  Steer
                </button>
              </>
            ) : null}
            {sessionTurnQueued ? (
              <button
                type="button"
                className="secondary-button"
                onClick={() => consumeHandledAction(actions.cancelQueuedTurn())}
                disabled={!controlsReady}
              >
                取消排队
              </button>
            ) : null}
            <button
              type="submit"
              className="send-button composer-send-icon"
              aria-label={state.processing ? '加入消息队列' : '发送消息'}
              disabled={!composerReady || !draft.trim()}
            >
              <Icon name="arrow-up" size={17} />
            </button>
          </div>
        </div>
        {references.length > 0 || draftError || state.composer?.lastError ? (
          <div className="composer-footline">
            {references.length > 0 ? <span>{references.length} 个 Context 引用</span> : null}
            {draftError ? (
              <span role="alert">{draftError}</span>
            ) : state.composer?.lastError ? (
              <span role="alert">{state.composer.lastError.message}</span>
            ) : null}
          </div>
        ) : null}
      </form>
      {riskSelection ? (
        <RiskConfirmation
          kind={riskSelection}
          onCancel={() => setRiskSelection(null)}
          onConfirm={() => {
            const selected = riskSelection;
            setRiskSelection(null);
            if (selected === 'auto') consumeHandledAction(actions.setMode('auto'));
            else consumeHandledAction(actions.setPermissionOverride('allow'));
          }}
        />
      ) : null}
    </div>
  );
}

function ModelControls({
  state,
  actions,
  disabled,
}: {
  readonly state: WorkbenchState;
  readonly actions: WorkbenchActions;
  readonly disabled: boolean;
}) {
  const model = state.composer?.model;
  const effortOptions = ['auto', ...(model?.effort.supportedLevels ?? [])];
  return (
    <div className="model-control-cluster">
      <ModelMenu state={state} actions={actions} disabled={disabled} />
      {model?.effort.supported ? (
        <ControlMenu
          label={
            state.composer?.pending.model
              ? `${effortLabel(model.effort.requested)} → ${effortLabel(
                  state.composer.pending.model.effort
                )}`
              : effortLabel(model.effort.requested)
          }
          accessibleLabel="推理强度"
          disabled={disabled}
          value={model.effort.requested}
          options={effortOptions.map(value => ({
            value,
            label: effortLabel(value),
            detail: value === 'auto' ? '采用模型或项目默认值' : `请求 ${value} reasoning effort`,
          }))}
          onSelect={value =>
            consumeHandledAction(actions.selectModel(model.modelId, value as WebEffortPreferenceV1))
          }
        />
      ) : null}
    </div>
  );
}

function ModelMenu({
  state,
  actions,
  disabled,
}: {
  readonly state: WorkbenchState;
  readonly actions: WorkbenchActions;
  readonly disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const model = state.composer?.model;
  const catalog = state.modelCatalog;
  const label = state.composer?.pending.model
    ? `${model?.modelId ?? '模型'} → ${state.composer.pending.model.modelId}`
    : (model?.modelId ?? '模型');
  const normalizedQuery = query.trim().toLowerCase();
  const unavailableProviderIds = new Set(
    (catalog?.unavailableProviders ?? []).map(provider => provider.id)
  );
  const visibleModels = (catalog?.items ?? [])
    .filter(item => !unavailableProviderIds.has(item.providerId))
    .filter(item =>
      [item.id, item.label, item.providerId, item.providerLabel].some(value =>
        value.toLowerCase().includes(normalizedQuery)
      )
    )
    .slice(0, 80);
  const groups = new Map<string, typeof visibleModels>();
  for (const entry of visibleModels) {
    const key = entry.providerLabel || entry.providerId;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const close = () => {
    setOpen(false);
    setQuery('');
    trigger.current?.focus();
  };
  useDismissable(open, root, close);
  return (
    <div className="control-menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="composer-control-trigger"
        aria-label="会话模型"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          if (open) close();
          else {
            setOpen(true);
            if (!catalog) consumeHandledAction(actions.loadModelCatalog());
          }
        }}
      >
        <span>{label}</span>
        <Icon name="chevron" size={12} />
      </button>
      {open ? (
        <div
          className="control-menu-popover model-catalog-popover"
          role="menu"
          aria-label="会话模型"
          ref={menu}
          onKeyDown={event => handleMenuKeyDown(event, close)}
        >
          {(catalog?.items.length ?? 0) > 8 ? (
            <label className="model-catalog-search">
              <span className="sr-only">筛选模型</span>
              <input
                type="search"
                value={query}
                placeholder="筛选模型…"
                onChange={event => setQuery(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    focusFirstMenuItem(menu.current);
                  } else if (event.key === 'Escape') {
                    event.stopPropagation();
                    close();
                  }
                }}
              />
            </label>
          ) : null}
          {catalog === null ? <p role="status">正在加载模型…</p> : null}
          {catalog && visibleModels.length === 0 ? <p>没有匹配的可用模型</p> : null}
          {[...groups.entries()].map(([provider, entries]) => (
            <section key={provider} role="group" aria-label={provider}>
              <div className="model-provider-heading">{provider}</div>
              {entries.map(entry => (
                <button
                  key={entry.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={entry.id === model?.modelId}
                  onClick={() => {
                    close();
                    consumeHandledAction(actions.selectModel(entry.id));
                  }}
                >
                  <span>
                    <strong>{entry.label}</strong>
                    <small>
                      {formatTokens(entry.contextWindow)} context
                      {entry.reasoning ? ' · reasoning' : ''}
                    </small>
                  </span>
                  {entry.id === model?.modelId ? <Icon name="check" size={14} /> : null}
                </button>
              ))}
            </section>
          ))}
          {catalog?.unavailableProviders.map(provider => (
            <section key={provider.id} role="group" aria-label={`${provider.id} 不可用`}>
              <div className="model-provider-heading state-error">{provider.id} · 不可用</div>
              <p>{provider.reason}</p>
              <button
                type="button"
                role="menuitem"
                onClick={() => consumeHandledAction(actions.loadModelCatalog())}
              >
                Retry
              </button>
            </section>
          ))}
          {(catalog?.items.length ?? 0) > 80 && !normalizedQuery ? (
            <p>显示前 80 项；输入关键词继续筛选。</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ContextMeter({
  state,
  actions,
  disabled,
}: {
  readonly state: WorkbenchState;
  readonly actions: WorkbenchActions;
  readonly disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const usage = state.composer?.contextUsage;
  const percent = usage ? Math.max(0, Math.min(100, usage.percent)) : null;
  const estimated = usage?.source === 'estimated';
  const warning = Boolean(usage && usage.percent >= usage.warningThresholdPercent);
  useDismissable(open, root, () => {
    setOpen(false);
    trigger.current?.focus();
  });
  return (
    <div className="context-meter-wrap" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="context-meter-button"
        aria-label={
          usage
            ? `Context ${estimated ? '估算 ' : ''}${usage.usedTokens} / ${usage.safeInputBudget ?? usage.contextWindow} tokens，${usage.percent}%${warning ? '，接近压缩阈值' : ''}`
            : 'Context 用量不可用'
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(value => !value)}
      >
        <span
          className="context-meter-ring"
          style={{ '--context-percent': `${percent ?? 0}%` } as CSSProperties}
          aria-hidden="true"
        />
        <span>
          {usage ? `${estimated ? '~' : ''}${usage.percent}%${warning ? ' !' : ''}` : 'Context'}
        </span>
      </button>
      {open ? (
        <section className="context-popover" role="dialog" aria-label="Context 用量详情">
          <header>
            <strong>Context</strong>
            <button
              type="button"
              className="icon-button"
              onClick={() => setOpen(false)}
              aria-label="关闭 Context 详情"
            >
              <Icon name="close" size={14} />
            </button>
          </header>
          {usage ? (
            <dl>
              <div>
                <dt>当前模型</dt>
                <dd>{usage.modelId}</dd>
              </div>
              <div>
                <dt>已使用</dt>
                <dd>{formatTokens(usage.usedTokens)}</dd>
              </div>
              <div>
                <dt>安全输入预算</dt>
                <dd>{formatTokens(usage.safeInputBudget ?? usage.contextWindow)}</dd>
              </div>
              <div>
                <dt>原始窗口</dt>
                <dd>{formatTokens(usage.contextWindow)}</dd>
              </div>
              <div>
                <dt>输出预留</dt>
                <dd>{formatTokens(usage.reservedOutputTokens ?? 0)}</dd>
              </div>
              <div>
                <dt>安全余量</dt>
                <dd>{formatTokens(usage.safetyMarginTokens ?? 0)}</dd>
              </div>
              <div>
                <dt>来源</dt>
                <dd>{usage.source === 'estimated' ? '估算 ~' : usage.source}</dd>
              </div>
              <div>
                <dt>警告阈值</dt>
                <dd>{usage.warningThresholdPercent}%</dd>
              </div>
              <div>
                <dt>自动压缩</dt>
                <dd>
                  {usage.autoCompactEnabled ? `${usage.autoCompactThresholdPercent}%` : '关闭'}
                </dd>
              </div>
            </dl>
          ) : (
            <p>Runtime 尚未提供当前模型的 Context 计数。</p>
          )}
          {state.composer?.compactAvailable ? (
            <button
              type="button"
              className="secondary-button"
              disabled={!usage || state.processing}
              onClick={() => consumeHandledAction(actions.compactContext())}
            >
              立即压缩
            </button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function ContextLauncher({
  state,
  actions,
  disabled,
  references,
  onChange,
  onInsertCommand,
}: {
  readonly state: WorkbenchState;
  readonly actions: WorkbenchActions;
  readonly disabled: boolean;
  readonly references: readonly WebContextReferenceV1[];
  readonly onChange: (value: readonly WebContextReferenceV1[]) => void;
  readonly onInsertCommand: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'root' | 'files' | 'sessions' | 'skills'>('root');
  const [files, setFiles] = useState<readonly WebFileNodeV1[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useDismissable(open, root, () => setOpen(false));

  const add = (reference: WebContextReferenceV1) => {
    if (!references.some(item => item.kind === reference.kind && item.id === reference.id)) {
      onChange([...references, reference]);
    }
    setOpen(false);
    setView('root');
  };
  const loadFiles = async () => {
    setView('files');
    setLoading(true);
    setError('');
    try {
      const page = await actions.listFiles();
      setFiles(page.items.filter(item => item.readable && !item.sensitive));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '文件列表加载失败。');
    } finally {
      setLoading(false);
    }
  };
  const addFile = async (node: WebFileNodeV1) => {
    setLoading(true);
    setError('');
    try {
      if (isDirectoryLike(node)) {
        const page = await actions.listFiles(node.id);
        add({ kind: 'folder', id: node.id, label: node.name, revision: page.revision });
      } else if (isFileLike(node)) {
        const page = await actions.readFileContent(node.id);
        if (page.binary || page.sensitive) throw new Error('该文件不能加入模型 Context。');
        add({ kind: 'file', id: node.id, label: node.name, revision: page.revision });
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Context 引用加载失败。');
    } finally {
      setLoading(false);
    }
  };
  const addReview = async () => {
    setLoading(true);
    try {
      const review = await actions.review();
      add({
        kind: 'review',
        id: 'working-tree',
        label: review.truncated
          ? `Review · ${review.totalChangedFiles} files · ${review.changedFiles.length} visible`
          : `Review · ${review.totalChangedFiles} files`,
        gitRevision: review.repositoryRevision,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Review Context 加载失败。');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="control-menu context-launcher" ref={root}>
      <button
        type="button"
        className="context-add-button"
        aria-label="添加 Context"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) requestAnimationFrame(() => focusFirstMenuItem(menu.current));
        }}
      >
        <Icon name="add" size={17} />
      </button>
      {open ? (
        <div
          className="control-menu-popover context-launcher-menu"
          role="menu"
          aria-label="添加 Context"
          ref={menu}
          onKeyDown={event => handleMenuKeyDown(event, () => setOpen(false))}
        >
          {view !== 'root' ? (
            <button type="button" role="menuitem" onClick={() => setView('root')}>
              ← 返回
            </button>
          ) : null}
          {view === 'root' ? (
            <>
              <MenuAction
                label="文件或目录"
                detail="Workspace 内受控读取"
                onClick={() => void loadFiles()}
              />
              <MenuAction
                label="当前 Review"
                detail="绑定 exact Git revision"
                onClick={() => void addReview()}
              />
              <MenuAction
                label="历史 Session"
                detail="引用受控摘要"
                onClick={() => setView('sessions')}
              />
              <MenuAction
                label="Skill"
                detail="绑定已加载能力 digest"
                onClick={() => setView('skills')}
              />
              <MenuAction
                label="命令"
                detail="插入 / 命令入口"
                onClick={() => {
                  onInsertCommand();
                  setOpen(false);
                }}
              />
              {references.length > 0 ? (
                <MenuAction
                  label="清除 Context"
                  detail="移除当前草稿全部引用"
                  onClick={() => {
                    onChange([]);
                    setOpen(false);
                  }}
                />
              ) : null}
            </>
          ) : null}
          {view === 'files'
            ? files.map(file => (
                <MenuAction
                  key={file.id}
                  label={file.name}
                  detail={isDirectoryLike(file) ? '目录' : `${file.sizeBytes ?? 0} bytes`}
                  onClick={() => void addFile(file)}
                />
              ))
            : null}
          {view === 'sessions'
            ? state.sessions
                .filter(session => session.id !== state.activeSessionId)
                .map(session => (
                  <MenuAction
                    key={session.id}
                    label={session.name || `Session ${session.id.slice(0, 8)}`}
                    detail={`${session.messageCount} 条消息`}
                    onClick={() =>
                      add({
                        kind: 'session',
                        id: session.id,
                        label: session.name || `Session ${session.id.slice(0, 8)}`,
                        digest: session.contextDigest,
                      })
                    }
                  />
                ))
            : null}
          {view === 'skills'
            ? state.skills
                .filter(skill => skill.userInvocable)
                .map(skill => (
                  <MenuAction
                    key={skill.id}
                    label={skill.name}
                    detail={skill.description}
                    onClick={() =>
                      add({ kind: 'skill', id: skill.id, label: skill.name, digest: skill.digest })
                    }
                  />
                ))
            : null}
          {loading ? <p role="status">正在加载…</p> : null}
          {error ? <p role="alert">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function ContextTray({
  references,
  invalidReferenceKeys,
  onChange,
}: {
  readonly references: readonly WebContextReferenceV1[];
  readonly invalidReferenceKeys: ReadonlySet<string>;
  readonly onChange: (value: readonly WebContextReferenceV1[]) => void;
}) {
  return (
    <div className="context-tray" aria-label="当前 Context 引用">
      {references.map(reference => (
        <span
          className={`context-chip${invalidReferenceKeys.has(contextReferenceKey(reference)) ? ' state-stale' : ''}`}
          key={contextReferenceKey(reference)}
        >
          <small>{contextKindLabel(reference.kind)}</small>
          <span>{reference.label}</span>
          {invalidReferenceKeys.has(contextReferenceKey(reference)) ? (
            <span className="context-chip-state">已失效，请移除后重新添加</span>
          ) : null}
          <button
            type="button"
            aria-label={`移除 Context ${reference.label}`}
            onClick={() => onChange(references.filter(item => item !== reference))}
          >
            <Icon name="close" size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}

function PlanReviewCard({
  state,
  actions,
}: {
  readonly state: WorkbenchState;
  readonly actions: WorkbenchActions;
}) {
  const review = state.composer!.planReview!;
  const [continuing, setContinuing] = useState(false);
  const [feedback, setFeedback] = useState('');
  const disabled =
    Boolean(state.pendingAction) ||
    state.connection !== 'live' ||
    !isActiveSessionSnapshotReady(state);
  return (
    <section className="plan-review-card" aria-labelledby="plan-review-title">
      <div>
        <span className="eyebrow">PLAN REVIEW</span>
        <h2 id="plan-review-title">计划已保存，尚未执行</h2>
        <p>
          由 {review.createdModel} 创建 · digest {review.planDigest.slice(0, 12)}
        </p>
      </div>
      {continuing ? (
        <label>
          继续规划反馈
          <textarea rows={2} value={feedback} onChange={event => setFeedback(event.target.value)} />
        </label>
      ) : null}
      <div className="plan-review-actions">
        <button
          type="button"
          className="danger-ghost-button"
          disabled={disabled}
          onClick={() => consumeHandledAction(actions.reviewPlan(review.planDigest, 'cancel'))}
        >
          取消计划
        </button>
        {continuing ? (
          <button
            type="button"
            className="secondary-button"
            disabled={disabled || !feedback.trim()}
            onClick={() =>
              consumeHandledAction(
                actions.reviewPlan(review.planDigest, 'continue', feedback.trim())
              )
            }
          >
            提交反馈
          </button>
        ) : (
          <button
            type="button"
            className="secondary-button"
            disabled={disabled}
            onClick={() => setContinuing(true)}
          >
            继续规划
          </button>
        )}
        <button
          type="button"
          className="primary-button"
          disabled={disabled}
          onClick={() => consumeHandledAction(actions.reviewPlan(review.planDigest, 'approve'))}
        >
          批准并进入 BUILD
        </button>
      </div>
    </section>
  );
}

interface ControlOption {
  readonly value: string;
  readonly label: string;
  readonly detail: string;
}
function ControlMenu({
  label,
  accessibleLabel,
  value,
  options,
  disabled,
  emptyLabel,
  onOpen,
  onSelect,
}: {
  readonly label: string;
  readonly accessibleLabel: string;
  readonly value: string;
  readonly options: readonly ControlOption[];
  readonly disabled?: boolean;
  readonly emptyLabel?: string;
  readonly onOpen?: () => void;
  readonly onSelect: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const openMenu = () => {
    setOpen(true);
    onOpen?.();
    requestAnimationFrame(() => focusSelectedOrFirstMenuItem(menu.current));
  };
  useDismissable(open, root, close);
  return (
    <div className="control-menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="composer-control-trigger"
        aria-label={accessibleLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => {
          if (open) close();
          else openMenu();
        }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            openMenu();
          }
        }}
      >
        <span>{label}</span>
        <Icon name="chevron" size={12} />
      </button>
      {open ? (
        <div
          id={menuId}
          ref={menu}
          className="control-menu-popover"
          role="menu"
          aria-label={accessibleLabel}
          onKeyDown={event => handleMenuKeyDown(event, close)}
        >
          {options.length === 0 ? (
            <p>{emptyLabel ?? '没有选项'}</p>
          ) : (
            options.map(option => (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={option.value === value}
                onClick={() => {
                  close();
                  onSelect(option.value);
                }}
              >
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.detail}</small>
                </span>
                {option.value === value ? <Icon name="check" size={14} /> : null}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function MenuAction({
  label,
  detail,
  onClick,
}: {
  readonly label: string;
  readonly detail: string;
  readonly onClick: () => void;
}) {
  return (
    <button type="button" role="menuitem" onClick={onClick}>
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
    </button>
  );
}

function RiskConfirmation({
  kind,
  onCancel,
  onConfirm,
}: {
  readonly kind: Exclude<RiskSelection, null>;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const restore = document.querySelector<HTMLButtonElement>(
      kind === 'auto' ? '[aria-label="工作模式"]' : '[aria-label="会话权限"]'
    );
    cancel.current?.focus();
    return () => restore?.focus();
  }, [kind]);
  return (
    <div
      className="modal-backdrop"
      onPointerDown={event => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        ref={dialog}
        className="risk-confirmation"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="risk-title"
        aria-describedby="risk-description"
        onKeyDown={event => handleDialogKeyDown(event, dialog.current, onCancel)}
      >
        <h2 id="risk-title">{kind === 'auto' ? '启用 AUTO 模式？' : '启用会话 ALLOW？'}</h2>
        <p id="risk-description">
          {kind === 'auto'
            ? 'Orion 会自主执行多个步骤，但仍受 ToolGateway、沙箱与 Workspace containment 约束。'
            : '策略允许的工具将不再逐次询问；硬拒绝、沙箱和 Workspace 边界仍然生效。'}
        </p>
        <label>
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={event => setAcknowledged(event.target.checked)}
          />
          我理解这会扩大本会话的默认执行范围
        </label>
        <div>
          <button ref={cancel} type="button" className="secondary-button" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!acknowledged}
            onClick={onConfirm}
          >
            确认启用
          </button>
        </div>
      </section>
    </div>
  );
}

function menuItems(root: HTMLElement | null): HTMLButtonElement[] {
  return root
    ? [
        ...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"]'),
      ].filter(item => !item.disabled)
    : [];
}

function focusFirstMenuItem(root: HTMLElement | null): void {
  menuItems(root)[0]?.focus();
}

function focusSelectedOrFirstMenuItem(root: HTMLElement | null): void {
  const items = menuItems(root);
  (items.find(item => item.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
}

function handleMenuKeyDown(event: KeyboardEvent<HTMLElement>, close: () => void): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const items = menuItems(event.currentTarget);
  if (items.length === 0) return;
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const nextIndex =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (Math.max(0, current) + 1) % items.length
          : (current <= 0 ? items.length : current) - 1;
  items[nextIndex]?.focus();
}

function handleDialogKeyDown(
  event: KeyboardEvent<HTMLElement>,
  root: HTMLElement | null,
  close: () => void
): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
    return;
  }
  if (event.key !== 'Tab' || !root) return;
  const items = [
    ...root.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
    ),
  ];
  if (items.length === 0) return;
  const first = items[0];
  const last = items.at(-1)!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function useDismissable(open: boolean, root: RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [close, open, root]);
}

function modeLabel(mode: string): string {
  return mode === 'plan' ? 'PLAN' : mode === 'auto' ? 'AUTO' : 'BUILD';
}
function modeControlLabel(state: WorkbenchState): string {
  const mode = state.composer?.mode ?? state.mode;
  const current = modeLabel(mode.baseMode);
  return mode.pendingBaseMode ? `${current} → ${modeLabel(mode.pendingBaseMode)}` : current;
}
function permissionControlLabel(state: WorkbenchState): string {
  const permission = state.composer?.permission;
  const source = permission?.source === 'session' ? 'Session' : 'Project';
  const current = `${permission?.effective.toUpperCase() ?? 'ASK'} · ${source}`;
  if (
    (state.composer?.mode.baseMode ?? state.mode.baseMode) === 'auto' &&
    permission?.effective !== 'deny'
  ) {
    return 'AUTO · hard policy';
  }
  const pending = state.composer?.pending.permission;
  if (!pending) return current;
  return `${current} → ${(pending.override ?? permission?.projectDefault ?? 'ask').toUpperCase()} · Session`;
}
function effortLabel(value: string): string {
  return value === 'auto' ? 'Effort 自动' : `Effort ${value}`;
}
function isDirectoryLike(node: WebFileNodeV1): boolean {
  return node.kind === 'directory' || (node.kind === 'symlink' && node.targetKind === 'directory');
}
function isFileLike(node: WebFileNodeV1): boolean {
  return node.kind === 'file' || (node.kind === 'symlink' && node.targetKind === 'file');
}
function contextKindLabel(kind: WebContextReferenceV1['kind']): string {
  return kind === 'file'
    ? 'FILE'
    : kind === 'folder'
      ? 'FOLDER'
      : kind === 'review'
        ? 'REVIEW'
        : kind === 'session'
          ? 'SESSION'
          : 'SKILL';
}
function contextReferenceKey(reference: WebContextReferenceV1): string {
  return `${reference.kind}:${reference.id}`;
}

/** Workbench actions already project failures into the shared notice state. */
function consumeHandledAction(action: Promise<unknown>): void {
  void action.catch(() => undefined);
}

function formatTokens(value: number): string {
  return value >= 1_000 ? `${Math.round(value / 1_000)}k` : String(value);
}
