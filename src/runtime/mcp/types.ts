import type { ToolInputJSONSchema } from '../../framework/tool';
import type { McpBindingSnapshotV1 } from '../step-snapshot';

export const LAZY_MCP_RUNTIME_VERSION = 1 as const;

export type McpTransportKindV1 = 'stdio' | 'sse' | 'http' | 'streamable-http' | 'websocket';

export type McpServerStateV1 =
  | 'dormant'
  | 'activating'
  | 'connected'
  | 'idle'
  | 'draining'
  | 'failed';

export type McpSelectionReasonV1 = 'explicit' | 'capability';

/**
 * Safe startup metadata. The connector owns command lines, endpoints, headers,
 * and credentials; none of those values belong in the model-visible catalog.
 */
export interface McpServerDescriptorInputV1 {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly transport: McpTransportKindV1;
  readonly configDigest: string;
  readonly tags?: readonly string[];
  readonly disabled?: boolean;
}

export interface McpServerDescriptorV1 extends McpServerDescriptorInputV1 {
  readonly version: 1;
  readonly tags: readonly string[];
  readonly disabled: boolean;
  readonly digest: string;
}

/** Descriptor-only catalog. Creating it must not connect to any MCP server. */
export interface McpCatalogSnapshotV1 {
  readonly version: 1;
  readonly descriptors: readonly McpServerDescriptorV1[];
  readonly digest: string;
}

/** Minimal untrusted result of MCP tools/list, normalized by the runtime. */
export interface McpListedToolV1 {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

/** One exact, generation-bound tool safe to hand to a Step factory. */
export interface McpToolDescriptorV1 {
  readonly version: 1;
  readonly serverId: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly description: string;
  readonly inputSchema: ToolInputJSONSchema;
  readonly schemaDigest: string;
  readonly bindingDigest: string;
}

export interface McpConnectionV1 {
  /** Settles only when the underlying transport/process has terminated. */
  readonly closed?: Promise<unknown>;
  listTools(signal: AbortSignal): Promise<readonly McpListedToolV1[]>;
  callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal
  ): Promise<unknown>;
  close(reason: string): void | Promise<void>;
}

/**
 * Injected transport boundary. Implementations may resolve the descriptor id
 * through a private registry containing the actual process/network config.
 */
export interface McpConnectorV1 {
  connect(descriptor: McpServerDescriptorV1, signal: AbortSignal): Promise<McpConnectionV1>;
}

export interface McpServerBindingSnapshotV1 {
  readonly version: 1;
  readonly serverId: string;
  readonly serverDigest: string;
  readonly catalogDigest: string;
  readonly generation: number;
  readonly tools: readonly McpToolDescriptorV1[];
  readonly toolsDigest: string;
  readonly bindingDigest: string;
}

/** Rich owner-scoped snapshot plus the exact serializable StepSnapshot value. */
export interface McpRuntimeBindingSnapshotV1 {
  readonly version: 1;
  readonly ownerId: string;
  readonly servers: readonly McpServerBindingSnapshotV1[];
  readonly step: McpBindingSnapshotV1;
  readonly digest: string;
}

export interface McpRuntimeToolBindingV1 {
  readonly descriptor: McpToolDescriptorV1;
  invoke(args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown>;
}

export interface McpLeaseRequestV1 {
  readonly catalog: McpCatalogSnapshotV1;
  readonly serverId: string;
  readonly ownerId: string;
  readonly reason: McpSelectionReasonV1;
  readonly signal?: AbortSignal;
}

export interface McpServerLeaseV1 {
  readonly version: 1;
  readonly leaseId: string;
  readonly ownerId: string;
  readonly serverId: string;
  readonly reason: McpSelectionReasonV1;
  readonly binding: McpServerBindingSnapshotV1;
  release(): Promise<void>;
}

export interface McpServerRuntimeSnapshotV1 {
  readonly serverId: string;
  readonly descriptorDigest?: string;
  readonly generation: number;
  readonly state: McpServerStateV1;
  readonly leaseOwners: readonly string[];
  readonly activeLeaseCount: number;
  readonly activeCallCount: number;
  readonly pendingAcquireCount: number;
  readonly toolCount: number;
  readonly toolsDigest?: string;
  readonly failure?: string;
}

export interface LazyMcpRuntimeSnapshotV1 {
  readonly version: 1;
  readonly catalog: McpCatalogSnapshotV1;
  readonly servers: readonly McpServerRuntimeSnapshotV1[];
  readonly digest: string;
}

export interface LazyMcpRuntimeOptions {
  readonly descriptors: readonly McpServerDescriptorInputV1[];
  readonly connector: McpConnectorV1;
  readonly idleTimeoutMs?: number;
  readonly maxServers?: number;
  readonly maxToolsPerServer?: number;
  readonly signal?: AbortSignal;
}
