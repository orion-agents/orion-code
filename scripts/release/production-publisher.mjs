import { chmodSync, createReadStream, mkdtempSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';

import {
  assertGitSha,
  canonicalJsonBytes,
  ensureRegularFile,
  sha256Bytes,
  sha256File,
} from './release-tooling-common.mjs';

const PROTECTED_ENVIRONMENT = 'orion-code-sidecar-release';
const MAX_REMOTE_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PUBLICATION_BYTES = 64 * 1024;

export function requiredReleaseAuthorization(context) {
  validateProtectedPublicationContext(context);
  return `publish:${context.refName}:${context.sha}`;
}

export function validateProtectedPublicationContext(context) {
  if (
    context.githubActions !== true ||
    context.eventName !== 'workflow_dispatch' ||
    context.refType !== 'tag' ||
    !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(context.refName) ||
    context.refProtected !== true ||
    context.environmentName !== PROTECTED_ENVIRONMENT
  ) {
    throw new Error('publication requires a protected tag dispatch and release environment.');
  }
  assertGitSha(context.sha);
  return context;
}

export function createFetchPublisherTransport(fetchImplementation = globalThis.fetch) {
  if (typeof fetchImplementation !== 'function') {
    throw new Error('publisher requires a fetch implementation.');
  }
  return {
    async putFile({ url, path, token, contentType }) {
      ensureRegularFile(path, 'publisher input');
      const response = await fetchImplementation(url, {
        method: 'PUT',
        headers: releaseHeaders(token, contentType),
        body: Readable.toWeb(createReadStream(path)),
        duplex: 'half',
        redirect: 'error',
      });
      if (!response.ok) throw new Error('immutable release asset upload failed.');
    },
    async putBytes({ url, bytes, token, contentType }) {
      if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_PUBLICATION_BYTES) {
        throw new Error('publication payload has an invalid size.');
      }
      const response = await fetchImplementation(url, {
        method: 'PUT',
        headers: releaseHeaders(token, contentType),
        body: bytes,
        redirect: 'error',
      });
      if (!response.ok) throw new Error('release publication commit failed.');
    },
    async getFile({ url, destination, maxBytes = MAX_REMOTE_ARCHIVE_BYTES }) {
      const response = await fetchImplementation(url, {
        method: 'GET',
        headers: { Accept: 'application/octet-stream' },
        redirect: 'error',
      });
      if (!response.ok || !response.body) {
        throw new Error('published release asset could not be downloaded for replay.');
      }
      const declaredLength = response.headers.get('content-length');
      if (declaredLength && Number(declaredLength) > maxBytes) {
        throw new Error('published release asset exceeds its byte limit.');
      }
      const output = await open(destination, 'wx', 0o600);
      let observed = 0;
      try {
        for await (const chunk of response.body) {
          const bytes = Buffer.from(chunk);
          observed += bytes.length;
          if (observed > maxBytes) {
            throw new Error('published release asset exceeds its byte limit.');
          }
          await output.write(bytes);
        }
        await output.sync();
      } finally {
        await output.close();
      }
      return { bytes: observed };
    },
  };
}

