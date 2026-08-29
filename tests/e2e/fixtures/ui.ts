import { expect, type Locator, type Page } from '@playwright/test';

export type AgentMode = 'BUILD' | 'PLAN' | 'AUTO';
export type ApprovalDecision = 'reject' | 'once' | 'project' | 'global';
export type InspectorTab = 'Goal' | '活动' | '能力' | '诊断';
export type SettingsSection = 'General' | 'Models & Reasoning' | 'Permissions' | 'Advanced';
export type SettingsSelectLabel = '主题' | '动效' | '默认模型' | '默认推理强度';
export type SettingsPermission = 'Ask' | 'Allow' | 'Deny';

export interface UiOperationOptions {
  readonly timeout?: number;
}

export interface CreateSessionOptions extends UiOperationOptions {
  readonly name?: string;
}

export interface SubmitPromptOptions extends UiOperationOptions {
  readonly waitForEcho?: boolean;
}

/** Stable, accessibility-first locators for the Web Workbench. */
export function workbenchUi(page: Page) {
  const main = page.getByRole('main');
  const workspaceRail = page.getByRole('complementary', { name: '项目与会话' });
  const activeProject = workspaceRail.locator('.project-node.active');
  const sessionList = activeProject.getByRole('list', { name: / 的会话$/u });
  const inspectorDock = page.getByRole('complementary', { name: '工作面板' });
  const inspectorDialog = page.getByRole('dialog', { name: '工作面板' });
  const inspector = inspectorDock.or(inspectorDialog);
  const inspectorSurface = page.locator('#work-panel');
  const inspectorShortcuts = page.getByRole('navigation', { name: '工作面板快捷入口' });
  const inspectorPanel = inspector.locator('.work-panel-detail');

  return {
    main,
    workspaceRail,
    sessionList,
    inspector,
    inspectorDock,
    inspectorDialog,
    inspectorSurface,
    inspectorShortcuts,
    inspectorPanel,
    composer: main.getByRole('textbox', { name: '发送给 Orion' }),
    sendButton: main.getByRole('button', { name: '发送消息', exact: true }),
    queueButton: main.getByRole('button', { name: '加入消息队列', exact: true }),
    newSessionButton: activeProject.getByRole('button', { name: /^在 .* 新建会话$/u }),
    sessionSearch: workspaceRail.getByRole('searchbox', { name: '搜索项目和会话' }),
    navigationButton: main.getByRole('button', { name: '打开会话导航', exact: true }),
    inspectorButton: main.getByRole('button', { name: /^(打开|关闭)工作面板$/u }),
    settingsButton: main.getByRole('button', { name: '打开设置', exact: true }),
    modeSelector: main.getByRole('group', { name: 'Agent 模式' }),
    transcript: main.getByRole('list', { name: '会话记录' }),
    settingsDialog: page.getByRole('dialog', { name: '设置' }),
    renameDialog: page.getByRole('dialog', { name: '重命名会话' }),
    workspaceDialog: page.getByRole('dialog', { name: '选择工作区' }),
    toolDetailGroup: inspector.getByRole('group', { name: '工具输出详情' }),
  };
}

export type WorkbenchUi = ReturnType<typeof workbenchUi>;

/** Open the real modal and wait until its Host-backed form is hydrated. */
export async function openSettings(page: Page, options: UiOperationOptions = {}): Promise<Locator> {
  const ui = workbenchUi(page);
  await ui.settingsButton.click();
  await expect(ui.settingsDialog).toBeVisible({ timeout: options.timeout });
  await expect(ui.settingsDialog.getByRole('combobox', { name: '主题' })).toBeVisible({
    timeout: options.timeout,
  });
  return ui.settingsDialog;
}

export async function selectSettingsSection(
  page: Page,
  section: SettingsSection,
  options: UiOperationOptions = {}
): Promise<Locator> {
  const dialog = workbenchUi(page).settingsDialog;
  const target = dialog
    .getByRole('navigation', { name: '设置类别' })
    .getByRole('button', { name: section, exact: true });
  await target.click();
  await expect(target).toHaveAttribute('aria-current', 'page', { timeout: options.timeout });
  return dialog;
}

