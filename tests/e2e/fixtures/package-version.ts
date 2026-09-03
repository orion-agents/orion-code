import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The packaged artifact under test is bound to the source revision that
 * produced it, so the expected product version is read from the repository
 * manifest instead of being pinned per release. Keeps the E2E gate
 * version-agnostic across v0.3.x releases. (v0.3.5 P1-B)
 */
export function readRepositoryVersion(repositoryRoot: string): string {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as {
    version: string;
  };
  return manifest.version;
}
