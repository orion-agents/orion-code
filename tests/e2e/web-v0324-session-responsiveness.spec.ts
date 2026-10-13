import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { basename } from 'path';
import { join } from 'path';

import type { Browser, Page, Request } from '@playwright/test';

import {
  browserGet,
  browserMutation,
  foregroundSessionId,
  sessionSnapshot,
  webBootstrap,
} from './fixtures/api';
import type { WebE2EArtifactStateV1 } from './fixtures/artifact-types';
import type { WebE2EEvidenceCollector } from './fixtures/evidence';
import { OPENAI_FIXTURE_MARKERS, OPENAI_FIXTURE_PROMPTS } from './fixtures/openai-provider';
import { startOrionHost, type OrionHostHandle } from './fixtures/orion-host';
import {
  allowExpectedConsoleErrors,
  allowExpectedNetworkFailures,
  expect,
  installSseCapture,
  test,
} from './fixtures/test';
import {
  createSession,
  openWorkspacePathForm,
  submitPrompt,
  waitForWorkbenchReady,
  workbenchUi,
} from './fixtures/ui';
import type { WorkspaceFixture } from './fixtures/workspace';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

// These journeys run against the installed package's real Host. Routes only
// hold real browser requests; release always continues to the real endpoint.
test('WEB33-P0-44 command admission does not lock another session or session creation', async ({
  evidence,
  page,
  provider,
}) => {
  await page.setViewportSize({ width: 1_600, height: 900 });
  await createSession(page, { name: 'Admission A' });
  const firstId = await foregroundSessionId(page);
  await createSession(page, { name: 'Admission B' });
  await selectSession(page, 'Admission A');
  const entered = deferred();
  const released = deferred();
  let heldCommands = 0;
  await page.route('**/api/v1/commands', async route => {
    const body = route.request().postDataJSON() as { expectedSessionId?: string };
    if (route.request().method() === 'POST' && body.expectedSessionId === firstId) {
      heldCommands += 1;
      entered.resolve();
      await released.promise;
    }
    await route.continue();
  });
  try {
    // submitPrompt waits for accepted requests to clear their draft. This
    // journey intentionally holds admission, so only trigger the real send.
    await workbenchUi(page).composer.fill(`${OPENAI_FIXTURE_PROMPTS.parallelHold}:admission-a`);
    await workbenchUi(page).sendButton.click();
    await entered.promise;
    await expect(sessionButton(page, 'Admission B')).toBeEnabled();
    await expect(workbenchUi(page).newSessionButton).toBeEnabled();
    await selectSession(page, 'Admission B');
    await workbenchUi(page).composer.fill('B draft stays in B');
    await selectSession(page, 'Admission A', false);
    await selectSession(page, 'Admission B');
    await expect(workbenchUi(page).composer).toHaveValue('B draft stays in B');
    await captureViewport(
      page,
      evidence,
      'command-pending',
      'web324-command-pending-other-session.png'
    );

    await submitPrompt(page, `${OPENAI_FIXTURE_PROMPTS.settingsProbe}:admission-b`);
    await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.settingsProbeDone)).toBeVisible();
    await createSession(page, { name: 'Admission C' });
    await expect(workbenchUi(page).composer).toBeEnabled();
    expect(heldCommands).toBe(1);
    released.resolve();
    await provider.waitForRequest(
      request =>
        request.scenario === 'parallel-hold' && request.lastUserText.endsWith(':admission-a')
    );
    provider.releaseHeldResponses('parallel-hold');
    await selectSession(page, 'Admission A');
    await expect(
      orionMessage(page, `${OPENAI_FIXTURE_MARKERS.parallelHeld}:admission-a`)
    ).toBeVisible({ timeout: 45_000 });
    evidence.recordFact('web324.command_pending_other_session_usable', true);
    evidence.recordFact('web324.command_pending_create_usable', true);
    evidence.recordFact('web324.cross_session_draft_preserved', true);
    evidence.recordFact('web324.command_admissions', heldCommands);
  } finally {
    released.resolve();
    provider.releaseHeldResponses();
  }
});

test('WEB33-P0-45 delayed single-flight creation preserves a later foreground selection', async ({
  evidence,
  page,
}) => {
  await page.setViewportSize({ width: 1_600, height: 900 });
  await createSession(page, { name: 'Creation A' });
  await createSession(page, { name: 'Creation B' });
  await selectSession(page, 'Creation A');
  const rows = workbenchUi(page).sessionList.locator('.project-session-row');
  const initialCount = await rows.count();
  const entered = deferred();
  const released = deferred();
  let createRequests = 0;
  await page.route('**/api/v1/sessions', async route => {
    if (route.request().method() === 'POST') {
      createRequests += 1;
      entered.resolve();
      await released.promise;
    }
    await route.continue();
  });
  try {
    await workbenchUi(page).newSessionButton.dblclick();
    await entered.promise;
    await expect(workbenchUi(page).newSessionButton).toBeDisabled();
    await expect(sessionButton(page, 'Creation B')).toBeEnabled();
    await selectSession(page, 'Creation B');
    await workbenchUi(page).composer.fill('Selected B during pending creation');
    const response = page.waitForResponse(
      value =>
        new URL(value.url()).pathname === '/api/v1/sessions' && value.request().method() === 'POST'
    );
    released.resolve();
    expect((await response).status()).toBe(201);
    await expect(rows).toHaveCount(initialCount + 1);
    await expect(workbenchUi(page).newSessionButton).toBeEnabled();
    await expect(sessionButton(page, 'Creation B')).toHaveAttribute('aria-current', 'page');
    await expect(workbenchUi(page).composer).toHaveValue('Selected B during pending creation');
    expect(createRequests).toBe(1);
    await captureViewport(
      page,
      evidence,
      'create-single-flight',
      'web324-create-single-flight-selection.png'
    );
    evidence.recordFact('web324.create_pending_selection_preserved', true);
    evidence.recordFact('web324.create_single_flight_requests', createRequests);
    evidence.recordFact('web324.create_added_rows', (await rows.count()) - initialCount);
  } finally {
    released.resolve();
  }
});

