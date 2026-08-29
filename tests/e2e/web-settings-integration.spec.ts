import { createHash, randomUUID } from 'crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'fs';
import { request as httpRequest } from 'http';
import { basename, dirname, join } from 'path';

import type { Browser, Page, Request } from '@playwright/test';

import type { WebSettingsDocumentV1, WebSettingsMutationResultV1 } from '../../src/web/protocol';
import { digestRuntimeValue } from '../../src/runtime/protocol/canonical';
import type { ToolInvocationReceiptV1 } from '../../src/runtime/tool-gateway';
import {
  activeSessionSnapshot,
  sessionSnapshot,
  settingsSnapshot,
  updateSettings,
  webBootstrap,
} from './fixtures/api';
import type { WebE2EEvidenceCollector } from './fixtures/evidence';
import {
  OPENAI_FIXTURE_ALTERNATE_MODEL,
  OPENAI_FIXTURE_FILES,
  OPENAI_FIXTURE_MARKERS,
  OPENAI_FIXTURE_MODEL,
  OPENAI_FIXTURE_PROMPTS,
} from './fixtures/openai-provider';
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
  answerApproval,
  applySettings,
  createSession,
  discardSettingsDraft,
  openSettings,
  selectSettingsSection,
  setSettingsPermission,
  setSettingsSelect,
  submitPrompt,
  waitForApproval,
  waitForWorkbenchReady,
  workbenchUi,
} from './fixtures/ui';
import type { WorkspaceFixtureConfig } from './fixtures/workspace';

const HEX_DIGEST = /^[a-f0-9]{64}$/u;
const REVISION = /^hmac-sha256:[a-f0-9]{64}$/u;

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test('SET-P0-01 Theme and Motion migrate, persist, refresh, and survive a new-port Host @settings', async ({
  artifactState,
  evidence,
  host,
  page,
  workspace,
}, testInfo) => {
  allowExpectedNetworkFailures(testInfo, 5);
  await page.evaluate(() => {
    localStorage.setItem('orion.web.theme', 'dark');
    localStorage.setItem('orion.web.motion', 'reduced');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForWorkbenchReady(page, { timeout: 30_000 });

  const migrated = await waitForSettings(
    page,
    value =>
      value.sections.appearance.theme.effectiveValue === 'dark' &&
      value.sections.appearance.motion.effectiveValue === 'reduced'
  );
  expect(migrated.revision).toMatch(REVISION);
  expect(
    await page.evaluate(() => ({
      theme: localStorage.getItem('orion.web.theme'),
      motion: localStorage.getItem('orion.web.motion'),
    }))
  ).toEqual({ theme: null, motion: null });

  await openSettings(page);
  await expect(
    workbenchUi(page).settingsDialog.getByRole('combobox', { name: '主题' })
  ).toHaveValue('dark');
  await setSettingsSelect(page, '主题', 'light');
  await setSettingsSelect(page, '动效', 'system');
  await applySettings(page, 2);
  const saved = await settingsSnapshot(page);
  expect(saved.sections.appearance.theme.effectiveValue).toBe('light');
  expect(saved.sections.appearance.motion.effectiveValue).toBe('system');
  expect(saved.revision).not.toBe(migrated.revision);
  await closeSettings(page);

  const catalogSettled = waitForStartupCatalog(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await Promise.all([waitForWorkbenchReady(page, { timeout: 30_000 }), catalogSettled]);
  expect((await settingsSnapshot(page)).revision).toBe(saved.revision);

  await host.stop();
  const replacement = await startOrionHost({
    state: artifactState,
    workspace: workspace.primaryWorkspace,
    configRoot: workspace.configDirectory,
    environment: workspace.environment,
    evidence,
  });
  try {
    expect(replacement.port).not.toBe(host.port);
    await page.goto(replacement.url, { waitUntil: 'domcontentloaded' });
    await waitForWorkbenchReady(page, { timeout: 30_000 });
    const restarted = await settingsSnapshot(page);
    expect(restarted.revision).toBe(saved.revision);
    expect(restarted.sections.appearance.theme.effectiveValue).toBe('light');
    expect(restarted.sections.appearance.motion.effectiveValue).toBe('system');
    await openSettings(page);
    await expect(
      workbenchUi(page).settingsDialog.getByRole('combobox', { name: '主题' })
    ).toHaveValue('light');
    await captureSettingsDialog(page, evidence, 'set-p0-01');
  } finally {
    await replacement.stop();
  }
  recordSettingsEvidence(evidence, migrated.revision, saved.revision);
});

test('SET-P0-02 default model affects only newly created Sessions and the real provider @settings', async ({
  evidence,
  page,
  provider,
}, testInfo) => {
  allowExpectedNetworkFailures(testInfo, 3);
  await createSession(page, { name: 'Model before default change' });
  const oldSession = await activeSessionSnapshot(page);
  expect(oldSession.session.model).toBe(OPENAI_FIXTURE_MODEL);

  await openSettings(page);
  await selectSettingsSection(page, 'Models & Reasoning');
  await setSettingsSelect(page, '默认模型', OPENAI_FIXTURE_ALTERNATE_MODEL);
  await applySettings(page, 1);
  const currentCard = workbenchUi(page).settingsDialog.getByLabel('当前会话设置');
  await expect(currentCard).toContainText(OPENAI_FIXTURE_MODEL);
  await closeSettings(page);

  await createSession(page, { name: 'Model after default change' });
  const newSession = await activeSessionSnapshot(page);
  expect(newSession.session.model).toBe(OPENAI_FIXTURE_ALTERNATE_MODEL);
  expect((await sessionSnapshot(page, oldSession.session.id)).session.model).toBe(
    OPENAI_FIXTURE_MODEL
  );

  const sequence = provider.requests.length;
  await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.settingsProbe);
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.settingsProbeDone)).toBeVisible({
    timeout: 45_000,
  });
  await waitForIdle(page);
  const request = await provider.waitForRequest(
    value => value.sequence > sequence && value.scenario === 'settings-probe'
  );
  expect(request.model).toBe(OPENAI_FIXTURE_ALTERNATE_MODEL);

  await openSettings(page);
  await selectSettingsSection(page, 'Models & Reasoning');
  await captureSettingsDialog(page, evidence, 'set-p0-02');
  evidence.recordFact('model.old_session', oldSession.session.model);
  evidence.recordFact('model.new_session', newSession.session.model);
  evidence.recordFact('model.provider_wire', request.model);
});

