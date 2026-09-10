import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { WorkbenchActions } from '../useWorkbench';
import {
  activeSessionSnapshotSync,
  isActiveSessionSnapshotReady,
  type WebEditPreview,
  type WebResearch,
  type WebSubtask,
  type WebToolCall,
  type WebTranscriptEntry,
  type WorkbenchState,
} from '../types';
import { Icon, type IconName } from './Icon';
import { Markdown, safeJson, sanitizeDisplayText } from './Markdown';
import { StateDot } from './StateDot';
import { ComposerControlCenter } from './composer/ComposerControlCenter';
import { buildHistoryNavigation, type HistoryAnchor } from './history-navigation';
import { ConversationHistoryNavigator } from './ConversationHistoryNavigator';
import { useConversationHistoryNavigator } from './useConversationHistoryNavigator';
import { ToolOutputPreview } from './ToolOutputPreview';

const INITIAL_TIMELINE_WINDOW = 320;
const TIMELINE_PAGE = 300;

export interface ConversationProps {
  readonly state: WorkbenchState;
  readonly actions: WorkbenchActions;
  readonly onRevealSettings: () => void;
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
  onRevealSettings,
  onCreateSession,
  composerInsertion,
}: ConversationProps) {
  const snapshotSync = activeSessionSnapshotSync(state);
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
  // v0.3.13 — history navigator model + viewport observer binding.
  const [reduceMotion, setReduceMotion] = useState(false);
  const anchors = useMemo<readonly HistoryAnchor[]>(
    () =>
      timeline.map(toHistoryAnchor).filter((anchor): anchor is HistoryAnchor => anchor !== null),
    [timeline]
  );
  const historyModel = useMemo(() => buildHistoryNavigation(anchors), [anchors]);
  const history = useConversationHistoryNavigator({
    viewportRef: scrollRef,
    model: historyModel,
    activeSessionId: state.activeSessionId,
    onUserNavigate: () => {
      pinnedRef.current = false;
      setPinned(false);
    },
  });

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduceMotion(media.matches);
    const onChange = (event: MediaQueryListEvent) => setReduceMotion(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

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
      {!state.bootstrap?.configured ? (
        <div className="configuration-banner" role="status">
          <Icon name="warning" />
          <div>
            <strong>模型尚未配置</strong>
            <span>请在 Orion 配置文件或环境变量中设置凭证。API Key 不会进入浏览器。</span>
          </div>
          <button type="button" className="secondary-button" onClick={onRevealSettings}>
            转到设置
          </button>
        </div>
      ) : null}

      <div className="transcript-stage">
        <div
          className="transcript-viewport"
          ref={scrollRef}
          role="region"
          aria-label="会话记录"
          tabIndex={0}
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
            ) : snapshotSync.status === 'failed' && timeline.length === 0 ? (
              <EmptyConversation
                icon="warning"
                title="会话快照加载失败"
                detail={snapshotSync.error ?? '请重试当前会话快照。'}
              />
            ) : (snapshotSync.status === 'loading' || snapshotSync.status === 'refreshing') &&
              timeline.length === 0 ? (
              <EmptyConversation
                icon="refresh"
                title="正在同步会话"
                detail="本地 Web Host 正在读取最近的会话快照。"
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
                  <li
                    key={timelineKey(item)}
                    id={`conversation-item-${state.activeSessionId ?? 'none'}-${timelineKey(item)}`}
                    data-event-id={item.order}
                    data-order={item.order}
                    ref={element => history.registerItem(item.order, element)}
                  >
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
        <ConversationHistoryNavigator
          model={historyModel}
          activeOrder={history.activeOrder}
          span={history.span}
          hasEarlierHistory={allTimeline.length > timeline.length || hasRemoteHistory}
          processing={state.processing}
          reduceMotion={reduceMotion}
          onJumpToOrder={(order, behavior) => history.scrollToOrder(order, behavior)}
          onJumpToLatest={jumpToLatest}
        />
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
        <ComposerControlCenter state={state} actions={actions} insertion={composerInsertion} />
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

/**
 * v0.3.13 — maps one loaded timeline row onto the history rail's navigation
 * vocabulary. Transcript roles become user / assistant / system; tool, edit,
 * subtask and research rows map directly. Error conditions (tool failures,
 * failed research, command failures, error layers, budget stops) surface as
 * `error` priority so they always stay visible on the rail.
 */
function toHistoryAnchor(item: TimelineItem): HistoryAnchor | null {
  const order = item.order;
  const key = timelineKey(item);
  if (item.kind === 'tool') {
    return {
      order,
      key,
      kind: 'tool',
      label: firstLine(item.value.summary) || item.value.name,
      preview: previewText(item.value.summary),
      priority: item.value.state === 'error' ? 'error' : 'activity',
    };
  }
  if (item.kind === 'edit') {
    return {
      order,
      key,
      kind: 'edit',
      label: item.value.request.path,
      preview: previewText(`${item.value.request.path}\n${item.value.request.newString ?? ''}`),
      priority: 'activity',
    };
  }
  if (item.kind === 'subtask') {
    return {
      order,
      key,
      kind: 'subtask',
      label: firstLine(item.value.objective) || item.value.role,
      preview: previewText(item.value.summary || item.value.objective),
      priority: SUBTASK_FAILURE_STATES.has(item.value.state) ? 'error' : 'activity',
    };
  }
  if (item.kind === 'research') {
    return {
      order,
      key,
      kind: 'research',
      label: firstLine(item.value.objective) || 'Research',
      preview: previewText(item.value.conclusion || item.value.objective),
      priority: item.value.stage === 'failed' ? 'error' : 'activity',
    };
  }
  const entry = item.value;
  if (entry.toolActivity) {
    const activity = entry.toolActivity;
    return {
      order,
      key,
      kind: 'tool',
      label: firstLine(activity.summary) || activity.name || activity.detail || '工具活动',
      preview: previewText(activity.summary || activity.body),
      priority: activity.state === 'error' ? 'error' : 'activity',
    };
  }
  const role = entry.role;
  let priority: HistoryAnchor['priority'];
  if (role === 'user') {
    priority = 'turn';
  } else if (role === 'assistant') {
    priority = 'turn';
  } else {
    priority =
      role === 'error' || (role === 'command' && entry.command?.success === false)
        ? 'error'
        : 'activity';
  }
  if (entry.errorLayer || entry.budgetStop) priority = 'error';
  const kind: HistoryAnchor['kind'] =
    role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'system';
  return {
    order,
    key,
    kind,
    priority,
    label:
      firstLine(entry.content) ||
      entry.title ||
      (role === 'user' ? '用户任务' : role === 'assistant' ? 'Orion 回复' : roleLabel(role)),
    preview: previewText(entry.content),
  };
}

const SUBTASK_FAILURE_STATES: ReadonlySet<string> = new Set([
  'failed',
  'timed_out',
  'rejected',
  'cancelled',
]);

function firstLine(value: string | undefined): string | null {
  if (!value) return null;
  const line = value.replace(/\s+/gu, ' ').trim();
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

/** Hover-preview excerpt: first 280 chars with real line breaks preserved. */
function previewText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= 280 ? trimmed : `${trimmed.slice(0, 280)}…`;
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
          <StateDot state={entry.live ? 'running' : 'ready'} describe={false} />
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
    tool.workspaceMutation?.phase === 'queued'
      ? `等待工作树写入${tool.workspaceMutation.queuePosition ? `（第 ${tool.workspaceMutation.queuePosition} 位）` : ''}`
      : tool.workspaceMutation?.phase === 'running'
        ? '正在写入工作树'
        : tool.state === 'running'
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
            <ToolOutputPreview
              text={preview}
              defaultOpen={tool.state === 'error'}
              note={
                activity?.outputView?.omittedBytes
                  ? `另有 ${formatBytes(activity.outputView.omittedBytes)} 已折叠，可在 Inspector 中查看产物。`
                  : null
              }
            />
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
        <div className="tool-detail-section tool-output-section">
          <span className="micro-label">输出</span>
          <ToolOutputPreview
            text={activity.outputView?.preview || activity.body}
            defaultOpen={activity.state === 'error'}
            note={
              activity.outputView?.omittedBytes
                ? `另有 ${formatBytes(activity.outputView.omittedBytes)} 已折叠，可在 Inspector 中查看产物。`
                : null
            }
          />
        </div>
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
              <StateDot state={source.status} />
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

export function ApprovalCard({
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
  const disabled =
    Boolean(state.pendingAction) ||
    state.connection !== 'live' ||
    !isActiveSessionSnapshotReady(state);
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
          onClick={() => consumeHandledAction(actions.answerPermission(false))}
          disabled={disabled}
        >
          拒绝
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => consumeHandledAction(actions.answerPermission(true, 'once'))}
          disabled={disabled}
        >
          仅本次
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => consumeHandledAction(actions.answerPermission(true, 'project'))}
          disabled={disabled}
        >
          允许此项目
        </button>
        <button
          type="button"
          className="primary-button"
          onClick={() => consumeHandledAction(actions.answerPermission(true, 'global'))}
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
  const disabled =
    Boolean(state.pendingAction) ||
    state.connection !== 'live' ||
    !isActiveSessionSnapshotReady(state);
  return (
    <details className="queue-dock">
      <summary>
        <span>{state.queue.items.length} 条排队消息</span>
        <span>执行时采用最新 Composer 控制</span>
      </summary>
      <div className="queue-list">
        {state.queue.items.map((item, index) => (
          <QueueRow
            key={item.id}
            item={item}
            index={index}
            count={state.queue.items.length}
            disabled={disabled}
            actions={actions}
          />
        ))}
        <button
          type="button"
          className="text-button queue-clear"
          onClick={() => consumeHandledAction(actions.clearQueue())}
          disabled={disabled}
        >
          清空队列
        </button>
      </div>
    </details>
  );
}

function QueueRow({
  item,
  index,
  count,
  disabled,
  actions,
}: {
  readonly item: WorkbenchState['queue']['items'][number];
  readonly index: number;
  readonly count: number;
  readonly disabled: boolean;
  readonly actions: WorkbenchActions;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(item.text);
  useEffect(() => setValue(item.text), [item.text]);

  const save = async () => {
    const next = value.trim();
    if (!next) return;
    await actions.editQueued(item.id, item.revision, next);
    setEditing(false);
  };

  return (
    <div className="queue-row">
      <span className="queue-index">{index + 1}</span>
      {editing ? (
        <textarea
          rows={2}
          value={value}
          aria-label={`编辑排队消息 ${index + 1}`}
          onChange={event => setValue(event.target.value)}
        />
      ) : (
        <p>{item.text}</p>
      )}
      <div className="queue-row-actions">
        <button
          type="button"
          className="icon-button"
          aria-label={`上移排队消息 ${index + 1}`}
          onClick={() =>
            consumeHandledAction(actions.moveQueued(item.id, item.revision, index - 1))
          }
          disabled={disabled || index === 0}
        >
          <Icon name="arrow-up" size={13} />
        </button>
        <button
          type="button"
          className="icon-button queue-move-down"
          aria-label={`下移排队消息 ${index + 1}`}
          onClick={() =>
            consumeHandledAction(actions.moveQueued(item.id, item.revision, index + 1))
          }
          disabled={disabled || index === count - 1}
        >
          <Icon name="arrow-up" size={13} />
        </button>
        {editing ? (
          <button
            type="button"
            className="text-button"
            onClick={() => consumeHandledAction(save())}
            disabled={disabled || !value.trim()}
          >
            保存
          </button>
        ) : (
          <button
            type="button"
            className="text-button"
            onClick={() => setEditing(true)}
            disabled={disabled}
          >
            编辑
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label={`移除排队消息 ${index + 1}`}
          onClick={() => consumeHandledAction(actions.removeQueued(item.id, item.revision))}
          disabled={disabled}
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
    </div>
  );
}

function EmptyConversation({
  icon,
  title,
  detail,
  action,
  onAction,
}: {
  readonly icon: IconName;
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

/** Workbench actions already surface rejected operations through shared notices. */
function consumeHandledAction(action: Promise<unknown>): void {
  void action.catch(() => undefined);
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
