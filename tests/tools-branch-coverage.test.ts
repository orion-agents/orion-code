import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: jest.fn(),
  spawn: jest.fn(),
  spawnSync: jest.fn(),
}));

import { execFile, spawn, spawnSync } from 'child_process';
import type { ToolContext } from '../src/framework/tool';
import { getRuntimeTools, getToolNames, TOOLS } from '../src/tools';
import { gitPushTool, gitStatusTool } from '../src/tools/git';
import {
  buildMcpToolName,
  getMcpConfigPath,
  mcpCallTool,
  mcpListTool,
  mcpManager,
} from '../src/tools/mcp';
import {
  lspGetDefinitionTool,
  lspGetDiagnosticsTool,
  lspGetHoverTool,
  lspGetReferencesTool,
} from '../src/tools/lsp';
import {
  clearWebFetchCache,
  isUrlSafeForSSRF,
  webFetchTool,
  webSearchTool,
} from '../src/tools/web';
import { ORION_USER_AGENT } from '../src/product/version';

const context: ToolContext = {
  cwd: process.cwd(),
  config: { name: 'branch-coverage', mode: 'development' },
};

function getTool(name: string) {
  const tool = TOOLS.find(candidate => candidate.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool;
}

type GitReply = {
  stdout?: string;
  stderr?: string;
  error?: (Error & { code?: number }) | null;
};

function scriptGit(...replies: GitReply[]): void {
  (execFile as unknown as jest.Mock).mockImplementation(
    (
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void
    ) => {
      const reply = replies.shift();
      if (!reply) throw new Error('Unexpected git invocation');
      queueMicrotask(() =>
        callback(
          reply.error ?? null,
          Buffer.from(reply.stdout ?? ''),
          Buffer.from(reply.stderr ?? '')
        )
      );
    }
  );
}

describe('core tool validation and result summaries', () => {
  test.each([
    ['read_file', {}, 'requires a path'],
    ['read_file', { path: 'package.json', maxLines: 0 }, 'maxLines must be a positive integer'],
    ['read_file', { path: 'package.json', offset: 1.5 }, 'offset must be a positive integer'],
    ['write_file', {}, 'requires a path'],
    ['write_file', { path: 'x' }, 'requires a content'],
    ['list_files', {}, 'requires a path'],
    ['exec_command', {}, 'requires a command'],
    ['edit_file', {}, 'requires a path'],
    ['edit_file', { path: 'x' }, 'requires an old_string'],
    ['edit_file', { path: 'x', old_string: 'a' }, 'requires a new_string'],
    ['glob', {}, 'requires a pattern'],
    ['grep', {}, 'requires a pattern'],
    ['memory_save', { content: 'x' }, 'requires a name'],
    ['memory_save', { name: 'x', type: 'other', content: 'x' }, 'requires a valid type'],
    ['memory_save', { name: 'x', type: 'user' }, 'requires a content'],
    ['memory_forget', {}, 'requires a name'],
    ['history_search', {}, 'requires a query'],
  ])('%s rejects invalid arguments', async (name, args, message) => {
    const result = await getTool(name).execute(args, context);
    expect(result).toEqual(
      expect.objectContaining({ success: false, error: expect.stringContaining(message) })
    );
  });

  test.each([
    [undefined, 'requires steps to be an array'],
    ['not-json', 'valid JSON array string'],
    [[], 'requires at least one step'],
    [Array.from({ length: 9 }, () => ({ tool: 'read_file', args: {} })), 'at most 8 steps'],
    [[null], 'must be an object'],
    [[{}], 'requires a tool string'],
    [[{ tool: 'read_file', args: 'not-json' }], 'valid JSON object string'],
    [[{ tool: 'read_file', args: [] }], 'requires args to be an object'],
    [[{ tool: 'write_file', args: {} }], 'is not allowed'],
  ])('batch_read rejects malformed or unsafe steps', async (steps, message) => {
    const result = await getTool('batch_read').execute({ steps }, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain(message);
  });

  test('exposes stable runtime names and metadata branches', () => {
    const names = getToolNames();
    expect(names).toContain('read_file');
    expect(getRuntimeTools().length).toBeGreaterThanOrEqual(TOOLS.length);

    const read = getTool('read_file');
    expect(
      read.getSummary?.({ path: 'x' }, { success: false, output: '', error: 'bad' })
    ).toContain('error');
    expect(read.getSummary?.({ path: 'x' }, { success: true, output: 'a\nb' })).toContain('2L');

    const write = getTool('write_file');
    expect(write.checkPermissions?.({}, context).behavior).toBe('ask');
    expect(
      write.getSummary?.({ path: 'x', content: '你好' }, { success: true, output: 'ok' })
    ).toContain('6B');
    expect(write.getSummary?.({ path: 'x' }, { success: false, output: '' })).toContain('error');

    const exec = getTool('exec_command');
    expect(exec.isDestructive?.({ command: 'rm -rf build' })).toBe(true);
    expect(exec.isDestructive?.({ command: 'pwd' })).toBe(false);
    expect(exec.checkPermissions?.({ command: 'pwd' }, context).behavior).toBe('allow');
    expect(exec.checkPermissions?.({ command: 'npm install' }, context).behavior).toBe('ask');
    expect(exec.userFacingName?.({ command: `echo ${'x'.repeat(100)}` })).toContain('...');
    expect(
      exec.getSummary?.({ command: '' }, { success: false, output: '', error: 'boom' })
    ).toContain('boom');
    expect(exec.getSummary?.({ command: 'pwd' }, { success: true, output: '/tmp' })).toContain(
      '4B'
    );
  });
});

describe('git tools branch behavior', () => {
  beforeEach(() => jest.clearAllMocks());

  test('git_status reports failures and classifies porcelain status codes', async () => {
    scriptGit({ error: Object.assign(new Error('not a repository'), { code: 128 }) });
    await expect(gitStatusTool.execute({}, context)).resolves.toEqual(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining('not a repository'),
      })
    );

    scriptGit({ stdout: '?? new.txt\n M work.ts\nM  staged.ts\nAM both.ts\n D deleted.ts' });
    const result = await gitStatusTool.execute({ cwd: '/repo' }, context);
    expect(result.success).toBe(true);
    expect(JSON.parse(result.output)).toEqual({
      clean: false,
      untracked: ['new.txt'],
      modified: ['work.ts', 'both.ts', 'deleted.ts'],
      staged: ['staged.ts', 'both.ts'],
      total: 5,
    });
  });

  test('git_push validates inputs and reports explicit-path staging failures', async () => {
    await expect(gitPushTool.execute({}, context)).resolves.toEqual(
      expect.objectContaining({ success: false, error: expect.stringContaining('commit message') })
    );
    await expect(gitPushTool.execute({ message: 'save', add_all: true }, context)).resolves.toEqual(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining('add_all=true is disabled'),
      })
    );
    await expect(
      gitPushTool.execute({ message: 'save', paths: ['ok', ''] }, context)
    ).resolves.toEqual(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining('exact repository-relative'),
      })
    );
    await expect(gitPushTool.execute({ message: 'save', paths: ['.'] }, context)).resolves.toEqual(
      expect.objectContaining({ success: false, error: expect.stringContaining('pathspec') })
    );
    await expect(
      gitPushTool.execute({ message: 'save', paths: [':(glob)**'] }, context)
    ).resolves.toEqual(
      expect.objectContaining({ success: false, error: expect.stringContaining('pathspec') })
    );

    scriptGit(
      { stdout: 'MM a\n M b\n M c\n M d\n M e\n M f' },
      { stdout: 'a\0' },
      { stdout: 'b\0' },
      { stdout: '' },
      { stdout: '1111111111111111111111111111111111111111' },
      { error: new Error('index locked'), stderr: 'fatal' },
      { stdout: '' }
    );
    const result = await gitPushTool.execute({ message: 'save', paths: ['a', 'b'] }, context);
    expect(result.success).toBe(false);
    expect(result.output).toContain('a, b, c, d, e...');
    expect(result.error).toContain('index locked');
    expect(result.error).toContain('index restored');

    jest.clearAllMocks();
    scriptGit({ stdout: ' M src/tools/git.ts' }, { stdout: 'src/cli.ts\0src/tools/git.ts\0' });
    const directory = await gitPushTool.execute(
      { message: 'save', paths: ['src'], verify: false },
      context
    );
    expect(directory.error).toContain('exact files');
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  test('git_push tolerates nothing-to-commit but rejects a missing origin', async () => {
    scriptGit(
      { stdout: 'M  staged.ts' },
      { stdout: 'staged.ts\0' },
      { stdout: 'staged.ts\0' },
      { stdout: '1111111111111111111111111111111111111111' },
      { stdout: 'added' },
      { stdout: 'staged.ts\0' },
      { stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      { error: new Error('commit failed'), stdout: 'nothing to commit' },
      { stdout: '' },
      { stdout: 'upstream git@example.test/repo.git (fetch)' }
    );
    const result = await gitPushTool.execute({ message: 'save', paths: ['staged.ts'] }, context);
    expect(result.success).toBe(false);
    expect(result.output).toContain('Nothing new to commit');
    expect(result.error).toContain('No remote origin configured');
  });

  test('git_push restores the original index when commit fails', async () => {
    scriptGit(
      { stdout: ' M selected.ts' },
      { stdout: 'selected.ts\0' },
      { stdout: '' },
      { stdout: '1111111111111111111111111111111111111111' },
      { stdout: 'added' },
      { stdout: 'selected.ts\0' },
      { stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      { error: new Error('hook rejected commit'), stderr: 'pre-commit failed' },
      { stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      { stdout: '' }
    );

    const result = await gitPushTool.execute(
      { message: 'save selected', paths: ['selected.ts'], verify: false },
      context
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining('index restored'),
      })
    );
    expect(result.error).toContain('hook rejected commit');
    expect((execFile as unknown as jest.Mock).mock.calls[9][1]).toEqual([
      'read-tree',
      '1111111111111111111111111111111111111111',
    ]);
  });

  test('git_push reports unexpected HEAD changes before restoring the index snapshot', async () => {
    scriptGit(
      { stdout: ' M selected.ts' },
      { stdout: 'selected.ts\0' },
      { stdout: '' },
      { stdout: '1111111111111111111111111111111111111111' },
      { stdout: 'added' },
      { stdout: 'selected.ts\0' },
      { stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      { error: new Error('hook changed HEAD'), stderr: 'pre-commit failed' },
      { stdout: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      { stdout: '' }
    );

    const result = await gitPushTool.execute(
      { message: 'save selected', paths: ['selected.ts'], verify: false },
      context
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining('HEAD changed unexpectedly'),
      })
    );
    expect(result.error).toContain('manual recovery required');
    expect(result.error).toContain('index restored');
  });

  test('git_push reports an index rollback failure after a rejected commit', async () => {
    scriptGit(
      { stdout: ' M selected.ts' },
      { stdout: 'selected.ts\0' },
      { stdout: '' },
      { stdout: '1111111111111111111111111111111111111111' },
      { stdout: 'added' },
      { stdout: 'selected.ts\0' },
      { stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      { error: new Error('hook rejected commit'), stderr: 'pre-commit failed' },
      { stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      { error: new Error('index locked') }
    );

    const result = await gitPushTool.execute(
      { message: 'save selected', paths: ['selected.ts'], verify: false },
      context
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining('index rollback failed: index locked'),
      })
    );
  });

  test.each([
    'Authentication failed',
    'Permission denied',
    'could not read Username',
    'fatal: could not read Password',
  ])('git_push recognizes remote credential failure: %s', async authMessage => {
    scriptGit(
      { stdout: '' },
      { stdout: 'origin git@example.test/repo.git (fetch)' },
      { error: new Error('auth'), stderr: authMessage }
    );
    const result = await gitPushTool.execute({ message: 'save' }, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Authentication failed');
  });

  test('git_push reports generic auth and push failures', async () => {
    scriptGit(
      { stdout: '' },
      { stdout: 'origin git@example.test/repo.git (fetch)' },
      { error: new Error('network down') }
    );
    const auth = await gitPushTool.execute({ message: 'save' }, context);
    expect(auth.error).toContain('network down');

    scriptGit({ stdout: '' }, { error: new Error('push rejected') });
    const push = await gitPushTool.execute({ message: 'save', verify: false }, context);
    expect(push.error).toContain('push rejected');
  });

  test('git_push warns when files remain and when untracked output exceeds five entries', async () => {
    scriptGit(
      { stdout: '' },
      { stdout: 'origin git@example.test/repo.git (fetch)' },
      { stdout: 'abc refs/heads/main' },
      { stdout: 'pushed' },
      { stdout: 'MM remaining.ts' },
      { stdout: 'abc123 latest' },
      { stdout: '?? a\n?? b\n?? c\n?? d\n?? e\n?? f' }
    );
    const result = await gitPushTool.execute({ message: 'save' }, context);
    expect(result.success).toBe(false);
    expect(result.output).toContain('6 untracked files');
    expect(result.output).toContain('a, b, c, d, e...');
    expect(result.output).toContain('remaining.ts');
  });

  test('git_push verifies an explicit pre-staged allowlist and completes a clean push', async () => {
    scriptGit(
      { stdout: ' M local.ts' },
      { stdout: 'local.ts\0' },
      { stdout: 'local.ts\0' },
      { stdout: '1111111111111111111111111111111111111111' },
      { stdout: 'added' },
      { stdout: 'local.ts\0' },
      { stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      { stdout: '[main abc] commit' },
      { stdout: '' },
      { stdout: 'pushed' },
      { stdout: '' },
      { stdout: 'abc123 latest' },
      { stdout: '' },
      { stdout: 'main' },
      { stdout: 'origin' }
    );
    const result = await gitPushTool.execute(
      {
        message: 'a very long commit message that is deliberately more than fifty characters long',
        add_all: false,
        paths: ['./local.ts'],
        verify: false,
      },
      context
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('Staging 1 explicit file');
    expect(result.output).toContain('Commit successful');
    expect(result.output).toContain('Pushed branch: main');
    expect(result.output).toContain('Remote: origin');
    expect(result.output).toContain('Latest commit: abc123 latest');
    expect(gitPushTool.isDestructive?.({})).toBe(true);
    expect(gitPushTool.isConcurrencySafe?.({})).toBe(false);
    expect(gitPushTool.checkPermissions?.({}, context).behavior).toBe('ask');
    expect(gitPushTool.userFacingName?.({})).toBe('Git Push: undefined');
  });

  test('git_push stops before commit or push when no explicit or existing staged files exist', async () => {
    scriptGit({ stdout: ' M local.ts' });

    const result = await gitPushTool.execute({ message: 'save', verify: false }, context);

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining('explicit file paths allowlist'),
      })
    );
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  test('git_push rejects pre-staged files outside the explicit allowlist', async () => {
    scriptGit(
      { stdout: 'M  protected.txt\n M selected.ts' },
      { stdout: 'selected.ts\0' },
      { stdout: 'protected.txt\0' }
    );

    const result = await gitPushTool.execute(
      { message: 'save selected', paths: ['selected.ts'], verify: false },
      context
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining('Pre-staged files fall outside'),
      })
    );
    expect(result.error).toContain('protected.txt');
    expect(execFile).toHaveBeenCalledTimes(3);
  });

  test('git_push rejects a staged set that expands beyond exact file paths', async () => {
    scriptGit(
      { stdout: ' M selected.ts\n M protected.txt' },
      { stdout: 'selected.ts\0' },
      { stdout: '' },
      { stdout: '1111111111111111111111111111111111111111' },
      { stdout: 'added' },
      { stdout: 'selected.ts\0protected.txt\0' },
      { stdout: '' }
    );

    const result = await gitPushTool.execute(
      { message: 'save selected', paths: ['selected.ts'], verify: false },
      context
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining('not exactly match'),
      })
    );
    expect(result.error).toContain('protected.txt');
    expect(result.error).toContain('index restored');
    expect(execFile).toHaveBeenCalledTimes(7);
  });

  test('git_push stops before remote writes when files remain outside the committed boundary', async () => {
    scriptGit(
      { stdout: ' M selected.ts\n?? protected.txt' },
      { stdout: 'selected.ts\0' },
      { stdout: '' },
      { stdout: '1111111111111111111111111111111111111111' },
      { stdout: 'added' },
      { stdout: 'selected.ts\0' },
      { stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      { stdout: '[main abc] commit' },
      { stdout: '?? protected.txt' }
    );

    const result = await gitPushTool.execute(
      { message: 'save selected', paths: ['selected.ts'], verify: false },
      context
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining('push was not attempted'),
      })
    );
    expect(execFile).toHaveBeenCalledTimes(9);
    expect((execFile as unknown as jest.Mock).mock.calls[4][1]).toEqual([
      'add',
      '--',
      'selected.ts',
    ]);
  });

  test('git_push fails closed when the initial status probe fails', async () => {
    scriptGit({ error: new Error('status unavailable') });

    const result = await gitPushTool.execute({ message: 'save', verify: false }, context);

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining('git status failed: status unavailable'),
      })
    );
  });

  test.each([
    {
      name: 'final porcelain status',
      replies: [
        { stdout: '' },
        { stdout: 'pushed' },
        { error: new Error('porcelain unavailable') },
      ],
      error: 'Final git status failed: porcelain unavailable',
    },
    {
      name: 'final log',
      replies: [
        { stdout: '' },
        { stdout: 'pushed' },
        { stdout: '' },
        { error: new Error('log unavailable') },
      ],
      error: 'Final git log failed: log unavailable',
    },
    {
      name: 'final short status',
      replies: [
        { stdout: '' },
        { stdout: 'pushed' },
        { stdout: '' },
        { stdout: 'abc123 latest' },
        { error: new Error('short status unavailable') },
      ],
      error: 'Final git status --short failed: short status unavailable',
    },
  ])('git_push fails closed when the $name probe fails', async ({ replies, error }) => {
    scriptGit(...replies);

    const result = await gitPushTool.execute({ message: 'save', verify: false }, context);

    expect(result).toEqual(expect.objectContaining({ success: false, error }));
  });
});

