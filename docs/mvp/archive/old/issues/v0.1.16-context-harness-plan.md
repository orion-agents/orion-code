# v0.1.16 技术方案 — Context Harness 持续上下文驾驭系统

> **版本定位**: 让 coding-agent 在长任务、多工具、多轮对话中持续高效工作，不因上下文膨胀、目标漂移或工具噪声跑偏。  
> **基础版本**: v0.1.15 / feat-v0.1.16 当前分支能力（token-based auto compact、动态模型 context discovery、session storage、memory、strategy tracker）。  
> **目标版本**: v0.1.16  
> **创建日期**: 2026-06-13

---

## 1. 背景与问题

Coding-agent 的核心难点不是“会不会调用工具”，而是长时间工作时能否稳定掌握完整上下文：

1. **目标漂移**: 多轮工具调用后，Agent 容易把局部错误当成主目标。
2. **上下文污染**: 大量日志、失败输出、重复文件内容挤占 token，关键约束被冲淡。
3. **压缩失真**: compact 后若只保留摘要，容易丢失未完成事项、用户硬约束、已验证事实。
4. **工具噪声**: LSP、shell、测试、网络请求都可能产生大量低价值输出。
5. **恢复困难**: 线程中断或 context 接近上限时，缺少可恢复的任务状态包。

v0.1.16 的升级目标是引入 **Context Harness**：在每一轮模型请求前，对“目标、约束、计划、证据、风险、未完成事项、压缩摘要”进行结构化装配，并在执行中持续校正。

---

## 2. 设计目标

### 2.1 核心目标

- **不跑偏**: 每轮请求都带上任务契约和当前计划，工具失败后回到主目标。
- **高效率**: 只把当前决策需要的上下文放进 prompt，长日志进入证据索引而非全量注入。
- **可恢复**: 任意时刻能生成 Context Capsule，支持 compact、resume、handoff。
- **可审计**: 每个关键结论都能追溯到用户指令、文件、命令输出或测试结果。
- **可渐进落地**: 复用现有 `Store`、`query()`、`session-storage`、`compact`、`memory`，不重写 agent loop。

### 2.2 非目标

- 不在 v0.1.16 实现多 Agent 调度系统重构。
- 不引入重型数据库依赖；优先使用现有 JSON/session/memory 能力。
- 不让模型自称“已验证”未执行过的操作；验证必须来自工具结果或明确用户确认。

---

## 3. 总体架构

```
User Input
   │
   ▼
┌────────────────────┐
│ Task Contract       │ 目标、硬约束、成功标准、禁止项
└─────────┬──────────┘
          ▼
┌────────────────────┐
│ Context Ledger      │ 结构化记录事实、决策、工具结果、风险
└─────────┬──────────┘
          ▼
┌────────────────────┐
│ Context Assembler   │ 每轮请求前装配最小充分上下文
└─────────┬──────────┘
          ▼
┌────────────────────┐
│ Query Loop          │ LLM -> Tool -> Result -> Strategy
└─────────┬──────────┘
          ▼
┌────────────────────┐
│ Drift Guard         │ 漂移检测、计划校正、验证门禁
└─────────┬──────────┘
          ▼
┌────────────────────┐
│ Capsule / Compact   │ 可恢复上下文包、95% 自动压缩
└────────────────────┘
```

---

## 4. 核心概念

### 4.1 Task Contract

Task Contract 是当前任务的硬边界，来自用户输入、项目规则、AGENTS.md、配置和系统策略。

```typescript
interface TaskContract {
  id: string;
  objective: string;
  userIntent: string;
  requirements: string[];
  successCriteria: string[];
  constraints: string[];
  prohibitions: string[];
  allowedScope: {
    cwd: string;
    files?: string[];
    commands?: string[];
  };
  createdAt: number;
  updatedAt: number;
}
```

示例：

