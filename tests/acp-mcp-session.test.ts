import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createAcpMcpConfigurationV1 } from '../src/acp/product-runtime-port';
import { createFirstPartyMcpAdapterV1, LazyMcpRuntime } from '../src/runtime/mcp';

describe('ACP session-scoped stdio MCP', () => {
  test('preserves PATH-resolved bare stdio commands from Studio', () => {
    expect(
      createAcpMcpConfigurationV1([
        { name: 'studio-context', command: 'npx', args: ['-y', 'context-server'], env: [] },
      ])
    ).toEqual({
      mcpServers: {
        'acp-session-0001': {
          type: 'stdio',
          name: 'studio-context',
          command: 'npx',
          args: ['-y', 'context-server'],
          env: {},
        },
      },
    });
  });

  test('lists, calls, and closes the deterministic stdio fixture with the session runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-acp-mcp-session-'));
    const eventsPath = join(root, 'events.log');
    const fixturePath = join(__dirname, 'fixtures', 'acp-v1', 'stdio-mcp-server.mjs');
    const configuration = createAcpMcpConfigurationV1([
      {
        name: 'fixture',
        command: process.execPath,
        args: [fixturePath],
        env: [
          { name: 'ORION_ACP_MCP_FIXTURE_EVENTS', value: eventsPath },
          { name: 'FIXTURE_VALUE', value: 'session-value' },
        ],
      },
    ]);
    const adapter = createFirstPartyMcpAdapterV1({
      config: configuration,
      baseDirectory: root,
      requestTimeoutMs: 2_000,
      closeGraceMs: 500,
    });
    const runtime = new LazyMcpRuntime({
      descriptors: adapter.descriptors,
      connector: adapter.connector,
    });

    try {
      const catalog = runtime.getCatalog();
      expect(catalog.descriptors.map(descriptor => descriptor.id)).toEqual(['acp-session-0001']);
      await runtime.acquire({
        catalog,
        serverId: 'acp-session-0001',
        ownerId: 'acp-session:test',
        reason: 'explicit',
      });
      expect(
        runtime.toolBindingsForOwner('acp-session:test').map(tool => tool.descriptor.name)
      ).toEqual(['echo']);
      await expect(
        runtime.toolBindingsForOwner('acp-session:test')[0].invoke({ text: 'hello' })
      ).resolves.toEqual({
        content: [{ type: 'text', text: 'hello:session-value' }],
      });

      await runtime.dispose('ACP session closed');
      expect(readFileSync(eventsPath, 'utf8').trim().split('\n')).toEqual([
        'initialize',
        'initialized',
        'tools/list',
        'tools/call',
        'close',
      ]);
    } finally {
      await runtime.dispose('test cleanup');
      rmSync(root, { recursive: true, force: true });
    }
  });
});
