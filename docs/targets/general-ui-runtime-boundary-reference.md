# UI Runtime Boundary Target

## Target

Orion Code should support multiple UI renderers without changing coding-agent behavior.
The primary product UI is the stable `terminal` renderer. This is the mainline
daily-use interface and the release-quality target for near-term Orion Code work.

`ink` and `tui` are experimental beta renderers. They are useful for validating
component models, fullscreen interaction, cursor handling, resize behavior, and
future UI architecture, but they are not the primary product UI yet.

`print` mode and remote UI are future iteration targets. They should follow the
same runtime protocol when developed, but they are not part of the current
interactive UI completion scope.

All renderers may look different, but they must drive the same agent runtime,
tool system, harness, session lifecycle, permissions, MCP, and skills behavior.

## Core Principle

There must be one agent brain and many UI shells.

```text
Agent Runtime Core
  harness / query / tools / MCP / skills / session / permissions / turn control
        ^
        |
UI-independent Agent Event Protocol
        |
        v
terminal stable UI / Ink beta / TUI beta / print future / remote UI future
```

If the same user input behaves differently because of the selected renderer, that is a bug unless the difference is explicitly presentation-only.

## Runtime-Owned Capabilities

These capabilities must live below the UI layer:

- User intent tracking and harness context assembly.
- Prompt construction, project instructions, file references, and skill injection.
- Tool availability, MCP tool discovery, and tool execution.
- Permission policy and tool confirmation semantics.
- Turn lifecycle: idle, running, interrupting, abort, retry, live revision, completion.
- Session persistence, resume, compact, transcript display boundaries, and summaries.
- Partial assistant persistence rules, especially aborted-turn cleanup.
- Slash command business semantics such as `/resume`, `/compact`, `/harness explain`, `/model`, `/mcp`, `/skills`, and `/permissions`.
- Ordered runtime events for assistant deltas, tool calls, tool results, errors, status, and diagnostics.

## UI-Owned Responsibilities

Renderers may own only presentation and local interaction mechanics:

- Prompt visual style, borders, colors, and status placement.
- Fullscreen vs scrollback behavior.
- Picker presentation for commands, sessions, models, files, and permissions.
- Markdown rendering style, tool folding, and transcript layout.
- Keyboard shortcuts and local editing mechanics, as long as submitted intent is identical.
- Terminal-specific cursor, IME, resize, and scrollback handling.

## Required Renderer Parity

The stable `terminal` UI must satisfy full runtime parity. Beta and future
renderers must use the same runtime contract for every feature they expose, even
when their visual polish or feature coverage is incomplete.

The shared runtime contract covers:

- Submitting normal chat input.
- Submitting slash commands.
- Sending live revision input during a running turn.
- Interrupting and exiting with Ctrl+C semantics.
- Responding to tool permission requests.
- Selecting sessions, models, files, and command palette entries.
- Displaying ordered assistant/tool/status/error events.

Print mode is a future non-interactive renderer target. When it is developed
further, it must fail explicitly when interaction is required and provide a
deterministic non-interactive alternative, such as `/resume <session-id>`.

## Anti-Patterns

Avoid these patterns:

- Implementing separate tool confirmation behavior per UI.
- Reimplementing live revision turn control inside each renderer.
- Letting a renderer decide which tools, MCP servers, or skills exist.
- Letting UI display state mutate session or harness state directly.
- Persisting transcript differently depending on renderer.
- Treating a visual picker as the source of command semantics.
- Fixing terminal rendering bugs by changing agent behavior.

## Target Architecture

Introduce a UI-independent agent protocol:

- `AgentRuntimeInput`: submitted prompt, slash command, interrupt, permission decision, picker decision, resize-independent metadata.
- `AgentRuntimeEvent`: user echo, assistant delta, assistant done, tool requested, tool started, tool finished, permission requested, picker requested, status, error, session restored, harness diagnostics.
- `AgentRuntimeController`: owns turn lifecycle, command dispatch, query execution, permissions, session updates, and harness updates.
- Renderer adapters: translate local UI input into `AgentRuntimeInput` and render `AgentRuntimeEvent`.

Renderer code should become replaceable. A new UI should not need to know how `query`, `harness`, `skills`, or `MCP` work.

## Current Implementation

The first runtime boundary is now represented by `src/runtime/agent-runtime-controller.ts`.
It owns shared turn semantics for the stable `terminal` renderer, while `ink`
and `tui` consume the same protocol as beta experiments:

