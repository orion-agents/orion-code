import type { ToolContext, ToolInputJSONSchema, ToolResult } from '../framework/tool';
import { digestRuntimeValue } from './protocol/canonical';
import { isRuntimeId } from './protocol/runtime-protocol-v1';

export type AgentBaseModeV1 = 'build' | 'plan' | 'auto';
export type ToolEffectV1 = 'none' | 'workspace_read' | 'workspace_write' | 'external_write';
export type ToolNetworkV1 = 'none' | 'read' | 'write';

export interface ModelSnapshotV1 {
  readonly providerId: string;
  readonly modelId: string;
  readonly protocol: string;
  readonly contextWindow: number;
}

export interface AuthoritySnapshotV1 {
  readonly authorityId: string;
  readonly projectRoot: string;
  readonly confirmation: 'ask' | 'allow' | 'deny';
  readonly filesystem: 'workspace' | 'full';
  readonly network: 'deny' | 'read' | 'write';
  readonly digest: string;
}

export interface ExecutionPolicySnapshotV1 {
  readonly policyId: string;
  readonly approvalMode: 'interactive' | 'never';
  readonly sandboxRequired: boolean;
  readonly sandboxBackend: string;
  readonly timeoutMs: number;
  readonly digest: string;
}

export interface EnvironmentSnapshotV1 {
  readonly cwd: string;
  readonly platform: string;
  readonly arch: string;
  readonly environmentDigest: string;
}

export interface CapabilitySelectionV1 {
  readonly id: string;
  readonly reason: string;
}

export interface CapabilityPlanV1 {
  readonly version: 1;
  readonly direct: readonly CapabilitySelectionV1[];
  readonly deferred: readonly CapabilitySelectionV1[];
  readonly hidden: readonly CapabilitySelectionV1[];
  readonly expansionAllowed: boolean;
  readonly digest: string;
}

export interface PromptSectionSnapshotV1 {
  readonly id: string;
  readonly content: string;
  readonly estimatedTokens: number;
  readonly sourceDigest: string;
}

export interface PromptSnapshotV1 {
  readonly version: 1;
  readonly sections: readonly PromptSectionSnapshotV1[];
  readonly estimatedTokens: number;
  readonly digest: string;
}

export interface SkillSnapshotEntryV1 {
  readonly id: string;
  readonly descriptorDigest: string;
  readonly definitionDigest?: string;
}

export interface SkillSnapshotV1 {
  readonly version: 1;
  readonly selected: readonly SkillSnapshotEntryV1[];
  readonly catalogDigest: string;
  readonly digest: string;
}

export interface McpBindingEntryV1 {
  readonly serverId: string;
  readonly toolName: string;
  readonly bindingDigest: string;
}

export interface McpBindingSnapshotV1 {
  readonly version: 1;
  readonly selected: readonly McpBindingEntryV1[];
  readonly catalogDigest: string;
  readonly digest: string;
}

export interface ToolRiskMetadataV1 {
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly fileEdit: boolean;
  readonly effect: ToolEffectV1;
  readonly network: ToolNetworkV1;
}

export interface ToolBindingDescriptorV1 {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly inputSchema: ToolInputJSONSchema;
  readonly schemaDigest: string;
  readonly executorId: string;
  readonly risk: ToolRiskMetadataV1;
}

export interface ToolBindingV1 {
  readonly descriptor: Omit<ToolBindingDescriptorV1, 'schemaDigest'> & {
    readonly schemaDigest?: string;
  };
  readonly execute: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}

export interface ModelVisibleToolV1 {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: ToolInputJSONSchema;
  };
}

export interface ToolRouterReceiptV1 {
  readonly version: 1;
  readonly toolNames: readonly string[];
  readonly visibleSchemaDigest: string;
  readonly bindingDigest: string;
  readonly digest: string;
}

interface FrozenToolBindingV1 {
  readonly descriptor: ToolBindingDescriptorV1;
  readonly execute: ToolBindingV1['execute'];
}

const EXECUTION_SERVICE_TOKEN = Symbol('orion.execution-service');

export class StepSnapshotValidationError extends Error {
  readonly code = 'ORION_STEP_SNAPSHOT_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'StepSnapshotValidationError';
  }
}

