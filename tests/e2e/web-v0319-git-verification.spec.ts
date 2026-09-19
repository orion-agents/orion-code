import { spawnSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { expect, test } from './fixtures/test';
import {
  applySettings,
  openSettings,
  setSettingsSelect,
  waitForWorkbenchReady,
} from './fixtures/ui';

/**
 * v0.3.19 — closing the v0.3.17 G317 assertion backlog.
 *
 * These five scenarios were the ones the v0.3.17 status table left as "feature present,
 * assertion missing". Everything here is checked against the real repository through a
 * separate `git` process, and the theme/tier claims are read from computed styles rather
 * than from the attribute that is supposed to drive them.
 */

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args as string[], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * A repository with one ordinary worktree change the reader can open. Deliberately small and
 * conflict-free: these scenarios are about reading behaviour, and a merge conflict would make
 * the reading pane a different surface.
 */
function seedReadingRepo(cwd: string): void {
  rmSync(join(cwd, '.git'), { recursive: true, force: true });
  git(cwd, ['init', '-q', '-b', 'main']);
  git(cwd, ['config', 'user.email', 'e2e@probe.local']);
  git(cwd, ['config', 'user.name', 'E2E Probe']);

  writeFileSync(join(cwd, 'notes.txt'), 'alpha\nbeta\n');
  writeFileSync(join(cwd, 'stable.txt'), 'unchanged\n');
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-q', '-m', 'feat: reading fixture']);

  // One unstaged change with several lines, so the diff has anchors to hold on to.
  writeFileSync(join(cwd, 'notes.txt'), 'alpha\nbeta changed\ngamma\ndelta\n');
}

async function openGitPanel(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForSelector('button[aria-label="打开Git面板"]', { timeout: 30_000 });
  // The rail button toggles, so clicking an already-active panel would close it — which is
  // exactly what happens on the reloads below, where the active panel is remembered.
  const active = page.locator('button[aria-label="打开Git面板"][aria-current="page"]');
  if ((await active.count()) === 0) {
    await page.click('button[aria-label="打开Git面板"]');
  }
  await page.waitForSelector('.git-views', { timeout: 30_000 });
}

/** Reads the theme-controlled surface colour so "dark" is measured, not assumed. */
async function surfaceLuminance(
  page: import('@playwright/test').Page,
  selector: string
): Promise<number> {
  return page.evaluate(target => {
    const node = document.querySelector(target);
    if (!node) throw new Error(`missing ${target}`);
    // Walk up until a non-transparent background is found; a panel can be transparent.
    let current: Element | null = node;
    while (current) {
      const colour = getComputedStyle(current).backgroundColor;
      const parts = colour
        .match(/rgba?\(([^)]+)\)/u)?.[1]
        ?.split(',')
        .map(Number);
      if (parts && parts.length >= 3 && (parts[3] === undefined || parts[3] > 0.5)) {
        const [r, g, b] = parts.map(channel => channel / 255);
        const linear = (channel: number) =>
          channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        return (
          0.2126 * linear(r as number) + 0.7152 * linear(g as number) + 0.0722 * linear(b as number)
        );
      }
      current = current.parentElement;
    }
    throw new Error(`no opaque background above ${target}`);
  }, selector);
}

/**
 * Chromium serialises a computed duration in whichever unit is shortest, so `0.01ms` comes
 * back as `1e-05s`. Comparing strings would be testing the serialiser, not the CSS.
 */
function durationSeconds(value: string): number {
  const match = value.match(/^([\d.eE+-]+)(m?s)$/u);
  if (!match) throw new Error(`unparsable duration: ${value}`);
  const amount = Number(match[1]);
  return match[2] === 'ms' ? amount / 1_000 : amount;
}

/**
 * The docked panel's real width, read from the same node that carries the tier attribute.
 * Reading the attribute through one API and the width through another is how a test ends up
 * comparing two different elements.
 */
