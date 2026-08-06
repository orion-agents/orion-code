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

import { resolve, relative, isAbsolute, join } from 'path';
import { existsSync, realpathSync, readdirSync, statSync } from 'fs';
import { AsyncLocalStorage } from 'async_hooks';

/** Tools whose arguments carry a single primary path under key `path`. */
const PATH_TOOLS = new Set(['read_file', 'list_files']);

/** Tools whose arguments carry a base/glob root under `path`. */
const BASE_PATH_TOOLS = new Set(['glob']);

/** Tools whose arguments carry a search base under `path`. */
const SEARCH_PATH_TOOLS = new Set(['grep']);

/** Known tools constrained by ToolContext.cwd but not by a narrower packet scope. */
const ROOT_BOUND_TOOLS = new Set(['git_status']);

/** batch_read nests step args; each step has { tool, args }. */
const BATCH_TOOL = 'batch_read';
const BATCH_READ_MAX_STEPS = 8;
const BATCH_READ_ALLOWED_TOOLS = new Set(['git_status', 'list_files', 'glob', 'grep', 'read_file']);

/** Built-ins whose contract is explicitly independent of repository paths. */
const DEFAULT_SCOPE_AGNOSTIC_TOOLS = new Set(['time', 'web_search', 'web_fetch']);

