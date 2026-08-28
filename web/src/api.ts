import type {
  WebCommandResultV1,
  WebCommandV1,
  WebMcpServerSummaryV1,
  WebPageV1,
  WebSessionMutationResultV1,
  WebSessionSnapshotV1,
  WebSessionSummaryV1,
  WebSkillSummaryV1,
  WebToolDetailPageV1,
  WebToolDetailSummaryV1,
  WebWorkspaceSummaryV1,
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
const MAX_COLLECTION_PAGES = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

  async listWorkspaces(): Promise<WorkspaceListResponse> {
    const items = await this.collectPages<WebWorkspaceSummaryV1>('/workspaces');
    return {
      active: items.find(item => item.active)?.path ?? '',
      workspaces: items.map(item => item.path),
    };
  }

  async listSessions(): Promise<{ readonly sessions: readonly WebSessionSummaryV1[] }> {
    return { sessions: await this.collectPages<WebSessionSummaryV1>('/sessions') };
  }

  diagnostics(): Promise<DiagnosticsSnapshot> {
    return this.query('/diagnostics');
  }

  async settings(): Promise<WebSettingsDocumentV1> {
    return parseSettingsDocument(await this.query<unknown>('/settings'));
  }

  async sessionSnapshot(sessionId: string, cursor?: string): Promise<WebSessionSnapshotV1> {
    const path = `/sessions/${encodeURIComponent(sessionId)}/snapshot`;
    return this.query<WebSessionSnapshotV1>(
      withPage(path, cursor ?? null, true, TRANSCRIPT_PAGE_SIZE)
    );
  }

  async skills(): Promise<{ readonly skills: readonly WebSkillSummaryV1[] }> {
    return { skills: await this.collectPages<WebSkillSummaryV1>('/skills') };
  }

  async mcp(): Promise<{ readonly servers: readonly WebMcpServerSummaryV1[] }> {
    return { servers: await this.collectPages<WebMcpServerSummaryV1>('/mcp') };
  }

  async toolDetails(): Promise<{ readonly details: readonly WebToolDetailSummaryV1[] }> {
    return { details: await this.collectPages<WebToolDetailSummaryV1>('/tool-details') };
  }

  readToolDetail(
    artifactId: string,
    offsetBytes = 0,
    limitBytes = 64 * 1024
  ): Promise<WebToolDetailPageV1> {
    const query = new URLSearchParams({
      offsetBytes: String(offsetBytes),
      limitBytes: String(limitBytes),
    });
    return this.query(`/tool-details/${encodeURIComponent(artifactId)}?${query.toString()}`);
  }

  async activateWorkspace(
    path: string
  ): Promise<WorkspaceListResponse & { readonly requestId: string }> {
    const result = await this.mutate<WorkspaceMutationResult>('/workspaces/activate', 'POST', {
      requestId: requestId(),
      path,
    });
    return {
      requestId: result.requestId,
      active: result.active,
      workspaces: result.page.items.map(item => item.path),
    };
  }

  async createSession(): Promise<WebSessionSummaryV1> {
    const result = await this.mutate<WebSessionMutationResultV1>('/sessions', 'POST', {
      requestId: requestId(),
    });
    return result.session;
  }

  activateSession(sessionId: string): Promise<WebCommandResultV1> {
    return this.mutate(`/sessions/${encodeURIComponent(sessionId)}/activate`, 'POST', {
      requestId: requestId(),
    });
  }

  async renameSession(sessionId: string, name: string): Promise<WebSessionSummaryV1> {
    const result = await this.mutate<WebSessionMutationResultV1>(
      `/sessions/${encodeURIComponent(sessionId)}`,
      'PATCH',
      { requestId: requestId(), name }
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

    const connect = () => {
      if (closed) return;
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
        try {
          const envelope = parseEnvelope((raw as MessageEvent<string>).data);
          if (envelope.type === 'replay_reset') {
            cursor = envelope.cursor;
            handlers.onEvent(envelope);
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
        if (closed) return;
        attempt += 1;
        handlers.onStatus(navigator.onLine ? 'reconnecting' : 'offline', attempt);
        const delay = Math.min(10_000, 500 * 2 ** Math.min(attempt, 5));
        window.clearTimeout(retryTimer);
        retryTimer = window.setTimeout(connect, delay);
      };
    };

    const reconnectWhenOnline = () => {
      if (closed || source) return;
      window.clearTimeout(retryTimer);
      connect();
    };
    const markOffline = () => {
      window.clearTimeout(retryTimer);
      source?.close();
      source = null;
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

  private async collectPages<T>(path: string): Promise<readonly T[]> {
    const items: T[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_COLLECTION_PAGES; page += 1) {
      const result: WebPageV1<T> = await this.query<WebPageV1<T>>(withPage(path, cursor));
      items.push(...result.items);
      if (!result.nextCursor) return items;
      if (seen.has(result.nextCursor)) {
        throw new WebApiError('集合分页游标重复。', 502);
      }
      seen.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new WebApiError('集合超过 Web Workbench 的分页上限。', 413);
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

  private async mutate<T>(path: string, method: 'POST' | 'PATCH', body: unknown): Promise<T> {
    if (!this.nonce) throw new WebApiError('Web Workbench 尚未完成安全握手。', 503);
    const response = await fetch(`${API_ROOT}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        [NONCE_HEADER]: this.nonce,
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
    (typeof value.payload.workspace !== 'string' ||
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
    value.type === 'replay_reset' &&
    (typeof value.payload.reason !== 'string' || value.payload.snapshotRequired !== true)
  ) {
    throw new Error('Replay reset 事件无效。');
  }
  return value as unknown as WebEventEnvelopeV1;
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
  return `${path}?${query.toString()}`;
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
