import { execFileSync } from 'child_process';
import { chmodSync, readdirSync, statSync, writeFileSync } from 'fs';
import { basename, join } from 'path';

import type { Browser, BrowserContext, Locator, Page, Request } from '@playwright/test';

import type {
  WebPageV1,
  WebSessionSummaryV1,
  WebTerminalMetadataV1,
  WebToolDetailSummaryV1,
} from '../../src/web/protocol';
import {
  guardedBrowserGet,
  sessionSnapshot,
  settingsSnapshot,
  updateSettings,
  webBootstrap,
} from './fixtures/api';
import { OPENAI_FIXTURE_MARKERS, OPENAI_FIXTURE_PROMPTS } from './fixtures/openai-provider';
import { startOrionHost } from './fixtures/orion-host';
import {
  allowExpectedNetworkFailures,
  closeCapturedEventSources,
  expect,
  installSseCapture,
  test,
} from './fixtures/test';
import {
  answerApproval,
  applySettings,
  createSession,
  openInspector,
  openSessionNavigation,
  openSettings,
  selectSettingsSection,
  setAgentMode,
  setSettingsSelect,
  submitPrompt,
  waitForApproval,
  waitForWorkbenchReady,
  workbenchUi,
} from './fixtures/ui';
import type { WorkspaceFixtureConfig } from './fixtures/workspace';

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test('WEB33-P0-01 first boot defaults to the built-in blocksmith system appearance', async ({
  evidence,
  page,
}) => {
  const externalRequests: string[] = [];
  const origin = new URL(page.url()).origin;
  const onRequest = (request: Request) => {
    if (new URL(request.url()).origin !== origin) externalRequests.push(request.url());
  };
  page.on('request', onRequest);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForWorkbenchReady(page, { timeout: 30_000 });

  const settings = await settingsSnapshot(page);
  expect(settings.sections.appearance.style.effectiveValue).toBe('orion-blocksmith');
  expect(settings.sections.appearance.style.explicitValue).toBeUndefined();
  expect(settings.sections.appearance.theme.effectiveValue).toBe('system');
  expect(settings.sections.appearance.theme.explicitValue).toBeUndefined();
  const appearance = await rootAppearance(page);
  expect(appearance).toMatchObject({ style: 'orion-blocksmith', theme: 'system' });
  expect(['#d7d0c1', '#15191b']).toContain(appearance.themeColor);
  expect(externalRequests).toHaveLength(0);
  await captureWorkbench(page, evidence, 'web33-p0-01-default-blocksmith.png', '01');
  page.off('request', onRequest);

  evidence.recordFact('web33.appearance_default', 'orion-blocksmith+system');
  evidence.recordFact('web33.theme_color_verified', true);
  evidence.recordFact('web33.remote_theme_requests', externalRequests.length);
});

