import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';

type ReleaseResult = {
  id: string;
  status: 'pass' | 'fail' | 'warn' | 'skip';
  detail: string;
};

type ReleaseReport = {
  ok: boolean;
  failed: number;
  warned: number;
  results: ReleaseResult[];
};

const projectRoot = resolve(__dirname, '..');
const releaseScript = join(projectRoot, 'scripts', 'release-check.js');
const depHealthScript = join(projectRoot, 'scripts', 'dep-health-check.sh');
const fixtures: string[] = [];

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function writeVersionFiles(cwd: string, version: string, changelog: string): void {
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({ name: 'release-check-fixture', version }, null, 2) + '\n'
  );
  writeFileSync(
    join(cwd, 'package-lock.json'),
    JSON.stringify(
      {
        name: 'release-check-fixture',
        version,
        lockfileVersion: 3,
        packages: { '': { name: 'release-check-fixture', version } },
      },
      null,
      2
    ) + '\n'
  );
  writeFileSync(join(cwd, 'README.md'), `npm install -g @orion-agents/orion-code@${version}\n`);
  writeFileSync(
    join(cwd, 'README.zh-CN.md'),
    `v${version}（当前版本）\n\nnpm install -g @orion-agents/orion-code@${version}\n`
  );
  writeFileSync(join(cwd, 'CHANGELOG.md'), `# Changelog\n\n${changelog.trim()}\n`);
}

function commitAll(cwd: string, message: string): void {
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-qm', message]);
}

function createFixture(version: string, changelog: string): string {
  const cwd = mkdtempSync(join(tmpdir(), 'orion-release-check-'));
  fixtures.push(cwd);
  mkdirSync(join(cwd, 'scripts'), { recursive: true });
  cpSync(releaseScript, join(cwd, 'scripts', 'release-check.js'));
  writeVersionFiles(cwd, version, changelog);
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.email', 'release-check@example.test']);
  git(cwd, ['config', 'user.name', 'Release Check Test']);
  commitAll(cwd, 'fixture');
  return cwd;
}

function runReleaseCheck(cwd: string): { status: number | null; report: ReleaseReport } {
  const result = spawnSync(
    process.execPath,
    [join(cwd, 'scripts', 'release-check.js'), '--skip-tests', '--skip-pack', '--json'],
    { cwd, encoding: 'utf8' }
  );
  if (!result.stdout.trim()) {
    throw new Error(`release-check emitted no JSON: ${result.stderr}`);
  }
  return { status: result.status, report: JSON.parse(result.stdout) as ReleaseReport };
}

function resultById(report: ReleaseReport, id: string): ReleaseResult {
  const result = report.results.find(item => item.id === id);
  if (!result) throw new Error(`missing release-check result: ${id}`);
  return result;
}

afterEach(() => {
  while (fixtures.length > 0) {
    rmSync(fixtures.pop()!, { recursive: true, force: true });
  }
});

