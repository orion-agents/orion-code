# Repository Guidelines

## Project Structure & Module Organization

Orion Code is a TypeScript CLI and agent harness. Source lives in `src/`, with the CLI entry point at `src/cli.ts` and public exports in `src/index.ts`. Key areas include `src/core/` for agent state, `src/framework/` for query/tool abstractions, `src/services/` for configuration, LLM, storage, and MCP services, `src/tools/` for tool implementations, `src/ui/` for terminal UI helpers, and `src/skills/` for built-in skills. Jest tests are in `tests/*.test.ts`; runtime smoke scripts are in `test-runtime/`. Docs and release notes are under `docs/`. Treat `dist/` as generated build output.

## Build, Test, and Development Commands

- `npm install`: install dependencies; Node.js 18+ is required.
- `npm run start` or `npm run cli`: run the CLI through `ts-node src/cli.ts`.
- `npm run dev`: run the CLI with `nodemon` for local iteration.
- `npm run build`: compile TypeScript into `dist/` and emit declarations.
- `npm test`: run the Jest suite from `tests/`.
- `npm run lint`: lint `src/` with ESLint.
- `npm run format`: format `src/` with Prettier.
- `npm run prepublishOnly`: build and test before publishing.

## Coding Style & Naming Conventions

Use strict TypeScript and follow the module style. Prettier enforces 2-space indentation, semicolons, single quotes, 100-character lines, ES5 trailing commas, and no parentheses around single-argument arrows. Prefer camelCase for variables/functions, PascalCase for classes/types, and kebab-case for command or documentation filenames. ESLint warns on `any` and unused variables, except unused arguments prefixed with `_`. Add JSDoc for public APIs when behavior is not obvious.

## Testing Guidelines

Jest with `ts-jest` is the main test framework. Place new tests in `tests/` with the `*.test.ts` suffix, using feature or bug names such as `config.test.ts` or `abort-signal.test.ts`. Add or update tests for new behavior and regressions. Keep coverage above the project guideline of 70%, and run `npm test` plus `npm run build` before opening a PR.

## Commit & Pull Request Guidelines

Use Conventional Commits, matching history: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, and `chore:`. Keep messages imperative and scoped to one change. PRs should include a clear description, linked issue when applicable, test/build results, and screenshots for CLI/UI changes. Avoid mixing unrelated refactors with feature or bug-fix work.

## Security & Configuration Tips

Do not commit `.env`, local config, generated databases, or secrets. Use `.env.example` and `docs/orion.example.json` as references for configuration. Review changes to `src/tools/bash_security.ts`, auth services, MCP transports, and file-writing utilities carefully because they affect command execution and local system access.


OH_TERMINAL_AGENT_RULE_MARKER_20260619


OH_TERMINAL_AGENT_RULE_MARKER_20260619


OH_TERMINAL_AGENT_RULE_MARKER_20260619


OH_TERMINAL_AGENT_RULE_MARKER_20260619


OH_TERMINAL_AGENT_RULE_MARKER_20260619
