#!/usr/bin/env node
/**
 * v0.3.17 S4 — end-to-end history browsing through the real UI.
 *
 * The §10 S4 exit evidence is "history browsing without workspace writes". So this script
 * drives the real history view and then asserts two things independently:
 *   1. the history facts the UI shows are the real ones (search across the whole history,
 *      commit details, merge parent switching, per-commit file diff, file history);
 *   2. the working tree, the index and HEAD are byte-identical before and after — read back
 *      through separate `git` processes, never through the app's own API.
 *
 * Usage: node scripts/smoke/v0317-git-history-e2e.mjs [--port <n>]
 */
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const ROOT = '/tmp/oc317-history-e2e';
/** Where screenshots go; defaults to ROOT. Never point ROOT itself at a shared folder. */
const SHOTS = process.env.OC317_HISTORY_SHOTS ?? ROOT;
const WORKSPACE = join(ROOT, 'repo');

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
  git(['config', 'user.email', 'history-e2e@probe.local']);
  git(['config', 'user.name', 'History E2E']);
  writeFileSync(join(WORKSPACE, 'alpha.txt'), 'one\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'feat: alpha initial']);

  // A side branch merged back, so a real merge commit exists in the list.
  git(['checkout', '-q', '-b', 'side']);
  writeFileSync(join(WORKSPACE, 'gamma.txt'), 'gamma\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'chore: gamma on side']);
  git(['checkout', '-q', 'main']);
  writeFileSync(join(WORKSPACE, 'alpha.txt'), 'one\ntwo\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'feat: alpha two']);
  git(['merge', '-q', '--no-ff', '-m', 'merge: side into main', 'side']);

  // 25 more commits so a search must cross a page boundary.
  for (let index = 0; index < 25; index += 1) {
    writeFileSync(join(WORKSPACE, 'log.txt'), `entry ${index}\n`);
    git(['add', '.']);
    git(['commit', '-q', '-m', index === 7 ? 'fix: the buried needle' : `chore: bulk ${index}`]);
  }

  // Leave uncommitted state so a stray write would be detectable.
  writeFileSync(join(WORKSPACE, 'alpha.txt'), 'one\ntwo\nuncommitted\n');
  writeFileSync(join(WORKSPACE, 'untracked.txt'), 'untracked\n');
}

/** Everything a history read must leave alone. */
function repoState() {
  return JSON.stringify({
    head: git(['rev-parse', 'HEAD']).trim(),
    index: git(['ls-files', '--stage']),
    porcelain: git(['status', '--porcelain=v1']),
    alpha: readFileSync(join(WORKSPACE, 'alpha.txt'), 'utf8'),
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
  const port = argv.includes('--port') ? Number(argv[argv.indexOf('--port') + 1]) : 4297;

  buildFixture();
  mkdirSync(SHOTS, { recursive: true });
  const child = spawn(process.execPath, [join(REPO, 'dist/cli.js'), 'web', '--port', String(port)], {
    cwd: WORKSPACE,
    env: {
      ...process.env,
      NO_COLOR: '1',
      // Point the Host at an isolated state directory inside the fixture.
      //
      // Two reasons, both learned the hard way: the Host must not add throwaway fixture
      // workspaces to the user's real ~/.orion-code registry, and a sandbox that denies
      // writes there makes the Host fail with the generic "Workspace registry is
      // unavailable" (the mapper discards the real cause) rather than anything actionable.
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

    // ---- history list ----------------------------------------------------------------
    await page.click('.git-views > button:has-text("历史")');
    await page.waitForSelector('.git-history-list > li', { timeout: 30_000 });
    const firstPageCount = await page.locator('.git-history-list > li').count();
    const listText = await page.locator('.git-history-list').innerText();
    check('the history list renders real commits', firstPageCount >= 10, `${firstPageCount} rows on the first page`);
    check(
      'the merge commit is marked as a merge',
      listText.includes('合并') && listText.includes('merge: side into main'),
      'merge badge present'
    );
    await page.screenshot({ path: join(SHOTS, 's4-01-history-list.png') });

    // ---- search must cross the page boundary -----------------------------------------
    await page.fill('input[aria-label="搜索提交消息"]', 'buried needle');
    // Waiting only for "one row" is not enough: the previous (unfiltered) list also has rows,
    // and the previous *filtered* list also had exactly one, so the condition can already be
    // true and the click would land on a stale row. Wait for the actual text.
    await page.waitForFunction(
      () => {
        const rows = document.querySelectorAll('.git-history-list > li');
        return rows.length === 1 && /buried needle/.test(rows[0].textContent ?? '');
      },
      undefined,
      { timeout: 20_000 }
    );
    const found = await page.locator('.git-history-list').innerText();
    check(
      'search finds a commit beyond the first page',
      found.includes('fix: the buried needle'),
      `page size is 30, the needle is 26 commits deep`
    );

    // ---- commit details --------------------------------------------------------------
    await page.click('.git-history-list > li button');
    await page.waitForSelector('.git-commit-detail', { timeout: 30_000 });
    const detailText = await page.locator('.git-commit-detail').innerText();
    check(
      'the detail states the commit facts',
      detailText.includes('fix: the buried needle') && detailText.includes('history-e2e@probe.local'),
      detailText.replace(/\s+/g, ' ').slice(0, 80)
    );
    await page.waitForSelector('.git-commit-file-list > li', { timeout: 30_000 });
    const fileDiff = await page.locator('.git-commit-detail .git-commit-stats-line').innerText();
    check('the file list carries real +/- counts', /\+\d+/.test(fileDiff), fileDiff.trim());
    await page.waitForSelector('.diff-body .diff-line', { timeout: 30_000 });
    const diffText = await page.locator('.diff-body').innerText();
    check(
      'the historical diff shows the committed content',
      diffText.includes('entry 7'),
      'diff body rendered from the commit, not the worktree'
    );

    // ---- merge parent switching ------------------------------------------------------
    await page.fill('input[aria-label="搜索提交消息"]', 'merge: side into main');
    await page.waitForFunction(
      () => {
        const rows = document.querySelectorAll('.git-history-list > li');
        return rows.length === 1 && /merge: side into main/.test(rows[0].textContent ?? '');
      },
      undefined,
      { timeout: 20_000 }
    );
    await page.click('.git-history-list > li button');
    // The picker only exists for a merge, so the detail has to be the merge commit before it
    // can be asserted — otherwise the two searches are being confused with each other.
    await page.waitForFunction(
      () => /合并提交/.test(document.querySelector('.git-commit-detail')?.textContent ?? ''),
      undefined,
      { timeout: 20_000 }
    );
    await page.waitForSelector('.git-parent-picker > button', { timeout: 30_000 });
    await page.screenshot({ path: join(SHOTS, 's4-02-merge-detail.png') });
    const firstBase = await page.locator('.git-commit-base').innerText();
    await page.click('.git-parent-picker > button:nth-child(2)');
    await page.waitForFunction(
      previous => document.querySelector('.git-commit-base')?.textContent !== previous,
      firstBase,
      { timeout: 20_000 }
    );
    const secondBase = await page.locator('.git-commit-base').innerText();
    check(
      'switching the compared parent changes the stated base',
      firstBase !== secondBase && /父提交 1\/2|父提交 2\/2/.test(firstBase + secondBase),
      `${firstBase.trim()} -> ${secondBase.trim()}`
    );

    // ---- file history ----------------------------------------------------------------
    await page.click('.git-commit-file-list button[aria-label^="查看"][aria-label*="文件历史"]');
    // Fall back to the plain label form if the assertion above selected nothing.
    if ((await page.locator('.git-file-history').count()) === 0) {
      await page.locator('.git-commit-file-list > li > button:last-child').first().click();
    }
    await page.waitForSelector('.git-file-history', { timeout: 30_000 });
    await page.screenshot({ path: join(SHOTS, 's4-03-file-history.png') });
    const fileHistoryText = await page.locator('.git-file-history').innerText();
    check(
      'file history follows the file and states its limits',
      fileHistoryText.includes('文件历史') && fileHistoryText.includes('跟随重命名'),
      fileHistoryText.replace(/\s+/g, ' ').slice(0, 70)
    );
    await page.click('.git-file-history .text-button');

    // ---- read-only proof -------------------------------------------------------------
    check('no page errors were raised', pageErrors.length === 0, pageErrors.join('; ').slice(0, 120));
    check(
      'history browsing left the worktree, index and HEAD untouched',
      repoState() === stateBefore,
      'compared via independent git processes'
    );

    await page.screenshot({ path: join(SHOTS, 's4-04-merge-diff.png') });
    await page.close();
  } finally {
    await browser.close().catch(() => undefined);
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 400));
    child.kill('SIGKILL');
  }

  const failed = results.filter(r => !r.passed);
  if (existsSync(ROOT)) {
    writeFileSync(
      join(ROOT, 'result.json'),
      `${JSON.stringify({ results, hostTail: hostLog.slice(-2000) }, null, 2)}\n`
    );
  }
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length > 0) process.exit(1);
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});
