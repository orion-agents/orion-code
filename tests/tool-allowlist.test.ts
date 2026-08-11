/**
 * v0.1.3-2 §1.3 — project-scoped allowlist rule engine.
 *
 * Covers the rule grammar, the "most restrictive wins" precedence, the
 * safety envelope (allowlist can tighten but never loosen tool policy,
 * plan mode or destructive gates) and the scheduler wiring.
 */

import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  parseAllowlistRules,
  matchAllowlistRules,
  createAllowlistEvaluator,
  describeAllowlistSubject,
  resolveProjectToolAllowlist,
  grantToolPermission,
  type ToolAllowlistEvaluator,
} from '../src/services/tool-allowlist';
import {
  loadGlobalConfig,
  saveGlobalConfig,
  saveProjectConfig,
} from '../src/services/global-config';
import { buildTool } from '../src/framework/tool';
import type { OrionCodeTool, ToolContext } from '../src/framework/tool';
import {
  prepareToolCalls,
  executeToolCalls,
  resolveEffectivePermission,
} from '../src/framework/tool-scheduler';
import type { ExecutedToolCall } from '../src/framework/tool-scheduler';
import type { Message } from '../src/services/llm';

// ============================================================================
// Fixtures
// ============================================================================

const execTool: OrionCodeTool = buildTool({
  name: 'exec_command',
  description: 'Run a shell command',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string', description: 'Command' } },
    required: ['command'],
  },
  execute: async () => ({ success: true, output: 'ran' }),
  isDestructive: args => /rm\s+-rf/.test((args.command as string) || ''),
  checkPermissions: () => ({ behavior: 'ask', reason: 'Command requires confirmation' }),
});

const readTool: OrionCodeTool = buildTool({
  name: 'read_file',
  description: 'Read a file',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path' } },
    required: ['path'],
  },
  execute: async () => ({ success: true, output: 'content' }),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
});

const blockedTool: OrionCodeTool = buildTool({
  name: 'danger_tool',
  description: 'Always denied by policy',
  parameters: { type: 'object', properties: {}, required: [] },
  execute: async () => ({ success: true, output: 'nope' }),
  checkPermissions: () => ({ behavior: 'deny', reason: 'Blocked by safety policy' }),
});

const fetchTool: OrionCodeTool = buildTool({
  name: 'web_fetch',
  description: 'Fetch a URL',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', description: 'URL' } },
    required: ['url'],
  },
  execute: async () => ({ success: true, output: 'fetched' }),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  checkPermissions: () => ({ behavior: 'ask', reason: 'External fetch' }),
});

const tools = [execTool, readTool, blockedTool, fetchTool];

const toolContext: ToolContext = {
  cwd: '/test',
  config: { name: 'orion-code', mode: 'development' },
};

function calls(
  entries: Array<[string, Record<string, unknown>]>
): NonNullable<Message['tool_calls']> {
  return entries.map(([name, args], i) => ({
    id: `call-${i}`,
    type: 'function' as const,
    function: { name, arguments: JSON.stringify(args) },
  }));
}

async function runAll(
  entries: Array<[string, Record<string, unknown>]>,
  options: {
    allowlist?: ToolAllowlistEvaluator;
    permissionMode?: string;
    toolConfirmation?: string;
    confirmToolUse?: (req: { name: string }) => Promise<boolean>;
  } = {}
): Promise<{ executed: ExecutedToolCall[]; executedNames: string[] }> {
  const executedNames: string[] = [];
  const toolExecutor = async (name: string) => {
    executedNames.push(name);
    return JSON.stringify({ success: true, output: `${name} ran` });
  };

  const prepared = prepareToolCalls({
    toolCalls: calls(entries),
    tools,
    toolExecutor,
    toolContext,
    toolAllowlist: options.allowlist,
    permissionMode: options.permissionMode,
    toolConfirmation: options.toolConfirmation,
    confirmToolUse: options.confirmToolUse as never,
  });

  const executed: ExecutedToolCall[] = [];
  for await (const item of executeToolCalls(prepared, {
    toolExecutor,
    permissionMode: options.permissionMode,
    toolConfirmation: options.toolConfirmation,
    confirmToolUse: options.confirmToolUse as never,
  })) {
    executed.push(item);
  }
  return { executed, executedNames };
}

