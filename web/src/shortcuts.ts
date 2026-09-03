/**
 * Single source of truth for Workbench keyboard bindings.
 *
 * The help panel renders this table, and the live handlers match against it via
 * `matchesShortcut()`, so documentation cannot drift away from the implementation.
 */

export type ShortcutGroup = '导航' | '面板' | '编辑' | '浮层';

export const SHORTCUT_GROUP_ORDER: readonly ShortcutGroup[] = ['导航', '面板', '编辑', '浮层'];

export interface ShortcutBinding {
  readonly id: string;
  /** `Mod` = ⌘ on Apple platforms, Ctrl elsewhere. `Shift` / `Alt` are literal. */
  readonly tokens: readonly string[];
  readonly group: ShortcutGroup;
  readonly description: string;
}

export const SHORTCUTS: readonly ShortcutBinding[] = Object.freeze([
  {
    id: 'toggle-project-navigation',
    tokens: ['Mod', 'B'],
    group: '导航',
    description: '展开或折叠项目导航',
  },
  {
    id: 'toggle-work-panel',
    tokens: ['Mod', 'Shift', 'B'],
    group: '导航',
    description: '展开或折叠右侧工作面板',
  },
  {
    id: 'focus-work-panel-1',
    tokens: ['Mod', 'Shift', '1'],
    group: '面板',
    description: '切换到 Agent 面板',
  },
  {
    id: 'focus-work-panel-2',
    tokens: ['Mod', 'Shift', '2'],
    group: '面板',
    description: '切换到审阅面板',
  },
  {
    id: 'focus-work-panel-3',
    tokens: ['Mod', 'Shift', '3'],
    group: '面板',
    description: '切换到终端面板',
  },
  {
    id: 'focus-work-panel-4',
    tokens: ['Mod', 'Shift', '4'],
    group: '面板',
    description: '切换到文件面板',
  },
  {
    id: 'focus-work-panel-5',
    tokens: ['Mod', 'Shift', '5'],
    group: '面板',
    description: '切换到 Git 面板',
  },
  {
    id: 'work-panel-tab-nav',
    tokens: ['←', '→'],
    group: '面板',
    description: '在面板标签之间移动（Home / End 跳到首尾）',
  },
  {
    id: 'resize-panel',
    tokens: ['←', '→'],
    group: '面板',
    description: '聚焦分隔条后按 2% 步长调整宽度，配合 Shift 为 10%',
  },
  {
    id: 'resize-panel-reset',
    tokens: ['Enter'],
    group: '面板',
    description: '分隔条聚焦时恢复默认宽度（Home 最窄，End 最宽）',
  },
  {
    id: 'submit-composer',
    tokens: ['Enter'],
    group: '编辑',
    description: '在输入框中发送当前内容',
  },
  {
    id: 'newline-composer',
    tokens: ['Shift', 'Enter'],
    group: '编辑',
    description: '在输入框中插入换行而不发送',
  },
  {
    id: 'force-submit-composer',
    tokens: ['Mod', 'Enter'],
    group: '编辑',
    description: 'Agent 运行中时立即提交（否则进入队列）',
  },
  {
    id: 'project-tree-nav',
    tokens: ['↑', '↓'],
    group: '面板',
    description: '在项目与会话树中移动焦点',
  },
  {
    id: 'close-overlay',
    tokens: ['Esc'],
    group: '浮层',
    description: '关闭抽屉、对话框或快捷键面板',
  },
  {
    id: 'open-shortcut-help',
    tokens: ['Mod', '/'],
    group: '浮层',
    description: '打开或关闭本快捷键面板',
  },
]);

export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const value = navigator.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(value) || /Mac/i.test(navigator.userAgent ?? '');
}

/** Human-readable rendering, e.g. `⌘ ⇧ 1` on macOS and `Ctrl + Shift + 1` elsewhere. */
export function formatShortcut(tokens: readonly string[], apple = isApplePlatform()): string {
  const parts = tokens.map(token => {
    if (token === 'Mod') return apple ? '⌘' : 'Ctrl';
    if (token === 'Shift') return apple ? '⇧' : 'Shift';
    if (token === 'Alt') return apple ? '⌥' : 'Alt';
    return token.toUpperCase();
  });
  return parts.join(apple ? ' ' : '+');
}

/**
 * Does `event` satisfy `tokens`? Digits and letters are matched through
 * `event.code` so that Shift-modified `event.key` values (e.g. `!` for Shift+1)
 * still resolve to the intended physical key.
 */
export function matchesShortcut(
  event: {
    readonly key: string;
    readonly code?: string;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly shiftKey: boolean;
    readonly altKey: boolean;
  },
  tokens: readonly string[]
): boolean {
  let needsMod = false;
  let needsShift = false;
  let needsAlt = false;
  let key: string | null = null;
  for (const token of tokens) {
    if (token === 'Mod') needsMod = true;
    else if (token === 'Shift') needsShift = true;
    else if (token === 'Alt') needsAlt = true;
    else key = token;
  }
  if (needsMod !== (event.metaKey || event.ctrlKey)) return false;
  if (needsShift !== event.shiftKey) return false;
  if (needsAlt !== event.altKey) return false;
  if (key === null) return false;
  const code = event.code ?? '';
  if (/^[a-z]$/i.test(key)) return code === `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return code === `Digit${key}`;
  // Event.key spellings differ from the compact tokens used in the help table
  // (Esc vs Escape); keep the table and the matcher on the same vocabulary.
  const KEY_ALIASES: Readonly<Record<string, string>> = Object.freeze({ esc: 'escape' });
  const expected = KEY_ALIASES[key.toLowerCase()] ?? key.toLowerCase();
  return event.key.toLowerCase() === expected;
}

export function findShortcut(id: string): ShortcutBinding | undefined {
  return SHORTCUTS.find(binding => binding.id === id);
}

export function shortcutsByGroup(): ReadonlyArray<{
  readonly group: ShortcutGroup;
  readonly items: readonly ShortcutBinding[];
}> {
  return SHORTCUT_GROUP_ORDER.map(group => ({
    group,
    items: SHORTCUTS.filter(binding => binding.group === group),
  })).filter(entry => entry.items.length > 0);
}
