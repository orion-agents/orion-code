/// <reference lib="dom" />

import { OrionWebApi } from '../web/src/api';

type Listener = EventListenerOrEventListenerObject;

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly listeners = new Map<string, Listener[]>();
  readonly close = jest.fn();
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, data: string): void {
    const event = { data } as MessageEvent<string>;
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }
}

describe('OrionWebApi event stream', () => {
  const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();

  beforeEach(() => {
    jest.useFakeTimers();
    FakeEventSource.instances = [];
    for (const key of ['navigator', 'window', 'EventSource'] as const) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { onLine: true },
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        setTimeout,
        clearTimeout,
      },
    });
    Object.defineProperty(globalThis, 'EventSource', {
      configurable: true,
      value: FakeEventSource,
    });
  });

  afterEach(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
    jest.useRealTimers();
  });

  test('suspends permanently after replay reset until the caller creates a new stream', () => {
    const events: unknown[] = [];
    const api = new OrionWebApi();
    const handle = api.connectEvents({
      cursor: 7,
      onEvent: event => events.push(event),
      onStatus: jest.fn(),
    });
    const source = FakeEventSource.instances[0];
    expect(source?.url).toBe('/api/v1/events?cursor=7');

    source.emit('orion', JSON.stringify(replayResetEnvelope(10)));
    expect(events).toHaveLength(1);
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(handle.cursor()).toBe(10);

    source.emit('orion', JSON.stringify(runtimeEnvelope(11)));
    source.onerror?.({} as Event);
    jest.advanceTimersByTime(60_000);

    expect(events).toHaveLength(1);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(handle.cursor()).toBe(10);
    handle.close();
    handle.close();
  });

  test('accepts a tagged Session Runtime summary for background actor badges', () => {
    const events: unknown[] = [];
    const api = new OrionWebApi();
    const handle = api.connectEvents({
      cursor: 0,
      onEvent: event => events.push(event),
      onStatus: jest.fn(),
    });
    const source = FakeEventSource.instances[0];

    source.emit('orion', JSON.stringify(sessionRuntimeEnvelope(1)));

    expect(events).toEqual([
      expect.objectContaining({
        type: 'session_runtime_changed',
        sessionId: '20000000-0000-4000-8000-000000000002',
        payload: {
          runtime: expect.objectContaining({ phase: 'running', pendingApprovalCount: 0 }),
        },
      }),
    ]);
    handle.close();
  });

  test('requires queued Session Runtime summaries to carry an exact queue identity', () => {
    const events: unknown[] = [];
    const protocolErrors: string[] = [];
    const api = new OrionWebApi();
    const handle = api.connectEvents({
      cursor: 0,
      onEvent: event => events.push(event),
      onStatus: jest.fn(),
      onProtocolError: error => protocolErrors.push(error),
    });
    const source = FakeEventSource.instances[0];
    const queued = sessionRuntimeEnvelope(1) as {
      payload: { runtime: Record<string, unknown> };
    };
    queued.payload.runtime.phase = 'queued';
    queued.payload.runtime.queueId = '40000000-0000-4000-8000-000000000004';
    queued.payload.runtime.queuePosition = 1;
    source.emit('orion', JSON.stringify(queued));
    expect(events).toHaveLength(1);

    const malformed = sessionRuntimeEnvelope(2) as {
      payload: { runtime: Record<string, unknown> };
    };
    malformed.payload.runtime.phase = 'queued';
    malformed.payload.runtime.queuePosition = 1;
    source.emit('orion', JSON.stringify(malformed));
    expect(protocolErrors).toEqual(['Session Runtime 状态事件无效。']);
    expect(events).toHaveLength(1);
    handle.close();
  });

  test('accepts only one-based queued Workspace mutation state for an identified Session', () => {
    const events: unknown[] = [];
    const protocolErrors: string[] = [];
    const api = new OrionWebApi();
    const handle = api.connectEvents({
      cursor: 0,
      onEvent: event => events.push(event),
      onStatus: jest.fn(),
      onProtocolError: error => protocolErrors.push(error),
    });
    const source = FakeEventSource.instances[0];
    const valid = workspaceMutationEnvelope(1);
    source.emit('orion', JSON.stringify(valid));
    expect(events).toEqual([
      expect.objectContaining({
        type: 'workspace_mutation_changed',
        payload: { state: { callId: 'call-write', phase: 'queued', queuePosition: 1 } },
      }),
    ]);

    const malformed = workspaceMutationEnvelope(2) as {
      payload: { state: Record<string, unknown> };
    };
    malformed.payload.state.queuePosition = 0;
    source.emit('orion', JSON.stringify(malformed));
    expect(protocolErrors).toEqual(['Workspace mutation 状态事件无效。']);
    expect(events).toHaveLength(1);
    handle.close();
  });
});

