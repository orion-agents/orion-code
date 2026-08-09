/**
 * Built-in subagent role presets: system prompts and tool allowlists.
 *
 * v0.2.20 ships read-only investigation roles. Every role's allowlist is the
 * intersection of (read-only tools) and (role-appropriate tools). No role
 * receives exec_command, write/edit, memory mutation, or the recursive
 * `subtask` capability - this is enforced structurally, not by prompt alone.
 */

import type { SubagentRole } from './types';
import type { OrionCodeTool } from '../../framework/tool';

/** Read-only investigation tools available to children in v0.2.20. */
export const READ_ONLY_INVESTIGATION_TOOLS = [
  'read_file',
  'list_files',
  'glob',
  'grep',
  'batch_read',
  // MCP tools are intentionally excluded. `readOnlyHint` says whether a tool
  // mutates remote state, but does not certify that its arguments are pathless
  // or constrained to the packet scope. Dynamic MCP exposure can return only
  // after the runtime has explicit path-scope capability metadata.
] as const;

/**
 * Tools a child must NEVER receive. Kept as an explicit deny-set so the
 * supervisor can assert that a filtered tool list contains none of these,
 * even if future tools are added upstream.
 */
export const SUBAGENT_FORBIDDEN_TOOLS = [
  'exec_command',
  'edit_file',
  'write_file',
  'memory_save',
  'memory_recall',
  'memory_forget',
  'orion-code',
  'subtask',
  // Generic MCP escape hatches. First-class mcp__ tools are also rejected by
  // filterToolsForRole/assertNoForbiddenTools until path-scope metadata exists.
  'mcp_call',
  'mcp_list',
  // Cross-session information leak: history_search reads transcripts from
  // all projects. Children must never access session history.
  'history_search',
] as const;

export interface RolePreset {
  role: SubagentRole;
  /** Tool names the child may use. */
  tools: readonly string[];
  /** System prompt enforcing the role's contract and JSON output schema. */
  systemPrompt: string;
}

const JSON_OUTPUT_CONTRACT = `
You MUST end your investigation by emitting a single JSON object and nothing else after it, matching this schema:

{
  "summary": "one concise paragraph of the overall conclusion",
  "findings": [{ "severity": "critical|high|medium|low|info", "title": "short", "evidence": "specific file:line or quoted fact", "file": "optional path", "line": 0 }],
  "files": ["paths you inspected or that are relevant"],
  "commands": [{ "command": "suggested read-only or root-owned command", "purpose": "why" }],
  "verification": ["how the root Agent can verify your conclusion"],
  "risks": ["caveats, unknowns, or things that could invalidate this"]
}

Rules:
- Every finding must cite concrete evidence (file path, line, quoted text, or command output you observed). Do not speculate.
- "commands.executed" is always false; you may only SUGGEST commands for the root Agent to run. Never claim you executed one.
- You cannot edit, write, delete, commit, push, publish, install dependencies, run tests, or create further subagents.
- If you cannot reach a confident conclusion, say so in "risks" rather than fabricating evidence.
- Keep the JSON valid and self-contained. No trailing prose.`;

export const ROLE_PRESETS: Record<SubagentRole, RolePreset> = {
  research: {
    role: 'research',
    tools: READ_ONLY_INVESTIGATION_TOOLS,
    systemPrompt: `You are a read-only research subagent for Orion Code. Your job is to gather repository facts, official documentation, or API behavior and return a structured conclusion.

You may only read files, list/glob/grep, and batch repository read-only steps exposed by the runtime. You may inspect git state only through read-only means available to you.

Focus narrowly on the objective you were given. Do not attempt edits or commands.${JSON_OUTPUT_CONTRACT}`,
  },
  review: {
    role: 'review',
    tools: READ_ONLY_INVESTIGATION_TOOLS,
    systemPrompt: `You are a read-only code review subagent for Orion Code. Your job is to review a diff, changeset, or code area for risks, regressions, and test gaps, and return a structured conclusion.

You may read files, list/glob/grep, and batch repository read-only steps. You may NOT fix code, change review scope, execute shell, use MCP tools, or commit.${JSON_OUTPUT_CONTRACT}`,
  },
  'test-investigate': {
    role: 'test-investigate',
    tools: READ_ONLY_INVESTIGATION_TOOLS,
    systemPrompt: `You are a read-only test investigation subagent for Orion Code. You analyze failing test logs, test code, and configuration to identify likely root causes, and return a structured conclusion.

You may read files, list/glob/grep, and batch repository read-only steps. You may NOT execute tests, use MCP tools, install dependencies, update snapshots, write fixtures, or publish. If a command would help diagnose the failure, suggest it in "commands" for the root Agent to run.${JSON_OUTPUT_CONTRACT}`,
  },
};

/** Resolve the tool allowlist for a role. Falls back to the read-only set. */
export function toolsForRole(role: SubagentRole): readonly string[] {
  return ROLE_PRESETS[role]?.tools ?? READ_ONLY_INVESTIGATION_TOOLS;
}

/** Resolve the system prompt for a role. */
export function systemPromptForRole(role: SubagentRole): string {
  return ROLE_PRESETS[role]?.systemPrompt ?? ROLE_PRESETS.research.systemPrompt;
}

/**
 * Filter an upstream tool list to a role's allowlist, removing any forbidden
 * tool, every dynamic first-class MCP tool, and the recursive `subtask`
 * capability. `readOnlyHint` is not a path-containment capability, so it must
 * not make an MCP tool child-visible.
 *
 * Returns the names the child may receive; the caller is responsible for
 * resolving them to tool definitions.
 */
export function filterToolsForRole(
  availableToolNames: readonly string[],
  role: SubagentRole,
  _runtimeTools?: readonly OrionCodeTool[]
): string[] {
  const allowed = new Set(toolsForRole(role));
  const denied = new Set<string>(SUBAGENT_FORBIDDEN_TOOLS);

  return availableToolNames.filter(name => {
    // Explicitly denied tools are never allowed.
    if (denied.has(name)) return false;

    // First-class MCP tools remain unavailable even with readOnlyHint=true:
    // read-only does not prove project-root or packet-scope containment.
    if (name.startsWith('mcp__')) return false;

    // Static allowlist covers non-MCP tools.
    return allowed.has(name);
  });
}

/** Assert a filtered tool list contains no forbidden tool. Used by the runner. */
export function assertNoForbiddenTools(toolNames: readonly string[]): void {
  const denied = new Set<string>(SUBAGENT_FORBIDDEN_TOOLS);
  const found = toolNames.filter(name => denied.has(name) || name.startsWith('mcp__'));
  if (found.length > 0) {
    throw new Error(`Subagent tool list contains forbidden tools: ${found.join(', ')}`);
  }
}
