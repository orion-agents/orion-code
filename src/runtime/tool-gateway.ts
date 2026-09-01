import type { ToolContext, ToolResult } from '../framework/tool';
import { digestRuntimeValue } from './protocol/canonical';
import { isRuntimeId } from './protocol/runtime-protocol-v1';
import {
  ExecutionService,
  type BoundToolExecutionResultV1,
  type StepSnapshotV1,
  type ToolBindingDescriptorV1,
} from './step-snapshot';

export type ToolPolicyBehaviorV1 = 'allow' | 'ask' | 'deny';
export type ToolTerminalV1 = 'completed' | 'failed' | 'interrupted' | 'indeterminate';

export interface ToolInvocationV1 {
  readonly invocationId: string;
  readonly parentInvocationId?: string;
  readonly snapshot: StepSnapshotV1;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly context: ToolContext;
  readonly abortSignal?: AbortSignal;
}

export interface ToolPolicyDecisionV1 {
  readonly behavior: ToolPolicyBehaviorV1;
  readonly source: string;
  readonly reason?: string;
  readonly digest: string;
}

export interface ToolApprovalDecisionV1 {
  readonly approved: boolean;
  readonly source: string;
  readonly reason?: string;
  readonly digest: string;
}

export interface SandboxPreparationV1 {
  readonly backend: string;
  readonly enforcement: 'full' | 'partial' | 'none';
  readonly reason?: string;
  readonly digest: string;
}

export interface ToolPolicyServiceV1 {
  decide(input: {
    readonly snapshot: StepSnapshotV1;
    readonly descriptor: ToolBindingDescriptorV1;
    readonly args: Readonly<Record<string, unknown>>;
  }): Promise<ToolPolicyDecisionV1> | ToolPolicyDecisionV1;
}

export interface ToolApprovalServiceV1 {
  decide(input: {
    readonly snapshot: StepSnapshotV1;
    readonly descriptor: ToolBindingDescriptorV1;
    readonly args: Readonly<Record<string, unknown>>;
    readonly policy: ToolPolicyDecisionV1;
    readonly abortSignal?: AbortSignal;
  }): Promise<ToolApprovalDecisionV1> | ToolApprovalDecisionV1;
}

export interface SandboxServiceV1 {
  prepare(input: {
    readonly snapshot: StepSnapshotV1;
    readonly descriptor: ToolBindingDescriptorV1;
    readonly args: Readonly<Record<string, unknown>>;
    readonly abortSignal?: AbortSignal;
  }): Promise<SandboxPreparationV1> | SandboxPreparationV1;
}

export interface ToolInvocationIntentV1 {
  readonly version: 1;
  readonly invocationId: string;
  readonly parentInvocationId?: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly toolName: string;
  readonly snapshotDigest: string;
  readonly argsDigest: string;
  readonly requestDigest: string;
  readonly startedAt: number;
  readonly digest: string;
}

export interface ToolInvocationReceiptV1 {
  readonly version: 1;
  readonly invocationId: string;
  readonly parentInvocationId?: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly toolName: string;
  readonly snapshotDigest: string;
  readonly routerDigest: string;
  readonly authorityDigest: string;
  readonly executionPolicyDigest: string;
  readonly intentDigest: string;
  readonly policy?: ToolPolicyDecisionV1;
  readonly approval?: ToolApprovalDecisionV1;
  readonly sandbox?: SandboxPreparationV1;
  readonly terminal: ToolTerminalV1;
  readonly terminalPhase: 'capability' | 'policy' | 'approval' | 'sandbox' | 'execute';
  readonly success: boolean;
  readonly result: ToolResult;
  readonly outputDigest: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly durationMs: number;
  readonly digest: string;
}

export interface ToolInvocationJournalEntryV1 {
  readonly intent: ToolInvocationIntentV1;
  readonly receipt?: ToolInvocationReceiptV1;
}

export interface ToolInvocationJournalV1 {
  load(invocationId: string): Promise<ToolInvocationJournalEntryV1 | null>;
  begin(intent: ToolInvocationIntentV1): Promise<void>;
  complete(receipt: ToolInvocationReceiptV1): Promise<void>;
}

export interface ToolInvocationResultV1 {
  readonly result: ToolResult;
  readonly receipt: ToolInvocationReceiptV1;
}