test('SET-P0-03 project Effort wins over global and model defaults across workspaces and restart @settings', async ({
  artifactState,
  evidence,
  host,
  page,
  provider,
  workspace,
}, testInfo) => {
  allowExpectedNetworkFailures(testInfo, 8);
  await createSession(page, { name: 'Primary effort session' });
  await openSettings(page);
  await selectSettingsSection(page, 'Models & Reasoning');
  await setSettingsSelect(page, '默认推理强度', 'high');
  await applySettings(page, 1);
  await closeSettings(page);

  const withGlobal = {
    ...workspace.readConfig(),
    defaultEffort: 'low',
  } as WorkspaceFixtureConfig;
  workspace.writeConfig(withGlobal);
  await waitForSettings(page, value => value.sections.defaults.effort.effectiveValue === 'high');

  const primary = await runSettingsProbe(page, provider);
  expect(primary.reasoningEffort).toBe('high');

  await switchWorkspace(page, workspace.secondaryWorkspace);
  await createSession(page, { name: 'Secondary effort session' });
  const inherited = await settingsSnapshot(page);
  expect(inherited.sections.defaults.effort).toMatchObject({
    effectiveValue: 'low',
    source: 'global',
  });
  const secondaryGlobal = await runSettingsProbe(page, provider);
  expect(secondaryGlobal.reasoningEffort).toBe('low');

  await openSettings(page);
  await selectSettingsSection(page, 'Models & Reasoning');
  await setSettingsSelect(page, '默认推理强度', 'medium');
  await applySettings(page, 1);
  await closeSettings(page);
  const secondaryProject = await runSettingsProbe(page, provider);
  expect(secondaryProject.reasoningEffort).toBe('medium');

  const primaryCatalogSettled = waitForStartupCatalog(page);
  await switchWorkspace(page, workspace.primaryWorkspace);
  await primaryCatalogSettled;
  await host.stop();
  const replacement = await startOrionHost({
    state: artifactState,
    workspace: workspace.primaryWorkspace,
    configRoot: workspace.configDirectory,
    environment: workspace.environment,
    evidence,
  });
  try {
    await page.goto(replacement.url, { waitUntil: 'domcontentloaded' });
    await waitForWorkbenchReady(page, { timeout: 30_000 });
    if (!(await webBootstrap(page)).activeSessionId) {
      await createSession(page);
    } else {
      await expect(workbenchUi(page).composer).toBeEnabled({ timeout: 30_000 });
    }
    const restarted = await runSettingsProbe(page, provider);
    expect(restarted.reasoningEffort).toBe('high');
    await openSettings(page);
    await selectSettingsSection(page, 'Models & Reasoning');
    await captureSettingsDialog(page, evidence, 'set-p0-03');
  } finally {
    await replacement.stop();
  }
  evidence.recordFact('effort.primary_wire', primary.reasoningEffort ?? 'missing');
  evidence.recordFact('effort.global_wire', secondaryGlobal.reasoningEffort ?? 'missing');
  evidence.recordFact('effort.secondary_wire', secondaryProject.reasoningEffort ?? 'missing');
});

test('SET-P0-04 ask to allow and deny reaches the real ToolGateway with durable receipts @settings', async ({
  evidence,
  page,
  provider,
  workspace,
}, testInfo) => {
  allowExpectedNetworkFailures(testInfo, 3);
  await createSession(page, { name: 'Settings policy session' });
  await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.pending);
  await waitForApproval(page, 'write_file', { timeout: 30_000 });
  const pendingProviderRequests = provider.requests.filter(
    request => request.scenario === 'pending'
  ).length;
  expect(pendingProviderRequests).toBe(1);

  await openSettings(page);
  await selectSettingsSection(page, 'Models & Reasoning');
  await expect(
    workbenchUi(page).settingsDialog.getByRole('combobox', { name: '默认模型' })
  ).toBeEnabled();
  await expect(
    workbenchUi(page).settingsDialog.getByRole('combobox', { name: '默认推理强度' })
  ).toBeDisabled();
  await selectSettingsSection(page, 'Permissions');
  const busy = workbenchUi(page).settingsDialog.getByRole('status').filter({
    hasText: '当前回合正在运行',
  });
  await expect(busy).toBeVisible();
  await expect(
    workbenchUi(page).settingsDialog.getByRole('radio', { name: 'Allow', exact: true })
  ).toBeDisabled();
  await closeSettings(page);
  await answerApproval(page, 'reject', 'write_file');
  await expect(page.getByRole('article', { name: '工具 write_file：失败' })).toContainText(
    'User denied the operation.',
    { timeout: 45_000 }
  );
  await waitForIdle(page);
  expect((await activeSessionSnapshot(page)).pendingApprovals).toEqual([]);
  expect(existsSync(workspace.primaryPath(OPENAI_FIXTURE_FILES.pendingWrite))).toBe(false);
  expect(provider.requests.filter(request => request.scenario === 'pending')).toHaveLength(
    pendingProviderRequests
  );

  await openSettings(page);
  await selectSettingsSection(page, 'Permissions');
  await setSettingsPermission(page, 'Allow');
  await applySettings(page, 1);
  await closeSettings(page);
  const receiptBaseline = durableToolReceipts(await capturedSseEvents(page)).length;

  await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.approveWriteExec);
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.approveWriteExecDone)).toBeVisible({
    timeout: 60_000,
  });
  await waitForIdle(page);
  expect(readFileSync(workspace.primaryPath(OPENAI_FIXTURE_FILES.approvedWrite), 'utf8')).toBe(
    'WRITE_APPROVED\n'
  );
  expect(readFileSync(workspace.primaryPath(OPENAI_FIXTURE_FILES.execProof), 'utf8')).toBe(
    'EXEC_APPROVED\n'
  );
  const allowReceipts = await waitForDurableReceipts(page, receiptBaseline + 2);
  const allowTail = allowReceipts.slice(receiptBaseline, receiptBaseline + 2);
  expect(allowTail).toHaveLength(2);
  expect(new Set(allowTail.map(value => value.executionPolicyDigest)).size).toBe(1);
  expect(new Set(allowTail.map(value => value.receiptDigest)).size).toBe(2);

  await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.autoEscape);
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.autoEscapeBlocked)).toBeVisible({
    timeout: 45_000,
  });
  await waitForIdle(page);
  expect(existsSync(workspace.secondaryPath(OPENAI_FIXTURE_FILES.autoEscapeWrite))).toBe(false);

  await openSettings(page);
  await selectSettingsSection(page, 'Permissions');
  await setSettingsPermission(page, 'Deny');
  await applySettings(page, 1);
  await closeSettings(page);
  await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.denyWrite);
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.denyWriteDone)).toBeVisible({
    timeout: 45_000,
  });
  await waitForIdle(page);
  expect(existsSync(workspace.primaryPath(OPENAI_FIXTURE_FILES.deniedWrite))).toBe(false);

  const authorizations = await page
    .getByRole('article', { name: /^\u5de5\u5177 /u })
    .getByText(/(?:config_allow|tool_policy)/u)
    .allTextContents();
  expect(authorizations.some(value => value.includes('config_allow'))).toBe(true);
  expect(authorizations.some(value => value.includes('tool_policy'))).toBe(true);
  const allReceipts = await waitForDurableReceipts(page, receiptBaseline + 4);
  allReceipts.forEach(value => {
    expect(value.executionPolicyDigest).toMatch(HEX_DIGEST);
    expect(value.receiptDigest).toMatch(HEX_DIGEST);
  });
  const active = await activeSessionSnapshot(page);
  expect(active.threadId).toEqual(expect.any(String));
  const durableReceipts = loadDurableToolReceipts(
    workspace.configDirectory,
    active.session.id,
    active.threadId!
  );
  for (const projected of allReceipts) {
    const durable = durableReceipts.get(projected.callId);
    expect(durable, `missing durable receipt for ${projected.callId}`).toBeDefined();
    expect(projected.receiptDigest).toBe(durable!.digest);
    expect(projected.executionPolicyDigest).toBe(durable!.executionPolicyDigest);
    expect(projected.name).toBe(durable!.toolName);
  }
  for (const projected of allowTail) {
    expect(durableReceipts.get(projected.callId)).toMatchObject({
      approval: { approved: true, source: 'authority' },
      success: true,
      terminalPhase: 'execute',
    });
  }
  const deniedProjected = allReceipts.slice(receiptBaseline).at(-1);
  expect(deniedProjected).toBeDefined();
  const deniedDurable = durableReceipts.get(deniedProjected!.callId);
  expect(deniedDurable).toBeDefined();
  expect(deniedDurable!.approval).toBeUndefined();
  expect(deniedDurable!.policy).toBeUndefined();
  expect(deniedDurable).toMatchObject({
    success: false,
    terminal: 'failed',
    terminalPhase: 'capability',
    toolName: 'write_file',
  });

  await openSettings(page);
  await selectSettingsSection(page, 'Permissions');
  await captureSettingsDialog(page, evidence, 'set-p0-04');
  evidence.recordFact('policy.receipts', allReceipts.length - receiptBaseline);
  evidence.recordFact('policy.allow_receipt_digest', digest(allowTail[0].receiptDigest));
  evidence.recordFact('policy.hard_escape_blocked', true);
});

