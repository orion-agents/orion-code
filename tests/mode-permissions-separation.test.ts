import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findCommand } from '../src/commands';
import { Store } from '../src/framework/store';
import { AgentModeLifecycleController } from '../src/framework/agent-mode';
import { loadConfig } from '../src/services/config';
import type { CommandContext } from '../src/commands/types';

describe('Agent mode and /permissions state axes', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-mode-axis-'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function context(): CommandContext {
    const config = loadConfig({ apiKey: 'test-key', model: 'gpt-4o' });
    const store = new Store({ config, tools: [], currentModel: config.model });
    return {
      cwd: root,
      config,
      store,
      llm: null,
      runtime: {} as never,
    };
  }

  it('starts plan mode through /plan while keeping edit confirmation independent', async () => {
    const ctx = context();
    await findCommand('permissions')!.execute(ctx, 'allow-edits');
    await findCommand('plan')!.execute(ctx, '');

    expect(ctx.store.getSnapshot()).toMatchObject({
      agentMode: 'plan',
      permissionMode: 'acceptEdits',
    });
    expect(ctx.store.getEffectivePermissionMode()).toBe('plan');

    new AgentModeLifecycleController(ctx.store).setMode('interactive');
    expect(ctx.store.getSnapshot().permissionMode).toBe('acceptEdits');
    expect(ctx.store.getEffectivePermissionMode()).toBe('acceptEdits');
  });

  it('does not retain /mode or its /perm compatibility alias', () => {
    expect(findCommand('mode')).toBeUndefined();
    expect(findCommand('perm')).toBeUndefined();
  });
});
