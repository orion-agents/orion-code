import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, join, relative, resolve } from 'path';

import { OPENAI_FIXTURE_ALTERNATE_MODEL, OPENAI_FIXTURE_MODEL } from './openai-provider';
import { writeMcpFixtureConfig, type McpFixtureConfig } from './mcp-server';

export type FixtureToolConfirmation = 'allow' | 'ask' | 'deny';

export interface WorkspaceFixtureOptions {
  readonly baseUrl: string;
  readonly model?: string;
  readonly toolConfirmation?: FixtureToolConfirmation;
  readonly installEnvironment?: boolean;
  readonly includeMcp?: boolean;
}

export interface WorkspaceFixtureConfig {
  readonly schemaVersion: 1;
  readonly providers: readonly {
    readonly id: string;
    readonly baseUrl: string;
    readonly apiKey: '$ORION_CODE_API_KEY';
    readonly protocol: 'openai-completions';
  }[];
  readonly models: readonly {
    readonly id: string;
    readonly provider: string;
    readonly model: string;
    readonly contextWindow: number;
    readonly maxOutputTokens: number;
    readonly reasoningCapability?: {
      readonly kind: 'effort-level';
      readonly supportedLevels: readonly ['low', 'medium', 'high'];
      readonly defaultLevel: 'medium';
      readonly adapter: 'openai-chat-reasoning-effort';
      readonly source: 'config';
    };
  }[];
  readonly defaultModel: string;
  readonly defaultEffort?: 'auto' | 'low' | 'medium' | 'high';
  readonly toolConfirmation: FixtureToolConfirmation;
  readonly sandbox: { readonly profile: 'none' };
  readonly projects?: Readonly<Record<string, { readonly defaultEffort?: string }>>;
  readonly web?: {
    readonly appearance?: {
      readonly style?: 'classic' | 'orion-blocksmith';
      readonly theme?: 'system' | 'light' | 'dark';
      readonly motion?: 'system' | 'reduced';
    };
  };
}

export interface WorkspaceFixture {
  readonly rootDirectory: string;
  readonly configDirectory: string;
  readonly configPath: string;
  readonly primaryWorkspace: string;
  readonly secondaryWorkspace: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly mcp: McpFixtureConfig | null;
  installEnvironment(): () => void;
  readConfig(): WorkspaceFixtureConfig;
  readConfigBytes(): Buffer;
  writeConfig(config: WorkspaceFixtureConfig): void;
  writeRawConfig(value: string | Buffer): void;
  primaryPath(relativePath: string): string;
  secondaryPath(relativePath: string): string;
  cleanup(): void;
}

const PROVIDER_ID = 'web-e2e-provider';
const TEST_API_KEY = 'orion-web-e2e-test-only';

