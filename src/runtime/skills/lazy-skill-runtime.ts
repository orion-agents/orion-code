import { Buffer } from 'buffer';
import { digestRuntimeValue } from '../protocol/canonical';
import { BoundedLruCache, type BoundedLruCacheStats } from './bounded-lru-cache';
import {
  DEFAULT_SKILL_SOURCE_SCOPE_ORDER,
  LAZY_SKILL_RUNTIME_VERSION,
  type LoadedSkillDefinitionV1,
  type SkillAuthorityReceiptV1,
  type SkillCatalogV1,
  type SkillDefinitionLoadRequestV1,
  type SkillDefinitionV1,
  type SkillDescriptorV1,
  type SkillInvalidationV1,
  type SkillObservationV1,
  type SkillProviderObservationReceiptV1,
  type SkillProviderSubscriptionV1,
  type SkillProviderV1,
  type SkillResourceDescriptorV1,
  type SkillResourceLoadRequestV1,
  type SkillResourceV1,
  type SkillScopeV1,
  type SkillShadowDiagnosticV1,
  type SkillSourceScopeV1,
} from './types';

const MAX_CATALOG_DESCRIPTION_CHARS = 240;
const DEFAULT_DEFINITION_CACHE = Object.freeze({
  maxEntries: 32,
  maxBytes: 2 * 1024 * 1024,
  ttlMs: 5 * 60 * 1000,
});
const DEFAULT_RESOURCE_CACHE = Object.freeze({
  maxEntries: 64,
  maxBytes: 8 * 1024 * 1024,
  ttlMs: 5 * 60 * 1000,
});

export interface LazySkillCacheOptions {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly ttlMs?: number;
}

export interface LazySkillRuntimeOptions {
  readonly providers: readonly SkillProviderV1[];
  readonly definitionCache?: LazySkillCacheOptions;
  readonly resourceCache?: LazySkillCacheOptions;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

export interface LazySkillRuntimeStatsV1 {
  readonly definitionCache: BoundedLruCacheStats;
  readonly resourceCache: BoundedLruCacheStats;
  readonly definitionLoadsInFlight: number;
  readonly resourceLoadsInFlight: number;
  readonly providerGenerations: Readonly<Record<string, number>>;
}

interface ProviderState {
  readonly generation: number;
  readonly observed: boolean;
  readonly complete: boolean;
  readonly digest?: string;
  readonly descriptorDigests: ReadonlyMap<string, string>;
}

interface CatalogDescriptorCandidate {
  readonly descriptor: SkillDescriptorV1;
  readonly scopeRank: number;
}

interface LinkedSignal {
  readonly signal: AbortSignal;
  dispose(): void;
}

export class LazySkillRuntimeError extends Error {
  readonly code: string = 'ORION_LAZY_SKILL_RUNTIME_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'LazySkillRuntimeError';
  }
}

export class StaleSkillCatalogError extends LazySkillRuntimeError {
  override readonly code = 'ORION_STALE_SKILL_CATALOG';

  constructor(providerId: string) {
    super(`Skill catalog is stale for provider ${providerId}; observe the provider again.`);
    this.name = 'StaleSkillCatalogError';
  }
}

export class SkillInvocationDeniedError extends LazySkillRuntimeError {
  override readonly code = 'ORION_SKILL_INVOCATION_DENIED';

  constructor(skillId: string, actor: 'model' | 'user') {
    super(`Skill ${skillId} is not invocable by ${actor}.`);
    this.name = 'SkillInvocationDeniedError';
  }
}

export class StaleSkillLoadError extends LazySkillRuntimeError {
  override readonly code = 'ORION_STALE_SKILL_LOAD';

  constructor(providerId: string, skillId: string) {
    super(`Skill ${skillId} changed while loading from provider ${providerId}.`);
    this.name = 'StaleSkillLoadError';
  }
}

/**
 * Descriptor-first runtime for Skills.
 *
 * Observation exposes only bounded descriptors. Definition and resource IO are
 * explicit, authority-scoped operations with digest-bound caches and receipts.
 */
