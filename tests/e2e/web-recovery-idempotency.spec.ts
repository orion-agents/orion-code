import { createHash, randomUUID } from 'crypto';
import { existsSync, readFileSync, rmSync } from 'fs';

import type { WebEventEnvelopeV1, WebSessionSnapshotV1 } from '../../src/web/protocol';
import {
  activeSessionSnapshot,
  foregroundSessionId,
  sessionSnapshot,
  settingsSnapshot,
} from './fixtures/api';
import {
  OPENAI_FIXTURE_FILES,
  OPENAI_FIXTURE_MARKERS,
  OPENAI_FIXTURE_PROMPTS,
} from './fixtures/openai-provider';
import { startOrionHost } from './fixtures/orion-host';
import {
  allowExpectedNetworkFailures,
  capturedSseEvents,
  expect,
  installSseCapture,
  test,
} from './fixtures/test';
import {
  answerApproval,
  createSession,
  submitPrompt,
  waitForApproval,
  waitForWorkbenchReady,
  workbenchUi,
} from './fixtures/ui';

test('E2E-P0-03 pending approval survives browser replacement and Host shutdown fails closed', async ({
  artifactState,
  context,
  evidence,
  host,
  page,
  provider,
  workspace,
}, testInfo) => {
  allowExpectedNetworkFailures(testInfo, 7);
  await createSession(page);
  const pendingPath = workspace.primaryPath(OPENAI_FIXTURE_FILES.pendingWrite);
  expect(existsSync(pendingPath)).toBe(false);

  await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.pending);
  await waitForApproval(page, 'write_file', { timeout: 30_000 });
  const initial = await activeSessionSnapshot(page);
  expect(initial.pendingApprovals).toHaveLength(1);
  const requestId = initial.pendingApprovals[0].id;
  evidence.recordFact('approval.request_digest', digestIdentifier(requestId));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  await waitForApproval(page, 'write_file', { timeout: 30_000 });
  expect((await activeSessionSnapshot(page)).pendingApprovals[0].id).toBe(requestId);
  expect(existsSync(pendingPath)).toBe(false);
  evidence.recordFact('approval.same_after_reload', true);

  await page.close();
  const replacement = await context.newPage();
  await installSseCapture(replacement);
  const detachReplacement = evidence.attachPage(replacement);
  await replacement.goto(host.url, { waitUntil: 'domcontentloaded' });
  await waitForWorkbenchReady(replacement, { timeout: 30_000 });
  const replacementTarget = workbenchUi(replacement)
    .sessionList.getByRole('button')
    .filter({ hasText: initial.session.id.slice(0, 8) })
    .first();
  await expect(replacementTarget).toBeVisible();
  if ((await replacementTarget.getAttribute('aria-current')) !== 'page') {
    await replacementTarget.click();
  }
  await expect.poll(() => foregroundSessionId(replacement)).toBe(initial.session.id);
  await waitForApproval(replacement, 'write_file', { timeout: 30_000 });
  expect((await sessionSnapshot(replacement, initial.session.id)).pendingApprovals[0].id).toBe(
    requestId
  );
  expect(existsSync(pendingPath)).toBe(false);
  evidence.recordFact('approval.same_after_tab', true);

  await answerApproval(replacement, 'once', 'write_file');
  await expect(orionMessage(replacement, OPENAI_FIXTURE_MARKERS.pendingResolved)).toBeVisible({
    timeout: 45_000,
  });
  expect(readFileSync(pendingPath, 'utf8')).toBe('PENDING_APPROVED\n');
  evidence.recordFact('approval.explicit_effect_sha256', fileSha256(pendingPath));
  expect((await sessionSnapshot(replacement, initial.session.id)).pendingApprovals).toEqual([]);
  await expect
    .poll(async () => (await sessionSnapshot(replacement, initial.session.id)).runtime.processing, {
      timeout: 45_000,
    })
    .toBe(false);

  rmSync(pendingPath);
  await createSession(replacement);
  await submitPrompt(replacement, OPENAI_FIXTURE_PROMPTS.pendingApproval);
  await waitForApproval(replacement, 'write_file', { timeout: 30_000 });
  const shutdownSnapshot = await activeSessionSnapshot(replacement);
  expect(shutdownSnapshot.pendingApprovals).toHaveLength(1);
  evidence.recordFact(
    'shutdown.request_digest',
    digestIdentifier(shutdownSnapshot.pendingApprovals[0].id)
  );
  expect(existsSync(pendingPath)).toBe(false);
  const requestsBeforeShutdown = provider.requests.length;
  evidence.recordFact('shutdown.provider_requests_before', requestsBeforeShutdown);

  detachReplacement();
  await replacement.close();
  await host.stop();
  expect(existsSync(pendingPath)).toBe(false);

  const restarted = await startOrionHost({
    state: artifactState,
    workspace: workspace.primaryWorkspace,
    configRoot: workspace.configDirectory,
    environment: workspace.environment,
    evidence,
  });
  try {
    const recovered = await context.newPage();
    await installSseCapture(recovered);
    const detachRecovered = evidence.attachPage(recovered);
    try {
      await recovered.goto(restarted.url, { waitUntil: 'domcontentloaded' });
      await waitForWorkbenchReady(recovered, { timeout: 30_000 });
      const targetSession = workbenchUi(recovered)
        .sessionList.getByRole('button')
        .filter({ hasText: shutdownSnapshot.session.id.slice(0, 8) })
        .first();
      await expect(targetSession).toBeVisible();
      if ((await targetSession.getAttribute('aria-current')) !== 'page') {
        await targetSession.click();
      }
      await expect
        .poll(() => foregroundSessionId(recovered), { timeout: 30_000 })
        .toBe(shutdownSnapshot.session.id);
      const snapshot = await sessionSnapshot(recovered, shutdownSnapshot.session.id);
      expect(snapshot.session.id).toBe(shutdownSnapshot.session.id);
      expect(snapshot.pendingApprovals).toEqual([]);
      expect(snapshot.runtime.processing).toBe(false);
      expect(existsSync(pendingPath)).toBe(false);
      await expect(
        provider.waitForRequest(request => request.sequence > requestsBeforeShutdown, 1_500)
      ).rejects.toThrow(/Timed out/u);
      expect(existsSync(pendingPath)).toBe(false);
      evidence.recordFact('shutdown.pending_restored', false);
      evidence.recordFact('shutdown.orphan_effect', false);
      evidence.recordFact('shutdown.provider_requests_after', provider.requests.length);
    } finally {
      detachRecovered();
      await recovered.close();
    }
  } finally {
    await restarted.stop();
  }
});