export interface NestedToolInvocationV1 {
  readonly invocationId: string;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * ToolGateway-owned composite execution seam. Implementations may describe an
 * aggregate operation, but every child effect must re-enter the same gateway.
 */
export interface NestedToolExecutionServiceV1 {
  handles(descriptor: ToolBindingDescriptorV1): boolean;
  run(input: {
    readonly invocation: ToolInvocationV1;
    readonly descriptor: ToolBindingDescriptorV1;
    readonly invokeChild: (child: NestedToolInvocationV1) => Promise<ToolInvocationResultV1>;
  }): Promise<BoundToolExecutionResultV1>;
}

export interface ToolGatewayServicesV1 {
  readonly policy: ToolPolicyServiceV1;
  readonly approval: ToolApprovalServiceV1;
  readonly sandbox: SandboxServiceV1;
  readonly execution: ExecutionService;
  readonly nested?: NestedToolExecutionServiceV1;
  readonly journal: ToolInvocationJournalV1;
  readonly clock?: () => number;
}

export class ToolGatewayError extends Error {
  constructor(
    readonly code:
      | 'ORION_TOOL_INVOCATION_INVALID'
      | 'ORION_TOOL_INVOCATION_CONFLICT'
      | 'ORION_TOOL_OUTCOME_INDETERMINATE'
      | 'ORION_TOOL_RECEIPT_PERSISTENCE',
    message: string,
    readonly invocationId?: string
  ) {
    super(message);
    this.name = 'ToolGatewayError';
  }
}

/** Capability → Policy → Approval → Sandbox → Execute → durable terminal receipt. */
export class ToolGateway {
  private readonly inflight = new Map<string, Promise<ToolInvocationResultV1>>();
  private readonly clock: () => number;

  constructor(private readonly services: ToolGatewayServicesV1) {
    this.clock = services.clock ?? Date.now;
  }

  invoke(invocation: ToolInvocationV1): Promise<ToolInvocationResultV1> {
    const existing = this.inflight.get(invocation.invocationId);
    if (existing) return existing;
    const run = this.invokeOnce(invocation).finally(() =>
      this.inflight.delete(invocation.invocationId)
    );
    this.inflight.set(invocation.invocationId, run);
    return run;
  }

  private async invokeOnce(invocation: ToolInvocationV1): Promise<ToolInvocationResultV1> {
    validateInvocation(invocation);
    const startedAt = this.clock();
    const intent = createIntent(invocation, startedAt);
    const existing = await this.services.journal.load(invocation.invocationId);
    if (existing) {
      if (existing.intent.requestDigest !== intent.requestDigest) {
        throw new ToolGatewayError(
          'ORION_TOOL_INVOCATION_CONFLICT',
          'Invocation ID was reused with different arguments or snapshot',
          invocation.invocationId
        );
      }
      if (existing.receipt) {
        return deepFreeze({ result: existing.receipt.result, receipt: existing.receipt });
      }
      throw new ToolGatewayError(
        'ORION_TOOL_OUTCOME_INDETERMINATE',
        'Invocation has a durable start but no terminal receipt; automatic re-execution is unsafe',
        invocation.invocationId
      );
    }

    await this.services.journal.begin(intent);
    const descriptor = invocation.snapshot.toolRouter.resolveDescriptor(invocation.toolName);
    if (!descriptor || !isDirectCapability(invocation.snapshot, descriptor.name)) {
      return this.commitTerminal(invocation, intent, {
        terminal: 'failed',
        terminalPhase: 'capability',
        result: failure(`Tool is not direct in this StepSnapshot: ${invocation.toolName}`),
      });
    }

    let policy: ToolPolicyDecisionV1;
    try {
      policy = validatePolicyDecision(
        await this.services.policy.decide({
          snapshot: invocation.snapshot,
          descriptor,
          args: invocation.args,
        })
      );
    } catch (error) {
      return this.commitTerminal(invocation, intent, {
        terminal: 'failed',
        terminalPhase: 'policy',
        result: failure(`Policy failed closed: ${errorMessage(error)}`),
      });
    }
    if (policy.behavior === 'deny') {
      return this.commitTerminal(invocation, intent, {
        policy,
        terminal: 'failed',
        terminalPhase: 'policy',
        result: failure(policy.reason ?? 'Tool denied by policy'),
      });
    }

    let approval: ToolApprovalDecisionV1 | undefined;
    if (policy.behavior === 'ask') {
      try {
        approval = validateApprovalDecision(
          await this.services.approval.decide({
            snapshot: invocation.snapshot,
            descriptor,
            args: invocation.args,
            policy,
            abortSignal: invocation.abortSignal,
          })
        );
      } catch (error) {
        return this.commitTerminal(invocation, intent, {
          policy,
          terminal: 'failed',
          terminalPhase: 'approval',
          result: failure(`Approval failed closed: ${errorMessage(error)}`),
        });
      }
      if (!approval.approved) {
        return this.commitTerminal(invocation, intent, {
          policy,
          approval,
          terminal: invocation.abortSignal?.aborted ? 'interrupted' : 'failed',
          terminalPhase: 'approval',
          result: failure(approval.reason ?? 'Tool approval denied'),
        });
      }
    }

    let sandbox: SandboxPreparationV1;
    try {
      sandbox = validateSandboxPreparation(
        await this.services.sandbox.prepare({
          snapshot: invocation.snapshot,
          descriptor,
          args: invocation.args,
          abortSignal: invocation.abortSignal,
        })
      );
    } catch (error) {
      return this.commitTerminal(invocation, intent, {
        policy,
        approval,
        terminal: 'failed',
        terminalPhase: 'sandbox',
        result: failure(`Sandbox preparation failed closed: ${errorMessage(error)}`),
      });
    }

    let executed: BoundToolExecutionResultV1;
    try {
      const nested = this.services.nested;
      executed =
        nested?.handles(descriptor) === true
          ? await nested.run({
              invocation,
              descriptor,
              invokeChild: child =>
                this.invoke({
                  invocationId: child.invocationId,
                  parentInvocationId: invocation.invocationId,
                  snapshot: invocation.snapshot,
                  toolName: child.toolName,
                  args: structuredClone(child.args),
                  context: invocation.context,
                  abortSignal: invocation.abortSignal,
                }),
            })
          : await this.services.execution.run({
              invocationId: invocation.invocationId,
              snapshot: invocation.snapshot,
              toolName: invocation.toolName,
              args: structuredClone(invocation.args),
              context: invocation.context,
              enforcement: sandbox.enforcement,
              abortSignal: invocation.abortSignal,
            });
    } catch (error) {
      executed = {
        terminal: invocation.abortSignal?.aborted ? 'interrupted' : 'failed',
        result: failure(`Nested execution failed closed: ${errorMessage(error)}`),
        durationMs: Math.max(0, this.clock() - intent.startedAt),
      };
    }
    return this.commitTerminal(invocation, intent, {
      policy,
      approval,
      sandbox,
      terminal: executed.terminal,
      terminalPhase: 'execute',
      result: executed.result,
      durationMs: executed.durationMs,
    });
  }

