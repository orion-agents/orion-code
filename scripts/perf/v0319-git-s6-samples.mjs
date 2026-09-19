#!/usr/bin/env node
/**
 * v0.3.19 (G317-20) — S5/S6 performance samples for the Git work panel.
 *
 * The v0.3.17 §9 baseline (`v0317-git-baseline.mjs`) covers the S2 reads: opening the panel,
 * switching files, switching views. This script covers what was added afterwards and had no
 * samples at all:
 *
 *   M5  comparison — resolving a range and painting the first compared diff
 *   M6  blame — the first blame table for one file at one commit
 *   M7  repeated open/close — whether the cost of opening grows (the outside view of a leak)
 *   M8  a hundred consecutive diffs — per-read cost, request count and DOM size
 *   M9  a large diff — whether the output is bounded instead of loaded whole
 *
 * Every metric keeps its raw samples; p50/p95 are derived and never asserted here. The only
 * assertions are the boundedness ones, because those are the claims G317-20 actually makes
 * ("进程、网络、缓存、DOM 有界").
 *
 * Usage:
 *   node scripts/perf/v0319-git-s6-samples.mjs [--fixture <dir>] [--port <n>] [--samples <n>]
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

const DEFAULTS = {
  fixture: '/tmp/oc319-perf/fixture',
  port: 4298,
  rounds: 30,
  diffs: 100,
  outDir: resolve(REPO, '../../orion-code/docs/plan/evidence/v0.3.17-git'),
};

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fixture') options.fixture = argv[++index];
    else if (arg === '--port') options.port = Number(argv[++index]);
    else if (arg === '--rounds') options.rounds = Number(argv[++index]);
    else if (arg === '--diffs') options.diffs = Number(argv[++index]);
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

async function domSize(page) {
  return page.evaluate(() => document.querySelectorAll('*').length);
}

async function gitRequestCount(page) {
  return page.evaluate(
    () =>
      performance.getEntriesByType('resource').filter(entry => entry.name.includes('/git/')).length
  );
}

async function environmentBlock() {
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
    browser: tryRun('bash', [
      '-lc',
      '/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "/Applications/Google Chrome.app/Contents/Info.plist"',
    ]),
    recordedAt: new Date().toISOString(),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.fixture)) {
    throw new Error(`Fixture not found: ${options.fixture}. Run v0317-git-fixture.mjs first.`);
  }
  const cli = join(REPO, 'dist/cli.js');
  if (!existsSync(cli)) throw new Error('Build first: dist/cli.js is missing.');

  const child = spawn(process.execPath, [cli, 'web', '--port', String(options.port)], {
    cwd: options.fixture,
    env: {
      ...process.env,
      NO_COLOR: '1',
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
    rounds: options.rounds,
    diffs: options.diffs,
    method:
      '生产构建（dist/cli.js + dist/web-client）+ 真实 Chrome；每轮先切到文件面板再打开 Git，' +
      '因为非活动资源面板会卸载，所以「打开」是真实重建而不是复用。',
    metrics: {},
    bounded: {},
    notes: [],
  };

  try {
    if (!(await waitForHost(options.port))) {
      throw new Error(`Host did not become ready on port ${options.port}.\n${hostLog}`);
    }
    const viewport = { width: 1512, height: 950 };
    const page = await browser.newPage({ viewport });
    page.on('pageerror', error => result.notes.push(`pageerror: ${error.message}`));
    await page.goto(`http://127.0.0.1:${options.port}/`, { waitUntil: 'load' });
    await page.waitForSelector('button[aria-label="打开Git面板"]', { timeout: 30_000 });

    const openGit = async () => {
      const active = page.locator('button[aria-label="打开Git面板"][aria-current="page"]');
      if ((await active.count()) === 0) await page.click('button[aria-label="打开Git面板"]');
      await page.waitForSelector('.git-views', { timeout: 30_000 });
    };
    const leaveGit = async () => {
      await page.click('button[aria-label="打开文件面板"]').catch(() => undefined);
      await page.waitForTimeout(40);
    };
    const rowButtons = () => page.locator('.git-row > button:not([aria-label])');

    await openGit();
    await page.waitForSelector('.git-row > button:not([aria-label])', { timeout: 30_000 });

    // ---- M5 comparison --------------------------------------------------------------
    const compareSamples = [];
    const compareDiffSamples = [];
    for (let round = 0; round < Math.min(options.rounds, 10); round += 1) {
      await page.click('.git-views > button:has-text("比较")');
      await page.waitForSelector('.git-compare-form', { timeout: 30_000 });
      // The ref list arrives from the Host asynchronously; reading the options immediately
      // measures the loading state, not the comparison.
      await page
        .waitForFunction(
          () =>
            document.querySelectorAll('select[aria-label="选择基准 A"] option').length >= 2 &&
            document.querySelectorAll('select[aria-label="选择目标 B"] option').length >= 2,
          { timeout: 30_000 }
        )
        .catch(() => undefined);
      const options5 = await page.locator('select[aria-label="选择基准 A"] option').allTextContents();
      if (options5.length < 2) {
        if (!result.compareSkippedReason) {
          result.compareSkippedReason = `only ${options5.length} base options were offered`;
        }
        break;
      }
      // The comparison is refused when both ends are the same ref (the button stays disabled),
      // so pick a pair that actually differs.
      const values = async selector =>
        page
          .locator(`${selector} option`)
          .evaluateAll(nodes => nodes.map(node => node.value));
      const baseValues = await values('select[aria-label="选择基准 A"]');
      const targetValues = await values('select[aria-label="选择目标 B"]');
      const basePick = baseValues.find(value => value);
      const targetPick = targetValues.find(value => value && value !== basePick);
      if (!basePick || !targetPick) {
        result.compareSkippedReason = `no distinct ref pair (A=${baseValues.length}, B=${targetValues.length})`;
        break;
      }
      await page.selectOption('select[aria-label="选择基准 A"]', basePick);
      await page.selectOption('select[aria-label="选择目标 B"]', targetPick);
      const resolvedAt = Date.now();
      await page.click('.git-compare-form button.primary-button');
      await page.waitForSelector('.git-compare-files > li', { timeout: 30_000 });
      compareSamples.push(Date.now() - resolvedAt);

      const diffAt = Date.now();
      await page.locator('.git-compare-files > li button').first().click();
      await page.waitForSelector('.diff-body .diff-line', { timeout: 30_000 });
      compareDiffSamples.push(Date.now() - diffAt);
      await page.click('.git-views > button:has-text("变更")');
      await page.waitForSelector('.git-views', { timeout: 30_000 });
    }

    // ---- M6 blame -------------------------------------------------------------------
    const blameSamples = [];
    for (let round = 0; round < Math.min(options.rounds, 10); round += 1) {
      await page.click('.git-views > button:has-text("历史")');
      await page.waitForSelector('.git-history-list > li', { timeout: 30_000 });
      await page.click('.git-history-list > li button');
      await page.waitForSelector('.git-commit-detail', { timeout: 30_000 });
      const blameButton = page.locator('button[aria-label$="的 Blame"]').first();
      if ((await blameButton.count()) === 0) break;
      const blameAt = Date.now();
      await blameButton.click();
      await page.waitForSelector('.git-blame-row', { timeout: 30_000 });
      blameSamples.push(Date.now() - blameAt);
      await page.click('.git-views > button:has-text("变更")');
      await page.waitForSelector('.git-views', { timeout: 30_000 });
    }

    // ---- M7 repeated open/close -----------------------------------------------------
    const openSamples = [];
    const domAfterOpen = [];
    for (let round = 0; round < options.rounds; round += 1) {
      await leaveGit();
      const startedAt = Date.now();
      await openGit();
      await page.waitForSelector('.git-row > button:not([aria-label])', { timeout: 30_000 });
      openSamples.push(Date.now() - startedAt);
      domAfterOpen.push(await domSize(page));
    }

    // ---- M8 a hundred consecutive diffs ---------------------------------------------
    await page.fill('input[aria-label="搜索文件路径"]', 'bulk/');
    await page.waitForTimeout(300);
    const rows = await rowButtons().count();
    const domBeforeDiffs = await domSize(page);
    const requestsBeforeDiffs = await gitRequestCount(page);
    const diffSamples = [];
    for (let index = 0; index < Math.min(options.diffs, rows); index += 1) {
      const startedAt = Date.now();
      await rowButtons().nth(index).click();
      await page.waitForSelector('.diff-body', { timeout: 30_000 });
      diffSamples.push(Date.now() - startedAt);
    }
    const domAfterDiffs = await domSize(page);
    const requestsAfterDiffs = await gitRequestCount(page);

    // ---- M9 a large diff ------------------------------------------------------------
    await page.fill('input[aria-label="搜索文件路径"]', 'wide/');
    const wideRow = rowButtons().filter({ hasText: 'wide/diff.txt' }).first();
    // The list is re-read from the Host after the search, so wait for the row itself.
    await wideRow.waitFor({ timeout: 30_000 }).catch(() => undefined);
    const wide = { found: (await wideRow.count()) > 0 };
    if (wide.found) {
      const startedAt = Date.now();
      await wideRow.click();
      await page.waitForSelector('.diff-body .diff-line', { timeout: 30_000 });
      wide.firstPaintMs = Date.now() - startedAt;
      wide.renderedLines = await page.locator('.diff-body .diff-line').count();
      wide.hasContinuation = (await page.locator('.diff-footer button', { hasText: '加载更多 Diff' }).count()) > 0;
      wide.anchorCount = (await page.locator('.diff-anchor-count').first().innerText().catch(() => '')).trim();
      wide.domNodes = await domSize(page);
    }

    result.metrics = {
      compareResolve: summarise(compareSamples),
      compareFirstDiff: summarise(compareDiffSamples),
      blameFirstTable: summarise(blameSamples),
      openPanelRepeated: summarise(openSamples),
      hundredDiffs: summarise(diffSamples),
    };
    result.bounded = {
      // Opening a panel must not get steadily worse: that is what a leak looks like from the
      // outside when there is no heap snapshot available.
      openPanelFirst: openSamples[0] ?? null,
      openPanelLast: openSamples[openSamples.length - 1] ?? null,
      openPanelLastWithin4xFirst:
        openSamples.length > 1 ? openSamples[openSamples.length - 1] <= Math.max(2_000, openSamples[0] * 4) : null,
      domAfterOpenMin: domAfterOpen.length ? Math.min(...domAfterOpen) : null,
      domAfterOpenMax: domAfterOpen.length ? Math.max(...domAfterOpen) : null,
      rowsRendered: rows,
      diffsRead: diffSamples.length,
      domBeforeDiffs,
      domAfterDiffs,
      domGrowth: domAfterDiffs - domBeforeDiffs,
      requestsBeforeDiffs,
      requestsAfterDiffs,
      requestsAdded: requestsAfterDiffs - requestsBeforeDiffs,
      // Revisiting the same file must be served from the cache, so this has to stay below the
      // number of reads.
      requestsBelowReads: requestsAfterDiffs - requestsBeforeDiffs < diffSamples.length,
      wideDiff: wide,
      wideDiffBounded:
        wide.found === true &&
        typeof wide.renderedLines === 'number' &&
        wide.renderedLines <= 600,
    };
    result.raw = { compareSamples, compareDiffSamples, blameSamples, openSamples, diffSamples, domAfterOpen };
  } finally {
    await browser.close().catch(() => undefined);
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 500));
    if (!child.killed) child.kill('SIGKILL');
  }

  result.hostStdout = hostLog.slice(-4000);
  mkdirSync(options.outDir, { recursive: true });
  const outFile = join(options.outDir, 's9-perf-s5-s6-samples.json');
  writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ outFile, metrics: result.metrics, bounded: result.bounded }, null, 2)}\n`
  );
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});
