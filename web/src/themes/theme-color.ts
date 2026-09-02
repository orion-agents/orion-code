import type { ThemePreference, UiStylePreference } from '../settings/types';

/** Resolve the browser chrome color without reading CSS or duplicating product state. */
export function themeColorForAppearance(
  style: UiStylePreference,
  theme: ThemePreference,
  prefersLight: boolean
): string {
  const light = theme === 'light' || (theme === 'system' && prefersLight);
  if (style === 'orion-blocksmith') return light ? '#d7d0c1' : '#15191b';
  return light ? '#f4f5f8' : '#090b10';
}
