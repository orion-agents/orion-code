import assert from 'node:assert/strict';
import { generateKeyPairSync, verify as verifySignature } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  buildAcpSidecar,
  parseBuildAcpSidecarArguments,
  verifyAcpSidecarReceipt,
} from '../acp-sidecar-release.mjs';
import { verifyDeterministicZip } from '../deterministic-zip.mjs';
import { assertNoReceiptBinding, canonicalJsonBytes } from '../release-tooling-common.mjs';
import {
  generateUpdateIndex,
  parseUpdateIndexArguments,
  updateIndexUsage,
} from '../update-index-release.mjs';

const TEST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURES = join(TEST_ROOT, 'tests', 'fixtures', 'release');
const VERSION = '0.3.2';
const GIT_SHA = '0123456789abcdef0123456789abcdef01234567';
const SOURCE_DATE_EPOCH = 1_788_134_400;

test('builder requires exact release inputs and explicit embedded runtime', () => {
  assert.throws(
    () =>
      parseBuildAcpSidecarArguments([
        '--version',
        VERSION,
        '--git-sha',
        GIT_SHA,
        '--target',
        'darwin-aarch64',
        '--out',
        '/tmp/output',
        '--node-license',
        '/tmp/LICENSE',
        '--studio-version-requirement',
        '>=0.1.0,<0.2.0',
      ]),
    /--node-runtime is required/
  );
  assert.throws(
    () =>
      parseBuildAcpSidecarArguments([
        '--version',
        'latest',
        '--git-sha',
        GIT_SHA,
        '--target',
        'darwin-aarch64',
        '--out',
        '/tmp/output',
        '--node-runtime',
        '/tmp/node',
        '--node-license',
        '/tmp/LICENSE',
        '--studio-version-requirement',
        '>=0.1.0,<0.2.0',
      ]),
    /exact semver/
  );
  assert.throws(
    () =>
      parseBuildAcpSidecarArguments([
        '--version',
        VERSION,
        '--git-sha',
        GIT_SHA,
        '--target',
        'darwin-aarch64',
        '--out',
        '/tmp/output',
        '--node-runtime',
        '/tmp/node',
        '--node-license',
        '/tmp/LICENSE',
        '--studio-version-requirement',
        '>=0.1.0,<0.2.0',
      ]),
    /--bundle-id is required/
  );
  assert.throws(
    () =>
      parseBuildAcpSidecarArguments([
        '--version',
        VERSION,
        '--git-sha',
        GIT_SHA,
        '--target',
        'darwin-aarch64',
        '--out',
        '/tmp/output',
        '--node-runtime',
        '/tmp/node',
        '--node-license',
        '/tmp/LICENSE',
        '--bundle-id',
        'Orion Code Sidecar',
        '--studio-version-requirement',
        '>=0.1.0,<0.2.0',
      ]),
    /lowercase reverse-DNS/
  );
});

test('dirty source is accepted only as an explicit NOT RELEASABLE local candidate', async t => {
  const fixture = createFixture(t);
  await assert.rejects(
    buildFixtureCandidate(fixture, { localUnsigned: false }),
    /dirty source may only build/
  );
  const candidate = await buildFixtureCandidate(fixture, { localUnsigned: true });
  assert.equal(candidate.receipt.release_status, 'NOT_RELEASABLE');
  assert.equal(candidate.receipt.policy.releasable, false);
  assert.deepEqual(candidate.receipt.policy.reasons, ['dirty_source', 'unsigned', 'not_notarized']);
  assert.match(readFileSync(candidate.markerPath, 'utf8'), /NOT RELEASABLE/);
});