```markdown
Objective: 修复 CLI 输入回显背景，使提交后的输入以灰色整行填充显示。
Requirements:
- 普通输入、多行输入、命令面板选择都一致。
- NO_COLOR / TERM=dumb 回退纯文本。
- 添加 UI 单元测试。
Success Criteria:
- npx tsc --noEmit 通过。
- tests/ui.test.ts 通过。
- 本地 node bin/openhorse 可肉眼验证。
Prohibitions:
- 不恢复旧的 markdown/table 背景补丁。
- 不修改无关文件。
```

### 4.2 Context Ledger

Context Ledger 是 Agent 的工作账本，记录“对当前任务有长期价值的信息”，而不是把完整对话直接塞回模型。

```typescript
type LedgerEntryType =
  | 'user_requirement'
  | 'decision'
  | 'file_fact'
  | 'tool_result'
  | 'test_result'
  | 'risk'
  | 'todo'
  | 'blocker'
  | 'verification';

interface ContextLedgerEntry {
  id: string;
  type: LedgerEntryType;
  content: string;
  source: {
    kind: 'user' | 'file' | 'tool' | 'test' | 'agent';
    ref?: string;       // file path, command id, message id
  };
  importance: 1 | 2 | 3 | 4 | 5;
  ttl: 'turn' | 'task' | 'session' | 'persistent';
  createdAt: number;
}
```

Ledger 的原则：

- 用户硬约束永远高优先级。
- 测试结果比模型推断优先级高。
- 最近失败的工具调用保留摘要，不保留大段日志。
- 文件事实要带路径和行号，避免“记得有个函数”但找不到来源。

### 4.3 Context Capsule

Context Capsule 是 compact、resume、handoff 的最小恢复包。

```typescript
interface ContextCapsule {
  contract: TaskContract;
  currentPlan: PlanStep[];
  completed: string[];
  openTodos: string[];
  keyFacts: ContextLedgerEntry[];
  changedFiles: string[];
  verification: {
    commandsRun: string[];
    passed: string[];
    failed: string[];
    warnings: string[];
  };
  nextAction: string;
}
```

Capsule 必须能回答三个问题：

1. 现在任务是什么？
2. 已经做了什么，证据是什么？
3. 下一步应该做什么？

---

## 5. 每轮上下文装配流程

v0.1.16 不再直接使用“system prompt + 全量 history”。每次调用模型前，由 Context Assembler 生成分层上下文：

```
┌──────────────────────────────────────────┐
│ Static Prompt                             │ OpenHorse 基础行为、工具规则
├──────────────────────────────────────────┤
│ Task Contract                             │ 当前目标和硬约束
├──────────────────────────────────────────┤
│ Active Plan                               │ 当前计划和正在执行的步骤
├──────────────────────────────────────────┤
│ Relevant Evidence                         │ 相关文件事实、测试结果、工具摘要
├──────────────────────────────────────────┤
│ Recent Turns                              │ 最近 3-8 轮关键消息
├──────────────────────────────────────────┤
│ Drift Warnings / Open Risks               │ 防跑偏提示
└──────────────────────────────────────────┘
```

### 5.1 Token Budget 分配

使用 `getModelContextWindow(modelId)` 获取模型窗口后，为各层分配预算：

| 层级 | 预算 | 策略 |
|------|------|------|
| Static Prompt | 5-10% | 可缓存，尽量稳定 |
| Task Contract | 5% | 永远保留 |
| Active Plan | 5% | 永远保留 |
| Evidence | 25-35% | 相关性排序 |
| Recent Turns | 20-30% | 只保留近因上下文 |
| Tool Results | 10-20% | 大输出摘要化 |
| Reserve | 15-25% | 留给模型输出和工具调用 |

当 `ctxPercent >= 80%` 时提前生成 Capsule；当 `ctxPercent >= 95%` 时触发现有 auto compact，但 compact 结果必须包含 Capsule。

### 5.2 Evidence 选择规则

Evidence 不按时间排序，而按“当前下一步需要什么”排序：

