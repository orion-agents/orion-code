import type {
  WebCommandResultV1,
  WebCommandV1,
  WebComposerActionResultV1,
  WebComposerActionV1,
  WebComposerControlStateV1,
  WebContextGuardV1,
  WebContextMutationResultV1,
  WebFileContentPageV1,
  WebFileTreePageV1,
  WebGitDiffPageV1,
  WebGitLogPageV1,
  WebGitStatusV1,
  WebMcpServerSummaryV1,
  WebModelCatalogPageV1,
  WebPageV1,
  WebReviewSnapshotV1,
  WebSessionMutationResultV1,
  WebSessionSnapshotV1,
  WebSessionSummaryV1,
  WebSkillSummaryV1,
  WebTerminalCreateResultV1,
  WebTerminalMetadataV1,
  WebToolDetailPageV1,
  WebToolDetailSummaryV1,
  WebWorkspaceSummaryV1,
  WebWorkspaceProjectSummaryV1,
} from '../../src/web/protocol';

import {
  parseSettingsDocument,
  parseSettingsInvalidatedEvent,
  parseSettingsMutationResult,
} from './settings/contract';
import type {
  SettingsOperationV1,
  WebSettingsDocumentV1,
  WebSettingsMutationResultV1,
} from './settings/types';
import type {
  DiagnosticsSnapshot,
  WebBootstrapV1,
  WebEventEnvelopeV1,
  WorkspaceListResponse,
} from './types';

const API_ROOT = '/api/v1';
const NONCE_HEADER = 'x-orion-web-nonce';
const COLLECTION_PAGE_SIZE = 100;
const TRANSCRIPT_PAGE_SIZE = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ComposerActionRequestV1 = WebComposerActionV1 extends infer Action
  ? Action extends WebComposerActionV1
    ? Omit<Action, 'requestId'>
    : never
  : never;

export class WebApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly type?: string
  ) {
    super(message);
    this.name = 'WebApiError';
  }
}

export interface EventStreamHandlers {
  readonly cursor?: number;
  readonly onEvent: (event: WebEventEnvelopeV1) => void;
  readonly onStatus: (
    status: 'connecting' | 'live' | 'reconnecting' | 'offline',
    attempt: number
  ) => void;
  readonly onProtocolError?: (message: string) => void;
}

export interface EventStreamHandle {
  close(): void;
  cursor(): number;
}

interface WorkspaceMutationResult {
  readonly requestId: string;
  readonly active: string;
  readonly page: WebPageV1<WebWorkspaceSummaryV1>;
}

export interface WebTerminalMutationResult {
  readonly requestId: string;
  readonly terminal: WebTerminalMetadataV1;
}

export class OrionWebApi {
  private nonce = '';

  async bootstrap(): Promise<WebBootstrapV1> {
    const value = await this.query<unknown>('/bootstrap');
    if (!isRecord(value) || value.apiVersion !== 1 || typeof value.nonce !== 'string') {
      throw new WebApiError('Web Host 返回了不兼容的启动协议。', 502);
    }
    this.nonce = value.nonce;
    return {
      ...value,
      settings: parseSettingsDocument(value.settings),
    } as WebBootstrapV1;
  }

  async listWorkspaces(
    context: WebContextGuardV1,
    cursor?: string
  ): Promise<WorkspaceListResponse> {
    const page = await this.collectionPage<WebWorkspaceSummaryV1>(
      withContext('/workspaces', context),
      cursor
    );
    const active = page.items.find(item => item.active);
    return {
      activeId: active?.id ?? '',
      activePath: active?.path ?? '',
      workspaces: page.items,
      nextCursor: page.nextCursor,
    };
  }

