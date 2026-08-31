#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFailClosedCommandRunner } from './production-sidecar-release.mjs';
import { validateProductionUrl } from './production-publisher.mjs';
import { assertGitSha, failClosedCli } from './release-tooling-common.mjs';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PROTECTED_ENVIRONMENT = 'orion-code-sidecar-release';
const REQUIRED_CONTEXT = [
  'ORION_RELEASE_EVENT_NAME',
  'ORION_RELEASE_REF_TYPE',
  'ORION_RELEASE_REF_NAME',
  'ORION_RELEASE_REF_PROTECTED',
  'ORION_RELEASE_ENVIRONMENT_NAME',
  'ORION_RELEASE_SHA',
];
const REQUIRED_CONFIGURATION = [
  'ORION_APPLE_DEVELOPER_ID_CERTIFICATE_P12_BASE64',
  'ORION_APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD',
  'ORION_APPLE_DEVELOPER_ID_APPLICATION',
  'ORION_APPLE_TEAM_ID',
  'ORION_APPLE_NOTARY_KEY_P8_BASE64',
  'ORION_APPLE_NOTARY_KEY_ID',
  'ORION_APPLE_NOTARY_ISSUER_ID',
  'ORION_UPDATE_INDEX_PRIVATE_KEY_PEM_BASE64',
  'ORION_UPDATE_INDEX_KEY_ID',
  'ORION_CODE_SIDECAR_BUNDLE_ID',
  'ORION_RELEASE_ASSET_UPLOAD_BASE_URL',
  'ORION_RELEASE_PUBLIC_BASE_URL',
  'ORION_RELEASE_PUBLICATION_URL',
  'ORION_RELEASE_UPLOAD_TOKEN',
];

export function validateProtectedReleaseContext(environment, version) {
  const missing = REQUIRED_CONTEXT.filter(name => !environment[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`protected release context is missing: ${missing.join(', ')}.`);
  }
  if (environment.ORION_RELEASE_EVENT_NAME !== 'workflow_dispatch') {
    throw new Error('protected release gate requires workflow_dispatch.');
  }
  if (environment.ORION_RELEASE_REF_TYPE !== 'tag') {
    throw new Error('protected release gate requires dispatch from an exact Git tag.');
  }
  const expectedTag = `v${version}`;
  if (environment.ORION_RELEASE_REF_NAME !== expectedTag) {
    throw new Error(`protected release gate requires tag ${expectedTag}.`);
  }
  if (
    environment.ORION_RELEASE_REF_PROTECTED !== 'true' ||
    environment.ORION_RELEASE_ENVIRONMENT_NAME !== PROTECTED_ENVIRONMENT
  ) {
    throw new Error('protected release gate requires a protected ref and release environment.');
  }
  assertGitSha(environment.ORION_RELEASE_SHA);
  return {
    kind: 'orion.protected-release-context',
    status: 'PASS',
    tag: expectedTag,
    sha: environment.ORION_RELEASE_SHA,
  };
}

export function validateProtectedReleaseConfiguration(
  environment,
  version,
  { allowFixtureValues = false } = {}
) {
  const context = validateProtectedReleaseContext(environment, version);
  const missing = REQUIRED_CONFIGURATION.filter(name => !environment[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`protected release configuration is missing: ${missing.join(', ')}.`);
  }

  assertBoundedBase64(
    environment.ORION_APPLE_DEVELOPER_ID_CERTIFICATE_P12_BASE64,
    'ORION_APPLE_DEVELOPER_ID_CERTIFICATE_P12_BASE64',
    false
  );
  assertBoundedBase64(
    environment.ORION_APPLE_NOTARY_KEY_P8_BASE64,
    'ORION_APPLE_NOTARY_KEY_P8_BASE64',
    true
  );
  assertBoundedBase64(
    environment.ORION_UPDATE_INDEX_PRIVATE_KEY_PEM_BASE64,
    'ORION_UPDATE_INDEX_PRIVATE_KEY_PEM_BASE64',
    true
  );
  if (
    environment.ORION_APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD.length > 1024 ||
    /[\r\n\0]/.test(environment.ORION_APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD)
  ) {
    throw new Error('Developer ID certificate password has an invalid shape.');
  }
  if (!/^[A-Z0-9]{10}$/.test(environment.ORION_APPLE_TEAM_ID)) {
    throw new Error('ORION_APPLE_TEAM_ID has an invalid format.');
  }
  if (
    !environment.ORION_APPLE_DEVELOPER_ID_APPLICATION.startsWith('Developer ID Application: ') ||
    !environment.ORION_APPLE_DEVELOPER_ID_APPLICATION.endsWith(
      ` (${environment.ORION_APPLE_TEAM_ID})`
    ) ||
    environment.ORION_APPLE_DEVELOPER_ID_APPLICATION.length > 512
  ) {
    throw new Error('Developer ID Application identity does not match the configured Team ID.');
  }
  if (!/^[A-Z0-9]{10}$/.test(environment.ORION_APPLE_NOTARY_KEY_ID)) {
    throw new Error('ORION_APPLE_NOTARY_KEY_ID has an invalid format.');
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      environment.ORION_APPLE_NOTARY_ISSUER_ID
    )
  ) {
    throw new Error('ORION_APPLE_NOTARY_ISSUER_ID has an invalid format.');
  }
  if (
    !/^[A-Za-z0-9._-]{1,128}$/.test(environment.ORION_UPDATE_INDEX_KEY_ID) ||
    environment.ORION_UPDATE_INDEX_KEY_ID.startsWith('local-test-')
  ) {
    throw new Error('ORION_UPDATE_INDEX_KEY_ID must identify a non-test release key.');
  }
  assertProductionBundleIdentifier(environment.ORION_CODE_SIDECAR_BUNDLE_ID, {
    allowFixtureValues,
  });
  validateProductionUrl(
    environment.ORION_RELEASE_ASSET_UPLOAD_BASE_URL,
    'release asset upload base URL',
    { allowFixture: allowFixtureValues }
  );
  validateProductionUrl(environment.ORION_RELEASE_PUBLIC_BASE_URL, 'release public base URL', {
    allowFixture: allowFixtureValues,
  });
  validateProductionUrl(environment.ORION_RELEASE_PUBLICATION_URL, 'publication URL', {
    allowFixture: allowFixtureValues,
  });
  if (
    environment.ORION_RELEASE_UPLOAD_TOKEN.length < 32 ||
    environment.ORION_RELEASE_UPLOAD_TOKEN.length > 4096 ||
    /\s/.test(environment.ORION_RELEASE_UPLOAD_TOKEN)
  ) {
    throw new Error('ORION_RELEASE_UPLOAD_TOKEN has an invalid shape.');
  }
  return {
    kind: 'orion.protected-release-configuration',
    status: 'PASS',
    release_status: 'READY_FOR_PROTECTED_STEPS',
    tag: context.tag,
    sha: context.sha,
  };
}

