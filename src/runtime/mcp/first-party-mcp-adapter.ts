import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { resolve } from 'path';
import { MCP_CLIENT_NAME } from '../../product/identity';
import { PACKAGE_VERSION } from '../../product/version';
import { digestRuntimeValue } from '../protocol/canonical';
import type {
  McpConnectionV1,
  McpConnectorV1,
  McpListedToolV1,
  McpServerDescriptorInputV1,
  McpServerDescriptorV1,
  McpTransportKindV1,
} from './types';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_GRACE_MS = 1_000;
const MAX_STDIO_FRAME_BYTES = 4 * 1024 * 1024;
const MCP_PROTOCOL_VERSION = '2024-11-05';

const SAFE_CHILD_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  // Required for command discovery and child process startup on Windows.
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
]);

type UnknownRecord = Record<string, unknown>;

export interface FirstPartyMcpServerConfigV1 {
  readonly type?: McpTransportKindV1;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly disabled?: boolean;
  readonly enabled?: boolean;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly name?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
}

/**
 * The three configuration envelopes Orion currently accepts. Callers should
 * pass one envelope, not merge them here; configuration precedence remains the
 * responsibility of the existing config loader.
 */
export interface FirstPartyMcpConfigurationV1 {
  readonly mcpServers?: Readonly<Record<string, FirstPartyMcpServerConfigV1>>;
  readonly servers?: Readonly<Record<string, FirstPartyMcpServerConfigV1>>;
  readonly orion?: {
    readonly mcp?: {
      readonly servers?: Readonly<Record<string, FirstPartyMcpServerConfigV1>>;
    };
  };
}

/** Private process input. It is handed only to the injected stdio factory. */
export interface FirstPartyMcpStdioConnectInputV1 {
  readonly serverId: string;
  readonly configDigest: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

/** Narrow replacement for the legacy global MCP manager. */
export interface FirstPartyMcpStdioFactoryV1 {
  connect(input: FirstPartyMcpStdioConnectInputV1, signal: AbortSignal): Promise<McpConnectionV1>;
}

export interface FirstPartyMcpAdapterV1 {
  readonly descriptors: readonly McpServerDescriptorInputV1[];
  readonly connector: McpConnectorV1;
}

export interface CreateFirstPartyMcpAdapterOptionsV1 {
  readonly config: FirstPartyMcpConfigurationV1;
  readonly baseDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly stdioFactory?: FirstPartyMcpStdioFactoryV1;
  readonly requestTimeoutMs?: number;
  readonly closeGraceMs?: number;
  readonly onStderr?: (serverId: string, text: string) => void;
}

export interface NodeStdioMcpFactoryOptionsV1 {
  readonly environment?: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
  readonly closeGraceMs?: number;
  readonly onStderr?: (serverId: string, text: string) => void;
}

interface NormalizedServerConfig {
  readonly serverId: string;
  readonly transport: McpTransportKindV1;
  readonly configDigest: string;
  readonly descriptor: McpServerDescriptorInputV1;
  readonly stdio?: FirstPartyMcpStdioConnectInputV1;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

export class FirstPartyMcpAdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'FirstPartyMcpAdapterError';
    this.code = code;
  }
}

/**
 * Compile existing Orion MCP configuration into a descriptor-only catalog and
 * an exact-id connector. This function performs no network, process, list, or
 * tool work.
 */
export function createFirstPartyMcpAdapterV1(
  options: CreateFirstPartyMcpAdapterOptionsV1
): FirstPartyMcpAdapterV1 {
  const environment = Object.freeze({ ...(options.environment ?? process.env) });
  const baseDirectory = resolve(options.baseDirectory ?? process.cwd());
  const servers = selectServerEnvelope(options.config);
  const registry = new Map<string, NormalizedServerConfig>();

  for (const [rawId, rawConfig] of Object.entries(servers).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const serverId = requiredText(rawId, 'MCP server id');
    if (registry.has(serverId)) {
      throw new FirstPartyMcpAdapterError(
        'ORION_MCP_DUPLICATE_SERVER',
        `MCP server ids collide after normalization: ${serverId}`
      );
    }
    if (!isEnabled(rawConfig)) continue;
    const normalized = normalizeServer(serverId, rawConfig, baseDirectory, environment);
    registry.set(serverId, normalized);
  }

  const stdioFactory =
    options.stdioFactory ??
    createNodeStdioMcpFactoryV1({
      environment,
      requestTimeoutMs: options.requestTimeoutMs,
      closeGraceMs: options.closeGraceMs,
      onStderr: options.onStderr,
    });
  const descriptors = Object.freeze(
    [...registry.values()]
      .map(record => record.descriptor)
      .sort((left, right) => left.id.localeCompare(right.id))
  );

  return Object.freeze({
    descriptors,
    connector: Object.freeze(new FirstPartyMcpConnector(registry, stdioFactory)),
  });
}

