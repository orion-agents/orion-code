# v0.3.53 调查记录与交付状态审计（0.3.50–0.3.52）

> 日期：2026-11-05。
> 数据源：git tag（本地 `rev-parse^{}` + `git ls-remote` 远端交叉）、npm registry 直连
> （`curl --noproxy '*' -H 'Cache-Control: no-cache'`）、GitHub Actions 作业结论与
> 日志、Release。
> 本轮性质：**条款 B 未清偿 → 不发布版本**；本文件记录已取得的运行时事实与静态
> 排查结论，供下一轮直接接续。

## 1. 三版交付状态审计

| 版本    | git tag（注释 tag 解引用）    | tag 指向 main 合并提交   | npm 存在 | registry 入库时间         | registry shasum（sha1）                    | dist-tag latest   | 结论      |
| ------- | ----------------------------- | ------------------------ | -------- | ------------------------- | ------------------------------------------ | ----------------- | --------- |
| 0.3.50  | `v0.3.50` → `86af06a…757f`    | 是（merge `86af06a`）    | 是       | 2026-11-02T03:52:07.285Z  | `a1165b7d33ae55499774f69fd16fa0fc0b54fccd` | 否（已被覆盖）    | published |
| 0.3.51  | `v0.3.51` → `0702878…a0cc05`  | 是（merge `0702878`）    | 是       | 2026-11-04T18:11:26.062Z  | `c60c4f7650d7bd208deaa7402ab57e11db3e7a9d` | 否（已被覆盖）    | published |
| 0.3.52  | `v0.3.52` → `a054c44…821ce`   | 是（merge `a054c44`）    | 是       | 2026-11-04T23:09:25.161Z  | `507ba5b79fc1fdf2d575c0b2a1b1a16efbebdd68` | **是（=0.3.52）** | published |

- 三版 `dist-tags.latest` 序列 0.3.50 → 0.3.51 → 0.3.52，连续推进无回退。
- 本地 `git rev-parse v0.3.X^{}` 与远端 `refs/tags/v0.3.X^{}` 完全吻合，且三版 tag 均为
  `origin/main` 祖先（`git merge-base --is-ancestor` 全 yes）。
- 0.3.52 tarball sha256 `0b532b9a89337f741cb9e90f7674384cf0e47ad3451cd9b51956805f785b8a7d`
  与其 CI 聚合收据（decision GO）逐字节一致；0.3.51 同理
  （`fc2c17bd…20bb3`）。

## 2. 本轮开版欠账处理

- main 上 CHANGELOG 0.3.52 条目原为 `Status: candidate` 且尾部写「Not merged, tagged
  or published」，与事实不符；本轮翻转为 `published` 并回填 PR #312、合并提交
  `a054c44`、tag `v0.3.52`、npm `2026-11-04T23:09:25.161Z`、GitHub Release 链接。
- 同时追加 **范围纠正**：v0.3.52 的「条款 B 修复」实际只覆盖 `WEB32-P0-09`
  （已在发布后 run 上确认转绿）；`WEB32-P0-08` 仍在
  run [41930947053](https://github.com/orion-agents/orion-code/actions/runs/41930947053)
  的 run-3 失败，`main` 上仍留有 Web E2E critical-journey 级红灯。

## 3. WEB32-P0-08 运行时事实（非推测）

1. v0.3.52 加入的到达摘要给出的决定性一行：
   `Timed out after 45000ms waiting for an OpenAI fixture request. total=1 recent=[#1 settings-probe len=22]`
   → 场景内 fixture 只收到过 settings-probe 一条请求，`context-manifest` 的 provider
   请求**从未到达**；排除「已发出但 `lastUserText` 不含关键字」。
2. 失败点之前的 `POST /api/v1/commands` 已成功返回，且 `contextReceipt` 断言通过
   （`manifestDigest` 64 hex、`referenceCount === 5`）→ UI→host 命令通道与 Context
   清单构建无异常。
3. 失败只出现在三连跑的后段 run（run-2 或 run-3），run-1 从未失败。
4. `WEB32-P0-08` 是 119 个场景中的第 58 个；后续场景照常执行并通过。

## 4. 静态排查（逐条对代码验证）

| 假设 | 判据 | 结论 |
| ---- | ---- | ---- |
| 队列出队静默吞掉启动失败 | `src/web/session-runtime-registry.ts:560` 外层 `.catch(() => undefined)` | **证伪**：`startTurn` 在 `:527-529` 已 `finishTurn(record, error)`，`:533-544` 写入 `record.failure`、转 `failed` 并重新 `drainQueue()`；外层 catch 仅防未处理拒绝 |
| `hasActiveTurn()` 跨 session 误命中 | `src/runtime/agent-runtime-controller.ts:165`、`:194`（每 actor 私有 `TurnController`）、`:703` | **弱化**：控制器按 session actor 各自实例化，新建 session 应为空闲 |
| `requestIsCurrent()` 在重绑窗口失败 | `:704`、`:1007-1010`、`:540` 捕获点 | **未证实**：纯文本 prompt 路径上捕获与检查之间未见 `await`；`:545-705` 区间内 3 处 `await` 分属非只读斜杠命令与修订分支 |
| `beginTurn` 后、HTTP 前的无界 settings 同步 | `:791 await synchronizeSettingsAtLogicalBoundary()`、`src/runtime/product-bootstrap.ts:430-434`、同一 workspace 共享 kernel（`src/web/workbench-controller.ts:2581-2591`） | **候选**：可解释「turn 已开始但请求不发出」；尚不能解释「只在后段 run」 |
| provider 闸门冷却过期后不再派发 waiter | `src/services/provider-resilience/request-gate.ts:55-56`（存在 `cooldownTimer`/`cooldownTimerDue`）、`:109-117`、`:154-159` | **弱化**：存在到期定时器；仍需运行时证据 |

**判定**：没有一条假设达到可负责任修改 `src/` 并发代码的证据强度，故本轮不猜改产品代码，
改为让机制在 CI 中自我声明。

## 5. 本轮交付

- `tests/e2e/web-v032-context-plan-queue-recovery.spec.ts`：在 `contextReceipt` 断言之后
  校验 `/api/v1/commands` 响应体的 `result`（host 的真实处置：
  `src/web/workbench-controller.ts:2119-2125` `result: admission.accepted.type`；
  排队分支 `:2107-2116` `session_turn_queued`；静默丢弃分支
  `agent-runtime-controller.ts:703-704` `command_ignored`）。断言只放行
  `started` / `session_turn_queued`，命中静默丢弃即以 `result`/`detail` 具名失败。
- CHANGELOG 0.3.52 状态翻转 + 范围纠正。
- 本文件。

## 6. 明确 not_run

- 人工标注付费质量评测、真实模型全链路审查 E2E：本环境无模型凭据，未运行。
- **本地 Playwright 复现：`not_run`（blocked by environment）**——E2E global setup 的
  `git rev-parse` 走 fixture 硬编码 PATH 命中 `/usr/bin/git`，被 Xcode 许可协议门拦住
  （exit 69，需人工 `sudo xcodebuild -license`）。绕过需在
  `~/.nvm/versions/node/<ver>/bin` 放 `git` 软链，属任务允许路径之外，未执行。
