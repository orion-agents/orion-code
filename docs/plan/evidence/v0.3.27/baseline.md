# v0.3.27 PR0 — Baseline Record

> Recorded 2026-10-19, before any implementation commit. Per plan §2/§12.

## Source & environment baseline

- Baseline commit: `main@b810996f0e425cae6a60541edd072a7dd87b4e6d`, package `0.3.26`,
  tag `v0.3.26` (npm `PUBLISHED 2026-10-17T11:30:33.458Z`, latest). Branch:
  `codex/v0.3.27` created from `origin/main` in worktree
  `orion-code.worktrees/v0.3.27`; no pre-existing v0.3.27 worktree or branch.
- Node: v26.5.1 for local gates. Goals document present with uncommitted local
  modifications and two historical goal documents deleted — protected, outside
  this cycle's scope (plan §12).

## Test baseline

- Full Jest at the baseline commit (this worktree, parallel mode):
  373 suites / 4505 passed / 5 skipped, **10 suites failing under parallel load** —
  all from the documented contention/timing families (PTY smoke ×2,
  settings-document watcher, global-config and thread-event-store and
  web-storage-admission cross-process tests, subagent deadline/concurrency ×2,
  workspace-diff/commit-plan CLI subprocess tests). Spot isolated rerun of the
  three not previously documented families (`workspace-diff`, `commit-plan`,
  `thread-event-store`): **24/24 pass**. Judged environment contention, not a
  product regression (the same commit was fully green in CI three-consecutive-runs).

## Current `/review` behavior (audited, per plan §2)

- `src/commands/workflow-commands.ts` registers `/review` as read-only but its
  execute calls `continueAsSlashChat('review', args)` — the run degrades into an
  ordinary agent turn (plan §2 row 1). No typed review workflow exists today.
- Existing read-only reviewer experience lives in `src/runtime/subagents/presets.ts`
  presets; the Web review panel shows Git change facts, not review results.
  Both are reuse inputs for PR1/PR2, not shipping behavior.

## Performance receipts (referenced, not re-run)

- Session responsiveness receipts: `docs/plan/evidence/` v0.3.24 series
  (warm-switch p95 ≤ 100ms target). Re-measurement is PR4 scope per plan §9.4.

## PR0 deliverables in this commit

- `src/services/code-review/contract.ts` — frozen contract: selector/state/
  conclusion/finding types, tighten-only budgets, finding validation, conclusion
  mapping (tool success ≠ review success), receipt digest, applicability.
- `tests/code-review-contract.test.ts` — 12 contract tests.
- `docs/plan/evidence/v0.3.27/quality/` — the 20-sample human-annotation
  benchmark set (12 defect + 8 clean; TS/JS/Python) with content digests,
  expected triggers, allowed locations and the frozen scoring thresholds.
  **Human review sign-off: PENDING** (plan §9.3 requires per-sample review
  before any paid model run).

## not_run at PR0

- PTY / Host+Chrome E2E / quality rounds / performance re-measurement: later
  slices per plan §8–§10.