// ============================================================================
// Parsing
// ============================================================================

describe('parseAllowlistRules', () => {
  test('parses bare tool names as allow rules', () => {
    const { rules, invalid } = parseAllowlistRules(['read_file', 'exec_command']);
    expect(invalid).toEqual([]);
    expect(rules.map(r => [r.effect, r.tool, r.pattern])).toEqual([
      ['allow', 'read_file', undefined],
      ['allow', 'exec_command', undefined],
    ]);
  });

  test('parses effect prefixes case-insensitively', () => {
    const { rules } = parseAllowlistRules([
      'DENY: exec_command',
      'Ask:write_file',
      'allow:read_file',
    ]);
    expect(rules.map(r => r.effect)).toEqual(['deny', 'ask', 'allow']);
  });

  test('parses subject patterns and wildcard tool', () => {
    const { rules, invalid } = parseAllowlistRules(['exec_command(git status*)', '*(*.env)']);
    expect(invalid).toEqual([]);
    expect(rules[0].pattern).toBe('git status*');
    expect(rules[1].tool).toBe('*');
    expect(rules[1].pattern).toBe('*.env');
  });

  test('skips blank lines and comments without reporting them as invalid', () => {
    const { rules, invalid } = parseAllowlistRules(['', '   ', '# a comment', 'read_file']);
    expect(rules).toHaveLength(1);
    expect(invalid).toEqual([]);
  });

  test('reports malformed entries instead of silently allowing them', () => {
    const { rules, invalid } = parseAllowlistRules([
      'exec_command(git status',
      'exec_command()',
      'bad name!',
      'exec_*_command',
      42 as unknown as string,
      'read_file',
    ]);
    expect(rules.map(r => r.tool)).toEqual(['read_file']);
    expect(invalid).toEqual([
      'exec_command(git status',
      'exec_command()',
      'bad name!',
      'exec_*_command',
      '42',
    ]);
  });

  test('returns an empty rule set for undefined config', () => {
    expect(parseAllowlistRules(undefined)).toEqual({ rules: [], invalid: [] });
    expect(createAllowlistEvaluator([])).toBeUndefined();
  });
});

// ============================================================================
// Subject extraction and matching
// ============================================================================

describe('describeAllowlistSubject', () => {
  test('prefers command, then file_path/path, then url', () => {
    expect(describeAllowlistSubject('exec_command', { command: 'git  status', path: 'x' })).toBe(
      'git status'
    );
    expect(describeAllowlistSubject('write_file', { path: ' src/a.ts ' })).toBe('src/a.ts');
    expect(describeAllowlistSubject('web_fetch', { url: 'https://a.dev' })).toBe('https://a.dev');
  });

  test('returns undefined when no inspectable string argument exists', () => {
    expect(describeAllowlistSubject('noop', { count: 3 })).toBeUndefined();
    expect(describeAllowlistSubject('noop', {})).toBeUndefined();
    expect(describeAllowlistSubject('noop', undefined)).toBeUndefined();
  });
});

