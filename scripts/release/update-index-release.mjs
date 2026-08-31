import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { verifyAcpSidecarReceipt } from './acp-sidecar-release.mjs';
import {
  PRODUCTION_RELEASE_STATUS,
  verifyProductionAcpSidecarReceipt,
} from './production-sidecar-release.mjs';
import {
  RELEASE_STATUS_NOT_RELEASABLE,
  assertExactSemver,
  assertRfc3339,
  assertSafeBasename,
  assertSafeRelativePath,
  canonicalJsonBytes,
  ensureEmptyOutputDirectory,
  ensurePrivateKeyFile,
  ensureRegularFile,
  hasFlag,
  optionalOption,
  parseCliArguments,
  readJsonFile,
  rejectUnknownOptions,
  requireOption,
  sha256Bytes,
  writeFileExclusive,
} from './release-tooling-common.mjs';

const INDEX_SCHEMA_VERSION = 1;
const SIGNATURE_SCHEMA_VERSION = 1;
const INDEX_FILENAME = 'orion-code-update-index-v1.json';
const SIGNATURE_FILENAME = 'orion-code-update-index-v1.json.sig';
const TEST_PUBLIC_KEY_FILENAME = 'orion-code-update-index-v1.test-public-key.json';
const MAX_INDEX_BYTES = 1024 * 1024;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_TEST_KEY_BYTES = 16 * 1024;
const DARWIN_SIDECAR_COMMAND = 'OrionCodeSidecar.app/Contents/MacOS/orion-code-acp';
const CHANNELS = new Set(['stable', 'beta']);
const STATUSES = new Set(['active', 'paused', 'revoked']);
const SAFE_STUDIO_REQUIREMENT = /^[0-9A-Za-z<>=.,*^~|+ -]{1,256}$/;

export function parseUpdateIndexArguments(argv) {
  const parsed = parseCliArguments(argv);
  const allowedValues = new Set([
    '--receipts',
    '--out',
    '--previous-index',
    '--sequence',
    '--generated-at',
    '--expires-at',
    '--published-at',
    '--channel',
    '--status',
    '--studio-version-requirement',
    '--rollout-basis-points',
    '--rollout-salt',
    '--archive-base-url',
    '--release-notes-url',
    '--rollback-to',
    '--test-private-key',
    '--test-key-id',
  ]);
  const allowedFlags = new Set(['--dry-run', '--allow-unsigned-fixture', '--help']);
  rejectUnknownOptions(parsed, allowedValues, allowedFlags);
  if (hasFlag(parsed, '--help')) return { help: true };
  const generatedAt = assertRfc3339(requireOption(parsed, '--generated-at'), 'generated_at');
  const publishedAtValue = optionalOption(parsed, '--published-at');
  const publishedAt = publishedAtValue
    ? assertRfc3339(publishedAtValue, 'published_at')
    : undefined;
  const expiresAt = assertRfc3339(requireOption(parsed, '--expires-at'), 'expires_at');
  if (Date.parse(expiresAt) <= Date.parse(generatedAt)) {
    throw new Error('expires_at must be later than generated_at.');
  }
  const channel = optionalOption(parsed, '--channel');
  if (channel !== undefined && !CHANNELS.has(channel)) {
    throw new Error('channel must be stable or beta.');
  }
  const status = requireOption(parsed, '--status');
  if (!STATUSES.has(status)) throw new Error('status must be active, paused, or revoked.');
  const rolloutBasisPoints = parseBoundedInteger(
    requireOption(parsed, '--rollout-basis-points'),
    0,
    10_000,
    'rollout basis points'
  );
  const rolloutSalt = optionalOption(parsed, '--rollout-salt');
  if (rolloutSalt !== undefined && !/^[0-9A-Za-z._:-]{1,128}$/.test(rolloutSalt)) {
    throw new Error('rollout salt is invalid.');
  }
  const studioVersionRequirement = optionalOption(parsed, '--studio-version-requirement');
  if (studioVersionRequirement !== undefined) {
    assertStudioVersionRequirement(studioVersionRequirement);
  }
  const previousIndex = optionalOption(parsed, '--previous-index');
  const sequenceValue = optionalOption(parsed, '--sequence');
  const testPrivateKey = optionalOption(parsed, '--test-private-key');
  const testKeyId = optionalOption(parsed, '--test-key-id');
  if ((testPrivateKey && !testKeyId) || (!testPrivateKey && testKeyId)) {
    throw new Error('--test-private-key and --test-key-id must be provided together.');
  }
  if (testKeyId && !/^local-test-[a-z0-9._-]{1,96}$/.test(testKeyId)) {
    throw new Error('test key ID must begin with local-test-.');
  }
  const allowUnsignedFixture = hasFlag(parsed, '--allow-unsigned-fixture');
  if (allowUnsignedFixture && !testPrivateKey) {
    throw new Error('unsigned fixture indexes require an explicit local test private key.');
  }
  return {
    help: false,
    receipts: resolve(requireOption(parsed, '--receipts')),
    outputDirectory: resolve(requireOption(parsed, '--out')),
    previousIndex: previousIndex ? resolve(previousIndex) : undefined,
    sequence: sequenceValue
      ? parseBoundedInteger(sequenceValue, 1, Number.MAX_SAFE_INTEGER, 'sequence')
      : undefined,
    generatedAt,
    expiresAt,
    publishedAt,
    channel,
    status,
    studioVersionRequirement,
    rolloutBasisPoints,
    rolloutSalt,
    archiveBaseUrl: optionalOption(parsed, '--archive-base-url')
      ? validateHttpsUrl(optionalOption(parsed, '--archive-base-url'), 'archive base URL')
      : undefined,
    releaseNotesUrl: optionalOption(parsed, '--release-notes-url')
      ? validateHttpsUrl(
          optionalOption(parsed, '--release-notes-url'),
          'release notes URL'
        ).toString()
      : undefined,
    rollbackTo: optionalOption(parsed, '--rollback-to'),
    testPrivateKey: testPrivateKey ? resolve(testPrivateKey) : undefined,
    testKeyId,
    allowUnsignedFixture,
    dryRun: true,
  };
}