  private async commitTerminal(
    invocation: ToolInvocationV1,
    intent: ToolInvocationIntentV1,
    outcome: {
      readonly policy?: ToolPolicyDecisionV1;
      readonly approval?: ToolApprovalDecisionV1;
      readonly sandbox?: SandboxPreparationV1;
      readonly terminal: ToolTerminalV1;
      readonly terminalPhase: ToolInvocationReceiptV1['terminalPhase'];
      readonly result: ToolResult;
      readonly durationMs?: number;
    }
  ): Promise<ToolInvocationResultV1> {
    const finishedAt = this.clock();
    const content = {
      version: 1 as const,
      invocationId: invocation.invocationId,
      parentInvocationId: invocation.parentInvocationId,
      threadId: invocation.snapshot.threadId,
      turnId: invocation.snapshot.turnId,
      stepId: invocation.snapshot.stepId,
      toolName: invocation.toolName,
      snapshotDigest: invocation.snapshot.digest,
      routerDigest: invocation.snapshot.toolRouter.digest,
      authorityDigest: invocation.snapshot.authority.digest,
      executionPolicyDigest: invocation.snapshot.executionPolicy.digest,
      intentDigest: intent.digest,
      policy: outcome.policy,
      approval: outcome.approval,
      sandbox: outcome.sandbox,
      terminal: outcome.terminal,
      terminalPhase: outcome.terminalPhase,
      success: outcome.terminal === 'completed' && outcome.result.success,
      result: structuredClone(outcome.result),
      outputDigest: digestRuntimeValue(outcome.result),
      startedAt: intent.startedAt,
      finishedAt,
      durationMs: outcome.durationMs ?? Math.max(0, finishedAt - intent.startedAt),
    };
    const receipt = deepFreeze({ ...content, digest: digestRuntimeValue(content) });
    try {
      await this.services.journal.complete(receipt);
    } catch (error) {
      throw new ToolGatewayError(
        'ORION_TOOL_RECEIPT_PERSISTENCE',
        `Tool terminal receipt was not committed: ${errorMessage(error)}`,
        invocation.invocationId
      );
    }
    return deepFreeze({ result: receipt.result, receipt });
  }
}

export class InMemoryToolInvocationJournalV1 implements ToolInvocationJournalV1 {
  private readonly entries = new Map<string, ToolInvocationJournalEntryV1>();

  async load(invocationId: string): Promise<ToolInvocationJournalEntryV1 | null> {
    return this.entries.get(invocationId) ?? null;
  }