test('builder rejects package metadata that drifted from the exact shrinkwrap', async t => {
  const fixture = createFixture(t);
  const lockPath = join(fixture.packageRoot, 'npm-shrinkwrap.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  lock.packages[''].dependencies = { unexpected: '1.0.0' };
  writeFileSync(lockPath, canonicalJsonBytes(lock));
  await assert.rejects(buildFixtureCandidate(fixture), /dependencies does not exactly match/);
});

test('archive bytes and external receipt are deterministic and never form a receipt cycle', async t => {
  const firstFixture = createFixture(t);
  const secondFixture = createFixture(t);
  const first = await buildFixtureCandidate(firstFixture);
  const second = await buildFixtureCandidate(secondFixture);
  assert.deepEqual(readFileSync(first.archivePath), readFileSync(second.archivePath));
  assert.deepEqual(readFileSync(first.receiptPath), readFileSync(second.receiptPath));

  const replay = await verifyAcpSidecarReceipt(first.receiptPath);
  const layout = loadDarwinLayout();
  assertClosedSchemaKeys(
    replay.manifest,
    JSON.parse(
      readFileSync(
        join(
          TEST_ROOT,
          'docs',
          'architecture',
          'orion-code-update-v1',
          'artifact-manifest-v1.schema.json'
        ),
        'utf8'
      )
    )
  );
  assertNoReceiptBinding(replay.manifest);
  assert.doesNotMatch(JSON.stringify(replay.manifest), /receipt/i);
  assert.equal(Object.hasOwn(replay.manifest, 'archive_sha256'), false);
  assert.equal(replay.manifest.node_version, '24.14.0');
  assert.equal(replay.manifest.command, layout.command);
  assert.equal(replay.receipt.artifact.command, layout.command);
  assert.equal(replay.receipt.artifact.bundle_id, layout.bundle_id);
  assert.deepEqual(Object.keys(replay.receipt.bindings).sort(), [
    'archive_sha256',
    'manifest_sha256',
    'notices_sha256',
    'sbom_sha256',
  ]);
  const archiveEntries = replay.manifest.files.map(file => file.path);
  for (const path of [
    layout.command,
    layout.info_plist,
    layout.node_license,
    layout.node_runtime,
  ]) {
    assert.equal(archiveEntries.includes(path), true, `missing app-bundle fixture path ${path}`);
  }
  assert.equal(
    archiveEntries.some(path => path.startsWith(`${layout.application_root}/`)),
    true
  );
  assert.equal(archiveEntries.includes('bin/orion-code-acp'), false);
  assert.equal(archiveEntries.includes('runtime/node'), false);
  assert.ok(lstatSync(first.archivePath).size < 1024 * 1024);
  const archive = await verifyDeterministicZip(first.archivePath, {
    selectedEntries: [`${replay.receipt.artifact.archive_root}/${layout.info_plist}`],
  });
  const infoPlist = archive.selectedBytes
    .get(`${replay.receipt.artifact.archive_root}/${layout.info_plist}`)
    .toString('utf8');
  assert.match(infoPlist, new RegExp(`<string>${layout.bundle_id}</string>`));
  assert.match(infoPlist, /<key>CFBundleExecutable<\/key>\n  <string>orion-code-acp<\/string>/);
  const manifestSchema = JSON.parse(
    readFileSync(
      join(
        TEST_ROOT,
        'docs',
        'architecture',
        'orion-code-update-v1',
        'artifact-manifest-v1.schema.json'
      ),
      'utf8'
    )
  );
  const goldenIndex = JSON.parse(
    readFileSync(
      join(TEST_ROOT, 'docs', 'architecture', 'orion-code-update-v1', 'golden', 'valid-index.json'),
      'utf8'
    )
  );
  assert.match(layout.command, new RegExp(manifestSchema.definitions.relativeArtifactPath.pattern));
  assert.equal(goldenIndex.releases[0].targets['darwin-aarch64'].command, layout.command);
  assert.equal(
    archiveEntries.some(path => path.endsWith('.map')),
    false
  );
  assert.equal(
    archiveEntries.some(path => path.toLowerCase().includes('.env')),
    false
  );
  assert.equal(
    readFileSync(first.archivePath).includes(Buffer.from(firstFixture.packageRoot)),
    false
  );
});

test('replay recomputes all four external bindings from final bytes', async t => {
  const fixture = createFixture(t);
  const candidate = await buildFixtureCandidate(fixture);
  for (const binding of ['archive_sha256', 'manifest_sha256', 'sbom_sha256', 'notices_sha256']) {
    const replayRoot = join(fixture.root, `tampered-${binding}`);
    mkdirSync(replayRoot, { recursive: true });
    const receipt = JSON.parse(readFileSync(candidate.receiptPath, 'utf8'));
    receipt.bindings[binding] = 'f'.repeat(64);
    const receiptPath = join(replayRoot, 'candidate.receipt.json');
    const archivePath = join(replayRoot, receipt.artifact.filename);
    writeFileSync(receiptPath, canonicalJsonBytes(receipt), { mode: 0o600 });
    copyFileSync(candidate.archivePath, archivePath);
    await assert.rejects(
      verifyAcpSidecarReceipt(receiptPath),
      new RegExp(binding.split('_')[0], 'i')
    );
  }
});

test('replay rejects final archive byte tampering', async t => {
  const fixture = createFixture(t);
  const candidate = await buildFixtureCandidate(fixture);
  const replayRoot = join(fixture.root, 'tampered-archive');
  mkdirSync(replayRoot, { recursive: true });
  const receipt = JSON.parse(readFileSync(candidate.receiptPath, 'utf8'));
  const receiptPath = join(replayRoot, 'candidate.receipt.json');
  const archivePath = join(replayRoot, receipt.artifact.filename);
  const archive = readFileSync(candidate.archivePath);
  archive[Math.floor(archive.length / 2)] ^= 0x01;
  writeFileSync(receiptPath, canonicalJsonBytes(receipt), { mode: 0o600 });
  writeFileSync(archivePath, archive, { mode: 0o600 });
  await assert.rejects(verifyAcpSidecarReceipt(receiptPath), /mismatch|invalid|malformed|drifted/i);
});

test('manifest receipt fields are rejected explicitly', () => {
  const malicious = JSON.parse(
    readFileSync(join(FIXTURES, 'manifest-with-receipt-digest.json'), 'utf8')
  );
  assert.throws(() => assertNoReceiptBinding(malicious), /must not contain receipt field/);
});

test('dependency .env and symlink entries fail closed', async t => {
  const secretFixture = createFixture(t, { dependency: true, dependencyEnv: true });
  await assert.rejects(buildFixtureCandidate(secretFixture), /secret-like path/);

  const symlinkFixture = createFixture(t, { dependency: true, dependencySymlink: true });
  await assert.rejects(buildFixtureCandidate(symlinkFixture), /symlink/);
});

test('source maps and their absolute paths are excluded from archive bytes', async t => {
  const fixture = createFixture(t, { sourceMap: true });
  const candidate = await buildFixtureCandidate(fixture);
  const receipt = JSON.parse(readFileSync(candidate.receiptPath, 'utf8'));
  const verified = await verifyDeterministicZip(candidate.archivePath);
  assert.equal(
    verified.entries.some(entry => entry.path.endsWith('.map')),
    false
  );
  assert.equal(
    verified.entries.some(entry => entry.path.includes(receipt.artifact.archive_root) === false),
    false
  );
});

test('update index is deterministic and its local Ed25519 signature covers exact bytes', async t => {
  const fixture = createFixture(t);
  const candidate = await buildFixtureCandidate(fixture);
  const key = createLocalTestKey(fixture.root);
  const indexOptions = loadIndexOptions();
  const firstOutput = join(fixture.root, 'index-first');
  const secondOutput = join(fixture.root, 'index-second');
  const common = {
    receipts: candidate.receiptPath,
    previousIndex: undefined,
    sequence: indexOptions.sequence,
    generatedAt: indexOptions.generated_at,
    expiresAt: indexOptions.expires_at,
    publishedAt: indexOptions.published_at,
    channel: indexOptions.channel,
    status: indexOptions.status,
    studioVersionRequirement: indexOptions.studio_version_requirement,
    rolloutBasisPoints: indexOptions.rollout_basis_points,
    rolloutSalt: indexOptions.rollout_salt,
    archiveBaseUrl: new URL(indexOptions.archive_base_url),
    releaseNotesUrl: indexOptions.release_notes_url,
    rollbackTo: undefined,
    testPrivateKey: key.privateKeyPath,
    testKeyId: 'local-test-release-tooling',
    allowUnsignedFixture: true,
    dryRun: true,
  };
  const first = await generateUpdateIndex({ ...common, outputDirectory: firstOutput });
  const second = await generateUpdateIndex({ ...common, outputDirectory: secondOutput });
  assert.deepEqual(first.indexBytes, second.indexBytes);
  assert.deepEqual(readFileSync(first.signaturePath), readFileSync(second.signaturePath));
  const envelope = JSON.parse(readFileSync(first.signaturePath, 'utf8'));
  const indexSchema = JSON.parse(
    readFileSync(
      join(
        TEST_ROOT,
        'docs',
        'architecture',
        'orion-code-update-v1',
        'update-index-v1.schema.json'
      ),
      'utf8'
    )
  );
  assertClosedSchemaKeys(first.index, indexSchema);
  assertClosedSchemaKeys(first.index.releases[0], indexSchema.definitions.release);
  assertClosedSchemaKeys(
    first.index.releases[0].targets['darwin-aarch64'],
    indexSchema.definitions.target
  );
  assertClosedSchemaKeys(
    envelope,
    JSON.parse(
      readFileSync(
        join(
          TEST_ROOT,
          'docs',
          'architecture',
          'orion-code-update-v1',
          'signature-envelope-v1.schema.json'
        ),
        'utf8'
      )
    )
  );
  assert.equal(
    verifySignature(
      null,
      first.indexBytes,
      key.publicKey,
      Buffer.from(envelope.signature, 'base64')
    ),
    true
  );
  const tampered = Buffer.from(first.indexBytes);
  tampered[0] ^= 0x01;
  assert.equal(
    verifySignature(null, tampered, key.publicKey, Buffer.from(envelope.signature, 'base64')),
    false
  );
  assert.match(readFileSync(first.markerPath, 'utf8'), /NOT RELEASABLE/);
  assert.equal(envelope.key_id.startsWith('local-test-'), true);

  await assert.rejects(
    generateUpdateIndex({
      ...common,
      outputDirectory: join(fixture.root, 'index-invalid-rollback'),
      rollbackTo: '0.3.1',
    }),
    /rollback_to is allowed only for paused or revoked/
  );

  const previousIndexPath = join(fixture.root, 'previous-index.json');
  writeFileSync(
    previousIndexPath,
    canonicalJsonBytes({
      schema_version: 1,
      sequence: 6,
      generated_at: '2026-08-30T00:00:00.000Z',
      expires_at: '2026-09-06T00:00:00.000Z',
      releases: [],
    })
  );
  const next = await generateUpdateIndex({
    ...common,
    outputDirectory: join(fixture.root, 'index-next-sequence'),
    previousIndex: previousIndexPath,
    sequence: undefined,
  });
  assert.equal(next.index.sequence, 7);
});

test('one replayed artifact advances monotonically through rollout pause resume and revoke', async t => {
  const fixture = createFixture(t);
  const candidate = await buildFixtureCandidate(fixture);
  const originalArchiveBytes = readFileSync(candidate.archivePath);
  const key = createLocalTestKey(fixture.root, 'policy-key.pem');
  const indexOptions = loadIndexOptions();
  const previousIndex = writeRollbackSeedIndex(fixture.root);
  const common = {
    receipts: candidate.receiptPath,
    testPrivateKey: key.privateKeyPath,
    testKeyId: 'local-test-policy-progression',
    allowUnsignedFixture: true,
    dryRun: true,
  };
  const fivePercent = await generateUpdateIndex({
    ...common,
    previousIndex,
    sequence: 7,
    outputDirectory: join(fixture.root, 'policy-05'),
    generatedAt: indexOptions.generated_at,
    expiresAt: indexOptions.expires_at,
    publishedAt: indexOptions.published_at,
    channel: indexOptions.channel,
    status: 'active',
    studioVersionRequirement: indexOptions.studio_version_requirement,
    rolloutBasisPoints: 500,
    rolloutSalt: indexOptions.rollout_salt,
    archiveBaseUrl: new URL(indexOptions.archive_base_url),
    releaseNotesUrl: indexOptions.release_notes_url,
  });
  const transition = (previous, name, generatedAt, expiresAt, status, rollout, rollbackTo) =>
    generateUpdateIndex({
      ...common,
      previousIndex: previous.indexPath,
      sequence: previous.index.sequence + 1,
      outputDirectory: join(fixture.root, `policy-${name}`),
      generatedAt,
      expiresAt,
      status,
      rolloutBasisPoints: rollout,
      rollbackTo,
    });
  const twentyFivePercent = await transition(
    fivePercent,
    '25',
    '2026-09-01T00:00:00.000Z',
    '2026-09-08T00:00:00.000Z',
    'active',
    2500
  );
  const paused = await transition(
    twentyFivePercent,
    'paused',
    '2026-09-02T00:00:00.000Z',
    '2026-09-09T00:00:00.000Z',
    'paused',
    2500
  );
  const fiftyPercent = await transition(
    paused,
    '50',
    '2026-09-03T00:00:00.000Z',
    '2026-09-10T00:00:00.000Z',
    'active',
    5000
  );
  const oneHundredPercent = await transition(
    fiftyPercent,
    '100',
    '2026-09-04T00:00:00.000Z',
    '2026-09-11T00:00:00.000Z',
    'active',
    10_000
  );
  const revoked = await transition(
    oneHundredPercent,
    'revoked',
    '2026-09-05T00:00:00.000Z',
    '2026-09-12T00:00:00.000Z',
    'revoked',
    10_000,
    '0.3.1'
  );

  const states = [
    [fivePercent, 7, 'active', 500, null],
    [twentyFivePercent, 8, 'active', 2500, null],
    [paused, 9, 'paused', 2500, null],
    [fiftyPercent, 10, 'active', 5000, null],
    [oneHundredPercent, 11, 'active', 10_000, null],
    [revoked, 12, 'revoked', 10_000, '0.3.1'],
  ];
  const admitted = releaseByVersion(fivePercent.index, VERSION);
  for (const [result, sequence, status, rollout, rollbackTo] of states) {
    const release = releaseByVersion(result.index, VERSION);
    assert.equal(result.index.sequence, sequence);
    assert.equal(release.status, status);
    assert.equal(release.rollout_basis_points, rollout);
    assert.equal(release.rollback_to, rollbackTo);
    assert.deepEqual(release.targets, admitted.targets);
    assert.equal(release.published_at, admitted.published_at);
    assert.equal(release.rollout_salt, admitted.rollout_salt);
  }
  assert.deepEqual(readFileSync(candidate.archivePath), originalArchiveBytes);
  assert.ok(lstatSync(candidate.archivePath).size < 1024 * 1024);
});

test('policy transition rejects sequence rollback SHA drift rollout decrease and revoke revival', async t => {
  const fixture = createFixture(t);
  const candidate = await buildFixtureCandidate(fixture);
  const key = createLocalTestKey(fixture.root, 'negative-policy-key.pem');
  const indexOptions = loadIndexOptions();
  const common = {
    receipts: candidate.receiptPath,
    testPrivateKey: key.privateKeyPath,
    testKeyId: 'local-test-policy-negative',
    allowUnsignedFixture: true,
    dryRun: true,
  };
  const admitted = await generateUpdateIndex({
    ...common,
    previousIndex: writeRollbackSeedIndex(fixture.root, 'negative-seed.json'),
    sequence: 7,
    outputDirectory: join(fixture.root, 'negative-admitted'),
    generatedAt: indexOptions.generated_at,
    expiresAt: indexOptions.expires_at,
    publishedAt: indexOptions.published_at,
    channel: indexOptions.channel,
    status: 'active',
    studioVersionRequirement: indexOptions.studio_version_requirement,
    rolloutBasisPoints: 2500,
    rolloutSalt: indexOptions.rollout_salt,
    archiveBaseUrl: new URL(indexOptions.archive_base_url),
    releaseNotesUrl: indexOptions.release_notes_url,
  });
  const transitionOptions = {
    ...common,
    previousIndex: admitted.indexPath,
    generatedAt: '2026-09-01T00:00:00.000Z',
    expiresAt: '2026-09-08T00:00:00.000Z',
    status: 'active',
    rolloutBasisPoints: 2500,
  };
  await assert.rejects(
    generateUpdateIndex({
      ...transitionOptions,
      sequence: 6,
      outputDirectory: join(fixture.root, 'sequence-replay'),
    }),
    /sequence must increase/
  );
  await assert.rejects(
    generateUpdateIndex({
      ...transitionOptions,
      sequence: 8,
      rolloutBasisPoints: 500,
      outputDirectory: join(fixture.root, 'rollout-decrease'),
    }),
    /rollout cannot decrease/
  );

  const shaDriftIndex = JSON.parse(readFileSync(admitted.indexPath, 'utf8'));
  releaseByVersion(shaDriftIndex, VERSION).targets['darwin-aarch64'].archive_sha256 = 'f'.repeat(
    64
  );
  const shaDriftPath = join(fixture.root, 'sha-drift-index.json');
  writeFileSync(shaDriftPath, canonicalJsonBytes(shaDriftIndex));
  await assert.rejects(
    generateUpdateIndex({
      ...transitionOptions,
      previousIndex: shaDriftPath,
      sequence: 8,
      outputDirectory: join(fixture.root, 'sha-drift'),
    }),
    /archive_sha256 drifted after receipt replay/
  );

  const revoked = await generateUpdateIndex({
    ...transitionOptions,
    sequence: 8,
    outputDirectory: join(fixture.root, 'negative-revoked'),
    status: 'revoked',
    rollbackTo: '0.3.1',
  });
  await assert.rejects(
    generateUpdateIndex({
      ...common,
      previousIndex: revoked.indexPath,
      sequence: 9,
      outputDirectory: join(fixture.root, 'revoked-revival'),
      generatedAt: '2026-09-02T00:00:00.000Z',
      expiresAt: '2026-09-09T00:00:00.000Z',
      status: 'active',
      rolloutBasisPoints: 5000,
    }),
    /cannot be revived/
  );
});

test('policy transition CLI accepts explicit higher sequence and documents immutable replay', () => {
  const parsed = parseUpdateIndexArguments([
    '--receipts',
    '/tmp/candidate.receipt.json',
    '--out',
    '/tmp/index-output',
    '--previous-index',
    '/tmp/previous-index.json',
    '--sequence',
    '43',
    '--generated-at',
    '2026-09-01T00:00:00.000Z',
    '--expires-at',
    '2026-09-08T00:00:00.000Z',
    '--status',
    'paused',
    '--rollout-basis-points',
    '2500',
    '--allow-unsigned-fixture',
    '--test-private-key',
    '/tmp/local-test.pem',
    '--test-key-id',
    'local-test-policy-cli',
  ]);
  assert.equal(parsed.sequence, 43);
  assert.equal(parsed.channel, undefined);
  assert.equal(parsed.rolloutSalt, undefined);
  assert.match(updateIndexUsage(), /original receipt\/archive for replay/);
  assert.match(updateIndexUsage(), /Revocation cannot be undone/);
});

test('update index refuses unsigned receipts without the explicit fixture gate', async t => {
  const fixture = createFixture(t);
  const candidate = await buildFixtureCandidate(fixture);
  const indexOptions = loadIndexOptions();
  await assert.rejects(
    generateUpdateIndex({
      receipts: candidate.receiptPath,
      outputDirectory: join(fixture.root, 'index-denied'),
      sequence: 1,
      generatedAt: indexOptions.generated_at,
      expiresAt: indexOptions.expires_at,
      publishedAt: indexOptions.published_at,
      channel: 'beta',
      status: 'active',
      studioVersionRequirement: indexOptions.studio_version_requirement,
      rolloutBasisPoints: 500,
      rolloutSalt: indexOptions.rollout_salt,
      archiveBaseUrl: new URL(indexOptions.archive_base_url),
      releaseNotesUrl: indexOptions.release_notes_url,
      allowUnsignedFixture: false,
      dryRun: true,
    }),
    /NOT_RELEASABLE receipts require/
  );
});

test('update index rejects duplicate version/target receipts and out-of-range rollout', async t => {
  const fixture = createFixture(t);
  const candidate = await buildFixtureCandidate(fixture);
  const duplicateDirectory = join(fixture.root, 'duplicate-receipts');
  mkdirSync(duplicateDirectory, { recursive: true });
  const receipt = JSON.parse(readFileSync(candidate.receiptPath, 'utf8'));
  copyFileSync(candidate.archivePath, join(duplicateDirectory, receipt.artifact.filename));
  copyFileSync(candidate.receiptPath, join(duplicateDirectory, 'one.receipt.json'));
  copyFileSync(candidate.receiptPath, join(duplicateDirectory, 'two.receipt.json'));
  const key = createLocalTestKey(fixture.root, 'duplicate-key.pem');
  const indexOptions = loadIndexOptions();
  await assert.rejects(
    generateUpdateIndex({
      receipts: duplicateDirectory,
      outputDirectory: join(fixture.root, 'duplicate-index'),
      sequence: 1,
      generatedAt: indexOptions.generated_at,
      expiresAt: indexOptions.expires_at,
      publishedAt: indexOptions.published_at,
      channel: 'beta',
      status: 'active',
      studioVersionRequirement: indexOptions.studio_version_requirement,
      rolloutBasisPoints: 500,
      rolloutSalt: indexOptions.rollout_salt,
      archiveBaseUrl: new URL(indexOptions.archive_base_url),
      releaseNotesUrl: indexOptions.release_notes_url,
      testPrivateKey: key.privateKeyPath,
      testKeyId: 'local-test-duplicate',
      allowUnsignedFixture: true,
      dryRun: true,
    }),
    /duplicate version\/target receipt/
  );

  assert.throws(
    () =>
      parseUpdateIndexArguments([
        '--receipts',
        candidate.receiptPath,
        '--out',
        join(fixture.root, 'bad-rollout'),
        '--generated-at',
        indexOptions.generated_at,
        '--expires-at',
        indexOptions.expires_at,
        '--channel',
        'beta',
        '--status',
        'active',
        '--studio-version-requirement',
        indexOptions.studio_version_requirement,
        '--rollout-basis-points',
        '10001',
        '--rollout-salt',
        indexOptions.rollout_salt,
        '--archive-base-url',
        indexOptions.archive_base_url,
        '--release-notes-url',
        indexOptions.release_notes_url,
      ]),
    /0\.\.=10000/
  );
});

test('receipt archive path traversal is rejected before filesystem access', async t => {
  const fixture = createFixture(t);
  const candidate = await buildFixtureCandidate(fixture);
  const receipt = JSON.parse(readFileSync(candidate.receiptPath, 'utf8'));
  receipt.artifact.filename = '../escape.zip';
  const maliciousReceipt = join(fixture.root, 'malicious.receipt.json');
  writeFileSync(maliciousReceipt, canonicalJsonBytes(receipt), { mode: 0o600 });
  await assert.rejects(verifyAcpSidecarReceipt(maliciousReceipt), /unsafe path segment/);
});

function createFixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'orion-release-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'package');
  const outputDirectory = join(root, 'output');
  mkdirSync(join(packageRoot, 'dist', 'acp'), { recursive: true });
  mkdirSync(join(packageRoot, 'dist', 'product'), { recursive: true });
  const dependencies = options.dependency ? { 'fixture-dependency': '1.0.0' } : {};
  const packageManifest = {
    name: '@orion-agents/orion-code',
    version: VERSION,
    license: 'MIT',
    dependencies,
    devDependencies: {},
    engines: { node: '^22.12.0 || ^24.0.0 || ^26.0.0' },
  };
  writeJson(join(packageRoot, 'package.json'), packageManifest);
  const lockPackages = {
    '': {
      name: packageManifest.name,
      version: VERSION,
      license: 'MIT',
      dependencies,
      devDependencies: {},
      engines: packageManifest.engines,
    },
  };
  if (options.dependency) {
    lockPackages['node_modules/fixture-dependency'] = {
      version: '1.0.0',
      license: 'MIT',
      integrity: 'sha512-YQ==',
    };
    const dependencyRoot = join(packageRoot, 'node_modules', 'fixture-dependency');
    mkdirSync(dependencyRoot, { recursive: true });
    writeJson(join(dependencyRoot, 'package.json'), {
      name: 'fixture-dependency',
      version: '1.0.0',
      license: 'MIT',
      main: 'index.js',
    });
    writeFileSync(join(dependencyRoot, 'index.js'), "module.exports = 'fixture';\n");
    if (options.dependencyEnv) writeFileSync(join(dependencyRoot, '.env'), 'SECRET=sentinel\n');
    if (options.dependencySymlink) symlinkSync('index.js', join(dependencyRoot, 'linked.js'));
  }
  writeJson(join(packageRoot, 'npm-shrinkwrap.json'), {
    name: packageManifest.name,
    version: VERSION,
    lockfileVersion: 3,
    packages: lockPackages,
  });
  writeFileSync(join(packageRoot, 'LICENSE'), 'MIT License\n\nPermission is hereby granted.\n');
  writeFileSync(
    join(packageRoot, 'dist', 'acp', 'server.mjs'),
    [
      "import { PACKAGE_VERSION } from '../product/version.js';",
      'export const version = PACKAGE_VERSION;',
      options.sourceMap ? '//# sourceMappingURL=server.mjs.map' : '',
      '',
    ].join('\n')
  );
  writeFileSync(
    join(packageRoot, 'dist', 'product', 'version.js'),
    `exports.PACKAGE_VERSION = '${VERSION}';\n`
  );
  if (options.sourceMap) {
    writeJson(join(packageRoot, 'dist', 'acp', 'server.mjs.map'), {
      version: 3,
      sources: [`${packageRoot}/src/acp/server.mts`],
    });
  }
  const runtime = join(root, 'embedded-node');
  writeFileSync(
    runtime,
    '#!/bin/sh\nprintf \'%s\\n\' \'{"nodeVersion":"v24.14.0","nodeAbi":"137","platform":"darwin","arch":"arm64"}\'\n',
    { mode: 0o755 }
  );
  chmodSync(runtime, 0o755);
  const nodeLicense = join(root, 'NODE-LICENSE');
  writeFileSync(nodeLicense, 'Node.js is licensed under its bundled licenses.\n');
  return { root, packageRoot, outputDirectory, runtime, nodeLicense };
}

