/**
 * orion code - Web Tools
 *
 * WebFetch: Fetch URL content and process with prompt
 * WebSearch: delegate search to provider MCP service
 *
 * Issue #32 #3.7: SSRF 拦截 - 拒绝访问内网地址 + Content-Length 上限
 */

import { buildTool, type OpenHorseTool } from '../framework/tool';
import { loadConfig } from '../services/config';
import {
  WebSearchMcpClient,
  WebSearchMcpError,
  DEFAULT_WEBSEARCH_MCP_ENDPOINT,
} from '../services/web-search-mcp';
import {
  getWebSearchMcpErrorSuggestion,
  resolveWebSearchMcpConfig,
} from '../services/web-search-provider';
import {
  formatAdapterOutput,
  getWebSearchMode,
  isExplicitAdapterMode,
  runWebSearchAdapters,
  shouldFallbackToAdapters,
  shouldTryMcpFirst,
} from '../services/web-search-adapters';

// ============================================================================
// SSRF Protection - Issue #32 #3.7
// ============================================================================

/** 内网 IP 地址范围（禁止访问） */
const BLOCKED_IP_PATTERNS = [
  /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,       // 127.x.x.x (localhost range)
  /^10\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,        // 10.x.x.x (private class A)
  /^192\.168\.(\d{1,3})\.(\d{1,3})$/,             // 192.168.x.x (private class C)
  /^169\.254\.(\d{1,3})\.(\d{1,3})$/,             // 169.254.x.x (link-local)
  /^172\.(1[6-9]|2\d|3[01])\.(\d{1,3})\.(\d{1,3})$/, // 172.16-31.x.x (private class B)
  /^0\.0\.0\.0$/,                                  // 0.0.0.0
  /^::1$/,                                         // IPv6 localhost
  /^fc[0-9a-f]{2}:/i,                              // IPv6 unique local
  /^fe[8-9a-f][0-9a-f]:/i,                         // IPv6 link-local
];

/** 禁止访问的主机名 */
const BLOCKED_HOSTNAMES = [
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',    // GCP metadata server
  'metadata',                     // Azure metadata
  'kubernetes.default',           // K8s internal
  'kubernetes.default.svc',
];

/** 最大响应内容长度 (10MB) */
const MAX_CONTENT_LENGTH = 10 * 1024 * 1024;

/**
 * 检查 URL 是否为内网地址
 * @param url - 要检查的 URL
 * @returns 是否为安全的（非内网）地址
 */
function isUrlSafeForSSRF(url: string): { safe: boolean; reason?: string } {
  try {
    const parsed = new URL(url);
    let hostname = parsed.hostname.toLowerCase();
    // URL.hostname keeps brackets around IPv6 literals (e.g. "[::1]"); strip them
    // so the BLOCKED_IP_PATTERNS anchors (^::1$, etc.) can match.
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      hostname = hostname.slice(1, -1);
    }

    // 检查禁止的主机名
    if (BLOCKED_HOSTNAMES.includes(hostname)) {
      return { safe: false, reason: `Blocked hostname: ${hostname}` };
    }

    // 检查内网 IP 模式
    for (const pattern of BLOCKED_IP_PATTERNS) {
      if (pattern.test(hostname)) {
        return { safe: false, reason: `Blocked IP range: ${hostname}` };
      }
    }

    // 检查 IP 编码绕过（十进制/十六进制/八进制/IPv6-mapped IPv4）。
    // 这些形式在 fetch 时会被解析为内网地址，但字符串正则无法识别。
    const normalizedV4 = parseIPv4Loose(hostname);
    if (normalizedV4) {
      for (const pattern of BLOCKED_IP_PATTERNS) {
        if (pattern.test(normalizedV4)) {
          return { safe: false, reason: `Blocked IP range: ${hostname} (resolves to ${normalizedV4})` };
        }
      }
    }

    // 检查以 .internal, .local, .localhost 结尾的主机名
    if (hostname.endsWith('.internal') || hostname.endsWith('.local') || hostname.endsWith('.localhost')) {
      return { safe: false, reason: `Blocked internal hostname: ${hostname}` };
    }

    return { safe: true };
  } catch {
    // URL 解析失败
    return { safe: false, reason: 'Invalid URL format' };
  }
}

