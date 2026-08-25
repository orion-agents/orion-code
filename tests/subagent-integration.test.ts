import {
  createSubagentBundleForTurn,
  createSubagentToolForTurn,
  deriveRootLlmConfig,
} from '../src/runtime/subagents/runtime-integration';
import { DEFAULT_SUBAGENT_CONFIG } from '../src/runtime/subagents/types';
import type { OrionCodeCLIConfig } from '../src/services/config';
import { buildRegistry } from '../src/services/model-registry';
import { createAuthoritySnapshotV1 } from '../src/runtime/step-snapshot';
import type { ProductionSubagentExecutionPortV1 } from '../src/runtime/subagents/runtime-contract';
import type { ParentThreadForkRequestV1 } from '../src/runtime/subagent-thread-runtime';

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

    it('fails closed while the product has not injected the modern child runtime', () => {
      const tool = createSubagentToolForTurn({
        config: { ...DEFAULT_SUBAGENT_CONFIG, mode: 'auto' },
        cwd: '/tmp/project',
        rootLlmConfig: { apiKey: 'k', model: 'm' },
        modelLabel: 'gpt-4o',
      });
      expect(tool).toBeNull();
    });

    it('returns a tool whose execute rejects invalid requests without calling the LLM', async () => {
      const modern = modernInputs();
      const tool = createSubagentToolForTurn({
        config: { ...DEFAULT_SUBAGENT_CONFIG, mode: 'auto' },
        cwd: '/tmp/project',
        rootLlmConfig: { apiKey: 'k', model: 'm' },
        ...modern,
      });
      const result = await tool!.execute({ tasks: 'nope' }, { cwd: '/tmp', config: {} as never });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid subtask request/);
      expect(modern.productionRuntime.execute).not.toHaveBeenCalled();
    });

    it('closes the per-turn production runtime exactly once when the turn settles', async () => {
      const modern = modernInputs();
      const closeSource = jest.fn();
      const bundle = createSubagentBundleForTurn({
        config: { ...DEFAULT_SUBAGENT_CONFIG, mode: 'auto' },
        cwd: '/tmp/project',
        rootLlmConfig: { apiKey: 'k', model: 'm' },
        ...modern,
        parentFork: undefined,
        parentForkSource: {
          serviceId: 'turn-parent-step-source',
          current: () => modern.parentFork,
          close: closeSource,
        },
      });

      await bundle!.close('turn_settled');
      await bundle!.close('duplicate_settle');

      expect(modern.productionRuntime.close).toHaveBeenCalledTimes(1);
      expect(modern.productionRuntime.close).toHaveBeenCalledWith('turn_settled');
      expect(closeSource).toHaveBeenCalledTimes(1);
      expect(closeSource).toHaveBeenCalledWith('turn_settled');
    });
  });
});

function modernInputs(): {
  productionRuntime: ProductionSubagentExecutionPortV1 & {
    execute: jest.Mock;
    close: jest.Mock;
  };
  parentFork: ParentThreadForkRequestV1;
  parentAuthority: ReturnType<typeof createAuthoritySnapshotV1>;
} {
  return {
    productionRuntime: {
      serviceId: 'test-production-subagents',
      execute: jest.fn(),
      close: jest.fn(),
    },
    parentFork: {
      store: {} as ParentThreadForkRequestV1['store'],
      threadId: '00000000-0000-4000-8000-000000000000',
      turnId: '00000000-0000-4000-8000-000000000001',
      stepId: '00000000-0000-4000-8000-000000000002',
      requestId: '00000000-0000-4000-8000-000000000003',
      stepSnapshotDigest: 'step-snapshot-digest',
      capabilityReceiptDigest: 'capability-receipt-digest',
      flush: () => undefined,
    },
    parentAuthority: createAuthoritySnapshotV1({
      authorityId: 'test-parent',
      projectRoot: '/tmp/project',
      confirmation: 'allow',
      filesystem: 'workspace',
      network: 'deny',
    }),
  };
}