describe('web tools branch behavior', () => {
  const originalFetch = global.fetch;

  function response(
    overrides: Omit<Partial<Response>, 'body'> & { bodyText?: string } = {}
  ): Response {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      redirected: false,
      url: 'https://example.com/page',
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: jest.fn().mockResolvedValue(overrides.bodyText ?? 'plain content'),
      ...overrides,
    } as unknown as Response;
  }

  beforeEach(() => {
    clearWebFetchCache();
    global.fetch = jest.fn();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  test.each([
    ['http://localhost', false],
    ['http://127.0.0.1', false],
    ['http://10.1.2.3', false],
    ['http://172.16.2.3', false],
    ['http://192.168.2.3', false],
    ['http://169.254.1.2', false],
    ['http://0.0.0.0', false],
    ['http://[::1]', false],
    ['http://2130706433', false],
    ['http://0x7f000001', false],
    ['http://0177.0.0.1', false],
    ['http://[::ffff:7f00:1]', false],
    ['http://service.internal', false],
    ['http://service.local', false],
    ['not a url', false],
    ['https://example.com', true],
  ])('classifies SSRF candidate %s', (url, safe) => {
    expect(isUrlSafeForSSRF(url).safe).toBe(safe);
  });

  test('validates URL and prompt inputs and blocks internal targets', async () => {
    await expect(webFetchTool.execute({}, context)).resolves.toEqual(
      expect.objectContaining({ success: false, error: expect.stringContaining('url parameter') })
    );
    await expect(webFetchTool.execute({ url: 'https://example.com' }, context)).resolves.toEqual(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining('prompt parameter'),
      })
    );
    expect(
      (await webFetchTool.execute({ url: 'file:///tmp/x', prompt: 'read' }, context)).error
    ).toContain('http or https');
    expect(
      (await webFetchTool.execute({ url: 'bad url', prompt: 'read' }, context)).error
    ).toContain('Invalid URL');
    expect(
      (await webFetchTool.execute({ url: 'http://127.0.0.1/private', prompt: 'read' }, context))
        .error
    ).toContain('Security policy');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('handles large, redirected HTTP-error, and network responses', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      response({ headers: new Headers({ 'content-length': '11000000' }) })
    );
    const large = await webFetchTool.execute(
      { url: 'https://large.example/x', prompt: 'read' },
      context
    );
    expect(large.error).toContain('maximum allowed size');

    (global.fetch as jest.Mock).mockResolvedValueOnce(
      response({
        ok: false,
        status: 503,
        statusText: 'Unavailable',
        redirected: true,
        url: 'https://example.net/final',
        headers: new Headers(),
      })
    );
    const unavailable = await webFetchTool.execute(
      { url: 'https://example.net/start', prompt: 'read' },
      context
    );
    expect(JSON.parse(unavailable.error || '{}')).toEqual(
      expect.objectContaining({
        type: 'HTTP_ERROR',
        code: 503,
        redirects: ['https://example.net/final'],
      })
    );

    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('socket closed'));
    const network = await webFetchTool.execute(
      { url: 'https://network.example/x', prompt: 'read' },
      context
    );
    expect(JSON.parse(network.error || '{}')).toEqual(
      expect.objectContaining({ type: 'NETWORK_ERROR', code: 0 })
    );
  });

  test('converts rich HTML, extracts a title, records redirects, and reuses the cache', async () => {
    const html = [
      '<script>drop()</script><style>.x{}</style><nav>nav</nav><header>head</header><footer>foot</footer>',
      '<h1>Orion</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6>',
      '<p><strong>bold</strong> <b>b</b> <em>em</em> <i>i</i></p>',
      '<a href="https://example.com">link</a><pre><code>let x = 1</code></pre><code>x</code>',
      '<ul><li>one</li></ul><ol><li>two</li></ol><div>block<br/>line</div><span>end</span>',
    ].join('');
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      response({
        redirected: true,
        url: 'https://example.com/final',
        headers: new Headers({ 'content-type': 'text/html' }),
        bodyText: html,
      })
    );

    const first = await webFetchTool.execute(
      { url: 'https://example.com/start', prompt: 'extract title and name' },
      context
    );
    expect(first.success).toBe(true);
    expect((global.fetch as jest.Mock).mock.calls[0][1].headers['User-Agent']).toBe(
      ORION_USER_AGENT
    );
    expect(first.output).toContain('Title: Orion');
    expect(first.output).toContain('**bold**');
    expect(first.output).toContain('Final URL (after redirects)');

    const cached = await webFetchTool.execute(
      { url: 'https://example.com/start', prompt: 'title' },
      context
    );
    expect(cached.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('summarizes long content, truncates oversized output, and covers default prompt rendering', async () => {
    const paragraph = 'a'.repeat(70);
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(
        response({ bodyText: `${paragraph}\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}` })
      )
      .mockResolvedValueOnce(response({ bodyText: 'x'.repeat(100_100) }))
      .mockResolvedValueOnce(response({ bodyText: 'short' }));

    const summary = await webFetchTool.execute(
      { url: 'https://summary.example/a', prompt: 'summarize this' },
      context
    );
    expect(summary.output).toContain('Summary:');
    expect(summary.output).toContain('Full content:');

    const truncated = await webFetchTool.execute(
      { url: 'https://truncate.example/a', prompt: 'read it' },
      context
    );
    expect(truncated.output).toContain('[... content truncated]');

    const plain = await webFetchTool.execute(
      { url: 'https://plain.example/a', prompt: 'inspect' },
      context
    );
    expect(plain.output).toContain('Prompt: "inspect"');
  });

  test('covers permission, display-name, and web search validation branches', async () => {
    expect(
      webFetchTool.checkPermissions?.({ url: 'https://github.com/openai' }, context).behavior
    ).toBe('allow');
    expect(
      webFetchTool.checkPermissions?.({ url: 'https://docs.github.com/openai' }, context).behavior
    ).toBe('allow');
    expect(webFetchTool.checkPermissions?.({ url: 'https://example.com' }, context).behavior).toBe(
      'ask'
    );
    expect(webFetchTool.checkPermissions?.({ url: 'bad' }, context).behavior).toBe('ask');
    expect(webFetchTool.userFacingName?.({ url: 'https://example.com/x' })).toBe(
      'Fetch example.com'
    );
    expect(webFetchTool.userFacingName?.({ url: 'bad' })).toBe('Fetch bad');

    expect((await webSearchTool.execute({}, context)).error).toContain('query parameter');
    expect((await webSearchTool.execute({ query: 'x' }, context)).error).toContain('at least 2');
    expect(webSearchTool.checkPermissions?.({}, context).behavior).toBe('ask');
    expect(webSearchTool.userFacingName?.({})).toBe('Search "undefined"');
    expect(webSearchTool.userFacingName?.({ query: 'x'.repeat(40) })).toBe(
      `Search "${'x'.repeat(30)}"`
    );
  });
});

