#!/usr/bin/env ts-node

import { spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

import { digestRuntimeValue } from '../../src/runtime/protocol/canonical';
import {
  assertSupportedReleaseNodeVersionV1,
  SUPPORTED_RELEASE_NODE_MAJORS_V1,
  WEB_E2E_CRITICAL_SCENARIOS_V1,
  type SupportedReleaseNodeMajorV1,
} from '../../src/runtime/release-receipts';
import { WEB_E2E_CRITICAL_GREP } from '../../tests/e2e/scenarios';

interface CliOptions {
  readonly tarball: string;
  readonly receipt: string;
  readonly chrome: string;
  readonly nodes: Readonly<Record<SupportedReleaseNodeMajorV1, string>>;
}

interface MatrixEntry {
  readonly nodeMajor: SupportedReleaseNodeMajorV1;
  readonly nodeVersion: string;
  readonly executable: string;
  readonly runRoot: string;
  readonly exitCode: number;
  readonly decision: string;
  readonly runId?: string;
  readonly tarballSha256?: string;
  readonly installedTargetDigest?: string;
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
  const packageIdentity = readJson(join(repositoryRoot, 'package.json')) as {
    name?: string;
    version?: string;
  };
  const expectedSha = receipt.tarball?.sha256;
  if (!/^[a-f0-9]{64}$/u.test(expectedSha ?? '')) {
    throw new Error('Artifact receipt is missing a valid tarball SHA-256.');
  }
  const observedSha = sha256(options.tarball);
  if (observedSha !== expectedSha) throw new Error('Tarball SHA-256 differs from its receipt.');
  if (
    packageIdentity.name !== '@orion-agents/orion-code' ||
    !packageIdentity.version ||
    receipt.package?.name !== packageIdentity.name ||
    receipt.package.version !== packageIdentity.version
  ) {
    throw new Error(
      `Matrix requires ${packageIdentity.name ?? '@orion-agents/orion-code'}@${packageIdentity.version ?? 'UNKNOWN'}.`
    );
  }

  const matrixRoot = join(
    repositoryRoot,
    'tests',
    'tmp',
    'web-e2e',
    `matrix-${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}`
  );
  mkdirSync(matrixRoot, { recursive: true, mode: 0o700 });
  const entries: MatrixEntry[] = [];
  for (const major of SUPPORTED_RELEASE_NODE_MAJORS_V1) {
    const executable = realpathSync(options.nodes[major]);
    const version = nodeVersion(executable);
    assertNodeVersion(major, version);
    const runRoot = join(matrixRoot, `node-${major}`);
    const exitCode = await runPlaywright({
      repositoryRoot,
      executable,
      runRoot,
      tarball: options.tarball,
      receipt: options.receipt,
      chrome: options.chrome,
    });
    const manifestPath = join(runRoot, 'manifest.json');
    const manifest = existsSync(manifestPath)
      ? (readJson(manifestPath) as {
          runId?: string;
          decision?: string;
          artifact?: { tarballSha256?: string; installedTargetDigest?: string };
          scenarios?: readonly { scenarioId?: string }[];
        })
      : undefined;
    entries.push({
      nodeMajor: major,
      nodeVersion: version,
      executable,
      runRoot,
      exitCode,
      decision: manifest?.decision ?? 'MISSING',
      exactCoverage: sameOrderedValues(
        (manifest?.scenarios ?? []).map(scenario => String(scenario.scenarioId ?? '')).sort(),
        WEB_E2E_CRITICAL_SCENARIOS_V1
      ),
      ...(manifest?.runId ? { runId: manifest.runId } : {}),
      ...(manifest?.artifact?.tarballSha256
        ? { tarballSha256: manifest.artifact.tarballSha256 }
        : {}),
      ...(manifest?.artifact?.installedTargetDigest
        ? { installedTargetDigest: manifest.artifact.installedTargetDigest }
        : {}),
      ...(manifest ? { manifestDigest: digestRuntimeValue(manifest) } : {}),
    });
  }

  const uniqueRunIds = new Set(entries.map(entry => entry.runId).filter(Boolean)).size;
  const targetDigests = new Set(entries.map(entry => entry.installedTargetDigest).filter(Boolean));
  const go =
    entries.every(
      entry =>
        entry.exitCode === 0 &&
        entry.decision === 'GO' &&
        entry.tarballSha256 === expectedSha &&
        entry.exactCoverage
    ) &&
    uniqueRunIds === SUPPORTED_RELEASE_NODE_MAJORS_V1.length &&
    targetDigests.size === 1;
  const summary = {
    version: 1,
    kind: 'orion.web-e2e-node-matrix',
    createdAt: new Date().toISOString(),
    package: receipt.package,
    tarballSha256: expectedSha,
    entries: entries.map(entry => ({
      ...entry,
      executable: `node-${entry.nodeMajor}`,
      runRoot: `node-${entry.nodeMajor}`,
    })),
    identity: { uniqueRunIds, installedTargetDigests: targetDigests.size },
    decision: go ? 'GO' : 'NO_GO',
  };
  writeFileSync(join(matrixRoot, 'matrix.json'), `${JSON.stringify(summary, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(
    `[web-e2e-matrix] decision=${summary.decision} sha256=${expectedSha} evidence=${matrixRoot}\n`
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
    if (!key?.startsWith('--') || !value) throw new Error(`Invalid matrix argument: ${key ?? ''}`);
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
    nodes: {
      22: required('node22'),
      24: required('node24'),
      26: required('node26'),
    },
  };
}

function nodeVersion(executable: string): string {
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Unable to execute ${executable}.`);
  return result.stdout.trim();
}

function assertNodeVersion(expectedMajor: SupportedReleaseNodeMajorV1, version: string): void {
  assertSupportedReleaseNodeVersionV1(version, expectedMajor, 'Web E2E matrix');
}

async function runPlaywright(options: {
  readonly repositoryRoot: string;
  readonly executable: string;
  readonly runRoot: string;
  readonly tarball: string;
  readonly receipt: string;
  readonly chrome: string;
}): Promise<number> {
  const cli = join(options.repositoryRoot, 'node_modules', '@playwright', 'test', 'cli.js');
  const environment: NodeJS.ProcessEnv = {
    PATH: `${dirname(options.executable)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL ?? '',
    CI: process.env.CI ?? '',
    CHROME_PATH: options.chrome,
    ORION_WEB_E2E_RUN_ROOT: options.runRoot,
    ORION_WEB_E2E_PROFILE: 'critical',
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
    const child = spawn(options.executable, [cli, 'test', '--grep', WEB_E2E_CRITICAL_GREP], {
      cwd: options.repositoryRoot,
      env: environment,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Node matrix child exited by ${signal}.`));
        return;
      }
      resolveRun(code ?? 1);
    });
  });
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

void main().catch(error => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
