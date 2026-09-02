/**
 * Research quality, cost, and recovery hardening (v0.1.4, P1-R6).
 *
 * - Source ranking is EXPLAINABLE ONLY: it returns an ordering plus a list of
 *   human-readable reasons (freshness / provider / scope match / dedup). It is
 *   never a verdict on truth - a higher rank does not mean a source is correct.
 * - Cost diagnostics summarize model/tool/time/source usage for `npm run cost`
 *   reconciliation.
 * - Recovery hints turn a structured failure reason into an actionable suggestion,
 *   without ever suggesting a generic MCP or a write path.
 */

import type { ResearchPacket, ResearchScope, ResearchSource } from './research-types';

export interface RankedSource {
  sourceId: string;
  rank: number;
  score: number;
  reasons: string[];
}

function daysSince(iso: string, now: Date): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 999;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

function hostOf(url?: string): string | null {
  if (!url) return null;
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
  } catch {
    return null;
  }
}

function matchesDomain(host: string | null, domains: string[] = []): boolean {
  if (!host || domains.length === 0) return false;
  return domains.some(d => host === d.toLowerCase() || host.endsWith('.' + d.toLowerCase()));
}

export interface RankOptions {
  /** Preferred providers in priority order (higher index = lower preference). */
  preferredProviders?: string[];
  scope?: ResearchScope;
  now?: Date;
}

/**
 * Rank sources by explainable signals. Stale revisions are demoted. The returned
 * `reasons` explain every contribution; the score is advisory, not truth.
 */
export function rankSources(sources: ResearchSource[], opts: RankOptions = {}): RankedSource[] {
  const now = opts.now ?? new Date();
  const ranked = sources.map(src => {
    const reasons: string[] = [];
    let score = 0;

    const age = daysSince(src.retrievedAt, now);
    score += Math.max(0, 30 - age); // fresher is better, capped
    if (age <= 7) reasons.push(`fresh (retrieved ${age}d ago)`);
    else reasons.push(`older (retrieved ${age}d ago)`);

    if (src.status === 'stale') {
      score -= 50;
      reasons.push('stale revision (demoted)');
    } else if (src.status === 'blocked' || src.status === 'failed') {
      score -= 40;
      reasons.push(`unavailable (${src.status})`);
    } else {
      reasons.push('available');
    }

    const idx = opts.preferredProviders?.indexOf(src.provider) ?? -1;
    if (idx >= 0) {
      score += 10 - idx;
      reasons.push(`preferred provider (${src.provider})`);
    } else {
      reasons.push(`provider ${src.provider}`);
    }

    const host = hostOf(src.canonicalUrl);
    if (matchesDomain(host, opts.scope?.domains)) {
      score += 15;
      reasons.push('matches scope domain');
    }

    return { sourceId: src.id, score, reasons };
  });

  ranked.sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId));
  return ranked.map((r, i) => ({ ...r, rank: i + 1 }));
}

export interface ResearchCostSummary {
  modelRequests: number;
  toolCalls: number;
  durationMs: number;
  sourceCount: number;
  retrievedCount: number;
  notes: string[];
}

/** Summarize research cost from the packet usage + source counts. */
export function researchCostSummary(
  packet: ResearchPacket,
  opts: { fetchedBytes?: number } = {}
): ResearchCostSummary {
  const notes: string[] = [];
  const retrieved = packet.sources.filter(s => s.status === 'retrieved').length;
  if (packet.sources.length > packet.request.maxSources) {
    notes.push(
      `source count exceeded request budget (${packet.sources.length} > ${packet.request.maxSources})`
    );
  }
  if (
    opts.fetchedBytes !== undefined &&
    packet.request.maxFetchBytes > 0 &&
    opts.fetchedBytes > packet.request.maxFetchBytes
  ) {
    notes.push(
      `fetched bytes exceeded budget (${opts.fetchedBytes} > ${packet.request.maxFetchBytes})`
    );
  }
  return {
    modelRequests: packet.usage.modelRequests,
    toolCalls: packet.usage.toolCalls,
    durationMs: packet.usage.durationMs,
    sourceCount: packet.sources.length,
    retrievedCount: retrieved,
    notes,
  };
}

/**
 * Turn a structured failure reason into an actionable recovery hint. Never
 * suggests a generic MCP or a write/exec path.
 */
export function recoveryHint(reason: string | undefined): string {
  const r = (reason ?? '').toLowerCase();
  if (r.includes('ssrf') || r.includes('blocked') || r.includes('internal')) {
    return 'Blocked by security policy (SSRF/internal host). Use an allowlisted public URL.';
  }
  if (r.includes('dns')) {
    return 'DNS resolution failed. Check network/allowlist; the guard runs on every redirect hop.';
  }
  if (r.includes('timeout') || r.includes('timed') || r.includes('too many redirect')) {
    return 'Request timed out or redirected too often. Increase maxDurationMs or reduce sources.';
  }
  if (r.includes('too large') || r.includes('content-length') || r.includes('bytes')) {
    return 'Response exceeded size budget. Increase maxFetchBytes or fetch a narrower excerpt.';
  }
  if (r.includes('provider') || r.includes('websearch') || r.includes('unavailable')) {
    return 'Search provider unavailable. Configure an allowlisted provider (WebSearch/WebFetch only; no generic MCP).';
  }
  return 'Review the failure reason and retry within the request budget (sources/ bytes/ duration).';
}
