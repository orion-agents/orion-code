import { digestRuntimeValue } from '../protocol/canonical';
import type { McpBindingSnapshotV1 } from '../step-snapshot';
import {
  LAZY_MCP_RUNTIME_VERSION,
  type LazyMcpRuntimeOptions,
  type LazyMcpRuntimeSnapshotV1,
  type McpCatalogSnapshotV1,
  type McpConnectionV1,
  type McpLeaseRequestV1,
  type McpListedToolV1,
  type McpRuntimeBindingSnapshotV1,
  type McpRuntimeToolBindingV1,
  type McpSelectionReasonV1,
  type McpServerBindingSnapshotV1,
  type McpServerDescriptorInputV1,
  type McpServerDescriptorV1,
  type McpServerLeaseV1,
  type McpServerRuntimeSnapshotV1,
  type McpToolDescriptorV1,
  type McpTransportKindV1,
} from './types';

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_SERVERS = 64;
const DEFAULT_MAX_TOOLS_PER_SERVER = 256;
const MAX_DESCRIPTION_CHARS = 320;
const VALID_TRANSPORTS = new Set<McpTransportKindV1>([
  'stdio',
  'sse',
  'http',
  'streamable-http',
  'websocket',
]);

interface ActiveLease {
  readonly leaseId: string;
  readonly ownerId: string;
  readonly reason: McpSelectionReasonV1;
  readonly binding: McpServerBindingSnapshotV1;
}

interface ActivationToken {
  readonly generation: number;
  readonly descriptorDigest: string;
  readonly controller: AbortController;
}

interface ActivationFlight {
  readonly token: ActivationToken;
  readonly promise: Promise<McpServerBindingSnapshotV1>;
}

interface ServerRecord {
  descriptor?: McpServerDescriptorV1;
  generation: number;
  state: McpServerRuntimeSnapshotV1['state'];
  connection?: McpConnectionV1;
  binding?: McpServerBindingSnapshotV1;
  activation?: ActivationFlight;
  readonly leases: Map<string, ActiveLease>;
  pendingAcquires: number;
  activeCalls: number;
  idleTimer?: NodeJS.Timeout;
  drainReason?: string;
  drainPromise?: Promise<void>;
  failure?: string;
}

interface LinkedSignal {
  readonly signal: AbortSignal;
  dispose(): void;
}

export class LazyMcpRuntimeError extends Error {
  readonly code: string = 'ORION_LAZY_MCP_RUNTIME_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'LazyMcpRuntimeError';
  }
}

export class StaleMcpCatalogError extends LazyMcpRuntimeError {
  override readonly code = 'ORION_STALE_MCP_CATALOG';

  constructor(serverId?: string) {
    super(
      serverId
        ? `MCP catalog is stale for server ${serverId}; capture the descriptor catalog again.`
        : 'MCP catalog is stale; capture the descriptor catalog again.'
    );
    this.name = 'StaleMcpCatalogError';
  }
}

export class McpServerDrainingError extends LazyMcpRuntimeError {
  override readonly code = 'ORION_MCP_SERVER_DRAINING';

  constructor(serverId: string) {
    super(`MCP server ${serverId} is draining and cannot accept a new lease.`);
    this.name = 'McpServerDrainingError';
  }
}

export class StaleMcpActivationError extends LazyMcpRuntimeError {
  override readonly code = 'ORION_STALE_MCP_ACTIVATION';

  constructor(serverId: string) {
    super(`MCP server ${serverId} changed while connect/tools-list was in flight.`);
    this.name = 'StaleMcpActivationError';
  }
}

export class McpToolBindingUnavailableError extends LazyMcpRuntimeError {
  override readonly code = 'ORION_MCP_TOOL_BINDING_UNAVAILABLE';

  constructor(ownerId: string, toolName: string) {
    super(`Owner ${ownerId} has no active MCP lease for tool ${toolName}.`);
    this.name = 'McpToolBindingUnavailableError';
  }
}

export class StaleMcpToolResultError extends LazyMcpRuntimeError {
  override readonly code = 'ORION_STALE_MCP_TOOL_RESULT';

  constructor(toolName: string) {
    super(`MCP tool result for ${toolName} was discarded after its owner binding changed.`);
    this.name = 'StaleMcpToolResultError';
  }
}

/**
 * Descriptor-first, owner-leased MCP lifecycle.
 *
 * The constructor performs only deterministic descriptor normalization. The
 * injected connector is not touched until acquire() selects one exact server.
 */