  async listWorkspaceSessions(
    workspaceId: string,
    context: WebContextGuardV1,
    cursor?: string
  ): Promise<{
    readonly sessions: readonly WebSessionSummaryV1[];
    readonly nextCursor: string | null;
  }> {
    const page = await this.collectionPage<WebSessionSummaryV1>(
      withContext(`/workspaces/${encodeURIComponent(workspaceId)}/sessions`, context),
      cursor
    );
    return { sessions: page.items, nextCursor: page.nextCursor };
  }

  workspaceProjectSummary(
    workspaceId: string,
    context: WebContextGuardV1
  ): Promise<WebWorkspaceProjectSummaryV1> {
    return this.query(
      withContext(`/workspaces/${encodeURIComponent(workspaceId)}/summary`, context)
    );
  }

  async listSessions(
    context: WebContextGuardV1,
    cursor?: string
  ): Promise<{
    readonly sessions: readonly WebSessionSummaryV1[];
    readonly nextCursor: string | null;
  }> {
    const page = await this.collectionPage<WebSessionSummaryV1>(
      withContext('/sessions', context),
      cursor
    );
    return { sessions: page.items, nextCursor: page.nextCursor };
  }

  diagnostics(context: WebContextGuardV1): Promise<DiagnosticsSnapshot> {
    return this.query(withContext('/diagnostics', context));
  }

  async settings(): Promise<WebSettingsDocumentV1> {
    return parseSettingsDocument(await this.query<unknown>('/settings'));
  }

  async sessionSnapshot(
    sessionId: string,
    context: WebContextGuardV1,
    cursor?: string
  ): Promise<WebSessionSnapshotV1> {
    const path = `/sessions/${encodeURIComponent(sessionId)}/snapshot`;
    return this.query<WebSessionSnapshotV1>(
      withPage(withContext(path, context), cursor ?? null, true, TRANSCRIPT_PAGE_SIZE)
    );
  }

  composerState(sessionId: string, context: WebContextGuardV1): Promise<WebComposerControlStateV1> {
    return this.query(
      withContext(`/sessions/${encodeURIComponent(sessionId)}/composer-state`, context)
    );
  }

  modelCatalog(
    sessionId: string,
    context: WebContextGuardV1,
    cursor?: string
  ): Promise<WebModelCatalogPageV1> {
    return this.query(
      withPage(
        withContext(`/sessions/${encodeURIComponent(sessionId)}/model-catalog`, context),
        cursor ?? null,
        false,
        COLLECTION_PAGE_SIZE
      )
    );
  }

  composerAction(
    sessionId: string,
    action: ComposerActionRequestV1
  ): Promise<WebComposerActionResultV1> {
    return this.mutate(`/sessions/${encodeURIComponent(sessionId)}/composer-actions`, 'POST', {
      ...action,
      requestId: requestId(),
    });
  }

  async skills(
    context: WebContextGuardV1,
    cursor?: string
  ): Promise<{
    readonly skills: readonly WebSkillSummaryV1[];
    readonly nextCursor: string | null;
  }> {
    const page = await this.collectionPage<WebSkillSummaryV1>(
      withContext('/skills', context),
      cursor
    );
    return { skills: page.items, nextCursor: page.nextCursor };
  }

  async mcp(
    context: WebContextGuardV1,
    cursor?: string
  ): Promise<{
    readonly servers: readonly WebMcpServerSummaryV1[];
    readonly nextCursor: string | null;
  }> {
    const page = await this.collectionPage<WebMcpServerSummaryV1>(
      withContext('/mcp', context),
      cursor
    );
    return { servers: page.items, nextCursor: page.nextCursor };
  }

  async toolDetails(
    context: WebContextGuardV1,
    cursor?: string
  ): Promise<{
    readonly details: readonly WebToolDetailSummaryV1[];
    readonly nextCursor: string | null;
  }> {
    const page = await this.collectionPage<WebToolDetailSummaryV1>(
      withContext('/tool-details', context),
      cursor
    );
    return { details: page.items, nextCursor: page.nextCursor };
  }

