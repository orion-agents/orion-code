import { spawnSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, join, relative, resolve, sep } from 'path';

import { digestRuntimeValue } from '../../../src/runtime/protocol/canonical';
import {
  assertSupportedReleaseNodeVersionV1,
  type TarballArtifactReceiptV1,
  verifyTarballArtifactReceiptV1,
} from '../../../src/runtime/release-receipts';
import {
  WEB_E2E_ARTIFACT_STATE_VERSION,
  WEB_E2E_RECEIPT_ENV,
  WEB_E2E_RUN_ROOT_ENV,
  WEB_E2E_STATE_ENV,
  WEB_E2E_TARBALL_ENV,
  type WebE2EArtifactSourceV1,
  type WebE2EArtifactStateV1,
} from './artifact-types';

const REPOSITORY_ROOT = resolve(__dirname, '../../..');
const RAW_EVIDENCE_ROOT = join(REPOSITORY_ROOT, 'tests', 'tmp', 'web-e2e');
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const EXPECTED_PACKAGE_NAME = '@orion-agents/orion-code';

interface RootPackageManifest {
  readonly name: string;
  readonly version: string;
}

interface InstalledPackageManifest extends RootPackageManifest {
  readonly bin?: string | Readonly<Record<string, string>>;
}

interface ArtifactInputV1 {
  readonly source: WebE2EArtifactSourceV1;
  readonly tarballPath: string;
  readonly receiptPath: string;
  readonly receipt: TarballArtifactReceiptV1;
}

export interface PrepareWebE2EArtifactOptions {
  readonly repositoryRoot?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runRoot?: string;
}

export function prepareWebE2EArtifact(
  options: PrepareWebE2EArtifactOptions = {}
): WebE2EArtifactStateV1 {
  const repositoryRoot = realpathSync(options.repositoryRoot ?? REPOSITORY_ROOT);
  assertSupportedWebE2ENode(process.versions.node);
  const rootPackage = readJson<RootPackageManifest>(join(repositoryRoot, 'package.json'));
  if (rootPackage.name !== EXPECTED_PACKAGE_NAME) {
    throw new Error(`Unexpected Web E2E package name: ${rootPackage.name}.`);
  }

  const environment = options.environment ?? process.env;
  mkdirPrivate(RAW_EVIDENCE_ROOT);
  const runId = createRunId();
  const configuredRunRoot = options.runRoot ?? environment[WEB_E2E_RUN_ROOT_ENV];
  const rawRoot = configuredRunRoot
    ? resolve(repositoryRoot, configuredRunRoot)
    : join(RAW_EVIDENCE_ROOT, runId);
  assertEvidenceRunRoot(rawRoot);
  mkdirPrivate(rawRoot);
  if (existsSync(join(rawRoot, 'state.json'))) {
    throw new Error('Web E2E run root already contains artifact state.');
  }
  const artifactDirectory = join(rawRoot, 'artifact');
  mkdirPrivate(artifactDirectory);

  const input = resolveArtifactInput({
    repositoryRoot,
    rawRoot,
    artifactDirectory,
    rootPackage,
    environment,
  });
  const receipt = verifyArtifactBinding(input.tarballPath, input.receiptPath, rootPackage);
  assertCurrentSourceBinding(repositoryRoot, rawRoot, receipt);

  const installation = installArtifact({
    rawRoot,
    tarballPath: input.tarballPath,
    receipt,
  });
  const npm = runTool('npm', ['--version'], {
    cwd: repositoryRoot,
    rawRoot,
    label: 'npm-version',
  }).trim();
  const statePath = join(rawRoot, 'state.json');
  const unsigned = {
    version: WEB_E2E_ARTIFACT_STATE_VERSION,
    kind: 'orion.web-e2e-artifact-state' as const,
    createdAt: new Date().toISOString(),
    runId,
    repositoryRoot,
    rawRoot,
    statePath,
    source: input.source,
    artifact: {
      tarballPath: input.tarballPath,
      receiptPath: input.receiptPath,
      receipt,
    },
    installation,
    environment: {
      node: process.version,
      nodeMajor: Number(process.versions.node.split('.')[0]),
      npm,
      platform: process.platform,
      arch: process.arch,
    },
  };
  const state: WebE2EArtifactStateV1 = Object.freeze({
    ...unsigned,
    stateDigest: digestRuntimeValue(unsigned),
  });
  writePrivateJson(statePath, state);
  process.env[WEB_E2E_STATE_ENV] = statePath;
  return state;
}

