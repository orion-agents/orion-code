/**
 * Orion Code - Migration Module
 */

export { migrateBrand, migrateProjectFiles, getMigrationHelp } from './migrate';
export { handleMigrateCommand, handleMigrateProjectCommand } from './command';
export type {
  BrandMigrationManifestV1,
  MigrationOptions,
  MigrationResult,
  FileMapping,
} from './types';