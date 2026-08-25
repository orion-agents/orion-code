import * as orion from '../src/index';
import type {
  AgentRuntimeCommandV1,
  CreateOrionRuntimeInputV1,
  FirstPartyMcpConfigurationV1,
  ModelRegistryConfig,
  OrionRuntime,
  ProviderConfig,
  RuntimeEventEnvelopeV1,
  SkillProviderV1,
} from '../src/index';

const FORBIDDEN_LEGACY_EXPORTS = [
  'Brain',
  'BaseAgent',
  'LeaderAgent',
  'CoderAgent',
  'init',
  'Harness',
  'MemorySystem',
  'SafetyChecker',
  'AgentRunner',
  'HarnessEngine',
  'TaskManager',
  'query',
  'simpleQuery',
  'ContextHarness',
  'HarnessKernel',
  'createContextHarness',
  'createHarnessKernel',
] as const;

const FORBIDDEN_IMPLEMENTATION_EXPORTS = [
  'RuntimeServices',
  'createRuntimeServices',
  'createRuntimeContributors',
  'ResourceScope',
  'StepSnapshotV1',
  'ExecutionService',
] as const;

// Compile-time contract probes. These values deliberately remain unused at
// runtime; a missing public type must fail ts-jest/tsc rather than a consumer.
const _command: AgentRuntimeCommandV1 = {
  type: 'turn.start',
  data: { input: 'inspect the repository', mode: 'build' as const },
};
const _event = null as unknown as RuntimeEventEnvelopeV1;
const _runtime = null as unknown as OrionRuntime;
const _runtimeInput = null as unknown as CreateOrionRuntimeInputV1;
const _provider: ProviderConfig = {
  id: 'fixture',
  baseUrl: 'https://provider.invalid/v1',
  apiKey: '$ORION_TEST_API_KEY',
  protocol: 'openai-completions',
};
const _registry: ModelRegistryConfig = {
  providers: [_provider],
  models: [{ id: 'fixture-model', provider: 'fixture', model: 'fixture-model' }],
  defaultModel: 'fixture-model',
};
const _mcp: FirstPartyMcpConfigurationV1 = {
  mcpServers: { docs: { command: 'docs-mcp' } },
};
const _skillProvider = null as unknown as SkillProviderV1;

void [_command, _event, _runtime, _runtimeInput, _registry, _mcp, _skillProvider];

describe('Orion Code v0.2 public contract', () => {
  test('exposes one product runtime factory and rejects empty session identity', () => {
    expect(typeof orion.createOrionRuntime).toBe('function');
    expect(() =>
      orion.createOrionRuntime({ sessionId: '', runtime: {} } as CreateOrionRuntimeInputV1)
    ).toThrow('sessionId must not be empty');
  });

  test('exposes the V1 protocol schema, IDs, and validators', () => {
    const commandId = orion.createRuntimeId();
    const threadId = orion.createRuntimeId();
    const eventId = orion.createRuntimeId();
    expect(orion.isRuntimeId(commandId)).toBe(true);
    expect(orion.getAgentRuntimeProtocolSchemaV1()).toMatchObject({ protocolVersion: 1 });

    expect(() =>
      orion.assertAgentRuntimeCommandV1({
        protocolVersion: 1,
        commandId,
        type: 'turn.start',
        data: { input: 'ship the cut', mode: 'build' },
      })
    ).not.toThrow();
    expect(() =>
      orion.assertRuntimeEventEnvelopeV1({
        protocolVersion: 1,
        eventId,
        seq: 1,
        threadId,
        durability: 'durable',
        timestamp: 1,
        payload: { type: 'thread.started', data: {} },
      })
    ).not.toThrow();
  });

  test('keeps Model, Skill, and lazy MCP configuration on supported boundaries', () => {
    expect(typeof orion.loadConfig).toBe('function');
    expect(typeof orion.buildRegistry).toBe('function');
    expect(typeof orion.createProductionFilesystemSkillProviderV1).toBe('function');
    expect(typeof orion.createFirstPartyMcpAdapterV1).toBe('function');
  });

  test('does not retain legacy runtimes, loops, or implementation-plane exports', () => {
    for (const symbol of [...FORBIDDEN_LEGACY_EXPORTS, ...FORBIDDEN_IMPLEMENTATION_EXPORTS]) {
      expect(orion).not.toHaveProperty(symbol);
    }
  });
});
