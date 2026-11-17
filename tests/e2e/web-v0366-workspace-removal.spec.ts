/**
 * v0.3.66 — workspace removal journey (WEB39-P0-06).
 *
 * Every non-active project row carries a removal entry; the active row keeps
 * its entry disabled because the Host rejects `workspace_active`. A removal of
 * an available workspace goes through the shared destructive-action confirm
 * dialog, and confirming drops the row plus the registry entry while the
 * disk-side sessions stay untouched. The second workspace is registered via
 * the `/workspaces/activate` API so the journey exercises removal, not the
 * picker flow (already covered by the WEB38 specs).
 */
import { randomUUID } from 'crypto';

import { browserMutation, guardedBrowserGet, webBootstrap } from './fixtures/api';
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

test('WEB39-P0-06 removing a non-active workspace confirms and drops the row, the active entry stays disabled', async ({
  page,
  workspace,
}) => {
  const ui = await waitForWorkbenchReady(page);
  const bootstrap = await webBootstrap(page);

  // The bootstrapped primary workspace is the active one: its removal entry is
  // disabled and explains that the Host rejects removal of the active project.
  const activeRemove = ui.workspaceRail.getByRole('button', {
    name: '移除项目 workspace-primary',
  });
  await expect(activeRemove).toBeDisabled();
  await expect(activeRemove).toHaveAttribute('title', /激活中的项目不能移除/u);

  // Register + activate the fixture's secondary workspace through the same
  // endpoint the workspace dialog drives, so primary becomes non-active.
  // The in-page fetch helper carries the loopback Origin + nonce contract.
  const activate = await browserMutation<{ readonly requestId: string }>(
    page,
    '/api/v1/workspaces/activate',
    {
      body: {
        requestId: randomUUID(),
        path: workspace.secondaryWorkspace,
        workspaceId: bootstrap.workspaceId,
        expectedContextRevision: bootstrap.contextRevision,
      },
    }
  );
  expect(activate.status).toBe(200);

  await page.reload();
  const reloaded = await waitForWorkbenchReady(page);

  // The now non-active primary row is removable; the entry next to it explains
  // that removal never touches disk-side sessions.
  const primaryRemove = reloaded.workspaceRail.getByRole('button', {
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

  // Confirmed removal drops the row.
  await primaryRemove.click();
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '移除', exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(
    reloaded.workspaceRail.getByRole('button', { name: '移除项目 workspace-primary' })
  ).toBeHidden();
  await expect(
    reloaded.workspaceRail.getByRole('button', { name: '移除项目 workspace-secondary' })
  ).toBeDisabled();

  // The durable registry no longer serves the removed workspace.
  const after = await guardedBrowserGet<WorkspacesPageShape>(page, '/api/v1/workspaces');
  expect(after.status).toBe(200);
  expect(after.body.items.map(item => item.path)).not.toContain(workspace.primaryWorkspace);
  expect(after.body.items.map(item => item.path)).toContain(workspace.secondaryWorkspace);
});
