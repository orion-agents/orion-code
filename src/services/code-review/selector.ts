/**
 * v0.3.28 — typed `/review` selector parsing (docs/plan/v0.3.28-plan.md S1).
 *
 * Slash arguments are parsed once into the frozen `ReviewSelectorV1` contract
 * from PR0. Unknown arguments produce a typed usage error instead of falling
 * back to an ordinary chat turn (v0.3.27 plan §3.1: "不能当成分支、路径或任意
 * 普通聊天悄悄继续").
 */
import type { ReviewSelectorV1 } from './contract';

export type ReviewSelectorParseResult =
  | { readonly ok: true; readonly selector: ReviewSelectorV1 }
  | { readonly ok: false; readonly usage: string };

export const REVIEW_USAGE_TEXT = [
  'Usage: /review [all | --base <ref>] [--path <path>]...',
  '  /review                    Review the current worktree (staged + unstaged + untracked)',
  '  /review all                Alias for the current worktree',
  '  /review --base main        Review committed changes merge-base(main, HEAD)..HEAD',
  '  /review --path src/foo.ts  Restrict the review to a path (repeatable)',
].join('\n');

function ok(selector: ReviewSelectorV1): ReviewSelectorParseResult {
  return { ok: true, selector: Object.freeze({ ...selector }) };
}

function usageError(reason: string): ReviewSelectorParseResult {
  return { ok: false, usage: `${reason}\n\n${REVIEW_USAGE_TEXT}` };
}

function looksLikeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.startsWith('-') &&
    !value.includes('\\') &&
    value.split('/').every(segment => segment && segment !== '.' && segment !== '..')
  );
}

/**
 * Parses `/review` arguments. Tokens: `all` alias, `--base <ref>` (once),
 * `--path <path>` (repeatable, also `--path=<path>`), a single bare relative
 * path (back-compat path filter). Anything else is a usage error.
 */
export function parseReviewSelector(rawArgs: string): ReviewSelectorParseResult {
  const tokens = rawArgs.trim().split(/\s+/).filter(token => token.length > 0);
  let base: string | null = null;
  const paths: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;

    if (token === 'all') {
      if (tokens.length !== 1) {
        return usageError('`all` cannot be combined with other arguments.');
      }
      return ok({ kind: 'worktree' });
    }

    if (token === '--base' || token.startsWith('--base=')) {
      if (base !== null) return usageError('--base may only be given once.');
      const value =
        token.startsWith('--base=') ? token.slice('--base='.length) : tokens[index + 1];
      if (!value) return usageError('--base requires a ref argument.');
      if (token === '--base') index += 1;
      base = value;
      continue;
    }

    if (token === '--path' || token.startsWith('--path=')) {
      const value =
        token.startsWith('--path=') ? token.slice('--path='.length) : tokens[index + 1];
      if (!value) return usageError('--path requires a path argument.');
      if (token === '--path') index += 1;
      if (!looksLikeRelativePath(value)) {
        return usageError(`Invalid --path value: ${value}`);
      }
      paths.push(value);
      continue;
    }

    if (token.startsWith('-')) {
      return usageError(`Unknown option: ${token}`);
    }

    // Bare argument: back-compat single existing-path filter. Multiple bare
    // arguments are ambiguous and rejected rather than guessed.
    if (paths.length > 0 || base !== null) {
      return usageError(`Unexpected argument: ${token}`);
    }
    if (!looksLikeRelativePath(token)) {
      return usageError(`Invalid path argument: ${token}`);
    }
    paths.push(token);
  }

  if (base !== null) {
    return ok(paths.length > 0 ? { kind: 'base', ref: base, paths } : { kind: 'base', ref: base });
  }
  return ok(paths.length > 0 ? { kind: 'worktree', paths } : { kind: 'worktree' });
}
