/// <reference lib="dom" />

import type { AgentRuntimeEvent } from '../src/runtime/agent-runtime-protocol';
import type { WebEventEnvelopeV1, WebSessionSnapshotV1 } from '../src/web/protocol';
import { initialWorkbenchState } from '../web/src/types';
import { workbenchReducer } from '../web/src/reducer';

describe('Web Workbench reducer', () => {
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

  test('ignores an inactive snapshot even when its session matches the current selection', () => {
    const selected = workbenchReducer(initialWorkbenchState, {
      type: 'reset_session_view',
      activeSessionId: 'session-1',
    });
    const activeSnapshot = snapshot([{ id: 'session-1:message:1', content: 'current' }], null);
    const inactiveSnapshot: WebSessionSnapshotV1 = {
      ...activeSnapshot,
      eventCursor: 20,
      runtime: { ...activeSnapshot.runtime, active: false },
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

    const stale = workbenchReducer(selected, {
      type: 'session_snapshot_loaded',
      snapshot: inactiveSnapshot,
    });

    expect(stale).toBe(selected);
    expect(stale.lastCursor).toBe(0);
    expect(stale.transcript).toEqual([]);
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

    const merged = workbenchReducer(restored, {
      type: 'durable_session_metadata_loaded',
      snapshot: durableSnapshot,
      contextRevision: 'context-1',
      workspaceId: 'workspace-1',
    });

    expect(merged.transcript.map(entry => entry.content)).toEqual(['live transcript']);
    expect(merged.lastCursor).toBe(restored.lastCursor);
    expect(merged.plan?.body).toBe('# Durable Plan');
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

  test('treats replay reset as a hard barrier until an active snapshot is accepted', () => {
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
    const recovered = workbenchReducer(afterLive, {
      type: 'session_snapshot_loaded',
      snapshot: recoveredSnapshot,
    });
    expect(recovered.connection).toBe('connecting');
    expect(recovered.lastCursor).toBe(13);
    expect(recovered.replayReason).toBeUndefined();
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
    },
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