export function updateIndexUsage() {
  return [
    'Usage: npm run release:update-index -- --receipts <file-or-directory> --out <empty-directory>',
    '  --generated-at <RFC3339> --expires-at <RFC3339>',
    '  --status <active|paused|revoked> --rollout-basis-points <0..10000>',
    '  [--previous-index <index.json>] [--sequence <positive-int>]',
    '  [--rollback-to <exact-semver>]',
    '',
    'Artifact admission additionally requires --channel, --studio-version-requirement,',
    '  --rollout-salt, --archive-base-url, and --release-notes-url.',
    '  [--published-at <RFC3339>] defaults to --generated-at for first admission.',
    'Policy transition for an existing immutable version requires --previous-index and the',
    '  original receipt/archive for replay; immutable release inputs may be omitted, but any',
    '  supplied value must exactly match the previous index. Sequence must increase.',
    'Allowed policy changes are rollout increase, active/paused transition, permanent revoke,',
    '  and adding a valid rollback_to while paused or revoked. Revocation cannot be undone.',
    '  [--allow-unsigned-fixture --test-private-key <local.pem> --test-key-id <local-test-id>]',
    '',
    'The generator is always a local dry run. It contains no upload or publish operation.',
  ].join('\n');
}

export async function generateUpdateIndex(options) {
  if (options.dryRun === false) throw new Error('this local generator cannot leave dry-run mode.');
  const production = options.productionSigning !== undefined;
  if (production && (options.allowUnsignedFixture || options.testPrivateKey || options.testKeyId)) {
    throw new Error('production index signing cannot use local fixture gates or test keys.');
  }
  validateGeneratorOptions(options);
  const previous = options.previousIndex ? readPreviousIndex(options.previousIndex) : undefined;
  const sequence = resolveNextSequence(previous, options.sequence);
  if (previous && Date.parse(options.generatedAt) <= Date.parse(previous.generated_at)) {
    throw new Error('generated_at must increase with a higher index sequence.');
  }
  const receiptPaths = collectReceiptPaths(options.receipts);
  if (receiptPaths.length === 0) throw new Error('no sidecar receipts were found.');
  const replayed = [];
  const receiptVerifier = production
    ? (options.productionReceiptVerifier ??
      (receiptPath =>
        verifyProductionAcpSidecarReceipt(
          receiptPath,
          undefined,
          options.productionReceiptVerification
        )))
    : verifyAcpSidecarReceipt;
  for (const receiptPath of receiptPaths) replayed.push(await receiptVerifier(receiptPath));
  for (const entry of replayed) {
    if (production) {
      if (
        entry.receipt.release_status !== PRODUCTION_RELEASE_STATUS ||
        entry.receipt.policy.releasable !== true ||
        entry.receipt.signing?.status !== 'developer_id' ||
        entry.receipt.signing?.notarization !== 'accepted'
      ) {
        throw new Error('production index accepts only final signed and notarized receipts.');
      }
      continue;
    }
    if (
      entry.receipt.release_status === RELEASE_STATUS_NOT_RELEASABLE ||
      entry.receipt.policy.releasable === false
    ) {
      if (!options.allowUnsignedFixture) {
        throw new Error(
          'NOT_RELEASABLE receipts require --allow-unsigned-fixture and a local test key.'
        );
      }
    }
  }
  if (options.allowUnsignedFixture && (!options.testPrivateKey || !options.testKeyId)) {
    throw new Error('unsigned fixture indexes require an explicit local test key.');
  }
  const versions = new Set(replayed.map(entry => entry.receipt.source.version));
  if (versions.size !== 1)
    throw new Error('one update-index invocation may contain only one exact version.');
  const [version] = versions;
  assertExactSemver(version, 'release version');
  const replayedTargets = new Map();
  const sourceSha = replayed[0].receipt.source.git_sha;
  for (const entry of replayed) {
    const receipt = entry.receipt;
    if (receipt.source.git_sha !== sourceSha) {
      throw new Error('all target receipts must bind the same source git SHA.');
    }
    const target = receipt.artifact.target;
    if (replayedTargets.has(target)) {
      throw new Error(`duplicate version/target receipt: ${version}/${target}`);
    }
    replayedTargets.set(target, {
      artifactFilename: receipt.artifact.filename,
      target: entry.indexTarget,
    });
  }

  const previousReleases = previous?.releases ?? [];
  assertNoDuplicateReleaseVersions(previousReleases);
  const previousRelease = previousReleases.find(release => release.version === version);
  const release = previousRelease
    ? evolveExistingRelease(previousRelease, replayedTargets, options)
    : createAdmittedRelease(version, replayedTargets, options);
  const releases = [
    ...previousReleases.filter(existing => existing.version !== version),
    release,
  ].sort((left, right) => left.version.localeCompare(right.version));
  assertNoDuplicateReleaseVersions(releases);
  assertRollbackSemantics(releases);
  const index = {
    schema_version: INDEX_SCHEMA_VERSION,
    sequence,
    generated_at: options.generatedAt,
    expires_at: options.expiresAt,
    releases,
  };
  const indexBytes = canonicalJsonBytes(index);
  if (indexBytes.length > MAX_INDEX_BYTES) throw new Error('generated update index exceeds 1 MiB.');

  ensureEmptyOutputDirectory(options.outputDirectory);
  const outputDirectory = realpathSync(options.outputDirectory);
  const indexPath = join(outputDirectory, INDEX_FILENAME);
  writeFileExclusive(indexPath, indexBytes);
  let signaturePath;
  let publicKeyPath;
  if (production) {
    const signing = signProductionIndexExactBytes(indexBytes, options.productionSigning);
    signaturePath = join(outputDirectory, SIGNATURE_FILENAME);
    writeFileExclusive(signaturePath, canonicalJsonBytes(signing.envelope));
  } else if (options.testPrivateKey) {
    const signing = signWithLocalTestKey(indexBytes, options.testPrivateKey, options.testKeyId);
    signaturePath = join(outputDirectory, SIGNATURE_FILENAME);
    publicKeyPath = join(outputDirectory, TEST_PUBLIC_KEY_FILENAME);
    writeFileExclusive(signaturePath, canonicalJsonBytes(signing.envelope));
    writeFileExclusive(publicKeyPath, canonicalJsonBytes(signing.publicKey));
  }
  let markerPath;
  if (!production) {
    markerPath = join(outputDirectory, 'NOT_RELEASABLE.txt');
    writeFileExclusive(
      markerPath,
      Buffer.from(
        'NOT RELEASABLE: local dry-run update index; any signature uses an untrusted local test key.\n',
        'utf8'
      )
    );
  }
  return {
    index,
    indexBytes,
    indexSha256: sha256Bytes(indexBytes),
    indexPath,
    signaturePath,
    publicKeyPath,
    markerPath,
    releaseStatus: production ? PRODUCTION_RELEASE_STATUS : RELEASE_STATUS_NOT_RELEASABLE,
  };
}

