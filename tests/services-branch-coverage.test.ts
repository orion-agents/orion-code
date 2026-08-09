import axios from 'axios';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { LLMService, ProviderRequestPreflightError, type Message } from '../src/services/llm';
import {
  calculateCtxPercent,
  createContextUsageSnapshot,
  discoverModelContexts,
  getAllKnownModels,
  getModelInfo,
  normalizeModelId,
  resolveContextBudget,
  resolveModelContext,
} from '../src/services/model-context';
import { TaskCapacityError, TaskManager, type TaskRecord } from '../src/services/task-manager';
import {
  formatAdapterOutput,
  getWebSearchMode,
  isExplicitAdapterMode,
  isMcpOnlyMode,
  runWebSearchAdapters,
  shouldFallbackToAdapters,
  shouldTryMcpFirst,
} from '../src/services/web-search-adapters';
import { WebSearchMcpClient, WebSearchMcpError } from '../src/services/web-search-mcp';
import { PACKAGE_VERSION } from '../src/product/version';
import {
  AuthService,
  SecureStorage,
  getAuthService,
  getSecureStorage,
  resetAuthService,
} from '../src/services/auth/auth';
import {
  BaseTransport,
  HttpTransport,
  SseTransport,
  TransportManager,
  WebSocketTransport,
  createTransport,
  getTransportManager,
  resetTransportManager,
  type TransportMessage,
} from '../src/services/mcp/transports';

type GlobalProperty = 'fetch' | 'EventSource' | 'WebSocket';

let envBeforeTest: NodeJS.ProcessEnv;
let globalDescriptorsBeforeTest: Record<GlobalProperty, PropertyDescriptor | undefined>;

