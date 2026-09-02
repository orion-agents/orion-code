import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { basename, join } from 'path';

import type { Browser, BrowserContext, Page, Request } from '@playwright/test';

import type {
  WebBootstrapV1,
  WebPageV1,
  WebSessionSnapshotV1,
  WebSessionSummaryV1,
} from '../../src/web/protocol';
import { browserGet, sessionSnapshot, webBootstrap } from './fixtures/api';
import { OPENAI_FIXTURE_MARKERS, OPENAI_FIXTURE_PROMPTS } from './fixtures/openai-provider';
import { startOrionHost } from './fixtures/orion-host';
import {
  allowExpectedNetworkFailures,
  closeCapturedEventSources,
  expect,
  installSseCapture,
  test,
} from './fixtures/test';
import {
  answerApproval,
  applySettings,
  createSession,
  openSessionNavigation,
  openSettings,
  selectSettingsSection,
  setSettingsPermission,
  submitPrompt,
  waitForApproval,
  waitForWorkbenchReady,
  workbenchUi,
} from './fixtures/ui';

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test('WEB33-P0-16 a running Session survives an immediate foreground switch', async ({
  evidence,
  page,
  provider,
}) => {
  const first = await createNamedSession(page, 'Parallel switch A');
  const eventRequests: string[] = [];
  const onRequest = (request: Request) => {
    if (new URL(request.url()).pathname === '/api/v1/events') eventRequests.push(request.url());
  };
  page.on('request', onRequest);

  await submitPrompt(page, `${OPENAI_FIXTURE_PROMPTS.parallelHold}:switch-a`);
  await provider.waitForRequest(
    request => request.scenario === 'parallel-hold' && request.lastUserText.endsWith(':switch-a')
  );
  await expectRuntimePhase(page, first.id, 'running');

  const second = await createNamedSession(page, 'Parallel switch B');
  await expect(activeSessionNamed(page, second.name)).toHaveAttribute('aria-current', 'page');
  await expect(workbenchUi(page).composer).toBeEnabled();
  await expect(sessionRowNamed(page, first.name)).toContainText('运行中');
  expect((await sessionSnapshot(page, first.id)).sessionRuntime.phase).toBe('running');

  await captureWorkbench(page, evidence, 'web33-p0-16-running-switch.png', '16');
  provider.releaseHeldResponses('parallel-hold');
  await activateNamedSession(page, first.name);
  await expect(orionMessage(page, `${OPENAI_FIXTURE_MARKERS.parallelHeld}:switch-a`)).toBeVisible({
    timeout: 45_000,
  });
  await expectRuntimePhase(page, first.id, 'idle');
  page.off('request', onRequest);

  expect(eventRequests).toHaveLength(0);
  evidence.recordFact('web33.running_switch_verified', true);
  evidence.recordFact('web33.background_turn_preserved', true);
  evidence.recordFact('web33.switch_sse_reconnects', eventRequests.length);
});

test('WEB33-P0-17 two Session actors run concurrently without transcript leakage', async ({
  evidence,
  page,
  provider,
}) => {
  const first = await createNamedSession(page, 'Concurrent actor A');
  await submitPrompt(page, `${OPENAI_FIXTURE_PROMPTS.parallelHold}:actor-a`);
  await provider.waitForRequest(
    request => request.scenario === 'parallel-hold' && request.lastUserText.endsWith(':actor-a')
  );

  const second = await createNamedSession(page, 'Concurrent actor B');
  await submitPrompt(page, `${OPENAI_FIXTURE_PROMPTS.parallelHold}:actor-b`);
  await provider.waitForRequest(
    request => request.scenario === 'parallel-hold' && request.lastUserText.endsWith(':actor-b')
  );

  const simultaneous = await Promise.all([
    sessionSnapshot(page, first.id),
    sessionSnapshot(page, second.id),
  ]);
  expect(simultaneous.map(value => value.sessionRuntime.phase)).toEqual(['running', 'running']);
  const parallelDiagnostics = await web33Diagnostics(page);
  expect(parallelDiagnostics.workspaceKernel).toMatchObject({
    participantCount: 3,
    closed: false,
    providerGate: { activeCount: 2, waitingCount: 0 },
  });
  await expect(sessionRowNamed(page, first.name)).toContainText('运行中');
  await expect(sessionRowNamed(page, second.name)).toContainText('运行中');
  await captureWorkbench(page, evidence, 'web33-p0-17-two-running.png', '17');

  provider.releaseHeldResponses('parallel-hold');
  await expect(orionMessage(page, `${OPENAI_FIXTURE_MARKERS.parallelHeld}:actor-b`)).toBeVisible({
    timeout: 45_000,
  });
  await expectRuntimePhase(page, second.id, 'idle');
  expect(await assistantContains(page, 'actor-a')).toBe(false);

  await activateNamedSession(page, first.name);
  await expect(orionMessage(page, `${OPENAI_FIXTURE_MARKERS.parallelHeld}:actor-a`)).toBeVisible({
    timeout: 45_000,
  });
  await expectRuntimePhase(page, first.id, 'idle');
  expect(await assistantContains(page, 'actor-b')).toBe(false);

  const requests = provider.requests.filter(request => request.scenario === 'parallel-hold');
  expect(requests).toHaveLength(2);
  evidence.recordFact('web33.parallel_peak_running', 2);
  evidence.recordFact('web33.parallel_provider_requests', requests.length);
  evidence.recordFact('web33.parallel_cross_session_leaks', 0);
  evidence.recordFact(
    'web33.workspace_kernel_participants',
    parallelDiagnostics.workspaceKernel.participantCount
  );
  evidence.recordFact(
    'web33.provider_gate_peak_active',
    parallelDiagnostics.workspaceKernel.providerGate.activeCount
  );
});