test('E2E-P0-04 SSE reconnect replays a completed real-tool turn without duplicate effects', async ({
  context,
  evidence,
  host,
  page,
  provider,
  workspace,
}, testInfo) => {
  allowExpectedNetworkFailures(testInfo, 3);
  await createSession(page);
  const pendingPath = workspace.primaryPath(OPENAI_FIXTURE_FILES.pendingWrite);
  await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.pending);
  await waitForApproval(page, 'write_file', { timeout: 30_000 });
  const pending = await activeSessionSnapshot(page);
  expect(pending.pendingApprovals).toHaveLength(1);
  const baselineCursor = pending.eventCursor;

  await context.setOffline(true);
  const bootstrap = await hostBootstrap(host.url);
  const approval = await hostMutation(host.url, bootstrap.nonce, {
    requestId: randomUUID(),
    workspaceId: bootstrap.workspaceId,
    expectedContextRevision: bootstrap.contextRevision,
    expectedSessionId: pending.session.id,
    expectedSessionRuntimeRevision: pending.sessionRuntime.runtimeRevision,
    type: 'permission_decision',
    requestPermissionId: pending.pendingApprovals[0].id,
    approved: true,
    scope: 'once',
  });
  expect(approval.status).toBe(202);
  await provider.waitForRequest(request => request.scenario === 'pending' && request.sequence >= 2);
  await waitForHostTurn(host.url, pending.session.id, snapshot => !snapshot.runtime.processing);
  expect(readFileSync(pendingPath, 'utf8')).toBe('PENDING_APPROVED\n');

  await context.setOffline(false);
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.pendingResolved)).toBeVisible({
    timeout: 45_000,
  });
  const final = await activeSessionSnapshot(page);
  expect(final.eventCursor).toBeGreaterThan(baselineCursor);
  expect(final.pendingApprovals).toEqual([]);
  expect(final.runtime.processing).toBe(false);
  expect(readFileSync(pendingPath, 'utf8')).toBe('PENDING_APPROVED\n');
  expect(provider.requests.filter(request => request.scenario === 'pending')).toHaveLength(2);

  const events = (await capturedSseEvents(page)).filter(isWebEventEnvelope);
  const replayed = events.filter(event => event.cursor > baselineCursor);
  expect(replayed.length).toBeGreaterThan(0);
  expect(new Set(replayed.map(event => event.eventId)).size).toBe(replayed.length);
  for (let index = 1; index < replayed.length; index += 1) {
    expect(replayed[index].cursor).toBeGreaterThan(replayed[index - 1].cursor);
  }
  const visibleMessages = await page.getByRole('main').getByRole('article').allTextContents();
  const markerCount = visibleMessages.filter(message =>
    message.includes(OPENAI_FIXTURE_MARKERS.pendingResolved)
  ).length;
  expect(markerCount).toBe(1);
  expect(
    final.transcript.items.filter(item => item.content.includes('PENDING_APPROVAL_RESOLVED'))
  ).toHaveLength(1);
  evidence.recordFact('sse.baseline_cursor', baselineCursor);
  evidence.recordFact('sse.final_cursor', final.eventCursor);
  evidence.recordFact('sse.replayed_events', replayed.length);
  evidence.recordFact('sse.unique_event_ids', new Set(replayed.map(event => event.eventId)).size);
  evidence.recordFact('sse.marker_count', markerCount);
  evidence.recordFact('sse.effect_sha256', fileSha256(pendingPath));
});