test('WEB33-P0-46 twenty warm switches render immediately without snapshot GET or SSE reconnect', async ({
  evidence,
  page,
}) => {
  await page.setViewportSize({ width: 1_600, height: 900 });
  await createSession(page, { name: 'Warm A' });
  await submitPrompt(page, `${OPENAI_FIXTURE_PROMPTS.settingsProbe}:warm-a`);
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.settingsProbeDone)).toBeVisible();
  await expect(sessionButton(page, 'Warm A').locator('..')).not.toContainText('运行中');
  await expect(workbenchUi(page).modeButton).toBeEnabled();
  await createSession(page, { name: 'Warm B' });
  await submitPrompt(page, `${OPENAI_FIXTURE_PROMPTS.settingsProbe}:warm-b`);
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.settingsProbeDone)).toBeVisible();
  await expect(sessionButton(page, 'Warm B').locator('..')).not.toContainText('运行中');
  await expect(workbenchUi(page).modeButton).toBeEnabled();
  await selectSession(page, 'Warm A');
  await expect(
    workbenchUi(page).main.getByText(`${OPENAI_FIXTURE_PROMPTS.settingsProbe}:warm-a`, {
      exact: true,
    })
  ).toBeVisible();
  await selectSession(page, 'Warm B');
  await expect(
    workbenchUi(page).main.getByText(`${OPENAI_FIXTURE_PROMPTS.settingsProbe}:warm-b`, {
      exact: true,
    })
  ).toBeVisible();

  const snapshotRequests: string[] = [];
  const eventRequests: string[] = [];
  const activateRequests: string[] = [];
  const onRequest = (request: Request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'GET' && /^\/api\/v1\/sessions\/[^/]+\/snapshot$/u.test(pathname)) {
      snapshotRequests.push(pathname);
    }
    if (pathname === '/api/v1/events') eventRequests.push(pathname);
    if (pathname.endsWith('/activate')) activateRequests.push(pathname);
  };
  page.on('request', onRequest);
  const durations: number[] = [];
  try {
    for (let index = 0; index < 20; index += 1) {
      const suffix = index % 2 === 0 ? 'a' : 'b';
      const name = `Warm ${suffix.toUpperCase()}`;
      const paint = await measuredSessionClick(
        page,
        name,
        `${OPENAI_FIXTURE_PROMPTS.settingsProbe}:warm-${suffix}`
      );
      expect(paint.selected).toBe(true);
      expect(paint.rendered).toBe(true);
      durations.push(paint.duration);
      await expect(sessionButton(page, name)).toHaveAttribute('aria-current', 'page');
      await expect(workbenchUi(page).composer).toBeEnabled();
      await expect(
        workbenchUi(page).main.getByText(`${OPENAI_FIXTURE_PROMPTS.settingsProbe}:warm-${suffix}`, {
          exact: true,
        })
      ).toBeVisible();
      await expect(workbenchUi(page).main.getByText('正在同步会话', { exact: true })).toHaveCount(
        0
      );
    }
  } finally {
    page.off('request', onRequest);
  }
  const sorted = [...durations].sort((left, right) => left - right);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  expect(snapshotRequests).toHaveLength(0);
  expect(eventRequests).toHaveLength(0);
  expect(activateRequests).toHaveLength(0);
  expect(p95).toBeLessThan(100);
  evidence.recordFact('web324.warm_switches', durations.length);
  evidence.recordFact('web324.warm_switch_snapshot_gets', snapshotRequests.length);
  evidence.recordFact('web324.warm_switch_sse_reconnects', eventRequests.length);
  evidence.recordFact('web324.warm_switch_activate_posts', activateRequests.length);
  evidence.recordFact('web324.warm_switch_p95_ms', p95);
  evidence.recordFact('web324.warm_switch_p95_budget', true);
  await captureViewport(page, evidence, 'warm-switch', 'web324-warm-switch-20.png');
});

test('WEB33-P0-47 rendered streaming content survives switching and a delayed background refresh', async ({
  evidence,
  page,
  provider,
}) => {
  await page.setViewportSize({ width: 1_600, height: 900 });
  await createSession(page, { name: 'Retained A' });
  const firstId = await foregroundSessionId(page);
  await createSession(page, { name: 'Retained B' });
  await selectSession(page, 'Retained A');
  await submitPrompt(page, `${OPENAI_FIXTURE_PROMPTS.parallelHold}:retained-a`);
  const marker = `${OPENAI_FIXTURE_MARKERS.parallelHeld}:retained-a`;
  await expect(orionMessage(page, marker)).toBeVisible({ timeout: 45_000 });
  await selectSession(page, 'Retained B');
  await workbenchUi(page).composer.fill('Retained B draft');
  provider.releaseHeldResponses('parallel-hold');
  // The row is updated by real Host SSE. Do not fetch a snapshot from the test,
  // since that would mask whether the browser treats background data as stale.
  await expect(sessionButton(page, 'Retained A').locator('..')).not.toContainText('运行中');
  const entered = deferred();
  const released = deferred();
  let backgroundRefreshes = 0;
  await page.route('**/api/v1/sessions/*/snapshot?*', async route => {
    if (new URL(route.request().url()).pathname === `/api/v1/sessions/${firstId}/snapshot`) {
      backgroundRefreshes += 1;
      entered.resolve();
      await released.promise;
    }
    await route.continue();
  });
  try {
    const paint = await measuredSessionClick(page, 'Retained A', marker);
    expect(paint.selected).toBe(true);
    expect(paint.rendered).toBe(true);
    await entered.promise;
    await expect(orionMessage(page, marker)).toBeVisible();
    await captureViewport(
      page,
      evidence,
      'stream-content-refresh',
      'web324-stream-content-refresh-pending.png'
    );
    await expect(sessionButton(page, 'Retained B')).toBeEnabled();
    await selectSession(page, 'Retained B');
    await expect(workbenchUi(page).composer).toHaveValue('Retained B draft');
    const response = page.waitForResponse(
      value => new URL(value.url()).pathname === `/api/v1/sessions/${firstId}/snapshot`
    );
    released.resolve();
    expect((await response).status()).toBe(200);
    await expect(sessionButton(page, 'Retained B')).toHaveAttribute('aria-current', 'page');
    await expect(workbenchUi(page).composer).toHaveValue('Retained B draft');
    expect(backgroundRefreshes).toBe(1);
    await selectSession(page, 'Retained A');
    await expect(orionMessage(page, marker)).toBeVisible();
    evidence.recordFact('web324.streaming_rendered_content_preserved', true);
    evidence.recordFact('web324.background_refresh_requests', backgroundRefreshes);
    evidence.recordFact('web324.background_refresh_selection_preserved', true);
  } finally {
    released.resolve();
    provider.releaseHeldResponses();
  }
});