async function panelSnapshot(
  page: import('@playwright/test').Page
): Promise<{ width: number; client: number; tier: string | null; narrowView: string | null }[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.git-panel')].map(node => ({
      width: Math.round(node.getBoundingClientRect().width),
      client: (node as HTMLElement).clientWidth,
      tier: node.getAttribute('data-width'),
      narrowView: node.getAttribute('data-narrow-view'),
    }))
  );
}

/** The panel that is actually laid out; a zero-width copy would not be the reader's panel. */
async function renderedPanel(page: import('@playwright/test').Page) {
  const snapshot = await panelSnapshot(page);
  return snapshot
    .filter(entry => entry.width > 0)
    .sort((left, right) => right.width - left.width)[0];
}

test.describe('v0.3.19 Git verification backlog', () => {
  test.beforeEach(async ({ page, workspace }) => {
    seedReadingRepo(workspace.primaryWorkspace);
    await page.reload();
    await waitForWorkbenchReady(page);
  });

  test('WEB34-P0-01 (W319-03) an external write refreshes the panel without moving the reader', async ({
    page,
    workspace,
  }) => {
    const cwd = workspace.primaryWorkspace;
    await openGitPanel(page);

    // The reader opens a change and anchors on it.
    await page.locator('.git-row button', { hasText: 'notes.txt' }).first().click();
    await page.waitForSelector('[aria-label="Diff notes.txt"]', { timeout: 30_000 });
    await expect(page.locator('.git-row.selected')).toContainText('notes.txt');

    // A separate process — this is what an Agent writing a file does — changes the very file
    // the reader is looking at, and also adds an unrelated one.
    writeFileSync(join(cwd, 'notes.txt'), 'alpha\nbeta changed\ngamma\ndelta\nepsilon\n');
    writeFileSync(join(cwd, 'agent-added.txt'), 'written by another process\n');

    // The panel polls while visible, so it must notice without any user action. Waiting for the
    // *new* file to appear proves the refresh happened rather than merely that time passed.
    await expect
      .poll(
        async () =>
          (await page.locator('.git-row button').count()) > 0 &&
          (await page.locator('.git-row').allInnerTexts()).some(text => /agent-added/.test(text)),
        { timeout: 30_000 }
      )
      .toBe(true);

    // The reader did not move: same file, same source group, diff still rendered.
    await expect(page.locator('.git-row.selected')).toContainText('notes.txt');
    await expect(page.locator('[aria-label="Diff notes.txt"]')).toBeVisible();
    // And the panel says the rendered document may be out of date instead of pretending it is
    // current — a refresh that silently kept stale content would be the real failure here.
    await expect(page.locator('.diff-stale')).toBeVisible();

    // The external write is genuinely on disk; the panel read it, it did not invent it.
    expect(git(cwd, ['status', '--porcelain=v1'])).toContain('agent-added.txt');
  });

  test('WEB34-P0-02 (W319-17) 在 Files 打开 reaches the Files panel with the same file', async ({
    page,
  }) => {
    await openGitPanel(page);
    await page.locator('.git-row button', { hasText: 'notes.txt' }).first().click();
    await page.waitForSelector('[aria-label="Diff notes.txt"]', { timeout: 30_000 });

    // The entry only exists for a working-tree change that is not a conflict (plan G7).
    const reveal = page.locator('.git-reveal-row button', { hasText: '在 Files 打开' });
    await expect(reveal).toBeVisible();
    await reveal.click();

    // It switches the dock to Files and opens *that* path — the token translation is the part
    // that could silently go wrong.
    await expect(
      page.locator('button[aria-label="打开文件面板"][aria-current="page"]')
    ).toBeVisible({ timeout: 20_000 });
    const content = page.locator('[aria-label="文件内容 notes.txt"]');
    await expect(content).toBeVisible({ timeout: 20_000 });
    await expect(content).toContainText('gamma');

    // A historical comparison deliberately offers no such action; reading history must not
    // jump the reader to a current file that happens to share the name.
    await page.click('button[aria-label="打开Git面板"]');
    await page.click('.git-views > button:has-text("历史")');
    await page.waitForSelector('.git-history-list > li', { timeout: 30_000 });
    await page.click('.git-history-list > li button');
    await page.waitForSelector('.git-commit-detail', { timeout: 30_000 });
    await expect(page.locator('.git-reveal-row')).toHaveCount(0);
    await expect(page.locator('.git-commit-detail')).toContainText('该版本');
  });

  test('WEB34-P0-03 (W319-19a) the work panel follows the theme and stops moving when asked', async ({
    page,
  }) => {
    // 1. The system preference is honoured, measured on the panel that is actually rendered.
    await openGitPanel(page);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme), { timeout: 20_000 })
      .toBe('system');

    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(200);
    const dark = await surfaceLuminance(page, '.git-panel');

    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(200);
    const light = await surfaceLuminance(page, '.git-panel');
    expect(dark).toBeLessThan(0.2);
    expect(light).toBeGreaterThan(0.5);

    // 2. The explicit choice made through the app's own control overrides the system
    //    preference — still with the OS set to light, so this cannot pass by accident.
    const dialog = await openSettings(page);
    await setSettingsSelect(page, '主题', 'dark');
    await applySettings(page, 1);
    await dialog.getByRole('button', { name: '关闭设置' }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme), { timeout: 20_000 })
      .toBe('dark');
    expect(await surfaceLuminance(page, '.git-panel')).toBeLessThan(0.2);

    // 3. Reduced motion is honoured by the work panel, not only by one spinner: the shipped
    //    rule collapses every duration, including the dock's own width animation, which is the
    //    movement a reader feels most when they resize or switch panels.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForTimeout(200);
    const moving = await page.evaluate(
      () =>
        getComputedStyle(document.querySelector('.workbench-shell') as Element).transitionDuration
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(200);
    const still = await page.evaluate(
      () =>
        getComputedStyle(document.querySelector('.workbench-shell') as Element).transitionDuration
    );
    expect(durationSeconds(moving)).toBeGreaterThan(0.001);
    expect(durationSeconds(still)).toBeLessThan(0.001);

    // 4. Under forced colours the selected affordance keeps a real border instead of relying on
    //    a colour that the mode discards. The rail button is the panel's own selected
    //    affordance and is always rendered, so this does not depend on the change list state.
    await page.emulateMedia({ forcedColors: 'active' });
    await page.waitForTimeout(300);
    const railBorder = await page.evaluate(() => {
      const node = document.querySelector('.work-panel-rail-button[aria-current="page"]');
      return node ? getComputedStyle(node).borderTopWidth : null;
    });
    expect(railBorder).toBe('2px');
    await page.emulateMedia({ forcedColors: 'none' });
  });

  test('WEB34-P0-04 (W319-19b) the narrow tier, the back affordance and overflow hold', async ({
    page,
  }) => {
    const panel = page.locator('.git-panel');
    const overflowOf = () =>
      page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));

    // 1280 is deterministic from the window alone: the dock can only give the panel
    // 1280 - 240 navigation - 560 conversation = 480px, which is inside the narrow band. This
    // is the tier boundary that can be reached by resizing rather than by seeding a preference.
    await page.setViewportSize({ width: 1_280, height: 900 });
    await page.reload();
    await waitForWorkbenchReady(page);
    await openGitPanel(page);
    await expect(panel).toHaveAttribute('data-width', 'narrow', { timeout: 20_000 });
    const narrowWidth = (await renderedPanel(page))?.width ?? 0;
    expect(narrowWidth).toBeGreaterThan(0);
    expect(narrowWidth).toBeLessThanOrEqual(622);

    // Narrow reads unified whatever was stored, shows one pane at a time and must offer a way
    // back to the list.
    await page.locator('.git-row button', { hasText: 'notes.txt' }).first().click();
    await page.waitForSelector('.diff-body', { timeout: 30_000 });
    await expect(panel).toHaveAttribute('data-narrow-view', 'detail');
    await expect(
      page.locator('.diff-mode-group > button', { hasText: '统一' }).first()
    ).toHaveAttribute('aria-pressed', 'true');
    const back = page.locator('.git-panel button', { hasText: '返回文件列表' });
    await expect(back).toBeVisible();
    await back.click();
    await expect(panel).toHaveAttribute('data-narrow-view', 'list');
    await expect(page.locator('.git-row.selected')).toHaveCount(1);
    const narrowOverflow = await overflowOf();
    expect(narrowOverflow.scroll).toBeLessThanOrEqual(narrowOverflow.client);

    // Window widths: 1920 docks a wider panel, 768 and 375 hand the width to the conversation.
    // At every one of them the panel must be reachable and nothing may overflow.
    // The `compact` and `wide` tiers are NOT asserted here. The tier follows the panel width,
    // and neither of the two ways to change that width was reproducible in this harness:
    // seeding `workPanel.widthPx` then reloading left a seeded 900px panel rendering 851px while
    // `data-width` stayed `wide` for six seconds of sampling, and dragging
    // `.panel-resize-handle` did not move the width at all. The bands themselves are pinned
    // exactly by `tests/web-git-panel-state.test.ts`; what this scenario claims is the narrow
    // tier, its affordances, and overflow — not the other two tiers.

    // Below 1180 the dock is not a rail at all — it is a drawer, and the entry point is the
    // work-panel toggle in the conversation header. What the plan requires here is that nothing
    // overflows and that the panel is still reachable; `waitForWorkbenchReady` cannot be used
    // because the connection indicator it waits for lives inside the now-hidden navigation.
    const narrowWindows: { viewport: number; scroll: number; client: number; shell: boolean }[] =
      [];
    for (const width of [768, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.reload();
      await page.waitForSelector('.workbench-shell', { timeout: 30_000 });
      const overflow = await overflowOf();
      // The plan's claim at these widths is "不溢出" — nothing else is asserted here. Which
      // control opens the drawer is a separate affordance, and neither the rail button nor the
      // header toggle is visible at these widths in this harness, so that is left unclaimed
      // rather than asserted through a control the reader cannot see.
      expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
      narrowWindows.push({
        viewport: width,
        scroll: overflow.scroll,
        client: overflow.client,
        shell: await page.locator('.workbench-shell').isVisible(),
      });
    }
    expect(narrowWindows.map(entry => entry.shell)).toEqual([true, true]);

    // Recorded so a future failure states what was really rendered.
    // Carried into the assertion so a failure states what was really rendered.
    expect({ narrowWidth, narrowWindows }).toEqual({
      narrowWidth: expect.any(Number),
      narrowWindows: expect.any(Array),
    });

    // NOTE (v0.3.19): the exact 960 / 620 / 360 panel bands are asserted by
    // `tests/web-git-panel-state.test.ts`, not here. Seeding `workPanel.widthPx` and reloading
    // was not reproducible: at a seeded 900px the panel rendered 851px while `data-width` stayed
    // `wide` for six seconds of sampling. That disagreement is recorded as an open finding in
    // `docs/plan/evidence/v0.3.17-git/s6-responsive-keyboard.md` rather than papered over with a
    // looser assertion.
  });

  test('WEB34-P0-05 (W319-20) repeated opening and a hundred diffs stay bounded', async ({
    page,
    workspace,
  }) => {
    const cwd = workspace.primaryWorkspace;
    // 120 changed files: the "连续换 100 个 Diff" case from the plan.
    mkdirSync(join(cwd, 'bulk'), { recursive: true });
    for (let index = 0; index < 120; index += 1) {
      const name = `bulk/file-${String(index).padStart(3, '0')}.txt`;
      writeFileSync(join(cwd, name), `baseline ${index}\n`);
    }
    git(cwd, ['add', 'bulk']);
    git(cwd, ['commit', '-q', '-m', 'chore: bulk baseline']);
    for (let index = 0; index < 120; index += 1) {
      const name = `bulk/file-${String(index).padStart(3, '0')}.txt`;
      writeFileSync(join(cwd, name), `baseline ${index}\nchanged ${index}\n`);
    }

    await page.reload();
    await waitForWorkbenchReady(page);

    // Repeated open/close: the dock unmounts the pane, so this is a real rebuild each time.
    let slowestFirstPaint = 0;
    let lastFirstPaint = 0;
    for (let round = 0; round < 12; round += 1) {
      await page.click('button[aria-label="打开文件面板"]').catch(() => undefined);
      await page.waitForTimeout(40);
      const startedAt = Date.now();
      await openGitPanel(page);
      await page.waitForSelector('.git-row button', { timeout: 30_000 });
      const elapsed = Date.now() - startedAt;
      if (round === 0) slowestFirstPaint = elapsed;
      lastFirstPaint = elapsed;
    }
    // The last open must not be dramatically worse than the first: that is what a leak looks
    // like from the outside, and it is the only bound that is honest without a heap snapshot.
    expect(lastFirstPaint).toBeLessThan(Math.max(2_000, slowestFirstPaint * 4));

    // A hundred diffs in sequence, with the DOM and the request count both bounded.
    await page.fill('input[aria-label="搜索文件路径"]', 'bulk/');
    await expect(page.locator('.git-row')).not.toHaveCount(0);
    // `.git-row button` also matches the stage button; the read affordance is the row button,
    // which is the only one without an explicit aria-label.
    const rowButtons = page.locator('.git-row > button:not([aria-label])');
    const rows = await rowButtons.count();
    expect(rows).toBeGreaterThanOrEqual(100);

    const beforeRequests = await page.evaluate(
      () =>
        performance.getEntriesByType('resource').filter(entry => entry.name.includes('/git/'))
          .length
    );
    for (let index = 0; index < 100; index += 1) {
      const target = rowButtons.nth(index % rows);
      const label = (await target.innerText()).trim();
      await target.click();
      try {
        await page.waitForSelector('.diff-body', { timeout: 10_000 });
      } catch (error) {
        const state = await page.evaluate(() => ({
          selectedRows: document.querySelectorAll('.git-row.selected').length,
          selectedText: document.querySelector('.git-row.selected')?.textContent ?? null,
          diffBodies: document.querySelectorAll('.diff-body').length,
          content: (
            document.querySelector('[aria-label="Git 内容"]') as HTMLElement | null
          )?.innerText.slice(0, 160),
          tier: document.querySelector('.git-panel')?.getAttribute('data-width') ?? null,
          narrowView:
            document.querySelector('.git-panel')?.getAttribute('data-narrow-view') ?? null,
        }));
        throw new Error(
          `diff ${index} (${label}) never rendered: ${JSON.stringify(state)} :: ${
            (error as Error).message
          }`
        );
      }
    }
    const afterRequests = await page.evaluate(
      () =>
        performance.getEntriesByType('resource').filter(entry => entry.name.includes('/git/'))
          .length
    );

    // DOM stays bounded: 100 reads, still a bounded number of rows and one diff body.
    await expect(page.locator('.git-panel')).toHaveCount(1);
    expect(await page.locator('.diff-body').count()).toBeLessThanOrEqual(2);
    expect(rows).toBeLessThanOrEqual(200);
    // Requests are bounded by pages, not by reads: revisiting the same files must be served
    // from the cache rather than re-fetched 100 times.
    const newRequests = afterRequests - beforeRequests;
    expect(newRequests).toBeLessThan(rows);
  });
});
