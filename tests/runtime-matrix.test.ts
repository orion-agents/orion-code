import {
  createGateEvidenceReceiptV1,
  createReleaseReceiptV1,
  createRuntimeMatrixReceiptV1,
  createTarballArtifactReceiptV1,
  verifyRuntimeMatrixReceiptV1,
} from '../src/runtime/release-receipts';
import { parseGateEvidenceArgumentsV1 } from '../scripts/release/gate-evidence';
import { parseAssembleReleaseArgumentsV1 } from '../scripts/release/assemble-release-receipt';

const SHA = 'a'.repeat(64);
const GIT_SHA = 'b'.repeat(40);

function artifact(options: { dirty?: boolean; version?: string } = {}) {
  return createTarballArtifactReceiptV1({
    version: 1,
    kind: 'orion.tarball-artifact',
    createdAt: '2026-08-26T00:00:00.000Z',
    source: { gitSha: GIT_SHA, dirty: options.dirty ?? false },
    package: { name: '@orion-agents/orion-code', version: options.version ?? '0.2.0' },
    tarball: {
      filename: 'orion-agents-orion-code-0.2.0.tgz',
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
  nodeMajor: 20 | 22 | 24,
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
      node: `v${nodeMajor}.0.0`,
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

const evidence = {
  benchmarkComparisonDigest: 'd'.repeat(64),
  benchmarkOk: true,
  taskEvalComparisonDigest: '9'.repeat(64),
  taskEvalDecision: 'GO' as const,
  architectureConfluenceDigest: 'e'.repeat(64),
  architectureDecision: 'GO' as const,
  fullTestDigest: 'f'.repeat(64),
  fullTestsPassed: true,
};

describe('v0.2.0 release receipts', () => {
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
        '--runtime=r20.json',
        '--runtime',
        'r22.json',
        '--runtime=r24.json',
        '--benchmark-baseline=b.json',
        '--benchmark-candidate=c.json',
        '--benchmark-comparison=bc.json',
        '--evaluation=e.json',
        '--confluence=h.json',
        '--full-tests=f.json',
        '--out=release.json',
      ]).runtimes
    ).toHaveLength(3);
  });

  test('digest-binds generic gate evidence', () => {
    const receipt = createGateEvidenceReceiptV1({
      version: 1,
      kind: 'orion.gate-evidence',
      createdAt: '2026-08-26T00:00:00.000Z',
      gateId: 'full-tests',
      source: { gitSha: GIT_SHA, packageVersion: '0.2.0' },
      commandDigest: '4'.repeat(64),
      outputDigest: '5'.repeat(64),
      durationMs: 123,
      status: 'pass',
    });
    expect(receipt.receiptDigest).toHaveLength(64);
  });

  test('accepts only a complete Node 20/22/24 matrix bound to one exact tarball', () => {
    const receipt = createReleaseReceiptV1({
      createdAt: '2026-08-26T01:00:00.000Z',
      artifact: artifact(),
      runtimeMatrix: [runtime(24), runtime(20), runtime(22)],
      evidence,
    });

    expect(receipt.decision).toBe('GO');
    expect(receipt.runtimeMatrix.map(item => item.environment.nodeMajor)).toEqual([20, 22, 24]);
    expect(receipt.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'pass' })])
    );
  });

  test('is NO_GO for missing matrix evidence or any failed runtime probe', () => {
    const missing = createReleaseReceiptV1({
      createdAt: '2026-08-26T01:00:00.000Z',
      artifact: artifact(),
      runtimeMatrix: [runtime(20), runtime(22)],
      evidence,
    });
    const failed = createReleaseReceiptV1({
      createdAt: '2026-08-26T01:00:00.000Z',
      artifact: artifact(),
      runtimeMatrix: [runtime(20), runtime(22, 'fail'), runtime(24)],
      evidence,
    });

    expect(missing.decision).toBe('NO_GO');
    expect(failed.decision).toBe('NO_GO');
  });

  test('is NO_GO when Node jobs did not use the same probe runner', () => {
    const receipt = createReleaseReceiptV1({
      createdAt: '2026-08-26T01:00:00.000Z',
      artifact: artifact(),
      runtimeMatrix: [runtime(20), runtime(22, 'pass', '7'.repeat(64)), runtime(24)],
      evidence,
    });

    expect(receipt.decision).toBe('NO_GO');
    expect(receipt.checks).toContainEqual(
      expect.objectContaining({ id: 'runtime_probe_identity', status: 'fail' })
    );
  });

  test('is NO_GO for a dirty source, wrong version, or failed task evaluation', () => {
    const dirtyArtifact = artifact({ dirty: true });
    const wrongVersionArtifact = artifact({ version: '0.1.9' });
    expect(
      createReleaseReceiptV1({
        createdAt: '2026-08-26T01:00:00.000Z',
        artifact: dirtyArtifact,
        runtimeMatrix: [runtime(20), runtime(22), runtime(24)],
        evidence,
      }).decision
    ).toBe('NO_GO');
    expect(
      createReleaseReceiptV1({
        createdAt: '2026-08-26T01:00:00.000Z',
        artifact: wrongVersionArtifact,
        runtimeMatrix: [runtime(20), runtime(22), runtime(24)],
        evidence,
      }).decision
    ).toBe('NO_GO');
    expect(
      createReleaseReceiptV1({
        createdAt: '2026-08-26T01:00:00.000Z',
        artifact: artifact(),
        runtimeMatrix: [runtime(20), runtime(22), runtime(24)],
        evidence: { ...evidence, taskEvalDecision: 'NO_GO' },
      }).decision
    ).toBe('NO_GO');
  });

  test('rejects tampered runtime receipts and unsupported Node majors', () => {
    expect(() =>
      verifyRuntimeMatrixReceiptV1({ ...runtime(20), receiptDigest: '0'.repeat(64) })
    ).toThrow('digest mismatch');
    expect(() =>
      createRuntimeMatrixReceiptV1({
        ...runtime(20),
        environment: { ...runtime(20).environment, nodeMajor: 26 },
      })
    ).toThrow('Unsupported release Node major');
  });
});