export class LazyMcpRuntime {
  readonly version = LAZY_MCP_RUNTIME_VERSION;

  private readonly connector: LazyMcpRuntimeOptions['connector'];
  private readonly idleTimeoutMs: number;
  private readonly maxServers: number;
  private readonly maxToolsPerServer: number;
  private readonly lifecycleController = new AbortController();
  private readonly records = new Map<string, ServerRecord>();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly detachParentSignal?: () => void;
  private catalogValue: McpCatalogSnapshotV1;
  private leaseSequence = 0;
  private disposed = false;
  private disposeFlight?: Promise<void>;

  constructor(options: LazyMcpRuntimeOptions) {
    this.connector = options.connector;
    this.idleTimeoutMs = validateBoundedInteger(
      options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      'MCP idle timeout',
      0
    );
    this.maxServers = validateBoundedInteger(
      options.maxServers ?? DEFAULT_MAX_SERVERS,
      'MCP server limit',
      1
    );
    this.maxToolsPerServer = validateBoundedInteger(
      options.maxToolsPerServer ?? DEFAULT_MAX_TOOLS_PER_SERVER,
      'MCP per-server tool limit',
      1
    );
    this.catalogValue = composeCatalog(options.descriptors, this.maxServers);
    for (const descriptor of this.catalogValue.descriptors) {
      this.records.set(descriptor.id, createRecord(descriptor));
    }

    if (options.signal) {
      const abortFromParent = (): void => {
        void this.dispose(options.signal?.reason).catch(() => undefined);
      };
      options.signal.addEventListener('abort', abortFromParent, { once: true });
      this.detachParentSignal = () => options.signal?.removeEventListener('abort', abortFromParent);
      if (options.signal.aborted) abortFromParent();
    }
  }

  /** Safe, immutable server descriptors; this call performs no IO. */
  getCatalog(): McpCatalogSnapshotV1 {
    return this.catalogValue;
  }

  /**
   * Replace descriptor metadata and invalidate changed generations. Existing
   * owners retain their frozen binding until release; new owners are rejected
   * while the old transport drains.
   */
  replaceDescriptors(descriptors: readonly McpServerDescriptorInputV1[]): McpCatalogSnapshotV1 {
    this.assertActive();
    const nextCatalog = composeCatalog(descriptors, this.maxServers);
    const nextById = new Map(
      nextCatalog.descriptors.map(descriptor => [descriptor.id, descriptor])
    );
    this.catalogValue = nextCatalog;

    for (const [serverId, record] of this.records) {
      const next = nextById.get(serverId);
      nextById.delete(serverId);
      if (next && record.descriptor?.digest === next.digest) {
        record.descriptor = next;
        continue;
      }
      record.descriptor = next;
      this.requestDrain(record, next ? 'descriptor_changed' : 'descriptor_removed');
    }
    for (const descriptor of nextById.values()) {
      this.records.set(descriptor.id, createRecord(descriptor));
    }
    return this.catalogValue;
  }

  /** Explicit or Capability-Compiler selection activates exactly one server. */
  async acquire(request: McpLeaseRequestV1): Promise<McpServerLeaseV1> {
    this.assertActive();
    const ownerId = validateIdentifier(request.ownerId, 'MCP lease owner id');
    const serverId = validateIdentifier(request.serverId, 'MCP server id');
    validateSelectionReason(request.reason);
    const descriptor = this.assertCatalogCurrent(request.catalog, serverId);
    if (descriptor.disabled) {
      throw new LazyMcpRuntimeError(`MCP server ${serverId} is disabled.`);
    }
    this.assertOwnerCatalog(ownerId, request.catalog.digest);

    const record = this.records.get(serverId);
    if (!record || !record.descriptor) {
      throw new LazyMcpRuntimeError(`Unknown MCP server: ${serverId}`);
    }
    if (record.state === 'draining' || record.drainReason) {
      throw new McpServerDrainingError(serverId);
    }

    record.pendingAcquires++;
    this.clearIdleTimer(record);
    try {
      const binding = await waitForPromise(
        this.ensureActivated(record, descriptor),
        request.signal
      );
      throwIfAborted(request.signal);
      this.assertActive();
      this.assertCatalogCurrent(request.catalog, serverId);
      if (record.drainReason || record.binding?.bindingDigest !== binding.bindingDigest) {
        throw new StaleMcpActivationError(serverId);
      }

      const leaseId = `mcp-lease:${serverId}:${++this.leaseSequence}`;
      const active: ActiveLease = {
        leaseId,
        ownerId,
        reason: request.reason,
        binding,
      };
      record.leases.set(leaseId, active);
      record.state = 'connected';
      record.failure = undefined;
      let released = false;
      return Object.freeze({
        version: LAZY_MCP_RUNTIME_VERSION,
        leaseId,
        ownerId,
        serverId,
        reason: request.reason,
        binding,
        release: async (): Promise<void> => {
          if (released) return;
          released = true;
          this.releaseLease(serverId, leaseId);
        },
      });
    } finally {
      record.pendingAcquires--;
      this.settleRecord(record);
    }
  }

