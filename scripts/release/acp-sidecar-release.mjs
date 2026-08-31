import { spawn } from 'node:child_process';
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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { verifyDeterministicZip, writeDeterministicZip } from './deterministic-zip.mjs';
import {
  RELEASE_STATUS_NOT_RELEASABLE,
  SIDECAR_ARCHIVE_ROOT,
  SUPPORTED_SIDECAR_TARGETS,
  assertExactObjectKeys,
  assertExactSemver,
  assertGitSha,
  assertNoReceiptBinding,
  assertNoSecretPath,
  assertPathOutsideRoot,
  assertRfc3339,
  assertSafeBasename,
  assertSafeRelativePath,
  assertSha256,
  assertSupportedTarget,
  canonicalJsonBytes,
  commandOutput,
  ensureEmptyOutputDirectory,
  ensureRegularFile,
  hasFlag,
  isoFromEpochSeconds,
  isExcludedReleasePath,
  optionalOption,
  parseCliArguments,
  readJsonFile,
  realpathRegularFile,
  rejectUnknownOptions,
  requireOption,
  resolveContained,
  sanitizeTextPayload,
  sha256Bytes,
  sha256File,
  shouldTreatAsText,
  writeFileExclusive,
} from './release-tooling-common.mjs';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SIDECAR_RECEIPT_KIND = 'orion-code-acp-sidecar-release-receipt';
const SIDECAR_RECEIPT_SCHEMA_VERSION = 1;
const MANIFEST_SCHEMA_VERSION = 1;
const ACP_PROTOCOL_VERSION = 1;
const DARWIN_APP_BUNDLE = 'OrionCodeSidecar.app';
const DARWIN_APP_CONTENTS = `${DARWIN_APP_BUNDLE}/Contents`;
const DARWIN_APP_RESOURCES = `${DARWIN_APP_CONTENTS}/Resources`;
const DARWIN_SIDECAR_COMMAND = `${DARWIN_APP_CONTENTS}/MacOS/orion-code-acp`;
const DARWIN_INFO_PLIST = `${DARWIN_APP_CONTENTS}/Info.plist`;
const DARWIN_NODE_RUNTIME = `${DARWIN_APP_RESOURCES}/runtime/node`;
const DARWIN_NODE_LICENSE = `${DARWIN_APP_RESOURCES}/NODE_LICENSE`;
const MAX_LICENSE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const SAFE_STUDIO_REQUIREMENT = /^[0-9A-Za-z<>=.,*^~|+ -]{1,256}$/;
const SOURCE_IMPORT = /(?:\brequire\s*\(|\bfrom\s+|\bimport\s*\()\s*['"]([^'"]+)['"]/g;
const PACKAGE_EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.github',
  '.cache',
  'benchmark',
  'benchmarks',
  'coverage',
  'docs',
  'example',
  'examples',
  'test',
  'tests',
  '__tests__',
]);
const PACKAGE_EXCLUDED_FILES = [
  /\.(?:d\.ts|d\.mts|map|ts|tsx)$/i,
  /^(?:changelog|history|readme)(?:[-_.].*)?$/i,
];

export function parseBuildAcpSidecarArguments(argv) {
  const parsed = parseCliArguments(argv);
  const allowedValues = new Set([
    '--version',
    '--git-sha',
    '--target',
    '--out',
    '--node-runtime',
    '--node-license',
    '--bundle-id',
    '--studio-version-requirement',
    '--source-date-epoch',
    '--local-fixture-package-root',
  ]);
  const allowedFlags = new Set(['--local-unsigned', '--skip-build', '--skip-smoke', '--help']);
  rejectUnknownOptions(parsed, allowedValues, allowedFlags);
  if (hasFlag(parsed, '--help')) return { help: true };
  const localUnsigned = hasFlag(parsed, '--local-unsigned');
  const skipBuild = hasFlag(parsed, '--skip-build');
  const skipSmoke = hasFlag(parsed, '--skip-smoke');
  if ((skipBuild || skipSmoke) && !localUnsigned) {
    throw new Error(
      '--skip-build and --skip-smoke are allowed only for local unsigned candidates.'
    );
  }
  const localFixturePackageRoot = optionalOption(parsed, '--local-fixture-package-root');
  if (localFixturePackageRoot && !(localUnsigned && skipBuild && skipSmoke)) {
    throw new Error(
      '--local-fixture-package-root requires --local-unsigned, --skip-build, and --skip-smoke.'
    );
  }
  const sourceDateEpochValue = optionalOption(parsed, '--source-date-epoch');
  const sourceDateEpoch =
    sourceDateEpochValue === undefined ? undefined : parseNonNegativeInteger(sourceDateEpochValue);
  return {
    help: false,
    version: assertExactSemver(requireOption(parsed, '--version')),
    gitSha: assertGitSha(requireOption(parsed, '--git-sha')),
    target: assertSupportedTarget(requireOption(parsed, '--target')),
    outputDirectory: resolve(requireOption(parsed, '--out')),
    nodeRuntime: resolve(requireOption(parsed, '--node-runtime')),
    nodeLicense: resolve(requireOption(parsed, '--node-license')),
    bundleId: assertBundleIdentifier(requireOption(parsed, '--bundle-id')),
    studioVersionRequirement: assertStudioRequirement(
      requireOption(parsed, '--studio-version-requirement')
    ),
    sourceDateEpoch,
    packageRoot: localFixturePackageRoot ? resolve(localFixturePackageRoot) : undefined,
    localUnsigned,
    skipBuild,
    skipSmoke,
  };
}

export function buildAcpSidecarUsage() {
  return [
    'Usage: npm run release:acp-sidecar -- --version <exact-semver> --git-sha <40-hex>',
    '  --target darwin-aarch64 --out <empty-directory>',
    '  --node-runtime <absolute-node-executable> --node-license <Node-LICENSE>',
    '  --bundle-id <required-reverse-dns-identifier>',
    '  --studio-version-requirement <semver-requirement>',
    '  [--local-unsigned] [--skip-build] [--skip-smoke] [--source-date-epoch <seconds>]',
    '  [--local-fixture-package-root <clean-test-package>]',
    '',
    'This command never signs, notarizes, uploads, publishes, or produces a releasable artifact.',
  ].join('\n');
}

