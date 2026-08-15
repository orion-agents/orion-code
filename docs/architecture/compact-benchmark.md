# Compact benchmark evidence ledger

Status date: 2026-08-15
Scope: evidence freeze and shared corpus definition for v0.1.9; this document is not a
cross-product ranking.

## Evidence labels

- `confirmed`: a primary source or pinned implementation directly establishes the stated
  mechanism. It does not imply that the product passed Orion's corpus.
- `observed`: a public implementation, specification, or release record exposes part of the
  mechanism, but no controlled end-to-end corpus result is recorded here.
- `not observable`: the public surface does not expose the stated internal field, or a
  credentialed/model-controlled run was not available. Missing data is neither pass nor fail.

## Pinned evidence and observable boundary

| Agent        | Evidence status | Pinned evidence                                                                                                                                                  | Confirmed or observed boundary                                                                                                                                                                                                   | Fixed-corpus run                                                                                                                 |
| ------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code  | `confirmed`     | Official context-window, how-it-works, Agent SDK loop, and session documentation, accessed 2026-08-15                                                            | Public documentation confirms context compaction, stable system context reinjection, and session continuation surfaces. Candidate schema, checkpoint CAS, exact token accounting, and internal retry trace are `not observable`. | `not observable`: no authorized controlled black-box receipt, model ID, context window, temperature, or raw result was captured. |
| OpenAI Codex | `confirmed`     | `openai/codex@e5470f1bce099442d73e491ce63d189d355b061e`: `codex-rs/core/src/compact.rs`, `compact_remote.rs`, `compact_remote_v2.rs`, and the compact test suite | Pinned source confirms separate local/remote compact paths and typed compacted history installation. Hosted model internals and server-side candidate generation are `not observable`.                                           | `not observable`: source evidence is confirmed; no like-for-like product run receipt is recorded.                                |
| Gemini CLI   | `observed`      | `google-gemini/gemini-cli@2a87e7be103308b8734246097ba723cc7deb4122`: compression configuration and `chatCompressionService.ts`                                   | Public source exposes model-aware thresholds, tool-output handling, and compression state. Provider-internal summary behavior and a controlled fixed-corpus result are `not observable`.                                         | Not run; no raw result path.                                                                                                     |
| OpenCode     | `observed`      | `anomalyco/opencode@4643e65ad6334de3e4e68dedc201d5fbb828c9fe`: V2 session specification and `packages/opencode/src/session/compaction.ts`                        | The `dev` specification/source exposes durable transcript and summary/checkpoint concepts. Stability guarantees and a controlled fixed-corpus result are `not observable`.                                                       | Not run; no raw result path.                                                                                                     |
| Aider        | `observed`      | `Aider-AI/aider@5dc9490bb35f9729ef2c95d00a19ccd30c26339c`: rolling-summary contract in `aider/prompts.py`                                                        | Source exposes a rolling free-text summary contract and explicit retention hints. Transactional checkpoint/CAS fields and criterion-evidence links are `not observable`.                                                         | Not run; no raw result path.                                                                                                     |
| Cline        | `observed`      | `cline/cline@8bbdde2a5c1f972864fe1b954f639c21fac61a40`: CLI changelog compact/canonical-history record                                                           | The release record exposes canonical-history preservation as an externally stated behavior. The internal compact transaction, validation, and retry implementation are `not observable`.                                         | Not run; no raw result path.                                                                                                     |

Primary links are frozen in
[`docs/plan/v0.1.9-plan.md`](../plan/v0.1.9-plan.md); update a commit and access date together.
Do not silently replace a pinned revision with a moving branch.

## Fixed corpus v1

The executable source is `src/harness/compact-benchmark-corpus.ts`. Canonical encoding is
`JSON.stringify` of the JSON value below, encoded as UTF-8 with no trailing newline. Its SHA-256 is
`9cb627c56d31ff345aa199edc632fe045d2f95f38490ae4860d5adc8e137fe1d`.
`repeat(value,count)` expands to exactly `count` Unicode scalar values before the run. Array order
is test order and object key order is part of the fixture.

