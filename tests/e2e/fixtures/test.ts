import { expect, test as base, type TestInfo } from '@playwright/test';

import type { WebE2EArtifactStateV1 } from './artifact-types';
import { loadWebE2EArtifactState } from './artifact';
import { createWebE2EEvidenceCollector, type WebE2EEvidenceCollector } from './evidence';
import { startOpenAiProviderFixture, type OpenAiProviderFixture } from './openai-provider';
import { startOrionHost, type OrionHostHandle } from './orion-host';
import { createWorkspaceFixture, type WorkspaceFixture } from './workspace';
import { waitForWorkbenchReady } from './ui';
import { webE2ERunnerIdentity, webE2EScenarioIdFromTitle } from '../scenarios';

interface WebE2ETestFixtures {
  readonly provider: OpenAiProviderFixture;
  readonly workspace: WorkspaceFixture;
  readonly evidence: WebE2EEvidenceCollector;
  readonly host: OrionHostHandle;
}

interface WebE2EWorkerFixtures {
  readonly artifactState: WebE2EArtifactStateV1;
}

export const test = base.extend<WebE2ETestFixtures, WebE2EWorkerFixtures>({
  artifactState: [
    async ({}, use) => {
      await use(loadWebE2EArtifactState());
    },
    { scope: 'worker' },
  ],

  provider: async ({}, use) => {
    const provider = await startOpenAiProviderFixture();
    try {
      await use(provider);
    } finally {
      provider.releaseHeldResponses();
      await provider.close();
    }
  },

  workspace: async ({ provider }, use) => {
    const workspace = createWorkspaceFixture({
      baseUrl: provider.baseUrl,
      installEnvironment: false,
      includeMcp: true,
    });
    try {
      await use(workspace);
    } finally {
      workspace.cleanup();
    }
  },

  evidence: async ({ artifactState, browser, workspace }, use, testInfo) => {
    const collector = createWebE2EEvidenceCollector({
      state: artifactState,
      scenarioId: scenarioId(testInfo),
      privatePaths: {
        [workspace.rootDirectory]: '<FIXTURE_ROOT>',
        [workspace.primaryWorkspace]: '<PRIMARY_WORKSPACE>',
        [workspace.secondaryWorkspace]: '<SECONDARY_WORKSPACE>',
        [workspace.configDirectory]: '<CONFIG_ROOT>',
      },
      secretValues: [workspace.environment.ORION_CODE_API_KEY],
    });
    collector.setBrowserIdentity(browser.browserType().name(), browser.version());
    const runner = webE2ERunnerIdentity();
    collector.recordFact('release.runner_name', runner.name);
    collector.recordFact('release.runner_image', runner.image);
    collector.recordFact('release.runner_digest', runner.digest);
    collector.recordFact('release.chrome_channel', runner.chromeChannel);
    let teardownError: Error | undefined;
    try {
      await use(collector);
    } finally {
      const counters = collector.snapshotCounters();
      const unexpected = unexpectedEvidence(counters, testInfo, collector);
      // Skipped and expected-to-fail scenarios still lack release evidence.
      // Only an ordinary pass may be sealed as `pass` in the fail-closed manifest.
      const testPassed = testInfo.status === 'passed' && testInfo.expectedStatus === 'passed';
      const status = testPassed && unexpected.length === 0 ? 'pass' : 'fail';
      collector.finalize(
        status,
        unexpected.length > 0
          ? `Unexpected browser evidence: ${unexpected.join(', ')}`
          : testPassed
            ? undefined
            : `Playwright status ${testInfo.status ?? 'unknown'} (expected ${testInfo.expectedStatus})`
      );
      if (testPassed && unexpected.length > 0) {
        teardownError = new Error(`Unexpected browser evidence: ${unexpected.join(', ')}`);
      }
    }
    if (teardownError) throw teardownError;
  },

  host: async ({ artifactState, evidence, workspace }, use) => {
    const host = await startOrionHost({
      state: artifactState,
      workspace: workspace.primaryWorkspace,
      configRoot: workspace.configDirectory,
      environment: workspace.environment,
      evidence,
    });
    try {
      await use(host);
    } finally {
      await host.stop();
    }
  },

  page: async ({ evidence, host, page }, use) => {
    await installSseCapture(page);
    const detach = evidence.attachPage(page);
    try {
      await page.goto(host.url, { waitUntil: 'domcontentloaded' });
      await waitForWorkbenchReady(page, { timeout: 30_000 });
      await use(page);
    } finally {
      detach();
    }
  },
});