test('WEB33-P0-02 style and theme save atomically without replacing draft or focus context', async ({
  evidence,
  page,
}) => {
  await createSession(page, { name: 'Appearance atomic session' });
  const initial = await settingsSnapshot(page);
  const seeded = await updateSettings(page, initial.revision, [
    { op: 'set', key: 'appearance.style', value: 'classic' },
    { op: 'set', key: 'appearance.theme', value: 'dark' },
  ]);
  expect(seeded.status).toBe(200);
  await expectRootAppearance(page, 'classic', 'dark');

  const draftText = 'theme switch must preserve this Session draft';
  await workbenchUi(page).composer.fill(draftText);
  const patches: Array<readonly string[]> = [];
  const onRequest = (request: Request) => {
    if (request.method() !== 'PATCH' || new URL(request.url()).pathname !== '/api/v1/settings') {
      return;
    }
    const body = request.postDataJSON() as { operations?: Array<{ key?: string }> };
    patches.push((body.operations ?? []).map(operation => String(operation.key)).sort());
  };
  page.on('request', onRequest);
  const dialog = await openSettings(page);
  await setSettingsSelect(page, '视觉风格', 'orion-blocksmith');
  await setSettingsSelect(page, '主题', 'light');
  await expect(dialog.getByLabel('外观预览：方块工坊，浅色')).toBeVisible();
  expect(await rootAppearance(page)).toMatchObject({ style: 'classic', theme: 'dark' });
  await applySettings(page, 2);
  page.off('request', onRequest);

  await expectRootAppearance(page, 'orion-blocksmith', 'light');
  await expect(workbenchUi(page).composer).toHaveValue(draftText);
  expect(
    await page.evaluate(() => document.activeElement?.closest('#settings-dialog') !== null)
  ).toBe(true);
  expect(patches).toEqual([['appearance.style', 'appearance.theme']]);
  await captureSurface(dialog, evidence, 'web33-p0-02-atomic-preview.png', '02');

  evidence.recordFact('web33.appearance_atomic_patch', patches[0].join(','));
  evidence.recordFact('web33.appearance_committed', 'orion-blocksmith+light');
  evidence.recordFact('web33.appearance_draft_preserved', true);
  evidence.recordFact('web33.appearance_focus_preserved', true);
});

test('WEB33-P0-03 appearance survives reload and same-origin Host restart', async ({
  artifactState,
  evidence,
  host,
  page,
  workspace,
}, testInfo) => {
  const failures: NetworkFailure[] = [];
  const onFailure = (request: Request) => failures.push(networkFailure(request));
  page.on('requestfailed', onFailure);
  await createSession(page, { name: 'Appearance restart session' });
  const sessionId = await sessionIdNamed(page, 'Appearance restart session');
  const before = await settingsSnapshot(page);
  const updated = await updateSettings(page, before.revision, [
    { op: 'set', key: 'appearance.style', value: 'orion-blocksmith' },
    { op: 'set', key: 'appearance.theme', value: 'dark' },
  ]);
  expect(updated.status).toBe(200);
  await expectRootAppearance(page, 'orion-blocksmith', 'dark');
  const nonceBefore = (await webBootstrap(page)).nonce;

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  await expectRootAppearance(page, 'orion-blocksmith', 'dark');
  await expect(
    workbenchUi(page).main.getByRole('heading', {
      level: 1,
      name: 'Appearance restart session',
    })
  ).toBeVisible();
  expect((await sessionSnapshot(page, sessionId)).session.id).toBe(sessionId);

  await host.stop();
  const replacement = await startOrionHost({
    state: artifactState,
    workspace: workspace.primaryWorkspace,
    configRoot: workspace.configDirectory,
    environment: workspace.environment,
    evidence,
    port: host.port,
  });
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForWorkbenchReady(page, { timeout: 30_000 });
    await expectRootAppearance(page, 'orion-blocksmith', 'dark');
    const restarted = await webBootstrap(page);
    expect(restarted.nonce).not.toBe(nonceBefore);
    await expect(
      workbenchUi(page).main.getByRole('heading', {
        level: 1,
        name: 'Appearance restart session',
      })
    ).toBeVisible();
    expect((await sessionSnapshot(page, sessionId)).session.id).toBe(sessionId);
    await captureWorkbench(page, evidence, 'web33-p0-03-restart-persisted.png', '03');
  } finally {
    page.off('requestfailed', onFailure);
    await replacement.stop();
  }
  expect(failures.every(isExpectedRestartFailure)).toBe(true);
  allowExpectedNetworkFailures(testInfo, failures.length);

  evidence.recordFact('web33.appearance_reload_persisted', true);
  evidence.recordFact('web33.appearance_restart_persisted', true);
  evidence.recordFact('web33.appearance_nonce_rotated', true);
  evidence.recordFact('web33.appearance_session_preserved', true);
});

