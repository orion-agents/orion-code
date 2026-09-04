import { expect, test } from './fixtures/test';
import { waitForWorkbenchReady, workbenchUi } from './fixtures/ui';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

/**
 * v0.3.8 Work panel vertical-rail flow (S1–S4): the rail stays vertical on the
 * right, clicking an icon shows exactly that panel, re-clicking collapses the
 * content back to the rail, and the terminal icon carries a status badge while
 * the foreground session runs.
 */
test('WEB38-P0-01 rail is vertical and activation shows exactly one panel', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1_600, height: 900 });
  const ui = workbenchUi(page);
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  await expect(ui.composer).toBeEnabled({ timeout: 30_000 });

  // Wide viewport keeps the dock; the vertical rail is always present.
  const rail = page.locator('#work-panel nav.work-panel-rail');
  await expect(rail).toBeVisible();
  await expect(rail).toHaveAttribute('aria-orientation', 'vertical');
  const icons = rail.getByRole('button');
  await expect(icons).toHaveCount(5);

  // Clicking the Git icon reveals the Git panel and marks the icon active.
  await rail.getByRole('button', { name: '打开Git面板' }).click();
  const detail = page.locator('#work-panel-detail');
  await expect(detail).toBeVisible();
  await expect(detail.locator('.work-panel-header h2')).toHaveText('Git');
  await expect(rail.getByRole('button', { name: '打开Git面板' })).toHaveAttribute(
    'aria-current',
    'page'
  );

  // No horizontal tab strip remains on the dock.
  await expect(page.locator('#work-panel [role="tablist"]')).toHaveCount(0);
});

test('WEB38-P0-02 re-clicking the active icon collapses back to the rail', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1_600, height: 900 });
  const ui = workbenchUi(page);
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  await expect(ui.composer).toBeEnabled({ timeout: 30_000 });

  const rail = page.locator('#work-panel nav.work-panel-rail');
  const reviewButton = rail.getByRole('button', { name: '打开审阅面板' });
  await reviewButton.click();
  await expect(page.locator('#work-panel-detail')).toBeVisible();

  // Re-click the active icon: content collapses, rail stays.
  await reviewButton.click();
  await expect(page.locator('#work-panel-detail')).toHaveCount(0);
  await expect(rail).toBeVisible();

  // Esc also collapses when the content has focus and is not an input.
  await reviewButton.click();
  await expect(page.locator('#work-panel-detail')).toBeVisible();
  await page.locator('#work-panel-detail').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#work-panel-detail')).toHaveCount(0);
});
