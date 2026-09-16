#!/usr/bin/env node
/**
 * v0.3.17 §9 — Git work panel performance baseline.
 *
 * Runs against the deterministic fixture from `v0317-git-fixture.mjs`, a production build
 * and a real Chrome, because the §9 budgets are about what the reader actually waits for.
 *
 * Recorded:
 *   M1  open Git → first usable change list
 *   M2  switch to a ~200KB text file → first diff paint (cold and warm separated)
 *   M3  switch back and forth between cached files / views
 *   M4  local search over a 50,000 commit fixture — NOT IMPLEMENTED (S4), reported as not_run
 *
 * Every metric keeps its raw samples; p50/p95 are derived, never asserted here.
 *
 * Usage:
 *   node scripts/perf/v0317-git-baseline.mjs [--fixture <dir>] [--port <n>] [--samples <n>]
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');
const { execFileSync } = require('node:child_process');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');

/** plan §11.3 — every receipt names the machine, toolchain and source revision. */
function environmentBlock() {
  const tryRun = (command, args) => {
    try {
      return execFileSync(command, args, { cwd: REPO, encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  };
  return {
    platform: process.platform,
    arch: process.arch,
    cpu: tryRun('sysctl', ['-n', 'machdep.cpu.brand_string']),
    node: process.version,
    git: tryRun('git', ['--version']),
    sourceHead: tryRun('git', ['rev-parse', 'HEAD']),
    sourceDirtyFiles: (tryRun('git', ['status', '--porcelain']) ?? '')
      .split('\n')
      .filter(Boolean).length,
    browser: tryRun('bash', [
      '-lc',
      '/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "/Applications/Google Chrome.app/Contents/Info.plist"',
    ]),
    recordedAt: new Date().toISOString(),
  };
}

const DEFAULTS = {
  fixture: '/tmp/oc317-perf/fixture',
  port: 4299,
  samples: 30,
  /** When set, capture the §10 S2 evidence screenshots before measuring. */
  shotsDir: null,
  /**
   * Evidence lives in the main workspace, not the iteration worktree. Derived rather than
   * guessed: `<parent>/orion-code/docs/plan/evidence/v0.3.17-git`.
   */
  outDir: resolve(REPO, '../../orion-code/docs/plan/evidence/v0.3.17-git'),
};

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fixture') options.fixture = argv[++index];
    else if (arg === '--port') options.port = Number(argv[++index]);
    else     if (arg === '--samples') options.samples = Number(argv[++index]);
    else if (arg === '--shots') options.shotsDir = argv[++index];
    else if (arg === '--out') options.outDir = argv[++index];
  }
  return options;
}

function percentile(samples, fraction) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return Number(sorted[index].toFixed(1));
}

function summarise(samples) {
  if (samples.length === 0) return { count: 0, min: null, p50: null, p95: null, max: null };
  return {
    count: samples.length,
    min: Number(Math.min(...samples).toFixed(1)),
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    max: Number(Math.max(...samples).toFixed(1)),
  };
}