export async function buildAcpSidecar(options) {
  const packageRoot = realpathSync(options.packageRoot ?? PACKAGE_ROOT);
  const version = assertExactSemver(options.version);
  const gitSha = assertGitSha(options.gitSha);
  const target = assertSupportedTarget(options.target);
  const bundleId = assertBundleIdentifier(options.bundleId);
  const studioVersionRequirement = assertStudioRequirement(options.studioVersionRequirement);
  const outputDirectory = resolve(options.outputDirectory);
  const nodeRuntime = realpathRegularFile(options.nodeRuntime, 'embedded Node runtime');
  const nodeLicense = realpathRegularFile(options.nodeLicense, 'embedded Node license');
  assertPathOutsideRoot(outputDirectory, packageRoot, 'output directory');
  ensureEmptyOutputDirectory(outputDirectory);
  const canonicalOutput = realpathSync(outputDirectory);
  assertPathOutsideRoot(canonicalOutput, packageRoot, 'output directory');

  const packageManifest = readJsonFile(join(packageRoot, 'package.json'), 'package.json');
  if (packageManifest.name !== '@orion-agents/orion-code' || packageManifest.version !== version) {
    throw new Error('requested version must exactly match the Orion Code package manifest.');
  }
  const source = options.sourceOverride ?? captureSourceState(packageRoot);
  if (source.gitSha !== gitSha) throw new Error('requested git SHA must exactly match HEAD.');
  if (source.dirty && !options.localUnsigned) {
    throw new Error(
      'dirty source may only build with --local-unsigned and remains NOT RELEASABLE.'
    );
  }
  if (!source.dirty && options.sourceDateEpoch !== undefined) {
    throw new Error('clean candidates derive SOURCE_DATE_EPOCH from the exact git commit.');
  }
  const sourceDateEpoch = options.sourceDateEpoch ?? source.sourceDateEpoch;
  const builtAt = isoFromEpochSeconds(sourceDateEpoch);
  const locked = verifyLockedInputs(packageRoot, packageManifest);
  const runtime = probeNodeRuntime(nodeRuntime, target);
  const runtimeLicense = readBoundedText(nodeLicense, MAX_LICENSE_BYTES, 'Node runtime license');
  if (runtimeLicense.trim().length === 0) throw new Error('Node runtime license is empty.');

  if (!options.skipBuild) {
    commandOutput('npm', ['run', 'build:server'], packageRoot, 128 * 1024 * 1024);
  }
  const serverEntry = join(packageRoot, 'dist', 'acp', 'server.mjs');
  ensureRegularFile(serverEntry, 'built ACP entry');

  const temporaryRoot = mkdtempSync(join(tmpdir(), 'orion-code-release-'));
  const releaseDirectory = join(temporaryRoot, 'release-output');
  const relocatedParent = join(temporaryRoot, 'Relocated 路径 with spaces');
  const sidecarRoot = join(relocatedParent, SIDECAR_ARCHIVE_ROOT);
  mkdirSync(sidecarRoot, { recursive: true, mode: 0o700 });
  mkdirSync(releaseDirectory, { recursive: true, mode: 0o700 });
  try {
    const forbiddenAbsolutePaths = [packageRoot, dirname(packageRoot), process.env.HOME].filter(
      value => typeof value === 'string' && value.length > 1
    );
    copyRuntime(nodeRuntime, nodeLicense, sidecarRoot, forbiddenAbsolutePaths);
    copyApplication(packageRoot, sidecarRoot, packageManifest, locked, forbiddenAbsolutePaths);
    writePayloadFile(
      join(sidecarRoot, DARWIN_INFO_PLIST),
      createDarwinInfoPlist({ bundleId, version, sourceDateEpoch }),
      0o644
    );
    const licenseInventory = collectLicenseInventory(packageRoot, locked.productionPackages);
    const noticesBytes = createThirdPartyNotices(licenseInventory);
    const sbomBytes = createCycloneDxSbom({
      packageManifest,
      source,
      builtAt,
      lockSha256: locked.lockSha256,
      runtime,
      productionPackages: locked.productionPackages,
      licenseInventory,
    });
    writePayloadFile(
      join(sidecarRoot, 'LICENSE'),
      readFileSync(join(packageRoot, 'LICENSE')),
      0o644
    );
    writePayloadFile(join(sidecarRoot, 'THIRD_PARTY_NOTICES'), noticesBytes, 0o644);
    writePayloadFile(join(sidecarRoot, 'SBOM.cdx.json'), sbomBytes, 0o644);
    writePayloadFile(
      join(sidecarRoot, 'NOT_RELEASABLE.txt'),
      Buffer.from(
        [
          'NOT RELEASABLE',
          'This local artifact is unsigned and not notarized.',
          source.dirty ? 'The source checkout was dirty.' : 'The source checkout was clean.',
          'It must not be uploaded, indexed by a release key, or distributed as Stable.',
          '',
        ].join('\n'),
        'utf8'
      ),
      0o644
    );

    const payloadFiles = await collectPayloadManifest(sidecarRoot, 'manifest.json');
    const sbomSha256 = sha256Bytes(sbomBytes);
    const noticesSha256 = sha256Bytes(noticesBytes);
    const nativeModules = payloadFiles
      .filter(file => /\.(?:node|dylib|so|dll)$/i.test(file.path))
      .map(file => file.path);
    const manifest = {
      schema_version: MANIFEST_SCHEMA_VERSION,
      version,
      git_sha: gitSha,
      target,
      built_at: builtAt,
      acp_protocol: ACP_PROTOCOL_VERSION,
      studio_version_requirement: studioVersionRequirement,
      node_version: runtime.nodeVersion,
      node_abi: runtime.nodeAbi,
      native_modules: nativeModules,
      command: DARWIN_SIDECAR_COMMAND,
      sbom_path: 'SBOM.cdx.json',
      sbom_sha256: sbomSha256,
      notices_path: 'THIRD_PARTY_NOTICES',
      notices_sha256: noticesSha256,
      files: payloadFiles,
    };
    assertNoReceiptBinding(manifest);
    const manifestBytes = canonicalJsonBytes(manifest);
    writePayloadFile(join(sidecarRoot, 'manifest.json'), manifestBytes, 0o644);
    assertStagedPayloadSafe(sidecarRoot, forbiddenAbsolutePaths);

    const smoke = options.skipSmoke
      ? { acpSmoke: 'skipped_local_unsigned', relocatedPath: 'not_verified' }
      : await runRelocatedAcpSmoke(sidecarRoot, version, temporaryRoot);
    const artifactStem = `orion-code-sidecar-${version}-${target}-NOT-RELEASABLE`;
    const archiveFilename = `${artifactStem}.zip`;
    const receiptFilename = `${artifactStem}.receipt.json`;
    const archivePath = join(releaseDirectory, archiveFilename);
    await writeDeterministicZip({
      sourceDirectory: sidecarRoot,
      outputPath: archivePath,
      archiveRoot: SIDECAR_ARCHIVE_ROOT,
    });
    const finalArchive = await verifyDeterministicZip(archivePath, {
      selectedEntries: [
        `${SIDECAR_ARCHIVE_ROOT}/manifest.json`,
        `${SIDECAR_ARCHIVE_ROOT}/SBOM.cdx.json`,
        `${SIDECAR_ARCHIVE_ROOT}/THIRD_PARTY_NOTICES`,
        `${SIDECAR_ARCHIVE_ROOT}/${DARWIN_INFO_PLIST}`,
      ],
    });
    const finalManifestSha256 = sha256Bytes(
      finalArchive.selectedBytes.get(`${SIDECAR_ARCHIVE_ROOT}/manifest.json`)
    );
    const finalSbomSha256 = sha256Bytes(
      finalArchive.selectedBytes.get(`${SIDECAR_ARCHIVE_ROOT}/SBOM.cdx.json`)
    );
    const finalNoticesSha256 = sha256Bytes(
      finalArchive.selectedBytes.get(`${SIDECAR_ARCHIVE_ROOT}/THIRD_PARTY_NOTICES`)
    );
    const finalInfoPlist = finalArchive.selectedBytes.get(
      `${SIDECAR_ARCHIVE_ROOT}/${DARWIN_INFO_PLIST}`
    );
    if (
      finalManifestSha256 !== sha256Bytes(manifestBytes) ||
      finalSbomSha256 !== sbomSha256 ||
      finalNoticesSha256 !== noticesSha256 ||
      finalInfoPlist?.compare(createDarwinInfoPlist({ bundleId, version, sourceDateEpoch })) !== 0
    ) {
      throw new Error('final archive component bytes drifted before receipt generation.');
    }
    const finalEntries = new Map(finalArchive.entries.map(entry => [entry.path, entry]));
    const runtimeExecutable = finalEntries.get(`${SIDECAR_ARCHIVE_ROOT}/${DARWIN_NODE_RUNTIME}`);
    const runtimeLicenseDigest = finalEntries.get(`${SIDECAR_ARCHIVE_ROOT}/${DARWIN_NODE_LICENSE}`);
    if (!runtimeExecutable || !runtimeLicenseDigest) {
      throw new Error('final archive is missing its embedded runtime evidence.');
    }
    const receipt = {
      schema_version: SIDECAR_RECEIPT_SCHEMA_VERSION,
      kind: SIDECAR_RECEIPT_KIND,
      release_status: RELEASE_STATUS_NOT_RELEASABLE,
      source: {
        package_name: packageManifest.name,
        version,
        git_sha: gitSha,
        dirty: Boolean(source.dirty),
        source_date_epoch: sourceDateEpoch,
        lock_sha256: locked.lockSha256,
      },
      artifact: {
        filename: archiveFilename,
        bytes: finalArchive.bytes,
        format: 'zip',
        archive_root: SIDECAR_ARCHIVE_ROOT,
        target,
        command: DARWIN_SIDECAR_COMMAND,
        bundle_id: bundleId,
      },
      bindings: {
        archive_sha256: finalArchive.sha256,
        manifest_sha256: finalManifestSha256,
        sbom_sha256: finalSbomSha256,
        notices_sha256: finalNoticesSha256,
      },
      runtime: {
        node_version: runtime.nodeVersion,
        node_abi: runtime.nodeAbi,
        platform: runtime.platform,
        arch: runtime.arch,
        executable_sha256: runtimeExecutable.sha256,
        license_sha256: runtimeLicenseDigest.sha256,
      },
      verification: {
        acp_smoke: smoke.acpSmoke,
        relocated_path: smoke.relocatedPath,
      },
      signing: {
        status: 'unsigned',
        notarization: 'not_checked',
      },
      policy: {
        releasable: false,
        reasons: source.dirty
          ? ['dirty_source', 'unsigned', 'not_notarized']
          : ['unsigned', 'not_notarized'],
      },
    };
    const receiptPath = join(releaseDirectory, receiptFilename);
    writeFileExclusive(receiptPath, canonicalJsonBytes(receipt));
    await verifyAcpSidecarReceipt(receiptPath);

    const markerPath = join(releaseDirectory, 'NOT_RELEASABLE.txt');
    writeFileExclusive(
      markerPath,
      Buffer.from('NOT RELEASABLE: local unsigned Orion Code sidecar candidate.\n', 'utf8')
    );
    copyExclusive(archivePath, join(canonicalOutput, archiveFilename), 0o600);
    copyExclusive(receiptPath, join(canonicalOutput, receiptFilename), 0o600);
    copyExclusive(markerPath, join(canonicalOutput, 'NOT_RELEASABLE.txt'), 0o600);
    return {
      archivePath: join(canonicalOutput, archiveFilename),
      receiptPath: join(canonicalOutput, receiptFilename),
      markerPath: join(canonicalOutput, 'NOT_RELEASABLE.txt'),
      receipt,
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export async function verifyAcpSidecarReceipt(receiptPath, explicitArchivePath) {
  const canonicalReceipt = realpathRegularFile(receiptPath, 'sidecar receipt');
  if (lstatSync(canonicalReceipt).size > MAX_RECEIPT_BYTES) {
    throw new Error('sidecar receipt exceeds 1 MiB.');
  }
  const receipt = readJsonFile(canonicalReceipt, 'sidecar receipt');
  validateReceiptShape(receipt);
  const receiptDirectory = dirname(canonicalReceipt);
  const archivePath = explicitArchivePath
    ? realpathRegularFile(explicitArchivePath, 'sidecar archive')
    : realpathRegularFile(
        resolveContained(receiptDirectory, receipt.artifact.filename, 'receipt archive filename'),
        'sidecar archive'
      );
  if (basename(archivePath) !== receipt.artifact.filename) {
    throw new Error('receipt archive filename does not match the replayed archive.');
  }
  const root = receipt.artifact.archive_root;
  const manifestArchivePath = `${root}/manifest.json`;
  const sbomArchivePath = `${root}/SBOM.cdx.json`;
  const noticesArchivePath = `${root}/THIRD_PARTY_NOTICES`;
  const infoPlistArchivePath = `${root}/${DARWIN_INFO_PLIST}`;
  const archive = await verifyDeterministicZip(archivePath, {
    selectedEntries: [
      manifestArchivePath,
      sbomArchivePath,
      noticesArchivePath,
      infoPlistArchivePath,
    ],
  });
  if (archive.bytes !== receipt.artifact.bytes) throw new Error('archive byte count drifted.');
  if (archive.sha256 !== receipt.bindings.archive_sha256) {
    throw new Error('archive SHA-256 does not match the external receipt.');
  }
  const manifestBytes = archive.selectedBytes.get(manifestArchivePath);
  const sbomBytes = archive.selectedBytes.get(sbomArchivePath);
  const noticesBytes = archive.selectedBytes.get(noticesArchivePath);
  const infoPlistBytes = archive.selectedBytes.get(infoPlistArchivePath);
  if (sha256Bytes(manifestBytes) !== receipt.bindings.manifest_sha256) {
    throw new Error('manifest SHA-256 does not match the external receipt.');
  }
  if (sha256Bytes(sbomBytes) !== receipt.bindings.sbom_sha256) {
    throw new Error('SBOM SHA-256 does not match the external receipt.');
  }
  if (sha256Bytes(noticesBytes) !== receipt.bindings.notices_sha256) {
    throw new Error('notices SHA-256 does not match the external receipt.');
  }

  const manifest = parseJsonBytes(manifestBytes, 'archive manifest');
  validateManifestShape(manifest);
  assertNoReceiptBinding(manifest);
  if (
    manifest.version !== receipt.source.version ||
    manifest.git_sha !== receipt.source.git_sha ||
    manifest.target !== receipt.artifact.target ||
    manifest.command !== DARWIN_SIDECAR_COMMAND ||
    manifest.command !== receipt.artifact.command ||
    manifest.node_version !== receipt.runtime.node_version ||
    manifest.node_abi !== receipt.runtime.node_abi
  ) {
    throw new Error('archive manifest identity does not match the external receipt.');
  }
  if (
    manifest.sbom_path !== 'SBOM.cdx.json' ||
    manifest.notices_path !== 'THIRD_PARTY_NOTICES' ||
    manifest.sbom_sha256 !== receipt.bindings.sbom_sha256 ||
    manifest.notices_sha256 !== receipt.bindings.notices_sha256
  ) {
    throw new Error('archive manifest component bindings drifted.');
  }
  const expectedFiles = archive.entries
    .filter(entry => entry.path !== manifestArchivePath)
    .map(entry => {
      if (!entry.path.startsWith(`${root}/`)) throw new Error('archive entry escaped its root.');
      const path = entry.path.slice(root.length + 1);
      assertAllowedArchivePayloadPath(path);
      return {
        path,
        mode: entry.mode & 0o777,
        bytes: entry.bytes,
        sha256: entry.sha256,
      };
    });
  if (canonicalJsonBytes(expectedFiles).compare(canonicalJsonBytes(manifest.files)) !== 0) {
    throw new Error('archive manifest file list does not match final archive bytes.');
  }
  const expectedFileMap = new Map(expectedFiles.map(file => [file.path, file]));
  if (
    expectedFileMap.get(DARWIN_NODE_RUNTIME)?.sha256 !== receipt.runtime.executable_sha256 ||
    expectedFileMap.get(DARWIN_NODE_LICENSE)?.sha256 !== receipt.runtime.license_sha256
  ) {
    throw new Error('embedded runtime evidence does not match final archive bytes.');
  }
  const expectedInfoPlist = createDarwinInfoPlist({
    bundleId: receipt.artifact.bundle_id,
    version: receipt.source.version,
    sourceDateEpoch: receipt.source.source_date_epoch,
  });
  if (!infoPlistBytes || infoPlistBytes.compare(expectedInfoPlist) !== 0) {
    throw new Error('deterministic Info.plist does not match the receipt bundle identity.');
  }
  const sbom = parseJsonBytes(sbomBytes, 'CycloneDX SBOM');
  if (sbom.bomFormat !== 'CycloneDX' || sbom.specVersion !== '1.5' || sbom.version !== 1) {
    throw new Error('archive SBOM is not the required CycloneDX 1.5 document.');
  }
  if (noticesBytes.toString('utf8').trim().length === 0) {
    throw new Error('archive third-party notices are empty.');
  }
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
      signing_requirement: signingRequirementForTarget(receipt.artifact.target),
    },
  };
}

export function captureSourceState(packageRoot) {
  const gitSha = commandOutput('git', ['rev-parse', 'HEAD'], packageRoot);
  assertGitSha(gitSha);
  const dirty =
    commandOutput('git', ['status', '--porcelain=v1', '--untracked-files=all'], packageRoot)
      .length > 0;
  const sourceDateEpoch = parseNonNegativeInteger(
    commandOutput('git', ['show', '-s', '--format=%ct', gitSha], packageRoot)
  );
  return { gitSha, dirty, sourceDateEpoch };
}

export function verifyLockedInputs(packageRoot, packageManifest) {
  const lockPath = join(packageRoot, 'npm-shrinkwrap.json');
  const lock = readJsonFile(lockPath, 'npm-shrinkwrap.json');
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') {
    throw new Error('npm-shrinkwrap.json must be a lockfileVersion 3 package lock.');
  }
  const root = lock.packages[''];
  if (!root || root.name !== packageManifest.name || root.version !== packageManifest.version) {
    throw new Error('npm-shrinkwrap root identity does not match package.json.');
  }
  for (const field of ['dependencies', 'devDependencies', 'engines']) {
    if (JSON.stringify(root[field] ?? {}) !== JSON.stringify(packageManifest[field] ?? {})) {
      throw new Error(`npm-shrinkwrap ${field} does not exactly match package.json.`);
    }
  }
  const productionPackages = [];
  for (const [lockPathKey, metadata] of Object.entries(lock.packages)) {
    if (!lockPathKey || metadata.dev || !lockPathKey.startsWith('node_modules/')) continue;
    assertSafeRelativePath(lockPathKey, 'locked package path');
    const sourceDirectory = resolveContained(packageRoot, lockPathKey, 'locked package path');
    if (!existsSync(sourceDirectory)) {
      if (metadata.optional) continue;
      throw new Error(`locked production package is not installed: ${lockPathKey}`);
    }
    const directoryMetadata = lstatSync(sourceDirectory);
    if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
      throw new Error(`locked production package must be a real directory: ${lockPathKey}`);
    }
    const installedManifest = readJsonFile(
      join(sourceDirectory, 'package.json'),
      'dependency package.json'
    );
    if (installedManifest.version !== metadata.version) {
      throw new Error(`installed production package version drifted: ${lockPathKey}`);
    }
    productionPackages.push({
      lockPath: lockPathKey,
      sourceDirectory,
      metadata,
      packageManifest: installedManifest,
      name: installedManifest.name,
      version: installedManifest.version,
    });
  }
  productionPackages.sort((left, right) => left.lockPath.localeCompare(right.lockPath));
  return {
    lock,
    lockSha256: sha256Bytes(readFileSync(lockPath)),
    productionPackages,
  };
}

