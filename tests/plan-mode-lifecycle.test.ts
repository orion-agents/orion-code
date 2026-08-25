import { findCommand } from '../src/commands';
import type { CommandContext } from '../src/commands/types';
import { AgentModeLifecycleController } from '../src/framework/agent-mode';
import { buildSystemPrompt } from '../src/framework/prompt';
import { Store } from '../src/framework/store';
import { loadConfig } from '../src/services/config';
import { TOOLS } from './support/legacy-tools';

describe('/plan durable lifecycle contract', () => {
  function context(): CommandContext {
    const config = loadConfig({ apiKey: 'test-key', model: 'test-model' });
    const store = new Store({ config, tools: TOOLS, currentModel: config.model });
    return {
      cwd: process.cwd(),
      config,
      store,
      llm: null,
      agentModeLifecycle: new AgentModeLifecycleController(store),
    };
  }

  it('uses /plan as the user entry and preserves the pre-PLAN execution mode', async () => {
    const ctx = context();
    ctx.agentModeLifecycle!.setMode('auto');
    const result = await findCommand('plan')!.execute(ctx, 'refactor the parser safely');

    expect(result).toMatchObject({
      success: true,
      continueAsChat: true,
      chatInput: 'refactor the parser safely',
    });
    expect(ctx.store.getSnapshot()).toMatchObject({
      agentMode: 'plan',
      planMode: true,
      planReturnMode: 'auto',
      currentPlan: null,
    });
    expect(ctx.store.getEffectivePermissionMode()).toBe('default');
  });

  it('does not expose model-facing enter/exit mode tools', () => {
    const names = TOOLS.map(tool => tool.name);
    expect(names).not.toContain('enter_plan_mode');
    expect(names).not.toContain('exit_plan_mode');
  });

  it('instructs PLAN to use the shared tools and finish through a durable receipt', () => {
    const planning = buildSystemPrompt({
      cwd: process.cwd(),
      platform: process.platform,
      nodeVersion: process.version,
      tools: TOOLS,
      agentMode: 'plan',
      planMode: true,
    }).dynamic;

    expect(planning).toContain('[Plan-to-Execution Mode]');
    expect(planning).toContain('same tool registry as BUILD');
    expect(planning).toContain('Never reject a tool solely because PLAN is active');
    expect(planning).toContain('typed PlanReceipt');
    expect(planning).toContain('separate logical request');
    expect(planning).toContain('Do not call an exit or mode-transition tool');
    expect(planning).not.toContain('exit_plan_mode');
    expect(planning).not.toContain('Do not edit files');
  });
});
