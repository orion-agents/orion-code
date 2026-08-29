import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import type { WorkbenchActions } from '../useWorkbench';
import type {
  WebEditPreview,
  WebResearch,
  WebSubtask,
  WebToolCall,
  WebTranscriptEntry,
  WorkbenchState,
} from '../types';
import { Icon } from './Icon';
import { Markdown, safeJson, sanitizeDisplayText } from './Markdown';
import { sessionTitle } from './WorkspaceRail';

const INITIAL_TIMELINE_WINDOW = 320;
const TIMELINE_PAGE = 300;

export interface ConversationProps {
  readonly state: WorkbenchState;
  readonly actions: WorkbenchActions;
  readonly navigationOpen: boolean;
  readonly inspectorExpanded: boolean;
  readonly settingsOpen: boolean;
  readonly onOpenNavigation: () => void;
  readonly onToggleInspector: () => void;
  readonly onOpenSettings: () => void;
  readonly onCreateSession: () => void;
  readonly composerInsertion: { readonly id: number; readonly text: string } | null;
}

type TimelineItem =
  | { readonly kind: 'transcript'; readonly order: number; readonly value: WebTranscriptEntry }
  | { readonly kind: 'tool'; readonly order: number; readonly value: WebToolCall }
  | { readonly kind: 'edit'; readonly order: number; readonly value: WebEditPreview }
  | { readonly kind: 'subtask'; readonly order: number; readonly value: WebSubtask }
  | { readonly kind: 'research'; readonly order: number; readonly value: WebResearch };

