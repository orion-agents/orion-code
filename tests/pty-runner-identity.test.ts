import { createHash } from 'crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';

const helper = resolve(__dirname, '..', 'scripts', 'pty_runner_identity.py');

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('PTY runner identity', () => {
  let root: string;
  let binary: string;
  const binContent = '#!/usr/bin/env node\nrequire("../dist/cli.js");\n';
  const manifestContent = '{"name":"@orion-agents/orion-code","version":"0.1.2"}\n';
  const cliContent = 'console.log("orion fixture");\n';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orion-pty-identity-'));
    mkdirSync(join(root, 'bin'));
    mkdirSync(join(root, 'dist'));
    binary = join(root, 'bin', 'orion');
    writeFileSync(binary, binContent);
    writeFileSync(join(root, 'package.json'), manifestContent);
    writeFileSync(join(root, 'dist', 'cli.js'), cliContent);
    chmodSync(binary, 0o755);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('binds an installed runner to its real path and package hashes', () => {
    const result = spawnSync('python3', [helper, resolve(__dirname, '..')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ORION_BIN: binary,
        ORION_REQUIRE_BOUND_RUNNER: '1',
        ORION_EXPECT_BIN_SHA256: sha256(binContent),
        ORION_EXPECT_PACKAGE_JSON_SHA256: sha256(manifestContent),
        ORION_EXPECT_DIST_CLI_SHA256: sha256(cliContent),
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ORION_PTY_RUNNER_KIND=installed');
    expect(result.stdout).toContain(`ORION_PTY_BIN_REALPATH=${realpathSync(binary)}`);
    expect(result.stdout).toContain(`ORION_PTY_BIN_SHA256=${sha256(binContent)}`);
    expect(result.stdout).toContain(`ORION_PTY_PACKAGE_JSON_SHA256=${sha256(manifestContent)}`);
    expect(result.stdout).toContain(`ORION_PTY_DIST_CLI_SHA256=${sha256(cliContent)}`);
  });

  it('fails closed when an expected installed artifact hash does not match', () => {
    const result = spawnSync('python3', [helper, resolve(__dirname, '..')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ORION_BIN: binary,
        ORION_REQUIRE_BOUND_RUNNER: '1',
        ORION_EXPECT_BIN_SHA256: sha256(binContent),
        ORION_EXPECT_PACKAGE_JSON_SHA256: sha256(manifestContent),
        ORION_EXPECT_DIST_CLI_SHA256: '0'.repeat(64),
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('dist/cli.js SHA-256 mismatch');
  });

  it('requires an explicit binary for bound packaged PTY evidence', () => {
    const result = spawnSync('python3', [helper, resolve(__dirname, '..'), '--source'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ORION_BIN: '',
        ORION_REQUIRE_BOUND_RUNNER: '1',
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('ORION_BIN is required');
  });

  it('attests source mode without presenting it as packaged evidence', () => {
    const repo = resolve(__dirname, '..');
    const result = spawnSync('python3', [helper, repo, '--source'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ORION_BIN: '',
        ORION_REQUIRE_BOUND_RUNNER: '',
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ORION_PTY_RUNNER_KIND=source');
    expect(result.stdout).toContain(`ORION_PTY_REPO_REALPATH=${realpathSync(repo)}`);
    expect(result.stdout).toContain('ORION_PTY_SOURCE_CLI_SHA256=');
    expect(result.stdout).not.toContain('ORION_PTY_RUNNER_KIND=installed');
  });

  it('routes both PTY acceptance scripts through the identity resolver', () => {
    for (const script of ['tui-ui-pty-smoke.py', 'target-pty-smoke.py']) {
      const source = readFileSync(resolve(__dirname, '..', 'scripts', script), 'utf8');
      expect(source).toContain('from pty_runner_identity import resolve_orion_command');
      expect(source).toContain('resolve_orion_command(repo');
    }
  });
});
