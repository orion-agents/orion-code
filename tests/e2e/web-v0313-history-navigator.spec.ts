import { expect, test } from './fixtures/test';
import { createSession, submitPrompt, waitForWorkbenchReady, workbenchUi } from './fixtures/ui';

test.use({ trace: 'off', video: 'off', screenshot: 'only-on-failure' });

/**
 * v0.3.13 — conversation history rail over the real Orion Web host.
 *
 * Every rail contract is exercised with a real browser viewport and real
 * pointer events against the `.transcript-viewport` scroll container. A note
 * on coverage: the rail only represents history the browser has loaded, and
 * the real host starts each test workspace with an empty transcript, so the
 * >320-row pagination scenarios (rail top "加载更早", prepend-anchor stability
 * across a page load) are exercised by the pure bucket/hook unit layers and
 * the render-layer tests instead — the fixture provider cannot seed hundreds
 * of transcript rows through the runtime.
 */
async function seedConversation(page: Parameters<typeof submitPrompt>[0], rounds: number) {
  await createSession(page);
  for (let index = 0; index < rounds; index += 1) {
    await submitPrompt(page, `history rail probe round ${index} reply in one short sentence`, {
      timeout: 30_000,
    });
    await expect(
      page.getByRole('article', { name: 'Orion' }).nth(index),
      `round ${index} assistant turn`
    ).toBeVisible({ timeout: 60_000 });
  }
}

test('WEB34-P0-19 rail and slider render beside the transcript without layout shift', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1_600, height: 900 });
  const ui = workbenchUi(page);
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  await seedConversation(page, 4);

  const rail = page.getByRole('navigation', { name: '会话历史定位' });
  await expect(rail).toBeVisible();
  const slider = rail.getByRole('slider', { name: '已加载会话历史位置' });
  await expect(slider).toBeVisible();

  // Decorative ticks are hidden from the accessibility tree.
  expect(await slider.locator('[aria-hidden="true"] .history-tick').count()).toBeGreaterThan(0);
  expect(await rail.locator('.history-tick').count()).toBeGreaterThan(1);

  // No horizontal overflow, composer and work panel unaffected by the rail.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  const before = {
    composerX: await ui.composer.boundingBox().then(box => box?.x ?? 0),
    mainX: await ui.main.boundingBox().then(box => box?.x ?? 0),
  };
  await page.evaluate(() => {
    const viewport = document.querySelector('.transcript-viewport');
    if (viewport) viewport.scrollTop = 0;
  });
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  const after = {
    composerX: await ui.composer.boundingBox().then(box => box?.x ?? 0),
    mainX: await ui.main.boundingBox().then(box => box?.x ?? 0),
  };
  expect(after).toEqual(before);
});

test('WEB34-P0-20 clicking the rail jumps the transcript and exposes a viewport marker', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1_600, height: 900 });
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  await seedConversation(page, 6);

  // Reading at the bottom, then click the slider near the top of loaded history.
  const viewport = page.locator('.transcript-viewport');
  const slider = page.getByRole('slider', { name: '已加载会话历史位置' });
  await page.waitForTimeout(300);
  const scrollState = () =>
    viewport.evaluate(element => ({
      top: element.scrollTop,
      bottom: element.scrollTop + element.clientHeight,
      max: element.scrollHeight,
    }));
  const atBottom = await scrollState();
  expect(atBottom.max - atBottom.bottom).toBeLessThan(80);

  const box = (await slider.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + 8);
  await page.waitForTimeout(700);
  const jumped = await scrollState();
  expect(jumped.top).toBeLessThan(atBottom.top - 80);

  // Clicking into the past un-pins: the "回到最新" affordance appears.
  await expect(page.getByRole('button', { name: '回到最新' })).toBeVisible({ timeout: 10_000 });

  // Jump to the latest again.
  await page.getByRole('button', { name: '回到最新' }).click();
  await page.waitForTimeout(700);
  const latest = await scrollState();
  expect(latest.max - latest.bottom).toBeLessThan(80);
});

test('WEB34-P0-21 pointer drag scrubs the transcript without text selection', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1_600, height: 900 });
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  await seedConversation(page, 5);

  const slider = page.getByRole('slider', { name: '已加载会话历史位置' });
  const box = (await slider.boundingBox())!;
  // Drag from the bottom end to the top of the rail.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 8, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  const selection = await page.evaluate(() => window.getSelection()?.toString().length ?? 0);
  expect(selection).toBe(0);
  const viewport = page.locator('.transcript-viewport');
  const top = await viewport.evaluate(element => element.scrollTop);
  expect(top).toBeLessThan(40);
});

test('WEB34-P0-22 browsing the past never steals the scroll while new output arrives', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1_600, height: 900 });
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  await seedConversation(page, 3);

  // Move into the past.
  const viewport = page.locator('.transcript-viewport');
  await page.evaluate(() => {
    const element = document.querySelector('.transcript-viewport');
    if (element) element.scrollTop = 0;
  });
  await page.waitForTimeout(300);
  const before = await viewport.evaluate(element => element.scrollTop);

  // A new turn streams in while the user reads old history.
  await submitPrompt(page, 'history rail live-output probe reply briefly', { timeout: 30_000 });
  await expect(page.getByRole('article', { name: 'Orion' }).last()).toBeVisible({
    timeout: 60_000,
  });
  await page.waitForTimeout(500);
  const during = await viewport.evaluate(element => element.scrollTop);
  // The viewport stays roughly where the user was reading (new output must not
  // yank the reader to the bottom).
  expect(Math.abs(during - before)).toBeLessThan(120);
});

test('WEB34-P0-23 narrow conversation columns hide the rail and keep controls usable', async ({
  page,
}) => {
  test.setTimeout(300_000);
  // A compact desktop whose central column sits below the 640px rail cutoff.
  await page.setViewportSize({ width: 700, height: 900 });
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  await seedConversation(page, 2);

  await expect(page.getByRole('navigation', { name: '会话历史定位' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );

  // Jump-to-latest still works without the rail.
  const viewport = page.locator('.transcript-viewport');
  await page.evaluate(() => {
    const element = document.querySelector('.transcript-viewport');
    if (element) element.scrollTop = 0;
  });
  await page.waitForTimeout(300);
  await expect(page.getByRole('button', { name: '回到最新' })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: '回到最新' }).click();
  await page.waitForTimeout(600);
  const bottom = await viewport.evaluate(element => element.scrollTop + element.clientHeight);
  const max = await viewport.evaluate(element => element.scrollHeight);
  expect(max - bottom).toBeLessThan(80);
});
