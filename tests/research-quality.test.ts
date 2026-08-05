/**
 * P1-R6 tests: explainable source ranking (never truth), cost diagnostics, and
 * structured recovery hints (v0.1.4).
 */

import { rankSources, researchCostSummary, recoveryHint } from '../src/runtime/subagents/research-quality';
import type { ResearchPacket, ResearchSource } from '../src/runtime/subagents/research-types';
import { RESEARCH_SCHEMA_VERSION } from '../src/runtime/subagents/research-types';

function src(id: string, over: Partial<ResearchSource> = {}): ResearchSource {
  return {
    id,
    kind: 'web_page',
    provider: 'ddg',
    retrievedAt: '2026-08-05T00:00:00.000Z',
    status: 'retrieved',
    ...over,
  };
}

function packet(over: Partial<ResearchPacket> = {}): ResearchPacket {
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    packetId: 'pkt-1',
    projectPath: '/proj',
    sessionId: 's1',
    request: { schemaVersion: RESEARCH_SCHEMA_VERSION, objective: 'o', scope: { projectRoot: '/proj' }, mode: 'web', maxSources: 50, maxFetchBytes: 1000, maxDurationMs: 1000 },
    summary: 's',
    claims: [],
    sources: [],
    gaps: [],
    risks: [],
    usage: { modelRequests: 2, toolCalls: 3, durationMs: 421, promptTokens: 0, completionTokens: 0, usageComplete: true },
    createdAt: '2026-08-05T00:00:00.000Z',
    ...over,
  };
}

describe('P1-R6 research quality / cost / recovery', () => {
  it('ranks with explainable reasons and demotes stale revisions', () => {
    const fresh = src('s-fresh', { retrievedAt: '2026-08-05T00:00:00.000Z' });
    const stale = src('s-stale', { status: 'stale', retrievedAt: '2026-07-01T00:00:00.000Z' });
    const blocked = src('s-blocked', { status: 'blocked', retrievedAt: '2026-08-05T00:00:00.000Z' });

    const ranked = rankSources([stale, fresh, blocked], { now: new Date('2026-08-05T12:00:00.000Z') });
    // Every entry must carry human-readable reasons (explainable, not opaque).
    expect(ranked.every(r => r.reasons.length > 0)).toBe(true);
    // Fresh available source ranks above the stale and blocked ones.
    const order = ranked.map(r => r.sourceId);
    expect(order.indexOf('s-fresh')).toBeLessThan(order.indexOf('s-stale'));
    expect(order.indexOf('s-fresh')).toBeLessThan(order.indexOf('s-blocked'));
    const staleEntry = ranked.find(r => r.sourceId === 's-stale')!;
    expect(staleEntry.reasons).toContain('stale revision (demoted)');
  });

  it('prefers scope-matching and preferred-provider sources without asserting truth', () => {
    const inScope = src('s-in', { canonicalUrl: 'https://example.com/x', provider: 'tavily' });
    const other = src('s-out', { canonicalUrl: 'https://elsewhere.com/y', provider: 'ddg' });
    const ranked = rankSources([other, inScope], {
      preferredProviders: ['tavily'],
      scope: { projectRoot: '/proj', domains: ['example.com'] },
    });
    expect(ranked[0].sourceId).toBe('s-in');
    expect(ranked[0].reasons).toContain('matches scope domain');
    expect(ranked[0].reasons).toContain('preferred provider (tavily)');
  });

  it('summarizes cost and flags budget overruns', () => {
    const pkt = packet({
      sources: [src('a'), src('b', { status: 'blocked' })],
      request: { schemaVersion: RESEARCH_SCHEMA_VERSION, objective: 'o', scope: { projectRoot: '/proj' }, mode: 'web', maxSources: 1, maxFetchBytes: 1000, maxDurationMs: 1000 },
    });
    const summary = researchCostSummary(pkt, { fetchedBytes: 5000 });
    expect(summary.modelRequests).toBe(2);
    expect(summary.retrievedCount).toBe(1);
    expect(summary.notes.some(n => n.includes('source count exceeded'))).toBe(true);
    expect(summary.notes.some(n => n.includes('fetched bytes'))).toBe(true);
  });

  it('maps structured failure reasons to recovery hints (no generic MCP / write path)', () => {
    expect(recoveryHint('SSRF blocked')).toMatch(/allowlisted/i);
    expect(recoveryHint('DNS lookup failed')).toMatch(/DNS/i);
    expect(recoveryHint('Response too large: Content-Length')).toMatch(/maxFetchBytes/i);
    expect(recoveryHint('WEBSEARCH_UNAVAILABLE')).toMatch(/no generic MCP/i);
    const generic = recoveryHint(undefined);
    expect(generic).toBeTruthy();
  });
});
