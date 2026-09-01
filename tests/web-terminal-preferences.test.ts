import {
  adjacentTerminalTab,
  clampTerminalFontSize,
  defaultTerminalPreference,
  parseTerminalPreference,
  terminalShellLabel,
  terminalTabAfterClose,
  terminalWorkspaceLabel,
} from '../web/src/components/terminal/terminal-preferences';

const tabs = [{ id: 'terminal-a' }, { id: 'terminal-b' }, { id: 'terminal-c' }] as const;

describe('Web Terminal device-local preferences', () => {
  it('fails closed for missing, corrupt, or unknown preference schemas', () => {
    expect(parseTerminalPreference(null)).toEqual(defaultTerminalPreference());
    expect(parseTerminalPreference('{bad json')).toEqual(defaultTerminalPreference());
    expect(
      parseTerminalPreference(
        JSON.stringify({ schemaVersion: 2, riskAcknowledged: true, fontSize: 18 })
      )
    ).toEqual(defaultTerminalPreference());
  });

  it('only restores an explicit risk acknowledgement and clamps font size to 11–18px', () => {
    expect(
      parseTerminalPreference(
        JSON.stringify({ schemaVersion: 1, riskAcknowledged: 'yes', fontSize: 200 })
      )
    ).toEqual({ schemaVersion: 1, riskAcknowledged: false, fontSize: 18 });
    expect(
      parseTerminalPreference(
        JSON.stringify({ schemaVersion: 1, riskAcknowledged: true, fontSize: 10 })
      )
    ).toEqual({ schemaVersion: 1, riskAcknowledged: true, fontSize: 11 });
    expect(clampTerminalFontSize(14.6)).toBe(15);
    expect(clampTerminalFontSize(Number.NaN)).toBe(12);
  });
});

describe('Web Terminal tab selection', () => {
  it('selects the right neighbor, then the left neighbor at the right edge', () => {
    expect(terminalTabAfterClose(tabs, 'terminal-a')).toBe('terminal-b');
    expect(terminalTabAfterClose(tabs, 'terminal-b')).toBe('terminal-c');
    expect(terminalTabAfterClose(tabs, 'terminal-c')).toBe('terminal-b');
    expect(terminalTabAfterClose([{ id: 'only' }], 'only')).toBeNull();
    expect(terminalTabAfterClose(tabs, 'missing')).toBeNull();
  });

  it('implements wrapping Arrow, Home, and End navigation for a roving tab stop', () => {
    expect(adjacentTerminalTab(tabs, 'terminal-a', 'ArrowLeft')).toBe('terminal-c');
    expect(adjacentTerminalTab(tabs, 'terminal-c', 'ArrowRight')).toBe('terminal-a');
    expect(adjacentTerminalTab(tabs, 'terminal-b', 'Home')).toBe('terminal-a');
    expect(adjacentTerminalTab(tabs, 'terminal-b', 'End')).toBe('terminal-c');
    expect(adjacentTerminalTab([], 'terminal-a', 'ArrowRight')).toBeNull();
  });
});

describe('Web Terminal metadata labels', () => {
  it('shows privacy-preserving shell and cwd basenames on POSIX and Windows paths', () => {
    expect(terminalShellLabel('/bin/zsh')).toBe('zsh');
    expect(
      terminalShellLabel('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    ).toBe('powershell.exe');
    expect(terminalWorkspaceLabel('/Users/example/projects/orion-code/')).toBe('orion-code');
    expect(terminalWorkspaceLabel('C:\\work\\orion-code')).toBe('orion-code');
    expect(terminalWorkspaceLabel('/')).toBe('/');
  });
});
