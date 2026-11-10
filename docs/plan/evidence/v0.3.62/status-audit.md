# v0.3.62 交付状态审计（滚动窗口 0.3.59–0.3.61）

> 制定日期：2026-11-11。
> 审计方法：每版核对 ① git tag 存在且 `^{}` 解引用指向 main 合并提交（本地
> `git rev-parse` + `git ls-remote` 远端交叉核对）；② npm registry 同版本
> 存在（防缓存直连 curl）；③ `dist-tags.latest` 连续推进无回退。
> 审计时点基线：`main@fb51d0e`、package `0.3.61`、npm `latest=0.3.61`。

## 1. 三版「tag + registry + latest」审计结果

| 版本   | tag 存在 | tag 对象（peel 前缀） | `^{}` 解引用 → main 合并提交    | npm registry 存在 | registry shasum（SHA-1）                   | 入库时间（UTC）          |
| ------ | -------- | --------------------- | ------------------------------- | ----------------- | ------------------------------------------ | ------------------------ |
| 0.3.59 | ✅       | `871632a1`            | `089fa330` = merge `089fa33` ✅ | ✅                | `f0f4f72bdfe38cd2e9ae952dd0c109a368b2fdb6` | 2026-11-10T02:04:09.591Z |
| 0.3.60 | ✅       | `32a3bc49`            | `256b8086` = merge `256b808` ✅ | ✅                | `76301c3815ab066a6e180f93ce16040651521756` | 2026-11-10T08:03:40.499Z |
| 0.3.61 | ✅       | `6113a224`            | `fb51d0e5` = merge `fb51d0e` ✅ | ✅                | `a13deed66fe0fa62677ce97ee322026aa2f54852` | 2026-11-10T14:32:12.700Z |

`dist-tags.latest` 序列：`0.3.59 → 0.3.60 → 0.3.61`，连续推进无回退。
远端 tag 双核验：`git ls-remote origin` 返回的三个 `^{}` peel 值与本地
`git rev-parse <tag>^{}` 逐字节一致（本地对象 `871632a1` / `32a3bc49` /
`6113a224` 与远端 tag 对象亦一致；本次审计在 v0.3.62 开版前实测）。

**结论：三版全部满足「tag + registry + latest」三条件，无欠账。**

## 2. v0.3.61 发布事实回填（上轮 v0.3.62 前完成）

- PR：https://github.com/orion-agents/orion-code/pull/321（squash 合并）。
- merge：`fb51d0e`（`fb51d0e5b4a613b90d2314f4b883526ae6dda92f`，树 `73b94021`
  与 PR head 树逐字节一致）。
- tag：annotated `v0.3.61`，tag 对象 `6113a224`，peel → `fb51d0e`。
- npm：`latest=0.3.61`，入库 `2026-11-10T14:32:12.700Z`，registry shasum
  `a13deed66fe0fa62677ce97ee322026aa2f54852`。
- tarball：本地 sha256
  `b87bb67e6cf1ff6d9a6ec3cbdcc62f990484e695d77279622dbec9fbc65740d3`
  （791 files / 1.80 MB packed），与 web-e2e-receipt 顶层 + 全部 3 个 primary
  runs 的 `tarballSha256`（decision 全 GO）、release-receipt 两字段
  （`/artifact/tarball/sha256` + `/webE2E/tarballSha256`，GO）及本地
  release:check 工件多向逐字节一致；SHA-1 与 registry shasum 一致。
- CI：PR run `42823607195`。attempt 1：16 success + 1 failure（Web E2E full
  suite three consecutive runs，run-3 红 `WEB32-P0-08` OpenAI fixture 45s
  超时——历史家族）+ 2 skipped（双 Aggregate receipt 长期基线）；
  `gh run rerun --failed` 单次复跑 → attempt 2 **18/18 全部 success，零红零
  skipped**（双 Aggregate receipt 也转绿），定性瞬时 flake。
- GitHub Release：https://github.com/orion-agents/orion-code/releases/tag/v0.3.61
  （--latest，`/releases/latest` API 复核指向 v0.3.61；含 attempt 1/2 双列
  逐作业门禁表 + flake trail + 多向 sha + 安装命令 + docs-only 张力标注）。

## 3. 开放项（延续记录）

- `WEB32-P0-08` OpenAI fixture 45s 超时 flake 家族根因未定（见
  `docs/plan/evidence/v0.3.53/investigation-and-audit.md`）；v0.3.61 周期
  attempt 1 该场景红（run-3），attempt 2 全绿，家族持续观察。
- `terminal_journey` PTY 屏幕内容探针 flake 家族（历轮 Node 22/24/26 floor
  均有出现）v0.3.61 周期未复现，根因未定。
- v0.3.58 周期 attempt 1 的「web-e2e-runtime 矩阵腿从未实例化 → run failure
  无失败作业」异常 v0.3.59–v0.3.61 未复现，清单保留观察。
- 人工标注的付费质量基准与真实 Host + Chrome 全链路 E2E：诚实 `not_run`
  （自动化环境无模型凭据）。