export function auditAcpSidecarSource(packageRoot = PACKAGE_ROOT) {
  const canonicalRoot = realpathSync(packageRoot);
  const packageManifest = readJsonFile(join(canonicalRoot, 'package.json'), 'package.json');
  const locked = verifyLockedInputs(canonicalRoot, packageManifest);
  const moduleGraph = collectLocalModuleGraph(canonicalRoot, 'dist/acp/server.mjs');
  const forbiddenAbsolutePaths = [canonicalRoot, dirname(canonicalRoot), process.env.HOME].filter(
    value => typeof value === 'string' && value.length > 1
  );
  for (const relativePath of moduleGraph) {
    const source = join(canonicalRoot, relativePath);
    const metadata = ensureRegularFile(source, 'compiled module');
    if (shouldTreatAsText(relativePath) && metadata.size <= MAX_TEXT_PAYLOAD_BYTES) {
      sanitizeTextPayload(readFileSync(source), relativePath, forbiddenAbsolutePaths);
    }
  }
  for (const dependency of locked.productionPackages) {
    validateDependencyPackageTree(dependency, forbiddenAbsolutePaths);
  }
  const licenses = collectLicenseInventory(canonicalRoot, locked.productionPackages);
  return {
    lockSha256: locked.lockSha256,
    productionPackages: locked.productionPackages.length,
    compiledModules: moduleGraph.size,
    licenseEntries: licenses.length,
  };
}

