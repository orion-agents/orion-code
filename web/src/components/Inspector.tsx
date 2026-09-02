import {
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';

import type { WorkbenchActions } from '../useWorkbench';
import {
  activeSessionSnapshotSync,
  isActiveSessionSnapshotReady,
  type WebToolCall,
  type WorkbenchState,
} from '../types';
import { Icon } from './Icon';
import { Markdown, safeJson, sanitizeDisplayText } from './Markdown';

export type AgentPanelTab = 'goal' | 'activity' | 'integrations' | 'diagnostics';

const TABS: ReadonlyArray<{
  readonly id: AgentPanelTab;
  readonly label: string;
  readonly icon: 'goal' | 'activity' | 'branch' | 'diagnostics';
}> = [
  { id: 'goal', label: 'Goal', icon: 'goal' },
  { id: 'activity', label: '活动', icon: 'activity' },
  { id: 'integrations', label: '能力', icon: 'branch' },
  { id: 'diagnostics', label: '诊断', icon: 'diagnostics' },
];

export interface AgentPanelProps {
  readonly state: WorkbenchState;
  readonly actions: WorkbenchActions;
  readonly tab: AgentPanelTab;
  readonly onTabChange: (tab: AgentPanelTab) => void;
}

export function AgentPanel({ state, actions, tab, onTabChange }: AgentPanelProps) {
  const panelId = useId();

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== 'ArrowLeft' &&
      event.key !== 'ArrowRight' &&
      event.key !== 'Home' &&
      event.key !== 'End'
    )
      return;
    event.preventDefault();
    const current = TABS.findIndex(item => item.id === tab);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? TABS.length - 1
          : (current + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    onTabChange(TABS[next].id);
    requestAnimationFrame(() =>
      document.getElementById(`${panelId}-tab-${TABS[next].id}`)?.focus()
    );
  };

  return (
    <div className="agent-panel">
        <div
          className="inspector-tabs"
          role="tablist"
          aria-label="详情类别"
          onKeyDown={onTabKeyDown}
        >
          {TABS.map(item => (
            <button
              id={`${panelId}-tab-${item.id}`}
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              aria-controls={`${panelId}-panel`}
              tabIndex={tab === item.id ? 0 : -1}
              onClick={() => onTabChange(item.id)}
            >
              <Icon name={item.icon} size={15} />
              <span>{item.label}</span>
            </button>
          ))}
        </div>
        <div
          id={`${panelId}-panel`}
          className="inspector-body"
          role="tabpanel"
          aria-labelledby={`${panelId}-tab-${tab}`}
          tabIndex={0}
        >
          {tab === 'goal' ? <GoalPanel state={state} actions={actions} /> : null}
          {tab === 'activity' ? <ActivityPanel state={state} actions={actions} /> : null}
          {tab === 'integrations' ? <IntegrationsPanel state={state} actions={actions} /> : null}
          {tab === 'diagnostics' ? <DiagnosticsPanel state={state} actions={actions} /> : null}
        </div>
    </div>
  );
}

