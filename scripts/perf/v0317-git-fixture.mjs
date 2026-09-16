#!/usr/bin/env node
/**
 * v0.3.17 §9 — deterministic Git performance fixture.
 *
 * Everything is seeded, so two runs produce the same repository shape and the numbers are
 * comparable. Nothing here touches a user project: the fixture lives under /tmp.
 *
 * Usage:
 *   node scripts/perf/v0317-git-fixture.mjs [--dir <path>] [--commits <n>]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULTS = {
  dir: '/tmp/oc317-perf/fixture',
  /** Commits created through fast-import so history paging has something to chew on. */
  commits: 2_000,
  /** Files committed as the baseline. */
  baselineFiles: 400,
  unstagedFiles: 150,
  stagedFiles: 100,
  untrackedFiles: 40,
  targetBytes: 200 * 1024,
};

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dir') options.dir = argv[++index];
    else if (arg === '--commits') options.commits = Number(argv[++index]);
    else if (arg.startsWith('--dir=')) options.dir = arg.slice('--dir='.length);
    else if (arg.startsWith('--commits=')) options.commits = Number(arg.slice('--commits='.length));
  }
  return options;
}

function git(cwd, args, input) {
  return execFileSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** Deterministic pseudo-random so file contents never depend on the clock. */
function seeded(index, salt = '') {
  let hash = 2166136261 ^ index;
  for (const char of salt) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

function fileBody(seed, lines) {
  const out = [];
  for (let line = 0; line < lines; line += 1) {
    out.push(`line ${line} :: ${(seeded(seed + line, 'body') % 100000).toString(36)}`);
  }
  return `${out.join('\n')}\n`;
}

/** Grows a deterministic body until it reaches `targetBytes`, so the fixture is honest
 *  about the "≤200KB text file" budget instead of assuming a bytes-per-line figure.
 *  Stops at the first line that crosses the target, so the overshoot is one line. */
function fileBodyOfSize(seed, targetBytes) {
  const out = [];
  let bytes = 0;
  for (let line = 0; bytes < targetBytes; line += 1) {
    const text = `line ${line} :: ${(seeded(seed + line, 'body') % 100000).toString(36)}\n`;
    out.push(text);
    bytes += Buffer.byteLength(text, 'utf8');
  }
  return out.join('');
}

function buildHistoryStream(count) {
  const parts = [];
  const blobBody = 'history marker\n';
  parts.push('blob\nmark :1\ndata ' + Buffer.byteLength(blobBody) + '\n' + blobBody);
  for (let index = 1; index <= count; index += 1) {
    const message = `chore: history commit ${index}\n`;
    parts.push(
      'commit refs/heads/main\n' +
        `mark :${index + 1}\n` +
        `author Perf Fixture <perf@probe.local> ${1_600_000_000 + index} +0000\n` +
        `committer Perf Fixture <perf@probe.local> ${1_600_000_000 + index} +0000\n` +
        `data ${Buffer.byteLength(message)}\n${message}` +
        (index > 1 ? `from :${index}\n` : '') +
        `M 100644 :1 history/commit-${String(index).padStart(5, '0')}.txt\n\n`
    );
  }
  // `git fast-import --done` requires an explicit `done` command to close the stream.
  return `${parts.join('')}done\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const dir = options.dir;

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const started = Date.now();
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'perf@probe.local']);
  git(dir, ['config', 'user.name', 'Perf Fixture']);
  // Keep the fixture's own history cheap: no reflog churn while generating.
  git(dir, ['config', 'gc.auto', '0']);

  // 1. History through fast-import — thousands of commits in one pass.
  git(dir, ['fast-import', '--quiet', '--done'], buildHistoryStream(options.commits));
  git(dir, ['reset', '-q', '--hard', 'HEAD']);

  // 2. A committed baseline of ordinary files.
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (let index = 0; index < options.baselineFiles; index += 1) {
    const name = `src/module-${String(index).padStart(4, '0')}.ts`;
    writeFileSync(join(dir, name), fileBody(index, 40));
  }
  git(dir, ['add', 'src']);
  git(dir, ['commit', '-q', '-m', 'feat: baseline modules']);

  // 3. The measured diff target: one large committed file, then one small change to it.
  //    This commit happens BEFORE any working-tree staging, otherwise it would sweep up
  //    the staged changes created in step 4 and the fixture would lose its staged group.
  mkdirSync(join(dir, 'large'), { recursive: true });
  const targetBody = fileBodyOfSize(9_000_000, options.targetBytes);
  writeFileSync(join(dir, 'large/target.txt'), targetBody);
  git(dir, ['add', 'large/target.txt']);
  git(dir, ['commit', '-q', '-m', 'feat: add large target']);
  // Change one line in the middle so the diff stays small while the file stays large.
  const original = targetBody.split('\n');
  original[Math.floor(original.length / 2)] = 'line changed by the perf fixture';
  writeFileSync(join(dir, 'large/target.txt'), `${original.join('\n')}`);

  // 4. Working tree states the panel must render.
  //    Paths are staged explicitly: `git add src` would also stage the unstaged edits and
  //    silently collapse two groups into one.
  const unstagedPaths = [];
  for (let index = 0; index < options.unstagedFiles; index += 1) {
    const name = `src/module-${String(index).padStart(4, '0')}.ts`;
    writeFileSync(join(dir, name), fileBody(index + 500_000, 40));
    unstagedPaths.push(name);
  }
  const stagedPaths = [];
  for (let index = 0; index < options.stagedFiles; index += 1) {
    const name = `src/module-${String(options.unstagedFiles + index).padStart(4, '0')}.ts`;
    writeFileSync(join(dir, name), fileBody(index + 600_000, 40));
    stagedPaths.push(name);
  }
  git(dir, ['add', '--', ...stagedPaths]);
  for (let index = 0; index < 20; index += 1) {
    const name = `src/module-${String(options.unstagedFiles + index).padStart(4, '0')}.ts`;
    writeFileSync(join(dir, name), fileBody(index + 700_000, 44));
  }

  mkdirSync(join(dir, 'untracked'), { recursive: true });
  for (let index = 0; index < options.untrackedFiles; index += 1) {
    writeFileSync(
      join(dir, `untracked/draft-${String(index).padStart(3, '0')}.txt`),
      fileBody(index + 800_000, 12)
    );
  }

  const summary = {
    dir,
    commits: options.commits,
    targetBytesRequested: options.targetBytes,
    // The real size, so the evidence never quotes the requested figure as an achieved one.
    targetBytesActual: Buffer.byteLength(targetBody, 'utf8'),
    // `-uall` so untracked files are counted individually rather than as one directory.
    porcelain: git(dir, ['status', '--porcelain=v1', '-uall']).split('\n').filter(Boolean).length,
    elapsedMs: Date.now() - started,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main();
