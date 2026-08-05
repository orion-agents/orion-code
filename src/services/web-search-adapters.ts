import type { OrionCodeCLIConfig } from './config';
import axios from 'axios';
import { webSearchEnv } from '../product/environment';
import { PACKAGE_VERSION } from '../product/version';

export interface WebSearchAdapterInput {
  query: string;
  limit: number;
}

export interface WebSearchHit {
  title: string;
  url: string;
  description?: string;
}

export interface WebSearchAdapterOutput {
  provider: string;
  hits: WebSearchHit[];
  durationSeconds: number;
}

interface WebSearchAdapter {
  name: string;
  isConfigured(): boolean;
  search(input: WebSearchAdapterInput): Promise<WebSearchAdapterOutput>;
}

interface AdapterHttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  /**
   * Provider payloads have no shared schema, so the parsed body stays
   * `unknown`. `extractHits` is the single place allowed to interpret it,
   * and it narrows every field before use.
   */
  json(): Promise<unknown>;
}

/** A JSON object of unknown shape, as returned by an external provider. */
type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

/** Return the first field of `keys` that holds a non-empty string. */
function pickString(source: UnknownRecord, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

export type WebSearchMode =
  | 'auto'
  | 'native'
  | 'mcp'
  | 'bailian'
  | 'zhipu'
  | 'tavily-mcp'
  | 'ddg'
  | 'duckduckgo'
  | 'tavily'
  | 'brave'
  | 'custom';

const ADAPTER_MODES = new Set(['ddg', 'duckduckgo', 'tavily', 'brave', 'custom']);
const MCP_ONLY_MODES = new Set(['native', 'mcp', 'bailian', 'zhipu', 'tavily-mcp']);
const OWSAK = webSearchEnv('API_KEY');

const DUCKDUCKGO_UA = `Mozilla/5.0 OrionCode/${PACKAGE_VERSION}`;

function hasProxyEnv(): boolean {
  return Boolean(
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy
  );
}

/**
 * Detect a Jest-replaced `global.fetch`.
 *
 * Under test we must not divert through axios, or the mock never sees the
 * request. Jest tags its mocks with `_isMockFunction`/`mock`, neither of
 * which exists on the DOM `fetch` type — hence the structural probe.
 */
function isFetchMocked(): boolean {
  const candidate = global.fetch as unknown as
    | { _isMockFunction?: boolean; mock?: unknown }
    | undefined;
  return Boolean(candidate?._isMockFunction || candidate?.mock);
}

async function adapterFetch(url: string, init: RequestInit = {}): Promise<AdapterHttpResponse> {
  if (!hasProxyEnv() || isFetchMocked()) {
    const response = await fetch(url, init);
    return {
      ok: response.ok,
      status: response.status,
      text: () => response.text(),
      json: () => response.json(),
    };
  }
  const response = await axios.request({
    url,
    method: init.method || 'GET',
    headers: init.headers as Record<string, string> | undefined,
    data: init.body,
    timeout: 30_000,
    validateStatus: () => true,
  });
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    text: async () =>
      typeof response.data === 'string' ? response.data : JSON.stringify(response.data),
    json: async () =>
      typeof response.data === 'string' ? JSON.parse(response.data) : response.data,
  };
}

function getRawMode(config: OrionCodeCLIConfig): string {
  return (
    config.webSearch?.provider ||
    process.env[webSearchEnv('PROVIDER')] ||
    process.env[webSearchEnv('MCP_PROVIDER')] ||
    'auto'
  )
    .trim()
    .toLowerCase();
}

export function getWebSearchMode(config: OrionCodeCLIConfig): WebSearchMode {
  const mode = getRawMode(config);
  if (
    mode === 'native' ||
    mode === 'mcp' ||
    mode === 'bailian' ||
    mode === 'zhipu' ||
    mode === 'tavily-mcp' ||
    mode === 'ddg' ||
    mode === 'duckduckgo' ||
    mode === 'tavily' ||
    mode === 'brave' ||
    mode === 'custom'
  )
    return mode;
  return 'auto';
}

