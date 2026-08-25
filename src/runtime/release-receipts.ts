import { digestRuntimeValue } from './protocol/canonical';

export const RELEASE_RECEIPT_VERSION_V1 = 1 as const;
export const SUPPORTED_RELEASE_NODE_MAJORS_V1 = Object.freeze([20, 22, 24] as const);

export type ReleaseGateDecisionV1 = 'GO' | 'NO_GO';

export interface TarballArtifactReceiptV1 {
  readonly version: typeof RELEASE_RECEIPT_VERSION_V1;
  readonly kind: 'orion.tarball-artifact';
  readonly createdAt: string;
  readonly source: {
    readonly gitSha: string;
    readonly dirty: boolean;
  };
  readonly package: {
    readonly name: string;
    readonly version: string;
  };
  readonly tarball: {
    readonly filename: string;
    readonly sha256: string;
    readonly npmIntegrity: string;
    readonly bytes: number;
    readonly unpackedBytes: number;
    readonly entryCount: number;
    readonly manifestDigest: string;
  };
  readonly receiptDigest: string;
}

export type RuntimeMatrixProbeIdV1 =
  | 'clean_install'
  | 'package_identity'
  | 'version'
  | 'help'
  | 'public_exports'
  | 'builtin_skill_assets'
  | 'native_sqlite'
  | 'tui_journey'
  | 'terminal_journey'
  | 'print_journey'
  | 'goal_journey'
  | 'subagent_journey'
  | 'skill_journey'
  | 'mcp_journey'
  | 'compact_resume_journey';

export interface RuntimeMatrixProbeV1 {
  readonly id: RuntimeMatrixProbeIdV1;
  readonly status: 'pass' | 'fail';
  readonly detail: string;
  readonly durationMs: number;
  readonly runnerDigest: string;
  readonly targetDigest: string;
}

export interface RuntimeMatrixReceiptV1 {
  readonly version: typeof RELEASE_RECEIPT_VERSION_V1;
  readonly kind: 'orion.runtime-matrix';
  readonly createdAt: string;
  readonly artifactReceiptDigest: string;
  readonly tarballSha256: string;
  readonly package: TarballArtifactReceiptV1['package'];
  readonly environment: {
    readonly node: string;
    readonly nodeMajor: number;
    readonly npm: string;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
  };
  readonly probes: readonly RuntimeMatrixProbeV1[];
  readonly decision: ReleaseGateDecisionV1;
  readonly receiptDigest: string;
}

export interface HarnessReleaseEvidenceV1 {
  readonly benchmarkComparisonDigest: string;
  readonly benchmarkOk: boolean;
  readonly taskEvalComparisonDigest: string;
  readonly taskEvalDecision: ReleaseGateDecisionV1;
  readonly architectureConfluenceDigest: string;
  readonly architectureDecision: ReleaseGateDecisionV1;
  readonly fullTestDigest: string;
  readonly fullTestsPassed: boolean;
}

export interface GateEvidenceReceiptV1 {
  readonly version: typeof RELEASE_RECEIPT_VERSION_V1;
  readonly kind: 'orion.gate-evidence';
  readonly createdAt: string;
  readonly gateId: string;
  readonly source: {
    readonly gitSha: string;
    readonly packageVersion: string;
  };
  readonly commandDigest: string;
  readonly outputDigest: string;
  readonly durationMs: number;
  readonly status: 'pass' | 'fail';
  readonly receiptDigest: string;
}

export interface ReleaseReceiptV1 {
  readonly version: typeof RELEASE_RECEIPT_VERSION_V1;
  readonly kind: 'orion.release';
  readonly createdAt: string;
  readonly artifact: TarballArtifactReceiptV1;
  readonly runtimeMatrix: readonly RuntimeMatrixReceiptV1[];
  readonly evidence: HarnessReleaseEvidenceV1;
  readonly checks: readonly {
    readonly id: string;
    readonly status: 'pass' | 'fail';
    readonly detail: string;
  }[];
  readonly decision: ReleaseGateDecisionV1;
  readonly receiptDigest: string;
}

type UnsignedArtifactReceiptV1 = Omit<TarballArtifactReceiptV1, 'receiptDigest'>;
type UnsignedRuntimeMatrixReceiptV1 = Omit<RuntimeMatrixReceiptV1, 'receiptDigest' | 'decision'>;

