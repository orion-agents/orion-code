# Agent Mode and Tool Permission Contract

## Decision

Orion models workflow mode and tool authorization as two independent axes.

| Workflow mode | Purpose                         | Tool registry     | Authorization behavior                                               |
| ------------- | ------------------------------- | ----------------- | -------------------------------------------------------------------- |
| BUILD         | Normal implementation           | Complete registry | Uses the selected permission policy and durable grants               |
| PLAN          | Evidence gathering and planning | Complete registry | Uses the same policy as BUILD; the mode itself never blocks a tool   |
| AUTO          | Unattended execution            | Complete registry | Approves every invocation after hard policy and explicit-deny checks |

Goal is an objective lifecycle layered over the selected base mode. It does not change this
authorization contract.

## Precedence

Authorization is resolved in this order:

1. A tool-owned hard denial always wins.
2. An explicit project or machine `deny` always wins.
3. AUTO approves the remaining invocation without an interactive prompt.
4. Outside AUTO, durable grants, mode-specific edit handling, and interactive confirmation apply.

Workspace containment, OS sandboxing, command safety, input validation, and runtime capability
guards remain active in every mode. AUTO is therefore prompt-free, not policy-free.

Network-backed tools and `subtask` research in `web` or `mixed` mode follow the same rule. AUTO
authorizes them after the two denial layers above; BUILD and PLAN follow the selected permission
policy. A project that must prohibit network access should add an explicit deny for the relevant
tool or capability.

## Observability

Every scheduled invocation emits a typed permission decision. The trace and renderer-neutral tool
activity carry the authorization source (for example `mode_auto`, `allowlist_allow`, or `user`).
Terminal output shows `Authorization: <source>` and the TUI tool metadata shows `auth <source>`.
This makes prompt-free AUTO executions auditable without inferring policy from prose.

## Compatibility decision

This contract supersedes the v0.1.4 research-plan wording that required a separate interactive
confirmation for WebSearch/WebFetch while in AUTO. That wording conflicts with Orion's adopted
AUTO product behavior: full unattended authorization subject to hard denials and explicit user
boundaries. A future capability sandbox may add a separate network-policy axis, but it must not
silently overload workflow mode.

## Regression requirements

- AUTO external research resolves to `allow` with source `mode_auto` and never opens a prompt.
- BUILD/PLAN retain their independently configured permission behavior.
- Explicit deny and hard tool policy remain stronger than AUTO.
- Authorization provenance survives query, transcript, terminal/TUI/print, trace, and protocol
  projections.
