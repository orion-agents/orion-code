/**
 * Bug-hunt round 3 evidence: read-only command classifier has security bypasses.
 *
 * isReadOnlyCommand auto-approves commands without confirmation. Several
 * read-only-classified commands can execute arbitrary code or delete files:
 *   - find -exec / find -delete  (arbitrary command exec / file deletion)
 *   - awk with system() / output redirect  (arbitrary command exec / file write)
 *   - curl -o <file>  (file write; only `>` is checked, not -o)
 *   - sort -o <file>  (file write)
 *
 * A command classified read-only runs WITHOUT user confirmation, so these are
 * privilege/safety bypasses.
 */
import { isReadOnlyCommand, assessCommandSecurity } from '../src/tools/bash_security';

describe('bash_security read-only bypasses', () => {
  describe('find with -exec or -delete', () => {
    it('find -exec must NOT be read-only (executes arbitrary commands)', () => {
      expect(isReadOnlyCommand('find . -exec rm -rf {} \\;')).toBe(false);
    });

    it('find -delete must NOT be read-only (deletes files)', () => {
      expect(isReadOnlyCommand('find . -name "*.tmp" -delete')).toBe(false);
    });

    it('assessCommandSecurity does not mark find -exec as safe', () => {
      const result = assessCommandSecurity('find . -exec chmod 777 {} \\;');
      expect(result.level).not.toBe('safe');
      expect(result.isReadOnly).toBe(false);
    });
  });

  describe('awk with code execution / file output', () => {
    it('awk system() must NOT be read-only (arbitrary command exec)', () => {
      expect(isReadOnlyCommand("awk 'BEGIN{system(\"rm -rf /tmp/x\")}'")).toBe(false);
    });

    it('awk with output redirect must NOT be read-only', () => {
      expect(isReadOnlyCommand("awk '{print > \"/tmp/out\"}' file.txt")).toBe(false);
    });
  });

  describe('curl with -o file output', () => {
    it('curl -o <file> must NOT be read-only (writes file)', () => {
      expect(isReadOnlyCommand('curl -o /tmp/out.html http://example.com')).toBe(false);
    });

    it('curl --output <file> must NOT be read-only', () => {
      expect(isReadOnlyCommand('curl --output /tmp/out.html http://example.com')).toBe(false);
    });
  });

  describe('sort with -o file output', () => {
    it('sort -o <file> must NOT be read-only (writes file)', () => {
      expect(isReadOnlyCommand('sort -o /tmp/out.txt input.txt')).toBe(false);
    });
  });

  describe('wget with redirect output', () => {
    it('wget url > <file> must NOT be read-only (writes file)', () => {
      expect(isReadOnlyCommand('wget http://example.com > /tmp/out.html')).toBe(false);
    });
  });
});
