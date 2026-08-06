/**
 * Redaction patterns for text that is **persisted**, not merely printed:
 * session transcripts, `/compact` summaries and the session index all pass
 * through `redactTraceText`. A format missing from this table is a format that
 * lands verbatim in `~/.orion-code/**\/messages.json`.
 *
 * When adding a provider, add a row to `tests/redaction.test.ts` too — the
 * table-driven test is what stops the next format from silently leaking.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [
    /\b((?:GH_TOKEN|GITHUB_TOKEN|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)\s*=\s*)(["']?)[^\s"',;]+/gi,
    '$1$2[REDACTED_SECRET]',
  ],
  [
    /(["'](?:gh_token|github_token|aws_access_key_id|aws_secret_access_key|aws_session_token)["']\s*:\s*)(["'])(?:[^"']+)(["'])/gi,
    '$1$2[REDACTED_SECRET]$3',
  ],
  [
    // Earlier versions only matched the *scheme name* when it was `Bearer`, so
    // `Authorization: Basic …` / `Token …` / `Digest …` / `ApiKey …` leaked the
    // credential verbatim to disk (issue #37, item 1). Require the optional
    // scheme token to be consumed as part of the match so the whole value is
    // redacted regardless of scheme.
    /\b((?:proxy-)?authorization\s*[:=]\s*)(["']?)(?:[A-Za-z][A-Za-z0-9_-]*\s+)?[^\s"',;]+/gi,
    '$1$2[REDACTED_SECRET]',
  ],
  [
    /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*)(["']?)[^\s"',;]+/gi,
    '$1$2[REDACTED_SECRET]',
  ],
  [
    /(["'](?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)["']\s*:\s*)(["'])(?:[^"']+)(["'])/gi,
    '$1$2[REDACTED_SECRET]$3',
  ],
  [
    /\b((?:OPENAI_API_KEY|DASHSCOPE_API_KEY|ANTHROPIC_API_KEY|XAI_API_KEY)\s*=\s*)(["']?)[^\s"',;]+/g,
    '$1$2[REDACTED_SECRET]',
  ],
  [/\bsk-[A-Za-z0-9_.-]{8,}\b/g, '[REDACTED_SECRET]'],
  [/\bgh[pousr]_[A-Za-z0-9]{8,}\b/gi, '[REDACTED_SECRET]'],
  [/\bgithub_pat_[A-Za-z0-9_]{8,}\b/gi, '[REDACTED_SECRET]'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_SECRET]'],
  // Google API keys: fixed `AIza` prefix followed by the URL-safe alphabet.
  // Real keys are 39 chars total (`AIza` + 35); some documented samples are 34,
  // so accept 34 or more to cover both without an unbounded upper bound.
  [/\bAIza[0-9A-Za-z_-]{34,}\b/g, '[REDACTED_SECRET]'],
  // Slack tokens: xoxb/xoxp/xoxa/xoxr/xoxs-... (bot, user, app, refresh, legacy).
  [/\bxox[baprs]-[0-9A-Za-z-]{10,}/gi, '[REDACTED_SECRET]'],
  // Google OAuth client secrets and refresh tokens.
  [/\bGOCSPX-[0-9A-Za-z_-]{10,}/g, '[REDACTED_SECRET]'],
  // Anthropic / OpenAI-style long-lived keys that do not start with `sk-`.
  [/\bxai-[A-Za-z0-9]{16,}\b/g, '[REDACTED_SECRET]'],
  [/\bgsk_[A-Za-z0-9]{16,}\b/g, '[REDACTED_SECRET]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED_SECRET]'],
];

export function redactTraceText(text: string): string {
  return SECRET_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    text
  );
}