export class LazySkillRuntime {
  readonly version = LAZY_SKILL_RUNTIME_VERSION;

  private readonly providers: ReadonlyMap<string, SkillProviderV1>;
  private readonly providerStates = new Map<string, ProviderState>();
  private readonly definitionCache: BoundedLruCache<SkillDefinitionV1>;
  private readonly resourceCache: BoundedLruCache<SkillResourceV1>;
  private readonly definitionFlights = new Map<string, Promise<SkillDefinitionV1>>();
  private readonly resourceFlights = new Map<string, Promise<SkillResourceV1>>();
  private readonly lifecycleController = new AbortController();
  private readonly subscriptions: SkillProviderSubscriptionV1[] = [];
  private readonly detachParentSignal?: () => void;
  private disposed = false;

  constructor(options: LazySkillRuntimeOptions) {
    const providerMap = new Map<string, SkillProviderV1>();
    for (const provider of options.providers) {
      const providerId = validateIdentifier(provider.id, 'Skill provider id');
      if (providerMap.has(providerId)) {
        throw new LazySkillRuntimeError(`Duplicate Skill provider id: ${providerId}`);
      }
      providerMap.set(providerId, provider);
      this.providerStates.set(providerId, {
        generation: 0,
        observed: false,
        complete: false,
        descriptorDigests: new Map(),
      });
    }
    this.providers = providerMap;

    const now = options.now ?? Date.now;
    this.definitionCache = new BoundedLruCache({
      ...DEFAULT_DEFINITION_CACHE,
      ...options.definitionCache,
      sizeOf: definition => Buffer.byteLength(JSON.stringify(definition), 'utf8'),
      now,
    });
    this.resourceCache = new BoundedLruCache({
      ...DEFAULT_RESOURCE_CACHE,
      ...options.resourceCache,
      sizeOf: resource => resourceBytes(resource),
      now,
    });

    if (options.signal) {
      const abortFromParent = (): void => {
        if (!this.lifecycleController.signal.aborted) {
          this.lifecycleController.abort(options.signal?.reason);
        }
      };
      options.signal.addEventListener('abort', abortFromParent, { once: true });
      this.detachParentSignal = () => options.signal?.removeEventListener('abort', abortFromParent);
      if (options.signal.aborted) abortFromParent();
    }

    for (const provider of this.providers.values()) {
      if (!provider.subscribe) continue;
      const subscription = provider.subscribe(
        invalidation => this.handleInvalidation(provider.id, invalidation),
        this.lifecycleController.signal
      );
      this.subscriptions.push(subscription);
    }
  }

  /** Observe provider descriptors and compose the deterministic scope overlay. */
  async observe(scope: SkillScopeV1, signal?: AbortSignal): Promise<SkillCatalogV1> {
    this.assertActive();
    const normalizedScope = normalizeScope(scope);
    const providerIds = normalizedScope.providerIds
      ? new Set(normalizedScope.providerIds)
      : undefined;
    const selectedProviders = [...this.providers.values()]
      .filter(provider => !providerIds || providerIds.has(provider.id))
      .sort((left, right) => left.id.localeCompare(right.id));
    const linked = linkSignals(this.lifecycleController.signal, signal);

    try {
      throwIfAborted(linked.signal);
      const observations = await Promise.all(
        selectedProviders.map(async provider => {
          const observation = await provider.list(normalizedScope, linked.signal);
          return normalizeObservation(provider.id, observation, normalizedScope.sourceScopeOrder);
        })
      );
      throwIfAborted(linked.signal);

      for (const observation of observations) this.reconcileObservation(observation);
      return composeCatalog(normalizedScope, observations);
    } finally {
      linked.dispose();
    }
  }