test('SET-P0-05 one UI draft emits one atomic three-field PATCH and rejects all of an invalid batch @settings', async ({
  evidence,
  host,
  page,
  workspace,
}) => {
  const before = await settingsSnapshot(page);
  const patches: Array<{ readonly request: Request; readonly body: Record<string, unknown> }> = [];
  const onRequest = (request: Request) => {
    if (request.method() !== 'PATCH' || new URL(request.url()).pathname !== '/api/v1/settings')
      return;
    patches.push({ request, body: request.postDataJSON() as Record<string, unknown> });
  };
  page.on('request', onRequest);
  await openSettings(page);
  await setSettingsSelect(page, '主题', 'dark');
  await setSettingsSelect(page, '动效', 'reduced');
  await selectSettingsSection(page, 'Models & Reasoning');
  await setSettingsSelect(page, '默认推理强度', 'high');
  await applySettings(page, 3);
  page.off('request', onRequest);

  expect(patches).toHaveLength(1);
  const operations = patches[0].body.operations as Array<{ readonly key: string }>;
  expect(operations.map(value => value.key).sort()).toEqual([
    'appearance.motion',
    'appearance.theme',
    'defaults.effort',
  ]);
  const after = await settingsSnapshot(page);
  expect(after.revision).not.toBe(before.revision);
  expect(after.sections.appearance.theme.effectiveValue).toBe('dark');
  expect(after.sections.appearance.motion.effectiveValue).toBe('reduced');
  expect(after.sections.defaults.effort.effectiveValue).toBe('high');

  const committedBytes = workspace.readConfigBytes();
  const rejected = await hostJson<unknown>(
    host.url,
    (await hostBootstrap(host.url)).nonce,
    '/api/v1/settings',
    'PATCH',
    {
      requestId: randomUUID(),
      expectedRevision: after.revision,
      operations: [
        { op: 'set', key: 'appearance.theme', value: 'light' },
        { op: 'set', key: 'defaults.model', value: 'fixture-model-does-not-exist' },
      ],
    }
  );
  expect(rejected.status).toBe(422);
  expect(problemCode(rejected.body)).toBe('settings_rejected');
  expect(workspace.readConfigBytes()).toEqual(committedBytes);
  expect((await hostSettingsSnapshot(host.url)).revision).toBe(after.revision);

  await captureSettingsDialog(page, evidence, 'set-p0-05');
  evidence.recordFact('batch.patch_count', patches.length);
  evidence.recordFact('batch.operation_count', operations.length);
  evidence.recordFact('batch.rejected_status', rejected.status);
  recordSettingsEvidence(evidence, before.revision, after.revision);
});

test('SET-P0-06 two real pages preserve a stale draft and finish an explicit conflict rebase @settings', async ({
  browser,
  evidence,
  host,
  page,
  workspace,
}, testInfo) => {
  allowExpectedNetworkFailures(testInfo, 1);
  const otherContext = await browser.newContext({ bypassCSP: false });
  const other = await otherContext.newPage();
  await installSseCapture(other);
  const detach = evidence.attachPage(other);
  try {
    await other.goto(host.url, { waitUntil: 'domcontentloaded' });
    await waitForWorkbenchReady(other, { timeout: 30_000 });
    const leftBase = await settingsSnapshot(page);
    const rightBase = await settingsSnapshot(other);
    expect(rightBase.revision).toBe(leftBase.revision);

    await openSettings(page);
    await openSettings(other);
    await setSettingsSelect(page, '主题', 'light');
    await setSettingsSelect(other, '主题', 'dark');
    const closedSseFailures: Array<{
      readonly method: string;
      readonly path: string;
      readonly error: string;
    }> = [];
    const onClosedSseFailure = (request: Request) => {
      closedSseFailures.push({
        method: request.method(),
        path: new URL(request.url()).pathname,
        error: request.failure()?.errorText ?? '',
      });
    };
    other.on('requestfailed', onClosedSseFailure);
    const closedEventSources = await closeCapturedEventSources(other);
    expect(closedEventSources).toBeGreaterThan(0);
    await expect.poll(() => closedSseFailures.length).toBe(1);
    other.off('requestfailed', onClosedSseFailure);
    expect(closedSseFailures).toEqual([
      { method: 'GET', path: '/api/v1/events', error: 'net::ERR_ABORTED' },
    ]);
    await applySettings(page, 1);
    const first = await settingsSnapshot(page);
    expect(first.sections.appearance.theme.effectiveValue).toBe('light');

    const staleResponses: Array<{
      readonly method: string;
      readonly path: string;
      readonly status: number;
    }> = [];
    const onResponse = (response: import('@playwright/test').Response) => {
      if (
        response.request().method() === 'PATCH' &&
        new URL(response.url()).pathname === '/api/v1/settings'
      ) {
        staleResponses.push({
          method: response.request().method(),
          path: new URL(response.url()).pathname,
          status: response.status(),
        });
      }
    };
    other.on('response', onResponse);
    evidence.expectConsoleErrorOnce(
      'Failed to load resource: the server responded with a status of 409 (Conflict)'
    );
    await workbenchUi(other)
      .settingsDialog.getByRole('button', { name: '应用 1 项', exact: true })
      .click();
    const conflict = workbenchUi(other).settingsDialog.getByRole('alert').filter({
      hasText: 'Host 设置已在其他位置更新',
    });
    await expect(conflict).toBeVisible({ timeout: 30_000 });
    other.off('response', onResponse);
    expect(staleResponses).toContainEqual({
      method: 'PATCH',
      path: '/api/v1/settings',
      status: 409,
    });
    await expect(
      workbenchUi(other).settingsDialog.getByRole('combobox', { name: '主题' })
    ).toHaveValue('dark');
    await expect(conflict.getByLabel('服务器值与我的草稿')).toContainText('light');
    expect(workspace.readConfig().web?.appearance?.theme).toBe('light');

    await conflict.getByRole('button', { name: '基于最新值重试', exact: true }).click();
    await expect(conflict).toBeHidden();
    await applySettings(other, 1);
    const final = await settingsSnapshot(other);
    expect(final.sections.appearance.theme.effectiveValue).toBe('dark');
    expect(final.revision).not.toBe(first.revision);
    await captureSettingsDialog(other, evidence, 'set-p0-06');

    evidence.recordFact('conflict.closed_event_sources', closedEventSources);
    evidence.recordFact('conflict.stale_patch_method', 'PATCH');
    evidence.recordFact('conflict.stale_patch_endpoint', '/api/v1/settings');
    evidence.recordFact('conflict.stale_patch_status', 409);
    recordSettingsEvidence(evidence, leftBase.revision, final.revision);
  } finally {
    detach();
    await otherContext.close();
  }
});