export async function setSettingsSelect(
  page: Page,
  label: SettingsSelectLabel,
  value: string,
  options: UiOperationOptions = {}
): Promise<void> {
  const select = workbenchUi(page).settingsDialog.getByRole('combobox', { name: label });
  await expect(select).toBeEnabled({ timeout: options.timeout });
  await select.selectOption(value);
  await expect(select).toHaveValue(value, { timeout: options.timeout });
}

export async function setSettingsPermission(
  page: Page,
  permission: SettingsPermission,
  options: UiOperationOptions = {}
): Promise<void> {
  const dialog = workbenchUi(page).settingsDialog;
  const radio = dialog.getByRole('radio', { name: permission, exact: true });
  await expect(radio).toBeEnabled({ timeout: options.timeout });
  await radio.click();
  if (permission === 'Allow') {
    const confirm = page.getByRole('alertdialog', { name: '确认启用 Allow' });
    await expect(confirm).toBeVisible({ timeout: options.timeout });
    await confirm.getByRole('checkbox', { name: '我理解这会扩大默认授权范围' }).check();
    await confirm.getByRole('button', { name: '启用 Allow', exact: true }).click();
  }
  await expect(radio).toBeChecked({ timeout: options.timeout });
}

export async function applySettings(
  page: Page,
  dirtyCount: number,
  options: UiOperationOptions = {}
): Promise<void> {
  const dialog = workbenchUi(page).settingsDialog;
  const apply = dialog.getByRole('button', { name: `应用 ${dirtyCount} 项`, exact: true });
  await expect(apply).toBeEnabled({ timeout: options.timeout });
  await apply.click();
  await expect(dialog.getByText('设置已安全保存并应用。', { exact: true })).toBeVisible({
    timeout: options.timeout,
  });
}

export async function discardSettingsDraft(
  page: Page,
  options: UiOperationOptions = {}
): Promise<void> {
  const ui = workbenchUi(page);
  await ui.settingsDialog.getByRole('button', { name: '关闭设置' }).click();
  const confirm = page.getByRole('alertdialog', { name: '放弃未应用的更改？' });
  await expect(confirm).toBeVisible({ timeout: options.timeout });
  await confirm.getByRole('button', { name: '放弃更改', exact: true }).click();
  await expect(ui.settingsDialog).toBeHidden({ timeout: options.timeout });
}

export async function waitForWorkbenchReady(
  page: Page,
  options: UiOperationOptions = {}
): Promise<WorkbenchUi> {
  const ui = workbenchUi(page);
  await expect(ui.main).toBeVisible({ timeout: options.timeout });
  await expect(page.getByRole('status').filter({ hasText: '正在启动 Orion Workbench' })).toBeHidden(
    { timeout: options.timeout }
  );
  await expect(page.getByText('本地 Runtime 已连接', { exact: true })).toBeVisible({
    timeout: options.timeout,
  });
  await expect(ui.settingsButton).toBeEnabled({ timeout: options.timeout });
  return ui;
}

export async function openSessionNavigation(
  page: Page,
  options: UiOperationOptions = {}
): Promise<Locator> {
  const ui = workbenchUi(page);
  if (!(await ui.workspaceRail.isVisible())) {
    await ui.navigationButton.click();
    await expect(ui.navigationButton).toHaveAttribute('aria-expanded', 'true', {
      timeout: options.timeout,
    });
  }
  await expect(ui.workspaceRail).toBeVisible({ timeout: options.timeout });
  return ui.workspaceRail;
}

export async function openInspector(
  page: Page,
  options: UiOperationOptions = {}
): Promise<Locator> {
  const ui = workbenchUi(page);
  if (!(await ui.inspectorPanel.isVisible())) {
    const overlay = await page.evaluate(() => matchMedia('(max-width: 1180px)').matches);
    await expect(ui.inspectorSurface).toHaveAttribute('data-mode', overlay ? 'overlay' : 'dock', {
      timeout: options.timeout,
    });
    if (!overlay) {
      await expect(ui.inspectorShortcuts).toBeVisible({ timeout: options.timeout });
      await ui.inspectorShortcuts.getByRole('button', { name: /^展开工作面板/u }).click();
    } else {
      await expect(ui.inspectorButton).toBeVisible({ timeout: options.timeout });
      await ui.inspectorButton.click();
      await expect(ui.inspectorButton).toHaveAttribute('aria-expanded', 'true', {
        timeout: options.timeout,
      });
    }
  }
  await expect(ui.inspector).toBeVisible({ timeout: options.timeout });
  await expect(ui.inspectorPanel).toBeVisible({ timeout: options.timeout });
  return ui.inspector;
}

