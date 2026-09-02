/**
 * Citation, conflict, and evidence-candidate resolution (v0.1.4, P0-R3).
 *
 * Turns a `ResearchPacket` (with its claims + sources) into:
 *  - resolved claim->source bindings (reference-integrity validated),
 *  - same-URL multi-version dedupe (older revisions marked `stale` on hash drift),
 *  - conflict records for contradictory sources (never auto-picked),
 *  - a verification classification per claim,
 *  - evidence candidates (only rule-compliant claims; research vs execution kept
 *    distinct so a web summary can never stand in for test/build/file facts),
 *  - a completion audit that stays `partial`/`unmet` for claims that have sources
 *    but no independent verification.
 *
 * This module is pure (no IO) so it is fully testable without network or disk.
 */

import type { ResearchClaim, ResearchPacket, ResearchSource, Verification } from './research-types';

/** Normalize a URL for dedupe: drop fragment + trailing slash, lowercase host. */
export function urlKey(url: string | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    const host = u.host.toLowerCase();
    let path = u.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    const query = u.search;
    return `${u.protocol}//${host}${path}${query}`;
  } catch {
    return url;
  }
}

export type BindingStatus = 'bound' | 'dangling' | 'stale_only' | 'conflicted';

export interface ClaimBinding {
  claimId: string;
  /** Resolved, non-stale source ids actually backing the claim. */
  sourceIds: string[];
  /** All source ids referenced by the claim (including stale/blocked). */
  referencedSourceIds: string[];
  status: BindingStatus;
}

export interface ConflictRecord {
  claimId: string;
  sourceIds: string[];
  reason: string;
}

export interface EvidenceCandidate {
  claimId: string;
  /** 'research' = external/web source; 'execution' = file/verification fact. */
  kind: 'research' | 'execution';
  basis: 'file' | 'external';
  summary: string;
}

export interface CompletionAudit {
  status: 'met' | 'partial' | 'unmet';
  /** Claims that have sources but no independent verification. */
  unverifiedClaimIds: string[];
  notes: string[];
}

export interface CitationResolution {
  packetId: string;
  bindings: ClaimBinding[];
  conflicts: ConflictRecord[];
  staleSourceIds: string[];
  evidenceCandidates: EvidenceCandidate[];
  audit: CompletionAudit;
}

/**
 * Resolve citations for a packet.
 *
 * Reference integrity: a claim binding to an unknown source id is flagged
 * `dangling` (and downgraded to `unverified`). Dedupe: sources sharing a
 * canonical URL key are collapsed; the newest by `retrievedAt` wins and older
 * revisions with a different content hash are marked `stale`. Conflict: a claim
 * backed by both a `retrieved` source and a `failed`/`blocked` source (or two
 * sources explicitly flagged contradictory) yields a conflict record and is
 * never silently resolved in the model-favorable direction.
 */
