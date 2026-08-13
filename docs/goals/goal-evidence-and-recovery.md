# Goal Evidence and Recovery

Since v0.1.2, Orion Code supports one persistent Goal per session. The npm `next=0.1.6` line preserves this contract;
v0.1.6 tightens authorization and exit behavior without changing the additive Goal storage schema. New command or
ACP clients must reuse the same Goal, evidence, permission, and recovery rules.

## Lifecycle

```text
/target <objective>
  -> active typed continuations
  -> runtime evidence ledger
  -> criterion audit
  -> complete | paused | blocked | usage_limited | budget_limited
```

Use `/goal` to inspect the current state, `/goal pause` to stop automatic continuation, and
`/goal resume` to continue a recoverable Goal. A passed completion audit automatically clears the
session's active Goal binding and exits Goal mode while retaining the completed sidecar as a durable
receipt. `/goal replace <objective>` creates a new goalId;
`/goal confirm <criterion-id>` records trusted human acceptance only for a criterion that explicitly requires
`user` evidence; `/goal exit` immediately stops Goal-owned execution and removes the Goal sidecar.
The old `/goal clear --yes` and `/target clear --yes` forms are intentionally rejected in v0.1.6.

## Completion evidence

The model cannot mark a Goal complete by writing a confident final message. It may call `update_goal`, which only
records a request bound to the current turn, goalId, and revision. The coordinator then audits each criterion against
runtime-captured records such as tests, builds, lint checks, file mutations, runtime checks, external checks, or
explicit user confirmation.

Evidence must be passing, traceable, accepted by the criterion, and fresh. Missing, failed, wrong-kind, wrong-Goal,
expired, or stale-workspace evidence keeps the Goal open and exposes the remaining requirement.

For multiple criteria, the model follows a verifiable sequence: run the checks, call `get_goal` to read the
criterion IDs and redacted runtime-captured evidence IDs (including evidence from the current turn), then call
`update_goal` with an explicit criterion-to-evidence mapping. The runtime validates every referenced ID again before
the completion audit; there is no automatic single-criterion mapping, and invented IDs or wrong-kind evidence are
rejected.

## Restart and resume

An active sidecar is never allowed to resume tools invisibly after a process restart. Orion loads it as paused and
shows the restored Goal. Run `/target resume` when you are ready. The continuation request is internal runtime state,
not a persisted user transcript entry.

## Storage and recovery

Goal data is stored beside the session as an additive version-1 JSON sidecar. Writes are atomic and guarded by a
revision compare-and-swap check. v0.1.1 sidecars remain readable. Invalid sidecars are quarantined rather than
silently overwritten. Storage repair or destructive cleanup must remain preview-first and require exact confirmation.
`/doctor` performs a separate read-only scan for corrupt, orphaned, metadata-mismatched, and stale temporary Goal
sidecars; it does not delete, quarantine, or rewrite files.

### Locate and back up Goal state

For a project, the session directory has this shape:

```text
${ORION_CODE_CONFIG_DIR:-~/.orion-code}/projects/<project-key>/sessions/
  <session-id>.json
  <session-id>.jsonl
  <session-id>.goal.json
```

The project key is derived from the canonical project path. Run diagnostics from the target project, then locate the
exact sidecar before changing versions or attempting manual recovery:

```bash
orion doctor
config_root="${ORION_CODE_CONFIG_DIR:-$HOME/.orion-code}"
find "$config_root/projects" -type f \
  \( -name '*.goal.json' -o -name '*.goal.json.corrupt-*' \) -print
```

Exit Orion before copying files. Back up the exact `<session-id>.goal.json` together with the matching `.json` and
`.jsonl` session files to a separate directory. Do this before downgrading or replacing any sidecar. Do not
use broad cleanup commands against `~/.orion-code`.

### Corrupt sidecars

When Goal loading detects invalid JSON, an invalid schema, an empty objective, or a mismatched session ID, Orion tries
to rename the original file to:

```text
<session-id>.goal.json.corrupt-<timestamp>
```

This quarantine happens during Goal loading, not during `orion doctor`. The doctor command only reports findings.
Orion does not automatically repair a quarantined file and does not silently replace it with a new Goal.

Keep the quarantined copy for inspection. Do not rename it back over the active sidecar unless its JSON, schema,
`sessionId`, and project ownership have been verified. If a known-good backup is available, exit Orion, preserve the
current files, restore the backup to the exact original path, then restart Orion and run:

```text
/resume <session-id>
/target status
```

An active Goal is restored as paused. Review the objective, criteria, revision, and next action before explicitly
running `/target resume`. If no known-good backup exists, keep the quarantine file and create a new Goal; Orion has no
supported automatic sidecar-repair command.

### Version rollback

Never overwrite a published npm version. Prefer a forward patch. Keep npm `latest`, prerelease tags such as `next`,
Git tags, GitHub Releases, merged source, and a local explicit install as separate states. As of 2026-08-12,
`latest=0.1.4` and `next=0.1.6`; installing the exact `0.1.6` version or `next` includes these fixes, while
installing `latest` does not.

Test a rollback in an isolated prefix first. Set `known_good_version` only after verifying its Goal/session
compatibility:

```bash
rollback_prefix="$(mktemp -d /tmp/orion-rollback.XXXXXX)"
known_good_version="0.1.4"
npm install --prefix "$rollback_prefix" "@orion-agents/orion-code@$known_good_version"
"$rollback_prefix/node_modules/.bin/orion" --version
```

Changing a public dist-tag or deprecating a version is an external registry write and requires explicit authorization.
If authorized, the receipt must separately show the exact deprecated version (if any), the new dist-tag target,
`npm view @orion-agents/orion-code dist-tags --json`, a clean default install, and an explicit exact-version install.
A local explicit install alone does not change the default for other users. Always retain the backup until the restored
session and Goal have been inspected successfully; older clients may preserve additive fields while not projecting
newer command, Research, effort, or ACP state.