describe('release-check script contract', () => {
  it('builds the publish artifact before release:check validates the pack contents', () => {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const prepublishOnly = pkg.scripts?.prepublishOnly ?? '';
    const buildIndex = prepublishOnly.indexOf('npm run build');
    const releaseCheckIndex = prepublishOnly.indexOf('npm run release:check');

    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(releaseCheckIndex).toBeGreaterThan(buildIndex);
  });

  it('accepts an explicit candidate state while the release tag is absent', () => {
    const cwd = createFixture(
      '1.2.3',
      '## [1.2.3] — UNRELEASED\n\n> **Status: candidate.** Not yet tagged or published.'
    );

    const { status, report } = runReleaseCheck(cwd);

    expect(status).toBe(0);
    expect(resultById(report, 'changelog').status).toBe('pass');
    expect(resultById(report, 'release-ref')).toMatchObject({ status: 'skip' });
    expect(resultById(report, 'release-ref').detail).toContain('refs/tags/v1.2.3');
  });

  it('accepts prerelease versions in package, README pins, and CHANGELOG headings', () => {
    const cwd = createFixture(
      '1.2.3-2',
      '## [1.2.3-2] — UNRELEASED\n\n> **Status: candidate.** Not yet tagged or published.'
    );

    const { status, report } = runReleaseCheck(cwd);

    expect(status).toBe(0);
    expect(resultById(report, 'version')).toMatchObject({ status: 'pass' });
    expect(resultById(report, 'changelog')).toMatchObject({ status: 'pass' });
    expect(resultById(report, 'release-ref')).toMatchObject({ status: 'skip' });
    expect(resultById(report, 'release-ref').detail).toContain('refs/tags/v1.2.3-2');
  });

  it('rejects a published claim when the explicit release tag is absent', () => {
    const cwd = createFixture('1.2.3', '## [1.2.3] — 2026-08-09\n\n> **Status: published.**');

    const { status, report } = runReleaseCheck(cwd);

    expect(status).toBe(1);
    expect(resultById(report, 'changelog')).toMatchObject({ status: 'fail' });
    expect(resultById(report, 'changelog').detail).toContain('refs/tags/v1.2.3');
  });

  it('validates a matching tag as the release tree', () => {
    const cwd = createFixture('1.2.3', '## [1.2.3] — 2026-08-09\n\n> **Status: published.**');
    git(cwd, ['tag', 'v1.2.3']);

    const { status, report } = runReleaseCheck(cwd);

    expect(status).toBe(0);
    expect(resultById(report, 'changelog').status).toBe('pass');
    expect(resultById(report, 'release-ref')).toMatchObject({ status: 'pass' });
    expect(resultById(report, 'release-ref').detail).toContain(
      'checkout=release tree (HEAD equals tag commit)'
    );
  });

  it('rejects stale README pre-release claims after the version tag exists', () => {
    const cwd = createFixture('1.2.3', '## [1.2.3] — 2026-08-09\n\n> **Status: published.**');
    writeFileSync(
      join(cwd, 'README.md'),
      'npm install -g @orion-agents/orion-code@1.2.3\n' +
        '1.2.3 is not on npm yet; 1.2.2 is the current published release.\n'
    );
    writeFileSync(
      join(cwd, 'README.zh-CN.md'),
      'v1.2.3（当前版本）\n\nnpm install -g @orion-agents/orion-code@1.2.3\n' +
        '### v1.2.3（开发中，未发布）\n### v1.2.2（最新已发布版本）\n'
    );
    commitAll(cwd, 'stale release docs');
    git(cwd, ['tag', 'v1.2.3']);

    const { status, report } = runReleaseCheck(cwd);

    expect(status).toBe(1);
    expect(resultById(report, 'version')).toMatchObject({ status: 'fail' });
    expect(resultById(report, 'version').detail).toContain(
      'README.md: contradicts refs/tags/v1.2.3'
    );
    expect(resultById(report, 'version').detail).toContain(
      'README.zh-CN.md: claims 1.2.2 is the latest/current published release'
    );
  });

  it('rejects a release tag that points at a different package version', () => {
    const cwd = createFixture('9.9.9', '## [9.9.9] — UNRELEASED\n\n> **Status: candidate.**');
    git(cwd, ['tag', 'v1.2.3']);
    writeVersionFiles(cwd, '1.2.3', '## [1.2.3] — 2026-08-09\n\n> **Status: published.**');
    commitAll(cwd, 'prepare 1.2.3');

    const { status, report } = runReleaseCheck(cwd);

    expect(status).toBe(1);
    expect(resultById(report, 'release-ref')).toMatchObject({ status: 'fail' });
    expect(resultById(report, 'release-ref').detail).toContain('package.json version is 9.9.9');
  });

  it('checks standard CHANGELOG headings even when a tag exists', () => {
    const cwd = createFixture(
      '1.2.3',
      '## Orion v1.2.3 Release Notes — 2026-08-09\n\n> **Status: published.**'
    );
    git(cwd, ['tag', 'v1.2.3']);

    const { status, report } = runReleaseCheck(cwd);

    expect(status).toBe(1);
    expect(resultById(report, 'changelog')).toMatchObject({ status: 'fail' });
    expect(resultById(report, 'changelog').detail).toContain('no standard heading');
  });

  it('rejects an unreleased CHANGELOG state after the tag exists', () => {
    const cwd = createFixture(
      '1.2.3',
      '## [1.2.3] — UNRELEASED\n\n> **Status: in development.** Not yet published.'
    );
    git(cwd, ['tag', 'v1.2.3']);

    const { status, report } = runReleaseCheck(cwd);

    expect(status).toBe(1);
    expect(resultById(report, 'changelog')).toMatchObject({ status: 'fail' });
    expect(resultById(report, 'changelog').detail).toContain('unreleased/candidate state');
  });

  it('warns instead of requiring post-release maintenance HEAD to equal the tag', () => {
    const cwd = createFixture('1.2.3', '## [1.2.3] — 2026-08-09\n\n> **Status: published.**');
    git(cwd, ['tag', 'v1.2.3']);
    writeFileSync(join(cwd, 'maintenance.txt'), 'post-release fix\n');
    commitAll(cwd, 'post-release maintenance');

    const { status, report } = runReleaseCheck(cwd);

    expect(status).toBe(0);
    expect(resultById(report, 'release-ref')).toMatchObject({ status: 'warn' });
    expect(resultById(report, 'release-ref').detail).toContain('checkout=post-release commits');
  });

  it('reports a diverged maintenance branch without treating it as the tag artifact', () => {
    const cwd = createFixture('1.2.3', '## [1.2.3] — 2026-08-09\n\n> **Status: published.**');
    const base = git(cwd, ['rev-parse', 'HEAD']);
    git(cwd, ['checkout', '-qb', 'release-artifact']);
    writeFileSync(join(cwd, 'release.txt'), 'release tree\n');
    commitAll(cwd, 'release artifact');
    git(cwd, ['tag', 'v1.2.3']);
    git(cwd, ['checkout', '-q', '-b', 'maintenance', base]);
    writeFileSync(join(cwd, 'maintenance.txt'), 'maintenance tree\n');
    commitAll(cwd, 'maintenance branch');

    const { status, report } = runReleaseCheck(cwd);

    expect(status).toBe(0);
    expect(resultById(report, 'release-ref')).toMatchObject({ status: 'warn' });
    expect(resultById(report, 'release-ref').detail).toContain(
      'checkout=post-release branch drift'
    );
  });
});

