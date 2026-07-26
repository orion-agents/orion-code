import { resolveWebSearchMcpConfig } from '../src/services/web-search-provider';
import type { OpenHorseCLIConfig } from '../src/services/config';

const originalEnv = { ...process.env };

function baseConfig(overrides: Partial<OpenHorseCLIConfig> = {}): OpenHorseCLIConfig {
  return {
    apiKey: 'sk-configured',
    model: 'gpt-4o',
    toolConfirmation: 'allow',
    name: 'test',
    mode: 'development',
    logLevel: 'info',
    ...overrides,
  };
}

function cleanEnv() {
  delete process.env.ORION_CODE_WEBSEARCH_API_KEY;
  delete process.env.ORION_CODE_WEBSEARCH_PROVIDER;
  delete process.env.ORION_CODE_WEBSEARCH_MCP_PROVIDER;
  delete process.env.ORION_CODE_WEBSEARCH_MCP_ENDPOINT;
  delete process.env.ORION_CODE_WEBSEARCH_MCP_TOOL;
  delete process.env.ORION_CODE_WEBSEARCH_AUTH_TYPE;
  delete process.env.ORION_CODE_WEBSEARCH_API_KEY_HEADER;
  delete process.env.ORION_CODE_WEBSEARCH_API_KEY_QUERY_PARAM;
  delete process.env.DASHSCOPE_API_KEY;
  delete process.env.GLM_API_KEY;
  delete process.env.ZHIPU_API_KEY;
  delete process.env.BIGMODEL_API_KEY;
  delete process.env.TAVILY_API_KEY;
}

beforeEach(() => {
  cleanEnv();
});

afterAll(() => {
  process.env = originalEnv;
});

describe('resolveWebSearchMcpConfig', () => {
  test('infers Bailian from coding.dashscope and reuses configured apiKey', () => {
    const resolved = resolveWebSearchMcpConfig(baseConfig({
      apiBaseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
      apiKey: 'sk-sp-coding-plan',
      model: 'glm-5',
    }));

    expect(resolved.provider).toBe('bailian');
    expect(resolved.endpoint).toBe('https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp');
    expect(resolved.apiKey).toBe('sk-sp-coding-plan');
  });

  test('uses DashScope web search key before configured model key', () => {
    process.env.DASHSCOPE_API_KEY = 'sk-dashscope-web';

    const resolved = resolveWebSearchMcpConfig(baseConfig({
      apiBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk-model-key',
    }));

    expect(resolved.provider).toBe('bailian');
    expect(resolved.apiKey).toBe('sk-dashscope-web');
  });

  test('infers Zhipu WebSearch Prime from bigmodel endpoint', () => {
    process.env.GLM_API_KEY = 'glm-web-key';

    const resolved = resolveWebSearchMcpConfig(baseConfig({
      apiBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4.5',
    }));

    expect(resolved.provider).toBe('zhipu');
    expect(resolved.endpoint).toBe('https://open.bigmodel.cn/api/mcp/web_search_prime/mcp');
    expect(resolved.toolName).toBe('webSearchPrime');
    expect(resolved.apiKey).toBe('glm-web-key');
  });

  test('explicit MCP provider and endpoint override inferred profile', () => {
    const resolved = resolveWebSearchMcpConfig(baseConfig({
      apiBaseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
      webSearch: {
        provider: 'tavily-mcp',
        endpoint: 'https://search.example.test/mcp',
        authType: 'query',
        apiKeyQueryParam: 'key',
      },
    }));

    expect(resolved.provider).toBe('tavily-mcp');
    expect(resolved.endpoint).toBe('https://search.example.test/mcp');
    expect(resolved.authType).toBe('query');
    expect(resolved.apiKeyQueryParam).toBe('key');
    expect(resolved.apiKey).toBe('sk-configured');
  });
});
