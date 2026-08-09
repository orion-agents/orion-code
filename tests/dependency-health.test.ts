import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { load as loadYaml } from 'js-yaml';

const root = join(__dirname, '..');

describe('dependency governance contract', () => {
  it('passes the offline dependency policy gate', () => {
    const result = spawnSync('bash', ['scripts/dep-health-check.sh', '--policy-only'], {
      cwd: root,
      encoding: 'utf8',
    });

    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(result.stdout).toContain(
      'DEPENDENCY_POLICY_OK node=20|22|24 openai=6 cjs=ok chat-completions=ok'
    );
    expect(result.stdout).toContain('DEPENDENCY_EXEMPTION ink=3 react=17');
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