/**
 * 将各种 IPv4 编码形式归一化为点分十进制。
 * 覆盖：纯十进制整数、十六进制、八进制、IPv6-mapped IPv4 (::ffff:a.b.c.d)。
 * 无法识别时返回 null。
 */
function parseIPv4Loose(host: string): string | null {
  // IPv6-mapped IPv4, dotted form: ::ffff:127.0.0.1 / ::ffff:0:127.0.0.1
  const v6dotted = host.match(/::ffff:(?:0+:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (v6dotted) return normalizeDotted(v6dotted[1]);

  // IPv6-mapped IPv4, hex form: ::ffff:7f00:1 (Node's URL canonicalizes to this)
  const v6hex = host.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (v6hex) {
    const hi = parseInt(v6hex[1], 16);
    const lo = parseInt(v6hex[2], 16);
    return `${(hi >>> 8) & 255}.${hi & 255}.${(lo >>> 8) & 255}.${lo & 255}`;
  }

  // 单个十进制整数（如 2130706433 -> 127.0.0.1）
  if (/^\d+$/.test(host)) {
    const n = Number(host);
    if (n <= 0xffffffff && Number.isSafeInteger(n)) {
      return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
    }
  }

  // 单个十六进制（如 0x7f000001）
  if (/^0x[0-9a-f]+$/i.test(host)) {
    const n = parseInt(host, 16);
    if (n <= 0xffffffff) {
      return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
    }
  }

  // 点分形式，各段可为十进制/八进制/十六进制（如 0177.0.0.1）
  if (host.includes('.')) {
    const parts = host.split('.');
    if (parts.length === 4) {
      const octets = parts.map(parseOctet);
      if (octets.every(o => o !== null && o >= 0 && o <= 255)) {
        return octets.join('.');
      }
    }
  }

  return null;
}

function parseOctet(s: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
  if (/^0[0-7]+$/.test(s)) return parseInt(s, 8);
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return null;
}

function normalizeDotted(dotted: string): string | null {
  const parts = dotted.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map(p => {
    const n = parseInt(p, 10);
    return Number.isFinite(n) && n >= 0 && n <= 255 ? n : null;
  });
  if (octets.some(o => o === null)) return null;
  return octets.join('.');
}

export { isUrlSafeForSSRF };

// ============================================================================
// WebFetch Tool
// ============================================================================

/** Preapproved hosts that don't need permission */
const PREAPPROVED_HOSTS = [
  'github.com',
  'docs.google.com',
  'stackoverflow.com',
  'npmjs.com',
  'nodejs.org',
  'typescriptlang.org',
  'reactjs.org',
  'vuejs.org',
  'python.org',
  'golang.org',
  'rust-lang.org',
  'mdn.mozilla.org',
  'developer.mozilla.org',
  'wikipedia.org',
  'arxiv.org',
];

const MAX_MARKDOWN_LENGTH = 100_000;
const FETCH_CACHE_TTL_MS = 15 * 60 * 1000;
const FETCH_CACHE_MAX_ENTRIES = 50;

interface CacheEntry {
  ts: number;
  data: { content: string; code: number; contentType: string };
}

const fetchCache = new Map<string, CacheEntry>();

function cacheGet(url: string): CacheEntry['data'] | null {
  const entry = fetchCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.ts > FETCH_CACHE_TTL_MS) {
    fetchCache.delete(url);
    return null;
  }
  return entry.data;
}

function cacheSet(url: string, data: CacheEntry['data']): void {
  // Cap size — drop oldest entry when full
  if (fetchCache.size >= FETCH_CACHE_MAX_ENTRIES) {
    const oldest = fetchCache.keys().next().value;
    if (oldest) fetchCache.delete(oldest);
  }
  fetchCache.set(url, { ts: Date.now(), data });
}

function isPreapprovedHost(hostname: string, _pathname: string): boolean {
  return PREAPPROVED_HOSTS.some(host => hostname === host || hostname.endsWith('.' + host));
}

/** Simple HTML to Markdown converter */
function htmlToMarkdown(html: string): string {
  let md = html;

  // Remove script, style, nav, header, footer tags
  md = md.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  md = md.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  md = md.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');
  md = md.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');
  md = md.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');

  // Convert headings
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '# $1\n\n');
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '## $1\n\n');
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '### $1\n\n');
  md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '#### $1\n\n');
  md = md.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '##### $1\n\n');
  md = md.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '###### $1\n\n');

  // Bold and italic
  md = md.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
  md = md.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
  md = md.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
  md = md.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*');

  // Links
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

  // Code blocks
  md = md.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n');
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');

  // Lists
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  md = md.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, '$1');
  md = md.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, '$1');

  // Paragraphs and divs
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');
  md = md.replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, '$1\n');
  md = md.replace(/<br\s*\/?>/gi, '\n');

  // Remove remaining tags
  md = md.replace(/<[^>]+>/g, '');

  // Clean up whitespace
  md = md.replace(/\n{3,}/g, '\n\n');
  md = md.trim();

  return md;
}

