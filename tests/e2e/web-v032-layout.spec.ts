import { basename, join } from 'path';

import { waitForWorkbenchReady, workbenchUi } from './fixtures/ui';
import { expect, test } from './fixtures/test';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test('WEB32-P0-01 left project rail pointer resize, reset, collapse and persistence', async ({
  evidence,
  page,
}) => {
  await page.setViewportSize({ width: 1_600, height: 900 });
  const ui = workbenchUi(page);
  const rail = ui.workspaceRail;
  const handle = page.locator('.panel-resize-handle-left');
  await expect(rail).toBeVisible();
  await expect(handle).toBeVisible();
  // v0.3.6 P0-B: the separator is now keyboard-reachable and announces itself.
  await expect(handle).toHaveAttribute('role', 'separator');
  await expect(handle).toHaveAttribute('aria-orientation', 'vertical');
  await expect(handle).toHaveAttribute('aria-valuemin', '0');
  await expect(handle).toHaveAttribute('aria-valuemax', '100');
  await expect(handle).toHaveAttribute('aria-valuetext', /像素/u);
  await expect(handle).not.toHaveAttribute('aria-hidden');
  expect(await handle.evaluate(element => (element as HTMLElement).tabIndex)).toBe(0);
  await expectElementWidth(rail, 280);

  await dragLeftRailToRequestedWidth(page, handle, 100);
  await expectElementWidth(rail, 240);

  await dragLeftRailToRequestedWidth(page, handle, 900);
  await expectElementWidth(rail, 480);

  await handle.dblclick();
  await expectElementWidth(rail, 280);
  await expectStoredWidths(page, { left: 280 });

  await dragLeftRailToRequestedWidth(page, handle, 480);
  await expectStoredWidths(page, { left: 480 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  await expectElementWidth(rail, 480);

  await rail.getByRole('button', { name: '折叠项目导航' }).click();
  await expectElementWidth(rail, 48);
  await expect(rail.getByRole('button', { name: '展开项目导航' })).toBeVisible();
  await rail.getByRole('button', { name: '展开项目导航' }).click();
  await expectElementWidth(rail, 480);

  const screenshotName = 'web32-p0-01-left-project-rail.png';
  await rail.screenshot({
    path: join(evidence.scenarioDirectory, screenshotName),
    animations: 'disabled',
  });
  evidence.recordFact('screenshot.left-project-rail', basename(screenshotName));
  evidence.recordFact('web32.left_resize_input', 'mouse-pointer');
  evidence.recordFact('web36.left_separator_keyboard_reachable', true);
  evidence.recordFact('web32.left_resize_min_px', 240);
  evidence.recordFact('web32.left_resize_default_px', 280);
  evidence.recordFact('web32.left_resize_max_px', 480);
  evidence.recordFact('web32.left_resize_reset_px', 280);
  evidence.recordFact('web32.left_rail_px', 48);
  evidence.recordFact('web32.left_width_persisted', true);
});

test('WEB32-P0-02 right panel concedes before the center drops below 560 and preferences restore', async ({
  evidence,
  page,
}) => {
  await page.setViewportSize({ width: 1_800, height: 900 });
  const ui = workbenchUi(page);
  const leftHandle = page.locator('.panel-resize-handle-left');
  const rightHandle = page.locator('.panel-resize-handle-right');
  await expect(leftHandle).toBeVisible();
  await expect(rightHandle).toBeVisible();
  await dragLeftRailToRequestedWidth(page, leftHandle, 480);
  await dragRightPanelToRequestedWidth(page, rightHandle, 720);
  await expectElementWidth(ui.workspaceRail, 480);
  await expectElementWidth(ui.inspectorDock, 720);
  await expectStoredWidths(page, { left: 480, right: 720 });

  await page.setViewportSize({ width: 1_440, height: 900 });
  await expectElementWidth(ui.workspaceRail, 480);
  await expectElementWidth(ui.inspectorDock, 400);
  await expectElementWidth(ui.main, 560);
  await expectStoredWidths(page, { left: 480, right: 720 });

  await page.setViewportSize({ width: 1_360, height: 900 });
  await expect(ui.inspectorDock).toHaveAttribute('data-mode', 'dock');
  await expectElementWidth(ui.inspectorDock, 320);
  await expectMinimumElementWidth(ui.main, 560);

  await page.setViewportSize({ width: 1_800, height: 900 });
  await expectElementWidth(ui.workspaceRail, 480);
  await expectElementWidth(ui.inspectorDock, 720);
  await expectElementWidth(ui.main, 600);

  const screenshotName = 'web32-p0-02-center-concession.png';
  await page.locator('.workbench-shell').screenshot({
    path: join(evidence.scenarioDirectory, screenshotName),
    animations: 'disabled',
  });
  evidence.recordFact('screenshot.center-concession', basename(screenshotName));
  evidence.recordFact('web32.center_min_px', 560);
  evidence.recordFact('web32.right_concession_verified', true);
  evidence.recordFact('web32.desktop_widths_restored', true);
});

test('WEB32-P0-03 320-1440 responsive drawers are exclusive, focused and overflow-free', async ({
  evidence,
  page,
}) => {
  await page.setViewportSize({ width: 1_800, height: 900 });
  const ui = workbenchUi(page);
  await dragLeftRailToRequestedWidth(page, page.locator('.panel-resize-handle-left'), 480);
  await dragRightPanelToRequestedWidth(page, page.locator('.panel-resize-handle-right'), 720);
  await expectStoredWidths(page, { left: 480, right: 720 });

  let maximumOverflow = 0;
  for (const width of [1_440, 1_180, 1_024, 760, 390, 320]) {
    await page.setViewportSize({ width, height: width <= 390 ? 844 : 900 });
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.clientWidth))
      .toBe(width);
    maximumOverflow = Math.max(maximumOverflow, await horizontalOverflow(page));
    if (width <= 760) {
      await expect(page.locator('.workbench-shell')).toHaveClass(/project-navigation-drawer/u);
      await expect(ui.inspectorSurface).toHaveAttribute('data-mode', 'overlay');
    }
  }
  expect(maximumOverflow).toBe(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await ui.navigationButton.focus();
  await ui.navigationButton.click();
  await expect(ui.navigationButton).toHaveAttribute('aria-expanded', 'true');
  await expect(ui.workspaceRail).toHaveClass(/drawer-open/u);
  await expect(ui.workspaceRail.getByRole('button', { name: '关闭项目导航' })).toBeFocused();
  await expect(ui.inspectorDialog).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(ui.workspaceRail).not.toHaveClass(/drawer-open/u);
  await expect(ui.navigationButton).toBeFocused();

  await ui.inspectorButton.focus();
  await ui.inspectorButton.click();
  await expect(ui.inspectorDialog).toBeVisible();
  await expect(ui.workspaceRail).not.toHaveClass(/drawer-open/u);
  await expect(ui.inspectorDialog.getByRole('button', { name: '关闭工作面板' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(ui.inspectorDialog).toBeHidden();
  await expect(ui.inspectorButton).toBeFocused();

  const screenshotName = 'web32-p0-03-mobile-drawers.png';
  await ui.main.screenshot({
    path: join(evidence.scenarioDirectory, screenshotName),
    animations: 'disabled',
  });

  await page.setViewportSize({ width: 1_800, height: 900 });
  await expectElementWidth(ui.workspaceRail, 480);
  await expectElementWidth(ui.inspectorDock, 720);
  await expectStoredWidths(page, { left: 480, right: 720 });

  evidence.recordFact('screenshot.mobile-drawers', basename(screenshotName));
  evidence.recordFact('web32.viewport_matrix', '320,390,760,1024,1180,1440');
  evidence.recordFact('web32.drawers_mutually_exclusive', true);
  evidence.recordFact('web32.drawer_focus_verified', true);
  evidence.recordFact('web32.desktop_preferences_preserved', true);
  evidence.recordFact('web32.horizontal_overflow', maximumOverflow);
});

async function dragLeftRailToRequestedWidth(
  page: import('@playwright/test').Page,
  handle: import('@playwright/test').Locator,
  requestedWidth: number
): Promise<void> {
  const bounds = await handle.boundingBox();
  const shell = await page.locator('.workbench-shell').boundingBox();
  if (!bounds || !shell) throw new Error('Project navigation resize handle is not measurable.');
  const pointer = await resizeHandleHitPoint(handle);
  const pointerY = pointer.y;
  await page.mouse.move(pointer.x, pointerY);
  await page.mouse.down();
  await page.mouse.move(shell.x + requestedWidth, pointerY, { steps: 12 });
  await page.mouse.up();
}

async function dragRightPanelToRequestedWidth(
  page: import('@playwright/test').Page,
  handle: import('@playwright/test').Locator,
  requestedWidth: number
): Promise<void> {
  const bounds = await handle.boundingBox();
  const shell = await page.locator('.workbench-shell').boundingBox();
  if (!bounds || !shell) throw new Error('Work Panel resize handle is not measurable.');
  const pointer = await resizeHandleHitPoint(handle);
  const pointerY = pointer.y;
  await page.mouse.move(pointer.x, pointerY);
  await page.mouse.down();
  await page.mouse.move(shell.x + shell.width - requestedWidth, pointerY, { steps: 12 });
  await page.mouse.up();
}

async function expectElementWidth(
  element: import('@playwright/test').Locator,
  expected: number
): Promise<void> {
  await expect
    .poll(async () =>
      Math.round(await element.evaluate(node => node.getBoundingClientRect().width))
    )
    .toBe(expected);
}

async function expectMinimumElementWidth(
  element: import('@playwright/test').Locator,
  minimum: number
): Promise<void> {
  await expect
    .poll(async () =>
      Math.round(await element.evaluate(node => node.getBoundingClientRect().width))
    )
    .toBeGreaterThanOrEqual(minimum);
}

async function expectStoredWidths(
  page: import('@playwright/test').Page,
  expected: { readonly left?: number; readonly right?: number }
): Promise<void> {
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const raw = localStorage.getItem('orion.web.workbench-layout.v2');
        if (!raw) return null;
        const value = JSON.parse(raw) as {
          projectNavigation?: { widthPx?: number };
          workPanel?: { widthPx?: number };
        };
        return {
          left: value.projectNavigation?.widthPx,
          right: value.workPanel?.widthPx,
        };
      })
    )
    .toMatchObject({
      ...(expected.left === undefined ? {} : { left: expected.left }),
      ...(expected.right === undefined ? {} : { right: expected.right }),
    });
}

async function horizontalOverflow(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() =>
    Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
  );
}

async function resizeHandleHitPoint(
  handle: import('@playwright/test').Locator
): Promise<{ readonly x: number; readonly y: number }> {
  const point = await handle.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const y = bounds.top + Math.min(120, Math.max(1, bounds.height / 2));
    for (let offset = 1; offset < Math.max(2, Math.floor(bounds.width) - 1); offset += 1) {
      const x = bounds.left + offset;
      if (element.contains(document.elementFromPoint(x, y))) return { x, y };
    }
    return null;
  });
  if (!point) throw new Error('Resize handle has no pointer-reachable hit-test point.');
  return point;
}
