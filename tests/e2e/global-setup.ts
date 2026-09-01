import type { FullConfig } from '@playwright/test';

import { prepareWebE2EArtifact } from './fixtures/artifact';
import { initializeWebE2EEvidenceManifest } from './fixtures/evidence';

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const state = prepareWebE2EArtifact();
  initializeWebE2EEvidenceManifest(state);
  process.stdout.write(
    `[web-e2e] ${state.artifact.receipt.package.name}@${state.artifact.receipt.package.version} ` +
      `sha256=${state.artifact.receipt.tarball.sha256} source=${state.source}\n`
  );
}
