import stringWidth from 'string-width';
import { renderTuiStartupBanner, shouldRenderTuiMascot } from '../src/tui-ui/terminal-image';

describe('TUI startup banner', () => {
  const baseOptions = {
    cwd: '/tmp/orion-project',
    version: '0.1.0',
    model: 'glm-5',
  };

  it('renders a text-only fallback when color is suppressed', () => {
    const banner = renderTuiStartupBanner({
      ...baseOptions,
      terminalWidth: 100,
      suppressColor: true,
    });

    expect(banner).toContain('ORION CODE | 猎户座');
    expect(banner).toContain('v0.1.0  model glm-5');
    expect(banner).toContain('project /tmp/orion-project');
    expect(banner).toContain('/ commands   @ files   ? shortcuts   Ctrl+O tools');
    expect(banner).toContain('Ctrl+C twice exits');

    expect(banner).not.toContain('▐▣ ▣▌');
    expect(banner).not.toContain('\x1b_G');
    expect(banner).not.toContain('\x1b]1337');
  });

  it('applies cyan to the title and dims the remaining lines', () => {
    const banner = renderTuiStartupBanner({
      ...baseOptions,
      terminalWidth: 100,
    });

    expect(banner).toContain('\x1b[38;2;88;190;255m');
    expect(banner).toContain('\x1b[2m');
    expect(banner).toContain('▐▣ ▣▌');
  });

  it('keeps every line within the terminal width', () => {
    const banner = renderTuiStartupBanner({
      ...baseOptions,
      terminalWidth: 20,
      suppressColor: true,
    });

    const widest = Math.max(
      ...banner
        .split('\n')
        .filter(Boolean)
        .map(line => stringWidth(line.replace(/^\r/, '')))
    );
    expect(widest).toBeLessThanOrEqual(20);
  });

  it.each([24, 30, 40, 60, 80, 120, 154])(
    'keeps the NO_COLOR fallback within %i columns without escape or image protocols',
    terminalWidth => {
      const banner = renderTuiStartupBanner({
        ...baseOptions,
        terminalWidth,
        suppressColor: true,
      });
      for (const line of banner.split('\n').filter(Boolean)) {
        expect(stringWidth(line.replace(/^\r/, ''))).toBeLessThanOrEqual(terminalWidth);
      }
      expect(banner).not.toContain('\x1b[');
      expect(banner).not.toContain('\x1b_G');
      expect(banner).not.toContain('\x1b]1337');
      expect(banner).not.toContain('▐▣ ▣▌');
    }
  );

  it('falls back to compact text without color codes when suppressed', () => {
    const banner = renderTuiStartupBanner({
      ...baseOptions,
      terminalWidth: 32,
      suppressColor: true,
    });

    expect(banner).toContain('ORION CODE | 猎户座');
    expect(banner).not.toContain('\x1b[');
  });

  it('suppresses the mascot consistently for classic, NO_COLOR, and explicit opt-out', () => {
    expect(shouldRenderTuiMascot({ theme: 'classic' })).toBe(false);
    expect(shouldRenderTuiMascot({ suppressColor: true, theme: 'orion-pixel' })).toBe(false);
    expect(shouldRenderTuiMascot({ mascot: false, theme: 'orion-pixel' })).toBe(false);
    expect(shouldRenderTuiMascot({ theme: 'orion-pixel' })).toBe(true);

    const classic = renderTuiStartupBanner({
      ...baseOptions,
      terminalWidth: 100,
      theme: 'classic',
    });
    expect(classic).not.toContain('▐▣ ▣▌');
  });

  it('strips ANSI, OSC, C0, C1, and line breaks from dynamic banner fields', () => {
    const banner = renderTuiStartupBanner({
      cwd: '/tmp/project\x1b[2J\nforged cwd\u009b31m',
      version: '0.1.7\rforged',
      model: 'safe\x1b]0;owned\x07\nforged model',
      terminalWidth: 120,
      suppressColor: true,
    });

    expect(banner).toContain('v0.1.7forged  model safe forged model');
    expect(banner).toContain('project /tmp/project forged cwd');
    expect(banner).not.toContain('31m');
    expect(banner.replace(/[\r\n]/gu, '')).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    expect(banner).not.toContain('\x1b');
    expect(banner).not.toContain('\nforged');
  });
});