describe('OrionWebApi collection pagination', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('loads one Session page at a time and forwards the explicit continuation cursor', async () => {
    const firstSession = sessionSummary('session-1');
    const secondSession = sessionSummary('session-2');
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ items: [firstSession], nextCursor: 'session-cursor-1' })
      )
      .mockResolvedValueOnce(jsonResponse({ items: [secondSession], nextCursor: null }));
    const api = new OrionWebApi();
    const context = {
      expectedContextRevision: '10000000-0000-4000-8000-000000000001',
      workspaceId: '20000000-0000-4000-8000-000000000002',
    };

    await expect(api.listSessions(context)).resolves.toEqual({
      sessions: [firstSession],
      nextCursor: 'session-cursor-1',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      '/api/v1/sessions?expectedContextRevision=10000000-0000-4000-8000-000000000001&workspaceId=20000000-0000-4000-8000-000000000002&pageSize=100'
    );

    await expect(api.listSessions(context, 'session-cursor-1')).resolves.toEqual({
      sessions: [secondSession],
      nextCursor: null,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[1]?.[0])).toBe(
      '/api/v1/sessions?expectedContextRevision=10000000-0000-4000-8000-000000000001&workspaceId=20000000-0000-4000-8000-000000000002&pageSize=100&cursor=session-cursor-1'
    );
  });
});

function replayResetEnvelope(cursor: number): object {
  return {
    apiVersion: 1,
    eventId: `30000000-0000-4000-8000-${String(cursor).padStart(12, '0')}`,
    cursor,
    sessionId: null,
    threadId: null,
    durable: true,
    timestamp: new Date(cursor).toISOString(),
    type: 'replay_reset',
    payload: { reason: 'retained history expired', snapshotRequired: true },
  };
}

function runtimeEnvelope(cursor: number): object {
  return {
    apiVersion: 1,
    eventId: `40000000-0000-4000-8000-${String(cursor).padStart(12, '0')}`,
    cursor,
    sessionId: 'session-1',
    threadId: 'thread-1',
    durable: false,
    timestamp: new Date(cursor).toISOString(),
    type: 'runtime_event',
    payload: {
      eventType: 'status_changed',
      value: { type: 'status_changed', message: 'must be ignored' },
    },
  };
}

function sessionRuntimeEnvelope(cursor: number): object {
  const sessionId = '20000000-0000-4000-8000-000000000002';
  return {
    apiVersion: 1,
    eventId: `50000000-0000-4000-8000-${String(cursor).padStart(12, '0')}`,
    cursor,
    sessionId,
    threadId: null,
    durable: true,
    timestamp: new Date(cursor).toISOString(),
    type: 'session_runtime_changed',
    payload: {
      runtime: {
        workspaceId: '10000000-0000-4000-8000-000000000001',
        sessionId,
        runtimeRevision: '30000000-0000-4000-8000-000000000003',
        phase: 'running',
        pendingApprovalCount: 0,
        resident: true,
        estimatedBytes: 1024,
        updatedAt: new Date(cursor).toISOString(),
      },
    },
  };
}

function workspaceMutationEnvelope(cursor: number): object {
  return {
    apiVersion: 1,
    eventId: `60000000-0000-4000-8000-${String(cursor).padStart(12, '0')}`,
    cursor,
    sessionId: '20000000-0000-4000-8000-000000000002',
    threadId: null,
    durable: false,
    timestamp: new Date(cursor).toISOString(),
    type: 'workspace_mutation_changed',
    payload: {
      state: { callId: 'call-write', phase: 'queued', queuePosition: 1 },
    },
  };
}

function sessionSummary(id: string): object {
  return {
    id,
    projectPath: '/workspace',
    name: id,
    model: 'test-model',
    createdAt: new Date(1).toISOString(),
    updatedAt: new Date(1).toISOString(),
    messageCount: 1,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
