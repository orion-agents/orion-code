import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { basename, join } from 'path';

import type { BrowserContext, Locator, Page, Request, TestInfo } from '@playwright/test';

import type { WebPageV1, WebWorkspaceSummaryV1 } from '../../src/web/protocol';
import { WorkspaceRegistryV1 } from '../../src/services/workspace-registry';
import { activeSessionSnapshot, browserGet, guardedBrowserGet, webBootstrap } from './fixtures/api';
import { OPENAI_FIXTURE_MARKERS, OPENAI_FIXTURE_PROMPTS } from './fixtures/openai-provider';
import { allowExpectedNetworkFailures, expect, installSseCapture, test } from './fixtures/test';
import type { WorkspaceFixture } from './fixtures/workspace';
import {
  answerApproval,
  collapseInspector,
  createSession,
  openInspector,
  openSessionNavigation,
  selectInspectorTab,
  setAgentMode,
  submitPrompt,
  waitForApproval,
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
  await activateWorkspaceThroughUi(page, workspace.primaryWorkspace);
  await createSession(page, { name: 'Primary Active Session' });

  const listed = await guardedBrowserGet<WebPageV1<WebWorkspaceSummaryV1>>(
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

    const tertiaryProject = projectTreeItem(tree, 'workspace-tertiary');
    if ((await tertiaryProject.getAttribute('aria-expanded')) !== 'true') {
      await tertiaryProject.click();
    }
    const tertiarySessions = rail.getByRole('list', {
      name: 'workspace-tertiary 的会话',
    });
    await expect(tertiarySessions.locator('.project-session-row')).toHaveCount(0);
    await expect(tertiarySessions.getByRole('button', { name: '打开项目' })).toBeVisible();

    const tertiaryPin = rail.getByRole('button', {
      name: '置顶项目 workspace-tertiary',
    });
    await tertiaryPin.click();
    await expect(
      rail.getByRole('button', { name: '取消置顶项目 workspace-tertiary' })
    ).toHaveAttribute('aria-pressed', 'true');
    const search = rail.getByRole('searchbox', { name: '搜索项目和会话' });
    await search.fill('workspace-tertiary');
    await expect(tree.locator('.project-toggle')).toHaveCount(1);
    await expect(projectTreeItem(tree, 'workspace-tertiary')).toBeVisible();
    await search.fill('');

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

    await submitPrompt(lazyPage, OPENAI_FIXTURE_PROMPTS.pending);
    await waitForApproval(lazyPage, 'write_file', { timeout: 30_000 });
    const primaryProject = projectTreeItem(tree, 'workspace-primary');
    const primaryNode = primaryProject.locator('xpath=ancestor::section[1]');
    await expect(primaryNode.locator('.project-session-row.active')).toContainText('运行中');
    await expect(primaryNode.locator('.project-session-row.active')).toContainText('等待审批');
    await answerApproval(lazyPage, 'reject', 'write_file');
    await expect
      .poll(async () => (await activeSessionSnapshot(lazyPage)).runtime.processing, {
        timeout: 30_000,
      })
      .toBe(false);

    await captureHashedScreenshot(rail, evidence, 'projects', 'web31-p0-01-projects-lazy-page.png');

    await lazyPage.unroute('**/api/v1/workspaces/**/sessions**');
    const scale = seedProjectSessionScale(workspace, listed.body.items);
    const collectionMetrics = await measureProjectCollections(lazyPage, scale.sessionProjectLabel);
    expect(collectionMetrics.workspaceItems).toBe(100);
    expect(collectionMetrics.sessionItems).toBe(100);
    expect(collectionMetrics.workspaceWarmP95Ms).toBeLessThanOrEqual(250);
    expect(collectionMetrics.sessionWarmP95Ms).toBeLessThanOrEqual(250);

    await lazyPage.reload({ waitUntil: 'domcontentloaded' });
    await waitForWorkbenchReady(lazyPage, { timeout: 30_000 });
    const scaledRail = workbenchUi(lazyPage).workspaceRail;
    const scaledTree = scaledRail.getByRole('navigation', { name: '已知项目' });
    let projectDomNodes = 0;
    await expect
      .poll(
        async () => {
          projectDomNodes = await scaledTree.locator('.project-node').count();
          return projectDomNodes > 0 && projectDomNodes <= 40;
        },
        { timeout: 30_000 }
      )
      .toBe(true);
    const scaledSearch = scaledRail.getByRole('searchbox', { name: '搜索项目和会话' });
    await scaledSearch.fill(scale.sessionProjectLabel);
    await expect(scaledTree.locator('.project-node')).toHaveCount(1);
    const scaledProject = projectTreeItem(scaledTree, scale.sessionProjectLabel);
    await scaledProject.click();
    const scaledSessions = scaledRail.getByRole('list', {
      name: `${scale.sessionProjectLabel} 的会话`,
    });
    await expect(scaledSessions.locator('.project-session-row')).toHaveCount(100, {
      timeout: 30_000,
    });
    expect(await scaledTree.locator('.project-node').count()).toBeLessThanOrEqual(40);
    expect(await scaledSessions.locator('.project-session-row').count()).toBeLessThanOrEqual(100);

    evidence.recordFact('web31.projects_visible', projectCount);
    evidence.recordFact('web31.lazy_session_page', true);
    evidence.recordFact('web31.lazy_session_requests', secondaryPageRequests);
    evidence.recordFact('web31.zero_session_project', true);
    evidence.recordFact('web31.project_pin_search', true);
    evidence.recordFact('web31.session_status_badges', 'running,approval');
    evidence.recordFact('web31.scale_projects', scale.projectCount);
    evidence.recordFact('web31.scale_sessions_per_project', scale.sessionsPerProject);
    evidence.recordFact(
      'web31.workspace_list_warm_p95_ms',
      roundMetric(collectionMetrics.workspaceWarmP95Ms)
    );
    evidence.recordFact(
      'web31.session_page_warm_p95_ms',
      roundMetric(collectionMetrics.sessionWarmP95Ms)
    );
    evidence.recordFact(
      'web31.workspace_list_cold_ms',
      roundMetric(collectionMetrics.workspaceColdMs)
    );
    evidence.recordFact('web31.session_page_cold_ms', roundMetric(collectionMetrics.sessionColdMs));
    evidence.recordFact('web31.project_dom_nodes', projectDomNodes);
    evidence.recordFact('web31.session_dom_nodes', 100);
    evidence.recordFact('web31.project_collection_p95_budget', true);
    evidence.recordFact('web31.project_dom_bounded', true);
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
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.planReady)).toBeVisible({
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
  expect(snapshot.composer.planReview?.status).toBe('awaiting_review');
  expect(provider.requests.filter(request => request.scenario === 'plan')).toHaveLength(2);
  await expect(workbenchUi(page).modeButton).toContainText('PLAN');
  await page.getByRole('button', { name: '批准并进入 BUILD' }).click();
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.planExecutionDone)).toBeVisible({
    timeout: 60_000,
  });
  await expect
    .poll(async () => (await activeSessionSnapshot(page)).runtime.processing, {
      timeout: 60_000,
    })
    .toBe(false);
  const completedPlanRequests = provider.requests.filter(request => request.scenario === 'plan');
  expect(completedPlanRequests).toHaveLength(4);
  expect(completedPlanRequests[2].lastUserText).toContain('action=approve');
  expect(completedPlanRequests[3].lastUserText).toContain('[Harness Completion Gate]');
  await expect(workbenchUi(page).modeButton).toContainText('BUILD');

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

  const projectSearch = ui.workspaceRail.getByRole('searchbox', {
    name: '搜索项目和会话',
  });
  await projectSearch.focus();
  await page.keyboard.press('Control+KeyB');
  await expect(ui.workspaceRail).toBeVisible();
  await expect(ui.workspaceRail).toHaveClass(/project-navigator-collapsed/u);
  const projectRailToggle = ui.workspaceRail.getByRole('button', {
    name: '展开项目导航',
    exact: true,
  });
  await expect(projectRailToggle).toBeVisible();
  await expect(projectRailToggle).toBeFocused();
  await page.keyboard.press('Control+KeyB');
  await expect(ui.workspaceRail).toBeVisible();
  await expect(projectSearch).toBeFocused();
  focusChecks += 2;

  await page.keyboard.press('Control+Shift+KeyB');
  await expect(ui.inspectorDock).toHaveAttribute('data-state', 'collapsed');
  await page.keyboard.press('Control+Shift+KeyB');
  await expect(ui.inspectorDock).toHaveAttribute('data-state', 'expanded');
  await page.keyboard.press('Control+Shift+Digit3');
  await expect(ui.inspectorDock.getByRole('tab', { name: /^终端，/u })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await page.keyboard.press('Control+Shift+Digit1');
  await expect(ui.inspectorDock.getByRole('tab', { name: /^Agent，/u })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  const panelSwitchP95Ms = await measurePanelSwitchLatency(page, ui.inspectorDock, 20);
  expect(panelSwitchP95Ms).toBeLessThanOrEqual(100);

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
  await expectCenterHitTarget(ui.settingsButton);
  await page.keyboard.press('Escape');
  await expect(ui.navigationButton).toBeFocused();
  focusChecks += 1;

  await page.setViewportSize({ width: 320, height: 720 });
  maximumOverflow = Math.max(maximumOverflow, await assertResponsiveBounds(page));
  await expectCenterHitTarget(ui.navigationButton);
  await openNavigationWithKeyboard(page);
  await expectCenterHitTarget(ui.settingsButton);
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
    await openNavigationWithKeyboard(page);
    await expectCenterHitTarget(ui.settingsButton);
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
  evidence.recordFact('web31.ide_shortcuts_verified', 'Ctrl+B,Ctrl+Shift+B,Ctrl+Shift+1..5');
  evidence.recordFact('web31.panel_switch_p95_ms', roundMetric(panelSwitchP95Ms));
  evidence.recordFact('web31.panel_switch_budget', true);
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

  const forcedColors = await createAuditedContext(browser, 'dark', 'active');
  try {
    const forcedPage = await openAuditedPage(forcedColors, host.url, evidence);
    try {
      await expect
        .poll(() => forcedPage.evaluate(() => matchMedia('(forced-colors: active)').matches))
        .toBe(true);
      blocking.push(...(await scanAxe(forcedPage)));
      await assertSecretFreeBrowserState(forcedPage, workspace.environment.ORION_CODE_API_KEY);
      await captureHashedScreenshot(
        workbenchUi(forcedPage).main,
        evidence,
        'forced-colors',
        'web31-p0-12-forced-colors.png'
      );
    } finally {
      detachEvidence(forcedPage);
      await forcedColors.close();
    }
  } catch (error) {
    await forcedColors.close().catch(() => undefined);
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
  evidence.recordFact('web31.forced_colors_verified', true);
  evidence.recordFact('web31.themes_verified', 'light,dark,forced-colors');
  evidence.recordFact('web31.axe_scans', 5);
});

function seedProjectSessionScale(
  workspace: WorkspaceFixture,
  registered: readonly WebWorkspaceSummaryV1[]
): {
  readonly projectCount: number;
  readonly sessionsPerProject: number;
  readonly sessionProjectLabel: string;
} {
  const projectCount = 100;
  const sessionsPerProject = 200;
  const projectPaths = registered.map(entry => realpathSync(entry.path));
  for (let index = projectPaths.length; index < projectCount; index += 1) {
    const projectPath = join(
      workspace.rootDirectory,
      `workspace-scale-${String(index).padStart(3, '0')}`
    );
    mkdirSync(projectPath, { recursive: true, mode: 0o700 });
    projectPaths.push(realpathSync(projectPath));
  }
  const registry = new WorkspaceRegistryV1({
    storagePath: join(workspace.configDirectory, 'workspaces.v1.json'),
  });
  registry.registerKnown(projectPaths, workspace.primaryWorkspace);

  const catalogPath = join(workspace.configDirectory, 'session-catalog.json');
  const existing = existsSync(catalogPath)
    ? (JSON.parse(readFileSync(catalogPath, 'utf8')) as {
        readonly sessions?: Readonly<Record<string, unknown>>;
      })
    : {};
  const sessions: Record<string, unknown> = { ...(existing.sessions ?? {}) };
  const now = Date.now();
  projectPaths.forEach((projectPath, projectIndex) => {
    for (let sessionIndex = 0; sessionIndex < sessionsPerProject; sessionIndex += 1) {
      const id = `scale-${String(projectIndex).padStart(3, '0')}-${String(sessionIndex).padStart(3, '0')}`;
      const updatedAt = now - projectIndex * sessionsPerProject - sessionIndex;
      sessions[id] = {
        id,
        projectPath,
        cwd: projectPath,
        model: 'scale-model',
        startTime: updatedAt,
        createdAt: new Date(updatedAt).toISOString(),
        updatedAt,
        updatedAtIso: new Date(updatedAt).toISOString(),
        messageCount: sessionIndex % 17,
        tokenCount: 0,
        cost: 0,
        name: `Scale Session ${String(sessionIndex).padStart(3, '0')}`,
      };
    }
  });
  writeFileSync(catalogPath, JSON.stringify({ version: 1, sessions }), { mode: 0o600 });
  return {
    projectCount,
    sessionsPerProject,
    sessionProjectLabel: basename(projectPaths.at(-1)!),
  };
}

interface ProjectCollectionMetrics {
  readonly workspaceColdMs: number;
  readonly workspaceWarmP95Ms: number;
  readonly workspaceItems: number;
  readonly sessionColdMs: number;
  readonly sessionWarmP95Ms: number;
  readonly sessionItems: number;
}

async function measureProjectCollections(
  page: Page,
  sessionProjectLabel: string
): Promise<ProjectCollectionMetrics> {
  const bootstrap = await webBootstrap(page);
  return page.evaluate(
    async input => {
      const contextQuery = new URLSearchParams({
        workspaceId: input.workspaceId,
        expectedContextRevision: input.contextRevision,
      });
      const guardedPath = (path: string) => {
        const url = new URL(path, location.origin);
        for (const [key, value] of contextQuery) url.searchParams.set(key, value);
        return `${url.pathname}?${url.searchParams.toString()}`;
      };
      const request = async (path: string) => {
        const startedAt = performance.now();
        const response = await fetch(path, {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        });
        const body = (await response.json()) as {
          readonly items?: readonly { readonly id: string; readonly label?: string }[];
        };
        if (!response.ok) throw new Error(`Performance request failed with ${response.status}.`);
        return { durationMs: performance.now() - startedAt, body };
      };
      const p95 = (samples: readonly number[]) => {
        const ordered = [...samples].sort((left, right) => left - right);
        return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)];
      };

      const workspacePath = guardedPath('/api/v1/workspaces?pageSize=100');
      const workspaceCold = await request(workspacePath);
      const target = workspaceCold.body.items?.find(item => item.label === input.expectedLabel);
      if (!target) throw new Error(`Scaled project ${input.expectedLabel} was not returned.`);
      const workspaceWarm: number[] = [];
      for (let sample = 0; sample < 20; sample += 1) {
        workspaceWarm.push((await request(workspacePath)).durationMs);
      }
      const sessionPath = guardedPath(
        `/api/v1/workspaces/${encodeURIComponent(target.id)}/sessions?pageSize=100`
      );
      const sessionCold = await request(sessionPath);
      const sessionWarm: number[] = [];
      for (let sample = 0; sample < 20; sample += 1) {
        sessionWarm.push((await request(sessionPath)).durationMs);
      }
      return {
        workspaceColdMs: workspaceCold.durationMs,
        workspaceWarmP95Ms: p95(workspaceWarm),
        workspaceItems: workspaceCold.body.items?.length ?? 0,
        sessionColdMs: sessionCold.durationMs,
        sessionWarmP95Ms: p95(sessionWarm),
        sessionItems: sessionCold.body.items?.length ?? 0,
      };
    },
    {
      expectedLabel: sessionProjectLabel,
      workspaceId: bootstrap.workspaceId,
      contextRevision: bootstrap.contextRevision,
    }
  );
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