test('WEB33-P0-48 a running actor survives cross-workspace navigation', async ({
  evidence,
  page,
  provider,
  workspace,
}, testInfo) => {
  // Context changes deliberately close the prior EventSource. Concurrent
  // reads admitted under the old Context can return a guarded 409.
  allowExpectedNetworkFailures(testInfo, 4);
  allowExpectedConsoleErrors(
    evidence,
    testInfo,
    'Failed to load resource: the server responded with a status of 409 (Conflict)',
    1
  );
  await page.setViewportSize({ width: 1_600, height: 900 });
  await openWorkspace(page, workspace.secondaryWorkspace);
  await createSession(page, { name: 'Cross workspace B' });
  await openWorkspace(page, workspace.primaryWorkspace);
  await createSession(page, { name: 'Cross workspace A' });
  const firstId = await foregroundSessionId(page);
  await submitPrompt(page, `${OPENAI_FIXTURE_PROMPTS.parallelHold}:cross-workspace-a`);
  await expect(
    orionMessage(page, `${OPENAI_FIXTURE_MARKERS.parallelHeld}:cross-workspace-a`)
  ).toBeVisible();
  const before = await sessionSnapshot(page, firstId);
  expect(before.sessionRuntime.phase).toBe('running');
  expect(before.sessionRuntime.resident).toBe(true);
  expect(before.activeTurnId).toBeTruthy();
  try {
    await selectAcrossWorkspace(page, 'Cross workspace B', basename(workspace.secondaryWorkspace));
    await workbenchUi(page).composer.fill('B draft during A running');
    await expect(workbenchUi(page).composer).toHaveValue('B draft during A running');
    await expect(
      orionMessage(page, `${OPENAI_FIXTURE_MARKERS.parallelHeld}:cross-workspace-a`)
    ).toHaveCount(0);
    expect(provider.requests.filter(request => request.scenario === 'parallel-hold')).toHaveLength(
      1
    );
    await captureViewport(page, evidence, 'cross-workspace', 'web324-cross-workspace-running.png');
    await selectAcrossWorkspace(page, 'Cross workspace A', basename(workspace.primaryWorkspace));
    const after = await sessionSnapshot(page, firstId);
    expect(after.sessionRuntime.phase).toBe('running');
    expect(after.sessionRuntime.resident).toBe(true);
    expect(after.sessionRuntime.runtimeRevision).toBe(before.sessionRuntime.runtimeRevision);
    expect(after.activeTurnId).toBe(before.activeTurnId);
    await expect(
      orionMessage(page, `${OPENAI_FIXTURE_MARKERS.parallelHeld}:cross-workspace-a`)
    ).toBeVisible();
    provider.releaseHeldResponses('parallel-hold');
    await expect(sessionButton(page, 'Cross workspace A').locator('..')).not.toContainText(
      '运行中'
    );
    await expect(
      orionMessage(page, `${OPENAI_FIXTURE_MARKERS.parallelHeld}:cross-workspace-a`)
    ).toBeVisible();
    evidence.recordFact('web324.cross_workspace_actor_preserved', true);
    evidence.recordFact('web324.cross_workspace_turn_preserved', true);
    evidence.recordFact('web324.cross_workspace_draft_usable', true);
    evidence.recordFact('web324.cross_workspace_provider_replays', 0);
  } finally {
    provider.releaseHeldResponses();
  }
});