test('WEB33-P0-18 a background approval remains owned by its Session', async ({
  evidence,
  page,
  provider,
}) => {
  const approvalSession = await createNamedSession(page, 'Background approval A');
  await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.pendingApproval);
  await waitForApproval(page, 'write_file', { timeout: 45_000 });
  await expectRuntimePhase(page, approvalSession.id, 'waiting_approval');

  const foreground = await createNamedSession(page, 'Foreground work B');
  await expect(page.getByRole('region', { name: /^允许 .+？$/u })).toHaveCount(0);
  await submitPrompt(page, `${OPENAI_FIXTURE_PROMPTS.settingsProbe}:foreground-b`);
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.settingsProbeDone)).toBeVisible({
    timeout: 45_000,
  });
  await expectRuntimePhase(page, foreground.id, 'idle');
  await expect(sessionRowNamed(page, approvalSession.name)).toContainText('等待审批');

  await activateNamedSession(page, approvalSession.name);
  const approval = await waitForApproval(page, 'write_file', { timeout: 30_000 });
  await captureSurface(approval, evidence, 'web33-p0-18-background-approval.png', '18');
  await answerApproval(page, 'reject', 'write_file');
  await expectRuntimePhase(page, approvalSession.id, 'idle');
  expect(provider.requests.filter(request => request.scenario === 'pending')).toHaveLength(1);

  evidence.recordFact('web33.background_approval_preserved', true);
  evidence.recordFact('web33.foreground_turn_completed', true);
  evidence.recordFact('web33.background_approval_cross_leaks', 0);
});

test('WEB33-P0-19 same-workspace mutation tools are FIFO and never overlap', async ({
  evidence,
  page,
  provider,
  workspace,
}) => {
  await openSettings(page);
  await selectSettingsSection(page, 'Permissions');
  await setSettingsPermission(page, 'Allow');
  await applySettings(page, 1);
  await page.keyboard.press('Escape');

  const first = await createNamedSession(page, 'Mutation actor A');
  await submitPrompt(page, `${OPENAI_FIXTURE_PROMPTS.parallelMutation}:mutation-a`);
  await provider.waitForRequest(
    request =>
      request.scenario === 'parallel-mutation' && request.lastUserText.endsWith(':mutation-a')
  );
  await expectRuntimePhase(page, first.id, 'running');
  const mutationLockPath = workspace.primaryPath('.web33-mutation.lock');
  const mutationReleasePath = workspace.primaryPath('.web33-mutation-release');
  await expect.poll(() => existsSync(mutationLockPath), { timeout: 15_000 }).toBe(true);

  const second = await createNamedSession(page, 'Mutation actor B');
  await submitPrompt(page, `${OPENAI_FIXTURE_PROMPTS.parallelMutation}:mutation-b`);
  await provider.waitForRequest(
    request =>
      request.scenario === 'parallel-mutation' && request.lastUserText.endsWith(':mutation-b')
  );
  await expectRuntimePhase(page, second.id, 'running');
  await expect(
    page.getByRole('article', { name: /工具 exec_command：等待工作树写入/u })
  ).toBeVisible({ timeout: 30_000 });
  writeFileSync(mutationReleasePath, 'release\n', { flag: 'wx' });

  await expect(
    orionMessage(page, `${OPENAI_FIXTURE_MARKERS.parallelMutationDone}:mutation-b`)
  ).toBeVisible({ timeout: 60_000 });
  await expectRuntimePhase(page, second.id, 'idle');
  await activateNamedSession(page, first.name);
  await expect(
    orionMessage(page, `${OPENAI_FIXTURE_MARKERS.parallelMutationDone}:mutation-a`)
  ).toBeVisible({ timeout: 60_000 });
  await expectRuntimePhase(page, first.id, 'idle');

  const overlapPath = workspace.primaryPath('web33-mutation-overlap.txt');
  const orderPath = workspace.primaryPath('web33-mutation-order.txt');
  expect(existsSync(overlapPath)).toBe(false);
  expect(readFileSync(orderPath, 'utf8').trim().split('\n')).toEqual(['mutation-a', 'mutation-b']);
  await captureWorkbench(page, evidence, 'web33-p0-19-mutation-fifo.png', '19');

  evidence.recordFact('web33.workspace_mutation_overlap', 0);
  evidence.recordFact('web33.workspace_mutation_results', 2);
  evidence.recordFact('web33.workspace_mutation_fifo_verified', true);
  evidence.recordFact('web33.workspace_mutation_wait_visible', true);
});

