import type { OrionCodeTool, ToolContext } from '../framework/tool';
import type { CapabilityToolCandidateV1, CapabilityToolTierV1 } from './capabilities';
import { canonicalRuntimeJson, digestRuntimeValue } from './protocol/canonical';
import type {
  ToolBindingV1,
  ToolEffectV1,
  ToolNetworkV1,
  ToolRiskMetadataV1,
} from './step-snapshot';

export interface BuiltinToolCatalogEntryV1 {
  readonly candidate: CapabilityToolCandidateV1;
  readonly binding: ToolBindingV1;
  readonly tool: OrionCodeTool;
}

export interface BuiltinToolCatalogV1 {
  readonly version: 1;
  readonly entries: readonly BuiltinToolCatalogEntryV1[];
  readonly candidates: readonly CapabilityToolCandidateV1[];
  readonly bindings: ReadonlyMap<string, ToolBindingV1>;
  readonly toolSchemaBytes: number;
  readonly digest: string;
}

interface BuiltinToolPolicyV1 {
  readonly tier: CapabilityToolTierV1;
  readonly risk: ToolRiskMetadataV1;
  readonly keywords: readonly string[];
}

const CORE = new Set([
  'edit_file',
  'exec_command',
  'glob',
  'grep',
  'list_files',
  'read_file',
  'subtask',
  'write_file',
]);

const LONG_TAIL = new Set(['web_fetch', 'web_search']);

const EXCLUDED_LEGACY_TOOLS = new Set(['mcp_call', 'mcp_list']);

const NETWORK_READ = new Set(['web_fetch', 'web_search']);
const NETWORK_WRITE = new Set(['git_push']);
const WORKSPACE_WRITES = new Set([
  'edit_file',
  'exec_command',
  'git_branch',
  'git_commit',
  'memory_forget',
  'memory_save',
  'write_file',
]);
const FILE_EDITS = new Set(['edit_file', 'write_file']);
const DESTRUCTIVE = new Set([
  'abandon_goal',
  'edit_file',
  'exec_command',
  'git_branch',
  'git_commit',
  'git_push',
  'memory_forget',
  'write_file',
]);

const KEYWORDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  web_fetch: ['web', 'url', 'http', 'fetch', '网页'],
  web_search: ['web', 'search', 'research', '搜索', '调研'],
  git_status: ['git status', 'working tree status', '工作区状态'],
  git_push: ['git push', 'push changes', '推送', '发布'],
  git_commit: ['git commit', 'commit changes', '提交'],
  git_diff: ['git diff', 'workspace diff', '变更差异'],
  git_log: ['git log', 'commit history', '提交历史'],
  git_branch: ['git branch', 'switch branch', '分支'],
  lsp_get_definition: ['lsp definition', 'go to definition', 'definition', '定义'],
  lsp_get_references: ['lsp references', 'find references', 'references', '引用'],
  lsp_get_hover: ['lsp hover', 'hover information', 'type information', '类型信息'],
  lsp_get_diagnostics: ['lsp diagnostics', 'file diagnostics', 'diagnostics', '诊断'],
  todo_write: ['todo', 'plan', '任务', '计划'],
  get_goal: ['goal', '目标'],
  create_goal: ['goal', '目标'],
  update_goal_plan: ['goal', 'plan', '目标', '计划'],
  update_goal: ['goal', '目标'],
  abandon_goal: ['goal', 'abandon', '目标', '退出'],
  batch_read: ['batch', 'read', '批量', '读取'],
  memory_save: ['memory', 'save', '记忆', '保存'],
  memory_recall: ['memory', 'recall', '记忆', '回忆'],
  memory_forget: ['memory', 'forget', '记忆', '忘记'],
  history_search: ['history', 'search', '历史', '搜索'],
  subtask: ['subtask', 'subagent', 'delegate', 'parallel', 'review', 'research', '并行', '调研'],
});

export class BuiltinToolCatalogError extends Error {
  readonly code = 'ORION_BUILTIN_TOOL_CATALOG_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'BuiltinToolCatalogError';
  }
}

/**
 * Adapts the first-party tool collection into immutable Capability candidates
 * and exact executor bindings. The explicit policy table is conservative:
 * unknown tools are rejected instead of inheriting permissive callback defaults.
 */
