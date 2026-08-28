import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';

import type { WebBootstrapV1, WebSessionSnapshotV1 } from '../../src/web/protocol';
import {
  OPENAI_FIXTURE_FILES,
  OPENAI_FIXTURE_MARKERS,
  OPENAI_FIXTURE_PROMPTS,
} from './fixtures/openai-provider';
import { allowExpectedNetworkFailures, test, expect } from './fixtures/test';
import { answerApproval, createSession, submitPrompt, waitForApproval } from './fixtures/ui';

test('E2E-P0-02 denial has no effect and allow-once performs one real write and test command', async ({
  evidence,
  page,
  provider,
  workspace,
}, testInfo) => {
  allowExpectedNetworkFailures(testInfo, 1);
  await createSession(page);
  const deniedPath = workspace.primaryPath(OPENAI_FIXTURE_FILES.deniedWrite);
  const approvedPath = workspace.primaryPath(OPENAI_FIXTURE_FILES.approvedWrite);
  const execProofPath = workspace.primaryPath(OPENAI_FIXTURE_FILES.execProof);
  expect(fileSha256(deniedPath)).toBeNull();
  expect(fileSha256(approvedPath)).toBeNull();
  expect(fileSha256(execProofPath)).toBeNull();

  await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.denyWrite);
  await waitForApproval(page, 'write_file', { timeout: 30_000 });
  const deniedPending = await activeSnapshot(page);
  expect(deniedPending.pendingApprovals).toHaveLength(1);
  expect(deniedPending.pendingApprovals[0]).toMatchObject({
    toolName: 'write_file',
    sanitizedArguments: { path: OPENAI_FIXTURE_FILES.deniedWrite },
    allowedScopes: ['once', 'project', 'global'],
  });

  await answerApproval(page, 'reject', 'write_file');
  await expect(page.getByRole('article', { name: '工具 write_file：失败' })).toContainText(
    'User denied the operation.',
    { timeout: 45_000 }
  );
  await expect
    .poll(async () => (await activeSnapshot(page)).runtime.processing, { timeout: 45_000 })
    .toBe(false);
  const deniedFinal = await activeSnapshot(page);
  expect(deniedFinal.pendingApprovals).toEqual([]);
  expect(provider.requests.filter(request => request.scenario === 'deny-write')).toHaveLength(1);
  expect(fileSha256(deniedPath)).toBeNull();
  evidence.recordFact('deny.file_absent', true);
  evidence.recordFact('deny.provider_requests', 1);
  evidence.recordFact(
    'approval.allowed_scopes',
    deniedPending.pendingApprovals[0].allowedScopes.join(',')
  );

  await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.approveWriteExec);
  await waitForApproval(page, 'write_file', { timeout: 30_000 });
  await answerApproval(page, 'once', 'write_file');
  await waitForApproval(page, 'exec_command', { timeout: 30_000 });
  await answerApproval(page, 'once', 'exec_command');
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.approveWriteExecDone)).toBeVisible({
    timeout: 45_000,
  });

  expect(readFileSync(approvedPath, 'utf8')).toBe('WRITE_APPROVED\n');
  expect(readFileSync(execProofPath, 'utf8')).toBe('EXEC_APPROVED\n');
  const approvedSha256 = createHash('sha256').update('WRITE_APPROVED\n').digest('hex');
  const execSha256 = createHash('sha256').update('EXEC_APPROVED\n').digest('hex');
  expect(fileSha256(approvedPath)).toBe(approvedSha256);
  expect(fileSha256(execProofPath)).toBe(execSha256);

  const finalSnapshot = await activeSnapshot(page);
  expect(finalSnapshot.pendingApprovals).toEqual([]);
  expect(finalSnapshot.runtime.processing).toBe(false);
  expect(
    provider.requests.filter(request => request.scenario === 'approve-write-exec')
  ).toHaveLength(3);
  evidence.recordFact('allow_once.approved_sha256', approvedSha256);
  evidence.recordFact('allow_once.exec_sha256', execSha256);
  evidence.recordFact('allow_once.provider_requests', 3);
  evidence.recordFact('turn.event_cursor', finalSnapshot.eventCursor);
  evidence.recordFact('turn.thread_cursor', finalSnapshot.threadCursor);
});

function orionMessage(page: import('@playwright/test').Page, marker: string) {
  return page.getByRole('article', { name: 'Orion' }).filter({ hasText: marker }).last();
}

async function activeSnapshot(
  page: import('@playwright/test').Page
): Promise<WebSessionSnapshotV1> {
  return page.evaluate(async () => {
    const bootstrapResponse = await fetch('/api/v1/bootstrap', { cache: 'no-store' });
    const bootstrap = (await bootstrapResponse.json()) as WebBootstrapV1;
    if (!bootstrap.activeSessionId) throw new Error('No active session for Web E2E snapshot.');
    const snapshotResponse = await fetch(
      `/api/v1/sessions/${encodeURIComponent(bootstrap.activeSessionId)}/snapshot?pageSize=100`,
      { cache: 'no-store' }
    );
    if (!snapshotResponse.ok) throw new Error(`Snapshot failed with ${snapshotResponse.status}.`);
    return snapshotResponse.json() as Promise<WebSessionSnapshotV1>;
  });
}

function fileSha256(path: string): string | null {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
}
