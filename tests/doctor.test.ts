import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { Store } from '../src/framework/store';
import { loadConfig } from '../src/services/config';
import { collectDoctorReport, formatDoctorReport, hasDoctorFailures } from '../src/services/doctor';
import { TOOLS } from './support/legacy-tools';
import { findCommand } from '../src/commands';
import type { CommandContext } from '../src/commands/types';
import { getLegacyProjectMemoryDir, getProjectSessionsDir } from '../src/services/config-dir';
import { resolveProjectPath } from '../src/services/session-storage';

const originalEnv = { ...process.env };

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
  });

  afterEach(() => {
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
    });

    expect(report.checks.find(check => check.id === 'config')?.status).toBe('ok');
    expect(report.checks.find(check => check.id === 'llm')?.summary).toContain('mock-doctor');
    expect(report.checks.find(check => check.id === 'project-instructions')?.summary).toContain(
      '1 files'
    );
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
    });
    const rendered = formatDoctorReport(report);

    expect(rendered).toContain(
      'https://[REDACTED]@provider.example.test/v1?key=[REDACTED]&token=[REDACTED]'
    );
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
    });

    expect(report.checks.find(check => check.id === 'permissions')?.status).toBe('ok');
  });

  it('does not warn for ask tool confirmation because permissions are runtime-owned', () => {
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
    });

    const permissions = report.checks.find(check => check.id === 'permissions');
    expect(permissions?.status).toBe('ok');
    expect(permissions?.detail).toContain('shared runtime permission protocol');
  });

  it('warns about legacy storage layout without failing doctor', () => {
    const legacyMemoryDir = getLegacyProjectMemoryDir(resolveProjectPath(projectDir));
    mkdirSync(legacyMemoryDir, { recursive: true });
    writeFileSync(
      join(legacyMemoryDir, 'legacy-memory.md'),
      `---
name: legacy-memory
description: Legacy memory
type: project
---

Legacy content`
    );

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
    });

    const storage = report.checks.find(check => check.id === 'storage-layout');
    expect(storage?.status).toBe('warn');
    expect(storage?.detail).toContain('legacy memory');
    expect(hasDoctorFailures(report)).toBe(false);
  });

  it('reports corrupt and orphan Goal sidecars without changing them', () => {
    const projectPath = resolveProjectPath(projectDir);
    const sessionsDir = getProjectSessionsDir(projectPath);
    mkdirSync(sessionsDir, { recursive: true });
    const corruptPath = join(sessionsDir, 'corrupt-session.goal.json');
    const orphanPath = join(sessionsDir, 'orphan-session.goal.json');
    writeFileSync(corruptPath, '{not-json');
    writeFileSync(
      orphanPath,
      JSON.stringify({
        version: 1,
        goalId: 'goal-orphan',
        sessionId: 'orphan-session',
        revision: 0,
        objective: 'orphan objective',
        status: 'active',
      })
    );
    const config = loadConfig({ apiKey: 'sk-test', model: 'mock-doctor' });
    const store = new Store({ config, tools: TOOLS, currentModel: config.model });

    const report = collectDoctorReport({
      cwd: projectDir,
      config,
      store,
      llm: makeLlm('mock-doctor') as any,
    });
    const goals = report.checks.find(check => check.id === 'goal-sidecars');

    expect(goals?.status).toBe('warn');
    expect(goals?.summary).toContain('1 corrupt');
    expect(goals?.summary).toContain('2 orphan');
    expect(goals?.detail).toContain('/doctor never deletes or rewrites Goal data');
    expect(readFileSync(corruptPath, 'utf8')).toBe('{not-json');
    expect(existsSync(orphanPath)).toBe(true);
    expect(hasDoctorFailures(report)).toBe(false);
  });

  it('reports deletion fences and live-sidecar collisions without changing Goal data', () => {
    const projectPath = resolveProjectPath(projectDir);
    const sessionsDir = getProjectSessionsDir(projectPath);
    mkdirSync(sessionsDir, { recursive: true });
    const compactFencePath = join(sessionsDir, 'collision-session.goal.json.deleted');
    const liveSidecarPath = join(sessionsDir, 'collision-session.goal.json');
    const renamedFencePath = join(sessionsDir, 'renamed-session.goal.json.deleted');
    const invalidFencePath = join(sessionsDir, 'invalid-session.goal.json.deleted');
    const unsafeRevisionFencePath = join(sessionsDir, 'unsafe-session.goal.json.deleted');
    const compactFence = JSON.stringify({
      version: 1,
      kind: 'goal_deletion_fence',
      sessionId: 'collision-session',
      goalId: 'goal-collision',
      revision: 4,
      deletedAt: Date.now(),
    });
    const liveSidecar = JSON.stringify({
      version: 1,
      goalId: 'goal-collision-new',
      sessionId: 'collision-session',
      revision: 0,
      objective: 'unexpected resurrected Goal',
      status: 'active',
    });
    const renamedFence = JSON.stringify({
      version: 1,
      goalId: 'goal-renamed',
      sessionId: 'renamed-session',
      revision: 7,
      objective: 'full sidecar retained after atomic rename',
      status: 'active',
    });
    const invalidFence = '{not-json';
    const unsafeRevisionFence = JSON.stringify({
      version: 1,
      kind: 'goal_deletion_fence',
      sessionId: 'unsafe-session',
      goalId: 'goal-unsafe',
      revision: Number.MAX_SAFE_INTEGER + 1,
      deletedAt: Date.now(),
    });
    writeFileSync(compactFencePath, compactFence);
    writeFileSync(liveSidecarPath, liveSidecar);
    writeFileSync(renamedFencePath, renamedFence);
    writeFileSync(invalidFencePath, invalidFence);
    writeFileSync(unsafeRevisionFencePath, unsafeRevisionFence);
    const config = loadConfig({ apiKey: 'sk-test', model: 'mock-doctor' });
    const store = new Store({ config, tools: TOOLS, currentModel: config.model });

    const report = collectDoctorReport({
      cwd: projectDir,
      config,
      store,
      llm: makeLlm('mock-doctor') as any,
    });
    const goals = report.checks.find(check => check.id === 'goal-sidecars');

    expect(goals?.status).toBe('warn');
    expect(goals?.summary).toContain('4 deletion fence (2 valid, 2 invalid)');
    expect(goals?.summary).toContain('1 live/fence collision');
    expect(goals?.detail).toContain('Goal writes with v0.1.1 are NO-GO');
    expect(goals?.detail).toContain('v0.1.1 does not understand deletion fences');
    expect(goals?.detail).toContain('possible stale-writer resurrection');
    expect(goals?.detail).toContain('/doctor never deletes or rewrites Goal data');
    expect(readFileSync(compactFencePath, 'utf8')).toBe(compactFence);
    expect(readFileSync(liveSidecarPath, 'utf8')).toBe(liveSidecar);
    expect(readFileSync(renamedFencePath, 'utf8')).toBe(renamedFence);
    expect(readFileSync(invalidFencePath, 'utf8')).toBe(invalidFence);
    expect(readFileSync(unsafeRevisionFencePath, 'utf8')).toBe(unsafeRevisionFence);
    expect(hasDoctorFailures(report)).toBe(false);
  });

  it('reports lazy Skill roots without loading definitions during doctor', () => {
    const externalRoot = join(configDir, 'configured-skills');
    const skillDir = join(externalRoot, 'code-review');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(configDir, 'orion.json'),
      JSON.stringify({
        defaultModel: 'mock-doctor',
        skills: { paths: [externalRoot] },
      }),
      'utf-8'
    );
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: code-review
description: Configured code review
trigger: /review
priority: 100
---
# Configured Code Review`
    );

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
    });

    const skills = report.checks.find(check => check.id === 'skills');
    expect(skills?.status).toBe('ok');
    expect(skills?.summary).toContain('lazy definition loading enabled');
    expect(skills?.detail).toContain('configured: available');
    expect(skills?.detail).not.toContain('Configured Code Review');
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
    // orion.json is the sole configuration source: seed it with the API key
    // and model instead of relying on ORION_CODE_* env overrides.
    writeFileSync(
      join(configDir, 'orion.json'),
      JSON.stringify({ apiKey: 'sk-doctor', defaultModel: 'mock-doctor' }),
      'utf-8'
    );

    const result = spawnSync(
      'node',
      ['-r', 'ts-node/register', 'src/cli.ts', 'doctor', '--output-format', 'json'],
      {
        cwd: join(__dirname, '..'),
        env: {
          ...process.env,
          ORION_CODE_CONFIG_DIR: configDir,
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
    expect(parsed.checks.some((check: any) => check.id === 'config' && check.status === 'ok')).toBe(
      true
    );
    expect(parsed.checks.some((check: any) => check.id === 'tools')).toBe(true);
  });
});
