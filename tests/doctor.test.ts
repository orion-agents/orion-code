import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { Store } from '../src/framework/store';
import { loadConfig } from '../src/services/config';
import { collectDoctorReport, formatDoctorReport, hasDoctorFailures } from '../src/services/doctor';
import { TOOLS } from '../src/tools';
import { mcpManager } from '../src/tools/mcp';
import { findCommand } from '../src/commands';
import type { CommandContext } from '../src/commands/types';
import { getLegacyProjectMemoryDir } from '../src/services/config-dir';
import { resolveProjectPath } from '../src/services/session-storage';
import { resetSkillsRegistry } from '../src/skills/registry';

const originalEnv = { ...process.env };

function makeRuntime() {
  return {
    brain: { getStatus: () => ({ agents: [], pendingTasks: 0, strategy: 'sequential' }) },
    memory: { getStatus: () => ({ working: 0, 'short-term': 0, 'long-term': 0 }) },
    store: { getStats: () => ({ working: 0, 'short-term': 0, 'long-term': 0 }) },
  };
}

function makeLlm(model = 'mock-doctor') {
  return {
    getModel: () => model,
  };
}

describe('doctor report', () => {
  let configDir: string;
  let projectDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'openhorse-doctor-config-'));
    projectDir = mkdtempSync(join(tmpdir(), 'openhorse-doctor-project-'));
    mkdirSync(join(projectDir, '.git'));
    process.env.ORION_CODE_CONFIG_DIR = configDir;
    mcpManager.disconnectAll();
    resetSkillsRegistry();
  });

  afterEach(() => {
    mcpManager.disconnectAll();
    resetSkillsRegistry();
    if (existsSync(configDir)) rmSync(configDir, { recursive: true, force: true });
    if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  it('reports actionable failures when the model is not configured', () => {
    const config = loadConfig();
    const store = new Store({
      config,
      tools: TOOLS,
      currentModel: config.model,
    });

    const report = collectDoctorReport({
      cwd: projectDir,
      config,
      store,
      llm: null,
      runtime: makeRuntime() as any,
    });
    const rendered = formatDoctorReport(report);

    expect(hasDoctorFailures(report)).toBe(true);
    expect(report.checks.find(check => check.id === 'config')?.status).toBe('fail');
    expect(rendered).toContain('Missing API key');
    expect(rendered).toContain('Orion Code Doctor');
  });

  it('loads project rules and reports a healthy configured runtime', () => {
    writeFileSync(join(projectDir, 'AGENTS.md'), 'Follow repository rules.\n');
    const config = loadConfig({ apiKey: 'sk-test', model: 'mock-doctor' });
    const store = new Store({
      config,
      tools: TOOLS,
      currentModel: config.model,
    });

    const report = collectDoctorReport({
      cwd: projectDir,
      config,
      store,
      llm: makeLlm('mock-doctor') as any,
      runtime: makeRuntime() as any,
    });

    expect(report.checks.find(check => check.id === 'config')?.status).toBe('ok');
    expect(report.checks.find(check => check.id === 'llm')?.summary).toContain('mock-doctor');
    expect(report.checks.find(check => check.id === 'project-instructions')?.summary).toContain('1 files');
    expect(store.getSnapshot().projectInstructionsContent).toContain('Follow repository rules.');
  });

  it('reports static provider config diagnostics without network checks or key leaks', () => {
    const originalFetch = (globalThis as any).fetch;
    const fetchMock = jest.fn();
    (globalThis as any).fetch = fetchMock;

    try {
      const config = loadConfig({
        apiKey: 'sk-doctor-secret123456',
        apiBaseUrl: 'https://provider.example.test/v1',
        model: 'gpt-4o',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: config.model,
      });

      const report = collectDoctorReport({
        cwd: projectDir,
        config,
        store,
        llm: makeLlm('gpt-4o') as any,
        runtime: makeRuntime() as any,
      });
      const provider = report.checks.find(check => check.id === 'provider-config');

      expect(fetchMock).not.toHaveBeenCalled();
      expect(provider?.status).toBe('ok');
      expect(provider?.summary).toContain('gpt-4o');
      expect(provider?.detail).toContain('endpoint=https://provider.example.test/v1');
      expect(provider?.detail).toContain('apiKey=configured');
      expect(provider?.detail).toContain('networkCheck=skipped');
      expect(provider?.detail).not.toContain('sk-doctor-secret123456');
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  it('redacts provider endpoint credentials in doctor output', () => {
    const config = loadConfig({
      apiKey: 'sk-doctor-secret123456',
      apiBaseUrl: 'https://user:password@provider.example.test/v1?key=secret123&token=tok123',
      model: 'gpt-4o',
    });
    const store = new Store({
      config,
      tools: TOOLS,
      currentModel: config.model,
    });

    const report = collectDoctorReport({
      cwd: projectDir,
      config,
      store,
      llm: makeLlm('gpt-4o') as any,
      runtime: makeRuntime() as any,
    });
    const rendered = formatDoctorReport(report);

    expect(rendered).toContain('https://[REDACTED]@provider.example.test/v1?key=[REDACTED]&token=[REDACTED]');
    expect(rendered).not.toContain('user:password');
    expect(rendered).not.toContain('secret123');
    expect(rendered).not.toContain('tok123');
    expect(rendered).not.toContain('sk-doctor-secret123456');
  });

  it('warns about unknown models and fails invalid endpoint syntax locally', () => {
    const config = loadConfig({
      apiKey: 'sk-doctor-secret123456',
      apiBaseUrl: 'not a valid endpoint',
      model: 'future-provider/model-x',
    });
    const store = new Store({
      config,
      tools: TOOLS,
      currentModel: config.model,
    });

    const report = collectDoctorReport({
      cwd: projectDir,
      config,
      store,
      llm: makeLlm('future-provider/model-x') as any,
      runtime: makeRuntime() as any,
    });
    const provider = report.checks.find(check => check.id === 'provider-config');

    expect(provider?.status).toBe('fail');
    expect(provider?.detail).toContain('modelSource=default');
    expect(provider?.detail).toContain('endpointStatus=invalid URL');
    expect(provider?.detail).not.toContain('sk-doctor-secret123456');
  });

  it('does not warn for ask tool confirmation in the stable terminal renderer', () => {
    const config = loadConfig({
      apiKey: 'sk-test',
      model: 'mock-doctor',
      toolConfirmation: 'ask',
      ui: { renderer: 'terminal', confirmations: 'config' },
    });
    const store = new Store({
      config,
      tools: TOOLS,
      currentModel: config.model,
    });

    const report = collectDoctorReport({
      cwd: projectDir,
      config,
      store,
      llm: makeLlm('mock-doctor') as any,
      runtime: makeRuntime() as any,
    });

    expect(report.checks.find(check => check.id === 'permissions')?.status).toBe('ok');
  });

  it('does not warn for ask tool confirmation in beta renderers because permissions are runtime-owned', () => {
    const config = loadConfig({
      apiKey: 'sk-test',
      model: 'mock-doctor',
      toolConfirmation: 'ask',
      ui: { renderer: 'ink', confirmations: 'config' },
    });
    const store = new Store({
      config,
      tools: TOOLS,
      currentModel: config.model,
    });

    const report = collectDoctorReport({
      cwd: projectDir,
      config,
      store,
      llm: makeLlm('mock-doctor') as any,
      runtime: makeRuntime() as any,
    });

    const permissions = report.checks.find(check => check.id === 'permissions');
    expect(permissions?.status).toBe('ok');
    expect(permissions?.detail).toContain('shared runtime permission protocol');
  });

  it('warns about legacy storage layout without failing doctor', () => {
    const legacyMemoryDir = getLegacyProjectMemoryDir(resolveProjectPath(projectDir));
    mkdirSync(legacyMemoryDir, { recursive: true });
    writeFileSync(join(legacyMemoryDir, 'legacy-memory.md'), `---
name: legacy-memory
description: Legacy memory
type: project
---

Legacy content`);

    const config = loadConfig({ apiKey: 'sk-test', model: 'mock-doctor' });
    const store = new Store({
      config,
      tools: TOOLS,
      currentModel: config.model,
    });

    const report = collectDoctorReport({
      cwd: projectDir,
      config,
      store,
      llm: makeLlm('mock-doctor') as any,
      runtime: makeRuntime() as any,
    });

    const storage = report.checks.find(check => check.id === 'storage-layout');
    expect(storage?.status).toBe('warn');
    expect(storage?.detail).toContain('legacy memory');
    expect(hasDoctorFailures(report)).toBe(false);
  });

  it('reports duplicate skill diagnostics without failing doctor', () => {
    const externalRoot = join(configDir, 'configured-skills');
    const skillDir = join(externalRoot, 'code-review');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(configDir, 'orion.json'), JSON.stringify({
      defaultModel: 'mock-doctor',
      skills: { paths: [externalRoot] },
    }), 'utf-8');
    writeFileSync(join(skillDir, 'SKILL.md'), `---
name: code-review
description: Configured code review
trigger: /review
priority: 100
---
# Configured Code Review`);

    const config = loadConfig({ apiKey: 'sk-test', model: 'mock-doctor' });
    const store = new Store({
      config,
      tools: TOOLS,
      currentModel: config.model,
    });

    const report = collectDoctorReport({
      cwd: projectDir,
      config,
      store,
      llm: makeLlm('mock-doctor') as any,
      runtime: makeRuntime() as any,
    });

    const skills = report.checks.find(check => check.id === 'skills');
    expect(skills?.status).toBe('warn');
    expect(skills?.summary).toContain('duplicate');
    expect(skills?.detail).toContain('duplicate code-review');
    expect(hasDoctorFailures(report)).toBe(false);
  });

  it('is exposed as /doctor slash command', async () => {
    const config = loadConfig({ apiKey: 'sk-test', model: 'mock-doctor' });
    const store = new Store({
      config,
      tools: TOOLS,
      currentModel: config.model,
    });
    const logs: string[] = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    try {
      const ctx: CommandContext = {
        cwd: projectDir,
        config,
        store,
        llm: makeLlm('mock-doctor') as any,
        runtime: makeRuntime() as any,
      };
      const result = await findCommand('doctor')!.execute(ctx, '');
      expect(result.success).toBe(true);
      expect(logs.join('\n')).toContain('Orion Code Doctor');
      expect(logs.join('\n')).toContain('Tools:');
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('openhorse doctor CLI', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'openhorse-doctor-cli-'));
  });

  afterEach(() => {
    if (existsSync(configDir)) rmSync(configDir, { recursive: true, force: true });
  });

  it('prints JSON diagnostics without entering the interactive UI', () => {
    const result = spawnSync(
      'node',
      ['-r', 'ts-node/register', 'src/cli.ts', 'doctor', '--output-format', 'json'],
      {
        cwd: join(__dirname, '..'),
        env: {
          ...process.env,
          ORION_CODE_CONFIG_DIR: configDir,
          ORION_CODE_API_KEY: 'sk-doctor',
          ORION_CODE_MODEL: 'mock-doctor',
          NO_COLOR: '1',
          FORCE_COLOR: '0',
        },
        encoding: 'utf8',
        timeout: 45000,
        maxBuffer: 1024 * 1024,
      }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('stable terminal UI');
    const parsed = JSON.parse(result.stdout);
    expect(parsed.checks.some((check: any) => check.id === 'config' && check.status === 'ok')).toBe(true);
    expect(parsed.checks.some((check: any) => check.id === 'tools')).toBe(true);
  });
});
