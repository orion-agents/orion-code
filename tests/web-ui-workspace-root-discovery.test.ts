import {
  initialWorkspaceRootDiscoveryState,
  workspaceRootDiscoveryReducer,
  workspaceRootScanSummary,
} from '../web/src/state/workspace-root-discovery';
import type { WebWorkspaceRootViewV1 } from '../web/src/types';

function root(id: string, overrides: Partial<WebWorkspaceRootViewV1> = {}): WebWorkspaceRootViewV1 {
  return {
    id,
    canonicalPath: `/tmp/roots/${id}`,
    label: id,
    addedAt: '2026-10-08T00:00:00.000Z',
    discovery: null,
    ...overrides,
  };
}

describe('workspaceRootDiscoveryReducer', () => {
  it('loads the roots list without scanning', () => {
    let state = workspaceRootDiscoveryReducer(initialWorkspaceRootDiscoveryState, {
      type: 'roots-loading',
    });
    expect(state.rootsLoading).toBe(true);
    state = workspaceRootDiscoveryReducer(state, {
      type: 'roots-loaded',
      roots: [root('alpha')],
    });
    expect(state.rootsLoading).toBe(false);
    expect(state.roots).toHaveLength(1);
    expect(state.scanning).toBe(false);
  });

  it('tracks the scan generation and drops stale responses', () => {
    let state = workspaceRootDiscoveryReducer(initialWorkspaceRootDiscoveryState, {
      type: 'scan-started',
      rootId: 'alpha',
      generation: 1,
    });
    expect(state.phase).toBe('loading');
    expect(state.scanning).toBe(true);
    // A response from an older generation must be dropped.
    state = workspaceRootDiscoveryReducer(state, {
      type: 'scan-succeeded',
      rootId: 'alpha',
      generation: 0,
      candidates: [],
      status: 'ready',
    });
    expect(state.phase).toBe('loading');
    // The current generation lands.
    state = workspaceRootDiscoveryReducer(state, {
      type: 'scan-succeeded',
      rootId: 'alpha',
      generation: 1,
      candidates: [
        { rootId: 'alpha', relativePath: 'proj', label: 'proj', hint: 'git', status: 'ready' },
      ],
      status: 'ready',
    });
    expect(state.phase).toBe('ready');
    expect(state.candidates).toHaveLength(1);
    expect(state.scanning).toBe(false);
  });

  it('distinguishes ready, partial, empty, and error phases', () => {
    let state = workspaceRootDiscoveryReducer(initialWorkspaceRootDiscoveryState, {
      type: 'scan-started',
      rootId: 'alpha',
      generation: 1,
    });
    state = workspaceRootDiscoveryReducer(state, {
      type: 'scan-succeeded',
      rootId: 'alpha',
      generation: 1,
      candidates: [
        { rootId: 'alpha', relativePath: '', label: 'alpha', hint: 'git', status: 'ready' },
      ],
      status: 'partial',
      errorCode: 'budget_exceeded',
    });
    expect(state.phase).toBe('partial');
    expect(state.errorCode).toBe('budget_exceeded');
    state = workspaceRootDiscoveryReducer(state, {
      type: 'scan-succeeded',
      rootId: 'alpha',
      generation: 1,
      candidates: [],
      status: 'ready',
    });
    expect(state.phase).toBe('empty');
    state = workspaceRootDiscoveryReducer(state, {
      type: 'scan-failed',
      rootId: 'alpha',
      generation: 1,
      message: 'The root directory is not readable.',
      errorCode: 'root_unreadable',
    });
    expect(state.phase).toBe('error');
    expect(state.errorMessage).toBe('The root directory is not readable.');
  });

  it('clears the active root and candidates when that root is removed', () => {
    let state = workspaceRootDiscoveryReducer(initialWorkspaceRootDiscoveryState, {
      type: 'roots-loaded',
      roots: [root('alpha'), root('beta')],
    });
    state = workspaceRootDiscoveryReducer(state, {
      type: 'scan-started',
      rootId: 'alpha',
      generation: 1,
    });
    state = workspaceRootDiscoveryReducer(state, { type: 'root-removed', rootId: 'alpha' });
    expect(state.roots.map((entry: WebWorkspaceRootViewV1) => entry.id)).toEqual(['beta']);
    expect(state.activeRootId).toBeNull();
    expect(state.candidates).toHaveLength(0);
    expect(state.scanning).toBe(false);
  });

  it('summarizes a root row without paths or candidate names', () => {
    let state = workspaceRootDiscoveryReducer(initialWorkspaceRootDiscoveryState, {
      type: 'roots-loaded',
      roots: [root('alpha', { discovery: { status: 'ready', candidateCount: 7, durationMs: 120, cached: true } })],
    });
    expect(workspaceRootScanSummary(state, state.roots[0])).toBe('7 个候选');
    state = workspaceRootDiscoveryReducer(state, {
      type: 'scan-started',
      rootId: 'alpha',
      generation: 2,
    });
    expect(workspaceRootScanSummary(state, state.roots[0])).toBe('扫描中…');
    const summary = JSON.stringify(workspaceRootScanSummary(state, state.roots[0]));
    expect(summary).not.toContain('/tmp/roots');
  });
});
