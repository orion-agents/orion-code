import type {
  WebEventEnvelopeV1,
  WebMcpServerSummaryV1,
  WebSessionSnapshotV1,
  WebSessionSummaryV1,
  WebSettingsSnapshotV1,
  WebSkillSummaryV1,
  WebToolDetailSummaryV1,
} from './types';
import type { SettingsMirrorSnapshot } from './settings/settings-mirror';
import {
  initialWorkbenchState,
  type ConnectionPhase,
  type DiagnosticsSnapshot,
  type GoalActivity,
  type GoalEvidenceItem,
  type GoalView,
  type WebBootstrapV1,
  type WebEditPreview,
  type WebResearch,
  type WebSubtask,
  type WebToolCall,
  type WebTranscriptEntry,
  type WorkbenchNotice,
  type WorkbenchState,
  type WorkspaceListResponse,
} from './types';

const MAX_TRANSCRIPT = 10_000;
const MAX_TOOLS = 1_000;
const MAX_EDITS = 256;
const MAX_SUBTASKS = 256;
const MAX_RESEARCH = 128;
const MAX_TRACES = 256;
const MAX_GOAL_ACTIVITY = 128;
const MAX_GOAL_EVIDENCE = 256;

export type WorkbenchAction =
  | {
      readonly type: 'baseline_loaded';
      readonly bootstrap: WebBootstrapV1;
      readonly workspaces: WorkspaceListResponse;
      readonly sessions: readonly WebSessionSummaryV1[];
      readonly diagnostics: DiagnosticsSnapshot;
      readonly settings: WebSettingsSnapshotV1;
      readonly skills: readonly WebSkillSummaryV1[];
      readonly mcpServers: readonly WebMcpServerSummaryV1[];
      readonly toolDetails: readonly WebToolDetailSummaryV1[];
    }
  | { readonly type: 'boot_failed'; readonly message: string }
  | {
      readonly type: 'connection_changed';
      readonly phase: ConnectionPhase;
      readonly attempt: number;
    }
  | { readonly type: 'event_received'; readonly envelope: WebEventEnvelopeV1 }
  | { readonly type: 'session_snapshot_loaded'; readonly snapshot: WebSessionSnapshotV1 }
  | { readonly type: 'older_transcript_loaded'; readonly snapshot: WebSessionSnapshotV1 }
  | { readonly type: 'sessions_loaded'; readonly sessions: readonly WebSessionSummaryV1[] }
  | { readonly type: 'workspaces_loaded'; readonly value: WorkspaceListResponse }
  | { readonly type: 'settings_loaded'; readonly settings: WebSettingsSnapshotV1 }
  | { readonly type: 'settings_mirror_changed'; readonly snapshot: SettingsMirrorSnapshot }
  | { readonly type: 'diagnostics_loaded'; readonly diagnostics: DiagnosticsSnapshot }
  | {
      readonly type: 'capabilities_loaded';
      readonly skills: readonly WebSkillSummaryV1[];
      readonly mcpServers: readonly WebMcpServerSummaryV1[];
    }
  | { readonly type: 'tool_details_loaded'; readonly details: readonly WebToolDetailSummaryV1[] }
  | { readonly type: 'pending_action'; readonly label: string | null }
  | { readonly type: 'notice'; readonly notice: WorkbenchNotice | null }
  | { readonly type: 'approval_resolved'; readonly requestId: string; readonly approved: boolean }
  | { readonly type: 'reset_session_view'; readonly activeSessionId: string | null }
  | { readonly type: 'recovering' };

