import { createContextHarness } from '../src/harness/context-harness';
import { checkToolDrift } from '../src/harness/drift-guard';
import type { CapabilityProfile, TaskContract } from '../src/harness/types';

function contract(overrides: Partial<TaskContract['allowedScope']> = {}): TaskContract {
  return {
    version: 3,
    id: 'contract-1',
    objective: 'Inspect the project safely',
    userIntent: 'Inspect the project safely',
    requirements: [],
    successCriteria: [],
    constraints: [],
    prohibitions: [],
    allowedScope: { cwd: '/repo', ...overrides },
    createdAt: 1,
    updatedAt: 1,
  };
}

function profile(tools: string[] = ['read_file']): CapabilityProfile {
  return {
    schemaVersion: 1,
    revision: 3,
    fingerprint: 'capability-ref',
    createdAt: 1,
    projectRoot: '/repo',
    model: {
      id: 'test-model',
      contextWindow: 100_000,
      toolCalling: tools.length > 0,
      streaming: true,
    },
    permission: {
      mode: 'default',
      confirmation: 'ask',
      scope: 'project',
      source: 'runtime_policy',
      hardDenyEnforced: true,
    },
    tools,
    features: { network: false, mcp: false, subagents: false, skills: false },
  };
}

describe('typed capability drift guard', () => {
  test('warns by default without blocking a tool that is absent from the capability profile', () => {
    const harness = createContextHarness({
      cwd: '/repo',
      modelId: 'test-model',
      state: { contract: contract(), ledger: [], capabilityProfile: profile(), updatedAt: 1 },
    });

    expect(
      harness.beforeToolUse({ name: 'write_file', args: { path: 'src/new.ts' } })
    ).toMatchObject({
      status: 'warn',
      reason: expect.stringContaining('absent from capability profile v3'),
    });
  });

  test('blocks capability mismatches and boundary-safe path escapes in block mode', () => {
    expect(
      checkToolDrift({
        contract: contract(),
        capabilityProfile: profile(),
        toolName: 'write_file',
        args: { path: 'src/new.ts' },
        mode: 'block',
      })
    ).toMatchObject({ status: 'block', reason: expect.stringContaining('capability profile') });

    for (const path of ['../secret', '/repo-other/secret']) {
      expect(
        checkToolDrift({
          contract: contract(),
          capabilityProfile: profile(),
          toolName: 'read_file',
          args: { path },
          mode: 'block',
        })
      ).toMatchObject({ status: 'block', reason: expect.stringContaining('outside') });
    }
  });

  test('enforces explicit file and command scopes using typed arguments', () => {
    const scoped = contract({ files: ['src'], commands: ['npm test -- --runInBand'] });
    expect(
      checkToolDrift({
        contract: scoped,
        capabilityProfile: profile(['read_file', 'exec_command']),
        toolName: 'read_file',
        args: { path: 'src/index.ts' },
        mode: 'block',
      })
    ).toEqual({ status: 'ok' });
    expect(
      checkToolDrift({
        contract: scoped,
        capabilityProfile: profile(['read_file', 'exec_command']),
        toolName: 'read_file',
        args: { path: 'tests/index.test.ts' },
        mode: 'block',
      })
    ).toMatchObject({ status: 'block', reason: expect.stringContaining('allowedScope.files') });
    expect(
      checkToolDrift({
        contract: scoped,
        capabilityProfile: profile(['read_file', 'exec_command']),
        toolName: 'exec_command',
        args: { command: 'npm test -- --runInBand && rm -rf tmp' },
        mode: 'block',
      })
    ).toMatchObject({ status: 'block', reason: expect.stringContaining('allowedScope.commands') });

    expect(
      checkToolDrift({
        contract: contract({ files: [], commands: [] }),
        capabilityProfile: profile(['read_file', 'exec_command']),
        toolName: 'read_file',
        args: { path: 'src/index.ts' },
        mode: 'block',
      })
    ).toMatchObject({ status: 'block', reason: expect.stringContaining('allowedScope.files') });
  });

  test('uses an in-scope typed workdir as the base for relative file paths', () => {
    expect(
      checkToolDrift({
        contract: contract({ files: ['packages/app'] }),
        capabilityProfile: profile(),
        toolName: 'read_file',
        args: { workdir: 'packages/app', path: 'src/index.ts' },
        mode: 'block',
      })
    ).toEqual({ status: 'ok' });

    expect(
      checkToolDrift({
        contract: contract({ files: ['packages/app'] }),
        capabilityProfile: profile(),
        toolName: 'read_file',
        args: {
          tasks: [
            { workdir: 'packages/app', path: 'src/index.ts' },
            { workdir: 'packages/other', path: 'src/index.ts' },
          ],
        },
        mode: 'block',
      })
    ).toMatchObject({ status: 'block', reason: expect.stringContaining('allowedScope.files') });
  });

  test('fails closed in block mode when typed arguments cannot be validated', () => {
    expect(
      checkToolDrift({
        contract: contract(),
        toolName: 'read_file',
        args: { path: 'src/index.ts' },
        mode: 'block',
      })
    ).toMatchObject({ status: 'block', reason: expect.stringContaining('unavailable') });

    expect(
      checkToolDrift({
        contract: contract(),
        capabilityProfile: profile(),
        toolName: 'read_file',
        args: { path: { unexpected: true } },
        mode: 'block',
      })
    ).toMatchObject({ status: 'block', reason: expect.stringContaining('malformed') });

    const cyclic: Record<string, unknown> = { path: 'src/index.ts' };
    cyclic.self = cyclic;
    expect(
      checkToolDrift({
        contract: { ...contract(), prohibitions: ['secret'] },
        capabilityProfile: profile(),
        toolName: 'read_file',
        args: cyclic,
        mode: 'block',
      })
    ).toMatchObject({ status: 'block', reason: expect.stringContaining('could not validate') });
  });

});