function probeNodeRuntime(nodeRuntime, target) {
  const expression =
    'JSON.stringify({nodeVersion:process.version,nodeAbi:process.versions.modules,platform:process.platform,arch:process.arch})';
  let runtime;
  try {
    runtime = JSON.parse(commandOutput(nodeRuntime, ['-p', expression], dirname(nodeRuntime)));
  } catch (error) {
    throw new Error(
      `embedded Node runtime probe failed: ${error instanceof Error ? error.message : error}`
    );
  }
  const expected = SUPPORTED_SIDECAR_TARGETS[target];
  if (runtime.platform !== expected.platform || runtime.arch !== expected.arch) {
    throw new Error('embedded Node runtime platform/architecture does not match the exact target.');
  }
  const versionMatch = /^v(\d+)\.(\d+)\.(\d+)$/.exec(runtime.nodeVersion ?? '');
  if (!versionMatch) throw new Error('embedded Node runtime returned an invalid version.');
  const major = Number(versionMatch[1]);
  const minor = Number(versionMatch[2]);
  if (!((major === 22 && minor >= 12) || major === 24 || major === 26)) {
    throw new Error(`embedded Node runtime ${runtime.nodeVersion} is unsupported.`);
  }
  if (typeof runtime.nodeAbi !== 'string' || !/^\d+$/.test(runtime.nodeAbi)) {
    throw new Error('embedded Node runtime returned an invalid ABI.');
  }
  return { ...runtime, nodeVersion: runtime.nodeVersion.slice(1) };
}

