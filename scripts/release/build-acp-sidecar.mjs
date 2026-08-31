#!/usr/bin/env node

import {
  buildAcpSidecar,
  buildAcpSidecarUsage,
  parseBuildAcpSidecarArguments,
} from './acp-sidecar-release.mjs';
import { failClosedCli } from './release-tooling-common.mjs';

await failClosedCli('orion.acp-sidecar-build-error', async () => {
  const options = parseBuildAcpSidecarArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${buildAcpSidecarUsage()}\n`);
    return;
  }
  const result = await buildAcpSidecar(options);
  process.stdout.write(
    `${JSON.stringify({
      kind: 'orion.acp-sidecar-build-result',
      release_status: 'NOT_RELEASABLE',
      archive: result.archivePath,
      receipt: result.receiptPath,
      marker: result.markerPath,
      external_actions: ['NOT_PUSHED', 'NOT_PUBLISHED', 'NOT_SIGNED', 'NOT_NOTARIZED'],
    })}\n`
  );
});
