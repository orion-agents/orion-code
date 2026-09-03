import { expect, test } from './fixtures/test';
import { createSession, waitForWorkbenchReady, workbenchUi } from './fixtures/ui';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

/**
 * v0.3.7 Session lifecycle e2e: the rail overflow menu drives rename / tags /
 * archive / delete, and the archived section restores. Runs on CI against the
 * packaged host; needs one real Session.
 */

test('WEB37-P0-01 session row menu archives and restores a session from the rail', async ({
  evidence,
  page,
  workspace,
}) => {
  test.setTimeout(120_000);
  evidence.addSecretValue(workspace.environment.ORION_CODE_API_KEY);
  await page.setViewportSize({ width: 1_600, height: 900 });
  const ui = workbenchUi(page);
  await createSession(page, { name: 'WEB37 archive flow' });
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  await expect(ui.composer).toBeEnabled({ timeout: 30_000 });

  const row = page.getByRole('listitem').filter({ hasText: 'WEB37 archive flow' }).first();
  const rowMenu = row.getByRole('button', { name: /会话 .* 操作/ });
  await expect(rowMenu).toBeVisible();

  // Keyboard opens the menu; Enter focuses the first enabled item.
  await rowMenu.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: /会话 .* 操作/ });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '重命名…' })).toBeFocused();

  // Navigate to 归档 and activate it.
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: '管理标签…' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(row).toBeHidden();

  // The archived section lists the session; restore brings it back.
  const archivedSection = page.locator('details.archived-section');
  await expect(archivedSection).toBeVisible();
  await archivedSection.locator('summary').click();
  await expect(archivedSection.getByText('WEB37 archive flow')).toBeVisible();
  await archivedSection.getByRole('button', { name: '还原' }).click();
  await expect(row).toBeVisible();

  evidence.recordFact('web37.menu_keyboard_navigation', true);
  evidence.recordFact('web37.archive_restore_verified', true);
});

test('WEB37-P0-02 delete requires confirmation and removes the session', async ({
  evidence,
  page,
  workspace,
}) => {
  test.setTimeout(120_000);
  evidence.addSecretValue(workspace.environment.ORION_CODE_API_KEY);
  await page.setViewportSize({ width: 1_600, height: 900 });
  const ui = workbenchUi(page);
  await createSession(page, { name: 'WEB37 delete flow' });
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  await expect(ui.composer).toBeEnabled({ timeout: 30_000 });

  const row = page.getByRole('listitem').filter({ hasText: 'WEB37 delete flow' }).first();
  const rowMenu = row.getByRole('button', { name: /会话 .* 操作/ });
  await rowMenu.click();
  const menu = page.getByRole('menu', { name: /会话 .* 操作/ });

  // Walk to the destructive 删除… item (last of four) and activate it.
  const deleteItem = menu.getByRole('menuitem', { name: '删除…' });
  await expect(deleteItem).toBeVisible();
  await deleteItem.click();

  // The confirm dialog must be answered explicitly; cancel keeps the row.
  const dialog = page.getByRole('dialog', { name: '删除会话' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('不可恢复');
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toBeVisible();

  // Confirm deletes for real.
  await rowMenu.click();
  await menu.getByRole('menuitem', { name: '删除…' }).click();
  await dialog.getByRole('button', { name: '永久删除' }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toBeHidden();

  evidence.recordFact('web37.delete_confirmation_required', true);
  evidence.recordFact('web37.delete_verified', true);
});

test('WEB37-P0-03 tags edit round-trips through the tag dialog', async ({
  evidence,
  page,
  workspace,
}) => {
  test.setTimeout(120_000);
  evidence.addSecretValue(workspace.environment.ORION_CODE_API_KEY);
  await page.setViewportSize({ width: 1_600, height: 900 });
  const ui = workbenchUi(page);
  await createSession(page, { name: 'WEB37 tags flow' });
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  await expect(ui.composer).toBeEnabled({ timeout: 30_000 });

  const row = page.getByRole('listitem').filter({ hasText: 'WEB37 tags flow' }).first();
  await row.getByRole('button', { name: /会话 .* 操作/ }).click();
  const menu = page.getByRole('menu', { name: /会话 .* 操作/ });
  await menu.getByRole('menuitem', { name: '管理标签…' }).click();

  const dialog = page.getByRole('dialog', { name: '管理会话标签' });
  await expect(dialog).toBeVisible();
  const input = dialog.getByLabel('新标签');
  await input.fill('bug');
  await input.press('Enter');
  await input.fill('前端');
  await input.press('Enter');
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toBeHidden();

  // Tag badges appear on the session row (persisted through the host).
  await expect(row.locator('.session-tag-badge')).toHaveText(['bug', '前端']);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  await expect(
    page
      .getByRole('listitem')
      .filter({ hasText: 'WEB37 tags flow' })
      .first()
      .locator('.session-tag-badge')
  ).toHaveText(['bug', '前端']);

  evidence.recordFact('web37.tags_roundtrip', true);
});
