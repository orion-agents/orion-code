import { basename, join } from 'path';

import { expect, test } from './fixtures/test';
import {
  collapseInspector,
  openInspector,
  openSessionNavigation,
  openSettings,
  workbenchUi,
} from './fixtures/ui';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test('WEB33-P0-23 right rail remains in the shell across collapse and breakpoint round-trips', async ({
  evidence,
  page,
}) => {
  await page.setViewportSize({ width: 1_920, height: 900 });
  const ui = workbenchUi(page);
  const panel = page.locator('#work-panel');
  const shell = page.locator('.workbench-shell');

  await openInspector(page);
  const initialWidth = await elementWidth(panel);
  expect(initialWidth).toBeGreaterThanOrEqual(320);
  await collapseInspector(page);
  await expect.poll(() => elementWidth(panel)).toBe(48);

  let maximumOverflow = 0;
  for (const width of [1_920, 1_440, 1_181, 1_180, 1_024, 760, 390, 320, 1_440]) {
    await page.setViewportSize({ width, height: width <= 390 ? 780 : 900 });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
    await expect
      .poll(async () => (await shellGeometry(page)).shellDisplay, {
        message: `Workbench shell must settle as a grid at ${width}px.`,
      })
      .toBe('grid');
    if (width >= 1_181) {
      await expect
        .poll(() => elementWidth(panel), {
          message: `Collapsed Work Panel must settle at 48px at ${width}px.`,
        })
        .toBe(48);
    } else {
      await expect(panel).toBeHidden();
    }
    const geometry = await shellGeometry(page);
    expect(geometry.mainTop).toBeCloseTo(geometry.shellTop, 0);
    expect(geometry.mainBottom).toBeCloseTo(geometry.shellBottom, 0);
    expect(geometry.mainRight).toBeLessThanOrEqual(geometry.shellRight + 1);
    if (width >= 1_181) {
      expect(geometry.panelPosition).not.toBe('fixed');
      expect(geometry.panelWidth).toBeCloseTo(48, 0);
      expect(geometry.panelRight).toBeCloseTo(geometry.shellRight, 0);
      expect(geometry.panelTop).toBeCloseTo(geometry.shellTop, 0);
      expect(geometry.panelBottom).toBeCloseTo(geometry.shellBottom, 0);
      expect(geometry.mainRight).toBeLessThanOrEqual(geometry.panelLeft + 1);
    } else {
      expect(geometry.panelPosition).toBe('fixed');
      expect(geometry.panelVisible).toBe(false);
    }
    maximumOverflow = Math.max(maximumOverflow, await horizontalOverflow(page));
  }

  await expect(ui.inspectorDock).toBeVisible();
  await expect(ui.inspectorShortcuts).toBeVisible();
  await expect(panel).toHaveAttribute('data-state', 'collapsed');
  await expect.poll(() => elementWidth(panel)).toBe(48);
  const screenshotName = 'web33-p0-23-right-rail.png';
  await shell.screenshot({
    path: join(evidence.scenarioDirectory, screenshotName),
    animations: 'disabled',
  });

  await openInspector(page);
  await expect.poll(() => elementWidth(panel)).toBe(initialWidth);
  const activeTab = page.getByRole('tab', { name: /^Agent/u });
  await activeTab.focus();
  await page.getByRole('button', { name: '折叠工作面板', exact: true }).click();
  const activeRailButton = ui.inspectorShortcuts.getByRole('button', {
    name: '打开Agent面板',
    exact: true,
  });
  await expect(activeRailButton).toBeFocused();

  expect(maximumOverflow).toBe(0);
  evidence.recordFact('screenshot.shell-right-rail', basename(screenshotName));
  evidence.recordFact('web33.shell_viewport_matrix', '320,390,760,1024,1180,1181,1440,1920');
  evidence.recordFact('web33.work_panel_rail_px', 48);
  evidence.recordFact('web33.shell_geometry_invariant', true);
  evidence.recordFact('web33.shell_horizontal_overflow', maximumOverflow);
  evidence.recordFact('web33.desktop_panel_preference_restored', true);
  evidence.recordFact('web33.shell_focus_restored', true);
});

