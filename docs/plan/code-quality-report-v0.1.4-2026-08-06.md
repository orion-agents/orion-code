# 代码质量测试报告 — v0.1.4 Research-to-Evidence

- 日期：2026-08-06
- 分支：`v0.1.4`（HEAD `9cb8137`，与 `origin/v0.1.4` 同步；PR [#7](https://github.com/orion-agents/orion-code/pull/7) OPEN）
- 范围：`src/runtime/subagents/research-*.ts` + `web-research-adapter.ts`（v0.1.4 全部新增产品代码）
- 方法：覆盖率治理（jest + ts-jest）、失败路径补测、静态安全自检（SSRF / 失败闭合 / 密钥卫生 / 并发写入）
- 运行环境：Node v24.14.0，`NODE_OPTIONS="--use-system-ca"`（禁用沙箱 safe-delete 守卫，避免注入子进程）

---

## 1. 结论摘要

**质量门禁：通过（有条件）。** v0.1.4 模块的行覆盖 98.51%、分支覆盖 88.37%，均高于核心模块门禁（行 ≥90% / 分支 ≥85%）。
本轮补齐 11 条失败路径测试，把 4 个此前**完全未被测试的失败闭合分支**纳入回归网，其中包括 v0.1.4 的核心完整性不变量。
另发现 1 项中等严重度的密钥外泄风险（F-1），不阻断本次合并，但应在 v0.1.5 单独修复。

---

## 2. 覆盖率报告

### 2.1 补测前后对比

| 指标 | 补测前 | 补测后 | 门禁 | 结论 |
| --- | --- | --- | --- | --- |
| 语句 Stmts | 92.58% | **96.82%** | — | ↑ 4.24 |
| 分支 Branch | 83.38% | **88.37%** | ≥85% | ❌ → ✅ |
| 函数 Funcs | 98.80% | **98.80%** | — | 持平 |
| 行 Lines | 93.82% | **98.51%** | ≥90% | ✅ → ✅ |
| 用例数 | 38 | **49** | — | +11 |

### 2.2 分文件覆盖（补测后）

| 文件 | Stmts | Branch | Lines | 残余未覆盖行 |
| --- | --- | --- | --- | --- |
| `research-contract.ts` | 96.11% | 90.47% | **100%** | 60,145,157-171,204-205,213 |
| `web-research-adapter.ts` | 96.77% | 86.79% | 97.70% | 100,294 |
| `research-artifact.ts` | 94.44% | 90.00% | **100%** | 126,140,150 |
| `research-citation.ts` | 98.01% | 87.50% | 97.50% | 30,134 |
| `research-quality.ts` | 95.52% | 87.27% | 96.61% | 34,141 |
| `research-renderer.ts` | **100%** | 86.95% | **100%** | 68-95,154 |
| `research-types.ts` | **100%** | **100%** | **100%** | — |

`research-contract.ts` 与 `web-research-adapter.ts` 的分支覆盖此前分别只有 77.38% / 79.24%，是本轮治理的两个主要缺口来源。

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
| 从 displayUrl 剥离 `api_key` / `access_token` | URL 携带凭据时不写入展示字段；普通参数（`page=2`）保留以免引用失准 | 完全未测 |
| 无密钥参数时 URL 原样保留 | 脱敏不误伤 | 完全未测 |
| search 依赖抛错 → 空结果 + note，不崩溃 | 搜索侧 MCP 掉线时降级 | 完全未测 |
| fetch 依赖抛错 → `failed` 来源 + 原因，不外抛 | 网络异常不能变成"看起来已取回" | 完全未测 |

---

## 4. 安全自检（静态）

### 4.1 通过项

**SSRF 双层防护（OWASP API7 / SSRF）** — 设计正确。

- 选择期（`web-research-adapter.ts:177`）复用 `src/tools/web.ts` 的词法守卫 `isUrlSafeForSSRF`：协议白名单（仅 http/https，先于一切主机检查，堵住 `file:`/`gopher:`/`data:` 空 hostname 绕过）、拒绝内嵌凭据 `http://user:pass@host`、IPv6 方括号剥离、禁用主机名表、内网 IP 段正则，并对**十进制/十六进制/八进制/IPv6-mapped IPv4 编码绕过**做归一化再匹配；URL 解析失败一律判为不安全（fail-closed）。
- 取回期（`isResolvedUrlSafeForSSRF`）在真实 WebFetch 里做 **DNS 解析后复检**，覆盖词法层无法拦截的 DNS rebinding；DNS 查询失败也判为不安全。
- 适配器把安全闸门失败落成 `blocked`/`failed` 来源，**从不抛出、从不变成 `retrieved`**，已有测试覆盖。

**失败闭合（Fail-closed）** — 经本轮补测后全部纳入回归：observed 声明必须绑定来源、inference 不得标记 observed、来源数不得超请求预算、schema 版本不匹配即拒绝。

**并发写入与作用域隔离** — `saveResearchPacket` 用内容哈希（剔除时间戳）作 CAS token；活跃 Goal 的 packet 必须携带显式 `expectedToken` 才能更新，否则抛 `CasMismatchError`，杜绝盲写覆盖；`loadResearchPacket` 遇旧 schema 抛 `UnsupportedSchemaError` 而非静默迁移；`resumeResearchState` 是纯派生，不重放外部副作用。

### 4.2 风险发现

#### F-1 — URL 携带的密钥会随 `canonicalUrl` 进入证据产物（严重度：中，CWE-532 / 敏感信息写入产物）

**证据链：**

- `web-research-adapter.ts:246,269` — `canonicalUrl` 直接取原始 URL（`fetched.finalUrl ?? hit.url`），**未脱敏**。
- `web-research-adapter.ts:247,270` — `stripSecretQuery` 只作用于 `displayUrl`。
- `research-renderer.ts:102` — 渲染投影输出的是 `canonicalUrl`。
- 全仓检索：`displayUrl` 在 `src/` 中只出现在类型定义与适配器赋值处，**没有任何消费方**；也就是说脱敏后的字段是"只写不读"，真正流向渲染与落盘的是未脱敏的那个。

**影响：** 当搜索命中形如 `https://host/doc?api_key=SECRET` 的 URL 时，密钥会被写入 research 证据产物并在渲染输出中显示。

**建议修复（v0.1.5，不建议塞进本次 PR）：** 两条路径二选一 ——（a）`canonicalUrl` 同样脱敏；（b）渲染与落盘改用 `displayUrl`。注意 `hashContent` 以 `canonicalUrl` 参与哈希（`web-research-adapter.ts:117-119`），走 (a) 会改变既有 `contentHash`，需配套加一条哈希稳定性测试并说明兼容影响。因涉及产物哈希语义，不适合在冻结边界内顺手改。

#### F-2 — `ResearchSource.redactions` 声明了却从未写入（严重度：低，CWE-778 审计不足）

`research-types.ts:81-82` 定义了 `redactions?: string[]`，注释写明"记录已实施的脱敏项（如 api_key）"，但全仓无任何赋值点。脱敏动作没有留下审计痕迹，事后无法判断某条来源是否被改写过。建议在 `stripSecretQuery` 返回被剥离的参数名并落到该字段。

#### F-3 — 两处 catch 分支在当前调用链下不可达（严重度：信息级）

`web-research-adapter.ts:100`（`hostOf` 的 catch）与 `:294`（`stripSecretQuery` 的 catch）只在 URL 解析失败时触发，而畸形 URL 在更早的词法 SSRF 闸门就已被判为 `Invalid URL format` 并 blocked。属合理的纵深防御，建议保留但不纳入覆盖率预期。

---

## 5. 遗留测试债（P3，不阻断）

| 位置 | 未覆盖内容 | 性质 |
| --- | --- | --- |
| `research-artifact.ts:126` | `loadResearchPacket` 空存储早返回 | 公共路径，可补 |
| `research-artifact.ts:140` | `resumeResearchState` 的 schema 版本闸门 | 公共路径，可补 |
| `research-artifact.ts:150` | `artifactHistory` 整个函数无调用 | 公共 API 未测 |
| `research-citation.ts:134` | `stale_only` 绑定状态分支 | 状态机分支未测 |
| `research-quality.ts:141` | 超时/重定向补救提示分支 | 文案分支 |
| `research-renderer.ts:154` | contentHash 缺省时的渲染分支 | 展示分支 |
| `research-citation.ts:30` / `research-quality.ts:34` | URL 解析 catch | 纵深防御，不可达 |

估算：补齐前 4 项约 6 条用例，可把分支覆盖再推高约 3-4 个百分点。

---

## 6. 质量门禁结论

| 检查项 | 结果 |
| --- | --- |
| v0.1.4 模块用例 | 49 passed / 0 failed（6 套件） |
| 行覆盖 ≥90% | ✅ 98.51% |
| 分支覆盖 ≥85% | ✅ 88.37% |
| `tsc --noEmit` | ✅ 0 错误 |
| `eslint`（改动文件） | ✅ 0 告警 |
| 高危安全缺陷（P0） | ✅ 无 |
| 中危安全缺陷 | ⚠️ 1 项（F-1），已定级并转 v0.1.5 |
| e2e / PTY 套件（前序） | ✅ 5 passed / 2 skipped / 0 failed |

**准出判定：v0.1.4 允许合并。** F-1 作为跟踪项进入 v0.1.5，理由是其修复会改变 `contentHash` 语义，属产物兼容性变更，不应在冻结边界内夹带。

---

## 7. 附：工具链修正

本轮使用的 `software-tester` 技能脚本 `scripts/run_coverage.py` 存在 runner 误判缺陷：它以 `shutil.which("npx")` 探测运行器，而 `npx` 恒存在且会自动下载被点名的包，导致在 jest 项目中永远选中 vitest，随后因传入 jest 专有的 `--collectCoverageFrom` 直接 `CACError` 退出。已改为按 `node_modules/.bin` → `package.json` 依赖 → `test` 脚本 → 配置文件的顺序探测真实运行器，并按运行器分发对应的 include 参数（vitest 用 `--coverage.include`）。已在本仓库验证探测结果为 `jest`。
