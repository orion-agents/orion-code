import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

import { startOrionWebServer, type OrionWebServerHandle } from '../src/web/server';
import { WebWorkbenchController } from '../src/web/workbench-controller';
import { createFakeWebRuntime } from './support/web-runtime';

/** Same derivation as the snapshot reader: sha256(`<name-status>::<path>`). */
function fileKeyFor(status: string, path: string): string {
  return createHash('sha256').update(`${status}::${path}`, 'utf8').digest('hex').slice(0, 16);
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'orion-review-run-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  git(workspace, ['init']);
  git(workspace, ['config', 'user.email', 'test@example.com']);
  git(workspace, ['config', 'user.name', 'Test']);
  writeFileSync(join(workspace, 'a.txt'), 'line1\nline2\nline3\n');
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-m', 'init']);
  writeFileSync(join(workspace, 'a.txt'), 'line1\nline2-changed\nline3\n');
  return workspace;
}

const FINDING_PAYLOAD = (fileKey: string) =>
  JSON.stringify({
    findings: [
      {
        findingId: 'abcd1234abcd1234abcd1234abcd1234',
        priority: 'P1',
        title: 'Changed line breaks consumers',
        trigger: 'When a consumer matches on the literal line2',
        impact: 'Downstream parsers fail on the renamed marker.',
        fileKey,
        side: 'new',
        startLine: 2,
        endLine: 2,
        evidence: 'The marker string line2 changed without a migration note.',
      },
    ],
  });

interface Harness {
  readonly handle: OrionWebServerHandle;
  readonly root: string;
  readonly workspace: string;
}

async function startHarness(withModel: boolean): Promise<Harness> {
  const workspace = makeWorkspace();
  const workbench = await WebWorkbenchController.create({
    cwd: workspace,
    createRuntime: cwd => {
      const runtime = createFakeWebRuntime(cwd);
      if (!withModel) return Promise.resolve(runtime);
      return Promise.resolve({
        ...runtime,
        llm: {
          chat: async () => ({
            content: `\`\`\`json\n${FINDING_PAYLOAD(fileKeyFor('M', 'a.txt'))}\n\`\`\``,
            model: 'fake-model',
            usage: { promptTokens: 12, completionTokens: 34 },
          }),
        },
      }) as never;
    },
  });
  const handle = await startOrionWebServer({
    cwd: workspace,
    port: 0,
    staticRoot: workspace,
    workbench,
  });
  return { handle, root: workspace, workspace };
}

function mutationHeaders(handle: OrionWebServerHandle): Record<string, string> {
  return {
    Origin: handle.url,
    'Content-Type': 'application/json',
    'X-Orion-Web-Nonce': handle.nonce,
  };
}

async function activeContext(handle: OrionWebServerHandle): Promise<{
  expectedContextRevision: string;
  workspaceId: string;
}> {
  const bootstrap = (await fetch(`${handle.url}/api/v1/bootstrap`).then(response =>
    response.json()
  )) as { contextRevision: string; workspaceId: string };
  return {
    expectedContextRevision: bootstrap.contextRevision,
    workspaceId: bootstrap.workspaceId,
  };
}

function guardedUrl(
  handle: OrionWebServerHandle,
  path: string,
  context: { expectedContextRevision: string; workspaceId: string }
): string {
  const url = new URL(path, handle.url);
  url.searchParams.set('expectedContextRevision', context.expectedContextRevision);
  url.searchParams.set('workspaceId', context.workspaceId);
  return url.toString();
}

interface RunRecord {
  readonly runId: string;
  readonly status: string;
  readonly stale: boolean;
  readonly result: {
    readonly conclusion: string;
    readonly findings: ReadonlyArray<{ readonly title: string; readonly fileKey: string }>;
  } | null;
  readonly failure: { readonly kind: string; readonly message: string } | null;
}

async function waitForFinished(
  handle: OrionWebServerHandle,
  runId: string,
  context: { expectedContextRevision: string; workspaceId: string }
): Promise<RunRecord> {
  for (let i = 0; i < 200; i += 1) {
    const response = await fetch(guardedUrl(handle, `/api/v1/review/runs/${runId}`, context));
    const record = (await response.json()) as RunRecord;
    if (record.status !== 'running' && record.status !== 'queued') return record;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('review run did not finish in time');
}

describe('Web shared code-review runs (v0.3.29)', () => {
  let harness: Harness;
  let context: { expectedContextRevision: string; workspaceId: string };

  beforeEach(async () => {
    harness = await startHarness(true);
    context = await activeContext(harness.handle);
  });

  afterEach(async () => {
    await harness.handle.close();
    rmSync(harness.root, { recursive: true, force: true });
  });

  test('start, poll and read a completed review run with an anchored finding', async () => {
    const started = await fetch(`${harness.handle.url}/api/v1/review/run`, {
      method: 'POST',
      headers: mutationHeaders(harness.handle),
      body: JSON.stringify({
        requestId: randomUUID(),
        selector: { kind: 'worktree' },
        ...context,
      }),
    });
    expect(started.status).toBe(200);
    const { runId, status } = (await started.json()) as { runId: string; status: string };
    expect(status).toBe('running');

    const record = await waitForFinished(harness.handle, runId, context);
    expect(record.status).toBe('completed');
    expect(record.failure).toBeNull();
    expect(record.result?.conclusion).toBe('findings');
    expect(record.result?.findings).toHaveLength(1);
    expect(record.result?.findings[0]?.fileKey).toBe(fileKeyFor('M', 'a.txt'));
    expect(record.stale).toBe(false);

    const list = await fetch(guardedUrl(harness.handle, '/api/v1/review/runs', context));
    const items = (await list.json()) as RunRecord[];
    expect(items.map(item => item.runId)).toContain(runId);
  });

  test('rejects unknown run ids with 404 and invalid selectors with 400', async () => {
    const missing = await fetch(
      guardedUrl(harness.handle, `/api/v1/review/runs/${randomUUID()}`, context)
    );
    expect(missing.status).toBe(404);

    const invalid = await fetch(`${harness.handle.url}/api/v1/review/run`, {
      method: 'POST',
      headers: mutationHeaders(harness.handle),
      body: JSON.stringify({
        requestId: randomUUID(),
        selector: { kind: 'everywhere' },
        ...context,
      }),
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ code: 'review_selector_invalid' });
  });

  test('mutations without the web nonce are rejected with 403', async () => {
    const response = await fetch(`${harness.handle.url}/api/v1/review/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: harness.handle.url },
      body: JSON.stringify({
        requestId: randomUUID(),
        selector: { kind: 'worktree' },
        ...context,
      }),
    });
    expect(response.status).toBe(403);
  });

  test('a Host without a configured model answers review.run with the typed 422', async () => {
    await harness.handle.close();
    rmSync(harness.root, { recursive: true, force: true });
    harness = await startHarness(false);
    context = await activeContext(harness.handle);
    const response = await fetch(`${harness.handle.url}/api/v1/review/run`, {
      method: 'POST',
      headers: mutationHeaders(harness.handle),
      body: JSON.stringify({
        requestId: randomUUID(),
        selector: { kind: 'worktree' },
        ...context,
      }),
    });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: 'review_no_model' });
  });
});
