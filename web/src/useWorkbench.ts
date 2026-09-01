import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
} from 'react';

import type {
  WebCommandResultV1,
  WebCommandV1,
  WebComposerActionV1,
  WebContextReferenceV1,
  WebContextGuardV1,
  WebFileContentPageV1,
  WebFileTreePageV1,
  WebGitDiffPageV1,
  WebGitLogPageV1,
  WebGitStatusV1,
  WebReviewSnapshotV1,
  WebTerminalCreateResultV1,
  WebTerminalMetadataV1,
  WebToolDetailPageV1,
} from '../../src/web/protocol';

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
import { initialWorkbenchState, type DiagnosticsSnapshot, type WorkbenchState } from './types';
import { upsertSessionSummary } from './state/session-collection';
import { removeComposerDraftsForWorkspace } from './state/composer-drafts';
import { selectPreferredForegroundSession } from './state/foreground-session';

export type WorkbenchAgentMode = 'interactive' | 'plan' | 'auto';

type ComposerActionInputV1 = WebComposerActionV1 extends infer Action
  ? Action extends WebComposerActionV1
    ? Omit<
        Action,
        | 'requestId'
        | 'workspaceId'
        | 'expectedContextRevision'
        | 'expectedSessionId'
        | 'expectedSessionRuntimeRevision'
        | 'expectedControlRevision'
      >
    : never
  : never;