  /** Release every lease owned by a turn, step, or sub-agent scope. */
  async releaseOwner(ownerId: string): Promise<void> {
    const normalized = validateIdentifier(ownerId, 'MCP lease owner id');
    for (const [serverId, record] of this.records) {
      for (const lease of [...record.leases.values()]) {
        if (lease.ownerId === normalized) this.releaseLease(serverId, lease.leaseId);
      }
    }
  }

  /**
   * Serializable binding pinned to the owner's leases. Once the owner releases
   * them, this becomes empty immediately even while a transport idles/drains.
   */
  bindingSnapshotForOwner(ownerId: string): McpRuntimeBindingSnapshotV1 {
    this.assertActive();
    const normalized = validateIdentifier(ownerId, 'MCP lease owner id');
    const byServer = this.ownerBindings(normalized);
    const servers = [...byServer.values()].sort((left, right) =>
      left.serverId.localeCompare(right.serverId)
    );
    const catalogDigest =
      servers.length === 0 ? this.catalogValue.digest : servers[0].catalogDigest;
    if (servers.some(binding => binding.catalogDigest !== catalogDigest)) {
      throw new LazyMcpRuntimeError(`Owner ${normalized} has mixed MCP catalog generations.`);
    }
    const selected = servers
      .flatMap(binding =>
        binding.tools.map(tool => ({
          serverId: binding.serverId,
          toolName: tool.qualifiedName,
          bindingDigest: tool.bindingDigest,
        }))
      )
      .sort(
        (left, right) =>
          left.toolName.localeCompare(right.toolName) || left.serverId.localeCompare(right.serverId)
      );
    const stepBase = {
      version: LAZY_MCP_RUNTIME_VERSION,
      selected,
      catalogDigest,
    } as const;
    const step: McpBindingSnapshotV1 = deepFreeze({
      ...stepBase,
      digest: digestRuntimeValue(stepBase),
    });
    const base = {
      version: LAZY_MCP_RUNTIME_VERSION,
      ownerId: normalized,
      servers,
      step,
    } as const;
    return deepFreeze({ ...base, digest: digestRuntimeValue(base) });
  }

  /** Executable owner bindings for a Step factory; no global connected-tool view exists. */
  toolBindingsForOwner(ownerId: string): readonly McpRuntimeToolBindingV1[] {
    this.assertActive();
    const normalized = validateIdentifier(ownerId, 'MCP lease owner id');
    const descriptors = [...this.ownerBindings(normalized).values()]
      .flatMap(binding => binding.tools)
      .sort((left, right) => left.qualifiedName.localeCompare(right.qualifiedName));
    return Object.freeze(
      descriptors.map(descriptor =>
        Object.freeze({
          descriptor,
          invoke: (args: Readonly<Record<string, unknown>>, signal?: AbortSignal) =>
            this.invoke(normalized, descriptor.qualifiedName, args, signal),
        })
      )
    );
  }

  /** Execute only through an active owner lease. */
  async invoke(
    ownerId: string,
    qualifiedToolName: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal
  ): Promise<unknown> {
    this.assertActive();
    const normalizedOwner = validateIdentifier(ownerId, 'MCP lease owner id');
    const normalizedTool = validateIdentifier(qualifiedToolName, 'MCP qualified tool name');
    const selected = this.findOwnerTool(normalizedOwner, normalizedTool);
    if (!selected) throw new McpToolBindingUnavailableError(normalizedOwner, normalizedTool);
    const { record, binding, tool } = selected;
    const connection = record.connection;
    if (!connection) throw new McpToolBindingUnavailableError(normalizedOwner, normalizedTool);

    record.activeCalls++;
    this.clearIdleTimer(record);
    const linked = linkSignals(this.lifecycleController.signal, signal);
    const operation = (async (): Promise<unknown> => {
      throwIfAborted(linked.signal);
      const result = await connection.callTool(tool.name, args, linked.signal);
      throwIfAborted(linked.signal);
      if (
        record.connection !== connection ||
        !this.ownerHasBinding(record, normalizedOwner, binding.bindingDigest)
      ) {
        throw new StaleMcpToolResultError(normalizedTool);
      }
      return result;
    })();
    this.track(operation);
    try {
      return await operation;
    } finally {
      linked.dispose();
      record.activeCalls--;
      this.settleRecord(record);
    }
  }

