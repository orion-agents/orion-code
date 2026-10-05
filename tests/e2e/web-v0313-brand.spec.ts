import { expect, test } from './fixtures/test';
import { waitForWorkbenchReady } from './fixtures/ui';

test.use({ trace: 'off', video: 'off', screenshot: 'on' });

/**
 * v0.3.13 §9 — the Orion brand glyph stays one decorative SVG in the project
 * navigator across desktop, minimum rail and the <=760px drawer; it never
 * becomes an interactive control and never causes horizontal overflow.
 */
test('WEB33-P0-31 brand mark is a single decorative SVG next to ORION copy', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1_280, height: 900 });
  await waitForWorkbenchReady(page, { timeout: 30_000 });

  // v0.3.20 (baseline.md #9-10) — the v0.3.15 pixel-brand rework replaced the
  // old `.brand-row`/ORION header with the pixel wordmark in the expanded
  // navigator toolbar. The contract that survives: one decorative brand
  // surface, no interactive affordance, no overflow.
  const toolbarBrand = page.locator('.project-toolbar-brand');
  await expect(toolbarBrand).toBeVisible();
  const wordmark = toolbarBrand.locator('svg.pixel-wordmark');
  await expect(wordmark).toHaveCount(1);
  await expect(wordmark).toBeVisible();
  await expect(wordmark).toHaveAttribute('role', 'img');
  expect(await toolbarBrand.locator('button, a, [tabindex]').count()).toBe(0);

  const box = await wordmark.boundingBox();
  if (!box) throw new Error('the pixel wordmark is not measurable');
  // The pixel wordmark renders at 14px tall at scale 2 — a text-like logo, not
  // the old 18px glyph. It must be visible and measurable, not a sliver.
  expect(box.width).toBeGreaterThanOrEqual(18);
  expect(box.height).toBeGreaterThanOrEqual(12);

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
});

test('WEB33-P0-32 brand survives the minimum project rail and the narrow drawer', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1_280, height: 900 });
  await waitForWorkbenchReady(page, { timeout: 30_000 });

  // Collapse the project navigator to the minimum (48px) rail: the shared
  // brand glyph survives, nothing overlaps or overflows. v0.3.20 — the
  // collapse control is `收起项目导航` and the aside keeps the single stable
  // id `workspace-rail` in both states.
  const railSurface = page.locator('#workspace-rail');
  const collapse = railSurface.getByRole('button', { name: '收起项目导航' });
  await collapse.click();
  await expect(railSurface).toHaveClass(/project-navigator-collapsed/u, { timeout: 15_000 });
  await expect(railSurface.locator('.project-rail-brand[aria-hidden="true"]')).toBeVisible();
  await expect(railSurface.locator('.orion-brand-mark')).toBeVisible();
  await expect(railSurface.getByRole('button', { name: '展开项目导航' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );

  // Narrow viewport: the drawer carries the toolbar brand identity. The
  // drawer's only entry is the keyboard contract (v0.3.15 removed the header
  // toggle that used to open it).
  await page.setViewportSize({ width: 375, height: 800 });
  await page.waitForTimeout(600);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+b' : 'Control+b');
  await expect(page.locator('#workspace-rail.drawer-open')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.project-toolbar-brand').first()).toBeVisible({ timeout: 15_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
});
