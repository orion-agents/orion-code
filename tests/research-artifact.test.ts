/**
 * P1-R5 tests: CAS/lock, scope isolation, resume (no replay), corrupt/old-schema
 * fail-closed, and active-Goal overwrite rejection (v0.1.4).
 */

import {
  artifactHistory,
  CasMismatchError,
  createMemoryArtifactStore,
  loadResearchPacket,
  resumeResearchState,
  saveResearchPacket,
  scopeKey,
  UnsupportedSchemaError,
} from '../src/runtime/subagents/research-artifact';
import type { ResearchPacket } from '../src/runtime/subagents/research-types';
import { RESEARCH_SCHEMA_VERSION } from '../src/runtime/subagents/research-types';

function basePacket(over: Partial<ResearchPacket> = {}): ResearchPacket {
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    packetId: 'pkt-1',
    projectPath: '/proj',
    sessionId: 'sess-1',
    request: { schemaVersion: RESEARCH_SCHEMA_VERSION, objective: 'o', scope: { projectRoot: '/proj' }, mode: 'local', maxSources: 50, maxFetchBytes: 0, maxDurationMs: 1000 },
    summary: 'summary',
    claims: [],
    sources: [{ id: 's1', kind: 'file', provider: 'local', retrievedAt: '2026-08-05T00:00:00.000Z', status: 'retrieved' }],
    gaps: [],
    risks: [],
    usage: { modelRequests: 1, toolCalls: 0, promptTokens: 0, completionTokens: 0, durationMs: 0, usageComplete: true },
    createdAt: '2026-08-05T00:00:00.000Z',
    ...over,
  };
}

describe('P1-R5 research artifact / resume / Goal', () => {
  it('saves atomically and round-trips with a version + CAS token', () => {
    const store = createMemoryArtifactStore();
    const pkt = basePacket();
    const r1 = saveResearchPacket(store, pkt, { projectPath: '/proj', sessionId: 's1' }, { now: () => new Date(0) });
    expect(r1.version).toBe(1);

    const loaded = loadResearchPacket(store, { projectPath: '/proj', sessionId: 's1' });
    expect(loaded?.packetId).toBe('pkt-1');

    // Update with the correct token.
    const pkt2 = basePacket({ summary: 'updated' });
    const r2 = saveResearchPacket(store, pkt2, { projectPath: '/proj', sessionId: 's1' }, { expectedToken: r1.casToken });
    expect(r2.version).toBe(2);
    expect(artifactHistory(store, { projectPath: '/proj', sessionId: 's1' })).toContain(r1.casToken);
  });

  it('rejects a CAS mismatch (concurrent / lost-update)', () => {
    const store = createMemoryArtifactStore();
    const r1 = saveResearchPacket(store, basePacket(), { projectPath: '/proj', sessionId: 's1' });
    expect(() =>
      saveResearchPacket(store, basePacket({ summary: 'stale' }), { projectPath: '/proj', sessionId: 's1' }, { expectedToken: 'wrong-token' }),
    ).toThrow(CasMismatchError);
    // The stale write did not land.
    expect(loadResearchPacket(store, { projectPath: '/proj', sessionId: 's1' })?.summary).toBe('summary');
    expect(r1.version).toBe(1);
  });

  it('isolates packets by project/session scope', () => {
    const store = createMemoryArtifactStore();
    saveResearchPacket(store, basePacket({ packetId: 'A' }), { projectPath: '/proj', sessionId: 's1' });
    saveResearchPacket(store, basePacket({ packetId: 'B' }), { projectPath: '/proj', sessionId: 's2' });
    saveResearchPacket(store, basePacket({ packetId: 'C' }), { projectPath: '/other', sessionId: 's1' });

    expect(loadResearchPacket(store, { projectPath: '/proj', sessionId: 's1' })?.packetId).toBe('A');
    expect(loadResearchPacket(store, { projectPath: '/proj', sessionId: 's2' })?.packetId).toBe('B');
    expect(loadResearchPacket(store, { projectPath: '/other', sessionId: 's1' })?.packetId).toBe('C');
    expect(scopeKey({ projectPath: '/proj', sessionId: 's1' })).not.toBe(scopeKey({ projectPath: '/proj', sessionId: 's2' }));
  });

  it('rejects an active-Goal overwrite without the current token', () => {
    const store = createMemoryArtifactStore();
    const r1 = saveResearchPacket(store, basePacket(), { projectPath: '/proj', sessionId: 's1', goalId: 'G1' });
    // No expectedToken on a goal-scoped packet -> must be an explicit resume.
    expect(() =>
      saveResearchPacket(store, basePacket({ summary: 'overwrite' }), { projectPath: '/proj', sessionId: 's1', goalId: 'G1' }),
    ).toThrow(CasMismatchError);
    // With the token it succeeds (resume path).
    const r2 = saveResearchPacket(store, basePacket({ summary: 'resumed' }), { projectPath: '/proj', sessionId: 's1', goalId: 'G1' }, { expectedToken: r1.casToken });
    expect(r2.version).toBe(2);
  });

  it('resumes to completed/partial/failed WITHOUT external replay', () => {
    const ok = basePacket();
    expect(resumeResearchState(ok)).toBe('completed');

    const partial = basePacket({ sources: [{ id: 's1', kind: 'web_page', status: 'failed', provider: 'ddg', retrievedAt: '2026-08-05T00:00:00.000Z', canonicalUrl: 'https://x' }] });
    expect(resumeResearchState(partial)).toBe('partial');

    const failed = basePacket({ sources: [] });
    expect(resumeResearchState(failed)).toBe('failed');
  });

  it('fails closed on old/unsupported schema (never silently migrates)', () => {
    const store = createMemoryArtifactStore();
    const old = basePacket({ schemaVersion: 999 as unknown as number });
    saveResearchPacket(store, old, { projectPath: '/proj', sessionId: 's1' });
    expect(() => loadResearchPacket(store, { projectPath: '/proj', sessionId: 's1' })).toThrow(UnsupportedSchemaError);
    // The record is preserved for traceability despite the load failure.
    expect(store.read(scopeKey({ projectPath: '/proj', sessionId: 's1' }))?.packet.schemaVersion).toBe(999);
  });
});
