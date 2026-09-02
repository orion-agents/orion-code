import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, realpathSync, statSync } from 'fs';
import { basename, isAbsolute, resolve } from 'path';
import type { IDisposable, IPty } from 'node-pty';

import { WebWorkbenchError } from './errors';

const MAX_TERMINALS = 4;
const MAX_WORKSPACE_TERMINALS = 2;
const MAX_SCROLLBACK_BYTES = 2 * 1024 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_FRAME_CHARS = 8_000;
const OUTPUT_COALESCE_MS = 8;
const DEFAULT_TICKET_TTL_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_FORCE_KILL_DELAY_MS = 1_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 1_000;
const DEFAULT_FORCE_KILL_GRACE_MS = 1_000;
const PROCESS_REAP_POLL_MS = 25;

export type WebTerminalStateV1 = 'running' | 'exited' | 'closing';

export interface WebTerminalMetadataV1 {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly shell: string;
  readonly state: WebTerminalStateV1;
  readonly cols: number;
  readonly rows: number;
  readonly connected: boolean;
  readonly createdAt: string;
  readonly lastActiveAt: string;
  readonly earliestSequence: number;
  readonly lastSequence: number;
  readonly exitCode?: number;
  readonly signal?: number;
}

export interface WebTerminalCreateResultV1 {
  readonly terminal: WebTerminalMetadataV1;
  readonly ticket: string;
  readonly ticketExpiresAt: string;
}

export interface WebTerminalOutputFrameV1 {
  readonly type: 'output';
  readonly sequence: number;
  readonly data: string;
}

export interface WebTerminalGapV1 {
  readonly type: 'gap';
  readonly earliestSequence: number;
  readonly latestSequence: number;
}

export interface WebTerminalExitV1 {
  readonly type: 'exit';
  readonly exitCode: number;
  readonly signal?: number;
}

export interface TerminalConnectionV1 {
  readonly terminal: WebTerminalMetadataV1;
  readonly replay: readonly WebTerminalOutputFrameV1[];
  readonly gap?: WebTerminalGapV1;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  setOutputPaused(paused: boolean): void;
  dispose(): void;
}

export interface TerminalProcessV1 {
  readonly pid: number;
  readonly process: string;
  readonly cols: number;
  readonly rows: number;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
  isAlive?(): boolean;
  onData(listener: (data: string) => void): IDisposable;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): IDisposable;
}

export interface TerminalBackendV1 {
  spawn(
    file: string,
    args: readonly string[],
    options: {
      readonly name: string;
      readonly cols: number;
      readonly rows: number;
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
    }
  ): TerminalProcessV1;
}

export interface TerminalManagerOptions {
  readonly resolveWorkspace: (workspaceId: string) => string | undefined;
  readonly getActiveContext: () => {
    readonly workspaceId: string;
    readonly contextRevision: string;
  };
  readonly backend?: TerminalBackendV1;
  readonly now?: () => number;
  readonly ticketTtlMs?: number;
  readonly idleTimeoutMs?: number;
  readonly forceKillDelayMs?: number;
  readonly shutdownGraceMs?: number;
  readonly forceKillGraceMs?: number;
  readonly onWorkspaceMutationHint?: (workspaceId: string) => void;
}

interface OutputFrame {
  readonly sequence: number;
  readonly data: string;
  readonly bytes: number;
}

interface TerminalSubscriber {
  readonly token: string;
  readonly onFrame: (frame: WebTerminalOutputFrameV1) => void;
  readonly onExit: (event: WebTerminalExitV1) => void;
  readonly onReplaced: () => void;
}

interface TerminalEntry {
  readonly id: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly shell: string;
  readonly title: string;
  readonly createdAtMs: number;
  process: TerminalProcessV1;
  state: WebTerminalStateV1;
  cols: number;
  rows: number;
  lastActiveAtMs: number;
  nextSequence: number;
  frames: OutputFrame[];
  frameBytes: number;
  pendingOutput: string;
  outputFlushTimer?: NodeJS.Timeout;
  subscriber?: TerminalSubscriber;
  exitCode?: number;
  signal?: number;
  idleTimer?: NodeJS.Timeout;
  forceKillTimer?: NodeJS.Timeout;
  reapTimer?: NodeJS.Timeout;
  dataSubscription: IDisposable;
  exitSubscription: IDisposable;
  removeAfterExit: boolean;
  outputPaused: boolean;
  readonly ownedProcesses: Map<number, string>;
}

