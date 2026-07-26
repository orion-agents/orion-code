/**
 * v0.2.23 — TUI Input Ownership Controller.
 *
 * Manages capture/restore of prompt state across modal interactions
 * (Inspector, session picker, permission prompt, history search).
 * All modal paths restore the prior input state in finally.
 */

import type { TuiInputParserState } from '../tui-core/input-parser';

// ============================================================================
// Types
// ============================================================================

export interface TuiInputDraftSnapshot {
  value: string;
  cursor: number;
  parserState: TuiInputParserState;
  historySearch?: {
    query: string;
    selectedIndex: number;
    originalDraft: string;
  };
}

export type TuiInputOwner =
  | 'prompt'
  | 'inspector'
  | 'session-picker'
  | 'file-picker'
  | 'permission'
  | 'history-search';

export interface TuiInputOwnershipState {
  current: TuiInputOwner;
  previous: TuiInputOwner | null;
  snapshot: TuiInputDraftSnapshot | null;
}

// ============================================================================
// Controller
// ============================================================================

export class TuiInputOwnershipController {
  private state: TuiInputOwnershipState = {
    current: 'prompt',
    previous: null,
    snapshot: null,
  };

  /** Current input owner. */
  get owner(): TuiInputOwner {
    return this.state.current;
  }

  /** True when a modal interaction is active. */
  get isModal(): boolean {
    return this.state.current !== 'prompt';
  }

  /**
   * Capture the current prompt state and activate a modal owner.
   * If already in a modal, this is a no-op (no nesting).
   */
  capture(owner: TuiInputOwner, snapshot: TuiInputDraftSnapshot): void {
    if (this.state.current === owner) return;
    if (this.state.current !== 'prompt') return; // Don't nest modals.

    this.state = {
      current: owner,
      previous: 'prompt',
      snapshot,
    };
  }

  /**
   * Restore the previous owner and return the saved snapshot.
   * Idempotent: calling restore when owner is 'prompt' is a safe no-op.
   */
  restore(): TuiInputDraftSnapshot | null {
    if (this.state.current === 'prompt') return null;

    const snapshot = this.state.snapshot;
    this.state = {
      current: 'prompt',
      previous: null,
      snapshot: null,
    };
    return snapshot;
  }

  /** Check if a given key/action should be routed to the current owner. */
  routesToOwner(owner: TuiInputOwner): boolean {
    return this.state.current === owner;
  }

  /** Reset to default prompt owner (for error recovery). */
  reset(): void {
    this.state = {
      current: 'prompt',
      previous: null,
      snapshot: null,
    };
  }
}