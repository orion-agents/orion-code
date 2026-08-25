/**
 * Modern production composition for isolated subagent Threads.
 *
 * This module deliberately does not import framework/query or the process-wide
 * tool catalog. Every child receives an explicit model factory and immutable
 * tool catalog, then runs through AgentLoopV1 -> ToolGateway -> ExecutionService.
 */

import { join, resolve } from 'path';

import type { ToolContext } from '../../framework/tool';
import { createStopDecision } from '../../framework/stop-decision';
import {
  LLMService,
  type LLMConfig,
  type LLMUsageEvent,
  type Message,
  type ProviderRequestPreflight,
} from '../../services/llm';
import { AgentLoopV1, type AgentLoopTurnCommitV1 } from '../agent-loop';
import type { BuiltinToolCatalogV1 } from '../builtin-tool-provider';
import { CapabilityReceiptJournalV1 } from '../capability-receipt-journal';
import {
  CapabilityAgentLoopStepFactoryV1,
  type AgentLoopStepPrepareInputV1,
  type CapabilityStepConfigurationV1,
} from '../capability-step-factory';
import {
  FirstPartySandboxServiceV1,
  FirstPartyToolApprovalServiceV1,
  FirstPartyToolPolicyServiceV1,
  type FirstPartyApprovalHandlerV1,
} from '../first-party-tool-services';
import { digestRuntimeValue } from '../protocol/canonical';
import { ExecutionService, type AuthoritySnapshotV1, type ToolBindingV1 } from '../step-snapshot';
import {
  SubagentThreadRuntimeV1,
  SubagentThreadTreeScopeV1,
  type SubagentAgentLoopFactoryInputV1,
  type SubagentThreadReceiptV1,
  type SubagentThreadTreeLimitsV1,
} from '../subagent-thread-runtime';
import { createTaskContextService, type TaskContextService } from '../task-context-service';
import type { ThreadTurnOutcomeV1, ThreadTurnRunnerV1 } from '../thread-runtime';
import { ThreadToolInvocationJournalV1 } from '../thread-tool-journal';
import { ToolGateway } from '../tool-gateway';
import { ThreadTurnCommitJournalV1, type TurnCommitTerminalV1 } from '../turn-commit';
import { buildChildMessages } from './context-builder';
import { evaluateToolCall } from './child-executor-guard';
import { parseSubtaskResult } from './result-parser';
import { SubagentReceiptJournalV1 } from './receipt-journal';
import type {
  ProductionSubagentExecutionOutcomeV1,
  ProductionSubagentExecutionPortV1,
  ProductionSubagentExecutionRequestV1,
} from './runtime-contract';
import { EMPTY_SUBTASK_USAGE, type SubagentRole, type SubtaskUsage } from './types';

export interface ProductionSubagentCapabilityContextV1 {
  readonly role: SubagentRole;
  readonly objective: string;
  readonly modelId: string;
  readonly authority: AuthoritySnapshotV1;
  readonly taskContext: TaskContextService;
  readonly toolCatalog: BuiltinToolCatalogV1;
}

export type ProductionSubagentCapabilityResolverV1 = (
  input: AgentLoopStepPrepareInputV1,
  context: ProductionSubagentCapabilityContextV1
) => CapabilityStepConfigurationV1 | Promise<CapabilityStepConfigurationV1>;

export interface ProductionSubagentRuntimeOptionsV1 {
  readonly childStoreRootDir: string;
  readonly toolCatalog: BuiltinToolCatalogV1;
  readonly treeLimits: SubagentThreadTreeLimitsV1;
  readonly rolePolicies: Readonly<Partial<Record<SubagentRole, AuthoritySnapshotV1>>>;
  /** A new mutable provider client must be returned for every child. */
  readonly createModelExecutor: (input: {
    readonly role: SubagentRole;
    readonly objective: string;
    readonly abortSignal: AbortSignal;
  }) => LLMService;
  readonly resolveCapabilityConfiguration: ProductionSubagentCapabilityResolverV1;
  readonly toolContext: (
    input: ProductionSubagentExecutionRequestV1,
    authority: AuthoritySnapshotV1
  ) => ToolContext;
  readonly beforeProviderRequest?: ProviderRequestPreflight;
  readonly approvalHandler?: FirstPartyApprovalHandlerV1;
  readonly runtimeServicesDigest?: string;
  readonly maxSummaryBytes?: number;
  readonly receiptRootDir?: string;
  readonly onReceipt?: (receipt: SubagentThreadReceiptV1) => void | Promise<void>;
  readonly parentAbortSignal?: AbortSignal;
}

