import { basename, join } from 'path';

import type { Locator, Page, Request } from '@playwright/test';

import { OPENAI_FIXTURE_MARKERS, OPENAI_FIXTURE_PROMPTS } from './fixtures/openai-provider';
import { startOrionHost } from './fixtures/orion-host';
import { createSession, openInspector, submitPrompt, waitForWorkbenchReady } from './fixtures/ui';
import { allowExpectedNetworkFailures, capturedSseEvents, expect, test } from './fixtures/test';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test('WEB31-P0-08 real PTY supports ANSI input output resize tabs and close', async ({
  evidence,
  page,
}) => {
  await installTerminalFrameCapture(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  await page.setViewportSize({ width: 1_600, height: 900 });

  const panel = await openTerminalPanel(page);
  await createTerminalFromUi(panel);
  await expectTerminalSurfaceLive(panel);

  await writeTerminal(page, panel, `printf '\\033[31mWEB31_ANSI_RED\\033[0m\\n'`);
  await expect(terminalRows(panel)).toContainText('WEB31_ANSI_RED', { timeout: 30_000 });
  await expect(
    panel.locator('.xterm-rows .xterm-fg-1').filter({ hasText: 'WEB31_ANSI_RED' })
  ).toHaveCount(1);

  const initial = await browserTerminals(page);
  expect(initial).toHaveLength(1);
  const initialCols = initial[0].cols;
  await dragPanelToRequestedWidth(page, page.locator('.work-panel-resize-handle'), 720);
  await expect
    .poll(async () => (await browserTerminals(page))[0]?.cols, { timeout: 30_000 })
    .toBeGreaterThan(initialCols);

  await panel.getByRole('button', { name: '新建终端', exact: true }).first().click();
  await expect(panel.getByRole('tab')).toHaveCount(2, { timeout: 30_000 });
  await expect(panel.getByText('PTY 已连接', { exact: true })).toBeVisible({ timeout: 30_000 });
  const activeTab = panel.getByRole('tab', { selected: true });
  await activeTab.focus();
  await activeTab.press('ArrowLeft');
  await expect(panel.getByRole('tab', { selected: true })).toBeFocused();
  await panel.getByRole('tab', { selected: true }).press('ArrowRight');
  await expect(panel.getByRole('tab', { selected: true })).toBeFocused();

  await captureProductSurface(panel, evidence, 'web31-p0-08-real-pty.png', '08');

  const selected = panel.getByRole('tab', { selected: true });
  await selected
    .locator('..')
    .getByRole('button', { name: /^关闭终端 /u })
    .click();
  await expect(panel.getByRole('tab')).toHaveCount(1, { timeout: 30_000 });
  await expect(panel.getByRole('tab', { selected: true })).toHaveCount(1);
  const remaining = panel.getByRole('tab', { selected: true });
  await remaining
    .locator('..')
    .getByRole('button', { name: /^关闭终端 /u })
    .click();
  await expect(panel.getByRole('tab')).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(async () => (await browserTerminals(page)).length).toBe(0);

  const transport = await terminalTransportSnapshot(page);
  expect(transport.connections).toBeGreaterThanOrEqual(2);
  expect(transport.outputFrames).toBeGreaterThan(0);
  expect(transport.invalidPayloads).toBe(0);
  evidence.recordFact('web31.real_pty_verified', true);
});

test('WEB31-P0-09 terminal reconnect gap restart and shutdown leave no orphan process', async ({
  artifactState,
  evidence,
  host,
  page,
  workspace,
}, testInfo) => {
  testInfo.setTimeout(180_000);
  const networkFailures: Array<{ method: string; path: string; error: string }> = [];
  const onRequestFailed = (request: Request) => {
    networkFailures.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      error: request.failure()?.errorText ?? '',
    });
  };
  page.on('requestfailed', onRequestFailed);
  await installTerminalFrameCapture(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  await page.setViewportSize({ width: 1_600, height: 900 });

  let replacement: Awaited<ReturnType<typeof startOrionHost>> | undefined;
  try {
    let panel = await openTerminalPanel(page);
    await createTerminalFromUi(panel);
    await expect(panel.getByText('PTY 已连接', { exact: true })).toBeVisible({ timeout: 30_000 });
    await writeTerminal(page, panel, `printf 'WEB31_BEFORE_REFRESH\\n'`);
    await expect(terminalRows(panel)).toContainText('WEB31_BEFORE_REFRESH', { timeout: 30_000 });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForWorkbenchReady(page, { timeout: 30_000 });
    panel = await openTerminalPanel(page);
    await expect(panel.getByText('PTY 已连接', { exact: true })).toBeVisible({ timeout: 30_000 });
    await writeTerminal(page, panel, `printf 'WEB31_AFTER_REFRESH\\n'`);
    await expect(terminalRows(panel)).toContainText('WEB31_AFTER_REFRESH', { timeout: 30_000 });

    let heldAttach = false;
    await page.route('**/api/v1/terminals/*/attach-ticket', async route => {
      if (heldAttach || route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      heldAttach = true;
      await delay(2_500);
      await route.continue();
    });
    await writeTerminal(
      page,
      panel,
      `sleep 0.5; yes G | head -c 2300000; printf '\\nWEB31_GAP_DONE\\n'`
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForWorkbenchReady(page, { timeout: 30_000 });
    panel = await openTerminalPanel(page);
    await expect
      .poll(async () => (await terminalTransportSnapshot(page)).gaps, { timeout: 60_000 })
      .toBeGreaterThan(0);
    await expect(panel.getByText('PTY 已连接', { exact: true })).toBeVisible({ timeout: 60_000 });
    await page.unroute('**/api/v1/terminals/*/attach-ticket');

    await writeTerminal(page, panel, 'sleep 300 & echo WEB31_CHILD_PID=$!');
    const explicitChild = await terminalPid(panel, 'WEB31_CHILD_PID');
    await closeSelectedTerminal(panel);
    await expect.poll(() => isPidAlive(explicitChild), { timeout: 15_000 }).toBe(false);

    await createTerminalFromUi(panel);
    await expect(panel.getByText('PTY 已连接', { exact: true })).toBeVisible({ timeout: 30_000 });
    await writeTerminal(page, panel, 'sleep 300 & echo WEB31_SHUTDOWN_CHILD_PID=$!');
    const shutdownChild = await terminalPid(panel, 'WEB31_SHUTDOWN_CHILD_PID');

    await host.stop();
    await expect(panel.getByText('连接已断开', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => isPidAlive(shutdownChild), { timeout: 15_000 }).toBe(false);

    replacement = await startOrionHost({
      state: artifactState,
      workspace: workspace.primaryWorkspace,
      configRoot: workspace.configDirectory,
      environment: workspace.environment,
      evidence,
      port: host.port,
    });
    expect(replacement.url).toBe(host.url);
    await expect.poll(() => hostTerminalCount(replacement!.url), { timeout: 30_000 }).toBe(0);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForWorkbenchReady(page, { timeout: 30_000 });
    panel = await openTerminalPanel(page);
    await expect(panel.getByText('没有活动终端', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await captureProductSurface(panel, evidence, 'web31-p0-09-terminal-lost.png', '09');

    evidence.recordFact('web31.terminal_orphan_processes', 0);
    evidence.recordFact('web31.terminal_restart_state', 'lost');
  } finally {
    page.off('requestfailed', onRequestFailed);
    await page.unroute('**/api/v1/terminals/*/attach-ticket').catch(() => undefined);
    await replacement?.stop();
  }
  expect(
    networkFailures.every(
      failure =>
        failure.method === 'GET' &&
        failure.path === '/api/v1/events' &&
        /net::ERR_(?:ABORTED|CONNECTION_REFUSED)/u.test(failure.error)
    )
  ).toBe(true);
  allowExpectedNetworkFailures(testInfo, networkFailures.length);
});

test('WEB31-P0-10 terminal WebSocket burst stays isolated from Workbench SSE', async ({
  evidence,
  page,
}, testInfo) => {
  testInfo.setTimeout(180_000);
  const networkFailures: Array<{ method: string; path: string; error: string }> = [];
  const onRequestFailed = (request: Request) => {
    networkFailures.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      error: request.failure()?.errorText ?? '',
    });
  };
  page.on('requestfailed', onRequestFailed);
  await installTerminalFrameCapture(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  await page.setViewportSize({ width: 1_600, height: 900 });
  await createSession(page, { name: 'PTY transport isolation' });
  const panel = await openTerminalPanel(page);
  await createTerminalFromUi(panel);
  await expect(panel.getByText('PTY 已连接', { exact: true })).toBeVisible({ timeout: 30_000 });

  const echoLatencies = await measureTerminalEcho(page, panel, 20);
  const echoP95Ms = percentile(echoLatencies, 0.95);
  expect(echoP95Ms).toBeLessThanOrEqual(80);

  await startFrameMeasurement(page, 2_000);
  const idleFrameMetrics = await finishFrameMeasurement(page);
  await startFrameMeasurement(page, 2_000);

  const terminalMarker = 'WEB31_TERMINAL_BURST_DONE';
  await writeTerminal(page, panel, `yes X | head -c 10485760; printf '\\n${terminalMarker}\\n'`);
  await submitPrompt(page, OPENAI_FIXTURE_PROMPTS.settingsProbe);
  await expect(orionMessage(page, OPENAI_FIXTURE_MARKERS.settingsProbeDone)).toBeVisible({
    timeout: 60_000,
  });
  await expect(terminalRows(panel)).toContainText(terminalMarker, { timeout: 90_000 });

  const sse = JSON.stringify(await capturedSseEvents(page));
  expect(sse).toContain(OPENAI_FIXTURE_MARKERS.settingsProbeDone);
  expect(sse).not.toContain(terminalMarker);
  const transport = await terminalTransportSnapshot(page);
  expect(transport.connections).toBeGreaterThanOrEqual(1);
  expect(transport.outputFrames).toBeGreaterThan(100);
  expect(transport.gaps).toBe(0);
  expect(transport.invalidPayloads).toBe(0);
  expect(transport.terminalStreamQueries).toBe(0);
  expect(transport.maxBufferedAmount).toBeLessThanOrEqual(256 * 1024);
  const frameMetrics = await finishFrameMeasurement(page);

  evidence.recordFact(
    'web31.terminal_idle_frame_rate_fps',
    roundMetric(idleFrameMetrics.framesPerSecond)
  );
  evidence.recordFact('web31.terminal_frame_rate_fps', roundMetric(frameMetrics.framesPerSecond));
  evidence.recordFact(
    'web31.terminal_frame_p95_interval_ms',
    roundMetric(frameMetrics.p95IntervalMs)
  );
  evidence.recordFact('web31.terminal_echo_p95_ms', roundMetric(echoP95Ms));
  evidence.recordFact('web31.terminal_ws_buffered_bytes', transport.maxBufferedAmount);
  evidence.recordFact('web31.terminal_burst_bytes', 10 * 1024 * 1024);

  expect(idleFrameMetrics.framesPerSecond).toBeGreaterThanOrEqual(55);
  expect(frameMetrics.framesPerSecond).toBeGreaterThanOrEqual(55);

  await captureProductSurface(
    panel.locator('.terminal-status'),
    evidence,
    'web31-p0-10-sse-ws-isolation.png',
    '10'
  );
  await closeSelectedTerminal(panel);
  evidence.recordFact('web31.sse_ws_isolated', true);
  evidence.recordFact('web31.transport_dropped_events', evidence.snapshotCounters().droppedEvents);
  evidence.recordFact('web31.terminal_performance_budget', true);
  page.off('requestfailed', onRequestFailed);
  expect(
    networkFailures.every(
      failure =>
        failure.method === 'GET' &&
        failure.path === '/api/v1/events' &&
        failure.error === 'net::ERR_ABORTED'
    )
  ).toBe(true);
  allowExpectedNetworkFailures(testInfo, networkFailures.length);
});

async function openTerminalPanel(page: Page): Promise<Locator> {
  const inspector = await openInspector(page, { timeout: 30_000 });
  const tab = inspector.getByRole('tab', { name: /^终端，/u });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  const panel = inspector.locator('.terminal-panel');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  return panel;
}

async function createTerminalFromUi(panel: Locator): Promise<void> {
  const before = await panel.getByRole('tab').count();
  await panel.getByRole('button', { name: '新建终端', exact: true }).first().click();
  const risk = panel.getByRole('alertdialog', { name: '创建本地终端前请确认风险' });
  await expect
    .poll(async () => (await risk.isVisible()) || (await panel.getByRole('tab').count()) > before, {
      timeout: 30_000,
    })
    .toBe(true);
  if (await risk.isVisible()) {
    await risk.getByRole('checkbox', { name: '我理解终端可以执行本地命令' }).check();
    await risk.getByRole('button', { name: '我理解，创建终端', exact: true }).click();
  }
  await expect(panel.getByRole('tab')).toHaveCount(before + 1, { timeout: 30_000 });
}

async function closeSelectedTerminal(panel: Locator): Promise<void> {
  const selected = panel.getByRole('tab', { selected: true });
  await selected
    .locator('..')
    .getByRole('button', { name: /^关闭终端 /u })
    .click();
  await expect(selected).toBeHidden({ timeout: 30_000 });
}

async function writeTerminal(page: Page, panel: Locator, command: string): Promise<void> {
  const input = panel.locator('.xterm-helper-textarea');
  await expect(input).toBeAttached({ timeout: 30_000 });
  await input.focus();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

function terminalRows(panel: Locator): Locator {
  return panel.locator('.xterm-rows');
}

async function expectTerminalSurfaceLive(panel: Locator): Promise<void> {
  const status = panel.locator('.terminal-connection-status');
  await expect
    .poll(
      () =>
        status.evaluate(element => {
          const statusBounds = element.getBoundingClientRect();
          const chain: Array<{
            readonly className: string;
            readonly display: string;
            readonly height: number;
            readonly overflow: string;
            readonly visibility: string;
            readonly width: number;
          }> = [];
          let current: HTMLElement | null = element as HTMLElement;
          while (current && chain.length < 8) {
            const style = getComputedStyle(current);
            const bounds = current.getBoundingClientRect();
            chain.push({
              className: current.className,
              display: style.display,
              height: bounds.height,
              overflow: style.overflow,
              visibility: style.visibility,
              width: bounds.width,
            });
            current = current.parentElement;
          }
          return JSON.stringify({
            live: element.textContent?.trim() === 'PTY 已连接',
            visible: statusBounds.width > 0 && statusBounds.height > 0,
            chain,
          });
        }),
      { timeout: 30_000 }
    )
    .toContain('"live":true,"visible":true');
}

async function terminalPid(panel: Locator, label: string): Promise<number> {
  let pid = 0;
  await expect
    .poll(
      async () => {
        const match = new RegExp(`${label}=(\\d+)`, 'u').exec(
          await terminalRows(panel).innerText()
        );
        pid = Number(match?.[1] ?? 0);
        return pid;
      },
      { timeout: 30_000 }
    )
    .toBeGreaterThan(1);
  return pid;
}

async function dragPanelToRequestedWidth(
  page: Page,
  handle: Locator,
  requestedWidth: number
): Promise<void> {
  const bounds = await handle.boundingBox();
  const viewportWidth = page.viewportSize()?.width;
  if (!bounds || !viewportWidth) throw new Error('Resizable Work Panel is not measurable.');
  const pointerY = bounds.y + Math.min(120, Math.max(1, bounds.height / 2));
  await page.mouse.move(bounds.x + bounds.width / 2, pointerY);
  await page.mouse.down();
  await page.mouse.move(viewportWidth - requestedWidth, pointerY, { steps: 12 });
  await page.mouse.up();
}

async function browserTerminals(page: Page): Promise<readonly TerminalMetadata[]> {
  return page.evaluate(async () => {
    const bootstrap = (await (await fetch('/api/v1/bootstrap', { cache: 'no-store' })).json()) as {
      workspaceId: string;
      contextRevision: string;
    };
    const query = new URLSearchParams({
      workspaceId: bootstrap.workspaceId,
      expectedContextRevision: bootstrap.contextRevision,
      pageSize: '100',
    });
    const response = await fetch(`/api/v1/terminals?${query.toString()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Terminal list failed with ${response.status}.`);
    return ((await response.json()) as { items: TerminalMetadata[] }).items;
  });
}

async function hostTerminalCount(url: string): Promise<number> {
  const bootstrap = (await (await fetch(`${url}/api/v1/bootstrap`)).json()) as {
    workspaceId: string;
    contextRevision: string;
  };
  const query = new URLSearchParams({
    workspaceId: bootstrap.workspaceId,
    expectedContextRevision: bootstrap.contextRevision,
    pageSize: '100',
  });
  const response = await fetch(`${url}/api/v1/terminals?${query.toString()}`);
  if (!response.ok) throw new Error(`Replacement terminal list failed with ${response.status}.`);
  return ((await response.json()) as { items: unknown[] }).items.length;
}

interface TerminalMetadata {
  readonly id: string;
  readonly cols: number;
  readonly rows: number;
  readonly state: string;
}

interface TerminalTransportSnapshot {
  readonly connections: number;
  readonly outputFrames: number;
  readonly gaps: number;
  readonly invalidPayloads: number;
  readonly terminalStreamQueries: number;
  readonly maxBufferedAmount: number;
}

async function installTerminalFrameCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = {
      connections: 0,
      outputFrames: 0,
      gaps: 0,
      invalidPayloads: 0,
      terminalStreamQueries: 0,
      maxBufferedAmount: 0,
    };
    Object.defineProperty(globalThis, '__orionTerminalTransport', {
      configurable: false,
      enumerable: false,
      value: state,
      writable: false,
    });
    const NativeWebSocket = globalThis.WebSocket;
    class CapturingWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const parsed = new URL(String(url), location.href);
        if (/^\/api\/v1\/terminals\/[^/]+\/stream$/u.test(parsed.pathname)) {
          state.connections += 1;
          if (parsed.search) state.terminalStreamQueries += 1;
          this.addEventListener('message', event => {
            state.maxBufferedAmount = Math.max(state.maxBufferedAmount, this.bufferedAmount);
            if (typeof event.data !== 'string') {
              state.invalidPayloads += 1;
              return;
            }
            try {
              const frame = JSON.parse(event.data) as { type?: unknown };
              if (frame.type === 'output') state.outputFrames += 1;
              else if (frame.type === 'gap') state.gaps += 1;
            } catch {
              state.invalidPayloads += 1;
            }
          });
        }
      }
    }
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: false,
      value: CapturingWebSocket,
      writable: false,
    });
  });
}

