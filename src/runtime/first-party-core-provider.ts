import type { OrionCodeTool, PermissionResult, ToolContext, ToolResult } from '../framework/tool';
import { createBuiltinToolCatalogV1, type BuiltinToolCatalogV1 } from './builtin-tool-provider';
import {
  CORE_TOOL_DESCRIPTORS,
  type CoreToolDescriptorSpecV1,
  type FirstPartyCoreToolNameV1,
} from './core-tools/descriptors';
import { digestRuntimeValue } from './protocol/canonical';

export type { FirstPartyCoreToolNameV1 } from './core-tools/descriptors';

export const FIRST_PARTY_CORE_PROVIDER_VERSION = 1 as const;

export interface FirstPartyCoreToolModuleV1 {
  readonly coreTool: OrionCodeTool;
}

export type FirstPartyCoreToolImporterV1 = () => Promise<FirstPartyCoreToolModuleV1>;
export type FirstPartyCoreToolImporterMapV1 = Readonly<
  Record<FirstPartyCoreToolNameV1, FirstPartyCoreToolImporterV1>
>;

export interface FirstPartyCoreToolProviderOptionsV1 {
  readonly context: ToolContext;
  /** Per-tool injection seam; unspecified names keep their exact production shard. */
  readonly importers?: Partial<FirstPartyCoreToolImporterMapV1>;
}

export interface FirstPartyCoreToolProviderStatsV1 {
  readonly version: 1;
  /** Compatibility proof: this provider never loads the legacy tools barrel. */
  readonly monolithicModuleLoads: number;
  readonly shardModuleLoads: number;
  readonly loadedShardNames: readonly FirstPartyCoreToolNameV1[];
  readonly resolvedExecutors: number;
  readonly resolvedToolNames: readonly FirstPartyCoreToolNameV1[];
}

export class FirstPartyCoreToolProviderError extends Error {
  readonly code = 'ORION_FIRST_PARTY_CORE_PROVIDER_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'FirstPartyCoreToolProviderError';
  }
}

/**
 * Lightweight first-party catalog for the ordinary coding lane.
 *
 * Descriptor construction has no runtime dependency on src/tools. Invoking a
 * frozen binding imports exactly one first-party shard; the legacy tools
 * barrel and unrelated long-tail tools are never materialized. Schema and
 * risk identity are revalidated before any implementation is allowed to run.
 */
export class FirstPartyCoreToolProviderV1 {
  readonly version = FIRST_PARTY_CORE_PROVIDER_VERSION;
  readonly catalog: BuiltinToolCatalogV1;

  private readonly context: ToolContext;
  private readonly importers: FirstPartyCoreToolImporterMapV1;
  private readonly implementations = new Map<FirstPartyCoreToolNameV1, OrionCodeTool>();
  private readonly moduleFlights = new Map<
    FirstPartyCoreToolNameV1,
    Promise<FirstPartyCoreToolModuleV1>
  >();
  private readonly loadedShardNames = new Set<FirstPartyCoreToolNameV1>();

  constructor(options: FirstPartyCoreToolProviderOptionsV1) {
    if (!options.context?.cwd?.trim()) {
      throw new FirstPartyCoreToolProviderError('Core provider context.cwd must not be empty.');
    }
    this.context = options.context;
    this.importers = Object.freeze({ ...DEFAULT_CORE_TOOL_IMPORTERS, ...options.importers });
    this.catalog = createBuiltinToolCatalogV1(
      CORE_TOOL_DESCRIPTORS.map(spec => this.createLazyTool(spec)),
      { context: options.context }
    );
    this.assertCatalogIdentity();
  }

  stats(): FirstPartyCoreToolProviderStatsV1 {
    const resolvedToolNames = [...this.implementations.keys()].sort();
    return Object.freeze({
      version: FIRST_PARTY_CORE_PROVIDER_VERSION,
      monolithicModuleLoads: 0,
      shardModuleLoads: this.loadedShardNames.size,
      loadedShardNames: Object.freeze([...this.loadedShardNames].sort()),
      resolvedExecutors: resolvedToolNames.length,
      resolvedToolNames: Object.freeze(resolvedToolNames),
    });
  }