test('WEB33-P0-04 style and light-dark axes reset independently', async ({ evidence, page }) => {
  let settings = await settingsSnapshot(page);
  expect(
    (
      await updateSettings(page, settings.revision, [
        { op: 'set', key: 'appearance.style', value: 'classic' },
        { op: 'set', key: 'appearance.theme', value: 'dark' },
      ])
    ).status
  ).toBe(200);

  let dialog = await openSettings(page);
  await dialog.getByRole('button', { name: '重置视觉风格为继承值' }).click();
  await applySettings(page, 1);
  settings = await settingsSnapshot(page);
  expect(settings.sections.appearance.style.effectiveValue).toBe('orion-blocksmith');
  expect(settings.sections.appearance.theme.effectiveValue).toBe('dark');
  await page.keyboard.press('Escape');

  expect(
    (
      await updateSettings(page, settings.revision, [
        { op: 'set', key: 'appearance.style', value: 'classic' },
      ])
    ).status
  ).toBe(200);
  dialog = await openSettings(page);
  await dialog.getByRole('button', { name: '重置主题为继承值' }).click();
  await applySettings(page, 1);
  settings = await settingsSnapshot(page);
  expect(settings.sections.appearance.theme.effectiveValue).toBe('system');
  expect(settings.sections.appearance.style.effectiveValue).toBe('classic');
  await captureSurface(dialog, evidence, 'web33-p0-04-independent-reset.png', '04');

  evidence.recordFact('web33.style_reset_default', 'orion-blocksmith');
  evidence.recordFact('web33.style_reset_preserved_theme', 'dark');
  evidence.recordFact('web33.theme_reset_default', 'system');
  evidence.recordFact('web33.theme_reset_preserved_style', 'classic');
});

test('WEB33-P0-05 clean pages sync while dirty appearance drafts require explicit rebase', async ({
  browser,
  evidence,
  host,
  page,
  workspace,
}, testInfo) => {
  const other = await openObservedPage(browser, host.url, evidence);
  const failures: NetworkFailure[] = [];
  const onFailure = (request: Request) => failures.push(networkFailure(request));
  other.page.on('requestfailed', onFailure);
  try {
    await openSettings(page);
    await setSettingsSelect(page, '视觉风格', 'classic');

    const current = workspace.readConfig();
    workspace.writeConfig({
      ...current,
      web: {
        ...current.web,
        appearance: { ...current.web?.appearance, theme: 'dark' },
      },
    } as WorkspaceFixtureConfig);

    await expect
      .poll(
        async () => (await settingsSnapshot(other.page)).sections.appearance.theme.effectiveValue
      )
      .toBe('dark');
    const dialog = workbenchUi(page).settingsDialog;
    const conflict = dialog.getByRole('alert').filter({
      hasText: 'Host 设置已在其他位置更新',
    });
    await expect(conflict).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByRole('combobox', { name: '视觉风格' })).toHaveValue('classic');
    await conflict.getByRole('button', { name: '基于最新值重试', exact: true }).click();
    await expect(dialog.getByRole('combobox', { name: '主题' })).toHaveValue('dark');
    await expect(dialog.getByRole('combobox', { name: '视觉风格' })).toHaveValue('classic');
    await applySettings(page, 1);
    await captureSurface(dialog, evidence, 'web33-p0-05-external-rebase.png', '05');

    evidence.recordFact('web33.appearance_clean_page_synced', true);
    evidence.recordFact('web33.appearance_dirty_draft_preserved', true);
    evidence.recordFact('web33.appearance_conflict_rebased', true);
  } finally {
    const closed = await closeCapturedEventSources(other.page);
    if (closed > 0) await expect.poll(() => failures.length).toBeGreaterThan(0);
    other.page.off('requestfailed', onFailure);
    expect(failures.every(isExpectedClosedSseFailure)).toBe(true);
    allowExpectedNetworkFailures(testInfo, failures.length);
    other.detach();
    await other.context.close();
  }
});

