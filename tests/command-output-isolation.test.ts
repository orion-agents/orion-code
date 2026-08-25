import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { findCommand } from '../src/commands';
import type { CommandContext } from '../src/commands/types';
import { Store } from '../src/framework/store';
import { loadConfig } from '../src/services/config';

describe('primary command output isolation', () => {
  it('returns structured output without writing to global stdout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-command-output-'));
    const previousConfigRoot = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = join(root, 'config');
    const config = loadConfig({ apiKey: 'test', model: 'test-model' });
    const store = new Store({ config, tools: [], currentModel: 'test-model' });
    const runtime = {
      brain: {
        getStatus: () => ({ agents: [], pendingTasks: 0, strategy: 'sequential' }),
      },
      memory: {
        getStatus: () => ({ working: 0, 'short-term': 0, 'long-term': 0 }),
      },
      store: {
        getStats: () => ({ working: 0, 'short-term': 0, 'long-term': 0 }),
      },
      harness: {
        getConfig: () => ({
          maxSteps: 20,
          boundaryCheck: true,
          goalConstraint: true,
          resultValidation: true,
          sandbox: false,
          timeout: 30_000,
          blockedActions: [],
        }),
      },
    };
    const ctx: CommandContext = {
      cwd: root,
      config,
      store,
      llm: null,
      uiRenderer: 'print',
      uiCapabilities: { structuredPickers: false },
      getSession: () => null,
    };
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const invocations: Array<[string, string]> = [
        ['help', ''],
        ['status', ''],
        ['model', ''],
        ['effort', 'status'],
        ['permissions', 'show'],
        ['diff', ''],
        ['compact', ''],
        ['context', 'show'],
        ['resume', ''],
      ];
      const results = await Promise.all(
        invocations.map(([name, args]) => findCommand(name)!.execute(ctx, args))
      );

      expect(log).not.toHaveBeenCalled();
      expect(results.every(result => result.output || result.error || result.sessionPicker)).toBe(
        true
      );
    } finally {
      log.mockRestore();
      if (previousConfigRoot === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
      else process.env.ORION_CODE_CONFIG_DIR = previousConfigRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
