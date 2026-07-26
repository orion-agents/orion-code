import fs from 'fs';
import path from 'path';
import { executeTool, getRuntimeTools } from '../src/tools';
import { buildMcpToolName, mcpManager } from '../src/tools/mcp';
import type { ToolContext } from '../src/framework/tool';

const testRoot = path.join(process.cwd(), 'tests', 'tmp-mcp');
const configDir = path.join(testRoot, 'config');
const serverPath = path.join(testRoot, 'fake-mcp-server.js');
const originalConfigDir = process.env.ORION_CODE_CONFIG_DIR;
const originalSuffix = process.env.MCP_TEST_SUFFIX;

const ctx: ToolContext = {
  cwd: process.cwd(),
  config: { name: 'test', mode: 'development' },
};

function writeFakeMcpServer(): void {
  fs.mkdirSync(testRoot, { recursive: true });
  fs.writeFileSync(serverPath, `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });

if (process.env.MCP_TEST_NOISE === '1') {
  process.stdout.write('fake MCP banner\\n{not-json}\\n');
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
}

function fail(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\\n');
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (!msg.id) return;

  if (msg.method === 'initialize') {
    if (process.env.MCP_TEST_FAIL_INIT === '1') {
      process.exit(1);
    }
    respond(msg.id, {
      protocolVersion: msg.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'fake-mcp', version: '1.0.0' }
    });
    return;
  }

  if (msg.method === 'tools/list') {
    respond(msg.id, {
      tools: [{
        name: 'echo',
        description: 'Echo test input',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Text to echo' }
          },
          required: ['text']
        },
        annotations: { readOnlyHint: true }
      }]
    });
    return;
  }

  if (msg.method === 'tools/call') {
    if (msg.params.name !== 'echo') {
      fail(msg.id, -32601, 'Unknown tool');
      return;
    }
    const args = msg.params.arguments || {};
    respond(msg.id, {
      content: [{ type: 'text', text: 'echo:' + args.text + ':' + (process.env.MCP_SUFFIX || '') }]
    });
    return;
  }

  fail(msg.id, -32601, 'Unknown method');
});
`, 'utf-8');
}

function writeMcpConfig(payload: unknown): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'mcp.json'), JSON.stringify(payload, null, 2), 'utf-8');
}

describe('MCP integration', () => {
  beforeEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
    writeFakeMcpServer();
    process.env.ORION_CODE_CONFIG_DIR = configDir;
    process.env.MCP_TEST_SUFFIX = 'ok';
    mcpManager.disconnectAll();
  });

  afterEach(() => {
    mcpManager.disconnectAll();
    if (originalConfigDir === undefined) {
      delete process.env.ORION_CODE_CONFIG_DIR;
    } else {
      process.env.ORION_CODE_CONFIG_DIR = originalConfigDir;
    }
    if (originalSuffix === undefined) {
      delete process.env.MCP_TEST_SUFFIX;
    } else {
      process.env.MCP_TEST_SUFFIX = originalSuffix;
    }
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('connects configured stdio servers and exposes first-class MCP tools', async () => {
    writeMcpConfig({
      mcpServers: {
        sample: {
          command: process.execPath,
          args: [serverPath],
          env: { MCP_SUFFIX: '${MCP_TEST_SUFFIX}' },
        },
      },
    });

    await mcpManager.connectAll();

    const status = mcpManager.getStatus();
    expect(status).toEqual([
      expect.objectContaining({ name: 'sample', connected: true, toolCount: 1, dead: false }),
    ]);

    const toolName = buildMcpToolName('sample', 'echo');
    const runtimeTool = getRuntimeTools().find(tool => tool.name === toolName);
    expect(runtimeTool).toBeDefined();
    expect(runtimeTool?.parameters.required).toEqual(['text']);
    expect(runtimeTool?.isReadOnly?.({})).toBe(true);

    const rawResult = await executeTool(toolName, { text: 'hello' });
    expect(JSON.parse(rawResult)).toEqual(expect.objectContaining({
      success: true,
      output: 'echo:hello:ok',
      summary: 'MCP sample/echo',
      outputBytes: 13,
    }));
  });

  test('mcp_list includes connected server tools', async () => {
    writeMcpConfig({
      mcpServers: {
        sample: {
          command: process.execPath,
          args: [serverPath],
        },
      },
    });

    await mcpManager.connectAll();

    const listTool = getRuntimeTools().find(tool => tool.name === 'mcp_list');
    const result = await listTool!.execute({}, ctx);

    expect(result.success).toBe(true);
    expect(result.output).toContain('[sample] echo');
    expect(result.output).toContain('Parameters: text');
  });

  test('accepts legacy servers config key for compatibility', async () => {
    writeMcpConfig({
      servers: {
        sample: {
          command: process.execPath,
          args: [serverPath],
        },
      },
    });

    await mcpManager.connectAll();

    expect(getRuntimeTools().map(tool => tool.name)).toContain('mcp__sample__echo');
  });

  test('drops banner and malformed newline-delimited output before valid responses', async () => {
    writeMcpConfig({
      mcpServers: {
        sample: {
          command: process.execPath,
          args: [serverPath],
          env: { MCP_TEST_NOISE: '1' },
        },
      },
    });

    await mcpManager.connectAll();

    const client = mcpManager.getClient('sample') as unknown as { state: { buffer: string } };
    expect(client.state.buffer).toBe('');
    expect(mcpManager.getStatus()).toEqual([
      expect.objectContaining({ name: 'sample', connected: true, dead: false }),
    ]);
  });

  test('cleans up a server that exits during initialization', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    writeMcpConfig({
      mcpServers: {
        sample: {
          command: process.execPath,
          args: [serverPath],
          env: { MCP_TEST_FAIL_INIT: '1' },
        },
      },
    });

    try {
      await mcpManager.connectAll();
      expect(mcpManager.getClient('sample')).toBeUndefined();
      expect(mcpManager.getStatus()).toEqual([
        expect.objectContaining({ name: 'sample', connected: false, toolCount: 0, dead: true }),
      ]);
    } finally {
      consoleError.mockRestore();
    }
  });
});
