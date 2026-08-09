/**
 * Environment probes for tests that cannot run in headless CI or that require
 * live provider credentials / a real pseudo-terminal.
 *
 * The PTY and CLI "smoke" suites spawn the real `orion` binary as a subprocess.
 * On GitHub Actions (and other headless runners) there is no interactive
 * terminal driver, so the assertions about terminal behavior (or the need for
 * an API key + network) produce false failures. They are skipped there and run
 * on a developer machine that has a TTY and/or credentials. See issue #76
 * (PTY smoke false-positives) and #57 (missing real PTY evidence).
 */

export const runningInCi =
  process.env.CI === 'true' || !!process.env.GITHUB_ACTIONS;

export const hasApiKey = !!process.env.ORION_CODE_API_KEY;

/** PTY smoke tests need a real interactive terminal; headless CI cannot provide one. */
export const canRunPtySmoke = !runningInCi;

/** CLI smoke tests spawn the real binary and need provider credentials + network. */
export const canRunCliSmoke = !runningInCi && hasApiKey;