test('SET-P0-07 a dirty draft coexists with a valid external edit until explicit rebase @settings', async ({
  evidence,
  page,
  workspace,
}) => {
  const before = await settingsSnapshot(page);
  await openSettings(page);
  await setSettingsSelect(page, '主题', 'dark');

  const current = workspace.readConfig();
  workspace.writeConfig({
    ...current,
    web: {
      ...current.web,
      appearance: { ...current.web?.appearance, motion: 'reduced' },
    },
  });
  const external = await waitForSettings(
    page,
    value =>
      value.revision !== before.revision &&
      value.sections.appearance.motion.effectiveValue === 'reduced'
  );
  const dialog = workbenchUi(page).settingsDialog;
  const conflict = dialog.getByRole('alert').filter({
    hasText: 'Host 设置已在其他位置更新',
  });
  await expect(conflict).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByRole('combobox', { name: '主题' })).toHaveValue('dark');
  await conflict.getByRole('button', { name: '基于最新值重试', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: '主题' })).toHaveValue('dark');
  await expect(dialog.getByRole('combobox', { name: '动效' })).toHaveValue('reduced');
  await applySettings(page, 1);

  const final = workspace.readConfig();
  expect(final.web?.appearance).toMatchObject({ theme: 'dark', motion: 'reduced' });
  const invalidations = settingsInvalidations(await capturedSseEvents(page));
  expect(invalidations.some(value => value.payload.reason === 'external-edit')).toBe(true);
  await captureSettingsDialog(page, evidence, 'set-p0-07');
  evidence.recordFact('external.valid_invalidation', true);
  evidence.recordFact('external.draft_preserved', true);
  recordSettingsEvidence(evidence, before.revision, external.revision);
});

test('SET-P0-08 invalid external JSON keeps Runtime last-good and cannot be overwritten @settings', async ({
  evidence,
  host,
  page,
  provider,
  workspace,
}, testInfo) => {
  allowExpectedNetworkFailures(testInfo, 1);
  const networkFailures: Array<{
    readonly method: string;
    readonly path: string;
    readonly error: string;
  }> = [];
  const onNetworkFailure = (request: Request) => {
    networkFailures.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      error: request.failure()?.errorText ?? '',
    });
  };
  page.on('requestfailed', onNetworkFailure);
  await createSession(page, { name: 'Last-good runtime session' });
  const before = await settingsSnapshot(page);
  const originalBytes = workspace.readConfigBytes();
  const leakMarker = 'settings-invalid-secret-marker-93c417';
  const invalidBytes = Buffer.from(`{"apiKey":"${leakMarker}"`, 'utf8');
  evidence.addSecretValue(leakMarker);

  await openSettings(page);
  try {
    workspace.writeRawConfig(invalidBytes);
    const invalid = await waitForSettings(page, value => value.state === 'invalid');
    expect(invalid.revision).not.toBe(before.revision);
    expect(invalid.sections.defaults.model.effectiveValue).toBe(
      before.sections.defaults.model.effectiveValue
    );
    expect(JSON.stringify(invalid)).not.toContain(leakMarker);
    const invalidAlert = workbenchUi(page).settingsDialog.getByRole('alert').filter({
      hasText: '设置文档无效',
    });
    await expect(invalidAlert).toBeVisible({ timeout: 30_000 });
    await expect(
      workbenchUi(page).settingsDialog.getByRole('combobox', { name: '主题' })
    ).toBeDisabled();

    const rejected = await hostJson<WebSettingsMutationResultV1>(
      host.url,
      (await hostBootstrap(host.url)).nonce,
      '/api/v1/settings',
      'PATCH',
      {
        requestId: randomUUID(),
        expectedRevision: before.revision,
        operations: [{ op: 'set', key: 'appearance.theme', value: 'dark' }],
      }
    );
    expect(rejected.status).toBe(503);
    expect(problemCode(rejected.body)).toBe('settings_document_invalid');
    expect(workspace.readConfigBytes()).toEqual(invalidBytes);
    await captureSettingsDialog(page, evidence, 'set-p0-08');
    await closeSettings(page);

    const request = runSettingsProbe(page, provider);
    await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.settingsProbeDone)).toBeVisible({
      timeout: 45_000,
    });
    expect((await request).model).toBe(before.sections.defaults.model.effectiveValue);
    expect(workspace.readConfigBytes()).toEqual(invalidBytes);
    evidence.recordFact('invalid.runtime_last_good', true);
    evidence.recordFact('invalid.rejected_status', rejected.status);
    evidence.recordFact('invalid.bytes_preserved', true);
  } finally {
    workspace.writeRawConfig(originalBytes);
    await waitForSettings(page, value => value.state === 'ready');
    page.off('requestfailed', onNetworkFailure);
  }
  expect(networkFailures).toEqual([
    { method: 'GET', path: '/api/v1/events', error: 'net::ERR_ABORTED' },
  ]);
});

test('SET-P0-09 disconnect after commit and exact requestId retry replays one settings side effect @settings', async ({
  evidence,
  host,
  page,
  workspace,
}) => {
  const before = await settingsSnapshot(page);
  const nonce = (await hostBootstrap(host.url)).nonce;
  const requestId = randomUUID();
  const body = {
    requestId,
    expectedRevision: before.revision,
    operations: [{ op: 'set', key: 'appearance.theme', value: 'dark' }],
  } as const;

  const ambiguousStatus = await disconnectAfterResponseHeaders(
    host.url,
    nonce,
    '/api/v1/settings',
    'PATCH',
    body
  );
  expect(ambiguousStatus).toBe(200);
  const committed = await waitForHostSettings(
    host.url,
    value => value.revision !== before.revision
  );
  const committedHash = digest(workspace.readConfigBytes());

  const retry = await hostJson<WebSettingsMutationResultV1>(
    host.url,
    nonce,
    '/api/v1/settings',
    'PATCH',
    body
  );
  const exactRetry = await hostJson<WebSettingsMutationResultV1>(
    host.url,
    nonce,
    '/api/v1/settings',
    'PATCH',
    body
  );
  expect(retry.status).toBe(200);
  expect(exactRetry).toEqual(retry);
  expect(retry.body.settings.revision).toBe(committed.revision);
  expect(digest(workspace.readConfigBytes())).toBe(committedHash);

  await expect
    .poll(
      async () =>
        settingsInvalidations(await capturedSseEvents(page)).filter(
          value => value.payload.revision === committed.revision
        ).length,
      { timeout: 30_000 }
    )
    .toBe(1);
  await openSettings(page);
  await captureSettingsDialog(page, evidence, 'set-p0-09');
  evidence.recordFact('idempotency.request_digest', digest(requestId));
  evidence.recordFact('idempotency.ambiguous_status', ambiguousStatus);
  evidence.recordFact('idempotency.exact_replay', true);
  evidence.recordFact('idempotency.side_effects', 1);
  recordSettingsEvidence(evidence, before.revision, committed.revision);
});

