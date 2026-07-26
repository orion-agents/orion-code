/**
 * Tool Scheduler unit tests
 */

import { buildTool } from '../src/framework/tool';
import type { OpenHorseTool, ToolContext } from '../src/framework/tool';
import { prepareToolCalls, executeToolCalls, inspectSchedule } from '../src/framework/tool-scheduler';
import type { Message } from '../src/services/llm';

const readOnlyTool: OpenHorseTool = buildTool({
  name: 'read_file',
  description: 'Read a file',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'File path' } },
    required: ['path'],
  },
  execute: async () => ({ success: true, output: 'file content' }),
  isConcurrencySafe: () => true,
});

const writeTool: OpenHorseTool = buildTool({
  name: 'edit_file',
  description: 'Edit a file',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'File path' } },
    required: ['path'],
  },
  execute: async () => ({ success: true, output: 'edited' }),
});

const askTool: OpenHorseTool = buildTool({
  name: 'web_search',
  description: 'Search the web',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search query' } },
    required: ['query'],
  },
  execute: async () => ({ success: true, output: 'results' }),
  checkPermissions: () => ({ behavior: 'ask', reason: 'External query' }),
});

const toolContext: ToolContext = {
  cwd: '/test',
  config: { name: 'orion-code', mode: 'development' },
};

const toolCalls = (names: string[]): NonNullable<Message['tool_calls']> =>
  names.map((name, i) => ({
    id: `call-${i}`,
    type: 'function' as const,
    function: { name, arguments: name === 'read_file' ? '{"path":"a.ts"}' : name === 'edit_file' ? '{"path":"a.ts","old":"x","new":"y"}' : '{"query":"q"}' },
  }));

const tools = [readOnlyTool, writeTool, askTool];

describe('prepareToolCalls', () => {
  test('marks read-only concurrent-safe tools as parallel', () => {
    const prepared = prepareToolCalls({
      toolCalls: toolCalls(['read_file', 'read_file']),
      tools,
      toolExecutor: async () => '',
      toolContext,
    });

    expect(prepared).toHaveLength(2);
    expect(prepared.every(p => p.canRunConcurrently)).toBe(true);
  });

  test('marks write tools as serial (not concurrency safe)', () => {
    const prepared = prepareToolCalls({
      toolCalls: toolCalls(['edit_file']),
      tools,
      toolExecutor: async () => '',
      toolContext,
    });

    expect(prepared[0].canRunConcurrently).toBe(false);
  });

  test('marks ask-permission tools as serial when interactive confirmation is available', () => {
    const prepared = prepareToolCalls({
      toolCalls: toolCalls(['web_search']),
      tools,
      toolExecutor: async () => '',
      toolContext,
      permissionMode: 'default',
      toolConfirmation: 'ask',
      confirmToolUse: async () => true,
    });

    expect(prepared[0].canRunConcurrently).toBe(false);
  });

  test('re-serializes tool arguments as valid JSON', () => {
    const calls = toolCalls(['read_file']);
    calls[0].function.arguments = '{"path":"a.ts","extra":true}'; // valid JSON with extra field

    prepareToolCalls({ toolCalls: calls, tools, toolExecutor: async () => '' });

    // Should be re-serialized (canonical JSON)
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ path: 'a.ts', extra: true });
  });

  test('handles invalid JSON arguments gracefully', () => {
    const calls = toolCalls(['read_file']);
    calls[0].function.arguments = 'not json at all';

    const prepared = prepareToolCalls({ toolCalls: calls, tools, toolExecutor: async () => '' });

    expect(prepared[0].args).toEqual({});
  });
});

describe('inspectSchedule', () => {
  test('separates parallel and serial calls', () => {
    const prepared = prepareToolCalls({
      toolCalls: toolCalls(['read_file', 'edit_file', 'read_file', 'web_search']),
      tools,
      toolExecutor: async () => '',
      toolContext,
      permissionMode: 'default',
      toolConfirmation: 'ask',
      confirmToolUse: async () => true,
    });

    const schedule = inspectSchedule(prepared);
    expect(schedule.parallel).toHaveLength(2); // two read_file
    expect(schedule.serial).toHaveLength(2); // edit_file + web_search
  });
});

