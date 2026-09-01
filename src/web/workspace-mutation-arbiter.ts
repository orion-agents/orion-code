import { createHash } from 'crypto';
import { createReadStream, lstatSync, readlinkSync } from 'fs';
import { relative, resolve } from 'path';

import type { WorkspaceMutationCoordinatorV1 } from '../runtime/step-snapshot';

export type WorkspaceMutationPhaseV1 = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface WorkspaceMutationStateV1 {
  readonly workspaceId: string;
  readonly invocationId: string;
  readonly phase: WorkspaceMutationPhaseV1;
  readonly queuePosition?: number;
}

export interface WorkspaceMutationAdmissionV1 {
  readonly workspaceId: string;
  readonly invocationId: string;
  readonly baselineRevision: string;
  readonly readCurrentRevision: () => string | Promise<string>;
  readonly abortSignal?: AbortSignal;
}

export interface WorkspaceMutationArbiterOptionsV1 {
  readonly onStateChanged?: (state: WorkspaceMutationStateV1) => void;
}

interface WorkspaceQueueEntry<T> {
  readonly admission: WorkspaceMutationAdmissionV1;
  readonly operation: () => T | Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
  running: boolean;
}

/**
 * FIFO admission for side-effecting tool execution in one Workspace.
 *
 * Callers capture a target-specific revision before joining the queue. The
 * revision is checked again only after the entry reaches the head, ensuring a
 * stale edit never executes after another Session changed its target. Queues
 * for different Workspaces remain independent.
 */
export class WorkspaceMutationArbiterV1 implements WorkspaceMutationCoordinatorV1 {
  private readonly queues = new Map<string, WorkspaceQueueEntry<unknown>[]>();
  private readonly preparing = new Set<string>();
  private closed = false;

  constructor(private readonly options: WorkspaceMutationArbiterOptionsV1 = {}) {}

  async runWorkspaceMutation<T>(
    input: {
      readonly workspaceId: string;
      readonly invocationId: string;
      readonly toolName: string;
      readonly args: Readonly<Record<string, unknown>>;
      readonly abortSignal?: AbortSignal;
    },
    operation: () => T | Promise<T>
  ): Promise<T> {
    this.assertOpen();
    const invocationId = input.invocationId.trim();
    if (!invocationId || this.preparing.has(invocationId) || this.find(invocationId)) {
      throw new WorkspaceMutationArbiterError(
        'workspace_mutation_duplicate',
        'Workspace mutation invocationId is already queued or running.'
      );
    }
    this.preparing.add(invocationId);
    try {
      const baselineRevision = await mutationTargetRevision(input);
      this.preparing.delete(invocationId);
      return await this.run(
        {
          workspaceId: input.workspaceId,
          invocationId,
          baselineRevision,
          readCurrentRevision: () => mutationTargetRevision(input),
          abortSignal: input.abortSignal,
        },
        operation
      );
    } finally {
      this.preparing.delete(invocationId);
    }
  }

  run<T>(admission: WorkspaceMutationAdmissionV1, operation: () => T | Promise<T>): Promise<T> {
    this.assertOpen();
    const workspaceId = admission.workspaceId.trim();
    const invocationId = admission.invocationId.trim();
    if (!workspaceId || !invocationId || !admission.baselineRevision.trim()) {
      throw new Error('Workspace mutation identity and baseline revision must not be empty.');
    }
    if (admission.abortSignal?.aborted) {
      return Promise.reject(
        new WorkspaceMutationArbiterError(
          'workspace_mutation_cancelled',
          'Workspace mutation was cancelled before admission.'
        )
      );
    }
    if (this.preparing.has(invocationId) || this.find(invocationId)) {
      throw new WorkspaceMutationArbiterError(
        'workspace_mutation_duplicate',
        'Workspace mutation invocationId is already queued or running.'
      );
    }

    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const result = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const entry: WorkspaceQueueEntry<T> = {
      admission: Object.freeze({ ...admission, workspaceId, invocationId }),
      operation,
      resolve,
      reject,
      running: false,
    };
    const queue = this.queues.get(workspaceId) ?? [];
    queue.push(entry as WorkspaceQueueEntry<unknown>);
    this.queues.set(workspaceId, queue);
    this.publishQueue(workspaceId);
    if (queue.length === 1) void this.startHead(workspaceId);
    return result;
  }

  snapshot(workspaceId?: string): readonly WorkspaceMutationStateV1[] {
    const states: WorkspaceMutationStateV1[] = [];
    for (const [candidate, queue] of this.queues) {
      if (workspaceId && workspaceId !== candidate) continue;
      queue.forEach((entry, index) =>
        states.push(
          Object.freeze({
            workspaceId: candidate,
            invocationId: entry.admission.invocationId,
            phase: entry.running ? 'running' : 'queued',
            ...(entry.running ? {} : { queuePosition: waitingPosition(queue, index) }),
          })
        )
      );
    }
    return Object.freeze(states);
  }

  close(reason = 'Workspace mutation arbiter closed'): void {
    if (this.closed) return;
    this.closed = true;
    for (const [workspaceId, queue] of this.queues) {
      for (const entry of queue) {
        if (entry.running) continue;
        entry.reject(new WorkspaceMutationArbiterError('workspace_mutation_cancelled', reason));
        this.publish(entry, 'cancelled');
      }
      this.queues.set(
        workspaceId,
        queue.filter(entry => entry.running)
      );
    }
  }

