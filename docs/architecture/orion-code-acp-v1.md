# Orion Code ACP v1 Contract

Status: implementation contract for the `@orion-agents/orion-code@0.3.2` managed-sidecar Preview candidate. This source state is not an npm publication or Git tag.

## Process contract

- `orion-code` starts the ACP server directly. `orion acp` is an equivalent debug alias.
- `orion-code --help`, `orion-code --version`, `orion acp --help`, and `orion acp --version` stay on the ACP path; they do not print CLI help or version text to protocol stdout.
- The transport is newline-delimited JSON-RPC over stdin/stdout using ACP protocol version `1`.
- Stdout is protocol-only. Diagnostics and fatal errors use stderr.
- ACP startup forces `ORION_CODE_DISABLE_ENV_FILES=1`; it never loads user, project, or package `.env` files.
- EOF, SIGINT, SIGTERM, explicit session close, and process shutdown close active runtimes and release owned leases idempotently.

## Capability contract

The initial server advertises:

- baseline `session/new`, `session/prompt`, `session/cancel`, and `session/update`;
- `session/load`;
- `session/close`.

Text and resource-link prompt blocks are accepted. Image, audio, and embedded-resource blocks return an explicit unsupported-content error. Authentication methods are empty because provider configuration remains owned by Orion Code. Session-scoped stdio MCP servers are accepted through ACP `mcpServers`; their command, arguments, and environment are passed to Orion Code's existing lazy MCP runtime, and their child processes close with the session. HTTP, SSE, ACP, and other undeclared MCP transports return an explicit unsupported-transport error. Additional directories are not advertised, and non-empty values are rejected rather than ignored.

## Runtime port

ACP handlers depend on `OrionAcpRuntimePort`, not terminal or Web view models. The product implementation composes the existing product runtime and session runner. A future SDK may provide another implementation without changing Studio's ACP integration.

Each prompt observer receives ordered session updates and a fail-closed permission callback. The prompt response is returned only after the product runner reaches its durable terminal state. A session accepts one active prompt; separate sessions may run concurrently.

`session/load` validates durable session metadata before starting a runtime, replays durable user, assistant, and tool history in order, drains the update mapper, and only then marks the session ready. History replay does not require a configured model. A prompt received while the session is loading fails with `ORION_ACP_SESSION_BUSY`.

## Content and event mapping

| Orion fact                        | ACP update                                          |
| --------------------------------- | --------------------------------------------------- |
| user transcript delta             | `user_message_chunk`                                |
| assistant transcript delta        | `agent_message_chunk`                               |
| reasoning/status transcript delta | `agent_thought_chunk` when represented as reasoning |
| tool start                        | `tool_call`                                         |
| tool completion/failure           | `tool_call_update`                                  |

Transcript updates may contain cumulative text. The mapper tracks the number of UTF-16 code units already sent for each stable message ID and emits only the suffix. A replacement or shorter text begins a new stable revision instead of producing a negative delta.

## Session identity, paths, and ownership

- `cwd` must be absolute and must resolve to an existing directory. Symlinks are canonicalized.
- `session/load` requires the canonical requested cwd to match durable session metadata.
- `ORION_CODE_CONFIG_DIR` continues to own model/provider/MCP/user configuration.
- `ORION_CODE_DATA_DIR` owns mutable history, usage, projects/sessions, cache, logs, receipts, and session leases. If unset, it falls back to the historical config-root layout without moving data.
- A writable session has a cross-process lease directory containing session ID, PID, process-start identity, random owner token, and sidecar version. A live matching owner is busy. A stale owner is recovered only after liveness and process-start checks, followed by an atomic rename/reacquire step.

## Permission contract

The first version offers `allow_once` and `reject_once`. Cancellation, disconnect, timeout, malformed response, duplicate response, or unknown option all reject. Durable project/global grants are not offered until Orion Code exposes a durable permission-grant port.

## Golden journey

`tests/fixtures/acp-v1/golden-stdio.jsonl` fixes the stable request/update ordering for initialize, new session, prompt, and close. IDs marked with angle-bracket placeholders are normalized by the transcript test.
