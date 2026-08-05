#!/usr/bin/env node
'use strict';

/**
 * release-check — read-only release gate for Orion Code.
 *
 * Verifies that the repository is in a publishable state. This script NEVER
 * mutates the repository or the registry: it will not run `git tag`, `git push`,
 * open PRs, merge, or `npm publish`. Those remain separately authorized actions.
 *
 * Usage:
 *   node scripts/release-check.js [options]
 *   npm run release:check -- [options]
 *
 * Options:
 *   --allow-dirty   Downgrade the dirty-worktree check from FAIL to WARN.
 *   --skip-tests    Skip the Jest suite (use only for a fast pre-flight).
 *   --skip-pack     Skip `npm pack --dry-run`.
 *   --json          Emit machine-readable JSON instead of the text report.
 *   --help          Show this help.
 */

const { spawnSync } = require('child_process');
const { readFileSync, existsSync } = require('fs');
const { resolve, join } = require('path');

const projectRoot = resolve(__dirname, '..');
const argv = process.argv.slice(2);
const hasFlag = flag => argv.includes(flag);

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(readFileSync(__filename, 'utf8').split('*/')[0].replace(/^[\s\S]*?\/\*\*/, ''));
  process.exit(0);
}

const options = {
  allowDirty: hasFlag('--allow-dirty'),
  skipTests: hasFlag('--skip-tests'),
  skipPack: hasFlag('--skip-pack'),
  json: hasFlag('--json'),
};

const STATUS = { PASS: 'pass', FAIL: 'fail', WARN: 'warn', SKIP: 'skip' };
const results = [];

function record(id, title, status, detail) {
  results.push({ id, title, status, detail: detail || '' });
}

/** Run a command without a shell. Returns { code, stdout, stderr }. */
function run(command, args, extraOptions) {
  const outcome = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...extraOptions,
  });
  return {
    code: outcome.status === null ? 1 : outcome.status,
    stdout: outcome.stdout || '',
    stderr: outcome.stderr || '',
    error: outcome.error,
  };
}

function localBin(name) {
  const binary = join(projectRoot, 'node_modules', '.bin', name);
  return existsSync(binary) ? binary : null;
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(projectRoot, relativePath), 'utf8'));
}

function readTextIfPresent(relativePath) {
  const absolute = join(projectRoot, relativePath);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
}

// ---------------------------------------------------------------------------
// 1. Version / identity consistency
// ---------------------------------------------------------------------------

function checkVersionConsistency() {
  const pkg = readJson('package.json');
  const version = pkg.version;
  const mismatches = [];
  const checked = [];

  const expect = (label, actual) => {
    checked.push(`${label}=${actual === null || actual === undefined ? '<missing>' : actual}`);
    if (actual !== version) {
      mismatches.push(`${label}: expected ${version}, found ${actual ?? '<missing>'}`);
    }
  };

  // package-lock.json: both the root version and the "" workspace entry.
  let lock = null;
  try {
    lock = readJson('package-lock.json');
  } catch {
    mismatches.push('package-lock.json: unreadable or missing');
  }
  if (lock) {
    expect('package-lock.version', lock.version);
    const rootEntry = lock.packages && lock.packages[''];
    expect('package-lock.packages[""].version', rootEntry && rootEntry.version);
  }

  // README install pins: `npm install -g @orion-agents/orion-code@X.Y.Z`
  const pinPattern = /@orion-agents\/orion-code@(\d+\.\d+\.\d+)/g;
  for (const readme of ['README.md', 'README.zh-CN.md']) {
    const text = readTextIfPresent(readme);
    if (text === null) {
      mismatches.push(`${readme}: missing`);
      continue;
    }
    const pins = [...text.matchAll(pinPattern)].map(match => match[1]);
    if (pins.length === 0) {
      mismatches.push(`${readme}: no install pin (@orion-agents/orion-code@X.Y.Z) found`);
      continue;
    }
    const bad = pins.filter(pin => pin !== version);
    checked.push(`${readme}.pin=${[...new Set(pins)].join(',')}`);
    if (bad.length > 0) {
      mismatches.push(`${readme}: install pin(s) ${[...new Set(bad)].join(', ')} != ${version}`);
    }
  }

  // Chinese README "当前版本" section marker must not lag behind the package.
  const zhReadme = readTextIfPresent('README.zh-CN.md');
  if (zhReadme) {
    const marker = zhReadme.match(/v(\d+\.\d+\.\d+)\s*（当前版本）/);
    if (marker) {
      checked.push(`README.zh-CN.当前版本=${marker[1]}`);
      if (marker[1] !== version) {
        mismatches.push(
          `README.zh-CN.md: "v${marker[1]}（当前版本）" marker is stale, package is ${version}`
        );
      }
    }
  }

  // The runtime banner/help must derive the version from package.json, never hardcode it.
  const versionSource = readTextIfPresent('src/product/version.ts');
  if (versionSource && !versionSource.includes("resolve(__dirname, '../../package.json')")) {
    mismatches.push(
      'src/product/version.ts: no longer resolves the version from package.json (banner/help may drift)'
    );
  }

  if (mismatches.length > 0) {
    return record(
      'version',
      `Version consistency (package ${version})`,
      STATUS.FAIL,
      mismatches.join('\n')
    );
  }
  record('version', `Version consistency (package ${version})`, STATUS.PASS, checked.join(' | '));
}

