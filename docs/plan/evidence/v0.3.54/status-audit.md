# v0.3.54 交付状态审计 — 三版滚动窗口（0.3.51–0.3.53）

> 审计日期：2026-11-08。
> 数据源：git tag（本地 `git rev-parse <tag>{}` + `git ls-remote` 远端交叉核对）、
> npm registry 直连（`curl --noproxy '*' -H 'Cache-Control: no-cache'`，防缓存
> 时间戳参数）、GitHub PR / Release / CI。
> 方法：每版核对 ① git tag 存在且注释 tag 解引用（`^{}`）指向 main 合并提交；
> ② npm registry 同版本存在（`versions[ver]`）；③ `dist-tags.latest` 指向最新
> 已发布版本且连续推进无回退。
> 本轮开版欠账清偿依据：main 上 CHANGELOG 的 0.3.53 条目由
> `candidate — release withheld` 翻为 `published`，回填真实 npm 发布时间戳
> `2026-11-08T02:39:25.949Z` 与 GitHub Release v0.3.53 链接；README /
> README.zh-CN 首部摘要同步移除陈旧的「release withheld」声明。

## 审计结论表

| 版本   | git tag（注释 tag 解引用）   | tag 指向 main 合并提交 | npm 版本存在 | registry 入库时间        | registry shasum（sha1）                    | dist-tag latest   | 结论      |
| ------ | ---------------------------- | ---------------------- | ------------ | ------------------------ | ------------------------------------------ | ----------------- | --------- |
| 0.3.51 | `v0.3.51` → `0702878…a0cc05` | 是（merge `0702878`）  | 是           | 2026-11-04T18:11:26.062Z | `c60c4f7650d7bd208deaa7402ab57e11db3e7a9d` | 否（已被覆盖）    | published |
| 0.3.52 | `v0.3.52` → `a054c44…1b1ace` | 是（merge `a054c44`）  | 是           | 2026-11-04T23:09:25.161Z | `507ba5b79fc1fdf2d575c0b2a1b1a16efbebdd68` | 否（已被覆盖）    | published |
| 0.3.53 | `v0.3.53` → `3d7c581…0118a`  | 是（merge `3d7c581`）  | 是           | 2026-11-08T02:39:25.949Z | `d98b82d6c673541b277305363832a4df4a0d8cf1` | **是（=0.3.53）** | published |

- 三版 `dist-tags.latest` 序列：0.3.51 → 0.3.52 → 0.3.53，连续推进无回退；
  本轮防缓存直连复核 `latest=0.3.53`（`dist-tags.next` 仍停在 `0.3.19`，
  为历史遗留 dist-tag，与 latest 判定无关）。
- 本地 `git rev-parse v0.3.X^{}` 与远端 `refs/tags/v0.3.X^{}` 一致
  （0702878 / a054c44 / 3d7c581），三版 tag 均位于 `origin/main` 历史上。
- 三版 registry shasum 与历轮发布记录一致，并以本轮直连复核确认，无篡改迹象。

## 0.3.53 发布事实回填（Step 0 开版欠账清偿依据）

- PR：#313（`test(e2e): v0.3.53 candidate — WEB32-P0-08 investigation; release
withheld by clause B`）
- squash 合并提交：`3d7c581105c80098008f790217deec551b40118a`（main）
- git tag：`v0.3.53`（注释 tag，peel → `3d7c581…0118a`，已推送，
  `git ls-remote origin refs/tags/v0.3.53^{}` 远端一致）
- npm registry：`@orion-agents/orion-code@0.3.53`，`dist-tags.latest=0.3.53`
- registry shasum：`d98b82d6c673541b277305363832a4df4a0d8cf1`
- tarball 入库时间：`2026-11-08T02:39:25.949Z`（registry `time` 字段；publish
  成功输出早于入库约 3 分钟，属既有 CDN 传播延迟，重发取得权威信号
  `E409 Cannot publish over previously staged version "0.3.53"`）
- tarball sha256：`a4c900d23b566a401d6f3618e0198425d19427fdb42c74be16accc3a87d4d6bc`
  （与 CI run `42438966303` 的 `release-package` artifact 及
  `web-e2e-receipt.tarballSha256` 逐字节一致）
- GitHub Release：https://github.com/orion-agents/orion-code/releases/tag/v0.3.53
  （已建，`--latest`，2026-11-08T03:04:41Z）
- CI 门禁：
  - 合并前 main run `41930947053`（HEAD `a054c44`，即 v0.3.52 发布提交）的
    `Web E2E full suite three consecutive runs` 红于 `WEB32-P0-08` → 单次
    `gh run rerun --failed` 后 attempt 2 = **success 18/18**（瞬时 flake 定性，
    依任务规则允许合并；**根因未修复，定性 ≠ 修复**）。
  - 合并后 push CI run `42438966303`（HEAD `3d7c581`）：
    `Exact tgz on Node 24.0.0 floor` 的 `terminal_journey` PTY 探针红（同一
    tarball 在 PR run `42323965955` 上该作业绿）→ 单次复跑后 attempt 2 =
    **success 18/18**。
  - 发布物取自 CI 构建的 `release-package` tarball（非本地 `npm pack`），规避
    工作区未提交文件混入包的历史风险（v0.3.27 教训）；该偏离已在 Release notes
    如实记录。
- CHANGELOG 0.3.53 条目：本轮（v0.3.54 开版提交）由
  `Status: candidate — release withheld` 翻转为 `Status: published`，section
  日期更正为真实发布日 `2026-11-08`，并回填上述真实发布时间戳与 Release 链接。

## 开放事项（如实记录，不视为已解决）

- `WEB32-P0-08` 根因**仍未确定**：v0.3.53 的调查
  （`docs/plan/evidence/v0.3.53/investigation-and-audit.md`）记录了运行时事实、
  四个静态假设与其中两个被代码证据证伪的判据；本轮发布前的转绿来自单次复跑的
  flake 定性，不构成修复。后续轮次若复现，仍按「单次复跑定性 → 仍红即停止」
  处置，并在证据充足时才修改 `src/` 并发代码。

## 明确 not_run（沿用历轮口径）

- 人工标注付费质量评测（12 缺陷 + 8 干净样本、3 轮运行）：本环境无模型凭据，未运行。
- 真实 Host + Chrome 全链路审查 E2E（付费评测通道）：本环境无凭据，未运行。

以上为诚实的 `not_run`（blocked by environment），不视为通过。
