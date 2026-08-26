import { canonicalRuntimeJson, digestRuntimeValue } from '../protocol/canonical';
import {
  createCapabilityPlanV1,
  type CapabilityPlanV1,
  type CapabilitySelectionV1,
  type ToolBindingDescriptorV1,
} from '../step-snapshot';
import type {
  CapabilityBudgetsV1,
  CapabilityCompilationV1,
  CapabilityCompilerInputV1,
  CapabilityExpansionReceiptV1,
  CapabilityExpansionRequestV1,
  CapabilityMcpBindingSelectionV1,
  CapabilityOmissionCodeV1,
  CapabilityOmissionV1,
  CapabilityReceiptIdentityV1,
  CapabilityReceiptV1,
  CapabilitySkillCandidateV1,
  CapabilitySkillSelectionV1,
  CapabilityToolBindingSelectionV1,
  CapabilityToolCandidateV1,
  DeferredCapabilitySummaryV1,
} from './types';

export const CAPABILITY_COMPILER_VERSION = 'orion-capability-compiler-v1';

type CapabilityCompilerErrorCode =
  | 'ORION_CAPABILITY_INPUT_INVALID'
  | 'ORION_CAPABILITY_CATALOG_INVALID'
  | 'ORION_CAPABILITY_REQUIRED_BUDGET'
  | 'ORION_CAPABILITY_EXPANSION_INVALID'
  | 'ORION_CAPABILITY_EXPANSION_EXHAUSTED'
  | 'ORION_CAPABILITY_INPUT_DRIFT';

export class CapabilityCompilerError extends Error {
  constructor(
    public readonly code: CapabilityCompilerErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'CapabilityCompilerError';
  }
}

interface NormalizedCatalog {
  readonly tools: readonly CapabilityToolCandidateV1[];
  readonly byName: ReadonlyMap<string, CapabilityToolCandidateV1>;
  readonly byLookup: ReadonlyMap<string, CapabilityToolCandidateV1>;
  readonly skills: readonly CapabilitySkillCandidateV1[];
  readonly skillsById: ReadonlyMap<string, CapabilitySkillCandidateV1>;
  readonly toolCatalogDigest: string;
}

interface SelectionReason {
  readonly reason: string;
  readonly required: boolean;
}

interface CompileOptions {
  readonly expansion?: {
    readonly previous: CapabilityCompilationV1;
    readonly requestedCanonicalIds: readonly string[];
    readonly requestedRawIds: readonly string[];
    readonly reason: string;
  };
}

interface CompilationLanes {
  readonly direct: readonly CapabilityToolCandidateV1[];
  readonly directReasons: ReadonlyMap<string, string>;
  readonly deferred: readonly CapabilityToolCandidateV1[];
  readonly deferredReasons: ReadonlyMap<string, string>;
  readonly hidden: readonly CapabilitySelectionV1[];
  readonly omissions: readonly CapabilityOmissionV1[];
  readonly selectedExpansionIds: readonly string[];
}

interface RouterDigests {
  readonly toolSchemaDigest: string;
  readonly toolBindingDigest: string;
  readonly toolRouterDigest: string;
  readonly toolSchemaBytes: number;
}

export function compileCapabilityPlanV1(input: CapabilityCompilerInputV1): CapabilityCompilationV1 {
  return compile(input, input.receipt, {});
}

export function expandCapabilityPlanV1(
  input: CapabilityCompilerInputV1,
  expansion: CapabilityExpansionRequestV1
): CapabilityCompilationV1 {
  validateExpansionParent(input, expansion);
  const catalog = normalizeCatalog(input);
  const requestedRawIds = normalizeStrings(expansion.requestedToolIds);
  const requestedCanonicalIds = requestedRawIds
    .map(id => catalog.byLookup.get(normalizeLookup(id))?.descriptor.name)
    .filter((id): id is string => Boolean(id));
  return compile(input, expansion.receipt, {
    expansion: {
      previous: expansion.previous,
      requestedCanonicalIds: uniqueSorted(requestedCanonicalIds),
      requestedRawIds,
      reason: expansion.reason.trim(),
    },
  });
}