export function createBuiltinToolCatalogV1(
  tools: readonly OrionCodeTool[],
  options: { readonly context: ToolContext; readonly include?: readonly string[] } = {
    context: { cwd: process.cwd(), config: { name: 'orion-code', mode: 'production' } },
  }
): BuiltinToolCatalogV1 {
  const include = options.include ? new Set(options.include) : undefined;
  const seenNames = new Set<string>();
  const seenAliases = new Set<string>();
  const entries: BuiltinToolCatalogEntryV1[] = [];

  for (const tool of tools) {
    const name = tool.name.trim();
    if (!name || EXCLUDED_LEGACY_TOOLS.has(name) || (include && !include.has(name))) continue;
    if (seenNames.has(name) || seenAliases.has(name)) {
      throw new BuiltinToolCatalogError(`Duplicate built-in tool name or alias: ${name}`);
    }
    if (!tool.parameters || tool.parameters.type !== 'object') {
      throw new BuiltinToolCatalogError(`Built-in tool ${name} requires an object input schema.`);
    }
    const aliases = [
      ...new Set((tool.aliases ?? []).map(alias => alias.trim()).filter(Boolean)),
    ].sort();
    for (const alias of aliases) {
      if (alias === name || seenNames.has(alias) || seenAliases.has(alias)) {
        throw new BuiltinToolCatalogError(`Duplicate built-in tool name or alias: ${alias}`);
      }
      seenAliases.add(alias);
    }
    seenNames.add(name);

    const frozenTool = freezeToolView(tool, name, aliases);
    const policy = policyFor(name);
    const bindingId = `builtin:${name}:v1`;
    const descriptor = deepFreeze({
      name,
      aliases,
      description: frozenTool.description,
      inputSchema: structuredClone(frozenTool.parameters),
      schemaDigest: digestRuntimeValue(frozenTool.parameters),
      executorId: bindingId,
      risk: policy.risk,
    });
    const binding: ToolBindingV1 = Object.freeze({
      descriptor,
      execute: (args: Record<string, unknown>, context: ToolContext) =>
        frozenTool.execute(args, { ...options.context, ...context }),
    });
    entries.push(
      Object.freeze({
        tool: frozenTool,
        binding,
        candidate: Object.freeze({
          bindingId,
          descriptor,
          tier: policy.tier,
          source: 'first_party' as const,
          keywords: policy.keywords,
        }),
      })
    );
  }

  if (include) {
    const missing = [...include].filter(name => !seenNames.has(name)).sort();
    if (missing.length > 0) {
      throw new BuiltinToolCatalogError(
        `Requested built-in tools are unavailable: ${missing.join(', ')}`
      );
    }
  }

  entries.sort((left, right) =>
    compare(left.candidate.descriptor.name, right.candidate.descriptor.name)
  );
  const candidates = Object.freeze(entries.map(entry => entry.candidate));
  const bindings = new Map(
    entries.map(entry => [entry.candidate.bindingId, entry.binding] as const)
  );
  const schemas = candidates.map(candidate => ({
    type: 'function' as const,
    function: {
      name: candidate.descriptor.name,
      description: candidate.descriptor.description,
      parameters: candidate.descriptor.inputSchema,
    },
  }));
  const content = {
    version: 1 as const,
    tools: candidates.map(candidate => ({
      bindingId: candidate.bindingId,
      descriptor: candidate.descriptor,
      tier: candidate.tier,
      keywords: candidate.keywords,
    })),
  };
  return Object.freeze({
    version: 1,
    entries: Object.freeze(entries),
    candidates,
    bindings,
    toolSchemaBytes: Buffer.byteLength(canonicalRuntimeJson(schemas), 'utf8'),
    digest: digestRuntimeValue(content),
  });
}

function policyFor(name: string): BuiltinToolPolicyV1 {
  if (!CORE.has(name) && !LONG_TAIL.has(name) && !KEYWORDS[name]) {
    throw new BuiltinToolCatalogError(
      `Built-in tool ${name} has no explicit v0.2.0 capability/risk policy.`
    );
  }
  const network: ToolNetworkV1 = NETWORK_WRITE.has(name)
    ? 'write'
    : NETWORK_READ.has(name)
      ? 'read'
      : name === 'exec_command'
        ? 'write'
        : 'none';
  const effect: ToolEffectV1 = NETWORK_WRITE.has(name)
    ? 'external_write'
    : WORKSPACE_WRITES.has(name)
      ? 'workspace_write'
      : name === 'batch_read' ||
          name.startsWith('git_') ||
          name.startsWith('lsp_') ||
          name.endsWith('_file')
        ? 'workspace_read'
        : 'none';
  const destructive = DESTRUCTIVE.has(name);
  const fileEdit = FILE_EDITS.has(name);
  const risk = Object.freeze({
    readOnly: !destructive && effect !== 'workspace_write' && effect !== 'external_write',
    destructive,
    fileEdit,
    effect,
    network,
  });
  return Object.freeze({
    tier: CORE.has(name) ? 'core' : LONG_TAIL.has(name) ? 'long_tail' : 'standard',
    risk,
    keywords: Object.freeze([...(KEYWORDS[name] ?? name.split('_'))]),
  });
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freezeToolView(
  tool: OrionCodeTool,
  name: string,
  aliases: readonly string[]
): OrionCodeTool {
  const bind = <T extends (...args: never[]) => unknown>(value: T | undefined): T | undefined =>
    value?.bind(tool) as T | undefined;
  return Object.freeze({
    name,
    aliases: Object.freeze([...aliases]) as string[],
    description: tool.description,
    parameters: deepFreeze(structuredClone(tool.parameters)),
    execute: tool.execute.bind(tool),
    validateInput: bind(tool.validateInput),
    checkPermissions: bind(tool.checkPermissions),
    isConcurrencySafe: bind(tool.isConcurrencySafe),
    isReadOnly: bind(tool.isReadOnly),
    isDestructive: bind(tool.isDestructive),
    isFileEdit: bind(tool.isFileEdit),
    userFacingName: bind(tool.userFacingName),
    getSummary: bind(tool.getSummary),
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}
