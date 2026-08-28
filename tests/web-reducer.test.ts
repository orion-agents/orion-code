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

    const awaiting = workbenchReducer(initialWorkbenchState, {
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

    const restored = workbenchReducer(initialWorkbenchState, {
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