function compile(
  input: CapabilityCompilerInputV1,
  receiptIdentity: CapabilityReceiptIdentityV1,
  options: CompileOptions
): CapabilityCompilationV1 {
  validateInput(input, receiptIdentity);
  const catalog = normalizeCatalog(input);
  const omissions: CapabilityOmissionV1[] = [];
  const selectedSkills = selectSkills(input, catalog, omissions);
  const skillRequestedTools = new Map<string, string>();

  for (const skill of selectedSkills) {
    for (const requested of skill.requestedCapabilities) {
      const candidate = catalog.byLookup.get(normalizeLookup(requested));
      if (candidate) {
        skillRequestedTools.set(candidate.descriptor.name, skill.id);
      } else {
        omissions.push(
          omission(
            requested,
            'skill_capability_unavailable',
            `Selected skill ${skill.id} requested an unavailable capability.`
          )
        );
      }
    }
  }

  const explicit = resolveExplicitTools(input, catalog, omissions);
  const reasons = buildDirectReasons(input, catalog, explicit, skillRequestedTools);
  const lanes = selectLanes(input, catalog, reasons, omissions, options);
  const plan = createCapabilityPlanV1({
    direct: lanes.direct.map(candidate => ({
      id: candidate.descriptor.name,
      reason: lanes.directReasons.get(candidate.descriptor.name)!,
    })),
    deferred: lanes.deferred.map(candidate => ({
      id: candidate.descriptor.name,
      reason: lanes.deferredReasons.get(candidate.descriptor.name)!,
    })),
    hidden: lanes.hidden,
    expansionAllowed: options.expansion ? false : lanes.deferred.length > 0,
  });

  const directToolBindings = freeze(
    lanes.direct.map(candidate => ({
      bindingId: candidate.bindingId,
      descriptor: cloneDescriptor(candidate.descriptor),
      reason: lanes.directReasons.get(candidate.descriptor.name)!,
    })) satisfies CapabilityToolBindingSelectionV1[]
  );
  const deferredTools = freeze(
    lanes.deferred.map(candidate => ({
      id: candidate.descriptor.name,
      description: candidate.descriptor.description,
      source: candidate.source,
      reason: lanes.deferredReasons.get(candidate.descriptor.name)!,
    })) satisfies DeferredCapabilitySummaryV1[]
  );
  const selectedMcpBindings = selectMcpBindings(catalog, plan);
  const routerDigests = createRouterDigests(lanes.direct);
  const expansionReceipt = options.expansion
    ? createExpansionReceipt(input, options.expansion, lanes.selectedExpansionIds)
    : undefined;
  const receipt = createReceipt({
    input,
    receiptIdentity,
    plan,
    catalog,
    selectedSkills,
    selectedMcpBindings,
    omissions: lanes.omissions,
    routerDigests,
    expansion: expansionReceipt,
  });

  return freeze({
    plan,
    directToolBindings,
    deferredTools,
    selectedSkills,
    selectedMcpBindings,
    receipt,
  });
}

function validateInput(
  input: CapabilityCompilerInputV1,
  receipt: CapabilityReceiptIdentityV1
): void {
  validateBudgets(input.budgets);
  for (const [name, value] of [
    ['task objective', input.task.objective],
    ['runtimeServicesDigest', input.runtimeServicesDigest],
    ['executionPolicyDigest', input.executionPolicyDigest],
    ['skillCatalogDigest', input.skillCatalogDigest],
    ['mcpCatalogDigest', input.mcpCatalogDigest],
    ['authority digest', input.authority.digest],
    ['requestId', receipt.requestId],
    ['threadId', receipt.threadId],
    ['turnId', receipt.turnId],
    ['stepId', receipt.stepId],
    ['durableCommitId', receipt.durableCommitId],
  ] as const) {
    if (!value.trim()) {
      throw new CapabilityCompilerError(
        'ORION_CAPABILITY_INPUT_INVALID',
        `${name} must not be empty.`
      );
    }
  }
  if (!Number.isSafeInteger(input.taskContextRevision) || input.taskContextRevision < 0) {
    throw new CapabilityCompilerError(
      'ORION_CAPABILITY_INPUT_INVALID',
      'taskContextRevision must be a non-negative safe integer.'
    );
  }
  if (!Number.isFinite(input.estimatedInputTokens) || input.estimatedInputTokens < 0) {
    throw new CapabilityCompilerError(
      'ORION_CAPABILITY_INPUT_INVALID',
      'estimatedInputTokens must be non-negative and finite.'
    );
  }
  if (!Number.isFinite(receipt.createdAt) || receipt.createdAt < 0) {
    throw new CapabilityCompilerError(
      'ORION_CAPABILITY_INPUT_INVALID',
      'receipt createdAt must be non-negative and finite.'
    );
  }
  if (!['build', 'plan', 'auto'].includes(input.baseMode)) {
    throw new CapabilityCompilerError(
      'ORION_CAPABILITY_INPUT_INVALID',
      'baseMode must be build, plan or auto.'
    );
  }
  const { digest: authorityDigest, ...authorityContent } = input.authority;
  if (digestRuntimeValue(authorityContent) !== authorityDigest) {
    throw new CapabilityCompilerError(
      'ORION_CAPABILITY_INPUT_INVALID',
      'Authority snapshot digest does not match its content.'
    );
  }
  const deniedIds = new Set<string>();
  for (const denied of input.hardDeniedTools ?? []) {
    const id = normalizeLookup(denied.id);
    if (!id || deniedIds.has(id)) {
      throw new CapabilityCompilerError(
        'ORION_CAPABILITY_INPUT_INVALID',
        `Hard-denied capability id is empty or duplicated: ${denied.id}.`
      );
    }
    deniedIds.add(id);
  }
}

