/**
 * SubagentPolicy: deterministic approval gate for `subtask` requests.
 *
 * The root Agent proposes work packages; the runtime decides whether they may
 * run. Every allow/reject decision is recorded with a reason and a budget
 * snapshot, so the policy is auditable rather than hidden in a classifier.
 *
 * Scope canonicalization lives here too: child paths must stay inside the
 * project root. `../`, absolute escapes and symlink escapes are rejected.
 */

import { resolve, relative, isAbsolute, normalize } from 'path';
import { existsSync, realpathSync } from 'fs';
import type {
  SubagentConfig,
  SubagentMode,
  SubagentRole,
  SubtaskPacket,
  SubtaskRequest,
} from './types';
import { SUBAGENT_LIMITS } from './types';

export type PolicyVerdict =
  | { allowed: true; canonicalScope: Map<number, string[]> }
  | { allowed: false; reason: PolicyRejectReason; detail?: string };

export type PolicyRejectReason =
  | 'mode_off'
  | 'not_root_depth'
  | 'explicit_intent_missing'
  | 'too_many_tasks'
  | 'role_disabled'
  | 'objective_unbounded'
  | 'duplicate_scope'
  | 'scope_escape'
  | 'pending_permission'
  | 'parent_aborted'
  | 'budget_exhausted'
  | 'provider_unavailable'
  | 'concurrency_limit'
  | 'empty_request'
  | 'not_eligible_for_delegation';

export interface PolicyContext {
  /** Current delegation depth. Only depth 0 (root) may delegate. */
  depth: number;
  /** Canonical project root the children operate in. */
  cwd: string;
  /** Active config. */
  config: SubagentConfig;
  /** Root objective text, used to detect explicit delegation intent. */
  rootObjective: string;
  /** Subtasks already started in this root turn. */
  tasksStartedThisTurn: number;
  /** Children currently running. */
  runningChildren: number;
  /** A permission request is awaiting user decision. */
  hasPendingPermission: boolean;
  /** Parent turn abort signal has fired. */
  parentAborted: boolean;
  /** Remaining aggregate model-request budget for the turn. */
  remainingModelRequests: number;
  /** Provider gate can reserve a slot for every task in the batch. */
  providerCanReserve: (count: number) => boolean;
}

/**
 * Canonicalize a list of scope paths against the project root.
 *
 * Returns the canonical relative paths for paths that stay inside the root,
 * or `null` if any path escapes (via `..`, absolute outside root, or symlink).
 * Symlink defense only applies to paths that exist on disk: a non-existent
 * path cannot be a symlink escape, and skipping it avoids root/child realpath
 * basis mismatches (e.g. macOS `/tmp` -> `/private/tmp`).
 */
export function canonicalizeScopePaths(
  rootCwd: string,
  paths: readonly string[] | undefined,
): { ok: true; paths: string[] } | { ok: false; reason: 'scope_escape'; path: string } {
  if (!paths || paths.length === 0) return { ok: true, paths: [] };

  const realRoot = realpathSafe(rootCwd);
  const canonical: string[] = [];
  for (const raw of paths) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      return { ok: false, reason: 'scope_escape', path: String(raw) };
    }
    const resolved = resolve(rootCwd, raw);
    const rel = relative(rootCwd, resolved);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return { ok: false, reason: 'scope_escape', path: raw };
    }
    if (existsSync(resolved)) {
      const realResolved = realpathSafe(resolved);
      const realRel = relative(realRoot, realResolved);
      if (realRel.startsWith('..') || isAbsolute(realRel)) {
        return { ok: false, reason: 'scope_escape', path: raw };
      }
    }
    canonical.push(normalize(rel));
  }
  return { ok: true, paths: canonical };
}

function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

const DELEGATION_INTENT_PATTERNS = [
  /\b(parallel|concurrent|separately|independent)\b/i,
  /\b(research|review|investigate|audit)\b/i,
  /\bsub-?agent\b/i,
  /\bsubtask\b/i,
  // CJK patterns: \b word-boundary does not match CJK, so no anchors here.
  /(多个|并行|分别|独立|调研|审查|调查)/,
];