  private async startHead(workspaceId: string): Promise<void> {
    const queue = this.queues.get(workspaceId);
    const entry = queue?.[0];
    if (!queue || !entry || entry.running) return;
    if (this.closed || entry.admission.abortSignal?.aborted) {
      this.finishHead(
        workspaceId,
        entry,
        new WorkspaceMutationArbiterError(
          'workspace_mutation_cancelled',
          'Workspace mutation was cancelled while queued.'
        )
      );
      return;
    }
    entry.running = true;
    this.publish(entry, 'running');
    try {
      const revision = await entry.admission.readCurrentRevision();
      if (revision !== entry.admission.baselineRevision) {
        throw new WorkspaceMutationArbiterError(
          'workspace_mutation_conflict',
          'The mutation target changed while this Session waited for Workspace admission.'
        );
      }
      const result = await entry.operation();
      entry.resolve(result);
      this.publish(entry, 'completed');
      this.finishHead(workspaceId, entry);
    } catch (error) {
      entry.reject(error);
      this.publish(
        entry,
        error instanceof WorkspaceMutationArbiterError &&
          error.code === 'workspace_mutation_cancelled'
          ? 'cancelled'
          : 'failed'
      );
      this.finishHead(workspaceId, entry);
    }
  }

  private finishHead(
    workspaceId: string,
    entry: WorkspaceQueueEntry<unknown>,
    earlyError?: unknown
  ): void {
    const queue = this.queues.get(workspaceId);
    if (!queue || queue[0] !== entry) return;
    if (earlyError) {
      entry.reject(earlyError);
      this.publish(
        entry,
        earlyError instanceof WorkspaceMutationArbiterError &&
          earlyError.code === 'workspace_mutation_cancelled'
          ? 'cancelled'
          : 'failed'
      );
    }
    queue.shift();
    if (queue.length === 0) this.queues.delete(workspaceId);
    else {
      this.publishQueue(workspaceId);
      void this.startHead(workspaceId);
    }
  }

  private publishQueue(workspaceId: string): void {
    const queue = this.queues.get(workspaceId) ?? [];
    queue.forEach((entry, index) => {
      if (!entry.running) this.publish(entry, 'queued', waitingPosition(queue, index));
    });
  }

  private publish(
    entry: WorkspaceQueueEntry<unknown>,
    phase: WorkspaceMutationPhaseV1,
    queuePosition?: number
  ): void {
    this.options.onStateChanged?.(
      Object.freeze({
        workspaceId: entry.admission.workspaceId,
        invocationId: entry.admission.invocationId,
        phase,
        ...(queuePosition === undefined ? {} : { queuePosition }),
      })
    );
  }

  private find(invocationId: string): WorkspaceQueueEntry<unknown> | undefined {
    for (const queue of this.queues.values()) {
      const entry = queue.find(candidate => candidate.admission.invocationId === invocationId);
      if (entry) return entry;
    }
    return undefined;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new WorkspaceMutationArbiterError(
        'workspace_mutation_cancelled',
        'Workspace mutation arbiter is closed.'
      );
    }
  }
}

function waitingPosition(queue: readonly WorkspaceQueueEntry<unknown>[], index: number): number {
  return index + (queue[0]?.running ? 0 : 1);
}

async function mutationTargetRevision(input: {
  readonly workspaceId: string;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
}): Promise<string> {
  if (
    (input.toolName !== 'edit_file' && input.toolName !== 'write_file') ||
    typeof input.args.path !== 'string' ||
    !input.args.path.trim()
  ) {
    return 'serialized-workspace-mutation-v1';
  }
  const root = resolve(input.workspaceId);
  const target = resolve(root, input.args.path);
  const traversal = relative(root, target);
  if (traversal === '..' || traversal.startsWith(`..${pathSeparator()}`)) {
    return `outside-workspace:${digestText(target)}`;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const before = fileIdentity(target);
      if (before.kind !== 'file') return digestText(JSON.stringify(before));
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(target)) digest.update(chunk as Buffer);
      const after = fileIdentity(target);
      if (JSON.stringify(before) === JSON.stringify(after)) {
        return digestText(JSON.stringify({ identity: after, content: digest.digest('hex') }));
      }
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') return digestText('missing');
      return digestText(`unreadable:${code}`);
    }
  }
  return digestText(`unstable:${Date.now()}`);
}

function fileIdentity(target: string): Readonly<Record<string, string>> {
  try {
    const stat = lstatSync(target, { bigint: true });
    if (stat.isSymbolicLink()) {
      return Object.freeze({
        kind: 'symlink',
        target: readlinkSync(target),
        mtimeNs: stat.mtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString(),
      });
    }
    return Object.freeze({
      kind: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other',
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      size: stat.size.toString(),
      mtimeNs: stat.mtimeNs.toString(),
      ctimeNs: stat.ctimeNs.toString(),
    });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return Object.freeze({ kind: 'missing' });
    return Object.freeze({ kind: 'unreadable', code: errorCode(error) });
  }
}

function digestText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { readonly code: unknown }).code)
    : 'UNKNOWN';
}

function pathSeparator(): string {
  return process.platform === 'win32' ? '\\' : '/';
}

export class WorkspaceMutationArbiterError extends Error {
  constructor(
    readonly code:
      | 'workspace_mutation_cancelled'
      | 'workspace_mutation_conflict'
      | 'workspace_mutation_duplicate',
    message: string
  ) {
    super(message);
    this.name = 'WorkspaceMutationArbiterError';
  }
}
