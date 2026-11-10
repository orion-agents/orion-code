# v0.3.60 交付状态审计 — 三版滚动窗口（0.3.57–0.3.59）

> 审计日期：2026-11-10。
> 数据源：git tag（本地 `git rev-parse <tag>^{}` + `git ls-remote` 远端交叉核对）、
> npm registry 直连（`curl --noproxy '*' -H 'Cache-Control: no-cache'`，防缓存
> 时间戳参数）、GitHub PR / Release / CI。
> 方法：每版核对 ① git tag 存在且注释 tag 解引用（`^{}`）指向 main 合并提交；
> ② npm registry 同版本存在（`versions[ver]`）；③ `dist-tags.latest` 指向最新
> 已发布版本且连续推进无回退。
> 本轮开版欠账清偿依据：main 上 CHANGELOG 的 0.3.59 条目由 `candidate` 翻为
> `published`，回填真实 npm 发布时间戳 `2026-11-10T02:04:09.591Z` 与 GitHub
> Release v0.3.59 链接；README / README.zh-CN 首部摘要同步改写为
> 「0.3.59 已发布、0.3.60 candidate」。

## 审计结论表

| 版本   | git tag（注释 tag 解引用）  | tag 指向 main 合并提交 | npm 版本存在 | registry 入库时间        | registry shasum（sha1）                    | dist-tag latest   | 结论      |
| ------ | --------------------------- | ---------------------- | ------------ | ------------------------ | ------------------------------------------ | ----------------- | --------- |
| 0.3.57 | `v0.3.57` → `10d0ce0…2182e` | 是（merge `10d0ce0`）  | 是           | 2026-11-09T13:06:47.415Z | `687077b3249deccf397dc238d56e5bde9234c4ab` | 否（已被覆盖）    | published |
| 0.3.58 | `v0.3.58` → `7ca9293…4941`  | 是（merge `7ca9293`）  | 是           | 2026-11-09T19:27:43.656Z | `078f73a0e2df60b7f9a3c5902d9e0bfc449265e9` | 否（已被覆盖）    | published |
| 0.3.59 | `v0.3.59` → `089fa33…9772`  | 是（merge `089fa33`）  | 是           | 2026-11-10T02:04:09.591Z | `f0f4f72bdfe38cd2e9ae952dd0c109a368b2fdb6` | **是（=0.3.59）** | published |

- 三版 `dist-tags.latest` 序列：0.3.57 → 0.3.58 → 0.3.59，连续推进无回退；
  本轮防缓存直连复核 `latest=0.3.59`（`dist-tags.next` 仍停在 `0.3.19`，
  为历史遗留 dist-tag，与 latest 判定无关）。
- 本地 `git rev-parse v0.3.X^{}` 与远端 `refs/tags/v0.3.X^{}` 一致
  （10d0ce0b / 7ca92932 / 089fa33），三版 tag 均位于 `origin/main` 历史上。
- 注释 tag 对象亦双端一致：`6c2dec2d`（0.3.57）/ `a6fca4b8`（0.3.58）/
  `871632a1`（0.3.59）。
- 三版 registry shasum 与历轮发布记录一致，并以本轮直连复核确认，无篡改迹象。

## 0.3.59 发布事实回填（Step 0 开版欠账清偿依据）

- PR：#319（`docs: v0.3.59 candidate - v0.3.58 release-completion bookkeeping`）
- squash 合并提交：`089fa3308f1bc0a9218f4a0aa530f48b06459772`（main，树
  `0a0af595…` 与 PR head 树逐字节一致）
- git tag：`v0.3.59`（注释 tag，tag 对象 `871632a1…86600`，peel →
  `089fa33…9772`，已推送，`git ls-remote origin refs/tags/v0.3.59^{}` 远端一致）
- npm registry：`@orion-agents/orion-code@0.3.59`，`dist-tags.latest=0.3.59`
- registry shasum：`f0f4f72bdfe38cd2e9ae952dd0c109a368b2fdb6`
- tarball 入库时间：`2026-11-10T02:04:09.591Z`（registry `time` 字段）
- tarball sha256：`4cbf5a31fc5c1873e01cc17e51564be236d6973b0712f0fe97ffac1db8380011`
  （与 CI run `42731807198` 的 `web-e2e-receipt.tarballSha256`（GO）及
  `release-receipt` 全部 11 处 tarballSha256 字段逐字节一致；791 files /
  1,883,725 B，本地 SHA-1 `f0f4f72b…fdb6` 与 registry shasum 一致）
- GitHub Release：https://github.com/orion-agents/orion-code/releases/tag/v0.3.59
  （已建，`--latest`，publishedAt `2026-11-10T02:06:09Z`，`/releases/latest`
  API 复核指向 v0.3.59；notes 含 attempt 1/2 双列逐作业门禁表 + flake trail +
  四向 sha + 安装命令 + docs-only 张力标注）
- CI 门禁：PR run `42731807198` attempt 2 **18/18 全部 success（零红零
  skipped，含两个长期基线 skipped 的 Aggregate receipt 全转绿）**。attempt 1
  红于 Web E2E full suite three consecutive runs——run-1/run-2 各红
  `WEB32-P0-08`（OpenAI fixture 45s 超时，48.3–48.4s 签名逐字节同型）、run-3
  GO 119，`gh run rerun --failed` 单次复跑后 attempt 2 全绿 → 按「重跑绿=瞬时
  flake 可合并」规则收口。逐作业核对经 `gh api` attempts API。

## 开放项（承前）

- `WEB32-P0-08`（OpenAI fixture 超时）根因仍开放：证据与静态排查见
  `docs/plan/evidence/v0.3.53/investigation-and-audit.md`。v0.3.59 周期
  attempt 1 又两轮同型红，v0.3.55–v0.3.59 五个连续周期该家族反复出现且失败率
  偏高（attempt 2 全绿维持瞬时定性）；本轮零产品代码，不宣称修复。
- v0.3.58 周期 attempt 1 新见 flake 家族「web-e2e-runtime 矩阵腿从未实例化
  → run conclusion=failure 但无失败作业记录」本轮未复现，清单保留观察。
- 人类标注付费质量基准与真实 Host + Chrome 全链 E2E 持续如实 `not_run`
  （自动化环境无模型凭证）。