  /** Begin a generation-safe explicit drain. Active lease owners finish first. */
  beginDrain(serverId: string, reason = 'explicit_drain'): void {
    this.assertActive();
    const normalized = validateIdentifier(serverId, 'MCP server id');
    const record = this.records.get(normalized);
    if (!record) throw new LazyMcpRuntimeError(`Unknown MCP server: ${normalized}`);
    this.requestDrain(record, validateIdentifier(reason, 'MCP drain reason'));
  }

  snapshot(): LazyMcpRuntimeSnapshotV1 {
    const servers = [...this.records.entries()]
      .map(([serverId, record]): McpServerRuntimeSnapshotV1 => {
        const leaseOwners = [
          ...new Set([...record.leases.values()].map(lease => lease.ownerId)),
        ].sort();
        return deepFreeze({
          serverId,
          ...(record.descriptor ? { descriptorDigest: record.descriptor.digest } : {}),
          generation: record.generation,
          state: record.state,
          leaseOwners,
          activeLeaseCount: record.leases.size,
          activeCallCount: record.activeCalls,
          pendingAcquireCount: record.pendingAcquires,
          toolCount: record.binding?.tools.length ?? 0,
          ...(record.binding ? { toolsDigest: record.binding.toolsDigest } : {}),
          ...(record.failure ? { failure: record.failure } : {}),
        });
      })
      .sort((left, right) => left.serverId.localeCompare(right.serverId));
    const base = {
      version: LAZY_MCP_RUNTIME_VERSION,
      catalog: this.catalogValue,
      servers,
    } as const;
    return deepFreeze({ ...base, digest: digestRuntimeValue(base) });
  }

  dispose(reason: unknown = new Error('Lazy MCP runtime disposed.')): Promise<void> {
    if (this.disposeFlight) return this.disposeFlight;
    const flight = this.performDispose(reason);
    this.disposeFlight = flight;
    return flight;
  }

  private async performDispose(reason: unknown): Promise<void> {
    this.disposed = true;
    this.detachParentSignal?.();
    if (!this.lifecycleController.signal.aborted) this.lifecycleController.abort(reason);

    for (const record of this.records.values()) {
      record.leases.clear();
      this.requestDrain(record, 'runtime_disposed');
    }
    await Promise.allSettled([...this.operations]);
    for (const record of this.records.values()) this.maybeStartDrain(record);
    await Promise.allSettled(
      [...this.records.values()]
        .map(record => record.drainPromise)
        .filter((promise): promise is Promise<void> => Boolean(promise))
    );
    for (const record of this.records.values()) this.clearIdleTimer(record);
    this.records.clear();
  }

  private ensureActivated(
    record: ServerRecord,
    descriptor: McpServerDescriptorV1
  ): Promise<McpServerBindingSnapshotV1> {
    if (
      record.connection &&
      record.binding &&
      record.binding.serverDigest === descriptor.digest &&
      !record.drainReason
    ) {
      if (record.binding.catalogDigest !== this.catalogValue.digest) {
        record.binding = rebindToCatalog(record.binding, this.catalogValue.digest);
      }
      record.state = 'connected';
      return Promise.resolve(record.binding);
    }
    if (record.activation) {
      if (
        record.activation.token.generation === record.generation &&
        record.activation.token.descriptorDigest === descriptor.digest
      ) {
        return record.activation.promise;
      }
      throw new StaleMcpActivationError(descriptor.id);
    }
    if (record.state === 'draining' || record.drainReason) {
      throw new McpServerDrainingError(descriptor.id);
    }

    const token: ActivationToken = {
      generation: record.generation,
      descriptorDigest: descriptor.digest,
      controller: new AbortController(),
    };
    record.state = 'activating';
    record.failure = undefined;
    const promise = this.activate(record, descriptor, token);
    const flight: ActivationFlight = { token, promise };
    record.activation = flight;
    this.track(promise);
    void promise.then(
      () => this.activationSettled(record, flight),
      () => this.activationSettled(record, flight)
    );
    return promise;
  }

