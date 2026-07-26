/**
 * v0.2.23 Slice 7 — TUI Theme Profile tests.
 */

import {
  detectColorProfile,
  degradeColorForProfile,
  resolvePreset,
} from '../src/tui-ui/theme-profile';

describe('TUI color profile detection', () => {
  it('returns none when NO_COLOR is set', () => {
    expect(detectColorProfile({ NO_COLOR: '1', COLORTERM: 'truecolor' } as any)).toBe('none');
  });

  it('returns truecolor when COLORTERM=truecolor', () => {
    expect(detectColorProfile({ COLORTERM: 'truecolor', TERM: 'xterm-256color' } as any)).toBe('truecolor');
  });

  it('returns truecolor when COLORTERM=24bit', () => {
    expect(detectColorProfile({ COLORTERM: '24bit' } as any)).toBe('truecolor');
  });

  it('returns ansi256 for 256color TERM', () => {
    expect(detectColorProfile({ TERM: 'xterm-256color' } as any)).toBe('ansi256');
  });

  it('defaults to ansi16', () => {
    expect(detectColorProfile({ TERM: 'xterm' } as any)).toBe('ansi16');
  });
});

describe('color degradation', () => {
  it('returns named color in none profile', () => {
    const color = { kind: 'rgb' as const, r: 255, g: 0, b: 0 };
    const degraded = degradeColorForProfile(color, 'none');
    expect(degraded.kind).toBe('named');
  });

  it('preserves color in truecolor profile', () => {
    const color = { kind: 'rgb' as const, r: 128, g: 230, b: 232 };
    const degraded = degradeColorForProfile(color, 'truecolor');
    expect(degraded).toEqual(color);
  });
});

describe('theme presets', () => {
  it('dark preset has muted foreground', () => {
    const preset = resolvePreset('dark');
    expect(preset.muted).toBeDefined();
    expect(preset.muted!.foreground).toBeDefined();
  });

  it('light preset has userBackground', () => {
    const preset = resolvePreset('light');
    expect(preset.userBackground).toBeDefined();
    expect(preset.userBackground!.background).toBeDefined();
  });

  it('high-contrast preset has bold error', () => {
    const preset = resolvePreset('high-contrast');
    expect(preset.error).toBeDefined();
    expect(preset.error!.bold).toBe(true);
  });

  it('auto defaults to dark', () => {
    const preset = resolvePreset('auto');
    expect(preset.muted).toBeDefined();
  });
});