import { randomUUID } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { request as httpRequest } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import WebSocket from 'ws';

import { startOrionWebServer, type OrionWebServerHandle } from '../src/web/server';
import { WebWorkbenchController } from '../src/web/workbench-controller';
import { createFakeWebRuntime } from './support/web-runtime';

describe('Orion local Web host', () => {
  let root: string;
  let workspace: string;
  let staticRoot: string;
  let handle: OrionWebServerHandle;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'orion-web-server-'));
    workspace = join(root, 'workspace');
    staticRoot = join(root, 'static');
    mkdirSync(workspace);
    mkdirSync(staticRoot);
    writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><main>Orion</main>');
    const workbench = await WebWorkbenchController.create({
      cwd: workspace,
      createRuntime: async cwd => createFakeWebRuntime(cwd),
    });
    handle = await startOrionWebServer({ cwd: workspace, port: 0, staticRoot, workbench });
  });

  afterEach(async () => {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('binds loopback with hardened same-origin responses', async () => {
    expect(handle.host).toBe('127.0.0.1');
    const response = await fetch(`${handle.url}/api/v1/health`);
    expect(response.status).toBe(200);
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain(`style-src-elem 'self' 'nonce-${handle.nonce}'`);
    expect(csp).toContain("style-src-attr 'unsafe-inline'");
    expect(csp).not.toContain("style-src-elem 'self' 'unsafe-inline'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();

    const misdirected = await rawRequest(handle, '/api/v1/health', { Host: 'attacker.invalid' });
    expect(misdirected.status).toBe(421);
  });

  test('requires exact Origin, nonce and JSON for mutations', async () => {
    const endpoint = `${handle.url}/api/v1/sessions`;
    const body = JSON.stringify({ requestId: randomUUID() });
    const missingOrigin = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orion-Web-Nonce': handle.nonce },
      body,
    });
    expect(missingOrigin.status).toBe(403);

    const wrongNonce = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Origin: handle.url,
        'Content-Type': 'application/json',
        'X-Orion-Web-Nonce': 'wrong',
      },
      body,
    });
    expect(wrongNonce.status).toBe(403);
  });

  test('returns the frozen Settings problem code at the mutation security boundary', async () => {
    const endpoints = [
      { path: '/api/v1/settings', method: 'PATCH' },
      { path: '/api/v1/settings/open-document', method: 'POST' },
    ];
    for (const endpoint of endpoints) {
      const response = await fetch(`${handle.url}${endpoint.path}`, {
        method: endpoint.method,
        headers: {
          Origin: 'http://attacker.invalid',
          'Content-Type': 'application/json',
          'X-Orion-Web-Nonce': handle.nonce,
        },
        body: JSON.stringify({ requestId: randomUUID() }),
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        status: 403,
        code: 'settings_write_forbidden',
      });
    }
  });

  test('replays a successful mutation response without creating a second session', async () => {
    const requestId = randomUUID();
    const context = await activeContext(handle);
    const request = () =>
      fetch(`${handle.url}/api/v1/sessions`, {
        method: 'POST',
        headers: mutationHeaders(handle),
        body: JSON.stringify({ requestId, ...context }),
      });

    const first = await request();
    const firstBody = (await first.json()) as {
      requestId: string;
      session: { id: string };
    };
    const retry = await request();
    const retryBody = (await retry.json()) as {
      requestId: string;
      session: { id: string };
    };
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(firstBody.requestId).toBe(requestId);
    expect(firstBody.session.id).toEqual(expect.any(String));
    expect(retryBody).toEqual(firstBody);

    const sessions = await fetch(
      guardedUrl(handle, '/api/v1/sessions', await activeContext(handle))
    ).then(response => response.json());
    expect((sessions as { items: unknown[] }).items).toHaveLength(1);
  });

  test('serves an omitted-tail recovery snapshot through the bounded latest-page path', async () => {
    const context = await activeContext(handle);
    const created = await fetch(`${handle.url}/api/v1/sessions`, {
      method: 'POST',
      headers: mutationHeaders(handle),
      body: JSON.stringify({ requestId: randomUUID(), ...context }),
    });
    const createdBody = (await created.json()) as { session: { id: string } };
    expect(created.status).toBe(201);

    const snapshot = jest.spyOn(handle.workbench, 'sessionSnapshot');
    const response = await fetch(
      guardedUrl(handle, `/api/v1/sessions/${createdBody.session.id}/snapshot`, context)
    );

    expect(response.status).toBe(200);
    expect(snapshot).toHaveBeenCalledWith(createdBody.session.id, undefined, 50, true, context);
  });

  test('rejects a continuation cursor after the Session collection revision changes', async () => {
    const create = async () =>
      fetch(`${handle.url}/api/v1/sessions`, {
        method: 'POST',
        headers: mutationHeaders(handle),
        body: JSON.stringify({ requestId: randomUUID(), ...(await activeContext(handle)) }),
      });
    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(201);

    const firstContext = await activeContext(handle);
    const first = await fetch(
      guardedUrl(handle, '/api/v1/sessions', firstContext, { pageSize: '1' })
    );
    const firstBody = (await first.json()) as { nextCursor: string | null };
    expect(first.status).toBe(200);
    expect(firstBody.nextCursor).toEqual(expect.any(String));

    expect((await create()).status).toBe(201);
    const stale = await fetch(
      guardedUrl(handle, '/api/v1/sessions', await activeContext(handle), {
        pageSize: '1',
        cursor: firstBody.nextCursor ?? '',
      })
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      status: 409,
      code: 'collection_cursor_stale',
    });
  });

  test('serves Workspace-scoped Sessions and applies Context revision CAS', async () => {
    const initialContext = await activeContext(handle);
    const created = await fetch(`${handle.url}/api/v1/sessions`, {
      method: 'POST',
      headers: mutationHeaders(handle),
      body: JSON.stringify({
        requestId: randomUUID(),
        name: 'context target',
        ...initialContext,
      }),
    });
    const createdBody = (await created.json()) as { session: { id: string } };
    const bootstrap = await fetch(`${handle.url}/api/v1/bootstrap`).then(
      response =>
        response.json() as Promise<{
          workspaceId: string;
          contextRevision: string;
          activeSessionId: string;
        }>
    );

    const sessions = await fetch(
      guardedUrl(
        handle,
        `/api/v1/workspaces/${encodeURIComponent(bootstrap.workspaceId)}/sessions`,
        {
          workspaceId: bootstrap.workspaceId,
          expectedContextRevision: bootstrap.contextRevision,
        }
      )
    );
    expect(sessions.status).toBe(200);
    await expect(sessions.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ id: createdBody.session.id })],
      nextCursor: null,
    });

    const requestId = randomUUID();
    const activate = await fetch(`${handle.url}/api/v1/context/activate`, {
      method: 'POST',
      headers: mutationHeaders(handle),
      body: JSON.stringify({
        requestId,
        expectedContextRevision: bootstrap.contextRevision,
        workspaceId: bootstrap.workspaceId,
        sessionId: createdBody.session.id,
      }),
    });
    expect(activate.status).toBe(200);
    await expect(activate.json()).resolves.toMatchObject({
      requestId,
      contextRevision: bootstrap.contextRevision,
      bootstrap: {
        contextRevision: bootstrap.contextRevision,
        workspaceId: bootstrap.workspaceId,
        activeSessionId: null,
      },
    });

    const stale = await fetch(`${handle.url}/api/v1/context/activate`, {
      method: 'POST',
      headers: mutationHeaders(handle),
      body: JSON.stringify({
        requestId: randomUUID(),
        expectedContextRevision: randomUUID(),
        workspaceId: bootstrap.workspaceId,
        sessionId: createdBody.session.id,
      }),
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      code: 'context_revision_conflict',
    });
  });

  test('requires the active Context guard on every workspace-bound read', async () => {
    const context = await activeContext(handle);
    const guardedReads = [
      '/api/v1/workspaces',
      `/api/v1/workspaces/${encodeURIComponent(context.workspaceId)}/sessions`,
      `/api/v1/workspaces/${encodeURIComponent(context.workspaceId)}/summary`,
      '/api/v1/skills',
      '/api/v1/mcp',
      '/api/v1/tool-details',
      '/api/v1/diagnostics',
    ];

    for (const path of guardedReads) {
      const missing = await fetch(`${handle.url}${path}`);
      expect({ path, status: missing.status }).toEqual({ path, status: 400 });

      const current = await fetch(guardedUrl(handle, path, context));
      expect({ path, status: current.status }).toEqual({ path, status: 200 });

      const stale = await fetch(
        guardedUrl(handle, path, { ...context, expectedContextRevision: randomUUID() })
      );
      expect({ path, status: stale.status }).toEqual({ path, status: 409 });
      await expect(stale.json()).resolves.toMatchObject({
        status: 409,
        code: 'context_revision_conflict',
      });
    }

    const missingDetail = '/api/v1/tool-details/not-a-real-artifact';
    expect((await fetch(`${handle.url}${missingDetail}`)).status).toBe(400);
    expect((await fetch(guardedUrl(handle, missingDetail, context))).status).toBe(404);
    const staleDetail = await fetch(
      guardedUrl(handle, missingDetail, {
        ...context,
        expectedContextRevision: randomUUID(),
      })
    );
    expect(staleDetail.status).toBe(409);
    await expect(staleDetail.json()).resolves.toMatchObject({
      status: 409,
      code: 'context_revision_conflict',
    });
  });

  test('rejects a command with a stale Session Runtime revision before actor admission', async () => {
    const context = await activeContext(handle);
    const created = await fetch(`${handle.url}/api/v1/sessions`, {
      method: 'POST',
      headers: mutationHeaders(handle),
      body: JSON.stringify({ requestId: randomUUID(), ...context }),
    });
    const createdBody = (await created.json()) as { session: { id: string } };
    expect(created.status).toBe(201);

    const response = await fetch(`${handle.url}/api/v1/commands`, {
      method: 'POST',
      headers: mutationHeaders(handle),
      body: JSON.stringify({
        requestId: randomUUID(),
        ...context,
        expectedSessionId: createdBody.session.id,
        expectedSessionRuntimeRevision: randomUUID(),
        type: 'submit',
        text: 'must not run',
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      status: 409,
      code: 'session_runtime_revision_conflict',
    });
    expect(handle.workbench.bootstrap(handle.nonce).activeSessionId).toBeNull();
    expect(handle.workbench.sessionRuntimeSummary(createdBody.session.id)).toMatchObject({
      phase: 'cold',
      resident: false,
    });
    expect(handle.workbench.runtime.store.getSnapshot().isProcessing).toBe(false);
  });

  test('rejects a stale tab Session create with zero cross-Workspace side effects', async () => {
    const staleContext = await activeContext(handle);
    const secondWorkspace = join(root, 'second-workspace');
    mkdirSync(secondWorkspace);
    const switched = await fetch(`${handle.url}/api/v1/workspaces/activate`, {
      method: 'POST',
      headers: mutationHeaders(handle),
      body: JSON.stringify({
        requestId: randomUUID(),
        path: secondWorkspace,
        ...staleContext,
      }),
    });
    expect(switched.status).toBe(200);
    const active = await activeContext(handle);
    expect(active.workspaceId).not.toBe(staleContext.workspaceId);

    const staleCreate = await fetch(`${handle.url}/api/v1/sessions`, {
      method: 'POST',
      headers: mutationHeaders(handle),
      body: JSON.stringify({ requestId: randomUUID(), ...staleContext }),
    });
    expect(staleCreate.status).toBe(409);
    await expect(staleCreate.json()).resolves.toMatchObject({
      code: 'context_revision_conflict',
    });

    const sessions = await fetch(guardedUrl(handle, '/api/v1/sessions', active));
    expect(sessions.status).toBe(200);
    await expect(sessions.json()).resolves.toMatchObject({ items: [] });
    expect(handle.workbench.bootstrap(handle.nonce)).toMatchObject({
      workspaceId: active.workspaceId,
      activeSessionId: null,
    });
  });

  test('requires a matching Context guard for Workspace-scoped reads', async () => {
    const missing = await fetch(`${handle.url}/api/v1/files`);
    expect(missing.status).toBe(400);

    const stale = await fetch(
      guardedUrl(handle, '/api/v1/git/status', {
        ...(await activeContext(handle)),
        expectedContextRevision: randomUUID(),
      })
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ code: 'context_revision_conflict' });
  });

  test('applies one atomic Settings batch, replays it exactly and rejects stale CAS', async () => {
    const beforeResponse = await fetch(`${handle.url}/api/v1/settings`);
    const before = (await beforeResponse.json()) as {
      revision: string;
      sections: { permissions: { toolConfirmation: { effectiveValue: string } } };
    };
    expect(before.revision).toMatch(/^hmac-sha256:[a-f0-9]{64}$/u);

    const requestId = randomUUID();
    const body = JSON.stringify({
      requestId,
      expectedRevision: before.revision,
      operations: [
        { op: 'set', key: 'appearance.theme', value: 'dark' },
        { op: 'set', key: 'appearance.motion', value: 'reduced' },
        { op: 'set', key: 'permissions.toolConfirmation', value: 'deny' },
      ],
    });
    const request = () =>
      fetch(`${handle.url}/api/v1/settings`, {
        method: 'PATCH',
        headers: mutationHeaders(handle),
        body,
      });

    const first = await request();
    const firstBody = (await first.json()) as {
      requestId: string;
      revision: string;
      appliedKeys: string[];
      settings: {
        sections: {
          appearance: { theme: { effectiveValue: string }; motion: { effectiveValue: string } };
          permissions: { toolConfirmation: { effectiveValue: string } };
        };
      };
    };
    const retry = await request();
    const retryBody = await retry.json();
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retryBody).toEqual(firstBody);
    expect(firstBody.requestId).toBe(requestId);
    expect(firstBody.revision).not.toBe(before.revision);
    expect(firstBody.appliedKeys).toEqual([
      'appearance.theme',
      'appearance.motion',
      'permissions.toolConfirmation',
    ]);
    expect(firstBody.settings.sections.appearance.theme.effectiveValue).toBe('dark');
    expect(firstBody.settings.sections.appearance.motion.effectiveValue).toBe('reduced');
    expect(firstBody.settings.sections.permissions.toolConfirmation.effectiveValue).toBe('deny');

    const conflictingRetry = await fetch(`${handle.url}/api/v1/settings`, {
      method: 'PATCH',
      headers: mutationHeaders(handle),
      body: JSON.stringify({
        requestId,
        expectedRevision: before.revision,
        operations: [{ op: 'set', key: 'appearance.theme', value: 'light' }],
      }),
    });
    expect(conflictingRetry.status).toBe(409);
    await expect(conflictingRetry.json()).resolves.toMatchObject({
      status: 409,
      code: 'request_id_conflict',
    });

    const stale = await fetch(`${handle.url}/api/v1/settings`, {
      method: 'PATCH',
      headers: mutationHeaders(handle),
      body: JSON.stringify({
        requestId: randomUUID(),
        expectedRevision: before.revision,
        operations: [{ op: 'set', key: 'appearance.theme', value: 'light' }],
      }),
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      status: 409,
      code: 'settings_revision_conflict',
    });
  });

  test('keeps Settings responses secret-free and open-document pathless', async () => {
    const settings = await fetch(`${handle.url}/api/v1/settings`);
    const settingsText = await settings.text();
    expect(settings.status).toBe(200);
    expect(settingsText).not.toContain('test-key');
    expect(settingsText).not.toContain('.orion-web-test.json');
    expect(settingsText).not.toMatch(/apiKey|authorization|credentialValue/iu);

    const hostile = await fetch(`${handle.url}/api/v1/settings/open-document`, {
      method: 'POST',
      headers: mutationHeaders(handle),
      body: JSON.stringify({ requestId: randomUUID(), path: '/tmp/hostile' }),
    });
    expect(hostile.status).toBe(400);

    const requestId = randomUUID();
    const opened = await fetch(`${handle.url}/api/v1/settings/open-document`, {
      method: 'POST',
      headers: mutationHeaders(handle),
      body: JSON.stringify({ requestId }),
    });
    expect(opened.status).toBe(200);
    await expect(opened.json()).resolves.toEqual({ requestId, opened: true });
  });

  test('runs a real PTY over a same-origin single-use WebSocket ticket', async () => {
    const bootstrap = await fetch(`${handle.url}/api/v1/bootstrap`).then(
      response => response.json() as Promise<{ workspaceId: string; contextRevision: string }>
    );
    const body = {
      requestId: randomUUID(),
      workspaceId: bootstrap.workspaceId,
      expectedContextRevision: bootstrap.contextRevision,
      cols: 90,
      rows: 28,
    };
    const missingGesture = await fetch(`${handle.url}/api/v1/terminals`, {
      method: 'POST',
      headers: mutationHeaders(handle),
      body: JSON.stringify(body),
    });
    expect(missingGesture.status).toBe(403);
    await expect(missingGesture.json()).resolves.toMatchObject({
      code: 'terminal_user_gesture_required',
    });

    const created = await fetch(`${handle.url}/api/v1/terminals`, {
      method: 'POST',
      headers: {
        ...mutationHeaders(handle),
        'X-Orion-User-Gesture': 'terminal-create-v1',
      },
      body: JSON.stringify({ ...body, requestId: randomUUID() }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      terminal: { id: string };
      ticket: string;
    };
    expect(createdBody.ticket).toMatch(/^[A-Za-z0-9_-]+$/u);
    const streamUrl = `${handle.url.replace('http:', 'ws:')}/api/v1/terminals/${createdBody.terminal.id}/stream`;
    expect(streamUrl).not.toContain(createdBody.ticket);

    const socket = new WebSocket(streamUrl, 'orion-terminal-v1', { origin: handle.url });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const ready = nextWebSocketMessage(socket, message => message.type === 'ready');
    socket.send(
      JSON.stringify({
        type: 'authenticate',
        ticket: createdBody.ticket,
        afterSequence: 0,
      })
    );
    await expect(ready).resolves.toMatchObject({
      type: 'ready',
      terminal: { id: createdBody.terminal.id, cols: 90, rows: 28 },
    });

    const marker = nextWebSocketMessage(
      socket,
      message => message.type === 'output' && String(message.data).includes('ORION_WS_PTY_OK')
    );
    socket.send(JSON.stringify({ type: 'resize', cols: 101, rows: 31 }));
    socket.send(JSON.stringify({ type: 'input', data: "printf 'ORION_WS_PTY_OK\\n'\r" }));
    await expect(marker).resolves.toMatchObject({ type: 'output', sequence: expect.any(Number) });

    const closed = await fetch(
      `${handle.url}/api/v1/terminals/${encodeURIComponent(createdBody.terminal.id)}`,
      {
        method: 'DELETE',
        headers: mutationHeaders(handle),
        body: JSON.stringify({
          requestId: randomUUID(),
          workspaceId: bootstrap.workspaceId,
          expectedContextRevision: bootstrap.contextRevision,
        }),
      }
    );
    expect(closed.status).toBe(200);
    await new Promise<void>(resolve => {
      if (socket.readyState === WebSocket.CLOSED) resolve();
      else socket.once('close', () => resolve());
    });
  });

  test('rejects unknown fields, oversized JSON and encoded traversal', async () => {
    const unknown = await fetch(`${handle.url}/api/v1/sessions`, {
      method: 'POST',
      headers: mutationHeaders(handle),
      body: JSON.stringify({ requestId: randomUUID(), unexpected: true }),
    });
    expect(unknown.status).toBe(400);

    const oversized = await fetch(`${handle.url}/api/v1/sessions`, {
      method: 'POST',
      headers: mutationHeaders(handle),
      body: JSON.stringify({ requestId: randomUUID(), padding: 'x'.repeat(1024 * 1024) }),
    });
    expect(oversized.status).toBe(413);

    const traversal = await fetch(`${handle.url}/%2e%2e%2fpackage.json`);
    expect(traversal.status).toBe(403);
  });

  const symlinkTest = process.platform === 'win32' ? test.skip : test;
  symlinkTest('rejects static asset symlinks that escape the packaged Web root', async () => {
    const outside = join(root, 'outside-secret.txt');
    const link = join(staticRoot, 'escaped-secret.txt');
    writeFileSync(outside, 'ORION_STATIC_SYMLINK_ESCAPE_SENTINEL');
    symlinkSync(outside, link);

    const response = await fetch(`${handle.url}/escaped-secret.txt`);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('ORION_STATIC_SYMLINK_ESCAPE_SENTINEL');
  });
});

