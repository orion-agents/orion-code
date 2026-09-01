import { digestRuntimeValue } from './protocol/canonical';

export const RELEASE_RECEIPT_VERSION_V1 = 1 as const;
export const SUPPORTED_RELEASE_NODE_MAJORS_V1 = Object.freeze([22, 24, 26] as const);
export type SupportedReleaseNodeMajorV1 = (typeof SUPPORTED_RELEASE_NODE_MAJORS_V1)[number];
export const SUPPORTED_RELEASE_NODE_FLOORS_V1: Readonly<
  Record<SupportedReleaseNodeMajorV1, readonly [number, number, number]>
> = Object.freeze({
  22: Object.freeze([22, 12, 0] as const),
  24: Object.freeze([24, 0, 0] as const),
  26: Object.freeze([26, 0, 0] as const),
});
export const SUPPORTED_RELEASE_VERSION_LINE_V1 = '0.3.x' as const;
export const WEB_E2E_LEGACY_SCENARIOS_V1 = Object.freeze([
  'E2E-P0-01',
  'E2E-P0-02',
  'E2E-P0-03',
  'E2E-P0-04',
  'E2E-P0-05',
  'E2E-P0-06',
  'E2E-P0-07',
  'E2E-P0-08',
  'SET-P0-01',
  'SET-P0-02',
  'SET-P0-03',
  'SET-P0-04',
  'SET-P0-05',
  'SET-P0-06',
  'SET-P0-07',
  'SET-P0-08',
  'SET-P0-09',
  'SET-P0-10',
  'SET-P0-11',
  'SET-P0-12',
  'SET-P0-13',
  'SET-P0-14',
] as const);
export const WEB_E2E_WEB31_SCENARIOS_V1 = Object.freeze([
  'WEB31-P0-01',
  'WEB31-P0-02',
  'WEB31-P0-03',
  'WEB31-P0-04',
  'WEB31-P0-05',
  'WEB31-P0-06',
  'WEB31-P0-07',
  'WEB31-P0-08',
  'WEB31-P0-09',
  'WEB31-P0-10',
  'WEB31-P0-11',
  'WEB31-P0-12',
] as const);
export const WEB_E2E_WEB32_SCENARIOS_V1 = Object.freeze([
  'WEB32-P0-01',
  'WEB32-P0-02',
  'WEB32-P0-03',
  'WEB32-P0-04',
  'WEB32-P0-05',
  'WEB32-P0-06',
  'WEB32-P0-07',
  'WEB32-P0-08',
  'WEB32-P0-09',
  'WEB32-P0-10',
  'WEB32-P0-11',
  'WEB32-P0-12',
] as const);
export const WEB_E2E_WEB33_THEME_SCENARIOS_V1 = Object.freeze([
  'WEB33-P0-01',
  'WEB33-P0-02',
  'WEB33-P0-03',
  'WEB33-P0-04',
  'WEB33-P0-05',
  'WEB33-P0-06',
  'WEB33-P0-07',
  'WEB33-P0-08',
  'WEB33-P0-09',
  'WEB33-P0-10',
  'WEB33-P0-11',
  'WEB33-P0-12',
] as const);
export const WEB_E2E_WEB33_SESSION_SCENARIOS_V1 = Object.freeze([
  'WEB33-P0-16',
  'WEB33-P0-17',
  'WEB33-P0-18',
  'WEB33-P0-19',
  'WEB33-P0-20',
  'WEB33-P0-21',
  'WEB33-P0-22',
  'WEB33-P0-23',
  'WEB33-P0-24',
] as const);
export const WEB_E2E_WEB33_SCENARIOS_V1 = Object.freeze([
  ...WEB_E2E_WEB33_THEME_SCENARIOS_V1,
  ...WEB_E2E_WEB33_SESSION_SCENARIOS_V1,
]);
export const WEB_E2E_FULL_SCENARIOS_V1 = Object.freeze([
  ...WEB_E2E_LEGACY_SCENARIOS_V1,
  ...WEB_E2E_WEB31_SCENARIOS_V1,
  ...WEB_E2E_WEB32_SCENARIOS_V1,
  ...WEB_E2E_WEB33_SCENARIOS_V1,
]);
export const WEB_E2E_SETTINGS_SCENARIOS_V1 = Object.freeze(
  WEB_E2E_FULL_SCENARIOS_V1.filter(id => id.startsWith('SET-P0-'))
);
export const WEB_E2E_WEB31_CRITICAL_SCENARIOS_V1 = Object.freeze([
  'WEB31-P0-01',
  'WEB31-P0-02',
  'WEB31-P0-08',
  'WEB31-P0-09',
  'WEB31-P0-10',
  'WEB31-P0-12',
] as const);
export const WEB_E2E_WEB32_CRITICAL_SCENARIOS_V1 = Object.freeze([
  'WEB32-P0-01',
  'WEB32-P0-04',
  'WEB32-P0-05',
  'WEB32-P0-06',
  'WEB32-P0-09',
  'WEB32-P0-11',
  'WEB32-P0-12',
] as const);
export const WEB_E2E_WEB33_CRITICAL_SCENARIOS_V1 = Object.freeze([
  'WEB33-P0-01',
  'WEB33-P0-03',
  'WEB33-P0-08',
  'WEB33-P0-10',
  'WEB33-P0-12',
  'WEB33-P0-16',
  'WEB33-P0-17',
  'WEB33-P0-18',
  'WEB33-P0-20',
  'WEB33-P0-21',
  'WEB33-P0-23',
  'WEB33-P0-24',
] as const);
export const WEB_E2E_CRITICAL_SCENARIOS_V1 = Object.freeze([
  ...WEB_E2E_LEGACY_SCENARIOS_V1.slice(0, 4),
  ...WEB_E2E_SETTINGS_SCENARIOS_V1,
  ...WEB_E2E_WEB31_CRITICAL_SCENARIOS_V1,
  ...WEB_E2E_WEB32_CRITICAL_SCENARIOS_V1,
  ...WEB_E2E_WEB33_CRITICAL_SCENARIOS_V1,
]);

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
  | 'web_journey'
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

