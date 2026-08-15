# v0.1.4 Test Report — Research-to-Evidence

> tech-team / **Test phase** · Role: Test Engineer · 2026-08-05
> Branch `v0.1.4` → PR #7 · Env: Node v24.14.0 (`/usr/local/bin/node`), `NODE_OPTIONS="--use-system-ca"` (safe-delete guard disabled for build/test), jest + ts-jest.

## 1. v0.1.4 regression baseline (in-scope suites)

| Suite | Tests | Result |
| ----- | ----- | ------ |
| `research-contract` | 8 | ✅ (1 flaky fixed this phase) |
| `research-web-research-adapter` | 9 | ✅ |
| `research-citation` | 8 | ✅ |
| `research-renderer-parity` | 3 | ✅ |
| `research-artifact` | 6 | ✅ |
| `research-quality` | 4 | ✅ |
| **Total** | **38** | **✅ 38 / 38** |

**Defect found & fixed during the test phase:** `research-contract.test.ts` ›
"produces a deterministic, serializable packet" was **flaky**. It compared
`stableStringify(subtaskResultToPacket(...))` across two calls, but
`subtaskResultToPacket` re-stamps `createdAt`/`retrievedAt` on every call, so when
the two calls straddled a millisecond the serialized strings differed and the test
flickered. `hashPacket` (the real CAS token for the artifact store) already strips
timestamps via `packetContentForHash`, so the product CAS mechanism was never at
risk. **Fix:** freeze the system clock in that suite (`jest.useFakeTimers()` +
`jest.setSystemTime`). Verified stable across 3 consecutive runs.

## 2. Full-suite sweep (broad regression / rot detection)

`jest --runInBand` over the whole tree:

- **Test Suites:** 181 passed, 5 failed, 2 skipped (186 of 188)
- **Tests:** 3080 passed, 20 failed, 3 skipped (3103 total)
- `tsc --noEmit` over the whole project: **0 errors**

### Failing suites — all classified as ENVIRONMENT / SANDBOX artifacts, **zero v0.1.4 regressions**

| Suite | Root cause | Classification |
| ----- | ---------- | -------------- |
| `goal-lifecycle-pty` | Spawns the real `orion` CLI subprocess (via ts-node); subprocess fails to boot under this sandbox → `TSError` / `AssertionError: Timed out waiting for 'ORION CODE \| 猎户座'`. | Sandbox / PTY |
| `tui-ui-pty` | Same — spawned CLI cannot start in this environment. | Sandbox / PTY |
| `print-mode` | Same — spawns the CLI; subprocess failure → expected banner absent. | Sandbox / PTY |
| `vector` | `better-sqlite3` native ABI mismatch: prebuilt `better_sqlite3.node` built for `NODE_MODULE_VERSION 147`, running Node 24 requires `137`. | Env / native module |
| `storage-maintenance` | Same `better-sqlite3` ABI mismatch (VectorStore dependency). | Env / native module |

### Notes
- v0.1.4 only added `src/runtime/subagents/research-*.ts` (pure, IO-free libraries),
  their tests, README sections, and plan docs. None of the failing suites' code paths
  were touched → no causal link to these failures.
- The `TSError` in the PTY suites is a **subprocess-launch** artifact (the project
  itself compiles cleanly per `tsc --noEmit`); it is not a project type error.
- 2 skipped suites + 3 skipped tests = sandbox-gated (PTY / env-guarded), by design.

## 3. Go / No-Go on test evidence

- ✅ v0.1.4 in-scope behavior: fully verified (38 / 38).
- ✅ No regression introduced into the 3080 passing tests.
- ⚠️ 20 failures are **100% environment / sandbox** (PTY subprocess boot + better-sqlite3
  ABI). They are **not** blockers for the v0.1.4 deliverable, but **are** blockers for a
  "fully green CI" gate.
- **Recommendation:** v0.1.4 merge is safe on test evidence. To reach a fully-green run
  before `npm publish`, two environment fixes are needed (out of v0.1.4 scope):
  1. Run the PTY/CLI-spawning suites where the spawned CLI can boot, or mark them
     `test.skip` under sandbox (consistent with how the other PTY suites already behave).
  2. `npm rebuild better-sqlite3` (or reinstall the matching prebuilt binary) so the
     native ABI matches the runtime Node.

## 4. Actions taken this phase

- Fixed flaky `research-contract` determinism test (clock freeze) → committed to `v0.1.4`, pushed (PR #7 updated).
- Produced this Test Report.
