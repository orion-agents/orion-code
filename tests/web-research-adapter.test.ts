/**
 * P0-R2 tests for the web research adapter (v0.1.4).
 *
 * All network is mocked via injected `search` / `fetch` deps; the real SSRF
 * lexical guard (isUrlSafeForSSRF) and the domain allowlist are exercised for
 * real. Focus: security-gate failures become blocked/failed sources and never
 * masquerade as retrieved hits, and budgets are enforced.
 */

import {
  runWebResearch,
  type RawSearchResult,
  type RawFetchResult,
  type WebResearchDeps,
} from '../src/runtime/subagents/web-research-adapter';
import { createLocalResearchRequest } from '../src/runtime/subagents/research-contract';
import { type ResearchRequest } from '../src/runtime/subagents/research-types';

function okHit(url: string, provider = 'websearch-mcp', rank = 0): RawSearchResult {
  return { query: 'q', provider, title: `Title ${rank}`, url, snippet: 'snippet', status: 'ok' };
}

function okFetch(url: string, content = 'body', bytes = 10): RawFetchResult {
  return { url, status: 'ok', content, finalUrl: url, bytes };
}

function webRequest(overrides: Partial<ResearchRequest> = {}): ResearchRequest {
  return {
    ...createLocalResearchRequest('how does X work', '/proj', { mode: 'web' }),
    ...overrides,
  };
}

