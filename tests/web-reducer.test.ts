/// <reference lib="dom" />

import type { AgentRuntimeEvent } from '../src/runtime/agent-runtime-protocol';
import type { WebEventEnvelopeV1, WebSessionSnapshotV1 } from '../src/web/protocol';
import {
  activeSessionSnapshotSync,
  initialWorkbenchState,
  isActiveSessionSnapshotReady,
  isActiveSessionActionPending,
  isSessionActionPending,
  canReuseSessionSnapshot,
} from '../web/src/types';
import { workbenchReducer } from '../web/src/reducer';

describe('Web Workbench reducer', () => {
  test('starts with an idle Session snapshot state', () => {
    expect(activeSessionSnapshotSync(initialWorkbenchState)).toEqual({
      status: 'idle',
      requestId: null,
    });
  });

  test('keeps an approval pending when the matching invocation starts', () => {
    const permission = runtimeEnvelope(
      {
        type: 'permission_requested',
        request: {
          id: 'permission-1',
          name: 'write_file',
          args: { path: 'fixture.txt' },
        },
      },
      1
    );
    const started = runtimeEnvelope(
      {
        type: 'tool_started',
        event: {
          callId: 'call-1',
          name: 'write_file',
          args: { path: 'fixture.txt' },
          sequence: 1,
        },
      },
      2
    );

    const selected = workbenchReducer(initialWorkbenchState, {
      type: 'reset_session_view',
      activeSessionId: 'session-1',
    });
    const awaiting = workbenchReducer(selected, {
      type: 'event_received',
      envelope: permission,
    });
    const running = workbenchReducer(awaiting, {
      type: 'event_received',
      envelope: started,
    });

    expect(running.permission).toMatchObject({ id: 'permission-1', name: 'write_file' });
    expect(running.tools).toEqual([
      expect.objectContaining({ callId: 'call-1', name: 'write_file', state: 'running' }),
    ]);
  });

  test('projects a Session-owned Workspace write queue onto the matching tool card', () => {
    const selected = workbenchReducer(initialWorkbenchState, {
      type: 'reset_session_view',
      activeSessionId: 'session-1',
    });
    const running = workbenchReducer(selected, {
      type: 'event_received',
      envelope: runtimeEnvelope(
        {
          type: 'tool_started',
          event: {
            callId: 'call-write',
            name: 'write_file',
            args: { path: 'fixture.txt' },
            sequence: 1,
          },
        },
        1
      ),
    });
    const queuedEnvelope: WebEventEnvelopeV1 = {
      apiVersion: 1,
      eventId: '50000000-0000-4000-8000-000000000002',
      cursor: 2,
      sessionId: 'session-1',
      threadId: null,
      durable: false,
      timestamp: new Date(2).toISOString(),
      type: 'workspace_mutation_changed',
      payload: {
        state: { callId: 'call-write', phase: 'queued', queuePosition: 1 },
      },
    };

    const queued = workbenchReducer(running, {
      type: 'event_received',
      envelope: queuedEnvelope,
    });

    expect(queued.tools).toEqual([
      expect.objectContaining({
        callId: 'call-write',
        workspaceMutation: { phase: 'queued', queuePosition: 1 },
      }),
    ]);
    expect(queued.announcement).toBe('工具 write_file 正在等待工作树写入');
  });

  test('prepends an older transcript page without duplicating the cursor boundary', () => {
    const latest = snapshot(
      [
        { id: 'session-1:message:3', content: 'three' },
        { id: 'session-1:message:4', content: 'four' },
      ],
      'older-page'
    );
    const older = snapshot(
      [
        { id: 'session-1:message:1', content: 'one' },
        { id: 'session-1:message:2', content: 'two' },
        { id: 'session-1:message:3', content: 'three' },
      ],
      null
    );

    const selected = workbenchReducer(initialWorkbenchState, {
      type: 'reset_session_view',
      activeSessionId: 'session-1',
    });
    const restored = workbenchReducer(selected, {
      type: 'session_snapshot_loaded',
      snapshot: latest,
    });
    const paged = workbenchReducer(restored, {
      type: 'older_transcript_loaded',
      snapshot: older,
    });

    expect(paged.transcript.map(entry => entry.content)).toEqual(['one', 'two', 'three', 'four']);
    expect(paged.sessionSnapshot?.transcript.nextCursor).toBeNull();
    expect(paged.announcement).toBe('已加载 2 条更早记录');
  });

  test('appends collection pages by stable identity and advances only their cursor', () => {
    const first = workbenchReducer(initialWorkbenchState, {
      type: 'sessions_loaded',
      sessions: [sessionSummary('session-1', 'first'), sessionSummary('session-2', 'old')],
      nextCursor: 'page-2',
    });
    const second = workbenchReducer(first, {
      type: 'sessions_loaded',
      sessions: [sessionSummary('session-2', 'updated'), sessionSummary('session-3', 'third')],
      nextCursor: null,
      append: true,
    });

    expect(second.sessions.map(session => [session.id, session.name])).toEqual([
      ['session-1', 'first'],
      ['session-2', 'updated'],
      ['session-3', 'third'],
    ]);
    expect(second.sessionNextCursor).toBeNull();
  });

  test('ignores a stale snapshot after the selected session changes', () => {
    const selected = workbenchReducer(initialWorkbenchState, {
      type: 'reset_session_view',
      activeSessionId: 'session-2',
    });
    const stale = workbenchReducer(selected, {
      type: 'session_snapshot_loaded',
      snapshot: snapshot([{ id: 'session-1:message:1', content: 'stale' }], null),
    });

    expect(stale).toBe(selected);
    expect(stale.activeSessionId).toBe('session-2');
    expect(stale.transcript).toEqual([]);
  });

  test('ignores a stale snapshot failure after the selected Session changes', () => {
    const selected = workbenchReducer(initialWorkbenchState, {
      type: 'reset_session_view',
      activeSessionId: 'session-2',
    });
    const stale = workbenchReducer(selected, {
      type: 'snapshot_failed',
      sessionId: 'session-1',
      detail: 'stale failure',
    });

    expect(stale).toBe(selected);
    expect(stale.connection).not.toBe('replay-required');
  });

  test('keeps the Web Host live when the selected Session snapshot fails', () => {
    const selected = workbenchReducer(
      { ...initialWorkbenchState, connection: 'live' },
      {
        type: 'reset_session_view',
        activeSessionId: 'session-2',
      }
    );
    const failed = workbenchReducer(selected, {
      type: 'snapshot_failed',
      sessionId: 'session-2',
      detail: 'matching failure',
    });

    expect(failed.connection).toBe('live');
    expect(failed.replayReason).toBeUndefined();
    expect(failed.sessionSync['session-2']).toEqual({
      status: 'failed',
      requestId: null,
      error: 'matching failure',
    });
    expect(failed.notice).toMatchObject({
      domain: 'session-snapshot',
      sessionId: 'session-2',
    });
    expect(isActiveSessionSnapshotReady(failed)).toBe(false);
  });

  test('tracks cold loads and cached refreshes as separate Session snapshot phases', () => {
    const cold = workbenchReducer(initialWorkbenchState, {
      type: 'reset_session_view',
      activeSessionId: 'session-1',
    });
    expect(cold.sessionSync['session-1']?.status).toBe('loading');

    const ready = workbenchReducer(cold, {
      type: 'session_snapshot_loaded',
      snapshot: snapshotFor('session-1', 'cached content'),
    });
    const cached = workbenchReducer(ready, {
      type: 'reset_session_view',
      activeSessionId: 'session-1',
    });
    expect(cached.sessionSync['session-1']?.status).toBe('refreshing');
    expect(cached.transcript.map(entry => entry.content)).toEqual(['cached content']);
    expect(isActiveSessionSnapshotReady(cached)).toBe(false);
  });

  test('clears only the matching Session snapshot error after a successful retry', () => {
    const selected = workbenchReducer(
      {
        ...initialWorkbenchState,
        connection: 'live',
        contextRevision: 'context-1',
        workspaceId: 'workspace-1',
      },
      { type: 'reset_session_view', activeSessionId: 'session-1' }
    );
    const started = workbenchReducer(selected, {
      type: 'session_snapshot_started',
      sessionId: 'session-1',
      requestId: 1,
      cached: false,
      contextRevision: 'context-1',
      workspaceId: 'workspace-1',
    });
    const failed = workbenchReducer(started, {
      type: 'snapshot_failed',
      sessionId: 'session-1',
      requestId: 1,
      contextRevision: 'context-1',
      workspaceId: 'workspace-1',
      detail: 'temporary failure',
    });
    const retrying = workbenchReducer(failed, {
      type: 'session_snapshot_started',
      sessionId: 'session-1',
      requestId: 2,
      cached: false,
      contextRevision: 'context-1',
      workspaceId: 'workspace-1',
    });
    const restored = workbenchReducer(retrying, {
      type: 'session_snapshot_loaded',
      snapshot: snapshotFor('session-1', 'restored'),
      requestId: 2,
      contextRevision: 'context-1',
      workspaceId: 'workspace-1',
    });

    expect(restored.connection).toBe('live');
    expect(restored.sessionSync['session-1']).toEqual({ status: 'ready', requestId: 2 });
    expect(restored.notice).toBeNull();
    expect(restored.transcript.map(entry => entry.content)).toEqual(['restored']);
    expect(isActiveSessionSnapshotReady(restored)).toBe(true);
  });

  test('ignores an older response for the same Session request sequence', () => {
    const contextual = {
      ...initialWorkbenchState,
      connection: 'live' as const,
      contextRevision: 'context-1',
      workspaceId: 'workspace-1',
    };
    const selected = workbenchReducer(contextual, {
      type: 'reset_session_view',
      activeSessionId: 'session-1',
    });
    const first = workbenchReducer(selected, {
      type: 'session_snapshot_started',
      sessionId: 'session-1',
      requestId: 1,
      cached: false,
      contextRevision: 'context-1',
      workspaceId: 'workspace-1',
    });
    const second = workbenchReducer(first, {
      type: 'session_snapshot_started',
      sessionId: 'session-1',
      requestId: 2,
      cached: false,
      contextRevision: 'context-1',
      workspaceId: 'workspace-1',
    });
    const stale = workbenchReducer(second, {
      type: 'session_snapshot_loaded',
      snapshot: snapshotFor('session-1', 'stale'),
      requestId: 1,
      contextRevision: 'context-1',
      workspaceId: 'workspace-1',
    });
    const latest = workbenchReducer(stale, {
      type: 'session_snapshot_loaded',
      snapshot: snapshotFor('session-1', 'latest'),
      requestId: 2,
      contextRevision: 'context-1',
      workspaceId: 'workspace-1',
    });

    expect(stale).toBe(second);
    expect(latest.transcript.map(entry => entry.content)).toEqual(['latest']);
    expect(latest.sessionSync['session-1']).toEqual({ status: 'ready', requestId: 2 });
  });

  test('tracks Session switch, cache-hit, load and failure client telemetry', () => {
    const contextual = {
      ...initialWorkbenchState,
      connection: 'live' as const,
      contextRevision: 'context-1',
      workspaceId: 'workspace-1',
    };
    const cold = workbenchReducer(contextual, {
      type: 'reset_session_view',
      activeSessionId: 'session-1',
    });
    expect(cold.clientTelemetry).toEqual({
      sessionSwitches: 1,
      snapshotCacheHits: 0,
      snapshotLoads: 0,
      snapshotFailures: 0,
    });

    const started = workbenchReducer(cold, {
      type: 'session_snapshot_started',
      sessionId: 'session-1',
      requestId: 1,
      cached: false,
      contextRevision: 'context-1',
      workspaceId: 'workspace-1',
    });
    expect(started.clientTelemetry.snapshotLoads).toBe(1);

    const failed = workbenchReducer(started, {
      type: 'snapshot_failed',
      sessionId: 'session-1',
      requestId: 1,
      contextRevision: 'context-1',
      workspaceId: 'workspace-1',
      detail: 'temporary failure',
    });
    expect(failed.clientTelemetry.snapshotFailures).toBe(1);

    // Cache a background Session, then switch to it: a switch plus a cache hit,
    // and the cached transcript renders without clearing.
    const backgroundStarted = workbenchReducer(failed, {
      type: 'session_snapshot_started',
      sessionId: 'session-2',
      requestId: 2,
      cached: true,
      contextRevision: 'context-1',
      workspaceId: 'workspace-1',
    });
    const backgroundCached = workbenchReducer(backgroundStarted, {
      type: 'session_snapshot_loaded',
      snapshot: snapshotFor('session-2', 'cached content'),
      requestId: 2,
      contextRevision: 'context-1',
      workspaceId: 'workspace-1',
    });
    const warm = workbenchReducer(backgroundCached, {
      type: 'reset_session_view',
      activeSessionId: 'session-2',
    });
    expect(warm.clientTelemetry).toEqual({
      sessionSwitches: 2,
      snapshotCacheHits: 1,
      snapshotLoads: 2, // foreground session-1 load + background session-2 prefetch
      snapshotFailures: 1,
    });
    expect(warm.transcript.map(entry => entry.content)).toEqual(['cached content']);
    expect(warm.sessionSync['session-2']?.status).toBe('ready');
  });

  test('caches a completed non-foreground snapshot without replacing the selected Session', () => {
    const contextual = {
      ...initialWorkbenchState,
      connection: 'live' as const,
      contextRevision: 'context-1',
      workspaceId: 'workspace-1',
    };
    const selected = workbenchReducer(contextual, {
      type: 'reset_session_view',
      activeSessionId: 'session-2',
    });
    const foreground = workbenchReducer(selected, {
      type: 'session_snapshot_loaded',
      snapshot: snapshotFor('session-2', 'foreground'),
    });
    const loadingBackground = workbenchReducer(foreground, {
      type: 'session_snapshot_started',
      sessionId: 'session-1',
      requestId: 3,
      cached: false,
      contextRevision: 'context-1',
      workspaceId: 'workspace-1',
    });
    const completed = workbenchReducer(loadingBackground, {
      type: 'session_snapshot_loaded',
      snapshot: snapshotFor('session-1', 'prefetched'),
      requestId: 3,
      contextRevision: 'context-1',
      workspaceId: 'workspace-1',
    });

    expect(completed.activeSessionId).toBe('session-2');
    expect(completed.transcript.map(entry => entry.content)).toEqual(['foreground']);
    expect(completed.sessionProjectionById['session-1']?.transcript.items).toEqual([
      expect.objectContaining({ content: 'prefetched' }),
    ]);
    expect(completed.sessionSync['session-1']).toEqual({ status: 'ready', requestId: 3 });
  });

  test('keeps a background prefetch failure local to that Session', () => {
    const contextual = {
      ...initialWorkbenchState,
      connection: 'live' as const,
      contextRevision: 'context-1',
      workspaceId: 'workspace-1',
    };
    const selected = workbenchReducer(contextual, {
      type: 'reset_session_view',
      activeSessionId: 'session-2',
    });
    const foreground = workbenchReducer(selected, {
      type: 'session_snapshot_loaded',
      snapshot: snapshotFor('session-2', 'foreground'),
    });
    const loadingBackground = workbenchReducer(foreground, {
      type: 'session_snapshot_started',
      sessionId: 'session-1',
      requestId: 4,
      cached: false,
      contextRevision: 'context-1',
      workspaceId: 'workspace-1',
    });
    const failed = workbenchReducer(loadingBackground, {
      type: 'snapshot_failed',
      sessionId: 'session-1',
      requestId: 4,
      contextRevision: 'context-1',
      workspaceId: 'workspace-1',
      detail: 'prefetch failed',
    });

    expect(failed.connection).toBe('live');
    expect(failed.activeSessionId).toBe('session-2');
    expect(failed.transcript.map(entry => entry.content)).toEqual(['foreground']);
    expect(failed.notice).toBeNull();
    expect(failed.sessionSync['session-1']).toEqual({
      status: 'failed',
      requestId: 4,
      error: 'prefetch failed',
    });
  });

  test('accepts a cold snapshot for the browser-selected Session', () => {
    const selected = workbenchReducer(initialWorkbenchState, {
      type: 'reset_session_view',
      activeSessionId: 'session-1',
    });
    const activeSnapshot = snapshot([{ id: 'session-1:message:1', content: 'current' }], null);
    const inactiveSnapshot: WebSessionSnapshotV1 = {
      ...activeSnapshot,
      eventCursor: 20,
      sessionRuntime: {
        ...activeSnapshot.sessionRuntime,
        phase: 'cold',
        resident: false,
        estimatedBytes: 0,
      },
      runtime: { ...activeSnapshot.runtime, active: false },
      composer: {
        ...activeSnapshot.composer,
        sessionRuntime: {
          ...activeSnapshot.composer.sessionRuntime,
          phase: 'cold',
          resident: false,
          estimatedBytes: 0,
        },
      },
      transcript: {
        items: [
          {
            id: 'session-1:message:2',
            role: 'assistant',
            content: 'stale',
            timestamp: 2,
          },
        ],
        nextCursor: null,
      },
    };

    const restored = workbenchReducer(selected, {
      type: 'session_snapshot_loaded',
      snapshot: inactiveSnapshot,
    });

    expect(restored).not.toBe(selected);
    expect(restored.lastCursor).toBe(0);
    expect(restored.sessionSync['session-1'].snapshotEventCursor).toBe(20);
    expect(restored.transcript).toEqual([
      expect.objectContaining({ id: 'session-1:message:2', content: 'stale' }),
    ]);
    expect(restored.sessionSnapshot?.sessionRuntime).toMatchObject({
      phase: 'cold',
      resident: false,
    });
  });

  test('bounds the browser Session projection cache by least-recently-loaded entries', () => {
    let state = initialWorkbenchState;
    for (let index = 0; index < 10; index += 1) {
      const sessionId = `session-${index}`;
      state = workbenchReducer(state, { type: 'reset_session_view', activeSessionId: sessionId });
      state = workbenchReducer(state, {
        type: 'session_snapshot_loaded',
        snapshot: snapshotFor(sessionId, `content-${index}`),
      });
    }

    expect(Object.keys(state.sessionProjectionById)).toEqual(
      Array.from({ length: 8 }, (_, index) => `session-${index + 2}`)
    );
    expect(state.activeSessionId).toBe('session-9');
  });

  test('merges durable Goal and Plan metadata without replacing the live transcript', () => {
    const selected = {
      ...workbenchReducer(initialWorkbenchState, {
        type: 'reset_session_view' as const,
        activeSessionId: 'session-1',
      }),
      contextRevision: 'context-1',
      workspaceId: 'workspace-1',
    };
    const restored = workbenchReducer(selected, {
      type: 'session_snapshot_loaded',
      snapshot: snapshot([{ id: 'session-1:message:1', content: 'live transcript' }], null),
    });
    const current = {
      ...restored,
      composer: {
        ...restored.composer!,
        controlRevision: 'control-new',
        mode: { baseMode: 'plan' as const, pendingBaseMode: null },
      },
    };
    const durableSnapshot: WebSessionSnapshotV1 = {
      ...snapshot([{ id: 'session-1:message:1', content: 'must not replace live' }], null),
      session: { ...snapshot([], null).session, name: 'Updated Session' },
      eventCursor: 99,
      plan: {
        body: '# Durable Plan',
        returnMode: 'build',
        digest: 'a'.repeat(64),
      },
    };

    const merged = workbenchReducer(current, {
      type: 'durable_session_metadata_loaded',
      snapshot: durableSnapshot,
      contextRevision: 'context-1',
      workspaceId: 'workspace-1',
    });

    expect(merged.transcript.map(entry => entry.content)).toEqual(['live transcript']);
    expect(merged.lastCursor).toBe(restored.lastCursor);
    expect(merged.plan?.body).toBe('# Durable Plan');
    expect(merged.composer).toMatchObject({
      controlRevision: 'control-new',
      mode: { baseMode: 'plan' },
    });
    expect(merged.sessionSnapshot?.plan?.digest).toBe('a'.repeat(64));
    expect(merged.sessions.find(session => session.id === 'session-1')?.name).toBe(
      'Updated Session'
    );

    const stale = workbenchReducer(merged, {
      type: 'durable_session_metadata_loaded',
      snapshot: { ...durableSnapshot, plan: { ...durableSnapshot.plan!, body: '# Stale' } },
      contextRevision: 'context-old',
      workspaceId: 'workspace-1',
    });
    expect(stale).toBe(merged);
  });

  test('advances the active snapshot Runtime revision with Composer state', () => {
    const selected = {
      ...workbenchReducer(initialWorkbenchState, {
        type: 'reset_session_view' as const,
        activeSessionId: 'session-1',
      }),
      contextRevision: 'context-1',
      workspaceId: 'workspace-1',
    };
    const restored = workbenchReducer(selected, {
      type: 'session_snapshot_loaded',
      snapshot: snapshot([], null),
    });
    const sessionRuntime = {
      ...restored.sessionSnapshot!.sessionRuntime,
      runtimeRevision: 'runtime-2',
    };
    const composer = {
      ...restored.composer!,
      controlRevision: 'control-2',
      sessionRuntime,
    };
    const envelope: WebEventEnvelopeV1 = {
      apiVersion: 1,
      eventId: '60000000-0000-4000-8000-000000000002',
      cursor: 2,
      sessionId: 'session-1',
      threadId: null,
      durable: true,
      timestamp: new Date(2).toISOString(),
      type: 'composer_state_changed',
      payload: { state: composer },
    };

    const advanced = workbenchReducer(restored, { type: 'event_received', envelope });

    expect(advanced.composer?.sessionRuntime.runtimeRevision).toBe('runtime-2');
    expect(advanced.sessionSnapshot?.sessionRuntime.runtimeRevision).toBe('runtime-2');
    expect(advanced.sessionSnapshot?.composer.controlRevision).toBe('control-2');
    expect(advanced.sessionRuntimeById['session-1']?.runtimeRevision).toBe('runtime-2');
    expect(advanced.sessionProjectionById['session-1']?.sessionRuntime.runtimeRevision).toBe(
      'runtime-2'
    );
  });

  test('caches a completed background Session snapshot without replacing the foreground view', () => {
    const selected = {
      ...workbenchReducer(initialWorkbenchState, {
        type: 'reset_session_view' as const,
        activeSessionId: 'session-1',
      }),
      contextRevision: 'context-1',
      workspaceId: 'workspace-1',
    };
    const foreground = workbenchReducer(selected, {
      type: 'session_snapshot_loaded',
      snapshot: snapshotFor('session-1', 'foreground content'),
    });
    const backgroundSnapshot = {
      ...snapshotFor('session-2', 'background completed content'),
      session: {
        ...snapshotFor('session-2', '').session,
        messageCount: 2,
      },
      sessionRuntime: {
        ...snapshotFor('session-2', '').sessionRuntime,
        runtimeRevision: 'runtime-background-completed',
        phase: 'idle' as const,
      },
    };

    const cached = workbenchReducer(foreground, {
      type: 'durable_session_metadata_loaded',
      snapshot: backgroundSnapshot,
      contextRevision: 'context-1',
      workspaceId: 'workspace-1',
    });

    expect(cached.activeSessionId).toBe('session-1');
    expect(cached.transcript.map(entry => entry.content)).toEqual(['foreground content']);
    expect(cached.sessionProjectionById['session-2']?.transcript.items).toEqual([
      expect.objectContaining({ content: 'background completed content' }),
    ]);
    expect(cached.sessionRuntimeById['session-2']).toMatchObject({
      runtimeRevision: 'runtime-background-completed',
      phase: 'idle',
    });

    const switched = workbenchReducer(cached, {
      type: 'reset_session_view',
      activeSessionId: 'session-2',
    });
    expect(switched.transcript.map(entry => entry.content)).toEqual([
      'background completed content',
    ]);
  });

  test('does not let a Host workbench state steal this tab foreground Session', () => {
    const selected = workbenchReducer(initialWorkbenchState, {
      type: 'reset_session_view',
      activeSessionId: 'session-1',
    });
    const restored = workbenchReducer(selected, {
      type: 'session_snapshot_loaded',
      snapshot: snapshot([{ id: 'session-1:message:1', content: 'local foreground' }], null),
    });
    const contextual = {
      ...restored,
      workspaceId: '30000000-0000-4000-8000-000000000002',
      workspace: '/workspace',
    };

    const received = workbenchReducer(contextual, {
      type: 'event_received',
      envelope: workbenchEnvelope('session-from-other-tab', 9),
    });

    expect(received.activeSessionId).toBe('session-1');
    expect(received.transcript.map(entry => entry.content)).toEqual(['local foreground']);
    expect(received.lastCursor).toBe(9);
  });

  test('keeps the live SSE cursor authoritative while switching Session projections', () => {
    const workspaceId = '30000000-0000-4000-8000-000000000002';
    const selected = {
      ...workbenchReducer(initialWorkbenchState, {
        type: 'reset_session_view' as const,
        activeSessionId: 'session-1',
      }),
      workspaceId,
      lastCursor: 5,
    };
    const switched = workbenchReducer(selected, {
      type: 'session_snapshot_loaded',
      snapshot: { ...snapshotFor('session-1', 'projection at cursor 10'), eventCursor: 10 },
      advanceEventCursor: false,
    });

    expect(switched.lastCursor).toBe(5);

    const invalidated = workbenchReducer(switched, {
      type: 'event_received',
      envelope: {
        apiVersion: 1,
        eventId: '40000000-0000-4000-8000-000000000010',
        cursor: 8,
        sessionId: null,
        threadId: null,
        durable: false,
        timestamp: new Date(8).toISOString(),
        type: 'workspace_resource_invalidated',
        payload: {
          workspaceId,
          resources: ['files'],
          reason: 'tool-finished',
        },
      },
    });

    expect(invalidated.lastCursor).toBe(8);
    expect(invalidated.workspaceResourceEpochs[workspaceId]?.files).toBe(8);

    const recovered = workbenchReducer(selected, {
      type: 'session_snapshot_loaded',
      snapshot: { ...snapshotFor('session-1', 'recovery baseline'), eventCursor: 10 },
      advanceEventCursor: true,
    });
    expect(recovered.lastCursor).toBe(10);
  });

  test('does not advance the SSE cursor when restoring a cached Session projection', () => {
    const background = {
      ...snapshotFor('session-2', 'cached background'),
      eventCursor: 50,
    };
    const cached = workbenchReducer(
      { ...initialWorkbenchState, lastCursor: 7, workspaceId: 'workspace-1' },
      {
        type: 'durable_session_metadata_loaded',
        snapshot: background,
        contextRevision: initialWorkbenchState.contextRevision,
        workspaceId: 'workspace-1',
      }
    );
    const switched = workbenchReducer(cached, {
      type: 'reset_session_view',
      activeSessionId: 'session-2',
    });

    expect(switched.lastCursor).toBe(7);
    expect(switched.transcript).toEqual([
      expect.objectContaining({ content: 'cached background' }),
    ]);
  });

  test('treats replay reset as a hard barrier until recovery reconnects the Web Host stream', () => {
    const selected = workbenchReducer(initialWorkbenchState, {
      type: 'reset_session_view',
      activeSessionId: 'session-1',
    });
    const restored = workbenchReducer(selected, {
      type: 'session_snapshot_loaded',
      snapshot: snapshot([{ id: 'session-1:message:1', content: 'current' }], null),
    });
    const reset = workbenchReducer(restored, {
      type: 'event_received',
      envelope: replayResetEnvelope(10),
    });
    const afterRuntime = workbenchReducer(reset, {
      type: 'event_received',
      envelope: runtimeEnvelope({ type: 'status_changed', message: 'must be ignored' }, 11),
    });
    const afterWorkbench = workbenchReducer(afterRuntime, {
      type: 'event_received',
      envelope: workbenchEnvelope('session-2', 12),
    });
    const afterLive = workbenchReducer(afterWorkbench, {
      type: 'connection_changed',
      phase: 'live',
      attempt: 0,
    });

    expect(afterLive.connection).toBe('replay-required');
    expect(afterLive.activeSessionId).toBe('session-1');
    expect(afterLive.transcript.map(entry => entry.content)).toEqual(['current']);
    expect(afterLive.lastCursor).toBe(10);
    expect(afterLive.replayReason).toBe('retained history expired');

    const recoveredSnapshot = { ...snapshot([], null), eventCursor: 13 };
    const snapshotWhileBlocked = workbenchReducer(afterLive, {
      type: 'session_snapshot_loaded',
      snapshot: recoveredSnapshot,
    });
    expect(snapshotWhileBlocked.connection).toBe('replay-required');
    expect(snapshotWhileBlocked.replayReason).toBe('retained history expired');

    const recovering = workbenchReducer(snapshotWhileBlocked, { type: 'recovering' });
    expect(recovering.connection).toBe('connecting');
    expect(recovering.replayReason).toBeUndefined();

    const recovered = workbenchReducer(recovering, {
      type: 'session_snapshot_loaded',
      snapshot: recoveredSnapshot,
    });
    expect(recovered.connection).toBe('connecting');
    expect(recovered.lastCursor).toBe(10);
    expect(recovered.sessionSync['session-1'].snapshotEventCursor).toBe(13);

    const live = workbenchReducer(recovered, {
      type: 'connection_changed',
      phase: 'live',
      attempt: 0,
    });
    expect(live.connection).toBe('live');
  });

  test('ignores session events when no session is selected while advancing the stream cursor', () => {
    const received = workbenchReducer(initialWorkbenchState, {
      type: 'event_received',
      envelope: runtimeEnvelope(
        {
          type: 'permission_requested',
          request: {
            id: 'stale-permission',
            name: 'write_file',
            args: { path: 'stale.txt' },
          },
        },
        7
      ),
    });

    expect(received.lastCursor).toBe(7);
    expect(received.activeSessionId).toBeNull();
    expect(received.permission).toBeNull();
  });

  test('applies compact transcript content deltas without replacing prior text', () => {
    const selected = workbenchReducer(initialWorkbenchState, {
      type: 'reset_session_view',
      activeSessionId: 'session-1',
    });
    const appended = workbenchReducer(selected, {
      type: 'event_received',
      envelope: runtimeEnvelope(
        {
          type: 'transcript_append',
          entry: { role: 'assistant', content: '', live: true },
        },
        1
      ),
    });
    const first = workbenchReducer(appended, {
      type: 'event_received',
      envelope: runtimeEnvelope(
        {
          type: 'transcript_update',
          id: 'web-entry-1',
          patch: {},
          contentDelta: 'hello',
          contentStart: 0,
        },
        2
      ),
    });
    const second = workbenchReducer(first, {
      type: 'event_received',
      envelope: runtimeEnvelope(
        {
          type: 'transcript_update',
          id: 'web-entry-1',
          patch: {},
          contentDelta: ' world',
          contentStart: 5,
        },
        3
      ),
    });

    expect(second.transcript).toEqual([
      expect.objectContaining({ id: 'web-entry-1', content: 'hello world', live: true }),
    ]);
  });

  test('keeps a running live entry across a Context snapshot until durable completion', () => {
    const running = snapshot([], null);
    const runningSnapshot = {
      ...running,
      sessionRuntime: { ...running.sessionRuntime, phase: 'running' as const },
      runtime: { ...running.runtime, processing: true },
      eventCursor: 2,
    };
    let state = workbenchReducer(initialWorkbenchState, {
      type: 'reset_session_view',
      activeSessionId: 'session-1',
    });
    state = workbenchReducer(state, {
      type: 'session_snapshot_loaded',
      snapshot: { ...runningSnapshot, eventCursor: 0 },
      advanceEventCursor: false,
    });
    state = workbenchReducer(state, {
      type: 'event_received',
      envelope: runtimeEnvelope(
        { type: 'transcript_append', entry: { role: 'assistant', content: 'partial', live: true } },
        1
      ),
    });
    state = workbenchReducer(state, {
      type: 'session_snapshot_loaded',
      snapshot: runningSnapshot,
      advanceEventCursor: false,
    });
    expect(state.transcript).toEqual([
      expect.objectContaining({ id: 'web-entry-1', content: 'partial', live: true }),
    ]);

    state = workbenchReducer(state, {
      type: 'event_received',
      envelope: runtimeEnvelope(
        {
          type: 'transcript_update',
          id: 'web-entry-1',
          patch: {},
          contentDelta: ' answer',
          contentStart: 7,
        },
        3
      ),
    });
    expect(state.transcript[0]?.content).toBe('partial answer');

    const completed = workbenchReducer(state, {
      type: 'session_snapshot_loaded',
      snapshot: {
        ...runningSnapshot,
        eventCursor: 4,
        sessionRuntime: { ...runningSnapshot.sessionRuntime, phase: 'idle' },
        runtime: { ...runningSnapshot.runtime, processing: false },
        transcript: {
          items: [
            { id: 'durable-user', role: 'user', content: 'prompt', timestamp: 1 },
            { id: 'durable-answer', role: 'assistant', content: 'partial answer', timestamp: 2 },
          ],
          nextCursor: null,
        },
      },
      advanceEventCursor: false,
    });
    expect(completed.transcript.map(entry => entry.content)).toEqual(['prompt', 'partial answer']);
  });

  test('keeps first-turn live text when a new Session materializes its thread while away', () => {
    const initial = { ...snapshot([], null), threadId: null, threadCursor: 0 };
    let state = workbenchReducer(initialWorkbenchState, {
      type: 'reset_session_view',
      activeSessionId: 'session-1',
    });
    state = workbenchReducer(state, {
      type: 'session_snapshot_loaded',
      snapshot: initial,
      advanceEventCursor: false,
    });
    state = workbenchReducer(state, {
      type: 'event_received',
      envelope: runtimeEnvelope(
        { type: 'transcript_append', entry: { role: 'assistant', content: 'held', live: true } },
        1
      ),
    });
    state = workbenchReducer(state, { type: 'reset_session_view', activeSessionId: 'session-2' });
    state = workbenchReducer(state, { type: 'reset_session_view', activeSessionId: 'session-1' });
    state = workbenchReducer(state, {
      type: 'session_snapshot_loaded',
      snapshot: {
        ...initial,
        threadId: 'thread-1',
        threadCursor: 1,
        eventCursor: 1,
        activeTurnId: 'turn-1',
        sessionRuntime: { ...initial.sessionRuntime, phase: 'running' },
        runtime: { ...initial.runtime, processing: true },
      },
      advanceEventCursor: false,
    });
    expect(state.transcript).toEqual([
      expect.objectContaining({ id: 'web-entry-1', content: 'held', live: true }),
    ]);
  });

  test('tracks Workspace resource invalidations independently by resource and project', () => {
    const envelope: WebEventEnvelopeV1 = {
      apiVersion: 1,
      eventId: '40000000-0000-4000-8000-000000000009',
      cursor: 9,
      sessionId: null,
      threadId: null,
      durable: false,
      timestamp: new Date(9).toISOString(),
      type: 'workspace_resource_invalidated',
      payload: {
        workspaceId: '30000000-0000-4000-8000-000000000002',
        resources: ['files', 'review'],
        reason: 'tool-finished',
      },
    };

    const next = workbenchReducer(initialWorkbenchState, {
      type: 'event_received',
      envelope,
    });

    expect(next.workspaceResourceEpochs[envelope.payload.workspaceId]).toEqual({
      files: 9,
      git: 0,
      review: 9,
    });
    expect(next.lastCursor).toBe(9);
  });

  test('requires snapshot recovery when a transcript delta skips a disconnected segment', () => {
    const selected = workbenchReducer(initialWorkbenchState, {
      type: 'reset_session_view',
      activeSessionId: 'session-1',
    });
    const appended = workbenchReducer(selected, {
      type: 'event_received',
      envelope: runtimeEnvelope(
        {
          type: 'transcript_append',
          entry: { role: 'assistant', content: 'abc', live: true },
        },
        1
      ),
    });
    const missed = workbenchReducer(appended, {
      type: 'event_received',
      envelope: runtimeEnvelope(
        {
          type: 'transcript_update',
          id: 'web-entry-1',
          patch: {},
          contentDelta: 'GHI',
          contentStart: 6,
        },
        2
      ),
    });

    expect(missed.connection).toBe('replay-required');
    expect(missed.transcript[0]?.content).toBe('abc');
    expect(missed.replayReason).toContain('基线');
  });
});

