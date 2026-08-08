import { loadConfig } from '../src/services/config';
import { DEFAULT_SUBAGENT_CONFIG } from '../src/runtime/subagents';

describe('subagent config resolution', () => {
  it('applies default config when no overrides are present', () => {
    const config = loadConfig({ apiKey: 'test-key' });
    expect(config.subagents).toBeDefined();
    expect(config.subagents!.mode).toBe(DEFAULT_SUBAGENT_CONFIG.mode);
    expect(config.subagents!.maxParallel).toBe(3);
    expect(config.subagents!.roles).toEqual(['research', 'review', 'test-investigate']);
  });

  it('respects subagents mode override', () => {
    const config = loadConfig({
      apiKey: 'test-key',
      subagents: { ...DEFAULT_SUBAGENT_CONFIG, mode: 'off' } as never,
    });
    expect(config.subagents!.mode).toBe('off');
  });

  it('respects subagents maxParallel override', () => {
    const config = loadConfig({
      apiKey: 'test-key',
      subagents: { ...DEFAULT_SUBAGENT_CONFIG, maxParallel: 1 } as never,
    });
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