function copyRuntime(nodeRuntime, nodeLicense, sidecarRoot, forbiddenAbsolutePaths) {
  copyNormalizedFile(
    nodeRuntime,
    join(sidecarRoot, DARWIN_NODE_RUNTIME),
    DARWIN_NODE_RUNTIME,
    forbiddenAbsolutePaths,
    0o755
  );
  const licenseBytes = Buffer.from(readBoundedText(nodeLicense, MAX_LICENSE_BYTES, 'Node license'));
  const sanitized = sanitizeTextPayload(licenseBytes, DARWIN_NODE_LICENSE, forbiddenAbsolutePaths);
  writePayloadFile(join(sidecarRoot, DARWIN_NODE_LICENSE), sanitized, 0o644);
}

function copyApplication(
  packageRoot,
  sidecarRoot,
  packageManifest,
  locked,
  forbiddenAbsolutePaths
) {
  const appRoot = join(sidecarRoot, DARWIN_APP_RESOURCES, 'app');
  const minimalManifest = {
    name: packageManifest.name,
    version: packageManifest.version,
    private: true,
    type: 'commonjs',
    engines: packageManifest.engines,
  };
  writePayloadFile(join(appRoot, 'package.json'), canonicalJsonBytes(minimalManifest), 0o644);
  const graph = collectLocalModuleGraph(packageRoot, 'dist/acp/server.mjs');
  const builtinSkills = join(packageRoot, 'dist', 'skills', 'builtin');
  if (existsSync(builtinSkills)) {
    for (const relativePath of walkFilesNoLinks(builtinSkills)) {
      graph.add(`dist/skills/builtin/${relativePath}`);
    }
  }
  for (const relativePath of [...graph].sort()) {
    assertNoSecretPath(relativePath);
    if (isExcludedReleasePath(relativePath)) continue;
    copyNormalizedFile(
      join(packageRoot, relativePath),
      join(appRoot, relativePath),
      `${DARWIN_APP_RESOURCES}/app/${relativePath}`,
      forbiddenAbsolutePaths,
      0o644
    );
  }
  for (const dependency of locked.productionPackages) {
    copyDependencyPackage(dependency, appRoot, forbiddenAbsolutePaths);
  }
  const launcher = Buffer.from(
    [
      '#!/bin/sh',
      'set -eu',
      'CONTENTS_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)',
      'export ORION_CODE_DISABLE_ENV_FILES=1',
      'exec "$CONTENTS_ROOT/Resources/runtime/node" "$CONTENTS_ROOT/Resources/app/launch-acp.mjs" "$@"',
      '',
    ].join('\n'),
    'utf8'
  );
  writePayloadFile(join(sidecarRoot, DARWIN_SIDECAR_COMMAND), launcher, 0o755);
  const entry = Buffer.from(
    [
      "process.env.ORION_CODE_DISABLE_ENV_FILES = '1';",
      "const { startOrionAcpServer } = await import('./dist/acp/server.mjs');",
      'await startOrionAcpServer();',
      '',
    ].join('\n'),
    'utf8'
  );
  writePayloadFile(join(appRoot, 'launch-acp.mjs'), entry, 0o644);
}

function createDarwinInfoPlist({ bundleId, version, sourceDateEpoch }) {
  assertBundleIdentifier(bundleId);
  assertExactSemver(version, 'bundle version');
  const shortVersion = version.split(/[+-]/, 1)[0];
  const bundleVersion = String(parseNonNegativeInteger(sourceDateEpoch));
  return Buffer.from(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>CFBundleDevelopmentRegion</key>',
      '  <string>en</string>',
      '  <key>CFBundleExecutable</key>',
      '  <string>orion-code-acp</string>',
      '  <key>CFBundleIdentifier</key>',
      `  <string>${bundleId}</string>`,
      '  <key>CFBundleInfoDictionaryVersion</key>',
      '  <string>6.0</string>',
      '  <key>CFBundleName</key>',
      '  <string>Orion Code Sidecar</string>',
      '  <key>CFBundlePackageType</key>',
      '  <string>APPL</string>',
      '  <key>CFBundleShortVersionString</key>',
      `  <string>${shortVersion}</string>`,
      '  <key>CFBundleVersion</key>',
      `  <string>${bundleVersion}</string>`,
      '  <key>LSBackgroundOnly</key>',
      '  <true/>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n'),
    'utf8'
  );
}

function collectLocalModuleGraph(packageRoot, entryPath) {
  const graph = new Set();
  const queue = [entryPath];
  while (queue.length > 0) {
    const relativePath = queue.shift();
    if (graph.has(relativePath)) continue;
    assertSafeRelativePath(relativePath, 'compiled module path');
    const absolutePath = resolveContained(packageRoot, relativePath, 'compiled module path');
    ensureRegularFile(absolutePath, 'compiled module');
    graph.add(relativePath);
    if (!/\.(?:js|mjs|cjs)$/i.test(relativePath)) continue;
    const source = readBoundedText(absolutePath, MAX_TEXT_PAYLOAD_BYTES, 'compiled module');
    SOURCE_IMPORT.lastIndex = 0;
    let match;
    while ((match = SOURCE_IMPORT.exec(source)) !== null) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue;
      const resolvedModule = resolveLocalModule(packageRoot, relativePath, specifier);
      if (resolvedModule && resolvedModule.startsWith('dist/')) queue.push(resolvedModule);
    }
  }
  return graph;
}