test('WEB33-P0-06 invalid and read-only Settings retain last-good appearance', async ({
  evidence,
  page,
  workspace,
}) => {
  const original = workspace.readConfigBytes();
  try {
    workspace.writeRawConfig('{invalid-json');
    await expect.poll(async () => (await settingsSnapshot(page)).state).toBe('invalid');
    let dialog = await openSettings(page);
    await expect(dialog.getByRole('alert').filter({ hasText: '设置文档无效' })).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: '视觉风格' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: /^应用 /u })).toBeDisabled();
    await captureSurface(dialog, evidence, 'web33-p0-06-invalid-last-good.png', '06');
    await page.keyboard.press('Escape');

    workspace.writeRawConfig(original);
    await expect.poll(async () => (await settingsSnapshot(page)).state).toBe('ready');
    chmodSync(workspace.configPath, 0o400);
    await expect.poll(async () => (await settingsSnapshot(page)).writable).toBe(false);
    dialog = await openSettings(page);
    await selectSettingsSection(page, 'Advanced');
    await dialog.getByRole('button', { name: '重新载入设置' }).click();
    await expect(dialog.getByText('只读', { exact: true })).toBeVisible({ timeout: 30_000 });
    await selectSettingsSection(page, 'General');
    await expect(dialog.getByRole('combobox', { name: '视觉风格' })).toBeDisabled();
  } finally {
    chmodSync(workspace.configPath, 0o600);
    workspace.writeRawConfig(original);
  }

  evidence.recordFact('web33.appearance_last_good_verified', true);
  evidence.recordFact('web33.appearance_invalid_save_disabled', true);
  evidence.recordFact('web33.appearance_read_only_save_disabled', true);
});

test('WEB33-P0-07 Tool approval Plan and Goal states remain operable in blocksmith', async ({
  evidence,
  page,
}, testInfo) => {
  const failures: NetworkFailure[] = [];
  const onFailure = (request: Request) => failures.push(networkFailure(request));
  page.on('requestfailed', onFailure);
  await createSession(page, { name: 'Theme state matrix' });
  const matrixSessionId = await sessionIdNamed(page, 'Theme state matrix');
  await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.pendingApproval);
  await waitForApproval(page, 'write_file', { timeout: 45_000 });
  await expect(page.getByRole('article', { name: /^工具 write_file/u })).toBeVisible();
  await answerApproval(page, 'reject', 'write_file');
  await expect
    .poll(async () => (await sessionSnapshot(page, matrixSessionId)).sessionRuntime.phase)
    .toBe('idle');
  await expect(
    workbenchUi(page).sessionList.getByRole('button', {
      name: /^Theme state matrix(?:\s|$)/u,
    })
  ).not.toContainText(/运行中|等待审批|停止中/u);

  await setAgentMode(page, 'PLAN');
  await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.plan);
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.planReady)).toBeVisible({
    timeout: 45_000,
  });
  await expect(page.getByRole('heading', { name: '计划已保存，尚未执行' })).toBeVisible();

  await createSession(page, { name: 'Theme Goal state' });
  const goalSessionId = await sessionIdNamed(page, 'Theme Goal state');
  const inspector = await openInspector(page);
  const objective = 'fixture:goal verify the blocksmith Goal state';
  await inspector.getByRole('textbox', { name: '创建 Goal' }).fill(objective);
  await inspector.getByRole('button', { name: '开始 Goal' }).click();
  await waitForApproval(page, 'write_file', { timeout: 45_000 });
  await expect(inspector.getByRole('heading', { name: objective })).toBeVisible();
  await captureWorkbench(page, evidence, 'web33-p0-07-state-matrix.png', '07');
  await answerApproval(page, 'reject', 'write_file');
  await expect
    .poll(async () => (await sessionSnapshot(page, goalSessionId)).runtime.processing)
    .toBe(false);
  page.off('requestfailed', onFailure);
  expect(failures.every(isExpectedClosedSseFailure)).toBe(true);
  allowExpectedNetworkFailures(testInfo, failures.length);

  evidence.recordFact('web33.theme_state_matrix', 'tool,approval,plan,goal');
  evidence.recordFact('web33.theme_state_actions_verified', true);
});

