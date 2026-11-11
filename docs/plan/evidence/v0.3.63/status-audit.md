# v0.3.63 交付状态审计（滚动窗口 0.3.60–0.3.62）

> 制定日期：2026-11-11。
> 审计方法：每版核对 ① git tag 存在且 `^{}` 解引用指向 main 合并提交（本地
> `git rev-parse` + `git ls-remote` 远端交叉核对）；② npm registry 同版本
> 存在（防缓存直连 curl）；③ `dist-tags.latest` 连续推进无回退。
> 审计时点基线：`main@39282ef`、package `0.3.62`、npm `latest=0.3.62`。

## 1. 三版「tag + registry + latest」审计结果

| 版本   | tag 存在 | tag 对象（peel 前缀） | `^{}` 解引用 → main 合并提交    | npm registry 存在 | registry shasum（SHA-1）                   | 入库时间（UTC）          |
| ------ | -------- | --------------------- | ------------------------------- | ----------------- | ------------------------------------------ | ------------------------ |
| 0.3.60 | ✅       | `32a3bc49`            | `256b8086` = merge `256b808` ✅ | ✅                | `76301c3815ab066a6e180f93ce16040651521756` | 2026-11-10T08:03:40.499Z |
| 0.3.61 | ✅       | `6113a224`            | `fb51d0e5` = merge `fb51d0e` ✅ | ✅                | `a13deed66fe0fa62677ce97ee322026aa2f54852` | 2026-11-10T14:32:12.700Z |
| 0.3.62 | ✅       | `5d73db6d`            | `39282eff` = merge `39282ef` ✅ | ✅                | `0ead49878f21b0678e380926fd4dc0fa686ca7b4` | 2026-11-11T01:36:46.634Z |

`dist-tags.latest` 序列：`0.3.60 → 0.3.61 → 0.3.62`，连续推进无回退。
远端 tag 双核验：`git ls-remote origin` 返回的三个 `^{}` peel 值与本地
`git rev-parse <tag>^{}` 逐字节一致（本地对象 `32a3bc49` / `6113a224` /
`5d73db6d` 与远端 tag 对象亦一致；本次审计在 v0.3.63 开版前实测）。

**结论：三版全部满足「tag + registry + latest」三条件，无欠账。**

## 2. v0.3.62 发布事实回填（上轮 v0.3.63 前完成）

- PR：https://github.com/orion-agents/orion-code/pull/322（squash 合并）。
- merge：`39282ef`（`39282eff35214806dbe896a94ef7fa2741aa87c7`，树 `ce24a42b`
  与 PR head 树逐字节一致）。
- tag：annotated `v0.3.62`，tag 对象 `5d73db6d`，peel → `39282ef`。
- npm：`latest=0.3.62`，入库 `2026-11-11T01:36:46.634Z`，registry shasum
  `0ead49878f21b0678e380926fd4dc0fa686ca7b4`。
- tarball：本地 sha256
  `77418d60aa8bb0677baffbb3425a374bc1eca6b369a51ec11a5f757e07b62a9a`
  （791 files / 1,884,191 B），与 web-e2e-receipt 顶层 + 全部 3 个 primary
  runs 的 `tarballSha256`（decision 全 GO）、release-receipt 两字段
  （`/artifact/tarball/sha256` + `/webE2E/tarballSha256`，GO）及本地
  release:check 工件多向逐字节一致；SHA-1 与 registry shasum 一致。
- CI：PR run `42888826433`。attempt 1：16 success + 1 failure（**Exact tgz
  on Node 26.0.0 floor**，"Clean-install and probe the downloaded tgz"
  步骤 exit=1，terminal PTY 屏幕内容探针——历史家族 v0.3.36/55/58/60 同
  签名）+ 1 skipped（Aggregate fail-closed 长期基线）→ `gh run rerun
  --failed` 单次复跑 → attempt 2 同一作业仍 failure（同 PTY 探针 exit=1
  同签名）→ 依「重跑仍红=停止」规则该轮收口；下一轮执行第二次单次复跑
  （attempt 3，约 4.5 分钟完成）→ **18/18 全部 success**，瞬时 flake 收口。
- GitHub Release：https://github.com/orion-agents/orion-code/releases/tag/v0.3.62
  （--latest，`/releases/latest` API 复核指向 v0.3.62；含 attempt 1/2/3
  三列逐作业门禁表 + flake trail + 多向 sha + 安装命令 + docs-only 张力
  标注）。

## 3. 开放项（延续记录）

- `WEB32-P0-08` OpenAI fixture 45s 超时 flake 家族根因未定（见
  `docs/plan/evidence/v0.3.53/investigation-and-audit.md`）；v0.3.62 周期
  三个 attempt 均未触及该场景红，维持瞬时 flake 家族观察。
- `terminal_journey` PTY 屏幕内容探针 flake 家族（Node 22/24/26 floor 均有
  出现记录）根因未定；v0.3.62 周期 attempt 1/2 连续复现于 Exact tgz Node
  26.0.0 floor 腿、attempt 3 转绿，与本轮 docs-only 改动无因果（零产品代码）。
- v0.3.58 周期 attempt 1 首见 flake 家族「web-e2e-runtime 矩阵腿从未实例化
  → run conclusion=failure 但无失败作业记录」，v0.3.59–v0.3.62 未复现，
  清单保留观察。
- 主指令 docs-only 周期与质量条款 C（不占版本号）的张力持续存在；当前沿
  v0.3.38–v0.3.62 先例以用户显式「每轮推进一个版本号」要求优先，Release
  notes 均已如实标注。上一版 candidate 段由下一轮开版提交翻转的欠账节奏
  亦沿此先例（本轮即清偿 0.3.62 的欠账）。
