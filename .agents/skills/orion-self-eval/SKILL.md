---
name: orion-self-eval
description: Evaluate Orion Code's own agent loop with real end-to-end conversations and machine checks, then judge a three-tier waterline (structural / conversation-loop / live-model) and emit an optimization backlog.
capabilities:
  - read_file
  - glob
  - grep
  - bash
model-invocable: true
user-invocable: true
---

# Orion Self-Eval

Measure what Orion Code's runtime actually does, not what its docs claim. Produces a
reproducible receipt with a digest so any later run can be compared against this one.

## When to use

- Before opening a release PR, to state a waterline instead of "tests are green".
- After changing the agent loop (tool scheduler, permission, session persistence, prompt
  assembly), to prove the loop still reaches valid terminal states.
- When asked "how good is Orion Code right now" — answer with tiered evidence, never
  with a single number.

## The waterline: three tiers, never conflated

| Tier | Question | Instrument | Needs a paid key? |
| --- | --- | --- | --- |
| T1 structural | Do the runtime's own gates pass, and at what cost? | `npm run bench:harness:eval`, `npm run bench:harness:compare`, `npm run release:check`, `npm test` | no |
| T2 conversation loop | Does a real turn reach a valid terminal state through the production pipeline, with real tools? | `node .agents/skills/orion-self-eval/conversation-eval.mjs` | no (deterministic mock provider) |
| T3 live-model judgment | Is the model's *decisiveness* good (recall / precision / false completion)? | `docs/plan/evidence/v0.3.27/quality/annotation-manifest.json` corpus + `scripts/bench/coding-task-eval.ts` / `live-task-executor.ts` | yes |

**Rule that keeps the verdict honest:** T3 is `not_run` unless a real key *and* a signed
annotation manifest exist. Never substitute fixture or mock results for T3 — the project's
own gate says so (`docs/plan/v0.3.27-plan.md` §9.3: record `not_run`, do not backfill with
fixtures). A "GO" at T1+T2 licenses a statement about the *loop*, not about agent
intelligence. Say which tier you measured.

## Procedure

0. **Fix the base first.** Local `main` goes stale silently — the release automation works
   in worktrees and merges through GitHub, so `refs/heads/main` in the primary checkout can
   lag many already-published versions. Run:
   ```bash
   git fetch origin main
   git rev-list --left-right --count main...refs/remotes/origin/main   # must be 0 N
   ```
   Branch from `refs/remotes/origin/main`, never from a stale local `main`. Verify the base
   actually contains the newest published tag:
   `git merge-base --is-ancestor v0.3.50 refs/remotes/origin/main`.

1. **T1** — run the deterministic gates and keep the numbers:
   ```bash
   npm run bench:harness:eval        # decision + per-check actuals + receiptDigest
   npm run release:check             # branch-name/version/tag consistency gate
   ```
   Reference thresholds already encoded in the repo: input-token reduction ≥30%, task
   success not lower, false-completion rate 0, model-request growth <5, capability
   expansion <10%, local orchestration p95 <5ms (`src/runtime/harness-metrics.ts`,
   frozen schema baseline 6,582 tokens).

2. **T2** — drive real conversations:
   ```bash
   node .agents/skills/orion-self-eval/conversation-eval.mjs
   ```
   It starts `mock-openai-server.mjs` (OpenAI-compatible, streaming + non-streaming),
   writes a throwaway `ORION_CODE_CONFIG_DIR`, builds a scratch workspace from
   `eval-tasks.json` fixtures, and runs the production entry point
   `src/cli.ts -p --output-format json -- <prompt>` once per task. Read
   `.agents/skills/orion-self-eval/last-receipt.json` for per-task observed signals
   (`toolEventCount`, `toolNames`, `toolFailures`, `errorCount`, `budgetStops`,
   `sessionId`, `modelRequests`, `filesAdded`) plus `digest`.
   `--keep-work` retains the scratch workspace and config dir for post-mortem.

3. **T3** — only with a key and signed manifest; otherwise write `not_run` and stop.
   Thresholds when it is legitimately run: recall ≥9/12 per round, precision ≥80%,
   clean-file false positives ≤1/8, ≥18/20 valid terminal states, 3 rounds each reported.

4. **Verdict** — state it per tier, cite the receipt digest, then convert every failing or
   unmeasured tier into a ranked backlog item. Hand the backlog to `orion-rsi-loop` to turn
   into the next iteration.

## Adding a T2 task

Append to `eval-tasks.json`: `prompt`, `fixtures` (path → content), `script` (the ordered
mock steps; use `tool_calls` with `name` + `arguments` to force a real tool through the
scheduler), and `checks`. Prefer **read-only** tools (`glob`, `grep`, `read_file`): print
mode auto-denies interactive permission requests, so a write-tool task tests the denial path
instead of the capability you meant to measure — use it deliberately if that is the point.
Check vocabulary implemented by the driver: `exit_zero`, `content_nonempty`,
`content_matches`, `tool_called`, `tool_not_called`, `no_tool_failures`, `no_errors`,
`no_budget_stops`, `session_persisted`, `max_model_requests`, `no_writes`.

## Failure interpretation

- `parsedResult: false` → print mode emitted non-JSON (crash banner, stderr bleed). Real bug.
- `toolEventCount: 0` while content is confident → **false completion**; the top defect class.
- `toolFailures > 0` with a valid tool name → argument schema drift between the model-facing
  tool spec and the implementation.
- `session_persisted` fail → storage regression; resume/replay is broken.
- `modelRequests` above `max_model_requests` → loop churn (redundant calls, lost context).
