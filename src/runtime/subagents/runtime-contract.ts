import type { AuthoritySnapshotV1 } from '../step-snapshot';
import type {
  ParentThreadForkRequestV1,
  SubagentThreadBudgetRequestV1,
  SubagentThreadReceiptV1,
} from '../subagent-thread-runtime';
import type { SubtaskPacket, SubtaskResult } from './types';

export interface ProductionSubagentExecutionRequestV1 {
  readonly taskId: string;
  readonly packet: SubtaskPacket;
  readonly canonicalScopePaths?: readonly string[];
  readonly parent: ParentThreadForkRequestV1;
  readonly parentAuthority: AuthoritySnapshotV1;
  readonly budget: SubagentThreadBudgetRequestV1;
  readonly timeoutMs: number;
  readonly abortSignal?: AbortSignal;
  readonly rootObjectiveSummary?: string;
  readonly modelLabel?: string;
}

export interface ProductionSubagentExecutionOutcomeV1 {
  readonly result: SubtaskResult;
  readonly parentCancelled: boolean;
  /** Present only after the digest-bound receipt was durably journaled. */
  readonly receipt?: SubagentThreadReceiptV1;
}

/** Explicit DI port consumed by the Supervisor; no query or global tool lookup is allowed. */
export interface ProductionSubagentExecutionPortV1 {
  readonly serviceId: string;
  execute(
    request: ProductionSubagentExecutionRequestV1
  ): Promise<ProductionSubagentExecutionOutcomeV1>;
  /** Releases the per-root-turn tree budget, queue and abort graph. Idempotent. */
  close(reason?: string): void | Promise<void>;
}