  private async activate(
    record: ServerRecord,
    descriptor: McpServerDescriptorV1,
    token: ActivationToken
  ): Promise<McpServerBindingSnapshotV1> {
    let connection: McpConnectionV1 | undefined;
    try {
      throwIfAborted(token.controller.signal);
      connection = await this.connector.connect(descriptor, token.controller.signal);
      this.assertActivationCurrent(record, descriptor, token);
      const listed = await connection.listTools(token.controller.signal);
      this.assertActivationCurrent(record, descriptor, token);
      const tools = normalizeTools(descriptor, record.generation, listed, this.maxToolsPerServer);
      const toolsDigest = digestRuntimeValue(tools);
      const bindingBase = {
        version: LAZY_MCP_RUNTIME_VERSION,
        serverId: descriptor.id,
        serverDigest: descriptor.digest,
        catalogDigest: this.catalogValue.digest,
        generation: record.generation,
        tools,
        toolsDigest,
      } as const;
      const binding = deepFreeze({
        ...bindingBase,
        bindingDigest: digestRuntimeValue(bindingBase),
      });
      this.assertActivationCurrent(record, descriptor, token);
      record.connection = connection;
      record.binding = binding;
      record.failure = undefined;
      record.state = record.pendingAcquires > 0 ? 'connected' : 'idle';
      this.watchConnection(record, connection, binding);
      return binding;
    } catch (error) {
      if (connection && record.connection !== connection) {
        await closeIgnoringFailure(connection, 'activation_not_published');
      }
      if (!this.isActivationCurrent(record, descriptor, token)) {
        throw new StaleMcpActivationError(descriptor.id);
      }
      record.connection = undefined;
      record.binding = undefined;
      record.state = 'failed';
      record.failure = errorMessage(error);
      throw toError(error, `MCP server ${descriptor.id} activation failed.`);
    }
  }

  private activationSettled(record: ServerRecord, flight: ActivationFlight): void {
    if (record.activation !== flight) return;
    record.activation = undefined;
    this.settleRecord(record);
  }

  private watchConnection(
    record: ServerRecord,
    connection: McpConnectionV1,
    binding: McpServerBindingSnapshotV1
  ): void {
    if (!connection.closed) return;
    void connection.closed.then(
      reason => this.handleUnexpectedClose(record, connection, binding, reason),
      error => this.handleUnexpectedClose(record, connection, binding, error)
    );
  }

  private handleUnexpectedClose(
    record: ServerRecord,
    connection: McpConnectionV1,
    binding: McpServerBindingSnapshotV1,
    reason: unknown
  ): void {
    if (
      this.disposed ||
      record.drainReason ||
      record.connection !== connection ||
      record.binding?.bindingDigest !== binding.bindingDigest
    ) {
      return;
    }
    this.clearIdleTimer(record);
    record.generation++;
    record.connection = undefined;
    record.binding = undefined;
    record.leases.clear();
    record.state = 'failed';
    record.failure = `connection closed: ${errorMessage(reason || 'transport terminated')}`.slice(
      0,
      MAX_DESCRIPTION_CHARS
    );
  }

  private assertActivationCurrent(
    record: ServerRecord,
    descriptor: McpServerDescriptorV1,
    token: ActivationToken
  ): void {
    if (!this.isActivationCurrent(record, descriptor, token)) {
      throw new StaleMcpActivationError(descriptor.id);
    }
    throwIfAborted(token.controller.signal);
  }

  private isActivationCurrent(
    record: ServerRecord,
    descriptor: McpServerDescriptorV1,
    token: ActivationToken
  ): boolean {
    return (
      !this.disposed &&
      !record.drainReason &&
      record.generation === token.generation &&
      record.descriptor?.digest === descriptor.digest &&
      token.descriptorDigest === descriptor.digest
    );
  }

  private requestDrain(record: ServerRecord, reason: string): void {
    this.clearIdleTimer(record);
    record.generation++;
    record.drainReason = reason;
    record.state = 'draining';
    record.failure = undefined;
    if (record.activation && !record.activation.token.controller.signal.aborted) {
      record.activation.token.controller.abort(new Error(`MCP server draining: ${reason}`));
    }
    this.maybeStartDrain(record);
  }

