# Orion Code Documentation

## Directory ownership

- [`architecture/`](architecture/repository-layout.md) — current component ownership, dependency
  direction, and product/runtime contracts.
- [`goals/`](goals/orion-code-项目级目标.md) — durable product goals and Goal evidence/recovery
  guidance.
- [`plan/`](plan/v0.2.0-dsh-harness-redesign-plan.md) — active execution plans, current release
  gates, and future roadmap.
- [`archive/releases/v0.1.x/`](archive/releases/v0.1.x/README.md) — immutable historical plans,
  audits, freeze boundaries, and release receipts.
- `test/` — maintained manual test references that do not belong in the Jest suite.
- [`orion.example.json`](orion.example.json) — current providers+models configuration example.
- [`zed-acp-integration.md`](zed-acp-integration.md) — Zed ACP integration guidance.

The repository release history is canonical in [`CHANGELOG.md`](../CHANGELOG.md). Active plans may
link into the archive, but historical evidence is not moved back into `plan/` merely to satisfy an
old relative path.

## v0.2.0 release set

- [DSH + Codex-informed Lean Harness redesign](plan/v0.2.0-dsh-harness-redesign-plan.md)
- [Release checklist](plan/v0.2.0-release-checklist.md)
- [Migration and rollback](migration/v0.1.9-to-v0.2.0.md)
- [DSH architecture reference](architecture/dsh/DeepSeek-Harness与Cordis插件机制科普.md)
- [Durable product goal](goals/orion-code-项目级目标.md)
