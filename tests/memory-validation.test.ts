import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { handleMemory } from '../src/commands/context-tool-command-handlers';
import { validateAllMemories, validateMemoryDrift } from '../src/memory/validation';
import { saveMemory } from '../src/memory/storage';
import type { MemoryEntry } from '../src/memory/types';

function memory(content: string): MemoryEntry {
  return {
    name: 'validation-fixture',
    description: 'Memory drift validation fixture',
    type: 'project',
    content,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('memory drift validation', () => {
  const roots: string[] = [];
  const originalConfigDir = process.env.ORION_CODE_CONFIG_DIR;
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
    else process.env.ORION_CODE_CONFIG_DIR = originalConfigDir;
    jest.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function project(): string {
    const root = mkdtempSync(join(tmpdir(), 'orion-memory-validation-'));
    roots.push(root);
    mkdirSync(join(root, 'src'));
    writeFileSync(
      join(root, 'src', 'example.ts'),
      'export function existingSymbol(): string { return "ok"; }\n'
    );
    return root;
  }

  it('accepts existing files, symbols, and well-formed URLs', () => {
    const root = project();
    const result = validateMemoryDrift(
      memory('`existingSymbol` is defined in src/example.ts; docs: https://example.com/api'),
      root
    );

    expect(result).toMatchObject({
      valid: true,
      drifts: [],
      symbolScanComplete: true,
      symbolFilesScanned: 1,
    });
  });

  it('reports a symbol that is absent from existing project source', () => {
    const root = project();
    const result = validateMemoryDrift(
      memory('`removedSymbol` used to be defined in src/example.ts'),
      root
    );

    expect(result.valid).toBe(false);
    expect(result.drifts).toContainEqual({
      type: 'symbol_missing',
      ref: 'removedSymbol',
      message: 'Symbol not found in project source: removedSymbol',
    });
    expect(result.drifts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'file_missing' })])
    );
  });

  it('fails an incomplete bounded scan without inventing a missing-symbol drift', () => {
    const root = project();
    writeFileSync(join(root, 'src', 'oversized.ts'), 'x'.repeat(2 * 1024 * 1024 + 1));

    const result = validateMemoryDrift(memory('`possiblyExternalSymbol`'), root);

    expect(result).toMatchObject({
      valid: false,
      drifts: [],
      symbolScanComplete: false,
      symbolFilesScanned: 1,
    });
  });

  it('wires validation into the explicit memory command', async () => {
    const root = project();
    process.env.ORION_CODE_CONFIG_DIR = join(root, '.config');
    saveMemory(
      memory('`existingSymbol` is defined in src/example.ts; docs: https://example.com/api'),
      root
    );

    const results = validateAllMemories(root);
    expect(results.get('validation-fixture')?.valid).toBe(true);

    process.chdir(root);
    const output = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(handleMemory({} as never, 'validate')).resolves.toEqual({ success: true });
    expect(output).toHaveBeenCalledWith(expect.stringContaining('1 memories validated'));
  });
});