  private maybeStartDrain(record: ServerRecord): void {
    if (
      !record.drainReason ||
      record.drainPromise ||
      record.activation ||
      record.leases.size > 0 ||
      record.pendingAcquires > 0 ||
      record.activeCalls > 0
    ) {
      return;
    }
    const connection = record.connection;
    record.binding = undefined;
    if (!connection) {
      this.finishDrain(record);
      return;
    }

    const reason = record.drainReason;
    const drain = Promise.resolve().then(() => connection.close(reason));
    record.drainPromise = drain;
    this.track(drain);
    void drain.then(
      () => {
        if (record.connection === connection) record.connection = undefined;
        record.drainPromise = undefined;
        this.finishDrain(record);
      },
      error => {
        record.drainPromise = undefined;
        record.state = 'failed';
        record.failure = `close failed: ${errorMessage(error)}`;
      }
    );
  }

  private finishDrain(record: ServerRecord): void {
    record.connection = undefined;
    record.binding = undefined;
    record.drainReason = undefined;
    record.failure = undefined;
    if (this.disposed || !record.descriptor) {
      for (const [serverId, candidate] of this.records) {
        if (candidate === record) this.records.delete(serverId);
      }
      return;
    }
    record.state = 'dormant';
  }

  private settleRecord(record: ServerRecord): void {
    if (record.drainReason) {
      this.maybeStartDrain(record);
      return;
    }
    if (record.connection && record.binding) {
      if (record.leases.size > 0 || record.pendingAcquires > 0 || record.activeCalls > 0) {
        this.clearIdleTimer(record);
        record.state = 'connected';
      } else {
        this.scheduleIdle(record);
      }
    }
  }

  private scheduleIdle(record: ServerRecord): void {
    if (record.idleTimer || record.drainReason || !record.connection) return;
    record.state = 'idle';
    if (this.idleTimeoutMs === 0) {
      this.requestDrain(record, 'idle_timeout');
      return;
    }
    const timer = setTimeout(() => {
      if (record.idleTimer !== timer) return;
      record.idleTimer = undefined;
      this.requestDrain(record, 'idle_timeout');
    }, this.idleTimeoutMs);
    timer.unref?.();
    record.idleTimer = timer;
  }

  private clearIdleTimer(record: ServerRecord): void {
    if (!record.idleTimer) return;
    clearTimeout(record.idleTimer);
    record.idleTimer = undefined;
  }

  private releaseLease(serverId: string, leaseId: string): void {
    const record = this.records.get(serverId);
    if (!record || !record.leases.delete(leaseId)) return;
    this.settleRecord(record);
  }

  private ownerBindings(ownerId: string): ReadonlyMap<string, McpServerBindingSnapshotV1> {
    const bindings = new Map<string, McpServerBindingSnapshotV1>();
    for (const [serverId, record] of this.records) {
      for (const lease of record.leases.values()) {
        if (lease.ownerId !== ownerId) continue;
        const existing = bindings.get(serverId);
        if (existing && existing.bindingDigest !== lease.binding.bindingDigest) {
          throw new LazyMcpRuntimeError(`Owner ${ownerId} has mixed bindings for ${serverId}.`);
        }
        bindings.set(serverId, lease.binding);
      }
    }
    return bindings;
  }

  private assertOwnerCatalog(ownerId: string, catalogDigest: string): void {
    for (const binding of this.ownerBindings(ownerId).values()) {
      if (binding.catalogDigest !== catalogDigest) throw new StaleMcpCatalogError(binding.serverId);
    }
  }

  private findOwnerTool(
    ownerId: string,
    qualifiedToolName: string
  ):
    | {
        readonly record: ServerRecord;
        readonly binding: McpServerBindingSnapshotV1;
        readonly tool: McpToolDescriptorV1;
      }
    | undefined {
    for (const record of this.records.values()) {
      for (const lease of record.leases.values()) {
        if (lease.ownerId !== ownerId) continue;
        const tool = lease.binding.tools.find(item => item.qualifiedName === qualifiedToolName);
        if (tool) return { record, binding: lease.binding, tool };
      }
    }
    return undefined;
  }

  private ownerHasBinding(record: ServerRecord, ownerId: string, bindingDigest: string): boolean {
    return [...record.leases.values()].some(
      lease => lease.ownerId === ownerId && lease.binding.bindingDigest === bindingDigest
    );
  }