const maybeDescribeDepHealth = process.platform === 'win32' ? describe.skip : describe;

maybeDescribeDepHealth('dep-health-check script contract', () => {
  it('enforces the policy and surfaces tree, audit, outdated, and completion sections', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'orion-dep-health-'));
    fixtures.push(cwd);
    const fakeBin = join(cwd, 'bin');
    mkdirSync(fakeBin);
    const npm = join(fakeBin, 'npm');
    writeFileSync(
      npm,
      `#!/bin/sh
case "$*" in
  "audit --audit-level=high") echo "found 0 vulnerabilities" ;;
  "outdated") echo "fixture-package 1.0.0 1.0.1 2.0.0"; exit 1 ;;
  "ls --all") echo "dependency tree ok" ;;
  *) echo "unexpected npm invocation: $*"; exit 2 ;;
esac
exit 0
`
    );
    chmodSync(npm, 0o755);

    const result = spawnSync('bash', [depHealthScript], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('DEPENDENCY_POLICY_OK node=20|22|24 openai=6');
    expect(result.stdout).toContain('== native dependency ABI ==');
    expect(result.stdout).toContain('better-sqlite3: ok node=');
    expect(result.stdout).toContain('== dependency tree consistency ==');
    expect(result.stdout).toContain('== npm audit (high severity gate) ==');
    expect(result.stdout).toContain('== npm outdated (report only; majors require contract review) ==');
    expect(result.stdout).toContain('Dependency health check complete.');
  });
});
