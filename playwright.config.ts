import { mkdirSync } from 'fs';
import { join, resolve } from 'path';

import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';

// Playwright forces color in worker output; inheriting NO_COLOR makes Node emit a noisy warning.
delete process.env.NO_COLOR;

const runRoot = resolve(
  process.env.ORION_WEB_E2E_RUN_ROOT ??
    join('tests', 'tmp', 'web-e2e', `${runTimestamp()}-${process.pid}`)
);

mkdirSync(runRoot, { recursive: true });
process.env.ORION_WEB_E2E_RUN_ROOT = runRoot;

const chromeUse: PlaywrightTestConfig['use'] = process.env.CHROME_PATH
  ? { launchOptions: { executablePath: process.env.CHROME_PATH } }
  : { channel: 'chrome' };

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: join(runRoot, 'test-results'),
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  preserveOutput: 'failures-only',
  reporter: [
    ['list'],
    ['junit', { outputFile: join(runRoot, 'junit', 'results.xml') }],
    ['html', { outputFolder: join(runRoot, 'html-report'), open: 'never' }],
  ],
  use: {
    browserName: 'chromium',
    ...chromeUse,
    bypassCSP: false,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chrome' }],
  metadata: {
    runRoot,
  },
});

function runTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