export function signProductionIndexExactBytes(indexBytes, productionSigning) {
  if (
    !Buffer.isBuffer(indexBytes) ||
    indexBytes.length === 0 ||
    indexBytes.length > MAX_INDEX_BYTES
  ) {
    throw new Error('production index bytes are empty or exceed 1 MiB.');
  }
  const keyId = productionSigning?.keyId;
  if (
    typeof keyId !== 'string' ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(keyId) ||
    keyId.startsWith('local-test-')
  ) {
    throw new Error('production index key ID must identify a protected non-test key.');
  }
  let privateKey;
  try {
    privateKey = createPrivateKey(productionSigning.privateKeyPem);
  } catch {
    throw new Error('protected update-index key is not a valid PKCS#8 private key.');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('protected update-index key must be Ed25519.');
  }
  const signature = sign(null, indexBytes, privateKey);
  const publicKey = createPublicKey(privateKey);
  if (signature.length !== 64 || !verify(null, indexBytes, publicKey, signature)) {
    throw new Error('production update-index signature self-verification failed.');
  }
  return {
    envelope: {
      schema_version: SIGNATURE_SCHEMA_VERSION,
      algorithm: 'ed25519',
      key_id: keyId,
      signature: signature.toString('base64'),
    },
    indexSha256: sha256Bytes(indexBytes),
  };
}

