# T22-02 恢复矩阵（recovery matrix）— 2026-10-09

- 基线：`main` = `0d22c9a`；本矩阵在 `codex/v0.3.22` 分支上以真实 API 执行
  （`tests/thread-durability-fault-injection.test.ts`，10 个场景全部 pass）。
- 注入机制：`ThreadEventStoreOptionsV1.onBoundary`（before_log_write / after_log_write /
  after_log_flush / before_projection_write / after_projection_write）抛错模拟崩溃与写入失败；
  Tool Invocation Journal 的 `complete()` 抛错模拟 receipt 持久化失败；重开 Store 模拟进程重启。
- 每个场景断言的列：Durable Stream（重放事件与 seq）、Tool Receipt 状态、UI Read Model
  （projection）、恢复行为（recoverIncomplete 产出）。

## 矩阵结果

| # | 边界 | 注入 | Durable Stream | Receipt 状态 | Read Model / 恢复 | 结果 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Turn Start | before_log_write 抛错 | 空（cursor 0） | — | 无 turn.started；fresh store 空 | pass |
| 2 | Turn Start | after_log_flush 后 before_projection_write 抛错 | turn.started 已 fsync | — | 重开即修复投影；recoverIncomplete 追加 turn.interrupted，状态 ≠ completed | pass |
| 3 | Tool Intent | intent 落账后 complete() 抛错（进程死亡） | intent 已持久化、receipt 缺失 | intent ✓ / receipt ✗ | 跨进程重放 → `ORION_TOOL_OUTCOME_INDETERMINATE`，不自动重执副作用 | pass |
| 4 | Tool Receipt | complete() 持续失败 | intent 持久化 | 无 receipt（不伪造成功） | `ORION_TOOL_RECEIPT_PERSISTENCE`；load() 无 receipt | pass |
| 5 | Turn Commit | 第三个 append 的 before_log_write 抛错（commit 事件丢失） | 前 2 笔 durable | — | recoverIncomplete → turn.interrupted，状态 ≠ completed | pass |
| 6 | Turn Terminal（用户取消） | 正常追加 turn.interrupted | terminal durable | — | recoverIncomplete 不复活为 completed（幂等） | pass |
| 7 | Turn Terminal（失败） | 正常追加 turn.failed | terminal durable | — | recoverIncomplete 后仍 failed；重放中无 turn.completed | pass |
| 8 | Turn 序列（双 Session） | 重启进程采用持久 head 后继续追加 | seq 1-4 单调 | — | turn A completed、turn B active，身份互不借用 | pass |
| 9 | 双 Session 双 Thread | 两个 threadId 各自 store | 各自日志独立 | — | 投影互不包含对方 turn；activeTurnId 各自正确 | pass |
| 10 | Compaction/投影发布 | before_projection_write 抛错 | 崩溃前事件全部 durable | — | 重开后重放完整（thread.started + turn.started），日志文件完好 | pass |

## 语义结论（对应计划验收标准）

1. 崩溃后不自动重复外部副作用：场景 3/4 —— intent 有、receipt 无时跨进程重放返回
   `ORION_TOOL_OUTCOME_INDETERMINATE`，execute 计数为 0。
2. Failed / Interrupted 不投影为 Completed：场景 6/7。
3. 恢复继续不产生重复副作用：场景 2/5 的 recoverIncomplete 只追加 indeterminate/interrupted
   事件，不重放工具执行。
4. 不同 Session 不借用身份：场景 8/9。
5. 未改变 Wire Protocol：全部场景使用既有事件类型与公开 API。

## 已知覆盖边界

- Goal Runtime 层（Goal 中断后继续）由既有 `tests/goal-lifecycle-v2.test.ts` 覆盖；本矩阵
  覆盖 Thread/Turn/Item 与 Tool Receipt 层。
- 双 Session **同一 turn 同时**写入在产品中为非法状态（投影不变量 `turn X is already active`），
  属 fail-closed 设计，不作为恢复场景。
