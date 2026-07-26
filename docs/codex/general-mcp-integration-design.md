# MCP Integration Design

## Current Status

OpenHorse v0.1.22 now supports stdio MCP servers configured at `~/.openhorse/mcp.json`. Before this change, MCP existed only as two wrapper tools, `mcp_list` and `mcp_call`, so the agent could not naturally choose MCP tools during a normal coding turn.

## Reference Model

Claude Code, Codex, and OpenClaude all converge on the same core pattern:

- Load MCP server configuration from user/project configuration.
- Connect servers during startup and keep connection state outside one LLM turn.
- Merge discovered MCP tools into the normal tool pool.
- Namespace MCP tools as `mcp__<server>__<tool>` to avoid collisions.
- Re-read the latest MCP tool state when constructing a turn, avoiding stale tool lists.

OpenClaude additionally keeps MCP clients and tools in app state and merges them into the REPL tool pool. Codex uses the same `mcp__...` convention in tool exposure and code-mode tool declarations.

## Configuration

Primary config path:

```text
~/.openhorse/mcp.json
```

Example:

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/hope/ai-project"],
      "env": {
        "API_TOKEN": "${API_TOKEN}"
      },
      "cwd": "/Users/hope/ai-project"
    }
  }
}
```

Supported fields: `type`, `command`, `args`, `env`, `cwd`, and `disabled`. `type` defaults to `stdio`. The legacy top-level `servers` key is accepted for compatibility, but new configs should use `mcpServers`.

## Runtime Behavior

Startup calls `mcpManager.connectAll()` in the background. When servers connect, their tools are exposed through `getRuntimeTools()`, which returns built-in tools plus dynamic MCP tools. Each chat turn resolves skills and builds the system prompt from this runtime tool pool, so newly connected MCP tools are available without restarting the process.

MCP tool calls return OpenHorse `ToolResult` objects. Text content is flattened for the model, and `structuredContent` is retained in metadata when present. MCP `isError` responses become failed tool results.

## Current Scope

Implemented:

- stdio MCP client over newline-delimited JSON-RPC.
- `initialize`, `notifications/initialized`, `tools/list`, and `tools/call`.
- Heartbeat and exponential reconnect.
- First-class dynamic tools named `mcp__<server>__<tool>`.
- Env expansion for `command`, `args`, `env`, and `cwd`.
- `/mcp`, `mcp_list`, and `mcp_call` for diagnostics.

Not implemented yet:

- Streamable HTTP/SSE MCP transports.
- MCP resources and prompts.
- MCP elicitation dialogs.
- OAuth or interactive server auth.
- Project-level trusted MCP scopes.

## Next Steps

1. Add transport adapters for streamable HTTP and SSE while preserving the same `MCPServerManager` API.
2. Add resources and prompts to the UI suggestion model after the Ink-style UI rewrite.
3. Persist server health diagnostics under `~/.openhorse/cache/mcp/`.
4. Add permission policies for MCP namespaces, such as `mcp__github__*`.
5. Add `/mcp reconnect <server>` and `/mcp disable <server>` commands.