export interface WebE2ERunEvidenceV1 {
  readonly role: 'primary' | 'runtime';
  readonly ordinal: number;
  readonly runId: string;
  readonly source: TarballArtifactReceiptV1['source'];
  readonly artifactReceiptDigest: string;
  readonly tarballSha256: string;
  readonly installedTargetDigest: string;
  readonly environment: RuntimeMatrixReceiptV1['environment'];
  readonly browser: {
    readonly name: string;
    readonly version: string;
    readonly channel: string;
  };
  readonly runner: {
    readonly name: string;
    readonly image: string;
    readonly digest: string;
  };
  readonly startedAt: string;
  readonly completedAt: string;
  readonly scenarioIds: readonly string[];
  readonly durationMs: number;
  readonly manifestDigest: string;
  readonly secretScanFindings: number;
  readonly cleanEvidence: boolean;
  readonly decision: ReleaseGateDecisionV1;
}

export interface WebE2EReleaseReceiptV1 {
  readonly version: typeof RELEASE_RECEIPT_VERSION_V1;
  readonly kind: 'orion.web-e2e-release';
  readonly createdAt: string;
  readonly source: TarballArtifactReceiptV1['source'];
  readonly artifactReceiptDigest: string;
  readonly tarballSha256: string;
  readonly package: TarballArtifactReceiptV1['package'];
  readonly primaryRuns: readonly WebE2ERunEvidenceV1[];
  readonly runtimeRuns: readonly WebE2ERunEvidenceV1[];
  readonly liveCanary: 'PASS' | 'FAIL' | 'NOT_RUN';
  readonly checks: readonly {
    readonly id: string;
    readonly status: 'pass' | 'fail';
    readonly detail: string;
  }[];
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
  readonly webE2EReceiptDigest: string;
  readonly webE2EDecision: ReleaseGateDecisionV1;
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
  readonly webE2E: WebE2EReleaseReceiptV1;
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
type UnsignedWebE2EReleaseReceiptV1 = Omit<
  WebE2EReleaseReceiptV1,
  'checks' | 'decision' | 'receiptDigest'
>;

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
  assertSupportedReleaseNodeVersionV1(input.environment.node, input.environment.nodeMajor);
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
    'web_journey',
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

export function createWebE2EReleaseReceiptV1(
  input: UnsignedWebE2EReleaseReceiptV1
): WebE2EReleaseReceiptV1 {
  assertIsoTimestamp(input.createdAt, 'Web E2E receipt createdAt');
  assertHexDigest(input.source.gitSha, 'Web E2E source gitSha', 40, 64);
  assertHexDigest(input.artifactReceiptDigest, 'Web E2E artifact receipt digest', 64, 64);
  assertHexDigest(input.tarballSha256, 'Web E2E tarball sha256', 64, 64);
  assertNonEmpty(input.package.name, 'Web E2E package name');
  assertNonEmpty(input.package.version, 'Web E2E package version');
  if (!['PASS', 'FAIL', 'NOT_RUN'].includes(input.liveCanary)) {
    throw new Error('Web E2E live canary must be PASS, FAIL, or NOT_RUN.');
  }
  const primaryRuns = input.primaryRuns
    .map(validateWebE2ERun)
    .sort((left, right) => left.ordinal - right.ordinal);
  const runtimeRuns = input.runtimeRuns
    .map(validateWebE2ERun)
    .sort((left, right) => left.environment.nodeMajor - right.environment.nodeMajor);
  const allRuns = [...primaryRuns, ...runtimeRuns];
  const expectedAllRuns = 3 + SUPPORTED_RELEASE_NODE_MAJORS_V1.length;
  const checks: Array<{ id: string; status: 'pass' | 'fail'; detail: string }> = [];
  const primaryOrdinals = primaryRuns.map(run => run.ordinal);
  const primaryRunIds = new Set(primaryRuns.map(run => run.runId));
  const primaryManifestDigests = new Set(primaryRuns.map(run => run.manifestDigest));
  const primaryTimelineIsConsecutive = primaryRuns.every((run, index) => {
    if (index === 0) return true;
    return Date.parse(run.startedAt) >= Date.parse(primaryRuns[index - 1].completedAt);
  });
  const primaryRunsAreFresh =
    primaryRuns.length === 3 &&
    primaryRunIds.size === 3 &&
    primaryManifestDigests.size === 3 &&
    primaryTimelineIsConsecutive;
  checks.push({
    id: 'primary_three_fresh_consecutive',
    status:
      primaryRuns.length === 3 &&
      [1, 2, 3].every((value, index) => primaryOrdinals[index] === value) &&
      primaryRunsAreFresh
        ? 'pass'
        : 'fail',
    detail:
      `expected=1,2,3 observed=${primaryOrdinals.join(',') || 'none'} ` +
      `uniqueRunIds=${primaryRunIds.size} uniqueManifests=${primaryManifestDigests.size} ` +
      `consecutive=${primaryTimelineIsConsecutive}`,
  });
  const runtimeMajors = runtimeRuns.map(run => run.environment.nodeMajor);
  const runtimeRunIds = new Set(runtimeRuns.map(run => run.runId));
  const runtimeManifestDigests = new Set(runtimeRuns.map(run => run.manifestDigest));
  checks.push({
    id: 'node_matrix_complete',
    status:
      runtimeRuns.length === SUPPORTED_RELEASE_NODE_MAJORS_V1.length &&
      SUPPORTED_RELEASE_NODE_MAJORS_V1.every((value, index) => runtimeMajors[index] === value)
        ? 'pass'
        : 'fail',
    detail: `expected=${SUPPORTED_RELEASE_NODE_MAJORS_V1.join(',')} observed=${runtimeMajors.join(',') || 'none'}`,
  });
  checks.push({
    id: 'node_matrix_runs_unique',
    status:
      runtimeRuns.length === SUPPORTED_RELEASE_NODE_MAJORS_V1.length &&
      runtimeRunIds.size === SUPPORTED_RELEASE_NODE_MAJORS_V1.length &&
      runtimeManifestDigests.size === SUPPORTED_RELEASE_NODE_MAJORS_V1.length
        ? 'pass'
        : 'fail',
    detail:
      `runs=${runtimeRuns.length} uniqueRunIds=${runtimeRunIds.size} ` +
      `uniqueManifests=${runtimeManifestDigests.size}`,
  });
  checks.push({
    id: 'live_canary',
    status: input.liveCanary === 'FAIL' ? 'fail' : 'pass',
    detail: `observed=${input.liveCanary}`,
  });
  const primaryCoverage =
    primaryRuns.length === 3 &&
    primaryRuns.every(
      run => run.role === 'primary' && sameOrderedValues(run.scenarioIds, WEB_E2E_FULL_SCENARIOS_V1)
    );
  const runtimeCoverage =
    runtimeRuns.length === SUPPORTED_RELEASE_NODE_MAJORS_V1.length &&
    runtimeRuns.every(
      run =>
        run.role === 'runtime' && sameOrderedValues(run.scenarioIds, WEB_E2E_CRITICAL_SCENARIOS_V1)
    );
  checks.push({
    id: 'scenario_coverage',
    status: primaryCoverage && runtimeCoverage ? 'pass' : 'fail',
    detail:
      primaryCoverage && runtimeCoverage
        ? `primary=${WEB_E2E_FULL_SCENARIOS_V1.length} scenarios runtime=${WEB_E2E_CRITICAL_SCENARIOS_V1.length} critical scenarios`
        : 'one or more runs have incomplete or reordered scenarios',
  });
  const artifactBound = allRuns.every(
    run =>
      run.source.gitSha === input.source.gitSha &&
      run.source.dirty === input.source.dirty &&
      run.artifactReceiptDigest === input.artifactReceiptDigest &&
      run.tarballSha256 === input.tarballSha256
  );
  checks.push({
    id: 'single_exact_tarball',
    status: artifactBound ? 'pass' : 'fail',
    detail: artifactBound
      ? `all Web runs verified sha256=${input.tarballSha256}`
      : 'one or more Web runs are not bound to the exact artifact',
  });
  const targetDigests = new Set(allRuns.map(run => run.installedTargetDigest));
  checks.push({
    id: 'installed_target_identity',
    status: allRuns.length === expectedAllRuns && targetDigests.size === 1 ? 'pass' : 'fail',
    detail:
      allRuns.length === expectedAllRuns && targetDigests.size === 1
        ? [...targetDigests][0]
        : `runs=${allRuns.length} targetDigests=${targetDigests.size}`,
  });
  const runnerDigests = new Set(allRuns.map(run => run.runner.digest));
  const runnerIdentityRecorded = allRuns.every(
    run => run.runner.name.trim() && run.runner.image.trim() && run.browser.channel.trim()
  );
  checks.push({
    id: 'runner_browser_identity',
    status:
      allRuns.length === expectedAllRuns && runnerDigests.size === 1 && runnerIdentityRecorded
        ? 'pass'
        : 'fail',
    detail:
      allRuns.length === expectedAllRuns && runnerDigests.size === 1 && runnerIdentityRecorded
        ? `runnerDigest=${[...runnerDigests][0]}`
        : `runs=${allRuns.length} runnerDigests=${runnerDigests.size} identity=${runnerIdentityRecorded}`,
  });
  const secretFindings = allRuns.reduce((sum, run) => sum + run.secretScanFindings, 0);
  checks.push({
    id: 'secret_scan_fail_closed',
    status: allRuns.length === expectedAllRuns && secretFindings === 0 ? 'pass' : 'fail',
    detail: `runs=${allRuns.length} findings=${secretFindings}`,
  });
  const runEvidenceClean = allRuns.every(
    run => run.decision === 'GO' && run.cleanEvidence && run.browser.version.trim()
  );
  checks.push({
    id: 'browser_evidence_clean',
    status: runEvidenceClean ? 'pass' : 'fail',
    detail: allRuns.map(run => `${run.role}${run.ordinal}=${run.decision}`).join(' '),
  });
  const settingsMatrixComplete =
    runtimeRuns.length === SUPPORTED_RELEASE_NODE_MAJORS_V1.length &&
    runtimeRuns.every(
      run =>
        run.decision === 'GO' &&
        run.cleanEvidence &&
        run.tarballSha256 === input.tarballSha256 &&
        WEB_E2E_SETTINGS_SCENARIOS_V1.every(id => run.scenarioIds.includes(id))
    );
  checks.push({
    id: 'SET-P0-14',
    status: settingsMatrixComplete ? 'pass' : 'fail',
    detail: settingsMatrixComplete
      ? `Settings journey passed without skip on Node ${runtimeMajors.join(',')} using one tgz`
      : `Settings journey missing, skipped, failed, or not bound to one tgz on Node ${SUPPORTED_RELEASE_NODE_MAJORS_V1.join('/')}`,
  });
  const web31PrimaryComplete =
    primaryRuns.length === 3 &&
    primaryRuns.every(
      run =>
        run.decision === 'GO' &&
        run.cleanEvidence &&
        WEB_E2E_WEB31_SCENARIOS_V1.every(id => run.scenarioIds.includes(id))
    );
  const web31MatrixComplete =
    runtimeRuns.length === SUPPORTED_RELEASE_NODE_MAJORS_V1.length &&
    runtimeRuns.every(
      run =>
        run.decision === 'GO' &&
        run.cleanEvidence &&
        run.tarballSha256 === input.tarballSha256 &&
        WEB_E2E_WEB31_CRITICAL_SCENARIOS_V1.every(id => run.scenarioIds.includes(id))
    );
  checks.push({
    id: 'WEB31-P0-12',
    status: web31PrimaryComplete && web31MatrixComplete ? 'pass' : 'fail',
    detail:
      web31PrimaryComplete && web31MatrixComplete
        ? `all WEB31 journeys passed in three primary runs; critical Web/PTY journeys passed on Node ${runtimeMajors.join(',')} using one tgz`
        : 'WEB31 full or critical exact-tarball coverage is missing, skipped, failed, or dirty',
  });
  const web32PrimaryComplete =
    primaryRuns.length === 3 &&
    primaryRuns.every(
      run =>
        run.decision === 'GO' &&
        run.cleanEvidence &&
        WEB_E2E_WEB32_SCENARIOS_V1.every(id => run.scenarioIds.includes(id))
    );
  const web32MatrixComplete =
    runtimeRuns.length === SUPPORTED_RELEASE_NODE_MAJORS_V1.length &&
    runtimeRuns.every(
      run =>
        run.decision === 'GO' &&
        run.cleanEvidence &&
        run.tarballSha256 === input.tarballSha256 &&
        WEB_E2E_WEB32_CRITICAL_SCENARIOS_V1.every(id => run.scenarioIds.includes(id))
    );
  checks.push({
    id: 'WEB32-P0-12',
    status: web32PrimaryComplete && web32MatrixComplete ? 'pass' : 'fail',
    detail:
      web32PrimaryComplete && web32MatrixComplete
        ? `all WEB32 journeys passed in three primary runs; critical Composer/Layout journeys passed on Node ${runtimeMajors.join(',')} using one tgz`
        : 'WEB32 full or critical exact-tarball coverage is missing, skipped, failed, or dirty',
  });
  const web33PrimaryComplete =
    primaryRuns.length === 3 &&
    primaryRuns.every(
      run =>
        run.decision === 'GO' &&
        run.cleanEvidence &&
        WEB_E2E_WEB33_SCENARIOS_V1.every(id => run.scenarioIds.includes(id))
    );
  const web33MatrixComplete =
    runtimeRuns.length === SUPPORTED_RELEASE_NODE_MAJORS_V1.length &&
    runtimeRuns.every(
      run =>
        run.decision === 'GO' &&
        run.cleanEvidence &&
        run.tarballSha256 === input.tarballSha256 &&
        WEB_E2E_WEB33_CRITICAL_SCENARIOS_V1.every(id => run.scenarioIds.includes(id))
    );
  checks.push({
    id: 'WEB33-P0-24',
    status: web33PrimaryComplete && web33MatrixComplete ? 'pass' : 'fail',
    detail:
      web33PrimaryComplete && web33MatrixComplete
        ? `all WEB33 journeys passed in three primary runs; critical theme/session journeys passed on Node ${runtimeMajors.join(',')} using one tgz`
        : 'WEB33 full or critical exact-tarball coverage is missing, skipped, failed, or dirty',
  });
  const decision: ReleaseGateDecisionV1 = checks.every(check => check.status === 'pass')
    ? 'GO'
    : 'NO_GO';
  const content = deepFreeze({
    version: RELEASE_RECEIPT_VERSION_V1,
    kind: 'orion.web-e2e-release' as const,
    createdAt: input.createdAt,
    source: deepFreeze({ ...input.source }),
    artifactReceiptDigest: input.artifactReceiptDigest,
    tarballSha256: input.tarballSha256,
    package: deepFreeze({ ...input.package }),
    primaryRuns: deepFreeze(primaryRuns),
    runtimeRuns: deepFreeze(runtimeRuns),
    liveCanary: input.liveCanary,
    checks: deepFreeze(checks),
    decision,
  });
  return deepFreeze({ ...content, receiptDigest: digestRuntimeValue(content) });
}

export function verifyWebE2EReleaseReceiptV1(value: unknown): WebE2EReleaseReceiptV1 {
  const receipt = value as WebE2EReleaseReceiptV1;
  if (!receipt || receipt.version !== 1 || receipt.kind !== 'orion.web-e2e-release') {
    throw new Error('Invalid WebE2EReleaseReceiptV1 envelope.');
  }
  const expected = createWebE2EReleaseReceiptV1({
    version: receipt.version,
    kind: receipt.kind,
    createdAt: receipt.createdAt,
    source: receipt.source,
    artifactReceiptDigest: receipt.artifactReceiptDigest,
    tarballSha256: receipt.tarballSha256,
    package: receipt.package,
    primaryRuns: receipt.primaryRuns,
    runtimeRuns: receipt.runtimeRuns,
    liveCanary: receipt.liveCanary,
  });
  if (expected.decision !== receipt.decision || expected.receiptDigest !== receipt.receiptDigest) {
    throw new Error('Web E2E release receipt decision or digest mismatch.');
  }
  return expected;
}

function validateWebE2ERun(input: WebE2ERunEvidenceV1): WebE2ERunEvidenceV1 {
  if (input.role !== 'primary' && input.role !== 'runtime') {
    throw new Error('Web E2E run role must be primary or runtime.');
  }
  assertPositiveInteger(input.ordinal, 'Web E2E run ordinal');
  assertNonEmpty(input.runId, 'Web E2E run id');
  assertHexDigest(input.source.gitSha, 'Web E2E run gitSha', 40, 64);
  assertHexDigest(input.artifactReceiptDigest, 'Web E2E run artifact receipt digest', 64, 64);
  assertHexDigest(input.tarballSha256, 'Web E2E run tarball sha256', 64, 64);
  assertHexDigest(input.installedTargetDigest, 'Web E2E installed target digest', 64, 64);
  assertHexDigest(input.manifestDigest, 'Web E2E manifest digest', 64, 64);
  assertNonEmpty(input.environment.node, 'Web E2E Node version');
  assertNonEmpty(input.environment.npm, 'Web E2E npm version');
  assertSupportedReleaseNodeVersionV1(
    input.environment.node,
    input.environment.nodeMajor,
    'Web E2E'
  );
  assertNonEmpty(input.browser.name, 'Web E2E browser name');
  assertNonEmpty(input.browser.version, 'Web E2E browser version');
  assertNonEmpty(input.browser.channel, 'Web E2E browser channel');
  assertNonEmpty(input.runner.name, 'Web E2E runner name');
  assertNonEmpty(input.runner.image, 'Web E2E runner image');
  assertHexDigest(input.runner.digest, 'Web E2E runner digest', 64, 64);
  assertIsoTimestamp(input.startedAt, 'Web E2E run startedAt');
  assertIsoTimestamp(input.completedAt, 'Web E2E run completedAt');
  if (Date.parse(input.completedAt) < Date.parse(input.startedAt)) {
    throw new Error('Web E2E run completedAt must not precede startedAt.');
  }
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0) {
    throw new Error('Web E2E run duration must be finite and non-negative.');
  }
  if (input.decision !== 'GO' && input.decision !== 'NO_GO') {
    throw new Error('Web E2E run decision must be GO or NO_GO.');
  }
  assertNonNegativeInteger(input.secretScanFindings, 'Web E2E secret scan findings');
  if (new Set(input.scenarioIds).size !== input.scenarioIds.length) {
    throw new Error('Web E2E run scenario ids must be unique.');
  }
  input.scenarioIds.forEach(id => assertNonEmpty(id, 'Web E2E scenario id'));
  return deepFreeze({
    ...input,
    source: { ...input.source },
    environment: { ...input.environment },
    browser: { ...input.browser },
    runner: { ...input.runner },
    scenarioIds: [...input.scenarioIds],
  });
}

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && right.every((value, index) => left[index] === value);
}

