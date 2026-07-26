import { createSubagentToolForTurn, deriveRootLlmConfig } from '../src/runtime/subagents/runtime-integration';
import { DEFAULT_SUBAGENT_CONFIG } from '../src/runtime/subagents/types';
import type { OpenHorseCLIConfig } from '../src/services/config';

function cliConfig(overrides: Partial<OpenHorseCLIConfig> = {}): OpenHorseCLIConfig {
  return {
    apiKey: 'test-key',
    model: 'gpt-4o',
    fallbackModel: 'gpt-4o-mini',
    toolConfirmation: 'allow',
    name: 'orion-code',
    mode: 'development',
    logLevel: 'info',
    subagents: { ...DEFAULT_SUBAGENT_CONFIG },
    ...overrides,
  } as OpenHorseCLIConfig;
}

describe('subagent runtime integration', () => {
  describe('deriveRootLlmConfig', () => {
    it('extracts the LLM config slice from the runtime config', () => {
      const cfg = deriveRootLlmConfig(cliConfig({ apiBaseUrl: 'http://x', apiKey: 'k', model: 'm', fallbackModel: 'f' }));
      expect(cfg).toEqual({ apiKey: 'k', baseUrl: 'http://x', model: 'm', fallbackModel: 'f' });
    });
  });

  describe('createSubagentToolForTurn', () => {
    it('returns null when mode is off', () => {
      const tool = createSubagentToolForTurn({
        config: { ...DEFAULT_SUBAGENT_CONFIG, mode: 'off' },
        cwd: '/tmp/project',
        rootLlmConfig: { apiKey: 'k', model: 'm' },
      });
      expect(tool).toBeNull();
    });

    it('returns null when there is no api key', () => {
      const tool = createSubagentToolForTurn({
        config: { ...DEFAULT_SUBAGENT_CONFIG, mode: 'auto' },
        cwd: '/tmp/project',
        rootLlmConfig: { apiKey: '', model: 'm' },
      });
      expect(tool).toBeNull();
    });

    it('returns a subtask tool named subtask when enabled', () => {
      const tool = createSubagentToolForTurn({
        config: { ...DEFAULT_SUBAGENT_CONFIG, mode: 'auto' },
        cwd: '/tmp/project',
        rootLlmConfig: { apiKey: 'k', model: 'm' },
        modelLabel: 'gpt-4o',
      });
      expect(tool).not.toBeNull();
      expect(tool!.name).toBe('subtask');
      expect(tool!.isReadOnly?.({})).toBe(true);
    });

    it('returns a tool whose execute rejects invalid requests without calling the LLM', async () => {
      const tool = createSubagentToolForTurn({
        config: { ...DEFAULT_SUBAGENT_CONFIG, mode: 'auto' },
        cwd: '/tmp/project',
        rootLlmConfig: { apiKey: 'k', model: 'm' },
      });
      const result = await tool!.execute({ tasks: 'nope' }, { cwd: '/tmp', config: {} as never });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid subtask request/);
    });
  });
});
