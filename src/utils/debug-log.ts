/**
 * Diagnostics boundary for intentionally-swallowed errors.
 *
 * A large part of the codebase deliberately tolerates failures: a missing
 * config file, a non-git directory, a corrupt session record. The historical
 * pattern for those paths was a parameterless `catch {}`, which discards the
 * error object entirely. That is fine for control flow and catastrophic for
 * diagnosis — once the exception is gone there is nothing left to explain why
 * a session failed to persist or why a provider silently fell back.
 *
 * `debugError` keeps the tolerant behaviour but preserves the signal in the
 * structured diagnostic log. Stderr remains opt-in via `ORION_CODE_DEBUG`, so
 * default runs are observable without polluting the TUI.
 *
 * Usage:
 *
 * ```ts
 * try {
 *   writeFileSync(path, data);
 * } catch (error) {
 *   debugError('session-storage.save', error, path);
 * }
 * ```
 */

import { recordStructuredDiagnostic } from './observability';

/** Environment variable that opts into diagnostic output. */
export const DEBUG_ENV_VAR = 'ORION_CODE_DEBUG';

/** Prefix used for every diagnostic line so output is greppable. */
const LOG_PREFIX = '[orion:debug]';

/**
 * Whether diagnostics are enabled.
 *
 * Read on every call (not cached) so tests and long-lived processes can flip
 * the flag at runtime.
 */
export function isDebugEnabled(): boolean {
  const value = process.env[DEBUG_ENV_VAR];
  return value === '1' || value === 'true';
}

/**
 * Render an unknown thrown value as a single-line, human-readable string.
 *
 * `catch` can receive anything, not just `Error`, so this normalises strings,
 * plain objects and `undefined` instead of printing `[object Object]`.
 */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error.message;
  }
  if (typeof error === 'string') return error;
  if (error === undefined) return '(no error value)';
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    // The value is not serialisable (cycles, getters that throw); its string
    // form is the best remaining signal and cannot itself fail here.
    return String(error);
  }
}

/**
 * Report a swallowed error.
 *
 * No-op unless `ORION_CODE_DEBUG` is set, and never throws — a diagnostics
 * helper must not be able to break the path it is instrumenting.
 *
 * @param scope   Dotted identifier of the call site, e.g. `auth.load`.
 * @param error   The caught value.
 * @param detail  Optional extra context (a path, an id, a provider name).
 */
export function debugError(scope: string, error: unknown, detail?: string): void {
  const formatted = formatError(error);
  recordStructuredDiagnostic('error', scope, formatted, detail);
  if (!isDebugEnabled()) return;
  try {
    const suffix = detail ? ` [${detail}]` : '';
    console.error(`${LOG_PREFIX} ${scope}${suffix}: ${formatted}`);
  } catch {
    // Writing diagnostics must never escalate into a real failure (closed
    // stderr, EPIPE on a killed pager). Dropping the line is the correct
    // outcome here — there is nowhere left to report it to.
  }
}