test('E2E-P0-05 exact mutation retry is idempotent and stale settings CAS is rejected', async ({
  context,
  evidence,
  host,
  page,
}, testInfo) => {
  allowExpectedNetworkFailures(testInfo, 2);
  const bootstrap = await hostBootstrap(host.url);
  const nonce = bootstrap.nonce;
  const contextGuard = {
    expectedContextRevision: bootstrap.contextRevision,
    workspaceId: bootstrap.workspaceId,
  };
  const requestId = randomUUID();
  const first = await hostJson<{ requestId: string; session: { id: string } }>(
    host.url,
    nonce,
    '/api/v1/sessions',
    'POST',
    { requestId, name: 'idempotent-session', ...contextGuard }
  );
  const retry = await hostJson<{ requestId: string; session: { id: string } }>(
    host.url,
    nonce,
    '/api/v1/sessions',
    'POST',
    { requestId, name: 'idempotent-session', ...contextGuard }
  );
  expect(first.status).toBe(201);
  expect(retry).toEqual(first);
  evidence.recordFact('idempotency.request_digest', digestIdentifier(requestId));
  evidence.recordFact('idempotency.session_digest', digestIdentifier(first.body.session.id));
  evidence.recordFact('idempotency.retry_same_response', true);

  const conflict = await hostJson(host.url, nonce, '/api/v1/sessions', 'POST', {
    requestId,
    name: 'conflicting-session',
    ...contextGuard,
  });
  expect(conflict.status).toBe(409);
  evidence.recordFact('idempotency.conflict_status', conflict.status);
  const sessions = await hostGet(
    host.url,
    contextPath('/api/v1/sessions', await hostBootstrap(host.url), { pageSize: '100' })
  );
  expect(
    (sessions as { items: { name?: string }[] }).items.filter(
      session => session.name === 'idempotent-session'
    )
  ).toHaveLength(1);
  expect(
    (sessions as { items: { name?: string }[] }).items.filter(
      session => session.name === 'conflicting-session'
    )
  ).toHaveLength(0);

  const other = await context.newPage();
  await installSseCapture(other);
  const detachOther = evidence.attachPage(other);
  try {
    await other.goto(page.url(), { waitUntil: 'domcontentloaded' });
    await waitForWorkbenchReady(other, { timeout: 30_000 });
    const left = await settingsSnapshot(page);
    const right = await settingsSnapshot(other);
    expect(right.revision).toBe(left.revision);

    const committed = await hostJson<{
      settings: {
        revision: string;
        sections: { permissions: { toolConfirmation: { effectiveValue: string } } };
      };
    }>(host.url, nonce, '/api/v1/settings', 'PATCH', {
      requestId: randomUUID(),
      expectedRevision: left.revision,
      ...contextGuard,
      operations: [{ op: 'set', key: 'permissions.toolConfirmation', value: 'allow' }],
    });
    expect(committed.status).toBe(200);
    expect(committed.body.settings.sections.permissions.toolConfirmation.effectiveValue).toBe(
      'allow'
    );
    expect(committed.body.settings.revision).not.toBe(left.revision);

    const stale = await hostJson(host.url, nonce, '/api/v1/settings', 'PATCH', {
      requestId: randomUUID(),
      expectedRevision: right.revision,
      ...contextGuard,
      operations: [{ op: 'set', key: 'permissions.toolConfirmation', value: 'deny' }],
    });
    expect(stale.status).toBe(409);
    const final = await settingsSnapshot(page);
    expect(final.revision).toBe(committed.body.settings.revision);
    expect(final.sections.permissions.toolConfirmation.effectiveValue).toBe('allow');
    evidence.recordFact('settings.base_revision', left.revision);
    evidence.recordFact('settings.committed_revision', committed.body.settings.revision);
    evidence.recordFact('settings.stale_status', stale.status);
  } finally {
    detachOther();
    await other.close();
  }
});

