import { writeFileSync, symlinkSync, unlinkSync } from 'fs';
import { request as httpRequest } from 'http';
import { join } from 'path';

import type { Browser } from '@playwright/test';

import {
  collapseInspector,
  createSession,
  openInspector,
  waitForWorkbenchReady,
  workbenchUi,
} from './fixtures/ui';
import { allowExpectedNetworkFailures, expect, installSseCapture, test } from './fixtures/test';

interface AxeViolation {
  readonly id: string;
  readonly impact: string | null;
  readonly help: string;
}

test('E2E-P0-08 Host attacks fail closed while real-CSP UI remains keyboard and axe clean', async ({
  artifactState,
  browser,
  context,
  evidence,
  host,
  page,
}, testInfo) => {
  allowExpectedNetworkFailures(testInfo, 6);
  await createSession(page);
  const nonce = await page.evaluate(
    async () =>
      (
        (await (await fetch('/api/v1/bootstrap', { cache: 'no-store' })).json()) as {
          nonce: string;
        }
      ).nonce
  );

  const documentResponse = await fetch(`${host.url}/`);
  expect(documentResponse.status).toBe(200);
  const csp = documentResponse.headers.get('content-security-policy') ?? '';
  const cspDirectives = parseCspDirectives(csp);
  expect(cspDirectives.get('script-src')).toEqual(["'self'"]);
  expect(cspDirectives.get('style-src-elem')).toEqual(["'self'", `'nonce-${nonce}'`]);
  expect(cspDirectives.get('style-src-attr')).toEqual(["'unsafe-inline'"]);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(cspDirectives.get('script-src')).not.toContain("'unsafe-inline'");
  expect(cspDirectives.get('style-src-elem')).not.toContain("'unsafe-inline'");
  expect(documentResponse.headers.get('x-frame-options')).toBe('DENY');
  expect(documentResponse.headers.get('cross-origin-resource-policy')).toBe('same-origin');
  evidence.recordFact('csp.script_self', csp.includes("script-src 'self'"));
  evidence.recordFact('csp.frame_ancestors_none', csp.includes("frame-ancestors 'none'"));
  evidence.recordFact(
    'csp.unsafe_inline',
    cspDirectives.get('script-src')?.includes("'unsafe-inline'") ?? false
  );

  expect(
    (await rawRequest(host.url, { path: '/api/v1/health', host: 'evil.invalid' })).status
  ).toBe(421);
  expect(
    (
      await rawRequest(host.url, {
        method: 'POST',
        path: '/api/v1/sessions',
        nonce,
        body: JSON.stringify({ requestId: 'missing-origin' }),
      })
    ).status
  ).toBe(403);
  expect(
    (
      await rawRequest(host.url, {
        method: 'POST',
        path: '/api/v1/sessions',
        origin: 'http://evil.invalid',
        nonce,
        body: JSON.stringify({ requestId: 'wrong-origin' }),
      })
    ).status
  ).toBe(403);
  expect(
    (
      await rawRequest(host.url, {
        method: 'POST',
        path: '/api/v1/sessions',
        origin: host.url,
        body: JSON.stringify({ requestId: 'missing-nonce' }),
      })
    ).status
  ).toBe(403);
  expect(
    (
      await rawRequest(host.url, {
        method: 'POST',
        path: '/api/v1/sessions',
        origin: host.url,
        nonce: 'wrong-nonce',
        body: JSON.stringify({ requestId: 'wrong-nonce' }),
      })
    ).status
  ).toBe(403);
  expect(
    (
      await rawRequest(host.url, {
        method: 'POST',
        path: '/api/v1/sessions',
        origin: host.url,
        nonce,
        contentType: 'text/plain',
        body: JSON.stringify({ requestId: 'wrong-content-type' }),
      })
    ).status
  ).toBe(415);
  const oversizedBody = JSON.stringify({ value: 'x'.repeat(1024 * 1024) });
  const oversized = await rawRequest(host.url, {
    method: 'POST',
    path: '/api/v1/sessions',
    origin: host.url,
    nonce,
    body: oversizedBody,
  });
  expect(oversized.status).toBe(413);
  evidence.recordFact('security.oversized_status', oversized.status);
  expect((await rawRequest(host.url, { path: '/%2e%2e%2fpackage.json' })).status).toBe(403);
  evidence.recordFact('security.mutation_negatives_passed', true);

  const staticRoot = join(artifactState.installation.packageRoot, 'dist', 'web-client');
  const sentinel = join(artifactState.rawRoot, 'security-sentinel.txt');
  const link = join(staticRoot, 'e2e-symlink-escape.txt');
  writeFileSync(sentinel, 'STATIC_ESCAPE_MUST_NOT_LEAK\n', { mode: 0o600 });
  symlinkSync(sentinel, link, 'file');
  try {
    const escaped = await rawRequest(host.url, { path: '/e2e-symlink-escape.txt' });
    expect(escaped.status).toBe(403);
    expect(escaped.body).not.toContain('STATIC_ESCAPE_MUST_NOT_LEAK');
    evidence.recordFact('security.symlink_status', escaped.status);
    evidence.recordFact('security.symlink_leaked', false);
  } finally {
    unlinkSync(link);
    unlinkSync(sentinel);
  }

  const sessionsBeforeHostile = await hostGetSessionCount(host.url);
  const hostile = await context.newPage();
  try {
    await hostile.goto('data:text/html,<title>hostile-origin</title>');
    const result = await hostile.evaluate(async target => {
      try {
        await fetch(`${target}/api/v1/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-orion-web-nonce': 'wrong' },
          body: JSON.stringify({ requestId: 'hostile-browser' }),
        });
        return 'unexpected-success';
      } catch (error) {
        return error instanceof Error ? error.name : String(error);
      }
    }, host.url);
    expect(result).toBe('TypeError');
    evidence.recordFact('security.hostile_origin_result', result);
  } finally {
    await hostile.close();
  }
  expect(await hostGetSessionCount(host.url)).toBe(sessionsBeforeHostile);

  await page.setViewportSize({ width: 1600, height: 900 });
  const ui = workbenchUi(page);
  const workspaceRailState = page.getByRole('complementary', {
    name: '项目与会话',
    includeHidden: true,
  });
  await expect(ui.inspectorDock).toBeVisible();
  await expect(ui.inspectorDock).toHaveAttribute('data-mode', 'dock');
  await expect(ui.inspectorPanel).toBeVisible();
  expect(await ui.main.evaluate(element => (element as HTMLElement).inert)).toBe(false);
  const resizeHandle = page.locator('.work-panel-resize-handle');
  await expect(resizeHandle).toBeVisible();
  await expect(resizeHandle).not.toHaveAttribute('role', 'separator');
  expect(await resizeHandle.getAttribute('tabindex')).toBeNull();
  const dragToWidth = async (width: number) => {
    const box = await resizeHandle.boundingBox();
    if (!box) throw new Error('Work Panel resize handle has no pointer bounds.');
    const viewportWidth = page.viewportSize()?.width;
    if (!viewportWidth) throw new Error('Work Panel resize test requires a fixed viewport.');
    await page.mouse.move(box.x + box.width / 2, box.y + Math.min(120, box.height / 2));
    await page.mouse.down();
    await page.mouse.move(viewportWidth - width, box.y + Math.min(120, box.height / 2), {
      steps: 8,
    });
    await page.mouse.up();
    await expect
      .poll(async () =>
        Math.round(
          await ui.inspectorDock.evaluate(element => element.getBoundingClientRect().width)
        )
      )
      .toBe(width);
  };
  await dragToWidth(320);
  await dragToWidth(720);
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('orion.web.work-panel.v1') ?? '{}').widthPx
    )
  ).toBe(720);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  await expect
    .poll(async () =>
      Math.round(await ui.inspectorDock.evaluate(element => element.getBoundingClientRect().width))
    )
    .toBe(720);
  evidence.recordFact('layout.pointer_resize_min', 320);
  evidence.recordFact('layout.pointer_resize_max', 720);
  evidence.recordFact('layout.keyboard_resize_surface_count', 0);
  evidence.recordFact('layout.pointer_resize_persisted', true);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect
    .poll(async () =>
      Math.round(await ui.inspectorDock.evaluate(element => element.getBoundingClientRect().width))
    )
    .toBe(600);
  expect(
    Math.round(await ui.main.evaluate(element => element.getBoundingClientRect().width))
  ).toBeGreaterThanOrEqual(560);
  const expandedMainWidth = await ui.main.evaluate(
    element => element.getBoundingClientRect().width
  );
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('orion.web.work-panel.v1') ?? '{}').widthPx
    )
  ).toBe(720);
  evidence.recordFact('layout.pointer_resize_1440_clamped', 600);
  evidence.recordFact('layout.conversation_min_preserved', true);

  const collapseButton = ui.inspectorDock.getByRole('button', {
    name: '折叠工作面板',
    exact: true,
  });
  await collapseButton.focus();
  await collapseButton.press('Enter');
  await expect(ui.inspectorPanel).toBeHidden();
  await expect(ui.inspectorShortcuts).toBeVisible();
  const goalShortcut = ui.inspectorShortcuts.getByRole('button', { name: /^打开Agent面板/u });
  await expect(goalShortcut).toBeFocused();
  await expect
    .poll(async () =>
      Math.round(await ui.inspectorDock.evaluate(element => element.getBoundingClientRect().width))
    )
    .toBe(48);
  const railWidth = await ui.inspectorDock.evaluate(
    element => element.getBoundingClientRect().width
  );
  const collapsedMainWidth = await ui.main.evaluate(
    element => element.getBoundingClientRect().width
  );
  expect(railWidth).toBeGreaterThanOrEqual(44);
  expect(railWidth).toBeLessThanOrEqual(48);
  expect(collapsedMainWidth).toBeGreaterThan(expandedMainWidth + 250);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
  await expect(page.getByRole('button', { name: '关闭侧边面板' })).toHaveCount(0);

  await goalShortcut.focus();
  await goalShortcut.press('Enter');
  const activityTab = ui.inspectorDock.getByRole('tab', { name: '活动', exact: true });
  await activityTab.click();
  await expect(activityTab).toHaveAttribute('aria-selected', 'true');
  await expect(activityTab).toBeFocused();
  await collapseInspector(page);
  await expect(goalShortcut).toBeFocused();
  await expect(goalShortcut).toHaveAttribute('aria-current', 'page');
  expect(await ui.main.evaluate(element => (element as HTMLElement).inert)).toBe(false);

  evidence.recordFact('a11y.inspector_dock_width', railWidth);
  evidence.recordFact('a11y.inspector_dock_preserves_tab', true);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(ui.inspectorShortcuts).toBeHidden();
  await ui.navigationButton.focus();
  await ui.navigationButton.press('Enter');
  await expect(ui.navigationButton).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(ui.navigationButton).toHaveAttribute('aria-expanded', 'false');
  await expect(ui.navigationButton).toBeFocused();

  await ui.inspectorButton.focus();
  await ui.inspectorButton.press('Enter');
  await expect(ui.inspectorButton).toHaveAttribute('aria-expanded', 'true');
  await expect(ui.inspectorDialog).toBeVisible();
  await expect(ui.inspectorDialog).toHaveAttribute('aria-modal', 'true');
  await expect(
    ui.inspectorDialog.getByRole('button', { name: '关闭工作面板', exact: true })
  ).toBeFocused();
  await expect(ui.inspectorDialog.getByRole('tab', { name: '活动', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  expect(await ui.main.evaluate(element => (element as HTMLElement).inert)).toBe(true);
  expect(await workspaceRailState.evaluate(element => (element as HTMLElement).inert)).toBe(true);
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press('Tab');
    expect(
      await ui.inspectorDialog.evaluate(element =>
        element.contains(element.ownerDocument.activeElement)
      )
    ).toBe(true);
  }
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press('Shift+Tab');
    expect(
      await ui.inspectorDialog.evaluate(element =>
        element.contains(element.ownerDocument.activeElement)
      )
    ).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(ui.inspectorButton).toHaveAttribute('aria-expanded', 'false');
  await expect(ui.inspectorButton).toBeFocused();
  expect(await ui.main.evaluate(element => (element as HTMLElement).inert)).toBe(false);
  expect(await workspaceRailState.evaluate(element => (element as HTMLElement).inert)).toBe(false);

  await openInspector(page);
  const scrim = page.getByRole('button', { name: '关闭侧边面板' });
  await expect(scrim).toBeVisible();
  await scrim.click({ position: { x: 20, y: 420 } });
  await expect(ui.inspectorDialog).toBeHidden();
  await expect(ui.inspectorButton).toBeFocused();

  await ui.settingsButton.focus();
  await ui.settingsButton.press('Enter');
  await expect(ui.settingsDialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(ui.settingsDialog).toBeHidden();
  await expect(ui.settingsButton).toBeFocused();

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(ui.inspectorDock).toBeVisible();
  await expect(ui.inspectorShortcuts).toBeVisible();
  await expect(goalShortcut).toHaveAttribute('aria-current', 'page');
  evidence.recordFact('a11y.mobile_keyboard_focus', true);
  evidence.recordFact('a11y.inspector_overlay_focus_trap', true);

  const blocking = await runAxeAudit(browser, host.url, evidence);
  expect(blocking).toEqual([]);
  evidence.recordFact('a11y.blocking_violations', blocking.length);
});

async function runAxeAudit(
  browser: Browser,
  url: string,
  evidence: import('./fixtures/evidence').WebE2EEvidenceCollector
): Promise<readonly AxeViolation[]> {
  const auditContext = await browser.newContext({
    bypassCSP: true,
    viewport: { width: 1440, height: 900 },
  });
  const auditPage = await auditContext.newPage();
  await installSseCapture(auditPage);
  const detach = evidence.attachPage(auditPage);
  try {
    await auditPage.goto(url, { waitUntil: 'domcontentloaded' });
    await waitForWorkbenchReady(auditPage, { timeout: 30_000 });
    await auditPage.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
    const blocking: AxeViolation[] = [];
    const scan = async (state: string) => {
      const violations = await scanAxe(auditPage);
      const current = violations.filter(
        violation => violation.impact === 'critical' || violation.impact === 'serious'
      );
      evidence.recordFact(`a11y.axe_${state}_blocking`, current.length);
      blocking.push(...current);
    };

    await scan('desktop_expanded');
    await collapseInspector(auditPage);
    await scan('desktop_collapsed');
    await auditPage.setViewportSize({ width: 390, height: 844 });
    await openInspector(auditPage);
    await scan('mobile_overlay');
    return blocking;
  } finally {
    detach();
    await auditContext.close();
  }
}

async function scanAxe(page: import('@playwright/test').Page): Promise<AxeViolation[]> {
  return page.evaluate(async () => {
    const axe = (
      window as typeof window & {
        axe: {
          run(
            root: Document,
            options: Record<string, unknown>
          ): Promise<{ violations: AxeViolation[] }>;
        };
      }
    ).axe;
    return (
      await axe.run(document, {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'],
        },
      })
    ).violations;
  });
}

function parseCspDirectives(value: string): ReadonlyMap<string, readonly string[]> {
  const directives = new Map<string, readonly string[]>();
  for (const rawDirective of value.split(';')) {
    const tokens = rawDirective.trim().split(/\s+/u).filter(Boolean);
    const name = tokens.shift();
    if (name) directives.set(name, tokens);
  }
  return directives;
}

interface RawRequestOptions {
  readonly method?: 'GET' | 'POST';
  readonly path: string;
  readonly host?: string;
  readonly origin?: string;
  readonly nonce?: string;
  readonly contentType?: string;
  readonly body?: string;
}

async function rawRequest(
  hostUrl: string,
  options: RawRequestOptions
): Promise<{ readonly status: number; readonly body: string }> {
  const target = new URL(hostUrl);
  const body = options.body ?? '';
  const headers: Record<string, string | number> = {
    Host: options.host ?? target.host,
    Accept: 'application/json',
  };
  if (options.origin) headers.Origin = options.origin;
  if (options.nonce) headers['x-orion-web-nonce'] = options.nonce;
  if (options.method === 'POST') {
    headers['Content-Type'] = options.contentType ?? 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body, 'utf8');
  }
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: Number(target.port),
        method: options.method ?? 'GET',
        path: options.path,
        headers,
      },
      response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.once('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    request.once('error', reject);
    request.setTimeout(10_000, () => request.destroy(new Error('Raw Host probe timed out.')));
    if (body) request.write(body);
    request.end();
  });
}

async function hostGetSessionCount(hostUrl: string): Promise<number> {
  const bootstrap = (await fetch(`${hostUrl}/api/v1/bootstrap`, {
    headers: { Accept: 'application/json' },
  }).then(response => response.json())) as {
    readonly contextRevision: string;
    readonly workspaceId: string;
  };
  const query = new URLSearchParams({
    pageSize: '100',
    expectedContextRevision: bootstrap.contextRevision,
    workspaceId: bootstrap.workspaceId,
  });
  const response = await fetch(`${hostUrl}/api/v1/sessions?${query.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Session count failed with HTTP ${response.status}.`);
  const value = (await response.json()) as { readonly items: readonly unknown[] };
  return value.items.length;
}
