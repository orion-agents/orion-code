import { readFileSync } from 'fs';
import { join } from 'path';

import { digestRuntimeValue } from '../src/runtime/protocol/canonical';
import {
  AGENT_RUNTIME_COMMAND_DEFINITIONS_V1,
  RUNTIME_EVENT_DEFINITIONS_V1,
  RuntimeProtocolValidationError,
  assertAgentRuntimeCommandV1,
  assertRuntimeEventEnvelopeV1,
  createRuntimeId,
  getAgentRuntimeProtocolSchemaV1,
} from '../src/runtime/protocol/runtime-protocol-v1';

interface GoldenProtocolFixture {
  protocolVersion: number;
  schemaDigest: string;
  commands: unknown[];
  events: unknown[];
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/agent-runtime-protocol-v1.golden.json'), 'utf8')
) as GoldenProtocolFixture;

describe('AgentRuntimeProtocolV1', () => {
  test('derives runtime validators and JSON Schema from the same definitions', () => {
    const schema = getAgentRuntimeProtocolSchemaV1();
    const commandTypes = Object.keys(AGENT_RUNTIME_COMMAND_DEFINITIONS_V1);
    const eventTypes = Object.keys(RUNTIME_EVENT_DEFINITIONS_V1);
    const schemaCommandTypes = ((schema.command.oneOf as Array<Record<string, unknown>>) ?? []).map(
      variant =>
        ((variant.properties as Record<string, Record<string, unknown>>).type as { const: string })
          .const
    );
    const schemaEventTypes = (
      (
        (schema.eventEnvelope.properties as Record<string, Record<string, unknown>>).payload as {
          oneOf: Array<Record<string, unknown>>;
        }
      ).oneOf ?? []
    ).map(
      variant =>
        ((variant.properties as Record<string, Record<string, unknown>>).type as { const: string })
          .const
    );

    expect(schema.protocolVersion).toBe(1);
    expect(schemaCommandTypes).toEqual(commandTypes);
    expect(schemaEventTypes).toEqual(eventTypes);
    expect(digestRuntimeValue(schema)).toBe(fixture.schemaDigest);
    expect(Object.isFrozen(schema)).toBe(true);
  });

  test('accepts all golden commands and events', () => {
    expect(fixture.protocolVersion).toBe(1);
    for (const command of fixture.commands)
      expect(() => assertAgentRuntimeCommandV1(command)).not.toThrow();
    for (const event of fixture.events)
      expect(() => assertRuntimeEventEnvelopeV1(event)).not.toThrow();
  });

  test('fails closed for incompatible versions, extra data, and durability drift', () => {
    const command = structuredClone(fixture.commands[0]) as Record<string, unknown>;
    command.protocolVersion = 2;
    expect(() => assertAgentRuntimeCommandV1(command)).toThrow(RuntimeProtocolValidationError);

    const commandWithExtraData = structuredClone(fixture.commands[0]) as {
      data: Record<string, unknown>;
    };
    commandWithExtraData.data.unexpected = true;
    expect(() => assertAgentRuntimeCommandV1(commandWithExtraData)).toThrow(/not allowed/);

    const durableDelta = structuredClone(fixture.events[1]) as Record<string, unknown>;
    durableDelta.durability = 'durable';
    expect(() => assertRuntimeEventEnvelopeV1(durableDelta)).toThrow(
      /item.delta must be ephemeral/
    );
  });

  test('creates stable UUID identities', () => {
    const ids = new Set(Array.from({ length: 100 }, createRuntimeId));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
