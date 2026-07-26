/**
 * Remote WebSearch MCP client.
 *
 * The built-in web_search tool delegates search to a provider MCP service
 * instead of scraping search-engine HTML locally.
 */

import type { WebSearchMcpConfig } from './config';
import { BAILIAN_WEBSEARCH_MCP_ENDPOINT } from './web-search-provider';
import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

export const DEFAULT_WEBSEARCH_MCP_ENDPOINT = BAILIAN_WEBSEARCH_MCP_ENDPOINT;

const MCP_PROTOCOL_VERSION = '2025-03-26';
const DEFAULT_TIMEOUT_MS = 30_000;
const CLIENT_VERSION_FALLBACK = '0.2.6';

function getPackageVersion(): string {
  if (process.env.npm_package_version) return process.env.npm_package_version;

  try {
    const pkgPath = resolvePath(__dirname, '../../package.json');
    const pkgText = readFileSync(pkgPath, 'utf8');
    const payload = JSON.parse(pkgText);
    if (typeof payload?.version === 'string' && payload.version) return payload.version;
  } catch {
    // ignore and fall back below
  }
  return CLIENT_VERSION_FALLBACK;
}

const CLIENT_VERSION = getPackageVersion();

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number;
  result?: any;
  error?: { code?: number; message?: string; data?: any };
}

interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

interface ResolvedWebSearchMcpConfig {
  endpoint: string;
  provider?: string;
  apiKey?: string;
  toolName?: string;
  timeoutMs: number;
  authType?: 'bearer' | 'header' | 'query' | 'none';
  apiKeyHeader?: string;
  apiKeyQueryParam?: string;
  headers: Record<string, string>;
}

export interface WebSearchMcpSearchResult {
  output: string;
  toolName: string;
  endpoint: string;
  provider?: string;
}

export class WebSearchMcpError extends Error {
  readonly type: string;
  readonly endpoint: string;

  constructor(type: string, message: string, endpoint: string) {
    super(message);
    this.name = 'WebSearchMcpError';
    this.type = type;
    this.endpoint = endpoint;
  }
}

function resolveConfig(config: WebSearchMcpConfig = {}): ResolvedWebSearchMcpConfig {
  return {
    endpoint: config.endpoint || DEFAULT_WEBSEARCH_MCP_ENDPOINT,
    provider: config.provider,
    apiKey: config.apiKey,
    toolName: config.toolName,
    timeoutMs: config.timeoutMs || DEFAULT_TIMEOUT_MS,
    authType: config.authType,
    apiKeyHeader: config.apiKeyHeader,
    apiKeyQueryParam: config.apiKeyQueryParam,
    headers: config.headers || {},
  };
}

function parseSseMessages(text: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  const events = text.split(/\n\n+/);

  for (const event of events) {
    const dataLines = event
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice('data:'.length).trim());

    if (dataLines.length === 0) continue;
    const data = dataLines.join('\n');
    if (!data || data === '[DONE]') continue;

    try {
      messages.push(JSON.parse(data) as JsonRpcMessage);
    } catch {
      // Ignore non-JSON SSE frames.
    }
  }

  return messages;
}