1. 当前计划步骤直接相关的文件和测试结果。
2. 最近失败且尚未解决的错误。
3. 用户明确强调的约束。
4. 已修改文件的 diff 摘要。
5. 历史背景和低风险事实。

---

## 6. 防跑偏机制

### 6.1 Drift Guard

Drift Guard 在三处触发：

1. **模型请求前**: 检查当前 plan 是否仍覆盖用户目标。
2. **工具调用前**: 检查工具是否服务于当前步骤。
3. **完成前**: 检查 success criteria 是否全部满足。

```typescript
interface DriftCheckResult {
  status: 'ok' | 'warn' | 'block';
  reason?: string;
  correction?: string;
}

interface DriftGuard {
  beforeModelRequest(ctx: HarnessContext): DriftCheckResult;
  beforeToolUse(toolName: string, args: unknown, ctx: HarnessContext): DriftCheckResult;
  beforeComplete(ctx: HarnessContext): DriftCheckResult;
}
```

触发 `warn` 时，向消息中注入短提示：

```markdown
[Harness Warning]
Current tool choice does not directly advance the active plan step:
"Add tests for user-input echo".
Prefer running targeted tests or editing tests/ui.test.ts.
```

触发 `block` 时，工具不执行，返回结构化错误。

### 6.2 Completion Gate

Agent 不能仅凭“我觉得完成了”结束。完成前必须满足：

- 有明确变更摘要。
- 每个 success criteria 有对应证据。
- 必要测试已运行，或明确说明未运行原因。
- 工作区未被无关变更污染；若存在用户已有变更，要区分说明。

```typescript
interface CompletionGateResult {
  canComplete: boolean;
  missing: string[];
  evidence: string[];
}
```

### 6.3 Strategy Loop 收敛

现有 `StrategyTracker` 已能记录失败尝试。v0.1.16 增强为“失败归因”：

| 失败类型 | 下一步 |
|----------|--------|
| command_not_found | 查 package scripts / docs |
| test_failure | 读取失败测试和相关代码 |
| permission_denied | 请求用户授权或换安全路径 |
| invalid_tool_args | 重新读取工具 schema |
| context_missing | 从 Ledger / files 召回上下文 |

避免 Agent 在同一失败模式上重复尝试。

---

## 7. 与现有模块集成

### 7.1 新增目录

```
src/harness/
├── types.ts              # TaskContract, ContextLedgerEntry, ContextCapsule
├── contract.ts           # 从用户输入/规则生成 TaskContract
├── ledger.ts             # ContextLedger 读写和优先级管理
├── assembler.ts          # 按 token budget 装配 prompt messages
├── capsule.ts            # Capsule 生成和恢复
├── drift-guard.ts        # 漂移检测与完成门禁
└── index.ts
```

### 7.2 修改点

| 文件 | 修改 |
|------|------|
| `src/framework/prompt.ts` | `PromptContext` 增加 `taskContract`, `contextCapsule`, `harnessWarnings` |
| `src/framework/query.ts` | 每轮 LLM 请求前调用 `ContextAssembler`，工具前调用 `DriftGuard` |
| `src/services/compact/auto-compact.ts` | compact 前生成 Capsule，compact 后把 Capsule 注入 summary |
| `src/services/session-storage.ts` | session meta 增加 capsule/ledger 摘要 |
| `src/framework/store.ts` | AppState 增加 `taskContract`, `contextLedger`, `activePlan` |
| `src/commands/index.ts` | `/compact`, `/status`, `/memory` 显示 harness 状态 |

### 7.3 Query Loop 集成草图

