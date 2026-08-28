import { createHash } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { join, relative, resolve } from 'path';

import {
  WEB_E2E_CRITICAL_SCENARIOS_V1,
  WEB_E2E_FULL_SCENARIOS_V1,
  WEB_E2E_SETTINGS_SCENARIOS_V1,
} from '../../src/runtime/release-receipts';

export const WEB_E2E_FULL_SCENARIOS = WEB_E2E_FULL_SCENARIOS_V1;
export const WEB_E2E_CRITICAL_SCENARIOS = WEB_E2E_CRITICAL_SCENARIOS_V1;
export const WEB_E2E_SETTINGS_SCENARIOS = WEB_E2E_SETTINGS_SCENARIOS_V1;
export const WEB_E2E_SETTINGS_TAG = '@settings' as const;

export interface WebE2ERunnerIdentityV1 {
  readonly name: string;
  readonly image: string;
  readonly digest: string;
  readonly chromeChannel: string;
}

export function expectedWebE2EScenarios(
  environment: NodeJS.ProcessEnv = process.env
): readonly string[] {
  const supplied = environment.ORION_WEB_E2E_EXPECTED_SCENARIOS;
  if (supplied) {
    const values = supplied
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);
    if (values.length === 0) throw new Error('Expected Web E2E scenario list is empty.');
    return Object.freeze([...new Set(values)]);
  }
  return environment.ORION_WEB_E2E_PROFILE === 'critical'
    ? WEB_E2E_CRITICAL_SCENARIOS
    : WEB_E2E_FULL_SCENARIOS;
}

export function webE2EScenarioIdFromTitle(title: string): string {
  const matches = title.match(/\b(?:E2E|SET)-P0-\d{2}\b/gu) ?? [];
  if (matches.length !== 1) {
    throw new Error('Every Web E2E test title must include exactly one E2E-P0-XX or SET-P0-XX ID.');
  }
  if (matches[0].startsWith('SET-P0-') && !title.includes(WEB_E2E_SETTINGS_TAG)) {
    throw new Error(
      `Settings scenario ${matches[0]} must include the ${WEB_E2E_SETTINGS_TAG} tag.`
    );
  }
  return matches[0];
}

export function webE2ERunnerIdentity(
  environment: NodeJS.ProcessEnv = process.env,
  repositoryRoot = resolve(__dirname, '../..')
): WebE2ERunnerIdentityV1 {
  const name = safeIdentity(
    environment.ORION_WEB_E2E_RUNNER_NAME ?? (environment.CI ? 'github-actions' : 'local'),
    'runner name'
  );
  const image = safeIdentity(
    environment.ORION_WEB_E2E_RUNNER_IMAGE ??
      ([environment.ImageOS, environment.ImageVersion].filter(Boolean).join('@') ||
        `${process.platform}-${process.arch}`),
    'runner image'
  );
  const chromeChannel = safeIdentity(
    environment.ORION_WEB_E2E_CHROME_CHANNEL ??
      (environment.CHROME_PATH ? 'system-google-chrome' : 'playwright-chrome'),
    'Chrome channel'
  );
  return Object.freeze({
    name,
    image,
    chromeChannel,
    digest: webE2ERunnerDigest(repositoryRoot),
  });
}

export function webE2ERunnerDigest(repositoryRoot = resolve(__dirname, '../..')): string {
  const roots = [resolve(repositoryRoot, 'scripts/e2e'), resolve(repositoryRoot, 'tests/e2e')];
  const paths = [resolve(repositoryRoot, 'playwright.config.ts')];
  for (const root of roots) collectTypeScriptFiles(root, paths);
  const excluded = new Set([
    resolve(repositoryRoot, 'scripts/e2e/assemble-web-e2e-receipt.ts'),
    resolve(repositoryRoot, 'scripts/e2e/capture-web-state-gallery.ts'),
  ]);
  const hash = createHash('sha256');
  for (const path of paths.filter(value => !excluded.has(value)).sort()) {
    const body = readFileSync(path);
    hash
      .update(relative(repositoryRoot, path).replace(/\\/gu, '/'))
      .update('\0')
      .update(String(body.length))
      .update('\0')
      .update(body);
  }
  return hash.digest('hex');
}

function collectTypeScriptFiles(root: string, paths: string[]): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) collectTypeScriptFiles(path, paths);
    else if (entry.isFile() && entry.name.endsWith('.ts')) paths.push(path);
  }
}

function safeIdentity(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || !/^[A-Za-z0-9._+@:/ -]+$/u.test(normalized)) {
    throw new Error(`Invalid Web E2E ${label}.`);
  }
  return normalized;
}
