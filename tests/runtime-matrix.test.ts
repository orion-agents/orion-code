import {
  assertSupportedReleaseNodeVersionV1,
  createGateEvidenceReceiptV1,
  createReleaseReceiptV1,
  createRuntimeMatrixReceiptV1,
  createTarballArtifactReceiptV1,
  createWebE2EReleaseReceiptV1,
  verifyGateEvidenceReceiptV1,
  verifyRuntimeMatrixReceiptV1,
  verifyWebE2EReleaseReceiptV1,
  WEB_E2E_CRITICAL_SCENARIOS_V1,
  WEB_E2E_FULL_SCENARIOS_V1,
  WEB_E2E_WEB31_CRITICAL_SCENARIOS_V1,
  WEB_E2E_WEB31_SCENARIOS_V1,
  WEB_E2E_WEB32_CRITICAL_SCENARIOS_V1,
  WEB_E2E_WEB32_SCENARIOS_V1,
  WEB_E2E_WEB33_CRITICAL_SCENARIOS_V1,
  WEB_E2E_WEB33_SCENARIOS_V1,
} from '../src/runtime/release-receipts';
import { parseGateEvidenceArgumentsV1 } from '../scripts/release/gate-evidence';
import { parseAssembleReleaseArgumentsV1 } from '../scripts/release/assemble-release-receipt';
import { webE2ERunnerDigest, webE2EScenarioIdFromTitle } from './e2e/scenarios';

const SHA = 'a'.repeat(64);
const GIT_SHA = 'b'.repeat(40);
const NODE_VERSION_BY_MAJOR = {
  22: 'v22.12.0',
  24: 'v24.0.0',
  26: 'v26.0.0',
} as const;

function artifact(options: { dirty?: boolean; version?: string } = {}) {
  const version = options.version ?? '0.3.3';
  return createTarballArtifactReceiptV1({
    version: 1,
    kind: 'orion.tarball-artifact',
    createdAt: '2026-08-26T00:00:00.000Z',
    source: { gitSha: GIT_SHA, dirty: options.dirty ?? false },
    package: { name: '@orion-agents/orion-code', version },
    tarball: {
      filename: `orion-agents-orion-code-${version}.tgz`,
      sha256: SHA,
      npmIntegrity: 'sha512-fixture',
      bytes: 100,
      unpackedBytes: 400,
      entryCount: 20,
      manifestDigest: 'c'.repeat(64),
    },
  });
}

function runtime(
  nodeMajor: 22 | 24 | 26,
  status: 'pass' | 'fail' = 'pass',
  runnerDigest = '2'.repeat(64)
) {
  const packaged = artifact();
  return createRuntimeMatrixReceiptV1({
    version: 1,
    kind: 'orion.runtime-matrix',
    createdAt: '2026-08-26T00:00:00.000Z',
    artifactReceiptDigest: packaged.receiptDigest,
    tarballSha256: packaged.tarball.sha256,
    package: packaged.package,
    environment: {
      node: NODE_VERSION_BY_MAJOR[nodeMajor],
      nodeMajor,
      npm: '11.0.0',
      platform: 'linux',
      arch: 'x64',
    },
    probes: [
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
    ].map((id, index) => ({
      id: id as Parameters<typeof createRuntimeMatrixReceiptV1>[0]['probes'][number]['id'],
      status: index === 0 ? status : 'pass',
      detail: `${id} ${index === 0 ? status : 'pass'}`,
      durationMs: index,
      runnerDigest,
      targetDigest: '3'.repeat(64),
    })),
  });
}

function webRun(role: 'primary' | 'runtime', ordinal: number) {
  const packaged = artifact();
  const nodeMajor = role === 'runtime' ? ordinal : 22;
  return {
    role,
    ordinal,
    runId: `${role}-${ordinal}`,
    source: packaged.source,
    artifactReceiptDigest: packaged.receiptDigest,
    tarballSha256: packaged.tarball.sha256,
    installedTargetDigest: '3'.repeat(64),
    environment: {
      node: `v${nodeMajor}.20.0`,
      nodeMajor,
      npm: '10.9.0',
      platform: 'linux' as const,
      arch: 'x64',
    },
    browser: { name: 'chromium', version: '151.0.0.0', channel: 'system-google-chrome' },
    runner: {
      name: 'github-actions',
      image: 'ubuntu24@20260826.1-X64',
      digest: '4'.repeat(64),
    },
    startedAt: `2026-08-26T00:00:${String(ordinal * 2).padStart(2, '0')}.000Z`,
    completedAt: `2026-08-26T00:00:${String(ordinal * 2 + 1).padStart(2, '0')}.000Z`,
    scenarioIds: role === 'primary' ? WEB_E2E_FULL_SCENARIOS_V1 : WEB_E2E_CRITICAL_SCENARIOS_V1,
    durationMs: 100,
    manifestDigest: String(ordinal).repeat(64).slice(0, 64),
    secretScanFindings: 0,
    cleanEvidence: true,
    decision: 'GO' as const,
  };
}

