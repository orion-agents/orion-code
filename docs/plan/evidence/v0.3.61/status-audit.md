# v0.3.61 交付状态审计（滚动窗口 0.3.58–0.3.60）

> 制定日期：2026-11-10。
> 审计方法：每版核对 ① git tag 存在且 `^{}` 解引用指向 main 合并提交（本地
> `git rev-parse` + `git ls-remote` 远端交叉核对）；② npm registry 同版本
> 存在（防缓存直连 curl）；③ `dist-tags.latest` 连续推进无回退。
> 审计时点基线：`main@256b808`、package `0.3.60`、npm `latest=0.3.60`。

## 1. 三版「tag + registry + latest」审计结果

| 版本   | tag 存在 | tag 对象（peel 前缀） | `^{}` 解引用 → main 合并提交     | npm registry 存在 | registry shasum（SHA-1）               | 入库时间（UTC）             |
| ------ | -------- | --------------------- | -------------------------------- | ----------------- | -------------------------------------- | --------------------------- |
| 0.3.58 | ✅       | `a6fca4b8`            | `7ca92932` = merge `7ca9293` ✅  | ✅                | `078f73a0e2df60b7f9a3c5902d9e0bfc449265e9` | 2026-11-09T19:27:43.656Z    |
| 0.3.59 | ✅       | `871632a1`            | `089fa330` = merge `089fa33` ✅  | ✅                | `f0f4f72bdfe38cd2e9ae952dd0c109a368b2fdb6` | 2026-11-10T02:04:09.591Z    |
| 0.3.60 | ✅       | `32a3bc49`            | `256b8086` = merge `256b808` ✅  | ✅                | `76301c3815ab066a6e180f93ce16040651521756` | 2026-11-10T08:03:40.499Z    |

`dist-tags.latest` 序列：`0.3.58 → 0.3.59 → 0.3.60`，连续推进无回退。
远端 tag 双核验：`git ls-remote origin 'refs/tags/v0.3.*'` 返回的三个 `^{}` peel
值与本地 `git rev-parse <tag>^{}` 逐字节一致（本次审计在 v0.3.61 开版前实测）。

**结论：三版全部满足「tag + registry + latest」三条件，无欠账。**

## 2. v0.3.60 发布事实回填（上轮 v0.3.61 前完成）

- PR：https://github.com/orion-agents/orion-code/pull/320（squash 合并）。
- merge：`256b808`（`256b8086c9485733eca347a8f240a41e6108c2b1`，PR head 树与
  merge 树逐字节一致）。
- tag：annotated `v0.3.60`，tag 对象 `32a3bc49`，peel → `256b808`。
- npm：`latest=0.3.60`，入库 `2026-11-10T08:03:40.499Z`，registry shasum
  `76301c3815ab066a6e180f93ce16040651521756`。
- tarball：本地 sha256 `f1d45e714f271a3965fb273ba61459653cb2ef8af6e3495ffbdefd9dc222fda0`
  （791 files / 1,883,828 B），与 CI web-e2e-receipt 顶层 + 全部 6 个
  primary/runtime runs 的 `tarballSha256`（decision 全 GO）及本地
  release:check 工件多向逐字节一致；SHA-1 与 registry shasum 一致。
- CI：PR run `42774833976`。attempt 1：17 success + 1 failure
  （Exact tgz on Node 22.12.0 floor，`terminal_journey` PTY 探针 exit=1——
  历史 Node 24/26 floor 家族首次落到 Node 22 腿）+ 1 skipped（Aggregate
  fail-closed 长期基线）；`gh run rerun --failed` 单次复跑 → attempt 2
  **18/18 全部 success，零红零 skipped**，定性瞬时 flake。
- GitHub Release：https://github.com/orion-agents/orion-code/releases/tag/v0.3.60
  （--latest，含 attempt 1/2 双列逐作业门禁表 + 多向 sha + 安装命令 +
  docs-only 张力标注）。

## 3. 开放项（延续记录）

- `WEB32-P0-08` OpenAI fixture 45s 超时 flake 家族根因未定（见
  `docs/plan/evidence/v0.3.53/investigation-and-audit.md`）；v0.3.60 周期
  attempt 1 无该场景红，家族持续观察。
- `terminal_journey` PTY 屏幕内容探针 flake 家族扩展到 Node 22 floor
  （历轮 24/26 floor 已见），根因未定。
- v0.3.58 周期 attempt 1 的「web-e2e-runtime 矩阵腿从未实例化 → run failure
  无失败作业」异常 v0.3.59/v0.3.60 未复现，清单保留观察。
- 人工标注的付费质量基准与真实 Host + Chrome 全链路 E2E：诚实 `not_run`
  （自动化环境无模型凭据）。
