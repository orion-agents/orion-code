import {
  getModelCatalogAliases,
  getModelCatalogDiagnostics,
  getModelCatalogEntry,
  listModelCatalogEntries,
  resolveModelAlias,
} from '../src/services/model-catalog';
import { resolveModelContext } from '../src/services/model-context';

describe('model catalog', () => {
  it('keeps listed models and aliases aligned with model context metadata', () => {
    const diagnostics = getModelCatalogDiagnostics();

    expect(diagnostics.unknownCatalogModels).toEqual([]);
    expect(diagnostics.unknownAliases).toEqual([]);
    for (const entry of listModelCatalogEntries()) {
      expect(['builtin', 'discovered']).toContain(resolveModelContext(entry.name).source);
    }
  });

  it('resolves public aliases to canonical model ids', () => {
    expect(resolveModelAlias('opus')).toBe('claude-opus-4-8');
    expect(resolveModelAlias('qwen')).toBe('qwen3.7-plus');
    expect(resolveModelAlias('qwenplus')).toBe('qwen3.7-plus');
    expect(resolveModelAlias('qwen35')).toBe('qwen3.5-plus');
    expect(resolveModelAlias('MiniMax-M2.5')).toBe('MiniMax-M2.5');
    expect(resolveModelAlias('minimax')).toBe('MiniMax-M2.5');
    expect(resolveModelAlias('custom-model')).toBe('custom-model');
  });

  it('exposes aliases and catalog lookup without leaking mutable state', () => {
    const aliases = getModelCatalogAliases();
    aliases.opus = 'broken';

    expect(getModelCatalogAliases().opus).toBe('claude-opus-4-8');
    expect(getModelCatalogEntry('glm')).toMatchObject({
      name: 'glm-5',
      alias: 'glm',
      provider: 'Bailian (Zhipu)',
    });
    expect(getModelCatalogEntry('missing-model')).toBeUndefined();
  });
});
