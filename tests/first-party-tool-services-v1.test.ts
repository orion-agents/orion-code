import { randomUUID } from 'crypto';

import { TOOLS } from './support/legacy-tools';
import { createBuiltinToolCatalogV1 } from '../src/runtime/builtin-tool-provider';
import {
  FirstPartySandboxServiceV1,
  FirstPartyToolApprovalServiceV1,
  FirstPartyToolPolicyServiceV1,
} from '../src/runtime/first-party-tool-services';
import {
  captureStepSnapshotV1,
  createAuthoritySnapshotV1,
  createCapabilityPlanV1,
  createExecutionPolicySnapshotV1,
} from '../src/runtime/step-snapshot';

const context = { cwd: '/repo', config: { name: 'orion', mode: 'test' } };

function snapshot(
  name: string,
  mode: 'build' | 'plan' | 'auto',
  confirmation: 'ask' | 'allow' | 'deny' = 'ask',
  sandboxRequired = false
) {
  const catalog = createBuiltinToolCatalogV1(TOOLS, { context, include: [name] });
  const binding = catalog.entries[0].binding;
  return {
    catalog,
    value: captureStepSnapshotV1({
      threadId: randomUUID(),
      turnId: randomUUID(),
      stepId: randomUUID(),
      taskEpoch: 1,
      baseMode: mode,
      model: {
        providerId: 'test',
        modelId: 'test',
        protocol: 'test',
        contextWindow: 32_000,
      },
      authority: createAuthoritySnapshotV1({
        authorityId: 'project',
        projectRoot: '/repo',
        confirmation,
        filesystem: 'workspace',
        network: 'write',
      }),
      executionPolicy: createExecutionPolicySnapshotV1({
        policyId: 'policy',
        approvalMode: confirmation === 'ask' ? 'interactive' : 'never',
        sandboxRequired,
        sandboxBackend: sandboxRequired ? 'required' : 'none',
        timeoutMs: 5_000,
      }),
      environment: { cwd: '/repo', platform: 'test', arch: 'test', environmentDigest: 'env' },
      capabilityPlan: createCapabilityPlanV1({
        direct: [{ id: name, reason: 'test' }],
      }),
      prompt: { version: 1, sections: [], estimatedTokens: 0, digest: 'prompt' },
      toolBindings: [binding],
      skills: { version: 1, selected: [], catalogDigest: 'none', digest: 'skills' },
      mcp: { version: 1, selected: [], catalogDigest: 'none', digest: 'mcp' },
      taskContextRevision: 0,
    }),
  };
}

describe('first-party ToolGateway services', () => {
  test('keeps permission decisions independent from BUILD/PLAN/AUTO', () => {
    const decisions = (['build', 'plan', 'auto'] as const).map(mode => {
      const { catalog, value } = snapshot('write_file', mode);
      const descriptor = value.toolRouter.descriptors[0];
      return new FirstPartyToolPolicyServiceV1(catalog, context).decide({
        snapshot: value,
        descriptor,
        args: { path: 'a.txt', content: 'hello' },
      });
    });

    expect(decisions.map(item => item.behavior)).toEqual(['ask', 'ask', 'ask']);
    expect(new Set(decisions.map(item => item.digest)).size).toBe(1);
  });

  test('denies an exec cwd outside project authority before approval or execution', () => {
    const { catalog, value } = snapshot('exec_command', 'build', 'allow');
    expect(
      new FirstPartyToolPolicyServiceV1(catalog, context).decide({
        snapshot: value,
        descriptor: value.toolRouter.descriptors[0],
        args: { command: 'pwd', cwd: '../outside' },
      })
    ).toMatchObject({
      behavior: 'deny',
      source: 'authority',
      reason: 'Command cwd is outside project authority.',
    });
  });

  test('uses frozen authority for approval and fails closed without a user channel', async () => {
    const ask = snapshot('write_file', 'build', 'ask').value;
    const allow = snapshot('write_file', 'build', 'allow').value;
    const policy = {
      behavior: 'ask' as const,
      source: 'test',
      reason: 'write',
      digest: 'policy',
    };
    const descriptor = ask.toolRouter.descriptors[0];

    await expect(
      new FirstPartyToolApprovalServiceV1().decide({
        snapshot: ask,
        descriptor,
        args: {},
        policy,
      })
    ).resolves.toMatchObject({ approved: false, source: 'unavailable' });
    await expect(
      new FirstPartyToolApprovalServiceV1().decide({
        snapshot: allow,
        descriptor: allow.toolRouter.descriptors[0],
        args: {},
        policy,
      })
    ).resolves.toMatchObject({ approved: true, source: 'authority' });
  });

  test('reports no containment as none so ExecutionService can fail closed when required', () => {
    const { value } = snapshot('exec_command', 'auto', 'allow', true);
    expect(
      new FirstPartySandboxServiceV1().prepare({
        snapshot: value,
        descriptor: value.toolRouter.descriptors[0],
        args: { command: 'pwd' },
      })
    ).toMatchObject({ enforcement: 'none', backend: 'none' });
  });
});
