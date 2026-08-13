import { DEFAULT_THEME, type TuiStyle, type TuiTheme } from '../tui-core/style';
import type { RichTextStyleToken, RichTextThemeResolver } from '../runtime/rich-text/types';
import type { TuiThemePreference } from '../services/global-config';
import { HIGH_CONTRAST_PRESET, LIGHT_PRESET } from './theme-profile';

type AddedThemeToken =
  | 'userMarker'
  | 'userText'
  | 'userBackground'
  | 'inlineCode'
  | 'link'
  | 'toolRunning'
  | 'toolSuccess'
  | 'toolError'
  | 'toolSkipped'
  | 'toolName'
  | 'toolMeta'
  | 'systemText'
  | 'commandMarker'
  | 'commandText'
  | 'statusText'
  | 'brand'
  | 'chromeBorder'
  | 'chromeFocus'
  | 'modeBuild'
  | 'modePlan'
  | 'modeAuto'
  | 'modeGoal'
  | 'modePermission'
  | 'pickerSelected'
  | 'queueBadge'
  | 'mascot';

export type ResolvedTuiTheme = TuiTheme & Required<Pick<TuiTheme, AddedThemeToken>>;

/** The built-in restrained dark theme used by the TUI transcript renderer. */
export const DEFAULT_TUI_THEME = DEFAULT_THEME as ResolvedTuiTheme;
export const DEFAULT_TUI_THEME_ID = 'orion-pixel-v1';

/** Resolve an older or partial semantic theme without mutating the caller's object. */
export function resolveTuiTheme(theme?: TuiTheme): ResolvedTuiTheme {
  if (!theme) return DEFAULT_TUI_THEME;
  return { ...DEFAULT_TUI_THEME, ...theme } as ResolvedTuiTheme;
}

/** Resolve a persisted product theme into semantic terminal tokens. */
export function resolveTuiThemePreference(preference: TuiThemePreference): ResolvedTuiTheme {
  if (preference === 'classic') {
    return resolveTuiTheme({
      ...DEFAULT_TUI_THEME,
      brand: DEFAULT_TUI_THEME.heading,
      chromeFocus: DEFAULT_TUI_THEME.heading,
      mascot: DEFAULT_TUI_THEME.muted,
    });
  }
  if (preference === 'high-contrast') {
    return resolveTuiTheme({ ...DEFAULT_TUI_THEME, ...HIGH_CONTRAST_PRESET });
  }
  if (preference === 'auto' && process.env.COLORFGBG?.split(';').at(-1) === '15') {
    return resolveTuiTheme({ ...DEFAULT_TUI_THEME, ...LIGHT_PRESET });
  }
  return DEFAULT_TUI_THEME;
}

/** Adapt TUI semantic tokens to the renderer-independent rich-text API. */
export function richTextThemeResolver(theme: ResolvedTuiTheme): RichTextThemeResolver {
  return (token: RichTextStyleToken): TuiStyle => theme[token];
}
