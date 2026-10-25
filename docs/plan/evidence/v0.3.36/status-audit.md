# v0.3.36 交付状态审计（0.3.33–0.3.35）与 v0.3.35 发布事实回填

> 审计日期：2026-10-25。审计人：自动化轮（v0.3.36）。
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
| 0.3.33 | `v0.3.33` → `262e6e2`（#289） | `d6d66547a6ae6bd63d92ae55aee9a6d4ec2ba4a2` | 2026-10-24T01:50:26.062Z | —               | 满足 |
| 0.3.34 | `v0.3.34` → `d511973`（#290） | `a9f5aa120e8e7277eed2d90837c6792bb1621837` | 2026-10-24T07:34:48.885Z | —               | 满足 |
| 0.3.35 | `v0.3.35` → `cfbb4e2`（#291） | `b54d87b2ade509af3479cbd19020b3df5a9f343b` | 2026-10-24T20:06:04.738Z | `latest=0.3.35` | 满足 |

- 采集方式：`git tag --list 'v0.3.*'` + `git rev-list -n1 <tag>`（本地，与 origin
  同步）+ 直连
  `curl -s -H 'Cache-Control: no-cache' "https://registry.npmjs.org/@orion-agents%2Forion-code?t=<ts>"`
  解析 `versions` / `time` / `dist-tags`（2026-10-25 快照，本轮 v0.3.36 开发前
  现场采集；查询同时确认 0.3.36 尚未发布，避免误判）。
- 口径说明：npm registry 的 `dist.shasum` 是 tarball 的 SHA-1（npm 口径），
  与本地 `npm pack` 产物文件 SHA-256 为不同口径，两者均有效，不构成冲突。

## v0.3.35 发布链路事实（本版回填）

v0.3.35（发布收据回填与交付状态审计切片，plan `docs/plan/v0.3.35-plan.md`）的
发布事实如下，全部可由 git log / registry 交叉验证：

- PR：https://github.com/orion-agents/orion-code/pull/291（squash 合并）。
- 合并提交：`cfbb4e2`（main，完整 SHA
  `cfbb4e274cedada1aaebab7f0f53686324a170dc`）。
- tag：`v0.3.35`（指向 main 合并提交 `cfbb4e2`）。
- npm：registry shasum `b54d87b2ade509af3479cbd19020b3df5a9f343b`；tarball 入库
  时间 2026-10-24T20:06:04.738Z。
- registry 确认：直连 curl（`Cache-Control: no-cache`）确认 0.3.35 存在且
  `dist-tags.latest=0.3.35`。
- 发布过程备注：上轮（2026-10-24）v0.3.35 首次推进时 CI「Web E2E full suite
  three consecutive runs」连续 8 轮执行均因 WEB32-P0-08 OpenAI fixture 45s 超时
  失败（当日 runner 负载 flake），按任务规则停止并保持 PR OPEN；本轮
  `gh run rerun --failed` 重跑后 E2E 通过，仅 Dependency security audit 常红
  基线（js-yaml GHSA）下合并。publish 无重试，一次成功。

## 结论

0.3.33 / 0.3.34 / 0.3.35 三版均满足「tag + registry + latest」三项核对，无交付
状态漂移残留。唯一被本版（v0.3.36）修正的漂移是文档侧：CHANGELOG 0.3.35 条目
停留在 `candidate`、v0.3.35 发布事实未形成仓库内证据文件。

## 明确 not_run

- 人工标注付费质量评测（12 缺陷 + 8 干净样本 × 3 轮）：自动化环境无模型凭据，
  门槛见 `docs/plan/v0.3.27-plan.md` §9.3。
- 真实 Host + Chrome 全链路审查 E2E：同上；CI 承载 exact tgz ×3 平台与
  Web E2E full suite 三连绿 gate。
