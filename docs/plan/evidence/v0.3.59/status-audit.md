# v0.3.59 交付状态审计 — 三版滚动窗口（0.3.56–0.3.58）

> 审计日期：2026-11-10。
> 数据源：git tag（本地 `git rev-parse <tag>{}` + `git ls-remote` 远端交叉核对）、
> npm registry 直连（`curl --noproxy '*' -H 'Cache-Control: no-cache'`，防缓存
> 时间戳参数）、GitHub PR / Release / CI。
> 方法：每版核对 ① git tag 存在且注释 tag 解引用（`^{}`）指向 main 合并提交；
> ② npm registry 同版本存在（`versions[ver]`）；③ `dist-tags.latest` 指向最新
> 已发布版本且连续推进无回退。
> 本轮开版欠账清偿依据：main 上 CHANGELOG 的 0.3.58 条目由 `candidate` 翻为
> `published`，回填真实 npm 发布时间戳 `2026-11-09T19:27:43.656Z` 与 GitHub
> Release v0.3.58 链接；README / README.zh-CN 首部摘要同步改写为
> 「0.3.58 已发布、0.3.59 candidate」。

## 审计结论表

| 版本   | git tag（注释 tag 解引用）   | tag 指向 main 合并提交 | npm 版本存在 | registry 入库时间        | registry shasum（sha1）                    | dist-tag latest   | 结论      |
| ------ | ---------------------------- | ---------------------- | ------------ | ------------------------ | ------------------------------------------ | ----------------- | --------- |
| 0.3.56 | `v0.3.56` → `7787da7…0937b`  | 是（merge `7787da7`）  | 是           | 2026-11-09T01:01:32.301Z | `870c41d27ec0418a4d592a1315f3352e7ab211a6` | 否（已被覆盖）    | published |
| 0.3.57 | `v0.3.57` → `10d0ce0…2182e`  | 是（merge `10d0ce0`）  | 是           | 2026-11-09T13:06:47.415Z | `687077b3249deccf397dc238d56e5bde9234c4ab` | 否（已被覆盖）    | published |
| 0.3.58 | `v0.3.58` → `7ca9293…4941`   | 是（merge `7ca9293`）  | 是           | 2026-11-09T19:27:43.656Z | `078f73a0e2df60b7f9a3c5902d9e0bfc449265e9` | **是（=0.3.58）** | published |

- 三版 `dist-tags.latest` 序列：0.3.56 → 0.3.57 → 0.3.58，连续推进无回退；
  本轮防缓存直连复核 `latest=0.3.58`（`dist-tags.next` 仍停在 `0.3.19`，
  为历史遗留 dist-tag，与 latest 判定无关）。
- 本地 `git rev-parse v0.3.X^{}` 与远端 `refs/tags/v0.3.X^{}` 一致
  （7787da7 / 10d0ce0 / 7ca9293），三版 tag 均位于 `origin/main` 历史上。
- 注释 tag 对象亦双端一致：`d0f1d7bc`（0.3.56）/ `6c2dec2d`（0.3.57）/
  `a6fca4b8`（0.3.58）。
- 三版 registry shasum 与历轮发布记录一致，并以本轮直连复核确认，无篡改迹象。

## 0.3.58 发布事实回填（Step 0 开版欠账清偿依据）

- PR：#318（`docs: v0.3.58 candidate - v0.3.57 release-completion bookkeeping`）
- squash 合并提交：`7ca92932ac7e9bded3731dba9629e10e2dd54941`（main，树
  `c940a4ad…` 与 PR head 树逐字节一致）
- git tag：`v0.3.58`（注释 tag，tag 对象 `a6fca4b8…f3ff1`，peel →
  `7ca9293…4941`，已推送，`git ls-remote origin refs/tags/v0.3.58^{}` 远端一致）
- npm registry：`@orion-agents/orion-code@0.3.58`，`dist-tags.latest=0.3.58`
- registry shasum：`078f73a0e2df60b7f9a3c5902d9e0bfc449265e9`
- tarball 入库时间：`2026-11-09T19:27:43.656Z`（registry `time` 字段）
- tarball sha256：`2e05239a84fca4fcc4e607f7e5b5b7d01de85509b6685138443e4c248e35924f`
  （与 CI run `42673103882` 的 `web-e2e-receipt.tarballSha256`（GO）及
  `release-receipt` 全部 tarballSha256 字段逐字节一致；791 files /
  1,883,656 B，本地 SHA-1 `078f73a0…65e9` 与 registry shasum 一致）
- GitHub Release：https://github.com/orion-agents/orion-code/releases/tag/v0.3.58
  （已建，`--latest`，notes 含三轮逐作业门禁表 + rerun trail + 四向 sha +
  安装命令 + docs-only 张力标注）
- CI 门禁：PR run `42673103882` attempt 3 **18/18 全部 success（零红零
  skipped）**。attempt 1 首见新 flake 家族——web-e2e-runtime 矩阵 Node 24 腿
  从未实例化（17/18 作业存在 + 2 skipped，run conclusion=failure 但无失败作业
  记录，`gh run rerun --failed` 被拒，降级为整条 rerun）；attempt 2 唯一
  failure 为 Node 24 floor `terminal_journey` PTY 探针 exit=1（同 Node 26 floor
  家族签名）；attempt 3 全绿 → 按「重跑绿=瞬时 flake 可合并」规则收口。逐作业
  核对经 `gh api` attempts API。

## 开放项（承前）

- `WEB32-P0-08`（OpenAI fixture 超时）根因仍开放：证据与静态排查见
  `docs/plan/evidence/v0.3.53/investigation-and-audit.md`。v0.3.58 周期
  attempt 3 E2E 三连跑全绿，维持瞬时 flake 定性；本轮不宣称其已修复。
- 新 flake 家族待观察：attempt 1 的「矩阵腿未实例化→run failure 无失败作业」
  根因未定；若复现，处置路径仍是整条 rerun（`--failed` 必被拒）。
- 人标付费质量基准与真实 Host + Chrome 全链路 E2E 在自动化环境中无模型
  凭据可跑，持续如实标注 `not_run`（blocked by environment，不视为 pass）。
