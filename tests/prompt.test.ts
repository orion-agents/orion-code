import { buildSystemPrompt, getSystemPrompt } from '../src/framework/prompt';
import type { PromptContext } from '../src/framework/prompt';
import { buildTool } from '../src/framework/tool';
import type { OpenHorseTool } from '../src/framework/tool';

const mockTool: OpenHorseTool = buildTool({
  name: 'read_file',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path' } } },
  execute: async () => ({ success: true, output: '' }),
});

const baseContext: PromptContext = {
  cwd: '/test/dir',
  platform: 'darwin',
  nodeVersion: 'v20.0.0',
  tools: [mockTool],
};

describe('buildSystemPrompt', () => {
  test('returns static and dynamic parts', () => {
    const result = buildSystemPrompt(baseContext);
    expect(result).toHaveProperty('static');
    expect(result).toHaveProperty('dynamic');
  });

  test('static part contains intro and capabilities', () => {
    const result = buildSystemPrompt(baseContext);
    expect(result.static).toContain('You are Orion Code');
    expect(result.static).toContain('action-oriented');
  });

  test('static part contains tool names', () => {
    const result = buildSystemPrompt(baseContext);
    expect(result.static).toContain('read_file');
  });

  test('static part contains the short execution strategy', () => {
    const result = buildSystemPrompt(baseContext);

    expect(result.static).toContain('Execution strategy');
    expect(result.static).toContain('short internal plan');
    expect(result.static).toContain('one well-planned tool batch');
  });

  test('static part instructs the model to batch independent read-only tool calls', () => {
    const result = buildSystemPrompt(baseContext);

    expect(result.static).toContain('Batched tool strategy');
    expect(result.static).toContain('multiple independent read-only tools');
    expect(result.static).toContain('use batch_read');
    expect(result.static).toContain('only git_status, list_files, glob, grep, and read_file');
    expect(result.static).toContain('Do not put web_search, web_fetch, exec_command, LSP tools, or write/edit tools inside batch_read');
    expect(result.static).toContain('Do not batch file edits');
  });

  test('dynamic part contains environment info', () => {
    const result = buildSystemPrompt(baseContext);
    expect(result.dynamic).toContain('/test/dir');
    expect(result.dynamic).toContain('darwin');
    expect(result.dynamic).toContain('v20.0.0');
  });

  test('dynamic part includes memory when provided', () => {
    const ctx: PromptContext = {
      ...baseContext,
      memoryContent: 'Some project memory',
    };
    const result = buildSystemPrompt(ctx);
    expect(result.dynamic).toContain('Some project memory');
  });

  test('dynamic part includes project instructions when provided', () => {
    const ctx: PromptContext = {
      ...baseContext,
      projectInstructionsContent: 'Project instructions loaded from repository guidance files.\n## AGENTS.md\nUse repo conventions.',
    };
    const result = buildSystemPrompt(ctx);

    expect(result.dynamic).toContain('Project instructions loaded');
    expect(result.dynamic).toContain('Use repo conventions.');
  });

  test('dynamic part includes active skill instructions when provided', () => {
    const ctx: PromptContext = {
      ...baseContext,
      activeSkillsContent: '## Active Skills\n\n### code-review\nReview carefully.',
    };
    const result = buildSystemPrompt(ctx);
    expect(result.dynamic).toContain('Active Skills');
    expect(result.dynamic).toContain('code-review');
  });

  test('dynamic part includes referenced file context when provided', () => {
    const ctx: PromptContext = {
      ...baseContext,
      referencedFilesContent: 'User-referenced files from the current input:\n### @src/app.ts\n~~~\ncode\n~~~',
    };
    const result = buildSystemPrompt(ctx);

    expect(result.dynamic).toContain('User-referenced files');
    expect(result.dynamic).toContain('@src/app.ts');
    expect(result.dynamic).toContain('code');
  });

  test('dynamic part excludes memory when not provided', () => {
    const result = buildSystemPrompt(baseContext);
    expect(result.dynamic).not.toContain('Project memory');
  });

  test('multiple tools are listed in static part', () => {
    const tools: OpenHorseTool[] = [
      buildTool({
        name: 'read_file',
        description: 'Read',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ success: true, output: '' }),
      }),
      buildTool({
        name: 'write_file',
        description: 'Write',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ success: true, output: '' }),
      }),
    ];
    const ctx: PromptContext = { ...baseContext, tools };
    const result = buildSystemPrompt(ctx);
    expect(result.static).toContain('read_file');
    expect(result.static).toContain('write_file');
  });
});

describe('getSystemPrompt', () => {
  test('returns a single combined string', () => {
    const prompt = getSystemPrompt(baseContext);
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  test('contains both static and dynamic content', () => {
    const prompt = getSystemPrompt(baseContext);
    expect(prompt).toContain('You are Orion Code');
    expect(prompt).toContain('/test/dir');
  });

  test('joins with separator', () => {
    const prompt = getSystemPrompt(baseContext);
    expect(prompt).toContain('\n\n---\n');
  });
});

describe('Stable prefix cache invariance', () => {
  test('static part is identical across 5 consecutive turns with varying dynamic context', () => {
    // Simulate 5 turns where user input changes (affecting dynamic context)
    // but the static system prefix should remain identical
    const staticPrefixes: string[] = [];
    const dynamicParts: string[] = [];

    for (let turn = 1; turn <= 5; turn++) {
      const ctx: PromptContext = {
        ...baseContext,
        cwd: `/test/dir/turn${turn}`, // Varies per turn
        memoryContent: turn > 1 ? `Previous turn ${turn - 1} result` : undefined,
        referencedFilesContent: turn === 3
          ? 'User-referenced files:\n### @src/index.ts\n~~~\n...\n~~~'
          : undefined,
      };
      const result = buildSystemPrompt(ctx);
      staticPrefixes.push(result.static);
      dynamicParts.push(result.dynamic);
    }

    // All static prefixes should be identical (same tools, same identity)
    for (let i = 1; i < staticPrefixes.length; i++) {
      expect(staticPrefixes[i]).toBe(staticPrefixes[0]);
    }

    // Dynamic parts should vary (cwd, memory, referenced files change)
    const uniqueDynamic = new Set(dynamicParts);
    expect(uniqueDynamic.size).toBeGreaterThan(1);
  });
});

describe('subagent prompt section', () => {
  const subtaskTool: OpenHorseTool = buildTool({
    name: 'subtask',
    description: 'Delegate subtasks',
    parameters: { type: 'object', properties: { tasks: { type: 'array', description: 'tasks' } } },
    execute: async () => ({ success: true, output: '' }),
  });

  it('includes subagent guidance when subtask tool is present', () => {
    const ctx: PromptContext = { ...baseContext, tools: [mockTool, subtaskTool] };
    const prompt = getSystemPrompt(ctx);
    expect(prompt).toMatch(/Subagent capability/);
    expect(prompt).toMatch(/subtask/);
    expect(prompt).toMatch(/READ-ONLY/);
    // Positive triggers + abuse prevention
    expect(prompt).toMatch(/independent/);
    expect(prompt).toMatch(/Do NOT use subtask/);
    expect(prompt).toMatch(/cannot edit/);
  });

  it('omits subagent guidance when subtask tool is absent', () => {
    const ctx: PromptContext = { ...baseContext, tools: [mockTool] };
    const prompt = getSystemPrompt(ctx);
    expect(prompt).not.toMatch(/Subagent capability/);
  });
});