type FakeMcpClient = {
  isConnected: jest.Mock;
  getTools: jest.Mock;
  callTool: jest.Mock;
  disconnect: jest.Mock;
};

function fakeMcpClient(tools: unknown[], connected = true): FakeMcpClient {
  return {
    isConnected: jest.fn().mockReturnValue(connected),
    getTools: jest.fn().mockReturnValue(tools),
    callTool: jest.fn(),
    disconnect: jest.fn(),
  };
}

function managerInternals() {
  return mcpManager as unknown as {
    clients: Map<string, FakeMcpClient>;
    configured: Map<string, unknown>;
    dead: Set<string>;
  };
}

describe('MCP manager and wrapper tools', () => {
  const originalConfigDir = process.env.ORION_CODE_CONFIG_DIR;
  let configDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    mcpManager.disconnectAll();
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-mcp-branches-'));
    process.env.ORION_CODE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    mcpManager.disconnectAll();
    fs.rmSync(configDir, { recursive: true, force: true });
    if (originalConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
    else process.env.ORION_CODE_CONFIG_DIR = originalConfigDir;
  });

  test('sanitizes names and loads absent, invalid, and legacy config shapes', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(buildMcpToolName('  ', '@@@')).toBe('mcp__server__tool');
    expect(buildMcpToolName('a b___c', 'tool.name')).toBe('mcp__a_b_c__tool_name');
    expect(getMcpConfigPath()).toBe(path.join(configDir, 'mcp.json'));
    expect(mcpManager.loadConfig()).toBeNull();

    fs.writeFileSync(getMcpConfigPath(), '{bad json', 'utf8');
    expect(mcpManager.loadConfig()).toBeNull();
    fs.writeFileSync(getMcpConfigPath(), JSON.stringify({ mcpServers: [] }), 'utf8');
    expect(mcpManager.loadConfig()).toBeNull();
    fs.writeFileSync(
      getMcpConfigPath(),
      JSON.stringify({ servers: { legacy: { command: 'node' } } }),
      'utf8'
    );
    expect(mcpManager.loadConfig()).toEqual({ mcpServers: { legacy: { command: 'node' } } });
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  test('lists no tools, unknown filters, descriptions, and parameters', async () => {
    expect((await mcpListTool.execute({}, context)).output).toContain('No MCP servers connected');

    const client = fakeMcpClient([
      {
        name: 'echo',
        description: 'Echo input',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      },
      { name: 'empty' },
    ]);
    managerInternals().clients.set('sample', client);

    expect((await mcpListTool.execute({ server: 'missing' }, context)).output).toContain(
      'No tools found for server'
    );
    const listed = await mcpListTool.execute({}, context);
    expect(listed.output).toContain('[sample] echo');
    expect(listed.output).toContain('Parameters: text');
    expect(listed.output).toContain('External MCP tool');
    expect(mcpListTool.isReadOnly?.({})).toBe(true);
    expect(mcpListTool.userFacingName?.({})).toBe('List MCP tools');
  });

  test('normalizes dynamic tools, resolves duplicate names, and executes wrapper outcomes', async () => {
    const first = fakeMcpClient([
      {
        name: 'bad tool',
        inputSchema: { type: 'wrong', properties: { ignored: true } },
      },
    ]);
    const second = fakeMcpClient([
      {
        name: 'bad tool',
        description: 'Rich tool',
        inputSchema: {
          type: 'object',
          properties: {
            invalid: null,
            enumOnly: { enum: ['a', 'b'] },
            union: { oneOf: [{ type: 'string' }], description: 3 },
          },
          required: ['enumOnly', 7],
        },
        annotations: { readOnlyHint: true, destructiveHint: true },
      },
    ]);
    first.callTool.mockResolvedValue({ success: true, output: 'first' });
    second.callTool.mockResolvedValue({ success: true, output: 'second' });
    managerInternals().clients.set('a b', first);
    managerInternals().clients.set('a@b', second);

    const tools = mcpManager.getOrionCodeTools();
    expect(tools.map(tool => tool.name)).toEqual(['mcp__a_b__bad_tool', 'mcp__a_b__bad_tool_2']);
    expect(tools[0].description).toContain('External MCP tool');
    expect(tools[0].parameters).toEqual({ type: 'object', properties: {}, required: [] });
    expect(tools[1].parameters.required).toEqual(['enumOnly']);
    expect(tools[1].parameters.properties.invalid).toEqual({
      type: 'string',
      description: 'invalid',
    });
    expect(tools[1].parameters.properties.enumOnly).toEqual(
      expect.objectContaining({ type: 'string', description: 'enumOnly' })
    );
    expect(tools[1].parameters.properties.union).toEqual(
      expect.objectContaining({ oneOf: expect.any(Array), description: 'union' })
    );
    expect(tools[1].isReadOnly?.({})).toBe(true);
    expect(tools[1].isDestructive?.({})).toBe(true);
    expect(tools[0].isReadOnly?.({})).toBe(false);
    expect(tools[0].isDestructive?.({})).toBe(false);
    expect(tools[1].checkPermissions?.({}, context).behavior).toBe('ask');
    expect(tools[1].userFacingName?.({})).toBe('MCP a@b/bad tool');
    expect(await tools[1].execute({ value: 1 }, context)).toEqual({
      success: true,
      output: 'second',
    });
    expect(tools[1].getSummary?.({}, { success: true, output: 'ok' })).toBe('MCP a@b/bad tool');
    expect(tools[1].getSummary?.({}, { success: false, output: '', error: 'bad' })).toBe('bad');
    expect(tools[1].getSummary?.({}, { success: false, output: '' })).toContain('failed');

    second.isConnected.mockReturnValue(false);
    const disconnected = await tools[1].execute({}, context);
    expect(disconnected.error).toContain('not connected');
  });

  test('reports status across configured, connected, disconnected, and dead servers', () => {
    const live = fakeMcpClient([{ name: 'one' }]);
    const down = fakeMcpClient([{ name: 'two' }], false);
    const internals = managerInternals();
    internals.clients.set('live', live);
    internals.clients.set('down', down);
    internals.configured.set('configured', {});
    internals.dead.add('dead');

    expect(mcpManager.getConnectedServers()).toEqual(['live']);
    expect(mcpManager.getAllTools()).toEqual([{ server: 'live', tool: { name: 'one' } }]);
    expect(mcpManager.getStatus()).toEqual(
      expect.arrayContaining([
        { name: 'live', connected: true, toolCount: 1, dead: false },
        { name: 'down', connected: false, toolCount: 1, dead: false },
        { name: 'configured', connected: false, toolCount: 0, dead: false },
        { name: 'dead', connected: false, toolCount: 0, dead: true },
      ])
    );
    mcpManager.disconnectAll();
    expect(live.disconnect).toHaveBeenCalled();
    expect(down.disconnect).toHaveBeenCalled();
  });

  test('mcp_call validates arguments, availability, connectivity, success, and thrown failures', async () => {
    expect((await mcpCallTool.execute({}, context)).error).toContain('server parameter');
    expect((await mcpCallTool.execute({ server: 'sample' }, context)).error).toContain(
      'tool parameter'
    );
    expect(
      (await mcpCallTool.execute({ server: 'missing', tool: 'echo' }, context)).error
    ).toContain('Available servers: none');

    const live = fakeMcpClient([]);
    live.callTool
      .mockResolvedValueOnce({ success: true, output: 'ok' })
      .mockRejectedValueOnce(new Error('boom'));
    const down = fakeMcpClient([], false);
    managerInternals().clients.set('live', live);
    managerInternals().clients.set('down', down);

    expect(
      (await mcpCallTool.execute({ server: 'missing', tool: 'echo' }, context)).error
    ).toContain('Available servers: live');
    expect((await mcpCallTool.execute({ server: 'down', tool: 'echo' }, context)).error).toContain(
      'is not connected'
    );
    expect(await mcpCallTool.execute({ server: 'live', tool: 'echo' }, context)).toEqual({
      success: true,
      output: 'ok',
    });
    expect(live.callTool).toHaveBeenLastCalledWith('echo', {});
    expect(
      (await mcpCallTool.execute({ server: 'live', tool: 'echo', args: { x: 1 } }, context)).error
    ).toContain('boom');
    expect(mcpCallTool.checkPermissions?.({}, context).behavior).toBe('ask');
    expect(mcpCallTool.userFacingName?.({ server: 'live', tool: 'echo' })).toBe('Call live/echo');
  });
});