export function createTarballArtifactReceiptV1(
  input: UnsignedArtifactReceiptV1
): TarballArtifactReceiptV1 {
  assertIsoTimestamp(input.createdAt, 'artifact createdAt');
  assertHexDigest(input.source.gitSha, 'source gitSha', 40, 64);
  assertNonEmpty(input.package.name, 'package name');
  assertNonEmpty(input.package.version, 'package version');
  assertNonEmpty(input.tarball.filename, 'tarball filename');
  assertHexDigest(input.tarball.sha256, 'tarball sha256', 64, 64);
  assertNonEmpty(input.tarball.npmIntegrity, 'tarball npm integrity');
  assertPositiveInteger(input.tarball.bytes, 'tarball bytes');
  assertPositiveInteger(input.tarball.unpackedBytes, 'tarball unpacked bytes');
  assertPositiveInteger(input.tarball.entryCount, 'tarball entry count');
  assertHexDigest(input.tarball.manifestDigest, 'tarball manifest digest', 64, 64);
  const content = deepFreeze({ ...input });
  return deepFreeze({ ...content, receiptDigest: digestRuntimeValue(content) });
}

export function verifyTarballArtifactReceiptV1(value: unknown): TarballArtifactReceiptV1 {
  const receipt = value as TarballArtifactReceiptV1;
  if (!receipt || receipt.version !== 1 || receipt.kind !== 'orion.tarball-artifact') {
    throw new Error('Invalid TarballArtifactReceiptV1 envelope.');
  }
  const expected = createTarballArtifactReceiptV1({
    version: receipt.version,
    kind: receipt.kind,
    createdAt: receipt.createdAt,
    source: receipt.source,
    package: receipt.package,
    tarball: receipt.tarball,
  });
  if (expected.receiptDigest !== receipt.receiptDigest) {
    throw new Error('Tarball artifact receipt digest mismatch.');
  }
  return expected;
}

export function createRuntimeMatrixReceiptV1(
  input: UnsignedRuntimeMatrixReceiptV1
): RuntimeMatrixReceiptV1 {
  assertIsoTimestamp(input.createdAt, 'runtime receipt createdAt');
  assertHexDigest(input.artifactReceiptDigest, 'artifact receipt digest', 64, 64);
  assertHexDigest(input.tarballSha256, 'runtime tarball sha256', 64, 64);
  assertNonEmpty(input.package.name, 'runtime package name');
  assertNonEmpty(input.package.version, 'runtime package version');
  assertNonEmpty(input.environment.node, 'Node version');
  assertNonEmpty(input.environment.npm, 'npm version');
  if (!SUPPORTED_RELEASE_NODE_MAJORS_V1.includes(input.environment.nodeMajor as 20 | 22 | 24)) {
    throw new Error(`Unsupported release Node major ${input.environment.nodeMajor}.`);
  }
  const expectedProbeIds: readonly RuntimeMatrixProbeIdV1[] = [
    'clean_install',
    'package_identity',
    'version',
    'help',
    'public_exports',
    'builtin_skill_assets',
    'native_sqlite',
    'tui_journey',
    'terminal_journey',
    'print_journey',
    'goal_journey',
    'subagent_journey',
    'skill_journey',
    'mcp_journey',
    'compact_resume_journey',
  ];
  const observedIds = input.probes.map(probe => probe.id);
  if (
    observedIds.length !== expectedProbeIds.length ||
    expectedProbeIds.some((id, index) => observedIds[index] !== id)
  ) {
    throw new Error(`Runtime probes must be complete and ordered: ${expectedProbeIds.join(', ')}.`);
  }
  for (const probe of input.probes) {
    if (probe.status !== 'pass' && probe.status !== 'fail') {
      throw new Error(`Runtime probe ${probe.id} has an invalid status.`);
    }
    assertNonEmpty(probe.detail, `runtime probe ${probe.id} detail`);
    if (!Number.isFinite(probe.durationMs) || probe.durationMs < 0) {
      throw new Error(`Runtime probe ${probe.id} duration must be finite and non-negative.`);
    }
    assertHexDigest(probe.runnerDigest, `runtime probe ${probe.id} runner digest`, 64, 64);
    assertHexDigest(probe.targetDigest, `runtime probe ${probe.id} target digest`, 64, 64);
  }
  const decision: ReleaseGateDecisionV1 = input.probes.every(probe => probe.status === 'pass')
    ? 'GO'
    : 'NO_GO';
  const content = deepFreeze({ ...input, decision });
  return deepFreeze({ ...content, receiptDigest: digestRuntimeValue(content) });
}