export function loadWebE2EArtifactState(
  statePath = process.env[WEB_E2E_STATE_ENV]
): WebE2EArtifactStateV1 {
  if (!statePath) {
    throw new Error(`${WEB_E2E_STATE_ENV} is not set; Web E2E global setup did not run.`);
  }
  const state = readJson<WebE2EArtifactStateV1>(resolve(statePath));
  if (
    state.version !== WEB_E2E_ARTIFACT_STATE_VERSION ||
    state.kind !== 'orion.web-e2e-artifact-state'
  ) {
    throw new Error('Invalid Web E2E artifact state envelope.');
  }
  if (digestRuntimeValue(unsignedState(state)) !== state.stateDigest) {
    throw new Error('Web E2E artifact state digest mismatch.');
  }
  if (realpathSync(state.repositoryRoot) !== realpathSync(REPOSITORY_ROOT)) {
    throw new Error('Web E2E artifact state belongs to another repository checkout.');
  }
  assertSupportedWebE2ENode(process.versions.node);
  if (state.environment.node !== process.version) {
    throw new Error(
      `Web E2E artifact state was prepared by ${state.environment.node}, ` +
        `but the current runtime is ${process.version}.`
    );
  }
  assertPathInside(state.rawRoot, state.statePath, 'state path');
  assertPathInside(state.rawRoot, state.artifact.tarballPath, 'tarball path');
  assertPathInside(state.rawRoot, state.artifact.receiptPath, 'artifact receipt path');
  assertPathInside(state.rawRoot, state.installation.prefix, 'install prefix');

  const rootPackage = readJson<RootPackageManifest>(join(state.repositoryRoot, 'package.json'));
  const receipt = verifyArtifactBinding(
    state.artifact.tarballPath,
    state.artifact.receiptPath,
    rootPackage
  );
  if (receipt.receiptDigest !== state.artifact.receipt.receiptDigest) {
    throw new Error('Web E2E state is not bound to the verified artifact receipt.');
  }
  verifyInstalledPackage(state, rootPackage);
  assertSupportedWebE2ENode(state.environment.node.replace(/^v/u, ''));
  return Object.freeze(state);
}

export function assertSupportedWebE2ENode(version: string): void {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version.replace(/^v/u, ''));
  if (!match) throw new Error(`Unable to parse Node version ${version}.`);
  const major = Number(match[1]);
  assertSupportedReleaseNodeVersionV1(`v${match[1]}.${match[2]}.${match[3]}`, major, 'Web E2E');
}

function resolveArtifactInput(options: {
  readonly repositoryRoot: string;
  readonly rawRoot: string;
  readonly artifactDirectory: string;
  readonly rootPackage: RootPackageManifest;
  readonly environment: NodeJS.ProcessEnv;
}): ArtifactInputV1 {
  const suppliedTarball = options.environment[WEB_E2E_TARBALL_ENV];
  const suppliedReceipt = options.environment[WEB_E2E_RECEIPT_ENV];
  if (Boolean(suppliedTarball) !== Boolean(suppliedReceipt)) {
    throw new Error(`${WEB_E2E_TARBALL_ENV} and ${WEB_E2E_RECEIPT_ENV} must be provided together.`);
  }

  if (suppliedTarball && suppliedReceipt) {
    const originalTarball = resolve(options.repositoryRoot, suppliedTarball);
    const originalReceipt = resolve(options.repositoryRoot, suppliedReceipt);
    const receipt = verifyArtifactBinding(originalTarball, originalReceipt, options.rootPackage);
    const tarballPath = join(options.artifactDirectory, receipt.tarball.filename);
    const receiptPath = join(options.artifactDirectory, 'artifact.json');
    copyFileSync(originalTarball, tarballPath);
    copyFileSync(originalReceipt, receiptPath);
    chmodSync(tarballPath, 0o600);
    chmodSync(receiptPath, 0o600);
    return { source: 'provided', tarballPath, receiptPath, receipt };
  }

  runTool('npm', ['run', 'build'], {
    cwd: options.repositoryRoot,
    rawRoot: options.rawRoot,
    label: 'build',
  });
  const receiptPath = join(options.artifactDirectory, 'artifact.json');
  runTool(
    'npm',
    [
      'run',
      'release:artifact',
      '--',
      '--out-dir',
      options.artifactDirectory,
      '--receipt',
      receiptPath,
    ],
    { cwd: options.repositoryRoot, rawRoot: options.rawRoot, label: 'release-artifact' }
  );
  const receipt = verifyTarballArtifactReceiptV1(readJson<unknown>(receiptPath));
  return {
    source: 'built',
    tarballPath: join(options.artifactDirectory, receipt.tarball.filename),
    receiptPath,
    receipt,
  };
}