function mutationHeaders(handle: OrionWebServerHandle): Record<string, string> {
  return {
    Origin: handle.url,
    'Content-Type': 'application/json',
    'X-Orion-Web-Nonce': handle.nonce,
  };
}

interface ActiveContext {
  readonly expectedContextRevision: string;
  readonly workspaceId: string;
}

async function activeContext(handle: OrionWebServerHandle): Promise<ActiveContext> {
  const bootstrap = (await fetch(`${handle.url}/api/v1/bootstrap`).then(response =>
    response.json()
  )) as { readonly contextRevision: string; readonly workspaceId: string };
  return {
    expectedContextRevision: bootstrap.contextRevision,
    workspaceId: bootstrap.workspaceId,
  };
}

function guardedUrl(
  handle: OrionWebServerHandle,
  path: string,
  context: ActiveContext,
  extra: Readonly<Record<string, string>> = {}
): string {
  const url = new URL(path, handle.url);
  url.searchParams.set('expectedContextRevision', context.expectedContextRevision);
  url.searchParams.set('workspaceId', context.workspaceId);
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  return url.toString();
}

function rawRequest(
  handle: OrionWebServerHandle,
  path: string,
  headers: Record<string, string>
): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: handle.host, port: handle.port, path, method: 'GET', headers },
      response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() })
        );
      }
    );
    request.once('error', reject);
    request.end();
  });
}

function nextWebSocketMessage(
  socket: WebSocket,
  predicate: (value: Record<string, unknown>) => boolean,
  timeoutMs = 5_000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for terminal WebSocket message'));
    }, timeoutMs);
    const onMessage = (data: WebSocket.RawData) => {
      const value = JSON.parse(data.toString()) as Record<string, unknown>;
      if (!predicate(value)) return;
      cleanup();
      resolve(value);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Terminal WebSocket closed before the expected message'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('close', onClose);
    };
    socket.on('message', onMessage);
    socket.on('close', onClose);
  });
}