- `src/runtime/agent-runtime-protocol.ts` defines `AgentRuntimeInput`,
  `AgentRuntimeEvent`, result types, and adapters between structured runtime
  events and the legacy `UiEventSink` contract.
- `src/runtime/ui-events.ts` exposes `OpenHorseUiRuntime` as the shared runtime
  context for every renderer; renderer-specific historical aliases must remain
  compatibility-only.
- Single active turn enforcement.
- Live revision with abort and latest-input restart.
- Ctrl+C interrupt and double-confirm exit.
- Processing state updates.
- Submitted user echo policy, configurable per renderer.
- Session picker selections flow through `AgentRuntimeInput.type =
  "select_session"`; renderers pass the chosen session id instead of rebuilding
  `/resume` command syntax locally.
- Slash command results that need visual interaction use the same
  `SessionPickerRequest` and `EditPreviewRequest` structures as runtime events,
  so command semantics do not fork per renderer.
- Renderer adapters declare presentation capabilities through
  `UiRendererCapabilities`; slash commands consume those capabilities instead of
  branching on concrete renderer names. Default capability resolution lives in
  `src/runtime/ui-events.ts`.
- Tool confirmation can flow through `AgentRuntimeEvent.type =
  "permission_requested"` and `AgentRuntimeInput.type = "permission_decision"`;
  terminal uses this as the product path, and Ink/TUI use it as beta protocol
  validation instead of providing renderer-local `confirmToolUse`
  implementations. Future print mode should deterministically deny interactive
  permission requests and report the non-interactive failure.
- Shared `AgentChatController` runner entry into query, tools, skills, MCP, harness, and session persistence.

Renderer launchers should act as adapters:

- `src/terminal-ui/launch.ts` owns the primary stable daily-use scrollback
  prompt behavior, `$EDITOR`, multiline composer, and terminal
  tool-confirmation prompt.
- `src/ink-ui/screens/ReplScreen.tsx` owns beta React state, prompt layout,
  overlays, native cursor, and transcript rendering experiments.
- `src/tui-ui/launch.ts` owns beta alternate-screen setup, terminal resize, raw
  input, and TUI runner rendering experiments.
- `src/print-ui/launch.ts` is a future non-interactive text/JSON output target,
  not a current interactive product UI. Its prompt submission, permission
  denial, session picker failures, and runtime events should route through the
  shared controller/protocol when that mode is developed further.

Remaining boundary work: keep hardening the terminal product UI first. Print
mode and future remote renderers should later expose deterministic
non-interactive permission decisions or remote permission prompts through the
same runtime protocol. Visual polish can differ, but the permission decision
semantics must stay runtime-owned.

New UI work should extend this controller/event boundary instead of reintroducing renderer-local turn loops.

## UI Strategy

Make the stable terminal renderer the main product path while preserving beta
renderer experiments behind explicit selection:

- `terminal`: primary stable scrollback-first UI for daily use, reliable shell
  history, predictable IME behavior, and release-quality coding-agent workflows.
- `ink`: experimental beta React-based UI for rapid component exploration. It
  should not be treated as the default product UI until it reaches terminal
  parity.
- `tui`: experimental beta renderer-owned UI for professional terminal behavior
  research, including precise cursor, resize, overlays, and transcript control.
- `print`: later non-interactive mode for automation, scripts, CI, and logs.
- `remote UI`: later renderer target for external clients, web surfaces, or
  daemon-style control.

The long-term product decision can change, but the near-term execution focus is
terminal UI quality. Ink/TUI experiments must not divert runtime semantics or
make terminal behavior regress.

## Acceptance Criteria

The stable `terminal` renderer is release-ready only when these checks pass:

- Same prompt produces the same model/tool/harness/session behavior across renderers.
- Tool confirmation policy is identical across renderers.
- Live revision aborts the same turn and persists the same final transcript.
- `/resume` restores the same session and harness state.
- `/compact` produces the same compact/session semantics.
- Tool events preserve chronological order in every renderer.
- Aborted assistant partial output is not persisted as a completed assistant message.
- Renderer-specific tests cover cursor, resize, IME, scrollback, and overlay behavior without changing runtime tests.

Ink/TUI beta renderers are acceptable when they do not break the shared runtime
contract and their known UI gaps are documented. They do not block terminal UI
release readiness unless a runtime-level regression is found.

Print/remote UI work is accepted in later iterations only after it proves the
same runtime semantics through deterministic non-interactive or remote-control
tests.

## Development Rule

When adding a new coding-agent feature, implement it in runtime first, then expose it through renderer adapters.
When adding a new UI feature, prove it does not change runtime behavior.
