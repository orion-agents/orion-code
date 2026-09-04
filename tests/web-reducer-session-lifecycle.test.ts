/**
 * v0.3.7 — Reducer lifecycle for Session tags / archive / restore / delete.
 * Pure state transitions; no DOM, no filesystem.
 */
import { describe, expect, it } from '@jest/globals';

import { workbenchReducer as reduce } from '../web/src/reducer';
import {
  initialWorkbenchState,
  type WebSessionSummaryV1,
  type WorkbenchState,
} from '../web/src/types';

function summary(id: string, overrides: Partial<WebSessionSummaryV1> = {}): WebSessionSummaryV1 {
  return {
    id,
    projectPath: '/tmp/demo',
    name: `会话 ${id}`,
    model: 'test-model',
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    messageCount: 3,
    contextDigest: 'digest',
    ...overrides,
  };
}

const WORKSPACE = 'workspace-1';

function seededState(): WorkbenchState {
  return {
    ...initialWorkbenchState,
    workspaceId: WORKSPACE,
    sessions: [summary('s2'), summary('s1')],
    workspaceSessions: {
      [WORKSPACE]: { status: 'ready', items: [summary('s2'), summary('s1')], nextCursor: null },
    },
    archivedSessions: { status: 'idle', items: [], nextCursor: null, ownerWorkspaceId: '' },
  };
}

describe('reducer session lifecycle (v0.3.7)', () => {
  it('session_updated replaces an existing row in place', () => {
    const next = reduce(seededState(), {
      type: 'session_updated',
      session: summary('s1', { tags: ['bug', 'frontend'] }),
    });
    expect(next.sessions.map(s => s.id)).toEqual(['s2', 's1']);
    expect(next.sessions[1].tags).toEqual(['bug', 'frontend']);
    expect(next.workspaceSessions[WORKSPACE].items[1].tags).toEqual(['bug', 'frontend']);
  });

  it('session_updated prepends when the row is not listed', () => {
    const next = reduce(seededState(), {
      type: 'session_updated',
      session: summary('s3', { tags: ['new'] }),
    });
    expect(next.sessions.map(s => s.id)).toEqual(['s3', 's2', 's1']);
  });

  it('session_archived removes from main listings and prepends to the archive', () => {
    const state: WorkbenchState = {
      ...seededState(),
      archivedSessions: {
        status: 'ready',
        items: [summary('s9')],
        nextCursor: null,
        ownerWorkspaceId: WORKSPACE,
      },
    };
    const next = reduce(state, { type: 'session_archived', session: summary('s2') });
    expect(next.sessions.map(s => s.id)).toEqual(['s1']);
    expect(next.workspaceSessions[WORKSPACE].items.map(s => s.id)).toEqual(['s1']);
    expect(next.archivedSessions.items.map(s => s.id)).toEqual(['s2', 's9']);
  });

  it('session_restored moves the row back to the top of the main listing', () => {
    const state: WorkbenchState = {
      ...seededState(),
      archivedSessions: {
        status: 'ready',
        items: [summary('s1', { name: '旧' })],
        nextCursor: null,
        ownerWorkspaceId: WORKSPACE,
      },
    };
    const next = reduce(state, {
      type: 'session_restored',
      session: summary('s1', { name: '旧' }),
    });
    expect(next.sessions.map(s => s.id)).toEqual(['s1', 's2']);
    expect(next.archivedSessions.items.map(s => s.id)).toEqual([]);
  });

  it('session_deleted removes from both listings', () => {
    const state: WorkbenchState = {
      ...seededState(),
      archivedSessions: {
        status: 'ready',
        items: [summary('s2')],
        nextCursor: null,
        ownerWorkspaceId: WORKSPACE,
      },
    };
    const next = reduce(state, { type: 'session_deleted', sessionId: 's2' });
    expect(next.sessions.map(s => s.id)).toEqual(['s1']);
    expect(next.workspaceSessions[WORKSPACE].items.map(s => s.id)).toEqual(['s1']);
    expect(next.archivedSessions.items).toEqual([]);
  });

  it('archived_sessions_loaded replaces the archived listing and keeps status ready', () => {
    const next = reduce(seededState(), {
      type: 'archived_sessions_loaded',
      workspaceId: WORKSPACE,
      sessions: [summary('s9')],
      nextCursor: null,
      append: false,
    });
    expect(next.archivedSessions.status).toBe('ready');
    expect(next.archivedSessions.items.map(s => s.id)).toEqual(['s9']);
  });

  it('archived_sessions_loaded appends when append is set', () => {
    const state: WorkbenchState = {
      ...seededState(),
      archivedSessions: {
        status: 'ready',
        items: [summary('s8')],
        nextCursor: 'c1',
        ownerWorkspaceId: WORKSPACE,
      },
    };
    const next = reduce(state, {
      type: 'archived_sessions_loaded',
      workspaceId: WORKSPACE,
      sessions: [summary('s9')],
      nextCursor: null,
      append: true,
    });
    expect(next.archivedSessions.items.map(s => s.id)).toEqual(['s8', 's9']);
  });

  it('archived_sessions_failed surfaces the error and keeps items', () => {
    const state: WorkbenchState = {
      ...seededState(),
      archivedSessions: {
        status: 'loading',
        items: [summary('s8')],
        nextCursor: null,
        ownerWorkspaceId: WORKSPACE,
      },
    };
    const next = reduce(state, {
      type: 'archived_sessions_failed',
      workspaceId: WORKSPACE,
      detail: 'boom',
    });
    expect(next.archivedSessions.status).toBe('error');
    expect(next.archivedSessions.error).toBe('boom');
    expect(next.archivedSessions.items.map(s => s.id)).toEqual(['s8']);
  });

  it('archived_sessions_loading keeps the current items', () => {
    const state: WorkbenchState = {
      ...seededState(),
      archivedSessions: {
        status: 'ready',
        items: [summary('s8')],
        nextCursor: null,
        ownerWorkspaceId: WORKSPACE,
      },
    };
    const next = reduce(state, { type: 'archived_sessions_loading', workspaceId: WORKSPACE });
    expect(next.archivedSessions.status).toBe('loading');
    expect(next.archivedSessions.items.map(s => s.id)).toEqual(['s8']);
  });
});