  /** Load one selected definition and issue an authority-intersection receipt. */
  async getDefinition(request: SkillDefinitionLoadRequestV1): Promise<LoadedSkillDefinitionV1> {
    this.assertActive();
    const descriptor = request.catalog.descriptors.find(item => item.id === request.skillId);
    if (!descriptor) {
      throw new LazySkillRuntimeError(
        `Skill ${request.skillId} is not present in catalog ${request.catalog.digest}.`
      );
    }
    this.assertCatalogCurrent(request.catalog, descriptor.providerId);
    if (
      (request.actor === 'model' && !descriptor.modelInvocable) ||
      (request.actor === 'user' && !descriptor.userInvocable)
    ) {
      throw new SkillInvocationDeniedError(descriptor.id, request.actor);
    }

    const receipt = createAuthorityReceipt(request, descriptor);
    const definition = await this.loadDefinition(descriptor, request.catalog, request.signal);
    return deepFreeze({ definition, receipt });
  }

  /** Read one manifest-declared resource after its definition has been selected. */
  async getResource(request: SkillResourceLoadRequestV1): Promise<SkillResourceV1> {
    this.assertActive();
    const definition = request.selection.definition;
    assertSelectionIdentity(request.selection);
    const path = normalizeResourcePath(request.path);
    const resourceDescriptor = definition.resourceManifest.find(resource => resource.path === path);
    if (!resourceDescriptor) {
      throw new LazySkillRuntimeError(
        `Resource ${path} is not declared by Skill ${definition.id}.`
      );
    }

    const provider = this.providers.get(definition.providerId);
    if (!provider) {
      throw new LazySkillRuntimeError(`Unknown Skill provider: ${definition.providerId}`);
    }
    const state = this.requireObservedState(definition.providerId);
    if (state.descriptorDigests.get(definition.id) !== definition.digest) {
      throw new StaleSkillLoadError(definition.providerId, definition.id);
    }
    const key = resourceCacheKey(definition, resourceDescriptor);
    if (state.complete) {
      const cached = this.resourceCache.get(key);
      if (cached) return cloneResource(cached);
    }

    let flight = this.resourceFlights.get(key);
    if (!flight) {
      flight = this.startResourceLoad(provider, definition, resourceDescriptor, state);
      this.resourceFlights.set(key, flight);
      void flight.then(
        () => this.resourceFlights.delete(key),
        () => this.resourceFlights.delete(key)
      );
    }
    const resource = await waitForPromise(flight, request.signal);
    return cloneResource(resource);
  }

  /** Watchers call this indirectly; tests and explicit refresh paths may call it directly. */
  invalidateProvider(providerId: string, reason = 'provider_invalidated'): void {
    if (!this.providers.has(providerId)) {
      throw new LazySkillRuntimeError(`Unknown Skill provider: ${providerId}`);
    }
    const previous = this.providerStates.get(providerId);
    this.providerStates.set(providerId, {
      generation: (previous?.generation ?? 0) + 1,
      observed: false,
      complete: false,
      descriptorDigests: new Map(),
    });
    this.deleteProviderCacheEntries(providerId);
    void reason;
  }

