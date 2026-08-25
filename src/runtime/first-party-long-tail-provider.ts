import type { OrionCodeTool, PermissionResult, ToolContext, ToolResult } from '../framework/tool';
import { createBuiltinToolCatalogV1, type BuiltinToolCatalogV1 } from './builtin-tool-provider';
import {
  LONG_TAIL_TOOL_DESCRIPTORS,
  type FirstPartyLongTailToolGroupV1,
  type FirstPartyLongTailToolNameV1,
  type LongTailToolDescriptorSpecV1,
} from './long-tail-tools/descriptors';
import { digestRuntimeValue } from './protocol/canonical';

export type {
  FirstPartyLongTailToolGroupV1,
  FirstPartyLongTailToolNameV1,
} from './long-tail-tools/descriptors';

export const FIRST_PARTY_LONG_TAIL_PROVIDER_VERSION = 1 as const;

export interface FirstPartyLongTailToolModuleV1 {
  readonly tools: readonly OrionCodeTool[];
}

export type FirstPartyLongTailGroupImporterV1 = () => Promise<FirstPartyLongTailToolModuleV1>;
export type FirstPartyLongTailGroupImporterMapV1 = Readonly<
  Record<FirstPartyLongTailToolGroupV1, FirstPartyLongTailGroupImporterV1>
>;

export interface FirstPartyLongTailToolProviderOptionsV1 {
  readonly context: ToolContext;
  /** Group-level injection seam; unspecified groups keep their production dynamic import. */
  readonly importers?: Partial<FirstPartyLongTailGroupImporterMapV1>;
}

export interface FirstPartyLongTailToolProviderStatsV1 {
  readonly version: 1;
  /** Compatibility proof: this provider never imports the retired src/tools barrel. */
  readonly monolithicModuleLoads: 0;
  readonly groupModuleLoads: number;
  readonly loadedGroups: readonly FirstPartyLongTailToolGroupV1[];
  readonly resolvedExecutors: number;
  readonly resolvedToolNames: readonly FirstPartyLongTailToolNameV1[];
}

export class FirstPartyLongTailToolProviderError extends Error {
  readonly code = 'ORION_FIRST_PARTY_LONG_TAIL_PROVIDER_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'FirstPartyLongTailToolProviderError';
  }
}

/**
 * Descriptor-only catalog for first-party Git, LSP and Web capabilities.
 *
 * Construction has no dependency on src/tools. An implementation group is
 * imported only after one of its exact frozen bindings executes. The loaded
 * implementation must reproduce the descriptor, schema, executor and risk
 * identity captured before the model boundary or execution fails closed.
 */
export class FirstPartyLongTailToolProviderV1 {
  readonly version = FIRST_PARTY_LONG_TAIL_PROVIDER_VERSION;
  readonly catalog: BuiltinToolCatalogV1;

  private readonly context: ToolContext;
  private readonly importers: FirstPartyLongTailGroupImporterMapV1;
  private readonly groupFlights = new Map<
    FirstPartyLongTailToolGroupV1,
    Promise<FirstPartyLongTailToolModuleV1>
  >();
  private readonly implementations = new Map<FirstPartyLongTailToolNameV1, OrionCodeTool>();
  private readonly loadedGroups = new Set<FirstPartyLongTailToolGroupV1>();

  constructor(options: FirstPartyLongTailToolProviderOptionsV1) {
    if (!options.context?.cwd?.trim()) {
      throw new FirstPartyLongTailToolProviderError(
        'Long-tail provider context.cwd must not be empty.'
      );
    }
    this.context = options.context;
    this.importers = Object.freeze({ ...DEFAULT_LONG_TAIL_IMPORTERS, ...options.importers });
    this.catalog = createBuiltinToolCatalogV1(
      LONG_TAIL_TOOL_DESCRIPTORS.map(spec => this.createLazyTool(spec)),
      { context: options.context }
    );
    this.assertCatalogIdentity();
  }

