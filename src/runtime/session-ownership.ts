import { PACKAGE_VERSION } from '../product/version';
import { acquireSessionLease, type SessionLease } from './session-ownership-lease';

export interface SessionOwnershipCoordinatorDependencies {
  readonly acquireLease: (sessionId: string, version: string) => Promise<SessionLease>;
  readonly version: string;
}

const defaultDependencies: SessionOwnershipCoordinatorDependencies = {
  acquireLease: acquireSessionLease,
  version: PACKAGE_VERSION,
};

/**
 * Serializes renderer-neutral session ownership changes. Runtime transitions
 * execute while both the old and candidate leases are held, so a failed start
 * can discard the candidate without exposing an unowned active runtime.
 */
export class SessionOwnershipCoordinator {
  private transactionTail: Promise<void> = Promise.resolve();
  private activeLease?: SessionLease;
  private readonly retiredLeases: SessionLease[] = [];
  private closed = false;

  constructor(
    private readonly dependencies: SessionOwnershipCoordinatorDependencies = defaultDependencies
  ) {}

  activate(sessionId: string, transition: () => Promise<void>): Promise<void> {
    return this.serialize(async () => {
      this.assertOpen();
      const current = this.activeLease;
      if (current?.owner.sessionId === sessionId) {
        await transition();
        return;
      }

      const candidate = await this.dependencies.acquireLease(sessionId, this.dependencies.version);
      try {
        await transition();
      } catch (transitionError) {
        try {
          await candidate.release();
        } catch (releaseError) {
          throw combineErrors(
            `Session ${sessionId} activation failed and its candidate lease could not be released`,
            transitionError,
            releaseError
          );
        }
        throw transitionError;
      }

      this.activeLease = candidate;
      if (current) await this.retire(current);
    });
  }

  switch(sessionId: string, transition: () => Promise<void>): Promise<void> {
    return this.activate(sessionId, transition);
  }

  release(transition: () => Promise<void> = async () => undefined): Promise<void> {
    return this.serialize(async () => {
      await transition();
      const current = this.activeLease;
      this.activeLease = undefined;
      if (current) await this.releaseRequired(current);
      await this.releaseRetired();
    });
  }

  close(transition: () => Promise<void> = async () => undefined): Promise<void> {
    return this.serialize(async () => {
      if (this.closed) return;
      await transition();
      const current = this.activeLease;
      this.activeLease = undefined;
      if (current) await this.releaseRequired(current);
      await this.releaseRetired();
      this.closed = true;
    });
  }

  get activeSessionId(): string | undefined {
    return this.activeLease?.owner.sessionId;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transactionTail.then(operation, operation);
    this.transactionTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async retire(lease: SessionLease): Promise<void> {
    try {
      await lease.release();
    } catch {
      // A failed old-owner cleanup cannot roll back a runtime transition that
      // already committed. Retain the exact handle and retry during shutdown.
      this.retiredLeases.push(lease);
    }
  }

  private async releaseRetired(): Promise<void> {
    if (this.retiredLeases.length === 0) return;
    const pending = this.retiredLeases.splice(0);
    const failures: unknown[] = [];
    for (const lease of pending) {
      try {
        await lease.release();
      } catch (error) {
        failures.push(error);
        this.retiredLeases.push(lease);
      }
    }
    if (failures.length > 0) {
      throw new SessionOwnershipError(
        'One or more retired session leases could not be released.',
        failures
      );
    }
  }

  private async releaseRequired(lease: SessionLease): Promise<void> {
    try {
      await lease.release();
    } catch (error) {
      this.activeLease = lease;
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Session ownership coordinator is closed.');
  }
}

export class SessionOwnershipError extends Error {
  constructor(
    message: string,
    readonly errors: readonly unknown[]
  ) {
    super(message);
    this.name = 'SessionOwnershipError';
  }
}

function combineErrors(message: string, first: unknown, second: unknown): SessionOwnershipError {
  return new SessionOwnershipError(message, [first, second]);
}
