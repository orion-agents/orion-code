import { createHash, randomUUID } from 'crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, relative, resolve } from 'path';

import { chromium, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

import {
  activeSessionSnapshot,
  browserMutation,
  settingsSnapshot,
  webBootstrap,
} from '../../tests/e2e/fixtures/api';
import { prepareWebE2EArtifact } from '../../tests/e2e/fixtures/artifact';
import { MCP_FIXTURE_ECHO_TOOL } from '../../tests/e2e/fixtures/mcp-server';
import {
  OPENAI_FIXTURE_MARKERS,
  OPENAI_FIXTURE_PROMPTS,
  startOpenAiProviderFixture,
  type OpenAiProviderFixture,
} from '../../tests/e2e/fixtures/openai-provider';
import { startOrionHost, type OrionHostHandle } from '../../tests/e2e/fixtures/orion-host';
import {
  answerApproval,
  createSession,
  openInspector,
  renameActiveSession,
  selectInspectorTab,
  setAgentMode,
  submitPrompt,
  waitForApproval,
  waitForWorkbenchReady,
  workbenchUi,
} from '../../tests/e2e/fixtures/ui';
import { createWorkspaceFixture, type WorkspaceFixture } from '../../tests/e2e/fixtures/workspace';

const REPOSITORY_ROOT = resolve(__dirname, '../..');
const DEFAULT_OUTPUT_DIRECTORY = join(
  REPOSITORY_ROOT,
  'docs',
  'assets',
  'screenshots',
  'v0.3.0-web'
);
const DEFAULT_TIMEOUT_MS = 60_000;

interface CapturedScreenshot {
  readonly order: number;
  readonly id: string;
  readonly title: string;
  readonly file: string;
  readonly sha256: string;
  readonly viewport: { readonly width: number; readonly height: number };
}

interface GalleryManifest {
  readonly schemaVersion: 1;
  readonly kind: 'orion.web-state-gallery';
  readonly createdAt: string;
  readonly package: { readonly name: string; readonly version: string };
  readonly artifact: {
    readonly filename: string;
    readonly sha256: string;
    readonly receiptDigest: string;
  };
  readonly runtime: {
    readonly node: string;
    readonly browser: string;
    readonly browserVersion: string;
    readonly hostTransport: 'loopback-http-sse';
    readonly provider: 'deterministic-loopback-openai-sse';
  };
  readonly screenshots: readonly CapturedScreenshot[];
}

async function main(): Promise<void> {
  const chromePath = process.env.CHROME_PATH?.trim();
  if (!chromePath) throw new Error('CHROME_PATH is required for the real Chrome state gallery.');

  const outputDirectory = resolve(process.env.ORION_WEB_GALLERY_OUTPUT ?? DEFAULT_OUTPUT_DIRECTORY);
  mkdirSync(outputDirectory, { recursive: true });

  const state = prepareWebE2EArtifact();
  const provider = await startOpenAiProviderFixture();
  const workspace = createWorkspaceFixture({
    baseUrl: provider.baseUrl,
    installEnvironment: false,
    includeMcp: true,
  });

  let host: OrionHostHandle | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  const screenshots: CapturedScreenshot[] = [];

  try {
    host = await startOrionHost({
      state,
      workspace: workspace.primaryWorkspace,
      configRoot: workspace.configDirectory,
      environment: workspace.environment,
    });
    browser = await chromium.launch({ executablePath: chromePath, headless: true });
    context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      deviceScaleFactor: 1,
      colorScheme: 'light',
      reducedMotion: 'reduce',
      bypassCSP: false,
    });
    const page = await context.newPage();
    await page.goto(host.url, { waitUntil: 'domcontentloaded' });
    await waitForWorkbenchReady(page, { timeout: 30_000 });

    await capture(page, outputDirectory, screenshots, 'workspace-empty', '空工作台');

    await createNamedSession(page, '真实构建演示');
    await capture(page, outputDirectory, screenshots, 'session-ready', 'BUILD 会话就绪');

    await submitPrompt(
      page,
      `${OPENAI_FIXTURE_PROMPTS.denyWrite} 请演示一次需要人工确认的文件写入。`
    );
    await waitForApproval(page, 'write_file', { timeout: 30_000 });
    await capture(page, outputDirectory, screenshots, 'approval-pending', '工具审批等待中');

    await answerApproval(page, 'reject', 'write_file');
    await expect(page.getByRole('article', { name: '工具 write_file：失败' })).toContainText(
      'User denied the operation.',
      { timeout: 45_000 }
    );
    await waitForIdle(page);
    await capture(page, outputDirectory, screenshots, 'approval-denied', '审批拒绝且无副作用');

    await submitPrompt(
      page,
      `${OPENAI_FIXTURE_PROMPTS.approveWriteExec} 请完成真实文件写入并运行测试。`
    );
    await waitForApproval(page, 'write_file', { timeout: 30_000 });
    await answerApproval(page, 'once', 'write_file');
    await waitForApproval(page, 'exec_command', { timeout: 30_000 });
    await answerApproval(page, 'once', 'exec_command');
    await waitForMarker(page, OPENAI_FIXTURE_MARKERS.approveWriteExecDone);
    await waitForIdle(page);
    await capture(page, outputDirectory, screenshots, 'build-complete', 'BUILD 写入与测试完成');

    await createNamedSession(page, '计划模式演示');
    await setAgentMode(page, 'PLAN');
    await submitPrompt(page, `${OPENAI_FIXTURE_PROMPTS.plan} 请先规划，再按计划执行。`);
    await waitForMarker(page, OPENAI_FIXTURE_MARKERS.planExecutionDone);
    await waitForIdle(page);
    await reloadWorkbench(page);
    await selectInspectorTab(page, 'Goal');
    await expect(
      workbenchUi(page).inspector.getByText('WEB_E2E_PLAN', { exact: true })
    ).toBeVisible();
    await capture(page, outputDirectory, screenshots, 'plan-complete', 'PLAN 收据与执行结果');

    await createNamedSession(page, 'Goal 模式演示');
    const objective = `${OPENAI_FIXTURE_PROMPTS.goal} 完成一个带文件和测试证据的持久 Goal`;
    const inspector = await openInspector(page);
    await inspector.getByRole('textbox', { name: '创建 Goal' }).fill(objective);
    await inspector.getByRole('button', { name: '开始 Goal' }).click();
    await waitForApproval(page, 'write_file', { timeout: 45_000 });
    await answerApproval(page, 'once', 'write_file');
    await waitForApproval(page, 'exec_command', { timeout: 45_000 });
    await answerApproval(page, 'once', 'exec_command');
    await waitForMarker(page, OPENAI_FIXTURE_MARKERS.goalComplete);
    await waitForIdle(page);
    await reloadWorkbench(page);
    await selectInspectorTab(page, 'Goal');
    await expect(
      workbenchUi(page).inspector.getByRole('heading', { name: objective })
    ).toBeVisible();
    await capture(page, outputDirectory, screenshots, 'goal-complete', 'Goal 完成与证据');

    await createNamedSession(page, 'MCP 与大输出演示');
    await selectInspectorTab(page, '能力');
    await capture(
      page,
      outputDirectory,
      screenshots,
      'capabilities-dormant',
      'Skills 与 MCP 未激活'
    );

    await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.mcpEcho);
    await waitForApproval(page, MCP_FIXTURE_ECHO_TOOL, { timeout: 45_000 });
    await capture(page, outputDirectory, screenshots, 'mcp-approval', 'MCP 工具审批');
    await answerApproval(page, 'once', MCP_FIXTURE_ECHO_TOOL);
    await waitForMarker(page, OPENAI_FIXTURE_MARKERS.mcpEchoDone);
    await waitForIdle(page);
    await reloadWorkbench(page);
    await selectInspectorTab(page, '能力');
    await expect(
      workbenchUi(page).inspector.getByText('stdio · 2 tools', { exact: true })
    ).toBeVisible();
    await capture(page, outputDirectory, screenshots, 'capabilities-connected', 'MCP 已激活');

    await submitPrompt(
      page,
      `${OPENAI_FIXTURE_PROMPTS.largeOutput} 生成真实的大输出并通过分页查看。`
    );
    await waitForApproval(page, 'exec_command', { timeout: 45_000 });
    await answerApproval(page, 'once', 'exec_command');
    await waitForMarker(page, OPENAI_FIXTURE_MARKERS.largeOutputDone);
    await waitForIdle(page);
    const activity = await selectInspectorTab(page, '活动');
    await activity.getByRole('button', { name: /刷新/u }).click();
    const detailGroup = activity.getByRole('group', { name: '工具输出详情' });
    await expect(detailGroup).toBeVisible({ timeout: 30_000 });
    await detailGroup.getByRole('button').filter({ hasText: 'exec_command' }).first().click();
    await expect(activity.locator('.detail-output pre')).toBeVisible({ timeout: 30_000 });
    await capture(page, outputDirectory, screenshots, 'tool-output', '工具大输出分页检查器');

    await selectInspectorTab(page, '诊断');
    await capture(page, outputDirectory, screenshots, 'diagnostics', '连接与恢复诊断');

    const ui = workbenchUi(page);
    await ui.settingsButton.click();
    await expect(ui.settingsDialog).toBeVisible();
    await capture(page, outputDirectory, screenshots, 'settings', 'Settings · General');
    await ui.settingsDialog.getByRole('button', { name: '关闭设置' }).click();
    await expect(ui.settingsDialog).toBeHidden();

    await context.setOffline(true);
    await expect(page.getByText('网络已离线，Orion 将在恢复后重连', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await capture(page, outputDirectory, screenshots, 'offline', '离线与待重连');
    await context.setOffline(false);
    await expect(page.getByText('本地 Runtime 已连接', { exact: true })).toBeVisible({
      timeout: 30_000,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await workbenchUi(page).navigationButton.click();
    await expect(workbenchUi(page).workspaceRail).toBeVisible();
    await capture(page, outputDirectory, screenshots, 'mobile-navigation', '移动端会话导航');
    await page.keyboard.press('Escape');
    await expect(workbenchUi(page).workspaceRail).toBeHidden();
    await workbenchUi(page).inspectorButton.click();
    await expect(workbenchUi(page).inspector).toBeVisible();
    await capture(page, outputDirectory, screenshots, 'mobile-inspector', '移动端详情面板');

    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 960 });

    const desktopUi = workbenchUi(page);
    await desktopUi.settingsButton.click();
    await expect(desktopUi.settingsDialog).toBeVisible();
    const settingsDialog = desktopUi.settingsDialog;
    await settingsDialog.getByRole('combobox', { name: '主题' }).selectOption('dark');
    await settingsDialog.getByRole('combobox', { name: '动效' }).selectOption('reduced');
    await expect(settingsDialog.getByRole('button', { name: '应用 2 项' })).toBeEnabled();
    await capture(page, outputDirectory, screenshots, 'settings-dirty', 'Settings · 两项草稿');

    await settingsDialog.getByRole('button', { name: '关闭设置' }).click();
    await expect(page.getByRole('alertdialog', { name: '放弃未应用的更改？' })).toBeVisible();
    await capture(
      page,
      outputDirectory,
      screenshots,
      'settings-discard-confirm',
      'Settings · 放弃草稿确认'
    );
    await page
      .getByRole('alertdialog', { name: '放弃未应用的更改？' })
      .getByRole('button', { name: '继续编辑' })
      .click();
    await settingsDialog.getByRole('button', { name: '应用 2 项' }).click();
    await expect(settingsDialog.getByText('设置已安全保存并应用。', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await capture(page, outputDirectory, screenshots, 'settings-saved', 'Settings · 原子保存成功');

    await settingsDialog.getByRole('button', { name: 'Models & Reasoning' }).click();
    await expect(settingsDialog.getByRole('heading', { name: '模型与推理' })).toBeVisible();
    await capture(page, outputDirectory, screenshots, 'settings-models', 'Settings · 模型与推理');

    await settingsDialog.getByRole('button', { name: 'Permissions' }).click();
    await expect(settingsDialog.getByRole('heading', { name: '权限' })).toBeVisible();
    await capture(page, outputDirectory, screenshots, 'settings-permissions', 'Settings · 权限');
    await settingsDialog.getByRole('radio', { name: 'Allow' }).click();
    await expect(page.getByRole('alertdialog', { name: '确认启用 Allow' })).toBeVisible();
    await capture(
      page,
      outputDirectory,
      screenshots,
      'settings-allow-confirm',
      'Settings · Allow 风险确认'
    );
    await page
      .getByRole('alertdialog', { name: '确认启用 Allow' })
      .getByRole('button', { name: '保持当前策略' })
      .click();

    await settingsDialog.getByRole('button', { name: 'Advanced' }).click();
    await expect(settingsDialog.getByRole('heading', { name: '高级' })).toBeVisible();
    await capture(page, outputDirectory, screenshots, 'settings-advanced', 'Settings · 高级状态');
    await settingsDialog.getByRole('button', { name: '关闭设置' }).click();
    await expect(settingsDialog).toBeHidden();

    await desktopUi.settingsButton.click();
    await expect(settingsDialog).toBeVisible();
    await settingsDialog.getByRole('combobox', { name: '主题' }).selectOption('light');
    const other = await context.newPage();
    try {
      await other.goto(host.url, { waitUntil: 'domcontentloaded' });
      await waitForWorkbenchReady(other, { timeout: 30_000 });
      const currentSettings = await settingsSnapshot(other);
      const mutation = await browserMutation(other, '/api/v1/settings', {
        method: 'PATCH',
        body: {
          requestId: randomUUID(),
          expectedRevision: currentSettings.revision,
          operations: [{ op: 'set', key: 'appearance.theme', value: 'system' }],
        },
      });
      if (mutation.status !== 200) {
        throw new Error(`Failed to create the real Settings conflict (HTTP ${mutation.status}).`);
      }
      await expect(
        settingsDialog.getByText('Host 设置已在其他位置更新', { exact: true })
      ).toBeVisible({ timeout: 30_000 });
      await capture(
        page,
        outputDirectory,
        screenshots,
        'settings-conflict',
        'Settings · 双页面版本冲突'
      );
      await settingsDialog.getByRole('button', { name: '采用服务器值' }).click();
    } finally {
      await other.close();
    }
    await settingsDialog.getByRole('button', { name: '关闭设置' }).click();
    await expect(settingsDialog).toBeHidden();

    await submitPrompt(page, `${OPENAI_FIXTURE_PROMPTS.pending} 保持一次真实审批等待。`);
    await waitForApproval(page, 'write_file', { timeout: 30_000 });
    await desktopUi.settingsButton.click();
    await settingsDialog.getByRole('button', { name: 'Permissions' }).click();
    await expect(settingsDialog.getByText(/当前回合正在运行/u)).toBeVisible();
    await capture(
      page,
      outputDirectory,
      screenshots,
      'settings-runtime-busy',
      'Settings · Runtime 忙碌锁定'
    );
    await settingsDialog.getByRole('button', { name: '关闭设置' }).click();
    await answerApproval(page, 'reject', 'write_file');
    await waitForIdle(page);

    const validConfigBytes = readFileSync(workspace.configPath);
    await desktopUi.settingsButton.click();
    await settingsDialog.getByRole('button', { name: 'Advanced' }).click();
    writeFileSync(workspace.configPath, '{bad-json', { encoding: 'utf8', mode: 0o600 });
    await expect(settingsDialog.getByText(/设置文档无效。控件已锁定/u)).toBeVisible({
      timeout: 30_000,
    });
    await capture(
      page,
      outputDirectory,
      screenshots,
      'settings-invalid',
      'Settings · 非法配置与 last-good'
    );

    writeFileSync(workspace.configPath, validConfigBytes, { mode: 0o600 });
    await expect
      .poll(async () => (await settingsSnapshot(page)).state, { timeout: 30_000 })
      .toBe('ready');
    await settingsDialog.getByRole('button', { name: '重新载入设置' }).click();
    await expect(settingsDialog.getByText(/设置文档无效。控件已锁定/u)).toBeHidden({
      timeout: 30_000,
    });

    chmodSync(workspace.configPath, 0o400);
    await settingsDialog.getByRole('button', { name: '重新载入设置' }).click();
    await expect(settingsDialog.getByText('设置当前为只读状态。', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await capture(page, outputDirectory, screenshots, 'settings-read-only', 'Settings · 只读配置');
    chmodSync(workspace.configPath, 0o600);

    const manifest: GalleryManifest = {
      schemaVersion: 1,
      kind: 'orion.web-state-gallery',
      createdAt: new Date().toISOString(),
      package: {
        name: state.artifact.receipt.package.name,
        version: state.artifact.receipt.package.version,
      },
      artifact: {
        filename: state.artifact.receipt.tarball.filename,
        sha256: state.artifact.receipt.tarball.sha256,
        receiptDigest: state.artifact.receipt.receiptDigest,
      },
      runtime: {
        node: process.version,
        browser: 'Google Chrome',
        browserVersion: await browser.version(),
        hostTransport: 'loopback-http-sse',
        provider: 'deterministic-loopback-openai-sse',
      },
      screenshots,
    };
    writeFileSync(join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    process.stdout.write(
      `${JSON.stringify(
        {
          outputDirectory: relative(REPOSITORY_ROOT, outputDirectory),
          screenshotCount: screenshots.length,
          artifactSha256: manifest.artifact.sha256,
          browserVersion: manifest.runtime.browserVersion,
        },
        null,
        2
      )}\n`
    );
  } finally {
    await closeQuietly(context, browser, host, workspace, provider);
  }
}

async function capture(
  page: Page,
  outputDirectory: string,
  screenshots: CapturedScreenshot[],
  id: string,
  title: string
): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.waitForTimeout(180);
  const order = screenshots.length + 1;
  const filename = `${String(order).padStart(2, '0')}-${id}.png`;
  const path = join(outputDirectory, filename);
  await page.screenshot({
    path,
    fullPage: false,
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
  });
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('Screenshot page has no viewport.');
  screenshots.push({
    order,
    id,
    title,
    file: filename,
    sha256: sha256(readFileSync(path)),
    viewport,
  });
}

async function waitForMarker(page: Page, marker: string): Promise<void> {
  await expect(
    page.getByRole('article', { name: 'Orion' }).filter({ hasText: marker }).last()
  ).toBeVisible({ timeout: DEFAULT_TIMEOUT_MS });
}

async function waitForIdle(page: Page): Promise<void> {
  await expect
    .poll(async () => (await activeSessionSnapshot(page)).runtime.processing, {
      timeout: DEFAULT_TIMEOUT_MS,
    })
    .toBe(false);
}

async function createNamedSession(page: Page, name: string): Promise<void> {
  const previousSessionId = (await webBootstrap(page)).activeSessionId;
  await createSession(page);
  await expect
    .poll(async () => (await webBootstrap(page)).activeSessionId, { timeout: 30_000 })
    .not.toBe(previousSessionId);
  await renameActiveSession(page, name, { timeout: 30_000 });
}

async function reloadWorkbench(page: Page): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForWorkbenchReady(page, { timeout: 30_000 });
}

async function closeQuietly(
  context: BrowserContext | undefined,
  browser: Browser | undefined,
  host: OrionHostHandle | undefined,
  workspace: WorkspaceFixture,
  provider: OpenAiProviderFixture
): Promise<void> {
  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await host?.stop().catch(() => undefined);
  workspace.cleanup();
  await provider.close().catch(() => undefined);
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

void main().catch(error => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
