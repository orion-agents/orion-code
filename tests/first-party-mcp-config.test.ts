import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  FirstPartyMcpConfigurationError,
  loadFirstPartyMcpConfigurationV1,
} from '../src/runtime/mcp';

describe('first-party MCP config loader', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-mcp-config-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('treats an absent file as an empty dormant catalog', () => {
    expect(loadFirstPartyMcpConfigurationV1(join(root, 'missing.json'))).toEqual({});
  });

  test('parses a legacy-compatible envelope without starting or expanding anything', () => {
    const path = join(root, 'mcp.json');
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          github: {
            command: '${MCP_COMMAND}',
            args: ['serve'],
            env: { TOKEN: '${MCP_TOKEN}' },
            tags: ['code'],
          },
        },
      })
    );

    expect(loadFirstPartyMcpConfigurationV1(path)).toEqual({
      mcpServers: {
        github: {
          command: '${MCP_COMMAND}',
          args: ['serve'],
          env: { TOKEN: '${MCP_TOKEN}' },
          tags: ['code'],
        },
      },
    });
  });

  test('fails closed with a sanitized typed error for malformed content', () => {
    const path = join(root, 'mcp.json');
    writeFileSync(path, JSON.stringify({ mcpServers: { broken: { args: 'not-an-array' } } }));

    expect(() => loadFirstPartyMcpConfigurationV1(path)).toThrow(
      expect.objectContaining<Partial<FirstPartyMcpConfigurationError>>({
        code: 'ORION_MCP_CONFIG_INVALID_FIELD',
        configPath: path,
      })
    );
  });

  test('rejects non-regular and oversized config files', () => {
    const directory = join(root, 'mcp.json');
    mkdirSync(directory);
    expect(() => loadFirstPartyMcpConfigurationV1(directory)).toThrow(
      expect.objectContaining({ code: 'ORION_MCP_CONFIG_INVALID_FILE' })
    );
  });
});
