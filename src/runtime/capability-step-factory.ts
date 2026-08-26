import type { Message } from '../services/llm';
import { estimateMessagesTokens } from '../utils/token-estimate';
import type { AgentLoopPreparedStepV1, AgentLoopStepFactoryV1 } from './agent-loop';
import {
  compileCapabilityPlanV1,
  type CapabilityCompilationV1,
  type CapabilityCompilerInputV1,
  type CapabilityPromptSectionReceiptV1,
  type CapabilityReceiptV1,
} from './capabilities';
import { digestRuntimeValue } from './protocol/canonical';
import { createRuntimeId, isRuntimeId } from './protocol/runtime-protocol-v1';
import {
  ToolRouterSnapshotV1,
  captureStepSnapshotV1,
  type AgentBaseModeV1,
  type EnvironmentSnapshotV1,
  type ExecutionPolicySnapshotV1,
  type McpBindingSnapshotV1,
  type ModelSnapshotV1,
  type PromptSnapshotV1,
  type SkillSnapshotV1,
  type StepSnapshotV1,
  type ToolBindingDescriptorV1,
  type ToolBindingV1,
} from './step-snapshot';

export type CapabilityStepCompilerInputV1 = Omit<
  CapabilityCompilerInputV1,
  'baseMode' | 'taskContextRevision' | 'receipt'
>;

export type AgentLoopStepPrepareInputV1 = Parameters<AgentLoopStepFactoryV1['prepare']>[0];

export interface CapabilityStepConfigurationV1 {
  readonly taskEpoch: number;
  readonly compiler: CapabilityStepCompilerInputV1;
  readonly model: ModelSnapshotV1;
  readonly executionPolicy: ExecutionPolicySnapshotV1;
  readonly environment: EnvironmentSnapshotV1;
}

export interface CapabilityStepReceiptV1 {
  readonly version: 1;
  readonly threadId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly capabilityReceiptDigest: string;
  readonly promptDigest: string;
  readonly snapshotDigest: string;
  readonly digest: string;
}

export interface CapabilityStepPersistenceBundleV1 {
  readonly snapshot: StepSnapshotV1;
  readonly capabilityReceipt: CapabilityReceiptV1;
  readonly receipt: CapabilityStepReceiptV1;
}

export interface PreparedCapabilityStepV1 extends AgentLoopPreparedStepV1 {
  readonly capabilityPlanDigest: string;
  readonly persistenceBundle: CapabilityStepPersistenceBundleV1 | undefined;
}

export interface CapabilityStepIdentityFactoryInputV1 {
  readonly kind: 'step' | 'request' | 'commit';
  readonly threadId: string;
  readonly turnId: string;
  readonly requestIndex: number;
}

export interface CapabilityAgentLoopStepFactoryOptionsV1 {
  readonly resolveConfiguration: (
    input: AgentLoopStepPrepareInputV1
  ) => CapabilityStepConfigurationV1 | Promise<CapabilityStepConfigurationV1>;
  /** Registry is keyed by the compiler catalog's stable bindingId, not tool name. */
  readonly resolveToolRegistry: (
    input: AgentLoopStepPrepareInputV1
  ) => ReadonlyMap<string, ToolBindingV1> | Promise<ReadonlyMap<string, ToolBindingV1>>;
  readonly idFactory?: (input: CapabilityStepIdentityFactoryInputV1) => string;
  readonly clock?: () => number;
  /** Called before capture resolves so persistence failure blocks the model request. */
  readonly onCaptured?: (bundle: CapabilityStepPersistenceBundleV1) => void | Promise<void>;
}

type CapabilityStepFactoryErrorCode =
  | 'ORION_CAPABILITY_STEP_ABORTED'
  | 'ORION_CAPABILITY_STEP_CONFIG_INVALID'
  | 'ORION_CAPABILITY_STEP_ID_INVALID'
  | 'ORION_CAPABILITY_STEP_BINDING_MISSING'
  | 'ORION_CAPABILITY_STEP_EXECUTOR_MISSING'
  | 'ORION_CAPABILITY_STEP_BINDING_MISMATCH'
  | 'ORION_CAPABILITY_STEP_ROUTER_MISMATCH'
  | 'ORION_CAPABILITY_STEP_ALREADY_CAPTURED';

export class CapabilityStepFactoryError extends Error {
  constructor(
    public readonly code: CapabilityStepFactoryErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'CapabilityStepFactoryError';
  }
}

/**
 * Recompiles capabilities per provider request and binds selected descriptors
 * to exact executor references before AgentLoop can expose them to the model.
 */
export class CapabilityAgentLoopStepFactoryV1 implements AgentLoopStepFactoryV1 {
  private readonly idFactory: (input: CapabilityStepIdentityFactoryInputV1) => string;
  private readonly clock: () => number;

