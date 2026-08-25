import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, resolve } from 'path';

import {
  ArchitectureConfluenceError,
  DEFAULT_RESOURCE_SCOPE_CHURN_CYCLES,
  runArchitectureConfluenceAuditV1,
  runResourceScopeChurnV1,
  verifyArchitectureConfluenceReceiptV1,
  type ArchitectureConfluenceReceiptV1,
} from '../src/runtime/harness-confluence';
import { runHarnessConfluenceGateV1 } from '../scripts/bench/harness-confluence';

const repositoryRoot = resolve(__dirname, '..');
const temporaryRoots: string[] = [];

function writeFixture(root: string, path: string, content: string): void {
  const absolute = resolve(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
}

function createConfluentFixture(options: { forbiddenBrainExport?: boolean } = {}): string {
  const root = mkdtempSync(resolve(tmpdir(), 'orion-confluence-'));
  temporaryRoots.push(root);
  writeFixture(
    root,
    'package.json',
    JSON.stringify({ name: 'confluent-fixture', main: 'dist/index.js', files: ['dist/'] })
  );
  writeFixture(root, 'tsconfig.json', JSON.stringify({ include: ['src/**/*'] }));
  writeFixture(
    root,
    'src/cli.ts',
    "import { OrionRuntimeV1 } from './runtime/orion-runtime-v1';\nexport { OrionRuntimeV1 };\n"
  );
  writeFixture(
    root,
    'src/index.ts',
    [
      "export { OrionRuntimeV1 } from './runtime/orion-runtime-v1';",
      options.forbiddenBrainExport ? 'export class Brain {}' : '',
      '',
    ].join('\n')
  );
  writeFixture(
    root,
    'src/runtime/orion-runtime-v1.ts',
    [
      "import { AgentLoopV1 } from './agent-loop';",
      "import type { TaskContextService } from './task-context-service';",
      "import type { QueryEvent } from '../framework/query';",
      'export class OrionRuntimeV1 {',
      '  readonly queryEvent?: QueryEvent;',
      '  constructor(readonly loop: AgentLoopV1, readonly taskContext: TaskContextService) {}',
      '}',
      '',
    ].join('\n')
  );
  writeFixture(root, 'src/framework/query.ts', 'export interface QueryEvent {}\n');
  writeFixture(root, 'src/runtime/agent-loop.ts', 'export class AgentLoopV1 {}\n');
  writeFixture(
    root,
    'src/runtime/task-context-service.ts',
    "export interface TaskContextService { readonly serviceId: 'task-context' }\n"
  );
  return root;
}

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

describe('ArchitectureConfluenceReceiptV1', () => {
  jest.setTimeout(30_000);

  test('records the legacy public/source cut independently of remaining Phase 7 gates', async () => {
    const receipt = await runArchitectureConfluenceAuditV1({
      repositoryRoot,
      clock: () => 1_725_000_000_000,
    });

    expect(receipt.strict).toBe(true);
    expect(receipt.counts.forbiddenExports).toBe(0);
    expect(receipt.counts.forbiddenTarballEntries).toBe(0);
    expect(receipt.tarball.forbiddenEntries).toEqual([]);
    expect(receipt.tarball.compilerExcludes).toEqual(
      expect.arrayContaining(['src/runtime/goals/coordinator.ts'])
    );
    expect(receipt.findings.some(finding => finding.ruleId.startsWith('forbidden-export:'))).toBe(
      false
    );
    expect(receipt.findings.some(finding => finding.ruleId === 'legacy-import')).toBe(false);
    expect(receipt.findings.some(finding => finding.ruleId === 'legacy-tarball-entry')).toBe(false);
    expect(receipt.owners.find(owner => owner.kind === 'runtime')?.status).toBe('pass');
    expect(receipt.owners.find(owner => owner.kind === 'task_context')?.status).toBe('pass');
    expect(receipt.resourceScope).toMatchObject({
      cycles: DEFAULT_RESOURCE_SCOPE_CHURN_CYCLES,
      status: 'pass',
      leakedResources: 0,
      leakedLeases: 0,
    });
    expect(verifyArchitectureConfluenceReceiptV1(receipt)).toBe(receipt);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.findings)).toBe(true);
  });

  test('returns GO for a single-owner production graph and clean package intent', async () => {
    const receipt = await runArchitectureConfluenceAuditV1({
      repositoryRoot: createConfluentFixture(),
      clock: () => 7,
    });

    expect(receipt.decision).toBe('GO');
    expect(receipt.findings).toEqual([]);
    expect(receipt.owners.every(owner => owner.status === 'pass')).toBe(true);
    expect(receipt.checks.every(check => check.status === 'pass')).toBe(true);
    expect(receipt.tarball.forbiddenEntries).toEqual([]);
    expect(verifyArchitectureConfluenceReceiptV1(receipt)).toBe(receipt);
  });

  test('supports explicit rules/allowlists while retaining fail-closed strict defaults', async () => {
    const root = createConfluentFixture({ forbiddenBrainExport: true });
    const blocked = await runArchitectureConfluenceAuditV1({
      repositoryRoot: root,
      config: { strict: false, scopeCycles: 2 },
      clock: () => 8,
    });
    const allowed = await runArchitectureConfluenceAuditV1({
      repositoryRoot: root,
      config: { strict: false, scopeCycles: 2, allow: { exports: ['Brain'] } },
      clock: () => 8,
    });

    expect(blocked.decision).toBe('NO_GO');
    expect(blocked.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleId: 'forbidden-export:Brain' })])
    );
    expect(allowed.decision).toBe('GO');
    await expect(
      runArchitectureConfluenceAuditV1({
        repositoryRoot: root,
        config: { strict: true, scopeCycles: 999 },
      })
    ).rejects.toThrow(ArchitectureConfluenceError);
  });

  test('rejects a tampered receipt instead of trusting its claimed decision', async () => {
    const receipt = await runArchitectureConfluenceAuditV1({
      repositoryRoot: createConfluentFixture(),
      clock: () => 9,
    });
    const tampered = {
      ...receipt,
      decision: 'NO_GO',
    } as ArchitectureConfluenceReceiptV1;

    expect(() => verifyArchitectureConfluenceReceiptV1(tampered)).toThrow(
      'Architecture confluence receipt digest mismatch'
    );
  });
});

