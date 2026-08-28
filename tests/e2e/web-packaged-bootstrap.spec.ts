import { allowExpectedNetworkFailures, test, expect } from './fixtures/test';
import { relative, resolve } from 'path';
import {
  activeSessionButton,
  createSession,
  renameActiveSession,
  workbenchUi,
} from './fixtures/ui';

test('E2E-P0-01 packaged Host renders v0.3.0 and persists a renamed session', async ({
  artifactState,
  evidence,
  host,
  page,
}, testInfo) => {
  // Session activation deliberately replaces the EventSource; Chrome reports the old stream aborted.
  allowExpectedNetworkFailures(testInfo, 1);
  expect(artifactState.artifact.receipt.package).toMatchObject({
    name: '@orion-agents/orion-code',
    version: '0.3.0',
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
  expect(health).toEqual({ status: 200, body: { ok: true, version: '0.3.0' } });

  const bootstrap = await page.evaluate(async () => {
    const response = await fetch('/api/v1/bootstrap', { cache: 'no-store' });
    return response.json();
  });
  expect(bootstrap).toMatchObject({ apiVersion: 1, productVersion: '0.3.0', configured: true });
  expect(bootstrap.nonce).toEqual(expect.any(String));
  expect(JSON.stringify(bootstrap)).not.toContain('orion-web-e2e-test-only');

  await expect(workbenchUi(page).workspaceRail.getByText('v0.3.0', { exact: true })).toBeVisible();
  await createSession(page);
  await renameActiveSession(page, 'Packaged Browser Session');
  await expect(await activeSessionButton(page)).toContainText('Packaged Browser Session');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('本地 Runtime 已连接', { exact: true })).toBeVisible();
  await expect(await activeSessionButton(page)).toContainText('Packaged Browser Session');
  await expect(workbenchUi(page).composer).toBeEnabled();
  evidence.recordFact(
    'product.version',
    String((bootstrap as { productVersion: string }).productVersion)
  );
  evidence.recordFact('session.rename_persisted', true);
});
