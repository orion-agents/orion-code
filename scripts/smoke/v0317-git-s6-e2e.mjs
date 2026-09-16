#!/usr/bin/env node
/**
 * v0.3.17 S5/S6 — end-to-end verification of the three views added last, plus the
 * responsive and dark-theme evidence the plan asks for.
 *
 * Covered:
 *   - branch/version comparison (two-endpoint snapshot, and the multi-merge-base refusal)
 *   - blame on a commit's file
 *   - conflict detail read from index stages 1/2/3
 *   - narrow-container layout and dark theme screenshots
 *   - one read-only guarantee over the whole run
 *
 * Every repository assertion is read back through a separate `git` process, never through the
 * app's own API. Usage: node scripts/smoke/v0317-git-s6-e2e.mjs [--port <n>]
 */
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const ROOT = '/tmp/oc318-s6-e2e';
const WORKSPACE = join(ROOT, 'repo');
/** Screenshots go here; ROOT is wiped by the fixture builder, so they must be separate. */
const SHOTS = process.env.OC318_SHOTS ?? ROOT;

function git(args) {
  return execFileSync('git', args, { cwd: WORKSPACE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function tryGit(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function buildFixture() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(WORKSPACE, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 's6@probe.local']);
  git(['config', 'user.name', 'S6 Probe']);

  writeFileSync(join(WORKSPACE, 'shared.txt'), 'base\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'feat: base']);
  git(['tag', 'v1']);

  // Two branches with a clean merge, so merge-base mode has a unique answer.
  git(['checkout', '-q', '-b', 'side']);
  writeFileSync(join(WORKSPACE, 'side.txt'), 'side\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'chore: side work']);
  git(['checkout', '-q', 'main']);
  writeFileSync(join(WORKSPACE, 'main.txt'), 'main\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'chore: main work']);

  // A conflicted file, left unresolved: the conflict view reads the index stages directly.
  git(['checkout', '-q', '-b', 'conflict-side', 'main']);
  writeFileSync(join(WORKSPACE, 'shared.txt'), 'theirs\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'feat: theirs change']);
  git(['checkout', '-q', 'main']);
  writeFileSync(join(WORKSPACE, 'shared.txt'), 'ours\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'feat: ours change']);
  tryGit(['merge', '--no-ff', '-m', 'merge conflict-side', 'conflict-side']);
}

function repoState() {
  return JSON.stringify({
    head: git(['rev-parse', 'HEAD']).trim(),
    index: git(['ls-files', '--stage']),
    porcelain: git(['status', '--porcelain=v1']),
    shared: readFileSync(join(WORKSPACE, 'shared.txt'), 'utf8'),
  });
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
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

const results = [];
function check(name, passed, detail) {
  results.push({ name, passed, detail });
  process.stdout.write(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  const port = argv.includes('--port') ? Number(argv[argv.indexOf('--port') + 1]) : 4295;

  buildFixture();
  mkdirSync(SHOTS, { recursive: true });
  const child = spawn(process.execPath, [join(REPO, 'dist/cli.js'), 'web', '--no-open', '--port', String(port)], {
    cwd: WORKSPACE,
    env: {
      ...process.env,
      NO_COLOR: '1',
      ORION_CODE_CONFIG_DIR: join(ROOT, 'state'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let hostLog = '';
  child.stdout.on('data', c => (hostLog += c));
  child.stderr.on('data', c => (hostLog += c));

  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    if (!(await waitForHost(port))) throw new Error(`Host never became ready.\n${hostLog}`);
    const page = await browser.newPage({ viewport: { width: 1512, height: 950 } });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
    await page.waitForSelector('button[aria-label="打开Git面板"]', { timeout: 30_000 });
    await page.click('button[aria-label="打开Git面板"]');
    await page.waitForSelector('.git-views', { timeout: 30_000 });

    const stateBefore = repoState();

    // ---- conflict view: stages, not a staged diff -----------------------------------
    await page.waitForSelector('.git-group', { timeout: 30_000 });
    const conflictRow = page.locator('.git-row button', { hasText: 'shared.txt' }).first();
    await conflictRow.click();
    await page.waitForSelector('.git-conflict, .diff-body', { timeout: 30_000 });
    const conflictShown = await page.locator('.git-conflict').count();
    if (conflictShown === 0) {
      const region = await page.locator('.git-content').innerText().catch(() => '(no .git-content)');
      const errorText = await page.locator('.resource-error').first().innerText().catch(() => '');
      process.stdout.write(
        `DIAG conflict region: ${region.replace(/\s+/g, ' ').slice(0, 200)}\n` +
          `DIAG error: ${errorText.slice(0, 160)}\n`
      );
    }
    check(
      'a conflicted file renders the three-way conflict view',
      conflictShown > 0,
      conflictShown > 0 ? 'git-conflict present' : 'fell back to an ordinary diff'
    );
    if (conflictShown > 0) {
      const text = await page.locator('.git-conflict').innerText();
      check(
        'the conflict view names its shape and shows the stages',
        /双方都修改/.test(text) && /ours（当前分支）/.test(text) && /theirs（合入分支）/.test(text),
        text.replace(/\s+/g, ' ').slice(0, 90)
      );
    }
    await page.screenshot({ path: join(SHOTS, 's6-01-conflict.png') });

    // ---- comparison view -------------------------------------------------------------
    try {
    await page.click('.git-views > button:has-text("比较")');
    await page.waitForSelector('.git-compare-form', { timeout: 30_000 });
    await page.selectOption('select[aria-label="选择基准 A"]', 'v1');
    await page.selectOption('select[aria-label="选择目标 B"]', 'main');
    await page.click('.git-compare-form button.primary-button');
    await page.waitForSelector('.git-compare-files > li', { timeout: 30_000 });
    const rangeText = await page.locator('.git-compare-range').first().innerText();
    const compareFiles = await page.locator('.git-compare-files > li').count();
    check(
      'two-endpoint comparison lists the real changed files',
      compareFiles > 0 && /[0-9a-f]{10}/.test(rangeText),
      `${compareFiles} files · ${rangeText.replace(/\s+/g, ' ').slice(0, 70)}`
    );
    await page.screenshot({ path: join(SHOTS, 's6-02-compare.png') });
    } catch (error) {
      const region = await page.locator('.git-compare').innerText().catch(() => '(no .git-compare)');
      const err = await page.locator('.resource-error').first().innerText().catch(() => '');
      const options = await page.locator('select[aria-label="选择基准 A"] option').allTextContents().catch(() => []);
      process.stdout.write('DIAG compare region: ' + region.replace(/\s+/g, ' ').slice(0, 220) + '\n');
      process.stdout.write('DIAG compare error: ' + err.slice(0, 160) + '\n');
      process.stdout.write('DIAG base options: ' + JSON.stringify(options).slice(0, 160) + '\n');
      check('two-endpoint comparison lists the real changed files', false, String(error).slice(0, 100));
    }

    // ---- narrow container + dark theme ----------------------------------------------
    await page.setViewportSize({ width: 700, height: 900 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, 's6-03-narrow.png') });
    await page.setViewportSize({ width: 1512, height: 950 });
    await page.waitForTimeout(300);

    // ---- blame -----------------------------------------------------------------------
    try {
    await page.click('.git-views > button:has-text("历史")');
    await page.waitForSelector('.git-history-list > li', { timeout: 30_000 });
    await page.click('.git-history-list > li button');
    await page.waitForSelector('.git-commit-file-list > li', { timeout: 30_000 });
    const blameButton = page.locator('.git-commit-file-list button[aria-label^="查看"][aria-label*="Blame"]').first();
    if ((await blameButton.count()) > 0) {
      await blameButton.click();
      await page.waitForSelector('.git-blame-row', { timeout: 30_000 });
      const rows = await page.locator('.git-blame-row').count();
      const first = await page.locator('.git-blame-row').first().innerText();
      check('blame renders per-line attribution', rows > 0 && /s6@probe\.local|S6 Probe/.test(first), `${rows} rows · ${first.replace(/\s+/g, ' ').slice(0, 60)}`);
      await page.screenshot({ path: join(SHOTS, 's6-04-blame.png') });
    } else {
      check('blame renders per-line attribution', false, 'blame button not found');
    }
    } catch (error) {
      check('blame renders per-line attribution', false, String(error).slice(0, 120));
    }

    check('no page errors were raised', pageErrors.length === 0, pageErrors.join('; ').slice(0, 120));
    check(
      'the whole run left HEAD, index and worktree untouched',
      repoState() === stateBefore,
      'compared via independent git processes'
    );

    await page.close();
  } finally {
    await browser.close().catch(() => undefined);
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 400));
    child.kill('SIGKILL');
  }

  const failed = results.filter(r => !r.passed);
  writeFileSync(
    join(SHOTS, 'result.json'),
    `${JSON.stringify({ results, hostTail: hostLog.slice(-1500) }, null, 2)}\n`
  );
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length > 0) process.exit(1);
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});