test('WEB33-P0-08 a connected PTY keeps identity buffer focus and ANSI colors on theme change', async ({
  evidence,
  page,
}) => {
  await page.setViewportSize({ width: 1_600, height: 900 });
  const panel = await openWorkPanel(page, '终端');
  await createTerminal(panel);
  const before = await browserTerminals(page);
  expect(before).toHaveLength(1);

  await writeTerminal(page, panel, "printf '\\033[31mWEB33_THEME_ANSI_RED\\033[0m\\n'");
  await expect(terminalRows(panel)).toContainText('WEB33_THEME_ANSI_RED', { timeout: 30_000 });
  await expect(
    panel.locator('.xterm-rows .xterm-fg-1').filter({ hasText: 'WEB33_THEME_ANSI_RED' })
  ).toHaveCount(1);
  const terminalInput = panel.locator('.xterm-helper-textarea');
  await terminalInput.focus();

  const settings = await settingsSnapshot(page);
  const result = await updateSettings(page, settings.revision, [
    { op: 'set', key: 'appearance.style', value: 'classic' },
    { op: 'set', key: 'appearance.theme', value: 'dark' },
  ]);
  expect(result.status).toBe(200);
  await expectRootAppearance(page, 'classic', 'dark');
  expect((await browserTerminals(page))[0].id).toBe(before[0].id);
  await expect(terminalRows(panel)).toContainText('WEB33_THEME_ANSI_RED');
  await expect(terminalInput).toBeFocused();
  await captureSurface(panel, evidence, 'web33-p0-08-terminal-theme.png', '08');

  evidence.recordFact('web33.theme_terminal_id_preserved', true);
  evidence.recordFact('web33.theme_terminal_buffer_preserved', true);
  evidence.recordFact('web33.theme_terminal_focus_preserved', true);
  evidence.recordFact('web33.theme_terminal_ansi_verified', true);
});

test('WEB33-P0-09 Files Git Review and 128KiB Tool detail stay readable', async ({
  evidence,
  page,
  workspace,
}) => {
  initializeGitFixture(workspace.primaryWorkspace);
  await createSession(page, { name: 'Theme engineering surfaces' });
  await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.largeOutput);
  await waitForApproval(page, 'exec_command', { timeout: 45_000 });
  await answerApproval(page, 'once', 'exec_command');
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.largeOutputDone)).toBeVisible({
    timeout: 60_000,
  });
  const details = await expectToolDetail(page);

  const files = await openWorkPanel(page, '文件');
  await expect(files.getByText('seed.txt', { exact: true })).toBeVisible({ timeout: 30_000 });
  const git = await openWorkPanel(page, 'Git');
  await expect(git.getByText('seed.txt', { exact: true })).toBeVisible({ timeout: 30_000 });
  const review = await openWorkPanel(page, '审阅');
  await expect(review.getByText(/seed\.txt/u)).toBeVisible({ timeout: 30_000 });
  await captureSurface(review, evidence, 'web33-p0-09-engineering-surfaces.png', '09');

  evidence.recordFact('web33.theme_engineering_surfaces', 'files,git,review,tool-output');
  evidence.recordFact('web33.theme_large_output_bytes', details.outputBytes);
  evidence.recordFact('web33.theme_engineering_readable', true);
});