export async function publishProductionRelease(
  { dryRun = true, authorization, context, token, artifacts, destinations },
  {
    transport = createFetchPublisherTransport(),
    temporaryParent = tmpdir(),
    verifyRemoteArchive,
    allowFixtureUrls = false,
  } = {}
) {
  validateProtectedPublicationContext(context);
  const paths = validatePublicationArtifacts(artifacts);
  const urls = validatePublicationDestinations(destinations, { allowFixtureUrls });
  const digests = {
    archive: await sha256File(paths.archivePath),
    receipt: await sha256File(paths.receiptPath),
    index: await sha256File(paths.indexPath),
    signature: await sha256File(paths.signaturePath),
  };
  const expectedAuthorization = requiredReleaseAuthorization(context);
  if (dryRun) {
    return {
      status: 'DRY_RUN',
      required_authorization: expectedAuthorization,
      archive_sha256: digests.archive.sha256,
      index_sha256: digests.index.sha256,
      external_actions: ['NOT_UPLOADED', 'NOT_PUBLISHED'],
    };
  }
  if (authorization !== expectedAuthorization) {
    throw new Error('release authorization did not exactly match the protected tag and SHA.');
  }
  if (typeof token !== 'string' || token.length < 32 || token.length > 4096 || /\s/.test(token)) {
    throw new Error('release upload token is missing or malformed.');
  }

  await transport.putFile({
    url: urls.archiveUploadUrl,
    path: paths.archivePath,
    token,
    contentType: 'application/zip',
  });
  const remoteDirectory = await createPrivateTemporaryDirectory(
    temporaryParent,
    'orion-remote-release-replay-'
  );
  const remoteArchivePath = join(remoteDirectory.path, basename(paths.archivePath));
  try {
    await transport.getFile({
      url: urls.archiveDownloadUrl,
      destination: remoteArchivePath,
      maxBytes: Math.min(MAX_REMOTE_ARCHIVE_BYTES, digests.archive.bytes + 1),
    });
    const remoteDigest = await sha256File(remoteArchivePath);
    if (
      remoteDigest.bytes !== digests.archive.bytes ||
      remoteDigest.sha256 !== digests.archive.sha256
    ) {
      throw new Error('remote archive SHA-256 did not match the final local bytes.');
    }
    if (verifyRemoteArchive) await verifyRemoteArchive(remoteArchivePath);
  } finally {
    remoteDirectory.remove();
  }

  await transport.putFile({
    url: urls.receiptUploadUrl,
    path: paths.receiptPath,
    token,
    contentType: 'application/json',
  });
  await transport.putFile({
    url: urls.indexUploadUrl,
    path: paths.indexPath,
    token,
    contentType: 'application/json',
  });
  await transport.putFile({
    url: urls.signatureUploadUrl,
    path: paths.signaturePath,
    token,
    contentType: 'application/json',
  });
  const publication = canonicalJsonBytes({
    schema_version: 1,
    kind: 'orion-code-update-publication',
    source: { tag: context.refName, git_sha: context.sha },
    archive: {
      url: urls.archiveDownloadUrl.toString(),
      bytes: digests.archive.bytes,
      sha256: digests.archive.sha256,
    },
    receipt: {
      url: urls.receiptDownloadUrl.toString(),
      sha256: digests.receipt.sha256,
    },
    index: {
      url: urls.indexDownloadUrl.toString(),
      sha256: digests.index.sha256,
    },
    signature: {
      url: urls.signatureDownloadUrl.toString(),
      sha256: digests.signature.sha256,
    },
  });
  await transport.putBytes({
    url: urls.publicationUrl,
    bytes: publication,
    token,
    contentType: 'application/json',
  });
  return {
    status: 'PUBLISHED',
    archive_sha256: digests.archive.sha256,
    index_sha256: digests.index.sha256,
    publication_sha256: sha256Bytes(publication),
    remote_archive_replay: 'PASS',
  };
}

function validatePublicationArtifacts(artifacts) {
  const paths = {
    archivePath: artifacts.archivePath,
    receiptPath: artifacts.receiptPath,
    indexPath: artifacts.indexPath,
    signaturePath: artifacts.signaturePath,
  };
  for (const [name, path] of Object.entries(paths)) {
    const metadata = ensureRegularFile(path, name);
    if (metadata.size <= 0) throw new Error(`${name} must not be empty.`);
  }
  return paths;
}

function validatePublicationDestinations(destinations, { allowFixtureUrls = false } = {}) {
  const urls = {};
  for (const name of [
    'archiveUploadUrl',
    'archiveDownloadUrl',
    'receiptUploadUrl',
    'receiptDownloadUrl',
    'indexUploadUrl',
    'indexDownloadUrl',
    'signatureUploadUrl',
    'signatureDownloadUrl',
    'publicationUrl',
  ]) {
    urls[name] = validateProductionUrl(destinations[name], name, {
      allowFixture: allowFixtureUrls,
    });
  }
  if (urls.archiveUploadUrl.toString() === urls.publicationUrl.toString()) {
    throw new Error('asset and publication destinations must be distinct.');
  }
  return urls;
}

export function validateProductionUrl(value, label = 'release URL', { allowFixture = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute production HTTPS URL.`);
  }
  const hostname = url.hostname.toLowerCase();
  const placeholderHostname =
    hostname.endsWith('.invalid') ||
    hostname.endsWith('.test') ||
    hostname === 'example.com' ||
    hostname.endsWith('.example.com');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    (placeholderHostname && !allowFixture)
  ) {
    throw new Error(`${label} must be an immutable production HTTPS URL.`);
  }
  return url;
}

function releaseHeaders(token, contentType) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 4096 || /\s/.test(token)) {
    throw new Error('release upload token is missing or malformed.');
  }
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': contentType,
    'If-None-Match': '*',
  };
}

async function createPrivateTemporaryDirectory(parent, prefix) {
  const path = mkdtempSync(join(parent, prefix));
  chmodSync(path, 0o700);
  return {
    path,
    remove() {
      rmSync(path, { recursive: true, force: true });
    },
  };
}
