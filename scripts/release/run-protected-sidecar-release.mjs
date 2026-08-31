#!/usr/bin/env node

import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  decodeProtectedBase64,
  runProtectedReleasePreflight,
} from './protected-release-preflight.mjs';
import {
  createDarwinArchiveAdapter,
  createFailClosedCommandRunner,
  finalizeProductionDarwinSidecar,
  verifyProductionAcpSidecarReceipt,
  withTemporaryAppleSigningContext,
} from './production-sidecar-release.mjs';
import {
  createFetchPublisherTransport,
  publishProductionRelease,
  requiredReleaseAuthorization,
  validateProductionUrl,
} from './production-publisher.mjs';
import {
  assertRfc3339,
  ensureEmptyOutputDirectory,
  ensureRegularFile,
  failClosedCli,
} from './release-tooling-common.mjs';
import { generateUpdateIndex } from './update-index-release.mjs';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export async function runProtectedSidecarRelease(
  environment = process.env,
  {
    runner = createFailClosedCommandRunner(),
    archiveAdapter = createDarwinArchiveAdapter(),
    fetchImplementation = globalThis.fetch,
    publisherTransport = createFetchPublisherTransport(fetchImplementation),
    temporaryParent = environment.RUNNER_TEMP ?? tmpdir(),
  } = {}
) {
  await runProtectedReleasePreflight(environment, { runner, repositoryRoot: REPOSITORY_ROOT });
  const packageManifest = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8'));
  const releaseInputs = parseProtectedReleaseInputs(environment, packageManifest.version);
  assertBelowTemporaryRoot(releaseInputs.outputDirectory, temporaryParent, 'release output');
  ensureEmptyOutputDirectory(releaseInputs.outputDirectory);
  const candidateOutput = resolveRequiredPath(environment.ORION_RELEASE_UNSIGNED_OUTPUT_DIRECTORY);
  assertBelowTemporaryRoot(candidateOutput, temporaryParent, 'unsigned candidate');
  const unsignedReceiptPath = findUnsignedCandidateReceipt(candidateOutput);
  const operationRoot = mkdtempSync(join(temporaryParent, 'orion-protected-release-'));
  try {
    const indexPrivateKey = decodeProtectedBase64(
      environment,
      'ORION_UPDATE_INDEX_PRIVATE_KEY_PEM_BASE64',
      true
    );
    const productionSigning = {
      privateKeyPem: indexPrivateKey,
      keyId: environment.ORION_UPDATE_INDEX_KEY_ID,
    };
    const previousIndexPath = await resolvePreviousIndex(
      releaseInputs,
      operationRoot,
      fetchImplementation
    );
    const artifactOutput = join(releaseInputs.outputDirectory, 'artifact');
    const indexOutput = join(releaseInputs.outputDirectory, 'index');
    ensureEmptyOutputDirectory(artifactOutput);
    const certificateP12 = decodeProtectedBase64(
      environment,
      'ORION_APPLE_DEVELOPER_ID_CERTIFICATE_P12_BASE64'
    );
    const notaryPrivateKey = decodeProtectedBase64(
      environment,
      'ORION_APPLE_NOTARY_KEY_P8_BASE64',
      true
    );
    return await withTemporaryAppleSigningContext(
      {
        certificateP12,
        certificatePassword: environment.ORION_APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD,
        notaryPrivateKey,
      },
      async ({ keychainPath, notaryKeyPath }) => {
        const artifact = await finalizeProductionDarwinSidecar(
          {
            unsignedReceiptPath,
            outputDirectory: artifactOutput,
            bundleId: environment.ORION_CODE_SIDECAR_BUNDLE_ID,
            signingIdentity: environment.ORION_APPLE_DEVELOPER_ID_APPLICATION,
            teamId: environment.ORION_APPLE_TEAM_ID,
            keychainPath,
            notaryKeyPath,
            notaryKeyId: environment.ORION_APPLE_NOTARY_KEY_ID,
            notaryIssuerId: environment.ORION_APPLE_NOTARY_ISSUER_ID,
          },
          { runner, archiveAdapter, temporaryParent }
        );
        const productionReceiptVerifier = receiptPath =>
          verifyProductionAcpSidecarReceipt(receiptPath, undefined, {
            runner,
            archiveAdapter,
            expectedBundleId: environment.ORION_CODE_SIDECAR_BUNDLE_ID,
            expectedTeamId: environment.ORION_APPLE_TEAM_ID,
            expectedSigningIdentity: environment.ORION_APPLE_DEVELOPER_ID_APPLICATION,
            temporaryParent,
          });
        const index = await generateUpdateIndex({
          receipts: artifact.receiptPath,
          outputDirectory: indexOutput,
          previousIndex: previousIndexPath,
          sequence: releaseInputs.sequence,
          generatedAt: releaseInputs.generatedAt,
          expiresAt: releaseInputs.expiresAt,
          publishedAt: releaseInputs.publishedAt,
          channel: releaseInputs.channel,
          status: releaseInputs.status,
          studioVersionRequirement: releaseInputs.studioVersionRequirement,
          rolloutBasisPoints: releaseInputs.rolloutBasisPoints,
          rolloutSalt: releaseInputs.rolloutSalt,
          archiveBaseUrl: releaseInputs.publicBaseUrl,
          releaseNotesUrl: releaseInputs.releaseNotesUrl,
          rollbackTo: releaseInputs.rollbackTo,
          allowUnsignedFixture: false,
          dryRun: true,
          productionSigning,
          productionReceiptVerifier,
        });
        const context = protectedPublicationContext(environment);
        const authorization = environment.ORION_RELEASE_AUTHORIZATION?.trim() || undefined;
        const archiveFilename = artifact.receipt.artifact.filename;
        const receiptFilename = artifact.receiptPath.split('/').at(-1);
        const indexFilename = index.indexPath.split('/').at(-1);
        const signatureFilename = index.signaturePath.split('/').at(-1);
        const destinations = buildPublicationDestinations({
          uploadBaseUrl: environment.ORION_RELEASE_ASSET_UPLOAD_BASE_URL,
          publicBaseUrl: environment.ORION_RELEASE_PUBLIC_BASE_URL,
          publicationUrl: environment.ORION_RELEASE_PUBLICATION_URL,
          version: packageManifest.version,
          sequence: releaseInputs.sequence,
          archiveFilename,
          receiptFilename,
          indexFilename,
          signatureFilename,
        });
        const publication = await publishProductionRelease(
          {
            dryRun: authorization === undefined,
            authorization,
            context,
            token: environment.ORION_RELEASE_UPLOAD_TOKEN,
            artifacts: {
              archivePath: artifact.archivePath,
              receiptPath: artifact.receiptPath,
              indexPath: index.indexPath,
              signaturePath: index.signaturePath,
            },
            destinations,
          },
          {
            transport: publisherTransport,
            temporaryParent,
            verifyRemoteArchive: remoteArchivePath =>
              verifyProductionAcpSidecarReceipt(artifact.receiptPath, remoteArchivePath, {
                runner,
                archiveAdapter,
                expectedBundleId: environment.ORION_CODE_SIDECAR_BUNDLE_ID,
                expectedTeamId: environment.ORION_APPLE_TEAM_ID,
                expectedSigningIdentity: environment.ORION_APPLE_DEVELOPER_ID_APPLICATION,
                temporaryParent,
              }),
          }
        );
        return {
          status: publication.status,
          release_status: artifact.receipt.release_status,
          tag: context.refName,
          sha: context.sha,
          artifact: artifact.archivePath,
          receipt: artifact.receiptPath,
          index: index.indexPath,
          signature: index.signaturePath,
          index_sha256: index.indexSha256,
          required_authorization: requiredReleaseAuthorization(context),
          remote_archive_replay: publication.remote_archive_replay ?? 'NOT_RUN',
        };
      },
      { runner, temporaryParent }
    );
  } finally {
    rmSync(operationRoot, { recursive: true, force: true });
    rmSync(candidateOutput, { recursive: true, force: true });
  }
}

