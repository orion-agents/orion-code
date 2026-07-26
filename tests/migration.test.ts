/**
 * Migration tool tests.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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

  test('migrates env file when --include-env is set', () => {
    const home = makeHome();
    const sourceDir = join(home, '.openhorse');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'openhorse.json'), '{}', 'utf-8');

    const envPath = join(home, '.openhorse.env');
    writeFileSync(envPath, [
      'OPENHORSE_API_KEY=sk-old-key',
      'OPENHORSE_MODEL=gpt-4o',
      'OTHER_VAR=keep-me',
      '# comment line',
    ].join('\n'), 'utf-8');

    try {
      const result = migrateBrand({ includeEnv: true, home });
      expect(result.success).toBe(true);

      const targetEnvPath = join(home, '.orion-code.env');
      expect(existsSync(targetEnvPath)).toBe(true);
      const migrated = readFileSync(targetEnvPath, 'utf8');
      expect(migrated).toContain('ORION_CODE_API_KEY=sk-old-key');
      expect(migrated).toContain('ORION_CODE_MODEL=gpt-4o');
      expect(migrated).toContain('OTHER_VAR=keep-me');
      expect(migrated).toContain('# comment line');
      expect(migrated).not.toContain('OPENHORSE_API_KEY');
      expect(migrated).not.toContain('OPENHORSE_MODEL');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('warns when env file exists but --include-env is not set', () => {
    const home = makeHome();
    const sourceDir = join(home, '.openhorse');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'openhorse.json'), '{}', 'utf-8');
    writeFileSync(join(home, '.openhorse.env'), 'OPENHORSE_API_KEY=foo\n', 'utf-8');

    try {
      const result = migrateBrand({ home });
      expect(result.success).toBe(true);
      const envWarning = result.manifest.warnings.find(w => w.includes('.openhorse.env'));
      expect(envWarning).toBeDefined();
      expect(existsSync(join(home, '.orion-code.env'))).toBe(false);
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
});