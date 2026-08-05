/**
 * Research-to-Evidence schema (v0.1.4).
 *
 * These types describe a safe, traceable, recoverable research loop that turns
 * a read-only `research` subagent result into a `ResearchPacket` whose claims
 * are bound to verifiable sources.
 *
 * Every packet is versioned. Unknown schema versions fail closed; unknown
 * fields are ignored but the schema must match. The schema is renderer- and
 * protocol-agnostic so TUI / terminal-ui / Print-JSON all consume one shape.
 */

export const RESEARCH_SCHEMA_VERSION = 1 as const;

export type ResearchMode = 'local' | 'web' | 'mixed';

export type SourceKind = 'file' | 'search_result' | 'web_page' | 'provider_document';

export type SourceStatus = 'retrieved' | 'partial' | 'failed' | 'blocked' | 'stale';

export type EvidenceKind = 'file' | 'external' | 'inference';

/**
 * Verification is the boundary between fact and inference.
 * - `observed`           : traceable to a source that was actually retrieved.
 * - `partially_observed` : partially traceable (e.g. excerpt but not full content).
 * - `unverified`         : claim exists but no independent source backs it.
 * - `contradicted`       : at least one source disputes the claim.
 */
export type Verification = 'observed' | 'partially_observed' | 'unverified' | 'contradicted';

export type Confidence = 'high' | 'medium' | 'low';

export interface ResearchScope {
  /** Canonical project root the research is scoped to. */
  projectRoot: string;
  /** In-project paths the child is allowed to read. */
  paths?: string[];
  /** Allowed external domains (web/mixed only). */
  domains?: string[];
  freshness?: 'any' | 'recent' | 'as_of';
  asOf?: string;
}

export interface ResearchRequest {
  schemaVersion: number;
  objective: string;
  scope: ResearchScope;
  mode: ResearchMode;
  /** Upper bound on number of sources collected. */
  maxSources: number;
  /** Upper bound on bytes fetched from external sources (0 for local-only). */
  maxFetchBytes: number;
  /** Hard wall-clock budget for the whole research packet. */
  maxDurationMs: number;
  expectedOutput?: string;
  /** Optional binding to a Goal objective revision. */
  goalBinding?: { goalId: string; objectiveRevision: number };
}

export interface ResearchSource {
  id: string;
  kind: SourceKind;
  /** Canonical, normalized URL for web/provider sources. */
  canonicalUrl?: string;
  /** User-visible URL with secret-bearing query params removed. */
  displayUrl?: string;
  /** Project-relative path for file sources (never an absolute user path). */
  projectPath?: string;
  title?: string;
  excerpt?: string;
  provider: string;
  retrievedAt: string;
  /**
   * Hash over the canonical source content. Proves what was read, NOT that the
   * content is true. Used for drift detection, not authenticity.
   */
  contentHash?: string;
  status: SourceStatus;
  failureReason?: string;
  /** Human-readable descriptions of redactions applied (e.g. "api_key"). */
  redactions?: string[];
}

export interface ResearchClaim {
  id: string;
  text: string;
  /** Bindings into `ResearchPacket.sources`. Must be non-empty for observed claims. */
  sourceIds: string[];
  evidenceKind: EvidenceKind;
  verification: Verification;
  confidence?: Confidence;
  /** Ids of claims/sources this claim contradicts. */
  conflicts?: string[];
}

export interface ResearchPacket {
  schemaVersion: number;
  packetId: string;
  projectPath: string;
  sessionId: string;
  goalId?: string;
  objectiveRevision?: number;
  request: ResearchRequest;
  summary: string;
  claims: ResearchClaim[];
  sources: ResearchSource[];
  /** Questions the research could not answer. */
  gaps: string[];
  risks: string[];
  usage: import('./types').SubtaskUsage;
  createdAt: string;
}
