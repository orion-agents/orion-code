import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';

import type { WebEventEnvelopeV1 } from '../../src/web/protocol';
import { activeSessionSnapshot } from './fixtures/api';
import {
  OPENAI_FIXTURE_FILES,
  OPENAI_FIXTURE_MARKERS,
  OPENAI_FIXTURE_PROMPTS,
} from './fixtures/openai-provider';
import { allowExpectedNetworkFailures, capturedSseEvents, expect, test } from './fixtures/test';
import {
  answerApproval,
  createSession,
  openInspector,
  setAgentMode,
  submitPrompt,
  waitForApproval,
  waitForWorkbenchReady,
} from './fixtures/ui';

test('E2E-P0-06 PLAN receipt, durable Goal completion and AUTO authority remain exact', async ({
  evidence,
  page,
  provider,
  workspace,
}, testInfo) => {
  allowExpectedNetworkFailures(testInfo, 5);
  await createSession(page);
  await setAgentMode(page, 'PLAN');
  await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.plan);
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.planReady)).toBeVisible({
    timeout: 45_000,
  });
  await waitForIdle(page);

  const planned = await activeSessionSnapshot(page);
  expect(planned.plan).not.toBeNull();
  expect(Object.keys(planned.plan!).sort()).toEqual(['body', 'digest', 'returnMode']);
  expect(planned.plan).toMatchObject({ returnMode: 'build' });
  expect(planned.plan!.body).toContain('# WEB_E2E_PLAN');
  expect(planned.plan!.digest).toMatch(/^[a-f0-9]{64}$/u);
  expect(planned.composer.planReview).toMatchObject({
    planDigest: planned.plan!.digest,
    status: 'awaiting_review',
  });
  await expect(page.getByRole('heading', { name: '计划已保存，尚未执行' })).toBeVisible();
  await expect(page.getByRole('button', { name: '工作模式' })).toContainText('PLAN');

  const planningRequests = provider.requests.filter(request => request.scenario === 'plan');
  expect(planningRequests).toHaveLength(2);
  expect(planningRequests.every(request => isPlanPrompt(request.systemText))).toBe(true);
  evidence.recordFact('plan.preapproval_provider_requests', planningRequests.length);

  await page.getByRole('button', { name: '批准并进入 BUILD' }).click();
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.planExecutionDone)).toBeVisible({
    timeout: 45_000,
  });
  await waitForIdle(page);
  await expect(page.getByRole('button', { name: '工作模式' })).toContainText('BUILD');

  const planRequests = provider.requests.filter(request => request.scenario === 'plan');
  expect(planRequests).toHaveLength(3);
  expect(planRequests.slice(0, 2).every(request => isPlanPrompt(request.systemText))).toBe(true);
  expect(isPlanPrompt(planRequests[2].systemText)).toBe(false);
  expect(planRequests[2].lastUserText).toContain('action=approve');
  const planCommits = (await capturedSseEvents(page))
    .filter(isWebEventEnvelope)
    .filter(event => event.type === 'thread_event' && event.payload.eventType === 'turn.committed');
  expect(planCommits).toHaveLength(2);
  evidence.recordFact('plan.digest', planned.plan!.digest);
  evidence.recordFact('plan.return_mode', planned.plan!.returnMode);
  evidence.recordFact('plan.logical_commits', planCommits.length);
  evidence.recordFact('plan.provider_requests', planRequests.length);

  await createSession(page);
  const objective =
    'fixture:goal complete a durable Web E2E Goal with fresh file and test evidence';
  const inspector = await openInspector(page);
  await inspector.getByRole('textbox', { name: '创建 Goal' }).fill(objective);
  await inspector.getByRole('button', { name: '开始 Goal' }).click();
  await waitForApproval(page, 'write_file', { timeout: 45_000 });
  await answerApproval(page, 'once', 'write_file');
  await waitForApproval(page, 'exec_command', { timeout: 45_000 });
  await answerApproval(page, 'once', 'exec_command');
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.goalComplete)).toBeVisible({
    timeout: 60_000,
  });
  await waitForIdle(page);

  const goalPath = workspace.primaryPath(OPENAI_FIXTURE_FILES.goalWrite);
  expect(readFileSync(goalPath, 'utf8')).toBe('WEB_E2E_GOAL_OK\n');
  const completedGoal = await activeSessionSnapshot(page);
  expect(completedGoal.goal).not.toBeNull();
  expect(completedGoal.goal!.authority).toBe('turn_commit');
  expect(completedGoal.goal!.digest).toMatch(/^[a-f0-9]{64}$/u);
  expect(goalStatus(completedGoal.goal!.state)).toBe('completed');
  const durableGoalDigest = completedGoal.goal!.digest;
  expect(provider.requests.filter(request => request.scenario === 'goal')).toHaveLength(6);
  evidence.recordFact('goal.digest', durableGoalDigest);
  evidence.recordFact('goal.status', goalStatus(completedGoal.goal!.state) ?? null);
  evidence.recordFact('goal.file_sha256', sha256(readFileSync(goalPath)));
  evidence.recordFact('goal.provider_requests', 6);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  const restoredGoal = await activeSessionSnapshot(page);
  expect(restoredGoal.goal?.digest).toBe(durableGoalDigest);
  expect(goalStatus(restoredGoal.goal?.state)).toBe('completed');
  await expect(page.getByRole('heading', { name: objective })).toBeVisible();
  evidence.recordFact('goal.restored_same_digest', restoredGoal.goal?.digest === durableGoalDigest);

  await createSession(page);
  await setAgentMode(page, 'AUTO');
  const autoPath = workspace.primaryPath(OPENAI_FIXTURE_FILES.autoAllowedWrite);
  const escapedPath = workspace.secondaryPath(OPENAI_FIXTURE_FILES.autoEscapeWrite);
  expect(existsSync(autoPath)).toBe(false);
  expect(existsSync(escapedPath)).toBe(false);

  await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.autoAllowed);
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.autoAllowedDone)).toBeVisible({
    timeout: 45_000,
  });
  await waitForIdle(page);
  expect(readFileSync(autoPath, 'utf8')).toBe('AUTO_ALLOWED\n');
  evidence.recordFact('auto.allowed_sha256', sha256(readFileSync(autoPath)));
  expect((await activeSessionSnapshot(page)).pendingApprovals).toEqual([]);
  expect(page.getByRole('region', { name: /^允许 .+？$/ })).toHaveCount(0);

  await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.autoEscape);
  const blocked = page.getByRole('article', { name: '工具 write_file：失败' }).last();
  await expect(blocked).toBeVisible({ timeout: 45_000 });
  await expect(blocked).toContainText(/workspace|denied|outside/iu);
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.autoEscapeBlocked)).toBeVisible({
    timeout: 45_000,
  });
  await waitForIdle(page);
  expect(existsSync(escapedPath)).toBe(false);
  const escapeRequests = provider.requests.filter(request => request.scenario === 'auto-escape');
  expect(escapeRequests).toHaveLength(2);
  expect(escapeRequests[0].messages.at(-1)?.role).toBe('user');
  expect(escapeRequests[1].messages.at(-1)?.role).toBe('tool');
  expect((await activeSessionSnapshot(page)).pendingApprovals).toEqual([]);
  evidence.recordFact('auto.escape_blocked', true);
  evidence.recordFact('auto.escape_provider_requests', escapeRequests.length);
});

function orionMessage(page: import('@playwright/test').Page, marker: string) {
  return page.getByRole('article', { name: 'Orion' }).filter({ hasText: marker }).last();
}

async function waitForIdle(page: import('@playwright/test').Page): Promise<void> {
  await expect
    .poll(async () => (await activeSessionSnapshot(page)).runtime.processing, { timeout: 60_000 })
    .toBe(false);
}

function isPlanPrompt(systemText: string): boolean {
  return systemText.includes('[Plan Mode]') || systemText.includes('[Plan-to-Execution Mode]');
}

function isWebEventEnvelope(value: unknown): value is WebEventEnvelopeV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Partial<WebEventEnvelopeV1>;
  return typeof event.eventId === 'string' && Number.isSafeInteger(event.cursor);
}

function goalStatus(value: unknown): string | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? String((value as Record<string, unknown>).status ?? '') || undefined
    : undefined;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
