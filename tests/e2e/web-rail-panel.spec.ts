import { expect, test } from './fixtures/test';
import { createSession, waitForWorkbenchReady, workbenchUi } from './fixtures/ui';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

/**
 * v0.3.8 Work panel vertical-rail flow (S1–S4): the rail stays vertical on the
 * right, clicking an icon shows exactly that panel, re-clicking collapses the
 * content back to the rail.
 *
 * v0.3.20 (S0 drift #1-2, baseline.md): the composer requires a session and a
 * configured model (since v0.3.2, `e4c1979`) — the placeholder「选择会话并配置模型后开始」
 * is that contract — so the readiness assertion moved behind `createSession`.
 * The rail's verticality is asserted by geometry, not by an ARIA attribute:
 * `role=navigation` admits no `aria-orientation`, so the old
 * `aria-orientation="vertical"` assertion was asserting the very violation axe
 * flags (baseline.md D1).
 */
test('WEB33-P0-13 rail is vertical and activation shows exactly one panel', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1_600, height: 900 });
  const ui = workbenchUi(page);
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  await createSession(page, { name: 'Rail verticality session' });
  await expect(ui.composer).toBeEnabled({ timeout: 30_000 });

  // Wide viewport keeps the dock; the vertical rail is always present.
  const rail = page.locator('#work-panel nav.work-panel-rail');
  await expect(rail).toBeVisible();
  // v0.3.12/15 added three rail utilities (帮助 / 主题 / 停靠开关) after the spacer,
  // so the total button count is 8; the five *panels* carry data-work-panel-id.
  const panelButtons = rail.locator('[data-work-panel-id]');
  await expect(panelButtons).toHaveCount(5);
  const icons = rail.getByRole('button');
  await expect(icons).toHaveCount(8);

  // Vertical by geometry: taller than wide, one column of stacked buttons.
  const railBox = await rail.boundingBox();
  expect(railBox).not.toBeNull();
  expect((railBox as { height: number }).height).toBeGreaterThan(
    (railBox as { width: number }).width
  );
  const buttonBoxes = await icons.evaluateAll(nodes =>
    nodes.map(node => {
      const rect = node.getBoundingClientRect();
      return { centerX: rect.x + rect.width / 2, y: rect.y, bottom: rect.bottom };
    })
  );
  expect(buttonBoxes.length).toBe(8);
  for (let index = 1; index < buttonBoxes.length; index += 1) {
    // Stacked: each button begins at or below the previous button's bottom edge.
    expect(buttonBoxes[index].y).toBeGreaterThanOrEqual(buttonBoxes[index - 1].bottom - 1);
    // Same column: the icons differ (17/18px), so align on centres with a small
    // tolerance rather than on the raw left edge.
    expect(
      Math.abs(buttonBoxes[index].centerX - buttonBoxes[index - 1].centerX)
    ).toBeLessThanOrEqual(6);
  }

  // Clicking the Git icon reveals the Git panel and marks the icon active.
  // v0.3.20: the dock no longer renders a `.work-panel-header h2` — since the
  // banner-free chrome (#255) each panel carries its own content, so the
  // activation contract is the panel body plus the rail's aria-current. The
  // default workspace fixture is not a git repository, and the panel says so
  // honestly (the G317-22 contract) instead of pretending to have changes.
  await rail.getByRole('button', { name: '打开Git面板' }).click();
  const detail = page.locator('#work-panel-detail');
  await expect(detail).toBeVisible();
  const gitPane = detail.locator('[role="tabpanel"][aria-label="Git"]');
  await expect(gitPane).toBeVisible();
  await expect(gitPane.getByText('当前项目不是 Git 仓库')).toBeVisible();
  await expect(rail.getByRole('button', { name: '打开Git面板' })).toHaveAttribute(
    'aria-current',
    'page'
  );

  // No horizontal tab strip remains on the dock.
  await expect(page.locator('#work-panel [role="tablist"]')).toHaveCount(0);
});

test('WEB33-P0-14 re-clicking the active icon collapses back to the rail', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1_600, height: 900 });
  const ui = workbenchUi(page);
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  await createSession(page, { name: 'Rail collapse session' });
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
