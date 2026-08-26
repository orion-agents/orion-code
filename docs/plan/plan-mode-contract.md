# Plan Mode Lifecycle Contract

## Product contract

Plan mode is a task-scoped collaboration phase, not a durable permission setting.

1. The user enters with `/plan`, starts immediately with `/plan <task>`, or cycles to Plan with
   `Shift+Tab`.
2. Orion changes the visible Agent workflow mode while leaving the independent tool-permission
   policy unchanged.
3. The agent uses any required tools to inspect evidence, validate assumptions, and produce a
   decision-complete implementation plan.
4. The runtime recognizes a decision-complete planning outcome and creates `PlanReceiptV1` in the
   same durable `TurnCommitV1` as history, TaskContext, StopDecision, prompt, capability, and tool
   receipt digests.
5. Orion projects the committed plan, automatically restores the selected Build or Auto mode, and
   exits Plan.
6. The planning turn never begins implementation. Orion starts a separate execution request after
   the plan is saved; no additional user message is required.

`Shift+Tab` cycles `BUILD → PLAN → AUTO → BUILD` without changing the prompt draft. The retired
`/mode` and `/perm` commands, plus model-driven `enter_plan_mode`, are intentionally not
compatibility entry points.
One entry and one completion transition prevent Store/tool-state drift.

## Tool and safety invariants

- BUILD, PLAN, and AUTO expose the same registered tool set. Agent mode is a workflow axis, not a
  tool-availability or permission axis.
- PLAN inherits the current `/permissions` policy and durable project/machine grants. A tool call
  may ask, run, or fail for the same policy reason it would in BUILD; the mode itself never produces
  a block or denial.
- Tool-owned hard denials, explicit allowlist denials, workspace containment, sandbox restrictions,
  and hard command safety policy remain enforced in every mode. AUTO removes interactive prompts;
  it does not bypass those boundaries.
- There is no model-facing `enter_plan_mode` or `exit_plan_mode` tool. A plan becomes ready only
  through the normal Agent Loop and its durable terminal decision.
- An invalid, empty, or uncommitted plan leaves no executable PlanReceipt and does not schedule
  implementation.
- A successful TurnCommit binds the trimmed plan and all relevant receipt digests, restores the
  selected execution mode, and schedules implementation as the next logical request.
- Cycling away from Plan with `Shift+Tab` is an explicit cancellation and discards an unfinished
  plan.

The full precedence and audit contract is defined in
[Agent Mode and Tool Permission Contract](../architecture/agent-mode-permission-contract.md).

## Reference alignment

- [Claude Code permission modes](https://code.claude.com/docs/en/permission-modes) treats Plan as a
  distinct workflow mode and exits it when the plan is accepted. Orion deliberately keeps mode and
  tool authorization independent so project grants remain stable across BUILD, PLAN, and AUTO.
- [Claude Code commands](https://code.claude.com/docs/en/commands) defines `/plan [description]` as
  the task entry.
- [OpenAI Codex](https://openai.com/index/introducing-codex/) emphasizes inspectable evidence and
  verifiable work before execution.

Orion's distinguishing choice is a task-scoped two-phase pipeline: the model submits a
decision-complete plan, then the runtime executes it in a separate request without asking the user
to repeat or resubmit the task.