  stats(): FirstPartyLongTailToolProviderStatsV1 {
    return Object.freeze({
      version: FIRST_PARTY_LONG_TAIL_PROVIDER_VERSION,
      monolithicModuleLoads: 0,
      groupModuleLoads: this.loadedGroups.size,
      loadedGroups: Object.freeze([...this.loadedGroups].sort(compare)),
      resolvedExecutors: this.implementations.size,
      resolvedToolNames: Object.freeze([...this.implementations.keys()].sort(compare)),
    });
  }

  private createLazyTool(spec: LongTailToolDescriptorSpecV1): OrionCodeTool {
    return {
      name: spec.name,
      aliases: [...spec.aliases],
      description: spec.description,
      parameters: structuredClone(spec.parameters),
      execute: (args, context) => this.execute(spec, args, context),
      checkPermissions: args => clonePermission(spec.permission(args)),
      isConcurrencySafe: args => spec.concurrencySafe(args),
      isReadOnly: args => spec.readOnly(args),
      isDestructive: args => spec.destructive(args),
      isFileEdit: args => spec.fileEdit(args),
      userFacingName: args => spec.userFacingName(args),
      ...(spec.summarize
        ? {
            getSummary: (args: Record<string, unknown>, result: ToolResult) =>
              spec.summarize!(args, result),
          }
        : {}),
    };
  }

  private async execute(
    spec: LongTailToolDescriptorSpecV1,
    args: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const tool = await this.resolveImplementation(spec);
    try {
      this.assertInvocationPolicy(spec, tool, args, context);
      const inputError = tool.validateInput?.({ ...args });
      if (inputError) return failure(inputError);
      const permission = tool.checkPermissions?.({ ...args }, context);
      if (permission?.behavior === 'deny') {
        return failure(permission.reason ?? `${spec.name} was denied by its implementation.`);
      }
      return await tool.execute({ ...args }, { ...this.context, ...context });
    } catch (error) {
      return failure(errorMessage(error));
    }
  }

  private async resolveImplementation(spec: LongTailToolDescriptorSpecV1): Promise<OrionCodeTool> {
    const cached = this.implementations.get(spec.name);
    if (cached) return cached;
    const module = await this.loadGroup(spec.group);
    const tool = module.tools.find(candidate => candidate.name === spec.name);
    if (!tool) {
      throw new FirstPartyLongTailToolProviderError(
        `Selected ${spec.group} executor group did not export ${spec.name}.`
      );
    }
    this.assertImplementationIdentity(spec.name, tool);
    this.implementations.set(spec.name, tool);
    return tool;
  }

  private loadGroup(group: FirstPartyLongTailToolGroupV1): Promise<FirstPartyLongTailToolModuleV1> {
    const cached = this.groupFlights.get(group);
    if (cached) return cached;
    const importer = this.importers[group];
    const flight = Promise.resolve()
      .then(() => importer())
      .then(module => {
        this.assertGroupExports(group, module);
        this.loadedGroups.add(group);
        return module;
      });
    this.groupFlights.set(group, flight);
    return flight;
  }

  private assertGroupExports(
    group: FirstPartyLongTailToolGroupV1,
    module: FirstPartyLongTailToolModuleV1
  ): void {
    if (!Array.isArray(module?.tools)) {
      throw new FirstPartyLongTailToolProviderError(
        `First-party ${group} importer did not return a tools array.`
      );
    }
    const expected = LONG_TAIL_TOOL_DESCRIPTORS.filter(spec => spec.group === group)
      .map(spec => spec.name)
      .sort(compare);
    const actual = module.tools.map(tool => tool?.name).sort(compare);
    if (digestRuntimeValue(actual) !== digestRuntimeValue(expected)) {
      throw new FirstPartyLongTailToolProviderError(
        `First-party ${group} executor group exports do not match its frozen descriptor set.`
      );
    }
  }

