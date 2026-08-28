import { randomUUID } from 'crypto';

type StringSchema = {
  readonly type: 'string';
  readonly enum?: readonly string[];
  readonly minLength?: number;
};

type NumberSchema = {
  readonly type: 'number' | 'integer';
  readonly minimum?: number;
};

type BooleanSchema = { readonly type: 'boolean' };

type ArraySchema = {
  readonly type: 'array';
  readonly items: JsonSchema;
  readonly maxItems?: number;
};

type ObjectSchema = {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
};

type JsonSchema = StringSchema | NumberSchema | BooleanSchema | ArraySchema | ObjectSchema;

type InferJsonSchema<T extends JsonSchema> = T extends StringSchema
  ? T extends { readonly enum: readonly (infer E extends string)[] }
    ? E
    : string
  : T extends NumberSchema
    ? number
    : T extends BooleanSchema
      ? boolean
      : T extends ArraySchema
        ? InferJsonSchema<T['items']>[]
        : T extends ObjectSchema
          ? InferObjectSchema<T>
          : never;

type RequiredKeys<T extends ObjectSchema> = T extends {
  readonly required: readonly (infer K extends string)[];
}
  ? K
  : never;

type InferObjectSchema<T extends ObjectSchema> = {
  -readonly [K in keyof T['properties'] as K extends RequiredKeys<T>
    ? K
    : never]-?: InferJsonSchema<T['properties'][K]>;
} & {
  -readonly [K in keyof T['properties'] as K extends RequiredKeys<T> ? never : K]?: InferJsonSchema<
    T['properties'][K]
  >;
};

const string = { type: 'string' } as const;
const nonEmptyString = { type: 'string', minLength: 1 } as const;
const nonNegativeInteger = { type: 'integer', minimum: 0 } as const;

/**
 * The protocol definitions are the single source used for both TypeScript
 * payload inference and the JSON Schema exposed to renderer/runtime adapters.
 */
export const AGENT_RUNTIME_COMMAND_DEFINITIONS_V1 = {
  initialize: {
    type: 'object',
    properties: {
      clientId: nonEmptyString,
      cwd: string,
    },
    required: ['clientId'],
    additionalProperties: false,
  },
  'thread.start': {
    type: 'object',
    properties: {
      threadId: nonEmptyString,
      input: string,
    },
    required: ['input'],
    additionalProperties: false,
  },
  'thread.resume': {
    type: 'object',
    properties: {
      threadId: nonEmptyString,
      cursor: nonNegativeInteger,
    },
    required: ['threadId'],
    additionalProperties: false,
  },
  'thread.fork': {
    type: 'object',
    properties: {
      sourceThreadId: nonEmptyString,
      sourceSeq: nonNegativeInteger,
      threadId: nonEmptyString,
    },
    required: ['sourceThreadId'],
    additionalProperties: false,
  },
  'turn.start': {
    type: 'object',
    properties: {
      input: nonEmptyString,
      mode: { type: 'string', enum: ['build', 'plan', 'auto', 'goal'] },
      authorityId: nonEmptyString,
    },
    required: ['input', 'mode'],
    additionalProperties: false,
  },
  'turn.steer': {
    type: 'object',
    properties: { input: nonEmptyString },
    required: ['input'],
    additionalProperties: false,
  },
  'turn.follow_up': {
    type: 'object',
    properties: { input: nonEmptyString },
    required: ['input'],
    additionalProperties: false,
  },
  'turn.interrupt': {
    type: 'object',
    properties: { reason: string },
    additionalProperties: false,
  },
  'approval.respond': {
    type: 'object',
    properties: {
      requestId: nonEmptyString,
      approved: { type: 'boolean' },
      scope: { type: 'string', enum: ['once', 'project', 'global'] },
    },
    required: ['requestId', 'approved'],
    additionalProperties: false,
  },
} as const satisfies Readonly<Record<string, ObjectSchema>>;