function verifyArtifactBinding(
  tarballPath: string,
  receiptPath: string,
  expectedPackage: RootPackageManifest
): TarballArtifactReceiptV1 {
  assertRegularFile(tarballPath, 'Web E2E tarball');
  assertRegularFile(receiptPath, 'Web E2E artifact receipt');
  const receipt = verifyTarballArtifactReceiptV1(readJson<unknown>(receiptPath));
  if (basename(tarballPath) !== receipt.tarball.filename) {
    throw new Error('Web E2E tarball filename does not match its artifact receipt.');
  }
  if (
    receipt.package.name !== expectedPackage.name ||
    receipt.package.version !== expectedPackage.version
  ) {
    throw new Error(
      `Web E2E package mismatch: expected ${expectedPackage.name}@${expectedPackage.version}, ` +
        `received ${receipt.package.name}@${receipt.package.version}.`
    );
  }
  const tarball = statSync(tarballPath);
  if (tarball.size !== receipt.tarball.bytes) {
    throw new Error('Web E2E tarball byte count does not match its artifact receipt.');
  }
  if (sha256File(tarballPath) !== receipt.tarball.sha256) {
    throw new Error('Web E2E tarball SHA-256 does not match its artifact receipt.');
  }
  return receipt;
}

function assertCurrentSourceBinding(
  repositoryRoot: string,
  rawRoot: string,
  receipt: TarballArtifactReceiptV1
): void {
  const head = runTool('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    rawRoot,
    label: 'git-head',
    persistOutput: false,
  }).trim();
  if (head !== receipt.source.gitSha) {
    throw new Error(
      `Web E2E artifact source mismatch: checkout ${head}, receipt ${receipt.source.gitSha}.`
    );
  }
}

function installArtifact(options: {
  readonly rawRoot: string;
  readonly tarballPath: string;
  readonly receipt: TarballArtifactReceiptV1;
}): WebE2EArtifactStateV1['installation'] {
  const prefix = join(options.rawRoot, 'install');
  mkdirPrivate(prefix, false);
  runTool(
    'npm',
    [
      'install',
      '--prefix',
      prefix,
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      options.tarballPath,
    ],
    { cwd: options.rawRoot, rawRoot: options.rawRoot, label: 'npm-install' }
  );
  const packageRoot = join(prefix, 'node_modules', ...options.receipt.package.name.split('/'));
  const packageJsonPath = join(packageRoot, 'package.json');
  const binaryPath = join(packageRoot, 'bin', 'orion');
  const state = {
    prefix,
    packageRoot,
    packageJsonPath,
    binaryPath,
    targetDigest: digestInstalledTarget(packageRoot),
  };
  verifyInstalledPackage(
    {
      installation: state,
      artifact: { receipt: options.receipt },
    } as Pick<WebE2EArtifactStateV1, 'installation' | 'artifact'>,
    options.receipt.package
  );
  return Object.freeze(state);
}

function verifyInstalledPackage(
  state: Pick<WebE2EArtifactStateV1, 'installation' | 'artifact'>,
  expectedPackage: RootPackageManifest
): void {
  assertRegularFile(state.installation.packageJsonPath, 'installed package.json');
  assertRegularFile(state.installation.binaryPath, 'installed Orion binary');
  for (const path of [
    join(state.installation.packageRoot, 'dist', 'cli.js'),
    join(state.installation.packageRoot, 'dist', 'web', 'server.js'),
    join(state.installation.packageRoot, 'dist', 'web-client', 'index.html'),
  ]) {
    assertRegularFile(path, 'installed Web runtime target');
  }
  const installed = readJson<InstalledPackageManifest>(state.installation.packageJsonPath);
  const installedBin = typeof installed.bin === 'string' ? installed.bin : installed.bin?.orion;
  if (
    installed.name !== expectedPackage.name ||
    installed.version !== expectedPackage.version ||
    installedBin !== 'bin/orion'
  ) {
    throw new Error('Installed Web E2E package identity or binary mapping is invalid.');
  }
  if (state.artifact.receipt.package.name !== installed.name) {
    throw new Error('Installed Web E2E package is not bound to the artifact receipt.');
  }
  if (digestInstalledTarget(state.installation.packageRoot) !== state.installation.targetDigest) {
    throw new Error('Installed Web E2E target digest mismatch.');
  }
}

