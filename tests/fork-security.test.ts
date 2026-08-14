import type { LLMService } from '../src/services/llm';
import type { QueryParams } from '../src/framework/query';

jest.mock('../src/framework', () => {
  const actual = jest.requireActual('../src/framework');
  return { ...actual, query: jest.fn() };
});

import { query } from '../src/framework';
import { forkSubagent } from '../src/agents/fork';

const queryMock = query as jest.MockedFunction<typeof query>;
const llm = {} as LLMService;

describe('forkSubagent security boundary', () => {
  let captured: QueryParams | undefined;

  beforeEach(() => {
    captured = undefined;
    queryMock.mockImplementation(async function* (params: QueryParams) {
      captured = params;
      yield {
        type: 'complete',
        content: 'done',
        model: 'test-model',
        stats: {} as never,
      };
    } as typeof query);
  });

  afterEach(() => jest.clearAllMocks());

  it('requires an injected typed LLM and never falls back to the CLI module', async () => {
    const result = await forkSubagent({
      inheritContext: false,
      taskDescription: 'inspect files',
      background: true,
    });

    expect(result).toMatchObject({
      success: false,
      error: 'No LLM available for fork subagent',
    });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('defaults to a minimal read-only tool set without relying on an Agent-mode gate', async () => {
    const result = await forkSubagent({
      inheritContext: false,
      taskDescription: 'inspect files',
      background: true,
      llm,
    });

    expect(result.success).toBe(true);
    expect(captured?.llm).toBe(llm);
    expect(captured?.permissionMode).toBe('plan');
    expect(captured?.toolContext).toMatchObject({
      permissionMode: 'plan',
      cwd: process.cwd(),
    });
    expect(captured?.tools.map(tool => tool.name)).toEqual([
      'read_file',
      'list_files',
      'glob',
      'grep',
      'batch_read',
    ]);
    expect(captured?.tools.every(tool => tool.isReadOnly?.({}) === true)).toBe(true);
    expect(captured?.tools.map(tool => tool.name)).not.toEqual(
      expect.arrayContaining(['exec_command', 'write_file', 'edit_file', 'delete_file'])
    );
  });
});
