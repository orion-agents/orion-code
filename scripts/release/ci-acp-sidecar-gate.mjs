#!/usr/bin/env node

import { generateKeyPairSync, verify as verifySignature } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { canonicalJsonBytes, failClosedCli } from './release-tooling-common.mjs';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TARGET = 'darwin-aarch64';
const MAX_FIXTURE_ARCHIVE_BYTES = 1024 * 1024;
const FIXED_GIT_DATE = '2026-08-31T00:00:00Z';

export async function runUnsignedAcpSidecarCiGate(options = {}) {
  const repositoryRoot = resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  const temporaryParent = resolve(options.temporaryParent ?? tmpdir());
  const packageManifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
  const temporaryRoot = mkdtempSync(join(temporaryParent, 'orion-acp-sidecar-ci-'));
  let summary;

  try {
    const fixture = createMinimalPackageFixture(temporaryRoot, packageManifest.version);
    const gitSha = initializeFixtureRepository(fixture.packageRoot);
    const candidate = runJsonCommand(
      'unsigned sidecar builder',
      join(repositoryRoot, 'scripts', 'release', 'build-acp-sidecar.mjs'),
      [
        '--version',
        packageManifest.version,
        '--git-sha',
        gitSha,
        '--target',
        TARGET,
        '--out',
        fixture.candidateOutput,
        '--node-runtime',
        fixture.runtime,
        '--node-license',
        fixture.nodeLicense,
        '--bundle-id',
        'invalid.example.orion-code-sidecar.ci-fixture',
        '--studio-version-requirement',
        '>=0.1.0,<1.0.0',
        '--local-unsigned',
        '--skip-build',
        '--skip-smoke',
        '--local-fixture-package-root',
        fixture.packageRoot,
      ]
    );
    assertEqual(candidate.release_status, 'NOT_RELEASABLE', 'builder release status');
    assertExternalActions(candidate.external_actions, [
      'NOT_PUSHED',
      'NOT_PUBLISHED',
      'NOT_SIGNED',
      'NOT_NOTARIZED',
    ]);
    assertNotReleasableMarker(candidate.marker);

    const archiveBytes = lstatSync(candidate.archive).size;
    if (archiveBytes > MAX_FIXTURE_ARCHIVE_BYTES) {
      throw new Error(
        `CI fixture archive exceeded ${MAX_FIXTURE_ARCHIVE_BYTES} bytes; refusing disk-heavy gate.`
      );
    }

    const replay = runJsonCommand(
      'sidecar receipt replay',
      join(repositoryRoot, 'scripts', 'release', 'verify-acp-sidecar.mjs'),
      ['--receipt', candidate.receipt, '--archive', candidate.archive]
    );
    assertEqual(replay.status, 'PASS', 'replay status');
    assertEqual(replay.release_status, 'NOT_RELEASABLE', 'replay release status');
    assertEqual(replay.target, TARGET, 'replay target');

    const testKey = createLocalTestKey(temporaryRoot);
    const index = runJsonCommand(
      'unsigned update-index generator',
      join(repositoryRoot, 'scripts', 'release', 'generate-update-index.mjs'),
      [
        '--receipts',
        candidate.receipt,
        '--out',
        fixture.indexOutput,
        '--sequence',
        '1',
        '--generated-at',
        '2026-08-31T00:00:00.000Z',
        '--expires-at',
        '2026-09-07T00:00:00.000Z',
        '--published-at',
        '2026-08-31T00:00:00.000Z',
        '--channel',
        'beta',
        '--status',
        'active',
        '--studio-version-requirement',
        '>=0.1.0,<1.0.0',
        '--rollout-basis-points',
        '10000',
        '--rollout-salt',
        'ci-fixture-v1',
        '--archive-base-url',
        'https://updates.invalid/orion-code/',
        '--release-notes-url',
        'https://updates.invalid/orion-code/fixture',
        '--allow-unsigned-fixture',
        '--test-private-key',
        testKey.privateKeyPath,
        '--test-key-id',
        'local-test-ci-gate',
      ]
    );
    assertEqual(index.mode, 'DRY_RUN', 'index mode');
    assertEqual(index.release_status, 'NOT_RELEASABLE', 'index release status');
    assertExternalActions(index.external_actions, [
      'NOT_PUSHED',
      'NOT_PUBLISHED',
      'NOT_SIGNED_WITH_RELEASE_KEY',
    ]);
    assertNotReleasableMarker(join(fixture.indexOutput, 'NOT_RELEASABLE.txt'));
    verifyLocalTestIndexSignature(index.index, index.signature, testKey.publicKey);

    summary = {
      kind: 'orion.acp-sidecar-ci-gate',
      status: 'PASS',
      release_status: 'NOT_RELEASABLE',
      target: TARGET,
      archive_bytes: archiveBytes,
      replay: 'PASS',
      index: 'PASS_LOCAL_TEST_KEY',
      retained_artifacts: 0,
      external_actions: [
        'NOT_PUSHED',
        'NOT_UPLOADED',
        'NOT_PUBLISHED',
        'NOT_SIGNED',
        'NOT_NOTARIZED',
      ],
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }

  if (existsSync(temporaryRoot)) {
    throw new Error('CI fixture cleanup failed; temporary candidate was retained.');
  }
  return summary;
}

function createMinimalPackageFixture(root, version) {
  const packageRoot = join(root, 'package');
  const candidateOutput = join(root, 'candidate');
  const indexOutput = join(root, 'index');
  mkdirSync(join(packageRoot, 'dist', 'acp'), { recursive: true });
  mkdirSync(join(packageRoot, 'dist', 'product'), { recursive: true });

  const packageManifest = {
    name: '@orion-agents/orion-code',
    version,
    license: 'MIT',
    dependencies: {},
    devDependencies: {},
    engines: { node: '^22.12.0 || ^24.0.0 || ^26.0.0' },
  };
  writeJson(join(packageRoot, 'package.json'), packageManifest);
  writeJson(join(packageRoot, 'npm-shrinkwrap.json'), {
    name: packageManifest.name,
    version,
    lockfileVersion: 3,
    packages: {
      '': packageManifest,
    },
  });
  writeFileSync(join(packageRoot, 'LICENSE'), 'MIT License\n');
  writeFileSync(
    join(packageRoot, 'dist', 'acp', 'server.mjs'),
    "export { PACKAGE_VERSION as version } from '../product/version.js';\n"
  );
  writeFileSync(
    join(packageRoot, 'dist', 'product', 'version.js'),
    `export const PACKAGE_VERSION = '${version}';\n`
  );

  const runtime = join(root, 'fixture-node');
  writeFileSync(
    runtime,
    '#!/bin/sh\nprintf \'%s\\n\' \'{"nodeVersion":"v24.14.0","nodeAbi":"137","platform":"darwin","arch":"arm64"}\'\n',
    { mode: 0o755 }
  );
  chmodSync(runtime, 0o755);
  const nodeLicense = join(root, 'NODE-LICENSE');
  writeFileSync(nodeLicense, 'Node.js fixture license evidence.\n');
  return { packageRoot, candidateOutput, indexOutput, runtime, nodeLicense };
}

function initializeFixtureRepository(packageRoot) {
  runCommand('git init', 'git', ['init', '--quiet'], packageRoot);
  runCommand('git add', 'git', ['add', '--all'], packageRoot);
  runCommand(
    'git commit',
    'git',
    ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Create CI release fixture'],
    packageRoot,
    {
      ...process.env,
      GIT_AUTHOR_NAME: 'Orion CI Fixture',
      GIT_AUTHOR_EMAIL: 'ci-fixture@invalid.example',
      GIT_COMMITTER_NAME: 'Orion CI Fixture',
      GIT_COMMITTER_EMAIL: 'ci-fixture@invalid.example',
      GIT_AUTHOR_DATE: FIXED_GIT_DATE,
      GIT_COMMITTER_DATE: FIXED_GIT_DATE,
    }
  );
  return runCommand('git rev-parse', 'git', ['rev-parse', 'HEAD'], packageRoot).trim();
}

function createLocalTestKey(root) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPath = join(root, 'local-test-index-key.pem');
  writeFileSync(privateKeyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), {
    mode: 0o600,
  });
  chmodSync(privateKeyPath, 0o600);
  return { privateKeyPath, publicKey };
}

