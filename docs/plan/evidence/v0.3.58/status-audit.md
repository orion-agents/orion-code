# v0.3.58 交付状态审计 — 三版滚动窗口（0.3.55–0.3.57）

> 审计日期：2026-11-10。
> 数据源：git tag（本地 `git rev-parse <tag>{}` + `git ls-remote` 远端交叉核对）、
> npm registry 直连（`curl --noproxy '*' -H 'Cache-Control: no-cache'`，防缓存
> 时间戳参数）、GitHub PR / Release / CI。
> 方法：每版核对 ① git tag 存在且注释 tag 解引用（`^{}`）指向 main 合并提交；
> ② npm registry 同版本存在（`versions[ver]`）；③ `dist-tags.latest` 指向最新
> 已发布版本且连续推进无回退。
> 本轮开版欠账清偿依据：main 上 CHANGELOG 的 0.3.57 条目由 `candidate` 翻为
> `published`，回填真实 npm 发布时间戳 `2026-11-09T13:06:47.415Z` 与 GitHub
> Release v0.3.57 链接；README / README.zh-CN 首部摘要同步改写为
> 「0.3.57 已发布、0.3.58 candidate」。

## 审计结论表

| 版本   | git tag（注释 tag 解引用）   | tag 指向 main 合并提交 | npm 版本存在 | registry 入库时间        | registry shasum（sha1）                    | dist-tag latest   | 结论      |
| ------ | ---------------------------- | ---------------------- | ------------ | ------------------------ | ------------------------------------------ | ----------------- | --------- |
| 0.3.55 | `v0.3.55` → `213676c…dc377`  | 是（merge `213676c`）  | 是           | 2026-11-08T19:05:26.012Z | `bc65972dc439fb880253b6d4f71c776f96c2ec41` | 否（已被覆盖）    | published |
| 0.3.56 | `v0.3.56` → `7787da7…0937b`  | 是（merge `7787da7`）  | 是           | 2026-11-09T01:01:32.301Z | `870c41d27ec0418a4d592a1315f3352e7ab211a6` | 否（已被覆盖）    | published |
| 0.3.57 | `v0.3.57` → `10d0ce0…2182e`  | 是（merge `10d0ce0`）  | 是           | 2026-11-09T13:06:47.415Z | `687077b3249deccf397dc238d56e5bde9234c4ab` | **是（=0.3.57）** | published |

- 三版 `dist-tags.latest` 序列：0.3.55 → 0.3.56 → 0.3.57，连续推进无回退；
  本轮防缓存直连复核 `latest=0.3.57`（`dist-tags.next` 仍停在 `0.3.19`，
  为历史遗留 dist-tag，与 latest 判定无关）。
- 本地 `git rev-parse v0.3.X^{}` 与远端 `refs/tags/v0.3.X^{}` 一致
  （213676c / 7787da7 / 10d0ce0），三版 tag 均位于 `origin/main` 历史上。
- 注释 tag 对象亦双端一致：`6d3e3ff3`（0.3.55）/ `d0f1d7bc`（0.3.56）/
  `6c2dec2d`（0.3.57）。
- 三版 registry shasum 与历轮发布记录一致，并以本轮直连复核确认，无篡改迹象。

## 0.3.57 发布事实回填（Step 0 开版欠账清偿依据）

- PR：#317（`docs: v0.3.57 candidate - v0.3.56 release-completion bookkeeping`）
- squash 合并提交：`10d0ce0b01d60dc10767383770552da60122182e`（main，树
  `eca40899…` 与 PR head 树逐字节一致）
- git tag：`v0.3.57`（注释 tag，tag 对象 `6c2dec2d…4823b`，peel →
  `10d0ce0…2182e`，已推送，`git ls-remote origin refs/tags/v0.3.57^{}` 远端一致）
- npm registry：`@orion-agents/orion-code@0.3.57`，`dist-tags.latest=0.3.57`
- registry shasum：`687077b3249deccf397dc238d56e5bde9234c4ab`
- tarball 入库时间：`2026-11-09T13:06:47.415Z`（registry `time` 字段；publish
  成功输出早于入库约 4 分钟，属既有 CDN 传播延迟）
- tarball sha256：`fadf8289a815ab227ad3d21a833621023fd4b9304b379c1213494aa1265fff60`
  （与 CI run `42572319183` 的 `web-e2e-receipt.tarballSha256`（decision GO）及
  `release-receipt` 全部 tarballSha256 字段逐字节一致；791 files /
  1,883,559 B，本地 SHA-1 `687077b3…c4ab` 与 registry shasum 一致）
- GitHub Release：https://github.com/orion-agents/orion-code/releases/tag/v0.3.57
  （已建，`--latest`，notes 含 18 作业逐项门禁表 + flake 历史 + 三向 sha +
  安装命令 + docs-only 张力标注）
- CI 门禁：PR run `42572319183` attempt 3 **18/18 全部 success（零红零
  skipped）**。attempt 1（17 success + 1 failure）与 attempt 2（同型失败）均红于
  `WEB32-P0-08` OpenAI fixture 45s 超时（失败签名逐字节同型）；`gh run rerun
  --failed` 单次复跑后 attempt 3 全绿（含长期 skipped 的 Aggregate fail-closed
  receipt 转绿）→ 按「重跑绿=瞬时 flake 可合并」规则收口。逐作业核对经
  `gh api runs/42572319183/attempts/3/jobs`。

## 开放项（承前）

- `WEB32-P0-08`（OpenAI fixture 超时）根因仍开放：证据与静态排查见
  `docs/plan/evidence/v0.3.53/investigation-and-audit.md`。v0.3.57 周期 CI
  attempt 1/2 连红、attempt 3 全绿，维持瞬时 flake 定性；本轮不宣称其已修复。
- 人标付费质量基准与真实 Host + Chrome 全链路 E2E 在自动化环境中无模型
  凭据可跑，持续如实标注 `not_run`（blocked by environment，不视为 pass）。