  private createLazyTool(spec: CoreToolDescriptorSpecV1): OrionCodeTool {
    return {
      name: spec.name,
      aliases: [...spec.aliases],
      description: spec.description,
      parameters: structuredClone(spec.parameters),
      execute: (args, context) => this.execute(spec, args, context),
      checkPermissions: () => permissionFor(spec),
      isConcurrencySafe: () => spec.concurrencySafe,
      isReadOnly: () => spec.readOnly,
      isDestructive: () => spec.destructive,
      isFileEdit: () => spec.fileEdit,
      userFacingName: () => spec.name,
    };
  }

  private async execute(
    spec: CoreToolDescriptorSpecV1,
    args: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const tool = await this.resolveImplementation(spec.name);
    try {
      const inputError = tool.validateInput?.({ ...args });
      if (inputError) return failure(inputError);
      const permission = tool.checkPermissions?.({ ...args }, context);
      if (permission?.behavior === 'deny') {
        return failure(permission.reason ?? `${spec.name} was denied by its implementation.`);
      }
      if (permission?.behavior === 'ask' && spec.permission !== 'ask') {
        return failure(
          `${spec.name} requested confirmation after its frozen lightweight policy allowed it.`
        );
      }
      return await tool.execute({ ...args }, { ...this.context, ...context });
    } catch (error) {
      return failure(errorMessage(error));
    }
  }

  private async resolveImplementation(name: FirstPartyCoreToolNameV1): Promise<OrionCodeTool> {
    const cached = this.implementations.get(name);
    if (cached) return cached;
    const module = await this.loadModule(name);
    const tool = module.coreTool;
    if (!tool || tool.name !== name) {
      throw new FirstPartyCoreToolProviderError(
        `Selected core executor shard ${name} did not export its exact coreTool.`
      );
    }
    this.assertImplementationIdentity(name, tool);
    this.implementations.set(name, tool);
    return tool;
  }

  private loadModule(name: FirstPartyCoreToolNameV1): Promise<FirstPartyCoreToolModuleV1> {
    const cached = this.moduleFlights.get(name);
    if (cached) return cached;
    const importer = this.importers[name];
    const flight = Promise.resolve()
      .then(() => importer())
      .then(module => {
        if (!module?.coreTool) {
          throw new FirstPartyCoreToolProviderError(
            `First-party tool importer ${name} did not return an exact coreTool.`
          );
        }
        this.loadedShardNames.add(name);
        return module;
      });
    this.moduleFlights.set(name, flight);
    return flight;
  }

  private assertCatalogIdentity(): void {
    const expectedNames = CORE_TOOL_DESCRIPTORS.map(spec => spec.name).sort();
    const actualNames = this.catalog.candidates.map(candidate => candidate.descriptor.name).sort();
    if (digestRuntimeValue(actualNames) !== digestRuntimeValue(expectedNames)) {
      throw new FirstPartyCoreToolProviderError('Lightweight core catalog identity drifted.');
    }
  }

  private assertImplementationIdentity(name: FirstPartyCoreToolNameV1, tool: OrionCodeTool): void {
    const actual = createBuiltinToolCatalogV1([tool], { context: this.context });
    const expected = this.catalog.entries.find(entry => entry.candidate.descriptor.name === name);
    if (!expected || actual.entries.length !== 1) {
      throw new FirstPartyCoreToolProviderError(`Core executor ${name} cannot be validated.`);
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
      throw new FirstPartyCoreToolProviderError(
        `Core executor ${name} does not match its frozen descriptor.`
      );
    }
  }
}

export function createFirstPartyCoreToolProviderV1(
  options: FirstPartyCoreToolProviderOptionsV1
): FirstPartyCoreToolProviderV1 {
  return new FirstPartyCoreToolProviderV1(options);
}

const DEFAULT_CORE_TOOL_IMPORTERS: FirstPartyCoreToolImporterMapV1 = Object.freeze({
  edit_file: () => import('../tools/core/edit-file'),
  exec_command: () => import('../tools/core/exec-command'),
  glob: () => import('../tools/core/glob'),
  grep: () => import('../tools/core/grep'),
  list_files: () => import('../tools/core/list-files'),
  read_file: () => import('../tools/core/read-file'),
  write_file: () => import('../tools/core/write-file'),
});

function permissionFor(spec: CoreToolDescriptorSpecV1): PermissionResult {
  return spec.permission === 'allow'
    ? { behavior: 'allow' }
    : { behavior: 'ask', reason: spec.permissionReason ?? `${spec.name} may mutate state.` };
}

function failure(error: string): ToolResult {
  return { success: false, output: '', error };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
