/**
 * Research view-model + renderer parity (v0.1.4, P1-R4).
 *
 * A single `ResearchView` is computed once from a packet + citation resolution.
 * Every presentation surface (TUI, terminal-ui, Print, JSON) projects THAT view,
 * so the event order / status / conclusion are guaranteed consistent across
 * renderers. The TUI shows the human-priority fields (stage, source counts,
 * failures, citations, risks); terminal-ui keeps the technical diagnostics
 * (provider, content hash, per-source status); Print/JSON emit the stable schema
 * rather than concatenated claim text.
 *
 * Also emits a `ResearchLifecycleEvent` stream that the unified agent runtime can
 * forward to TUI / terminal-ui / Print / JSON without each surface re-deriving it.
 */

import type {
  ResearchMode,
  ResearchPacket,
  SourceKind,
  SourceStatus,
  Verification,
} from './research-types';
import type { CitationResolution } from './research-citation';

export type ResearchStage = 'completed' | 'partial' | 'failed';

export interface ResearchViewSource {
  id: string;
  kind: SourceKind;
  provider: string;
  status: SourceStatus;
  canonicalUrl?: string;
  displayUrl?: string;
  projectPath?: string;
  title?: string;
  contentHash?: string;
  failureReason?: string;
}

export interface ResearchView {
  schemaVersion: number;
  packetId: string;
  objective: string;
  mode: ResearchMode;
  stage: ResearchStage;
  sourceCount: number;
  retrievedCount: number;
  partialCount: number;
  failedCount: number;
  blockedCount: number;
  staleCount: number;
  citationCount: number;
  conflictCount: number;
  evidenceCandidateCount: number;
  riskCount: number;
  auditStatus: 'met' | 'partial' | 'unmet';
  conclusion: string;
  claims: Array<{ id: string; verification: Verification; bindingStatus: string }>;
  sources: ResearchViewSource[];
}

export type ResearchLifecycleSummary = Pick<
  ResearchView,
  | 'sourceCount'
  | 'retrievedCount'
  | 'partialCount'
  | 'failedCount'
  | 'blockedCount'
  | 'staleCount'
  | 'citationCount'
  | 'conflictCount'
  | 'evidenceCandidateCount'
  | 'riskCount'
>;

export type ResearchRenderMode = 'tui' | 'terminal' | 'print' | 'json';

/** Compute the canonical view once; all renderers project this. */
export function buildResearchView(
  packet: ResearchPacket,
  resolution: CitationResolution
): ResearchView {
  const sources = packet.sources;
  const retrieved = sources.filter(s => s.status === 'retrieved').length;
  const partial = sources.filter(s => s.status === 'partial').length;
  const failed = sources.filter(s => s.status === 'failed').length;
  const blocked = sources.filter(s => s.status === 'blocked').length;
  const stale = sources.filter(s => s.status === 'stale').length;

  const stage: ResearchStage =
    resolution.audit.status === 'met'
      ? 'completed'
      : packet.risks.length > 0 || failed + blocked > 0
        ? 'partial'
        : 'completed';

  const conclusion = buildConclusion(packet, resolution, { retrieved, failed, blocked });

  return {
    schemaVersion: packet.schemaVersion,
    packetId: packet.packetId,
    objective: packet.request.objective,
    mode: packet.request.mode,
    stage,
    sourceCount: sources.length,
    retrievedCount: retrieved,
    partialCount: partial,
    failedCount: failed,
    blockedCount: blocked,
    staleCount: stale,
    citationCount: resolution.bindings.filter(b => b.status === 'bound').length,
    conflictCount: resolution.conflicts.length,
    evidenceCandidateCount: resolution.evidenceCandidates.length,
    riskCount: packet.risks.length,
    auditStatus: resolution.audit.status,
    conclusion,
    claims: packet.claims.map(c => ({
      id: c.id,
      verification: c.verification,
      bindingStatus: resolution.bindings.find(b => b.claimId === c.id)?.status ?? 'dangling',
    })),
    sources: sources.map(s => ({
      id: s.id,
      kind: s.kind,
      provider: s.provider,
      status: s.status,
      ...(s.canonicalUrl ? { canonicalUrl: s.canonicalUrl } : {}),
      ...(s.displayUrl ? { displayUrl: s.displayUrl } : {}),
      ...(s.projectPath ? { projectPath: s.projectPath } : {}),
      ...(s.title ? { title: s.title } : {}),
      ...(s.contentHash ? { contentHash: s.contentHash } : {}),
      ...(s.failureReason ? { failureReason: s.failureReason } : {}),
    })),
  };
}

function buildConclusion(
  packet: ResearchPacket,
  resolution: CitationResolution,
  counts: { retrieved: number; failed: number; blocked: number }
): string {
  const unverified = resolution.audit.unverifiedClaimIds.length;
  if (resolution.audit.status === 'met') {
    return `Research complete: ${resolution.evidenceCandidates.length} evidence candidate(s) from ${counts.retrieved} verified source(s).`;
  }
  const parts: string[] = [];
  parts.push(
    `Research ${resolution.audit.status}: ${resolution.evidenceCandidates.length} evidence candidate(s)`
  );
  if (counts.failed + counts.blocked > 0)
    parts.push(`${counts.failed + counts.blocked} source(s) failed/blocked`);
  if (resolution.conflicts.length > 0) parts.push(`${resolution.conflicts.length} conflict(s)`);
  if (unverified > 0) parts.push(`${unverified} claim(s) without independent verification`);
  return parts.join('; ') + '.';
}