export { expect };

export function allowExpectedNetworkFailures(testInfo: TestInfo, maximum: number): void {
  if (!Number.isSafeInteger(maximum) || maximum < 0) {
    throw new Error('Expected network failure maximum must be a non-negative integer.');
  }
  testInfo.annotations.push({
    type: 'evidence:allow-network-failures',
    description: String(maximum),
  });
}

export async function capturedSseEvents(page: import('@playwright/test').Page): Promise<unknown[]> {
  return page.evaluate(() => {
    const value = (globalThis as unknown as { __orionE2EEvents?: unknown[] }).__orionE2EEvents;
    return structuredClone(value ?? []);
  });
}

export async function closeCapturedEventSources(
  page: import('@playwright/test').Page
): Promise<number> {
  return page.evaluate(() => {
    const sources = (globalThis as unknown as { __orionE2EEventSources?: Set<EventSource> })
      .__orionE2EEventSources;
    const count = sources?.size ?? 0;
    for (const source of sources ?? []) source.close();
    return count;
  });
}

function scenarioId(testInfo: TestInfo): string {
  return webE2EScenarioIdFromTitle(testInfo.titlePath.join(' '));
}

function unexpectedEvidence(
  counters: ReturnType<WebE2EEvidenceCollector['snapshotCounters']>,
  testInfo: TestInfo,
  evidence: WebE2EEvidenceCollector
): string[] {
  const allowedNetworkFailures = Math.max(
    0,
    ...testInfo.annotations
      .filter(annotation => annotation.type === 'evidence:allow-network-failures')
      .map(annotation => Number(annotation.description ?? 0))
      .filter(Number.isSafeInteger)
  );
  return [
    evidence.unmatchedExpectedConsoleErrors().length
      ? `${evidence.unmatchedExpectedConsoleErrors().length} expected console error(s) missing`
      : '',
    counters.consoleErrors ? `${counters.consoleErrors} console error(s)` : '',
    counters.consoleWarnings ? `${counters.consoleWarnings} console warning(s)` : '',
    counters.pageErrors ? `${counters.pageErrors} page error(s)` : '',
    counters.http5xx ? `${counters.http5xx} HTTP 5xx response(s)` : '',
    counters.secretFindings ? `${counters.secretFindings} secret finding(s)` : '',
    counters.networkFailures > allowedNetworkFailures
      ? `${counters.networkFailures} network failure(s), maximum ${allowedNetworkFailures}`
      : '',
  ].filter(Boolean);
}

export async function installSseCapture(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    const events: unknown[] = [];
    const sources = new Set<EventSource>();
    Object.defineProperty(globalThis, '__orionE2EEvents', {
      configurable: false,
      enumerable: false,
      value: events,
      writable: false,
    });
    Object.defineProperty(globalThis, '__orionE2EEventSources', {
      configurable: false,
      enumerable: false,
      value: sources,
      writable: false,
    });
    const NativeEventSource = globalThis.EventSource;
    class CapturingEventSource extends NativeEventSource {
      constructor(url: string | URL, eventSourceInitDict?: EventSourceInit) {
        super(url, eventSourceInitDict);
        sources.add(this);
        this.addEventListener('orion', raw => {
          try {
            events.push(JSON.parse((raw as MessageEvent<string>).data));
          } catch {
            events.push({ invalid: true });
          }
        });
      }

      close(): void {
        sources.delete(this);
        super.close();
      }
    }
    Object.defineProperty(globalThis, 'EventSource', {
      configurable: false,
      value: CapturingEventSource,
      writable: false,
    });
  });
}