async function measureTerminalEcho(page: Page, panel: Locator, samples: number): Promise<number[]> {
  const input = panel.locator('.xterm-helper-textarea');
  await expect(input).toBeAttached({ timeout: 30_000 });
  await input.focus();
  const values: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const marker = `z${sample.toString(36)}${Date.now().toString(36)}`;
    await page.evaluate(value => {
      const target = document.querySelector('.terminal-panel .xterm-rows');
      if (!target) throw new Error('Terminal rows are unavailable for echo measurement.');
      const state = { marker: value, startedAt: performance.now(), durationMs: -1 };
      Object.defineProperty(globalThis, '__orionEchoMeasurement', {
        configurable: true,
        value: state,
      });
      const observer = new MutationObserver(() => {
        if (!target.textContent?.includes(value)) return;
        state.durationMs = performance.now() - state.startedAt;
        observer.disconnect();
      });
      observer.observe(target, { childList: true, characterData: true, subtree: true });
      window.setTimeout(() => observer.disconnect(), 2_000);
    }, marker);
    await page.keyboard.type(marker);
    let durationMs = -1;
    await expect
      .poll(
        async () => {
          durationMs = await page.evaluate(() => {
            const state = (
              globalThis as typeof globalThis & {
                __orionEchoMeasurement?: { readonly durationMs: number };
              }
            ).__orionEchoMeasurement;
            return state?.durationMs ?? -1;
          });
          return durationMs;
        },
        { timeout: 2_000 }
      )
      .toBeGreaterThanOrEqual(0);
    values.push(durationMs);
    await page.keyboard.press('Control+U');
  }
  return values;
}