describe('reducer archived owner-binding & runtime cleanup (v0.3.7 fixes)', () => {
  function ownedState(owner: string, items: WebSessionSummaryV1[]): WorkbenchState {
    return {
      ...seededState(),
      workspaceId: WORKSPACE,
      archivedSessions: {
        status: 'ready',
        items,
        nextCursor: null,
        ownerWorkspaceId: owner,
      },
    };
  }

  it('ignores archived events for a workspace that is no longer foreground', () => {
    const state = ownedState(WORKSPACE, [summary('s9')]);
    const loaded = reduce(state, {
      type: 'archived_sessions_loaded',
      workspaceId: 'other-workspace',
      sessions: [summary('s9'), summary('sX')],
      nextCursor: null,
      append: false,
    });
    expect(loaded.archivedSessions.items.map(s => s.id)).toEqual(['s9']);
    expect(loaded.archivedSessions.ownerWorkspaceId).toBe(WORKSPACE);
    const loading = reduce(state, {
      type: 'archived_sessions_loading',
      workspaceId: 'other-workspace',
    });
    expect(loading.archivedSessions.status).toBe('ready');
  });

  it('drops foreign rows immediately when loading a new workspace archive', () => {
    const state = ownedState('other-workspace', [summary('sX')]);
    const loading = reduce(state, { type: 'archived_sessions_loading', workspaceId: WORKSPACE });
    expect(loading.archivedSessions.status).toBe('loading');
    expect(loading.archivedSessions.items).toEqual([]);
  });

  it('keeps rows of the same workspace while loading', () => {
    const state = ownedState(WORKSPACE, [summary('s9')]);
    const loading = reduce(state, { type: 'archived_sessions_loading', workspaceId: WORKSPACE });
    expect(loading.archivedSessions.items.map(s => s.id)).toEqual(['s9']);
  });

  it('records the owning workspace on a successful load', () => {
    const next = reduce(seededState(), {
      type: 'archived_sessions_loaded',
      workspaceId: WORKSPACE,
      sessions: [summary('s9')],
      nextCursor: null,
      append: false,
    });
    expect(next.archivedSessions.ownerWorkspaceId).toBe(WORKSPACE);
  });

  it('session_deleted clears the stale runtime projection', () => {
    const state: WorkbenchState = {
      ...seededState(),
      sessionRuntimeById: {
        s2: {
          workspaceId: WORKSPACE,
          sessionId: 's2',
          runtimeRevision: 'r',
          phase: 'idle',
          pendingApprovalCount: 0,
          resident: false,
          estimatedBytes: 0,
          updatedAt: '2026-09-02T00:00:00.000Z',
        },
      },
    };
    const next = reduce(state, { type: 'session_deleted', sessionId: 's2' });
    expect(next.sessionRuntimeById['s2']).toBeUndefined();
    expect(next.sessions.map(s => s.id)).toEqual(['s1']);
  });
});

describe('reducer lifecycle idempotency (v0.3.8)', () => {
  it('archiving an already-archived session never duplicates the archived row', () => {
    const state: WorkbenchState = {
      ...seededState(),
      archivedSessions: {
        status: 'ready',
        items: [summary('s2')],
        nextCursor: null,
        ownerWorkspaceId: WORKSPACE,
      },
    };
    const next = reduce(state, { type: 'session_archived', session: summary('s2') });
    expect(next.archivedSessions.items.map(s => s.id)).toEqual(['s2']);
    expect(next.sessions.map(s => s.id)).toEqual(['s1']);
  });

  it('archiving a session that is not in the main listing is a safe no-op for the main list', () => {
    const state: WorkbenchState = {
      ...seededState(),
      sessions: [summary('s1')],
      workspaceSessions: {
        [WORKSPACE]: { status: 'ready', items: [summary('s1')], nextCursor: null },
      },
    };
    const next = reduce(state, { type: 'session_archived', session: summary('s-unknown') });
    expect(next.sessions.map(s => s.id)).toEqual(['s1']);
    expect(next.archivedSessions.items.map(s => s.id)).toEqual(['s-unknown']);
  });

  it('deleting an unknown session id is a safe no-op', () => {
    const next = reduce(seededState(), { type: 'session_deleted', sessionId: 'nope' });
    expect(next.sessions.map(s => s.id)).toEqual(['s2', 's1']);
    expect(next.archivedSessions.items).toEqual([]);
  });

  it('restoring a session already in the main list moves it to the top without duplicating', () => {
    const state: WorkbenchState = {
      ...seededState(),
      archivedSessions: {
        status: 'ready',
        items: [summary('s1', { name: '旧' })],
        nextCursor: null,
        ownerWorkspaceId: WORKSPACE,
      },
    };
    const restored = summary('s1', { name: '旧' });
    const next = reduce(state, { type: 'session_restored', session: restored });
    expect(next.sessions.map(s => s.id)).toEqual(['s1', 's2']);
    expect(next.archivedSessions.items).toEqual([]);
  });
});
