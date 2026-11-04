# v0.3.52 交付状态审计 — 三版滚动窗口（0.3.49–0.3.51）

> 审计日期：2026-11-05。
> 数据源：git tag（本地 + `git ls-remote` 远端交叉核对）、npm registry 直连
> （`curl --noproxy '*' -H 'Cache-Control: no-cache'`）、GitHub PR / Release / CI。
> 方法：每版核对 ① git tag 存在且注释 tag 解引用（`^{}`）指向 main 合并提交；
> ② npm registry 同版本存在（`versions[ver]`）；③ `dist-tags.latest` 指向最新
> 已发布版本。
> 本轮开版欠账清偿依据：main 上 CHANGELOG 的 0.3.51 条目由 `candidate` 翻为
> `published`，回填真实 npm 发布时间戳 2026-11-04T18:11:26.062Z 与
> GitHub Release v0.3.51 链接。

## 审计结论表

| 版本    | git tag（注释 tag 解引用）  | tag 指向 main 合并提交 | npm 版本存在 | registry 入库时间         | registry shasum（sha1）                    | dist-tag latest    | 结论      |
| ------- | --------------------------- | ---------------------- | ----------- | ------------------------- | ------------------------------------------ | ------------------ | --------- |
| 0.3.49  | `v0.3.49` → `bb3c518…99a4f` | 是（merge `bb3c518`）  | 是          | 2026-11-01T20:19:49.434Z  | `4ebe49d7e801de7c182c2fe0b64bb953be645e87` | 否（已被覆盖）     | published |
| 0.3.50  | `v0.3.50` → `86af06a…5757f` | 是（merge `86af06a`）  | 是          | 2026-11-02T03:52:07.285Z  | `a1165b7d33ae55499774f69fd16fa0fc0b54fccd` | 否（已被覆盖）     | published |
| 0.3.51  | `v0.3.51` → `0702878…a0cc05`| 是（merge `0702878`）  | 是          | 2026-11-04T18:11:26.062Z  | `c60c4f7650d7bd208deaa7402ab57e11db3e7a9d` | **是（=0.3.51）**  | published |

- 三版 `dist-tags.latest` 序列：0.3.49 → 0.3.50 → 0.3.51，连续推进无回退。
- 本地 `git rev-parse v0.3.X^{}` 与远端 `refs/tags/v0.3.X^{}` 一致（bb3c518 /
  86af06a / 0702878），三版 tag 均位于 `origin/main` 历史上
  （`git merge-base --is-ancestor` 校验均 yes）。
- 三版 registry shasum 与历轮发布记录一致，并以本轮直连复核确认，无篡改迹象。

## 0.3.51 发布事实回填（Step 0 开版欠账清偿依据）

- PR：#310（`docs: v0.3.51 - receipt backfill and delivery-status audit (PR4 automatable portion) (#310)`）
- squash 合并提交：`0702878b0b7e2cc1092e9b0f7293c17e94a0cc05`（main）
- git tag：`v0.3.51`（注释 tag，peel → `0702878…a0cc05`，已推送）
- npm registry：`@orion-agents/orion-code@0.3.51`，`dist-tags.latest=0.3.51`
- registry shasum：`c60c4f7650d7bd208deaa7402ab57e11db3e7a9d`（与本地 tarball sha1 一致）
- tarball 入库时间：`2026-11-04T18:11:26.062Z`
- tarball sha256：`fc2c17bdcd3ce3b7247ac38d9f9ffb86d9039a66702d6600678f1f33a5720bb3`
  （本地 Node 22 pack 与 CI 聚合收据 `web-e2e-receipt.tarballSha256` 逐字节一致）
- GitHub Release：`https://github.com/orion-agents/orion-code/releases/tag/v0.3.51`
  （已建，`--latest`，2026-11-04T18:13:57Z）
- CI：PR run `41877286186` 逐作业核对 18/18 success、两个聚合收据 decision=GO
  （首跑 `Exact tgz on Node 26.0.0 floor` 红为 `terminal_journey` PTY 已知家族，
  单次 `rerun --failed` 后全绿）。
- **发布后 main CI 遗留红灯（本轮条款 B 处理对象）**：run `41883895208`（HEAD
  `0702878`）两作业红——`Web E2E critical journey on Node 22.12.0 floor`
  （WEB32-P0-09 `planReview.status` 单次读取命中迁移中间态）与
  `Web E2E full suite three consecutive runs`（run-2 WEB32-P0-08 fixture 45s
  超时；上一轮 `keepAliveTimeout` 修复降低但未根除）。本版 S1 修 P0-09 的测试侧
  时序缺陷、S3 为 P0-08 增加定位证据；`Release gate (release:check)` 在该 run
  已转绿，说明 v0.3.51 的 bump 已清偿上一轮 `Release ref` 结构性红灯。
- CHANGELOG 0.3.51 条目：本轮（v0.3.52 开版提交）由 `Status: candidate` 翻转为
  `Status: published`，并回填上述真实发布时间戳与 Release 链接。

## 明确 not_run（沿用历轮口径）

- 人工标注付费质量评测（12 缺陷 + 8 干净样本、3 轮运行）：本环境无模型凭据，未运行。
- 真实 Host + Chrome 全链路审查 E2E（付费评测通道）：本环境无凭据，未运行。

以上为诚实的 `not_run`（blocked by environment），不视为通过。
