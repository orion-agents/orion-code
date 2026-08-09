# Security Policy

Orion Code is a goal-driven coding agent that executes commands, calls tools, and
talks to LLM providers on your behalf. This document explains how to report
vulnerabilities and summarizes the security model you are opting into when you run it.

## Supported versions

Only the latest released `vX.Y.Z` line receives security fixes. The current
supported line is **`v0.1.4`** (see `CHANGELOG.md` for the delivery state of each
release). Pre-release / worktree-only builds carry no security-support promise.

## Reporting a vulnerability

Please report security issues **privately**, not through public issues:

- Use GitHub's private vulnerability reporting on this repository
  (`Security → Report a vulnerability`), or
- Email the maintainer referenced in `package.json` with `[orion-code security]`
  in the subject.

Do not open a public issue for a suspected vulnerability. We will acknowledge
within 3 business days, propose a fix timeline, and coordinate disclosure.

Include:

- Affected version (output of `orion --version`)
- Steps to reproduce / proof-of-concept
- Expected vs. actual behavior
- Any relevant logs (redact secrets, API keys, and file paths first)

## Security model

Orion Code runs with the privileges of the invoking user. Its safety boundary is
**defense-in-depth**, not a sandbox:

- **Command classification.** Shell commands are classified (read-only,
  read/write, destructive) before execution. Destructive or out-of-bounds
  operations require explicit user approval unless a configured allowlist permits
  them. Fail-closed: when classification is uncertain, the operation is denied.
- **Sandbox / network isolation.** When a sandbox is enabled it is intended to
  constrain filesystem access and network egress. Treat it as *best-effort,
  platform-dependent* isolation — it is not a hard security boundary, especially
  on macOS where enforcement depends on the host OS. Do not rely on the sandbox to
  contain a malicious prompt or untrusted skill.
- **Credential handling.** Provider API keys and cloud credentials
  (`AWS_*`, `GCP_*`, `AZURE_*`, …) are read from your config / environment and are
  never written into session transcripts, logs, or telemetry in cleartext.
  Third-party MCP stdio servers receive only an explicit allowlist of environment
  variables, not the full parent environment.
- **MCP servers.** External MCP stdio servers are third-party code. They run as
  child processes; review their source and permissions before connecting.
- **Untrusted input.** Prompts, skills, and web/tool content are treated as
  untrusted. Redirects are re-validated against the pre-approved host list, and
  tool output is not blindly executed.

## Incident response (runbook)

If you suspect a credential leak or unauthorized action while running Orion Code:

1. **Contain.** Stop the agent, rotate any exposed keys/secrets immediately, and
   disconnect the affected environment.
2. **Preserve.** Keep the session directory and `ORION_CODE_CONFIG_DIR` intact
   (do not delete) so the transcript can be reviewed.
3. **Report.** Follow the private reporting path above with the preserved logs.
4. **Remediate.** Apply the released patch, review your allowlist / sandbox
   configuration, and audit recent sessions for unexpected tool calls.

## Scope and limitations

This is a developer tool. It can modify files, run commands, and make network
requests. Running it against a codebase implies trust in the prompts and skills
you provide. The maintainers are not responsible for actions performed by the
agent, including those resulting from prompt injection in untrusted content.
