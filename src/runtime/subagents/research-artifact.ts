/**
 * Research artifact persistence, resume, and Goal integration (v0.1.4, P1-R5).
 *
 * - Packet + source metadata are saved atomically under a CAS (compare-and-swap)
 *   token so a concurrent / active-Goal overwrite without the current token is
 *   rejected.
 * - Scope isolation: project / session / Goal are part of the storage key, so a
 *   packet can never leak across project/session boundaries.
 * - resume derives completed/partial/failed WITHOUT replaying any external side
 *   effect (no network, no fetch) - it only reads the stored packet.
 * - clear/repair/cleanup preserve the original packet + prior CAS tokens for
 *   traceability; old schema versions fail closed (never silently migrated).
 *
 * Persistence is injected (default: in-memory map) so the logic is testable
 * without disk.
 */

import { hashPacket } from './research-contract';
import { RESEARCH_SCHEMA_VERSION, type ResearchPacket } from './research-types';

export interface ResearchScope {
  projectPath: string;
  sessionId: string;
  goalId?: string;
}

export interface ArtifactRecord {
  version: number;
  /** CAS token = content hash of the stored packet at write time. */
  casToken: string;
  packet: ResearchPacket;
  storedAt: string;
  /** Prior CAS tokens, oldest first, kept for traceability. */
  previousTokens: string[];
}

export interface ResearchArtifactStore {
  read(scopeKey: string): ArtifactRecord | null;
  write(scopeKey: string, record: ArtifactRecord): void;
}

/** Default in-memory store (test seam; production can back this with session storage). */
export function createMemoryArtifactStore(): ResearchArtifactStore {
  const map = new Map<string, ArtifactRecord>();
  return {
    read: key => map.get(key) ?? null,
    write: (key, rec) => {
      map.set(key, rec);
    },
  };
}

export function scopeKey(scope: ResearchScope): string {
  return `${scope.projectPath}::${scope.sessionId}::${scope.goalId ?? '-'}`;
}

export type ResearchResumeState = 'completed' | 'partial' | 'failed';

export class CasMismatchError extends Error {
  constructor(public scopeKey: string, public expected: string, public actual: string) {
    super(`CAS mismatch for ${scopeKey}: expected ${expected}, found ${actual}`);
    this.name = 'CasMismatchError';
  }
}

export class UnsupportedSchemaError extends Error {
  constructor(public version: number) {
    super(`unsupported research schema version ${version}`);
    this.name = 'UnsupportedSchemaError';
  }
}

export interface SaveOptions {
  /**
   * When set, the write only succeeds if the existing record's CAS token matches.
   * Omitting it for a goal-scoped packet triggers a CasMismatchError (an active
   * Goal's packet must be updated via explicit resume with the current token).
   */
  expectedToken?: string;
  /** Stamp used instead of the wall clock (deterministic tests). */
  now?: () => Date;
}

export interface SaveResult {
  version: number;
  casToken: string;
}

/**
 * Atomically save (or update) a research packet under its scope. Enforces CAS so
 * concurrent / active-Goal overwrites are rejected unless the caller holds the
 * current token. Returns the new version + token.
 */
export function saveResearchPacket(
  store: ResearchArtifactStore,
  packet: ResearchPacket,
  scope: ResearchScope,
  opts: SaveOptions = {},
): SaveResult {
  const key = scopeKey(scope);
  const now = opts.now ?? (() => new Date());
  const casToken = hashPacket(packet);
  const existing = store.read(key);

  if (scope.goalId && existing && opts.expectedToken === undefined) {
    // An active Goal's packet must be updated with an explicit token (resume),
    // never blindly overwritten.
    throw new CasMismatchError(key, existing.casToken, casToken);
  }
  if (existing && opts.expectedToken !== undefined && opts.expectedToken !== existing.casToken) {
    throw new CasMismatchError(key, opts.expectedToken, existing.casToken);
  }

  const version = (existing?.version ?? 0) + 1;
  const previousTokens = existing ? [...existing.previousTokens, existing.casToken] : [];
  store.write(key, { version, casToken, packet, storedAt: now().toISOString(), previousTokens });
  return { version, casToken };
}

/**
 * Load a packet. Fails closed on old/unsupported schema versions (never migrates
 * silently). Returns null when nothing is stored for the scope.
 */
export function loadResearchPacket(store: ResearchArtifactStore, scope: ResearchScope): ResearchPacket | null {
  const rec = store.read(scopeKey(scope));
  if (!rec) return null;
  if (rec.packet.schemaVersion !== RESEARCH_SCHEMA_VERSION) {
    throw new UnsupportedSchemaError(rec.packet.schemaVersion);
  }
  return rec.packet;
}

/**
 * Resume the research state from a stored packet WITHOUT replaying external side
 * effects. Pure derivation: completed when there are usable sources and no
 * failures/conflicts, partial when there are failures/conflicts but some progress,
 * failed only when there is nothing usable.
 */
export function resumeResearchState(packet: ResearchPacket): ResearchResumeState {
  if (packet.schemaVersion !== RESEARCH_SCHEMA_VERSION) throw new UnsupportedSchemaError(packet.schemaVersion);
  if (packet.sources.length === 0) return 'failed';
  const hasFailures = packet.sources.some(s => s.status === 'failed' || s.status === 'blocked');
  const hasConflict = packet.risks.some(r => /conflict/i.test(r));
  if (hasFailures || hasConflict) return 'partial';
  return 'completed';
}

/** Get the prior CAS tokens for a scope (traceability after clear/repair). */
export function artifactHistory(store: ResearchArtifactStore, scope: ResearchScope): string[] {
  return store.read(scopeKey(scope))?.previousTokens ?? [];
}
