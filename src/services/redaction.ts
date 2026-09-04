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
  // Redact URL userinfo before generic `token:` / `secret:` rules can consume
  // only the password tail and make the complete credential boundary
  // unrecognizable (issue #234).
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[REDACTED_CREDENTIAL]@'],
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
    /\b((?:token|client[_-]?secret|private[_-]?key|secret[_-]?key|signing[_-]?key|encryption[_-]?key|session[_-]?key|db[_-]?password|credential[_-]?value|account[_-]?key|connection[_-]?string|database[_-]?url|dsn|pwd|auth)\s*[:=]\s*)(["']?)[^\s"',;]+/gi,
    '$1$2[REDACTED_SECRET]',
  ],
  [
    /(["'](?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)["']\s*:\s*)(["'])(?:[^"']+)(["'])/gi,
    '$1$2[REDACTED_SECRET]$3',
  ],
  [
    /(["'](?:token|client[_-]?secret|private[_-]?key|secret[_-]?key|signing[_-]?key|encryption[_-]?key|session[_-]?key|db[_-]?password|credential[_-]?value|account[_-]?key|connection[_-]?string|database[_-]?url|dsn|pwd|auth)["']\s*:\s*)(["'])(?:[^"']+)(["'])/gi,
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
  [
    // Uppercase environment assignments with a secret-shaped suffix, e.g.
    // `export X_CLIENT_SECRET=…` / `CLIENT_SECRET=…`. The generic lower-case
    // field rules cannot match these because the underscore is a word
    // character, so no boundary exists right before `client_secret` (issue #241).
    /\b((?:[A-Z][A-Z0-9_]*_)?(?:CLIENT_SECRET|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY|PRIVATE_KEY|SESSION_KEY|ENCRYPTION_KEY|DB_PASSWORD|API_KEY|API_TOKEN|CREDENTIALS?|SECRETS?)\s*=\s*)(["']?)[^\s"',;]+/gi,
    '$1$2[REDACTED_SECRET]',
  ],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED_SECRET]'],
];

/** Field-name guard shared by browser/event and approval snapshot projections. */
export function isSensitiveFieldName(field: string): boolean {
  const normalized = field.replace(/[^a-z0-9]/giu, '').toLowerCase();
  if (!normalized) return false;
  return (
    normalized === 'env' ||
    normalized === 'environment' ||
    normalized === 'header' ||
    normalized === 'headers' ||
    normalized.endsWith('authorization') ||
    normalized.endsWith('cookie') ||
    normalized.endsWith('password') ||
    normalized.endsWith('passphrase') ||
    normalized.endsWith('token') ||
    normalized.endsWith('apikey') ||
    normalized.endsWith('privatekey') ||
    normalized.endsWith('signingkey') ||
    normalized.endsWith('encryptionkey') ||
    normalized.endsWith('sessionkey') ||
    normalized.endsWith('accountkey') ||
    normalized.endsWith('connectionstring') ||
    normalized.endsWith('databaseurl') ||
    normalized === 'dsn' ||
    normalized === 'pwd' ||
    normalized === 'auth' ||
    normalized.endsWith('auth') ||
    normalized.endsWith('secret') ||
    normalized.endsWith('secretkey') ||
    normalized.includes('secretaccesskey') ||
    normalized.includes('credential')
  );
}

/** File-name policy shared by local browser read models. */
export function isSensitiveFilePath(path: string): boolean {
  const segments = path
    .replace(/\\/gu, '/')
    .split('/')
    .filter(Boolean)
    .map(segment => segment.toLowerCase());
  return segments.some(segment => {
    if (segment === '.ssh' || segment === '.gnupg' || segment === 'keychain') return true;
    if (segment === '.npmrc' || segment === '.pypirc' || segment === '.netrc') return true;
    if (segment === '.env' || segment.startsWith('.env.')) return true;
    if (/^(?:credentials?|secrets?)(?:\.|$)/u.test(segment)) return true;
    if (/^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/u.test(segment)) return true;
    return /\.(?:pem|key|p12|pfx|kdbx|keystore|jks)$/u.test(segment);
  });
}

export function redactTraceText(text: string): string {
  const labelRedacted = SECRET_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    text
  );
  return redactStructuredSecretFields(labelRedacted);
}

function redactStructuredSecretFields(text: string): string {
  const doubleQuoted = text.replace(
    /("((?:\\.|[^"\\])*)"\s*:\s*)"(?:\\.|[^"\\])*"/gu,
    (match, prefix: string, encodedKey: string) => {
      let key = encodedKey;
      try {
        key = JSON.parse(`"${encodedKey}"`) as string;
      } catch {
        // Keep the literal key for JSON-like diagnostic output.
      }
      return isSensitiveFieldName(key) ? `${prefix}"[REDACTED_SECRET]"` : match;
    }
  );
  return doubleQuoted.replace(
    /('((?:\\.|[^'\\])*)'\s*:\s*)'(?:\\.|[^'\\])*'/gu,
    (match, prefix: string, key: string) =>
      isSensitiveFieldName(key) ? `${prefix}'[REDACTED_SECRET]'` : match
  );
}