  readToolDetail(
    artifactId: string,
    context: WebContextGuardV1,
    offsetBytes = 0,
    limitBytes = 64 * 1024
  ): Promise<WebToolDetailPageV1> {
    const query = new URLSearchParams({
      offsetBytes: String(offsetBytes),
      limitBytes: String(limitBytes),
    });
    appendContext(query, context);
    return this.query(`/tool-details/${encodeURIComponent(artifactId)}?${query.toString()}`);
  }

  listFiles(
    context: WebContextGuardV1,
    parentId?: string,
    cursor?: string
  ): Promise<WebFileTreePageV1> {
    const query = new URLSearchParams({ pageSize: '100' });
    appendContext(query, context);
    if (parentId) query.set('parentId', parentId);
    if (cursor) query.set('cursor', cursor);
    return this.query(`/files?${query.toString()}`);
  }

  readFileContent(
    fileId: string,
    context: WebContextGuardV1,
    cursor?: string
  ): Promise<WebFileContentPageV1> {
    const query = new URLSearchParams({ limitBytes: String(64 * 1024) });
    appendContext(query, context);
    if (cursor) query.set('cursor', cursor);
    return this.query(`/files/${encodeURIComponent(fileId)}/content?${query.toString()}`);
  }

  gitStatus(context: WebContextGuardV1, cursor?: string): Promise<WebGitStatusV1> {
    const query = new URLSearchParams({ pageSize: '200' });
    appendContext(query, context);
    if (cursor) query.set('cursor', cursor);
    return this.query(`/git/status?${query.toString()}`);
  }

  gitLog(context: WebContextGuardV1, cursor?: string): Promise<WebGitLogPageV1> {
    const query = new URLSearchParams({ pageSize: '30' });
    appendContext(query, context);
    if (cursor) query.set('cursor', cursor);
    return this.query(`/git/log?${query.toString()}`);
  }

  gitDiff(fileId: string, context: WebContextGuardV1, cursor?: string): Promise<WebGitDiffPageV1> {
    const query = new URLSearchParams({ lineLimit: '240', byteLimit: String(256 * 1024) });
    appendContext(query, context);
    if (cursor) query.set('cursor', cursor);
    return this.query(`/git/diff/${encodeURIComponent(fileId)}?${query.toString()}`);
  }

  review(context: WebContextGuardV1): Promise<WebReviewSnapshotV1> {
    return this.query(withContext('/review', context));
  }

  async terminals(
    context: WebContextGuardV1,
    cursor?: string
  ): Promise<{
    readonly terminals: readonly WebTerminalMetadataV1[];
    readonly nextCursor: string | null;
  }> {
    const page = await this.collectionPage<WebTerminalMetadataV1>(
      withContext('/terminals', context),
      cursor
    );
    return { terminals: page.items, nextCursor: page.nextCursor };
  }

  createTerminal(input: {
    readonly expectedContextRevision: string;
    readonly workspaceId: string;
    readonly cols: number;
    readonly rows: number;
  }): Promise<WebTerminalCreateResultV1 & { readonly requestId: string }> {
    return this.mutate(
      '/terminals',
      'POST',
      { ...input, requestId: requestId() },
      { 'X-Orion-User-Gesture': 'terminal-create-v1' }
    );
  }

  terminalAttachTicket(
    terminalId: string,
    input: { readonly expectedContextRevision: string; readonly workspaceId: string }
  ): Promise<WebTerminalCreateResultV1 & { readonly requestId: string }> {
    return this.mutate(`/terminals/${encodeURIComponent(terminalId)}/attach-ticket`, 'POST', {
      ...input,
      requestId: requestId(),
    });
  }

  closeTerminal(
    terminalId: string,
    input: { readonly expectedContextRevision: string; readonly workspaceId: string }
  ): Promise<WebTerminalMutationResult> {
    return this.mutate(`/terminals/${encodeURIComponent(terminalId)}`, 'DELETE', {
      ...input,
      requestId: requestId(),
    });
  }