  stats(): LazySkillRuntimeStatsV1 {
    return Object.freeze({
      definitionCache: this.definitionCache.stats(),
      resourceCache: this.resourceCache.stats(),
      definitionLoadsInFlight: this.definitionFlights.size,
      resourceLoadsInFlight: this.resourceFlights.size,
      providerGenerations: Object.freeze(
        Object.fromEntries(
          [...this.providerStates.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([providerId, state]) => [providerId, state.generation])
        )
      ),
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.detachParentSignal?.();
    if (!this.lifecycleController.signal.aborted) {
      this.lifecycleController.abort(new Error('Lazy Skill runtime disposed.'));
    }
    const subscriptions = this.subscriptions.splice(0).reverse();
    await Promise.allSettled(subscriptions.map(subscription => subscription.dispose()));
    this.definitionCache.clear();
    this.resourceCache.clear();
    this.providerStates.clear();
  }

  private async loadDefinition(
    descriptor: SkillDescriptorV1,
    catalog: SkillCatalogV1,
    signal?: AbortSignal
  ): Promise<SkillDefinitionV1> {
    const provider = this.providers.get(descriptor.providerId);
    if (!provider)
      throw new LazySkillRuntimeError(`Unknown Skill provider: ${descriptor.providerId}`);
    const state = this.requireObservedState(descriptor.providerId);
    const key = definitionCacheKey(descriptor);
    if (state.complete) {
      const cached = this.definitionCache.get(key);
      if (cached) return cached;
    }

    let flight = this.definitionFlights.get(key);
    if (!flight) {
      flight = this.startDefinitionLoad(provider, descriptor, catalog, state);
      this.definitionFlights.set(key, flight);
      void flight.then(
        () => this.definitionFlights.delete(key),
        () => this.definitionFlights.delete(key)
      );
    }
    return waitForPromise(flight, signal);
  }

  private async startDefinitionLoad(
    provider: SkillProviderV1,
    descriptor: SkillDescriptorV1,
    catalog: SkillCatalogV1,
    state: ProviderState
  ): Promise<SkillDefinitionV1> {
    const loaded = await provider.get(descriptor.id, this.lifecycleController.signal);
    if (!loaded) {
      throw new LazySkillRuntimeError(`Skill ${descriptor.id} was not found by ${provider.id}.`);
    }
    const definition = normalizeDefinition(descriptor, loaded);
    const current = this.providerStates.get(provider.id);
    if (!current || current.generation !== state.generation || !current.observed) {
      throw new StaleSkillLoadError(provider.id, descriptor.id);
    }
    this.assertCatalogCurrent(catalog, provider.id);
    if (current.complete) this.definitionCache.set(definitionCacheKey(descriptor), definition);
    return definition;
  }

  private async startResourceLoad(
    provider: SkillProviderV1,
    definition: SkillDefinitionV1,
    resourceDescriptor: SkillResourceDescriptorV1,
    state: ProviderState
  ): Promise<SkillResourceV1> {
    const loaded = await provider.getResource(
      definition.id,
      resourceDescriptor.path,
      this.lifecycleController.signal
    );
    const resource = normalizeResource(definition, resourceDescriptor, loaded);
    const current = this.providerStates.get(provider.id);
    if (!current || current.generation !== state.generation || !current.observed) {
      throw new StaleSkillLoadError(provider.id, definition.id);
    }
    if (current.complete)
      this.resourceCache.set(resourceCacheKey(definition, resourceDescriptor), resource);
    return resource;
  }

  private reconcileObservation(observation: SkillObservationV1): void {
    const previous = this.providerStates.get(observation.providerId);
    const stableMatch =
      observation.complete &&
      previous?.observed === true &&
      previous.complete &&
      previous.digest === observation.digest;
    if (stableMatch) return;

    this.deleteProviderCacheEntries(observation.providerId);
    this.providerStates.set(observation.providerId, {
      generation: (previous?.generation ?? 0) + 1,
      observed: true,
      complete: observation.complete,
      digest: observation.digest,
      descriptorDigests: new Map(
        observation.descriptors.map(descriptor => [descriptor.id, descriptor.digest])
      ),
    });
  }

  private assertCatalogCurrent(catalog: SkillCatalogV1, providerId: string): void {
    const observation = catalog.observations.find(item => item.providerId === providerId);
    const state = this.providerStates.get(providerId);
    if (!observation || !state?.observed || state.digest !== observation.digest) {
      throw new StaleSkillCatalogError(providerId);
    }
  }

  private requireObservedState(providerId: string): ProviderState {
    const state = this.providerStates.get(providerId);
    if (!state?.observed) throw new StaleSkillCatalogError(providerId);
    return state;
  }

  private handleInvalidation(providerId: string, invalidation: SkillInvalidationV1): void {
    if (invalidation.providerId !== providerId) {
      throw new LazySkillRuntimeError(
        `Provider ${providerId} emitted invalidation for ${invalidation.providerId}.`
      );
    }
    this.invalidateProvider(providerId, invalidation.reason);
  }

  private deleteProviderCacheEntries(providerId: string): void {
    const prefix = `${providerId}\u0000`;
    this.definitionCache.deleteWhere(key => key.startsWith(prefix));
    this.resourceCache.deleteWhere(key => key.startsWith(prefix));
  }

  private assertActive(): void {
    if (this.disposed || this.lifecycleController.signal.aborted) {
      throw new LazySkillRuntimeError('Lazy Skill runtime is disposed.');
    }
  }
}

function composeCatalog(
  scope: Required<Pick<SkillScopeV1, 'id' | 'sourceScopeOrder'>> &
    Pick<SkillScopeV1, 'providerIds'>,
  observations: readonly SkillObservationV1[]
): SkillCatalogV1 {
  const byName = new Map<string, CatalogDescriptorCandidate[]>();
  const descriptorIds = new Set<string>();
  for (const observation of observations) {
    for (const descriptor of observation.descriptors) {
      const scopeRank = scope.sourceScopeOrder.indexOf(descriptor.sourceScope);
      if (scopeRank < 0) continue;
      const nameKey = descriptor.name.toLowerCase();
      const candidates = byName.get(nameKey) ?? [];
      candidates.push({ descriptor, scopeRank });
      byName.set(nameKey, candidates);
    }
  }

  const descriptors: SkillDescriptorV1[] = [];
  const shadowDiagnostics: SkillShadowDiagnosticV1[] = [];
  for (const candidates of byName.values()) {
    candidates.sort(compareCandidates);
    const selected = candidates[0].descriptor;
    if (descriptorIds.has(selected.id)) {
      throw new LazySkillRuntimeError(`Duplicate selected Skill id: ${selected.id}`);
    }
    descriptorIds.add(selected.id);
    descriptors.push(selected);
    for (const shadowed of candidates.slice(1)) {
      shadowDiagnostics.push(
        deepFreeze({
          name: selected.name,
          selected: descriptorIdentity(selected),
          shadowed: descriptorIdentity(shadowed.descriptor),
          reason:
            selected.sourceScope === shadowed.descriptor.sourceScope
              ? 'same source scope; deterministic provider/id tie-break'
              : `${selected.sourceScope} source scope outranks ${shadowed.descriptor.sourceScope}`,
        })
      );
    }
  }
  descriptors.sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
  );
  shadowDiagnostics.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.shadowed.providerId.localeCompare(right.shadowed.providerId) ||
      left.shadowed.id.localeCompare(right.shadowed.id)
  );
  const observationReceipts: SkillProviderObservationReceiptV1[] = observations
    .map(observation =>
      deepFreeze({
        providerId: observation.providerId,
        digest: observation.digest,
        complete: observation.complete,
        descriptorCount: observation.descriptors.length,
      })
    )
    .sort((left, right) => left.providerId.localeCompare(right.providerId));
  const digest = digestRuntimeValue({
    version: LAZY_SKILL_RUNTIME_VERSION,
    sourceScopeOrder: scope.sourceScopeOrder,
    descriptors,
    observations: observationReceipts,
    shadowDiagnostics,
  });

