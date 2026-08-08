/**
 * Migration tool tests.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { migrateBrand, migrateProjectFiles } from '../src/migration/migrate';

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'orion-migration-'));
}

describe('brand migration', () => {
  test('dry-run detects missing source directory', () => {
    const home = makeHome();
    try {
      const result = migrateBrand({ dryRun: true, home });
      expect(result.success).toBe(true);
      expect(result.manifest.warnings[0]).toContain('does not exist');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('dry-run with source files reports counts without writing target', () => {
    const home = makeHome();
    const sourceDir = join(home, '.openhorse');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'openhorse.json'), JSON.stringify({
      defaultModel: 'gpt-4o',
      apiKey: 'sk-test',
    }), 'utf-8');
    writeFileSync(join(sourceDir, 'OPENHORSE.md'), '# User Instructions', 'utf-8');
    writeFileSync(join(sourceDir, 'settings.json'), '{}', 'utf-8');

    try {
      const result = migrateBrand({ dryRun: true, home });
      expect(result.success).toBe(true);
      expect(result.manifest.copiedFiles).toBeGreaterThan(0);
      expect(result.manifest.sourceSnapshot.fileCount).toBe(3);
      expect(existsSync(join(home, '.orion-code'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('dry-run does not block a later real migration (Issue #48)', () => {
    const home = makeHome();
    const sourceDir = join(home, '.openhorse');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'openhorse.json'), JSON.stringify({ defaultModel: 'gpt-4o' }), 'utf-8');
    writeFileSync(join(sourceDir, 'OPENHORSE.md'), '# User Instructions', 'utf-8');
    // A verbatim directory: on the buggy code the dry run copied this straight
    // into the target dir, which then blocked the real migration.
    const skillsDir = join(sourceDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'SKILL.md'), '---\nname: demo\n---', 'utf-8');

    try {
      // Default (dry-run) must not touch the real target directory.
      const dry = migrateBrand({ dryRun: true, home });
      expect(dry.success).toBe(true);
      expect(existsSync(join(home, '.orion-code'))).toBe(false);

      // A subsequent real migration must now succeed (it was previously blocked
      // because the dry run had written into the target dir).
      const real = migrateBrand({ dryRun: false, home });
      expect(real.success).toBe(true);
      expect(real.manifest.verified).toBe(true);
      expect(existsSync(join(home, '.orion-code', 'orion.json'))).toBe(true);
      expect(existsSync(join(home, '.orion-code', 'skills', 'SKILL.md'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('fails when target directory already exists', () => {
    const home = makeHome();
    const sourceDir = join(home, '.openhorse');
    const targetDir = join(home, '.orion-code');
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(sourceDir, 'openhorse.json'), '{}', 'utf-8');
    writeFileSync(join(targetDir, 'existing.txt'), 'existing', 'utf-8');

    try {
      const result = migrateBrand({ home });
      expect(result.success).toBe(false);
      expect(result.manifest.conflicts.length).toBeGreaterThan(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('migrates config files with renaming', () => {
    const home = makeHome();
    const sourceDir = join(home, '.openhorse');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'openhorse.json'), JSON.stringify({
      defaultModel: 'gpt-4o',
      apiKey: 'sk-test',
    }), 'utf-8');
    writeFileSync(join(sourceDir, 'OPENHORSE.md'), '# User Instructions', 'utf-8');
    writeFileSync(join(sourceDir, 'OPENHORSE.local.md'), '# Local', 'utf-8');

    const skillsDir = join(sourceDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'SKILL.md'), '---\nname: test\n---\nTest', 'utf-8');

    try {
      const result = migrateBrand({ home });
      expect(result.success).toBe(true);
      expect(result.manifest.verified).toBe(true);

      const targetDir = join(home, '.orion-code');
      expect(existsSync(targetDir)).toBe(true);
      expect(existsSync(join(targetDir, 'orion.json'))).toBe(true);
      expect(existsSync(join(targetDir, 'ORION.md'))).toBe(true);
      expect(existsSync(join(targetDir, 'ORION.local.md'))).toBe(true);
      expect(existsSync(join(targetDir, 'skills', 'SKILL.md'))).toBe(true);

      expect(existsSync(sourceDir)).toBe(true);
      expect(existsSync(join(sourceDir, 'openhorse.json'))).toBe(true);

      expect(existsSync(join(targetDir, 'migration-logs', 'openhorse'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('does not migrate a legacy .openhorse.env file', () => {
    const home = makeHome();
    const sourceDir = join(home, '.openhorse');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'openhorse.json'), '{}', 'utf-8');
    writeFileSync(join(home, '.openhorse.env'), 'OPENHORSE_API_KEY=foo\n', 'utf-8');

    try {
      const result = migrateBrand({ home });
      expect(result.success).toBe(true);
      // .env migration was removed; the legacy env file is left untouched.
      expect(existsSync(join(home, '.orion-code.env'))).toBe(false);
      expect(result.manifest.warnings.find(w => w.includes('.openhorse.env'))).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('project file migration', () => {
  test('renames .openhorse/ to .orion-code/ in project directory', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orion-project-migrate-'));
    const openhorseDir = join(tempDir, '.openhorse');
    const skillsDir = join(openhorseDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(openhorseDir, 'config.json'), '{}', 'utf-8');
    writeFileSync(join(skillsDir, 'SKILL.md'), '---\nname: test\n---\nTest', 'utf-8');

    try {
      const result = migrateProjectFiles(tempDir);
      expect(result.success).toBe(true);
      expect(result.renamed.length).toBe(1);

      expect(existsSync(join(tempDir, '.orion-code'))).toBe(true);
      expect(existsSync(join(tempDir, '.orion-code', 'skills', 'SKILL.md'))).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('reports conflict when target already exists', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orion-project-conflict-'));
    const srcDir = join(tempDir, '.openhorse');
    const destDir = join(tempDir, '.orion-code');
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(srcDir, 'config.json'), '{}', 'utf-8');
    writeFileSync(join(destDir, 'config.json'), '{}', 'utf-8');

    try {
      const result = migrateProjectFiles(tempDir);
      expect(result.success).toBe(false);
      expect(result.conflicts.length).toBeGreaterThan(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('dry-run reports renames without writing', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orion-project-dryrun-'));
    const srcDir = join(tempDir, '.openhorse');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'config.json'), '{}', 'utf-8');

    try {
      const result = migrateProjectFiles(tempDir, { dryRun: true });
      expect(result.success).toBe(true);
      expect(result.renamed.length).toBe(1);
      expect(existsSync(join(tempDir, '.orion-code'))).toBe(false);
      expect(existsSync(join(tempDir, '.openhorse'))).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('/migrate CLI command', () => {
  test('renders help text', () => {
    const { handleMigrateCommand } = require('../src/migration/command');
    const logs: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    try {
      const result = handleMigrateCommand({} as any, '--help');
      expect(result.success).toBe(true);
      expect(logs.join('\n')).toContain('orion migrate openhorse');
      expect(logs.join('\n')).toContain('--dry-run');
    } finally {
      jest.restoreAllMocks();
    }
  });

  test('defaults to a dry run and requires --yes before writing', () => {
    const migrateModule = require('../src/migration/migrate');
    const migrateSpy = jest.spyOn(migrateModule, 'migrateBrand').mockReturnValue({
      success: true,
      manifest: {
        warnings: [],
        conflicts: [],
        copiedFiles: 2,
        sourceRoot: '/tmp/.openhorse',
        targetRoot: '/tmp/.orion-code',
        sourceSnapshot: { fileCount: 2, totalBytes: 128 },
        renamedFiles: [],
      },
    });
    const { handleMigrateCommand } = require('../src/migration/command');
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      expect(handleMigrateCommand({} as any, 'openhorse').success).toBe(true);
      expect(migrateSpy).toHaveBeenLastCalledWith(expect.objectContaining({ dryRun: true }));

      expect(handleMigrateCommand({} as any, 'openhorse --yes').success).toBe(true);
      expect(migrateSpy).toHaveBeenLastCalledWith(expect.objectContaining({ dryRun: false }));
    } finally {
      jest.restoreAllMocks();
    }
  });

  test('exposes migration as a direct pre-config CLI command', () => {
    const output = execFileSync(
      process.execPath,
      ['-r', 'ts-node/register', 'src/cli.ts', 'migrate', '--help'],
      { cwd: join(__dirname, '..'), encoding: 'utf-8' }
    );

    expect(output).toContain('orion migrate openhorse');
    expect(output).toContain('--yes');
    expect(output).toContain('preview-only');
  });
});
