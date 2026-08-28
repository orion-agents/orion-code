import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
} from 'react';

import type { WebCommandResultV1, WebCommandV1, WebToolDetailPageV1 } from '../../src/web/protocol';

import { OrionWebApi, WebApiError, requestId, type EventStreamHandle } from './api';
import { workbenchReducer, type WorkbenchAction } from './reducer';
import {
  clearLegacyAppearance,
  prepareLegacyAppearanceMigration,
} from './settings/legacy-appearance';
import { SettingsMirror } from './settings/settings-mirror';
import type {
  SettingsOperationV1,
  WebSettingsDocumentV1,
  WebSettingsMutationResultV1,
} from './settings/types';
import {
  initialWorkbenchState,
  type DiagnosticsSnapshot,
  type WebSessionSummaryV1,
  type WorkbenchState,
} from './types';

export type WorkbenchAgentMode = 'interactive' | 'plan' | 'auto';

export interface WorkbenchActions {
  retryBoot(): Promise<void>;
  refreshDiagnostics(): Promise<void>;
  refreshToolDetails(): Promise<void>;
  recoverSession(): Promise<void>;
  switchWorkspace(path: string): Promise<void>;
  createSession(): Promise<void>;
  activateSession(sessionId: string): Promise<void>;
  loadOlderTranscript(): Promise<void>;
  renameSession(sessionId: string, name: string): Promise<void>;
  submit(text: string): Promise<WebCommandResultV1>;
  queue(text: string): Promise<WebCommandResultV1>;
  removeQueued(itemId: string): Promise<void>;
  clearQueue(): Promise<void>;
  interrupt(): Promise<void>;
  setMode(mode: WorkbenchAgentMode): Promise<void>;
  answerPermission(approved: boolean, scope?: 'once' | 'project' | 'global'): Promise<void>;
  controlGoal(
    action: 'create' | 'status' | 'pause' | 'resume' | 'clear',
    objective?: string
  ): Promise<void>;
  refreshSettings(): Promise<WebSettingsDocumentV1>;
  updateSettings(
    expectedRevision: string,
    operations: readonly SettingsOperationV1[],
    requestId: string
  ): Promise<WebSettingsMutationResultV1>;
  openSettingsDocument(): Promise<void>;
  readToolDetail(artifactId: string, offsetBytes?: number): Promise<WebToolDetailPageV1>;
  dismissNotice(): void;
}

export interface UseWorkbenchResult {
  readonly state: WorkbenchState;
  readonly actions: WorkbenchActions;
}

