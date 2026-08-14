import { findCommand } from '../src/commands';
import type { CommandContext } from '../src/commands/types';
import { buildSystemPrompt } from '../src/framework/prompt';
import { Store } from '../src/framework/store';
import { getToolState, resetToolState } from '../src/framework/tool-state';
import { resolveEffectivePermission } from '../src/framework/tool-scheduler';
import { loadConfig } from '../src/services/config';
import { TOOLS } from '../src/tools';

describe('/plan lifecycle', () => {
  beforeEach(() => resetToolState());
  afterEach(() => resetToolState());

  function context(): CommandContext {
    const config = loadConfig({ apiKey: 'test-key', model: 'test-model' });
    const store = new Store({ config, tools: TOOLS, currentModel: config.model });
    return {
      cwd: process.cwd(),
      config,
      store,
      llm: null,
      runtime: {} as never,
    };
  }

  it('uses /plan as the user entry and immediately plans an optional task', async () => {
    const ctx = context();
    const result = await findCommand('plan')!.execute(ctx, 'refactor the parser safely');

    expect(result).toMatchObject({
      success: true,
      continueAsChat: true,
      chatInput: 'refactor the parser safely',
    });
    expect(ctx.store.getSnapshot()).toMatchObject({
      agentMode: 'plan',
      planMode: true,
      currentPlan: null,
    });
    expect(getToolState()).toMatchObject({
      planMode: true,
      currentPlan: null,
      planReturnMode: 'interactive',
    });
    expect(ctx.store.getEffectivePermissionMode()).toBe('default');
  });

  it('allows exit_plan_mode without a prompt and restores the previous mode', async () => {
    const ctx = context();
    ctx.store.setAgentMode('auto');
    await findCommand('plan')!.execute(ctx, 'plan an upgrade');
    const exitPlan = TOOLS.find(tool => tool.name === 'exit_plan_mode')!;

    expect(
      resolveEffectivePermission({
        toolName: exitPlan.name,
        tool: exitPlan,
        args: { plan: 'Upgrade plan' },
        permission: exitPlan.checkPermissions?.(
          {},
          {
            cwd: ctx.cwd,
            config: { name: 'test', mode: 'test' },
          }
        ),
        permissionMode: 'plan',
      })
    ).toMatchObject({ outcome: 'allow', risk: 'read_only' });

    const result = await exitPlan.execute(
      { plan: 'Upgrade plan' },
      {
        cwd: ctx.cwd,
        config: { name: 'test', mode: 'test' },
        onPlanModeChange: transition => {
          ctx.store.setState({
            agentMode: transition.active ? 'plan' : transition.returnMode,
            planMode: transition.active,
            currentPlan: transition.currentPlan,
          });
        },
      }
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('execution will start in AUTO');
    expect(result.output).not.toContain('execution will start in interactive');
    expect(ctx.store.getSnapshot()).toMatchObject({
      agentMode: 'auto',
      planMode: false,
      currentPlan: 'Upgrade plan',
    });
    expect(getToolState().planMode).toBe(false);
  });

  it('injects the automatic, non-executing completion contract only in plan mode', () => {
    const normal = buildSystemPrompt({
      cwd: process.cwd(),
      platform: process.platform,
      nodeVersion: process.version,
      tools: TOOLS,
    }).dynamic;
    const planning = buildSystemPrompt({
      cwd: process.cwd(),
      platform: process.platform,
      nodeVersion: process.version,
      tools: TOOLS,
      planMode: true,
    }).dynamic;

    expect(normal).not.toContain('[Plan Mode]');
    expect(planning).toContain('[Plan Mode]');
    expect(planning).toContain('call exit_plan_mode exactly once');
    expect(planning).toContain('exits plan mode automatically');
    expect(planning).toContain('current permission policy and durable grants');
    expect(planning).not.toContain('Explore and reason read-only');
    expect(planning).not.toContain('Do not edit files');
  });

  it('injects distinct Build, Plan-to-execution, and Auto behavior contracts', () => {
    const render = (agentMode: 'interactive' | 'plan' | 'auto') =>
      buildSystemPrompt({
        cwd: process.cwd(),
        platform: process.platform,
        nodeVersion: process.version,
        tools: TOOLS,
        agentMode,
        planMode: agentMode === 'plan',
      }).dynamic;

    expect(render('interactive')).toContain('[Build Mode]');
    expect(render('plan')).toContain('[Plan-to-Execution Mode]');
    expect(render('plan')).toContain('same tool registry as BUILD');
    expect(render('plan')).toContain('Never reject a tool solely because PLAN is active');
    expect(render('plan')).toContain('separate execution request');
    expect(render('auto')).toContain('[Auto Mode]');
    expect(render('auto')).toContain('Do not ask permission questions or clarifying questions');
    expect(render('auto')).toContain('hard safety policy');
  });
});
