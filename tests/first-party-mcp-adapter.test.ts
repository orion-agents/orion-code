import {
  createFirstPartyMcpAdapterV1,
  FirstPartyMcpAdapterError,
  LazyMcpRuntime,
  type FirstPartyMcpStdioConnectInputV1,
  type FirstPartyMcpStdioFactoryV1,
  type McpConnectionV1,
  type McpListedToolV1,
} from '../src/runtime/mcp';

const TOOLS: readonly McpListedToolV1[] = [
  {
    name: 'echo',
    description: 'Echo one value',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
];

class FakeConnection implements McpConnectionV1 {
  listCalls = 0;
  callCalls = 0;
  closeCalls = 0;
  lastCall?: { readonly name: string; readonly args: Readonly<Record<string, unknown>> };

  async listTools(_signal: AbortSignal): Promise<readonly McpListedToolV1[]> {
    this.listCalls++;
    return TOOLS;
  }

  async callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    _signal: AbortSignal
  ): Promise<unknown> {
    this.callCalls++;
    this.lastCall = { name, args };
    return { server: 'fake', name, args };
  }

  async close(_reason: string): Promise<void> {
    this.closeCalls++;
  }
}

class FakeStdioFactory implements FirstPartyMcpStdioFactoryV1 {
  readonly inputs: FirstPartyMcpStdioConnectInputV1[] = [];
  readonly connections: FakeConnection[] = [];

  async connect(
    input: FirstPartyMcpStdioConnectInputV1,
    _signal: AbortSignal
  ): Promise<McpConnectionV1> {
    this.inputs.push(input);
    const connection = new FakeConnection();
    this.connections.push(connection);
    return connection;
  }
}

const REAL_MCP_SERVER = String.raw`
const readline = require('readline');
const input = readline.createInterface({ input: process.stdin });
function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
input.on('line', line => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (!message.id) return;
  if (message.method === 'initialize') {
    respond(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'adapter-fixture', version: '1.0.0' }
    });
    return;
  }
  if (message.method === 'tools/list') {
    respond(message.id, { tools: [{
      name: 'echo',
      description: 'Echo one value',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
      }
    }] });
    return;
  }
  if (message.method === 'tools/call') {
    if (process.env.CRASH_ON_CALL === '1') process.exit(23);
    respond(message.id, {
      content: [{
        type: 'text',
        text: [
          message.params.arguments.text,
          process.env.EXPLICIT_SECRET || 'missing',
          process.env.PARENT_ONLY_SECRET || 'not-inherited'
        ].join(':')
      }]
    });
  }
});
`;

async function flushAsync(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index++) await Promise.resolve();
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for MCP lifecycle state.');
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
  }
}

