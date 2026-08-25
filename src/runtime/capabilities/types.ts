import type {
  AgentBaseModeV1,
  AuthoritySnapshotV1,
  CapabilityPlanV1,
  ToolBindingDescriptorV1,
} from '../step-snapshot';

export type CapabilityToolTierV1 = 'core' | 'standard' | 'long_tail';
export type CapabilityToolSourceV1 = 'builtin' | 'first_party' | 'skill' | 'mcp';

export interface CapabilityMcpSourceV1 {
  readonly serverId: string;
  readonly bindingDigest: string;
}

/** One exact descriptor/executor identity exposed by the static tool catalog. */
export interface CapabilityToolCandidateV1 {
  readonly bindingId: string;
  readonly descriptor: ToolBindingDescriptorV1;
  readonly tier: CapabilityToolTierV1;
  readonly source: CapabilityToolSourceV1;
  readonly keywords?: readonly string[];
  readonly mcp?: CapabilityMcpSourceV1;
}

export interface CapabilitySkillCandidateV1 {
  readonly id: string;
  readonly digest: string;
  readonly description: string;
  readonly keywords?: readonly string[];
  readonly requestedCapabilities: readonly string[];
  /** A loaded definition contributes only its digest to receipts, never its body. */
  readonly loaded?: boolean;
}

export interface CapabilityTaskSignalsV1 {
  readonly objective: string;
  readonly criteria?: readonly string[];
  readonly activeInstruction?: string;
  readonly explicitToolIds?: readonly string[];
  readonly explicitSkillIds?: readonly string[];
  readonly explicitMcpToolIds?: readonly string[];
}

export interface CapabilityModelSupportV1 {
  readonly toolCalling: boolean;
}

export interface CapabilityBudgetsV1 {
  readonly maxDirectTools: number;
  readonly maxToolSchemaBytes: number;
  readonly maxDeferredTools: number;
  readonly maxExpansionTools: number;
}

export interface CapabilityHardDenyV1 {
  readonly id: string;
  readonly reason: string;
}

export interface CapabilityPromptSectionReceiptV1 {
  readonly id: string;
  readonly digest: string;
  readonly selected: boolean;
  readonly reason?: string;
}

export interface CapabilityReceiptIdentityV1 {
  readonly requestId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly durableCommitId: string;
  readonly createdAt: number;
}

export interface CapabilityCompilerInputV1 {
  readonly baseMode: AgentBaseModeV1;
  readonly taskContextRevision: number;
  readonly task: CapabilityTaskSignalsV1;
  readonly model: CapabilityModelSupportV1;
  readonly authority: AuthoritySnapshotV1;
  readonly hardDeniedTools?: readonly CapabilityHardDenyV1[];
  readonly budgets: CapabilityBudgetsV1;
  readonly tools: readonly CapabilityToolCandidateV1[];
  readonly skills?: readonly CapabilitySkillCandidateV1[];
  readonly receipt: CapabilityReceiptIdentityV1;
  readonly runtimeServicesDigest: string;
  readonly executionPolicyDigest: string;
  readonly skillCatalogDigest: string;
  readonly mcpCatalogDigest: string;
  readonly promptManifest?: readonly CapabilityPromptSectionReceiptV1[];
  readonly estimatedInputTokens: number;
  readonly actualPromptTokens?: number;
}

export type CapabilityOmissionCodeV1 =
  | 'direct_tool_budget'
  | 'tool_schema_budget'
  | 'deferred_tool_budget'
  | 'authority_denied'
  | 'model_unsupported'
  | 'unknown_explicit_tool'
  | 'unknown_explicit_skill'
  | 'unknown_explicit_mcp_tool'
  | 'skill_capability_unavailable'
  | 'expansion_limit'
  | 'expansion_not_deferred'
  | 'already_direct';

export interface CapabilityOmissionV1 {
  readonly id: string;
  readonly code: CapabilityOmissionCodeV1;
  readonly reason: string;
}

export interface CapabilityToolBindingSelectionV1 {
  readonly bindingId: string;
  readonly descriptor: ToolBindingDescriptorV1;
  readonly reason: string;
}

export interface DeferredCapabilitySummaryV1 {
  readonly id: string;
  readonly description: string;
  readonly source: CapabilityToolSourceV1;
  readonly reason: string;
}

export interface CapabilitySkillSelectionV1 {
  readonly id: string;
  readonly digest: string;
  readonly loaded: boolean;
  readonly reason: string;
  readonly requestedCapabilities: readonly string[];
}

export interface CapabilityMcpBindingSelectionV1 {
  readonly id: string;
  readonly serverId: string;
  readonly toolName: string;
  readonly bindingDigest: string;
  readonly direct: boolean;
}

export interface CapabilityExpansionReceiptV1 {
  readonly parentPlanDigest: string;
  readonly parentReceiptDigest: string;
  readonly reason: string;
  readonly requestedToolIds: readonly string[];
  readonly selectedToolIds: readonly string[];
  readonly omittedToolIds: readonly string[];
  readonly maxExpansionTools: number;
  readonly digest: string;
}

export interface CapabilityReceiptV1 {
  readonly version: 1;
  readonly compilerVersion: string;
  readonly requestId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly durableCommitId: string;
  readonly taskContextRevision: number;
  readonly taskSignalsDigest: string;
  readonly modelSupportDigest: string;
  readonly planDigest: string;
  readonly runtimeServicesDigest: string;
  readonly toolCatalogDigest: string;
  readonly toolSchemaDigest: string;
  readonly toolBindingDigest: string;
  readonly toolRouterDigest: string;
  readonly directToolNames: readonly string[];
  readonly deferredToolNames: readonly string[];
  readonly hiddenToolReasons: Readonly<Record<string, string>>;
  readonly skillCatalogDigest: string;
  readonly selectedSkillIds: readonly string[];
  readonly loadedSkillDigests: Readonly<Record<string, string>>;
  readonly mcpCatalogDigest: string;
  readonly mcpBindingDigest: string;
  readonly selectedMcpBindings: readonly CapabilityMcpBindingSelectionV1[];
  readonly promptManifest: readonly CapabilityPromptSectionReceiptV1[];
  readonly authorityDigest: string;
  readonly hardDenyDigest: string;
  readonly executionPolicyDigest: string;
  readonly budgets: CapabilityBudgetsV1;
  readonly budgetDigest: string;
  readonly omitted: readonly CapabilityOmissionV1[];
  readonly expansion?: CapabilityExpansionReceiptV1;
  readonly estimatedInputTokens: number;
  readonly actualPromptTokens?: number;
  readonly toolSchemaBytes: number;
  readonly createdAt: number;
  readonly digest: string;
}

export interface CapabilityCompilationV1 {
  readonly plan: CapabilityPlanV1;
  readonly directToolBindings: readonly CapabilityToolBindingSelectionV1[];
  readonly deferredTools: readonly DeferredCapabilitySummaryV1[];
  readonly selectedSkills: readonly CapabilitySkillSelectionV1[];
  readonly selectedMcpBindings: readonly CapabilityMcpBindingSelectionV1[];
  readonly receipt: CapabilityReceiptV1;
}

export interface CapabilityExpansionRequestV1 {
  readonly previous: CapabilityCompilationV1;
  readonly requestedToolIds: readonly string[];
  readonly reason: string;
  readonly receipt: CapabilityReceiptIdentityV1;
}