// ---------------------------------------------------------------------------
// 2. CHANGELOG entry for the current version
// ---------------------------------------------------------------------------

function checkChangelog() {
  const changelog = readTextIfPresent('CHANGELOG.md');
  if (changelog === null) {
    return record('changelog', 'CHANGELOG.md entry', STATUS.FAIL, 'CHANGELOG.md is missing');
  }
  const { version } = readJson('package.json');
  if (!changelog.includes(version)) {
    return record(
      'changelog',
      'CHANGELOG.md entry',
      STATUS.FAIL,
      `CHANGELOG.md has no entry mentioning ${version}`
    );
  }

  // A version that is not tagged must not be presented as a published release.
  const tagLookup = run('git', ['tag', '--list', `v${version}`]);
  const tagged = tagLookup.stdout.trim().length > 0;

  if (!tagged) {
    const escaped = version.replace(/\./g, '\\.');
    const headingLine = changelog
      .split('\n')
      .find(line => new RegExp(`^#{1,3}\\s*\\[?${escaped}\\]?`).test(line.trim()));

    if (!headingLine) {
      return record(
        'changelog',
        'CHANGELOG.md entry',
        STATUS.FAIL,
        `CHANGELOG has no heading for ${version} (expected e.g. "## [${version}] — UNRELEASED")`
      );
    }

    // Claiming published status, or stamping a release date, requires a tag.
    const claimsPublished = /published|已发布|已发[布佈]/i.test(headingLine);
    const hasReleaseDate = /\d{4}-\d{2}-\d{2}/.test(headingLine);
    const marksUnreleased = /unreleased|candidate|merged|候选|已合并|未发布/i.test(headingLine);

    if (claimsPublished || (hasReleaseDate && !marksUnreleased)) {
      return record(
        'changelog',
        'CHANGELOG.md entry',
        STATUS.FAIL,
        `CHANGELOG presents ${version} as released ("${headingLine.trim()}") but no git tag ` +
          `v${version} exists.\nMark it UNRELEASED / candidate / merged until the tag is created.`
      );
    }
    if (!marksUnreleased) {
      return record(
        'changelog',
        'CHANGELOG.md entry',
        STATUS.WARN,
        `"${headingLine.trim()}" does not state a delivery state; ` +
          'add UNRELEASED / candidate / merged so readers cannot mistake it for a release.'
      );
    }
  }
  record(
    'changelog',
    'CHANGELOG.md entry',
    STATUS.PASS,
    `mentions ${version}; tag v${version} ${tagged ? 'exists' : 'not created yet (candidate/merged)'}`
  );
}

