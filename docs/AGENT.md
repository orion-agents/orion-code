# Orion Code Docs Agent Guide

> Agent（Claude Code / Codex / Cursor 等）在 orion 项目中编写文档时必须遵循本规范。

---

## 1. 文件命名规则

所有 `docs/` 下的 Markdown 文件必须遵循三段式命名：

```
{scope}-{topic}-{type}.md
```

### 1.1 scope — 作用域（必填，放最前）

| scope | 含义 | 示例 |
|-------|------|------|
| `v0.2.20` | 绑定具体版本 | `v0.2.20-subagent-runtime-plan.md` |
| `v0.1.x` | 绑定版本区间（跨小版本） | `v0.1.x-mcp-integration-design.md` |
| `v0.1.0-v0.1.9` | 绑定版本范围 | `v0.1.0-v0.1.9-regression-plan.md` |
| `general` | 无版本绑定（长期/跨版本） | `general-architecture-design.md` |

**规则：**
- 版本号统一 `v` 前缀：`v0.2.20`，不用 `0.2.20`
- 有版本绑定的文档 scope 必须是版本号，不能省略
- 无版本绑定的文档 scope 必须是 `general`，不能省略
- scope 在最前，保证同版本文件在文件列表中自然聚在一起

### 1.2 topic — 主题关键词（必填，居中）

2-4 个短词，用 `-` 连接，描述文档的核心主题。

**规则：**
- 用英文小写，简短精确
- 不要写 `orion-` 前缀（已在项目内，冗余）
- 不要写 `optimization` / `upgrade` 等泛词，写具体对象：`agent-loop-rate-limit` 而非 `agent-loop-optimization`
- 多个主题用短横线连接：`harness-long-session`、`ink-ui-upgrade`

**示例：**

| 好的 topic | 不好的 topic |
|------------|-------------|
| `subagent-runtime` | `subagent-runtime-optimization-upgrade` |
| `agent-loop-rate-limit` | `agent-loop-optimization` |
| `harness-long-session` | `long-session-support` |
| `mcp-integration` | `mcp-integration-support-and-design` |

### 1.3 type — 文档类型（必填，放最后）

| type | 含义 | 何时用 |
|------|------|--------|
| `plan` | 规划/计划 | 还没做，描述要做什么、怎么做 |
| `design` | 架构设计 | 描述系统结构、接口、数据模型 |
| `report` | 实施报告/状态报告 | 已做完或做到一半，记录结果和状态 |
| `review` | 质量审查 | CR / 质量审查报告 |
| `audit` | 审计/就绪检查 | 就绪性检查、合规审计 |
| `run` | 测试运行记录 | 一次具体测试执行的记录 |
| `changelog` | 版本变更日志 | 一个版本的完成记录/变更清单 |
| `reference` | 参考文档 | 长期有效的参考、目标、北极星文档 |
| `proposal` | 提案 | 尚未批准的方案提议 |

**规则：**
- 每个文件必须且只能有一个 type
- type 放在文件名最后，紧跟 `.md` 前缀
- 选择最精确的 type，不要用 `plan` 代替 `design`，不要用 `report` 代替 `review`

### 1.4 特殊格式

**日期记录**（如 test runs）：日期放在 scope 后、topic 前，用 ISO 格式：

```
v0.2.18-2026-07-10-real-usage-run.md
```

**补丁/修复版本**：保留 `plus` / `fix` 标记在 scope 中：

```
v0.1.9-fix-changelog.md
v0.1.4-plus-changelog.md
```

---

## 2. 目录结构

目录不变，按职责划分：

```
docs/
├── agy/           # AGY 相关文档
├── claude/        # Claude Code 生成文档
├── codex/         # Codex 生成文档
├── old/           # 历史归档
│   └── issues/    # 历史问题文档
├── targets/       # 北极星/目标文档
├── test/          # 测试文档
│   └── runs/      # 测试运行记录
├── version/       # 版本记录
└── *.md           # 根级文档（仅 general-configuration-reference.md 等）
```

**规则：**
- 不创建新目录，除非有明确的新职责分类
- `old/` 是归档区，不再活跃的文档移入，不在 `old/` 下新建子目录
- `version/` 只放版本 changelog 和质量审查报告

---

## 3. 文档内容规范

### 3.1 文件头

每个文档开头必须包含元信息块：

```markdown
# 标题

> **状态**: draft / active / archived
> **版本**: v0.2.20（文档对应的版本）
> **日期**: 2026-07-14
> **作者**: hope / agent
```

### 3.2 正文

- 用中文或英文均可，保持单篇文档内语言一致
- 代码块标注语言：` ```ts `、` ```bash `
- 文件引用用相对路径：`src/runtime/subagents/supervisor.ts`
- 不在文档中硬编码绝对路径

### 3.3 状态流转

| 状态 | 含义 | 可流转到 |
|------|------|----------|
| `draft` | 编写中 | `active` |
| `active` | 当前有效 | `archived` |
| `archived` | 已归档，仅作历史参考 | — |

归档文档移入 `old/`，状态标记为 `archived`。

---

## 4. Agent 操作规则

1. **新建文档**：必须按 `{scope}-{topic}-{type}.md` 命名，放入对应目录
2. **重命名文档**：只改文件名，不改目录；重命名后检查文档内是否有自引用路径需要更新
3. **删除文档**：优先归档到 `old/`（改状态为 `archived`），而非直接删除
4. **版本绑定**：文档描述的工作属于某个版本时，scope 必须是该版本号；跨版本或长期文档用 `general`
5. **type 选择**：先做后写用 `report`，先写后做用 `plan`，描述结构用 `design`，审查用 `review`
6. **不要**：不要在文件名中加 `orion-` 前缀、不要用泛词做 topic、不要省略 scope 或 type

---

## 5. 命名速查

```
# 版本规划
v0.2.21-tui-convergence-plan.md

# 版本设计
v0.2.20-subagent-runtime-design.md

# 版本报告
v0.2.20-subagent-runtime-report.md

# 版本审查
v0.2.20-quality-review.md

# 版本变更
v0.2.20-changelog.md

# 长期参考
general-architecture-design.md

# 测试运行
v0.2.20-2026-07-14-real-usage-run.md

# 历史归档
v0.1.15-changelog.md
```