function validateBudgets(budgets: CapabilityBudgetsV1): void {
  for (const [name, value] of Object.entries(budgets)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new CapabilityCompilerError(
        'ORION_CAPABILITY_INPUT_INVALID',
        `Capability budget ${name} must be a non-negative safe integer.`
      );
    }
  }
  if (budgets.maxToolSchemaBytes < 2) {
    throw new CapabilityCompilerError(
      'ORION_CAPABILITY_INPUT_INVALID',
      'maxToolSchemaBytes must fit at least an empty JSON array.'
    );
  }
}

function normalizeCatalog(input: CapabilityCompilerInputV1): NormalizedCatalog {
  const byName = new Map<string, CapabilityToolCandidateV1>();
  const byLookup = new Map<string, CapabilityToolCandidateV1>();
  const bindingIds = new Set<string>();
  const tools = [...input.tools]
    .map(candidate => normalizeToolCandidate(candidate))
    .sort((left, right) => compare(left.descriptor.name, right.descriptor.name));

  for (const candidate of tools) {
    const name = candidate.descriptor.name;
    if (byName.has(name)) catalogError(`Duplicate tool name: ${name}.`);
    if (bindingIds.has(candidate.bindingId)) {
      catalogError(`Duplicate tool bindingId: ${candidate.bindingId}.`);
    }
    byName.set(name, candidate);
    bindingIds.add(candidate.bindingId);
    for (const lookup of [name, ...candidate.descriptor.aliases]) {
      const key = normalizeLookup(lookup);
      if (byLookup.has(key)) catalogError(`Duplicate tool name or alias: ${lookup}.`);
      byLookup.set(key, candidate);
    }
  }

  const skillsById = new Map<string, CapabilitySkillCandidateV1>();
  const skills = [...(input.skills ?? [])]
    .map(normalizeSkillCandidate)
    .sort((left, right) => compare(left.id, right.id));
  for (const skill of skills) {
    if (skillsById.has(skill.id)) catalogError(`Duplicate skill id: ${skill.id}.`);
    skillsById.set(skill.id, skill);
  }

  const toolCatalogDigest = digestRuntimeValue(
    tools.map(candidate => ({
      bindingId: candidate.bindingId,
      descriptor: candidate.descriptor,
      tier: candidate.tier,
      source: candidate.source,
      keywords: candidate.keywords,
      mcp: candidate.mcp,
    }))
  );
  return { tools, byName, byLookup, skills, skillsById, toolCatalogDigest };
}

function normalizeToolCandidate(candidate: CapabilityToolCandidateV1): CapabilityToolCandidateV1 {
  const bindingId = candidate.bindingId.trim();
  const descriptor = cloneDescriptor(candidate.descriptor);
  if (!bindingId) catalogError(`Tool ${descriptor.name} requires a bindingId.`);
  if (!descriptor.name.trim()) catalogError('Tool name must not be empty.');
  if (!descriptor.executorId.trim()) catalogError(`Tool ${descriptor.name} requires executorId.`);
  if (digestRuntimeValue(descriptor.inputSchema) !== descriptor.schemaDigest) {
    catalogError(`Tool ${descriptor.name} schemaDigest does not match inputSchema.`);
  }
  if (!['core', 'standard', 'long_tail'].includes(candidate.tier)) {
    catalogError(`Tool ${descriptor.name} has an invalid capability tier.`);
  }
  if (!['builtin', 'first_party', 'skill', 'mcp'].includes(candidate.source)) {
    catalogError(`Tool ${descriptor.name} has an invalid capability source.`);
  }
  const risk = descriptor.risk;
  if (
    typeof risk?.readOnly !== 'boolean' ||
    typeof risk.destructive !== 'boolean' ||
    typeof risk.fileEdit !== 'boolean' ||
    !['none', 'workspace_read', 'workspace_write', 'external_write'].includes(risk.effect) ||
    !['none', 'read', 'write'].includes(risk.network)
  ) {
    catalogError(`Tool ${descriptor.name} has incomplete risk metadata.`);
  }
  if (risk.readOnly && (risk.destructive || risk.fileEdit || risk.effect.includes('write'))) {
    catalogError(`Tool ${descriptor.name} has contradictory read-only metadata.`);
  }
  if (candidate.source === 'mcp' && !candidate.mcp) {
    catalogError(`MCP tool ${descriptor.name} requires MCP source metadata.`);
  }
  if (candidate.mcp && candidate.source !== 'mcp') {
    catalogError(`Non-MCP tool ${descriptor.name} cannot declare MCP source metadata.`);
  }
  if (candidate.mcp && (!candidate.mcp.serverId.trim() || !candidate.mcp.bindingDigest.trim())) {
    catalogError(`MCP tool ${descriptor.name} requires stable server and binding digests.`);
  }
  return freeze({
    bindingId,
    descriptor,
    tier: candidate.tier,
    source: candidate.source,
    keywords: uniqueSorted(candidate.keywords ?? []),
    mcp: candidate.mcp
      ? {
          serverId: candidate.mcp.serverId.trim(),
          bindingDigest: candidate.mcp.bindingDigest.trim(),
        }
      : undefined,
  });
}

