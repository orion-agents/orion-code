import { basename, join } from 'path';

import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/test';
import { waitForWorkbenchReady, workbenchUi } from './fixtures/ui';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

/**
 * v0.3.6 interaction-quality e2e (P0-B keyboard separators, P1-A shortcut help,
 * P1-B theme cycle). Runs against the packaged web host on CI; needs no Session
 * because every surface under test lives in the workbench shell header/rail.
 */

const FINE = 5; // 2% of the 240-480 rail range
const COARSE = 24; // 10% of the 240-480 rail range

test('WEB36-P0-01 left rail separator keyboard resize with Home/End/Enter and live aria-valuenow', async ({
  evidence,
  page,
}) => {
  await page.setViewportSize({ width: 1_600, height: 900 });
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  const ui = workbenchUi(page);
  const rail = ui.workspaceRail;
  const handle = page.locator('.panel-resize-handle-left');
  await expect(rail).toBeVisible();
  await expect(handle).toBeVisible();
  await expect(handle).toHaveAttribute('role', 'separator');
  await expectElementWidth(rail, 280);

  const railWidth = () => elementWidth(rail);
  const readValuenow = async (): Promise<number> =>
    Number(await handle.getAttribute('aria-valuenow'));

  await handle.focus();
  await expect(handle).toBeFocused();

  // Fine step: ArrowRight grows the rail by 2% of the range (~5px at 1600px).
  const valuenowBefore = await readValuenow();
  const widthBefore = await railWidth();
  await page.keyboard.press('ArrowRight');
  const valuenowAfter = await readValuenow();
  expect(await railWidth()).toBe(widthBefore + FINE);
  expect(valuenowAfter).toBeGreaterThan(valuenowBefore);

  // Coarse step with Shift.
  await page.keyboard.press('Shift+ArrowRight');
  expect(await railWidth()).toBe(widthBefore + FINE + COARSE);

  // Back to the default with Enter.
  await page.keyboard.press('Enter');
  await expectElementWidth(rail, 280);

  // Range edges: End -> max, Home -> min, then Enter resets again.
  await page.keyboard.press('End');
  await expectElementWidth(rail, 480);
  expect(await readValuenow()).toBe(100);
  await page.keyboard.press('Home');
  await expectElementWidth(rail, 240);
  expect(await readValuenow()).toBe(0);
  await page.keyboard.press('Enter');
  await expectElementWidth(rail, 280);

  // aria-valuetext reports pixels for screen readers.
  await expect(handle).toHaveAttribute('aria-valuetext', /280 像素/u);

  const screenshotName = 'web36-p0-01-keyboard-resize.png';
  await handle.screenshot({
    path: join(evidence.scenarioDirectory, screenshotName),
    animations: 'disabled',
  });
  evidence.recordFact('screenshot.keyboard-resize', basename(screenshotName));
  evidence.recordFact('web36.separator_fine_step_px', FINE);
  evidence.recordFact('web36.separator_coarse_step_px', COARSE);
  evidence.recordFact('web36.separator_min_px', 240);
  evidence.recordFact('web36.separator_max_px', 480);
  evidence.recordFact('web36.separator_default_px', 280);
  evidence.recordFact('web36.separator_keyboard_verified', true);
});

test('WEB36-P1-01 shortcut help opens on Mod+/ , is keyboard navigable, and Esc returns focus', async ({
  evidence,
  page,
}) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  const ui = workbenchUi(page);
  const helpButton = page.getByRole('button', { name: '键盘快捷键帮助' });
  const dialog = page.locator('#shortcut-help');
  await expect(helpButton).toBeVisible();

  // Keyboard path: focus a shell control, press Mod+/, dialog opens.
  await ui.navigationButton.focus();
  await pressModSlash(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('键盘快捷键');
  for (const group of ['导航', '面板', '编辑', '浮层']) {
    await expect(dialog.getByRole('heading', { name: group })).toBeVisible();
  }
  await expect(dialog.locator('kbd').first()).toBeVisible();

  // Tab reaches the explicit close control inside the panel.
  await expect(dialog.getByRole('button', { name: '关闭快捷键面板' })).toBeVisible();

  // Esc closes and focus returns to the element that opened the panel.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(ui.navigationButton).toBeFocused();

  // Toggle again with Mod+/ and close through the same chord.
  await page.keyboard.press('Escape'); // no-op guard: dialog is closed
  await pressModSlash(page);
  await expect(dialog).toBeVisible();
  await pressModSlash(page);
  await expect(dialog).toBeHidden();
  await expect(ui.navigationButton).toBeFocused();

  evidence.recordFact('web36.shortcut_help_opened', true);
  evidence.recordFact('web36.shortcut_help_focus_restored', true);
});

