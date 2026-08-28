import { randomUUID } from 'crypto';
import type { ServerResponse } from 'http';

import type { AgentRuntimeEvent } from '../runtime/agent-runtime-protocol';
import type { RuntimeEventEnvelopeV1 } from '../runtime/protocol/runtime-protocol-v1';
import type { ToolAuthorizationSource, ToolAuthorizationView } from '../runtime/ui-events';
import { redactTraceText } from '../services/redaction';
import { WEB_API_VERSION, type WebEventEnvelopeV1, type WebWorkbenchEventV1 } from './protocol';

export interface WebEventHubOptions {
  readonly maxEvents?: number;
  readonly maxBytes?: number;
  readonly now?: () => number;
}

interface RetainedEvent {
  readonly envelope: WebEventEnvelopeV1;
  readonly encoded: string;
  readonly bytes: number;
}

const DEFAULT_MAX_EVENTS = 10_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const TOOL_AUTHORIZATION_SOURCES = new Set<ToolAuthorizationSource>([
  'tool_policy',
  'config_allow',
  'config_deny',
  'user',
  'missing_confirmation',
  'drift_guard',
  'mode_auto',
  'mode_accept_edits',
  'allowlist_allow',
  'allowlist_deny',
  'allowlist_ask',
  'missing_risk_metadata',
  'risk_guard',
  'config_allow_blocked',
]);

/** Bounded fan-out and reconnect replay for browser consumers. */
export class WebEventHub {
  private readonly retained: RetainedEvent[] = [];
  private readonly clients = new Set<ServerResponse>();
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private nextCursor = 1;
  private retainedBytes = 0;

  constructor(options: WebEventHubOptions = {}) {
    this.maxEvents = positiveInteger(options.maxEvents ?? DEFAULT_MAX_EVENTS, 'maxEvents');
    this.maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, 'maxBytes');
    this.now = options.now ?? Date.now;
  }

  emitRuntime(
    event: AgentRuntimeEvent,
    context: { readonly sessionId?: string; readonly threadId?: string } = {}
  ): WebEventEnvelopeV1 {
    return this.emit(
      { type: 'runtime_event', value: sanitizeRuntimeEvent(event) },
      isDurableRuntimeEvent(event),
      context
    );
  }

  emitThread(event: RuntimeEventEnvelopeV1, sessionId: string): WebEventEnvelopeV1 {
    return this.emit({ type: 'thread_event', value: sanitizeThreadEvent(event) }, true, {
      sessionId,
      threadId: event.threadId,
    });
  }

  emit(
    event: WebWorkbenchEventV1,
    durable = true,
    context: { readonly sessionId?: string; readonly threadId?: string } = {}
  ): WebEventEnvelopeV1 {
    const base = {
      apiVersion: WEB_API_VERSION,
      eventId: randomUUID(),
      cursor: this.nextCursor++,
      sessionId: context.sessionId ?? null,
      threadId: context.threadId ?? null,
      durable,
      timestamp: new Date(this.now()).toISOString(),
    } as const;
    const envelope = Object.freeze(toEnvelope(base, event));
    const encoded = encodeSse(envelope);
    const retained = { envelope, encoded, bytes: Buffer.byteLength(encoded) };
    this.retained.push(retained);
    this.retainedBytes += retained.bytes;
    this.trim();
    for (const client of this.clients) {
      if (!writeClient(client, encoded)) this.clients.delete(client);
    }
    return envelope;
  }

  attach(response: ServerResponse, cursor: number): () => void {
    const earliest = this.retained[0]?.envelope.cursor ?? this.nextCursor;
    const latest = this.nextCursor - 1;
    if (cursor > latest || cursor < earliest - 1) {
      const reset: WebEventEnvelopeV1 = {
        apiVersion: WEB_API_VERSION,
        eventId: randomUUID(),
        cursor: latest,
        sessionId: null,
        threadId: null,
        type: 'replay_reset',
        durable: true,
        timestamp: new Date(this.now()).toISOString(),
        payload: {
          reason: 'Requested cursor is outside retained history.',
          snapshotRequired: true,
        },
      };
      if (!writeClient(response, encodeSse(reset))) return () => undefined;
    } else {
      for (const item of this.retained) {
        if (item.envelope.cursor > cursor && !writeClient(response, item.encoded)) {
          return () => undefined;
        }
      }
    }
    this.clients.add(response);
    return () => this.clients.delete(response);
  }

  heartbeat(): void {
    for (const client of this.clients) {
      if (!writeClient(client, ': heartbeat\n\n')) this.clients.delete(client);
    }
  }

  close(): void {
    for (const client of this.clients) client.end();
    this.clients.clear();
  }

  snapshot(): { readonly earliest: number; readonly latest: number; readonly retained: number } {
    return Object.freeze({
      earliest: this.retained[0]?.envelope.cursor ?? this.nextCursor,
      latest: this.nextCursor - 1,
      retained: this.retained.length,
    });
  }

  private trim(): void {
    while (this.retained.length > this.maxEvents || this.retainedBytes > this.maxBytes) {
      const removed = this.retained.shift();
      if (!removed) break;
      this.retainedBytes -= removed.bytes;
    }
  }
}

