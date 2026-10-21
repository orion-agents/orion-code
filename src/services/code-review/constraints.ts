/**
 * v0.3.27 PR1 — read-only workflow constraints for code review (plan §5.1).
 *
 * The review turn runs through the normal AgentLoop / ToolGateway, but under
 * immutable workflow constraints: the model only sees bounded read/list/glob/
 * grep capabilities, and every dispatch re-validates against this module so
 * aliases, batch calls, steering or permission escalation (AUTO / ALLOW) can
 * never widen the turn. The constraint set is deny-by-default: a tool that is
 * not explicitly allowlisted is rejected, which covers long-tail tools, MCP,
 * network, task derivation and future additions without maintaining a denylist.
 *
 * PR2 wires this guard into the review workflow's dispatch; PR1 ships the
 * frozen model, its digest, and the negative tests.
 */
import { digestRuntimeValue } from '../../runtime/protocol/canonical';

/** Read-only tools the review turn may use. Only first-party core tools with
 *  `readOnly: true` in their descriptors qualify (plan §5.1); `edit_file`,
 *  `exec_command` and `write_file` are structurally excluded. */
export const REVIEW_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'list_files',
  'glob',
  'grep',
]);

const REVIEW_CONSTRAINT_CONTENT = Object.freeze({
  schemaVersion: 1,
  workflow: 'code-review',
  mode: 'read-only',
  allowedTools: [...REVIEW_ALLOWED_TOOLS].sort(),
  deniedByDefault: Object.freeze([
    'exec_command',
    'write_file',
    'edit_file',
    'git mutations',
    'mcp',
    'network tools',
    'dynamic skills',
    'task derivation',
    'settings mutation',
  ]),
  /** Rationale text is part of the digest: changing the policy changes every
   *  receipt that binds it. */
  policy:
    'The review turn may only inspect the frozen snapshot through the ' +
    'allowlisted read tools. Permission escalation (AUTO / ALLOW) may tighten ' +
    'or maintain but never widen this set. Test commands are not run: they ' +
    'can write caches and mutate the workspace under review.',
});

export interface ReviewWorkflowConstraintsV1 {
  readonly schemaVersion: 1;
  readonly workflow: 'code-review';
  readonly allowedTools: readonly string[];
  readonly constraintsDigest: string;
  readonly policy: string;
}

/** The frozen constraint set with its digest. Receipts and capability
 *  compilations bind this digest so a policy change invalidates old reviews'
 *  rules provenance alongside the rules digest. */
export const REVIEW_WORKFLOW_CONSTRAINTS: ReviewWorkflowConstraintsV1 = Object.freeze({
  schemaVersion: 1,
  workflow: 'code-review',
  allowedTools: REVIEW_CONSTRAINT_CONTENT.allowedTools,
  constraintsDigest: digestRuntimeValue(REVIEW_CONSTRAINT_CONTENT),
  policy: REVIEW_CONSTRAINT_CONTENT.policy,
});

export class ReviewToolPolicyError extends Error {
  constructor(
    message: string,
    readonly code: 'review_tool_denied',
    readonly toolName: string
  ) {
    super(message);
    this.name = 'ReviewToolPolicyError';
  }
}

/** Dispatch-level re-validation. Called on every tool invocation of a review
 *  turn — direct calls, batch calls, aliases and steering all funnel through
 *  here before the gateway executes anything. */
export function assertReviewToolAllowed(toolName: string): void {
  if (!REVIEW_ALLOWED_TOOLS.has(toolName)) {
    throw new ReviewToolPolicyError(
      `Tool "${toolName}" is not available in a read-only code review turn.`,
      'review_tool_denied',
      toolName
    );
  }
}
