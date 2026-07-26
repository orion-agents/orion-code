import { loadConfig } from '../src/services/config';
import { DEFAULT_SUBAGENT_CONFIG } from '../src/runtime/subagents';

describe('subagent config resolution', () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['ORION_CODE_SUBAGENTS', 'ORION_CODE_SUBAGENT_MAX_PARALLEL']) {
      envBackup[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('applies default config when no overrides are present', () => {
    const config = loadConfig({ apiKey: 'test-key' });
    expect(config.subagents).toBeDefined();
    expect(config.subagents!.mode).toBe(DEFAULT_SUBAGENT_CONFIG.mode);
    expect(config.subagents!.maxParallel).toBe(3);
    expect(config.subagents!.roles).toEqual(['research', 'review', 'test-investigate']);
  });

  it('respects ORION_CODE_SUBAGENTS env override', () => {
    process.env.ORION_CODE_SUBAGENTS = 'off';
    const config = loadConfig({ apiKey: 'test-key' });
    expect(config.subagents!.mode).toBe('off');
  });

  it('respects ORION_CODE_SUBAGENT_MAX_PARALLEL env override', () => {
    process.env.ORION_CODE_SUBAGENT_MAX_PARALLEL = '1';
    const config = loadConfig({ apiKey: 'test-key' });
    expect(config.subagents!.maxParallel).toBe(1);
  });

  it('clamps an out-of-range maxParallel from overrides', () => {
    const config = loadConfig({
      apiKey: 'test-key',
      subagents: { ...DEFAULT_SUBAGENT_CONFIG, maxParallel: 99 },
    } as never);
    expect(config.subagents!.maxParallel).toBe(3);
  });

  it('normalizes an invalid mode to auto', () => {
    const config = loadConfig({
      apiKey: 'test-key',
      subagents: { ...DEFAULT_SUBAGENT_CONFIG, mode: 'bogus' as never },
    } as never);
    expect(config.subagents!.mode).toBe('auto');
  });

  it('drops unknown roles', () => {
    const config = loadConfig({
      apiKey: 'test-key',
      subagents: { ...DEFAULT_SUBAGENT_CONFIG, roles: ['research', 'bogus' as never, 'review'] },
    } as never);
    expect(config.subagents!.roles).toEqual(['research', 'review']);
  });
});