/** A production single-process stdio transport with no global registry. */
export function createNodeStdioMcpFactoryV1(
  options: NodeStdioMcpFactoryOptionsV1 = {}
): FirstPartyMcpStdioFactoryV1 {
  const environment = Object.freeze({ ...(options.environment ?? process.env) });
  const requestTimeoutMs = boundedInteger(
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    'MCP request timeout',
    1
  );
  const closeGraceMs = boundedInteger(
    options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS,
    'MCP close grace',
    0
  );

  return Object.freeze({
    connect: async (
      input: FirstPartyMcpStdioConnectInputV1,
      signal: AbortSignal
    ): Promise<McpConnectionV1> => {
      throwIfAborted(signal);
      const child = spawn(input.command, [...input.args], {
        cwd: input.cwd,
        env: buildFirstPartyMcpChildEnvironmentV1(input.env, environment),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const connection = new NodeStdioMcpConnection(
        input.serverId,
        child,
        requestTimeoutMs,
        closeGraceMs,
        options.onStderr
      );
      try {
        await connection.initialize(signal);
        return connection;
      } catch (error) {
        await connection.close('initialization_failed');
        throw toError(error, `MCP server ${input.serverId} initialization failed.`);
      }
    },
  });
}

class FirstPartyMcpConnector implements McpConnectorV1 {
  readonly #registry: ReadonlyMap<string, NormalizedServerConfig>;
  readonly #stdioFactory: FirstPartyMcpStdioFactoryV1;

  constructor(
    registry: ReadonlyMap<string, NormalizedServerConfig>,
    stdioFactory: FirstPartyMcpStdioFactoryV1
  ) {
    this.#registry = registry;
    this.#stdioFactory = stdioFactory;
  }

  async connect(descriptor: McpServerDescriptorV1, signal: AbortSignal): Promise<McpConnectionV1> {
    throwIfAborted(signal);
    const record = this.#registry.get(descriptor.id);
    if (
      !record ||
      record.configDigest !== descriptor.configDigest ||
      record.transport !== descriptor.transport
    ) {
      throw new FirstPartyMcpAdapterError(
        'ORION_MCP_STALE_DESCRIPTOR',
        `MCP descriptor is stale or unknown for server ${descriptor.id}.`
      );
    }
    if (record.transport !== 'stdio' || !record.stdio) {
      throw new FirstPartyMcpAdapterError(
        'ORION_MCP_UNSUPPORTED_TRANSPORT',
        `MCP server ${descriptor.id} uses unsupported transport ${record.transport}.`
      );
    }
    return this.#stdioFactory.connect(record.stdio, signal);
  }
}

class NodeStdioMcpConnection implements McpConnectionV1 {
  readonly closed: Promise<unknown>;

  private readonly pending = new Map<string, PendingRequest>();
  private readonly resolveClosed: (reason: unknown) => void;
  private buffer = '';
  private requestSequence = 0;
  private terminated = false;
  private closing = false;

  constructor(
    private readonly serverId: string,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly requestTimeoutMs: number,
    private readonly closeGraceMs: number,
    onStderr?: (serverId: string, text: string) => void
  ) {
    let resolveClosed!: (reason: unknown) => void;
    this.closed = new Promise(resolvePromise => {
      resolveClosed = resolvePromise;
    });
    this.resolveClosed = resolveClosed;

    child.stdout.on('data', (chunk: Buffer | string) => this.acceptStdout(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString().trim();
      if (text) onStderr?.(serverId, text.slice(0, 4_096));
    });
    child.stdin.on('error', error => this.failTransport(error));
    child.once('error', error => this.failTransport(error));
    child.once('close', (code, signal) => {
      this.finishTransport(
        new Error(
          `MCP server ${serverId} process closed (code=${String(code)}, signal=${String(signal)}).`
        )
      );
    });
  }

  async initialize(signal: AbortSignal): Promise<void> {
    await this.request(
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: MCP_CLIENT_NAME, version: PACKAGE_VERSION },
      },
      signal
    );
    this.notify('notifications/initialized', {});
  }

  async listTools(signal: AbortSignal): Promise<readonly McpListedToolV1[]> {
    const result = await this.request('tools/list', {}, signal);
    if (!isRecord(result) || !Array.isArray(result.tools)) {
      throw new FirstPartyMcpAdapterError(
        'ORION_MCP_INVALID_TOOLS_LIST',
        `MCP server ${this.serverId} returned an invalid tools/list result.`
      );
    }
    return Object.freeze(
      result.tools
        .filter(isRecord)
        .filter(tool => typeof tool.name === 'string' && tool.name.trim().length > 0)
        .map(tool =>
          Object.freeze({
            name: tool.name as string,
            ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
            ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
          })
        )
    );
  }

  callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal
  ): Promise<unknown> {
    return this.request('tools/call', { name, arguments: args }, signal);
  }

  async close(reason: string): Promise<void> {
    if (this.terminated) return;
    if (!this.closing) {
      this.closing = true;
      this.rejectPending(new Error(`MCP server ${this.serverId} closed: ${reason}`));
      this.child.kill('SIGTERM');
    }
    if (await settlesWithin(this.closed, this.closeGraceMs)) return;
    if (!this.terminated) this.child.kill('SIGKILL');
    await settlesWithin(this.closed, this.closeGraceMs);
  }

  private request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    throwIfAborted(signal);
    this.assertWritable();
    const id = `orion-mcp-${++this.requestSequence}`;
    const message = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;

    return new Promise((resolveRequest, rejectRequest) => {
      const reject = (error: Error): void => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (pending.signal && pending.onAbort) {
          pending.signal.removeEventListener('abort', pending.onAbort);
        }
        rejectRequest(error);
      };
      const resolve = (value: unknown): void => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (pending.signal && pending.onAbort) {
          pending.signal.removeEventListener('abort', pending.onAbort);
        }
        resolveRequest(value);
      };
      const timer = setTimeout(
        () =>
          reject(
            new FirstPartyMcpAdapterError(
              'ORION_MCP_REQUEST_TIMEOUT',
              `MCP server ${this.serverId} request timed out (${method}).`
            )
          ),
        this.requestTimeoutMs
      );
      timer.unref?.();
      const onAbort = (): void => reject(abortError(signal));
      this.pending.set(id, { method, resolve, reject, timer, signal, onAbort });
      signal.addEventListener('abort', onAbort, { once: true });

      this.child.stdin.write(message, error => {
        if (error) reject(toError(error, `MCP server ${this.serverId} write failed.`));
      });
    });
  }

  private notify(method: string, params: unknown): void {
    this.assertWritable();
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`, error => {
      if (error) this.failTransport(error);
    });
  }

  private acceptStdout(chunk: string): void {
    if (this.terminated) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_STDIO_FRAME_BYTES) {
      this.failTransport(
        new FirstPartyMcpAdapterError(
          'ORION_MCP_FRAME_TOO_LARGE',
          `MCP server ${this.serverId} exceeded the stdio frame limit.`
        )
      );
      return;
    }
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) this.acceptLine(line);
  }

  private acceptLine(line: string): void {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // Third-party servers sometimes print banners. Complete non-JSON lines
      // are ignored; an unterminated frame remains bounded in `buffer`.
      return;
    }
    if (!isRecord(message) || (typeof message.id !== 'string' && typeof message.id !== 'number')) {
      return;
    }
    const pending = this.pending.get(String(message.id));
    if (!pending) return;
    if (message.error !== undefined) {
      pending.reject(parseRpcError(this.serverId, pending.method, message.error));
      return;
    }
    pending.resolve(message.result);
  }

  private assertWritable(): void {
    if (
      this.terminated ||
      this.closing ||
      this.child.stdin.destroyed ||
      !this.child.stdin.writable
    ) {
      throw new FirstPartyMcpAdapterError(
        'ORION_MCP_CONNECTION_CLOSED',
        `MCP server ${this.serverId} connection is closed.`
      );
    }
  }

  private failTransport(error: unknown): void {
    const failure = toError(error, `MCP server ${this.serverId} transport failed.`);
    this.finishTransport(failure);
    if (!this.child.killed) this.child.kill('SIGTERM');
  }

  private finishTransport(reason: unknown): void {
    if (this.terminated) return;
    this.terminated = true;
    this.buffer = '';
    this.rejectPending(toError(reason, `MCP server ${this.serverId} transport terminated.`));
    this.resolveClosed(reason);
  }

  private rejectPending(error: Error): void {
    for (const pending of [...this.pending.values()]) pending.reject(error);
  }
}

function selectServerEnvelope(
  config: FirstPartyMcpConfigurationV1
): Readonly<Record<string, FirstPartyMcpServerConfigV1>> {
  const candidates = [
    ['orion.mcp.servers', config.orion?.mcp?.servers],
    ['mcpServers', config.mcpServers],
    ['servers', config.servers],
  ] as const;
  const present: Array<readonly [string, Readonly<Record<string, FirstPartyMcpServerConfigV1>>]> =
    [];
  for (const [name, servers] of candidates) {
    if (servers) present.push([name, servers]);
  }
  if (present.length > 1) {
    throw new FirstPartyMcpAdapterError(
      'ORION_MCP_AMBIGUOUS_CONFIG',
      `MCP configuration has multiple server envelopes: ${present.map(([name]) => name).join(', ')}.`
    );
  }
  return present[0]?.[1] ?? {};
}

function isEnabled(config: FirstPartyMcpServerConfigV1): boolean {
  return config.disabled !== true && config.enabled !== false;
}

function normalizeServer(
  serverId: string,
  config: FirstPartyMcpServerConfigV1,
  baseDirectory: string,
  environment: NodeJS.ProcessEnv
): NormalizedServerConfig {
  const transport = config.type ?? 'stdio';
  if (!isTransport(transport)) {
    throw new FirstPartyMcpAdapterError(
      'ORION_MCP_INVALID_TRANSPORT',
      `MCP server ${serverId} has an invalid transport.`
    );
  }
  const command = optionalExpandedText(config.command, environment);
  if (transport === 'stdio' && !command) {
    throw new FirstPartyMcpAdapterError(
      'ORION_MCP_MISSING_COMMAND',
      `MCP stdio server ${serverId} requires a command.`
    );
  }
  const args = Object.freeze((config.args ?? []).map(value => expandText(value, environment)));
  const env = freezeRecord(
    Object.fromEntries(
      Object.entries(config.env ?? {}).map(([key, value]) => [key, expandText(value, environment)])
    )
  );
  const cwdValue = optionalExpandedText(config.cwd, environment);
  const cwd = cwdValue ? resolve(baseDirectory, cwdValue) : undefined;
  const url = optionalExpandedText(config.url, environment);
  const headers = freezeRecord(
    Object.fromEntries(
      Object.entries(config.headers ?? {}).map(([key, value]) => [
        key,
        expandText(value, environment),
      ])
    )
  );
  const digestInput = {
    transport,
    ...(command ? { command } : {}),
    args,
    env,
    ...(cwd ? { cwd } : {}),
    ...(url ? { url } : {}),
    headers,
  };
  const configDigest = `sha256:${digestRuntimeValue(digestInput)}`;
  const descriptor = Object.freeze({
    id: serverId,
    name: optionalText(config.name) ?? serverId,
    ...(optionalText(config.description) ? { description: optionalText(config.description) } : {}),
    transport,
    configDigest,
    tags: Object.freeze(
      [...new Set((config.tags ?? []).map(tag => tag.trim()).filter(Boolean))].sort()
    ),
  });
  const stdio =
    transport === 'stdio' && command
      ? Object.freeze({
          serverId,
          configDigest,
          command,
          args,
          env,
          ...(cwd ? { cwd } : {}),
        })
      : undefined;
  return Object.freeze({ serverId, transport, configDigest, descriptor, stdio });
}

export function buildFirstPartyMcpChildEnvironmentV1(
  configured: Readonly<Record<string, string>> = {},
  parent: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (SAFE_CHILD_ENV_KEYS.has(key) || key.startsWith('LC_')) env[key] = value;
  }
  for (const [key, value] of Object.entries(configured)) env[key] = value;
  return env;
}

function expandText(value: string, environment: NodeJS.ProcessEnv): string {
  if (typeof value !== 'string') {
    throw new FirstPartyMcpAdapterError(
      'ORION_MCP_INVALID_CONFIG',
      'MCP command, argument, environment, and endpoint values must be strings.'
    );
  }
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key: string) => {
    return environment[key] ?? '';
  });
}

function optionalExpandedText(
  value: string | undefined,
  environment: NodeJS.ProcessEnv
): string | undefined {
  if (value === undefined) return undefined;
  const expanded = expandText(value, environment).trim();
  return expanded || undefined;
}

function requiredText(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new FirstPartyMcpAdapterError('ORION_MCP_INVALID_CONFIG', `${label} must not be empty.`);
  }
  return value.trim();
}

function optionalText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new FirstPartyMcpAdapterError(
      'ORION_MCP_INVALID_CONFIG',
      'MCP server metadata must be strings.'
    );
  }
  return value.trim() || undefined;
}

function boundedInteger(value: number, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new FirstPartyMcpAdapterError(
      'ORION_MCP_INVALID_CONFIG',
      `${label} must be an integer >= ${minimum}.`
    );
  }
  return value;
}

function isTransport(value: string): value is McpTransportKindV1 {
  return (
    value === 'stdio' ||
    value === 'sse' ||
    value === 'http' ||
    value === 'streamable-http' ||
    value === 'websocket'
  );
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function freezeRecord(value: Record<string, string>): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
  );
}

function parseRpcError(serverId: string, method: string, value: unknown): Error {
  const message =
    isRecord(value) && typeof value.message === 'string' ? value.message : 'MCP error';
  return new FirstPartyMcpAdapterError(
    'ORION_MCP_RPC_ERROR',
    `MCP server ${serverId} rejected ${method}: ${message}`
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('MCP operation aborted.');
}

function toError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' && value ? value : fallback);
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs === 0) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>(resolvePromise => {
        timer = setTimeout(() => resolvePromise(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