  terminalSocket(terminalId: string): WebSocket {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return new WebSocket(
      `${protocol}//${location.host}${API_ROOT}/terminals/${encodeURIComponent(terminalId)}/stream`,
      'orion-terminal-v1'
    );
  }

  activateContext(input: {
    readonly expectedContextRevision: string;
    readonly workspaceId: string;
    readonly sessionId: string | null;
  }): Promise<WebContextMutationResultV1> {
    return this.mutate('/context/activate', 'POST', { ...input, requestId: requestId() });
  }

  async setWorkspacePinned(
    workspaceId: string,
    pinned: boolean,
    context: WebContextGuardV1
  ): Promise<WebWorkspaceSummaryV1> {
    const result = await this.mutate<{
      readonly requestId: string;
      readonly workspace: WebWorkspaceSummaryV1;
    }>(`/workspaces/${encodeURIComponent(workspaceId)}/pin`, 'POST', {
      requestId: requestId(),
      pinned,
      ...context,
    });
    return result.workspace;
  }

  removeWorkspace(
    workspaceId: string,
    context: WebContextGuardV1
  ): Promise<{ readonly requestId: string; readonly removed: true }> {
    return this.mutate(`/workspaces/${encodeURIComponent(workspaceId)}`, 'DELETE', {
      requestId: requestId(),
      ...context,
    });
  }

  async activateWorkspace(
    path: string,
    context: WebContextGuardV1
  ): Promise<WorkspaceListResponse & { readonly requestId: string }> {
    const result = await this.mutate<WorkspaceMutationResult>('/workspaces/activate', 'POST', {
      requestId: requestId(),
      path,
      ...context,
    });
    return {
      requestId: result.requestId,
      activeId: result.page.items.find(item => item.active)?.id ?? '',
      activePath: result.active,
      workspaces: result.page.items,
      nextCursor: result.page.nextCursor,
    };
  }

  async createSession(context: WebContextGuardV1): Promise<WebSessionSummaryV1> {
    const result = await this.mutate<WebSessionMutationResultV1>('/sessions', 'POST', {
      requestId: requestId(),
      ...context,
    });
    return result.session;
  }

  activateSession(sessionId: string, context: WebContextGuardV1): Promise<WebCommandResultV1> {
    return this.mutate(`/sessions/${encodeURIComponent(sessionId)}/activate`, 'POST', {
      requestId: requestId(),
      ...context,
    });
  }

  async renameSession(
    sessionId: string,
    name: string,
    context: WebContextGuardV1
  ): Promise<WebSessionSummaryV1> {
    const result = await this.mutate<WebSessionMutationResultV1>(
      `/sessions/${encodeURIComponent(sessionId)}`,
      'PATCH',
      { requestId: requestId(), name, ...context }
    );
    return result.session;
  }

  command(command: Omit<WebCommandV1, 'requestId'>): Promise<WebCommandResultV1> {
    return this.mutate('/commands', 'POST', { ...command, requestId: requestId() });
  }

  async updateSettings(
    expectedRevision: string,
    operations: readonly SettingsOperationV1[],
    stableRequestId = requestId()
  ): Promise<WebSettingsMutationResultV1> {
    const result = await this.mutate<unknown>('/settings', 'PATCH', {
      operations,
      expectedRevision,
      requestId: stableRequestId,
    });
    const parsed = parseSettingsMutationResult(result);
    if (parsed.requestId !== stableRequestId) {
      throw new WebApiError('Host 返回了其他设置请求的结果。', 502, 'settings_response_invalid');
    }
    const expectedKeys = operations.map(operation => operation.key);
    if (
      parsed.appliedKeys.length !== expectedKeys.length ||
      expectedKeys.some(key => !parsed.appliedKeys.includes(key))
    ) {
      throw new WebApiError(
        'Host 返回的设置字段与提交内容不一致。',
        502,
        'settings_response_invalid'
      );
    }
    return parsed;
  }