function cloneDescriptor(descriptor: ToolBindingDescriptorV1): ToolBindingDescriptorV1 {
  return freeze({
    name: descriptor.name.trim(),
    aliases: uniqueSorted(descriptor.aliases),
    description: descriptor.description,
    inputSchema: structuredClone(descriptor.inputSchema),
    schemaDigest: descriptor.schemaDigest.trim(),
    executorId: descriptor.executorId.trim(),
    risk: structuredClone(descriptor.risk),
  });
}

function normalizeSkillCandidate(skill: CapabilitySkillCandidateV1): CapabilitySkillCandidateV1 {
  const id = skill.id.trim();
  if (!id || !skill.digest.trim()) catalogError('Skill id and digest must not be empty.');
  return freeze({
    id,
    digest: skill.digest.trim(),
    description: skill.description,
    keywords: uniqueSorted(skill.keywords ?? []),
    requestedCapabilities: uniqueSorted(skill.requestedCapabilities),
    loaded: skill.loaded === true,
  });
}

function selectSkills(
  input: CapabilityCompilerInputV1,
  catalog: NormalizedCatalog,
  omissions: CapabilityOmissionV1[]
): readonly CapabilitySkillSelectionV1[] {
  const selected = new Map<string, string>();
  const explicitIds = normalizeStrings(input.task.explicitSkillIds ?? []);
  const taskText = normalizedTaskText(input);

  for (const id of explicitIds) {
    const skill = catalog.skillsById.get(id);
    if (skill) {
      selected.set(id, 'Explicitly requested by the task.');
    } else {
      omissions.push(
        omission(id, 'unknown_explicit_skill', `Explicit skill ${id} is unavailable.`)
      );
    }
  }
  for (const skill of catalog.skills) {
    if (selected.has(skill.id)) continue;
    if (matchesTask([skill.id, ...(skill.keywords ?? [])], taskText)) {
      selected.set(skill.id, 'Matched current task intent.');
    }
  }

  return freeze(
    [...selected]
      .sort(([left], [right]) => compare(left, right))
      .map(([id, reason]) => {
        const skill = catalog.skillsById.get(id)!;
        return {
          id,
          digest: skill.digest,
          loaded: skill.loaded === true,
          reason,
          requestedCapabilities: [...skill.requestedCapabilities],
        };
      })
  );
}

function resolveExplicitTools(
  input: CapabilityCompilerInputV1,
  catalog: NormalizedCatalog,
  omissions: CapabilityOmissionV1[]
): ReadonlyMap<string, string> {
  const explicit = new Map<string, string>();
  const groups: Array<{
    ids: readonly string[];
    missingCode: 'unknown_explicit_tool' | 'unknown_explicit_mcp_tool';
    mcpOnly: boolean;
  }> = [
    {
      ids: normalizeStrings(input.task.explicitToolIds ?? []),
      missingCode: 'unknown_explicit_tool',
      mcpOnly: false,
    },
    {
      ids: normalizeStrings(input.task.explicitMcpToolIds ?? []),
      missingCode: 'unknown_explicit_mcp_tool',
      mcpOnly: true,
    },
  ];

  for (const group of groups) {
    for (const rawId of group.ids) {
      const candidate = resolveCandidate(rawId, catalog, group.mcpOnly);
      if (!candidate) {
        omissions.push(
          omission(rawId, group.missingCode, `Explicit capability ${rawId} is unavailable.`)
        );
        continue;
      }
      explicit.set(candidate.descriptor.name, 'Explicitly requested by the task.');
    }
  }
  const taskText = normalizedTaskText(input);
  for (const candidate of catalog.tools) {
    if (
      matchesTask([candidate.descriptor.name, ...candidate.descriptor.aliases], taskText) &&
      !explicit.has(candidate.descriptor.name)
    ) {
      explicit.set(candidate.descriptor.name, 'Explicitly named in task text.');
    }
  }
  return explicit;
}

function resolveCandidate(
  id: string,
  catalog: NormalizedCatalog,
  mcpOnly: boolean
): CapabilityToolCandidateV1 | undefined {
  const direct = catalog.byLookup.get(normalizeLookup(id));
  if (direct && (!mcpOnly || direct.source === 'mcp')) return direct;
  if (!mcpOnly) return undefined;
  return catalog.tools.find(
    candidate =>
      candidate.source === 'mcp' &&
      (candidate.bindingId === id ||
        `${candidate.mcp?.serverId}.${candidate.descriptor.name}` === id)
  );
}

