import { randomUUID } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { request as httpRequest } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';

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
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
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
    const request = () =>
      fetch(`${handle.url}/api/v1/sessions`, {
        method: 'POST',
        headers: mutationHeaders(handle),
        body: JSON.stringify({ requestId }),
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

    const sessions = await fetch(`${handle.url}/api/v1/sessions`).then(response => response.json());
    expect((sessions as { items: unknown[] }).items).toHaveLength(1);
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
