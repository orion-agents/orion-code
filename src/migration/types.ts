/**
 * Orion Code - Migration Types
 */

export interface BrandMigrationManifestV1 {
  version: 1;
  migrationId: string;
  sourceBrand: 'openhorse';
  targetBrand: 'orion-code';
  createdAt: string;
  completedAt?: string;
  dryRun: boolean;
  sourceRoot: string;
  targetRoot: string;
  sourceSnapshot: {
    fileCount: number;
    totalBytes: number;
    treeSha256: string;
  };
  outputSnapshot?: {
    fileCount: number;
    totalBytes: number;
    treeSha256: string;
  };
  renamedFiles: Array<{ from: string; to: string }>;
  copiedFiles: number;
  skippedFiles: Array<{ path: string; reason: string }>;
  conflicts: Array<{ path: string; reason: string }>;
  warnings: string[];
  verified: boolean;
}

export interface MigrationOptions {
  dryRun?: boolean;
  includeEnv?: boolean;
  includeProjectFiles?: boolean;
  /** Override home directory for testing. */
  home?: string;
}

export interface MigrationResult {
  success: boolean;
  manifest: BrandMigrationManifestV1;
}

export interface FileMapping {
  from: string;
  to: string;
  reason?: string;
}