function buildDirectReasons(
  input: CapabilityCompilerInputV1,
  catalog: NormalizedCatalog,
  explicit: ReadonlyMap<string, string>,
  skillRequestedTools: ReadonlyMap<string, string>
): ReadonlyMap<string, SelectionReason> {
  const result = new Map<string, SelectionReason>();
  const taskText = normalizedTaskText(input);

  for (const candidate of catalog.tools) {
    const name = candidate.descriptor.name;
    const explicitReason = explicit.get(name);
    if (explicitReason) {
      result.set(name, { reason: explicitReason, required: true });
      continue;
    }
    const skillId = skillRequestedTools.get(name);
    if (skillId) {
      result.set(name, {
        reason: `Required by selected skill ${skillId}.`,
        required: true,
      });
      continue;
    }
    if (candidate.tier === 'core') {
      result.set(name, { reason: 'Core coding capability.', required: true });
      continue;
    }
    if (
      candidate.tier === 'standard' &&
      matchesTask([name, ...candidate.descriptor.aliases, ...(candidate.keywords ?? [])], taskText)
    ) {
      result.set(name, { reason: 'Matched current task intent.', required: false });
    }
  }
  return result;
}

function selectLanes(
  input: CapabilityCompilerInputV1,
  catalog: NormalizedCatalog,
  reasons: ReadonlyMap<string, SelectionReason>,
  initialOmissions: readonly CapabilityOmissionV1[],
  options: CompileOptions
): CompilationLanes {
  const direct: CapabilityToolCandidateV1[] = [];
  const directReasons = new Map<string, string>();
  const deferredCandidates: Array<{ candidate: CapabilityToolCandidateV1; reason: string }> = [];
  const hidden: CapabilitySelectionV1[] = [];
  const omissions = [...initialOmissions];
  const selectedExpansionIds: string[] = [];
  const expansionRequested = new Set(options.expansion?.requestedCanonicalIds ?? []);
  const previousDeferred = new Set(
    options.expansion?.previous.plan.deferred.map(selection => selection.id) ?? []
  );
  const previousDirect = new Set(
    options.expansion?.previous.plan.direct.map(selection => selection.id) ?? []
  );
  let expansionSlots = input.budgets.maxExpansionTools;

  const selectionPriority = (candidate: CapabilityToolCandidateV1): number => {
    const name = candidate.descriptor.name;
    if (previousDirect.has(name)) return 0;
    if (expansionRequested.has(name) && previousDeferred.has(name)) return 2;
    const selection = reasons.get(name);
    if (selection?.required) return 0;
    if (selection) return 1;
    return 3;
  };
  const orderedTools = [...catalog.tools].sort(
    (left, right) =>
      selectionPriority(left) - selectionPriority(right) ||
      compare(left.descriptor.name, right.descriptor.name)
  );

  for (const candidate of orderedTools) {
    const name = candidate.descriptor.name;
    const deniedReason = authorityDenial(input, candidate);
    if (deniedReason) {
      hidden.push({ id: name, reason: deniedReason });
      omissions.push(omission(name, denialCode(input), deniedReason));
      continue;
    }

    const selection = reasons.get(name);
    const wantsExpansion = expansionRequested.has(name) && previousDeferred.has(name);
    const previousReason = options.expansion?.previous.plan.direct.find(
      item => item.id === name
    )?.reason;
    const reason = wantsExpansion
      ? { reason: `Expanded after bounded request: ${options.expansion!.reason}`, required: false }
      : previousDirect.has(name)
        ? {
            reason: previousReason ?? selection?.reason ?? 'Preserved from parent plan.',
            required: true,
          }
        : selection;
    if (wantsExpansion && expansionSlots <= 0) {
      deferredCandidates.push({ candidate, reason: 'Deferred by the one-step expansion limit.' });
      omissions.push(
        omission(name, 'expansion_limit', 'Capability expansion tool limit was reached.')
      );
      continue;
    }

    if (reason) {
      const budgetFailure = directBudgetFailure(input.budgets, direct, candidate);
      if (!budgetFailure) {
        direct.push(candidate);
        directReasons.set(name, reason.reason);
        if (wantsExpansion) {
          expansionSlots--;
          selectedExpansionIds.push(name);
        }
        continue;
      }
      if (reason.required) {
        throw new CapabilityCompilerError(
          'ORION_CAPABILITY_REQUIRED_BUDGET',
          `Required capability ${name} exceeds ${budgetFailure.replace(/_/gu, ' ')}.`
        );
      }
      deferredCandidates.push({ candidate, reason: `Deferred by ${budgetFailure}.` });
      omissions.push(omission(name, budgetFailure, `Direct ${budgetFailure} was reached.`));
      continue;
    }

    deferredCandidates.push({
      candidate,
      reason:
        candidate.tier === 'long_tail' || candidate.source === 'mcp'
          ? 'Deferred long-tail capability.'
          : 'Deferred until task relevance is established.',
    });
  }

  if (options.expansion) {
    const directNames = new Set(direct.map(candidate => candidate.descriptor.name));
    for (const rawId of options.expansion.requestedRawIds) {
      const candidate = catalog.byLookup.get(normalizeLookup(rawId));
      if (!candidate) {
        omissions.push(
          omission(rawId, 'expansion_not_deferred', 'Expansion requested an unknown capability.')
        );
      } else if (
        options.expansion.previous.plan.direct.some(item => item.id === candidate.descriptor.name)
      ) {
        omissions.push(
          omission(candidate.descriptor.name, 'already_direct', 'Capability was already direct.')
        );
      } else if (!previousDeferred.has(candidate.descriptor.name)) {
        omissions.push(
          omission(
            candidate.descriptor.name,
            'expansion_not_deferred',
            'Only capabilities from the parent deferred lane can be expanded.'
          )
        );
      } else if (!directNames.has(candidate.descriptor.name)) {
        // The precise budget or authority omission was recorded above.
      }
    }
  }

  const deferred = deferredCandidates.slice(0, input.budgets.maxDeferredTools);
  for (const omittedCandidate of deferredCandidates.slice(input.budgets.maxDeferredTools)) {
    omissions.push(
      omission(
        omittedCandidate.candidate.descriptor.name,
        'deferred_tool_budget',
        'Deferred capability summary budget was reached.'
      )
    );
  }
  const deferredReasons = new Map(
    deferred.map(entry => [entry.candidate.descriptor.name, entry.reason] as const)
  );

  const sortedDirect = direct.sort((left, right) =>
    compare(left.descriptor.name, right.descriptor.name)
  );
  return {
    direct: sortedDirect,
    directReasons,
    deferred: deferred.map(entry => entry.candidate),
    deferredReasons,
    hidden: hidden.sort((left, right) => compare(left.id, right.id)),
    omissions: normalizeOmissions(omissions),
    selectedExpansionIds: uniqueSorted(selectedExpansionIds),
  };
}

