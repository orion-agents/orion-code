import {
  LazyMcpRuntime,
  McpServerDrainingError,
  StaleMcpActivationError,
  StaleMcpCatalogError,
  type McpConnectionV1,
  type McpConnectorV1,
  type McpListedToolV1,
  type McpServerDescriptorInputV1,
  type McpServerDescriptorV1,
} from '../src/runtime/mcp';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function server(id: string, configDigest = `config:${id}:1`): McpServerDescriptorInputV1 {
  return {
    id,
    name: id,
    description: `${id} test server`,
    transport: 'stdio',
    configDigest,
  };
}

const DEFAULT_TOOLS: readonly McpListedToolV1[] = [
  {
    name: 'search',
    description: 'Search the fixture corpus',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query'],
    },
  },
];

class FakeConnection implements McpConnectionV1 {
  closed?: Promise<unknown>;
  listCalls = 0;
  callCalls = 0;
  closeCalls = 0;
  closeReasons: string[] = [];
  listGate?: Promise<void>;
  callGate?: Promise<void>;

  constructor(readonly tools: readonly McpListedToolV1[] = DEFAULT_TOOLS) {}

  async listTools(_signal: AbortSignal): Promise<readonly McpListedToolV1[]> {
    this.listCalls++;
    await this.listGate;
    return this.tools;
  }

  async callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    _signal: AbortSignal
  ): Promise<unknown> {
    this.callCalls++;
    await this.callGate;
    return { name, args, source: 'fake-mcp' };
  }

  async close(reason: string): Promise<void> {
    this.closeCalls++;
    this.closeReasons.push(reason);
  }
}

class FakeConnector implements McpConnectorV1 {
  connectCalls = 0;
  processesSpawned = 0;
  socketsOpened = 0;
  failuresRemaining = 0;
  readonly connections: FakeConnection[] = [];
  readonly connectionFactory: (descriptor: McpServerDescriptorV1) => FakeConnection;

  constructor(
    connectionFactory: (descriptor: McpServerDescriptorV1) => FakeConnection = () =>
      new FakeConnection()
  ) {
    this.connectionFactory = connectionFactory;
  }

  async connect(descriptor: McpServerDescriptorV1, _signal: AbortSignal): Promise<McpConnectionV1> {
    this.connectCalls++;
    if (this.failuresRemaining > 0) {
      this.failuresRemaining--;
      throw new Error(`fixture connect failed: ${descriptor.id}`);
    }
    this.processesSpawned++;
    const connection = this.connectionFactory(descriptor);
    this.connections.push(connection);
    return connection;
  }
}

async function flushAsync(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index++) await Promise.resolve();
}

