import { createHash } from 'crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { basename, join } from 'path';

import type { BrowserContext, Locator, Page, Request, TestInfo } from '@playwright/test';

import type { WebPageV1, WebWorkspaceSummaryV1 } from '../../src/web/protocol';
import { activeSessionSnapshot, browserGet, webBootstrap } from './fixtures/api';
import { OPENAI_FIXTURE_MARKERS, OPENAI_FIXTURE_PROMPTS } from './fixtures/openai-provider';
import { allowExpectedNetworkFailures, expect, installSseCapture, test } from './fixtures/test';
import {
  collapseInspector,
  createSession,
  openInspector,
  openSessionNavigation,
  selectInspectorTab,
  setAgentMode,
  submitPrompt,
  waitForWorkbenchReady,
  workbenchUi,
} from './fixtures/ui';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test('WEB31-P0-01 packaged Workbench shows three projects and lazy-loads real Session pages', async ({
  context,
  evidence,
  host,
  page,
  workspace,
}, testInfo) => {
  testInfo.setTimeout(180_000);
  const networkFailures: NetworkFailure[] = [];
  const onRequestFailed = captureNetworkFailure(networkFailures);
  page.on('requestfailed', onRequestFailed);
  await page.setViewportSize({ width: 1_440, height: 900 });

  const tertiaryWorkspace = join(workspace.rootDirectory, 'workspace-tertiary');
  mkdirSync(tertiaryWorkspace, { recursive: true, mode: 0o700 });
  writeFileSync(join(tertiaryWorkspace, 'seed.txt'), 'gamma\n', 'utf8');

  await createSession(page);
  await activateWorkspaceThroughUi(page, workspace.secondaryWorkspace);
  await createSession(page);
  await createSession(page);
  await activateWorkspaceThroughUi(page, tertiaryWorkspace);
  await createSession(page);
  await activateWorkspaceThroughUi(page, workspace.primaryWorkspace);

  const listed = await browserGet<WebPageV1<WebWorkspaceSummaryV1>>(
    page,
    '/api/v1/workspaces?pageSize=50'
  );
  expect(listed.status).toBe(200);
  const secondary = listed.body.items.find(
    item => realpathSync(item.path) === realpathSync(workspace.secondaryWorkspace)
  );
  expect(secondary).toBeDefined();
  expect(listed.body.items).toHaveLength(3);

  const lazyPage = await context.newPage();
  await installSseCapture(lazyPage);
  const detach = evidence.attachPage(lazyPage);
  lazyPage.on('requestfailed', onRequestFailed);
  let secondaryPageRequests = 0;
  await lazyPage.route('**/api/v1/workspaces/**/sessions**', async route => {
    const target = new URL(route.request().url());
    if (target.pathname !== `/api/v1/workspaces/${encodeURIComponent(secondary!.id)}/sessions`) {
      await route.continue();
      return;
    }
    secondaryPageRequests += 1;
    target.searchParams.set('pageSize', '1');
    await route.continue({ url: target.toString() });
  });

  try {
    await lazyPage.goto(host.url, { waitUntil: 'domcontentloaded' });
    await waitForWorkbenchReady(lazyPage, { timeout: 30_000 });
    const rail = workbenchUi(lazyPage).workspaceRail;
    const tree = rail.getByRole('navigation', { name: '已知项目' });
    const labels = ['workspace-primary', 'workspace-secondary', 'workspace-tertiary'];
    for (const label of labels) {
      await expect(projectTreeItem(tree, label)).toBeVisible();
    }
    const projectCount = await tree.locator('.project-toggle').count();
    expect(projectCount).toBe(3);

    const secondaryProject = projectTreeItem(tree, 'workspace-secondary');
    await secondaryProject.click();
    await expect(secondaryProject).toHaveAttribute('aria-expanded', 'true');
    const secondarySessions = rail.getByRole('list', {
      name: 'workspace-secondary 的会话',
    });
    const rows = secondarySessions.locator('.project-session-row');
    await expect(rows).toHaveCount(1, { timeout: 30_000 });
    const loadMore = secondarySessions.getByRole('button', {
      name: '加载更多会话',
      exact: true,
    });
    await expect(loadMore).toBeVisible();
    expect(secondaryPageRequests).toBe(1);
    await loadMore.click();
    await expect(rows).toHaveCount(2, { timeout: 30_000 });
    await expect(loadMore).toHaveCount(0);
    expect(secondaryPageRequests).toBe(2);

    for (const label of ['workspace-primary', 'workspace-tertiary']) {
      const project = projectTreeItem(tree, label);
      if ((await project.getAttribute('aria-expanded')) !== 'true') await project.click();
      await expect(project).toHaveAttribute('aria-expanded', 'true');
      await expect
        .poll(async () => project.locator('.project-copy > span').innerText())
        .toMatch(/(?:Git|clean|M\d+)/u);
    }
    await expect
      .poll(async () => secondaryProject.locator('.project-copy > span').innerText())
      .toMatch(/(?:Git|clean|M\d+)/u);

    await captureHashedScreenshot(rail, evidence, 'projects', 'web31-p0-01-projects-lazy-page.png');
    evidence.recordFact('web31.projects_visible', projectCount);
    evidence.recordFact('web31.lazy_session_page', true);
    evidence.recordFact('web31.lazy_session_requests', secondaryPageRequests);
  } finally {
    lazyPage.off('requestfailed', onRequestFailed);
    detach();
    await lazyPage.close();
  }
  page.off('requestfailed', onRequestFailed);
  allowVerifiedEventStreamAborts(testInfo, networkFailures);
});

