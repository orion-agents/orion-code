# First-Class Coding Agent Recovery Plan

## Current Diagnosis

OpenHorse has useful agent assets: tools, MCP, skills, session storage, harness,
print mode, doctor, diff, and commit planning. The weak point is the interactive
UI boundary. The current Ink path mixes React rendering with a stdout cursor
proxy. That design guesses terminal state after output has already been written,
so Chinese IME candidate placement, Backspace, streaming output, resize, and
prompt overlays can drift.

The stable scrollback terminal UI is the product default again. It preserves
Backspace, shell scrollback, visible history, and live input restoration with a
lightweight raw editor that owns only the current prompt line. Running turns can
receive a new ordinary input line as a live revision and restart with the latest
instruction while assistant output clears and restores the active prompt. The
renderer-owned TUI remains the explicit advanced path for proving richer
overlays, transcript scrollback, and cursor ownership before it can become the
default.

## Reference Findings

- OpenClaude keeps rendering in `~/ai-project/openclaude/src/ink/`: React nodes
  render into a screen buffer, frames carry cursor state, and `LogUpdate` diffs
  frame-to-frame terminal output.
- OpenClaude parses input in `src/ink/parse-keypress.ts` from raw byte/token
  streams, including incomplete UTF-8, paste mode, terminal responses, and
  modified key sequences.
- Codex keeps the TUI inside a single state machine under
  `~/ai-project/codex/codex-rs/tui/src/`: crossterm input, ratatui frame
  rendering, transcript cells, bottom pane, resize, and cursor are coordinated
  in one renderer boundary.
- OpenClaw's terminal-core separates safe stream writing, restoration, styled
  prompts, and prompt selection. It treats terminal restore and stream output as
  first-class runtime concerns.

## Stop Line

Do not continue productizing the current Ink stdout proxy. It can remain as an
experimental shell, but all future rich UI work should move toward a
renderer-owned TUI core:

- one input adapter owns raw stdin parsing;
- one screen/frame model owns rows, styles, and cursor;
- one renderer diffs frames to terminal output;
- overlays and prompt input are part of the same frame, not extra stdout writes;
- transcript persistence is independent from live overlays.

## Implemented First Slice

Added `src/tui-core/` and `src/tui-ui/`:

- `input-parser.ts`: byte-stream parser for text, paste, Backspace, Delete,
  Ctrl+C, Ctrl+U, Ctrl+W, arrows, page navigation, and split UTF-8 CJK bytes.
- `frame.ts`: minimal frame/screen model with CJK cell width, grapheme-aware
  text writing, frame-owned cursor, and row diff detection.
- `terminal-writer.ts`: pure frame-diff to ANSI writer. It writes only changed
  rows, clears stale row content, and moves the native terminal cursor to the
  frame-declared cursor position at the end of each render batch.
- `src/tui-ui/state.ts`: renderer-independent UI state reducer and
  `UiEventSink` adapter for transcript, live entries, status, processing,
  prompt buffer, command palette, file picker, shortcut overlay, and session
  picker overlay.
- `src/tui-ui/layout.ts`: pure state-to-frame layout for transcript tail,
  live entries, status row, bottom prompt box, frame-owned prompt cursor, and
  live overlays.
- `src/tui-ui/runner.ts`: combines the input parser, UI reducer, frame layout,
  and terminal writer. It handles prompt editing, CJK grapheme Backspace,
  submission, `/` command palette, `@` file picker, `?` shortcuts overlay,
  Tab/Enter completion, Ctrl+C dispatch, resize redraw, and the existing
  `UiEventSink` event contract without stdout side channels.
- `src/tui-ui/launch.ts`: exposes the renderer-owned TUI through
  `openhorse --ui tui`. It owns raw stdin,
  alternate-screen setup/teardown, bracketed paste mode,
  resize redraws, Ctrl+C double-exit semantics, submitted input echo, live
  revision aborts, session picker selection, and the `InkChatController` event
  stream.
- `tests/tui-core.test.ts`: protects CJK split bytes, macOS-style DEL
  Backspace, bracketed paste, CJK row width, wrapping, ANSI row updates, writer
  cursor placement, and cursor-only diffs.
