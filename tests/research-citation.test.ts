/**
 * P0-R3 tests: citation binding, dedupe/stale, conflict, verification,
 * evidence-candidate separation, and completion audit (v0.1.4).
 */

import { resolveCitations, urlKey } from '../src/runtime/subagents/research-citation';
import type {
  ResearchClaim,
  ResearchPacket,
  ResearchSource,
} from '../src/runtime/subagents/research-types';
import { RESEARCH_SCHEMA_VERSION } from '../src/runtime/subagents/research-types';

function src(id: string, over: Partial<ResearchSource> = {}): ResearchSource {
  return {
    id,
    kind: 'file',
    provider: 'local',
    retrievedAt: '2026-08-05T00:00:00.000Z',
    status: 'retrieved',
    ...over,
  };
}

function claim(id: string, over: Partial<ResearchClaim> = {}): ResearchClaim {
  return {
    id,
    text: `claim ${id}`,
    sourceIds: [],
    evidenceKind: 'file',
    verification: 'unverified',
    ...over,
  };
}

function packet(claims: ResearchClaim[], sources: ResearchSource[]): ResearchPacket {
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    packetId: 'pkt-1',
    projectPath: '/proj',
    sessionId: 'sess-1',
    request: {
      schemaVersion: RESEARCH_SCHEMA_VERSION,
      objective: 'o',
      scope: { projectRoot: '/proj' },
      mode: 'local',
      maxSources: 50,
      maxFetchBytes: 0,
      maxDurationMs: 1000,
    },
    summary: 'summary',
    claims,
    sources,
    gaps: [],
    risks: [],
    usage: {
      modelRequests: 1,
      toolCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      durationMs: 0,
      usageComplete: true,
    },
    createdAt: '2026-08-05T00:00:00.000Z',
  };
}

describe('P0-R3 citation / conflict / evidence', () => {
  it('urlKey normalizes fragment and trailing slash', () => {
    expect(urlKey('https://example.com/a/')).toBe('https://example.com/a');
    expect(urlKey('https://Example.com/a#frag')).toBe('https://example.com/a');
    expect(urlKey(undefined)).toBe('');
  });

  it('binds an observed file claim and emits an execution evidence candidate', () => {
    const s = src('src-1', { kind: 'file', projectPath: 'a.ts' });
    const c = claim('clm-1', { sourceIds: ['src-1'], evidenceKind: 'file' });
    const res = resolveCitations(packet([c], [s]));

    const b = res.bindings.find(b => b.claimId === 'clm-1')!;
    expect(b.status).toBe('bound');
    expect(b.sourceIds).toEqual(['src-1']);
    expect(res.evidenceCandidates).toHaveLength(1);
    expect(res.evidenceCandidates[0]).toMatchObject({ kind: 'execution', basis: 'file' });
    expect(res.audit.status).toBe('met');
  });

  it('flags a dangling binding and downgrades to unverified', () => {
    const c = claim('clm-1', { sourceIds: ['ghost'], evidenceKind: 'file' });
    const res = resolveCitations(packet([c], []));

    const b = res.bindings[0];
    expect(b.status).toBe('dangling');
    expect(c.verification).toBe('unverified');
    expect(res.evidenceCandidates).toHaveLength(0);
    expect(res.audit.unverifiedClaimIds).toContain('clm-1');
  });

  it('dedupes same-URL multi-version and marks the older revision stale', () => {
    const older = src('src-old', {
      canonicalUrl: 'https://example.com/doc',
      contentHash: 'hash-a',
      retrievedAt: '2026-08-05T00:00:00.000Z',
      kind: 'web_page',
    });
    const newer = src('src-new', {
      canonicalUrl: 'https://example.com/doc',
      contentHash: 'hash-b',
      retrievedAt: '2026-08-05T01:00:00.000Z',
      kind: 'web_page',
    });
    const c = claim('clm-1', { sourceIds: ['src-old', 'src-new'], evidenceKind: 'external' });
    const res = resolveCitations(packet([c], [older, newer]));

    expect(res.staleSourceIds).toContain('src-old');
    const olderSrc = res ? older : older;
    expect(olderSrc.status).toBe('stale');
    // active binding keeps only the non-stale source
    const b = res.bindings[0];
    expect(b.sourceIds).toEqual(['src-new']);
  });

  it('records a conflict (retrieved + failed) and never emits an evidence candidate', () => {
    const ok = src('src-ok', { kind: 'web_page', canonicalUrl: 'https://example.com/x' });
    const bad = src('src-bad', { kind: 'web_page', status: 'failed', canonicalUrl: 'https://example.com/y' });
    const c = claim('clm-1', { sourceIds: ['src-ok', 'src-bad'], evidenceKind: 'external' });
    const res = resolveCitations(packet([c], [ok, bad]));

    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0].claimId).toBe('clm-1');
    expect(c.verification).toBe('contradicted');
    expect(res.evidenceCandidates).toHaveLength(0);
  });

  it('separates research evidence (web) from execution evidence (file)', () => {
    const fileSrc = src('src-f', { kind: 'file', projectPath: 'a.ts' });
    const webSrc = src('src-w', { kind: 'web_page', canonicalUrl: 'https://example.com/x', contentHash: 'h' });
    const fileClaim = claim('clm-f', { sourceIds: ['src-f'], evidenceKind: 'file' });
    const webClaim = claim('clm-w', { sourceIds: ['src-w'], evidenceKind: 'external' });
    const res = resolveCitations(packet([fileClaim, webClaim], [fileSrc, webSrc]));

    const exec = res.evidenceCandidates.find(e => e.claimId === 'clm-f')!;
    const research = res.evidenceCandidates.find(e => e.claimId === 'clm-w')!;
    expect(exec.kind).toBe('execution');
    expect(research.kind).toBe('research');
  });

  it('keeps completion audit partial for claims with sources but no independent verification', () => {
    const s = src('src-1', { kind: 'web_page', status: 'blocked', canonicalUrl: 'https://example.com/x' });
    const c = claim('clm-1', { sourceIds: ['src-1'], evidenceKind: 'external' });
    const res = resolveCitations(packet([c], [s]));

    // A blocked source is not 'retrieved', so verification stays unverified.
    expect(c.verification).toBe('unverified');
    expect(res.audit.status).toBe('partial');
    expect(res.audit.unverifiedClaimIds).toContain('clm-1');
  });

  it('never turns an inference claim into an evidence candidate', () => {
    const s = src('src-1', { kind: 'file', projectPath: 'a.ts' });
    const c = claim('clm-1', { sourceIds: ['src-1'], evidenceKind: 'inference' });
    const res = resolveCitations(packet([c], [s]));

    expect(c.verification).toBe('unverified');
    expect(res.evidenceCandidates).toHaveLength(0);
  });
});