/** Create two isolated workspaces and a current providers+models Orion configuration. */
export function createWorkspaceFixture(options: WorkspaceFixtureOptions): WorkspaceFixture {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const model = options.model?.trim() || OPENAI_FIXTURE_MODEL;
  const toolConfirmation = options.toolConfirmation ?? 'ask';
  if (!['allow', 'ask', 'deny'].includes(toolConfirmation)) {
    throw new Error('toolConfirmation must be allow, ask, or deny.');
  }

  const rootDirectory = mkdtempSync(join(tmpdir(), 'orion-web-e2e-'));
  const configDirectory = join(rootDirectory, 'config');
  const primaryWorkspace = join(rootDirectory, 'workspace-primary');
  const secondaryWorkspace = join(rootDirectory, 'workspace-secondary');
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  seedWorkspace(primaryWorkspace, 'primary', 'alpha');
  seedWorkspace(secondaryWorkspace, 'secondary', 'beta');

  const config: WorkspaceFixtureConfig = {
    schemaVersion: 1,
    providers: [
      {
        id: PROVIDER_ID,
        baseUrl,
        apiKey: '$ORION_CODE_API_KEY',
        protocol: 'openai-completions',
      },
    ],
    models: [
      {
        id: model,
        provider: PROVIDER_ID,
        model,
        contextWindow: 256_000,
        maxOutputTokens: 16_384,
        reasoningCapability: reasoningCapability(),
      },
      {
        id: OPENAI_FIXTURE_ALTERNATE_MODEL,
        provider: PROVIDER_ID,
        model: OPENAI_FIXTURE_ALTERNATE_MODEL,
        // Deliberately smaller so WEB32 can prove the production semantic
        // compact preflight before a Session model switch.
        contextWindow: 8_000,
        maxOutputTokens: 1_000,
        reasoningCapability: reasoningCapability(),
      },
    ],
    defaultModel: model,
    toolConfirmation,
    sandbox: { profile: 'none' },
  };
  const configPath = join(configDirectory, 'orion.json');
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  const mcp = options.includeMcp === false ? null : writeMcpFixtureConfig(configDirectory);
  const environment = Object.freeze({
    ORION_CODE_CONFIG_DIR: configDirectory,
    ORION_CODE_API_KEY: TEST_API_KEY,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  });

  let restoreEnvironment: (() => void) | undefined;
  let cleaned = false;
  const installEnvironment = (): (() => void) => {
    if (cleaned) throw new Error('Cannot install environment for a cleaned workspace fixture.');
    if (restoreEnvironment) return restoreEnvironment;
    const previous = Object.fromEntries(
      Object.keys(environment).map(key => [key, process.env[key]])
    ) as Record<string, string | undefined>;
    for (const [key, value] of Object.entries(environment)) process.env[key] = value;
    let restored = false;
    restoreEnvironment = () => {
      if (restored) return;
      restored = true;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      restoreEnvironment = undefined;
    };
    return restoreEnvironment;
  };
  if (options.installEnvironment !== false) installEnvironment();

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    restoreEnvironment?.();
    rmSync(rootDirectory, { recursive: true, force: true });
  };

  return Object.freeze({
    rootDirectory,
    configDirectory,
    configPath,
    primaryWorkspace,
    secondaryWorkspace,
    environment,
    mcp,
    installEnvironment,
    readConfig: () => JSON.parse(readFileSync(configPath, 'utf8')) as WorkspaceFixtureConfig,
    readConfigBytes: () => readFileSync(configPath),
    writeConfig: (next: WorkspaceFixtureConfig) =>
      writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      }),
    writeRawConfig: (value: string | Buffer) => writeFileSync(configPath, value, { mode: 0o600 }),
    primaryPath: (relativePath: string) => fixturePath(primaryWorkspace, relativePath),
    secondaryPath: (relativePath: string) => fixturePath(secondaryWorkspace, relativePath),
    cleanup,
  });
}

function reasoningCapability() {
  return {
    kind: 'effort-level' as const,
    supportedLevels: ['low', 'medium', 'high'] as const,
    defaultLevel: 'medium' as const,
    adapter: 'openai-chat-reasoning-effort' as const,
    source: 'config' as const,
  };
}

function seedWorkspace(workspace: string, identity: string, seed: string): void {
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  writeFileSync(join(workspace, 'seed.txt'), `${seed}\n`, 'utf8');
  writeFileSync(
    join(workspace, 'workspace-fixture.json'),
    `${JSON.stringify({ identity, seed }, null, 2)}\n`,
    'utf8'
  );
  writeFileSync(
    join(workspace, 'package.json'),
    `${JSON.stringify(
      {
        name: `orion-web-e2e-${identity}`,
        private: true,
        scripts: {
          test: 'node verify-fixture.js',
          build: 'node verify-fixture.js',
        },
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  writeFileSync(
    join(workspace, 'verify-fixture.js'),
    [
      "const { readFileSync } = require('node:fs');",
      "const fixture = JSON.parse(readFileSync('workspace-fixture.json', 'utf8'));",
      `if (fixture.identity !== '${identity}') process.exit(1);`,
      `process.stdout.write('WEB_E2E_${identity.toUpperCase()}_OK\\n');`,
      '',
    ].join('\n'),
    'utf8'
  );
}

function fixturePath(workspace: string, relativePath: string): string {
  if (!relativePath.trim() || isAbsolute(relativePath)) {
    throw new Error('Fixture path must be a non-empty workspace-relative path.');
  }
  const candidate = resolve(workspace, relativePath);
  const boundary = relative(workspace, candidate);
  if (boundary === '..' || boundary.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('Fixture path escapes its workspace.');
  }
  return candidate;
}

function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') {
    throw new Error('OpenAI fixture baseUrl must use loopback HTTP.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('OpenAI fixture baseUrl must not contain credentials, query, or fragment.');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/u, '') || '/v1';
  if (parsed.pathname !== '/v1') throw new Error('OpenAI fixture baseUrl must end in /v1.');
  return parsed.toString().replace(/\/$/u, '');
}

export function workspaceFixtureExists(fixture: WorkspaceFixture): boolean {
  return (
    existsSync(fixture.configPath) &&
    existsSync(fixture.primaryWorkspace) &&
    existsSync(fixture.secondaryWorkspace)
  );
}
