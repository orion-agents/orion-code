import { createHash, randomUUID } from 'crypto';
import { realpathSync } from 'fs';

import type {
  WebBootstrapV1,
  WebMcpServerSummaryV1,
  WebPageV1,
  WebSkillSummaryV1,
  WebToolDetailPageV1,
  WebToolDetailSummaryV1,
} from '../../src/web/protocol';
import {
  activeSessionSnapshot,
  foregroundSessionId,
  guardedBrowserGet,
  webBootstrap,
} from './fixtures/api';
import { MCP_FIXTURE_ECHO_TOOL } from './fixtures/mcp-server';
import { OPENAI_FIXTURE_MARKERS, OPENAI_FIXTURE_PROMPTS } from './fixtures/openai-provider';
import { allowExpectedNetworkFailures, capturedSseEvents, expect, test } from './fixtures/test';
import {
  answerApproval,
  createSession,
  renameActiveSession,
  selectInspectorTab,
  submitPrompt,
  waitForApproval,
  waitForWorkbenchReady,
  workbenchUi,
} from './fixtures/ui';

const LARGE_OUTPUT_BYTES = 128 * 1024;

test('E2E-P0-07 workspaces stay isolated while MCP and large artifacts are explicitly observable', async ({
  evidence,
  host,
  page,
  provider,
  workspace,
}, testInfo) => {
  allowExpectedNetworkFailures(testInfo, 5);
  await createSession(page);
  await renameActiveSession(page, 'Primary durable session');
  const primary = await activeSessionSnapshot(page);
  const secondaryWorkspace = realpathSync(workspace.secondaryWorkspace);

  const ui = workbenchUi(page);
  await ui.workspaceRail.getByRole('button', { name: '选择其他工作区' }).click();
  await expect(ui.workspaceDialog).toBeVisible();
  await ui.workspaceDialog
    .getByRole('textbox', { name: '打开其他本地目录' })
    .fill(workspace.secondaryWorkspace);
  await ui.workspaceDialog.getByRole('button', { name: '打开', exact: true }).click();
  await expect(ui.workspaceDialog).toBeHidden({ timeout: 30_000 });
  await expect
    .poll(async () => (await webBootstrap(page)).workspace, { timeout: 30_000 })
    .toBe(secondaryWorkspace);

  await createSession(page);
  await renameActiveSession(page, 'Secondary durable session');
  const secondary = await activeSessionSnapshot(page);
  expect(secondary.session.projectPath).toBe(secondaryWorkspace);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  expect((await activeSessionSnapshot(page)).session.id).toBe(secondary.session.id);

  const bootstrap = await hostBootstrap(host.url);
  const crossWorkspace = await hostJson(
    host.url,
    bootstrap.nonce,
    `/api/v1/sessions/${encodeURIComponent(primary.session.id)}/activate`,
    {
      requestId: randomUUID(),
      expectedContextRevision: bootstrap.contextRevision,
      workspaceId: bootstrap.workspaceId,
    }
  );
  expect(crossWorkspace.status).toBe(409);
  const afterRejectedActivation = await webBootstrap(page);
  expect(afterRejectedActivation.workspace).toBe(secondaryWorkspace);
  expect(await foregroundSessionId(page, afterRejectedActivation.workspaceId)).toBe(
    secondary.session.id
  );
  evidence.recordFact('workspace.primary_session_digest', digestIdentifier(primary.session.id));
  evidence.recordFact('workspace.secondary_session_digest', digestIdentifier(secondary.session.id));
  evidence.recordFact('workspace.cross_activation_status', crossWorkspace.status);
  evidence.recordFact('workspace.active_preserved', true);

  const skills = await guardedBrowserGet<WebPageV1<WebSkillSummaryV1>>(
    page,
    '/api/v1/skills?pageSize=100'
  );
  const mcpBefore = await guardedBrowserGet<WebPageV1<WebMcpServerSummaryV1>>(
    page,
    '/api/v1/mcp?pageSize=100'
  );
  expect(skills.status).toBe(200);
  expect(mcpBefore.status).toBe(200);
  expect(mcpBefore.body.items).toHaveLength(1);
  expect(mcpBefore.body.items[0]).toMatchObject({ id: 'web_e2e', state: 'dormant' });
  evidence.recordFact('catalog.skills_count', skills.body.items.length);
  evidence.recordFact('catalog.mcp_before_state', mcpBefore.body.items[0].state);
  const catalogJson = JSON.stringify({ skills: skills.body, mcp: mcpBefore.body });
  expect(catalogJson).not.toContain(workspace.configDirectory);
  expect(catalogJson).not.toContain(workspace.environment.ORION_CODE_API_KEY);

  await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.mcpEcho);
  await waitForApproval(page, MCP_FIXTURE_ECHO_TOOL, { timeout: 45_000 });
  const mcpReady = await guardedBrowserGet<WebPageV1<WebMcpServerSummaryV1>>(
    page,
    '/api/v1/mcp?pageSize=100'
  );
  expect(mcpReady.body.items[0]).toMatchObject({ state: 'connected', toolCount: 2 });
  evidence.recordFact('catalog.mcp_after_state', mcpReady.body.items[0].state);
  evidence.recordFact('catalog.mcp_tool_count', mcpReady.body.items[0].toolCount);
  await answerApproval(page, 'once', MCP_FIXTURE_ECHO_TOOL);
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.mcpEchoDone)).toBeVisible({
    timeout: 45_000,
  });
  await waitForIdle(page);
  await expect(
    page.getByRole('article', { name: new RegExp(`^工具 ${MCP_FIXTURE_ECHO_TOOL}`) })
  ).toContainText('MCP_ECHO_OK');
  expect(provider.requests.filter(request => request.scenario === 'mcp-echo')).toHaveLength(2);
  evidence.recordFact('catalog.mcp_provider_requests', 2);

  await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.largeOutput);
  await waitForApproval(page, 'exec_command', { timeout: 45_000 });
  await answerApproval(page, 'once', 'exec_command');
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.largeOutputDone)).toBeVisible({
    timeout: 60_000,
  });
  await waitForIdle(page);

  const details = await guardedBrowserGet<WebPageV1<WebToolDetailSummaryV1>>(
    page,
    '/api/v1/tool-details?pageSize=100'
  );
  expect(details.status).toBe(200);
  const artifact = details.body.items.find(
    item => item.toolName === 'exec_command' && item.outputBytes === LARGE_OUTPUT_BYTES
  );
  expect(artifact).toBeDefined();
  expect(artifact).toMatchObject({ hasArtifact: true, state: 'success' });
  expect(artifact!.artifactId).toMatch(/^[A-Za-z0-9_-]+$/u);
  expect(JSON.stringify(artifact)).not.toContain(workspace.secondaryWorkspace);

  const first = await guardedBrowserGet<WebToolDetailPageV1>(
    page,
    `/api/v1/tool-details/${encodeURIComponent(artifact!.artifactId!)}?offsetBytes=0&limitBytes=65536`
  );
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({
    offsetBytes: 0,
    nextOffsetBytes: 65_536,
    totalBytes: LARGE_OUTPUT_BYTES,
    redacted: true,
  });
  expect(Buffer.byteLength(first.body.content, 'utf8')).toBe(65_536);
  const second = await guardedBrowserGet<WebToolDetailPageV1>(
    page,
    `/api/v1/tool-details/${encodeURIComponent(artifact!.artifactId!)}?offsetBytes=${first.body.nextOffsetBytes}&limitBytes=65536`
  );
  expect(second.body.offsetBytes).toBe(65_536);
  expect(second.body.nextOffsetBytes).toBeUndefined();
  expect(second.body.totalBytes).toBe(LARGE_OUTPUT_BYTES);
  expect(Buffer.byteLength(second.body.content, 'utf8')).toBe(65_536);
  expect(`${first.body.content}${second.body.content}`).toBe('L'.repeat(LARGE_OUTPUT_BYTES));
  evidence.recordFact('artifact.id_digest', digestIdentifier(artifact!.artifactId!));
  evidence.recordFact('artifact.total_bytes', artifact!.outputBytes);
  evidence.recordFact('artifact.first_page_bytes', Buffer.byteLength(first.body.content, 'utf8'));
  evidence.recordFact('artifact.second_page_bytes', Buffer.byteLength(second.body.content, 'utf8'));
  evidence.recordFact(
    'artifact.content_sha256',
    digestIdentifier(`${first.body.content}${second.body.content}`)
  );

  const activity = await selectInspectorTab(page, '活动');
  await activity.getByRole('button', { name: /刷新/u }).click();
  const detailGroup = activity.getByRole('group', { name: '工具输出详情' });
  await expect(detailGroup).toBeVisible({ timeout: 30_000 });
  await detailGroup.getByRole('button').filter({ hasText: 'exec_command' }).first().click();
  await expect(activity.getByRole('button', { name: '加载更多' })).toBeVisible();
  await activity.getByRole('button', { name: '加载更多' }).click();
  await expect
    .poll(
      () =>
        activity
          .locator('.detail-output pre')
          .evaluate(node => new TextEncoder().encode(node.textContent ?? '').byteLength),
      { timeout: 30_000 }
    )
    .toBe(LARGE_OUTPUT_BYTES);
  await expect(activity.getByRole('button', { name: '加载更多' })).toHaveCount(0);
  evidence.recordFact('artifact.ui_rendered_bytes', LARGE_OUTPUT_BYTES);

  const sseJson = JSON.stringify(await capturedSseEvents(page));
  expect(sseJson).not.toContain('L'.repeat(12_000));
  expect(sseJson).not.toContain(workspace.environment.ORION_CODE_API_KEY);
  evidence.recordFact('artifact.large_output_in_sse', false);
});

function orionMessage(page: import('@playwright/test').Page, marker: string) {
  return page.getByRole('article', { name: 'Orion' }).filter({ hasText: marker }).last();
}

async function waitForIdle(page: import('@playwright/test').Page): Promise<void> {
  await expect
    .poll(async () => (await activeSessionSnapshot(page)).runtime.processing, { timeout: 60_000 })
    .toBe(false);
}

async function hostBootstrap(hostUrl: string): Promise<WebBootstrapV1> {
  const response = await fetch(`${hostUrl}/api/v1/bootstrap`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Host bootstrap failed with HTTP ${response.status}.`);
  return response.json() as Promise<WebBootstrapV1>;
}

async function hostJson(
  hostUrl: string,
  nonce: string,
  path: string,
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
  return { status: response.status, body: await response.json() };
}

function digestIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