export const RUNTIME_EVENT_DEFINITIONS_V1 = {
  'thread.started': {
    type: 'object',
    properties: { projectPath: string },
    additionalProperties: false,
  },
  'thread.resumed': {
    type: 'object',
    properties: { fromSeq: nonNegativeInteger },
    required: ['fromSeq'],
    additionalProperties: false,
  },
  'thread.forked': {
    type: 'object',
    properties: {
      sourceThreadId: nonEmptyString,
      sourceSeq: nonNegativeInteger,
    },
    required: ['sourceThreadId', 'sourceSeq'],
    additionalProperties: false,
  },
  'turn.started': {
    type: 'object',
    properties: {
      input: nonEmptyString,
      mode: { type: 'string', enum: ['build', 'plan', 'auto', 'goal', 'maintenance'] },
      queueId: nonEmptyString,
    },
    required: ['input', 'mode'],
    additionalProperties: false,
  },
  'turn.queued': {
    type: 'object',
    properties: {
      queueId: nonEmptyString,
      input: nonEmptyString,
      mode: { type: 'string', enum: ['build', 'plan', 'auto', 'goal', 'maintenance'] },
      kind: { type: 'string', enum: ['regular', 'goal', 'maintenance'] },
      source: { type: 'string', enum: ['start', 'follow_up'] },
      enqueuedAt: nonNegativeInteger,
      deadline: nonNegativeInteger,
    },
    required: ['queueId', 'input', 'mode', 'kind', 'source', 'enqueuedAt', 'deadline'],
    additionalProperties: false,
  },
  'turn.queue_expired': {
    type: 'object',
    properties: { queueId: nonEmptyString },
    required: ['queueId'],
    additionalProperties: false,
  },
  'turn.steered': {
    type: 'object',
    properties: { itemId: nonEmptyString, input: nonEmptyString },
    required: ['itemId', 'input'],
    additionalProperties: false,
  },
  'turn.interrupt_requested': {
    type: 'object',
    properties: { intentId: nonEmptyString, reason: string },
    required: ['intentId'],
    additionalProperties: false,
  },
  'turn.committed': {
    type: 'object',
    properties: {
      commitId: nonEmptyString,
      terminal: { type: 'string', enum: ['completed', 'failed', 'interrupted'] },
      digest: nonEmptyString,
      receipt: nonEmptyString,
      outcome: string,
      error: string,
      reason: string,
    },
    required: ['commitId', 'terminal', 'digest', 'receipt'],
    additionalProperties: false,
  },
  'turn.completed': {
    type: 'object',
    properties: { outcome: string },
    additionalProperties: false,
  },
  'turn.failed': {
    type: 'object',
    properties: { error: nonEmptyString },
    required: ['error'],
    additionalProperties: false,
  },
  'turn.interrupted': {
    type: 'object',
    properties: { reason: string },
    additionalProperties: false,
  },
  'item.started': {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['message', 'reasoning', 'command', 'file_change', 'mcp', 'plan', 'compact'],
      },
      parentItemId: nonEmptyString,
      role: { type: 'string', enum: ['user', 'assistant', 'system', 'tool'] },
      name: nonEmptyString,
      inputDigest: nonEmptyString,
      intent: string,
    },
    required: ['kind'],
    additionalProperties: false,
  },
  'item.delta': {
    type: 'object',
    properties: {
      delta: string,
      channel: { type: 'string', enum: ['content', 'reasoning', 'output'] },
    },
    required: ['delta'],
    additionalProperties: false,
  },
  'item.completed': {
    type: 'object',
    properties: {
      content: string,
      summary: string,
      outputDigest: nonEmptyString,
      receipt: string,
    },
    additionalProperties: false,
  },
  'item.failed': {
    type: 'object',
    properties: { error: nonEmptyString, receipt: string },
    required: ['error'],
    additionalProperties: false,
  },
  'item.interrupted': {
    type: 'object',
    properties: { reason: string, receipt: string },
    additionalProperties: false,
  },
  'item.indeterminate': {
    type: 'object',
    properties: { reason: nonEmptyString, receipt: string },
    required: ['reason'],
    additionalProperties: false,
  },
  'compact.started': {
    type: 'object',
    properties: {
      sourceSeq: nonNegativeInteger,
      transactionId: nonEmptyString,
      sourceReceiptDigest: nonEmptyString,
      startedProjectionDigest: nonEmptyString,
    },
    required: ['sourceSeq', 'transactionId', 'sourceReceiptDigest', 'startedProjectionDigest'],
    additionalProperties: false,
  },
  'compact.completed': {
    type: 'object',
    properties: {
      checkpointId: nonEmptyString,
      sourceSeq: nonNegativeInteger,
      transactionId: nonEmptyString,
      commitReceiptDigest: nonEmptyString,
      nextModelVisibleHistoryDigest: nonEmptyString,
    },
    required: [
      'checkpointId',
      'sourceSeq',
      'transactionId',
      'commitReceiptDigest',
      'nextModelVisibleHistoryDigest',
    ],
    additionalProperties: false,
  },
  'compact.failed': {
    type: 'object',
    properties: {
      error: nonEmptyString,
      transactionId: nonEmptyString,
      sourceSeq: nonNegativeInteger,
      failureCode: nonEmptyString,
      failureReceiptDigest: nonEmptyString,
    },
    required: ['error', 'transactionId', 'sourceSeq', 'failureCode', 'failureReceiptDigest'],
    additionalProperties: false,
  },
  'approval.requested': {
    type: 'object',
    properties: {
      requestId: nonEmptyString,
      toolName: nonEmptyString,
    },
    required: ['requestId', 'toolName'],
    additionalProperties: false,
  },
  'step.snapshot': {
    type: 'object',
    properties: {
      snapshotId: nonEmptyString,
      digest: nonEmptyString,
      receipt: nonEmptyString,
    },
    required: ['snapshotId', 'digest', 'receipt'],
    additionalProperties: false,
  },
  'capability.receipt': {
    type: 'object',
    properties: {
      receiptId: nonEmptyString,
      digest: nonEmptyString,
      receipt: nonEmptyString,
    },
    required: ['receiptId', 'digest', 'receipt'],
    additionalProperties: false,
  },
  'tool.receipt': {
    type: 'object',
    properties: {
      invocationId: nonEmptyString,
      terminal: { type: 'string', enum: ['completed', 'failed', 'interrupted', 'indeterminate'] },
      success: { type: 'boolean' },
      outputDigest: nonEmptyString,
      receiptDigest: nonEmptyString,
      intentDigest: nonEmptyString,
    },
    required: [
      'invocationId',
      'terminal',
      'success',
      'outputDigest',
      'receiptDigest',
      'intentDigest',
    ],
    additionalProperties: false,
  },
} as const satisfies Readonly<Record<string, ObjectSchema>>;

