export const LAZY_SKILL_RUNTIME_VERSION = 1 as const;

export type SkillSourceScopeV1 = 'builtin' | 'user' | 'configured' | 'project' | 'remote';
export type SkillInvocationActorV1 = 'model' | 'user';

/** Highest-priority source first. */
export const DEFAULT_SKILL_SOURCE_SCOPE_ORDER: readonly SkillSourceScopeV1[] = Object.freeze([
  'project',
  'configured',
  'user',
  'builtin',
  'remote',
]);

export interface SkillScopeV1 {
  readonly id: string;
  /** Sources absent from this list are outside the catalog scope. */
  readonly sourceScopeOrder?: readonly SkillSourceScopeV1[];
  /** Optional provider allowlist for an isolated agent or project scope. */
  readonly providerIds?: readonly string[];
}

/** Safe summary metadata. It deliberately has no body, resource path, or trigger implementation. */
export interface SkillDescriptorV1 {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly providerId: string;
  readonly sourceScope: SkillSourceScopeV1;
  readonly modelInvocable: boolean;
  readonly userInvocable: boolean;
  readonly requestedCapabilities: readonly string[];
  /** Revision digest shared with the definition returned by the provider. */
  readonly digest: string;
}

export interface SkillResourceDescriptorV1 {
  readonly path: string;
  readonly digest: string;
  readonly bytes: number;
  readonly mediaType?: string;
}

export interface SkillDefinitionV1 extends SkillDescriptorV1 {
  readonly body: string;
  readonly resourceManifest: readonly SkillResourceDescriptorV1[];
}

export interface SkillResourceV1 {
  readonly skillId: string;
  readonly path: string;
  readonly digest: string;
  readonly content: string | Uint8Array;
  readonly mediaType?: string;
}

export interface SkillObservationV1 {
  readonly version: 1;
  readonly providerId: string;
  /** Digest of the provider's complete descriptor observation. */
  readonly digest: string;
  /** Incomplete observations can be returned but are never treated as stable cache state. */
  readonly complete: boolean;
  readonly descriptors: readonly SkillDescriptorV1[];
}

export interface SkillInvalidationV1 {
  readonly providerId: string;
  readonly reason: string;
  readonly nextDigest?: string;
}

export interface SkillProviderSubscriptionV1 {
  dispose(): void | Promise<void>;
}

export interface SkillProviderV1 {
  readonly id: string;
  list(scope: SkillScopeV1, signal: AbortSignal): Promise<SkillObservationV1>;
  get(id: string, signal: AbortSignal): Promise<SkillDefinitionV1 | undefined>;
  getResource(id: string, path: string, signal: AbortSignal): Promise<SkillResourceV1>;
  subscribe?(
    invalidate: (invalidation: SkillInvalidationV1) => void,
    signal: AbortSignal
  ): SkillProviderSubscriptionV1;
}

export interface SkillProviderObservationReceiptV1 {
  readonly providerId: string;
  readonly digest: string;
  readonly complete: boolean;
  readonly descriptorCount: number;
}

export interface SkillShadowDiagnosticV1 {
  readonly name: string;
  readonly selected: {
    readonly id: string;
    readonly providerId: string;
    readonly sourceScope: SkillSourceScopeV1;
  };
  readonly shadowed: {
    readonly id: string;
    readonly providerId: string;
    readonly sourceScope: SkillSourceScopeV1;
  };
  readonly reason: string;
}

export interface SkillCatalogV1 {
  readonly version: 1;
  readonly scopeId: string;
  readonly sourceScopeOrder: readonly SkillSourceScopeV1[];
  readonly descriptors: readonly SkillDescriptorV1[];
  readonly observations: readonly SkillProviderObservationReceiptV1[];
  readonly shadowDiagnostics: readonly SkillShadowDiagnosticV1[];
  readonly digest: string;
}

export interface SkillAuthorityV1 {
  readonly authorityId: string;
  readonly digest: string;
  readonly allowedCapabilities: readonly string[];
  readonly deniedCapabilityReasons?: Readonly<Record<string, string>>;
}

/** Durable metadata for a selection. It deliberately excludes definition body and resources. */
export interface SkillAuthorityReceiptV1 {
  readonly version: 1;
  readonly skillId: string;
  readonly skillName: string;
  readonly providerId: string;
  readonly sourceScope: SkillSourceScopeV1;
  readonly descriptorDigest: string;
  readonly catalogDigest: string;
  readonly actor: SkillInvocationActorV1;
  readonly reason: string;
  readonly requestedCapabilities: readonly string[];
  readonly grantedCapabilities: readonly string[];
  readonly omittedCapabilityReasons: Readonly<Record<string, string>>;
  readonly authorityId: string;
  readonly authorityDigest: string;
  readonly digest: string;
}

export interface LoadedSkillDefinitionV1 {
  readonly definition: SkillDefinitionV1;
  readonly receipt: SkillAuthorityReceiptV1;
}

export interface SkillDefinitionLoadRequestV1 {
  readonly catalog: SkillCatalogV1;
  readonly skillId: string;
  readonly actor: SkillInvocationActorV1;
  readonly reason: string;
  readonly authority: SkillAuthorityV1;
  readonly signal?: AbortSignal;
}

export interface SkillResourceLoadRequestV1 {
  readonly selection: LoadedSkillDefinitionV1;
  readonly path: string;
  readonly signal?: AbortSignal;
}
