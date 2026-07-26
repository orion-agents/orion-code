/**
 * openhorse - UI 组件测试
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { createStreamRenderer, StreamMarkdownRenderer } from '../src/ui/stream-markdown';
import { renderToolCard, renderToolLine, renderDiffPreview, renderReadPreview } from '../src/ui/tool-preview';
import { renderStatusBar, renderCompactStatusBar } from '../src/ui/status-bar';
import { renderUserInputEcho, renderUserInputEchoFrame } from '../src/ui/user-input';

// ============================================================================
// StreamMarkdownRenderer 测试
// ============================================================================

describe('StreamMarkdownRenderer', () => {
  let renderer: StreamMarkdownRenderer;

  beforeEach(() => {
    renderer = createStreamRenderer();
  });

  test('renders plain text immediately', () => {
    const output = renderer.feed('Hello world\n');
    expect(output).toContain('Hello world');
  });

  test('buffers code block until end', () => {
    // Feed code block start
    const output1 = renderer.feed('Here is code:\n```typescript\n');
    expect(output1).toContain('Here is code:');
    expect(output1).toContain('typescript');

    // Feed code content - outputs line immediately
    const output2 = renderer.feed('const x = 1;\n');
    expect(output2).toContain('const x = 1');

    // Feed code block end
    const output3 = renderer.feed('```');
    expect(output3).toContain('└──');
  });

  test('flush outputs remaining buffer', () => {
    renderer.feed('Some text');
    renderer.feed(' more text');
    const flush = renderer.flush();
    expect(flush).toContain('Some text more text');
  });

  test('reset clears all state', () => {
    renderer.feed('```typescript\ncode\n');
    renderer.reset();
    const flush = renderer.flush();
    expect(flush).toBe('');
  });
});

// ============================================================================
// Tool Preview 测试
// ============================================================================

describe('Tool Preview', () => {
  test('renderToolCard formats success tool', () => {
    const card = renderToolCard({
      name: 'Read',
      args: { path: '/src/test.ts' },
      result: 'content here',
      success: true,
      duration: 100,
    });

    expect(card).toContain('Read');
    expect(card).toContain('/src/test.ts');
    expect(card).toContain('100ms');
  });

  test('renderToolCard formats failed tool', () => {
    const card = renderToolCard({
      name: 'Bash',
      args: { command: 'npm test' },
      result: 'Error: failed',
      success: false,
      duration: 500,
    });

    expect(card).toContain('Bash');
    expect(card).toContain('npm test');
  });

  test('renderToolLine formats compact output', () => {
    const line = renderToolLine('Read', { path: '/test.ts' }, true, 50);
    expect(line).toContain('Read');
    expect(line).toContain('50ms');
  });

  test('renderDiffPreview shows +/- lines', () => {
    const diff = renderDiffPreview({
      file: 'config.ts',
      oldLines: ['const MAX = 100;'],
      newLines: ['const MAX = 200;'],
    });

    expect(diff).toContain('config.ts');
  });

  test('renderReadPreview shows file content', () => {
    const preview = renderReadPreview('test.ts', 'line1\nline2\nline3', true);
    expect(preview).toContain('Read');
    expect(preview).toContain('test.ts');
  });
});

// ============================================================================
// Status Bar 测试
// ============================================================================

describe('Status Bar', () => {
  test('renderStatusBar formats all stats', () => {
    const stats = {
      model: 'gpt-4o',
      tokens: 5000,
      promptTokens: 3000,
      completionTokens: 2000,
      cost: 0.05,
      ctxPercent: 30,
      mcpConnected: 2,
      mcpTotal: 3,
    };

    const bar = renderStatusBar(stats);
    expect(bar).toContain('Orion Code');
    expect(bar).toContain('gpt-4o');
    expect(bar).toContain('K tok'); // Uses format like "5.0K tok"
    expect(bar).toContain('MCP');
  });

  test('renderCompactStatusBar shows tokens and context without realtime cost', () => {
    const stats = {
      model: 'gpt-4o',
      tokens: 1000,
      promptTokens: 600,
      completionTokens: 400,
      cost: 0.01,
      ctxPercent: 20,
      mcpConnected: 0,
      mcpTotal: 0,
    };

    const bar = renderCompactStatusBar(stats);
    expect(bar).toContain('K tok'); // Uses format like "1.0K tok"
    expect(bar).toContain('ctx');
    expect(bar).not.toContain('$0.0100');
  });

  test('handles zero values', () => {
    const stats = {
      model: 'test',
      tokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
      ctxPercent: 0,
      mcpConnected: 0,
      mcpTotal: 0,
    };

    const bar = renderStatusBar(stats);
    expect(bar).toContain('Orion Code');
  });
});

// ============================================================================
// User Input Echo 测试
// ============================================================================

describe('User Input Echo', () => {
  const originalNoColor = process.env.NO_COLOR;
  const originalTerm = process.env.TERM;
  const stripAnsi = (text: string) => text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');

  afterEach(() => {
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }
    if (originalTerm === undefined) {
      delete process.env.TERM;
    } else {
      process.env.TERM = originalTerm;
    }
  });

  test('renders submitted input with true-color background', () => {
    delete process.env.NO_COLOR;
    process.env.TERM = 'xterm-256color';

    const output = renderUserInputEcho('hello', 20);

    expect(output).toContain('\x1b[48;2;56;56;56m');
    expect(output).toContain('\x1b[38;2;226;232;240m');
    expect(stripAnsi(output)).toHaveLength(20);
    expect(stripAnsi(output)).toContain('hello');
    expect(stripAnsi(output)).not.toContain('❯');
  });

  test('fills every submitted line to the terminal width', () => {
    delete process.env.NO_COLOR;
    process.env.TERM = 'xterm-256color';

    const output = renderUserInputEcho('hello\n世界', 12);
    const lines = stripAnsi(output).split('\n');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveLength(12);
    expect(lines[1]).toContain('世界');
  });

  test('falls back to plain text when colors are disabled', () => {
    process.env.NO_COLOR = '1';

    const output = renderUserInputEcho('hello', 20);

    expect(output).toHaveLength(20);
    expect(output).toContain('hello');
    expect(output).not.toContain('\x1b[');
  });

  test('renders submitted framed input without transcript separators', () => {
    delete process.env.NO_COLOR;
    process.env.TERM = 'xterm-256color';

    const output = renderUserInputEchoFrame('挺好的', 20);
    const lines = stripAnsi(output).split('\n');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('挺好的');
    expect(lines[0]).not.toContain('❯');
    expect(lines[0]).not.toContain('─');
    expect(lines[0].trim()).toBe('挺好的');
  });
});