export function useWorkbench(): UseWorkbenchResult {
  const api = useMemo(() => new OrionWebApi(), []);
  const settingsMirror = useMemo(() => new SettingsMirror(() => api.settings()), [api]);
  const [state, dispatch] = useReducer(workbenchReducer, initialWorkbenchState);
  const [streamEpoch, setStreamEpoch] = useState(0);
  const stateRef = useRef(state);
  const streamRef = useRef<EventStreamHandle | null>(null);
  const operationSequence = useRef(0);
  const baselineStarted = useRef(false);
  stateRef.current = state;

  useEffect(
    () =>
      settingsMirror.subscribe(() => {
        dispatch({ type: 'settings_mirror_changed', snapshot: settingsMirror.getSnapshot() });
      }),
    [settingsMirror]
  );

  const loadSessionSnapshot = useCallback(
    async (sessionId: string) => {
      const snapshot = await api.sessionSnapshot(sessionId);
      if (snapshot.session.id !== sessionId) {
        throw new WebApiError('Host 返回了其他会话的快照。', 502);
      }
      dispatch({ type: 'session_snapshot_loaded', snapshot });
      return snapshot;
    },
    [api]
  );

  const loadBaseline = useCallback(async () => {
    try {
      const bootstrap = await api.bootstrap();
      settingsMirror.reset();
      settingsMirror.accept(bootstrap.settings);
      const snapshotRequest = bootstrap.activeSessionId
        ? api
            .sessionSnapshot(bootstrap.activeSessionId)
            .then(snapshot => ({ snapshot, error: undefined }))
            .catch(error => ({ snapshot: null, error }))
        : Promise.resolve({ snapshot: null, error: undefined });
      const [workspaces, sessions, mirrorSnapshot, sessionResult] = await Promise.all([
        api.listWorkspaces(),
        api.listSessions(),
        settingsMirror.refresh(),
        snapshotRequest,
      ]);
      const settings = await migrateLegacyAppearance(
        api,
        settingsMirror,
        mirrorSnapshot.document ?? mirrorSnapshot.lastGood ?? bootstrap.settings
      );
      dispatch({
        type: 'baseline_loaded',
        bootstrap,
        workspaces,
        sessions: sessions.sessions,
        diagnostics: {},
        settings,
        skills: [],
        mcpServers: [],
        toolDetails: [],
      });
      if (sessionResult.snapshot) {
        dispatch({ type: 'session_snapshot_loaded', snapshot: sessionResult.snapshot });
      }
      if (sessionResult.error) {
        showError(dispatch, '会话快照加载失败', sessionResult.error, 'warning');
      }

      // Catalogs and diagnostics do not gate the composer. Load them after the
      // cursor-bound transcript baseline so a large artifact directory cannot
      // hold the entire application in its boot overlay.
      void Promise.all([
        api.diagnostics().catch(() => ({}) as DiagnosticsSnapshot),
        api.skills().catch(() => ({ skills: [] })),
        api.mcp().catch(() => ({ servers: [] })),
        api.toolDetails().catch(() => ({ details: [] })),
      ]).then(([diagnostics, skills, mcp, toolDetails]) => {
        dispatch({ type: 'diagnostics_loaded', diagnostics });
        dispatch({ type: 'capabilities_loaded', skills: skills.skills, mcpServers: mcp.servers });
        dispatch({ type: 'tool_details_loaded', details: toolDetails.details });
      });
    } catch (error) {
      dispatch({ type: 'boot_failed', message: errorMessage(error) });
      throw error;
    }
  }, [api, settingsMirror]);

  const refreshWorkspaceResources = useCallback(
    async (sessionId: string | null = stateRef.current.activeSessionId) => {
      const [workspaces, sessions] = await Promise.all([api.listWorkspaces(), api.listSessions()]);
      dispatch({ type: 'workspaces_loaded', value: workspaces });
      dispatch({ type: 'sessions_loaded', sessions: sessions.sessions });
      if (sessionId) await loadSessionSnapshot(sessionId);
      void Promise.all([
        api.diagnostics().catch(() => ({}) as DiagnosticsSnapshot),
        api.skills().catch(() => ({ skills: [] })),
        api.mcp().catch(() => ({ servers: [] })),
        api.toolDetails().catch(() => ({ details: [] })),
      ]).then(([diagnostics, skills, mcp, toolDetails]) => {
        dispatch({ type: 'diagnostics_loaded', diagnostics });
        dispatch({ type: 'capabilities_loaded', skills: skills.skills, mcpServers: mcp.servers });
        dispatch({ type: 'tool_details_loaded', details: toolDetails.details });
      });
    },
    [api, loadSessionSnapshot]
  );

  useEffect(() => {
    // React StrictMode replays effects in development; bootstrap may perform a one-time
    // appearance migration, so it must only be started once for this mounted App instance.
    if (baselineStarted.current) return undefined;
    baselineStarted.current = true;
    let active = true;
    void loadBaseline().catch(() => {
      if (!active) return;
    });
    return () => {
      active = false;
    };
  }, [loadBaseline]);

  const hasBootstrap = state.bootstrap !== null;
  useEffect(() => {
    if (!hasBootstrap) return undefined;
    const stream = api.connectEvents({
      cursor: stateRef.current.lastCursor,
      onEvent: envelope => {
        dispatch({ type: 'event_received', envelope });
        if (envelope.type === 'settings_invalidated') {
          void settingsMirror.invalidate(envelope.payload.revision, envelope.payload.state);
        }
      },
      onStatus: (phase, attempt) => dispatch({ type: 'connection_changed', phase, attempt }),
      onProtocolError: message =>
        dispatch({
          type: 'notice',
          notice: {
            id: Date.now(),
            tone: 'error',
            title: '收到无法识别的 Runtime 事件',
            detail: message,
          },
        }),
    });
    streamRef.current = stream;
    return () => {
      stream.close();
      if (streamRef.current === stream) streamRef.current = null;
    };
    // The stream owns its cursor. Recreating it on every event would cause replay churn.
  }, [api, hasBootstrap, settingsMirror, streamEpoch]);

  const pauseEventStream = useCallback(() => {
    streamRef.current?.close();
    streamRef.current = null;
  }, []);
  const resumeEventStream = useCallback(() => {
    setStreamEpoch(epoch => epoch + 1);
  }, []);

  const previousWorkspace = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!state.workspace || state.boot !== 'ready') return;
    if (previousWorkspace.current === undefined) {
      previousWorkspace.current = state.workspace;
      return;
    }
    if (previousWorkspace.current === state.workspace) return;
    previousWorkspace.current = state.workspace;
    if (state.pendingAction) return;
    pauseEventStream();
    void loadBaseline()
      .catch(error => showError(dispatch, '工作区刷新失败', error))
      .finally(resumeEventStream);
  }, [
    loadBaseline,
    pauseEventStream,
    resumeEventStream,
    state.boot,
    state.pendingAction,
    state.workspace,
  ]);

  const previousSession = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (state.boot !== 'ready') return;
    if (previousSession.current === undefined) {
      previousSession.current = state.activeSessionId;
      return;
    }
    if (previousSession.current === state.activeSessionId) return;
    previousSession.current = state.activeSessionId;
    if (state.pendingAction || !state.activeSessionId) return;
    if (state.sessionSnapshot?.session.id === state.activeSessionId) return;
    pauseEventStream();
    void refreshWorkspaceResources(state.activeSessionId)
      .catch(error => showError(dispatch, '会话刷新失败', error))
      .finally(resumeEventStream);
  }, [
    pauseEventStream,
    refreshWorkspaceResources,
    resumeEventStream,
    state.activeSessionId,
    state.boot,
    state.pendingAction,
    state.sessionSnapshot,
  ]);

  const runOperation = useCallback(
    async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
      const sequence = ++operationSequence.current;
      dispatch({ type: 'pending_action', label });
      try {
        return await operation();
      } catch (error) {
        showError(dispatch, `${label}失败`, error);
        throw error;
      } finally {
        if (operationSequence.current === sequence) {
          dispatch({ type: 'pending_action', label: null });
        }
      }
    },
    []
  );

  const sendCommand = useCallback(
    async (label: string, command: Omit<WebCommandV1, 'requestId'>) =>
      runOperation(label, async () => {
        const result = await api.command(command);
        assertCommandResult(result);
        return result;
      }),
    [api, runOperation]
  );

  const retryBoot = useCallback(
    () => runOperation('重新连接', loadBaseline),
    [loadBaseline, runOperation]
  );

  const refreshDiagnostics = useCallback(
    () =>
      runOperation('刷新诊断', async () => {
        const diagnostics = await api.diagnostics();
        dispatch({ type: 'diagnostics_loaded', diagnostics });
      }),
    [api, runOperation]
  );

  const refreshToolDetails = useCallback(
    () =>
      runOperation('刷新工具详情', async () => {
        const result = await api.toolDetails();
        dispatch({ type: 'tool_details_loaded', details: result.details });
      }),
    [api, runOperation]
  );

  const recoverSession = useCallback(
    () =>
      runOperation('恢复会话', async () => {
        pauseEventStream();
        dispatch({ type: 'recovering' });
        try {
          await loadBaseline();
        } finally {
          resumeEventStream();
        }
      }),
    [loadBaseline, pauseEventStream, resumeEventStream, runOperation]
  );

  const switchWorkspace = useCallback(
    (path: string) =>
      runOperation('切换工作区', async () => {
        pauseEventStream();
        try {
          const result = await api.activateWorkspace(path);
          dispatch({ type: 'workspaces_loaded', value: result });
          dispatch({ type: 'reset_session_view', activeSessionId: null });
          await loadBaseline();
        } finally {
          resumeEventStream();
        }
      }),
    [api, loadBaseline, pauseEventStream, resumeEventStream, runOperation]
  );

  const createSession = useCallback(
    () =>
      runOperation('创建会话', async () => {
        pauseEventStream();
        try {
          const session = await api.createSession();
          dispatch({ type: 'reset_session_view', activeSessionId: session.id });
          const sessions = await api.listSessions();
          dispatch({ type: 'sessions_loaded', sessions: sessions.sessions });
          await loadSessionSnapshot(session.id);
        } finally {
          resumeEventStream();
        }
      }),
    [api, loadSessionSnapshot, pauseEventStream, resumeEventStream, runOperation]
  );

  const activateSession = useCallback(
    (sessionId: string) =>
      runOperation('恢复会话', async () => {
        pauseEventStream();
        try {
          await api.activateSession(sessionId);
          dispatch({ type: 'reset_session_view', activeSessionId: sessionId });
          const sessions = await api.listSessions();
          dispatch({ type: 'sessions_loaded', sessions: sessions.sessions });
          await loadSessionSnapshot(sessionId);
          void api
            .toolDetails()
            .then(details => dispatch({ type: 'tool_details_loaded', details: details.details }))
            .catch(() => undefined);
        } finally {
          resumeEventStream();
        }
      }),
    [api, loadSessionSnapshot, pauseEventStream, resumeEventStream, runOperation]
  );

  const loadOlderTranscript = useCallback(
    () =>
      runOperation('加载更早记录', async () => {
        const current = stateRef.current.sessionSnapshot;
        const sessionId = stateRef.current.activeSessionId;
        const cursor = current?.transcript.nextCursor;
        if (!current || !sessionId || !cursor) return;
        const older = await api.sessionSnapshot(sessionId, cursor);
        if (
          older.session.id !== current.session.id ||
          older.threadId !== current.threadId ||
          older.threadCursor !== current.threadCursor ||
          older.projectionDigest !== current.projectionDigest
        ) {
          throw new WebApiError('加载历史记录时会话快照发生变化，请先恢复会话。', 409);
        }
        dispatch({ type: 'older_transcript_loaded', snapshot: older });
      }),
    [api, runOperation]
  );

  const renameSession = useCallback(
    (sessionId: string, name: string) =>
      runOperation('重命名会话', async () => {
        const updated = await api.renameSession(sessionId, name);
        const sessions = replaceSession(stateRef.current.sessions, updated);
        dispatch({ type: 'sessions_loaded', sessions });
      }),
    [api, runOperation]
  );

  const submit = useCallback(
    (text: string) => sendCommand('提交任务', { type: 'submit', text }),
    [sendCommand]
  );
  const queue = useCallback(
    (text: string) => sendCommand('加入队列', { type: 'queue_followup', text }),
    [sendCommand]
  );
  const removeQueued = useCallback(
    async (itemId: string) => {
      await sendCommand('移除排队消息', { type: 'remove_followup', itemId });
    },
    [sendCommand]
  );
  const clearQueue = useCallback(async () => {
    await sendCommand('清空队列', { type: 'clear_followups' });
  }, [sendCommand]);
  const interrupt = useCallback(async () => {
    await sendCommand('中断任务', { type: 'interrupt' });
  }, [sendCommand]);
  const setMode = useCallback(
    async (agentMode: WorkbenchAgentMode) => {
      if (stateRef.current.mode.baseMode === agentMode && !stateRef.current.mode.pendingBaseMode) {
        return;
      }
      await sendCommand('切换模式', { type: 'set_agent_mode', agentMode });
    },
    [sendCommand]
  );

  const answerPermission = useCallback(
    async (approved: boolean, scope: 'once' | 'project' | 'global' = 'once') => {
      const request = stateRef.current.permission;
      if (!request) return;
      await sendCommand(approved ? '确认工具权限' : '拒绝工具权限', {
        type: 'permission_decision',
        requestPermissionId: request.id,
        approved,
        scope,
      });
      dispatch({ type: 'approval_resolved', requestId: request.id, approved });
    },
    [sendCommand]
  );

  const controlGoal = useCallback(
    async (goalAction: 'create' | 'status' | 'pause' | 'resume' | 'clear', objective?: string) => {
      await sendCommand('更新 Goal', { type: 'goal_control', goalAction, objective });
      pauseEventStream();
      try {
        const sessionId = stateRef.current.activeSessionId;
        const [diagnostics] = await Promise.all([
          api.diagnostics(),
          sessionId ? loadSessionSnapshot(sessionId) : Promise.resolve(),
        ]);
        dispatch({ type: 'diagnostics_loaded', diagnostics });
      } finally {
        resumeEventStream();
      }
    },
    [api, loadSessionSnapshot, pauseEventStream, resumeEventStream, sendCommand]
  );

  const refreshSettings = useCallback(async () => {
    const snapshot = await settingsMirror.refresh();
    const document = snapshot.document ?? snapshot.lastGood;
    if (!document) throw new WebApiError(snapshot.error ?? '设置尚不可用。', 503);
    return document;
  }, [settingsMirror]);

  const updateSettings = useCallback(
    async (
      expectedRevision: string,
      operations: readonly SettingsOperationV1[],
      stableRequestId: string
    ) => {
      if (operations.length < 1 || operations.length > 20) {
        throw new WebApiError(
          '设置变更必须包含 1 到 20 个字段。',
          400,
          'settings_invalid_operation'
        );
      }
      const result = await api.updateSettings(expectedRevision, operations, stableRequestId);
      settingsMirror.accept(result.settings);
      return result;
    },
    [api, settingsMirror]
  );

  const openSettingsDocument = useCallback(async () => {
    await api.openSettingsDocument();
  }, [api]);

  const readToolDetail = useCallback(
    (artifactId: string, offsetBytes = 0) => api.readToolDetail(artifactId, offsetBytes),
    [api]
  );

  const dismissNotice = useCallback(() => dispatch({ type: 'notice', notice: null }), []);

  const actions = useMemo<WorkbenchActions>(
    () => ({
      retryBoot,
      refreshDiagnostics,
      refreshToolDetails,
      recoverSession,
      switchWorkspace,
      createSession,
      activateSession,
      loadOlderTranscript,
      renameSession,
      submit,
      queue,
      removeQueued,
      clearQueue,
      interrupt,
      setMode,
      answerPermission,
      controlGoal,
      refreshSettings,
      updateSettings,
      openSettingsDocument,
      readToolDetail,
      dismissNotice,
    }),
    [
      activateSession,
      loadOlderTranscript,
      answerPermission,
      clearQueue,
      controlGoal,
      createSession,
      dismissNotice,
      interrupt,
      queue,
      readToolDetail,
      recoverSession,
      refreshDiagnostics,
      refreshSettings,
      refreshToolDetails,
      removeQueued,
      renameSession,
      retryBoot,
      setMode,
      submit,
      switchWorkspace,
      updateSettings,
      openSettingsDocument,
    ]
  );

  return { state, actions };
}

