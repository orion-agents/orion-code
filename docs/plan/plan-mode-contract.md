# Plan Mode Lifecycle Contract

## Product contract

Plan mode is a task-scoped collaboration phase, not a durable permission setting.

1. The user enters with `/plan`, starts immediately with `/plan <task>`, or cycles to Plan with
   `Shift+Tab`.
2. Orion synchronizes the visible Agent mode and the tool scheduler into read-only Plan state.
3. The agent explores repository evidence and produces a decision-complete implementation plan.
4. The agent calls `exit_plan_mode` exactly once with the final plan.
5. Orion saves the plan, automatically restores the selected Build or Auto mode, and exits Plan.
6. The planning turn never begins implementation. Orion starts a separate execution request after
   the plan is saved; no additional user message is required.

`Shift+Tab` cycles `BUILD → PLAN → AUTO → BUILD` without changing the prompt draft. The retired
`/mode` and `/perm` commands, plus model-driven `enter_plan_mode`, are intentionally not
compatibility entry points.
One entry and one completion transition prevent Store/tool-state drift.

## Safety invariants

- Plan mode permits bounded local reads only. Workspace writes, mutating commands, external calls,
  and tools with missing risk metadata fail closed.
- `exit_plan_mode` changes only in-process plan metadata, so it is the sole non-workspace transition
  allowed through the read-only gate.
- An invalid or empty plan leaves Plan mode active.
- A successful exit stores the trimmed plan, emits a typed lifecycle receipt, restores the selected
  execution mode, and schedules implementation as the next logical request.
- Cycling away from Plan with `Shift+Tab` is an explicit cancellation and discards an unfinished
  plan.

## Reference alignment

- [Claude Code permission modes](https://code.claude.com/docs/en/permission-modes) treats Plan as a
  read-only exploration mode and exits it when the plan is accepted.
- [Claude Code commands](https://code.claude.com/docs/en/commands) defines `/plan [description]` as
  the task entry.
- [OpenAI Codex](https://openai.com/index/introducing-codex/) emphasizes inspectable evidence and
  verifiable work before execution.

Orion's distinguishing choice is a task-scoped two-phase pipeline: the model submits a
decision-complete plan, then the runtime executes it in a separate request without asking the user
to repeat or resubmit the task.