export function Conversation({
  state,
  actions,
  navigationOpen,
  inspectorExpanded,
  settingsOpen,
  onOpenNavigation,
  onToggleInspector,
  onOpenSettings,
  onCreateSession,
  composerInsertion,
}: ConversationProps) {
  const activeSession = state.sessions.find(session => session.id === state.activeSessionId);
  const allTimeline = useMemo(
    () => buildTimeline(state),
    [state.edits, state.research, state.subtasks, state.tools, state.transcript]
  );
  const [visibleCount, setVisibleCount] = useState(INITIAL_TIMELINE_WINDOW);
  const timeline = allTimeline.slice(-visibleCount);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const prependAnchor = useRef<{ height: number; top: number } | null>(null);
  const [pinned, setPinned] = useState(true);

  useEffect(() => {
    setVisibleCount(INITIAL_TIMELINE_WINDOW);
    pinnedRef.current = true;
    setPinned(true);
  }, [state.activeSessionId]);

  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    if (prependAnchor.current) {
      const anchor = prependAnchor.current;
      viewport.scrollTop = anchor.top + (viewport.scrollHeight - anchor.height);
      prependAnchor.current = null;
      return;
    }
    if (pinnedRef.current) viewport.scrollTop = viewport.scrollHeight;
  }, [timeline.length, state.processing]);

  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    const content = contentRef.current;
    if (!viewport || !content || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [state.activeSessionId]);

  const updatePinned = () => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const next = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 72;
    pinnedRef.current = next;
    setPinned(next);
  };

  const hasRemoteHistory = Boolean(state.sessionSnapshot?.transcript.nextCursor);
  const loadEarlier = async () => {
    const viewport = scrollRef.current;
    if (viewport)
      prependAnchor.current = { height: viewport.scrollHeight, top: viewport.scrollTop };
    if (allTimeline.length > timeline.length) {
      setVisibleCount(count => count + TIMELINE_PAGE);
      return;
    }
    if (hasRemoteHistory) {
      try {
        await actions.loadOlderTranscript();
        setVisibleCount(count => count + 100);
      } catch {
        prependAnchor.current = null;
      }
    }
  };

  const jumpToLatest = () => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    pinnedRef.current = true;
    setPinned(true);
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
  };

  return (
    <main className="conversation-column" id="main-content">
      <header className="conversation-header">
        <button
          type="button"
          className="icon-button mobile-nav-toggle"
          onClick={onOpenNavigation}
          aria-label="打开会话导航"
          aria-controls="workspace-rail"
          aria-expanded={navigationOpen}
        >
          <Icon name="menu" />
        </button>
        <div className="conversation-identity">
          <div className="title-line">
            <h1 tabIndex={-1}>{activeSession ? sessionTitle(activeSession) : 'Orion Code'}</h1>
            {state.processing ? <span className="running-pulse">运行中</span> : null}
          </div>
          <p title={state.workspace}>
            {activeSession?.model ??
              state.settings?.sections.defaults.model.effectiveValue ??
              '本地工作台'}{' '}
            · {basename(state.workspace)}
          </p>
        </div>
        <div className="header-actions">
          <StatusChip tone={state.processing ? 'active' : 'neutral'}>
            {modeLabel(state.mode.baseMode)}
            {state.mode.pendingBaseMode ? ` → ${modeLabel(state.mode.pendingBaseMode)}` : ''}
          </StatusChip>
          <StatusChip>
            {state.settings?.sections.permissions.toolConfirmation.effectiveValue.toUpperCase() ??
              'ASK'}
          </StatusChip>
          <button
            type="button"
            className="icon-button"
            onClick={onOpenSettings}
            aria-label="打开设置"
            aria-haspopup="dialog"
            aria-controls="settings-dialog"
            aria-expanded={settingsOpen}
          >
            <Icon name="settings" />
          </button>
          <button
            type="button"
            className="icon-button inspector-toggle"
            onClick={onToggleInspector}
            aria-label={inspectorExpanded ? '关闭工作面板' : '打开工作面板'}
            aria-controls="work-panel"
            aria-expanded={inspectorExpanded}
          >
            <Icon name="sidebar" />
          </button>
        </div>
      </header>

      {!state.bootstrap?.configured ? (
        <div className="configuration-banner" role="status">
          <Icon name="warning" />
          <div>
            <strong>模型尚未配置</strong>
            <span>请在 Orion 配置文件或环境变量中设置凭证。API Key 不会进入浏览器。</span>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={onOpenSettings}
            aria-haspopup="dialog"
            aria-controls="settings-dialog"
            aria-expanded={settingsOpen}
          >
            查看模型状态
          </button>
        </div>
      ) : null}

      <div
        className="transcript-viewport"
        ref={scrollRef}
        onScroll={updatePinned}
        aria-busy={state.processing}
      >
        <div className="transcript-content" ref={contentRef}>
          {allTimeline.length > timeline.length || hasRemoteHistory ? (
            <button
              type="button"
              className="load-history"
              onClick={() => void loadEarlier()}
              disabled={Boolean(state.pendingAction)}
            >
              {allTimeline.length > timeline.length
                ? `加载更早内容 · 还剩 ${allTimeline.length - timeline.length} 项`
                : '从持久记录加载更早内容'}
            </button>
          ) : null}

          {!state.activeSessionId ? (
            <EmptyConversation
              icon="workspace"
              title="选择或创建一个会话"
              detail="Orion 会在当前工作区运行，并沿用 CLI/TUI 的权限与持久化状态。"
              action="创建会话"
              onAction={onCreateSession}
            />
          ) : timeline.length === 0 ? (
            <EmptyConversation
              icon="spark"
              title="准备好开始了"
              detail="描述要构建、修复或调查的任务。Orion 会实时展示工具、文件变化与验证结果。"
            />
          ) : (
            <ol className="timeline" aria-label="会话记录">
              {timeline.map(item => (
                <li key={timelineKey(item)} data-event-id={item.order}>
                  {renderTimelineItem(item, state)}
                </li>
              ))}
            </ol>
          )}
          {state.processing ? (
            <div className="thinking-indicator" role="status">
              <span />
              <span />
              <span />
              <span>{state.statusMessage || 'Orion 正在处理…'}</span>
            </div>
          ) : null}
        </div>
      </div>

      {!pinned && timeline.length > 0 ? (
        <button type="button" className="jump-latest" onClick={jumpToLatest}>
          <Icon name="arrow-up" size={15} />
          回到最新
        </button>
      ) : null}

      <div className="input-dock">
        {state.permission || state.queue.items.length > 0 ? (
          <div className="input-transients">
            {state.permission ? <ApprovalCard state={state} actions={actions} /> : null}
            {state.queue.items.length > 0 ? <QueueDock state={state} actions={actions} /> : null}
          </div>
        ) : null}
        <Composer state={state} actions={actions} insertion={composerInsertion} />
      </div>
    </main>
  );
}