interface TicketRecord {
  readonly terminalId: string;
  readonly digest: Buffer;
  readonly expiresAt: number;
}

/** Owns explicit-user PTYs; terminal bytes never enter Workbench SSE or durable storage. */
export class TerminalManagerV1 {
  private readonly terminals = new Map<string, TerminalEntry>();
  private readonly tickets = new Map<string, TicketRecord>();
  private readonly resolveWorkspace: TerminalManagerOptions['resolveWorkspace'];
  private readonly getActiveContext: TerminalManagerOptions['getActiveContext'];
  private readonly backend?: TerminalBackendV1;
  private readonly now: () => number;
  private readonly ticketTtlMs: number;
  private readonly idleTimeoutMs: number;
  private readonly forceKillDelayMs: number;
  private readonly shutdownGraceMs: number;
  private readonly forceKillGraceMs: number;
  private readonly onWorkspaceMutationHint?: (workspaceId: string) => void;
  private closed = false;
  private shutdownPromise?: Promise<void>;

  constructor(options: TerminalManagerOptions) {
    this.resolveWorkspace = options.resolveWorkspace;
    this.getActiveContext = options.getActiveContext;
    this.backend = options.backend;
    this.now = options.now ?? Date.now;
    this.ticketTtlMs = boundedPositive(options.ticketTtlMs ?? DEFAULT_TICKET_TTL_MS, 'ticketTtlMs');
    this.idleTimeoutMs = boundedPositive(
      options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      'idleTimeoutMs'
    );
    this.forceKillDelayMs = boundedPositive(
      options.forceKillDelayMs ?? DEFAULT_FORCE_KILL_DELAY_MS,
      'forceKillDelayMs'
    );
    this.shutdownGraceMs = boundedPositive(
      options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
      'shutdownGraceMs'
    );
    this.forceKillGraceMs = boundedPositive(
      options.forceKillGraceMs ?? DEFAULT_FORCE_KILL_GRACE_MS,
      'forceKillGraceMs'
    );
    this.onWorkspaceMutationHint = options.onWorkspaceMutationHint;
  }

  get available(): boolean {
    if (this.backend) return true;
    try {
      loadNodePtyBackend();
      return true;
    } catch {
      return false;
    }
  }

  list(workspaceId: string): readonly WebTerminalMetadataV1[] {
    return Object.freeze(
      [...this.terminals.values()]
        .filter(entry => entry.workspaceId === workspaceId)
        .sort((left, right) => left.createdAtMs - right.createdAtMs)
        .map(entry => this.metadata(entry))
    );
  }

