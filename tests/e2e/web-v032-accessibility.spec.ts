import { basename, join } from 'path';

import type { Page, Request, TestInfo } from '@playwright/test';

import { capturedSseEvents, expect, test } from './fixtures/test';
import { createSession, waitForWorkbenchReady, workbenchUi } from './fixtures/ui';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test('WEB32-P0-12 normal-CSP Composer surfaces pass axe across theme, motion and 200 percent zoom', async ({
  context,
  evidence,
  page,
  workspace,
}, testInfo) => {
  testInfo.setTimeout(180_000);
  const network = observeExactEventStreamAborts(page, testInfo);
  evidence.addSecretValue(workspace.environment.ORION_CODE_API_KEY);
  await createSession(page, { name: 'WEB32 accessibility' });

  await context.addInitScript({ path: require.resolve('axe-core/axe.min.js') });
  const documentResponse = await page.reload({ waitUntil: 'domcontentloaded' });
  expect(documentResponse).not.toBeNull();
  const csp = documentResponse!.headers()['content-security-policy'] ?? '';
  const directives = new Map(
    csp.split(';').map(directive => {
      const [name, ...values] = directive.trim().split(/\s+/u);
      return [name, values] as const;
    })
  );
  expect(directives.get('script-src')).toEqual(["'self'"]);
  expect(directives.get('style-src-elem')).toEqual(
    expect.arrayContaining(["'self'", expect.stringMatching(/^'nonce-[A-Za-z0-9_-]+'$/u)])
  );
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  await expect(workbenchUi(page).composer).toBeEnabled({ timeout: 30_000 });
  await expect
    .poll(() => page.evaluate(() => typeof (globalThis as { axe?: unknown }).axe))
    .toBe('object');

  const blocking: AxeViolation[] = [];
  await page.setViewportSize({ width: 1_440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await expectColorScheme(page, 'light');
  expect(await reducedMotionIsEffective(page)).toBe(true);
  blocking.push(...(await scanAxe(page, 'light')));
  await workbenchUi(page).modeButton.click();
  await expect(page.getByRole('menu', { name: '工作模式' })).toBeVisible();
  blocking.push(...(await scanAxe(page, 'light-mode-menu')));
  await page.keyboard.press('Escape');

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.mouse.move(0, 0);
  await expectColorScheme(page, 'dark');
  expect(await reducedMotionIsEffective(page)).toBe(true);
  blocking.push(...(await scanAxe(page, 'dark')));

  await page.setViewportSize({ width: 640, height: 900 });
  const cdp = await context.newCDPSession(page);
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 320,
      height: 450,
      deviceScaleFactor: 2,
      mobile: false,
      screenWidth: 640,
      screenHeight: 900,
    });
    await expect
      .poll(() =>
        page.evaluate(() => ({
          dpr: devicePixelRatio,
          innerWidth,
          visualWidth: visualViewport?.width ?? innerWidth,
        }))
      )
      .toEqual({ dpr: 2, innerWidth: 320, visualWidth: 320 });
    expect(await horizontalOverflow(page)).toBe(0);
    blocking.push(...(await scanAxe(page, 'dark-zoom-200')));
    const screenshotName = 'web32-p0-12-dark-reduced-motion-zoom200.png';
    await page.locator('.composer-control-center').screenshot({
      path: join(evidence.scenarioDirectory, screenshotName),
      animations: 'disabled',
    });
    evidence.recordFact('screenshot.accessibility', basename(screenshotName));
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await cdp.detach();
  }

  const blockingFindings = blocking.filter(
    violation => violation.impact === 'critical' || violation.impact === 'serious'
  );
  expect(blockingFindings).toEqual([]);
  const serializedBrowserState = JSON.stringify({
    text: await page.locator('html').innerText(),
    events: await capturedSseEvents(page),
  });
  expect(serializedBrowserState).not.toContain(workspace.environment.ORION_CODE_API_KEY);

  const counters = evidence.snapshotCounters();
  expect(counters.consoleErrors).toBe(0);
  expect(counters.pageErrors).toBe(0);
  expect(counters.http5xx).toBe(0);
  expect(counters.secretFindings).toBe(0);
  expect(counters.droppedEvents).toBe(0);
  evidence.recordFact('web32.axe_blocking_violations', blockingFindings.length);
  evidence.recordFact('web32.console_errors', counters.consoleErrors);
  evidence.recordFact('web32.page_errors', counters.pageErrors);
  evidence.recordFact('web32.http_5xx', counters.http5xx);
  evidence.recordFact('web32.secret_findings', counters.secretFindings);
  evidence.recordFact('web32.dropped_events', counters.droppedEvents);
  evidence.recordFact('web32.zoom_200_verified', true);
  evidence.recordFact('web32.theme_motion_verified', true);
  evidence.recordFact('web32.normal_csp_verified', true);
  network.finish();
});

