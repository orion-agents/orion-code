/**
 * Orion Code - scoped tool allowlist rule engine.
 *
 * Contract (v0.1.3-2 §1.3 / P1-B / P1-E)
 * ======================================
 *
 * Scope
 * -----
 * Project rules live in `ProjectConfig.allowedTools`; machine-wide rules live in
 * `GlobalConfig.allowedTools`. Both are evaluated for a project and the most
 * restrictive matching effect wins. Project rules win ties for clearer audit
 * attribution.
 *
 * Grammar
 * -------
 *   rule    := [effect ":"] tool [ "(" pattern ")" ]
 *   effect  := "allow" | "ask" | "deny"            (default: "allow")
 *   tool    := exact tool name (e.g. `exec_command`, `write_file`) or `*`
 *   pattern := glob over the tool's canonical subject; `*` = any run of chars,
 *              `?` = exactly one char. Everything else is literal.
 *
 * Tool names are the *real* runtime names (`exec_command`, `read_file`,
 * `write_file`, `edit_file`, `web_fetch`, ...). There is no `Bash(...)` alias.
 *
 * Canonical subject
 * -----------------
 * The subject is the first non-empty string argument found in
 * {@link SUBJECT_ARG_KEYS} order, with runs of whitespace collapsed. For
 * `exec_command` that is the command line, for file tools the path, for web
 * tools the URL. A rule without a pattern matches any subject.
 *
 * Precedence (most restrictive wins, order in the array is irrelevant)
 * -------------------------------------------------------------------
 *   deny > ask > allow
 *
 * A rule with a pattern whose subject cannot be determined matches only for the
 * restrictive effects (`deny`, `ask`); `allow` fails closed and does not match.
 *
 * Safety envelope (enforced by the scheduler, documented here)
 * -----------------------------------------------------------
 * `allow` is an explicit durable user approval and skips later interactive
 * confirmations for that tool. It can never override `checkPermissions() ===
 * 'deny'` or an explicit `ask`/`deny` rule. Agent modes do not remove tools;
 * PLAN inherits the current permission policy and AUTO supplies its own grant.
 *
 * Compatibility
 * -------------
 * Unparseable entries are ignored and reported through `invalid` so callers can
 * surface them; a malformed rule never becomes a silent allow. Configs written
 * before this engine existed contain plain tool names, which keep their natural
 * meaning ("auto-approve this tool").
 */

import {
  getProjectConfig,
  loadGlobalConfig,
  saveProjectConfig,
  updateGlobalConfig,
} from './global-config';

// ============================================================================
// Types
// ============================================================================

/** Effect of a matched allowlist rule. */
export type AllowlistEffect = 'allow' | 'ask' | 'deny';

/** Scope selected by an interactive permission decision. */
export type ToolPermissionScope = 'once' | 'project' | 'global';

export function isToolPermissionScope(value: unknown): value is ToolPermissionScope {
  return value === 'once' || value === 'project' || value === 'global';
}

/** A parsed allowlist rule. */
export interface AllowlistRule {
  /** Original source text, used verbatim in user-facing reasons. */
  source: string;
  effect: AllowlistEffect;
  /** Tool name, or `*` for any tool. */
  tool: string;
  /** Raw subject glob, undefined when the rule has no `(...)` part. */
  pattern?: string;
}

/** Result of evaluating a tool call against the rule set. */
export interface ToolAllowlistMatch {
  effect: AllowlistEffect;
  /** The winning rule's source text (for audit/UI reasons). */
  rule: string;
  /** Present for config-backed evaluations; omitted by pure rule evaluators. */
  scope?: Exclude<ToolPermissionScope, 'once'>;
}

/** Injected into the tool scheduler; pure, no I/O. */
export type ToolAllowlistEvaluator = (
  toolName: string,
  args: Record<string, unknown>
) => ToolAllowlistMatch | undefined;

export interface ParsedAllowlist {
  rules: AllowlistRule[];
  /** Entries that could not be parsed, verbatim. */
  invalid: string[];
}

// ============================================================================
// Parsing
// ============================================================================

const EFFECT_PREFIX = /^(allow|ask|deny)\s*:\s*/i;
const TOOL_NAME_RE = /^[A-Za-z0-9_*][A-Za-z0-9_.-]*$/;
const EFFECT_RANK: Record<AllowlistEffect, number> = { allow: 0, ask: 1, deny: 2 };