export function workbenchReducer(
  state: WorkbenchState = initialWorkbenchState,
  action: WorkbenchAction
): WorkbenchState {
  switch (action.type) {
    case 'baseline_loaded': {
      const base =
        state.activeSessionId !== action.bootstrap.activeSessionId
          ? clearSessionProjection(state)
          : state;
      const mode = modeFromDiagnostics(action.diagnostics, base.mode);
      return {
        ...base,
        boot: 'ready',
        bootError: undefined,
        bootstrap: action.bootstrap,
        workspace: action.workspaces.active || action.bootstrap.workspace,
        workspaces: action.workspaces.workspaces,
        sessions: action.sessions,
        activeSessionId: action.bootstrap.activeSessionId,
        settings: action.settings,
        diagnostics: action.diagnostics,
        skills: action.skills,
        mcpServers: action.mcpServers,
        toolDetails: action.toolDetails,
        processing: Boolean(action.diagnostics.processing),
        mode,
        statusMessage: action.bootstrap.configured
          ? 'Runtime 已就绪'
          : '模型尚未配置，任务提交已停用',
        announcement: action.bootstrap.configured ? 'Orion Runtime 已就绪' : 'Orion 尚未配置模型',
      };
    }
    case 'boot_failed':
      return {
        ...state,
        boot: 'error',
        bootError: action.message,
        connection: isOnline() ? 'reconnecting' : 'offline',
        announcement: `启动失败：${action.message}`,
      };
    case 'connection_changed':
      return {
        ...state,
        connection: action.phase,
        connectionAttempt: action.attempt,
        announcement: connectionAnnouncement(action.phase, action.attempt),
      };
    case 'event_received':
      return reduceEnvelope(state, action.envelope);
    case 'session_snapshot_loaded':
      return applySessionSnapshot(state, action.snapshot);
    case 'older_transcript_loaded': {
      if (state.activeSessionId !== action.snapshot.session.id || !state.sessionSnapshot) {
        return state;
      }
      const existing = new Set(state.transcript.map(entry => entry.id));
      const older = transcriptFromSnapshot(action.snapshot).filter(
        entry => !existing.has(entry.id)
      );
      return {
        ...state,
        transcript: [...older, ...state.transcript]
          .sort((left, right) => left.order - right.order)
          .slice(-MAX_TRANSCRIPT),
        sessionSnapshot: {
          ...state.sessionSnapshot,
          transcript: {
            items: state.sessionSnapshot.transcript.items,
            nextCursor: action.snapshot.transcript.nextCursor,
          },
        },
        announcement: `已加载 ${older.length} 条更早记录`,
      };
    }
    case 'sessions_loaded':
      return { ...state, sessions: action.sessions };
    case 'workspaces_loaded':
      return {
        ...state,
        workspace: action.value.active,
        workspaces: action.value.workspaces,
      };
    case 'settings_loaded':
      return { ...state, settings: action.settings };
    case 'settings_mirror_changed':
      return {
        ...state,
        settings: action.snapshot.document ?? action.snapshot.lastGood,
        settingsMirror: action.snapshot,
      };
    case 'diagnostics_loaded':
      return {
        ...state,
        diagnostics: action.diagnostics,
        processing: Boolean(action.diagnostics.processing ?? state.processing),
        mode: modeFromDiagnostics(action.diagnostics, state.mode),
      };
    case 'capabilities_loaded':
      return { ...state, skills: action.skills, mcpServers: action.mcpServers };
    case 'tool_details_loaded':
      return { ...state, toolDetails: action.details };
    case 'pending_action':
      return { ...state, pendingAction: action.label };
    case 'notice':
      return { ...state, notice: action.notice };
    case 'approval_resolved':
      if (state.permission?.id !== action.requestId) return state;
      return {
        ...state,
        permission: null,
        announcement: action.approved ? '工具权限已授予' : '工具请求已拒绝',
      };
    case 'reset_session_view':
      return {
        ...clearSessionProjection(state),
        activeSessionId: action.activeSessionId,
        statusMessage: action.activeSessionId ? '正在恢复会话…' : '请选择会话',
        announcement: action.activeSessionId ? '正在恢复会话' : '会话已清除',
      };
    case 'recovering':
      return {
        ...state,
        connection: 'connecting',
        replayReason: undefined,
        notice: null,
        announcement: '正在重新加载会话状态',
      };
  }
}

