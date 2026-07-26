# OpenHorse Todo List

## Phase 3 - 高级 Agent

### 成本追踪 ✅ 已完成

- [x] CostTracker 类 - 记录 token 使用和估算成本
- [x] 模型定价表 - 支持 OpenAI/Claude/Qwen/Gemini/DeepSeek/GLM
- [x] 统计维度 - 按 Agent/任务/模型/时间
- [x] 预算检查 - setBudget/checkBudget
- [x] /cost 命令 - 显示会话用量和成本

**提交**: [668171d](https://github.com/Linux2010/openhorse/commit/668171d)

**新增文件**:
- `src/core/cost-tracker.ts` - CostTracker 类
- `tests/cost-tracker.test.ts` - 20 个测试用例

**修改文件**:
- `src/framework/store.ts` - 添加 costTracker 字段
- `src/framework/query.ts` - 执行后记录 usage
- `src/commands/index.ts` - 添加 /cost 命令

**测试**: 154 passed ✅

---

### 配置目录 ~/.openhorse ✅ 已完成

- [x] config-dir.ts - 配置目录路径管理 (支持 OPENHORSE_CONFIG_DIR 环境变量)
- [x] global-config.ts - 全局配置加载/保存 (openhorse.json)
- [x] session-storage.ts - 会话持久化 (JSONL 格式)
- [x] memory.ts - Memory 文件加载 (User/Project/Local 层级)
- [x] config.ts 重构 - 合并 GlobalConfig + 环境变量
- [x] CLI 集成 - 启动初始化、会话创建

**新增文件**:
- `src/services/config-dir.ts` - 配置目录路径管理
- `src/services/global-config.ts` - 全局配置加载/保存
- `src/services/session-storage.ts` - 会话持久化 (JSONL)
- `src/services/memory.ts` - Memory 文件加载

**修改文件**:
- `src/services/config.ts` - 合并 GlobalConfig + 环境变量优先级
- `src/cli.ts` - 启动初始化 ensureConfigDir、createSession

**目录结构**:
```
~/.openhorse/
├── openhorse.json         # 全局配置
├── OPENHORSE.md           # 用户级 memory
├── history.jsonl          # 命令历史
├── sessions/              # 会话数据
│   ├── {id}.json          # 会话元数据
│   └── {id}.jsonl         # 会话对话记录
├── projects/              # 项目配置
├── cost/                  # 成本记录
└── cache/                 # 缓存数据
```

**测试**: 196 passed ✅

---

### CLI 对话修复 ✅ 已完成

- [x] 修复 LLMService.chatStream - 添加 stream_options 提取 usage
- [x] 删除重复 /cost 命令定义
- [x] 合并 handleCost 和 showCost 实现
- [x] 添加回归测试 - cli-chat.test.ts, llm.test.ts

**提交**: [d8fb7fd](https://github.com/Linux2010/openhorse/commit/d8fb7fd)

**修改文件**:
- `src/services/llm.ts` - 添加 stream_options: { include_usage: true }
- `src/commands/index.ts` - 删除重复命令，合并 handleCost

**新增测试**:
- `tests/cli-chat.test.ts` - Store/Query/CostTracker 集成测试
- `tests/llm.test.ts` - LLMService 单元测试

**测试**: 207 passed (1 skipped) ✅

---

### Session 记录与恢复 ✅ 已完成

- [x] `/sessions` 命令 - 列出最近会话 (ID、模型、时间、tokens、成本)
- [x] `/resume` 命令 - 恢复会话历史 (`/resume` 最后会话 或 `/resume <id>`)
- [x] handleChat 集成 - 对话消息自动记录到 session `.jsonl`
- [x] loadSessionHistory - 恢复对话历史格式

**修改文件**:
- `src/commands/index.ts` - 添加 /sessions 和 /resume 命令处理
- `src/commands/types.ts` - CommandContext 添加 sessionId
- `src/cli.ts` - 传递 currentSession.id 到 CommandContext
- `src/services/session-storage.ts` - 添加 loadSessionHistory, listSessions, deleteSession

**存储格式**:
- Session 元数据: `~/.openhorse/sessions/{id}.json`
- Session 对话记录: `~/.openhorse/sessions/{id}.jsonl`

**测试**: 通过 node REPL 验证 ✅

---

### 待完成

- [ ] Task 链 - 基础抽象
- [ ] Coordinator - 核心编排

---

## Phase 2 - 工具系统 ✅ 已完成

- [x] 添加 Edit 工具 - 实现精确字符串替换（类似 OpenClaude 的 Edit tool）
- [x] 添加 Glob/Grep 工具 - 文件和内容搜索
- [x] 完善 Harness 边界检查 - 工具执行前的权限验证

### 完成详情

**提交**: [60413df](https://github.com/Linux2010/openhorse/commit/60413df)

**工具总数**: 7
- `read_file` - 读取文件内容
- `write_file` - 写入文件
- `list_files` - 列出目录
- `exec_command` - 执行 shell 命令
- `edit_file` - 精确字符串替换
- `glob` - 文件模式搜索
- `grep` - 内容正则搜索

**权限系统**:
- 破坏性操作需用户确认（default mode）
- 危险命令被拦截（rm -rf /, mkfs, fork bombs）
- acceptEdits/auto mode 自动允许

**测试**: 134 passed ✅

---

## Slash 命令系统改进 ✅ 已完成

- [x] 查看 openclaude 如何实现 切换模型的 /model 是如何做的，以及其他的 / 命令行

### 完成详情

**提交**: [550318a](https://github.com/Linux2010/openhorse/commit/550318a)

**增强命令**:
- `/model` - 模型别名(opus/sonnet/haiku/gpt4o/qwen/glm)、列表显示(list)、帮助(help)
- `/cost` - 显示会话 token 用量
- `/usage` (alias `/stats`) - 详细用量统计
- `/clear-history` (alias `/reset`) - 清空对话历史

**模型别名映射**:
| Alias | Model |
|-------|-------|
| opus | claude-opus-4-7 |
| sonnet | claude-sonnet-4-6 |
| haiku | claude-haiku-4-5 |
| gpt4o | gpt-4o |
| qwen | qwen3.5-plus |
| glm | glm-5 |

**测试**: 134 passed ✅