#!/usr/bin/env ts-node

import assert from 'assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { chromium, type Browser } from 'playwright-core';

import type { OrionWebServerHandle } from '../../src/web/server';

interface AxeViolation {
  readonly id: string;
  readonly impact: string | null;
  readonly help: string;
  readonly nodes: readonly unknown[];
}

async function main(): Promise<void> {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'orion-web-browser-'));
  const previousConfigRoot = process.env.ORION_CODE_CONFIG_DIR;
  process.env.ORION_CODE_CONFIG_DIR = join(temporaryRoot, 'config');
  let handle: OrionWebServerHandle | undefined;
  let browser: Browser | undefined;

  try {
    const { startOrionWebServer } = await import('../../src/web/server');
    handle = await startOrionWebServer({ cwd: temporaryRoot, port: 0 });
    browser = await chromium.launch({
      executablePath: resolveChromeExecutable(),
      headless: true,
      args: ['--disable-background-networking', '--no-first-run', '--no-default-browser-check'],
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      bypassCSP: true,
    });
    await page.goto(handle.url, { waitUntil: 'networkidle' });

    await page.getByRole('heading', { name: '选择或创建一个会话' }).waitFor();
    await page.getByText('本地 Runtime 已连接').waitFor();
    await page.getByRole('button', { name: '创建会话', exact: true }).first().click();
    await page.getByText('模型尚未配置').waitFor();
    await page.locator('.session-row.active').waitFor();

    const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
    await page.addScriptTag({ content: axeSource });
    const violations = await page.evaluate(async () => {
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
      const results = await axe.run(document, {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'],
        },
      });
      return results.violations;
    });
    const blocking = violations.filter(
      violation => violation.impact === 'critical' || violation.impact === 'serious'
    );
    assert.deepStrictEqual(
      blocking,
      [],
      `Blocking axe violations: ${blocking.map(item => `${item.id}:${item.help}`).join(', ')}`
    );

    await page.setViewportSize({ width: 390, height: 844 });
    const navigation = page.getByRole('button', { name: '打开会话导航' });
    await navigation.click();
    await assertEventually(async () => (await navigation.getAttribute('aria-expanded')) === 'true');
    await page.locator('#workspace-rail.drawer-open').waitFor();
    await page.keyboard.press('Escape');
    await assertEventually(
      async () => (await navigation.getAttribute('aria-expanded')) === 'false'
    );

    process.stdout.write(
      `${JSON.stringify({
        host: handle.host,
        health: 'pass',
        sessionMutation: 'pass',
        responsiveDrawer: 'pass',
        axeBlockingViolations: blocking.length,
        axeNonBlockingViolations: violations.length,
      })}\n`
    );
  } finally {
    await browser?.close();
    await handle?.close();
    if (previousConfigRoot === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
    else process.env.ORION_CODE_CONFIG_DIR = previousConfigRoot;
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function resolveChromeExecutable(): string {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter((value): value is string => Boolean(value));
  const executable = candidates.find(candidate => existsSync(candidate));
  if (!executable) {
    throw new Error('Chrome/Chromium is required for the Web Workbench browser release gate.');
  }
  return executable;
}

async function assertEventually(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Responsive drawer did not close after Escape.');
}

void main().catch(error => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
