import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findCommand } from '../src/commands';
import { Store } from '../src/framework/store';
import { loadConfig } from '../src/services/config';
import type { CommandContext } from '../src/commands/types';

describe('/mode and /permissions state axes', () => {
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

  it('keeps agent plan mode independent from edit confirmation policy', async () => {
    const ctx = context();
    await findCommand('permissions')!.execute(ctx, 'allow-edits');
    await findCommand('mode')!.execute(ctx, 'plan');

    expect(ctx.store.getSnapshot()).toMatchObject({
      agentMode: 'plan',
      permissionMode: 'acceptEdits',
    });
    expect(ctx.store.getEffectivePermissionMode()).toBe('plan');

    await findCommand('mode')!.execute(ctx, 'interactive');
    expect(ctx.store.getSnapshot().permissionMode).toBe('acceptEdits');
    expect(ctx.store.getEffectivePermissionMode()).toBe('acceptEdits');
  });

  it('maps legacy accept-edits without mutating the agent axis', async () => {
    const ctx = context();
    const result = await findCommand('mode')!.execute(ctx, 'accept-edits');
    expect(result).toMatchObject({ success: true });
    expect(ctx.store.getSnapshot()).toMatchObject({
      agentMode: 'interactive',
      permissionMode: 'acceptEdits',
    });
  });
});
