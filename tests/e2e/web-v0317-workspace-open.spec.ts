/**
 * v0.3.17 / W316P — LOCAL WORKSPACE open path.
 *
 * The Host answers the directory picker from a script file (the workspace
 * fixture points `ORION_CODE_WEB_PICKER_FIXTURE` at it), so these specs run the
 * whole browse → inspect → confirm → activate flow without ever opening a real
 * Finder dialog. Real Finder behaviour stays a manual macOS smoke check.
 */
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';

import { guardedBrowserGet, webBootstrap } from './fixtures/api';
import { expect, test } from './fixtures/test';
import { waitForWorkbenchReady, workbenchUi } from './fixtures/ui';

interface OpenTraceShape {
  readonly requestId: string;
  readonly operation: string;
  readonly outcome: string;
  readonly stages: Readonly<Record<string, number>>;
  readonly totalMs: number;
  readonly errorCode?: string;
}

interface DiagnosticsShape {
  readonly workspaceOpen: { readonly retained: number; readonly recent: readonly OpenTraceShape[] };
  readonly session: { readonly controlPlaneInstalls: number; readonly actors: unknown };
}

type PickerScript = { path?: string; outcome?: 'cancelled' | 'unavailable' };

/** The fixture reads this file fresh on every picker invocation. */
function armPicker(workspaceRoot: string, script: PickerScript): string {
  const scriptPath = join(workspaceRoot, 'picker-script.json');
  writeFileSync(scriptPath, JSON.stringify(script));
  return scriptPath;
}

async function diagnostics(
  page: Parameters<typeof guardedBrowserGet>[0]
): Promise<DiagnosticsShape> {
  const result = await guardedBrowserGet<DiagnosticsShape>(page, '/api/v1/diagnostics');
  expect(result.status).toBe(200);
  return result.body;
}

async function openWorkspaceDialog(page: Parameters<typeof workbenchUi>[0]) {
  const ui = workbenchUi(page);
  await waitForWorkbenchReady(page);
  await ui.workspaceRail.getByRole('button', { name: '选择其他工作区' }).click();
  await expect(ui.workspaceDialog).toBeVisible();
  return ui;
}

test('WEB38-P0-01 (W316P-01) opening the dialog browses nothing and installs no Runtime', async ({ page }) => {
  const before = await diagnostics(page);
  const bootstrapBefore = await webBootstrap(page);

  const ui = await openWorkspaceDialog(page);

  const after = await diagnostics(page);
  // No picker ran, no inspect ran, no control plane was swapped.
  expect(after.workspaceOpen.retained).toBe(before.workspaceOpen.retained);
  expect(after.session.controlPlaneInstalls).toBe(before.session.controlPlaneInstalls);
  const bootstrapAfter = await webBootstrap(page);
  expect(bootstrapAfter.contextRevision).toBe(bootstrapBefore.contextRevision);

  // The Finder entry is the primary affordance; the manual path is folded away.
  await expect(
    ui.workspaceDialog.getByRole('button', { name: '从 Finder 选择文件夹…' })
  ).toBeVisible();
  await expect(ui.workspaceDialog.getByRole('textbox', { name: '打开其他本地目录' })).toBeHidden();
});

test('WEB38-P0-02 (W316P-02) a scripted Finder pick inspects and confirms without switching', async ({
  page,
  workspace,
}) => {
  const picked = mkdtempSync(join(workspace.rootDirectory, 'picked-'));
  armPicker(workspace.rootDirectory, { path: picked });

  const before = await diagnostics(page);
  const bootstrapBefore = await webBootstrap(page);
  const ui = await openWorkspaceDialog(page);

  await ui.workspaceDialog.getByRole('button', { name: '从 Finder 选择文件夹…' }).click();

  const card = ui.workspaceDialog.getByRole('region', { name: '已选择本地项目' });
  await expect(card).toBeVisible();
  await expect(card).toContainText(picked);
  await expect(card).toContainText('本地文件夹');
  // Confirmation is required: nothing has been registered or activated yet.
  await expect(card.getByRole('button', { name: '打开项目' })).toBeEnabled();

  const after = await diagnostics(page);
  const inspectTrace = after.workspaceOpen.recent.find(trace => trace.operation === 'inspect');
  expect(inspectTrace?.outcome).toBe('success');
  expect(after.session.controlPlaneInstalls).toBe(before.session.controlPlaneInstalls);
  const bootstrapAfter = await webBootstrap(page);
  expect(bootstrapAfter.contextRevision).toBe(bootstrapBefore.contextRevision);
  expect(bootstrapAfter.workspaceId).toBe(bootstrapBefore.workspaceId);
});