export class ProductionSubagentRuntimeError extends Error {
  constructor(
    readonly code:
      | 'ORION_SUBAGENT_PRODUCTION_INVALID'
      | 'ORION_SUBAGENT_PRODUCTION_CLOSED'
      | 'ORION_SUBAGENT_PRODUCTION_MODEL_PORT',
    message: string
  ) {
    super(message);
    this.name = 'ProductionSubagentRuntimeError';
  }
}

/** One root-turn-owned production service; child runtime instances are request scoped. */
export class ProductionSubagentRuntimeV1 implements ProductionSubagentExecutionPortV1 {
  readonly serviceId = 'production-subagent-runtime-v1';
  readonly tree: SubagentThreadTreeScopeV1;
  readonly receipts: SubagentReceiptJournalV1;

  private readonly options: ProductionSubagentRuntimeOptionsV1;
  private readonly runtimeServicesDigest: string;
  private readonly issuedModelExecutors = new WeakSet<LLMService>();
  private parentTurnKey: string | undefined;
  private closed = false;

  constructor(options: ProductionSubagentRuntimeOptionsV1) {
    validateOptions(options);
    this.options = Object.freeze({ ...options });
    this.tree = new SubagentThreadTreeScopeV1(options.treeLimits, options.parentAbortSignal);
    this.receipts = new SubagentReceiptJournalV1(
      options.receiptRootDir ?? join(options.childStoreRootDir, 'receipts')
    );
    this.runtimeServicesDigest =
      options.runtimeServicesDigest ??
      digestRuntimeValue({
        version: 1,
        owner: this.serviceId,
        loop: 'agent-loop-v1',
        gateway: 'tool-gateway-v1',
        taskContext: 'task-context-v1',
        toolCatalog: options.toolCatalog.digest,
      });
  }

  async execute(
    request: ProductionSubagentExecutionRequestV1
  ): Promise<ProductionSubagentExecutionOutcomeV1> {
    if (this.closed) {
      throw new ProductionSubagentRuntimeError(
        'ORION_SUBAGENT_PRODUCTION_CLOSED',
        'Production subagent runtime is closed.'
      );
    }
    validateRequest(request);
    this.bindParentTurn(request);

    const deadline = createDeadline(request.abortSignal, request.timeoutMs);
    const startedAt = Date.now();
    const usage = createUsageAccumulator();
    let persistedReceipt: SubagentThreadReceiptV1 | undefined;
    try {
      const runtime = new SubagentThreadRuntimeV1({
        childStoreRootDir: this.options.childStoreRootDir,
        tree: this.tree,
        rolePolicies: this.options.rolePolicies,
        defaultBudget: request.budget,
        maxSummaryBytes: this.options.maxSummaryBytes ?? 64 * 1024,
        createAgentLoop: input => this.createChildLoop(input, request, usage),
        onReceipt: async receipt => {
          persistedReceipt = this.receipts.commit(receipt);
          await this.options.onReceipt?.(persistedReceipt);
        },
      });
      const child = await runtime.run({
        parent: request.parent,
        parentAuthority: request.parentAuthority,
        role: request.packet.role,
        objective: request.packet.objective,
        budget: request.budget,
        abortSignal: deadline.signal,
      });
      if (!persistedReceipt || persistedReceipt.digest !== child.receipt.digest) {
        throw new ProductionSubagentRuntimeError(
          'ORION_SUBAGENT_PRODUCTION_INVALID',
          'Child completed without a matching durable parent-facing receipt.'
        );
      }
      const status = deadline.timedOut
        ? 'timed_out'
        : child.turnTerminal === 'interrupted' || child.status === 'cancelled'
          ? 'cancelled'
          : child.turnTerminal === 'failed' || child.status !== 'completed'
            ? 'failed'
            : 'completed';
      const subtaskUsage = finalizeUsage(usage, child.usage, startedAt, true);
      const result = parseSubtaskResult({
        id: request.taskId,
        role: request.packet.role,
        content: child.summary,
        status,
        usage: subtaskUsage,
      });
      result.stopDecision = child.stopDecision;
      return Object.freeze({
        result,
        parentCancelled: status === 'cancelled' && Boolean(request.abortSignal?.aborted),
        receipt: child.receipt,
      });
    } catch (error) {
      const status = deadline.timedOut
        ? 'timed_out'
        : request.abortSignal?.aborted || this.tree.signal.aborted
          ? 'cancelled'
          : 'failed';
      const result = parseSubtaskResult({
        id: request.taskId,
        role: request.packet.role,
        content: errorMessage(error),
        status,
        usage: finalizeUsage(usage, undefined, startedAt, false),
      });
      result.stopDecision = createStopDecision({
        scope: 'subagent',
        status:
          status === 'cancelled' ? 'cancelled' : status === 'timed_out' ? 'stopped' : 'failed',
        disposition: 'resume_allowed',
        reason: { code: `subagent_${status}`, message: result.summary },
        evidence: [],
        nextActions: [
          { kind: 'retry', label: 'Inspect the child receipt boundary before retrying.' },
        ],
        resources: {
          llmRequests: {
            used: usage.providerAttempts,
            limit: request.budget.maxModelRequests,
          },
          toolCalls: { used: usage.toolCalls, limit: request.budget.maxToolCalls },
          elapsedMs: { used: Math.max(0, Date.now() - startedAt), limit: request.timeoutMs },
        },
      });
      return Object.freeze({
        result,
        parentCancelled: status === 'cancelled' && Boolean(request.abortSignal?.aborted),
        ...(persistedReceipt ? { receipt: persistedReceipt } : {}),
      });
    } finally {
      deadline.dispose();
      usage.unsubscribe?.();
    }
  }

