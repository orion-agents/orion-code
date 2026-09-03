import type {
  WebEventEnvelopeV1,
  WebComposerControlStateV1,
  WebModelCatalogPageV1,
  WebMcpServerSummaryV1,
  WebSessionSnapshotV1,
  WebSessionRuntimeSummaryV1,
  WebSessionSummaryV1,
  WebSettingsSnapshotV1,
  WebSkillSummaryV1,
  WebToolDetailSummaryV1,
  WebWorkspaceProjectSummaryV1,
} from './types';
import { upsertSessionSummary } from './state/session-collection';
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
const MAX_SESSION_PROJECTIONS = 8;
const MAX_SESSION_PROJECTION_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_RUNTIME_SUMMARIES = 64;
const MAX_SESSION_SYNC_ENTRIES = 64;

export type WorkbenchAction =
  | {
      readonly type: 'baseline_loaded';
      readonly bootstrap: WebBootstrapV1;
      readonly workspaces: WorkspaceListResponse;
      readonly sessions: readonly WebSessionSummaryV1[];
      readonly sessionNextCursor: string | null;
      readonly diagnostics: DiagnosticsSnapshot;
      readonly settings: WebSettingsSnapshotV1;
      readonly skills: readonly WebSkillSummaryV1[];
      readonly skillNextCursor: string | null;
      readonly mcpServers: readonly WebMcpServerSummaryV1[];
      readonly mcpNextCursor: string | null;
      readonly toolDetails: readonly WebToolDetailSummaryV1[];
      readonly toolDetailNextCursor: string | null;
    }
  | { readonly type: 'boot_failed'; readonly message: string }
  | {
      readonly type: 'connection_changed';
      readonly phase: ConnectionPhase;
      readonly attempt: number;
    }
  | { readonly type: 'event_received'; readonly envelope: WebEventEnvelopeV1 }
  | {
      readonly type: 'session_snapshot_started';
      readonly sessionId: string;
      readonly requestId: number;
      readonly cached: boolean;
      readonly contextRevision: string;
      readonly workspaceId: string;
    }
  | {
      readonly type: 'session_snapshot_loaded';
      readonly snapshot: WebSessionSnapshotV1;
      readonly requestId?: number;
      readonly contextRevision?: string;
      readonly workspaceId?: string;
      /**
       * A snapshot cursor may establish a new SSE baseline only while the event
       * stream is paused. Live Session switches leave the stream in charge of
       * the global cursor so in-flight control events cannot be skipped.
       */
      readonly advanceEventCursor?: boolean;
    }
  | { readonly type: 'composer_loaded'; readonly composer: WebComposerControlStateV1 }
  | { readonly type: 'model_catalog_loaded'; readonly catalog: WebModelCatalogPageV1 }
  | {
      readonly type: 'durable_session_metadata_loaded';
      readonly snapshot: WebSessionSnapshotV1;
      readonly contextRevision: string;
      readonly workspaceId: string;
    }
  | { readonly type: 'older_transcript_loaded'; readonly snapshot: WebSessionSnapshotV1 }
  | {
      readonly type: 'sessions_loaded';
      readonly sessions: readonly WebSessionSummaryV1[];
      readonly nextCursor: string | null;
      readonly append?: boolean;
    }
  | {
      readonly type: 'workspaces_loaded';
      readonly value: WorkspaceListResponse;
      readonly append?: boolean;
    }
  | { readonly type: 'workspace_sessions_loading'; readonly workspaceId: string }
  | {
      readonly type: 'workspace_sessions_loaded';
      readonly workspaceId: string;
      readonly sessions: readonly WebSessionSummaryV1[];
      readonly nextCursor: string | null;
      readonly append?: boolean;
    }
  | {
      readonly type: 'workspace_sessions_failed';
      readonly workspaceId: string;
      readonly detail: string;
    }
  // v0.3.7 — Session tag / archive / delete mutations keep the rail listings
  // (active workspace + archived section) in sync with the host.
  | { readonly type: 'session_updated'; readonly session: WebSessionSummaryV1 }
  | { readonly type: 'session_archived'; readonly session: WebSessionSummaryV1 }
  | { readonly type: 'session_restored'; readonly session: WebSessionSummaryV1 }
  | { readonly type: 'session_deleted'; readonly sessionId: string }
  | { readonly type: 'archived_sessions_loading'; readonly workspaceId: string }
  | {
      readonly type: 'archived_sessions_loaded';
      readonly workspaceId: string;
      readonly sessions: readonly WebSessionSummaryV1[];
      readonly nextCursor: string | null;
      readonly append?: boolean;
    }
  | {
      readonly type: 'archived_sessions_failed';
      readonly workspaceId: string;
      readonly detail: string;
    }
  | {
      readonly type: 'workspace_project_summary_loaded';
      readonly summary: WebWorkspaceProjectSummaryV1;
    }
  | { readonly type: 'settings_loaded'; readonly settings: WebSettingsSnapshotV1 }
  | { readonly type: 'settings_mirror_changed'; readonly snapshot: SettingsMirrorSnapshot }
  | { readonly type: 'diagnostics_loaded'; readonly diagnostics: DiagnosticsSnapshot }
  | {
      readonly type: 'capabilities_loaded';
      readonly skills: readonly WebSkillSummaryV1[];
      readonly skillNextCursor: string | null;
      readonly mcpServers: readonly WebMcpServerSummaryV1[];
      readonly mcpNextCursor: string | null;
      readonly append?: boolean;
    }
  | {
      readonly type: 'tool_details_loaded';
      readonly details: readonly WebToolDetailSummaryV1[];
      readonly nextCursor: string | null;
      readonly append?: boolean;
    }
  | { readonly type: 'pending_action'; readonly label: string | null }
  | { readonly type: 'notice'; readonly notice: WorkbenchNotice | null }
  | { readonly type: 'approval_resolved'; readonly requestId: string; readonly approved: boolean }
  | {
      readonly type: 'snapshot_failed';
      readonly sessionId: string | null;
      readonly detail: string;
      readonly requestId?: number;
      readonly contextRevision?: string;
      readonly workspaceId?: string;
    }
  | { readonly type: 'reset_session_view'; readonly activeSessionId: string | null }
  | { readonly type: 'recovering' };

