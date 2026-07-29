# OpenHorse Development Lessons for Coding Agents

This guide summarizes practical development lessons from the v0.1.21 work. It is written for coding models such as Qwen, Claude, Codex, or other agents that need to modify OpenHorse reliably.

## 1. Start From The Actual Repo State

Always inspect the current branch and dirty files before editing:

```bash
git status --short --branch
rg -n "targetSymbol|relatedBehavior" src tests docs
```

OpenHorse is often developed across several in-progress changes. Do not revert unrelated modified or deleted files. If a file is already dirty, read it carefully and work with the current state.

Prefer local patterns over new abstractions. For example, v0.1.21 reused the existing CLI, query loop, session storage, and UI v2 components instead of replacing the terminal stack.

## 2. Terminal UI Requires Different Discipline

The CLI is not a normal React-style UI. It is a stream of ANSI control codes, cursor movement, saved positions, and redraws. Small output changes can corrupt the whole interaction.

When touching terminal rendering:

- Treat `process.stdout.write`, `console.log`, spinners, prompts, panels, and stream chunks as one shared surface.
- Avoid writing raw output while a live input frame is visible unless you first hide or preserve the frame.
- Use visible-width helpers for CJK text. JavaScript `string.length` is not terminal width.
- Test Chinese input, manual newlines, empty lines, and long lines.
- Test in a real PTY, not only with unit tests.

The v2 input frame should behave like a fixed live input region. Assistant output, tool lines, status text, and user input must not overwrite one another.

## 3. Preserve A Stable Input Frame

The main v2 UI lesson: do not clear the frame by guessing from the current cursor position. With CJK characters, IME behavior, wrapping, and multiline input, cursor math can drift and create artifacts such as:

```text
› 地方
   │ 事地方
   │ 事地方
```

The robust approach is:

- Save an anchor at the top of the frame when drawing it.
- On redraw, restore to that anchor.
- Clear the full previous frame height.
- Draw the new frame from the same origin.
- Then place the cursor using the frame renderer result.

This is more reliable than moving upward from the current cursor row.

## 4. Separate History Echo From Live Input

Submitted user input and the live input box are different UI objects:

- Submitted input becomes conversation history and should be rendered as a complete framed echo.
- The live input frame should immediately reappear empty so the user can type while the agent runs.

For v2, a good submitted echo looks like:

```text
────────────────────
 user message
────────────────────
```

After that, restore the live input frame:

```text
──────────────────── model=glm-5 tokens=0
›
────────────────────
```

Do not leave a bare cursor under `Turn 1...`.

## 5. Keep Status Fixed, Not In The Transcript

Status such as:

```text
model=glm-5  session=f6bcadcf  tokens=4.4K  cost=$0.0012  ctx=2%
```

should not be printed as normal conversation output. In v2, it belongs in the bottom-right of the live input frame. This keeps it visible without polluting history or scrolling away.

Implementation pattern:

- Render a status badge string.
- Pass it into the input frame renderer.
- Update the badge when usage, session, model, cost, or mode changes.
- Redraw the frame instead of `console.log`-ing the status.

## 6. Streaming Output Must Preserve Input

Agent output can arrive as partial chunks. A chunk may end in the middle of a line. If the input frame is redrawn immediately after it, the border can attach to the assistant text.

Use an output helper that:

1. Hides or clears the live input frame.
2. Writes assistant/tool/status output.
3. Tracks the output cursor column.
4. Redraws the live input frame below the output.

This avoids artifacts like:

```text
assistant text────────────────────────
```

Also guard stream callbacks after abort. Once a turn is aborted, late chunks from the old turn should be ignored.

## 7. Interruptible Turns Need One Owner

Do not allow concurrent agent turns. Use a single turn controller with states like:

- `idle`
- `running`
- `aborting`

When the user types during a running turn, treat it as a revision:

- Store only the latest revision.
- Abort the current turn.
- Wait for the current promise to settle.
- Restart with the latest instruction.

This prevents interleaved LLM streams, duplicate session writes, and tool-result races.

## 8. Abort Must Flow Through Every Layer

Cancellation is only real if the same signal reaches the whole execution path:

```text
CLI TurnController
  -> CommandContext.abortSignal
  -> handleChat
  -> query
  -> LLMService.chatStream
  -> toolExecutor / executeTool
```

For model streaming:

- Pass the signal to the OpenAI-compatible SDK request options.
- Check the signal before processing stream chunks.
- Do not persist partial assistant output from aborted turns.

For tools:

- Pass the signal through the tool context.
- Tools that support abort should stop early.
- Tools that cannot stop immediately should settle before the restart begins.

## 9. Session Writes Must Match User Intent

Record submitted user messages, but do not persist partial assistant output from interrupted turns.

Good session behavior:

- Original user input is stored.
- Interrupted assistant partials are not stored as final assistant messages.
- The latest revision is stored as a new user message.
- Harness state and summaries update only after completed non-aborted turns.

This keeps `/resume` from restoring confusing half-responses.

## 10. Manual Newline Edge Cases

Manual multiline input is easy to break. Test all of these:

- Empty input + Shift/Option Enter.
- Text + manual newline.
- Chinese text + manual newline.
- A trailing empty line.
- Repeated newline on an already empty line.
- Backspace across multiline input.

Avoid infinite empty continuation rows. A safe rule is:

- If input is empty, manual newline should not add a line.
- If input already ends with `\n`, another manual newline should not add more blank rows.
- If the current line has content, manual newline is allowed.

## 11. Testing Strategy That Works Here

Use layered validation:

```bash
npm run build
npm test -- --runInBand tests/command-panel.test.ts tests/ui-v2.test.ts
npm test -- --runInBand tests/query.test.ts tests/llm.test.ts
npm test -- --runInBand
```

Then run a real terminal session:

```bash
npm run start
```

Manual scenarios to verify:

- Type while the agent is streaming.
- Submit a revision during streaming.
- Press Ctrl+C once and twice.
- Type `/`, `@`, and `?` while running.
- Enter Chinese multiline text.
- Confirm the status badge remains fixed at bottom-right.

Unit tests catch regressions. PTY testing catches visual truth.

## 12. Good Agent Habits For This Project

When modifying OpenHorse, follow this checklist:

- Read the relevant code before editing.
- Make the smallest coherent change.
- Add targeted tests for the bug class.
- Run build and focused tests first.
- Run the full test suite before final response.
- If changing terminal UI, run a real PTY test.
- Report known warnings separately from failures.
- Never hide dirty worktree state from the user.

## 13. Common Mistakes To Avoid

Avoid these patterns:

- Printing v2 status with `console.log`.
- Starting old spinners in v2 while the live input frame is visible.
- Clearing terminal UI based only on current cursor position.
- Treating `string.length` as visible width.
- Persisting aborted assistant output.
- Starting a new chat turn before the old one has settled.
- Letting slash command panels open while an agent turn is streaming.
- Trusting unit tests alone for terminal UI.

## 14. Development Mindset

OpenHorse is a coding agent, but its user experience depends heavily on small terminal details. A correct implementation is not just one that compiles; it must feel stable while the model is thinking, streaming, aborting, and recovering.

The best workflow is:

1. Understand the user-visible failure.
2. Find the exact shared state or output surface involved.
3. Add one stable owner for that state.
4. Verify with both tests and real terminal interaction.
5. Keep the transcript, session history, and live UI separate.

If another model follows these rules, it will make fewer broad rewrites and produce fixes that survive real use.
