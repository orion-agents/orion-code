#!/usr/bin/env node
/**
 * v0.3.17 S3 — end-to-end write verification through the real UI.
 *
 * The §10 S3 exit evidence is "real index/HEAD verification after a browser click", which is
 * a different claim from "the service method works". This script drives the actual panel:
 * click 暂存, then ask Git directly whether the index changed; click 取消暂存 and ask again;
 * type a message, submit, and check that HEAD really moved.
 *
 * Every assertion reads repository state through a separate `git` process, never through the
 * app's own API — a bug in the read model must not be able to certify a bug in the write path.
 *
 * Usage: node scripts/smoke/v0317-git-write-e2e.mjs [--port <n>]
 */
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const ROOT = '/tmp/oc317-write-e2e';
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
  git(['config', 'user.email', 'e2e@probe.local']);
  git(['config', 'user.name', 'E2E Probe']);
  // Deliberately small and deterministic: one file to stage, one to leave alone.
  writeFileSync(join(WORKSPACE, 'stage-me.txt'), 'before\n');
  writeFileSync(join(WORKSPACE, 'leave-me.txt'), 'before\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'baseline']);
  writeFileSync(join(WORKSPACE, 'stage-me.txt'), 'after\n');
  writeFileSync(join(WORKSPACE, 'leave-me.txt'), 'after\n');
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
  const port = argv.includes('--port') ? Number(argv[argv.indexOf('--port') + 1]) : 4298;

  buildFixture();
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
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
    await page.waitForSelector('button[aria-label="打开Git面板"]', { timeout: 30_000 });
    await page.click('button[aria-label="打开Git面板"]');
    await page.waitForSelector('.git-row', { timeout: 30_000 });

    // ---- M1: staging through a real click -------------------------------------------------
    const beforeStage = tryGit(['show', ':stage-me.txt']);
    await page.click('button[aria-label="暂存 stage-me.txt"]');
    await page.waitForSelector('.git-group:has-text("已暂存") .git-row', { timeout: 20_000 });
    const afterStage = tryGit(['show', ':stage-me.txt']);
    check(
      'clicking 暂存 changes the real index',
      afterStage?.trim() === 'after' && beforeStage?.trim() === 'before',
      `index before="${beforeStage?.trim()}" after="${afterStage?.trim()}"`
    );
    check(
      'the untouched file stayed out of the index',
      tryGit(['show', ':leave-me.txt'])?.trim() === 'before',
      `leave-me.txt index="${tryGit(['show', ':leave-me.txt'])?.trim()}"`
    );

    // ---- M2: unstaging through a real click ------------------------------------------------
    await page.click('button[aria-label="取消暂存 stage-me.txt"]');
    await page.waitForTimeout(1_500);
    const unstageError = await page
      .locator('.resource-error')
      .first()
      .innerText()
      .catch(() => '');
    check(
      'clicking 取消暂存 returns the index to HEAD',
      tryGit(['show', ':stage-me.txt'])?.trim() === 'before',
      `index="${tryGit(['show', ':stage-me.txt'])?.trim()}"${unstageError ? ` | panel error: ${unstageError}` : ''}`
    );

    // ---- M3: commit through the real form --------------------------------------------------
    await page.click('button[aria-label="暂存 stage-me.txt"]');
    await page.waitForSelector('.git-commit-toggle', { timeout: 20_000 });
    await page.click('.git-commit-toggle');
    await page.waitForSelector('.git-commit-body', { timeout: 20_000 });

    const headBefore = git(['rev-parse', 'HEAD']).trim();
    const previewText = await page.locator('.git-commit-meta').innerText();
    check(
      'the form states identity and hook status',
      previewText.includes('e2e@probe.local') && /hooks/.test(previewText),
      previewText.replace(/\s+/g, ' ').slice(0, 90)
    );
    // The preview describes the real index, so it must converge on 1 file after the stage
    // above — and it must do so without the change list being filtered. Wait for convergence
    // rather than racing it; never converging is the failure this check is looking for.
    const converged = await page
      .waitForFunction(
        () => /提交 1 个文件/.test(document.querySelector('.git-commit-toggle')?.textContent ?? ''),
        undefined,
        { timeout: 15_000 }
      )
      .then(() => true)
      .catch(() => false);
    const toggleText = await page.locator('.git-commit-toggle').innerText();
    check(
      'the commit preview describes the real index, not the change list',
      converged && /1 个文件/.test(toggleText),
      toggleText.trim().replace(/\n+/g, ' ')
    );

    await page.fill('.git-commit-body input[type="text"]', 'feat: e2e commit');
    await page.fill('.git-commit-body textarea', 'body line one\nbody line two');
    await page.click('.git-commit-body button.primary-button');
    // `aria-busy` is rendered as the string "false" when idle, so compare explicitly rather
    // than testing truthiness.
    await page.waitForFunction(
      () =>
        document.querySelector('.git-commit-body button.primary-button')?.getAttribute('aria-busy') !==
        'true',
      undefined,
      { timeout: 40_000 }
    );
    const commitError = await page
      .locator('.resource-error')
      .first()
      .innerText()
      .catch(() => '');

    const headAfter = git(['rev-parse', 'HEAD']).trim();
    const message = git(['log', '-1', '--format=%B']);
    check(
      'submitting the form moves HEAD to a new commit',
      headAfter !== headBefore,
      `${headBefore.slice(0, 8)} -> ${headAfter.slice(0, 8)}${commitError ? ` | panel error: ${commitError}` : ''}`
    );
    check(
      'the commit keeps the summary and the multi-line body',
      message.includes('feat: e2e commit') && message.includes('body line two'),
      message.trim().replace(/\n+/g, ' / ')
    );
    check(
      'the worktree file survived the commit',
      tryGit(['show', 'HEAD:stage-me.txt'])?.trim() === 'after',
      `HEAD file="${tryGit(['show', 'HEAD:stage-me.txt'])?.trim()}"`
    );

    await page.screenshot({ path: join(ROOT, 'after-commit.png') });
    await page.close();
  } finally {
    await browser.close().catch(() => undefined);
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 400));
    child.kill('SIGKILL');
  }

  const failed = results.filter(r => !r.passed);
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, 'result.json'), `${JSON.stringify({ results, hostTail: hostLog.slice(-2000) }, null, 2)}\n`);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length > 0) process.exit(1);
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});