function resolveNextSequence(previous, requestedSequence) {
  const sequence = requestedSequence ?? (previous ? previous.sequence + 1 : 1);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new Error('index sequence is invalid.');
  }
  if (previous && sequence <= previous.sequence) {
    throw new Error(`index sequence must increase beyond previous sequence ${previous.sequence}.`);
  }
  return sequence;
}

function createAdmittedRelease(version, replayedTargets, options) {
  const channel = requireAdmissionOption(options.channel, '--channel');
  if (channel === 'stable' && version.includes('-')) {
    throw new Error('Stable channel cannot publish a prerelease semver.');
  }
  const studioVersionRequirement = requireAdmissionOption(
    options.studioVersionRequirement,
    '--studio-version-requirement'
  );
  const rolloutSalt = requireAdmissionOption(options.rolloutSalt, '--rollout-salt');
  const archiveBaseUrl = requireAdmissionOption(options.archiveBaseUrl, '--archive-base-url');
  const releaseNotesUrl = requireAdmissionOption(options.releaseNotesUrl, '--release-notes-url');
  const rollbackTo = normalizeRollbackTo(options.rollbackTo);
  assertRollbackState(version, options.status, rollbackTo);

  const targets = {};
  for (const [targetName, replayed] of [...replayedTargets.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    targets[targetName] = {
      ...replayed.target,
      archive_url: archiveUrlForReceipt(archiveBaseUrl, version, replayed.artifactFilename),
    };
  }
  return {
    version,
    channel,
    status: options.status,
    published_at: options.publishedAt ?? options.generatedAt,
    studio_version_requirement: studioVersionRequirement,
    acp_protocol: 1,
    rollout_basis_points: options.rolloutBasisPoints,
    rollout_salt: rolloutSalt,
    rollback_to: rollbackTo,
    release_notes_url: releaseNotesUrl,
    targets,
  };
}

function evolveExistingRelease(previousRelease, replayedTargets, options) {
  assertOptionalImmutable('channel', options.channel, previousRelease.channel);
  assertOptionalImmutable('published_at', options.publishedAt, previousRelease.published_at);
  assertOptionalImmutable(
    'studio_version_requirement',
    options.studioVersionRequirement,
    previousRelease.studio_version_requirement
  );
  assertOptionalImmutable('rollout_salt', options.rolloutSalt, previousRelease.rollout_salt);
  assertOptionalImmutable(
    'release_notes_url',
    options.releaseNotesUrl,
    previousRelease.release_notes_url
  );
  assertReplayedArtifactsUnchanged(previousRelease, replayedTargets, options.archiveBaseUrl);

  if (options.rolloutBasisPoints < previousRelease.rollout_basis_points) {
    throw new Error(`rollout cannot decrease for immutable release ${previousRelease.version}.`);
  }
  if (previousRelease.status === 'revoked' && options.status !== 'revoked') {
    throw new Error(`revoked release ${previousRelease.version} cannot be revived.`);
  }
  const rollbackTo =
    options.rollbackTo === undefined
      ? previousRelease.rollback_to
      : normalizeRollbackTo(options.rollbackTo);
  if (previousRelease.rollback_to !== null && rollbackTo !== previousRelease.rollback_to) {
    throw new Error(
      `rollback_to cannot change after release ${previousRelease.version} has authorized it.`
    );
  }
  assertRollbackState(previousRelease.version, options.status, rollbackTo);
  return {
    ...previousRelease,
    status: options.status,
    rollout_basis_points: options.rolloutBasisPoints,
    rollback_to: rollbackTo,
  };
}

function assertReplayedArtifactsUnchanged(previousRelease, replayedTargets, archiveBaseUrl) {
  const previousTargetNames = Object.keys(previousRelease.targets).sort();
  const replayedTargetNames = [...replayedTargets.keys()].sort();
  if (
    previousTargetNames.length !== replayedTargetNames.length ||
    previousTargetNames.some((target, index) => target !== replayedTargetNames[index])
  ) {
    throw new Error(
      `immutable artifact target set drifted for release ${previousRelease.version}.`
    );
  }
  const immutableFields = [
    'archive_bytes',
    'archive_sha256',
    'format',
    'command',
    'manifest_sha256',
    'sbom_sha256',
    'signing_requirement',
  ];
  for (const targetName of previousTargetNames) {
    const previousTarget = previousRelease.targets[targetName];
    const replayed = replayedTargets.get(targetName);
    for (const field of immutableFields) {
      if (previousTarget[field] !== replayed.target[field]) {
        throw new Error(
          `immutable artifact ${previousRelease.version}/${targetName} ${field} drifted after receipt replay.`
        );
      }
    }
    const previousUrl = new URL(previousTarget.archive_url);
    const previousFilename = decodeURIComponent(previousUrl.pathname.split('/').at(-1) ?? '');
    if (previousFilename !== replayed.artifactFilename) {
      throw new Error(
        `immutable artifact ${previousRelease.version}/${targetName} filename drifted after receipt replay.`
      );
    }
    if (
      archiveBaseUrl &&
      archiveUrlForReceipt(archiveBaseUrl, previousRelease.version, replayed.artifactFilename) !==
        previousTarget.archive_url
    ) {
      throw new Error(
        `immutable artifact ${previousRelease.version}/${targetName} archive_url drifted.`
      );
    }
  }
}

function requireAdmissionOption(value, optionName) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`${optionName} is required when admitting a new artifact version.`);
  }
  return value;
}