test('WEB33-P0-49 successful creation releases its POST lock before a slow failed snapshot', async ({
  evidence,
  page,
}, testInfo) => {
  allowExpectedNetworkFailures(testInfo, 1);
  allowExpectedConsoleErrors(evidence, testInfo, 'Failed to load resource: net::ERR_FAILED', 1);
  await page.setViewportSize({ width: 1_600, height: 900 });
  await createSession(page, { name: 'Creation snapshot A' });
  const knownIds = new Set([await foregroundSessionId(page)]);
  await createSession(page, { name: 'Creation snapshot B' });
  knownIds.add(await foregroundSessionId(page));
  const rows = workbenchUi(page).sessionList.locator('.project-session-row');
  const count = await rows.count();
  const entered = deferred();
  const release = deferred();
  let rejectedSnapshots = 0;
  await page.route('**/api/v1/sessions/*/snapshot?*', async route => {
    const match = new URL(route.request().url()).pathname.match(
      /^\/api\/v1\/sessions\/([^/]+)\/snapshot$/u
    );
    if (match && !knownIds.has(match[1]) && rejectedSnapshots === 0) {
      rejectedSnapshots += 1;
      entered.resolve();
      await release.promise;
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  try {
    const createdResponse = page.waitForResponse(
      response =>
        new URL(response.url()).pathname === '/api/v1/sessions' &&
        response.request().method() === 'POST'
    );
    await workbenchUi(page).newSessionButton.click();
    const response = await createdResponse;
    expect(response.status()).toBe(201);
    const { session } = (await response.json()) as { session: { id: string } };
    const name = `会话 ${session.id.slice(0, 8)}`;
    await entered.promise;
    await expect(rows).toHaveCount(count + 1);
    await expect(workbenchUi(page).newSessionButton).toBeEnabled();
    await expect(sessionButton(page, name)).toHaveAttribute('aria-current', 'page');
    await expect(workbenchUi(page).composer).toBeDisabled();
    await selectSession(page, 'Creation snapshot B');
    await workbenchUi(page).composer.fill('B remains usable while created snapshot is pending');
    await selectSession(page, name, false);
    release.resolve();
    await expect(
      workbenchUi(page).main.getByRole('heading', { name: '会话快照加载失败' })
    ).toBeVisible();
    await expect(rows).toHaveCount(count + 1);
    await expect(workbenchUi(page).newSessionButton).toBeEnabled();
    await expect(workbenchUi(page).composer).toBeDisabled();
    await captureViewport(
      page,
      evidence,
      'create-snapshot-failure',
      'web324-created-snapshot-failure.png'
    );
    await page.getByRole('button', { name: '重试同步', exact: true }).click();
    await expect(workbenchUi(page).composer).toBeEnabled();
    expect((await sessionSnapshot(page, session.id)).session.id).toBe(session.id);
    await selectSession(page, 'Creation snapshot B');
    await expect(workbenchUi(page).composer).toHaveValue(
      'B remains usable while created snapshot is pending'
    );
    evidence.recordFact('web324.create_post_snapshot_decoupled', true);
    evidence.recordFact('web324.create_failed_snapshot_formal_id_preserved', true);
    evidence.recordFact('web324.create_failed_snapshot_retry', true);
    evidence.recordFact('web324.create_failed_snapshot_count', rejectedSnapshots);
  } finally {
    release.resolve();
  }
});

test('WEB33-P0-50 ten creation clicks are single-flight and a failed POST rolls back locally', async ({
  evidence,
  page,
}, testInfo) => {
  allowExpectedNetworkFailures(testInfo, 1);
  allowExpectedConsoleErrors(evidence, testInfo, 'Failed to load resource: net::ERR_FAILED', 1);
  await page.setViewportSize({ width: 1_600, height: 900 });
  await createSession(page, { name: 'Rollback A' });
  await createSession(page, { name: 'Rollback B' });
  await selectSession(page, 'Rollback A');
  const rows = workbenchUi(page).sessionList.locator('.project-session-row');
  const count = await rows.count();
  const entered = deferred();
  const release = deferred();
  let failedPosts = 0;
  await page.route('**/api/v1/sessions', async route => {
    if (route.request().method() === 'POST' && failedPosts === 0) {
      failedPosts += 1;
      entered.resolve();
      await release.promise;
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  try {
    const box = await workbenchUi(page).newSessionButton.boundingBox();
    if (!box) throw new Error('Create button is not visible.');
    for (let index = 0; index < 10; index += 1) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    await entered.promise;
    await expect(workbenchUi(page).newSessionButton).toBeDisabled();
    await expect(workbenchUi(page).composer).toBeDisabled();
    await selectSession(page, 'Rollback B');
    await workbenchUi(page).composer.fill('B draft survives failed creation');
    release.resolve();
    await expect(workbenchUi(page).newSessionButton).toBeEnabled();
    await expect(rows).toHaveCount(count);
    await expect(sessionButton(page, 'Rollback B')).toHaveAttribute('aria-current', 'page');
    await expect(workbenchUi(page).composer).toHaveValue('B draft survives failed creation');
    await captureViewport(
      page,
      evidence,
      'create-post-rollback',
      'web324-create-post-rollback.png'
    );
    await createSession(page, { name: 'Rollback retry success' });
    await expect(rows).toHaveCount(count + 1);
    expect(failedPosts).toBe(1);
    evidence.recordFact('web324.create_ten_click_posts', failedPosts);
    evidence.recordFact('web324.create_provisional_write_blocked', true);
    evidence.recordFact('web324.create_post_failure_rollback', true);
    evidence.recordFact('web324.create_post_failure_other_draft_preserved', true);
    evidence.recordFact('web324.create_post_retry', true);
  } finally {
    release.resolve();
  }
});

test('WEB33-P0-51 an older-history request does not block another session from writing', async ({
  artifactState,
  browser,
  evidence,
  host,
  provider,
  workspace,
}) => {
  const seeded = await openSeededWorkbench(
    artifactState,
    browser,
    evidence,
    host,
    workspace,
    10,
    500,
    'History'
  );
  const page = seeded.page;
  const entered = deferred();
  const release = deferred();
  let historyRequests = 0;
  try {
    await selectSession(page, 'History Hot A');
    await page.route('**/api/v1/sessions/*/snapshot?*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.includes(seeded.firstId) && url.searchParams.has('cursor')) {
        historyRequests += 1;
        entered.resolve();
        await release.promise;
      }
      await route.continue();
    });
    await page.getByRole('button', { name: '从持久记录加载更早内容', exact: true }).click();
    await entered.promise;
    await selectSession(page, 'History Hot B');
    await submitPrompt(page, `${OPENAI_FIXTURE_PROMPTS.settingsProbe}:history-pending-b`);
    await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.settingsProbeDone)).toBeVisible();
    expect(
      provider.requests.filter(request => request.lastUserText.endsWith(':history-pending-b'))
    ).toHaveLength(1);
    await captureViewport(
      page,
      evidence,
      'history-pending-other-session',
      'web324-history-pending-b-usable.png'
    );
    const response = page.waitForResponse(value => {
      const url = new URL(value.url());
      return url.pathname.includes(seeded.firstId) && url.searchParams.has('cursor');
    });
    release.resolve();
    expect((await response).status()).toBe(200);
    await expect(sessionButton(page, 'History Hot B')).toHaveAttribute('aria-current', 'page');
    await selectSession(page, 'History Hot A');
    await page.locator('.transcript-viewport').evaluate(element => {
      element.scrollTop = 0;
    });
    await expect(
      workbenchUi(page).main.getByText(historyMessage('History Hot A', 400), { exact: true })
    ).toBeVisible();
    expect(historyRequests).toBe(1);
    evidence.recordFact('web324.history_pending_other_session_write', true);
    evidence.recordFact('web324.history_late_response_selection_preserved', true);
    evidence.recordFact('web324.history_loaded_page_preserved', true);
    evidence.recordFact('web324.history_pending_requests', historyRequests);
  } finally {
    release.resolve();
    await seeded.close();
  }
});

test('WEB33-P0-52 switching restores each session reading position and loaded history', async ({
  artifactState,
  browser,
  evidence,
  host,
  workspace,
}, testInfo) => {
  // The two intentional Context migrations close two EventSource requests.
  allowExpectedNetworkFailures(testInfo, 2);
  const seeded = await openSeededWorkbench(
    artifactState,
    browser,
    evidence,
    host,
    workspace,
    10,
    500,
    'Scroll'
  );
  const page = seeded.page;
  const releaseColdSnapshot = deferred();
  try {
    await selectSession(page, 'Scroll Hot A');
    const viewport = page.locator('.transcript-viewport');
    await viewport.evaluate(element => {
      element.scrollTop = Math.max(100, element.scrollHeight * 0.35);
    });
    await expect(page.getByRole('button', { name: '回到最新', exact: true })).toBeVisible();
    const before = await viewport.evaluate(element => ({
      top: element.scrollTop,
      height: element.scrollHeight,
    }));
    expect(before.top).toBeGreaterThan(0);
    await selectSession(page, 'Scroll Hot B');
    await viewport.evaluate(element => {
      element.scrollTop = Math.max(100, element.scrollHeight * 0.65);
    });
    await expect(page.getByRole('button', { name: '回到最新', exact: true })).toBeVisible();
    const secondTop = await viewport.evaluate(element => element.scrollTop);
    await selectSession(page, 'Scroll Hot A');
    await expect
      .poll(async () =>
        Math.abs((await viewport.evaluate(element => element.scrollTop)) - before.top)
      )
      .toBeLessThanOrEqual(3);
    await expect(page.getByRole('button', { name: '回到最新', exact: true })).toBeVisible();
    expect(await viewport.evaluate(element => element.scrollHeight)).toBe(before.height);
    await captureViewport(
      page,
      evidence,
      'reading-position-restored',
      'web324-reading-position-restored.png'
    );
    await selectSession(page, 'Scroll Hot B');
    await expect
      .poll(async () =>
        Math.abs((await viewport.evaluate(element => element.scrollTop)) - secondTop)
      )
      .toBeLessThanOrEqual(3);
    await selectSession(page, 'Scroll Hot A');
    await openWorkspace(page, workspace.secondaryWorkspace);
    await createSession(page, { name: 'Scroll remote workspace' });
    const coldSnapshotEntered = deferred();
    let coldSnapshots = 0;
    await page.route('**/api/v1/sessions/*/snapshot?*', async route => {
      if (
        new URL(route.request().url()).pathname === `/api/v1/sessions/${seeded.firstId}/snapshot`
      ) {
        coldSnapshots += 1;
        if (coldSnapshots === 1) {
          coldSnapshotEntered.resolve();
          await releaseColdSnapshot.promise;
        }
      }
      await route.continue();
    });
    await selectAcrossWorkspace(page, 'Scroll Hot A', basename(workspace.primaryWorkspace), false);
    await coldSnapshotEntered.promise;
    await expect(workbenchUi(page).composer).toBeDisabled();
    const loadingTop = await viewport.evaluate(element => element.scrollTop);
    releaseColdSnapshot.resolve();
    await expect(workbenchUi(page).composer).toBeEnabled();
    await expect
      .poll(async () =>
        Math.abs((await viewport.evaluate(element => element.scrollTop)) - before.top)
      )
      .toBeLessThanOrEqual(3);
    await expect(page.getByRole('button', { name: '回到最新', exact: true })).toBeVisible();
    await captureViewport(
      page,
      evidence,
      'cold-context-scroll-restored',
      'web324-cold-context-scroll-restored.png'
    );
    evidence.recordFact('web324.scroll_two_session_positions_restored', true);
    evidence.recordFact('web324.scroll_history_height_preserved', true);
    evidence.recordFact('web324.scroll_restore_tolerance_px', 3);
    evidence.recordFact('web324.scroll_cold_context_position_restored', true);
    evidence.recordFact('web324.scroll_loading_top_px', loadingTop);
    evidence.recordFact('web324.scroll_cold_snapshot_requests', coldSnapshots);
  } finally {
    releaseColdSnapshot.resolve();
    await seeded.close();
  }
});

for (const [id, count] of [
  ['53', 10],
  ['54', 100],
  ['55', 1000],
] as const) {
  test(`WEB33-P0-${id} ${count} sessions and 10k histories have bounded warm-switch latency`, async ({
    artifactState,
    browser,
    evidence,
    host,
    provider,
    workspace,
  }) => {
    test.setTimeout(600_000);
    const variant =
      process.env.ORION_WEB324_PERFORMANCE_VARIANT === 'baseline' ? 'baseline' : 'candidate';
    const seeded = await openSeededWorkbench(
      artifactState,
      browser,
      evidence,
      host,
      workspace,
      count,
      10_000,
      'Scale'
    );
    const page = seeded.page;
    const requests: string[] = [];
    const events: string[] = [];
    const onRequest = (request: Request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === 'GET' && /^\/api\/v1\/sessions\/[^/]+\/snapshot$/u.test(path))
        requests.push(path);
      if (path === '/api/v1/events') events.push(path);
    };
    try {
      await selectSession(page, 'Scale Hot A');
      await selectSession(page, 'Scale Hot B');
      const before = await sessionActorStats(page);
      const rows = await workbenchUi(page).sessionList.locator('.project-session-row').count();
      expect(rows).toBeLessThanOrEqual(100);
      expect(rows).toBeGreaterThanOrEqual(Math.min(count, 2));
      const context = await webBootstrap(page);
      const catalog = await browserGet<{ items: unknown[]; nextCursor: string | null }>(
        page,
        `/api/v1/workspaces/${context.workspaceId}/sessions?${new URLSearchParams({
          workspaceId: context.workspaceId,
          expectedContextRevision: context.contextRevision,
          pageSize: '100',
        }).toString()}`
      );
      expect(catalog.status).toBe(200);
      expect(catalog.body.items).toHaveLength(Math.min(count, 100));
      expect(Boolean(catalog.body.nextCursor)).toBe(count > 100);
      const long = await sessionSnapshot(page, seeded.firstId);
      expect(long.session.messageCount).toBe(10_000);
      expect(long.transcript.items.length).toBeLessThanOrEqual(100);
      page.on('request', onRequest);
      const samples: SessionPaintMeasurement[] = [];
      for (let index = 0; index < 24; index += 1) {
        const name = index % 2 === 0 ? 'Scale Hot A' : 'Scale Hot B';
        const measurement = await measuredSessionClick(page, name, name);
        expect(measurement.selected).toBe(true);
        expect(measurement.rendered).toBe(true);
        samples.push(measurement);
        await expect(workbenchUi(page).composer).toBeEnabled();
      }
      page.off('request', onRequest);
      const after = await sessionActorStats(page);
      expect(after.actorsCreated - before.actorsCreated).toBe(0);
      expect(after.actorsClosed - before.actorsClosed).toBe(0);
      expect(provider.requests).toHaveLength(0);
      expect(events).toHaveLength(0);
      const durations = samples.map(sample => sample.duration);
      const p95 = percentile(durations, 0.95);
      const raw = {
        version: 1,
        variant,
        catalogSessions: count,
        historyMessagesPerHotSession: 10_000,
        viewport: { width: 1600, height: 900 },
        samples,
        snapshotRequests: requests,
        sseReconnects: events.length,
        actorAllocations: after.actorsCreated - before.actorsCreated,
        p50: percentile(durations, 0.5),
        p95,
        maximum: Math.max(...durations),
      };
      writeFileSync(
        join(evidence.scenarioDirectory, 'performance-samples.json'),
        JSON.stringify(raw, null, 2)
      );
      evidence.recordFact('web324.scale_variant', variant);
      evidence.recordFact('web324.scale_catalog_sessions', count);
      evidence.recordFact('web324.scale_history_messages', 10_000);
      evidence.recordFact('web324.scale_dom_rows', rows);
      evidence.recordFact('web324.scale_samples', samples.length);
      evidence.recordFact('web324.scale_raw_duration_samples', JSON.stringify(durations));
      evidence.recordFact('web324.scale_p50_ms', percentile(durations, 0.5));
      evidence.recordFact('web324.scale_p95_ms', p95);
      evidence.recordFact('web324.scale_snapshot_gets', requests.length);
      evidence.recordFact('web324.scale_sse_reconnects', events.length);
      evidence.recordFact(
        'web324.scale_actor_allocations',
        after.actorsCreated - before.actorsCreated
      );
      evidence.recordFact('web324.scale_provider_requests', provider.requests.length);
      evidence.recordFact('web324.scale_budget', p95 < 100);
      await captureViewport(
        page,
        evidence,
        `scale-${count}`,
        `web324-scale-${count}-warm-switch.png`
      );
      if (variant === 'candidate') {
        expect(requests).toHaveLength(0);
        expect(p95).toBeLessThan(100);
      }
    } finally {
      page.off('request', onRequest);
      await seeded.close();
    }
  });
}

test('WEB33-P0-56 a real older HTTP snapshot cannot revert newer same-session SSE state', async ({
  evidence,
  page,
  provider,
}) => {
  await page.setViewportSize({ width: 1_600, height: 900 });
  await createSession(page, { name: 'HTTP SSE A' });
  const firstId = await foregroundSessionId(page);
  await createSession(page, { name: 'HTTP SSE B' });
  await selectSession(page, 'HTTP SSE A');
  await submitPrompt(page, `${OPENAI_FIXTURE_PROMPTS.settingsProbe}:http-sse-prior`);
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.settingsProbeDone)).toBeVisible();
  await submitPrompt(page, `${OPENAI_FIXTURE_PROMPTS.parallelHold}:http-sse-a`);
  await provider.waitForRequest(
    request => request.scenario === 'parallel-hold' && request.lastUserText.endsWith(':http-sse-a')
  );
  const marker = `${OPENAI_FIXTURE_MARKERS.parallelHeld}:http-sse-a`;
  const running = await sessionSnapshot(page, firstId);
  await selectSession(page, 'HTTP SSE B');
  const context = await webBootstrap(page);
  // A second client's legitimate background queue action changes A's runtime
  // revision, making the browser's A cache dirty without modifying any payload.
  const cleared = await browserMutation(page, '/api/v1/commands', {
    body: {
      requestId: randomUUID(),
      workspaceId: context.workspaceId,
      expectedContextRevision: context.contextRevision,
      expectedSessionId: firstId,
      expectedSessionRuntimeRevision: running.sessionRuntime.runtimeRevision,
      type: 'clear_followups',
    },
  });
  expect(cleared.status).toBe(202);
  const captured = deferred();
  const release = deferred();
  let snapshotRequests = 0;
  await page.route('**/api/v1/sessions/*/snapshot?*', async route => {
    if (new URL(route.request().url()).pathname === `/api/v1/sessions/${firstId}/snapshot`) {
      snapshotRequests += 1;
      if (snapshotRequests === 1) {
        const realResponse = await route.fetch();
        const body = (await realResponse.json()) as { sessionRuntime: { phase: string } };
        expect(body.sessionRuntime.phase).toBe('running');
        captured.resolve();
        await release.promise;
        await route.fulfill({ response: realResponse });
        return;
      }
    }
    await route.continue();
  });
  try {
    await selectSession(page, 'HTTP SSE A', false);
    await captured.promise;
    provider.releaseHeldResponses('parallel-hold');
    await expect(sessionButton(page, 'HTTP SSE A').locator('..')).not.toContainText('运行中');
    await expect(page.locator('.thinking-indicator')).toHaveCount(0);
    release.resolve();
    await expect(workbenchUi(page).composer).toBeEnabled();
    await expect(page.locator('.thinking-indicator')).toHaveCount(0);
    await expect(orionMessage(page, marker)).toBeVisible();
    await expect(orionMessage(page, marker)).toHaveCount(1);
    expect(snapshotRequests).toBeGreaterThanOrEqual(2);
    expect(provider.requests.filter(request => request.scenario === 'parallel-hold')).toHaveLength(
      1
    );
    await captureViewport(page, evidence, 'http-sse-ordering', 'web324-http-sse-ordering.png');
    evidence.recordFact('web324.same_session_old_snapshot_rejected', true);
    evidence.recordFact('web324.same_session_fresh_snapshot_requests', snapshotRequests);
    evidence.recordFact('web324.same_session_duplicate_messages', 0);
    evidence.recordFact('web324.same_session_provider_replays', 0);
  } finally {
    release.resolve();
    provider.releaseHeldResponses();
  }
});