test('SET-P0-10 an old page recovers a same-origin Host restart before saving with the new nonce @settings', async ({
  artifactState,
  evidence,
  host,
  page,
  workspace,
}, testInfo) => {
  allowExpectedNetworkFailures(testInfo, 10);
  await createSession(page, { name: 'Same-origin recovery session' });
  const oldBootstrap = await webBootstrap(page);
  const first = await updateSettings(page, oldBootstrap.settings.revision, [
    { op: 'set', key: 'appearance.theme', value: 'dark' },
  ]);
  expect(first.status).toBe(200);
  const second = await updateSettings(page, first.body.settings.revision, [
    { op: 'set', key: 'appearance.motion', value: 'reduced' },
  ]);
  expect(second.status).toBe(200);
  await expect
    .poll(async () => settingsInvalidations(await capturedSseEvents(page)).length, {
      timeout: 30_000,
    })
    .toBeGreaterThanOrEqual(2);

  await host.stop();
  const restarted = await startOrionHost({
    state: artifactState,
    workspace: workspace.primaryWorkspace,
    configRoot: workspace.configDirectory,
    environment: workspace.environment,
    evidence,
    port: host.port,
  });
  try {
    expect(restarted.url).toBe(host.url);
    const recover = page.getByRole('button', { name: '恢复', exact: true });
    await expect(recover).toBeVisible({ timeout: 45_000 });
    const restartedBootstrap = await hostBootstrap(restarted.url);
    expect(restartedBootstrap.nonce).not.toBe(oldBootstrap.nonce);
    expect(restartedBootstrap.settings.revision).toBe(second.body.settings.revision);

    const staleNonce = await rawRequest(restarted.url, {
      method: 'PATCH',
      path: '/api/v1/settings',
      origin: restarted.url,
      nonce: oldBootstrap.nonce,
      body: JSON.stringify({
        requestId: randomUUID(),
        expectedRevision: restartedBootstrap.settings.revision,
        operations: [{ op: 'set', key: 'appearance.theme', value: 'light' }],
      }),
    });
    expect(staleNonce.status).toBe(403);

    await recover.click();
    await waitForWorkbenchReady(page, { timeout: 30_000 });
    await expect(page.getByText('实时连接已恢复', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    expect((await webBootstrap(page)).nonce).toBe(restartedBootstrap.nonce);
    await openSettings(page);
    await setSettingsSelect(page, '主题', 'light');
    await applySettings(page, 1);
    const saved = await settingsSnapshot(page);
    expect(saved.sections.appearance.theme.effectiveValue).toBe('light');
    await captureSettingsDialog(page, evidence, 'set-p0-10');
    evidence.recordFact('restart.same_origin', true);
    evidence.recordFact('restart.nonce_rotated', true);
    evidence.recordFact('restart.old_nonce_status', staleNonce.status);
    recordSettingsEvidence(evidence, second.body.settings.revision, saved.revision);
  } finally {
    await restarted.stop();
  }
});

test('SET-P0-11 settings mutations and open-document fail closed except the legal pathless action @settings', async ({
  evidence,
  host,
  page,
}) => {
  const bootstrap = await hostBootstrap(host.url);
  const body = JSON.stringify({
    requestId: randomUUID(),
    expectedRevision: bootstrap.settings.revision,
    operations: [{ op: 'set', key: 'appearance.theme', value: 'dark' }],
  });
  const hostile = await rawRequest(host.url, {
    method: 'PATCH',
    path: '/api/v1/settings',
    origin: 'http://evil.invalid',
    nonce: bootstrap.nonce,
    body,
  });
  const missingNonce = await rawRequest(host.url, {
    method: 'PATCH',
    path: '/api/v1/settings',
    origin: host.url,
    body,
  });
  const wrongType = await rawRequest(host.url, {
    method: 'PATCH',
    path: '/api/v1/settings',
    origin: host.url,
    nonce: bootstrap.nonce,
    contentType: 'text/plain',
    body,
  });
  const arbitraryPath = await rawRequest(host.url, {
    method: 'POST',
    path: '/api/v1/settings/open-document',
    origin: host.url,
    nonce: bootstrap.nonce,
    body: JSON.stringify({ requestId: randomUUID(), path: '/tmp/not-authorized' }),
  });
  const arbitraryRoute = await rawRequest(host.url, {
    method: 'POST',
    path: '/api/v1/settings/open-document/not-authorized',
    origin: host.url,
    nonce: bootstrap.nonce,
    body: JSON.stringify({ requestId: randomUUID() }),
  });
  expect(hostile.status).toBe(403);
  expect(missingNonce.status).toBe(403);
  expect(wrongType.status).toBe(415);
  expect(arbitraryPath.status).toBe(400);
  expect(arbitraryRoute.status).toBe(404);

  const pathless = await rawRequest(host.url, {
    method: 'POST',
    path: '/api/v1/settings/open-document',
    origin: host.url,
    nonce: bootstrap.nonce,
    body: JSON.stringify({ requestId: randomUUID() }),
  });
  expect(pathless.status).toBe(200);
  expect(JSON.parse(pathless.body)).toMatchObject({ opened: true });

  await openSettings(page);
  await selectSettingsSection(page, 'Advanced');
  await captureSettingsDialog(page, evidence, 'set-p0-11');
  evidence.recordFact('security.hostile_origin', hostile.status);
  evidence.recordFact('security.missing_nonce', missingNonce.status);
  evidence.recordFact('security.wrong_content_type', wrongType.status);
  evidence.recordFact('security.arbitrary_path', arbitraryPath.status);
  evidence.recordFact('security.pathless_open', pathless.status);
});

test('SET-P0-12 persisted Settings evidence is free of secrets, headers, env names, and config paths @settings', async ({
  artifactState,
  evidence,
  host,
  page,
  workspace,
}) => {
  const before = await settingsSnapshot(page);
  await openSettings(page);
  await setSettingsSelect(page, '主题', 'dark');
  await applySettings(page, 1);
  const after = await settingsSnapshot(page);
  const problem = await rawRequest(host.url, {
    method: 'PATCH',
    path: '/api/v1/settings',
    origin: host.url,
    nonce: (await hostBootstrap(host.url)).nonce,
    body: JSON.stringify({ requestId: randomUUID(), expectedRevision: after.revision }),
  });
  expect(problem.status).toBe(400);

  const captures = await Promise.all([
    rawRequest(host.url, { path: '/api/v1/bootstrap' }),
    rawRequest(host.url, { path: '/api/v1/settings' }),
    rawRequest(host.url, { path: '/api/v1/diagnostics' }),
  ]);
  const liveMaterial = [
    ...captures.flatMap(value => [value.body, JSON.stringify(value.headers)]),
    problem.body,
    JSON.stringify(await capturedSseEvents(page)),
  ].join('\n');
  const denylist = [
    workspace.environment.ORION_CODE_API_KEY,
    'ORION_CODE_API_KEY',
    workspace.configPath,
    workspace.configDirectory,
    'Authorization:',
    'Bearer ',
    '"apiKey"',
    '"credentialValue"',
  ];
  for (const forbidden of denylist) expect(liveMaterial).not.toContain(forbidden);

  await captureSettingsDialog(page, evidence, 'set-p0-12');
  const persistedFiles = collectFiles(join(artifactState.rawRoot, 'scenarios'));
  const persistedMaterial = persistedFiles.map(path => readFileSync(path));
  expect(
    persistedFiles.filter(path => basename(path) === 'manifest.json').length
  ).toBeGreaterThanOrEqual(11);
  expect(persistedFiles.filter(path => path.endsWith('.png')).length).toBeGreaterThanOrEqual(12);
  expect(persistedFiles.some(path => path.endsWith('.zip') || path.endsWith('.webm'))).toBe(false);
  for (const forbidden of denylist) {
    const needle = Buffer.from(forbidden, 'utf8');
    expect(persistedMaterial.some(value => value.includes(needle))).toBe(false);
  }
  expect(evidence.snapshotCounters().secretFindings).toBe(0);
  evidence.recordFact('privacy.persisted_files_scanned', persistedFiles.length);
  evidence.recordFact('privacy.secret_findings', 0);
  evidence.recordFact('privacy.raw_trace_disabled', true);
  recordSettingsEvidence(evidence, before.revision, after.revision);
});

test('SET-P0-13 Settings reflows at desktop, 390, 320, and 200 percent with keyboard and axe @settings', async ({
  browser,
  evidence,
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await workbenchUi(page).settingsButton.focus();
  await workbenchUi(page).settingsButton.press('Enter');
  await expect(workbenchUi(page).settingsDialog).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await captureSettingsDialog(page, evidence, 'set-p0-13-desktop');
  await page.keyboard.press('Escape');
  await expect(workbenchUi(page).settingsDialog).toBeHidden();
  await expect(workbenchUi(page).settingsButton).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await workbenchUi(page).settingsButton.focus();
  await workbenchUi(page).settingsButton.press('Enter');
  await selectSettingsSection(page, 'Advanced');
  await assertNoHorizontalOverflow(page);
  await captureSettingsDialog(page, evidence, 'set-p0-13-390');
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 320, height: 720 });
  await workbenchUi(page).settingsButton.focus();
  await workbenchUi(page).settingsButton.press('Enter');
  await selectSettingsSection(page, 'Permissions');
  await setSettingsPermission(page, 'Deny');
  await page.keyboard.press('Escape');
  const discard = page.getByRole('alertdialog', { name: '放弃未应用的更改？' });
  await expect(discard).toBeVisible();
  await expect(discard.getByRole('button', { name: '继续编辑', exact: true })).toBeFocused();
  await discard.getByRole('button', { name: '继续编辑', exact: true }).click();
  await assertNoHorizontalOverflow(page);
  await captureSettingsDialog(page, evidence, 'set-p0-13-320');
  await discardSettingsDraft(page);
  await expect(workbenchUi(page).settingsButton).toBeFocused();

  await page.setViewportSize({ width: 640, height: 900 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 320,
    height: 450,
    deviceScaleFactor: 2,
    mobile: false,
    screenWidth: 640,
    screenHeight: 900,
  });
  try {
    const zoom = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      visualWidth: window.visualViewport?.width ?? window.innerWidth,
      devicePixelRatio: window.devicePixelRatio,
    }));
    expect(zoom.innerWidth).toBeLessThanOrEqual(321);
    expect(zoom.visualWidth).toBeLessThanOrEqual(321);
    expect(zoom.devicePixelRatio).toBe(2);
    const zoomHitTest = await workbenchUi(page).settingsButton.evaluate(button => {
      const rect = (element: Element | null) => {
        if (!element) return null;
        const bounds = element.getBoundingClientRect();
        return {
          x: Math.round(bounds.x * 100) / 100,
          y: Math.round(bounds.y * 100) / 100,
          width: Math.round(bounds.width * 100) / 100,
          height: Math.round(bounds.height * 100) / 100,
          right: Math.round(bounds.right * 100) / 100,
          bottom: Math.round(bounds.bottom * 100) / 100,
        };
      };
      const buttonBounds = button.getBoundingClientRect();
      const hit = document.elementFromPoint(
        buttonBounds.left + buttonBounds.width / 2,
        buttonBounds.top + buttonBounds.height / 2
      );
      return {
        button: rect(button),
        titleLine: rect(document.querySelector('.title-line')),
        headerActions: rect(button.closest('.header-actions')),
        hit: hit
          ? {
              tag: hit.tagName.toLowerCase(),
              className: typeof hit.className === 'string' ? hit.className : '',
              ariaLabel: hit.getAttribute('aria-label'),
            }
          : null,
        buttonContainsHit: hit ? button.contains(hit) : false,
      };
    });
    evidence.recordFact('a11y.zoom_hit_test', JSON.stringify(zoomHitTest));
    evidence.recordFact('a11y.zoom_method', 'viewport-equivalent-320-css-dpr2');
    expect(zoomHitTest.buttonContainsHit, JSON.stringify(zoomHitTest)).toBe(true);
    await openSettings(page);
    await assertNoHorizontalOverflow(page);
    await captureSettingsDialog(page, evidence, 'set-p0-13-zoom200');
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
  }

  const blocking = await runSettingsAxeAudit(browser, page.url(), evidence);
  expect(blocking).toEqual([]);
  evidence.recordFact('a11y.blocking_violations', blocking.length);
  evidence.recordFact('a11y.desktop', true);
  evidence.recordFact('a11y.mobile_390', true);
  evidence.recordFact('a11y.mobile_320', true);
  evidence.recordFact('a11y.zoom_200', true);
  evidence.recordFact('a11y.keyboard_escape', true);
});

