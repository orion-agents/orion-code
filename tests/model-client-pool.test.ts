/**
 * v0.2.26 — ModelClientPool unit tests.
 */

import { ModelClientPool } from '../src/services/model-client-pool';
import type { ProviderConfig } from '../src/services/model-registry';

describe('ModelClientPool', () => {
  let pool: ModelClientPool;

  beforeEach(() => {
    pool = new ModelClientPool();
  });

  it('starts with size 0', () => {
    expect(pool.size).toBe(0);
  });

  it('creates a client on first get', () => {
    const provider: ProviderConfig = {
      id: 'test',
      baseUrl: 'https://test.example.com/v1',
      apiKey: 'sk-test123',
      protocol: 'openai-completions',
    };
    const client = pool.getClient(provider);
    expect(client).toBeDefined();
    expect(pool.size).toBe(1);
  });

  it('returns cached client on second get', () => {
    const provider: ProviderConfig = {
      id: 'test',
      baseUrl: 'https://test.example.com/v1',
      apiKey: 'sk-test123',
      protocol: 'openai-completions',
    };
    const client1 = pool.getClient(provider);
    const client2 = pool.getClient(provider);
    expect(client1).toBe(client2);
    expect(pool.size).toBe(1);
  });

  it('resolves env var keys', () => {
    process.env.TEST_API_KEY = 'env-key-value';
    try {
      const provider: ProviderConfig = {
        id: 'test',
        baseUrl: 'https://test.example.com/v1',
        apiKey: '$TEST_API_KEY',
        protocol: 'openai-completions',
      };
      const client = pool.getClient(provider);
      expect(client).toBeDefined();
    } finally {
      delete process.env.TEST_API_KEY;
    }
  });

  it('invalidate removes a cached client', () => {
    const provider: ProviderConfig = {
      id: 'test',
      baseUrl: 'https://test.example.com/v1',
      apiKey: 'sk-test123',
      protocol: 'openai-completions',
    };
    pool.getClient(provider);
    expect(pool.size).toBe(1);
    pool.invalidate('test');
    expect(pool.size).toBe(0);
  });

  it('clear removes all clients', () => {
    const p1: ProviderConfig = { id: 'a', baseUrl: 'https://a.example.com/v1', apiKey: 'sk-a', protocol: 'openai-completions' };
    const p2: ProviderConfig = { id: 'b', baseUrl: 'https://b.example.com/v1', apiKey: 'sk-b', protocol: 'openai-completions' };
    pool.getClient(p1);
    pool.getClient(p2);
    expect(pool.size).toBe(2);
    pool.clear();
    expect(pool.size).toBe(0);
  });
});