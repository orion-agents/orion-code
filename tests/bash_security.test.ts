import {
  READ_ONLY_COMMANDS,
  DANGEROUS_PATTERNS,
  isReadOnlyCommand,
  checkDangerousCommand,
  isPotentiallyDestructive,
  isValidationCommand,
  assessCommandSecurity,
  wrapForSandbox,
  DEFAULT_SANDBOX_OPTIONS,
} from '../src/tools/bash_security';

describe('bash_security', () => {
  describe('READ_ONLY_COMMANDS', () => {
    test('contains expected commands', () => {
      expect(READ_ONLY_COMMANDS).toContain('ls');
      expect(READ_ONLY_COMMANDS).toContain('cat');
      expect(READ_ONLY_COMMANDS).toContain('git status');
      expect(READ_ONLY_COMMANDS).toContain('npm list');
      expect(READ_ONLY_COMMANDS).toContain('node --version');
    });
  });

  describe('isReadOnlyCommand', () => {
    test('returns true for exact match read-only commands', () => {
      expect(isReadOnlyCommand('ls')).toBe(true);
      expect(isReadOnlyCommand('cat')).toBe(true);
      expect(isReadOnlyCommand('pwd')).toBe(true);
    });

    test('returns true for read-only commands with arguments', () => {
      expect(isReadOnlyCommand('ls -la')).toBe(true);
      expect(isReadOnlyCommand('cat package.json')).toBe(true);
      expect(isReadOnlyCommand('git status')).toBe(true);
      expect(isReadOnlyCommand('git log --oneline')).toBe(true);
    });

    test('returns false for sed with -i flag', () => {
      expect(isReadOnlyCommand('sed -i \'s/old/new/g\' file.txt')).toBe(false);
    });

    test('returns false for curl with file output', () => {
      expect(isReadOnlyCommand('curl http://example.com > output.html')).toBe(false);
    });

    test('returns false for wget with file output', () => {
      expect(isReadOnlyCommand('wget -O output.html http://example.com')).toBe(false);
    });

    test('returns false for destructive commands', () => {
      expect(isReadOnlyCommand('rm -rf node_modules')).toBe(false);
      expect(isReadOnlyCommand('chmod 777 file.txt')).toBe(false);
    });
  });

  describe('isValidationCommand', () => {
    test('allows common bounded verification commands', () => {
      expect(isValidationCommand('npx tsc --noEmit')).toBe(true);
      expect(isValidationCommand('npm test -- --no-coverage')).toBe(true);
      expect(isValidationCommand('npm run lint')).toBe(true);
      expect(isValidationCommand('npx jest tests/harness.test.ts --no-coverage')).toBe(true);
    });

    test('does not allow arbitrary npx or install commands', () => {
      expect(isValidationCommand('npx some-random-package')).toBe(false);
      expect(isValidationCommand('npm install')).toBe(false);
      expect(isValidationCommand('npm run start')).toBe(false);
    });
  });

  describe('checkDangerousCommand', () => {
    test('detects rm -rf /', () => {
      const result = checkDangerousCommand('rm -rf /');
      expect(result).not.toBeNull();
      expect(result?.reason).toContain('root directory');
    });

    test('detects rm -rf ~', () => {
      const result = checkDangerousCommand('rm -rf ~');
      expect(result).not.toBeNull();
      expect(result?.reason).toContain('home directory');
    });

    test('detects mkfs', () => {
      const result = checkDangerousCommand('mkfs.ext4 /dev/sda1');
      expect(result).not.toBeNull();
      expect(result?.reason).toContain('format');
    });

    test('detects dd with device output', () => {
      const result = checkDangerousCommand('dd of=/dev/sda');
      expect(result).not.toBeNull();
      expect(result?.reason).toContain('disk');
    });

    test('detects fork bomb', () => {
      const result = checkDangerousCommand(':(){ :|:& };:');
      expect(result).not.toBeNull();
      expect(result?.reason).toContain('Fork bomb');
    });

    test('returns null for safe commands', () => {
      expect(checkDangerousCommand('ls -la')).toBeNull();
      expect(checkDangerousCommand('npm install')).toBeNull();
      expect(checkDangerousCommand('git status')).toBeNull();
    });
  });

  describe('isPotentiallyDestructive', () => {
    test('detects rm -rf', () => {
      expect(isPotentiallyDestructive('rm -rf node_modules')).toBe(true);
    });

    test('detects chmod', () => {
      expect(isPotentiallyDestructive('chmod 644 file.txt')).toBe(true);
    });

    test('detects kill', () => {
      expect(isPotentiallyDestructive('kill -9 1234')).toBe(true);
    });

    test('returns false for safe commands', () => {
      expect(isPotentiallyDestructive('ls -la')).toBe(false);
      expect(isPotentiallyDestructive('cat file.txt')).toBe(false);
      expect(isPotentiallyDestructive('npm install')).toBe(false);
    });
  });

  describe('assessCommandSecurity', () => {
    test('returns blocked for dangerous commands', () => {
      const result = assessCommandSecurity('rm -rf /');
      expect(result.level).toBe('blocked');
      expect(result.isReadOnly).toBe(false);
    });

    test('returns safe for read-only commands', () => {
      const result = assessCommandSecurity('ls -la');
      expect(result.level).toBe('safe');
      expect(result.isReadOnly).toBe(true);
    });

    test('returns safe for git read commands', () => {
      const result = assessCommandSecurity('git log --oneline -10');
      expect(result.level).toBe('safe');
      expect(result.isReadOnly).toBe(true);
    });

    test('returns safe for validation commands', () => {
      const result = assessCommandSecurity('npx tsc --noEmit');
      expect(result.level).toBe('safe');
      expect(result.isReadOnly).toBe(true);
    });

    test('returns caution for potentially destructive commands', () => {
      const result = assessCommandSecurity('rm -rf node_modules');
      expect(result.level).toBe('caution');
      expect(result.isReadOnly).toBe(false);
    });

    test('returns caution for unknown commands', () => {
      const result = assessCommandSecurity('some-unknown-command');
      expect(result.level).toBe('caution');
    });
  });

  describe('wrapForSandbox', () => {
    test('returns original command for none mode', () => {
      const cmd = 'ls -la';
      expect(wrapForSandbox(cmd, { mode: 'none' })).toBe(cmd);
    });

    test('wraps command for docker mode', () => {
      const cmd = 'ls -la';
      const result = wrapForSandbox(cmd, { mode: 'docker' });
      expect(result).toContain('docker exec');
      expect(result).toContain('ls -la');
    });

    test('wraps command for bubblewrap mode', () => {
      const cmd = 'ls -la';
      const result = wrapForSandbox(cmd, { mode: 'bubblewrap' });
      expect(result).toContain('bwrap');
      expect(result).toContain('ls -la');
    });

    test('disables network in docker by default', () => {
      const result = wrapForSandbox('curl http://example.com', { mode: 'docker' });
      expect(result).toContain('--network none');
    });

    test('enables network when specified', () => {
      const result = wrapForSandbox('curl http://example.com', { mode: 'docker', network: true });
      expect(result).not.toContain('--network none');
    });
  });

  describe('DEFAULT_SANDBOX_OPTIONS', () => {
    test('has mode none by default', () => {
      expect(DEFAULT_SANDBOX_OPTIONS.mode).toBe('none');
    });
  });
});