test('SET-P0-14 installed tarball critical Settings journey runs on the supported Node matrix @settings', async ({
  artifactState,
  evidence,
  page,
  provider,
}, testInfo) => {
  allowExpectedNetworkFailures(testInfo, 2);
  expect(artifactState.artifact.receipt.package).toMatchObject({
    name: '@orion-agents/orion-code',
    version: '0.3.1',
  });
  expect(artifactState.environment.nodeMajor).toBe(Number(process.versions.node.split('.')[0]));
  expect([22, 24, 26]).toContain(artifactState.environment.nodeMajor);
  expect(artifactState.artifact.receipt.tarball.sha256).toMatch(HEX_DIGEST);

  await createSession(page, { name: 'Packaged Settings matrix session' });
  await openSettings(page);
  await setSettingsSelect(page, '主题', 'dark');
  await selectSettingsSection(page, 'Models & Reasoning');
  await setSettingsSelect(page, '默认推理强度', 'low');
  await applySettings(page, 2);
  await closeSettings(page);
  const request = await runSettingsProbe(page, provider);
  expect(request.reasoningEffort).toBe('low');
  await openSettings(page);
  await selectSettingsSection(page, 'Models & Reasoning');
  await captureSettingsDialog(page, evidence, 'set-p0-14');

  evidence.recordFact('matrix.node_major', artifactState.environment.nodeMajor);
  evidence.recordFact('matrix.tarball_sha256', artifactState.artifact.receipt.tarball.sha256);
  evidence.recordFact('matrix.installed_target_digest', artifactState.installation.targetDigest);
  evidence.recordFact('matrix.provider_effort', request.reasoningEffort ?? 'missing');
});