async function waitForHost(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
      if (response.status < 500) return true;
    } catch {
      // not up yet
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/** HTTP durations the app itself recorded, so the numbers are not re-timed by hand. */
async function resourceDurations(page, pathFragment) {
  return page.evaluate(fragment => {
    const entries = performance.getEntriesByType('resource');
    return entries
      .filter(entry => entry.name.includes(fragment))
      .map(entry => Number(entry.duration.toFixed(1)));
  }, pathFragment);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.fixture)) {
    throw new Error(`Fixture not found: ${options.fixture}. Run v0317-git-fixture.mjs first.`);
  }

  const cli = join(REPO, 'dist/cli.js');
  if (!existsSync(cli)) throw new Error(`Build first: dist/cli.js is missing.`);

  const child = spawn(process.execPath, [cli, 'web', '--port', String(options.port)], {
    cwd: options.fixture,
    env: {
      ...process.env,
      NO_COLOR: '1',
      // Isolated Host state: the fixture must not enter the user's real workspace registry,
      // and a sandbox that denies writes to ~/.orion-code otherwise fails the Host with the
      // unhelpful "Workspace registry is unavailable".
      ORION_CODE_CONFIG_DIR: join(options.fixture, '..', 'state'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let hostLog = '';
  child.stdout.on('data', chunk => {
    hostLog += chunk.toString();
  });
  child.stderr.on('data', chunk => {
    hostLog += chunk.toString();
  });

  const browser = await chromium.launch({ channel: 'chrome' });
  const result = {
    environment: environmentBlock(),
    fixture: options.fixture,
    port: options.port,
    samplesRequested: options.samples,
    method:
      '生产构建（dist/cli.js + dist/web-client）+ 真实 Chrome；面板每轮先切到另一资源面板再打开，' +
      '因为非活动资源面板会卸载，故该指标反映真实的「重新打开」代价。',
    metrics: {},
    notes: [],
    /** Budgets from plan §9, restated so the reader can compare without opening the plan. */
    budgets: {
      openPanelToChangeList: '温态 p95 ≤ 500ms',
      selectLargeFileToDiffPaint: '温态 p95 ≤ 300ms；冷态 p95 ≤ 1s',
      switchCachedFile: 'p95 ≤ 100ms',
      switchView: 'p95 ≤ 100ms',
    },
    notRun: [
      {
        metric: 'M4 本地搜索首批结果（50,000 提交）',
        reason: '提交搜索属于 S4（plan §10），当前未实现，因此没有可测量的路径。',
      },
      {
        metric: '2,000 改动文件 / 50MB 原始 Diff 的有界性',
        reason: '需要 50MB 级 fixture；本轮先固定 291 个改动 + 200KB 文本文件。',
      },
      {
        metric: '词级高亮 / 忽略空白的计算预算',
        reason: 'S5 功能，尚未实现。',
      },
    ],
  };

  try {
    const ready = await waitForHost(options.port);
    if (!ready) {
      throw new Error(`Host did not become ready on port ${options.port}.\n${hostLog}`);
    }

    const viewport = { width: 1512, height: 950 };
    const openGit = async target => {
      await target.click('button[aria-label="打开Git面板"]');
      await target.waitForSelector('.git-row button', { timeout: 30_000 });
    };
    const samples = { openPanel: [], diffTarget: [], switchFile: [], switchView: [] };

    if (options.shotsDir) {
      // §10 S2 exit evidence — real browser layout and navigation, not a mock.
      // Runs on its OWN page and is closed before measuring: it loads the target file, which
      // would warm the document cache and silently turn the "cold" sample into a warm one.
      const shotPage = await browser.newPage({ viewport });
      try {
        mkdirSync(options.shotsDir, { recursive: true });
        await shotPage.goto(`http://127.0.0.1:${options.port}/`, { waitUntil: 'load' });
        await shotPage.waitForSelector('button[aria-label="打开Git面板"]', { timeout: 30_000 });
        await openGit(shotPage);
        await shotPage.screenshot({ path: join(options.shotsDir, 's2-01-changes.png') });

        await shotPage
          .locator('.git-row button', { hasText: 'large/target.txt' })
          .first()
          .click();
        await shotPage.waitForSelector('.diff-body .diff-line', { timeout: 30_000 });
        await shotPage.screenshot({ path: join(options.shotsDir, 's2-02-diff-unified.png') });

        await shotPage.click('.diff-mode-group > button:has-text("并排")');
        await shotPage.waitForSelector('.diff-body-side-by-side', { timeout: 30_000 });
        await shotPage.screenshot({ path: join(options.shotsDir, 's2-03-diff-side-by-side.png') });

        await shotPage.click('.diff-mode-group > button:has-text("统一")');
        // The navigator must stay usable after a Host-side search.
        await shotPage.fill('input[aria-label="搜索文件路径"]', 'module-01');
        await shotPage.waitForTimeout(500);
        await shotPage.screenshot({ path: join(options.shotsDir, 's2-04-search.png') });

        await shotPage.click('.git-views > button:has-text("历史")');
        await shotPage.waitForSelector('.git-history', { timeout: 30_000 });
        await shotPage.screenshot({ path: join(options.shotsDir, 's2-05-history.png') });

        // The compare view states its own stage instead of showing a blank pane.
        await shotPage.click('.git-views > button:has-text("比较")');
        await shotPage.waitForTimeout(300);
        await shotPage.screenshot({ path: join(options.shotsDir, 's2-06-compare-stage.png') });
      } finally {
        await shotPage.close();
      }
      result.shotsDir = options.shotsDir;
    }

    const page = await browser.newPage({ viewport });
    page.on('pageerror', error => result.notes.push(`pageerror: ${error.message}`));
    await page.goto(`http://127.0.0.1:${options.port}/`, { waitUntil: 'load' });
    await page.waitForSelector('button[aria-label="打开Git面板"]', { timeout: 30_000 });

    // Warm-up: one discarded pass so module loading is not charged to M1.
    await openGit(page);

    for (let iteration = 0; iteration < options.samples; iteration += 1) {
      // M1 — a genuine open: park on another resource panel first, because inactive
      // resource panels unmount, so the Git pane really is rebuilt here.
      await page.click('button[aria-label="打开文件面板"]').catch(() => undefined);
      await page.waitForTimeout(60);
      const openedAt = Date.now();
      await page.click('button[aria-label="打开Git面板"]');
      await page.waitForSelector('.git-row button', { timeout: 30_000 });
      samples.openPanel.push(Date.now() - openedAt);

      // M2 — selecting the large text file and getting the first diff paint.
      const targetRow = page.locator('.git-row button', { hasText: 'large/target.txt' });
      const diffAt = Date.now();
      await targetRow.first().click();
      await page.waitForSelector('.diff-body .diff-line', { timeout: 30_000 });
      samples.diffTarget.push(Date.now() - diffAt);

      // M3 — switching to another file, then back to the cached one.
      const otherRow = page.locator('.git-row button', { hasText: 'src/module-0000.ts' });
      if ((await otherRow.count()) > 0) {
        const switchAt = Date.now();
        await otherRow.first().click();
        await page.waitForSelector('.diff-body', { timeout: 30_000 });
        samples.switchFile.push(Date.now() - switchAt);
      }

      // M3 — switching views.
      const viewAt = Date.now();
      await page.click('.git-views > button:has-text("历史")');
      await page.waitForSelector('.git-history', { timeout: 30_000 });
      await page.click('.git-views > button:has-text("变更")');
      await page.waitForSelector('.git-row button', { timeout: 30_000 });
      samples.switchView.push(Date.now() - viewAt);
    }

    const statusHttp = await resourceDurations(page, '/git/status');
    const diffHttp = await resourceDurations(page, '/git/diff-v2/');

    result.metrics = {
      openPanelToChangeList: summarise(samples.openPanel),
      // The first read of the large file in this session is the cold sample; the rest are
      // warm. Separating them is required by §9 and they must not be averaged together.
      selectLargeFileToDiffPaintCold: summarise(samples.diffTarget.slice(0, 1)),
      selectLargeFileToDiffPaintWarm: summarise(samples.diffTarget.slice(1)),
      selectLargeFileToDiffPaint: summarise(samples.diffTarget),
      switchCachedFile: summarise(samples.switchFile),
      switchView: summarise(samples.switchView),
      httpGitStatus: summarise(statusHttp),
      httpGitDiffDocument: summarise(diffHttp),
    };
    result.raw = samples;
    result.httpRaw = { status: statusHttp, diffDocument: diffHttp };
  } finally {
    await browser.close().catch(() => undefined);
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 500));
    if (!child.killed) child.kill('SIGKILL');
  }

  result.hostStdout = hostLog.slice(-4000);
  mkdirSync(options.outDir, { recursive: true });
  const outFile = join(options.outDir, 's9-perf-baseline.json');
  writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ outFile, metrics: result.metrics }, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});