  create(input: {
    readonly workspaceId: string;
    readonly expectedContextRevision: string;
    readonly cols?: number;
    readonly rows?: number;
  }): WebTerminalCreateResultV1 {
    this.assertOpen();
    const active = this.getActiveContext();
    if (
      active.workspaceId !== input.workspaceId ||
      active.contextRevision !== input.expectedContextRevision
    ) {
      throw new WebWorkbenchError(
        409,
        'The active Context changed before terminal creation.',
        'context_revision_conflict'
      );
    }
    const workspace = this.resolveWorkspace(input.workspaceId);
    if (!workspace) {
      throw new WebWorkbenchError(404, 'Workspace was not found.', 'workspace_not_found');
    }
    const canonicalWorkspace = canonicalDirectory(workspace);
    const running = [...this.terminals.values()].filter(entry => entry.state === 'running');
    if (running.length >= MAX_TERMINALS) {
      throw new WebWorkbenchError(409, 'Terminal limit reached.', 'terminal_limit_reached');
    }
    if (
      running.filter(entry => entry.workspaceId === input.workspaceId).length >=
      MAX_WORKSPACE_TERMINALS
    ) {
      throw new WebWorkbenchError(
        409,
        'Workspace terminal limit reached.',
        'terminal_workspace_limit_reached'
      );
    }
    const cols = boundedDimension(input.cols ?? 100, 2, 400, 'cols');
    const rows = boundedDimension(input.rows ?? 30, 1, 200, 'rows');
    const shell = resolveShell();
    const backend = this.backend ?? loadNodePtyBackend();
    let process: TerminalProcessV1;
    try {
      process = backend.spawn(shell, shellArguments(shell), {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: canonicalWorkspace,
        env: terminalEnvironment(shell),
      });
    } catch {
      throw new WebWorkbenchError(
        503,
        'The native terminal backend could not start a shell.',
        'terminal_backend_unavailable'
      );
    }
    const id = randomUUID();
    const now = this.now();
    const entry = {} as TerminalEntry;
    Object.assign(entry, {
      id,
      workspaceId: input.workspaceId,
      cwd: canonicalWorkspace,
      shell,
      title: basename(shell),
      createdAtMs: now,
      process,
      state: 'running' as const,
      cols,
      rows,
      lastActiveAtMs: now,
      nextSequence: 1,
      frames: [],
      frameBytes: 0,
      pendingOutput: '',
      dataSubscription: process.onData(data => this.appendOutput(entry, data)),
      exitSubscription: process.onExit(event => this.handleExit(entry, event)),
      removeAfterExit: false,
      outputPaused: false,
      ownedProcesses: new Map<number, string>(),
    } satisfies Partial<TerminalEntry>);
    rememberProcessTree(entry);
    this.terminals.set(id, entry);
    this.scheduleIdle(entry);
    const ticket = this.issueTicket(id);
    return Object.freeze({
      terminal: this.metadata(entry),
      ticket: ticket.value,
      ticketExpiresAt: new Date(ticket.expiresAt).toISOString(),
    });
  }

  issueAttachTicket(input: {
    readonly terminalId: string;
    readonly workspaceId: string;
    readonly expectedContextRevision: string;
  }): { readonly ticket: string; readonly ticketExpiresAt: string } {
    this.assertActiveContext(input.workspaceId, input.expectedContextRevision);
    const entry = this.requireTerminal(input.terminalId);
    if (entry.workspaceId !== input.workspaceId) {
      throw new WebWorkbenchError(404, 'Terminal was not found.', 'terminal_not_found');
    }
    if (entry.state !== 'running') {
      throw new WebWorkbenchError(409, 'Terminal is no longer running.', 'terminal_not_running');
    }
    const ticket = this.issueTicket(entry.id);
    return Object.freeze({
      ticket: ticket.value,
      ticketExpiresAt: new Date(ticket.expiresAt).toISOString(),
    });
  }

