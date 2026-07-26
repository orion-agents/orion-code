import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { webSearchTool, resetWebSearchMcpClientForTests } from '../src/tools/web';
import type { ToolContext } from '../src/framework/tool';

const ctx: ToolContext = {
  cwd: process.cwd(),
  config: { name: 'test', mode: 'development' },
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
}

describe('web_search MCP delegation', () => {
  const configDir = join(tmpdir(), `openhorse-web-search-mcp-${Date.now()}`);
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.ORION_CODE_CONFIG_DIR = configDir;
    process.env.ORION_CODE_WEBSEARCH_API_KEY = 'sk-test-websearch';
    process.env.ORION_CODE_WEBSEARCH_MCP_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp';
    delete process.env.ORION_CODE_WEBSEARCH_PROVIDER;
    delete process.env.ORION_CODE_WEBSEARCH_MCP_PROVIDER;
    delete process.env.ORION_CODE_WEBSEARCH_AUTH_TYPE;
    delete process.env.ORION_CODE_WEBSEARCH_API_KEY_HEADER;
    delete process.env.ORION_CODE_WEBSEARCH_API_KEY_QUERY_PARAM;
    delete process.env.DASHSCOPE_API_KEY;
    delete process.env.ORION_CODE_API_KEY;
    delete process.env.ORION_CODE_API_BASE_URL;
    delete process.env.TAVILY_API_KEY;
    delete process.env.BRAVE_API_KEY;
    delete process.env.ORION_CODE_WEBSEARCH_API;
    delete process.env.WEB_SEARCH_API;
    delete process.env.GLM_API_KEY;
    delete process.env.ZHIPU_API_KEY;
    delete process.env.BIGMODEL_API_KEY;
    resetWebSearchMcpClientForTests();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    resetWebSearchMcpClientForTests();
  });

  afterAll(() => {
    process.env = originalEnv;
    if (existsSync(configDir)) {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('calls remote MCP initialize, list tools, and tool call', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(jsonResponse({
        jsonrpc: '2.0',
        id: 'initialize-response',
        result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'WebSearch' } },
      }, { headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' } }))
      .mockResolvedValueOnce(new Response('', { status: 202 }))
      .mockResolvedValueOnce(jsonResponse({
        jsonrpc: '2.0',
        id: 'tools-list-response',
        result: {
          tools: [
            {
              name: 'web_search',
              description: 'Search the web',
              inputSchema: {
                type: 'object',
                properties: {
                  query: { type: 'string' },
                  limit: { type: 'number' },
                },
              },
            },
          ],
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        jsonrpc: '2.0',
        id: 'tools-call-response',
        result: {
          content: [
            { type: 'text', text: 'Search results\nSources:\n- [Orion Code](https://example.com)' },
          ],
        },
      }));
    global.fetch = fetchMock as any;

    const result = await webSearchTool.execute({ query: 'openhorse web search', limit: 3 }, ctx);

    expect(result.success).toBe(true);
    expect(result.output).toContain('Search results');
    expect(result.metadata?.provider).toBe('bailian');
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const initRequest = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(initRequest.method).toBe('initialize');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-test-websearch');

    const callRequest = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(callRequest.method).toBe('tools/call');
    expect(callRequest.params).toEqual({
      name: 'web_search',
      arguments: { query: 'openhorse web search', limit: 3 },
    });
  });

  test('returns configuration error when WebSearch MCP API key is missing', async () => {
    process.env.ORION_CODE_WEBSEARCH_PROVIDER = 'native';
    delete process.env.ORION_CODE_WEBSEARCH_API_KEY;
    delete process.env.DASHSCOPE_API_KEY;
    delete process.env.ORION_CODE_API_KEY;

    const result = await webSearchTool.execute({ query: 'openhorse' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('WEBSEARCH_MCP_NOT_CONFIGURED');
    expect(result.error).toContain('ORION_CODE_WEBSEARCH_API_KEY');
  });

  test('falls back to DuckDuckGo when auto MCP rejects configured Coding Plan key', async () => {
    delete process.env.ORION_CODE_WEBSEARCH_API_KEY;
    process.env.ORION_CODE_API_KEY = 'sk-sp-test-dedicated';
    process.env.ORION_CODE_API_BASE_URL = 'https://coding.dashscope.aliyuncs.com/v1';
    global.fetch = jest.fn()
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response(`
        <html>
          <a class="result__a" href="https://example.com/orion-code">Orion Code</a>
        </html>
      `, { status: 200, headers: { 'content-type': 'text/html' } })) as any;

    const result = await webSearchTool.execute({ query: 'openhorse' }, ctx);

    expect(result.success).toBe(true);
    expect(result.output).toContain('[Orion Code](https://example.com/orion-code)');
    expect(result.metadata?.source).toBe('websearch-adapter');
    expect(result.metadata?.provider).toBe('duckduckgo');
    expect(result.metadata?.mcpError).toBe('WEBSEARCH_MCP_HTTP_ERROR');
    const headers = (global.fetch as jest.Mock).mock.calls[0][1].headers;
    expect(headers.Authorization).toBe('Bearer sk-sp-test-dedicated');
  });

  test('supports query-parameter auth for extensible MCP providers', async () => {
    delete process.env.ORION_CODE_WEBSEARCH_API_KEY;
    delete process.env.ORION_CODE_WEBSEARCH_MCP_ENDPOINT;
    process.env.ORION_CODE_WEBSEARCH_PROVIDER = 'tavily-mcp';
    process.env.TAVILY_API_KEY = 'tvly-test';

    const fetchMock = jest.fn()
      .mockResolvedValueOnce(jsonResponse({
        jsonrpc: '2.0',
        id: 'initialize-response',
        result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'Tavily' } },
      }))
      .mockResolvedValueOnce(new Response('', { status: 202 }))
      .mockResolvedValueOnce(jsonResponse({
        jsonrpc: '2.0',
        id: 'tools-list-response',
        result: {
          tools: [
            {
              name: 'search',
              inputSchema: {
                type: 'object',
                properties: {
                  query: { type: 'string' },
                },
              },
            },
          ],
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        jsonrpc: '2.0',
        id: 'tools-call-response',
        result: { content: [{ type: 'text', text: 'Tavily result' }] },
      }));
    global.fetch = fetchMock as any;

    const result = await webSearchTool.execute({ query: 'openhorse' }, ctx);

    expect(result.success).toBe(true);
    expect(result.metadata?.provider).toBe('tavily-mcp');
    expect(fetchMock.mock.calls[0][0]).toContain('https://mcp.tavily.com/mcp/');
    expect(fetchMock.mock.calls[0][0]).toContain('tavilyApiKey=tvly-test');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  test('supports explicit Tavily adapter mode like OpenClaude', async () => {
    delete process.env.ORION_CODE_WEBSEARCH_API_KEY;
    process.env.ORION_CODE_WEBSEARCH_PROVIDER = 'tavily';
    process.env.TAVILY_API_KEY = 'tvly-test';

    const fetchMock = jest.fn().mockResolvedValueOnce(jsonResponse({
      results: [
        {
          title: 'Orion Code',
          url: 'https://example.com/orion-code',
          content: 'Orion Code search adapter result',
        },
      ],
    }));
    global.fetch = fetchMock as any;

    const result = await webSearchTool.execute({ query: 'openhorse', limit: 2 }, ctx);

    expect(result.success).toBe(true);
    expect(result.metadata?.source).toBe('websearch-adapter');
    expect(result.metadata?.provider).toBe('tavily');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.tavily.com/search');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tvly-test');
    expect(result.output).toContain('[Orion Code](https://example.com/orion-code)');
  });
});
