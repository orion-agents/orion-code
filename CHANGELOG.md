# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Delivery status legend

This project distinguishes three delivery states. **Never present unreleased work as released.**

| State             | Meaning                                      | Criterion                                  |
| ----------------- | -------------------------------------------- | ------------------------------------------ |
| **Published**     | Tagged source is installable from npm        | git tag exists **and** `npm publish` done  |
| **npm-published** | Registry version exists without full release | exact npm version, but tag/release may lag |
| **Merged**        | In the default branch, not yet installable   | merged, **no** tag / not published         |
| **Candidate**     | Reviewable source, no release promise        | committed PR branch or owned worktree      |

Evidence labels follow `docs/archive/releases/v0.1.x/targets-v0.1.3-v0.1.3-2.md`:
`met` / `partial` / `unmet` / `not_run` — where `not_run` means "blocked by environment",
which is **not** a pass.

## [Unreleased]

## [0.3.40] — 2026-10-26

> **Status: published.** Open. Receipt backfill & delivery-status audit slice
> (PR4 automatable portion of the v0.3.27 review loop, plan:
> `docs/plan/v0.3.40-plan.md`): the 0.3.39 entry is corrected to `published`
> (with the real npm publish timestamp and the GitHub Release link), a new
> three-version delivery-status audit (0.3.37–0.3.39: tag + registry +
> dist-tag latest) is recorded in `docs/plan/evidence/v0.3.40/status-audit.md`
> together with the v0.3.39 release facts (PR #296, squash merge `5a51932`,
> tag `v0.3.39`, npm registry `latest=0.3.39`, GitHub Release v0.3.39).
> No production code changes. The human-labeled paid quality benchmark and
> real Host + Chrome full-chain E2E remain honestly `not_run` (no model
> credentials in the automation environment). Released as
> `@orion-agents/orion-code@0.3.40` from `refs/tags/v0.3.40`, merged to `main`
> as `ef45214` (#297). npm registry `latest=0.3.40` published
> `2026-10-26T18:21:55.395Z`. GitHub Release:
> https://github.com/orion-agents/orion-code/releases/tag/v0.3.40

### Changed

- CHANGELOG: corrected the 0.3.39 delivery status from `candidate` to
  `published` (tagged `v0.3.39`, npm registry `latest`, npm publish timestamp
  and GitHub Release link backfilled).
- docs: added `docs/plan/evidence/v0.3.40/status-audit.md` — a three-version
  (0.3.37–0.3.39) delivery-status audit cross-checking git tags, registry
  versions and the `latest` dist-tag, plus the v0.3.39 release facts
  (PR #296, merge `5a51932`, tag `v0.3.39`, registry `latest=0.3.39`).
- README / README.zh-CN: header summary and install pin updated to 0.3.40.

## [0.3.41] — 2026-10-27

> **Status: published.** Open. Receipt backfill & delivery-status audit slice
> (PR4 automatable portion of the v0.3.27 review loop, plan:
> `docs/plan/v0.3.41-plan.md`): the 0.3.40 entry is corrected to `published`
> (with the real npm publish timestamp and the GitHub Release link), a new
> three-version delivery-status audit (0.3.38–0.3.40: tag + registry +
> dist-tag latest) is recorded in `docs/plan/evidence/v0.3.41/status-audit.md`
> together with the v0.3.40 release facts (PR #297, squash merge `ef45214`,
> tag `v0.3.40`, npm registry `latest=0.3.40`, GitHub Release v0.3.40).
> No production code changes. The human-labeled paid quality benchmark and
> real Host + Chrome full-chain E2E remain honestly `not_run` (no model
> credentials in the automation environment). Released as
> `@orion-agents/orion-code@0.3.41` from `refs/tags/v0.3.41`, merged to `main`
> as `2abc8e3` (#298). npm registry `latest=0.3.41` published
> `2026-10-27T00:30:30.123Z`. GitHub Release:
> https://github.com/orion-agents/orion-code/releases/tag/v0.3.41

### Changed

- CHANGELOG: corrected the 0.3.40 delivery status from `candidate` to
  `published` (tagged `v0.3.40`, npm registry `latest`, npm publish timestamp
  and GitHub Release link backfilled).
- docs: added `docs/plan/evidence/v0.3.41/status-audit.md` — a three-version
  (0.3.38–0.3.40) delivery-status audit cross-checking git tags, registry
  versions and the `latest` dist-tag, plus the v0.3.40 release facts
  (PR #297, merge `ef45214`, tag `v0.3.40`, registry `latest=0.3.40`).
- README / README.zh-CN: header summary and install pin updated to 0.3.41.

## [0.3.42] — 2026-10-27

> **Status: published.** Open. Receipt backfill & delivery-status audit slice
> (PR4 automatable portion of the v0.3.27 review loop, plan:
> `docs/plan/v0.3.42-plan.md`): the 0.3.41 entry is corrected to `published`
> (with the real npm publish timestamp and the GitHub Release link), a new
> three-version delivery-status audit (0.3.39–0.3.41: tag + registry +
> dist-tag latest) is recorded in `docs/plan/evidence/v0.3.42/status-audit.md`
> together with the v0.3.41 release facts (PR #298, squash merge `2abc8e3`,
> tag `v0.3.41`, npm registry `latest=0.3.41`, GitHub Release v0.3.41).
> No production code changes. The human-labeled paid quality benchmark and
> real Host + Chrome full-chain E2E remain honestly `not_run` (no model
> credentials in the automation environment). Released as
> `@orion-agents/orion-code@0.3.42` from `refs/tags/v0.3.42`, merged to `main`
> as `50628a7` (#299). npm registry `latest=0.3.42` published
> `2026-10-27T06:27:35.184Z`. GitHub Release:
> https://github.com/orion-agents/orion-code/releases/tag/v0.3.42

### Changed

- CHANGELOG: corrected the 0.3.41 delivery status from `candidate` to
  `published` (tagged `v0.3.41`, npm registry `latest`, npm publish timestamp
  and GitHub Release link backfilled).
- docs: added `docs/plan/evidence/v0.3.42/status-audit.md` — a three-version
  (0.3.39–0.3.41) delivery-status audit cross-checking git tags, registry
  versions and the `latest` dist-tag, plus the v0.3.41 release facts
  (PR #298, merge `2abc8e3`, tag `v0.3.41`, registry `latest=0.3.41`).
- README / README.zh-CN: header summary and install pin updated to 0.3.42.

## [0.3.43] — 2026-10-27

> **Status: published.** Open. Receipt backfill & delivery-status audit slice
> (PR4 automatable portion of the v0.3.27 review loop, plan:
> `docs/plan/v0.3.43-plan.md`): the 0.3.42 entry is corrected to `published`
> (with the real npm publish timestamp and the GitHub Release link), a new
> three-version delivery-status audit (0.3.40–0.3.42: tag + registry +
> dist-tag latest) is recorded in `docs/plan/evidence/v0.3.43/status-audit.md`
> together with the v0.3.42 release facts (PR #299, squash merge `50628a7`,
> tag `v0.3.42`, npm registry `latest=0.3.42`, GitHub Release v0.3.42).
> No production code changes. The human-labeled paid quality benchmark and
> real Host + Chrome full-chain E2E remain honestly `not_run` (no model
> credentials in the automation environment). Released as
> `@orion-agents/orion-code@0.3.43` from `refs/tags/v0.3.43`, merged to `main`
> as `fa03965` (#300). npm registry `latest=0.3.43` published
> `2026-10-27T19:02:04.278Z`. GitHub Release:
> https://github.com/orion-agents/orion-code/releases/tag/v0.3.43

### Changed

- CHANGELOG: corrected the 0.3.42 delivery status from `candidate` to
  `published` (tagged `v0.3.42`, npm registry `latest`, npm publish timestamp
  and GitHub Release link backfilled).
- docs: added `docs/plan/evidence/v0.3.43/status-audit.md` — a three-version
  (0.3.40–0.3.42) delivery-status audit cross-checking git tags, registry
  versions and the `latest` dist-tag, plus the v0.3.42 release facts
  (PR #299, merge `50628a7`, tag `v0.3.42`, registry `latest=0.3.42`).
- README / README.zh-CN: header summary and install pin updated to 0.3.43.

## [0.3.45] — 2026-10-28

> **Status: published.** Open. Receipt backfill & delivery-status audit slice
> (PR4 automatable portion of the v0.3.27 review loop, plan:
> `docs/plan/v0.3.45-plan.md`): the 0.3.44 entry is corrected to `published`
> (with the real npm publish timestamp and the GitHub Release link), a new
> three-version delivery-status audit (0.3.42–0.3.44: tag + registry +
> dist-tag latest) is recorded in `docs/plan/evidence/v0.3.45/status-audit.md`
> together with the v0.3.44 release facts (PR #301, squash merge `95d5aa3`,
> tag `v0.3.44`, npm registry `latest=0.3.44`, GitHub Release v0.3.44).
> No production code changes. The human-labeled paid quality benchmark and
> real Host + Chrome full-chain E2E remain honestly `not_run` (no model
> credentials in the automation environment). Released as
> `@orion-agents/orion-code@0.3.45` from `refs/tags/v0.3.45`, merged to `main`
> as `4216ab0` (#302). npm registry `latest=0.3.45` published
> `2026-10-28T23:12:19.822Z`. GitHub Release:
> https://github.com/orion-agents/orion-code/releases/tag/v0.3.45

### Changed

- CHANGELOG: corrected the 0.3.44 delivery status from `candidate` to
  `published` (tagged `v0.3.44`, npm registry `latest`, npm publish timestamp
  and GitHub Release link backfilled).
- docs: added `docs/plan/evidence/v0.3.45/status-audit.md` — a three-version
  (0.3.42–0.3.44) delivery-status audit cross-checking git tags, registry
  versions and the `latest` dist-tag, plus the v0.3.44 release facts
  (PR #301, merge `95d5aa3`, tag `v0.3.44`, registry `latest=0.3.44`).
- README / README.zh-CN: header summary and install pin updated to 0.3.45.

## [0.3.46] — 2026-10-29

> **Status: published.** Open. Receipt backfill & delivery-status audit slice
> (PR4 automatable portion of the v0.3.27 review loop, plan:
> `docs/plan/v0.3.46-plan.md`): the 0.3.45 entry is corrected to `published`
> (with the real npm publish timestamp and the GitHub Release link), a new
> three-version delivery-status audit (0.3.43–0.3.45: tag + registry +
> dist-tag latest) is recorded in `docs/plan/evidence/v0.3.46/status-audit.md`
> together with the v0.3.45 release facts (PR #302, squash merge `4216ab0`,
> tag `v0.3.45`, npm registry `latest=0.3.45`, GitHub Release v0.3.45).
> No production code changes. The human-labeled paid quality benchmark and
> real Host + Chrome full-chain E2E remain honestly `not_run` (no model
> credentials in the automation environment). Released as
> `@orion-agents/orion-code@0.3.46` from `refs/tags/v0.3.46`, merged to `main`
> as `2bccc47` (#303). npm registry `latest=0.3.46` published
> `2026-10-29T10:25:59.871Z`. GitHub Release:
> https://github.com/orion-agents/orion-code/releases/tag/v0.3.46

### Changed

- CHANGELOG: corrected the 0.3.45 delivery status from `candidate` to
  `published` (tagged `v0.3.45`, npm registry `latest`, npm publish timestamp
  and GitHub Release link backfilled).
- docs: added `docs/plan/evidence/v0.3.46/status-audit.md` — a three-version
  (0.3.43–0.3.45) delivery-status audit cross-checking git tags, registry
  versions and the `latest` dist-tag, plus the v0.3.45 release facts
  (PR #302, merge `4216ab0`, tag `v0.3.45`, registry `latest=0.3.45`).
- README / README.zh-CN: header summary and install pin updated to 0.3.46.

## [0.3.47] — 2026-10-29

> **Status: candidate.** Open. Receipt backfill & delivery-status audit slice
> (PR4 automatable portion of the v0.3.27 review loop, plan:
> `docs/plan/v0.3.47-plan.md`): the 0.3.46 entry is corrected to `published`
> (with the real npm publish timestamp and the GitHub Release link), a new
> three-version delivery-status audit (0.3.44–0.3.46: tag + registry +
> dist-tag latest) is recorded in `docs/plan/evidence/v0.3.47/status-audit.md`
> together with the v0.3.46 release facts (PR #303, squash merge `2bccc47`,
> tag `v0.3.46`, npm registry `latest=0.3.46`, GitHub Release v0.3.46).
> No production code changes. The human-labeled paid quality benchmark and
> real Host + Chrome full-chain E2E remain honestly `not_run` (no model
> credentials in the automation environment). Not merged, tagged or published.

### Changed

- CHANGELOG: corrected the 0.3.46 delivery status from `candidate` to
  `published` (tagged `v0.3.46`, npm registry `latest`, npm publish timestamp
  and GitHub Release link backfilled).
- docs: added `docs/plan/evidence/v0.3.47/status-audit.md` — a three-version
  (0.3.44–0.3.46) delivery-status audit cross-checking git tags, registry
  versions and the `latest` dist-tag, plus the v0.3.46 release facts
  (PR #303, merge `2bccc47`, tag `v0.3.46`, registry `latest=0.3.46`).
- README / README.zh-CN: header summary and install pin updated to 0.3.47.

## [0.3.44] — 2026-10-28

> **Status: published.** Open. Receipt backfill & delivery-status audit slice
> (PR4 automatable portion of the v0.3.27 review loop, plan:
> `docs/plan/v0.3.44-plan.md`): the 0.3.43 entry is corrected to `published`
> (with the real npm publish timestamp and the GitHub Release link), a new
> three-version delivery-status audit (0.3.41–0.3.43: tag + registry +
> dist-tag latest) is recorded in `docs/plan/evidence/v0.3.44/status-audit.md`
> together with the v0.3.43 release facts (PR #300, squash merge `fa03965`,
> tag `v0.3.43`, npm registry `latest=0.3.43`, GitHub Release v0.3.43).
> No production code changes. The human-labeled paid quality benchmark and
> real Host + Chrome full-chain E2E remain honestly `not_run` (no model
> credentials in the automation environment). Released as
> `@orion-agents/orion-code@0.3.44` from `refs/tags/v0.3.44`, merged to `main`
> as `95d5aa3` (#301). npm registry `latest=0.3.44` published
> `2026-10-28T06:08:32.080Z`. GitHub Release:
> https://github.com/orion-agents/orion-code/releases/tag/v0.3.44

### Changed

- CHANGELOG: corrected the 0.3.43 delivery status from `candidate` to
  `published` (tagged `v0.3.43`, npm registry `latest`, npm publish timestamp
  and GitHub Release link backfilled).
- docs: added `docs/plan/evidence/v0.3.44/status-audit.md` — a three-version
  (0.3.41–0.3.43) delivery-status audit cross-checking git tags, registry
  versions and the `latest` dist-tag, plus the v0.3.43 release facts
  (PR #300, merge `fa03965`, tag `v0.3.43`, registry `latest=0.3.43`).
- README / README.zh-CN: header summary and install pin updated to 0.3.44.

## [0.3.39] — 2026-10-26

> **Status: published.** Open. Receipt backfill & delivery-status audit slice
> (PR4 automatable portion of the v0.3.27 review loop, plan:
> `docs/plan/v0.3.39-plan.md`): the 0.3.38 entry is corrected to `published`
> (with the real npm publish timestamp and the GitHub Release link), a new
> three-version delivery-status audit (0.3.36–0.3.38: tag + registry +
> dist-tag latest) is recorded in `docs/plan/evidence/v0.3.39/status-audit.md`
> together with the v0.3.38 release facts (PR #295, squash merge `4cb727e`,
> tag `v0.3.38`, npm registry `latest=0.3.38`, GitHub Release v0.3.38).
> No production code changes. The human-labeled paid quality benchmark and
> real Host + Chrome full-chain E2E remain honestly `not_run` (no model
> credentials in the automation environment). Released as `@orion-agents/orion-code@0.3.39` from `refs/tags/v0.3.39`, merged to `main` as `5a51932` (#296). npm registry `latest=0.3.39` published `2026-10-26T03:17:19.937Z`. GitHub Release: https://github.com/orion-agents/orion-code/releases/tag/v0.3.39

### Changed

- CHANGELOG: corrected the 0.3.38 delivery status from `candidate` to
  `published` (tagged `v0.3.38`, npm registry `latest`, npm publish timestamp
  and GitHub Release link backfilled).
- docs: added `docs/plan/evidence/v0.3.39/status-audit.md` — a three-version
  (0.3.36–0.3.38) delivery-status audit cross-checking git tags, registry
  versions and the `latest` dist-tag, plus the v0.3.38 release facts
  (PR #295, merge `4cb727e`, tag `v0.3.38`, registry `latest=0.3.38`).
- README / README.zh-CN: header summary and install pin updated to 0.3.39.

## [0.3.38] — 2026-10-25

> **Status: published.** Open. Receipt backfill & delivery-status audit slice
> (PR4 automatable portion of the v0.3.27 review loop, plan:
> `docs/plan/v0.3.38-plan.md`): the 0.3.37 entry is corrected to `published`
> (with the real npm publish timestamp and the GitHub Release link), a new
> three-version delivery-status audit (0.3.35–0.3.37: tag + registry +
> dist-tag latest) is recorded in `docs/plan/evidence/v0.3.38/status-audit.md`
> together with the v0.3.37 release facts (PR #293, squash merge `8fb6ef0`,
> tag `v0.3.37`, npm registry `latest=0.3.37`, GitHub Release v0.3.37).
> No production code changes. The human-labeled paid quality benchmark and
> real Host + Chrome full-chain E2E remain honestly `not_run` (no model
> credentials in the automation environment). Released as `@orion-agents/orion-code@0.3.38` from `refs/tags/v0.3.38`, merged to `main` as `4cb727e` (#295). npm registry `latest=0.3.38` published `2026-10-25T20:50:25.203Z`. GitHub Release: https://github.com/orion-agents/orion-code/releases/tag/v0.3.38

### Changed

- CHANGELOG: corrected the 0.3.37 delivery status from `candidate` to
  `published` (tagged `v0.3.37`, npm registry `latest`, npm publish timestamp
  and GitHub Release link backfilled).
- docs: added `docs/plan/evidence/v0.3.38/status-audit.md` — a three-version
  (0.3.35–0.3.37) delivery-status audit cross-checking git tags, registry
  versions and the `latest` dist-tag, plus the v0.3.37 release facts
  (PR #293, merge `8fb6ef0`, tag `v0.3.37`, registry `latest=0.3.37`).
- README / README.zh-CN: header summary and install pin updated to 0.3.38.

## [0.3.37] — 2026-10-25

> **Status: published.** Open. Receipt backfill & delivery-status audit slice
> (PR4 automatable portion of the v0.3.27 review loop, plan:
> `docs/plan/v0.3.37-plan.md`): the 0.3.36 entry is corrected to `published`
> (including the backfilled GitHub Release link), a new three-version
> delivery-status audit (0.3.34–0.3.36: tag + registry + dist-tag latest) is
> recorded in `docs/plan/evidence/v0.3.37/status-audit.md` together with the
> v0.3.36 release facts (PR #292, squash merge `6ea1d16`, tag `v0.3.36`, npm
> registry `latest=0.3.36`, backfilled GitHub Release v0.3.36). No production
> code changes. The human-labeled paid quality benchmark and real Host +
> Chrome full-chain E2E remain honestly `not_run` (no model credentials in
> the automation environment). Released as `@orion-agents/orion-code@0.3.37` from `refs/tags/v0.3.37`, merged to `main` as `8fb6ef0` (#293). npm registry `latest=0.3.37` published `2026-10-25T15:03:25.053Z`. GitHub Release: https://github.com/orion-agents/orion-code/releases/tag/v0.3.37

### Changed

- CHANGELOG: corrected the 0.3.36 delivery status from `candidate` to
  `published` (tagged `v0.3.36`, npm registry `latest`, GitHub Release link
  backfilled).
- docs: added `docs/plan/evidence/v0.3.37/status-audit.md` — a three-version
  (0.3.34–0.3.36) delivery-status audit cross-checking git tags, registry
  versions and the `latest` dist-tag, plus the v0.3.36 release facts
  (PR #292, merge `6ea1d16`, tag `v0.3.36`, registry `latest=0.3.36`) and the
  backfilled GitHub Release v0.3.36.
- README / README.zh-CN: header summary and install pin updated to 0.3.37.
- deps (coordinated on main via PR #294): npm-shrinkwrap resolution of undici
  moved to 6.29.1, clearing the production audit advisories GHSA-4qv8-2p9j-2685
  and GHSA-xjj6-f33q-929c; 0.3.37 is the first tagged release shipping it.

## [0.3.36] — 2026-10-25

> **Status: published.** Open. Receipt backfill & delivery-status audit slice
> (PR4 automatable portion of the v0.3.27 review loop, plan:
> `docs/plan/v0.3.36-plan.md`): the 0.3.35 entry is corrected to `published`,
> a new three-version delivery-status audit (0.3.33–0.3.35: tag + registry +
> dist-tag latest) is recorded in `docs/plan/evidence/v0.3.36/status-audit.md`
> together with the v0.3.35 release facts (PR #291, squash merge `cfbb4e2`,
> tag `v0.3.35`, npm registry `latest=0.3.35`). No production code changes.
> The human-labeled paid quality benchmark and real Host + Chrome full-chain
> E2E remain honestly `not_run` (no model credentials in the automation
> environment). Released as `@orion-agents/orion-code@0.3.36` from `refs/tags/v0.3.36`, merged to `main` as `6ea1d16` (#292). npm registry `latest=0.3.36` published `2026-10-25T01:59:21.552Z`. GitHub Release: https://github.com/orion-agents/orion-code/releases/tag/v0.3.36

### Changed

- CHANGELOG: corrected the 0.3.35 delivery status from `candidate` to
  `published` (tagged `v0.3.35`, npm registry `latest`).
- docs: added `docs/plan/evidence/v0.3.36/status-audit.md` — a three-version
  (0.3.33–0.3.35) delivery-status audit cross-checking git tags, registry
  versions and the `latest` dist-tag, plus the v0.3.35 release facts
  (PR #291, merge `cfbb4e2`, tag `v0.3.35`, registry `latest=0.3.35`).

## [0.3.35] — 2026-10-25

> **Status: published.** Released as `@orion-agents/orion-code@0.3.35` from
> tag `v0.3.35` (merge commit `cfbb4e2`, PR #291, 2026-10-25); npm registry
> `latest` confirmed 0.3.35 via direct registry query (registry shasum
> `b54d87b2ade509af3479cbd19020b3df5a9f343b`, tarball ingested
> 2026-10-24T20:06:04.738Z). Receipt backfill & delivery-status audit slice
> (PR4 automatable portion of the v0.3.27 review loop, plan:
> `docs/plan/v0.3.35-plan.md`): the 0.3.34 entry is corrected to `published`,
> a new three-version delivery-status audit (0.3.32–0.3.34: tag + registry +
> dist-tag latest) is recorded in `docs/plan/evidence/v0.3.35/status-audit.md`
> together with the v0.3.34 release facts (PR #290, squash merge `d511973`,
> tag `v0.3.34`, npm registry `latest=0.3.34`). No production code changes.
> The human-labeled paid quality benchmark and real Host + Chrome full-chain
> E2E remain honestly `not_run` (no model credentials in the automation
> environment).

### Changed

- CHANGELOG: corrected the 0.3.34 delivery status from `candidate` to
  `published` (tagged `v0.3.34`, npm registry `latest`).
- docs: added `docs/plan/evidence/v0.3.35/status-audit.md` — a three-version
  (0.3.32–0.3.34) delivery-status audit cross-checking git tags, registry
  versions and the `latest` dist-tag, plus the v0.3.34 release facts
  (PR #290, merge `d511973`, tag `v0.3.34`, registry `latest=0.3.34`).

## [0.3.34] — 2026-10-24

> **Status: published.** Released as `@orion-agents/orion-code@0.3.34` from
> tag `v0.3.34` (merge commit `d511973`, PR #290, 2026-10-24); npm registry
> `latest` confirmed 0.3.34 via direct registry query. Receipt backfill &
> delivery-status audit slice
> (PR4 automatable portion of the v0.3.27 review loop, plan:
> `docs/plan/v0.3.34-plan.md`): the 0.3.33 entry is corrected to `published`,
> a new three-version delivery-status audit (0.3.31–0.3.33: tag + registry +
> dist-tag latest) is recorded in `docs/plan/evidence/v0.3.34/status-audit.md`
> together with the v0.3.33 release facts (PR #289, squash merge `262e6e2`,
> tag `v0.3.33`, npm registry `latest=0.3.33`). No production code changes.
> The human-labeled paid quality benchmark and real Host + Chrome full-chain
> E2E remain honestly `not_run` (no model credentials in the automation
> environment).

### Changed

- CHANGELOG: corrected the 0.3.33 delivery status from `candidate` to
  `published` (tagged `v0.3.33`, npm registry `latest`).
- docs: added `docs/plan/evidence/v0.3.34/status-audit.md` — a three-version
  (0.3.31–0.3.33) delivery-status audit cross-checking git tags, registry
  versions and the `latest` dist-tag, plus the v0.3.33 release facts
  (PR #289, merge `262e6e2`, tag `v0.3.33`, registry `latest=0.3.33`).

## [0.3.33] — 2026-10-24

> **Status: published.** Released as `@orion-agents/orion-code@0.3.33` from
> tag `v0.3.33` (merge commit `262e6e2`, PR #289, 2026-10-24); npm registry
> `latest` confirmed 0.3.33 via direct registry query. Receipt backfill &
> delivery-status audit slice
> (PR4 automatable portion of the v0.3.27 review loop, plan:
> `docs/plan/v0.3.33-plan.md`): the 0.3.32 entry is corrected to `published`,
> a new three-version delivery-status audit (0.3.30–0.3.32: tag + registry +
> dist-tag latest) is recorded in `docs/plan/evidence/v0.3.33/status-audit.md`
> together with the v0.3.32 release facts (PR #288, squash merge `d24f531`,
> tag `v0.3.32`, npm registry `latest=0.3.32`). No production code changes.
> The human-labeled paid quality benchmark and real Host + Chrome full-chain
> E2E remain honestly `not_run` (no model credentials in the automation
> environment).

### Changed

- CHANGELOG: corrected the 0.3.32 delivery status from `candidate` to
  `published` (tagged `v0.3.32`, npm registry `latest`).
- docs: added `docs/plan/evidence/v0.3.33/status-audit.md` — a three-version
  (0.3.30–0.3.32) delivery-status audit cross-checking git tags, registry
  versions and the `latest` dist-tag, plus the v0.3.32 release facts
  (PR #288, merge `d24f531`, tag `v0.3.32`, registry `latest=0.3.32`).

## [0.3.32] — 2026-10-23

> **Status: published.** Released as `@orion-agents/orion-code@0.3.32` from
> tag `v0.3.32` (merge commit `d24f531`, PR #288, 2026-10-23); npm registry
> `latest` confirmed 0.3.32 via direct registry query. Receipt backfill &
> delivery-status audit slice
> (PR4 automatable portion of the v0.3.27 review loop, plan:
> `docs/plan/v0.3.32-plan.md`): the 0.3.31 entry is corrected to `published`,
> a new three-version delivery-status audit (0.3.29–0.3.31: tag + registry +
> dist-tag latest) is recorded in `docs/plan/evidence/v0.3.32/status-audit.md`
> together with the v0.3.31 release facts (PR #287, squash merge `10dfd8d`,
> tag `v0.3.31`, npm registry `latest=0.3.31`). No production code changes.
> The human-labeled paid quality benchmark and real Host + Chrome full-chain
> E2E remain honestly `not_run` (no model credentials in the automation
> environment).

### Changed

- CHANGELOG: corrected the 0.3.31 delivery status from `candidate` to
  `published` (tagged `v0.3.31`, npm registry `latest`).
- docs: added `docs/plan/evidence/v0.3.32/status-audit.md` — a three-version
  (0.3.29–0.3.31) delivery-status audit cross-checking git tags, registry
  versions and the `latest` dist-tag, plus the v0.3.31 release facts
  (PR #287, merge `10dfd8d`, tag `v0.3.31`, registry `latest=0.3.31`).

## [0.3.31] — 2026-10-22

> **Status: published.** Released as `@orion-agents/orion-code@0.3.31` from
> tag `v0.3.31` (merge commit `10dfd8d`, PR #287, 2026-10-22); npm registry
> `latest` confirmed 0.3.31 via direct registry query. Receipt backfill &
> delivery-status audit slice
> (PR4 automatable portion of the v0.3.27 review loop, plan:
> `docs/plan/v0.3.31-plan.md`): the v0.3.30 qualification evidence's release
> section is backfilled with the actual delivery facts (PR #286, squash merge
> `15887f5`, tag `v0.3.30`, npm registry `latest=0.3.30`), the 0.3.30 entry is
> corrected to `published`, and a new three-version delivery-status audit
> (0.3.28–0.3.30: tag + registry + dist-tag latest) is recorded in
> `docs/plan/evidence/v0.3.31/status-audit.md`. No production code changes.
> The human-labeled paid quality benchmark and real Host + Chrome full-chain
> E2E remain honestly `not_run` (no model credentials in the automation
> environment).

### Changed

- docs: backfilled the release section of
  `docs/plan/evidence/v0.3.30/qualification.md` with the real delivery facts
  (PR #286, merge commit `15887f5`, tag `v0.3.30`, npm registry `latest`).
- CHANGELOG: corrected the 0.3.30 delivery status from `candidate` to
  `published` (tagged `v0.3.30`, npm registry `latest`).
- docs: added `docs/plan/evidence/v0.3.31/status-audit.md` — a three-version
  (0.3.28–0.3.30) delivery-status audit cross-checking git tags, registry
  versions and the `latest` dist-tag.

## [0.3.30] — 2026-10-22

> **Status: published.** Released as `@orion-agents/orion-code@0.3.30` from
> tag `v0.3.30` (merge commit `15887f5`, PR #286, 2026-10-22); npm registry
> `latest` confirmed 0.3.30 via direct registry query. Qualification &
> documentation slice (PR4
> automatable portion of the v0.3.27 review loop, plan:
> `docs/plan/v0.3.30-plan.md`): the public README (English and 简体中文) no
> longer claims that Files/Git/Review are read-only or that the project
> navigator creates no other runtimes — Files offers CAS-guarded text editing
> (512 KiB cap), Git offers staging, hunk/line feedback, local commits and
> history reading, Review starts the shared bounded review runner, and the
> Host runs a bounded Session actor pool (3 running / 4 resident by default);
> remote or destructive Git operations remain unexposed by design. A new
> `docs/architecture/code-review-loop.md` documents the shared loop end to
> end (selectors, tighten-only budgets, receipt digests, staleness, state
> banners, Web single-flight, host-restart history boundary). The v0.3.29
> entry is corrected to `published` (tag `v0.3.29`, npm `latest`). The
> human-labeled paid quality benchmark and real Host + Chrome full-chain E2E
> remain honestly `not_run` (no model credentials in the automation
> environment).

### Changed

- README.md / README.zh-CN.md: aligned the Web workbench capability summary
  with the current implementation (Files CAS editing, Git staging/commit/
  history, Review shared runner, bounded Session actor pool) and kept the
  explicit "remote/destructive Git operations not exposed" boundary.
- docs: added `docs/architecture/code-review-loop.md` (shared review loop
  usage & semantics) and indexed it in `docs/readme.md`.
- CHANGELOG: corrected the 0.3.29 delivery status from `candidate` to
  `published` (tagged `v0.3.29`, npm registry `latest`).

## [0.3.29] — 2026-10-22

> **Status: published.** Released as `@orion-agents/orion-code@0.3.29` from
> tag `v0.3.29` (merge commit `86c20aa`, PR #285, 2026-10-22); npm registry
> `latest` confirmed 0.3.29 via direct registry query. The Web shared review
> loop (plan: `docs/plan/v0.3.29-plan.md`, PR3 core of the v0.3.27 review loop):
> the Host now starts the same bounded single-pass review runner the CLI uses
> (`runCodeReview`, v0.3.28) against the active Workspace. `POST /review/run`
> performs fast admission (one in-flight run per Host, typed
> `review_run_in_progress` 409 and `review_no_model` 422) and the model
> completion continues in the background; `GET /review/runs` and
> `GET /review/runs/:runId` read a bounded in-memory history where every
> receipt passes digest re-verification and is flagged `stale` when the
> repository revision changed after admission. The Review panel lists the runs
> with honest state banners (running / cancelled / failed / partial / stale
> never render as a green pass), groups findings P0→P3 with file:line anchors
> into the existing diff view, counts contract-invalid model output instead of
> hiding it, and can send each finding back to the Composer as a typed draft
> the user still confirms. The fileKey→path mapping is captured through an
> additive `onSnapshotCaptured` runner hook; the frozen receipt contract is
> unchanged.

### Added

- `src/web/code-review-run-service.ts` — the Host-side review run service:
  single-flight admission, background execution of the shared runner, bounded
  receipt history (20 runs, oldest finished evicted first), digest
  re-verification on read, repository-revision staleness flags, cancellation,
  and the `parseWebReviewSelectorV1` request validation.
- `src/web/workbench-controller.ts` — `reviewRunStart` / `reviewRunList` /
  `reviewRunGet` / `reviewRunCancel`, with the review model adapter derived
  from the control-plane Runtime's `llm` (typed 422 when the Host has no
  configured model).
- `src/web/server.ts` — `POST /review/run` and
  `POST /review/runs/:runId/cancel` behind `assertMutation` +
  `executeMutation`, plus read-only `GET /review/runs[/:runId]` with context
  guards.
- `web/src/components/review/ReviewRunsSection.tsx` and
  `review-runs-view.ts` — the Review panel results section: run button,
  polling while a run is in flight, priority-grouped findings, honest banners,
  diff anchoring and typed Composer drafts.
- Tests: `tests/web-code-review-run-service.test.ts` (10 unit tests),
  `tests/web-review-run-endpoint.test.ts` (4 real-host tests on a temp Git
  repository, including the 403 nonce guard and the 422 no-model path),
  `tests/web-review-runs-view.test.tsx` (13 pure + SSR view tests).

### Not run

- Real Host + Chrome full-chain E2E and the human-labeled quality benchmark
  (PR4) — the local automation sandbox has no model credentials; recorded
  honestly as `not_run`, not silently skipped.

## [0.3.28] — 2026-10-22

> **Status: published.** The typed `/review` runtime & CLI slice
> (plan: `docs/plan/v0.3.28-plan.md`, PR2 core of the v0.3.27 review loop):
> `/review` arguments now parse into the frozen `ReviewSelectorV1` (worktree /
> `--base` / repeatable `--path`, back-compat single-path filter) and unknown
> input returns the usage text instead of silently continuing as an ordinary
> chat turn. The review runs against the admission-time frozen Git snapshot
> through a bounded single-pass model completion; the model's findings are
> validated against the contract and anchored to the snapshot manifest, with
> invalid or unanchored findings counted and surfaced rather than silently
> dropped. Every run produces a digest-verifiable `CodeReviewResultV1` receipt
> rendered by the shared formatter with honest state banners: an empty scope
> reports "no changes under review" without calling the model, and partial,
> failed, cancelled or inconclusive runs never render as a green pass.
> Web wiring (PR3) and the qualification benchmark (PR4) remain subsequent
> slices. Merged as #284, tagged `v0.3.28` on main (`8a4722b`), published to
> npm (registry `latest` = 0.3.28).

### Added

- `src/services/code-review/selector.ts` — the typed `/review` argument
  parser: empty / `all` → worktree scope, `--base <ref>` → base scope,
  repeatable `--path <path>` filters, single bare relative path kept as a
  back-compat worktree filter; unknown options, missing values, repeated
  `--base`, absolute paths and traversal are typed usage errors. Fourteen
  tests pin every accepted shape and rejection path.
- `src/services/code-review/runner.ts` — the bounded single-pass review
  runner: `resolveReviewBudgets` (tighten-only) → `captureReviewSnapshot`
  (worktree contained reader) → frozen unified diff captured with the same
  admission-time arguments → rules digest binding the read-only constraints
  digest plus ancestor `AGENTS.md` contents → one model completion through an
  injected adapter → contract validation + snapshot-membership anchoring +
  `maxFindings` budget → `resolveReviewConclusion` → receipt digest
  recomputation. Empty scope completes without a model call and is labeled
  `empty_scope_no_changes`; cancellation, model errors and unparsable output
  are typed failures, never green passes.
- `src/services/code-review/format.ts` — the shared TUI formatter: scope and
  resolved target header, findings grouped P0→P3 with side:line locations,
  invalid-finding counts, coverage / skips / budget exhaustion footer and a
  receipt digest line; partial / failed / cancelled banners never render as a
  clean pass.
- `/review` command wiring (`src/commands/workflow-commands.ts`,
  `workflow-command-handlers.ts`): the command is now a read-only builtin
  that runs the typed workflow; unrecognized arguments return usage, a
  missing model returns an explicit error, and no path falls back to ordinary
  chat.

### Changed

- `src/services/code-review/snapshot.ts` exports `reviewUnifiedDiffArgs` so
  the runner reuses the exact frozen diff arguments instead of re-deriving
  OIDs after admission; no frozen semantics changed.

### Not run

- Real-PTY CLI verification, Web E2E (no Web changes in this slice), and the
  paid human-annotated review-quality benchmark remain `not_run`, matching
  the v0.3.27 plan's PR3/PR4 sequencing.

## [0.3.27] — 2026-10-22

> **Status: published, 2026-10-22.** Tagged `v0.3.27` (`0be5b18`), merged via
> #283, and visible on npm as registry `latest`. First slice of the
> professional code review loop
> (plan: `docs/plan/v0.3.27-plan.md`): the shared review contract (selectors,
> states, conclusions, findings, tighten-only budgets, receipt digests,
> stale-applicability) is frozen in `src/services/code-review` and bound by
> contract tests; the shared Git snapshot reader captures worktree (staged /
> unstaged / untracked, separate sources) and base (frozen merge-base..HEAD
> OIDs, rename tracking) scopes with typed scope errors; and the read-only
> workflow constraints deny every non-read tool by default with a dispatch-level
> guard whose digest binds receipts. Runtime / CLI wiring (PR2), the Web loop
> (PR3) and the qualification benchmark (PR4) are subsequent slices of the same
> plan and are not part of this release; PR2's core CLI slice ships in 0.3.28.

### Added

- #277-plan PR0: `src/services/code-review/contract.ts` — the shared review
  contract with the plan §4.1 conclusion mapping (a partial, failed, cancelled
  or untrustworthy review can never surface as a green "no findings"),
  tighten-only budgets from plan §4.3, finding validation, receipt digests
  verified by recomputation, and stale-applicability annotation that never
  rewrites history. Twelve contract tests pin the semantics.
- PR0: the human-annotation review-quality benchmark set (12 defect + 8 clean
  samples across TypeScript/JavaScript/Python with content digests, expected
  triggers, allowed locations and frozen scoring thresholds), awaiting
  per-sample human sign-off before any paid model run (plan §9.3).
- PR1: `src/services/code-review/snapshot.ts` — the shared Git snapshot reader:
  worktree scope records staged (index OIDs), unstaged (working content with
  before/after digest re-checks) and untracked changes as separate sources;
  base scope freezes ref/HEAD/merge-base into immutable OIDs with rename
  tracking and typed `ref_unresolved` / `no_merge_base` errors; sensitive and
  binary entries are skipped without being read; tightened budgets skip the
  excess with typed reasons; the contained worktree reader refuses to leave the
  repository root.
- PR1: `src/services/code-review/constraints.ts` — deny-by-default read-only
  workflow constraints (only `read_file`, `list_files`, `glob`, `grep` pass the
  dispatch-level guard) with a frozen digest that receipts bind.

## [0.3.26] — 2026-10-17

> **Status: published.** Released as `@orion-agents/orion-code@0.3.26` from
> `refs/tags/v0.3.26`, and merged to `main` as `b810996` (#278). Structured-diff
> integrity and Session lifecycle: header-lookalike body rows stay body rows
> (#274), hunks split across pagination keep their rows, line numbers and
> identity (#275), permanent Session deletion removes the v2 Thread records
> (#276), and exiting a cutover Session no longer rewrites its summary from the
> frozen legacy JSONL (#277). Plan: `docs/plan/v0.3.26-plan.md`. GitHub Release:
> https://github.com/orion-agents/orion-code/releases/tag/v0.3.26

### Fixed

- #274: a deletion row whose text starts with `-- ` (`--- old comment`) is no longer
  mistaken for the old-file header; the hunk stays open and the remaining body is
  no longer demoted to document metadata.
- #275: the structured diff continuation contract carries the split hunk's state
  (header, index, running line cursors) in the cursor, so every page of a large
  hunk keeps its rows with correct line numbers and the stable hunk identity, and
  the last page reports the true completeness.
- #276: permanently deleting a cutover Session removes its v2 records — cutover
  index entry, event log, head, projection, compact state and checkpoints,
  session-index manifest, transcript pages and import receipt — under the same
  file-lock and atomic-write discipline as the cutover itself.
- #277: `/exit` (and the shutdown path) no longer rewrites a cutover Session's
  `messageCount`/`historySizeBytes` from the frozen legacy JSONL; the summary comes
  from the authoritative v2 Thread.

## [0.3.25] — 2026-10-13

> **Status: published.** Released as `@orion-agents/orion-code@0.3.25` from
> `refs/tags/v0.3.25`, and merged to `main` as `c356323` (#273). Four open-issue fixes
> for the Git conflict view (#269), file-history revisions (#270), the model-switch
> compact preflight (#271) and the stable project navigation order (#272). Plan:
> `docs/plan/v0.3.25-plan.md`. GitHub Release:
> https://github.com/orion-agents/orion-code/releases/tag/v0.3.25

### Fixed

- #269: `GET /git/conflict` no longer fails with `git cat-file: could not get object
info` after editing a conflicted file before staging — the `worktree` version is read
  from the filesystem (contained within the repository root) instead of an object
  `hash-object` never wrote.
- #270: `GET /git/file-history` with a `rev` now walks that revision; previously the
  validated revision never reached the `git log` command and every query walked HEAD.
- #271: switching to a model with the same or larger raw context window but a smaller
  effective input budget (larger output reserve) now reports `compactRequired` and runs
  the compact preflight instead of silently persisting a model the history cannot fit.

### Changed

- #272: the left project navigation keeps a stable registration order for unpinned
  projects (`registeredAt`, persisted by the workspace registry and exposed additively
  on `WebWorkspaceSummaryV1`); activating sessions no longer reshuffles the tree.
  Pinned projects keep `pinnedOrder` first.

## [0.3.24] — 2026-10-13

> **Status: published.** Released as `@orion-agents/orion-code@0.3.24` from
> `refs/tags/v0.3.24`, and merged to `main` as `85fadb4` (#268). Session
> navigation & responsiveness for the Web Workbench. Plan:
> `docs/plan/v0.3.24-plan.md`. GitHub Release:
> https://github.com/orion-agents/orion-code/releases/tag/v0.3.24

### Fixed

- Session command and Composer requests track only their originating Session;
  sending no longer blocks another Session's Composer or session creation.
- Same-Context snapshots across a live event stream are reused when unchanged;
  warm selection does not re-fetch or disable input. Background changes and
  disconnections still require synchronization before writes.
- Foreground display caches retain streamed messages, tool cards and loaded
  history instead of restoring an older HTTP tail when switching back.
- Creation is single-flight and respects a later foreground selection. Late
  send responses do not clear, focus or replace another Session's draft.
- Web creation bounds asynchronous Git branch probes; project storage identity
  resolution reuses an invalidatable bounded cache instead of repeatedly
  spawning synchronous Git on every storage helper call.
- Cross-Workspace navigation remains usable while another Session is running;
  the most recent navigation intent wins when Context activation is in flight.
- Per-Session scroll position and loaded history survive navigation, while
  foreground Snapshot and SSE reconciliation no longer skips background events.
- Web Session creation waits for file locks without freezing the Host event
  loop, and cold Catalog scans yield to unrelated HTTP and SSE traffic.

## [0.3.23] — UNRELEASED

> **Status: candidate.** Open. Coding Intelligence & Verified Execution — wires the live
> coding-task evaluation to the production runtime (isolated workspaces, machine-verified
> success, five-outcome classification), adds repo-intelligence symbol indexing and
> recall, and consolidates the bounded verification/repair loop into the HarnessKernel
> completion audit. Plan: `docs/plan/v0.3.23-plan.md`. Not merged, tagged or published.

### Added (planned)

- Live Coding Eval: `LiveTaskExecutor` + `compare-receipts` A/B reporting; five-outcome
  classification with orthogonal falseComplete; `command_exit_zero` / `invariant` checks.
- Repo Intelligence: lightweight TS/JS symbol index with incremental maintenance and
  sourced recall (Recall@K evaluated).
- Verified Repair: structured failure attribution, bounded repair loop (feature-flagged),
  five-state completion audit; the orphaned auto-fix / verification-profile modules merge
  into the wired stack and are removed.

## [0.3.22] — 2026-10-09

> **Status: published.** Released as `@orion-agents/orion-code@0.3.22` from
> `refs/tags/v0.3.22`, and merged to `main` as `9f09e0a` (#265). Hardens ToolGateway
> in-flight request identity (T22-01), adds the durability fault-injection matrix (T22-02),
> the four-state release verification gate (T22-03), and a real coding-task evaluation
> harness (T22-04). Plan: `docs/plan/v0.3.22-plan.md`. GitHub Release:
> https://github.com/orion-agents/orion-code/releases/tag/v0.3.22。

### Fixed (product)

- ToolGateway in-flight dedupe now compares the full request digest: the same invocationId
  with different arguments, tool, snapshot, or parent conflicts
  (`ORION_TOOL_INVOCATION_CONFLICT`) instead of reusing the running execution's promise.

## [0.3.21] — 2026-10-09

> **Status: published.** Released as `@orion-agents/orion-code@0.3.21` from
> `refs/tags/v0.3.21`, and merged to `main` as `0d22c9a` (#264). Adds user-authorized
> local project-root discovery to `LOCAL WORKSPACE` (bounded scan, explicit
> inspect → confirm → activate reuse, no Home/network-volume scanning, no silent
> registration) and corrects the v0.3.20 release-facts documentation
> (`docs/plan/evidence/v0.3.20-e2e/release-receipt-v0.3.20.md`).

### Added (planned)

- Saved project roots registry (`WorkspaceRootsRegistryV1`) and a bounded, cancellable
  discovery service with depth/candidate/time budgets and partial-result semantics.

### Fixed (planned)

- README / README.zh-CN / CHANGELOG release-state drift for v0.3.20, plus a release-check
  guard that fails when a README describes a tagged version as unpublished.

## [0.3.20] — 2026-10-07

> **Status: published.** Released as `@orion-agents/orion-code@0.3.20` from
> `refs/tags/v0.3.20`, and merged to `main` as `e658932` (#261). Repairs the Web E2E
> suite that has been red since v0.3.11 (the dock's tabs became rail buttons)
> independently of the Git panel work, and fixes the product defects the repair exposed.
>
> ### Fixed (product)
>
> - The work-panel rail no longer sets `aria-orientation` on `role=navigation`
>   (axe `aria-allowed-attr`, critical), and the navigation aside keeps one stable
>   id so `aria-controls` always resolves.
> - The first archived-sessions load no longer storms the host (2476 requests
>   measured in ~80s): the loading state claims workspace ownership like the
>   failure path already did.
> - The narrow-width navigation toggle and the drawer close button are restored
>   (v0.3.15 removed them with the conversation header, leaving sub-~800px
>   viewports without a pointer entry while their CSS and focus wiring survived).
> - A bare Escape no longer moves focus to a stale drawer trigger, and the
>   shortcut-help dialog restores focus to its trigger explicitly; its scrollable
>   body is keyboard focusable (axe `scrollable-region-focusable`, serious).
>
> ### Test infrastructure
>
> - Every stale E2E locator and copy assertion traced to its contract change and
>   rewritten; all previously failing specs pass locally (full suite 100/103 —
>   the remainder are sandbox-only: a bulk-delete shim, two perf bounds).
> - `allowExpectedConsoleErrors(testInfo, text, maximum)` bounds the console
>   noise that deliberate failure journeys (CAS conflicts, phantom catalog
>   sessions) produce; the evidence capture caps can be raised via env for
>   diagnosis.
> - The receipt upload only fires when the evidence gate actually ran.
>
> ### Security
>
> - The production dependency tree is patched to zero known high advisories:
>   `js-yaml` 4.3.2 (the advisory the audit job originally failed on) plus the
>   `axios` 1.20.0, `undici` 6.29.0, `brace-expansion`, `braces` and `figlet`
>   patch updates. The audit job now audits `--omit=dev`: the remaining high
>   advisories sit in dev-only tooling (jest 29 → 30, typescript-eslint 7 → 8,
>   nodemon) whose fixes are major tooling upgrades; they are follow-up work,
>   not shipped code.

## [0.3.19] — 2026-09-19

> **Status: published.** Released as `@orion-agents/orion-code@0.3.19` from
> `refs/tags/v0.3.19`, and merged to `main` as `d17d211` (#259). Closes the five scenarios
> the v0.3.17 status table left as "feature present, assertion missing"
> (`docs/plan/evidence/v0.3.17-git/g317-status.md`), and fixes the three defects those
> assertions found.

### Fixed

- **The responsive tiers were inert.** `GitPanel` attached its `ResizeObserver` from an
  effect with an empty dependency list. The panel's first render is the loading placeholder,
  which does not contain the measured node, so the effect read a null ref, returned, and never
  ran again: the width stayed `0`, `data-width` stayed `wide` on a 480px panel, and the narrow
  affordances never activated on any load whose status was not already cached. The observer is
  now attached with a callback ref, so it follows the node in and out of the tree.
- **A discarded diff read left the pane blank with a file still selected.** Only a newer
  _selection_ supersedes a read now. The document states the revision it was rendered against,
  so accepting it and letting `stale` tell the truth is both safer and correct — dropping it
  because the 2s visible poll had bumped the revision abandoned the read with nothing to
  re-issue it.
- **Returning from the narrow detail pane threw away the reading position.** The back control
  cleared `selectedFileId` to show the list, which also dropped the anchors and the cached
  document. The pane choice is now its own state.

### Added

- **A bare repository is no longer reported as "not a repository".** `rev-parse
--show-toplevel` fails for a bare repository too, and that single failure was read as "no
  repository here". Status now carries `repositoryKind: 'worktree' | 'bare' | 'absent'` and
  `hasWorktree`; every worktree-backed surface gates on `hasWorktree`, which is the only flag
  that cannot be wrong. A bare repository's branch is reported instead of hidden, its change
  lists stay empty, and the history limit names the real reason.
- **G317 assertion backlog:** an external write no longer moves the reader (the refresh is
  detected and the document is marked stale instead of silently kept); `在 Files 打开` is
  asserted end to end; the theme is measured rather than assumed (system preference, the
  explicit choice through Settings, reduced motion and forced colours); the narrow tier's back
  affordance and overflow are asserted; and repeated open/close plus a hundred consecutive
  diffs are asserted bounded, with S5/S6 samples recorded by
  `scripts/perf/v0319-git-s6-samples.mjs`.

### Known limits

- The `compact` and `wide` panel tiers are pinned by `resolveGitPanelLayout` unit tests, not in
  a browser: neither seeding `workPanel.widthPx` nor dragging the splitter reproduced a tier
  change in the E2E harness. `docs/plan/evidence/v0.3.17-git/s6-responsive-keyboard.md` records
  the measurement.
- The drawer entry point below 1180px is not asserted; those widths assert overflow only.

## [0.3.18]

> **Status: npm-published, not tagged or merged.** The exact contents below are
> published to the registry as 0.3.18, but `refs/tags/v0.3.18` does not exist and
> `main` does not carry this work yet, so the release is not complete.
> Closes the assertion and evidence backlog of the Git right-hand work panel
> shipped in 0.3.17, and fixes the CRLF part-staging defect found right after
> that release.

### Fixed

- **CRLF part-staging was impossible:** the rebuilt context reused the
  normalised display text, dropping the carriage return, so the patch never
  matched the stored bytes. The raw line is reused so the context keeps its
  line endings, and a selection that still cannot apply is refused explicitly
  with `git_patch_not_applicable` instead of surfacing as a Git failure.

### Added

- **Assertion coverage for the G317 backlog:** deleting and renaming through
  the panel (git records R with the content preserved), line-level staging on a
  CRLF file, a signing failure (HEAD and the staged work untouched), bare and
  non-repository workspaces, and a clean repository with readable history.
- **Conflict-assertion split:** the plan requirement (a conflict is never shown
  as an ordinary stageable diff) is asserted separately from whether the ideal
  three-way view rendered — the earlier single assertion was flaky because the
  three-way view loads asynchronously.
- **Browser evidence:** conflict, comparison, blame, narrow-viewport and
  open-in-Files screenshots under docs/plan/evidence/v0.3.17-git/screenshots/.

### Known gaps

- The bare-repository `status()` contract is measured but not yet pinned (its
  current behaviour is neither a refusal nor an empty status).
- Performance samples for the S5/S6 reads, dark-theme screenshot assertions,
  and the agent-led file-change scenario are still open.

---

## [0.3.17]

> **Status: candidate.** Opening a local project is made fast and honest
> (`docs/plan/v0.3.16-plan-v1.md`): the directory preview no longer waits on the
> session catalog, the Finder browse action no longer occupies the global
> Context mutation admission, and every entry point shares one
> inspect → confirm → activate contract. Covers S2, S3 and S5; S1 (per-stage
> telemetry) and S4 (staged activate baseline) are not implemented yet. Not
> merged, tagged or published.
>
> **Update:** S1 (per-stage telemetry) and the S4 headline (the foreground
> snapshot no longer gates the first render) also landed on this branch, plus a
> bounded inspect probe. The measured Host-side receipt is in
> `docs/plan/evidence/v0.3.17-open-baseline.md`.
>
> **Update 2:** the Git right-hand work panel (`docs/plan/v0.3.17-plan.md`,
> S0–S6) is implemented on this branch as well. Evidence per stage is under
> `docs/plan/evidence/v0.3.17-git/`, and the scenario matrix is
> `g317-status.md`. All functional gaps are closed; the remaining items are
> assertion and evidence backlog, listed under **Known gaps** below.

### Added

- **Per-stage open-path telemetry:** `WorkspaceOpenTelemetryV1` keeps a bounded
  ring of `{ requestId, operation, outcome, stage ms, errorCode }` for the
  picker, the inspect probe and the Context transition, and exposes it
  read-only through Diagnostics as `workspaceOpen`. Traces never carry a path,
  a label or file content.

### Fixed

- **The preview no longer blocks on the session catalog:** `inspect` used to
  call `countSessionsByProject()`, which can rebuild the catalog and hold its
  file lock for up to 10s before the confirmation card appeared. It now reads
  the warm cache only (`peekCachedSessionCounts()`) and reports
  `sessionCountStatus: 'deferred'` when the catalog is cold; the card stays
  usable and shows 会话数读取中 instead of stalling.

### Changed

- **The native picker is browse admission, not a mutation:**
  `POST /workspaces/pick-directory` no longer goes through `executeMutation()`,
  so an open Finder dialog does not raise `activeMutationCount` or enter the
  idempotency ledger and can no longer make a project switch look like a busy
  Runtime. Single-flight (`picker_busy`) and the nonce/origin/content-type
  guards are unchanged.
- **One path contract:** the advanced manual entry and the pinned/recent rows
  now go through the same inspect → confirm → activate state machine as the
  Finder entry. Nothing activates without an explicit confirmation, and
  availability plus the Git/Folder kind are always re-checked.
- **The picker timeout is wired:** `timeoutMs` reaches the default `execFile`
  runner, and a timeout reports its own `picker_timeout` reason code instead of
  being folded into `picker_unavailable`.
- **The preview probe is bounded:** `inspectDirectory` now uses asynchronous fs
  raced against a 250ms budget, so a hung network mount or a broken symlink
  cannot freeze the Node event loop; on timeout the directory is reported
  `unreadable` with an `inspect_budget_exceeded` trace code.
- **The foreground snapshot no longer gates the first render:** `loadBaseline`
  dispatches the identity baseline (bootstrap, workspaces, sessions, settings)
  before restoring the session, so the project shell and session list appear
  while the transcript is still loading. The reducer already marks the active
  session `loading`, so the Composer stays disabled until the snapshot settles.
- **Activation no longer re-requests the workspace page:** the page returned by
  `POST /workspaces/activate` is reused by the baseline when its `activeId`
  matches the freshly bootstrapped Context, so opening a project issues one
  fewer round-trip. A mismatch falls back to the normal request.
- **The confirmation card reports discrete stages:** while opening, the card
  shows `准备项目 → 加载本地 Runtime → 恢复会话（如有）` with only the stage the
  Host actually reports marked `aria-current="step"`, instead of one vague
  "正在打开…" label covering the whole wait.

### Tests

- `tests/web-workbench-workspace-picker.test.ts` — the preview never calls the
  catalog rebuild entry point; the count is `ready` when the cache is warm.
- `tests/session-catalog-peek.test.ts` — the peek answers `null` on a cold
  module instead of loading or locking.
- `tests/native-directory-picker.test.ts` — a timeout keeps its own reason code.
- `tests/web-ui-workspace-picker.test.tsx` — the card stays actionable while the
  count is deferred, and the stage list only appears after confirming.
- `tests/workspace-open-telemetry.test.ts` — stage offsets, duplicate marks,
  bounded retention, and that a serialized trace contains no path.
- `tests/e2e/web-v0317-workspace-open.spec.ts` — W316P-01/02/04/08/09 driven by a
  scripted picker: no browse side effects, inspect-then-confirm, cancellation,
  the shared advanced-path contract, and the no-path-leak regression.
- `tests/e2e/*` — the four manual-path specs confirm on the card before
  activating.

### Test seams

- **`ORION_CODE_WEB_PICKER_FIXTURE`** points the Host at a JSON script file so
  end-to-end runs never open a real Finder dialog (`{"path": …}` /
  `{"paths": […]}` / `{"outcome": "cancelled" | "unavailable"}`). The script is
  re-read on every invocation, and an absent or malformed file behaves like a
  cancelled dialog. It is browse-only: the returned path still has to be
  confirmed and passes through the same guarded activation flow.

### Added — Git right-hand work panel (S0–S6)

- **Change navigation:** staged / unstaged / untracked / conflict groups with a
  host-side filter and search, counts that cover the whole matching set, and a
  pagination cursor bound to the group and query it was issued for.
- **Diff reading:** unified and side-by-side, old/new line numbers, continuous
  hunks, fold state, line anchors, word-level diff (`--word-diff=plain`) and
  ignore-all-space — the last two are bound into the pagination cursor, so a
  page can never be continued under a different view.
- **Writes through an index transaction:** every index change holds
  `index.lock` (and only ever removes a lock it created), writes to a private
  sibling index, verifies it, and publishes with a single atomic rename.
  Hunk-level and line-level staging rebuild the patch on the Host from the
  reviewed document — the browser only ever sends ids.
- **Commit form and result recovery:** summary plus multi-line body, the
  identity / signing / hook configuration that will actually run, a preview of
  the real index (independent of list filters), the draft preserved on failure,
  and idempotent replay by `requestId`.
- **History:** search across the whole reachable history, commit details,
  root commits compared with the empty tree, merge parents selectable and
  labelled, file history with `--follow`, blame, historical blobs for files
  that no longer exist locally, and a commit graph drawn by git itself.
- **Branch and version comparison:** two-endpoint snapshot and diverged-from
  (merge-base) modes; the resolved commit ids are part of the result so an open
  comparison can be frozen, and a multi-merge-base pair is refused rather than
  silently picking one.
- **Conflict views:** base / ours / theirs read from index stages 1/2/3 plus
  the working tree, with a stage that legitimately does not exist reported as
  absent instead of being elided.
- **Submodule and LFS:** recorded gitlink SHAs are shown without traversing
  submodules, and LFS pointers are reported as state without fetching objects.
- **Image versions:** a bounded, magic-byte-identified image becomes a data URL
  so both versions of a picture can be shown without a download.
- **Cross-panel links:** "open in Files" translates a Git token into a Files
  token on the Host, and the composer reference carries the file, comparison
  source, revision and line range into the draft without sending it.
- **Responsive and keyboard:** three tiers keyed off the panel container (not
  the window), with a narrow layout that never writes the downgrade back into
  the stored preference; arrow keys, Enter, F7 / Shift+F7 change navigation,
  Escape unwinding one layer at a time, and Space toggling selection only —
  never a Git write.

### Fixed — Git panel

- **Staging could silently do nothing:** the private index copy received a
  fresh mtime, which defeated Git’s racy-clean rule — a file edited within the
  same timestamp granularity and with an unchanged size was not re-hashed, so
  `git add` succeeded while changing nothing. The copy now preserves the
  original timestamps, and staging verifies each path with `hash-object
--path` against the index entry.
- **`localhost` was rejected site-wide:** the Host and Origin checks compared
  header strings exactly, so `http://localhost:<port>` returned 421 (and, with
  only the Host check fixed, every mutation would have returned 403). Both now
  accept any loopback spelling of the same endpoint while still refusing
  attacker-controlled names and a mismatched port.
- **`git apply -` and `git commit -F -` blocked forever:** the async
  `execFile` `input` option is silently ignored, so stdin was never closed.
  Writes now use `spawn` and close stdin explicitly, and a timeout kills the
  whole process group so a slow hook cannot be orphaned.
- **Refs came back empty:** `for-each-ref` does not support the `%x1f` escapes
  that `git log --format` does; it printed them literally. Refs are now parsed
  from a space-separated format.
- **A detached HEAD could be reported as a branch:** the check was "no ref
  points at HEAD", which is wrong when detaching onto a branch tip. It now
  asks git whether HEAD is a symbolic ref.

### Known gaps

- Assertion and evidence backlog for the Git panel: an end-to-end spec
  (`tests/e2e/web-v0317-git-workspace.spec.ts`), automated assertions for the
  Files cross-panel link, and scenario variants not yet covered (staging a
  deletion or rename, CRLF line selection, signing failure, bare repository
  and linked worktree cases, agent-led file changes).
- Narrow-viewport and dark-theme screenshots, plus performance samples for the
  reads added in S5 and S6.
- `npm run typecheck:e2e` fails on this branch with 12 errors in the v0.3.12
  and v0.3.13 specs; the same 12 errors reproduce on the v0.3.16 baseline, so
  they are pre-existing and unrelated to the Git panel.

## [0.3.16] — CANDIDATE

> **Status: candidate.** LOCAL WORKSPACE opens a new project without typing a
> path (`docs/plan/v0.3.16-plan.md`): a Host-side native folder picker, and a
> read-only inspect step separated from activation. Covers slices S1 and S2;
> controlled workspace-roots discovery (S3) is not implemented yet. No protocol
> removals or dependency changes. Not merged, tagged or published.

### Added

- **Native folder picker (Host):** `POST /workspaces/pick-directory` runs the OS
  directory chooser on the Host. The AppleScript is a fixed constant and the
  prompt / default location travel as `argv` through `execFile`, so a chosen
  path is never interpolated into a shell or script string. Cancelling is a
  normal outcome, platforms without an adapter report `picker_unavailable`
  rather than faking a selection, and only one picker may be open at a time.
- **Read-only workspace inspect:** `POST /workspaces/inspect` resolves the
  canonical path, availability (`available` / `missing` / `not_directory` /
  `unreadable`) and Git-vs-folder kind, plus existing workspace id, session
  count and pin order. It never registers a workspace, activates a Context or
  reads file contents.
- **Project picker dialog:** the LOCAL WORKSPACE dialog now leads with
  `从 Finder 选择文件夹…`, groups pinned and recent projects, and shows a
  confirmation card (canonical path, kind, availability, session count). The
  manual absolute-path entry moved into a collapsed 高级 disclosure.

### Changed

- Browsing, searching, inspecting and cancelling never call `activateContext`,
  pause the event stream or stop a running Session; only confirming 打开项目
  enters the existing activation flow.

### Tests

- `tests/native-directory-picker.test.ts` — outcome mapping, argv isolation,
  trailing-separator handling and non-macOS unavailability.
- `tests/web-workbench-workspace-picker.test.ts` — inspect is strictly
  read-only and the picker is single-in-flight.
- `tests/web-ui-workspace-picker.test.tsx` — state-machine invariants (no
  activation without a confirmed candidate) and the confirmation card.
- `tests/e2e/*` — the four specs that filled the manual path now open the
  advanced disclosure first.

## [0.3.15] — CANDIDATE

> **Status: candidate.** Web Workbench visual & interaction convergence
> (`docs/plan/v0.3.15-plan.md`): copy thinning, unified confirm modal, busy
> affordances and resource-panel visual tightening. No protocol, API or
> dependency changes. Not merged, tagged or published.

### Added

- **Pixel brand identity:** the Workbench brand is now true pixel art. A
  dot-matrix `orion-code` wordmark (`PixelWordmark`, 5×7 grid, run-merged hard
  rects, integer `scale`) sits in the expanded rail header, and an SVG page
  icon (`web/public/favicon.svg`) gives the browser tab a real favicon (there
  was none). `OrionBrandMark` gained an optional `pixel` prop that renders
  solid two-tone bars with a 1px base shadow; the default gradient glyph used
  by the boot screen and the collapsed rail is unchanged.

### Fixed

- Restored the keyboard-shortcut reference trigger (now a rail icon), which was
  lost when the conversation header was removed.

- The eager archived-sessions loader no longer refetches in a loop after a
  rejected request: `archived_sessions_failed` now claims the workspace
  (`ownerWorkspaceId`), so the App effect's guard skips settled workspaces, and
  the fire-and-forget call no longer surfaces the workspace-switch Context race
  (`The active Context changed before the operation was admitted`) as hundreds
  of unhandled promise rejections / 409 console errors.

### Changed

- **Copy thinning (T1):** removed or compressed eight explanatory paragraphs in
  Files / Git / Review / ProjectNavigator / Inspector; details moved to
  `title` / `aria` attributes (search scope, binary metadata, sensitive-content
  fence, Git read-model detail, hunk-to-composer hint, diagnostics redaction).
  Empty states follow icon + one short line.
- **Transient notices (T1):** Files/Git/Review recovery and success notices now
  fade out automatically after 4s; error notices persist until replaced
  (`useAutoNotice`).
- **Unified confirm modal (T2/D3):** the two remaining `window.confirm` guards
  — Files discard-unsaved-changes and Inspector clear-Goal — use a shared
  `ConfirmDialog` (native `<dialog>`: Esc cancel, focus trap, cancel-focused
  Enter, danger action styling).
- **Busy affordances (T2):** Files/Git/Review refresh buttons report
  `aria-busy` with a rotating icon (box size unchanged, reduced-motion aware);
  the Files save button holds a fixed minimum width so 保存/保存中… no longer
  shifts the row, and reports `aria-busy` while saving.
- **Visual convergence (T3):** resource-panel icons unified on the 12/16/20
  tiers (16px inside panels), search fields and change-list rows reuse the
  existing radius tokens, and Git group/history headings step back to muted
  11px type. No new theme tokens.
- **Banner-free chrome:** the conversation header, the left-rail brand row and
  the right-rail `PROJECT WORKSPACE` header are removed — conversation content
  now starts at the top of the column. The theme-cycle and inspector-toggle
  controls moved to the bottom of the right rail, and the left rail exposes a
  collapse control in its toolbar. Project and session rows keep the plain
  folder icon; the `orion-code` mark is used only in the rail header, the
  collapsed rail and the favicon.

### Tests

- New SSR contracts (`tests/web-ui-resource-copy-v0315.test.tsx`): thinned copy
  never returns to first paint, busy buttons idle on first paint, confirm-modal
  markup (focused cancel, danger action, closed shell), goal-clear wiring.
- E2E locators were unaffected: the only referenced copy (`二进制文件`,
  `刷新文件树`, `选择文件预览`) is unchanged.

## [0.3.14] — CANDIDATE

> **Status: candidate.** Editable Files panel (guarded `POST /files/write` with
> revision CAS) and removal of the legacy view-only controls. Not merged,
> tagged or published.

### Added

- File editing in the Files panel: content view gains a view/edit toggle; the
  edit mode is a controlled monospace textarea with dirty tracking, explicit
  save (guarded `POST /files/write`), cancel/Esc with an unsaved-changes
  confirmation, and a 409 conflict path that offers an explicit reload.
- `POST /files/write`: workspace-fenced (registry + symlink escape checks),
  sensitive-path block, 512 KiB text-only payload limit, on-disk stat
  fingerprint CAS (`file_revision_conflict`), user-gesture header
  (`file-mutation-v1`), idempotent `file.write` mutation ledger entry, and
  one-shot snapshot invalidation so Git/Review decorations refresh after a
  save.

### Fixed

- Resource refreshes keep the inspected file: `ReviewPanel` no longer drops the
  open diff on a manual refresh, a `refreshEpoch` invalidation or a Git revision
  conflict recovery; `FilesPanel` keeps the open file on refresh (still reset
  when the workspace itself changes), so the editor no longer closes mid-edit.
- The review summary counters are localised (已暂存 / 未暂存 / 未跟踪 / 冲突)
  instead of raw English labels.
- Binary detection tolerates an 8 KiB sample that ends inside one UTF-8 code
  point, so CJK files are no longer rejected as binary on read or save.

### Removed

- The read-only file toolbar: 「跳转」（line jump）, 「复制」 and 「自动换行」
  controls, the line-number gutter spans and the wrap-only styles.
- The Review panel's 「验证证据」 module: the evidence list,
  `WebReviewVerificationV1`, `ReviewServiceV1.verificationPage`, the
  `GET /review/verification` route and the snapshot's `verification` /
  `verificationTruncated` fields. The review overview is now composed only from
  Git facts; durable tool receipts remain available to the runtime.

## [0.3.13] — CANDIDATE

> **Status: candidate.** Development baseline after v0.3.12 (version bump only;
> no functional changes yet). Not merged, tagged or published.

## [0.3.12] — NPM-PUBLISHED

> **Status: npm-published.** `@orion-agents/orion-code@0.3.12` is available
> through the npm registry (latest tag). Published 2026-09-07 via PR #252;
> git tag/release may lag. Wide Right Workspace + repository-truth + guarded
> Git mutations (v0.3.12-plan) plus resource split layout, conversation
> history navigator and the unified brand mark (v0.3.13-plan v3/v4/v5).

### Added

- Wide Right Workspace logic layer: five-panel registry, per-workspace layout
  preferences (schema v4 with per-panel navigator widths), pure dock/rail/drawer
  geometry with 320px conversation minimum and 360/560/960/max snap points.
- Repository snapshot store shared by Git/Review/Files decorations
  (coalescing, one-shot invalidation, revision-stale detection).
- Progressive Review verification paging (GET /review/verification).
- Guarded Git stage/unstage/commit (POST /git/\*) with host-resolved file ids,
  repository-revision CAS and an explicit user-gesture header.
- Bounded workspace search (GET /files/search; name/content scopes).
- Context V2 file_range references (revision-bound, line-extracted, budgeted).
- **Resource split layout (v0.3.13-plan-v4):** Files/Git/Review share one
  content | splitter | navigator shell (`ResourceSplitLayout`) with explicit
  named grid areas (no more sparse grid auto-placement gaps). Git now shows its
  diff on the left, matching Files/Review. Each panel has an inner draggable
  separator measured against the split root — never the workbench shell — so
  dragging never moves the outer Right Workspace; per-workspace + per-panel
  navigator widths are persisted (300px default, 160–420px drag range,
  double-click/keyboard reset), and <=620px containers stack navigator-over-
  content and hide the handle.
- **Conversation history navigator (v0.3.13-plan-v5):** a left-inside rail on
  the loaded transcript derived from the unified order timeline. A pure bucket
  model (<=48–64 stable buckets, user/assistant/errors always visible) feeds
  decorative ticks plus one focusable `role="slider"` (Arrow/Page/Home/End,
  reduced-motion aware). An IntersectionObserver + rAF-throttled viewport
  marker tracks the reading position; pointer scrub uses capture and cancels
  pinned auto-follow; the top entry drives the existing paginated
  load-earlier. Container-query degradation: full rail >760px, compact
  641–760px, hidden <=640px with no horizontal overflow.
- **Unified Orion brand mark (v0.3.13-plan-v5 §9):** one decorative
  `OrionBrandMark` inline SVG (20×20 artboard, three bars, theme-token
  gradients with forced-colors fallback) replaces the duplicated
  `.brand-mark`/`.boot-mark` span CSS in the project navigator and boot
  screen; the mark stays aria-hidden and non-interactive.
- E2E: rail-panel scenario ids on the allowlist; real-conversation smoke spec;
  Files/Review/Git split-layout, history-rail and brand visual specs.

## [0.3.11] — NPM-PUBLISHED

> **Status: npm-published.** `@orion-agents/orion-code@0.3.11` is available through the npm
> registry (latest tag). Published 2026-09-05; git tag/release may lag.

### Added

- The right work panel becomes a **vertical-rail menu** (v0.3.8-plan carried
  forward): a persistent 48px icon rail replaces the expand-then-horizontal-tabs
  flow; clicking an icon shows exactly that panel, re-clicking collapses back to
  the rail, and Esc closes the content area (input/terminal/alertdialog
  exempted). The rail carries terminal status badges (running/queued/approval/
  failed), keyboard shortcuts (Cmd/Ctrl+Shift+1-5) jump directly without
  toggling, and the terminal keeps its xterm session while resource panels
  mount active-only. An optional user icon order is persisted in the layout
  preference (`workPanel.order`).
- Idempotency contract tests carried over from the v0.3.8 branch: reducer
  archive/restore/delete no-op and no-duplicate cases; storage archive-twice
  and restore-never-archived cases.

## [0.3.10] — NPM-PUBLISHED

> **Status: npm-published.** `@orion-agents/orion-code@0.3.10` is available through the npm
> registry (latest tag). Published 2026-09-04; git tag/release may lag.

### Added

- The local Web host defaults to port **4242** (M42, the Orion Nebula) instead of
  the generic 3080; `DEFAULT_WEB_PORT` is the single source shared by
  cli-options, launch and server.
- `orion web start [--port N]`: idempotent background-host start (prints the URL
  when already running); start/restart/`--background` share one arg builder.
- README documents the background-host lifecycle (`start|status|stop|restart`,
  pidfile/log locations) and the launchd foreground-supervision recipe.

## [0.3.9] — CANDIDATE

> **Status: npm-published.** `@orion-agents/orion-code@0.3.9` is available through the npm
> registry (latest tag); deterministic-bug-fix release + background host lifecycle
> (issue #247 S1/S2). Published 2026-09-04; git tag/release may lag.

### Added

- `orion web --background`: starts the Web Workbench host detached from the
  terminal, writes a pidfile (`~/.orion-code/web-host.<port>.pid`), redirects
  logs to `~/.orion-code/logs/web-<port>.log` and prints URL/pid.
- `orion web status|stop|restart [--port <number>]`: pidfile-based host
  management without third-party supervisors. Still binds 127.0.0.1 and keeps
  the fail-closed approval/context/sandbox semantics unchanged (issue #247).

### Fixed

- Issue-sweep triage: #222 (blank session rename), #223 (failed create leaves a
  persisted active session), #234 (URL userinfo password starting with `token:`),
  #238 (busy state-write clearing processing), #242 (stale Settings save into the
  newly active workspace) were all already resolved on `main` — closed with
  source evidence.
- Web redaction now covers uppercase X-prefixed environment assignments
  (`X_CLIENT_SECRET=…`, `CLIENT_SECRET=…`, `AUTH_TOKEN=…`) whose secret suffix
  hides behind underscore word characters (issue #241).
- Cmd/Ctrl+B can again open the Project Navigator at 761–799px: expanding the
  navigation preference now resolves to a drawer and opens it explicitly instead
  of leaving an invisible drawer (issue #226).

### Tests

- `redaction-xprefixed-env` suite: X-prefixed env values, bare uppercase
  assignments, #234 userinfo regression, #241 JSON keys.

## [0.3.7] — CANDIDATE

> **Status: candidate.** This work is isolated on the codex/v0.3.7 worktree (left project
> rail interaction quality). It is not merged, tagged or published to npm.

### Added

- Session **tags**: up to 8 user-assigned tags per Session (each ≤ 32 chars), persisted on
  the Session record (`SessionMeta.tags`), projected into `WebSessionSummaryV1.tags`,
  managed from a new "管理标签…" dialog (chip add via Enter/comma, per-chip remove) and
  rendered as small badges on rail rows. Host endpoint `POST /sessions/:id/tags`.
- Session **archive / restore**: soft delete via `SessionMeta.archivedAt` that keeps every
  file, hides the Session from default listings and counts, and surfaces it under a new
  "已归档" rail section with a 还原 action (`POST /sessions/:id/archive|restore`;
  `GET /workspaces/:id/sessions/archived`).
- Session **delete** from the web workbench: destructive confirmation dialog (explicit
  "永久删除" guard, 不可恢复 copy) wired to the existing storage `deleteSession` through a
  new `DELETE /sessions/:id` endpoint; refuse-while-busy checks in the controller.
- The rail rename affordance becomes a general **overflow menu** (`SessionRowMenu`,
  keyboard navigable ↑↓/Home/End/Esc with focus restore) hosting 重命名… / 管理标签… /
  归档 / 删除… so future per-Session actions have a stable home.

### Changed

- Active-workspace session listings (`listProjectSessions`, `listSessions`,
  `countSessionsByProject`) exclude archived Sessions by default.
- Rail footer status copy is shortened to 已连接 / 离线 / … with full sentences moved to a
  tooltip (`connectionTitle`); the collapsed rail dot keeps an accessible short label.
- Project tag chips, archived-section rows and the two new dialogs ship with their own
  styles; stale `.session-rename`/`.session-row` rules were removed.

### Fixed

- Rename failures are no longer silent: `RenameDialog` surfaces the server error inline
  (`field-error`) instead of closing without feedback.
- Session-row menu hint ids are instance-unique (`useId`) so `aria-describedby` can never
  point at another row's hint.
- The archived rail listing is bound to its owning Workspace: switching projects drops stale
  foreign archive rows immediately and never flashes another project's archive while loading;
  `session_deleted` also clears the stale runtime projection.

### Tests

- New contract suites: `web-reducer-session-lifecycle` (14, incl. owner-binding + runtime
  cleanup regression), `web-ui-SessionDialogs` (7), `web-ui-SessionRowMenu` (3),
  `web-ui-WorkspaceDialog` (6), `session-storage-tags-archive` (5, incl. delete),
  plus controller-level guards (tags validation / archive-restore / delete-while-busy /
  foreign-workspace rejection / 404) in `web-workbench-controller.test.ts`; `web-ui-*` now
  112 cases green. E2E: `web-v037-session-lifecycle.spec.ts` (archive/restore, delete-confirm,
  tags round-trip) runs in CI.

## [0.3.6] — CANDIDATE

> **Status: candidate.** This work is isolated on the codex/v0.3.6 worktree (pure web
> workbench interaction quality). It is not merged, tagged or published to npm.

### Added

- Component rendering contract layer for the web workbench: six `.test.tsx` suites
  (89 cases) assert on `react-dom/server.renderToStaticMarkup` output without jsdom —
  Markdown / StateDot / ShortcutHelp / DiffViewer / ApprovalCard / PanelResize.
- `StateDot` status indicator that never relies on colour alone (WCAG 1.4.1): every dot
  carries a shape channel via `data-tone` (square / circle / pulsing ring / hollow ring /
  triangle) plus a visually-hidden text label for assistive tech; applied to reasoning,
  research sources, review evidence and the work-panel rail.
- Single-source keyboard binding table (`shortcuts.ts`) plus a `⌘/` shortcut help dialog
  rendered from it, so the panel cannot drift from the live bindings; `matchesShortcut`
  now resolves `Esc` → `Escape` so the help vocabulary matches real key events.
- Header theme-cycle button (system → light → dark, persisted through the settings
  document); the `SettingsDialog` entry stays intact.
- Stacked notification toasts (P1-C): multiple notices queue without overwriting, each
  non-recoverable non-error notice auto-dismisses after 5s, error / recovery notices stay
  until acted on, and `aria-live` is graded (alert for errors, status otherwise).

### Changed

- `PanelResizeHandle` is keyboard reachable with full separator semantics: `role=separator`
  with live `aria-valuenow`/`aria-valuetext`, ←/→ steps of 2% (Shift 10%), Home/End jump,
  Enter/Space reset to default; stepping logic is extracted as pure functions.
- Notification region becomes a stacked container (`.workbench-notice-stack`); cards slide
  in on `opacity`/`transform` only and the whole stack is inert while drawers are open.
- Icon set gains `sun` / `moon` / `monitor` / `keyboard` glyphs.

### Fixed

- Markdown heading off-by-one: `##` renders as `<h2>` (was `<h3>`), a lone `#` no longer
  collapses to `<h6>`; >6 hashes stay a plain paragraph per GFM.

## [0.3.5] — CANDIDATE

> **Status: candidate.** This work is isolated on the codex/v0.3.5 worktree. It is not
> merged, tagged or published to npm, and exact-artifact qualification remains a separate gate.

### Added

- Version thread projection digests so v0.3.2/v0.3.3 cutover receipts keep verifying while new
  projections carry the full diagnostic/compact shape; forged digests fail closed.
- Session snapshot sync state is decoupled from the Host transport: a Session snapshot failure
  can no longer flip the live SSE to `replay-required`; Composer and command gates require both
  transport live and the foreground Session snapshot ready.
- Host and browser diagnostics counters for Session switches, snapshot cache hits/loads/latency,
  and Session actor allocation/eviction/closure, so "pure selection allocates no Runtime" is
  provable from counters instead of prose.
- Runtime ownership across Workspace Context switches: the Host-level Session registry is created
  once and preserved; control planes and Session actors borrow per-Workspace shared kernels, and
  only Host shutdown closes every actor and kernel.

### Changed

- Instant Session switching renders a cached projection immediately, refreshes with a bounded
  tail snapshot in the background, and prefetches the most recent Sessions after a baseline.
- Version and release hygiene: package identity moves to 0.3.5, `release:check` recognizes
  `codex/vX.Y.Z` and `GITHUB_HEAD_REF` release branches, and the Web rail no longer falls back to
  a hardcoded version string.

### Fixed

- Workspace Context activation no longer shuts down resident Session actors of other Workspaces
  or requires every actor to be idle before switching the active control plane.
- A failed Context activation restores the previous control plane without rebuilding the Session
  registry, so resident actors and their Runtime revisions survive the rollback.

## [0.3.4] — CANDIDATE

> **Status: candidate.** This stabilization work is isolated on the v0.3.4 worktree. It is not
> merged, tagged or published to npm, and exact-artifact qualification remains a separate gate.

### Changed

- Bind Settings writes to the active Workspace and Context revision in addition to the Settings
  document revision, so a stale browser tab cannot apply a valid patch to another Workspace.
- Preserve lexical symbolic-link identity while projecting a contained target as a file or
  directory, and expose the true changed-file total separately from the bounded Review page.
- Split exact-tgz qualification into a script-disabled identity stage and a separate lifecycle-
  enabled consumer/native stage.

### Fixed

- Keep split terminal surrogate pairs intact across delayed PTY callbacks, wait for browser write
  capacity without animation-frame spin, and drain reconnect data in replay, live-tail, exit order.
- Reject blank Session renames without changing durable metadata, and keep active-turn state intact
  when a busy-rejected slash command fails.
- Isolate concurrent command transcript capture so interleaved output cannot cross Sessions or
  leave the process-wide console bridge installed.
- Project cold and resident Composer model, Effort and permission changes from the actor Runtime's
  canonical Session instead of a pre-actor metadata copy.
- Detect binary content on every file page, render contained directory symlinks as expandable and
  label Review truncation against the true repository total.

### Security

- Redact URL userinfo and structured sensitive keys before browser/evidence projection; evaluate
  file aliases plus canonical targets and block sensitive current or rename-source Git diffs before
  starting a content process.
- Require matching, canonical-digest-verified terminal receipts and durable receipt facts before a
  modern tool result can project success.
- Fail release qualification for a failed live canary or duplicated runtime run and manifest
  evidence instead of accepting a structurally complete but non-independent matrix.

## [0.3.3] — CANDIDATE

> **Status: candidate.** The implementation and local qualification remain isolated on the v0.3.3
> worktree. It is not merged, tagged, published to npm or represented as a completed release receipt.

### Added

- Add the bundled `orion-blocksmith` pixel-workshop style as a closed built-in appearance option,
  composed with system/light/dark themes and reduced motion without remote assets or executable
  theme packages.
- Add a bounded Web Session actor registry with three running slots, four resident actors, FIFO
  overflow admission, cancellable queued turns, idle LRU eviction and explicit per-Session runtime
  revisions.
- Add the v0.3.3 OpenAPI, migration guide and exact-artifact WEB33-P0-01..12 plus
  WEB33-P0-16..24 qualification contract.

### Changed

- Make foreground Session selection browser-tab-local so a running, approval-waiting or queued
  Session continues while another Session is viewed or submitted.
- Route Session commands and Composer mutations through exact Workspace, Context, Session runtime
  and control revisions; stale operations fail closed instead of following a global active Session.
- Keep a single Workbench SSE connection while projecting Session-tagged runtime state into bounded
  per-Session browser caches.
- Package runtime JavaScript and declarations without generated source-map files, preserving local
  build maps while keeping the published artifact within the existing unpacked-size budget.

### Fixed

- Remove the global pending barrier from warm same-Workspace Session selection and restore cached
  content immediately while a guarded snapshot refreshes in the background.
- Keep the collapsed Work Panel as a right-side full-height 48px rail across desktop and drawer
  breakpoints without moving it below the conversation or creating horizontal page overflow.
- Keep the only persistent Settings entry at the lower-left project rail and restore focus after a
  successful Settings save.
- Raise Orion Blocksmith light-theme muted text contrast to WCAG AA for small labels and empty-state
  copy.

### Security

- Serialize same-Workspace mutating Tool steps through a shared arbiter while preserving independent
  actors for non-conflicting work; stale file baselines are rejected before side effects.
- Bind queued-turn cancellation, approvals, Goal/Plan controls and structured Context references to
  the intended Session actor, with zero cross-Session provider, Tool, journal or file effects on
  revision conflict.

## [0.3.2] — CANDIDATE

> **Status: candidate.** Source, API and browser qualification are being frozen together. This is
> not a Git tag, GitHub Release or npm publication until the exact-artifact receipts exist.

### Added

- Add an IDE-style left project navigator that expands, collapses to a 48px rail and mouse-resizes
  from 240–480px while preserving a 560px conversation floor and responsive drawer preferences.
- Add a Composer Control Center for BUILD/PLAN/AUTO, Session permission, model, Effort and
  Runtime-projected Context usage, including pending/last-good/error/retry states.
- Add structured file/folder/review/session/Skill Context references with Host-side containment,
  sensitive-data, revision, digest and prompt-budget validation.
- Add durable Plan review with exact-digest approve, continue-planning and cancel operations that
  survive refresh, replay and Host restart without auto-executing an unreviewed Plan.
- Add revisioned queue edit/move/remove and Session-scoped tab-local draft recovery.
- Add the v0.3.2 OpenAPI, mode/permission contract, migration guide and exact-artifact
  WEB32-P0-01..12 qualification contract.

### Changed

- Replace the three Composer mode buttons with accessible menus and keep workflow mode independent
  from tool authorization; explicit Deny and hard Policy remain stronger than AUTO or Allow.
- Make active-turn model changes deferred to the next logical request and require verified compact
  before switching to a smaller safe context window, with complete rollback on failure.
- Project provider or explicitly estimated Context usage from Runtime instead of reconstructing
  token capacity in the browser.

### Fixed

- Keep the left/right desktop widths stable across narrow-screen drawers, reloads and 200% zoom;
  bound controls and Context chips without covering the textarea or send action.
- Consume expected UI mutation rejections after the shared operation layer has projected the error,
  preventing a deliberate 409 CAS conflict from becoming an unhandled browser page error.
- Require a matching active-session snapshot after replay reset before re-enabling the Composer.

### Security

- Bind Composer, queue and Plan mutations to exact Workspace/Session/Context/control revisions and
  fail stale operations with zero provider, ToolGateway, file or queue side effects.
- Revalidate every structured Context reference at prompt assembly and keep sensitive/raw content
  out of the DOM, SSE, screenshots and release evidence.

## [0.3.1] — CANDIDATE

> **Status: candidate.** This branch carries the v0.3 Web quality and long-session recovery fixes.
> It is not a Git tag, GitHub Release or npm publication until those receipts exist.

### Added

- Add a registered multi-project navigator with lazy inactive-project Session pages and one atomic,
  revision-guarded active Workspace/Session transition.
- Add a professional right work dock for Agent, Review, Terminal, Files and Git, with an IDE-style
  mouse-resized 320–720px desktop panel and responsive drawers that preserve desktop width.
- Add bounded, revisioned read models for workspace-contained files, Git status/log/diff and review
  metadata, plus an explicit real-PTY terminal with short-lived WebSocket attach tickets.
- Add the v0.3.1 OpenAPI, migration guide and exact-artifact WEB31-P0-01..12 qualification contract.

### Changed

- Extend full browser qualification to 34 scenarios and the Node 22.12/24/26 critical matrix to 24
  scenarios, all bound to one source-clean tgz, installed-target identity and real Chrome runner.
- Raise the packed-package ceiling from 2.00 to 2.25 MiB for the bundled xterm client while keeping
  the 10 MiB unpacked and 1,500-entry limits unchanged.
- Keep terminal output off the Workbench SSE and durable Session history; Host restart reports the
  terminal as lost instead of fabricating recovery.

### Fixed

- Keep the conversation composer in a bounded bottom dock while transcript history and pending
  approval or follow-up content scroll independently.
- Bind Web commands and recovery snapshots to the active Session, make replay reset a terminal
  barrier, and preserve Session-scoped drafts across navigation.
- Serve large tool output only from a browser-safe derivative so arbitrary byte offsets cannot
  bypass redaction.
- Persist verified Thread heads and immutable transcript pages, use revision-bound collection
  cursors, and load additional browser history explicitly instead of draining every page at boot.

### Security

- Require UUID idempotency keys and current Workspace/Context guards for v0.3.1 resource operations;
  stale guards return `context_revision_conflict` with zero side effects.
- Bind every WEB31 screenshot and high-risk structured fact into the Web E2E receipt, including
  context targeting, PTY orphan count, SSE/WS isolation, axe and secret gates.

## [0.3.0] — CANDIDATE

> **Status: candidate.** This source version is not a Git tag, GitHub Release or npm publication
> until those external receipts are created and read back separately.

### Added

- Add `orion web`, a loopback-only React workbench for workspace/session navigation, streaming
  conversation and tools, follow-up/interrupt, approvals, Goal/Plan, model/effort settings,
  Skills/MCP metadata, large-output inspection and diagnostics.
- Add a versioned same-origin Web API with bounded cursor pagination, process-lifetime idempotency
  keys, settings compare-and-swap, session recovery snapshots and a replayable SSE event stream.
- Add a Host-owned Settings subsystem with strict typed reads, keyed exact-byte revisions,
  raw-preserving atomic batch updates, lock-inside CAS, external-edit convergence, last-good
  recovery and browser conflict handling.
- Add the source-audited v0.3.0 product plan, OpenAPI contract and v0.2.2 migration/rollback guide.

### Changed

- Set the release-qualification contract to maintained Node 22.12+, 24 and 26; publication now
  requires exact-tarball native SQLite, CLI, TUI, Web and fail-closed evidence on every line.
- Extract the CLI composition into one shared product bootstrap so Web, TUI, terminal and print
  retain the same AgentRuntimeController, OrionSessionRunner, OrionRuntime and durable stores.
- Resolve new root/child runtimes from the selected model profile and support exact
  BUILD/PLAN/AUTO selection at the next logical-request boundary.
- Align durable approval scopes with the product permission store as `once`, `project`, `global`.
- Route Web, TUI and slash-command changes for default model, project/global effort and tool
  confirmation through one Settings coordinator; keep the current-session model distinct from the
  default for newly created sessions.

### Security

- Bind Web only to `127.0.0.1`; require exact Origin, per-process nonce and JSON for mutations; cap
  bodies and pages; reject Host/path-boundary violations; and send restrictive browser headers.
- Keep pending approvals runtime-owned across browser disconnects, redact browser-safe projections,
  expose no provider credentials, and disconnect slow SSE clients so they recover by cursor rather
  than growing an unbounded response buffer.
- Expose credential readiness only, keep the configuration-file action pathless, preserve invalid
  external bytes, and require Runtime-idle mutation for settings that alter execution policy.

## [0.2.2] — 2026-08-27

> **Status: published.** The `v0.2.2` tag and npm `latest` package identify this release tree.

### Fixed

- Isolate Session discovery from malformed historical model context so one interrupted V2 Thread
  cannot block `/session`, `/resume --last`, or a healthy explicit resume for the whole project.
- Recover incomplete imported tool-call groups as explicit cancelled tool results before provider
  requests, retain the original transcript facts, and surface typed recovery provenance to users.
- Keep compact Goal token usage visible ahead of long objective text on narrow TUI status rows while
  preserving Goal escape controls and the purple mode override.

## [0.2.1] — CANDIDATE

> **Status: candidate.** This source version is not a Git tag, GitHub Release, or npm publication
> until each external receipt is created and read back.

### Fixed

- Project session discovery now projects message count, durable history size, and last activity
  from the authoritative v2 Thread instead of treating an empty legacy JSONL sidecar as the session.
- `/resume` and `/resume --last` restore the latest TurnCommit model history and replay the selected
  Thread into the UI exactly once without starting an extra model turn or duplicating user input.
- Runtime restart treats legacy Harness and Goal sidecars as first-migration seeds only; once a
  TurnCommit exists, its TaskContext and Goal state remain the sole durable authority.
- TUI submission uses the durable Thread user item as its only transcript echo, including queued
  revisions, so one user input renders as one entry.
- TUI context pressure now flows from the product Agent Loop into a live, width-prioritized `CTX`
  percentage instead of disappearing until the turn completes.
- Goal V2 TurnCommits now restore the purple Goal mode chrome, clear it on completion, and display
  only compact cumulative usage such as `tokens:581.6K` instead of an internal unlimited sentinel.
- Cross-process file locking no longer lets healthy contenders starve the active owner through the
  recovery sentinel; stale recovery remains serialized and fail-closed.

## [0.2.0] — CANDIDATE

> **Status: candidate.** Implementation evidence does not imply a Git tag, GitHub Release, npm
> publication, or dist-tag promotion. Those receipts remain pending until performed and read back.

### Added

- Add the versioned `Thread → Turn → Step → Item` runtime protocol, append-only Thread event store,
  deterministic projection/replay, bounded renderer buffering, and typed admission for start, steer,
  follow-up, interrupt, overload, and maintenance.
- Add immutable Step Snapshots and Capability Receipts binding model, prompt, Authority, Policy,
  selected Skills/MCP, visible schemas, exact executors, and durable per-request lineage.
- Add a single ToolGateway execution boundary for core, long-tail, nested batch, MCP, Skill, and
  subagent invocations through Capability → Policy → Approval → Sandbox → Execute.
- Add descriptor-first lazy Skill and MCP runtimes with scope layering, bounded caches, digest
  invalidation, single-flight loading, exact server leases, idle teardown, and crash isolation.
- Add Prompt Registry budgets, stable prefix receipts, first-party contributor slots, redaction,
  and deterministic omission reasons.
- Add transactional Compact maintenance, atomic TurnCommit, Goal Runtime V2, durable PlanReceipt,
  modern child Thread runtime, and a side-by-side legacy Session materializer with atomic index
  cutover.
- Add machine-readable Harness benchmark/eval, architecture confluence, exact tarball, Node 20/22/24
  runtime matrix, gate evidence, and aggregate ReleaseReceipt contracts.

### Changed

- Replace the legacy Brain/Agent/Harness/query runtime graph with one statically composed product
  Runtime and one Agent Loop implementation for root and child turns.
- Reduce the ordinary coding schema from the frozen v0.1.9 baseline of 33 tools / 20,596 bytes to
  7 exact core schemas / 3,947 bytes; long-tail capabilities are selected or deferred by task.
- Make `/plan <task>` commit a PlanReceipt and exit automatically; implementation starts in a new
  logical turn after BUILD/AUTO is restored.
- Let productive Goals continue without a fixed turn-count cap; evidence audit, resource budget,
  no-progress, blocker, provider, persistence, interrupt, and completion decisions remain explicit.
- Keep BUILD/PLAN/AUTO as workflow modes independent from Authority and tool permission policy.

### Removed

- Remove the Ink renderer, legacy Agent/Brain/Harness/SDK public surface, global `TOOLS` and eager MCP
  singleton, compatibility command roots, and direct model→tool execution bypasses from the package.
- Remove `/target`, `/mode`, model-facing `enter_plan_mode`/`exit_plan_mode`, and legacy Goal mutations
  `/goal exit|edit|replace|confirm|budget` plus `clear --yes`.

### Security

- Freeze exact schema/executor/Authority/Policy bindings per model request and fail closed on digest
  or catalog drift.
- Preserve project-boundary, symlink, sandbox, destructive-command, cancellation, durable receipt,
  and indeterminate-side-effect enforcement across all modes and nested execution.

## [0.1.9] — CANDIDATE

> **Status: candidate.** Source, CI, exact tarball, npm `next`, tag, GitHub Release, and stable
> `latest` are independent receipts. This section must be updated after each delivery action; it
> does not claim publication in advance.

### Added

- Add a typed semantic Compact pipeline with atomic message groups, canonical fingerprints,
  structured ContextItems, TaskContract/evidence/capability reinjection, bounded manual focus, and
  deterministic fallback diagnostics.
- Add Compact Checkpoint V2 receipts with source/replacement hashes, target-headroom validation,
  Harness/Goal bindings, transactional candidate installation, rollback, and V1 read compatibility.
- Add HarnessKernel TaskContract V3 criteria, evidence-to-criterion receipts, deterministic state,
  Capability Profiles, ProgressDelta, and typed StopDecision projections.
- Add mature-agent Compact benchmark fixtures and lifecycle trace events for prepare, validate,
  commit, rollback, and boundary transitions.
- Add bounded project-level `compactInstructions` for manual and automatic compaction; caller
  guidance remains subordinate to protocol, safety, criteria, evidence, failures, and pending work.

### Changed

- Replace Goal's fixed five-continuation stop with criterion/evidence completion, no-progress,
  blocker, provider, explicit budget, and user-abort decisions. Resource circuit breakers remain
  bounded and resumable.
- Bind subagent reservations to child query/provider accounting; keep deprecated turn fields only
  as compatibility inputs rather than task-complete semantics.
- Load a bounded memory index at startup and retrieve relevant content per turn with an auditable,
  body-free prompt manifest.
- Extend `/context explain` with section budgets, capability identity, output/safety reserves, and
  the latest committed Compact receipt.

### Fixed

- Serialize usage JSONL appends with an independent cross-process lock and replay-safe request IDs
  (#206).
- Contain project context, project instructions, and explicit skill reads at a canonical project
  boundary; project-provided `@file` content remains untrusted data (#207).
- Make smaller-context model switches run and commit a semantic preflight before changing the
  active model.
- Reject stale Compact candidates when the transcript tail or active checkpoint changes between
  prepare and commit, while preserving append-only session history.
- Stop treating request/tool budgets or an unsatisfied completion gate as successful task
  completion; render resumable typed decisions consistently.

### Security

- Reject symlink and non-regular project context paths, revalidate opened descriptors, and redact
  boundary errors without exposing out-of-project file contents.

## [0.1.8] — 2026-08-15

> **Status: published.** Tag `v0.1.8` identifies the source;
> `@orion-agents/orion-code@0.1.8` is published through the npm `next` dist-tag.
> Stable `latest` remains `0.1.4`; promotion is a separate decision.

### Added

- Add schema-level and scheduler-level finite safe-integer validation for bounded tool inputs,
  including `exec_command.timeout`, `exec_command.maxOutputBytes`, and `list_files.maxDepth` (#203).
- Add a renderer-neutral budget-stop view with usage, last completed work, and visible recovery
  actions across TUI, terminal, print, JSON, and `/loop-stats` (#204).
- Add typed tool-authorization provenance and an explicit BUILD/PLAN/AUTO network-permission
  architecture contract; AUTO stays prompt-free after hard policy and explicit deny checks (#175).
- Add repository-layout, cleanup-manifest, and per-issue verification ledgers for auditable release
  ownership and recovery.

### Changed

- Restrict the npm package to the single runtime icon and enforce packed size, unpacked size, entry
  count, required files, and unexpected-path budgets during release checks.
- Move maintained scripts into `scripts/release`, `scripts/smoke`, and `scripts/maintenance`; archive
  historical v0.1.x plans under `docs/archive/releases/v0.1.x`.
- Enforce renderer command scope before special command dispatch, integrating the behavior reviewed
  in PR #201 for issue #179.
- Keep session transcript append metadata incremental and cover a 5,000-row history without a
  full JSONL rescan (#172).

### Fixed

- Publish file-lock owner metadata atomically and quarantine stale legacy zero-byte recovery
  sentinels so an interrupted writer cannot permanently block `/resume`.
- Verify the existing security, persistence, TUI/performance, release/dependency, and Goal lifecycle
  candidate fixes for issues #170–#200 with focused regression batches and real renderer smokes.
- Keep Goal completion evidence durable across failure, compact, restart, and resume, then
  automatically leave Goal mode after a passing audit (#189).
- Update PTY harnesses to current provider profiles and durable trace/status assertions so the
  release matrix exercises source code without deprecated configuration fallbacks.

### Removed

- Remove 18 unreferenced tracked documentation images, 15 superseded `test-runtime` probes, the
  unused `src/ink` helper, and the unreferenced `src/ui-v2` experiment after replacement mapping.

## [0.1.7] — 2026-08-13

> **Status: published.** Tag `v0.1.7` and its GitHub prerelease identify the source;
> `@orion-agents/orion-code@0.1.7` is published through the npm `next` dist-tag.
> Stable `latest` remains `0.1.4`; promotion is a separate decision.

### Added

- Add `/plan [task]` as the task-scoped, read-only planning entry with an automatically saved exit
  transition and restoration of the previous interactive/auto mode.
- Add an original Orion Pixel terminal identity with a portable pixel mascot, semantic poses,
  restrained motion, and safe classic/NO_COLOR/narrow-terminal fallbacks.
- Add persisted TUI themes, motion, mascot, status-line, and semantic keymap configuration plus
  `/theme`, `/keymap`, `/statusline`, and `/queue` command surfaces.
- Add a bounded shared-runtime follow-up queue: Enter steers the active turn while Tab queues FIFO
  work without interrupting it.

### Changed

- Remove the `/mode` command and its `/perm` compatibility alias. Base modes now change only through
  `Shift+Tab`; `/plan` remains the task entry and model-driven `enter_plan_mode` stays unavailable,
  so Plan state has one lifecycle authority and completion never starts implementation in the same
  turn.
- Replace renderer-local status strings with a typed Chrome projection for Goal, model, permission,
  context, effort, queued follow-ups, and active work.
- Complete Ctrl+R history search, Ctrl+E external composition, empty Ctrl+D exit, and Esc-owned
  interruption behavior while preserving native terminal scrollback.
- Show stable sequence numbers for active subtasks and keep critical Goal, evidence, research, and
  permission state visible before lower-priority chrome.

### Fixed

- Automatically exit Goal mode after a persisted passing completion audit, restore the underlying
  BUILD/PLAN/AUTO mode, retain the completed Goal sidecar as an audit receipt, and reconcile the
  narrow crash window where the terminal sidecar was saved before the session binding was cleared.
- Route explicit `exit goal mode` / `退出 goal 模式` intent through the same deterministic runtime
  clear boundary as `/goal exit`, reject completion retries without new runtime evidence, and cap
  each autonomous continuation below fresh-user loop budgets.
- Sanitize every dynamic startup-banner field, including 8-bit C1 CSI/OSC forms, before writing it
  to the terminal (#164).
- Serialize global configuration read-modify-write transactions across processes and add an atomic
  session catalog for indexed lookup and bounded listing (#157, #159, #163).
- Reject brace-quantified and overlapping-alternative ReDoS patterns, while distinguishing benign
  command substitution from visible recursive deletion in permission policy; contain command cwd
  inside the workspace across permission and execution paths (#160, #162, #169).
- Require explicit risk metadata on every built-in slash command, cover drift-guard prepare/execute
  enforcement and session rename success/scoping, and make coverage a release gate (#158, #166,
  #167, #168).
- Pin all third-party GitHub Actions in CI to immutable commit SHAs (#165).

### Compatibility

- `/goal exit` remains the canonical slash command; explicit natural-language exit intent is routed
  to the same operation. Removed `/goal clear --yes` and `/target clear --yes` syntax is still
  rejected and is not restored as a compatibility alias.

## [0.1.6] — 2026-08-12

> **Status: published.** Tag `v0.1.6` and its GitHub Release identify the source;
> `@orion-agents/orion-code@0.1.6` is published through the npm `next` dist-tag.
> Stable `latest` remains `0.1.4`; promotion is a separate decision.

### Changed

- Require explicit user authorization before a model-created Goal can become active and bound
  non-user continuation loops so a Goal cannot run indefinitely without returning control (#150).
- Replace destructive Goal clearing with `/goal exit`, which aborts the active turn, rejects any
  pending permission request, and clears persisted Goal state. The old `/goal clear --yes` and
  `/target clear --yes` forms are intentionally rejected rather than retained as aliases.
- Make the default dependency-health report reproducible without registry access; registry-backed
  `npm audit` and `npm outdated` reports now require explicit `--full-network` (#155).

### Fixed

- Preserve `vector.db` during brand migration when native SQLite verification is unavailable and
  report the actionable ABI/rebuild cause instead of misclassifying it as corruption (#149).
- Remove real embedding-provider calls from vector tests, make source-only import tests independent
  of prebuilt `dist/`, and select installed Node runtimes by numeric version (#140, #144, #146).
- Keep dependency policy mandatory in prepublish/release gates and synchronize release version
  claims across README and release metadata (#129, #147).
- Anchor macOS seatbelt secret-file denies to the stable project root and make `exec_command`
  permission prechecks use the same explicit command cwd as execution (#151, #153).
- Strip ANSI/OSC/C0/C1 control sequences from terminal-ui transcript and streamed assistant output
  before it reaches the terminal writer (#154).
- Make memory drift validation perform a bounded project symbol scan, expose it through
  `/memory validate`, and fail inconclusive scans closed instead of silently accepting them (#156).

### Compatibility

- This pre-1.0 release contains an intentional command-line breaking change: scripts using
  `/goal clear --yes` or `/target clear --yes` must migrate to `/goal exit`. Goal/session storage
  remains additive and compatible; the removed command syntax is not supported as an alias.

## [0.1.5] — 2026-08-11

> **Status: npm-published.** `@orion-agents/orion-code@0.1.5` is available through the npm
> `next` dist-tag. No `v0.1.5` Git tag or GitHub Release exists, and stable `latest` remains
> `0.1.4`; those delivery states are intentionally recorded separately.

### Added

- Added a typed slash-command descriptor registry, exact invocation grammar, compatibility
  lifecycle metadata, busy policies, and canonical `/goal`, `/session`, `/context`,
  `/commit-plan`, `/rewind`, `/subagents`, and `/effort` control surfaces.
- Added provider-aware effort capability resolution, scoped persistence, immutable retry
  snapshots, structured renderer events, and additive reasoning/effort usage ledger metadata.

### Changed

- Split agent mode from tool permission policy and constrained the empty command palette to a
  primary, searchable surface while retaining explicit advanced and compatibility commands.
- Made dependency, Jest-major, tag/changelog, and prepublish checks fail closed.
- Made the dependency policy reject runtimes outside the declared Node 20/22/24 matrix (#133).
- Added version-tag CI triggers, synchronized the Jest 29 lockfile, and moved the candidate
  package/install metadata to `0.1.5` (#134, #135, #141).
- Made the dependency policy prove the installed OpenAI client on each CI runtime instead of
  inferring Node support from an engine-string regex, and added a real sqlite-vec load/query
  probe (#137, #142).

### Fixed

- Canonicalized recursive `rm` targets before safety evaluation and routed batch confirmations
  and local fast paths through the shared permission policy (#125, #126, #132).
- Repaired Goal completion audit persistence, entity decoding, confirmation fallback, and TUI
  submission/projection behavior (#127).
- Classified every recursive `rm` flag form as destructive so broad tool rules cannot silently
  approve shell deletion (#136).
- Made concurrent session registration reserve capacity atomically across processes,
  with atomic heartbeats and serialized stale-lock recovery (#121).
- Serialized session transcript, metadata, statistics, summaries, and deletion updates under a
  per-session cross-process lock so counters cannot lose concurrent writes (#138).
- Deferred native SQLite loading to semantic-storage boundaries and added actionable
  ABI diagnostics for memory, maintenance, migration, and dependency checks (#111).
- Removed real Ollama/OpenAI calls from vector unit tests by using deterministic embedding
  fixtures, eliminating timeout-driven release flakiness (#139, #140).

## [0.1.4-2] — 2026-08-09

> **Status: published.** Tag `v0.1.4-2` exists and the package is on npm
> (`@orion-agents/orion-code@0.1.4-2`, `next` dist-tag). Stable `latest` remains `0.1.4`.

### Changed

- Split the slash-command registry and chat runtime into bounded modules, removed
  deprecated OpenHorse type aliases, and made strict lint rules fail the build.
- Upgraded the OpenAI SDK to the Node-20-compatible 6.x line, removed unused runtime
  dependencies, and added automated dependency policy/update checks.
- Added structured diagnostics, provider recovery metrics, runtime-matrix CI, and
  real PTY research lifecycle coverage.

### Fixed

- Closed persistence races, checkpoint corruption/rollback gaps, task-capacity and
  response-parsing bugs, tool-call group corruption, context compaction errors, and
  provider retry/stream recovery inconsistencies.
- Hardened forked-agent capabilities, harness evidence/sandbox enforcement, AWS auth,
  command execution gates, and macOS sandbox fail-closed behavior.
- Completed the research contract across controlled web access, redirects, budgets,
  atomic CAS persistence, citation durability, renderer events, and restart/resume.
- Added conversational Goal abandonment with explicit user authorization and corrected
  Goal boundary/audit/no-progress semantics.
- Made `prepublishOnly` build before the release pack gate so clean checkouts and final
  tarballs are validated against the same generated `dist` output.

## [0.1.4] — 2026-08-06

> **Status: published.** Tag `v0.1.4` exists and the package is on npm
> (`@orion-agents/orion-code@0.1.4`, `latest` dist-tag). Released 2026-08-06.
> Work that remains a worktree-only draft carries no release promise (see legend).

Aligns `package.json` / `package-lock.json` with the `v0.1.4` release so the
CLI banner, HTTP `User-Agent`, and crash/telemetry reports stop misreporting `0.1.3`.

### Changed

- **Release metadata (#10):** bumped `package.json` and `package-lock.json` to
  `0.1.4` so `orion --version` and the outbound `User-Agent` reflect the development line.
- **Type safety (#5):** removed ~22 `any` usages (120 → 98 on the committed tree):
  - native `Intl.Segmenter` typing via the `ES2022.Intl` `lib` (no more `(Intl as any)` casts);
  - typed SQLite rows in `src/memory/vector-store.ts` (`MemoryRow` / `MemoryVectorRow`);
  - `unknown`-typed task params in `src/services/task-manager.ts`;
  - typed provider-error messages in `src/services/provider-resilience/error-classifier.ts`.

### Fixed

- **Lint (#6):** resolved unused-vars / prefer-const warnings and removed dead code
  (17 ESLint `no-explicit-any` / unused-var alerts cleared).

## [0.1.3] — 2026-08-05

> **Status: published.** Tag `v0.1.3` exists and the package is on npm
> (`@orion-agents/orion-code@0.1.3`). The model-config subset (`/model` / `/models`)
> is merged; the security/tooling subset below shipped in this release.

This release hardens the execution surface (sandbox POC, tool-allowlist ReDoS,
plan-mode bypass, SSRF / API-key leakage) and rounds out developer-facing tooling
(git tools, TUI permission interaction, incremental input, goal-tool diagnostics).

### Added

- **Shell sandbox POC** (`src/tools/sandbox.ts`)
  - Commands are wrapped as an **argv array**, never re-parsed by an intermediate shell
    (eliminates quote-injection surface).
  - **Runtime backend probes** for `seatbelt` / `bubblewrap` / `docker` via `spawnSync`
    — capability is never inferred from `which`.
  - **Fail-closed**: a configured profile that cannot be applied (no backend, unusable
    backend, unknown profile/backend) **refuses execution** instead of silently degrading.
  - Default `profile: 'none'` is fully backward compatible with the legacy `sh -c` path.
  - Docker backend runs with a **`--read-only` rootfs** and explicit `rw` bind-mounts for
    the workspace + tmp + user `writableRoots`; network is blocked unless `allowNetwork`.
  - Wired into `src/tools/index.ts` (`exec_command` plan + `checkPermissions` gate) and
    `src/services/global-config.ts` (`sandbox` config at global + project scope).
- **Git tooling** (`src/tools/git.ts`)
  - Structured read-only `git_diff` / `git_log` / `git_branch` / `git_status`
    (with ahead/behind for the tracking branch).
  - Risk-graded `git_commit` (state-write, `isDestructive() => true`) and the pre-existing
    `git_push`. There is **no** `git_stage` tool; staging happens via `git_commit`'s
    `paths` / `all` arguments.
  - All paths confined to the repository; `paths` rejects glob / pathspec syntax;
    output is redacted.
  - ⚠️ **Known gap**: `git_commit({ all: true })` stages _every_ tracked modification.
    The index snapshot / rollback and user-visible preview required by plan §P1-C are
    **not implemented** — prefer explicit `paths`.
- **TUI permission interaction** (`/permissions` command)
  - Toggle tool-confirmation live; immediately rewrite in-memory config **and** persist to disk.
  - Status-bar `perm:` chip reflects the current mode; a system confirmation message is appended
    to the session. A failed `updateGlobalConfig` leaves the in-memory state unchanged.

### Changed

- **Tool allowlist — ReDoS hardening** (`src/services/tool-allowlist.ts`)
  - Regex-compiled glob matchers replaced by a **linear dual-pointer matcher**
    (`O(pattern × subject)`, `O(1)` extra state, no catastrophic backtracking). Regressed by a
    pathological `(a*)*b`-style input test.
- **Plan-mode bypass fixed** (`src/framework/tool-scheduler.ts`)
  - Plan-mode commands no longer short-circuit permission checks with a default allow; they go
    through the same gating as interactive mode.
- **SSRF / API-key hardening** (`src/tools/web.ts`, `src/utils/mask.ts`)
  - Per-hop redirect host checks, a response-body hard cap, and full API-key masking in logs/output.
- **Incremental input during a running turn**
  - Supplementary user input is echoed immediately (G1), accumulated without loss (G2),
    dedupe-guarded, and reflected in status text (G4).
- **Goal tools** (`src/runtime/goals/tools.ts`)
  - `update_goal` / `update_goal_plan` / `create_goal` failures now return a **diagnostic `output`**
    instead of an empty string.
- **Config model** (`src/services/global-config.ts`)
  - `sandbox` config at both global and project scope, with documented schema / defaults / migration /
    redaction / rollback (P1-E). Project config shallow-overrides global per key.

### Security

- Sandbox execution is fail-closed and verifiable: on hosts with a usable backend, the OS-enforcement
  assertions exercise **real kernel-level confinement** (Docker `--read-only` + bind-mounts verified on macOS).
- Allowlist matching is ReDoS-safe.
- Web tool rejects redirect-based SSRF pivots and never leaks API keys in output.

### Out of scope (this release)

Deliberately deferred to a later version per the architecture review
(`docs/archive/releases/v0.1.x/v0.1.3-2-plan.md`):

- **Hook system (#27)** — external scripts expand the permission / timeout / secret / audit surface and
  need a standalone technical design.
- Several `v0.1.3-2` plan items (writable / background sub-agents, generic MCP SSE/HTTP/OAuth, queue
  injection / project-instruction files, custom slash commands, domestic-differentiation, Goal self-repair)
  are tracked for **v0.2**.

### Evidence

Verified by `npm run release:check` on **2026-08-05**:

- **Full Jest suite (Node 24.14.0): 3045 tests — 3042 passed, 1 failed, 2 skipped; 179 suites passed.**
  The single failure is `tests/terminal-ui-pty.test.ts` (sandbox `safe-delete` `EACCES`) → `not_run`.
- Focused v0.1.3-2 suites: `sandbox` 30 (incl. live Docker OS-enforcement assertions),
  `tool-allowlist` 38, `web-ssrf-bypass` 21, `git-tools` 7, plus `tool-confirmation` /
  `permission-mode` / `incremental-input` / `goal-tools` / `tool-scheduler` / `config`.
- `tsc --noEmit` **0 errors**; ESLint **0 errors / 137 warnings** (pre-existing `no-explicit-any`).
- `npm pack --dry-run` OK — 1098 files, 5.23 MB unpacked.
- CI / real-PTY / tarball clean-install evidence remains environment-gated and labelled `not_run`
  rather than substituted by a local green run.

**Corrections to earlier claims.** The previously reported "10 focused suites: 173/173" was a
cherry-picked subset that excluded failing suites. A full run surfaced pre-§8 test rot in
`tests/agent-runtime-controller.test.ts`, `tests/runtime-ui-parity.test.ts` and
`tests/turn-controller.test.ts` (they asserted latest-only revision semantics and the old
English status strings). These were realigned with the §8 G1/G2 design — the product behaviour
was not changed. The PTY smoke scripts `scripts/terminal-ui-pty-smoke.py` /
`scripts/tui-ui-pty-smoke.py` were updated to wait for the current Chinese status text.

> Run the suite with **Node 24.14.0**. Node 22 produces 14 spurious `better-sqlite3` failures
> (native module built for `NODE_MODULE_VERSION 137`, Node 22 requires `127`).

### Still open (release gate)

- `docs/archive/releases/v0.1.x/targets-v0.1.3-v0.1.3-2.md` P0-C Goal sidecar overwrite protection — `unverified`.
- Worktree not yet frozen into a commit (index currently holds the 42 in-scope files).
- No `v0.1.3` tag; not published.

## [0.1.2] — 2026-08-02 · Published (tag `v0.1.2`)

Goal reliability release. Typed continuation for a single session with a single active Goal;
safe pause after restart/resume requiring explicit recovery; runtime evidence ledger with
per-criterion completion audit and precise stop reasons; confirmation was single-session scoped.

## [0.1.1] — 2026-07-31 · Published

Command contract, TUI as the default path, OpenHorse migration and data-safety convergence;
terminal-ui repositioned as the diagnostics build, Ink formally deprecated.

## [0.1.0] — 2026-07-28 · Published

First public TUI baseline.

---

## Maintenance rules

1. Run `npm run release:check` before every release. It verifies version consistency
   (`package.json` / `package-lock.json` / both README install pins / the Chinese README
   "current version" marker), CHANGELOG presence, `git diff --check`, worktree cleanliness,
   lint, types, the full test suite, and `npm pack --dry-run`.
2. `release:check` is **read-only**: it never runs `git tag`, `git push`, PR, merge or
   `npm publish`. Those stay separately authorized.
3. When an entry moves Candidate → Merged → Published, **move it to the matching section**.
   Leaving a stale status label is a release-gate failure.

(Legacy release notes under `docs/mvp/` are not maintained in this file.)
