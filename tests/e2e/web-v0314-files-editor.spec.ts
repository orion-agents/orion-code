import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { expect, test } from './fixtures/test';
import { openInspector, waitForWorkbenchReady } from './fixtures/ui';

test.use({ trace: 'off', video: 'off', screenshot: 'only-on-failure' });

/**
 * v0.3.14 T4 — editable Files panel over the real Orion Web host.
 *
 * Seeds a workspace file, edits it through the view/edit toggle, saves via the
 * guarded `POST /files/write` (revision CAS), then forces a 409 by editing the
 * file externally before a second save and recovers through the explicit
 * reload affordance. Also pins the removal of the legacy read-only controls.
 *
 * After a successful save the repository snapshot invalidates and the whole
 * panel rebuilds, so content assertions use a settle-and-reopen poll instead
 * of immediate view assertions.
 */
async function openFilesPanel(page: import('@playwright/test').Page) {
  await page.setViewportSize({ width: 1_600, height: 900 });
  const panel = await openInspector(page, { timeout: 30_000 });
  // v0.3.11+ — the work panel is an icon rail; the Files entry lives in the
  // quick-entry navigation, not in the session tabs.
  const entry = panel
    .getByRole('navigation', { name: '工作面板快捷入口' })
    .getByRole('button', { name: '打开文件面板' });
  await entry.click();
  const visible = panel.getByRole('tabpanel').filter({ visible: true });
  await expect(visible).toBeVisible({ timeout: 30_000 });
  return visible;
}

test('WEB33-P0-34 file editor saves with CAS and recovers from revision conflicts', async ({
  page,
  workspace,
  evidence,
}) => {
  test.setTimeout(300_000);
  await waitForWorkbenchReady(page, { timeout: 30_000 });

  const primary = workspace.primaryWorkspace;
  mkdirSync(primary, { recursive: true });
  const target = join(primary, 'editable-note.txt');
  writeFileSync(target, 'EDITABLE SEED LINE\n', 'utf8');

  let panel = await openFilesPanel(page);
  let clicked = false;
  let needle = 'EDITED BY V0.3.14 E2E';
  const row = panel.getByRole('button', { name: /editable-note\.txt/u });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();

  // View mode shows the seed content; the legacy read-only controls are gone.
  const view = panel.locator('.file-code-view');
  await expect(view).toContainText('EDITABLE SEED LINE');
  for (const removed of ['跳转', '自动换行']) {
    expect(await panel.getByText(removed, { exact: true }).count()).toBe(0);
  }
  expect(await panel.getByRole('button', { name: '复制', exact: true }).count()).toBe(0);

  // Enter edit mode.
  await panel.getByRole('button', { name: '编辑', exact: true }).click();
  const editor = panel.locator('.file-editor');
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue(/EDITABLE SEED LINE/u);

  // Save #1 succeeds; the snapshot invalidation rebuilds the whole panel, so
  // re-open the file once the tree settles and verify the saved content.
  await editor.fill('EDITED BY V0.3.14 E2E\nsecond edited line\n');
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await expect
    .poll(
      async () => {
        let reopen = panel.getByRole('button', { name: /editable-note\.txt/u });
        if (!(await reopen.count().catch(() => 0))) {
          panel = await openFilesPanel(page);
          clicked = false;
        }
        reopen = panel.getByRole('button', { name: /editable-note\.txt/u });
        const viewText =
          (await panel
            .locator('.file-code-view')
            .textContent()
            .catch(() => '')) ?? '';
        if (viewText.includes(needle)) return viewText;
        // Click ONCE per panel rebuild; re-clicking restarts the async load
        // and would keep the content empty forever.
        if (!clicked && (await reopen.count().catch(() => 0))) {
          await reopen.click().catch(() => undefined);
          clicked = true;
        }
        return '';
      },
      { timeout: 30_000 }
    )
    .toContain('EDITED BY V0.3.14 E2E');
  expect(readFileSync(target, 'utf8')).toContain('second edited line');

  // External mutation invalidates the client's revision.
  writeFileSync(target, 'EXTERNALLY CHANGED CONTENT\n', 'utf8');

  // The deliberate 409 surfaces as a browser console resource error.
  evidence.expectConsoleErrorOnce(
    'Failed to load resource: the server responded with a status of 409 (Conflict)'
  );

  await panel.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(editor).toBeVisible();
  await editor.fill('stale draft that must be rejected\n');
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await expect(panel.locator('.resource-error')).toContainText('文件已在别处变更', {
    timeout: 20_000,
  });

  // Explicit reload discards the stale draft and shows the on-disk content.
  needle = 'EXTERNALLY CHANGED CONTENT';
  clicked = false;
  await panel.locator('.resource-error').getByRole('button', { name: '重新加载' }).click();
  await expect
    .poll(
      async () => {
        let reopen = panel.getByRole('button', { name: /editable-note\.txt/u });
        if (!(await reopen.count().catch(() => 0))) {
          panel = await openFilesPanel(page);
          clicked = false;
        }
        reopen = panel.getByRole('button', { name: /editable-note\.txt/u });
        const viewText =
          (await panel
            .locator('.file-code-view')
            .textContent()
            .catch(() => '')) ?? '';
        if (viewText.includes(needle)) return viewText;
        // Click ONCE per panel rebuild; re-clicking restarts the async load
        // and would keep the content empty forever.
        if (!clicked && (await reopen.count().catch(() => 0))) {
          await reopen.click().catch(() => undefined);
          clicked = true;
        }
        return '';
      },
      { timeout: 30_000 }
    )
    .toContain('EXTERNALLY CHANGED CONTENT');
});
