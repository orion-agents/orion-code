# v0.3.34 交付状态审计（0.3.31–0.3.33）与 v0.3.33 发布事实回填

> 审计日期：2026-10-24。审计人：自动化轮（v0.3.34）。
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
| 0.3.31 | `v0.3.31` → `10dfd8d`（#287） | `f386000e6ef40ab347d744fb2afefc3b6daae687` | 2026-10-22T21:45:55.477Z | —               | 满足 |
| 0.3.32 | `v0.3.32` → `d24f531`（#288） | `e0542251f4a4c5eb3bbfe686c884606bf80be0c5` | 2026-10-23T03:39:28.945Z | —               | 满足 |
| 0.3.33 | `v0.3.33` → `262e6e2`（#289） | `d6d66547a6ae6bd63d92ae55aee9a6d4ec2ba4a2` | 2026-10-24T01:50:26.062Z | `latest=0.3.33` | 满足 |

- 采集方式：`git tag --list 'v0.3.*'` + `git rev-list -n1 <tag>`（本地，与 origin
  同步）+ 直连
  `curl -s -H 'Cache-Control: no-cache' "https://registry.npmjs.org/@orion-agents%2Forion-code?t=<ts>"`
  解析 `versions` / `time` / `dist-tags`（2026-10-24 快照）。
- 口径说明：npm registry 的 `dist.shasum` 是 tarball 的 SHA-1（npm 口径），
  与本地 `npm pack` 产物文件 SHA-256 为不同口径，两者均有效，不构成冲突。

## v0.3.33 发布链路事实（本版回填）

v0.3.33（发布收据回填与交付状态审计切片，plan `docs/plan/v0.3.33-plan.md`）的
发布事实如下，全部可由 git log / registry 交叉验证：

- PR：https://github.com/orion-agents/orion-code/pull/289（squash 合并）。
- 合并提交：`262e6e2`（main，完整 SHA
  `262e6e28937652e09f81209c828c050805658b7e`）。
- tag：`v0.3.33`（指向 main 合并提交 `262e6e2`）。
- npm：registry shasum `d6d66547a6ae6bd63d92ae55aee9a6d4ec2ba4a2`；tarball 入库
  时间 2026-10-24T01:50:26.062Z。
- registry 确认：直连 curl（`Cache-Control: no-cache`）确认 0.3.33 存在且
  `dist-tags.latest=0.3.33`。
- 发布过程备注：本轮 publish 无重试，一次成功；CI 18/18 全绿无 flake 重跑；
  registry 可见性在数分钟内确认，与 v0.3.29 / v0.3.31 轮记录的可见性延迟现象
  相比本轮未复现阻塞。

## 结论

0.3.31 / 0.3.32 / 0.3.33 三版均满足「tag + registry + latest」三项核对，无交付
状态漂移残留。唯一被本版（v0.3.34）修正的漂移是文档侧：CHANGELOG 0.3.33 条目
停留在 `candidate`、v0.3.33 发布事实未形成仓库内证据文件。

## 明确 not_run

- 人工标注付费质量评测（12 缺陷 + 8 干净样本 × 3 轮）：自动化环境无模型凭据，
  门槛见 `docs/plan/v0.3.27-plan.md` §9.3。
- 真实 Host + Chrome 全链路审查 E2E：同上；CI 承载 exact tgz ×3 平台与
  Web E2E full suite 三连绿 gate。
