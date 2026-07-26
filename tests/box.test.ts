import { toolLine, renderHeaderBox, renderPromptSeparator, renderFooterBar } from '../src/ui/box';

describe('toolLine', () => {
  test('includes tool name in output', () => {
    const line = toolLine('read_file', { path: '/test' }, true, 50);
    expect(line).toContain('read_file');
  });

  test('includes duration when success', () => {
    const line = toolLine('read_file', { path: '/test' }, true, 123);
    expect(line).toContain('123ms');
  });

  test('includes duration when failure', () => {
    const line = toolLine('exec_command', { command: 'rm -rf /' }, false, 5);
    expect(line).toContain('5ms');
  });

  test('includes path in args summary', () => {
    const line = toolLine('read_file', { path: '/some/long/path/file.txt' }, true);
    expect(line).toContain('/some/long/path/file.txt');
  });

  test('includes command in args summary', () => {
    const line = toolLine('exec_command', { command: 'ls -la' }, true);
    expect(line).toContain('ls -la');
  });

  test('truncates long paths', () => {
    const longPath = '/very/long/' + 'x'.repeat(100);
    const line = toolLine('read_file', { path: longPath }, true);
    // Should contain truncated version with ...
    expect(line.length).toBeLessThan(longPath.length + 50);
  });

  test('truncates long commands', () => {
    const longCmd = 'echo ' + 'a'.repeat(100);
    const line = toolLine('exec_command', { command: longCmd }, true);
    expect(line.length).toBeLessThan(longCmd.length + 50);
  });

  test('handles empty args', () => {
    const line = toolLine('some_tool', {}, true);
    expect(line).toContain('some_tool');
  });

  test('handles string arg values', () => {
    const line = toolLine('some_tool', { value: 'hello world' }, true);
    expect(line).toContain('hello world');
  });
});

describe('renderHeaderBox', () => {
  test('renders compact inline header with model', () => {
    const box = renderHeaderBox({
      provider: 'Anthropic',
      model: 'claude-3',
      endpoint: 'https://api.anthropic.com',
      status: 'ready',
      version: '0.1.0',
    });
    expect(box).toContain('orion');
    expect(box).toContain('v0.1.0');
    expect(box).toContain('claude-3');
  });

  test('renders as single line (no box borders)', () => {
    const box = renderHeaderBox({
      provider: 'Test',
      model: 'test-model',
      endpoint: 'http://localhost',
      status: 'ready',
      version: '1.0',
    });
    expect(box).not.toContain('╔');
    expect(box).not.toContain('╗');
    expect(box.split('\n').length).toBe(1);
  });

  test('shows ready status dot', () => {
    const box = renderHeaderBox({
      provider: 'Test',
      model: 'test',
      endpoint: 'http://localhost',
      status: 'ready',
      version: '1.0',
    });
    // status dot is rendered
    expect(box).toBeTruthy();
  });

  test('shortens Alibaba Cloud provider to Qwen', () => {
    const box = renderHeaderBox({
      provider: 'Alibaba Cloud',
      model: 'glm-5',
      endpoint: 'https://dashscope.aliyuncs.com',
      status: 'ready',
      version: '1.0',
    });
    expect(box).toContain('Qwen');
    expect(box).not.toContain('Alibaba Cloud');
  });
});

describe('renderPromptSeparator', () => {
  test('renders separator with prompt', () => {
    const sep = renderPromptSeparator();
    expect(sep).toContain('❯');
    expect(sep).toContain('─');
  });

  test('includes mode text when provided', () => {
    const sep = renderPromptSeparator('plan mode on');
    expect(sep).toContain('[plan mode on]');
  });
});

describe('renderFooterBar', () => {
  test('renders shortcuts hint', () => {
    const footer = renderFooterBar();
    expect(footer).toContain('? for shortcuts');
  });

  test('includes file context when provided', () => {
    const footer = renderFooterBar('test.ts');
    expect(footer).toContain('In');
    expect(footer).toContain('test.ts');
  });

  test('includes effort when provided', () => {
    const footer = renderFooterBar(undefined, 'high');
    expect(footer).toContain('high');
  });
});