describe('matchAllowlistRules', () => {
  const match = (entries: string[], name: string, args: Record<string, unknown>) =>
    matchAllowlistRules(parseAllowlistRules(entries).rules, name, args);

  test('matches by exact tool name only', () => {
    expect(match(['read_file'], 'read_file', { path: 'a' })?.effect).toBe('allow');
    expect(match(['read_file'], 'write_file', { path: 'a' })).toBeUndefined();
  });

  test('matches the wildcard tool for any call', () => {
    expect(match(['deny:*'], 'anything', {})?.effect).toBe('deny');
  });

  test('applies the subject glob', () => {
    expect(
      match(['exec_command(git status*)'], 'exec_command', { command: 'git status -s' })?.effect
    ).toBe('allow');
    expect(
      match(['exec_command(git status*)'], 'exec_command', { command: 'git push' })
    ).toBeUndefined();
  });

  test('is order independent and most restrictive wins', () => {
    const entries = ['exec_command', 'deny:exec_command(*rm -rf*)', 'ask:exec_command(git push*)'];
    expect(match(entries, 'exec_command', { command: 'ls' })?.effect).toBe('allow');
    expect(match(entries, 'exec_command', { command: 'git push origin main' })?.effect).toBe('ask');
    expect(match(entries, 'exec_command', { command: 'sudo rm -rf /' })?.effect).toBe('deny');
    // Reversing the config order must not change the outcome.
    expect(
      match([...entries].reverse(), 'exec_command', { command: 'sudo rm -rf /' })?.effect
    ).toBe('deny');
  });

  test('fails closed when the subject cannot be determined', () => {
    // A pattern rule cannot be verified without a subject: restrictive rules
    // still apply, permissive ones must not.
    expect(match(['deny:mystery(*secret*)'], 'mystery', { count: 1 })?.effect).toBe('deny');
    expect(match(['ask:mystery(*secret*)'], 'mystery', { count: 1 })?.effect).toBe('ask');
    expect(match(['allow:mystery(*secret*)'], 'mystery', { count: 1 })).toBeUndefined();
  });

  test('returns undefined when there are no rules', () => {
    expect(matchAllowlistRules([], 'read_file', {})).toBeUndefined();
  });
});

