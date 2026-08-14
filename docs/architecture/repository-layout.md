# Repository Layout and Dependency Boundaries

This document is the v0.1.8 ownership map for Orion Code. It describes the current supported
layout; it is not a promise that every historical directory remains public.

## Production source

| Path                                           | Responsibility                                                              | May depend on                              |
| ---------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------ |
| `src/product/`                                 | Product identity and product-level constants                                | `utils` and stable data types              |
| `src/core/`                                    | Agent primitives, strategy, artifacts, usage, and state                     | `framework`, `services`, `utils`           |
| `src/framework/`                               | Stable query, tool, store, and prompt contracts                             | lower-level services and utilities         |
| `src/runtime/`                                 | Turn orchestration, Goal/Plan/subagent lifecycles, renderer-neutral views   | core/framework/services/tools              |
| `src/services/`                                | Config, providers, storage, auth, MCP, compact, and infrastructure adapters | utilities and explicit contracts           |
| `src/commands/`                                | Slash-command descriptors and handlers                                      | runtime/services; never renderer internals |
| `src/tools/`                                   | Tool definitions and execution boundaries                                   | framework/services/utilities               |
| `src/tui-core/`                                | Renderer-neutral terminal layout and styling primitives                     | utilities only                             |
| `src/tui-ui/`                                  | The supported product TUI                                                   | runtime views and `tui-core`               |
| `src/terminal-ui/`                             | Technical and diagnostics renderer                                          | runtime views                              |
| `src/print-ui/`                                | Non-interactive text/JSON renderer                                          | runtime views                              |
| `src/ink-ui/`                                  | Deprecated compatibility renderer, retained until v0.2.0                    | runtime views                              |
| `src/sdk/`                                     | Supported programmatic entry points                                         | stable runtime/framework exports           |
| `src/memory/`, `src/migration/`, `src/skills/` | Domain services with explicit native or persistence boundaries              | services/framework/utilities               |

`src/ui-v2/` and `src/ink/` were retired in v0.1.8 because no production or public entry imported
them. Their live capabilities are owned by `src/runtime/ui-view-model.ts`, `src/tui-ui/`,
`src/terminal-ui/`, and the still-supported `src/ink-ui/` compatibility renderer.

## Tests and scripts

- `tests/*.test.ts` remains the Jest discovery boundary in v0.1.8. New tests may move into
  `unit/`, `integration/`, `contract/`, or `e2e/` only together with an explicit Jest discovery
  migration; directory cosmetics must not make tests disappear.
- `scripts/release/` contains release and dependency gates. They are read-only unless their help
  text explicitly says otherwise.
- `scripts/smoke/` contains real renderer/PTY smoke drivers and their shared helpers.
- `scripts/maintenance/` contains local deterministic repository maintenance.
- The former `test-runtime/` manual scripts were removed after their behavior was mapped to Jest or
  PTY replacements in [the v0.1.8 cleanup manifest](../plan/v0.1.8-cleanup-manifest.md).

## Documentation and assets

- `docs/plan/` contains current contracts and active roadmaps.
- `docs/goals/` contains durable product goals.
- `docs/architecture/` contains current system decisions and ownership boundaries.
- `docs/operations/` contains operator workflows.
- `docs/archive/releases/v0.1.x/` contains immutable historical plans, audits, and release evidence.
- `assets/orion-tui-icon.png` is the only runtime image shipped in the npm package. Generated or
  design-source artwork is not a runtime dependency and must live outside this repository.

## Dependency rules

1. Renderers consume typed runtime events/view models; runtime code does not parse renderer output.
2. Commands and tools do not import TUI implementation modules.
3. Native dependencies load only on semantic paths that require them and must fail with actionable
   diagnostics.
4. Public exports flow through supported package entry points. New deep imports require an explicit
   compatibility decision.
5. Deleting or moving a path requires an import/reference audit, replacement mapping, focused
   regression, full build/test, and exact npm-tarball verification.
