# Orion Code Documentation

## Directory Structure

```
docs/
├── readme.md                  # This file
├── orion.example.json     # Example configuration
├── general-configuration-reference.md  # Configuration reference
├── AGENT.md                   # Agent instructions
│
├── product-plan/              # Product planning & strategy
│   ├── 00-索引与执行摘要.md
│   ├── 01-现状能力分析.md
│   ├── 02-竞品调研.md
│   ├── 03-新版本功能规划.md
│   ├── 04-技术选型论证.md
│   └── 05-开发路线图.md
│
├── targets/                   # Vision & target state docs
│   ├── general-coding-agent-vision-reference.md
│   ├── general-ui-runtime-boundary-reference.md
│   ├── general-agent-loop-final-form-reference.md
│   └── general-ui-ultimate-experience-reference.md
│
├── codex/                     # All version-specific plans, audits, reports (v0.1.23 - v0.2.27)
│   ├── general-*.md           # Cross-version design docs
│   └── v0.2.*.md              # Per-version plans, audits, bug reports, changelogs
│
├── test/                      # Test plans & reports
│   ├── general-*.md           # General testing strategy
│   ├── v0.*.md                # Per-version test plans/reports
│   ├── 10-test-prompts-*.md   # Test prompt suites
│   ├── logs/                  # Test execution logs
│   └── runs/                  # Test run artifacts
│
└── old/                       # Archived — pre-v0.2 changelogs & design docs
    ├── general-*.md           # Early architecture & design docs
    ├── v0.1.*.md              # v0.1.x changelogs (v0.1.1 - v0.1.27)
    └── issues/                # Historical issue records
```

## Directory Purpose

| Directory | Purpose | Status |
|-----------|---------|--------|
| `product-plan/` | Product strategy, competitive analysis, roadmap | Active |
| `targets/` | Long-term vision and target state references | Active |
| `codex/` | All version plans, audits, reports, bug analyses, changelogs | Active |
| `test/` | Test plans, reports, prompt suites, logs | Active |
| `old/` | Pre-v0.2 changelogs and early architecture/design docs | Archived |

## Naming Convention

```
{scope}-{topic}-{type}.md
```

- **scope**: `general` (cross-version) or `v0.2.X` (version-specific)
- **topic**: short kebab-case description
- **type**: `plan`, `report`, `audit`, `reference`, `changelog`, `bug-report`, `bug-analysis`, `fix-plan`, `fix-assessment`, `status-report`, `quality-review`

Examples:
- `v0.2.26-multi-model-configuration-plan.md` — version-specific design plan
- `general-mcp-integration-design.md` — cross-version design reference
- `v0.2.24-v0.2.26-integration-audit.md` — multi-version audit
- `v0.2.21-bug-analysis.md` — version-specific bug analysis
- `v0.2.20-quality-review.md` — version quality review

## Migration History

On 2026-07-26, four scattered directories were collapsed into `codex/`:

| Source | Files moved |
|--------|-------------|
| `docs/claude/` → `codex/` | 5 files (v0.2.4–v0.2.7 early design docs) |
| `docs/agy/` → `codex/` | 2 files (technical upgrade proposal + supplements) |
| `docs/workBuddy/` → `codex/` | 7 files (bug reports, fix plans, assessments) |
| `docs/version/` → `codex/` + `old/` | 2 files to codex, 1 to old |

Pre-v0.2 codex files also moved to `old/` for archival.

## Adding New Docs

1. Determine if the doc is **version-specific** or **cross-version**
2. Pick the right directory: `codex/` for plans/audits/reports, `test/` for test docs
3. Use the naming convention
4. `old/` should not receive new files — it's frozen