type ProtocolVariant<T extends Readonly<Record<string, ObjectSchema>>> = {
  [K in keyof T]: {
    type: K;
    data: InferJsonSchema<T[K]>;
  };
}[keyof T];

export type AgentRuntimeCommandV1 = ProtocolVariant<typeof AGENT_RUNTIME_COMMAND_DEFINITIONS_V1>;
export type RuntimeEventV1 = ProtocolVariant<typeof RUNTIME_EVENT_DEFINITIONS_V1>;
export type RuntimeEventTypeV1 = RuntimeEventV1['type'];
export type RuntimeDurabilityV1 = 'durable' | 'ephemeral';

export interface RuntimeEventEnvelopeV1<T extends RuntimeEventV1 = RuntimeEventV1> {
  readonly protocolVersion: 1;
  readonly eventId: string;
  /** Durable sequence, or the latest durable cursor for an ephemeral delta. */
  readonly seq: number;
  readonly threadId: string;
  readonly turnId?: string;
  readonly stepId?: string;
  readonly itemId?: string;
  readonly durability: RuntimeDurabilityV1;
  readonly timestamp: number;
  readonly payload: T;
}

export interface AgentRuntimeProtocolSchemaV1 {
  readonly protocolVersion: 1;
  readonly command: Readonly<Record<string, unknown>>;
  readonly eventEnvelope: Readonly<Record<string, unknown>>;
}