interface FetchResult {
  content: string;
  code: number;
  contentType: string;
  url?: string;           // 最终 URL（跟随重定向后）
  redirects?: string[];   // 重定向链
  errorType?: string;     // 错误类型
}

async function fetchUrl(url: string, _maxRedirects: number = 5): Promise<FetchResult> {
  const cached = cacheGet(url);
  if (cached) return { ...cached, url };

  // Issue #32 #3.7: SSRF 检查
  const ssrfCheck = isUrlSafeForSSRF(url);
  if (!ssrfCheck.safe) {
    return {
      content: `SSRF blocked: ${ssrfCheck.reason}`,
      code: 403,
      contentType: 'text/plain',
      errorType: 'SSRF_BLOCKED',
    };
  }

  try {
    // Issue #20 修复：启用 redirect: 'follow' 自动跟随重定向
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Orion-Code/0.2.27',
        'Accept': 'text/html,application/xhtml+xml,text/markdown,text/plain,*/*',
      },
      redirect: 'follow',  // 自动跟随重定向（最多 20 次，由 fetch 内置限制）
    });

    // Issue #32 #3.7: Content-Length 检查
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_CONTENT_LENGTH) {
      return {
        content: `Response too large: Content-Length ${contentLength} exceeds ${MAX_CONTENT_LENGTH} bytes`,
        code: 413,
        contentType: 'text/plain',
        errorType: 'CONTENT_TOO_LARGE',
      };
    }

    const contentType = response.headers.get('content-type') || 'text/plain';
    const finalUrl = response.url;
    const redirects: string[] = [];

    // 记录重定向信息（如果发生了重定向）
    if (response.redirected && finalUrl !== url) {
      redirects.push(finalUrl);
    }

    if (!response.ok) {
      return {
        content: `HTTP Error ${response.status}: ${response.statusText}`,
        code: response.status,
        contentType,
        url: finalUrl,
        redirects,
        errorType: 'HTTP_ERROR',
      };
    }

    const text = await response.text();

    // Convert to markdown if HTML
    let content = text;
    if (contentType.includes('text/html')) {
      content = htmlToMarkdown(text);
    }

    // Truncate if too large
    if (content.length > MAX_MARKDOWN_LENGTH) {
      content = content.slice(0, MAX_MARKDOWN_LENGTH) + '\n\n[... content truncated]';
    }

    const result: FetchResult = {
      content,
      code: response.status,
      contentType,
      url: finalUrl,
      redirects,
    };
    if (response.ok) cacheSet(url, { content, code: response.status, contentType });
    return result;
  } catch (err: any) {
    return {
      content: `Fetch error: ${err.message}`,
      code: 0,
      contentType: 'text/plain',
      errorType: 'NETWORK_ERROR',
    };
  }
}

/** Clear the fetch cache (test helper / debugging) */
export function clearWebFetchCache(): void {
  fetchCache.clear();
}

