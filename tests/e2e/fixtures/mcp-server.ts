import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

export const MCP_FIXTURE_SERVER_ID = 'web_e2e';
export const MCP_FIXTURE_ECHO_TOOL = `mcp__${MCP_FIXTURE_SERVER_ID}__fixture_echo`;
export const MCP_FIXTURE_LARGE_TOOL = `mcp__${MCP_FIXTURE_SERVER_ID}__fixture_large_text`;

/** Dependency-free newline-delimited JSON-RPC MCP server run by the production stdio adapter. */
export const MCP_FIXTURE_SERVER_SOURCE = String.raw`
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const fail = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
input.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined || message.id === null) return;
  if (message.method === 'initialize') {
    return send(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'orion-web-e2e', version: '1.0.0' }
    });
  }
  if (message.method === 'tools/list') {
    return send(message.id, { tools: [
      {
        name: 'fixture_echo',
        description: 'Return deterministic text for Orion Web E2E.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false
        }
      },
      {
        name: 'fixture_large_text',
        description: 'Return bounded deterministic text for paging tests.',
        inputSchema: {
          type: 'object',
          properties: { bytes: { type: 'number', minimum: 1, maximum: 131072 } },
          required: ['bytes'],
          additionalProperties: false
        }
      }
    ] });
  }
  if (message.method === 'tools/call') {
    const name = message.params && message.params.name;
    const args = (message.params && message.params.arguments) || {};
    if (name === 'fixture_echo') {
      return send(message.id, { content: [{ type: 'text', text: String(args.text || '') }] });
    }
    if (name === 'fixture_large_text') {
      const bytes = Number(args.bytes);
      if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 131072) {
        return fail(message.id, -32602, 'bytes must be an integer from 1 through 131072');
      }
      return send(message.id, { content: [{ type: 'text', text: 'M'.repeat(bytes) }] });
    }
    return fail(message.id, -32601, 'Unknown fixture tool');
  }
  return fail(message.id, -32601, 'Unknown fixture method');
});
`;

export interface McpFixtureConfigOptions {
  readonly serverId?: string;
  readonly fileName?: string;
}

export interface McpFixtureConfig {
  readonly configPath: string;
  readonly serverId: string;
  readonly echoToolName: string;
  readonly largeToolName: string;
}

/** Write the current production-compatible stdio MCP envelope into an isolated config root. */
export function writeMcpFixtureConfig(
  configDirectory: string,
  options: McpFixtureConfigOptions = {}
): McpFixtureConfig {
  const root = resolve(configDirectory);
  const serverId = options.serverId ?? MCP_FIXTURE_SERVER_ID;
  if (!/^[A-Za-z0-9_.-]+$/u.test(serverId)) throw new Error('MCP fixture server id is invalid.');
  const fileName = options.fileName ?? 'mcp.json';
  if (fileName !== 'mcp.json') throw new Error('MCP fixture config must use mcp.json.');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const configPath = join(root, fileName);
  const config = {
    mcpServers: {
      [serverId]: {
        type: 'stdio',
        command: process.execPath,
        args: ['-e', MCP_FIXTURE_SERVER_SOURCE],
        name: 'Orion Web E2E MCP',
        description: 'Deterministic local-only MCP fixture.',
        tags: ['deterministic', 'e2e'],
      },
    },
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return Object.freeze({
    configPath,
    serverId,
    echoToolName: `mcp__${serverId}__fixture_echo`,
    largeToolName: `mcp__${serverId}__fixture_large_text`,
  });
}
