---
name: orion-rsi-loop
description: Turn an Orion Code self-eval waterline into the next self-improvement iteration — pick the highest-leverage gap, enforce the release guardrails, and leave behind an instrument that measures the following cycle.
capabilities:
  - read_file
  - glob
  - grep
  - bash
model-invocable: true
user-invocable: true
---

# Orion RSI Loop

Recursive self-improvement for this repository: `orion-self-eval` measures the agent, this
skill converts the measurement into the next change, and the next measurement must be able to
prove the change helped. A cycle that cannot be re-measured did not happen.

## Input

A self-eval receipt (`last-receipt.json`) plus the current `docs/goals/orion-code-项目级目标.md`.
Start by restating, in one line each: which tiers are GO, which are `not_run`, and the digest
you will compare against next cycle.

## Choosing what to improve (rank, do not grab the first item)

Score every candidate gap:

1. **Blocked tier** — does it unlock a tier that is currently unmeasurable? A measurement gap
   outranks a feature gap: an unmeasured dimension cannot be ratcheted.
2. **Loop integrity** — false completion, permission-path breaks, session persistence,
   unreached terminal states. These are the agent's own body; regressions here poison every
   later measurement.
3. **Harness cost** — prompt/schema tokens, model-request growth, orchestration p95. Improving
   these is verifiable in T1 without a key.
4. **Delivery integrity** — version/tag/registry/CHANGELOG/Release consistency and stale-base
   traps. Low glamour, high blast radius: a published artifact that is not on the trunk you
   branch from invalidates every subsequent iteration.
5. **Product surface** — new capability. Only after 1–4 are clean for three consecutive cycles.

Reject a candidate if the only evidence for it is self-report (the agent's own prose claiming
success). Reject a candidate whose fix is *weakening a check* — see Guardrails.

## Per-iteration procedure

1. `git fetch origin main` and branch from `refs/remotes/origin/main` in a dedicated worktree
   (`../orion-code.worktrees/<name>`). Never branch from local `main`: it lags published
   versions silently. Link `node_modules` if the worktree lacks it, and confirm it is not a
   dangling symlink before running `tsc`.
2. Write the plan first: `docs/plan/<name>-plan.md` with task breakdown, touched files,
   acceptance criteria, and the measurement that will prove it.
3. Implement with the narrowest change that moves the chosen signal. Add or update a Jest test
   for behavior changes; a new search path, tool schema, or scheduler rule needs a test that
   would fail if the rule were removed.
4. Validate before proposing: `npx tsc --noEmit`, `npm run lint`, the targeted suites, full
   `npm test`, `npm run build`, `npm run release:check`, then re-run `orion-self-eval` T1+T2 and
   record the new receipt digest next to the old one.
5. `git add` **by explicit path** — never `-A`. The primary checkout routinely holds the user's
   uncommitted drafts; they must not ride along in a commit or a release tarball.
6. Push the branch, open a PR with `gh` (the GitHub MCP `create_pull_request` is 403 here), and
   **stop for review**. Do not merge autonomously. Merge only after CI is green job-by-job, and
   only when a re-run has proven that any single red is a flake rather than a real failure.
7. Version consumption: a cycle whose delta is docs/receipts only does **not** bump a version,
   tag, publish, or create a Release. Product delta in `src/`, `web/`, `tests/` is what earns a
   version number.

## Guardrails (each one exists because the failure is easy and silent)

- **No ratchet laundering.** Never "fix" a failing check by loosening its threshold or deleting
  the assertion. If a threshold is genuinely wrong, change it in a dedicated commit whose only
  purpose is that, with the reasoning in the message, so it is visible in review.
- **Separate evidence from narration.** Every number in a report must come from a command's
  output in the same cycle, never from a previous cycle's summary or from memory.
- **Distinguish environment contention from regression.** Known flake families (PTY suites,
  cross-process locks, settings watchers) must be re-run in isolation and labelled before they
  are believed; PTY suites time out in sandboxes and block later steps in the same command.
- **A missing key is `not_run`, not a pass.** Recording T3 as satisfied because fixtures were
  green is the single most damaging failure mode of this loop.
- **Publish from a clean worktree.** Never from a dirty checkout: `npm pack` packs the working
  tree, which can ship someone's uncommitted draft. Verify the tarball sha against the CI receipt
  before publishing.
- **Declare blocked only after three consecutive cycles** on the same blocking condition, and
  always with the command output that shows it.

## Output of a cycle

A short report containing: tier verdicts with digests (old → new), the one gap chosen and why it
outranked the rest, the diff's touched files, the guardrails that bound it, and the *next*
measurement this cycle made possible. If the cycle improved the instrument rather than the
product, say so explicitly and state what product gap that unlocks.
