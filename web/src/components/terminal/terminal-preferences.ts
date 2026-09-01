export const TERMINAL_PREFERENCE_STORAGE_KEY = 'orion.web.terminal.v1';
export const TERMINAL_FONT_SIZE_MIN = 11;
export const TERMINAL_FONT_SIZE_MAX = 18;
export const TERMINAL_FONT_SIZE_DEFAULT = 12;

export interface TerminalPreferenceV1 {
  readonly schemaVersion: 1;
  readonly riskAcknowledged: boolean;
  readonly fontSize: number;
}

export type TerminalTabNavigationKey = 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';

export function defaultTerminalPreference(): TerminalPreferenceV1 {
  return Object.freeze({
    schemaVersion: 1,
    riskAcknowledged: false,
    fontSize: TERMINAL_FONT_SIZE_DEFAULT,
  });
}

export function clampTerminalFontSize(value: number): number {
  if (!Number.isFinite(value)) return TERMINAL_FONT_SIZE_DEFAULT;
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(value)));
}

export function parseTerminalPreference(raw: string | null): TerminalPreferenceV1 {
  if (!raw) return defaultTerminalPreference();
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.schemaVersion !== 1) return defaultTerminalPreference();
    return Object.freeze({
      schemaVersion: 1,
      riskAcknowledged: value.riskAcknowledged === true,
      fontSize:
        typeof value.fontSize === 'number'
          ? clampTerminalFontSize(value.fontSize)
          : TERMINAL_FONT_SIZE_DEFAULT,
    });
  } catch {
    return defaultTerminalPreference();
  }
}

export function readTerminalPreference(): TerminalPreferenceV1 {
  try {
    return parseTerminalPreference(
      globalThis.localStorage?.getItem(TERMINAL_PREFERENCE_STORAGE_KEY)
    );
  } catch {
    return defaultTerminalPreference();
  }
}

export function writeTerminalPreference(preference: TerminalPreferenceV1): void {
  try {
    globalThis.localStorage?.setItem(TERMINAL_PREFERENCE_STORAGE_KEY, JSON.stringify(preference));
  } catch {
    // Device-local UI preferences are best effort and never block the PTY surface.
  }
}

/** Select the tab to the right, or the previous tab when the right edge was closed. */
export function terminalTabAfterClose(
  terminals: readonly { readonly id: string }[],
  closingId: string
): string | null {
  const closingIndex = terminals.findIndex(terminal => terminal.id === closingId);
  if (closingIndex < 0) return null;
  const remaining = terminals.filter(terminal => terminal.id !== closingId);
  return remaining[Math.min(closingIndex, remaining.length - 1)]?.id ?? null;
}

export function adjacentTerminalTab(
  terminals: readonly { readonly id: string }[],
  activeId: string,
  key: TerminalTabNavigationKey
): string | null {
  if (terminals.length === 0) return null;
  if (key === 'Home') return terminals[0].id;
  if (key === 'End') return terminals.at(-1)?.id ?? null;
  const current = terminals.findIndex(terminal => terminal.id === activeId);
  const index = current < 0 ? 0 : current;
  const delta = key === 'ArrowRight' ? 1 : -1;
  return terminals[(index + delta + terminals.length) % terminals.length].id;
}

export function terminalShellLabel(shell: string): string {
  return lastPathComponent(shell) || shell || 'shell';
}

/** A privacy-preserving cwd label; the full canonical path remains Host-owned. */
export function terminalWorkspaceLabel(workspacePath: string): string {
  return lastPathComponent(workspacePath) || (workspacePath.startsWith('/') ? '/' : '当前项目');
}

function lastPathComponent(value: string): string {
  const normalized = value.replace(/[\\/]+$/gu, '');
  return normalized.split(/[\\/]/gu).filter(Boolean).at(-1) ?? '';
}