function orionMessage(page: import('@playwright/test').Page, marker: string) {
  return page.getByRole('article', { name: 'Orion' }).filter({ hasText: marker }).last();
}

function isWebEventEnvelope(value: unknown): value is WebEventEnvelopeV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Partial<WebEventEnvelopeV1>;
  return (
    typeof event.eventId === 'string' &&
    Number.isSafeInteger(event.cursor) &&
    typeof event.type === 'string'
  );
}

async function hostBootstrap(hostUrl: string): Promise<{
  readonly nonce: string;
  readonly contextRevision: string;
  readonly workspaceId: string;
}> {
  const response = await fetch(`${hostUrl}/api/v1/bootstrap`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Host bootstrap failed with HTTP ${response.status}.`);
  return response.json() as Promise<{
    readonly nonce: string;
    readonly contextRevision: string;
    readonly workspaceId: string;
  }>;
}

async function hostMutation(
  hostUrl: string,
  nonce: string,
  body: unknown
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(`${hostUrl}/api/v1/commands`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: hostUrl,
      'x-orion-web-nonce': nonce,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function hostJson<T = unknown>(
  hostUrl: string,
  nonce: string,
  path: string,
  method: 'POST' | 'PATCH',
  body: unknown
): Promise<{ readonly status: number; readonly body: T }> {
  const response = await fetch(`${hostUrl}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: hostUrl,
      'x-orion-web-nonce': nonce,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

async function hostGet<T = unknown>(hostUrl: string, path: string): Promise<T> {
  const response = await fetch(`${hostUrl}${path}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Host GET ${path} failed with HTTP ${response.status}.`);
  return response.json() as Promise<T>;
}

async function waitForHostTurn(
  hostUrl: string,
  sessionId: string,
  predicate: (snapshot: WebSessionSnapshotV1) => boolean
): Promise<WebSessionSnapshotV1> {
  let latest: WebSessionSnapshotV1 | undefined;
  await expect
    .poll(
      async () => {
        const bootstrap = await hostBootstrap(hostUrl);
        const response = await fetch(
          `${hostUrl}${contextPath(
            `/api/v1/sessions/${encodeURIComponent(sessionId)}/snapshot`,
            bootstrap,
            { pageSize: '100' }
          )}`,
          { headers: { Accept: 'application/json' } }
        );
        if (!response.ok) throw new Error(`Host snapshot failed with HTTP ${response.status}.`);
        latest = (await response.json()) as WebSessionSnapshotV1;
        return predicate(latest);
      },
      { timeout: 45_000 }
    )
    .toBe(true);
  return latest!;
}

function contextPath(
  path: string,
  context: { readonly contextRevision: string; readonly workspaceId: string },
  extra: Readonly<Record<string, string>> = {}
): string {
  const url = new URL(path, 'http://orion.invalid');
  url.searchParams.set('expectedContextRevision', context.contextRevision);
  url.searchParams.set('workspaceId', context.workspaceId);
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
}

function digestIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