describe('v0.3.24 Session responsiveness', () => {
  const context = { workspaceId: 'workspace-1', contextRevision: 'context-1' };
  const readyPair = () => {
    let state: import('../web/src/types').WorkbenchState = {
      ...initialWorkbenchState,
      ...context,
      connection: 'live',
    };
    for (const id of ['session-1', 'session-2']) {
      state = workbenchReducer(state, { type: 'reset_session_view', activeSessionId: id });
      state = workbenchReducer(state, {
        type: 'session_snapshot_loaded',
        snapshot: snapshotFor(id, `${id} original`),
      });
    }
    return state;
  };

  test('warm selection retains renamed and tagged catalog metadata instead of replaying the snapshot', () => {
    let state = readyPair();
    const updated = {
      ...state.sessions.find(session => session.id === 'session-1')!,
      name: 'Renamed A',
      tags: ['bug'],
    };
    state = workbenchReducer(state, {
      type: 'sessions_loaded',
      sessions: state.sessions.map(session => (session.id === updated.id ? updated : session)),
      nextCursor: null,
    });
    state = workbenchReducer(state, { type: 'reset_session_view', activeSessionId: updated.id });
    expect(state.sessions.find(session => session.id === updated.id)).toMatchObject(updated);
    expect(state.sessionSnapshot?.session).toMatchObject(updated);
    state = workbenchReducer(state, { type: 'reset_session_view', activeSessionId: 'session-2' });
    state = workbenchReducer(state, { type: 'reset_session_view', activeSessionId: updated.id });
    expect(state.sessionSnapshot?.session.name).toBe('Renamed A');
    expect(state.sessionSnapshot?.session.tags).toEqual(['bug']);
  });

  test('reuses a live same-Context cache and preserves streamed messages and tools', () => {
    let state = workbenchReducer(readyPair(), {
      type: 'reset_session_view',
      activeSessionId: 'session-1',
    });
    expect(isActiveSessionSnapshotReady(state)).toBe(true);
    state = workbenchReducer(state, {
      type: 'event_received',
      envelope: runtimeEnvelope(
        { type: 'transcript_append', entry: { role: 'assistant', content: 'live answer' } },
        1
      ),
    });
    state = workbenchReducer(state, {
      type: 'event_received',
      envelope: runtimeEnvelope(
        {
          type: 'tool_started',
          event: { callId: 'live-tool', name: 'read_file', args: {}, sequence: 2 },
        },
        2
      ),
    });
    const transcript = state.transcript;
    const tools = state.tools;
    state = workbenchReducer(state, { type: 'reset_session_view', activeSessionId: 'session-2' });
    state = workbenchReducer(state, { type: 'reset_session_view', activeSessionId: 'session-1' });
    expect(state.transcript).toBe(transcript);
    expect(state.tools).toBe(tools);
    expect(state.transcript.at(-1)?.content).toBe('live answer');
    expect(state.tools[0].callId).toBe('live-tool');
    expect(isActiveSessionSnapshotReady(state)).toBe(true);
  });

  test('late HTTP authority cannot replace newer SSE content or make a stale cache ready', () => {
    let state = workbenchReducer(readyPair(), {
      type: 'reset_session_view',
      activeSessionId: 'session-1',
    });
    state = workbenchReducer(state, {
      type: 'session_snapshot_started',
      sessionId: 'session-1',
      requestId: 10,
      cached: true,
      ...context,
    });
    state = workbenchReducer(state, {
      type: 'event_received',
      envelope: runtimeEnvelope(
        { type: 'transcript_append', entry: { role: 'assistant', content: 'newer stream' } },
        20
      ),
    });
    const stale = workbenchReducer(state, {
      type: 'session_snapshot_loaded',
      snapshot: snapshotFor('session-1', 'old HTTP'),
      requestId: 10,
      ...context,
    });
    expect(stale.transcript).toBe(state.transcript);
    expect(stale.sessionSync['session-1']).toMatchObject({ dirty: true, lastEventCursor: 20 });
    expect(isActiveSessionSnapshotReady(stale)).toBe(false);
    const fresh = workbenchReducer(stale, {
      type: 'session_snapshot_loaded',
      snapshot: { ...snapshotFor('session-1', 'newer stream'), eventCursor: 20 },
      requestId: 10,
      ...context,
    });
    expect(isActiveSessionSnapshotReady(fresh)).toBe(true);
    expect(fresh.transcript[0].content).toBe('newer stream');
    const other = workbenchReducer(state, {
      type: 'reset_session_view',
      activeSessionId: 'session-2',
    });
    const unrelated = workbenchReducer(other, {
      type: 'session_snapshot_loaded',
      snapshot: snapshotFor('session-2', 'B authority'),
      ...context,
    });
    expect(isActiveSessionSnapshotReady(unrelated)).toBe(true);
  });

  test('an oversized live display cannot silently reuse an obsolete HTTP tail after eviction', () => {
    let state = workbenchReducer(readyPair(), {
      type: 'reset_session_view',
      activeSessionId: 'session-1',
    });
    state = { ...state, transcript: [{ ...state.transcript[0], content: 'x'.repeat(4_500_000) }] };
    state = workbenchReducer(state, { type: 'reset_session_view', activeSessionId: 'session-2' });
    expect(state.sessionViewsById['session-1']).toBeUndefined();
    expect(state.sessionSync['session-1']?.dirty).toBe(true);
    state = workbenchReducer(state, { type: 'reset_session_view', activeSessionId: 'session-1' });
    expect(isActiveSessionSnapshotReady(state)).toBe(false);
    expect(state.sessionSync['session-1']?.status).toBe('refreshing');
  });

  test('background events invalidate only their owning cache', () => {
    let state = readyPair();
    expect(canReuseSessionSnapshot(state, 'session-1')).toBe(true);
    state = workbenchReducer(state, {
      type: 'event_received',
      envelope: runtimeEnvelope({ type: 'processing_changed', processing: true }, 1),
    });
    expect(canReuseSessionSnapshot(state, 'session-1')).toBe(false);
    expect(canReuseSessionSnapshot(state, 'session-2')).toBe(true);
    state = workbenchReducer(state, { type: 'reset_session_view', activeSessionId: 'session-1' });
    expect(activeSessionSnapshotSync(state).status).toBe('refreshing');
    expect(isActiveSessionSnapshotReady(state)).toBe(false);
    expect(state.transcript[0].content).toBe('session-1 original');
  });

  test('same-workspace Context revision changes invalidate authority and old pending tokens', () => {
    let state = readyPair();
    state = workbenchReducer(state, {
      type: 'pending_session_action',
      sessionId: 'session-2',
      operationId: 1,
      label: 'submit',
      ...context,
    });
    const envelope = workbenchEnvelope(null, 40);
    if (envelope.type !== 'workbench_state') throw new Error('Expected a workbench envelope');
    state = workbenchReducer(state, {
      type: 'event_received',
      envelope: {
        ...envelope,
        payload: {
          ...envelope.payload,
          workspaceId: context.workspaceId,
          workspace: state.workspace,
          contextRevision: 'context-next',
        },
      },
    });
    expect(state.pendingSessionActions).toEqual({});
    expect(state.sessionSync['session-1']?.dirty).toBe(true);
    expect(state.sessionSync['session-2']?.dirty).toBe(true);
    expect(isActiveSessionSnapshotReady(state)).toBe(false);
  });

  test('a stream interruption makes cached authority require synchronization', () => {
    const state = workbenchReducer(readyPair(), {
      type: 'connection_changed',
      phase: 'reconnecting',
      attempt: 1,
    });
    const live = workbenchReducer(state, { type: 'connection_changed', phase: 'live', attempt: 0 });
    expect(canReuseSessionSnapshot(live, 'session-1')).toBe(false);
    expect(isActiveSessionSnapshotReady(live)).toBe(false);
  });

  test('pending writes are owned by Session and clear only their own tokens', () => {
    let state = readyPair();
    const action = { type: 'pending_session_action' as const, sessionId: 'session-1', ...context };
    state = workbenchReducer(state, { ...action, operationId: 1, label: 'submit' });
    state = workbenchReducer(state, { ...action, operationId: 2, label: 'queue' });
    expect(state.pendingAction).toBeNull();
    expect(isActiveSessionActionPending(state)).toBe(false);
    state = workbenchReducer(state, { type: 'reset_session_view', activeSessionId: 'session-1' });
    expect(isActiveSessionActionPending(state)).toBe(true);
    state = workbenchReducer(state, { ...action, operationId: 1, label: null });
    expect(isActiveSessionActionPending(state)).toBe(true);
    state = workbenchReducer(state, { ...action, operationId: 2, label: null });
    expect(isActiveSessionActionPending(state)).toBe(false);
    expect(state.pendingSessionActions).toEqual({});
  });

  test('late pending responses from another Context cannot lock the foreground', () => {
    const state = readyPair();
    expect(
      workbenchReducer(state, {
        type: 'pending_session_action',
        sessionId: 'session-2',
        operationId: 3,
        label: 'submit',
        workspaceId: 'another-workspace',
        contextRevision: 'old-context',
      })
    ).toBe(state);
    const creating = workbenchReducer(state, {
      type: 'session_creation_pending',
      pending: true,
      ...context,
    });
    expect(creating.pendingAction).toBeNull();
    expect(isActiveSessionActionPending(creating)).toBe(false);
    expect(isActiveSessionSnapshotReady(creating)).toBe(false);
    const selected = workbenchReducer(creating, {
      type: 'reset_session_view',
      activeSessionId: 'session-2',
    });
    expect(selected.sessionCreationSelected).toBe(false);
    expect(isActiveSessionSnapshotReady(selected)).toBe(true);
  });

  test('navigation intent is browser-local and cannot authorize a target Context', () => {
    const state = readyPair();
    const target = { workspaceId: 'other-project', sessionId: 'other-session' };
    const navigating = workbenchReducer(
      { ...state, pendingAction: '切换项目上下文' },
      { type: 'navigation_target', target }
    );
    expect(navigating.navigationTarget).toEqual(target);
    expect(navigating.workspaceId).toBe(state.workspaceId);
    expect(navigating.activeSessionId).toBe(state.activeSessionId);
    expect(isActiveSessionActionPending(navigating)).toBe(true);
    const settled = workbenchReducer(navigating, { type: 'navigation_target', target: null });
    expect(settled.navigationTarget).toBeNull();
  });

  test('a Session menu observes only its own in-flight operation', () => {
    const state = workbenchReducer(readyPair(), {
      type: 'pending_session_action',
      sessionId: 'session-1',
      operationId: 7,
      label: 'rename',
      ...context,
    });
    expect(isSessionActionPending(state, 'session-1')).toBe(true);
    expect(isSessionActionPending(state, 'session-2')).toBe(false);
  });

  test('a late Composer HTTP reply cannot roll back a newer SSE control revision', () => {
    const state = readyPair();
    const original = state.composer!;
    const newer = { ...original, controlRevision: 'newer-control' };
    const advanced = workbenchReducer(state, {
      type: 'event_received',
      envelope: {
        apiVersion: 1,
        eventId: 'new-control-event',
        cursor: 1,
        sessionId: 'session-2',
        threadId: 'thread-2',
        durable: true,
        timestamp: new Date(1).toISOString(),
        type: 'composer_state_changed',
        payload: { state: newer },
      },
    });
    const late = workbenchReducer(advanced, {
      type: 'composer_loaded',
      composer: { ...original, controlRevision: 'http-control' },
      requestControlRevision: original.controlRevision,
    });
    expect(late).toBe(advanced);
    expect(late.composer?.controlRevision).toBe('newer-control');
  });

  test('Host diagnostics do not change the foreground Session execution state', () => {
    const state = readyPair();
    const result = workbenchReducer(state, {
      type: 'diagnostics_loaded',
      diagnostics: { activeSessionId: 'session-1', processing: true, agentMode: 'auto' },
    });
    expect(result.processing).toBe(state.processing);
    expect(result.mode).toBe(state.mode);
    expect(result.activeSessionId).toBe('session-2');
  });

  test('a single Session snapshot never acknowledges other Sessions replay events', () => {
    let state = workbenchReducer(readyPair(), {
      type: 'session_snapshot_loaded',
      snapshot: { ...snapshotFor('session-2', 'latest B'), eventCursor: 10 },
    });
    expect(state.lastCursor).toBe(0);
    state = workbenchReducer(state, {
      type: 'event_received',
      envelope: {
        apiVersion: 1,
        eventId: 'background-runtime',
        cursor: 8,
        sessionId: 'session-1',
        threadId: 'thread-1',
        durable: true,
        timestamp: new Date(8).toISOString(),
        type: 'session_runtime_changed',
        payload: { runtime: { ...snapshotFor('session-1', '').sessionRuntime, phase: 'running' } },
      },
    });
    expect(state.sessionRuntimeById['session-1'].phase).toBe('running');
    const composer = state.composer!;
    state = workbenchReducer(state, {
      type: 'event_received',
      envelope: {
        apiVersion: 1,
        eventId: 'represented-old-control',
        cursor: 9,
        sessionId: 'session-2',
        threadId: 'thread-2',
        durable: true,
        timestamp: new Date(9).toISOString(),
        type: 'composer_state_changed',
        payload: { state: { ...composer, controlRevision: 'old-replayed-control' } },
      },
    });
    expect(state.composer).toBe(composer);
    expect(state.lastCursor).toBe(9);
  });

  test('replay reset clears Session cursor watermarks from a previous Host epoch', () => {
    const old = {
      ...readyPair(),
      sessionSync: {
        'session-1': {
          status: 'ready' as const,
          requestId: null,
          lastEventCursor: 500,
          snapshotEventCursor: 500,
        },
      },
    };
    const reset = workbenchReducer(old, {
      type: 'event_received',
      envelope: replayResetEnvelope(2),
    });
    expect(reset.sessionSync['session-1'].lastEventCursor).toBeUndefined();
    expect(reset.sessionSync['session-1'].snapshotEventCursor).toBeUndefined();
    expect(reset.sessionSync['session-1'].dirty).toBe(true);
  });

  test('a history page received in the background is kept in that Session display', () => {
    let state = workbenchReducer(readyPair(), {
      type: 'reset_session_view',
      activeSessionId: 'session-1',
    });
    const older = {
      ...state.sessionSnapshot!,
      transcript: {
        items: [{ id: 'old-entry', role: 'user' as const, content: 'older history', timestamp: 0 }],
        nextCursor: null,
      },
    };
    state = workbenchReducer(state, { type: 'reset_session_view', activeSessionId: 'session-2' });
    const foreground = state.transcript;
    state = workbenchReducer(state, { type: 'older_transcript_loaded', snapshot: older });
    expect(state.transcript).toBe(foreground);
    expect(
      state.sessionViewsById['session-1'].view.transcript.some(entry => entry.id === 'old-entry')
    ).toBe(true);
    state = workbenchReducer(state, { type: 'reset_session_view', activeSessionId: 'session-1' });
    expect(state.transcript.some(entry => entry.id === 'old-entry')).toBe(true);
    expect(state.sessionSnapshot?.transcript.nextCursor).toBeNull();
  });

  test('authority refresh keeps paged durable history only while its projection matches', () => {
    let state = workbenchReducer(
      { ...initialWorkbenchState, ...context, connection: 'live', activeSessionId: 'session-1' },
      {
        type: 'session_snapshot_loaded',
        snapshot: snapshot([{ id: 'thread:20', content: 'tail' }], 'page-before-20'),
      }
    );
    state = workbenchReducer(state, {
      type: 'older_transcript_loaded',
      snapshot: snapshot([{ id: 'thread:1', content: 'early' }], null),
    });
    state = workbenchReducer(state, {
      type: 'session_snapshot_loaded',
      snapshot: snapshot([{ id: 'thread:20', content: 'tail' }], 'page-before-20'),
    });
    expect(state.transcript.map(entry => entry.id)).toEqual(['thread:1', 'thread:20']);
    expect(state.sessionSnapshot?.transcript.nextCursor).toBeNull();
    state = workbenchReducer(state, {
      type: 'session_snapshot_loaded',
      snapshot: {
        ...snapshot([{ id: 'thread:20', content: 'revised tail' }], 'page-before-20'),
        projectionDigest: 'changed-authority',
      },
    });
    expect(state.transcript.map(entry => entry.id)).toEqual(['thread:20']);
  });
});