function parseJsonRpcMessages(text: string, contentType: string): JsonRpcMessage[] {
  if (!text.trim()) return [];

  if (contentType.includes('text/event-stream')) {
    return parseSseMessages(text);
  }

  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function withTimeout(timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

function normalizeMcpOutput(result: any): string {
  if (Array.isArray(result?.content)) {
    const text = result.content
      .filter((item: any) => item?.type === 'text' && typeof item.text === 'string')
      .map((item: any) => item.text)
      .join('\n');
    if (text) return text;
  }

  if (result?.structuredContent) {
    return JSON.stringify(result.structuredContent, null, 2);
  }

  return JSON.stringify(result, null, 2);
}

function selectSearchTool(tools: McpToolDefinition[], preferred?: string): McpToolDefinition {
  if (tools.length === 0) {
    throw new Error('WebSearch MCP returned no tools');
  }

  const candidates = [
    preferred,
    'web_search',
    'webSearch',
    'WebSearch',
    'search',
    'Search',
    'webSearchPrime',
  ].filter(Boolean) as string[];

  for (const name of candidates) {
    const exact = tools.find(tool => tool.name === name);
    if (exact) return exact;
  }

  const fuzzy = tools.find(tool => /search/i.test(tool.name));
  return fuzzy || tools[0];
}

function buildSearchArgs(tool: McpToolDefinition, query: string, limit?: number): Record<string, unknown> {
  const properties = tool.inputSchema?.properties || {};
  const args: Record<string, unknown> = {};

  const queryKey = ['query', 'q', 'keyword', 'keywords', 'search_query', 'searchQuery', 'input']
    .find(key => Object.prototype.hasOwnProperty.call(properties, key));
  args[queryKey || 'query'] = query;

  if (limit && limit > 0) {
    const limitKey = ['limit', 'count', 'num_results', 'max_results', 'top_k', 'topK', 'page_size', 'pageSize']
      .find(key => Object.prototype.hasOwnProperty.call(properties, key));
    if (limitKey) {
      args[limitKey] = limit;
    }
  }

  return args;
}

export class WebSearchMcpClient {
  private readonly config: ResolvedWebSearchMcpConfig;
  private initialized = false;
  private sessionId: string | null = null;
  private tools: McpToolDefinition[] = [];

  constructor(config?: WebSearchMcpConfig) {
    this.config = resolveConfig(config);
  }

  async search(query: string, limit?: number): Promise<WebSearchMcpSearchResult> {
    await this.ensureInitialized();

    const tool = selectSearchTool(this.tools, this.config.toolName);
    const result = await this.request('tools/call', {
      name: tool.name,
      arguments: buildSearchArgs(tool, query, limit),
    });

    if (result?.isError) {
      throw new WebSearchMcpError('WEBSEARCH_MCP_TOOL_ERROR', normalizeMcpOutput(result), this.config.endpoint);
    }

    return {
      output: normalizeMcpOutput(result),
      toolName: tool.name,
      endpoint: this.config.endpoint,
      provider: this.config.provider,
    };
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    if (
      this.config.authType !== 'none'
      && !this.config.apiKey
      && !this.config.headers.Authorization
      && !this.config.headers.authorization
    ) {
      throw new WebSearchMcpError(
        'WEBSEARCH_MCP_NOT_CONFIGURED',
        'WebSearch MCP API key is not configured. Set webSearch.apiKey, ORION_CODE_WEBSEARCH_API_KEY, a provider API key env var, or the Orion Code apiKey.',
        this.config.endpoint
      );
    }

    await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'orion-code', version: CLIENT_VERSION },
    });

    await this.notification('notifications/initialized', {});

    const toolsResult = await this.request('tools/list', {});
    this.tools = toolsResult?.tools || [];
    this.initialized = true;
  }

  private async notification(method: string, params: Record<string, unknown>): Promise<void> {
    await this.sendJsonRpc({ jsonrpc: '2.0', method, params });
  }

  private async request(method: string, params: Record<string, unknown>): Promise<any> {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const message = { jsonrpc: '2.0', id, method, params };
    const messages = await this.sendJsonRpc(message);
    const response = messages.find(msg => String(msg.id) === id) || messages[0];

    if (!response) {
      throw new WebSearchMcpError('WEBSEARCH_MCP_EMPTY_RESPONSE', `Empty MCP response for ${method}`, this.config.endpoint);
    }
    if (response.error) {
      throw new WebSearchMcpError(
        'WEBSEARCH_MCP_RPC_ERROR',
        response.error.message || `MCP ${method} failed`,
        this.config.endpoint
      );
    }

    return response.result;
  }

  private async sendJsonRpc(message: Record<string, unknown>): Promise<JsonRpcMessage[]> {
    const authType = this.config.authType || 'bearer';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
      ...this.config.headers,
    };

    let endpoint = this.config.endpoint;
    if (this.config.apiKey && authType === 'query') {
      const url = new URL(endpoint);
      url.searchParams.set(this.config.apiKeyQueryParam || 'api_key', this.config.apiKey);
      endpoint = url.toString();
    }

    if (
      this.config.apiKey
      && authType !== 'none'
      && authType !== 'query'
      && !headers.Authorization
      && !headers.authorization
    ) {
      const headerName = this.config.apiKeyHeader || 'Authorization';
      headers[headerName] = authType === 'header'
        ? this.config.apiKey
        : `Bearer ${this.config.apiKey}`;
    }
    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId;
    }

    const timeout = withTimeout(this.config.timeoutMs);
    let response: Response;

    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: timeout.signal,
      });
    } catch (err: any) {
      const message = err?.name === 'AbortError'
        ? `request timed out after ${this.config.timeoutMs}ms`
        : err?.message || String(err);
      throw new WebSearchMcpError('WEBSEARCH_MCP_NETWORK_ERROR', message, this.config.endpoint);
    } finally {
      timeout.cleanup();
    }

    const sessionId = response.headers.get('mcp-session-id') || response.headers.get('Mcp-Session-Id');
    if (sessionId) {
      this.sessionId = sessionId;
    }

    if (response.status === 202 || response.status === 204) {
      return [];
    }

    const text = await response.text();
    if (!response.ok) {
      throw new WebSearchMcpError(
        'WEBSEARCH_MCP_HTTP_ERROR',
        `HTTP ${response.status}: ${text || response.statusText}`,
        this.config.endpoint
      );
    }

    try {
      return parseJsonRpcMessages(text, response.headers.get('content-type') || '');
    } catch (err: any) {
      throw new WebSearchMcpError(
        'WEBSEARCH_MCP_PARSE_ERROR',
        `Failed to parse MCP response: ${err.message}`,
        this.config.endpoint
      );
    }
  }
}
