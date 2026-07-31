import {
  loadConfig,
  isConfigured,
  getConfigErrors,
  getConfigSummary,
  isBetaUIRenderer,
  isRecommendedBetaUIRenderer,
  isDeprecatedUIRenderer,
  isInteractiveUIRenderer,
  isSupportedUIRenderer,
  resolveUIRenderer,
  DEFAULT_UI_RENDERER,
  SUPPORTED_UI_RENDERERS,
} from '../src/services/config';
import { delimiter } from 'path';

const originalEnv = { ...process.env };

function cleanEnv() {
  delete process.env.ORION_CODE_API_KEY;
  delete process.env.ORION_CODE_API_BASE_URL;
  delete process.env.ORION_CODE_BASE_URL;
  delete process.env.ORION_CODE_MODEL;
  delete process.env.ORION_CODE_FALLBACK_MODEL;
  delete process.env.ORION_CODE_NAME;
  delete process.env.ORION_CODE_MODE;
  delete process.env.ORION_CODE_LOG_LEVEL;
  delete process.env.ORION_CODE_TOOL_CONFIRMATION;
  delete process.env.ORION_CODE_UI;
  delete process.env.ORION_CODE_UI_RENDERER;
  delete process.env.ORION_CODE_UI_CONFIRMATIONS;
  delete process.env.ORION_CODE_WEBSEARCH_API_KEY;
  delete process.env.ORION_CODE_WEBSEARCH_PROVIDER;
  delete process.env.ORION_CODE_WEBSEARCH_MCP_PROVIDER;
  delete process.env.ORION_CODE_WEBSEARCH_MCP_ENDPOINT;
  delete process.env.ORION_CODE_WEBSEARCH_MCP_TOOL;
  delete process.env.ORION_CODE_WEBSEARCH_MCP_TIMEOUT_MS;
  delete process.env.ORION_CODE_WEBSEARCH_AUTH_TYPE;
  delete process.env.ORION_CODE_WEBSEARCH_API_KEY_HEADER;
  delete process.env.ORION_CODE_WEBSEARCH_API_KEY_QUERY_PARAM;
  delete process.env.ORION_CODE_SKILLS_PATHS;
  delete process.env.ORION_CODE_MAX_LLM_REQUESTS_PER_TURN;
  delete process.env.ORION_CODE_MAX_TOOL_CALLS_PER_TURN;
  delete process.env.ORION_CODE_MAX_READ_ONLY_FRAGMENTATION;
  delete process.env.ORION_CODE_MAX_MODEL_VISIBLE_TOOL_BYTES;
  delete process.env.DASHSCOPE_API_KEY;
}

beforeEach(() => {
  cleanEnv();
  jest.restoreAllMocks();
});

afterAll(() => {
  Object.assign(process.env, originalEnv);
});