  attach(input: {
    readonly terminalId: string;
    readonly ticket: string;
    readonly afterSequence: number;
    readonly onFrame: (frame: WebTerminalOutputFrameV1) => void;
    readonly onExit: (event: WebTerminalExitV1) => void;
    readonly onReplaced: () => void;
  }): TerminalConnectionV1 {
    this.assertOpen();
    if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0) {
      throw new WebWorkbenchError(
        400,
        'Terminal sequence is invalid.',
        'terminal_sequence_invalid'
      );
    }
    const entry = this.requireTerminal(input.terminalId);
    this.consumeTicket(entry.id, input.ticket);
    this.flushPendingOutput(entry, true);
    if (entry.outputPaused) this.setProcessOutputPaused(entry, false);
    entry.subscriber?.onReplaced();
    const token = randomUUID();
    entry.subscriber = {
      token,
      onFrame: input.onFrame,
      onExit: input.onExit,
      onReplaced: input.onReplaced,
    };
    this.touch(entry);
    const earliest = entry.frames[0]?.sequence ?? entry.nextSequence;
    const latest = entry.nextSequence - 1;
    const gap =
      input.afterSequence < earliest - 1
        ? Object.freeze({
            type: 'gap' as const,
            earliestSequence: earliest,
            latestSequence: latest,
          })
        : undefined;
    const replay = entry.frames
      .filter(frame => frame.sequence > input.afterSequence)
      .map(frame =>
        Object.freeze({ type: 'output' as const, sequence: frame.sequence, data: frame.data })
      );
    return Object.freeze({
      terminal: this.metadata(entry),
      replay: Object.freeze(replay),
      ...(gap ? { gap } : {}),
      write: (data: string) => {
        this.assertConnection(entry, token);
        if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > MAX_INPUT_BYTES) {
          throw new WebWorkbenchError(
            400,
            'Terminal input is too large.',
            'terminal_input_invalid'
          );
        }
        entry.process.write(data);
        this.touch(entry);
        if (/[\r\n]/u.test(data)) this.onWorkspaceMutationHint?.(entry.workspaceId);
      },
      resize: (cols: number, rows: number) => {
        this.assertConnection(entry, token);
        const nextCols = boundedDimension(cols, 2, 400, 'cols');
        const nextRows = boundedDimension(rows, 1, 200, 'rows');
        entry.process.resize(nextCols, nextRows);
        entry.cols = nextCols;
        entry.rows = nextRows;
        this.touch(entry);
      },
      setOutputPaused: (paused: boolean) => {
        this.assertConnection(entry, token);
        if (typeof paused !== 'boolean') {
          throw new WebWorkbenchError(
            400,
            'Terminal output flow state is invalid.',
            'terminal_flow_invalid'
          );
        }
        this.setProcessOutputPaused(entry, paused);
      },
      dispose: () => {
        if (entry.subscriber?.token !== token) return;
        entry.subscriber = undefined;
        if (entry.outputPaused) this.setProcessOutputPaused(entry, false);
      },
    });
  }

  closeTerminal(input: {
    readonly terminalId: string;
    readonly workspaceId: string;
    readonly expectedContextRevision: string;
  }): WebTerminalMetadataV1 {
    this.assertActiveContext(input.workspaceId, input.expectedContextRevision);
    const entry = this.requireTerminal(input.terminalId);
    if (entry.workspaceId !== input.workspaceId) {
      throw new WebWorkbenchError(404, 'Terminal was not found.', 'terminal_not_found');
    }
    entry.removeAfterExit = true;
    if (entry.state === 'running') {
      entry.state = 'closing';
      this.terminateEntry(entry);
    } else {
      if (isProcessTreeAlive(entry)) {
        forceKillProcessTree(entry);
        this.scheduleReap(entry);
      } else {
        this.removeEntry(entry);
      }
    }
    return this.metadata(entry);
  }

  closeWorkspace(workspaceId: string): void {
    for (const entry of [...this.terminals.values()]) {
      if (entry.workspaceId !== workspaceId) continue;
      entry.removeAfterExit = true;
      if (entry.state === 'running') {
        entry.state = 'closing';
        this.terminateEntry(entry);
      } else {
        if (isProcessTreeAlive(entry)) {
          forceKillProcessTree(entry);
          this.scheduleReap(entry);
        } else {
          this.removeEntry(entry);
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    this.tickets.clear();
    const entries = [...this.terminals.values()];
    for (const entry of entries) {
      entry.removeAfterExit = true;
      if (entry.state === 'running') entry.state = 'closing';
      if (isProcessTreeAlive(entry)) this.terminateEntry(entry);
      else this.removeEntry(entry);
    }
    await this.reapStoppedEntries(entries, this.shutdownGraceMs);
    const survivors = entries.filter(
      entry => this.terminals.get(entry.id) === entry && isProcessTreeAlive(entry)
    );
    for (const entry of survivors) forceKillProcessTree(entry);
    await this.reapStoppedEntries(survivors, this.forceKillGraceMs);
    const orphans = survivors.filter(
      entry => this.terminals.get(entry.id) === entry && isProcessTreeAlive(entry)
    );
    if (orphans.length > 0) {
      throw new WebWorkbenchError(
        503,
        'One or more terminal process trees survived Host shutdown.',
        'terminal_shutdown_incomplete'
      );
    }
  }

  private async reapStoppedEntries(
    entries: readonly TerminalEntry[],
    timeoutMs: number
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let alive = false;
      for (const entry of entries) {
        if (this.terminals.get(entry.id) !== entry) continue;
        if (isProcessTreeAlive(entry)) {
          alive = true;
          continue;
        }
        this.removeEntry(entry);
      }
      if (!alive || Date.now() >= deadline) return;
      await delay(Math.min(PROCESS_REAP_POLL_MS, Math.max(1, deadline - Date.now())));
    }
  }

  private terminateEntry(entry: TerminalEntry): void {
    terminateProcessTree(entry);
    if (entry.forceKillTimer) clearTimeout(entry.forceKillTimer);
    entry.forceKillTimer = setTimeout(() => {
      entry.forceKillTimer = undefined;
      if (this.terminals.get(entry.id) !== entry || !isProcessTreeAlive(entry)) {
        if (entry.removeAfterExit && this.terminals.get(entry.id) === entry) {
          this.removeEntry(entry);
        }
        return;
      }
      forceKillProcessTree(entry);
      this.scheduleReap(entry);
    }, this.forceKillDelayMs);
    entry.forceKillTimer.unref();
  }

  private scheduleReap(entry: TerminalEntry): void {
    if (entry.reapTimer || this.terminals.get(entry.id) !== entry) return;
    const check = () => {
      entry.reapTimer = undefined;
      if (this.terminals.get(entry.id) !== entry) return;
      if (!isProcessTreeAlive(entry)) {
        if (entry.removeAfterExit) this.removeEntry(entry);
        return;
      }
      forceKillProcessTree(entry);
      entry.reapTimer = setTimeout(check, PROCESS_REAP_POLL_MS);
      entry.reapTimer.unref();
    };
    entry.reapTimer = setTimeout(check, PROCESS_REAP_POLL_MS);
    entry.reapTimer.unref();
  }

  private setProcessOutputPaused(entry: TerminalEntry, paused: boolean): void {
    if (entry.outputPaused === paused) return;
    try {
      if (paused) entry.process.pause();
      else entry.process.resume();
      entry.outputPaused = paused;
    } catch {
      throw new WebWorkbenchError(
        503,
        'Terminal output flow control failed.',
        'terminal_flow_failed'
      );
    }
  }

  private appendOutput(entry: TerminalEntry, data: string): void {
    if (entry.state !== 'running' && entry.state !== 'closing') return;
    entry.pendingOutput += data;
    this.flushPendingOutput(entry, data.length >= MAX_OUTPUT_FRAME_CHARS);
    if (entry.pendingOutput && !entry.outputFlushTimer) {
      entry.outputFlushTimer = setTimeout(() => {
        entry.outputFlushTimer = undefined;
        this.flushPendingOutput(entry, true);
      }, OUTPUT_COALESCE_MS);
      entry.outputFlushTimer.unref();
    }
  }

  private flushPendingOutput(entry: TerminalEntry, force: boolean, final = false): void {
    let emitted = false;
    while (
      entry.pendingOutput.length > 0 &&
      (force || entry.pendingOutput.length >= MAX_OUTPUT_FRAME_CHARS)
    ) {
      let end = Math.min(entry.pendingOutput.length, MAX_OUTPUT_FRAME_CHARS);
      if (
        end < entry.pendingOutput.length &&
        end > 0 &&
        isHighSurrogate(entry.pendingOutput.charCodeAt(end - 1)) &&
        isLowSurrogate(entry.pendingOutput.charCodeAt(end))
      ) {
        end -= 1;
      }
      if (
        !final &&
        end === entry.pendingOutput.length &&
        isHighSurrogate(entry.pendingOutput.charCodeAt(end - 1))
      ) {
        break;
      }
      if (end <= 0) break;
      const value = replaceUnpairedSurrogates(entry.pendingOutput.slice(0, end));
      entry.pendingOutput = entry.pendingOutput.slice(end);
      const frame = Object.freeze({
        sequence: entry.nextSequence++,
        data: value,
        bytes: Buffer.byteLength(value, 'utf8'),
      });
      entry.frames.push(frame);
      entry.frameBytes += frame.bytes;
      while (entry.frameBytes > MAX_SCROLLBACK_BYTES && entry.frames.length > 0) {
        const removed = entry.frames.shift();
        entry.frameBytes -= removed?.bytes ?? 0;
      }
      entry.subscriber?.onFrame(
        Object.freeze({ type: 'output', sequence: frame.sequence, data: frame.data })
      );
      emitted = true;
    }
    if (!entry.pendingOutput && entry.outputFlushTimer) {
      clearTimeout(entry.outputFlushTimer);
      entry.outputFlushTimer = undefined;
    }
    if (emitted) this.touch(entry);
  }

  private handleExit(entry: TerminalEntry, event: { exitCode: number; signal?: number }): void {
    if (this.terminals.get(entry.id) !== entry) return;
    this.flushPendingOutput(entry, true, true);
    entry.state = 'exited';
    entry.exitCode = event.exitCode;
    entry.signal = event.signal;
    entry.outputPaused = false;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.forceKillTimer) clearTimeout(entry.forceKillTimer);
    entry.subscriber?.onExit(
      Object.freeze({
        type: 'exit',
        exitCode: event.exitCode,
        ...(event.signal !== undefined ? { signal: event.signal } : {}),
      })
    );
    entry.subscriber = undefined;
    this.onWorkspaceMutationHint?.(entry.workspaceId);
    if (isProcessTreeAlive(entry)) {
      forceKillProcessTree(entry);
      this.scheduleReap(entry);
    } else if (entry.removeAfterExit) {
      this.removeEntry(entry);
    }
  }

  private issueTicket(terminalId: string): { readonly value: string; readonly expiresAt: number } {
    for (const [key, record] of this.tickets) {
      if (record.terminalId === terminalId) this.tickets.delete(key);
    }
    const value = randomBytes(32).toString('base64url');
    const digest = ticketDigest(value);
    const expiresAt = this.now() + this.ticketTtlMs;
    this.tickets.set(terminalId, { terminalId, digest, expiresAt });
    return Object.freeze({ value, expiresAt });
  }

  private consumeTicket(terminalId: string, value: string): void {
    const record = this.tickets.get(terminalId);
    const digest = ticketDigest(typeof value === 'string' ? value : '');
    if (
      !record ||
      record.expiresAt < this.now() ||
      record.digest.length !== digest.length ||
      !timingSafeEqual(record.digest, digest)
    ) {
      throw new WebWorkbenchError(
        403,
        'Terminal stream ticket is invalid.',
        'terminal_ticket_invalid'
      );
    }
    this.tickets.delete(terminalId);
  }

  private metadata(entry: TerminalEntry): WebTerminalMetadataV1 {
    return Object.freeze({
      id: entry.id,
      workspaceId: entry.workspaceId,
      title: entry.title,
      shell: basename(entry.shell),
      state: entry.state,
      cols: entry.cols,
      rows: entry.rows,
      connected: Boolean(entry.subscriber),
      createdAt: new Date(entry.createdAtMs).toISOString(),
      lastActiveAt: new Date(entry.lastActiveAtMs).toISOString(),
      earliestSequence: entry.frames[0]?.sequence ?? entry.nextSequence,
      lastSequence: entry.nextSequence - 1,
      ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
      ...(entry.signal !== undefined ? { signal: entry.signal } : {}),
    });
  }

  private assertConnection(entry: TerminalEntry, token: string): void {
    if (entry.subscriber?.token !== token) {
      throw new WebWorkbenchError(409, 'Terminal connection was replaced.', 'terminal_replaced');
    }
    if (entry.state !== 'running') {
      throw new WebWorkbenchError(409, 'Terminal is no longer running.', 'terminal_not_running');
    }
  }

  private assertActiveContext(workspaceId: string, contextRevision: string): void {
    this.assertOpen();
    const active = this.getActiveContext();
    if (active.workspaceId !== workspaceId || active.contextRevision !== contextRevision) {
      throw new WebWorkbenchError(
        409,
        'The active Context changed before terminal mutation.',
        'context_revision_conflict'
      );
    }
  }

  private requireTerminal(id: string): TerminalEntry {
    const entry = this.terminals.get(id);
    if (!entry) throw new WebWorkbenchError(404, 'Terminal was not found.', 'terminal_not_found');
    return entry;
  }

  private touch(entry: TerminalEntry): void {
    entry.lastActiveAtMs = this.now();
    this.scheduleIdle(entry);
  }

  private scheduleIdle(entry: TerminalEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (entry.state !== 'running') return;
      if (this.now() - entry.lastActiveAtMs < this.idleTimeoutMs) {
        this.scheduleIdle(entry);
        return;
      }
      entry.state = 'closing';
      this.terminateEntry(entry);
    }, this.idleTimeoutMs);
    entry.idleTimer.unref();
  }

  private removeEntry(entry: TerminalEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.forceKillTimer) clearTimeout(entry.forceKillTimer);
    if (entry.reapTimer) clearTimeout(entry.reapTimer);
    if (entry.outputFlushTimer) clearTimeout(entry.outputFlushTimer);
    entry.dataSubscription.dispose();
    entry.exitSubscription.dispose();
    entry.subscriber = undefined;
    this.terminals.delete(entry.id);
    this.tickets.delete(entry.id);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new WebWorkbenchError(503, 'Terminal manager is closed.', 'terminal_unavailable');
    }
  }
}