test('WEB33-P0-57 a failed Context activation does not strand a later selected workspace', async ({
  evidence,
  page,
  provider,
  workspace,
}, testInfo) => {
  // Three setup Context changes and the queued recovery close four old
  // EventSource requests. Stale read guards can reject old 409 requests.
  allowExpectedNetworkFailures(testInfo, 4);
  allowExpectedConsoleErrors(
    evidence,
    testInfo,
    'Failed to load resource: the server responded with a status of 409 (Conflict)',
    3
  );
  allowExpectedConsoleErrors(
    evidence,
    testInfo,
    'Failed to load resource: the server responded with a status of 400 (Bad Request)',
    1
  );
  await page.setViewportSize({ width: 1_600, height: 900 });
  await openWorkspace(page, workspace.secondaryWorkspace);
  await createSession(page, { name: 'Queued context B' });
  const second = await webBootstrap(page);
  const secondId = await foregroundSessionId(page);
  const thirdPath = join(workspace.rootDirectory, 'workspace-tertiary');
  mkdirSync(thirdPath, { mode: 0o700 });
  await openWorkspace(page, thirdPath);
  await createSession(page, { name: 'Queued context C' });
  const third = await webBootstrap(page);
  const thirdId = await foregroundSessionId(page);
  await openWorkspace(page, workspace.primaryWorkspace);
  await createSession(page, { name: 'Queued context A' });
  const initial = await webBootstrap(page);
  const actorBefore = await sessionActorStats(page);
  const entered = deferred();
  const release = deferred();
  const requests: Array<{
    workspaceId: string;
    sessionId: string;
    requestId: string;
    expectedContextRevision: string;
  }> = [];
  let injectedFailures = 0;
  await page.route('**/api/v1/context/activate', async route => {
    const body = route.request().postDataJSON() as (typeof requests)[number];
    requests.push(body);
    if (body.workspaceId === second.workspaceId && injectedFailures === 0) {
      injectedFailures += 1;
      entered.resolve();
      await release.promise;
      // A deliberately rejected admission has no Host side effects. All C
      // requests continue to the real Host; unexpected HTTP 5xx stay fatal.
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'about:blank',
          title: 'Controlled Context admission failure',
          status: 400,
          code: 'fixture_context_admission_failure',
          detail: 'Fixture Context admission was rejected.',
        }),
      });
      return;
    }
    await route.continue();
  });
  try {
    await selectAcrossWorkspace(
      page,
      'Queued context B',
      basename(workspace.secondaryWorkspace),
      false
    );
    await entered.promise;
    await selectAcrossWorkspace(page, 'Queued context C', basename(thirdPath), false);
    await expect(workbenchUi(page).composer).toBeDisabled();
    const cResponse = page.waitForResponse(
      response =>
        new URL(response.url()).pathname === '/api/v1/context/activate' &&
        (response.request().postDataJSON() as { workspaceId?: string }).workspaceId ===
          third.workspaceId
    );
    release.resolve();
    const response = await cResponse;
    expect(response.status()).toBe(200);
    const result = (await response.json()) as {
      requestId: string;
      bootstrap: { workspaceId: string };
    };
    await expect(workbenchUi(page).composer).toBeEnabled();
    await expect(sessionButton(page, 'Queued context C')).toHaveAttribute('aria-current', 'page');
    expect((await webBootstrap(page)).workspaceId).toBe(third.workspaceId);
    expect(requests).toHaveLength(2);
    expect(requests[0].workspaceId).toBe(second.workspaceId);
    expect(requests[0].sessionId).toBe(secondId);
    expect(requests[1].workspaceId).toBe(third.workspaceId);
    expect(requests[1].sessionId).toBe(thirdId);
    expect(requests[1].expectedContextRevision).toBe(initial.contextRevision);
    expect(requests[1].requestId).not.toBe(requests[0].requestId);
    expect(result.requestId).toBe(requests[1].requestId);
    expect(result.bootstrap.workspaceId).toBe(third.workspaceId);
    const actorAfter = await sessionActorStats(page);
    expect(actorAfter.actorsCreated - actorBefore.actorsCreated).toBe(0);
    expect(provider.requests).toHaveLength(0);
    await workbenchUi(page).composer.fill('C remains writable after B failed admission');
    await captureViewport(
      page,
      evidence,
      'context-failure-drain',
      'web324-context-failure-drain.png'
    );
    evidence.recordFact('web324.context_failed_activation_later_target_drained', true);
    evidence.recordFact('web324.context_failed_activation_count', injectedFailures);
    evidence.recordFact('web324.context_request_target_identities_preserved', true);
    evidence.recordFact('web324.context_request_ids_distinct', true);
    evidence.recordFact('web324.context_navigation_actor_allocations', 0);
  } finally {
    release.resolve();
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function captureViewport(
  page: Page,
  evidence: WebE2EEvidenceCollector,
  id: string,
  filename: string
): Promise<void> {
  await page.screenshot({
    path: join(evidence.scenarioDirectory, filename),
    animations: 'disabled',
    fullPage: false,
  });
  evidence.recordFact(`screenshot.web324-${id}`, filename);
}

async function openWorkspace(page: Page, path: string): Promise<void> {
  const ui = workbenchUi(page);
  await ui.workspaceRail.getByRole('button', { name: '选择其他工作区', exact: true }).click();
  await expect(ui.workspaceDialog).toBeVisible();
  await (await openWorkspacePathForm(ui.workspaceDialog)).fill(path);
  await ui.workspaceDialog.getByRole('button', { name: '打开', exact: true }).click();
  await ui.workspaceDialog.getByRole('button', { name: '打开项目', exact: true }).click();
  await expect(ui.workspaceDialog).toBeHidden();
  await expect
    .poll(async () => basename((await webBootstrap(page)).workspace))
    .toBe(basename(path));
}

async function selectAcrossWorkspace(
  page: Page,
  name: string,
  label: string,
  requireComposer = true
): Promise<void> {
  const rail = workbenchUi(page).workspaceRail;
  const button = rail.getByRole('button', { name: new RegExp(`^${name}(?:\\s|$)`, 'u') });
  if (!(await button.isVisible())) {
    await rail.getByRole('button', { name: new RegExp(`^${label}(?:\\s|$)`, 'u') }).click();
  }
  await expect(button).toBeEnabled();
  await button.click();
  await expect(button).toHaveAttribute('aria-current', 'page');
  if (requireComposer) await expect(workbenchUi(page).composer).toBeEnabled();
}

function historyMessage(name: string, index: number): string {
  return `${name} message ${index}\n${'Fixture history line. '.repeat(8)}`;
}

async function openSeededWorkbench(
  state: WebE2EArtifactStateV1,
  browser: Browser,
  evidence: WebE2EEvidenceCollector,
  original: OrionHostHandle,
  workspace: WorkspaceFixture,
  count: number,
  historyCount: number,
  prefix: string
): Promise<{ page: Page; firstId: string; secondId: string; close(): Promise<void> }> {
  await original.stop();
  const seed = [
    `const storage=require(${JSON.stringify(join(state.installation.packageRoot, 'dist/services/session-storage.js'))});`,
    `const materializer=require(${JSON.stringify(join(state.installation.packageRoot, 'dist/runtime/legacy-thread-materializer.js'))});`,
    `const views=require(${JSON.stringify(join(state.installation.packageRoot, 'dist/runtime/thread-session-view.js'))});`,
    'const {randomUUID}=require("crypto");',
    `const workspace=${JSON.stringify(workspace.primaryWorkspace)};`,
    `const count=${count};const historyCount=${historyCount};const prefix=${JSON.stringify(prefix)};`,
    'const existing=storage.listProjectSessions(workspace,2000).length;',
    'if(existing>count-2)throw new Error("Seed workspace already contains too many Sessions.");',
    'const start=Date.now()+1000;const ids=[];',
    'for(let index=existing;index<count;index++){',
    'const hot=index>=count-2;const name=hot?prefix+" Hot "+(index===count-2?"A":"B"):prefix+" Catalog "+String(index).padStart(4,"0");',
    'const session={id:randomUUID(),projectPath:workspace,cwd:workspace,model:"ark-code-latest",startTime:start+index,createdAt:new Date(start+index).toISOString(),updatedAt:start+index,updatedAtIso:new Date(start+index).toISOString(),messageCount:0,gitBranch:"main",tokenCount:0,cost:0,name};',
    'storage.saveSessionMeta(session);',
    'if(hot){ids.push(session.id);',
    'for(let offset=0;offset<historyCount;offset+=1000){',
    'storage.appendSessionMessages(session.id,Array.from({length:Math.min(1000,historyCount-offset)},(_,value)=>({role:(offset+value)%2?"assistant":"user",content:name+" message "+(offset+value)+"\\n"+"Fixture history line. ".repeat(8),timestamp:start+offset+value})));}',
    'materializer.materializeLegacyThreadV1({projectPath:workspace,sessionId:session.id});',
    'views.loadThreadSessionSnapshotPageV1(workspace,session.id,undefined,100);}',
    '}',
    'process.stdout.write(JSON.stringify({firstId:ids[0],secondId:ids[1],count:storage.listProjectSessions(workspace,2000).length}));',
  ].join('');
  const seeded = JSON.parse(
    execFileSync(process.execPath, ['-e', seed], {
      cwd: workspace.primaryWorkspace,
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 256 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: original.homeDirectory,
        ORION_CODE_CONFIG_DIR: workspace.configDirectory,
        ORION_CODE_DISABLE_ENV_FILES: '1',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
    }).trim()
  ) as { firstId: string; secondId: string; count: number };
  expect(seeded.count).toBe(count);
  const replacement = await startOrionHost({
    state,
    workspace: workspace.primaryWorkspace,
    configRoot: workspace.configDirectory,
    environment: workspace.environment,
    evidence,
    port: original.port,
  });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    bypassCSP: false,
  });
  const page = await context.newPage();
  await installSseCapture(page);
  const detach = evidence.attachPage(page);
  try {
    await page.goto(replacement.url, { waitUntil: 'domcontentloaded' });
    await waitForWorkbenchReady(page, { timeout: 30_000 });
  } catch (error) {
    detach();
    await context.close();
    await replacement.stop();
    throw error;
  }
  return {
    page,
    ...seeded,
    close: async () => {
      detach();
      await context.close();
      await replacement.stop();
    },
  };
}

