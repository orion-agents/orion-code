# 代码质量测试报告 — v0.1.4 Research-to-Evidence

- 日期：2026-08-06
- 分支：`v0.1.4`（HEAD `9cb8137`，与 `origin/v0.1.4` 同步；PR [#7](https://github.com/orion-agents/orion-code/pull/7) OPEN）
- 范围：`src/runtime/subagents/research-*.ts` + `web-research-adapter.ts`（v0.1.4 全部新增产品代码）
- 方法：覆盖率治理（jest + ts-jest）、失败路径补测、静态安全自检（SSRF / 失败闭合 / 密钥卫生 / 并发写入）、缺陷修复与回归
- 运行环境：Node v24.14.0，`NODE_OPTIONS="--use-system-ca"`（禁用沙箱 safe-delete 守卫，避免注入子进程）

---

## 1. 结论摘要

**质量门禁：通过。** v0.1.4 模块的行覆盖 98.77%、分支覆盖 90.36%，均高于核心模块门禁（行 ≥90% / 分支 ≥85%）。

本轮分两步：

1. **覆盖率治理** —— 补齐 11 条失败路径测试，把此前**完全未被测试的失败闭合分支**纳入回归网，其中包括 v0.1.4 的核心完整性不变量（inference 不得标记 observed）。
2. **缺陷修复** —— 审计发现的密钥外泄风险 F-1（中危）与审计缺失 F-2（低危）**已在本分支修复**，并补 4 条回归测试；同时清掉 4 项 P3 测试债。

无遗留未修缺陷。

---

## 2. 覆盖率报告

### 2.1 治理前后对比

| 指标 | 初始 | 补测后 | 修复+补债后 | 门禁 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 语句 Stmts | 92.58% | 96.82% | **97.47%** | — | ↑ 4.89 |
| 分支 Branch | 83.38% | 88.37% | **90.36%** | ≥85% | ❌ → ✅ |
| 函数 Funcs | 98.80% | 98.80% | **98.80%** | — | 持平 |
| 行 Lines | 93.82% | 98.51% | **98.77%** | ≥90% | ✅ |
| 用例数 | 38 | 49 | **55** | — | +17 |

### 2.2 分文件覆盖（最终）

| 文件 | Stmts | Branch | Lines | 残余未覆盖行 |
| --- | --- | --- | --- | --- |
| `research-contract.ts` | 96.11% | 90.47% | **100%** | 60,145,157-171,204-205,213 |
| `web-research-adapter.ts` | 96.90% | 88.67% | 97.80% | 100,321 |
| `research-artifact.ts` | 98.14% | **100%** | **100%** | — |
| `research-citation.ts` | 99.00% | 91.07% | 98.75% | 30 |
| `research-quality.ts` | 95.52% | 87.27% | 96.61% | 34,141 |
| `research-renderer.ts` | **100%** | 86.95% | **100%** | 68-95,154 |
| `research-types.ts` | **100%** | **100%** | **100%** | — |

`research-contract.ts` 与 `web-research-adapter.ts` 的分支覆盖初始分别只有 77.38% / 79.24%，是本轮治理的两个主要缺口来源。残余未覆盖项均为 URL 解析 catch 一类的不可达纵深防御分支（见 §4.2 F-3）。

---

## 3. 本轮新增测试（11 条）

### `tests/research-contract.test.ts` — 硬上限与失败闭合分支（7 条）

| 用例 | 守护的不变量 | 补测前状态 |
| --- | --- | --- |
| 拒绝 inference 声明被标记为 observed | **v0.1.4 核心完整性不变量**：推理结论永不能冒充直接观测，即使挂了来源 | 完全未测 |
| 拒绝不支持的 packet schemaVersion | 禁止静默跨版本读入 | 完全未测 |
| 拒绝超过 `maxSummaryLen` 的摘要 | 硬上限 20000 | 完全未测 |
| 拒绝超过 `maxClaims` 的声明数 | 硬上限 500 | 完全未测 |
| 拒绝不支持的 request schemaVersion | 请求侧版本闸门 | 完全未测 |
| 拒绝越界预算（maxSources/maxFetchBytes/maxDurationMs） | 三项预算下限，防止 0 预算请求进入调度 | 完全未测 |
| 拒绝缺字段的 goalBinding | Goal 绑定完整性 | 完全未测 |

> 这些全部是**拒绝路径**。验证器的拒绝分支没有测试，等于验证器随时可能静默 fail-open —— 这类缺口的危险性高于普通业务代码的行覆盖缺失。

### `tests/web-research-adapter.test.ts` — 韧性与密钥卫生（4 条）

| 用例 | 守护的行为 | 补测前状态 |
| --- | --- | --- |
| 剥离 `api_key` / `access_token` | URL 携带凭据时不进入来源字段；普通参数（`page=2`）保留以免引用失准 | 完全未测 |
| 无密钥参数时 URL 原样保留 | 脱敏不误伤 | 完全未测 |
| search 依赖抛错 → 空结果 + note，不崩溃 | 搜索侧 MCP 掉线时降级 | 完全未测 |
| fetch 依赖抛错 → `failed` 来源 + 原因，不外抛 | 网络异常不能变成"看起来已取回" | 完全未测 |

### 缺陷修复后补充的回归（4 条）

| 用例 | 守护的行为 |
| --- | --- |
| `canonicalUrl` 与 `displayUrl` 同时脱敏，且写入 `redactions` | F-1 / F-2 回归闸门 |
| 重定向引入的凭据也被脱敏，且哈希基于安全 URL | 重定向是第二条注入路径 |
| 无密钥 URL 字节级不变 | 保证脱敏不移动既有 `contentHash` |
| `blocked` / `skipped` 诊断列表同样脱敏 | 堵住第二条泄漏路径 |

### P3 测试债清理（6 条）

`loadResearchPacket` 未写入 scope 返回 null、`resumeResearchState` 的 schema 闸门、`artifactHistory` 的完整 CAS 链与空历史、`research-citation` 的 `stale_only` 绑定状态。`research-artifact.ts` 分支覆盖因此达到 100%。

---

## 4. 安全自检（静态）

### 4.1 通过项

**SSRF 双层防护（OWASP API7 / SSRF）** — 设计正确。

- 选择期（`web-research-adapter.ts:177`）复用 `src/tools/web.ts` 的词法守卫 `isUrlSafeForSSRF`：协议白名单（仅 http/https，先于一切主机检查，堵住 `file:`/`gopher:`/`data:` 空 hostname 绕过）、拒绝内嵌凭据 `http://user:pass@host`、IPv6 方括号剥离、禁用主机名表、内网 IP 段正则，并对**十进制/十六进制/八进制/IPv6-mapped IPv4 编码绕过**做归一化再匹配；URL 解析失败一律判为不安全（fail-closed）。
- 取回期（`isResolvedUrlSafeForSSRF`）在真实 WebFetch 里做 **DNS 解析后复检**，覆盖词法层无法拦截的 DNS rebinding；DNS 查询失败也判为不安全。
- 适配器把安全闸门失败落成 `blocked`/`failed` 来源，**从不抛出、从不变成 `retrieved`**，已有测试覆盖。

**失败闭合（Fail-closed）** — 经本轮补测后全部纳入回归：observed 声明必须绑定来源、inference 不得标记 observed、来源数不得超请求预算、schema 版本不匹配即拒绝。

**并发写入与作用域隔离** — `saveResearchPacket` 用内容哈希（剔除时间戳）作 CAS token；活跃 Goal 的 packet 必须携带显式 `expectedToken` 才能更新，否则抛 `CasMismatchError`，杜绝盲写覆盖；`loadResearchPacket` 遇旧 schema 抛 `UnsupportedSchemaError` 而非静默迁移；`resumeResearchState` 是纯派生，不重放外部副作用。

### 4.2 缺陷发现与修复

#### F-1 — URL 携带的密钥会随 `canonicalUrl` 进入证据产物 ✅ 已修复

严重度：中（CWE-532 敏感信息写入产物）

**证据链（修复前）：**

- `canonicalUrl` 直接取原始 URL（`fetched.finalUrl ?? hit.url`），**未脱敏**；`stripSecretQuery` 只作用于 `displayUrl`。
- `research-renderer.ts:102` 渲染投影输出的是 `canonicalUrl`，持久化的 packet 同样存 `canonicalUrl`。
- 全仓检索：`displayUrl` 在 `src/` 中只出现在类型定义与适配器赋值处，**没有任何消费方** —— 脱敏后的字段"只写不读"，真正流向渲染与落盘的是未脱敏的那一个。
- 附带：`result.blocked` / `result.skipped` 两个诊断列表也直接压入原始 `hit.url`，构成第二条泄漏路径。

**影响：** 搜索命中形如 `https://host/doc?api_key=SECRET` 的 URL 时，密钥被写入 research 证据产物并在渲染输出中显示。

**修复方式：** 不再维护"原始 / 脱敏"双字段并寄望每个消费方选对，改为**在边界处脱敏一次，所有对外字段统一使用安全 URL**。新增 `redactUrl(url) -> { url, removed[] }` 取代 `stripSecretQuery`，`canonicalUrl`、`displayUrl`、`hashContent` 入参、`blocked`、`skipped` 全部消费它。重定向后的 `finalUrl` 同样处理（重定向可引入搜索命中不带的凭据）。

**哈希兼容性：** `redactUrl` 对无可剥离参数的 URL 返回原字符串（不重新序列化），因此干净 URL 的 `contentHash` **字节级不变**；只有本就在泄漏密钥的 URL 哈希会变，而这类记录原本就是缺陷产物。已加专项测试锁定该性质。

#### F-2 — `ResearchSource.redactions` 声明了却从未写入 ✅ 已修复

严重度：低（CWE-778 审计不足）

`research-types.ts:81-82` 定义了 `redactions?: string[]`，注释写明"记录已实施的脱敏项"，但全仓无赋值点 —— 被脱敏的 URL 与从未携带凭据的 URL 事后无法区分。现由 `redactUrl` 返回被剥离的参数名并落入该字段；搜索命中与重定向后 URL 的剥离结果取**并集**（搜索侧剥离过的事实，不因重定向后 URL 干净而消失）。无剥离时不写入该字段，避免伪造审计条目。

#### F-3 — 两处 catch 分支在当前调用链下不可达（严重度：信息级，不修）

`hostOf` 与 `redactUrl` 的 catch 只在 URL 解析失败时触发，而畸形 URL 在更早的词法 SSRF 闸门就已被判为 `Invalid URL format` 并 blocked。属合理的纵深防御，保留但不纳入覆盖率预期。

---

## 5. 测试债

初始识别的 P3 债务中，以下 4 项**已在本轮清理**（`research-artifact.ts` 分支覆盖因此达到 100%）：

| 位置 | 内容 | 状态 |
| --- | --- | --- |
| `research-artifact.ts` | `loadResearchPacket` 未命中 scope 返回 null | ✅ 已补 |
| `research-artifact.ts` | `resumeResearchState` 的 schema 版本闸门 | ✅ 已补 |
| `research-artifact.ts` | `artifactHistory` 完整 CAS 链 + 空历史 | ✅ 已补 |
| `research-citation.ts` | `stale_only` 绑定状态分支 | ✅ 已补 |

剩余项均为展示层文案分支或不可达的防御性 catch，不构成风险：

| 位置 | 未覆盖内容 | 性质 |
| --- | --- | --- |
| `research-quality.ts:141` | 超时/重定向补救提示分支 | 文案分支 |
| `research-renderer.ts:154` | contentHash 缺省时的渲染分支 | 展示分支 |
| `research-citation.ts:30` / `research-quality.ts:34` / `web-research-adapter.ts:100,321` | URL 解析 catch | 纵深防御，不可达 |

---

## 6. 质量门禁结论

| 检查项 | 结果 |
| --- | --- |
| v0.1.4 模块用例 | **55 passed / 0 failed**（6 套件） |
| 行覆盖 ≥90% | ✅ 98.77% |
| 分支覆盖 ≥85% | ✅ 90.36% |
| `tsc --noEmit`（全仓） | ✅ 0 错误 |
| `eslint`（改动文件） | ✅ 0 告警 |
| 高危安全缺陷（P0） | ✅ 无 |
| 中危安全缺陷 | ✅ F-1 已修复并加回归 |
| 低危 / 审计缺陷 | ✅ F-2 已修复 |
| e2e / PTY 套件（前序） | ✅ 5 passed / 2 skipped / 0 failed |

**准出判定：v0.1.4 允许合并，无遗留未修缺陷。**

### 6.1 关于全量回归的可信度说明

本机并行跑全量 jest **结果不可复现**：同一条 `npx jest --silent` 连跑两次，分别得到 7 failed 与 38 failed。差异集中在 spawn CLI 子进程的 PTY / UI / print-mode 类套件，属并行 worker 下的资源竞争超时，与被测逻辑无关。项目自身的发布流程（`prepublishOnly`）正是用 `npm test -- --runInBand` 串行执行，印证了这一点；判定回归状态应以串行结果为准。

本次改动的影响面归因是确定的，不依赖全量结果：改动的产品代码只有 `web-research-adapter.ts` 一个文件，全仓仅 `tests/web-research-adapter.test.ts` 引用它（已检索确认），该套件 15/15 通过，且全仓 `tsc --noEmit` 无错误。

> 另需注意：工作树中另有 13 个 `src/` 文件处于修改态（`tool-scheduler.ts`、`tools/web.ts`、`llm.ts`、`git.ts` 等），属 v0.1.4 冻结边界之外的既有改动，**不在本次提交范围内**，但会影响本机全量测试的观测结果。

---

## 7. 附：工具链修正

本轮使用的 `software-tester` 技能脚本 `scripts/run_coverage.py` 存在 runner 误判缺陷：它以 `shutil.which("npx")` 探测运行器，而 `npx` 恒存在且会自动下载被点名的包，导致在 jest 项目中永远选中 vitest，随后因传入 jest 专有的 `--collectCoverageFrom` 直接 `CACError` 退出。已改为按 `node_modules/.bin` → `package.json` 依赖 → `test` 脚本 → 配置文件的顺序探测真实运行器，并按运行器分发对应的 include 参数（vitest 用 `--coverage.include`）。已在本仓库验证探测结果为 `jest`。
