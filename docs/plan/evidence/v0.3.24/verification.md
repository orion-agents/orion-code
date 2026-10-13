# v0.3.24 验证记录

- 日期：2026-10-11 至 2026-10-13，macOS 本机。
- 实施分支：`codex/v0.3.24`；基线：`main@6ed47fd`，包版本：`0.3.24`。
- 状态：2026-10-13 最新本地打包 Host + Chrome 的 14/14 新场景通过；全量 Jest 373/373 suites 通过。提交绑定的 CI、PR 与 npm 发布仍待验证。下面 2026-10-11 的 8/8 结果仅作历史回归证据，不能替代本次最终门禁。

## 2026-10-12 增量审查

前端已修复普通 Context 导航期间单会话 Snapshot 错误推进全局 SSE Cursor 的竞态；快照仅记录目标 Session 的代表水位，事件流仍负责全局回放。新增旧历史分页归属、跨工作区导航排队、创建正式 ID 前占位、按会话滚动位置及展示缓存等回归。真实 Chrome 复测还发现：首轮会话运行前 `threadId=null`，切出后运行中生成线程 ID，返回时旧合并规则会丢失已显示的流式文字。已修复 `null → 当前运行线程` 边界并增加 reducer 回归。后端对异步 Catalog、Git 身份和跨进程锁进行补充审查。

当前已完成的定向检查：`tests/web-reducer.test.ts` 46 项通过；ESLint、Prettier、Web 与 E2E TypeScript 检查通过。后端上一轮 8 suites / 151 tests 通过；全量检查及最终冻结后重跑仍待完成。

PR-0 干净主线的真实 Chrome 基线（10/100/1000 会话，各 24 次热切换、每个热会话 10,000 条历史）：第二绘制帧 p95 约 33.0/32.3/31.1ms；各组多发 24 次 Snapshot GET，SSE 重连、Actor 新建和模型调用为 0。[基线原始样本](baseline-performance-samples.json)已保留；完整隔离运行记录位于基线工作树 `tests/tmp/web-e2e/2026-10-12T10-06-29-655Z-34722/`。本地候选版与之相比主要收益是消除热切换 GET，而不是声称绘制帧显著加速。

## 2026-10-13 最新打包 Host + Chrome 结果

`WEB33-P0-44` 至 `WEB33-P0-57` 共 14/14 通过；隔离安装包 SHA-256 `4e965f93657daa99910f6adb2a46f86949392caa6e2a11ac19d8b54c6b52b455`，artifact receipt digest `fdf07c54fd813bbc40c5c54ee13122fc00503755771c2ef4934d9db98be15cbb`。完整原始 manifest、真实截图、日志及观测事实存于本地 `tests/tmp/web-e2e/2026-10-13T01-19-21-662Z-58181/`，总体 verdict 为 `GO`。该包来自未提交的实施工作树，仍需在最终提交上通过 CI；不能把本地 GO 冒充提交绑定的 release GO。

最终代码审查后的旧场景回归又打包、隔离安装并运行 `WEB33-P0-16/17/20/21` 与新 `44–47`：8/8 通过，verdict `GO`。本次包 SHA-256 `12c60b12d36b174e8b2ed8925a67e390f4cf768b491a23efab0dab3ebc73c543`，原始证据在本地 `tests/tmp/web-e2e/2026-10-13T01-37-30-171Z-9926/`。这次运行验证最终源码与测试改动的兼容性，但同样不是 CI 提交绑定的 receipt。

| 会话规模 | 主线第二帧 p95 | 本地候选第二帧 p95 | 24 次热切换 Snapshot GET | SSE 重连 / Actor 新建 / Provider 请求 |
| --- | ---: | ---: | ---: | ---: |
| 10 | 33.0ms | 31.9ms | 主线 24，候选 0 | 候选 0 / 0 / 0 |
| 100 | 32.3ms | 32.1ms | 主线 24，候选 0 | 候选 0 / 0 / 0 |
| 1000 | 31.1ms | 31.6ms | 主线 24，候选 0 | 候选 0 / 0 / 0 |

每组 24 次真实鼠标点击，第二个绘制帧需已经选中并显示目标正文；候选 p95 均低于 100ms 预算，1000 会话时 DOM 行数为 100。[候选逐次原始样本](candidate-performance-samples.json)与基线采用同一测法。数值差异很小，不据此声称帧时间有统计显著提升。新场景还覆盖：A 的 POST 延迟时 B 可发送与新建、10 次创建点击单飞、运行态跨 Workspace 保留、正式 ID 与失败快照分离、历史分页并行、双会话滚动恢复、旧 HTTP 不回滚 SSE、失败 Context 激活后的后来选择。

