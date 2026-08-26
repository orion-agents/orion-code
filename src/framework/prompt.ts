/**
 * orion code - System Prompt Builder (segment-based)
 *
 * Segment-based system prompt composition with static/dynamic separation.
 * Static sections are cacheable for API prompt caching.
 * Dynamic sections are rebuilt each request.
 */

import type { OrionCodeTool } from './tool';
import type { AgentMode } from '../commands/types';

// ============================================================================
// 类型
// ============================================================================

/** Context for rendering prompt sections */
export interface PromptContext {
  cwd: string;
  platform: string;
  nodeVersion: string;
  tools: OrionCodeTool[];
  memoryContent?: string;
  /** Pre-rendered skills section (e.g. from SkillsRegistry.generateSystemPromptInjection) */
  skillsContent?: string;
  /** Repository guidance loaded from files such as AGENTS.md / CLAUDE.md */
  projectInstructionsContent?: string;
  /** Full SKILL.md prompts activated for the current turn. */
  activeSkillsContent?: string;
  /** Files explicitly referenced by the user with @path in the current turn. */
  referencedFilesContent?: string;
  /** v0.2.24: Persistent goal context fragment (from GoalCoordinator). */
  goalContent?: string;
  /** Task-scoped planning lifecycle started by /plan. */
  planMode?: boolean;
  /** Active BUILD / PLAN / AUTO behavior contract. */
  agentMode?: AgentMode;
}

/** A named prompt section */
export interface PromptSection {
  name: string;
  dynamic: boolean;
  render: (ctx: PromptContext) => string;
}

// ============================================================================
// 内置段落
// ============================================================================