export interface GuardOptions {
  /** Canonical project root (first containment boundary). */
  rootCwd: string;
  /** Canonical scope paths (second, stricter boundary). Empty = root only. */
  scopePaths?: readonly string[];
  /** Explicitly certified pathless tools that may run under a packet scope. */
  scopeAgnosticTools?: readonly string[];
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

/**
 * Resolve an existing or not-yet-created target without dropping its missing
 * suffix. For example, `<root>/src/not-created` canonicalizes to that exact
 * target rather than widening to the existing `<root>/src` ancestor.
 */
function canonicalTargetRealpath(p: string): string | undefined {
  let current = p;
  for (let i = 0; i < 64; i++) {
    if (existsSync(current)) {
      try {
        const ancestorReal = realpathSync(current);
        return resolve(ancestorReal, relative(current, p));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT') return undefined;
      }
    }
    const parent = resolve(current, '..');
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
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
 * Strategy: resolve the path against root, canonicalize its nearest existing
 * ancestor, then append the unresolved suffix. Keeping that suffix is
 * important for missing scope paths: `src/not-created` must not widen to
 * `src`. Existing symlink ancestors are resolved before containment checks.
 */
function checkContainment(
  rawPath: string,
  rootReal: string,
  scopeReals: readonly string[]
): { contained: boolean; reason?: string } {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    return { contained: false, reason: 'empty path' };
  }

  const resolved = resolve(rootReal, rawPath);
  const targetReal = canonicalTargetRealpath(resolved);

  // If no existing ancestor could be resolved (e.g. EACCES on realpathSync),
  // containment cannot be verified — reject the path.
  if (targetReal === undefined) {
    return { contained: false, reason: `cannot verify path containment: ${rawPath}` };
  }

  // Boundary 1: must be inside root.
  if (!isInsideOrEqual(targetReal, rootReal)) {
    return { contained: false, reason: `path escapes project root: ${rawPath}` };
  }

  // Boundary 2: if scopes specified, the target must be inside a scope.
  if (scopeReals.length > 0) {
    const targetInScope = scopeReals.some(scope => isInsideOrEqual(targetReal, scope));
    if (!targetInScope) {
      return { contained: false, reason: `path outside packet scope: ${rawPath}` };
    }
  }

  return { contained: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keep known-tool containment identical to the path accepted by the executor. */
function normalizeKnownToolPath(input: string): string {
  let value = input.trim();

  const markdownLink = value.match(/^!?\[[^\]]*\]\(([\s\S]+)\)$/u);
  if (markdownLink) {
    value = markdownLink[1].trim();
    if (value.startsWith('<')) {
      const end = value.indexOf('>');
      if (end >= 0) value = value.slice(1, end);
    } else {
      value = value.replace(/\s+["'][\s\S]*["']$/u, '');
    }
  }

  if (
    (value.startsWith('`') && value.endsWith('`')) ||
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  if (value.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(value).pathname);
    } catch {
      // Malformed URL or bad percent-encoding: fall back to stripping the
      // scheme so the guard still sees a path to validate. Refusing here
      // would let an unparseable URI bypass containment checks entirely.
      return value.replace(/^file:\/\//u, '');
    }
  }
  return value;
}

interface BatchReadStep {
  tool: string;
  args: Record<string, unknown>;
}

/** Parse batch_read input exactly like the real executor before guarding it. */
function parseBatchReadSteps(rawSteps: unknown): { steps?: BatchReadStep[]; error?: string } {
  let value = rawSteps;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { error: 'steps must be an array or a valid JSON array string' };
    }
  }
  if (!Array.isArray(value)) return { error: 'steps must be an array' };
  if (value.length === 0) return { error: 'steps must not be empty' };
  if (value.length > BATCH_READ_MAX_STEPS) {
    return { error: `steps exceed the ${BATCH_READ_MAX_STEPS}-step limit` };
  }

  const steps: BatchReadStep[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const step = value[index];
    if (!isRecord(step) || typeof step.tool !== 'string' || !step.tool) {
      return { error: `step ${index + 1} requires an object with a tool string` };
    }
    let stepArgs = step.args;
    if (typeof stepArgs === 'string') {
      try {
        stepArgs = JSON.parse(stepArgs);
      } catch {
        return { error: `step ${index + 1} args must be a valid JSON object string` };
      }
    }
    if (!isRecord(stepArgs)) return { error: `step ${index + 1} args must be an object` };
    steps.push({ tool: step.tool, args: stepArgs });
  }
  return { steps };
}

const PATH_LIKE_ARG_KEY =
  /(?:^|_)(?:path|paths|file|files|filepath|filename|directory|directories|dir|cwd|root|base|location|locations|source|sources|destination|destinations|target|targets|uri|uris)(?:$|_)/iu;

/** Detect nested path/file/location/resourceUri shapes without trusting MCP schemas. */
function hasUnknownPathArgs(value: unknown, key = '', inheritedPathContext = false): boolean {
  const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-.]/g, '_');
  const pathContext = inheritedPathContext || PATH_LIKE_ARG_KEY.test(normalizedKey);
  if (typeof value === 'string') {
    if (value.trim().startsWith('file://')) return true;
    if (!pathContext) return false;
    const uriKey = /(?:^|_)(?:uri|uris)(?:$|_)/iu.test(normalizedKey);
    return !uriKey;
  }
  if (Array.isArray(value)) {
    return value.some(item => hasUnknownPathArgs(item, key, pathContext));
  }
  if (!isRecord(value)) return pathContext;
  if (pathContext) return true;

  return Object.entries(value).some(([nestedKey, nestedValue]) =>
    hasUnknownPathArgs(nestedValue, nestedKey, false)
  );
}

/** Match grep's basename-only `glob` filter exactly as the real executor does. */
function matchesGrepGlob(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${regex}$`).test(name);
}

function checkGrepDescendantSymlinks(
  rawBasePath: string,
  rootReal: string,
  scopeReals: readonly string[],
  globPattern?: string
): { contained: boolean; reason?: string; path?: string } {
  const base = resolve(rootReal, rawBasePath);
  try {
    if (!existsSync(base) || !statSync(base).isDirectory()) return { contained: true };
  } catch {
    return { contained: false, reason: `cannot inspect search path: ${rawBasePath}` };
  }

  const pending = [base];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      // Real grep skips unreadable directories rather than searching them.
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (globPattern && !matchesGrepGlob(entry.name, globPattern)) continue;
      if (!entry.isSymbolicLink()) continue;

      try {
        // Real grep checks isFile() immediately before streaming. Directory,
        // dangling and other non-file symlink targets are therefore skipped.
        if (!statSync(entryPath).isFile()) continue;
      } catch {
        // Dangling symlink: `stat` throws, and real grep skips it too.
        continue;
      }

      let targetReal: string;
      try {
        targetReal = realpathSync(entryPath);
      } catch {
        return {
          contained: false,
          reason: `cannot verify search descendant symlink: ${entryPath}`,
          path: entryPath,
        };
      }
      if (!isInsideOrEqual(targetReal, rootReal)) {
        return {
          contained: false,
          reason: `search descendant symlink escapes project root: ${entryPath}`,
          path: entryPath,
        };
      }
      if (scopeReals.length > 0 && !scopeReals.some(scope => isInsideOrEqual(targetReal, scope))) {
        return {
          contained: false,
          reason: `search descendant symlink escapes packet scope: ${entryPath}`,
          path: entryPath,
        };
      }
    }
  }
  return { contained: true };
}

function evaluateResolvedToolCall(
  tool: string,
  args: Record<string, unknown>,
  rootReal: string,
  scopeReals: readonly string[],
  scopeAgnosticTools: ReadonlySet<string>
): GuardVerdict {
  if (tool === BATCH_TOOL) {
    const parsed = parseBatchReadSteps(args.steps);
    if (parsed.error || !parsed.steps) {
      return {
        ok: false,
        tool,
        reason: `invalid batch_read: ${parsed.error ?? 'steps are required'}`,
      };
    }

    for (const step of parsed.steps) {
      if (!BATCH_READ_ALLOWED_TOOLS.has(step.tool)) {
        return {
          ok: false,
          tool,
          reason: `tool ${step.tool} is not allowed in batch_read`,
        };
      }
      const verdict = evaluateResolvedToolCall(
        step.tool,
        step.args,
        rootReal,
        scopeReals,
        scopeAgnosticTools
      );
      if (!verdict.ok) return verdict;
    }
    return { ok: true };
  }

  if (ROOT_BOUND_TOOLS.has(tool)) {
    if (scopeReals.length > 0) {
      return {
        ok: false,
        tool,
        reason: `${tool} is root-bound and unavailable under packet scope`,
      };
    }

    // git_status's published schema has one optional filesystem argument:
    // `cwd`. Other path/workdir-like aliases are ignored by the real tool.
    const rawCwd = args.cwd;
    if (rawCwd === undefined || rawCwd === '') return { ok: true };
    if (typeof rawCwd !== 'string') {
      return { ok: false, tool, reason: `${tool} cwd must be a string` };
    }

    const normalizedCwd = normalizeKnownToolPath(rawCwd);
    const containment = checkContainment(normalizedCwd, rootReal, []);
    if (!containment.contained) {
      return {
        ok: false,
        tool,
        reason: containment.reason ?? 'cwd rejected',
        path: normalizedCwd,
      };
    }
    return { ok: true };
  }

  const knownPathTool =
    PATH_TOOLS.has(tool) || BASE_PATH_TOOLS.has(tool) || SEARCH_PATH_TOOLS.has(tool);
  if (knownPathTool) {
    const rawPath = args.path;
    if (
      scopeReals.length > 0 &&
      (BASE_PATH_TOOLS.has(tool) || SEARCH_PATH_TOOLS.has(tool)) &&
      (typeof rawPath !== 'string' || rawPath.trim() === '')
    ) {
      return {
        ok: false,
        tool,
        reason: `${tool} requires explicit path under packet scope`,
      };
    }

    if (typeof rawPath === 'string') {
      const normalizedPath = normalizeKnownToolPath(rawPath);
      const containment = checkContainment(normalizedPath, rootReal, scopeReals);
      if (!containment.contained) {
        return {
          ok: false,
          tool,
          reason: containment.reason ?? 'path rejected',
          path: normalizedPath,
        };
      }

      if (SEARCH_PATH_TOOLS.has(tool)) {
        const descendants = checkGrepDescendantSymlinks(
          normalizedPath,
          rootReal,
          scopeReals,
          typeof args.glob === 'string' ? args.glob : undefined
        );
        if (!descendants.contained) {
          return {
            ok: false,
            tool,
            reason: descendants.reason ?? 'search descendant symlink rejected',
            path: descendants.path ?? normalizedPath,
          };
        }
      }
    } else if (SEARCH_PATH_TOOLS.has(tool) && scopeReals.length === 0) {
      const descendants = checkGrepDescendantSymlinks(
        '.',
        rootReal,
        scopeReals,
        typeof args.glob === 'string' ? args.glob : undefined
      );
      if (!descendants.contained) {
        return {
          ok: false,
          tool,
          reason: descendants.reason ?? 'search descendant symlink rejected',
          path: descendants.path ?? rootReal,
        };
      }
    }
    return { ok: true };
  }

  if (!scopeAgnosticTools.has(tool)) {
    return {
      ok: false,
      tool,
      reason: `${tool} is not certified scope-agnostic`,
    };
  }
  if (hasUnknownPathArgs(args)) {
    return {
      ok: false,
      tool,
      reason: `${tool} scope-agnostic certification requires pathless arguments`,
    };
  }
  return { ok: true };
}

/**
 * Evaluate whether a tool call is allowed under the guard's boundaries.
 * Pure (modulo realpath reads) so it can be tested in isolation.
 */
export function evaluateToolCall(
  tool: string,
  args: Record<string, unknown>,
  options: GuardOptions
): GuardVerdict {
  const rootReal = nearestExistingAncestorRealpath(options.rootCwd);
  if (rootReal === undefined) {
    return { ok: false, tool, reason: 'cannot resolve project root realpath' };
  }

  const requestedScopes = options.scopePaths ?? [];
  const scopeReals: string[] = [];
  for (const scopePath of requestedScopes) {
    if (typeof scopePath !== 'string' || scopePath.trim() === '') {
      return { ok: false, tool, reason: 'cannot verify packet scope: empty path' };
    }
    const scopeReal = canonicalTargetRealpath(resolve(rootReal, scopePath));
    if (scopeReal === undefined || !isInsideOrEqual(scopeReal, rootReal)) {
      return {
        ok: false,
        tool,
        reason: `cannot verify packet scope: ${scopePath}`,
        path: scopePath,
      };
    }
    scopeReals.push(scopeReal);
  }

  const scopeAgnosticTools = new Set([
    ...DEFAULT_SCOPE_AGNOSTIC_TOOLS,
    ...(options.scopeAgnosticTools ?? []),
  ]);
  return evaluateResolvedToolCall(tool, args, rootReal, scopeReals, scopeAgnosticTools);
}

/**
 * An async-context scope holder. Every parallel child gets its own packet
 * scope, while callers outside a child context retain the legacy root-only
 * behavior (or a scope explicitly entered for that async context).
 *
 * A process-wide mutable `current` value is unsafe here: parallel children
 * overwrite each other's scope, and one child's cleanup can remove another
 * still-running child's boundary. AsyncLocalStorage is available in Node 20
 * and follows the promise/callback chain used by each child run.
 */
export class ScopeHolder {
  private readonly storage = new AsyncLocalStorage<readonly string[]>();

  runWithScope<T>(paths: readonly string[], operation: () => T): T {
    return this.storage.run([...paths], operation);
  }

  setScope(paths: readonly string[]): void {
    this.storage.enterWith([...paths]);
  }

  clear(): void {
    this.storage.enterWith([]);
  }

  getScope(): readonly string[] {
    return this.storage.getStore() ?? [];
  }
}

/**
 * Rewrite approved root-bound cwd arguments to canonical absolute paths before
 * delegation. The git tool passes cwd directly to child_process, where a
 * relative value would otherwise resolve against process.cwd() instead of the
 * guarded project root. batch_read is normalized to its parsed array form so
 * nested git_status calls receive the same protection.
 */
function canonicalizeApprovedArgs(
  tool: string,
  args: Record<string, unknown>,
  rootReal: string
): Record<string, unknown> {
  if (ROOT_BOUND_TOOLS.has(tool)) {
    const rawCwd = args.cwd;
    const normalizedCwd =
      typeof rawCwd === 'string' && rawCwd !== '' ? normalizeKnownToolPath(rawCwd) : '.';
    return { ...args, cwd: resolve(rootReal, normalizedCwd) };
  }

  if (tool === BATCH_TOOL) {
    const parsed = parseBatchReadSteps(args.steps);
    if (parsed.steps) {
      return {
        ...args,
        steps: parsed.steps.map(step => ({
          tool: step.tool,
          args: canonicalizeApprovedArgs(step.tool, step.args, rootReal),
        })),
      };
    }
  }

  return args;
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
    abortSignal?: AbortSignal
  ) => Promise<string>,
  options: GuardOptions & { scopeHolder?: ScopeHolder }
): (name: string, args: Record<string, unknown>, abortSignal?: AbortSignal) => Promise<string> {
  return async (name, args, abortSignal) => {
    const scopePaths = options.scopeHolder?.getScope() ?? options.scopePaths ?? [];
    const verdict = evaluateToolCall(name, args, {
      rootCwd: options.rootCwd,
      scopePaths,
      scopeAgnosticTools: options.scopeAgnosticTools,
    });
    if (!verdict.ok) {
      return JSON.stringify({
        success: false,
        output: '',
        error: `Subagent scope guard rejected ${verdict.tool}: ${verdict.reason}`,
      });
    }
    if (!ROOT_BOUND_TOOLS.has(name) && name !== BATCH_TOOL) {
      return inner(name, args, abortSignal);
    }

    const rootReal = nearestExistingAncestorRealpath(options.rootCwd);
    if (rootReal === undefined) {
      return JSON.stringify({
        success: false,
        output: '',
        error: `Subagent scope guard rejected ${name}: cannot resolve project root realpath`,
      });
    }
    return inner(name, canonicalizeApprovedArgs(name, args, rootReal), abortSignal);
  };
}