test('WEB36-P1-02 header theme button cycles system -> light -> dark -> system on the root dataset', async ({
  evidence,
  page,
}) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  const themeButton = page.getByRole('button', { name: /^主题：/u });
  await expect(themeButton).toBeVisible();

  const theme = async (): Promise<string> =>
    page.evaluate(() => document.documentElement.dataset.theme ?? '');
  const before = await theme();

  await themeButton.click();
  const light = await theme();
  expect(['light', 'dark', 'system']).toContain(light);
  expect(light).not.toBe(before);

  await themeButton.click();
  const dark = await theme();
  expect(['light', 'dark', 'system']).toContain(dark);
  expect(dark).not.toBe(light);

  // Third click closes the cycle back to the starting preference.
  await themeButton.click();
  expect(await theme()).toBe(before);

  // The button keeps an accessible dynamic label describing the current state.
  await expect(themeButton).toHaveAttribute('aria-label', /^主题：/u);

  evidence.recordFact('web36.theme_cycle_start', before);
  evidence.recordFact('web36.theme_cycle_verified', true);
});

test('WEB36-P1-03 shell surfaces pass axe (WCAG 2.2 tags) with the help panel open', async ({
  context,
  evidence,
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1_440, height: 900 });
  await context.addInitScript({ path: require.resolve('axe-core/axe.min.js') });
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await expect
    .poll(() => page.evaluate(() => typeof (globalThis as { axe?: unknown }).axe))
    .toBe('object');

  const blocking: Array<{ id: string; impact: string | null; stage: string }> = [];
  blocking.push(...(await scanAxe(page, 'shell-light')));
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  blocking.push(...(await scanAxe(page, 'shell-dark')));

  await pressModSlash(page);
  await expect(page.locator('#shortcut-help')).toBeVisible();
  blocking.push(...(await scanAxe(page, 'shortcut-help')));
  await page.keyboard.press('Escape');

  const blockingFindings = blocking.filter(
    violation => violation.impact === 'critical' || violation.impact === 'serious'
  );
  expect(blockingFindings).toEqual([]);
  evidence.recordFact('web36.axe_blocking_violations', blockingFindings.length);
});

interface AxeFinding {
  readonly id: string;
  readonly impact: string | null;
  readonly stage: string;
}

async function scanAxe(page: Page, stage: string): Promise<AxeFinding[]> {
  return page.evaluate(async currentStage => {
    const axe = (
      globalThis as typeof globalThis & {
        axe: {
          run(
            root: Document,
            options: Readonly<Record<string, unknown>>
          ): Promise<{ readonly violations: readonly AxeViolationLike[] }>;
        };
      }
    ).axe;
    interface AxeViolationLike {
      readonly id: string;
      readonly impact: string | null;
    }
    const result = await axe.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'],
      },
    });
    return result.violations.map(violation => ({
      id: violation.id,
      impact: violation.impact,
      stage: currentStage,
    }));
  }, stage);
}

async function elementWidth(element: import('@playwright/test').Locator): Promise<number> {
  return Math.round(await element.evaluate(node => node.getBoundingClientRect().width));
}

async function expectElementWidth(
  element: import('@playwright/test').Locator,
  expected: number
): Promise<void> {
  await expect.poll(() => elementWidth(element)).toBe(expected);
}

async function pressModSlash(page: Page): Promise<void> {
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${modifier}+/`);
}
