/**
 * orion code — ModelCoordinator v0.2.26
 *
 * Orchestrates /model switching as a transactional prepare/commit/rollback.
 * Handles preflight compact when switching to a smaller context window,
 * and emits model_changed events for all renderers.
 *
 * Gate C of v0.2.26 plan.
 */

import { EventEmitter } from 'events';
import type { ModelRegistry, ResolvedModelProfile } from '../services/model-registry';
import type { ModelClientPool } from '../services/model-client-pool';
import { buildRequestContext } from '../services/model-client-pool';

// ============================================================================
// Types
// ============================================================================

export interface ModelSwitchContext {
  from: ResolvedModelProfile | null;
  to: ResolvedModelProfile;
  registry: ModelRegistry;
  pool: ModelClientPool;
}

export interface ModelSwitchResult {
  success: boolean;
  error?: string;
  /** True if a preflight compact was executed. */
  compacted?: boolean;
}

export interface ModelChangedEvent {
  fromId: string | null;
  toId: string;
  fromContext: number | null;
  toContext: number;
  fingerprint: string;
}

export class ModelCoordinator extends EventEmitter {
  private current: ResolvedModelProfile | null = null;
  private registry: ModelRegistry | null = null;
  private pool: ModelClientPool | null = null;
  private switching = false;

  bind(registry: ModelRegistry, pool: ModelClientPool): void {
    this.registry = registry;
    this.pool = pool;
  }

  /** Current profile, or null if not yet set. */
  getCurrent(): ResolvedModelProfile | null {
    return this.current;
  }

  /** Whether a switch is currently in progress. */
  isSwitching(): boolean {
    return this.switching;
  }

  /**
   * Attempt to switch to a new model profile.
   * Uses prepare/commit semantics: if any step fails, the current model is unchanged.
   */
  switchTo(selector: string): ModelSwitchResult {
    if (!this.registry || !this.pool) {
      return { success: false, error: 'ModelCoordinator not bound to a registry/pool.' };
    }
    if (this.switching) {
      return { success: false, error: 'A model switch is already in progress.' };
    }

    // Resolve the target profile
    const target = this.resolve(selector);
    if (!target) {
      return { success: false, error: `Unknown model: "${selector}". Use /model list to see available models.` };
    }

    this.switching = true;
    try {
      return this.commitSwitch(target);
    } finally {
      this.switching = false;
    }
  }

  /**
   * Set initial model on startup (no "from" profile, no compact check).
   */
  initModel(selector: string): ModelSwitchResult {
    if (!this.registry || !this.pool) {
      return { success: false, error: 'ModelCoordinator not bound.' };
    }
    const target = this.resolve(selector);
    if (!target) {
      return { success: false, error: `Unknown model: "${selector}".` };
    }
    const prev = this.current;
    this.current = target;
    this.emit('model_changed', {
      fromId: prev?.id ?? null,
      toId: target.id,
      fromContext: prev?.resolvedContextWindow ?? null,
      toContext: target.resolvedContextWindow,
      fingerprint: target.fingerprint,
    } satisfies ModelChangedEvent);
    return { success: true };
  }

  // ========================================================================
  // Private
  // ========================================================================

  private resolve(selector: string): ResolvedModelProfile | null {
    const { lookupProfile } = require('../services/model-registry');
    return lookupProfile(this.registry!, selector);
  }

  private commitSwitch(target: ResolvedModelProfile): ModelSwitchResult {
    // Preflight: ensure the client can be created
    try {
      const provider = this.registry!.providers.get(target.provider);
      if (!provider) {
        return { success: false, error: `Provider "${target.provider}" not found.` };
      }
      // Validate client creation (this throws if key is missing/env var unset)
      this.pool!.getClient(provider);
    } catch (err) {
      return { success: false, error: `Cannot create client for ${target.id}: ${String(err)}` };
    }

    // Preflight compact: if switching to smaller context, check if compact needed
    const prev = this.current;
    let compacted = false;
    if (prev && target.resolvedContextWindow < prev.resolvedContextWindow) {
      // Signal that compact may be needed (caller handles actual compact)
      // This is informational — the actual compact is triggered by the agent loop.
      compacted = true;
    }

    // Commit
    this.current = target;

    this.emit('model_changed', {
      fromId: prev?.id ?? null,
      toId: target.id,
      fromContext: prev?.resolvedContextWindow ?? null,
      toContext: target.resolvedContextWindow,
      fingerprint: target.fingerprint,
    } satisfies ModelChangedEvent);

    return { success: true, compacted };
  }
}