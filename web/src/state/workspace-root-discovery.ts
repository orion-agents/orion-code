/**
 * v0.3.21 — state machine for project-root discovery in the workspace dialog.
 *
 * Roots and discovery are deliberately separate from the workspace picker
 * phases: a root is an authorized scan boundary, a candidate is a hint, and
 * only the existing confirmation card can start an activation. A generation
 * counter drops stale scan responses after the user switches roots, removes a
 * root, or re-triggers a scan.
 */
import type { WebWorkspaceRootCandidateV1, WebWorkspaceRootViewV1 } from '../types';

export type WorkspaceRootDiscoveryPhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'partial'
  | 'empty'
  | 'error'
  | 'cancelled';

export interface WorkspaceRootDiscoveryState {
  readonly phase: WorkspaceRootDiscoveryPhase;
  /** Saved roots, newest first (registry order). */
  readonly roots: readonly WebWorkspaceRootViewV1[];
  /** The root whose candidates are displayed, if any. */
  readonly activeRootId: string | null;
  readonly candidates: readonly WebWorkspaceRootCandidateV1[];
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  /** Bumped on every scan start; responses from older generations are dropped. */
  readonly generation: number;
  readonly rootsLoading: boolean;
  readonly scanning: boolean;
}

export const initialWorkspaceRootDiscoveryState: WorkspaceRootDiscoveryState = {
  phase: 'idle',
  roots: [],
  activeRootId: null,
  candidates: [],
  errorCode: null,
  errorMessage: null,
  generation: 0,
  rootsLoading: false,
  scanning: false,
};

export type WorkspaceRootDiscoveryAction =
  | { readonly type: 'reset' }
  | { readonly type: 'roots-loading' }
  | { readonly type: 'roots-loaded'; readonly roots: readonly WebWorkspaceRootViewV1[] }
  | { readonly type: 'roots-failed'; readonly message: string }
  | { readonly type: 'root-added'; readonly root: WebWorkspaceRootViewV1 }
  | { readonly type: 'root-removed'; readonly rootId: string }
  | { readonly type: 'scan-started'; readonly rootId: string; readonly generation: number }
  | {
      readonly type: 'scan-succeeded';
      readonly rootId: string;
      readonly generation: number;
      readonly candidates: readonly WebWorkspaceRootCandidateV1[];
      readonly status: 'ready' | 'partial';
      readonly errorCode?: string;
    }
  | {
      readonly type: 'scan-failed';
      readonly rootId: string;
      readonly generation: number;
      readonly message: string;
      readonly errorCode?: string;
    }
  | { readonly type: 'scan-cancelled'; readonly rootId: string; readonly generation: number };

const candidateCountOf = (
  roots: readonly WebWorkspaceRootViewV1[],
  rootId: string
): number | null => {
  const root = roots.find(entry => entry.id === rootId);
  return root?.discovery?.candidateCount ?? null;
};

export function workspaceRootDiscoveryReducer(
  state: WorkspaceRootDiscoveryState,
  action: WorkspaceRootDiscoveryAction
): WorkspaceRootDiscoveryState {
  switch (action.type) {
    case 'reset':
      return { ...initialWorkspaceRootDiscoveryState };
    case 'roots-loading':
      return { ...state, rootsLoading: true, errorMessage: null, errorCode: null };
    case 'roots-loaded':
      return {
        ...state,
        rootsLoading: false,
        roots: action.roots,
        errorMessage: null,
        errorCode: null,
      };
    case 'roots-failed':
      return { ...state, rootsLoading: false, errorMessage: action.message };
    case 'root-added': {
      const roots = [action.root, ...state.roots.filter(root => root.id !== action.root.id)];
      return { ...state, roots };
    }
    case 'root-removed': {
      const roots = state.roots.filter(root => root.id !== action.rootId);
      const activeCleared = state.activeRootId === action.rootId;
      return {
        ...state,
        roots,
        ...(activeCleared
          ? {
              activeRootId: null,
              candidates: [],
              phase: 'idle' as const,
              errorCode: null,
              errorMessage: null,
              scanning: false,
            }
          : {}),
      };
    }
    case 'scan-started': {
      // A new generation invalidates every response from older scans.
      return {
        ...state,
        phase: 'loading',
        activeRootId: action.rootId,
        generation: action.generation,
        scanning: true,
        errorCode: null,
        errorMessage: null,
        candidates: [],
      };
    }
    case 'scan-succeeded': {
      // Stale response (the user moved on): drop it.
      if (action.generation !== state.generation || action.rootId !== state.activeRootId) {
        return state;
      }
      const roots = state.roots.map(root =>
        root.id === action.rootId
          ? {
              ...root,
              lastScannedAt: new Date().toISOString(),
              discovery: {
                status: action.status,
                candidateCount: action.candidates.length,
                durationMs: 0,
                cached: false,
                ...(action.errorCode ? { errorCode: action.errorCode } : {}),
              },
            }
          : root
      );
      return {
        ...state,
        scanning: false,
        roots,
        candidates: action.candidates,
        phase:
          action.candidates.length > 0
            ? action.status === 'partial'
              ? 'partial'
              : 'ready'
            : 'empty',
        ...(action.status === 'partial' && action.errorCode ? { errorCode: action.errorCode } : {}),
      };
    }
    case 'scan-failed': {
      if (action.generation !== state.generation || action.rootId !== state.activeRootId) {
        return state;
      }
      return {
        ...state,
        scanning: false,
        phase: 'error',
        errorMessage: action.message,
        ...(action.errorCode ? { errorCode: action.errorCode } : {}),
      };
    }
    case 'scan-cancelled': {
      if (action.generation !== state.generation || action.rootId !== state.activeRootId) {
        return state;
      }
      return { ...state, scanning: false, phase: 'cancelled', candidates: [] };
    }
    default:
      return state;
  }
}

/** Status line for a root row (no absolute paths, no candidate names). */
export function workspaceRootScanSummary(
  state: WorkspaceRootDiscoveryState,
  root: WebWorkspaceRootViewV1
): string {
  if (state.scanning && state.activeRootId === root.id) return '扫描中…';
  if (state.activeRootId === root.id && state.phase === 'loading') return '扫描中…';
  if (root.discovery) {
    if (root.discovery.errorCode === 'budget_exceeded') return '部分结果（预算内未扫完）';
    if (root.discovery.errorCode) return '上次扫描未完成';
    const count = root.discovery.candidateCount;
    return root.discovery.status === 'partial' ? `部分结果（${count} 个候选）` : `${count} 个候选`;
  }
  if (root.lastScannedAt) return '尚未在本次会话扫描';
  return '尚未扫描';
}

export { candidateCountOf };