```typescript
const harness = getContextHarness({
  modelId: llm.getModel(),
  store,
  sessionId,
});

while (true) {
  const assembled = await harness.assemble(messages);
  const response = await llm.chatStream(assembled.messages, callbacks, tools);

  harness.recordAssistantResponse(response);

  for (const toolCall of response.toolCalls ?? []) {
    const guard = harness.beforeToolUse(toolCall);
    if (guard.status === 'block') {
      messages.push(harness.asToolBlockedMessage(toolCall, guard));
      continue;
    }

    const result = await toolExecutor(...);
    harness.recordToolResult(toolCall, result);
  }

  if (!response.toolCalls?.length) {
    const gate = harness.beforeComplete();
    if (!gate.canComplete) {
      messages.push(harness.asCompletionBlockedMessage(gate));
      continue;
    }
    return;
  }
}
```

---

## 8. Compact 与记忆策略

### 8.1 Compact 不再只压缩 messages

现有 auto compact 基于 `usage.promptTokens` 和模型 context window，在 95% 触发。v0.1.16 要求 compact 输出包含：

1. Conversation summary
2. Task Contract
3. Context Capsule
4. Open todos
5. Verification state

压缩后的第一条 user/system 注入：

```markdown
## Context Capsule

Objective: ...
Current step: ...
Completed:
- ...
Open todos:
- ...
Key facts:
- ...
Verification:
- Passed: npx tsc --noEmit
- Pending: npm test
Next action: ...
```

### 8.2 Memory 写入分级

| 内容 | 写入位置 | TTL |
|------|----------|-----|
| 当前任务 contract | session | task |
| 已验证项目事实 | project memory | persistent |
| 用户偏好/纠正 | user memory | persistent |
| 大日志/完整命令输出 | session artifact | session |
| Capsule | session meta | session |

### 8.3 召回策略

每次任务开始时召回：

- `AGENTS.md` / project memory / user memory
- 最近同项目 session summary
- 与当前文件路径相关的历史 facts
- 与当前错误文本相关的历史 fixes

召回内容进入 Ledger，不直接无限追加到 prompt。

---

## 9. v0.1.16 分阶段落地

### Phase 1: Context Ledger + Capsule (P0)

**目标**: 先解决 compact/resume 后不丢主线。

交付：

- `src/harness/types.ts`
- `src/harness/ledger.ts`
- `src/harness/capsule.ts`
- session 中保存 capsule
- `/status` 显示 active objective / open todos / verification

验收：

- 长任务中可随时生成 Capsule。
- compact 后仍保留目标、未完成事项和验证状态。
- 单元测试覆盖 ledger priority、capsule serialization。

### Phase 2: Context Assembler (P0)

**目标**: 每轮模型请求前构建最小充分上下文。

交付：

- `src/harness/assembler.ts`
- Token budget 分配
- Evidence relevance 排序
- query loop 接入 assembled messages

验收：

- `TaskContract` 永远出现在模型请求中。
- 大工具输出不会全量挤占 prompt。
- 在 128K 和 200K 模型上 budget 计算正确。

### Phase 3: Drift Guard + Completion Gate (P1)

**目标**: 防止工具调用和最终回答偏离任务。

交付：

- `src/harness/drift-guard.ts`
- tool-use precheck
- completion gate
- strategy failure taxonomy

验收：

- 与当前任务无关的高风险工具调用会被 warning 或 block。
- 未运行必需测试时，不能直接宣称完成。
- 工具连续失败后能切换策略。

### Phase 4: Memory Integration (P1)

**目标**: 把可复用事实沉淀到 memory，而非只存在当前 prompt。

交付：

- Ledger -> memory promotion 策略
- 用户纠正信号提取
- project facts 召回

验收：

- 用户明确偏好可跨 session 生效。
- 项目事实可被后续任务召回。
- 低价值日志不会进入长期 memory。

---

## 10. 配置项

建议新增到 `openhorse.json`：

```json
{
  "harness": {
    "enabled": true,
    "compactThreshold": 0.95,
    "preCompactThreshold": 0.8,
    "maxRecentTurns": 8,
    "evidenceBudgetRatio": 0.3,
    "driftGuard": "warn",
    "completionGate": true
  }
}
```

模式说明：