describe('loadConfig', () => {
  test('returns defaults when no env or overrides', () => {
    jest.spyOn(require('../src/services/global-config'), 'loadGlobalConfig').mockReturnValue({
      defaultModel: 'gpt-4o',
    });

    const config = loadConfig();
    expect(config.model).toBe('gpt-4o');
    expect(config.name).toBe('orion-code');
    expect(config.mode).toBe('development');
    expect(config.logLevel).toBe('info');
    expect(config.apiKey).toBe('');
    expect(config.toolConfirmation).toBe('allow');
    expect(config.ui).toEqual({ renderer: 'tui', confirmations: 'config' });
  });

  test('overrides take priority', () => {
    const config = loadConfig({
      apiKey: 'test-key',
      model: 'custom-model',
      fallbackModel: 'backup-model',
      name: 'my-instance',
      mode: 'production',
      logLevel: 'debug',
      toolConfirmation: 'deny',
      ui: { renderer: 'ink', confirmations: 'interactive' },
    });
    expect(config.apiKey).toBe('test-key');
    expect(config.model).toBe('custom-model');
    expect(config.fallbackModel).toBe('backup-model');
    expect(config.name).toBe('my-instance');
    expect(config.mode).toBe('production');
    expect(config.logLevel).toBe('debug');
    expect(config.toolConfirmation).toBe('deny');
    expect(config.ui).toEqual({ renderer: 'ink', confirmations: 'interactive' });
  });

  test('loads valid custom model pricing and drops invalid rates', () => {
    jest.spyOn(require('../src/services/global-config'), 'loadGlobalConfig').mockReturnValue({
      defaultModel: 'routed-model',
      cost: {
        modelPricing: {
          'routed-model': { input: 1.5, output: 6, cachedInput: 0.5 },
          invalid: { input: -1, output: 2 },
        },
      },
    });

    const config = loadConfig();

    expect(config.cost?.modelPricing?.['routed-model']).toEqual({
      input: 1.5,
      output: 6,
      cachedInput: 0.5,
    });
    expect(config.cost?.modelPricing?.invalid).toBeUndefined();
  });

  test('env vars are used when no overrides and no globalConfig', () => {
    jest.spyOn(require('../src/services/global-config'), 'loadGlobalConfig').mockReturnValue({
      defaultModel: undefined as any,
    });

    process.env.ORION_CODE_API_KEY = 'env-key';
    process.env.ORION_CODE_MODEL = 'env-model';
    process.env.ORION_CODE_FALLBACK_MODEL = 'env-fallback';
    process.env.ORION_CODE_TOOL_CONFIRMATION = 'ask';
    process.env.ORION_CODE_UI_RENDERER = 'ink';
    process.env.ORION_CODE_UI_CONFIRMATIONS = 'interactive';
    process.env.ORION_CODE_WEBSEARCH_API_KEY = 'sk-websearch-env';
    process.env.ORION_CODE_WEBSEARCH_PROVIDER = 'tavily';
    process.env.ORION_CODE_WEBSEARCH_MCP_ENDPOINT = 'https://example.com/mcp';
    process.env.ORION_CODE_WEBSEARCH_MCP_TOOL = 'search';
    process.env.ORION_CODE_WEBSEARCH_MCP_TIMEOUT_MS = '12345';
    process.env.ORION_CODE_WEBSEARCH_AUTH_TYPE = 'query';
    process.env.ORION_CODE_WEBSEARCH_API_KEY_QUERY_PARAM = 'tavilyApiKey';
    process.env.ORION_CODE_MAX_LLM_REQUESTS_PER_TURN = '72';
    process.env.ORION_CODE_MAX_TOOL_CALLS_PER_TURN = '240';
    process.env.ORION_CODE_MAX_READ_ONLY_FRAGMENTATION = '4';
    process.env.ORION_CODE_MAX_MODEL_VISIBLE_TOOL_BYTES = '131072';

    const config = loadConfig();
    expect(config.apiKey).toBe('env-key');
    expect(config.model).toBe('env-model');
    expect(config.fallbackModel).toBe('env-fallback');
    expect(config.toolConfirmation).toBe('ask');
    expect(config.ui).toEqual({ renderer: 'tui', confirmations: 'interactive' });
    expect(config.webSearch).toEqual({
      apiKey: 'sk-websearch-env',
      provider: 'tavily',
      endpoint: 'https://example.com/mcp',
      toolName: 'search',
      timeoutMs: 12345,
      authType: 'query',
      apiKeyQueryParam: 'tavilyApiKey',
    });
    expect(config.agentLoop).toEqual({
      budget: {
        maxLlmRequestsPerUserTurn: 72,
        maxToolCallsPerUserTurn: 240,
        maxReadOnlyFragmentation: 4,
        maxModelVisibleToolBytes: 131072,
      },
    });
  });

  test('globalConfig is used when no env or overrides', () => {
    jest.spyOn(require('../src/services/global-config'), 'loadGlobalConfig').mockReturnValue({
      apiKey: 'global-key',
      apiBaseUrl: 'https://custom.api.com',
      defaultModel: 'glm-5',
      fallbackModel: 'qwen-plus',
      toolConfirmation: 'deny',
      webSearch: {
        endpoint: 'https://dashscope.example/mcp',
        apiKey: 'sk-websearch-global',
        toolName: 'web_search',
      },
      ui: {
        renderer: 'ink',
        confirmations: 'interactive',
      },
      skills: {
        paths: ['/opt/openhorse/skills'],
      },
      agentLoop: {
        budget: {
          maxLlmRequestsPerUserTurn: 96,
        },
      },
    });

    const config = loadConfig();
    expect(config.apiKey).toBe('global-key');
    expect(config.apiBaseUrl).toBe('https://custom.api.com');
    expect(config.model).toBe('glm-5');
    expect(config.fallbackModel).toBe('qwen-plus');
    expect(config.toolConfirmation).toBe('deny');
    // orion.json no longer controls renderer; TUI is the product default.
    expect(config.ui).toEqual({ renderer: 'tui', confirmations: 'interactive' });
    expect(config.webSearch?.endpoint).toBe('https://dashscope.example/mcp');
    expect(config.webSearch?.apiKey).toBe('sk-websearch-global');
    expect(config.webSearch?.toolName).toBe('web_search');
    expect(config.skills).toEqual({ paths: ['/opt/openhorse/skills'] });
    expect(config.agentLoop).toEqual({
      budget: {
        maxLlmRequestsPerUserTurn: 96,
      },
    });
  });

  test('loads additional skills paths from env and overrides', () => {
    jest.spyOn(require('../src/services/global-config'), 'loadGlobalConfig').mockReturnValue({
      defaultModel: 'gpt-4o',
      skills: {
        paths: ['/global/skills', ''],
      },
    });

    process.env.ORION_CODE_SKILLS_PATHS = ['/env/skills-a', '/env/skills-b'].join(delimiter);

    const config = loadConfig({
      skills: {
        paths: ['/override/skills', '/global/skills'],
      },
    });

    expect(config.skills).toEqual({
      paths: ['/global/skills', '/env/skills-a', '/env/skills-b', '/override/skills'],
    });
  });

  test('cli renderer override can switch to experimental ink beta', () => {
    jest.spyOn(require('../src/services/global-config'), 'loadGlobalConfig').mockReturnValue({
      defaultModel: 'gpt-4o',
      ui: {
        renderer: 'ink',
        confirmations: 'config',
      },
    });

    const config = loadConfig({ ui: { renderer: 'ink' } });
    expect(config.ui).toEqual({ renderer: 'ink', confirmations: 'config' });
  });

  test('cli renderer override can switch to renderer-owned tui preview', () => {
    jest.spyOn(require('../src/services/global-config'), 'loadGlobalConfig').mockReturnValue({
      defaultModel: 'gpt-4o',
    });

    const config = loadConfig({ ui: { renderer: 'tui' } });
    expect(config.ui).toEqual({ renderer: 'tui', confirmations: 'config' });
  });

  test('ignores env renderer so npm run start stays on the default TUI', () => {
    jest.spyOn(require('../src/services/global-config'), 'loadGlobalConfig').mockReturnValue({
      defaultModel: 'gpt-4o',
    });

    process.env.ORION_CODE_UI = 'ink';
    process.env.ORION_CODE_UI_RENDERER = 'ink';

    const config = loadConfig();
    expect(config.ui).toEqual({ renderer: 'tui', confirmations: 'config' });
  });

  test('ignores invalid tool confirmation values', () => {
    jest.spyOn(require('../src/services/global-config'), 'loadGlobalConfig').mockReturnValue({
      defaultModel: 'gpt-4o',
      toolConfirmation: 'invalid',
    });

    process.env.ORION_CODE_TOOL_CONFIRMATION = 'also-invalid';
    process.env.ORION_CODE_UI = 'invalid';
    process.env.ORION_CODE_UI_CONFIRMATIONS = 'also-invalid';

    const config = loadConfig();
    expect(config.toolConfirmation).toBe('allow');
    expect(config.ui).toEqual({ renderer: 'tui', confirmations: 'config' });
  });
});