  private assertCatalogCurrent(
    catalog: McpCatalogSnapshotV1,
    serverId: string
  ): McpServerDescriptorV1 {
    const requested = catalog.descriptors.find(descriptor => descriptor.id === serverId);
    const current = this.catalogValue.descriptors.find(descriptor => descriptor.id === serverId);
    if (
      catalog.version !== LAZY_MCP_RUNTIME_VERSION ||
      catalog.digest !== this.catalogValue.digest ||
      !requested ||
      !current ||
      requested.digest !== current.digest
    ) {
      throw new StaleMcpCatalogError(serverId);
    }
    return current;
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.operations.add(promise);
    void promise.then(
      () => this.operations.delete(promise),
      () => this.operations.delete(promise)
    );
    return promise;
  }

  private assertActive(): void {
    if (this.disposed || this.lifecycleController.signal.aborted) {
      throw new LazyMcpRuntimeError('Lazy MCP runtime is disposed.');
    }
  }
}

function createRecord(descriptor: McpServerDescriptorV1): ServerRecord {
  return {
    descriptor,
    generation: 0,
    state: 'dormant',
    leases: new Map(),
    pendingAcquires: 0,
    activeCalls: 0,
  };
}

function composeCatalog(
  inputs: readonly McpServerDescriptorInputV1[],
  maxServers: number
): McpCatalogSnapshotV1 {
  if (inputs.length > maxServers) {
    throw new LazyMcpRuntimeError(
      `MCP descriptor count ${inputs.length} exceeds configured limit ${maxServers}.`
    );
  }
  const ids = new Set<string>();
  const namespaces = new Set<string>();
  const descriptors = inputs
    .map(input => normalizeServerDescriptor(input))
    .sort((left, right) => left.id.localeCompare(right.id));
  for (const descriptor of descriptors) {
    if (ids.has(descriptor.id)) {
      throw new LazyMcpRuntimeError(`Duplicate MCP server id: ${descriptor.id}`);
    }
    ids.add(descriptor.id);
    const namespace = sanitizeMcpNamePart(descriptor.id, 'server');
    if (namespaces.has(namespace)) {
      throw new LazyMcpRuntimeError(
        `MCP server ids collide after tool-name normalization: ${descriptor.id}`
      );
    }
    namespaces.add(namespace);
  }
  const base = { version: LAZY_MCP_RUNTIME_VERSION, descriptors } as const;
  return deepFreeze({ ...base, digest: digestRuntimeValue(base) });
}

function normalizeServerDescriptor(input: McpServerDescriptorInputV1): McpServerDescriptorV1 {
  const id = validateIdentifier(input.id, 'MCP server id');
  const name = validateIdentifier(input.name, `MCP server ${id} name`);
  if (!VALID_TRANSPORTS.has(input.transport)) {
    throw new LazyMcpRuntimeError(`MCP server ${id} has unsupported transport.`);
  }
  const description = (input.description ?? '').trim().slice(0, MAX_DESCRIPTION_CHARS);
  const configDigest = validateIdentifier(input.configDigest, `MCP server ${id} config digest`);
  const tags = Object.freeze(
    [...new Set((input.tags ?? []).map(tag => tag.trim()).filter(Boolean))].sort()
  );
  const base = {
    version: LAZY_MCP_RUNTIME_VERSION,
    id,
    name,
    ...(description ? { description } : {}),
    transport: input.transport,
    configDigest,
    tags,
    disabled: input.disabled === true,
  } as const;
  return deepFreeze({ ...base, digest: digestRuntimeValue(base) });
}

function normalizeTools(
  descriptor: McpServerDescriptorV1,
  generation: number,
  listed: readonly McpListedToolV1[],
  maxTools: number
): readonly McpToolDescriptorV1[] {
  if (!Array.isArray(listed)) {
    throw new LazyMcpRuntimeError(`MCP server ${descriptor.id} returned a non-array tools list.`);
  }
  if (listed.length > maxTools) {
    throw new LazyMcpRuntimeError(
      `MCP server ${descriptor.id} returned ${listed.length} tools; limit is ${maxTools}.`
    );
  }
  const nativeNames = new Set<string>();
  const qualifiedNames = new Set<string>();
  const tools = listed
    .map(raw => {
      const name = validateIdentifier(raw.name, `MCP server ${descriptor.id} tool name`);
      if (nativeNames.has(name)) {
        throw new LazyMcpRuntimeError(
          `MCP server ${descriptor.id} returned duplicate tool ${name}.`
        );
      }
      nativeNames.add(name);
      const qualifiedName = buildQualifiedToolName(descriptor.id, name);
      if (qualifiedNames.has(qualifiedName)) {
        throw new LazyMcpRuntimeError(
          `MCP server ${descriptor.id} tool names collide after normalization: ${name}`
        );
      }
      qualifiedNames.add(qualifiedName);
      const description = (raw.description ?? name).trim().slice(0, MAX_DESCRIPTION_CHARS) || name;
      const inputSchema = normalizeInputSchema(raw.inputSchema);
      const schemaDigest = digestRuntimeValue(inputSchema);
      const bindingBase = {
        version: LAZY_MCP_RUNTIME_VERSION,
        serverId: descriptor.id,
        serverDigest: descriptor.digest,
        generation,
        name,
        qualifiedName,
        description,
        schemaDigest,
      } as const;
      return deepFreeze({
        version: LAZY_MCP_RUNTIME_VERSION,
        serverId: descriptor.id,
        name,
        qualifiedName,
        description,
        inputSchema,
        schemaDigest,
        bindingDigest: digestRuntimeValue(bindingBase),
      });
    })
    .sort((left, right) => left.qualifiedName.localeCompare(right.qualifiedName));
  return deepFreeze(tools);
}

