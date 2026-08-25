import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createAllowlistEvaluator,
  describeAllowlistSubject,
  grantToolPermission,
  matchAllowlistRules,
  parseAllowlistRules,
  resolveProjectToolAllowlist,
} from '../src/services/tool-allowlist';
import {
  loadGlobalConfig,
  saveGlobalConfig,
  saveProjectConfig,
} from '../src/services/global-config';

describe('tool allowlist policy input', () => {
  test('parses the versioned grammar and rejects malformed permissive rules', () => {
    const parsed = parseAllowlistRules([
      'allow:read_file(src/*)',
      'ask:exec_command(git push*)',
      'deny:*(*.env)',
      'read_file()',
      'bad tool',
      '# comment',
    ]);

    expect(parsed.rules).toEqual([
      {
        source: 'allow:read_file(src/*)',
        effect: 'allow',
        tool: 'read_file',
        pattern: 'src/*',
      },
      {
        source: 'ask:exec_command(git push*)',
        effect: 'ask',
        tool: 'exec_command',
        pattern: 'git push*',
      },
      { source: 'deny:*(*.env)', effect: 'deny', tool: '*', pattern: '*.env' },
    ]);
    expect(parsed.invalid).toEqual(['read_file()', 'bad tool']);
  });

  test('uses a bounded glob matcher and applies deny over ask over allow', () => {
    const rules = parseAllowlistRules([
      'allow:exec_command(git *)',
      'ask:exec_command(git push*)',
      'deny:exec_command(*--force*)',
    ]).rules;

    expect(matchAllowlistRules(rules, 'exec_command', { command: 'git status' })?.effect).toBe(
      'allow'
    );
    expect(matchAllowlistRules(rules, 'exec_command', { command: 'git push origin main' })?.effect)
      .toBe('ask');
    expect(
      matchAllowlistRules(rules, 'exec_command', { command: 'git push --force origin main' })
        ?.effect
    ).toBe('deny');
    expect(
      matchAllowlistRules(
        parseAllowlistRules([`deny:exec_command(${`${'*a'.repeat(2_000)}b`})`]).rules,
        'exec_command',
        { command: 'a'.repeat(20_000) }
      )
    ).toBeUndefined();
  });

  test('fails closed when a restrictive patterned rule has no canonical subject', () => {
    const deny = createAllowlistEvaluator(parseAllowlistRules(['deny:write_file(*.env)']).rules);
    const allow = createAllowlistEvaluator(parseAllowlistRules(['allow:write_file(*.env)']).rules);

    expect(deny?.('write_file', {})).toMatchObject({ effect: 'deny' });
    expect(allow?.('write_file', {})).toBeUndefined();
    expect(describeAllowlistSubject('write_file', { file_path: '  src/a.ts  ' })).toBe('src/a.ts');
  });
});

describe('project-scoped tool grants', () => {
  let configRoot: string;
  const originalConfigDir = process.env.ORION_CODE_CONFIG_DIR;

  beforeEach(() => {
    configRoot = mkdtempSync(join(tmpdir(), 'orion-allowlist-'));
    process.env.ORION_CODE_CONFIG_DIR = configRoot;
    saveGlobalConfig({ defaultModel: 'gpt-4o', toolConfirmation: 'allow' });
  });

  afterEach(() => {
    if (existsSync(configRoot)) rmSync(configRoot, { recursive: true, force: true });
    if (originalConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
    else process.env.ORION_CODE_CONFIG_DIR = originalConfigDir;
  });

  test('keeps project and global scopes distinct and lets restrictions win', () => {
    saveGlobalConfig({
      ...loadGlobalConfig(),
      allowedTools: ['allow:exec_command'],
    });
    saveProjectConfig('/repo/a', { allowedTools: ['deny:exec_command(*rm -rf*)'] });

    expect(
      resolveProjectToolAllowlist('/repo/a').evaluator?.('exec_command', { command: 'git status' })
    ).toMatchObject({ effect: 'allow', scope: 'global' });
    expect(
      resolveProjectToolAllowlist('/repo/a').evaluator?.('exec_command', { command: 'rm -rf build' })
    ).toMatchObject({ effect: 'deny', scope: 'project' });
  });

  test('persists explicit grants idempotently without broadening another project', () => {
    grantToolPermission('project', '/repo/a', 'write_file');
    grantToolPermission('project', '/repo/a', 'write_file');
    grantToolPermission('global', '/repo/a', 'read_file');

    expect(resolveProjectToolAllowlist('/repo/a').rules.map(rule => rule.source)).toEqual([
      'allow:read_file',
      'allow:write_file',
    ]);
    expect(resolveProjectToolAllowlist('/repo/b').rules.map(rule => rule.source)).toEqual([
      'allow:read_file',
    ]);
    expect(() => grantToolPermission('project', '/repo/a', '*')).toThrow(
      'Cannot persist permission for invalid tool name'
    );
  });
});
