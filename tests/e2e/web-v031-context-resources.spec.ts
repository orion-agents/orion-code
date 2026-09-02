import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { basename, join } from 'path';

import type { Page, Request } from '@playwright/test';

import type {
  WebBootstrapV1,
  WebContextMutationResultV1,
  WebFileContentPageV1,
  WebFileTreePageV1,
  WebGitDiffPageV1,
  WebGitLogPageV1,
  WebGitStatusV1,
  WebPageV1,
  WebReviewSnapshotV1,
  WebSessionSummaryV1,
} from '../../src/web/protocol';
import {
  browserGet,
  browserMutation,
  foregroundSessionId,
  rememberForegroundSession,
  webBootstrap,
} from './fixtures/api';
import { allowExpectedNetworkFailures, expect, test } from './fixtures/test';
import { createSession, openInspector, waitForWorkbenchReady, workbenchUi } from './fixtures/ui';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test('WEB31-P0-02 cross-project Context CAS rejects a stale tab with zero side effects', async ({
  context,
  evidence,
  host,
  page,
  provider,
  workspace,
}, testInfo) => {
  const networkFailures: Array<{ method: string; path: string; error: string }> = [];
  const onRequestFailed = (request: Request) => {
    networkFailures.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      error: request.failure()?.errorText ?? '',
    });
  };
  let stalePage: Page | undefined;
  let detachStaleEvidence: (() => void) | undefined;
  page.on('requestfailed', onRequestFailed);
  try {
    await createSession(page, { name: 'Primary Context Session' });
    const primary = await webBootstrap(page);
    const primarySessionId = await foregroundSessionId(page, primary.workspaceId);

    await switchWorkspaceThroughUi(page, workspace.secondaryWorkspace);
    await createSession(page, { name: 'Secondary Context Session' });
    const secondary = await webBootstrap(page);
    const secondarySessionId = await foregroundSessionId(page, secondary.workspaceId);
    expect(secondary.workspace).toBe(realpathSync(workspace.secondaryWorkspace));

    stalePage = await context.newPage();
    stalePage.on('requestfailed', onRequestFailed);
    detachStaleEvidence = evidence.attachPage(stalePage);
    await stalePage.goto(host.url, { waitUntil: 'domcontentloaded' });
    await waitForWorkbenchReady(stalePage, { timeout: 30_000 });
    await rememberForegroundSession(stalePage, secondarySessionId, secondary.workspaceId);
    await stalePage.reload({ waitUntil: 'domcontentloaded' });
    await waitForWorkbenchReady(stalePage, { timeout: 30_000 });
    const stale = await webBootstrap(stalePage);
    expect(stale).toMatchObject({
      workspaceId: secondary.workspaceId,
      contextRevision: secondary.contextRevision,
    });
    expect(await foregroundSessionId(stalePage, secondary.workspaceId)).toBe(secondarySessionId);

    const secondarySessionsBefore = await workspaceSessions(stalePage, secondary.workspaceId);
    const providerRequestsBefore = provider.requests.length;

    const activated = await browserMutation<WebContextMutationResultV1>(
      page,
      '/api/v1/context/activate',
      {
        nonce: secondary.nonce,
        body: {
          requestId: randomUUID(),
          expectedContextRevision: secondary.contextRevision,
          workspaceId: primary.workspaceId,
          sessionId: primarySessionId,
        },
      }
    );
    expect(activated.status).toBe(200);
    expect(activated.body.bootstrap).toMatchObject({
      workspaceId: primary.workspaceId,
    });
    expect(activated.body.contextRevision).not.toBe(secondary.contextRevision);

    const staleActivation = await hostMutation(host.url, '/api/v1/context/activate', {
      nonce: stale.nonce,
      body: {
        requestId: randomUUID(),
        expectedContextRevision: stale.contextRevision,
        workspaceId: secondary.workspaceId,
        sessionId: secondarySessionId,
      },
    });
    expect(staleActivation.status).toBe(409);
    expect(problemCode(staleActivation.body)).toBe('context_revision_conflict');

    const staleCreate = await hostMutation(host.url, '/api/v1/sessions', {
      nonce: stale.nonce,
      body: {
        requestId: randomUUID(),
        expectedContextRevision: stale.contextRevision,
        workspaceId: secondary.workspaceId,
        name: 'MUST NOT EXIST',
      },
    });
    expect(staleCreate.status).toBe(409);
    expect(problemCode(staleCreate.body)).toBe('context_revision_conflict');

    const staleReadPaths = [
      '/api/v1/workspaces',
      `/api/v1/workspaces/${encodeURIComponent(secondary.workspaceId)}/sessions`,
      `/api/v1/workspaces/${encodeURIComponent(secondary.workspaceId)}/summary`,
      '/api/v1/skills',
      '/api/v1/mcp',
      '/api/v1/tool-details',
      '/api/v1/tool-details/not-a-real-artifact',
      '/api/v1/diagnostics',
    ];
    for (const path of staleReadPaths) {
      const response = await guardedHostGet(host.url, path, stale);
      expect(response.status, path).toBe(409);
      expect(problemCode(response.body), path).toBe('context_revision_conflict');
    }

    const authoritative = await webBootstrap(page);
    const secondarySessionsAfter = await workspaceSessions(page, secondary.workspaceId);
    const sideEffects = [
      authoritative.workspaceId !== primary.workspaceId,
      (await foregroundSessionId(page, primary.workspaceId)) !== primarySessionId,
      secondarySessionsAfter.items.length !== secondarySessionsBefore.items.length,
      secondarySessionsAfter.items.some(session => session.name === 'MUST NOT EXIST'),
      provider.requests.length !== providerRequestsBefore,
    ].filter(Boolean).length;
    expect(sideEffects).toBe(0);

    await expect
      .poll(() => foregroundSessionId(page, primary.workspaceId), { timeout: 30_000 })
      .toBe(primarySessionId);
    const screenshotName = 'web31-p0-02-context-cas.png';
    await page.screenshot({
      path: join(evidence.scenarioDirectory, screenshotName),
      animations: 'disabled',
    });
    evidence.recordFact('screenshot.context', basename(screenshotName));
    evidence.recordFact('web31.context_target_verified', true);
    evidence.recordFact('web31.context_conflict_side_effects', sideEffects);
    evidence.recordFact('web31.context_stale_read_conflicts', staleReadPaths.length);
  } finally {
    page.off('requestfailed', onRequestFailed);
    stalePage?.off('requestfailed', onRequestFailed);
    detachStaleEvidence?.();
    await stalePage?.close();
  }
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