function resolveLocalModule(packageRoot, importer, specifier) {
  const base = resolve(dirname(join(packageRoot, importer)), specifier);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.json`,
    join(base, 'index.js'),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const metadata = lstatSync(candidate);
    if (metadata.isSymbolicLink()) throw new Error('compiled module graph contains a symlink.');
    if (!metadata.isFile()) continue;
    const relativePath = relative(packageRoot, candidate).split('\\').join('/');
    if (!relativePath.startsWith('dist/')) {
      throw new Error('compiled module import escaped dist/.');
    }
    return relativePath;
  }
  throw new Error(`compiled module dependency is missing for ${importer}.`);
}

function copyDependencyPackage(dependency, appRoot, forbiddenAbsolutePaths) {
  validateDependencyPackageTree(dependency, forbiddenAbsolutePaths);
  const destinationRoot = join(appRoot, dependency.lockPath);
  const visit = (sourceDirectory, destinationDirectory, relativeWithinPackage) => {
    for (const name of readdirSync(sourceDirectory).sort()) {
      const sourcePath = join(sourceDirectory, name);
      const metadata = lstatSync(sourcePath);
      if (metadata.isSymbolicLink()) {
        throw new Error(`production dependency contains a symlink: ${dependency.lockPath}/${name}`);
      }
      const packageRelative = relativeWithinPackage ? `${relativeWithinPackage}/${name}` : name;
      const payloadRelative = `${dependency.lockPath}/${packageRelative}`;
      if (metadata.isDirectory()) {
        if (name === 'node_modules' || PACKAGE_EXCLUDED_DIRECTORIES.has(name.toLowerCase()))
          continue;
        visit(sourcePath, join(destinationDirectory, name), packageRelative);
        continue;
      }
      if (!metadata.isFile())
        throw new Error(`production dependency has a non-file: ${payloadRelative}`);
      assertNoSecretPath(payloadRelative);
      if (PACKAGE_EXCLUDED_FILES.some(pattern => pattern.test(name))) continue;
      copyNormalizedFile(
        sourcePath,
        join(destinationDirectory, name),
        `${DARWIN_APP_RESOURCES}/app/${payloadRelative}`,
        forbiddenAbsolutePaths,
        metadata.mode & 0o111 ? 0o755 : 0o644
      );
    }
  };
  visit(dependency.sourceDirectory, destinationRoot, '');
}

function validateDependencyPackageTree(dependency, forbiddenAbsolutePaths) {
  const visit = (sourceDirectory, relativeWithinPackage) => {
    for (const name of readdirSync(sourceDirectory).sort()) {
      const sourcePath = join(sourceDirectory, name);
      const metadata = lstatSync(sourcePath);
      const packageRelative = relativeWithinPackage ? `${relativeWithinPackage}/${name}` : name;
      const payloadRelative = `${dependency.lockPath}/${packageRelative}`;
      if (metadata.isSymbolicLink()) {
        throw new Error(`production dependency contains a symlink: ${payloadRelative}`);
      }
      if (metadata.isDirectory()) {
        if (name === 'node_modules' || PACKAGE_EXCLUDED_DIRECTORIES.has(name.toLowerCase()))
          continue;
        visit(sourcePath, packageRelative);
        continue;
      }
      if (!metadata.isFile())
        throw new Error(`production dependency has a non-file: ${payloadRelative}`);
      assertNoSecretPath(payloadRelative);
      if (PACKAGE_EXCLUDED_FILES.some(pattern => pattern.test(name))) continue;
      if (shouldTreatAsText(payloadRelative) && metadata.size <= MAX_TEXT_PAYLOAD_BYTES) {
        sanitizeTextPayload(readFileSync(sourcePath), payloadRelative, forbiddenAbsolutePaths);
      }
    }
  };
  visit(dependency.sourceDirectory, '');
}

function collectLicenseInventory(packageRoot, productionPackages) {
  return productionPackages.map(dependency => {
    const expression = normalizeLicenseExpression(
      dependency.packageManifest.license ?? dependency.metadata.license
    );
    const licenseFile = findLicenseFile(dependency.sourceDirectory);
    const licenseText = licenseFile
      ? readBoundedText(licenseFile, MAX_LICENSE_BYTES, `license for ${dependency.name}`)
      : undefined;
    const resolvedExpression = expression ?? detectLicenseExpression(licenseText);
    if (!resolvedExpression) {
      throw new Error(
        `production dependency ${dependency.name}@${dependency.version} has no license evidence.`
      );
    }
    return {
      lockPath: dependency.lockPath,
      name: dependency.name,
      version: dependency.version,
      expression: resolvedExpression,
      licenseText,
      licenseSha256: licenseText ? sha256Bytes(Buffer.from(licenseText, 'utf8')) : undefined,
    };
  });
}

function createThirdPartyNotices(inventory) {
  const sections = [
    'THIRD_PARTY_NOTICES',
    'Generated from the exact production dependency lock used by this candidate.',
    '',
  ];
  for (const component of inventory) {
    sections.push(`${component.name}@${component.version}`);
    sections.push(`Installed path: ${component.lockPath}`);
    sections.push(`License: ${component.expression}`);
    if (component.licenseSha256) sections.push(`License text SHA-256: ${component.licenseSha256}`);
    sections.push('');
    if (component.licenseText) sections.push(component.licenseText.trim(), '');
  }
  return Buffer.from(`${sections.join('\n').trimEnd()}\n`, 'utf8');
}

function createCycloneDxSbom({
  packageManifest,
  source,
  builtAt,
  lockSha256,
  runtime,
  productionPackages,
  licenseInventory,
}) {
  const licenses = new Map(licenseInventory.map(entry => [entry.lockPath, entry.expression]));
  const components = productionPackages.map(dependency => {
    const component = {
      type: 'library',
      'bom-ref': `npm:${dependency.lockPath}@${dependency.version}`,
      name: dependency.name,
      version: dependency.version,
      purl: `pkg:npm/${encodePurlName(dependency.name)}@${encodeURIComponent(dependency.version)}`,
      licenses: [{ expression: licenses.get(dependency.lockPath) }],
      properties: [{ name: 'orion:lock-path', value: dependency.lockPath }],
    };
    const integrityHash = parseNpmIntegrity(dependency.metadata.integrity);
    if (integrityHash) component.hashes = [integrityHash];
    return component;
  });
  components.sort((left, right) => left['bom-ref'].localeCompare(right['bom-ref']));
  return canonicalJsonBytes({
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      timestamp: builtAt,
      component: {
        type: 'application',
        'bom-ref': `pkg:npm/%40orion-agents/orion-code@${packageManifest.version}`,
        name: packageManifest.name,
        version: packageManifest.version,
      },
      properties: [
        { name: 'orion:git-sha', value: source.gitSha },
        { name: 'orion:npm-shrinkwrap-sha256', value: lockSha256 },
        { name: 'orion:node-version', value: runtime.nodeVersion },
        { name: 'orion:node-abi', value: runtime.nodeAbi },
      ],
    },
    components,
  });
}

async function collectPayloadManifest(root, excludedPath) {
  const files = [];
  for (const relativePath of walkFilesNoLinks(root)) {
    if (relativePath === excludedPath) continue;
    assertAllowedArchivePayloadPath(relativePath);
    const absolutePath = join(root, relativePath);
    const metadata = ensureRegularFile(absolutePath, 'payload file');
    const digest = await sha256File(absolutePath);
    files.push({
      path: relativePath,
      mode: metadata.mode & 0o111 ? 0o755 : 0o644,
      bytes: digest.bytes,
      sha256: digest.sha256,
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function assertStagedPayloadSafe(root, forbiddenAbsolutePaths) {
  for (const relativePath of walkFilesNoLinks(root)) {
    assertAllowedArchivePayloadPath(relativePath);
    const absolutePath = join(root, relativePath);
    const metadata = ensureRegularFile(absolutePath, 'staged payload');
    if (!shouldTreatAsText(relativePath) || metadata.size > MAX_TEXT_PAYLOAD_BYTES) continue;
    sanitizeTextPayload(readFileSync(absolutePath), relativePath, forbiddenAbsolutePaths);
  }
}

function assertAllowedArchivePayloadPath(relativePath) {
  assertSafeRelativePath(relativePath, 'archive payload path');
  assertNoSecretPath(relativePath);
  if (isExcludedReleasePath(relativePath)) {
    throw new Error(`archive contains excluded development path ${relativePath}.`);
  }
}

function validateReceiptShape(receipt) {
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
    'sidecar receipt'
  );
  if (
    receipt.schema_version !== SIDECAR_RECEIPT_SCHEMA_VERSION ||
    receipt.kind !== SIDECAR_RECEIPT_KIND
  ) {
    throw new Error('unsupported sidecar receipt contract.');
  }
  if (receipt.release_status !== RELEASE_STATUS_NOT_RELEASABLE) {
    throw new Error('local tooling accepts only explicitly NOT_RELEASABLE receipts.');
  }
  assertExactObjectKeys(
    receipt.source,
    ['package_name', 'version', 'git_sha', 'dirty', 'source_date_epoch', 'lock_sha256'],
    'receipt source'
  );
  if (receipt.source.package_name !== '@orion-agents/orion-code')
    throw new Error('invalid package name.');
  assertExactSemver(receipt.source.version, 'receipt version');
  assertGitSha(receipt.source.git_sha);
  if (typeof receipt.source.dirty !== 'boolean') throw new Error('receipt dirty flag is invalid.');
  parseNonNegativeInteger(receipt.source.source_date_epoch);
  assertSha256(receipt.source.lock_sha256, 'receipt lock SHA-256');
  assertExactObjectKeys(
    receipt.artifact,
    ['filename', 'bytes', 'format', 'archive_root', 'target', 'command', 'bundle_id'],
    'receipt artifact'
  );
  assertSafeBasename(receipt.artifact.filename, 'archive filename');
  if (!Number.isSafeInteger(receipt.artifact.bytes) || receipt.artifact.bytes <= 0) {
    throw new Error('receipt archive byte count is invalid.');
  }
  if (receipt.artifact.format !== 'zip' || receipt.artifact.archive_root !== SIDECAR_ARCHIVE_ROOT) {
    throw new Error('receipt archive layout is unsupported.');
  }
  assertSupportedTarget(receipt.artifact.target);
  if (receipt.artifact.command !== DARWIN_SIDECAR_COMMAND) {
    throw new Error('receipt command is not the managed launcher.');
  }
  assertBundleIdentifier(receipt.artifact.bundle_id);
  assertExactObjectKeys(
    receipt.bindings,
    ['archive_sha256', 'manifest_sha256', 'sbom_sha256', 'notices_sha256'],
    'receipt bindings'
  );
  for (const [name, value] of Object.entries(receipt.bindings)) assertSha256(value, name);
  assertExactObjectKeys(
    receipt.runtime,
    ['node_version', 'node_abi', 'platform', 'arch', 'executable_sha256', 'license_sha256'],
    'receipt runtime'
  );
  assertSha256(receipt.runtime.executable_sha256, 'runtime executable SHA-256');
  assertSha256(receipt.runtime.license_sha256, 'runtime license SHA-256');
  assertExactSemver(receipt.runtime.node_version, 'runtime Node version');
  if (!/^\d+$/.test(receipt.runtime.node_abi)) throw new Error('runtime Node ABI is invalid.');
  const targetRuntime = SUPPORTED_SIDECAR_TARGETS[receipt.artifact.target];
  if (
    receipt.runtime.platform !== targetRuntime.platform ||
    receipt.runtime.arch !== targetRuntime.arch
  ) {
    throw new Error('runtime platform/architecture does not match the receipt target.');
  }
  assertExactObjectKeys(
    receipt.verification,
    ['acp_smoke', 'relocated_path'],
    'receipt verification'
  );
  if (
    !['pass', 'skipped_local_unsigned'].includes(receipt.verification.acp_smoke) ||
    !['pass', 'not_verified'].includes(receipt.verification.relocated_path)
  ) {
    throw new Error('receipt verification status is invalid.');
  }
  assertExactObjectKeys(receipt.signing, ['status', 'notarization'], 'receipt signing');
  if (receipt.signing.status !== 'unsigned' || receipt.signing.notarization !== 'not_checked') {
    throw new Error('local receipt must remain unsigned and not notarized.');
  }
  assertExactObjectKeys(receipt.policy, ['releasable', 'reasons'], 'receipt policy');
  if (receipt.policy.releasable !== false || !Array.isArray(receipt.policy.reasons)) {
    throw new Error('local receipt must remain NOT RELEASABLE.');
  }
}

function validateManifestShape(manifest) {
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
    'archive manifest'
  );
  if (manifest.schema_version !== MANIFEST_SCHEMA_VERSION || manifest.acp_protocol !== 1) {
    throw new Error('archive manifest contract is unsupported.');
  }
  assertExactSemver(manifest.version, 'manifest version');
  assertGitSha(manifest.git_sha);
  assertSupportedTarget(manifest.target);
  assertRfc3339(manifest.built_at, 'manifest built_at');
  assertStudioRequirement(manifest.studio_version_requirement);
  assertExactSemver(manifest.node_version, 'manifest Node version');
  if (!/^\d+$/.test(manifest.node_abi)) throw new Error('manifest Node ABI is invalid.');
  assertSafeRelativePath(manifest.command, 'manifest command');
  assertSafeRelativePath(manifest.sbom_path, 'manifest SBOM path');
  assertSafeRelativePath(manifest.notices_path, 'manifest notices path');
  assertSha256(manifest.sbom_sha256, 'manifest SBOM SHA-256');
  assertSha256(manifest.notices_sha256, 'manifest notices SHA-256');
  if (!Array.isArray(manifest.native_modules) || !Array.isArray(manifest.files)) {
    throw new Error('archive manifest file collections are invalid.');
  }
  let previousNativeModule = '';
  for (const nativeModule of manifest.native_modules) {
    assertSafeRelativePath(nativeModule, 'manifest native module');
    if (
      !/\.(?:node|dylib|so|dll)$/i.test(nativeModule) ||
      (previousNativeModule && previousNativeModule.localeCompare(nativeModule) >= 0)
    ) {
      throw new Error('manifest native modules must be sorted, unique native paths.');
    }
    previousNativeModule = nativeModule;
  }
  let previousPath = '';
  for (const file of manifest.files) {
    assertExactObjectKeys(file, ['path', 'mode', 'bytes', 'sha256'], 'manifest file');
    assertAllowedArchivePayloadPath(file.path);
    if (previousPath && previousPath.localeCompare(file.path) >= 0) {
      throw new Error('manifest files must be strictly sorted and unique.');
    }
    previousPath = file.path;
    if (
      ![0o644, 0o755].includes(file.mode) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0
    ) {
      throw new Error('manifest file metadata is invalid.');
    }
    assertSha256(file.sha256, 'manifest file SHA-256');
  }
  const expectedNativeModules = manifest.files
    .filter(file => /\.(?:node|dylib|so|dll)$/i.test(file.path))
    .map(file => file.path);
  if (
    canonicalJsonBytes(expectedNativeModules).compare(
      canonicalJsonBytes(manifest.native_modules)
    ) !== 0
  ) {
    throw new Error('manifest native module inventory does not match its file list.');
  }
}

async function runRelocatedAcpSmoke(sidecarRoot, version, temporaryRoot) {
  const launcher = join(sidecarRoot, DARWIN_SIDECAR_COMMAND);
  const smokeRoot = join(temporaryRoot, 'ACP smoke 空格');
  const configDirectory = join(smokeRoot, 'config');
  const dataDirectory = join(smokeRoot, 'data');
  const cwd = join(smokeRoot, 'project');
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const environment = {
    HOME: smokeRoot,
    PATH: '/usr/bin:/bin',
    TMPDIR: smokeRoot,
    LANG: 'C.UTF-8',
    ORION_CODE_CONFIG_DIR: configDirectory,
    ORION_CODE_DATA_DIR: dataDirectory,
    ORION_CODE_DISABLE_ENV_FILES: '1',
  };
  let sessionId;
  await withAcpProcess(launcher, cwd, environment, async client => {
    const initialized = await client.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'orion-release-smoke', version: '1' },
    });
    if (
      initialized.protocolVersion !== 1 ||
      initialized.agentInfo?.name !== 'orion-code' ||
      initialized.agentInfo?.version !== version
    ) {
      throw new Error('relocated ACP initialize identity drifted.');
    }
    const created = await client.request('session/new', { cwd, mcpServers: [] });
    sessionId = created.sessionId;
    const promptError = await client.requestError('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'release smoke' }],
    });
    if (!promptError) throw new Error('unconfigured packaged ACP prompt unexpectedly succeeded.');
    client.notify('session/cancel', { sessionId });
    await client.request('session/close', { sessionId });
    await client.request('session/close', { sessionId });
  });
  await withAcpProcess(launcher, cwd, environment, async client => {
    await client.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'orion-release-smoke', version: '1' },
    });
    await client.request('session/load', { sessionId, cwd, mcpServers: [] });
    await client.request('session/close', { sessionId });
  });
  return { acpSmoke: 'pass', relocatedPath: 'pass' };
}

async function withAcpProcess(launcher, cwd, environment, operation) {
  const child = spawn(launcher, [], {
    cwd,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const rejectPending = message => {
    for (const [id, waiter] of pending) {
      pending.delete(id);
      waiter.reject(new Error(message));
    }
  };
  const exitPromise = new Promise(resolvePromise => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
    }, 30_000);
    timeout.unref();
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      rejectPending('ACP smoke process exited before responding.');
      resolvePromise({ code, signal });
    });
    child.once('error', error => {
      clearTimeout(timeout);
      rejectPending('ACP smoke process failed before responding.');
      resolvePromise({ error });
    });
  });
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += chunk.toString('utf8');
    if (stderr.length > 1024 * 1024) child.kill('SIGKILL');
  });
  let nextId = 1;
  let stdout = '';
  child.stdout.on('data', chunk => {
    stdout += chunk.toString('utf8');
    if (stdout.length > 4 * 1024 * 1024) child.kill('SIGKILL');
    while (true) {
      const newline = stdout.indexOf('\n');
      if (newline < 0) break;
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        child.kill('SIGKILL');
        continue;
      }
      if (message.id === undefined) continue;
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) waiter.resolve({ error: message.error });
      else waiter.resolve({ result: message.result });
    }
  });
  const send = (method, params, expectError) => {
    const id = nextId++;
    const response = new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        rejectPromise(new Error(`ACP smoke request ${method} timed out.`));
        child.kill('SIGKILL');
      }, 15_000);
      timeout.unref();
      pending.set(id, {
        resolve: value => {
          clearTimeout(timeout);
          if (value.error && !expectError) rejectPromise(new Error(`ACP ${method} failed.`));
          else resolvePromise(expectError ? value.error : value.result);
        },
        reject: error => {
          clearTimeout(timeout);
          rejectPromise(error);
        },
      });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return response;
  };
  const client = {
    request: (method, params) => send(method, params, false),
    requestError: (method, params) => send(method, params, true),
    notify: (method, params) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`),
  };
  let operationError;
  try {
    await operation(client);
  } catch (error) {
    operationError = error;
  } finally {
    child.stdin.end();
  }
  const exit = await exitPromise;
  if (operationError) throw operationError;
  if (exit.error || exit.signal || exit.code !== 0) {
    throw new Error(`relocated ACP process failed: ${redactSmokeError(stderr)}`);
  }
}