test('WEB33-P0-20 two tabs keep independent selections and stale actor CAS has zero effects', async ({
  browser,
  evidence,
  host,
  page,
  provider,
}, testInfo) => {
  const first = await createNamedSession(page, 'Tab route A');
  const second = await createNamedSession(page, 'Tab route B');
  const secondary = await openObservedPage(browser, host.url, evidence);
  const secondaryFailures: NetworkFailure[] = [];
  const onSecondaryFailure = (request: Request) => secondaryFailures.push(networkFailure(request));
  secondary.page.on('requestfailed', onSecondaryFailure);

  try {
    await activateNamedSession(page, first.name);
    await activateNamedSession(secondary.page, second.name);
    await expect(activeSessionNamed(page, first.name)).toHaveAttribute('aria-current', 'page');
    await expect(activeSessionNamed(secondary.page, second.name)).toHaveAttribute(
      'aria-current',
      'page'
    );

    const stale = await sessionSnapshot(page, first.id);
    await submitPrompt(page, `${OPENAI_FIXTURE_PROMPTS.settingsProbe}:tab-a`);
    await submitPrompt(secondary.page, `${OPENAI_FIXTURE_PROMPTS.settingsProbe}:tab-b`);
    await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.settingsProbeDone)).toBeVisible({
      timeout: 45_000,
    });
    await expect(
      orionMessage(secondary.page, OPENAI_FIXTURE_MARKERS.settingsProbeDone)
    ).toBeVisible({ timeout: 45_000 });
    await Promise.all([
      expectRuntimePhase(page, first.id, 'idle'),
      expectRuntimePhase(secondary.page, second.id, 'idle'),
    ]);

    const firstSnapshot = await sessionSnapshot(page, first.id);
    const secondSnapshot = await sessionSnapshot(page, second.id);
    expect(snapshotText(firstSnapshot)).toContain(':tab-a');
    expect(snapshotText(firstSnapshot)).not.toContain(':tab-b');
    expect(snapshotText(secondSnapshot)).toContain(':tab-b');
    expect(snapshotText(secondSnapshot)).not.toContain(':tab-a');

    const beforeStale = provider.requests.length;
    const conflict = await hostCommand(host.url, {
      bootstrap: await hostBootstrap(host.url),
      sessionId: first.id,
      runtimeRevision: stale.sessionRuntime.runtimeRevision,
      text: `${OPENAI_FIXTURE_PROMPTS.settingsProbe}:must-not-run`,
    });
    expect(conflict.status).toBe(409);
    expect(problemCode(conflict.body)).toBe('session_runtime_revision_conflict');
    expect(provider.requests).toHaveLength(beforeStale);
    expect(snapshotText(await sessionSnapshot(page, first.id))).not.toContain('must-not-run');

    await captureWorkbench(page, evidence, 'web33-p0-20-two-tab-routing.png', '20');
    evidence.recordFact('web33.two_tab_selection_independent', true);
    evidence.recordFact('web33.explicit_session_routing_verified', true);
    evidence.recordFact('web33.stale_runtime_status', conflict.status);
    evidence.recordFact('web33.stale_runtime_side_effects', 0);
  } finally {
    const closed = await closeCapturedEventSources(secondary.page);
    if (closed > 0) {
      await expect.poll(() => secondaryFailures.length, { timeout: 10_000 }).toBeGreaterThan(0);
    }
    secondary.page.off('requestfailed', onSecondaryFailure);
    expect(secondaryFailures.every(isExpectedClosedSseFailure)).toBe(true);
    allowExpectedNetworkFailures(testInfo, secondaryFailures.length);
    secondary.detach();
    await secondary.context.close();
  }
});