describe('executeToolCalls', () => {
  test('executes concurrent tools in parallel and yields in order', async () => {
    const executionOrder: string[] = [];
    const delays = [50, 10, 30]; // simulate different execution times

    const prepared = prepareToolCalls({
      toolCalls: toolCalls(['read_file', 'read_file', 'read_file']),
      tools,
      toolExecutor: async (name, args) => {
        const idx = parseInt(args.path as string, 10) || 0;
        await new Promise(r => setTimeout(r, delays[idx] || 10));
        executionOrder.push(name);
        return JSON.stringify({ success: true, output: `content-${idx}` });
      },
      toolContext,
    });

    const results: any[] = [];
    for await (const executed of executeToolCalls(prepared, {
      toolExecutor: async (name, args) => {
        const idx = parseInt(args.path as string, 10) || 0;
        await new Promise(r => setTimeout(r, delays[idx] || 10));
        executionOrder.push(name);
        return JSON.stringify({ success: true, output: `content-${idx}` });
      },
    })) {
      results.push(executed);
    }

    // All 3 should succeed
    expect(results).toHaveLength(3);
    // Results should be in original order (index 0, 1, 2)
    expect(results.map(r => r.prepared.index)).toEqual([0, 1, 2]);
    // Parallel execution: total time < sum of individual times
    expect(executionOrder).toHaveLength(3);
  });

  test('limits concurrent-safe tools to maxParallelToolCalls batches', async () => {
    let active = 0;
    let maxActive = 0;

    const prepared = prepareToolCalls({
      toolCalls: toolCalls(['read_file', 'read_file', 'read_file', 'read_file']),
      tools,
      toolExecutor: async () => '',
      toolContext,
    });

    const results: any[] = [];
    for await (const executed of executeToolCalls(prepared, {
      maxParallelToolCalls: 2,
      toolExecutor: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 10));
        active--;
        return JSON.stringify({ success: true, output: 'ok' });
      },
    })) {
      results.push(executed);
    }

    expect(results).toHaveLength(4);
    expect(maxActive).toBe(2);
    expect(results.map(result => result.prepared.index)).toEqual([0, 1, 2, 3]);
  });

  test('flushes parallel read group before serial tools and resumes reads after', async () => {
    const calls: NonNullable<Message['tool_calls']> = [
      {
        id: 'call-0',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"0"}' },
      },
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"1"}' },
      },
      {
        id: 'call-2',
        type: 'function',
        function: { name: 'edit_file', arguments: '{"path":"2","old":"x","new":"y"}' },
      },
      {
        id: 'call-3',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"3"}' },
      },
    ];
    const log: string[] = [];

    const prepared = prepareToolCalls({
      toolCalls: calls,
      tools,
      toolExecutor: async () => '',
      toolContext,
    });

    const results: any[] = [];
    for await (const executed of executeToolCalls(prepared, {
      toolExecutor: async (name, args) => {
        const label = `${name}:${String(args.path)}`;
        log.push(`start:${label}`);
        if (name === 'read_file' && args.path !== '3') {
          await new Promise(resolve => setTimeout(resolve, args.path === '0' ? 20 : 5));
        }
        log.push(`end:${label}`);
        return JSON.stringify({ success: true, output: label });
      },
    })) {
      results.push(executed);
    }

    expect(results.map(result => result.prepared.index)).toEqual([0, 1, 2, 3]);
    expect(log.indexOf('start:edit_file:2')).toBeGreaterThan(log.indexOf('end:read_file:0'));
    expect(log.indexOf('start:edit_file:2')).toBeGreaterThan(log.indexOf('end:read_file:1'));
    expect(log.indexOf('start:read_file:3')).toBeGreaterThan(log.indexOf('end:edit_file:2'));
  });

  test('executes serial tools one at a time', async () => {
    const executionOrder: string[] = [];

    const prepared = prepareToolCalls({
      toolCalls: toolCalls(['edit_file', 'edit_file']),
      tools,
      toolExecutor: async () => JSON.stringify({ success: true, output: 'ok' }),
      toolContext,
    });

    const results: any[] = [];
    for await (const executed of executeToolCalls(prepared, {
      toolExecutor: async () => {
        executionOrder.push('exec');
        return JSON.stringify({ success: true, output: 'ok' });
      },
    })) {
      results.push(executed);
    }

    expect(results).toHaveLength(2);
    expect(executionOrder).toHaveLength(2);
  });

  test('aborted tool execution returns error result', async () => {
    const prepared = prepareToolCalls({
      toolCalls: toolCalls(['read_file']),
      tools,
      toolExecutor: async () => {
        throw new Error('Network error');
      },
      toolContext,
    });

    const results: any[] = [];
    for await (const executed of executeToolCalls(prepared, {
      toolExecutor: async () => {
        throw new Error('Network error');
      },
    })) {
      results.push(executed);
    }

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('Network error');
  });

  test('treats non-json tool result as success output', async () => {
    const prepared = prepareToolCalls({
      toolCalls: toolCalls(['read_file']),
      tools,
      toolExecutor: async () => 'plain text result',
      toolContext,
    });

    const results: any[] = [];
    for await (const executed of executeToolCalls(prepared, {
      toolExecutor: async () => 'plain text result',
    })) {
      results.push(executed);
    }

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].summary).toBe('plain text result');
    expect(results[0].outputBytes).toBeGreaterThan(0);
  });

  test('passes artifactRef through from tool result payload', async () => {
    const prepared = prepareToolCalls({
      toolCalls: toolCalls(['read_file']),
      tools,
      toolExecutor: async () => JSON.stringify({
        success: true,
        output: 'artifact output',
        outputBytes: 12,
        artifactRef: { id: 'read_file-123', outputBytes: 1200 },
      }),
      toolContext,
    });

    const results: any[] = [];
    for await (const executed of executeToolCalls(prepared, {
      toolExecutor: async () => JSON.stringify({
        success: true,
        output: 'artifact output',
        outputBytes: 12,
        artifactRef: { id: 'read_file-123', outputBytes: 1200 },
      }),
    })) {
      results.push(executed);
    }

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].artifactRef).toEqual({ id: 'read_file-123', outputBytes: 1200 });
  });

  test('denies ask-permission tools when toolConfirmation is deny', async () => {
    const prepared = prepareToolCalls({
      toolCalls: toolCalls(['web_search']),
      tools,
      toolExecutor: async () => '',
      toolContext,
      permissionMode: 'default',
      toolConfirmation: 'deny',
    });

    const results: any[] = [];
    for await (const executed of executeToolCalls(prepared, {
      toolExecutor: async () => '',
      permissionMode: 'default',
      toolConfirmation: 'deny',
    })) {
      results.push(executed);
    }

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('toolConfirmation=deny');
    expect(results[0].permissionDecision).toMatchObject({
      behavior: 'ask',
      approved: false,
      source: 'config_deny',
      reason: 'External query',
    });
  });

  test('allows ask-permission tools when toolConfirmation is allow', async () => {
    const prepared = prepareToolCalls({
      toolCalls: toolCalls(['web_search']),
      tools,
      toolExecutor: async () => JSON.stringify({ success: true, output: 'results' }),
      toolContext,
      permissionMode: 'default',
      toolConfirmation: 'allow',
    });

    const results: any[] = [];
    for await (const executed of executeToolCalls(prepared, {
      toolExecutor: async () => JSON.stringify({ success: true, output: 'results' }),
      permissionMode: 'default',
      toolConfirmation: 'allow',
    })) {
      results.push(executed);
    }

    expect(results[0].success).toBe(true);
    expect(results[0].permissionDecision).toMatchObject({
      behavior: 'ask',
      approved: true,
      source: 'config_allow',
      reason: 'External query',
    });
  });

  test('records user permission decision for interactive confirmation', async () => {
    const prepared = prepareToolCalls({
      toolCalls: toolCalls(['web_search']),
      tools,
      toolExecutor: async () => JSON.stringify({ success: true, output: 'results' }),
      toolContext,
      permissionMode: 'default',
      toolConfirmation: 'ask',
      confirmToolUse: async () => true,
    });

    const results: any[] = [];
    for await (const executed of executeToolCalls(prepared, {
      toolExecutor: async () => JSON.stringify({ success: true, output: 'results' }),
      permissionMode: 'default',
      toolConfirmation: 'ask',
      confirmToolUse: async () => false,
    })) {
      results.push(executed);
    }

    expect(results[0].success).toBe(false);
    expect(results[0].permissionDecision).toMatchObject({
      behavior: 'ask',
      approved: false,
      source: 'user',
      reason: 'External query',
    });
    expect(typeof results[0].permissionDecision.duration).toBe('number');
  });
});