function assertOptionalImmutable(field, supplied, previous) {
  if (supplied !== undefined && supplied !== previous) {
    throw new Error(`immutable release field ${field} drifted during policy transition.`);
  }
}

function normalizeRollbackTo(value) {
  if (value === undefined || value === null) return null;
  return assertExactSemver(value, 'rollback_to');
}

function assertRollbackState(version, status, rollbackTo) {
  if (rollbackTo === version) throw new Error('rollback_to must differ from the source version.');
  if (rollbackTo && status === 'active') {
    throw new Error('rollback_to is allowed only for paused or revoked releases.');
  }
}

function archiveUrlForReceipt(archiveBaseUrl, version, artifactFilename) {
  return new URL(
    `${encodeURIComponent(version)}/${encodeURIComponent(artifactFilename)}`,
    ensureTrailingSlash(archiveBaseUrl)
  ).toString();
}

function collectReceiptPaths(path) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) throw new Error('receipts input must not be a symlink.');
  if (metadata.isFile()) {
    if (metadata.size > MAX_RECEIPT_BYTES) throw new Error('sidecar receipt exceeds 1 MiB.');
    return [realpathSync(path)];
  }
  if (!metadata.isDirectory()) throw new Error('receipts input must be a file or directory.');
  return readdirSync(path)
    .filter(name => name.endsWith('.receipt.json'))
    .sort()
    .map(name => {
      assertSafeBasename(name, 'receipt filename');
      const receiptPath = join(path, name);
      const receiptMetadata = ensureRegularFile(receiptPath, 'sidecar receipt');
      if (receiptMetadata.size > MAX_RECEIPT_BYTES)
        throw new Error('sidecar receipt exceeds 1 MiB.');
      return realpathSync(receiptPath);
    });
}