function directBudgetFailure(
  budgets: CapabilityBudgetsV1,
  selected: readonly CapabilityToolCandidateV1[],
  candidate: CapabilityToolCandidateV1
): 'direct_tool_budget' | 'tool_schema_budget' | undefined {
  if (selected.length + 1 > budgets.maxDirectTools) return 'direct_tool_budget';
  if (toolSchemaBytes([...selected, candidate]) > budgets.maxToolSchemaBytes) {
    return 'tool_schema_budget';
  }
  return undefined;
}

function authorityDenial(
  input: CapabilityCompilerInputV1,
  candidate: CapabilityToolCandidateV1
): string | undefined {
  if (!input.model.toolCalling) return 'Model does not support tool calling.';
  const hardDeny = input.hardDeniedTools?.find(
    denied => normalizeLookup(denied.id) === normalizeLookup(candidate.descriptor.name)
  );
  if (hardDeny) return hardDeny.reason.trim() || 'Capability is hard denied by Authority.';

  const risk = candidate.descriptor.risk;
  if (risk.network === 'read' && input.authority.network === 'deny') {
    return 'Authority denies network reads.';
  }
  if (risk.network === 'write' && input.authority.network !== 'write') {
    return 'Authority denies network writes.';
  }
  if (
    input.authority.confirmation === 'deny' &&
    (risk.destructive || risk.fileEdit || risk.effect.includes('write'))
  ) {
    return 'Authority denies mutating capabilities.';
  }
  return undefined;
}

function denialCode(input: CapabilityCompilerInputV1): 'model_unsupported' | 'authority_denied' {
  return input.model.toolCalling ? 'authority_denied' : 'model_unsupported';
}

function createRouterDigests(tools: readonly CapabilityToolCandidateV1[]): RouterDigests {
  const descriptors = tools.map(candidate => candidate.descriptor);
  const visibleSchemas = descriptors.map(descriptor => ({
    type: 'function' as const,
    function: {
      name: descriptor.name,
      description: descriptor.description,
      parameters: descriptor.inputSchema,
    },
  }));
  const toolSchemaDigest = digestRuntimeValue(visibleSchemas);
  const toolBindingDigest = digestRuntimeValue(
    descriptors.map(descriptor => ({
      name: descriptor.name,
      aliases: descriptor.aliases,
      schemaDigest: descriptor.schemaDigest,
      executorId: descriptor.executorId,
      risk: descriptor.risk,
    }))
  );
  return {
    toolSchemaDigest,
    toolBindingDigest,
    toolRouterDigest: digestRuntimeValue({
      version: 1,
      visibleSchemaDigest: toolSchemaDigest,
      bindingDigest: toolBindingDigest,
    }),
    toolSchemaBytes: Buffer.byteLength(canonicalRuntimeJson(visibleSchemas), 'utf8'),
  };
}

function toolSchemaBytes(tools: readonly CapabilityToolCandidateV1[]): number {
  return createRouterDigests(tools).toolSchemaBytes;
}