function loadNodePtyBackend(): TerminalBackendV1 {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodePty = require('node-pty') as typeof import('node-pty');
  return Object.freeze({
    spawn: (
      file: string,
      args: readonly string[],
      options: {
        readonly name: string;
        readonly cols: number;
        readonly rows: number;
        readonly cwd: string;
        readonly env: Readonly<Record<string, string>>;
      }
    ): IPty => nodePty.spawn(file, [...args], { ...options, env: { ...options.env } }),
  });
}

function resolveShell(): string {
  const configured = process.env.SHELL;
  const candidates = [
    configured,
    process.platform === 'win32' ? process.env.COMSPEC : '/bin/zsh',
    '/bin/bash',
  ];
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate) || !existsSync(candidate)) continue;
    try {
      const canonical = realpathSync(candidate);
      const stat = statSync(canonical);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return canonical;
    } catch {
      // Try the next bounded shell candidate.
    }
  }
  throw new WebWorkbenchError(
    503,
    'No interactive shell is available.',
    'terminal_shell_unavailable'
  );
}

function shellArguments(shell: string): readonly string[] {
  if (process.platform === 'win32') return [];
  return basename(shell) === 'zsh' ? ['-f'] : ['--noprofile', '--norc'];
}

function terminalEnvironment(shell: string): Record<string, string> {
  const env: Record<string, string> = {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    SHELL: shell,
  };
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR']) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

function canonicalDirectory(path: string): string {
  try {
    const canonical = realpathSync(resolve(path));
    if (!statSync(canonical).isDirectory()) throw new Error('not a directory');
    return canonical;
  } catch {
    throw new WebWorkbenchError(400, 'Workspace directory is unavailable.');
  }
}

function ticketDigest(ticket: string): Buffer {
  return createHash('sha256').update(ticket).digest();
}

function boundedPositive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function boundedDimension(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new WebWorkbenchError(400, `${name} must be an integer from ${min} through ${max}.`);
  }
  return value;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function replaceUnpairedSurrogates(value: string): string {
  let normalized = '';
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (isHighSurrogate(current)) {
      const next = value.charCodeAt(index + 1);
      if (isLowSurrogate(next)) {
        normalized += value[index] + value[index + 1];
        index += 1;
      } else {
        normalized += '\ufffd';
      }
      continue;
    }
    normalized += isLowSurrogate(current) ? '\ufffd' : value[index];
  }
  return normalized;
}

