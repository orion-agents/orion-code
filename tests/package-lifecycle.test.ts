import { readFileSync } from 'fs';
import { resolve } from 'path';

interface PackageManifest {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
}

const rootDir = resolve(__dirname, '..');

describe('npm package lifecycle', () => {
  it('cleans generated output before every build and pack', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(rootDir, 'package.json'), 'utf8')
    ) as PackageManifest;

    expect(manifest.scripts).toMatchObject({
      clean: 'node scripts/maintenance/clean-dist.js',
      build:
        'npm run clean && npm run build:server && npm run build:web && node scripts/maintenance/copy-runtime-assets.js',
      'build:server': 'tsc',
      'build:web': 'tsc -p web/tsconfig.json --noEmit && vite build --config web/vite.config.ts',
      prepack: 'npm run build',
    });
  });

  it('restricts the clean script to the project dist directory', () => {
    const cleanScript = readFileSync(resolve(rootDir, 'scripts/maintenance/clean-dist.js'), 'utf8');

    expect(cleanScript).toContain("const projectRoot = resolve(__dirname, '../..');");
    expect(cleanScript).toContain("const distDir = resolve(projectRoot, 'dist');");
    expect(cleanScript).toContain("relative(projectRoot, distDir) !== 'dist'");
    expect(cleanScript).toContain('rmSync(distDir, { recursive: true, force: true });');
  });

  it('lets isolated packaged-runtime gates disable ambient env-file loading', () => {
    const binSource = readFileSync(resolve(rootDir, 'bin/orion'), 'utf8');

    expect(binSource).toContain('(nodeMajor === 22 && nodeMinor >= 12)');
    expect(binSource).toContain('nodeMajor === 24 || nodeMajor === 26');
    expect(binSource).toContain('Orion Code requires Node.js 22.12+, 24, or 26');
    expect(binSource).toContain(
      "const loadConfiguredEnvFiles = process.env.ORION_CODE_DISABLE_ENV_FILES !== '1';"
    );
    expect(binSource).toContain('loadConfiguredEnvFiles && loadEnvFile(globalEnv)');
    expect(binSource).toContain('loadConfiguredEnvFiles && loadEnvFile(localEnv)');
    expect(binSource).toContain('loadConfiguredEnvFiles && loadEnvFile(packageEnv)');
  });

  it('keeps unsupported renderer warnings in the current tense', () => {
    const cliSource = readFileSync(resolve(rootDir, 'src/cli.ts'), 'utf8');

    expect(cliSource).toContain(
      'Renderer "${uiValue}" is no longer supported; starting the TUI product renderer instead.'
    );
    expect(cliSource).not.toContain(
      'Renderer "${uiValue}" was removed in v0.2.0; starting the TUI product renderer instead.'
    );
  });

  it('keeps exact release install and Print wording explicit in both READMEs', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(rootDir, 'package.json'), 'utf8')
    ) as PackageManifest;
    const english = readFileSync(resolve(rootDir, 'README.md'), 'utf8');
    const chinese = readFileSync(resolve(rootDir, 'README.zh-CN.md'), 'utf8');
    const exactInstall = `npm install -g ${manifest.name}@${manifest.version}`;
    const unversionedInstall = new RegExp(
      `^npm install -g ${String(manifest.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
      'm'
    );

    expect(english).toContain(exactInstall);
    expect(chinese).toContain(exactInstall);
    expect(english).not.toMatch(unversionedInstall);
    expect(chinese).not.toMatch(unversionedInstall);
    expect(english).toContain('Experimental non-interactive print mode');
    expect(chinese).toContain('早期实验性的非交互入口');
  });
});