export function shouldTryMcpFirst(mode: WebSearchMode): boolean {
  return !ADAPTER_MODES.has(mode);
}
export function shouldFallbackToAdapters(mode: WebSearchMode): boolean {
  return mode === 'auto';
}
export function isExplicitAdapterMode(mode: WebSearchMode): boolean {
  return ADAPTER_MODES.has(mode);
}
export function isMcpOnlyMode(mode: WebSearchMode): boolean {
  return MCP_ONLY_MODES.has(mode);
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function unwrapDuckDuckGoUrl(rawUrl: string): string {
  const decoded = decodeHtml(rawUrl);
  try {
    const url = decoded.startsWith('//') ? new URL('https:' + decoded) : new URL(decoded);
    const uddg = url.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : url.toString();
  } catch {
    return decoded;
  }
}

function limitHits(hits: WebSearchHit[], limit: number): WebSearchHit[] {
  const seen = new Set<string>();
  const out: WebSearchHit[] = [];
  for (const hit of hits) {
    if (!hit.url || seen.has(hit.url)) continue;
    seen.add(hit.url);
    out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}

const TITLE_KEYS = ['title', 'name', 'headline', 'heading', 'url', 'link'] as const;
const URL_KEYS = ['url', 'link', 'href', 'uri'] as const;
const DESCRIPTION_KEYS = ['description', 'snippet', 'content', 'summary', 'text'] as const;

function normalizeHit(raw: unknown): WebSearchHit | null {
  if (!isRecord(raw)) return null;
  const title = pickString(raw, TITLE_KEYS);
  const url = pickString(raw, URL_KEYS);
  if (!title || !url) return null;
  const description = pickString(raw, DESCRIPTION_KEYS);
  return { title, url, ...(description ? { description } : {}) };
}

function extractHits(payload: unknown): WebSearchHit[] {
  const root = isRecord(payload) ? payload : undefined;
  const web = root && isRecord(root.web) ? root.web : undefined;
  const candidates: unknown[] = [
    root?.results,
    web?.results,
    root?.organic_results,
    root?.data,
    root?.items,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const hits = candidate
      .map(normalizeHit)
      .filter((hit): hit is WebSearchHit => hit !== null);
    if (hits.length > 0) return hits;
  }
  if (Array.isArray(payload)) {
    return payload.map(normalizeHit).filter((hit): hit is WebSearchHit => hit !== null);
  }
  return [];
}

function withDuration(
  provider: string,
  start: number,
  hits: WebSearchHit[]
): WebSearchAdapterOutput {
  return { provider, hits, durationSeconds: (Date.now() - start) / 1000 };
}

const tavilyAdapter: WebSearchAdapter = {
  name: 'tavily',
  isConfigured() {
    return Boolean(process.env.TAVILY_API_KEY || process.env[OWSAK]);
  },
  async search(input) {
    const start = Date.now();
    const apiKey = process.env.TAVILY_API_KEY || process.env[OWSAK];
    if (!apiKey) throw new Error('Tavily search is not configured. Set TAVILY_API_KEY.');
    const response = await adapterFetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query: input.query, max_results: input.limit, search_depth: 'basic' }),
    });
    if (!response.ok)
      throw new Error(`Tavily search failed: HTTP ${response.status} ${await response.text()}`);
    const payload = await response.json();
    return withDuration('tavily', start, limitHits(extractHits(payload), input.limit));
  },
};

const braveAdapter: WebSearchAdapter = {
  name: 'brave',
  isConfigured() {
    return Boolean(process.env.BRAVE_API_KEY);
  },
  async search(input) {
    const start = Date.now();
    if (!process.env.BRAVE_API_KEY)
      throw new Error('Brave search is not configured. Set BRAVE_API_KEY.');
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', input.query);
    url.searchParams.set('count', String(Math.min(Math.max(input.limit, 1), 20)));
    const response = await adapterFetch(url.toString(), {
      headers: { Accept: 'application/json', 'X-Subscription-Token': process.env.BRAVE_API_KEY },
    });
    if (!response.ok)
      throw new Error(`Brave search failed: HTTP ${response.status} ${await response.text()}`);
    const payload = await response.json();
    return withDuration('brave', start, limitHits(extractHits(payload), input.limit));
  },
};

