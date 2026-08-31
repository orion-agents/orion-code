#!/usr/bin/env node

import { verifyAcpSidecarReceipt } from './acp-sidecar-release.mjs';
import {
  failClosedCli,
  parseCliArguments,
  rejectUnknownOptions,
  requireOption,
} from './release-tooling-common.mjs';

await failClosedCli('orion.acp-sidecar-replay-error', async () => {
  const parsed = parseCliArguments(process.argv.slice(2));
  rejectUnknownOptions(parsed, new Set(['--receipt', '--archive']), new Set());
  const replay = await verifyAcpSidecarReceipt(
    requireOption(parsed, '--receipt'),
    parsed.values.get('--archive')
  );
  process.stdout.write(
    `${JSON.stringify({
      kind: 'orion.acp-sidecar-replay-result',
      status: 'PASS',
      release_status: replay.receipt.release_status,
      version: replay.receipt.source.version,
      target: replay.receipt.artifact.target,
      bindings: replay.receipt.bindings,
    })}\n`
  );
});