function selectMcpBindings(
  catalog: NormalizedCatalog,
  plan: CapabilityPlanV1
): readonly CapabilityMcpBindingSelectionV1[] {
  const direct = new Set(plan.direct.map(item => item.id));
  const deferred = new Set(plan.deferred.map(item => item.id));
  return freeze(
    catalog.tools
      .filter(
        candidate =>
          candidate.source === 'mcp' &&
          (direct.has(candidate.descriptor.name) || deferred.has(candidate.descriptor.name))
      )
      .map(candidate => ({
        id: candidate.bindingId,
        serverId: candidate.mcp!.serverId,
        toolName: candidate.descriptor.name,
        bindingDigest: candidate.mcp!.bindingDigest,
        direct: direct.has(candidate.descriptor.name),
      }))
  );
}

function createExpansionReceipt(
  input: CapabilityCompilerInputV1,
  expansion: NonNullable<CompileOptions['expansion']>,
  selectedIds: readonly string[]
): CapabilityExpansionReceiptV1 {
  const selected = new Set(selectedIds);
  const content = {
    parentPlanDigest: expansion.previous.plan.digest,
    parentReceiptDigest: expansion.previous.receipt.digest,
    reason: expansion.reason,
    requestedToolIds: expansion.requestedRawIds,
    selectedToolIds: [...selected].sort(compare),
    omittedToolIds: expansion.requestedCanonicalIds.filter(id => !selected.has(id)).sort(compare),
    maxExpansionTools: input.budgets.maxExpansionTools,
  };
  return freeze({ ...content, digest: digestRuntimeValue(content) });
}

function createReceipt(params: {
  readonly input: CapabilityCompilerInputV1;
  readonly receiptIdentity: CapabilityReceiptIdentityV1;
  readonly plan: CapabilityPlanV1;
  readonly catalog: NormalizedCatalog;
  readonly selectedSkills: readonly CapabilitySkillSelectionV1[];
  readonly selectedMcpBindings: readonly CapabilityMcpBindingSelectionV1[];
  readonly omissions: readonly CapabilityOmissionV1[];
  readonly routerDigests: RouterDigests;
  readonly expansion?: CapabilityExpansionReceiptV1;
}): CapabilityReceiptV1 {
  const hiddenToolReasons = Object.fromEntries(
    params.plan.hidden.map(item => [item.id, item.reason])
  );
  const loadedSkillDigests = Object.fromEntries(
    params.selectedSkills.filter(skill => skill.loaded).map(skill => [skill.id, skill.digest])
  );
  const selectedMcpBindings = [...params.selectedMcpBindings];
  const taskSignalsDigest = digestRuntimeValue(normalizeTaskSignals(params.input));
  const modelSupportDigest = digestRuntimeValue(params.input.model);
  const hardDenyDigest = digestRuntimeValue(normalizeHardDenies(params.input));
  const budgets = { ...params.input.budgets };
  const budgetDigest = digestRuntimeValue(budgets);
  const content = {
    version: 1 as const,
    compilerVersion: CAPABILITY_COMPILER_VERSION,
    ...params.receiptIdentity,
    taskContextRevision: params.input.taskContextRevision,
    taskSignalsDigest,
    modelSupportDigest,
    planDigest: params.plan.digest,
    runtimeServicesDigest: params.input.runtimeServicesDigest,
    toolCatalogDigest: params.catalog.toolCatalogDigest,
    toolSchemaDigest: params.routerDigests.toolSchemaDigest,
    toolBindingDigest: params.routerDigests.toolBindingDigest,
    toolRouterDigest: params.routerDigests.toolRouterDigest,
    directToolNames: params.plan.direct.map(item => item.id),
    deferredToolNames: params.plan.deferred.map(item => item.id),
    hiddenToolReasons,
    skillCatalogDigest: params.input.skillCatalogDigest,
    selectedSkillIds: params.selectedSkills.map(skill => skill.id),
    loadedSkillDigests,
    mcpCatalogDigest: params.input.mcpCatalogDigest,
    mcpBindingDigest: digestRuntimeValue({
      catalogDigest: params.input.mcpCatalogDigest,
      selected: selectedMcpBindings,
    }),
    selectedMcpBindings,
    promptManifest: [...(params.input.promptManifest ?? [])],
    authorityDigest: params.input.authority.digest,
    hardDenyDigest,
    executionPolicyDigest: params.input.executionPolicyDigest,
    budgets,
    budgetDigest,
    omitted: [...params.omissions],
    expansion: params.expansion,
    estimatedInputTokens: params.input.estimatedInputTokens,
    actualPromptTokens: params.input.actualPromptTokens,
    toolSchemaBytes: params.routerDigests.toolSchemaBytes,
    createdAt: params.receiptIdentity.createdAt,
  };
  return freeze({ ...content, digest: digestRuntimeValue(content) });
}

