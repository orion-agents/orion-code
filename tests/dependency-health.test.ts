import { spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { load as loadYaml } from 'js-yaml';

const root = join(__dirname, '..');
const supportedMajors = new Set([20, 22, 24]);

function compareNodeVersionDescending(left: string, right: string): number {
  const parse = (value: string): number[] => value.replace(/^v/u, '').split('.').map(Number);
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function supportedNodeExecutable(): string {
  const currentMajor = Number(process.versions.node.split('.')[0]);
  if (supportedMajors.has(currentMajor)) return process.execPath;

  const versionsRoot = join(process.env.NVM_DIR ?? join(homedir(), '.nvm'), 'versions', 'node');
  if (existsSync(versionsRoot)) {
    const candidate = readdirSync(versionsRoot)
      .filter(version => /^v(?:20|22|24)\./u.test(version))
      .sort(compareNodeVersionDescending)
      .map(version => join(versionsRoot, version, 'bin', 'node'))
      .find(existsSync);
    if (candidate) return candidate;
  }
  throw new Error('A supported Node 20, 22, or 24 runtime is required for dependency policy tests');
}

function policyResult(nodeExecutable = process.execPath) {
  return spawnSync('bash', ['scripts/dep-health-check.sh', '--policy-only'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dirname(nodeExecutable)}:${process.env.PATH ?? ''}`,
    },
  });
}

describe('dependency governance contract', () => {
  it('sorts supported NVM runtimes by numeric semantic version', () => {
    expect(['v24.2.0', 'v22.23.2', 'v24.14.1'].sort(compareNodeVersionDescending)).toEqual([
      'v24.14.1',
      'v24.2.0',
      'v22.23.2',
    ]);
  });

  it('passes the offline dependency policy gate on a supported runtime', () => {
    const result = policyResult(supportedNodeExecutable());

    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(result.stdout).toContain(
      'DEPENDENCY_POLICY_OK node=20|22|24 openai=6 cjs=ok chat-completions=ok sqlite-vec='
    );
    expect(result.stdout).toContain('DEPENDENCY_EXEMPTION ink=3 react=17');
  });

  it('rejects the active runtime when it is outside the supported matrix', () => {
    const result = policyResult();
    const currentMajor = Number(process.versions.node.split('.')[0]);
    if (supportedMajors.has(currentMajor)) {
      expect(result.status).toBe(0);
      return;
    }

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DEPENDENCY_POLICY_FAILED');
    expect(result.stderr).toContain(`current Node ${process.versions.node} is unsupported`);
    expect(result.stdout).not.toContain('DEPENDENCY_POLICY_OK');
  });

  it('probes the native binding at its real open boundary with actionable recovery', () => {
    const script = readFileSync(join(root, 'scripts', 'dep-health-check.sh'), 'utf8');

    expect(script).toContain("new Database(':memory:')");
    expect(script).toContain('process.versions.modules');
    expect(script).toContain('supportedNodeMajors.has(runtimeNodeMajor)');
    expect(script).toContain('NATIVE_DEPENDENCY_FAILED better-sqlite3');
    expect(script).toContain('npm rebuild better-sqlite3');
    expect(script).toContain("require('sqlite-vec')");
    expect(script).toContain('SELECT vec_version() AS version');
    expect(script).toContain('CREATE VIRTUAL TABLE vec_health USING vec0');
    expect(script).toContain('npm rebuild sqlite-vec');
    expect(script).not.toContain('!/>=\\s*22/.test(installed.engines.node)');
  });

  it('keeps runtime, type-only, and removed dependencies in their intended scopes', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      engines: { node: string };
    };

    expect(manifest.engines.node).toBe('^20.0.0 || ^22.0.0 || ^24.0.0');
    expect(manifest.dependencies.openai).toMatch(/^\^6\./);
    expect(manifest.dependencies).not.toHaveProperty('lodash-es');
    expect(manifest.dependencies).not.toHaveProperty('type-fest');
    expect(manifest.dependencies).not.toHaveProperty('@types/better-sqlite3');
    expect(manifest.devDependencies).toHaveProperty('@types/better-sqlite3');
    const major = (value: string): number => Number(value.match(/\d+/)?.[0]);
    expect(major(manifest.devDependencies['@types/jest'])).toBe(
      major(manifest.devDependencies.jest)
    );
  });

  it('configures bounded npm and GitHub Actions update streams', () => {
    const config = loadYaml(readFileSync(join(root, '.github/dependabot.yml'), 'utf8')) as {
      version: number;
      updates: Array<{
        'package-ecosystem': string;
        ignore?: Array<{ 'dependency-name': string }>;
      }>;
    };

    expect(config.version).toBe(2);
    expect(config.updates.map(update => update['package-ecosystem'])).toEqual([
      'npm',
      'github-actions',
    ]);
    expect(config.updates[0].ignore?.map(entry => entry['dependency-name'])).toEqual(
      expect.arrayContaining(['openai', 'ink', 'react', '@types/react'])
    );
  });
});
