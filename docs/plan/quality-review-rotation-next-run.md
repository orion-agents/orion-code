# 源码优先质量轮训：下一轮任务清单（2026-08-15）

- 轮训频率：每 30 分钟。
- 执行模式：每轮只聚焦单一维度；未检测到问题时写“本轮未复现问题”。
- 自动轮次：安全与输入校验 -> 权限与边界控制 -> 持久化/并发一致性 -> TUI 交互与终端输出安全 -> 依赖/版本与供应链风险 -> 测试完整性与测试实现一致性 -> 性能与回归风险 -> Release/发布工程风险。

## 上一轮结论

- 上一轮执行维度：**持久化/并发一致性**。
- 重点核查文件：`src/services/session-storage.ts`、`src/services/goal-storage.ts`、`src/services/file-lock.ts`、`src/services/session-index.ts`、`tests/persistence-concurrency.test.ts` 等。
- 本轮未复现问题，写入“持久化/并发一致性”轮训结论为：未复现新增风险。

## 下一轮待办（本次新增）

1. 在本轮后续工作中补充**优化项**：
   - 已在官方仓库提交 Issue：[#206](https://github.com/orion-agents/orion-code/issues/206)（标签：`reliability` `tech-debt`）。优化内容：`src/services/usage-state.ts` 中 `appendUsageRecord` 的并发 `appendFileSync` 写入缺少与其他持久化链路一致的锁策略与恢复语义。
   - 明确回归动作：
     - 补充 `tests/persistence-concurrency.test.ts` 的并发 `usage ledger` 压测（多进程高频 `appendUsageRecord`），验证 JSONL 无行级损坏且 `droppedCorruptLines` 不异常上升。
     - 增补拒绝路径回归：非法值、越界值、非数值输入在 `appendUsageRecord` 下的处理结果应明确拒绝并可观测。
     - 与 `getUsageState` 的一致性对账，补齐可重放/回放校验。
   - 该点作为本轮“持久化/并发一致性”优化任务项，在“下轮”前置检查项中跟进。

2. 下一轮轮训维度候选（按规则自动推进）：
   - **TUI 交互与终端输出安全**。
