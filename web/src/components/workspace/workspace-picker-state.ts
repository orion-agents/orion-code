/**
 * v0.3.16 — LOCAL WORKSPACE picker state machine (pure, DOM-free).
 *
 * Opening a project is a two-phase flow: browse/inspect never touch the Host
 * Context, and only `activate-started` submits the confirmed path. Keeping the
 * transitions in a pure reducer means the invariant "nothing activates before
 * confirm" is unit-testable without rendering anything.
 */
import type { WebWorkspaceCandidateV1 } from '../../types';

export type WorkspacePickerPhase =
  | 'browse'
  | 'picker-pending'
  | 'inspect-pending'
  | 'confirm'
  | 'activate-pending';

export interface WorkspacePickerState {
  readonly phase: WorkspacePickerPhase;
  /** The inspected candidate awaiting confirmation, if any. */
  readonly candidate: WebWorkspaceCandidateV1 | null;
  /** Path echoed while inspecting so the skeleton can name the target. */
  readonly pendingPath: string | null;
  readonly error: string | null;
  /**
   * True once a picker result was cancelled or reported unavailable — used to
   * return focus to the "choose folder" button without treating it as failure.
   */
  readonly pickerReturned: boolean;
}

export const initialWorkspacePickerState: WorkspacePickerState = Object.freeze({
  phase: 'browse',
  candidate: null,
  pendingPath: null,
  error: null,
  pickerReturned: false,
});

export type WorkspacePickerEvent =
  | { readonly type: 'picker-started' }
  | { readonly type: 'picker-cancelled' }
  | { readonly type: 'picker-unavailable'; readonly reason: string }
  | { readonly type: 'inspect-started'; readonly path: string }
  | { readonly type: 'inspect-succeeded'; readonly candidate: WebWorkspaceCandidateV1 }
  | { readonly type: 'activate-started' }
  | { readonly type: 'failed'; readonly message: string }
  | { readonly type: 'back-to-browse' }
  | { readonly type: 'reset' };

export function workspacePickerReducer(
  state: WorkspacePickerState,
  event: WorkspacePickerEvent
): WorkspacePickerState {
  switch (event.type) {
    case 'picker-started':
      // A picker may start from browse, from a previous error, or to replace a
      // confirm card the user backed out of.
      return { ...state, phase: 'picker-pending', error: null, pickerReturned: false };
    case 'picker-cancelled':
      return { ...state, phase: 'browse', error: null, pendingPath: null, pickerReturned: true };
    case 'picker-unavailable':
      return {
        ...state,
        phase: 'browse',
        error: event.reason,
        pendingPath: null,
        pickerReturned: true,
      };
    case 'inspect-started':
      return {
        ...state,
        phase: 'inspect-pending',
        pendingPath: event.path,
        candidate: null,
        error: null,
        pickerReturned: false,
      };
    case 'inspect-succeeded':
      return {
        ...state,
        phase: 'confirm',
        candidate: event.candidate,
        pendingPath: null,
        error: null,
      };
    case 'activate-started':
      // Guard: activation is only reachable from a confirmed candidate.
      if (state.phase !== 'confirm' || !state.candidate) return state;
      return { ...state, phase: 'activate-pending', error: null };
    case 'failed':
      return {
        ...state,
        phase: state.candidate ? 'confirm' : 'browse',
        error: event.message,
        pendingPath: null,
      };
    case 'back-to-browse':
      return { ...state, phase: 'browse', candidate: null, pendingPath: null, error: null };
    case 'reset':
      return initialWorkspacePickerState;
    default:
      return state;
  }
}

/** True while a picker or inspect request is outstanding. */
export function workspacePickerBusy(state: WorkspacePickerState): boolean {
  return (
    state.phase === 'picker-pending' ||
    state.phase === 'inspect-pending' ||
    state.phase === 'activate-pending'
  );
}