function GoalPanel({
  state,
  actions,
}: {
  readonly state: WorkbenchState;
  readonly actions: WorkbenchActions;
}) {
  const goal = state.goal;
  const plan =
    state.plan?.body ?? (typeof state.diagnostics?.plan === 'string' ? state.diagnostics.plan : '');
  const pending = Boolean(state.pendingAction);
  const commandBlocked =
    pending || state.connection !== 'live' || !isActiveSessionSnapshotReady(state);
  if (!goal) {
    return (
      <div className="inspector-stack">
        <section className="inspector-empty-card">
          <div className="empty-mini-icon">
            <Icon name="goal" />
          </div>
          <h3>没有活动 Goal</h3>
          <p>Goal 会跨回合保存目标、计划、证据和预算状态。</p>
        </section>
        <GoalCreateForm
          onCreate={objective => actions.controlGoal('create', objective)}
          disabled={commandBlocked || !state.activeSessionId}
        />
        <PlanSection mode={state.mode.baseMode} plan={plan} />
      </div>
    );
  }

  const progress = goal.criteria?.total
    ? Math.round((goal.criteria.passed / goal.criteria.total) * 100)
    : 0;
  return (
    <div className="inspector-stack">
      <section className="goal-card">
        <header>
          <span className={`goal-status status-${goal.status}`}>
            {goal.status.replace(/_/g, ' ')}
          </span>
          <span>rev {goal.revision}</span>
        </header>
        <h3>{goal.objective}</h3>
        {goal.criteria ? (
          <div className="goal-progress">
            <div>
              <span>成功条件</span>
              <strong>
                {goal.criteria.passed} / {goal.criteria.total}
              </strong>
            </div>
            <progress
              value={goal.criteria.passed}
              max={Math.max(1, goal.criteria.total)}
              aria-label={`Goal 条件完成 ${progress}%`}
            />
            <div className="goal-breakdown">
              <span>{progress}% 完成</span>
              <span>
                {goal.criteria.failed} 失败 · {goal.criteria.stale} 过期
              </span>
            </div>
          </div>
        ) : null}
        <dl className="metric-grid">
          <div>
            <dt>Tokens</dt>
            <dd>
              {formatNumber(goal.tokensUsed)}
              {goal.tokenBudget ? ` / ${formatNumber(goal.tokenBudget)}` : ''}
            </dd>
          </div>
          <div>
            <dt>用时</dt>
            <dd>{formatElapsed(goal.timeUsedMs)}</dd>
          </div>
          <div>
            <dt>续跑</dt>
            <dd>{goal.continuationCount}</dd>
          </div>
          <div>
            <dt>Plan</dt>
            <dd>{goal.planRevision ? `r${goal.planRevision}` : '—'}</dd>
          </div>
        </dl>
        {goal.nextAction ? (
          <div className="next-action">
            <span>下一步</span>
            <p>{goal.nextAction}</p>
          </div>
        ) : null}
        {goal.auditRemaining?.length ? (
          <details className="remaining-audit">
            <summary>仍需验证 {goal.auditRemaining.length} 项</summary>
            <ul>
              {goal.auditRemaining.map((item, index) => (
                <li key={`${item}-${index}`}>{item}</li>
              ))}
            </ul>
          </details>
        ) : null}
        <div className="goal-actions">
          {goal.status === 'active' ? (
            <button
              type="button"
              className="secondary-button"
              onClick={() => void actions.controlGoal('pause')}
              disabled={commandBlocked}
            >
              <Icon name="pause" size={14} />
              暂停
            </button>
          ) : goal.status !== 'complete' ? (
            <button
              type="button"
              className="secondary-button"
              onClick={() => void actions.controlGoal('resume')}
              disabled={commandBlocked}
            >
              <Icon name="refresh" size={14} />
              恢复
            </button>
          ) : null}
          <button
            type="button"
            className="danger-ghost-button"
            onClick={() => {
              if (window.confirm('清除此 Goal？会话记录仍会保留。'))
                void actions.controlGoal('clear');
            }}
            disabled={commandBlocked}
          >
            清除
          </button>
        </div>
      </section>

      {state.goalEvidence.length > 0 ? (
        <section className="inspector-section">
          <div className="inspector-section-heading">
            <h3>最近证据</h3>
            <span>{state.goalEvidence.length}</span>
          </div>
          <ul className="evidence-list">
            {state.goalEvidence
              .slice(-8)
              .reverse()
              .map(item => (
                <li key={item.id}>
                  <span className={`evidence-state ${item.result}`} aria-hidden="true">
                    <Icon
                      name={
                        item.result === 'passed'
                          ? 'check'
                          : item.result === 'failed'
                            ? 'close'
                            : 'more'
                      }
                      size={12}
                    />
                  </span>
                  <div>
                    <strong>{item.subject}</strong>
                    <span>
                      {item.kind} · {item.result}
                    </span>
                  </div>
                </li>
              ))}
          </ul>
        </section>
      ) : null}

      <PlanSection mode={state.mode.baseMode} plan={plan} goalPhase={goal.planPhase} />

      {state.goalActivity.length > 0 ? (
        <section className="inspector-section">
          <div className="inspector-section-heading">
            <h3>Goal 轨迹</h3>
          </div>
          <ol className="compact-timeline">
            {state.goalActivity
              .slice(-10)
              .reverse()
              .map((item, index) => (
                <li key={`${item.timestamp}-${index}`}>
                  <span className="timeline-pin" aria-hidden="true" />
                  <div>
                    <strong>{item.type.replace(/_/g, ' ')}</strong>
                    <p>{item.message}</p>
                    <time>{formatClock(item.timestamp)}</time>
                  </div>
                </li>
              ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

function GoalCreateForm({
  onCreate,
  disabled,
}: {
  readonly onCreate: (objective: string) => Promise<void>;
  readonly disabled: boolean;
}) {
  const [objective, setObjective] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!objective.trim()) return;
    try {
      await onCreate(objective.trim());
      setObjective('');
    } catch {
      // The persistent notice carries the actionable error.
    }
  };
  return (
    <form className="goal-create" onSubmit={submit}>
      <label htmlFor="goal-objective">创建 Goal</label>
      <textarea
        id="goal-objective"
        rows={3}
        value={objective}
        onChange={event => setObjective(event.target.value)}
        placeholder="输入一个可验证、可持续执行的目标…"
        disabled={disabled}
      />
      <button type="submit" className="primary-button" disabled={disabled || !objective.trim()}>
        <Icon name="goal" size={15} />
        开始 Goal
      </button>
    </form>
  );
}

function PlanSection({
  mode,
  plan,
  goalPhase,
}: {
  readonly mode: string;
  readonly plan: string;
  readonly goalPhase?: string;
}) {
  return (
    <section className="inspector-section plan-section">
      <div className="inspector-section-heading">
        <h3>Plan</h3>
        <span className={`mode-badge mode-${mode}`}>
          {mode === 'plan' ? 'PLAN MODE' : goalPhase || 'READ ONLY'}
        </span>
      </div>
      {plan ? (
        <Markdown>{plan}</Markdown>
      ) : (
        <p className="muted-copy">
          还没有保存的计划。切换到 PLAN 模式后提交任务，Runtime 会生成并保存计划。
        </p>
      )}
    </section>
  );
}

function ActivityPanel({
  state,
  actions,
}: {
  readonly state: WorkbenchState;
  readonly actions: WorkbenchActions;
}) {
  const changes = useMemo(() => state.tools.filter(tool => isChangeTool(tool)), [state.tools]);
  return (
    <div className="inspector-stack">
      <section className="inspector-section">
        <div className="inspector-section-heading">
          <h3>工具调用</h3>
          <span>{state.tools.length}</span>
        </div>
        {state.tools.length ? (
          <ul className="activity-list">
            {state.tools
              .slice(-20)
              .reverse()
              .map(tool => (
                <ToolActivityRow key={tool.callId} tool={tool} />
              ))}
          </ul>
        ) : (
          <EmptySmall text="还没有工具活动" />
        )}
      </section>
      <ToolDetailsSection state={state} actions={actions} />
      <section className="inspector-section">
        <div className="inspector-section-heading">
          <h3>文件变化</h3>
          <span>{changes.length + state.edits.length}</span>
        </div>
        {changes.length || state.edits.length ? (
          <ul className="change-list">
            {state.edits
              .slice(-8)
              .reverse()
              .map(edit => (
                <li key={edit.eventId}>
                  <Icon name="edit" size={14} />
                  <div>
                    <strong>{basename(edit.request.path)}</strong>
                    <span>
                      {edit.request.kind} · {edit.request.candidates.length} candidates
                    </span>
                  </div>
                </li>
              ))}
            {changes
              .slice(-8)
              .reverse()
              .map(tool => (
                <li key={tool.callId}>
                  <Icon name="code" size={14} />
                  <div>
                    <strong>{tool.name}</strong>
                    <span>{tool.summary || tool.state}</span>
                  </div>
                </li>
              ))}
          </ul>
        ) : (
          <EmptySmall text="还没有文件变化" />
        )}
      </section>
      <section className="inspector-section">
        <div className="inspector-section-heading">
          <h3>子代理与研究</h3>
          <span>{state.subtasks.length + state.research.length}</span>
        </div>
        {state.subtasks.length ? (
          <ul className="activity-list">
            {state.subtasks
              .slice(-8)
              .reverse()
              .map(task => (
                <li key={task.taskId}>
                  <span className={`state-dot state-${task.state}`} aria-hidden="true" />
                  <div>
                    <strong>{task.role}</strong>
                    <span>{task.objective}</span>
                  </div>
                  <small>{task.state}</small>
                </li>
              ))}
          </ul>
        ) : null}
        {state.research.length ? (
          <ul className="activity-list">
            {state.research
              .slice(-6)
              .reverse()
              .map(item => (
                <li key={item.packetId}>
                  <span className={`state-dot state-${item.stage}`} aria-hidden="true" />
                  <div>
                    <strong>Research</strong>
                    <span>{item.objective || item.packetId}</span>
                  </div>
                  <small>{item.stage}</small>
                </li>
              ))}
          </ul>
        ) : null}
        {!state.subtasks.length && !state.research.length ? (
          <EmptySmall text="还没有子代理或研究活动" />
        ) : null}
      </section>
    </div>
  );
}

function ToolActivityRow({ tool }: { readonly tool: WebToolCall }) {
  return (
    <li>
      <span className={`state-dot state-${tool.state}`} aria-hidden="true" />
      <div>
        <strong>{tool.name}</strong>
        <span>{tool.summary || `调用 #${tool.sequence}`}</span>
      </div>
      <small>{tool.duration !== undefined ? `${Math.round(tool.duration)}ms` : tool.state}</small>
    </li>
  );
}

function ToolDetailsSection({
  state,
  actions,
}: {
  readonly state: WorkbenchState;
  readonly actions: WorkbenchActions;
}) {
  const [selectedId, setSelectedId] = useState('');
  const [content, setContent] = useState('');
  const [nextOffset, setNextOffset] = useState<number | undefined>();
  const [totalBytes, setTotalBytes] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setSelectedId('');
    setContent('');
    setNextOffset(undefined);
    setError('');
  }, [state.activeSessionId]);

  const read = async (artifactId: string, offset = 0) => {
    setLoading(true);
    setError('');
    try {
      const page = await actions.readToolDetail(artifactId, offset);
      setSelectedId(artifactId);
      setContent(current => (offset === 0 ? page.content : `${current}${page.content}`));
      setNextOffset(page.nextOffsetBytes);
      setTotalBytes(page.totalBytes);
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : '工具详情读取失败。');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="inspector-section tool-detail-browser">
      <div className="inspector-section-heading">
        <h3>持久化输出</h3>
        <button
          type="button"
          className="icon-text-button"
          onClick={() => void actions.refreshToolDetails()}
          disabled={Boolean(state.pendingAction)}
        >
          <Icon name="refresh" size={13} />
          刷新
        </button>
      </div>
      {state.toolDetails.length ? (
        <div className="detail-selector" role="group" aria-label="工具输出详情">
          {state.toolDetails
            .slice(-20)
            .reverse()
            .map(detail => (
              <button
                type="button"
                key={`${detail.callId}:${detail.sequence}`}
                className={selectedId && detail.artifactId === selectedId ? 'active' : ''}
                disabled={!detail.artifactId || loading}
                onClick={() => detail.artifactId && void read(detail.artifactId)}
              >
                <span>
                  <strong>{detail.toolName}</strong>
                  <small>
                    #{detail.sequence} · {formatBytes(detail.outputBytes)}
                  </small>
                </span>
                <Icon name="chevron" size={13} />
              </button>
            ))}
        </div>
      ) : (
        <EmptySmall text="没有可读取的持久化输出" />
      )}
      {state.toolDetailNextCursor ? (
        <button
          type="button"
          className="text-button"
          onClick={() => void actions.loadMoreToolDetails()}
          disabled={Boolean(state.pendingAction)}
        >
          加载更多输出记录
        </button>
      ) : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {selectedId ? (
        <div className="detail-output">
          <div>
            <span>{formatBytes(totalBytes)} · 已脱敏</span>
            <code>{selectedId}</code>
          </div>
          <pre tabIndex={0}>{sanitizeDisplayText(content)}</pre>
          {nextOffset !== undefined ? (
            <button
              type="button"
              className="secondary-button"
              disabled={loading}
              onClick={() => void read(selectedId, nextOffset)}
            >
              {loading ? '读取中…' : '加载更多'}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function IntegrationsPanel({
  state,
  actions,
}: {
  readonly state: WorkbenchState;
  readonly actions: WorkbenchActions;
}) {
  const skills = state.skills;
  const servers = state.mcpServers;
  return (
    <div className="inspector-stack">
      <section className="capability-card">
        <header>
          <span className="capability-icon">
            <Icon name="spark" size={17} />
          </span>
          <div>
            <h3>Skills</h3>
            <p>安全描述符，只读</p>
          </div>
          <span className={`readiness-pill ${skills.length ? 'ready' : ''}`}>
            {skills.length ? `${skills.length} 可用` : '未发现'}
          </span>
        </header>
        {skills.length ? (
          <ul className="skill-list">
            {skills.map(skill => (
              <li key={skill.id}>
                <div>
                  <strong>{skill.name}</strong>
                  <span>
                    {skill.sourceScope} · {skill.providerId}
                  </span>
                </div>
                <p>{skill.description}</p>
                {skill.requestedCapabilities.length ? (
                  <small>{skill.requestedCapabilities.join(' · ')}</small>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted-copy">当前 Runtime 没有公开可用的 Skill 描述符。</p>
        )}
      </section>
      <section className="capability-card">
        <header>
          <span className="capability-icon mcp">
            <Icon name="branch" size={17} />
          </span>
          <div>
            <h3>MCP Servers</h3>
            <p>只读配置与运行状态</p>
          </div>
          <span className={`readiness-pill ${servers.length ? 'ready' : ''}`}>
            {servers.length ? `${servers.length} 已配置` : '未配置'}
          </span>
        </header>
        {servers.length ? (
          <ul className="server-list">
            {servers.map(server => (
              <li key={server.id}>
                <span className={`state-dot state-${server.state}`} aria-hidden="true" />
                <div>
                  <code>{server.name}</code>
                  <small>
                    {server.transport} · {server.toolCount} tools
                  </small>
                </div>
                <span>{server.disabled ? 'Disabled' : server.state}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted-copy">没有可用的 MCP Server。浏览器不会接收环境变量或认证 Header。</p>
        )}
      </section>
      {state.skillNextCursor || state.mcpNextCursor ? (
        <button
          type="button"
          className="secondary-button"
          onClick={() => void actions.loadMoreCapabilities()}
          disabled={Boolean(state.pendingAction)}
        >
          加载更多能力
        </button>
      ) : null}
      <section className="security-note">
        <Icon name="info" size={16} />
        <p>
          <strong>能力边界由 Runtime 管理。</strong> Web
          端只展示描述符和状态，不加载外部插件代码，也不会绕过 ToolGateway。
        </p>
      </section>
    </div>
  );
}

function DiagnosticsPanel({
  state,
  actions,
}: {
  readonly state: WorkbenchState;
  readonly actions: WorkbenchActions;
}) {
  const diagnostics = state.diagnostics;
  const snapshotSync = activeSessionSnapshotSync(state);
  return (
    <div className="inspector-stack">
      <div className="diagnostics-toolbar">
        <div>
          <span className={`connection-dot ${state.connection}`} aria-hidden="true" />
          <strong>{connectionTitle(state.connection)}</strong>
        </div>
        <button
          type="button"
          className="icon-text-button"
          onClick={() => void actions.refreshDiagnostics()}
          disabled={Boolean(state.pendingAction)}
        >
          <Icon name="refresh" size={14} />
          刷新
        </button>
      </div>
      <section className="inspector-section">
        <div className="inspector-section-heading">
          <h3>Runtime</h3>
        </div>
        <dl className="diagnostic-list">
          <DiagnosticRow label="版本" value={state.bootstrap?.productVersion ?? '—'} />
          <DiagnosticRow label="工作区" value={basename(state.workspace) || '—'} />
          <DiagnosticRow label="会话" value={state.activeSessionId?.slice(0, 12) ?? '未选择'} />
          <DiagnosticRow
            label="模式"
            value={String(diagnostics?.agentMode ?? state.mode.baseMode)}
          />
          <DiagnosticRow
            label="权限"
            value={String(
              diagnostics?.permissionMode ??
                state.settings?.sections.permissions.toolConfirmation.effectiveValue ??
                '—'
            )}
          />
          <DiagnosticRow label="事件游标" value={`${state.lastCursor}`} />
          <DiagnosticRow label="事件 UUID" value={state.lastEventId?.slice(0, 12) ?? '—'} />
          <DiagnosticRow label="会话快照" value={snapshotSync.status} />
          <DiagnosticRow label="保留事件" value={`${diagnostics?.eventStream?.retained ?? '—'}`} />
        </dl>
      </section>
      {diagnostics?.contextUsage ? (
        <JsonSection title="Context usage" value={diagnostics.contextUsage} />
      ) : null}
      {diagnostics?.tokenUsage ? (
        <JsonSection title="Token usage" value={diagnostics.tokenUsage} />
      ) : null}
      {diagnostics?.harness ? <JsonSection title="Harness" value={diagnostics.harness} /> : null}
      {state.loopStats ? <JsonSection title="Loop statistics" value={state.loopStats} /> : null}
      <section className="security-note">
        <Icon name="check" size={16} />
        <p>诊断载荷由 Host 脱敏。API Key、认证 Header 和环境值不会返回浏览器。</p>
      </section>
    </div>
  );
}

function DiagnosticRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  );
}

function JsonSection({ title, value }: { readonly title: string; readonly value: unknown }) {
  return (
    <details className="json-section">
      <summary>{title}</summary>
      <pre tabIndex={0}>{safeJson(value, 12_000)}</pre>
    </details>
  );
}

function EmptySmall({ text }: { readonly text: string }) {
  return (
    <div className="empty-small">
      <span className="empty-line" aria-hidden="true" />
      <p>{text}</p>
    </div>
  );
}

function isChangeTool(tool: WebToolCall): boolean {
  return /write|edit|patch|delete|move|rename|mkdir|create/i.test(tool.name);
}

function basename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? normalized;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    notation: value > 99_999 ? 'compact' : 'standard',
  }).format(value);
}

function formatElapsed(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function formatClock(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time)
    ? new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : '';
}

function connectionTitle(value: WorkbenchState['connection']): string {
  if (value === 'live') return '本地 Web Host 连接正常';
  if (value === 'offline') return '浏览器离线';
  if (value === 'replay-required') return 'Web Host 事件流需要恢复';
  if (value === 'closed') return '本地 Web Host 已关闭';
  return value === 'connecting' ? '正在连接本地 Web Host' : '正在重新连接本地 Web Host';
}