test('WEB33-P0-21 warm and 10k-message cold switches stay page-bounded', async ({
  artifactState,
  browser,
  evidence,
  host,
  workspace,
}) => {
  await host.stop();
  const longSessionId = seedInstalledLongSession(
    artifactState.installation.packageRoot,
    workspace.primaryWorkspace,
    workspace.configDirectory,
    host.homeDirectory,
    10_000
  );
  const replacement = await startOrionHost({
    state: artifactState,
    workspace: workspace.primaryWorkspace,
    configRoot: workspace.configDirectory,
    environment: workspace.environment,
    evidence,
    port: host.port,
  });
  const observed = await openObservedPage(browser, replacement.url, evidence);
  const requests: Array<{ readonly method: string; readonly path: string }> = [];
  const onRequest = (request: Request) => {
    requests.push({ method: request.method(), path: new URL(request.url()).pathname });
  };
  observed.page.on('request', onRequest);

  try {
    const warm = await createNamedSession(observed.page, 'Warm switch session');
    const performanceBefore = await web33Diagnostics(observed.page);
    requests.length = 0;
    const cold = await measuredActivate(observed.page, 'Long 10k session');
    expect(cold.elapsedMs).toBeLessThanOrEqual(800);
    let maximumSnapshotPages = snapshotRequestCount(requests);
    let catalogRequestCount = forbiddenCatalogRequestCount(requests);
    let eventRequestCount = eventStreamRequestCount(requests);
    const coldSnapshot = await sessionSnapshot(observed.page, longSessionId);
    expect(coldSnapshot.session.messageCount).toBe(10_000);
    expect(coldSnapshot.transcript.items.length).toBeLessThanOrEqual(100);
    const coldSnapshotBytes = Buffer.byteLength(JSON.stringify(coldSnapshot), 'utf8');

    const warmSamples: number[] = [];
    for (let index = 0; index < 15; index += 1) {
      requests.length = 0;
      warmSamples.push((await measuredActivate(observed.page, warm.name)).elapsedMs);
      maximumSnapshotPages = Math.max(maximumSnapshotPages, snapshotRequestCount(requests));
      catalogRequestCount += forbiddenCatalogRequestCount(requests);
      eventRequestCount += eventStreamRequestCount(requests);
      requests.length = 0;
      warmSamples.push((await measuredActivate(observed.page, 'Long 10k session')).elapsedMs);
      maximumSnapshotPages = Math.max(maximumSnapshotPages, snapshotRequestCount(requests));
      catalogRequestCount += forbiddenCatalogRequestCount(requests);
      eventRequestCount += eventStreamRequestCount(requests);
    }
    const warmP95 = percentile(warmSamples, 0.95);
    expect(warmP95).toBeLessThanOrEqual(150);
    expect(maximumSnapshotPages).toBeLessThanOrEqual(1);
    expect(catalogRequestCount).toBe(0);
    expect(eventRequestCount).toBe(0);
    const performanceAfter = await web33Diagnostics(observed.page);
    const logScanDelta =
      performanceAfter.performance.thread.eventStore.logScans -
      performanceBefore.performance.thread.eventStore.logScans;
    const logBytesDelta =
      performanceAfter.performance.thread.eventStore.bytesScanned -
      performanceBefore.performance.thread.eventStore.bytesScanned;
    const indexBuildDelta =
      performanceAfter.performance.thread.sessionIndex.indexBuilds -
      performanceBefore.performance.thread.sessionIndex.indexBuilds;
    const indexBytesDelta =
      performanceAfter.performance.thread.sessionIndex.bytesRead -
      performanceBefore.performance.thread.sessionIndex.bytesRead;
    const replayResetDelta =
      performanceAfter.eventStream.replayResets - performanceBefore.eventStream.replayResets;
    expect(
      logScanDelta,
      `Thread log scan reasons: ${JSON.stringify(performanceAfter.performance.thread.eventStore.scanReasons)}`
    ).toBe(0);
    expect(logBytesDelta).toBe(0);
    expect(indexBuildDelta).toBe(0);
    expect(indexBytesDelta).toBeLessThanOrEqual(1024 * 1024);
    expect(coldSnapshotBytes).toBeLessThanOrEqual(256 * 1024);
    expect(replayResetDelta).toBe(0);

    await captureWorkbench(observed.page, evidence, 'web33-p0-21-long-session.png', '21');
    evidence.recordFact('web33.warm_switch_p95_ms', roundMetric(warmP95));
    evidence.recordFact('web33.warm_switch_p50_ms', roundMetric(percentile(warmSamples, 0.5)));
    evidence.recordFact('web33.warm_switch_max_ms', roundMetric(Math.max(...warmSamples)));
    evidence.recordFact('web33.warm_switch_samples', warmSamples.length);
    evidence.recordFact('web33.cold_switch_ms', roundMetric(cold.elapsedMs));
    evidence.recordFact('web33.warm_switch_budget', warmP95 <= 150);
    evidence.recordFact('web33.cold_switch_budget', cold.elapsedMs <= 800);
    evidence.recordFact('web33.long_session_messages', coldSnapshot.session.messageCount);
    evidence.recordFact('web33.switch_snapshot_pages_max', maximumSnapshotPages);
    evidence.recordFact('web33.switch_catalog_requests', catalogRequestCount);
    evidence.recordFact('web33.switch_sse_reconnects', eventRequestCount);
    evidence.recordFact('web33.switch_replay_resets', replayResetDelta);
    evidence.recordFact('web33.switch_log_scans', logScanDelta);
    evidence.recordFact('web33.switch_log_bytes_scanned', logBytesDelta);
    evidence.recordFact('web33.switch_index_builds', indexBuildDelta);
    evidence.recordFact('web33.switch_index_bytes_read', indexBytesDelta);
    evidence.recordFact('web33.switch_snapshot_bytes', coldSnapshotBytes);
    evidence.recordFact('web33.switch_index_bytes_budget', indexBytesDelta <= 1024 * 1024);
    evidence.recordFact('web33.switch_snapshot_bytes_budget', coldSnapshotBytes <= 256 * 1024);
  } finally {
    observed.page.off('request', onRequest);
    observed.detach();
    await observed.context.close();
    await replacement.stop();
  }
});

