import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  type ArtifactRecord,
  type ResearchArtifactStore,
  CasMismatchError,
  createFileArtifactStore,
  createMemoryArtifactStore,
  loadResearchPacket,
  saveResearchPacket,
  scopeKey,
} from '../src/runtime/subagents/research-artifact';
import { resolveCitations } from '../src/runtime/subagents/research-citation';
import { hashPacket } from '../src/runtime/subagents/research-contract';
import {
  RESEARCH_SCHEMA_VERSION,
  type ResearchPacket,
} from '../src/runtime/subagents/research-types';

function packet(summary: string, sources: ResearchPacket['sources'] = []): ResearchPacket {
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    packetId: 'pkt-1',
    projectPath: '/proj',
    sessionId: 'sess-1',
    request: {
      schemaVersion: RESEARCH_SCHEMA_VERSION,
      objective: 'durable research state',
      scope: { projectRoot: '/proj' },
      mode: 'mixed',
      maxSources: 50,
      maxFetchBytes: 1024,
      maxDurationMs: 1_000,
    },
    summary,
    claims: [],
    sources,
    gaps: [],
    risks: [],
    usage: {
      modelRequests: 1,
      toolCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      durationMs: 0,
      usageComplete: true,
    },
    createdAt: '2026-08-05T00:00:00.000Z',
  };
}

function replacementRecord(
  existing: ArtifactRecord,
  nextPacket: ResearchPacket,
  storedAt: string
): ArtifactRecord {
  return {
    version: existing.version + 1,
    casToken: hashPacket(nextPacket),
    packet: nextPacket,
    storedAt,
    previousTokens: [...existing.previousTokens, existing.casToken],
  };
}

function expectSingleConditionalWriter(
  first: ResearchArtifactStore,
  second: ResearchArtifactStore = first
): void {
  const scope = { projectPath: '/proj', sessionId: 'sess-1', packetId: 'pkt-1' };
  const key = scopeKey(scope);
  const seed = saveResearchPacket(first, packet('seed'), scope);
  const firstSnapshot = first.read(key)!;
  const secondSnapshot = second.read(key)!;

  expect(
    first.writeIfCas?.(
      key,
      seed.casToken,
      replacementRecord(firstSnapshot, packet('writer-a'), new Date(1).toISOString())
    )
  ).toBe(true);
  expect(
    second.writeIfCas?.(
      key,
      seed.casToken,
      replacementRecord(secondSnapshot, packet('writer-b'), new Date(2).toISOString())
    )
  ).toBe(false);
  expect(loadResearchPacket(first, scope)?.summary).toBe('writer-a');
}

describe('research persistence consistency (#102, #105)', () => {
  it('allows only one in-memory writer from the same CAS snapshot', () => {
    expectSingleConditionalWriter(createMemoryArtifactStore());
  });

  it('allows only one file-backed writer across store instances', () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'orion-research-cas-'));
    const previousConfigRoot = process.env.ORION_CODE_CONFIG_DIR;
    process.env.ORION_CODE_CONFIG_DIR = configRoot;
    try {
      expectSingleConditionalWriter(
        createFileArtifactStore('/project-under-test'),
        createFileArtifactStore('/project-under-test')
      );
    } finally {
      if (previousConfigRoot === undefined) delete process.env.ORION_CODE_CONFIG_DIR;
      else process.env.ORION_CODE_CONFIG_DIR = previousConfigRoot;
      rmSync(configRoot, { recursive: true, force: true });
    }
  });

  it('rejects an expected token when the scoped record is missing', () => {
    expect(() =>
      saveResearchPacket(
        createMemoryArtifactStore(),
        packet('missing'),
        { projectPath: '/proj', sessionId: 'missing' },
        { expectedToken: 'stale-token' }
      )
    ).toThrow(CasMismatchError);
  });

  it('persists resolved stale state under the matching CAS token', () => {
    const researchPacket = packet('resolved', [
      {
        id: 'src-old',
        kind: 'web_page',
        provider: 'test',
        retrievedAt: '2026-08-05T00:00:00.000Z',
        status: 'retrieved',
        canonicalUrl: 'https://example.com/doc',
        contentHash: 'old',
      },
      {
        id: 'src-new',
        kind: 'web_page',
        provider: 'test',
        retrievedAt: '2026-08-05T01:00:00.000Z',
        status: 'retrieved',
        canonicalUrl: 'https://example.com/doc',
        contentHash: 'new',
      },
    ]);
    const scope = {
      projectPath: '/proj',
      sessionId: 'sess-1',
      packetId: researchPacket.packetId,
    };
    const store = createMemoryArtifactStore();

    resolveCitations(researchPacket);
    const saved = saveResearchPacket(store, researchPacket, scope, { now: () => new Date(0) });
    const loaded = loadResearchPacket(store, scope)!;

    expect(loaded.sources.map(source => `${source.id}:${source.status}`)).toEqual([
      'src-old:stale',
      'src-new:retrieved',
    ]);
    expect(saved.casToken).toBe(hashPacket(loaded));
  });
});