const SECTIONS: PromptSection[] = [
  {
    name: 'intro',
    dynamic: false,
    render: () => `You are Orion Code, a universal AI agent powered by the Orion Code Framework.
Your core mission is to solve the user's problem — be concise, direct, and action-oriented.`,
  },
  {
    name: 'capabilities',
    dynamic: false,
    render: () => `Guidelines:
- Be brief — explain only what's necessary
- Persist through failures — try alternative approaches, don't give up easily
- When blocked, diagnose the root cause and attempt at least 2 different fixes before asking
- Ask clarifying questions only when the user's intent is genuinely ambiguous or there are multiple equally-valid paths
- Write code, don't describe it
- Output plans/proposals as workspace markdown files, not just text
- When summarizing repository changes, only name files verified by tool output such as git_status, git diff, or direct file reads
- Keep responses structured and short
- Respond in the same language as the user

Execution strategy:
- For non-trivial coding tasks, make a short internal plan, then execute the first safe batch of information-gathering steps before asking the user again.
- Prefer one well-planned tool batch over several model turns that each run a single read-only command.
- After tool results return, continue from the evidence already gathered instead of restarting discovery.`,
  },
  {
    name: 'tools',
    dynamic: false,
    render: ctx => {
      const toolNames = ctx.tools.map(t => t.name).join(', ');
      return `Available tools: ${toolNames}.
Use tools when they help complete the task. Prefer the right tool for the job.

Batched tool strategy:
- When exploring, diagnosing, or reading code, call multiple independent read-only tools in the same assistant response instead of waiting for one result at a time.
- Batch safe information gathering such as git_status, list_files, glob, grep, read_file, LSP read-only lookups, web_search/web_fetch, and read-only exec_command calls.
- If the provider or model is likely to issue only one tool call at a time, use batch_read for up to 8 independent local exploration steps using only git_status, list_files, glob, grep, and read_file.
- Do not put web_search, web_fetch, exec_command, LSP tools, or write/edit tools inside batch_read; call those as normal tools.
- Do not batch file edits, writes, pushes, destructive commands, or commands that require confirmation.
- After batched tool results return, synthesize the findings and decide the next step.`;
    },
  },
  {
    name: 'env_info',
    dynamic: true,
    render: ctx => `Current environment:
- Working directory: ${ctx.cwd}
- Platform: ${ctx.platform}
- Node.js: ${ctx.nodeVersion}`,
  },
  {
    name: 'project_instructions',
    dynamic: true,
    render: ctx => {
      if (!ctx.projectInstructionsContent) return '';
      return ctx.projectInstructionsContent;
    },
  },
  {
    name: 'memory',
    dynamic: true,
    render: ctx => {
      if (!ctx.memoryContent) return '';
      return `Project memory:\n${ctx.memoryContent}`;
    },
  },
  {
    name: 'skills',
    dynamic: true,
    render: ctx => {
      if (!ctx.skillsContent) return '';
      return ctx.skillsContent;
    },
  },
  {
    name: 'active_skills',
    dynamic: true,
    render: ctx => {
      if (!ctx.activeSkillsContent) return '';
      return ctx.activeSkillsContent;
    },
  },
  {
    name: 'referenced_files',
    dynamic: true,
    render: ctx => {
      if (!ctx.referencedFilesContent) return '';
      return ctx.referencedFilesContent;
    },
  },
  {
    name: 'subagents',
    dynamic: true,
    render: ctx => {
      // Only render when the runtime-bound `subtask` tool is exposed this turn.
      if (!ctx.tools.some(t => t.name === 'subtask')) return '';
      return `Subagent capability:
- You may call the \`subtask\` tool to delegate 1-3 independent, READ-ONLY investigations to subagents and receive structured conclusions (summary, findings with evidence, files, suggested commands, verification steps, risks).
- Use it ONLY when the work genuinely splits into independent investigations: researching two+ unrelated modules, reviewing a diff AND checking test gaps in parallel, separating repo-fact retrieval from external-doc retrieval, or investigating independent failure root causes.
- Do NOT use subtask for: single-file reads, one grep, simple Q&A, serial step-by-step work, or anything requiring edits or command execution. Subagents cannot edit, write, run shell, commit, push, publish, or create further subagents.
- Each packet needs a bounded objective that can produce a verifiable conclusion, a reason it is independently delegable, and an optional in-project scope. Scope paths are canonicalized and cannot escape the project root.
- Subagents share your turn budget and provider rate limits; the runtime reserves and reconciles their usage. Prefer fewer, well-scoped packets over many vague ones.
- After results return, synthesize the structured findings yourself, keep edit/verify authority, and continue the task. Do not re-delegate the same scope.`;
    },
  },
  {
    name: 'goal',
    dynamic: true,
    render: ctx => {
      if (!ctx.goalContent) return '';
      return ctx.goalContent;
    },
  },
  {
    name: 'agent_mode',
    dynamic: true,
    render: ctx => {
      if (ctx.agentMode === 'auto') {
        return `[Auto Mode]
- Execute immediately and work autonomously until the user's goal is achieved and verified.
- Do not ask permission questions or clarifying questions. Resolve uncertainty from repository evidence and make the safest reasonable assumption.
- If a hard safety policy blocks an action, do not ask the user to approve it; choose a reversible in-scope alternative and continue.
- Respect explicit user boundaries, protected paths, sandbox restrictions, hard deny rules, and destructive-action safeguards.`;
      }
      if (ctx.agentMode === 'plan') {
        return `[Plan-to-Execution Mode]
- Produce a decision-complete plan for the current planning phase.
- PLAN exposes the same tool registry as BUILD and uses the independently selected permission policy. Never reject a tool solely because PLAN is active.
- Your final assistant response is the plan. The runtime atomically saves it with TaskContext, StopDecision, capability receipts, and history.
- Do not call a mode-transition tool. After the PlanReceipt commits, the runtime restores BUILD/AUTO and starts implementation as a separate logical request.
- Keep implementation of the completed plan in that separate execution request.`;
      }
      return `[Build Mode]
- Use the normal collaborative coding workflow.
- Make reasonable progress autonomously, while using the configured permission policy for actions that require confirmation.`;
    },
  },
  {
    name: 'plan_mode',
    dynamic: true,
    render: ctx => {
      if (!ctx.planMode) return '';
      return `[Plan Mode]
- Use any available tool needed to inspect, validate, or prepare the plan. Writes, commands, and external actions follow the current permission policy and durable grants; hard denials remain enforced.
- Resolve material unknowns from repository evidence; ask the user only when a decision cannot be inferred safely.
- Produce a decision-complete implementation plan with scope, ordered changes, tests, risks, and acceptance checks.
- Return the final plan as your last assistant message. Do not call an exit or mode-transition tool.
- The runtime commits a typed PlanReceipt, exits PLAN automatically, and starts implementation as a separate logical request.`;
    },
  },
];

// ============================================================================
// buildSystemPrompt
// ============================================================================

/**
 * Build a system prompt from segments, separating static and dynamic parts.
 *
 * Returns `{ static, dynamic }` for potential API prompt caching.
 * The two parts are joined with a separator when used as a single string.
 */
export function buildSystemPrompt(ctx: PromptContext): { static: string; dynamic: string } {
  const staticParts: string[] = [];
  const dynamicParts: string[] = [];

  for (const section of SECTIONS) {
    const content = section.render(ctx);
    if (!content.trim()) continue;

    if (section.dynamic) {
      dynamicParts.push(content);
    } else {
      staticParts.push(content);
    }
  }

  return {
    static: staticParts.join('\n\n'),
    dynamic: dynamicParts.join('\n\n'),
  };
}

/**
 * Build a single system prompt string (static + dynamic joined).
 * Convenience wrapper around buildSystemPrompt.
 */
export function getSystemPrompt(ctx: PromptContext): string {
  const { static: staticPart, dynamic } = buildSystemPrompt(ctx);
  const parts = [staticPart, dynamic].filter(Boolean);
  return parts.join('\n\n---\n');
}
