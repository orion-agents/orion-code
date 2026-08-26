/**
 * Regression coverage for issues #43, #45, #50, #51, #52.
 *
 * Each block reproduces the exact defect described in the issue and asserts the
 * fixed behaviour, so a future refactor cannot silently reintroduce it.
 */

import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// #43 — memory_save / memory_forget path traversal
// ============================================================================

describe('#43 memory entry names cannot escape the memory directory', () => {
  const storage = require('../src/memory/storage');
  const { resolveMemoryEntryPath, InvalidMemoryNameError } = storage;

  const dir = '/tmp/orion-memory-poc/memory';

  it('rejects parent-directory traversal', () => {
    expect(() => resolveMemoryEntryPath(dir, '../../../ESCAPED-CANARY')).toThrow(
      InvalidMemoryNameError
    );
  });

  it('rejects absolute paths', () => {
    expect(() => resolveMemoryEntryPath(dir, '/etc/orion-canary')).toThrow(InvalidMemoryNameError);
  });

  it('rejects null bytes and control characters', () => {
    expect(() => resolveMemoryEntryPath(dir, 'safe\0name')).toThrow(InvalidMemoryNameError);
    expect(() => resolveMemoryEntryPath(dir, 'safe\nname')).toThrow(InvalidMemoryNameError);
  });

  it('rejects path separators instead of silently rewriting them', () => {
    expect(() => resolveMemoryEntryPath(dir, 'nested/name')).toThrow(InvalidMemoryNameError);
    expect(() => resolveMemoryEntryPath(dir, 'nested\\name')).toThrow(InvalidMemoryNameError);
  });

  it('rejects empty / whitespace-only names', () => {
    expect(() => resolveMemoryEntryPath(dir, '')).toThrow(InvalidMemoryNameError);
    expect(() => resolveMemoryEntryPath(dir, '   ')).toThrow(InvalidMemoryNameError);
  });

  it('accepts ordinary kebab-case names and keeps them inside the directory', () => {
    const filePath = resolveMemoryEntryPath(dir, 'user-role');
    expect(filePath).toBe(resolve(dir, 'user-role.md'));
  });

  it('preserves non-ASCII names verbatim (no underscore collapsing)', () => {
    // sanitizePathKey would rewrite these to "___"; we only use its verdict.
    const filePath = resolveMemoryEntryPath(dir, '用户偏好');
    expect(filePath).toBe(resolve(dir, '用户偏好.md'));
  });

  it('saveMemory refuses a traversing name and writes nothing', () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'orion-mem-'));
    try {
      const memoryDir = storage.getMemoryDir(projectPath);
      const escaped = resolve(memoryDir, '../../../ESCAPED-CANARY.md');

      expect(() =>
        storage.saveMemory(
          {
            name: '../../../ESCAPED-CANARY',
            type: 'project',
            description: 'poc',
            content: 'pwned',
          },
          projectPath
        )
      ).toThrow(/Invalid memory name/);

      expect(existsSync(escaped)).toBe(false);
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it('deleteMemory refuses a traversing name (arbitrary-delete primitive)', () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'orion-mem-'));
    try {
      expect(() => storage.deleteMemory('../../../ESCAPED-CANARY', projectPath)).toThrow(
        /Invalid memory name/
      );
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it('loadMemory returns null (does not throw) for an unsafe name', () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'orion-mem-'));
    try {
      expect(storage.loadMemory('../../../ESCAPED-CANARY', projectPath)).toBeNull();
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// #45 — context budget collapses to 1 token
// ============================================================================

describe('#45 context budget resolution', () => {
  const {
    resolveContextBudget,
    resolveModelContext,
    __resetBudgetWarningsForTest,
  } = require('../src/services/model-context');

  beforeEach(() => {
    __resetBudgetWarningsForTest();
  });

  it('gpt-4 no longer collapses to a 1-token input budget', () => {
    const budget = resolveContextBudget('gpt-4');
    expect(budget.contextWindow).toBe(8192);
    expect(budget.safeInputBudget).toBeGreaterThan(1000);
  });

  it('gpt-4.1 is not captured by the 8k gpt-4 entry', () => {
    const resolved = resolveModelContext('gpt-4.1');
    expect(resolved.matchedId).toBe('gpt-4.1');
    expect(resolveContextBudget('gpt-4.1').safeInputBudget).toBeGreaterThan(100000);
  });

  it('gpt-4-turbo resolves to the 128k entry, not gpt-4', () => {
    const resolved = resolveModelContext('gpt-4-turbo');
    expect(resolved.matchedId).toBe('gpt-4-turbo');
    expect(resolved.contextWindow).toBe(128000);
  });

  it('glm-5.2-air prefers glm-5.2 over the shorter glm-5', () => {
    const resolved = resolveModelContext('glm-5.2-air');
    expect(resolved.matchedId).toBe('glm-5.2');
  });

  it('still fuzzy-matches provider-prefixed and dated ids', () => {
    expect(resolveModelContext('openai/gpt-4o').matchedId).toBe('gpt-4o');
    expect(resolveModelContext('gpt-4o:latest').matchedId).toBe('gpt-4o');
  });

  it('reserved output can never exceed half the context window', () => {
    const budget = resolveContextBudget('gpt-4', 1_000_000);
    expect(budget.reservedOutputTokens).toBeLessThanOrEqual(8192 / 2);
    expect(budget.safeInputBudget).toBeGreaterThan(1);
  });

  it('a non-positive raw budget falls back proportionally instead of clamping to 1', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // 1200-token window: safetyMargin alone (min 1024) plus reserve exceeds it.
      const { __registerModelForTest } = require('../src/services/model-context');
      __registerModelForTest({
        id: 'tiny-window-test-model',
        label: 'Tiny',
        contextWindow: 1200,
        maxOutputTokens: 1200,
      });

      const budget = resolveContextBudget('tiny-window-test-model');
      expect(budget.safeInputBudget).toBeGreaterThan(1);
      expect(budget.safeInputBudget).toBe(Math.floor(1200 * 0.6));
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

// ============================================================================
// #50 — glob helpers drop the leading dot when extracting extensions
// ============================================================================

describe('#50 extension extraction keeps the leading dot', () => {
  const { matchFiles } = require('../src/services/file-glob');

  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-glob-'));
    writeFileSync(join(root, '.gitignore'), '*.log\n');
    writeFileSync(join(root, 'changelog'), 'x');
    writeFileSync(join(root, 'catalog'), 'x');
    writeFileSync(join(root, 'app.log'), 'x');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('`*.log` no longer hides changelog / catalog from @-completion', () => {
    const names = matchFiles('c', root).map((m: { path: string }) => m.path);
    expect(names).toContain('changelog');
    expect(names).toContain('catalog');
  });

  it('`*.log` still ignores real .log files', () => {
    const names = matchFiles('a', root).map((m: { path: string }) => m.path);
    expect(names).not.toContain('app.log');
  });

  it('auto-fix `**/*.ts` no longer fires on extensionless paths', () => {
    const { matchesPattern } = require('../src/services/auto-fix/autoFixHook').__testables;

    expect(matchesPattern('docs/requirements', '**/*.ts')).toBe(false);
    expect(matchesPattern('notes/highlights', '**/*.ts')).toBe(false);
    expect(matchesPattern('src/a.ts', '**/*.ts')).toBe(true);
    // `.mts` must not be swallowed by the `.ts` trigger either.
    expect(matchesPattern('src/a.mts', '**/*.ts')).toBe(false);
  });

  it('detectAutoFixConfig clears commands the project does not define', () => {
    const {
      detectAutoFixConfig,
      DEFAULT_AUTOFIX_CONFIG,
    } = require('../src/services/auto-fix/autoFixConfig');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));

    const config = detectAutoFixConfig(root);
    expect(config.buildCommand).toBe('npm run build');
    expect(config.lintCommand).toBeUndefined();
    expect(config.testCommand).toBeUndefined();
    // and it must not hand out the shared singleton / shared triggers array
    expect(config).not.toBe(DEFAULT_AUTOFIX_CONFIG);
    expect(config.triggers).not.toBe(DEFAULT_AUTOFIX_CONFIG.triggers);
  });

  it('the catch path returns a copy, so setEnabled cannot poison the defaults', () => {
    const {
      detectAutoFixConfig,
      DEFAULT_AUTOFIX_CONFIG,
    } = require('../src/services/auto-fix/autoFixConfig');
    const missing = join(root, 'no-such-dir');
    const config = detectAutoFixConfig(missing);

    expect(config).not.toBe(DEFAULT_AUTOFIX_CONFIG);
    config.enabled = false;
    expect(DEFAULT_AUTOFIX_CONFIG.enabled).toBe(true);
  });
});

// ============================================================================
// #51 — verification gate never re-opens after fail-then-pass
// ============================================================================

describe('#51 verification gate reopens after a fail-then-pass', () => {
  const { summarizeVerificationState } = require('../src/services/verification-profile');

  const profile = {
    profile: 'node',
    required: true,
    commands: ['npm run build'],
  };

  it('a command that failed and then passed no longer blocks the claim', () => {
    const summary = summarizeVerificationState(profile, [
      { command: 'npm run build', success: false },
      { command: 'npm run build', success: true },
    ]);

    expect(summary.passedCommands).toContain('npm run build');
    expect(summary.failedCommands).toEqual([]);
    expect(summary.missingCommands).toEqual([]);
    expect(summary.claimAllowed).toBe(true);
  });

  it('a command that passed and then failed still blocks the claim', () => {
    const summary = summarizeVerificationState(profile, [
      { command: 'npm run build', success: true },
      { command: 'npm run build', success: false },
    ]);

    expect(summary.failedCommands).toContain('npm run build');
    expect(summary.claimAllowed).toBe(false);
  });

  it('reports a truthful reason instead of falling back to "checks not run"', () => {
    const summary = summarizeVerificationState(
      { profile: 'node', required: true, commands: ['npm run build'] },
      [
        { command: 'npm run build', success: true },
        { command: 'npm test', success: false },
      ]
    );

    expect(summary.claimAllowed).toBe(false);
    expect(summary.skippedReason).toMatch(/still failing/i);
    expect(summary.skippedReason).toContain('npm test');
  });

  it('an untouched required command is still missing', () => {
    const summary = summarizeVerificationState(profile, []);
    expect(summary.claimAllowed).toBe(false);
    expect(summary.missingCommands).toContain('npm run build');
  });
});

// ============================================================================
// #52 — four small correctness bugs
// ============================================================================

describe('#52.1 removed Goal subcommands never fall through to create', () => {
  const { parseTargetCommand } = require('../src/commands/target-command');

  it.each(['exit', 'confirm', 'edit', 'replace', 'budget'])(
    '/goal %s is rejected instead of creating a Goal',
    word => {
      const result = parseTargetCommand(`/goal ${word}`);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Unsupported Goal command');
    }
  );

  it('/goal clear --yes is rejected instead of becoming an objective', () => {
    const result = parseTargetCommand('/goal clear --yes');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unsupported Goal command');
  });

  it('/target is removed', () => {
    const result = parseTargetCommand('/target status');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Usage: /goal');
  });

  it('a normal natural-language objective still creates', () => {
    const result = parseTargetCommand('/goal clean the build cache');
    expect(result.ok).toBe(true);
    expect(result.input.action).toBe('create');
    expect(result.input.objective).toBe('clean the build cache');
  });

  it('the current clear contract is exact', () => {
    expect(parseTargetCommand('/goal clear')).toEqual({
      ok: true,
      input: { type: 'goal_control', action: 'clear' },
    });
    expect(parseTargetCommand('/goal clear --yes').ok).toBe(false);
  });
});

describe('#52.2 unquoteGitPath decodes multi-byte UTF-8 correctly', () => {
  const unquote: (p: string) => string = require('../src/services/workspace-diff').__testables
    .unquoteGitPath;

  it('accumulates consecutive octal escapes into one UTF-8 decode', () => {
    expect(unquote('"uni\\346\\226\\207.txt"')).toBe('uni文.txt');
    expect(unquote('"uni\\346\\226\\207.txt"')).not.toContain('\uFFFD');
  });

  it('still handles the standard C escapes', () => {
    expect(unquote('"a\\"b"')).toBe('a"b');
    expect(unquote('"a\\\\b"')).toBe('a\\b');
    expect(unquote('"a\\tb"')).toBe('a\tb');
  });

  it('mixes literal text, octal runs and escapes', () => {
    expect(unquote('"a\\346\\226\\207b\\"c"')).toBe('a文b"c');
  });

  it('handles a non-ASCII name that also contains a quote', () => {
    // git C-quotes this even with core.quotepath=false.
    expect(unquote('"\\346\\212\\245\\345\\221\\212\\"x.md"')).toBe('报告"x.md');
  });

  it('leaves unquoted paths untouched', () => {
    expect(unquote('plain/path.txt')).toBe('plain/path.txt');
  });
});

describe('#52.3 a dangling symlink no longer truncates completion', () => {
  const { matchFiles } = require('../src/services/file-glob');
  const { unlinkSync, rmdirSync, readdirSync } = require('fs');

  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-symlink-'));
  });

  afterEach(() => {
    // Tear down entry-by-entry: a recursive delete over a directory that holds
    // a dangling symlink trips some sandboxed rm implementations.
    for (const entry of readdirSync(root)) {
      const target = join(root, entry);
      try {
        unlinkSync(target);
      } catch {
        try {
          rmdirSync(target);
        } catch {
          /* best effort */
        }
      }
    }
    try {
      rmdirSync(root);
    } catch {
      /* best effort */
    }
  });

  it('entries after a broken symlink are still returned', () => {
    // readdirSync returns entries in an unspecified order, so create several
    // real files around the dangling link to make truncation observable.
    writeFileSync(join(root, 'aaa.txt'), 'x');
    symlinkSync(join(root, 'does-not-exist'), join(root, 'bbb-broken'));
    writeFileSync(join(root, 'ccc.txt'), 'x');
    mkdirSync(join(root, 'ddd-dir'));

    const names = matchFiles('', root).map((m: { path: string }) => m.path);
    expect(names).toContain('aaa.txt');
    expect(names).toContain('ccc.txt');
    expect(names).toContain('ddd-dir');
  });
});

describe('#52.4 caseSensitive is honoured by findRelevantMemories', () => {
  const { extractKeywords, calculateKeywordMatch } = require('../src/memory/relevant-finder');

  it('extractKeywords can preserve the original casing', () => {
    expect(extractKeywords('Deploy STAGING')).toEqual(['deploy', 'staging']);
    expect(extractKeywords('Deploy STAGING', true)).toEqual(['Deploy', 'STAGING']);
  });

  it('stop-word removal stays case-insensitive in preserveCase mode', () => {
    expect(extractKeywords('The Deploy', true)).toEqual(['Deploy']);
  });

  it('caseSensitive:true actually changes the match outcome', () => {
    const memory = {
      name: 'deploy-notes',
      description: 'staging deploy',
      content: 'deploy to staging',
      type: 'project',
    };

    const insensitive = calculateKeywordMatch(['STAGING'], memory, false);
    const sensitive = calculateKeywordMatch(['STAGING'], memory, true);

    expect(insensitive.score).toBeGreaterThan(0);
    expect(sensitive.score).toBe(0);
  });
});
