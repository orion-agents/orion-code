import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { basename, join } from 'path';

import type { Page, Request, TestInfo } from '@playwright/test';
import type {
  WebBootstrapV1,
  WebComposerActionResultV1,
  WebComposerControlStateV1,
} from '../../src/web/protocol';
import { activeSessionSnapshot, foregroundSessionId } from './fixtures/api';
import {
  OPENAI_FIXTURE_ALTERNATE_MODEL,
  OPENAI_FIXTURE_FILES,
  OPENAI_FIXTURE_MARKERS,
  OPENAI_FIXTURE_MODEL,
  OPENAI_FIXTURE_PROMPTS,
} from './fixtures/openai-provider';
import { allowExpectedNetworkFailures, capturedSseEvents, expect, test } from './fixtures/test';
import {
  answerApproval,
  createSession,
  setAgentMode,
  submitPrompt,
  waitForApproval,
  workbenchUi,
} from './fixtures/ui';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test('WEB32-P0-04 mode dropdown is immediate or deferred, confirms AUTO risk and stays independent', async ({
  evidence,
  page,
}, testInfo) => {
  const finishSseTransitionEvidence = observeSessionSseTransition(page);
  await createSession(page, { name: 'WEB32 modes' });
  const ui = workbenchUi(page);

  await ui.modeButton.click();
  const modeMenu = page.getByRole('menu', { name: '工作模式' });
  for (const mode of ['BUILD', 'PLAN', 'AUTO']) {
    await expect(
      modeMenu.getByRole('menuitemradio', { name: new RegExp(`^${mode}\\b`, 'u') })
    ).toBeVisible();
  }
  await page.keyboard.press('Escape');

  await setAgentMode(page, 'PLAN');
  expect((await activeSessionSnapshot(page)).composer.mode).toEqual({
    baseMode: 'plan',
    pendingBaseMode: null,
  });
  await setAgentMode(page, 'BUILD');

  await selectPermission(page, 'DENY');
  await selectAutoWithRiskConfirmation(page);
  const independent = await activeSessionSnapshot(page);
  expect(independent.composer.mode.baseMode).toBe('auto');
  expect(independent.composer.permission).toMatchObject({
    effective: 'deny',
    override: 'deny',
    source: 'session',
  });

  await setAgentMode(page, 'BUILD');
  await selectPermission(page, 'ASK');
  await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.pending);
  await waitForApproval(page, 'write_file', { timeout: 30_000 });
  await setAgentMode(page, 'PLAN');
  await expect(ui.modeButton).toContainText('BUILD → PLAN');
  const deferred = await activeSessionSnapshot(page);
  expect(deferred.composer.mode).toEqual({ baseMode: 'interactive', pendingBaseMode: 'plan' });
  expect(deferred.composer.permission.effective).toBe('ask');
  await answerApproval(page, 'reject', 'write_file');
  await waitForIdle(page);
  await expect(ui.modeButton).toContainText('PLAN');
  expect((await activeSessionSnapshot(page)).composer.mode).toEqual({
    baseMode: 'plan',
    pendingBaseMode: null,
  });

  await captureComposer(page, evidence, 'web32-p0-04-mode-menu.png', 'mode-menu');
  evidence.recordFact('web32.mode_options', 'build,plan,auto');
  evidence.recordFact('web32.mode_immediate_and_deferred', true);
  evidence.recordFact('web32.auto_risk_confirmation', true);
  evidence.recordFact('web32.mode_permission_independent', true);
  finishSseTransitionEvidence(testInfo);
});

