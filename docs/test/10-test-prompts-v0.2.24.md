# Orion Code v0.2.24 — 10 方向自动化测试计划

> 每个测试方向是一个自包含的 prompt，设计给 AI coding agent 执行。
> 每个方向应独立运行：先写失败测试（确认问题存在），再写实现（如需），最后回归全量。
> 测试代码放在 `tests/` 目录，测试结果和报告放在 `docs/test/logs/` 目录。

---

## Prompt 1: Session 并发安全测试

**目标**: 验证 `session-storage.ts` 中 `appendSessionMessage`、`saveSessionMeta`、`updateSessionStats` 等函数的并发安全性。验证 `touchSession` 的 read-modify-write 流程在并发场景下不丢消息、不双计。

**执行步骤**:
1. 写测试: 用 `Promise.all` 并发调用 `appendSessionMessage` 100 次，验证 `messageCount` 一致
2. 写测试: 并发调用 `updateSessionStats` 10 次，验证 `tokenCount` 累加正确
3. 写测试: 并发读写 `saveSessionMeta` + `loadSessionMeta`，验证不出现半写数据
4. 跑回归: `npm test -- --runInBand --testPathPatterns="session"`
5. 结果写入 `docs/test/logs/`

**预期发现**: RMW 竞态可能在高并发下丢失 token 计数或消息计数

---

## Prompt 2: MCP 客户端稳定性测试

**目标**: 验证 `src/tools/mcp.ts` 的 buffer 处理、错误恢复、进程生命周

**执行步骤**:
1. 写测试: 模拟 MCP server 发送非 JSON 行（banner/debug），验证 buffer 清理
2. 写测试: 模拟 MCP server 崩溃后重连，验证 `pedingRequests` 全部 reject
3. 写测试: 模拟 MCP server 发送分片 JSON（多次 data 事件），验证重组正确
4. 写测试: `mcpManager.getClient` 重复调用只创建一次连接
5. 跑回归: `npm test -- --runInBand --testPathPatterns="mcp"`
6. 结果写入 `docs/test/logs/`

**预期发现**: 非 JSON 行残留、server 崩溃后未清理 `pedingRequests`

---

## Prompt 3: Bash 安全绕过测试

**目标**: 验证 `src/tools/bash_security.ts` 的鲁棒性。确保危险命令检查不能被编码、拼接、引用等方式绕过。

**执行步骤**:
1. 写测试: 用各种编码绕过（反斜杠、单引号、双引号、变量拼接）尝试调用 `rm -rf /`
2. 写测试: 验证 `curl | sh` 和 `wget -O - | bash` 等管道攻击被拦截
3. 写测试: 验证安全回退命令如 `sudo`、`chmod 777`、`chown` 需要权限
4. 写测试: 验证只读命令 `ls`、`cat`、`echo` 在白名单且可直接通过
5. 跑回归: `npm test -- --runInBand --testPathPatterns="bash_security"`
6. 结果写入 `docs/test/logs/`

**预期发现**: 某些编码方式可能绕过检测

---

## Prompt 4: Edit/Write 文件操作边界测试

**目标**: 验证 `edit_file` 和 `write_file` 的边界情况处理

**执行步骤**:
1. 写测试: `old_string` 在文件中出现 0 次、1 次、多次 → 分别验证
2. 写测试: `replace_all` + `fuzzy_match` 组合语义验证
3. 写测试: 空文件、非常大的文件、只读文件、目录路径的编辑拒绝
4. 写测试: `write_file` 创建深层目录不存在时的错误处理
5. 写测试: `new_string === old_string` 时的行为
6. 跑回归: `npm test -- --runInBand --testPathPatterns="edit|write"`
7. 结果写入 `docs/test/logs/`

**预期发现**: 空文件编辑、深层目录创建缺失错误处理

---

## Prompt 5: LLM Provider 重试与 Fallback 测试

**目标**: 验证 `src/services/llm.ts` 中的 API 重试、fallback 模型切换、stream abort 的正确性

**执行步骤**:
1. 写测试: 模拟 API 返回 429 → 验证重试次数和退避时间
2. 写测试: 模拟 API 返回 500/502/503 → 验证 fallback 模型切换
3. 写测试: 模拟 stream 中途断开 → 验证部分内容可恢复
4. 写测试: 模拟 API key 无效 (401) → 验证不无限重试
5. 写测试: context 超限时自动 compact 触发
6. 跑回归: `npm test -- --runInBand --testPathPatterns="llm|provider|retry"`
7. 结果写入 `docs/test/logs/`

**预期发现**: 某些错误码未正确分类导致错误重试策略

---

## Prompt 6: TUI 渲染器 Resize 与输入完整性测试

**目标**: 验证 TUI 渲染器在窗口 resize、多行输入、CJK 字符、bracketed paste 场景下的稳定性