/** Exact, immutable schema/executor binding captured at a model boundary. */
export class ToolRouterSnapshotV1 {
  readonly version = 1 as const;
  readonly descriptors: readonly ToolBindingDescriptorV1[];
  readonly visibleSchemas: readonly ModelVisibleToolV1[];
  readonly visibleSchemaDigest: string;
  readonly bindingDigest: string;
  readonly digest: string;
  private readonly bindings: ReadonlyMap<string, FrozenToolBindingV1>;

  constructor(bindings: readonly ToolBindingV1[]) {
    const byName = new Map<string, FrozenToolBindingV1>();
    const descriptors: ToolBindingDescriptorV1[] = [];
    for (const binding of bindings) {
      const descriptor = normalizeToolDescriptor(binding.descriptor);
      for (const name of [descriptor.name, ...descriptor.aliases]) {
        if (byName.has(name)) {
          throw new StepSnapshotValidationError(`Duplicate tool binding or alias: ${name}`);
        }
      }
      const frozen: FrozenToolBindingV1 = Object.freeze({
        descriptor,
        execute: binding.execute,
      });
      byName.set(descriptor.name, frozen);
      for (const alias of descriptor.aliases) byName.set(alias, frozen);
      descriptors.push(descriptor);
    }

    this.descriptors = deepFreeze(descriptors);
    this.visibleSchemas = deepFreeze(
      descriptors.map(descriptor => ({
        type: 'function' as const,
        function: {
          name: descriptor.name,
          description: descriptor.description,
          parameters: descriptor.inputSchema,
        },
      }))
    );
    this.visibleSchemaDigest = digestRuntimeValue(this.visibleSchemas);
    this.bindingDigest = digestRuntimeValue(
      descriptors.map(descriptor => ({
        name: descriptor.name,
        aliases: descriptor.aliases,
        schemaDigest: descriptor.schemaDigest,
        executorId: descriptor.executorId,
        risk: descriptor.risk,
      }))
    );
    this.digest = digestRuntimeValue({
      version: this.version,
      visibleSchemaDigest: this.visibleSchemaDigest,
      bindingDigest: this.bindingDigest,
    });
    this.bindings = byName;
    Object.freeze(this);
  }

  resolveDescriptor(name: string): ToolBindingDescriptorV1 | undefined {
    return this.bindings.get(name)?.descriptor;
  }

  executeBound(
    token: symbol,
    name: string,
    args: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    if (token !== EXECUTION_SERVICE_TOKEN) {
      throw new StepSnapshotValidationError('Bound tool executors are private to ExecutionService');
    }
    const binding = this.bindings.get(name);
    if (!binding) {
      throw new StepSnapshotValidationError(`Tool is not bound in this StepSnapshot: ${name}`);
    }
    return binding.execute(args, context);
  }

  toReceipt(): ToolRouterReceiptV1 {
    return deepFreeze({
      version: 1,
      toolNames: this.descriptors.map(descriptor => descriptor.name),
      visibleSchemaDigest: this.visibleSchemaDigest,
      bindingDigest: this.bindingDigest,
      digest: this.digest,
    });
  }

  assertIntegrity(): void {
    const visibleSchemaDigest = digestRuntimeValue(this.visibleSchemas);
    if (visibleSchemaDigest !== this.visibleSchemaDigest) {
      throw new StepSnapshotValidationError('Model-visible tool schema changed after capture');
    }
    for (const descriptor of this.descriptors) {
      if (digestRuntimeValue(descriptor.inputSchema) !== descriptor.schemaDigest) {
        throw new StepSnapshotValidationError(`Tool schema digest drifted: ${descriptor.name}`);
      }
      const binding = this.bindings.get(descriptor.name);
      if (!binding || binding.descriptor.executorId !== descriptor.executorId) {
        throw new StepSnapshotValidationError(`Tool executor binding drifted: ${descriptor.name}`);
      }
    }
  }
}

export interface BoundToolExecutionRequestV1 {
  readonly snapshot: StepSnapshotV1;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly context: ToolContext;
  readonly enforcement: 'full' | 'partial' | 'none';
  readonly abortSignal?: AbortSignal;
}

export interface BoundToolExecutionResultV1 {
  readonly terminal: 'completed' | 'failed' | 'interrupted' | 'indeterminate';
  readonly result: ToolResult;
  readonly durationMs: number;
}