test('WEB31-P0-04 Agent panel preserves Plan, activity, capabilities, diagnostics, and Composer', async ({
  evidence,
  page,
  provider,
}, testInfo) => {
  testInfo.setTimeout(180_000);
  const networkFailures: NetworkFailure[] = [];
  const onRequestFailed = captureNetworkFailure(networkFailures);
  page.on('requestfailed', onRequestFailed);
  await page.setViewportSize({ width: 1_440, height: 900 });
  await createSession(page);

  await setAgentMode(page, 'PLAN');
  await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.plan);
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.planExecutionDone)).toBeVisible({
    timeout: 60_000,
  });
  await expect
    .poll(async () => (await activeSessionSnapshot(page)).runtime.processing, {
      timeout: 60_000,
    })
    .toBe(false);
  const snapshot = await activeSessionSnapshot(page);
  expect(snapshot.plan?.body).toContain('# WEB_E2E_PLAN');
  expect(snapshot.plan?.digest).toMatch(/^[a-f0-9]{64}$/u);
  expect(provider.requests.filter(request => request.scenario === 'plan')).toHaveLength(4);
  await expect(
    workbenchUi(page).modeSelector.getByRole('button', { name: 'BUILD', exact: true })
  ).toHaveAttribute('aria-pressed', 'true');

  const inspector = await openInspector(page, { timeout: 30_000 });
  await expect(inspector.getByRole('tab', { name: /^Agent，/u })).toHaveAttribute(
    'aria-selected',
    'true'
  );

  const goal = await selectInspectorTab(page, 'Goal');
  await expect(goal.getByRole('textbox', { name: '创建 Goal' })).toBeVisible();
  await expect(goal.getByRole('heading', { name: 'WEB_E2E_PLAN' })).toBeVisible();

  const goalTab = inspector.getByRole('tab', { name: 'Goal', exact: true });
  await goalTab.focus();
  await goalTab.press('ArrowRight');
  const activityTab = inspector.getByRole('tab', { name: '活动', exact: true });
  await expect(activityTab).toHaveAttribute('aria-selected', 'true');
  await expect(activityTab).toBeFocused();
  await expect(inspector.getByRole('heading', { name: '工具调用' })).toBeVisible();

  const capabilities = await selectInspectorTab(page, '能力');
  await expect(capabilities.getByRole('heading', { name: 'Skills' })).toBeVisible();
  await expect(capabilities.getByRole('heading', { name: 'MCP Servers' })).toBeVisible();
  await expect(capabilities.getByText('Orion Web E2E MCP', { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  const diagnostics = await selectInspectorTab(page, '诊断');
  await diagnostics.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(diagnostics.getByRole('heading', { name: 'Runtime' })).toBeVisible();
  await expect(diagnostics.getByText('实时连接正常', { exact: true }).first()).toBeVisible();

  await captureHashedScreenshot(inspector, evidence, 'agent', 'web31-p0-04-agent-regression.png');
  evidence.recordFact('web31.agent_regression_verified', true);
  evidence.recordFact('web31.agent_panels_verified', 4);
  evidence.recordFact('web31.agent_plan_digest', snapshot.plan!.digest);
  page.off('requestfailed', onRequestFailed);
  allowVerifiedEventStreamAborts(testInfo, networkFailures);
});

test('WEB31-P0-11 five responsive widths preserve keyboard focus and zero page overflow', async ({
  evidence,
  page,
}, testInfo) => {
  const networkFailures: NetworkFailure[] = [];
  const onRequestFailed = captureNetworkFailure(networkFailures);
  page.on('requestfailed', onRequestFailed);
  await page.setViewportSize({ width: 1_440, height: 900 });
  await createSession(page);
  const ui = workbenchUi(page);
  let maximumOverflow = 0;
  let focusChecks = 0;

  maximumOverflow = Math.max(maximumOverflow, await pageHorizontalOverflow(page));
  await expect(ui.inspectorDock).toHaveAttribute('data-mode', 'dock');
  const collapse = ui.inspectorDock.getByRole('button', {
    name: '折叠工作面板',
    exact: true,
  });
  await collapse.focus();
  await collapse.press('Enter');
  const agentShortcut = ui.inspectorShortcuts.getByRole('button', {
    name: '打开Agent面板',
    exact: true,
  });
  await expect(agentShortcut).toBeFocused();
  focusChecks += 1;
  await agentShortcut.press('Enter');
  await expect(ui.inspectorDock.getByRole('tab', { name: /^Agent，/u })).toBeFocused();
  focusChecks += 1;

  await page.setViewportSize({ width: 1_180, height: 820 });
  await expect(ui.inspectorSurface).toHaveAttribute('data-mode', 'overlay');
  maximumOverflow = Math.max(maximumOverflow, await assertResponsiveBounds(page));
  await openInspectorWithKeyboard(page);
  await expect(ui.inspectorDialog.getByRole('button', { name: '关闭工作面板' })).toBeFocused();
  await page.keyboard.press('Tab');
  expect(await focusIsInside(ui.inspectorDialog)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(ui.inspectorButton).toBeFocused();
  focusChecks += 1;

  await page.setViewportSize({ width: 760, height: 820 });
  maximumOverflow = Math.max(maximumOverflow, await assertResponsiveBounds(page));
  await openNavigationWithKeyboard(page);
  await expect(ui.workspaceRail.getByRole('button', { name: '关闭项目导航' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(ui.navigationButton).toBeFocused();
  focusChecks += 1;

  await openInspectorWithKeyboard(page);
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press('Tab');
    expect(await focusIsInside(ui.inspectorDialog)).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(ui.inspectorButton).toBeFocused();
  focusChecks += 1;

  await page.setViewportSize({ width: 390, height: 780 });
  maximumOverflow = Math.max(maximumOverflow, await assertResponsiveBounds(page));
  await openNavigationWithKeyboard(page);
  await page.keyboard.press('Escape');
  await expect(ui.navigationButton).toBeFocused();
  focusChecks += 1;
  await expectCenterHitTarget(ui.settingsButton);

  await page.setViewportSize({ width: 320, height: 720 });
  maximumOverflow = Math.max(maximumOverflow, await assertResponsiveBounds(page));
  await expectCenterHitTarget(ui.navigationButton);
  await expectCenterHitTarget(ui.settingsButton);
  await openNavigationWithKeyboard(page);
  await page.keyboard.press('Escape');
  await expect(ui.navigationButton).toBeFocused();
  focusChecks += 1;

  await page.setViewportSize({ width: 640, height: 900 });
  const cdp = await page.context().newCDPSession(page);
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
    maximumOverflow = Math.max(maximumOverflow, await pageHorizontalOverflow(page));
    await expectCenterHitTarget(ui.navigationButton);
    await expectCenterHitTarget(ui.settingsButton);
    await openNavigationWithKeyboard(page);
    await page.keyboard.press('Escape');
    await expect(ui.navigationButton).toBeFocused();
    focusChecks += 1;
    await captureHashedScreenshot(
      ui.main,
      evidence,
      'responsive',
      'web31-p0-11-responsive-320-dpr2.png'
    );
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await cdp.detach();
  }

  expect(maximumOverflow).toBe(0);
  expect(focusChecks).toBeGreaterThanOrEqual(8);
  evidence.recordFact('web31.responsive_focus_verified', true);
  evidence.recordFact('web31.horizontal_overflow', maximumOverflow);
  evidence.recordFact('web31.responsive_widths', '320,390,760,1180,1440');
  evidence.recordFact('web31.zoom_method', 'direct-320-and-viewport-equivalent-200-percent');
  page.off('requestfailed', onRequestFailed);
  allowVerifiedEventStreamAborts(testInfo, networkFailures);
});

test('WEB31-P0-12 light and dark reduced-motion surfaces pass axe with zero secrets', async ({
  browser,
  evidence,
  host,
  workspace,
}) => {
  evidence.addSecretValue(workspace.environment.ORION_CODE_API_KEY);
  const blocking: AxeViolation[] = [];

  const light = await createAuditedContext(browser, 'light');
  try {
    const lightPage = await openAuditedPage(light, host.url, evidence);
    try {
      await expectColorScheme(lightPage, 'light');
      blocking.push(...(await scanAxe(lightPage)));
      await assertSecretFreeBrowserState(lightPage, workspace.environment.ORION_CODE_API_KEY);
    } finally {
      detachEvidence(lightPage);
      await light.close();
    }
  } catch (error) {
    await light.close().catch(() => undefined);
    throw error;
  }

  const dark = await createAuditedContext(browser, 'dark');
  try {
    const darkPage = await openAuditedPage(dark, host.url, evidence);
    try {
      await expectColorScheme(darkPage, 'dark');
      expect(await reducedMotionIsEffective(darkPage)).toBe(true);
      blocking.push(...(await scanAxe(darkPage)));
      await collapseInspector(darkPage);
      blocking.push(...(await scanAxe(darkPage)));
      await darkPage.setViewportSize({ width: 390, height: 780 });
      await openInspector(darkPage);
      blocking.push(...(await scanAxe(darkPage)));
      await darkPage.keyboard.press('Escape');
      await assertSecretFreeBrowserState(darkPage, workspace.environment.ORION_CODE_API_KEY);
      await captureHashedScreenshot(
        workbenchUi(darkPage).main,
        evidence,
        'quality',
        'web31-p0-12-dark-reduced-motion.png'
      );
    } finally {
      detachEvidence(darkPage);
      await dark.close();
    }
  } catch (error) {
    await dark.close().catch(() => undefined);
    throw error;
  }

  const blockingFindings = blocking.filter(
    violation => violation.impact === 'critical' || violation.impact === 'serious'
  );
  expect(blockingFindings).toEqual([]);
  const secretFindings = evidence.snapshotCounters().secretFindings;
  expect(secretFindings).toBe(0);
  evidence.recordFact('web31.axe_blocking_violations', blockingFindings.length);
  evidence.recordFact('web31.secret_findings', secretFindings);
  evidence.recordFact('web31.reduced_motion_verified', true);
  evidence.recordFact('web31.themes_verified', 'light,dark');
  evidence.recordFact('web31.axe_scans', 4);
});

async function activateWorkspaceThroughUi(page: Page, path: string): Promise<void> {
  const ui = workbenchUi(page);
  await openSessionNavigation(page, { timeout: 30_000 });
  const trigger = ui.workspaceRail.getByRole('button', { name: '选择其他工作区' });
  await expect(trigger).toBeEnabled({ timeout: 30_000 });
  await trigger.click();
  await expect(ui.workspaceDialog).toBeVisible();
  await ui.workspaceDialog.getByRole('textbox', { name: '打开其他本地目录' }).fill(path);
  await ui.workspaceDialog.getByRole('button', { name: '打开', exact: true }).click();
  await expect(ui.workspaceDialog).toBeHidden({ timeout: 30_000 });
  await expect
    .poll(async () => realpathSync((await webBootstrap(page)).workspace), {
      timeout: 30_000,
    })
    .toBe(realpathSync(path));
}

function projectTreeItem(tree: Locator, label: string): Locator {
  return tree.getByRole('button', {
    name: new RegExp(`^${escapeRegex(label)}\\b`, 'u'),
  });
}

function orionMessage(page: Page, marker: string): Locator {
  return page.getByRole('article', { name: 'Orion' }).filter({ hasText: marker }).last();
}

interface NetworkFailure {
  readonly method: string;
  readonly path: string;
  readonly error: string;
}

function captureNetworkFailure(failures: NetworkFailure[]): (request: Request) => void {
  return request => {
    failures.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      error: request.failure()?.errorText ?? '',
    });
  };
}

function allowVerifiedEventStreamAborts(
  testInfo: TestInfo,
  failures: readonly NetworkFailure[]
): void {
  expect(
    failures.every(
      failure =>
        failure.method === 'GET' &&
        failure.path === '/api/v1/events' &&
        failure.error === 'net::ERR_ABORTED'
    )
  ).toBe(true);
  allowExpectedNetworkFailures(testInfo, failures.length);
}

async function openInspectorWithKeyboard(page: Page): Promise<void> {
  const button = workbenchUi(page).inspectorButton;
  await expect(button).toBeVisible();
  await button.focus();
  await button.press('Enter');
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(workbenchUi(page).inspectorDialog).toBeVisible();
}

async function openNavigationWithKeyboard(page: Page): Promise<void> {
  const button = workbenchUi(page).navigationButton;
  await expect(button).toBeVisible();
  await button.focus();
  await button.press('Enter');
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(workbenchUi(page).workspaceRail).toBeVisible();
}

async function focusIsInside(locator: Locator): Promise<boolean> {
  return locator.evaluate(element => element.contains(element.ownerDocument.activeElement));
}

async function centerHitTarget(locator: Locator): Promise<boolean> {
  return locator.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const target = document.elementFromPoint(
      bounds.left + bounds.width / 2,
      bounds.top + bounds.height / 2
    );
    return target === element || element.contains(target);
  });
}

