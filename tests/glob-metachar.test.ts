/**
 * Bug-hunt round 11 evidence: glob_ does not escape regex metacharacters and
 * has no recursion depth cap.
 *
 * globToRegex only escapes `.` and translates glob wildcards; it leaves other
 * regex metacharacters (parens, brackets, +, ^, $, |, etc.) untouched. So:
 *   - A filename with literal parens, `src/(group)/x.ts`, becomes the regex
 *     `^src/(group)/x\.ts$` where `(group)` is a capture group. The real file
 *     no longer matches -> existing files are silently dropped from results.
 *   - A pattern with an unbalanced `[`, e.g. `src/[abc/x.ts`, makes
 *     `new RegExp(...)` throw RangeError, which the outer try/catch turns into
 *     a generic error string with no hint that the *pattern* was invalid.
 *
 * Separately, `walk` recurses with no depth limit, so a pathological directory
 * tree (or a symlink loop) can hang or OOM the tool. We assert a depth cap.
 */
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';

const TOOLS = require('../src/tools').TOOLS;
const globTool = TOOLS.find((t: any) => t.name === 'glob');

const ctx = { cwd: process.cwd(), config: { name: 'orion-code', mode: 'development' } };

describe('glob tool metacharacters & depth (bug-hunt round 11)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(tmpdir(), 'openhorse-glob-bug-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('matches a file whose path contains literal parens', async () => {
    fs.mkdirSync(path.join(dir, 'src', '(group)'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', '(group)', 'file.ts'), '', 'utf-8');

    const result = await globTool.execute(
      { pattern: 'src/(group)/*.ts', path: dir },
      { ...ctx, cwd: dir },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('file.ts');
  });

  it('does not crash on an unbalanced bracket (treats it as a literal)', async () => {
    // Before the fix, an unbalanced '[' made new RegExp throw RangeError,
    // which the outer catch turned into a generic error. After escaping regex
    // metacharacters, '[' is treated as a literal char, the pattern is valid,
    // and the tool simply reports no matches instead of crashing.
    const result = await globTool.execute(
      { pattern: 'src/[abc/file.ts', path: dir },
      { ...ctx, cwd: dir },
    );
    expect(result.success).toBe(true);
    // No file matches the literal pattern -> friendly no-match message.
    expect(result.output).toMatch(/No files|No matches|No files found/i);
  });

  it('caps recursion depth on a deep directory tree', async () => {
    // Build a 60-deep chain of dirs each with one file. A depth cap keeps this
    // bounded; without one the walk traverses the entire chain.
    let cur = dir;
    for (let i = 0; i < 60; i++) {
      cur = path.join(cur, `d${i}`);
      fs.mkdirSync(cur);
      fs.writeFileSync(path.join(cur, 'file.ts'), '', 'utf-8');
    }

    const result = await globTool.execute(
      { pattern: '**/*.ts', path: dir },
      { ...ctx, cwd: dir },
    );
    expect(result.success).toBe(true);
    // With a reasonable depth cap, the deepest files (e.g. d59) are NOT all
    // traversed; the result is bounded rather than enumerating all 60 levels.
    // We assert the tool returns promptly and does not list the very deepest.
    expect(result.output).not.toContain('d59/file.ts');
  }, 15_000);
});