/** The only runtime primitive allowed to call a frozen concrete tool executor. */
export class ExecutionService {
  async run(request: BoundToolExecutionRequestV1): Promise<BoundToolExecutionResultV1> {
    const startedAt = Date.now();
    request.snapshot.toolRouter.assertIntegrity();
    if (request.snapshot.executionPolicy.sandboxRequired && request.enforcement !== 'full') {
      return {
        terminal: 'failed',
        result: {
          success: false,
          output: '',
          error: 'Required sandbox enforcement is unavailable',
        },
        durationMs: Date.now() - startedAt,
      };
    }
    if (request.abortSignal?.aborted) {
      return {
        terminal: 'interrupted',
        result: { success: false, output: '', error: 'Tool invocation aborted before execution' },
        durationMs: Date.now() - startedAt,
      };
    }

    const timeoutController = new AbortController();
    const forwardAbort = () => timeoutController.abort(request.abortSignal?.reason);
    request.abortSignal?.addEventListener('abort', forwardAbort, { once: true });
    const timeout = setTimeout(
      () => timeoutController.abort(new Error('Tool invocation timed out')),
      request.snapshot.executionPolicy.timeoutMs
    );
    timeout.unref?.();
    try {
      const result = await request.snapshot.toolRouter.executeBound(
        EXECUTION_SERVICE_TOKEN,
        request.toolName,
        structuredClone(request.args),
        { ...request.context, abortSignal: timeoutController.signal }
      );
      return {
        terminal: timeoutController.signal.aborted
          ? 'interrupted'
          : result.success
            ? 'completed'
            : 'failed',
        result,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        terminal: timeoutController.signal.aborted ? 'interrupted' : 'failed',
        result: {
          success: false,
          output: '',
          error: error instanceof Error ? error.message : String(error),
        },
        durationMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timeout);
      request.abortSignal?.removeEventListener('abort', forwardAbort);
    }
  }
}

export interface StepSnapshotV1 {
  readonly version: 1;
  readonly threadId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly taskEpoch: number;
  readonly baseMode: AgentBaseModeV1;
  readonly model: ModelSnapshotV1;
  readonly authority: AuthoritySnapshotV1;
  readonly executionPolicy: ExecutionPolicySnapshotV1;
  readonly environment: EnvironmentSnapshotV1;
  readonly capabilityPlan: CapabilityPlanV1;
  readonly prompt: PromptSnapshotV1;
  readonly toolRouter: ToolRouterSnapshotV1;
  readonly skills: SkillSnapshotV1;
  readonly mcp: McpBindingSnapshotV1;
  readonly taskContextRevision: number;
  readonly digest: string;
}

export type StepSnapshotInputV1 = Omit<StepSnapshotV1, 'version' | 'digest' | 'toolRouter'> & {
  readonly toolBindings: readonly ToolBindingV1[];
};

