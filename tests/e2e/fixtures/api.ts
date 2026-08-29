import { randomUUID } from 'crypto';

import type { Page } from '@playwright/test';

import type {
  WebBootstrapV1,
  WebSessionSnapshotV1,
  WebSettingsMutationResultV1,
  WebSettingsOperationV1,
  WebSettingsSnapshotV1,
} from '../../../src/web/protocol';

export interface BrowserApiResult<T = unknown> {
  readonly status: number;
  readonly contentType: string;
  readonly body: T;
}

export interface BrowserMutationOptions {
  readonly method?: 'POST' | 'PATCH';
  readonly body: unknown;
  readonly nonce?: string;
  readonly origin?: string;
  readonly contentType?: string;
}

export async function webBootstrap(page: Page): Promise<WebBootstrapV1> {
  const result = await browserGet<WebBootstrapV1>(page, '/api/v1/bootstrap');
  if (result.status !== 200) throw new Error(`Bootstrap failed with HTTP ${result.status}.`);
  return result.body;
}

export async function activeSessionSnapshot(page: Page): Promise<WebSessionSnapshotV1> {
  const bootstrap = await webBootstrap(page);
  if (!bootstrap.activeSessionId) throw new Error('No active Web E2E session.');
  return sessionSnapshot(page, bootstrap.activeSessionId);
}

export async function sessionSnapshot(
  page: Page,
  sessionId: string
): Promise<WebSessionSnapshotV1> {
  const bootstrap = await webBootstrap(page);
  const query = new URLSearchParams({
    pageSize: '100',
    expectedContextRevision: bootstrap.contextRevision,
    workspaceId: bootstrap.workspaceId,
  });
  const result = await browserGet<WebSessionSnapshotV1>(
    page,
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/snapshot?${query.toString()}`
  );
  if (result.status !== 200) throw new Error(`Snapshot failed with HTTP ${result.status}.`);
  return result.body;
}

export async function settingsSnapshot(page: Page): Promise<WebSettingsSnapshotV1> {
  const result = await browserGet<WebSettingsSnapshotV1>(page, '/api/v1/settings');
  if (result.status !== 200) throw new Error(`Settings failed with HTTP ${result.status}.`);
  return result.body;
}

export async function updateSettings(
  page: Page,
  expectedRevision: string,
  operations: readonly WebSettingsOperationV1[],
  requestId = randomUUID()
): Promise<BrowserApiResult<WebSettingsMutationResultV1>> {
  return browserMutation<WebSettingsMutationResultV1>(page, '/api/v1/settings', {
    method: 'PATCH',
    body: { requestId, expectedRevision, operations },
  });
}

export async function browserGet<T = unknown>(
  page: Page,
  path: string
): Promise<BrowserApiResult<T>> {
  return page.evaluate(async requestPath => {
    const response = await fetch(requestPath, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();
    return {
      status: response.status,
      contentType,
      body: text ? (JSON.parse(text) as T) : (null as T),
    };
  }, path);
}

export async function guardedBrowserGet<T = unknown>(
  page: Page,
  path: string,
  context?: Pick<WebBootstrapV1, 'workspaceId' | 'contextRevision'>
): Promise<BrowserApiResult<T>> {
  const active = context ?? (await webBootstrap(page));
  const url = new URL(path, 'http://orion.invalid');
  url.searchParams.set('workspaceId', active.workspaceId);
  url.searchParams.set('expectedContextRevision', active.contextRevision);
  return browserGet<T>(page, `${url.pathname}?${url.searchParams.toString()}`);
}

export async function browserMutation<T = unknown>(
  page: Page,
  path: string,
  options: BrowserMutationOptions
): Promise<BrowserApiResult<T>> {
  const nonce = options.nonce ?? (await webBootstrap(page)).nonce;
  return page.evaluate(
    async input => {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'Content-Type': input.contentType,
        'x-orion-web-nonce': input.nonce,
      };
      if (input.origin) headers.Origin = input.origin;
      const response = await fetch(input.path, {
        method: input.method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers,
        body: typeof input.body === 'string' ? input.body : JSON.stringify(input.body),
      });
      const contentType = response.headers.get('content-type') ?? '';
      const text = await response.text();
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          body = text;
        }
      }
      return { status: response.status, contentType, body };
    },
    {
      path,
      method: options.method ?? 'POST',
      body: options.body,
      nonce,
      origin: options.origin,
      contentType: options.contentType ?? 'application/json',
    }
  ) as Promise<BrowserApiResult<T>>;
}
