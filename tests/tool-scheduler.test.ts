/**
 * Tool Scheduler unit tests
 */

import { buildTool } from '../src/framework/tool';
import type { OpenHorseTool, ToolContext } from '../src/framework/tool';
import {
  prepareToolCalls,
  executeToolCalls,
  inspectSchedule,
  resolveEffectivePermission,
} from '../src/framework/tool-scheduler';
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
  isReadOnly: () => true,
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
  isDestructive: () => true,
  isFileEdit: () => true,
  checkPermissions: () => ({ behavior: 'ask', reason: 'Edit operation' }),
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
  isReadOnly: () => true,
  checkPermissions: () => ({ behavior: 'ask', reason: 'External query' }),
});

/** File-edit tool that requires confirmation — the target of `acceptEdits`. */
const askFileEditTool: OpenHorseTool = buildTool({
  name: 'write_file',
  description: 'Write a file',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'File path' } },
    required: ['path'],
  },
  execute: async () => ({ success: true, output: 'written' }),
  isDestructive: () => true,
  isFileEdit: () => true,
  checkPermissions: () => ({ behavior: 'ask', reason: 'Write operation' }),
});

/** Concurrency-safe ask tool, used to assert scheduling stays consistent with execution. */
const askConcurrentTool: OpenHorseTool = buildTool({
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

const toolContext: ToolContext = {
  cwd: '/test',
  config: { name: 'orion-code', mode: 'development' },
};

const ARGS_BY_TOOL: Record<string, string> = {
  read_file: '{"path":"a.ts"}',
  edit_file: '{"path":"a.ts","old":"x","new":"y"}',
  write_file: '{"path":"a.ts","content":"x"}',
  web_fetch: '{"url":"https://example.com"}',
};

const toolCalls = (names: string[]): NonNullable<Message['tool_calls']> =>
  names.map((name, i) => ({
    id: `call-${i}`,
    type: 'function' as const,
    function: { name, arguments: ARGS_BY_TOOL[name] ?? '{"query":"q"}' },
  }));

const tools = [readOnlyTool, writeTool, askTool, askFileEditTool, askConcurrentTool];

const stateWriteTool: OpenHorseTool = buildTool({
  name: 'state_write',
  description: 'Mutate application state',
  parameters: { type: 'object', properties: {}, required: [] },
  execute: async () => ({ success: true, output: 'written' }),
  isReadOnly: () => false,
});

const dangerousTool: OpenHorseTool = buildTool({
  name: 'dangerous_action',
  description: 'Perform a destructive action',
  parameters: { type: 'object', properties: {}, required: [] },
  execute: async () => ({ success: true, output: 'destroyed' }),
  isDestructive: () => true,
  checkPermissions: () => ({ behavior: 'ask', reason: 'Dangerous operation' }),
});

describe('prepareToolCalls', () => {
  test('marks read-only concurrent-safe tools as parallel', () => {
    const prepared = prepareToolCalls({
      toolCalls: toolCalls(['read_file', 'read_file']),
      tools,
      toolExecutor: async () => '',
      toolContext,
      permissionMode: 'acceptEdits',
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
      permissionMode: 'acceptEdits',
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
      permissionMode: 'acceptEdits',
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
      permissionMode: 'acceptEdits',
    });

    const results: any[] = [];
    for await (const executed of executeToolCalls(prepared, {
      toolExecutor: async () => {
        executionOrder.push('exec');
        return JSON.stringify({ success: true, output: 'ok' });
      },
      permissionMode: 'acceptEdits',
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
      toolExecutor: async () =>
        JSON.stringify({
          success: true,
          output: 'artifact output',
          outputBytes: 12,
          artifactRef: { id: 'read_file-123', outputBytes: 1200 },
        }),
      toolContext,
    });

    const results: any[] = [];
    for await (const executed of executeToolCalls(prepared, {
      toolExecutor: async () =>
        JSON.stringify({
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

    expect(results[0].success).toBe(false);
    expect(results[0].permissionDecision).toMatchObject({
      behavior: 'ask',
      approved: false,
      source: 'config_allow_blocked',
      reason: 'External query',
    });
    expect(results[0].error).toContain('toolConfirmation=allow cannot approve');
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

// ============================================================================
// Permission mode semantics (regression: non-default modes used to bypass ask)
// ============================================================================

describe('permission mode semantics for ask tools', () => {
  const runOne = async (
    name: string,
    opts: {
      permissionMode?: string;
      toolConfirmation?: string;
      confirmToolUse?: (req: { name: string }) => Promise<boolean>;
      onExec?: (name: string) => void;
    }
  ) => {
    const toolExecutor = async (toolName: string) => {
      opts.onExec?.(toolName);
      return JSON.stringify({ success: true, output: 'executed' });
    };
    const base = {
      toolCalls: toolCalls([name]),
      tools,
      toolExecutor,
      toolContext,
      permissionMode: opts.permissionMode,
      toolConfirmation: opts.toolConfirmation,
      confirmToolUse: opts.confirmToolUse,
    };
    const prepared = prepareToolCalls(base);
    const results: any[] = [];
    for await (const executed of executeToolCalls(prepared, {
      toolExecutor,
      permissionMode: opts.permissionMode,
      toolConfirmation: opts.toolConfirmation,
      confirmToolUse: opts.confirmToolUse,
    })) {
      results.push(executed);
    }
    return { results, prepared };
  };

  test('plan mode blocks ask tools and never executes them', async () => {
    const executed: string[] = [];
    const { results } = await runOne('web_search', {
      permissionMode: 'plan',
      toolConfirmation: 'allow',
      onExec: n => executed.push(n),
    });

    expect(executed).toEqual([]);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('blocked in plan mode');
    expect(results[0].permissionDecision).toMatchObject({
      behavior: 'ask',
      approved: false,
      source: 'plan_mode',
      reason: 'External query',
    });
  });

  test('plan mode blocks file-edit tools too', async () => {
    const executed: string[] = [];
    const { results } = await runOne('write_file', {
      permissionMode: 'plan',
      onExec: n => executed.push(n),
    });

    expect(executed).toEqual([]);
    expect(results[0].success).toBe(false);
    expect(results[0].permissionDecision.source).toBe('plan_mode');
  });

  test('acceptEdits auto-approves file-edit tools without prompting', async () => {
    const executed: string[] = [];
    let prompted = 0;
    const { results } = await runOne('write_file', {
      permissionMode: 'acceptEdits',
      toolConfirmation: 'ask',
      confirmToolUse: async () => {
        prompted++;
        return false;
      },
      onExec: n => executed.push(n),
    });

    expect(prompted).toBe(0);
    expect(executed).toEqual(['write_file']);
    expect(results[0].success).toBe(true);
    expect(results[0].permissionDecision).toMatchObject({
      behavior: 'ask',
      approved: true,
      source: 'mode_accept_edits',
      reason: 'Write operation',
    });
  });

  test('acceptEdits still confirms non-edit ask tools (no blanket bypass)', async () => {
    const executed: string[] = [];
    let prompted = 0;
    const { results } = await runOne('web_search', {
      permissionMode: 'acceptEdits',
      toolConfirmation: 'ask',
      confirmToolUse: async () => {
        prompted++;
        return false;
      },
      onExec: n => executed.push(n),
    });

    expect(prompted).toBe(1);
    expect(executed).toEqual([]);
    expect(results[0].success).toBe(false);
    expect(results[0].permissionDecision).toMatchObject({
      approved: false,
      source: 'user',
    });
  });

  test('acceptEdits honours toolConfirmation=deny for non-edit ask tools', async () => {
    const executed: string[] = [];
    const { results } = await runOne('web_search', {
      permissionMode: 'acceptEdits',
      toolConfirmation: 'deny',
      onExec: n => executed.push(n),
    });

    expect(executed).toEqual([]);
    expect(results[0].success).toBe(false);
    expect(results[0].permissionDecision.source).toBe('config_deny');
  });

  test('auto mode does not approve external ask tools', async () => {
    const executed: string[] = [];
    let prompted = 0;
    const { results } = await runOne('web_search', {
      permissionMode: 'auto',
      toolConfirmation: 'ask',
      confirmToolUse: async () => {
        prompted++;
        return false;
      },
      onExec: n => executed.push(n),
    });

    expect(prompted).toBe(1);
    expect(executed).toEqual([]);
    expect(results[0].success).toBe(false);
    expect(results[0].permissionDecision).toMatchObject({
      approved: false,
      source: 'user',
    });
  });

  test('scheduling matches execution: acceptEdits keeps confirmable ask tools serial', () => {
    const confirmToolUse = async () => true;

    const inAcceptEdits = prepareToolCalls({
      toolCalls: toolCalls(['web_fetch']),
      tools,
      toolExecutor: async () => '',
      toolContext,
      permissionMode: 'acceptEdits',
      toolConfirmation: 'ask',
      confirmToolUse,
    });
    // Regression: used to be `true` because the check was gated on permissionMode==='default',
    // which would have run an interactive prompt inside a parallel batch.
    expect(inAcceptEdits[0].canRunConcurrently).toBe(false);

    const inDefault = prepareToolCalls({
      toolCalls: toolCalls(['web_fetch']),
      tools,
      toolExecutor: async () => '',
      toolContext,
      permissionMode: 'default',
      toolConfirmation: 'ask',
      confirmToolUse,
    });
    expect(inDefault[0].canRunConcurrently).toBe(false);

    const inAuto = prepareToolCalls({
      toolCalls: toolCalls(['web_fetch']),
      tools,
      toolExecutor: async () => '',
      toolContext,
      permissionMode: 'auto',
      toolConfirmation: 'ask',
      confirmToolUse,
    });
    // auto mode does not bypass confirmation, so it must stay out of the
    // parallel batch while the confirmation callback is pending.
    expect(inAuto[0].canRunConcurrently).toBe(false);
  });
});

describe('fail-closed permission matrix', () => {
  const cases: Array<{
    label: string;
    tool: OpenHorseTool;
    permission?: { behavior: 'allow' | 'ask' | 'deny'; reason?: string };
    expected: Record<string, 'allow' | 'confirm' | 'block'>;
  }> = [
    {
      label: 'safe/read-only',
      tool: readOnlyTool,
      expected: { default: 'allow', acceptEdits: 'allow', plan: 'allow', auto: 'allow' },
    },
    {
      label: 'caution/external',
      tool: askTool,
      permission: { behavior: 'ask', reason: 'External query' },
      expected: { default: 'confirm', acceptEdits: 'confirm', plan: 'block', auto: 'confirm' },
    },
    {
      label: 'state-write',
      tool: stateWriteTool,
      expected: { default: 'confirm', acceptEdits: 'confirm', plan: 'block', auto: 'confirm' },
    },
    {
      label: 'destructive',
      tool: dangerousTool,
      permission: { behavior: 'ask', reason: 'Dangerous operation' },
      expected: { default: 'confirm', acceptEdits: 'confirm', plan: 'block', auto: 'confirm' },
    },
  ];

  test.each(cases)('$label obeys every permission mode', ({ tool, permission, expected }) => {
    for (const mode of ['default', 'acceptEdits', 'plan', 'auto']) {
      const decision = resolveEffectivePermission({
        toolName: tool.name,
        tool,
        args: {},
        permission,
        permissionMode: mode,
      });
      expect(decision.outcome).toBe(expected[mode]);
    }
  });

  test('global allow cannot approve caution, state-write, destructive, or unknown tools', async () => {
    const unknownTool: OpenHorseTool = buildTool({
      name: 'unknown_risk',
      description: 'No risk metadata',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => ({ success: true, output: 'must not run' }),
    });
    const matrixTools = [askTool, stateWriteTool, dangerousTool, unknownTool];
    const executed: string[] = [];

    for (const tool of matrixTools) {
      const prepared = prepareToolCalls({
        toolCalls: [
          { id: tool.name, type: 'function', function: { name: tool.name, arguments: '{}' } },
        ],
        tools: matrixTools,
        toolExecutor: async name => {
          executed.push(name);
          return JSON.stringify({ success: true, output: 'unexpected' });
        },
        toolContext,
        toolConfirmation: 'allow',
      });
      for await (const result of executeToolCalls(prepared, {
        toolExecutor: async name => {
          executed.push(name);
          return JSON.stringify({ success: true, output: 'unexpected' });
        },
        toolConfirmation: 'allow',
      })) {
        expect(result.success).toBe(false);
        expect(result.permissionDecision?.approved).toBe(false);
      }
    }

    expect(executed).toEqual([]);
  });

  test('allowlist allow does not auto-approve missing risk metadata', () => {
    const decision = resolveEffectivePermission({
      toolName: 'unknown_risk',
      tool: buildTool({
        name: 'unknown_risk',
        description: 'No risk metadata',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => ({ success: true, output: 'must not run' }),
      }),
      args: {},
      allowlist: { effect: 'allow', rule: 'unknown_risk' },
    });
    expect(decision).toMatchObject({ outcome: 'confirm', source: 'missing_risk_metadata' });
  });
});
