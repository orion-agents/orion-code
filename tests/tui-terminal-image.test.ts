import {
  detectTerminalImageProtocol,
  readTuiIcon,
  renderTuiStartupBanner,
  resolveTuiIconPath,
} from '../src/tui-ui/terminal-image';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(5000, 0x5a),
]);

describe('TUI terminal image banner', () => {
  it('detects Kitty-compatible and iTerm2 terminals in auto mode', () => {
    expect(
      detectTerminalImageProtocol({
        env: {
          ORION_TUI_IMAGE: 'auto',
          TERM_PROGRAM: 'ghostty',
          TERM: 'xterm-256color',
        },
        isTTY: true,
      })
    ).toBe('kitty');
    expect(
      detectTerminalImageProtocol({
        env: {
          ORION_TUI_IMAGE: 'auto',
          TERM_PROGRAM: 'WezTerm',
          TERM: 'xterm-256color',
        },
        isTTY: true,
      })
    ).toBe('kitty');
    expect(
      detectTerminalImageProtocol({
        env: {
          ORION_TUI_IMAGE: 'auto',
          TERM_PROGRAM: 'iTerm.app',
          ITERM_SESSION_ID: 'test',
        },
        isTTY: true,
      })
    ).toBe('iterm2');
  });

  it('uses the portable pixel banner by default in image-capable terminals', () => {
    expect(
      detectTerminalImageProtocol({
        env: { TERM_PROGRAM: 'ghostty', TERM: 'xterm-256color' },
        isTTY: true,
      })
    ).toBe('none');
  });

  it('uses the portable fallback for multiplexers, remote shells, and explicit off', () => {
    expect(
      detectTerminalImageProtocol({
        env: { TERM_PROGRAM: 'ghostty', TMUX: '/tmp/tmux-1/default,1,0' },
        isTTY: true,
      })
    ).toBe('none');
    expect(
      detectTerminalImageProtocol({
        env: { TERM_PROGRAM: 'iTerm.app', SSH_TTY: '/dev/ttys001' },
        isTTY: true,
      })
    ).toBe('none');
    expect(
      detectTerminalImageProtocol({
        env: { ORION_TUI_IMAGE: 'off', TERM_PROGRAM: 'ghostty' },
        isTTY: true,
      })
    ).toBe('none');
  });

  it('never emits a requested image protocol in Apple Terminal', () => {
    expect(
      detectTerminalImageProtocol({
        env: {
          ORION_TUI_IMAGE: 'kitty',
          TERM_PROGRAM: 'Apple_Terminal',
          TERM: 'xterm-256color',
          KITTY_WINDOW_ID: 'stale-value',
        },
        isTTY: true,
      })
    ).toBe('none');
    expect(
      detectTerminalImageProtocol({
        env: {
          ORION_TUI_IMAGE: 'iterm2',
          TERM_PROGRAM: 'Apple_Terminal',
          TERM: 'xterm-256color',
          ITERM_SESSION_ID: 'stale-value',
        },
        isTTY: true,
      })
    ).toBe('none');
  });

  it('honors a requested protocol only when the current terminal supports it', () => {
    expect(
      detectTerminalImageProtocol({
        env: { ORION_TUI_IMAGE: 'kitty', TERM_PROGRAM: 'ghostty' },
        isTTY: true,
      })
    ).toBe('kitty');
    expect(
      detectTerminalImageProtocol({
        env: { ORION_TUI_IMAGE: 'iterm2', TERM_PROGRAM: 'iTerm.app' },
        isTTY: true,
      })
    ).toBe('iterm2');
    expect(
      detectTerminalImageProtocol({
        env: { ORION_TUI_IMAGE: 'kitty', TERM_PROGRAM: 'unknown-terminal' },
        isTTY: true,
      })
    ).toBe('none');
  });

  it('encodes a chunked Kitty PNG and positions text to its right', () => {
    const banner = renderTuiStartupBanner({
      cwd: '/tmp/orion-project',
      version: '0.1.0',
      model: 'glm-5',
      terminalWidth: 100,
      protocol: 'kitty',
      image: PNG,
      suppressColor: true,
    });

    expect(banner).toMatch(/\x1b_Ga=T,f=100,t=d,q=2,C=1,i=\d+,c=10,r=5,m=1;/);
    expect(banner).toContain('\x1b_Gq=2,m=0;');
    expect(banner).toContain('\r\x1b[12CORION CODE | 猎户座\n');
    expect(banner).toContain('project /tmp/orion-project');
    expect((banner.match(/\n/g) ?? []).length).toBe(5);
  });

  it('encodes an iTerm2 inline image with cell dimensions', () => {
    const banner = renderTuiStartupBanner({
      cwd: '/tmp/orion-project',
      version: '0.1.0',
      model: 'glm-5',
      terminalWidth: 100,
      protocol: 'iterm2',
      image: PNG,
      suppressColor: true,
    });

    expect(banner).toContain('\x1b]1337;File=inline=1;width=10;height=5;preserveAspectRatio=1:');
    expect(banner).toContain('ORION CODE | 猎户座');
  });

  it('renders the OC pixel badge beside the portable startup details', () => {
    const banner = renderTuiStartupBanner({
      cwd: '/tmp/orion-project',
      version: '0.1.0',
      model: 'glm-5',
      terminalWidth: 100,
      protocol: 'none',
      suppressColor: true,
    });

    expect(banner).toContain('│ ✦   ·   ▒▓▓▓▓▒ ▒▓▓▓▓▒ │  ORION CODE | 猎户座');
    expect(banner).toContain('│  ╲ ✦    ▓░░░░▓ ▓░░░░  │  v0.1.0  model glm-5');
    expect(banner).toContain('│✦─✦─✦    ▓░░░░▓ ▓░░░░  │  project /tmp/orion-project');
    expect(banner).toContain('│  ╱ ✦    ▓░░░░▓ ▓░░░░  │  / commands');
    expect(banner).toContain('│ ✦   ·   ▒▓▓▓▓▒ ▒▓▓▓▓▒ │  Ctrl+C twice exits');
    expect(banner).toContain('ORION CODE | 猎户座');
    expect((banner.match(/\n/g) ?? []).length).toBe(7);
  });

  it('keeps every pixel badge row aligned to the same width', () => {
    const banner = renderTuiStartupBanner({
      cwd: '/tmp/orion-project',
      version: '0.1.0',
      model: 'glm-5',
      terminalWidth: 100,
      protocol: 'none',
      suppressColor: true,
    });
    const badgeWidths = banner
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const row = line.replace(/^\r/, '');
        const end = row.startsWith('│')
          ? row.indexOf('│', 1)
          : Math.max(row.indexOf('╮'), row.indexOf('╯'));
        return Array.from(row.slice(0, end + 1)).length;
      });

    expect(new Set(badgeWidths)).toEqual(new Set([25]));
  });

  it('uses three cyan depth levels for the layered pixel badge', () => {
    const banner = renderTuiStartupBanner({
      cwd: '/tmp/orion-project',
      version: '0.1.0',
      model: 'glm-5',
      terminalWidth: 100,
      protocol: 'none',
    });

    expect(banner).toContain('\x1b[38;2;125;211;252m');
    expect(banner).toContain('\x1b[38;2;88;190;255m');
    expect(banner).toContain('\x1b[38;2;30;120;190m');
  });

  it('falls back to compact text when the terminal is narrow', () => {
    const banner = renderTuiStartupBanner({
      cwd: '/tmp/orion-project',
      version: '0.1.0',
      model: 'glm-5',
      terminalWidth: 32,
      protocol: 'kitty',
      image: PNG,
      suppressColor: true,
    });

    expect(banner).toContain('ORION CODE | 猎户座');
    expect(banner).not.toContain('███');
    expect(banner).not.toContain('\x1b_G');
    expect(banner).not.toContain('\x1b]1337');
    expect(banner).not.toContain('\x1b[');
  });

  it('ships a readable PNG runtime asset', () => {
    const path = resolveTuiIconPath({});
    expect(path).not.toBeNull();
    expect(readTuiIcon(path)).not.toBeNull();
  });
});
