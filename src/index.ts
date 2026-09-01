/**
 * Orion Code v0.3 public API.
 *
 * The package root intentionally exposes one product runtime factory, the
 * versioned wire protocol, and the supported Model/Skill/MCP configuration
 * boundaries. Runtime services, contributors, resource scopes, Step snapshots,
 * and the legacy query/agent harnesses remain package-private.
 */

import {
  createProductOrionRuntimeV1,
  type ProductOrionRuntimeOptionsV1,
} from './runtime/product-orion-runtime';
import type { AgentRuntimeCommandV1, RuntimeEventEnvelopeV1 } from './runtime/protocol';

export type OrionRuntimeStateV1 = 'created' | 'starting' | 'started' | 'closing' | 'closed';

export type OrionRuntimeTurnCommandV1 = Extract<
  AgentRuntimeCommandV1,
  { type: 'turn.start' | 'turn.steer' | 'turn.follow_up' | 'turn.interrupt' }
>;

export type OrionRuntimeAdmissionV1 =
  | { readonly status: 'started'; readonly turnId: string }
  | {
      readonly status: 'steered';
      readonly activeTurnId: string;
      readonly itemId: string;
    }
  | {
      readonly status: 'queued';
      readonly queueId: string;
      readonly position: number;
      readonly deadline: number;
    }
  | {
      readonly status: 'interrupt_requested';
      readonly activeTurnId: string;
      readonly intentId: string;
      readonly alreadyRequested: boolean;
    }
  | {
      readonly status: 'rejected';
      readonly reason:
        | 'overloaded'
        | 'non_steerable'
        | 'shutdown'
        | 'no_active_turn'
        | 'deadline_expired'
        | 'invalid_input'
        | 'turn_mismatch';
    };

export interface OrionRuntimeReplayV1 {
  readonly events: readonly RuntimeEventEnvelopeV1[];
  readonly fromCursor: number;
  readonly nextCursor: number;
  readonly hasMore: boolean;
}

/** Public facade; implementation-plane service and resource owners stay hidden. */
export interface OrionRuntime {
  readonly state: OrionRuntimeStateV1;
  start(): Promise<void>;
  dispatch(command: OrionRuntimeTurnCommandV1): OrionRuntimeAdmissionV1;
  interrupt(reason?: string): OrionRuntimeAdmissionV1;
  compact(input?: {
    readonly maxMessages?: number;
    readonly focus?: string;
  }): OrionRuntimeAdmissionV1;
  replay(cursor?: number, limit?: number): OrionRuntimeReplayV1;
  waitForIdle(): Promise<void>;
  close(reason?: string): Promise<void>;
}

export interface CreateOrionRuntimeInputV1 {
  readonly sessionId: string;
  readonly runtime: ProductOrionRuntimeOptionsV1;
}

export type OrionRuntimeOptions = ProductOrionRuntimeOptionsV1;

/** The sole supported package-root composition entry point. */
export function createOrionRuntime(input: CreateOrionRuntimeInputV1): OrionRuntime {
  if (!input?.sessionId?.trim()) throw new Error('Orion runtime sessionId must not be empty.');
  const runtime = createProductOrionRuntimeV1(input.runtime, input.sessionId);
  return Object.freeze({
    get state(): OrionRuntimeStateV1 {
      return runtime.state;
    },
    start: async (): Promise<void> => {
      await runtime.start();
    },
    dispatch: (command: OrionRuntimeTurnCommandV1): OrionRuntimeAdmissionV1 =>
      runtime.thread.dispatch(command),
    interrupt: (reason = 'runtime interrupted'): OrionRuntimeAdmissionV1 =>
      runtime.thread.dispatch({ type: 'turn.interrupt', data: { reason } }),
    compact: (
      compactInput: { readonly maxMessages?: number; readonly focus?: string } = {}
    ): OrionRuntimeAdmissionV1 => runtime.compact(compactInput),
    replay: (cursor = 0, limit?: number): OrionRuntimeReplayV1 =>
      runtime.thread.replay(cursor, limit),
    waitForIdle: (): Promise<void> => runtime.thread.waitForIdle(),
    close: async (reason = 'orion_runtime_closed'): Promise<void> => {
      await runtime.close(reason);
    },
  });
}

// Versioned runtime protocol.
export {
  AGENT_RUNTIME_COMMAND_DEFINITIONS_V1,
  RUNTIME_EVENT_DEFINITIONS_V1,
  RuntimeProtocolValidationError,
  assertAgentRuntimeCommandV1,
  assertRuntimeEventEnvelopeV1,
  createRuntimeId,
  getAgentRuntimeProtocolSchemaV1,
  isRuntimeId,
} from './runtime/protocol';
export type {
  AgentRuntimeCommandV1,
  AgentRuntimeProtocolSchemaV1,
  RuntimeDurabilityV1,
  RuntimeEventEnvelopeV1,
  RuntimeEventTypeV1,
  RuntimeEventV1,
} from './runtime/protocol';

// Existing product and model configuration.
export { getConfigErrors, getConfigSummary, isConfigured, loadConfig } from './services/config';
export type { OrionCodeCLIConfig } from './services/config';
export {
  buildRegistry,
  getLegacyMigrationHint,
  isLegacyConfig,
  lookupProfile,
  resolveModelProfile,
} from './services/model-registry';
export type {
  ModelProfile,
  ModelRegistry,
  ModelRegistryConfig,
  ProviderConfig,
  ProviderProtocol,
  RegistryValidationError,
  RegistryValidationResult,
  ResolvedModelProfile,
} from './services/model-registry';
export { LLMService, LLMProviderError } from './services/llm';
export type {
  LLMConfig,
  LLMRequestDiagnostics,
  LLMResponse,
  Message,
  StreamCallback,
  StreamCallbacks,
} from './services/llm';

// Skills remain a user extension boundary; the runtime implementation is not
// exported from the package root.
export {
  createFilesystemSkillProviderV1,
  createFilesystemSkillRootsV1,
  createProductionFilesystemSkillProviderV1,
} from './runtime/skills';
export type {
  FilesystemSkillProviderOptionsV1,
  FilesystemSkillRootOptionsV1,
  FilesystemSkillRootV1,
  ProductionFilesystemSkillProviderOptionsV1,
  SkillDefinitionV1,
  SkillDescriptorV1,
  SkillProviderV1,
  SkillResourceDescriptorV1,
  SkillResourceV1,
  SkillScopeV1,
  SkillSourceScopeV1,
} from './runtime/skills';

// MCP configuration compiles to dormant descriptors. Connections remain lazy
// and owner-scoped inside OrionRuntime.
export {
  FirstPartyMcpAdapterError,
  createFirstPartyMcpAdapterV1,
  createNodeStdioMcpFactoryV1,
} from './runtime/mcp';
export type {
  CreateFirstPartyMcpAdapterOptionsV1,
  FirstPartyMcpAdapterV1,
  FirstPartyMcpConfigurationV1,
  FirstPartyMcpServerConfigV1,
  FirstPartyMcpStdioFactoryV1,
  McpConnectionV1,
  McpConnectorV1,
  McpServerDescriptorInputV1,
  McpTransportKindV1,
  NodeStdioMcpFactoryOptionsV1,
} from './runtime/mcp';