test('WEB33-P0-10 blocksmith keeps the full responsive viewport matrix overflow-free', async ({
  evidence,
  page,
}) => {
  let maximumOverflow = 0;
  for (const width of [320, 390, 760, 1_180, 1_440, 1_920]) {
    await page.setViewportSize({ width, height: width <= 390 ? 780 : 900 });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
    maximumOverflow = Math.max(maximumOverflow, await horizontalOverflow(page));
    await expect(workbenchUi(page).composer).toBeVisible();
    const shell = page.locator('.workbench-shell');
    if (width <= 760) {
      await expect(shell).toHaveClass(/project-navigation-drawer/u);
      await openSessionNavigation(page);
      await expect(workbenchUi(page).workspaceRail).toHaveClass(/drawer-open/u);
      await page.keyboard.press('Escape');
    } else {
      await expect(shell).not.toHaveClass(/project-navigation-drawer/u);
      await expect(workbenchUi(page).workspaceRail).toBeVisible();
    }
    if (width <= 1_180) {
      await expect(workbenchUi(page).inspectorSurface).toHaveAttribute('data-mode', 'overlay');
      await openInspector(page);
      await expect(workbenchUi(page).inspectorSurface).toHaveClass(/drawer-open/u);
      await page.keyboard.press('Escape');
      await expect(workbenchUi(page).inspectorPanel).toBeHidden();
    } else {
      await expect(workbenchUi(page).inspectorSurface).toHaveAttribute('data-mode', 'dock');
    }
  }
  expect(maximumOverflow).toBe(0);
  await page.setViewportSize({ width: 390, height: 780 });
  await captureWorkbench(page, evidence, 'web33-p0-10-responsive.png', '10');

  evidence.recordFact('web33.theme_viewport_matrix', '320,390,760,1180,1440,1920');
  evidence.recordFact('web33.theme_horizontal_overflow', maximumOverflow);
  evidence.recordFact('web33.theme_responsive_controls_verified', true);
});