describe('UI renderer helpers', () => {
  test('defines tui as product, terminal as technical, ink as deprecated', () => {
    expect(DEFAULT_UI_RENDERER).toBe('tui');
    expect(SUPPORTED_UI_RENDERERS).toEqual(['tui', 'terminal', 'ink']);
    expect(resolveUIRenderer('stable')).toBe('terminal');
    expect(resolveUIRenderer('terminal')).toBe('terminal');
    expect(resolveUIRenderer('tui')).toBe('tui');
    expect(resolveUIRenderer('ink')).toBe('ink');
    expect(resolveUIRenderer('legacy')).toBeUndefined();
    expect(resolveUIRenderer('v2')).toBeUndefined();
  });

  test('keeps renderer capability checks centralized', () => {
    expect(isSupportedUIRenderer('terminal')).toBe(true);
    expect(isInteractiveUIRenderer('ink')).toBe(true);
    expect(isBetaUIRenderer('ink')).toBe(true);
    expect(isBetaUIRenderer('tui')).toBe(true);
    expect(isBetaUIRenderer('terminal')).toBe(false);
    expect(isRecommendedBetaUIRenderer('tui')).toBe(true);
    expect(isRecommendedBetaUIRenderer('ink')).toBe(false);
    expect(isDeprecatedUIRenderer('ink')).toBe(true);
    expect(isDeprecatedUIRenderer('tui')).toBe(false);
    expect(isSupportedUIRenderer('print')).toBe(false);
  });
});

describe('isConfigured', () => {
  test('returns false when no API key', () => {
    jest.spyOn(require('../src/services/global-config'), 'loadGlobalConfig').mockReturnValue({
      defaultModel: 'gpt-4o',
    });

    const config = loadConfig();
    expect(isConfigured(config)).toBe(false);
  });

  test('returns true when API key is set', () => {
    const config = loadConfig({ apiKey: 'some-key' });
    expect(isConfigured(config)).toBe(true);
  });
});

describe('getConfigErrors', () => {
  test('returns error when no API key', () => {
    jest.spyOn(require('../src/services/global-config'), 'loadGlobalConfig').mockReturnValue({
      defaultModel: 'gpt-4o',
    });

    const config = loadConfig();
    const errors = getConfigErrors(config);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('ORION_CODE_API_KEY');
  });

  test('returns empty when API key is set', () => {
    const config = loadConfig({ apiKey: 'some-key' });
    const errors = getConfigErrors(config);
    expect(errors.length).toBe(0);
  });
});

describe('getConfigSummary', () => {
  test('returns summary with masked API key', () => {
    const config = loadConfig({
      apiKey: 'sk-test-12345',
      model: 'gpt-4o',
      fallbackModel: 'claude-sonnet-4-6',
    });

    const summary = getConfigSummary(config);
    expect(summary.apiKey).toBe('sk-test***');
    expect(summary.model).toBe('gpt-4o');
    expect(summary.fallback).toBe('claude-sonnet-4-6');
    expect(summary.toolConfirmation).toBe('allow');
    expect(summary.ui).toBe('tui/config');
    expect(summary.webSearch).toBe('(default)');
  });
});