  return deepFreeze({
    version: LAZY_SKILL_RUNTIME_VERSION,
    scopeId: scope.id,
    sourceScopeOrder: scope.sourceScopeOrder,
    descriptors,
    observations: observationReceipts,
    shadowDiagnostics,
    digest,
  });
}

function compareCandidates(
  left: CatalogDescriptorCandidate,
  right: CatalogDescriptorCandidate
): number {
  return (
    left.scopeRank - right.scopeRank ||
    left.descriptor.providerId.localeCompare(right.descriptor.providerId) ||
    left.descriptor.id.localeCompare(right.descriptor.id)
  );
}

function descriptorIdentity(descriptor: SkillDescriptorV1): SkillShadowDiagnosticV1['selected'] {
  return Object.freeze({
    id: descriptor.id,
    providerId: descriptor.providerId,
    sourceScope: descriptor.sourceScope,
  });
}

function normalizeScope(
  scope: SkillScopeV1
): Required<Pick<SkillScopeV1, 'id' | 'sourceScopeOrder'>> & Pick<SkillScopeV1, 'providerIds'> {
  const id = validateIdentifier(scope.id, 'Skill scope id');
  const sourceScopeOrder = [...(scope.sourceScopeOrder ?? DEFAULT_SKILL_SOURCE_SCOPE_ORDER)];
  if (sourceScopeOrder.length === 0 || new Set(sourceScopeOrder).size !== sourceScopeOrder.length) {
    throw new LazySkillRuntimeError('Skill source scope order must be non-empty and unique.');
  }
  const providerIds = scope.providerIds
    ? Object.freeze(
        [
          ...new Set(
            scope.providerIds.map(providerId => validateIdentifier(providerId, 'Provider id'))
          ),
        ].sort()
      )
    : undefined;
  return {
    id,
    sourceScopeOrder: Object.freeze(sourceScopeOrder),
    providerIds,
  };
}

