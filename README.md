# Orion Code

> **Goal-driven coding agent for the terminal.**
>
> v0.1.0 — Initial release

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.0-blue.svg)](https://www.typescriptlang.org)

---

**Language**: [English](README.md) | [简体中文](README.zh-CN.md)

---

## Overview

Orion Code is a terminal-based coding agent. It wraps LLM APIs in a harness of safety checks, tool orchestration, session management, and context awareness.

| Dimension | Description |
|-----------|-------------|
| **Agent Harness** | Safety boundaries, task constraints, result validation |
| **Tool Calling** | LLM autonomously invokes tools to complete tasks |
| **Memory System** | Layered memory with semantic search |
| **MCP Protocol** | Connect external MCP servers for tool extension |

## Quick Start

### Requirements

- Node.js >= 18.0
- npm >= 9.0

### Install & Run

```bash
# Install globally
npm install -g @orion-agents/orion-code

# Or from source
git clone https://github.com/orion-agents/orion-code.git
cd orion-code && npm install && npm run build

# Configure API key
export ORION_CODE_API_KEY=your-api-key
# or create ~/.orion-code/orion.json on first run

# Start
orion

# TUI renderer (default)
orion --ui tui

# Stable terminal fallback
orion --ui terminal

# Diagnostics
orion doctor

# Workspace diff
orion diff

# Commit plan
orion commit

# Non-interactive print mode
orion -p "review the current git diff"
echo "summarize this project" | orion --print
```

### TUI startup banner

The default TUI displays a portable sky-blue pixel banner: a compact landscape
rectangle with a line-drawn Orion constellation on the left and a full,
centered `OC` mark on the right, beside `ORION CODE | 猎户座`. The mark uses
three pixel densities and cyan depth levels for a finely layered appearance. It
works in Apple Terminal and automatically becomes a compact text banner in
narrow terminals.

```bash
# Default portable pixel banner
ORION_TUI_IMAGE=off orion

# Opt into a PNG in compatible terminals
ORION_TUI_IMAGE=auto orion
ORION_TUI_IMAGE=kitty orion
ORION_TUI_IMAGE=iterm2 orion

# Override the bundled PNG
ORION_TUI_ICON=/absolute/path/to/icon.png orion
```

Apple Terminal does not support either inline image protocol, so both protocol
requests safely fall back to the pixel banner instead of emitting image data.

## Key Features

| Feature | Description |
|---------|-------------|
| **Tool Orchestration** | 22 built-in tools: file I/O, shell, web, memory, git, LSP |
| **Multi-Model** | OpenAI-compatible providers with model switching |
| **Context Awareness** | Per-model context windows, token-based auto-compact |
| **MCP Protocol** | stdio MCP servers with heartbeat + reconnect |
| **Memory System** | User / Project / Session memory with semantic search |
| **Session Management** | Persistent sessions with history restore |
| **Safety Boundaries** | Bash safety checks, audit logging, permission modes |
| **Skills System** | Builtin + user + project-level skill extensions |
| **Multi-Agent** | Subagent fork/worker-pool with smart routing |
| **CLI Utilities** | `doctor`, `diff`, `commit`, `-p` print mode |

## Configuration

```json
{
  "providers": [{
    "id": "my-provider",
    "baseUrl": "https://api.example.com/v1",
    "apiKey": "$MY_API_KEY",
    "protocol": "openai-completions"
  }],
  "models": [{
    "id": "my-model",
    "provider": "my-provider",
    "model": "model-name",
    "contextWindow": 200000,
    "maxOutputTokens": 64000
  }],
  "defaultModel": "my-model",
  "toolConfirmation": "deny",
  "ui": { "renderer": "tui" },
  "subagents": { "mode": "auto", "maxParallel": 4 }
}
```

Configuration: `~/.orion-code/orion.json` | Priority: `CLI flags > config > env vars > defaults`

## Interactive Commands

| Command | Description |
|---------|-------------|
| `/help` | Show help |
| `/status` | System status |
| `/model` | View or switch models |
| `/config` | Show configuration |
| `/cost` | Token usage and cost |
| `/compact` | Trigger context compact |
| `/sessions` | List recent sessions |
| `/resume` | Resume last session |
| `/memory` | Memory system status |
| `/skills` | List loaded skills |
| `/mcp` | MCP server status |
| `/doctor` | Run diagnostics |
| `/diff` | Workspace diff |
| `/commit` | Commit plan |
| `/clear` | Clear screen |
| `/exit` | Exit |

## Migration from OpenHorse

```bash
orion migrate openhorse [--dry-run] [--include-env]
```

See [docs/mvp/v0.1.0.md](docs/mvp/v0.1.0.md) for full capability documentation.

## Development

```bash
npm install      # Install dependencies
npm run build    # Build
npm test         # Run tests (1,929+ tests)
npm run lint     # Lint
npm run format   # Format
```

## License

MIT License — see [LICENSE](LICENSE) for details.