function redactSmokeError(stderr) {
  const singleLine = stderr.replace(/\s+/g, ' ').trim();
  return singleLine.length > 300 ? `${singleLine.slice(0, 300)}…` : singleLine || 'no diagnostics';
}

function copyNormalizedFile(source, destination, relativePath, forbiddenAbsolutePaths, mode) {
  assertNoSecretPath(relativePath);
  const metadata = ensureRegularFile(source, 'release input file');
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  if (shouldTreatAsText(relativePath) && metadata.size <= MAX_TEXT_PAYLOAD_BYTES) {
    const bytes = sanitizeTextPayload(readFileSync(source), relativePath, forbiddenAbsolutePaths);
    writePayloadFile(destination, bytes, mode);
  } else {
    copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
    chmodSync(destination, mode);
  }
}

function writePayloadFile(path, bytes, mode) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { flag: 'wx', mode });
}

function copyExclusive(source, destination, mode) {
  copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
  chmodSync(destination, mode);
}

function walkFilesNoLinks(root) {
  const output = [];
  const visit = (directory, prefix) => {
    for (const name of readdirSync(directory).sort()) {
      const absolutePath = join(directory, name);
      const metadata = lstatSync(absolutePath);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (metadata.isSymbolicLink())
        throw new Error(`release input contains a symlink: ${relativePath}`);
      if (metadata.isDirectory()) visit(absolutePath, relativePath);
      else if (metadata.isFile()) output.push(relativePath);
      else throw new Error(`release input contains a non-file: ${relativePath}`);
    }
  };
  visit(root, '');
  return output.sort();
}