function readPreviousIndex(path) {
  const metadata = ensureRegularFile(path, 'previous update index');
  if (metadata.size > MAX_INDEX_BYTES) throw new Error('previous update index exceeds 1 MiB.');
  const index = readJsonFile(path, 'previous update index');
  const keys = Object.keys(index).sort().join(',');
  if (keys !== ['expires_at', 'generated_at', 'releases', 'schema_version', 'sequence'].join(',')) {
    throw new Error('previous update index has unsupported or missing fields.');
  }
  if (
    index.schema_version !== INDEX_SCHEMA_VERSION ||
    !Number.isSafeInteger(index.sequence) ||
    index.sequence <= 0 ||
    !Array.isArray(index.releases)
  ) {
    throw new Error('previous update index contract is invalid.');
  }
  assertRfc3339(index.generated_at, 'previous generated_at');
  assertRfc3339(index.expires_at, 'previous expires_at');
  assertNoDuplicateReleaseVersions(index.releases);
  assertRollbackSemantics(index.releases);
  return index;
}

function assertNoDuplicateReleaseVersions(releases) {
  const versions = new Set();
  for (const release of releases) {
    if (!release || typeof release !== 'object')
      throw new Error('index release must be an object.');
    const releaseKeys = Object.keys(release).sort().join(',');
    if (
      releaseKeys !==
      [
        'acp_protocol',
        'channel',
        'published_at',
        'release_notes_url',
        'rollback_to',
        'rollout_basis_points',
        'rollout_salt',
        'status',
        'studio_version_requirement',
        'targets',
        'version',
      ].join(',')
    ) {
      throw new Error('index release has unsupported or missing fields.');
    }
    const version = assertExactSemver(release.version, 'index release version');
    if (versions.has(version)) throw new Error(`duplicate release version ${version}.`);
    versions.add(version);
    if (!release.targets || typeof release.targets !== 'object' || Array.isArray(release.targets)) {
      throw new Error(`release ${version} targets are invalid.`);
    }
    const targets = Object.keys(release.targets);
    if (targets.length === 0 || new Set(targets).size !== targets.length) {
      throw new Error(`release ${version} target set is invalid.`);
    }
    if (
      !Number.isInteger(release.rollout_basis_points) ||
      release.rollout_basis_points < 0 ||
      release.rollout_basis_points > 10_000
    ) {
      throw new Error(`release ${version} rollout basis points are out of bounds.`);
    }
    if (!CHANNELS.has(release.channel) || !STATUSES.has(release.status)) {
      throw new Error(`release ${version} channel or status is invalid.`);
    }
    if (release.channel === 'stable' && version.includes('-')) {
      throw new Error(`Stable release ${version} must not be a prerelease.`);
    }
    assertRfc3339(release.published_at, `release ${version} published_at`);
    validateHttpsUrl(release.release_notes_url, `release ${version} release notes URL`);
    if (
      typeof release.rollout_salt !== 'string' ||
      !/^[0-9A-Za-z._:-]{1,128}$/.test(release.rollout_salt)
    ) {
      throw new Error(`release ${version} rollout salt is invalid.`);
    }
    if (
      typeof release.studio_version_requirement !== 'string' ||
      !SAFE_STUDIO_REQUIREMENT.test(release.studio_version_requirement)
    ) {
      throw new Error(`release ${version} Studio requirement is invalid.`);
    }
    if (release.acp_protocol !== 1) throw new Error(`release ${version} ACP protocol is invalid.`);
    if (release.rollback_to !== null) {
      assertExactSemver(release.rollback_to, `release ${version} rollback_to`);
      if (release.status === 'active') {
        throw new Error(`release ${version} active status cannot authorize rollback.`);
      }
    }
    for (const [target, artifact] of Object.entries(release.targets)) {
      validateExistingTarget(target, artifact, version);
    }
  }
}