test('WEB32-P0-05 Session permission dropdown reaches ToolGateway and explicit DENY survives AUTO', async ({
  evidence,
  page,
  workspace,
}, testInfo) => {
  const finishSseTransitionEvidence = observeSessionSseTransition(page);
  await createSession(page, { name: 'WEB32 permissions' });
  const ui = workbenchUi(page);
  await ui.permissionButton.click();
  const menu = page.getByRole('menu', { name: '会话权限' });
  for (const label of ['继承项目', 'ASK', 'ALLOW', 'DENY']) {
    await expect(
      menu.getByRole('menuitemradio', { name: new RegExp(`^${label}`, 'u') })
    ).toBeVisible();
  }
  await page.keyboard.press('Escape');

  const receiptBaseline = durableToolReceipts(await capturedSseEvents(page)).length;
  await selectPermission(page, 'ALLOW');
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
  const allowedReceipts = await waitForDurableReceipts(page, receiptBaseline + 2);
  for (const receipt of allowedReceipts.slice(receiptBaseline)) {
    expect(receipt.executionPolicyDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.receiptDigest).toMatch(/^[a-f0-9]{64}$/u);
  }

  await selectAutoWithRiskConfirmation(page);
  await selectPermission(page, 'DENY');
  const deniedState = await activeSessionSnapshot(page);
  expect(deniedState.composer.mode.baseMode).toBe('auto');
  expect(deniedState.composer.permission).toMatchObject({ effective: 'deny', override: 'deny' });
  await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.denyWrite);
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.denyWriteDone)).toBeVisible({
    timeout: 45_000,
  });
  await waitForIdle(page);
  expect(existsSync(workspace.primaryPath(OPENAI_FIXTURE_FILES.deniedWrite))).toBe(false);

  const authorizations = await page
    .getByRole('article', { name: /^工具 /u })
    .getByText(/(?:config_allow|tool_policy)/u)
    .allTextContents();
  expect(authorizations.some(value => value.includes('config_allow'))).toBe(true);
  expect(authorizations.some(value => value.includes('tool_policy'))).toBe(true);
  await waitForDurableReceipts(page, receiptBaseline + 3);

  await captureComposer(page, evidence, 'web32-p0-05-permission-menu.png', 'permission-menu');
  evidence.recordFact('web32.permission_options', 'default,ask,allow,deny');
  evidence.recordFact('web32.allow_risk_confirmation', true);
  evidence.recordFact('web32.tool_gateway_verified', true);
  evidence.recordFact('web32.explicit_deny_verified', true);
  evidence.recordFact('web32.authorization_provenance_verified', true);
  finishSseTransitionEvidence(testInfo);
});

test('WEB32-P0-06 model and effort selection performs real compact and rolls invalid metadata back', async ({
  evidence,
  host,
  page,
  provider,
}, testInfo) => {
  const finishSseTransitionEvidence = observeSessionSseTransition(page);
  await createSession(page, { name: 'WEB32 models' });
  const sessionId = await foregroundSessionId(page);
  const ui = workbenchUi(page);
  await ui.modelButton.click();
  const modelMenu = page.getByRole('menu', { name: '会话模型' });
  const modelEntries = modelMenu.getByRole('menuitemradio');
  await expect(modelEntries).toHaveCount(2);
  const metadata = await modelEntries.allTextContents();
  expect(metadata.some(value => value.includes('256k context'))).toBe(true);
  expect(metadata.some(value => value.includes('8k context'))).toBe(true);
  await page.keyboard.press('Escape');

  await selectEffort(page, 'HIGH');
  const largePrompt = `fixture:context-load ${'context-payload '.repeat(3_000)}`;
  await submitPrompt(page, largePrompt);
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.unknownScenario)).toBeVisible({
    timeout: 60_000,
  });
  await waitForIdle(page);

  const switchResponse = page.waitForResponse(response => {
    if (response.request().method() !== 'POST') return false;
    if (!new URL(response.url()).pathname.endsWith('/composer-actions')) return false;
    return response.request().postDataJSON()?.type === 'select_model';
  });
  await selectModel(page, OPENAI_FIXTURE_ALTERNATE_MODEL);
  const switched = (await (await switchResponse).json()) as WebComposerActionResultV1;
  expect(switched.modelReceipt).toMatchObject({
    fromModelId: OPENAI_FIXTURE_MODEL,
    toModelId: OPENAI_FIXTURE_ALTERNATE_MODEL,
    requestedEffort: 'high',
    compactRequired: true,
    compacted: true,
    compactPreflight: 'committed',
    appliesFrom: 'immediate',
  });
  expect(switched.state.model).toMatchObject({
    modelId: OPENAI_FIXTURE_ALTERNATE_MODEL,
    contextWindow: 8_000,
  });

  const requestSequence = provider.requests.length;
  await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.settingsProbe);
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.settingsProbeDone)).toBeVisible({
    timeout: 45_000,
  });
  const wired = await provider.waitForRequest(
    request => request.sequence > requestSequence && request.scenario === 'settings-probe'
  );
  expect(wired.model).toBe(OPENAI_FIXTURE_ALTERNATE_MODEL);
  expect(wired.reasoningEffort).toBe('high');
  await waitForIdle(page);

  const beforeRejected = await hostComposerState(host.url, sessionId);
  const rejected = await hostComposerAction(host.url, beforeRejected.bootstrap, sessionId, {
    ...controlGuard(beforeRejected.bootstrap, beforeRejected.state, sessionId),
    type: 'select_model',
    modelId: 'model-that-does-not-exist',
  });
  expect(rejected.status).toBe(422);
  expect(problemCode(rejected.body)).toBe('model_unavailable');
  const afterRejected = await hostComposerState(host.url, sessionId);
  expect(afterRejected.state.model.modelId).toBe(OPENAI_FIXTURE_ALTERNATE_MODEL);
  expect(afterRejected.state.controlRevision).toBe(beforeRejected.state.controlRevision);

  await captureComposer(page, evidence, 'web32-p0-06-model-effort.png', 'model-effort');
  evidence.recordFact('web32.model_catalog_entries', 2);
  evidence.recordFact('web32.model_effort_verified', true);
  evidence.recordFact('web32.real_compact_before_switch', true);
  evidence.recordFact('web32.model_switch_rollback_verified', true);
  evidence.recordFact('web32.model_metadata_verified', true);
  finishSseTransitionEvidence(testInfo);
});

