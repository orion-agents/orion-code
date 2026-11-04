#!/usr/bin/env node
/**
 * orion-self-eval driver: runs real Orion Code conversations end-to-end through
 * the production print pipeline (`src/cli.ts -p --output-format json`) against
 * the deterministic mock provider, then scores each turn with machine checks.
 *
 * This measures the conversation *loop* — real runtime, real tools, real session
 * persistence, scripted model — so it is honest without a paid API key. It does
 * NOT measure model judgment quality; that tier must be recorded `not_run`
 * unless a real key and budget are supplied.
 *
 * Usage:
 *   node conversation-eval.mjs [--tasks <file>] [--out <file>] [--keep-work]
 * Env:
 *   ORION_EVAL_REPO      repo root (default: resolved from this file's location)
 *   ORION_EVAL_TASKS      task corpus (default: eval-tasks.json next to this file)
 *   ORION_EVAL_OUT        receipt path (default: <repo>/.agents/skills/orion-self-eval/last-receipt.json)
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = name => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const repoRoot = resolve(arg('repo') || process.env.ORION_EVAL_REPO || resolve(HERE, '../../..'));
const tasksPath = arg('tasks') || process.env.ORION_EVAL_TASKS || join(HERE, 'eval-tasks.json');
const outPath = arg('out') || process.env.ORION_EVAL_OUT || join(HERE, 'last-receipt.json');
const keepWork = process.argv.includes('--keep-work');

const corpus = JSON.parse(readFileSync(tasksPath, 'utf-8'));
const startedAt = new Date();

function wait(mockProc) {
  return new Promise((resolveReady, rejectReady) => {
    let buf = '';
    mockProc.stdout.on('data', chunk => {
      buf += chunk.toString();
      const line = buf.split('\n').find(l => l.trim().startsWith('{'));
      if (line) {
        try {
          resolveReady(JSON.parse(line));
        } catch (error) {
          rejectReady(error);
        }
      }
    });
    mockProc.on('error', rejectReady);
    setTimeout(() => rejectReady(new Error('mock provider did not become ready in 10s')), 10_000).unref?.();
  });
}

function extractJson(text) {
  const first = text.indexOf('{');
  if (first < 0) return null;
  for (let end = text.length; end > first; end -= 1) {
    const slice = text.slice(first, end);
    if (!slice.trimEnd().endsWith('}')) continue;
    try {
      return JSON.parse(slice);
    } catch {
      /* keep shrinking */
    }
  }
  return null;
}

function listFiles(root) {
  const out = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full.replace(`${root}/`, ''));
    }
  };
  try {
    walk(root);
  } catch {
    /* unreadable */
  }
  return out.sort();
}

