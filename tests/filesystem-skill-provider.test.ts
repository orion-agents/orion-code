import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  createFilesystemSkillProviderV1,
  createFilesystemSkillRootsV1,
  createProductionFilesystemSkillProviderV1,
  FilesystemSkillProviderError,
  type FilesystemSkillWatchFactoryV1,
} from '../src/runtime/skills/filesystem-skill-provider';
import { LazySkillRuntime, StaleSkillCatalogError } from '../src/runtime/skills';

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orion-filesystem-skills-'));
  temporaryRoots.push(root);
  return root;
}

function writeSkill(
  root: string,
  directory: string,
  input: {
    name: string;
    description: string;
    body?: string;
    tools?: readonly string[];
  }
): string {
  const skillDirectory = join(root, directory);
  mkdirSync(skillDirectory, { recursive: true });
  const tools = input.tools?.length
    ? `tools:\n${input.tools.map(tool => `  - ${tool}`).join('\n')}\n`
    : '';
  writeFileSync(
    join(skillDirectory, 'SKILL.md'),
    `---\nname: ${input.name}\ndescription: ${input.description}\n${tools}---\n\n${input.body ?? '# Selected body'}\n`,
    'utf8'
  );
  return skillDirectory;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('FilesystemSkillProviderV1', () => {
  test('observes builtin, user, configured, and project descriptors without loading bodies', async () => {
    const root = temporaryRoot();
    const cwd = join(root, 'project');
    const configHome = join(root, 'config');
    const builtinRoot = join(root, 'builtin');
    const configuredRoot = join(root, 'configured');
    const largeBody = `# Not catalog content\n${'body-sentinel '.repeat(2_000)}`;
    writeSkill(builtinRoot, 'builtin-only', {
      name: 'builtin-only',
      description: 'builtin descriptor',
      body: largeBody,
    });
    writeSkill(join(configHome, 'skills'), 'user-only', {
      name: 'user-only',
      description: 'user descriptor',
      body: largeBody,
    });
    writeSkill(configuredRoot, 'configured-only', {
      name: 'configured-only',
      description: 'configured descriptor',
      body: largeBody,
      tools: ['grep', 'read_file'],
    });
    writeSkill(join(cwd, '.orion-code', 'skills'), 'project-only', {
      name: 'project-only',
      description: 'project descriptor',
      body: largeBody,
    });
    const roots = createFilesystemSkillRootsV1({
      cwd,
      configHome,
      builtinRoot,
      configuredPaths: [configuredRoot],
    });
    const provider = createProductionFilesystemSkillProviderV1({
      cwd,
      configHome,
      builtinRoot,
      configuredPaths: [configuredRoot],
      watch: false,
      maxFrontmatterBytes: 1_024,
    });
    const signal = new AbortController().signal;

    const first = await provider.list({ id: 'project-scope' }, signal);
    const second = await provider.list({ id: 'another-scope-id' }, signal);

    expect(roots.map(item => item.sourceScope)).toEqual([
      'builtin',
      'user',
      'configured',
      'project',
    ]);
    expect(first.complete).toBe(true);
    expect(first.descriptors.map(item => [item.name, item.sourceScope])).toEqual([
      ['builtin-only', 'builtin'],
      ['configured-only', 'configured'],
      ['project-only', 'project'],
      ['user-only', 'user'],
    ]);
    expect(first.descriptors.find(item => item.name === 'configured-only')).toMatchObject({
      requestedCapabilities: ['grep', 'read_file'],
    });
    expect(first.digest).toBe(second.digest);
    expect(JSON.stringify(first)).not.toContain(root);
    expect(provider.stats()).toMatchObject({
      catalogScans: 2,
      skillFilesObserved: 8,
      frontmatterPrefixReads: 8,
      definitionReads: 0,
      definitionBytes: 0,
      resourceReads: 0,
      resourceBytes: 0,
    });
    expect(provider.stats().frontmatterPrefixBytes).toBeLessThan(8 * 1_024);
  });

  test('loads the selected definition then enforces manifest and realpath resource containment', async () => {
    const root = temporaryRoot();
    const outside = join(root, 'outside-secret.md');
    const skillsRoot = join(root, 'skills');
    const skillDirectory = writeSkill(skillsRoot, 'safe-skill', {
      name: 'safe-skill',
      description: 'safe descriptor',
      body: '# Full selected instructions\nUse references only on demand.',
    });
    const guide = join(skillDirectory, 'references', 'guide.md');
    const binary = join(skillDirectory, 'assets', 'fixture.bin');
    mkdirSync(dirname(guide), { recursive: true });
    mkdirSync(dirname(binary), { recursive: true });
    writeFileSync(guide, 'trusted guide', 'utf8');
    writeFileSync(binary, Buffer.from([0, 1, 2, 3]));
    writeFileSync(outside, 'outside secret', 'utf8');
    if (process.platform !== 'win32') {
      symlinkSync(outside, join(skillDirectory, 'escape.md'));
    }
    const provider = createFilesystemSkillProviderV1({
      roots: [{ path: skillsRoot, sourceScope: 'configured' }],
      watch: false,
    });
    const signal = new AbortController().signal;
    const observation = await provider.list({ id: 'resource-scope' }, signal);
    const descriptor = observation.descriptors[0];

    expect(provider.stats().definitionReads).toBe(0);
    const definition = await provider.get(descriptor.id, signal);

    expect(definition?.body).toContain('# Full selected instructions');
    expect(definition?.body).not.toContain('description: safe descriptor');
    expect(definition?.resourceManifest.map(item => item.path)).toEqual([
      'assets/fixture.bin',
      'references/guide.md',
    ]);
    const resource = await provider.getResource(descriptor.id, 'references/guide.md', signal);
    expect(resource).toMatchObject({ content: 'trusted guide', mediaType: 'text/markdown' });
    await expect(
      provider.getResource(descriptor.id, '../outside-secret.md', signal)
    ).rejects.toThrow(FilesystemSkillProviderError);

    if (process.platform !== 'win32') {
      unlinkSync(guide);
      symlinkSync(outside, guide);
      await expect(
        provider.getResource(descriptor.id, 'references/guide.md', signal)
      ).rejects.toThrow('escapes its trusted realpath roots');
    }
    expect(provider.stats()).toMatchObject({
      definitionReads: 1,
      resourceReads: 1,
      unsafeEntriesRejected: process.platform === 'win32' ? 0 : 1,
    });
  });

  test('keeps 100 unselected filesystem Skills descriptor-only', async () => {
    const root = temporaryRoot();
    for (let index = 1; index <= 100; index++) {
      writeSkill(root, `skill-${index}`, {
        name: `skill-${index}`,
        description: `descriptor ${index}`,
        body: `# Body ${index}\n${'must-not-load-at-cold-start '.repeat(1_000)}`,
      });
    }
    const provider = createFilesystemSkillProviderV1({
      roots: [{ path: root, sourceScope: 'configured' }],
      watch: false,
      maxFrontmatterBytes: 1_024,
    });

    const observation = await provider.list({ id: 'hundred-skills' }, new AbortController().signal);

    expect(observation.complete).toBe(true);
    expect(observation.descriptors).toHaveLength(100);
    expect(provider.stats()).toMatchObject({
      skillFilesObserved: 100,
      frontmatterPrefixReads: 100,
      definitionReads: 0,
      definitionBytes: 0,
      resourceReads: 0,
      resourceBytes: 0,
    });
    expect(provider.stats().frontmatterPrefixBytes).toBeLessThan(100 * 1_024);
  });

  test('leaves source precedence to LazySkillRuntime and invalidates cached selections on watch', async () => {
    const root = temporaryRoot();
    const builtin = join(root, 'builtin');
    const project = join(root, 'project');
    writeSkill(builtin, 'shared', {
      name: 'shared',
      description: 'builtin copy',
      body: '# builtin body',
    });
    const projectSkill = writeSkill(project, 'shared', {
      name: 'shared',
      description: 'project copy',
      body: '# project body',
    });
    const watches: Array<{ active: boolean; invalidate: (event: string) => void }> = [];
    const watchFactory: FilesystemSkillWatchFactoryV1 = (_path, invalidate) => {
      const watch = { active: true, invalidate };
      watches.push(watch);
      return { close: () => (watch.active = false) };
    };
    const provider = createFilesystemSkillProviderV1({
      roots: [
        { path: builtin, sourceScope: 'builtin' },
        { path: project, sourceScope: 'project' },
      ],
      watchFactory,
      watchDebounceMs: 0,
    });
    const runtime = new LazySkillRuntime({ providers: [provider] });
    const catalog = await runtime.observe({ id: 'layered-scope' });
    const selected = catalog.descriptors[0];
    const generation = runtime.stats().providerGenerations[provider.id];

    expect(selected).toMatchObject({ name: 'shared', sourceScope: 'project' });
    expect(catalog.shadowDiagnostics).toHaveLength(1);
    const loaded = await runtime.getDefinition({
      catalog,
      skillId: selected.id,
      actor: 'model',
      reason: 'focused test',
      authority: {
        authorityId: 'test-authority',
        digest: 'test-authority-v1',
        allowedCapabilities: [],
      },
    });
    expect(loaded.definition.body).toContain('# project body');

    writeFileSync(
      join(projectSkill, 'SKILL.md'),
      '---\nname: shared\ndescription: project copy updated\n---\n\n# updated project body\n',
      'utf8'
    );
    const activeWatch = watches.find(watch => watch.active);
    expect(activeWatch).toBeDefined();
    activeWatch!.invalidate('change');

    expect(runtime.stats().providerGenerations[provider.id]).toBe(generation + 1);
    await expect(
      runtime.getDefinition({
        catalog,
        skillId: selected.id,
        actor: 'model',
        reason: 'stale request',
        authority: {
          authorityId: 'test-authority',
          digest: 'test-authority-v1',
          allowedCapabilities: [],
        },
      })
    ).rejects.toThrow(StaleSkillCatalogError);

    const refreshed = await runtime.observe({ id: 'layered-scope' });
    expect(refreshed.digest).not.toBe(catalog.digest);
    expect(refreshed.descriptors[0].description).toBe('project copy updated');
    expect(provider.stats().watchInvalidations).toBe(1);
    await runtime.dispose();
    expect(watches.every(watch => !watch.active)).toBe(true);
  });

  test('marks an observation incomplete when frontmatter exceeds its hard prefix bound', async () => {
    const root = temporaryRoot();
    const skillDirectory = join(root, 'oversized-header');
    mkdirSync(skillDirectory, { recursive: true });
    writeFileSync(
      join(skillDirectory, 'SKILL.md'),
      `---\nname: oversized-header\ndescription: ${'x'.repeat(500)}\n---\n# body\n`,
      'utf8'
    );
    const provider = createFilesystemSkillProviderV1({
      roots: [{ path: root, sourceScope: 'configured' }],
      watch: false,
      maxFrontmatterBytes: 64,
    });

    const observation = await provider.list({ id: 'bounded-scope' }, new AbortController().signal);

    expect(observation.complete).toBe(false);
    expect(observation.descriptors).toHaveLength(1);
    expect(observation.descriptors[0]).toMatchObject({ name: 'oversized-header' });
    expect(provider.stats()).toMatchObject({
      frontmatterPrefixBytes: 64,
      definitionReads: 0,
      incompleteObservations: 1,
    });
  });
});
