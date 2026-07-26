# v0.1.21 Interruptible Turn & Live Revision

## Goals

v0.1.21 improves the interactive CLI loop in two areas:

- `Ctrl+C` follows a Claude Code-like double-confirm flow before exiting.
- While an agent turn is streaming or executing tools, the user can enter a new instruction and OpenHorse restarts with the latest goal.

The chosen revision behavior is **interrupt and restart, latest input wins**. This prevents concurrent turns from interleaving terminal output, session writes, tool results, and harness state.

## Runtime Design

OpenHorse now owns a single active turn through a CLI-level turn controller.

- `idle`: no active command or chat turn.
- `running`: one input is being handled.
- `aborting`: an interrupt was requested and the active turn is winding down.

When the user submits normal text during `running` or `aborting`, the controller records it as the pending revision, aborts the active turn, and keeps only the latest revision. When the current promise settles, the CLI starts a new turn with that latest revision.

Slash commands are not run concurrently during an active turn. `/exit`, `/quit`, and `/q` still exit immediately; other commands ask the user to interrupt first.

## Abort Propagation

The abort signal is threaded through the runtime:

1. CLI creates an `AbortController` for each turn.
2. `CommandContext.abortSignal` passes it into command handlers.
3. `handleChat` passes it into `query`.
4. `query` passes it into `LLMService.chatStream` and the tool executor.
5. `LLMService.chatStream` passes it to the OpenAI-compatible SDK request options and checks it before processing stream chunks.

Tool execution already accepts `abortSignal`; commands such as shell execution can terminate early when the signal fires. Tools that cannot stop immediately are allowed to settle before the restart begins.

## Session Semantics

Submitted user input is durable. If a turn is interrupted, partial assistant text, tool calls, and tool results from that interrupted turn are not persisted as final assistant history. The restarted revision is stored as a new user message and becomes the source of truth for the next response.

Harness state and session summaries are updated only for completed, non-aborted turns.

## Ctrl+C Behavior

- In multiline input, command palette, file completion, resume picker, or history mode, the first `Ctrl+C` cancels that local interaction.
- During an active turn, the first `Ctrl+C` aborts the turn and shows a second-press exit hint.
- When idle, the first `Ctrl+C` shows a second-press exit hint.
- A second `Ctrl+C` within 2 seconds shuts down the CLI after normal session cleanup.
- `Ctrl+D` on an empty input still exits directly.

## Validation

Automated checks:

- `npm test -- --runInBand tests/turn-controller.test.ts`
- `npm test -- --runInBand tests/query.test.ts tests/llm.test.ts`
- `npm run build`
- `npm test -- --runInBand`

Manual checks:

- Start with `npm run start` or `openhorse`; use `--ui legacy` only for fallback checks.
- Send a slow prompt, then type a new instruction while output is streaming; the first turn should stop and restart with the latest instruction.
- Type several revisions quickly; only the final revision should run.
- Press `Ctrl+C` once while running; the turn should stop without exiting.
- Press `Ctrl+C` twice within 2 seconds while idle; the CLI should exit.