interface ProcessRow {
  readonly pid: number;
  readonly parentPid: number;
  readonly state: string;
  readonly identity: string;
}

function terminateProcessTree(entry: TerminalEntry): void {
  signalProcessTree(entry, 'SIGTERM');
}

function forceKillProcessTree(entry: TerminalEntry): void {
  signalProcessTree(entry, 'SIGKILL');
}

function signalProcessTree(entry: TerminalEntry, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    try {
      entry.process.kill(signal);
    } catch {
      // The process may already have exited.
    }
    return;
  }
  const rows = rememberProcessTree(entry);
  let groupSignalled = false;
  const rootIdentity = entry.ownedProcesses.get(entry.process.pid);
  if (rootIdentity && rows.get(entry.process.pid)?.identity === rootIdentity) {
    try {
      process.kill(-entry.process.pid, signal);
      groupSignalled = true;
    } catch {
      // A PTY child may not remain the process-group leader after shell startup.
    }
  }
  const owned = [...entry.ownedProcesses.entries()]
    .filter(([pid, identity]) => {
      const row = rows.get(pid);
      return row?.identity === identity && !isZombie(row);
    })
    .sort(([leftPid], [rightPid]) => {
      if (leftPid === entry.process.pid) return 1;
      if (rightPid === entry.process.pid) return -1;
      return rightPid - leftPid;
    });
  for (const [pid] of owned) {
    try {
      process.kill(pid, signal);
    } catch {
      // The process exited after the bounded ownership snapshot.
    }
  }
  if (!groupSignalled && owned.length === 0) {
    try {
      entry.process.kill(signal);
    } catch {
      // The process is already gone.
    }
  }
}

