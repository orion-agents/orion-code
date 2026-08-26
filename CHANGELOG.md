# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Delivery status legend

This project distinguishes three delivery states. **Never present unreleased work as released.**

| State             | Meaning                                      | Criterion                                  |
| ----------------- | -------------------------------------------- | ------------------------------------------ |
| **Published**     | Tagged source is installable from npm        | git tag exists **and** `npm publish` done  |
| **npm-published** | Registry version exists without full release | exact npm version, but tag/release may lag |
| **Merged**        | In the default branch, not yet installable   | merged, **no** tag / not published         |
| **Candidate**     | Reviewable source, no release promise        | committed PR branch or owned worktree      |

Evidence labels follow `docs/archive/releases/v0.1.x/targets-v0.1.3-v0.1.3-2.md`:
`met` / `partial` / `unmet` / `not_run` — where `not_run` means "blocked by environment",
which is **not** a pass.

## [Unreleased]

## [0.2.0] — CANDIDATE

> **Status: candidate.** Implementation evidence does not imply a Git tag, GitHub Release, npm
> publication, or dist-tag promotion. Those receipts remain pending until performed and read back.

### Added

- Add the versioned `Thread → Turn → Step → Item` runtime protocol, append-only Thread event store,
  deterministic projection/replay, bounded renderer buffering, and typed admission for start, steer,
  follow-up, interrupt, overload, and maintenance.
- Add immutable Step Snapshots and Capability Receipts binding model, prompt, Authority, Policy,
  selected Skills/MCP, visible schemas, exact executors, and durable per-request lineage.
- Add a single ToolGateway execution boundary for core, long-tail, nested batch, MCP, Skill, and
  subagent invocations through Capability → Policy → Approval → Sandbox → Execute.
- Add descriptor-first lazy Skill and MCP runtimes with scope layering, bounded caches, digest
  invalidation, single-flight loading, exact server leases, idle teardown, and crash isolation.
- Add Prompt Registry budgets, stable prefix receipts, first-party contributor slots, redaction,
  and deterministic omission reasons.
- Add transactional Compact maintenance, atomic TurnCommit, Goal Runtime V2, durable PlanReceipt,
  modern child Thread runtime, and a side-by-side legacy Session materializer with atomic index
  cutover.
- Add machine-readable Harness benchmark/eval, architecture confluence, exact tarball, Node 20/22/24
  runtime matrix, gate evidence, and aggregate ReleaseReceipt contracts.

### Changed

- Replace the legacy Brain/Agent/Harness/query runtime graph with one statically composed product
  Runtime and one Agent Loop implementation for root and child turns.
- Reduce the ordinary coding schema from the frozen v0.1.9 baseline of 33 tools / 20,596 bytes to
  7 exact core schemas / 3,947 bytes; long-tail capabilities are selected or deferred by task.
- Make `/plan <task>` commit a PlanReceipt and exit automatically; implementation starts in a new
  logical turn after BUILD/AUTO is restored.
- Let productive Goals continue without a fixed turn-count cap; evidence audit, resource budget,
  no-progress, blocker, provider, persistence, interrupt, and completion decisions remain explicit.
- Keep BUILD/PLAN/AUTO as workflow modes independent from Authority and tool permission policy.

### Removed

- Remove the Ink renderer, legacy Agent/Brain/Harness/SDK public surface, global `TOOLS` and eager MCP
  singleton, compatibility command roots, and direct model→tool execution bypasses from the package.
- Remove `/target`, `/mode`, model-facing `enter_plan_mode`/`exit_plan_mode`, and legacy Goal mutations
  `/goal exit|edit|replace|confirm|budget` plus `clear --yes`.

### Security

- Freeze exact schema/executor/Authority/Policy bindings per model request and fail closed on digest
  or catalog drift.
- Preserve project-boundary, symlink, sandbox, destructive-command, cancellation, durable receipt,
  and indeterminate-side-effect enforcement across all modes and nested execution.