function normalizeObservation(
  providerId: string,
  observation: SkillObservationV1,
  sourceScopeOrder: readonly SkillSourceScopeV1[]
): SkillObservationV1 {
  if (observation.version !== LAZY_SKILL_RUNTIME_VERSION) {
    throw new LazySkillRuntimeError(
      `Provider ${providerId} returned unsupported observation version.`
    );
  }
  if (observation.providerId !== providerId) {
    throw new LazySkillRuntimeError(
      `Provider ${providerId} returned observation for ${observation.providerId}.`
    );
  }
  const digest = validateDigest(observation.digest, `Provider ${providerId} observation digest`);
  const allowedScopes = new Set(sourceScopeOrder);
  const descriptors = observation.descriptors
    .map(descriptor => normalizeDescriptor(providerId, descriptor))
    .filter(descriptor => allowedScopes.has(descriptor.sourceScope));
  return deepFreeze({
    version: LAZY_SKILL_RUNTIME_VERSION,
    providerId,
    digest,
    complete: observation.complete === true,
    descriptors,
  });
}

function normalizeDescriptor(providerId: string, descriptor: SkillDescriptorV1): SkillDescriptorV1 {
  if (descriptor.providerId !== providerId) {
    throw new LazySkillRuntimeError(
      `Skill ${descriptor.id} belongs to ${descriptor.providerId}, not provider ${providerId}.`
    );
  }
  if (!DEFAULT_SKILL_SOURCE_SCOPE_ORDER.includes(descriptor.sourceScope)) {
    throw new LazySkillRuntimeError(`Skill ${descriptor.id} has invalid source scope.`);
  }
  return deepFreeze({
    id: validateIdentifier(descriptor.id, 'Skill id'),
    name: validateIdentifier(descriptor.name, 'Skill name'),
    description: descriptor.description.trim().slice(0, MAX_CATALOG_DESCRIPTION_CHARS),
    providerId,
    sourceScope: descriptor.sourceScope,
    modelInvocable: descriptor.modelInvocable === true,
    userInvocable: descriptor.userInvocable === true,
    requestedCapabilities: normalizeCapabilities(descriptor.requestedCapabilities),
    digest: validateDigest(descriptor.digest, `Skill ${descriptor.id} digest`),
  });
}