  openSettingsDocument(): Promise<{ readonly requestId: string; readonly opened: true }> {
    return this.mutate('/settings/open-document', 'POST', { requestId: requestId() });
  }

  connectEvents(handlers: EventStreamHandlers): EventStreamHandle {
    let cursor = Math.max(0, handlers.cursor ?? 0);
    let source: EventSource | null = null;
    let retryTimer: number | undefined;
    let attempt = 0;
    let closed = false;
    let suspendedForReplay = false;

    const connect = () => {
      if (closed || suspendedForReplay) return;
      if (!navigator.onLine) {
        handlers.onStatus('offline', attempt);
        return;
      }
      handlers.onStatus(attempt === 0 ? 'connecting' : 'reconnecting', attempt);
      source = new EventSource(`${API_ROOT}/events?cursor=${cursor}`);
      source.onopen = () => {
        attempt = 0;
        handlers.onStatus('live', attempt);
      };
      source.addEventListener('orion', raw => {
        if (closed || suspendedForReplay) return;
        try {
          const envelope = parseEnvelope((raw as MessageEvent<string>).data);
          if (envelope.type === 'replay_reset') {
            cursor = envelope.cursor;
            handlers.onEvent(envelope);
            suspendedForReplay = true;
            source?.close();
            source = null;
            window.clearTimeout(retryTimer);
            return;
          }
          if (envelope.cursor <= cursor) return;
          cursor = envelope.cursor;
          handlers.onEvent(envelope);
        } catch (error) {
          handlers.onProtocolError?.(
            error instanceof Error ? error.message : '无法解析 Runtime 事件。'
          );
        }
      });
      source.onerror = () => {
        source?.close();
        source = null;
        if (closed || suspendedForReplay) return;
        attempt += 1;
        handlers.onStatus(navigator.onLine ? 'reconnecting' : 'offline', attempt);
        const delay = Math.min(10_000, 500 * 2 ** Math.min(attempt, 5));
        window.clearTimeout(retryTimer);
        retryTimer = window.setTimeout(connect, delay);
      };
    };

    const reconnectWhenOnline = () => {
      if (closed || suspendedForReplay || source) return;
      window.clearTimeout(retryTimer);
      connect();
    };
    const markOffline = () => {
      window.clearTimeout(retryTimer);
      source?.close();
      source = null;
      if (suspendedForReplay) return;
      handlers.onStatus('offline', attempt);
    };

    window.addEventListener('online', reconnectWhenOnline);
    window.addEventListener('offline', markOffline);
    connect();

    return {
      close() {
        closed = true;
        window.clearTimeout(retryTimer);
        source?.close();
        source = null;
        window.removeEventListener('online', reconnectWhenOnline);
        window.removeEventListener('offline', markOffline);
      },
      cursor: () => cursor,
    };
  }

  private collectionPage<T>(path: string, cursor?: string): Promise<WebPageV1<T>> {
    return this.query<WebPageV1<T>>(withPage(path, cursor ?? null, false, COLLECTION_PAGE_SIZE));
  }

  private async query<T>(path: string): Promise<T> {
    const response = await fetch(`${API_ROOT}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
    });
    return readResponse<T>(response);
  }

  private async mutate<T>(
    path: string,
    method: 'POST' | 'PATCH' | 'DELETE',
    body: unknown,
    extraHeaders: Readonly<Record<string, string>> = {}
  ): Promise<T> {
    if (!this.nonce) throw new WebApiError('Web Workbench 尚未完成安全握手。', 503);
    const response = await fetch(`${API_ROOT}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        [NONCE_HEADER]: this.nonce,
        ...extraHeaders,
      },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify(body),
    });
    return readResponse<T>(response);
  }
}