## [0.1.9] — CANDIDATE

> **Status: candidate.** Source, CI, exact tarball, npm `next`, tag, GitHub Release, and stable
> `latest` are independent receipts. This section must be updated after each delivery action; it
> does not claim publication in advance.

### Added

- Add a typed semantic Compact pipeline with atomic message groups, canonical fingerprints,
  structured ContextItems, TaskContract/evidence/capability reinjection, bounded manual focus, and
  deterministic fallback diagnostics.
- Add Compact Checkpoint V2 receipts with source/replacement hashes, target-headroom validation,
  Harness/Goal bindings, transactional candidate installation, rollback, and V1 read compatibility.
- Add HarnessKernel TaskContract V3 criteria, evidence-to-criterion receipts, deterministic state,
  Capability Profiles, ProgressDelta, and typed StopDecision projections.
- Add mature-agent Compact benchmark fixtures and lifecycle trace events for prepare, validate,
  commit, rollback, and boundary transitions.
- Add bounded project-level `compactInstructions` for manual and automatic compaction; caller
  guidance remains subordinate to protocol, safety, criteria, evidence, failures, and pending work.

### Changed

- Replace Goal's fixed five-continuation stop with criterion/evidence completion, no-progress,
  blocker, provider, explicit budget, and user-abort decisions. Resource circuit breakers remain
  bounded and resumable.
- Bind subagent reservations to child query/provider accounting; keep deprecated turn fields only
  as compatibility inputs rather than task-complete semantics.
- Load a bounded memory index at startup and retrieve relevant content per turn with an auditable,
  body-free prompt manifest.
- Extend `/context explain` with section budgets, capability identity, output/safety reserves, and
  the latest committed Compact receipt.

### Fixed