async function expectCenterHitTarget(locator: Locator): Promise<void> {
  await expect.poll(() => centerHitTarget(locator)).toBe(true);
}

async function assertResponsiveBounds(page: Page): Promise<number> {
  const bounds = await page.evaluate(() => {
    const selectors = ['.conversation-column', '.conversation-header', '.input-dock'];
    return {
      innerWidth,
      overflow: Math.max(
        0,
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
        document.body.scrollWidth - document.body.clientWidth
      ),
      elements: selectors.map(selector => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) throw new Error(`Responsive surface ${selector} is missing.`);
        const rect = element.getBoundingClientRect();
        return { selector, left: rect.left, right: rect.right, width: rect.width };
      }),
    };
  });
  for (const element of bounds.elements) {
    expect(element.left, `${element.selector} left bound`).toBeGreaterThanOrEqual(-1);
    expect(element.right, `${element.selector} right bound`).toBeLessThanOrEqual(
      bounds.innerWidth + 1
    );
    expect(element.width, `${element.selector} width`).toBeGreaterThan(0);
  }
  expect(bounds.overflow).toBe(0);
  return bounds.overflow;
}

async function pageHorizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() =>
    Math.max(
      0,
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      document.body.scrollWidth - document.body.clientWidth
    )
  );
}

