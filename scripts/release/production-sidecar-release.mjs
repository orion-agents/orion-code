import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  constants as fsConstants,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { verifyAcpSidecarReceipt } from './acp-sidecar-release.mjs';
import { verifyDeterministicZip, writeDeterministicZip } from './deterministic-zip.mjs';
import {
  SIDECAR_ARCHIVE_ROOT,
  assertExactObjectKeys,
  assertExactSemver,
  assertGitSha,
  assertNoReceiptBinding,
  assertNoSecretPath,
  assertRfc3339,
  assertSafeBasename,
  assertSafeRelativePath,
  assertSha256,
  assertSupportedTarget,
  canonicalJsonBytes,
  ensureEmptyOutputDirectory,
  ensureRegularFile,
  readJsonFile,
  resolveContained,
  sha256Bytes,
  sha256File,
  writeFileExclusive,
} from './release-tooling-common.mjs';

export const PRODUCTION_RELEASE_STATUS = 'RELEASABLE';

const RECEIPT_KIND = 'orion-code-acp-sidecar-release-receipt';
const RECEIPT_SCHEMA_VERSION = 1;
const MANIFEST_SCHEMA_VERSION = 1;
const DARWIN_TARGET = 'darwin-aarch64';
const DARWIN_APP_BUNDLE = 'OrionCodeSidecar.app';
const DARWIN_APP_CONTENTS = `${DARWIN_APP_BUNDLE}/Contents`;
const DARWIN_COMMAND = `${DARWIN_APP_CONTENTS}/MacOS/orion-code-acp`;
const DARWIN_NODE_RUNTIME = `${DARWIN_APP_CONTENTS}/Resources/runtime/node`;
const DARWIN_NODE_LICENSE = `${DARWIN_APP_CONTENTS}/Resources/NODE_LICENSE`;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const SAFE_STUDIO_REQUIREMENT = /^[0-9A-Za-z<>=.,*^~|+ -]{1,256}$/;
const NATIVE_MODULE_EXTENSION = /\.(?:dylib|node|so|dll)$/i;