/** Apply prompt to content using simple extraction */
function applyPromptToContent(content: string, prompt: string): string {
  // For simple prompts, return the content directly
  const lowerPrompt = prompt.toLowerCase();

  if (lowerPrompt.includes('title') || lowerPrompt.includes('name')) {
    // Try to extract title
    const titleMatch = content.match(/^#\s+(.+)$/m);
    if (titleMatch) {
      return `Title: ${titleMatch[1]}\n\n${content}`;
    }
  }

  if (lowerPrompt.includes('summary') || lowerPrompt.includes('summarize')) {
    // Return first few paragraphs as summary
    const paragraphs = content.split('\n\n').filter(p => p.length > 50);
    const summary = paragraphs.slice(0, 3).join('\n\n');
    return `Summary:\n${summary}\n\n---\n\nFull content:\n${content}`;
  }

  // Default: return content with prompt context
  return `Prompt: "${prompt}"\n\nContent:\n${content}`;
}

export const webFetchTool: OpenHorseTool = buildTool({
  name: 'web_fetch',
  description: `Fetch content from a URL and process with a prompt.
IMPORTANT: WebFetch WILL FAIL for authenticated or private URLs.
Before using this tool, check if the URL points to an authenticated service (e.g. Google Docs, Confluence, Jira, GitHub).`,
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch content from (must be a valid URL)',
      },
      prompt: {
        type: 'string',
        description: 'The prompt to run on the fetched content (e.g. "extract the title", "summarize the content")',
      },
    },
    required: ['url', 'prompt'],
  },
  execute: async (args) => {
    const url = args.url as string;
    const prompt = args.prompt as string;

    if (!url || typeof url !== 'string') {
      return { success: false, output: '', error: 'web_fetch requires a url parameter' };
    }

    if (!prompt || typeof prompt !== 'string') {
      return { success: false, output: '', error: 'web_fetch requires a prompt parameter' };
    }

    // Validate URL
    try {
      const parsed = new URL(url);
      if (!parsed.protocol.startsWith('http')) {
        return { success: false, output: '', error: 'URL must use http or https protocol' };
      }
    } catch {
      return { success: false, output: '', error: `Invalid URL: ${url}` };
    }

    const { content, code, url: finalUrl, redirects, errorType } = await fetchUrl(url);

    // Issue #20 修复：返回结构化结果
    // Issue #32 #3.7: SSRF 和 Content-Length 错误处理
    if (code !== 200) {
      const errorInfo = {
        type: errorType || 'HTTP_ERROR',
        code,
        message: content,
        url: finalUrl,
        redirects: redirects || [],
      };

      // SSRF 或 Content-Length 错误时返回更详细的错误
      if (errorType === 'SSRF_BLOCKED') {
        return {
          success: false,
          output: '',
          error: `Security policy blocked access to internal network address. ${content}`,
        };
      }
      if (errorType === 'CONTENT_TOO_LARGE') {
        return {
          success: false,
          output: '',
          error: `Response exceeds maximum allowed size (${MAX_CONTENT_LENGTH} bytes). ${content}`,
        };
      }

      return {
        success: false,
        output: '',
        error: JSON.stringify(errorInfo),
      };
    }

    const resultContent = applyPromptToContent(content, prompt);
    const finalUrlInfo = finalUrl !== url ? `\n\nFinal URL (after redirects): ${finalUrl}` : '';

    return {
      success: true,
      output: resultContent + finalUrlInfo,
    };
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  checkPermissions: (args) => {
    const url = args.url as string;
    try {
      const parsed = new URL(url);
      if (isPreapprovedHost(parsed.hostname, parsed.pathname)) {
        return { behavior: 'allow', reason: 'Preapproved host' };
      }
    } catch {
      // Invalid URL - will fail in execute
    }
    return { behavior: 'ask', reason: 'Fetching external URL' };
  },
  userFacingName: (args) => {
    try {
      const url = new URL(args.url as string);
      return `Fetch ${url.hostname}`;
    } catch {
      return `Fetch ${args.url as string}`;
    }
  },
});

// ============================================================================
// WebSearch Tool - provider MCP delegation
// ============================================================================

let cachedWebSearchClient: { key: string; client: WebSearchMcpClient } | null = null;

function getWebSearchMcpClient(): WebSearchMcpClient {
  const config = loadConfig();
  const webSearch = resolveWebSearchMcpConfig(config);

  const key = JSON.stringify({
    provider: webSearch.provider,
    endpoint: webSearch.endpoint,
    apiKey: webSearch.apiKey ? `${webSearch.apiKey.slice(0, 8)}...` : '',
    toolName: webSearch.toolName || '',
    timeoutMs: webSearch.timeoutMs || 0,
    authType: webSearch.authType || '',
    apiKeyHeader: webSearch.apiKeyHeader || '',
    apiKeyQueryParam: webSearch.apiKeyQueryParam || '',
    headers: Object.keys(webSearch.headers || {}).sort(),
  });

  if (!cachedWebSearchClient || cachedWebSearchClient.key !== key) {
    cachedWebSearchClient = {
      key,
      client: new WebSearchMcpClient(webSearch),
    };
  }

  return cachedWebSearchClient.client;
}