export class RuntimeProtocolValidationError extends Error {
  readonly code = 'ORION_RUNTIME_PROTOCOL_INVALID';

  constructor(readonly problems: readonly string[]) {
    super(`Runtime protocol validation failed: ${problems.join('; ')}`);
    this.name = 'RuntimeProtocolValidationError';
  }
}

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
const UUID_REGEXP = new RegExp(UUID_PATTERN);

export function createRuntimeId(): string {
  return randomUUID();
}

export function isRuntimeId(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEXP.test(value);
}

export function getAgentRuntimeProtocolSchemaV1(): AgentRuntimeProtocolSchemaV1 {
  const commandVariants = Object.entries(AGENT_RUNTIME_COMMAND_DEFINITIONS_V1).map(
    ([type, data]) => ({
      type: 'object',
      properties: {
        protocolVersion: { const: 1 },
        commandId: { type: 'string', pattern: UUID_PATTERN },
        type: { const: type },
        data,
      },
      required: ['protocolVersion', 'commandId', 'type', 'data'],
      additionalProperties: false,
    })
  );
  const eventVariants = Object.entries(RUNTIME_EVENT_DEFINITIONS_V1).map(([type, data]) => ({
    type: 'object',
    properties: {
      type: { const: type },
      data,
    },
    required: ['type', 'data'],
    additionalProperties: false,
  }));

  return deepFreeze({
    protocolVersion: 1 as const,
    command: { oneOf: commandVariants },
    eventEnvelope: {
      type: 'object',
      properties: {
        protocolVersion: { const: 1 },
        eventId: { type: 'string', pattern: UUID_PATTERN },
        seq: { type: 'integer', minimum: 0 },
        threadId: { type: 'string', pattern: UUID_PATTERN },
        turnId: { type: 'string', pattern: UUID_PATTERN },
        stepId: { type: 'string', pattern: UUID_PATTERN },
        itemId: { type: 'string', pattern: UUID_PATTERN },
        durability: { enum: ['durable', 'ephemeral'] },
        timestamp: { type: 'integer', minimum: 0 },
        payload: { oneOf: eventVariants },
      },
      required: [
        'protocolVersion',
        'eventId',
        'seq',
        'threadId',
        'durability',
        'timestamp',
        'payload',
      ],
      additionalProperties: false,
    },
  });
}

export function assertAgentRuntimeCommandV1(value: unknown): asserts value is {
  protocolVersion: 1;
  commandId: string;
  type: AgentRuntimeCommandV1['type'];
  data: AgentRuntimeCommandV1['data'];
} {
  const problems: string[] = [];
  if (!isRecord(value)) {
    throw new RuntimeProtocolValidationError(['command must be an object']);
  }
  if (value.protocolVersion !== 1) problems.push('protocolVersion must equal 1');
  if (!isRuntimeId(value.commandId)) problems.push('commandId must be a UUID');
  if (typeof value.type !== 'string' || !(value.type in AGENT_RUNTIME_COMMAND_DEFINITIONS_V1)) {
    problems.push('type must be a known command');
  } else {
    validateSchema(
      value.data,
      AGENT_RUNTIME_COMMAND_DEFINITIONS_V1[
        value.type as keyof typeof AGENT_RUNTIME_COMMAND_DEFINITIONS_V1
      ],
      'data',
      problems
    );
  }
  if (problems.length > 0) throw new RuntimeProtocolValidationError(problems);
}

