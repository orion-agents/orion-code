/**
 * Research contract and normalizer (v0.1.4, P0-R1).
 *
 * Responsibilities:
 *  - Validate a `ResearchRequest` before any work happens.
 *  - Map a legacy `SubtaskResult` (existing `research` role output) into a
 *    versioned `ResearchPacket` without rewriting the runtime.
 *  - Fail closed: missing summary, over-limit sources, or an `observed` claim
 *    without a source binding are rejected. Non-completed results never yield
 *    `observed` claims (no "looks researched" masquerading as verified).
 *  - Provide a deterministic serialization + content hash contract so packets
 *    are replayable and de-duplicable.
 */

import { createHash } from 'crypto';
import type { SubtaskResult, SubtaskUsage } from './types';
import {
  RESEARCH_SCHEMA_VERSION,
  type EvidenceKind,
  type ResearchClaim,
  type ResearchPacket,
  type ResearchRequest,
  type ResearchSource,
  type Verification,
} from './research-types';

/** Hard caps independent of per-request budget, to bound abuse. */
export const RESEARCH_HARD_LIMITS = {
  maxSources: { min: 1, max: 200 },
  maxFetchBytes: { min: 0, max: 32 * 1024 * 1024 },
  maxDurationMs: { min: 1_000, max: 600_000 },
  maxClaims: 500,
  maxSummaryLen: 20_000,
} as const;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface PacketContext {
  sessionId: string;
  projectPath: string;
  goalId?: string;
  objectiveRevision?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Validate a research request before scheduling any work. */
export function validateResearchRequest(req: Partial<ResearchRequest>): ValidationResult {
  const errors: string[] = [];
  if (typeof req.schemaVersion !== 'number') errors.push('schemaVersion is required');
  if (req.schemaVersion !== undefined && req.schemaVersion !== RESEARCH_SCHEMA_VERSION) {
    errors.push(`unsupported schemaVersion ${req.schemaVersion}`);
  }
  if (typeof req.objective !== 'string' || !req.objective.trim()) errors.push('objective is required');
  if (!req.scope || typeof req.scope.projectRoot !== 'string') errors.push('scope.projectRoot is required');
  if (req.mode !== 'local' && req.mode !== 'web' && req.mode !== 'mixed') {
    errors.push('mode must be local | web | mixed');
  }
  if (typeof req.maxSources !== 'number' || req.maxSources < RESEARCH_HARD_LIMITS.maxSources.min) {
    errors.push(`maxSources must be >= ${RESEARCH_HARD_LIMITS.maxSources.min}`);
  }
  if (typeof req.maxFetchBytes !== 'number' || req.maxFetchBytes < 0) {
    errors.push('maxFetchBytes must be >= 0');
  }
  if (typeof req.maxDurationMs !== 'number' || req.maxDurationMs <= 0) {
    errors.push('maxDurationMs must be > 0');
  }
  if (req.goalBinding) {
    if (typeof req.goalBinding.goalId !== 'string') errors.push('goalBinding.goalId is required');
    if (typeof req.goalBinding.objectiveRevision !== 'number') {
      errors.push('goalBinding.objectiveRevision is required');
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Convenience builder for a local-only research request (POC-1 default). */
export function createLocalResearchRequest(
  objective: string,
  projectRoot: string,
  overrides: Partial<ResearchRequest> = {},
): ResearchRequest {
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    objective,
    scope: { projectRoot, ...(overrides.scope ?? {}) },
    mode: overrides.mode ?? 'local',
    maxSources: overrides.maxSources ?? 50,
    maxFetchBytes: overrides.maxFetchBytes ?? 0,
    maxDurationMs: overrides.maxDurationMs ?? 120_000,
    ...overrides,
  };
}

function deriveVerification(status: SubtaskResult['status'], hasFile: boolean): Verification {
  // Fail closed: a non-completed result can never produce an `observed` claim.
  if (status !== 'completed') return 'unverified';
  return hasFile ? 'observed' : 'unverified';
}

/**
 * Map a legacy `SubtaskResult` into a versioned `ResearchPacket`.
 *
 * File findings become `observed` file claims bound to a `file` source. Findings
 * without a file become `inference`/`unverified` claims. Failed/cancelled/timed
 * out results downgrade every claim to `unverified` so a partial run can never
 * report a verified conclusion.
 */
export function subtaskResultToPacket(
  result: SubtaskResult,
  request: ResearchRequest,
  ctx: PacketContext,
): ResearchPacket {
  const sources: ResearchSource[] = [];
  const sourceByPath = new Map<string, ResearchSource>();

  const ensureFileSource = (projectPath: string): ResearchSource => {
    const existing = sourceByPath.get(projectPath);
    if (existing) return existing;
    const source: ResearchSource = {
      id: `src-${sources.length + 1}`,
      kind: 'file',
      projectPath,
      provider: 'local',
      retrievedAt: nowIso(),
      status: 'retrieved',
    };
    sourceByPath.set(projectPath, source);
    sources.push(source);
    return source;
  };

  for (const filePath of result.files) ensureFileSource(filePath);

  const claims: ResearchClaim[] = result.findings.map((finding, i) => {
    const hasFile = typeof finding.file === 'string' && finding.file.length > 0;
    const bound = hasFile ? ensureFileSource(finding.file as string) : undefined;
    const evidenceKind: EvidenceKind = hasFile ? 'file' : 'inference';
    const verification = deriveVerification(result.status, hasFile);
    const text = finding.evidence ? `${finding.title}: ${finding.evidence}` : finding.title;
    const claim: ResearchClaim = {
      id: `clm-${i + 1}`,
      text,
      sourceIds: bound ? [bound.id] : [],
      evidenceKind,
      verification,
    };
    if (finding.severity) {
      const confidence =
        finding.severity === 'critical' || finding.severity === 'high'
          ? 'high'
          : finding.severity === 'medium'
            ? 'medium'
            : 'low';
      claim.confidence = confidence;
    }
    return claim;
  });

  const packet: ResearchPacket = {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    packetId: `pkt-${result.id}`,
    projectPath: ctx.projectPath,
    sessionId: ctx.sessionId,
    ...(ctx.goalId ? { goalId: ctx.goalId } : {}),
    ...(ctx.objectiveRevision !== undefined ? { objectiveRevision: ctx.objectiveRevision } : {}),
    request,
    summary: result.summary,
    claims,
    sources,
    gaps: [],
    risks: result.risks,
    usage: result.usage as SubtaskUsage,
    createdAt: nowIso(),
  };
  return packet;
}

/**
 * Fail-closed packet validation. An `observed`/`partially_observed` claim must
 * bind to at least one existing source; an inference claim must not be marked
 * `observed`; source counts must respect the request budget.
 */
export function validatePacket(packet: ResearchPacket): ValidationResult {
  const errors: string[] = [];
  if (!packet.summary || !packet.summary.trim()) errors.push('packet.summary is required');
  if (packet.schemaVersion !== RESEARCH_SCHEMA_VERSION) {
    errors.push(`unsupported schemaVersion ${packet.schemaVersion}`);
  }
  if (packet.summary.length > RESEARCH_HARD_LIMITS.maxSummaryLen) {
    errors.push('packet.summary exceeds max length');
  }
  if (packet.claims.length > RESEARCH_HARD_LIMITS.maxClaims) {
    errors.push(`claims ${packet.claims.length} exceed max ${RESEARCH_HARD_LIMITS.maxClaims}`);
  }

  const sourceIds = new Set(packet.sources.map(s => s.id));
  for (const source of packet.sources) {
    if (!source.provider) errors.push(`source ${source.id} missing provider`);
    if (!source.status) errors.push(`source ${source.id} missing status`);
  }
  if (packet.sources.length > packet.request.maxSources) {
    errors.push(`sources ${packet.sources.length} exceed request.maxSources ${packet.request.maxSources}`);
  }

  for (const claim of packet.claims) {
    for (const sid of claim.sourceIds) {
      if (!sourceIds.has(sid)) errors.push(`claim ${claim.id} references unknown source ${sid}`);
    }
    const verified = claim.verification === 'observed' || claim.verification === 'partially_observed';
    if (verified && claim.sourceIds.length === 0) {
      errors.push(`claim ${claim.id} marked ${claim.verification} but has no source binding`);
    }
    if (claim.verification === 'observed' && claim.evidenceKind === 'inference') {
      errors.push(`claim ${claim.id} is inference but marked observed`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) sorted[key] = sortDeep(obj[key]);
    return sorted;
  }
  return value;
}

/** Deterministic JSON (sorted keys) for a value. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

/** Strip volatile timestamps so the content hash is reproducible across runs. */
function packetContentForHash(packet: ResearchPacket): unknown {
  return sortDeep({
    ...packet,
    createdAt: undefined,
    sources: packet.sources.map(s => ({ ...s, retrievedAt: undefined })),
  });
}

/**
 * Content hash over the canonical packet body (timestamps excluded). Proves what
 * was read, NOT that the content is true; used for dedupe and drift detection.
 */
export function hashPacket(packet: ResearchPacket): string {
  return createHash('sha256').update(stableStringify(packetContentForHash(packet))).digest('hex');
}