## 验证层

| 层                 | 覆盖                                                                                                           | 结果                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Reducer            | 请求归属/并发 token、缓存即时选择、实时消息/工具保留、rename/tags、迟到 HTTP、超预算淘汰、Context/断线失效     | 当前 46 项通过                         |
| 后端与存储         | 真实慢 Git 子进程超时、创建期间其他操作可用、不创建 actor、Context 竞争、真实仓库/worktree/symlink/config 失效 | 上一轮 8 suites / 151 tests 通过       |
| 静态检查           | ESLint、Web TypeScript、E2E TypeScript、Prettier、diff check                                                   | 当前通过；提交冻结后需重跑             |
| 全量 Jest          | CLI/TUI、Web、存储、Runtime、release receipts 等                                                               | 373 suites / 4486 tests 通过，5 skipped |
| 打包 Host + Chrome | 新 44–57 全 14 个会话旅程；旧 16/17/20/21 联合回归                                                            | 新 14/14 GO；联合回归 8/8 GO；提交绑定 CI 待验证 |
| 构建               | TypeScript + Web production bundle + 内置 Skill assets                                                         | 通过                                   |

## 历史浏览器验收（2026-10-11 实现快照，仅供回归对照）

新场景不是替身前端：由测试仓库构建、打包、隔离安装并启动真实 Orion Host；Provider 使用本地受控 fixture。浏览器仅延迟真实请求，解除后继续发向真实 endpoint。

- `WEB33-P0-44`：A 的发送 POST 返回前，B 可选择、输入、执行；C 可新建。A 的晚到响应不影响 B 的草稿。
- `WEB33-P0-45`：创建单飞，只产生一个 POST；创建期间能选择 B，返回不抢回 B，也不清草稿。
- `WEB33-P0-46`：真实鼠标选择 A/B 至少 20 次，从点击事件到第二个绘制帧观测选中与正文；p95 < 100ms、snapshot GET = 0、SSE 重连 = 0、activate POST = 0。
- `WEB33-P0-47`：A 显示流式内容后切出，在后台继续完成；返回先保留显示，迟到的 A 读取不抢 B 的前台或草稿。
- 既有 `16/17/20/21`：运行中切换、两个 actor 并行、两标签页/CAS 和长历史冷加载回归。

最终 run：`tests/tmp/web-e2e/2026-10-11T01-40-21-872Z-48326/manifest.json`。环境为 macOS arm64、Node `v26.5.1`、npm `11.17.0`、真实 Chrome（本地 Playwright channel）。

| 观测                                                   | 实测                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------- |
| 新 46：20 次真实鼠标点击到第二 RAF                     | p95 **30.4ms**，每次已选中且已显示目标正文                 |
| 同一测量窗口的 snapshot GET / SSE 重连 / activate POST | **0 / 0 / 0**                                              |
| 新 44：A 的 POST 延迟期间                              | B 提交成功，C 创建成功，跨会话草稿保留                     |
| 新 45：重复新建                                        | 1 POST / 1 新行，不抢回用户后来选择的 B                    |
| 新 47：流式显示及迟到刷新                              | 已显示内容保留，A 响应不抢 B，B 草稿保留                   |
| 原 21：10,000 条历史冷 HTTP 读取                       | 6.2ms；该值不含用户点击/绘制，不能与 30.4ms 的 UI 测量混用 |

原 20 有一次预期 network failure（故意结束次标签页 SSE）；新四场景 console errors/warnings、page errors、HTTP 5xx、意外 network failures、secret findings 均为 0。

原始包与执行绑定：

```text
tarballSha256: cca285cddfb88065cfd11e6908475ebae25dcf27f82d3b9e3d813054a66d5f5e
installedTargetDigest: 5c59cf6677cbace717c164c7de7d7dda62eb7c12f6c909a79fcef16ec9e25959
artifactReceiptDigest: e99bc781444184cd6d759089c034b36c8b1db7357a70b18c690863d9248f9790
runnerDigest: 82a24b116c670748183748b38476cb759a1c0385a82ec289555699cc575d08aa
verifiedEvidenceBundleDigest: b7adf1399695535ec7bb433fd8542daebfcc6311d54f24f3faf8694b78e34b77
```

根 agent 重新执行 `verifyEvidenceBundle`，校验全 8 场景的原始 manifest、真实 PNG、日志与必需 facts；重算当前 runner digest 一致。旧 21 的快照页数门禁改为合法范围 `0–1`：暖缓存可以零请求，但 `2` 与负数仍拒绝，不能把零请求事实伪造为一页。新 44–47 全部纳入 full/critical release 注册并提供截图；这只是本地定向验证，并非完整 release receipt。