function webReceipt() {
  const packaged = artifact();
  return createWebE2EReleaseReceiptV1({
    version: 1,
    kind: 'orion.web-e2e-release',
    createdAt: '2026-08-26T00:01:00.000Z',
    source: packaged.source,
    artifactReceiptDigest: packaged.receiptDigest,
    tarballSha256: packaged.tarball.sha256,
    package: packaged.package,
    primaryRuns: [webRun('primary', 1), webRun('primary', 2), webRun('primary', 3)],
    runtimeRuns: [webRun('runtime', 22), webRun('runtime', 24), webRun('runtime', 26)],
    liveCanary: 'NOT_RUN',
  });
}

const WEB_E2E = webReceipt();
const evidence = {
  benchmarkComparisonDigest: 'd'.repeat(64),
  benchmarkOk: true,
  taskEvalComparisonDigest: '9'.repeat(64),
  taskEvalDecision: 'GO' as const,
  architectureConfluenceDigest: 'e'.repeat(64),
  architectureDecision: 'GO' as const,
  fullTestDigest: 'f'.repeat(64),
  fullTestsPassed: true,
  webE2EReceiptDigest: WEB_E2E.receiptDigest,
  webE2EDecision: WEB_E2E.decision,
};

describe('v0.3.x release receipts', () => {
  test('recognizes every Settings P0 scenario in full and critical contracts', () => {
    const expected = Array.from(
      { length: 14 },
      (_, index) => `SET-P0-${String(index + 1).padStart(2, '0')}`
    );

    expect(WEB_E2E_FULL_SCENARIOS_V1).toEqual(expect.arrayContaining(expected));
    expect(WEB_E2E_CRITICAL_SCENARIOS_V1).toEqual(expect.arrayContaining(expected));
    expect(webE2EScenarioIdFromTitle('SET-P0-14 @settings exact tgz matrix')).toBe('SET-P0-14');
    expect(() => webE2EScenarioIdFromTitle('SET-P0-01 missing tag')).toThrow('@settings');
    expect(webE2ERunnerDigest()).toMatch(/^[a-f0-9]{64}$/u);
  });

  test('recognizes all WEB31 journeys and the frozen critical Web/PTY subset', () => {
    const expected = Array.from(
      { length: 12 },
      (_, index) => `WEB31-P0-${String(index + 1).padStart(2, '0')}`
    );

    expect(WEB_E2E_WEB31_SCENARIOS_V1).toEqual(expected);
    expect(WEB_E2E_FULL_SCENARIOS_V1).toEqual(expect.arrayContaining(expected));
    expect(WEB_E2E_WEB31_CRITICAL_SCENARIOS_V1).toEqual([
      'WEB31-P0-01',
      'WEB31-P0-02',
      'WEB31-P0-08',
      'WEB31-P0-09',
      'WEB31-P0-10',
      'WEB31-P0-12',
    ]);
    expect(WEB_E2E_CRITICAL_SCENARIOS_V1).toEqual(
      expect.arrayContaining(WEB_E2E_WEB31_CRITICAL_SCENARIOS_V1)
    );
    expect(webE2EScenarioIdFromTitle('WEB31-P0-08 real PTY exact tgz')).toBe('WEB31-P0-08');
    expect(() => webE2EScenarioIdFromTitle('WEB31-P0-01 and WEB31-P0-02')).toThrow('exactly one');
  });

  test('recognizes all WEB32 journeys and the frozen critical Composer/Layout subset', () => {
    const expected = Array.from(
      { length: 12 },
      (_, index) => `WEB32-P0-${String(index + 1).padStart(2, '0')}`
    );

    expect(WEB_E2E_WEB32_SCENARIOS_V1).toEqual(expected);
    expect(WEB_E2E_FULL_SCENARIOS_V1).toEqual(expect.arrayContaining(expected));
    expect(WEB_E2E_WEB32_CRITICAL_SCENARIOS_V1).toEqual([
      'WEB32-P0-01',
      'WEB32-P0-04',
      'WEB32-P0-05',
      'WEB32-P0-06',
      'WEB32-P0-09',
      'WEB32-P0-11',
      'WEB32-P0-12',
    ]);
    expect(WEB_E2E_CRITICAL_SCENARIOS_V1).toEqual(
      expect.arrayContaining(WEB_E2E_WEB32_CRITICAL_SCENARIOS_V1)
    );
    expect(webE2EScenarioIdFromTitle('WEB32-P0-06 compact before model switch')).toBe(
      'WEB32-P0-06'
    );
    expect(() => webE2EScenarioIdFromTitle('WEB32-P0-01 and WEB32-P0-02')).toThrow('exactly one');
  });

  test('recognizes the WEB33 theme and multi-session journeys with a frozen critical subset', () => {
    const expected = [
      ...Array.from({ length: 12 }, (_, index) => `WEB33-P0-${String(index + 1).padStart(2, '0')}`),
      ...Array.from({ length: 9 }, (_, index) => `WEB33-P0-${String(index + 16).padStart(2, '0')}`),
    ];

    expect(WEB_E2E_WEB33_SCENARIOS_V1).toEqual(expected);
    expect(WEB_E2E_FULL_SCENARIOS_V1).toEqual(expect.arrayContaining(expected));
    expect(WEB_E2E_WEB33_CRITICAL_SCENARIOS_V1).toEqual([
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
    ]);
    expect(WEB_E2E_CRITICAL_SCENARIOS_V1).toEqual(
      expect.arrayContaining(WEB_E2E_WEB33_CRITICAL_SCENARIOS_V1)
    );
    expect(webE2EScenarioIdFromTitle('WEB33-P0-23 shell geometry')).toBe('WEB33-P0-23');
    expect(() => webE2EScenarioIdFromTitle('WEB33-P0-23 and WEB33-P0-24')).toThrow('exactly one');
  });

  test('accepts only declared Node majors at or above their supported floor', () => {
    for (const [major, version] of Object.entries(NODE_VERSION_BY_MAJOR)) {
      expect(() => assertSupportedReleaseNodeVersionV1(version, Number(major))).not.toThrow();
    }
    expect(() => assertSupportedReleaseNodeVersionV1('v22.11.9', 22)).toThrow(
      'below supported floor v22.12.0'
    );
    expect(() => assertSupportedReleaseNodeVersionV1('v22.12.0', 24)).toThrow(
      'does not match declared major 24'
    );
    expect(() => assertSupportedReleaseNodeVersionV1('v25.1.0', 25)).toThrow(
      'Unsupported release Node major 25'
    );
    expect(() => assertSupportedReleaseNodeVersionV1('v20.20.2', 20)).toThrow(
      'Unsupported release Node major 20'
    );
    expect(() => assertSupportedReleaseNodeVersionV1('22.12', 22)).toThrow(
      'Invalid release Node version 22.12'
    );
  });

  test('parses fail-closed gate and aggregate receipt commands', () => {
    expect(
      parseGateEvidenceArgumentsV1([
        '--id',
        'full-tests',
        '--out',
        'full.json',
        '--',
        'npm',
        'test',
        '--',
        '--runInBand',
      ])
    ).toMatchObject({
      gateId: 'full-tests',
      command: 'npm',
      commandArguments: ['test', '--', '--runInBand'],
    });
    expect(() => parseGateEvidenceArgumentsV1(['--id', 'full-tests'])).toThrow('Usage');
    expect(
      parseAssembleReleaseArgumentsV1([
        '--artifact=a.json',
        '--runtime=r22.json',
        '--runtime=r24.json',
        '--runtime=r26.json',
        '--benchmark-baseline=b.json',
        '--benchmark-candidate=c.json',
        '--benchmark-comparison=bc.json',
        '--evaluation=e.json',
        '--confluence=h.json',
        '--full-tests=f.json',
        '--web-e2e=w.json',
        '--out=release.json',
      ]).runtimes
    ).toHaveLength(3);
  });

  test('digest-binds generic gate evidence', () => {
    const input = {
      version: 1 as const,
      kind: 'orion.gate-evidence' as const,
      createdAt: '2026-08-26T00:00:00.000Z',
      gateId: 'full-tests',
      source: { gitSha: GIT_SHA, packageVersion: '0.3.3' },
      commandDigest: '4'.repeat(64),
      outputDigest: '5'.repeat(64),
      durationMs: 123,
      status: 'pass' as const,
    };
    const receipt = createGateEvidenceReceiptV1(input);
    expect(receipt.receiptDigest).toHaveLength(64);
    expect(verifyGateEvidenceReceiptV1(receipt)).toEqual(receipt);
    expect(() => createGateEvidenceReceiptV1({ ...input, createdAt: 'not-a-timestamp' })).toThrow(
      'must be ISO-8601'
    );
    expect(() => createGateEvidenceReceiptV1({ ...input, gateId: ' ' })).toThrow(
      'must not be empty'
    );
    expect(() => createGateEvidenceReceiptV1({ ...input, commandDigest: 'NOT-A-DIGEST' })).toThrow(
      'lowercase hexadecimal digest'
    );
    expect(() => createGateEvidenceReceiptV1({ ...input, durationMs: -1 })).toThrow(
      'finite and non-negative'
    );
    expect(() => createGateEvidenceReceiptV1({ ...input, status: 'skip' as 'pass' })).toThrow(
      'status must be pass or fail'
    );
    expect(() => verifyGateEvidenceReceiptV1(null)).toThrow('Invalid GateEvidenceReceiptV1');
    expect(() =>
      verifyGateEvidenceReceiptV1({ ...receipt, receiptDigest: '0'.repeat(64) })
    ).toThrow('digest mismatch');
  });

  test('rejects invalid aggregate evidence decisions before producing a release receipt', () => {
    const create = (invalidEvidence: typeof evidence) =>
      createReleaseReceiptV1({
        createdAt: '2026-08-26T01:00:00.000Z',
        artifact: artifact(),
        runtimeMatrix: [runtime(22), runtime(24), runtime(26)],
        webE2E: WEB_E2E,
        evidence: invalidEvidence,
      });

    expect(() => create({ ...evidence, taskEvalDecision: 'INVALID' as 'GO' })).toThrow(
      'Task evaluation decision must be GO or NO_GO'
    );
    expect(() => create({ ...evidence, architectureDecision: 'INVALID' as 'GO' })).toThrow(
      'Architecture decision must be GO or NO_GO'
    );
    expect(() => create({ ...evidence, webE2EDecision: 'INVALID' as 'GO' })).toThrow(
      'Web E2E decision must be GO or NO_GO'
    );
  });

  test('binds three full browser runs and the Node 22/24/26 browser matrix', () => {
    const packaged = artifact();
    const receipt = createWebE2EReleaseReceiptV1({
      version: 1,
      kind: 'orion.web-e2e-release',
      createdAt: '2026-08-26T00:00:00.000Z',
      source: packaged.source,
      artifactReceiptDigest: packaged.receiptDigest,
      tarballSha256: packaged.tarball.sha256,
      package: packaged.package,
      primaryRuns: [webRun('primary', 1), webRun('primary', 2), webRun('primary', 3)],
      runtimeRuns: [webRun('runtime', 22), webRun('runtime', 24), webRun('runtime', 26)],
      liveCanary: 'NOT_RUN',
    });

    expect(receipt.decision).toBe('GO');
    expect(verifyWebE2EReleaseReceiptV1(receipt)).toEqual(receipt);
    expect(() =>
      verifyWebE2EReleaseReceiptV1({ ...receipt, receiptDigest: '0'.repeat(64) })
    ).toThrow('digest mismatch');
  });

  test('fails Web E2E receipt when a primary run or Node runtime is missing', () => {
    const packaged = artifact();
    const receipt = createWebE2EReleaseReceiptV1({
      version: 1,
      kind: 'orion.web-e2e-release',
      createdAt: '2026-08-26T00:00:00.000Z',
      source: packaged.source,
      artifactReceiptDigest: packaged.receiptDigest,
      tarballSha256: packaged.tarball.sha256,
      package: packaged.package,
      primaryRuns: [webRun('primary', 1), webRun('primary', 2)],
      runtimeRuns: [webRun('runtime', 22), webRun('runtime', 24)],
      liveCanary: 'NOT_RUN',
    });

    expect(receipt.decision).toBe('NO_GO');
  });

  test('fails closed for skipped versioned Web coverage, duplicate runs, or secrets', () => {
    const packaged = artifact();
    const create = (
      primaryRuns: ReturnType<typeof webRun>[],
      runtimeRuns: ReturnType<typeof webRun>[]
    ) =>
      createWebE2EReleaseReceiptV1({
        version: 1,
        kind: 'orion.web-e2e-release',
        createdAt: '2026-08-26T00:00:00.000Z',
        source: packaged.source,
        artifactReceiptDigest: packaged.receiptDigest,
        tarballSha256: packaged.tarball.sha256,
        package: packaged.package,
        primaryRuns,
        runtimeRuns,
        liveCanary: 'NOT_RUN',
      });
    const primary = [webRun('primary', 1), webRun('primary', 2), webRun('primary', 3)];
    const runtimeRuns = [webRun('runtime', 22), webRun('runtime', 24), webRun('runtime', 26)];
    const skipped = {
      ...runtimeRuns[0],
      scenarioIds: runtimeRuns[0].scenarioIds.filter(id => id !== 'SET-P0-14'),
    };
    const skippedWeb31 = {
      ...runtimeRuns[1],
      scenarioIds: runtimeRuns[1].scenarioIds.filter(id => id !== 'WEB31-P0-09'),
    };
    const skippedWeb32 = {
      ...runtimeRuns[2],
      scenarioIds: runtimeRuns[2].scenarioIds.filter(id => id !== 'WEB32-P0-09'),
    };
    const skippedWeb33 = {
      ...runtimeRuns[0],
      scenarioIds: runtimeRuns[0].scenarioIds.filter(id => id !== 'WEB33-P0-23'),
    };
    const duplicate = { ...primary[1], runId: primary[0].runId };
    const duplicateRuntime = {
      ...runtimeRuns[1],
      runId: runtimeRuns[0].runId,
      manifestDigest: runtimeRuns[0].manifestDigest,
    };
    const leaked = { ...runtimeRuns[2], secretScanFindings: 1 };

    expect(create(primary, [skipped, runtimeRuns[1], runtimeRuns[2]]).decision).toBe('NO_GO');
    expect(create(primary, [runtimeRuns[0], skippedWeb31, runtimeRuns[2]]).decision).toBe('NO_GO');
    expect(create(primary, [runtimeRuns[0], runtimeRuns[1], skippedWeb32]).decision).toBe('NO_GO');
    expect(create(primary, [skippedWeb33, runtimeRuns[1], runtimeRuns[2]]).decision).toBe('NO_GO');
    expect(create([primary[0], duplicate, primary[2]], runtimeRuns).decision).toBe('NO_GO');
    expect(create(primary, [runtimeRuns[0], duplicateRuntime, runtimeRuns[2]]).decision).toBe(
      'NO_GO'
    );
    expect(create(primary, [runtimeRuns[0], runtimeRuns[1], leaked]).decision).toBe('NO_GO');
  });

  test('fails Web E2E receipt when an attempted live canary fails', () => {
    const packaged = artifact();
    const create = (liveCanary: 'PASS' | 'FAIL' | 'NOT_RUN') =>
      createWebE2EReleaseReceiptV1({
        version: 1,
        kind: 'orion.web-e2e-release',
        createdAt: '2026-08-26T00:00:00.000Z',
        source: packaged.source,
        artifactReceiptDigest: packaged.receiptDigest,
        tarballSha256: packaged.tarball.sha256,
        package: packaged.package,
        primaryRuns: [webRun('primary', 1), webRun('primary', 2), webRun('primary', 3)],
        runtimeRuns: [webRun('runtime', 22), webRun('runtime', 24), webRun('runtime', 26)],
        liveCanary,
      });

    expect(create('PASS').decision).toBe('GO');
    expect(create('NOT_RUN').decision).toBe('GO');
    expect(create('FAIL')).toEqual(
      expect.objectContaining({
        decision: 'NO_GO',
        checks: expect.arrayContaining([
          expect.objectContaining({ id: 'live_canary', status: 'fail' }),
        ]),
      })
    );
  });

  test('accepts only a complete Node 22/24/26 matrix bound to one exact tarball', () => {
    const receipt = createReleaseReceiptV1({
      createdAt: '2026-08-26T01:00:00.000Z',
      artifact: artifact(),
      runtimeMatrix: [runtime(24), runtime(26), runtime(22)],
      webE2E: WEB_E2E,
      evidence,
    });

    expect(receipt.decision).toBe('GO');
    expect(receipt.webE2E.receiptDigest).toBe(WEB_E2E.receiptDigest);
    expect(receipt.evidence.webE2EReceiptDigest).toBe(receipt.webE2E.receiptDigest);
    expect(receipt.runtimeMatrix.map(item => item.environment.nodeMajor)).toEqual([22, 24, 26]);
    expect(receipt.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'pass' })])
    );
  });

  test('is NO_GO for missing matrix evidence or any failed runtime probe', () => {
    const missing = createReleaseReceiptV1({
      createdAt: '2026-08-26T01:00:00.000Z',
      artifact: artifact(),
      runtimeMatrix: [runtime(22), runtime(24)],
      webE2E: WEB_E2E,
      evidence,
    });
    const failed = createReleaseReceiptV1({
      createdAt: '2026-08-26T01:00:00.000Z',
      artifact: artifact(),
      runtimeMatrix: [runtime(22), runtime(24, 'fail'), runtime(26)],
      webE2E: WEB_E2E,
      evidence,
    });

    expect(missing.decision).toBe('NO_GO');
    expect(failed.decision).toBe('NO_GO');
  });

  test('is NO_GO when Node jobs did not use the same probe runner', () => {
    const receipt = createReleaseReceiptV1({
      createdAt: '2026-08-26T01:00:00.000Z',
      artifact: artifact(),
      runtimeMatrix: [runtime(22), runtime(24, 'pass', '7'.repeat(64)), runtime(26)],
      webE2E: WEB_E2E,
      evidence,
    });

    expect(receipt.decision).toBe('NO_GO');
    expect(receipt.checks).toContainEqual(
      expect.objectContaining({ id: 'runtime_probe_identity', status: 'fail' })
    );
  });

  test('is NO_GO when final evidence does not bind the embedded Web E2E receipt', () => {
    const receipt = createReleaseReceiptV1({
      createdAt: '2026-08-26T01:00:00.000Z',
      artifact: artifact(),
      runtimeMatrix: [runtime(22), runtime(24), runtime(26)],
      webE2E: WEB_E2E,
      evidence: { ...evidence, webE2EReceiptDigest: '8'.repeat(64) },
    });

    expect(receipt.decision).toBe('NO_GO');
    expect(receipt.checks).toContainEqual(
      expect.objectContaining({ id: 'web_e2e', status: 'fail' })
    );
  });

  test('is NO_GO for a dirty source, wrong version, or failed task evaluation', () => {
    const dirtyArtifact = artifact({ dirty: true });
    const wrongVersionArtifact = artifact({ version: '0.1.9' });
    expect(
      createReleaseReceiptV1({
        createdAt: '2026-08-26T01:00:00.000Z',
        artifact: dirtyArtifact,
        runtimeMatrix: [runtime(22), runtime(24), runtime(26)],
        webE2E: WEB_E2E,
        evidence,
      }).decision
    ).toBe('NO_GO');
    expect(
      createReleaseReceiptV1({
        createdAt: '2026-08-26T01:00:00.000Z',
        artifact: wrongVersionArtifact,
        runtimeMatrix: [runtime(22), runtime(24), runtime(26)],
        webE2E: WEB_E2E,
        evidence,
      }).decision
    ).toBe('NO_GO');
    expect(
      createReleaseReceiptV1({
        createdAt: '2026-08-26T01:00:00.000Z',
        artifact: artifact(),
        runtimeMatrix: [runtime(22), runtime(24), runtime(26)],
        webE2E: WEB_E2E,
        evidence: { ...evidence, taskEvalDecision: 'NO_GO' },
      }).decision
    ).toBe('NO_GO');
  });

  test('rejects tampered runtime receipts and unsupported Node majors', () => {
    expect(() =>
      verifyRuntimeMatrixReceiptV1({ ...runtime(22), receiptDigest: '0'.repeat(64) })
    ).toThrow('digest mismatch');
    expect(() =>
      createRuntimeMatrixReceiptV1({
        ...runtime(22),
        environment: { ...runtime(22).environment, nodeMajor: 25 },
      })
    ).toThrow('Unsupported release Node major');
  });
});