function normalizeDefinition(
  descriptor: SkillDescriptorV1,
  definition: SkillDefinitionV1
): SkillDefinitionV1 {
  if (
    definition.id !== descriptor.id ||
    definition.providerId !== descriptor.providerId ||
    definition.digest !== descriptor.digest
  ) {
    throw new LazySkillRuntimeError(
      `Skill definition identity or digest drifted: ${descriptor.id}`
    );
  }
  if (typeof definition.body !== 'string') {
    throw new LazySkillRuntimeError(`Skill ${descriptor.id} definition body must be text.`);
  }
  const resourcePaths = new Set<string>();
  const resourceManifest = definition.resourceManifest
    .map(resource => normalizeResourceDescriptor(descriptor.id, resource))
    .sort((left, right) => left.path.localeCompare(right.path));
  for (const resource of resourceManifest) {
    if (resourcePaths.has(resource.path)) {
      throw new LazySkillRuntimeError(
        `Skill ${descriptor.id} declares resource ${resource.path} more than once.`
      );
    }
    resourcePaths.add(resource.path);
  }
  return deepFreeze({
    ...descriptor,
    body: definition.body,
    resourceManifest,
  });
}

function normalizeResourceDescriptor(
  skillId: string,
  descriptor: SkillResourceDescriptorV1
): SkillResourceDescriptorV1 {
  if (!Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 0) {
    throw new LazySkillRuntimeError(`Skill ${skillId} resource bytes must be non-negative.`);
  }
  return deepFreeze({
    path: normalizeResourcePath(descriptor.path),
    digest: validateDigest(descriptor.digest, `Skill ${skillId} resource digest`),
    bytes: descriptor.bytes,
    ...(descriptor.mediaType?.trim() ? { mediaType: descriptor.mediaType.trim() } : {}),
  });
}

function normalizeResource(
  definition: SkillDefinitionV1,
  descriptor: SkillResourceDescriptorV1,
  resource: SkillResourceV1
): SkillResourceV1 {
  if (
    resource.skillId !== definition.id ||
    normalizeResourcePath(resource.path) !== descriptor.path ||
    resource.digest !== descriptor.digest
  ) {
    throw new LazySkillRuntimeError(
      `Skill resource identity or digest drifted: ${definition.id}/${descriptor.path}`
    );
  }
  const content =
    typeof resource.content === 'string'
      ? resource.content
      : new Uint8Array(
          resource.content.buffer,
          resource.content.byteOffset,
          resource.content.byteLength
        ).slice();
  const actualBytes =
    typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength;
  if (actualBytes !== descriptor.bytes) {
    throw new LazySkillRuntimeError(
      `Skill resource byte count drifted: ${definition.id}/${descriptor.path}`
    );
  }
  if (descriptor.mediaType && resource.mediaType && descriptor.mediaType !== resource.mediaType) {
    throw new LazySkillRuntimeError(
      `Skill resource media type drifted: ${definition.id}/${descriptor.path}`
    );
  }
  return Object.freeze({
    skillId: definition.id,
    path: descriptor.path,
    digest: descriptor.digest,
    content,
    ...(descriptor.mediaType || resource.mediaType
      ? { mediaType: descriptor.mediaType || resource.mediaType }
      : {}),
  });
}

function createAuthorityReceipt(
  request: SkillDefinitionLoadRequestV1,
  descriptor: SkillDescriptorV1
): SkillAuthorityReceiptV1 {
  const authorityId = validateIdentifier(request.authority.authorityId, 'Skill authority id');
  const authorityDigest = validateDigest(request.authority.digest, 'Skill authority digest');
  const reason = request.reason.trim();
  if (!reason) throw new LazySkillRuntimeError('Skill load reason must not be empty.');
  const requestedCapabilities = normalizeCapabilities(descriptor.requestedCapabilities);
  const allowed = new Set(normalizeCapabilities(request.authority.allowedCapabilities));
  const grantedCapabilities = requestedCapabilities.filter(capability => allowed.has(capability));
  const omittedCapabilityReasons = Object.fromEntries(
    requestedCapabilities
      .filter(capability => !allowed.has(capability))
      .map(capability => [
        capability,
        request.authority.deniedCapabilityReasons?.[capability]?.trim() ||
          'not_granted_by_current_authority',
      ])
  );
  const base = {
    version: LAZY_SKILL_RUNTIME_VERSION,
    skillId: descriptor.id,
    skillName: descriptor.name,
    providerId: descriptor.providerId,
    sourceScope: descriptor.sourceScope,
    descriptorDigest: descriptor.digest,
    catalogDigest: request.catalog.digest,
    actor: request.actor,
    reason,
    requestedCapabilities,
    grantedCapabilities,
    omittedCapabilityReasons,
    authorityId,
    authorityDigest,
  } as const;
  return deepFreeze({ ...base, digest: digestRuntimeValue(base) });
}