function reduceEnvelope(state: WorkbenchState, envelope: WebEventEnvelopeV1): WorkbenchState {
  if (envelope.type === 'replay_reset') {
    return {
      ...state,
      lastCursor: envelope.cursor,
      lastEventId: envelope.eventId,
      connection: 'replay-required',
      replayReason: envelope.payload.reason,
      notice: {
        id: envelope.cursor,
        tone: 'warning',
        title: '需要重新载入会话',
        detail: envelope.payload.reason,
      },
      announcement: '事件历史已超出保留窗口，需要重新载入会话',
    };
  }
  if (envelope.cursor <= state.lastCursor) return state;

  const received: WorkbenchState = {
    ...state,
    lastCursor: envelope.cursor,
    lastEventId: envelope.eventId,
  };

  if (envelope.type === 'settings_invalidated') {
    return {
      ...received,
      announcement:
        envelope.payload.revision === state.settings?.revision
          ? 'Host 设置已同步'
          : envelope.payload.state === 'invalid'
            ? '设置文档无效，仍保留上一次可用值'
            : 'Host 设置已更新，正在刷新',
    };
  }

  if (envelope.type === 'workbench_state') {
    const projectionChanged =
      (state.workspace !== '' && state.workspace !== envelope.payload.workspace) ||
      state.activeSessionId !== envelope.payload.activeSessionId;
    const next = projectionChanged ? clearSessionProjection(received) : received;
    return {
      ...next,
      workspace: envelope.payload.workspace,
      activeSessionId: envelope.payload.activeSessionId,
    };
  }

  if (
    envelope.sessionId &&
    received.activeSessionId &&
    envelope.sessionId !== received.activeSessionId
  ) {
    return received;
  }

  if (envelope.type === 'thread_event') {
    return reduceThreadEvent(received, envelope.payload.value);
  }

  return reduceRuntimeEvent(
    received,
    envelope.payload.value,
    envelope.eventId,
    envelope.cursor,
    envelope.timestamp
  );
}

function reduceThreadEvent(
  state: WorkbenchState,
  envelope: Extract<WebEventEnvelopeV1, { type: 'thread_event' }>['payload']['value']
): WorkbenchState {
  const event = envelope.payload;
  switch (event.type) {
    case 'thread.started':
    case 'thread.resumed':
      return { ...state, statusMessage: '会话线程已就绪' };
    case 'thread.forked':
      return { ...state, statusMessage: '分支线程已就绪' };
    case 'turn.started':
      return {
        ...state,
        processing: true,
        statusMessage: event.data.mode === 'plan' ? '正在制定计划…' : 'Orion 正在处理…',
        announcement: '新回合已开始',
      };
    case 'turn.queued':
      return { ...state, statusMessage: '消息已进入 Runtime 队列' };
    case 'turn.queue_expired':
      return {
        ...state,
        notice: {
          id: state.lastCursor,
          tone: 'warning',
          title: '一条排队消息已过期',
          detail: `队列项 ${event.data.queueId} 未在时限内开始。`,
        },
      };
    case 'turn.steered':
      return { ...state, statusMessage: '已将补充指令送入当前回合' };
    case 'turn.interrupt_requested':
      return { ...state, statusMessage: '正在中断当前回合…' };
    case 'turn.committed':
      return { ...state, statusMessage: '回合结果已持久化' };
    case 'turn.completed':
      return {
        ...state,
        processing: false,
        permission: null,
        statusMessage: '任务已完成',
        announcement: '当前回合已完成',
      };
    case 'turn.failed':
      return {
        ...state,
        processing: false,
        permission: null,
        statusMessage: '当前回合失败',
        notice: {
          id: state.lastCursor,
          tone: 'error',
          title: '当前回合失败',
          detail: event.data.error,
        },
        announcement: '当前回合失败',
      };
    case 'turn.interrupted':
      return {
        ...state,
        processing: false,
        permission: null,
        statusMessage: '当前回合已中断',
        announcement: '当前回合已中断',
      };
    case 'compact.started':
      return { ...state, statusMessage: '正在压缩上下文…' };
    case 'compact.completed':
      return { ...state, statusMessage: '上下文压缩完成' };
    case 'compact.failed':
      return {
        ...state,
        statusMessage: '上下文压缩失败',
        notice: {
          id: state.lastCursor,
          tone: 'warning',
          title: '上下文压缩失败',
          detail: event.data.error,
        },
      };
    case 'approval.requested':
      return { ...state, statusMessage: `等待确认：${event.data.toolName}` };
    case 'item.started':
    case 'item.delta':
    case 'item.completed':
    case 'item.failed':
    case 'item.interrupted':
    case 'item.indeterminate':
    case 'step.snapshot':
    case 'capability.receipt':
    case 'tool.receipt':
      return state;
  }
}