/** Argument keys probed, in order, to derive a rule-matching subject. */
export const SUBJECT_ARG_KEYS = [
  'command',
  'file_path',
  'path',
  'url',
  'pattern',
  'query',
] as const;

/**
 * Anchored glob match implemented without regular expressions.
 *
 * A compiled `^...$` RegExp built from a `*`-heavy glob is a catastrophic
 * backtracking (ReDoS) hazard: patterns come from user configuration while
 * subjects come from model-produced tool arguments, so neither side is a
 * trusted constant. The two-pointer algorithm below keeps a single backtrack
 * anchor for the most recent `*`, which bounds the work at
 * O(pattern x subject) with O(1) extra state and no recursion.
 *
 * Comparison walks code points, so an astral character counts as exactly one
 * `?`. `*` spans any run of characters including newlines.
 */
function globMatches(pattern: string, subject: string): boolean {
  const p = Array.from(pattern);
  const s = Array.from(subject);
  let pi = 0;
  let si = 0;
  let starPi = -1;
  let starSi = 0;

  while (si < s.length) {
    const token = pi < p.length ? p[pi] : undefined;
    if (token === '*') {
      starPi = pi;
      starSi = si;
      pi += 1;
    } else if (token === '?' || (token !== undefined && token === s[si])) {
      pi += 1;
      si += 1;
    } else if (starPi >= 0) {
      // Let the most recent `*` swallow one more character and retry.
      starSi += 1;
      si = starSi;
      pi = starPi + 1;
    } else {
      return false;
    }
  }

  while (pi < p.length && p[pi] === '*') pi += 1;
  return pi === p.length;
}

function parseAllowlistRule(entry: string): AllowlistRule | undefined {
  const source = entry.trim();
  if (!source || source.startsWith('#')) return undefined;

  let rest = source;
  let effect: AllowlistEffect = 'allow';
  const prefix = rest.match(EFFECT_PREFIX);
  if (prefix) {
    effect = prefix[1].toLowerCase() as AllowlistEffect;
    rest = rest.slice(prefix[0].length).trim();
  }
  if (!rest) return undefined;

  let tool = rest;
  let pattern: string | undefined;
  const open = rest.indexOf('(');
  if (open >= 0) {
    if (!rest.endsWith(')')) return undefined;
    tool = rest.slice(0, open).trim();
    pattern = rest.slice(open + 1, -1).trim();
    // `tool()` is meaningless: an empty glob would only match an empty subject
    // and is far more likely to be a typo than an intentional rule.
    if (!pattern) return undefined;
  }

  if (!TOOL_NAME_RE.test(tool)) return undefined;
  if (tool.includes('*') && tool !== '*') return undefined;

  return { source, effect, tool, pattern };
}