function isProcessTreeAlive(entry: TerminalEntry): boolean {
  if (entry.process.isAlive) {
    try {
      return entry.process.isAlive();
    } catch {
      return true;
    }
  }
  if (process.platform === 'win32') {
    try {
      process.kill(entry.process.pid, 0);
      return true;
    } catch (error) {
      return !isMissingProcessError(error);
    }
  }
  const rows = rememberProcessTree(entry);
  for (const [pid, identity] of entry.ownedProcesses) {
    const row = rows.get(pid);
    if (row?.identity === identity && !isZombie(row)) return true;
  }
  return false;
}

function rememberProcessTree(entry: TerminalEntry): Map<number, ProcessRow> {
  const rows = readProcessRows();
  if (rows.size === 0) return rows;
  const childrenByParent = new Map<number, ProcessRow[]>();
  for (const row of rows.values()) {
    const children = childrenByParent.get(row.parentPid) ?? [];
    children.push(row);
    childrenByParent.set(row.parentPid, children);
  }
  const pending = [entry.process.pid, ...entry.ownedProcesses.keys()];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const pid = pending.pop()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    const row = rows.get(pid);
    const existingIdentity = entry.ownedProcesses.get(pid);
    if (existingIdentity && row?.identity !== existingIdentity) continue;
    if (row && !existingIdentity) entry.ownedProcesses.set(pid, row.identity);
    for (const child of childrenByParent.get(pid) ?? []) pending.push(child.pid);
  }
  return rows;
}

function readProcessRows(): Map<number, ProcessRow> {
  if (process.platform === 'win32') return new Map();
  try {
    const output = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,stat=,lstart='], {
      encoding: 'utf8',
      timeout: 1_000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const rows = new Map<number, ProcessRow>();
    for (const line of output.split('\n')) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u);
      if (!match) continue;
      const pid = Number(match[1]);
      const parentPid = Number(match[2]);
      if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid)) continue;
      rows.set(pid, Object.freeze({ pid, parentPid, state: match[3], identity: match[4] }));
    }
    return rows;
  } catch {
    return new Map();
  }
}

function isZombie(row: ProcessRow): boolean {
  return row.state.startsWith('Z');
}

function isMissingProcessError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ESRCH';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}
