#!/usr/bin/env node

import { failClosedCli } from './release-tooling-common.mjs';
import {
  generateUpdateIndex,
  parseUpdateIndexArguments,
  updateIndexUsage,
} from './update-index-release.mjs';

await failClosedCli('orion.update-index-generation-error', async () => {
  const options = parseUpdateIndexArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${updateIndexUsage()}\n`);
    return;
  }
  const result = await generateUpdateIndex(options);
  process.stdout.write(
    `${JSON.stringify({
      kind: 'orion.update-index-generation-result',
      mode: 'DRY_RUN',
      release_status: 'NOT_RELEASABLE',
      index: result.indexPath,
      signature: result.signaturePath ?? null,
      public_key: result.publicKeyPath ?? null,
      index_sha256: result.indexSha256,
      external_actions: ['NOT_PUSHED', 'NOT_PUBLISHED', 'NOT_SIGNED_WITH_RELEASE_KEY'],
    })}\n`
  );
});