function jsonResponse(payload: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function asyncStream(chunks: any[]): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function restoreProcessEnv(snapshot: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(process.env)) {
    if (!(name in snapshot)) delete process.env[name];
  }
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function restoreGlobalProperty(
  name: GlobalProperty,
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete (globalThis as unknown as Record<string, unknown>)[name];
}

function runCleanup(actions: Array<() => void>): void {
  const errors: unknown[] = [];
  for (const action of actions) {
    try {
      action();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw errors[0];
}

beforeEach(() => {
  envBeforeTest = { ...process.env };
  globalDescriptorsBeforeTest = {
    fetch: Object.getOwnPropertyDescriptor(globalThis, 'fetch'),
    EventSource: Object.getOwnPropertyDescriptor(globalThis, 'EventSource'),
    WebSocket: Object.getOwnPropertyDescriptor(globalThis, 'WebSocket'),
  };
});

afterEach(() => {
  runCleanup([
    () => resetAuthService(),
    () => resetTransportManager(),
    () => restoreProcessEnv(envBeforeTest),
    () => restoreGlobalProperty('fetch', globalDescriptorsBeforeTest.fetch),
    () => restoreGlobalProperty('EventSource', globalDescriptorsBeforeTest.EventSource),
    () => restoreGlobalProperty('WebSocket', globalDescriptorsBeforeTest.WebSocket),
    () => jest.restoreAllMocks(),
    () => jest.useRealTimers(),
  ]);
});

describe('services branch coverage: task manager', () => {
  test('covers defaults, updates, events, deletion, conversions, cleanup, and reset', () => {
    const manager = new TaskManager();
    const events: string[] = [];
    manager.on('created', () => events.push('created'));
    manager.on('updated', () => events.push('updated'));
    manager.on('deleted', () => events.push('deleted'));
    manager.on('reset', () => events.push('reset'));

    const defaults = manager.create({ name: 'default', description: 'default task' });
    expect(defaults).toMatchObject({
      priority: 'P1',
      assignedTo: 'leader',
      tags: [],
      retries: 0,
      maxRetries: 3,
      status: 'pending',
    });

    const configured = manager.create({
      name: 'configured',
      description: 'configured task',
      priority: 'P0',
      assignedTo: 'worker',
      params: { input: 1 },
      tags: ['coverage'],
      maxRetries: 1,
    });
    expect(manager.get(configured.id)).toBe(configured);
    expect(manager.get('missing')).toBeUndefined();
    expect(manager.update('missing', { name: 'nope' })).toBeUndefined();
    expect(manager.update(configured.id, {})).toBe(configured);
    expect(
      manager.update(configured.id, {
        name: 'updated',
        description: 'updated description',
        priority: 'P2',
        assignedTo: 'reviewer',
        params: { output: 2 },
        tags: ['updated'],
        maxRetries: 2,
      })
    ).toMatchObject({
      name: 'updated',
      description: 'updated description',
      priority: 'P2',
      assignedTo: 'reviewer',
      params: { output: 2 },
      tags: ['updated'],
      maxRetries: 2,
    });

    expect(manager.toTask(configured)).toEqual(
      expect.objectContaining({ id: configured.id, status: 'pending', params: { output: 2 } })
    );
    expect(manager.delete('missing')).toBe(false);
    expect(manager.delete(defaults.id)).toBe(true);
    expect(manager.cleanup([])).toBe(0);
    manager.reset();
    expect(manager.getStats().total).toBe(0);
    expect(events).toEqual(expect.arrayContaining(['created', 'updated', 'deleted', 'reset']));
  });

  test('covers every valid and invalid transition plus retry limits', () => {
    const manager = new TaskManager();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const statusChanges: Array<{ from: string; to: string }> = [];
    manager.on('status-change', event => statusChanges.push(event));

    expect(manager.start('missing')).toBeUndefined();
    expect(manager.complete('missing')).toBeUndefined();
    expect(manager.fail('missing')).toBeUndefined();
    expect(manager.retry('missing')).toBeUndefined();

    const completed = manager.create({ name: 'complete', description: 'complete' });
    expect(manager.start(completed.id)?.startedAt).toEqual(expect.any(Number));
    expect(manager.start(completed.id)).toBeUndefined();
    expect(manager.complete(completed.id, { success: true, data: { value: 'ok' } })).toMatchObject({
      status: 'completed',
      result: { success: true, data: { value: 'ok' } },
      completedAt: expect.any(Number),
    });
    expect(manager.cancel(completed.id)).toBeUndefined();
    expect(manager.retry(completed.id)).toBeUndefined();
    expect(completed.retries).toBe(0);

    const failedDefault = manager.create({ name: 'failed-default', description: 'failed' });
    manager.start(failedDefault.id);
    expect(manager.fail(failedDefault.id)).toMatchObject({
      status: 'failed',
      result: { success: false, error: 'Task failed' },
    });
    expect(manager.retry(failedDefault.id)).toMatchObject({ status: 'pending', retries: 1 });

    const failedCustom = manager.create({
      name: 'failed-custom',
      description: 'failed',
      maxRetries: 0,
    });
    manager.start(failedCustom.id);
    manager.fail(failedCustom.id, 'boom', { success: false, error: 'structured' });
    expect(manager.retry(failedCustom.id)).toBeUndefined();

    const cancelled = manager.create({ name: 'cancelled', description: 'cancelled' });
    expect(manager.cancel(cancelled.id)).toMatchObject({ status: 'cancelled' });
    expect(manager.retry(cancelled.id)).toMatchObject({ status: 'pending', retries: 1 });

    expect(statusChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'pending', to: 'running' }),
        expect.objectContaining({ from: 'running', to: 'completed' }),
        expect.objectContaining({ from: 'running', to: 'failed' }),
        expect.objectContaining({ from: 'failed', to: 'pending' }),
        expect.objectContaining({ from: 'cancelled', to: 'pending' }),
      ])
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('covers scalar and array filters, time bounds, tags, sorting, and stats', () => {
    const manager = new TaskManager();
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValueOnce(100).mockReturnValueOnce(200).mockReturnValueOnce(300);
    const p2 = manager.create({
      name: 'p2',
      description: 'p2',
      priority: 'P2',
      assignedTo: 'a',
      tags: ['one'],
    });
    const p0 = manager.create({
      name: 'p0',
      description: 'p0',
      priority: 'P0',
      assignedTo: 'b',
      tags: ['two'],
    });
    const p1 = manager.create({
      name: 'p1',
      description: 'p1',
      priority: 'P1',
      assignedTo: 'a',
      tags: ['one', 'two'],
    });
    now.mockRestore();

    expect(manager.list()).toHaveLength(3);
    expect(manager.list({ status: 'pending' })).toHaveLength(3);
    expect(manager.list({ status: ['running', 'failed'] })).toHaveLength(0);
    expect(manager.list({ priority: 'P0' })).toEqual([p0]);
    expect(manager.list({ priority: ['P1', 'P2'] })).toEqual([p2, p1]);
    expect(manager.list({ assignedTo: 'a' })).toEqual([p2, p1]);
    expect(manager.list({ tags: ['two'] })).toEqual([p0, p1]);
    expect(manager.list({ tags: [] })).toHaveLength(3);
    expect(manager.list({ createdAfter: 200 })).toEqual([p0, p1]);
    expect(manager.list({ createdBefore: 200 })).toEqual([p2, p0]);
    expect(manager.getPending().map(task => task.priority)).toEqual(['P0', 'P1', 'P2']);
    expect(manager.getByAgent('a')).toEqual([p2, p1]);

    manager.start(p0.id);
    manager.complete(p0.id);
    manager.start(p1.id);
    manager.fail(p1.id, 'no');
    manager.cancel(p2.id);
    expect(manager.getStats()).toEqual({
      total: 3,
      pending: 0,
      running: 0,
      completed: 1,
      failed: 1,
      cancelled: 1,
    });
    expect(manager.cleanup(['completed'])).toBe(1);
    expect(manager.cleanup()).toBe(2);
  });

  test('evicts oldest terminal work only when capacity is reached', () => {
    const originalMax = (TaskManager as any).MAX_TASKS;
    (TaskManager as any).MAX_TASKS = 2;
    try {
      const manager = new TaskManager();
      const old = manager.create({ name: 'old', description: 'old' });
      manager.start(old.id);
      manager.complete(old.id);
      old.updatedAt = 1;
      const pending = manager.create({ name: 'pending', description: 'pending' });
      manager.create({ name: 'new', description: 'new' });
      expect(manager.get(old.id)).toBeUndefined();
      expect(manager.get(pending.id)).toBeDefined();

      const cancelled = new TaskManager();
      const cancelledTask = cancelled.create({ name: 'cancelled', description: 'cancelled' });
      cancelled.cancel(cancelledTask.id);
      cancelled.create({ name: 'pending', description: 'pending' });
      cancelled.create({ name: 'replacement', description: 'replacement' });
      expect(cancelled.get(cancelledTask.id)).toBeUndefined();

      const noTerminal = new TaskManager();
      noTerminal.create({ name: 'one', description: 'one' });
      noTerminal.create({ name: 'two', description: 'two' });
      expect(() => noTerminal.create({ name: 'three', description: 'three' })).toThrow(
        TaskCapacityError
      );
      expect(noTerminal.getStats().total).toBe(2);
    } finally {
      (TaskManager as any).MAX_TASKS = originalMax;
    }
  });
});

describe('services branch coverage: model context', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  test('normalizes IDs and resolves builtin, fuzzy, default, and empty model IDs', () => {
    expect(normalizeModelId('  vendors/OpenAI/GPT-4O  ')).toBe('gpt-4o');
    expect(resolveModelContext('gpt-4o')).toMatchObject({ source: 'builtin', matchedId: 'gpt-4o' });
    expect(resolveModelContext('provider/gpt-4o')).toMatchObject({ source: 'builtin' });
    expect(resolveModelContext('gpt-4o:latest')).toMatchObject({ source: 'fuzzy' });
    expect(resolveModelContext('totally-unknown')).toMatchObject({
      source: 'default',
      label: 'totally-unknown',
      matchedId: 'default',
    });
    // Empty IDs currently fuzzy-match the first builtin because every string includes ''.
    expect(resolveModelContext('')).toMatchObject({ source: 'fuzzy' });
    expect(getModelInfo('gpt-4o')).not.toBeNull();
    expect(getModelInfo('missing-model')).toBeNull();
    expect(calculateCtxPercent(999999, 'gpt-4')).toBe(100);
  });

  test('discovers numeric and string context windows while rejecting malformed entries', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse({
        data: [
          { id: 'Vendor/New-Model', context_window: 4096 },
          { id: 'string-model', max_context_length: '8192' },
          { id: '', context_window: 100 },
          { id: 'zero', context_window: 0 },
          { id: 'nan', context_window: 'wat' },
          { id: 'negative', context_window: -1 },
          { id: 'missing' },
        ],
      })
    );
    const models = await discoverModelContexts('https://models.example/', 'secret');
    expect(models.map(model => model.id)).toEqual(['Vendor/New-Model', 'string-model']);
    expect(resolveModelContext('Vendor/New-Model')).toMatchObject({ source: 'discovered' });
    expect(resolveModelContext('vendor/new-model')).toMatchObject({
      source: 'discovered',
      id: 'new-model',
      label: 'Vendor/New-Model',
    });
    expect(getAllKnownModels()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'Vendor/New-Model' })])
    );
    expect(global.fetch).toHaveBeenCalledWith(
      'https://models.example/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
      })
    );
  });

  test('silently handles non-ok, missing data, and rejected discovery requests', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockRejectedValueOnce(new Error('offline'));
    await expect(discoverModelContexts('https://models.example', 'x')).resolves.toEqual([]);
    await expect(discoverModelContexts('https://models.example', 'x')).resolves.toEqual([]);
    await expect(discoverModelContexts('https://models.example', 'x')).resolves.toEqual([]);
  });

  test('resolves finite, capped, zero, negative, and non-finite context budgets', () => {
    expect(resolveContextBudget('gpt-4', 2000)).toMatchObject({
      contextWindow: 8192,
      reservedOutputTokens: 2000,
      safetyMarginTokens: 1024,
    });
    expect(resolveContextBudget('gpt-4', 999999).reservedOutputTokens).toBe(4096);
    expect(resolveContextBudget('gpt-4', -4).reservedOutputTokens).toBe(0);
    expect(resolveContextBudget('gpt-4', 10.6).reservedOutputTokens).toBe(11);
    expect(resolveContextBudget('gpt-4', Number.NaN).reservedOutputTokens).toBe(4096);
    expect(resolveContextBudget('totally-unknown').reservedOutputTokens).toBe(8192);
    expect(resolveContextBudget('gpt-4', 999999).safeInputBudget).toBe(3072);
  });

  test('creates default and customized usage snapshots with clamping', () => {
    expect(createContextUsageSnapshot({ modelId: 'gpt-4', usedTokens: Number.NaN })).toMatchObject({
      usedTokens: 0,
      source: 'estimated',
      warningThresholdPercent: 80,
      autoCompactThresholdPercent: 95,
      autoCompactEnabled: true,
    });
    expect(
      createContextUsageSnapshot({
        modelId: 'gpt-4',
        usedTokens: -4,
        source: 'provider_adjusted',
        warningThreshold: 0.5,
        autoCompactThreshold: 0.75,
        autoCompactEnabled: false,
        outputReserveTokens: 0,
      })
    ).toMatchObject({
      usedTokens: 0,
      source: 'provider_adjusted',
      warningThresholdPercent: 50,
      autoCompactThresholdPercent: 75,
      autoCompactEnabled: false,
    });
    expect(createContextUsageSnapshot({ modelId: 'gpt-4', usedTokens: 100000 })).toMatchObject({
      percent: 100,
      rawPercent: 100,
    });
  });
});