type LspResponse = unknown | Error;

class FakeLspProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = jest.fn();
  stdin = {
    write: jest.fn((wire: string) => {
      const body = wire.slice(wire.indexOf('\r\n\r\n') + 4);
      const request = JSON.parse(body) as { id?: number; method: string };
      if (request.id === undefined) return true;
      const queue = lspReplies.get(request.method) || [];
      const result = queue.length > 0 ? queue.shift() : {};
      const payload =
        result instanceof Error
          ? { jsonrpc: '2.0', id: request.id, error: { message: result.message } }
          : { jsonrpc: '2.0', id: request.id, result };
      const json = JSON.stringify(payload);
      queueMicrotask(() =>
        this.stdout.emit(
          'data',
          Buffer.from(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`)
        )
      );
      return true;
    }),
  };
}

const lspReplies = new Map<string, LspResponse[]>();
const lspProcesses: FakeLspProcess[] = [];

function queueLsp(method: string, ...values: LspResponse[]): void {
  lspReplies.set(method, values);
}

function location(uri = 'file:///project/target.ts', line = 2, character = 4) {
  return {
    uri,
    range: {
      start: { line, character },
      end: { line, character: character + 1 },
    },
  };
}

describe('LSP protocol success and formatting branches', () => {
  beforeAll(() => {
    (spawnSync as unknown as jest.Mock).mockReturnValue({ status: 0 });
    (spawn as unknown as jest.Mock).mockImplementation(() => {
      const process = new FakeLspProcess();
      lspProcesses.push(process);
      return process;
    });
  });

  beforeEach(() => {
    lspReplies.clear();
    queueLsp('initialize', {});
  });

  test('formats single, multiple, empty, and missing definitions', async () => {
    queueLsp(
      'textDocument/definition',
      location(),
      [location('file:///a.ts', 0, 0), location('file:///b.ts', 1, 1)],
      [],
      null
    );
    const args = { file_path: '/project/source.ts', line: 1, character: 1 };
    const one = await lspGetDefinitionTool.execute(args, { ...context, cwd: '/lsp-def-one' });
    const many = await lspGetDefinitionTool.execute(args, { ...context, cwd: '/lsp-def-many' });
    const empty = await lspGetDefinitionTool.execute(args, { ...context, cwd: '/lsp-def-empty' });
    const none = await lspGetDefinitionTool.execute(args, { ...context, cwd: '/lsp-def-none' });
    expect(one.output).toBe('/project/target.ts:3:5');
    expect(many.output).toBe('/a.ts:1:1\n/b.ts:2:2');
    expect(empty.output).toBe('No definition found');
    expect(none.output).toBe('No definition found');
  });

  test('formats references and honors include_declaration=false', async () => {
    queueLsp('textDocument/references', [location('file:///ref.js', 4, 5)], null);
    const args = {
      file_path: '/project/source.jsx',
      line: 2,
      character: 3,
      include_declaration: false,
    };
    const found = await lspGetReferencesTool.execute(args, { ...context, cwd: '/lsp-ref-found' });
    const none = await lspGetReferencesTool.execute(args, { ...context, cwd: '/lsp-ref-none' });
    expect(found.output).toBe('/ref.js:5:6');
    expect(none.output).toBe('No definition found');
  });

  test('formats string, array, object, and missing hover content', async () => {
    queueLsp(
      'textDocument/hover',
      { contents: 'string hover' },
      {
        contents: [
          { kind: 'markdown', value: 'first' },
          { kind: 'plaintext', value: 'second' },
        ],
      },
      { contents: { kind: 'markdown', value: 'object hover' } },
      null
    );
    const args = { file_path: '/project/source.js', line: 2, character: 3 };
    const outputs = [];
    for (const suffix of ['string', 'array', 'object', 'none']) {
      outputs.push(
        (await lspGetHoverTool.execute(args, { ...context, cwd: `/lsp-hover-${suffix}` })).output
      );
    }
    expect(outputs).toEqual([
      'string hover',
      'first\nsecond',
      'object hover',
      'No hover information',
    ]);
  });

  test('formats diagnostics severity and handles empty diagnostic responses', async () => {
    queueLsp(
      'textDocument/diagnostic',
      {
        items: [1, 2, 3, 4, 9].map((severity, index) => ({
          range: {
            start: { line: index, character: index },
            end: { line: index, character: index + 1 },
          },
          severity,
          message: `message-${severity}`,
        })),
      },
      {}
    );
    const args = { file_path: '/project/source.py' };
    const found = await lspGetDiagnosticsTool.execute(args, { ...context, cwd: '/lsp-diag-found' });
    const none = await lspGetDiagnosticsTool.execute(args, { ...context, cwd: '/lsp-diag-none' });
    expect(found.output).toContain('[Error]');
    expect(found.output).toContain('[Warning]');
    expect(found.output).toContain('[Information]');
    expect(found.output).toContain('[Hint]');
    expect(found.output).toContain('[Unknown]');
    expect(none.output).toBe('No diagnostics found');
  });

  test('validates file and position types and reports protocol errors', async () => {
    const invalid = [
      await lspGetDefinitionTool.execute({ file_path: '', line: 1, character: 1 }, context),
      await lspGetDefinitionTool.execute({ file_path: '/x.ts', line: 0, character: 1 }, context),
      await lspGetDefinitionTool.execute(
        { file_path: '/x.ts', line: Number.NaN, character: 1 },
        context
      ),
      await lspGetDefinitionTool.execute(
        { file_path: '/x.ts', line: 1, character: Infinity },
        context
      ),
      await lspGetDiagnosticsTool.execute({}, context),
    ];
    expect(invalid.map(result => result.success)).toEqual([false, false, false, false, false]);

    queueLsp('textDocument/definition', new Error('server rejected request'));
    const failed = await lspGetDefinitionTool.execute(
      { file_path: '/project/unknown.ext', line: 1, character: 1 },
      { ...context, cwd: '/lsp-error-response' }
    );
    expect(failed.success).toBe(false);
    expect(failed.error).toContain('server rejected request');

    const latest = lspProcesses[lspProcesses.length - 1];
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    latest.stderr.emit('data', Buffer.from('diagnostic noise'));
    latest.emit('error', Object.assign(new Error('gone'), { code: 'ENOENT' }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to start'));
    warn.mockRestore();
  });
});