describe('First-party Lazy MCP adapter v1', () => {
  test('compiles only enabled descriptors and startup/status perform zero transport work', async () => {
    const factory = new FakeStdioFactory();
    const adapter = createFirstPartyMcpAdapterV1({
      config: {
        mcpServers: {
          zeta: { command: 'zeta-server' },
          alpha: {
            command: '${MCP_BIN}',
            args: ['--token', '${MCP_TOKEN}'],
            env: { SERVICE_TOKEN: '${MCP_TOKEN}' },
            description: 'Alpha fixture',
            tags: ['search', 'docs'],
          },
          beta: { command: 'beta-server' },
          gamma: { command: 'gamma-server' },
          delta: { command: 'delta-server' },
          disabled: { command: 'never-start', disabled: true },
        },
      },
      environment: {
        MCP_BIN: 'alpha-server',
        MCP_TOKEN: 'super-secret-value',
      },
      stdioFactory: factory,
    });
    const runtime = new LazyMcpRuntime({
      descriptors: adapter.descriptors,
      connector: adapter.connector,
      idleTimeoutMs: 0,
    });

    expect(adapter.descriptors.map(item => item.id)).toEqual([
      'alpha',
      'beta',
      'delta',
      'gamma',
      'zeta',
    ]);
    expect(runtime.snapshot().servers.map(item => item.state)).toEqual([
      'dormant',
      'dormant',
      'dormant',
      'dormant',
      'dormant',
    ]);
    expect(factory.inputs).toHaveLength(0);
    expect(JSON.stringify(adapter.descriptors)).not.toContain('super-secret-value');
    expect(JSON.stringify(runtime.getCatalog())).not.toContain('super-secret-value');

    const lease = await runtime.acquire({
      catalog: runtime.getCatalog(),
      serverId: 'alpha',
      ownerId: 'turn:adapter',
      reason: 'explicit',
    });
    expect(factory.inputs).toHaveLength(1);
    expect(factory.inputs[0]).toMatchObject({
      serverId: 'alpha',
      command: 'alpha-server',
      args: ['--token', 'super-secret-value'],
      env: { SERVICE_TOKEN: 'super-secret-value' },
    });
    expect(factory.connections[0].listCalls).toBe(1);
    expect(runtime.snapshot().servers.find(item => item.serverId === 'beta')?.state).toBe(
      'dormant'
    );

    const [tool] = runtime.toolBindingsForOwner('turn:adapter');
    await expect(tool.invoke({ text: 'hello' })).resolves.toEqual({
      server: 'fake',
      name: 'echo',
      args: { text: 'hello' },
    });
    expect(factory.connections[0].lastCall).toEqual({ name: 'echo', args: { text: 'hello' } });

    await lease.release();
    await flushAsync();
    expect(factory.connections[0].closeCalls).toBe(1);
    await runtime.dispose();
  });

  test('config and tool binding digests are stable while stale/unsupported descriptors fail closed', async () => {
    const firstFactory = new FakeStdioFactory();
    const secondFactory = new FakeStdioFactory();
    const firstAdapter = createFirstPartyMcpAdapterV1({
      config: {
        orion: {
          mcp: {
            servers: {
              docs: {
                command: 'docs-server',
                args: ['--mode', 'read'],
                env: { ZETA: 'z', ALPHA: 'a' },
              },
            },
          },
        },
      },
      stdioFactory: firstFactory,
    });
    const secondAdapter = createFirstPartyMcpAdapterV1({
      config: {
        mcpServers: {
          docs: {
            env: { ALPHA: 'a', ZETA: 'z' },
            args: ['--mode', 'read'],
            command: 'docs-server',
          },
        },
      },
      stdioFactory: secondFactory,
    });
    expect(firstAdapter.descriptors).toEqual(secondAdapter.descriptors);

    const firstRuntime = new LazyMcpRuntime({
      descriptors: firstAdapter.descriptors,
      connector: firstAdapter.connector,
    });
    const secondRuntime = new LazyMcpRuntime({
      descriptors: secondAdapter.descriptors,
      connector: secondAdapter.connector,
    });
    const firstLease = await firstRuntime.acquire({
      catalog: firstRuntime.getCatalog(),
      serverId: 'docs',
      ownerId: 'turn:first',
      reason: 'capability',
    });
    const secondLease = await secondRuntime.acquire({
      catalog: secondRuntime.getCatalog(),
      serverId: 'docs',
      ownerId: 'turn:second',
      reason: 'capability',
    });
    expect(firstLease.binding.tools[0].bindingDigest).toBe(
      secondLease.binding.tools[0].bindingDigest
    );

    const unsupportedFactory = new FakeStdioFactory();
    const unsupportedAdapter = createFirstPartyMcpAdapterV1({
      config: { servers: { remote: { type: 'http', url: 'https://example.invalid/mcp' } } },
      stdioFactory: unsupportedFactory,
    });
    const unsupportedRuntime = new LazyMcpRuntime({
      descriptors: unsupportedAdapter.descriptors,
      connector: unsupportedAdapter.connector,
    });
    await expect(
      unsupportedRuntime.acquire({
        catalog: unsupportedRuntime.getCatalog(),
        serverId: 'remote',
        ownerId: 'turn:remote',
        reason: 'explicit',
      })
    ).rejects.toMatchObject({ code: 'ORION_MCP_UNSUPPORTED_TRANSPORT' });
    expect(unsupportedFactory.inputs).toHaveLength(0);

    const controller = new AbortController();
    controller.abort(new Error('selection cancelled'));
    await expect(
      firstAdapter.connector.connect(firstRuntime.getCatalog().descriptors[0], controller.signal)
    ).rejects.toThrow('selection cancelled');
    expect(firstFactory.inputs).toHaveLength(1);

    await firstLease.release();
    await secondLease.release();
    await firstRuntime.dispose();
    await secondRuntime.dispose();
    await unsupportedRuntime.dispose();
  });

  test('default stdio factory initializes, lists, calls, filters parent env, and tears down idle', async () => {
    const adapter = createFirstPartyMcpAdapterV1({
      config: {
        mcpServers: {
          live: {
            command: process.execPath,
            args: ['-e', REAL_MCP_SERVER],
            env: { EXPLICIT_SECRET: '${CONFIGURED_SECRET}' },
          },
        },
      },
      environment: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CONFIGURED_SECRET: 'allowed-for-server',
        PARENT_ONLY_SECRET: 'must-not-leak',
      },
      requestTimeoutMs: 2_000,
      closeGraceMs: 200,
    });
    const runtime = new LazyMcpRuntime({
      descriptors: adapter.descriptors,
      connector: adapter.connector,
      idleTimeoutMs: 0,
    });
    expect(runtime.snapshot().servers[0].state).toBe('dormant');

    const lease = await runtime.acquire({
      catalog: runtime.getCatalog(),
      serverId: 'live',
      ownerId: 'turn:live',
      reason: 'explicit',
    });
    expect(lease.binding.tools.map(tool => tool.qualifiedName)).toEqual(['mcp__live__echo']);
    await expect(
      runtime.toolBindingsForOwner('turn:live')[0].invoke({ text: 'hello' })
    ).resolves.toEqual({
      content: [{ type: 'text', text: 'hello:allowed-for-server:not-inherited' }],
    });

    await lease.release();
    await waitFor(() => runtime.snapshot().servers[0].state === 'dormant');
    await runtime.dispose();
  });

  test('one stdio process crash fails only that server and leaves other descriptors usable', async () => {
    const adapter = createFirstPartyMcpAdapterV1({
      config: {
        mcpServers: {
          crash: {
            command: process.execPath,
            args: ['-e', REAL_MCP_SERVER],
            env: { CRASH_ON_CALL: '1' },
          },
          healthy: { command: process.execPath, args: ['-e', REAL_MCP_SERVER] },
        },
      },
      requestTimeoutMs: 2_000,
      closeGraceMs: 200,
    });
    const runtime = new LazyMcpRuntime({
      descriptors: adapter.descriptors,
      connector: adapter.connector,
    });
    const crashLease = await runtime.acquire({
      catalog: runtime.getCatalog(),
      serverId: 'crash',
      ownerId: 'turn:crash',
      reason: 'capability',
    });

    await expect(
      runtime.toolBindingsForOwner('turn:crash')[0].invoke({ text: 'boom' })
    ).rejects.toThrow(/closed|transport|terminated/);
    await waitFor(
      () =>
        runtime.snapshot().servers.find(server => server.serverId === 'crash')?.state === 'failed'
    );
    expect(runtime.snapshot().servers.find(server => server.serverId === 'healthy')?.state).toBe(
      'dormant'
    );

    const healthyLease = await runtime.acquire({
      catalog: runtime.getCatalog(),
      serverId: 'healthy',
      ownerId: 'turn:healthy',
      reason: 'explicit',
    });
    await expect(
      runtime.toolBindingsForOwner('turn:healthy')[0].invoke({ text: 'still-alive' })
    ).resolves.toEqual({
      content: [{ type: 'text', text: 'still-alive:missing:not-inherited' }],
    });

    await crashLease.release();
    await healthyLease.release();
    await runtime.dispose();
  });

  test('rejects ambiguous envelopes and enabled stdio entries without commands', () => {
    expect(() =>
      createFirstPartyMcpAdapterV1({
        config: { mcpServers: {}, servers: {} },
      })
    ).toThrow(FirstPartyMcpAdapterError);
    expect(() =>
      createFirstPartyMcpAdapterV1({
        config: { mcpServers: { invalid: {} } },
      })
    ).toThrow('requires a command');
  });
});