describe('services branch coverage: auth and secure storage', () => {
  const configDir = process.env.ORION_CODE_CONFIG_DIR as string;
  const authPath = join(configDir, 'auth.json');
  const securePath = join(configDir, 'secure.json');

  beforeEach(() => {
    resetAuthService();
    delete process.env.ORION_CODE_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    rmSync(authPath, { recursive: true, force: true });
    rmSync(securePath, { recursive: true, force: true });
  });

  test('loads missing/corrupt configuration and prefers environment API keys', () => {
    const missing = new AuthService();
    expect(missing.getApiKey()).toBeNull();
    expect(missing.getOAuthToken()).toBeNull();
    expect(missing.getAwsAuth()).toBeNull();
    expect(missing.isAuthenticated()).toBe(false);

    writeFileSync(authPath, '{broken');
    const corrupt = new AuthService();
    expect(corrupt.getStatus()).toMatchObject({ hasApiKey: false, hasOAuth: false, hasAws: false });
    process.env.ANTHROPIC_API_KEY = 'anthropic-env';
    expect(corrupt.getApiKey()).toBe('anthropic-env');
    process.env.ORION_CODE_API_KEY = 'orion-env';
    expect(corrupt.getApiKey()).toBe('orion-env');
  });

  test('persists API, OAuth, and AWS variants and reports status', () => {
    const auth = new AuthService();
    (auth as any).config = null;
    auth.setApiKey('stored', 'file');
    expect(auth.getApiKey()).toBe('stored');
    expect(JSON.parse(readFileSync(authPath, 'utf8')).apiKey).toMatchObject({
      key: 'stored',
      source: 'file',
      createdAt: expect.any(Number),
    });

    (auth as any).config = null;
    auth.setOAuthToken('provider', 'access');
    expect(auth.getOAuthToken()).toMatchObject({
      provider: 'provider',
      accessToken: 'access',
      refreshToken: undefined,
      expiresAt: undefined,
    });
    auth.setOAuthToken('provider-2', 'access-2', 'refresh', Date.now() + 10000);
    expect(auth.getOAuthToken()).toMatchObject({ provider: 'provider-2', refreshToken: 'refresh' });
    auth.setOAuthToken('expired', 'expired', undefined, Date.now() - 1);
    expect(auth.getOAuthToken()).toBeNull();

    (auth as any).config = null;
    auth.setAwsAuth('default');
    expect(auth.getAwsAuth()).toEqual({ profile: 'default', region: 'us-east-1' });
    auth.setAwsAuth('china', 'cn-north-1');
    expect(auth.getAwsAuth()).toEqual({ profile: 'china', region: 'cn-north-1' });
    expect(auth.getStatus()).toMatchObject({
      hasApiKey: false,
      hasOAuth: false,
      hasAws: true,
      awsProfile: 'china',
    });
    auth.clear();
    expect(auth.isAuthenticated()).toBe(false);
  });

  test('uses singleton factories and resets the auth singleton', () => {
    const first = getAuthService();
    expect(getAuthService()).toBe(first);
    resetAuthService();
    expect(getAuthService()).not.toBe(first);
    expect(getSecureStorage()).toBe(getSecureStorage());
  });

  test('stores, retrieves, deletes, and tolerates missing secure values', async () => {
    const storage = new SecureStorage();
    expect(await storage.retrieve('svc', 'acct')).toBeNull();
    expect(await storage.delete('svc', 'acct')).toBe(true);
    expect(await storage.store('svc', 'acct', 'first')).toBe(true);
    expect(await storage.store('svc2', 'acct2', 'second')).toBe(true);
    expect(await storage.retrieve('svc', 'acct')).toBe('first');
    expect(await storage.retrieve('missing', 'missing')).toBeNull();
    expect(await storage.delete('svc', 'acct')).toBe(true);
    expect(await storage.retrieve('svc', 'acct')).toBeNull();
  });

  test('returns safe failures for corrupt or unwritable secure storage', async () => {
    const storage = new SecureStorage();
    writeFileSync(securePath, '{broken');
    await expect(storage.retrieve('svc', 'acct')).resolves.toBeNull();
    await expect(storage.delete('svc', 'acct')).resolves.toBe(false);
    await expect(storage.store('svc', 'acct', 'secret')).resolves.toBe(false);

    rmSync(securePath, { force: true });
    mkdirSync(securePath);
    await expect(storage.store('svc', 'acct', 'secret')).resolves.toBe(false);
    await expect(storage.retrieve('svc', 'acct')).resolves.toBeNull();
    await expect(storage.delete('svc', 'acct')).resolves.toBe(false);
  });
});

