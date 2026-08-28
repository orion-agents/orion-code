import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { spawnSync } from 'child_process';

import { captureReleaseArtifactSourceV1 } from '../scripts/release/build-release-artifact';
import {
  parseAssembleWebE2EArgumentsV1,
  verifyEvidenceBundle,
  type WebE2ERunManifest,
  type WebE2EScenarioManifest,
} from '../scripts/e2e/assemble-web-e2e-receipt';

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
const releaseScript = join(projectRoot, 'scripts', 'release', 'release-check.js');
const depHealthScript = join(projectRoot, 'scripts', 'release', 'dep-health-check.sh');
const fixtures: string[] = [];
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

function createWebEvidenceBundle(
  options: {
    includeScreenshotFact?: boolean;
    screenshotFact?: string;
    screenshotBody?: Buffer;
    writeScreenshot?: boolean;
  } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'orion-web-evidence-'));
  fixtures.push(root);
  const scenarioRoot = join(root, 'scenarios', 'SET-P0-01-fixture');
  mkdirSync(scenarioRoot, { recursive: true });
  const screenshotFact = options.screenshotFact ?? 'settings-dialog.png';
  const scenario: WebE2EScenarioManifest = {
    scenarioId: 'SET-P0-01',
    startedAt: '2026-08-27T00:00:00.000Z',
    completedAt: '2026-08-27T00:00:01.000Z',
    durationMs: 1000,
    status: 'pass',
    browser: { name: 'chromium', version: '151.0.0.0' },
    counters: { secretFindings: 0 },
    facts: options.includeScreenshotFact === false ? {} : { 'screenshot.dialog': screenshotFact },
    logs: { stdout: 'stdout.log', stderr: 'stderr.log' },
  };
  const manifest: WebE2ERunManifest = {
    version: 1,
    kind: 'orion.web-e2e-manifest',
    runId: 'settings-evidence-fixture',
    scenarios: [scenario],
  };
  const manifestPath = join(root, 'manifest.json');
  const screenshotPath = join(scenarioRoot, screenshotFact);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(scenarioRoot, 'manifest.json'), `${JSON.stringify(scenario, null, 2)}\n`);
  writeFileSync(join(scenarioRoot, 'stdout.log'), 'bounded stdout\n');
  writeFileSync(join(scenarioRoot, 'stderr.log'), '');
  if (
    options.includeScreenshotFact !== false &&
    options.writeScreenshot !== false &&
    !screenshotFact.includes('/')
  ) {
    writeFileSync(screenshotPath, options.screenshotBody ?? ONE_PIXEL_PNG);
  }
  return { manifest, manifestPath, scenario, screenshotPath };
}

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
    join(cwd, 'npm-shrinkwrap.json'),
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
  writeFileSync(
    join(cwd, 'README.md'),
    `> v${version} — fixture\n\nnpm install -g @orion-agents/orion-code@${version}\n`
  );
  writeFileSync(
    join(cwd, 'README.zh-CN.md'),
    `> v${version} — fixture\n\nv${version}（当前版本）\n\nnpm install -g @orion-agents/orion-code@${version}\n`
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
  mkdirSync(join(cwd, 'scripts', 'release'), { recursive: true });
  cpSync(releaseScript, join(cwd, 'scripts', 'release', 'release-check.js'));
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
    [join(cwd, 'scripts', 'release', 'release-check.js'), '--skip-tests', '--skip-pack', '--json'],
    { cwd, encoding: 'utf8' }
  );
  if (!result.stdout.trim()) {
    throw new Error(`release-check emitted no JSON: ${result.stderr}`);
  }
  return { status: result.status, report: JSON.parse(result.stdout) as ReleaseReport };
}

