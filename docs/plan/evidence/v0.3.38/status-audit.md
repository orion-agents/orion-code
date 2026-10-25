# v0.3.38 交付状态审计（0.3.35–0.3.37）与 v0.3.37 发布事实回填

> 审计日期：2026-10-26。审计人：自动化轮（v0.3.38）。
>
> 口径：每版核对三项 —— ① git tag 存在且指向 main 合并提交；② npm registry
> 存在同版本（直连 curl，`Cache-Control: no-cache`，不依赖本地 npm 缓存）；
> ③ `dist-tags.latest` 指向最新已发布版本。
>
> 依据：项目级目标 §11.2「分别记录：实现候选、默认分支合并、tag、npm 版本」
> 与 G1「每项完成结论绑定当前代码或外部资源的证据」。

## 审计结果

| 版本   | tag（→ main 合并提交）        | registry shasum（npm SHA-1 口径）          | tarball 入库时间（UTC）  | latest 指向     | 结论 |
| ------ | ----------------------------- | ------------------------------------------ | ------------------------ | --------------- | ---- |
| 0.3.35 | `v0.3.35` → `cfbb4e2`（#291） | `b54d87b2ade509af3479cbd19020b3df5a9f343b` | 2026-10-24T20:06:04.738Z | —               | 满足 |
| 0.3.36 | `v0.3.36` → `6ea1d16`（#292） | `cce4f6cff28966986046d170eac14a9b155fc51f` | 2026-10-25T01:59:21.552Z | —               | 满足 |
| 0.3.37 | `v0.3.37` → `8fb6ef0`（#293） | `31754d58e735d6ff78ce76fc7bed183c6fcf8512` | 2026-10-25T15:03:25.053Z | `latest=0.3.37` | 满足 |

- 采集方式：`git tag --list 'v0.3.*'` + `git rev-list -n1 <tag>`（本地，与 origin
  同步）+ 直连
  `curl -s -H 'Cache-Control: no-cache' "https://registry.npmjs.org/@orion-agents%2Forion-code?t=<ts>"`
  解析 `versions` / `time` / `dist-tags`（2026-10-26 快照，本轮 v0.3.38 开发前
  现场采集；查询同时确认 0.3.38 尚未发布，避免误判）。
- 口径说明：npm registry 的 `dist.shasum` 是 tarball 的 SHA-1（npm 口径），
  与本地 `npm pack` 产物文件 SHA-256 为不同口径，两者均有效，不构成冲突。

## v0.3.37 发布链路事实（本版回填）

v0.3.37（发布收据回填与交付状态审计切片，plan `docs/plan/v0.3.37-plan.md`）的
发布事实如下，全部可由 git log / registry / GitHub 交叉验证：

- PR：https://github.com/orion-agents/orion-code/pull/293（squash 合并）。
- 合并提交：`8fb6ef0`（main，完整 SHA
  `8fb6ef0e1982b0485672d921914fbb1adf0ba6a0`）。
- tag：`v0.3.37`（指向 main 合并提交 `8fb6ef0`）。
- npm：registry shasum `31754d58e735d6ff78ce76fc7bed183c6fcf8512`；tarball 入库
  时间 2026-10-25T15:03:25.053Z。
- registry 确认：直连 curl（`Cache-Control: no-cache`）确认 0.3.37 存在且
  `dist-tags.latest=0.3.37`。
- GitHub Release：v0.3.37 发布当轮已创建（自 v0.3.36 轮起「GitHub Release 创建」
  固定为发布链路第 8 步，本轮为该流程的首个完整执行轮）：
  https://github.com/orion-agents/orion-code/releases/tag/v0.3.37 。

## 结论

0.3.35 / 0.3.36 / 0.3.37 三版均满足「tag + registry + latest」三项核对，无交付
状态漂移残留。唯一被本版（v0.3.38）修正的漂移是文档侧：CHANGELOG 0.3.37 条目
停留在 `candidate`、v0.3.37 发布事实未形成仓库内证据文件。

## 明确 not_run

- 人工标注付费质量评测（12 缺陷 + 8 干净样本 × 3 轮）：自动化环境无模型凭据，
  门槛见 `docs/plan/v0.3.27-plan.md` §9.3。
- 真实 Host + Chrome 全链路审查 E2E：同上；CI 承载 exact tgz ×3 平台与
  Web E2E full suite 三连绿 gate。
- v0.3.28–v0.3.35 的 GitHub Release 逐版补发：超出本版范围，由维护者决策；
  自 v0.3.36 轮起新发布版本均即时创建 Release，历史欠账不再扩大。
