/**
 * Shortcut registry + help dialog contract layer (v0.3.6 P1-A).
 *
 * The dialog is rendered from the same `SHORTCUTS` table the live handlers use,
 * so the panel can never drift from what is actually wired up. These tests pin
 * the registry shape, key-matching semantics (via event.code for Shift+digit)
 * and the dialog DOM.
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  SHORTCUTS,
  findShortcut,
  formatShortcut,
  matchesShortcut,
  shortcutsByGroup,
} from '../web/src/shortcuts';
import { ShortcutHelpDialog } from '../web/src/components/ShortcutHelpDialog';

function makeEvent(overrides: Partial<Parameters<typeof matchesShortcut>[0]> = {}) {
  return {
    key: 'b',
    code: 'KeyB',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

describe('shortcut registry', () => {
  it('declares every group in the documented order', () => {
    const groups = shortcutsByGroup().map(entry => entry.group);
    expect(groups).toEqual(['导航', '面板', '编辑', '浮层']);
  });

  it('keeps every binding id unique and finds them back', () => {
    const ids = SHORTCUTS.map(binding => binding.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(findShortcut('toggle-work-panel')?.description).toContain('工作面板');
    expect(findShortcut('nope')).toBeUndefined();
  });

  it('covers both documented panel quick-switch shortcuts', () => {
    expect(findShortcut('focus-work-panel-5')?.tokens).toEqual(['Mod', 'Shift', '5']);
  });
});

describe('formatShortcut', () => {
  it('renders Apple glyphs with spaces', () => {
    expect(formatShortcut(['Mod', 'Shift', 'B'], true)).toBe('⌘ ⇧ B');
    expect(formatShortcut(['Mod', '/'], true)).toBe('⌘ /');
    expect(formatShortcut(['Esc'], true)).toBe('ESC');
  });

  it('renders cross-platform tokens with + separators', () => {
    expect(formatShortcut(['Mod', 'Shift', '1'], false)).toBe('Ctrl+Shift+1');
    expect(formatShortcut(['Shift', 'Enter'], false)).toBe('Shift+ENTER');
  });
});

describe('matchesShortcut', () => {
  it('matches a plain Mod+B chord on both modifier conventions', () => {
    const tokens = findShortcut('toggle-project-navigation')!.tokens;
    expect(matchesShortcut(makeEvent({ code: 'KeyB', metaKey: true }), tokens)).toBe(true);
    expect(matchesShortcut(makeEvent({ code: 'KeyB', ctrlKey: true }), tokens)).toBe(true);
    expect(matchesShortcut(makeEvent({ code: 'KeyA', metaKey: true }), tokens)).toBe(false);
  });

  it('resolves Shift+digit through event.code so shifted keys still hit', () => {
    const tokens = findShortcut('focus-work-panel-1')!.tokens;
    // Physical Shift+1 produces event.key "!" — must still match Digit1.
    expect(
      matchesShortcut(
        makeEvent({ key: '!', code: 'Digit1', metaKey: true, shiftKey: true }),
        tokens
      )
    ).toBe(true);
    expect(
      matchesShortcut(
        makeEvent({ key: '!', code: 'Digit1', metaKey: false, shiftKey: true }),
        tokens
      )
    ).toBe(false);
  });

  it('requires the exact modifier state', () => {
    const tokens = findShortcut('toggle-work-panel')!.tokens; // Mod+Shift+B
    expect(matchesShortcut(makeEvent({ metaKey: true, shiftKey: true }), tokens)).toBe(true);
    expect(matchesShortcut(makeEvent({ metaKey: true, shiftKey: false }), tokens)).toBe(false);
  });

  it('matches plain keys such as Enter / Escape', () => {
    const submit = findShortcut('submit-composer')!.tokens;
    expect(matchesShortcut(makeEvent({ key: 'Enter', code: 'Enter' }), submit)).toBe(true);
    const esc = findShortcut('close-overlay')!.tokens;
    expect(matchesShortcut(makeEvent({ key: 'Escape', code: 'Escape' }), esc)).toBe(true);
  });
});

describe('ShortcutHelpDialog', () => {
  it('renders the panel title, every group and kbd key caps', () => {
    const html = renderToStaticMarkup(
      React.createElement(ShortcutHelpDialog, { open: true, onClose: () => undefined })
    );
    expect(html).toContain('id="shortcut-help"');
    expect(html).toContain('键盘快捷键');
    // All four groups appear as section headings.
    for (const group of ['导航', '面板', '编辑', '浮层']) {
      expect(html).toContain(`<h3>${group}</h3>`);
    }
    // Every binding is listed with its formatted key cap.
    expect(html).toContain('<kbd>');
    expect(html).toContain('展开或折叠右侧工作面板');
    expect(html).toContain('关闭抽屉、对话框或快捷键面板');
    expect(html).toContain('aria-labelledby="shortcut-help-title"');
  });

  it('offers an explicit close control with an accessible label', () => {
    const html = renderToStaticMarkup(
      React.createElement(ShortcutHelpDialog, { open: true, onClose: () => undefined })
    );
    expect(html).toContain('aria-label="关闭快捷键面板"');
  });

  it('mentions Esc as the closing hint in the footer', () => {
    const html = renderToStaticMarkup(
      React.createElement(ShortcutHelpDialog, { open: false, onClose: () => undefined })
    );
    expect(html).toContain('按 <kbd>Esc</kbd> 关闭本面板');
  });
});
