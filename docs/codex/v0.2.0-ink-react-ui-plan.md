# v0.2.0 Ink/React UI Refactor Plan

## Summary

v0.2.0 replaces the hand-written readline/ANSI interaction layer with an Ink/React UI. The agent core remains unchanged: tools, MCP, skills, session storage, and the Context Harness continue to run through the existing services. The UI becomes a state-driven React surface with transcript, prompt, overlays, picker components, and live turn state.

This follows the OpenClaude architecture in `/Users/hope/ai-project/openclaude`: a root app provider, a REPL screen, prompt input, transcript rendering, reusable select lists, and overlays that never write into the transcript.

## Architecture

- `src/cli.ts` is the bootstrap entry: it loads config, memory, skills, tools, runtime, LLM, and MCP, then launches Ink.
- `src/ink-ui/launch.tsx` renders the Ink app and owns shutdown.
- `src/ink-ui/App.tsx` hosts the REPL screen.
- `src/ink-ui/screens/ReplScreen.tsx` owns transcript state, prompt state, overlays, and turn control.
- `src/ink-ui/controllers/chat-controller.ts` consumes the existing `query()` async generator and converts model/tool/session activity into UI events.
- `src/ink-ui/components/*` renders prompt input, transcript rows, status line, and scrollable pickers.

## Interaction Rules

- The Ink UI is the default renderer. The legacy readline/v2 renderer is removed from the CLI entry in v0.2.0.
- The bottom prompt stays visible while the agent is streaming or using tools.
- Slash palettes, shortcuts, file completion, and session pickers are overlays; they do not become transcript messages.
- Submitted user chat and commands are rendered as transcript entries.
- During an active turn, plain text input is treated as a revision: the current turn is aborted and only the latest revision restarts.
- During an active turn, slash commands other than `/exit` are rejected with a status message.
- `Ctrl+C` cancels overlays first, interrupts a running turn next, and exits only on a second press inside the confirmation window.

## Implementation Phases

1. Add Ink/React dependencies compatible with the current CommonJS + `ts-node` runtime.
2. Replace the CLI entry with an Ink bootstrap and remove the readline keypress renderer from the main path.
3. Add event-driven chat execution that preserves session, skills, tools, MCP, and harness behavior.
4. Implement prompt, transcript, status line, command palette, file picker, session picker, shortcuts overlay, and live revision.
5. Verify with build, unit tests, mocked chat flows, and manual terminal testing.

## Validation

- `npm run build`
- `npm test -- --runInBand`
- `npm run start`
- `npm run start -- --ui ink`

Manual checks: normal chat, streaming while typing, multiline input with Option+Enter, `/` command palette, `@` file picker, `?` shortcuts overlay, `/resume` picker with scrolling, `/harness explain`, tool calls, Ctrl+C interrupt, and resume/compact continuity.
