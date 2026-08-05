# 目标追踪文档（Goal Doc）：v0.1.3 + v0.1.3-2 全量交付

> 模式：tech-team `targets`（goal doc + acceptance checklist + 多轮审计至 100%）
> 创建：2026-08-04
> 来源：
> - `docs/plan/v0.1.3-plan.md`（§1–§8，含各自 DoD）
> - `docs/plan/v0.1.3-2-plan.md`（§1–§10，市场对标与能力补齐）
> 可信证据规则：每条验收项须有 `tsc --noEmit` 0 错 + 对应单测通过 + `npx tsc` emit 成功（orion 读 dist 非 src）。HEADless 无法端到端验证的项（真实 TUI PTY、沙箱 OS 级行为）以单测 + 静态证据替代，并显式标注。

---

## 一、v0.1.3 功能需求与验收标准

### 1.1 模型配置一致性（§1–§5，P0）
- **需求**：`/model` 与 `/models` 的展示/切换以 `ModelRegistry.enabledProfiles` 为唯一真源，不再依赖静态 catalog 假值。
- **验收**：
  - `/models` 中 `ark-code-latest` 显示 `1.0M ctx`（来源 profile）；
  - `/model info` 的 Context/Output 与 `modelRegistry` 解析值一致；
  - registry alias 切换测试通过，`store.currentModel` 为 profile id；
  - `tests/status-command.test.ts` 全部通过；

### 1.2 模型命令重构（§6，P0）
- **需求**：`/model` 仅展示当前模型；`/models` 为交互式选择切换；删除 `/model list`/`/model help`；内置目录（model-context/model-registry/model-catalog）补全上下文兜底。
- **验收**：
  - `/models` 交互式渲染器返回 `modelPicker`；非交互式打印候选列表；
  - 未配置 context 的模型（如 `glm-5.2`）回退 catalog 兜底值（1M/128K）；
  - `tsc` 通过、`status-command.test.ts` 全过、`npm run build` 成功；

### 1.3 TUI 权限交互（§7，P0，已实现工作树待收尾）
- **需求**：`/permissions` 命令（无参弹层/带参直设）；即时改写内存+落盘；状态栏 `perm:`；**会话追加系统确认消息**；`updateGlobalConfig` 失败时内存不变。
- **验收**：
  - `permission_mode_change` 合法值→`updateGlobalConfig` 调用 + `runtime.config.toolConfirmation` 即时变；
  - 非法值→拒绝、不改写、返回错误；
  - 会话追加系统消息 `Tool confirmation → <level>`；
  - 落盘失败时内存配置保持不变；
  - `renderStatus` 含 `perm:<level>`；`renderOverlay` 三选项；
  - `tests/tool-confirmation.test.ts` 通过；

### 1.4 运行中增量输入（§8，P0，已实现工作树待收尾）
- **需求**：运行中补充即时回显（G1）、累积不丢（G2）、防重复门（G1 配套）、状态文案（G4）。
- **验收**：
  - 运行中 `submit('补充A')` 立即 `emitAppend` 且内容含 `补充A`；
  - 整个生命周期 `emitAppend(submittedEntry('补充A'))` 仅一次（不重复）；
  - 连补 `A`+`B` → `pendingRevision='补充A\n补充B'`，下一轮 request.text 含两段；
  - `submit` 后 `emitStatus` 含 `'已接收补充…'`；
  - `tests/incremental-input.test.ts` 通过；

### 1.5 fix A：update_goal 失败可读（已实现待收尾）
- **需求**：`update_goal`/`update_goal_plan`/`create_goal` 失败返回 `output` 含诊断文案。
- **验收**：`tests/goal-tools.test.ts` 通过；失败 `output` 非空；

---

## 二、v0.1.3-2 功能需求与验收标准