export function workbenchReducer(
  state: WorkbenchState = initialWorkbenchState,
  action: WorkbenchAction
): WorkbenchState {
  switch (action.type) {
    case 'baseline_loaded': {
      const base =
        state.workspaceId !== action.bootstrap.workspaceId ||
        state.activeSessionId !== action.bootstrap.activeSessionId
          ? clearSessionProjection(state)
          : state;
      const mode = modeFromDiagnostics(action.diagnostics, base.mode);
      return {
        ...base,
        boot: 'ready',
        bootError: undefined,
        bootstrap: action.bootstrap,
        contextRevision: action.bootstrap.contextRevision,
        workspaceId: action.bootstrap.workspaceId,
        workspace: action.workspaces.activePath || action.bootstrap.workspace,
        workspaces: action.workspaces.workspaces,
        sessions: action.sessions,
        workspaceSessions: {
          ...base.workspaceSessions,
          [action.bootstrap.workspaceId]: {
            status: 'ready',
            items: action.sessions,
            nextCursor: action.sessionNextCursor,
          },
        },
        workspaceNextCursor: action.workspaces.nextCursor,
        sessionNextCursor: action.sessionNextCursor,
        activeSessionId: action.bootstrap.activeSessionId,
        sessionSync: action.bootstrap.activeSessionId
          ? {
              ...base.sessionSync,
              [action.bootstrap.activeSessionId]: {
                status: base.sessionProjectionById[action.bootstrap.activeSessionId]
                  ? 'refreshing'
                  : 'loading',
                requestId: null,
              },
            }
          : base.sessionSync,
        settings: action.settings,
        diagnostics: action.diagnostics,
        skills: action.skills,
        skillNextCursor: action.skillNextCursor,
        mcpServers: action.mcpServers,
        mcpNextCursor: action.mcpNextCursor,
        toolDetails: action.toolDetails,
        toolDetailNextCursor: action.toolDetailNextCursor,
        notice: base.notice?.domain === 'session-snapshot' ? null : base.notice,
        processing: Boolean(action.diagnostics.processing),
        mode,
        statusMessage: action.bootstrap.configured
          ? '本地 Web Host 已就绪'
          : '模型尚未配置，任务提交已停用',
        announcement: action.bootstrap.configured ? '本地 Web Host 已就绪' : 'Orion 尚未配置模型',
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
      if (state.connection === 'replay-required') return state;
      return {
        ...state,
        connection: action.phase,
        connectionAttempt: action.attempt,
        announcement: connectionAnnouncement(action.phase, action.attempt),
      };
    case 'event_received':
      return reduceEnvelope(state, action.envelope);
    case 'session_snapshot_started':
      if (
        state.contextRevision !== action.contextRevision ||
        state.workspaceId !== action.workspaceId
      ) {
        return state;
      }
      return withTelemetry(
        setSessionSnapshotSync(state, action.sessionId, {
          status: action.cached ? 'refreshing' : 'loading',
          requestId: action.requestId,
        }),
        { snapshotLoads: 1 }
      );
    case 'session_snapshot_loaded': {
      const sessionId = action.snapshot.session.id;
      if (!snapshotContextMatches(state, action.contextRevision, action.workspaceId)) return state;
      if (!snapshotRequestMatches(state, sessionId, action.requestId)) return state;
      if (state.activeSessionId !== sessionId) {
        if (action.requestId === undefined) return state;
        return markSessionSnapshotReady(
          cacheBackgroundSessionSnapshot(state, action.snapshot),
          sessionId
        );
      }
      return markSessionSnapshotReady(
        applySessionSnapshot(state, action.snapshot, action.advanceEventCursor !== false),
        sessionId
      );
    }
    case 'composer_loaded':
      if (
        action.composer.sessionId !== state.activeSessionId ||
        action.composer.workspaceId !== state.workspaceId ||
        action.composer.contextRevision !== state.contextRevision
      ) {
        return state;
      }
      return applyComposerState(state, action.composer);
    case 'model_catalog_loaded':
      return { ...state, modelCatalog: action.catalog };
    case 'durable_session_metadata_loaded':
      if (
        state.contextRevision !== action.contextRevision ||
        state.workspaceId !== action.workspaceId
      ) {
        return state;
      }
      if (state.activeSessionId !== action.snapshot.session.id) {
        return cacheBackgroundSessionSnapshot(state, action.snapshot);
      }
      if (action.snapshot.runtime.active !== true) return state;
      return applyDurableSessionMetadata(state, action.snapshot);
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
      return {
        ...state,
        sessions: action.append
          ? mergeByKey(state.sessions, action.sessions, session => session.id)
          : action.sessions,
        sessionNextCursor: action.nextCursor,
        workspaceSessions: state.workspaceId
          ? {
              ...state.workspaceSessions,
              [state.workspaceId]: {
                status: 'ready',
                items: action.append
                  ? mergeByKey(state.sessions, action.sessions, session => session.id)
                  : action.sessions,
                nextCursor: action.nextCursor,
              },
            }
          : state.workspaceSessions,
      };
    case 'workspaces_loaded':
      return {
        ...state,
        workspaceId: action.value.activeId || state.workspaceId,
        workspace: action.value.activePath || state.workspace,
        workspaces: action.append
          ? mergeByKey(state.workspaces, action.value.workspaces, workspace => workspace.id)
          : action.value.workspaces,
        workspaceNextCursor: action.value.nextCursor,
      };
    case 'workspace_sessions_loading':
      return {
        ...state,
        workspaceSessions: {
          ...state.workspaceSessions,
          [action.workspaceId]: {
            status: 'loading',
            items: state.workspaceSessions[action.workspaceId]?.items ?? [],
            nextCursor: state.workspaceSessions[action.workspaceId]?.nextCursor ?? null,
          },
        },
      };
    case 'workspace_sessions_loaded': {
      const current = state.workspaceSessions[action.workspaceId];
      const items = action.append
        ? mergeByKey(current?.items ?? [], action.sessions, session => session.id)
        : action.sessions;
      return {
        ...state,
        sessions: action.workspaceId === state.workspaceId ? items : state.sessions,
        sessionNextCursor:
          action.workspaceId === state.workspaceId ? action.nextCursor : state.sessionNextCursor,
        workspaceSessions: {
          ...state.workspaceSessions,
          [action.workspaceId]: {
            status: 'ready',
            items,
            nextCursor: action.nextCursor,
          },
        },
      };
    }
    case 'workspace_sessions_failed':
      return {
        ...state,
        workspaceSessions: {
          ...state.workspaceSessions,
          [action.workspaceId]: {
            status: 'error',
            items: state.workspaceSessions[action.workspaceId]?.items ?? [],
            nextCursor: state.workspaceSessions[action.workspaceId]?.nextCursor ?? null,
            error: action.detail,
          },
        },
      };

    // v0.3.7 — Session lifecycle mirrors. `session_updated` carries the
    // refreshed summary (tags), the other three move rows between the main and
    // the archived listing without a full refetch.
    case 'session_updated': {
      const main = updateActiveSessionList(state, list => replaceOrPrepend(list, action.session));
      return main;
    }
    case 'session_archived': {
      const without = withoutSession(state, action.session.id);
      const archivedHas = state.archivedSessions.items.some(s => s.id === action.session.id);
      return {
        ...without,
        archivedSessions: archivedHas
          ? without.archivedSessions
          : {
              ...without.archivedSessions,
              status: 'ready',
              items: [action.session, ...without.archivedSessions.items],
            },
      };
    }
    case 'session_restored': {
      const main = updateActiveSessionList(state, list => [
        action.session,
        ...list.filter(item => item.id !== action.session.id),
      ]);
      return {
        ...main,
        archivedSessions: {
          ...main.archivedSessions,
          items: main.archivedSessions.items.filter(s => s.id !== action.session.id),
        },
      };
    }
    case 'session_deleted': {
      const runtimeById = { ...state.sessionRuntimeById };
      delete runtimeById[action.sessionId];
      return {
        ...withoutSession(state, action.sessionId),
        sessionRuntimeById: runtimeById,
        archivedSessions: {
          ...state.archivedSessions,
          items: state.archivedSessions.items.filter(s => s.id !== action.sessionId),
        },
      };
    }
    case 'archived_sessions_loading':
      // Guard against cross-workspace races: only the foreground workspace may
      // write the single archived copy, and stale rows from another workspace
      // are dropped immediately instead of flashing during the load.
      if (action.workspaceId !== state.workspaceId) return state;
      return {
        ...state,
        archivedSessions: {
          status: 'loading',
          items:
            state.archivedSessions.ownerWorkspaceId === action.workspaceId
              ? state.archivedSessions.items
              : [],
          nextCursor: state.archivedSessions.nextCursor,
          ownerWorkspaceId: state.archivedSessions.ownerWorkspaceId,
        },
      };
    case 'archived_sessions_loaded': {
      if (action.workspaceId !== state.workspaceId) return state;
      const items = action.append
        ? mergeByKey(state.archivedSessions.items, action.sessions, session => session.id)
        : action.sessions;
      return {
        ...state,
        archivedSessions: {
          status: 'ready',
          items,
          nextCursor: action.nextCursor,
          ownerWorkspaceId: action.workspaceId,
        },
      };
    }
    case 'archived_sessions_failed':
      if (action.workspaceId !== state.workspaceId) return state;
      return {
        ...state,
        archivedSessions: {
          ...state.archivedSessions,
          status: 'error',
          error: action.detail,
        },
      };

    case 'workspace_project_summary_loaded':
      return {
        ...state,
        workspaceProjectSummaries: {
          ...state.workspaceProjectSummaries,
          [action.summary.workspaceId]: action.summary,
        },
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
      return {
        ...state,
        skills: action.append
          ? mergeByKey(state.skills, action.skills, skill => skill.id)
          : action.skills,
        skillNextCursor: action.skillNextCursor,
        mcpServers: action.append
          ? mergeByKey(state.mcpServers, action.mcpServers, server => server.id)
          : action.mcpServers,
        mcpNextCursor: action.mcpNextCursor,
      };
    case 'tool_details_loaded':
      return {
        ...state,
        toolDetails: action.append
          ? mergeByKey(
              state.toolDetails,
              action.details,
              detail => `${detail.sequence}:${detail.callId}`
            )
          : action.details,
        toolDetailNextCursor: action.nextCursor,
      };
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
    case 'snapshot_failed': {
      if (!snapshotContextMatches(state, action.contextRevision, action.workspaceId)) return state;
      if (!action.sessionId) {
        if (state.connection === 'replay-required') return state;
        return {
          ...state,
          notice: {
            id: action.requestId ?? state.lastCursor,
            tone: 'warning',
            title: '会话状态尚未同步',
            detail: action.detail,
          },
          announcement: '会话状态尚未同步',
        };
      }
      if (!snapshotRequestMatches(state, action.sessionId, action.requestId)) return state;
      if (action.sessionId !== state.activeSessionId && action.requestId === undefined)
        return state;
      const failed = withTelemetry(
        setSessionSnapshotSync(state, action.sessionId, {
          status: 'failed',
          requestId: action.requestId ?? state.sessionSync[action.sessionId]?.requestId ?? null,
          error: action.detail,
        }),
        { snapshotFailures: 1 }
      );
      if (action.sessionId !== state.activeSessionId) return failed;
      if (state.connection === 'replay-required') return failed;
      return {
        ...failed,
        statusMessage:
          state.sessionSnapshot?.session.id === action.sessionId
            ? '会话刷新失败，当前显示最近状态'
            : '会话快照加载失败',
        notice: {
          id: action.requestId ?? state.lastCursor,
          tone: 'warning',
          title: '会话快照尚未同步',
          detail: action.detail,
          domain: 'session-snapshot',
          sessionId: action.sessionId,
        },
        announcement: '当前会话快照尚未同步，写操作已暂停',
      };
    }
    case 'reset_session_view': {
      const switching =
        Boolean(action.activeSessionId) && action.activeSessionId !== state.activeSessionId;
      const cached = Boolean(
        action.activeSessionId && state.sessionProjectionById[action.activeSessionId]
      );
      const telemetry = {
        ...(switching ? { sessionSwitches: 1 } : {}),
        ...(cached ? { snapshotCacheHits: 1 } : {}),
      };
      if (action.activeSessionId && state.sessionProjectionById[action.activeSessionId]) {
        const sessionId = action.activeSessionId;
        const restored = applySessionSnapshot(
          { ...state, activeSessionId: sessionId },
          state.sessionProjectionById[sessionId],
          false
        );
        return withTelemetry(
          {
            ...setSessionSnapshotSync(restored, sessionId, {
              status: 'refreshing',
              requestId: state.sessionSync[sessionId]?.requestId ?? null,
            }),
            notice:
              state.notice?.domain === 'session-snapshot' && state.notice.sessionId !== sessionId
                ? null
                : state.notice,
            statusMessage: '已显示最近会话状态，正在同步…',
            announcement: '已切换到缓存会话，正在同步最新状态',
          },
          telemetry
        );
      }
      const cleared = {
        ...clearSessionProjection(state),
        activeSessionId: action.activeSessionId,
        notice:
          state.notice?.domain === 'session-snapshot' &&
          state.notice.sessionId !== action.activeSessionId
            ? null
            : state.notice,
        statusMessage: action.activeSessionId ? '正在加载会话快照…' : '请选择会话',
        announcement: action.activeSessionId ? '正在加载会话快照' : '会话已清除',
      };
      const synced = action.activeSessionId
        ? setSessionSnapshotSync(cleared, action.activeSessionId, {
            status: 'loading',
            requestId: state.sessionSync[action.activeSessionId]?.requestId ?? null,
          })
        : cleared;
      return withTelemetry(synced, telemetry);
    }
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
        domain: 'transport',
      },
      announcement: '事件历史已超出保留窗口，需要重新载入会话',
    };
  }
  if (state.connection === 'replay-required') return state;
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

  if (envelope.type === 'workspace_resource_invalidated') {
    const current = state.workspaceResourceEpochs[envelope.payload.workspaceId] ?? {
      files: 0,
      git: 0,
      review: 0,
    };
    const next = { ...current };
    for (const resource of envelope.payload.resources) next[resource] = envelope.cursor;
    return {
      ...received,
      workspaceResourceEpochs: {
        ...state.workspaceResourceEpochs,
        [envelope.payload.workspaceId]: next,
      },
      announcement: '项目资源已变化，可用面板正在刷新',
    };
  }

  if (envelope.type === 'workbench_state') {
    const workspaceChanged =
      (state.workspaceId !== '' && state.workspaceId !== envelope.payload.workspaceId) ||
      (state.workspace !== '' && state.workspace !== envelope.payload.workspace);
    const next = workspaceChanged ? clearSessionProjection(received) : received;
    return {
      ...next,
      contextRevision: envelope.payload.contextRevision,
      workspaceId: envelope.payload.workspaceId,
      workspace: envelope.payload.workspace,
      // Session foreground selection belongs to this browser tab. Host
      // workbench_state only moves the Workspace Context; a legacy/global
      // activeSessionId must never steal or clear another tab's selection.
      activeSessionId: workspaceChanged ? null : state.activeSessionId,
    };
  }

  if (envelope.type === 'composer_state_changed') {
    const composer = envelope.payload.state;
    if (
      composer.sessionId !== received.activeSessionId ||
      composer.workspaceId !== received.workspaceId ||
      composer.contextRevision !== received.contextRevision
    ) {
      return received;
    }
    return applyComposerState(received, composer);
  }

  if (envelope.type === 'session_runtime_changed') {
    const runtime = envelope.payload.runtime;
    const cached = received.sessionProjectionById[runtime.sessionId];
    const sessionRuntimeById = cacheRuntimeSummary(received.sessionRuntimeById, runtime);
    const sessionProjectionById = cached
      ? cacheSessionProjection(received.sessionProjectionById, {
          ...cached,
          sessionRuntime: runtime,
        })
      : received.sessionProjectionById;
    if (runtime.sessionId !== received.activeSessionId) {
      return { ...received, sessionProjectionById, sessionRuntimeById };
    }
    return {
      ...received,
      sessionProjectionById,
      sessionRuntimeById,
      processing: ['running', 'waiting_approval', 'stopping'].includes(runtime.phase),
      sessionSnapshot:
        received.sessionSnapshot?.session.id === runtime.sessionId
          ? { ...received.sessionSnapshot, sessionRuntime: runtime }
          : received.sessionSnapshot,
      composer:
        received.composer?.sessionId === runtime.sessionId
          ? { ...received.composer, sessionRuntime: runtime }
          : received.composer,
    };
  }

  if (envelope.type === 'workspace_mutation_changed') {
    if (envelope.sessionId !== received.activeSessionId) return received;
    const tool = received.tools.find(item => item.callId === envelope.payload.state.callId);
    if (!tool) return received;
    const workspaceMutation = {
      phase: envelope.payload.state.phase,
      ...(envelope.payload.state.queuePosition === undefined
        ? {}
        : { queuePosition: envelope.payload.state.queuePosition }),
    };
    return {
      ...received,
      tools: upsertTool(received.tools, { ...tool, workspaceMutation }),
      announcement:
        workspaceMutation.phase === 'queued'
          ? `工具 ${tool.name} 正在等待工作树写入`
          : workspaceMutation.phase === 'running'
            ? `工具 ${tool.name} 已获得工作树写入权限`
            : received.announcement,
    };
  }

  if (envelope.sessionId !== null && envelope.sessionId !== received.activeSessionId) {
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
    case 'plan.review_requested':
      return {
        ...state,
        processing: false,
        statusMessage: '计划已保存，等待审核',
        announcement: '计划已准备好，请审核后再执行',
      };
    case 'plan.review_resolved':
      return {
        ...state,
        statusMessage:
          event.data.action === 'approve'
            ? '计划已批准，正在进入 BUILD'
            : event.data.action === 'continue'
              ? '已提交继续规划反馈'
              : '计划已取消',
      };
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
      if (event.contentDelta !== undefined) {
        const target = state.transcript.find(entry => entry.id === event.id);
        if (
          !target ||
          event.contentStart === undefined ||
          (target.content ?? '').length !== event.contentStart
        ) {
          const detail = '流式回复基线已变化，需要重新载入会话。';
          return {
            ...state,
            connection: 'replay-required',
            replayReason: detail,
            notice: {
              id: cursor,
              tone: 'warning',
              title: '需要重新载入会话',
              detail,
            },
            announcement: detail,
          };
        }
      }
      return {
        ...state,
        transcript: state.transcript.map(entry =>
          entry.id === event.id
            ? {
                ...entry,
                ...event.patch,
                ...(event.contentDelta === undefined
                  ? {}
                  : { content: `${entry.content ?? ''}${event.contentDelta}` }),
              }
            : entry
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
  snapshot: WebSessionSnapshotV1,
  advanceEventCursor = true
): WorkbenchState {
  const transcript = transcriptFromSnapshot(snapshot).slice(-MAX_TRANSCRIPT);
  const agentMode = isAgentMode(snapshot.runtime.agentMode)
    ? snapshot.runtime.agentMode
    : state.mode.baseMode;
  const permission = snapshot.pendingApprovals[0];
  const goal = goalFromPersistentSnapshot(snapshot.goal);
  return {
    ...clearSessionProjection(state),
    lastCursor: advanceEventCursor
      ? Math.max(state.lastCursor, snapshot.eventCursor)
      : state.lastCursor,
    activeSessionId: snapshot.session.id,
    sessionProjectionById: cacheSessionProjection(state.sessionProjectionById, snapshot),
    sessionRuntimeById: cacheRuntimeSummary(state.sessionRuntimeById, snapshot.sessionRuntime),
    sessions: upsertSessionSummary(state.sessions, snapshot.session),
    workspaceSessions: state.workspaceId
      ? {
          ...state.workspaceSessions,
          [state.workspaceId]: {
            status: 'ready',
            items: upsertSessionSummary(
              state.workspaceSessions[state.workspaceId]?.items ?? state.sessions,
              snapshot.session
            ),
            nextCursor:
              state.workspaceSessions[state.workspaceId]?.nextCursor ?? state.sessionNextCursor,
          },
        }
      : state.workspaceSessions,
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
    mode: snapshot.composer.mode ?? { baseMode: agentMode, pendingBaseMode: null },
    queue: {
      items: snapshot.composer.queue.items.map(item => ({ ...item })),
      limit: snapshot.composer.queue.limit,
    },
    goal,
    plan: snapshot.plan ?? null,
    composer: snapshot.composer,
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
    announcement: '会话快照已同步',
  };
}

function cacheBackgroundSessionSnapshot(
  state: WorkbenchState,
  snapshot: WebSessionSnapshotV1
): WorkbenchState {
  const workspaceSessions = state.workspaceId
    ? {
        ...state.workspaceSessions,
        [state.workspaceId]: {
          status: 'ready' as const,
          items: upsertSessionSummary(
            state.workspaceSessions[state.workspaceId]?.items ?? state.sessions,
            snapshot.session
          ),
          nextCursor:
            state.workspaceSessions[state.workspaceId]?.nextCursor ?? state.sessionNextCursor,
        },
      }
    : state.workspaceSessions;
  return {
    ...state,
    sessionProjectionById: cacheSessionProjection(state.sessionProjectionById, snapshot),
    sessionRuntimeById: cacheRuntimeSummary(state.sessionRuntimeById, snapshot.sessionRuntime),
    sessions: upsertSessionSummary(state.sessions, snapshot.session),
    workspaceSessions,
  };
}

function applyComposerState(
  state: WorkbenchState,
  composer: WebComposerControlStateV1
): WorkbenchState {
  const cached = state.sessionProjectionById[composer.sessionId];
  const sessionProjectionById = cached
    ? cacheSessionProjection(state.sessionProjectionById, {
        ...cached,
        sessionRuntime: composer.sessionRuntime,
        composer,
      })
    : state.sessionProjectionById;
  return {
    ...state,
    composer,
    sessionSnapshot:
      state.sessionSnapshot?.session.id === composer.sessionId
        ? {
            ...state.sessionSnapshot,
            sessionRuntime: composer.sessionRuntime,
            composer,
          }
        : state.sessionSnapshot,
    sessionProjectionById,
    sessionRuntimeById: cacheRuntimeSummary(state.sessionRuntimeById, composer.sessionRuntime),
    processing: composer.processing,
    mode: composer.mode,
    queue: {
      items: composer.queue.items.map(item => ({ ...item })),
      limit: composer.queue.limit,
    },
    diagnostics: {
      ...(state.diagnostics ?? {}),
      contextUsage: composer.contextUsage,
      agentMode: composer.mode.baseMode,
    },
  };
}

function applyDurableSessionMetadata(
  state: WorkbenchState,
  snapshot: WebSessionSnapshotV1
): WorkbenchState {
  const sessions = upsertSessionSummary(state.sessions, snapshot.session);
  const currentWorkspaceSessions = state.workspaceSessions[state.workspaceId];
  const composer =
    !state.composer || state.composer.controlRevision === snapshot.composer.controlRevision
      ? snapshot.composer
      : state.composer;
  return {
    ...state,
    sessions,
    workspaceSessions: {
      ...state.workspaceSessions,
      [state.workspaceId]: {
        status: 'ready',
        items: upsertSessionSummary(
          currentWorkspaceSessions?.items ?? state.sessions,
          snapshot.session
        ),
        nextCursor: currentWorkspaceSessions?.nextCursor ?? state.sessionNextCursor,
      },
    },
    goal: goalFromPersistentSnapshot(snapshot.goal),
    plan: snapshot.plan,
    composer,
    sessionSnapshot:
      state.sessionSnapshot?.session.id === snapshot.session.id
        ? {
            ...state.sessionSnapshot,
            session: snapshot.session,
            goal: snapshot.goal,
            plan: snapshot.plan,
            composer,
            recoveryDiagnostics: snapshot.recoveryDiagnostics,
          }
        : state.sessionSnapshot,
    diagnostics: {
      ...(state.diagnostics ?? {}),
      plan: snapshot.plan?.body ?? null,
      recoveryDiagnostics: snapshot.recoveryDiagnostics,
    },
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

function mergeByKey<T>(
  current: readonly T[],
  incoming: readonly T[],
  keyOf: (value: T) => string
): readonly T[] {
  const merged = new Map(current.map(value => [keyOf(value), value]));
  for (const value of incoming) merged.set(keyOf(value), value);
  return [...merged.values()];
}

/** Prepend `session` when new; replace in place when already listed. */
function replaceOrPrepend(
  items: readonly WebSessionSummaryV1[],
  session: WebSessionSummaryV1
): readonly WebSessionSummaryV1[] {
  const index = items.findIndex(item => item.id === session.id);
  if (index < 0) return [session, ...items];
  const next = [...items];
  next[index] = session;
  return next;
}

/** Drop `sessionId` from the active workspace main listing (sessions + workspaceSessions). */
function withoutSession(state: WorkbenchState, sessionId: string): WorkbenchState {
  const active = state.workspaceId;
  const activeList = active ? state.workspaceSessions[active] : undefined;
  const mainItems = (activeList?.items ?? state.sessions).filter(
    session => session.id !== sessionId
  );
  return {
    ...state,
    sessions: active ? mainItems : state.sessions,
    workspaceSessions: active
      ? {
          ...state.workspaceSessions,
          [active]: {
            status: (activeList?.status ?? 'ready') === 'error' ? 'error' : 'ready',
            items: mainItems,
            nextCursor: activeList?.nextCursor ?? null,
            error: activeList?.error,
          },
        }
      : state.workspaceSessions,
  };
}

/** Apply a mutation to the active workspace main listing (mirrors both mirrors). */
function updateActiveSessionList(
  state: WorkbenchState,
  mutate: (items: readonly WebSessionSummaryV1[]) => readonly WebSessionSummaryV1[]
): WorkbenchState {
  const active = state.workspaceId;
  const activeList = active ? state.workspaceSessions[active] : undefined;
  const base = activeList?.items ?? state.sessions;
  const items = mutate(base);
  const status =
    activeList?.status === 'error'
      ? 'error'
      : activeList?.status === 'loading'
        ? 'loading'
        : 'ready';
  return {
    ...state,
    sessions: active ? items : state.sessions,
    workspaceSessions: active
      ? {
          ...state.workspaceSessions,
          [active]: {
            status,
            items,
            nextCursor: activeList?.nextCursor ?? null,
            error: activeList?.error,
          },
        }
      : state.workspaceSessions,
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

function cacheSessionProjection(
  current: Readonly<Record<string, WebSessionSnapshotV1>>,
  snapshot: WebSessionSnapshotV1
): Readonly<Record<string, WebSessionSnapshotV1>> {
  const entries = Object.entries(current).filter(
    ([sessionId]) => sessionId !== snapshot.session.id
  );
  entries.push([snapshot.session.id, snapshot]);
  let estimatedBytes = entries.reduce(
    (total, [, value]) => total + estimateSessionProjectionBytes(value),
    0
  );
  while (
    entries.length > 1 &&
    (entries.length > MAX_SESSION_PROJECTIONS || estimatedBytes > MAX_SESSION_PROJECTION_BYTES)
  ) {
    const removed = entries.shift();
    if (removed) estimatedBytes -= estimateSessionProjectionBytes(removed[1]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function cacheRuntimeSummary(
  current: Readonly<Record<string, WebSessionRuntimeSummaryV1>>,
  summary: WebSessionRuntimeSummaryV1
): Readonly<Record<string, WebSessionRuntimeSummaryV1>> {
  const entries = Object.entries(current).filter(([sessionId]) => sessionId !== summary.sessionId);
  entries.push([summary.sessionId, summary]);
  return Object.freeze(Object.fromEntries(entries.slice(-MAX_SESSION_RUNTIME_SUMMARIES)));
}

function estimateSessionProjectionBytes(snapshot: WebSessionSnapshotV1): number {
  try {
    // UTF-16 code units provide a conservative serialized-size estimate for
    // the browser-owned cache budget across ASCII and CJK content.
    return JSON.stringify(snapshot).length * 2;
  } catch {
    return MAX_SESSION_PROJECTION_BYTES;
  }
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
    composer: null,
    modelCatalog: null,
    plan: null,
    loopStats: null,
    traces: [],
  };
}

function setSessionSnapshotSync(
  state: WorkbenchState,
  sessionId: string,
  sync: WorkbenchState['sessionSync'][string]
): WorkbenchState {
  const sessionSync: Record<string, WorkbenchState['sessionSync'][string]> = {
    ...state.sessionSync,
  };
  delete sessionSync[sessionId];
  sessionSync[sessionId] = sync;
  const overflow = Object.keys(sessionSync).length - MAX_SESSION_SYNC_ENTRIES;
  if (overflow > 0) {
    Object.keys(sessionSync)
      .filter(id => id !== state.activeSessionId && id !== sessionId)
      .slice(0, overflow)
      .forEach(id => delete sessionSync[id]);
  }
  return {
    ...state,
    sessionSync,
  };
}

function withTelemetry(
  state: WorkbenchState,
  delta: Partial<WorkbenchState['clientTelemetry']>
): WorkbenchState {
  const clientTelemetry: WorkbenchState['clientTelemetry'] = {
    sessionSwitches: state.clientTelemetry.sessionSwitches + (delta.sessionSwitches ?? 0),
    snapshotCacheHits: state.clientTelemetry.snapshotCacheHits + (delta.snapshotCacheHits ?? 0),
    snapshotLoads: state.clientTelemetry.snapshotLoads + (delta.snapshotLoads ?? 0),
    snapshotFailures: state.clientTelemetry.snapshotFailures + (delta.snapshotFailures ?? 0),
  };
  return { ...state, clientTelemetry };
}

function markSessionSnapshotReady(state: WorkbenchState, sessionId: string): WorkbenchState {
  const ready = setSessionSnapshotSync(state, sessionId, {
    status: 'ready',
    requestId: state.sessionSync[sessionId]?.requestId ?? null,
  });
  if (ready.notice?.domain !== 'session-snapshot' || ready.notice.sessionId !== sessionId) {
    return ready;
  }
  return { ...ready, notice: null };
}

function snapshotRequestMatches(
  state: WorkbenchState,
  sessionId: string,
  requestId?: number
): boolean {
  return requestId === undefined || state.sessionSync[sessionId]?.requestId === requestId;
}

function snapshotContextMatches(
  state: WorkbenchState,
  contextRevision?: string,
  workspaceId?: string
): boolean {
  return (
    (contextRevision === undefined || state.contextRevision === contextRevision) &&
    (workspaceId === undefined || state.workspaceId === workspaceId)
  );
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
  if (phase === 'live') return '本地 Web Host 事件流已连接';
  if (phase === 'offline') return '浏览器已离线，本地 Web Host 将在网络恢复后重连';
  if (phase === 'reconnecting') {
    return `正在重新连接本地 Web Host，第 ${Math.max(1, attempt)} 次尝试`;
  }
  if (phase === 'connecting') return '正在连接本地 Web Host';
  if (phase === 'replay-required') return '本地 Web Host 事件历史需要重新载入';
  return '本地 Web Host 已关闭';
}
