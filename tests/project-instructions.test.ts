import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  findProjectRoot,
  loadProjectInstructionFiles,
  loadProjectInstructions,
  renderProjectInstructions,
} from '../src/services/project-instructions';

describe('project instructions loader', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openhorse-project-instructions-'));
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'packages', 'cli'), { recursive: true });
    mkdirSync(join(root, '.cursor', 'rules'), { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), 'Root agent rules\n');
    writeFileSync(join(root, 'CLAUDE.md'), 'Claude-compatible rules\n');
    writeFileSync(join(root, '.cursor', 'rules', 'style.mdc'), 'Cursor style rule\n');
    writeFileSync(join(root, 'packages', 'cli', 'AGENTS.md'), 'CLI-specific rules\n');
  });

  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it('finds the git project root from nested directories', () => {
    expect(findProjectRoot(join(root, 'packages', 'cli'))).toBe(root);
  });

  it('loads guidance files from root to current directory', () => {
    const files = loadProjectInstructionFiles(join(root, 'packages', 'cli'));

    expect(files.map(file => file.path)).toEqual([
      'AGENTS.md',
      'CLAUDE.md',
      '.cursor/rules/style.mdc',
      'packages/cli/AGENTS.md',
    ]);
    expect(files.map(file => file.content)).toEqual([
      'Root agent rules',
      'Claude-compatible rules',
      'Cursor style rule',
      'CLI-specific rules',
    ]);
  });

  it('renders override ordering and source paths', () => {
    const rendered = loadProjectInstructions(join(root, 'packages', 'cli'));

    expect(rendered).toContain('Project instructions loaded');
    expect(rendered.indexOf('## AGENTS.md')).toBeLessThan(rendered.indexOf('## packages/cli/AGENTS.md'));
    expect(rendered).toContain('Later sections are from more specific directories');
  });

  it('respects render budget', () => {
    const rendered = renderProjectInstructions(
      [
        {
          path: 'AGENTS.md',
          absolutePath: join(root, 'AGENTS.md'),
          content: 'x'.repeat(500),
          truncated: false,
        },
      ],
      { maxTotalChars: 80 }
    );

    expect(rendered).toContain('[truncated by instruction budget]');
    expect(rendered.length).toBeLessThan(320);
  });
});