test('WEB33-P0-22 a fourth turn is visible, cancellable, and absent after restart', async ({
  artifactState,
  evidence,
  host,
  page,
  provider,
  workspace,
}, testInfo) => {
  const sessions = [];
  for (const name of ['Pool A', 'Pool B', 'Pool C', 'Pool D']) {
    sessions.push(await createNamedSession(page, name));
  }

  for (const session of sessions.slice(0, 3)) {
    await activateNamedSession(page, session.name);
    await submitPrompt(
      page,
      `${OPENAI_FIXTURE_PROMPTS.parallelHold}:${session.name.toLowerCase()}`
    );
    await provider.waitForRequest(
      request =>
        request.scenario === 'parallel-hold' &&
        request.lastUserText.endsWith(session.name.toLowerCase())
    );
    await expectRuntimePhase(page, session.id, 'running');
  }
  expect(provider.requests.filter(request => request.scenario === 'parallel-hold')).toHaveLength(3);

  const fourth = sessions[3];
  await activateNamedSession(page, fourth.name);
  await submitPrompt(page, `${OPENAI_FIXTURE_PROMPTS.parallelHold}:pool-d`, {
    waitForEcho: false,
  });
  await expectRuntimePhase(page, fourth.id, 'queued');
  await expect(workbenchUi(page).composer).toHaveAttribute('placeholder', /第 1 位/u);
  await expect(page.getByRole('button', { name: '取消排队', exact: true })).toBeVisible();
  await expect(sessionRowNamed(page, fourth.name)).toContainText('排队 1');
  await captureWorkbench(page, evidence, 'web33-p0-22-fourth-queued.png', '22');

  await page.getByRole('button', { name: '取消排队', exact: true }).click();
  await expectRuntimePhase(page, fourth.id, 'idle');
  await expect(page.getByRole('button', { name: '取消排队', exact: true })).toHaveCount(0);
  expect(
    provider.requests.filter(
      request => request.scenario === 'parallel-hold' && request.lastUserText.endsWith(':pool-d')
    )
  ).toHaveLength(0);
  expect(snapshotText(await sessionSnapshot(page, fourth.id))).not.toContain(':pool-d');

  provider.releaseHeldResponses('parallel-hold');
  for (const session of sessions.slice(0, 3)) {
    await expectRuntimePhase(page, session.id, 'idle');
  }

  const shutdownRunning = sessions[0];
  await activateNamedSession(page, shutdownRunning.name);
  await submitPrompt(page, `${OPENAI_FIXTURE_PROMPTS.parallelHold}:shutdown-running-a`);
  await provider.waitForRequest(
    request =>
      request.scenario === 'parallel-hold' && request.lastUserText.endsWith(':shutdown-running-a')
  );
  await expectRuntimePhase(page, shutdownRunning.id, 'running');

  const shutdownApproval = sessions[1];
  await activateNamedSession(page, shutdownApproval.name);
  await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.pendingApproval);
  await provider.waitForRequest(request => request.scenario === 'pending');
  await waitForApproval(page, 'write_file', { timeout: 30_000 });
  await expectRuntimePhase(page, shutdownApproval.id, 'waiting_approval');

  const shutdownRunningSecond = sessions[2];
  await activateNamedSession(page, shutdownRunningSecond.name);
  await submitPrompt(page, `${OPENAI_FIXTURE_PROMPTS.parallelHold}:shutdown-running-c`);
  await provider.waitForRequest(
    request =>
      request.scenario === 'parallel-hold' && request.lastUserText.endsWith(':shutdown-running-c')
  );
  await expectRuntimePhase(page, shutdownRunningSecond.id, 'running');

  await activateNamedSession(page, fourth.name);
  await submitPrompt(page, `${OPENAI_FIXTURE_PROMPTS.parallelHold}:shutdown-queued-d`, {
    waitForEcho: false,
  });
  await expectRuntimePhase(page, fourth.id, 'queued');
  const providerRequestsBeforeShutdown = provider.requests.length;
  const pendingBeforeShutdown = (await sessionSnapshot(page, shutdownApproval.id)).pendingApprovals
    .length;
  expect(pendingBeforeShutdown).toBe(1);
  await captureWorkbench(page, evidence, 'web33-p0-22-shutdown-state.png', '22-shutdown');

  const failures: NetworkFailure[] = [];
  const onFailure = (request: Request) => failures.push(networkFailure(request));
  page.on('requestfailed', onFailure);
  // Stop the live stream before intentionally taking the Host down. Otherwise
  // terminal runtime edges can race client-triggered snapshot refreshes with
  // the listener shutdown and produce unrelated connection-refused noise.
  expect(await closeCapturedEventSources(page)).toBe(1);
  const gracefulExit = await host.stop();
  expect(gracefulExit).toEqual({ code: 0, signal: null });
  const replacement = await startOrionHost({
    state: artifactState,
    workspace: workspace.primaryWorkspace,
    configRoot: workspace.configDirectory,
    environment: workspace.environment,
    evidence,
    port: host.port,
  });
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForWorkbenchReady(page, { timeout: 30_000 });
    const restartedQueued = await sessionSnapshot(page, fourth.id);
    expect(restartedQueued.sessionRuntime.phase).toBe('cold');
    expect(restartedQueued.sessionRuntime.queueId).toBeUndefined();
    expect(restartedQueued.sessionRuntime.queuePosition).toBeUndefined();
    expect(snapshotText(restartedQueued)).not.toContain(':shutdown-queued-d');
    const restartedRunning = await sessionSnapshot(page, shutdownRunning.id);
    const restartedApproval = await sessionSnapshot(page, shutdownApproval.id);
    const restartedRunningSecond = await sessionSnapshot(page, shutdownRunningSecond.id);
    expect(restartedRunning.sessionRuntime.phase).toBe('interrupted');
    expect(restartedApproval.sessionRuntime.phase).toBe('interrupted');
    expect(restartedRunningSecond.sessionRuntime.phase).toBe('interrupted');
    expect(restartedApproval.pendingApprovals).toHaveLength(0);
    await expect(sessionRowNamed(page, fourth.name)).not.toContainText('排队');
    await assertProviderRequestCountStable(provider, providerRequestsBeforeShutdown, 1_500);
  } finally {
    page.off('requestfailed', onFailure);
    await replacement.stop();
  }
  expect(failures.every(isExpectedRestartFailure)).toBe(true);
  allowExpectedNetworkFailures(testInfo, failures.length);

  evidence.recordFact('web33.max_running_sessions', 3);
  evidence.recordFact('web33.fourth_queue_position', 1);
  evidence.recordFact('web33.fourth_queue_cancelled', true);
  evidence.recordFact('web33.fourth_provider_requests', 0);
  evidence.recordFact('web33.restart_ghost_queue_items', 0);
  evidence.recordFact('web33.graceful_shutdown_exit_code', 0);
  evidence.recordFact('web33.restart_interrupted_sessions', 3);
  evidence.recordFact('web33.pending_approvals_before_shutdown', pendingBeforeShutdown);
  evidence.recordFact('web33.pending_approvals_after_restart', 0);
  evidence.recordFact('web33.restart_provider_replays', 0);
});