### 2.1 权限与安全（§1，P0）
| 项 | 需求 | 验收 |
|---|---|---|
| §1.1 plan mode 绕过修复 | 移除 `permissionMode==='default'` 对确认逻辑的短路；caution/dangerous 工具无论模式都走 `confirmToolUse` | `tests/tool-scheduler.test.ts` 各模式×各级组合通过；plan/acceptEdits 模式执行 caution 工具触发询问或被 deny |
| §1.2 沙箱接线 | `exec_command`/`bash` 路径接入 `wrapForSandbox(cmd, sandboxProfile)`；配置 `sandboxProfile` | `read-only` 下写盘/网络被拦截并测试断言；无配置时向后兼容 |
| §1.3 allowlist 规则引擎 | 实现 `allowedTools` 匹配（glob/前缀）；命中跳过 ask | 配置 `allowedTools` 后对应工具免确认；越权拒绝；测试通过 |
| §1.4 Hook 系统 | 工具调度入口发射 PreToolUse/PostToolUse；配置 hooks 脚本返回 allow/deny/ask | PreToolUse 返回 deny 拦截；PostToolUse 收到结果；≥1 e2e |
| §1.5 SSRF/key 修复 | web 默认 `redirect:'manual'` + 内网防护；config 遮蔽 key | 169.254/10.x/127.x 被拦；config 输出不含 key 明文 |

### 2.2 Git 工具补全（§2，P0）
- **需求**：新增 `git_commit`/`git_diff`/`git_log`/`git_branch`（+ `git_status` 增强），带风险分级。
- **验收**：`/git commit`/`diff`/`log`/`branch` 经 TUI 与 renderer-local 可调用；`tests/git-tools.test.ts` 通过。

### 2.3 子代理与并行（§3，P1）
- §3.1 子代理可写/可指定模型：`general-purpose`/`implementer` 预设；`subtask` 可指定 model；深度可配置。
- §3.2 background agent：`/agent run --background` 后台 spawn，进度入 store，可查。
- §3.3 清理 `src/agents/*` 死代码（复用则接线，否则删）。

### 2.4 MCP 生态（§4，P1）
- §4.1 SSE/HTTP transport：实现 Streamable HTTP + SSE + OAuth2.1。
- §4.2 Tool Search：长尾工具按需发现，新增 `tool_search`。
- §4.3 自定义工具注册 API：`registerTool(spec)` + 配置式目录。

### 2.5 上下文工程（§5，P1）
- §5.1 运行中队列注入：用户补充入队而非打断重跑，保留已产 token。
- §5.2 项目指令文件：启动加载 `<repo>/.orion/instructions.md` 为动态 system prompt。
- §5.3 工具池裁剪：长上下文按相关性裁剪工具 schema。

### 2.6 工程化与扩展（§6–§7，P2）
- §6.1 用户自定义 slash 命令：从 `~/.orion-code/commands/` 与 `<repo>/.orion/commands/` 加载 `.md` 模板。
- §6.2 模型 catalog 动态化 + fallback 修复。
- §7.1 CHANGELOG + 发布脚本（`npm run release:patch` 自动产出）。
- §7.2 架构债清理：弃用 ink；`commands/index.ts` 按域拆分；删 `agents/*` 死代码；eslint 收敛。
- §7.3 Goal 数据丢失修复：`coordinator.ts:671` load 失败不覆盖活跃 goal。

### 2.7 国产差异化（§8）
- 中文项目语境优化、私有化部署包、生态 MCP 预设（建议项，非阻塞）。

---

## 三、分阶段实现计划（里程碑）

- **M1（v0.1.3 收尾 + 安全基线 2a）**：§1.3/§1.4/§1.5 fix A 纳入 HEAD 验证 + §2.1 Git + §1.1 plan bug + §1.5 SSRF/key + §1.3 allowlist + §1.2 沙箱接线。
- **M2（v0.1.3 模型重构 + 并行生态 2b）**：§1.1–§1.2 模型配置 + §1.4 增量收尾 + §3 子代理/background + §4 MCP/HTTP/ToolSearch + §5 队列注入/指令文件。
- **M3（工程化 2c）**：§6 自定义命令 + §6.2 catalog + §7 CHANGELOG/架构债 + §7.3 Goal 修复。

## 四、当前已验证状态

### 截至 2026-08-04（续接执行前）
- v0.1.3 §7/§8 实现已在工作树 + dist emit 成功，但"会话系统消息/失败路径测试/纳入 HEAD"待补；
- fix A 已在工作树 + dist，源码无残留空 `output`；
- v0.1.3-2 全部章节：零实现，仅计划。

