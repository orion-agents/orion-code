import {
  READ_ONLY_COMMANDS,
  DANGEROUS_PATTERNS,
  isReadOnlyCommand,
  checkDangerousCommand,
  isPotentiallyDestructive,
  isValidationCommand,
  assessCommandSecurity,
  findDestructiveRmTarget,
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
      expect(isReadOnlyCommand("sed -i 's/old/new/g' file.txt")).toBe(false);
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
    test('allows common bounded local verification commands', () => {
      expect(isValidationCommand('tsc --noEmit')).toBe(true);
      expect(isValidationCommand('npm run lint')).toBe(true);
      expect(isValidationCommand('npm run build')).toBe(true);
      expect(isValidationCommand('pnpm typecheck')).toBe(true);
    });

    test('does not allow network-pulling or script-executing commands', () => {
      // npx fetches and runs an arbitrary registry package → RCE.
      expect(isValidationCommand('npx tsc --noEmit')).toBe(false);
      expect(isValidationCommand('npx jest tests/harness.test.ts --no-coverage')).toBe(false);
      // npm test / yarn test run project scripts → silent code execution.
      expect(isValidationCommand('npm test -- --no-coverage')).toBe(false);
      expect(isValidationCommand('yarn test')).toBe(false);
      // arbitrary npx / install still blocked.
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

    test('returns safe for local validation commands', () => {
      const result = assessCommandSecurity('tsc --noEmit');
      expect(result.level).toBe('safe');
      expect(result.isReadOnly).toBe(true);
    });

    test('returns caution for network egress commands (issue #64)', () => {
      for (const cmd of [
        'curl https://example.com',
        'wget https://example.com',
        'nslookup example.com',
        'dig example.com',
        'host example.com',
      ]) {
        const result = assessCommandSecurity(cmd);
        expect(result.level).toBe('caution');
        expect(result.isReadOnly).toBe(false);
      }
    });

    test('returns caution for npx / npm test (issue #64)', () => {
      expect(assessCommandSecurity('npx tsc --noEmit').level).toBe('caution');
      expect(assessCommandSecurity('npx jest tests/x.test.ts').level).toBe('caution');
      expect(assessCommandSecurity('npm test').level).toBe('caution');
      expect(assessCommandSecurity('yarn test').level).toBe('caution');
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

  // Regression: #13 -- the anchored `rm -rf /` patterns were defeated by any
  // reordering of the flag cluster or any trailing argument.
  describe('findDestructiveRmTarget', () => {
    test.each([
      ['rm -rf /', '/'],
      ['rm -fr /', '/'],
      ['rm -r -f /', '/'],
      ['rm -f -r /', '/'],
      ['rm --recursive --force /', '/'],
      ['rm -rf / --no-preserve-root', '/'],
      ['rm --no-preserve-root -rf /', '/'],
      ['rm -rf //', '//'],
      ['rm -rf /*', '/*'],
      ['sudo rm -rf /', '/'],
      ['/bin/rm -rf /', '/'],
      ['rm -rf ~', '~'],
      ['rm -rf ~/', '~/'],
      ['rm -rf ~/*', '~/*'],
      ['rm -rf $HOME', '$HOME'],
      ['rm -rf ${HOME}/', '${HOME}/'],
      ['rm -rf /usr', '/usr'],
      ['rm -rf /etc/*', '/etc/*'],
      ['rm -rf /tmp/..', '/tmp/..'],
      ['rm -rf /tmp/../ --no-preserve-root', '/tmp/../'],
      ['rm -rf /var/tmp/../..', '/var/tmp/../..'],
      ['rm -rf ./..', './..'],
      ['rm -rf -- /', '/'],
      ['rm -rf build /', '/'],
    ])('flags %s as catastrophic', (cmd, target) => {
      expect(findDestructiveRmTarget(cmd)).toBe(target);
    });

    test.each([
      'rm -rf ./build',
      'rm -rf node_modules',
      'rm -rf dist/*',
      'rm -f ~/.cache/orion/session.json',
      'rm -rf /tmp/orion-test',
      'rm -rf /usr-local-backup',
      'ls -la /',
      'echo rm',
    ])('leaves %s alone', cmd => {
      expect(findDestructiveRmTarget(cmd)).toBeNull();
    });

    test('rm without -r or -f cannot remove a directory, so it is not blocked', () => {
      expect(findDestructiveRmTarget('rm /')).toBeNull();
    });

    test('catches a destructive rm hidden later in a chain', () => {
      expect(findDestructiveRmTarget('npm run build && rm -fr / --no-preserve-root')).toBe('/');
    });

    test('assessCommandSecurity blocks every rewrite', () => {
      for (const cmd of [
        'rm -rf /',
        'rm -fr /',
        'rm -rf / --no-preserve-root',
        'rm -rf /*',
        'rm -rf /tmp/..',
      ]) {
        expect(assessCommandSecurity(cmd).level).toBe('blocked');
      }
    });
  });
});
