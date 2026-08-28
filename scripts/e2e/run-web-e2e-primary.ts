#!/usr/bin/env ts-node

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

import { digestRuntimeValue } from '../../src/runtime/protocol/canonical';
import { WEB_E2E_FULL_SCENARIOS_V1 } from '../../src/runtime/release-receipts';

interface CliOptions {
  readonly tarball: string;
  readonly receipt: string;
  readonly chrome: string;
}

interface PrimaryEntry {
  readonly ordinal: number;
  readonly runRoot: string;
  readonly exitCode: number;
  readonly decision: string;
  readonly runId?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly tarballSha256?: string;
  readonly manifestDigest?: string;
  readonly exactCoverage: boolean;
}

async function main(): Promise<void> {
  const repositoryRoot = resolve(__dirname, '..', '..');
  const options = parseArguments(process.argv.slice(2), repositoryRoot);
  const receipt = readJson(options.receipt) as {
    package?: { name?: string; version?: string };
    tarball?: { sha256?: string };
  };
  const expectedSha = receipt.tarball?.sha256;
  if (!/^[a-f0-9]{64}$/u.test(expectedSha ?? '')) {
    throw new Error('Artifact receipt is missing a valid tarball SHA-256.');
  }
  if (sha256File(options.tarball) !== expectedSha) {
    throw new Error('Tarball SHA-256 differs from its receipt.');
  }
  if (receipt.package?.name !== '@orion-agents/orion-code' || receipt.package.version !== '0.3.0') {
    throw new Error('Primary runner requires @orion-agents/orion-code@0.3.0.');
  }

  const primaryRoot = join(
    repositoryRoot,
    'tests',
    'tmp',
    'web-e2e',
    `primary-${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}`
  );
  mkdirSync(primaryRoot, { recursive: true, mode: 0o700 });
  const entries: PrimaryEntry[] = [];
  for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
    const runRoot = join(primaryRoot, `run-${ordinal}`);
    const exitCode = await runPlaywright({ repositoryRoot, runRoot, ...options });
    const manifestPath = join(runRoot, 'manifest.json');
    const manifest = existsSync(manifestPath)
      ? (readJson(manifestPath) as {
          runId?: string;
          createdAt?: string;
          updatedAt?: string;
          decision?: string;
          artifact?: { tarballSha256?: string };
          scenarios?: readonly { scenarioId?: string }[];
        })
      : undefined;
    entries.push({
      ordinal,
      runRoot,
      exitCode,
      decision: manifest?.decision ?? 'MISSING',
      exactCoverage: sameOrderedValues(
        (manifest?.scenarios ?? []).map(scenario => String(scenario.scenarioId ?? '')).sort(),
        WEB_E2E_FULL_SCENARIOS_V1
      ),
      ...(manifest?.runId ? { runId: manifest.runId } : {}),
      ...(manifest?.createdAt ? { startedAt: manifest.createdAt } : {}),
      ...(manifest?.updatedAt ? { completedAt: manifest.updatedAt } : {}),
      ...(manifest?.artifact?.tarballSha256
        ? { tarballSha256: manifest.artifact.tarballSha256 }
        : {}),
      ...(manifest ? { manifestDigest: digestRuntimeValue(manifest) } : {}),
    });
  }
  const uniqueRunIds = new Set(entries.map(entry => entry.runId).filter(Boolean)).size;
  const uniqueManifestDigests = new Set(entries.map(entry => entry.manifestDigest).filter(Boolean))
    .size;
  const consecutive = entries.every((entry, index) => {
    if (index === 0) return true;
    const previous = entries[index - 1];
    return (
      Boolean(entry.startedAt && previous.completedAt) &&
      Date.parse(entry.startedAt!) >= Date.parse(previous.completedAt!)
    );
  });
  const go =
    entries.every(
      entry =>
        entry.exitCode === 0 &&
        entry.decision === 'GO' &&
        entry.tarballSha256 === expectedSha &&
        entry.exactCoverage
    ) &&
    uniqueRunIds === 3 &&
    uniqueManifestDigests === 3 &&
    consecutive;
  const summary = {
    version: 1,
    kind: 'orion.web-e2e-primary-runs',
    createdAt: new Date().toISOString(),
    package: receipt.package,
    tarballSha256: expectedSha,
    entries: entries.map(entry => ({
      ...entry,
      runRoot: `run-${entry.ordinal}`,
    })),
    freshness: { uniqueRunIds, uniqueManifestDigests, consecutive },
    decision: go ? 'GO' : 'NO_GO',
  };
  writeFileSync(join(primaryRoot, 'primary.json'), `${JSON.stringify(summary, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(
    `[web-e2e-primary] decision=${summary.decision} sha256=${expectedSha} evidence=${primaryRoot}\n`
  );
  if (!go) process.exitCode = 1;
}

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && right.every((value, index) => left[index] === value);
}

function parseArguments(args: readonly string[], repositoryRoot: string): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error(`Invalid primary argument: ${key ?? ''}`);
    values.set(key.slice(2), value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`Missing required --${name} argument.`);
    const path = resolve(repositoryRoot, value);
    if (!existsSync(path)) throw new Error(`--${name} path does not exist.`);
    return path;
  };
  return {
    tarball: required('tarball'),
    receipt: required('receipt'),
    chrome: required('chrome'),
  };
}

async function runPlaywright(options: {
  readonly repositoryRoot: string;
  readonly runRoot: string;
  readonly tarball: string;
  readonly receipt: string;
  readonly chrome: string;
}): Promise<number> {
  const cli = join(options.repositoryRoot, 'node_modules', '@playwright', 'test', 'cli.js');
  const environment: NodeJS.ProcessEnv = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL ?? '',
    CI: process.env.CI ?? '',
    CHROME_PATH: options.chrome,
    ORION_WEB_E2E_RUN_ROOT: options.runRoot,
    ORION_WEB_E2E_TARBALL: options.tarball,
    ORION_WEB_E2E_RECEIPT: options.receipt,
    ORION_WEB_E2E_RUNNER_NAME:
      process.env.ORION_WEB_E2E_RUNNER_NAME ?? (process.env.CI ? 'github-actions' : 'local'),
    ORION_WEB_E2E_RUNNER_IMAGE:
      process.env.ORION_WEB_E2E_RUNNER_IMAGE ??
      ([process.env.ImageOS, process.env.ImageVersion].filter(Boolean).join('@') ||
        `${process.platform}-${process.arch}`),
    ORION_WEB_E2E_CHROME_CHANNEL:
      process.env.ORION_WEB_E2E_CHROME_CHANNEL ?? 'system-google-chrome',
  };
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cli, 'test'], {
      cwd: options.repositoryRoot,
      env: environment,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Primary Web E2E child exited by ${signal}.`));
        return;
      }
      resolveRun(code ?? 1);
    });
  });
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

void main().catch(error => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