export interface WorkbenchActions {
  retryBoot(): Promise<void>;
  refreshDiagnostics(): Promise<void>;
  refreshToolDetails(): Promise<void>;
  loadMoreWorkspaces(): Promise<void>;
  loadMoreSessions(): Promise<void>;
  loadWorkspaceSessions(workspaceId: string, append?: boolean): Promise<void>;
  refreshWorkspaceProjectSummary(workspaceId: string): Promise<void>;
  loadMoreCapabilities(): Promise<void>;
  loadMoreToolDetails(): Promise<void>;
  recoverSession(): Promise<void>;
  switchWorkspace(path: string): Promise<void>;
  activateContext(workspaceId: string, sessionId: string | null): Promise<void>;
  setWorkspacePinned(workspaceId: string, pinned: boolean): Promise<void>;
  removeWorkspace(workspaceId: string): Promise<void>;
  createSession(): Promise<void>;
  activateSession(sessionId: string): Promise<void>;
  loadOlderTranscript(): Promise<void>;
  renameSession(sessionId: string, name: string): Promise<void>;
  submit(
    text: string,
    contextReferences?: readonly WebContextReferenceV1[]
  ): Promise<WebCommandResultV1>;
  queue(
    text: string,
    contextReferences?: readonly WebContextReferenceV1[]
  ): Promise<WebCommandResultV1>;
  removeQueued(itemId: string, expectedItemRevision: number): Promise<void>;
  editQueued(itemId: string, expectedItemRevision: number, text: string): Promise<void>;
  moveQueued(itemId: string, expectedItemRevision: number, targetIndex: number): Promise<void>;
  clearQueue(): Promise<void>;
  cancelQueuedTurn(): Promise<void>;
  interrupt(): Promise<void>;
  setMode(mode: WorkbenchAgentMode): Promise<void>;
  setPermissionOverride(value: 'ask' | 'allow' | 'deny' | null): Promise<void>;
  loadModelCatalog(): Promise<void>;
  selectModel(
    modelId: string,
    effort?: import('../../src/web/protocol').WebEffortPreferenceV1
  ): Promise<void>;
  compactContext(): Promise<void>;
  reviewPlan(
    planDigest: string,
    action: 'approve' | 'continue' | 'cancel',
    feedback?: string
  ): Promise<void>;
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
  listFiles(parentId?: string, cursor?: string): Promise<WebFileTreePageV1>;
  readFileContent(fileId: string, cursor?: string): Promise<WebFileContentPageV1>;
  gitStatus(cursor?: string): Promise<WebGitStatusV1>;
  gitLog(cursor?: string): Promise<WebGitLogPageV1>;
  gitDiff(fileId: string, cursor?: string): Promise<WebGitDiffPageV1>;
  review(): Promise<WebReviewSnapshotV1>;
  terminals(): Promise<readonly WebTerminalMetadataV1[]>;
  createTerminal(cols: number, rows: number): Promise<WebTerminalCreateResultV1>;
  terminalAttachTicket(terminalId: string): Promise<WebTerminalCreateResultV1>;
  closeTerminal(terminalId: string): Promise<void>;
  terminalSocket(terminalId: string): WebSocket;
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
  const resourceGeneration = useRef(0);
  const metadataRefreshSequence = useRef(new Map<string, number>());
  const metadataRefreshOrdinal = useRef(0);
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
    async (sessionId: string, context = requireContextGuard(stateRef.current)) => {
      try {
        const snapshot = await api.sessionSnapshot(sessionId, context);
        if (snapshot.session.id !== sessionId) {
          throw new WebApiError('Host 返回了其他会话的快照。', 502);
        }
        dispatch({
          type: 'session_snapshot_loaded',
          snapshot,
          // HTTP snapshots and the SSE stream share one Host-global cursor.
          // While a stream is active, advancing from the snapshot could skip a
          // control event that is already in flight. A paused stream, however,
          // needs the snapshot cursor as its next replay baseline.
          advanceEventCursor: streamRef.current === null,
        });
        return snapshot;
      } catch (error) {
        dispatch({ type: 'snapshot_failed', sessionId, detail: errorMessage(error) });
        throw error;
      }
    },
    [api]
  );

  const loadBaselineOnce = useCallback(async () => {
    const generation = ++resourceGeneration.current;
    try {
      const bootstrap = await api.bootstrap();
      const context = {
        expectedContextRevision: bootstrap.contextRevision,
        workspaceId: bootstrap.workspaceId,
      } satisfies WebContextGuardV1;
      settingsMirror.reset();
      settingsMirror.accept(bootstrap.settings);
      const [workspaces, sessions, mirrorSnapshot] = await Promise.all([
        api.listWorkspaces(context),
        api.listSessions(context),
        settingsMirror.refresh(),
      ]);
      const foregroundSessionId = preferredForegroundSession(
        bootstrap.workspaceId,
        sessions.sessions,
        bootstrap.activeSessionId
      );
      rememberForegroundSession(bootstrap.workspaceId, foregroundSessionId);
      const effectiveBootstrap = Object.freeze({
        ...bootstrap,
        activeSessionId: foregroundSessionId,
      });
      const sessionResult = foregroundSessionId
        ? await api
            .sessionSnapshot(foregroundSessionId, context)
            .then(snapshot => ({ snapshot, error: undefined }))
            .catch(error => ({ snapshot: null, error }))
        : { snapshot: null, error: undefined };
      const settings = await migrateLegacyAppearance(
        api,
        settingsMirror,
        mirrorSnapshot.document ?? mirrorSnapshot.lastGood ?? bootstrap.settings,
        context
      );
      if (generation !== resourceGeneration.current) return;
      dispatch({
        type: 'baseline_loaded',
        bootstrap: effectiveBootstrap,
        workspaces,
        sessions: sessions.sessions,
        sessionNextCursor: sessions.nextCursor,
        diagnostics: {},
        settings,
        skills: [],
        skillNextCursor: null,
        mcpServers: [],
        mcpNextCursor: null,
        toolDetails: [],
        toolDetailNextCursor: null,
      });
      if (sessionResult.snapshot) {
        if (sessionResult.snapshot.session.id === foregroundSessionId) {
          dispatch({ type: 'session_snapshot_loaded', snapshot: sessionResult.snapshot });
        } else {
          dispatch({
            type: 'snapshot_failed',
            sessionId: foregroundSessionId,
            detail: '活动会话已在其他页面发生变化，请恢复当前会话。',
          });
        }
      }
      if (sessionResult.error) {
        dispatch({
          type: 'snapshot_failed',
          sessionId: foregroundSessionId,
          detail: errorMessage(sessionResult.error),
        });
        showError(dispatch, '会话快照加载失败', sessionResult.error, 'warning');
      }

      void api
        .workspaceProjectSummary(bootstrap.workspaceId, context)
        .then(summary => {
          if (generation === resourceGeneration.current) {
            dispatch({ type: 'workspace_project_summary_loaded', summary });
          }
        })
        .catch(() => undefined);

      // Catalogs and diagnostics do not gate the composer. Load them after the
      // cursor-bound transcript baseline so a large artifact directory cannot
      // hold the entire application in its boot overlay.
      void Promise.all([
        api.diagnostics(context).catch(() => ({}) as DiagnosticsSnapshot),
        api.skills(context).catch(() => ({ skills: [], nextCursor: null })),
        api.mcp(context).catch(() => ({ servers: [], nextCursor: null })),
        api.toolDetails(context).catch(() => ({ details: [], nextCursor: null })),
      ]).then(([diagnostics, skills, mcp, toolDetails]) => {
        if (generation !== resourceGeneration.current) return;
        dispatch({ type: 'diagnostics_loaded', diagnostics });
        dispatch({
          type: 'capabilities_loaded',
          skills: skills.skills,
          skillNextCursor: skills.nextCursor,
          mcpServers: mcp.servers,
          mcpNextCursor: mcp.nextCursor,
        });
        dispatch({
          type: 'tool_details_loaded',
          details: toolDetails.details,
          nextCursor: toolDetails.nextCursor,
        });
      });
    } catch (error) {
      throw error;
    }
  }, [api, settingsMirror]);

  const loadBaseline = useCallback(async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await loadBaselineOnce();
        return;
      } catch (error) {
        lastError = error;
        if (!isBaselineRetryable(error) || attempt === 2) break;
        await waitForBaselineRetry(100 * 3 ** attempt);
      }
    }
    dispatch({ type: 'boot_failed', message: errorMessage(lastError) });
    throw lastError;
  }, [loadBaselineOnce]);

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
        if (needsSessionSnapshotRefresh(envelope)) {
          const current = stateRef.current;
          if (envelope.sessionId && current.contextRevision && current.workspaceId) {
            const sessionId = envelope.sessionId;
            const sequence = ++metadataRefreshOrdinal.current;
            metadataRefreshSequence.current.set(sessionId, sequence);
            const contextRevision = current.contextRevision;
            const workspaceId = current.workspaceId;
            void api
              .sessionSnapshot(sessionId, {
                expectedContextRevision: contextRevision,
                workspaceId,
              })
              .then(snapshot => {
                if (metadataRefreshSequence.current.get(sessionId) !== sequence) return;
                dispatch({
                  type: 'durable_session_metadata_loaded',
                  snapshot,
                  contextRevision,
                  workspaceId,
                });
              })
              .catch(() => undefined)
              .finally(() => {
                if (metadataRefreshSequence.current.get(sessionId) === sequence) {
                  metadataRefreshSequence.current.delete(sessionId);
                }
              });
          }
        }
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

  useEffect(() => {
    if (!state.workspace || state.boot !== 'ready') return;
    if (state.pendingAction) return;
    if (state.bootstrap?.workspace === state.workspace) return;
    pauseEventStream();
    void loadBaseline()
      .catch(error => showError(dispatch, '工作区刷新失败', error))
      .finally(resumeEventStream);
  }, [
    loadBaseline,
    pauseEventStream,
    resumeEventStream,
    state.boot,
    state.bootstrap?.workspace,
    state.pendingAction,
    state.workspace,
  ]);

  useEffect(() => {
    if (state.boot !== 'ready') return;
    if (state.pendingAction || !state.activeSessionId) return;
    if (state.bootstrap?.workspace !== state.workspace) return;
    if (state.sessionSnapshot?.session.id === state.activeSessionId) {
      return;
    }
    void loadSessionSnapshot(state.activeSessionId).catch(error =>
      showError(dispatch, '会话刷新失败', error)
    );
  }, [
    loadSessionSnapshot,
    state.activeSessionId,
    state.boot,
    state.bootstrap?.workspace,
    state.pendingAction,
    state.sessionSnapshot,
    state.workspace,
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
    async (
      label: string,
      command: Omit<
        WebCommandV1,
        | 'requestId'
        | 'workspaceId'
        | 'expectedContextRevision'
        | 'expectedSessionId'
        | 'expectedSessionRuntimeRevision'
      >
    ) =>
      runOperation(label, async () => {
        if (stateRef.current.connection !== 'live') {
          throw new WebApiError(
            '会话连接尚未同步，请恢复连接后重试。',
            409,
            'session_not_synchronized'
          );
        }
        const expectedSessionId = stateRef.current.activeSessionId;
        if (!expectedSessionId) {
          throw new WebApiError('当前没有可接收命令的活动会话。', 409, 'active_session_changed');
        }
        const snapshot = stateRef.current.sessionSnapshot;
        if (!snapshot || snapshot.session.id !== expectedSessionId) {
          throw new WebApiError(
            '会话 Runtime 状态尚未同步，请刷新后重试。',
            409,
            'session_runtime_revision_conflict'
          );
        }
        try {
          const result = await api.command({
            ...command,
            workspaceId: stateRef.current.workspaceId,
            expectedContextRevision: stateRef.current.contextRevision,
            expectedSessionId,
            expectedSessionRuntimeRevision: snapshot.sessionRuntime.runtimeRevision,
          });
          assertCommandResult(result);
          return result;
        } catch (error) {
          if (
            error instanceof WebApiError &&
            [
              'context_revision_conflict',
              'active_session_changed',
              'session_runtime_revision_conflict',
            ].includes(error.code ?? '')
          ) {
            dispatch({
              type: 'snapshot_failed',
              sessionId: expectedSessionId,
              detail: error.message,
            });
          }
          throw error;
        }
      }),
    [api, runOperation]
  );

  const sendComposerAction = useCallback(
    async (label: string, action: ComposerActionInputV1) =>
      runOperation(label, async () => {
        const current = stateRef.current;
        const composer = current.composer;
        if (
          current.connection !== 'live' ||
          !current.activeSessionId ||
          !composer ||
          composer.sessionId !== current.activeSessionId
        ) {
          throw new WebApiError(
            'Composer 控制状态尚未与活动会话同步。',
            409,
            'composer_control_conflict'
          );
        }
        try {
          const result = await api.composerAction(current.activeSessionId, {
            ...action,
            workspaceId: current.workspaceId,
            expectedContextRevision: current.contextRevision,
            expectedSessionId: current.activeSessionId,
            expectedSessionRuntimeRevision: composer.sessionRuntime.runtimeRevision,
            expectedControlRevision: composer.controlRevision,
          } as Parameters<OrionWebApi['composerAction']>[1]);
          dispatch({ type: 'composer_loaded', composer: result.state });
          return result;
        } catch (error) {
          if (
            error instanceof WebApiError &&
            [
              'composer_control_conflict',
              'context_revision_conflict',
              'active_session_changed',
              'session_runtime_revision_conflict',
            ].includes(error.code ?? '')
          ) {
            dispatch({
              type: 'snapshot_failed',
              sessionId: current.activeSessionId,
              detail: error.message,
            });
          }
          throw error;
        }
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
        const generation = ++resourceGeneration.current;
        const diagnostics = await api.diagnostics(requireContextGuard(stateRef.current));
        if (generation !== resourceGeneration.current) return;
        dispatch({ type: 'diagnostics_loaded', diagnostics });
      }),
    [api, runOperation]
  );

  const refreshToolDetails = useCallback(
    () =>
      runOperation('刷新工具详情', async () => {
        const generation = ++resourceGeneration.current;
        const result = await api.toolDetails(requireContextGuard(stateRef.current));
        if (generation !== resourceGeneration.current) return;
        dispatch({
          type: 'tool_details_loaded',
          details: result.details,
          nextCursor: result.nextCursor,
        });
      }),
    [api, runOperation]
  );

  const loadMoreWorkspaces = useCallback(
    () =>
      runOperation('加载更多工作区', async () => {
        const context = requireContextGuard(stateRef.current);
        const cursor = stateRef.current.workspaceNextCursor;
        if (!cursor) return;
        try {
          const result = await api.listWorkspaces(context, cursor);
          dispatch({ type: 'workspaces_loaded', value: result, append: true });
        } catch (error) {
          if (!isCollectionCursorStale(error)) throw error;
          dispatch({ type: 'workspaces_loaded', value: await api.listWorkspaces(context) });
        }
      }),
    [api, runOperation]
  );

  const loadMoreSessions = useCallback(
    () =>
      runOperation('加载更多会话', async () => {
        const cursor = stateRef.current.sessionNextCursor;
        if (!cursor) return;
        const context = requireContextGuard(stateRef.current);
        try {
          const result = await api.listSessions(context, cursor);
          dispatch({
            type: 'sessions_loaded',
            sessions: result.sessions,
            nextCursor: result.nextCursor,
            append: true,
          });
        } catch (error) {
          if (!isCollectionCursorStale(error)) throw error;
          const refreshed = await api.listSessions(context);
          dispatch({
            type: 'sessions_loaded',
            sessions: refreshed.sessions,
            nextCursor: refreshed.nextCursor,
          });
        }
      }),
    [api, runOperation]
  );

  const loadWorkspaceSessions = useCallback(
    async (workspaceId: string, append = false) => {
      const context = requireContextGuard(stateRef.current);
      const current = stateRef.current.workspaceSessions[workspaceId];
      const cursor = append ? current?.nextCursor : undefined;
      if (append && !cursor) return;
      dispatch({ type: 'workspace_sessions_loading', workspaceId });
      const summaryRequest = api.workspaceProjectSummary(workspaceId, context).catch(() => null);
      try {
        const result = await api.listWorkspaceSessions(workspaceId, context, cursor ?? undefined);
        dispatch({
          type: 'workspace_sessions_loaded',
          workspaceId,
          sessions: result.sessions,
          nextCursor: result.nextCursor,
          append,
        });
        const summary = await summaryRequest;
        if (summary) dispatch({ type: 'workspace_project_summary_loaded', summary });
      } catch (error) {
        dispatch({ type: 'workspace_sessions_failed', workspaceId, detail: errorMessage(error) });
        throw error;
      }
    },
    [api]
  );

  const refreshWorkspaceProjectSummary = useCallback(
    async (workspaceId: string) => {
      const summary = await api.workspaceProjectSummary(
        workspaceId,
        requireContextGuard(stateRef.current)
      );
      dispatch({ type: 'workspace_project_summary_loaded', summary });
    },
    [api]
  );

  const loadMoreCapabilities = useCallback(
    () =>
      runOperation('加载更多能力', async () => {
        const context = requireContextGuard(stateRef.current);
        const skillCursor = stateRef.current.skillNextCursor;
        const mcpCursor = stateRef.current.mcpNextCursor;
        if (!skillCursor && !mcpCursor) return;
        try {
          const [skills, mcp] = await Promise.all([
            skillCursor
              ? api.skills(context, skillCursor)
              : Promise.resolve({ skills: [], nextCursor: null }),
            mcpCursor
              ? api.mcp(context, mcpCursor)
              : Promise.resolve({ servers: [], nextCursor: null }),
          ]);
          dispatch({
            type: 'capabilities_loaded',
            skills: skills.skills,
            skillNextCursor: skills.nextCursor,
            mcpServers: mcp.servers,
            mcpNextCursor: mcp.nextCursor,
            append: true,
          });
        } catch (error) {
          if (!isCollectionCursorStale(error)) throw error;
          const [skills, mcp] = await Promise.all([api.skills(context), api.mcp(context)]);
          dispatch({
            type: 'capabilities_loaded',
            skills: skills.skills,
            skillNextCursor: skills.nextCursor,
            mcpServers: mcp.servers,
            mcpNextCursor: mcp.nextCursor,
          });
        }
      }),
    [api, runOperation]
  );

  const loadMoreToolDetails = useCallback(
    () =>
      runOperation('加载更多工具详情', async () => {
        const context = requireContextGuard(stateRef.current);
        const cursor = stateRef.current.toolDetailNextCursor;
        if (!cursor) return;
        try {
          const result = await api.toolDetails(context, cursor);
          dispatch({
            type: 'tool_details_loaded',
            details: result.details,
            nextCursor: result.nextCursor,
            append: true,
          });
        } catch (error) {
          if (!isCollectionCursorStale(error)) throw error;
          const refreshed = await api.toolDetails(context);
          dispatch({
            type: 'tool_details_loaded',
            details: refreshed.details,
            nextCursor: refreshed.nextCursor,
          });
        }
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
          const result = await api.activateWorkspace(path, requireContextGuard(stateRef.current));
          dispatch({ type: 'workspaces_loaded', value: result });
          dispatch({ type: 'reset_session_view', activeSessionId: null });
          await loadBaseline();
        } finally {
          resumeEventStream();
        }
      }),
    [api, loadBaseline, pauseEventStream, resumeEventStream, runOperation]
  );

  const selectSession = useCallback(
    (sessionId: string) => {
      const current = stateRef.current;
      if (current.activeSessionId === sessionId && current.sessionSnapshot) {
        return Promise.resolve();
      }
      const context = requireContextGuard(current);
      const select = async () => {
        rememberForegroundSession(context.workspaceId, sessionId);
        dispatch({ type: 'reset_session_view', activeSessionId: sessionId });
        await loadSessionSnapshot(sessionId, context);
      };
      return current.sessionProjectionById[sessionId] ? select() : runOperation('切换会话', select);
    },
    [loadSessionSnapshot, runOperation]
  );

  const activateContext = useCallback(
    (workspaceId: string, sessionId: string | null) => {
      if (workspaceId === stateRef.current.workspaceId && sessionId) {
        return selectSession(sessionId);
      }
      return runOperation('切换项目上下文', async () => {
        const current = stateRef.current;
        const expectedContextRevision = current.contextRevision;
        if (!expectedContextRevision) {
          throw new WebApiError('工作区上下文尚未完成同步。', 409, 'context_revision_conflict');
        }
        if (workspaceId === current.workspaceId) {
          rememberForegroundSession(workspaceId, sessionId);
          dispatch({ type: 'reset_session_view', activeSessionId: sessionId });
          if (sessionId) {
            await loadSessionSnapshot(sessionId, requireContextGuard(current));
          }
          return;
        }
        rememberForegroundSession(workspaceId, sessionId);
        pauseEventStream();
        ++resourceGeneration.current;
        try {
          const result = await api.activateContext({
            expectedContextRevision,
            workspaceId,
            sessionId,
          });
          if (
            result.contextRevision !== result.bootstrap.contextRevision ||
            result.bootstrap.workspaceId !== workspaceId
          ) {
            throw new WebApiError('Host 返回的项目上下文不一致。', 502, 'context_response_invalid');
          }
          dispatch({ type: 'reset_session_view', activeSessionId: sessionId });
          await loadBaseline();
        } catch (error) {
          if (
            error instanceof WebApiError &&
            (error.code === 'context_revision_conflict' || error.code === 'active_session_changed')
          ) {
            dispatch({ type: 'snapshot_failed', sessionId: null, detail: error.message });
          }
          throw error;
        } finally {
          resumeEventStream();
        }
      });
    },
    [
      api,
      loadBaseline,
      loadSessionSnapshot,
      pauseEventStream,
      resumeEventStream,
      runOperation,
      selectSession,
    ]
  );

  const setWorkspacePinned = useCallback(
    (workspaceId: string, pinned: boolean) =>
      runOperation(pinned ? '置顶项目' : '取消置顶', async () => {
        await api.setWorkspacePinned(workspaceId, pinned, requireContextGuard(stateRef.current));
        dispatch({
          type: 'workspaces_loaded',
          value: await api.listWorkspaces(requireContextGuard(stateRef.current)),
        });
      }),
    [api, runOperation]
  );

  const removeWorkspace = useCallback(
    (workspaceId: string) =>
      runOperation('移除项目', async () => {
        const current = stateRef.current;
        if (!current.contextRevision) {
          throw new WebApiError('工作区上下文尚未完成同步。', 409, 'context_revision_conflict');
        }
        await api.removeWorkspace(workspaceId, requireContextGuard(current));
        removeComposerDraftsForWorkspace(workspaceId);
        dispatch({
          type: 'workspaces_loaded',
          value: await api.listWorkspaces(requireContextGuard(stateRef.current)),
        });
      }),
    [api, runOperation]
  );

  const createSession = useCallback(
    () =>
      runOperation('创建会话', async () => {
        const context = requireContextGuard(stateRef.current);
        const session = await api.createSession(context);
        rememberForegroundSession(context.workspaceId, session.id);
        dispatch({
          type: 'sessions_loaded',
          sessions: upsertSessionSummary(stateRef.current.sessions, session),
          nextCursor: stateRef.current.sessionNextCursor,
        });
        dispatch({ type: 'reset_session_view', activeSessionId: session.id });
        await loadSessionSnapshot(session.id, context);
      }),
    [api, loadSessionSnapshot, runOperation]
  );

  const activateSession = selectSession;

  const loadOlderTranscript = useCallback(
    () =>
      runOperation('加载更早记录', async () => {
        const current = stateRef.current.sessionSnapshot;
        const sessionId = stateRef.current.activeSessionId;
        const cursor = current?.transcript.nextCursor;
        if (!current || !sessionId || !cursor) return;
        try {
          const older = await api.sessionSnapshot(
            sessionId,
            requireContextGuard(stateRef.current),
            cursor
          );
          if (
            older.session.id !== current.session.id ||
            older.threadId !== current.threadId ||
            older.threadCursor !== current.threadCursor ||
            older.projectionDigest !== current.projectionDigest
          ) {
            throw new WebApiError(
              '加载历史记录时会话快照发生变化，正在恢复最新快照。',
              409,
              'transcript_cursor_stale'
            );
          }
          dispatch({ type: 'older_transcript_loaded', snapshot: older });
        } catch (error) {
          if (!(error instanceof WebApiError) || error.code !== 'transcript_cursor_stale') {
            throw error;
          }
          pauseEventStream();
          dispatch({ type: 'recovering' });
          try {
            await loadSessionSnapshot(sessionId);
          } finally {
            resumeEventStream();
          }
        }
      }),
    [api, loadSessionSnapshot, pauseEventStream, resumeEventStream, runOperation]
  );

  const renameSession = useCallback(
    (sessionId: string, name: string) =>
      runOperation('重命名会话', async () => {
        const updated = await api.renameSession(
          sessionId,
          name,
          requireContextGuard(stateRef.current)
        );
        const sessions = upsertSessionSummary(stateRef.current.sessions, updated);
        dispatch({
          type: 'sessions_loaded',
          sessions,
          nextCursor: stateRef.current.sessionNextCursor,
        });
      }),
    [api, runOperation]
  );

  const submit = useCallback(
    (text: string, contextReferences?: readonly WebContextReferenceV1[]) =>
      sendCommand('提交任务', { type: 'submit', text, contextReferences }),
    [sendCommand]
  );
  const queue = useCallback(
    (text: string, contextReferences?: readonly WebContextReferenceV1[]) =>
      sendCommand('加入队列', { type: 'queue_followup', text, contextReferences }),
    [sendCommand]
  );
  const removeQueued = useCallback(
    async (itemId: string, expectedItemRevision: number) => {
      await sendComposerAction('移除排队消息', {
        type: 'remove_queue_item',
        itemId,
        expectedItemRevision,
      });
    },
    [sendComposerAction]
  );
  const editQueued = useCallback(
    async (itemId: string, expectedItemRevision: number, text: string) => {
      await sendComposerAction('编辑排队消息', {
        type: 'edit_queue_item',
        itemId,
        expectedItemRevision,
        text,
      });
    },
    [sendComposerAction]
  );
  const moveQueued = useCallback(
    async (itemId: string, expectedItemRevision: number, targetIndex: number) => {
      await sendComposerAction('移动排队消息', {
        type: 'move_queue_item',
        itemId,
        expectedItemRevision,
        targetIndex,
      });
    },
    [sendComposerAction]
  );
  const clearQueue = useCallback(async () => {
    await sendCommand('清空队列', { type: 'clear_followups' });
  }, [sendCommand]);
  const cancelQueuedTurn = useCallback(async () => {
    const runtime = stateRef.current.sessionSnapshot?.sessionRuntime;
    if (!runtime || runtime.phase !== 'queued' || !runtime.queueId) {
      throw new WebApiError(
        '排队任务已变化，请等待状态同步后重试。',
        409,
        'session_queue_conflict'
      );
    }
    await sendCommand('取消排队任务', {
      type: 'cancel_queued_turn',
      queueId: runtime.queueId,
    });
  }, [sendCommand]);
  const interrupt = useCallback(async () => {
    await sendCommand('中断任务', { type: 'interrupt' });
  }, [sendCommand]);
  const setMode = useCallback(
    async (agentMode: WorkbenchAgentMode) => {
      if (stateRef.current.mode.baseMode === agentMode && !stateRef.current.mode.pendingBaseMode) {
        return;
      }
      await sendComposerAction('切换模式', { type: 'set_agent_mode', mode: agentMode });
    },
    [sendComposerAction]
  );

  const setPermissionOverride = useCallback(
    async (value: 'ask' | 'allow' | 'deny' | null) => {
      await sendComposerAction(
        value === null ? '继承项目权限' : '切换会话权限',
        value === null
          ? { type: 'clear_permission_override' }
          : { type: 'set_permission_override', value }
      );
    },
    [sendComposerAction]
  );

  const loadModelCatalog = useCallback(
    () =>
      runOperation('加载模型目录', async () => {
        const current = stateRef.current;
        if (!current.activeSessionId) return;
        const catalog = await api.modelCatalog(
          current.activeSessionId,
          requireContextGuard(current)
        );
        dispatch({ type: 'model_catalog_loaded', catalog });
      }),
    [api, runOperation]
  );

  const selectModel = useCallback(
    async (modelId: string, effort?: import('../../src/web/protocol').WebEffortPreferenceV1) => {
      await sendComposerAction('切换会话模型', {
        type: 'select_model',
        modelId,
        ...(effort ? { effort } : {}),
      });
    },
    [sendComposerAction]
  );

  const compactContext = useCallback(async () => {
    await sendComposerAction('压缩上下文', { type: 'compact_context' });
  }, [sendComposerAction]);

  const reviewPlan = useCallback(
    async (planDigest: string, action: 'approve' | 'continue' | 'cancel', feedback?: string) => {
      await sendComposerAction('审核计划', {
        type: 'review_plan',
        planDigest,
        action,
        ...(feedback ? { feedback } : {}),
      });
    },
    [sendComposerAction]
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
      const generation = ++resourceGeneration.current;
      pauseEventStream();
      try {
        const sessionId = stateRef.current.activeSessionId;
        const context = requireContextGuard(stateRef.current);
        const [diagnostics] = await Promise.all([
          api.diagnostics(context),
          sessionId ? loadSessionSnapshot(sessionId) : Promise.resolve(),
        ]);
        if (generation !== resourceGeneration.current) return;
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
      const result = await api.updateSettings(
        expectedRevision,
        operations,
        requireContextGuard(stateRef.current),
        stableRequestId
      );
      settingsMirror.accept(result.settings);
      return result;
    },
    [api, settingsMirror]
  );

  const openSettingsDocument = useCallback(async () => {
    await api.openSettingsDocument();
  }, [api]);

  const readToolDetail = useCallback(
    (artifactId: string, offsetBytes = 0) =>
      api.readToolDetail(artifactId, requireContextGuard(stateRef.current), offsetBytes),
    [api]
  );

  const listFiles = useCallback(
    (parentId?: string, cursor?: string) =>
      api.listFiles(requireContextGuard(stateRef.current), parentId, cursor),
    [api]
  );
  const readFileContent = useCallback(
    (fileId: string, cursor?: string) =>
      api.readFileContent(fileId, requireContextGuard(stateRef.current), cursor),
    [api]
  );
  const gitStatus = useCallback(
    (cursor?: string) => api.gitStatus(requireContextGuard(stateRef.current), cursor),
    [api]
  );
  const gitLog = useCallback(
    (cursor?: string) => api.gitLog(requireContextGuard(stateRef.current), cursor),
    [api]
  );
  const gitDiff = useCallback(
    (fileId: string, cursor?: string) =>
      api.gitDiff(fileId, requireContextGuard(stateRef.current), cursor),
    [api]
  );
  const review = useCallback(() => api.review(requireContextGuard(stateRef.current)), [api]);
  const terminals = useCallback(
    async () => (await api.terminals(requireContextGuard(stateRef.current))).terminals,
    [api]
  );
  const createTerminal = useCallback(
    async (cols: number, rows: number) => {
      const current = stateRef.current;
      if (!current.contextRevision || !current.workspaceId) {
        throw new WebApiError('工作区上下文尚未完成同步。', 409, 'context_revision_conflict');
      }
      return api.createTerminal({
        expectedContextRevision: current.contextRevision,
        workspaceId: current.workspaceId,
        cols,
        rows,
      });
    },
    [api]
  );
  const terminalAttachTicket = useCallback(
    async (terminalId: string) => {
      const current = stateRef.current;
      if (!current.contextRevision || !current.workspaceId) {
        throw new WebApiError('工作区上下文尚未完成同步。', 409, 'context_revision_conflict');
      }
      return api.terminalAttachTicket(terminalId, {
        expectedContextRevision: current.contextRevision,
        workspaceId: current.workspaceId,
      });
    },
    [api]
  );
  const closeTerminal = useCallback(
    async (terminalId: string) => {
      const current = stateRef.current;
      if (!current.contextRevision || !current.workspaceId) {
        throw new WebApiError('工作区上下文尚未完成同步。', 409, 'context_revision_conflict');
      }
      await api.closeTerminal(terminalId, {
        expectedContextRevision: current.contextRevision,
        workspaceId: current.workspaceId,
      });
    },
    [api]
  );
  const terminalSocket = useCallback((terminalId: string) => api.terminalSocket(terminalId), [api]);

  const dismissNotice = useCallback(() => dispatch({ type: 'notice', notice: null }), []);

  const actions = useMemo<WorkbenchActions>(
    () => ({
      retryBoot,
      refreshDiagnostics,
      refreshToolDetails,
      loadMoreWorkspaces,
      loadMoreSessions,
      loadWorkspaceSessions,
      refreshWorkspaceProjectSummary,
      loadMoreCapabilities,
      loadMoreToolDetails,
      recoverSession,
      switchWorkspace,
      activateContext,
      setWorkspacePinned,
      removeWorkspace,
      createSession,
      activateSession,
      loadOlderTranscript,
      renameSession,
      submit,
      queue,
      removeQueued,
      editQueued,
      moveQueued,
      clearQueue,
      cancelQueuedTurn,
      interrupt,
      setMode,
      setPermissionOverride,
      loadModelCatalog,
      selectModel,
      compactContext,
      reviewPlan,
      answerPermission,
      controlGoal,
      refreshSettings,
      updateSettings,
      openSettingsDocument,
      readToolDetail,
      listFiles,
      readFileContent,
      gitStatus,
      gitLog,
      gitDiff,
      review,
      terminals,
      createTerminal,
      terminalAttachTicket,
      closeTerminal,
      terminalSocket,
      dismissNotice,
    }),
    [
      activateSession,
      activateContext,
      closeTerminal,
      createTerminal,
      gitDiff,
      gitLog,
      gitStatus,
      listFiles,
      loadOlderTranscript,
      loadMoreCapabilities,
      loadMoreSessions,
      loadMoreToolDetails,
      loadMoreWorkspaces,
      loadModelCatalog,
      loadWorkspaceSessions,
      answerPermission,
      clearQueue,
      cancelQueuedTurn,
      compactContext,
      reviewPlan,
      controlGoal,
      createSession,
      dismissNotice,
      editQueued,
      interrupt,
      queue,
      readFileContent,
      readToolDetail,
      review,
      recoverSession,
      refreshDiagnostics,
      refreshSettings,
      refreshToolDetails,
      refreshWorkspaceProjectSummary,
      removeQueued,
      removeWorkspace,
      renameSession,
      retryBoot,
      setMode,
      setPermissionOverride,
      selectModel,
      setWorkspacePinned,
      submit,
      switchWorkspace,
      moveQueued,
      terminalAttachTicket,
      terminalSocket,
      terminals,
      updateSettings,
      openSettingsDocument,
    ]
  );

  return { state, actions };
}