```json
[
  {
    "id": "C01-large-tool",
    "setup": "tool_output:repeat(x,65536)",
    "required": ["objective", "criterion:c1", "tool_pair:t1", "next_action"]
  },
  {
    "id": "C02-parallel-tools",
    "setup": "parallel_calls:[read:a,read:b];results_reverse_order",
    "required": ["call_result_pair:a", "call_result_pair:b", "original_order"]
  },
  {
    "id": "C03-steer-rollback",
    "setup": "edit:a;user_steer:revert_a_edit_b",
    "required": ["latest_instruction", "reverted:a", "changed:b"]
  },
  {
    "id": "C04-resume",
    "setup": "compact;crash_after_prepare;restart_resume",
    "required": ["canonical_transcript", "committed_checkpoint_only", "no_replayed_side_effect"]
  },
  {
    "id": "C05-cjk",
    "setup": "objective:修复权限边界;constraint:不得修改用户文件",
    "required": ["objective", "constraint", "criterion:cjk1"]
  },
  {
    "id": "C06-provider-failure",
    "setup": "candidate_provider:[timeout,empty,invalid_schema]",
    "required": ["old_checkpoint_active", "bounded_retry", "typed_failure"]
  },
  {
    "id": "C07-oversized-item",
    "setup": "single_message:repeat(y,131072)",
    "required": ["explicit_over_budget", "no_partial_protocol_item", "typed_pause_or_fallback"]
  },
  {
    "id": "C08-repeat-compact",
    "setup": "compact_rounds:10;no_new_facts",
    "required": ["no_fact_loss", "stable_refs", "thrash_bound"]
  }
]
```

Executable fixture and semantic-compact verification command:

```sh
PATH=/Users/hope/.nvm/versions/node/v24.14.1/bin:$PATH npx jest \
  tests/compact-benchmark-corpus.test.ts tests/compact-semantic.test.ts \
  tests/compact-robustness.test.ts \
  --runInBand --no-coverage
```

The immutable Orion receipt is
[`receipts/v0.1.9-compact-node24.json`](receipts/v0.1.9-compact-node24.json): implementation
commit `e350719c3dc66756557f29ec2b89bf53cf1cb682`, Node `v24.14.1`, macOS arm64,
2026-08-15, `3` suites, `24` tests, `24` passed.
The corpus contract tests validate all eight case definitions and their hash. The semantic suite
executes Orion's atomic tool grouping, typed coverage, canonical fingerprint, 65% headroom,
oversized-item fail-closed behavior, provider fallback diagnostics, and model-switch receipt gates.
The semantic suite also verifies bounded manual focus, TaskContract/criterion/evidence/capability
reinjection, typed ContextItem schema, and rejection of tampered source boundaries, task epochs, or
dangling evidence. The robustness suite executes ten sequential compact rounds with exact mandatory
criterion/evidence references, bounded duplicate rejection, typed `context_thrash` / `no_headroom`
pauses, and pre/post query headroom validation. Crash/restart is still not exercised by this command
and must not be inferred from the passing mechanism and ten-round scenario tests.

## Required run receipt

Every actual run must append a row without overwriting prior evidence:

| Field          | Requirement                                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product        | product version plus immutable commit/build identifier                                                                                                      |
| Environment    | OS, runtime version, date, and network mode                                                                                                                 |
| Model controls | provider, exact model, context window, temperature/reasoning settings                                                                                       |
| Invocation     | exact command/API request with secrets redacted                                                                                                             |
| Corpus         | corpus version and SHA-256 above                                                                                                                            |
| Raw result     | repository-relative immutable artifact path; never a prose-only recollection                                                                                |
| Metrics        | required-fact retention, criterion/evidence integrity, tool-pair integrity, before/after token counts when observable, latency, retries, and terminal state |
| Boundary       | each unavailable field explicitly marked `not observable`                                                                                                   |

No comparable external-product command or raw-result artifact exists in this checkout yet. Therefore
the external product rows above document design evidence only. Orion's executable local fixture and
test receipt are not a cross-product result; scenario-level immutable raw receipts remain required.

## Orion integration checklist

- Deterministic fallback, provider candidate, resume, and repeated-compact paths must consume the
  same corpus expansion.
- A run is valid only when tool call/result pairs remain atomic and all required criterion/evidence
  references resolve.
- A prepared but uncommitted checkpoint must remain inactive after crash/restart.
- Provider timeout, empty output, or invalid schema must preserve the old checkpoint and produce a
  typed, bounded failure or fallback receipt.
- A black-box product result cannot be promoted from `observed` to `confirmed` without immutable raw
  output and the model controls above.