test('WEB32-P0-07 Context meter distinguishes provider and estimated usage and supports manual compact', async ({
  evidence,
  page,
}, testInfo) => {
  const finishSseTransitionEvidence = observeSessionSseTransition(page);
  await createSession(page, { name: 'WEB32 estimated context meter' });
  const largePrompt = `${OPENAI_FIXTURE_PROMPTS.estimatedUsage} ${'manual-context '.repeat(3_000)}`;
  await submitPrompt(page, largePrompt);
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.estimatedUsageDone)).toBeVisible({
    timeout: 60_000,
  });
  await waitForIdle(page);
  expect((await activeSessionSnapshot(page)).composer.contextUsage).toMatchObject({
    source: 'estimated',
    modelId: OPENAI_FIXTURE_MODEL,
  });

  const ui = workbenchUi(page);
  await ui.contextButton.click();
  const details = page.getByRole('dialog', { name: 'Context 用量详情' });
  await expect(details).toContainText('警告阈值');
  await expect(details).toContainText('自动压缩');
  await expect(details).toContainText('估算 ~');
  const compactResponse = page.waitForResponse(response => {
    if (response.request().method() !== 'POST') return false;
    if (!new URL(response.url()).pathname.endsWith('/composer-actions')) return false;
    return response.request().postDataJSON()?.type === 'compact_context';
  });
  await details.getByRole('button', { name: '立即压缩' }).click();
  const compacted = (await (await compactResponse).json()) as WebComposerActionResultV1;
  expect(compacted.outcome).toBe('applied');
  expect(compacted.state.contextUsage).toMatchObject({ source: 'estimated' });

  await selectModel(page, OPENAI_FIXTURE_ALTERNATE_MODEL);
  const switched = await activeSessionSnapshot(page);
  expect(switched.composer.model.contextWindow).toBe(8_000);
  expect(
    switched.composer.contextUsage === null ||
      switched.composer.contextUsage.modelId === OPENAI_FIXTURE_ALTERNATE_MODEL
  ).toBe(true);

  await captureComposer(page, evidence, 'web32-p0-07-context-meter.png', 'context-meter');

  await createSession(page, { name: 'WEB32 provider context meter' });
  await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.settingsProbe);
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.settingsProbeDone)).toBeVisible({
    timeout: 45_000,
  });
  await waitForIdle(page);
  const providerUsage = (await activeSessionSnapshot(page)).composer.contextUsage;
  expect(providerUsage).toMatchObject({ modelId: OPENAI_FIXTURE_MODEL });
  expect(providerUsage?.source.startsWith('provider')).toBe(true);

  evidence.recordFact('web32.context_sources', 'provider,estimated');
  evidence.recordFact('web32.context_thresholds_verified', true);
  evidence.recordFact('web32.model_capacity_reset', true);
  evidence.recordFact('web32.manual_compact_verified', true);
  finishSseTransitionEvidence(testInfo);
});