| 配置 | 默认 | 说明 |
|------|------|------|
| `enabled` | `true` | 是否启用 Context Harness |
| `preCompactThreshold` | `0.8` | 提前生成 Capsule |
| `compactThreshold` | `0.95` | 触发 auto compact |
| `maxRecentTurns` | `8` | 最近对话保留上限 |
| `evidenceBudgetRatio` | `0.3` | Evidence token 预算比例 |
| `driftGuard` | `warn` | `off` / `warn` / `block` |
| `completionGate` | `true` | 是否启用完成门禁 |

---

## 11. 测试计划

### 11.1 单元测试

新增测试文件：

```
tests/harness-ledger.test.ts
tests/harness-capsule.test.ts
tests/harness-assembler.test.ts
tests/harness-drift-guard.test.ts
```

覆盖：

- Ledger entry priority 和 TTL。
- Capsule 序列化/反序列化。
- Token budget 在不同模型 context 下正确分配。
- Evidence 排序。
- Drift warning/block。
- Completion gate 缺测试时阻止完成。

### 11.2 集成测试

新增场景：

1. **长日志场景**: 工具输出 20K token，assembler 只注入摘要。
2. **目标漂移场景**: 用户要求修 UI，模型尝试改 provider，drift guard warning。
3. **compact 恢复场景**: 95% context 后 compact，下一轮仍知道 open todos。
4. **测试门禁场景**: 修改代码但未运行测试，completion gate 要求验证。
5. **用户纠正场景**: 用户说“不要改配置”，后续工具调用不得写 config。

### 11.3 手工验证脚本

```
npm run build
npm test -- --no-coverage
node bin/openhorse
```

手工输入：

```text
帮我修复 CLI 用户输入背景，要求只改 UI 层，必须有测试，不要改 provider。
```

验证：

- `/status` 可见 objective、open todos。
- 工具失败后仍围绕 UI 修复。
- 完成前显示测试结果。

---

## 12. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| Harness prompt 过长 | 反而挤占工作上下文 | token budget 强制截断 |
| Drift Guard 误判 | 阻碍 agent 探索 | 默认 `warn`，P1 后再支持 `block` |
| Capsule 摘要不准确 | resume 后方向错误 | Capsule 来源必须来自 Ledger，不直接由模型自由发挥 |
| Evidence 召回不足 | 模型缺关键信息 | 当前步骤文件、失败测试、用户硬约束强制保留 |
| 实现侵入太大 | 影响现有 query 稳定性 | Phase 1 只旁路记录，Phase 2 再接入 assembler |

---

## 13. 验收标准

v0.1.16 交付完成时必须满足：

- [ ] Context Ledger 能记录用户要求、工具结果、测试结果、风险和 todos。
- [ ] Context Capsule 能在 compact 前生成，并在 compact 后保留任务主线。
- [ ] Context Assembler 能按模型 context window 装配最小充分 prompt。
- [ ] Drift Guard 至少支持 `warn` 模式，能发现明显偏离目标的工具调用。
- [ ] Completion Gate 能防止未验证时直接宣称完成。
- [ ] `/status` 能显示 harness 状态。
- [ ] 全量 `npm test -- --no-coverage` 通过。

---

## 14. 与后续版本关系

v0.1.16 建立 Context Harness 的骨架；后续版本可继续扩展：

- **v0.1.17**: 多 Agent 协作时共享 Ledger/Capsule。
- **v0.1.18**: Memory promotion 自动学习用户纠正。
- **v0.1.19**: 引入 evaluator，对完成结果做独立评估。
- **v0.1.20**: 云端/远程任务恢复，Capsule 作为跨设备 handoff 格式。

---

## 15. 推荐实现顺序

1. 先实现 `ContextLedger`，不改变现有行为，只记录。
2. 增加 `ContextCapsule`，接入 auto compact。
3. 增加 `/status` 展示 capsule 和 open todos。
4. 在 `query()` 前接入 `ContextAssembler`，逐步替换全量 messages。
5. 增加 Drift Guard 的 `warn` 模式。
6. 最后启用 Completion Gate。

