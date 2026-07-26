/**
 * ChildToolExecutorGuard: enforces project-root and packet-scope isolation.
 *
 * R3 (v0.2.20): the policy only canonicalizes scope.paths into the child
 * prompt, but the actual tool arguments (read_file path, glob base, grep
 * path, batch_read nested args) were not validated. A child could read
 * absolute paths, `../` escapes, outside-scope files, or symlink targets
 * pointing outside the project.
 *
 * This guard wraps the child tool executor and performs a realpath-based
 * containment check on every path-bearing argument before delegating to
 * the real executor.
 *
 * Two containment boundaries:
 *   1. Canonical project root (always enforced).
 *   2. Packet scope paths (enforced when the packet specifies a non-empty
 *      scope). The path must be inside the root AND inside at least one
 *      scope realpath.
 */

import { resolve, relative, isAbsolute } from 'path';
import { existsSync, realpathSync } from 'fs';

/** Tools whose arguments carry a single primary path under key `path`. */
const PATH_TOOLS = new Set(['read_file', 'list_files']);

/** Tools whose arguments carry a base/glob root under `path`. */
const BASE_PATH_TOOLS = new Set(['glob']);

/** Tools whose arguments carry a search base under `path`. */
const SEARCH_PATH_TOOLS = new Set(['grep']);

/** batch_read nests step args; each step has { tool, args }. */
const BATCH_TOOL = 'batch_read';

export interface GuardOptions {
  /** Canonical project root (first containment boundary). */
  rootCwd: string;
  /** Canonical scope paths (second, stricter boundary). Empty = root only. */
  scopePaths?: readonly string[];
}

export interface GuardRejection {
  ok: false;
  tool: string;
  reason: string;
  path?: string;
}

export interface GuardApproval {
  ok: true;
}

export type GuardVerdict = GuardApproval | GuardRejection;

/**
 * Return the realpath of the nearest existing ancestor of `p`.
 *
 * This handles not-yet-created paths (the target doesn't exist, but its
 * parent dir does) and symlinked parent directories: we walk up until we
 * find a path that exists, then resolve its realpath. Symlink escapes in
 * an existing ancestor are caught because realpath resolves them.
 */
function nearestExistingAncestorRealpath(p: string): string | undefined {
  let current = p;
  for (let i = 0; i < 64; i++) {
    if (existsSync(current)) {
      try {
        return realpathSync(current);
      } catch (err) {
        // Distinguish ENOENT (path disappeared between existsSync and realpathSync)
        // from permission/I/O errors. ENOENT: continue walking up. Others: fail.
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') {
          // Path vanished between existsSync and realpathSync (TOCTOU).
          // Continue walking up to find an existing ancestor.
          const parent = resolve(current, '..');
          if (parent === current) return undefined;
          current = parent;
          continue;
        }
        // EACCES, EIO, etc: cannot resolve realpath — treat as unresolvable.
        // Returning undefined signals to the caller that containment cannot be
        // verified, and the path should be rejected.
        return undefined;
      }
    }
    const parent = resolve(current, '..');
    if (parent === current) return undefined; // filesystem root, no existing ancestor
    current = parent;
  }
  return undefined; // loop exhausted, no existing ancestor found
}