function runReleaseCheckWithArgs(
  cwd: string,
  args: string[]
): { status: number | null; report: ReleaseReport } {
  const result = spawnSync(
    process.execPath,
    [
      join(cwd, 'scripts', 'release', 'release-check.js'),
      '--skip-tests',
      '--skip-pack',
      '--json',
      ...args,
    ],
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
  it('freezes clean source identity before creating an in-repository artifact directory', () => {
    const cwd = createFixture('1.2.3', '## [1.2.3] - 2026-08-15\n\nStatus: candidate');

    const source = captureReleaseArtifactSourceV1(cwd);
    mkdirSync(join(cwd, '.release', 'package'), { recursive: true });
    writeFileSync(join(cwd, '.release', 'package', 'artifact.json'), '{}\n');

    expect(source).toMatchObject({ gitSha: git(cwd, ['rev-parse', 'HEAD']), dirty: false });
    expect(captureReleaseArtifactSourceV1(cwd).dirty).toBe(true);
  });

  it('builds the publish artifact before release:check validates the pack contents', () => {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
      files?: string[];
    };
    const prepublishOnly = pkg.scripts?.prepublishOnly ?? '';
    const build = pkg.scripts?.build ?? '';
    const criticalWebE2E = pkg.scripts?.['test:web-e2e:critical'] ?? '';
    const buildIndex = prepublishOnly.indexOf('npm run build');
    const dependencyPolicyIndex = prepublishOnly.indexOf('npm run deps:check -- --policy-only');
    const releaseCheckIndex = prepublishOnly.indexOf('npm run release:check');

    expect(dependencyPolicyIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeGreaterThan(dependencyPolicyIndex);
    expect(releaseCheckIndex).toBeGreaterThan(buildIndex);
    expect(prepublishOnly).toContain('npm run test:coverage -- --runInBand');
    expect(prepublishOnly).toContain('npm run test:web-browser');
    expect(criticalWebE2E).toContain('@settings');
    expect(build).toContain('node scripts/maintenance/copy-runtime-assets.js');
    expect(pkg.files).toContain('npm-shrinkwrap.json');
    expect(pkg.files).toContain('assets/orion-tui-icon.png');
    expect(pkg.files).toContain('CHANGELOG.md');
    expect(pkg.files).toContain('docs/orion.example.json');
    expect(pkg.files).toContain('docs/migration/v0.1.9-to-v0.2.0.md');
    expect(pkg.files).toContain('docs/migration/v0.2.2-to-v0.3.0.md');
    expect(pkg.files).toContain('docs/migration/v0.2.2-to-v0.3.0-settings.md');
    expect(pkg.files).toContain('docs/architecture/v0.3.0-web-api.yaml');
    expect(pkg.files).toContain('docs/plan/v0.2.0-dsh-harness-redesign-plan.md');
    expect(pkg.files).toContain('docs/plan/v0.2.0-release-checklist.md');
    expect(pkg.files).toContain('docs/plan/v0.3.0-web-workbench-plan.md');
    expect(pkg.files).toContain('docs/plan/v0.3.0-settings-integration-plan.md');
    expect(pkg.files).toContain('docs/plan/v0.3.0-node-runtime-compatibility-plan.md');
    expect(pkg.files).not.toContain('assets/');
  });

  it('fails when the checkout version does not match the intended release', () => {
    const cwd = createFixture('1.2.3', '## [1.2.3] - 2026-08-15\n\nStatus: candidate');

    const { status, report } = runReleaseCheckWithArgs(cwd, ['--expected-version', '1.2.4']);

    expect(status).not.toBe(0);
    expect(resultById(report, 'version').detail).toContain(
      'package.json version: expected release 1.2.4, found 1.2.3'
    );
  });

  it('binds a vX.Y.Z release branch to the matching package version', () => {
    const cwd = createFixture('1.2.3', '## [1.2.3] - 2026-08-15\n\nStatus: candidate');
    git(cwd, ['checkout', '-qb', 'v1.2.4']);

    const { status, report } = runReleaseCheck(cwd);

    expect(status).not.toBe(0);
    expect(resultById(report, 'version').detail).toContain(
      'release branch v1.2.4: package.json version expected 1.2.4, found 1.2.3'
    );
  });

  it('enforces exact package contents and hard package-size budgets', () => {
    const script = readFileSync(releaseScript, 'utf8');

    expect(script).toContain('MAX_PACKED_PACKAGE_BYTES = 2 * 1024 * 1024');
    expect(script).toContain('MAX_UNPACKED_PACKAGE_BYTES = 10 * 1024 * 1024');
    expect(script).toContain('MAX_PACKAGE_ENTRIES = 1500');
    expect(script).toContain("'assets/orion-tui-icon.png'");
    expect(script).toContain("'docs/orion.example.json'");
    expect(script).toContain("'docs/readme.md'");
    expect(script).toContain("'docs/migration/v0.1.9-to-v0.2.0.md'");
    expect(script).toContain("'docs/migration/v0.2.2-to-v0.3.0.md'");
    expect(script).toContain("'docs/migration/v0.2.2-to-v0.3.0-settings.md'");
    expect(script).toContain("'docs/architecture/v0.3.0-web-api.yaml'");
    expect(script).toContain("'docs/plan/v0.2.0-dsh-harness-redesign-plan.md'");
    expect(script).toContain("'docs/plan/v0.2.0-release-checklist.md'");
    expect(script).toContain("'docs/plan/v0.3.0-web-workbench-plan.md'");
    expect(script).toContain("'docs/plan/v0.3.0-settings-integration-plan.md'");
    expect(script).toContain("'docs/plan/v0.3.0-node-runtime-compatibility-plan.md'");
    expect(script).toContain("['Web Workbench', webProbe]");
    expect(script).toContain('unexpected tarball entries');
  });

  it('pins third-party GitHub Actions to immutable commit SHAs', () => {
    const workflow = readFileSync(join(projectRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    const uses = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)].map(match => match[1]);

    expect(uses.length).toBeGreaterThan(0);
    expect(uses.filter(value => !/@[0-9a-f]{40}$/u.test(value))).toEqual([]);
  });

  it('keeps Settings browser evidence fail-closed across the exact-artifact release chain', () => {
    const workflow = readFileSync(join(projectRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    const releaseReceipt = readFileSync(
      join(projectRoot, 'scripts', 'release', 'assemble-release-receipt.ts'),
      'utf8'
    );
    const webReceipt = readFileSync(
      join(projectRoot, 'scripts', 'e2e', 'assemble-web-e2e-receipt.ts'),
      'utf8'
    );
    const criticalRunner = readFileSync(
      join(projectRoot, 'scripts', 'e2e', 'run-web-e2e-critical.ts'),
      'utf8'
    );
    const browserFixture = readFileSync(
      join(projectRoot, 'tests', 'e2e', 'fixtures', 'test.ts'),
      'utf8'
    );

    expect(workflow).toContain("node-version: ['22', '24', '26']");
    expect(workflow).toContain("node-version: '22.12.0'");
    expect(workflow).toContain("node-version: '24.0.0'");
    expect(workflow).toContain("node-version: '26.0.0'");
    expect(workflow).toContain('runtime-node${{ matrix.node-major }}');
    expect(workflow).toContain('ci-runtime-node${{ matrix.node-major }}');
    expect(workflow).toContain('npm run test:web-e2e:critical');
    expect(workflow).toContain('ORION_WEB_E2E_RUNNER_IMAGE');
    expect(workflow).toContain('--web-e2e .release/web-e2e/web-e2e-receipt.json');
    expect(criticalRunner).toContain("'(?:E2E-P0-0[1-4]|@settings)'");
    expect(criticalRunner).toContain("manifest?.decision === 'GO'");
    expect(browserFixture).toContain(
      "testInfo.status === 'passed' && testInfo.expectedStatus === 'passed'"
    );
    expect(browserFixture).not.toContain('testInfo.status === testInfo.expectedStatus');
    expect(releaseReceipt).toContain('webE2E,');
    expect(webReceipt).toContain("consistentFact(scenarios, 'release.runner_digest'");
    expect(webReceipt).toContain('secretScanFindings');
  });

  it('requires one Web E2E runtime manifest for every supported Node line', () => {
    const base = [
      '--artifact=artifact.json',
      '--primary=primary-1.json',
      '--primary=primary-2.json',
      '--primary=primary-3.json',
      '--live-canary=NOT_RUN',
      '--out=receipt.json',
    ];
    const runtimes = [22, 24, 26].map(major => `--runtime=node-${major}.json`);

    expect(parseAssembleWebE2EArgumentsV1([...base, ...runtimes]).runtime).toHaveLength(3);
    expect(() => parseAssembleWebE2EArgumentsV1([...base, ...runtimes.slice(0, -1)])).toThrow(
      'Exactly 3 --runtime manifests are required.'
    );
  });

  it('digest-binds Settings screenshots so replacement changes the evidence identity', () => {
    const fixture = createWebEvidenceBundle();
    const originalDigest = verifyEvidenceBundle(fixture.manifestPath, fixture.manifest, [
      fixture.scenario,
    ]);

    writeFileSync(
      fixture.screenshotPath,
      Buffer.concat([ONE_PIXEL_PNG, Buffer.from('tampered screenshot bytes')])
    );

    expect(
      verifyEvidenceBundle(fixture.manifestPath, fixture.manifest, [fixture.scenario])
    ).not.toBe(originalDigest);
  });

  it('rejects missing, unsafe-path, symlinked, or malformed Settings screenshots', () => {
    const missingFact = createWebEvidenceBundle({ includeScreenshotFact: false });
    expect(() =>
      verifyEvidenceBundle(missingFact.manifestPath, missingFact.manifest, [missingFact.scenario])
    ).toThrow('screenshot evidence is missing');

    const missing = createWebEvidenceBundle({ writeScreenshot: false });
    expect(() =>
      verifyEvidenceBundle(missing.manifestPath, missing.manifest, [missing.scenario])
    ).toThrow('screenshot evidence is missing');

    const unsafe = createWebEvidenceBundle({
      screenshotFact: '../outside.png',
      writeScreenshot: false,
    });
    expect(() =>
      verifyEvidenceBundle(unsafe.manifestPath, unsafe.manifest, [unsafe.scenario])
    ).toThrow('path is missing or unsafe');

    const symlinked = createWebEvidenceBundle({ writeScreenshot: false });
    const symlinkTarget = join(dirname(symlinked.screenshotPath), 'symlink-target.png');
    writeFileSync(symlinkTarget, ONE_PIXEL_PNG);
    symlinkSync(symlinkTarget, symlinked.screenshotPath);
    expect(() =>
      verifyEvidenceBundle(symlinked.manifestPath, symlinked.manifest, [symlinked.scenario])
    ).toThrow('must be a regular file');

    const malformed = createWebEvidenceBundle({ screenshotBody: Buffer.alloc(40) });
    expect(() =>
      verifyEvidenceBundle(malformed.manifestPath, malformed.manifest, [malformed.scenario])
    ).toThrow('not a valid bounded PNG');
  });

  it('keeps the dependency policy as a blocking release-gate step', () => {
    const workflow = readFileSync(join(projectRoot, '.github', 'workflows', 'ci.yml'), 'utf8');

    expect(workflow).toMatch(
      /release-gate:[\s\S]*?Dependency policy[\s\S]*?npm run deps:check -- --policy-only[\s\S]*?release:check/u
    );
  });

  it('keeps offline dependency health blocking and rejects retired dependencies', () => {
    const workflow = readFileSync(join(projectRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    const script = readFileSync(depHealthScript, 'utf8');

    const depHealthJob = workflow.slice(workflow.indexOf('  dep-health:'));
    expect(depHealthJob).not.toContain('continue-on-error: true');
    expect(script).toContain("!('shell-quote' in production)");
    expect(script).toContain("!('ink' in production)");
    expect(script).toContain("join(root, 'npm-shrinkwrap.json')");
  });

  it('treats malformed npm pack metadata as a release failure', () => {
    const cwd = createFixture(
      '1.2.3',
      '## [1.2.3] — UNRELEASED\n\n> **Status: candidate.** Not yet tagged or published.'
    );
    const fakeBin = join(cwd, 'fake-bin');
    mkdirSync(fakeBin);
    const npm = join(fakeBin, 'npm');
    writeFileSync(npm, '#!/bin/sh\necho malformed-pack-json\nexit 0\n');
    chmodSync(npm, 0o755);

    const result = spawnSync(
      process.execPath,
      [join(cwd, 'scripts', 'release', 'release-check.js'), '--skip-tests', '--json'],
      {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
      }
    );
    const report = JSON.parse(result.stdout) as ReleaseReport;

    expect(result.status).toBe(1);
    expect(resultById(report, 'pack')).toMatchObject({ status: 'fail' });
  });

  it('runs the release workflow for version tag pushes', () => {
    const workflow = readFileSync(join(projectRoot, '.github', 'workflows', 'ci.yml'), 'utf8');

    expect(workflow).toMatch(/push:[\s\S]*?tags:\s*\n\s*- ['"]v\*['"]/u);
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
      '> v1.2.3 — fixture\n\n' +
        'npm install -g @orion-agents/orion-code@1.2.3\n' +
        '1.2.3 is not on npm yet; 1.2.2 is the current published release.\n'
    );
    writeFileSync(
      join(cwd, 'README.zh-CN.md'),
      '> v1.2.3 — fixture\n\n' +
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

  it('rejects a stale top-level README version summary', () => {
    const cwd = createFixture(
      '1.2.3',
      '## [1.2.3] — UNRELEASED\n\n> **Status: candidate.** Not yet tagged or published.'
    );
    writeFileSync(
      join(cwd, 'README.md'),
      '> v1.2.2 — stale summary\n\nnpm install -g @orion-agents/orion-code@1.2.3\n'
    );

    const { status, report } = runReleaseCheck(cwd);

    expect(status).toBe(1);
    expect(resultById(report, 'version')).toMatchObject({ status: 'fail' });
    expect(resultById(report, 'version').detail).toContain(
      'README.md: top-level version summary expected 1.2.3, found 1.2.2'
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

  it('rejects a stale tagged CHANGELOG even when the maintenance tree marks it published', () => {
    const cwd = createFixture(
      '1.2.3',
      '## [1.2.3] — UNRELEASED\n\n> **Status: candidate.** Not yet tagged or published.'
    );
    git(cwd, ['tag', 'v1.2.3']);
    writeVersionFiles(cwd, '1.2.3', '## [1.2.3] — 2026-08-09\n\n> **Status: published.**');
    commitAll(cwd, 'record post-release evidence');

    const { status, report } = runReleaseCheck(cwd);

    expect(status).toBe(1);
    expect(resultById(report, 'changelog')).toMatchObject({ status: 'pass' });
    expect(resultById(report, 'release-ref')).toMatchObject({ status: 'fail' });
    expect(resultById(report, 'release-ref').detail).toContain('tagged CHANGELOG is stale');
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
  it('keeps the default health report offline and reproducible', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'orion-dep-health-'));
    fixtures.push(cwd);
    const fakeBin = join(cwd, 'bin');
    mkdirSync(fakeBin);
    const npm = join(fakeBin, 'npm');
    writeFileSync(
      npm,
      `#!/bin/sh
case "$*" in
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

    const currentMajor = Number(process.versions.node.split('.')[0]);
    if (![22, 24, 26].includes(currentMajor)) {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`current Node ${process.versions.node} is unsupported`);
      const script = readFileSync(depHealthScript, 'utf8');
      expect(script).toContain('== native dependency ABI ==');
      expect(script).toContain('== dependency tree consistency ==');
      expect(script).toContain('== npm audit (high severity network gate) ==');
      expect(script).toContain(
        '== npm outdated (network report only; majors require contract review) =='
      );
      expect(script).toContain('Dependency health check complete.');
      return;
    }

    if (result.status !== 0) {
      throw new Error(
        `dep-health fixture failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      );
    }
    expect(result.stdout).toContain('DEPENDENCY_POLICY_OK node=22|24|26 openai=6');
    expect(result.stdout).toContain('== native dependency ABI ==');
    expect(result.stdout).toContain('better-sqlite3: ok node=');
    expect(result.stdout).toContain('== dependency tree consistency ==');
    expect(result.stdout).toContain(
      '== registry reports skipped (offline default; use --full-network) =='
    );
    expect(result.stdout).not.toContain('fixture-package');
    expect(result.stdout).toContain('Dependency health check complete.');
  });

  it('runs registry-backed reports only with --full-network', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'orion-dep-health-network-'));
    fixtures.push(cwd);
    const fakeBin = join(cwd, 'bin');
    mkdirSync(fakeBin);
    const npm = join(fakeBin, 'npm');
    writeFileSync(
      npm,
      `#!/bin/sh
case "$*" in
  "audit --audit-level=high --fetch-retries=1 --fetch-timeout=10000") echo "found 0 vulnerabilities" ;;
  "outdated --fetch-retries=1 --fetch-timeout=10000") echo "fixture-package 1.0.0 1.0.1 2.0.0"; exit 1 ;;
  "ls --all") echo "dependency tree ok" ;;
  *) echo "unexpected npm invocation: $*"; exit 2 ;;
esac
exit 0
`
    );
    chmodSync(npm, 0o755);

    const result = spawnSync('bash', [depHealthScript, '--full-network'], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    });

    if (![22, 24, 26].includes(Number(process.versions.node.split('.')[0]))) {
      expect(result.status).toBe(1);
      return;
    }
    if (result.status !== 0) {
      throw new Error(
        `dep-health network fixture failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      );
    }
    expect(result.stdout).toContain('== npm audit (high severity network gate) ==');
    expect(result.stdout).toContain(
      '== npm outdated (network report only; majors require contract review) =='
    );
    expect(result.stdout).toContain('fixture-package');
  });
});
