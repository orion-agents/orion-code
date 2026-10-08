/**
 * v0.3.21 / WEB38-P0-06 — LOCAL WORKSPACE project-root discovery.
 *
 * The scripted picker (ORION_CODE_WEB_PICKER_FIXTURE) authorizes a projects
 * parent as a root; the bounded scan then proposes candidates, and clicking one
 * still routes through the existing inspect → confirm → activate card. Nothing
 * switches Context, registers a workspace, or installs a Runtime without the
 * explicit confirmation, and the discovery telemetry stays path-free.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { guardedBrowserGet, webBootstrap } from './fixtures/api';
import { expect, test } from './fixtures/test';
import { waitForWorkbenchReady, workbenchUi } from './fixtures/ui';

interface DiscoveryTraceShape {
  readonly operation: string;
  readonly outcome: string;
  readonly candidateCount: number;
  readonly durationMs: number;
  readonly partial: boolean;
  readonly errorCode?: string;
}

interface DiagnosticsShape {
  readonly workspaceDiscovery: {
    readonly retained: number;
    readonly recent: readonly DiscoveryTraceShape[];
  };
}

type PickerScript = { path?: string; outcome?: 'cancelled' | 'unavailable' };

function armPicker(workspaceRoot: string, script: PickerScript): string {
  const scriptPath = join(workspaceRoot, 'picker-script.json');
  writeFileSync(scriptPath, JSON.stringify(script));
  return scriptPath;
}

async function openWorkspaceDialog(page: Parameters<typeof workbenchUi>[0]) {
  const ui = workbenchUi(page);
  await waitForWorkbenchReady(page);
  await ui.workspaceRail.getByRole('button', { name: '选择其他工作区' }).click();
  await expect(ui.workspaceDialog).toBeVisible();
  return ui;
}

test('WEB38-P0-06 adding a project root discovers candidates and confirms without switching', async ({
  page,
  workspace,
}) => {
  // Two real projects under an authorized parent, outside the workspace root.
  const projectsRoot = mkdtempSync(join(tmpdir(), 'orion-discovery-projects-'));
  mkdirSync(join(projectsRoot, 'alpha-repo', '.git'), { recursive: true });
  mkdirSync(join(projectsRoot, 'beta-app'), { recursive: true });
  writeFileSync(join(projectsRoot, 'beta-app', 'package.json'), '{}\n');
  armPicker(workspace.rootDirectory, { path: projectsRoot });

  const bootstrapBefore = await webBootstrap(page);
  const ui = await openWorkspaceDialog(page);

  // Adding the root runs one bounded scan immediately (explicit authorization).
  await ui.workspaceDialog.getByRole('button', { name: '添加项目根目录…' }).click();

  await expect(ui.workspaceDialog.getByText('2 个候选')).toBeVisible({ timeout: 15_000 });
  await expect(
    ui.workspaceDialog.getByRole('group', { name: '发现的项目' }).getByRole('button', {
      name: /alpha-repo/,
    })
  ).toBeVisible();

  // A candidate click inspects and confirms — it never activates directly.
  await ui.workspaceDialog
    .getByRole('group', { name: '发现的项目' })
    .getByRole('button', { name: /alpha-repo/ })
    .click();
  const card = ui.workspaceDialog.getByRole('region', { name: '已选择本地项目' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('alpha-repo');
  await expect(card.getByRole('button', { name: '打开项目' })).toBeEnabled();

  // Nothing switched: Context revision and the active workspace are unchanged.
  const bootstrapAfter = await webBootstrap(page);
  expect(bootstrapAfter.contextRevision).toBe(bootstrapBefore.contextRevision);
  expect(bootstrapAfter.workspaceId).toBe(bootstrapBefore.workspaceId);

  // Discovery telemetry stays sanitized: counts and codes only.
  const diagnostics = await guardedBrowserGet<DiagnosticsShape>(page, '/api/v1/diagnostics');
  expect(diagnostics.status).toBe(200);
  const scan = diagnostics.body.workspaceDiscovery.recent.find(
    trace => trace.operation === 'discover'
  );
  expect(scan?.outcome).toBe('success');
  expect(scan?.candidateCount).toBe(2);
  const serialized = JSON.stringify(diagnostics.body.workspaceDiscovery);
  expect(serialized).not.toContain(projectsRoot);
  expect(serialized).not.toContain('alpha-repo');
  expect(serialized).not.toContain('beta-app');
});
