import stringWidth from 'string-width';
import { renderTuiStartupBanner } from '../src/tui-ui/terminal-image';

describe('TUI startup banner', () => {
  const baseOptions = {
    cwd: '/tmp/orion-project',
    version: '0.1.0',
    model: 'glm-5',
  };

  it('renders the startup details as plain text with no left icon', () => {
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

    // The left-side icon (pixel badge or inline PNG) must be gone.
    expect(banner).not.toContain('│✦');
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

  it('falls back to compact text without color codes when suppressed', () => {
    const banner = renderTuiStartupBanner({
      ...baseOptions,
      terminalWidth: 32,
      suppressColor: true,
    });

    expect(banner).toContain('ORION CODE | 猎户座');
    expect(banner).not.toContain('\x1b[');
  });
});
