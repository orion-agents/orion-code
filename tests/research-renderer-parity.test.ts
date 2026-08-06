/**
 * P1-R4 tests: the same packet+resolution yields a consistent view and conclusion
 * across TUI / terminal-ui / Print / JSON, plus a unified lifecycle event stream.
 */

import { buildResearchView, renderResearch, toLifecycleEvents } from '../src/runtime/subagents/research-renderer';
import { resolveCitations } from '../src/runtime/subagents/research-citation';
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
  return { id, text: `claim ${id}`, sourceIds: [], evidenceKind: 'file', verification: 'unverified', ...over };
}

function packet(claims: ResearchClaim[], sources: ResearchSource[]): ResearchPacket {
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    packetId: 'pkt-1',
    projectPath: '/proj',
    sessionId: 'sess-1',
    request: { schemaVersion: RESEARCH_SCHEMA_VERSION, objective: 'o', scope: { projectRoot: '/proj' }, mode: 'local', maxSources: 50, maxFetchBytes: 0, maxDurationMs: 1000 },
    summary: 'summary',
    claims,
    sources,
    gaps: [],
    risks: [],
    usage: { modelRequests: 1, toolCalls: 0, promptTokens: 0, completionTokens: 0, durationMs: 0, usageComplete: true },
    createdAt: '2026-08-05T00:00:00.000Z',
  };
}

describe('P1-R4 research renderer parity', () => {
  it('keeps conclusion + counts identical across tui/terminal/print/json', () => {
    const s = src('src-1', { kind: 'file', projectPath: 'a.ts' });
    const c = claim('clm-1', { sourceIds: ['src-1'], evidenceKind: 'file' });
    const pkt = packet([c], [s]);
    const resolution = resolveCitations(pkt);
    const view = buildResearchView(pkt, resolution);

    const tui = renderResearch(view, 'tui');
    const terminal = renderResearch(view, 'terminal');
    const print = renderResearch(view, 'print');
    const json = renderResearch(view, 'json');

    // Every mode must carry the same conclusion and the same source count.
    for (const out of [tui, terminal, print]) {
      expect(out).toContain(view.conclusion);
    }
    expect(tui).toContain(`Sources: ${view.sourceCount}`);
    expect(print).toContain(`Sources: ${view.sourceCount}`);
    expect(terminal).toContain(`sources (${view.sourceCount}):`);
    const parsed = JSON.parse(json);
    expect(parsed.conclusion).toBe(view.conclusion);
    expect(parsed.sourceCount).toBe(view.sourceCount);
    expect(parsed.auditStatus).toBe('met');
  });

  it('emits a unified lifecycle event stream with start/source/conflict/completed', () => {
    const ok = src('src-ok', { kind: 'web_page', canonicalUrl: 'https://example.com/x' });
    const bad = src('src-bad', { kind: 'web_page', status: 'failed', canonicalUrl: 'https://example.com/y' });
    const c = claim('clm-1', { sourceIds: ['src-ok', 'src-bad'], evidenceKind: 'external' });
    const pkt = packet([c], [ok, bad]);
    const resolution = resolveCitations(pkt);
    const view = buildResearchView(pkt, resolution);
    const events = toLifecycleEvents(view, resolution);

    expect(events[0].type).toBe('research_started');
    expect(events.filter(e => e.type === 'research_source')).toHaveLength(2);
    expect(events.filter(e => e.type === 'research_conflict')).toHaveLength(1);
    const done = events[events.length - 1] as Extract<typeof events[number], { type: 'research_completed' }>;
    expect(done.type).toBe('research_completed');
    expect(done.stage).toBe('partial');
    expect(done.auditStatus).toBe('partial');
  });

  it('parity holds for a mixed-mode packet with stale + blocked sources', () => {
    const older = src('src-old', { kind: 'web_page', canonicalUrl: 'https://example.com/d', contentHash: 'a', retrievedAt: '2026-08-05T00:00:00.000Z' });
    const newer = src('src-new', { kind: 'web_page', canonicalUrl: 'https://example.com/d', contentHash: 'b', retrievedAt: '2026-08-05T01:00:00.000Z' });
    const blocked = src('src-blk', { kind: 'web_page', status: 'blocked', canonicalUrl: 'https://internal/x', failureReason: 'SSRF' });
    const c1 = claim('clm-1', { sourceIds: ['src-old', 'src-new'], evidenceKind: 'external' });
    const c2 = claim('clm-2', { sourceIds: ['src-blk'], evidenceKind: 'external' });
    const pkt = packet([c1, c2], [older, newer, blocked]);
    pkt.request.mode = 'mixed';
    const resolution = resolveCitations(pkt);
    const view = buildResearchView(pkt, resolution);

    const tui = renderResearch(view, 'tui');
    const json = JSON.parse(renderResearch(view, 'json'));
    expect(json.sourceCount).toBe(3);
    expect(json.staleCount).toBe(1);
    expect(json.blockedCount).toBe(1);
    expect(tui).toContain('1 stale');
    expect(tui).toContain('1 blocked');
  });
});
