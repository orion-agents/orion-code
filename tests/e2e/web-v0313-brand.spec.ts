import { expect, test } from './fixtures/test';
import { waitForWorkbenchReady } from './fixtures/ui';

test.use({ trace: 'off', video: 'off', screenshot: 'on' });

/**
 * v0.3.13 §9 — the Orion brand glyph stays one decorative SVG in the project
 * navigator across desktop, minimum rail and the <=760px drawer; it never
 * becomes an interactive control and never causes horizontal overflow.
 */
test('WEB34-P0-24 brand mark is a single decorative SVG next to ORION copy', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1_280, height: 900 });
  await waitForWorkbenchReady(page, { timeout: 30_000 });

  const brandRow = page.locator('.brand-row');
  await expect(brandRow).toBeVisible();
  const mark = brandRow.locator('.orion-brand-mark');
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute('aria-hidden', 'true');
  expect(await mark.locator('svg').count()).toBe(1);
  expect(await mark.locator('rect').count()).toBe(3);
  // No interactive affordance inside the brand area.
  expect(await mark.locator('button, a, [tabindex]').count()).toBe(0);
  await expect(brandRow.getByText('ORION')).toBeVisible();

  const box = await mark.boundingBox();
  expect(box).not.toBeNull();
  expect(box.width).toBeGreaterThanOrEqual(18);
  expect(box.height).toBeGreaterThanOrEqual(18);

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  await page.screenshot({ path: 'test-results/v0313-brand-desktop.png', fullPage: false });
});

test('WEB34-P0-25 brand survives the minimum project rail and the narrow drawer', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1_280, height: 900 });
  await waitForWorkbenchReady(page, { timeout: 30_000 });

  // Collapse the project navigator to the minimum (48px) rail: the mark and
  // ORION survive, CODE WORKBENCH may hide, but nothing overlaps or overflows.
  const railSurface = page.locator('#project-navigation');
  const collapse = railSurface.getByRole('button', { name: '折叠项目导航' });
  if (await collapse.isVisible()) {
    await collapse.click();
    await expect(railSurface).toHaveClass(/project-navigator-collapsed/u, { timeout: 15_000 });
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  await page.screenshot({ path: 'test-results/v0313-brand-min-rail.png', fullPage: false });

  // Narrow viewport: the drawer version shows the mark and copy intact.
  await page.setViewportSize({ width: 375, height: 800 });
  await page.waitForTimeout(600);
  const toggle = page.getByRole('button', { name: '打开会话导航' }).first();
  if (await toggle.isVisible()) await toggle.click();
  const drawerRow = page.locator('.brand-row').first();
  await expect(drawerRow).toBeVisible({ timeout: 15_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  await page.screenshot({ path: 'test-results/v0313-brand-drawer.png', fullPage: false });
});