test('WEB31-P0-05 file pages preserve line boundaries and block containment, symlink, and secret reads', async ({
  evidence,
  host,
  page,
  workspace,
}, testInfo) => {
  testInfo.setTimeout(180_000);
  git(workspace.primaryWorkspace, ['init', '-b', 'main']);
  git(workspace.primaryWorkspace, ['config', 'user.name', 'Orion Web E2E']);
  git(workspace.primaryWorkspace, ['config', 'user.email', 'web-e2e@example.invalid']);
  git(workspace.primaryWorkspace, ['add', '--all']);
  git(workspace.primaryWorkspace, ['commit', '-m', 'file panel base']);
  appendFileSync(workspace.primaryPath('.git/info/exclude'), '\nhuge-tree/\n', 'utf8');

  const fileScaleCount = 100_000;
  const hugeTreePath = workspace.primaryPath('huge-tree');
  createFileScale(hugeTreePath, fileScaleCount);

  const lineBodies = ['A', 'B', 'C', 'D'].map(marker => `${marker}${marker.repeat(39_999)}\n`);
  const expectedContent = lineBodies.join('');
  const pagedPath = workspace.primaryPath('paged-lines.txt');
  const sensitivePath = workspace.primaryPath('.env');
  const externalPath = join(workspace.rootDirectory, 'outside-file.txt');
  const symlinkPath = workspace.primaryPath('outside-link.txt');
  const binaryPath = workspace.primaryPath('binary-preview.dat');
  writeFileSync(pagedPath, expectedContent, 'utf8');
  writeFileSync(sensitivePath, `ORION_CODE_API_KEY=${workspace.environment.ORION_CODE_API_KEY}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  writeFileSync(externalPath, 'OUTSIDE_WORKSPACE_SENTINEL\n', { encoding: 'utf8', mode: 0o600 });
  symlinkSync(externalPath, symlinkPath, 'file');
  writeFileSync(binaryPath, Buffer.from([0x00, 0x01, 0x02, 0xff]));

  const bootstrap = await webBootstrap(page);
  const performanceBefore = await browserPerformanceCounters(page);
  const root = await guardedGet<WebFileTreePageV1>(page, '/api/v1/files', bootstrap, {
    parentId: 'workspace-root',
    pageSize: '100',
  });
  expect(root.status).toBe(200);
  const paged = fileNode(root.body, 'paged-lines.txt');
  const sensitive = fileNode(root.body, '.env');
  const escaped = fileNode(root.body, 'outside-link.txt');
  const binary = fileNode(root.body, 'binary-preview.dat');
  const hugeTree = fileNode(root.body, 'huge-tree');
  expect(sensitive).toMatchObject({ sensitive: true, readable: true });
  expect(escaped).toMatchObject({ kind: 'symlink', readable: false });
  expect(JSON.stringify(root.body)).not.toContain(workspace.primaryWorkspace);

  const binaryRead = await guardedGet<WebFileContentPageV1>(
    page,
    `/api/v1/files/${encodeURIComponent(binary.id)}/content`,
    bootstrap
  );
  expect(binaryRead.status).toBe(200);
  expect(binaryRead.body).toMatchObject({
    fileId: binary.id,
    binary: true,
    mediaType: 'application/octet-stream',
    nextCursor: null,
  });
  expect(binaryRead.body).not.toHaveProperty('content');

  const fileMetrics = await measureFileDirectory(page, bootstrap, hugeTree.id);
  expect(fileMetrics.items).toBe(100);
  expect(fileMetrics.warmP95Ms).toBeLessThanOrEqual(250);
  expect(fileMetrics.responseBytes).toBeLessThan(128 * 1024);

  const sensitiveRead = await guardedHostGet(
    host.url,
    `/api/v1/files/${encodeURIComponent(sensitive.id)}/content`,
    bootstrap
  );
  expect(sensitiveRead.status).toBe(403);
  expect(problemCode(sensitiveRead.body)).toBe('sensitive_file_blocked');
  expect(JSON.stringify(sensitiveRead.body)).not.toContain(
    workspace.environment.ORION_CODE_API_KEY
  );

  const escapedRead = await guardedHostGet(
    host.url,
    `/api/v1/files/${encodeURIComponent(escaped.id)}/content`,
    bootstrap
  );
  expect(escapedRead.status).toBe(403);
  expect(problemCode(escapedRead.body)).toBe('file_outside_workspace');
  expect(JSON.stringify(escapedRead.body)).not.toContain('OUTSIDE_WORKSPACE_SENTINEL');

  const forgedRead = await guardedHostGet(
    host.url,
    '/api/v1/files/..%2F..%2Foutside-file.txt/content',
    bootstrap
  );
  expect(forgedRead.status).toBe(400);
  expect(JSON.stringify(forgedRead.body)).not.toContain('OUTSIDE_WORKSPACE_SENTINEL');

  const pages: WebFileContentPageV1[] = [];
  let cursor: string | undefined;
  do {
    const result = await guardedGet<WebFileContentPageV1>(
      page,
      `/api/v1/files/${encodeURIComponent(paged.id)}/content`,
      bootstrap,
      { ...(cursor ? { cursor } : {}), limitBytes: '65536' }
    );
    expect(result.status).toBe(200);
    expect(result.body.binary).toBe(false);
    expect(result.body.content).toMatch(/\n$/u);
    expect(result.body.content?.split('\n').filter(Boolean)).toHaveLength(1);
    pages.push(result.body);
    cursor = result.body.nextCursor ?? undefined;
  } while (cursor && pages.length < 8);
  expect(cursor).toBeUndefined();
  expect(pages).toHaveLength(lineBodies.length);
  expect(pages.map(item => item.content ?? '').join('')).toBe(expectedContent);
  expect(pages.map(item => item.offsetBytes)).toEqual([0, 40_001, 80_002, 120_003]);

  const panel = await openWorkPanel(page, '文件');
  const tree = panel.getByRole('region', { name: '工作区文件' });
  await tree.getByRole('button', { name: /^目录 huge-tree/u }).click();
  await expect
    .poll(() => tree.locator('.file-node').count(), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(100);
  const fileDomNodes = await tree.locator('.file-node').count();
  expect(fileDomNodes).toBeLessThanOrEqual(120);
  await expect(tree.getByRole('button', { name: '加载更多', exact: true })).toBeVisible();
  const pagedFile = tree.getByRole('button', { name: /^文件 paged-lines\.txt，Git 未跟踪$/u });
  await expect(pagedFile).toBeVisible();
  await pagedFile.click();
  await expect(panel.getByRole('button', { name: '加载更多内容' })).toBeVisible();
  await panel.getByRole('button', { name: '加载更多内容' }).click();
  await expect.poll(() => panel.locator('.file-code-line').count()).toBeGreaterThanOrEqual(2);
  await expect(tree.getByRole('button', { name: '文件 .env，不可读取' })).toBeDisabled();
  await expect(
    tree.getByRole('button', { name: '符号链接 outside-link.txt，不可读取' })
  ).toBeDisabled();
  const binaryFile = tree.getByRole('button', {
    name: /^文件 binary-preview\.dat，Git 未跟踪$/u,
  });
  await expect(binaryFile).toBeVisible();
  await binaryFile.click();
  await expect(panel.getByText('二进制文件', { exact: true })).toBeVisible();
  const performanceAfter = await browserPerformanceCounters(page);
  const filePerformance = subtractCounters(
    performanceAfter.files,
    performanceBefore.files,
    'File performance counters'
  );
  expect(filePerformance.readOperations).toBeGreaterThanOrEqual(21);
  expect(filePerformance.bytesRead).toBeGreaterThan(0);
  expect(filePerformance.itemsParsed).toBeGreaterThan(0);
  expect(filePerformance.itemsParsed).toBeLessThan(10_000);

  const screenshotName = 'web31-p0-05-safe-file-pages.png';
  await panel.screenshot({
    path: join(evidence.scenarioDirectory, screenshotName),
    animations: 'disabled',
  });
  evidence.recordFact('screenshot.files', basename(screenshotName));
  evidence.recordFact('web31.file_security_verified', true);
  evidence.recordFact('web31.file_content_pages', pages.length);
  evidence.recordFact('web31.file_binary_verified', true);
  evidence.recordFact('web31.file_git_decoration', '未跟踪');
  evidence.recordFact('web31.file_scale_entries', fileScaleCount);
  evidence.recordFact('web31.file_page_warm_p95_ms', roundMetric(fileMetrics.warmP95Ms));
  evidence.recordFact('web31.file_page_cold_ms', roundMetric(fileMetrics.coldMs));
  evidence.recordFact('web31.file_page_response_bytes', fileMetrics.responseBytes);
  evidence.recordFact('web31.file_dom_nodes', fileDomNodes);
  evidence.recordFact('web31.file_read_operations', filePerformance.readOperations);
  evidence.recordFact('web31.file_bytes_read', filePerformance.bytesRead);
  evidence.recordFact('web31.file_items_parsed', filePerformance.itemsParsed);
  evidence.recordFact('web31.file_performance_budget', true);
});

test('WEB31-P0-06 Git status, log, and diff enforce state, revision, and long-line bounds', async ({
  evidence,
  host,
  page,
  workspace,
}, testInfo) => {
  testInfo.setTimeout(180_000);
  seedGitStateMatrix(workspace.primaryWorkspace);
  const bootstrap = await webBootstrap(page);
  const performanceBefore = await browserPerformanceCounters(page);

  const clean = await guardedGet<WebGitStatusV1>(page, '/api/v1/git/status', bootstrap, {
    pageSize: '2000',
  });
  expect(clean.status).toBe(200);
  expect(clean.body).toMatchObject({ isRepository: true, clean: true, detached: false });

  git(workspace.primaryWorkspace, ['checkout', '--detach', 'HEAD']);
  const detached = await guardedGet<WebGitStatusV1>(page, '/api/v1/git/status', bootstrap);
  expect(detached.status).toBe(200);
  expect(detached.body.detached).toBe(true);
  git(workspace.primaryWorkspace, ['switch', 'main']);

  createDirtyGitMatrix(workspace.primaryWorkspace);
  createGitStatusScale(workspace.primaryWorkspace, 2_000);
  const rawDiffBytes = measureRawGitDiffBytes(workspace.primaryWorkspace, 'large-diff.txt');
  expect(rawDiffBytes).toBeGreaterThanOrEqual(50 * 1024 * 1024);
  const dirty = await guardedGet<WebGitStatusV1>(page, '/api/v1/git/status', bootstrap, {
    pageSize: '2000',
  });
  expect(dirty.status).toBe(200);
  expect(dirty.body.clean).toBe(false);
  expect(dirty.body.staged.map(file => file.path)).toContain('staged.txt');
  expect(dirty.body.unstaged.map(file => file.path)).toEqual(
    expect.arrayContaining(['long-line.txt', 'tracked.txt'])
  );
  expect(dirty.body.untracked.map(file => file.path)).toContain('untracked.txt');
  expect(dirty.body.conflicted.map(file => file.path)).toContain('conflict.txt');
  expect(dirty.body.totalFiles).toBe(2_000);
  expect(dirty.body.truncated).toBe(false);

  const statusMetrics = await measureGitStatus(page, bootstrap);
  expect(statusMetrics.warmP95Ms).toBeLessThanOrEqual(500);
  expect(statusMetrics.items).toBe(2_000);

  const largeDiff = gitFile(dirty.body, 'large-diff.txt');
  const diffMetrics = await measureGitDiff(page, bootstrap, largeDiff.fileId);
  expect(diffMetrics.warmP95Ms).toBeLessThanOrEqual(400);
  expect(diffMetrics.lines).toBeGreaterThan(0);
  expect(diffMetrics.responseBytes).toBeLessThanOrEqual(1024 * 1024 + 64 * 1024);

  const firstLog = await guardedGet<WebGitLogPageV1>(page, '/api/v1/git/log', bootstrap, {
    pageSize: '1',
  });
  expect(firstLog.status).toBe(200);
  expect(firstLog.body.items).toHaveLength(1);
  expect(firstLog.body.nextCursor).toEqual(expect.any(String));
  const secondLog = await guardedGet<WebGitLogPageV1>(page, '/api/v1/git/log', bootstrap, {
    pageSize: '1',
    cursor: firstLog.body.nextCursor as string,
  });
  expect(secondLog.status).toBe(200);
  expect(secondLog.body.items).toHaveLength(1);
  expect(secondLog.body.items[0].id).not.toBe(firstLog.body.items[0].id);

  const tracked = gitFile(dirty.body, 'tracked.txt');
  const firstDiff = await guardedGet<WebGitDiffPageV1>(
    page,
    `/api/v1/git/diff/${encodeURIComponent(tracked.fileId)}`,
    bootstrap,
    { lineLimit: '5', byteLimit: String(256 * 1024) }
  );
  expect(firstDiff.status).toBe(200);
  expect(firstDiff.body.lines.length).toBeGreaterThan(0);
  expect(firstDiff.body.nextCursor).toEqual(expect.any(String));
  expect(JSON.stringify(firstDiff.body)).not.toContain(workspace.primaryWorkspace);

  const firstStatusPage = await guardedGet<WebGitStatusV1>(page, '/api/v1/git/status', bootstrap, {
    pageSize: '1',
  });
  expect(firstStatusPage.body.nextCursor).toEqual(expect.any(String));
  writeFileSync(workspace.primaryPath('late-untracked.txt'), 'late\n', 'utf8');
  const staleStatus = await guardedHostGet(host.url, '/api/v1/git/status', bootstrap, {
    pageSize: '1',
    cursor: firstStatusPage.body.nextCursor as string,
  });
  expect(staleStatus.status).toBe(409);
  expect(problemCode(staleStatus.body)).toBe('git_revision_conflict');

  appendFileSync(workspace.primaryPath('tracked.txt'), 'revision changed\n', 'utf8');
  const staleDiff = await guardedHostGet(
    host.url,
    `/api/v1/git/diff/${encodeURIComponent(tracked.fileId)}`,
    bootstrap,
    {
      lineLimit: '5',
      byteLimit: String(256 * 1024),
      cursor: firstDiff.body.nextCursor as string,
    }
  );
  expect(staleDiff.status).toBe(409);
  expect(problemCode(staleDiff.body)).toBe('git_revision_conflict');

  const refreshed = await guardedGet<WebGitStatusV1>(page, '/api/v1/git/status', bootstrap, {
    pageSize: '2000',
  });
  const longLine = gitFile(refreshed.body, 'long-line.txt');
  const oversizedDiff = await guardedHostGet(
    host.url,
    `/api/v1/git/diff/${encodeURIComponent(longLine.fileId)}`,
    bootstrap,
    { lineLimit: '500', byteLimit: '1024' }
  );
  expect(oversizedDiff.status).toBe(413);
  expect(problemCode(oversizedDiff.body)).toBe('git_line_too_long');

  const panel = await openWorkPanel(page, 'Git');
  await expect(panel.getByRole('region', { name: 'Git 变更' })).toContainText('冲突');
  await panel.getByRole('button').filter({ hasText: 'tracked.txt' }).first().click();
  await expect(
    panel.getByRole('region', { name: 'Git Diff' }).locator('.diff-viewer')
  ).toBeVisible();
  const performanceAfter = await browserPerformanceCounters(page);
  const gitPerformance = subtractCounters(
    performanceAfter.git,
    performanceBefore.git,
    'Git performance counters'
  );
  expect(gitPerformance.processCount).toBeGreaterThan(0);
  expect(gitPerformance.bytesRead).toBeGreaterThan(0);
  expect(gitPerformance.itemsParsed).toBeGreaterThan(0);
  const screenshotName = 'web31-p0-06-git-state-matrix.png';
  await panel.screenshot({
    path: join(evidence.scenarioDirectory, screenshotName),
    animations: 'disabled',
  });
  evidence.recordFact('screenshot.git', basename(screenshotName));
  evidence.recordFact('web31.git_state_matrix_verified', true);
  evidence.recordFact('web31.git_revision_conflicts', 2);
  evidence.recordFact('web31.git_long_line_status', oversizedDiff.status);
  evidence.recordFact('web31.git_changed_files', dirty.body.totalFiles);
  evidence.recordFact('web31.git_raw_diff_bytes', rawDiffBytes);
  evidence.recordFact('web31.git_status_warm_p95_ms', roundMetric(statusMetrics.warmP95Ms));
  evidence.recordFact('web31.git_status_cold_ms', roundMetric(statusMetrics.coldMs));
  evidence.recordFact('web31.git_diff_warm_p95_ms', roundMetric(diffMetrics.warmP95Ms));
  evidence.recordFact('web31.git_diff_cold_ms', roundMetric(diffMetrics.coldMs));
  evidence.recordFact('web31.git_diff_response_bytes', diffMetrics.responseBytes);
  evidence.recordFact('web31.git_process_count', gitPerformance.processCount);
  evidence.recordFact('web31.git_bytes_read', gitPerformance.bytesRead);
  evidence.recordFact('web31.git_items_parsed', gitPerformance.itemsParsed);
  evidence.recordFact('web31.git_performance_budget', true);
});

test('WEB31-P0-07 Review sends one structured hunk to an unsubmitted Composer draft', async ({
  evidence,
  page,
  provider,
  workspace,
}, testInfo) => {
  const networkFailures: Array<{ method: string; path: string; error: string }> = [];
  const onRequestFailed = (request: Request) => {
    networkFailures.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      error: request.failure()?.errorText ?? '',
    });
  };
  page.on('requestfailed', onRequestFailed);
  await createSession(page);
  seedReviewFixture(workspace.primaryWorkspace);
  const headBefore = git(workspace.primaryWorkspace, ['rev-parse', 'HEAD']);
  const contentBefore = readFileSync(workspace.primaryPath('review-target.ts'), 'utf8');
  const providerRequestsBefore = provider.requests.length;
  const bootstrap = await webBootstrap(page);
  const review = await guardedGet<WebReviewSnapshotV1>(page, '/api/v1/review', bootstrap);
  expect(review.status).toBe(200);
  expect(review.body.changedFiles.map(file => file.path)).toEqual(['review-target.ts']);

  const panel = await openWorkPanel(page, '审阅');
  await expect(panel.getByText('1 个变更文件', { exact: true })).toBeVisible();
  await panel.getByRole('button').filter({ hasText: 'review-target.ts' }).click();
  const sendHunk = panel.getByRole('button', { name: '发送此 Hunk 到对话' });
  await expect(sendHunk).toBeVisible();
  await sendHunk.click();

  const composer = workbenchUi(page).composer;
  await expect(composer).toHaveValue(/```review_context/u);
  const draft = await composer.inputValue();
  const metadataMatch = /```review_context\n([\s\S]*?)\n```/u.exec(draft);
  expect(metadataMatch).not.toBeNull();
  const metadata = JSON.parse(metadataMatch![1]) as Record<string, unknown>;
  expect(metadata).toEqual({
    schemaVersion: 1,
    type: 'review_context',
    repositoryRevision: review.body.repositoryRevision,
    path: 'review-target.ts',
    hunk: expect.stringMatching(/^@@/u),
  });
  expect(draft).toContain('```diff');
  expect(draft).toContain(String(metadata.hunk));
  expect(draft).not.toContain(workspace.primaryWorkspace);
  expect(provider.requests.length).toBe(providerRequestsBefore);
  await expect(
    page.getByRole('article', { name: '你' }).filter({ hasText: 'review_context' })
  ).toHaveCount(0);
  expect(git(workspace.primaryWorkspace, ['rev-parse', 'HEAD'])).toBe(headBefore);
  expect(readFileSync(workspace.primaryPath('review-target.ts'), 'utf8')).toBe(contentBefore);
  expect(git(workspace.primaryWorkspace, ['status', '--porcelain=v1'])).toContain(
    'review-target.ts'
  );

  const screenshotName = 'web31-p0-07-review-draft.png';
  await page.screenshot({
    path: join(evidence.scenarioDirectory, screenshotName),
    animations: 'disabled',
  });
  evidence.recordFact('screenshot.review', basename(screenshotName));
  evidence.recordFact('web31.review_hunk_to_composer', true);
  evidence.recordFact(
    'web31.review_provider_requests',
    provider.requests.length - providerRequestsBefore
  );
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

function createFileScale(directory: string, count: number): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (let index = 0; index < count; index += 1) {
    writeFileSync(join(directory, `entry-${String(index).padStart(6, '0')}.txt`), '');
  }
}

async function measureFileDirectory(
  page: Page,
  bootstrap: WebBootstrapV1,
  parentId: string
): Promise<{
  readonly coldMs: number;
  readonly warmP95Ms: number;
  readonly items: number;
  readonly responseBytes: number;
}> {
  return page.evaluate(
    async input => {
      const query = new URLSearchParams({
        workspaceId: input.workspaceId,
        expectedContextRevision: input.contextRevision,
        parentId: input.parentId,
        pageSize: '100',
      });
      const request = async () => {
        const startedAt = performance.now();
        const response = await fetch(`/api/v1/files?${query.toString()}`, {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        });
        const text = await response.text();
        if (!response.ok)
          throw new Error(`File performance request failed with ${response.status}.`);
        const body = JSON.parse(text) as { readonly items: readonly unknown[] };
        return {
          durationMs: performance.now() - startedAt,
          items: body.items.length,
          responseBytes: new TextEncoder().encode(text).byteLength,
        };
      };
      const cold = await request();
      const warm: number[] = [];
      for (let sample = 0; sample < 20; sample += 1) {
        warm.push((await request()).durationMs);
      }
      warm.sort((left, right) => left - right);
      return {
        coldMs: cold.durationMs,
        warmP95Ms: warm[Math.max(0, Math.ceil(warm.length * 0.95) - 1)],
        items: cold.items,
        responseBytes: cold.responseBytes,
      };
    },
    {
      workspaceId: bootstrap.workspaceId,
      contextRevision: bootstrap.contextRevision,
      parentId,
    }
  );
}

async function measureGitStatus(
  page: Page,
  bootstrap: WebBootstrapV1
): Promise<{
  readonly coldMs: number;
  readonly warmP95Ms: number;
  readonly items: number;
}> {
  return page.evaluate(async input => {
    const query = new URLSearchParams({
      workspaceId: input.workspaceId,
      expectedContextRevision: input.contextRevision,
      pageSize: '2000',
    });
    const request = async () => {
      const startedAt = performance.now();
      const response = await fetch(`/api/v1/git/status?${query.toString()}`, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      const body = (await response.json()) as {
        readonly totalFiles: number;
      };
      if (!response.ok) throw new Error(`Git status performance failed with ${response.status}.`);
      return { durationMs: performance.now() - startedAt, items: body.totalFiles };
    };
    const cold = await request();
    const warm: number[] = [];
    for (let sample = 0; sample < 20; sample += 1) warm.push((await request()).durationMs);
    warm.sort((left, right) => left - right);
    return {
      coldMs: cold.durationMs,
      warmP95Ms: warm[Math.max(0, Math.ceil(warm.length * 0.95) - 1)],
      items: cold.items,
    };
  }, bootstrap);
}

async function measureGitDiff(
  page: Page,
  bootstrap: WebBootstrapV1,
  fileId: string
): Promise<{
  readonly coldMs: number;
  readonly warmP95Ms: number;
  readonly lines: number;
  readonly responseBytes: number;
}> {
  return page.evaluate(
    async input => {
      const query = new URLSearchParams({
        workspaceId: input.workspaceId,
        expectedContextRevision: input.contextRevision,
        lineLimit: '240',
        byteLimit: String(256 * 1024),
      });
      const path = `/api/v1/git/diff/${encodeURIComponent(input.fileId)}?${query.toString()}`;
      const request = async () => {
        const startedAt = performance.now();
        const response = await fetch(path, {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`Git diff performance failed with ${response.status}.`);
        const body = JSON.parse(text) as { readonly lines: readonly string[] };
        return {
          durationMs: performance.now() - startedAt,
          lines: body.lines.length,
          responseBytes: new TextEncoder().encode(text).byteLength,
        };
      };
      const cold = await request();
      const warm: number[] = [];
      for (let sample = 0; sample < 20; sample += 1) warm.push((await request()).durationMs);
      warm.sort((left, right) => left - right);
      return {
        coldMs: cold.durationMs,
        warmP95Ms: warm[Math.max(0, Math.ceil(warm.length * 0.95) - 1)],
        lines: cold.lines,
        responseBytes: cold.responseBytes,
      };
    },
    { ...bootstrap, fileId }
  );
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

interface FilePerformanceCounters {
  readonly readOperations: number;
  readonly bytesRead: number;
  readonly itemsParsed: number;
}

interface GitPerformanceCounters {
  readonly processCount: number;
  readonly bytesRead: number;
  readonly itemsParsed: number;
}

interface PerformanceCountersSnapshot {
  readonly files: FilePerformanceCounters;
  readonly git: GitPerformanceCounters;
}

async function browserPerformanceCounters(page: Page): Promise<PerformanceCountersSnapshot> {
  const bootstrap = await webBootstrap(page);
  return page.evaluate(async context => {
    const query = new URLSearchParams({
      workspaceId: context.workspaceId,
      expectedContextRevision: context.contextRevision,
    });
    const response = await fetch(`/api/v1/diagnostics?${query.toString()}`, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Diagnostics request failed with ${response.status}.`);
    const value = (await response.json()) as {
      readonly performance?: PerformanceCountersSnapshot;
    };
    if (!value.performance?.files || !value.performance.git) {
      throw new Error('Host diagnostics omitted performance counters.');
    }
    return value.performance;
  }, bootstrap);
}

function subtractCounters<T extends object>(after: T, before: T, label: string): T {
  const result: Record<string, number> = {};
  for (const [key, afterValue] of Object.entries(after)) {
    const beforeValue = (before as Record<string, unknown>)[key];
    if (typeof afterValue !== 'number' || typeof beforeValue !== 'number') {
      throw new Error(`${label} field ${key} is not numeric.`);
    }
    const difference = afterValue - beforeValue;
    if (!Number.isSafeInteger(difference) || difference < 0) {
      throw new Error(`${label} field ${key} did not increase monotonically.`);
    }
    result[key] = difference;
  }
  return result as T;
}

async function switchWorkspaceThroughUi(page: Page, path: string): Promise<void> {
  const ui = workbenchUi(page);
  await ui.workspaceRail.getByRole('button', { name: '选择其他工作区' }).click();
  await expect(ui.workspaceDialog).toBeVisible();
  await ui.workspaceDialog.getByRole('textbox', { name: '打开其他本地目录' }).fill(path);
  await ui.workspaceDialog.getByRole('button', { name: '打开', exact: true }).click();
  await expect(ui.workspaceDialog).toBeHidden({ timeout: 30_000 });
  await expect
    .poll(async () => (await webBootstrap(page)).workspace, { timeout: 30_000 })
    .toBe(realpathSync(path));
}

async function workspaceSessions(
  page: Page,
  workspaceId: string
): Promise<WebPageV1<WebSessionSummaryV1>> {
  const bootstrap = await webBootstrap(page);
  const result = await browserGet<WebPageV1<WebSessionSummaryV1>>(
    page,
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/sessions?${new URLSearchParams({
      workspaceId: bootstrap.workspaceId,
      expectedContextRevision: bootstrap.contextRevision,
      pageSize: '100',
    }).toString()}`
  );
  expect(result.status).toBe(200);
  return result.body;
}

async function guardedGet<T = unknown>(
  page: Page,
  path: string,
  bootstrap: Pick<WebBootstrapV1, 'workspaceId' | 'contextRevision'>,
  extra: Readonly<Record<string, string>> = {}
) {
  const url = new URL(path, 'http://orion.invalid');
  url.searchParams.set('workspaceId', bootstrap.workspaceId);
  url.searchParams.set('expectedContextRevision', bootstrap.contextRevision);
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  return browserGet<T>(page, `${url.pathname}?${url.searchParams.toString()}`);
}

async function guardedHostGet<T = unknown>(
  baseUrl: string,
  path: string,
  bootstrap: Pick<WebBootstrapV1, 'workspaceId' | 'contextRevision'>,
  extra: Readonly<Record<string, string>> = {}
): Promise<{ readonly status: number; readonly body: T }> {
  const url = new URL(path, baseUrl);
  url.searchParams.set('workspaceId', bootstrap.workspaceId);
  url.searchParams.set('expectedContextRevision', bootstrap.contextRevision);
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  return {
    status: response.status,
    body: (await response.json()) as T,
  };
}

async function hostMutation<T = unknown>(
  baseUrl: string,
  path: string,
  options: {
    readonly body: unknown;
    readonly nonce: string;
    readonly method?: 'POST' | 'PATCH';
  }
): Promise<{ readonly status: number; readonly body: T }> {
  const response = await fetch(new URL(path, baseUrl), {
    method: options.method ?? 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: baseUrl,
      'x-orion-web-nonce': options.nonce,
    },
    body: JSON.stringify(options.body),
  });
  return {
    status: response.status,
    body: (await response.json()) as T,
  };
}

async function openWorkPanel(page: Page, name: '文件' | 'Git' | '审阅') {
  await page.setViewportSize({ width: 1_600, height: 900 });
  const panel = await openInspector(page, { timeout: 30_000 });
  const tab = panel.getByRole('tab', { name: new RegExp(`^${name}，`, 'u') });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  const visiblePanel = panel.getByRole('tabpanel').filter({ visible: true });
  await expect(visiblePanel).toBeVisible({ timeout: 30_000 });
  return visiblePanel;
}

function fileNode(page: WebFileTreePageV1, name: string) {
  const node = page.items.find(item => item.name === name);
  if (!node) throw new Error(`File fixture ${name} was not projected.`);
  return node;
}

function gitFile(status: WebGitStatusV1, path: string) {
  const file = [
    ...status.conflicted,
    ...status.staged,
    ...status.unstaged,
    ...status.untracked,
  ].find(item => item.path === path);
  if (!file) throw new Error(`Git fixture ${path} was not projected.`);
  return file;
}

function problemCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  return typeof (body as Record<string, unknown>).code === 'string'
    ? ((body as Record<string, unknown>).code as string)
    : undefined;
}

function seedGitStateMatrix(workspace: string): void {
  git(workspace, ['init', '-b', 'main']);
  git(workspace, ['config', 'user.name', 'Orion Web E2E']);
  git(workspace, ['config', 'user.email', 'web-e2e@example.invalid']);
  writeFileSync(join(workspace, 'tracked.txt'), 'base\n', 'utf8');
  writeFileSync(join(workspace, 'conflict.txt'), 'base\n', 'utf8');
  writeFileSync(join(workspace, 'long-line.txt'), 'short\n', 'utf8');
  writeFileSync(join(workspace, 'large-diff.txt'), largeDiffText('BASE', 26 * 1024 * 1024), 'utf8');
  git(workspace, ['add', '--all']);
  git(workspace, ['commit', '-m', 'base fixture']);
  appendFileSync(join(workspace, 'tracked.txt'), 'history\n', 'utf8');
  git(workspace, ['add', 'tracked.txt']);
  git(workspace, ['commit', '-m', 'history fixture']);
}

function createDirtyGitMatrix(workspace: string): void {
  git(workspace, ['switch', '-c', 'conflict-side']);
  writeFileSync(join(workspace, 'conflict.txt'), 'side branch\n', 'utf8');
  git(workspace, ['add', 'conflict.txt']);
  git(workspace, ['commit', '-m', 'side conflict']);
  git(workspace, ['switch', 'main']);
  writeFileSync(join(workspace, 'conflict.txt'), 'main branch\n', 'utf8');
  git(workspace, ['add', 'conflict.txt']);
  git(workspace, ['commit', '-m', 'main conflict']);
  git(workspace, ['merge', '--no-edit', 'conflict-side'], [1]);
  writeFileSync(join(workspace, 'staged.txt'), 'staged\n', 'utf8');
  git(workspace, ['add', 'staged.txt']);
  appendFileSync(join(workspace, 'tracked.txt'), 'unstaged\n', 'utf8');
  writeFileSync(join(workspace, 'untracked.txt'), 'untracked\n', 'utf8');
  writeFileSync(join(workspace, 'long-line.txt'), `${'L'.repeat(2_048)}\n`, 'utf8');
  writeFileSync(
    join(workspace, 'large-diff.txt'),
    largeDiffText('CHANGED', 26 * 1024 * 1024),
    'utf8'
  );
}

function createGitStatusScale(workspace: string, targetFiles: number): void {
  const current = git(workspace, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    .split('\0')
    .filter(Boolean).length;
  if (current > targetFiles) {
    throw new Error(`Git scale already has ${current} changed files; target is ${targetFiles}.`);
  }
  for (let index = current; index < targetFiles; index += 1) {
    writeFileSync(join(workspace, `scale-change-${String(index).padStart(4, '0')}.txt`), 'x\n');
  }
}

function largeDiffText(marker: string, targetBytes: number): string {
  const line = `${marker}:${'x'.repeat(104)}\n`;
  const repeat = Math.ceil(targetBytes / Buffer.byteLength(line));
  const value = line.repeat(repeat);
  return value.slice(0, targetBytes - 1) + '\n';
}

function measureRawGitDiffBytes(workspace: string, path: string): number {
  const outputPath = join(workspace, '.git', 'orion-web-e2e-raw-diff.tmp');
  const descriptor = openSync(outputPath, 'w', 0o600);
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync('git', ['diff', '--no-ext-diff', '--no-textconv', '--', path], {
      cwd: workspace,
      stdio: ['ignore', descriptor, 'pipe'],
      env: gitEnvironment(),
    });
  } finally {
    closeSync(descriptor);
  }
  if (result!.status !== 0) {
    throw new Error(`git raw diff failed: ${String(result!.stderr ?? '')}`);
  }
  const bytes = statSync(outputPath).size;
  unlinkSync(outputPath);
  return bytes;
}

function seedReviewFixture(workspace: string): void {
  git(workspace, ['init', '-b', 'main']);
  git(workspace, ['config', 'user.name', 'Orion Web E2E']);
  git(workspace, ['config', 'user.email', 'web-e2e@example.invalid']);
  const original = Array.from(
    { length: 24 },
    (_, index) => `export const value${index} = ${index};`
  );
  writeFileSync(join(workspace, 'review-target.ts'), `${original.join('\n')}\n`, 'utf8');
  git(workspace, ['add', '--all']);
  git(workspace, ['commit', '-m', 'review base']);
  const changed = [...original];
  changed[2] = 'export const value2 = 200;';
  changed[20] = 'export const value20 = 2000;';
  writeFileSync(join(workspace, 'review-target.ts'), `${changed.join('\n')}\n`, 'utf8');
}

function git(workspace: string, args: readonly string[], acceptedExitCodes = [0]): string {
  const result = spawnSync('git', args, {
    cwd: workspace,
    encoding: 'utf8',
    env: gitEnvironment(),
  });
  if (!acceptedExitCodes.includes(result.status ?? -1)) {
    throw new Error(
      `git ${args.join(' ')} failed (${result.status ?? 'signal'}): ${result.stderr || result.stdout}`
    );
  }
  return result.stdout.trim();
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
}