这个顺序风险最低：先可观察，再可恢复，再优化 prompt，最后加约束。

---

## 16. 外部调研结论

> 调研日期：2026-06-13。主要参考 Codex 和 Claude Code；OpenClaude、OpenClaw 作为开源 TypeScript/网关形态补充。

### 16.1 Codex

Codex 的 harness 不是单个安全类，而是贯穿每个 turn 的运行时上下文。开源仓库 `openai/codex` 中的 `TurnContext` 同时携带 config、model context window、approval policy、permission profile、network、compact prompt、skills、dynamic tools 等信息；`compact` 任务在压缩前后执行 hooks，并把初始上下文重新注入到压缩后的历史中。

可借鉴点：

- **上下文层**：`AGENTS.md` 分层加载、project doc 大小限制、skills 按需加载、model context window 感知。
- **执行层**：每个 turn 都有统一 `TurnContext`，避免工具、模型、权限、压缩各自维护状态。
- **权限层**：sandbox mode 与 approval policy 分离；文件系统、网络、受保护目录、审批 reviewer 是独立配置面。
- **生命周期层**：`PreToolUse`、`PreCompact`、`PostCompact`、`Stop` 等 hooks 作为模型绕不开的确定性拦截点。

参考：[Codex open source](https://developers.openai.com/codex/open-source)、[Agent approvals and security](https://developers.openai.com/codex/agent-approvals-security)、[AGENTS.md](https://developers.openai.com/codex/guides/agents-md)、[Hooks](https://developers.openai.com/codex/hooks)、[Permissions](https://developers.openai.com/codex/permissions)。

### 16.2 Claude Code

Claude Code 的公开文档显示，其 harness 重点是“上下文管理 + 权限/沙箱 + hooks + 子 agent”。`CLAUDE.md`、auto memory、skills、MCP 工具名在 session 开始时加载；`/compact` 会把历史替换为结构化摘要，root 规则和 auto memory 会重新注入。权限采用 allow/ask/deny 规则和多种 permission modes；hooks 用于在工具调用、权限请求、compact、stop 等阶段执行确定性逻辑。

可借鉴点：

- **规则不只放 prompt**：`CLAUDE.md` 指导模型，permissions/hooks 才负责阻止行为。
- **压缩后重注入**：root 规则、memory、技能摘要和必要上下文必须在 compact 后恢复。
- **子 agent 隔离**：大范围调研可放到独立 context，只把结论回填主上下文。
- **完成前校验**：通过 stop hooks / best-practice 的验证流程，减少“未测就完成”。

参考：[Overview](https://code.claude.com/docs/en/overview)、[Memory](https://code.claude.com/docs/en/memory)、[Context window](https://code.claude.com/docs/en/context-window)、[Permissions](https://code.claude.com/docs/en/permissions)、[Hooks](https://code.claude.com/docs/en/hooks)、[Best practices](https://code.claude.com/docs/en/best-practices)、[Sandboxing](https://code.claude.com/docs/en/sandboxing)。

### 16.3 OpenClaude

OpenClaude 是开源 coding-agent CLI，目标是把 Claude Code 风格工作流接到多 provider。其 `src/query.ts` 使用 async generator 主循环，携带 `ToolUseContext`、`canUseTool`、auto compact tracking、fallback model、stop hooks、tool failure loop guard；`src/services/compact/` 中有 auto compact、reactive compact、micro compact、context partitioning、relevance pruning、PreCompact/PostCompact hooks。

可借鉴点：

- TypeScript 里可以把 harness 状态显式穿过 query loop，而不是藏在全局变量。
- auto compact 需要 failure circuit breaker，避免 prompt-too-long 后反复重试。
- 工具失败要做 loop guard，按 signature/category/path 归因，而不是只计数。
- read-only 工具可并发，mutating 工具串行，减少上下文和状态竞争。

参考：[Gitlawb/openclaude](https://github.com/Gitlawb/openclaude)。

### 16.4 OpenClaw

OpenClaw 更像个人助手/网关控制面，重点不在单仓库 coding loop，而在 channel、gateway、skills、subagents、exec approvals、ACP/Codex/Claude 后端 runtime。它的 sub-agent 默认独立上下文，只有明确需要时 fork 当前 transcript；子 agent 完成后把结果作为证据交回父 agent 复核。

可借鉴点：

- 远程/多入口任务要有 session ledger、审批边界和来源路由。
- `sessions_spawn` 的 isolated/fork 区分适合后续多 agent。
- exec approval 采用 deny/allowlist/ask/auto/full 分层策略，可作为 OpenHorse 后续 permission modes 参考。

参考：[openclaw/openclaw](https://github.com/openclaw/openclaw)、[Agent runtime architecture](https://docs.openclaw.ai/openclaw-agent-runtime)、[Sub-agents](https://docs.openclaw.ai/tools/subagents)、[Permission modes](https://docs.openclaw.ai/tools/permission-modes)、[Exec approvals](https://docs.openclaw.ai/tools/exec-approvals)。

---

## 17. 对 OpenHorse 的实现路径收敛

当前 OpenHorse 已有 `src/framework/query.ts`、`src/framework/prompt.ts`、`src/services/compact/*`、`src/services/model-context.ts`、`src/services/session-storage.ts`、`src/core/strategy-tracker.ts`，但 `src/harness/harness.ts` 仍偏任务前后校验。v0.1.16 应把 harness 从“安全检查类”升级为“turn-level context runtime”。

### 17.1 四个平面

| 平面 | 职责 | v0.1.16 最小落地 |
|------|------|------------------|
| Context Plane | contract、ledger、capsule、assembler | P0 必做 |
| Execution Plane | query loop、tool result、failure taxonomy | 复用 query/strategy-tracker 扩展 |
| Permission Plane | allow/ask/deny、workspace scope、risk hints | 先接入 `checkPermissions`，不重写 sandbox |
| Lifecycle Plane | hooks、compact、completion gate、status | 先实现内置 hooks/event bus |

### 17.2 插入点

1. **用户输入后**：生成或更新 `TaskContract`，写入 `ContextLedger`。
2. **`chatStream` 前**：`ContextAssembler` 根据 model context window 生成 messages。
3. **tool call 前**：`DriftGuard.beforeToolUse()` + 现有 `tool.checkPermissions()`。
4. **tool result 后**：摘要化写入 Ledger；失败进入 `StrategyTracker` taxonomy。
5. **auto compact 前**：生成 `ContextCapsule`；compact summary 必须包含 capsule。
6. **final answer 前**：`CompletionGate` 检查 success criteria、测试证据、未完成项。

### 17.3 推荐 PR 拆分

1. **PR-1 Ledger/Capsule 旁路记录**：新增 `src/harness/types.ts`、`ledger.ts`、`capsule.ts`，query loop 只记录，不改变 prompt。
2. **PR-2 Compact 保真**：`auto-compact.ts` 在 80% 生成 capsule，在 95% 注入 compact summary；补 resume/compact 测试。
3. **PR-3 Assembler 接入**：`prompt.ts` 增加 harness sections；`query.ts` 在 `chatStream` 前使用 assembled messages。
4. **PR-4 Drift/Completion Gate**：默认 `warn`，只对明显无关工具和未验证完成做拦截。
5. **PR-5 Status/Debug UX**：`/status` 显示 objective、open todos、ctxPercent、last verification、capsule age。

### 17.4 v0.1.16 不建议做的事

- 不先复刻 Codex Guardian；先保留接口和风险分类。
- 不把所有历史塞进 memory；memory 只保存可复用事实和用户偏好。
- 不让 compact 直接由模型自由总结任务状态；capsule 必须由 Ledger 生成。
- 不默认 block 探索性工具；先用 `warn` 收集误判样本。
