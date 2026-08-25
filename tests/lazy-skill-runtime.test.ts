import {
  BoundedLruCache,
  LazySkillRuntime,
  SkillInvocationDeniedError,
  StaleSkillCatalogError,
  StaleSkillLoadError,
  type SkillAuthorityV1,
  type SkillDefinitionV1,
  type SkillDescriptorV1,
  type SkillInvalidationV1,
  type SkillObservationV1,
  type SkillProviderSubscriptionV1,
  type SkillProviderV1,
  type SkillResourceV1,
  type SkillScopeV1,
} from '../src/runtime/skills';

const AUTHORITY: SkillAuthorityV1 = {
  authorityId: 'authority:test',
  digest: 'authority-digest-1',
  allowedCapabilities: ['exec'],
  deniedCapabilityReasons: { web: 'network is disabled by project authority' },
};
const SCOPE: SkillScopeV1 = { id: 'project:test' };

function descriptor(id: string, overrides: Partial<SkillDescriptorV1> = {}): SkillDescriptorV1 {
  return {
    id,
    name: id,
    description: `Summary for ${id}`,
    providerId: 'provider:test',
    sourceScope: 'user',
    modelInvocable: true,
    userInvocable: true,
    requestedCapabilities: [],
    digest: `digest:${id}:1`,
    ...overrides,
  };
}

function definition(
  value: SkillDescriptorV1,
  body = `# ${value.name}\n\nPrivate definition body.`
): SkillDefinitionV1 {
  return {
    ...value,
    body,
    resourceManifest: [],
  };
}

class FakeSkillProvider implements SkillProviderV1 {
  readonly id: string;
  descriptors: SkillDescriptorV1[];
  definitions = new Map<string, SkillDefinitionV1>();
  resources = new Map<string, SkillResourceV1>();
  observationDigest = 'observation:1';
  complete = true;
  listReads = 0;
  definitionReads = 0;
  resourceReads = 0;
  definitionGate?: Promise<void>;
  resourceGate?: Promise<void>;
  private invalidation?: (event: SkillInvalidationV1) => void;

  constructor(id: string, descriptors: SkillDescriptorV1[]) {
    this.id = id;
    this.descriptors = descriptors;
    for (const item of descriptors) this.definitions.set(item.id, definition(item));
  }

  async list(_scope: SkillScopeV1, _signal: AbortSignal): Promise<SkillObservationV1> {
    this.listReads++;
    return {
      version: 1,
      providerId: this.id,
      digest: this.observationDigest,
      complete: this.complete,
      descriptors: this.descriptors,
    };
  }

  async get(id: string, _signal: AbortSignal): Promise<SkillDefinitionV1 | undefined> {
    this.definitionReads++;
    await this.definitionGate;
    return this.definitions.get(id);
  }

  async getResource(id: string, path: string, _signal: AbortSignal): Promise<SkillResourceV1> {
    this.resourceReads++;
    await this.resourceGate;
    const resource = this.resources.get(`${id}:${path}`);
    if (!resource) throw new Error(`Missing fake resource ${id}:${path}`);
    return resource;
  }

  subscribe(
    invalidate: (event: SkillInvalidationV1) => void,
    _signal: AbortSignal
  ): SkillProviderSubscriptionV1 {
    this.invalidation = invalidate;
    return { dispose: () => (this.invalidation = undefined) };
  }

  emitInvalidation(reason = 'fixture_changed'): void {
    this.invalidation?.({ providerId: this.id, reason });
  }
}

async function select(
  runtime: LazySkillRuntime,
  catalog: Awaited<ReturnType<LazySkillRuntime['observe']>>,
  skillId: string,
  actor: 'model' | 'user' = 'user'
) {
  return runtime.getDefinition({
    catalog,
    skillId,
    actor,
    reason: 'explicit_test_selection',
    authority: AUTHORITY,
  });
}

