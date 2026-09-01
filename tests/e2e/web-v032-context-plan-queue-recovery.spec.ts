import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { basename, join } from 'path';

import type { Page, Request, TestInfo } from '@playwright/test';

import type {
  WebBootstrapV1,
  WebCommandResultV1,
  WebComposerActionResultV1,
  WebFileTreePageV1,
  WebSessionSnapshotV1,
} from '../../src/web/protocol';
import { digestRuntimeValue } from '../../src/runtime/protocol/canonical';
import {
  activeSessionSnapshot,
  foregroundSessionId,
  sessionSnapshot,
  webBootstrap,
} from './fixtures/api';
import { OPENAI_FIXTURE_MARKERS, OPENAI_FIXTURE_PROMPTS } from './fixtures/openai-provider';
import { startOrionHost } from './fixtures/orion-host';
import {
  allowExpectedNetworkFailures,
  capturedSseEvents,
  closeCapturedEventSources,
  expect,
  installSseCapture,
  test,
} from './fixtures/test';
import {
  createSession,
  setAgentMode,
  submitPrompt,
  waitForApproval,
  waitForWorkbenchReady,
  workbenchUi,
} from './fixtures/ui';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test('WEB32-P0-08 structured Context references are exact, removable, stale-safe and secret-free', async ({
  evidence,
  host,
  page,
  provider,
  workspace,
}, testInfo) => {
  testInfo.setTimeout(180_000);
  const finishSseTransitionEvidence = observeSessionSseTransitions(page);
  const secretMarker = 'OPAQUE_WEB32_CONTEXT_SECRET_8Q2M';
  evidence.addSecretValue(secretMarker);

  mkdirSync(workspace.primaryPath('context-folder'), { recursive: true });
  writeFileSync(
    workspace.primaryPath('context-file.txt'),
    `visible context\ntoken=${secretMarker}\n`,
    'utf8'
  );
  writeFileSync(workspace.primaryPath('context-folder/visible.txt'), 'folder context\n', 'utf8');
  writeFileSync(
    workspace.primaryPath('context-folder/.env'),
    `CONTEXT_TOKEN=${secretMarker}\n`,
    'utf8'
  );
  writeFileSync(workspace.primaryPath('.env'), `CONTEXT_TOKEN=${secretMarker}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  initializeGitReview(workspace.primaryWorkspace);

  await createSession(page, { name: 'WEB32 historical Context' });
  await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.settingsProbe);
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.settingsProbeDone)).toBeVisible({
    timeout: 45_000,
  });
  await waitForIdle(page);
  await createSession(page, { name: 'WEB32 Context manifest' });

  await addFileOrFolderReference(page, 'context-file.txt');
  await addFileOrFolderReference(page, 'context-folder');
  await addRootContextReference(page, '当前 Review');
  await addNestedContextReference(page, '历史 Session', 'WEB32 historical Context');
  await addNestedContextReference(page, 'Skill', 'code-review');

  const tray = page.getByLabel('当前 Context 引用');
  for (const kind of ['FILE', 'FOLDER', 'REVIEW', 'SESSION', 'SKILL']) {
    await expect(tray.getByText(kind, { exact: true })).toBeVisible();
  }
  await tray.getByRole('button', { name: '移除 Context context-file.txt' }).click();
  await expect(tray.getByText('FILE', { exact: true })).toHaveCount(0);
  await addFileOrFolderReference(page, 'context-file.txt');
  await expect(tray.getByText('FILE', { exact: true })).toBeVisible();

  const screenshotName = 'web32-p0-08-context-references.png';
  await page.locator('.composer-control-center').screenshot({
    path: join(evidence.scenarioDirectory, screenshotName),
    animations: 'disabled',
  });
  evidence.recordFact('screenshot.context-references', basename(screenshotName));

  const providerSequence = provider.requests.length;
  const commandResponse = page.waitForResponse(response => {
    if (response.request().method() !== 'POST') return false;
    return new URL(response.url()).pathname === '/api/v1/commands';
  });
  await submitPrompt(page, 'fixture:context-manifest verify the exact structured references');
  const command = (await (await commandResponse).json()) as WebCommandResultV1;
  expect(command.contextReceipt).toMatchObject({
    manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    referenceCount: 5,
  });
  const resolvedRequest = await provider.waitForRequest(
    request =>
      request.sequence > providerSequence && request.lastUserText.includes('context-manifest'),
    45_000
  );
  const manifest = parseContextManifest(resolvedRequest.lastUserText);
  expect(manifest.manifestDigest).toBe(command.contextReceipt?.manifestDigest);
  expect(manifest.references.map(reference => reference.kind).sort()).toEqual([
    'file',
    'folder',
    'review',
    'session',
    'skill',
  ]);
  expect(resolvedRequest.lastUserText).not.toContain(secretMarker);
  expect(JSON.stringify(await capturedSseEvents(page))).not.toContain(secretMarker);
  await waitForIdle(page);

  await addFileOrFolderReference(page, 'context-file.txt');
  writeFileSync(workspace.primaryPath('context-file.txt'), 'new revision\n', 'utf8');
  const requestsBeforeStale = provider.requests.length;
  evidence.expectConsoleErrorOnce(
    'Failed to load resource: the server responded with a status of 409 (Conflict)'
  );
  const staleResponse = page.waitForResponse(response => {
    if (response.request().method() !== 'POST') return false;
    return new URL(response.url()).pathname === '/api/v1/commands';
  });
  await workbenchUi(page).composer.fill('fixture:stale-context must not reach the provider');
  await workbenchUi(page).sendButton.click();
  const stale = await staleResponse;
  expect(stale.status()).toBe(409);
  expect(problemCode(await stale.json())).toBe('context_reference_stale');
  await expect(tray.getByText('已失效，请移除后重新添加')).toBeVisible();
  expect(provider.requests).toHaveLength(requestsBeforeStale);

  const current = await webBootstrap(page);
  const currentSessionId = await foregroundSessionId(page, current.workspaceId);
  const currentSnapshot = await sessionSnapshot(page, currentSessionId);
  const rootFiles = await hostGuardedGet<WebFileTreePageV1>(host.url, '/api/v1/files', current, {
    pageSize: '100',
  });
  const sensitive = rootFiles.body.items.find(item => item.name === '.env');
  expect(sensitive).toBeDefined();
  const forbidden = await hostCommand(host.url, current, {
    requestId: randomUUID(),
    workspaceId: current.workspaceId,
    expectedContextRevision: current.contextRevision,
    expectedSessionId: currentSessionId,
    expectedSessionRuntimeRevision: currentSnapshot.sessionRuntime.runtimeRevision,
    type: 'submit',
    text: 'fixture:forbidden-context must not reach the provider',
    contextReferences: [
      {
        kind: 'file',
        id: sensitive!.id,
        label: sensitive!.name,
        revision: rootFiles.body.revision,
      },
    ],
  });
  expect(forbidden.status).toBe(403);
  expect(problemCode(forbidden.body)).toBe('context_reference_forbidden');
  expect(provider.requests).toHaveLength(requestsBeforeStale);

  evidence.recordFact('web32.context_reference_types', 'file,folder,review,session,skill');
  evidence.recordFact('web32.context_stale_blocked', true);
  evidence.recordFact('web32.context_forbidden_blocked', true);
  evidence.recordFact('web32.prompt_manifest_digest_verified', true);
  evidence.recordFact('web32.context_secret_findings', 0);
  finishSseTransitionEvidence(testInfo);
});

test('WEB32-P0-09 durable Plan review blocks execution and resolves approve, continue and cancel exactly', async ({
  artifactState,
  evidence,
  host,
  page,
  provider,
  workspace,
}, testInfo) => {
  testInfo.setTimeout(240_000);
  const finishSseTransitionEvidence = observeSessionSseTransitions(page);

  await createSession(page, { name: 'WEB32 Plan approve' });
  const approveBefore = provider.requests.filter(request => request.scenario === 'plan').length;
  const awaitingApprove = await createAwaitingPlan(page);
  expect(provider.requests.filter(request => request.scenario === 'plan')).toHaveLength(
    approveBefore + 2
  );
  expect(awaitingApprove.composer.planReview?.status).toBe('awaiting_review');
  expect(digestRuntimeValue(awaitingApprove.plan!.body.trim())).toBe(
    awaitingApprove.composer.planReview?.planDigest
  );
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.planExecutionDone)).toHaveCount(0);

  await closeCapturedEventSources(page);
  await host.stop();
  const replacement = await startOrionHost({
    state: artifactState,
    workspace: workspace.primaryWorkspace,
    configRoot: workspace.configDirectory,
    environment: workspace.environment,
    evidence,
    port: host.port,
  });
  try {
    await page.goto(replacement.url, { waitUntil: 'domcontentloaded' });
    await waitForWorkbenchReady(page, { timeout: 30_000 });
    await activateSessionByName(page, 'WEB32 Plan approve', awaitingApprove.session.id);
    const recovered = await sessionSnapshot(page, awaitingApprove.session.id);
    expect(recovered.session.id).toBe(awaitingApprove.session.id);
    expect(recovered.composer.planReview).toMatchObject({
      planDigest: awaitingApprove.composer.planReview!.planDigest,
      status: 'awaiting_review',
    });

    const screenshotName = 'web32-p0-09-plan-review-recovered.png';
    await page.locator('.plan-review-card').screenshot({
      path: join(evidence.scenarioDirectory, screenshotName),
      animations: 'disabled',
    });
    evidence.recordFact('screenshot.plan-review', basename(screenshotName));

    const active = await webBootstrap(page);
    const composer = await hostComposerState(replacement.url, active, awaitingApprove.session.id);
    const stale = await hostComposerAction(
      replacement.url,
      active,
      awaitingApprove.session.id,
      composer,
      {
        type: 'review_plan',
        planDigest: '0'.repeat(64),
        action: 'approve',
      }
    );
    expect(stale.status).toBe(409);
    expect(problemCode(stale.body)).toBe('plan_review_stale');

    await page.getByRole('button', { name: '批准并进入 BUILD' }).click();
    await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.planExecutionDone)).toBeVisible({
      timeout: 60_000,
    });
    await waitForIdle(page);
    await expect(workbenchUi(page).modeButton).toContainText('BUILD');
    const approvedPlanRequests = provider.requests.filter(request => request.scenario === 'plan');
    expect(approvedPlanRequests).toHaveLength(approveBefore + 4);
    expect(
      approvedPlanRequests
        .slice(approveBefore, approveBefore + 2)
        .every(
          request =>
            request.systemText.includes('[Plan Mode]') &&
            request.lastUserText.includes(OPENAI_FIXTURE_PROMPTS.plan)
        )
    ).toBe(true);
    expect(approvedPlanRequests[approveBefore + 2]).toMatchObject({
      lastUserText: expect.stringContaining('action=approve'),
    });
    expect(approvedPlanRequests[approveBefore + 2].systemText).not.toContain('[Plan Mode]');
    expect(approvedPlanRequests[approveBefore + 3]).toMatchObject({
      lastUserText: expect.stringContaining('[Harness Completion Gate]'),
    });

    await createSession(page, { name: 'WEB32 Plan continue' });
    const continuing = await createAwaitingPlan(page);
    const continuingRevision = continuing.composer.planReview!.revision;
    const executionMarkersBeforeContinue = await orionMessage(
      page,
      OPENAI_FIXTURE_MARKERS.planExecutionDone
    ).count();
    await page.getByRole('button', { name: '继续规划' }).click();
    await page.getByRole('textbox', { name: '继续规划反馈' }).fill('Add one verification step.');
    await page.getByRole('button', { name: '提交反馈' }).click();
    await expect
      .poll(async () => (await activeSessionSnapshot(page)).composer.planReview?.revision, {
        timeout: 60_000,
      })
      .not.toBe(continuingRevision);
    const continued = await activeSessionSnapshot(page);
    expect(continued.composer.planReview?.status).toBe('awaiting_review');
    await expect(workbenchUi(page).modeButton).toContainText('PLAN');
    expect(await orionMessage(page, OPENAI_FIXTURE_MARKERS.planExecutionDone).count()).toBe(
      executionMarkersBeforeContinue
    );

    await createSession(page, { name: 'WEB32 Plan cancel' });
    await createAwaitingPlan(page);
    const planRequestsBeforeCancel = provider.requests.filter(
      request => request.scenario === 'plan'
    ).length;
    await page.getByRole('button', { name: '取消计划' }).click();
    await expect(page.locator('.plan-review-card')).toBeHidden();
    const cancelled = await activeSessionSnapshot(page);
    expect(cancelled.composer.planReview?.status).toBe('cancelled');
    expect(provider.requests.filter(request => request.scenario === 'plan')).toHaveLength(
      planRequestsBeforeCancel
    );
    await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.planExecutionDone)).toHaveCount(0);

    evidence.recordFact('web32.plan_awaiting_review', true);
    evidence.recordFact('web32.plan_preapproval_side_effects', 0);
    evidence.recordFact('web32.plan_decisions_verified', 'approve,continue,cancel');
    evidence.recordFact('web32.plan_restart_recovery', true);
    evidence.recordFact('web32.plan_stale_digest_status', stale.status);
    finishSseTransitionEvidence(testInfo);
  } finally {
    await replacement.stop();
  }
});

test('WEB32-P0-10 queued follow-ups support exact edits and Steer while drafts remain Session-scoped', async ({
  evidence,
  host,
  page,
}, testInfo) => {
  testInfo.setTimeout(180_000);
  const finishSseTransitionEvidence = observeSessionSseTransitions(page);
  await createSession(page, { name: 'WEB32 Queue controls' });
  const queueSessionId = await foregroundSessionId(page);
  await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.pending);
  await waitForApproval(page, 'write_file', { timeout: 45_000 });

  const ui = workbenchUi(page);
  for (const text of ['queue alpha', 'queue beta', 'queue gamma']) {
    await ui.composer.fill(text);
    await ui.queueButton.click();
    await expect
      .poll(async () => (await activeSessionSnapshot(page)).composer.queue.items.length)
      .toBe(['queue alpha', 'queue beta', 'queue gamma'].indexOf(text) + 1);
  }

  const queueDock = page.locator('.queue-dock');
  await queueDock.locator('summary').click();
  await expect(queueDock).toHaveAttribute('open', '');
  const rows = queueDock.locator('.queue-row');
  await rows.nth(0).getByRole('button', { name: '编辑', exact: true }).click();
  await rows.nth(0).getByRole('textbox', { name: '编辑排队消息 1' }).fill('queue alpha edited');
  await rows.nth(0).getByRole('button', { name: '保存', exact: true }).click();
  await expect(rows.nth(0)).toContainText('queue alpha edited');

  await rows.nth(0).getByRole('button', { name: '下移排队消息 1' }).click();
  await expect
    .poll(async () => queueDock.locator('.queue-row p').allTextContents())
    .toEqual(['queue beta', 'queue alpha edited', 'queue gamma']);
  await rows.nth(2).getByRole('button', { name: '移除排队消息 3' }).click();
  await expect(rows).toHaveCount(2);
  await expect
    .poll(async () => queueDock.locator('.queue-row p').allTextContents())
    .toEqual(['queue beta', 'queue alpha edited']);

  const screenshotName = 'web32-p0-10-queue-editor.png';
  await queueDock.screenshot({
    path: join(evidence.scenarioDirectory, screenshotName),
    animations: 'disabled',
  });
  evidence.recordFact('screenshot.queue-editor', basename(screenshotName));

  const active = await webBootstrap(page);
  const beforeCas = await hostComposerState(host.url, active, queueSessionId);
  const casItem = beforeCas.queue.items[0];
  const firstEdit = await hostComposerAction(host.url, active, queueSessionId, beforeCas, {
    type: 'edit_queue_item',
    itemId: casItem.id,
    expectedItemRevision: casItem.revision,
    text: 'queue beta host edit',
  });
  expect(firstEdit.status).toBe(200);
  const afterCas = await hostComposerState(host.url, active, queueSessionId);
  expect(afterCas.queue.items[0]).toMatchObject({
    id: casItem.id,
    text: 'queue beta host edit',
    revision: casItem.revision + 1,
  });
  await expect(rows.nth(0)).toContainText('queue beta host edit');
  const staleEdit = await hostComposerAction(host.url, active, queueSessionId, afterCas, {
    type: 'edit_queue_item',
    itemId: casItem.id,
    expectedItemRevision: casItem.revision,
    text: 'queue beta stale overwrite',
  });
  expect(staleEdit.status).toBe(409);
  expect(problemCode(staleEdit.body)).toBe('queue_item_conflict');
  expect((await hostComposerState(host.url, active, queueSessionId)).queue.items[0].text).toBe(
    'queue beta host edit'
  );

  const queueBeforeSteer = (await activeSessionSnapshot(page)).composer.queue.items;
  const steerResponse = page.waitForResponse(response => {
    if (response.request().method() !== 'POST') return false;
    return new URL(response.url()).pathname === '/api/v1/commands';
  });
  await ui.composer.fill('fixture:steer revise the active request now');
  await page.getByRole('button', { name: 'Steer', exact: true }).click();
  const steerHttpResponse = await steerResponse;
  const steerBody = await steerHttpResponse.json();
  expect({ status: steerHttpResponse.status(), code: problemCode(steerBody) }).toEqual({
    status: 202,
    code: undefined,
  });
  const steer = steerBody as WebCommandResultV1;
  expect(steer.result).toBe('revision_requested');
  const queueAfterSteer = (await activeSessionSnapshot(page)).composer.queue.items;
  const admittedWhileSteering = queueBeforeSteer.length - queueAfterSteer.length;
  expect(admittedWhileSteering).toBeGreaterThanOrEqual(0);
  expect(admittedWhileSteering).toBeLessThanOrEqual(1);
  expect(queueAfterSteer.map(item => item.id)).toEqual(
    queueBeforeSteer.slice(admittedWhileSteering).map(item => item.id)
  );
  await waitForIdle(page);
  await expect(
    page.getByRole('article', { name: '你' }).filter({ hasText: 'queue beta host edit' })
  ).toHaveCount(1);
  await expect(
    page.getByRole('article', { name: '你' }).filter({ hasText: 'queue alpha edited' })
  ).toHaveCount(1);
  await expect(
    page
      .getByRole('article', { name: '你' })
      .filter({ hasText: 'fixture:steer revise the active request now' })
  ).toHaveCount(1);
  expect((await activeSessionSnapshot(page)).composer.queue.items).toEqual([]);

  await createSession(page, { name: 'WEB32 Draft A' });
  const sessionA = (await activeSessionSnapshot(page)).session;
  await ui.composer.fill('DRAFT_A_ONLY');
  await waitForStoredDraft(page, 'DRAFT_A_ONLY');
  await createSession(page, { name: 'WEB32 Draft B' });
  const sessionB = (await activeSessionSnapshot(page)).session;
  await expect(ui.composer).toHaveValue('');
  await ui.composer.fill('DRAFT_B_ONLY');
  await waitForStoredDraft(page, 'DRAFT_B_ONLY');

  await activateSessionByName(page, 'WEB32 Draft A', sessionA.id);
  await expect(ui.composer).toHaveValue('DRAFT_A_ONLY');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  await expect(ui.composer).toHaveValue('DRAFT_A_ONLY');
  await activateSessionByName(page, 'WEB32 Draft B', sessionB.id);
  await expect(ui.composer).toHaveValue('DRAFT_B_ONLY');
  await expect(ui.composer).not.toHaveValue(/DRAFT_A_ONLY/u);

  evidence.recordFact('web32.queue_actions', 'edit,move,remove,steer');
  evidence.recordFact('web32.queue_item_cas_verified', true);
  evidence.recordFact('web32.draft_switch_refresh_verified', true);
  evidence.recordFact('web32.cross_session_draft_leaks', 0);
  finishSseTransitionEvidence(testInfo);
});

test('WEB32-P0-11 two-tab control CAS and replay recovery preserve the matching Session barrier', async ({
  artifactState,
  context,
  evidence,
  host,
  page,
  provider,
  workspace,
}, testInfo) => {
  testInfo.setTimeout(240_000);
  const network = createKnownSseFailureObserver(testInfo, ['net::ERR_ABORTED']);
  network.track(page);
  await createSession(page, { name: 'WEB32 Recovery target' });
  const target = (await activeSessionSnapshot(page)).session;
  const providerRequestsBefore = provider.requests.length;

  const other = await context.newPage();
  await installSseCapture(other);
  const detachOther = evidence.attachPage(other);
  network.track(other);
  try {
    await other.goto(host.url, { waitUntil: 'domcontentloaded' });
    await waitForWorkbenchReady(other, { timeout: 30_000 });
    await activateSessionByName(other, 'WEB32 Recovery target', target.id);
    expect((await sessionSnapshot(other, target.id)).session.id).toBe(target.id);
    const staleControl = await hostComposerState(host.url, await webBootstrap(other), target.id);
    await closeCapturedEventSources(other);

    const activeControl = await webBootstrap(page);
    const applied = await hostComposerAction(host.url, activeControl, target.id, staleControl, {
      type: 'set_permission_override',
      value: 'deny',
    });
    expect(applied.status).toBe(200);
    expect((await hostComposerState(host.url, activeControl, target.id)).permission.override).toBe(
      'deny'
    );

    evidence.expectConsoleErrorOnce(
      'Failed to load resource: the server responded with a status of 409 (Conflict)'
    );
    const staleResponse = other.waitForResponse(response => {
      if (response.request().method() !== 'POST') return false;
      return new URL(response.url()).pathname.endsWith('/composer-actions');
    });
    await workbenchUi(other).modeButton.click();
    await other
      .getByRole('menu', { name: '工作模式' })
      .getByRole('menuitemradio', { name: /^PLAN\b/u })
      .click();
    const stale = await staleResponse;
    expect(stale.status()).toBe(409);
    expect(problemCode(await stale.json())).toBe('session_runtime_revision_conflict');
    const afterConflict = await hostComposerState(host.url, await webBootstrap(page), target.id);
    expect(afterConflict.mode.baseMode).toBe(staleControl.mode.baseMode);
    expect(afterConflict.permission.override).toBe('deny');
    expect(provider.requests).toHaveLength(providerRequestsBefore);
  } finally {
    detachOther();
    await other.close();
  }

  await closeCapturedEventSources(page);
  await host.stop();
  const replacement = await startOrionHost({
    state: artifactState,
    workspace: workspace.primaryWorkspace,
    configRoot: workspace.configDirectory,
    environment: workspace.environment,
    evidence,
    port: host.port,
  });
  let releaseSnapshot: (() => void) | undefined;
  try {
    await page.goto(replacement.url, { waitUntil: 'domcontentloaded' });
    await waitForWorkbenchReady(page, { timeout: 30_000 });
    await activateSessionByName(page, 'WEB32 Recovery target', target.id);
    const restarted = await sessionSnapshot(page, target.id);
    expect(restarted.session.id).toBe(target.id);
    expect(restarted.composer.permission.override).toBe('deny');

    let forcedReplayCursor = false;
    const eventRoute = '**/api/v1/events?**';
    await page.route(eventRoute, async route => {
      if (forcedReplayCursor) {
        await route.continue();
        return;
      }
      forcedReplayCursor = true;
      const url = new URL(route.request().url());
      url.searchParams.set('cursor', String(Number.MAX_SAFE_INTEGER));
      await route.continue({ url: url.toString() });
    });

    network.allow('net::ERR_INTERNET_DISCONNECTED');
    await context.setOffline(true);
    await expect(page.getByText('网络已离线，Orion 将在恢复后重连', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await context.setOffline(false);
    const recover = page.getByRole('button', { name: '恢复', exact: true });
    await expect(recover).toBeVisible({ timeout: 30_000 });
    expect(forcedReplayCursor).toBe(true);
    await expect(workbenchUi(page).composer).toBeDisabled();
    expect(
      (await capturedSseEvents(page)).some(
        event => isRecord(event) && event.type === 'replay_reset'
      )
    ).toBe(true);
    await page.unroute(eventRoute);

    let snapshotHeld = false;
    let markSnapshotHeld!: () => void;
    const snapshotReached = new Promise<void>(resolve => {
      markSnapshotHeld = resolve;
    });
    const snapshotGate = new Promise<void>(resolve => {
      releaseSnapshot = resolve;
    });
    const snapshotRoute = '**/api/v1/sessions/*/snapshot?**';
    await page.route(snapshotRoute, async route => {
      if (!snapshotHeld) {
        snapshotHeld = true;
        markSnapshotHeld();
        await snapshotGate;
      }
      await route.continue();
    });
    await recover.click();
    await snapshotReached;
    await expect(workbenchUi(page).composer).toBeDisabled();
    const releaseHeldSnapshot = releaseSnapshot;
    if (!releaseHeldSnapshot) throw new Error('Snapshot barrier was not initialized.');
    releaseHeldSnapshot();
    releaseSnapshot = undefined;
    await expect(workbenchUi(page).composer).toBeEnabled({ timeout: 30_000 });
    await page.unroute(snapshotRoute);
    expect((await sessionSnapshot(page, target.id)).session.id).toBe(target.id);

    const screenshotName = 'web32-p0-11-recovery-barrier.png';
    await page.locator('.composer-control-center').screenshot({
      path: join(evidence.scenarioDirectory, screenshotName),
      animations: 'disabled',
    });
    evidence.recordFact('screenshot.recovery-barrier', basename(screenshotName));
    evidence.recordFact('web32.control_cas_two_tabs', true);
    evidence.recordFact('web32.host_restart_recovered', true);
    evidence.recordFact('web32.replay_reset_recovered', true);
    evidence.recordFact('web32.composer_snapshot_barrier', true);
  } finally {
    releaseSnapshot?.();
    await context.setOffline(false);
    await replacement.stop();
    network.finish();
  }
});

async function createAwaitingPlan(page: Page): Promise<WebSessionSnapshotV1> {
  await setAgentMode(page, 'PLAN');
  await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.plan);
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.planReady)).toBeVisible({
    timeout: 60_000,
  });
  await waitForIdle(page);
  const snapshot = await activeSessionSnapshot(page);
  expect(snapshot.plan?.digest).toMatch(/^[a-f0-9]{64}$/u);
  expect(snapshot.composer.planReview).toMatchObject({
    planDigest: digestRuntimeValue(snapshot.plan!.body.trim()),
    status: 'awaiting_review',
  });
  await expect(page.getByRole('heading', { name: '计划已保存，尚未执行' })).toBeVisible();
  return snapshot;
}

async function activateSessionByName(
  page: Page,
  name: string,
  expectedSessionId: string
): Promise<void> {
  const button = workbenchUi(page)
    .sessionList.locator('.project-session-main')
    .filter({ hasText: new RegExp(`^${escapeRegex(name)}\\b`, 'u') });
  await expect(button).toHaveCount(1, { timeout: 30_000 });
  if ((await button.getAttribute('aria-current')) !== 'page') {
    await button.click();
  }
  await expect.poll(() => foregroundSessionId(page), { timeout: 30_000 }).toBe(expectedSessionId);
  await expect(workbenchUi(page).composer).toBeEnabled({ timeout: 30_000 });
}

async function addFileOrFolderReference(page: Page, name: string): Promise<void> {
  const menu = await openContextMenu(page);
  await menu.getByRole('menuitem', { name: /^文件或目录/u }).click();
  await menu.getByRole('menuitem', { name: new RegExp(`^${escapeRegex(name)}\\b`, 'u') }).click();
  await expect(page.getByLabel('当前 Context 引用').getByText(name, { exact: true })).toBeVisible();
}

async function addRootContextReference(page: Page, label: string): Promise<void> {
  const menu = await openContextMenu(page);
  await menu.getByRole('menuitem', { name: new RegExp(`^${escapeRegex(label)}\\b`, 'u') }).click();
  await expect(menu).toBeHidden({ timeout: 30_000 });
}

async function addNestedContextReference(
  page: Page,
  category: '历史 Session' | 'Skill',
  label: string
): Promise<void> {
  const menu = await openContextMenu(page);
  await menu
    .getByRole('menuitem', { name: new RegExp(`^${escapeRegex(category)}\\b`, 'u') })
    .click();
  const option = menu.getByRole('menuitem', {
    name: new RegExp(`^${escapeRegex(label)}\\b`, 'u'),
  });
  await expect(option).toBeVisible({ timeout: 30_000 });
  await option.click();
  await expect(menu).toBeHidden({ timeout: 30_000 });
  await expect(
    page.getByLabel('当前 Context 引用').getByText(label, { exact: true })
  ).toBeVisible();
}

async function openContextMenu(page: Page) {
  await page.getByRole('button', { name: '添加 Context', exact: true }).click();
  const menu = page.getByRole('menu', { name: '添加 Context' });
  await expect(menu).toBeVisible();
  return menu;
}

function initializeGitReview(workspace: string): void {
  git(workspace, ['init', '-b', 'main']);
  git(workspace, ['config', 'user.name', 'Orion Web E2E']);
  git(workspace, ['config', 'user.email', 'web-e2e@example.invalid']);
  git(workspace, ['add', '--all']);
  git(workspace, ['commit', '-m', 'context base']);
  writeFileSync(join(workspace, 'review-context.ts'), 'export const review = 2;\n', 'utf8');
}

function git(workspace: string, args: readonly string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd: workspace,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function parseContextManifest(text: string): {
  readonly manifestDigest: string;
  readonly references: readonly { readonly kind: string }[];
} {
  const marker = '[Orion Context Manifest V1]\n';
  const offset = text.indexOf(marker);
  if (offset < 0) throw new Error('Resolved provider request omitted the Context manifest.');
  return JSON.parse(text.slice(offset + marker.length)) as {
    readonly manifestDigest: string;
    readonly references: readonly { readonly kind: string }[];
  };
}

async function hostComposerState(
  hostUrl: string,
  bootstrap: WebBootstrapV1,
  sessionId: string
): Promise<WebComposerActionResultV1['state']> {
  const result = await hostGuardedGet<WebComposerActionResultV1['state']>(
    hostUrl,
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/composer-state`,
    bootstrap
  );
  if (result.status !== 200) throw new Error(`Composer state failed with HTTP ${result.status}.`);
  return result.body;
}

async function hostComposerAction(
  hostUrl: string,
  bootstrap: WebBootstrapV1,
  sessionId: string,
  composer: WebComposerActionResultV1['state'],
  action: Readonly<Record<string, unknown>>
): Promise<{ readonly status: number; readonly body: unknown }> {
  return hostJson(
    hostUrl,
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/composer-actions`,
    bootstrap.nonce,
    {
      requestId: randomUUID(),
      workspaceId: bootstrap.workspaceId,
      expectedContextRevision: bootstrap.contextRevision,
      expectedSessionId: sessionId,
      expectedSessionRuntimeRevision: composer.sessionRuntime.runtimeRevision,
      expectedControlRevision: composer.controlRevision,
      ...action,
    }
  );
}

async function hostCommand(
  hostUrl: string,
  bootstrap: WebBootstrapV1,
  body: Readonly<Record<string, unknown>>
): Promise<{ readonly status: number; readonly body: unknown }> {
  return hostJson(hostUrl, '/api/v1/commands', bootstrap.nonce, body);
}

async function hostJson(
  hostUrl: string,
  path: string,
  nonce: string,
  body: unknown
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(`${hostUrl}${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: hostUrl,
      'x-orion-web-nonce': nonce,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
}

async function hostGuardedGet<T>(
  hostUrl: string,
  path: string,
  context: Pick<WebBootstrapV1, 'workspaceId' | 'contextRevision'>,
  extra: Readonly<Record<string, string>> = {}
): Promise<{ readonly status: number; readonly body: T }> {
  const url = new URL(path, hostUrl);
  url.searchParams.set('workspaceId', context.workspaceId);
  url.searchParams.set('expectedContextRevision', context.contextRevision);
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  return { status: response.status, body: (await response.json()) as T };
}

async function waitForIdle(page: Page): Promise<void> {
  await expect
    .poll(async () => (await activeSessionSnapshot(page)).runtime.processing, { timeout: 60_000 })
    .toBe(false);
}

async function waitForStoredDraft(page: Page, marker: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          expected =>
            window.sessionStorage.getItem('orion.web.composer-drafts.v1')?.includes(expected) ===
            true,
          marker
        ),
      { timeout: 10_000 }
    )
    .toBe(true);
}

function orionMessage(page: Page, marker: string) {
  return page.getByRole('article', { name: 'Orion' }).filter({ hasText: marker }).last();
}

interface NetworkFailure {
  readonly method: string;
  readonly path: string;
  readonly error: string;
}

function observeSessionSseTransitions(page: Page): (testInfo: TestInfo) => void {
  const failures: NetworkFailure[] = [];
  const onRequestFailed = (request: Request): void => {
    failures.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      error: request.failure()?.errorText ?? '',
    });
  };
  page.on('requestfailed', onRequestFailed);
  return testInfo => {
    page.off('requestfailed', onRequestFailed);
    for (const failure of failures) {
      expect(failure).toEqual({
        method: 'GET',
        path: '/api/v1/events',
        error: 'net::ERR_ABORTED',
      });
    }
    allowExpectedNetworkFailures(testInfo, failures.length);
  };
}