export function assertSupportedReleaseNodeVersionV1(
  node: string,
  nodeMajor: number,
  label = 'release'
): void {
  if (!SUPPORTED_RELEASE_NODE_MAJORS_V1.includes(nodeMajor as SupportedReleaseNodeMajorV1)) {
    throw new Error(`Unsupported ${label} Node major ${nodeMajor}.`);
  }
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(node);
  if (!match) throw new Error(`Invalid ${label} Node version ${node}.`);
  const observed = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  if (observed[0] !== nodeMajor) {
    throw new Error(`${label} Node version ${node} does not match declared major ${nodeMajor}.`);
  }
  const floor = SUPPORTED_RELEASE_NODE_FLOORS_V1[nodeMajor as SupportedReleaseNodeMajorV1];
  let comparison = 0;
  for (let index = 0; index < observed.length; index += 1) {
    if (observed[index] === floor[index]) continue;
    comparison = observed[index] - floor[index];
    break;
  }
  if (comparison < 0) {
    throw new Error(`${label} Node version ${node} is below supported floor v${floor.join('.')}.`);
  }
}

export function createReleaseReceiptV1(input: {
  readonly createdAt: string;
  readonly artifact: TarballArtifactReceiptV1;
  readonly runtimeMatrix: readonly RuntimeMatrixReceiptV1[];
  readonly webE2E: WebE2EReleaseReceiptV1;
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
  assertHexDigest(input.evidence.webE2EReceiptDigest, 'Web E2E receipt digest', 64, 64);
  if (!['GO', 'NO_GO'].includes(input.evidence.taskEvalDecision)) {
    throw new Error('Task evaluation decision must be GO or NO_GO.');
  }
  if (!['GO', 'NO_GO'].includes(input.evidence.architectureDecision)) {
    throw new Error('Architecture decision must be GO or NO_GO.');
  }
  if (!['GO', 'NO_GO'].includes(input.evidence.webE2EDecision)) {
    throw new Error('Web E2E decision must be GO or NO_GO.');
  }
  const artifact = verifyTarballArtifactReceiptV1(input.artifact);
  const webE2E = verifyWebE2EReleaseReceiptV1(input.webE2E);
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
    status: /^0\.3\.(0|[1-9]\d*)$/.test(artifact.package.version) ? 'pass' : 'fail',
    detail: `expected=${SUPPORTED_RELEASE_VERSION_LINE_V1} observed=${artifact.package.version}`,
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
  const webE2EBindingOk =
    webE2E.source.gitSha === artifact.source.gitSha &&
    webE2E.source.dirty === artifact.source.dirty &&
    webE2E.artifactReceiptDigest === artifact.receiptDigest &&
    webE2E.tarballSha256 === artifact.tarball.sha256 &&
    webE2E.package.name === artifact.package.name &&
    webE2E.package.version === artifact.package.version &&
    input.evidence.webE2EReceiptDigest === webE2E.receiptDigest &&
    input.evidence.webE2EDecision === webE2E.decision;
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
  checks.push({
    id: 'web_e2e',
    status: webE2EBindingOk && webE2E.decision === 'GO' ? 'pass' : 'fail',
    detail: webE2EBindingOk
      ? webE2E.receiptDigest
      : 'Web E2E receipt is not strongly bound to the final artifact and evidence digest',
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
    webE2E,
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

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
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
