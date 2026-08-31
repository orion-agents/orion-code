import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseBuildAcpSidecarArguments } from '../acp-sidecar-release.mjs';
import { buildProtectedSidecarCandidate } from '../build-protected-sidecar-candidate.mjs';
import { runUnsignedAcpSidecarCiGate } from '../ci-acp-sidecar-gate.mjs';
import {
  runProtectedReleasePreflight,
  validateExactTaggedSource,
  validateProtectedReleaseConfiguration,
} from '../protected-release-preflight.mjs';
import { failClosedCli } from '../release-tooling-common.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';

test('release CLIs await the fail-closed lifecycle at module scope', () => {
  for (const script of [
    '../build-acp-sidecar.mjs',
    '../verify-acp-sidecar.mjs',
    '../generate-update-index.mjs',
    '../build-protected-sidecar-candidate.mjs',
    '../ci-acp-sidecar-gate.mjs',
    '../protected-release-preflight.mjs',
    '../run-protected-sidecar-release.mjs',
  ]) {
    const source = readFileSync(new URL(script, import.meta.url), 'utf8');
    assert.equal(source.match(/failClosedCli\(/g)?.length, 1, script);
    assert.equal(source.match(/await failClosedCli\(/g)?.length, 1, script);
  }
});

test('fail-closed CLI lifecycle returns the operation promise', async () => {
  let completed = false;
  const lifecycle = failClosedCli('fixture-error', async () => {
    await Promise.resolve();
    completed = true;
  });
  assert.equal(typeof lifecycle?.then, 'function');
  await lifecycle;
  assert.equal(completed, true);
});

function protectedEnvironment(overrides = {}) {
  const privateKey = Buffer.from(
    '-----BEGIN PRIVATE KEY-----\nfixture-only-not-a-real-key-material\n-----END PRIVATE KEY-----\n'
  ).toString('base64');
  return {
    ORION_RELEASE_EVENT_NAME: 'workflow_dispatch',
    ORION_RELEASE_REF_TYPE: 'tag',
    ORION_RELEASE_REF_NAME: 'v0.3.2',
    ORION_RELEASE_REF_PROTECTED: 'true',
    ORION_RELEASE_ENVIRONMENT_NAME: 'orion-code-sidecar-release',
    ORION_RELEASE_SHA: SHA,
    ORION_APPLE_DEVELOPER_ID_CERTIFICATE_P12_BASE64: Buffer.alloc(64, 1).toString('base64'),
    ORION_APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD: 'fixture-password',
    ORION_APPLE_DEVELOPER_ID_APPLICATION:
      'Developer ID Application: Orion Release Fixture (ABCDE12345)',
    ORION_APPLE_TEAM_ID: 'ABCDE12345',
    ORION_APPLE_NOTARY_KEY_P8_BASE64: privateKey,
    ORION_APPLE_NOTARY_KEY_ID: 'FGHIJ67890',
    ORION_APPLE_NOTARY_ISSUER_ID: '12345678-1234-1234-1234-1234567890ab',
    ORION_UPDATE_INDEX_PRIVATE_KEY_PEM_BASE64: privateKey,
    ORION_UPDATE_INDEX_KEY_ID: 'orion-release-key-v1',
    ORION_CODE_SIDECAR_BUNDLE_ID: 'invalid.example.orion-code-sidecar.fixture',
    ORION_RELEASE_ASSET_UPLOAD_BASE_URL: 'https://uploads.orion.invalid/sidecar/',
    ORION_RELEASE_PUBLIC_BASE_URL: 'https://releases.orion.invalid/sidecar/',
    ORION_RELEASE_PUBLICATION_URL: 'https://uploads.orion.invalid/publications/1.json',
    ORION_RELEASE_UPLOAD_TOKEN: 'a'.repeat(64),
    ...overrides,
  };
}

test('fixture package roots require every explicit local-only builder guard', () => {
  assert.throws(
    () =>
      parseBuildAcpSidecarArguments([
        '--version',
        '0.3.2',
        '--git-sha',
        '0123456789abcdef0123456789abcdef01234567',
        '--target',
        'darwin-aarch64',
        '--out',
        '/tmp/output',
        '--node-runtime',
        '/tmp/node',
        '--node-license',
        '/tmp/LICENSE',
        '--studio-version-requirement',
        '>=0.1.0,<1.0.0',
        '--local-unsigned',
        '--skip-build',
        '--local-fixture-package-root',
        '/tmp/package',
      ]),
    /requires --local-unsigned, --skip-build, and --skip-smoke/
  );
});

test('ordinary CI builds, replays, and indexes only a disposable NOT RELEASABLE fixture', async t => {
  const temporaryParent = mkdtempSync(join(tmpdir(), 'orion-ci-gate-test-'));
  t.after(() => rmSync(temporaryParent, { recursive: true, force: true }));
  const result = await runUnsignedAcpSidecarCiGate({ temporaryParent });
  assert.equal(result.status, 'PASS');
  assert.equal(result.release_status, 'NOT_RELEASABLE');
  assert.equal(result.target, 'darwin-aarch64');
  assert.equal(result.replay, 'PASS');
  assert.equal(result.index, 'PASS_LOCAL_TEST_KEY');
  assert.equal(result.retained_artifacts, 0);
  assert.ok(result.archive_bytes < 1024 * 1024);
  assert.deepEqual(result.external_actions, [
    'NOT_PUSHED',
    'NOT_UPLOADED',
    'NOT_PUBLISHED',
    'NOT_SIGNED',
    'NOT_NOTARIZED',
  ]);
  assert.deepEqual(readdirSync(temporaryParent), []);
});

test('protected release preflight names missing configuration without exposing values', () => {
  assert.throws(
    () =>
      validateProtectedReleaseConfiguration(
        protectedEnvironment({
          ORION_APPLE_TEAM_ID: '',
          ORION_APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD: 'do-not-print-this',
        }),
        '0.3.2'
      ),
    error => {
      assert.match(error.message, /protected release configuration is missing/);
      assert.match(error.message, /ORION_APPLE_TEAM_ID/);
      assert.doesNotMatch(error.message, /do-not-print-this/);
      return true;
    }
  );
});

test('protected release preflight rejects ordinary pull-request context', () => {
  assert.throws(
    () =>
      validateProtectedReleaseConfiguration(
        protectedEnvironment({
          ORION_RELEASE_EVENT_NAME: 'pull_request',
          ORION_RELEASE_REF_TYPE: 'branch',
          ORION_RELEASE_REF_NAME: 'feature',
        }),
        '0.3.2'
      ),
    /requires workflow_dispatch/
  );
});

test('protected release preflight accepts complete shapes without exposing values', () => {
  const environment = protectedEnvironment();
  assert.equal(
    validateProtectedReleaseConfiguration(environment, '0.3.2', { allowFixtureValues: true })
      .status,
    'PASS'
  );
});

test('exact tagged source validation is injectable and rejects a dirty checkout', async () => {
  const cleanRunner = {
    async run({ args }) {
      if (args[0] === 'status') return { stdout: '', stderr: '' };
      return { stdout: `${SHA}\n`, stderr: '' };
    },
  };
  assert.equal(
    (await validateExactTaggedSource(protectedEnvironment(), { runner: cleanRunner })).status,
    'PASS'
  );
  const dirtyRunner = {
    async run({ args }) {
      if (args[0] === 'status') return { stdout: ' M package.json\n', stderr: '' };
      return { stdout: `${SHA}\n`, stderr: '' };
    },
  };
  await assert.rejects(
    validateExactTaggedSource(protectedEnvironment(), { runner: dirtyRunner }),
    /not the clean exact tagged SHA/
  );
});

test('full protected preflight uses only injected git commands in fixture mode', async () => {
  const runner = {
    async run({ args }) {
      if (args[0] === 'status') return { stdout: '', stderr: '' };
      return { stdout: `${SHA}\n`, stderr: '' };
    },
  };
  const result = await runProtectedReleasePreflight(protectedEnvironment(), {
    runner,
    allowFixtureValues: true,
  });
  assert.equal(result.release_status, 'READY_FOR_PROTECTED_STEPS');
});

test('unsigned protected build refuses signing, notary, index, and upload secrets', async () => {
  const runner = {
    async run() {
      throw new Error('source commands must not run after secret rejection');
    },
  };
  await assert.rejects(
    buildProtectedSidecarCandidate(protectedEnvironment(), { runner }),
    /must not receive signing, notarization, or upload secrets/
  );
});

test('protected workflow keeps secrets out of the real build and smoke step', () => {
  const workflow = readFileSync(
    new URL('../../../.github/workflows/acp-sidecar-release-gate.yml', import.meta.url),
    'utf8'
  );
  const buildStart = workflow.indexOf(
    '- name: Build and smoke-test the unsigned production candidate'
  );
  const signingStart = workflow.indexOf(
    '- name: Sign, notarize, replay, and conditionally publish'
  );
  assert.ok(buildStart >= 0 && signingStart > buildStart);
  const buildStep = workflow.slice(buildStart, signingStart);
  assert.doesNotMatch(buildStep, /secrets\./);
  assert.match(buildStep, /release:acp-sidecar-protected-build/);
  assert.doesNotMatch(workflow, /--skip-build|--skip-smoke/);

  const builder = readFileSync(
    new URL('../build-protected-sidecar-candidate.mjs', import.meta.url),
    'utf8'
  );
  assert.match(builder, /skipBuild: false/);
  assert.match(builder, /skipSmoke: false/);
});