  close(reason = 'production_subagent_runtime_closed'): void {
    if (this.closed) return;
    this.closed = true;
    this.tree.close(reason);
  }

  private bindParentTurn(request: ProductionSubagentExecutionRequestV1): void {
    const key = `${request.parent.threadId}:${request.parent.turnId}`;
    if (!this.parentTurnKey) {
      this.parentTurnKey = key;
      return;
    }
    if (this.parentTurnKey !== key) {
      throw new ProductionSubagentRuntimeError(
        'ORION_SUBAGENT_PRODUCTION_INVALID',
        'A production subagent runtime and its tree limits belong to exactly one parent turn.'
      );
    }
  }

  private createChildLoop(
    input: SubagentAgentLoopFactoryInputV1,
    request: ProductionSubagentExecutionRequestV1,
    usage: UsageAccumulatorV1
  ): ThreadTurnRunnerV1 {
    const llm = this.options.createModelExecutor({
      role: input.role,
      objective: input.objective,
      abortSignal: input.abortSignal,
    });
    if (
      !llm ||
      typeof llm.chatStream !== 'function' ||
      typeof llm.setProviderRequestPreflight !== 'function'
    ) {
      throw new ProductionSubagentRuntimeError(
        'ORION_SUBAGENT_PRODUCTION_MODEL_PORT',
        'Child model factory must return an isolated LLMService with provider preflight support.'
      );
    }
    if (this.issuedModelExecutors.has(llm)) {
      throw new ProductionSubagentRuntimeError(
        'ORION_SUBAGENT_PRODUCTION_MODEL_PORT',
        'Child model factory reused mutable LLM state across child requests.'
      );
    }
    this.issuedModelExecutors.add(llm);
    const sharedPreflight = this.options.beforeProviderRequest;
    llm.setProviderRequestPreflight(async context => {
      const shared = sharedPreflight ? await sharedPreflight(context) : { available: true };
      if (!shared.available) return shared;
      try {
        input.budget.consumeModelRequests();
        usage.providerAttempts += 1;
        return shared;
      } catch (error) {
        return { available: false, reason: errorMessage(error) };
      }
    });
    if (typeof llm.subscribeUsage === 'function') {
      usage.hasUsageObserver = true;
      usage.unsubscribe = llm.subscribeUsage(event => observeUsage(usage, event));
    }

    const taskContext = createTaskContextService({
      cwd: input.authority.projectRoot,
      modelId: llm.getModel(),
      config: { completionGate: 'off' },
    });
    const context = this.options.toolContext(request, input.authority);
    if (resolve(context.cwd) !== resolve(input.authority.projectRoot)) {
      throw new ProductionSubagentRuntimeError(
        'ORION_SUBAGENT_PRODUCTION_INVALID',
        'Child ToolContext cwd must match the narrowed authority root.'
      );
    }
    const firstPartyPolicy = new FirstPartyToolPolicyServiceV1(this.options.toolCatalog, context);
    const policy = {
      decide: (policyInput: Parameters<typeof firstPartyPolicy.decide>[0]) => {
        input.budget.consumeToolCalls();
        usage.toolCalls += 1;
        return firstPartyPolicy.decide(policyInput);
      },
    };
    const gateway = new ToolGateway({
      policy,
      approval: new FirstPartyToolApprovalServiceV1(this.options.approvalHandler),
      sandbox: new FirstPartySandboxServiceV1(),
      execution: new ExecutionService(),
      journal: new ThreadToolInvocationJournalV1(input.childStore),
    });
    const capabilityJournal = new CapabilityReceiptJournalV1(input.childStore);
    const registries = new Map<string, ReadonlyMap<string, ToolBindingV1>>();
    const preparationKey = (step: AgentLoopStepPrepareInputV1): string =>
      `${step.turnId}:${step.requestIndex}`;
    const stepFactory = new CapabilityAgentLoopStepFactoryV1({
      resolveConfiguration: async step => {
        const configured = await this.options.resolveCapabilityConfiguration(step, {
          role: input.role,
          objective: input.objective,
          modelId: llm.getModel(),
          authority: input.authority,
          taskContext,
          toolCatalog: this.options.toolCatalog,
        });
        assertCapabilityConfiguration(configured, llm, input.authority);
        const bindings = budgetedBindings(this.options.toolCatalog, input, request);
        registries.set(preparationKey(step), bindings);
        return {
          ...configured,
          compiler: {
            ...configured.compiler,
            task: {
              ...configured.compiler.task,
              objective: input.objective,
              activeInstruction: request.packet.expectedOutput,
            },
            authority: input.authority,
            tools: this.options.toolCatalog.candidates,
            runtimeServicesDigest: this.runtimeServicesDigest,
            executionPolicyDigest: configured.executionPolicy.digest,
          },
        };
      },
      resolveToolRegistry: step => {
        const key = preparationKey(step);
        const registry = registries.get(key);
        registries.delete(key);
        if (!registry) throw new Error(`No frozen child tool registry exists for ${key}.`);
        return registry;
      },
      onCaptured: bundle => {
        capabilityJournal.commit(bundle);
      },
    });
    const baseMessages = childBaseMessages(request, input.authority.projectRoot);
    const turnCommits = new ThreadTurnCommitJournalV1(input.childStore);
    const agentLoop = new AgentLoopV1({
      llm,
      taskContext,
      steps: stepFactory,
      gateway,
      loadBaseMessages: () => baseMessages.map(message => ({ ...message })),
      toolContext: () => context,
      loopBudget: {
        maxLlmRequestsPerUserTurn: input.budget.limits.maxModelRequests,
        maxToolCallsPerUserTurn: input.budget.limits.maxToolCalls,
      },
      commitTurn: commit => commitAgentLoopTurn(turnCommits, commit),
    });
    return new CommitCompletingChildRunnerV1(
      agentLoop,
      input,
      taskContext,
      turnCommits,
      baseMessages
    );
  }
}