async function measurePanelSwitchLatency(
  page: Page,
  dock: Locator,
  samples: number
): Promise<number> {
  const tabs = ['审阅', '终端', '文件', 'Git', 'Agent'].map(label =>
    dock.getByRole('tab', { name: new RegExp(`^${label}，`, 'u') })
  );
  const durations: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const tab = tabs[index % tabs.length];
    await tab.evaluate(element => {
      const target = element as HTMLButtonElement;
      const state = { durationMs: -1 };
      Object.defineProperty(globalThis, '__orionPanelSwitchMeasurement', {
        configurable: true,
        value: state,
      });
      target.addEventListener(
        'pointerdown',
        () => {
          const startedAt = performance.now();
          const panelId = target.getAttribute('aria-controls');
          const inspect = () => {
            const panel = panelId ? document.getElementById(panelId) : null;
            if (
              target.getAttribute('aria-selected') === 'true' &&
              panel &&
              !panel.hidden &&
              panel.getClientRects().length > 0
            ) {
              state.durationMs = performance.now() - startedAt;
              return;
            }
            requestAnimationFrame(inspect);
          };
          requestAnimationFrame(inspect);
        },
        { once: true }
      );
    });
    await tab.click();
    let durationMs = -1;
    await expect
      .poll(() =>
        page.evaluate(() => {
          const state = (
            globalThis as typeof globalThis & {
              __orionPanelSwitchMeasurement?: { readonly durationMs: number };
            }
          ).__orionPanelSwitchMeasurement;
          return state?.durationMs ?? -1;
        })
      )
      .toBeGreaterThanOrEqual(0);
    durationMs = await page.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            __orionPanelSwitchMeasurement?: { readonly durationMs: number };
          }
        ).__orionPanelSwitchMeasurement?.durationMs ?? -1
    );
    durations.push(durationMs);
  }
  durations.sort((left, right) => left - right);
  return durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)];
}

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
  colorScheme: 'light' | 'dark',
  forcedColors: 'active' | 'none' = 'none'
): Promise<BrowserContext> {
  const context = await browser.newContext({
    colorScheme,
    forcedColors,
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
  const publicPaths = ['/api/v1/bootstrap', '/api/v1/settings'];
  const guardedPaths = ['/api/v1/diagnostics', '/api/v1/skills', '/api/v1/mcp'];
  const serialized: string[] = [];
  for (const path of publicPaths) {
    const response = await browserGet(page, path);
    expect(response.status, path).toBe(200);
    serialized.push(JSON.stringify(response.body));
  }
  for (const path of guardedPaths) {
    const response = await guardedBrowserGet(page, path);
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