**执行步骤**:
1. 写测试: PTY 中连续 10 次 resize（40→120→80→60→100 列），验证无重复 status
2. 写测试: CJK 输入"你好世界" + backspace，验证光标位置正确
3. 写测试: 粘贴 20 行文本（bracketed paste），验证不被拆成多次提交
4. 写测试: 输入过程中 resize → 输入不丢失
5. 跑回归: `npm test -- --runInBand --testPathPatterns="tui-ui-pty|tui-ui-layout|tui-ui-runner"`
6. 结果写入 `docs/test/logs/`

**预期发现**: resize 时可能丢失输入、status 重复渲染

---

## Prompt 7: Transcript 污染与持久化一致性测试

**目标**: 验证 overlay/picker/help/status 等 UI 临时内容不进入 persistent transcript。验证 session 文件的一致性（meta ↔ messages ↔ harness）

**执行步骤**:
1. 写测试: 验证 session picker overlay 产生的 system 消息不进 transcript 文件
2. 写测试: 验证 /help 输出不进 transcript
3. 写测试: 验证 `messageCount` = messages 文件中实际行数
4. 写测试: 验证 harness sidecar 的 sessionId 与 meta 一致
5. 写测试: 验证 `truncateSessionToLastComplete` 的正确截断行为
6. 跑回归: `npm test -- --runInBand --testPathPatterns="session-storage|session-index"`
7. 结果写入 `docs/test/logs/`

**预期发现**: 破损的 messages JSON 导致 messageCount ≠ 实际行数

---

## Prompt 8: Subagent 生命周期与错误隔离测试

**目标**: 验证 subagent 的创建、执行、取消、超时、错误隔离。子 agent 崩溃不影响主 agent。

**执行步骤**:
1. 写测试: subagent 执行工具调用 → 工具返回结果正确
2. 写测试: subagent 执行过程中 cancel → pending requests reject，不内存泄漏
3. 写测试: subagent 执行超时 → 被终止 + 清理
4. 写测试: subagent 中的错误不传播到主 agent
5. 写测试: 并发多个 subagent → 结果互不干扰
6. 跑回归: `npm test -- --runInBand --testPathPatterns="subagent"`
7. 结果写入 `docs/test/logs/`

**预期发现**: 取消后 pending requests 未 reject 导致内存泄漏

---

## Prompt 9: Memory 系统跨会话持久化测试

**目标**: 验证 Memory（User/Project/Local 三级）的 save、recall、search、delete 在跨会话间的正确性

**执行步骤**:
1. 写测试: `memory_save` → 文件确实落在对应路径（User/Project/Local）
2. 写测试: `memory_recall` → 搜索关键词返回匹配条目
3. 写测试: 跨 session 记忆加载（新建 session 后仍能 recall）
4. 写测试: 记忆验证拒绝过短/全空白/纯特殊字符的条目
5. 写测试: 语义搜索 fallback 到文本搜索（sqlite-vec 不可用时）
6. 跑回归: `npm test -- --runInBand --testPathPatterns="memory|vector|semantic"`
7. 结果写入 `docs/test/logs/`

**预期发现**: 语义搜索 fallback 可能未正确触发

---

## Prompt 10: Goal 目标模式端到端集成测试

**目标**: 验证 v0.2.24 新增的 `/target` 完整生命周期：创建 → 自动续跑 → pause → resume → compact → complete → resume 恢复

**执行步骤**:
1. 写测试: Goal sidecar 创建后文件存在且格式正确（JSON schema 验证）
2. 写测试: GoalCoordinator 在 idle 后自动发射 `goal_continuation_scheduled` 事件
3. 写测试: pause 之后不发射 continuation 事件
4. 写测试: 3 次相同 blocker → 自动进入 `blocked` 状态
5. 写测试: 预算耗尽 → 自动进入 `budget_limited` 状态
6. 写测试: completion audit 拒绝未全部满足的 requirements
7. 写测试: clear 后侧边栏文件可被新 goal 复用
8. 写测试: SessionMeta 中的 `activeGoalId` 与 goal sidecar 的 `goalId` 一致
9. 跑回归: `npm test -- --runInBand --testPathPatterns="goal"`
10. 用真实 TUI 验证 `/target create` → `/target pause` → `/target resume` → `/target clear` 流程
11. 结果写入 `docs/test/logs/`

**预期发现**: compact 后 goal objective 丢失（需要 Compact 集成），Resume 后自动续跑条件判断有误

---

## 使用方式

将这 10 个 prompt 逐个（或并发）提交给 AI coding agent 执行。每个 prompt 独立运行，产生独立的测试结果和报告。

推荐的执行顺序：
- **Phase A (快速)**: Prompt 1, 3, 4 (session/bashtools/filetools — 无需模型)
- **Phase B (中等)**: Prompt 5, 6, 7, 8 (API/mock/TUI PTY — 需 mock 服务器)
- **Phase C (集成)**: Prompt 2, 9, 10 (MCP/memory/goal — 需 mock 外部服务)

每个 phase 完成后执行全量回归：`npm run build && npm test -- --runInBand`