- `tests/tui-ui-state.test.ts`: protects transcript/live-entry separation,
  finalization ordering, prompt/status/picker isolation, scrollback offset
  behavior, and compatibility with the existing controller event sink contract.
- `tests/tui-ui-layout.test.ts`: protects transcript tail rendering,
  PageUp/PageDown scrollback windowing, status and prompt placement, CJK prompt
  cursor calculation, and picker overlay rendering without transcript mutation.
- `tests/tui-ui-runner.test.ts`: protects runner-level CJK input, macOS DEL
  Backspace, prompt submission/reset, event sink rendering, PageUp/PageDown
  transcript scrollback, slash command completion, exact command submit,
  shortcut overlay isolation, file picker completion, and full redraw on
  resize.
- `tests/tui-ui-launch.test.ts`: drives the real launch function with fake TTY
  streams and verifies raw-mode lifecycle, alternate-screen lifecycle, CJK
  prompt editing, and shutdown.
- `tests/tui-ui-pty.test.ts` plus `scripts/tui-ui-pty-smoke.py`: starts
  `npm run start -- --ui tui` in a real PTY and verifies visible CJK input,
  Backspace, command palette completion, shortcut overlay isolation, file
  picker completion, prompt redraw, real OpenAI-compatible streaming, live
  revision abort/restart, tool-call display ordering, `/resume` picker
  navigation, selected-session restore, `/exit`, and terminal restoration.
- `src/terminal-ui/raw-editor.ts`: provides the default scrollback prompt
  editor. It parses raw UTF-8 input through the shared TUI parser, keeps CJK
  input in an owned prompt buffer, restores the prompt after assistant/tool
  output, supports Backspace/Delete/arrows/history/Ctrl+U/Ctrl+W/Tab, and stays
  out of alternate screen.
- `scripts/terminal-ui-pty-smoke.py`: protects the explicit stable terminal
  path. It starts `npm run start` inside a PTY with stale `OPENHORSE_UI=ink`
  environment values, verifies the stable terminal UI is selected, checks
  Chinese input + Backspace, checks streaming-output prompt restore while
  Chinese text is in progress, verifies live revision restart, and exits through
  double Ctrl+C.

This is intentionally below React/Ink. It is the foundation for replacing the
fragile cursor bridge with a renderer-owned terminal layer.

## Next Implementation Path

1. Keep the stable terminal UI as the default until TUI can preserve normal
   shell scrollback or provide an equivalent resume/history experience without
   clearing the user's terminal context.
2. Move model picker, permission prompts, MCP elicitation, and tool approval
   flows into frame overlays managed by the TUI state machine.
3. Add PTY coverage for terminal resize, transcript scrollback, history
   navigation, and command/file overlays under streaming output.
4. Replace `--ui ink` with the new TUI after PTY tests prove CJK IME anchoring,
   Backspace, streaming edits, resize, session resume, scrollback, and exit
   cleanup.
5. Add a Codex-style inline-history renderer so finalized transcript rows can
   survive in normal terminal scrollback without giving up TUI-owned prompt
   rendering.

## Verification Gates

- `npm run build`
- `npm test -- --runInBand tests/tui-core.test.ts`
- `npm test -- --runInBand tests/tui-ui-state.test.ts`
- `npm test -- --runInBand tests/tui-ui-layout.test.ts`
- `npm test -- --runInBand tests/tui-ui-runner.test.ts`
- `npm test -- --runInBand tests/tui-ui-launch.test.ts`
- `npm test -- --runInBand tests/tui-ui-pty.test.ts`
- `npm test -- --runInBand tests/terminal-ui-pty.test.ts`
- `python3 scripts/terminal-ui-pty-smoke.py`
- future: extend `tests/tui-ui-pty.test.ts` with resize, scrollback, and CJK
  composition scenarios

The acceptance bar is not "does not crash". The bar is: no prompt pollution,
no scrollback corruption, no duplicate borders, cursor stays at the editing
position, and conversation history remains recoverable after resume.
