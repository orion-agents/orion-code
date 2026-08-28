import type {
  MotionPreference,
  SettingsOperationV1,
  ThemePreference,
  WebSettingsDocumentV1,
} from './types';

export const LEGACY_THEME_KEY = 'orion.web.theme';
export const LEGACY_MOTION_KEY = 'orion.web.motion';

export interface LegacyAppearanceMigration {
  readonly operations: readonly SettingsOperationV1[];
  readonly keysToClear: readonly string[];
}

export function prepareLegacyAppearanceMigration(
  document: WebSettingsDocumentV1
): LegacyAppearanceMigration {
  const themeRaw = safeRead(LEGACY_THEME_KEY);
  const motionRaw = safeRead(LEGACY_MOTION_KEY);
  const theme = asTheme(themeRaw);
  const motion = asMotion(motionRaw);
  const operations: SettingsOperationV1[] = [];
  const keysToClear: string[] = [];

  if (themeRaw !== null) keysToClear.push(LEGACY_THEME_KEY);
  if (motionRaw !== null) keysToClear.push(LEGACY_MOTION_KEY);
  if (document.sections.appearance.theme.explicitValue === undefined && theme) {
    operations.push({ op: 'set', key: 'appearance.theme', value: theme });
  }
  if (document.sections.appearance.motion.explicitValue === undefined && motion) {
    operations.push({ op: 'set', key: 'appearance.motion', value: motion });
  }

  return { operations, keysToClear };
}

export function clearLegacyAppearance(keys: readonly string[]): void {
  if (typeof window === 'undefined') return;
  for (const key of keys) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Privacy modes may make localStorage unavailable; Host settings remain authoritative.
    }
  }
}

function safeRead(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function asTheme(value: string | null): ThemePreference | null {
  return value === 'system' || value === 'light' || value === 'dark' ? value : null;
}

function asMotion(value: string | null): MotionPreference | null {
  return value === 'system' || value === 'reduced' ? value : null;
}
