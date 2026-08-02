# Goal Evidence and Recovery

Orion Code v0.1.2 supports one persistent Goal per session.

## Lifecycle

```text
/target <objective>
  -> active typed continuations
  -> runtime evidence ledger
  -> criterion audit
  -> complete | paused | blocked | usage_limited | budget_limited
```

Use `/target` to inspect the current state, `/target pause` to stop automatic continuation, and
`/target resume` to continue a recoverable Goal. `/target replace <objective>` creates a new goalId;
`/target confirm <criterion-id>` records trusted human acceptance only for a criterion that explicitly requires
`user` evidence; `/target clear --yes` removes the Goal sidecar.

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
`.jsonl` session files to a separate directory. Do this before downgrading to v0.1.1 or replacing any sidecar. Do not
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
running `/target resume`. If no known-good backup exists, keep the quarantine file and create a new Goal; v0.1.2 has no
supported automatic sidecar-repair command.

### Version rollback

After the backup above, never overwrite the published v0.1.2 artifact. Prefer a forward fix in v0.1.3. If the
default registry version must be rolled back immediately, obtain explicit registry-write approval and run:

```bash
npm deprecate @orion-agents/orion-code@0.1.2 "Release blocked; use 0.1.1 or the next fixed release"
npm dist-tag add @orion-agents/orion-code@0.1.1 latest
npm view @orion-agents/orion-code dist-tags --json
npm view @orion-agents/orion-code@latest version
npm install -g @orion-agents/orion-code@0.1.1
orion --version
```

v0.1.1 ignores the additive v0.1.2 contract, plan, and evidence fields in its UI. The compatibility fixture verifies
that its reader/writer preserves those fields, but the richer v0.1.2 projections are unavailable until v0.1.2 is
reinstalled. A rollback receipt must show `latest=0.1.1`, a clean default install resolving to 0.1.1, and an explicit
`@0.1.1` install resolving to the same version. A local explicit install alone does not restore the registry default
for other users. Always retain the backup until the restored session has been inspected successfully.