function reduceRuntimeEvent(
  state: WorkbenchState,
  event: Extract<WebEventEnvelopeV1, { type: 'runtime_event' }>['payload']['value'],
  eventId: string,
  cursor: number,
  timestamp: string
): WorkbenchState {
  switch (event.type) {
    case 'transcript_append': {
      const entry: WebTranscriptEntry = {
        ...event.entry,
        id: `web-entry-${cursor}`,
        eventId,
        order: cursor,
        receivedAt: timestamp,
      };
      return {
        ...state,
        transcript: appendBounded(state.transcript, entry, MAX_TRANSCRIPT),
      };
    }
    case 'transcript_update':
      return {
        ...state,
        transcript: state.transcript.map(entry =>
          entry.id === event.id ? { ...entry, ...event.patch } : entry
        ),
      };
    case 'transcript_finalize':
      return {
        ...state,
        transcript: state.transcript.map(entry =>
          entry.id === event.id ? { ...entry, ...event.patch, live: false } : entry
        ),
      };
    case 'transcript_remove':
      return { ...state, transcript: state.transcript.filter(entry => entry.id !== event.id) };
    case 'transcript_replace': {
      const total = Math.max(1, event.entries.length);
      return {
        ...state,
        transcript: event.entries.slice(-MAX_TRANSCRIPT).map((entry, index) => ({
          ...entry,
          eventId: `${eventId}:${index}`,
          order: cursor - 1 + (index + 1) / (total + 1),
          receivedAt: timestamp,
          live: false,
        })),
      };
    }
    case 'transcript_clear':
      return {
        ...clearSessionProjection(state),
        activeSessionId: state.activeSessionId,
        statusMessage: '新会话已就绪',
      };
    case 'status_changed':
      return { ...state, statusMessage: event.message };
    case 'permission_requested':
      return {
        ...state,
        permission: { ...event.request, eventId },
        announcement: `需要确认工具权限：${event.request.name}`,
      };
    case 'tool_started': {
      const tool: WebToolCall = {
        callId: event.event.callId,
        eventId,
        order: cursor,
        name: event.event.name,
        args: event.event.args,
        sequence: event.event.sequence,
        state: 'running',
        startedAt: timestamp,
      };
      return {
        ...state,
        tools: upsertTool(state.tools, tool),
        announcement: `工具 ${tool.name} 已开始`,
      };
    }
    case 'tool_finished': {
      const previous = state.tools.find(tool => tool.callId === event.event.callId);
      const tool: WebToolCall = {
        callId: event.event.callId,
        eventId: previous?.eventId ?? eventId,
        order: previous?.order ?? cursor,
        name: event.event.name,
        args: event.event.args,
        sequence: event.event.sequence,
        state: event.event.skipped ? 'skipped' : event.event.success ? 'success' : 'error',
        startedAt: previous?.startedAt,
        finishedAt: timestamp,
        duration: event.event.duration,
        summary: event.event.summary,
        error: event.event.error,
        outputBytes: event.event.outputBytes,
        artifactId: event.event.artifactRef?.id,
        authorization: event.event.authorization,
      };
      return {
        ...state,
        tools: upsertTool(state.tools, tool),
        announcement: `工具 ${tool.name} ${
          tool.state === 'success' ? '已完成' : tool.state === 'skipped' ? '已跳过' : '失败'
        }`,
      };
    }
    case 'edit_preview_requested': {
      const edit: WebEditPreview = {
        eventId,
        order: cursor,
        receivedAt: timestamp,
        request: event.request,
      };
      return { ...state, edits: appendBounded(state.edits, edit, MAX_EDITS) };
    }
    case 'session_restored':
      return {
        ...state,
        activeSessionId: event.event.sessionId,
        statusMessage: `已恢复 ${event.event.restoredMessages} 条消息`,
        announcement: '会话恢复完成',
        notice:
          event.event.warnings && event.event.warnings.length > 0
            ? {
                id: cursor,
                tone: 'warning',
                title: '会话已恢复，但有注意事项',
                detail: event.event.warnings.join(' '),
              }
            : state.notice,
      };
    case 'loop_stats_updated':
      return { ...state, loopStats: event.stats };
    case 'trace_event_recorded':
      return { ...state, traces: appendBounded(state.traces, event.event, MAX_TRACES) };
    case 'harness_diagnostics_updated':
      return {
        ...state,
        diagnostics: {
          ...(state.diagnostics ?? {}),
          harness: event.diagnostics as unknown as Record<string, unknown>,
        },
      };
    case 'subtask_event': {
      const subtask: WebSubtask = {
        ...event.event,
        eventId,
        order: cursor,
        updatedAt: timestamp,
      };
      const subtasks = [
        ...state.subtasks.filter(item => item.taskId !== subtask.taskId),
        subtask,
      ].slice(-MAX_SUBTASKS);
      return { ...state, subtasks };
    }
    case 'research_event':
      return {
        ...state,
        research: reduceResearch(state.research, event.event, eventId, cursor, timestamp),
      };
    case 'goal_event':
      return reduceGoalEvent(state, event.event, timestamp);
    case 'effort_event':
      return { ...state, effort: event.event };
    case 'followup_queue_changed':
      return { ...state, queue: event.snapshot };
    case 'processing_changed':
      return {
        ...state,
        processing: event.processing,
        permission: event.processing ? state.permission : null,
        announcement: event.processing ? 'Orion 开始处理任务' : 'Orion 已完成当前处理',
      };
    case 'agent_mode_changed':
      return { ...state, mode: event.snapshot };
    case 'clear_view':
      return { ...state, transcript: [], tools: [], edits: [] };
    case 'shutdown_requested':
      return {
        ...state,
        connection: 'closed',
        processing: false,
        permission: null,
        statusMessage: event.reason ?? 'Web Host 已关闭',
        announcement: 'Orion Web Host 已关闭',
      };
    case 'session_picker_requested':
    case 'model_picker_requested':
      return state;
  }
}