export function createFailClosedCommandRunner() {
  return {
    async run({ label, command, args, cwd }) {
      const result = spawnSync(command, [...args], {
        cwd,
        env: scrubbedCommandEnvironment(),
        encoding: 'utf8',
        maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (result.error || result.status !== 0 || result.signal) {
        throw new Error(`${label} failed.`);
      }
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    },
  };
}

export function createDarwinArchiveAdapter() {
  return {
    async extract({ archivePath, destination, runner }) {
      await verifyDeterministicZip(archivePath);
      mkdirSync(destination, { recursive: true, mode: 0o700 });
      await runner.run({
        label: 'archive extraction',
        command: '/usr/bin/ditto',
        args: ['-x', '-k', archivePath, destination],
        cwd: destination,
      });
    },
    async create({ sourceDirectory, archivePath }) {
      await writeDeterministicZip({
        sourceDirectory,
        outputPath: archivePath,
        archiveRoot: SIDECAR_ARCHIVE_ROOT,
      });
    },
  };
}

export async function withTemporaryAppleSigningContext(
  configuration,
  operation,
  { runner = createFailClosedCommandRunner(), temporaryParent = tmpdir() } = {}
) {
  const temporaryRoot = mkdtempSync(join(temporaryParent, 'orion-apple-signing-'));
  chmodSync(temporaryRoot, 0o700);
  const certificatePath = join(temporaryRoot, 'developer-id.p12');
  const notaryKeyPath = join(temporaryRoot, 'notary-key.p8');
  const keychainPath = join(temporaryRoot, 'release.keychain-db');
  const keychainPassword = randomBytes(32).toString('base64url');
  let operationResult;
  let operationError;
  let cleanupError;
  try {
    writePrivateFile(certificatePath, configuration.certificateP12);
    writePrivateFile(notaryKeyPath, configuration.notaryPrivateKey);
    await runner.run({
      label: 'temporary keychain creation',
      command: '/usr/bin/security',
      args: ['create-keychain', '-p', keychainPassword, keychainPath],
      cwd: temporaryRoot,
    });
    await runner.run({
      label: 'temporary keychain unlock',
      command: '/usr/bin/security',
      args: ['unlock-keychain', '-p', keychainPassword, keychainPath],
      cwd: temporaryRoot,
    });
    await runner.run({
      label: 'Developer ID certificate import',
      command: '/usr/bin/security',
      args: [
        'import',
        certificatePath,
        '-k',
        keychainPath,
        '-P',
        configuration.certificatePassword,
        '-T',
        '/usr/bin/codesign',
        '-T',
        '/usr/bin/security',
      ],
      cwd: temporaryRoot,
    });
    await runner.run({
      label: 'temporary keychain partition setup',
      command: '/usr/bin/security',
      args: [
        'set-key-partition-list',
        '-S',
        'apple-tool:,apple:,codesign:',
        '-s',
        '-k',
        keychainPassword,
        keychainPath,
      ],
      cwd: temporaryRoot,
    });
    operationResult = await operation({ keychainPath, notaryKeyPath });
  } catch (error) {
    operationError = error;
  }
  if (existsSync(keychainPath)) {
    try {
      await runner.run({
        label: 'temporary keychain deletion',
        command: '/usr/bin/security',
        args: ['delete-keychain', keychainPath],
        cwd: temporaryRoot,
      });
    } catch (error) {
      cleanupError = new Error('temporary signing keychain cleanup failed.', { cause: error });
    }
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  return operationResult;
}

export async function signAndNotarizeDarwinBundle(
  {
    appPath,
    bundleId,
    signingIdentity,
    teamId,
    keychainPath,
    notaryKeyPath,
    notaryKeyId,
    notaryIssuerId,
    temporaryDirectory,
  },
  { runner = createFailClosedCommandRunner() } = {}
) {
  assertDarwinSigningConfiguration({ bundleId, signingIdentity, teamId });
  const canonicalApp = realDirectory(appPath, 'sidecar app bundle');
  const nestedCode = await discoverNestedMachO(canonicalApp, runner);
  for (const codePath of nestedCode) {
    await runner.run({
      label: 'nested Developer ID signing',
      command: '/usr/bin/codesign',
      args: [
        '--force',
        '--options',
        'runtime',
        '--timestamp',
        '--sign',
        signingIdentity,
        '--keychain',
        keychainPath,
        codePath,
      ],
      cwd: canonicalApp,
    });
  }
  await runner.run({
    label: 'outer app Developer ID signing',
    command: '/usr/bin/codesign',
    args: [
      '--force',
      '--options',
      'runtime',
      '--timestamp',
      '--sign',
      signingIdentity,
      '--keychain',
      keychainPath,
      canonicalApp,
    ],
    cwd: canonicalApp,
  });

  const notarizationArchive = join(temporaryDirectory, 'notarization-submission.zip');
  await runner.run({
    label: 'notarization archive creation',
    command: '/usr/bin/ditto',
    args: ['-c', '-k', '--keepParent', canonicalApp, notarizationArchive],
    cwd: temporaryDirectory,
  });
  const notarization = await runner.run({
    label: 'Apple notarization submission',
    command: '/usr/bin/xcrun',
    args: [
      'notarytool',
      'submit',
      notarizationArchive,
      '--key',
      notaryKeyPath,
      '--key-id',
      notaryKeyId,
      '--issuer',
      notaryIssuerId,
      '--wait',
      '--output-format',
      'json',
    ],
    cwd: temporaryDirectory,
  });
  const notarizationResult = parseAcceptedNotaryResult(notarization.stdout);
  await runner.run({
    label: 'notarization ticket staple',
    command: '/usr/bin/xcrun',
    args: ['stapler', 'staple', canonicalApp],
    cwd: temporaryDirectory,
  });
  await verifyDarwinPlatformTrust(
    { appPath: canonicalApp, bundleId, signingIdentity, teamId, nestedCode },
    { runner }
  );
  return {
    nestedCode,
    notarizationId: notarizationResult.id,
    notarizationStatus: 'accepted',
  };
}

export async function verifyDarwinPlatformTrust(
  { appPath, bundleId, signingIdentity, signingIdentitySha256, teamId, nestedCode },
  { runner = createFailClosedCommandRunner() } = {}
) {
  assertBundleIdentifier(bundleId);
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error('Apple Team ID format is invalid.');
  if (signingIdentity) {
    assertDarwinSigningConfiguration({ bundleId, signingIdentity, teamId });
  } else {
    assertSha256(signingIdentitySha256, 'signing identity SHA-256');
  }
  const canonicalApp = realDirectory(appPath, 'sidecar app bundle');
  const codePaths = nestedCode ?? (await discoverNestedMachO(canonicalApp, runner));
  for (const codePath of codePaths) {
    await runner.run({
      label: 'nested code signature verification',
      command: '/usr/bin/codesign',
      args: ['--verify', '--strict', '--verbose=4', codePath],
      cwd: canonicalApp,
    });
    const nestedDisplay = await runner.run({
      label: 'nested code signature metadata inspection',
      command: '/usr/bin/codesign',
      args: ['--display', '--verbose=4', codePath],
      cwd: canonicalApp,
    });
    assertDeveloperIdMetadata(`${nestedDisplay.stdout}\n${nestedDisplay.stderr}`, {
      signingIdentity,
      signingIdentitySha256,
      teamId,
    });
  }
  await runner.run({
    label: 'outer app code signature verification',
    command: '/usr/bin/codesign',
    args: ['--verify', '--strict', '--verbose=4', canonicalApp],
    cwd: canonicalApp,
  });
  const display = await runner.run({
    label: 'outer app signature metadata inspection',
    command: '/usr/bin/codesign',
    args: ['--display', '--verbose=4', canonicalApp],
    cwd: canonicalApp,
  });
  const metadata = `${display.stdout}\n${display.stderr}`;
  assertDeveloperIdMetadata(metadata, { signingIdentity, signingIdentitySha256, teamId });
  if (!metadata.includes(`Identifier=${bundleId}`)) {
    throw new Error('Developer ID signature metadata did not match the frozen release identity.');
  }
  if (/get-task-allow/i.test(metadata)) {
    throw new Error('release signature metadata contains a development entitlement.');
  }
  const entitlements = await runner.run({
    label: 'outer app entitlement inspection',
    command: '/usr/bin/codesign',
    args: ['--display', '--entitlements', ':-', canonicalApp],
    cwd: canonicalApp,
  });
  if (
    /com\.apple\.security\.get-task-allow[\s\S]*?<true\s*\/>/i.test(
      `${entitlements.stdout}\n${entitlements.stderr}`
    )
  ) {
    throw new Error('release signature enables the development task entitlement.');
  }
  await runner.run({
    label: 'Gatekeeper assessment',
    command: '/usr/sbin/spctl',
    args: ['--assess', '--type', 'execute', '--verbose=4', canonicalApp],
    cwd: canonicalApp,
  });
  await runner.run({
    label: 'stapled ticket validation',
    command: '/usr/bin/xcrun',
    args: ['stapler', 'validate', canonicalApp],
    cwd: canonicalApp,
  });
  return { codesign: 'pass', gatekeeper: 'pass', staple: 'pass' };
}

export async function finalizeProductionDarwinSidecar(
  options,
  {
    runner = createFailClosedCommandRunner(),
    archiveAdapter = createDarwinArchiveAdapter(),
    temporaryParent = tmpdir(),
  } = {}
) {
  const outputDirectory = resolve(options.outputDirectory);
  ensureEmptyOutputDirectory(outputDirectory);
  const canonicalOutput = realpathSync(outputDirectory);
  const unsigned = await verifyAcpSidecarReceipt(options.unsignedReceiptPath);
  if (
    unsigned.receipt.source.dirty ||
    unsigned.receipt.artifact.target !== DARWIN_TARGET ||
    unsigned.receipt.artifact.bundle_id !== options.bundleId ||
    unsigned.receipt.verification.acp_smoke !== 'pass' ||
    unsigned.receipt.verification.relocated_path !== 'pass'
  ) {
    throw new Error(
      'production finalization requires a clean, fully smoke-tested Darwin candidate.'
    );
  }
  const temporaryRoot = mkdtempSync(join(temporaryParent, 'orion-production-sidecar-'));
  chmodSync(temporaryRoot, 0o700);
  try {
    const extractionDirectory = join(temporaryRoot, 'unsigned');
    await archiveAdapter.extract({
      archivePath: unsigned.archivePath,
      destination: extractionDirectory,
      runner,
    });
    const sidecarRoot = requireSingleArchiveRoot(extractionDirectory);
    const markerPath = join(sidecarRoot, 'NOT_RELEASABLE.txt');
    ensureRegularFile(markerPath, 'unsigned candidate marker');
    unlinkSync(markerPath);
    const appPath = join(sidecarRoot, DARWIN_APP_BUNDLE);
    const signing = await signAndNotarizeDarwinBundle(
      {
        appPath,
        bundleId: options.bundleId,
        signingIdentity: options.signingIdentity,
        teamId: options.teamId,
        keychainPath: options.keychainPath,
        notaryKeyPath: options.notaryKeyPath,
        notaryKeyId: options.notaryKeyId,
        notaryIssuerId: options.notaryIssuerId,
        temporaryDirectory: temporaryRoot,
      },
      { runner }
    );
    const manifest = await rebuildProductionManifest(sidecarRoot);
    const version = unsigned.receipt.source.version;
    const target = unsigned.receipt.artifact.target;
    const archiveFilename = `orion-code-sidecar-${version}-${target}.zip`;
    const receiptFilename = `orion-code-sidecar-${version}-${target}.receipt.json`;
    const archivePath = join(temporaryRoot, archiveFilename);
    await archiveAdapter.create({ sourceDirectory: sidecarRoot, archivePath, runner });
    const archiveDigest = await sha256File(archivePath);
    const manifestBytes = readFileSync(join(sidecarRoot, 'manifest.json'));
    const sbomBytes = readFileSync(join(sidecarRoot, 'SBOM.cdx.json'));
    const noticesBytes = readFileSync(join(sidecarRoot, 'THIRD_PARTY_NOTICES'));
    const fileMap = new Map(manifest.files.map(file => [file.path, file]));
    const runtimeExecutable = fileMap.get(DARWIN_NODE_RUNTIME);
    const runtimeLicense = fileMap.get(DARWIN_NODE_LICENSE);
    if (!runtimeExecutable || !runtimeLicense) {
      throw new Error('production manifest omitted embedded runtime evidence.');
    }
    const receipt = {
      schema_version: RECEIPT_SCHEMA_VERSION,
      kind: RECEIPT_KIND,
      release_status: PRODUCTION_RELEASE_STATUS,
      source: { ...unsigned.receipt.source, dirty: false },
      artifact: {
        ...unsigned.receipt.artifact,
        filename: archiveFilename,
        bytes: archiveDigest.bytes,
      },
      bindings: {
        archive_sha256: archiveDigest.sha256,
        manifest_sha256: sha256Bytes(manifestBytes),
        sbom_sha256: sha256Bytes(sbomBytes),
        notices_sha256: sha256Bytes(noticesBytes),
      },
      runtime: {
        ...unsigned.receipt.runtime,
        executable_sha256: runtimeExecutable.sha256,
        license_sha256: runtimeLicense.sha256,
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
        team_id: options.teamId,
        identity_sha256: sha256Bytes(Buffer.from(options.signingIdentity, 'utf8')),
        hardened_runtime: true,
        timestamp: true,
        notarization: signing.notarizationStatus,
      },
      policy: { releasable: true, reasons: [] },
    };
    const temporaryReceiptPath = join(temporaryRoot, receiptFilename);
    writeFileExclusive(temporaryReceiptPath, canonicalJsonBytes(receipt));
    await verifyProductionAcpSidecarReceipt(temporaryReceiptPath, archivePath, {
      runner,
      archiveAdapter,
      expectedBundleId: options.bundleId,
      expectedTeamId: options.teamId,
      expectedSigningIdentity: options.signingIdentity,
      temporaryParent,
    });
    const finalArchivePath = join(canonicalOutput, archiveFilename);
    const finalReceiptPath = join(canonicalOutput, receiptFilename);
    copyFileSync(archivePath, finalArchivePath, fsConstants.COPYFILE_EXCL);
    copyFileSync(temporaryReceiptPath, finalReceiptPath, fsConstants.COPYFILE_EXCL);
    chmodSync(finalArchivePath, 0o600);
    chmodSync(finalReceiptPath, 0o600);
    return { archivePath: finalArchivePath, receiptPath: finalReceiptPath, receipt };
  } catch (error) {
    rmSync(canonicalOutput, { recursive: true, force: true });
    mkdirSync(canonicalOutput, { recursive: true, mode: 0o700 });
    throw error;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export async function verifyProductionAcpSidecarReceipt(
  receiptPath,
  explicitArchivePath,
  {
    runner = createFailClosedCommandRunner(),
    archiveAdapter = createDarwinArchiveAdapter(),
    expectedBundleId,
    expectedTeamId,
    expectedSigningIdentity,
    temporaryParent = tmpdir(),
  } = {}
) {
  const canonicalReceipt = realFile(receiptPath, 'production sidecar receipt');
  if (lstatSync(canonicalReceipt).size > MAX_RECEIPT_BYTES) {
    throw new Error('production sidecar receipt exceeds 1 MiB.');
  }
  const receipt = readJsonFile(canonicalReceipt, 'production sidecar receipt');
  validateProductionReceiptShape(receipt);
  if (
    (expectedBundleId && receipt.artifact.bundle_id !== expectedBundleId) ||
    (expectedTeamId && receipt.signing.team_id !== expectedTeamId) ||
    (expectedSigningIdentity &&
      receipt.signing.identity_sha256 !== sha256Bytes(Buffer.from(expectedSigningIdentity, 'utf8')))
  ) {
    throw new Error('production receipt identity did not match protected release configuration.');
  }
  const archivePath = explicitArchivePath
    ? realFile(explicitArchivePath, 'production sidecar archive')
    : realFile(
        resolveContained(
          dirname(canonicalReceipt),
          receipt.artifact.filename,
          'production receipt archive filename'
        ),
        'production sidecar archive'
      );
  if (basename(archivePath) !== receipt.artifact.filename) {
    throw new Error('production receipt archive filename does not match replayed bytes.');
  }
  const archiveDigest = await sha256File(archivePath);
  if (
    archiveDigest.bytes !== receipt.artifact.bytes ||
    archiveDigest.sha256 !== receipt.bindings.archive_sha256
  ) {
    throw new Error('production archive bytes do not match the final release receipt.');
  }
  const temporaryRoot = mkdtempSync(join(temporaryParent, 'orion-production-replay-'));
  chmodSync(temporaryRoot, 0o700);
  try {
    const extractionDirectory = join(temporaryRoot, 'extracted');
    await archiveAdapter.extract({ archivePath, destination: extractionDirectory, runner });
    const sidecarRoot = requireSingleArchiveRoot(extractionDirectory);
    const manifestPath = realFile(join(sidecarRoot, 'manifest.json'), 'production manifest');
    const manifestBytes = readFileSync(manifestPath);
    if (sha256Bytes(manifestBytes) !== receipt.bindings.manifest_sha256) {
      throw new Error('production manifest SHA-256 does not match the final release receipt.');
    }
    const manifest = parseJsonBytes(manifestBytes, 'production manifest');
    validateProductionManifestShape(manifest);
    assertNoReceiptBinding(manifest);
    if (
      manifest.version !== receipt.source.version ||
      manifest.git_sha !== receipt.source.git_sha ||
      manifest.target !== receipt.artifact.target ||
      manifest.command !== receipt.artifact.command ||
      manifest.node_version !== receipt.runtime.node_version ||
      manifest.node_abi !== receipt.runtime.node_abi
    ) {
      throw new Error('production manifest identity does not match the final release receipt.');
    }
    const actualFiles = await collectManifestFiles(sidecarRoot, 'manifest.json');
    if (canonicalJsonBytes(actualFiles).compare(canonicalJsonBytes(manifest.files)) !== 0) {
      throw new Error('production manifest does not bind every final archive file.');
    }
    if (actualFiles.some(file => file.path.endsWith('NOT_RELEASABLE.txt'))) {
      throw new Error('production archive retained a NOT_RELEASABLE marker.');
    }
    const fileMap = new Map(actualFiles.map(file => [file.path, file]));
    if (
      fileMap.get(DARWIN_NODE_RUNTIME)?.sha256 !== receipt.runtime.executable_sha256 ||
      fileMap.get(DARWIN_NODE_LICENSE)?.sha256 !== receipt.runtime.license_sha256
    ) {
      throw new Error('production runtime evidence does not match final archive bytes.');
    }
    const sbomBytes = readFileSync(join(sidecarRoot, 'SBOM.cdx.json'));
    const noticesBytes = readFileSync(join(sidecarRoot, 'THIRD_PARTY_NOTICES'));
    if (
      sha256Bytes(sbomBytes) !== receipt.bindings.sbom_sha256 ||
      sha256Bytes(noticesBytes) !== receipt.bindings.notices_sha256 ||
      manifest.sbom_sha256 !== receipt.bindings.sbom_sha256 ||
      manifest.notices_sha256 !== receipt.bindings.notices_sha256
    ) {
      throw new Error('production SBOM or notices evidence drifted.');
    }
    await verifyDarwinPlatformTrust(
      {
        appPath: join(sidecarRoot, DARWIN_APP_BUNDLE),
        bundleId: receipt.artifact.bundle_id,
        signingIdentity: expectedSigningIdentity,
        signingIdentitySha256: receipt.signing.identity_sha256,
        teamId: receipt.signing.team_id,
      },
      { runner }
    );
    return {
      receipt,
      manifest,
      archivePath,
      indexTarget: {
        archive_bytes: receipt.artifact.bytes,
        archive_sha256: receipt.bindings.archive_sha256,
        format: 'zip',
        command: receipt.artifact.command,
        manifest_sha256: receipt.bindings.manifest_sha256,
        sbom_sha256: receipt.bindings.sbom_sha256,
        signing_requirement: 'developer_id_and_notarized',
      },
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export async function rebuildProductionManifest(sidecarRoot) {
  const canonicalRoot = realDirectory(sidecarRoot, 'sidecar root');
  const manifestPath = realFile(join(canonicalRoot, 'manifest.json'), 'unsigned manifest');
  const manifest = readJsonFile(manifestPath, 'unsigned manifest');
  validateProductionManifestShape(manifest);
  const files = await collectManifestFiles(canonicalRoot, 'manifest.json');
  if (files.some(file => file.path.endsWith('NOT_RELEASABLE.txt'))) {
    throw new Error('production payload retained a NOT_RELEASABLE marker.');
  }
  const sbom = files.find(file => file.path === 'SBOM.cdx.json');
  const notices = files.find(file => file.path === 'THIRD_PARTY_NOTICES');
  if (!sbom || !notices) throw new Error('production payload is missing release evidence.');
  const productionManifest = {
    ...manifest,
    sbom_sha256: sbom.sha256,
    notices_sha256: notices.sha256,
    native_modules: files
      .filter(file => NATIVE_MODULE_EXTENSION.test(file.path))
      .map(file => file.path),
    files,
  };
  assertNoReceiptBinding(productionManifest);
  writeFileSync(manifestPath, canonicalJsonBytes(productionManifest), { mode: 0o644 });
  return productionManifest;
}

async function discoverNestedMachO(appPath, runner) {
  const candidates = walkRegularFiles(appPath)
    .filter(file => file.executable || NATIVE_MODULE_EXTENSION.test(file.relativePath))
    .sort((left, right) => {
      const depth = right.relativePath.split('/').length - left.relativePath.split('/').length;
      return depth || left.relativePath.localeCompare(right.relativePath);
    });
  const output = [];
  for (const candidate of candidates) {
    const detected = await runner.run({
      label: 'Mach-O discovery',
      command: '/usr/bin/file',
      args: ['-b', candidate.absolutePath],
      cwd: appPath,
    });
    if (/Mach-O/.test(detected.stdout)) output.push(candidate.absolutePath);
  }
  if (!output.some(path => path.endsWith(`/Resources/runtime/node`))) {
    throw new Error('embedded Node runtime was not identified as Mach-O code.');
  }
  return output;
}

async function collectManifestFiles(root, excludedPath) {
  const files = [];
  for (const file of walkRegularFiles(root)) {
    if (file.relativePath === excludedPath) continue;
    assertSafeRelativePath(file.relativePath, 'production payload path');
    assertNoSecretPath(file.relativePath);
    const digest = await sha256File(file.absolutePath);
    files.push({
      path: file.relativePath,
      mode: file.executable ? 0o755 : 0o644,
      bytes: digest.bytes,
      sha256: digest.sha256,
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function walkRegularFiles(root) {
  const output = [];
  const visit = directory => {
    for (const name of readdirSync(directory).sort()) {
      const absolutePath = join(directory, name);
      const metadata = lstatSync(absolutePath);
      if (metadata.isSymbolicLink()) throw new Error('production payload contains a symlink.');
      if (metadata.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!metadata.isFile()) throw new Error('production payload contains a special file.');
      const relativePath = relative(root, absolutePath).split(sep).join('/');
      output.push({
        absolutePath,
        relativePath,
        executable: (metadata.mode & 0o111) !== 0,
      });
    }
  };
  visit(root);
  return output.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function validateProductionReceiptShape(receipt) {
  assertExactObjectKeys(
    receipt,
    [
      'schema_version',
      'kind',
      'release_status',
      'source',
      'artifact',
      'bindings',
      'runtime',
      'verification',
      'signing',
      'policy',
    ],
    'production sidecar receipt'
  );
  if (
    receipt.schema_version !== RECEIPT_SCHEMA_VERSION ||
    receipt.kind !== RECEIPT_KIND ||
    receipt.release_status !== PRODUCTION_RELEASE_STATUS
  ) {
    throw new Error('production receipt is not a releasable receipt contract.');
  }
  assertExactObjectKeys(
    receipt.source,
    ['package_name', 'version', 'git_sha', 'dirty', 'source_date_epoch', 'lock_sha256'],
    'production receipt source'
  );
  if (
    receipt.source.package_name !== '@orion-agents/orion-code' ||
    receipt.source.dirty !== false
  ) {
    throw new Error('production receipt must bind a clean Orion Code source.');
  }
  assertExactSemver(receipt.source.version, 'production receipt version');
  assertGitSha(receipt.source.git_sha);
  assertSha256(receipt.source.lock_sha256, 'production receipt lock SHA-256');
  if (
    !Number.isSafeInteger(receipt.source.source_date_epoch) ||
    receipt.source.source_date_epoch < 0
  ) {
    throw new Error('production receipt source epoch is invalid.');
  }
  assertExactObjectKeys(
    receipt.artifact,
    ['filename', 'bytes', 'format', 'archive_root', 'target', 'command', 'bundle_id'],
    'production receipt artifact'
  );
  assertSafeBasename(receipt.artifact.filename, 'production archive filename');
  if (
    !Number.isSafeInteger(receipt.artifact.bytes) ||
    receipt.artifact.bytes <= 0 ||
    receipt.artifact.format !== 'zip' ||
    receipt.artifact.archive_root !== SIDECAR_ARCHIVE_ROOT ||
    receipt.artifact.command !== DARWIN_COMMAND
  ) {
    throw new Error('production receipt archive contract is invalid.');
  }
  assertSupportedTarget(receipt.artifact.target);
  assertBundleIdentifier(receipt.artifact.bundle_id);
  assertExactObjectKeys(
    receipt.bindings,
    ['archive_sha256', 'manifest_sha256', 'sbom_sha256', 'notices_sha256'],
    'production receipt bindings'
  );
  for (const [name, value] of Object.entries(receipt.bindings)) assertSha256(value, name);
  assertExactObjectKeys(
    receipt.runtime,
    ['node_version', 'node_abi', 'platform', 'arch', 'executable_sha256', 'license_sha256'],
    'production receipt runtime'
  );
  assertExactSemver(receipt.runtime.node_version, 'production Node version');
  if (
    !/^\d+$/.test(receipt.runtime.node_abi) ||
    receipt.runtime.platform !== 'darwin' ||
    receipt.runtime.arch !== 'arm64'
  ) {
    throw new Error('production receipt runtime identity is invalid.');
  }
  assertSha256(receipt.runtime.executable_sha256, 'runtime executable SHA-256');
  assertSha256(receipt.runtime.license_sha256, 'runtime license SHA-256');
  assertExactObjectKeys(
    receipt.verification,
    ['acp_smoke', 'relocated_path', 'final_archive_replay', 'codesign', 'gatekeeper', 'staple'],
    'production receipt verification'
  );
  if (Object.values(receipt.verification).some(value => value !== 'pass')) {
    throw new Error('production receipt contains an incomplete verification gate.');
  }
  assertExactObjectKeys(
    receipt.signing,
    ['status', 'team_id', 'identity_sha256', 'hardened_runtime', 'timestamp', 'notarization'],
    'production receipt signing'
  );
  if (
    receipt.signing.status !== 'developer_id' ||
    !/^[A-Z0-9]{10}$/.test(receipt.signing.team_id) ||
    receipt.signing.hardened_runtime !== true ||
    receipt.signing.timestamp !== true ||
    receipt.signing.notarization !== 'accepted'
  ) {
    throw new Error('production receipt is not signed and notarized for release.');
  }
  assertSha256(receipt.signing.identity_sha256, 'signing identity SHA-256');
  assertExactObjectKeys(receipt.policy, ['releasable', 'reasons'], 'production receipt policy');
  if (
    receipt.policy.releasable !== true ||
    !Array.isArray(receipt.policy.reasons) ||
    receipt.policy.reasons.length !== 0
  ) {
    throw new Error('production receipt policy is not releasable.');
  }
}

function validateProductionManifestShape(manifest) {
  assertExactObjectKeys(
    manifest,
    [
      'schema_version',
      'version',
      'git_sha',
      'target',
      'built_at',
      'acp_protocol',
      'studio_version_requirement',
      'node_version',
      'node_abi',
      'native_modules',
      'command',
      'sbom_path',
      'sbom_sha256',
      'notices_path',
      'notices_sha256',
      'files',
    ],
    'production manifest'
  );
  if (
    manifest.schema_version !== MANIFEST_SCHEMA_VERSION ||
    manifest.acp_protocol !== 1 ||
    manifest.target !== DARWIN_TARGET ||
    manifest.command !== DARWIN_COMMAND ||
    manifest.sbom_path !== 'SBOM.cdx.json' ||
    manifest.notices_path !== 'THIRD_PARTY_NOTICES'
  ) {
    throw new Error('production manifest contract is unsupported.');
  }
  assertExactSemver(manifest.version, 'production manifest version');
  assertGitSha(manifest.git_sha);
  assertRfc3339(manifest.built_at, 'production manifest built_at');
  assertExactSemver(manifest.node_version, 'production manifest Node version');
  if (!/^\d+$/.test(manifest.node_abi)) throw new Error('production manifest Node ABI is invalid.');
  if (
    typeof manifest.studio_version_requirement !== 'string' ||
    !SAFE_STUDIO_REQUIREMENT.test(manifest.studio_version_requirement) ||
    manifest.studio_version_requirement.includes('latest')
  ) {
    throw new Error('production manifest Studio requirement is invalid.');
  }
  assertSha256(manifest.sbom_sha256, 'production manifest SBOM SHA-256');
  assertSha256(manifest.notices_sha256, 'production manifest notices SHA-256');
  if (!Array.isArray(manifest.native_modules) || !Array.isArray(manifest.files)) {
    throw new Error('production manifest file collections are invalid.');
  }
  let previousPath = '';
  for (const file of manifest.files) {
    assertExactObjectKeys(file, ['path', 'mode', 'bytes', 'sha256'], 'production manifest file');
    assertSafeRelativePath(file.path, 'production manifest file path');
    if (previousPath && previousPath.localeCompare(file.path) >= 0) {
      throw new Error('production manifest files must be sorted and unique.');
    }
    previousPath = file.path;
    if (
      ![0o644, 0o755].includes(file.mode) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0
    ) {
      throw new Error('production manifest file metadata is invalid.');
    }
    assertSha256(file.sha256, 'production manifest file SHA-256');
  }
  const expectedNativeModules = manifest.files
    .filter(file => NATIVE_MODULE_EXTENSION.test(file.path))
    .map(file => file.path);
  if (
    canonicalJsonBytes(expectedNativeModules).compare(
      canonicalJsonBytes(manifest.native_modules)
    ) !== 0
  ) {
    throw new Error('production native module inventory does not match manifest files.');
  }
}

function requireSingleArchiveRoot(extractionDirectory) {
  const entries = readdirSync(extractionDirectory);
  if (entries.length !== 1 || entries[0] !== SIDECAR_ARCHIVE_ROOT) {
    throw new Error('archive must extract to the single frozen sidecar root.');
  }
  const root = join(extractionDirectory, SIDECAR_ARCHIVE_ROOT);
  return realDirectory(root, 'extracted sidecar root');
}

function parseAcceptedNotaryResult(output) {
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error('Apple notarization returned malformed status.');
  }
  if (
    !value ||
    value.status !== 'Accepted' ||
    typeof value.id !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(value.id)
  ) {
    throw new Error('Apple notarization did not accept the submitted bytes.');
  }
  return value;
}

function assertDarwinSigningConfiguration({ bundleId, signingIdentity, teamId }) {
  assertBundleIdentifier(bundleId);
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error('Apple Team ID format is invalid.');
  if (
    typeof signingIdentity !== 'string' ||
    !signingIdentity.startsWith('Developer ID Application: ') ||
    !signingIdentity.endsWith(` (${teamId})`) ||
    signingIdentity.length > 512
  ) {
    throw new Error('Developer ID signing identity does not match the configured Team ID.');
  }
}

function assertDeveloperIdMetadata(metadata, { signingIdentity, signingIdentitySha256, teamId }) {
  const authority = metadata
    .split(/\r?\n/)
    .find(line => line.startsWith('Authority=Developer ID Application: '))
    ?.slice('Authority='.length);
  if (
    !metadata.includes(`TeamIdentifier=${teamId}`) ||
    !authority ||
    (signingIdentity && authority !== signingIdentity) ||
    (signingIdentitySha256 &&
      sha256Bytes(Buffer.from(authority, 'utf8')) !== signingIdentitySha256) ||
    !/flags=.*runtime/im.test(metadata) ||
    !/(?:^|\n)Timestamp=/m.test(metadata)
  ) {
    throw new Error('Developer ID signature metadata did not match the frozen release identity.');
  }
}

function assertBundleIdentifier(value) {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > 255 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      value
    ) ||
    /(?:^|\.)(?:invalid|example|test)$/.test(value)
  ) {
    throw new Error('bundle ID must be an explicit production reverse-DNS identifier.');
  }
  return value;
}

function realDirectory(path, label) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory.`);
  }
  return realpathSync(path);
}

function realFile(path, label) {
  ensureRegularFile(path, label);
  const canonical = realpathSync(path);
  ensureRegularFile(canonical, label);
  return canonical;
}

function writePrivateFile(path, bytes) {
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  chmodSync(path, 0o600);
}

function scrubbedCommandEnvironment() {
  const environment = { ...process.env };
  for (const name of [
    'ORION_APPLE_DEVELOPER_ID_CERTIFICATE_P12_BASE64',
    'ORION_APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD',
    'ORION_APPLE_NOTARY_KEY_P8_BASE64',
    'ORION_UPDATE_INDEX_PRIVATE_KEY_PEM_BASE64',
    'ORION_RELEASE_UPLOAD_TOKEN',
  ]) {
    delete environment[name];
  }
  return environment;
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}