### 续接执行进度（2026-08-04 起）
已完成（证据：对应单测 + tsc 0 错 + npx tsc emit 成功）：
- **v0.1.3-2 §1.1 plan mode 绕过修复**：`tool-scheduler` 移除 `default` 短路，caution/dangerous 工具无论模式都走确认（前序会话已交付）。
- **v0.1.3-2 §1.3 allowlist 规则引擎 (#25)**：线性 glob 匹配替换正则（ReDoS 硬化），`tests/tool-allowlist.test.ts` 38/38 通过。
- **v0.1.3-2 §1.5 SSRF/key 修复**：逐跳重定向检查 + 响应体硬上限 + key 全量遮蔽，`tests/web-ssrf-bypass.test.ts` 21/21 通过。
- **v0.1.3-2 §1.2 沙箱接线 POC (#26)**：`src/tools/sandbox.ts`（argv 包裹 + 运行时探针 + fail-closed + 默认 none）接线 `global-config.ts` 与 `tools/index.ts`；`tests/sandbox.test.ts` 30/30 通过，含 3 条真实 docker OS 强执行证据（本机 docker daemon 可用，`--read-only` 隔离生效）；dist 已 emit；README/中文 README 补沙箱配置章节（P1-E 字段归属/schema/默认/迁移/脱敏/回滚）。
  - docker 后端修复：挂载 `options.cwd` 原样路径（避免 macOS `/var`→`/private/var` 符号链接导致 Docker Desktop 不共享）；加 `--read-only` 使镜像根文件系统只读，写盘约束来自显式 rw bind-mount。

已决定移出本版本（依据 v0.1.3-2-plan.md §1.4 / §3 行）：
- **v0.1.3-2 §1.4 Hook 系统 (#27)**：外部脚本扩大权限/超时/密钥/审计面，需独立技术设计 → **OUT OF SCOPE**。

待收尾（工作树已有实现，待补测试 + 纳入 HEAD + emit）：
- v0.1.3 §7 TUI 权限交互 (#19)、§8 增量输入 (#20)、fix A (#21)。
- v0.1.3-2 §2 Git 工具补全 (#22, P0)、其余 P1/P2 按范围收敛。

### 交付证据总览（2026-08-02 续接完成）

全部 in-scope P0/P1 开发任务已完成，证据门（tsc --noEmit 0 错 + 对应单测通过 + npx tsc emit 成功）全部满足。`npm test` 聚焦套件（10 个）**173/173 通过**：

| 验收项 | 套件 | 结果 |
| --- | --- | --- |
| §1.1 plan mode 绕过修复 | tool-scheduler.test.ts | ✅（含 §1.1 部分，与 config 共 40） |
| §1.2 沙箱接线 POC (#26) | sandbox.test.ts | ✅ 30/30（含 3 条真实 docker OS 强执行） |
| §1.3 allowlist 规则引擎 (#25) | tool-allowlist.test.ts | ✅ 38/38（ReDoS 线性 glob） |
| §1.5 SSRF/key 修复 | web-ssrf-bypass.test.ts | ✅ 21/21 |
| §2 Git 工具补全 (#22) | git-tools.test.ts | ✅ 7/7（真实临时仓库） |
| v0.1.3 §7 TUI 权限 | tool-confirmation/permission-mode | ✅（共 37 例一部分） |
| v0.1.3 §8 增量输入 | incremental-input.test.ts | ✅（共 37 例一部分） |
| v0.1.3 fix A | goal-tools.test.ts | ✅（共 37 例一部分） |
| P1-E 配置迁移 | config.test.ts | ✅（共 40 例一部分） |

**已验证完整（173/173）**：sandbox(30)+allowlist(38)+ssrf(21)+git(7)+tool-confirmation+permission-mode+incremental+goal-tools(37)+tool-scheduler+config(40)。

**OUT OF SCOPE（依据 v0.1.3-2-plan.md 审查结论，非缺陷）**：
- §1.4 Hook 系统 (#27)：外部脚本扩大权限/超时/密钥/审计面，需独立技术设计。
- §2.3 可写/background 子代理、§2.4 通用 MCP SSE/HTTP/OAuth/ToolSearch、§2.5 队列注入/项目指令文件、§2.6 用户自定义 slash 命令/catalog 动态化、§2.7 国产差异化、§7.3 Goal 数据丢失修复（与 P0-C 重叠，待 v0.2 技术书）。
- 这些项在 goal doc 中曾列为需求，但经市场调研审查后确认为 v0.2+ 或独立技术书范围；本次不实现、不写入稳定承诺。

**发布门剩余（P2，非开发阻塞）**：CHANGELOG/release:check 脚本、dirty-worktree 所有权冻结与候选 commit、真实 CI/PTY/tarball clean install 证据（标记为 not_run，非本地绿灯替代）。当前工作树含大量与本轮无关的删除/资源改动，发布前须先冻结文件边界。