/** Backward-compatible config derivation only; it does not construct a child loop. */
export function createChildLlmConfig(
  rootConfig: Pick<LLMConfig, 'apiKey' | 'baseUrl' | 'model' | 'fallbackModel'>
): LLMConfig {
  return {
    apiKey: rootConfig.apiKey,
    baseUrl: rootConfig.baseUrl,
    model: rootConfig.model,
    fallbackModel: rootConfig.fallbackModel,
    timeout: 60_000,
  };
}

export function createProductionSubagentRuntimeV1(
  options: ProductionSubagentRuntimeOptionsV1
): ProductionSubagentRuntimeV1 {
  return new ProductionSubagentRuntimeV1(options);
}

class CommitCompletingChildRunnerV1 implements ThreadTurnRunnerV1 {
  constructor(
    private readonly agentLoop: AgentLoopV1,
    private readonly input: SubagentAgentLoopFactoryInputV1,
    private readonly taskContext: TaskContextService,
    private readonly commits: ThreadTurnCommitJournalV1,
    private readonly baseMessages: readonly Message[]
  ) {}

  async run(context: Parameters<ThreadTurnRunnerV1['run']>[0]): Promise<ThreadTurnOutcomeV1> {
    let outcome: ThreadTurnOutcomeV1;
    try {
      outcome = await this.agentLoop.run(context);
    } catch (error) {
      outcome = context.abortSignal.aborted
        ? { status: 'interrupted', reason: errorMessage(error) }
        : { status: 'failed', error: errorMessage(error) };
    }
    if (!this.input.childStore.loadProjection().turns[context.turnId]?.commit) {
      const terminal: TurnCommitTerminalV1 =
        outcome.status === 'completed'
          ? { status: 'completed', outcome: outcome.outcome }
          : outcome.status === 'interrupted'
            ? { status: 'interrupted', reason: outcome.reason }
            : { status: 'failed', error: outcome.error };
      const stopDecision = createStopDecision({
        scope: 'subagent',
        status:
          outcome.status === 'completed'
            ? 'completed'
            : outcome.status === 'interrupted'
              ? 'cancelled'
              : 'failed',
        disposition: outcome.status === 'completed' ? 'finish_scope' : 'resume_allowed',
        reason: {
          code: `child_${outcome.status}`,
          message:
            outcome.status === 'failed'
              ? outcome.error
              : outcome.status === 'interrupted'
                ? (outcome.reason ?? 'Child interrupted.')
                : (outcome.outcome ?? 'Child completed.'),
        },
        evidence: [],
        nextActions:
          outcome.status === 'completed'
            ? [{ kind: 'inspect', label: 'Inspect child evidence.' }]
            : [{ kind: 'retry', label: 'Retry from the durable child boundary.' }],
        resources: {},
      });
      this.commits.commit({
        turnId: context.turnId,
        history: [...this.baseMessages, { role: 'user', content: context.input }],
        taskContextState: this.taskContext.exportState(),
        taskContextRevision: this.taskContext.revision,
        terminal,
        stopDecision,
      });
    }
    return outcome;
  }
}