async function migrateLegacyAppearance(
  api: OrionWebApi,
  mirror: SettingsMirror,
  initialDocument: WebSettingsDocumentV1,
  context: WebContextGuardV1
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
      const result = await api.updateSettings(
        document.revision,
        migration.operations,
        context,
        requestId()
      );
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

function requireContextGuard(
  state: Pick<WorkbenchState, 'contextRevision' | 'workspaceId'>
): WebContextGuardV1 {
  if (!state.contextRevision || !state.workspaceId) {
    throw new WebApiError('工作区上下文尚未完成同步。', 409, 'context_revision_conflict');
  }
  return {
    expectedContextRevision: state.contextRevision,
    workspaceId: state.workspaceId,
  };
}

const WEB_VIEW_ID_KEY = 'orion.web.view-id.v1';
const WEB_FOREGROUND_PREFIX = 'orion.web.foreground-session.v1:';

function preferredForegroundSession(
  workspaceId: string,
  sessions: readonly import('./types').WebSessionSummaryV1[],
  hostDefault: string | null
): string | null {
  const stored = readSessionStorage(`${WEB_FOREGROUND_PREFIX}${workspaceId}`);
  return selectPreferredForegroundSession(stored, sessions, hostDefault);
}

function rememberForegroundSession(workspaceId: string, sessionId: string | null): void {
  ensureWebViewId();
  const key = `${WEB_FOREGROUND_PREFIX}${workspaceId}`;
  try {
    if (sessionId) globalThis.sessionStorage?.setItem(key, sessionId);
    else globalThis.sessionStorage?.removeItem(key);
  } catch {
    // Private browsing/storage denial only disables foreground persistence.
  }
}

function ensureWebViewId(): string {
  const existing = readSessionStorage(WEB_VIEW_ID_KEY);
  if (existing) return existing;
  const created = globalThis.crypto?.randomUUID?.() ?? `view-${Date.now().toString(36)}`;
  try {
    globalThis.sessionStorage?.setItem(WEB_VIEW_ID_KEY, created);
  } catch {
    // The in-memory fallback remains sufficient for the current page.
  }
  return created;
}

function readSessionStorage(key: string): string | null {
  try {
    return globalThis.sessionStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
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

function isCollectionCursorStale(error: unknown): boolean {
  return error instanceof WebApiError && error.code === 'collection_cursor_stale';
}

function isBaselineRetryable(error: unknown): boolean {
  return (
    error instanceof WebApiError &&
    ['context_revision_conflict', 'runtime_busy', 'active_session_changed'].includes(
      error.code ?? ''
    )
  );
}

function waitForBaselineRetry(delayMs: number): Promise<void> {
  return new Promise(resolve => {
    globalThis.setTimeout(resolve, delayMs);
  });
}

function needsSessionSnapshotRefresh(envelope: import('./types').WebEventEnvelopeV1): boolean {
  if (!envelope.sessionId) return false;
  if (envelope.type === 'runtime_event') {
    return envelope.payload.value.type === 'permission_requested';
  }
  if (envelope.type !== 'thread_event') return false;
  return [
    'approval.requested',
    'plan.review_requested',
    'turn.completed',
    'turn.failed',
    'turn.interrupted',
  ].includes(envelope.payload.value.payload.type);
}