/** True if `candidate` is `ancestor` or inside it (both realpaths). */
function isInsideOrEqual(candidate: string, ancestor: string): boolean {
  if (candidate === ancestor) return true;
  const rel = relative(ancestor, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Check that a path stays inside root (and inside a scope if scopes given).
 *
 * Strategy: resolve the path against root, then take the realpath of its
 * nearest existing ancestor. If that ancestor is outside root, the path
 * escapes (via `..`, absolute outside root, or symlinked parent). If scopes
 * are specified, the ancestor must also be inside a scope OR the path must
 * descend into a scope from the root (ancestor is root itself, remaining
 * suffix enters a scope).
 */
function checkContainment(
  rawPath: string,
  rootReal: string,
  scopeReals: readonly string[],
): { contained: boolean; reason?: string } {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    return { contained: false, reason: 'empty path' };
  }

  const resolved = resolve(rootReal, rawPath);
  const ancestorReal = nearestExistingAncestorRealpath(resolved);

  // If no existing ancestor could be resolved (e.g. EACCES on realpathSync),
  // containment cannot be verified — reject the path.
  if (ancestorReal === undefined) {
    return { contained: false, reason: `cannot verify path containment: ${rawPath}` };
  }

  // Boundary 1: must be inside root.
  if (!isInsideOrEqual(ancestorReal, rootReal)) {
    return { contained: false, reason: `path escapes project root: ${rawPath}` };
  }

  // Boundary 2: if scopes specified, the target must be inside a scope.
  if (scopeReals.length > 0) {
    // If the ancestor is already inside a scope, ok.
    const ancestorInScope = scopeReals.some(s => isInsideOrEqual(ancestorReal, s));
    if (!ancestorInScope) {
      // Ancestor is root (or above scope) but target may descend into a
      // scope. Re-resolve the full target's nearest-existing-ancestor
      // against each scope: the resolved path relative to root must, when
      // joined, fall inside a scope realpath.
      const targetInScope = scopeReals.some(s => {
        // Compute where the target would resolve to relative to root, then
        // check containment against the scope realpath.
        const targetResolved = resolve(rootReal, rawPath);
        const targetAncestor = nearestExistingAncestorRealpath(targetResolved);
        return targetAncestor !== undefined && isInsideOrEqual(targetAncestor, s);
      });
      if (!targetInScope) {
        return { contained: false, reason: `path outside packet scope: ${rawPath}` };
      }
    }
  }

  return { contained: true };
}

/** Extract path-bearing arguments from a tool call. */
function extractPathArgs(
  tool: string,
  args: Record<string, unknown>,
): string[] {
  const paths: string[] = [];

  if (
    PATH_TOOLS.has(tool) ||
    BASE_PATH_TOOLS.has(tool) ||
    SEARCH_PATH_TOOLS.has(tool)
  ) {
    const p = args.path;
    if (typeof p === 'string') {
      paths.push(p);
    }
    // glob/grep with no path default to cwd (inside root) - no check needed.
  }

  if (tool === BATCH_TOOL) {
    const steps = args.steps;
    if (Array.isArray(steps)) {
      for (const step of steps) {
        if (step && typeof step === 'object' && typeof step.tool === 'string') {
          const stepArgs =
            step.args && typeof step.args === 'object'
              ? (step.args as Record<string, unknown>)
              : {};
          paths.push(...extractPathArgs(step.tool, stepArgs));
        }
      }
    }
  }

  return paths;
}

/**
 * Evaluate whether a tool call is allowed under the guard's boundaries.
 * Pure (modulo realpath reads) so it can be tested in isolation.
 */
export function evaluateToolCall(
  tool: string,
  args: Record<string, unknown>,
  options: GuardOptions,
): GuardVerdict {
  const rootReal = nearestExistingAncestorRealpath(options.rootCwd);
  if (rootReal === undefined) {
    return { ok: false, tool, reason: 'cannot resolve project root realpath' };
  }
  const scopeReals = (options.scopePaths ?? []).map(p =>
    nearestExistingAncestorRealpath(resolve(rootReal, p)),
  ).filter((s): s is string => s !== undefined);

  const pathArgs = extractPathArgs(tool, args);
  for (const path of pathArgs) {
    const verdict = checkContainment(path, rootReal, scopeReals);
    if (!verdict.contained) {
      return { ok: false, tool, reason: verdict.reason ?? 'path rejected', path };
    }
  }

  return { ok: true };
}

/**
 * A mutable scope holder: the supervisor sets the current packet's scope
 * before running it, so the turn-level guard can enforce per-packet scope
 * containment without rebuilding the executor per packet.
 */
export class ScopeHolder {
  private current: readonly string[] = [];

  setScope(paths: readonly string[]): void {
    this.current = paths;
  }

  clear(): void {
    this.current = [];
  }

  getScope(): readonly string[] {
    return this.current;
  }
}

/**
 * Wrap a child tool executor with containment enforcement. The returned
 * executor delegates to `inner` only when all path-bearing args are inside
 * the project root (and inside the packet scope, if the scope holder is set).
 */
export function createChildToolExecutorGuard(
  inner: (
    name: string,
    args: Record<string, unknown>,
    abortSignal?: AbortSignal,
  ) => Promise<string>,
  options: GuardOptions & { scopeHolder?: ScopeHolder },
): (
  name: string,
  args: Record<string, unknown>,
  abortSignal?: AbortSignal,
) => Promise<string> {
  return async (name, args, abortSignal) => {
    const scopePaths = options.scopeHolder?.getScope() ?? options.scopePaths ?? [];
    const verdict = evaluateToolCall(name, args, {
      rootCwd: options.rootCwd,
      scopePaths,
    });
    if (!verdict.ok) {
      return JSON.stringify({
        success: false,
        output: '',
        error: `Subagent scope guard rejected ${verdict.tool}: ${verdict.reason}`,
      });
    }
    return inner(name, args, abortSignal);
  };
}