export function verifyRuntimeMatrixReceiptV1(value: unknown): RuntimeMatrixReceiptV1 {
  const receipt = value as RuntimeMatrixReceiptV1;
  if (!receipt || receipt.version !== 1 || receipt.kind !== 'orion.runtime-matrix') {
    throw new Error('Invalid RuntimeMatrixReceiptV1 envelope.');
  }
  const expected = createRuntimeMatrixReceiptV1({
    version: receipt.version,
    kind: receipt.kind,
    createdAt: receipt.createdAt,
    artifactReceiptDigest: receipt.artifactReceiptDigest,
    tarballSha256: receipt.tarballSha256,
    package: receipt.package,
    environment: receipt.environment,
    probes: receipt.probes,
  });
  if (expected.decision !== receipt.decision || expected.receiptDigest !== receipt.receiptDigest) {
    throw new Error('Runtime matrix receipt decision or digest mismatch.');
  }
  return expected;
}

export function createReleaseReceiptV1(input: {
  readonly createdAt: string;
  readonly artifact: TarballArtifactReceiptV1;
  readonly runtimeMatrix: readonly RuntimeMatrixReceiptV1[];
  readonly evidence: HarnessReleaseEvidenceV1;
}): ReleaseReceiptV1 {
  assertIsoTimestamp(input.createdAt, 'release receipt createdAt');
  assertHexDigest(input.evidence.benchmarkComparisonDigest, 'benchmark comparison digest', 64, 64);
  assertHexDigest(input.evidence.taskEvalComparisonDigest, 'task eval comparison digest', 64, 64);
  assertHexDigest(
    input.evidence.architectureConfluenceDigest,
    'architecture confluence digest',
    64,
    64
  );
  assertHexDigest(input.evidence.fullTestDigest, 'full test digest', 64, 64);
  if (!['GO', 'NO_GO'].includes(input.evidence.taskEvalDecision)) {
    throw new Error('Task evaluation decision must be GO or NO_GO.');
  }
  if (!['GO', 'NO_GO'].includes(input.evidence.architectureDecision)) {
    throw new Error('Architecture decision must be GO or NO_GO.');
  }
  const artifact = verifyTarballArtifactReceiptV1(input.artifact);
  const runtimeMatrix = input.runtimeMatrix
    .map(verifyRuntimeMatrixReceiptV1)
    .sort((left, right) => left.environment.nodeMajor - right.environment.nodeMajor);
  const checks: Array<{ id: string; status: 'pass' | 'fail'; detail: string }> = [];
  const expectedMajors = [...SUPPORTED_RELEASE_NODE_MAJORS_V1];
  const observedMajors = runtimeMatrix.map(receipt => receipt.environment.nodeMajor);
  checks.push({
    id: 'source_clean',
    status: artifact.source.dirty ? 'fail' : 'pass',
    detail: artifact.source.dirty ? 'release artifact was built from a dirty tree' : 'clean source',
  });
  checks.push({
    id: 'release_version',
    status: artifact.package.version === '0.2.0' ? 'pass' : 'fail',
    detail: artifact.package.version,
  });
  checks.push({
    id: 'runtime_matrix_complete',
    status:
      observedMajors.length === expectedMajors.length &&
      expectedMajors.every((major, index) => observedMajors[index] === major)
        ? 'pass'
        : 'fail',
    detail: `expected=${expectedMajors.join(',')} observed=${observedMajors.join(',') || 'none'}`,
  });
  const artifactBindingOk = runtimeMatrix.every(
    receipt =>
      receipt.artifactReceiptDigest === artifact.receiptDigest &&
      receipt.tarballSha256 === artifact.tarball.sha256 &&
      receipt.package.name === artifact.package.name &&
      receipt.package.version === artifact.package.version
  );
  checks.push({
    id: 'task_eval',
    status: input.evidence.taskEvalDecision === 'GO' ? 'pass' : 'fail',
    detail: input.evidence.taskEvalComparisonDigest,
  });
  checks.push({
    id: 'single_exact_tarball',
    status: artifactBindingOk ? 'pass' : 'fail',
    detail: artifactBindingOk
      ? `all runtimes verified sha256=${artifact.tarball.sha256}`
      : 'one or more runtime receipts are not bound to the exact release artifact',
  });
  checks.push({
    id: 'runtime_probes',
    status: runtimeMatrix.every(receipt => receipt.decision === 'GO') ? 'pass' : 'fail',
    detail: runtimeMatrix
      .map(receipt => `node${receipt.environment.nodeMajor}=${receipt.decision}`)
      .join(' '),
  });
  const probeIds = runtimeMatrix[0]?.probes.map(probe => probe.id) ?? [];
  const mismatchedProbeIdentities = probeIds.filter(id => {
    const matching = runtimeMatrix
      .map(receipt => receipt.probes.find(probe => probe.id === id))
      .filter((probe): probe is RuntimeMatrixProbeV1 => probe !== undefined);
    return (
      matching.length !== runtimeMatrix.length ||
      new Set(matching.map(probe => probe.runnerDigest)).size !== 1 ||
      new Set(matching.map(probe => probe.targetDigest)).size !== 1
    );
  });
  checks.push({
    id: 'runtime_probe_identity',
    status: mismatchedProbeIdentities.length === 0 ? 'pass' : 'fail',
    detail:
      mismatchedProbeIdentities.length === 0
        ? 'all Node runtimes used identical probe runners and installed targets'
        : `runner/target digest mismatch: ${mismatchedProbeIdentities.join(', ')}`,
  });
  checks.push({
    id: 'harness_benchmark',
    status: input.evidence.benchmarkOk ? 'pass' : 'fail',
    detail: input.evidence.benchmarkComparisonDigest,
  });
  checks.push({
    id: 'architecture_confluence',
    status: input.evidence.architectureDecision === 'GO' ? 'pass' : 'fail',
    detail: input.evidence.architectureConfluenceDigest,
  });
  checks.push({
    id: 'full_tests',
    status: input.evidence.fullTestsPassed ? 'pass' : 'fail',
    detail: input.evidence.fullTestDigest,
  });
  const ptyProbeIds: readonly RuntimeMatrixProbeIdV1[] = [
    'tui_journey',
    'terminal_journey',
    'print_journey',
    'goal_journey',
    'subagent_journey',
  ];
  const ptyJourneysPassed = runtimeMatrix.every(receipt =>
    ptyProbeIds.every(id => receipt.probes.find(probe => probe.id === id)?.status === 'pass')
  );
  checks.push({
    id: 'pty_journeys',
    status: ptyJourneysPassed ? 'pass' : 'fail',
    detail: ptyJourneysPassed
      ? `installed journeys passed on Node ${observedMajors.join(',')}`
      : 'one or more installed renderer/Goal/subagent journeys failed or are missing',
  });
  const decision: ReleaseGateDecisionV1 = checks.every(check => check.status === 'pass')
    ? 'GO'
    : 'NO_GO';
  const content = deepFreeze({
    version: RELEASE_RECEIPT_VERSION_V1,
    kind: 'orion.release' as const,
    createdAt: input.createdAt,
    artifact,
    runtimeMatrix,
    evidence: deepFreeze({ ...input.evidence }),
    checks: deepFreeze(checks),
    decision,
  });
  return deepFreeze({ ...content, receiptDigest: digestRuntimeValue(content) });
}