function toEnvelope(
  base: {
    readonly apiVersion: 1;
    readonly eventId: string;
    readonly cursor: number;
    readonly sessionId: string | null;
    readonly threadId: string | null;
    readonly durable: boolean;
    readonly timestamp: string;
  },
  event: WebWorkbenchEventV1
): WebEventEnvelopeV1 {
  switch (event.type) {
    case 'runtime_event':
      return {
        ...base,
        type: event.type,
        payload: { eventType: event.value.type, value: event.value },
      };
    case 'thread_event':
      if (!base.sessionId || !base.threadId) {
        throw new Error('Thread events require session and thread identity');
      }
      return {
        ...base,
        sessionId: base.sessionId,
        threadId: base.threadId,
        durable: true,
        type: event.type,
        payload: {
          sequence: event.value.seq,
          eventType: event.value.payload.type,
          value: event.value,
        },
      };
    case 'workbench_state':
      return {
        ...base,
        type: event.type,
        payload: { workspace: event.workspace, activeSessionId: event.activeSessionId },
      };
    case 'settings_invalidated':
      return {
        ...base,
        durable: false,
        type: event.type,
        payload: {
          revision: event.revision,
          reason: event.reason,
          state: event.state,
        },
      };
    case 'replay_reset':
      return {
        ...base,
        durable: true,
        type: event.type,
        payload: { reason: event.reason, snapshotRequired: true },
      };
  }
}

function isDurableRuntimeEvent(event: AgentRuntimeEvent): boolean {
  return ![
    'status_changed',
    'processing_changed',
    'transcript_update',
    'loop_stats_updated',
  ].includes(event.type);
}

function sanitizeRuntimeEvent(event: AgentRuntimeEvent): AgentRuntimeEvent {
  const sanitized = sanitizeValue(event) as AgentRuntimeEvent;
  if (event.type !== 'tool_finished' || sanitized.type !== 'tool_finished') return sanitized;
  const authorization = sanitizeToolAuthorization(event.event.authorization);
  if (!authorization) return sanitized;
  return {
    ...sanitized,
    event: { ...sanitized.event, authorization },
  };
}

function sanitizeToolAuthorization(
  authorization: ToolAuthorizationView | undefined
): ToolAuthorizationView | undefined {
  if (
    !authorization ||
    typeof authorization.approved !== 'boolean' ||
    !TOOL_AUTHORIZATION_SOURCES.has(authorization.source)
  ) {
    return undefined;
  }
  const behavior = authorization.behavior;
  return {
    approved: authorization.approved,
    source: authorization.source,
    ...(behavior === 'allow' || behavior === 'ask' || behavior === 'deny' ? { behavior } : {}),
    ...(typeof authorization.reason === 'string'
      ? { reason: redactTraceText(authorization.reason) }
      : {}),
  };
}

function sanitizeThreadEvent(event: RuntimeEventEnvelopeV1): RuntimeEventEnvelopeV1 {
  return sanitizeValue(event) as RuntimeEventEnvelopeV1;
}

function sanitizeValue(value: unknown, key = ''): unknown {
  if (typeof value === 'string') return redactTraceText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.map(item => sanitizeValue(item));
  if (!value || typeof value !== 'object') return undefined;
  const result: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (
      /^(?:api[-_]?key|authorization|cookie|password|secret|access[-_]?token|refresh[-_]?token|auth[-_]?token|credential)$/i.test(
        childKey
      )
    ) {
      continue;
    }
    if (childKey === 'abortSignal') continue;
    result[childKey] = sanitizeValue(childValue, childKey);
  }
  void key;
  return result;
}

function encodeSse(envelope: WebEventEnvelopeV1): string {
  return `id: ${envelope.cursor}\nevent: orion\ndata: ${JSON.stringify(envelope)}\n\n`;
}

function writeClient(response: ServerResponse, data: string): boolean {
  if (response.destroyed || response.writableEnded) return false;
  try {
    if (!response.write(data)) {
      // `false` is backpressure, not a transport failure. End the chunked
      // response cleanly so EventSource can retain the last delivered cursor
      // and resume from it. Destroying here discards buffered bytes on Node 20
      // and traps the browser in an incomplete-chunk reconnect loop.
      response.end();
      return false;
    }
    return true;
  } catch {
    response.destroy();
    return false;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be positive`);
  return value;
}