- Serialize usage JSONL appends with an independent cross-process lock and replay-safe request IDs
  (#206).
- Contain project context, project instructions, and explicit skill reads at a canonical project
  boundary; project-provided `@file` content remains untrusted data (#207).
- Make smaller-context model switches run and commit a semantic preflight before changing the
  active model.
- Reject stale Compact candidates when the transcript tail or active checkpoint changes between
  prepare and commit, while preserving append-only session history.
- Stop treating request/tool budgets or an unsatisfied completion gate as successful task
  completion; render resumable typed decisions consistently.

### Security

- Reject symlink and non-regular project context paths, revalidate opened descriptors, and redact
  boundary errors without exposing out-of-project file contents.

## [0.1.8] — 2026-08-15

> **Status: published.** Tag `v0.1.8` identifies the source;
> `@orion-agents/orion-code@0.1.8` is published through the npm `next` dist-tag.
> Stable `latest` remains `0.1.4`; promotion is a separate decision.

### Added

- Add schema-level and scheduler-level finite safe-integer validation for bounded tool inputs,
  including `exec_command.timeout`, `exec_command.maxOutputBytes`, and `list_files.maxDepth` (#203).
- Add a renderer-neutral budget-stop view with usage, last completed work, and visible recovery
  actions across TUI, terminal, print, JSON, and `/loop-stats` (#204).
- Add typed tool-authorization provenance and an explicit BUILD/PLAN/AUTO network-permission
  architecture contract; AUTO stays prompt-free after hard policy and explicit deny checks (#175).
- Add repository-layout, cleanup-manifest, and per-issue verification ledgers for auditable release
  ownership and recovery.

### Changed

- Restrict the npm package to the single runtime icon and enforce packed size, unpacked size, entry
  count, required files, and unexpected-path budgets during release checks.
- Move maintained scripts into `scripts/release`, `scripts/smoke`, and `scripts/maintenance`; archive
  historical v0.1.x plans under `docs/archive/releases/v0.1.x`.
- Enforce renderer command scope before special command dispatch, integrating the behavior reviewed
  in PR #201 for issue #179.
- Keep session transcript append metadata incremental and cover a 5,000-row history without a
  full JSONL rescan (#172).

### Fixed

- Publish file-lock owner metadata atomically and quarantine stale legacy zero-byte recovery
  sentinels so an interrupted writer cannot permanently block `/resume`.
- Verify the existing security, persistence, TUI/performance, release/dependency, and Goal lifecycle
  candidate fixes for issues #170–#200 with focused regression batches and real renderer smokes.
- Keep Goal completion evidence durable across failure, compact, restart, and resume, then
  automatically leave Goal mode after a passing audit (#189).
- Update PTY harnesses to current provider profiles and durable trace/status assertions so the
  release matrix exercises source code without deprecated configuration fallbacks.

### Removed

- Remove 18 unreferenced tracked documentation images, 15 superseded `test-runtime` probes, the
  unused `src/ink` helper, and the unreferenced `src/ui-v2` experiment after replacement mapping.

## [0.1.7] — 2026-08-13

> **Status: published.** Tag `v0.1.7` and its GitHub prerelease identify the source;
> `@orion-agents/orion-code@0.1.7` is published through the npm `next` dist-tag.
> Stable `latest` remains `0.1.4`; promotion is a separate decision.

### Added

- Add `/plan [task]` as the task-scoped, read-only planning entry with an automatically saved exit
  transition and restoration of the previous interactive/auto mode.
- Add an original Orion Pixel terminal identity with a portable pixel mascot, semantic poses,
  restrained motion, and safe classic/NO_COLOR/narrow-terminal fallbacks.
- Add persisted TUI themes, motion, mascot, status-line, and semantic keymap configuration plus
  `/theme`, `/keymap`, `/statusline`, and `/queue` command surfaces.
- Add a bounded shared-runtime follow-up queue: Enter steers the active turn while Tab queues FIFO
  work without interrupting it.

### Changed

- Remove the `/mode` command and its `/perm` compatibility alias. Base modes now change only through
  `Shift+Tab`; `/plan` remains the task entry and model-driven `enter_plan_mode` stays unavailable,
  so Plan state has one lifecycle authority and completion never starts implementation in the same
  turn.
- Replace renderer-local status strings with a typed Chrome projection for Goal, model, permission,
  context, effort, queued follow-ups, and active work.
- Complete Ctrl+R history search, Ctrl+E external composition, empty Ctrl+D exit, and Esc-owned
  interruption behavior while preserving native terminal scrollback.
- Show stable sequence numbers for active subtasks and keep critical Goal, evidence, research, and
  permission state visible before lower-priority chrome.

### Fixed

- Automatically exit Goal mode after a persisted passing completion audit, restore the underlying
  BUILD/PLAN/AUTO mode, retain the completed Goal sidecar as an audit receipt, and reconcile the
  narrow crash window where the terminal sidecar was saved before the session binding was cleared.
- Route explicit `exit goal mode` / `退出 goal 模式` intent through the same deterministic runtime
  clear boundary as `/goal exit`, reject completion retries without new runtime evidence, and cap
  each autonomous continuation below fresh-user loop budgets.
- Sanitize every dynamic startup-banner field, including 8-bit C1 CSI/OSC forms, before writing it
  to the terminal (#164).
- Serialize global configuration read-modify-write transactions across processes and add an atomic
  session catalog for indexed lookup and bounded listing (#157, #159, #163).
- Reject brace-quantified and overlapping-alternative ReDoS patterns, while distinguishing benign
  command substitution from visible recursive deletion in permission policy; contain command cwd
  inside the workspace across permission and execution paths (#160, #162, #169).
- Require explicit risk metadata on every built-in slash command, cover drift-guard prepare/execute
  enforcement and session rename success/scoping, and make coverage a release gate (#158, #166,
  #167, #168).
- Pin all third-party GitHub Actions in CI to immutable commit SHAs (#165).

### Compatibility

- `/goal exit` remains the canonical slash command; explicit natural-language exit intent is routed
  to the same operation. Removed `/goal clear --yes` and `/target clear --yes` syntax is still
  rejected and is not restored as a compatibility alias.

## [0.1.6] — 2026-08-12

> **Status: published.** Tag `v0.1.6` and its GitHub Release identify the source;
> `@orion-agents/orion-code@0.1.6` is published through the npm `next` dist-tag.
> Stable `latest` remains `0.1.4`; promotion is a separate decision.

### Changed

- Require explicit user authorization before a model-created Goal can become active and bound
  non-user continuation loops so a Goal cannot run indefinitely without returning control (#150).
- Replace destructive Goal clearing with `/goal exit`, which aborts the active turn, rejects any
  pending permission request, and clears persisted Goal state. The old `/goal clear --yes` and
  `/target clear --yes` forms are intentionally rejected rather than retained as aliases.
- Make the default dependency-health report reproducible without registry access; registry-backed
  `npm audit` and `npm outdated` reports now require explicit `--full-network` (#155).

### Fixed

- Preserve `vector.db` during brand migration when native SQLite verification is unavailable and
  report the actionable ABI/rebuild cause instead of misclassifying it as corruption (#149).
- Remove real embedding-provider calls from vector tests, make source-only import tests independent
  of prebuilt `dist/`, and select installed Node runtimes by numeric version (#140, #144, #146).
- Keep dependency policy mandatory in prepublish/release gates and synchronize release version
  claims across README and release metadata (#129, #147).
- Anchor macOS seatbelt secret-file denies to the stable project root and make `exec_command`
  permission prechecks use the same explicit command cwd as execution (#151, #153).
- Strip ANSI/OSC/C0/C1 control sequences from terminal-ui transcript and streamed assistant output
  before it reaches the terminal writer (#154).
- Make memory drift validation perform a bounded project symbol scan, expose it through
  `/memory validate`, and fail inconclusive scans closed instead of silently accepting them (#156).

### Compatibility

- This pre-1.0 release contains an intentional command-line breaking change: scripts using
  `/goal clear --yes` or `/target clear --yes` must migrate to `/goal exit`. Goal/session storage
  remains additive and compatible; the removed command syntax is not supported as an alias.

## [0.1.5] — 2026-08-11

> **Status: npm-published.** `@orion-agents/orion-code@0.1.5` is available through the npm
> `next` dist-tag. No `v0.1.5` Git tag or GitHub Release exists, and stable `latest` remains
> `0.1.4`; those delivery states are intentionally recorded separately.

### Added

- Added a typed slash-command descriptor registry, exact invocation grammar, compatibility
  lifecycle metadata, busy policies, and canonical `/goal`, `/session`, `/context`,
  `/commit-plan`, `/rewind`, `/subagents`, and `/effort` control surfaces.
- Added provider-aware effort capability resolution, scoped persistence, immutable retry
  snapshots, structured renderer events, and additive reasoning/effort usage ledger metadata.

### Changed

- Split agent mode from tool permission policy and constrained the empty command palette to a
  primary, searchable surface while retaining explicit advanced and compatibility commands.
- Made dependency, Jest-major, tag/changelog, and prepublish checks fail closed.
- Made the dependency policy reject runtimes outside the declared Node 20/22/24 matrix (#133).
- Added version-tag CI triggers, synchronized the Jest 29 lockfile, and moved the candidate
  package/install metadata to `0.1.5` (#134, #135, #141).
- Made the dependency policy prove the installed OpenAI client on each CI runtime instead of
  inferring Node support from an engine-string regex, and added a real sqlite-vec load/query
  probe (#137, #142).

### Fixed

- Canonicalized recursive `rm` targets before safety evaluation and routed batch confirmations
  and local fast paths through the shared permission policy (#125, #126, #132).
- Repaired Goal completion audit persistence, entity decoding, confirmation fallback, and TUI
  submission/projection behavior (#127).
- Classified every recursive `rm` flag form as destructive so broad tool rules cannot silently
  approve shell deletion (#136).
- Made concurrent session registration reserve capacity atomically across processes,
  with atomic heartbeats and serialized stale-lock recovery (#121).
- Serialized session transcript, metadata, statistics, summaries, and deletion updates under a
  per-session cross-process lock so counters cannot lose concurrent writes (#138).
- Deferred native SQLite loading to semantic-storage boundaries and added actionable
  ABI diagnostics for memory, maintenance, migration, and dependency checks (#111).
- Removed real Ollama/OpenAI calls from vector unit tests by using deterministic embedding
  fixtures, eliminating timeout-driven release flakiness (#139, #140).

## [0.1.4-2] — 2026-08-09

> **Status: published.** Tag `v0.1.4-2` exists and the package is on npm
> (`@orion-agents/orion-code@0.1.4-2`, `next` dist-tag). Stable `latest` remains `0.1.4`.

### Changed

- Split the slash-command registry and chat runtime into bounded modules, removed
  deprecated OpenHorse type aliases, and made strict lint rules fail the build.
- Upgraded the OpenAI SDK to the Node-20-compatible 6.x line, removed unused runtime
  dependencies, and added automated dependency policy/update checks.
- Added structured diagnostics, provider recovery metrics, runtime-matrix CI, and
  real PTY research lifecycle coverage.

### Fixed

- Closed persistence races, checkpoint corruption/rollback gaps, task-capacity and
  response-parsing bugs, tool-call group corruption, context compaction errors, and
  provider retry/stream recovery inconsistencies.
- Hardened forked-agent capabilities, harness evidence/sandbox enforcement, AWS auth,
  command execution gates, and macOS sandbox fail-closed behavior.
- Completed the research contract across controlled web access, redirects, budgets,
  atomic CAS persistence, citation durability, renderer events, and restart/resume.
- Added conversational Goal abandonment with explicit user authorization and corrected
  Goal boundary/audit/no-progress semantics.
- Made `prepublishOnly` build before the release pack gate so clean checkouts and final
  tarballs are validated against the same generated `dist` output.

## [0.1.4] — 2026-08-06

> **Status: published.** Tag `v0.1.4` exists and the package is on npm
> (`@orion-agents/orion-code@0.1.4`, `latest` dist-tag). Released 2026-08-06.
> Work that remains a worktree-only draft carries no release promise (see legend).

Aligns `package.json` / `package-lock.json` with the `v0.1.4` release so the
CLI banner, HTTP `User-Agent`, and crash/telemetry reports stop misreporting `0.1.3`.

### Changed

- **Release metadata (#10):** bumped `package.json` and `package-lock.json` to
  `0.1.4` so `orion --version` and the outbound `User-Agent` reflect the development line.
- **Type safety (#5):** removed ~22 `any` usages (120 → 98 on the committed tree):
  - native `Intl.Segmenter` typing via the `ES2022.Intl` `lib` (no more `(Intl as any)` casts);
  - typed SQLite rows in `src/memory/vector-store.ts` (`MemoryRow` / `MemoryVectorRow`);
  - `unknown`-typed task params in `src/services/task-manager.ts`;
  - typed provider-error messages in `src/services/provider-resilience/error-classifier.ts`.

### Fixed

- **Lint (#6):** resolved unused-vars / prefer-const warnings and removed dead code
  (17 ESLint `no-explicit-any` / unused-var alerts cleared).

## [0.1.3] — 2026-08-05

> **Status: published.** Tag `v0.1.3` exists and the package is on npm
> (`@orion-agents/orion-code@0.1.3`). The model-config subset (`/model` / `/models`)
> is merged; the security/tooling subset below shipped in this release.

This release hardens the execution surface (sandbox POC, tool-allowlist ReDoS,
plan-mode bypass, SSRF / API-key leakage) and rounds out developer-facing tooling
(git tools, TUI permission interaction, incremental input, goal-tool diagnostics).

### Added

- **Shell sandbox POC** (`src/tools/sandbox.ts`)
  - Commands are wrapped as an **argv array**, never re-parsed by an intermediate shell
    (eliminates quote-injection surface).
  - **Runtime backend probes** for `seatbelt` / `bubblewrap` / `docker` via `spawnSync`
    — capability is never inferred from `which`.
  - **Fail-closed**: a configured profile that cannot be applied (no backend, unusable
    backend, unknown profile/backend) **refuses execution** instead of silently degrading.
  - Default `profile: 'none'` is fully backward compatible with the legacy `sh -c` path.
  - Docker backend runs with a **`--read-only` rootfs** and explicit `rw` bind-mounts for
    the workspace + tmp + user `writableRoots`; network is blocked unless `allowNetwork`.
  - Wired into `src/tools/index.ts` (`exec_command` plan + `checkPermissions` gate) and
    `src/services/global-config.ts` (`sandbox` config at global + project scope).
- **Git tooling** (`src/tools/git.ts`)
  - Structured read-only `git_diff` / `git_log` / `git_branch` / `git_status`
    (with ahead/behind for the tracking branch).
  - Risk-graded `git_commit` (state-write, `isDestructive() => true`) and the pre-existing
    `git_push`. There is **no** `git_stage` tool; staging happens via `git_commit`'s
    `paths` / `all` arguments.
  - All paths confined to the repository; `paths` rejects glob / pathspec syntax;
    output is redacted.
  - ⚠️ **Known gap**: `git_commit({ all: true })` stages _every_ tracked modification.
    The index snapshot / rollback and user-visible preview required by plan §P1-C are
    **not implemented** — prefer explicit `paths`.
- **TUI permission interaction** (`/permissions` command)
  - Toggle tool-confirmation live; immediately rewrite in-memory config **and** persist to disk.
  - Status-bar `perm:` chip reflects the current mode; a system confirmation message is appended
    to the session. A failed `updateGlobalConfig` leaves the in-memory state unchanged.

### Changed

- **Tool allowlist — ReDoS hardening** (`src/services/tool-allowlist.ts`)
  - Regex-compiled glob matchers replaced by a **linear dual-pointer matcher**
    (`O(pattern × subject)`, `O(1)` extra state, no catastrophic backtracking). Regressed by a
    pathological `(a*)*b`-style input test.
- **Plan-mode bypass fixed** (`src/framework/tool-scheduler.ts`)
  - Plan-mode commands no longer short-circuit permission checks with a default allow; they go
    through the same gating as interactive mode.
- **SSRF / API-key hardening** (`src/tools/web.ts`, `src/utils/mask.ts`)
  - Per-hop redirect host checks, a response-body hard cap, and full API-key masking in logs/output.
- **Incremental input during a running turn**
  - Supplementary user input is echoed immediately (G1), accumulated without loss (G2),
    dedupe-guarded, and reflected in status text (G4).
- **Goal tools** (`src/runtime/goals/tools.ts`)
  - `update_goal` / `update_goal_plan` / `create_goal` failures now return a **diagnostic `output`**
    instead of an empty string.
- **Config model** (`src/services/global-config.ts`)
  - `sandbox` config at both global and project scope, with documented schema / defaults / migration /
    redaction / rollback (P1-E). Project config shallow-overrides global per key.

### Security

- Sandbox execution is fail-closed and verifiable: on hosts with a usable backend, the OS-enforcement
  assertions exercise **real kernel-level confinement** (Docker `--read-only` + bind-mounts verified on macOS).
- Allowlist matching is ReDoS-safe.
- Web tool rejects redirect-based SSRF pivots and never leaks API keys in output.

### Out of scope (this release)

Deliberately deferred to a later version per the architecture review
(`docs/archive/releases/v0.1.x/v0.1.3-2-plan.md`):

- **Hook system (#27)** — external scripts expand the permission / timeout / secret / audit surface and
  need a standalone technical design.
- Several `v0.1.3-2` plan items (writable / background sub-agents, generic MCP SSE/HTTP/OAuth, queue
  injection / project-instruction files, custom slash commands, domestic-differentiation, Goal self-repair)
  are tracked for **v0.2**.

### Evidence

Verified by `npm run release:check` on **2026-08-05**:

- **Full Jest suite (Node 24.14.0): 3045 tests — 3042 passed, 1 failed, 2 skipped; 179 suites passed.**
  The single failure is `tests/terminal-ui-pty.test.ts` (sandbox `safe-delete` `EACCES`) → `not_run`.
- Focused v0.1.3-2 suites: `sandbox` 30 (incl. live Docker OS-enforcement assertions),
  `tool-allowlist` 38, `web-ssrf-bypass` 21, `git-tools` 7, plus `tool-confirmation` /
  `permission-mode` / `incremental-input` / `goal-tools` / `tool-scheduler` / `config`.
- `tsc --noEmit` **0 errors**; ESLint **0 errors / 137 warnings** (pre-existing `no-explicit-any`).
- `npm pack --dry-run` OK — 1098 files, 5.23 MB unpacked.
- CI / real-PTY / tarball clean-install evidence remains environment-gated and labelled `not_run`
  rather than substituted by a local green run.

**Corrections to earlier claims.** The previously reported "10 focused suites: 173/173" was a
cherry-picked subset that excluded failing suites. A full run surfaced pre-§8 test rot in
`tests/agent-runtime-controller.test.ts`, `tests/runtime-ui-parity.test.ts` and
`tests/turn-controller.test.ts` (they asserted latest-only revision semantics and the old
English status strings). These were realigned with the §8 G1/G2 design — the product behaviour
was not changed. The PTY smoke scripts `scripts/terminal-ui-pty-smoke.py` /
`scripts/tui-ui-pty-smoke.py` were updated to wait for the current Chinese status text.

> Run the suite with **Node 24.14.0**. Node 22 produces 14 spurious `better-sqlite3` failures
> (native module built for `NODE_MODULE_VERSION 137`, Node 22 requires `127`).

### Still open (release gate)

- `docs/archive/releases/v0.1.x/targets-v0.1.3-v0.1.3-2.md` P0-C Goal sidecar overwrite protection — `unverified`.
- Worktree not yet frozen into a commit (index currently holds the 42 in-scope files).
- No `v0.1.3` tag; not published.

## [0.1.2] — 2026-08-02 · Published (tag `v0.1.2`)

Goal reliability release. Typed continuation for a single session with a single active Goal;
safe pause after restart/resume requiring explicit recovery; runtime evidence ledger with
per-criterion completion audit and precise stop reasons; confirmation was single-session scoped.

## [0.1.1] — 2026-07-31 · Published

Command contract, TUI as the default path, OpenHorse migration and data-safety convergence;
terminal-ui repositioned as the diagnostics build, Ink formally deprecated.

## [0.1.0] — 2026-07-28 · Published

First public TUI baseline.

---

## Maintenance rules

1. Run `npm run release:check` before every release. It verifies version consistency
   (`package.json` / `package-lock.json` / both README install pins / the Chinese README
   "current version" marker), CHANGELOG presence, `git diff --check`, worktree cleanliness,
   lint, types, the full test suite, and `npm pack --dry-run`.
2. `release:check` is **read-only**: it never runs `git tag`, `git push`, PR, merge or
   `npm publish`. Those stay separately authorized.
3. When an entry moves Candidate → Merged → Published, **move it to the matching section**.
   Leaving a stale status label is a release-gate failure.

(Legacy release notes under `docs/mvp/` are not maintained in this file.)