export async function collapseInspector(
  page: Page,
  options: UiOperationOptions = {}
): Promise<void> {
  const inspector = await openInspector(page, options);
  await inspector.getByRole('button', { name: /^(折叠|关闭)工作面板$/u }).click();
  await expect(workbenchUi(page).inspectorPanel).toBeHidden({ timeout: options.timeout });
}

export async function openInspectorShortcut(
  page: Page,
  tab: InspectorTab,
  options: UiOperationOptions = {}
): Promise<Locator> {
  const ui = workbenchUi(page);
  await expect(ui.inspectorDock).toBeVisible({ timeout: options.timeout });
  if (!(await ui.inspectorShortcuts.isVisible())) await collapseInspector(page, options);
  const shortcut = ui.inspectorShortcuts.getByRole('button', {
    name: /^打开Agent面板/u,
  });
  await shortcut.click();
  await expect(ui.inspectorPanel).toBeVisible({ timeout: options.timeout });
  const target = ui.inspector.getByRole('tab', { name: tab, exact: true });
  await target.click();
  await expect(target).toHaveAttribute('aria-selected', 'true', { timeout: options.timeout });
  return ui.inspectorPanel;
}

export async function selectInspectorTab(
  page: Page,
  tab: InspectorTab,
  options: UiOperationOptions = {}
): Promise<Locator> {
  const inspector = await openInspector(page, options);
  const target = inspector.getByRole('tab', { name: tab, exact: true });
  await target.click();
  await expect(target).toHaveAttribute('aria-selected', 'true', { timeout: options.timeout });
  return inspector.locator('.inspector-body');
}

/** Resolve the current session from semantic list/button roles and aria-current. */
export async function activeSessionButton(
  page: Page,
  options: UiOperationOptions = {}
): Promise<Locator> {
  const row = await activeSessionRow(page, options);
  return row.locator('.project-session-main');
}

export async function setAgentMode(
  page: Page,
  mode: AgentMode,
  options: UiOperationOptions = {}
): Promise<Locator> {
  const button = workbenchUi(page).modeSelector.getByRole('button', {
    name: mode,
    exact: true,
  });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true', { timeout: options.timeout });
  return button;
}

export async function createSession(
  page: Page,
  options: CreateSessionOptions = {}
): Promise<Locator> {
  const ui = workbenchUi(page);
  const rows = ui.sessionList.locator('.project-session-row');
  let trigger = ui.newSessionButton;

  if (!(await trigger.isVisible())) {
    const emptyStateTrigger = ui.main.getByRole('button', { name: '创建会话', exact: true });
    if (await emptyStateTrigger.isVisible()) trigger = emptyStateTrigger;
    else {
      await openSessionNavigation(page, options);
      trigger = ui.newSessionButton;
    }
  }

  const previousCount = await rows.count();
  const previousActive = await currentActiveSession(page);
  const previousActiveElement = await previousActive?.button.elementHandle();
  const previousActiveText = previousActive
    ? (await previousActive.button.innerText()).replace(/\s+/gu, ' ').trim()
    : '<none>';

  await expect(trigger).toBeEnabled({ timeout: options.timeout });
  await trigger.click();
  await expect
    .poll(async () => rows.count(), { timeout: options.timeout })
    .toBeGreaterThan(previousCount);
  await expect
    .poll(
      async () => {
        const current = await currentActiveSession(page);
        if (!current) return false;
        const rename = current.row.getByRole('button', { name: /^重命名会话 / });
        if (!(await rename.isEnabled())) return false;
        const currentElement = await current.button.elementHandle();
        if (!currentElement) return false;
        if (!previousActiveElement) return true;
        const isDifferentElement = await currentElement.evaluate(
          (element, previous) => element !== previous,
          previousActiveElement
        );
        return (
          isDifferentElement &&
          (await previousActiveElement.getAttribute('aria-current')) !== 'page'
        );
      },
      {
        message: `new active session must replace ${previousActiveText}`,
        timeout: options.timeout,
      }
    )
    .toBe(true);

  let activeRow = await activeSessionRow(page, options);
  await expect(activeRow.getByRole('button', { name: /^重命名会话 / })).toBeEnabled({
    timeout: options.timeout,
  });
  let active = activeRow.locator('.project-session-main');

  if (options.name) {
    await renameActiveSession(page, options.name, options);
    activeRow = await activeSessionRow(page, options);
    active = activeRow.locator('.project-session-main');
  }
  await expect(ui.modeSelector.getByRole('button', { name: 'BUILD', exact: true })).toBeEnabled({
    timeout: options.timeout,
  });
  return active;
}

