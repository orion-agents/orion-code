/**
 * Secret masking helpers.
 *
 * Diagnostics (`/config`, `/doctor`, provider dumps) used to print
 * `apiKey.slice(0, 7) + '***'`. That leaks the full provider prefix
 * (`sk-proj-`, `sk-ant-`, org-scoped prefixes, …) and, for short keys,
 * a meaningful fraction of the secret itself. Terminal output is routinely
 * pasted into issues and chat logs, so the safe default is to reveal nothing
 * that identifies the key beyond its shape.
 */

/** Number of trailing characters kept so a user can tell two keys apart. */
const VISIBLE_SUFFIX = 4;

/** Minimum length before we are willing to reveal any characters at all. */
const MIN_LENGTH_FOR_SUFFIX = 12;

/**
 * Mask a secret for display.
 *
 * - empty / undefined  -> `(not set)`
 * - short secrets      -> fully masked, only the length is shown
 * - normal secrets     -> `***<last 4> (len=NN)`
 *
 * The length is included because it is the single most useful signal when
 * debugging "wrong key configured" problems, and it does not narrow the
 * search space in any practical way.
 */
export function maskSecret(secret: string | undefined | null): string {
  if (!secret) return '(not set)';
  const trimmed = String(secret);
  if (trimmed.length < MIN_LENGTH_FOR_SUFFIX) {
    return `*** (len=${trimmed.length})`;
  }
  return `***${trimmed.slice(-VISIBLE_SUFFIX)} (len=${trimmed.length})`;
}

/**
 * Redact secret-looking substrings from free-form text (log lines, error
 * messages, HTTP bodies) before it is shown to the user or written to disk.
 *
 * There used to be a second, weaker implementation here that missed GitHub
 * PATs, AWS access key IDs, Google API keys and Slack tokens. It had no call
 * sites, but it sat next to `maskSecret` — which *is* imported in three places
 * — so the next contributor reaching for "the redactor in the file I already
 * import from" would have silently picked the leaky one. There is now exactly
 * one implementation, in `services/redaction`.
 */
export { redactTraceText as redactSecrets } from '../services/redaction';