function assertRollbackSemantics(releases) {
  const releasesByVersion = new Map(releases.map(release => [release.version, release]));
  for (const release of releases) {
    if (release.rollback_to === null) continue;
    const rollbackTarget = releasesByVersion.get(release.rollback_to);
    if (!rollbackTarget) {
      throw new Error(
        `release ${release.version} rollback_to must name a release in the same index.`
      );
    }
    if (compareSemver(rollbackTarget.version, release.version) >= 0) {
      throw new Error(`release ${release.version} rollback_to must be a strictly lower version.`);
    }
    if (rollbackTarget.status === 'revoked') {
      throw new Error(`release ${release.version} rollback_to must not target a revoked release.`);
    }
    const hasCompatibleTarget = Object.keys(release.targets).some(target =>
      Object.hasOwn(rollbackTarget.targets, target)
    );
    if (!hasCompatibleTarget) {
      throw new Error(`release ${release.version} rollback_to has no compatible artifact target.`);
    }
  }
}

function compareSemver(left, right) {
  const leftParts = semverPrecedenceParts(left);
  const rightParts = semverPrecedenceParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts.core[index] < rightParts.core[index]) return -1;
    if (leftParts.core[index] > rightParts.core[index]) return 1;
  }
  if (leftParts.prerelease.length === 0 && rightParts.prerelease.length === 0) return 0;
  if (leftParts.prerelease.length === 0) return 1;
  if (rightParts.prerelease.length === 0) return -1;
  const count = Math.max(leftParts.prerelease.length, rightParts.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const leftIdentifier = leftParts.prerelease[index];
    const rightIdentifier = rightParts.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftIdentifier) < BigInt(rightIdentifier) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

function semverPrecedenceParts(version) {
  assertExactSemver(version, 'release version');
  const withoutBuild = version.split('+', 1)[0];
  const separator = withoutBuild.indexOf('-');
  const core = separator < 0 ? withoutBuild : withoutBuild.slice(0, separator);
  const prerelease = separator < 0 ? '' : withoutBuild.slice(separator + 1);
  return {
    core: core.split('.').map(part => BigInt(part)),
    prerelease: prerelease ? prerelease.split('.') : [],
  };
}

function validateGeneratorOptions(options) {
  assertRfc3339(options.generatedAt, 'generated_at');
  assertRfc3339(options.expiresAt, 'expires_at');
  if (options.publishedAt !== undefined) {
    assertRfc3339(options.publishedAt, 'published_at');
  }
  if (Date.parse(options.expiresAt) <= Date.parse(options.generatedAt)) {
    throw new Error('expires_at must be later than generated_at.');
  }
  if (options.channel !== undefined && !CHANNELS.has(options.channel)) {
    throw new Error('channel is invalid.');
  }
  if (!STATUSES.has(options.status)) {
    throw new Error('status is invalid.');
  }
  if (
    !Number.isInteger(options.rolloutBasisPoints) ||
    options.rolloutBasisPoints < 0 ||
    options.rolloutBasisPoints > 10_000
  ) {
    throw new Error('rollout basis points must be an integer in 0..=10000.');
  }
  if (
    options.rolloutSalt !== undefined &&
    (typeof options.rolloutSalt !== 'string' ||
      !/^[0-9A-Za-z._:-]{1,128}$/.test(options.rolloutSalt))
  ) {
    throw new Error('rollout salt is invalid.');
  }
  if (options.studioVersionRequirement !== undefined) {
    assertStudioVersionRequirement(options.studioVersionRequirement);
  }
  if (options.archiveBaseUrl !== undefined) {
    validateHttpsUrl(options.archiveBaseUrl.toString(), 'archive base URL');
  }
  if (options.releaseNotesUrl !== undefined) {
    validateHttpsUrl(options.releaseNotesUrl, 'release notes URL');
  }
}

