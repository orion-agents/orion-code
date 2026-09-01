import { allowExpectedNetworkFailures, test, expect } from './fixtures/test';
import { relative, resolve } from 'path';
import {
  activeSessionButton,
  createSession,
  renameActiveSession,
  workbenchUi,
} from './fixtures/ui';

test('E2E-P0-01 packaged Host renders v0.3.2 and persists a renamed session', async ({
  artifactState,
  evidence,
  host,
  page,
}, testInfo) => {
  // Session activation deliberately replaces the EventSource; Chrome reports the old stream aborted.
  allowExpectedNetworkFailures(testInfo, 3);
  expect(artifactState.artifact.receipt.package).toMatchObject({
    name: '@orion-agents/orion-code',
    version: '0.3.2',
  });
  expect(host.host).toBe('127.0.0.1');
  const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  expect(host.environmentKeys).toContain(homeKey);
  expect(resolve(host.homeDirectory)).not.toBe(
    resolve(process.env[homeKey] ?? host.launcherDirectory)
  );
  expect(relative(artifactState.rawRoot, host.homeDirectory)).not.toMatch(/^\.\./u);
  evidence.recordFact('artifact.sha256', artifactState.artifact.receipt.tarball.sha256);
  evidence.recordFact('host.loopback', host.host === '127.0.0.1');
  evidence.recordFact('host.home_isolated', true);
  evidence.recordFact('host.home_inherited', false);

  const health = await page.evaluate(async () => {
    const response = await fetch('/api/v1/health', { cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  });
  expect(health).toEqual({ status: 200, body: { ok: true, version: '0.3.2' } });

  const bootstrap = await page.evaluate(async () => {
    const response = await fetch('/api/v1/bootstrap', { cache: 'no-store' });
    return response.json();
  });
  expect(bootstrap).toMatchObject({ apiVersion: 1, productVersion: '0.3.2', configured: true });
  expect(bootstrap.nonce).toEqual(expect.any(String));
  expect(JSON.stringify(bootstrap)).not.toContain('orion-web-e2e-test-only');

  await expect(workbenchUi(page).workspaceRail.getByText('v0.3.2', { exact: true })).toBeVisible();
  await createSession(page);
  await renameActiveSession(page, 'Packaged Browser Session');
  await expect(await activeSessionButton(page)).toContainText('Packaged Browser Session');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('本地 Runtime 已连接', { exact: true })).toBeVisible();
  await expect(await activeSessionButton(page)).toContainText('Packaged Browser Session');
  await expect(workbenchUi(page).composer).toBeEnabled();

  await workbenchUi(page).composer.fill('unsent draft stays with its Session');
  await createSession(page, { name: 'Draft Isolation Session' });
  await expect(workbenchUi(page).composer).toHaveValue('');
  const originalSession = workbenchUi(page).sessionList.getByRole('button', {
    name: /^Packaged Browser Session/u,
  });
  await originalSession.click();
  await expect(originalSession).toHaveAttribute('aria-current', 'page');
  await expect(workbenchUi(page).composer).toHaveValue('unsent draft stays with its Session');
  await workbenchUi(page).composer.fill('');

  await page.setViewportSize({ width: 1440, height: 520 });
  const layout = await page.evaluate(() => {
    const bounds = (selector: string) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) throw new Error(`${selector} was not rendered.`);
      const rect = element.getBoundingClientRect();
      return Object.freeze({ top: rect.top, bottom: rect.bottom, height: rect.height });
    };
    return Object.freeze({
      main: bounds('.conversation-column'),
      transcript: bounds('.transcript-viewport'),
      dock: bounds('.input-dock'),
      composer: bounds('.composer'),
    });
  });
  expect(layout.transcript.bottom).toBeLessThanOrEqual(layout.dock.top + 1);
  expect(layout.dock.bottom).toBeLessThanOrEqual(layout.main.bottom + 1);
  expect(layout.composer.bottom).toBeLessThanOrEqual(layout.main.bottom + 1);
  expect(layout.dock.height).toBeGreaterThanOrEqual(layout.composer.height);
  evidence.recordFact('layout.composer_docked', true);
  evidence.recordFact('composer.session_draft_isolated', true);
  evidence.recordFact(
    'product.version',
    String((bootstrap as { productVersion: string }).productVersion)
  );
  evidence.recordFact('session.rename_persisted', true);
});