export function parseProtectedReleaseInputs(environment, version) {
  const sequence = parseInteger(environment.ORION_RELEASE_SEQUENCE, 1, Number.MAX_SAFE_INTEGER);
  const generatedAt = assertRfc3339(environment.ORION_RELEASE_GENERATED_AT, 'generated_at');
  const expiresAt = assertRfc3339(environment.ORION_RELEASE_EXPIRES_AT, 'expires_at');
  const publishedAt = assertRfc3339(environment.ORION_RELEASE_PUBLISHED_AT, 'published_at');
  if (Date.parse(expiresAt) <= Date.parse(generatedAt)) {
    throw new Error('release index expiry must follow generation time.');
  }
  const channel = environment.ORION_RELEASE_CHANNEL;
  const status = environment.ORION_RELEASE_STATUS;
  if (!['stable', 'beta'].includes(channel) || !['active', 'paused', 'revoked'].includes(status)) {
    throw new Error('release channel or status is invalid.');
  }
  const rolloutBasisPoints = parseInteger(
    environment.ORION_RELEASE_ROLLOUT_BASIS_POINTS,
    0,
    10_000
  );
  const rolloutSalt = environment.ORION_RELEASE_ROLLOUT_SALT;
  if (!/^[0-9A-Za-z._:-]{1,128}$/.test(rolloutSalt ?? '')) {
    throw new Error('release rollout salt is invalid.');
  }
  const studioVersionRequirement = environment.ORION_CODE_STUDIO_VERSION_REQUIREMENT;
  if (
    typeof studioVersionRequirement !== 'string' ||
    studioVersionRequirement.length === 0 ||
    studioVersionRequirement.includes('latest')
  ) {
    throw new Error('minimum Studio version requirement is missing or invalid.');
  }
  const releaseNotesUrl = validateProductionUrl(
    environment.ORION_RELEASE_NOTES_URL,
    'release notes URL'
  ).toString();
  const publicBaseUrl = validateProductionUrl(
    environment.ORION_RELEASE_PUBLIC_BASE_URL,
    'release public base URL'
  );
  const outputDirectory = resolveRequiredPath(environment.ORION_RELEASE_OUTPUT_DIRECTORY);
  const previousIndexUrl = environment.ORION_RELEASE_PREVIOUS_INDEX_URL?.trim()
    ? validateProductionUrl(
        environment.ORION_RELEASE_PREVIOUS_INDEX_URL,
        'previous index URL'
      ).toString()
    : undefined;
  if (sequence > 1 && !previousIndexUrl) {
    throw new Error('sequence greater than one requires the previous immutable index URL.');
  }
  if (sequence === 1 && previousIndexUrl) {
    throw new Error('sequence one must not claim a previous index.');
  }
  return {
    version,
    sequence,
    generatedAt,
    expiresAt,
    publishedAt,
    channel,
    status,
    rolloutBasisPoints,
    rolloutSalt,
    studioVersionRequirement,
    releaseNotesUrl,
    publicBaseUrl,
    outputDirectory,
    previousIndexUrl,
    rollbackTo: environment.ORION_RELEASE_ROLLBACK_TO?.trim() || undefined,
  };
}