describe('services branch coverage: web-search adapters', () => {
  const adapterEnvNames = [
    'ORION_CODE_WEBSEARCH_PROVIDER',
    'ORION_CODE_WEBSEARCH_MCP_PROVIDER',
    'ORION_CODE_WEBSEARCH_API_KEY',
    'ORION_CODE_WEBSEARCH_API',
    'ORION_CODE_WEBSEARCH_METHOD',
    'ORION_CODE_WEBSEARCH_QUERY_PARAM',
    'ORION_CODE_WEBSEARCH_API_KEY_HEADER',
    'TAVILY_API_KEY',
    'BRAVE_API_KEY',
    'WEB_SEARCH_API',
    'WEB_METHOD',
    'WEB_QUERY_PARAM',
    'WEB_KEY',
    'WEB_AUTH_HEADER',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'https_proxy',
    'http_proxy',
  ];

  beforeEach(() => {
    for (const name of adapterEnvNames) delete process.env[name];
    global.fetch = jest.fn();
  });

  test('resolves config/env modes and classifies routing policies', () => {
    expect(getWebSearchMode({} as any)).toBe('auto');
    process.env.ORION_CODE_WEBSEARCH_MCP_PROVIDER = ' zhipu ';
    expect(getWebSearchMode({} as any)).toBe('zhipu');
    process.env.ORION_CODE_WEBSEARCH_PROVIDER = ' BRAVE ';
    expect(getWebSearchMode({} as any)).toBe('brave');
    expect(getWebSearchMode({ webSearch: { provider: 'wat' } } as any)).toBe('auto');
    expect(getWebSearchMode({ webSearch: { provider: 'duckduckgo' } } as any)).toBe('duckduckgo');

    for (const mode of ['native', 'mcp', 'bailian', 'zhipu', 'tavily-mcp'] as const) {
      expect(shouldTryMcpFirst(mode)).toBe(true);
      expect(isMcpOnlyMode(mode)).toBe(true);
      expect(isExplicitAdapterMode(mode)).toBe(false);
    }
    for (const mode of ['ddg', 'duckduckgo', 'tavily', 'brave', 'custom'] as const) {
      expect(shouldTryMcpFirst(mode)).toBe(false);
      expect(isMcpOnlyMode(mode)).toBe(false);
      expect(isExplicitAdapterMode(mode)).toBe(true);
    }
    expect(shouldFallbackToAdapters('auto')).toBe(true);
    expect(shouldFallbackToAdapters('mcp')).toBe(false);
  });

  test('runs Tavily success, empty, missing-key, HTTP-error, and primitive-error branches', async () => {
    await expect(runWebSearchAdapters({ query: 'q', limit: 2 }, 'tavily')).rejects.toThrow(
      'Tavily search is not configured'
    );
    process.env.TAVILY_API_KEY = 'tavily-key';
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            { title: 'A', url: 'https://a', description: 'desc' },
            { name: 'B', link: 'https://b', snippet: 'snippet' },
            { title: 'duplicate', url: 'https://a' },
            null,
          ],
        })
      )
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
      .mockResolvedValueOnce(new Response('bad', { status: 429 }))
      .mockRejectedValueOnce('primitive');
    await expect(runWebSearchAdapters({ query: 'q', limit: 2 }, 'tavily')).resolves.toMatchObject({
      provider: 'tavily',
      hits: [
        { title: 'A', url: 'https://a', description: 'desc' },
        { title: 'B', url: 'https://b', description: 'snippet' },
      ],
    });
    await expect(runWebSearchAdapters({ query: 'q', limit: 1 }, 'tavily')).resolves.toMatchObject({
      hits: [],
    });
    await expect(runWebSearchAdapters({ query: 'q', limit: 1 }, 'tavily')).rejects.toThrow(
      'HTTP 429 bad'
    );
    await expect(runWebSearchAdapters({ query: 'q', limit: 1 }, 'tavily')).rejects.toThrow(
      'primitive'
    );
  });

  test('runs Brave with clamped limits and alternate result fields', async () => {
    await expect(runWebSearchAdapters({ query: 'q', limit: 1 }, 'brave')).rejects.toThrow(
      'Brave search is not configured'
    );
    process.env.BRAVE_API_KEY = 'brave-key';
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(
        jsonResponse({
          web: {
            results: [{ headline: 'Headline', href: 'https://headline', content: 'content' }],
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({ organic_results: [{ heading: 'H', uri: 'https://h', summary: 'S' }] })
      )
      .mockResolvedValueOnce(new Response('bad', { status: 500 }));
    await runWebSearchAdapters({ query: 'q', limit: 0 }, 'brave');
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain('count=1');
    await runWebSearchAdapters({ query: 'q', limit: 99 }, 'brave');
    expect(String((global.fetch as jest.Mock).mock.calls[1][0])).toContain('count=20');
    await expect(runWebSearchAdapters({ query: 'q', limit: 1 }, 'brave')).rejects.toThrow(
      'HTTP 500 bad'
    );
  });

  test('runs custom GET/POST, auth aliases, payload shapes, and missing/HTTP errors', async () => {
    await expect(runWebSearchAdapters({ query: 'q', limit: 1 }, 'custom')).rejects.toThrow(
      'Custom search is not configured'
    );
    process.env.WEB_SEARCH_API = 'https://custom.example/search';
    process.env.WEB_QUERY_PARAM = 'term';
    process.env.WEB_KEY = 'key';
    process.env.WEB_AUTH_HEADER = 'X-Key';
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ title: 'GET', url: 'https://get', text: 'body' }] })
      )
      .mockResolvedValueOnce(jsonResponse({ items: [{ title: 'POST', url: 'https://post' }] }))
      .mockResolvedValueOnce(new Response('denied', { status: 403 }));
    await runWebSearchAdapters({ query: 'hello', limit: 3 }, 'custom');
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain('term=hello');
    expect((global.fetch as jest.Mock).mock.calls[0][1].headers).toMatchObject({ 'X-Key': 'key' });

    process.env.WEB_METHOD = 'post';
    await runWebSearchAdapters({ query: 'post', limit: 4 }, 'custom');
    expect((global.fetch as jest.Mock).mock.calls[1][1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ term: 'post', limit: 4 }),
    });
    await expect(runWebSearchAdapters({ query: 'q', limit: 1 }, 'custom')).rejects.toThrow(
      'HTTP 403 denied'
    );
  });

  test('uses axios under proxy and handles string and object response data', async () => {
    process.env.HTTPS_PROXY = 'http://proxy.example';
    process.env.WEB_SEARCH_API = 'https://custom.example/search';
    global.fetch = (async () => new Response()) as typeof fetch;
    const request = jest
      .spyOn(axios, 'request')
      .mockResolvedValueOnce({
        status: 200,
        data: JSON.stringify({ results: [{ title: 'A', url: 'https://a' }] }),
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: { results: [{ title: 'B', url: 'https://b' }] },
      } as any)
      .mockResolvedValueOnce({ status: 500, data: { message: 'bad' } } as any);
    await expect(runWebSearchAdapters({ query: 'a', limit: 1 }, 'custom')).resolves.toMatchObject({
      hits: [{ title: 'A', url: 'https://a' }],
    });
    await expect(runWebSearchAdapters({ query: 'b', limit: 1 }, 'custom')).resolves.toMatchObject({
      hits: [{ title: 'B', url: 'https://b' }],
    });
    await expect(runWebSearchAdapters({ query: 'c', limit: 1 }, 'custom')).rejects.toThrow(
      '{"message":"bad"}'
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', timeout: 30000 })
    );
    request.mockRestore();
  });

  test('parses DuckDuckGo HTML, unwraps links, decodes markup, and reports blocks/no-results', async () => {
    const html = [
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example%2F&amp;x=1"><b>A &amp; B</b></a>',
      '<a class="result__a" href="not a url">Second &quot;Hit&quot;</a>',
      '<a class="result__a" href="https://a.example/">duplicate</a>',
    ].join('\n');
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(new Response(html, { status: 200 }))
      .mockResolvedValueOnce(new Response('anomaly in the request', { status: 200 }))
      .mockResolvedValueOnce(new Response('<html>empty</html>', { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(runWebSearchAdapters({ query: 'q', limit: 5 }, 'ddg')).resolves.toMatchObject({
      provider: 'duckduckgo',
      hits: expect.arrayContaining([
        expect.objectContaining({ title: 'A & B', url: 'https://a.example/' }),
        expect.objectContaining({ title: 'Second "Hit"', url: 'not a url' }),
      ]),
    });
    expect((global.fetch as jest.Mock).mock.calls[0][1].headers['User-Agent']).toBe(
      `Mozilla/5.0 OrionCode/${PACKAGE_VERSION}`
    );
    await expect(runWebSearchAdapters({ query: 'q', limit: 1 }, 'duckduckgo')).rejects.toThrow(
      'rate-limited'
    );
    await expect(runWebSearchAdapters({ query: 'q', limit: 1 }, 'ddg')).rejects.toThrow(
      'no parseable results'
    );
    await expect(runWebSearchAdapters({ query: 'q', limit: 1 }, 'ddg')).rejects.toThrow('HTTP 503');
  });

  test('falls through auto adapters, aggregates failures, and rejects unavailable modes', async () => {
    await expect(runWebSearchAdapters({ query: 'q', limit: 1 }, 'native')).rejects.toThrow(
      'No web search adapter is available'
    );
    process.env.TAVILY_API_KEY = 't';
    process.env.BRAVE_API_KEY = 'b';
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
      .mockResolvedValueOnce(
        jsonResponse({ web: { results: [{ title: 'B', url: 'https://b' }] } })
      );
    await expect(runWebSearchAdapters({ query: 'q', limit: 1 }, 'auto')).resolves.toMatchObject({
      provider: 'brave',
      hits: [{ title: 'B', url: 'https://b' }],
    });

    (global.fetch as jest.Mock).mockReset();
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(new Response('tavily bad', { status: 500 }))
      .mockResolvedValueOnce(new Response('brave bad', { status: 500 }))
      .mockResolvedValueOnce(new Response('<html>none</html>', { status: 200 }));
    await expect(runWebSearchAdapters({ query: 'q', limit: 1 }, 'auto')).rejects.toThrow(
      /All 3 web search adapters failed/
    );
  });

  test('formats descriptions only when present', () => {
    expect(
      formatAdapterOutput(
        {
          provider: 'test',
          durationSeconds: 0,
          hits: [
            { title: 'A', url: 'https://a', description: 'desc' },
            { title: 'B', url: 'https://b' },
          ],
        },
        'query'
      )
    ).toContain('- [A](https://a) - desc\n- [B](https://b)');
  });
});

describe('services branch coverage: WebSearch MCP', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  function rpcFetch(tools: any[], callResult: any = { content: [{ type: 'text', text: 'ok' }] }) {
    return jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const result =
        body.method === 'tools/list' ? { tools } : body.method === 'tools/call' ? callResult : {};
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result }, 200, {
        'mcp-session-id': 'session-1',
      });
    });
  }

  test('requires credentials unless auth is none or an authorization header is provided', async () => {
    await expect(
      new WebSearchMcpClient({ endpoint: 'https://mcp.example' }).search('q')
    ).rejects.toMatchObject({
      type: 'WEBSEARCH_MCP_NOT_CONFIGURED',
      endpoint: 'https://mcp.example',
    });

    global.fetch = rpcFetch([{ name: 'search', inputSchema: { properties: {} } }]);
    await expect(
      new WebSearchMcpClient({ endpoint: 'https://mcp.example', authType: 'none' }).search('q')
    ).resolves.toMatchObject({ output: 'ok' });

    global.fetch = rpcFetch([{ name: 'search', inputSchema: { properties: {} } }]);
    await expect(
      new WebSearchMcpClient({
        endpoint: 'https://mcp.example',
        headers: { authorization: 'Basic x' },
      }).search('q')
    ).resolves.toMatchObject({ output: 'ok' });
  });

  test.each([
    [
      'preferred',
      [{ name: 'custom', inputSchema: { properties: { keyword: {}, count: {} } } }],
      'custom',
      'keyword',
      'count',
    ],
    [
      'standard',
      [{ name: 'web_search', inputSchema: { properties: { q: {}, top_k: {} } } }],
      undefined,
      'q',
      'top_k',
    ],
    [
      'fuzzy',
      [
        {
          name: 'providerSearchTool',
          inputSchema: { properties: { searchQuery: {}, pageSize: {} } },
        },
      ],
      undefined,
      'searchQuery',
      'pageSize',
    ],
    ['fallback', [{ name: 'anything', inputSchema: {} }], undefined, 'query', undefined],
  ])(
    'selects %s tools and maps query/limit keys',
    async (_label, tools, preferred, queryKey, limitKey) => {
      global.fetch = rpcFetch(tools);
      const client = new WebSearchMcpClient({
        endpoint: 'https://mcp.example',
        apiKey: 'key',
        toolName: preferred as string | undefined,
      });
      await client.search('needle', 3);
      const call = (global.fetch as jest.Mock).mock.calls
        .map(entry => JSON.parse(String(entry[1].body)))
        .find(body => body.method === 'tools/call');
      expect(call.params.arguments[queryKey as string]).toBe('needle');
      if (limitKey) expect(call.params.arguments[limitKey as string]).toBe(3);
      else expect(call.params.arguments).not.toHaveProperty('limit');
    }
  );

  test('normalizes text, structured, and raw tool outputs and omits nonpositive limits', async () => {
    global.fetch = rpcFetch(
      [{ name: 'search', inputSchema: { properties: { query: {}, limit: {} } } }],
      {
        content: [
          { type: 'image', text: 'ignore' },
          { type: 'text', text: 'one' },
          { type: 'text', text: 'two' },
        ],
      }
    );
    await expect(
      new WebSearchMcpClient({
        endpoint: 'https://mcp.example',
        authType: 'none',
        provider: 'p',
      }).search('q', 0)
    ).resolves.toMatchObject({
      output: 'one\ntwo',
      provider: 'p',
      toolName: 'search',
      endpoint: 'https://mcp.example',
    });

    global.fetch = rpcFetch([{ name: 'search' }], { structuredContent: { answer: 1 } });
    await expect(
      new WebSearchMcpClient({ endpoint: 'https://mcp.example', authType: 'none' }).search('q')
    ).resolves.toMatchObject({ output: '{\n  "answer": 1\n}' });

    global.fetch = rpcFetch([{ name: 'search' }], { value: 2 });
    await expect(
      new WebSearchMcpClient({ endpoint: 'https://mcp.example', authType: 'none' }).search('q')
    ).resolves.toMatchObject({ output: '{\n  "value": 2\n}' });
  });

  test('supports query/header/bearer/none auth and reuses a returned session ID', async () => {
    for (const auth of [
      { authType: 'query', apiKey: 'q', apiKeyQueryParam: 'token' },
      { authType: 'header', apiKey: 'h', apiKeyHeader: 'X-Key' },
      { apiKey: 'b' },
      { authType: 'none', apiKey: 'ignored' },
      { apiKey: 'b', headers: { Authorization: 'Override' } },
    ] as any[]) {
      global.fetch = rpcFetch([{ name: 'search' }]);
      await new WebSearchMcpClient({ endpoint: 'https://mcp.example', ...auth }).search('q');
      const [firstUrl, firstInit] = (global.fetch as jest.Mock).mock.calls[0];
      const laterInit = (global.fetch as jest.Mock).mock.calls[2][1];
      if (auth.authType === 'query') expect(String(firstUrl)).toContain('token=q');
      if (auth.authType === 'header') expect(firstInit.headers['X-Key']).toBe('h');
      if (!auth.authType)
        expect(firstInit.headers.Authorization).toBe(auth.headers?.Authorization ?? 'Bearer b');
      if (auth.authType === 'none') expect(firstInit.headers.Authorization).toBeUndefined();
      expect(laterInit.headers['Mcp-Session-Id']).toBe('session-1');
    }
  });

  test('parses SSE frames and ignores done, empty, and malformed events', async () => {
    global.fetch = jest.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === 'notifications/initialized') return new Response(null, { status: 204 });
      const result =
        body.method === 'tools/list'
          ? { tools: [{ name: 'search' }] }
          : body.method === 'tools/call'
            ? { content: [{ type: 'text', text: 'sse' }] }
            : {};
      const text = [
        'event: ping',
        '',
        'data: not-json',
        '',
        'data: [DONE]',
        '',
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}`,
        '',
      ].join('\n');
      return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    await expect(
      new WebSearchMcpClient({ endpoint: 'https://mcp.example', authType: 'none' }).search('q')
    ).resolves.toMatchObject({ output: 'sse' });
  });

  test('reports no-tools, tool error, empty, RPC, HTTP, parse, timeout, and network errors', async () => {
    global.fetch = rpcFetch([]);
    await expect(
      new WebSearchMcpClient({ endpoint: 'https://mcp.example', authType: 'none' }).search('q')
    ).rejects.toThrow('returned no tools');

    global.fetch = rpcFetch([{ name: 'search' }], {
      isError: true,
      content: [{ type: 'text', text: 'tool failed' }],
    });
    await expect(
      new WebSearchMcpClient({ endpoint: 'https://mcp.example', authType: 'none' }).search('q')
    ).rejects.toMatchObject({ type: 'WEBSEARCH_MCP_TOOL_ERROR' });

    (global.fetch as jest.Mock).mockReset().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(
      new WebSearchMcpClient({ endpoint: 'https://mcp.example', authType: 'none' }).search('q')
    ).rejects.toMatchObject({ type: 'WEBSEARCH_MCP_EMPTY_RESPONSE' });

    (global.fetch as jest.Mock).mockReset().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init.body));
      return jsonResponse({ jsonrpc: '2.0', id: body.id, error: {} });
    });
    await expect(
      new WebSearchMcpClient({ endpoint: 'https://mcp.example', authType: 'none' }).search('q')
    ).rejects.toMatchObject({ type: 'WEBSEARCH_MCP_RPC_ERROR' });

    (global.fetch as jest.Mock)
      .mockReset()
      .mockResolvedValue(new Response('', { status: 500, statusText: 'Bad' }));
    await expect(
      new WebSearchMcpClient({ endpoint: 'https://mcp.example', authType: 'none' }).search('q')
    ).rejects.toMatchObject({ type: 'WEBSEARCH_MCP_HTTP_ERROR' });

    (global.fetch as jest.Mock)
      .mockReset()
      .mockResolvedValue(
        new Response('{broken', { status: 200, headers: { 'content-type': 'application/json' } })
      );
    await expect(
      new WebSearchMcpClient({ endpoint: 'https://mcp.example', authType: 'none' }).search('q')
    ).rejects.toMatchObject({ type: 'WEBSEARCH_MCP_PARSE_ERROR' });

    (global.fetch as jest.Mock)
      .mockReset()
      .mockRejectedValue(Object.assign(new Error('abort'), { name: 'AbortError' }));
    await expect(
      new WebSearchMcpClient({
        endpoint: 'https://mcp.example',
        authType: 'none',
        timeoutMs: 7,
      }).search('q')
    ).rejects.toMatchObject({
      type: 'WEBSEARCH_MCP_NETWORK_ERROR',
      message: 'request timed out after 7ms',
    });

    (global.fetch as jest.Mock).mockReset().mockRejectedValue('offline');
    await expect(
      new WebSearchMcpClient({ endpoint: 'https://mcp.example', authType: 'none' }).search('q')
    ).rejects.toMatchObject({
      type: 'WEBSEARCH_MCP_NETWORK_ERROR',
      message: 'offline',
    });
  });

  test('exposes structured error metadata', () => {
    const error = new WebSearchMcpError('TYPE', 'message', 'endpoint');
    expect(error).toMatchObject({ name: 'WebSearchMcpError', type: 'TYPE', endpoint: 'endpoint' });
  });
});

describe('services branch coverage: MCP transports', () => {
  class FakeEventSource {
    static instances: FakeEventSource[] = [];
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onerror?: () => void;
    close = jest.fn();
    constructor(
      public url: string,
      public options?: { headers?: Record<string, string> }
    ) {
      FakeEventSource.instances.push(this);
    }
  }

  class FakeWebSocket {
    static OPEN = 1;
    static instances: FakeWebSocket[] = [];
    readyState = FakeWebSocket.OPEN;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onerror?: (error: unknown) => void;
    onclose?: () => void;
    close = jest.fn();
    send = jest.fn();
    constructor(public url: string) {
      FakeWebSocket.instances.push(this);
    }
  }

  beforeEach(() => {
    FakeEventSource.instances = [];
    FakeWebSocket.instances = [];
    Object.defineProperty(global, 'EventSource', {
      configurable: true,
      writable: true,
      value: FakeEventSource,
    });
    Object.defineProperty(global, 'WebSocket', {
      configurable: true,
      writable: true,
      value: FakeWebSocket,
    });
    global.fetch = jest.fn();
  });

  test('covers base state/message/error/connection helpers through a concrete probe', async () => {
    class Probe extends BaseTransport {
      async connect() {
        this.emitConnected();
      }
      async disconnect() {
        this.emitDisconnected();
      }
      async send(message: TransportMessage) {
        this.emitMessage(message);
      }
      fail(error: Error) {
        this.emitError(error);
      }
    }
    const probe = new Probe({ type: 'http', endpoint: 'https://probe' });
    const messages: TransportMessage[] = [];
    const errors: Error[] = [];
    probe.on('message', message => messages.push(message));
    probe.on('error', error => errors.push(error));
    expect(probe.isConnected()).toBe(false);
    await probe.connect();
    await probe.send({ type: 'notification' });
    probe.fail(new Error('probe'));
    await probe.disconnect();
    expect(messages).toHaveLength(1);
    expect(errors[0].message).toBe('probe');
    expect(probe.isConnected()).toBe(false);
  });

  test('covers SSE open/messages/parse errors/send/errors/disconnect and reconnect policy', async () => {
    jest.useFakeTimers();
    const sse = new SseTransport({
      type: 'sse',
      endpoint: 'https://sse.example/events',
      headers: { token: 'x' },
      maxReconnectAttempts: 1,
    });
    const messages: TransportMessage[] = [];
    const errors: Error[] = [];
    const reconnects: number[] = [];
    sse.on('message', message => messages.push(message));
    sse.on('error', error => errors.push(error));
    sse.on('reconnecting', attempt => reconnects.push(attempt));
    await sse.connect();
    const first = FakeEventSource.instances[0];
    // Issue #67: auth must NOT be in the URL query string (leaks to logs).
    expect(first.url).not.toContain('token=');
    expect(first.options?.headers?.token).toBe('x');
    first.onopen?.();
    expect(sse.isConnected()).toBe(true);
    first.onmessage?.({ data: JSON.stringify({ type: 'notification', method: 'ok' }) });
    first.onmessage?.({ data: '{bad' });
    first.onerror?.();
    first.onerror?.();
    expect(messages).toHaveLength(1);
    expect(reconnects).toEqual([1]);
    expect(errors.some(error => error.message.includes('Failed to parse SSE'))).toBe(true);
    expect(errors.some(error => error.message.includes('Max reconnect'))).toBe(true);
    await sse.disconnect();

    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response('', { status: 500, statusText: 'Bad' }));
    await expect(sse.send({ type: 'notification' })).resolves.toBeUndefined();
    await expect(sse.send({ type: 'notification' })).rejects.toThrow('HTTP 500: Bad');

    const noReconnect = new SseTransport({
      type: 'sse',
      endpoint: 'https://sse.example',
      reconnect: false,
    });
    await noReconnect.connect();
    FakeEventSource.instances.at(-1)?.onerror?.();
    expect((noReconnect as any).reconnectAttempts).toBe(0);
  });

  test('covers WebSocket connection, replacement, messages, send guards, errors, close, and reconnect', async () => {
    jest.useFakeTimers();
    const ws = new WebSocketTransport({
      type: 'websocket',
      endpoint: 'wss://ws.example',
      maxReconnectAttempts: 1,
    });
    const errors: Error[] = [];
    const messages: TransportMessage[] = [];
    ws.on('error', error => errors.push(error));
    ws.on('message', message => messages.push(message));
    await expect(ws.send({ type: 'request' })).rejects.toThrow('not connected');
    const connecting = ws.connect();
    const first = FakeWebSocket.instances[0];
    first.onopen?.();
    await connecting;
    first.onmessage?.({ data: JSON.stringify({ type: 'response', result: 1 }) });
    first.onmessage?.({ data: '{bad' });
    await ws.send({ type: 'request', method: 'go' });
    expect(first.send).toHaveBeenCalledWith(JSON.stringify({ type: 'request', method: 'go' }));
    first.onclose?.();
    first.onclose?.();
    expect(messages).toHaveLength(1);
    expect(errors.some(error => error.message.includes('Failed to parse WebSocket'))).toBe(true);
    expect(errors.some(error => error.message.includes('Max reconnect'))).toBe(true);
    await ws.disconnect();

    const replacing = ws.connect();
    const second = FakeWebSocket.instances.at(-1)!;
    second.onopen?.();
    await replacing;
    expect(first.close).toHaveBeenCalled();

    const rejecting = new WebSocketTransport({
      type: 'websocket',
      endpoint: 'wss://bad',
      reconnect: false,
    });
    rejecting.on('error', () => undefined);
    const rejected = rejecting.connect();
    FakeWebSocket.instances.at(-1)?.onerror?.(new Error('socket'));
    await expect(rejected).rejects.toThrow('socket');
  });

  test('covers HTTP HEAD/send success, HTTP failure, network failure, timeout defaults, and disconnect', async () => {
    const http = new HttpTransport({
      type: 'http',
      endpoint: 'https://http.example',
      headers: { token: 'x' },
      timeout: 5,
    });
    const messages: TransportMessage[] = [];
    const errors: Error[] = [];
    http.on('message', message => messages.push(message));
    http.on('error', error => errors.push(error));
    expect(http.isConnected()).toBe(true);
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ type: 'response', result: 'ok' }))
      .mockResolvedValueOnce(new Response('', { status: 503, statusText: 'Down' }))
      .mockRejectedValueOnce(new Error('offline'));
    await expect(http.connect()).resolves.toBeUndefined();
    await expect(http.send({ type: 'request' })).resolves.toBeUndefined();
    await expect(http.send({ type: 'request' })).rejects.toThrow('HTTP 503: Down');
    await expect(http.send({ type: 'request' })).rejects.toThrow('offline');
    expect(messages).toEqual([{ type: 'response', result: 'ok' }]);
    await http.disconnect();
    expect(http.isConnected()).toBe(false);

    (global.fetch as jest.Mock).mockResolvedValueOnce(new Response('', { status: 500 }));
    await expect(http.connect()).rejects.toThrow('Endpoint returned 500');
    expect(errors.some(error => error.message.includes('Failed to connect'))).toBe(true);

    const defaults = new HttpTransport({ type: 'http', endpoint: 'https://default.example' });
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse({ type: 'response' }));
    await defaults.send({ type: 'request' });
  });

  test('covers the factory, manager lifecycle, filtering, missing removal, and singleton reset', async () => {
    expect(createTransport({ type: 'sse', endpoint: 'https://sse' })).toBeInstanceOf(SseTransport);
    expect(createTransport({ type: 'websocket', endpoint: 'wss://ws' })).toBeInstanceOf(
      WebSocketTransport
    );
    expect(createTransport({ type: 'http', endpoint: 'https://http' })).toBeInstanceOf(
      HttpTransport
    );
    expect(() => createTransport({ type: 'invalid' as any, endpoint: 'x' })).toThrow(
      'Unknown transport'
    );

    const manager = new TransportManager();
    const connected = manager.register('connected', { type: 'http', endpoint: 'https://ok' });
    const disconnected = manager.register('disconnected', {
      type: 'sse',
      endpoint: 'https://sse',
      reconnect: false,
    });
    expect(manager.get('connected')).toBe(connected);
    expect(manager.get('missing')).toBeUndefined();
    jest.spyOn(connected, 'connect').mockResolvedValue();
    jest.spyOn(disconnected, 'connect').mockRejectedValue(new Error('ignored'));
    jest.spyOn(connected, 'disconnect').mockResolvedValue();
    jest.spyOn(disconnected, 'disconnect').mockRejectedValue(new Error('ignored'));
    const send = jest.spyOn(connected, 'send').mockResolvedValue();
    await manager.connectAll();
    await manager.broadcast({ type: 'notification' });
    expect(send).toHaveBeenCalled();
    await manager.remove('missing');
    await manager.remove('connected');
    expect(manager.get('connected')).toBeUndefined();
    await manager.disconnectAll();

    const singleton = getTransportManager();
    expect(getTransportManager()).toBe(singleton);
    resetTransportManager();
    expect(getTransportManager()).not.toBe(singleton);
  });
});

describe('services branch coverage: LLM optional/provider paths', () => {
  function service(config: Record<string, unknown> = {}) {
    return new LLMService({ apiKey: 'test', model: 'primary', ...config } as any);
  }

  test('covers empty chat responses, tools, optional usage fields, observers, and diagnostics cloning', async () => {
    const llm = service();
    const create = jest
      .fn()
      .mockResolvedValueOnce({ choices: [], model: undefined })
      .mockResolvedValueOnce({
        id: undefined,
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: 'call', function: { name: 'tool', arguments: '{}' } }],
            },
          },
        ],
        usage: {
          input_tokens: '10',
          output_tokens: 2,
          input_tokens_details: { cached_tokens: '3' },
        },
        total_cost: '0.5',
      });
    (llm as any).client = { chat: { completions: { create } } };
    await expect(llm.chat([{ role: 'user', content: 'empty' }])).resolves.toMatchObject({
      content: '',
      usage: undefined,
      toolCalls: undefined,
    });
    const observed: any[] = [];
    const unsubscribe = llm.subscribeUsage(event => observed.push(event));
    await expect(
      llm.chat(
        [{ role: 'user', content: 'tools' }],
        [
          {
            type: 'function',
            function: { name: 'tool', description: 'd', parameters: {} },
          },
        ]
      )
    ).resolves.toMatchObject({
      content: '',
      usage: { promptTokens: 10, completionTokens: 2, cachedPromptTokens: 3, costUsd: 0.5 },
      toolCalls: [{ id: 'call', type: 'function' }],
    });
    unsubscribe();
    expect(observed).toHaveLength(1);
    expect(create.mock.calls[1][0]).toHaveProperty('tools');
    const first = llm.getLastRequestDiagnostics();
    first.retryErrorTypes.push('rate_limit');
    expect(llm.getLastRequestDiagnostics().retryErrorTypes).not.toContain('rate_limit');
  });

  test('covers preflight allow/deny/default reason and scoped restore semantics', async () => {
    const llm = service();
    const create = jest
      .fn()
      .mockResolvedValue({ choices: [{ message: { content: 'ok' } }], model: 'primary' });
    (llm as any).client = { chat: { completions: { create } } };
    await llm.chat([{ role: 'user', content: 'no gate' }]);
    const gate = jest.fn().mockResolvedValue({ available: true });
    const restore = llm.setProviderRequestPreflight(gate);
    await llm.chat([{ role: 'user', content: 'allowed' }]);
    expect(gate).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'chat', attempt: 1, model: 'primary' })
    );
    llm.setProviderRequestPreflight(() => ({ available: false, reason: 'custom deny' }));
    restore();
    await expect(llm.chat([{ role: 'user', content: 'denied' }])).rejects.toThrow('custom deny');
    llm.setProviderRequestPreflight(() => ({ available: false }));
    await expect(llm.chat([{ role: 'user', content: 'denied' }])).rejects.toThrow(
      'token budget preflight'
    );
    expect(new ProviderRequestPreflightError('x').name).toBe('ProviderRequestPreflightError');
  });

  test('covers stream callback variants, fragmented/default tool calls, message calls, usage, and sanitization', async () => {
    const llm = service();
    const create = jest
      .fn()
      .mockResolvedValueOnce(
        asyncStream([
          {
            id: 'r1',
            model: 'stream-model',
            choices: [
              {
                delta: {
                  content: 'A',
                  tool_calls: [{ function: { name: 'first', arguments: '{"a":' } }],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  content: '',
                  tool_calls: [
                    { index: 0, id: 'real-id', function: { arguments: '1}' } },
                    { index: 1, id: 'bad', function: { name: 'bad', arguments: 'not-json' } },
                    { index: 2, id: 'empty', function: { name: 'empty', arguments: '' } },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 4, completion_tokens: 2, cost_usd: 0 },
          },
        ])
      )
      .mockResolvedValueOnce(
        asyncStream([
          {
            choices: [
              {
                delta: {},
                message: {
                  tool_calls: [
                    { index: 0, id: 'msg', function: { name: 'messageTool', arguments: '{"x":' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {},
                message: {
                  tool_calls: [
                    { index: 0, id: 'msg', function: { arguments: '2}' } },
                    { index: 1, function: { name: 'ignored', arguments: '{}' } },
                  ],
                },
              },
            ],
          },
        ])
      );
    (llm as any).client = { chat: { completions: { create } } };
    const chunks: string[] = [];
    const thinking = jest.fn();
    const first = await llm.chatStream(
      [{ role: 'user', content: 'stream' }],
      {
        onChunk: chunk => chunks.push(chunk),
        onThinking: thinking,
      },
      [{ type: 'function', function: { name: 'x', description: 'x', parameters: {} } }]
    );
    expect(first).toMatchObject({
      content: 'A',
      model: 'stream-model',
      toolCalls: [
        { id: 'real-id', function: { name: 'first', arguments: '{"a":1}' } },
        { id: 'bad', function: { arguments: '{}' } },
        { id: 'empty', function: { arguments: '{}' } },
      ],
    });
    expect(chunks).toEqual(['A']);
    expect(thinking).toHaveBeenCalled();
    expect(create.mock.calls[0][0]).toHaveProperty('tools');

    const callback = jest.fn();
    const second = await llm.chatStream([{ role: 'user', content: 'message calls' }], callback);
    expect(second.toolCalls).toEqual([
      { id: 'msg', type: 'function', function: { name: 'messageTool', arguments: '{"x":2}' } },
    ]);
    expect(callback).not.toHaveBeenCalled();
  });

  test('covers fallback/reset no-op and model/config accessors', () => {
    const noFallback = service();
    noFallback.triggerFallback();
    expect(noFallback.isUsingFallback()).toBe(false);
    const fallback = service({ fallbackModel: 'backup', timeout: 12 });
    fallback.triggerFallback();
    fallback.triggerFallback();
    expect(fallback.isUsingFallback()).toBe(true);
    fallback.resetToPrimary();
    expect(fallback.isUsingFallback()).toBe(false);
    fallback.setModel('manual');
    expect(fallback.getModel()).toBe('manual');
    expect(fallback.getConfigSummary()).toMatchObject({ model: 'manual', maxTokens: '8192' });
  });

  test('converts cache-control, assistant tool calls, and tool message IDs', () => {
    const llm = service();
    const messages: Message[] = [
      { role: 'system', content: 'cached', cacheControl: { type: 'ephemeral' } },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call',
            type: 'function',
            function: { name: 'tool', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', content: 'result', tool_call_id: 'call' },
      { role: 'user', content: 'plain' },
    ];
    const converted = (llm as any).toOpenAIMessages(messages);
    expect(converted[0].content).toEqual(
      expect.arrayContaining([expect.objectContaining({ cache_control: { type: 'ephemeral' } })])
    );
    expect(converted[1]).toHaveProperty('tool_calls');
    expect(converted[2]).toHaveProperty('tool_call_id', 'call');
    expect(converted[3]).toEqual({ role: 'user', content: 'plain' });
  });
});
