# v0.3.39 交付状态审计（滚动窗口：0.3.36–0.3.38）

> 采集时间：2026-10-26（v0.3.39 开版轮）。
>
> 方法：① `git tag --list 'v0.3.*'` + `git rev-parse <tag>^{}`（本地与 origin 强制同步
> 后核对，`git ls-remote` 交叉验证）；② npm registry 直连 curl（`Cache-Control:
> no-cache`、`--noproxy '*'`）核对版本存在性、shasum 与入库时间；③ 同一响应的
> `dist-tags.latest` 核对最新已发布指向。

## 三版审计表

| 版本   | git tag 指向                                                            | registry shasum                                | 入库时间                 | dist-tag        | 结论 |
| ------ | ----------------------------------------------------------------------- | ---------------------------------------------- | ------------------------ | --------------- | ---- |
| 0.3.36 | `v0.3.36` → `ebbbaa4`（注释 tag；重指向说明见下）                        | `cce4f6cff28966986046d170eac14a9b155fc51f`     | 2026-10-25T01:59:21.552Z | —               | 满足 |
| 0.3.37 | `v0.3.37` → `8fb6ef0`（main squash 合并提交，#293）                      | `31754d58e735d6ff78ce76fc7bed183c6fcf8512`     | 2026-10-25T15:03:25.053Z | —               | 满足 |
| 0.3.38 | `v0.3.38` → `4cb727e`（main squash 合并提交，#295）                      | `5c15a05421c53d66cc543c9d9ab4516e1e04d18f`     | 2026-10-25T20:50:25.203Z | `latest=0.3.38` | 满足 |

三项核对口径：① tag 存在且可解析到 commit；② registry 同版本 tarball 存在且
shasum 与发布轮记录一致；③ `dist-tags.latest` 指向最新已发布版本（当前 0.3.38）。
0.3.36 / 0.3.37 的 dist-tag 列为「—」表示已被后续版本覆盖，属预期滚动。

## v0.3.36 tag 重指向的事实记录（勘误）

上一轮（v0.3.38 轮）审计表将 0.3.36 的 tag 指向记为 `6ea1d16`（main squash 合并
提交，#292），本次核对发现该记录不准确：远端 `refs/tags/v0.3.36` 为**注释 tag**，
object 为 `ebbbaa4`，tag message 为「v0.3.36 — receipt backfill & delivery-status
audit (retagged: CHANGELOG published facts)」，即 PR #294 协同轮（undici 6.29.1
审计修复合入 main 为 `70373f2`）对 tag 做过一次重指向。`ebbbaa4` 不在 main 历史
上（squash 合并重写历史所致），与 `6ea1d16` 的树差异仅 `npm-shrinkwrap.json` 3 行
（undici resolution），内容等价。三项核对（tag 存在 / registry 版本存在 /
latest 指向）不受影响，本表按实测事实更正记录。

## v0.3.38 发布事实回填

- PR：#295（`codex/v0.3.38`，docs-only 切片）。
- 合并：squash merge → `4cb727e2049c70e6a8b300325c9020f22bf2708c`。
- tag：`v0.3.38`（注释 tag object `331354d`，peel → `4cb727e`）。
- npm：`@orion-agents/orion-code@0.3.38`，registry `latest=0.3.38`，tarball 入库
  **2026-10-25T20:50:25.203Z**，registry shasum
  `5c15a05421c53d66cc543c9d9ab4516e1e04d18f`。
- GitHub Release：https://github.com/orion-agents/orion-code/releases/tag/v0.3.38
  （创建于 2026-10-25T20:52:20Z，非 draft）。

## 结论

0.3.36 / 0.3.37 / 0.3.38 三版均满足「tag + registry + latest」三项核对，无交付
状态漂移残留。本轮（v0.3.39）修正的漂移为文档侧：main CHANGELOG 0.3.38 条目
停留在 `candidate`，本版翻转为 `published` 并回填真实时间戳与 Release 链接；
另更正上轮审计对 v0.3.36 tag 指向的记录（6ea1d16 → ebbbaa4，重指向事实）。

## 明确 not_run

- 人工标注付费质量评测（12 缺陷 + 8 干净样本、3 轮运行）：本自动化环境无模型
  凭据，未运行，如实记 `not_run`（非 pass）。
- 真实 Host + Chrome 全链路审查 E2E：同上，`not_run`。
- 自 v0.3.36 轮起新发布版本均即时创建 GitHub Release，历史欠账（v0.3.28–v0.3.35）
  不再扩大，是否逐版补发由维护者决策。
