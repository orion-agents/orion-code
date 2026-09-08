import { expect, test } from './fixtures/test';
import { waitForWorkbenchReady } from './fixtures/ui';

test.use({ trace: 'off', video: 'off', screenshot: 'on' });

/**
 * v0.3.13 — Files/Review column placement regression. The previous fix only set
 * `grid-column`, so CSS Grid auto-placement pushed the second child into an
 * implicit second row (content bottom-left, navigator top-right). These
 * bounding-box assertions catch that directly: both panes must share one grid
 * row with equal top and height.
 */
async function assertSameRow(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  leftSelector: string,
  rightSelector: string
): Promise<void> {
  const left = await page.locator(leftSelector).boundingBox();
  const right = await page.locator(rightSelector).boundingBox();
  expect(left).not.toBeNull();
  expect(right).not.toBeNull();
  expect(left.x).toBeLessThan(right.x);
  expect(Math.abs(left.y - right.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(left.height - right.height)).toBeLessThanOrEqual(1);
}

test('WEB33-P0-16 Files puts preview left of the tree on one grid row', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1_600, height: 900 });
  await waitForWorkbenchReady(page, { timeout: 30_000 });

  // Open the Files panel from the vertical rail.
  await page.locator('.work-panel-rail-button[data-work-panel-id="files"]').click();
  // The fixture default detail width sits below the 620px split threshold;
  // widen the docked panel to its max so the split geometry applies.
  const dockGrip = page.getByRole('separator', { name: /调整工作面板宽度/u });
  await dockGrip.focus();
  await page.keyboard.press('End');
  await page.waitForTimeout(400);
  const layout = page.locator('.resource-split-layout');
  const tree = page.locator('[aria-label="工作区文件"]');
  const preview = page.locator('[aria-label="文件预览"]');
  await expect(layout).toBeVisible();
  await expect(tree).toBeVisible();
  await expect(preview).toBeVisible();

  // v0.3.13 S2 — the inner separator sits between content and navigator.
  const handle = page.getByRole('separator', { name: '调整文件目录宽度' });
  await expect(handle).toBeVisible();
  const handleBox = await handle.boundingBox();
  const previewBox = await preview.boundingBox();
  const treeBox = await tree.boundingBox();
  expect(handleBox).not.toBeNull();
  // The separator's hit area overlaps the boundary between the two columns.
  expect(handleBox.x).toBeGreaterThanOrEqual(previewBox.x);
  expect(handleBox.x).toBeLessThan(treeBox.x + treeBox.width);

  // Select the first file node so the preview renders content.
  const firstFile = tree.locator('.file-node').first();
  if ((await firstFile.count()) > 0) {
    await firstFile.click();
    await expect(preview.locator('header strong').first()).toBeVisible({ timeout: 30_000 });
  }

  await assertSameRow(page, '[aria-label="文件预览"]', '[aria-label="工作区文件"]');
  await page.screenshot({ path: 'test-results/v0313-files-wide.png', fullPage: false });
});

test('WEB33-P0-17 Review puts diff left of the file list on one grid row', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1_600, height: 900 });
  await waitForWorkbenchReady(page, { timeout: 30_000 });

  await page.locator('.work-panel-rail-button[data-work-panel-id="review"]').click();
  // Widen the docked panel past the 620px stack threshold.
  const dockGrip = page.getByRole('separator', { name: /调整工作面板宽度/u });
  await dockGrip.focus();
  await page.keyboard.press('End');
  await page.waitForTimeout(400);
  const diff = page.locator('[aria-label="审阅 Diff"]');
  const list = page.locator('[aria-label="待审阅文件"]');
  await expect(list).toBeVisible({ timeout: 30_000 });
  await expect(diff).toBeVisible({ timeout: 30_000 });
  // v0.3.13 S2 — the review panel exposes its own inner separator.
  await expect(page.getByRole('separator', { name: '调整待审阅文件列表宽度' })).toBeVisible();
  await assertSameRow(page, '[aria-label="审阅 Diff"]', '[aria-label="待审阅文件"]');
});

test('WEB33-P0-18 narrow Files container stacks navigator above content', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1_600, height: 900 });
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  await page.locator('.work-panel-rail-button[data-work-panel-id="files"]').click();

  // Shrink the docked detail surface to its minimum (Home): the files
  // container drops below 620px and the layout stacks into one column.
  const dockGrip = page.getByRole('separator', { name: /调整工作面板宽度/u });
  await dockGrip.focus();
  await page.keyboard.press('Home');
  await page.waitForTimeout(400);

  const tree = page.locator('[aria-label="工作区文件"]');
  const preview = page.locator('[aria-label="文件预览"]');
  await expect(tree).toBeVisible({ timeout: 30_000 });
  await expect(preview).toBeVisible({ timeout: 30_000 });

  const treeBox = await tree.boundingBox();
  const previewBox = await preview.boundingBox();
  expect(treeBox).not.toBeNull();
  expect(previewBox).not.toBeNull();
  expect(treeBox.y).toBeLessThan(previewBox.y);
  expect(Math.abs(treeBox.width - previewBox.width)).toBeLessThanOrEqual(1);
  // v0.3.13 S2 — a single-column container hides the inner separator.
  await expect(page.getByRole('separator', { name: '调整文件目录宽度' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  await page.screenshot({ path: 'test-results/v0313-files-narrow.png', fullPage: false });
});