const customAdapter: WebSearchAdapter = {
  name: 'custom',
  isConfigured() {
    return Boolean(process.env[webSearchEnv('API')] || process.env.WEB_SEARCH_API);
  },
  async search(input) {
    const start = Date.now();
    const endpoint = process.env[webSearchEnv('API')] || process.env.WEB_SEARCH_API;
    if (!endpoint) throw new Error(`Custom search is not configured. Set ${webSearchEnv('API')}.`);
    const method = (
      process.env[webSearchEnv('METHOD')] ||
      process.env.WEB_METHOD ||
      'GET'
    ).toUpperCase();
    const queryParam =
      process.env[webSearchEnv('QUERY_PARAM')] || process.env.WEB_QUERY_PARAM || 'q';
    const headers: Record<string, string> = { Accept: 'application/json' };
    const apiKey = process.env[OWSAK] || process.env.WEB_KEY;
    const authHeader = process.env[webSearchEnv('API_KEY_HEADER')] || process.env.WEB_AUTH_HEADER;
    if (apiKey && authHeader) headers[authHeader] = apiKey;

    let response: AdapterHttpResponse;
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      response = await adapterFetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ [queryParam]: input.query, limit: input.limit }),
      });
    } else {
      const url = new URL(endpoint);
      url.searchParams.set(queryParam, input.query);
      url.searchParams.set('limit', String(input.limit));
      response = await adapterFetch(url.toString(), { headers });
    }
    if (!response.ok)
      throw new Error(`Custom search failed: HTTP ${response.status} ${await response.text()}`);
    const payload = await response.json();
    return withDuration('custom', start, limitHits(extractHits(payload), input.limit));
  },
};

const duckDuckGoAdapter: WebSearchAdapter = {
  name: 'duckduckgo',
  isConfigured() {
    return true;
  },
  async search(input) {
    const start = Date.now();
    const url = new URL('https://duckduckgo.com/html/');
    url.searchParams.set('q', input.query);
    const response = await adapterFetch(url.toString(), {
      headers: {
        'User-Agent': DUCKDUCKGO_UA,
        Accept: 'text/html,application/xhtml+xml,text/html;q=0.9,*/*;q=0.8',
      },
    });
    if (!response.ok) throw new Error(`DuckDuckGo search failed: HTTP ${response.status}`);
    const html = await response.text();
    if (/anomaly in the request|making requests too quickly/i.test(html)) {
      throw new Error('DuckDuckGo scraping is rate-limited from this network.');
    }
    const hits: WebSearchHit[] = [];
    const anchorPattern =
      /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;
    while ((match = anchorPattern.exec(html)) !== null) {
      hits.push({ title: decodeHtml(match[2]), url: unwrapDuckDuckGoUrl(match[1]) });
    }
    if (hits.length === 0) throw new Error('DuckDuckGo returned no parseable results.');
    return withDuration('duckduckgo', start, limitHits(hits, input.limit));
  },
};

const ADAPTER_BY_MODE: Record<string, WebSearchAdapter> = {
  tavily: tavilyAdapter,
  brave: braveAdapter,
  custom: customAdapter,
  ddg: duckDuckGoAdapter,
  duckduckgo: duckDuckGoAdapter,
};

function autoAdapterChain(): WebSearchAdapter[] {
  return [tavilyAdapter, braveAdapter, customAdapter, duckDuckGoAdapter].filter(a =>
    a.isConfigured()
  );
}

function explicitAdapterChain(mode: WebSearchMode): WebSearchAdapter[] {
  const adapter = ADAPTER_BY_MODE[mode];
  return adapter ? [adapter] : [];
}

export async function runWebSearchAdapters(
  input: WebSearchAdapterInput,
  mode: WebSearchMode
): Promise<WebSearchAdapterOutput> {
  const chain = mode === 'auto' ? autoAdapterChain() : explicitAdapterChain(mode);
  if (chain.length === 0) throw new Error(`No web search adapter is available for mode "${mode}".`);
  const errors: Error[] = [];
  for (const adapter of chain) {
    try {
      const result = await adapter.search(input);
      if (result.hits.length > 0 || mode !== 'auto') return result;
      errors.push(new Error(`${adapter.name} returned no results`));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      errors.push(error);
      if (mode !== 'auto') throw error;
    }
  }
  throw new Error(
    `All ${chain.length} web search adapters failed:\n` +
      errors.map((error, index) => `  ${index + 1}. ${error.message}`).join('\n')
  );
}

export function formatAdapterOutput(result: WebSearchAdapterOutput, query: string): string {
  const lines = [`Web search results for "${query}" via ${result.provider}:`, '', 'Sources:'];
  for (const hit of result.hits) {
    const description = hit.description ? ` - ${hit.description}` : '';
    lines.push(`- [${hit.title}](${hit.url})${description}`);
  }
  return lines.join('\n');
}