  constructor(private readonly options: CapabilityAgentLoopStepFactoryOptionsV1) {
    this.idFactory = options.idFactory ?? (() => createRuntimeId());
    this.clock = options.clock ?? Date.now;
  }

  async prepare(input: AgentLoopStepPrepareInputV1): Promise<PreparedCapabilityStepV1> {
    this.throwIfAborted(input.abortSignal);
    const configuration = cloneConfiguration(await this.options.resolveConfiguration(input));
    this.throwIfAborted(input.abortSignal);
    this.validateConfiguration(configuration);
    const identity = this.createIdentity(input);
    const baseMode = normalizeBaseMode(input.mode);
    const initialCompilation = compileCapabilityPlanV1({
      ...configuration.compiler,
      baseMode,
      taskContextRevision: input.taskContextRevision,
      receipt: identity,
    });
    const registry = await this.options.resolveToolRegistry(input);
    this.throwIfAborted(input.abortSignal);
    if (!registry || typeof registry.get !== 'function') {
      throw new CapabilityStepFactoryError(
        'ORION_CAPABILITY_STEP_CONFIG_INVALID',
        'Tool registry must implement ReadonlyMap.get().'
      );
    }
    const toolBindings = this.bindExactExecutors(initialCompilation, registry);
    const preparedRouter = this.createRouter(toolBindings, 'prepared');
    this.assertRouterMatchesCompilation(initialCompilation, preparedRouter, 'prepared');

    let persistenceBundle: CapabilityStepPersistenceBundleV1 | undefined;
    let captured = false;
    const prepared: PreparedCapabilityStepV1 = {
      stepId: identity.stepId,
      toolBindings,
      capabilityPlanDigest: initialCompilation.plan.digest,
      get persistenceBundle(): CapabilityStepPersistenceBundleV1 | undefined {
        return persistenceBundle;
      },
      capture: async captureInput => {
        if (captured) {
          throw new CapabilityStepFactoryError(
            'ORION_CAPABILITY_STEP_ALREADY_CAPTURED',
            `Step ${identity.stepId} has already crossed the model boundary.`
          );
        }
        captured = true;
        this.throwIfAborted(input.abortSignal);

        const prompt = createFinalPromptSnapshotV1(captureInput.messages);
        const finalPromptManifest = mergePromptManifest(
          configuration.compiler.promptManifest ?? [],
          prompt
        );
        const finalCompilation = compileCapabilityPlanV1({
          ...configuration.compiler,
          promptManifest: finalPromptManifest,
          baseMode,
          taskContextRevision: captureInput.taskContextRevision,
          receipt: identity,
        });
        if (finalCompilation.plan.digest !== initialCompilation.plan.digest) {
          throw new CapabilityStepFactoryError(
            'ORION_CAPABILITY_STEP_BINDING_MISMATCH',
            'Capability selection changed while binding the final prompt.'
          );
        }
        this.assertRouterMatchesCompilation(finalCompilation, preparedRouter, 'final');

        const snapshot = captureStepSnapshotV1({
          threadId: input.threadId,
          turnId: input.turnId,
          stepId: identity.stepId,
          taskEpoch: configuration.taskEpoch,
          baseMode,
          model: configuration.model,
          authority: configuration.compiler.authority,
          executionPolicy: configuration.executionPolicy,
          environment: configuration.environment,
          capabilityPlan: finalCompilation.plan,
          prompt,
          toolBindings,
          skills: createSkillSnapshot(finalCompilation, configuration.compiler.skillCatalogDigest),
          mcp: createMcpSnapshot(finalCompilation, configuration.compiler.mcpCatalogDigest),
          taskContextRevision: captureInput.taskContextRevision,
        });
        this.assertSnapshotMatchesCompilation(snapshot, finalCompilation);

        const receiptContent = {
          version: 1 as const,
          threadId: input.threadId,
          turnId: input.turnId,
          stepId: identity.stepId,
          capabilityReceiptDigest: finalCompilation.receipt.digest,
          promptDigest: prompt.digest,
          snapshotDigest: snapshot.digest,
        };
        const receipt: CapabilityStepReceiptV1 = freeze({
          ...receiptContent,
          digest: digestRuntimeValue(receiptContent),
        });
        const bundle: CapabilityStepPersistenceBundleV1 = freeze({
          snapshot,
          capabilityReceipt: finalCompilation.receipt,
          receipt,
        });
        persistenceBundle = bundle;
        await this.options.onCaptured?.(bundle);
        this.throwIfAborted(input.abortSignal);
        return snapshot;
      },
    };
    return Object.freeze(prepared);
  }

