import { buildTool, toOpenAITool, toOpenAITools } from '../src/framework/tool';
import type { OpenHorseTool, ToolContext, ToolConfig } from '../src/framework/tool';

const mockContext: ToolContext = {
  cwd: '/test',
  config: { name: 'test', mode: 'development' } as ToolConfig,
};

describe('buildTool', () => {
  const baseTool: OpenHorseTool = {
    name: 'test_tool',
    description: 'A test tool',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
      },
      required: ['path'],
    },
    execute: async () => ({ success: true, output: 'ok' }),
  };

  test('fills default isConcurrencySafe as false', () => {
    const tool = buildTool(baseTool);
    expect(tool.isConcurrencySafe?.({})).toBe(false);
  });

  test('fills default isReadOnly as false', () => {
    const tool = buildTool(baseTool);
    expect(tool.isReadOnly?.({})).toBe(false);
  });

  test('fills default isDestructive as false', () => {
    const tool = buildTool(baseTool);
    expect(tool.isDestructive?.({})).toBe(false);
  });

  test('fills default checkPermissions as allow', () => {
    const tool = buildTool(baseTool);
    const result = tool.checkPermissions?.({}, mockContext);
    expect(result).toEqual({ behavior: 'allow' });
  });

  test('preserves custom isReadOnly', () => {
    const tool = buildTool({
      ...baseTool,
      isReadOnly: () => true,
    });
    expect(tool.isReadOnly?.({})).toBe(true);
  });

  test('preserves custom isDestructive', () => {
    const tool = buildTool({
      ...baseTool,
      isDestructive: (args) => Boolean(args.force),
    });
    expect(tool.isDestructive?.({})).toBe(false);
    expect(tool.isDestructive?.({ force: true })).toBe(true);
  });

  test('preserves custom checkPermissions', () => {
    const tool = buildTool({
      ...baseTool,
      checkPermissions: () => ({ behavior: 'deny', reason: 'no access' }),
    });
    const result = tool.checkPermissions?.({}, mockContext);
    expect(result).toEqual({ behavior: 'deny', reason: 'no access' });
  });

  test('preserves aliases', () => {
    const tool = buildTool({
      ...baseTool,
      aliases: ['read', 'cat'],
    });
    expect(tool.aliases).toEqual(['read', 'cat']);
  });

  test('preserves userFacingName', () => {
    const tool = buildTool({
      ...baseTool,
      userFacingName: (args) => `Read ${args.path}`,
    });
    expect(tool.userFacingName?.({ path: '/test' })).toBe('Read /test');
  });

  test('preserves getSummary', () => {
    const tool = buildTool({
      ...baseTool,
      getSummary: (_args, result) => result.output,
    });
    expect(tool.getSummary?.({}, { success: true, output: 'hello' })).toBe('hello');
  });

  test('execute works correctly', async () => {
    const tool = buildTool(baseTool);
    const result = await tool.execute({ path: '/test' }, mockContext);
    expect(result.success).toBe(true);
    expect(result.output).toBe('ok');
  });
});

describe('toOpenAITool', () => {
  test('converts OpenHorseTool to OpenAI format', () => {
    const tool = buildTool({
      name: 'read_file',
      description: 'Read a file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path' } },
        required: ['path'],
      },
      execute: async () => ({ success: true, output: '' }),
    });

    const openaiTool = toOpenAITool(tool);
    expect(openaiTool.type).toBe('function');
    expect(openaiTool.function.name).toBe('read_file');
    expect(openaiTool.function.description).toBe('Read a file');
    expect(openaiTool.function.parameters).toEqual({
      type: 'object',
      properties: { path: { type: 'string', description: 'Path' } },
      required: ['path'],
    });
  });
});

describe('toOpenAITools', () => {
  test('converts an array of tools', () => {
    const tools = [
      buildTool({
        name: 'tool_a',
        description: 'Tool A',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ success: true, output: '' }),
      }),
      buildTool({
        name: 'tool_b',
        description: 'Tool B',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ success: true, output: '' }),
      }),
    ];

    const result = toOpenAITools(tools);
    expect(result).toHaveLength(2);
    expect(result[0].function.name).toBe('tool_a');
    expect(result[1].function.name).toBe('tool_b');
  });
});
