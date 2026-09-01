#!/usr/bin/env ts-node

import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

import { WEB_E2E_CRITICAL_SCENARIOS_V1 } from '../../src/runtime/release-receipts';
import { WEB_E2E_CRITICAL_GREP } from '../../tests/e2e/scenarios';

async function main(): Promise<void> {
  const repositoryRoot = resolve(__dirname, '../..');
  assertArguments(process.argv.slice(2));
  const runRoot = resolve(
    repositoryRoot,
    process.env.ORION_WEB_E2E_RUN_ROOT ??
      join(
        'tests',
        'tmp',
        'web-e2e',
        `critical-${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}`
      )
  );
  const exitCode = await runPlaywright(repositoryRoot, runRoot);
  const manifestPath = join(runRoot, 'manifest.json');
  const manifest = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        readonly decision?: string;
        readonly scenarios?: readonly { readonly scenarioId?: string }[];
      })
    : undefined;
  const scenarioIds = (manifest?.scenarios ?? [])
    .map(scenario => String(scenario.scenarioId ?? ''))
    .sort();
  const exactCoverage = sameOrderedValues(scenarioIds, WEB_E2E_CRITICAL_SCENARIOS_V1);
  const go = exitCode === 0 && manifest?.decision === 'GO' && exactCoverage;
  process.stdout.write(
    `[web-e2e-critical] decision=${manifest?.decision ?? 'MISSING'} ` +
      `exactCoverage=${exactCoverage} evidence=${runRoot}\n`
  );
  if (!go) process.exitCode = 1;
}

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && right.every((value, index) => left[index] === value);
}

function assertArguments(args: readonly string[]): void {
  if (args.length !== 0) {
    throw new Error('Critical Web E2E runner owns its scenario grep and accepts no arguments.');
  }
}

async function runPlaywright(repositoryRoot: string, runRoot: string): Promise<number> {
  const cli = join(repositoryRoot, 'node_modules', '@playwright', 'test', 'cli.js');
  const environment: NodeJS.ProcessEnv = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL ?? '',
    CI: process.env.CI ?? '',
    ORION_WEB_E2E_RUN_ROOT: runRoot,
    ORION_WEB_E2E_PROFILE: 'critical',
    ORION_WEB_E2E_RUNNER_NAME:
      process.env.ORION_WEB_E2E_RUNNER_NAME ?? (process.env.CI ? 'github-actions' : 'local'),
    ORION_WEB_E2E_RUNNER_IMAGE:
      process.env.ORION_WEB_E2E_RUNNER_IMAGE ??
      ([process.env.ImageOS, process.env.ImageVersion].filter(Boolean).join('@') ||
        `${process.platform}-${process.arch}`),
    ORION_WEB_E2E_CHROME_CHANNEL:
      process.env.ORION_WEB_E2E_CHROME_CHANNEL ??
      (process.env.CHROME_PATH ? 'system-google-chrome' : 'playwright-chrome'),
    ...(process.env.CHROME_PATH ? { CHROME_PATH: process.env.CHROME_PATH } : {}),
    ...(process.env.ORION_WEB_E2E_TARBALL
      ? { ORION_WEB_E2E_TARBALL: process.env.ORION_WEB_E2E_TARBALL }
      : {}),
    ...(process.env.ORION_WEB_E2E_RECEIPT
      ? { ORION_WEB_E2E_RECEIPT: process.env.ORION_WEB_E2E_RECEIPT }
      : {}),
  };
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cli, 'test', '--grep', WEB_E2E_CRITICAL_GREP], {
      cwd: repositoryRoot,
      env: environment,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Critical Web E2E child exited by ${signal}.`));
        return;
      }
      resolveRun(code ?? 1);
    });
  });
}

void main().catch(error => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