async function readResponse<T>(response: Response): Promise<T> {
  const type = response.headers.get('content-type') ?? '';
  const payload = type.includes('json') ? await response.json().catch(() => null) : null;
  if (!response.ok) {
    const problem = isRecord(payload) ? payload : {};
    const detail =
      typeof problem.detail === 'string' ? problem.detail : `请求失败 (${response.status})`;
    throw new WebApiError(
      detail,
      response.status,
      typeof problem.code === 'string' ? problem.code : undefined,
      typeof problem.type === 'string' ? problem.type : undefined
    );
  }
  return payload as T;
}

function parseEnvelope(raw: string): WebEventEnvelopeV1 {
  const value = JSON.parse(raw) as unknown;
  if (
    !isRecord(value) ||
    value.apiVersion !== 1 ||
    typeof value.eventId !== 'string' ||
    !UUID_PATTERN.test(value.eventId) ||
    !Number.isSafeInteger(value.cursor) ||
    (value.cursor as number) < 0 ||
    (value.sessionId !== null && typeof value.sessionId !== 'string') ||
    (value.threadId !== null && typeof value.threadId !== 'string') ||
    typeof value.durable !== 'boolean' ||
    typeof value.timestamp !== 'string' ||
    ![
      'runtime_event',
      'thread_event',
      'workbench_state',
      'replay_reset',
      'settings_invalidated',
      'workspace_resource_invalidated',
      'composer_state_changed',
      'session_runtime_changed',
      'workspace_mutation_changed',
    ].includes(String(value.type)) ||
    !isRecord(value.payload)
  ) {
    throw new Error('Runtime 事件不符合 Web protocol v1。');
  }
  if (value.type === 'runtime_event') {
    const runtimeValue = value.payload.value;
    if (
      !isRecord(runtimeValue) ||
      typeof value.payload.eventType !== 'string' ||
      runtimeValue.type !== value.payload.eventType
    ) {
      throw new Error('Runtime 事件判别字段不一致。');
    }
  }
  if (
    value.type === 'thread_event' &&
    (!isRecord(value.payload.value) ||
      typeof value.payload.eventType !== 'string' ||
      !Number.isSafeInteger(value.payload.sequence) ||
      typeof value.sessionId !== 'string' ||
      typeof value.threadId !== 'string')
  ) {
    throw new Error('Thread 事件身份或序列无效。');
  }
  if (
    value.type === 'workbench_state' &&
    (typeof value.payload.contextRevision !== 'string' ||
      !UUID_PATTERN.test(value.payload.contextRevision) ||
      typeof value.payload.workspaceId !== 'string' ||
      !UUID_PATTERN.test(value.payload.workspaceId) ||
      typeof value.payload.workspace !== 'string' ||
      (value.payload.activeSessionId !== null && typeof value.payload.activeSessionId !== 'string'))
  ) {
    throw new Error('Workbench 状态事件无效。');
  }
  if (
    value.type === 'settings_invalidated' &&
    (value.sessionId !== null || value.threadId !== null || value.durable !== false)
  ) {
    throw new Error('Settings invalidation 事件身份无效。');
  }
  if (value.type === 'settings_invalidated') {
    return parseSettingsInvalidatedEvent(value);
  }
  if (
    value.type === 'session_runtime_changed' &&
    (!isRecord(value.payload.runtime) ||
      value.sessionId !== value.payload.runtime.sessionId ||
      !isSessionRuntimeSummary(value.payload.runtime))
  ) {
    throw new Error('Session Runtime 状态事件无效。');
  }
  if (value.type === 'workspace_mutation_changed') {
    const state = value.payload.state;
    if (
      typeof value.sessionId !== 'string' ||
      value.durable !== false ||
      !isRecord(state) ||
      typeof state.callId !== 'string' ||
      state.callId.length < 1 ||
      !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(String(state.phase)) ||
      (state.phase === 'queued'
        ? !Number.isSafeInteger(state.queuePosition) || (state.queuePosition as number) < 1
        : state.queuePosition !== undefined)
    ) {
      throw new Error('Workspace mutation 状态事件无效。');
    }
  }
  if (
    value.type === 'workspace_resource_invalidated' &&
    (value.sessionId !== null ||
      value.threadId !== null ||
      value.durable !== false ||
      typeof value.payload.workspaceId !== 'string' ||
      !UUID_PATTERN.test(value.payload.workspaceId) ||
      !Array.isArray(value.payload.resources) ||
      value.payload.resources.length < 1 ||
      value.payload.resources.some(
        resource => !['files', 'git', 'review'].includes(String(resource))
      ) ||
      !['context-change', 'filesystem-change', 'terminal-command', 'tool-finished'].includes(
        String(value.payload.reason)
      ))
  ) {
    throw new Error('Workspace resource invalidation 事件无效。');
  }
  if (
    value.type === 'composer_state_changed' &&
    (typeof value.sessionId !== 'string' ||
      value.durable !== true ||
      !isRecord(value.payload.state) ||
      value.payload.state.apiVersion !== 1 ||
      value.payload.state.sessionId !== value.sessionId ||
      typeof value.payload.state.controlRevision !== 'string' ||
      !UUID_PATTERN.test(value.payload.state.controlRevision) ||
      typeof value.payload.state.contextRevision !== 'string' ||
      !UUID_PATTERN.test(value.payload.state.contextRevision))
  ) {
    throw new Error('Composer state 事件身份无效。');
  }
  if (
    value.type === 'replay_reset' &&
    (typeof value.payload.reason !== 'string' || value.payload.snapshotRequired !== true)
  ) {
    throw new Error('Replay reset 事件无效。');
  }
  return value as unknown as WebEventEnvelopeV1;
}

