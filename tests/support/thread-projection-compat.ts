import { readFileSync, writeFileSync } from 'fs';

import { getProjectThreadsV2IndexPath } from '../../src/product/paths';
import { digestRuntimeValue } from '../../src/runtime/protocol/canonical';
import type { ThreadProjectionV1 } from '../../src/runtime/thread-projection';

interface MutableCutoverIndexFixtureV1 {
  readonly version: 1;
  readonly generation: number;
  readonly sessions: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly digest: string;
}

/** Reproduce the projection digest emitted by the exact v0.3.2 projection shape. */
export function v032ProjectionDigest(projection: ThreadProjectionV1): string {
  const {
    digest: _digest,
    diagnosticEvents: _diagnosticEvents,
    compactEvents: _compactEvents,
    ...v032Content
  } = projection;
  void _digest;
  void _diagnosticEvents;
  void _compactEvents;
  return digestRuntimeValue(v032Content);
}

export function rewriteCutoverProjectionReceipt(input: {
  readonly projectPath: string;
  readonly sessionId: string;
  readonly projectionDigest: string;
  readonly projectionDigestVersion?: 1 | 2;
}): void {
  const path = getProjectThreadsV2IndexPath(input.projectPath);
  const current = JSON.parse(readFileSync(path, 'utf8')) as MutableCutoverIndexFixtureV1;
  const entry = current.sessions[input.sessionId];
  if (!entry) throw new Error(`Missing cutover fixture for Session ${input.sessionId}`);
  const { projectionDigestVersion: _projectionDigestVersion, ...entryContent } = entry;
  void _projectionDigestVersion;
  const nextEntry = {
    ...entryContent,
    projectionDigest: input.projectionDigest,
    ...(input.projectionDigestVersion === undefined
      ? {}
      : { projectionDigestVersion: input.projectionDigestVersion }),
  };
  const content = {
    version: current.version,
    generation: current.generation,
    sessions: { ...current.sessions, [input.sessionId]: nextEntry },
  };
  const next = { ...content, digest: digestRuntimeValue(content) };
  writeFileSync(path, `${JSON.stringify(next)}\n`, { mode: 0o600 });
}