function validateExistingTarget(target, artifact, version) {
  if (!['darwin-aarch64', 'windows-x86_64', 'linux-x86_64', 'linux-aarch64'].includes(target)) {
    throw new Error(`release ${version} target name is invalid.`);
  }
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new Error(`release ${version}/${target} artifact is invalid.`);
  }
  const keys = Object.keys(artifact).sort().join(',');
  if (
    keys !==
    [
      'archive_bytes',
      'archive_sha256',
      'archive_url',
      'command',
      'format',
      'manifest_sha256',
      'sbom_sha256',
      'signing_requirement',
    ].join(',')
  ) {
    throw new Error(`release ${version}/${target} has unsupported or missing fields.`);
  }
  validateHttpsUrl(artifact.archive_url, `release ${version}/${target} archive URL`);
  if (
    !Number.isSafeInteger(artifact.archive_bytes) ||
    artifact.archive_bytes <= 0 ||
    artifact.archive_bytes > 2 * 1024 * 1024 * 1024
  ) {
    throw new Error(`release ${version}/${target} archive size is invalid.`);
  }
  for (const field of ['archive_sha256', 'manifest_sha256', 'sbom_sha256']) {
    if (!/^[0-9a-f]{64}$/.test(artifact[field])) {
      throw new Error(`release ${version}/${target} ${field} is invalid.`);
    }
  }
  if (artifact.format !== 'zip' || typeof artifact.command !== 'string') {
    throw new Error(`release ${version}/${target} archive contract is invalid.`);
  }
  assertSafeRelativePath(artifact.command, `release ${version}/${target} command`);
  if (target === 'darwin-aarch64' && artifact.command !== DARWIN_SIDECAR_COMMAND) {
    throw new Error(
      `release ${version}/${target} command must use the frozen app-like bundle layout.`
    );
  }
  const expectedSigning =
    target === 'darwin-aarch64'
      ? 'developer_id_and_notarized'
      : target === 'windows-x86_64'
        ? 'authenticode'
        : 'digest_only';
  if (artifact.signing_requirement !== expectedSigning) {
    throw new Error(`release ${version}/${target} signing requirement is invalid.`);
  }
}

function signWithLocalTestKey(indexBytes, keyPath, keyId) {
  if (!/^local-test-[a-z0-9._-]{1,96}$/.test(keyId ?? '')) {
    throw new Error('local test signing key ID is invalid.');
  }
  ensurePrivateKeyFile(keyPath);
  if (lstatSync(keyPath).size > MAX_TEST_KEY_BYTES)
    throw new Error('local test private key is too large.');
  const privateKey = createPrivateKey(readFileSync(keyPath));
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('local test private key must be Ed25519.');
  }
  const publicKey = createPublicKey(privateKey);
  const jwk = publicKey.export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new Error('local test public key export is invalid.');
  }
  const rawPublicKey = Buffer.from(jwk.x, 'base64url');
  if (rawPublicKey.length !== 32) throw new Error('local test Ed25519 public key is not 32 bytes.');
  return {
    envelope: {
      schema_version: SIGNATURE_SCHEMA_VERSION,
      algorithm: 'ed25519',
      key_id: keyId,
      signature: sign(null, indexBytes, privateKey).toString('base64'),
    },
    publicKey: {
      schema_version: 1,
      purpose: 'local_test_only',
      trusted_by_release_builds: false,
      key_id: keyId,
      algorithm: 'ed25519',
      public_key: rawPublicKey.toString('base64'),
    },
  };
}

function validateHttpsUrl(value, label) {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new Error(`${label} must be an absolute HTTPS URL.`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL.`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname
  ) {
    throw new Error(`${label} must be immutable HTTPS without credentials, query, or fragment.`);
  }
  return url;
}

function ensureTrailingSlash(url) {
  const copy = new URL(url.toString());
  if (!copy.pathname.endsWith('/')) copy.pathname += '/';
  return copy;
}

function assertStudioVersionRequirement(value) {
  if (
    typeof value !== 'string' ||
    !SAFE_STUDIO_REQUIREMENT.test(value) ||
    value.includes('latest')
  ) {
    throw new Error('Studio version requirement is invalid.');
  }
  return value;
}

function parseBoundedInteger(value, minimum, maximum, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer in ${minimum}..=${maximum}.`);
  }
  return parsed;
}
