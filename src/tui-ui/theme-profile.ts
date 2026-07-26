/**
 * v0.2.23 — TUI Theme and Color Profile.
 *
 * Provides theme presets (dark, light, high-contrast) and color depth
 * detection (truecolor, ansi256, ansi16, none) for the TUI renderer.
 * Uses the actual TuiTheme/TuiColor types from tui-core/style.
 */

import type { TuiColor, TuiStyle } from '../tui-core/style';

// ============================================================================
// Types
// ============================================================================

export type TuiThemePreset = 'dark' | 'light' | 'high-contrast' | 'auto';
export type TuiColorProfile = 'truecolor' | 'ansi256' | 'ansi16' | 'none';

// ============================================================================
// Color helpers
// ============================================================================

function rgb(r: number, g: number, b: number): TuiColor {
  return { kind: 'rgb', r, g, b };
}

function named(name: 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white'): TuiColor {
  return { kind: 'named', value: name };
}

function indexed(value: number): TuiColor {
  return { kind: 'indexed', value };
}

// ============================================================================
// Color profile detection
// ============================================================================

export function detectColorProfile(env: typeof process.env = process.env): TuiColorProfile {
  if (env.NO_COLOR || env.NO_COLOR === '') return 'none';
  const colorterm = (env.COLORTERM ?? '').toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return 'truecolor';
  const term = (env.TERM ?? '').toLowerCase();
  if (term.includes('256color')) return 'ansi256';
  return 'ansi16';
}

// ============================================================================
// Color degradation
// ============================================================================

export function degradeColorForProfile(color: TuiColor, profile: TuiColorProfile): TuiColor {
  if (profile === 'none') return named('white');
  if (profile === 'truecolor') return color;
  if (color.kind !== 'rgb') return color;

  if (profile === 'ansi256') {
    return indexed(rgbToAnsi256(color.r, color.g, color.b));
  }
  return named(rgbToAnsi16Name(color.r, color.g, color.b));
}

export function degradeStyleForProfile(style: TuiStyle, profile: TuiColorProfile): TuiStyle {
  const result: TuiStyle = {};
  if (style.foreground) result.foreground = degradeColorForProfile(style.foreground, profile);
  if (style.background) result.background = degradeColorForProfile(style.background, profile);
  if (style.bold) result.bold = style.bold;
  if (style.dim) result.dim = style.dim;
  if (style.italic) result.italic = style.italic;
  if (style.underline) result.underline = style.underline;
  if (style.inverse) result.inverse = style.inverse;
  return result;
}

// ============================================================================
// Preset styles (use TuiTheme optional fields: muted, warning, error)
// ============================================================================

export interface ThemePresetOverrides {
  muted?: TuiStyle;
  warning?: TuiStyle;
  error?: TuiStyle;
  userBackground?: TuiStyle;
  userText?: TuiStyle;
}

export const DARK_PRESET: ThemePresetOverrides = {
  muted: { foreground: rgb(120, 120, 120) },
  warning: { foreground: rgb(242, 193, 78) },
  error: { foreground: rgb(255, 122, 122), bold: true },
  userBackground: { background: rgb(40, 40, 40) },
  userText: { foreground: rgb(200, 200, 200) },
};

export const LIGHT_PRESET: ThemePresetOverrides = {
  muted: { foreground: rgb(130, 130, 130) },
  warning: { foreground: rgb(160, 120, 20) },
  error: { foreground: rgb(180, 30, 30), bold: true },
  userBackground: { background: rgb(240, 240, 240) },
  userText: { foreground: rgb(50, 50, 50) },
};

export const HIGH_CONTRAST_PRESET: ThemePresetOverrides = {
  muted: { foreground: rgb(180, 180, 180) },
  warning: { foreground: rgb(255, 255, 80), bold: true },
  error: { foreground: rgb(255, 80, 80), bold: true },
  userBackground: { background: rgb(20, 20, 20) },
  userText: { foreground: rgb(255, 255, 255) },
};

export function resolvePreset(preset: TuiThemePreset): ThemePresetOverrides {
  switch (preset) {
    case 'light': return LIGHT_PRESET;
    case 'high-contrast': return HIGH_CONTRAST_PRESET;
    case 'dark':
    case 'auto':
    default:
      return DARK_PRESET;
  }
}

// ============================================================================
// Color math helpers
// ============================================================================

function rgbToAnsi16Name(r: number, g: number, b: number): 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white' {
  const colors: Array<['black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white', number, number, number]> = [
    ['black', 0, 0, 0], ['red', 255, 0, 0], ['green', 0, 255, 0], ['yellow', 255, 255, 0],
    ['blue', 0, 0, 255], ['magenta', 255, 0, 255], ['cyan', 0, 255, 255], ['white', 255, 255, 255],
  ];
  let best: typeof colors[number][0] = 'white';
  let bestDist = Infinity;
  for (const [name, cr, cg, cb] of colors) {
    const dist = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (dist < bestDist) { bestDist = dist; best = name; }
  }
  return best;
}

function rgbToAnsi256(r: number, g: number, b: number): number {
  if (Math.abs(r - g) < 20 && Math.abs(g - b) < 20 && Math.abs(r - b) < 20) {
    return 232 + Math.min(23, Math.round(r / 10.625));
  }
  return 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
}