export function buildPublicationDestinations({
  uploadBaseUrl,
  publicBaseUrl,
  publicationUrl,
  version,
  sequence,
  archiveFilename,
  receiptFilename,
  indexFilename,
  signatureFilename,
}) {
  const uploadBase = ensureTrailingSlash(validateProductionUrl(uploadBaseUrl, 'upload base URL'));
  const publicBase = ensureTrailingSlash(validateProductionUrl(publicBaseUrl, 'public base URL'));
  const versionPrefix = `${encodeURIComponent(version)}/`;
  const indexPrefix = `indexes/${sequence}/`;
  return {
    archiveUploadUrl: new URL(`${versionPrefix}${encodeURIComponent(archiveFilename)}`, uploadBase),
    archiveDownloadUrl: new URL(
      `${versionPrefix}${encodeURIComponent(archiveFilename)}`,
      publicBase
    ),
    receiptUploadUrl: new URL(`${versionPrefix}${encodeURIComponent(receiptFilename)}`, uploadBase),
    receiptDownloadUrl: new URL(
      `${versionPrefix}${encodeURIComponent(receiptFilename)}`,
      publicBase
    ),
    indexUploadUrl: new URL(`${indexPrefix}${encodeURIComponent(indexFilename)}`, uploadBase),
    indexDownloadUrl: new URL(`${indexPrefix}${encodeURIComponent(indexFilename)}`, publicBase),
    signatureUploadUrl: new URL(
      `${indexPrefix}${encodeURIComponent(signatureFilename)}`,
      uploadBase
    ),
    signatureDownloadUrl: new URL(
      `${indexPrefix}${encodeURIComponent(signatureFilename)}`,
      publicBase
    ),
    publicationUrl: validateProductionUrl(publicationUrl, 'publication URL'),
  };
}

