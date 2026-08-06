/**
 * Helpers for reading a caught value safely.
 *
 * TypeScript types `catch` bindings as `unknown`, and the codebase used to
 * work around that by writing `catch (err: any)` and reaching for
 * `err.message`. That silently produces the string `"undefined"` whenever
 * something other than an `Error` is thrown — a rejected promise carrying a
 * string, an axios object, a `throw { code }` — which is exactly when a clear
 * message matters most.
 */

/**
 * Extract a human-readable message from any thrown value.
 *
 * - `Error`            -> `error.message`
 * - `string`           -> the string itself
 * - `{ message: '…' }` -> that message (axios/node-fetch style error objects)
 * - anything else      -> `String(value)`
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return String(error);
}

/**
 * Read the `code` property that Node's `ErrnoException` and most HTTP clients
 * attach (`ENOENT`, `EACCES`, `ECONNREFUSED`, …), without asserting a type.
 */
export function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}