export function resetWebSearchMcpClientForTests(): void {
  cachedWebSearchClient = null;
}

export const webSearchTool: OpenHorseTool = buildTool({
  name: 'web_search',
  description: `Search the web through the built-in WebSearch provider chain.
Orion Code tries provider-native MCP first in auto mode, then falls back to configured search adapters such as Tavily, Brave, custom search, or DuckDuckGo.
You MUST include the Sources section with markdown hyperlinks in your response.`,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query (minimum 2 characters)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results (optional, default 5)',
      },
    },
    required: ['query'],
  },
  execute: async (args) => {
    const query = args.query as string;
    const limit = (args.limit as number) || 5;

    if (!query || typeof query !== 'string') {
      return { success: false, output: '', error: 'web_search requires a query parameter' };
    }

    if (query.length < 2) {
      return { success: false, output: '', error: 'Query must be at least 2 characters' };
    }

    const config = loadConfig();
    const mode = getWebSearchMode(config);
    let mcpError: WebSearchMcpError | null = null;

    if (shouldTryMcpFirst(mode)) {
      try {
        const result = await getWebSearchMcpClient().search(query, limit);
        return {
          success: true,
          output: result.output,
          metadata: { source: 'websearch-mcp', provider: result.provider, endpoint: result.endpoint, tool: result.toolName },
        };
      } catch (err: any) {
        const resolvedConfig = resolveWebSearchMcpConfig(config);
        mcpError = err instanceof WebSearchMcpError
          ? err
          : new WebSearchMcpError('WEBSEARCH_MCP_ERROR', err.message || String(err), resolvedConfig.endpoint || DEFAULT_WEBSEARCH_MCP_ENDPOINT);

        if (!shouldFallbackToAdapters(mode)) {
          return {
            success: false,
            output: '',
            error: JSON.stringify({
              type: mcpError.type,
              source: 'websearch-mcp',
              endpoint: mcpError.endpoint,
              message: mcpError.message,
              suggestion: getWebSearchMcpErrorSuggestion(resolvedConfig),
            }),
            metadata: { source: 'websearch-mcp', provider: resolvedConfig.provider, endpoint: mcpError.endpoint },
          };
        }
      }
    }

    try {
      const adapterResult = await runWebSearchAdapters(
        { query, limit },
        isExplicitAdapterMode(mode) ? mode : 'auto'
      );
      return {
        success: true,
        output: formatAdapterOutput(adapterResult, query),
        metadata: { source: 'websearch-adapter', provider: adapterResult.provider, mcpError: mcpError?.type },
      };
    } catch (adapterErr: any) {
      const resolvedConfig = resolveWebSearchMcpConfig(config);
      return {
        success: false,
        output: '',
        error: JSON.stringify({
          type: 'WEBSEARCH_UNAVAILABLE',
          source: 'websearch',
          mode,
          mcp: mcpError
            ? {
                type: mcpError.type,
                endpoint: mcpError.endpoint,
                message: mcpError.message,
              }
            : undefined,
          adapter: adapterErr?.message || String(adapterErr),
          suggestion: [
            getWebSearchMcpErrorSuggestion(resolvedConfig),
            'Or set ORION_CODE_WEBSEARCH_PROVIDER=ddg/tavily/brave/custom with the matching adapter configuration.',
          ].join(' '),
        }),
        metadata: { source: 'websearch', provider: resolvedConfig.provider, endpoint: resolvedConfig.endpoint },
      };
    }
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  checkPermissions: () => {
    return { behavior: 'ask', reason: 'Web search may query external services' };
  },
  userFacingName: (args) => `Search "${(args.query as string)?.slice(0, 30)}"`,
});

// ============================================================================
// Export
// ============================================================================

export const WEB_TOOLS: OpenHorseTool[] = [webFetchTool, webSearchTool];
