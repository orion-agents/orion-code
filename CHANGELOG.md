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

## [0.3.9] — CANDIDATE

## [0.3.9] — CANDIDATE

> **Status: npm-published.** `@orion-agents/orion-code@0.3.9` is available through the npm
> registry (latest tag); deterministic-bug-fix release + background host lifecycle
> (issue #247 S1/S2). Published 2026-09-04; git tag/release may lag.

### Added

- `orion web --background`: starts the Web Workbench host detached from the
  terminal, writes a pidfile (`~/.orion-code/web-host.<port>.pid`), redirects
  logs to `~/.orion-code/logs/web-<port>.log` and prints URL/pid.
- `orion web status|stop|restart [--port <number>]`: pidfile-based host
  management without third-party supervisors. Still binds 127.0.0.1 and keeps
  the fail-closed approval/context/sandbox semantics unchanged (issue #247).

### Fixed

- Issue-sweep triage: #222 (blank session rename), #223 (failed create leaves a
  persisted active session), #234 (URL userinfo password starting with `token:`),
  #238 (busy state-write clearing processing), #242 (stale Settings save into the
  newly active workspace) were all already resolved on `main` — closed with
  source evidence.
- Web redaction now covers uppercase X-prefixed environment assignments
  (`X_CLIENT_SECRET=…`, `CLIENT_SECRET=…`, `AUTH_TOKEN=…`) whose secret suffix
  hides behind underscore word characters (issue #241).
- Cmd/Ctrl+B can again open the Project Navigator at 761–799px: expanding the
  navigation preference now resolves to a drawer and opens it explicitly instead
  of leaving an invisible drawer (issue #226).

### Tests

- `redaction-xprefixed-env` suite: X-prefixed env values, bare uppercase
  assignments, #234 userinfo regression, #241 JSON keys.

## [0.3.7] — CANDIDATE

> **Status: candidate.** This work is isolated on the codex/v0.3.7 worktree (left project
> rail interaction quality). It is not merged, tagged or published to npm.

### Added

- Session **tags**: up to 8 user-assigned tags per Session (each ≤ 32 chars), persisted on
  the Session record (`SessionMeta.tags`), projected into `WebSessionSummaryV1.tags`,
  managed from a new "管理标签…" dialog (chip add via Enter/comma, per-chip remove) and
  rendered as small badges on rail rows. Host endpoint `POST /sessions/:id/tags`.
- Session **archive / restore**: soft delete via `SessionMeta.archivedAt` that keeps every
  file, hides the Session from default listings and counts, and surfaces it under a new
  "已归档" rail section with a 还原 action (`POST /sessions/:id/archive|restore`;
  `GET /workspaces/:id/sessions/archived`).
- Session **delete** from the web workbench: destructive confirmation dialog (explicit
  "永久删除" guard, 不可恢复 copy) wired to the existing storage `deleteSession` through a
  new `DELETE /sessions/:id` endpoint; refuse-while-busy checks in the controller.
- The rail rename affordance becomes a general **overflow menu** (`SessionRowMenu`,
  keyboard navigable ↑↓/Home/End/Esc with focus restore) hosting 重命名… / 管理标签… /
  归档 / 删除… so future per-Session actions have a stable home.

### Changed

- Active-workspace session listings (`listProjectSessions`, `listSessions`,
  `countSessionsByProject`) exclude archived Sessions by default.
- Rail footer status copy is shortened to 已连接 / 离线 / … with full sentences moved to a
  tooltip (`connectionTitle`); the collapsed rail dot keeps an accessible short label.
- Project tag chips, archived-section rows and the two new dialogs ship with their own
  styles; stale `.session-rename`/`.session-row` rules were removed.

### Fixed

- Rename failures are no longer silent: `RenameDialog` surfaces the server error inline
  (`field-error`) instead of closing without feedback.
- Session-row menu hint ids are instance-unique (`useId`) so `aria-describedby` can never
  point at another row's hint.
- The archived rail listing is bound to its owning Workspace: switching projects drops stale
  foreign archive rows immediately and never flashes another project's archive while loading;
  `session_deleted` also clears the stale runtime projection.

### Tests

- New contract suites: `web-reducer-session-lifecycle` (14, incl. owner-binding + runtime
  cleanup regression), `web-ui-SessionDialogs` (7), `web-ui-SessionRowMenu` (3),
  `web-ui-WorkspaceDialog` (6), `session-storage-tags-archive` (5, incl. delete),
  plus controller-level guards (tags validation / archive-restore / delete-while-busy /
  foreign-workspace rejection / 404) in `web-workbench-controller.test.ts`; `web-ui-*` now
  112 cases green. E2E: `web-v037-session-lifecycle.spec.ts` (archive/restore, delete-confirm,
  tags round-trip) runs in CI.

## [0.3.6] — CANDIDATE

> **Status: candidate.** This work is isolated on the codex/v0.3.6 worktree (pure web
> workbench interaction quality). It is not merged, tagged or published to npm.

### Added

- Component rendering contract layer for the web workbench: six `.test.tsx` suites
  (89 cases) assert on `react-dom/server.renderToStaticMarkup` output without jsdom —
  Markdown / StateDot / ShortcutHelp / DiffViewer / ApprovalCard / PanelResize.
- `StateDot` status indicator that never relies on colour alone (WCAG 1.4.1): every dot
  carries a shape channel via `data-tone` (square / circle / pulsing ring / hollow ring /
  triangle) plus a visually-hidden text label for assistive tech; applied to reasoning,
  research sources, review evidence and the work-panel rail.
- Single-source keyboard binding table (`shortcuts.ts`) plus a `⌘/` shortcut help dialog
  rendered from it, so the panel cannot drift from the live bindings; `matchesShortcut`
  now resolves `Esc` → `Escape` so the help vocabulary matches real key events.
- Header theme-cycle button (system → light → dark, persisted through the settings
  document); the `SettingsDialog` entry stays intact.
- Stacked notification toasts (P1-C): multiple notices queue without overwriting, each
  non-recoverable non-error notice auto-dismisses after 5s, error / recovery notices stay
  until acted on, and `aria-live` is graded (alert for errors, status otherwise).

### Changed

- `PanelResizeHandle` is keyboard reachable with full separator semantics: `role=separator`
  with live `aria-valuenow`/`aria-valuetext`, ←/→ steps of 2% (Shift 10%), Home/End jump,
  Enter/Space reset to default; stepping logic is extracted as pure functions.
- Notification region becomes a stacked container (`.workbench-notice-stack`); cards slide
  in on `opacity`/`transform` only and the whole stack is inert while drawers are open.
- Icon set gains `sun` / `moon` / `monitor` / `keyboard` glyphs.

### Fixed

- Markdown heading off-by-one: `##` renders as `<h2>` (was `<h3>`), a lone `#` no longer
  collapses to `<h6>`; >6 hashes stay a plain paragraph per GFM.

## [0.3.5] — CANDIDATE

> **Status: candidate.** This work is isolated on the codex/v0.3.5 worktree. It is not
> merged, tagged or published to npm, and exact-artifact qualification remains a separate gate.

### Added

- Version thread projection digests so v0.3.2/v0.3.3 cutover receipts keep verifying while new
  projections carry the full diagnostic/compact shape; forged digests fail closed.
- Session snapshot sync state is decoupled from the Host transport: a Session snapshot failure
  can no longer flip the live SSE to `replay-required`; Composer and command gates require both
  transport live and the foreground Session snapshot ready.
- Host and browser diagnostics counters for Session switches, snapshot cache hits/loads/latency,
  and Session actor allocation/eviction/closure, so "pure selection allocates no Runtime" is
  provable from counters instead of prose.
- Runtime ownership across Workspace Context switches: the Host-level Session registry is created
  once and preserved; control planes and Session actors borrow per-Workspace shared kernels, and
  only Host shutdown closes every actor and kernel.

### Changed

- Instant Session switching renders a cached projection immediately, refreshes with a bounded
  tail snapshot in the background, and prefetches the most recent Sessions after a baseline.
- Version and release hygiene: package identity moves to 0.3.5, `release:check` recognizes
  `codex/vX.Y.Z` and `GITHUB_HEAD_REF` release branches, and the Web rail no longer falls back to
  a hardcoded version string.

### Fixed

- Workspace Context activation no longer shuts down resident Session actors of other Workspaces
  or requires every actor to be idle before switching the active control plane.
- A failed Context activation restores the previous control plane without rebuilding the Session
  registry, so resident actors and their Runtime revisions survive the rollback.

## [0.3.4] — CANDIDATE

> **Status: candidate.** This stabilization work is isolated on the v0.3.4 worktree. It is not
> merged, tagged or published to npm, and exact-artifact qualification remains a separate gate.

### Changed

- Bind Settings writes to the active Workspace and Context revision in addition to the Settings
  document revision, so a stale browser tab cannot apply a valid patch to another Workspace.
- Preserve lexical symbolic-link identity while projecting a contained target as a file or
  directory, and expose the true changed-file total separately from the bounded Review page.
- Split exact-tgz qualification into a script-disabled identity stage and a separate lifecycle-
  enabled consumer/native stage.

### Fixed

- Keep split terminal surrogate pairs intact across delayed PTY callbacks, wait for browser write
  capacity without animation-frame spin, and drain reconnect data in replay, live-tail, exit order.
- Reject blank Session renames without changing durable metadata, and keep active-turn state intact
  when a busy-rejected slash command fails.
- Isolate concurrent command transcript capture so interleaved output cannot cross Sessions or
  leave the process-wide console bridge installed.
- Project cold and resident Composer model, Effort and permission changes from the actor Runtime's
  canonical Session instead of a pre-actor metadata copy.
- Detect binary content on every file page, render contained directory symlinks as expandable and
  label Review truncation against the true repository total.

### Security

- Redact URL userinfo and structured sensitive keys before browser/evidence projection; evaluate
  file aliases plus canonical targets and block sensitive current or rename-source Git diffs before
  starting a content process.
- Require matching, canonical-digest-verified terminal receipts and durable receipt facts before a
  modern tool result can project success.
- Fail release qualification for a failed live canary or duplicated runtime run and manifest
  evidence instead of accepting a structurally complete but non-independent matrix.

## [0.3.3] — CANDIDATE

> **Status: candidate.** The implementation and local qualification remain isolated on the v0.3.3
> worktree. It is not merged, tagged, published to npm or represented as a completed release receipt.

### Added

- Add the bundled `orion-blocksmith` pixel-workshop style as a closed built-in appearance option,
  composed with system/light/dark themes and reduced motion without remote assets or executable
  theme packages.
- Add a bounded Web Session actor registry with three running slots, four resident actors, FIFO
  overflow admission, cancellable queued turns, idle LRU eviction and explicit per-Session runtime
  revisions.
- Add the v0.3.3 OpenAPI, migration guide and exact-artifact WEB33-P0-01..12 plus
  WEB33-P0-16..24 qualification contract.

### Changed

- Make foreground Session selection browser-tab-local so a running, approval-waiting or queued
  Session continues while another Session is viewed or submitted.
- Route Session commands and Composer mutations through exact Workspace, Context, Session runtime
  and control revisions; stale operations fail closed instead of following a global active Session.
- Keep a single Workbench SSE connection while projecting Session-tagged runtime state into bounded
  per-Session browser caches.
- Package runtime JavaScript and declarations without generated source-map files, preserving local
  build maps while keeping the published artifact within the existing unpacked-size budget.

### Fixed

- Remove the global pending barrier from warm same-Workspace Session selection and restore cached
  content immediately while a guarded snapshot refreshes in the background.
- Keep the collapsed Work Panel as a right-side full-height 48px rail across desktop and drawer
  breakpoints without moving it below the conversation or creating horizontal page overflow.
- Keep the only persistent Settings entry at the lower-left project rail and restore focus after a
  successful Settings save.
- Raise Orion Blocksmith light-theme muted text contrast to WCAG AA for small labels and empty-state
  copy.

### Security

- Serialize same-Workspace mutating Tool steps through a shared arbiter while preserving independent
  actors for non-conflicting work; stale file baselines are rejected before side effects.
- Bind queued-turn cancellation, approvals, Goal/Plan controls and structured Context references to
  the intended Session actor, with zero cross-Session provider, Tool, journal or file effects on
  revision conflict.

## [0.3.2] — CANDIDATE

> **Status: candidate.** Source, API and browser qualification are being frozen together. This is
> not a Git tag, GitHub Release or npm publication until the exact-artifact receipts exist.

### Added

- Add an IDE-style left project navigator that expands, collapses to a 48px rail and mouse-resizes
  from 240–480px while preserving a 560px conversation floor and responsive drawer preferences.
- Add a Composer Control Center for BUILD/PLAN/AUTO, Session permission, model, Effort and
  Runtime-projected Context usage, including pending/last-good/error/retry states.
- Add structured file/folder/review/session/Skill Context references with Host-side containment,
  sensitive-data, revision, digest and prompt-budget validation.
- Add durable Plan review with exact-digest approve, continue-planning and cancel operations that
  survive refresh, replay and Host restart without auto-executing an unreviewed Plan.
- Add revisioned queue edit/move/remove and Session-scoped tab-local draft recovery.
- Add the v0.3.2 OpenAPI, mode/permission contract, migration guide and exact-artifact
  WEB32-P0-01..12 qualification contract.

### Changed

- Replace the three Composer mode buttons with accessible menus and keep workflow mode independent
  from tool authorization; explicit Deny and hard Policy remain stronger than AUTO or Allow.
- Make active-turn model changes deferred to the next logical request and require verified compact
  before switching to a smaller safe context window, with complete rollback on failure.
- Project provider or explicitly estimated Context usage from Runtime instead of reconstructing
  token capacity in the browser.

### Fixed

- Keep the left/right desktop widths stable across narrow-screen drawers, reloads and 200% zoom;
  bound controls and Context chips without covering the textarea or send action.
- Consume expected UI mutation rejections after the shared operation layer has projected the error,
  preventing a deliberate 409 CAS conflict from becoming an unhandled browser page error.
- Require a matching active-session snapshot after replay reset before re-enabling the Composer.

### Security

- Bind Composer, queue and Plan mutations to exact Workspace/Session/Context/control revisions and
  fail stale operations with zero provider, ToolGateway, file or queue side effects.
- Revalidate every structured Context reference at prompt assembly and keep sensitive/raw content
  out of the DOM, SSE, screenshots and release evidence.

## [0.3.1] — CANDIDATE

> **Status: candidate.** This branch carries the v0.3 Web quality and long-session recovery fixes.
> It is not a Git tag, GitHub Release or npm publication until those receipts exist.

### Added

- Add a registered multi-project navigator with lazy inactive-project Session pages and one atomic,
  revision-guarded active Workspace/Session transition.
- Add a professional right work dock for Agent, Review, Terminal, Files and Git, with an IDE-style
  mouse-resized 320–720px desktop panel and responsive drawers that preserve desktop width.
- Add bounded, revisioned read models for workspace-contained files, Git status/log/diff and review
  metadata, plus an explicit real-PTY terminal with short-lived WebSocket attach tickets.
- Add the v0.3.1 OpenAPI, migration guide and exact-artifact WEB31-P0-01..12 qualification contract.

### Changed

- Extend full browser qualification to 34 scenarios and the Node 22.12/24/26 critical matrix to 24
  scenarios, all bound to one source-clean tgz, installed-target identity and real Chrome runner.
- Raise the packed-package ceiling from 2.00 to 2.25 MiB for the bundled xterm client while keeping
  the 10 MiB unpacked and 1,500-entry limits unchanged.
- Keep terminal output off the Workbench SSE and durable Session history; Host restart reports the
  terminal as lost instead of fabricating recovery.

### Fixed

- Keep the conversation composer in a bounded bottom dock while transcript history and pending
  approval or follow-up content scroll independently.
- Bind Web commands and recovery snapshots to the active Session, make replay reset a terminal
  barrier, and preserve Session-scoped drafts across navigation.
- Serve large tool output only from a browser-safe derivative so arbitrary byte offsets cannot
  bypass redaction.
- Persist verified Thread heads and immutable transcript pages, use revision-bound collection
  cursors, and load additional browser history explicitly instead of draining every page at boot.

### Security

- Require UUID idempotency keys and current Workspace/Context guards for v0.3.1 resource operations;
  stale guards return `context_revision_conflict` with zero side effects.
- Bind every WEB31 screenshot and high-risk structured fact into the Web E2E receipt, including
  context targeting, PTY orphan count, SSE/WS isolation, axe and secret gates.

## [0.3.0] — CANDIDATE

> **Status: candidate.** This source version is not a Git tag, GitHub Release or npm publication
> until those external receipts are created and read back separately.

### Added

- Add `orion web`, a loopback-only React workbench for workspace/session navigation, streaming
  conversation and tools, follow-up/interrupt, approvals, Goal/Plan, model/effort settings,
  Skills/MCP metadata, large-output inspection and diagnostics.
- Add a versioned same-origin Web API with bounded cursor pagination, process-lifetime idempotency
  keys, settings compare-and-swap, session recovery snapshots and a replayable SSE event stream.
- Add a Host-owned Settings subsystem with strict typed reads, keyed exact-byte revisions,
  raw-preserving atomic batch updates, lock-inside CAS, external-edit convergence, last-good
  recovery and browser conflict handling.
- Add the source-audited v0.3.0 product plan, OpenAPI contract and v0.2.2 migration/rollback guide.

### Changed

- Set the release-qualification contract to maintained Node 22.12+, 24 and 26; publication now
  requires exact-tarball native SQLite, CLI, TUI, Web and fail-closed evidence on every line.
- Extract the CLI composition into one shared product bootstrap so Web, TUI, terminal and print
  retain the same AgentRuntimeController, OrionSessionRunner, OrionRuntime and durable stores.
- Resolve new root/child runtimes from the selected model profile and support exact
  BUILD/PLAN/AUTO selection at the next logical-request boundary.
- Align durable approval scopes with the product permission store as `once`, `project`, `global`.
- Route Web, TUI and slash-command changes for default model, project/global effort and tool
  confirmation through one Settings coordinator; keep the current-session model distinct from the
  default for newly created sessions.

### Security

- Bind Web only to `127.0.0.1`; require exact Origin, per-process nonce and JSON for mutations; cap
  bodies and pages; reject Host/path-boundary violations; and send restrictive browser headers.
- Keep pending approvals runtime-owned across browser disconnects, redact browser-safe projections,
  expose no provider credentials, and disconnect slow SSE clients so they recover by cursor rather
  than growing an unbounded response buffer.
- Expose credential readiness only, keep the configuration-file action pathless, preserve invalid
  external bytes, and require Runtime-idle mutation for settings that alter execution policy.

## [0.2.2] — 2026-08-27

> **Status: published.** The `v0.2.2` tag and npm `latest` package identify this release tree.

### Fixed

- Isolate Session discovery from malformed historical model context so one interrupted V2 Thread
  cannot block `/session`, `/resume --last`, or a healthy explicit resume for the whole project.
- Recover incomplete imported tool-call groups as explicit cancelled tool results before provider
  requests, retain the original transcript facts, and surface typed recovery provenance to users.
- Keep compact Goal token usage visible ahead of long objective text on narrow TUI status rows while
  preserving Goal escape controls and the purple mode override.

## [0.2.1] — CANDIDATE

> **Status: candidate.** This source version is not a Git tag, GitHub Release, or npm publication
> until each external receipt is created and read back.

### Fixed

- Project session discovery now projects message count, durable history size, and last activity
  from the authoritative v2 Thread instead of treating an empty legacy JSONL sidecar as the session.
- `/resume` and `/resume --last` restore the latest TurnCommit model history and replay the selected
  Thread into the UI exactly once without starting an extra model turn or duplicating user input.
- Runtime restart treats legacy Harness and Goal sidecars as first-migration seeds only; once a
  TurnCommit exists, its TaskContext and Goal state remain the sole durable authority.
- TUI submission uses the durable Thread user item as its only transcript echo, including queued
  revisions, so one user input renders as one entry.
- TUI context pressure now flows from the product Agent Loop into a live, width-prioritized `CTX`
  percentage instead of disappearing until the turn completes.
- Goal V2 TurnCommits now restore the purple Goal mode chrome, clear it on completion, and display
  only compact cumulative usage such as `tokens:581.6K` instead of an internal unlimited sentinel.
- Cross-process file locking no longer lets healthy contenders starve the active owner through the
  recovery sentinel; stale recovery remains serialized and fail-closed.

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
