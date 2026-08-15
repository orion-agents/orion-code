import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildMemoryPromptContext } from '../src/memory/prompt-context';
import { saveMemory } from '../src/memory/storage';
import type { MemoryEntry } from '../src/memory/types';

function memory(name: string, description: string, content: string): MemoryEntry {
  return {
    name,
    description,
    type: 'project',
    content,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('bounded memory prompt context', () => {
  const roots: string[] = [];
  const originalConfigDir = process.env.ORION_CODE_CONFIG_DIR;

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
    else process.env.ORION_CODE_CONFIG_DIR = originalConfigDir;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'orion-memory-prompt-context-'));
    roots.push(root);
    process.env.ORION_CODE_CONFIG_DIR = join(root, '.config');
    return root;
  }

  it('bounds the index, relevant entries, and manifest while preserving relevance order', () => {
    const root = fixture();
    saveMemory(
      memory('typescript-policy', 'TypeScript release policy', 'typescript '.repeat(300)),
      root
    );
    saveMemory(
      memory('typescript-tests', 'TypeScript testing notes', 'jest typescript '.repeat(300)),
      root
    );
    saveMemory(memory('unrelated', 'Cooking notes', 'soup '.repeat(300)), root);

    const result = buildMemoryPromptContext('typescript release', root, {
      maxTotalChars: 700,
      maxEntrypointChars: 180,
      maxRelevantEntries: 1,
      maxEntryChars: 220,
      minScore: 0.1,
    });

    expect(result.content.length).toBeLessThanOrEqual(700);
    expect(result.manifest).toMatchObject({
      budgetChars: 700,
      usedChars: result.content.length,
      entrypoint: {
        includedChars: expect.any(Number),
        truncated: true,
      },
    });
    expect(result.manifest.selected).toHaveLength(1);
    expect(result.manifest.selected[0]).toMatchObject({
      name: 'typescript-policy',
      includedChars: expect.any(Number),
      truncated: true,
    });
    expect(result.manifest.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'typescript-tests', reason: 'entry_limit' }),
      ])
    );
    expect(result.content).not.toContain('soup');
  });

  it('returns a deterministic bounded index-only projection for an empty query', () => {
    const root = fixture();
    saveMemory(memory('project-policy', 'Project policy', 'policy body'), root);

    const first = buildMemoryPromptContext('', root, {
      maxTotalChars: 160,
      maxEntrypointChars: 100,
      maxRelevantEntries: 3,
    });
    const second = buildMemoryPromptContext('', root, {
      maxTotalChars: 160,
      maxEntrypointChars: 100,
      maxRelevantEntries: 3,
    });

    expect(first).toEqual(second);
    expect(first.content.length).toBeLessThanOrEqual(160);
    expect(first.manifest.selected).toEqual([]);
    expect(first.manifest.candidateCount).toBe(0);
  });
});
