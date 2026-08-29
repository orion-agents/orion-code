import { readFileSync } from 'fs';
import { join } from 'path';

const panelSource = readFileSync(
  join(__dirname, '..', 'web', 'src', 'components', 'terminal', 'TerminalPanel.tsx'),
  'utf8'
);
const dockSource = readFileSync(
  join(__dirname, '..', 'web', 'src', 'layout', 'WorkPanelDock.tsx'),
  'utf8'
);

describe('Web Terminal Playwright-facing DOM contract', () => {
  it('keeps terminal tabs on the standard roving tab and tabpanel contract', () => {
    expect(panelSource).toContain('role="tablist" aria-label="终端会话"');
    expect(panelSource).toContain('role="tab"');
    expect(panelSource).toContain('tabIndex={activeId === item.id ? 0 : -1}');
    expect(panelSource).toContain('aria-controls={`${terminalTabsId}-${item.id}-panel`}');
    expect(panelSource).toContain('role="tabpanel"');
    expect(panelSource).toContain('aria-labelledby={`${terminalTabsId}-${activeId}`}');
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      expect(panelSource).toContain(`key === '${key}'`);
    }
    expect(panelSource).toContain('pendingTabFocusRef.current = successor');
    expect(panelSource).toContain('if (focusTerminalOnReadyRef.current)');
  });

  it('exposes one-time terminal risk confirmation without bypassing keyboard safety', () => {
    expect(panelSource).toContain('role="alertdialog"');
    expect(panelSource).toContain('aria-modal="true"');
    expect(panelSource).toContain('创建本地终端前请确认风险');
    expect(panelSource).toContain('我理解终端可以执行本地命令');
    expect(panelSource).toContain('disabled={!understood}');
    expect(panelSource).toContain("event.key === 'Escape'");
    expect(panelSource).toContain("event.key !== 'Tab'");
    expect(panelSource).toContain('.inert = true');
  });

  it('provides accessible metadata, toolbar, font, and close controls', () => {
    expect(panelSource).toContain('role="group" aria-label="活动终端信息"');
    expect(panelSource).toContain('role="toolbar" aria-label="终端操作"');
    expect(panelSource).toContain('aria-label="终端字体大小"');
    expect(panelSource).toContain('aria-label={`关闭终端 ${item.title}`}');
    expect(panelSource).toContain('terminalProcessState(activeTerminal.state');
    expect(panelSource).toContain('terminalShellLabel(activeTerminal.shell)');
    expect(panelSource).toContain('cwd <code>{cwdLabel}</code>');
  });

  it('binds cwd to the active workspace and preserves Escape for the terminal surface', () => {
    expect(dockSource).toContain('workspacePath={state.workspace}');
    expect(dockSource).toContain('\'[role="alertdialog"], .terminal-host\'');
    expect(dockSource).toContain("!element.closest('[inert]')");
  });
});
