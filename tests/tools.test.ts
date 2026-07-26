import { TOOLS, executeTool, getToolNames } from '../src/tools';
import type { ToolContext } from '../src/framework/tool';
import { getMemoryDir, loadMemory } from '../src/memory/storage';
import fs from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const ctx: ToolContext = {
  cwd: process.cwd(),
  config: { name: 'test', mode: 'development' },
};

const testDir = path.join(process.cwd(), 'tests', 'tmp');

function setupTestDir() {
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }
}

function cleanupTestDir() {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

describe('TOOLS array', () => {
  test('contains expected number of tools', () => {
    // Core tools: 11, Web tools: 2, MCP tools: 2, Todo tools: 1, Plan tools: 2 = 18
    expect(TOOLS.length).toBeGreaterThanOrEqual(18);
  });

  test('includes expected tool names', () => {
    const names = TOOLS.map(t => t.name);
    // Core tools
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('list_files');
    expect(names).toContain('exec_command');
    expect(names).toContain('edit_file');
    expect(names).toContain('glob');
    expect(names).toContain('grep');
    expect(names).toContain('batch_read');
    expect(names).toContain('memory_save');
    expect(names).toContain('memory_recall');
    expect(names).toContain('memory_forget');
    expect(names).toContain('history_search');
    // New v0.1.4 tools
    expect(names).toContain('web_fetch');
    expect(names).toContain('web_search');
    expect(names).toContain('mcp_list');
    expect(names).toContain('mcp_call');
    expect(names).toContain('todo_write');
    expect(names).toContain('enter_plan_mode');
    expect(names).toContain('exit_plan_mode');
  });
});

describe('memory tools project cwd', () => {
  const memoryProject = path.join(tmpdir(), `openhorse-memory-tools-${Date.now()}`);
  const memoryCtx: ToolContext = {
    cwd: memoryProject,
    config: { name: 'test', mode: 'development' },
  };

  beforeEach(() => {
    if (fs.existsSync(memoryProject)) {
      fs.rmSync(memoryProject, { recursive: true, force: true });
    }
    fs.mkdirSync(memoryProject, { recursive: true });
    const memoryDir = getMemoryDir(memoryProject);
    if (fs.existsSync(memoryDir)) {
      fs.rmSync(memoryDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    const memoryDir = getMemoryDir(memoryProject);
    if (fs.existsSync(memoryProject)) {
      fs.rmSync(memoryProject, { recursive: true, force: true });
    }
    if (fs.existsSync(memoryDir)) {
      fs.rmSync(memoryDir, { recursive: true, force: true });
    }
  });

  test('memory_save writes to ToolContext.cwd project memory', async () => {
    const name = `ctx-memory-${Date.now()}`;
    const result = await executeTool('memory_save', {
      name,
      type: 'project',
      description: 'Context memory',
      content: 'Stored via tool context cwd',
    }, undefined, memoryCtx);

    expect(JSON.parse(result).success).toBe(true);
    expect(fs.existsSync(path.join(getMemoryDir(memoryProject), `${name}.md`))).toBe(true);
    expect(loadMemory(name, memoryProject)?.content).toBe('Stored via tool context cwd');
    expect(loadMemory(name, process.cwd())).toBeNull();
  });

  test('memory_recall and memory_forget use ToolContext.cwd', async () => {
    await executeTool('memory_save', {
      name: 'ctx-forget',
      type: 'feedback',
      content: 'Forget me from context project',
    }, undefined, memoryCtx);

    const recalled = JSON.parse(await executeTool('memory_recall', {
      query: 'Forget me',
    }, undefined, memoryCtx));
    expect(recalled.output).toContain('ctx-forget');

    const forgotten = JSON.parse(await executeTool('memory_forget', {
      name: 'ctx-forget',
    }, undefined, memoryCtx));
    expect(forgotten.success).toBe(true);
    expect(loadMemory('ctx-forget', memoryProject)).toBeNull();
  });
});

describe('read_file tool', () => {
  const tool = TOOLS.find(t => t.name === 'read_file')!;

  test('isReadOnly returns true', () => {
    expect(tool.isReadOnly?.({})).toBe(true);
  });

  test('isConcurrencySafe returns true', () => {
    expect(tool.isConcurrencySafe?.({})).toBe(true);
  });

  test('reads existing file successfully', async () => {
    const result = await tool.execute({ path: 'package.json' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('orion-code');
  });

  test('reads markdown link paths outside the project', async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'orion-code-tool-path-'));
    const file = path.join(dir, 'SKILL.md');
    fs.writeFileSync(file, 'skill body', 'utf-8');

    try {
      const result = await tool.execute({ path: `[$imagegen](${file})` }, ctx);

      expect(result.success).toBe(true);
      expect(result.output).toBe('skill body');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reads file URL paths with encoded characters', async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'orion-code-tool-url-'));
    const file = path.join(dir, 'space file.md');
    fs.writeFileSync(file, 'url body', 'utf-8');

    try {
      const result = await tool.execute({ path: `file://${encodeURI(file)}` }, ctx);

      expect(result.success).toBe(true);
      expect(result.output).toBe('url body');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns error for nonexistent file', async () => {
    const result = await tool.execute({ path: 'tests/nonexistent-file-xyz.txt' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('File not found');
  });

  test('returns error for directory path', async () => {
    const result = await tool.execute({ path: 'src' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not a file');
  });

  test('respects maxLines parameter', async () => {
    const result = await tool.execute({ path: 'package.json', maxLines: 2 }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('truncated');
  });

  test('userFacingName returns path', () => {
    const name = tool.userFacingName?.({ path: '/my/file.txt' });
    expect(name).toBe('Read /my/file.txt');
  });
});

describe('write_file tool', () => {
  const tool = TOOLS.find(t => t.name === 'write_file')!;

  beforeAll(() => {
    setupTestDir();
  });

  afterAll(() => {
    cleanupTestDir();
  });

  test('isDestructive returns true', () => {
    expect(tool.isDestructive?.({})).toBe(true);
  });

  test('writes and reads back file', async () => {
    const testFile = path.join(testDir, 'test-write.txt');
    const result = await tool.execute({ path: testFile, content: 'hello world' }, ctx);
    expect(result.success).toBe(true);

    const content = fs.readFileSync(testFile, 'utf-8');
    expect(content).toBe('hello world');
  });

  test('overwrites existing file', async () => {
    const testFile = path.join(testDir, 'test-overwrite.txt');
    fs.writeFileSync(testFile, 'original', 'utf-8');

    const result = await tool.execute({ path: testFile, content: 'new content' }, ctx);
    expect(result.success).toBe(true);

    const content = fs.readFileSync(testFile, 'utf-8');
    expect(content).toBe('new content');
  });

  test('allows writing an empty file', async () => {
    const testFile = path.join(testDir, 'test-empty.txt');

    const result = await tool.execute({ path: testFile, content: '' }, ctx);

    expect(result.success).toBe(true);
    expect(fs.readFileSync(testFile, 'utf-8')).toBe('');
  });
});

describe('list_files tool', () => {
  const tool = TOOLS.find(t => t.name === 'list_files')!;

  test('isReadOnly returns true', () => {
    expect(tool.isReadOnly?.({})).toBe(true);
  });

  test('isConcurrencySafe returns true', () => {
    expect(tool.isConcurrencySafe?.({})).toBe(true);
  });

  test('lists files in src directory', async () => {
    const result = await tool.execute({ path: 'src', maxDepth: 1 }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('cli.ts');
  });

  test('lists markdown link paths outside the project', async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'orion-code-tool-list-'));
    fs.writeFileSync(path.join(dir, 'item.txt'), 'listed', 'utf-8');

    try {
      const result = await tool.execute({ path: `[fixture](${dir})`, maxDepth: 1 }, ctx);

      expect(result.success).toBe(true);
      expect(result.output).toContain('item.txt');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns error for nonexistent path', async () => {
    const result = await tool.execute({ path: 'tests/nonexistent-path-xyz' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('userFacingName returns path', () => {
    const name = tool.userFacingName?.({ path: 'src' });
    expect(name).toBe('List src');
  });
});

describe('exec_command tool', () => {
  const tool = TOOLS.find(t => t.name === 'exec_command')!;

  test('isConcurrencySafe only for read-only commands', () => {
    expect(tool.isConcurrencySafe?.({ command: 'git status --short' })).toBe(true);
    expect(tool.isConcurrencySafe?.({ command: 'npm test' })).toBe(true);
  });

  test('executes simple command', async () => {
    const result = await tool.execute({ command: 'echo hello' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('hello');
  });

  test('handles failing command', async () => {
    const result = await tool.execute({ command: 'exit 1' }, ctx);
    expect(result.success).toBe(false);
  });

  test('isDestructive detects rm -rf', () => {
    expect(tool.isDestructive?.({ command: 'rm -rf /' })).toBe(true);
    expect(tool.isDestructive?.({ command: 'ls -la' })).toBe(false);
  });

  test('checkPermissions allows bounded validation command', () => {
    const perm = tool.checkPermissions?.({ command: 'npx tsc --noEmit' }, ctx);
    expect(perm?.behavior).toBe('allow');
  });

  test('checkPermissions still asks for arbitrary commands', () => {
    // 'npm run start' is now in the read-only whitelist (v0.2.25 bash_security update)
    // Use a command that is not in the whitelist instead.
    const perm = tool.checkPermissions?.({ command: 'make install' }, ctx);
    expect(perm?.behavior).toBe('ask');
  });

  test('userFacingName returns truncated command', () => {
    const name = tool.userFacingName?.({ command: 'echo hello world' });
    expect(name).toBe('Exec echo hello world');
  });

  // Issue #28: Output truncation tests
  test('truncates large output with maxOutput parameter', async () => {
    // Generate 100KB of output
    const result = await tool.execute({
      command: 'yes "test line" | head -2000',
      maxOutput: 1024, // 1KB limit
    }, ctx);
    expect(result.success).toBe(true);
    expect(result.output.length).toBeLessThan(1100); // Allow some overhead for truncation message
    expect(result.output).toContain('[... output truncated');
  });

  test('default maxOutput is 50KB', async () => {
    // Generate 60KB of output, should be truncated
    const result = await tool.execute({
      command: 'yes "test line for truncation test" | head -1500',
    }, ctx);
    expect(result.success).toBe(true);
    // Default is 51200 bytes, output should be truncated
    expect(result.output.length).toBeLessThan(52000);
  });

  test('does not truncate small output', async () => {
    const result = await tool.execute({
      command: 'echo "small output"',
      maxOutput: 1024,
    }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('small output');
    expect(result.output).not.toContain('[... output truncated');
  });

  test('resolves relative cwd from ToolContext.cwd', async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'orion-code-tool-exec-'));
    fs.mkdirSync(path.join(dir, 'child'));

    try {
      const result = await tool.execute({ command: 'pwd', cwd: 'child' }, {
        ...ctx,
        cwd: dir,
      });

      expect(result.success).toBe(true);
      expect(fs.realpathSync(result.output.trim())).toBe(fs.realpathSync(path.join(dir, 'child')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('executeTool', () => {
  test('executes read_file tool', async () => {
    const result = await executeTool('read_file', { path: 'package.json' });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.output).toContain('orion-code');
    expect(parsed.summary).toContain('read package.json');
    expect(parsed.outputBytes).toBeGreaterThan(0);
  });

  test('exec_command failure summary includes error and output preview', async () => {
    const result = await executeTool('exec_command', {
      command: 'printf "found-uv\\n"; exit 1',
    }, undefined, ctx);
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('Command exited with code 1');
    expect(parsed.output).toContain('found-uv');
    expect(parsed.summary).toContain('Command exited with code 1');
    expect(parsed.summary).toContain('output: found-uv');
  });

  test('exec_command summary preserves useful tail of long commands', async () => {
    const result = await executeTool('exec_command', {
      command: `printf ok # ${'x'.repeat(140)} tail-marker`,
    }, undefined, ctx);
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.summary).toContain('tail-marker');
    expect(parsed.summary).toContain('2B output');
  });

  test('exec_command summary bounds the model-facing command text', async () => {
    const longCommand = `printf ok # head-marker ${'x'.repeat(600)} tail-marker`;
    const result = await executeTool('exec_command', {
      command: longCommand,
    }, undefined, ctx);
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.summary).toContain('head-marker');
    expect(parsed.summary).toContain('tail-marker');
    expect(parsed.summary).toContain('...');
    expect(parsed.summary).not.toContain('x'.repeat(300));
    expect(parsed.summary.length).toBeLessThan(220);
  });

  test('returns error for unknown tool', async () => {
    const result = await executeTool('unknown_tool', {});
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Unknown tool');
  });
});

describe('getToolNames', () => {
  test('returns comma-separated names', () => {
    const names = getToolNames();
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('list_files');
    expect(names).toContain('exec_command');
    expect(names).toContain('edit_file');
    expect(names).toContain('glob');
    expect(names).toContain('grep');
    expect(names).toContain('batch_read');
  });
});

describe('batch_read tool', () => {
  const tool = TOOLS.find(t => t.name === 'batch_read')!;

  async function runBatchRead(steps: Array<{ tool: string; args: Record<string, unknown> }>) {
    const outer = JSON.parse(await executeTool('batch_read', { steps }, undefined, ctx));
    return {
      outer,
      inner: JSON.parse(outer.output),
    };
  }

  test('isReadOnly and concurrency safe', () => {
    expect(tool.isReadOnly?.({})).toBe(true);
    expect(tool.isConcurrencySafe?.({})).toBe(true);
  });

  test('executes allowed read-only tools in order', async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'openhorse-batch-read-'));
    fs.writeFileSync(path.join(dir, 'note.txt'), 'needle in batch', 'utf-8');

    try {
      const { outer, inner } = await runBatchRead([
        { tool: 'list_files', args: { path: dir, maxDepth: 1 } },
        { tool: 'read_file', args: { path: path.join(dir, 'note.txt') } },
        { tool: 'grep', args: { pattern: 'needle', path: dir } },
      ]);

      expect(outer.success).toBe(true);
      expect(inner.success).toBe(true);
      expect(inner.steps.map((step: any) => step.tool)).toEqual(['list_files', 'read_file', 'grep']);
      expect(inner.steps[0].output).toContain('note.txt');
      expect(inner.steps[1].output).toContain('needle in batch');
      expect(inner.steps[2].output).toContain('note.txt:1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects disallowed write tools before execution', async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'openhorse-batch-read-deny-'));
    const target = path.join(dir, 'blocked.txt');

    try {
      const { outer, inner } = await runBatchRead([
        { tool: 'write_file', args: { path: target, content: 'nope' } },
      ]);

      expect(outer.success).toBe(false);
      expect(inner.success).toBe(false);
      expect(inner.error).toContain('not allowed');
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects more than eight steps', async () => {
    const steps = Array.from({ length: 9 }, () => ({ tool: 'list_files', args: { path: 'src', maxDepth: 0 } }));
    const { outer, inner } = await runBatchRead(steps);

    expect(outer.success).toBe(false);
    expect(inner.error).toContain('at most 8 steps');
    expect(inner.steps).toEqual([]);
  });

  test('truncates large per-step output', async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'openhorse-batch-read-big-'));
    const file = path.join(dir, 'big.txt');
    fs.writeFileSync(file, 'a'.repeat(5000), 'utf-8');

    try {
      const { inner } = await runBatchRead([
        { tool: 'read_file', args: { path: file } },
      ]);

      expect(inner.success).toBe(true);
      expect(inner.steps[0].output.length).toBeLessThan(2500);
      expect(inner.steps[0].output).toContain('bytes truncated');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('edit_file tool', () => {
  const tool = TOOLS.find(t => t.name === 'edit_file')!;

  beforeAll(() => {
    setupTestDir();
  });

  afterAll(() => {
    cleanupTestDir();
  });

  test('isDestructive returns true', () => {
    expect(tool.isDestructive?.({})).toBe(true);
  });

  test('checkPermissions returns ask', () => {
    const perm = tool.checkPermissions?.({ path: 'test.txt' }, ctx);
    expect(perm?.behavior).toBe('ask');
  });

  test('replaces unique string in file', async () => {
    const testFile = path.join(testDir, 'test-edit.txt');
    fs.writeFileSync(testFile, 'hello world', 'utf-8');

    const result = await tool.execute({ path: testFile, old_string: 'hello', new_string: 'hi' }, ctx);
    expect(result.success).toBe(true);

    const content = fs.readFileSync(testFile, 'utf-8');
    expect(content).toBe('hi world');
  });

  test('rejects when old_string not found', async () => {
    const testFile = path.join(testDir, 'test-edit-notfound.txt');
    fs.writeFileSync(testFile, 'hello world', 'utf-8');

    const result = await tool.execute({ path: testFile, old_string: 'notfound', new_string: 'hi' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('does not fuzzy edit unless explicitly requested', async () => {
    const testFile = path.join(testDir, 'test-edit-fuzzy-default.txt');
    fs.writeFileSync(testFile, 'function target() {\n  return true;\n}\n', 'utf-8');

    const result = await tool.execute({
      path: testFile,
      old_string: 'function target() { return true; }',
      new_string: 'function target() {\n  return false;\n}',
    }, ctx);

    expect(result.success).toBe(false);
    expect(fs.readFileSync(testFile, 'utf-8')).toContain('return true;');
  });

  test('supports explicit fuzzy edit without consuming leading blank lines', async () => {
    const testFile = path.join(testDir, 'test-edit-fuzzy-opt-in.txt');
    fs.writeFileSync(testFile, 'prefix\n\nfunction target() {\n  return true;\n}\n', 'utf-8');

    const result = await tool.execute({
      path: testFile,
      old_string: 'function target() { return true; }',
      new_string: 'function target() {\n  return false;\n}',
      fuzzy_match: true,
    }, ctx);

    expect(result.success).toBe(true);
    expect(fs.readFileSync(testFile, 'utf-8')).toBe('prefix\n\nfunction target() {\n  return false;\n}\n');
  });

  test('rejects ambiguous fuzzy matches', async () => {
    const testFile = path.join(testDir, 'test-edit-fuzzy-ambiguous.txt');
    fs.writeFileSync(testFile, [
      'function foo() {',
      '  return 1;',
      '}',
      'function foo() {',
      '  return 2;',
      '}',
      '',
    ].join('\n'), 'utf-8');

    const result = await tool.execute({
      path: testFile,
      old_string: 'function foo() { return',
      new_string: 'function bar() { return',
      fuzzy_match: true,
      replace_all: true,
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Fuzzy match found');
  });

  test('previews ambiguous fuzzy matches without writing', async () => {
    const testFile = path.join(testDir, 'test-edit-fuzzy-preview.txt');
    const original = [
      'function foo() {',
      '  return 1;',
      '}',
      'function foo() {',
      '  return 2;',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(testFile, original, 'utf-8');

    const result = await tool.execute({
      path: testFile,
      old_string: 'function foo() { return',
      new_string: 'function bar() { return',
      fuzzy_match: true,
      replace_all: true,
      preview: true,
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.output).toContain('Fuzzy');
    expect(result.output).toContain('candidates (2)');
    expect(fs.readFileSync(testFile, 'utf-8')).toBe(original);
  });

  test('rejects multiple matches without replace_all', async () => {
    const testFile = path.join(testDir, 'test-edit-multi.txt');
    fs.writeFileSync(testFile, 'hello hello hello', 'utf-8');

    const result = await tool.execute({ path: testFile, old_string: 'hello', new_string: 'hi' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('3 times');
  });

  test('previews exact multiple matches without writing', async () => {
    const testFile = path.join(testDir, 'test-edit-preview-multi.txt');
    fs.writeFileSync(testFile, 'hello hello hello', 'utf-8');

    const result = await tool.execute({
      path: testFile,
      old_string: 'hello',
      new_string: 'hi',
      preview: true,
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.output).toContain('Exact match candidates (3)');
    expect(fs.readFileSync(testFile, 'utf-8')).toBe('hello hello hello');
  });

  test('replaces all with replace_all=true', async () => {
    const testFile = path.join(testDir, 'test-edit-all.txt');
    fs.writeFileSync(testFile, 'hello hello hello', 'utf-8');

    const result = await tool.execute({ path: testFile, old_string: 'hello', new_string: 'hi', replace_all: true }, ctx);
    expect(result.success).toBe(true);

    const content = fs.readFileSync(testFile, 'utf-8');
    expect(content).toBe('hi hi hi');
  });

  test('allows replacing with an empty string', async () => {
    const testFile = path.join(testDir, 'test-edit-delete.txt');
    fs.writeFileSync(testFile, 'hello world', 'utf-8');

    const result = await tool.execute({ path: testFile, old_string: 'hello ', new_string: '' }, ctx);

    expect(result.success).toBe(true);
    expect(fs.readFileSync(testFile, 'utf-8')).toBe('world');
  });

  test('edits markdown link paths outside the project', async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'orion-code-tool-edit-'));
    const file = path.join(dir, 'SKILL.md');
    fs.writeFileSync(file, 'old skill body', 'utf-8');

    try {
      const result = await tool.execute({
        path: `[$imagegen](${file})`,
        old_string: 'old',
        new_string: 'new',
      }, ctx);

      expect(result.success).toBe(true);
      expect(fs.readFileSync(file, 'utf-8')).toBe('new skill body');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('glob tool', () => {
  const tool = TOOLS.find(t => t.name === 'glob')!;

  test('isReadOnly returns true', () => {
    expect(tool.isReadOnly?.({})).toBe(true);
  });

  test('isConcurrencySafe returns true', () => {
    expect(tool.isConcurrencySafe?.({})).toBe(true);
  });

  test('finds TypeScript files', async () => {
    const result = await tool.execute({ pattern: '**/*.ts', path: 'src' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('cli.ts');
  });

  test('resolves search path from ToolContext.cwd', async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'orion-code-tool-glob-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'local.ts'), 'export {}', 'utf-8');

    try {
      const result = await tool.execute({ pattern: '**/*.ts', path: 'src' }, {
        ...ctx,
        cwd: dir,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('local.ts');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns message when no matches', async () => {
    const result = await tool.execute({ pattern: '*.xyz', path: 'src' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('No files');
  });
});

describe('grep tool', () => {
  const tool = TOOLS.find(t => t.name === 'grep')!;

  beforeAll(() => {
    setupTestDir();
  });

  afterAll(() => {
    cleanupTestDir();
  });

  test('isReadOnly returns true', () => {
    expect(tool.isReadOnly?.({})).toBe(true);
  });

  test('isConcurrencySafe returns true', () => {
    expect(tool.isConcurrencySafe?.({})).toBe(true);
  });

  test('finds pattern in files', async () => {
    const result = await tool.execute({ pattern: 'orion-code', path: 'package.json' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('orion-code');
  });

  test('resolves search path from ToolContext.cwd', async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'orion-code-tool-grep-'));
    fs.mkdirSync(path.join(dir, 'docs'));
    fs.writeFileSync(path.join(dir, 'docs', 'note.txt'), 'needle from cwd', 'utf-8');

    try {
      const result = await tool.execute({ pattern: 'needle', path: 'docs' }, {
        ...ctx,
        cwd: dir,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('note.txt');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns message when no matches', async () => {
    const result = await tool.execute({ pattern: 'notfoundpattern', path: 'src' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('No matches');
  });

  test('does not skip repeated matches and respects glob filter', async () => {
    const grepDir = path.join(testDir, 'grep-fixture');
    fs.mkdirSync(grepDir, { recursive: true });
    fs.writeFileSync(path.join(grepDir, 'a.txt'), 'needle\nneedle\n', 'utf-8');
    fs.writeFileSync(path.join(grepDir, 'b.md'), 'needle\n', 'utf-8');

    const result = await tool.execute({ pattern: 'needle', path: grepDir, glob: '*.txt' }, ctx);

    expect(result.success).toBe(true);
    expect(result.output.match(/a\.txt:/g)).toHaveLength(2);
    expect(result.output).not.toContain('b.md');
  });
});

describe('todo_write tool', () => {
  const tool = TOOLS.find(t => t.name === 'todo_write')!;

  test('accepts direct array arguments as well as JSON strings', async () => {
    const result = await tool.execute({
      todos: [
        {
          content: 'Run tests',
          activeForm: 'Running tests',
          status: 'in_progress',
        },
      ],
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.output).toContain('Run tests');
  });
});