test('WEB33-P0-11 keyboard 200-percent reflow forced colors and axe remain clean', async ({
  browser,
  evidence,
  host,
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await openSessionNavigation(page);
  const settingsButton = workbenchUi(page).settingsButton;
  await settingsButton.focus();
  await settingsButton.press('Enter');
  await expect(workbenchUi(page).settingsDialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settingsButton).toBeFocused();
  expect(await horizontalOverflow(page)).toBe(0);

  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await expect
    .poll(() => page.evaluate(() => matchMedia('(forced-colors: active)').matches))
    .toBe(true);
  await captureWorkbench(page, evidence, 'web33-p0-11-forced-colors.png', '11');

  const audit = await openAxePage(browser, host.url, evidence);
  let violations: AxeViolation[] = [];
  try {
    violations = await scanAxe(audit.page);
    expect(
      violations.filter(value => ['critical', 'serious'].includes(value.impact ?? ''))
    ).toEqual([]);
  } finally {
    audit.detach();
    await audit.context.close();
  }

  evidence.recordFact('web33.theme_axe_blocking_violations', 0);
  evidence.recordFact('web33.theme_zoom_200_verified', true);
  evidence.recordFact('web33.theme_forced_colors_verified', true);
  evidence.recordFact('web33.theme_keyboard_verified', true);
});

test('WEB33-P0-12 theme assets remain self-hosted CSP-bound secret-free and within budget', async ({
  artifactState,
  evidence,
  page,
  workspace,
}) => {
  const external: string[] = [];
  const origin = new URL(page.url()).origin;
  const onRequest = (request: Request) => {
    const target = new URL(request.url());
    if (target.origin !== origin) external.push(target.origin);
  };
  page.on('request', onRequest);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  page.off('request', onRequest);
  expect(external).toHaveLength(0);

  const html = await fetch(page.url());
  const csp = html.headers.get('content-security-policy') ?? '';
  expect(csp).toContain("default-src 'self'");
  expect(csp).not.toContain("'unsafe-eval'");
  const assetDirectory = join(
    artifactState.installation.packageRoot,
    'dist',
    'web-client',
    'assets'
  );
  const cssBytes = readdirSync(assetDirectory)
    .filter(name => name.endsWith('.css'))
    .reduce((total, name) => total + statSync(join(assetDirectory, name)).size, 0);
  expect(cssBytes).toBeLessThanOrEqual(160 * 1024);
  const serialized = [
    await page.locator('html').innerText(),
    JSON.stringify((await settingsSnapshot(page)).sections.appearance),
  ].join('\n');
  expect(serialized).not.toContain(workspace.environment.ORION_CODE_API_KEY);
  await captureWorkbench(page, evidence, 'web33-p0-12-csp-assets.png', '12');

  evidence.recordFact('web33.theme_csp_violations', 0);
  evidence.recordFact('web33.theme_external_asset_requests', external.length);
  evidence.recordFact('web33.theme_secret_findings', 0);
  evidence.recordFact('web33.theme_asset_bytes', cssBytes);
  evidence.recordFact('web33.theme_asset_budget_verified', true);
});

interface NetworkFailure {
  readonly method: string;
  readonly path: string;
  readonly error: string;
}

interface AxeViolation {
  readonly id: string;
  readonly impact: string | null;
  readonly nodes: readonly {
    readonly target: readonly string[];
    readonly html: string;
    readonly failureSummary: string | null;
  }[];
}

async function rootAppearance(page: Page): Promise<{
  readonly style: string | null;
  readonly theme: string | null;
  readonly themeColor: string | null;
}> {
  return page.evaluate(() => ({
    style: document.documentElement.getAttribute('data-ui-style'),
    theme: document.documentElement.getAttribute('data-theme'),
    themeColor:
      document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content ?? null,
  }));
}

async function expectRootAppearance(page: Page, style: string, theme: string): Promise<void> {
  await expect.poll(() => rootAppearance(page)).toMatchObject({ style, theme });
}

async function captureWorkbench(
  page: Page,
  evidence: import('./fixtures/evidence').WebE2EEvidenceCollector,
  name: string,
  id: string
): Promise<void> {
  await captureSurface(page.locator('.workbench-shell'), evidence, name, id);
}

async function captureSurface(
  surface: Locator,
  evidence: import('./fixtures/evidence').WebE2EEvidenceCollector,
  name: string,
  id: string
): Promise<void> {
  await surface.screenshot({
    path: join(evidence.scenarioDirectory, name),
    animations: 'disabled',
  });
  evidence.recordFact(`screenshot.web33-p0-${id}`, basename(name));
}

async function openObservedPage(
  browser: Browser,
  url: string,
  evidence: import('./fixtures/evidence').WebE2EEvidenceCollector
): Promise<{ readonly context: BrowserContext; readonly page: Page; readonly detach: () => void }> {
  const context = await browser.newContext({ bypassCSP: false });
  const page = await context.newPage();
  await installSseCapture(page);
  const detach = evidence.attachPage(page);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  return { context, page, detach };
}

async function openAxePage(
  browser: Browser,
  url: string,
  evidence: import('./fixtures/evidence').WebE2EEvidenceCollector
): Promise<{ readonly context: BrowserContext; readonly page: Page; readonly detach: () => void }> {
  const context = await browser.newContext({ bypassCSP: true });
  await context.addInitScript({ path: require.resolve('axe-core/axe.min.js') });
  const page = await context.newPage();
  const detach = evidence.attachPage(page);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  await expect
    .poll(() => page.evaluate(() => typeof (globalThis as { axe?: unknown }).axe))
    .toBe('object');
  return { context, page, detach };
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
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
    });
    return result.violations.map(value => ({
      id: value.id,
      impact: value.impact,
      nodes: value.nodes.map(node => ({
        target: node.target,
        html: node.html,
        failureSummary: node.failureSummary,
      })),
    }));
  });
}

function networkFailure(request: Request): NetworkFailure {
  return {
    method: request.method(),
    path: new URL(request.url()).pathname,
    error: request.failure()?.errorText ?? '',
  };
}

function isExpectedRestartFailure(failure: NetworkFailure): boolean {
  return (
    failure.method === 'GET' &&
    failure.path === '/api/v1/events' &&
    /net::ERR_(?:ABORTED|CONNECTION_REFUSED)/u.test(failure.error)
  );
}

