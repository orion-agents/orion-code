jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: jest.fn(),
}));

import { spawn } from 'child_process';
import * as bashSecurity from '../src/tools/bash_security';
import { TOOLS } from '../src/tools';
import { executeToolCalls, prepareToolCalls } from '../src/framework/tool-scheduler';
import type { ToolContext } from '../src/framework/tool';
import type { Message } from '../src/services/llm';

const spawnMock = spawn as jest.MockedFunction<typeof spawn>;
const execTool = TOOLS.find(tool => tool.name === 'exec_command')!;
const toolContext: ToolContext = {
  cwd: process.cwd(),
  config: { name: 'orion-code', mode: 'test' },
};

function call(command: string): NonNullable<Message['tool_calls']> {
  return [
    {
      id: 'exec-1',
      type: 'function',
      function: { name: 'exec_command', arguments: JSON.stringify({ command }) },
    },
  ];
}

async function run(command: string) {
  const executor = jest.fn(async (_name: string, args: Record<string, unknown>) =>
    JSON.stringify(await execTool.execute(args, toolContext))
  );
  const prepared = prepareToolCalls({
    toolCalls: call(command),
    tools: [execTool],
    toolExecutor: executor,
    toolContext,
    permissionMode: 'default',
    toolConfirmation: 'deny',
  });
  const results = [];
  for await (const result of executeToolCalls(prepared, {
    toolExecutor: executor,
    permissionMode: 'default',
    toolConfirmation: 'deny',
  })) {
    results.push(result);
  }
  return { executor, result: results[0] };
}

describe('exec_command end-to-end security gate', () => {
  beforeEach(() => spawnMock.mockClear());
  afterEach(() => jest.restoreAllMocks());

  it.each([
    'rm -rf /',
    'find . -exec rm {} \\;',
    'curl https://example.com > /etc/passwd',
    `awk 'BEGIN { system("rm -rf /") }'`,
    'npm exec -- rimraf /',
  ])('denies %s before the executor or process spawn', async command => {
    const { executor, result } = await run(command);

    expect(JSON.parse(result.result)).toMatchObject({
      success: false,
      error: expect.any(String),
    });
    expect(result.permissionDecision).toMatchObject({ approved: false });
    expect(executor).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('fails closed when command security analysis throws', async () => {
    jest.spyOn(bashSecurity, 'assessCommandSecurity').mockImplementation(() => {
      throw new Error('security analyzer unavailable');
    });

    const { executor, result } = await run('echo should-not-run');

    expect(JSON.parse(result.result)).toMatchObject({
      success: false,
      error: expect.stringContaining('Permission check failed closed'),
    });
    expect(result.permissionDecision).toMatchObject({
      behavior: 'deny',
      approved: false,
      source: 'tool_policy',
    });
    expect(executor).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