test('WEB38-P0-03 (W316P-04) cancelling the picker leaves the session and Context untouched', async ({
  page,
  workspace,
}) => {
  armPicker(workspace.rootDirectory, { outcome: 'cancelled' });
  const before = await diagnostics(page);
  const bootstrapBefore = await webBootstrap(page);

  const ui = await openWorkspaceDialog(page);
  await ui.workspaceDialog.getByRole('button', { name: '从 Finder 选择文件夹…' }).click();

  // Cancellation is a normal outcome: back to browsing, no card, no error, and
  // the dialog stays open.
  await expect(ui.workspaceDialog.getByRole('region', { name: '已选择本地项目' })).toBeHidden();
  await expect(ui.workspaceDialog).toBeVisible();
  const cancelTrace = (await diagnostics(page)).workspaceOpen.recent.find(
    trace => trace.operation === 'pick-directory'
  );
  expect(cancelTrace?.outcome).toBe('cancelled');

  const bootstrapAfter = await webBootstrap(page);
  expect(bootstrapAfter.contextRevision).toBe(bootstrapBefore.contextRevision);
  expect((await diagnostics(page)).session.controlPlaneInstalls).toBe(
    before.session.controlPlaneInstalls
  );
  // The Composer was never disabled by browsing.
  await expect(workbenchUi(page).composer).toBeVisible();
});

test('WEB38-P0-04 (W316P-08) the advanced path follows the same inspect → confirm contract', async ({
  page,
  workspace,
}) => {
  const picked = mkdtempSync(join(workspace.rootDirectory, 'typed-'));
  const ui = await openWorkspaceDialog(page);

  await ui.workspaceDialog.locator('summary', { hasText: '高级：粘贴绝对路径' }).click();
  await ui.workspaceDialog.getByRole('textbox', { name: '打开其他本地目录' }).fill(picked);
  await ui.workspaceDialog.getByRole('button', { name: '打开', exact: true }).click();

  // Exactly like the Finder path: a confirmation card, not an immediate switch.
  const card = ui.workspaceDialog.getByRole('region', { name: '已选择本地项目' });
  await expect(card).toBeVisible();
  await expect(card).toContainText(picked);
  await expect(ui.workspaceDialog).toBeVisible();
});

test('WEB38-P0-05 (W316P-09) traces and diagnostics never carry an unchecked path', async ({
  page,
  workspace,
}) => {
  const picked = mkdtempSync(join(workspace.rootDirectory, 'secret-project-'));
  armPicker(workspace.rootDirectory, { path: picked });

  const ui = await openWorkspaceDialog(page);
  await ui.workspaceDialog.getByRole('button', { name: '从 Finder 选择文件夹…' }).click();
  await expect(ui.workspaceDialog.getByRole('region', { name: '已选择本地项目' })).toBeVisible();

  const serialized = JSON.stringify((await diagnostics(page)).workspaceOpen);
  expect(serialized).not.toContain(picked);
  expect(serialized).not.toContain('secret-project-');
  expect(serialized).not.toMatch(/\/Users\/|\/tmp\//u);
  // Privacy holds for the evidence snapshot the suite writes out.
  for (const trace of (await diagnostics(page)).workspaceOpen.recent) {
    expect(Object.keys(trace).sort()).toEqual(
      trace.errorCode
        ? ['errorCode', 'operation', 'outcome', 'requestId', 'stages', 'totalMs']
        : ['operation', 'outcome', 'requestId', 'stages', 'totalMs']
    );
  }
});