function buildTimeline(state: WorkbenchState): TimelineItem[] {
  const toolIds = new Set(state.tools.map(tool => tool.callId));
  const transcript = state.transcript
    .filter(entry => !entry.toolActivity?.callId || !toolIds.has(entry.toolActivity.callId))
    .map(value => ({ kind: 'transcript' as const, order: value.order, value }));
  return [
    ...transcript,
    ...state.tools.map(value => ({ kind: 'tool' as const, order: value.order, value })),
    ...state.edits.map(value => ({ kind: 'edit' as const, order: value.order, value })),
    ...state.subtasks.map(value => ({ kind: 'subtask' as const, order: value.order, value })),
    ...state.research.map(value => ({ kind: 'research' as const, order: value.order, value })),
  ].sort((left, right) => left.order - right.order);
}

function timelineKey(item: TimelineItem): string {
  if (item.kind === 'transcript') return `entry-${item.value.id}`;
  if (item.kind === 'tool') return `tool-${item.value.callId}`;
  if (item.kind === 'edit') return `edit-${item.order}`;
  if (item.kind === 'subtask') return `subtask-${item.value.taskId}`;
  return `research-${item.value.packetId}`;
}

function renderTimelineItem(item: TimelineItem, state: WorkbenchState) {
  if (item.kind === 'transcript') return <TranscriptCard entry={item.value} />;
  if (item.kind === 'tool') {
    const activity = state.transcript.find(
      entry => entry.toolActivity?.callId === item.value.callId
    )?.toolActivity;
    return <ToolCard tool={item.value} activity={activity} />;
  }
  if (item.kind === 'edit') return <EditCard edit={item.value} />;
  if (item.kind === 'subtask') return <SubtaskCard subtask={item.value} />;
  return <ResearchCard research={item.value} />;
}

function TranscriptCard({ entry }: { readonly entry: WebTranscriptEntry }) {
  if (entry.toolActivity) return <StandaloneToolActivity entry={entry} />;
  if (isReasoning(entry)) {
    return (
      <details className="reasoning-card">
        <summary>
          <span className={`state-dot ${entry.live ? 'running' : 'ready'}`} aria-hidden="true" />
          <span>{entry.live ? '正在分析' : entry.title || '推理摘要'}</span>
          <span className="reasoning-hint">展开查看 Runtime 提供的摘要</span>
        </summary>
        <Markdown>{entry.content}</Markdown>
      </details>
    );
  }
  const role = entry.role;
  return (
    <article className={`message-card role-${role}`} aria-label={roleLabel(role)}>
      <header>
        <span className="message-avatar" aria-hidden="true">
          {roleGlyph(role)}
        </span>
        <span>{entry.title || roleLabel(role)}</span>
        {entry.live ? <span className="streaming-label">生成中</span> : null}
        {entry.command ? (
          <span className={`command-state ${entry.command.success ? 'success' : 'error'}`}>
            {entry.command.success ? '成功' : '失败'}
          </span>
        ) : null}
      </header>
      <div className="message-body">
        {role === 'user' ? (
          <p className="literal-message">{entry.content}</p>
        ) : (
          <Markdown>{entry.content}</Markdown>
        )}
      </div>
      {entry.budgetStop ? (
        <div className="budget-stop" role="status">
          <Icon name="pause" size={15} />
          <span>{entry.budgetStop.reason} · 状态已保留</span>
        </div>
      ) : null}
    </article>
  );
}