function commitAgentLoopTurn(
  commits: ThreadTurnCommitJournalV1,
  commit: AgentLoopTurnCommitV1
): void {
  commits.commit({
    turnId: commit.turnId,
    history: commit.history,
    taskContextState: commit.taskContextState,
    taskContextRevision: commit.taskContextRevision,
    terminal: terminalFromAgentCommit(commit),
    stopDecision: commit.queryComplete.stats?.stopDecision,
  });
}

function terminalFromAgentCommit(commit: AgentLoopTurnCommitV1): TurnCommitTerminalV1 {
  const finishReason = commit.queryComplete.stats?.finishReason;
  if (finishReason === 'failed') {
    return { status: 'failed', error: commit.queryComplete.content || 'Child AgentLoop failed.' };
  }
  if (finishReason === 'cancelled') {
    return { status: 'interrupted', reason: 'Child AgentLoop cancelled.' };
  }
  return { status: 'completed', outcome: finishReason ?? 'completed' };
}

function budgetedBindings(
  catalog: BuiltinToolCatalogV1,
  input: SubagentAgentLoopFactoryInputV1,
  request: ProductionSubagentExecutionRequestV1
): ReadonlyMap<string, ToolBindingV1> {
  return new Map(
    [...catalog.bindings].map(([bindingId, binding]) => [
      bindingId,
      Object.freeze({
        descriptor: binding.descriptor,
        execute: async (args: Record<string, unknown>, context: ToolContext) => {
          const containment = evaluateToolCall(binding.descriptor.name, args, {
            rootCwd: input.authority.projectRoot,
            scopePaths: request.canonicalScopePaths,
          });
          if (!containment.ok) {
            return {
              success: false,
              output: '',
              error: `Subagent scope denied ${binding.descriptor.name}: ${containment.reason}`,
            };
          }
          return binding.execute(args, context);
        },
      }),
    ])
  );
}