describe('P0-R2 web research adapter', () => {
  it('runs search -> select -> fetch -> hash on a clean mixed pass', async () => {
    const deps: WebResearchDeps = {
      allowedDomains: ['example.com'],
      search: async () => [okHit('https://example.com/a'), okHit('https://example.com/b')],
      fetch: async url => okFetch(url, `content for ${url}`),
    };
    const res = await runWebResearch(webRequest(), deps);

    expect(res.sources).toHaveLength(2);
    expect(res.sources.every(s => s.status === 'retrieved')).toBe(true);
    expect(res.sources[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.sources[0].canonicalUrl).toBe('https://example.com/a');
    expect(res.blocked).toHaveLength(0);
    expect(res.provider).toBe('websearch-mcp');
  });

  it('blocks SSRF-bait URLs instead of fetching them', async () => {
    const fetched: string[] = [];
    const deps: WebResearchDeps = {
      search: async () => [okHit('http://169.254.169.254/latest/meta-data/')],
      fetch: async url => {
        fetched.push(url);
        return okFetch(url);
      },
    };
    const res = await runWebResearch(webRequest(), deps);

    expect(fetched).toHaveLength(0); // never fetched
    expect(res.blocked).toContain('http://169.254.169.254/latest/meta-data/');
    expect(res.sources).toHaveLength(1);
    expect(res.sources[0].status).toBe('blocked');
    expect(res.sources[0].failureReason).toMatch(/SSRF|Blocked|internal/i);
    expect(res.sources[0].contentHash).toBeUndefined();
  });

  it('blocks URLs outside the domain allowlist', async () => {
    const fetched: string[] = [];
    const deps: WebResearchDeps = {
      allowedDomains: ['example.com'],
      search: async () => [okHit('https://evil.example.net/x')],
      fetch: async url => {
        fetched.push(url);
        return okFetch(url);
      },
    };
    const res = await runWebResearch(
      webRequest({ scope: { projectRoot: '/proj', domains: ['example.com'] } }),
      deps
    );

    expect(fetched).toHaveLength(0);
    expect(res.blocked).toContain('https://evil.example.net/x');
    expect(res.sources[0].status).toBe('blocked');
    expect(res.sources[0].failureReason).toMatch(/allowlist/i);
  });

  it('caps fetched sources at maxSources and skips the rest', async () => {
    const fetched: string[] = [];
    const deps: WebResearchDeps = {
      search: async () => Array.from({ length: 5 }, (_, i) => okHit(`https://example.com/${i}`)),
      fetch: async url => {
        fetched.push(url);
        return okFetch(url);
      },
    };
    const res = await runWebResearch(webRequest({ maxSources: 2 }), deps);

    expect(fetched).toHaveLength(2);
    expect(res.sources.filter(s => s.status === 'retrieved')).toHaveLength(2);
    // Hits beyond maxSources are never selected, so the packet carries exactly 2.
    expect(res.sources).toHaveLength(2);
    expect(res.skipped).toHaveLength(0);
  });

  it('counts blocked search hits against maxSources', async () => {
    const fetched: string[] = [];
    const deps: WebResearchDeps = {
      search: async () => [
        { ...okHit('http://169.254.169.254/one'), title: 'blocked-1' },
        { ...okHit('http://169.254.169.254/two'), title: 'blocked-2' },
        okHit('https://example.com/allowed'),
      ],
      fetch: async url => {
        fetched.push(url);
        return okFetch(url);
      },
    };
    const res = await runWebResearch(webRequest({ maxSources: 2 }), deps);

    expect(fetched).toHaveLength(0);
    expect(res.sources).toHaveLength(2);
    expect(res.sources.every(source => source.status === 'blocked')).toBe(true);
  });

  it('stops fetching once the byte budget is exhausted', async () => {
    const fetched: string[] = [];
    const deps: WebResearchDeps = {
      search: async () => Array.from({ length: 3 }, (_, i) => okHit(`https://example.com/${i}`)),
      fetch: async url => {
        fetched.push(url);
        return okFetch(url, 'x', 100);
      },
    };
    const res = await runWebResearch(webRequest({ maxSources: 3, maxFetchBytes: 150 }), deps);

    expect(fetched).toHaveLength(2); // 100 + 100 = 200 > 150 after second fetch
    expect(res.truncatedDueToBytes).toBe(true);
    expect(res.bytesFetched).toBe(200);
    expect(res.skipped).toContain('https://example.com/2');
  });

  it('aborts remaining fetches after the duration budget elapses', async () => {
    let clock = 0;
    const now = () => new Date(clock);
    const fetched: string[] = [];
    const deps: WebResearchDeps = {
      search: async () => Array.from({ length: 3 }, (_, i) => okHit(`https://example.com/${i}`)),
      fetch: async url => {
        fetched.push(url);
        clock += 10_000; // advance past a 5s budget after the first fetch
        return okFetch(url);
      },
      now,
    };
    const res = await runWebResearch(webRequest({ maxSources: 3, maxDurationMs: 5_000 }), deps);

    expect(fetched).toHaveLength(1);
    expect(res.timedOut).toBe(true);
    expect(res.skipped).toContain('https://example.com/1');
  });

  it('records a fetch failure as failed, never as a retrieved hit', async () => {
    const deps: WebResearchDeps = {
      search: async () => [okHit('https://example.com/a')],
      fetch: async () => ({
        url: 'https://example.com/a',
        status: 'error',
        failureReason: 'HTTP 503',
      }),
    };
    const res = await runWebResearch(webRequest(), deps);

    expect(res.sources).toHaveLength(1);
    expect(res.sources[0].status).toBe('failed');
    expect(res.sources[0].failureReason).toBe('HTTP 503');
    expect(res.sources[0].contentHash).toBeUndefined();
  });

  it('preserves source status across provider fallback (never downgrades)', async () => {
    // Simulate the search dep falling back provider A->B internally; the adapter
    // must record whatever the search returned and not rewrite a blocked hit.
    const deps: WebResearchDeps = {
      search: async () => [
        { ...okHit('https://example.com/ok'), provider: 'ddg' },
        {
          query: 'q',
          provider: 'tavily',
          title: 'Blocked',
          url: 'https://internal.example.com/x',
          status: 'blocked',
          failureReason: 'provider refused',
        },
      ],
      fetch: async url => okFetch(url),
    };
    const res = await runWebResearch(webRequest(), deps);

    // Provider recorded is the successful one; the blocked hit stays blocked.
    expect(res.provider).toBe('ddg');
    const blocked = res.sources.find(s => s.status === 'blocked');
    expect(blocked).toBeDefined();
    expect(blocked?.failureReason).toBe('provider refused');
    const retrieved = res.sources.find(s => s.status === 'retrieved');
    expect(retrieved?.provider).toBe('ddg');
  });

  it('skips web research entirely for local mode', async () => {
    const called = { search: false, fetch: false };
    const deps: WebResearchDeps = {
      search: async () => {
        called.search = true;
        return [];
      },
      fetch: async () => {
        called.fetch = true;
        return okFetch('https://example.com/a');
      },
    };
    const res = await runWebResearch({ ...webRequest(), mode: 'local' }, deps);

    expect(called.search).toBe(false);
    expect(called.fetch).toBe(false);
    expect(res.sources).toHaveLength(0);
    expect(res.notes.some(n => n.includes('local'))).toBe(true);
  });
});

/**
 * The failure side of the adapter: dependency crashes and secret hygiene. A
 * regression here is the dangerous kind - it turns a blocked or failed source
 * into something that reads as retrieved, or leaks a credential into evidence.
 */
describe('P0-R2 web research adapter resilience and redaction', () => {
  it('redacts secret query params from every URL field that leaves the module', async () => {
    // canonicalUrl is what the renderer projects and what the packet persists,
    // so redacting only displayUrl would leak the credential into evidence.
    const secretUrl = 'https://example.com/doc?api_key=SECRET123&access_token=T0KEN&page=2';
    const deps: WebResearchDeps = {
      allowedDomains: ['example.com'],
      search: async () => [okHit(secretUrl)],
      fetch: async url => okFetch(url),
    };
    const res = await runWebResearch(webRequest(), deps);

    const source = res.sources[0];
    expect(source.status).toBe('retrieved');
    for (const field of [source.canonicalUrl, source.displayUrl]) {
      expect(field).not.toContain('SECRET123');
      expect(field).not.toContain('T0KEN');
      // Ordinary params survive so the citation still points at the right page.
      expect(field).toContain('page=2');
    }
    // The redaction is auditable rather than silent.
    expect(source.redactions).toEqual(expect.arrayContaining(['api_key', 'access_token']));
  });

  it('redacts credentials introduced by a redirect and hashes the safe URL', async () => {
    const deps: WebResearchDeps = {
      allowedDomains: ['example.com'],
      search: async () => [okHit('https://example.com/start')],
      fetch: async () => ({
        url: 'https://example.com/start',
        status: 'ok',
        content: 'body',
        finalUrl: 'https://example.com/final?token=REDIRECTSECRET',
        bytes: 4,
      }),
    };
    const res = await runWebResearch(webRequest(), deps);

    const source = res.sources[0];
    expect(source.canonicalUrl).not.toContain('REDIRECTSECRET');
    expect(source.displayUrl).not.toContain('REDIRECTSECRET');
    expect(source.redactions).toContain('token');
    expect(source.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps clean URLs byte-identical so redaction never moves the content hash', async () => {
    const clean = 'https://example.com/doc?page=2';
    const deps: WebResearchDeps = {
      allowedDomains: ['example.com'],
      search: async () => [okHit(clean)],
      fetch: async url => okFetch(url),
    };
    const res = await runWebResearch(webRequest(), deps);

    const source = res.sources[0];
    expect(source.displayUrl).toBe(clean);
    expect(source.canonicalUrl).toBe(clean);
    // No redaction happened, so no audit entry is fabricated.
    expect(source.redactions).toBeUndefined();
  });

  it('redacts URLs recorded in the blocked and skipped diagnostics', async () => {
    const deps: WebResearchDeps = {
      allowedDomains: ['example.com'],
      search: async () => [
        okHit('https://evil.example.net/x?api_key=BLOCKEDSECRET'),
        okHit('https://example.com/a'),
        okHit('https://example.com/b?token=SKIPPEDSECRET'),
      ],
      fetch: async url => okFetch(url, 'x', 100),
    };
    const res = await runWebResearch(webRequest({ maxSources: 3, maxFetchBytes: 50 }), deps);

    expect(res.blocked.join(' ')).not.toContain('BLOCKEDSECRET');
    expect(res.skipped.join(' ')).not.toContain('SKIPPEDSECRET');
    // The diagnostics still identify which URL was rejected/skipped.
    expect(res.blocked.some(u => u.includes('evil.example.net'))).toBe(true);
    expect(res.skipped.some(u => u.includes('/b'))).toBe(true);
  });

  it('degrades to an empty noted result when the search dependency throws', async () => {
    const deps: WebResearchDeps = {
      search: async () => {
        throw new Error('search mcp offline');
      },
      fetch: async () => {
        throw new Error('fetch must not run');
      },
    };
    const res = await runWebResearch(webRequest(), deps);

    expect(res.sources).toHaveLength(0);
    expect(res.blocked).toHaveLength(0);
    expect(res.notes.some(n => n.includes('search dependency threw: search mcp offline'))).toBe(
      true
    );
  });

  it('records a thrown fetch as a failed source rather than propagating', async () => {
    const deps: WebResearchDeps = {
      allowedDomains: ['example.com'],
      search: async () => [okHit('https://example.com/a')],
      fetch: async () => {
        throw new Error('socket hang up');
      },
    };
    const res = await runWebResearch(webRequest(), deps);

    expect(res.sources).toHaveLength(1);
    expect(res.sources[0].status).toBe('failed');
    expect(res.sources[0].failureReason).toContain('fetch threw: socket hang up');
    expect(res.sources[0].contentHash).toBeUndefined();
  });
});
