import type { ToolContext } from '../src/framework/tool';
import { resolveEffectivePermission } from '../src/framework/tool-scheduler';
import { createSubtaskTool, type SubagentSupervisorDeps } from '../src/runtime/subagents';

const context = {
  cwd: '/tmp/orion-mode-permission-test',
  config: { name: 'test', mode: 'default' },
} satisfies ToolContext;

const webResearchArgs = {
  tasks: [
    {
      role: 'research',
      objective: 'Find current primary sources.',
      reason: 'The answer depends on external evidence.',
      research: { mode: 'web' },
    },
  ],
};

describe('agent mode network permission contract', () => {
  const subtask = createSubtaskTool({} as SubagentSupervisorDeps);
  const policy = subtask.checkPermissions?.(webResearchArgs, context);

  it('AUTO authorizes an external research subtask without a prompt', () => {
    expect(policy).toMatchObject({ behavior: 'ask' });
    expect(
      resolveEffectivePermission({
        toolName: 'subtask',
        tool: subtask,
        args: webResearchArgs,
        permission: policy,
        permissionMode: 'auto',
      })
    ).toMatchObject({ outcome: 'allow', source: 'mode_auto', risk: 'external' });
  });

  it('BUILD asks for the same external research capability by default', () => {
    expect(
      resolveEffectivePermission({
        toolName: 'subtask',
        tool: subtask,
        args: webResearchArgs,
        permission: policy,
        permissionMode: 'default',
      })
    ).toMatchObject({ outcome: 'confirm', source: 'risk_guard', risk: 'external' });
  });

  it('an explicit deny remains stronger than AUTO', () => {
    expect(
      resolveEffectivePermission({
        toolName: 'subtask',
        tool: subtask,
        args: webResearchArgs,
        permission: policy,
        permissionMode: 'auto',
        allowlist: {
          effect: 'deny',
          rule: 'deny:subtask',
          scope: 'project',
        },
      })
    ).toMatchObject({ outcome: 'deny', source: 'allowlist_deny' });
  });
});
