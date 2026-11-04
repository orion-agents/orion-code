# v0.1 迭代计划：项目级 Skills 与 Orion Code 自评测回路（skills-rsi-eval）

分支：`codex/skills-eval-rsi`（基线 `refs/remotes/origin/main` @ `86af06a` = tag `v0.3.50`）。
性质：含产品代码 delta（`src/` + `tests/`）与文档证据，**不占用版本号、不打 tag、不发布**（质量条款 C：本 PR 由人工评审决定合并时机）。

## 1. 背景与问题

1. 项目级 skills 只能放在 `.orion-code/skills/` 才被运行时发现；团队/编辑器惯用的
   `.agents/skills/` 目录**不在任何搜索根上**，写进去就是死文档。
2. 仓库有 T1（离线确定性 harness 门禁）与一整套 Web E2E 收据体系，但**缺少一个能在无
   API key 环境下驱动"真对话"的评测入口**：`-p --output-format json` 是真实生产入口，
   却没有可复用的评测编排；付费标注集（20 样本）`HumanReview` 仍是 `PENDING`。
3. 因此"orion-code 现在到底什么水位"无法用可复核的证据回答，只能靠叙述。

## 2. 任务分解

| # | 任务 | 涉及文件 | 验收标准 |
| --- | --- | --- | --- |
| S1 | 把 `.agents/skills` 注册为 project 搜索根 | `src/runtime/skills/filesystem-skill-provider.ts`、`src/commands/context-tool-command-handlers.ts` | ①`createFilesystemSkillRootsV1` 返回两个 `project` 根；②运行时从仓库根 `list()` 能发现 `.agents/skills` 下的描述符且 `definitionReads === 0`（正文仍懒加载）；③同名跨根冲突保持确定性（走既有 same-scope tie-break，不改优先级表） |
| S2 | 评测 skill `orion-self-eval` | `.agents/skills/orion-self-eval/{SKILL.md,mock-openai-server.mjs,conversation-eval.mjs,eval-tasks.json}` | 三层水位定义清晰；T2 驱动器能在无 key 下跑真对话并产出带 digest 的 receipt；检查词表覆盖假完成/工具失败/会话落盘/预算熔断/写副作用 |
| S3 | RSI skill `orion-rsi-loop` | `.agents/skills/orion-rsi-loop/SKILL.md` | 给出候选改进项的排序规则与"禁止给自己降门槛"的护栏；把每轮必须留下可复测仪器写成硬约束 |
| S4 | 真实评测对话 + 水位判定 | `docs/plan/evidence/skills-rsi-2026-11-04/*` | T1/T2 各自给出 decision/digest 与逐检查 actual；T3 明确记 `not_run` 并给出原因，不得用 fixture 顶替 |
| S5 | 清偿主干发布状态欠账 | `CHANGELOG.md`、`README.md`、`README.zh-CN.md` | `release:check` 的 changelog / readme 两项由红转绿（v0.3.50 已 tag+已发布但文档仍写 candidate） |

## 3. 本地验证

- `npx tsc --noEmit`：0 error
- `npm run lint`：0 error
- `npx jest tests/filesystem-skill-provider.test.ts tests/lazy-skill-runtime.test.ts tests/doctor.test.ts tests/migration.test.ts`：41 passed
- 运行时实证：`createFilesystemSkillRootsV1({cwd})` → `project roots: .orion-code/skills | .agents/skills`；`list()` → `complete: true`，project 描述符 `orion-rsi-loop`、`orion-self-eval`，`definitionReads: 0`
- `npm run release:check -- --skip-tests`：见 §5（转绿项与残留项均如实记录）

## 4. 不在本 PR 范围

- 不修改任何门禁阈值；不把 `.agents/skills` 提升为高于 `.orion-code/skills` 的优先级。
- 不做版本 bump / tag / publish / Release（无发布意图）。
- 不动 T3 标注集与 `live-task-executor` 的付费执行路径。

## 5. 交付时要一起评审的结构性发现（见水位报告 F-1…F-5）

本 PR 的 `release-gate` 作业预计 **NO-GO**，原因不是代码缺陷而是门禁与流程条款冲突：
`release-ref` 要求"HEAD 即当前版本的 tag 提交"，于是**任何从已打 tag 的主干切出、又不占版本号的分支必然红**。
这与质量条款 C（docs-only 周期不占版本号）直接互斥。两个处置方案需要人工决定，本 PR 不擅自放宽门禁：
- (a) `release-check` 增加"非发布分支"模式：当 HEAD 超前于最新 tag 且分支名不声明版本时，把 post-release drift 记为信息而非阻塞；
- (b) 主干在两次发布之间保留一个 `UNRELEASED` 段落，发布分支才把版本落到顶层 section。