interface NamedSession {
  readonly id: string;
  readonly name: string;
}

interface NetworkFailure {
  readonly method: string;
  readonly path: string;
  readonly error: string;
}

interface Web33Diagnostics {
  readonly eventStream: { readonly replayResets: number };
  readonly workspaceKernel: {
    readonly participantCount: number;
    readonly closed: boolean;
    readonly providerGate: { readonly activeCount: number; readonly waitingCount: number };
  };
  readonly performance: {
    readonly thread: {
      readonly eventStore: {
        readonly logScans: number;
        readonly bytesScanned: number;
        readonly eventsScanned: number;
        readonly scanReasons: Readonly<Record<string, number>>;
      };
      readonly sessionIndex: {
        readonly indexBuilds: number;
        readonly manifestReads: number;
        readonly pageReads: number;
        readonly bytesRead: number;
      };
    };
  };
}

async function web33Diagnostics(page: Page): Promise<Web33Diagnostics> {
  const context = await webBootstrap(page);
  const result = await browserGet<Web33Diagnostics>(
    page,
    `/api/v1/diagnostics?${new URLSearchParams({
      workspaceId: context.workspaceId,
      expectedContextRevision: context.contextRevision,
    }).toString()}`
  );
  if (result.status !== 200) {
    throw new Error(`Diagnostics failed with HTTP ${result.status}.`);
  }
  return result.body;
}

async function createNamedSession(page: Page, name: string): Promise<NamedSession> {
  await createSession(page, { name, timeout: 30_000 });
  const context = await webBootstrap(page);
  const result = await browserGet<WebPageV1<WebSessionSummaryV1>>(
    page,
    `/api/v1/workspaces/${encodeURIComponent(context.workspaceId)}/sessions?${new URLSearchParams({
      workspaceId: context.workspaceId,
      expectedContextRevision: context.contextRevision,
      pageSize: '100',
    }).toString()}`
  );
  expect(result.status).toBe(200);
  const session = result.body.items.find(value => value.name === name);
  if (!session) throw new Error(`Created Session was not listed: ${name}.`);
  const snapshot = await sessionSnapshot(page, session.id);
  expect(snapshot.session.name).toBe(name);
  return Object.freeze({ id: snapshot.session.id, name });
}