function applySessionSnapshot(
  state: WorkbenchState,
  snapshot: WebSessionSnapshotV1
): WorkbenchState {
  const transcript = transcriptFromSnapshot(snapshot).slice(-MAX_TRANSCRIPT);
  const agentMode = isAgentMode(snapshot.runtime.agentMode)
    ? snapshot.runtime.agentMode
    : state.mode.baseMode;
  const permission = snapshot.pendingApprovals[0];
  const goal = goalFromPersistentSnapshot(snapshot.goal);
  return {
    ...clearSessionProjection(state),
    lastCursor: Math.max(state.lastCursor, snapshot.eventCursor),
    activeSessionId: snapshot.session.id,
    sessions: replaceSession(state.sessions, snapshot.session),
    transcript,
    permission: permission
      ? {
          id: permission.id,
          name: permission.toolName,
          reason: permission.reason,
          args: { ...permission.sanitizedArguments },
          eventId: `snapshot:${permission.id}`,
        }
      : null,
    processing: snapshot.runtime.processing,
    statusMessage: snapshot.runtime.status,
    mode: { baseMode: agentMode, pendingBaseMode: null },
    queue: {
      items: snapshot.runtime.followups.map(item => ({ ...item })),
      limit: snapshot.runtime.followupLimit,
    },
    goal,
    plan: snapshot.plan ?? null,
    sessionSnapshot: snapshot,
    diagnostics: {
      ...(state.diagnostics ?? {}),
      activeSessionId: snapshot.session.id,
      processing: snapshot.runtime.processing,
      agentMode,
      permissionMode: snapshot.runtime.permissionMode,
      contextUsage: snapshot.runtime.contextUsage,
      tokenUsage: snapshot.runtime.tokenUsage,
      plan: snapshot.plan?.body ?? null,
      recoveryDiagnostics: snapshot.recoveryDiagnostics,
    },
    connection: state.connection === 'replay-required' ? 'connecting' : state.connection,
    replayReason: undefined,
    announcement: '会话状态已恢复',
  };
}

function transcriptFromSnapshot(snapshot: WebSessionSnapshotV1): WebTranscriptEntry[] {
  return snapshot.transcript.items.map((entry, index) => {
    const ordinal = Number.parseInt(entry.id.split(':').at(-1) ?? '', 10);
    return {
      id: entry.id,
      role: entry.role,
      content: entry.content,
      eventId: `snapshot:${entry.id}`,
      order: -1_000_000_000 + (Number.isSafeInteger(ordinal) ? ordinal : index),
      receivedAt: timestampString(entry.timestamp),
      live: false,
    };
  });
}