/** Parse raw `allowedTools` entries. Invalid entries are reported, never applied. */
export function parseAllowlistRules(entries: readonly string[] | undefined): ParsedAllowlist {
  const rules: AllowlistRule[] = [];
  const invalid: string[] = [];
  if (!entries) return { rules, invalid };

  for (const entry of entries) {
    if (typeof entry !== 'string') {
      invalid.push(String(entry));
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const rule = parseAllowlistRule(entry);
    if (rule) {
      rules.push(rule);
    } else {
      invalid.push(trimmed);
    }
  }

  return { rules, invalid };
}

// ============================================================================
// Matching
// ============================================================================

/** Derive the canonical subject a pattern is matched against. */
export function describeAllowlistSubject(
  _toolName: string,
  args: Record<string, unknown> | undefined
): string | undefined {
  if (!args) return undefined;
  for (const key of SUBJECT_ARG_KEYS) {
    const value = args[key];
    if (typeof value === 'string') {
      const normalized = value.replace(/\s+/g, ' ').trim();
      if (normalized) return normalized;
    }
  }
  return undefined;
}

function ruleMatches(rule: AllowlistRule, toolName: string, subject: string | undefined): boolean {
  if (rule.tool !== '*' && rule.tool !== toolName) return false;
  if (rule.pattern === undefined) return true;
  if (subject === undefined) {
    // Unknown subject: restrictive rules still apply (fail closed), permissive
    // ones do not (never auto-approve something we could not inspect).
    return rule.effect !== 'allow';
  }
  return globMatches(rule.pattern, subject);
}

/**
 * Evaluate a tool call against parsed rules.
 * Returns the most restrictive matching rule, or undefined when nothing matched.
 */
export function matchAllowlistRules(
  rules: readonly AllowlistRule[],
  toolName: string,
  args: Record<string, unknown>
): ToolAllowlistMatch | undefined {
  if (rules.length === 0) return undefined;
  const subject = describeAllowlistSubject(toolName, args);

  let winner: AllowlistRule | undefined;
  for (const rule of rules) {
    if (!ruleMatches(rule, toolName, subject)) continue;
    if (!winner || EFFECT_RANK[rule.effect] > EFFECT_RANK[winner.effect]) {
      winner = rule;
      if (winner.effect === 'deny') break;
    }
  }

  return winner ? { effect: winner.effect, rule: winner.source } : undefined;
}

/** Build a pure evaluator from parsed rules. Returns undefined when there is nothing to enforce. */
export function createAllowlistEvaluator(
  rules: readonly AllowlistRule[]
): ToolAllowlistEvaluator | undefined {
  if (rules.length === 0) return undefined;
  const frozen = [...rules];
  return (toolName, args) => matchAllowlistRules(frozen, toolName, args ?? {});
}

// ============================================================================
// Project resolution
// ============================================================================

export interface ResolvedToolAllowlist extends ParsedAllowlist {
  evaluator?: ToolAllowlistEvaluator;
  global: ParsedAllowlist;
  project: ParsedAllowlist;
}

/**
 * Load and compile the allowlist for a project path.
 * Missing/empty configuration yields no evaluator, i.e. unchanged behaviour.
 */
export function resolveProjectToolAllowlist(projectPath: string): ResolvedToolAllowlist {
  let globalEntries: string[] | undefined;
  let projectEntries: string[] | undefined;
  try {
    const config = loadGlobalConfig();
    globalEntries = config.allowedTools;
    projectEntries = config.projects?.[projectPath]?.allowedTools;
  } catch {
    globalEntries = undefined;
    projectEntries = undefined;
  }
  const global = parseAllowlistRules(globalEntries);
  const project = parseAllowlistRules(projectEntries);
  const rules = [...global.rules, ...project.rules];
  const invalid = [...global.invalid, ...project.invalid];
  const globalEvaluator = createAllowlistEvaluator(global.rules);
  const projectEvaluator = createAllowlistEvaluator(project.rules);
  const evaluator: ToolAllowlistEvaluator | undefined =
    globalEvaluator || projectEvaluator
      ? (toolName, args) => {
          const globalMatch = globalEvaluator?.(toolName, args);
          const projectMatch = projectEvaluator?.(toolName, args);
          if (!globalMatch) return projectMatch ? { ...projectMatch, scope: 'project' } : undefined;
          if (!projectMatch) return { ...globalMatch, scope: 'global' };
          return EFFECT_RANK[projectMatch.effect] >= EFFECT_RANK[globalMatch.effect]
            ? { ...projectMatch, scope: 'project' }
            : { ...globalMatch, scope: 'global' };
        }
      : undefined;
  return { rules, invalid, global, project, evaluator };
}

/** Alias with scope-neutral naming for new callers. */
export const resolveToolAllowlist = resolveProjectToolAllowlist;

function appendToolGrant(entries: readonly string[] | undefined, toolName: string): string[] {
  if (!TOOL_NAME_RE.test(toolName) || toolName === '*' || toolName.includes('*')) {
    throw new Error(`Cannot persist permission for invalid tool name: ${toolName}`);
  }
  const parsed = parseAllowlistRules(entries);
  const alreadyGranted = parsed.rules.some(
    rule => rule.effect === 'allow' && rule.tool === toolName && rule.pattern === undefined
  );
  return alreadyGranted ? [...(entries ?? [])] : [...(entries ?? []), `allow:${toolName}`];
}

/** Persist an explicit interactive approval before the waiting tool is resumed. */
export function grantToolPermission(
  scope: Exclude<ToolPermissionScope, 'once'>,
  projectPath: string,
  toolName: string
): void {
  if (scope === 'global') {
    const config = loadGlobalConfig();
    updateGlobalConfig({ allowedTools: appendToolGrant(config.allowedTools, toolName) });
    return;
  }
  const project = getProjectConfig(projectPath);
  saveProjectConfig(projectPath, {
    ...project,
    allowedTools: appendToolGrant(project.allowedTools, toolName),
  });
}
