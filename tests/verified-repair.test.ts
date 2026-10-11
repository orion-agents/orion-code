/**
 * v0.3.23 T23-C — failure attribution, the bounded verified-repair loop, and
 * the five-state completion audit. Also guards against forbidden repairs
 * (test deletion, weakened assertions, modified acceptance criteria).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  attributeFailure,
  parseEsLintOutput,
  parseJestFailures,
  parseTypeScriptDiagnostics,
} from '../src/harness/failure-attribution';
import {
  assertNoForbiddenRepair,
  completionStateFromVerification,
  runVerifiedRepairLoop,
  snapshotTestFiles,
  ForbiddenRepairError,
  type VerificationRunV1,
} from '../src/harness/verified-repair';

const TSC_OUTPUT = `src/agent.ts(12,3): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
src/loop.ts(40,1): error TS2322: Type 'boolean' is not assignable to type 'string'.`;

const JEST_OUTPUT = `FAIL tests/math.test.ts
  ✕ divides correctly (5 ms)
  ✕ handles zero (2 ms)
Tests: 2 failed, 5 passed, 7 total`;

const ESLINT_OUTPUT = `src/agent.ts:10:5  error  Unexpected any  @typescript-eslint/no-explicit-any`;

describe('failure attribution (T23-C2)', () => {
  test('parses TypeScript diagnostics into file/line/code entries', () => {
    const evidence = attributeFailure(TSC_OUTPUT, 'npx tsc --noEmit');
    expect(evidence.kind).toBe('typescript');
    expect(evidence.entries).toHaveLength(2);
    expect(evidence.entries[0]).toMatchObject({
      file: 'src/agent.ts',
      line: 12,
      code: 'TS2345',
    });
    // The digest is stable over identical input.
    expect(evidence.digest).toBe(attributeFailure(TSC_OUTPUT, 'npx tsc --noEmit').digest);
    expect(parseTypeScriptDiagnostics(TSC_OUTPUT)).toHaveLength(2);
  });

  test('parses jest failures and classifies unit vs integration', () => {
    const unit = attributeFailure(JEST_OUTPUT, 'npx jest tests/math.test.ts');
    expect(unit.kind).toBe('unit-test');
    expect(parseJestFailures(JEST_OUTPUT)).toHaveLength(2);
    const integration = attributeFailure('FAIL e2e/journey.spec.ts\n✕ journey (1 s)', 'e2e');
    expect(integration.kind).toBe('integration-test');
  });

  test('parses eslint output and detects environment and provider failures', () => {
    expect(attributeFailure(ESLINT_OUTPUT, 'eslint src/').kind).toBe('lint');
    expect(parseEsLintOutput(ESLINT_OUTPUT)[0]).toMatchObject({ file: 'src/agent.ts', line: 10 });
    expect(attributeFailure('EACCES: permission denied', 'npm test').kind).toBe('environment');
    expect(attributeFailure('Error: provider returned rate limit 429', 'npm test').kind).toBe(
      'provider'
    );
    expect(attributeFailure('something unreadable happened', 'npm test').kind).toBe('unknown');
  });
});

function verification(ok: boolean, output: string): VerificationRunV1 {
  return { ok, output, command: 'npm test', durationMs: 10 };
}

describe('runVerifiedRepairLoop (T23-C3)', () => {
  test('completes on the first green verification without repairing', async () => {
    let repairs = 0;
    const outcome = await runVerifiedRepairLoop({
      verify: async () => verification(true, 'all good'),
      repair: async () => {
        repairs += 1;
      },
    });
    expect(outcome.terminal).toBe('completed');
    expect(outcome.attempts).toBe(1);
    expect(repairs).toBe(0);
  });

  test('repairs once and completes on re-verification', async () => {
    let calls = 0;
    let repairs = 0;
    const outcome = await runVerifiedRepairLoop({
      verify: async () => {
        calls += 1;
        return verification(calls > 1, calls > 1 ? 'ok' : JEST_OUTPUT);
      },
      repair: async () => {
        repairs += 1;
      },
    });
    expect(outcome.terminal).toBe('completed');
    expect(outcome.attempts).toBe(2);
    expect(repairs).toBe(1);
    expect(outcome.rounds[0].attribution.kind).toBe('unit-test');
  });

  test('fails after maxAttempts when verification keeps failing', async () => {
    let attempts = 0;
    const outcome = await runVerifiedRepairLoop({
      maxAttempts: 2,
      verify: async () => {
        attempts += 1;
        return verification(false, `FAIL run ${attempts}\n✕ failure mode ${attempts} ms`);
      },
      repair: async () => undefined,
    });
    expect(outcome.terminal).toBe('failed');
    expect(outcome.attempts).toBe(2);
    expect(outcome.failureReason).toContain('still failing');
  });

  test('blocks on no progress: identical failure digests across rounds', async () => {
    let attempts = 0;
    const outcome = await runVerifiedRepairLoop({
      maxAttempts: 5,
      verify: async () => {
        attempts += 1;
        return verification(false, JEST_OUTPUT); // identical every round
      },
      repair: async () => undefined,
    });
    expect(outcome.terminal).toBe('blocked');
    expect(outcome.noProgress).toBe(true);
    expect(attempts).toBeGreaterThanOrEqual(2);
  });

  test('blocks when the verification infrastructure itself fails', async () => {
    const outcome = await runVerifiedRepairLoop({
      verify: async () => {
        throw new Error('runner missing');
      },
      repair: async () => undefined,
    });
    expect(outcome.terminal).toBe('blocked');
    expect(outcome.failureReason).toContain('verification infrastructure');
  });

  test('cancels on the abort signal', async () => {
    const controller = new AbortController();
    const outcome = await runVerifiedRepairLoop({
      signal: controller.signal,
      verify: async () => verification(false, JEST_OUTPUT),
      repair: async () => {
        controller.abort();
      },
    });
    expect(outcome.terminal).toBe('cancelled');
  });
});

describe('forbidden repair guard (T23-C4)', () => {
  const workspaceBase = (): string => {
    const workspace = mkdtempSync(join(tmpdir(), 'orion-repair-guard-'));
    mkdirSync(join(workspace, 'tests'), { recursive: true });
    writeFileSync(
      join(workspace, 'tests/math.test.ts'),
      'expect(1).toBe(1);\nexpect(2).toBe(2);\nexpect(3).toBe(3);\n'
    );
    return workspace;
  };

  test('deleting a test file is forbidden', async () => {
    const workspace = workspaceBase();
    const before = snapshotTestFiles(workspace, ['tests/math.test.ts']);
    rmSync(join(workspace, 'tests/math.test.ts'));
    const after = snapshotTestFiles(workspace, ['tests/math.test.ts']);
    expect(() => assertNoForbiddenRepair(before, after)).toThrow(ForbiddenRepairError);
    try {
      assertNoForbiddenRepair(before, after);
    } catch (error) {
      expect((error as ForbiddenRepairError).guard).toBe('test_deleted');
    }
    rmSync(workspace, { recursive: true, force: true });
  });

  test('weakening assertions is forbidden', async () => {
    const workspace = workspaceBase();
    const before = snapshotTestFiles(workspace, ['tests/math.test.ts']);
    writeFileSync(join(workspace, 'tests/math.test.ts'), 'expect(1).toBe(1);\n');
    const after = snapshotTestFiles(workspace, ['tests/math.test.ts']);
    expect(() => assertNoForbiddenRepair(before, after)).toThrow(/assertions were weakened/);
    rmSync(workspace, { recursive: true, force: true });
  });

  test('the loop maps a forbidden repair to terminal failed', async () => {
    const workspace = workspaceBase();
    const outcome = await runVerifiedRepairLoop({
      verify: async () => verification(false, JEST_OUTPUT),
      repair: async () => {
        rmSync(join(workspace, 'tests/math.test.ts'));
      },
      guard: previous => {
        const after = snapshotTestFiles(workspace, ['tests/math.test.ts']);
        if (previous) assertNoForbiddenRepair(previous, after);
        return after;
      },
    });
    expect(outcome.terminal).toBe('failed');
    expect(outcome.failureReason).toContain('forbidden repair');
    rmSync(workspace, { recursive: true, force: true });
  });

  test('modifying acceptance criteria is forbidden', () => {
    const before = {
      testFiles: ['tests/x.test.ts'],
      assertionTokens: { 'tests/x.test.ts': 3 },
      acceptanceDigests: { 'acceptance.md': 'abc' },
    };
    const after = {
      testFiles: ['tests/x.test.ts'],
      assertionTokens: { 'tests/x.test.ts': 3 },
      acceptanceDigests: { 'acceptance.md': 'def' },
    };
    expect(() => assertNoForbiddenRepair(before, after)).toThrow(/acceptance criteria/);
  });
});

describe('five-state completion audit (T23-C5)', () => {
  test('maps the five states without collapsing unverified into completed', () => {
    expect(
      completionStateFromVerification({
        cancelled: false,
        verificationRan: true,
        verificationOk: true,
        agentClaimedSuccess: true,
      })
    ).toBe('completed');
    expect(
      completionStateFromVerification({
        cancelled: false,
        verificationRan: true,
        verificationOk: false,
        agentClaimedSuccess: true,
      })
    ).toBe('failed');
    expect(
      completionStateFromVerification({
        cancelled: false,
        verificationRan: false,
        verificationOk: false,
        agentClaimedSuccess: true, // a claim alone must NOT produce completed
      })
    ).toBe('unverified');
    expect(
      completionStateFromVerification({
        cancelled: true,
        verificationRan: false,
        verificationOk: false,
        agentClaimedSuccess: false,
      })
    ).toBe('cancelled');
    expect(
      completionStateFromVerification({
        cancelled: false,
        blockedReason: 'no progress',
        verificationRan: false,
        verificationOk: false,
        agentClaimedSuccess: false,
      })
    ).toBe('blocked');
  });
});
