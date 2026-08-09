import {
  createSubagentToolForTurn,
  deriveRootLlmConfig,
} from '../src/runtime/subagents/runtime-integration';
import { DEFAULT_SUBAGENT_CONFIG } from '../src/runtime/subagents/types';
import type { OrionCodeCLIConfig } from '../src/services/config';
import { buildRegistry } from '../src/services/model-registry';

function cliConfig(overrides: Partial<OrionCodeCLIConfig> = {}): OrionCodeCLIConfig {
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
  } as OrionCodeCLIConfig;
}

describe('subagent runtime integration', () => {
  describe('deriveRootLlmConfig', () => {
    it('extracts the LLM config slice from the runtime config', () => {
      const cfg = deriveRootLlmConfig(
        cliConfig({ apiBaseUrl: 'http://x', apiKey: 'k', model: 'm', fallbackModel: 'f' })
      );
      expect(cfg).toEqual({ apiKey: 'k', baseUrl: 'http://x', model: 'm', fallbackModel: 'f' });
    });

    it('resolves the current provider/profile config and expands its env key', () => {
      process.env.ORION_SUBAGENT_TEST_KEY = 'registry-key';
      try {
        const built = buildRegistry({
          providers: [
            {
              id: 'current-provider',
              baseUrl: 'https://provider.example/v1',
              apiKey: '$ORION_SUBAGENT_TEST_KEY',
              protocol: 'openai-completions',
            },
          ],
          models: [
            { id: 'primary-profile', provider: 'current-provider', model: 'actual-primary' },
            { id: 'fallback-profile', provider: 'current-provider', model: 'actual-fallback' },
          ],
          defaultModel: 'primary-profile',
          fallbackModel: 'fallback-profile',
        });
        expect(built.valid).toBe(true);
        const cfg = deriveRootLlmConfig(
          cliConfig({ apiKey: '', apiBaseUrl: undefined, modelRegistry: built.registry! })
        );
        expect(cfg).toEqual({
          apiKey: 'registry-key',
          baseUrl: 'https://provider.example/v1',
          model: 'actual-primary',
          fallbackModel: 'actual-fallback',
        });
      } finally {
        delete process.env.ORION_SUBAGENT_TEST_KEY;
      }
    });

    it('does not send a cross-provider fallback model to the default provider', () => {
      const built = buildRegistry({
        providers: [
          {
            id: 'primary',
            baseUrl: 'https://primary.example/v1',
            apiKey: 'primary-key',
            protocol: 'openai-completions',
          },
          {
            id: 'fallback',
            baseUrl: 'https://fallback.example/v1',
            apiKey: 'fallback-key',
            protocol: 'openai-completions',
          },
        ],
        models: [
          { id: 'primary-profile', provider: 'primary', model: 'primary-model' },
          { id: 'fallback-profile', provider: 'fallback', model: 'fallback-model' },
        ],
        defaultModel: 'primary-profile',
        fallbackModel: 'fallback-profile',
      });
      const cfg = deriveRootLlmConfig(cliConfig({ modelRegistry: built.registry! }));
      expect(cfg.fallbackModel).toBeUndefined();
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