  private assertCatalogIdentity(): void {
    const expected = LONG_TAIL_TOOL_DESCRIPTORS.map(spec => spec.name).sort(compare);
    const actual = this.catalog.candidates
      .map(candidate => candidate.descriptor.name)
      .sort(compare);
    if (digestRuntimeValue(actual) !== digestRuntimeValue(expected)) {
      throw new FirstPartyLongTailToolProviderError(
        'Lightweight long-tail catalog identity drifted.'
      );
    }
    for (const spec of LONG_TAIL_TOOL_DESCRIPTORS) {
      const descriptor = this.catalog.entries.find(
        entry => entry.candidate.descriptor.name === spec.name
      )?.candidate.descriptor;
      if (
        !descriptor ||
        descriptor.executorId !== `builtin:${spec.name}:v1` ||
        descriptor.schemaDigest !== digestRuntimeValue(spec.parameters) ||
        digestRuntimeValue(descriptor.risk) !== digestRuntimeValue(spec.risk)
      ) {
        throw new FirstPartyLongTailToolProviderError(
          `Lightweight long-tail descriptor ${spec.name} schema/risk/executor identity drifted.`
        );
      }
    }
  }

  private assertImplementationIdentity(
    name: FirstPartyLongTailToolNameV1,
    tool: OrionCodeTool
  ): void {
    const actual = createBuiltinToolCatalogV1([tool], { context: this.context });
    const expected = this.catalog.entries.find(entry => entry.candidate.descriptor.name === name);
    if (!expected || actual.entries.length !== 1) {
      throw new FirstPartyLongTailToolProviderError(
        `Long-tail executor ${name} cannot be validated.`
      );
    }
    const expectedDescriptor = expected.candidate.descriptor;
    const actualDescriptor = actual.entries[0].candidate.descriptor;
    if (
      expectedDescriptor.name !== actualDescriptor.name ||
      expectedDescriptor.description !== actualDescriptor.description ||
      expectedDescriptor.schemaDigest !== actualDescriptor.schemaDigest ||
      expectedDescriptor.executorId !== actualDescriptor.executorId ||
      digestRuntimeValue(expectedDescriptor.aliases) !==
        digestRuntimeValue(actualDescriptor.aliases) ||
      digestRuntimeValue(expectedDescriptor.risk) !== digestRuntimeValue(actualDescriptor.risk)
    ) {
      throw new FirstPartyLongTailToolProviderError(
        `Long-tail executor ${name} does not match its frozen descriptor.`
      );
    }
  }

  private assertInvocationPolicy(
    spec: LongTailToolDescriptorSpecV1,
    tool: OrionCodeTool,
    args: Record<string, unknown>,
    context: ToolContext
  ): void {
    const expectedPermission = spec.permission(args);
    const actualPermission = tool.checkPermissions?.({ ...args }, context) ?? {
      behavior: 'allow' as const,
    };
    if (actualPermission.behavior !== expectedPermission.behavior) {
      throw new FirstPartyLongTailToolProviderError(
        `Long-tail executor ${spec.name} permission behavior drifted.`
      );
    }
    for (const [label, expected, actual] of [
      ['read-only', spec.readOnly(args), tool.isReadOnly?.({ ...args }) ?? false],
      ['destructive', spec.destructive(args), tool.isDestructive?.({ ...args }) ?? false],
      ['file-edit', spec.fileEdit(args), tool.isFileEdit?.({ ...args }) ?? false],
      ['concurrency', spec.concurrencySafe(args), tool.isConcurrencySafe?.({ ...args }) ?? false],
    ] as const) {
      if (expected !== actual) {
        throw new FirstPartyLongTailToolProviderError(
          `Long-tail executor ${spec.name} ${label} metadata drifted.`
        );
      }
    }
  }
}

export function createFirstPartyLongTailToolProviderV1(
  options: FirstPartyLongTailToolProviderOptionsV1
): FirstPartyLongTailToolProviderV1 {
  return new FirstPartyLongTailToolProviderV1(options);
}

const DEFAULT_LONG_TAIL_IMPORTERS: FirstPartyLongTailGroupImporterMapV1 = Object.freeze({
  git: async () => ({ tools: (await import('../tools/git')).GIT_TOOLS }),
  lsp: async () => ({ tools: (await import('../tools/lsp')).lspTools }),
  web: async () => ({ tools: (await import('../tools/web')).WEB_TOOLS }),
});

function clonePermission(permission: PermissionResult): PermissionResult {
  return permission.reason
    ? { behavior: permission.behavior, reason: permission.reason }
    : { behavior: permission.behavior };
}

function failure(error: string): ToolResult {
  return { success: false, output: '', error };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