// ---------------------------------------------------------------------------
// 3. Whitespace / conflict-marker hygiene
// ---------------------------------------------------------------------------

function checkGitHygiene() {
  const diff = run('git', ['diff', '--check']);
  const staged = run('git', ['diff', '--cached', '--check']);
  const problems = [diff.stdout, diff.stderr, staged.stdout, staged.stderr]
    .filter(chunk => chunk.trim().length > 0)
    .join('\n')
    .trim();
  if (problems) {
    return record('git-hygiene', 'git diff --check', STATUS.FAIL, problems.split('\n').slice(0, 20).join('\n'));
  }
  record('git-hygiene', 'git diff --check', STATUS.PASS, 'no whitespace or conflict-marker errors');
}

// ---------------------------------------------------------------------------
// 4. Dirty worktree
// ---------------------------------------------------------------------------

function checkWorktreeClean() {
  const status = run('git', ['status', '--porcelain']);
  const lines = status.stdout.split('\n').filter(line => line.trim().length > 0);
  if (lines.length === 0) {
    return record('worktree', 'Clean worktree', STATUS.PASS, 'worktree is clean');
  }
  const tracked = lines.filter(line => !line.startsWith('??')).length;
  const untracked = lines.length - tracked;
  const preview = lines.slice(0, 12).join('\n');
  const detail =
    `${lines.length} dirty entries (${tracked} tracked, ${untracked} untracked)\n${preview}` +
    (lines.length > 12 ? `\n... and ${lines.length - 12} more` : '');
  record(
    'worktree',
    'Clean worktree',
    options.allowDirty ? STATUS.WARN : STATUS.FAIL,
    detail + (options.allowDirty ? '\n(downgraded by --allow-dirty)' : '')
  );
}

// ---------------------------------------------------------------------------
// 5-7. Lint / typecheck / tests
// ---------------------------------------------------------------------------

function checkLint() {
  const eslint = localBin('eslint');
  if (!eslint) {
    return record('lint', 'ESLint', STATUS.WARN, 'node_modules/.bin/eslint not found; run npm install');
  }
  const outcome = run(eslint, ['src/']);
  const combined = `${outcome.stdout}${outcome.stderr}`;
  const summary = combined.match(/\d+ problems? \(\d+ errors?, \d+ warnings?\)/);
  if (outcome.code !== 0) {
    return record('lint', 'ESLint', STATUS.FAIL, (summary && summary[0]) || combined.trim().slice(-1500));
  }
  record('lint', 'ESLint', STATUS.PASS, (summary && summary[0]) || '0 errors');
}

function checkTypes() {
  const tsc = localBin('tsc');
  if (!tsc) {
    return record('typecheck', 'tsc --noEmit', STATUS.WARN, 'node_modules/.bin/tsc not found; run npm install');
  }
  const outcome = run(tsc, ['--noEmit']);
  if (outcome.code !== 0) {
    const combined = `${outcome.stdout}${outcome.stderr}`.trim();
    const errorLines = combined.split('\n').filter(line => line.includes('error TS'));
    return record(
      'typecheck',
      'tsc --noEmit',
      STATUS.FAIL,
      `${errorLines.length} type error(s)\n${errorLines.slice(0, 15).join('\n')}`
    );
  }
  record('typecheck', 'tsc --noEmit', STATUS.PASS, '0 type errors');
}

function checkTests() {
  if (options.skipTests) {
    return record('tests', 'Jest suite', STATUS.SKIP, 'skipped via --skip-tests');
  }
  const jest = localBin('jest');
  if (!jest) {
    return record('tests', 'Jest suite', STATUS.WARN, 'node_modules/.bin/jest not found; run npm install');
  }
  const outcome = run(jest, ['--runInBand', '--ci']);
  const combined = `${outcome.stdout}${outcome.stderr}`;
  const suites = combined.match(/Test Suites:.*/);
  const tests = combined.match(/Tests:.*/);
  const summary = [suites && suites[0], tests && tests[0]].filter(Boolean).join(' | ');
  if (outcome.code !== 0) {
    const failed = combined
      .split('\n')
      .filter(line => line.startsWith('FAIL'))
      .slice(0, 15)
      .join('\n');
    return record('tests', 'Jest suite', STATUS.FAIL, `${summary}\n${failed}`.trim());
  }
  record('tests', 'Jest suite', STATUS.PASS, summary || 'all tests passed');
}