function createKnownSseFailureObserver(testInfo: TestInfo, initialErrors: readonly string[]) {
  const failures: NetworkFailure[] = [];
  const allowedErrors = new Set(initialErrors);
  const detachers: (() => void)[] = [];
  const annotation = {
    type: 'evidence:allow-network-failures',
    description: '0',
  };
  testInfo.annotations.push(annotation);
  return {
    track(page: Page): void {
      const onRequestFailed = (request: Request): void => {
        failures.push({
          method: request.method(),
          path: new URL(request.url()).pathname,
          error: request.failure()?.errorText ?? '',
        });
        annotation.description = String(failures.length);
      };
      page.on('requestfailed', onRequestFailed);
      detachers.push(() => page.off('requestfailed', onRequestFailed));
    },
    allow(error: string): void {
      allowedErrors.add(error);
    },
    finish(): void {
      detachers.splice(0).forEach(detach => detach());
      for (const failure of failures) {
        expect(failure.method).toBe('GET');
        expect(failure.path).toBe('/api/v1/events');
        expect([...allowedErrors]).toContain(failure.error);
      }
      annotation.description = String(failures.length);
    },
  };
}

function problemCode(value: unknown): string | undefined {
  return isRecord(value) && typeof value.code === 'string' ? value.code : undefined;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