function findLicenseFile(directory) {
  const candidates = readdirSync(directory)
    .filter(name => /^(?:licen[cs]e|copying|notice)(?:\.[^.]+)?$/i.test(name))
    .sort();
  for (const name of candidates) {
    const path = join(directory, name);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) throw new Error('license evidence must not be a symlink.');
    if (metadata.isFile()) return path;
  }
  return undefined;
}

function normalizeLicenseExpression(value) {
  if (typeof value === 'string' && /^[0-9A-Za-z-.+() ]{1,128}$/.test(value.trim())) {
    return value.trim();
  }
  if (value && typeof value === 'object' && typeof value.type === 'string') {
    return normalizeLicenseExpression(value.type);
  }
  return undefined;
}

function detectLicenseExpression(text) {
  if (!text) return undefined;
  const normalized = text.toLowerCase();
  if (normalized.includes('permission is hereby granted, free of charge')) return 'MIT';
  if (normalized.includes('apache license') && normalized.includes('version 2.0'))
    return 'Apache-2.0';
  if (normalized.includes('isc license')) return 'ISC';
  if (normalized.includes('redistribution and use in source and binary forms')) return 'BSD';
  return undefined;
}

function parseNpmIntegrity(integrity) {
  if (typeof integrity !== 'string') return undefined;
  const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
  if (!match) return undefined;
  return {
    alg: match[1].toUpperCase().replace('SHA', 'SHA-'),
    content: Buffer.from(match[2], 'base64').toString('hex'),
  };
}

function encodePurlName(name) {
  return name
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

function readBoundedText(path, maxBytes, label) {
  const metadata = ensureRegularFile(path, label);
  if (metadata.size > maxBytes) throw new Error(`${label} exceeds its byte limit.`);
  return readFileSync(path, 'utf8');
}

function assertStudioRequirement(value) {
  if (
    typeof value !== 'string' ||
    !SAFE_STUDIO_REQUIREMENT.test(value) ||
    value.includes('latest')
  ) {
    throw new Error('Studio version requirement is invalid.');
  }
  return value;
}

function assertBundleIdentifier(value) {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > 255 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)
  ) {
    throw new Error('bundle ID must be an explicit lowercase reverse-DNS identifier.');
  }
  return value;
}

function parseNonNegativeInteger(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error('expected a non-negative integer.');
  return parsed;
}

function signingRequirementForTarget(target) {
  if (target === 'darwin-aarch64') return 'developer_id_and_notarized';
  throw new Error(`no signing requirement is frozen for ${target}.`);
}
