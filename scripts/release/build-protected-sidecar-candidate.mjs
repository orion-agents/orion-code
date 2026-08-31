#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAcpSidecar } from './acp-sidecar-release.mjs';
import {
  assertProductionBundleIdentifier,
  validateExactTaggedSource,
  validateProtectedReleaseContext,
} from './protected-release-preflight.mjs';
import { createFailClosedCommandRunner } from './production-sidecar-release.mjs';
import {
  ensureEmptyOutputDirectory,
  ensureRegularFile,
  failClosedCli,
} from './release-tooling-common.mjs';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FORBIDDEN_BUILD_SECRETS = [
  'ORION_APPLE_DEVELOPER_ID_CERTIFICATE_P12_BASE64',
  'ORION_APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD',
  'ORION_APPLE_NOTARY_KEY_P8_BASE64',
  'ORION_UPDATE_INDEX_PRIVATE_KEY_PEM_BASE64',
  'ORION_RELEASE_UPLOAD_TOKEN',
];

export async function buildProtectedSidecarCandidate(
  environment = process.env,
  { runner = createFailClosedCommandRunner() } = {}
) {
  const packageManifest = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8'));
  validateProtectedReleaseContext(environment, packageManifest.version);
  if (FORBIDDEN_BUILD_SECRETS.some(name => environment[name]?.trim())) {
    throw new Error(
      'unsigned build step must not receive signing, notarization, or upload secrets.'
    );
  }
  await validateExactTaggedSource(environment, { runner, repositoryRoot: REPOSITORY_ROOT });
  const bundleId = environment.ORION_CODE_SIDECAR_BUNDLE_ID;
  assertProductionBundleIdentifier(bundleId);
  const studioVersionRequirement = environment.ORION_CODE_STUDIO_VERSION_REQUIREMENT;
  if (
    typeof studioVersionRequirement !== 'string' ||
    studioVersionRequirement.length === 0 ||
    studioVersionRequirement.includes('latest')
  ) {
    throw new Error('minimum Studio version requirement is missing or invalid.');
  }
  const outputDirectory = resolveRequiredPath(environment.ORION_RELEASE_UNSIGNED_OUTPUT_DIRECTORY);
  ensureEmptyOutputDirectory(outputDirectory);
  const nodeLicense = findEmbeddedNodeLicense(process.execPath);
  const result = await buildAcpSidecar({
    version: packageManifest.version,
    gitSha: environment.ORION_RELEASE_SHA,
    target: 'darwin-aarch64',
    outputDirectory,
    nodeRuntime: process.execPath,
    nodeLicense,
    bundleId,
    studioVersionRequirement,
    localUnsigned: false,
    skipBuild: false,
    skipSmoke: false,
  });
  return {
    status: 'PASS',
    release_status: 'NOT_RELEASABLE',
    archive: result.archivePath,
    receipt: result.receiptPath,
    marker: result.markerPath,
  };
}

function findEmbeddedNodeLicense(nodeExecutable) {
  const runtimeRoot = dirname(dirname(nodeExecutable));
  const candidates = [join(runtimeRoot, 'LICENSE'), join(dirname(runtimeRoot), 'LICENSE')];
  for (const candidate of candidates) {
    try {
      ensureRegularFile(candidate, 'embedded Node license');
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error('embedded Node distribution LICENSE was not found.');
}

function resolveRequiredPath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('unsigned candidate output directory is required.');
  }
  return resolve(value);
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  await failClosedCli('orion.protected-sidecar-candidate-error', async () => {
    if (process.argv.length !== 2) {
      throw new Error('protected sidecar candidate builder accepts no command-line arguments.');
    }
    const result = await buildProtectedSidecarCandidate();
    process.stdout.write(
      `${JSON.stringify({ kind: 'orion.protected-sidecar-candidate', ...result })}\n`
    );
  });
}