function orionMessage(page: Page, marker: string) {
  return page.getByRole('article', { name: 'Orion' }).filter({ hasText: marker }).last();
}

async function closeSettings(page: Page): Promise<void> {
  const ui = workbenchUi(page);
  await ui.settingsDialog.getByRole('button', { name: '关闭设置' }).click();
  await expect(ui.settingsDialog).toBeHidden();
}

async function waitForIdle(page: Page): Promise<void> {
  await expect
    .poll(async () => (await activeSessionSnapshot(page)).runtime.processing, {
      timeout: 60_000,
    })
    .toBe(false);
}

async function waitForSettings(
  page: Page,
  predicate: (value: WebSettingsDocumentV1) => boolean
): Promise<WebSettingsDocumentV1> {
  await expect
    .poll(async () => predicate(await settingsSnapshot(page)), { timeout: 30_000 })
    .toBe(true);
  return settingsSnapshot(page);
}

async function waitForHostSettings(
  hostUrl: string,
  predicate: (value: WebSettingsDocumentV1) => boolean
): Promise<WebSettingsDocumentV1> {
  await expect
    .poll(async () => predicate(await hostSettingsSnapshot(hostUrl)), { timeout: 30_000 })
    .toBe(true);
  return hostSettingsSnapshot(hostUrl);
}

async function runSettingsProbe(
  page: Page,
  provider: import('./fixtures/openai-provider').OpenAiProviderFixture
): Promise<import('./fixtures/openai-provider').OpenAiFixtureRequest> {
  const sequence = provider.requests.length;
  await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.settingsProbe);
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.settingsProbeDone)).toBeVisible({
    timeout: 45_000,
  });
  await waitForIdle(page);
  return provider.waitForRequest(
    value => value.sequence > sequence && value.scenario === 'settings-probe'
  );
}

async function switchWorkspace(page: Page, path: string): Promise<void> {
  const ui = workbenchUi(page);
  await ui.workspaceRail.getByRole('button', { name: '选择其他工作区' }).click();
  await expect(ui.workspaceDialog).toBeVisible();
  await ui.workspaceDialog.getByRole('textbox', { name: '打开其他本地目录' }).fill(path);
  await ui.workspaceDialog.getByRole('button', { name: '打开', exact: true }).click();
  await expect(ui.workspaceDialog).toBeHidden({ timeout: 30_000 });
  await expect
    .poll(async () => realpathSync((await webBootstrap(page)).workspace), { timeout: 30_000 })
    .toBe(realpathSync(path));
}

async function captureSettingsDialog(
  page: Page,
  evidence: WebE2EEvidenceCollector,
  label: string
): Promise<void> {
  const dialog = workbenchUi(page).settingsDialog;
  if (!(await dialog.isVisible())) await openSettings(page);
  const filename = `${label}.settings.png`;
  await dialog.screenshot({
    path: join(evidence.scenarioDirectory, filename),
    animations: 'disabled',
  });
  evidence.recordFact(`screenshot.${label.replace(/^set-p0-/u, '')}`, filename);
  evidence.recordFact('privacy.trace_disabled', true);
  evidence.recordFact('privacy.video_disabled', true);
  evidence.recordFact('privacy.auto_screenshot_disabled', true);
}

function recordSettingsEvidence(
  evidence: WebE2EEvidenceCollector,
  before: string,
  after: string
): void {
  evidence.recordFact('settings.revision_before_digest', digest(before));
  evidence.recordFact('settings.revision_after_digest', digest(after));
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

interface SettingsInvalidationEnvelope {
  readonly eventId: string;
  readonly cursor: number;
  readonly payload: {
    readonly revision: string;
    readonly reason: 'local-write' | 'external-edit' | 'workspace-change';
    readonly state: 'ready' | 'invalid';
  };
}

function settingsInvalidations(events: readonly unknown[]): SettingsInvalidationEnvelope[] {
  return events.filter((value): value is SettingsInvalidationEnvelope => {
    if (!isRecord(value) || value.type !== 'settings_invalidated' || !isRecord(value.payload)) {
      return false;
    }
    return (
      typeof value.eventId === 'string' &&
      Number.isSafeInteger(value.cursor) &&
      typeof value.payload.revision === 'string' &&
      typeof value.payload.reason === 'string'
    );
  });
}

interface ProjectedDurableToolReceipt {
  readonly callId: string;
  readonly name: string;
  readonly executionPolicyDigest: string;
  readonly receiptDigest: string;
}

function durableToolReceipts(events: readonly unknown[]): ProjectedDurableToolReceipt[] {
  const receipts = new Map<string, ProjectedDurableToolReceipt>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;
    if (
      typeof value.callId === 'string' &&
      typeof value.name === 'string' &&
      typeof value.executionPolicyDigest === 'string' &&
      typeof value.receiptDigest === 'string'
    ) {
      receipts.set(value.receiptDigest, {
        callId: value.callId,
        name: value.name,
        executionPolicyDigest: value.executionPolicyDigest,
        receiptDigest: value.receiptDigest,
      });
    }
    Object.values(value).forEach(visit);
  };
  events.forEach(visit);
  return [...receipts.values()];
}

async function waitForDurableReceipts(
  page: Page,
  minimum: number
): Promise<ProjectedDurableToolReceipt[]> {
  await expect
    .poll(async () => durableToolReceipts(await capturedSseEvents(page)).length, {
      timeout: 60_000,
    })
    .toBeGreaterThanOrEqual(minimum);
  return durableToolReceipts(await capturedSseEvents(page));
}