interface AxeViolation {
  readonly id: string;
  readonly impact: string | null;
  readonly stage: string;
  readonly nodes: readonly {
    readonly target: readonly string[];
    readonly failureSummary: string | null;
  }[];
}

async function scanAxe(page: Page, stage: string): Promise<AxeViolation[]> {
  return page.evaluate(async currentStage => {
    const axe = (
      globalThis as typeof globalThis & {
        axe: {
          run(
            root: Document,
            options: Readonly<Record<string, unknown>>
          ): Promise<{
            readonly violations: readonly {
              readonly id: string;
              readonly impact: string | null;
              readonly nodes: readonly {
                readonly target: readonly string[];
                readonly failureSummary: string | null;
              }[];
            }[];
          }>;
        };
      }
    ).axe;
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
      nodes: violation.nodes.map(node => ({
        target: node.target,
        failureSummary: node.failureSummary,
      })),
    }));
  }, stage);
}

async function expectColorScheme(page: Page, expected: 'light' | 'dark'): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        preference: matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
        rendered: getComputedStyle(document.documentElement).colorScheme,
        textSecondary: getComputedStyle(document.documentElement)
          .getPropertyValue('--text-2')
          .trim()
          .toLowerCase(),
        modeColor: (() => {
          const modeLabel = document.querySelector<HTMLElement>('[aria-label="工作模式"] > span');
          return modeLabel ? getComputedStyle(modeLabel).color : null;
        })(),
      }))
    )
    .toEqual({
      preference: expected,
      rendered: expected,
      textSecondary: expected === 'light' ? '#454b5a' : '#b1b8c8',
      modeColor: expected === 'light' ? 'rgb(69, 75, 90)' : 'rgb(177, 184, 200)',
    });
}

async function reducedMotionIsEffective(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    const toMilliseconds = (value: string): number => {
      const normalized = value.trim();
      if (normalized.endsWith('ms')) return Number(normalized.slice(0, -2));
      if (normalized.endsWith('s')) return Number(normalized.slice(0, -1)) * 1_000;
      return Number.POSITIVE_INFINITY;
    };
    return ['.workbench-shell', '.workspace-rail', '.work-panel'].every(selector => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return false;
      const style = getComputedStyle(element);
      return `${style.animationDuration},${style.transitionDuration}`
        .split(',')
        .map(toMilliseconds)
        .every(duration => Number.isFinite(duration) && duration <= 1);
    });
  });
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() =>
    Math.max(
      0,
      document.documentElement.scrollWidth - innerWidth,
      document.body.scrollWidth - innerWidth
    )
  );
}

function observeExactEventStreamAborts(page: Page, testInfo: TestInfo) {
  const failures: { readonly method: string; readonly path: string; readonly error: string }[] = [];
  const annotation = { type: 'evidence:allow-network-failures', description: '0' };
  testInfo.annotations.push(annotation);
  const onRequestFailed = (request: Request): void => {
    failures.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      error: request.failure()?.errorText ?? '',
    });
    annotation.description = String(failures.length);
  };
  page.on('requestfailed', onRequestFailed);
  return {
    finish(): void {
      page.off('requestfailed', onRequestFailed);
      for (const failure of failures) {
        expect(failure).toEqual({
          method: 'GET',
          path: '/api/v1/events',
          error: 'net::ERR_ABORTED',
        });
      }
      annotation.description = String(failures.length);
    },
  };
}