export function createGateEvidenceReceiptV1(
  input: Omit<GateEvidenceReceiptV1, 'receiptDigest'>
): GateEvidenceReceiptV1 {
  assertIsoTimestamp(input.createdAt, 'gate evidence createdAt');
  assertNonEmpty(input.gateId, 'gate evidence id');
  assertHexDigest(input.source.gitSha, 'gate evidence gitSha', 40, 64);
  assertNonEmpty(input.source.packageVersion, 'gate evidence package version');
  assertHexDigest(input.commandDigest, 'gate evidence command digest', 64, 64);
  assertHexDigest(input.outputDigest, 'gate evidence output digest', 64, 64);
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0) {
    throw new Error('Gate evidence duration must be finite and non-negative.');
  }
  if (input.status !== 'pass' && input.status !== 'fail') {
    throw new Error('Gate evidence status must be pass or fail.');
  }
  const content = deepFreeze({ ...input });
  return deepFreeze({ ...content, receiptDigest: digestRuntimeValue(content) });
}

export function verifyGateEvidenceReceiptV1(value: unknown): GateEvidenceReceiptV1 {
  const receipt = value as GateEvidenceReceiptV1;
  if (!receipt || receipt.version !== 1 || receipt.kind !== 'orion.gate-evidence') {
    throw new Error('Invalid GateEvidenceReceiptV1 envelope.');
  }
  const expected = createGateEvidenceReceiptV1({
    version: receipt.version,
    kind: receipt.kind,
    createdAt: receipt.createdAt,
    gateId: receipt.gateId,
    source: receipt.source,
    commandDigest: receipt.commandDigest,
    outputDigest: receipt.outputDigest,
    durationMs: receipt.durationMs,
    status: receipt.status,
  });
  if (expected.receiptDigest !== receipt.receiptDigest) {
    throw new Error('Gate evidence receipt digest mismatch.');
  }
  return expected;
}

function assertIsoTimestamp(value: string, label: string): void {
  if (!value || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be ISO-8601.`);
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must not be empty.`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
}

function assertHexDigest(value: string, label: string, minLength: number, maxLength: number): void {
  if (
    typeof value !== 'string' ||
    value.length < minLength ||
    value.length > maxLength ||
    !/^[a-f0-9]+$/u.test(value)
  ) {
    throw new Error(`${label} must be a lowercase hexadecimal digest.`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
