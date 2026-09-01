import { loadWebE2EArtifactState } from './fixtures/artifact';
import { aggregateWebE2EEvidence } from './fixtures/evidence';
import { expectedWebE2EScenarios } from './scenarios';

export default async function globalTeardown(): Promise<void> {
  const state = loadWebE2EArtifactState();
  const manifest = aggregateWebE2EEvidence(state, expectedWebE2EScenarios());
  process.stdout.write(
    `[web-e2e] decision=${manifest.decision} scenarios=${manifest.scenarios.length} ` +
      `evidence=${state.rawRoot}\n`
  );
}