async function migrateLegacyAppearance(
  api: OrionWebApi,
  mirror: SettingsMirror,
  initialDocument: WebSettingsDocumentV1
): Promise<WebSettingsDocumentV1> {
  let document = initialDocument;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const migration = prepareLegacyAppearanceMigration(document);
    if (migration.keysToClear.length === 0) return document;

    // Keep the legacy values until Host persistence is known to be healthy and writable.
    if (document.state !== 'ready' || !document.writable) return document;
    if (migration.operations.length === 0) {
      clearLegacyAppearance(migration.keysToClear);
      return document;
    }

    try {
      const result = await api.updateSettings(document.revision, migration.operations, requestId());
      mirror.accept(result.settings);
      clearLegacyAppearance(migration.keysToClear);
      return result.settings;
    } catch (error) {
      if (
        attempt === 0 &&
        error instanceof WebApiError &&
        error.code === 'settings_revision_conflict'
      ) {
        const refreshed = await mirror.refresh();
        const latest = refreshed.document ?? refreshed.lastGood;
        if (latest) {
          document = latest;
          continue;
        }
      }
      // Migration is best-effort; retaining the old keys makes a later retry safe.
      return document;
    }
  }

  return document;
}

function replaceSession(
  sessions: readonly WebSessionSummaryV1[],
  updated: WebSessionSummaryV1
): readonly WebSessionSummaryV1[] {
  return sessions.map(session => (session.id === updated.id ? updated : session));
}

function assertCommandResult(result: WebCommandResultV1): void {
  if (
    result.result.includes('failed') ||
    result.result.includes('invalid') ||
    result.result.includes('rejected') ||
    result.result.includes('ignored') ||
    result.result.includes('full') ||
    result.result === 'empty'
  ) {
    throw new WebApiError(commandDetail(result), 409);
  }
}

function commandDetail(result: WebCommandResultV1): string {
  if (result.detail) {
    try {
      const detail = JSON.parse(result.detail) as { reason?: unknown };
      if (typeof detail.reason === 'string') return detail.reason;
    } catch {
      // Fall through to the stable result code.
    }
  }
  return `Runtime 未接受操作：${result.result}`;
}

function showError(
  dispatch: Dispatch<WorkbenchAction>,
  title: string,
  error: unknown,
  tone: 'warning' | 'error' = 'error'
): void {
  dispatch({
    type: 'notice',
    notice: { id: Date.now(), tone, title, detail: errorMessage(error) },
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof WebApiError) return error.message;
  if (error instanceof Error) return error.message;
  return '发生未知错误。';
}