async function activateNamedSession(page: Page, name: string): Promise<void> {
  let button = activeSessionNamed(page, name);
  if (!(await button.isVisible())) {
    await openSessionNavigation(page, { timeout: 30_000 });
    button = activeSessionNamed(page, name);
  }
  if ((await button.getAttribute('aria-current')) !== 'page') await button.click();
  await expect(button).toHaveAttribute('aria-current', 'page', { timeout: 30_000 });
  await expect(workbenchUi(page).composer).toBeEnabled({ timeout: 30_000 });
}

function activeSessionNamed(page: Page, name: string) {
  return workbenchUi(page).sessionList.getByRole('button', {
    name: new RegExp(`^${escapeRegex(name)}(?:\\s|$)`, 'u'),
  });
}

function sessionRowNamed(page: Page, name: string) {
  return activeSessionNamed(page, name).locator('..');
}

async function expectRuntimePhase(
  page: Page,
  sessionId: string,
  phase: WebSessionSnapshotV1['sessionRuntime']['phase']
): Promise<void> {
  await expect
    .poll(async () => (await sessionSnapshot(page, sessionId)).sessionRuntime.phase, {
      timeout: 60_000,
    })
    .toBe(phase);
}

async function assertProviderRequestCountStable(
  provider: { readonly requests: readonly unknown[] },
  expected: number,
  durationMs: number
): Promise<void> {
  const deadline = Date.now() + durationMs;
  do {
    expect(provider.requests).toHaveLength(expected);
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(50, durationMs)));
  } while (Date.now() < deadline);
  expect(provider.requests).toHaveLength(expected);
}

function orionMessage(page: Page, marker: string) {
  return page.getByRole('article', { name: 'Orion' }).filter({ hasText: marker }).last();
}

async function assistantContains(page: Page, value: string): Promise<boolean> {
  const messages = page.getByRole('article', { name: 'Orion' });
  const count = await messages.count();
  for (let index = 0; index < count; index += 1) {
    if ((await messages.nth(index).innerText()).includes(value)) return true;
  }
  return false;
}

async function captureWorkbench(
  page: Page,
  evidence: import('./fixtures/evidence').WebE2EEvidenceCollector,
  name: string,
  id: string
): Promise<void> {
  await captureSurface(page.locator('.workbench-shell'), evidence, name, id);
}

async function captureSurface(
  surface: import('@playwright/test').Locator,
  evidence: import('./fixtures/evidence').WebE2EEvidenceCollector,
  name: string,
  id: string
): Promise<void> {
  await surface.screenshot({
    path: join(evidence.scenarioDirectory, name),
    animations: 'disabled',
  });
  evidence.recordFact(`screenshot.web33-p0-${id}`, basename(name));
}

async function openObservedPage(
  browser: Browser,
  url: string,
  evidence: import('./fixtures/evidence').WebE2EEvidenceCollector
): Promise<{
  readonly context: BrowserContext;
  readonly page: Page;
  readonly detach: () => void;
}> {
  const context = await browser.newContext({ bypassCSP: false });
  const page = await context.newPage();
  await installSseCapture(page);
  const detach = evidence.attachPage(page);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  return { context, page, detach };
}

function snapshotText(snapshot: WebSessionSnapshotV1): string {
  return snapshot.transcript.items.map(item => item.content).join('\n');
}