### 重跑命令

```bash
ORION_WEB_E2E_EXPECTED_SCENARIOS=WEB33-P0-16,WEB33-P0-17,WEB33-P0-20,WEB33-P0-21,WEB33-P0-44,WEB33-P0-45,WEB33-P0-46,WEB33-P0-47 \
  npm run test:web-e2e -- tests/e2e/web-v0324-session-responsiveness.spec.ts \
  tests/e2e/web-v033-session-concurrency.spec.ts \
  --grep 'WEB33-P0-(16|17|20|21|44|45|46|47)'
```

### 最终现场截图

- [发送请求延迟期间切换与新建](web324-command-pending-other-session.png)
- [新建单飞与选择优先](web324-create-single-flight-selection.png)
- [20 次热切换后的页面](web324-warm-switch-20.png)
- [保留流式内容，等待权威刷新](web324-stream-content-refresh-pending.png)

## 发现并纠正的验证问题

首轮打包时版本号发生变化，fixture 检查不接受不同版本，不能算产品通过。后续诊断真实抓到 rename 后缓存恢复默认名称，已修复并增加回归；另纠正延迟发送用例错误等待“请求尚未返回就清空草稿”，以及性能测量未等待后台完成事件的 setup 竞态。门槛仍要求第二帧已有目标内容、零额外暖切换请求。

全量检查还发现主线已有过时测试：同步 lifecycle API 使用 `.rejects`、纯选择被误认为 actor 分配、缺少当前 UI props、SSR 懒加载模块被断言已同步渲染、release fixture 的场景未按严格集合排序。仅调整对应测试的真实接口与断言，不降低生产 gate。

## 范围与限制

Web 首次冷 Git root 探测改为异步、限时 250ms；Catalog 冷扫描和文件锁重试会让出事件循环。本地 stat/JSON/原子写的短临界区、CLI/TUI 同步 API、历史索引完整性重建仍保留同步行为。显示缓存淘汰会要求重新读取权威 tail，超大历史不能保证无限驻留。2026-10-11 的打包安装在隔离测试目录，未替换用户常驻服务；跨 OS/Node 22/24/26 全矩阵和本版最终提交的 CI 结果待验证，未把受控 Provider fixture 冒称线上付费模型验收。


## 2026-10-13 提交绑定 CI 的首轮结果与修复（WorkBuddy 复核）

PR #268（codex/v0.3.24 → main）首轮 CI（run 38334488330）暴露两类问题：

1. **SET-P0-10（Host 重启恢复）teardown 失败**：测试断言全部通过，但恢复窗口内旧页面
   重放的排队操作被轮换 nonce 的 admission 以 409 正确拒绝，浏览器将该失败资源记为
   console error，证据守卫（0 容忍）判负。修复：按 v0.3.20 S4 机制注册天花板 allowance
   （`allowConsoleError`，精确文本，0–2 次，测试开头注册——409 出现时机不定）。
   本地打包复验 SET-P0-10 单场景 verdict **GO**。修复后 critical ×3 全部转绿
   （run 38341184792）。
2. **Node 22/24/26 矩阵的 release-check 契约测试失败**：干净 clone + Node 22.12 + npm ci
   本地复现 **33/33 通过**——失败为 CI 环境特有。诊断增强：`runReleaseCheck` 在脚本
   退出非零时把失败检查项（id + detail）直接打入作业日志。首轮诊断显示 fixture 被
   `GITHUB_HEAD_REF=codex/v0.3.24` 环境泄漏污染（分支名版本约定要求 0.3.24 而 fixture
   为 1.2.3）——下一轮以净化 spawn env 修复。

3. **E2E-P0-07（三轮连跑阻断项，未解决）**：三轮稳定失败（每轮 18.7s，非 flake）。
   失败点：reload → waitForWorkbenchReady 后 composer 持续 disabled（placeholder
   「选择会话并配置模型后开始」，34 次轮询）。已排除：console/page error 为 0、
   dirty/refreshing 卡死（已加收敛 effect：活跃会话快照 dirty 或缺失时 250ms 防抖
   强制重读，manifest 显示重读确实发生但未恢复就绪）、快照请求缺失（manifest 显示
   多次 snapshot GET）。剩余假设：reload 后两个 baseline 竞争导致 Context revision
   错位，快照 dispatch 被静默拒绝且无状态变化（收敛 effect 的依赖不触发）。
   下一步：reducer 层拒绝路径加诊断或改为「拒绝即调度当前 Context 重读」。

全量 Jest（含上述改动）复跑：**4486 passed / 5 skipped / 0 failed（373 套件）**。