function assertSelectionIdentity(selection: LoadedSkillDefinitionV1): void {
  const { definition, receipt } = selection;
  if (
    receipt.skillId !== definition.id ||
    receipt.skillName !== definition.name ||
    receipt.providerId !== definition.providerId ||
    receipt.sourceScope !== definition.sourceScope ||
    receipt.descriptorDigest !== definition.digest
  ) {
    throw new LazySkillRuntimeError(`Skill selection receipt does not bind ${definition.id}.`);
  }
  const { digest, ...receiptBase } = receipt;
  if (digestRuntimeValue(receiptBase) !== digest) {
    throw new LazySkillRuntimeError(`Skill selection receipt digest drifted: ${definition.id}.`);
  }
}

function normalizeCapabilities(capabilities: readonly string[]): readonly string[] {
  return Object.freeze(
    [...new Set(capabilities.map(capability => capability.trim()).filter(Boolean))].sort()
  );
}

function normalizeResourcePath(path: string): string {
  const normalized = path.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[a-z]:\//i.test(normalized) ||
    normalized.split('/').some(segment => segment === '..' || segment === '' || segment === '.')
  ) {
    throw new LazySkillRuntimeError(
      `Skill resource path must be a contained relative path: ${path}`
    );
  }
  return normalized;
}

function validateIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.includes('\u0000')) {
    throw new LazySkillRuntimeError(`${label} must be non-empty and contain no null bytes.`);
  }
  return normalized;
}

function validateDigest(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new LazySkillRuntimeError(`${label} must not be empty.`);
  return normalized;
}

function definitionCacheKey(descriptor: SkillDescriptorV1): string {
  return `${descriptor.providerId}\u0000definition\u0000${descriptor.id}\u0000${descriptor.digest}`;
}

function resourceCacheKey(
  definition: SkillDefinitionV1,
  resource: SkillResourceDescriptorV1
): string {
  return (
    `${definition.providerId}\u0000resource\u0000${definition.id}\u0000${definition.digest}` +
    `\u0000${resource.path}\u0000${resource.digest}`
  );
}

function resourceBytes(resource: SkillResourceV1): number {
  const contentBytes =
    typeof resource.content === 'string'
      ? Buffer.byteLength(resource.content, 'utf8')
      : resource.content.byteLength;
  return contentBytes + Buffer.byteLength(resource.path + resource.digest, 'utf8');
}

function cloneResource(resource: SkillResourceV1): SkillResourceV1 {
  return Object.freeze({
    ...resource,
    content:
      typeof resource.content === 'string'
        ? resource.content
        : new Uint8Array(resource.content).slice(),
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error(String(reason || 'Operation aborted.'));
}

function linkSignals(primary: AbortSignal, secondary?: AbortSignal): LinkedSignal {
  if (!secondary) return { signal: primary, dispose: () => undefined };
  const controller = new AbortController();
  const abort = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  const onPrimary = (): void => abort(primary);
  const onSecondary = (): void => abort(secondary);
  primary.addEventListener('abort', onPrimary, { once: true });
  secondary.addEventListener('abort', onSecondary, { once: true });
  if (primary.aborted) abort(primary);
  if (secondary.aborted) abort(secondary);
  return {
    signal: controller.signal,
    dispose: (): void => {
      primary.removeEventListener('abort', onPrimary);
      secondary.removeEventListener('abort', onSecondary);
    },
  };
}

function waitForPromise<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      value => {
        cleanup();
        resolve(value);
      },
      error => {
        cleanup();
        reject(error);
      }
    );
  });
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (ArrayBuffer.isView(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}