function childBaseMessages(
  request: ProductionSubagentExecutionRequestV1,
  cwd: string
): readonly Message[] {
  const framed = buildChildMessages({
    cwd,
    packet: request.packet,
    canonicalScopePaths: request.canonicalScopePaths ? [...request.canonicalScopePaths] : undefined,
    rootObjectiveSummary: request.rootObjectiveSummary,
    modelLabel: request.modelLabel,
  });
  return Object.freeze([
    {
      role: 'system' as const,
      content: `${framed[0].content}\n\n# Delegation packet\n${framed[1].content}`,
    },
  ]);
}

interface UsageAccumulatorV1 {
  providerAttempts: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  costComplete: boolean;
  hasUsageObserver: boolean;
  successfulUsageEvents: number;
  unsubscribe?: () => void;
}

function createUsageAccumulator(): UsageAccumulatorV1 {
  return {
    providerAttempts: 0,
    toolCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    costComplete: true,
    hasUsageObserver: false,
    successfulUsageEvents: 0,
  };
}

function observeUsage(usage: UsageAccumulatorV1, event: LLMUsageEvent): void {
  usage.successfulUsageEvents += 1;
  usage.promptTokens += event.usage.promptTokens;
  usage.completionTokens += event.usage.completionTokens;
  if (event.usage.costUsd === undefined) usage.costComplete = false;
  else usage.costUsd += event.usage.costUsd;
}

function finalizeUsage(
  observed: UsageAccumulatorV1,
  charged: { readonly modelRequests: number; readonly toolCalls: number } | undefined,
  startedAt: number,
  completed: boolean
): SubtaskUsage {
  const usage: SubtaskUsage = {
    ...EMPTY_SUBTASK_USAGE,
    modelRequests: Math.max(observed.providerAttempts, charged?.modelRequests ?? 0),
    toolCalls: Math.max(observed.toolCalls, charged?.toolCalls ?? 0),
    promptTokens: observed.promptTokens,
    completionTokens: observed.completionTokens,
    durationMs: Math.max(0, Date.now() - startedAt),
    usageComplete:
      completed &&
      observed.hasUsageObserver &&
      observed.successfulUsageEvents >= observed.providerAttempts,
  };
  if (observed.hasUsageObserver && observed.costComplete) usage.costUsd = observed.costUsd;
  return usage;
}

function assertCapabilityConfiguration(
  configured: CapabilityStepConfigurationV1,
  llm: LLMService,
  authority: AuthoritySnapshotV1
): void {
  if (!configured || configured.model.modelId !== llm.getModel()) {
    throw new ProductionSubagentRuntimeError(
      'ORION_SUBAGENT_PRODUCTION_INVALID',
      'Capability model snapshot must match the isolated child model.'
    );
  }
  if (configured.environment.cwd !== authority.projectRoot) {
    throw new ProductionSubagentRuntimeError(
      'ORION_SUBAGENT_PRODUCTION_INVALID',
      'Child capability environment must use the narrowed authority root.'
    );
  }
}

function validateOptions(options: ProductionSubagentRuntimeOptionsV1): void {
  if (!options.childStoreRootDir?.trim()) invalid('childStoreRootDir is required.');
  if (!options.toolCatalog) invalid('An explicit child tool catalog is required.');
  if (options.toolCatalog.candidates.some(candidate => !candidate.descriptor.risk.readOnly)) {
    invalid('Production investigation subagents accept only read-only tool bindings.');
  }
  if (typeof options.createModelExecutor !== 'function')
    invalid('createModelExecutor is required.');
  if (typeof options.resolveCapabilityConfiguration !== 'function') {
    invalid('resolveCapabilityConfiguration is required.');
  }
  if (typeof options.toolContext !== 'function') invalid('toolContext is required.');
}

function validateRequest(request: ProductionSubagentExecutionRequestV1): void {
  if (!request.taskId.trim() || !request.packet.objective.trim()) {
    invalid('Subagent taskId and objective are required.');
  }
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
    invalid('Subagent timeoutMs must be a positive safe integer.');
  }
}

function invalid(message: string): never {
  throw new ProductionSubagentRuntimeError('ORION_SUBAGENT_PRODUCTION_INVALID', message);
}

function createDeadline(
  parent: AbortSignal | undefined,
  timeoutMs: number
): {
  readonly signal: AbortSignal;
  readonly timedOut: boolean;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = (): void => controller.abort(parent?.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Subagent timed out after ${timeoutMs}ms.`));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