/** Render the same view in the requested mode. All modes share one conclusion. */
export function renderResearch(view: ResearchView, mode: ResearchRenderMode): string {
  switch (mode) {
    case 'json':
      return JSON.stringify(view);
    case 'print':
      return renderPrint(view);
    case 'terminal':
      return renderTerminal(view);
    case 'tui':
      return renderTui(view);
  }
}

function renderTui(view: ResearchView): string {
  // Human-priority: stage, source counts, failures, citations, risks.
  return [
    `Research ${view.stage.toUpperCase()} (${view.mode})`,
    `Sources: ${view.retrievedCount} retrieved / ${view.failedCount} failed / ${view.blockedCount} blocked / ${view.staleCount} stale`,
    `Citations: ${view.citationCount} bound, ${view.conflictCount} conflict(s)`,
    `Evidence candidates: ${view.evidenceCandidateCount}`,
    `Risks: ${view.riskCount}`,
    `Conclusion: ${view.conclusion}`,
  ].join('\n');
}

function renderTerminal(view: ResearchView): string {
  // Technical diagnostics: provider + content hash per source + audit.
  const srcLines = view.sources
    .map(s => {
      const location = s.displayUrl ?? s.canonicalUrl ?? s.projectPath;
      return `  - ${s.id} [${s.status}] provider=${s.provider} kind=${s.kind}${location ? ` source=${location}` : ''}${s.contentHash ? ` hash=${s.contentHash.slice(0, 12)}` : ''}${s.failureReason ? ` failure=${s.failureReason}` : ''}`;
    })
    .join('\n');
  return [
    `RESEARCH ${view.packetId} stage=${view.stage} audit=${view.auditStatus}`,
    `objective: ${view.objective}`,
    `sources (${view.sourceCount}):`,
    srcLines,
    `bindings: ${view.citationCount} bound, ${view.conflictCount} conflict(s)`,
    `conclusion: ${view.conclusion}`,
  ].join('\n');
}

function renderPrint(view: ResearchView): string {
  // Stable schema text (not raw concatenated claim text).
  const claims = view.claims
    .map(c => `  - ${c.id}: ${c.verification} (${c.bindingStatus})`)
    .join('\n');
  return [
    `# Research: ${view.objective}`,
    `Status: ${view.stage} | Audit: ${view.auditStatus}`,
    `Sources: ${view.sourceCount} (retrieved ${view.retrievedCount}, failed ${view.failedCount}, blocked ${view.blockedCount}, stale ${view.staleCount})`,
    `Citations: ${view.citationCount} bound, ${view.conflictCount} conflict(s), ${view.evidenceCandidateCount} evidence candidate(s)`,
    `Claims:`,
    claims,
    `Conclusion: ${view.conclusion}`,
  ].join('\n');
}

/** Lifecycle events the unified agent runtime can forward to any surface. */
export type ResearchLifecycleEvent =
  | { type: 'research_started'; packetId: string; objective: string; mode: ResearchMode }
  | {
      type: 'research_source';
      packetId: string;
      sourceId: string;
      status: SourceStatus;
      provider: string;
      /** Additive v0.1.4 fields. Optional so older event producers stay compatible. */
      kind?: SourceKind;
      canonicalUrl?: string;
      displayUrl?: string;
      projectPath?: string;
      title?: string;
      contentHash?: string;
      failureReason?: string;
    }
  | { type: 'research_conflict'; packetId: string; claimId: string }
  | {
      type: 'research_completed';
      packetId: string;
      stage: ResearchStage;
      auditStatus: ResearchView['auditStatus'];
      conclusion: string;
      /** Additive aggregate metadata lets sinks project the final view losslessly. */
      summary?: ResearchLifecycleSummary;
    };

export function toLifecycleEvents(
  view: ResearchView,
  resolution?: CitationResolution
): ResearchLifecycleEvent[] {
  const events: ResearchLifecycleEvent[] = [
    {
      type: 'research_started',
      packetId: view.packetId,
      objective: view.objective,
      mode: view.mode,
    },
  ];
  for (const s of view.sources) {
    events.push({
      type: 'research_source',
      packetId: view.packetId,
      sourceId: s.id,
      status: s.status,
      provider: s.provider,
      kind: s.kind,
      ...(s.canonicalUrl ? { canonicalUrl: s.canonicalUrl } : {}),
      ...(s.displayUrl ? { displayUrl: s.displayUrl } : {}),
      ...(s.projectPath ? { projectPath: s.projectPath } : {}),
      ...(s.title ? { title: s.title } : {}),
      ...(s.contentHash ? { contentHash: s.contentHash } : {}),
      ...(s.failureReason ? { failureReason: s.failureReason } : {}),
    });
  }
  if (resolution) {
    for (const c of resolution.conflicts) {
      events.push({ type: 'research_conflict', packetId: view.packetId, claimId: c.claimId });
    }
  }
  events.push({
    type: 'research_completed',
    packetId: view.packetId,
    stage: view.stage,
    auditStatus: view.auditStatus,
    conclusion: view.conclusion,
    summary: {
      sourceCount: view.sourceCount,
      retrievedCount: view.retrievedCount,
      partialCount: view.partialCount,
      failedCount: view.failedCount,
      blockedCount: view.blockedCount,
      staleCount: view.staleCount,
      citationCount: view.citationCount,
      conflictCount: view.conflictCount,
      evidenceCandidateCount: view.evidenceCandidateCount,
      riskCount: view.riskCount,
    },
  });
  return events;
}