interface AxeViolation {
  readonly id: string;
  readonly impact: string | null;
}

async function createAuditedContext(
  browser: import('@playwright/test').Browser,
  colorScheme: 'light' | 'dark'
): Promise<BrowserContext> {
  const context = await browser.newContext({
    colorScheme,
    reducedMotion: 'reduce',
    viewport: { width: 1_440, height: 900 },
  });
  await context.addInitScript({ path: require.resolve('axe-core/axe.min.js') });
  return context;
}

const evidenceDetach = new WeakMap<Page, () => void>();

async function openAuditedPage(
  context: BrowserContext,
  url: string,
  evidence: import('./fixtures/evidence').WebE2EEvidenceCollector
): Promise<Page> {
  const page = await context.newPage();
  await installSseCapture(page);
  evidenceDetach.set(page, evidence.attachPage(page));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  await expect
    .poll(() => page.evaluate(() => typeof (globalThis as { axe?: unknown }).axe))
    .toBe('object');
  return page;
}

function detachEvidence(page: Page): void {
  evidenceDetach.get(page)?.();
  evidenceDetach.delete(page);
}

async function scanAxe(page: Page): Promise<AxeViolation[]> {
  return page.evaluate(async () => {
    const axe = (
      globalThis as typeof globalThis & {
        axe: {
          run(
            root: Document,
            options: Readonly<Record<string, unknown>>
          ): Promise<{ readonly violations: AxeViolation[] }>;
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
    }));
  });
}