  async begin(intent: ToolInvocationIntentV1): Promise<void> {
    if (this.entries.has(intent.invocationId)) {
      throw new ToolGatewayError(
        'ORION_TOOL_INVOCATION_CONFLICT',
        `Invocation ${intent.invocationId} already started`,
        intent.invocationId
      );
    }
    this.entries.set(intent.invocationId, deepFreeze({ intent }));
  }

  async complete(receipt: ToolInvocationReceiptV1): Promise<void> {
    const entry = this.entries.get(receipt.invocationId);
    if (!entry || entry.intent.digest !== receipt.intentDigest || entry.receipt) {
      throw new ToolGatewayError(
        'ORION_TOOL_INVOCATION_CONFLICT',
        `Invocation ${receipt.invocationId} cannot accept another terminal receipt`,
        receipt.invocationId
      );
    }
    this.entries.set(receipt.invocationId, deepFreeze({ ...entry, receipt }));
  }
}

export function createStaticPolicyDecisionV1(
  input: Omit<ToolPolicyDecisionV1, 'digest'>
): ToolPolicyDecisionV1 {
  return deepFreeze({ ...input, digest: digestRuntimeValue(input) });
}

export function createStaticApprovalDecisionV1(
  input: Omit<ToolApprovalDecisionV1, 'digest'>
): ToolApprovalDecisionV1 {
  return deepFreeze({ ...input, digest: digestRuntimeValue(input) });
}

export function createSandboxPreparationV1(
  input: Omit<SandboxPreparationV1, 'digest'>
): SandboxPreparationV1 {
  return deepFreeze({ ...input, digest: digestRuntimeValue(input) });
}

function createIntent(invocation: ToolInvocationV1, startedAt: number): ToolInvocationIntentV1 {
  const requestDigest = digestRuntimeValue({
    invocationId: invocation.invocationId,
    parentInvocationId: invocation.parentInvocationId,
    threadId: invocation.snapshot.threadId,
    turnId: invocation.snapshot.turnId,
    stepId: invocation.snapshot.stepId,
    toolName: invocation.toolName,
    snapshotDigest: invocation.snapshot.digest,
    argsDigest: digestRuntimeValue(invocation.args),
  });
  const content = {
    version: 1 as const,
    invocationId: invocation.invocationId,
    parentInvocationId: invocation.parentInvocationId,
    threadId: invocation.snapshot.threadId,
    turnId: invocation.snapshot.turnId,
    stepId: invocation.snapshot.stepId,
    toolName: invocation.toolName,
    snapshotDigest: invocation.snapshot.digest,
    argsDigest: digestRuntimeValue(invocation.args),
    requestDigest,
    startedAt,
  };
  return deepFreeze({ ...content, digest: digestRuntimeValue(content) });
}

function isDirectCapability(snapshot: StepSnapshotV1, toolName: string): boolean {
  return snapshot.capabilityPlan.direct.some(entry => entry.id === toolName);
}

function validateInvocation(invocation: ToolInvocationV1): void {
  if (!isRuntimeId(invocation.invocationId)) {
    throw new ToolGatewayError(
      'ORION_TOOL_INVOCATION_INVALID',
      'invocationId must be a UUID',
      invocation.invocationId
    );
  }
  if (invocation.parentInvocationId && !isRuntimeId(invocation.parentInvocationId)) {
    throw new ToolGatewayError(
      'ORION_TOOL_INVOCATION_INVALID',
      'parentInvocationId must be a UUID',
      invocation.invocationId
    );
  }
  if (!invocation.toolName.trim()) {
    throw new ToolGatewayError(
      'ORION_TOOL_INVOCATION_INVALID',
      'toolName must not be empty',
      invocation.invocationId
    );
  }
}

function validatePolicyDecision(value: ToolPolicyDecisionV1): ToolPolicyDecisionV1 {
  if (!['allow', 'ask', 'deny'].includes(value.behavior) || !value.source || !value.digest) {
    throw new Error('Malformed policy decision');
  }
  return value;
}

function validateApprovalDecision(value: ToolApprovalDecisionV1): ToolApprovalDecisionV1 {
  if (typeof value.approved !== 'boolean' || !value.source || !value.digest) {
    throw new Error('Malformed approval decision');
  }
  return value;
}

function validateSandboxPreparation(value: SandboxPreparationV1): SandboxPreparationV1 {
  if (!['full', 'partial', 'none'].includes(value.enforcement) || !value.backend || !value.digest) {
    throw new Error('Malformed sandbox preparation');
  }
  return value;
}

function failure(error: string): ToolResult {
  return { success: false, output: '', error };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return value;
}
