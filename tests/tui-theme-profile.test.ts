/**
 * v0.2.23 Slice 7 — TUI Theme Profile tests.
 */

import {
  detectColorProfile,
  degradeColorForProfile,
  resolvePreset,
} from '../src/tui-ui/theme-profile';
import { DEFAULT_TUI_THEME, resolveTuiThemePreference } from '../src/tui-ui/theme';

describe('TUI color profile detection', () => {
  it('returns none when NO_COLOR is set', () => {
    expect(detectColorProfile({ NO_COLOR: '1', COLORTERM: 'truecolor' } as any)).toBe('none');
  });

  it('returns truecolor when COLORTERM=truecolor', () => {
    expect(detectColorProfile({ COLORTERM: 'truecolor', TERM: 'xterm-256color' } as any)).toBe(
      'truecolor'
    );
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

describe('persisted TUI theme preferences', () => {
  const originalColorFgBg = process.env.COLORFGBG;

  afterEach(() => {
    if (originalColorFgBg === undefined) delete process.env.COLORFGBG;
    else process.env.COLORFGBG = originalColorFgBg;
  });

  it('resolves high contrast and classic to distinct semantic theme tokens', () => {
    const highContrast = resolveTuiThemePreference('high-contrast');
    const classic = resolveTuiThemePreference('classic');

    expect(highContrast.error).not.toEqual(DEFAULT_TUI_THEME.error);
    expect(classic.brand).toEqual(DEFAULT_TUI_THEME.heading);
    expect(classic.chromeFocus).toEqual(DEFAULT_TUI_THEME.heading);
  });

  it('selects a light semantic profile for auto on a light terminal background', () => {
    process.env.COLORFGBG = '0;15';
    expect(resolveTuiThemePreference('auto').userBackground).not.toEqual(
      DEFAULT_TUI_THEME.userBackground
    );
  });

  it('uses contrast-safe mode colors for light and high-contrast profiles', () => {
    process.env.COLORFGBG = '0;15';
    const light = resolveTuiThemePreference('auto');
    expect(light.modeBuild.foreground).toEqual({ kind: 'rgb', r: 51, g: 65, b: 85 });
    expect(light.modePlan.foreground).toEqual({ kind: 'rgb', r: 3, g: 105, b: 161 });
    expect(light.modeAuto.foreground).toEqual({ kind: 'rgb', r: 161, g: 98, b: 7 });
    expect(light.modeGoal.foreground).toEqual({ kind: 'rgb', r: 126, g: 34, b: 206 });

    const highContrast = resolveTuiThemePreference('high-contrast');
    expect(highContrast.modeBuild.foreground).toEqual({ kind: 'named', value: 'white' });
    expect(highContrast.modePlan.foreground).toEqual({ kind: 'named', value: 'cyan' });
    expect(highContrast.modeAuto.foreground).toEqual({ kind: 'named', value: 'yellow' });
    expect(highContrast.modeGoal.foreground).toEqual({ kind: 'named', value: 'magenta' });
  });
});
