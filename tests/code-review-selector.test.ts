/**
 * v0.3.28 — typed `/review` selector parsing (plan S1). Every accepted shape
 * and every rejection path is pinned; unrecognized input must never parse to
 * something plausible.
 */
import { parseReviewSelector, REVIEW_USAGE_TEXT } from '../src/services/code-review/selector';

describe('v0.3.28 — parseReviewSelector', () => {
  test('empty arguments resolve to the worktree scope', () => {
    expect(parseReviewSelector('')).toEqual({
      ok: true,
      selector: { kind: 'worktree' },
    });
    expect(parseReviewSelector('   ')).toEqual({
      ok: true,
      selector: { kind: 'worktree' },
    });
  });

  test('`all` is an alias for the worktree scope', () => {
    expect(parseReviewSelector('all')).toEqual({
      ok: true,
      selector: { kind: 'worktree' },
    });
  });

  test('`all` cannot be combined with other arguments', () => {
    const parsed = parseReviewSelector('all --base main');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.usage).toContain('cannot be combined');
  });

  test('--base resolves to the base scope', () => {
    expect(parseReviewSelector('--base main')).toEqual({
      ok: true,
      selector: { kind: 'base', ref: 'main' },
    });
    expect(parseReviewSelector('--base=origin/main')).toEqual({
      ok: true,
      selector: { kind: 'base', ref: 'origin/main' },
    });
  });

  test('--base with --path keeps both dimensions', () => {
    const parsed = parseReviewSelector('--base main --path src --path web');
    expect(parsed).toEqual({
      ok: true,
      selector: { kind: 'base', ref: 'main', paths: ['src', 'web'] },
    });
  });

  test('--path filters the worktree scope', () => {
    expect(parseReviewSelector('--path src/foo.ts')).toEqual({
      ok: true,
      selector: { kind: 'worktree', paths: ['src/foo.ts'] },
    });
  });

  test('a single bare relative path is a back-compat worktree filter', () => {
    expect(parseReviewSelector('src/runtime')).toEqual({
      ok: true,
      selector: { kind: 'worktree', paths: ['src/runtime'] },
    });
  });

  test('unknown options are usage errors, never guesses', () => {
    for (const args of ['--unknown', '-x', '--base']) {
      const parsed = parseReviewSelector(args);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.usage).toContain(REVIEW_USAGE_TEXT);
    }
  });

  test('--base and --path reject missing values', () => {
    expect(parseReviewSelector('--base').ok).toBe(false);
    expect(parseReviewSelector('--path').ok).toBe(false);
  });

  test('--base may only be given once', () => {
    expect(parseReviewSelector('--base main --base dev').ok).toBe(false);
  });

  test('absolute paths and traversal are rejected', () => {
    expect(parseReviewSelector('/etc').ok).toBe(false);
    expect(parseReviewSelector('..').ok).toBe(false);
    expect(parseReviewSelector('--path ../secrets').ok).toBe(false);
  });

  test('multiple bare arguments are rejected as ambiguous', () => {
    expect(parseReviewSelector('src other').ok).toBe(false);
  });

  test('a bare path after --path is rejected instead of silently merged', () => {
    expect(parseReviewSelector('--path src other').ok).toBe(false);
  });

  test('parsed selectors are frozen copies', () => {
    const parsed = parseReviewSelector('--path src');
    if (parsed.ok) {
      expect(Object.isFrozen(parsed.selector)).toBe(true);
    }
  });
});
