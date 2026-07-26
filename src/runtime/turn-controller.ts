export type TurnStatus = 'idle' | 'running' | 'aborting';

export interface TurnHandle {
  id: number;
  input: string;
  abortController: AbortController;
  abortSignal: AbortSignal;
}

export interface TurnSnapshot {
  status: TurnStatus;
  activeTurnId?: number;
  pendingRevision?: string;
  verificationState?: 'pending' | 'running' | 'passed' | 'failed' | 'gated';
}

export interface TurnControllerOptions {
  exitConfirmWindowMs?: number;
}

const DEFAULT_EXIT_CONFIRM_WINDOW_MS = 2000;

/**
 * Owns the single active CLI turn. It prevents concurrent agent runs and keeps
 * live revision semantics independent from terminal rendering details.
 */
export class TurnController {
  private nextTurnId = 1;
  private activeTurn: TurnHandle | null = null;
  private status: TurnStatus = 'idle';
  private pendingRevision: string | undefined;
  private verificationState: 'pending' | 'running' | 'passed' | 'failed' | 'gated' | undefined;
  private lastExitIntentAt = 0;
  private readonly exitConfirmWindowMs: number;

  constructor(options: TurnControllerOptions = {}) {
    this.exitConfirmWindowMs = options.exitConfirmWindowMs ?? DEFAULT_EXIT_CONFIRM_WINDOW_MS;
  }

  beginTurn(input: string): TurnHandle {
    if (this.activeTurn) {
      throw new Error('A turn is already running');
    }

    const abortController = new AbortController();
    const turn: TurnHandle = {
      id: this.nextTurnId++,
      input,
      abortController,
      abortSignal: abortController.signal,
    };

    this.activeTurn = turn;
    this.status = 'running';
    this.pendingRevision = undefined;
    this.verificationState = undefined;
    this.clearExitIntent();
    return turn;
  }

  requestRevision(input: string): boolean {
    if (!this.activeTurn) return false;

    this.pendingRevision = input;
    this.status = 'aborting';
    if (!this.activeTurn.abortController.signal.aborted) {
      this.activeTurn.abortController.abort();
    }
    return true;
  }

  interruptActiveTurn(): boolean {
    if (!this.activeTurn) return false;

    this.status = 'aborting';
    if (!this.activeTurn.abortController.signal.aborted) {
      this.activeTurn.abortController.abort();
    }
    return true;
  }

  finishTurn(turnId: number): string | undefined {
    if (!this.activeTurn || this.activeTurn.id !== turnId) {
      return undefined;
    }

    this.activeTurn = null;
    this.status = 'idle';
    const revision = this.pendingRevision;
    this.pendingRevision = undefined;
    return revision;
  }

  setVerificationState(state: 'pending' | 'running' | 'passed' | 'failed' | 'gated'): void {
    this.verificationState = state;
  }

  getVerificationState(): 'pending' | 'running' | 'passed' | 'failed' | 'gated' | undefined {
    return this.verificationState;
  }

  hasActiveTurn(): boolean {
    return this.activeTurn !== null;
  }

  getSnapshot(): TurnSnapshot {
    return {
      status: this.status,
      activeTurnId: this.activeTurn?.id,
      pendingRevision: this.pendingRevision,
      verificationState: this.verificationState,
    };
  }

  registerExitIntent(now = Date.now()): boolean {
    const shouldExit =
      this.lastExitIntentAt > 0 &&
      now - this.lastExitIntentAt <= this.exitConfirmWindowMs;

    this.lastExitIntentAt = shouldExit ? 0 : now;
    return shouldExit;
  }

  clearExitIntent(): void {
    this.lastExitIntentAt = 0;
  }
}