function snapshot(
  entries: readonly { readonly id: string; readonly content: string }[],
  nextCursor: string | null
): WebSessionSnapshotV1 {
  const sessionRuntime = {
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    runtimeRevision: 'runtime-1',
    phase: 'idle' as const,
    pendingApprovalCount: 0,
    resident: true,
    estimatedBytes: 1,
    updatedAt: new Date(1).toISOString(),
  };
  return {
    apiVersion: 1,
    session: {
      id: 'session-1',
      name: 'Session 1',
      projectPath: '/workspace',
      model: 'test-model',
      createdAt: new Date(1).toISOString(),
      updatedAt: new Date(1).toISOString(),
      messageCount: 4,
      contextDigest: 'session-context-digest',
    },
    sessionRuntime,
    threadId: 'thread-1',
    threadCursor: 8,
    eventCursor: 0,
    projectionDigest: 'projection-digest',
    threadStatus: 'idle',
    transcript: {
      items: entries.map((entry, index) => ({
        ...entry,
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        timestamp: index + 1,
      })),
      nextCursor,
    },
    runtime: {
      active: true,
      processing: false,
      agentMode: 'interactive',
      permissionMode: 'ask',
      status: 'Ready',
      followups: [],
      followupLimit: 16,
      contextUsage: null,
      tokenUsage: null,
    },
    pendingApprovals: [],
    goal: null,
    plan: null,
    composer: {
      apiVersion: 1,
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      contextRevision: 'context-1',
      controlRevision: 'control-1',
      sessionRuntime,
      processing: false,
      compactAvailable: true,
      mode: { baseMode: 'interactive', pendingBaseMode: null },
      model: {
        modelId: 'test-model',
        providerId: 'test-provider',
        providerLabel: 'Test provider',
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        effort: {
          requested: 'auto',
          effective: null,
          source: 'model-default',
          supported: true,
          supportedLevels: [],
        },
      },
      permission: {
        effective: 'ask',
        override: null,
        projectDefault: 'ask',
        source: 'project',
      },
      contextUsage: null,
      planReview: null,
      pending: { model: null, permission: null },
      lastError: null,
      queue: { items: [], limit: 16 },
    },
    recoveryDiagnostics: [],
  };
}