function buildFixtureCandidate(fixture, overrides = {}) {
  const layout = loadDarwinLayout();
  return buildAcpSidecar({
    packageRoot: fixture.packageRoot,
    version: VERSION,
    gitSha: GIT_SHA,
    target: 'darwin-aarch64',
    outputDirectory: fixture.outputDirectory,
    nodeRuntime: fixture.runtime,
    nodeLicense: fixture.nodeLicense,
    bundleId: layout.bundle_id,
    studioVersionRequirement: '>=0.1.0,<0.2.0',
    sourceDateEpoch: SOURCE_DATE_EPOCH,
    sourceOverride: {
      gitSha: GIT_SHA,
      dirty: true,
      sourceDateEpoch: SOURCE_DATE_EPOCH,
    },
    localUnsigned: true,
    skipBuild: true,
    skipSmoke: true,
    ...overrides,
  });
}

function loadIndexOptions() {
  return JSON.parse(readFileSync(join(FIXTURES, 'index-options.json'), 'utf8'));
}

function loadDarwinLayout() {
  return JSON.parse(readFileSync(join(FIXTURES, 'darwin-app-layout.json'), 'utf8'));
}

function writeRollbackSeedIndex(root, filename = 'rollback-seed-index.json') {
  const layout = loadDarwinLayout();
  const path = join(root, filename);
  writeFileSync(
    path,
    canonicalJsonBytes({
      schema_version: 1,
      sequence: 6,
      generated_at: '2026-08-30T00:00:00.000Z',
      expires_at: '2026-09-06T00:00:00.000Z',
      releases: [
        {
          version: '0.3.1',
          channel: 'stable',
          status: 'active',
          published_at: '2026-08-30T00:00:00.000Z',
          studio_version_requirement: '>=0.1.0,<0.2.0',
          acp_protocol: 1,
          rollout_basis_points: 10_000,
          rollout_salt: 'fixture-v0.3.1-salt',
          rollback_to: null,
          release_notes_url: 'https://fixtures.invalid/orion-code/releases/0.3.1',
          targets: {
            'darwin-aarch64': {
              archive_url:
                'https://fixtures.invalid/orion-code/0.3.1/orion-code-sidecar-0.3.1-darwin-aarch64.zip',
              archive_sha256: 'a'.repeat(64),
              archive_bytes: 1024,
              format: 'zip',
              command: layout.command,
              manifest_sha256: 'b'.repeat(64),
              sbom_sha256: 'c'.repeat(64),
              signing_requirement: 'developer_id_and_notarized',
            },
          },
        },
      ],
    })
  );
  return path;
}

function releaseByVersion(index, version) {
  const release = index.releases.find(candidate => candidate.version === version);
  assert.ok(release, `missing release ${version}`);
  return release;
}

function createLocalTestKey(root, filename = 'local-test-key.pem') {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPath = join(root, filename);
  writeFileSync(privateKeyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), {
    mode: 0o600,
  });
  chmodSync(privateKeyPath, 0o600);
  return { privateKeyPath, publicKey };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, canonicalJsonBytes(value));
}

function assertClosedSchemaKeys(value, schema) {
  assert.equal(schema.additionalProperties, false);
  const expected = [...schema.required].sort();
  assert.deepEqual(Object.keys(value).sort(), expected);
}
