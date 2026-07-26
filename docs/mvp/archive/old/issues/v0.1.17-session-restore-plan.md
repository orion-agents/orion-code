# v0.1.17 技术方案 - Project Session 记录与恢复

## 目标

v0.1.17 聚焦把 OpenHorse 的 session 从“能写文件”升级为“可按项目查找、恢复、继续写入”的可靠工作流。用户在同一个 Git 项目中重新启动 OpenHorse 后，可以恢复最近会话或指定会话；新会话记录保存在 `~/.openhorse/projects/<project-key>/sessions/`，旧版 `~/.openhorse/sessions/` 平铺文件仅作为 legacy fallback。

## 调研结论

Codex 的官方手册把会话称为 thread：本地保存 transcript，可用 `codex resume` 打开 picker，`codex resume --last` 恢复当前目录最近会话，`codex resume --all` 跨目录查找，`codex resume <SESSION_ID>` 指定恢复；状态根目录由 `CODEX_HOME` 控制，默认 `~/.codex`。Codex app-server 也提供 `thread/start`、`thread/resume`、`thread/fork` 语义。

Claude Code 的官方文档明确采用项目目录维度：session 是绑定到 project directory 的保存会话，持续写入本地 transcript；`claude --continue` 恢复当前目录最近会话，`claude --resume` 打开 picker，`claude --resume <name|id>` 指定恢复。transcript 存在 `~/.claude/projects/<project>/<session-id>.jsonl`，project key 由工作目录派生；picker 可以扩展到所有 worktrees 或所有项目。

OpenHorse 采用两者的共同核心：项目优先、ID 可指定、最近会话快捷恢复、JSONL transcript；默认恢复不混入全局历史，只有 `--all` 或按 ID 读取旧数据时才使用 legacy fallback。

## 当前问题

- 启动时立即创建空 session，导致 `/resume` 容易恢复到刚创建的空会话。
- `/sessions` 默认列出全局最近会话，不按当前 project 收敛。
- `/resume <id>` 会把历史恢复到 store，但后续消息仍写入启动时的新 session。
- tool call 相关 transcript 记录不完整，恢复后可能出现 tool 消息缺少对应 assistant `tool_calls` 的情况。
- session meta 缺少 `updatedAt`、`messageCount`、`projectKey` 等 picker 所需字段。

## 存储设计

采用 project-scoped 存储，并保留旧路径读取能力：

```text
~/.openhorse/
├── sessions/              # legacy only
│   ├── <session-id>.json
│   └── <session-id>.jsonl
└── projects/
    └── <project-key>/
        └── sessions/
            ├── <session-id>.json
            └── <session-id>.jsonl
```

`project-key` 由 canonical project path 派生。OpenHorse 优先使用 Git root；非 Git 目录使用当前目录的真实绝对路径。新 session 只写项目索引文件；`/sessions` 和 `/resume` 默认只读取当前 project。`/sessions --all`、`/resume <id> --all` 以及 `loadSessionMeta(id)` 可以读取 legacy 平铺文件，用于老数据兜底。

## 命令行为

- `/sessions`：默认列出当前 project 的最近 session。
- `/sessions --all`：列出本机所有 project 的最近 session。
- `/sessions --project <path>`：列出指定 project。
- `/resume`：当当前 project 有多个 session 时展示编号 picker；只有一个 session 时直接恢复。
- `/resume --last`：恢复当前 project 最近 session，不展示 picker。
- `/resume <number>` 或 `/resume #<number>`：按 `/sessions` / `/resume` picker 编号恢复。
- `/resume <id|prefix|name>`：在当前 project 中恢复指定 session。
- `/resume <id|prefix|name> --all`：跨 project 查找。
- `/session-rename <number|id|prefix|name> <new name>`：给 session 设置可读名称。

如果 `<prefix|name>` 匹配多个 session，OpenHorse 不会猜测恢复哪一个，而是打印冲突列表，要求用户使用更长 ID、编号或精确名称。

恢复成功后，当前运行时的 active session id 必须切换到被恢复的 session，后续对话继续追加到同一 transcript。

## 实现步骤

1. 增强 `config-dir`：增加 project key、project session 目录和路径函数。
2. 增强 `session-storage`：canonical project 解析、project session 列表、session 查找、resume/reopen、message count 和 updatedAt。
3. 改 CLI：session 改为懒创建；`/resume` 成功后切换 active session；支持启动参数 `--resume [id]` 和 `--continue`。
4. 改 transcript 记录：完整记录 assistant tool calls，再记录对应 tool results，避免恢复历史损坏。
5. 补测试：project 过滤、指定恢复、消息计数、project scoped 文件、SDK session 字段。

## 验证

- `npx tsc --noEmit`
- `npx jest tests/session-storage.test.ts tests/command-panel.test.ts tests/parser.test.ts --no-coverage`
- `npm test -- --no-coverage`
- 手工验证：在同一项目中运行 `npm run start`，对话一次后退出，再运行 `npm run start -- --resume` 或在 CLI 中输入 `/resume`，确认 history 恢复且后续消息继续追加到原 session。