export function hasExplicitDelegationIntent(rootObjective: string): boolean {
  return DELEGATION_INTENT_PATTERNS.some(re => re.test(rootObjective));
}

const UNBOUNDED_OBJECTIVE_PATTERNS = [
  /^(处理一下|继续看看|看一下|随便|帮个忙)/,
  /^\s*(todo|tbd|fixme)\s*$/i,
];

function isObjectiveBounded(objective: string): boolean {
  const trimmed = objective.trim();
  if (trimmed.length < 4) return false;
  if (UNBOUNDED_OBJECTIVE_PATTERNS.some(re => re.test(trimmed))) return false;
  return true;
}

/**
 * Evaluate a `subtask` request against the policy. This is the single
 * deterministic gate every request must pass before any child is queued.
 */
export function evaluateSubtaskPolicy(
  request: SubtaskRequest,
  ctx: PolicyContext,
): PolicyVerdict {
  if (ctx.parentAborted) return reject('parent_aborted');
  if (ctx.hasPendingPermission) return reject('pending_permission');
  if (ctx.depth !== 0) return reject('not_root_depth');
  if (ctx.config.mode === 'off') return reject('mode_off');

  const tasks = request.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) return reject('empty_request');
  if (tasks.length > ctx.config.maxTasksPerTurn) {
    return reject('too_many_tasks', `${tasks.length} > ${ctx.config.maxTasksPerTurn}`);
  }

  if (ctx.config.mode === 'explicit' && !hasExplicitDelegationIntent(ctx.rootObjective)) {
    return reject('explicit_intent_missing');
  }

  // R9: for `auto` mode, require at least two independent investigation
  // directions in the root objective OR a review + test-investigate
  // combination. A single-file read or simple Q&A cannot accidentally
  // delegate. `explicit` mode ensures explicit intent manually; this gate
  // only applies when the model proposes delegation unbidden.
  if (ctx.config.mode === 'auto' && tasks.length === 1) {
    if (!meetsAutoEligibility(ctx.rootObjective, tasks)) {
      return reject('not_eligible_for_delegation',
        'auto mode requires at least 2 independent investigation directions or a review+test-investigate combination');
    }
  }

  const totalTasks = ctx.tasksStartedThisTurn + tasks.length;
  if (totalTasks > ctx.config.maxTasksPerTurn) {
    return reject('too_many_tasks', `turn total ${totalTasks} > ${ctx.config.maxTasksPerTurn}`);
  }

  // Concurrency: a parallel batch must fit within maxParallel alongside running children.
  if (request.execution === 'parallel') {
    if (ctx.runningChildren > 0 && ctx.runningChildren + tasks.length > ctx.config.maxParallel) {
      return reject('concurrency_limit', `${ctx.runningChildren}+${tasks.length} > ${ctx.config.maxParallel}`);
    }
  }

  if (ctx.remainingModelRequests < tasks.length) {
    return reject('budget_exhausted', `need >=${tasks.length} requests, have ${ctx.remainingModelRequests}`);
  }

  if (!ctx.providerCanReserve(tasks.length)) {
    return reject('provider_unavailable');
  }

  const canonicalScope = new Map<number, string[]>();
  const seenScopes = new Set<string>();
  for (let i = 0; i < tasks.length; i++) {
    const packet = tasks[i];
    if (!ctx.config.roles.includes(packet.role)) {
      return reject('role_disabled', packet.role);
    }
    if (!isObjectiveBounded(packet.objective)) {
      return reject('objective_unbounded', packet.objective.slice(0, 40));
    }
    const scope = canonicalizeScopePaths(ctx.cwd, packet.scope?.paths);
    if (!scope.ok) {
      return reject('scope_escape', scope.path);
    }
    const scopeKey = scope.paths.join(',');
    if (scopeKey && seenScopes.has(scopeKey)) {
      return reject('duplicate_scope', scopeKey);
    }
    if (scopeKey) seenScopes.add(scopeKey);
    canonicalScope.set(i, scope.paths);
  }

  return { allowed: true, canonicalScope };
}