async function expectColorScheme(page: Page, expected: 'light' | 'dark'): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        preference: matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
        rendered: getComputedStyle(document.documentElement).colorScheme,
      }))
    )
    .toEqual({ preference: expected, rendered: expected });
}

async function reducedMotionIsEffective(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    const selectors = ['.workbench-shell', '.workspace-rail', '.work-panel'];
    const toMilliseconds = (value: string): number => {
      const normalized = value.trim();
      if (normalized.endsWith('ms')) return Number(normalized.slice(0, -2));
      if (normalized.endsWith('s')) return Number(normalized.slice(0, -1)) * 1_000;
      return Number.POSITIVE_INFINITY;
    };
    return selectors.every(selector => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return false;
      const style = getComputedStyle(element);
      const durations = `${style.animationDuration},${style.transitionDuration}`
        .split(',')
        .map(toMilliseconds);
      return durations.every(duration => Number.isFinite(duration) && duration <= 1);
    });
  });
}

async function assertSecretFreeBrowserState(page: Page, secret: string): Promise<void> {
  const paths = [
    '/api/v1/bootstrap',
    '/api/v1/settings',
    '/api/v1/diagnostics',
    '/api/v1/skills',
    '/api/v1/mcp',
  ];
  const serialized: string[] = [];
  for (const path of paths) {
    const response = await browserGet(page, path);
    expect(response.status, path).toBe(200);
    serialized.push(JSON.stringify(response.body));
  }
  serialized.push(await page.locator('html').innerText());
  for (const value of serialized) expect(value).not.toContain(secret);
}

async function captureHashedScreenshot(
  surface: Locator,
  evidence: import('./fixtures/evidence').WebE2EEvidenceCollector,
  key: string,
  filename: string
): Promise<void> {
  const path = join(evidence.scenarioDirectory, filename);
  await surface.screenshot({ path, animations: 'disabled' });
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  evidence.recordFact(`screenshot.${key}`, basename(filename));
  evidence.recordFact('web31.screenshot_sha256', digest);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
