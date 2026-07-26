/**
 * Orion Code - Migration CLI command handler
 *
 * Provides the /migrate slash command and CLI entry point.
 */

import { migrateBrand, migrateProjectFiles, getMigrationHelp } from './migrate';
import type { CommandContext, CommandResult } from '../commands/types';

export function handleMigrateCommand(ctx: CommandContext, args: string = ''): CommandResult {
  const trimmed = args.trim();

  // Show help
  if (trimmed === '--help' || trimmed === '-h' || !trimmed || trimmed === 'openhorse --help') {
    console.log(getMigrationHelp());
    return { success: true };
  }

  // Parse subcommand
  if (!trimmed.startsWith('openhorse')) {
    console.log(getMigrationHelp());
    return { success: true };
  }

  const rest = trimmed.slice('openhorse'.length).trim();
  const flags = new Set(rest.split(/\s+/).filter(f => f.startsWith('--')));

  const options = {
    dryRun: flags.has('--dry-run'),
    includeEnv: flags.has('--include-env'),
    includeProjectFiles: flags.has('--include-project-files'),
  };

  const result = migrateBrand(options);

  if (result.manifest.warnings.length > 0) {
    console.log('Warnings:');
    for (const warning of result.manifest.warnings) {
      console.log(`  ⚠  ${warning}`);
    }
    console.log();
  }

  if (result.manifest.conflicts.length > 0) {
    console.log('Conflicts:');
    for (const conflict of result.manifest.conflicts) {
      console.log(`  ✗  ${conflict.path}: ${conflict.reason}`);
    }
    console.log();
  }

  if (options.dryRun) {
    console.log(`Dry run complete. ${result.manifest.copiedFiles} files would be migrated.`);
    console.log(`Source: ${result.manifest.sourceRoot}`);
    console.log(`Target: ${result.manifest.targetRoot}`);
    console.log(`Files: ${result.manifest.sourceSnapshot.fileCount} files, ${formatBytes(result.manifest.sourceSnapshot.totalBytes)}`);
    if (result.manifest.renamedFiles.length > 0) {
      console.log('\nRenamed files:');
      for (const rf of result.manifest.renamedFiles) {
        console.log(`  ${rf.from} → ${rf.to}`);
      }
    }
  } else if (result.success) {
    console.log(`Migration complete. ${result.manifest.copiedFiles} files migrated.`);
    console.log(`Manifest: migration-${result.manifest.migrationId}.json`);
    console.log(`Source ${result.manifest.sourceRoot} was left unchanged.`);
  }

  return { success: result.success };
}

export function handleMigrateProjectCommand(
  ctx: CommandContext,
  args: string = '',
): CommandResult {
  const trimmed = args.trim();
  const flags = new Set(trimmed.split(/\s+/).filter(f => f.startsWith('--')));

  const options = {
    dryRun: flags.has('--dry-run'),
  };

  const projectPath = ctx.cwd || process.cwd();
  const result = migrateProjectFiles(projectPath, options);

  for (const warning of result.warnings) {
    console.log(`  ⚠  ${warning}`);
  }

  for (const conflict of result.conflicts) {
    console.log(`  ✗  ${conflict.from} → ${conflict.to}: ${conflict.reason}`);
  }

  if (options.dryRun) {
    console.log(`Dry run: ${result.renamed.length} project files would be renamed.`);
    for (const rf of result.renamed) {
      console.log(`  ${rf.from} → ${rf.to}`);
    }
  } else if (result.success) {
    console.log(`Renamed ${result.renamed.length} project files.`);
  }

  return { success: result.success };
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}