describe('Lazy MCP Runtime v1', () => {
  test('five startup descriptors perform zero connect, process, socket, or tools/list work', () => {
    const connector = new FakeConnector();
    const runtime = new LazyMcpRuntime({
      descriptors: Array.from({ length: 5 }, (_, index) => server(`server-${index}`)),
      connector,
    });

    expect(runtime.getCatalog().descriptors).toHaveLength(5);
    expect(runtime.snapshot().servers.map(item => item.state)).toEqual([
      'dormant',
      'dormant',
      'dormant',
      'dormant',
      'dormant',
    ]);
    expect(connector.connectCalls).toBe(0);
    expect(connector.processesSpawned).toBe(0);
    expect(connector.socketsOpened).toBe(0);
    expect(connector.connections).toHaveLength(0);
  });

  test('explicit selection connects only one server and exposes owner-scoped Step bindings', async () => {
    const connector = new FakeConnector();
    const runtime = new LazyMcpRuntime({
      descriptors: [server('docs'), server('browser'), server('database')],
      connector,
    });
    const catalog = runtime.getCatalog();

    const lease = await runtime.acquire({
      catalog,
      serverId: 'docs',
      ownerId: 'turn:one',
      reason: 'explicit',
    });

    expect(connector.connectCalls).toBe(1);
    expect(connector.processesSpawned).toBe(1);
    expect(connector.connections[0].listCalls).toBe(1);
    expect(runtime.snapshot().servers.find(item => item.serverId === 'docs')).toMatchObject({
      state: 'connected',
      leaseOwners: ['turn:one'],
      activeLeaseCount: 1,
      toolCount: 1,
    });
    expect(runtime.snapshot().servers.find(item => item.serverId === 'browser')?.state).toBe(
      'dormant'
    );

    const binding = runtime.bindingSnapshotForOwner('turn:one');
    expect(binding.step.catalogDigest).toBe(catalog.digest);
    expect(binding.step.selected).toEqual([
      {
        serverId: 'docs',
        toolName: 'mcp__docs__search',
        bindingDigest: lease.binding.tools[0].bindingDigest,
      },
    ]);
    const [tool] = runtime.toolBindingsForOwner('turn:one');
    await expect(tool.invoke({ query: 'orion' })).resolves.toEqual({
      name: 'search',
      args: { query: 'orion' },
      source: 'fake-mcp',
    });
    expect(runtime.bindingSnapshotForOwner('another-owner').step.selected).toEqual([]);

    await lease.release();
    await expect(tool.invoke({ query: 'released owner' })).rejects.toThrow(
      'has no active MCP lease'
    );
    await runtime.dispose();
  });

  test('an unchanged warm server is rebound to a new catalog without reconnecting', async () => {
    const connector = new FakeConnector();
    const runtime = new LazyMcpRuntime({ descriptors: [server('docs')], connector });
    const oldCatalog = runtime.getCatalog();
    const oldLease = await runtime.acquire({
      catalog: oldCatalog,
      serverId: 'docs',
      ownerId: 'turn:old-catalog',
      reason: 'explicit',
    });

    const nextCatalog = runtime.replaceDescriptors([server('docs'), server('browser')]);
    const nextLease = await runtime.acquire({
      catalog: nextCatalog,
      serverId: 'docs',
      ownerId: 'turn:new-catalog',
      reason: 'capability',
    });

    expect(connector.connectCalls).toBe(1);
    expect(connector.connections[0].listCalls).toBe(1);
    expect(oldLease.binding.catalogDigest).toBe(oldCatalog.digest);
    expect(nextLease.binding.catalogDigest).toBe(nextCatalog.digest);
    expect(runtime.bindingSnapshotForOwner('turn:old-catalog').step.catalogDigest).toBe(
      oldCatalog.digest
    );
    expect(runtime.bindingSnapshotForOwner('turn:new-catalog').step.catalogDigest).toBe(
      nextCatalog.digest
    );

    await oldLease.release();
    await nextLease.release();
    await runtime.dispose();
  });

  test('concurrent Capability selection is single-flight and one caller abort does not cancel peers', async () => {
    const gate = deferred<void>();
    const connector = new FakeConnector(() => {
      const connection = new FakeConnection();
      connection.listGate = gate.promise;
      return connection;
    });
    const runtime = new LazyMcpRuntime({ descriptors: [server('docs')], connector });
    const catalog = runtime.getCatalog();
    const cancelled = new AbortController();

    const first = runtime.acquire({
      catalog,
      serverId: 'docs',
      ownerId: 'turn:cancelled',
      reason: 'capability',
      signal: cancelled.signal,
    });
    const second = runtime.acquire({
      catalog,
      serverId: 'docs',
      ownerId: 'turn:kept',
      reason: 'capability',
    });
    await flushAsync();
    expect(connector.connectCalls).toBe(1);
    expect(connector.connections[0].listCalls).toBe(1);
    expect(runtime.snapshot().servers[0]).toMatchObject({
      state: 'activating',
      pendingAcquireCount: 2,
    });

    const cancelledExpectation = expect(first).rejects.toThrow('caller cancelled');
    cancelled.abort(new Error('caller cancelled'));
    await cancelledExpectation;
    gate.resolve(undefined);
    const lease = await second;

    expect(connector.connectCalls).toBe(1);
    expect(connector.connections[0].listCalls).toBe(1);
    expect(runtime.bindingSnapshotForOwner('turn:cancelled').step.selected).toEqual([]);
    expect(runtime.bindingSnapshotForOwner('turn:kept').step.selected).toHaveLength(1);

    await lease.release();
    await runtime.dispose();
  });

  test('last release removes ghost tools immediately and idle deadline tears down transport', async () => {
    jest.useFakeTimers();
    const connector = new FakeConnector();
    const runtime = new LazyMcpRuntime({
      descriptors: [server('docs')],
      connector,
      idleTimeoutMs: 25,
    });
    try {
      const lease = await runtime.acquire({
        catalog: runtime.getCatalog(),
        serverId: 'docs',
        ownerId: 'turn:one',
        reason: 'explicit',
      });
      await lease.release();

      expect(runtime.bindingSnapshotForOwner('turn:one').step.selected).toEqual([]);
      expect(runtime.toolBindingsForOwner('turn:one')).toEqual([]);
      expect(runtime.snapshot().servers[0].state).toBe('idle');
      expect(connector.connections[0].closeCalls).toBe(0);

      jest.advanceTimersByTime(25);
      await flushAsync();
      expect(connector.connections[0].closeCalls).toBe(1);
      expect(connector.connections[0].closeReasons).toEqual(['idle_timeout']);
      expect(runtime.snapshot().servers[0]).toMatchObject({ state: 'dormant', toolCount: 0 });
    } finally {
      await runtime.dispose();
      jest.useRealTimers();
    }
  });

  test('a delayed tool result is discarded when its owner lease is released', async () => {
    const callGate = deferred<void>();
    const connector = new FakeConnector(() => {
      const connection = new FakeConnection();
      connection.callGate = callGate.promise;
      return connection;
    });
    const runtime = new LazyMcpRuntime({ descriptors: [server('docs')], connector });
    const lease = await runtime.acquire({
      catalog: runtime.getCatalog(),
      serverId: 'docs',
      ownerId: 'turn:one',
      reason: 'explicit',
    });
    const tool = runtime.toolBindingsForOwner('turn:one')[0];
    const invocation = tool.invoke({ query: 'late result' });
    const staleExpectation = expect(invocation).rejects.toThrow('was discarded');
    await flushAsync();
    expect(runtime.snapshot().servers[0].activeCallCount).toBe(1);

    await lease.release();
    expect(runtime.bindingSnapshotForOwner('turn:one').step.selected).toEqual([]);
    callGate.resolve(undefined);
    await staleExpectation;
    expect(runtime.snapshot().servers[0].activeCallCount).toBe(0);

    await runtime.dispose();
  });

  test('descriptor invalidation discards a delayed stale tools/list result', async () => {
    const firstList = deferred<void>();
    let connectionNumber = 0;
    const connector = new FakeConnector(() => {
      const connection = new FakeConnection();
      if (connectionNumber++ === 0) connection.listGate = firstList.promise;
      return connection;
    });
    const runtime = new LazyMcpRuntime({ descriptors: [server('docs')], connector });
    const oldCatalog = runtime.getCatalog();
    const acquisition = runtime.acquire({
      catalog: oldCatalog,
      serverId: 'docs',
      ownerId: 'turn:old',
      reason: 'capability',
    });
    const staleExpectation = expect(acquisition).rejects.toBeInstanceOf(StaleMcpActivationError);
    await flushAsync();
    expect(connector.connections[0].listCalls).toBe(1);

    const nextCatalog = runtime.replaceDescriptors([server('docs', 'config:docs:2')]);
    expect(runtime.snapshot().servers[0].state).toBe('draining');
    firstList.resolve(undefined);
    await staleExpectation;
    await flushAsync();

    expect(connector.connections[0].closeCalls).toBe(1);
    expect(runtime.bindingSnapshotForOwner('turn:old').step.selected).toEqual([]);
    expect(runtime.snapshot().servers[0]).toMatchObject({ state: 'dormant', toolCount: 0 });
    await expect(
      runtime.acquire({
        catalog: oldCatalog,
        serverId: 'docs',
        ownerId: 'turn:stale-catalog',
        reason: 'explicit',
      })
    ).rejects.toBeInstanceOf(StaleMcpCatalogError);

    const fresh = await runtime.acquire({
      catalog: nextCatalog,
      serverId: 'docs',
      ownerId: 'turn:fresh',
      reason: 'explicit',
    });
    expect(connector.connectCalls).toBe(2);
    await fresh.release();
    await runtime.dispose();
  });

  test('changed server drains old owner, rejects new leases, then reconnects without ghost tools', async () => {
    const connector = new FakeConnector();
    const runtime = new LazyMcpRuntime({ descriptors: [server('docs')], connector });
    const oldLease = await runtime.acquire({
      catalog: runtime.getCatalog(),
      serverId: 'docs',
      ownerId: 'turn:old',
      reason: 'explicit',
    });
    const nextCatalog = runtime.replaceDescriptors([server('docs', 'config:docs:2')]);

    expect(runtime.snapshot().servers[0]).toMatchObject({
      state: 'draining',
      leaseOwners: ['turn:old'],
    });
    expect(runtime.bindingSnapshotForOwner('turn:old').step.selected).toHaveLength(1);
    await expect(
      runtime.acquire({
        catalog: nextCatalog,
        serverId: 'docs',
        ownerId: 'turn:new',
        reason: 'capability',
      })
    ).rejects.toBeInstanceOf(McpServerDrainingError);
    await expect(
      runtime.toolBindingsForOwner('turn:old')[0].invoke({ query: 'pinned step' })
    ).resolves.toMatchObject({ name: 'search' });

    await oldLease.release();
    expect(runtime.bindingSnapshotForOwner('turn:old').step.selected).toEqual([]);
    await flushAsync();
    expect(connector.connections[0].closeCalls).toBe(1);
    expect(runtime.snapshot().servers[0].state).toBe('dormant');

    const freshLease = await runtime.acquire({
      catalog: nextCatalog,
      serverId: 'docs',
      ownerId: 'turn:new',
      reason: 'capability',
    });
    expect(connector.connectCalls).toBe(2);
    expect(freshLease.binding.serverDigest).not.toBe(oldLease.binding.serverDigest);
    await freshLease.release();
    await runtime.dispose();
  });

  test('failed activation exposes failed state and a later selection retries cleanly', async () => {
    const connector = new FakeConnector();
    connector.failuresRemaining = 1;
    const runtime = new LazyMcpRuntime({ descriptors: [server('docs')], connector });
    const request = {
      catalog: runtime.getCatalog(),
      serverId: 'docs',
      ownerId: 'turn:retry',
      reason: 'explicit' as const,
    };

    await expect(runtime.acquire(request)).rejects.toThrow('fixture connect failed: docs');
    expect(runtime.snapshot().servers[0]).toMatchObject({
      state: 'failed',
      toolCount: 0,
    });
    const lease = await runtime.acquire(request);
    expect(connector.connectCalls).toBe(2);
    expect(runtime.snapshot().servers[0].state).toBe('connected');

    await lease.release();
    await runtime.dispose();
  });

  test('one server crash invalidates only its owners and leaves peer bindings connected', async () => {
    const docsClosed = deferred<unknown>();
    let docsConnections = 0;
    const connector = new FakeConnector(descriptor => {
      const connection = new FakeConnection();
      if (descriptor.id === 'docs' && docsConnections++ === 0) {
        connection.closed = docsClosed.promise;
      }
      return connection;
    });
    const runtime = new LazyMcpRuntime({
      descriptors: [server('docs'), server('browser')],
      connector,
    });
    const catalog = runtime.getCatalog();
    const docsLease = await runtime.acquire({
      catalog,
      serverId: 'docs',
      ownerId: 'turn:docs',
      reason: 'explicit',
    });
    const browserLease = await runtime.acquire({
      catalog,
      serverId: 'browser',
      ownerId: 'turn:browser',
      reason: 'capability',
    });

    docsClosed.resolve(new Error('fixture process exited'));
    await flushAsync();
    expect(runtime.snapshot().servers.find(item => item.serverId === 'docs')).toMatchObject({
      state: 'failed',
      activeLeaseCount: 0,
      toolCount: 0,
      failure: 'connection closed: fixture process exited',
    });
    expect(runtime.bindingSnapshotForOwner('turn:docs').step.selected).toEqual([]);
    expect(runtime.snapshot().servers.find(item => item.serverId === 'browser')).toMatchObject({
      state: 'connected',
      activeLeaseCount: 1,
      toolCount: 1,
    });
    expect(runtime.bindingSnapshotForOwner('turn:browser').step.selected).toHaveLength(1);

    const recoveredDocsLease = await runtime.acquire({
      catalog,
      serverId: 'docs',
      ownerId: 'turn:docs-retry',
      reason: 'explicit',
    });
    expect(connector.connectCalls).toBe(3);
    expect(runtime.snapshot().servers.find(item => item.serverId === 'docs')?.state).toBe(
      'connected'
    );

    await docsLease.release();
    await browserLease.release();
    await recoveredDocsLease.release();
    await runtime.dispose();
  });
});