function loadDurableToolReceipts(
  configDirectory: string,
  sessionId: string,
  expectedThreadId: string
): ReadonlyMap<string, ToolInvocationReceiptV1> {
  const indexPaths = collectFiles(configDirectory).filter(
    path => basename(path) === 'index.v1.json'
  );
  const selected = indexPaths
    .map(path => ({ path, value: JSON.parse(readFileSync(path, 'utf8')) as unknown }))
    .find(candidate => {
      if (!isRecord(candidate.value) || !isRecord(candidate.value.sessions)) return false;
      return isRecord(candidate.value.sessions[sessionId]);
    });
  expect(selected, 'missing session to Thread cutover index').toBeDefined();
  const index = selected!.value as {
    readonly version: number;
    readonly sessions: Record<string, { readonly threadId: string; readonly eventLogFile: string }>;
    readonly digest: string;
  };
  const { digest: indexDigest, ...indexContent } = index;
  expect(index.version).toBe(1);
  expect(digestRuntimeValue(indexContent)).toBe(indexDigest);
  const entry = index.sessions[sessionId];
  expect(entry.threadId).toBe(expectedThreadId);
  const eventLog = join(dirname(selected!.path), entry.eventLogFile);
  expect(existsSync(eventLog)).toBe(true);

  const records = readFileSync(eventLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as unknown);
  const facts = new Map<string, Record<string, unknown>>();
  const terminalEvents: Array<Record<string, unknown>> = [];
  let previousHash: string | null = null;
  for (const raw of records) {
    expect(isRecord(raw)).toBe(true);
    const record = raw as Record<string, unknown>;
    expect(record.previousHash).toBe(previousHash);
    expect(record.hash).toBe(
      digestRuntimeValue({
        version: record.version,
        previousHash: record.previousHash,
        event: record.event,
      })
    );
    previousHash = String(record.hash);
    const event = record.event;
    if (!isRecord(event) || !isRecord(event.payload)) continue;
    if (event.payload.type === 'tool.receipt' && isRecord(event.payload.data)) {
      facts.set(String(event.itemId), event.payload.data);
    }
    if (
      ['item.completed', 'item.failed', 'item.interrupted', 'item.indeterminate'].includes(
        String(event.payload.type)
      ) &&
      isRecord(event.payload.data) &&
      typeof event.payload.data.receipt === 'string'
    ) {
      terminalEvents.push(event);
    }
  }

  const result = new Map<string, ToolInvocationReceiptV1>();
  for (const event of terminalEvents) {
    const payload = event.payload as Record<string, unknown>;
    const data = payload.data as Record<string, unknown>;
    const receipt = JSON.parse(String(data.receipt)) as ToolInvocationReceiptV1;
    const { digest: receiptDigest, ...receiptContent } = receipt;
    expect(digestRuntimeValue(receiptContent)).toBe(receiptDigest);
    expect(receipt.threadId).toBe(expectedThreadId);
    expect(receipt.invocationId).toBe(event.itemId);
    expect(receipt.turnId).toBe(event.turnId);
    expect(receipt.stepId).toBe(event.stepId);
    const fact = facts.get(receipt.invocationId);
    expect(fact, `missing tool.receipt fact for ${receipt.invocationId}`).toBeDefined();
    expect(fact!.receiptDigest).toBe(receipt.digest);
    expect(fact!.invocationId).toBe(receipt.invocationId);
    expect(fact!.terminal).toBe(receipt.terminal);
    expect(fact!.success).toBe(receipt.success);
    expect(fact!.outputDigest).toBe(receipt.outputDigest);
    expect(fact!.intentDigest).toBe(receipt.intentDigest);
    result.set(receipt.invocationId, receipt);
  }
  return result;
}

async function hostBootstrap(hostUrl: string): Promise<Awaited<ReturnType<typeof webBootstrap>>> {
  const response = await fetch(`${hostUrl}/api/v1/bootstrap`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Host bootstrap failed with HTTP ${response.status}.`);
  return response.json() as ReturnType<typeof webBootstrap>;
}

async function hostSettingsSnapshot(hostUrl: string): Promise<WebSettingsDocumentV1> {
  const response = await fetch(`${hostUrl}/api/v1/settings`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Host settings failed with HTTP ${response.status}.`);
  return response.json() as Promise<WebSettingsDocumentV1>;
}

async function waitForStartupCatalog(page: Page): Promise<void> {
  const pending = new Set([
    '/api/v1/diagnostics',
    '/api/v1/skills',
    '/api/v1/mcp',
    '/api/v1/tool-details',
  ]);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      page.off('response', onResponse);
      reject(new Error(`Startup catalog did not settle: ${[...pending].join(', ')}`));
    }, 30_000);
    const onResponse = (response: import('@playwright/test').Response) => {
      const request = response.request();
      if (request.method() !== 'GET' || response.status() >= 500) return;
      pending.delete(new URL(response.url()).pathname);
      if (pending.size > 0) return;
      clearTimeout(timeout);
      page.off('response', onResponse);
      resolve();
    };
    page.on('response', onResponse);
  });
}

async function hostJson<T>(
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

interface RawRequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH';
  readonly path: string;
  readonly origin?: string;
  readonly nonce?: string;
  readonly contentType?: string;
  readonly body?: string;
}

async function rawRequest(
  hostUrl: string,
  options: RawRequestOptions
): Promise<{
  readonly status: number;
  readonly body: string;
  readonly headers: import('http').IncomingHttpHeaders;
}> {
  const target = new URL(hostUrl);
  const body = options.body ?? '';
  const headers: Record<string, string | number> = { Accept: 'application/json' };
  if (options.origin) headers.Origin = options.origin;
  if (options.nonce) headers['x-orion-web-nonce'] = options.nonce;
  if (options.method === 'POST' || options.method === 'PATCH') {
    headers['Content-Type'] = options.contentType ?? 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body, 'utf8');
  }
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: Number(target.port),
        method: options.method ?? 'GET',
        path: options.path,
        headers,
      },
      response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.once('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: response.headers,
          })
        );
      }
    );
    request.once('error', reject);
    request.setTimeout(10_000, () => request.destroy(new Error('Host request timed out.')));
    if (body) request.write(body);
    request.end();
  });
}

async function disconnectAfterResponseHeaders(
  hostUrl: string,
  nonce: string,
  path: string,
  method: 'POST' | 'PATCH',
  body: unknown
): Promise<number> {
  const target = new URL(hostUrl);
  const encoded = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: Number(target.port),
        method,
        path,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(encoded, 'utf8'),
          Origin: hostUrl,
          'x-orion-web-nonce': nonce,
        },
      },
      response => {
        const status = response.statusCode ?? 0;
        response.destroy();
        request.destroy();
        resolve(status);
      }
    );
    request.once('error', error => {
      if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error);
    });
    request.setTimeout(10_000, () => request.destroy(new Error('Ambiguous save timed out.')));
    request.end(encoded);
  });
}

function problemCode(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.code === 'string' ? value.code : undefined;
}

function collectFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...collectFiles(path));
    else if (entry.isFile() && statSync(path).size <= 10 * 1024 * 1024) result.push(path);
  }
  return result;
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const dialog = document.querySelector<HTMLDialogElement>('#settings-dialog');
    return {
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      dialog: dialog ? dialog.scrollWidth - dialog.clientWidth : 0,
    };
  });
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.dialog).toBeLessThanOrEqual(1);
}

interface AxeViolation {
  readonly id: string;
  readonly impact: string | null;
  readonly help: string;
}

async function runSettingsAxeAudit(
  browser: Browser,
  url: string,
  evidence: WebE2EEvidenceCollector
): Promise<readonly AxeViolation[]> {
  const context = await browser.newContext({
    bypassCSP: true,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  await installSseCapture(page);
  const detach = evidence.attachPage(page);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitForWorkbenchReady(page, { timeout: 30_000 });
    await openSettings(page);
    await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
    const violations = await page.evaluate(async () => {
      const axe = (
        window as typeof window & {
          axe: {
            run(
              root: Document,
              options: Record<string, unknown>
            ): Promise<{ violations: AxeViolation[] }>;
          };
        }
      ).axe;
      return (
        await axe.run(document, {
          runOnly: {
            type: 'tag',
            values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'],
          },
        })
      ).violations;
    });
    return violations.filter(
      violation => violation.impact === 'critical' || violation.impact === 'serious'
    );
  } finally {
    detach();
    await context.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