function rebindToCatalog(
  binding: McpServerBindingSnapshotV1,
  catalogDigest: string
): McpServerBindingSnapshotV1 {
  const base = {
    version: LAZY_MCP_RUNTIME_VERSION,
    serverId: binding.serverId,
    serverDigest: binding.serverDigest,
    catalogDigest,
    generation: binding.generation,
    tools: binding.tools,
    toolsDigest: binding.toolsDigest,
  } as const;
  return deepFreeze({ ...base, bindingDigest: digestRuntimeValue(base) });
}

function normalizeInputSchema(value: unknown): McpToolDescriptorV1['inputSchema'] {
  if (!isRecord(value) || value.type !== 'object') {
    return deepFreeze({ type: 'object', properties: {} });
  }
  const cloned = structuredClone(value) as Record<string, unknown>;
  cloned.type = 'object';
  if (!isRecord(cloned.properties)) cloned.properties = {};
  if (cloned.required !== undefined && !Array.isArray(cloned.required)) delete cloned.required;
  return deepFreeze(cloned as unknown as McpToolDescriptorV1['inputSchema']);
}

function buildQualifiedToolName(serverId: string, toolName: string): string {
  return `mcp__${sanitizeMcpNamePart(serverId, 'server')}__${sanitizeMcpNamePart(toolName, 'tool')}`;
}

function sanitizeMcpNamePart(name: string, fallback: string): string {
  const sanitized = name
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized || fallback;
}

function validateSelectionReason(reason: McpSelectionReasonV1): void {
  if (reason !== 'explicit' && reason !== 'capability') {
    throw new LazyMcpRuntimeError(`Unsupported MCP selection reason: ${String(reason)}`);
  }
}

function validateIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.includes('\u0000')) {
    throw new LazyMcpRuntimeError(`${label} must be non-empty and contain no null bytes.`);
  }
  return normalized;
}

function validateBoundedInteger(value: number, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new LazyMcpRuntimeError(`${label} must be a safe integer >= ${minimum}.`);
  }
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw toError(signal.reason, 'MCP operation aborted.');
}

function linkSignals(primary: AbortSignal, secondary?: AbortSignal): LinkedSignal {
  if (!secondary) return { signal: primary, dispose: () => undefined };
  const controller = new AbortController();
  const abort = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  const onPrimary = (): void => abort(primary);
  const onSecondary = (): void => abort(secondary);
  primary.addEventListener('abort', onPrimary, { once: true });
  secondary.addEventListener('abort', onSecondary, { once: true });
  if (primary.aborted) abort(primary);
  if (secondary.aborted) abort(secondary);
  return {
    signal: controller.signal,
    dispose: (): void => {
      primary.removeEventListener('abort', onPrimary);
      secondary.removeEventListener('abort', onSecondary);
    },
  };
}

function waitForPromise<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(toError(signal.reason, 'MCP lease acquisition aborted.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      value => {
        cleanup();
        resolve(value);
      },
      error => {
        cleanup();
        reject(error);
      }
    );
  });
}

async function closeIgnoringFailure(connection: McpConnectionV1, reason: string): Promise<void> {
  try {
    await connection.close(reason);
  } catch {
    // The stale connection is never published even if its best-effort close fails.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error;
  const message = String(error ?? '').trim();
  return new Error(message || fallback);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (ArrayBuffer.isView(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}