  private createIdentity(input: AgentLoopStepPrepareInputV1) {
    if (!isRuntimeId(input.threadId) || !isRuntimeId(input.turnId)) {
      throw new CapabilityStepFactoryError(
        'ORION_CAPABILITY_STEP_ID_INVALID',
        'Capability Step Factory requires UUID threadId and turnId values.'
      );
    }
    const create = (kind: CapabilityStepIdentityFactoryInputV1['kind']): string =>
      this.idFactory({
        kind,
        threadId: input.threadId,
        turnId: input.turnId,
        requestIndex: input.requestIndex,
      });
    const stepId = create('step');
    if (!isRuntimeId(stepId)) {
      throw new CapabilityStepFactoryError(
        'ORION_CAPABILITY_STEP_ID_INVALID',
        'Capability Step Factory must issue a UUID stepId.'
      );
    }
    return freeze({
      requestId: create('request'),
      threadId: input.threadId,
      turnId: input.turnId,
      stepId,
      durableCommitId: create('commit'),
      createdAt: this.clock(),
    });
  }

  private bindExactExecutors(
    compilation: CapabilityCompilationV1,
    registry: ReadonlyMap<string, ToolBindingV1>
  ): readonly ToolBindingV1[] {
    const bindings = compilation.directToolBindings.map(selection => {
      const binding = registry.get(selection.bindingId);
      if (!binding) {
        throw new CapabilityStepFactoryError(
          'ORION_CAPABILITY_STEP_BINDING_MISSING',
          `No executor binding is registered for ${selection.bindingId}.`
        );
      }
      if (typeof binding.execute !== 'function') {
        throw new CapabilityStepFactoryError(
          'ORION_CAPABILITY_STEP_EXECUTOR_MISSING',
          `Binding ${selection.bindingId} does not provide an executor.`
        );
      }
      const actualRouter = this.createRouter([binding], `binding:${selection.bindingId}`);
      const actualDescriptor = actualRouter.descriptors[0];
      if (!descriptorsEqual(actualDescriptor, selection.descriptor)) {
        throw new CapabilityStepFactoryError(
          'ORION_CAPABILITY_STEP_BINDING_MISMATCH',
          `Binding ${selection.bindingId} does not match the compiled descriptor.`
        );
      }
      return freeze({
        descriptor: structuredClone(actualDescriptor),
        execute: binding.execute,
      });
    });
    return Object.freeze(bindings);
  }

  private createRouter(bindings: readonly ToolBindingV1[], phase: string): ToolRouterSnapshotV1 {
    try {
      return new ToolRouterSnapshotV1(bindings);
    } catch (error) {
      throw new CapabilityStepFactoryError(
        'ORION_CAPABILITY_STEP_BINDING_MISMATCH',
        `Invalid ${phase} tool binding: ${errorMessage(error)}`
      );
    }
  }

  private assertRouterMatchesCompilation(
    compilation: CapabilityCompilationV1,
    router: ToolRouterSnapshotV1,
    phase: string
  ): void {
    const receipt = compilation.receipt;
    const names = router.descriptors.map(descriptor => descriptor.name);
    if (
      receipt.toolSchemaDigest !== router.visibleSchemaDigest ||
      receipt.toolBindingDigest !== router.bindingDigest ||
      receipt.toolRouterDigest !== router.digest ||
      digestRuntimeValue(receipt.directToolNames) !== digestRuntimeValue(names)
    ) {
      throw new CapabilityStepFactoryError(
        'ORION_CAPABILITY_STEP_ROUTER_MISMATCH',
        `Capability compiler and ${phase} ToolRouter digests differ.`
      );
    }
  }

  private assertSnapshotMatchesCompilation(
    snapshot: StepSnapshotV1,
    compilation: CapabilityCompilationV1
  ): void {
    this.assertRouterMatchesCompilation(compilation, snapshot.toolRouter, 'snapshot');
    if (
      snapshot.capabilityPlan.digest !== compilation.plan.digest ||
      snapshot.prompt.digest !==
        compilation.receipt.promptManifest.find(item => item.id === 'final-model-messages')?.digest
    ) {
      throw new CapabilityStepFactoryError(
        'ORION_CAPABILITY_STEP_ROUTER_MISMATCH',
        'Final StepSnapshot is not bound to its capability plan and prompt receipt.'
      );
    }
  }