test('WEB33-P0-24 Settings has one persistent entry in the project navigation only', async ({
  evidence,
  page,
}) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  const ui = workbenchUi(page);
  const allSettingsButtons = page.getByRole('button', { name: '打开设置', exact: true });
  await expect(allSettingsButtons).toHaveCount(1);
  await expect(ui.settingsButton).toBeVisible();
  await expect(
    page.locator('.conversation-header').getByRole('button', { name: '打开设置' })
  ).toHaveCount(0);
  await expect(
    page.locator('.work-panel-header').getByRole('button', { name: '打开设置' })
  ).toHaveCount(0);

  await ui.settingsButton.focus();
  await ui.settingsButton.press('Enter');
  await expect(ui.settingsDialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(ui.settingsDialog).toBeHidden();
  await expect(ui.settingsButton).toBeFocused();

  await ui.workspaceRail.getByRole('button', { name: '折叠项目导航' }).click();
  await expect(allSettingsButtons).toHaveCount(1);
  await expect(ui.settingsButton).toBeVisible();
  await openSettings(page);
  await page.keyboard.press('Escape');
  await expect(ui.settingsButton).toBeFocused();

  await page.setViewportSize({ width: 390, height: 780 });
  await openSessionNavigation(page);
  await expect(allSettingsButtons).toHaveCount(1);
  await ui.settingsButton.click();
  await expect(ui.settingsDialog).toBeVisible();
  await expect(ui.workspaceRail).not.toHaveClass(/drawer-open/u);
  await expect(page.locator('[aria-modal="true"]')).toHaveCount(1);

  const screenshotName = 'web33-p0-24-settings-entry.png';
  await ui.settingsDialog.screenshot({
    path: join(evidence.scenarioDirectory, screenshotName),
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await expect(ui.settingsDialog).toBeHidden();
  await expect(ui.workspaceRail).toHaveClass(/drawer-open/u);
  await expect(ui.settingsButton).toBeFocused();

  evidence.recordFact('screenshot.settings-entry', basename(screenshotName));
  evidence.recordFact('web33.persistent_settings_buttons', 1);
  evidence.recordFact('web33.settings_location', 'project-navigation-footer');
  evidence.recordFact('web33.header_settings_buttons', 0);
  evidence.recordFact('web33.drawer_modal_exclusive', true);
  evidence.recordFact('web33.settings_focus_restored', true);
});

async function elementWidth(locator: import('@playwright/test').Locator): Promise<number> {
  return locator.evaluate(element => element.getBoundingClientRect().width);
}

async function horizontalOverflow(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() =>
    Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
  );
}

async function shellGeometry(page: import('@playwright/test').Page): Promise<{
  readonly shellDisplay: string;
  readonly shellTop: number;
  readonly shellRight: number;
  readonly shellBottom: number;
  readonly mainTop: number;
  readonly mainRight: number;
  readonly mainBottom: number;
  readonly panelPosition: string;
  readonly panelVisible: boolean;
  readonly panelLeft: number;
  readonly panelTop: number;
  readonly panelRight: number;
  readonly panelBottom: number;
  readonly panelWidth: number;
}> {
  return page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>('.workbench-shell');
    const main = document.querySelector<HTMLElement>('.conversation-column');
    const panel = document.querySelector<HTMLElement>('#work-panel');
    if (!shell || !main || !panel) throw new Error('Workbench shell geometry is unavailable.');
    const shellRect = shell.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const panelStyle = getComputedStyle(panel);
    return {
      shellDisplay: getComputedStyle(shell).display,
      shellTop: shellRect.top,
      shellRight: shellRect.right,
      shellBottom: shellRect.bottom,
      mainTop: mainRect.top,
      mainRight: mainRect.right,
      mainBottom: mainRect.bottom,
      panelPosition: panelStyle.position,
      panelVisible: panelStyle.visibility !== 'hidden' && panelRect.right > 0,
      panelLeft: panelRect.left,
      panelTop: panelRect.top,
      panelRight: panelRect.right,
      panelBottom: panelRect.bottom,
      panelWidth: panelRect.width,
    };
  });
}