describe('ResourceScope confluence evidence', () => {
  test('runs 1,000 alternating activation histories without leaking', async () => {
    const evidence = await runResourceScopeChurnV1();

    expect(evidence).toMatchObject({
      cycles: 1_000,
      resourcesActivated: 2_000,
      resourcesDisposed: 2_000,
      leasesAcquired: 1_000,
      leasesReleased: 1_000,
      leakedResources: 0,
      leakedLeases: 0,
      lifoViolations: 0,
      closeErrors: 0,
      timedOutCloses: 0,
      historyIndependent: true,
      status: 'pass',
    });
  });
});

describe('harness-confluence gate command', () => {
  test('returns exit code 0 only for a verified GO receipt', async () => {
    const receipt = await runArchitectureConfluenceAuditV1({
      repositoryRoot: createConfluentFixture(),
      config: { strict: false, scopeCycles: 1 },
      clock: () => 10,
    });
    let stdout = '';
    const exitCode = await runHarnessConfluenceGateV1(['--pretty'], {
      audit: async () => receipt,
      writeStdout: output => {
        stdout += output;
      },
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ decision: 'GO', digest: receipt.digest });
  });

  test('returns exit code 1 and emits the full receipt for NO_GO', async () => {
    const receipt = await runArchitectureConfluenceAuditV1({
      repositoryRoot: createConfluentFixture({ forbiddenBrainExport: true }),
      config: { strict: false, scopeCycles: 1 },
      clock: () => 10,
    });
    let stdout = '';
    const exitCode = await runHarnessConfluenceGateV1([], {
      audit: async () => receipt,
      writeStdout: output => {
        stdout += output;
      },
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ decision: 'NO_GO', digest: receipt.digest });
  });

  test('fails closed with exit code 2 on invalid input or audit errors', async () => {
    let stderr = '';
    const invalidArgument = await runHarnessConfluenceGateV1(['--unknown'], {
      writeStderr: output => {
        stderr += output;
      },
    });
    const auditFailure = await runHarnessConfluenceGateV1([], {
      audit: async () => {
        throw new Error('audit unavailable');
      },
      writeStderr: output => {
        stderr += output;
      },
    });

    expect(invalidArgument).toBe(2);
    expect(auditFailure).toBe(2);
    expect(stderr).toContain('"failClosed":true');
    expect(stderr).toContain('audit unavailable');
  });
});