  private validateConfiguration(configuration: CapabilityStepConfigurationV1): void {
    if (!Number.isSafeInteger(configuration.taskEpoch) || configuration.taskEpoch < 0) {
      throw new CapabilityStepFactoryError(
        'ORION_CAPABILITY_STEP_CONFIG_INVALID',
        'Capability step taskEpoch must be a non-negative safe integer.'
      );
    }
    if (configuration.compiler.executionPolicyDigest !== configuration.executionPolicy.digest) {
      throw new CapabilityStepFactoryError(
        'ORION_CAPABILITY_STEP_CONFIG_INVALID',
        'Compiler executionPolicyDigest does not match the StepSnapshot policy.'
      );
    }
    const { digest: policyDigest, ...policyContent } = configuration.executionPolicy;
    if (digestRuntimeValue(policyContent) !== policyDigest) {
      throw new CapabilityStepFactoryError(
        'ORION_CAPABILITY_STEP_CONFIG_INVALID',
        'ExecutionPolicy snapshot digest does not match its content.'
      );
    }
    if (
      !Number.isSafeInteger(configuration.model.contextWindow) ||
      configuration.model.contextWindow <= 0
    ) {
      throw new CapabilityStepFactoryError(
        'ORION_CAPABILITY_STEP_CONFIG_INVALID',
        'Model contextWindow must be a positive safe integer.'
      );
    }
    for (const [name, value] of [
      ['model providerId', configuration.model.providerId],
      ['model modelId', configuration.model.modelId],
      ['model protocol', configuration.model.protocol],
      ['environment cwd', configuration.environment.cwd],
      ['environment platform', configuration.environment.platform],
      ['environment arch', configuration.environment.arch],
      ['environment digest', configuration.environment.environmentDigest],
    ] as const) {
      if (!value.trim()) {
        throw new CapabilityStepFactoryError(
          'ORION_CAPABILITY_STEP_CONFIG_INVALID',
          `${name} must not be empty.`
        );
      }
    }
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) return;
    throw new CapabilityStepFactoryError(
      'ORION_CAPABILITY_STEP_ABORTED',
      'Capability step preparation was aborted.'
    );
  }
}

export function createFinalPromptSnapshotV1(messages: readonly Message[]): PromptSnapshotV1 {
  const cloned = structuredClone(messages) as Message[];
  const sections = cloned.map((message, index) => ({
    id: `message:${String(index).padStart(4, '0')}:${message.role}`,
    content: message.content,
    estimatedTokens: estimateMessagesTokens([message]),
    sourceDigest: digestRuntimeValue(message),
  }));
  return freeze({
    version: 1,
    sections,
    estimatedTokens: estimateMessagesTokens(cloned),
    digest: digestRuntimeValue(cloned),
  });
}

function mergePromptManifest(
  configured: readonly CapabilityPromptSectionReceiptV1[],
  prompt: PromptSnapshotV1
): readonly CapabilityPromptSectionReceiptV1[] {
  const reservedId = 'final-model-messages';
  if (configured.some(section => section.id === reservedId)) {
    throw new CapabilityStepFactoryError(
      'ORION_CAPABILITY_STEP_CONFIG_INVALID',
      `Prompt manifest id ${reservedId} is reserved by the Step Factory.`
    );
  }
  return freeze([
    ...structuredClone(configured),
    { id: reservedId, digest: prompt.digest, selected: true },
  ]);
}

function createSkillSnapshot(
  compilation: CapabilityCompilationV1,
  catalogDigest: string
): SkillSnapshotV1 {
  const content = {
    version: 1 as const,
    selected: compilation.selectedSkills.map(skill => ({
      id: skill.id,
      descriptorDigest: skill.digest,
      definitionDigest: skill.loaded ? skill.digest : undefined,
    })),
    catalogDigest,
  };
  return freeze({ ...content, digest: digestRuntimeValue(content) });
}

function createMcpSnapshot(
  compilation: CapabilityCompilationV1,
  catalogDigest: string
): McpBindingSnapshotV1 {
  const content = {
    version: 1 as const,
    selected: compilation.selectedMcpBindings
      .filter(binding => binding.direct)
      .map(binding => ({
        serverId: binding.serverId,
        toolName: binding.toolName,
        bindingDigest: binding.bindingDigest,
      })),
    catalogDigest,
  };
  return freeze({ ...content, digest: digestRuntimeValue(content) });
}

function cloneConfiguration(
  configuration: CapabilityStepConfigurationV1
): CapabilityStepConfigurationV1 {
  try {
    return freeze(structuredClone(configuration));
  } catch (error) {
    throw new CapabilityStepFactoryError(
      'ORION_CAPABILITY_STEP_CONFIG_INVALID',
      `Capability step configuration is not snapshot-safe: ${errorMessage(error)}`
    );
  }
}

function descriptorsEqual(
  actual: ToolBindingDescriptorV1,
  expected: ToolBindingDescriptorV1
): boolean {
  return digestRuntimeValue(actual) === digestRuntimeValue(expected);
}

function normalizeBaseMode(mode: AgentLoopStepPrepareInputV1['mode']): AgentBaseModeV1 {
  return mode === 'plan' || mode === 'auto' ? mode : 'build';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function freeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) freeze(nested);
  return Object.freeze(value);
}
