/// <reference lib="dom" />

import type { AgentRuntimeEvent } from '../src/runtime/agent-runtime-protocol';
import type { WebEventEnvelopeV1, WebSessionSnapshotV1 } from '../src/web/protocol';
import {
  activeSessionSnapshotSync,
  initialWorkbenchState,
  isActiveSessionSnapshotReady,
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
    expect(restored.lastCursor).toBe(20);
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
    expect(recovered.lastCursor).toBe(13);

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