function isSessionRuntimeSummary(value: Record<string, unknown>): boolean {
  const queued = value.phase === 'queued';
  return (
    typeof value.workspaceId === 'string' &&
    UUID_PATTERN.test(value.workspaceId) &&
    typeof value.sessionId === 'string' &&
    UUID_PATTERN.test(value.sessionId) &&
    typeof value.runtimeRevision === 'string' &&
    UUID_PATTERN.test(value.runtimeRevision) &&
    [
      'cold',
      'starting',
      'idle',
      'queued',
      'running',
      'waiting_approval',
      'stopping',
      'interrupted',
      'failed',
    ].includes(String(value.phase)) &&
    Number.isSafeInteger(value.pendingApprovalCount) &&
    (value.pendingApprovalCount as number) >= 0 &&
    typeof value.resident === 'boolean' &&
    Number.isSafeInteger(value.estimatedBytes) &&
    (value.estimatedBytes as number) >= 0 &&
    typeof value.updatedAt === 'string' &&
    (queued
      ? typeof value.queueId === 'string' &&
        UUID_PATTERN.test(value.queueId) &&
        Number.isSafeInteger(value.queuePosition) &&
        (value.queuePosition as number) >= 1
      : value.queueId === undefined && value.queuePosition === undefined)
  );
}

function withPage(
  path: string,
  cursor: string | null = null,
  tail = false,
  pageSize = COLLECTION_PAGE_SIZE
): string {
  const query = new URLSearchParams({ pageSize: String(pageSize) });
  if (cursor) query.set('cursor', cursor);
  if (tail) query.set('tail', '1');
  return `${path}${path.includes('?') ? '&' : '?'}${query.toString()}`;
}

function appendContext(query: URLSearchParams, context: WebContextGuardV1): void {
  query.set('expectedContextRevision', context.expectedContextRevision);
  query.set('workspaceId', context.workspaceId);
}

function withContext(path: string, context: WebContextGuardV1): string {
  const query = new URLSearchParams();
  appendContext(query, context);
  return `${path}${path.includes('?') ? '&' : '?'}${query.toString()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function requestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