export async function renameActiveSession(
  page: Page,
  name: string,
  options: UiOperationOptions = {}
): Promise<void> {
  const nextName = name.trim();
  if (!nextName) throw new Error('Session name must not be empty.');

  const ui = workbenchUi(page);
  const activeRow = await activeSessionRow(page, options);
  let renameButton = activeRow.getByRole('button', { name: /^重命名会话 / });

  if (!(await renameButton.isVisible())) {
    await openSessionNavigation(page, options);
    renameButton = activeRow.getByRole('button', { name: /^重命名会话 / });
  }

  await activeRow.hover();
  await expect(renameButton).toBeVisible({ timeout: options.timeout });
  await expect(renameButton).toBeEnabled({ timeout: options.timeout });
  await renameButton.focus();
  await renameButton.press('Enter');
  await expect(ui.renameDialog).toBeVisible({ timeout: options.timeout });
  await ui.renameDialog.getByRole('textbox', { name: '会话名称' }).fill(nextName);
  await ui.renameDialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(ui.renameDialog).toBeHidden({ timeout: options.timeout });
  await expect(
    ui.sessionList
      .locator('.project-session-main')
      .filter({ hasText: new RegExp(`^${escapeRegex(nextName)}`, 'u') })
  ).toHaveCount(1, { timeout: options.timeout });
}

export async function submitPrompt(
  page: Page,
  prompt: string,
  options: SubmitPromptOptions = {}
): Promise<Locator> {
  const text = prompt.trim();
  if (!text) throw new Error('Prompt must not be empty.');

  const ui = workbenchUi(page);
  await expect(ui.composer).toBeEnabled({ timeout: options.timeout });
  await ui.composer.fill(text);
  await expect(ui.sendButton).toBeEnabled({ timeout: options.timeout });
  await ui.sendButton.click();
  await expect(ui.composer).toHaveValue('', { timeout: options.timeout });

  const echo = ui.main.getByRole('article', { name: '你' }).filter({ hasText: text }).last();
  if (options.waitForEcho !== false) await expect(echo).toBeVisible({ timeout: options.timeout });
  return echo;
}

export function approvalRegion(page: Page, toolName?: string): Locator {
  const name = toolName ? new RegExp(`^允许 ${escapeRegex(toolName)}？$`) : /^允许 .+？$/;
  return page.getByRole('region', { name });
}

export async function waitForApproval(
  page: Page,
  toolName?: string,
  options: UiOperationOptions = {}
): Promise<Locator> {
  const region = approvalRegion(page, toolName);
  await expect(region).toBeVisible({ timeout: options.timeout });
  return region;
}

export async function answerApproval(
  page: Page,
  decision: ApprovalDecision,
  toolName?: string,
  options: UiOperationOptions = {}
): Promise<void> {
  const region = await waitForApproval(page, toolName, options);
  const buttonName: Record<ApprovalDecision, string> = {
    reject: '拒绝',
    once: '仅本次',
    project: '允许此项目',
    global: '始终允许',
  };
  await region.getByRole('button', { name: buttonName[decision], exact: true }).click();
  await expect(region).toBeHidden({ timeout: options.timeout });
}

async function activeSessionRow(page: Page, options: UiOperationOptions = {}): Promise<Locator> {
  let active: Awaited<ReturnType<typeof currentActiveSession>>;

  await expect
    .poll(
      async () => {
        active = await currentActiveSession(page);
        return Boolean(active);
      },
      { timeout: options.timeout }
    )
    .toBe(true);

  return active!.row;
}

async function currentActiveSession(
  page: Page
): Promise<{ readonly button: Locator; readonly row: Locator } | undefined> {
  const rows = workbenchUi(page).sessionList.locator('.project-session-row');
  const count = await rows.count();
  let active: { readonly button: Locator; readonly row: Locator } | undefined;
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const button = row.locator('.project-session-main');
    if ((await button.getAttribute('aria-current')) !== 'page') continue;
    if (active) return undefined;
    active = { button, row };
  }
  return active;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