function goalFromPersistentSnapshot(goalView: WebSessionSnapshotV1['goal']): GoalView | null {
  if (!goalView || !isRecord(goalView.state)) return null;
  const goal = goalView.state;
  if (
    typeof goal.goalId !== 'string' ||
    typeof goal.objective !== 'string' ||
    typeof goal.status !== 'string'
  ) {
    return null;
  }
  const budget = isRecord(goal.budget) ? goal.budget : null;
  const stopDecision = isRecord(goal.lastStopDecision) ? goal.lastStopDecision : null;
  const stopReason =
    stopDecision && isRecord(stopDecision.reason)
      ? stringValue(stopDecision.reason.message)
      : stringValue(goal.stopReason);
  const criteria = isRecord(goal.criteria)
    ? {
        passed: numberValue(goal.criteria.passed),
        total: numberValue(goal.criteria.total),
        failed: numberValue(goal.criteria.failed),
        stale: numberValue(goal.criteria.stale),
      }
    : undefined;
  return {
    goalId: goal.goalId,
    revision: numberValue(goal.revision, numberValue(goal.generation, 1)),
    objective: goal.objective,
    status: goal.status,
    tokenBudget: optionalNumber(goal.tokenBudget) ?? optionalNumber(budget?.maxTokens),
    tokensUsed: numberValue(goal.tokensUsed),
    timeUsedMs: numberValue(goal.timeUsedMs, numberValue(goal.elapsedMs)),
    continuationCount: numberValue(goal.continuationCount),
    updatedAt: numberValue(goal.updatedAt),
    stopReason,
    criteria,
    planRevision: optionalNumber(goal.planRevision),
    planPhase: stringValue(goal.planPhase),
    nextAction: stringValue(goal.nextAction),
    auditRemaining: Array.isArray(goal.auditRemaining)
      ? goal.auditRemaining.filter((item): item is string => typeof item === 'string')
      : undefined,
  };
}

function reduceGoalEvent(
  state: WorkbenchState,
  event: Extract<
    Extract<WebEventEnvelopeV1, { type: 'runtime_event' }>['payload']['value'],
    { type: 'goal_event' }
  >['event'],
  timestamp: string
): WorkbenchState {
  switch (event.type) {
    case 'goal_updated':
    case 'goal_restored':
      return {
        ...state,
        goal: event.goal,
        goalActivity: addGoalActivity(state.goalActivity, event.type, 'Goal 状态已更新', timestamp),
      };
    case 'goal_completed':
      return {
        ...state,
        goal: event.goal,
        goalActivity: addGoalActivity(
          state.goalActivity,
          event.type,
          event.audit.verificationSummary,
          timestamp
        ),
        announcement: 'Goal 已完成并通过运行时审计',
      };
    case 'goal_cleared':
      return {
        ...state,
        goal: null,
        goalEvidence: [],
        goalActivity: addGoalActivity(state.goalActivity, event.type, event.reason, timestamp),
      };
    case 'goal_plan_updated':
      return {
        ...state,
        goal: state.goal
          ? {
              ...state.goal,
              planRevision: event.planRevision,
              planPhase: event.phase,
              nextAction: event.nextAction,
            }
          : state.goal,
        goalActivity: addGoalActivity(
          state.goalActivity,
          event.type,
          event.nextAction ?? `Plan phase: ${event.phase}`,
          timestamp
        ),
      };
    case 'goal_evidence_recorded': {
      const evidence: GoalEvidenceItem = event.evidence;
      return {
        ...state,
        goalEvidence: [
          ...state.goalEvidence.filter(item => item.id !== evidence.id),
          evidence,
        ].slice(-MAX_GOAL_EVIDENCE),
      };
    }
    case 'goal_continuation':
      return {
        ...state,
        goalActivity: addGoalActivity(
          state.goalActivity,
          `${event.type}:${event.phase}`,
          event.reason,
          timestamp
        ),
      };
    case 'goal_audit_failed':
      return {
        ...state,
        goalActivity: addGoalActivity(state.goalActivity, event.type, event.summary, timestamp),
        notice: {
          id: Date.parse(timestamp),
          tone: 'warning',
          title: 'Goal 审计尚未通过',
          detail: event.summary,
        },
      };
  }
}