async function runTask(task) {
  const work = mkdtempSync(join(tmpdir(), 'orion-eval-ws-'));
  const configHome = mkdtempSync(join(tmpdir(), 'orion-eval-cfg-'));
  const mock = spawn(process.execPath, [join(HERE, 'mock-openai-server.mjs')], {
    env: { ...process.env, ORION_EVAL_SCRIPT: writeScript(task) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const record = { id: task.id, title: task.title, checks: [] };
  try {
    const ready = await wait(mock);
    writeFileSync(
      join(configHome, 'orion.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          defaultModel: 'orion-eval-model',
          fallbackModel: 'orion-eval-model',
          toolConfirmation: 'allow',
          providers: [
            {
              id: 'orion-eval',
              displayName: 'Eval Mock Provider',
              baseUrl: `http://127.0.0.1:${ready.port}/v1`,
              apiKey: 'mock-key',
              protocol: 'openai-completions',
            },
          ],
          models: [
            {
              id: 'orion-eval-model',
              displayName: 'Eval Mock Model',
              provider: 'orion-eval',
              model: 'mock-model',
              contextWindow: 200_000,
              maxOutputTokens: 4096,
            },
          ],
        },
        null,
        2
      )
    );

    for (const [rel, contents] of Object.entries(task.fixtures || {})) {
      const target = join(work, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents, 'utf-8');
    }
    const before = listFiles(work);

    const cli = await new Promise(done => {
      const child = spawn(
        process.execPath,
        [
          '--no-warnings',
          join(repoRoot, 'node_modules/ts-node/dist/bin.js'),
          '--transpile-only',
          join(repoRoot, 'src/cli.ts'),
          '-p',
          '--output-format',
          'json',
          '--',
          task.prompt,
        ],
        {
          cwd: work,
          env: {
            ...process.env,
            ORION_CODE_CONFIG_DIR: configHome,
            ORION_CODE_API_KEY: 'mock-key',
            NO_COLOR: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), task.timeoutMs || 120_000);
      child.stdout.on('data', c => (stdout += c));
      child.stderr.on('data', c => (stderr += c));
      child.on('close', code => {
        clearTimeout(timer);
        done({ code, stdout, stderr });
      });
    });

    const result = extractJson(cli.stdout);
    const toolEvents = Array.isArray(result?.toolEvents) ? result.toolEvents : [];
    const errors = Array.isArray(result?.errors) ? result.errors : [];
    const content = typeof result?.content === 'string' ? result.content : '';
    const mockState = await fetchMockState(ready.port);

    record.observed = {
      exitCode: cli.code,
      parsedResult: Boolean(result),
      contentLength: content.length,
      toolEventCount: toolEvents.length,
      toolNames: [...new Set(toolEvents.map(event => event?.name || event?.tool || 'unknown'))].sort(),
      toolFailures: toolEvents.filter(event => event?.success === false).length,
      errorCount: errors.length,
      budgetStops: Array.isArray(result?.budgetStops) ? result.budgetStops.length : 0,
      sessionId: result?.sessionId ? 'present' : 'absent',
      model: result?.model ?? null,
      modelRequests: mockState.calls?.length ?? 0,
      durationMs: mockState.stepIndex !== undefined ? undefined : undefined,
      filesAdded: listFiles(work).filter(f => !before.includes(f)),
    };

    for (const check of task.checks || []) record.checks.push(evaluate(check, record.observed, content));
    record.pass = record.checks.every(check => check.status === 'pass');
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    record.pass = false;
    record.checks.push({ id: 'task-ran', status: 'fail', detail: record.error });
  } finally {
    mock.kill('SIGKILL');
    if (!keepWork) {
      rmSync(work, { recursive: true, force: true });
      rmSync(configHome, { recursive: true, force: true });
    } else {
      record.workspace = work;
      record.configHome = configHome;
    }
  }
  return record;
}

function writeScript(task) {
  const path = join(tmpdir(), `orion-eval-script-${task.id}.json`);
  writeFileSync(path, JSON.stringify(task.script || [{ content: 'ok' }]), 'utf-8');
  return path;
}

async function fetchMockState(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/__mock_state`);
    return await res.json();
  } catch {
    return {};
  }
}

function evaluate(check, observed, content) {
  const id = check.check;
  let ok = false;
  let detail = '';
  switch (id) {
    case 'content_nonempty':
      ok = content.trim().length > 0;
      detail = `contentLength=${observed.contentLength}`;
      break;
    case 'content_matches':
      ok = new RegExp(check.value, 'm').test(content);
      detail = `pattern=${check.value}`;
      break;
    case 'tool_called':
      ok = observed.toolNames.includes(check.value);
      detail = `tools=${observed.toolNames.join(',')}`;
      break;
    case 'tool_not_called':
      ok = !observed.toolNames.includes(check.value);
      detail = `tools=${observed.toolNames.join(',')}`;
      break;
    case 'no_tool_failures':
      ok = observed.toolFailures === 0;
      detail = `toolFailures=${observed.toolFailures}`;
      break;
    case 'no_errors':
      ok = observed.errorCount === 0;
      detail = `errors=${observed.errorCount}`;
      break;
    case 'no_budget_stops':
      ok = observed.budgetStops === 0;
      detail = `budgetStops=${observed.budgetStops}`;
      break;
    case 'session_persisted':
      ok = observed.sessionId === 'present';
      detail = `sessionId=${observed.sessionId}`;
      break;
    case 'max_model_requests':
      ok = observed.modelRequests <= Number(check.value);
      detail = `modelRequests=${observed.modelRequests} limit=${check.value}`;
      break;
    case 'exit_zero':
      ok = observed.exitCode === 0;
      detail = `exitCode=${observed.exitCode}`;
      break;
    case 'no_writes':
      ok = observed.filesAdded.length === 0;
      detail = `filesAdded=${observed.filesAdded.join(',')}`;
      break;
    default:
      detail = `unknown check id: ${id}`;
  }
  return { id: `${id}:${check.value ?? ''}`, status: ok ? 'pass' : 'fail', detail };
}

const tasks = [];
for (const task of corpus.tasks) tasks.push(await runTask(task));

const passed = tasks.filter(task => task.pass).length;
const rubric = corpus.rubric || {};
const minValidTurns = Number(rubric.min_valid_turns ?? corpus.tasks.length);
const maxFalseCompletes = Number(rubric.max_false_completes ?? 0);
const falseCompletes = tasks.filter(
  task => task.observed?.contentLength > 0 && task.observed?.toolEventCount === 0 && task.pass
).length;

const tierVerdict =
  tasks.length >= minValidTurns && passed === tasks.length && falseCompletes <= maxFalseCompletes
    ? 'GO'
    : 'NO-GO';

const receipt = {
  schemaVersion: 1,
  track: 'orion-self-eval/tier2-conversation-loop',
  provider: 'deterministic-mock (no paid model calls)',
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  repoRoot,
  cliVersion: (() => {
    try {
      return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')).version;
    } catch {
      return 'unknown';
    }
  })(),
  tasks,
  summary: {
    total: tasks.length,
    passed,
    falseCompletes,
    tierVerdict,
    notRunTiers: [
      'tier3-live-model-quality (needs ORION_CODE_API_KEY + budget; annotation manifest HumanReview=PENDING)',
    ],
  },
};
receipt.digest = createHash('sha256').update(JSON.stringify({ ...receipt, digest: undefined })).digest('hex');

writeFileSync(outPath, JSON.stringify(receipt, null, 2), 'utf-8');
process.stdout.write(
  `${JSON.stringify(
    {
      tierVerdict,
      passed: `${passed}/${tasks.length}`,
      falseCompletes,
      digest: receipt.digest.slice(0, 16),
      receipt: outPath,
      tasks: tasks.map(task => ({ id: task.id, pass: task.pass, observed: task.observed })),
    },
    null,
    2
  )}\n`
);
if (tierVerdict !== 'GO') process.exitCode = 1;