function protectedPublicationContext(environment) {
  return {
    githubActions: environment.GITHUB_ACTIONS === 'true',
    eventName: environment.ORION_RELEASE_EVENT_NAME,
    refType: environment.ORION_RELEASE_REF_TYPE,
    refName: environment.ORION_RELEASE_REF_NAME,
    refProtected: environment.ORION_RELEASE_REF_PROTECTED === 'true',
    environmentName: environment.ORION_RELEASE_ENVIRONMENT_NAME,
    sha: environment.ORION_RELEASE_SHA,
  };
}

async function resolvePreviousIndex(inputs, temporaryDirectory, fetchImplementation) {
  if (!inputs.previousIndexUrl) return undefined;
  if (typeof fetchImplementation !== 'function') {
    throw new Error('previous index retrieval requires a fetch implementation.');
  }
  const response = await fetchImplementation(inputs.previousIndexUrl, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    redirect: 'error',
  });
  if (!response.ok) throw new Error('previous immutable update index could not be downloaded.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 1024 * 1024) {
    throw new Error('previous immutable update index has an invalid size.');
  }
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });
  const path = join(temporaryDirectory, 'previous-index.json');
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  return path;
}

function parseInteger(value, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`release integer must be within ${minimum}..=${maximum}.`);
  }
  return parsed;
}

function resolveRequiredPath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('protected release output directory is required.');
  }
  return resolve(value);
}

function findUnsignedCandidateReceipt(directory) {
  const metadata = lstatSync(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('unsigned candidate output must be a real directory.');
  }
  const canonicalDirectory = realpathSync(directory);
  const receipts = readdirSync(canonicalDirectory)
    .filter(name => name.endsWith('.receipt.json'))
    .sort();
  if (receipts.length !== 1) {
    throw new Error('unsigned candidate output must contain exactly one release receipt.');
  }
  const receiptPath = join(canonicalDirectory, receipts[0]);
  ensureRegularFile(receiptPath, 'unsigned candidate receipt');
  return receiptPath;
}

function assertBelowTemporaryRoot(path, temporaryParent, label) {
  const resolvedPath = resolve(path);
  const resolvedTemporaryParent = realpathSync(temporaryParent);
  const relation = relative(resolvedTemporaryParent, resolvedPath);
  if (
    relation === '' ||
    relation === '..' ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  ) {
    throw new Error(`${label} must be a dedicated directory below RUNNER_TEMP.`);
  }
}

function ensureTrailingSlash(url) {
  const copy = new URL(url.toString());
  if (!copy.pathname.endsWith('/')) copy.pathname += '/';
  return copy;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  await failClosedCli('orion.protected-sidecar-release-error', async () => {
    if (process.argv.length !== 2) {
      throw new Error('protected sidecar release accepts no command-line arguments.');
    }
    const result = await runProtectedSidecarRelease();
    process.stdout.write(
      `${JSON.stringify({ kind: 'orion.protected-sidecar-release', ...result })}\n`
    );
  });
}
