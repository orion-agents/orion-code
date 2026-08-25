export const PROMPT_REGISTRY_VERSION = 1 as const;

export type PromptAuthorityV1 =
  | 'system'
  | 'developer'
  | 'project'
  | 'user'
  | 'tool'
  | 'session'
  | 'runtime';

export type PromptContributorKindV1 =
  | 'task_context'
  | 'skill'
  | 'memory'
  | 'project'
  | 'goal'
  | 'subagent'
  | 'mode';

export type PromptCacheabilityV1 = 'cacheable' | 'non_cacheable';
export type PromptRedactionPolicyV1 = 'none' | 'secrets';

export type PromptDeclaredOmissionReasonV1 =
  | 'not_selected_by_plan'
  | 'source_unavailable'
  | 'authority_denied'
  | 'not_applicable';

export type PromptSelectionReasonV1 =
  | 'mandatory'
  | 'selected_by_priority'
  | PromptDeclaredOmissionReasonV1
  | 'section_token_budget_exceeded'
  | 'global_token_budget_exceeded';

export interface PromptSectionSourceV1 {
  /** Stable logical source id, never a filesystem path. */
  readonly id: string;
  /** SHA-256 of the source revision or render input. */
  readonly digest: string;
}

export interface PromptSectionInputV1 {
  readonly id: string;
  readonly authority: PromptAuthorityV1;
  readonly source: PromptSectionSourceV1;
  /** Higher priority optional sections are admitted first. */
  readonly priority: number;
  /** Hard per-section budget. V1 never truncates section content. */
  readonly tokenBudget: number;
  readonly mandatory: boolean;
  readonly atomic: boolean;
  readonly dynamic: boolean;
  readonly cacheability: PromptCacheabilityV1;
  readonly redaction: PromptRedactionPolicyV1;
  readonly content: string;
  /** False means the capability/prompt plan omitted this contribution before budgeting. */
  readonly enabled?: boolean;
  readonly omissionReason?: PromptDeclaredOmissionReasonV1;
}

/** Explicit first-party slots avoid turning Prompt Registry into a plugin/service locator. */
export interface PromptContributorInputsV1 {
  readonly taskContext?: readonly PromptSectionInputV1[];
  readonly skill?: readonly PromptSectionInputV1[];
  readonly memory?: readonly PromptSectionInputV1[];
  readonly project?: readonly PromptSectionInputV1[];
  readonly goal?: readonly PromptSectionInputV1[];
  readonly subagent?: readonly PromptSectionInputV1[];
  readonly mode?: readonly PromptSectionInputV1[];
}

export interface PromptAssemblyRequestV1 {
  readonly hardTokenBudget: number;
  readonly contributors: PromptContributorInputsV1;
}

export interface SelectedPromptSectionV1 {
  readonly id: string;
  readonly authority: PromptAuthorityV1;
  readonly contributor: PromptContributorKindV1;
  readonly sourceId: string;
  readonly sourceDigest: string;
  readonly priority: number;
  readonly tokenBudget: number;
  readonly estimatedTokens: number;
  readonly mandatory: boolean;
  readonly atomic: boolean;
  readonly dynamic: boolean;
  readonly cacheability: PromptCacheabilityV1;
  readonly cacheablePrefix: boolean;
  readonly redaction: PromptRedactionPolicyV1;
  readonly redactionApplied: boolean;
  readonly contentDigest: string;
  /** The only output object that contains model-visible section text. */
  readonly content: string;
}

export interface PromptSectionReceiptV1 {
  readonly id: string;
  readonly authority: PromptAuthorityV1;
  readonly contributor: PromptContributorKindV1;
  readonly sourceId: string;
  readonly sourceDigest: string;
  readonly priority: number;
  readonly tokenBudget: number;
  readonly estimatedTokens: number;
  readonly mandatory: boolean;
  readonly atomic: boolean;
  readonly dynamic: boolean;
  readonly cacheability: PromptCacheabilityV1;
  readonly cacheablePrefix: boolean;
  readonly redaction: PromptRedactionPolicyV1;
  readonly redactionApplied: boolean;
  readonly selected: boolean;
  readonly reason: PromptSelectionReasonV1;
  readonly contentDigest: string;
}

export interface PromptCacheablePrefixV1 {
  readonly sectionIds: readonly string[];
  readonly estimatedTokens: number;
  readonly digest: string;
  readonly text: string;
}

/** Durable receipt: hashes and safe ids only; no section body, secret, or filesystem path. */
export interface PromptAssemblyReceiptV1 {
  readonly version: 1;
  readonly hardTokenBudget: number;
  readonly estimatedTokens: number;
  readonly selectedSectionIds: readonly string[];
  readonly omittedSectionIds: readonly string[];
  readonly sections: readonly PromptSectionReceiptV1[];
  readonly promptDigest: string;
  readonly cacheablePrefixDigest: string;
  readonly digest: string;
}

export interface PromptAssemblyV1 {
  readonly version: 1;
  readonly text: string;
  readonly sections: readonly SelectedPromptSectionV1[];
  readonly cacheablePrefix: PromptCacheablePrefixV1;
  readonly receipt: PromptAssemblyReceiptV1;
}