interface FrameMetrics {
  readonly framesPerSecond: number;
  readonly p95IntervalMs: number;
}

async function startFrameMeasurement(page: Page, durationMs: number): Promise<void> {
  await page.evaluate(duration => {
    const state = {
      startedAt: performance.now(),
      completedAt: 0,
      intervals: [] as number[],
      previousAt: 0,
    };
    Object.defineProperty(globalThis, '__orionFrameMeasurement', {
      configurable: true,
      value: state,
    });
    const tick = (now: number) => {
      if (state.previousAt > 0) state.intervals.push(now - state.previousAt);
      state.previousAt = now;
      if (now - state.startedAt >= duration) {
        state.completedAt = now;
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, durationMs);
}

async function finishFrameMeasurement(page: Page): Promise<FrameMetrics> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __orionFrameMeasurement?: { readonly completedAt: number };
            }
          ).__orionFrameMeasurement?.completedAt ?? 0
      )
    )
    .toBeGreaterThan(0);
  return page.evaluate(() => {
    const state = (
      globalThis as typeof globalThis & {
        __orionFrameMeasurement?: {
          readonly startedAt: number;
          readonly completedAt: number;
          readonly intervals: readonly number[];
        };
      }
    ).__orionFrameMeasurement;
    if (!state || state.completedAt <= state.startedAt) {
      throw new Error('Frame measurement did not finish.');
    }
    const intervals = [...state.intervals].sort((left, right) => left - right);
    return {
      framesPerSecond: (state.intervals.length * 1_000) / (state.completedAt - state.startedAt),
      p95IntervalMs: intervals[Math.max(0, Math.ceil(intervals.length * 0.95) - 1)] ?? 0,
    };
  });
}

function percentile(values: readonly number[], quantile: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)];
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

async function terminalTransportSnapshot(page: Page): Promise<TerminalTransportSnapshot> {
  return page.evaluate(() => {
    const value = (
      globalThis as typeof globalThis & { __orionTerminalTransport?: TerminalTransportSnapshot }
    ).__orionTerminalTransport;
    if (!value) throw new Error('Terminal transport capture was not installed.');
    return structuredClone(value);
  });
}

function orionMessage(page: Page, marker: string): Locator {
  return page.getByRole('article', { name: 'Orion' }).filter({ hasText: marker }).last();
}

async function captureProductSurface(
  surface: Locator,
  evidence: { readonly scenarioDirectory: string; recordFact(key: string, value: string): void },
  filename: string,
  factSuffix: string
): Promise<void> {
  await surface.screenshot({
    path: join(evidence.scenarioDirectory, filename),
    animations: 'disabled',
  });
  evidence.recordFact(`screenshot.${factSuffix}`, basename(filename));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ESRCH'
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