describe('Lazy Skill Runtime v1', () => {
  test('100 discovered Skills require zero definition and resource reads when none is selected', async () => {
    const descriptors = Array.from({ length: 100 }, (_, index) =>
      descriptor(`skill-${String(index).padStart(3, '0')}`)
    );
    const provider = new FakeSkillProvider('provider:test', descriptors);
    const runtime = new LazySkillRuntime({ providers: [provider] });

    const catalog = await runtime.observe(SCOPE);

    expect(catalog.descriptors).toHaveLength(100);
    expect(provider.listReads).toBe(1);
    expect(provider.definitionReads).toBe(0);
    expect(provider.resourceReads).toBe(0);
    expect(JSON.stringify(catalog)).not.toContain('Private definition body');
    expect(JSON.stringify(catalog)).not.toContain('resourceManifest');
    expect(
      catalog.descriptors.every(item => !('body' in item) && !('resourceManifest' in item))
    ).toBe(true);
    await runtime.dispose();
  });

  test('composes project > configured > user > builtin scope layers deterministically', async () => {
    const builtin = descriptor('builtin-review', {
      name: 'review',
      providerId: 'provider:builtin',
      sourceScope: 'builtin',
    });
    const project = descriptor('project-review', {
      name: 'review',
      providerId: 'provider:project',
      sourceScope: 'project',
    });
    const builtinProvider = new FakeSkillProvider('provider:builtin', [builtin]);
    const projectProvider = new FakeSkillProvider('provider:project', [project]);
    const runtime = new LazySkillRuntime({ providers: [builtinProvider, projectProvider] });

    const catalog = await runtime.observe(SCOPE);
    expect(catalog.descriptors.map(item => item.id)).toEqual(['project-review']);
    expect(catalog.shadowDiagnostics).toEqual([
      expect.objectContaining({
        name: 'review',
        selected: expect.objectContaining({ sourceScope: 'project' }),
        shadowed: expect.objectContaining({ sourceScope: 'builtin' }),
      }),
    ]);

    const reversed = await runtime.observe({
      id: 'project:test-reversed',
      sourceScopeOrder: ['builtin', 'project'],
    });
    expect(reversed.descriptors.map(item => item.id)).toEqual(['builtin-review']);
    await runtime.dispose();
  });

  test('loads a definition on demand and records Authority capability intersection without body', async () => {
    const item = descriptor('networked-skill', {
      requestedCapabilities: ['web', 'exec', 'web'],
    });
    const provider = new FakeSkillProvider('provider:test', [item]);
    const runtime = new LazySkillRuntime({ providers: [provider] });
    const catalog = await runtime.observe(SCOPE);

    expect(provider.definitionReads).toBe(0);
    const loaded = await select(runtime, catalog, item.id);

    expect(provider.definitionReads).toBe(1);
    expect(loaded.definition.body).toContain('Private definition body');
    expect(loaded.receipt).toMatchObject({
      requestedCapabilities: ['exec', 'web'],
      grantedCapabilities: ['exec'],
      omittedCapabilityReasons: { web: 'network is disabled by project authority' },
      authorityDigest: AUTHORITY.digest,
    });
    expect(JSON.stringify(loaded.receipt)).not.toContain(loaded.definition.body);
    expect(Object.isFrozen(loaded.receipt)).toBe(true);
    await runtime.dispose();
  });

  test('enforces user/model invocation policy before definition IO', async () => {
    const item = descriptor('user-only', { modelInvocable: false, userInvocable: true });
    const provider = new FakeSkillProvider('provider:test', [item]);
    const runtime = new LazySkillRuntime({ providers: [provider] });
    const catalog = await runtime.observe(SCOPE);

    await expect(select(runtime, catalog, item.id, 'model')).rejects.toBeInstanceOf(
      SkillInvocationDeniedError
    );
    expect(provider.definitionReads).toBe(0);
    await expect(select(runtime, catalog, item.id, 'user')).resolves.toBeDefined();
    expect(provider.definitionReads).toBe(1);
    await runtime.dispose();
  });

  test('reads only manifest-declared resources and caches them independently', async () => {
    const item = descriptor('resource-skill');
    const provider = new FakeSkillProvider('provider:test', [item]);
    provider.definitions.set(item.id, {
      ...definition(item),
      resourceManifest: [
        {
          path: 'references/guide.md',
          digest: 'resource:guide:1',
          bytes: 5,
          mediaType: 'text/markdown',
        },
      ],
    });
    provider.resources.set(`${item.id}:references/guide.md`, {
      skillId: item.id,
      path: 'references/guide.md',
      digest: 'resource:guide:1',
      content: 'guide',
      mediaType: 'text/markdown',
    });
    const runtime = new LazySkillRuntime({ providers: [provider] });
    const catalog = await runtime.observe(SCOPE);
    const loaded = await select(runtime, catalog, item.id);

    expect(provider.resourceReads).toBe(0);
    await expect(runtime.getResource({ selection: loaded, path: '../secret.txt' })).rejects.toThrow(
      'contained relative path'
    );
    expect(provider.resourceReads).toBe(0);
    await expect(
      runtime.getResource({ selection: loaded, path: 'references/guide.md' })
    ).resolves.toMatchObject({ content: 'guide' });
    await runtime.getResource({ selection: loaded, path: 'references/guide.md' });
    expect(provider.resourceReads).toBe(1);
    await runtime.dispose();
  });

  test('deduplicates concurrent definition and resource reads with single-flight', async () => {
    let releaseDefinition = (): void => undefined;
    let releaseResource = (): void => undefined;
    const item = descriptor('concurrent-skill');
    const provider = new FakeSkillProvider('provider:test', [item]);
    provider.definitions.set(item.id, {
      ...definition(item),
      resourceManifest: [{ path: 'data.txt', digest: 'resource:data:1', bytes: 4 }],
    });
    provider.resources.set(`${item.id}:data.txt`, {
      skillId: item.id,
      path: 'data.txt',
      digest: 'resource:data:1',
      content: 'data',
    });
    provider.definitionGate = new Promise(resolve => (releaseDefinition = resolve));
    provider.resourceGate = new Promise(resolve => (releaseResource = resolve));
    const runtime = new LazySkillRuntime({ providers: [provider] });
    const catalog = await runtime.observe(SCOPE);

    const firstDefinition = select(runtime, catalog, item.id);
    const secondDefinition = select(runtime, catalog, item.id);
    expect(provider.definitionReads).toBe(1);
    releaseDefinition();
    const [first, second] = await Promise.all([firstDefinition, secondDefinition]);
    expect(first.definition).toBe(second.definition);

    const firstResource = runtime.getResource({ selection: first, path: 'data.txt' });
    const secondResource = runtime.getResource({ selection: second, path: 'data.txt' });
    expect(provider.resourceReads).toBe(1);
    releaseResource();
    await expect(Promise.all([firstResource, secondResource])).resolves.toHaveLength(2);
    await runtime.dispose();
  });

  test('invalidates digest-bound caches and rejects stale catalogs or in-flight loads', async () => {
    let release = (): void => undefined;
    const item = descriptor('changing-skill');
    const provider = new FakeSkillProvider('provider:test', [item]);
    const runtime = new LazySkillRuntime({ providers: [provider] });
    const oldCatalog = await runtime.observe(SCOPE);
    await select(runtime, oldCatalog, item.id);
    expect(provider.definitionReads).toBe(1);

    provider.emitInvalidation();
    await expect(select(runtime, oldCatalog, item.id)).rejects.toBeInstanceOf(
      StaleSkillCatalogError
    );

    const next = descriptor(item.id, { digest: 'digest:changing-skill:2' });
    provider.descriptors = [next];
    provider.definitions.set(next.id, definition(next, '# changed'));
    provider.observationDigest = 'observation:2';
    const nextCatalog = await runtime.observe(SCOPE);
    provider.definitionGate = new Promise(resolve => (release = resolve));
    const pending = select(runtime, nextCatalog, next.id);
    expect(provider.definitionReads).toBe(2);
    provider.emitInvalidation('changed_during_load');
    release();
    await expect(pending).rejects.toBeInstanceOf(StaleSkillLoadError);
    await runtime.dispose();
  });

  test('does not retain definition cache entries for incomplete provider observations', async () => {
    const item = descriptor('partial-skill');
    const provider = new FakeSkillProvider('provider:test', [item]);
    provider.complete = false;
    const runtime = new LazySkillRuntime({ providers: [provider] });
    const catalog = await runtime.observe(SCOPE);

    await select(runtime, catalog, item.id);
    await select(runtime, catalog, item.id);
    expect(provider.definitionReads).toBe(2);
    expect(runtime.stats().definitionCache.entries).toBe(0);
    await runtime.dispose();
  });

  test('bounds LRU state by entry count, bytes, and TTL', () => {
    let now = 100;
    const cache = new BoundedLruCache<string>({
      maxEntries: 2,
      maxBytes: 4,
      ttlMs: 10,
      sizeOf: value => value.length,
      now: () => now,
    });

    expect(cache.set('a', 'aa')).toBe(true);
    expect(cache.set('b', 'bb')).toBe(true);
    expect(cache.get('a')).toBe('aa');
    expect(cache.set('c', 'cc')).toBe(true);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.stats()).toMatchObject({ entries: 2, bytes: 4 });
    expect(cache.set('oversized', '12345')).toBe(false);
    now = 110;
    expect(cache.stats()).toMatchObject({ entries: 0, bytes: 0 });
  });
});
