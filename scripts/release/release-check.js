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
 *   node scripts/release/release-check.js [options]
 *   npm run release:check -- [options]
 *
 * Options:
 *   --allow-dirty   Downgrade the dirty-worktree check from FAIL to WARN.
 *   --skip-tests    Skip the Jest suite (use only for a fast pre-flight).
 *   --skip-pack     Skip exact tarball creation and runtime smoke validation.
 *   --expected-version <version>
 *                   Require package identity to match the intended release.
 *   --json          Emit machine-readable JSON instead of the text report.
 *   --help          Show this help.
 */

const { spawnSync } = require('child_process');
const { readFileSync, existsSync, mkdtempSync, realpathSync, rmSync } = require('fs');
const { createHash } = require('crypto');
const { tmpdir } = require('os');
const { resolve, join } = require('path');

const projectRoot = resolve(__dirname, '../..');
const MAX_PACKED_PACKAGE_BYTES = 2 * 1024 * 1024;
const MAX_UNPACKED_PACKAGE_BYTES = 10 * 1024 * 1024;
const MAX_PACKAGE_ENTRIES = 1500;
const REQUIRED_PACKAGE_ENTRIES = [
  'assets/orion-tui-icon.png',
  'bin/orion',
  'CHANGELOG.md',
  'docs/readme.md',
  'docs/migration/v0.1.8-to-v0.1.9.md',
  'docs/plan/v0.1.9-release-checklist.md',
  'LICENSE',
  'README.md',
  'README.zh-CN.md',
  'npm-shrinkwrap.json',
  'package.json',
];
const ALLOWED_PACKAGE_PREFIXES = ['dist/'];
const argv = process.argv.slice(2);
const hasFlag = flag => argv.includes(flag);
const optionValue = name => {
  const inline = argv.find(value => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(
    readFileSync(__filename, 'utf8')
      .split('*/')[0]
      .replace(/^[\s\S]*?\/\*\*/, '')
  );
  process.exit(0);
}

const options = {
  allowDirty: hasFlag('--allow-dirty'),
  skipTests: hasFlag('--skip-tests'),
  skipPack: hasFlag('--skip-pack'),
  json: hasFlag('--json'),
  expectedVersion: optionValue('--expected-version'),
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

function releaseTag(version) {
  const ref = `refs/tags/v${version}`;
  const resolved = run('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return {
    ref,
    exists: resolved.code === 0 && resolved.stdout.trim().length > 0,
    commit: resolved.code === 0 ? resolved.stdout.trim() : null,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function versionSection(changelog, version) {
  const escaped = escapeRegExp(version);
  const lines = changelog.split('\n');
  const headingIndex = lines.findIndex(line =>
    new RegExp(`^#{1,3}\\s*\\[?${escaped}\\]?(?:\\s|$)`).test(line.trim())
  );
  if (headingIndex < 0) return null;

  let endIndex = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index++) {
    if (/^#{1,3}\s+/.test(lines[index].trim())) {
      endIndex = index;
      break;
    }
  }

  const heading = lines[headingIndex].trim();
  const text = lines.slice(headingIndex, endIndex).join('\n');
  const marksUnreleased =
    /status\s*:\s*(?:unreleased|candidate|merged|in development)|\bunreleased\b|\bcandidate\b|\bin development\b|not (?:yet )?(?:tagged|published)|候选|已合并|未发布/i.test(
      text
    );
  const claimsPublished =
    /status\s*:\s*published|status[^\n]*(?:已发布|已发[布佈])|已发布|已发[布佈]/i.test(text) ||
    (!marksUnreleased && /\bpublished\b/i.test(text));
  return {
    heading,
    text,
    claimsPublished,
    marksUnreleased,
    hasReleaseDate: /\d{4}-\d{2}-\d{2}/.test(heading),
  };
}

function readGitFile(commit, relativePath) {
  const outcome = run('git', ['show', `${commit}:${relativePath}`]);
  return outcome.code === 0 ? outcome.stdout : null;
}

// ---------------------------------------------------------------------------
// 1. Version / identity consistency
// ---------------------------------------------------------------------------

function checkVersionConsistency() {
  const pkg = readJson('package.json');
  const version = pkg.version;
  const mismatches = [];
  const checked = [];

  if (options.expectedVersion) {
    checked.push(`expected-version=${options.expectedVersion}`);
    if (version !== options.expectedVersion) {
      mismatches.push(
        `package.json version: expected release ${options.expectedVersion}, found ${version}`
      );
    }
  }
  const branch = run('git', ['branch', '--show-current']).stdout.trim();
  const releaseBranchVersion = branch.match(/^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/)?.[1];
  if (releaseBranchVersion) {
    checked.push(`release-branch=${branch}`);
    if (version !== releaseBranchVersion) {
      mismatches.push(
        `release branch ${branch}: package.json version expected ${releaseBranchVersion}, found ${version}`
      );
    }
  }

  const expect = (label, actual) => {
    checked.push(`${label}=${actual === null || actual === undefined ? '<missing>' : actual}`);
    if (actual !== version) {
      mismatches.push(`${label}: expected ${version}, found ${actual ?? '<missing>'}`);
    }
  };

  // npm-shrinkwrap.json is published with the CLI and locks consumer installs.
  let lock = null;
  try {
    lock = readJson('npm-shrinkwrap.json');
  } catch {
    mismatches.push('npm-shrinkwrap.json: unreadable or missing');
  }
  if (lock) {
    expect('npm-shrinkwrap.version', lock.version);
    const rootEntry = lock.packages && lock.packages[''];
    expect('npm-shrinkwrap.packages[""].version', rootEntry && rootEntry.version);
  }

  // README install pins: `npm install -g @orion-agents/orion-code@X.Y.Z`
  const pinPattern =
    /@orion-agents\/orion-code@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/g;
  const summaryVersionPattern =
    /^\s*>\s*(?:\*\*)?v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/m;
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
    const summaryVersion = text.match(summaryVersionPattern)?.[1];
    checked.push(`${readme}.summary=${summaryVersion ?? '<missing>'}`);
    if (summaryVersion !== version) {
      mismatches.push(
        `${readme}: top-level version summary expected ${version}, found ${summaryVersion ?? '<missing>'}`
      );
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

  // Once the version tag exists, README status prose must not still describe
  // that version as unreleased or name an older release as the latest/current.
  if (releaseTag(version).exists) {
    const escapedVersion = escapeRegExp(version);
    const unreleasedPattern = new RegExp(
      `(?:v)?${escapedVersion}[^\\n]{0,160}` +
        '(?:not on npm yet|not yet published|in-development|in development|开发中|尚未发布|未发布)',
      'i'
    );

    for (const readme of ['README.md', 'README.zh-CN.md']) {
      const text = readTextIfPresent(readme);
      if (!text) continue;
      if (unreleasedPattern.test(text)) {
        mismatches.push(
          `${readme}: contradicts refs/tags/v${version} by describing ${version} as unreleased`
        );
      }

      const olderLatestClaims = [
        ...text.matchAll(
          /v?(\d+\.\d+\.\d+)[^\n]{0,120}(?:is the current published release|(?:latest|current) published version)/gi
        ),
        ...text.matchAll(/v?(\d+\.\d+\.\d+)\s*[（(](?:最新|当前)已发布版本[）)]/g),
        ...text.matchAll(/当前已发布版本[\s\S]{0,80}?v?(\d+\.\d+\.\d+)/g),
      ];
      for (const claim of olderLatestClaims) {
        if (claim[1] !== version) {
          mismatches.push(
            `${readme}: claims ${claim[1]} is the latest/current published release; expected ${version}`
          );
        }
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

  const section = versionSection(changelog, version);
  if (!section) {
    return record(
      'changelog',
      'CHANGELOG.md entry',
      STATUS.FAIL,
      `CHANGELOG has no standard heading for ${version} (expected e.g. "## [${version}] — UNRELEASED")`
    );
  }

  const tag = releaseTag(version);
  if (!tag.exists) {
    // Claiming published status, or stamping a release date, requires a tag.
    if (section.claimsPublished || (section.hasReleaseDate && !section.marksUnreleased)) {
      return record(
        'changelog',
        'CHANGELOG.md entry',
        STATUS.FAIL,
        `CHANGELOG presents ${version} as released ("${section.heading}") but ${tag.ref} does not ` +
          'exist.\nMark it UNRELEASED / candidate / merged until the tag is created.'
      );
    }
    if (!section.marksUnreleased) {
      return record(
        'changelog',
        'CHANGELOG.md entry',
        STATUS.WARN,
        `"${section.heading}" does not state a delivery state; ` +
          'add UNRELEASED / candidate / merged so readers cannot mistake it for a release.'
      );
    }
  } else {
    if (section.marksUnreleased) {
      return record(
        'changelog',
        'CHANGELOG.md entry',
        STATUS.FAIL,
        `${tag.ref} exists, but the ${version} section still claims an unreleased/candidate state ` +
          `("${section.heading}"). Mark the current release evidence as published.`
      );
    }
    if (!section.claimsPublished || !section.hasReleaseDate) {
      return record(
        'changelog',
        'CHANGELOG.md entry',
        STATUS.FAIL,
        `${tag.ref} exists, but the ${version} section does not contain both an explicit published ` +
          `state and a release date ("${section.heading}").`
      );
    }
  }

  record(
    'changelog',
    'CHANGELOG.md entry',
    STATUS.PASS,
    `${section.heading}; ${tag.exists ? `${tag.ref} exists and state is published` : `${tag.ref} not created (candidate/merged)`}`
  );
}

// ---------------------------------------------------------------------------
// 3. Release tag target and current checkout relationship
// ---------------------------------------------------------------------------

function checkReleaseRef() {
  const { version } = readJson('package.json');
  const tag = releaseTag(version);
  if (!tag.exists || !tag.commit) {
    return record(
      'release-ref',
      `Release ref (${tag.ref})`,
      STATUS.SKIP,
      `${tag.ref} not created; candidate/merged CHANGELOG rules apply`
    );
  }

  const taggedPackageText = readGitFile(tag.commit, 'package.json');
  let taggedVersion = null;
  try {
    taggedVersion = taggedPackageText ? JSON.parse(taggedPackageText).version : null;
  } catch {
    taggedVersion = null;
  }
  if (taggedVersion !== version) {
    return record(
      'release-ref',
      `Release ref (${tag.ref})`,
      STATUS.FAIL,
      `${tag.ref} resolves to ${tag.commit}, whose package.json version is ` +
        `${taggedVersion ?? '<missing/unreadable>'}; expected ${version}`
    );
  }

  const taggedChangelog = readGitFile(tag.commit, 'CHANGELOG.md');
  const taggedSection = taggedChangelog ? versionSection(taggedChangelog, version) : null;
  if (!taggedSection) {
    return record(
      'release-ref',
      `Release ref (${tag.ref})`,
      STATUS.FAIL,
      `${tag.ref} resolves to ${tag.commit}, but that tree has no standard CHANGELOG heading for ${version}`
    );
  }

  const headLookup = run('git', ['rev-parse', '--verify', 'HEAD']);
  if (headLookup.code !== 0) {
    return record(
      'release-ref',
      `Release ref (${tag.ref})`,
      STATUS.FAIL,
      `cannot resolve HEAD: ${headLookup.stderr.trim() || 'unknown git error'}`
    );
  }
  const head = headLookup.stdout.trim();
  const details = [`${tag.ref} -> ${tag.commit}`, `tagged package version=${taggedVersion}`];
  let status = STATUS.PASS;

  if (!taggedSection.claimsPublished || taggedSection.marksUnreleased) {
    status = STATUS.FAIL;
    details.push(
      `tagged CHANGELOG is stale ("${taggedSection.heading}"); current-tree CHANGELOG carries the post-publish evidence`
    );
  }

  if (head === tag.commit) {
    details.push('checkout=release tree (HEAD equals tag commit)');
  } else {
    const tagIsAncestor = run('git', ['merge-base', '--is-ancestor', tag.commit, head]);
    const headIsAncestor = run('git', ['merge-base', '--is-ancestor', head, tag.commit]);
    if (tagIsAncestor.code === 0) {
      if (status !== STATUS.FAIL) status = STATUS.WARN;
      details.push(
        `checkout=post-release commits (${head.slice(0, 12)} is ahead of the immutable release tag); HEAD is not published by ${tag.ref}`
      );
    } else if (headIsAncestor.code === 0) {
      return record(
        'release-ref',
        `Release ref (${tag.ref})`,
        STATUS.FAIL,
        `HEAD ${head} is behind the release tag ${tag.commit}; check out the release tree or a post-release maintenance branch`
      );
    } else {
      const mergeBase = run('git', ['merge-base', tag.commit, head]);
      if (status !== STATUS.FAIL) status = STATUS.WARN;
      details.push(
        `checkout=post-release branch drift (HEAD ${head.slice(0, 12)} and tag diverge at ` +
          `${mergeBase.stdout.trim().slice(0, 12) || '<unknown>'}); validate the tag tree as the published artifact`
      );
    }
  }

  record('release-ref', `Release ref (${tag.ref})`, status, details.join('\n'));
}

// ---------------------------------------------------------------------------
// 4. Whitespace / conflict-marker hygiene
// ---------------------------------------------------------------------------

function checkGitHygiene() {
  const diff = run('git', ['diff', '--check']);
  const staged = run('git', ['diff', '--cached', '--check']);
  const problems = [diff.stdout, diff.stderr, staged.stdout, staged.stderr]
    .filter(chunk => chunk.trim().length > 0)
    .join('\n')
    .trim();
  if (problems) {
    return record(
      'git-hygiene',
      'git diff --check',
      STATUS.FAIL,
      problems.split('\n').slice(0, 20).join('\n')
    );
  }
  record('git-hygiene', 'git diff --check', STATUS.PASS, 'no whitespace or conflict-marker errors');
}

// ---------------------------------------------------------------------------
// 5. Dirty worktree
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
// 6-8. Lint / typecheck / tests
// ---------------------------------------------------------------------------

function checkLint() {
  const eslint = localBin('eslint');
  if (!eslint) {
    return record(
      'lint',
      'ESLint',
      STATUS.WARN,
      'node_modules/.bin/eslint not found; run npm install'
    );
  }
  const outcome = run(eslint, ['src/']);
  const combined = `${outcome.stdout}${outcome.stderr}`;
  const summary = combined.match(/\d+ problems? \(\d+ errors?, \d+ warnings?\)/);
  if (outcome.code !== 0) {
    return record(
      'lint',
      'ESLint',
      STATUS.FAIL,
      (summary && summary[0]) || combined.trim().slice(-1500)
    );
  }
  record('lint', 'ESLint', STATUS.PASS, (summary && summary[0]) || '0 errors');
}

function checkTypes() {
  const tsc = localBin('tsc');
  if (!tsc) {
    return record(
      'typecheck',
      'tsc --noEmit',
      STATUS.WARN,
      'node_modules/.bin/tsc not found; run npm install'
    );
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
    return record(
      'tests',
      'Jest suite',
      STATUS.WARN,
      'node_modules/.bin/jest not found; run npm install'
    );
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
// 9. Exact package artifact and clean-install smoke
// ---------------------------------------------------------------------------

function checkPack() {
  if (options.skipPack) {
    return record('pack', 'npm package artifact', STATUS.SKIP, 'skipped via --skip-pack');
  }
  // Build the exact tarball in an isolated directory. `--ignore-scripts` keeps
  // this gate read-only with respect to the repository; callers build first.
  // Canonicalize macOS' /var -> /private/var alias before npm records the
  // tarball file spec. Otherwise `npm ls` reports the correctly installed
  // package as invalid solely because the spec and real path spellings differ.
  const packDir = realpathSync(mkdtempSync(join(tmpdir(), 'orion-release-pack-')));
  const outcome = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packDir]);
  if (outcome.code !== 0) {
    rmSync(packDir, { recursive: true, force: true });
    return record(
      'pack',
      'npm package artifact',
      STATUS.FAIL,
      `${outcome.stdout}${outcome.stderr}`.trim().slice(-1500)
    );
  }
  let parsed = null;
  try {
    parsed = JSON.parse(outcome.stdout);
  } catch {
    rmSync(packDir, { recursive: true, force: true });
    return record(
      'pack',
      'npm package artifact',
      STATUS.FAIL,
      'could not parse npm pack JSON output'
    );
  }
  const tarball = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!tarball) {
    rmSync(packDir, { recursive: true, force: true });
    return record(
      'pack',
      'npm package artifact',
      STATUS.FAIL,
      'npm pack returned no tarball metadata'
    );
  }

  const entryNames = (tarball.files || []).map(file => file.path);
  const missing = REQUIRED_PACKAGE_ENTRIES.filter(required => !entryNames.includes(required));
  const hasDist = entryNames.some(name => name.startsWith('dist/'));
  if (!hasDist) missing.push('dist/** (build output)');

  const allowedExactEntries = new Set(REQUIRED_PACKAGE_ENTRIES);
  const unexpected = entryNames.filter(
    name =>
      !allowedExactEntries.has(name) &&
      !ALLOWED_PACKAGE_PREFIXES.some(prefix => name.startsWith(prefix))
  );
  const entryCount = Number(tarball.entryCount);
  const packedSize = Number(tarball.size);
  const unpackedSize = Number(tarball.unpackedSize);
  const packageBudgetFailures = [];
  if (!Number.isSafeInteger(entryCount) || entryCount < 1) {
    packageBudgetFailures.push(`invalid entry count: ${tarball.entryCount ?? '<missing>'}`);
  } else if (entryCount > MAX_PACKAGE_ENTRIES) {
    packageBudgetFailures.push(
      `entry count ${entryCount} exceeds ${MAX_PACKAGE_ENTRIES} file budget`
    );
  }
  if (!Number.isSafeInteger(packedSize) || packedSize < 1) {
    packageBudgetFailures.push(`invalid packed size: ${tarball.size ?? '<missing>'}`);
  } else if (packedSize > MAX_PACKED_PACKAGE_BYTES) {
    packageBudgetFailures.push(
      `packed size ${(packedSize / 1024 / 1024).toFixed(2)} MB exceeds ` +
        `${(MAX_PACKED_PACKAGE_BYTES / 1024 / 1024).toFixed(2)} MB budget`
    );
  }
  if (!Number.isSafeInteger(unpackedSize) || unpackedSize < 1) {
    packageBudgetFailures.push(`invalid unpacked size: ${tarball.unpackedSize ?? '<missing>'}`);
  } else if (unpackedSize > MAX_UNPACKED_PACKAGE_BYTES) {
    packageBudgetFailures.push(
      `unpacked size ${(unpackedSize / 1024 / 1024).toFixed(2)} MB exceeds ` +
        `${(MAX_UNPACKED_PACKAGE_BYTES / 1024 / 1024).toFixed(2)} MB budget`
    );
  }

  const detail =
    `${tarball.name}@${tarball.version} · ${entryCount} files · ` +
    `packed ${(packedSize / 1024 / 1024).toFixed(2)} MB · ` +
    `unpacked ${(unpackedSize / 1024 / 1024).toFixed(2)} MB`;

  if (missing.length > 0 || unexpected.length > 0 || packageBudgetFailures.length > 0) {
    rmSync(packDir, { recursive: true, force: true });
    const failures = [];
    if (missing.length > 0) failures.push(`missing from tarball: ${missing.join(', ')}`);
    if (unexpected.length > 0) {
      failures.push(`unexpected tarball entries: ${unexpected.slice(0, 25).join(', ')}`);
    }
    failures.push(...packageBudgetFailures);
    return record('pack', 'npm package artifact', STATUS.FAIL, `${detail}\n${failures.join('\n')}`);
  }

  const tarballPath = join(packDir, tarball.filename || '');
  const tarballSha256 = createHash('sha256').update(readFileSync(tarballPath)).digest('hex');
  const extract = run('tar', ['-xzf', tarballPath, '-C', packDir]);
  if (extract.code !== 0) {
    rmSync(packDir, { recursive: true, force: true });
    return record(
      'pack',
      'npm package artifact',
      STATUS.FAIL,
      `unable to extract exact tarball: ${extract.stderr || extract.stdout}`
    );
  }

  const installDir = join(packDir, 'install');
  const install = run('npm', [
    'install',
    '--prefix',
    installDir,
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    tarballPath,
  ]);
  if (install.code !== 0) {
    rmSync(packDir, { recursive: true, force: true });
    return record(
      'pack',
      'npm package artifact',
      STATUS.FAIL,
      `clean tarball install failed: ${`${install.stdout}${install.stderr}`.trim().slice(-1500)}`
    );
  }

  const installedPackage = join(installDir, 'node_modules', '@orion-agents', 'orion-code');
  const smokeEnv = {
    ...process.env,
    ORION_CODE_CONFIG_DIR: join(packDir, 'config'),
  };
  const versionSmoke = run(
    process.execPath,
    [join(installedPackage, 'bin', 'orion'), '--version'],
    { cwd: installDir, env: smokeEnv }
  );
  const helpSmoke = run(process.execPath, [join(installedPackage, 'bin', 'orion'), '--help'], {
    cwd: installDir,
    env: smokeEnv,
  });
  const treeProbe = run('npm', ['ls', '--prefix', installDir, '--omit=dev', '--all']);
  const nativeProbe = run(
    process.execPath,
    [
      '-e',
      "const {createRequire}=require('module');const r=createRequire(process.cwd()+'/probe.js');const L=r('better-sqlite3');const D=L.default||L;const db=new D(':memory:',{allowExtension:true});const V=r('sqlite-vec');const vec=V.default||V;vec.load(db);if(!db.prepare('SELECT vec_version() AS version').get().version)process.exit(2);db.close();",
    ],
    {
      cwd: installDir,
      env: smokeEnv,
    }
  );
  const smokeFailure = [
    ['version', versionSmoke],
    ['help', helpSmoke],
    ['dependency tree', treeProbe],
    ['native dependency', nativeProbe],
  ].find(([, outcome]) => outcome.code !== 0);
  const versionMatches = versionSmoke.stdout.includes(String(tarball.version));
  const helpMatches = /Usage:|Orion Code/u.test(helpSmoke.stdout);
  const installedShrinkwrap = existsSync(join(installedPackage, 'npm-shrinkwrap.json'));
  const smokeSummary = smokeFailure
    ? `${smokeFailure[0]} probe failed: ${`${smokeFailure[1].stdout}${smokeFailure[1].stderr}`.trim().slice(-1500)}`
    : !versionMatches || !helpMatches || !installedShrinkwrap
      ? `artifact identity mismatch (version=${versionMatches}, help=${helpMatches}, shrinkwrap=${installedShrinkwrap})`
      : '';
  rmSync(packDir, { recursive: true, force: true });
  if (smokeSummary) {
    return record('pack', 'npm package artifact', STATUS.FAIL, smokeSummary);
  }
  record(
    'pack',
    'npm package artifact',
    STATUS.PASS,
    `${detail} · sha256 ${tarballSha256} · clean install/version/help/native ok`
  );
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
    console.log(
      '\nNote: this script does not tag, push, or publish. Those need explicit authorization.'
    );
    return 0;
  }

  console.log(`FAIL — ${failed.length} blocking issue(s): ${failed.map(f => f.id).join(', ')}`);
  console.log('Release gate is NO-GO until the above are resolved.');
  return 1;
}

function main() {
  checkVersionConsistency();
  checkChangelog();
  checkReleaseRef();
  checkGitHygiene();
  checkWorktreeClean();
  checkLint();
  checkTypes();
  checkTests();
  checkPack();
  process.exit(report());
}

main();