function ToolCard({
  tool,
  activity,
}: {
  readonly tool: WebToolCall;
  readonly activity?: WebTranscriptEntry['toolActivity'];
}) {
  const stateLabel =
    tool.state === 'running'
      ? '运行中'
      : tool.state === 'success'
        ? '完成'
        : tool.state === 'skipped'
          ? '跳过'
          : '失败';
  const preview = activity?.outputView?.preview || activity?.body || tool.error || tool.summary;
  return (
    <article
      className={`tool-card tool-${tool.state}`}
      aria-label={`工具 ${tool.name}：${stateLabel}`}
    >
      <div className="tool-card-header">
        <span className={`tool-state-icon ${tool.state}`} aria-hidden="true">
          {tool.state === 'running' ? (
            <span className="spinner" />
          ) : (
            <Icon
              name={
                tool.state === 'success' ? 'check' : tool.state === 'skipped' ? 'pause' : 'warning'
              }
              size={15}
            />
          )}
        </span>
        <div className="tool-title">
          <strong>{tool.name}</strong>
          <span>
            #{tool.sequence} · {stateLabel}
            {tool.duration !== undefined ? ` · ${formatDuration(tool.duration)}` : ''}
          </span>
        </div>
        {tool.outputBytes !== undefined ? (
          <span className="byte-pill">{formatBytes(tool.outputBytes)}</span>
        ) : null}
      </div>
      {tool.summary || tool.error ? (
        <p className={tool.error ? 'tool-error-copy' : 'tool-summary'}>
          {sanitizeDisplayText(tool.error || tool.summary || '')}
        </p>
      ) : null}
      <details className="tool-details" open={tool.state === 'error'}>
        <summary>输入与详情</summary>
        <dl className="tool-meta-grid">
          <div>
            <dt>授权</dt>
            <dd>
              {tool.authorization
                ? `${tool.authorization.approved ? '允许' : '拒绝'} · ${tool.authorization.source}`
                : '等待 Runtime 记录'}
            </dd>
          </div>
          {tool.artifactId ? (
            <div>
              <dt>产物</dt>
              <dd>
                <code>{tool.artifactId}</code>
              </dd>
            </div>
          ) : null}
        </dl>
        <div className="tool-detail-section">
          <span className="micro-label">参数（已脱敏）</span>
          <pre tabIndex={0}>{safeJson(tool.args)}</pre>
        </div>
        {preview ? (
          <div className="tool-detail-section">
            <span className="micro-label">输出预览</span>
            <pre tabIndex={0}>{sanitizeDisplayText(preview)}</pre>
            {activity?.outputView?.omittedBytes ? (
              <p className="truncation-note">
                另有 {formatBytes(activity.outputView.omittedBytes)} 已折叠，可在 Inspector
                中查看产物。
              </p>
            ) : null}
          </div>
        ) : null}
      </details>
    </article>
  );
}

function StandaloneToolActivity({ entry }: { readonly entry: WebTranscriptEntry }) {
  const activity = entry.toolActivity!;
  return (
    <article className={`tool-card tool-${activity.state}`}>
      <div className="tool-card-header">
        <span className={`tool-state-icon ${activity.state}`} aria-hidden="true">
          <Icon name="terminal" size={15} />
        </span>
        <div className="tool-title">
          <strong>{activity.name}</strong>
          <span>{activity.detail}</span>
        </div>
      </div>
      {activity.summary ? <p className="tool-summary">{activity.summary}</p> : null}
      {activity.outputView?.preview || activity.body ? (
        <pre tabIndex={0}>
          {sanitizeDisplayText(activity.outputView?.preview || activity.body || '')}
        </pre>
      ) : null}
    </article>
  );
}

function EditCard({ edit }: { readonly edit: WebEditPreview }) {
  const request = edit.request;
  return (
    <article className="edit-card">
      <header>
        <span className="edit-icon">
          <Icon name="edit" size={15} />
        </span>
        <div>
          <strong>文件修改预览</strong>
          <span>
            {request.kind} · {request.candidates.length} 个候选
          </span>
        </div>
      </header>
      <code className="path-chip" title={request.path}>
        {request.path}
      </code>
      <details>
        <summary>查看替换内容</summary>
        <pre tabIndex={0}>{sanitizeDisplayText(request.newString)}</pre>
      </details>
    </article>
  );
}

function SubtaskCard({ subtask }: { readonly subtask: WebSubtask }) {
  return (
    <details className={`activity-card subtask-card state-${subtask.state}`}>
      <summary>
        <Icon name="branch" size={16} />
        <span>
          <strong>{subtask.role}</strong>
          <small>{subtask.state}</small>
        </span>
        {subtask.durationMs !== undefined ? (
          <time>{formatDuration(subtask.durationMs)}</time>
        ) : null}
      </summary>
      <p>{subtask.objective}</p>
      {subtask.summary ? <Markdown>{subtask.summary}</Markdown> : null}
    </details>
  );
}

