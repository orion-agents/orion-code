/**
 * v0.3.66 — workspace removal journey (WEB39-P0-06).
 *
 * Every non-active project row carries a removal entry; the active row keeps
 * its entry disabled because the Host rejects `workspace_active`. A removal of
 * an available workspace goes through the shared destructive-action confirm
 * dialog, and confirming drops the row plus the registry entry while the
 * disk-side sessions stay untouched.
 *
 * The journey drives the shipped open path end to end (scripted Finder pick →
 * inspect → confirm card → 打开项目) so the client completes the activation
 * itself and the rail updates without a page reload — a reload would abort the
 * SSE stream and trip the evidence watchdog. The removed directory's sessions
 * are fixture-owned and stay on disk (the fixture cleans them up).
 */
import { realpathSync } from 'fs';
import { writeFileSync } from 'fs';

import { guardedBrowserGet } from './fixtures/api';
import { expect, test } from './fixtures/test';
import { waitForWorkbenchReady, workbenchUi } from './fixtures/ui';

interface WorkspaceSummaryShape {
  readonly id: string;
  readonly path: string;
  readonly label: string;
  readonly active: boolean;
  readonly available: boolean;
}

interface WorkspacesPageShape {
  readonly items: readonly WorkspaceSummaryShape[];
}

type PickerScript = { path?: string; outcome?: 'cancelled' | 'unavailable' };

/** The fixture reads this file fresh on every picker invocation. */
function armPicker(workspaceRoot: string, script: PickerScript): void {
  writeFileSync(`${workspaceRoot}/picker-script.json`, JSON.stringify(script));
}

test('WEB39-P0-06 removing a non-active workspace confirms and drops the row, the active entry stays disabled', async ({
  page,
  workspace,
}) => {
  const ui = await waitForWorkbenchReady(page);

  // The bootstrapped primary workspace is the active one: its removal entry is
  // disabled and explains that the Host rejects removal of the active project.
  const activeRemove = ui.workspaceRail.getByRole('button', {
    name: '移除项目 workspace-primary',
  });
  await expect(activeRemove).toBeDisabled();
  await expect(activeRemove).toHaveAttribute('title', /激活中的项目不能移除/u);

  // Open the secondary workspace through the shipped confirm flow so the
  // client updates its own state (no reload): picker → card → 打开项目.
  armPicker(workspace.rootDirectory, { path: workspace.secondaryWorkspace });
  await ui.workspaceRail.getByRole('button', { name: '选择其他工作区' }).click();
  const dialog = ui.workspaceDialog;
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '从 Finder 选择文件夹…' }).click();
  const card = dialog.getByRole('region', { name: '已选择本地项目' });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '打开项目' }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  // The now non-active primary row is removable; the entry explains that
  // removal never touches disk-side sessions.
  const primaryRemove = ui.workspaceRail.getByRole('button', {
    name: '移除项目 workspace-primary',
  });
  await expect(primaryRemove).toBeEnabled();
  await expect(primaryRemove).toHaveAttribute('title', /不会删除磁盘上的会话记录/u);

  // First removal attempt: 取消 keeps the row and the registry entry.
  await primaryRemove.click();
  const confirm = page.getByRole('dialog', { name: '移除项目 workspace-primary' });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('将从项目列表移除该项目并关闭其终端');
  await confirm.getByRole('button', { name: '取消' }).click();
  await expect(confirm).toBeHidden();
  await expect(primaryRemove).toBeVisible();

  // Confirmed removal drops the row; the active (secondary) row stays disabled.
  await primaryRemove.click();
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '移除', exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(
    ui.workspaceRail.getByRole('button', { name: '移除项目 workspace-primary' })
  ).toBeHidden();
  await expect(
    ui.workspaceRail.getByRole('button', { name: '移除项目 workspace-secondary' })
  ).toBeDisabled();

  // The durable registry no longer serves the removed workspace; paths are
  // canonical (macOS /var → /private/var), so compare via realpath.
  const after = await guardedBrowserGet<WorkspacesPageShape>(page, '/api/v1/workspaces');
  expect(after.status).toBe(200);
  const paths = after.body.items.map(item => item.path);
  expect(paths).not.toContain(realpathSync(workspace.primaryWorkspace));
  expect(paths).toContain(realpathSync(workspace.secondaryWorkspace));
});