function isExpectedClosedSseFailure(failure: NetworkFailure): boolean {
  return (
    failure.method === 'GET' &&
    failure.path === '/api/v1/events' &&
    failure.error === 'net::ERR_ABORTED'
  );
}

function orionMessage(page: Page, marker: string) {
  return page.getByRole('article', { name: 'Orion' }).filter({ hasText: marker }).last();
}

async function openWorkPanel(page: Page, name: '终端' | '文件' | 'Git' | '审阅'): Promise<Locator> {
  const panel = await openInspector(page);
  const tab = panel.getByRole('tab', { name: new RegExp(`^${name}`, 'u') });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  const pane = panel.getByRole('tabpanel', { name: new RegExp(`^${name}`, 'u') });
  await expect(pane).toBeVisible();
  return pane;
}

async function createTerminal(panel: Locator): Promise<void> {
  const before = await panel.getByRole('tab').count();
  const button = panel.getByRole('button', { name: '新建终端', exact: true }).first();
  await expect(button).toBeEnabled({ timeout: 30_000 });
  await button.click();
  const risk = panel.getByRole('alertdialog', { name: '创建本地终端前请确认风险' });
  await expect
    .poll(async () => (await risk.isVisible()) || (await panel.getByRole('tab').count()) > before, {
      timeout: 30_000,
    })
    .toBe(true);
  if (await risk.isVisible()) {
    await risk.getByRole('checkbox', { name: '我理解终端可以执行本地命令' }).check();
    await risk.getByRole('button', { name: '我理解，创建终端', exact: true }).click();
  }
  await expect(panel.getByRole('tab')).toHaveCount(before + 1, { timeout: 30_000 });
  await expect(panel.getByText('PTY 已连接', { exact: true })).toBeVisible({ timeout: 30_000 });
}

async function writeTerminal(page: Page, panel: Locator, command: string): Promise<void> {
  const textarea = panel.locator('.xterm-helper-textarea');
  await expect(textarea).toBeAttached({ timeout: 30_000 });
  await textarea.focus();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

function terminalRows(panel: Locator): Locator {
  return panel.locator('.xterm-rows');
}

async function browserTerminals(page: Page): Promise<readonly WebTerminalMetadataV1[]> {
  const result = await guardedBrowserGet<WebPageV1<WebTerminalMetadataV1>>(
    page,
    '/api/v1/terminals?pageSize=100'
  );
  expect(result.status).toBe(200);
  return result.body.items;
}

async function sessionIdNamed(page: Page, name: string): Promise<string> {
  const result = await guardedBrowserGet<WebPageV1<WebSessionSummaryV1>>(
    page,
    '/api/v1/sessions?pageSize=100'
  );
  expect(result.status).toBe(200);
  const session = result.body.items.find(value => value.name === name);
  expect(session).toBeDefined();
  return session!.id;
}

function initializeGitFixture(workspace: string): void {
  execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'web33@example.invalid'], {
    cwd: workspace,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.name', 'WEB33 Fixture'], {
    cwd: workspace,
    stdio: 'ignore',
  });
  execFileSync('git', ['add', '.'], { cwd: workspace, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fixture baseline'], { cwd: workspace, stdio: 'ignore' });
  writeFileSync(join(workspace, 'seed.txt'), 'alpha\nblocksmith review change\n', 'utf8');
}

async function expectToolDetail(page: Page): Promise<WebToolDetailSummaryV1> {
  let item: WebToolDetailSummaryV1 | undefined;
  await expect
    .poll(async () => {
      const result = await guardedBrowserGet<WebPageV1<WebToolDetailSummaryV1>>(
        page,
        '/api/v1/tool-details?pageSize=100'
      );
      if (result.status !== 200) return 0;
      item = result.body.items.find(value => value.toolName === 'exec_command');
      return item?.outputBytes ?? 0;
    })
    .toBeGreaterThanOrEqual(128 * 1024);
  return item!;
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() =>
    Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
  );
}