function sessionSummary(id: string, name: string): WebSessionSnapshotV1['session'] {
  return {
    id,
    name,
    projectPath: '/workspace',
    model: 'test-model',
    createdAt: new Date(1).toISOString(),
    updatedAt: new Date(1).toISOString(),
    messageCount: 1,
    contextDigest: `context-${id}`,
  };
}

function snapshotFor(sessionId: string, content: string): WebSessionSnapshotV1 {
  const value = snapshot([{ id: `${sessionId}:message:1`, content }], null);
  const sessionRuntime = { ...value.sessionRuntime, sessionId };
  return {
    ...value,
    session: { ...value.session, id: sessionId, name: sessionId },
    sessionRuntime,
    composer: { ...value.composer, sessionId, sessionRuntime },
  };
}

function runtimeEnvelope(event: AgentRuntimeEvent, cursor: number): WebEventEnvelopeV1 {
  return {
    apiVersion: 1,
    eventId: `00000000-0000-4000-8000-${String(cursor).padStart(12, '0')}`,
    cursor,
    sessionId: 'session-1',
    threadId: 'thread-1',
    durable: true,
    timestamp: new Date(cursor).toISOString(),
    type: 'runtime_event',
    payload: { eventType: event.type, value: event },
  };
}

function replayResetEnvelope(cursor: number): WebEventEnvelopeV1 {
  return {
    apiVersion: 1,
    eventId: `10000000-0000-4000-8000-${String(cursor).padStart(12, '0')}`,
    cursor,
    sessionId: null,
    threadId: null,
    durable: true,
    timestamp: new Date(cursor).toISOString(),
    type: 'replay_reset',
    payload: { reason: 'retained history expired', snapshotRequired: true },
  };
}

function workbenchEnvelope(activeSessionId: string | null, cursor: number): WebEventEnvelopeV1 {
  return {
    apiVersion: 1,
    eventId: `20000000-0000-4000-8000-${String(cursor).padStart(12, '0')}`,
    cursor,
    sessionId: null,
    threadId: null,
    durable: true,
    timestamp: new Date(cursor).toISOString(),
    type: 'workbench_state',
    payload: {
      contextRevision: '30000000-0000-4000-8000-000000000001',
      workspaceId: '30000000-0000-4000-8000-000000000002',
      workspace: '/workspace',
      activeSessionId,
    },
  };
}