function digestInstalledTarget(packageRoot: string): string {
  const targets = [
    'package.json',
    'bin/orion',
    'dist/cli.js',
    'dist/web/server.js',
    'dist/web-client/index.html',
  ];
  const hash = createHash('sha256');
  for (const path of targets) {
    const body = readFileSync(join(packageRoot, path));
    hash.update(path).update('\0').update(String(body.length)).update('\0').update(body);
  }
  return hash.digest('hex');
}

function runTool(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly rawRoot: string;
    readonly label: string;
    readonly persistOutput?: boolean;
  }
): string {
  const toolRoot = join(options.rawRoot, 'setup');
  mkdirPrivate(toolRoot);
  const npmConfigPath = join(options.rawRoot, '.npmrc');
  if (!existsSync(npmConfigPath)) writeFileSync(npmConfigPath, '', { mode: 0o600 });
  const outcome = spawnSync(platformCommand(command), [...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    env: toolEnvironment(options.rawRoot, npmConfigPath),
    windowsHide: true,
  });
  const stdout = outcome.stdout ?? '';
  const stderr = outcome.error?.message ?? outcome.stderr ?? '';
  if (options.persistOutput !== false) {
    writeFileSync(
      join(toolRoot, `${safeComponent(options.label)}.stdout.log`),
      boundedRedactedOutput(stdout, options.rawRoot),
      { mode: 0o600 }
    );
    writeFileSync(
      join(toolRoot, `${safeComponent(options.label)}.stderr.log`),
      boundedRedactedOutput(stderr, options.rawRoot),
      { mode: 0o600 }
    );
  }
  if (outcome.status !== 0) {
    throw new Error(
      `${command} ${args[0] ?? ''} failed with exit ${outcome.status ?? 'spawn-error'}: ` +
        boundedRedactedOutput(stderr || stdout, options.rawRoot).trim()
    );
  }
  return stdout;
}

function toolEnvironment(rawRoot: string, npmConfigPath: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    CI: process.env.CI,
    TMPDIR: join(rawRoot, 'tmp'),
    TEMP: join(rawRoot, 'tmp'),
    TMP: join(rawRoot, 'tmp'),
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    PATHEXT: process.env.PATHEXT,
    WINDIR: process.env.WINDIR,
    npm_config_userconfig: npmConfigPath,
    npm_config_cache: join(rawRoot, 'npm-cache'),
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
  mkdirPrivate(environment.TMPDIR!);
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

function unsignedState(state: WebE2EArtifactStateV1): Omit<WebE2EArtifactStateV1, 'stateDigest'> {
  return {
    version: state.version,
    kind: state.kind,
    createdAt: state.createdAt,
    runId: state.runId,
    repositoryRoot: state.repositoryRoot,
    rawRoot: state.rawRoot,
    statePath: state.statePath,
    source: state.source,
    artifact: state.artifact,
    installation: state.installation,
    environment: state.environment,
  };
}

function writePrivateJson(path: string, value: unknown): void {
  mkdirPrivate(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    throw new Error(
      `Unable to read JSON evidence ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function assertRegularFile(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} is missing.`);
}

function assertPathInside(root: string, candidate: string, label: string): void {
  const path = relative(resolve(root), resolve(candidate));
  if (!path || path === '..' || path.startsWith(`..${sep}`) || resolve(path) === path) {
    if (!path) return;
    throw new Error(`${label} escapes the Web E2E raw root.`);
  }
}

function assertEvidenceRunRoot(candidate: string): void {
  const root = resolve(RAW_EVIDENCE_ROOT);
  const path = relative(root, resolve(candidate));
  if (!path || path === '..' || path.startsWith(`..${sep}`) || resolve(path) === path) {
    throw new Error('Web E2E run root must be a child of tests/tmp/web-e2e.');
  }
}

function mkdirPrivate(path: string, recursive = true): void {
  mkdirSync(path, { recursive, mode: 0o700 });
}

function createRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}`;
}

function safeComponent(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 80) || 'command';
}

function boundedRedactedOutput(value: string, rawRoot: string): string {
  const redacted = value
    .split(rawRoot)
    .join('<RUN_ROOT>')
    .replace(/\b((?:authorization|api[_-]?key|token|secret)\s*[:=]\s*)[^\s,;]+/giu, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_.-]{8,}\b/gu, '[REDACTED]');
  const encoded = Buffer.from(redacted, 'utf8');
  return encoded.length <= MAX_COMMAND_OUTPUT_BYTES
    ? redacted
    : `${encoded.subarray(0, MAX_COMMAND_OUTPUT_BYTES).toString('utf8')}\n[TRUNCATED]\n`;
}

function platformCommand(command: string): string {
  return process.platform === 'win32' && command === 'npm' ? 'npm.cmd' : command;
}