function validateExpansionParent(
  input: CapabilityCompilerInputV1,
  expansion: CapabilityExpansionRequestV1
): void {
  if (expansion.previous.receipt.expansion || !expansion.previous.plan.expansionAllowed) {
    throw new CapabilityCompilerError(
      'ORION_CAPABILITY_EXPANSION_EXHAUSTED',
      'CapabilityPlanV1 permits at most one bounded expansion.'
    );
  }
  if (!expansion.reason.trim()) {
    throw new CapabilityCompilerError(
      'ORION_CAPABILITY_EXPANSION_INVALID',
      'Capability expansion requires a reason.'
    );
  }
  if (
    expansion.previous.receipt.threadId !== input.receipt.threadId ||
    expansion.previous.receipt.turnId !== input.receipt.turnId ||
    expansion.previous.receipt.authorityDigest !== input.authority.digest ||
    expansion.previous.receipt.runtimeServicesDigest !== input.runtimeServicesDigest ||
    expansion.previous.receipt.executionPolicyDigest !== input.executionPolicyDigest ||
    expansion.previous.receipt.skillCatalogDigest !== input.skillCatalogDigest ||
    expansion.previous.receipt.mcpCatalogDigest !== input.mcpCatalogDigest ||
    expansion.previous.receipt.taskContextRevision !== input.taskContextRevision ||
    expansion.previous.receipt.taskSignalsDigest !==
      digestRuntimeValue(normalizeTaskSignals(input)) ||
    expansion.previous.receipt.modelSupportDigest !== digestRuntimeValue(input.model) ||
    expansion.previous.receipt.hardDenyDigest !== digestRuntimeValue(normalizeHardDenies(input)) ||
    expansion.previous.receipt.budgetDigest !== digestRuntimeValue(input.budgets) ||
    expansion.previous.receipt.toolCatalogDigest !== normalizeCatalog(input).toolCatalogDigest
  ) {
    throw new CapabilityCompilerError(
      'ORION_CAPABILITY_INPUT_DRIFT',
      'Capability expansion inputs drifted from the parent plan; recompile the turn instead.'
    );
  }
  if (
    expansion.receipt.threadId !== input.receipt.threadId ||
    expansion.receipt.turnId !== input.receipt.turnId
  ) {
    throw new CapabilityCompilerError(
      'ORION_CAPABILITY_EXPANSION_INVALID',
      'Capability expansion must remain in the parent thread and turn.'
    );
  }
}

function omission(
  id: string,
  code: CapabilityOmissionCodeV1,
  reason: string
): CapabilityOmissionV1 {
  return { id: id.trim(), code, reason };
}

function normalizeOmissions(omissions: readonly CapabilityOmissionV1[]): CapabilityOmissionV1[] {
  const unique = new Map<string, CapabilityOmissionV1>();
  for (const entry of omissions) {
    unique.set(`${entry.id}\u0000${entry.code}\u0000${entry.reason}`, entry);
  }
  return [...unique.values()].sort(
    (left, right) => compare(left.id, right.id) || compare(left.code, right.code)
  );
}

function normalizedTaskText(input: CapabilityCompilerInputV1): string {
  return normalizeLookup(
    [input.task.objective, input.task.activeInstruction, ...(input.task.criteria ?? [])]
      .filter(Boolean)
      .join(' ')
  );
}

function normalizeTaskSignals(input: CapabilityCompilerInputV1): Record<string, unknown> {
  return {
    objective: input.task.objective.trim(),
    criteria: uniqueSorted(input.task.criteria ?? []),
    activeInstruction: input.task.activeInstruction?.trim(),
    explicitToolIds: normalizeStrings(input.task.explicitToolIds ?? []),
    explicitSkillIds: normalizeStrings(input.task.explicitSkillIds ?? []),
    explicitMcpToolIds: normalizeStrings(input.task.explicitMcpToolIds ?? []),
  };
}

function normalizeHardDenies(
  input: CapabilityCompilerInputV1
): readonly CapabilityHardDenyDigest[] {
  return [...(input.hardDeniedTools ?? [])]
    .map(denied => ({ id: normalizeLookup(denied.id), reason: denied.reason.trim() }))
    .sort((left, right) => compare(left.id, right.id));
}

interface CapabilityHardDenyDigest {
  readonly id: string;
  readonly reason: string;
}

function matchesTask(terms: readonly string[], normalizedText: string): boolean {
  return terms.some(term => {
    const normalized = normalizeLookup(term);
    return normalized.length > 1 && ` ${normalizedText} `.includes(` ${normalized} `);
  });
}

function normalizeLookup(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeStrings(values: readonly string[]): string[] {
  return uniqueSorted(values.map(value => value.trim()).filter(Boolean));
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].sort(compare);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function catalogError(message: string): never {
  throw new CapabilityCompilerError('ORION_CAPABILITY_CATALOG_INVALID', message);
}

function freeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) freeze(nested);
  return Object.freeze(value);
}
