import {
  DEFAULT_THEME,
  type TuiStyle,
  type TuiTheme,
} from '../tui-core/style';
import type {
  RichTextStyleToken,
  RichTextThemeResolver,
} from '../runtime/rich-text/types';

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
  | 'statusText';

export type ResolvedTuiTheme = TuiTheme & Required<Pick<TuiTheme, AddedThemeToken>>;

/** The built-in restrained dark theme used by the TUI transcript renderer. */
export const DEFAULT_TUI_THEME = DEFAULT_THEME as ResolvedTuiTheme;
export const DEFAULT_TUI_THEME_ID = 'orion-code-dark-v2';

/** Resolve an older or partial semantic theme without mutating the caller's object. */
export function resolveTuiTheme(theme?: TuiTheme): ResolvedTuiTheme {
  if (!theme) return DEFAULT_TUI_THEME;
  return { ...DEFAULT_TUI_THEME, ...theme } as ResolvedTuiTheme;
}

/** Adapt TUI semantic tokens to the renderer-independent rich-text API. */
export function richTextThemeResolver(theme: ResolvedTuiTheme): RichTextThemeResolver {
  return (token: RichTextStyleToken): TuiStyle => theme[token];
}