describe('glob semantics (regex-free matcher)', () => {
  const hit = (pattern: string, subject: string) =>
    Boolean(
      matchAllowlistRules(parseAllowlistRules([`t(${pattern})`]).rules, 't', { command: subject })
    );

  test('anchors the whole subject', () => {
    expect(hit('git status', 'git status')).toBe(true);
    expect(hit('git status', 'git status -s')).toBe(false);
    expect(hit('git status', 'sudo git status')).toBe(false);
  });

  test('`*` spans any run of characters, `?` exactly one', () => {
    expect(hit('git *', 'git push origin main')).toBe(true);
    expect(hit('*rm -rf*', 'sudo rm -rf /tmp')).toBe(true);
    expect(hit('a?c', 'abc')).toBe(true);
    expect(hit('a?c', 'ac')).toBe(false);
    expect(hit('a?c', 'abbc')).toBe(false);
    // A single `?` consumes one code point, not one UTF-16 unit.
    expect(hit('a?c', 'a\u{1F600}c')).toBe(true);
  });

  test('trailing and consecutive stars collapse correctly', () => {
    // Note: an empty subject is reported as "no subject" by
    // describeAllowlistSubject, so it is covered by the fail-closed test above
    // rather than here.
    expect(hit('**', 'anything')).toBe(true);
    expect(hit('git**status', 'git status')).toBe(true);
    expect(hit('git*', 'git')).toBe(true);
  });

  test('regex metacharacters in a pattern stay literal', () => {
    expect(hit('a.c', 'abc')).toBe(false);
    expect(hit('a.c', 'a.c')).toBe(true);
    expect(hit('node -e "x+y"', 'node -e "x+y"')).toBe(true);
    // The pattern spans the first `(` to the trailing `)`, so nested parens are
    // literal characters rather than grouping syntax.
    expect(hit('run(1)', 'run(1)')).toBe(true);
    expect(hit('run(1)', 'run1')).toBe(false);
    expect(hit('[a-z]+', '[a-z]+')).toBe(true);
    expect(hit('[a-z]+', 'abc')).toBe(false);
  });

  test('subject whitespace is normalized before matching', () => {
    // describeAllowlistSubject collapses runs of whitespace, so a multi-line
    // command still matches a single-space pattern.
    expect(hit('git commit -m *', 'git   commit\n-m  "wip"')).toBe(true);
  });

  test('pathological glob/subject pairs match in linear time (no ReDoS)', () => {
    // `(a*)*b`-shaped inputs are the classic catastrophic-backtracking trigger
    // for a compiled RegExp. The two-pointer matcher must stay fast.
    const pattern = `${'*a'.repeat(40)}*b`;
    const subject = 'a'.repeat(4000);
    const started = Date.now();
    expect(hit(pattern, subject)).toBe(false);
    expect(hit('*'.repeat(200), subject)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

// ============================================================================
// Precedence contract
// ============================================================================

describe('resolveEffectivePermission precedence', () => {
  const resolve = (input: Parameters<typeof resolveEffectivePermission>[0]) =>
    resolveEffectivePermission(input);

  test('tool policy deny always wins over an allow rule', () => {
    const decision = resolve({
      toolName: 'danger_tool',
      tool: blockedTool,
      args: {},
      permission: { behavior: 'deny', reason: 'Blocked by safety policy' },
      allowlist: { effect: 'allow', rule: 'danger_tool' },
    });
    expect(decision).toMatchObject({ outcome: 'deny', source: 'tool_policy' });
  });

  test('a deny rule blocks a tool that the tool policy would have allowed', () => {
    const decision = resolve({
      toolName: 'read_file',
      tool: readTool,
      args: { path: '.env' },
      permission: undefined,
      allowlist: { effect: 'deny', rule: 'deny:read_file(*.env)' },
    });
    expect(decision.outcome).toBe('deny');
    expect(decision.source).toBe('allowlist_deny');
    expect(decision.reason).toContain('deny:read_file(*.env)');
  });

  test('plan mode still blocks a tool covered by an allow rule', () => {
    const decision = resolve({
      toolName: 'exec_command',
      tool: execTool,
      args: { command: 'git status' },
      permission: { behavior: 'ask', reason: 'Command requires confirmation' },
      permissionMode: 'plan',
      allowlist: { effect: 'allow', rule: 'exec_command(git status*)' },
    });
    expect(decision).toMatchObject({ outcome: 'block', source: 'plan_mode' });
  });

  test('an ask rule overrides auto mode', () => {
    const decision = resolve({
      toolName: 'exec_command',
      tool: execTool,
      args: { command: 'git push' },
      permission: { behavior: 'ask', reason: 'Command requires confirmation' },
      permissionMode: 'auto',
      allowlist: { effect: 'ask', rule: 'ask:exec_command(git push*)' },
    });
    expect(decision.outcome).toBe('confirm');
  });

  test('an ask rule escalates an otherwise auto-allowed tool', () => {
    const decision = resolve({
      toolName: 'read_file',
      tool: readTool,
      args: { path: 'secrets.env' },
      permission: undefined,
      allowlist: { effect: 'ask', rule: 'ask:read_file(*.env)' },
    });
    expect(decision.outcome).toBe('confirm');
    expect(decision.reason).toContain('ask:read_file(*.env)');
  });

  test('an explicit allow rule cannot auto-approve a destructive non-file invocation', () => {
    const decision = resolve({
      toolName: 'exec_command',
      tool: execTool,
      args: { command: 'rm -rf build' },
      permission: { behavior: 'ask', reason: 'Command requires confirmation' },
      allowlist: { effect: 'allow', rule: 'exec_command' },
    });
    expect(decision).toMatchObject({
      outcome: 'confirm',
      source: 'risk_guard',
      risk: 'destructive',
    });
  });

  test('an allow rule downgrades a non-destructive ask to auto-approval', () => {
    const decision = resolve({
      toolName: 'exec_command',
      tool: execTool,
      args: { command: 'git status' },
      permission: { behavior: 'ask', reason: 'Command requires confirmation' },
      allowlist: { effect: 'allow', rule: 'exec_command(git status*)' },
    });
    expect(decision).toMatchObject({ outcome: 'allow', source: 'allowlist_allow' });
  });

  test('no rules keeps the historic mode behaviour', () => {
    expect(
      resolve({
        toolName: 'exec_command',
        tool: execTool,
        args: { command: 'git status' },
        permission: { behavior: 'ask', reason: 'ask' },
      }).outcome
    ).toBe('confirm');
    expect(
      resolve({
        toolName: 'read_file',
        tool: readTool,
        args: { path: 'a.ts' },
      }).outcome
    ).toBe('allow');
  });
});

// ============================================================================
// Scheduler integration
// ============================================================================

describe('tool scheduler with a project allowlist', () => {
  test('allow rule executes without prompting and records the decision source', async () => {
    const confirmToolUse = jest.fn(async () => true);
    const allowlist = createAllowlistEvaluator(
      parseAllowlistRules(['exec_command(git status*)']).rules
    );

    const { executed, executedNames } = await runAll(
      [['exec_command', { command: 'git status --short' }]],
      { allowlist, toolConfirmation: 'ask', confirmToolUse }
    );

    expect(confirmToolUse).not.toHaveBeenCalled();
    expect(executedNames).toEqual(['exec_command']);
    expect(executed[0].permissionDecision).toMatchObject({
      approved: true,
      source: 'allowlist_allow',
    });
  });

  test('deny rule blocks execution entirely and names the rule', async () => {
    const confirmToolUse = jest.fn(async () => true);
    const allowlist = createAllowlistEvaluator(
      parseAllowlistRules(['exec_command', 'deny:exec_command(*rm -rf*)']).rules
    );

    const { executed, executedNames } = await runAll(
      [['exec_command', { command: 'rm -rf /tmp/x' }]],
      { allowlist, toolConfirmation: 'allow', confirmToolUse }
    );

    expect(executedNames).toEqual([]);
    expect(confirmToolUse).not.toHaveBeenCalled();
    expect(executed[0].permissionDecision).toMatchObject({
      approved: false,
      behavior: 'deny',
      source: 'allowlist_deny',
    });
    expect(executed[0].error).toContain('deny:exec_command(*rm -rf*)');
  });

  test('a deny rule beats toolConfirmation=allow for a read-only tool', async () => {
    const allowlist = createAllowlistEvaluator(
      parseAllowlistRules(['deny:read_file(*.env)']).rules
    );

    const { executed, executedNames } = await runAll([['read_file', { path: 'secrets.env' }]], {
      allowlist,
      toolConfirmation: 'allow',
    });

    expect(executedNames).toEqual([]);
    expect(executed[0].permissionDecision?.source).toBe('allowlist_deny');
  });

  test('an ask rule still prompts while permissionMode=auto', async () => {
    const confirmToolUse = jest.fn(async () => false);
    const allowlist = createAllowlistEvaluator(
      parseAllowlistRules(['ask:exec_command(git push*)']).rules
    );

    const { executed, executedNames } = await runAll(
      [['exec_command', { command: 'git push origin main' }]],
      { allowlist, permissionMode: 'auto', toolConfirmation: 'ask', confirmToolUse }
    );

    expect(confirmToolUse).toHaveBeenCalledTimes(1);
    expect(executedNames).toEqual([]);
    expect(executed[0].permissionDecision).toMatchObject({ approved: false, source: 'user' });
  });

  test('plan mode is not weakened by an allow rule', async () => {
    const allowlist = createAllowlistEvaluator(parseAllowlistRules(['exec_command']).rules);

    const { executed, executedNames } = await runAll([['exec_command', { command: 'ls' }]], {
      allowlist,
      permissionMode: 'plan',
      toolConfirmation: 'allow',
    });

    expect(executedNames).toEqual([]);
    expect(executed[0].permissionDecision?.source).toBe('plan_mode');
    expect(executed[0].error).toContain('blocked in plan mode');
  });

  test('allowlisted external ask tools are persistently approved and may retain safe concurrency', async () => {
    const allowlist = createAllowlistEvaluator(parseAllowlistRules(['web_fetch']).rules);

    const prepared = prepareToolCalls({
      toolCalls: calls([
        ['web_fetch', { url: 'https://a.dev' }],
        ['web_fetch', { url: 'https://b.dev' }],
      ]),
      tools,
      toolExecutor: async () => '',
      toolContext,
      toolAllowlist: allowlist,
      toolConfirmation: 'ask',
      confirmToolUse: async () => true,
    });

    expect(prepared.every(p => p.canRunConcurrently)).toBe(true);
    expect(prepared[0].allowlist).toEqual({ effect: 'allow', rule: 'web_fetch' });

    const { executedNames } = await runAll([['web_fetch', { url: 'https://a.dev' }]], {
      allowlist,
      toolConfirmation: 'ask',
    });
    expect(executedNames).toEqual(['web_fetch']);
  });

  test('an ask rule forces a concurrency-safe tool back to serial execution', () => {
    const allowlist = createAllowlistEvaluator(parseAllowlistRules(['ask:read_file(*.env)']).rules);

    const prepared = prepareToolCalls({
      toolCalls: calls([['read_file', { path: 'a.env' }]]),
      tools,
      toolExecutor: async () => '',
      toolContext,
      toolAllowlist: allowlist,
      toolConfirmation: 'ask',
      confirmToolUse: async () => true,
    });

    expect(prepared[0].canRunConcurrently).toBe(false);
  });

  test('no allowlist keeps existing behaviour untouched', async () => {
    const confirmToolUse = jest.fn(async () => true);
    const { executedNames } = await runAll([['exec_command', { command: 'git status' }]], {
      toolConfirmation: 'ask',
      confirmToolUse,
    });
    expect(confirmToolUse).toHaveBeenCalledTimes(1);
    expect(executedNames).toEqual(['exec_command']);
  });
});

// ============================================================================
// Project scoping
// ============================================================================

describe('resolveProjectToolAllowlist', () => {
  const testDir = mkdtempSync(join(tmpdir(), 'orion-allowlist-'));
  const originalEnv = process.env.ORION_CODE_CONFIG_DIR;

  beforeAll(() => {
    process.env.ORION_CODE_CONFIG_DIR = testDir;
  });

  beforeEach(() => {
    saveGlobalConfig({ defaultModel: 'gpt-4o', toolConfirmation: 'allow' });
  });

  afterAll(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    if (originalEnv !== undefined) {
      process.env.ORION_CODE_CONFIG_DIR = originalEnv;
    } else {
      delete process.env.ORION_CODE_CONFIG_DIR;
    }
  });

  test('rules are scoped to their own project path', () => {
    saveProjectConfig('/repo/a', { allowedTools: ['exec_command(git status*)', 'bogus rule!'] });
    saveProjectConfig('/repo/b', {});

    const a = resolveProjectToolAllowlist('/repo/a');
    expect(a.rules).toHaveLength(1);
    expect(a.invalid).toEqual(['bogus rule!']);
    expect(a.evaluator?.('exec_command', { command: 'git status' })).toEqual({
      effect: 'allow',
      rule: 'exec_command(git status*)',
      scope: 'project',
    });

    const b = resolveProjectToolAllowlist('/repo/b');
    expect(b.rules).toEqual([]);
    expect(b.evaluator).toBeUndefined();
  });

  test('unknown project paths resolve to no rules', () => {
    const unknown = resolveProjectToolAllowlist('/repo/never-configured');
    expect(unknown.evaluator).toBeUndefined();
    expect(unknown.invalid).toEqual([]);
  });

  test('global rules apply to every project while project restrictions still win', () => {
    saveGlobalConfig({
      ...loadGlobalConfig(),
      allowedTools: ['allow:exec_command'],
      projects: {
        '/repo/a': { allowedTools: ['deny:exec_command(rm -rf*)'] },
        '/repo/b': { allowedTools: ['ask:exec_command(git push*)'] },
      },
    });

    expect(
      resolveProjectToolAllowlist('/repo/c').evaluator?.('exec_command', { command: 'ls' })
    ).toEqual({ effect: 'allow', rule: 'allow:exec_command', scope: 'global' });
    expect(
      resolveProjectToolAllowlist('/repo/a').evaluator?.('exec_command', { command: 'rm -rf x' })
    ).toEqual({ effect: 'deny', rule: 'deny:exec_command(rm -rf*)', scope: 'project' });
    expect(
      resolveProjectToolAllowlist('/repo/b').evaluator?.('exec_command', { command: 'git push' })
    ).toEqual({ effect: 'ask', rule: 'ask:exec_command(git push*)', scope: 'project' });
  });

  test('persists idempotent project and machine-wide grants', () => {
    grantToolPermission('project', '/repo/grants', 'exec_command');
    grantToolPermission('project', '/repo/grants', 'exec_command');
    grantToolPermission('global', '/repo/grants', 'web_fetch');

    expect(loadGlobalConfig().projects?.['/repo/grants']?.allowedTools).toEqual([
      'allow:exec_command',
    ]);
    expect(loadGlobalConfig().allowedTools).toEqual(['allow:web_fetch']);
    expect(
      resolveProjectToolAllowlist('/another/repo').evaluator?.('web_fetch', {
        url: 'https://example.com',
      })
    ).toEqual({ effect: 'allow', rule: 'allow:web_fetch', scope: 'global' });
  });
});