async function hostBootstrap(url: string): Promise<WebBootstrapV1> {
  const response = await fetch(`${url}/api/v1/bootstrap`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Host bootstrap failed with HTTP ${response.status}.`);
  return response.json() as Promise<WebBootstrapV1>;
}

async function hostCommand(
  url: string,
  input: {
    readonly bootstrap: WebBootstrapV1;
    readonly sessionId: string;
    readonly runtimeRevision: string;
    readonly text: string;
  }
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(`${url}/api/v1/commands`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: url,
      'x-orion-web-nonce': input.bootstrap.nonce,
    },
    body: JSON.stringify({
      requestId: randomUUID(),
      workspaceId: input.bootstrap.workspaceId,
      expectedContextRevision: input.bootstrap.contextRevision,
      expectedSessionId: input.sessionId,
      expectedSessionRuntimeRevision: input.runtimeRevision,
      type: 'submit',
      text: input.text,
    }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function problemCode(value: unknown): string | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? String((value as Record<string, unknown>).code ?? '') || undefined
    : undefined;
}

function networkFailure(request: Request): NetworkFailure {
  return {
    method: request.method(),
    path: new URL(request.url()).pathname,
    error: request.failure()?.errorText ?? '',
  };
}

function isExpectedClosedSseFailure(failure: NetworkFailure): boolean {
  return (
    failure.method === 'GET' &&
    failure.path === '/api/v1/events' &&
    failure.error === 'net::ERR_ABORTED'
  );
}

function isExpectedRestartFailure(failure: NetworkFailure): boolean {
  return (
    failure.method === 'GET' &&
    failure.path === '/api/v1/events' &&
    /net::ERR_(?:ABORTED|CONNECTION_REFUSED)/u.test(failure.error)
  );
}

function seedInstalledLongSession(
  packageRoot: string,
  workspace: string,
  configDirectory: string,
  homeDirectory: string,
  messageCount: number
): string {
  const storageModule = join(packageRoot, 'dist', 'services', 'session-storage.js');
  const materializerModule = join(packageRoot, 'dist', 'runtime', 'legacy-thread-materializer.js');
  const sessionViewModule = join(packageRoot, 'dist', 'runtime', 'thread-session-view.js');
  const script = [
    `const storage=require(${JSON.stringify(storageModule)});`,
    `const materializer=require(${JSON.stringify(materializerModule)});`,
    `const sessionView=require(${JSON.stringify(sessionViewModule)});`,
    `const session=storage.createSession(${JSON.stringify(workspace)},'ark-code-latest');`,
    "storage.renameSession(session.id,'Long 10k session');",
    `const count=${messageCount};`,
    'for(let offset=0;offset<count;offset+=1000){',
    'const messages=Array.from({length:Math.min(1000,count-offset)},(_,index)=>{',
    'const value=offset+index;',
    "return {role:value%2===0?'user':'assistant',content:'long-history-'+value,timestamp:1700000000000+value};",
    '});storage.appendSessionMessages(session.id,messages);}',
    `materializer.materializeLegacyThreadV1({projectPath:${JSON.stringify(
      workspace
    )},sessionId:session.id});`,
    `sessionView.loadThreadSessionSnapshotPageV1(${JSON.stringify(
      workspace
    )},session.id,undefined,100);`,
    'process.stdout.write(session.id);',
  ].join('');
  return execFileSync(process.execPath, ['-e', script], {
    cwd: workspace,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: homeDirectory,
      ORION_CODE_CONFIG_DIR: configDirectory,
      ORION_CODE_DISABLE_ENV_FILES: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
  }).trim();
}

async function measuredActivate(page: Page, name: string): Promise<{ readonly elapsedMs: number }> {
  let button = activeSessionNamed(page, name);
  if (!(await button.isVisible())) {
    await openSessionNavigation(page, { timeout: 30_000 });
    button = activeSessionNamed(page, name);
  }
  expect(await button.getAttribute('aria-current')).not.toBe('page');
  await button.evaluate(element => {
    const state = { elapsedMs: -1, error: '' };
    Object.defineProperty(globalThis, '__orionWeb33SwitchTiming', {
      configurable: true,
      value: state,
    });
    let startedAt = -1;
    let timer = 0;
    const observer = new MutationObserver(() => finishIfReady());
    const finishIfReady = () => {
      if (startedAt < 0) return;
      const composer = document.querySelector<HTMLTextAreaElement>('#orion-composer');
      if (element.getAttribute('aria-current') !== 'page' || !composer || composer.disabled) return;
      state.elapsedMs = performance.now() - startedAt;
      observer.disconnect();
      window.clearTimeout(timer);
    };
    element.addEventListener(
      'click',
      () => {
        startedAt = performance.now();
        observer.observe(document.documentElement, {
          attributes: true,
          childList: true,
          subtree: true,
        });
        timer = window.setTimeout(() => {
          state.error = 'Session switch DOM readiness timed out.';
          observer.disconnect();
        }, 5_000);
        finishIfReady();
      },
      { once: true }
    );
  });
  await button.click();
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const state = (
            globalThis as typeof globalThis & {
              __orionWeb33SwitchTiming?: { readonly elapsedMs: number; readonly error: string };
            }
          ).__orionWeb33SwitchTiming;
          if (state?.error) throw new Error(state.error);
          return state?.elapsedMs ?? -1;
        }),
      { timeout: 10_000 }
    )
    .toBeGreaterThanOrEqual(0);
  const elapsedMs = await page.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          __orionWeb33SwitchTiming: { readonly elapsedMs: number };
        }
      ).__orionWeb33SwitchTiming.elapsedMs
  );
  await expect(button).toHaveAttribute('aria-current', 'page', { timeout: 30_000 });
  await expect(workbenchUi(page).composer).toBeEnabled({ timeout: 30_000 });
  return { elapsedMs };
}

function snapshotRequestCount(requests: readonly { readonly path: string }[]): number {
  return requests.filter(request => /^\/api\/v1\/sessions\/[^/]+\/snapshot$/u.test(request.path))
    .length;
}

function forbiddenCatalogRequestCount(requests: readonly { readonly path: string }[]): number {
  return requests.filter(request =>
    ['/api/v1/settings', '/api/v1/skills', '/api/v1/mcp', '/api/v1/tool-details'].includes(
      request.path
    )
  ).length;
}

function eventStreamRequestCount(requests: readonly { readonly path: string }[]): number {
  return requests.filter(request => request.path === '/api/v1/events').length;
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