export function captureStepSnapshotV1(input: StepSnapshotInputV1): StepSnapshotV1 {
  for (const [name, id] of [
    ['threadId', input.threadId],
    ['turnId', input.turnId],
    ['stepId', input.stepId],
  ] as const) {
    if (!isRuntimeId(id)) throw new StepSnapshotValidationError(`${name} must be a UUID`);
  }
  if (!Number.isSafeInteger(input.taskEpoch) || input.taskEpoch < 0) {
    throw new StepSnapshotValidationError('taskEpoch must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(input.taskContextRevision) || input.taskContextRevision < 0) {
    throw new StepSnapshotValidationError(
      'taskContextRevision must be a non-negative safe integer'
    );
  }

  const toolRouter = new ToolRouterSnapshotV1(input.toolBindings);
  const direct = new Set(input.capabilityPlan.direct.map(entry => entry.id));
  for (const descriptor of toolRouter.descriptors) {
    if (!direct.has(descriptor.name)) {
      throw new StepSnapshotValidationError(
        `Tool ${descriptor.name} is executable but not direct in CapabilityPlanV1`
      );
    }
  }
  if (direct.size !== toolRouter.descriptors.length) {
    throw new StepSnapshotValidationError(
      'CapabilityPlanV1 direct tools and ToolRouterSnapshotV1 must match exactly'
    );
  }

  const serializable = {
    version: 1 as const,
    threadId: input.threadId,
    turnId: input.turnId,
    stepId: input.stepId,
    taskEpoch: input.taskEpoch,
    baseMode: input.baseMode,
    model: structuredClone(input.model),
    authority: structuredClone(input.authority),
    executionPolicy: structuredClone(input.executionPolicy),
    environment: structuredClone(input.environment),
    capabilityPlan: structuredClone(input.capabilityPlan),
    prompt: structuredClone(input.prompt),
    skills: structuredClone(input.skills),
    mcp: structuredClone(input.mcp),
    taskContextRevision: input.taskContextRevision,
    toolRouterReceipt: toolRouter.toReceipt(),
  };
  const digest = digestRuntimeValue(serializable);
  const { toolRouterReceipt: _receipt, ...snapshotFields } = serializable;
  void _receipt;
  return deepFreeze({ ...snapshotFields, toolRouter, digest });
}

export function createCapabilityPlanV1(input: {
  direct?: readonly CapabilitySelectionV1[];
  deferred?: readonly CapabilitySelectionV1[];
  hidden?: readonly CapabilitySelectionV1[];
  expansionAllowed?: boolean;
}): CapabilityPlanV1 {
  const content = {
    version: 1 as const,
    direct: normalizeSelections(input.direct ?? []),
    deferred: normalizeSelections(input.deferred ?? []),
    hidden: normalizeSelections(input.hidden ?? []),
    expansionAllowed: input.expansionAllowed ?? true,
  };
  const all = [...content.direct, ...content.deferred, ...content.hidden];
  if (new Set(all.map(entry => entry.id)).size !== all.length) {
    throw new StepSnapshotValidationError('Capability IDs must appear in exactly one lane');
  }
  return deepFreeze({ ...content, digest: digestRuntimeValue(content) });
}

export function createAuthoritySnapshotV1(
  input: Omit<AuthoritySnapshotV1, 'digest'>
): AuthoritySnapshotV1 {
  return withDigest(input);
}

export function createExecutionPolicySnapshotV1(
  input: Omit<ExecutionPolicySnapshotV1, 'digest'>
): ExecutionPolicySnapshotV1 {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new StepSnapshotValidationError('Execution timeout must be a positive safe integer');
  }
  return withDigest(input);
}

function normalizeToolDescriptor(input: ToolBindingV1['descriptor']): ToolBindingDescriptorV1 {
  const name = input.name.trim();
  if (!name) throw new StepSnapshotValidationError('Tool name must not be empty');
  if (!input.executorId.trim()) {
    throw new StepSnapshotValidationError(`Tool ${name} requires a stable executorId`);
  }
  const risk = input.risk;
  if (
    typeof risk?.readOnly !== 'boolean' ||
    typeof risk.destructive !== 'boolean' ||
    typeof risk.fileEdit !== 'boolean' ||
    !['none', 'workspace_read', 'workspace_write', 'external_write'].includes(risk.effect) ||
    !['none', 'read', 'write'].includes(risk.network)
  ) {
    throw new StepSnapshotValidationError(`Tool ${name} has incomplete risk metadata`);
  }
  if (risk.readOnly && (risk.destructive || risk.fileEdit || risk.effect.includes('write'))) {
    throw new StepSnapshotValidationError(`Tool ${name} declares contradictory read-only metadata`);
  }
  const aliases = [...new Set(input.aliases.map(alias => alias.trim()).filter(Boolean))].sort();
  const inputSchema = structuredClone(input.inputSchema);
  const schemaDigest = digestRuntimeValue(inputSchema);
  if (input.schemaDigest && input.schemaDigest !== schemaDigest) {
    throw new StepSnapshotValidationError(`Tool ${name} schemaDigest does not match inputSchema`);
  }
  return deepFreeze({
    name,
    aliases,
    description: input.description,
    inputSchema,
    schemaDigest,
    executorId: input.executorId,
    risk: structuredClone(risk),
  });
}

function normalizeSelections(input: readonly CapabilitySelectionV1[]): CapabilitySelectionV1[] {
  return [...input]
    .map(entry => ({ id: entry.id.trim(), reason: entry.reason.trim() }))
    .filter(entry => entry.id.length > 0)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function withDigest<T extends Record<string, unknown>>(input: T): T & { readonly digest: string } {
  const content = structuredClone(input);
  return deepFreeze({ ...content, digest: digestRuntimeValue(content) });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return value;
}