function reject(reason: PolicyRejectReason, detail?: string): PolicyVerdict {
  return { allowed: false, reason, detail };
}

/** Clamp a user-provided config value to the enforced bounds. */
export function clampSubagentConfig(config: SubagentConfig): SubagentConfig {
  const clamp = (value: number, bounds: { min: number; max: number }) =>
    Math.max(bounds.min, Math.min(bounds.max, Math.floor(value) || bounds.min));
  const roles: SubagentRole[] = Array.from(new Set(config.roles)).filter(r =>
    (['research', 'review', 'test-investigate'] as SubagentRole[]).includes(r),
  ) as SubagentRole[];
  const clampedRoles = roles.length > 0 ? roles : DEFAULT_ROLES;
  const mode: SubagentMode = ['off', 'explicit', 'auto'].includes(config.mode) ? config.mode : 'auto';
  return {
    mode,
    maxParallel: clamp(config.maxParallel, SUBAGENT_LIMITS.maxParallel),
    maxTasksPerTurn: clamp(config.maxTasksPerTurn, SUBAGENT_LIMITS.maxTasksPerTurn),
    maxTurnsPerTask: clamp(config.maxTurnsPerTask, SUBAGENT_LIMITS.maxTurnsPerTask),
    maxModelRequestsPerTask: clamp(config.maxModelRequestsPerTask, SUBAGENT_LIMITS.maxModelRequestsPerTask),
    maxModelRequestsPerTurn: clamp(config.maxModelRequestsPerTurn, SUBAGENT_LIMITS.maxModelRequestsPerTurn),
    maxToolCallsPerTask: clamp(config.maxToolCallsPerTask, SUBAGENT_LIMITS.maxToolCallsPerTask),
    timeoutMs: clamp(config.timeoutMs, SUBAGENT_LIMITS.timeoutMs),
    roles: clampedRoles,
  };
}

const DEFAULT_ROLES: SubagentRole[] = ['research', 'review', 'test-investigate'];

/**
 * R9: determine whether a single-task `auto` delegation is eligible.
 *
 * A single-packet delegation is only allowed when the root objective shows
 * two or more independent investigation directions (so the model could have
 * proposed multiple tasks but chose one) OR when the packet requests a review
 * or test-investigation with a well-scoped objective. Simple Q&A, single-file
 * reads, or vague "look at" prompts are never eligible.
 *
 * The check is conservative and explainable. `explicit` mode bypasses this
 * gate entirely (the user said "delegate").
 *
 * @returns true if the task meets the minimum eligibility bar.
 */
function meetsAutoEligibility(
  rootObjective: string,
  tasks: SubtaskPacket[],
): boolean {
  if (tasks.length >= 2) return true;

  const task = tasks[0];
  const role = task.role;
  const objective = task.objective;

  // review and test-investigate are inherently multi-faceted: they imply a
  // diff/changeset and test coverage analysis respectively. A single review
  // or test-investigate task is eligible when the objective is concrete.
  if (role === 'review' || role === 'test-investigate') {
    return objective.trim().length >= 10;
  }

  // research: require multiple independent investigation signals in either
  // the root objective or the task's scope/packet details.
  const hasMultiDirectionInRoot = hasMultipleInvestigationDirections(rootObjective);
  if (hasMultiDirectionInRoot) return true;

  // The packet must show at least two independent aspects.
  const scopeCount = task.scope?.paths?.length ?? 0;
  const hintCount = task.contextHints?.length ?? 0;

  return scopeCount >= 2 || hintCount >= 2;
}

/** True if the objective text suggests at least two independent work items. */
function hasMultipleInvestigationDirections(objective: string): boolean {
  const lower = objective.toLowerCase();
  // Conjunctions that signal multiple independent directions.
  const multiMarkers = [
    / and /, /, and /, / or /,
    / both /, / each /,
    / parallel/, /separately/, /independently/,
    / respectively/,
    // CJK: multiple items or separation
    /(和|与|以及|分别|并行|独立|同时)/,
    /(两个|多个|若干|各个|分别)/,
  ];
  return multiMarkers.some(re => re.test(lower));
}
