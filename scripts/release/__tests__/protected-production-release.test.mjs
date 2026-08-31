import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  PRODUCTION_RELEASE_STATUS,
  createFailClosedCommandRunner,
  rebuildProductionManifest,
  signAndNotarizeDarwinBundle,
  verifyProductionAcpSidecarReceipt,
  withTemporaryAppleSigningContext,
} from '../production-sidecar-release.mjs';
import {
  publishProductionRelease,
  requiredReleaseAuthorization,
} from '../production-publisher.mjs';
import { canonicalJsonBytes, sha256Bytes, sha256File } from '../release-tooling-common.mjs';
import { generateUpdateIndex } from '../update-index-release.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const TEAM_ID = 'ABCDE12345';
const BUNDLE_ID = 'invalid.example.orion-code-sidecar.fixture';
const SIGNING_IDENTITY = `Developer ID Application: Orion Release Fixture (${TEAM_ID})`;

test('release command runner removes secret-bearing environment variables', async () => {
  const name = 'ORION_RELEASE_UPLOAD_TOKEN';
  const previous = process.env[name];
  process.env[name] = 'do-not-inherit-this-secret';
  try {
    await createFailClosedCommandRunner().run({
      label: 'secret inheritance fixture',
      command: process.execPath,
      args: ['-e', `process.exit(process.env.${name} ? 41 : 0)`],
      cwd: process.cwd(),
    });
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});

test('temporary Apple signing context injects file-backed credentials and removes them', async t => {
  const root = mkdtempSync(join(tmpdir(), 'orion-signing-context-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const runner = {
    async run(call) {
      calls.push(call);
      if (call.args[0] === 'create-keychain') writeFileSync(call.args.at(-1), 'keychain');
      if (call.args[0] === 'delete-keychain') unlinkSync(call.args.at(-1));
      return { stdout: '', stderr: '' };
    },
  };
  const result = await withTemporaryAppleSigningContext(
    {
      certificateP12: Buffer.alloc(64, 1),
      certificatePassword: 'fixture-password',
      notaryPrivateKey: Buffer.from(
        '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n'
      ),
    },
    async ({ keychainPath, notaryKeyPath }) => {
      assert.equal(existsSync(keychainPath), true);
      assert.match(readFileSync(notaryKeyPath, 'utf8'), /BEGIN PRIVATE KEY/);
      return 'PASS';
    },
    { runner, temporaryParent: root }
  );
  assert.equal(result, 'PASS');
  assert.deepEqual(readdirSync(root), []);
  assert.ok(calls.some(call => call.args[0] === 'import'));
  assert.ok(calls.some(call => call.args[0] === 'delete-keychain'));
});

test('Darwin release commands sign nested code before the outer app and complete notarization', async t => {
  const root = mkdtempSync(join(tmpdir(), 'orion-signing-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const appPath = join(root, 'OrionCodeSidecar.app');
  const runtimePath = join(appPath, 'Contents/Resources/runtime/node');
  const launcherPath = join(appPath, 'Contents/MacOS/orion-code-acp');
  mkdirSync(join(appPath, 'Contents/Resources/runtime'), { recursive: true });
  mkdirSync(join(appPath, 'Contents/MacOS'), { recursive: true });
  writeFileSync(runtimePath, 'fixture-runtime');
  writeFileSync(launcherPath, '#!/bin/sh\n');
  chmodSync(runtimePath, 0o755);
  chmodSync(launcherPath, 0o755);
  const calls = [];
  const runner = {
    async run(call) {
      calls.push(call);
      if (call.command === '/usr/bin/file') {
        return {
          stdout: call.args.at(-1).endsWith('/Contents/Resources/runtime/node')
            ? 'Mach-O 64-bit executable arm64\n'
            : 'ASCII text\n',
          stderr: '',
        };
      }
      if (call.args[0] === 'notarytool') {
        return {
          stdout: JSON.stringify({
            id: '12345678-1234-1234-1234-1234567890ab',
            status: 'Accepted',
          }),
          stderr: '',
        };
      }
      if (call.command === '/usr/bin/codesign' && call.args[0] === '--display') {
        return {
          stdout: '',
          stderr: [
            `Identifier=${BUNDLE_ID}`,
            `Authority=${SIGNING_IDENTITY}`,
            `TeamIdentifier=${TEAM_ID}`,
            'flags=0x10000(runtime)',
            'Timestamp=Aug 31, 2026 at 10:00:00',
          ].join('\n'),
        };
      }
      return { stdout: '', stderr: '' };
    },
  };
  await signAndNotarizeDarwinBundle(
    {
      appPath,
      bundleId: BUNDLE_ID,
      signingIdentity: SIGNING_IDENTITY,
      teamId: TEAM_ID,
      keychainPath: join(root, 'fixture.keychain-db'),
      notaryKeyPath: join(root, 'fixture.p8'),
      notaryKeyId: 'FGHIJ67890',
      notaryIssuerId: '12345678-1234-1234-1234-1234567890ab',
      temporaryDirectory: root,
    },
    { runner }
  );
  const signingCalls = calls.filter(
    call => call.command === '/usr/bin/codesign' && call.args[0] === '--force'
  );
  assert.equal(signingCalls.length, 2);
  assert.equal(signingCalls[0].args.at(-1).endsWith('/Contents/Resources/runtime/node'), true);
  assert.equal(signingCalls[1].args.at(-1).endsWith('/OrionCodeSidecar.app'), true);
  assert.equal(
    calls.some(call => call.args.includes('--deep')),
    false
  );
  const notaryCall = calls.find(call => call.args[0] === 'notarytool');
  assert.deepEqual(notaryCall.args.slice(0, 3), [
    'notarytool',
    'submit',
    join(root, 'notarization-submission.zip'),
  ]);
  assert.ok(notaryCall.args.includes('--wait'));
  assert.ok(calls.some(call => call.args[0] === 'stapler' && call.args[1] === 'staple'));
  assert.ok(calls.some(call => call.command === '/usr/sbin/spctl'));
  assert.ok(calls.some(call => call.args[0] === 'stapler' && call.args[1] === 'validate'));
});

test('Darwin release commands fail closed when Apple rejects notarization', async t => {
  const root = mkdtempSync(join(tmpdir(), 'orion-notary-rejection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const appPath = join(root, 'OrionCodeSidecar.app');
  const runtimePath = join(appPath, 'Contents/Resources/runtime/node');
  mkdirSync(join(appPath, 'Contents/Resources/runtime'), { recursive: true });
  writeFileSync(runtimePath, 'fixture-runtime');
  chmodSync(runtimePath, 0o755);
  const calls = [];
  const runner = {
    async run(call) {
      calls.push(call);
      if (call.command === '/usr/bin/file') {
        return { stdout: 'Mach-O 64-bit executable arm64\n', stderr: '' };
      }
      if (call.args[0] === 'notarytool') {
        return {
          stdout: JSON.stringify({
            id: '12345678-1234-1234-1234-1234567890ab',
            status: 'Invalid',
          }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    },
  };
  await assert.rejects(
    signAndNotarizeDarwinBundle(
      {
        appPath,
        bundleId: BUNDLE_ID,
        signingIdentity: SIGNING_IDENTITY,
        teamId: TEAM_ID,
        keychainPath: join(root, 'fixture.keychain-db'),
        notaryKeyPath: join(root, 'fixture.p8'),
        notaryKeyId: 'FGHIJ67890',
        notaryIssuerId: '12345678-1234-1234-1234-1234567890ab',
        temporaryDirectory: root,
      },
      { runner }
    ),
    /did not accept/
  );
  assert.equal(
    calls.some(call => call.args[0] === 'stapler'),
    false
  );
});

test('production receipt replay accepts only final signed, notarized, manifest-bound bytes', async t => {
  const fixture = await createProductionReceiptFixture(t);
  const replay = await verifyProductionAcpSidecarReceipt(
    fixture.receiptPath,
    fixture.archivePath,
    fixture.dependencies
  );
  assert.equal(replay.receipt.release_status, PRODUCTION_RELEASE_STATUS);
  assert.equal(replay.indexTarget.signing_requirement, 'developer_id_and_notarized');

  const rejected = structuredClone(fixture.receipt);
  rejected.signing.notarization = 'rejected';
  const rejectedPath = join(fixture.root, 'rejected.receipt.json');
  writeFileSync(rejectedPath, canonicalJsonBytes(rejected), { mode: 0o600 });
  await assert.rejects(
    verifyProductionAcpSidecarReceipt(rejectedPath, fixture.archivePath, fixture.dependencies),
    /not signed and notarized/
  );

  const tamperedArchive = join(fixture.root, fixture.receipt.artifact.filename);
  writeFileSync(tamperedArchive, 'tampered-final-bytes', { mode: 0o600 });
  await assert.rejects(
    verifyProductionAcpSidecarReceipt(fixture.receiptPath, tamperedArchive, fixture.dependencies),
    /final release receipt/
  );
});

test('production index signs the exact final bytes with a protected Ed25519 key', async t => {
  const root = mkdtempSync(join(tmpdir(), 'orion-production-index-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const receiptPath = join(root, 'candidate.receipt.json');
  writeFileSync(receiptPath, '{}\n', { mode: 0o600 });
  const outputDirectory = join(root, 'index');
  mkdirSync(outputDirectory);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const productionReceiptVerifier = async () => ({
    receipt: {
      release_status: PRODUCTION_RELEASE_STATUS,
      source: { version: '0.3.2', git_sha: SHA },
      artifact: {
        target: 'darwin-aarch64',
        filename: 'orion-code-sidecar-0.3.2-darwin-aarch64.zip',
      },
      signing: { status: 'developer_id', notarization: 'accepted' },
      policy: { releasable: true },
    },
    indexTarget: {
      archive_bytes: 123,
      archive_sha256: '1'.repeat(64),
      format: 'zip',
      command: 'OrionCodeSidecar.app/Contents/MacOS/orion-code-acp',
      manifest_sha256: '2'.repeat(64),
      sbom_sha256: '3'.repeat(64),
      signing_requirement: 'developer_id_and_notarized',
    },
  });
  const result = await generateUpdateIndex({
    receipts: receiptPath,
    outputDirectory,
    sequence: 1,
    generatedAt: '2026-08-31T00:00:00.000Z',
    expiresAt: '2026-09-07T00:00:00.000Z',
    publishedAt: '2026-08-31T00:00:00.000Z',
    channel: 'stable',
    status: 'active',
    studioVersionRequirement: '>=0.4.0',
    rolloutBasisPoints: 500,
    rolloutSalt: 'stable-0.3.2',
    archiveBaseUrl: new URL('https://releases.orion.invalid/sidecar/'),
    releaseNotesUrl: 'https://www.orion.invalid/releases/orion-code-0.3.2',
    allowUnsignedFixture: false,
    dryRun: true,
    productionSigning: {
      privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
      keyId: 'orion-release-key-v1',
    },
    productionReceiptVerifier,
  });
  const envelope = JSON.parse(readFileSync(result.signaturePath, 'utf8'));
  assert.equal(result.releaseStatus, PRODUCTION_RELEASE_STATUS);
  assert.equal(result.markerPath, undefined);
  assert.equal(existsSync(join(outputDirectory, 'NOT_RELEASABLE.txt')), false);
  assert.equal(
    verify(null, result.indexBytes, publicKey, Buffer.from(envelope.signature, 'base64')),
    true
  );
  const tampered = Buffer.concat([result.indexBytes, Buffer.from(' ')]);
  assert.equal(verify(null, tampered, publicKey, Buffer.from(envelope.signature, 'base64')), false);
});

test('publisher defaults to dry-run and requires exact protected authorization before upload', async t => {
  const fixture = createPublicationFixture(t);
  const forbiddenTransport = {
    async putFile() {
      throw new Error('dry-run attempted upload');
    },
    async putBytes() {
      throw new Error('dry-run attempted publication');
    },
    async getFile() {
      throw new Error('dry-run attempted download');
    },
  };
  const dryRun = await publishProductionRelease(
    { ...fixture.input, dryRun: true },
    { transport: forbiddenTransport, allowFixtureUrls: true }
  );
  assert.equal(dryRun.status, 'DRY_RUN');
  assert.deepEqual(dryRun.external_actions, ['NOT_UPLOADED', 'NOT_PUBLISHED']);

  await assert.rejects(
    publishProductionRelease(
      { ...fixture.input, dryRun: false, authorization: 'publish:wrong' },
      { transport: forbiddenTransport, allowFixtureUrls: true }
    ),
    /did not exactly match/
  );
});

test('authorized publisher uploads immutable assets only after remote archive SHA replay', async t => {
  const fixture = createPublicationFixture(t);
  const calls = [];
  const transport = {
    async putFile({ path }) {
      calls.push(`put:${path.split('/').at(-1)}`);
    },
    async getFile({ destination }) {
      calls.push('get:archive');
      copyFileSync(fixture.input.artifacts.archivePath, destination);
    },
    async putBytes() {
      calls.push('put:publication');
    },
  };
  let replayed = false;
  const result = await publishProductionRelease(
    {
      ...fixture.input,
      dryRun: false,
      authorization: requiredReleaseAuthorization(fixture.input.context),
    },
    {
      transport,
      allowFixtureUrls: true,
      verifyRemoteArchive: async () => {
        replayed = true;
      },
    }
  );
  assert.equal(result.status, 'PUBLISHED');
  assert.equal(replayed, true);
  assert.deepEqual(calls, [
    'put:artifact.zip',
    'get:archive',
    'put:artifact.receipt.json',
    'put:index.json',
    'put:index.json.sig',
    'put:publication',
  ]);
});

test('publisher stops before index upload when remote archive bytes drift', async t => {
  const fixture = createPublicationFixture(t);
  const calls = [];
  const transport = {
    async putFile({ path }) {
      calls.push(`put:${path.split('/').at(-1)}`);
    },
    async getFile({ destination }) {
      calls.push('get:archive');
      writeFileSync(destination, 'different-remote-bytes');
    },
    async putBytes() {
      calls.push('put:publication');
    },
  };
  await assert.rejects(
    publishProductionRelease(
      {
        ...fixture.input,
        dryRun: false,
        authorization: requiredReleaseAuthorization(fixture.input.context),
      },
      { transport, allowFixtureUrls: true }
    ),
    /remote archive SHA-256 did not match/
  );
  assert.deepEqual(calls, ['put:artifact.zip', 'get:archive']);
});

async function createProductionReceiptFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'orion-production-receipt-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const payloadRoot = join(root, 'payload', 'orion-code-sidecar');
  const appPath = join(payloadRoot, 'OrionCodeSidecar.app');
  const runtimePath = join(appPath, 'Contents/Resources/runtime/node');
  const licensePath = join(appPath, 'Contents/Resources/NODE_LICENSE');
  mkdirSync(join(appPath, 'Contents/Resources/runtime'), { recursive: true });
  mkdirSync(join(appPath, 'Contents/MacOS'), { recursive: true });
  writeFileSync(runtimePath, 'signed-runtime');
  chmodSync(runtimePath, 0o755);
  writeFileSync(licensePath, 'Node fixture license\n');
  writeFileSync(join(appPath, 'Contents/MacOS/orion-code-acp'), '#!/bin/sh\n');
  chmodSync(join(appPath, 'Contents/MacOS/orion-code-acp'), 0o755);
  writeFileSync(join(appPath, 'Contents/Info.plist'), '<plist/>\n');
  writeFileSync(join(payloadRoot, 'SBOM.cdx.json'), '{"bomFormat":"CycloneDX"}\n');
  writeFileSync(join(payloadRoot, 'THIRD_PARTY_NOTICES'), 'Fixture notices\n');
  writeFileSync(join(payloadRoot, 'LICENSE'), 'Fixture license\n');
  const initialManifest = {
    schema_version: 1,
    version: '0.3.2',
    git_sha: SHA,
    target: 'darwin-aarch64',
    built_at: '2026-08-31T00:00:00.000Z',
    acp_protocol: 1,
    studio_version_requirement: '>=0.4.0',
    node_version: '22.12.0',
    node_abi: '127',
    native_modules: [],
    command: 'OrionCodeSidecar.app/Contents/MacOS/orion-code-acp',
    sbom_path: 'SBOM.cdx.json',
    sbom_sha256: sha256Bytes(readFileSync(join(payloadRoot, 'SBOM.cdx.json'))),
    notices_path: 'THIRD_PARTY_NOTICES',
    notices_sha256: sha256Bytes(readFileSync(join(payloadRoot, 'THIRD_PARTY_NOTICES'))),
    files: [],
  };
  writeFileSync(join(payloadRoot, 'manifest.json'), canonicalJsonBytes(initialManifest));
  const manifest = await rebuildProductionManifest(payloadRoot);
  const archivePath = join(root, 'artifact.zip');
  writeFileSync(archivePath, 'final-archive-bytes', { mode: 0o600 });
  const archive = await sha256File(archivePath);
  const fileMap = new Map(manifest.files.map(file => [file.path, file]));
  const receipt = {
    schema_version: 1,
    kind: 'orion-code-acp-sidecar-release-receipt',
    release_status: PRODUCTION_RELEASE_STATUS,
    source: {
      package_name: '@orion-agents/orion-code',
      version: '0.3.2',
      git_sha: SHA,
      dirty: false,
      source_date_epoch: 1788134400,
      lock_sha256: '4'.repeat(64),
    },
    artifact: {
      filename: 'artifact.zip',
      bytes: archive.bytes,
      format: 'zip',
      archive_root: 'orion-code-sidecar',
      target: 'darwin-aarch64',
      command: 'OrionCodeSidecar.app/Contents/MacOS/orion-code-acp',
      bundle_id: BUNDLE_ID,
    },
    bindings: {
      archive_sha256: archive.sha256,
      manifest_sha256: sha256Bytes(readFileSync(join(payloadRoot, 'manifest.json'))),
      sbom_sha256: sha256Bytes(readFileSync(join(payloadRoot, 'SBOM.cdx.json'))),
      notices_sha256: sha256Bytes(readFileSync(join(payloadRoot, 'THIRD_PARTY_NOTICES'))),
    },
    runtime: {
      node_version: '22.12.0',
      node_abi: '127',
      platform: 'darwin',
      arch: 'arm64',
      executable_sha256: fileMap.get('OrionCodeSidecar.app/Contents/Resources/runtime/node').sha256,
      license_sha256: fileMap.get('OrionCodeSidecar.app/Contents/Resources/NODE_LICENSE').sha256,
    },
    verification: {
      acp_smoke: 'pass',
      relocated_path: 'pass',
      final_archive_replay: 'pass',
      codesign: 'pass',
      gatekeeper: 'pass',
      staple: 'pass',
    },
    signing: {
      status: 'developer_id',
      team_id: TEAM_ID,
      identity_sha256: sha256Bytes(Buffer.from(SIGNING_IDENTITY)),
      hardened_runtime: true,
      timestamp: true,
      notarization: 'accepted',
    },
    policy: { releasable: true, reasons: [] },
  };
  const receiptPath = join(root, 'artifact.receipt.json');
  writeFileSync(receiptPath, canonicalJsonBytes(receipt), { mode: 0o600 });
  const archiveAdapter = {
    async extract({ destination }) {
      mkdirSync(destination, { recursive: true });
      cpSync(payloadRoot, join(destination, 'orion-code-sidecar'), { recursive: true });
    },
  };
  const runner = platformFixtureRunner(runtimePath);
  return {
    root,
    receipt,
    receiptPath,
    archivePath,
    dependencies: {
      archiveAdapter,
      runner,
      expectedBundleId: BUNDLE_ID,
      expectedTeamId: TEAM_ID,
      expectedSigningIdentity: SIGNING_IDENTITY,
      temporaryParent: root,
    },
  };
}

function platformFixtureRunner() {
  return {
    async run(call) {
      if (call.command === '/usr/bin/file') {
        return {
          stdout: call.args.at(-1).endsWith('/Resources/runtime/node')
            ? 'Mach-O 64-bit executable arm64\n'
            : 'ASCII text\n',
          stderr: '',
        };
      }
      if (call.command === '/usr/bin/codesign' && call.args[0] === '--display') {
        return {
          stdout: '',
          stderr: [
            `Identifier=${BUNDLE_ID}`,
            `Authority=${SIGNING_IDENTITY}`,
            `TeamIdentifier=${TEAM_ID}`,
            'flags=0x10000(runtime)',
            'Timestamp=Aug 31, 2026 at 10:00:00',
          ].join('\n'),
        };
      }
      return { stdout: '', stderr: '' };
    },
  };
}

function createPublicationFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'orion-publisher-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifacts = {
    archivePath: join(root, 'artifact.zip'),
    receiptPath: join(root, 'artifact.receipt.json'),
    indexPath: join(root, 'index.json'),
    signaturePath: join(root, 'index.json.sig'),
  };
  for (const [name, path] of Object.entries(artifacts)) writeFileSync(path, `${name}\n`);
  return {
    input: {
      context: {
        githubActions: true,
        eventName: 'workflow_dispatch',
        refType: 'tag',
        refName: 'v0.3.2',
        refProtected: true,
        environmentName: 'orion-code-sidecar-release',
        sha: SHA,
      },
      token: 'a'.repeat(64),
      artifacts,
      destinations: {
        archiveUploadUrl: 'https://uploads.orion.invalid/0.3.2/artifact.zip',
        archiveDownloadUrl: 'https://releases.orion.invalid/0.3.2/artifact.zip',
        receiptUploadUrl: 'https://uploads.orion.invalid/0.3.2/artifact.receipt.json',
        receiptDownloadUrl: 'https://releases.orion.invalid/0.3.2/artifact.receipt.json',
        indexUploadUrl: 'https://uploads.orion.invalid/indexes/1/index.json',
        indexDownloadUrl: 'https://releases.orion.invalid/indexes/1/index.json',
        signatureUploadUrl: 'https://uploads.orion.invalid/indexes/1/index.json.sig',
        signatureDownloadUrl: 'https://releases.orion.invalid/indexes/1/index.json.sig',
        publicationUrl: 'https://uploads.orion.invalid/publications/1.json',
      },
    },
  };
}
