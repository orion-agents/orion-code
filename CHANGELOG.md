# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Delivery status legend

This project distinguishes three delivery states. **Never present unreleased work as released.**

| State | Meaning | Criterion |
| --- | --- | --- |
| **Published** | Users can install it | git tag exists **and** `npm publish` done |
| **Merged** | In the default branch, not yet installable | merged, **no** tag / not published |
| **Candidate** | Worktree only | **not committed**; carries no release promise |

Evidence labels follow `docs/plan/targets-v0.1.3-v0.1.3-2.md`:
`met` / `partial` / `unmet` / `not_run` — where `not_run` means "blocked by environment",
which is **not** a pass.

## [Unreleased]

> **Status: maintenance branch only.** These fixes are newer than the immutable
> `v0.1.4` tag and npm artifact; pushing the `v0.1.4` branch does not republish them.

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
  - ⚠️ **Known gap**: `git_commit({ all: true })` stages *every* tracked modification.
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
(`docs/plan/v0.1.3-2-plan.md`):

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

- `docs/plan/targets-v0.1.3-v0.1.3-2.md` P0-C Goal sidecar overwrite protection — `unverified`.
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
