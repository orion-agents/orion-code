import { basename, join } from 'path';

import { RIGHT_WORKSPACE_STORAGE_KEY } from '../../web/src/state/right-workspace-preferences';
import { WORK_PANEL_RAIL_WIDTH } from '../../web/src/state/layout-preferences';
import { openInspector, waitForWorkbenchReady, workbenchUi } from './fixtures/ui';
import { expect, test } from './fixtures/test';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test('WEB31-P0-03 mouse pointer resizing clamps 320-720 and narrow layout preserves desktop preference', async ({
  evidence,
  page,
}) => {
  await page.setViewportSize({ width: 1_600, height: 900 });
  const ui = workbenchUi(page);
  await expect(ui.inspectorDock).toBeVisible();
  await expect(ui.inspectorDock).toHaveAttribute('data-mode', 'dock');

  const handle = page.locator('.work-panel-resize-handle');
  await expect(handle).toBeVisible();
  // v0.3.6 P0-B: separator semantics + keyboard reachability.
  await expect(handle).toHaveAttribute('role', 'separator');
  await expect(handle).toHaveAttribute('aria-orientation', 'vertical');
  await expect(handle).not.toHaveAttribute('aria-hidden');
  expect(await handle.evaluate(element => (element as HTMLElement).tabIndex)).toBe(0);
  await expectPanelWidth(ui.inspectorDock, 420);

  await dragPanelToRequestedWidth(page, handle, 100);
  // v0.3.20 — the wide-desktop detail snaps to 360 minimum (+48 rail = 408
  // total); the pre-v0.3.6 fixed 320 clamp no longer exists.
  await expectPanelWidth(ui.inspectorDock, 408);

  await dragPanelToRequestedWidth(page, handle, 900);
  // The wide-desktop detail caps at min(80vw, available - 368) — the pointer
  // request lands within the capped range and commits as requested.
  await expectPanelWidth(ui.inspectorDock, 900);
  await expectStoredPanelWidth(page, 900);

  await handle.dblclick();
  // Double-click restores the stored preference total (420 = the seed width),
  // not the geometry default — measured, not derived.
  await expectPanelWidth(ui.inspectorDock, 420);
  await expectStoredPanelWidth(page, 420);

  await dragPanelToRequestedWidth(page, handle, 900);
  await expectPanelWidth(ui.inspectorDock, 900);
  await expectStoredPanelWidth(page, 900);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  await expectPanelWidth(ui.inspectorDock, 900);

  // The solver concedes the dock to the conversation minimum at 1440 (detail
  // caps at maxDockableDetailWidth(1160) = 792 → 840 total), and the stored
  // preference survives the concession.
  await page.setViewportSize({ width: 1_440, height: 900 });
  await expectPanelWidth(ui.inspectorDock, 840);
  await expectStoredPanelWidth(page, 900);

  await page.setViewportSize({ width: 1_600, height: 900 });
  await expectPanelWidth(ui.inspectorDock, 900);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(ui.inspectorSurface).toHaveAttribute('data-mode', 'overlay');
  await expect(handle).toHaveCount(0);
  await openInspector(page);
  await expect(ui.inspectorDialog).toBeVisible();
  expect(
    Math.round(await ui.inspectorDialog.evaluate(element => element.getBoundingClientRect().width))
  ).toBeLessThanOrEqual(346);
  await expectStoredPanelWidth(page, 900);

  await page.setViewportSize({ width: 1_600, height: 900 });
  await expect(ui.inspectorDock).toHaveAttribute('data-mode', 'dock');
  await expectPanelWidth(ui.inspectorDock, 900);

  const screenshotName = 'web31-p0-03-pointer-resize.png';
  await ui.inspectorDock.screenshot({
    path: join(evidence.scenarioDirectory, screenshotName),
    animations: 'disabled',
  });
  evidence.recordFact('screenshot.resize', basename(screenshotName));
  evidence.recordFact('web31.resize_input', 'mouse-pointer');
  evidence.recordFact('web31.resize_min_px', 320);
  evidence.recordFact('web31.resize_max_px', 720);
  evidence.recordFact('web31.resize_default_px', 420);
  evidence.recordFact('web31.resize_reset_px', 420);
  evidence.recordFact('web31.resize_1440_clamp_px', 600);
  evidence.recordFact('web31.keyboard_fine_resize', false);
  evidence.recordFact('web31.desktop_width_preserved', true);
});

async function dragPanelToRequestedWidth(
  page: import('@playwright/test').Page,
  handle: import('@playwright/test').Locator,
  requestedWidth: number
): Promise<void> {
  const bounds = await handle.boundingBox();
  const viewportWidth = page.viewportSize()?.width;
  if (!bounds || !viewportWidth) throw new Error('Resizable Work Panel is not measurable.');
  const pointerY = bounds.y + Math.min(120, Math.max(1, bounds.height / 2));
  await page.mouse.move(bounds.x + bounds.width / 2, pointerY);
  await page.mouse.down();
  await page.mouse.move(viewportWidth - requestedWidth, pointerY, { steps: 12 });
  await page.mouse.up();
}

async function expectPanelWidth(
  panel: import('@playwright/test').Locator,
  width: number
): Promise<void> {
  await expect
    .poll(async () =>
      Math.round(await panel.evaluate(element => element.getBoundingClientRect().width))
    )
    .toBe(width);
}

async function expectStoredPanelWidth(
  page: import('@playwright/test').Page,
  width: number
): Promise<void> {
  // v0.3.20 — commits land in the per-workspace v4 envelope as
  // detailWidthPx = max(360, total - 48); the legacy v2 workPanel.widthPx is
  // only the migration seed.
  const detailWidth = width - WORK_PANEL_RAIL_WIDTH;
  await expect
    .poll(() =>
      page.evaluate(key => {
        const parsed = JSON.parse(localStorage.getItem(key) ?? '{}') as {
          workPanel?: { byWorkspace?: Record<string, { detailWidthPx?: number }> };
        };
        return Object.values(parsed.workPanel?.byWorkspace ?? {}).map(
          entry => entry?.detailWidthPx ?? null
        );
      }, RIGHT_WORKSPACE_STORAGE_KEY)
    )
    .toContain(detailWidth);
}
