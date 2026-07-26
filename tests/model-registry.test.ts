/**
 * v0.2.26 — Model Registry unit tests (Slice 1).
 */
import {
  isLegacyConfig,
  getLegacyMigrationHint,
  buildRegistry,
  lookupProfile,
  resolveModelProfile,
  type ModelRegistryConfig,
  type ProviderConfig,
  type ModelProfile,
} from '../src/services/model-registry';

const VALID_PROVIDER: ProviderConfig = {
  id: 'test-provider',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test-key',
  protocol: 'openai-completions',
};

const VALID_PROFILE: ModelProfile = {
  id: 'test-model',
  provider: 'test-provider',
  model: 'test-model-v1',
};

function validConfig(overrides: Partial<ModelRegistryConfig> = {}): ModelRegistryConfig {
  return {
    providers: [VALID_PROVIDER],
    models: [VALID_PROFILE],
    defaultModel: 'test-model',
    ...overrides,
  };
}

describe('Model Registry (Slice 1)', () => {
  describe('legacy detection', () => {
    it('detects legacy 4-field config', () => {
      expect(isLegacyConfig({ apiKey: 'sk-xxx', apiBaseUrl: 'https://x.com', defaultModel: 'm', fallbackModel: 'f' })).toBe(true);
    });

    it('does not flag new config as legacy', () => {
      expect(isLegacyConfig({ providers: [], models: [] })).toBe(false);
    });

    it('produces migration hint', () => {
      const hint = getLegacyMigrationHint();
      expect(hint).toContain('providers');
      expect(hint).toContain('models');
      expect(hint).toContain('v0.2.26');
    });
  });

  describe('validation', () => {
    it('rejects empty providers', () => {
      const r = buildRegistry({ providers: [], models: [VALID_PROFILE] });
      expect(r.valid).toBe(false);
    });

    it('rejects empty models', () => {
      const r = buildRegistry({ providers: [VALID_PROVIDER], models: [] });
      expect(r.valid).toBe(false);
    });

    it('rejects unknown provider', () => {
      const r = buildRegistry({
        providers: [VALID_PROVIDER],
        models: [{ ...VALID_PROFILE, provider: 'unknown' }],
      });
      expect(r.valid).toBe(false);
      expect(r.errors[0].message).toContain('Unknown provider');
    });

    it('rejects duplicate profile id', () => {
      const r = buildRegistry({
        providers: [VALID_PROVIDER],
        models: [VALID_PROFILE, { ...VALID_PROFILE, id: 'test-model' }],
      });
      expect(r.valid).toBe(false);
    });

    it('rejects negative contextWindow', () => {
      const r = buildRegistry({
        providers: [VALID_PROVIDER],
        models: [{ ...VALID_PROFILE, contextWindow: -1 }],
      });
      expect(r.valid).toBe(false);
    });

    it('rejects maxOutputTokens >= contextWindow', () => {
      const r = buildRegistry({
        providers: [VALID_PROVIDER],
        models: [{ ...VALID_PROFILE, contextWindow: 1000, maxOutputTokens: 1000 }],
      });
      expect(r.valid).toBe(false);
    });

    it('rejects missing defaultModel', () => {
      const r = buildRegistry({ providers: [VALID_PROVIDER], models: [VALID_PROFILE], defaultModel: 'nonexistent' });
      expect(r.valid).toBe(false);
    });
  });

  describe('resolution', () => {
    it('builds a valid registry', () => {
      const r = buildRegistry(validConfig());
      expect(r.valid).toBe(true);
      expect(r.registry).not.toBeNull();
      expect(r.registry!.profiles.size).toBe(1);
    });

    it('resolves config context over builtin', () => {
      const r = buildRegistry({
        providers: [VALID_PROVIDER],
        models: [{ ...VALID_PROFILE, contextWindow: 500000, model: 'gpt-4o' }],
      });
      expect(r.valid).toBe(true);
      const p = r.registry!.profiles.get('test-model')!;
      expect(p.resolvedContextWindow).toBe(500000);
      expect(p.contextSource).toBe('config');
    });

    it('falls back to builtin when no config context', () => {
      const r = buildRegistry({
        providers: [VALID_PROVIDER],
        models: [{ ...VALID_PROFILE, model: 'gpt-4o' }],
      });
      expect(r.valid).toBe(true);
      const p = r.registry!.profiles.get('test-model')!;
      expect(p.resolvedContextWindow).toBe(128000);
      expect(p.contextSource).toBe('builtin');
    });

    it('falls back to default when no match', () => {
      const r = buildRegistry({
        providers: [VALID_PROVIDER],
        models: [{ ...VALID_PROFILE, model: 'custom-unknown-model' }],
      });
      expect(r.valid).toBe(true);
      const p = r.registry!.profiles.get('test-model')!;
      expect(p.resolvedContextWindow).toBe(128000);
      expect(p.contextSource).toBe('default');
    });

    it('generates stable fingerprint', () => {
      const r1 = buildRegistry(validConfig());
      const r2 = buildRegistry(validConfig());
      expect(r1.registry!.profiles.get('test-model')!.fingerprint)
        .toBe(r2.registry!.profiles.get('test-model')!.fingerprint);
    });
  });

  describe('lookup', () => {
    it('finds by exact id', () => {
      const r = buildRegistry(validConfig());
      expect(lookupProfile(r.registry!, 'test-model')).not.toBeNull();
    });

    it('finds by alias', () => {
      const r = buildRegistry({
        providers: [VALID_PROVIDER],
        models: [{ ...VALID_PROFILE, aliases: ['tm', 'test'] }],
      });
      expect(lookupProfile(r.registry!, 'tm')).not.toBeNull();
      expect(lookupProfile(r.registry!, 'tm')!.id).toBe('test-model');
    });

    it('finds by prefix', () => {
      const r = buildRegistry(validConfig());
      expect(lookupProfile(r.registry!, 'test-')).not.toBeNull();
    });

    it('returns null for unknown', () => {
      const r = buildRegistry(validConfig());
      expect(lookupProfile(r.registry!, 'nope')).toBeNull();
    });

    it('returns null for ambiguous prefix', () => {
      const r = buildRegistry({
        providers: [VALID_PROVIDER],
        models: [
          { ...VALID_PROFILE, id: 'model-a' },
          { ...VALID_PROFILE, id: 'model-ab', provider: 'test-provider', model: 'v2' },
        ],
      });
      expect(lookupProfile(r.registry!, 'model-a')).not.toBeNull(); // exact match
      expect(lookupProfile(r.registry!, 'model-')).toBeNull(); // ambiguous
    });
  });

  describe('enabled/disabled', () => {
    it('excludes disabled profiles from enabled list', () => {
      const r = buildRegistry({
        providers: [VALID_PROVIDER],
        models: [
          VALID_PROFILE,
          { ...VALID_PROFILE, id: 'disabled-model', enabled: false, provider: 'test-provider', model: 'v3' },
        ],
      });
      expect(r.registry!.enabledProfiles.length).toBe(1);
      expect(r.registry!.profiles.size).toBe(2); // still in registry
    });
  });
});