async function sessionActorStats(
  page: Page
): Promise<{ actorsCreated: number; actorsClosed: number }> {
  const context = await webBootstrap(page);
  const result = await browserGet<{
    session: { actors: { actorsCreated: number; actorsClosed: number } };
  }>(
    page,
    `/api/v1/diagnostics?${new URLSearchParams({
      workspaceId: context.workspaceId,
      expectedContextRevision: context.contextRevision,
    }).toString()}`
  );
  expect(result.status).toBe(200);
  return result.body.session.actors;
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * quantile) - 1];
}

interface SessionPaintMeasurement {
  readonly duration: number;
  readonly selected: boolean;
  readonly rendered: boolean;
}

async function measuredSessionClick(
  page: Page,
  name: string,
  prompt: string
): Promise<SessionPaintMeasurement> {
  const button = sessionButton(page, name);
  // Start at the browser's real pointer-generated click, before React's root
  // listener runs. The Playwright roundtrip is excluded from render latency.
  await button.evaluate((element, expectedPrompt) => {
    const observedWindow = window as typeof window & {
      __orionSessionPaint?: Promise<SessionPaintMeasurement>;
    };
    observedWindow.__orionSessionPaint = new Promise(resolve => {
      element.addEventListener(
        'click',
        async () => {
          const start = performance.now();
          await new Promise<void>(complete => requestAnimationFrame(() => complete()));
          await new Promise<void>(complete => requestAnimationFrame(() => complete()));
          resolve({
            duration: performance.now() - start,
            selected: element.getAttribute('aria-current') === 'page',
            rendered:
              document.querySelector('main .timeline')?.textContent?.includes(expectedPrompt) ??
              false,
          });
        },
        { once: true }
      );
    });
  }, prompt);
  await button.click();
  return page.evaluate(async () => {
    const observedWindow = window as typeof window & {
      __orionSessionPaint?: Promise<SessionPaintMeasurement>;
    };
    if (!observedWindow.__orionSessionPaint)
      throw new Error('Session paint measurement was not installed.');
    return observedWindow.__orionSessionPaint;
  });
}

function sessionButton(page: Page, name: string) {
  return workbenchUi(page).sessionList.getByRole('button', {
    name: new RegExp(`^${name}(?:\\s|$)`, 'u'),
  });
}

async function selectSession(page: Page, name: string, requireComposer = true): Promise<void> {
  await sessionButton(page, name).click();
  await expect(sessionButton(page, name)).toHaveAttribute('aria-current', 'page');
  if (requireComposer) await expect(workbenchUi(page).composer).toBeEnabled();
}

function orionMessage(page: Page, text: string) {
  return workbenchUi(page)
    .main.getByRole('article', { name: 'Orion', exact: true })
    .filter({ hasText: text });
}
