import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { buildMemoryPromptContext } from '../src/memory/prompt-context';
import { saveMemory } from '../src/memory/storage';

describe('production memory prompt integration', () => {
  const roots: string[] = [];
  const originalConfigDir = process.env.ORION_CODE_CONFIG_DIR;

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
    else process.env.ORION_CODE_CONFIG_DIR = originalConfigDir;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test('keeps the default turn projection bounded and the trace manifest free of bodies', () => {
    const project = mkdtempSync(join(tmpdir(), 'orion-memory-runtime-'));
    roots.push(project);
    process.env.ORION_CODE_CONFIG_DIR = join(project, '.config');
    const privateBodyMarker = 'BODY_MUST_NOT_ENTER_MANIFEST';
    for (let index = 0; index < 12; index++) {
      saveMemory(
        {
          name: `typescript-${index}`,
          description: `TypeScript policy ${index}`,
          type: 'project',
          content: `${privateBodyMarker} typescript ${'x'.repeat(10_000)}`,
          createdAt: 0,
          updatedAt: 0,
        },
        project
      );
    }

    const projection = buildMemoryPromptContext('typescript policy', project);

    expect(projection.content.length).toBeLessThanOrEqual(24_000);
    expect(projection.manifest.selected.length).toBeLessThanOrEqual(5);
    expect(projection.manifest.omitted.length).toBeLessThanOrEqual(20);
    expect(JSON.stringify(projection.manifest)).not.toContain(privateBodyMarker);
  });

  test('wires the bounded selector at startup and for each runtime turn', () => {
    const root = resolve(__dirname, '..');
    const cli = readFileSync(join(root, 'src', 'cli.ts'), 'utf8');
    const productRuntime = readFileSync(
      join(root, 'src', 'runtime', 'product-orion-runtime.ts'),
      'utf8'
    );
    const selector = readFileSync(join(root, 'src', 'memory', 'prompt-context.ts'), 'utf8');

    expect(cli).toContain("buildMemoryPromptContext('', cwd).content");
    expect(cli).not.toContain('loadAllMemories(cwd)');
    expect(productRuntime).toContain('buildMemoryPromptContext(input, options.cwd)');
    expect(productRuntime).toContain('const memory = buildMemoryPromptContext(input, options.cwd).content');
    expect(productRuntime).toContain('memory,');
    expect(selector).toContain('loadMemory(candidate.name, projectPath)');
    expect(selector).not.toContain('loadAllMemories');
  });
});