function reduceResearch(
  current: readonly WebResearch[],
  event: Extract<
    Extract<WebEventEnvelopeV1, { type: 'runtime_event' }>['payload']['value'],
    { type: 'research_event' }
  >['event'],
  eventId: string,
  order: number,
  timestamp: string
): readonly WebResearch[] {
  const previous = current.find(item => item.packetId === event.packetId);
  const base: WebResearch = previous ?? {
    packetId: event.packetId,
    eventId,
    order,
    updatedAt: timestamp,
    stage: 'running',
    sources: [],
    conflicts: [],
  };
  let next: WebResearch;
  switch (event.type) {
    case 'research_started':
      next = {
        ...base,
        eventId,
        order,
        updatedAt: timestamp,
        objective: event.objective,
        mode: event.mode,
        stage: 'running',
      };
      break;
    case 'research_source': {
      const source = {
        id: event.sourceId,
        provider: event.provider,
        status: event.status,
        title: event.title,
        location: event.displayUrl ?? event.canonicalUrl ?? event.projectPath,
        failureReason: event.failureReason,
      };
      next = {
        ...base,
        eventId,
        order,
        updatedAt: timestamp,
        sources: [...base.sources.filter(item => item.id !== source.id), source].slice(-64),
      };
      break;
    }
    case 'research_conflict':
      next = {
        ...base,
        eventId,
        order,
        updatedAt: timestamp,
        conflicts: [...base.conflicts.filter(id => id !== event.claimId), event.claimId].slice(-64),
      };
      break;
    case 'research_completed':
      next = {
        ...base,
        eventId,
        order,
        updatedAt: timestamp,
        stage: event.stage,
        auditStatus: event.auditStatus,
        conclusion: event.conclusion,
        summary: event.summary as Record<string, number> | undefined,
      };
      break;
  }
  return [...current.filter(item => item.packetId !== event.packetId), next].slice(-MAX_RESEARCH);
}

function upsertTool(current: readonly WebToolCall[], tool: WebToolCall): readonly WebToolCall[] {
  return [...current.filter(item => item.callId !== tool.callId), tool]
    .sort((left, right) => left.order - right.order)
    .slice(-MAX_TOOLS);
}

function clearSessionProjection(state: WorkbenchState): WorkbenchState {
  return {
    ...state,
    transcript: [],
    tools: [],
    edits: [],
    subtasks: [],
    research: [],
    permission: null,
    processing: false,
    statusMessage: '',
    queue: { items: [], limit: 16 },
    goal: null,
    goalEvidence: [],
    goalActivity: [],
    sessionSnapshot: null,
    plan: null,
    loopStats: null,
    traces: [],
  };
}

function replaceSession(
  sessions: readonly WebSessionSummaryV1[],
  updated: WebSessionSummaryV1
): readonly WebSessionSummaryV1[] {
  const found = sessions.some(session => session.id === updated.id);
  return found
    ? sessions.map(session => (session.id === updated.id ? updated : session))
    : [updated, ...sessions];
}

function addGoalActivity(
  current: readonly GoalActivity[],
  type: string,
  message: string,
  timestamp: string
): readonly GoalActivity[] {
  return appendBounded(current, { type, message, timestamp }, MAX_GOAL_ACTIVITY);
}

function appendBounded<T>(current: readonly T[], item: T, limit: number): readonly T[] {
  const next = [...current, item];
  return next.length <= limit ? next : next.slice(next.length - limit);
}

function modeFromDiagnostics(
  diagnostics: DiagnosticsSnapshot,
  fallback: WorkbenchState['mode']
): WorkbenchState['mode'] {
  const mode = diagnostics.agentMode;
  if (isAgentMode(mode)) return { baseMode: mode, pendingBaseMode: null };
  return fallback;
}

function isAgentMode(value: unknown): value is 'interactive' | 'plan' | 'auto' {
  return value === 'interactive' || value === 'plan' || value === 'auto';
}

function timestampString(value: number): string {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : new Date(0).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine;
}

function connectionAnnouncement(phase: ConnectionPhase, attempt: number): string {
  if (phase === 'live') return '实时连接已恢复';
  if (phase === 'offline') return '网络已离线，Orion 将在恢复后重连';
  if (phase === 'reconnecting') return `正在重新连接，第 ${Math.max(1, attempt)} 次尝试`;
  if (phase === 'connecting') return '正在连接 Orion Runtime';
  if (phase === 'replay-required') return '需要重新载入会话';
  return 'Orion Web Host 已关闭';
}
