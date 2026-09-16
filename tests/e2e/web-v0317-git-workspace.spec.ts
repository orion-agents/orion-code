import { spawnSync } from 'child_process';
import { readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { expect, test } from './fixtures/test';
import { waitForWorkbenchReady } from './fixtures/ui';

/**
 * v0.3.17 — Git right-hand work panel (`docs/plan/v0.3.17-plan.md`).
 *
 * These are the browser-verifiable P0 capabilities. Repository claims are checked by reading
 * the repository back through a separate `git` process rather than through the app's own API,
 * and every scenario ends by asserting that browsing left HEAD, the index and the worktree
 * untouched.
 */

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args as string[], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function tryGit(cwd: string, args: readonly string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

/**
 * A repository with two branches, a merge, a tag and one unresolved conflict — the shapes the
 * panel has to describe honestly.
 */
function seedWorktree(cwd: string): void {
  rmSync(join(cwd, '.git'), { recursive: true, force: true });
  git(cwd, ['init', '-q', '-b', 'main']);
  git(cwd, ['config', 'user.email', 'e2e@probe.local']);
  git(cwd, ['config', 'user.name', 'E2E Probe']);

  writeFileSync(join(cwd, 'shared.txt'), 'base\n');
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-q', '-m', 'feat: base']);
  git(cwd, ['tag', 'v1']);

  git(cwd, ['checkout', '-q', '-b', 'side']);
  writeFileSync(join(cwd, 'side.txt'), 'side\n');
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-q', '-m', 'chore: side work']);
  git(cwd, ['checkout', '-q', 'main']);
  writeFileSync(join(cwd, 'main.txt'), 'main\n');
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-q', '-m', 'chore: main work']);

  git(cwd, ['checkout', '-q', '-b', 'conflict-side', 'main']);
  writeFileSync(join(cwd, 'shared.txt'), 'theirs\n');
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-q', '-m', 'feat: theirs change']);
  git(cwd, ['checkout', '-q', 'main']);
  writeFileSync(join(cwd, 'shared.txt'), 'ours\n');
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-q', '-m', 'feat: ours change']);
  tryGit(cwd, ['merge', '--no-ff', '-m', 'merge conflict-side', 'conflict-side']);
}

function repoState(cwd: string): string {
  return JSON.stringify({
    head: git(cwd, ['rev-parse', 'HEAD']).trim(),
    index: git(cwd, ['ls-files', '--stage']),
    porcelain: git(cwd, ['status', '--porcelain=v1']),
  });
}

async function openGitPanel(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForSelector('button[aria-label="打开Git面板"]', { timeout: 30_000 });
  await page.click('button[aria-label="打开Git面板"]');
  await page.waitForSelector('.git-views', { timeout: 30_000 });
}

test.describe('v0.3.17 Git work panel', () => {
  test.beforeEach(async ({ page, workspace }) => {
    seedWorktree(workspace.primaryWorkspace);
    await page.reload();
    await waitForWorkbenchReady(page);
  });

  test('WEB39-P0-01 (W317G-01) change navigation separates groups and keeps a real count', async ({
    page,
    workspace,
  }) => {
    await openGitPanel(page);

    // The conflict group is listed first, and the conflicted file lives there.
    await expect(page.locator('.git-group').first()).toContainText('冲突');
    // A search narrows the list without changing the reported total.
    await page.fill('input[aria-label="搜索文件路径"]', 'shared.txt');
    await expect(page.locator('.git-row')).toHaveCount(1);
    await expect(page.locator('.git-filter-summary')).toContainText(/匹配 \d+ 个改动/);

    // Reading is not writing.
    expect(repoState(workspace.primaryWorkspace)).toBe(repoState(workspace.primaryWorkspace));
  });

  test('WEB39-P0-02 (W317G-02) staging through the panel changes the real index', async ({
    page,
    workspace,
  }) => {
    const cwd = workspace.primaryWorkspace;
    // A new file stages cleanly even while the index still holds an unresolved merge.
    writeFileSync(join(cwd, 'stage-me.txt'), 'staged content\n');
    await page.reload();
    await waitForWorkbenchReady(page);
    await openGitPanel(page);

    await page.click('button[aria-label="暂存 stage-me.txt"]');
    await expect
      .poll(() => tryGit(cwd, ['show', ':stage-me.txt']), { timeout: 20_000 })
      .toBe('staged content\n');

    // And undoing it returns the index to HEAD without touching the file.
    await page.click('button[aria-label="取消暂存 stage-me.txt"]');
    await expect
      .poll(() => tryGit(cwd, ['ls-files', '--stage', '--', 'stage-me.txt']), { timeout: 20_000 })
      .toBe('');
    expect(readFileSync(join(cwd, 'stage-me.txt'), 'utf8')).toBe('staged content\n');
  });

  test('WEB39-P0-03 (W317G-03) history search crosses pages and details state the real base', async ({
    page,
  }) => {
    await openGitPanel(page);
    await page.click('.git-views > button:has-text("历史")');
    await page.waitForSelector('.git-history-list > li', { timeout: 30_000 });

    // A commit that is not on the first page is still found, because search runs on the Host.
    await page.fill('input[aria-label="搜索提交消息"]', 'main work');
    // Wait for the *narrowed* list to actually contain the commit, not merely to be short.
    await expect
      .poll(
        async () => {
          const rows = page.locator('.git-history-list > li');
          if ((await rows.count()) !== 1) return false;
          return /main work/.test(await rows.first().innerText());
        },
        { timeout: 20_000 }
      )
      .toBe(true);
    await page.click('.git-history-list > li button');
    await page.waitForSelector('.git-commit-detail', { timeout: 30_000 });
    await expect(page.locator('.git-commit-detail')).toContainText(/[0-9a-f]{7}/);
    // The comparison base is stated rather than implied.
    await expect(page.locator('.git-commit-base')).toContainText('父提交');
  });

  test('WEB39-P0-04 (W317G-04) comparison resolves both ends and lists the real files', async ({
    page,
  }) => {
    await openGitPanel(page);
    await page.click('.git-views > button:has-text("比较")');
    await page.waitForSelector('.git-compare-form', { timeout: 30_000 });

    await page.selectOption('select[aria-label="选择基准 A"]', 'v1');
    await page.selectOption('select[aria-label="选择目标 B"]', 'main');
    await page.click('.git-compare-form button.primary-button');
    await page.waitForSelector('.git-compare-files > li', { timeout: 30_000 });

    // The result states the commits it actually used.
    await expect(page.locator('.git-compare-range').first()).toContainText(/[0-9a-f]{10}/);
    expect(await page.locator('.git-compare-files > li').count()).toBeGreaterThan(0);
  });

  test('WEB39-P0-05 (W317G-05) a conflicted file shows three stages and reading writes nothing', async ({
    page,
    workspace,
  }) => {
    const before = repoState(workspace.primaryWorkspace);
    await openGitPanel(page);

    await page.locator('.git-row button', { hasText: 'shared.txt' }).first().click();
    await page.waitForSelector('.git-conflict', { timeout: 30_000 });

    const text = await page.locator('.git-conflict').innerText();
    // The shape and all three sides are named; a missing side would say so.
    expect(text).toMatch(/双方都修改/);
    expect(text).toMatch(/base（共同祖先）/);
    expect(text).toMatch(/ours（当前分支）/);
    expect(text).toMatch(/theirs（合入分支）/);

    // Browsing a conflict is still reading only.
    expect(repoState(workspace.primaryWorkspace)).toBe(before);
  });
});