function verifyLocalTestIndexSignature(indexPath, signaturePath, publicKey) {
  const indexBytes = readFileSync(indexPath);
  const envelope = JSON.parse(readFileSync(signaturePath, 'utf8'));
  if (!envelope.key_id?.startsWith('local-test-')) {
    throw new Error('CI index signature did not use a local-test key ID.');
  }
  if (!verifySignature(null, indexBytes, publicKey, Buffer.from(envelope.signature, 'base64'))) {
    throw new Error('CI index signature did not cover the exact generated index bytes.');
  }
}

function runJsonCommand(label, script, arguments_) {
  const stdout = runCommand(label, process.execPath, [script, ...arguments_], REPOSITORY_ROOT);
  try {
    return JSON.parse(stdout.trim());
  } catch {
    throw new Error(`${label} did not emit one machine-readable JSON result.`);
  }
}

function runCommand(label, command, arguments_, cwd, environment = process.env) {
  const result = spawnSync(command, arguments_, {
    cwd,
    env: environment,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.error) throw new Error(`${label} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    const diagnostic = (result.stderr || result.stdout || '').trim();
    throw new Error(`${label} failed closed${diagnostic ? `: ${diagnostic}` : '.'}`);
  }
  return result.stdout;
}

function assertNotReleasableMarker(path) {
  if (!/NOT RELEASABLE/.test(readFileSync(path, 'utf8'))) {
    throw new Error('CI fixture is missing its NOT RELEASABLE marker.');
  }
}

function assertExternalActions(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('release command external-action boundary drifted.');
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} is ${String(actual)}, expected ${expected}.`);
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, canonicalJsonBytes(value));
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  await failClosedCli('orion.acp-sidecar-ci-gate-error', async () => {
    if (process.argv.length !== 2) throw new Error('CI gate accepts no command-line arguments.');
    const result = await runUnsignedAcpSidecarCiGate();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  });
}