export async function validateExactTaggedSource(
  environment,
  { runner = createFailClosedCommandRunner(), repositoryRoot = REPOSITORY_ROOT } = {}
) {
  const head = (
    await runner.run({
      label: 'release HEAD resolution',
      command: '/usr/bin/git',
      args: ['rev-parse', 'HEAD'],
      cwd: repositoryRoot,
    })
  ).stdout.trim();
  const status = (
    await runner.run({
      label: 'release worktree cleanliness check',
      command: '/usr/bin/git',
      args: ['status', '--porcelain=v1', '--untracked-files=all'],
      cwd: repositoryRoot,
    })
  ).stdout.trim();
  const tagSha = (
    await runner.run({
      label: 'release tag resolution',
      command: '/usr/bin/git',
      args: ['rev-parse', `refs/tags/${environment.ORION_RELEASE_REF_NAME}^{}`],
      cwd: repositoryRoot,
    })
  ).stdout.trim();
  if (
    status !== '' ||
    head !== environment.ORION_RELEASE_SHA ||
    tagSha !== environment.ORION_RELEASE_SHA
  ) {
    throw new Error('protected release source is not the clean exact tagged SHA.');
  }
  return { status: 'PASS', sha: head, tag: environment.ORION_RELEASE_REF_NAME };
}

export async function runProtectedReleasePreflight(environment = process.env, dependencies = {}) {
  const packageManifest = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8'));
  const configuration = validateProtectedReleaseConfiguration(
    environment,
    packageManifest.version,
    {
      allowFixtureValues: dependencies.allowFixtureValues === true,
    }
  );
  await validateExactTaggedSource(environment, dependencies);
  return configuration;
}

export function decodeProtectedBase64(environment, name, requirePem = false) {
  const value = environment[name];
  assertBoundedBase64(value, name, requirePem);
  return Buffer.from(value, 'base64');
}

function assertBoundedBase64(value, name, requirePem) {
  if (
    typeof value !== 'string' ||
    value.length > 2 * 1024 * 1024 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new Error(`${name} is not bounded base64.`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length < 32) throw new Error(`${name} is too short.`);
  if (requirePem && !decoded.toString('utf8').startsWith('-----BEGIN PRIVATE KEY-----')) {
    throw new Error(`${name} does not contain a PKCS#8 private key.`);
  }
}

export function assertProductionBundleIdentifier(value, { allowFixtureValues = false } = {}) {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > 255 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      value
    ) ||
    (/(?:^|\.)(?:invalid|example|test|fixture)$/.test(value) && !allowFixtureValues)
  ) {
    throw new Error('ORION_CODE_SIDECAR_BUNDLE_ID must be an explicit production identifier.');
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  await failClosedCli('orion.protected-release-preflight-error', async () => {
    if (process.argv.length !== 2) {
      throw new Error('protected release preflight accepts no command-line arguments.');
    }
    const result = await runProtectedReleasePreflight();
    process.stdout.write(
      `${JSON.stringify({
        kind: result.kind,
        status: result.status,
        release_status: result.release_status,
        tag: result.tag,
        sha: result.sha,
      })}\n`
    );
  });
}
