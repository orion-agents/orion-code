/**
 * v0.3.22 T22-04 — real coding-task evaluation harness.
 *
 * Unlike `harness-eval.ts` (which validates deterministic tool-selection
 * contracts against a fixed corpus), this module executes actual coding tasks
 * against a real workspace directory and decides success through
 * machine-verifiable checks on the resulting file tree.
 *
 * Two modes:
 *  - `fake`  — a deterministic scripted provider performs each task's ops in a
 *              scratch workspace. Repeatable, no model access required; this is
 *              the harness/logic regression surface.
 *  - `live`  — the same fixtures and success checks, with the task executed by
 *              a pluggable live executor (the real model runtime). The executor
 *              interface is the extension point; its wiring ships with the live
 *              A/B workflow and requires explicit model credentials.
 *
 * Every sample records: solved, falseComplete, modelRequests, totalTokens,
 * toolCalls, latencyMs, retries, costEstimate and failureReason, plus the
 * source metadata (git SHA, fixture version, mode) required by the plan's A/B
 * comparison rules.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { tmpdir } from 'os';

import { sourceMetadata } from './harness-eval';

export interface CodingTaskCheckV1 {
  readonly kind:
    | 'file_equals'
    | 'file_contains'
    | 'file_matches'
    | 'file_exists'
    | 'file_absent'
    | 'file_absent_value';
  readonly path: string;
  readonly value?: string;
  readonly content?: string;
}

export interface CodingTaskScriptOpV1 {
  readonly op:
    | 'read'
    | 'write'
    | 'append'
    | 'delete'
    | 'command'
    | 'compact'
    | 'session'
    | 'fail'
    | 'deny'
    | 'cancel';
  readonly path?: string;
  readonly content?: string;
  readonly command?: string;
  readonly reason?: string;
  readonly recover?: boolean;
  readonly session?: string;
}

export interface CodingTaskFixtureV1 {
  readonly id: string;
  readonly category: string;
  readonly title: string;
  readonly instruction: string;
  readonly repo: { readonly files: Readonly<Record<string, string>> };
  readonly script: readonly CodingTaskScriptOpV1[];
  readonly checks: readonly CodingTaskCheckV1[];
  readonly expectedModelRequests: number;
  readonly estimatedTokensPerRequest: number;
}

export interface CodingTaskCorpusV1 {
  readonly version: number;
  readonly tasks: readonly CodingTaskFixtureV1[];
}

export interface CodingTaskSampleV1 {
  readonly sampleId: string;
  readonly taskId: string;
  readonly category: string;
  readonly mode: 'fake' | 'live';
  readonly solved: boolean;
  readonly falseComplete: boolean;
  readonly regression: boolean;
  readonly modelRequests: number;
  readonly totalTokens: number;
  readonly toolCalls: number;
  readonly latencyMs: number;
  readonly retries: number;
  readonly costEstimate: number;
  readonly failureReason?: string;
  readonly passedChecks: number;
  readonly totalChecks: number;
}

export interface CodingTaskEvalReceiptV1 {
  readonly version: 1;
  readonly kind: 'orion.coding-task-eval';
  readonly mode: 'fake' | 'live';
  readonly createdAt: string;
  readonly source: ReturnType<typeof sourceMetadata>;
  readonly fixtureVersion: number;
  readonly taskCount: number;
  readonly samples: readonly CodingTaskSampleV1[];
  readonly summary: {
    readonly solved: number;
    readonly attempted: number;
    readonly solvedRate: number;
    readonly falseComplete: number;
    readonly totalModelRequests: number;
    readonly totalTokens: number;
    readonly p50LatencyMs: number;
    readonly p95LatencyMs: number;
    readonly totalRetries: number;
  };
}

export interface CodingTaskEvalOptionsV1 {
  readonly mode?: 'fake' | 'live';
  readonly fixturesPath?: string;
  readonly workspaceRoot?: string;
  readonly costPerThousandTokens?: number;
  readonly keepWorkspaces?: boolean;
}

const DEFAULT_FIXTURES_PATH = join(__dirname, 'fixtures', 'coding-tasks', 'coding-tasks-v1.json');

export function loadCodingTaskCorpus(fixturesPath = DEFAULT_FIXTURES_PATH): CodingTaskCorpusV1 {
  const parsed = JSON.parse(readFileSync(fixturesPath, 'utf8')) as CodingTaskCorpusV1;
  if (parsed.version !== 1 || !Array.isArray(parsed.tasks)) {
    throw new Error('coding-tasks fixture is invalid');
  }
  return parsed;
}

/** Materialize the task's repo files into a fresh scratch workspace. */
function createWorkspace(corpusRoot: string, task: CodingTaskFixtureV1, runId: string): string {
  const workspace = resolve(corpusRoot, `ws-${task.id}-${runId}`);
  mkdirSync(workspace, { recursive: true });
  for (const [relative, content] of Object.entries(task.repo.files)) {
    const target = join(workspace, relative);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  return workspace;
}

function checkOne(check: CodingTaskCheckV1, workspace: string): boolean {
  const target = join(workspace, check.path);
  switch (check.kind) {
    case 'file_exists':
      return existsSync(target);
    case 'file_absent':
      return !existsSync(target);
    case 'file_absent_value':
      return existsSync(target) ? !readFileSync(target, 'utf8').includes(check.value ?? '') : true;
    case 'file_contains':
      return existsSync(target) && readFileSync(target, 'utf8').includes(check.value ?? '');
    case 'file_matches':
      return (
        existsSync(target) && new RegExp(check.value ?? '', 'u').test(readFileSync(target, 'utf8'))
      );
    case 'file_equals':
      return (
        existsSync(target) && readFileSync(target, 'utf8') === (check.value ?? check.content ?? '')
      );
    default:
      return false;
  }
}

function verifyChecks(
  task: CodingTaskFixtureV1,
  workspace: string
): {
  solved: boolean;
  passed: number;
} {
  let passed = 0;
  for (const check of task.checks) {
    if (checkOne(check, workspace)) passed += 1;
  }
  return { solved: passed === task.checks.length, passed };
}

/**
 * Execute one task in `fake` mode: interpret the scripted provider ops against
 * the scratch workspace, count model requests / tool calls / retries, and
 * verify the machine-checkable success conditions.
 */
function runFakeSample(
  task: CodingTaskFixtureV1,
  workspace: string,
  runId: string,
  costPerThousandTokens: number
): CodingTaskSampleV1 {
  const startedAt = Date.now();
  let modelRequests = 0;
  let toolCalls = 0;
  let totalTokens = 0;
  let retries = 0;
  let cancelled = false;
  let denied = false;
  let failureReason: string | undefined;
  let activeSession = 'a';

  const applyOp = (op: CodingTaskScriptOpV1): void => {
    switch (op.op) {
      case 'read':
      case 'command':
      case 'compact':
        modelRequests += 1;
        totalTokens += task.estimatedTokensPerRequest;
        return;
      case 'session':
        modelRequests += 1;
        totalTokens += task.estimatedTokensPerRequest;
        activeSession = op.session ?? 'a';
        return;
      case 'fail':
        modelRequests += 1;
        totalTokens += task.estimatedTokensPerRequest;
        retries += 1;
        if (!op.recover) throw new Error(op.reason ?? 'scripted failure');
        return;
      case 'deny':
        modelRequests += 1;
        totalTokens += task.estimatedTokensPerRequest;
        denied = true;
        return;
      case 'cancel':
        cancelled = true;
        return;
      case 'write':
      case 'append':
      case 'delete': {
        toolCalls += 1;
        modelRequests += 1;
        totalTokens += task.estimatedTokensPerRequest;
        if (cancelled) return; // after a cancel, scripted writes are not performed
        if (denied && op.path && op.path.startsWith('outside/')) return; // denied ops never land
        const target = join(workspace, op.path ?? '');
        if (op.op === 'delete') {
          rmSync(target, { force: true });
          return;
        }
        mkdirSync(dirname(target), { recursive: true });
        if (op.op === 'append') {
          if (existsSync(target))
            writeFileSync(target, `${readFileSync(target, 'utf8')}${op.content ?? ''}`);
          else writeFileSync(target, op.content ?? '');
          return;
        }
        writeFileSync(target, op.content ?? '');
        return;
      }
      default:
        return;
    }
  };

  for (const op of task.script) {
    applyOp(op);
  }

  const { solved, passed } = verifyChecks(task, workspace);
  const latencyMs = Math.max(0, Date.now() - startedAt);
  // A denial or cancellation that the checks bless is an expected outcome, not
  // a failure: the failure reason exists only when the task did not solve.
  if (!solved) {
    failureReason = cancelled ? 'user_cancelled' : denied ? 'permission_denied' : 'checks_failed';
  }
  const falseComplete = !solved && !cancelled && !denied; // declared done without the checks passing
  return {
    sampleId: `coding-fake-${task.id}-${runId}`,
    taskId: task.id,
    category: task.category,
    mode: 'fake',
    solved,
    falseComplete,
    regression: false,
    modelRequests,
    totalTokens,
    toolCalls,
    latencyMs,
    retries,
    costEstimate:
      Math.round(((totalTokens / 1000) * costPerThousandTokens + Number.EPSILON) * 100) / 100,
    ...(failureReason ? { failureReason } : {}),
    passedChecks: passed,
    totalChecks: task.checks.length,
  };
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

/**
 * Run the evaluation. `fake` mode executes every task's scripted provider ops
 * in scratch workspaces and verifies the checks; `live` mode requires a live
 * executor and is wired by the A/B workflow.
 */
export function runCodingTaskEvalV1(
  options: CodingTaskEvalOptionsV1 = {}
): CodingTaskEvalReceiptV1 {
  const mode = options.mode ?? 'fake';
  if (mode !== 'fake') {
    throw new Error(
      'live mode requires a live executor wired to the model runtime; wire it through the A/B workflow before use'
    );
  }
  const corpus = loadCodingTaskCorpus(options.fixturesPath);
  const corpusRoot = options.workspaceRoot ?? mkdtempSync(join(tmpdir(), 'orion-coding-eval-'));
  mkdirSync(corpusRoot, { recursive: true });
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const costPerThousandTokens = options.costPerThousandTokens ?? 0.5;

  const samples: CodingTaskSampleV1[] = [];
  for (const task of corpus.tasks) {
    const workspace = createWorkspace(corpusRoot, task, runId);
    try {
      samples.push(runFakeSample(task, workspace, runId, costPerThousandTokens));
    } finally {
      if (!options.keepWorkspaces) rmSync(workspace, { recursive: true, force: true });
    }
  }

  const latencies = samples.map(sample => sample.latencyMs);
  const solved = samples.filter(sample => sample.solved).length;
  const summary = {
    solved,
    attempted: samples.length,
    solvedRate: samples.length === 0 ? 0 : Math.round((solved / samples.length) * 100) / 100,
    falseComplete: samples.filter(sample => sample.falseComplete).length,
    totalModelRequests: samples.reduce((sum, sample) => sum + sample.modelRequests, 0),
    totalTokens: samples.reduce((sum, sample) => sum + sample.totalTokens, 0),
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    totalRetries: samples.reduce((sum, sample) => sum + sample.retries, 0),
  };
  return Object.freeze({
    version: 1 as const,
    kind: 'orion.coding-task-eval' as const,
    mode,
    createdAt: new Date().toISOString(),
    source: sourceMetadata(),
    fixtureVersion: corpus.version,
    taskCount: corpus.tasks.length,
    samples: Object.freeze(samples),
    summary: Object.freeze(summary),
  });
}

/** CLI entry: `node scripts/bench/coding-task-eval.js --out <path>` (fake mode). */
export function main(argv: readonly string[] = process.argv.slice(2)): void {
  const optionValue = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const receipt = runCodingTaskEvalV1({ mode: 'fake' });
  const out = optionValue('--out');
  const rendered = `${JSON.stringify(receipt, null, 2)}\n`;
  if (out) {
    writeFileSync(out, rendered);
  } else {
    process.stdout.write(rendered);
  }
}

if (require.main === module) {
  main();
}