async function selectPermission(
  page: import('@playwright/test').Page,
  value: 'INHERIT' | 'ASK' | 'ALLOW' | 'DENY'
): Promise<void> {
  const trigger = workbenchUi(page).permissionButton;
  await trigger.click();
  const label = value === 'INHERIT' ? '继承项目' : value;
  const option = page
    .getByRole('menu', { name: '会话权限' })
    .getByRole('menuitemradio', { name: new RegExp(`^${label}`, 'u') });
  await option.click();
  if (value === 'ALLOW') {
    const dialog = page.getByRole('alertdialog', { name: '启用会话 ALLOW？' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('checkbox', { name: '我理解这会扩大本会话的默认执行范围' }).check();
    await dialog.getByRole('button', { name: '确认启用' }).click();
  }
  await expect
    .poll(async () => (await activeSessionSnapshot(page)).composer.permission.override)
    .toBe(value === 'INHERIT' ? null : value.toLowerCase());
}

async function selectAutoWithRiskConfirmation(
  page: import('@playwright/test').Page
): Promise<void> {
  const trigger = workbenchUi(page).modeButton;
  await trigger.click();
  await page
    .getByRole('menu', { name: '工作模式' })
    .getByRole('menuitemradio', { name: /^AUTO\b/u })
    .click();
  const dialog = page.getByRole('alertdialog', { name: '启用 AUTO 模式？' });
  await expect(dialog).toBeVisible();
  expect((await activeSessionSnapshot(page)).composer.mode.baseMode).not.toBe('auto');
  await dialog.getByRole('checkbox', { name: '我理解这会扩大本会话的默认执行范围' }).check();
  await dialog.getByRole('button', { name: '确认启用' }).click();
  await expect
    .poll(async () => (await activeSessionSnapshot(page)).composer.mode.baseMode)
    .toBe('auto');
}

async function selectEffort(page: import('@playwright/test').Page, value: string): Promise<void> {
  const trigger = workbenchUi(page).main.getByRole('button', { name: '推理强度' });
  await trigger.click();
  await page
    .getByRole('menu', { name: '推理强度' })
    .getByRole('menuitemradio', { name: new RegExp(`^Effort ${value.toLowerCase()}\\b`, 'iu') })
    .click();
  await expect(trigger).toContainText(value.toLowerCase(), { ignoreCase: true });
}

async function selectModel(page: import('@playwright/test').Page, modelId: string): Promise<void> {
  const trigger = workbenchUi(page).modelButton;
  await trigger.click();
  await page
    .getByRole('menu', { name: '会话模型' })
    .getByRole('menuitemradio', { name: new RegExp(`^${escapeRegex(modelId)}\\b`, 'u') })
    .click();
  await expect(trigger).toContainText(modelId, { timeout: 60_000 });
}

function orionMessage(page: import('@playwright/test').Page, marker: string) {
  return page.getByRole('article', { name: 'Orion' }).filter({ hasText: marker }).last();
}

async function waitForIdle(page: import('@playwright/test').Page): Promise<void> {
  await expect
    .poll(async () => (await activeSessionSnapshot(page)).runtime.processing, { timeout: 60_000 })
    .toBe(false);
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
  page: import('@playwright/test').Page,
  minimum: number
): Promise<ProjectedDurableToolReceipt[]> {
  await expect
    .poll(async () => durableToolReceipts(await capturedSseEvents(page)).length, {
      timeout: 60_000,
    })
    .toBeGreaterThanOrEqual(minimum);
  return durableToolReceipts(await capturedSseEvents(page));
}

async function hostComposerState(
  hostUrl: string,
  sessionId: string
): Promise<{
  readonly bootstrap: WebBootstrapV1;
  readonly state: WebComposerControlStateV1;
}> {
  const bootstrapResponse = await fetch(`${hostUrl}/api/v1/bootstrap`, {
    headers: { Accept: 'application/json' },
  });
  const bootstrap = (await bootstrapResponse.json()) as WebBootstrapV1;
  const query = new URLSearchParams({
    workspaceId: bootstrap.workspaceId,
    expectedContextRevision: bootstrap.contextRevision,
  });
  const response = await fetch(
    `${hostUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/composer-state?${query.toString()}`,
    { headers: { Accept: 'application/json' } }
  );
  if (!response.ok) throw new Error(`Composer state failed with HTTP ${response.status}.`);
  return { bootstrap, state: (await response.json()) as WebComposerControlStateV1 };
}

async function hostComposerAction(
  hostUrl: string,
  bootstrap: WebBootstrapV1,
  sessionId: string,
  body: Readonly<Record<string, unknown>>
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(
    `${hostUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/composer-actions`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: hostUrl,
        'x-orion-web-nonce': bootstrap.nonce,
      },
      body: JSON.stringify({ requestId: randomUUID(), ...body }),
    }
  );
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
}

function controlGuard(
  bootstrap: WebBootstrapV1,
  state: WebComposerControlStateV1,
  sessionId: string
) {
  return {
    workspaceId: bootstrap.workspaceId,
    expectedContextRevision: bootstrap.contextRevision,
    expectedSessionId: sessionId,
    expectedControlRevision: state.controlRevision,
  };
}

function problemCode(value: unknown): string | undefined {
  return isRecord(value) && typeof value.code === 'string' ? value.code : undefined;
}

interface NetworkFailure {
  readonly method: string;
  readonly path: string;
  readonly error: string;
}

function observeSessionSseTransition(page: Page): (testInfo: TestInfo) => void {
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

async function captureComposer(
  page: import('@playwright/test').Page,
  evidence: import('./fixtures/evidence').WebE2EEvidenceCollector,
  filename: string,
  key: string
): Promise<void> {
  await page.locator('.composer-control-center').screenshot({
    path: join(evidence.scenarioDirectory, filename),
    animations: 'disabled',
  });
  evidence.recordFact(`screenshot.${key}`, basename(filename));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