// ---------------------------------------------------------------------------
// 8. Package dry-run
// ---------------------------------------------------------------------------

function checkPack() {
  if (options.skipPack) {
    return record('pack', 'npm pack --dry-run', STATUS.SKIP, 'skipped via --skip-pack');
  }
  // `--ignore-scripts` keeps this check read-only: it must not trigger `prepack`
  // (which would run a full clean + build and mutate dist/).
  const outcome = run('npm', ['pack', '--dry-run', '--ignore-scripts', '--json']);
  if (outcome.code !== 0) {
    return record(
      'pack',
      'npm pack --dry-run',
      STATUS.FAIL,
      `${outcome.stdout}${outcome.stderr}`.trim().slice(-1500)
    );
  }
  let parsed = null;
  try {
    parsed = JSON.parse(outcome.stdout);
  } catch {
    return record('pack', 'npm pack --dry-run', STATUS.WARN, 'could not parse npm pack JSON output');
  }
  const tarball = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!tarball) {
    return record('pack', 'npm pack --dry-run', STATUS.WARN, 'npm pack returned no tarball metadata');
  }

  const entryNames = (tarball.files || []).map(file => file.path);
  const missing = ['bin/orion', 'README.md', 'LICENSE'].filter(
    required => !entryNames.includes(required)
  );
  const hasDist = entryNames.some(name => name.startsWith('dist/'));
  if (!hasDist) missing.push('dist/** (build output)');

  const detail =
    `${tarball.name}@${tarball.version} · ${tarball.entryCount} files · ` +
    `unpacked ${(tarball.unpackedSize / 1024 / 1024).toFixed(2)} MB`;

  if (missing.length > 0) {
    return record(
      'pack',
      'npm pack --dry-run',
      STATUS.FAIL,
      `${detail}\nmissing from tarball: ${missing.join(', ')}`
    );
  }
  record('pack', 'npm pack --dry-run', STATUS.PASS, detail);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function report() {
  const icons = { pass: '✅', fail: '❌', warn: '⚠️ ', skip: '⏭️ ' };
  const failed = results.filter(result => result.status === STATUS.FAIL);
  const warned = results.filter(result => result.status === STATUS.WARN);

  if (options.json) {
    console.log(
      JSON.stringify(
        { ok: failed.length === 0, failed: failed.length, warned: warned.length, results },
        null,
        2
      )
    );
    return failed.length === 0 ? 0 : 1;
  }

  console.log('\nrelease:check — read-only release gate');
  console.log('='.repeat(60));
  for (const result of results) {
    console.log(`${icons[result.status]} ${result.title}`);
    if (result.detail) {
      for (const line of result.detail.split('\n')) {
        console.log(`     ${line}`);
      }
    }
  }
  console.log('='.repeat(60));

  if (failed.length === 0) {
    console.log(
      `PASS — ${results.length} checks, 0 failures` +
        (warned.length ? `, ${warned.length} warning(s)` : '')
    );
    console.log('\nNote: this script does not tag, push, or publish. Those need explicit authorization.');
    return 0;
  }

  console.log(`FAIL — ${failed.length} blocking issue(s): ${failed.map(f => f.id).join(', ')}`);
  console.log('Release gate is NO-GO until the above are resolved.');
  return 1;
}

function main() {
  checkVersionConsistency();
  checkChangelog();
  checkGitHygiene();
  checkWorktreeClean();
  checkLint();
  checkTypes();
  checkTests();
  checkPack();
  process.exit(report());
}

main();
