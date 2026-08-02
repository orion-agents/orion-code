import { readFileSync } from 'fs';
import { resolve } from 'path';

type PackageMetadata = {
  version?: unknown;
};

/**
 * Resolve the version from the package installed next to `src/` or `dist/`.
 *
 * `npm_package_version` is only a fallback: when Orion is launched from another
 * package's npm script that variable can describe the caller rather than Orion.
 */
export function resolvePackageVersion(): string {
  try {
    const packagePath = resolve(__dirname, '../../package.json');
    const metadata = JSON.parse(readFileSync(packagePath, 'utf8')) as PackageMetadata;
    if (typeof metadata.version === 'string' && metadata.version.trim()) {
      return metadata.version.trim();
    }
  } catch {
    // Packaged installs include package.json; retain a safe fallback for unusual embedders.
  }

  const npmVersion = process.env.npm_package_version?.trim();
  return npmVersion || '0.0.0';
}

/** The single runtime version used by CLI, MCP metadata, and HTTP user agents. */
export const PACKAGE_VERSION = resolvePackageVersion();

/** Stable outbound User-Agent for Orion-owned HTTP requests. */
export const ORION_USER_AGENT = `Orion-Code/${PACKAGE_VERSION}`;