export function resolveCitations(packet: ResearchPacket): CitationResolution {
  const sourceIds = new Set(packet.sources.map(s => s.id));
  const byId = new Map(packet.sources.map(s => [s.id, s] as const));

  // --- dedupe same-URL multi-version -> stale ---
  const staleSourceIds: string[] = [];
  const groups = new Map<string, ResearchSource[]>();
  for (const s of packet.sources) {
    const key = urlKey(s.canonicalUrl);
    if (!key) continue;
    const arr = groups.get(key) ?? [];
    arr.push(s);
    groups.set(key, arr);
  }
  for (const [, group] of groups) {
    if (group.length < 2) continue;
    // newest by retrievedAt wins; older ones with a different hash become stale.
    const sorted = [...group].sort((a, b) => b.retrievedAt.localeCompare(a.retrievedAt));
    const winner = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      const s = sorted[i];
      if (s.contentHash && winner.contentHash && s.contentHash !== winner.contentHash) {
        staleSourceIds.push(s.id);
        s.status = 'stale';
      }
    }
  }
  const staleSet = new Set(staleSourceIds);

  const bindings: ClaimBinding[] = [];
  const conflicts: ConflictRecord[] = [];
  const evidenceCandidates: EvidenceCandidate[] = [];

  for (const claim of packet.claims) {
    const referenced = claim.sourceIds.filter(id => sourceIds.has(id));
    const danglingRefs = claim.sourceIds.filter(id => !sourceIds.has(id));
    const active = referenced.filter(id => !staleSet.has(id));
    const activeSources = active.map(id => byId.get(id)!).filter(Boolean);

    const hasRetrieved = activeSources.some(s => s.status === 'retrieved');
    const hasFailed = activeSources.some(s => s.status === 'failed' || s.status === 'blocked');

    let status: BindingStatus;
    if (danglingRefs.length > 0 && referenced.length === 0) {
      status = 'dangling';
    } else if (hasRetrieved && hasFailed) {
      status = 'conflicted';
    } else if (active.length === 0 && referenced.length > 0) {
      status = 'stale_only';
    } else {
      status = 'bound';
    }

    if (status === 'conflicted') {
      conflicts.push({
        claimId: claim.id,
        sourceIds: active,
        reason: 'claim backed by both a retrieved source and a failed/blocked source',
      });
    }

    bindings.push({
      claimId: claim.id,
      sourceIds: active,
      referencedSourceIds: referenced,
      status,
    });

    // Verification classification: conflicted -> contradicted.
    const verification: Verification =
      status === 'conflicted'
        ? 'contradicted'
        : classifyVerification(claim, hasRetrieved, activeSources);
    claim.verification = verification;

    // Evidence candidate: only rule-compliant claims.
    if (
      (verification === 'observed' || verification === 'partially_observed') &&
      claim.evidenceKind !== 'inference' &&
      status !== 'conflicted'
    ) {
      const primary = activeSources.find(s => s.status === 'retrieved');
      const isFile = primary?.kind === 'file';
      evidenceCandidates.push({
        claimId: claim.id,
        kind: isFile ? 'execution' : 'research',
        basis: isFile ? 'file' : 'external',
        summary: claim.text,
      });
    }
  }

  const audit = auditCompletion(packet, bindings);

  return {
    packetId: packet.packetId,
    bindings,
    conflicts,
    staleSourceIds,
    evidenceCandidates,
    audit,
  };
}

function classifyVerification(
  claim: ResearchClaim,
  hasRetrieved: boolean,
  activeSources: ResearchSource[]
): Verification {
  if (claim.evidenceKind === 'inference') return 'unverified';
  if (!hasRetrieved) return 'unverified';
  const onlyExcerpt = activeSources.every(
    s => !!s.excerpt && s.excerpt.length < 4000 && !s.contentHash
  );
  return onlyExcerpt ? 'partially_observed' : 'observed';
}

/**
 * Completion audit. The key invariant (plan exit condition): a claim that HAS
 * sources but no independent verification must keep the audit `partial`/`unmet`
 * - never `met`. We therefore treat any claim with referenced sources whose
 * verification is not `observed` as unverified for audit purposes.
 */
function auditCompletion(packet: ResearchPacket, bindings: ClaimBinding[]): CompletionAudit {
  const notes: string[] = [];
  const unverifiedClaimIds: string[] = [];

  for (const claim of packet.claims) {
    const binding = bindings.find(b => b.claimId === claim.id);
    const hasSources = (binding?.referencedSourceIds.length ?? 0) > 0;
    const independentlyVerified = claim.verification === 'observed';
    if (!independentlyVerified) {
      if (hasSources) {
        unverifiedClaimIds.push(claim.id);
        notes.push(`claim ${claim.id} has sources but no independent verification (stays partial)`);
      } else {
        unverifiedClaimIds.push(claim.id);
      }
    }
  }

  let status: CompletionAudit['status'];
  if (unverifiedClaimIds.length === 0) {
    status = 'met';
  } else if (
    packet.claims.some(
      c => (bindings.find(b => b.claimId === c.id)?.referencedSourceIds.length ?? 0) > 0
    )
  ) {
    status = 'partial';
  } else {
    status = 'unmet';
  }

  return { status, unverifiedClaimIds, notes };
}
