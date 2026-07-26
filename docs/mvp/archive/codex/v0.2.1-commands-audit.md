# v0.2.1 Commands Audit and UI Plan

## Goal

OpenHorse v0.2.x uses the Ink UI as the primary interface, so slash commands should behave like a compact product menu rather than a flat debug registry. The command palette must prioritize coding-agent workflows, keep session recovery discoverable, and hide legacy entry points that duplicate normal chat behavior.

## Command Groups

### Workflow

Primary coding actions that should appear first in `/`:

- `/review [scope]` routes to the review skill/chat workflow.
- `/security [scope]` routes to security review.
- `/test-gen [scope]` routes to test generation.
- `/todos` shows the current agent todo state.

These commands are shortcuts for common coding-agent intentions. They should not fork separate agent runtimes.

### Session

Session lifecycle commands:

- `/resume [number|session-id|name]`
- `/sessions`
- `/session-rename <ref> <name>`
- `/compact [threshold]`
- `/clear-history`

These are still core because long-running coding work depends on resume, compact, and recovery.

### Context

Commands that explain or repair agent context:

- `/harness [explain]`
- `/skills`
- `/memory [reindex]`

These should remain visible because OpenHorse differentiates itself through harness, skills, and persistent context.

### Tools

Runtime tool visibility:

- `/tools` lists built-in and MCP tools.
- `/mcp` shows MCP server status.
- `/safety` shows the safety/audit checker state.

### Model and Mode

Runtime configuration:

- `/model [model|list|help]`
- `/mode [default|accept-edits|plan|auto|next]`
- `/config`

`/mode` is important for coding agents because it controls whether the agent plans, asks, edits, or runs more autonomously.

### System and Diagnostics

Operational commands:

- `/help`, `/status`, `/clear`, `/exit`
- `/usage`, `/cost`, `/agents`

## Hidden Legacy Commands

- `/chat` is redundant in Ink because plain text already means chat.
- `/task` and `/run` duplicate the normal agent loop and expose an older task-manager abstraction.

They remain executable for compatibility but are hidden from help, palette, and suggestions.

## Missing Commands for Future Versions

- `/permissions`: richer permission policy editor; currently `/mode` is the lightweight equivalent.
- `/context`: concise current prompt/context capsule view, distinct from detailed `/harness`.
- `/branch`: show or switch coding branch workflow.

## Implemented Since This Audit

- `/doctor`: configuration, MCP, tool, model, skills, project rules, session, harness, and context-size health check.
- `openhorse doctor --output-format json`: non-interactive diagnostics for scripts and remote harnesses.
- `/diff`: deterministic staged/unstaged/untracked Git workspace summary.
- `openhorse diff --output-format json`: non-interactive workspace change report for scripts and higher-level automation.
- `/commit`: read-only commit plan and suggested commit message.
- `openhorse commit --output-format json`: non-interactive commit plan for scripts and higher-level automation.

## v0.2.1 Implementation Notes

Commands now carry category and priority metadata. `getVisibleCommands()` returns the sorted user-facing command list, while hidden legacy commands remain available through `findCommand()`. The Ink command palette shows command categories in descriptions and argument hints in labels, matching the new UI’s menu-style interaction.