export function assertRuntimeEventEnvelopeV1(
  value: unknown
): asserts value is RuntimeEventEnvelopeV1 {
  const problems: string[] = [];
  if (!isRecord(value)) {
    throw new RuntimeProtocolValidationError(['event envelope must be an object']);
  }
  if (value.protocolVersion !== 1) problems.push('protocolVersion must equal 1');
  if (!isRuntimeId(value.eventId)) problems.push('eventId must be a UUID');
  if (!isRuntimeId(value.threadId)) problems.push('threadId must be a UUID');
  for (const field of ['turnId', 'stepId', 'itemId'] as const) {
    if (value[field] !== undefined && !isRuntimeId(value[field])) {
      problems.push(`${field} must be a UUID when present`);
    }
  }
  if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 0) {
    problems.push('seq must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(value.timestamp) || (value.timestamp as number) < 0) {
    problems.push('timestamp must be a non-negative safe integer');
  }
  if (value.durability !== 'durable' && value.durability !== 'ephemeral') {
    problems.push('durability must be durable or ephemeral');
  }
  if (!isRecord(value.payload) || typeof value.payload.type !== 'string') {
    problems.push('payload must be a typed event object');
  } else if (!(value.payload.type in RUNTIME_EVENT_DEFINITIONS_V1)) {
    problems.push('payload.type must be a known event');
  } else {
    validateSchema(
      value.payload.data,
      RUNTIME_EVENT_DEFINITIONS_V1[value.payload.type as keyof typeof RUNTIME_EVENT_DEFINITIONS_V1],
      'payload.data',
      problems
    );
    validateEventIdentity(value, value.payload.type as RuntimeEventTypeV1, problems);
  }
  if (problems.length > 0) throw new RuntimeProtocolValidationError(problems);
}

function validateEventIdentity(
  value: Record<string, unknown>,
  type: RuntimeEventTypeV1,
  problems: string[]
): void {
  if (type === 'item.delta') {
    if (value.durability !== 'ephemeral') problems.push('item.delta must be ephemeral');
  } else if (value.durability !== 'durable') {
    problems.push(`${type} must be durable`);
  }
  if (value.durability === 'durable' && (!Number.isSafeInteger(value.seq) || value.seq === 0)) {
    problems.push('durable events require seq >= 1');
  }
  if (
    type.startsWith('turn.') &&
    type !== 'turn.queued' &&
    type !== 'turn.queue_expired' &&
    !isRuntimeId(value.turnId)
  ) {
    problems.push(`${type} requires turnId`);
  }
  if (type.startsWith('item.')) {
    if (!isRuntimeId(value.turnId)) problems.push(`${type} requires turnId`);
    if (!isRuntimeId(value.stepId)) problems.push(`${type} requires stepId`);
    if (!isRuntimeId(value.itemId)) problems.push(`${type} requires itemId`);
  }
  if (type.startsWith('compact.') && !isRuntimeId(value.turnId)) {
    problems.push(`${type} requires turnId`);
  }
}

function validateSchema(
  value: unknown,
  schema: JsonSchema,
  path: string,
  problems: string[]
): void {
  if (schema.type === 'string') {
    if (typeof value !== 'string') {
      problems.push(`${path} must be a string`);
      return;
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      problems.push(`${path} must not be empty`);
    }
    if (schema.enum && !schema.enum.includes(value)) {
      problems.push(`${path} must be one of ${schema.enum.join(', ')}`);
    }
    return;
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (schema.type === 'integer' && !Number.isSafeInteger(value))
    ) {
      problems.push(`${path} must be a ${schema.type}`);
      return;
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      problems.push(`${path} must be >= ${schema.minimum}`);
    }
    return;
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') problems.push(`${path} must be a boolean`);
    return;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      problems.push(`${path} must be an array`);
      return;
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      problems.push(`${path} must contain at most ${schema.maxItems} items`);
    }
    value.forEach((entry, index) =>
      validateSchema(entry, schema.items, `${path}[${index}]`, problems)
    );
    return;
  }
  if (schema.type !== 'object') {
    problems.push(`${path} uses an unsupported schema`);
    return;
  }
  if (!isRecord(value)) {
    problems.push(`${path} must be an object`);
    return;
  }
  const required = new Set(schema.required ?? []);
  for (const key of required) {
    if (!(key in value)) problems.push(`${path}.${key} is required`);
  }
  for (const [key, entry] of Object.entries(value)) {
    const propertySchema = schema.properties[key];
    if (!propertySchema) {
      problems.push(`${path}.${key} is not allowed`);
      continue;
    }
    validateSchema(entry, propertySchema, `${path}.${key}`, problems);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return value;
}