function ResearchCard({ research }: { readonly research: WebResearch }) {
  return (
    <details className={`activity-card research-card state-${research.stage}`}>
      <summary>
        <Icon name="search" size={16} />
        <span>
          <strong>Research</strong>
          <small>
            {research.stage} · {research.sources.length} sources
          </small>
        </span>
      </summary>
      {research.objective ? <p>{research.objective}</p> : null}
      {research.conclusion ? <Markdown>{research.conclusion}</Markdown> : null}
      {research.sources.length > 0 ? (
        <ul className="source-list">
          {research.sources.map(source => (
            <li key={source.id}>
              <span className={`state-dot state-${source.status}`} aria-hidden="true" />
              <span>{source.title || source.location || source.id}</span>
              <small>
                {source.provider} · {source.status}
              </small>
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}

function ApprovalCard({
  state,
  actions,
}: {
  readonly state: WorkbenchState;
  readonly actions: WorkbenchActions;
}) {
  const request = state.permission!;
  const cardRef = useRef<HTMLElement>(null);
  const previousRequest = useRef('');
  useEffect(() => {
    if (previousRequest.current === request.id) return;
    previousRequest.current = request.id;
    cardRef.current?.focus();
  }, [request.id]);
  const disabled = Boolean(state.pendingAction) || state.connection !== 'live';
  return (
    <section
      ref={cardRef}
      className="approval-card"
      role="region"
      aria-live="assertive"
      aria-labelledby="approval-title"
      aria-describedby="approval-reason"
      tabIndex={-1}
    >
      <div className="approval-heading">
        <span className="approval-icon">
          <Icon name="warning" size={17} />
        </span>
        <div>
          <span className="eyebrow">需要你的确认</span>
          <h2 id="approval-title">允许 {request.name}？</h2>
        </div>
      </div>
      <p id="approval-reason">{request.reason || '该工具需要在当前权限策略下获得明确授权。'}</p>
      <details className="approval-args">
        <summary>查看脱敏参数</summary>
        <pre tabIndex={0}>{safeJson(request.args, 6_000)}</pre>
      </details>
      <div className="approval-actions">
        <button
          type="button"
          className="danger-ghost-button"
          onClick={() => void actions.answerPermission(false)}
          disabled={disabled}
        >
          拒绝
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => void actions.answerPermission(true, 'once')}
          disabled={disabled}
        >
          仅本次
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => void actions.answerPermission(true, 'project')}
          disabled={disabled}
        >
          允许此项目
        </button>
        <button
          type="button"
          className="primary-button"
          onClick={() => void actions.answerPermission(true, 'global')}
          disabled={disabled}
        >
          始终允许
        </button>
      </div>
      <p className="approval-footnote">项目与全局授权会写入 Orion 配置；拒绝不会丢失当前会话。</p>
    </section>
  );
}

function QueueDock({
  state,
  actions,
}: {
  readonly state: WorkbenchState;
  readonly actions: WorkbenchActions;
}) {
  const disabled = Boolean(state.pendingAction) || state.connection !== 'live';
  return (
    <details className="queue-dock">
      <summary>
        <span>{state.queue.items.length} 条排队消息</span>
        <span>当前请求完成后执行</span>
      </summary>
      <div className="queue-list">
        {state.queue.items.map((item, index) => (
          <div className="queue-row" key={item.id}>
            <span className="queue-index">{index + 1}</span>
            <p>{item.text}</p>
            <button
              type="button"
              className="icon-button"
              aria-label={`移除排队消息 ${index + 1}`}
              onClick={() => void actions.removeQueued(item.id)}
              disabled={disabled}
            >
              <Icon name="trash" size={14} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="text-button queue-clear"
          onClick={() => void actions.clearQueue()}
          disabled={disabled}
        >
          清空队列
        </button>
      </div>
    </details>
  );
}

function Composer({
  state,
  actions,
  insertion,
}: {
  readonly state: WorkbenchState;
  readonly actions: WorkbenchActions;
  readonly insertion: { readonly id: number; readonly text: string } | null;
}) {
  const [draft, setDraft] = useState('');
  const drafts = useRef(new Map<string, string>());
  const activeSessionRef = useRef(state.activeSessionId);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const disabled =
    !state.activeSessionId || !state.bootstrap?.configured || state.connection !== 'live';
  const pending = Boolean(state.pendingAction);
  const composerReady = !disabled && !pending;
  activeSessionRef.current = state.activeSessionId;

  useEffect(() => {
    const sessionId = state.activeSessionId;
    setDraft(sessionId ? (drafts.current.get(sessionId) ?? '') : '');
  }, [state.activeSessionId]);

  useEffect(() => {
    if (!insertion || !state.activeSessionId) return;
    setDraft(current => {
      const next = current.trim() ? `${current.trimEnd()}\n\n${insertion.text}` : insertion.text;
      drafts.current.set(state.activeSessionId as string, next);
      return next;
    });
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [insertion, state.activeSessionId]);

  const deliver = async (mode: 'submit' | 'queue') => {
    const text = draft.trim();
    if (!text || !composerReady) return;
    const sessionId = state.activeSessionId;
    try {
      if (mode === 'queue') await actions.queue(text);
      else await actions.submit(text);
      if (sessionId) drafts.current.delete(sessionId);
      if (activeSessionRef.current === sessionId) setDraft('');
      textareaRef.current?.focus();
    } catch {
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
    <form className="composer" onSubmit={onSubmit}>
      <label htmlFor="orion-composer" className="sr-only">
        发送给 Orion
      </label>
      <textarea
        ref={textareaRef}
        id="orion-composer"
        rows={3}
        maxLength={1_000_000}
        value={draft}
        onChange={event => {
          const next = event.target.value;
          setDraft(next);
          if (state.activeSessionId) drafts.current.set(state.activeSessionId, next);
        }}
        onKeyDown={onKeyDown}
        placeholder={
          pending
            ? '正在完成会话切换…'
            : disabled
              ? '选择会话并配置模型后开始'
              : state.processing
                ? '输入后续消息；Enter 排队，⌘/Ctrl+Enter Steer'
                : '描述任务，或输入 / 查看命令…'
        }
        disabled={!composerReady}
      />
      <div className="composer-toolbar">
        <div className="composer-controls">
          <fieldset className="mode-selector" disabled={!composerReady}>
            <legend className="sr-only">Agent 模式</legend>
            {(['interactive', 'plan', 'auto'] as const).map(mode => (
              <button
                key={mode}
                type="button"
                className={state.mode.baseMode === mode ? 'active' : ''}
                aria-pressed={state.mode.baseMode === mode}
                onClick={() => void actions.setMode(mode)}
              >
                <span className={`mode-dot mode-${mode}`} aria-hidden="true" />
                {modeLabel(mode)}
              </button>
            ))}
          </fieldset>
          <span className="composer-hint">Shift+Enter 换行</span>
        </div>
        <div className="composer-actions">
          {state.processing ? (
            <>
              <button
                type="button"
                className="icon-text-button stop-button"
                onClick={() => void actions.interrupt()}
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
          <button
            type="submit"
            className="send-button"
            aria-label={state.processing ? '加入消息队列' : '发送消息'}
            disabled={!composerReady || !draft.trim()}
          >
            <span>{state.processing ? '排队' : '发送'}</span>
            <Icon name="arrow-up" size={16} />
          </button>
        </div>
      </div>
    </form>
  );
}

function EmptyConversation({
  icon,
  title,
  detail,
  action,
  onAction,
}: {
  readonly icon: 'workspace' | 'spark';
  readonly title: string;
  readonly detail: string;
  readonly action?: string;
  readonly onAction?: () => void;
}) {
  return (
    <section className="empty-conversation">
      <div className="empty-orbit">
        <Icon name={icon} size={26} />
      </div>
      <h2>{title}</h2>
      <p>{detail}</p>
      {action && onAction ? (
        <button type="button" className="primary-button" onClick={onAction}>
          {action}
        </button>
      ) : null}
    </section>
  );
}

function StatusChip({
  children,
  tone = 'neutral',
}: {
  readonly children: ReactNode;
  readonly tone?: 'neutral' | 'active';
}) {
  return <span className={`status-chip ${tone}`}>{children}</span>;
}

function isReasoning(entry: WebTranscriptEntry): boolean {
  const label = `${entry.title ?? ''}`.toLocaleLowerCase();
  return (
    label.includes('reason') ||
    label.includes('think') ||
    label.includes('analysis') ||
    label.includes('推理') ||
    label.includes('思考')
  );
}

function roleLabel(role: WebTranscriptEntry['role']): string {
  if (role === 'user') return '你';
  if (role === 'assistant') return 'Orion';
  if (role === 'command') return '命令';
  if (role === 'error') return '错误';
  if (role === 'system') return '系统';
  if (role === 'status') return '状态';
  return '工具';
}

function roleGlyph(role: WebTranscriptEntry['role']): string {
  if (role === 'user') return 'Y';
  if (role === 'assistant') return 'O';
  if (role === 'error') return '!';
  if (role === 'command') return '›';
  return '·';
}

export function modeLabel(mode: string): string {
  if (mode === 'plan') return 'PLAN';
  if (mode === 'auto') return 'AUTO';
  return 'BUILD';
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function basename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? normalized;
}
